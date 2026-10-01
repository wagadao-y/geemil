<script lang="ts">
  import { ChevronRight, Eye, EyeOff } from '@lucide/svelte';
  import type { SpaceNode } from '$lib/types';
  import { useWorkspace } from '$lib/state/workspace.svelte';
  import NodeIcon from './NodeIcon.svelte';
  import CategoryIcon from './CategoryIcon.svelte';
  import TreeItem from './TreeItem.svelte';

  let { node, depth }: { node: SpaceNode; depth: number } = $props();
  const ws = useWorkspace();

  const children = $derived(ws.children.get(node.id) ?? []);
  const annotations = $derived(ws.annotations.filter((a) => a.nodeId === node.id));
  const expandable = $derived(children.length > 0 || annotations.length > 0);
  const expanded = $derived(ws.expanded.has(node.id));
  const selfHidden = $derived(ws.hiddenNodes.has(node.id));
  const inheritedHidden = $derived(!selfHidden && ws.effectiveHidden.has(node.id));
  const cut = $derived(ws.isCutAway(node.id));
  const current = $derived(
    ws.focusNodeId === node.id && (ws.selection?.type !== 'annotation' || !ws.selection),
  );
  const selected = $derived(ws.selection?.type === 'node' && ws.selection.id === node.id);
  const total = $derived(ws.annotationsUnder(node.id).length);

  function toggleExpand(event: MouseEvent) {
    event.stopPropagation();
    if (expanded) ws.expanded.delete(node.id);
    else ws.expanded.add(node.id);
  }
</script>

<div
  class="row"
  class:current
  class:selected
  class:dim={selfHidden || inheritedHidden || cut}
  style:--depth={depth}
  role="treeitem"
  aria-selected={selected}
  aria-expanded={expandable ? expanded : undefined}
  tabindex="0"
  onclick={() => ws.focusNode(node.id)}
  onkeydown={(e) => {
    if (e.key === 'Enter') ws.focusNode(node.id);
    if (e.key === 'ArrowRight') ws.expanded.add(node.id);
    if (e.key === 'ArrowLeft') ws.expanded.delete(node.id);
  }}
>
  <button
    class="twisty"
    class:open={expanded}
    class:invisible={!expandable}
    tabindex="-1"
    aria-label={expanded ? '折りたたむ' : '展開する'}
    onclick={toggleExpand}
  >
    <ChevronRight size={14} />
  </button>
  <span class="kind"><NodeIcon kind={node.kind} /></span>
  <span class="name">{node.name}</span>
  {#if cut}<span class="tag">非表示階</span>{/if}
  {#if total > 0 && !expanded}<span class="badge">{total}</span>{/if}
  {#if node.parentId}
    <button
      class="eye"
      class:off={selfHidden}
      class:inherited={inheritedHidden}
      title={selfHidden ? '表示する' : '非表示にする'}
      aria-label={selfHidden ? `${node.name} を表示` : `${node.name} を非表示`}
      onclick={(e) => {
        e.stopPropagation();
        ws.toggleNode(node.id);
      }}
    >
      {#if selfHidden || inheritedHidden}<EyeOff size={15} />{:else}<Eye size={15} />{/if}
    </button>
  {/if}
</div>

{#if expanded}
  <div role="group">
    {#each children as child (child.id)}
      <TreeItem node={child} depth={depth + 1} />
    {/each}
    {#each annotations as annotation (annotation.id)}
      {@const active = ws.selection?.type === 'annotation' && ws.selection.id === annotation.id}
      <div
        class="row leaf"
        class:selected={active}
        class:dim={ws.effectiveHidden.has(node.id) || cut}
        style:--depth={depth + 1}
        role="treeitem"
        aria-selected={active}
        tabindex="0"
        onclick={() => ws.selectAnnotation(annotation.id, { fly: true })}
        onkeydown={(e) => e.key === 'Enter' && ws.selectAnnotation(annotation.id, { fly: true })}
      >
        <span class="twisty invisible"></span>
        <span class="kind cat {annotation.category}"
          ><CategoryIcon category={annotation.category} size={13} /></span
        >
        <span class="name">{annotation.title}</span>
        {#if annotation.code}<span class="code mono">{annotation.code}</span>{/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 32px;
    padding: 0 4px 0 calc(4px + var(--depth) * 16px);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-2);
    cursor: pointer;
    user-select: none;
  }
  .row:hover {
    background: var(--panel-2);
  }
  .row.current {
    color: var(--text);
    font-weight: 600;
  }
  .row.selected {
    border-color: var(--accent-line);
    background: var(--accent-soft);
    color: var(--accent);
  }
  .row.dim .name,
  .row.dim .kind {
    opacity: 0.45;
  }
  .twisty {
    display: grid;
    flex: none;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--faint);
  }
  .twisty:hover {
    background: rgb(0 0 0 / 6%);
    color: var(--text);
  }
  .twisty :global(svg) {
    transition: transform 0.12s;
  }
  .twisty.open :global(svg) {
    transform: rotate(90deg);
  }
  .invisible {
    visibility: hidden;
  }
  .kind {
    display: grid;
    flex: none;
    place-items: center;
    width: 20px;
    color: var(--muted);
  }
  .selected .kind {
    color: var(--accent);
  }
  .kind.cat.equipment {
    color: var(--accent);
  }
  .kind.cat.issue {
    color: var(--warn);
  }
  .kind.cat.note {
    color: var(--info);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .leaf .name {
    font-weight: 400;
  }
  .code {
    color: var(--faint);
    font-size: 11px;
  }
  .tag {
    padding: 0 5px;
    border-radius: 4px;
    background: var(--panel-2);
    border: 1px solid var(--line);
    color: var(--faint);
    font-size: 10px;
    font-weight: 400;
  }
  .badge {
    min-width: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: var(--panel-2);
    border: 1px solid var(--line);
    color: var(--muted);
    font-size: 11px;
    font-weight: 400;
    line-height: 16px;
    text-align: center;
  }
  .eye {
    display: grid;
    flex: none;
    place-items: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--muted);
    opacity: 0.85;
  }
  .eye:hover {
    background: rgb(0 0 0 / 6%);
    color: var(--text);
  }
  .eye.off {
    color: var(--faint);
  }
  .eye.inherited {
    color: var(--line-strong);
  }
</style>
