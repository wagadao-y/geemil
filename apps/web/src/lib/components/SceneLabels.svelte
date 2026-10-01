<script lang="ts">
  import { Box, Camera, Plus } from '@lucide/svelte';
  import { useWorkspace } from '$lib/state/workspace.svelte';
  import { anchor } from '$lib/viewer/anchor';
  import { formatMeters } from '$lib/viewer/format';
  import type { Vec3 } from '$lib/types';
  import CategoryIcon from './CategoryIcon.svelte';

  const ws = useWorkspace();

  function center(min: Vec3, max: Vec3, z = max[2]): Vec3 {
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, z];
  }

  const buildings = $derived(
    ws.bundle.nodes.filter((n) => n.kind === 'building' && ws.isNodeShown(n.id)),
  );
  const areas = $derived(
    ws.bundle.nodes.filter(
      (n) => n.kind === 'area' && ws.isNodeShown(n.id) && ws.layers.pointcloud,
    ),
  );
  const pins = $derived(
    ws.layers.annotation ? ws.annotations.filter((a) => ws.isNodeShown(a.nodeId)) : [],
  );
  const panos = $derived(
    ws.layers.panorama || ws.panoramaId
      ? ws.bundle.panoramas.filter((p) => p.id !== ws.panoramaId && ws.isNodeShown(p.nodeId))
      : [],
  );
  const measure = $derived.by(() => {
    const [a, b] = ws.measurePoints;
    if (!a || !b) return null;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    return {
      mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] as Vec3,
      total: Math.hypot(dx, dy, dz),
      horizontal: Math.hypot(dx, dy),
      vertical: Math.abs(dz),
    };
  });

  function isSelected(id: string) {
    return ws.selection?.type === 'annotation' && ws.selection.id === id;
  }
</script>

<div class="labels">
  {#if !ws.panoramaId}
    {#each buildings as node (node.id)}
      <div
        class="anchor"
        {@attach anchor(
          ws.viewer,
          center(node.bounds.min, node.bounds.max, node.bounds.max[2] + 3),
          {
            minDistance: 90,
          },
        )}
      >
        <button class="place" onclick={() => ws.focusNode(node.id)}>
          <Box size={14} />
          {node.name}
        </button>
      </div>
    {/each}
    {#each areas as node (node.id)}
      <div
        class="anchor"
        {@attach anchor(
          ws.viewer,
          center(node.bounds.min, node.bounds.max, node.bounds.min[2] + 0.2),
          {
            minDistance: 6,
            maxDistance: 75,
          },
        )}
      >
        <button class="area" onclick={() => ws.focusNode(node.id)}>{node.name}</button>
      </div>
    {/each}
  {/if}

  {#each panos as pano (pano.id)}
    <div
      class="anchor"
      {@attach anchor(ws.viewer, [pano.position[0], pano.position[1], pano.position[2] - 1.2], {
        maxDistance: ws.panoramaId ? 30 : 90,
      })}
    >
      <button
        class="pano"
        class:in-pano={!!ws.panoramaId}
        title={`${pano.name} を開く`}
        aria-label={`360°写真 ${pano.name} を開く`}
        onclick={() => ws.openPanorama(pano)}
      >
        <Camera size={12} />
        <span class="pano-name">{pano.name}</span>
      </button>
    </div>
  {/each}

  {#each pins as a (a.id)}
    {@const selected = isSelected(a.id)}
    <div
      class="anchor"
      class:front={selected}
      {@attach anchor(ws.viewer, a.position, { maxDistance: selected ? Infinity : 160 })}
    >
      <button
        class="pin {a.category}"
        class:selected
        onclick={() => ws.selectAnnotation(a.id)}
        ondblclick={() => ws.selectAnnotation(a.id, { fly: true })}
        aria-label={a.title}
      >
        <span class="head"><CategoryIcon category={a.category} size={13} /></span>
        <span class="tag">
          {#if a.code}<span class="code mono">{a.code}</span>{/if}
          {a.title}
        </span>
      </button>
    </div>
  {/each}

  {#if ws.draft}
    <div class="anchor front" {@attach anchor(ws.viewer, ws.draft.position)}>
      <div class="pin draft selected">
        <span class="head"><Plus size={14} /></span>
        <span class="tag">{ws.draft.title || '新しい注記'}</span>
      </div>
    </div>
  {/if}

  {#each ws.measurePoints as point, i (i)}
    <div class="anchor" {@attach anchor(ws.viewer, point)}>
      <span class="measure-dot"></span>
    </div>
  {/each}
  {#if measure}
    <div class="anchor front" {@attach anchor(ws.viewer, measure.mid)}>
      <div class="measure">
        <strong>{formatMeters(measure.total)}</strong>
        <span
          >水平 {formatMeters(measure.horizontal)} · 高低差 {formatMeters(measure.vertical)}</span
        >
      </div>
    </div>
  {/if}
</div>

<style>
  .labels {
    position: absolute;
    inset: 0;
    z-index: 5;
    overflow: hidden;
    pointer-events: none;
  }
  .anchor {
    position: absolute;
    top: 0;
    left: 0;
    visibility: hidden;
    will-change: transform;
  }
  .anchor.front {
    z-index: 20000 !important;
  }
  .anchor > * {
    pointer-events: auto;
  }

  .place {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 11px;
    border: 1px solid rgb(0 0 0 / 8%);
    border-radius: var(--radius-sm);
    background: rgb(255 255 255 / 94%);
    box-shadow: var(--shadow);
    color: var(--text);
    font-weight: 600;
    white-space: nowrap;
    translate: -50% -50%;
  }
  .place:hover {
    color: var(--accent);
  }
  .place :global(svg) {
    color: var(--muted);
  }

  .area {
    padding: 2px 8px;
    border: 1px dashed rgb(255 255 255 / 45%);
    border-radius: 4px;
    background: rgb(15 20 25 / 55%);
    color: #dbe4ea;
    font-size: 11px;
    white-space: nowrap;
    translate: -50% -50%;
  }
  .area:hover {
    border-color: #5eead4;
    color: #fff;
  }

  .pano {
    display: inline-flex;
    align-items: center;
    gap: 0;
    height: 24px;
    min-width: 24px;
    padding: 0 5px;
    border: 2px solid #fff;
    border-radius: 999px;
    background: rgb(15 118 110 / 90%);
    box-shadow:
      0 0 0 3px rgb(15 118 110 / 30%),
      0 2px 6px rgb(0 0 0 / 40%);
    color: #fff;
    translate: -50% -50%;
    transition: gap 0.12s;
  }
  .pano-name {
    max-width: 0;
    overflow: hidden;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    transition: max-width 0.15s;
  }
  .pano:hover {
    gap: 5px;
    padding-right: 8px;
  }
  .pano:hover .pano-name {
    max-width: 80px;
  }
  .pano.in-pano {
    height: 34px;
    padding: 0 9px;
    gap: 6px;
  }
  .pano.in-pano .pano-name {
    max-width: 80px;
  }

  .pin {
    --c: var(--accent);
    position: relative;
    display: flex;
    align-items: center;
    padding: 0;
    border: 0;
    background: none;
    translate: -13px calc(-100% - 12px);
  }
  .pin.issue {
    --c: #d97706;
  }
  .pin.note {
    --c: #6366f1;
  }
  .pin.draft {
    --c: #f59e0b;
  }
  .pin::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 12px;
    width: 2px;
    height: 12px;
    background: var(--c);
  }
  .pin::before {
    content: '';
    position: absolute;
    top: calc(100% + 9px);
    left: 9px;
    width: 8px;
    height: 8px;
    border: 2px solid #fff;
    border-radius: 50%;
    background: var(--c);
  }
  .head {
    display: grid;
    place-items: center;
    flex: none;
    width: 26px;
    height: 26px;
    border: 2px solid #fff;
    border-radius: 50%;
    background: var(--c);
    box-shadow: 0 2px 6px rgb(0 0 0 / 35%);
    color: #fff;
  }
  .tag {
    max-width: 0;
    margin-left: -10px;
    padding: 0;
    overflow: hidden;
    border-radius: 0 6px 6px 0;
    background: var(--c);
    color: #fff;
    font-weight: 600;
    white-space: nowrap;
    line-height: 24px;
    transition:
      max-width 0.15s,
      padding 0.15s;
  }
  .pin:hover .tag,
  .pin.selected .tag {
    max-width: 260px;
    padding: 0 10px 0 14px;
  }
  .pin.selected .head {
    box-shadow:
      0 0 0 4px color-mix(in srgb, var(--c) 35%, transparent),
      0 2px 8px rgb(0 0 0 / 40%);
  }
  .code {
    margin-right: 4px;
    opacity: 0.85;
  }
  .pin.draft .head {
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      box-shadow: 0 0 0 8px rgb(245 158 11 / 0%);
    }
    0% {
      box-shadow: 0 0 0 0 rgb(245 158 11 / 60%);
    }
  }

  .measure-dot {
    display: block;
    width: 10px;
    height: 10px;
    border: 2px solid #1b1f23;
    border-radius: 50%;
    background: #fbbf24;
    translate: -50% -50%;
    pointer-events: none;
  }
  .measure {
    display: grid;
    justify-items: center;
    padding: 5px 10px;
    border-radius: var(--radius-sm);
    background: #fbbf24;
    color: #1b1f23;
    box-shadow: 0 2px 8px rgb(0 0 0 / 35%);
    white-space: nowrap;
    translate: -50% calc(-100% - 8px);
  }
  .measure strong {
    font-size: 15px;
    font-variant-numeric: tabular-nums;
  }
  .measure span {
    font-size: 11px;
  }
</style>
