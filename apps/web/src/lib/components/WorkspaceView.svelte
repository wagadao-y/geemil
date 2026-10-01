<script lang="ts">
  import { onMount } from 'svelte';
  import { replaceState } from '$app/navigation';
  import { Layers3, Bookmark, PanelLeftClose, PanelLeftOpen } from '@lucide/svelte';
  import type { SiteBundle } from '$lib/types';
  import { provideWorkspace, Workspace } from '$lib/state/workspace.svelte';
  import AppHeader from './AppHeader.svelte';
  import HierarchyTree from './HierarchyTree.svelte';
  import SavedViews from './SavedViews.svelte';
  import LayersPanel from './LayersPanel.svelte';
  import ViewerPane from './ViewerPane.svelte';
  import Inspector from './Inspector.svelte';
  import Toasts from './Toasts.svelte';

  let { bundle }: { bundle: SiteBundle } = $props();

  // svelte-ignore state_referenced_locally
  const ws = new Workspace(bundle);
  provideWorkspace(ws);

  /** Restores a shared link once the viewer exists. */
  function applyUrl() {
    const params = new URLSearchParams(location.search);
    const cam = params.get('cam')?.split(',').map(Number);
    const hide = params.get('hide')?.split(',').filter(Boolean) ?? [];
    for (const id of hide) ws.hiddenNodes.add(id);
    const floor = params.get('floor');
    if (floor && ws.nodesById.has(floor)) {
      ws.floorFilter = floor;
      ws.focusNodeId = floor;
    }
    if (cam?.length === 6 && cam.every(Number.isFinite)) {
      void ws.viewer?.flyTo(
        {
          position: [cam[0], cam[1], cam[2]],
          target: [cam[3], cam[4], cam[5]],
        },
        0,
      );
    }
    const annotation = params.get('a');
    if (annotation) ws.selectAnnotation(annotation, { fly: !cam });
    const pano = ws.bundle.panoramas.find((p) => p.id === params.get('pano'));
    if (pano) void ws.openPanorama(pano);
    if (params.size > 0) replaceState(location.pathname, {});
  }

  let restored = false;
  $effect(() => {
    if (ws.viewer && !restored) {
      restored = true;
      applyUrl();
    }
  });

  function onKeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    const typing = target.closest('input, textarea, select, [contenteditable]');
    if (event.key === 'Escape') {
      if (typing) {
        (target as HTMLElement).blur();
        return;
      }
      if (ws.tool !== 'select' || ws.measurePoints.length) {
        ws.tool = 'select';
        ws.measurePoints = [];
      } else if (ws.selection?.type === 'draft') ws.clearSelection();
      else if (ws.panoramaId) void ws.closePanorama();
      else ws.clearSelection();
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    const keys: Record<string, () => void> = {
      v: () => (ws.tool = 'select'),
      m: () => (ws.tool = 'measure'),
      n: () => (ws.tool = 'annotate'),
      h: () => ws.home(),
      '[': () => (ws.showLeft = !ws.showLeft),
    };
    keys[event.key.toLowerCase()]?.();
  }

  onMount(() => {
    document.title = `${bundle.site.name} · Spatial Hub`;
  });
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app" class:no-left={!ws.showLeft} class:with-right={!!ws.selection}>
  <AppHeader />

  {#if ws.showLeft}
    <aside class="left">
      <div class="left-head">
        <h2>施設構成</h2>
        <button
          class="icon-btn"
          title="パネルを閉じる  ["
          aria-label="パネルを閉じる"
          onclick={() => (ws.showLeft = false)}
        >
          <PanelLeftClose size={16} />
        </button>
      </div>
      <div class="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={ws.leftTab === 'tree'}
          class:active={ws.leftTab === 'tree'}
          onclick={() => (ws.leftTab = 'tree')}
        >
          <Layers3 size={14} /> 階層
        </button>
        <button
          role="tab"
          aria-selected={ws.leftTab === 'views'}
          class:active={ws.leftTab === 'views'}
          onclick={() => (ws.leftTab = 'views')}
        >
          <Bookmark size={14} /> 保存ビュー
          {#if ws.savedViews.length}<span class="count">{ws.savedViews.length}</span>{/if}
        </button>
      </div>
      <div class="left-body scroll">
        {#if ws.leftTab === 'tree'}
          <HierarchyTree />
        {:else}
          <SavedViews />
        {/if}
      </div>
      <LayersPanel />
    </aside>
  {:else}
    <button
      class="reopen glass"
      title="施設構成を開く  ["
      aria-label="施設構成を開く"
      onclick={() => (ws.showLeft = true)}
    >
      <PanelLeftOpen size={16} />
    </button>
  {/if}

  <main class="center">
    <ViewerPane />
  </main>

  {#if ws.selection}
    <aside class="right">
      <Inspector />
    </aside>
  {/if}

  <Toasts />
</div>

<style>
  .app {
    display: grid;
    grid-template-columns: 296px minmax(0, 1fr) 0;
    grid-template-rows: 56px minmax(0, 1fr);
    grid-template-areas:
      'header header header'
      'left center right';
    height: 100vh;
    overflow: hidden;
  }
  .app.with-right {
    grid-template-columns: 296px minmax(0, 1fr) 352px;
  }
  .app.no-left {
    grid-template-columns: 0 minmax(0, 1fr) 0;
  }
  .app.no-left.with-right {
    grid-template-columns: 0 minmax(0, 1fr) 352px;
  }
  .left {
    grid-area: left;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--line);
    background: var(--panel);
  }
  .left-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 10px 4px 16px;
  }
  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  .tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    padding: 0 8px;
    border-bottom: 1px solid var(--line);
  }
  .tabs button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 38px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--muted);
    font-weight: 500;
  }
  .tabs button:hover {
    color: var(--text);
  }
  .tabs button.active {
    border-bottom-color: var(--accent);
    color: var(--accent);
  }
  .count {
    min-width: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: var(--panel-2);
    border: 1px solid var(--line);
    color: var(--muted);
    font-size: 11px;
    line-height: 16px;
  }
  .left-body {
    flex: 1;
    min-height: 0;
  }
  .center {
    grid-area: center;
    position: relative;
    min-width: 0;
    min-height: 0;
  }
  .right {
    grid-area: right;
    min-height: 0;
    border-left: 1px solid var(--line);
    background: var(--panel);
  }
  .reopen {
    position: absolute;
    top: 104px;
    left: 12px;
    z-index: 30;
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: var(--radius);
  }
  @media (max-width: 1100px) {
    .app.with-right {
      grid-template-columns: 0 minmax(0, 1fr) 340px;
    }
    .app.with-right .left {
      display: none;
    }
  }
</style>
