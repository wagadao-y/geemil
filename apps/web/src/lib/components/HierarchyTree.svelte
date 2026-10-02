<script lang="ts">
  import { useWorkspace } from '$lib/state/workspace.svelte';
  import TreeItem from './TreeItem.svelte';

  const ws = useWorkspace();
</script>

<div class="tree" role="tree" aria-label="施設構成">
  <TreeItem space={ws.root} depth={0} />
</div>

<style>
  .tree {
    padding: 6px 6px 12px;
  }
</style>
