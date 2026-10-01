<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    open = $bindable(false),
    align = 'left',
    children,
  }: { open?: boolean; align?: 'left' | 'right'; children: Snippet } = $props();

  let el = $state<HTMLDivElement>();

  function onPointerDown(event: PointerEvent) {
    if (!open || !el) return;
    // The trigger sits next to the popover in the same parent, so it toggles by itself.
    if (!el.parentElement?.contains(event.target as Node)) open = false;
  }
</script>

<svelte:window
  onpointerdown={onPointerDown}
  onkeydown={(e) => e.key === 'Escape' && (open = false)}
/>

{#if open}
  <div class="popover" class:right={align === 'right'} bind:this={el}>
    {@render children()}
  </div>
{/if}

<style>
  .popover {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 100;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--panel);
    box-shadow: var(--shadow-lg);
    animation: pop 0.12s ease-out;
  }
  .popover.right {
    left: auto;
    right: 0;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
</style>
