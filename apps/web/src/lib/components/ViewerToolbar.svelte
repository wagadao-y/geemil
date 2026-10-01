<script lang="ts">
  import {
    MousePointer2,
    Ruler,
    MapPinPlus,
    House,
    Maximize,
    Minimize,
    ZoomIn,
    ZoomOut,
  } from '@lucide/svelte';
  import { useWorkspace, type Tool } from '$lib/state/workspace.svelte';

  const ws = useWorkspace();
  let fullscreen = $state(false);

  const tools: { id: Tool; label: string; key: string; icon: typeof Ruler }[] = [
    { id: 'select', label: '選択・移動', key: 'V', icon: MousePointer2 },
    { id: 'measure', label: '距離を計測', key: 'M', icon: Ruler },
    { id: 'annotate', label: '注記を追加', key: 'N', icon: MapPinPlus },
  ];

  function setTool(tool: Tool) {
    ws.tool = ws.tool === tool ? 'select' : tool;
    if (ws.tool !== 'measure') ws.measurePoints = [];
  }

  async function toggleFullscreen() {
    const main = document.querySelector('.center');
    if (document.fullscreenElement) await document.exitFullscreen();
    else await main?.requestFullscreen();
  }
</script>

<svelte:document onfullscreenchange={() => (fullscreen = !!document.fullscreenElement)} />

<div class="toolbar">
  <div class="group">
    {#each tools as tool (tool.id)}
      <button
        class:active={ws.tool === tool.id}
        onclick={() => setTool(tool.id)}
        aria-label={tool.label}
        aria-pressed={ws.tool === tool.id}
      >
        <tool.icon size={18} />
        <span class="tip">{tool.label}<kbd>{tool.key}</kbd></span>
      </button>
    {/each}
  </div>
  {#if !ws.panoramaId}
    <div class="group">
      <button onclick={() => ws.viewer?.zoom(0.6)} aria-label="ズームイン">
        <ZoomIn size={18} /><span class="tip">ズームイン</span>
      </button>
      <button onclick={() => ws.viewer?.zoom(1.6)} aria-label="ズームアウト">
        <ZoomOut size={18} /><span class="tip">ズームアウト</span>
      </button>
      <button onclick={() => ws.home()} aria-label="敷地全体を表示">
        <House size={18} /><span class="tip">敷地全体<kbd>H</kbd></span>
      </button>
    </div>
  {/if}
  <div class="group">
    <button onclick={toggleFullscreen} aria-label="全画面">
      {#if fullscreen}<Minimize size={18} />{:else}<Maximize size={18} />{/if}
      <span class="tip">{fullscreen ? '全画面を終了' : '全画面'}</span>
    </button>
  </div>
</div>

<style>
  .toolbar {
    position: absolute;
    top: 50%;
    right: 12px;
    z-index: 20;
    display: grid;
    gap: 8px;
    translate: 0 -50%;
  }
  .group {
    display: grid;
    padding: 4px;
    border-radius: 10px;
    background: rgb(255 255 255 / 96%);
    box-shadow: var(--shadow-lg);
  }
  button {
    position: relative;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border: 0;
    border-radius: 7px;
    background: none;
    color: var(--text-2);
  }
  button:hover {
    background: var(--panel-2);
    color: var(--text);
  }
  button.active {
    background: var(--accent);
    color: #fff;
  }
  .tip {
    position: absolute;
    top: 50%;
    right: calc(100% + 10px);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 9px;
    border-radius: 6px;
    background: #1d252c;
    color: #f1f5f7;
    font-size: 12px;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    translate: 4px -50%;
    transition:
      opacity 0.12s,
      translate 0.12s;
  }
  button:hover .tip {
    opacity: 1;
    translate: 0 -50%;
  }
  kbd {
    padding: 0 4px;
    border: 1px solid rgb(255 255 255 / 25%);
    border-radius: 3px;
    font-family: var(--mono);
    font-size: 10px;
  }
</style>
