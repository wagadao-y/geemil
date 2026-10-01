<script lang="ts">
  import { useWorkspace } from '$lib/state/workspace.svelte';
  import AnnotationDetail from './AnnotationDetail.svelte';
  import AnnotationForm from './AnnotationForm.svelte';
  import NodeDetail from './NodeDetail.svelte';

  const ws = useWorkspace();
  const node = $derived(
    ws.selection?.type === 'node' ? ws.nodesById.get(ws.selection.id) : undefined,
  );
</script>

<div class="inspector">
  {#if ws.selection?.type === 'draft' && ws.draft}
    <AnnotationForm bind:annotation={ws.draft} mode="create" />
  {:else if ws.selectedAnnotation}
    {#key ws.selectedAnnotation.id}
      <AnnotationDetail annotation={ws.selectedAnnotation} />
    {/key}
  {:else if node}
    {#key node.id}
      <NodeDetail {node} />
    {/key}
  {/if}
</div>

<style>
  .inspector {
    height: 100%;
    animation: slide 0.16s ease-out;
  }
  @keyframes slide {
    from {
      opacity: 0;
      transform: translateX(8px);
    }
  }
</style>
