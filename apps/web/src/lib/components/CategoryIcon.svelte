<script lang="ts">
  import { Cog, MessageSquareText, TriangleAlert } from '@lucide/svelte';
  import type { AnnotationCategory } from '$lib/types';

  let { category, size = 14 }: { category: AnnotationCategory; size?: number } = $props();
</script>

{#if category === 'equipment'}<Cog {size} />
{:else if category === 'issue'}<TriangleAlert {size} />
{:else}<MessageSquareText {size} />{/if}
