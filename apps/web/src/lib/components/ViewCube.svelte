<script lang="ts">
  import { Matrix4 } from 'three';
  import { useWorkspace } from '$lib/state/workspace.svelte';
  import type { ViewDirection } from '$lib/viewer/viewer';

  const ws = useWorkspace();
  const SIZE = 46;
  let cube = $state<HTMLDivElement>();
  let needle = $state<HTMLDivElement>();

  type V = [number, number, number];
  /** Face normal, text right and text up, in the site frame (Z up, -Y is the front). */
  const faces: { label: string; view: ViewDirection | null; n: V; r: V; u: V }[] = [
    { label: '上', view: 'top', n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] },
    { label: '下', view: null, n: [0, 0, -1], r: [1, 0, 0], u: [0, -1, 0] },
    { label: '前', view: 'front', n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1] },
    { label: '後', view: 'back', n: [0, 1, 0], r: [-1, 0, 0], u: [0, 0, 1] },
    { label: '右', view: 'right', n: [1, 0, 0], r: [0, 1, 0], u: [0, 0, 1] },
    { label: '左', view: 'left', n: [-1, 0, 0], r: [0, -1, 0], u: [0, 0, 1] },
  ];

  /** Maps the face's CSS box (x right, y down) onto its side of the cube. */
  function faceTransform(f: (typeof faces)[number]): string {
    const h = SIZE / 2;
    const down = f.u.map((v) => -v);
    const cols = [...f.r, 0, ...down, 0, ...f.n, 0, ...f.n.map((v) => v * h), 1];
    return `matrix3d(${cols.join(',')})`;
  }

  const view = new Matrix4();

  $effect(() => {
    return ws.viewer?.onFrame(({ camera, heading }) => {
      if (!cube) return;
      // World to camera rotation, with Y flipped because CSS Y points down.
      view.extractRotation(camera.matrixWorldInverse);
      const e = view.elements;
      const m = [e[0], -e[1], e[2], 0, e[4], -e[5], e[6], 0, e[8], -e[9], e[10], 0, 0, 0, 0, 1];
      cube.style.transform = `matrix3d(${m.map((v) => v.toFixed(6)).join(',')})`;
      if (needle) needle.style.transform = `rotate(${-heading}deg)`;
    });
  });
</script>

<div class="cube-wrap" aria-label="視点の切り替え">
  <div class="compass">
    <div class="needle" bind:this={needle}><span>N</span></div>
  </div>
  <div class="scene">
    <div class="cube" bind:this={cube} style:--s={`${SIZE}px`}>
      {#each faces as face (face.label)}
        <button
          class="face"
          style:transform={faceTransform(face)}
          disabled={!face.view}
          onclick={() => face.view && ws.viewer?.setView(face.view)}
          aria-label={`${face.label}から見る`}
        >
          {face.label}
        </button>
      {/each}
    </div>
  </div>
  <button class="iso" onclick={() => ws.viewer?.setView('iso')} title="斜め上から見る">
    斜め
  </button>
</div>

<style>
  .cube-wrap {
    position: absolute;
    top: 14px;
    right: 14px;
    z-index: 20;
    width: 100px;
    height: 110px;
  }
  .compass {
    position: absolute;
    top: 0;
    left: 0;
    width: 100px;
    height: 100px;
    border: 1px solid rgb(255 255 255 / 14%);
    border-radius: 50%;
    background: radial-gradient(circle, rgb(0 0 0 / 0%) 55%, rgb(0 0 0 / 22%) 56%);
  }
  .needle {
    position: absolute;
    inset: 0;
  }
  .needle span {
    position: absolute;
    top: -1px;
    left: 50%;
    translate: -50% 0;
    color: #fca5a5;
    font-size: 10px;
    font-weight: 700;
  }
  .scene {
    position: absolute;
    top: 50px;
    left: 50px;
    width: 0;
    height: 0;
  }
  .cube {
    position: absolute;
    transform-style: preserve-3d;
  }
  .face {
    position: absolute;
    top: calc(var(--s) / -2);
    left: calc(var(--s) / -2);
    display: grid;
    place-items: center;
    width: var(--s);
    height: var(--s);
    padding: 0;
    border: 1px solid #b8c0c5;
    background: linear-gradient(145deg, #ffffff, #e4e9ec);
    color: #3d474f;
    font-size: 13px;
    font-weight: 600;
    transform-origin: 50% 50%;
    backface-visibility: hidden;
  }
  .face:hover:not(:disabled) {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .face:disabled {
    cursor: default;
  }
  .iso {
    position: absolute;
    right: -4px;
    bottom: -4px;
    padding: 1px 6px;
    border: 1px solid rgb(255 255 255 / 18%);
    border-radius: 4px;
    background: rgb(22 28 34 / 70%);
    color: #c9d3d9;
    font-size: 10px;
  }
  .iso:hover {
    color: #fff;
  }
</style>
