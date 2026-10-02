<script lang="ts">
  import { ChevronDown, Map as MapIcon } from '@lucide/svelte';
  import { demoBuildings } from '$lib/api/demo-data';
  import { useWorkspace } from '$lib/state/workspace.svelte';
  import type { Box } from '$lib/types';

  const ws = useWorkspace();
  let open = $state(true);
  let marker = $state<SVGGElement>();
  let svg = $state<SVGSVGElement>();

  /** Map extent: the whole site, or the focused building with a margin. */
  const extent = $derived.by((): Box => {
    const building = ws.focusedBuilding;
    const b = building ? building.bounds : ws.root.bounds;
    const pad = building ? 10 : 0;
    return {
      min: [b.min[0] - pad, b.min[1] - pad, 0],
      max: [b.max[0] + pad, b.max[1] + pad, 0],
    };
  });
  const width = $derived(extent.max[0] - extent.min[0]);
  const height = $derived(extent.max[1] - extent.min[1]);
  // SVG y grows down; north (+Y) is up, so y is negated.
  const viewBox = $derived(`${extent.min[0]} ${-extent.max[1]} ${width} ${height}`);
  const unit = $derived(width / 220);

  const floorLabel = $derived(
    ws.floorFilter ? ws.spacesById.get(ws.floorFilter)?.name : ws.focusedBuilding ? '全階' : null,
  );
  const areas = $derived(
    ws.focusedBuilding
      ? ws
          .descendants(ws.focusedBuilding.id)
          .filter((n) => n.kind === 'area' && ws.isSpaceShown(n.id))
      : [],
  );
  const panos = $derived(
    ws.layers.panorama ? ws.bundle.panoramas.filter((p) => ws.isSpaceShown(p.spaceId)) : [],
  );

  $effect(() => {
    return ws.viewer?.onFrame(({ camera, heading }) => {
      // Clamp to the map so the camera stays visible when it is outside the extent.
      const x = Math.min(Math.max(camera.position.x, extent.min[0]), extent.max[0]);
      const y = Math.min(Math.max(camera.position.y, extent.min[1]), extent.max[1]);
      marker?.setAttribute('transform', `translate(${x} ${-y}) rotate(${heading}) scale(${unit})`);
    });
  });

  function onClick(event: MouseEvent) {
    if (!svg) return;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const p = point.matrixTransform(svg.getScreenCTM()!.inverse());
    ws.viewer?.panTo(p.x, -p.y);
  }
</script>

<div class="minimap" class:closed={!open}>
  <button class="head" onclick={() => (open = !open)} aria-expanded={open}>
    <MapIcon size={13} />
    {ws.focusedBuilding?.name ?? '敷地図'}
    {#if floorLabel}<span class="floor">{floorLabel}</span>{/if}
    <span class="chev"><ChevronDown size={14} /></span>
  </button>
  {#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <svg bind:this={svg} {viewBox} onclick={onClick} preserveAspectRatio="xMidYMid meet">
      <rect
        x={-112}
        y={-82}
        width={224}
        height={164}
        rx={4}
        fill="#3a4044"
        stroke="#59605f"
        stroke-width={unit}
      />
      <g fill="#262b2f">
        <rect x={-98} y={-68} width={196} height={8} />
        <rect x={-98} y={60} width={196} height={8} />
        <rect x={-100} y={-68} width={8} height={136} />
        <rect x={92} y={-68} width={8} height={136} />
        <rect x={-90} y={12} width={180} height={7} />
      </g>
      <g fill="#cdd2d0" opacity=".9">
        <circle cx={-76} cy={-40} r={8} />
        <circle cx={-56} cy={-48} r={8} />
      </g>
      {#each demoBuildings as b (b.spaceId)}
        {@const hidden = !ws.isSpaceShown(b.spaceId)}
        {@const focused = ws.focusedBuilding?.id === b.spaceId}
        <rect
          x={b.min[0]}
          y={-b.max[1]}
          width={b.max[0] - b.min[0]}
          height={b.max[1] - b.min[1]}
          fill={focused ? '#55606a' : '#9aa3a6'}
          stroke={focused ? '#5eead4' : '#cfd5d6'}
          stroke-width={unit * (focused ? 1.2 : 0.6)}
          opacity={hidden ? 0.3 : 1}
        />
      {/each}
      {#each areas as a (a.id)}
        <rect
          x={a.bounds.min[0]}
          y={-a.bounds.max[1]}
          width={a.bounds.max[0] - a.bounds.min[0]}
          height={a.bounds.max[1] - a.bounds.min[1]}
          fill="rgb(94 234 212 / 12%)"
          stroke="#5eead4"
          stroke-dasharray={`${unit * 2} ${unit * 1.5}`}
          stroke-width={unit * 0.6}
        />
      {/each}
      {#each panos as p (p.id)}
        <circle
          cx={p.position[0]}
          cy={-p.position[1]}
          r={unit * 1.6}
          fill="#0f766e"
          stroke="#fff"
          stroke-width={unit * 0.6}
        />
      {/each}
      <g bind:this={marker} pointer-events="none">
        <path d="M0 0 L-9 -18 A20 20 0 0 1 9 -18 Z" fill="rgb(45 212 191 / 45%)" />
        <circle r="3.4" fill="#fff" />
        <circle r="2.2" fill="#0f766e" />
      </g>
    </svg>
  {/if}
</div>

<style>
  .minimap {
    position: absolute;
    bottom: 52px;
    left: 12px;
    z-index: 20;
    width: 248px;
    overflow: hidden;
    border: 1px solid rgb(255 255 255 / 14%);
    border-radius: var(--radius);
    background: rgb(18 23 28 / 88%);
    box-shadow: var(--shadow-lg);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 30px;
    padding: 0 8px 0 10px;
    border: 0;
    background: none;
    color: #c9d3d9;
    font-size: 12px;
    font-weight: 500;
  }
  .floor {
    padding: 0 6px;
    border: 1px solid rgb(255 255 255 / 25%);
    border-radius: 4px;
    font-size: 11px;
  }
  .chev {
    display: grid;
    margin-left: auto;
    transition: transform 0.15s;
  }
  .closed .chev {
    transform: rotate(180deg);
  }
  svg {
    display: block;
    width: 100%;
    height: 170px;
    cursor: pointer;
    background: #0e1a24;
  }
</style>
