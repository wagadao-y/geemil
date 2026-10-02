<script lang="ts">
  import { useWorkspace } from '$lib/state/workspace.svelte';
  import AnnotationDetail from './AnnotationDetail.svelte';
  import AnnotationForm from './AnnotationForm.svelte';
  import SpaceDetail from './SpaceDetail.svelte';

  const ws = useWorkspace();
  const space = $derived(
    ws.selection?.type === 'space' ? ws.spacesById.get(ws.selection.id) : undefined,
  );
</script>

<div class="inspector">
  {#if ws.selection?.type === 'draft' && ws.draft}
    <AnnotationForm bind:annotation={ws.draft} mode="create" />
  {:else if ws.selectedAnnotation}
    {#key ws.selectedAnnotation.id}
      <AnnotationDetail annotation={ws.selectedAnnotation} />
    {/key}
  {:else if space}
    {#key space.id}
      <SpaceDetail {space} />
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
