<script lang="ts">
  import { Building2, Factory, Layers2, SquareDashed, Trees } from '@lucide/svelte';
  import type { SpaceKind } from '$lib/types';

  let { kind, size = 15 }: { kind: SpaceKind; size?: number } = $props();
</script>

{#if kind === 'site'}<Factory {size} />
{:else if kind === 'outdoor'}<Trees {size} />
{:else if kind === 'building'}<Building2 {size} />
{:else if kind === 'floor'}<Layers2 {size} />
{:else}<SquareDashed {size} />{/if}
