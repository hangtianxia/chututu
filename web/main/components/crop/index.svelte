<script lang="ts">
  import { Message } from '@ggchivalrous/db-ui';
  import { loadImage } from '@web/util/util';
  import './index.scss';

  type CropMode = 'two_3x4' | 'three_3x5' | 'custom';

  interface ModeDef {
    label: string;
    cropW: number;
    cropH: number;
    parts: number;
    outLabel: string;
  }

  const MODE_DEF: Record<CropMode, ModeDef> = {
    // To get 2x 3:4 portrait slices seamlessly, crop must be 3:2.
    two_3x4: { label: '两张 3:4', cropW: 3, cropH: 2, parts: 2, outLabel: '先裁 3:2 横图，再一分为二' },
    three_3x5: { label: '三张 3:5', cropW: 9, cropH: 5, parts: 3, outLabel: '先裁 9:5 横图，再三等分' },
    custom: { label: '自定义', cropW: 9, cropH: 5, parts: 3, outLabel: '自定义横图比例，再二等分/三等分' },
  };

  const modeKeys: CropMode[] = ['two_3x4', 'three_3x5', 'custom'];

  let mode: CropMode = 'three_3x5';
  let customRatioText = '9:5';
  let customParts: 2 | 3 = 3;
  let processing = false;

  let fileInput: HTMLInputElement | null = null;
  let filePath = '';
  let fileName = '';
  let imgW = 0;
  let imgH = 0;
  let imgEl: HTMLImageElement | null = null;

  let outputDir = '';
  let outputManual = false;

  let previewCanvasEl: HTMLCanvasElement | null = null;
  // Composition controls (crop window in original image space)
  let cropZoom = 1; // 1 = max-area center crop, >1 = zoom-in
  let cropCenterX = 0;
  let cropCenterY = 0;

  let dragActive = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartCenterX = 0;
  let dragStartCenterY = 0;

  let renderRaf: number | null = null;
  let lastMode: CropMode | '' = '';
  let currentDef: ModeDef = MODE_DEF.three_3x5;

  function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n));
  }

  function gcd(a: number, b: number) {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b) {
      const t = a % b;
      a = b;
      b = t;
    }
    return a || 1;
  }

  function parseRatio(text: string, fallback = { w: 9, h: 5 }) {
    const t = (text || '').trim();
    const m = t.match(/^(\d+(?:\.\d+)?)\s*[:/xX]\s*(\d+(?:\.\d+)?)$/);
    if (!m) return fallback;
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return fallback;
    return { w, h };
  }

  function getModeDef(): ModeDef {
    if (mode !== 'custom') return MODE_DEF[mode];
    const r = parseRatio(customRatioText, { w: 9, h: 5 });
    return {
      ...MODE_DEF.custom,
      cropW: r.w,
      cropH: r.h,
      parts: customParts,
      outLabel: `先裁 ${r.w}:${r.h} 横图，再 ${customParts} 等分`,
    };
  }

  function getOutRatioText(def: ModeDef) {
    const w = def.cropW / def.parts;
    const h = def.cropH;
    // try to show integer reduced ratio when possible
    const wi = Math.round(w * 1000);
    const hi = Math.round(h * 1000);
    const g = gcd(wi, hi);
    return `${wi / g}:${hi / g}`;
  }

  $: currentDef = getModeDef();

  function getDirFromFilePath(p: string) {
    const s = (p || '').trim();
    if (!s) return '';
    const isWin = s.includes('\\');
    const sep = isWin ? '\\' : '/';
    const idx = s.lastIndexOf(sep);
    if (idx < 0) return '';
    if (!isWin && idx === 0) return '/';
    if (isWin && idx === 2 && s[1] === ':') return `${s.slice(0, 2)}\\`;
    return s.slice(0, idx);
  }

  function openFilePicker() {
    fileInput?.click?.();
  }

  async function onPickFiles(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const f = el?.files?.[0];
    if (!f) return;

    filePath = (f as any).path || '';
    fileName = f.name;
    if (!outputManual) {
      outputDir = getDirFromFilePath(filePath);
    }

    await loadImageInfo();
    cropCenterX = imgW / 2;
    cropCenterY = imgH / 2;
    cropZoom = 1;
    await renderPreview();

    // reset input for consecutive picks
    el.value = '';
  }

  async function loadImageInfo() {
    if (!filePath) return;
    const img = await loadImage(filePath);
    imgW = img.naturalWidth;
    imgH = img.naturalHeight;
    imgEl = img;
  }

  function computeCropRect(w: number, h: number, cropW: number, cropH: number) {
    if (!w || !h) return { left: 0, top: 0, width: 0, height: 0 };
    const target = cropW / cropH;
    const r = w / h;
    let cw = w;
    let ch = h;
    if (r > target) {
      cw = Math.round(h * target);
    } else {
      ch = Math.round(w / target);
    }
    cw = clamp(cw, 1, w);
    ch = clamp(ch, 1, h);
    const left = Math.floor((w - cw) / 2);
    const top = Math.floor((h - ch) / 2);
    return { left, top, width: cw, height: ch };
  }

  function clampCropRectToImage(w: number, h: number, rect: { left: number; top: number; width: number; height: number }) {
    const width = clamp(Math.round(rect.width), 1, w);
    const height = clamp(Math.round(rect.height), 1, h);
    const left = clamp(Math.round(rect.left), 0, w - width);
    const top = clamp(Math.round(rect.top), 0, h - height);
    return { left, top, width, height };
  }

  function getCropRectForCurrentComposition() {
    const def = getModeDef();
    const base = computeCropRect(imgW, imgH, def.cropW, def.cropH);
    if (!base.width || !base.height) return base;

    const z = Math.max(1, Number.isFinite(Number(cropZoom)) ? cropZoom : 1);
    const width = base.width / z;
    const height = base.height / z;
    const left = cropCenterX - width / 2;
    const top = cropCenterY - height / 2;
    return clampCropRectToImage(imgW, imgH, { left, top, width, height });
  }

  function scheduleRender() {
    if (renderRaf != null) return;
    renderRaf = requestAnimationFrame(() => {
      renderRaf = null;
      void renderPreview();
    });
  }

  function resetComposition() {
    if (!imgW || !imgH) return;
    cropCenterX = imgW / 2;
    cropCenterY = imgH / 2;
    cropZoom = 1;
    scheduleRender();
  }

  function zoomComposition(delta: number) {
    const next = clamp(cropZoom * delta, 1, 8);
    cropZoom = Number(next.toFixed(3));
    scheduleRender();
  }

  function clampCenterForZoom(centerX: number, centerY: number, z: number) {
    const def = getModeDef();
    const base = computeCropRect(imgW, imgH, def.cropW, def.cropH);
    const width = base.width / Math.max(1, z);
    const height = base.height / Math.max(1, z);
    const left = centerX - width / 2;
    const top = centerY - height / 2;
    const cr = clampCropRectToImage(imgW, imgH, { left, top, width, height });
    return { cx: cr.left + cr.width / 2, cy: cr.top + cr.height / 2 };
  }

  function startDrag(e: PointerEvent) {
    dragActive = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartCenterX = cropCenterX;
    dragStartCenterY = cropCenterY;
    try {
      (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
  }

  function moveDrag(e: PointerEvent) {
    if (!dragActive || !previewCanvasEl || !imgW || !imgH) return;
    const rect = previewCanvasEl.getBoundingClientRect();
    const sx = (previewCanvasEl.width || 1) / Math.max(1, rect.width);
    const sy = (previewCanvasEl.height || 1) / Math.max(1, rect.height);
    const dxCanvas = (e.clientX - dragStartX) * sx;
    const dyCanvas = (e.clientY - dragStartY) * sy;

    // canvas pixels -> original image pixels (respect zoom)
    const cw = Math.max(1, previewCanvasEl.width);
    const ch = Math.max(1, previewCanvasEl.height);
    const sx0 = cw / imgW;
    const sy0 = ch / imgH;
    const z = Math.max(1, cropZoom);
    const dxOrig = dxCanvas / Math.max(1e-6, sx0 * z);
    const dyOrig = dyCanvas / Math.max(1e-6, sy0 * z);

    // dragging moves the image; crop window moves opposite
    cropCenterX = dragStartCenterX - dxOrig;
    cropCenterY = dragStartCenterY - dyOrig;

    // clamp by current crop size
    const c = clampCenterForZoom(cropCenterX, cropCenterY, cropZoom);
    cropCenterX = c.cx;
    cropCenterY = c.cy;
    scheduleRender();
  }

  function onWheelZoom(e: WheelEvent) {
    if (!filePath) return;
    e.preventDefault();
    const d = e.deltaY;
    // trackpad friendly
    const mul = d > 0 ? 1 / 1.08 : 1.08;

    const canvas = previewCanvasEl;
    if (!canvas || !imgW || !imgH) return;
    const rect = canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (canvas.width / Math.max(1, rect.width));
    const py = (e.clientY - rect.top) * (canvas.height / Math.max(1, rect.height));

    const cw = canvas.width;
    const ch = canvas.height;
    const sx0 = cw / imgW;
    const sy0 = ch / imgH;
    const centerX = cw / 2;
    const centerY = ch / 2;
    const z0 = Math.max(1, cropZoom);
    const z1 = clamp(z0 * mul, 1, 8);
    if (z1 === z0) return;

    // anchor in original image coordinates under cursor
    const ax = cropCenterX + (px - centerX) / Math.max(1e-6, sx0 * z0);
    const ay = cropCenterY + (py - centerY) / Math.max(1e-6, sy0 * z0);

    const nextCenterX = ax - (px - centerX) / Math.max(1e-6, sx0 * z1);
    const nextCenterY = ay - (py - centerY) / Math.max(1e-6, sy0 * z1);

    cropZoom = Number(z1.toFixed(3));
    const c = clampCenterForZoom(nextCenterX, nextCenterY, cropZoom);
    cropCenterX = c.cx;
    cropCenterY = c.cy;
    scheduleRender();
  }

  function endDrag() {
    dragActive = false;
  }

  async function pickOutputDir() {
    const res = await window.api['open:pickDir']();
    if (res?.code === 0 && res.data) {
      outputDir = res.data;
      outputManual = true;
    }
  }

  function openOutputDir() {
    if (outputDir) {
      window.api['open:dir'](outputDir);
    }
  }

  async function exportSlices() {
    if (!filePath) {
      Message.error('请先选择图片');
      return;
    }
    if (!outputDir) {
      Message.error('请选择输出目录');
      return;
    }

    processing = true;
    try {
      const cropRect = getCropRectForCurrentComposition();
      const def = getModeDef();
      const res = await window.api.cropSplit({
        path: filePath,
        outputDir,
        mode,
        cropW: def.cropW,
        cropH: def.cropH,
        parts: def.parts,
        cropRect,
      });
      if (res.code !== 0) {
        Message.error(res.message || '导出失败');
        return;
      }
      Message.success(`已导出 ${res.data?.length || 0} 张`);
    } finally {
      processing = false;
    }
  }

  async function renderPreview() {
    if (!filePath || !previewCanvasEl) return;
    const def = getModeDef();
    const img = imgEl;
    if (!img) return;

    const maxSide = 1600;
    const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const cw = Math.max(1, Math.round(img.naturalWidth * s));
    const ch = Math.max(1, Math.round(img.naturalHeight * s));
    previewCanvasEl.width = cw;
    previewCanvasEl.height = ch;

    const ctx = previewCanvasEl.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);

    const sx = cw / imgW;
    const sy = ch / imgH;
    const z = Math.max(1, cropZoom);
    const base = computeCropRect(imgW, imgH, def.cropW, def.cropH);

    // Fixed crop frame (zoom=1 size), centered.
    const frameW = Math.round(base.width * sx);
    const frameH = Math.round(base.height * sy);
    const frameLeft = Math.round((cw - frameW) / 2);
    const frameTop = Math.round((ch - frameH) / 2);
    const frame = { left: frameLeft, top: frameTop, width: frameW, height: frameH };

    // Draw image with composition transform (pan/zoom).
    ctx.save();
    ctx.setTransform(sx * z, 0, 0, sy * z, (cw / 2) - cropCenterX * sx * z, (ch / 2) - cropCenterY * sy * z);
    ctx.drawImage(img, 0, 0);
    ctx.restore();

    // overlay crop rect
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, cw, frame.top);
    ctx.fillRect(0, frame.top, frame.left, frame.height);
    ctx.fillRect(frame.left + frame.width, frame.top, cw - (frame.left + frame.width), frame.height);
    ctx.fillRect(0, frame.top + frame.height, cw, ch - (frame.top + frame.height));

    ctx.strokeStyle = 'rgba(108, 214, 255, 0.95)';
    ctx.lineWidth = 2;
    ctx.strokeRect(frame.left + 1, frame.top + 1, frame.width - 2, frame.height - 2);

    // split lines
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    for (let i = 1; i < def.parts; i++) {
      const x = frame.left + (frame.width * i) / def.parts;
      ctx.beginPath();
      ctx.moveTo(x, frame.top);
      ctx.lineTo(x, frame.top + frame.height);
      ctx.stroke();
    }
    ctx.restore();
  }

  $: if (filePath && previewCanvasEl && imgEl) {
    if (mode !== lastMode) {
      lastMode = mode;
      cropZoom = 1;
      cropCenterX = imgW / 2;
      cropCenterY = imgH / 2;
    }
    scheduleRender();
  }

</script>

<div class="crop-wrap">
  <div class="crop-left">
    <div class="crop-toolbar">
      <div class="button grass" on:click={openFilePicker} on:keypress role="button" tabindex="-1">添加图片</div>
      <input class="hide" type="file" accept="image/*" bind:this={fileInput} on:change={onPickFiles} />
      <div class="button grass primary" on:click={exportSlices} on:keypress role="button" tabindex="-1">
        {#if processing}导出中...{:else}导出{/if}
      </div>
    </div>

    <div class="crop-left-settings grass-inset param-sidebar">
      <div class="panel-title">裁切模式</div>
      <div class="mode-toggle">
        {#each modeKeys as k}
          <div
            class="mode-pill"
            class:active={mode === k}
            on:click={() => (mode = k)}
            on:keypress
            role="button"
            tabindex="-1"
          >
            {MODE_DEF[k].label}
          </div>
        {/each}
      </div>
      <div class="help">{currentDef.outLabel}</div>
      <div class="help">输出竖图比例约为：{getOutRatioText(currentDef)}</div>

      {#if mode === 'custom'}
        <div class="row" style="margin-top: 6px;">
          <span class="label">横图比例</span>
          <input class="input" style="width: 92px;" bind:value={customRatioText} on:change={scheduleRender} />
        </div>
        <div class="row">
          <span class="label">等分</span>
          <div class="mode-toggle" style="margin: 0;">
            <div class="mode-pill" class:active={customParts === 2} on:click={() => (customParts = 2)} on:keypress role="button" tabindex="-1">2 等分</div>
            <div class="mode-pill" class:active={customParts === 3} on:click={() => (customParts = 3)} on:keypress role="button" tabindex="-1">3 等分</div>
          </div>
        </div>
      {/if}

      <div class="help">拖动预览可移动构图，滚轮/ +/- 可缩放构图（用于裁切窗口）</div>

      <div class="panel-title" style="margin-top: 14px;">文件</div>
      {#if filePath}
        <div class="help">{fileName}</div>
        <div class="help">{imgW} x {imgH}</div>
      {:else}
        <div class="empty">还没有图片</div>
      {/if}

      <div class="panel-title" style="margin-top: 14px;">输出</div>
      <div class="row">
        <span class="label">目录</span>
        <span class="config-value">
          <span class="open-file-line" on:click={pickOutputDir} on:keypress role="button" tabindex="-1">{outputDir || '选择输出目录'}</span>
        </span>
      </div>
      <div class="row">
        <span class="label">打开</span>
        <span class="config-value">
          <span class="open-file-line" on:click={openOutputDir} on:keypress role="button" tabindex="-1">打开输出目录</span>
        </span>
      </div>
      <div class="help">导出文件命名：{fileName ? `${fileName.split('.').slice(0, -1).join('.')}_part_1_of_${MODE_DEF[mode].parts}.jpg` : 'xxx_part_1_of_N.jpg'}</div>
    </div>
  </div>

  <div class="crop-right">
    <div class="preview grass-inset">
      <div class="preview-head">
        <div class="title">预览</div>
        <div class="actions">
          <span class="info">{fileName || '暂无文件'}</span>
          <div class="button" on:click={resetComposition} on:keypress role="button" tabindex="-1">适配</div>
          <div class="button" on:click={() => zoomComposition(1 / 1.15)} on:keypress role="button" tabindex="-1">-</div>
          <div class="button" on:click={() => zoomComposition(1.15)} on:keypress role="button" tabindex="-1">+</div>
        </div>
      </div>

      <div class="preview-body">
        {#if filePath}
          <div
            class="img-scroll"
            class:dragging={dragActive}
            on:pointerdown={startDrag}
            on:pointermove={moveDrag}
            on:pointerup={endDrag}
            on:pointercancel={endDrag}
            on:wheel|preventDefault={onWheelZoom}
          >
            <canvas bind:this={previewCanvasEl} class="canvas" />
          </div>
        {:else}
          <div class="empty">暂无预览</div>
        {/if}
      </div>
    </div>
  </div>
</div>
