<script lang="ts">
  import { CircleCheck, CircleAlert, Info } from '@lucide/svelte';
  import { useWorkspace } from '$lib/state/workspace.svelte';

  const ws = useWorkspace();
</script>

<div class="toasts" aria-live="polite">
  {#each ws.toasts as toast (toast.id)}
    <div class="toast {toast.tone}">
      {#if toast.tone === 'success'}<CircleCheck size={16} />
      {:else if toast.tone === 'error'}<CircleAlert size={16} />
      {:else}<Info size={16} />{/if}
      {toast.message}
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    bottom: 64px;
    left: 50%;
    z-index: 200;
    display: grid;
    gap: 8px;
    justify-items: center;
    translate: -50% 0;
    pointer-events: none;
  }
  .toast {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 9px 14px;
    border-radius: var(--radius);
    background: #1d252c;
    color: #f1f5f7;
    box-shadow: var(--shadow-lg);
    animation: rise 0.18s ease-out;
  }
  .toast.success :global(svg) {
    color: #5eead4;
  }
  .toast.error :global(svg) {
    color: #fca5a5;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
</style>
