<script lang="ts">
  import { Calendar, Compass, ChevronLeft, ChevronRight, Info } from '@lucide/svelte';
  import type { Panorama } from '$lib/types';
  import { useWorkspace } from '$lib/state/workspace.svelte';

  let { pano }: { pano: Panorama } = $props();
  const ws = useWorkspace();
  let heading = $state(0);
  let needle = $state<HTMLSpanElement>();

  const strip = $derived(ws.panoramasNear(pano));
  const index = $derived(strip.findIndex((p) => p.id === pano.id));

  $effect(() => {
    return ws.viewer?.onFrame((info) => {
      heading = Math.round(info.heading);
      if (needle) needle.style.transform = `rotate(${info.heading}deg)`;
    });
  });

  function go(offset: number) {
    const next = strip[index + offset];
    if (next) void ws.openPanorama(next);
  }

  function direction(deg: number) {
    return ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round(deg / 45) % 8];
  }
</script>

<div class="bar glass">
  <button class="nav" disabled={index <= 0} onclick={() => go(-1)} aria-label="前の写真">
    <ChevronLeft size={18} />
  </button>
  <div class="strip">
    {#each strip as p (p.id)}
      <button class="thumb" class:active={p.id === pano.id} onclick={() => ws.openPanorama(p)}>
        <span class="img">
          <span class="ring"></span>
        </span>
        <span class="name mono">{p.name}</span>
      </button>
    {/each}
  </div>
  <button
    class="nav"
    disabled={index >= strip.length - 1}
    onclick={() => go(1)}
    aria-label="次の写真"
  >
    <ChevronRight size={18} />
  </button>

  <div class="stat">
    <span class="k">方位</span>
    <span class="v">
      {heading}°<small>{direction(heading)}</small>
      <span class="compass"
        ><span class="needle" bind:this={needle}></span><Compass size={22} /></span
      >
    </span>
  </div>
  <div class="stat">
    <span class="k">撮影日</span>
    <span class="v">{pano.capturedAt.replaceAll('-', '.')} <Calendar size={16} /></span>
  </div>
</div>

{#if !pano.imageUrl}
  <div class="demo-note glass">
    <Info size={13} /> デモデータには写真がないため、撮影位置からの 3D ビューを表示しています
  </div>
{/if}

<style>
  .bar {
    position: absolute;
    bottom: 14px;
    left: 50%;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: calc(100% - 140px);
    padding: 8px;
    border-radius: 12px;
    translate: -50% 0;
  }
  .strip {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .nav {
    display: grid;
    place-items: center;
    width: 28px;
    height: 72px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: #c9d3d9;
  }
  .nav:hover:not(:disabled) {
    background: rgb(255 255 255 / 8%);
  }
  .nav:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .thumb {
    display: grid;
    gap: 4px;
    padding: 3px;
    border: 2px solid transparent;
    border-radius: 8px;
    background: none;
    color: #c9d3d9;
  }
  .thumb.active {
    border-color: #2dd4bf;
    color: #fff;
  }
  .img {
    display: grid;
    place-items: center;
    width: 96px;
    height: 52px;
    border-radius: 5px;
    background:
      radial-gradient(ellipse at 50% 120%, #5a6670 0%, transparent 60%),
      linear-gradient(180deg, #3b4650, #1e252b);
  }
  .ring {
    width: 18px;
    height: 18px;
    border: 2px solid rgb(255 255 255 / 70%);
    border-radius: 50%;
  }
  .active .ring {
    border-color: #2dd4bf;
    background: rgb(45 212 191 / 30%);
  }
  .name {
    font-size: 11px;
  }
  .stat {
    display: grid;
    gap: 2px;
    min-width: 120px;
    height: 72px;
    padding: 8px 14px;
    border-left: 1px solid var(--glass-line);
  }
  .k {
    color: #9fb0bb;
    font-size: 11px;
  }
  .v {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 18px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  small {
    color: #9fb0bb;
    font-size: 11px;
  }
  .compass {
    position: relative;
    display: grid;
    margin-left: auto;
    color: #9fb0bb;
  }
  .needle {
    position: absolute;
    inset: 0;
  }
  .needle::before {
    content: '';
    position: absolute;
    top: 2px;
    left: 50%;
    width: 2px;
    height: 9px;
    background: #2dd4bf;
    translate: -50% 0;
  }
  .demo-note {
    position: absolute;
    top: 56px;
    left: 12px;
    z-index: 20;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: 6px;
    color: #c9d3d9;
    font-size: 11px;
  }
</style>
