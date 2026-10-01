<script lang="ts">
  import { ChevronDown } from '@lucide/svelte';
  import { useWorkspace } from '$lib/state/workspace.svelte';
  import Switch from './Switch.svelte';

  const ws = useWorkspace();
  let open = $state(true);
</script>

<section class="layers">
  <button class="head" onclick={() => (open = !open)} aria-expanded={open}>
    表示レイヤー
    <span class="chev" class:closed={!open}><ChevronDown size={16} /></span>
  </button>
  {#if open}
    <div class="item">
      <Switch bind:checked={ws.layers.mesh} label="屋外メッシュ" swatch="mesh" />
      <div class="slider" class:disabled={!ws.layers.mesh}>
        <span>不透明度</span>
        <input
          type="range"
          min="0.1"
          max="1"
          step="0.05"
          bind:value={ws.meshOpacity}
          disabled={!ws.layers.mesh}
          style:--fill={`${((ws.meshOpacity - 0.1) / 0.9) * 100}%`}
          aria-label="屋外メッシュの不透明度"
        />
        <span class="value">{Math.round(ws.meshOpacity * 100)}%</span>
      </div>
    </div>
    <div class="item">
      <Switch bind:checked={ws.layers.pointcloud} label="屋内点群" swatch="cloud" />
    </div>
    <div class="item">
      <Switch bind:checked={ws.layers.panorama} label="360°写真" swatch="pano" />
    </div>
    <div class="item">
      <Switch bind:checked={ws.layers.annotation} label="注記" swatch="note" />
    </div>
  {/if}
</section>

<style>
  .layers {
    border-top: 1px solid var(--line);
    background: var(--panel);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    height: 44px;
    padding: 0 12px 0 16px;
    border: 0;
    background: none;
    font-size: 14px;
    font-weight: 600;
  }
  .chev {
    display: grid;
    color: var(--muted);
    transition: transform 0.15s;
  }
  .chev.closed {
    transform: rotate(-90deg);
  }
  .item {
    padding: 8px 16px;
    border-top: 1px solid var(--line);
  }
  .item:last-child {
    padding-bottom: 12px;
  }
  .slider {
    display: grid;
    grid-template-columns: auto 1fr 36px;
    align-items: center;
    gap: 10px;
    margin: 6px 0 2px 44px;
    color: var(--muted);
    font-size: 12px;
  }
  .slider.disabled {
    opacity: 0.45;
  }
  .value {
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  input[type='range'] {
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(to right, var(--accent) var(--fill), var(--line) var(--fill));
    appearance: none;
    outline: none;
  }
  input[type='range']::-webkit-slider-thumb {
    width: 14px;
    height: 14px;
    border: 2px solid #fff;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 1px 3px rgb(0 0 0 / 30%);
    appearance: none;
  }
  input[type='range']::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border: 2px solid #fff;
    border-radius: 50%;
    background: var(--accent);
  }
</style>
