<script lang="ts">
  import { onMount } from 'svelte';
  import { ChevronRight, Layers2, ArrowLeft, Camera, LoaderCircle } from '@lucide/svelte';
  import { demoBuildings } from '$lib/api/demo-data';
  import { useWorkspace } from '$lib/state/workspace.svelte';
  import { Viewer } from '$lib/viewer/viewer';
  import SceneLabels from './SceneLabels.svelte';
  import ViewerToolbar from './ViewerToolbar.svelte';
  import ViewCube from './ViewCube.svelte';
  import Minimap from './Minimap.svelte';
  import StatusBar from './StatusBar.svelte';
  import PanoramaBar from './PanoramaBar.svelte';
  import Popover from './Popover.svelte';

  const ws = useWorkspace();
  let stage = $state<HTMLDivElement>();
  let loading = $state(true);
  let floorMenu = $state(false);

  onMount(() => {
    const viewer = new Viewer(stage!);
    ws.viewer = viewer;
    const initial = ws.bundle.savedViews.find((v) => v.id === 'v-overview')?.camera;
    if (initial) void viewer.flyTo(initial, 0);
    viewer.setSite(ws.bundle, demoBuildings).then(
      () => (loading = false),
      (error: unknown) => {
        loading = false;
        console.error(error);
        ws.toast('点群の読み込みに失敗しました', 'error');
      },
    );
    return () => {
      ws.viewer = null;
      viewer.dispose();
    };
  });

  $effect(() => {
    ws.viewer?.applyVisibility({
      hidden: ws.effectiveHidden,
      layers: { ...ws.layers },
      meshOpacity: ws.meshOpacity,
      floorFilter: ws.floorFilter,
    });
  });

  $effect(() => {
    const a = ws.selectedAnnotation;
    const shown = a && ws.layers.annotation && ws.isNodeShown(a.nodeId);
    ws.viewer?.setHighlight(shown && a.extent ? a.extent : null);
  });

  $effect(() => {
    ws.viewer?.setMeasure($state.snapshot(ws.measurePoints));
  });

  // ---- clicks on the canvas: distinguish a click from an orbit drag.
  let down: { x: number; y: number; t: number } | null = null;

  function onPointerDown(event: PointerEvent) {
    if (!(event.target as HTMLElement).classList.contains('viewer-canvas')) return;
    if (event.button !== 0) return;
    down = { x: event.clientX, y: event.clientY, t: performance.now() };
  }

  async function onPointerUp(event: PointerEvent) {
    const start = down;
    down = null;
    if (!start || !ws.viewer) return;
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (moved > 4 || performance.now() - start.t > 500) return;
    const rect = stage!.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (ws.tool === 'select') return;
    const point = await ws.viewer.pick(x, y);
    if (!point) {
      ws.toast('点群かメッシュの上をクリックしてください');
      return;
    }
    if (ws.tool === 'annotate') ws.startDraft(point);
    else if (ws.tool === 'measure') {
      ws.measurePoints = ws.measurePoints.length >= 2 ? [point] : [...ws.measurePoints, point];
    }
  }

  async function onDoubleClick(event: MouseEvent) {
    if (!(event.target as HTMLElement).classList.contains('viewer-canvas')) return;
    if (!ws.viewer || ws.panoramaId || ws.tool !== 'select') return;
    const rect = stage!.getBoundingClientRect();
    const point = await ws.viewer.pick(event.clientX - rect.left, event.clientY - rect.top);
    if (point) ws.viewer.focusPoint(point, 14);
  }

  const crumbs = $derived(ws.path(ws.focusNodeId));
  const floors = $derived(
    ws.focusedBuilding
      ? (ws.children.get(ws.focusedBuilding.id) ?? []).filter((n) => n.kind === 'floor')
      : [],
  );
  const floorName = $derived(
    ws.floorFilter ? (ws.nodesById.get(ws.floorFilter)?.name ?? '') : 'すべての階',
  );

  const hints: Record<string, string> = {
    annotate: '注記を付けたい位置をクリック',
    measure: '始点と終点をクリックして距離を計測',
  };
</script>

<div class="pane">
  <nav class="crumbs" aria-label="現在の場所">
    {#each crumbs as node, i (node.id)}
      {#if i > 0}<ChevronRight size={14} />{/if}
      <button
        class:current={i === crumbs.length - 1}
        onclick={() => (i === 0 ? ws.home() : ws.focusNode(node.id, { select: false }))}
      >
        {i === 0 ? '敷地' : node.name}
      </button>
    {/each}
    {#if crumbs.length === 1}<ChevronRight size={14} /><span class="current">全体</span>{/if}
    {#if ws.panorama}
      <ChevronRight size={14} /><span class="current pano">
        <Camera size={13} />
        {ws.panorama.name}
      </span>
    {/if}
  </nav>

  <div
    class="stage"
    class:tool-active={ws.tool !== 'select'}
    bind:this={stage}
    onpointerdown={onPointerDown}
    onpointerup={onPointerUp}
    ondblclick={onDoubleClick}
    role="application"
    aria-label="3D ビュー"
  >
    <SceneLabels />

    <div class="top-left">
      {#if ws.panorama}
        <button class="chip-btn glass" onclick={() => ws.closePanorama()}>
          <ArrowLeft size={15} /> 3D に戻る
        </button>
        <span class="chip-btn glass static"><Camera size={15} /> 360°写真</span>
      {:else if ws.focusedBuilding && floors.length > 0}
        <div class="floor-switch">
          <button
            class="chip-btn glass"
            onclick={() => (floorMenu = !floorMenu)}
            aria-expanded={floorMenu}
          >
            <Layers2 size={15} />
            {ws.focusedBuilding.name}
            <span class="sep"></span>
            <strong>{floorName}</strong> を表示
          </button>
          <Popover bind:open={floorMenu}>
            <div class="floor-menu">
              {#each [...floors].reverse() as floor (floor.id)}
                <button
                  class:active={ws.floorFilter === floor.id}
                  onclick={() => {
                    ws.focusNode(floor.id, { select: false });
                    floorMenu = false;
                  }}
                >
                  {floor.name}<span>以上を非表示</span>
                </button>
              {/each}
              <button
                class:active={!ws.floorFilter}
                onclick={() => {
                  ws.floorFilter = null;
                  floorMenu = false;
                }}
              >
                すべての階
              </button>
            </div>
          </Popover>
        </div>
      {/if}
      {#if loading}
        <span class="chip-btn glass static loading">
          <LoaderCircle size={14} /> 点群を読み込み中
        </span>
      {/if}
    </div>

    <ViewCube />
    <ViewerToolbar />
    {#if !ws.panorama}<Minimap />{/if}

    {#if hints[ws.tool]}
      <div class="hint glass">
        {hints[ws.tool]}
        {#if ws.tool === 'measure' && ws.measurePoints.length === 1}
          <span class="dim">— 終点をクリック</span>
        {/if}
        <kbd>Esc</kbd> で終了
      </div>
    {/if}

    {#if ws.panorama}
      <PanoramaBar pano={ws.panorama} />
    {:else}
      <StatusBar />
    {/if}
  </div>
</div>

<style>
  .pane {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .crumbs {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
    height: 40px;
    padding: 0 12px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
    color: var(--faint);
    overflow: hidden;
    white-space: nowrap;
  }
  .crumbs button,
  .crumbs .current {
    padding: 3px 6px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--text-2);
    font-weight: 500;
  }
  .crumbs button:hover {
    background: var(--panel-2);
    color: var(--accent);
  }
  .crumbs .current {
    color: var(--text);
    font-weight: 600;
  }
  .crumbs .pano {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--accent);
  }
  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: var(--viewport);
  }
  .stage.tool-active :global(.viewer-canvas) {
    cursor: crosshair;
  }
  .stage :global(.viewer-canvas) {
    display: block;
    outline: none;
  }
  .top-left {
    position: absolute;
    top: 12px;
    left: 12px;
    z-index: 20;
    display: flex;
    gap: 8px;
  }
  .chip-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 34px;
    padding: 0 12px;
    border-radius: var(--radius);
    font-weight: 500;
  }
  button.chip-btn:hover {
    background: rgb(36 44 52 / 90%);
  }
  .chip-btn.static {
    cursor: default;
  }
  .chip-btn strong {
    color: #5eead4;
  }
  .sep {
    width: 1px;
    height: 14px;
    background: var(--glass-line);
  }
  .loading :global(svg) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .floor-switch {
    position: relative;
  }
  .floor-menu {
    display: grid;
    min-width: 200px;
    padding: 6px;
  }
  .floor-menu button {
    display: flex;
    justify-content: space-between;
    padding: 8px 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font-weight: 500;
    text-align: left;
  }
  .floor-menu button span {
    color: var(--faint);
    font-size: 11px;
    font-weight: 400;
  }
  .floor-menu button:hover {
    background: var(--panel-2);
  }
  .floor-menu button.active {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .hint {
    position: absolute;
    top: 12px;
    left: 50%;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 14px;
    border-radius: 999px;
    translate: -50% 0;
    font-weight: 500;
  }
  .hint .dim {
    color: #9fb0bb;
  }
  kbd {
    padding: 0 5px;
    border: 1px solid rgb(255 255 255 / 25%);
    border-radius: 4px;
    font-family: var(--mono);
    font-size: 11px;
  }
</style>
