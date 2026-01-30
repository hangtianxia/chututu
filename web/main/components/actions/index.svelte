<script lang='ts'>
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { arrToObj, roundDecimalPlaces } from '@common/utils';
  import { ActionItem } from '@components';
  import { Message, Switch, ColorPicker } from '@ggchivalrous/db-ui';
  import { config, pathInfo } from '@web/store/config';
  import { smoothIncrement } from '@web/util/util';
  import { genPreviewGpuLike } from '@web/modules/preview-tool';

  import type { ImgInfo, IConfig, IFileInfo, TInputEvent } from '../../interface';

  import './index.scss';

  export let labelWidth = '90px';
  export let fileInfoList: IFileInfo[] = [];
  export let processing = false;

  const dispatch = createEventDispatcher<{
    pickFiles: void
    startTask: void
    openParamSetting: void
    openTempSetting: void
  }>();

  let handleCount = 0;
  let outputDirName = '';
  let imgInfoRecord: Record<string, ImgInfo> = {};

  let previewId = '';
  let previewUrl = '';
  let previewLoading = false;
  let previewError = '';
  let previewTimer: ReturnType<typeof setTimeout>;
  let previewReqInc = 0;
  let previewRevoke: null | (() => void) = null;
  let previewZoom = 1;
  let previewNaturalW = 0;
  let previewNaturalH = 0;
  let previewScrollEl: HTMLDivElement | null = null;
  let autoFitNextPreviewLoad = false;
  let lastPreviewId = '';

  let fileListSig = '';
  let outputManualForThisPick = false;

  let panActive = false;
  let panStartX = 0;
  let panStartY = 0;
  let panStartScrollLeft = 0;
  let panStartScrollTop = 0;

  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

  // Curvature (corner radius) drag control
  const radiusMin = 0;
  const radiusMax = 50;
  let radiusTrackEl: HTMLDivElement | null = null;
  let radiusDragActive = false;
  let radiusPreviewOverride: { radius: number, radius_show: boolean } | null = null;
  let radiusPreviewTimer: ReturnType<typeof setTimeout> | null = null;

  function startPreviewPan(e: PointerEvent) {
    if (!previewId) return;
    const el = e.currentTarget as HTMLElement | null;
    if (!el) return;
    panActive = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartScrollLeft = el.scrollLeft;
    panStartScrollTop = el.scrollTop;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }

  function movePreviewPan(e: PointerEvent) {
    if (!panActive) return;
    const el = e.currentTarget as HTMLElement | null;
    if (!el) return;
    const dx = e.clientX - panStartX;
    const dy = e.clientY - panStartY;
    el.scrollLeft = panStartScrollLeft - dx;
    el.scrollTop = panStartScrollTop - dy;
  }

  function endPreviewPan() {
    panActive = false;
  }

  function stopNativeDrag(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  $: getPathName($config.output);
  $: onFileInfoList(fileInfoList);
  $: getHandleCount(imgInfoRecord);
  $: ensurePreviewId(fileInfoList);
  $: schedulePreview($config, previewId);

  $: if (previewId && previewId !== lastPreviewId) {
    lastPreviewId = previewId;
    previewZoom = 1;
    previewNaturalW = 0;
    previewNaturalH = 0;
    autoFitNextPreviewLoad = true;
  }

  onDestroy(() => {
    if (previewTimer) {
      clearTimeout(previewTimer);
    }

    if (radiusPreviewTimer) {
      clearTimeout(radiusPreviewTimer);
      radiusPreviewTimer = null;
    }

    previewRevoke?.();
    previewRevoke = null;
  });

  window.api['on:progress']((data: Pick<ImgInfo, 'id' | 'progress'>) => {
    if (imgInfoRecord[data.id]) {
      if (imgInfoRecord[data.id].closeInterval) {
        imgInfoRecord[data.id].closeInterval();
      }

      imgInfoRecord[data.id].closeInterval = smoothIncrement(
        imgInfoRecord[data.id].progress,
        data.progress,
        10,
        (n) => {
          imgInfoRecord[data.id].progress = n;
        },
      );
    }
  });

  window.api['on:faildTask']((data: { id: string, msg: string }) => {
    if (!imgInfoRecord[data.id]) {
      return;
    }

    imgInfoRecord[data.id].faild = true;
    imgInfoRecord[data.id].faildMsg = data.msg;
  });

  function getHandleCount(_imgInfoRecord: typeof imgInfoRecord) {
    handleCount = Object.values(_imgInfoRecord).filter((i) => i.progress === 100 || i.faild).length;
  }

  function getDirFromFilePath(p: string) {
    const s = (p || '').trim();
    if (!s) return '';
    const isWin = s.includes('\\');
    const sep = isWin ? '\\' : '/';
    const idx = s.lastIndexOf(sep);
    if (idx < 0) return '';
    if (!isWin && idx === 0) return '/';
    // windows root like C:\x.jpg
    if (isWin && idx === 2 && s[1] === ':') return `${s.slice(0, 2)}\\`;
    return s.slice(0, idx);
  }

  function ensurePreviewId(list: IFileInfo[]) {
    if (!list?.length) {
      previewId = '';
      previewUrl = '';
      previewError = '';
      previewLoading = false;
      return;
    }

    if (!previewId || !list.find((i) => i.id === previewId)) {
      previewId = list[0].id;
    }
  }

  function touchConfig() {
    // 触发 store 通知（内部对象是引用类型，深层修改需要显式触发）
    config.update((d) => d);
  }

  function schedulePreview(_: any, id: string) {
    if (!id) {
      return;
    }

    if (previewTimer) {
      clearTimeout(previewTimer);
    }

    previewTimer = setTimeout(() => {
      runPreview(id);
    }, 250);
  }

  function schedulePreviewFast(id: string) {
    if (!id) return;
    if (radiusPreviewTimer) {
      clearTimeout(radiusPreviewTimer);
    }
    radiusPreviewTimer = setTimeout(() => {
      radiusPreviewTimer = null;
      runPreview(id);
    }, 60);
  }

  function getPreviewConfig(): IConfig {
    if (!radiusPreviewOverride) return $config;
    return {
      ...$config,
      options: {
        ...$config.options,
        ...radiusPreviewOverride,
      },
    };
  }

  function setRadiusOverrideFromClientX(clientX: number) {
    const el = radiusTrackEl;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const p = (clientX - rect.left) / w;
    const v = radiusMin + clamp(p, 0, 1) * (radiusMax - radiusMin);
    const next = roundDecimalPlaces(v, 1);
    radiusPreviewOverride = { radius: next, radius_show: true };
  }

  function startRadiusDrag(e: PointerEvent) {
    radiusDragActive = true;
    setRadiusOverrideFromClientX(e.clientX);
    schedulePreviewFast(previewId);
    try {
      (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
  }

  function moveRadiusDrag(e: PointerEvent) {
    if (!radiusDragActive) return;
    setRadiusOverrideFromClientX(e.clientX);
    schedulePreviewFast(previewId);
  }

  function endRadiusDrag() {
    if (!radiusDragActive) return;
    radiusDragActive = false;
    if (radiusPreviewOverride) {
      const { radius } = radiusPreviewOverride;
      config.update((d) => {
        d.options.radius = radius;
        d.options.radius_show = true;
        return d;
      });
      radiusPreviewOverride = null;
      runPreview(previewId);
    }
  }

  async function runPreview(id: string) {
    const file = fileInfoList.find((i) => i.id === id);
    if (!file?.path) {
      return;
    }

    const reqId = ++previewReqInc;
    if (!radiusDragActive) {
      previewLoading = true;
      previewError = '';
    }

    try {
      const exif = await getExitInfo(id, file.path);
      const r = await genPreviewGpuLike({
        path: file.path,
        maxSize: 1100,
        quality: 82,
        config: getPreviewConfig(),
        exif,
        logoPath: $pathInfo.logo,
      });

      if (reqId !== previewReqInc) {
        r?.revoke?.();
        return;
      }

      previewRevoke?.();
      previewRevoke = r.revoke || null;
      previewUrl = r.url;
      previewLoading = false;
      return;
    } catch (e: any) {
      if (reqId !== previewReqInc) {
        return;
      }
      // fall back to main-process preview (CPU)
      try {
        const res = await window.api.preview({
          path: file.path,
          name: file.name,
          maxSize: 1100,
        });

        if (reqId !== previewReqInc) {
          return;
        }

        previewRevoke?.();
        previewRevoke = null;
        previewLoading = false;

        if (res.code === 0) {
          previewUrl = res.data;
        } else {
          previewError = res.message || '预览生成失败';
        }
      } catch (e1: any) {
        if (reqId !== previewReqInc) {
          return;
        }
        previewLoading = false;
        previewError = e1?.message || e?.message || `${e1}` || `${e}` || '预览生成失败';
      }
    }
  }

  function onFileInfoList(list: IFileInfo[]) {
    const sig = (list || []).map((i) => i.id).join(',');
    if (sig !== fileListSig) {
      fileListSig = sig;
      outputManualForThisPick = false;
    }

    imgInfoRecord = arrToObj(list, 'id', (i): ImgInfo => ({
      ...i,
      closeInterval: null,
      progress: 0,
      exif: null,
      faild: false,
      faildMsg: '',
      ...imgInfoRecord[i.id],
    }));

    // Default output dir = the directory of the selected image.
    const firstPath = list?.[0]?.path;
    const dir = firstPath ? getDirFromFilePath(firstPath) : '';
    if (dir && !outputManualForThisPick) {
      $config.output = dir;
      touchConfig();
    }
  }

  async function changeOutputPath() {
    const data = await window.api['open:selectPath']();
    if (data.code === 0 && data.data.output) {
      $config.output = data.data.output;
      outputManualForThisPick = true;
      touchConfig();
    }
  }

  function openDir(dir: string) {
    window.api['open:dir'](dir);
  }

  function getPathName(path: string) {
    path = path.trim();

    if (!path) {
      outputDirName = '异常目录无法识别';
      return;
    }

    const isMatch = path.match(/^([A-Za-z]:)\\/);

    if (isMatch) {
      const arr = path.replace(isMatch[1], '').split('\\');
      outputDirName = arr[arr.length - 1] || isMatch[0];
      return;
    }

    const arr = path.split('/');
    outputDirName = arr[arr.length - 1] || '/';
  }

  function onBGRateChange(e: CustomEvent<boolean>) {
    if (e.detail) {
      config.update((d) => {
        d.options.landscape = false;
        return d;
      });
    }

    touchConfig();
  }

  const numReg = /-{0,1}\d+\.{0,1}\d{0,3}/;
  function onNumInputChange(v: TInputEvent, key: keyof IConfig['options'], max: number, min: number, decimal?: number) {
    let _v = v.currentTarget.value;
    const match = _v.match(numReg);

    if (match && match.length) {
      _v = match[0];
    }

    let num = +_v;
    if (Number.isNaN(num)) num = min;
    else if (num < min) num = min;
    else if (num > max) num = max;

    num = typeof decimal === 'number' ? roundDecimalPlaces(num, decimal) : num;
    ($config.options[key] as number) = num;
    v.currentTarget.value = `${num}`;

    touchConfig();
  }

  function switchBgRate() {
    config.update((d) => {
      d.options.bg_rate = {
        w: d.options.bg_rate.h,
        h: d.options.bg_rate.w,
      };
      return d;
    });
  }

  function selectPreview(id: string) {
    previewId = id;
    runPreview(id);
  }

  function zoomPreview(factor: number | 'fit') {
    if (factor === 'fit') {
      if (previewScrollEl && previewNaturalW && previewNaturalH) {
        const cw = Math.max(1, previewScrollEl.clientWidth);
        const ch = Math.max(1, previewScrollEl.clientHeight);
        const z = Math.min(cw / previewNaturalW, ch / previewNaturalH, 1);
        previewZoom = Math.max(0.05, z);
      } else {
        previewZoom = 1;
      }
      return;
    }
    previewZoom = Math.max(0.2, Math.min(6, previewZoom * factor));
  }

  function onPreviewWheel(e: WheelEvent) {
    if (!previewId) return;
    const factor = Math.exp(-e.deltaY * 0.001);
    previewZoom = Math.max(0.2, Math.min(6, previewZoom * factor));
  }

  function onPreviewImgLoad(e: Event) {
    const img = e.currentTarget as HTMLImageElement;
    previewNaturalW = img.naturalWidth || 0;
    previewNaturalH = img.naturalHeight || 0;

    // only auto-fit when selecting a new image
    if (autoFitNextPreviewLoad) {
      autoFitNextPreviewLoad = false;
      zoomPreview('fit');
    }
  }

  function refreshPreview() {
    if (previewId) {
      runPreview(previewId);
    }
  }

  async function getExitInfo(id: string, path: string) {
    if (imgInfoRecord[id].exif !== null) {
      return imgInfoRecord[id].exif;
    }

    const info = await window.api.getExitInfo(path);
    imgInfoRecord[id].exif = info.data || undefined;

    return info.data;
  }

  async function cpExif(id: string) {
    if (!imgInfoRecord[id] || !imgInfoRecord[id].exif) {
      return Message.error('图片信息不存在！！');
    }

    navigator.clipboard.writeText(JSON.stringify(imgInfoRecord[id].exif, null, 2));
    return Message.success('相机信息已复制到粘贴板');
  }

  async function clearImgInfo() {
    const res = await window.api.drainQueue();
    if (res.code !== 0) {
      Message.error(`清空失败！${res.message || ''}`);
      return;
    }

    Message.success('清空成功');
    fileInfoList = [];
  }
</script>

<div class="app-action-wrap">
  <div class="app-action-left-wrap">
    <div class="watermark-toolbar">
      <div class="button grass" on:click={() => dispatch('pickFiles')} on:keypress role="button" tabindex="-1">添加图片</div>
      <div class="button grass primary" on:click={() => dispatch('startTask')} on:keypress role="button" tabindex="-1">
        {#if processing}
          导出中...
        {:else}
          导出
        {/if}
      </div>
      <div class="button grass" on:click={() => dispatch('openParamSetting')} on:keypress role="button" tabindex="-1">参数设置</div>
      <div class="button grass" on:click={() => dispatch('openTempSetting')} on:keypress role="button" tabindex="-1">模板设置</div>
    </div>

    <div class="left-settings grass-inset param-sidebar">
    <ActionItem {labelWidth} title="输出目录">
      <svelte:fragment slot="popup">图片输出目录，点击可以打开目录</svelte:fragment>
      <span class="db-icon-setting output-setting" on:click|stopPropagation={changeOutputPath} on:keypress role="button" tabindex="-1"></span>
      <span class="open-file-line" on:click={() => openDir($config.output)} on:keypress role="button" tabindex="-1">{outputDirName}</span>
    </ActionItem>

    <ActionItem {labelWidth} title="主图占比">
      <svelte:fragment slot="popup">
        指定主图对背景宽度的占比（可以调节左右边框的宽度）
        <br>
        默认主图占背景的90%
      </svelte:fragment>
      <input
        class="input"
        type="text"
        value={$config.options.main_img_w_rate}
        style="width: 103px;"
        on:change={(v) => onNumInputChange(v, 'main_img_w_rate', 100, 1, 0)}
      />
    </ActionItem>

    <ActionItem {labelWidth} title="文本间距">
      <svelte:fragment slot="popup">
        指定文本上下间距（临时性功能，后续会去掉）
        <br>
        默认0.4
      </svelte:fragment>
      <input
        class="input"
        type="text"
        value={$config.options.text_margin}
        style="width: 103px;"
        on:change={(v) => onNumInputChange(v, 'text_margin', 10000, 0, 2)}
      />
    </ActionItem>

    <ActionItem {labelWidth} title="最小上下边距">
      <svelte:fragment slot="popup">
        指定水印上下边距的最小值，默认情况使用阴影宽度作为上下边距
        <br>
        设置最小上下边距，将会从它和阴影之间取最大值
        <br>
        按照背景高度比例换算，值为 0-100
        <br>
        默认：0
      </svelte:fragment>
      <input
        class="input"
        type="text"
        value={$config.options.mini_top_bottom_margin}
        style="width: 103px;"
        on:change={(v) => onNumInputChange(v, 'mini_top_bottom_margin', 100, 0, 2)}
      />
    </ActionItem>

    <ActionItem {labelWidth} title="主图圆角">
      <svelte:fragment slot="popup">
        控制主图区域（含阴影遮罩“洞口”）的圆角
        <br>
        不影响底部文字区域
        <br>
        取值范围: 0 - 50
        <br>
        默认值: 2.1
      </svelte:fragment>
      <Switch bind:value={$config.options.radius_show} on:change={touchConfig} />
      <input
        class="input"
        type="text"
        value={$config.options.radius}
        style="width: 103px;"
        on:change={(v) => onNumInputChange(v, 'radius', 50, 0, 1)}
      />
      {@const _radiusV = radiusPreviewOverride?.radius ?? $config.options.radius}
      {@const _radiusP = clamp((_radiusV - radiusMin) / (radiusMax - radiusMin), 0, 1)}
      <div class="radius-drag" bind:this={radiusTrackEl} on:pointerdown={startRadiusDrag} on:pointermove={moveRadiusDrag} on:pointerup={endRadiusDrag} on:pointercancel={endRadiusDrag}>
        <div class="radius-drag-track" />
        <div class="radius-drag-fill" style={`width:${Math.round(_radiusP * 100)}%;`} />
        <div class="radius-drag-thumb" style={`left:${Math.round(_radiusP * 100)}%;`} />
        <div class="radius-drag-val">{roundDecimalPlaces(_radiusV, 1)}</div>
      </div>
    </ActionItem>

    <ActionItem {labelWidth} title="阴影大小">
      <svelte:fragment slot="popup">
        指定阴影的大小，不指定则无阴影
        <br>
        设置的值为图片高度的百分比，例如: 1，则为0.01%
        <br>
        默认值：6
      </svelte:fragment>
      <Switch bind:value={$config.options.shadow_show} on:change={touchConfig} />
      <input
        class="input"
        type="text"
        value={$config.options.shadow}
        style="width: 103px;"
        on:change={(v) => onNumInputChange(v, 'shadow', 50, 0, 1)}
      />
    </ActionItem>

    <ActionItem {labelWidth} title="输出质量">
      <svelte:fragment slot="popup">
        指定输出质量，只允许整数
        <br>
        默认值：100
      </svelte:fragment>
      <input
        class="input"
        type="text"
        value={$config.options.quality}
        style="width: 103px;"
        on:change={(v) => onNumInputChange(v, 'quality', 100, 1, 0)}
      />
    </ActionItem>

    <ActionItem {labelWidth} title="输出宽高比">
      <svelte:fragment slot="popup">
        指定输出的图片的宽高比(该比例只生效于背景，对原图不生效)
        <br>
        该选项生效后影响以下选项效果：
        <br>
        <b>横屏输出：</b>失效
      </svelte:fragment>
      <Switch bind:value={$config.options.bg_rate_show} on:change={onBGRateChange} />
      <input class="input" style="width: 40px; margin-right: 4px;" type="text" bind:value={$config.options.bg_rate.w} on:change={touchConfig}/>
      <i class="switch icon db-icon-sort" on:click={switchBgRate} role="button" tabindex="-1" on:keypress />
      <input class="input" style="width: 40px; margin-left: 5px;" type="text" bind:value={$config.options.bg_rate.h} on:change={touchConfig}/>
    </ActionItem>

    <ActionItem {labelWidth} title="纯色背景">
      <svelte:fragment slot="popup">使用纯色背景，默认使用图片模糊做背景</svelte:fragment>
      <Switch bind:value={$config.options.solid_bg} on:change={touchConfig} />
      {#if $config.options.solid_bg}
        <ColorPicker bind:value={$config.options.solid_color} size="mini" on:change={touchConfig}/>
      {/if}
    </ActionItem>

    <ActionItem {labelWidth} title="横屏输出">
      <svelte:fragment slot="popup">
        软件自己判断图片宽高那一边更长
        <br>
        将背景横向处理
        <br>
        适合竖图生成横屏图片
      </svelte:fragment>
      <Switch bind:value={$config.options.landscape} disabled={$config.options.bg_rate_show} on:change={touchConfig} />
    </ActionItem>

    <ActionItem {labelWidth} title="快速输出">
      <svelte:fragment slot="popup">
        开启后选择图片/拖拽图片到软件将直接输出水印图片无需点击生成按钮
      </svelte:fragment>
      <Switch bind:value={$config.options.iot} on:change={touchConfig} />
    </ActionItem>

    </div>

    <div class="img-wrap grass-inset">
      <div class="img-list">
        {#each fileInfoList as i (i.id)}
          {@const record = imgInfoRecord[i.id]}
          {#key i.id}
          <div class="img-item grass" class:active={i.id === previewId} on:click={() => selectPreview(i.id)} on:keypress role="button" tabindex="-1">
            <div class="img-item-head">
              <span class="img-name">{i.name}</span>
              {#if record.faild}
                <i class="db-icon-error error"></i>
              {:else if record.progress < 100}
                <span
                  style="font-weight: bold;"
                  class={ record.progress === 100 ? 'success' : ''}
                >{record.progress}%</span>
              {:else}
                <i class="db-icon-success success"></i>
              {/if}
            </div>
            <div class="img-item-info">
              相机信息:
              {#await getExitInfo(i.id, i.path)}
                <i class="db-icon-loading"></i>
              {:then v}
                {#if v}
                  <i class="db-icon-success success"></i>
                  <i class="icon db-icon-document-copy" on:click={() => cpExif(i.id)} on:keypress role="button" tabindex="-1"></i>
                {:else}
                  <i class="db-icon-error error"></i>
                {/if}
              {/await}
            </div>

            <div class="img-item-faild-msg">
              {record.faildMsg}
            </div>
          </div>
          {/key}
        {/each}
      </div>
    </div>

    <div class="task-action">
      <ActionItem title="图片数量">{fileInfoList.length}</ActionItem>
      <ActionItem title="完成数量">{handleCount}</ActionItem>
      <div class="button" on:click={clearImgInfo} on:keypress role="button" tabindex="-1">清空</div>
    </div>
  </div>

  <div class="app-action-right-wrap">
    <div class="preview-wrap grass-inset">
      <div class="preview-head">
        <span class="preview-title">实时预览</span>
        <div class="preview-actions">
          <span class="preview-name">{fileInfoList.find((i) => i.id === previewId)?.name || ''}</span>
          {#if previewId}
            <span class="preview-zoom">{Math.round(previewZoom * 100)}%</span>
            <div class="button" on:click={() => zoomPreview('fit')} on:keypress role="button" tabindex="-1">适配</div>
            <div class="button" on:click={() => zoomPreview(1 / 1.15)} on:keypress role="button" tabindex="-1">-</div>
            <div class="button" on:click={() => zoomPreview(1.15)} on:keypress role="button" tabindex="-1">+</div>
          {/if}
          <div class="button" on:click={refreshPreview} on:keypress role="button" tabindex="-1">刷新</div>
        </div>
      </div>
      <div class="preview-body">
        {#if !previewId}
          <div class="preview-empty">添加图片后自动生成预览</div>
        {:else if previewLoading}
          <div class="preview-loading"><i class="db-icon-loading"></i> 生成中...</div>
        {:else if previewError}
          <div class="preview-error">{previewError}</div>
        {:else if previewUrl}
          <div
            class="preview-scroll"
            class:dragging={panActive}
            role="application"
            tabindex="-1"
            bind:this={previewScrollEl}
            on:wheel|preventDefault={onPreviewWheel}
            on:pointerdown={startPreviewPan}
            on:pointermove={movePreviewPan}
            on:pointerup={endPreviewPan}
            on:pointercancel={endPreviewPan}
            on:dragover|preventDefault|stopPropagation
            on:drop|preventDefault|stopPropagation
          >
            <div class="preview-inner" style={`width:${Math.max(1, Math.round(previewNaturalW * previewZoom))}px;height:${Math.max(1, Math.round(previewNaturalH * previewZoom))}px;`}>
              <img
                class="preview-img"
                alt="preview"
                src={previewUrl}
                draggable={false}
                on:load={onPreviewImgLoad}
                on:dragstart={stopNativeDrag}
              />
            </div>
          </div>
        {:else}
          <div class="preview-empty">暂无预览</div>
        {/if}
      </div>
    </div>
  </div>
</div>
