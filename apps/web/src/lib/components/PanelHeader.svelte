<script lang="ts">
  import { X } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import { useWorkspace } from '$lib/state/workspace.svelte';

  let { label, actions }: { label: string; actions?: Snippet } = $props();
  const ws = useWorkspace();
</script>

<div class="head">
  <span>{label}</span>
  <div class="actions">
    {@render actions?.()}
    <button
      class="icon-btn"
      aria-label="閉じる"
      title="閉じる  Esc"
      onclick={() => ws.clearSelection()}
    >
      <X size={17} />
    </button>
  </div>
</div>

<style>
  .head {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    height: 44px;
    padding: 0 8px 0 16px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 500;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }
</style>
