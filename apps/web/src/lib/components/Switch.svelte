<script lang="ts">
  let {
    checked = $bindable(false),
    label,
    swatch,
  }: { checked?: boolean; label: string; swatch?: 'mesh' | 'cloud' | 'pano' | 'note' } = $props();
</script>

<label class="switch">
  <input type="checkbox" role="switch" bind:checked />
  <span class="track"><span class="thumb"></span></span>
  <span class="label">{label}</span>
  {#if swatch}<span class="swatch {swatch}"></span>{/if}
</label>

<style>
  .switch {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    user-select: none;
  }
  input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .track {
    position: relative;
    flex: none;
    width: 34px;
    height: 20px;
    border-radius: 10px;
    background: var(--line-strong);
    transition: background 0.15s;
  }
  .thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 2px rgb(0 0 0 / 25%);
    transition: transform 0.15s;
  }
  input:checked + .track {
    background: var(--accent);
  }
  input:checked + .track .thumb {
    transform: translateX(14px);
  }
  input:focus-visible + .track {
    outline: 2px solid var(--accent-bright);
    outline-offset: 2px;
  }
  .label {
    flex: 1;
    font-weight: 500;
  }
  .swatch {
    width: 12px;
    height: 12px;
    border-radius: 3px;
  }
  .swatch.mesh {
    background: linear-gradient(135deg, #cfd2cf, #8b908d);
  }
  .swatch.cloud {
    border-radius: 50%;
    background: radial-gradient(circle, #8fb3d9 30%, #4a6f96 70%);
  }
  .swatch.pano {
    border: 2px solid #fff;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 1px var(--line-strong);
  }
  .swatch.note {
    border-radius: 50% 50% 50% 0;
    background: var(--warn);
    transform: rotate(-45deg);
  }
</style>
