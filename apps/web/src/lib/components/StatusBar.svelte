<script lang="ts">
  import { useWorkspace } from '$lib/state/workspace.svelte';

  const ws = useWorkspace();
  let scale = $state<HTMLDivElement>();
  let label = $state('');
  let ticks = $state<string[]>([]);

  /** Picks 1, 2 or 5 × 10ⁿ meters that fits about 160 px. */
  function niceLength(metersPerPixel: number): number {
    const raw = metersPerPixel * 160;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const n = raw / pow;
    return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * pow;
  }

  function fmt(m: number) {
    return m >= 1 ? `${+m.toFixed(1)}` : `${+m.toFixed(2)}`;
  }

  $effect(() => {
    return ws.viewer?.onFrame(({ metersPerPixel }) => {
      const length = niceLength(metersPerPixel);
      if (scale) scale.style.width = `${length / metersPerPixel}px`;
      const next = `${fmt(length)} m`;
      if (next !== label) {
        label = next;
        ticks = ['0', fmt(length / 2), next];
      }
    });
  });
</script>

<footer class="status">
  <div class="meta">
    <span>座標系：{ws.bundle.site.crs}（m）</span>
    <span class="dot">•</span>
    <span>撮影：{ws.bundle.site.capturedAt.replaceAll('-', '.')}</span>
  </div>

  <div class="legend">
    <span class:off={!ws.layers.mesh}><i class="mesh"></i>メッシュ（屋外）</span>
    <span class:off={!ws.layers.pointcloud}><i class="cloud"></i>点群（屋内）</span>
    <span class:off={!ws.layers.panorama}><i class="pano"></i>360°写真</span>
  </div>

  <div class="scale" bind:this={scale} aria-label={`縮尺 ${label}`}>
    <div class="ticks">
      {#each ticks as tick, i (i)}<span>{tick}</span>{/each}
    </div>
    <div class="bar"></div>
  </div>
</footer>

<style>
  .status {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 24px;
    height: 40px;
    padding: 0 20px;
    background: linear-gradient(to top, rgb(12 16 20 / 85%), rgb(12 16 20 / 0%));
    color: #b7c2c9;
    font-size: 12px;
    pointer-events: none;
  }
  .meta {
    display: flex;
    gap: 8px;
    white-space: nowrap;
  }
  .dot {
    opacity: 0.5;
  }
  .legend {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0 16px;
    min-width: 0;
    height: 18px;
    overflow: hidden;
    white-space: nowrap;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .legend .off {
    opacity: 0.35;
    text-decoration: line-through;
  }
  i {
    display: inline-block;
    width: 11px;
    height: 11px;
  }
  .mesh {
    border: 1px solid #9aa3a6;
    background: linear-gradient(135deg, #cfd2cf, #6b706d);
  }
  .cloud {
    border-radius: 50%;
    background: radial-gradient(circle, #a9c6e4 30%, #4a6f96 75%);
  }
  .pano {
    border: 2px solid #fff;
    border-radius: 50%;
    background: var(--accent);
  }
  .scale {
    display: grid;
    flex: none;
  }
  .ticks {
    display: flex;
    justify-content: space-between;
    width: 100%;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }
  .ticks span {
    width: 0;
    display: flex;
    justify-content: center;
    white-space: nowrap;
  }
  .ticks span:last-child {
    justify-content: flex-end;
  }
  .ticks span:first-child {
    justify-content: flex-start;
  }
  .bar {
    height: 6px;
    border: 1.5px solid #dfe6ea;
    border-top: 0;
    background: linear-gradient(#dfe6ea, #dfe6ea) center / 1.5px 100% no-repeat;
  }
</style>
