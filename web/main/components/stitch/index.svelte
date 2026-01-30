<script lang="ts">
  import './index.scss';
  import { Message, Switch } from '@ggchivalrous/db-ui';
  import { config } from '@web/store/config';
  import { createCanvas, loadImage } from '@web/util/util';

  type StitchItem = {
    path: string
    name: string
    extraScale: number
    offX: number
    offY: number
  }

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  function parseRatio(text: string, fallback = { w: 3, h: 5 }) {
    const s = (text || '').trim();
    if (!s) return fallback;
    for (const sep of [':', '/']) {
      if (s.includes(sep)) {
        const [a, b] = s.split(sep, 2);
        const rw = Number(a.trim());
        const rh = Number(b.trim());
        if (Number.isFinite(rw) && Number.isFinite(rh) && rw > 0 && rh > 0) {
          return { w: rw, h: rh };
        }
        return fallback;
      }
    }
    const r = Number(s);
    if (Number.isFinite(r) && r > 0) return { w: r, h: 1 };
    return fallback;
  }

  function safeInt(v: any, fallback: number) {
    const n = Number.parseInt(`${v}`, 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function perCropHeight(targetW: number, outW: number, outH: number, n: number) {
    const totalH = targetW * (outH / outW);
    const h = totalH / Math.max(1, n);
    return Math.max(1, Math.round(h));
  }

  const imgCache = new Map<string, Promise<HTMLImageElement>>();
  function getImg(path: string) {
    const hit = imgCache.get(path);
    if (hit) return hit;
    const p = loadImage(path);
    imgCache.set(path, p);
    return p;
  }

  async function cropItemCover(it: StitchItem, targetW: number, cropH: number, offsetScale = 1) {
    const img = await getImg(it.path);
    const iw = img.width;
    const ih = img.height;

    const coverScale = Math.max(targetW / iw, cropH / ih);
    const scale = coverScale * it.extraScale;

    const newW = Math.max(1, Math.round(iw * scale));
    const newH = Math.max(1, Math.round(ih * scale));

    const maxX = Math.max(0, newW - targetW);
    const maxY = Math.max(0, newH - cropH);
    const cx = Math.floor(maxX / 2);
    const cy = Math.floor(maxY / 2);

    const x0 = clamp(cx + Math.round(it.offX * offsetScale), 0, maxX);
    const y0 = clamp(cy + Math.round(it.offY * offsetScale), 0, maxY);

    // draw scaled once, then crop via drawImage source-rect
    const tmp = createCanvas(newW, newH);
    const tctx = tmp.getContext('2d');
    tctx.drawImage(img, 0, 0, newW, newH);

    return { src: tmp, x0, y0, w: targetW, h: cropH };
  }

  async function composeToCanvas(args: {
    items: StitchItem[]
    baseTargetW: number
    renderTargetW: number
    ratio: { w: number, h: number }
    maxH: number
    autoScale: boolean
    alwaysFitMaxH?: number
  }) {
    const { items } = args;
    if (!items.length) {
      return { canvas: createCanvas(1, 1), outW: 1, outH: 1, cropH: 1, truncated: false };
    }

    const n = items.length;
    const cropH0 = perCropHeight(args.baseTargetW, args.ratio.w, args.ratio.h, n);
    const totalH0 = cropH0 * n;

    const hardMaxH = args.alwaysFitMaxH ?? args.maxH;
    const scaleH = totalH0 > hardMaxH && args.autoScale ? hardMaxH / totalH0 : 1;
    const scaleW = Math.min(1, args.renderTargetW / Math.max(1, args.baseTargetW));
    const scale = scaleH * scaleW;

    const targetW = Math.max(1, Math.round(args.baseTargetW * scale));
    const cropH = Math.max(1, Math.round(cropH0 * scale));
    const totalH = cropH * n;

    const outH = totalH0 > hardMaxH && !args.autoScale
      ? hardMaxH
      : totalH;

    const canvas = createCanvas(targetW, outH);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const offsetScale = targetW / Math.max(1, args.baseTargetW);
    const parts = await Promise.all(items.map((it) => cropItemCover(it, targetW, cropH, offsetScale)));

    let y = 0;
    let truncated = false;
    for (const p of parts) {
      if (y + cropH > outH) {
        truncated = true;
        break;
      }
      ctx.drawImage(p.src, p.x0, p.y0, p.w, p.h, 0, y, p.w, p.h);
      y += cropH;
    }

    return { canvas, outW: targetW, outH, cropH: cropH0, truncated, offsetScale };
  }

  let fileInput: HTMLInputElement | null = null;
  let items: StitchItem[] = [];
  let selected = -1;

  let targetWText = '1080';
  let ratioText = '3:5';
  let maxHText = '12000';
  let autoScaleExport = true;

  let previewUrl = '';
  let previewScale = 1;
  let previewFitMode = false;
  let previewLoading = false;
  let previewPending = false;
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let previewCanvasEl: HTMLCanvasElement | null = null;
  let previewCtx: CanvasRenderingContext2D | null = null;
  let previewScrollEl: HTMLDivElement | null = null;
  let lastPreviewMeta = { canvasW: 1, canvasH: 1, cropH: 1, offsetScale: 1, scale: 1 };

  let dragActive = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartOffX = 0;
  let dragStartOffY = 0;
  let previewInfo = '';

  let rafId: number | null = null;

  function getCanvasPointFromEvent(e: PointerEvent | WheelEvent) {
    const canvas = previewCanvasEl;
    if (!canvas) return { x: 0, y: 0, ok: false };
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / Math.max(1, rect.width));
    const y = (e.clientY - rect.top) * (canvas.height / Math.max(1, rect.height));
    return { x, y, ok: true };
  }

  function getHitIndex(yCanvas: number) {
    const cropH = lastPreviewMeta.cropH || 1;
    return clamp(Math.floor(yCanvas / cropH), 0, Math.max(0, items.length - 1));
  }

  async function renderAll() {
    if (!previewCanvasEl) return;
    if (!previewCtx) previewCtx = previewCanvasEl.getContext('2d');
    if (!previewCtx) return;

    const ctx = previewCtx;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, previewCanvasEl.width, previewCanvasEl.height);

    for (let i = 0; i < items.length; i++) {
      await renderBlock(i, true);
    }

    drawSelectionOutline();
    ctx.restore();
  }

  function drawSelectionOutline() {
    if (!previewCtx || !previewCanvasEl) return;
    if (selected < 0 || selected >= items.length) return;
    const y = selected * lastPreviewMeta.cropH;
    previewCtx.save();
    previewCtx.lineWidth = 2;
    previewCtx.strokeStyle = 'rgba(108, 214, 255, 0.75)';
    previewCtx.strokeRect(1, y + 1, previewCanvasEl.width - 2, lastPreviewMeta.cropH - 2);
    previewCtx.restore();
  }

  async function renderBlock(idx: number, skipClear = false) {
    if (!previewCanvasEl) return;
    if (!previewCtx) previewCtx = previewCanvasEl.getContext('2d');
    if (!previewCtx) return;
    if (idx < 0 || idx >= items.length) return;

    const ctx = previewCtx;
    const it = items[idx];
    const y = idx * lastPreviewMeta.cropH;
    const outW = previewCanvasEl.width;
    const cropH = lastPreviewMeta.cropH;
    const scaleOut = lastPreviewMeta.scale || 1;
    const offsetScale = lastPreviewMeta.offsetScale || 1;

    if (!skipClear) {
      ctx.save();
      ctx.fillStyle = '#000';
      ctx.fillRect(0, y, outW, cropH);
      ctx.restore();
    }

    const img = await getImg(it.path);
    const iw = img.width;
    const ih = img.height;

    const coverScale = Math.max(outW / iw, cropH / ih);
    const scaleImg = coverScale * it.extraScale;
    const scaledW = iw * scaleImg;
    const scaledH = ih * scaleImg;

    const maxX = Math.max(0, scaledW - outW);
    const maxY = Math.max(0, scaledH - cropH);
    const cx = Math.floor(maxX / 2);
    const cy = Math.floor(maxY / 2);

    const x0 = clamp(cx + Math.round(it.offX * scaleOut), 0, maxX);
    const y0 = clamp(cy + Math.round(it.offY * scaleOut), 0, maxY);

    const sx = x0 / Math.max(1e-6, scaleImg);
    const sy = y0 / Math.max(1e-6, scaleImg);
    const sw = outW / Math.max(1e-6, scaleImg);
    const sh = cropH / Math.max(1e-6, scaleImg);

    ctx.drawImage(img, sx, sy, sw, sh, 0, y, outW, cropH);
  }

  function schedulePreview() {
    previewPending = true;
    if (previewTimer) {
      clearTimeout(previewTimer);
    }
    previewTimer = setTimeout(() => {
      previewTimer = null;
      refreshPreview();
    }, 60);
  }

  function fitPreviewToViewport() {
    const el = previewScrollEl;
    const canvas = previewCanvasEl;
    if (!el || !canvas) return;

    const vw = Math.max(1, el.clientWidth);
    const vh = Math.max(1, el.clientHeight);
    const cw = Math.max(1, canvas.width);
    const ch = Math.max(1, canvas.height);

    // Fit whole canvas in view, with a small margin.
    const pad = 12;
    const wRatio = (vw - pad) / cw;
    const hRatio = (vh - pad) / ch;
    const s = Math.max(0.05, Math.min(6, Math.min(wRatio, hRatio)));
    previewScale = Number(s.toFixed(3));
  }

  async function refreshPreview() {
    previewLoading = true;
    previewPending = false;

    const n = items.length;
    const targetW = Math.max(100, safeInt(targetWText, 1080));
    const ratio = parseRatio(ratioText, { w: 5, h: 3 });
    const maxH = Math.max(200, safeInt(maxHText, 12000));

    try {
      const hardMaxH = 4000;
      const baseCropH = perCropHeight(targetW, ratio.w, ratio.h, n);
      const baseTotalH = baseCropH * Math.max(1, n);
      const scaleH = baseTotalH > hardMaxH ? hardMaxH / baseTotalH : 1;
      const renderW = Math.min(targetW, 1400);
      const scaleW = Math.min(1, renderW / Math.max(1, targetW));
      const scaleOut = scaleH * scaleW;

      const outW = Math.max(1, Math.round(targetW * scaleOut));
      const cropH = Math.max(1, Math.round(baseCropH * scaleOut));
      const outH = cropH * Math.max(1, n);

      lastPreviewMeta = {
        canvasW: outW,
        canvasH: outH,
        cropH,
        offsetScale: scaleOut,
        scale: scaleOut,
      };

      if (previewCanvasEl) {
        previewCanvasEl.width = outW;
        previewCanvasEl.height = outH;
      }

      previewUrl = 'canvas';
      await renderAll();

      if (previewFitMode) {
        // wait a tick for layout to settle
        requestAnimationFrame(() => fitPreviewToViewport());
      }

      const cropHPx = perCropHeight(targetW, ratio.w, ratio.h, n);
      previewInfo = `N=${n} | 每张裁剪 ${targetW}x${cropHPx}px | 输出约 ${targetW}x${Math.min(maxH, cropHPx * n)}px`;
    } catch (e: any) {
      Message.error(e?.message || '预览生成失败');
    } finally {
      previewLoading = false;
    }
  }

  function setSelected(idx: number) {
    selected = idx;
    // update selection outline on preview
    renderAll();
  }

  function updateSelected(patch: Partial<StitchItem>) {
    if (selected < 0 || selected >= items.length) return;
    items = items.map((it, i) => (i === selected ? { ...it, ...patch } : it));
    schedulePreview();
  }

  function onScaleInput(e: Event) {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    updateSelected({ extraScale: v });
  }

  function onOffXInput(e: Event) {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    updateSelected({ offX: v });
  }

  function onOffYInput(e: Event) {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    updateSelected({ offY: v });
  }

  function removeSelected() {
    if (selected < 0 || selected >= items.length) return;
    items = items.filter((_, i) => i !== selected);
    selected = Math.min(selected, items.length - 2);
    schedulePreview();
  }

  function moveSelected(delta: number) {
    if (selected < 0 || selected >= items.length) return;
    const j = selected + delta;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    const tmp = next[selected];
    next[selected] = next[j];
    next[j] = tmp;
    items = next;
    selected = j;
    schedulePreview();
  }

  function resetSelected() {
    updateSelected({ extraScale: 1, offX: 0, offY: 0 });
  }

  async function onPickFiles(ev: any) {
    const files: FileList | null = ev?.currentTarget?.files || null;
    if (!files?.length) return;
    const next: StitchItem[] = [];
    for (let i = 0; i < files.length; i++) {
      const f: any = files[i];
      if (!f?.path) continue;
      next.push({
        path: f.path,
        name: f.name,
        extraScale: 1,
        offX: 0,
        offY: 0,
      });
    }

    items = [...items, ...next];
    if (selected === -1 && items.length) selected = 0;
    if (fileInput) fileInput.value = '';
    schedulePreview();
  }

  function openFilePicker() {
    fileInput?.click();
  }

  let pendingOffX = 0;
  let pendingOffY = 0;
  let pendingScale = 1;

  function updateSelectedFast(patch: Partial<StitchItem>) {
    if (selected < 0 || selected >= items.length) return;
    items = items.map((it, i) => (i === selected ? { ...it, ...patch } : it));
  }

  function scheduleRerenderSelected() {
    if (rafId != null) return;
    rafId = requestAnimationFrame(async () => {
      rafId = null;
      updateSelectedFast({ offX: pendingOffX, offY: pendingOffY, extraScale: pendingScale });
      await renderBlock(selected);
      drawSelectionOutline();
    });
  }

  function startDrag(e: PointerEvent) {
    if (!previewCanvasEl) return;
    if (!items.length) return;

    const p = getCanvasPointFromEvent(e);
    if (!p.ok) return;

    const idx = getHitIndex(p.y);
    selected = idx;

    // ensure outline updates even on click
    renderAll();

    dragActive = true;
    dragStartX = p.x;
    dragStartY = p.y;
    dragStartOffX = items[idx].offX;
    dragStartOffY = items[idx].offY;
    try {
      (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
  }

  function moveDrag(e: PointerEvent) {
    if (!dragActive) return;
    if (!previewCanvasEl) return;
    if (selected < 0 || selected >= items.length) return;

    const p = getCanvasPointFromEvent(e);
    if (!p.ok) return;

    const dxCanvas = p.x - dragStartX;
    const dyCanvas = p.y - dragStartY;
    const s = lastPreviewMeta.scale || 1;

    pendingOffX = Math.round(dragStartOffX - dxCanvas / s);
    pendingOffY = Math.round(dragStartOffY - dyCanvas / s);
    pendingScale = items[selected].extraScale;
    scheduleRerenderSelected();
  }

  function endDrag() {
    dragActive = false;
  }

  function onWheelZoom(e: WheelEvent) {
    if (!previewCanvasEl) return;
    if (!items.length) return;

    const p = getCanvasPointFromEvent(e);
    if (!p.ok) return;

    const idx = getHitIndex(p.y);
    selected = idx;

    const it = items[idx];
    const factor = Math.exp(-e.deltaY * 0.001);
    const next = clamp(it.extraScale * factor, 0.5, 2.5);

    // Zoom around mouse position within this block (keep the pixel under cursor stable).
    const outW = previewCanvasEl.width;
    const cropH = lastPreviewMeta.cropH || 1;
    const scaleOut = lastPreviewMeta.scale || 1;
    const localX = clamp(p.x, 0, outW);
    const localY = clamp(p.y - idx * cropH, 0, cropH);

    const img = getImg(it.path);
    img.then((im) => {
      const iw = im.width;
      const ih = im.height;
      const coverScale = Math.max(outW / iw, cropH / ih);

      const s0 = coverScale * it.extraScale;
      const s1 = coverScale * next;
      const ratio = s1 / Math.max(1e-6, s0);

      const scaledW0 = iw * s0;
      const scaledH0 = ih * s0;
      const maxX0 = Math.max(0, scaledW0 - outW);
      const maxY0 = Math.max(0, scaledH0 - cropH);
      const cx0 = Math.floor(maxX0 / 2);
      const cy0 = Math.floor(maxY0 / 2);
      const x0 = clamp(cx0 + Math.round(it.offX * scaleOut), 0, maxX0);
      const y0 = clamp(cy0 + Math.round(it.offY * scaleOut), 0, maxY0);

      const scaledW1 = iw * s1;
      const scaledH1 = ih * s1;
      const maxX1 = Math.max(0, scaledW1 - outW);
      const maxY1 = Math.max(0, scaledH1 - cropH);
      const cx1 = Math.floor(maxX1 / 2);
      const cy1 = Math.floor(maxY1 / 2);

      const x1 = clamp(((x0 + localX) * ratio) - localX, 0, maxX1);
      const y1 = clamp(((y0 + localY) * ratio) - localY, 0, maxY1);

      pendingOffX = (x1 - cx1) / Math.max(1e-6, scaleOut);
      pendingOffY = (y1 - cy1) / Math.max(1e-6, scaleOut);
      pendingScale = Number(next.toFixed(3));
      scheduleRerenderSelected();
    });

  }

  function onFit() {
    previewFitMode = true;
    fitPreviewToViewport();
  }

  function onZoom(delta: number) {
    previewFitMode = false;
    const next = Math.min(6, Math.max(0.2, previewScale * delta));
    previewScale = Number(next.toFixed(3));
  }

  async function exportImage() {
    if (!items.length) {
      Message.waring('请先添加图片');
      return;
    }

    const targetW = Math.max(100, safeInt(targetWText, 1080));
    const ratio = parseRatio(ratioText, { w: 5, h: 3 });
    const maxH = Math.max(200, safeInt(maxHText, 12000));

    const { canvas } = await composeToCanvas({
      items,
      baseTargetW: targetW,
      renderTargetW: targetW,
      ratio,
      maxH,
      autoScale: autoScaleExport,
    });

    const blob: Blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.95);
    });
    const buf = new Uint8Array(await blob.arrayBuffer());
    const ts = new Date();
    const pad = (n: number) => `${n}`.padStart(2, '0');
    const name = `stitch_${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.jpg`;
    const defaultPath = $config?.output ? `${$config.output}/${name}` : name;

    const res = await window.api['save:saveAs']({
      defaultPath,
      filters: [
        { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
        { name: 'PNG', extensions: ['png'] },
      ],
      buf,
    });

    if (res.code === 0 && res.data) {
      Message.success(`已保存: ${res.data}`);
    } else if (res.code !== 0) {
      Message.error(res.message || '保存失败');
    }
  }

  $: if (items) {
    // keep preview fresh when global settings change
    // (avoid immediate first run before mount)
  }

  // initial preview if list already exists
  setTimeout(() => {
    schedulePreview();
  }, 0);

  // no url resources to revoke
</script>

<div class="stitch-wrap">
  <div class="stitch-left">
    <div class="stitch-toolbar">
      <div class="button grass" on:click={openFilePicker} on:keypress role="button" tabindex="-1">添加图片</div>
      <input class="hide" type="file" accept="image/*" multiple bind:this={fileInput} on:change={onPickFiles} />
      <div class="button grass" on:click={removeSelected} on:keypress role="button" tabindex="-1">移除</div>
      <div class="button grass" on:click={() => moveSelected(-1)} on:keypress role="button" tabindex="-1">上移</div>
      <div class="button grass" on:click={() => moveSelected(1)} on:keypress role="button" tabindex="-1">下移</div>
      <div class="button grass primary" on:click={exportImage} on:keypress role="button" tabindex="-1">导出</div>
    </div>

    <div class="stitch-left-settings grass-inset param-sidebar">
      <div class="stitch-panel">
        <div class="panel-title">全局设置</div>
        <div class="row">
          <span class="label">输出宽度(px)</span>
          <input class="input" bind:value={targetWText} on:change={schedulePreview} />
        </div>
        <div class="row">
          <span class="label">最终比例 W:H</span>
          <input class="input" bind:value={ratioText} on:input={schedulePreview} />
        </div>
        <div class="row">
          <span class="label">最大高度(px)</span>
          <input class="input" bind:value={maxHText} on:change={schedulePreview} />
        </div>
        <div class="row">
          <span class="label">超高缩放导出</span>
          <Switch bind:value={autoScaleExport} />
        </div>
        <div class="row">
          <div class="button" on:click={refreshPreview} on:keypress role="button" tabindex="-1">刷新预览</div>
        </div>
      </div>

      <div class="stitch-list">
        {#if !items.length}
          <div class="empty">还没有图片</div>
        {:else}
          {#each items as it, idx (it.path + ':' + idx)}
            <div class="list-item grass" class:active={idx === selected} on:click={() => setSelected(idx)} on:keypress role="button" tabindex="-1">
              <div class="name">{idx + 1}. {it.name}</div>
              <div class="meta">scale {it.extraScale.toFixed(2)} | x {it.offX} | y {it.offY}</div>
            </div>
          {/each}
        {/if}
      </div>

      <div class="stitch-panel">
        <div class="panel-title">当前图片微调</div>
        {#if selected < 0 || selected >= items.length}
          <div class="empty">未选择图片</div>
        {:else}
          {@const it = items[selected]}
          <div class="row">
            <span class="label">额外缩放</span>
            <input type="range" min="0.5" max="2.5" step="0.01" value={it.extraScale} on:input={onScaleInput} />
            <span class="val">{it.extraScale.toFixed(2)}</span>
          </div>
          <div class="row">
            <span class="label">X 偏移</span>
            <input type="range" min="-4000" max="4000" step="1" value={it.offX} on:input={onOffXInput} />
            <span class="val">{it.offX}</span>
          </div>
          <div class="row">
            <span class="label">Y 偏移</span>
            <input type="range" min="-4000" max="4000" step="1" value={it.offY} on:input={onOffYInput} />
            <span class="val">{it.offY}</span>
          </div>
          <div class="row">
            <div class="button" on:click={resetSelected} on:keypress role="button" tabindex="-1">重置当前图</div>
          </div>
        {/if}
      </div>
    </div>
  </div>

  <div class="stitch-right">
    <div class="preview grass-inset">
      <div class="preview-head">
        <div class="title">预览</div>
        <div class="actions">
          <span class="info">{previewInfo}</span>
          <div class="button" on:click={onFit} on:keypress role="button" tabindex="-1">适配</div>
          <div class="button" on:click={() => onZoom(1 / 1.15)} on:keypress role="button" tabindex="-1">-</div>
          <div class="button" on:click={() => onZoom(1.15)} on:keypress role="button" tabindex="-1">+</div>
        </div>
      </div>

      <div class="preview-body">
        {#if items.length}
          <div
            class="img-scroll"
            class:dragging={dragActive}
            bind:this={previewScrollEl}
            on:pointerdown={startDrag}
            on:pointermove={moveDrag}
            on:pointerup={endDrag}
            on:pointercancel={endDrag}
            on:wheel|preventDefault={onWheelZoom}
          >
            <canvas bind:this={previewCanvasEl} class="canvas" style={`transform: scale(${previewScale});`} />
          </div>
        {:else}
          <div class="empty">暂无预览</div>
        {/if}

        <!-- keep UI stable; no loading overlay during micro-adjust -->
      </div>
    </div>
  </div>
</div>
