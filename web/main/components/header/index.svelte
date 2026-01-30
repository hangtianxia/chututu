<script lang="ts">
  import { FontSelect } from '@components';
  import { Popover } from '@ggchivalrous/db-ui';
  import { config, getConfig, resetConfig } from '@web/store/config';
  import './index.scss';

  export let page: 'watermark' | 'stitch' | 'crop' = 'watermark';

  function miniSizeWindow() {
    window.api.miniSize();
  }

  function closeApp() {
    window.api.closeApp();
  }

</script>

<div class="app-header">
  <div class="app-header-left no-drag">
    <div class="mode-tabs grass-inset">
      <div class="mode-tab" class:active={page === 'watermark'} on:click={() => (page = 'watermark')} on:keypress role="button" tabindex="-1">加框</div>
      <div class="mode-tab" class:active={page === 'stitch'} on:click={() => (page = 'stitch')} on:keypress role="button" tabindex="-1">拼图</div>
      <div class="mode-tab" class:active={page === 'crop'} on:click={() => (page = 'crop')} on:keypress role="button" tabindex="-1">裁图</div>
    </div>
  </div>

  <div class="app-header-right">
    {#if page === 'watermark'}
      <FontSelect fontMap={$config.fontMap} bind:value={$config.options.font} on:update={getConfig} />

      <Popover trigger="hover">
        <div slot="reference" class="no-drag button app-header-button app-header-reset" on:click={resetConfig} on:keypress role="button" tabindex="-1">
          <svg class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M491.52 819.2a304.3328 304.3328 0 0 1-217.088-90.112l28.672-28.672a266.24 266.24 0 1 0-40.96-327.68l-35.2256-21.2992A307.2 307.2 0 1 1 491.52 819.2z"></path><path d="M430.08 409.6H245.76a20.48 20.48 0 0 1-20.48-20.48V204.8h40.96v163.84h163.84z"></path><path d="M512 512m-61.44 0a61.44 61.44 0 1 0 122.88 0 61.44 61.44 0 1 0-122.88 0Z"></path></svg>
        </div>
        <p>重置默认配置（含模板/字段）</p>
      </Popover>
    {/if}

    <div class="no-drag button app-header-button" on:click={miniSizeWindow} on:keypress role="button" tabindex="-1">-</div>
    <div class="no-drag button app-header-button" on:click={closeApp} on:keypress role="button" tabindex="-1">x</div>
  </div>
</div>
