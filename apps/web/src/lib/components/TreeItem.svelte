<script lang="ts">
  import { ChevronRight, Eye, EyeOff } from '@lucide/svelte';
  import type { Space } from '$lib/types';
  import { useWorkspace } from '$lib/state/workspace.svelte';
  import SpaceIcon from './SpaceIcon.svelte';
  import CategoryIcon from './CategoryIcon.svelte';
  import TreeItem from './TreeItem.svelte';

  let { space, depth }: { space: Space; depth: number } = $props();
  const ws = useWorkspace();

  const children = $derived(ws.children.get(space.id) ?? []);
  const annotations = $derived(ws.annotations.filter((a) => a.spaceId === space.id));
  const expandable = $derived(children.length > 0 || annotations.length > 0);
  const expanded = $derived(ws.expanded.has(space.id));
  const selfHidden = $derived(ws.hiddenSpaces.has(space.id));
  const inheritedHidden = $derived(!selfHidden && ws.effectiveHidden.has(space.id));
  const cut = $derived(ws.isCutAway(space.id));
  const current = $derived(
    ws.focusSpaceId === space.id && (ws.selection?.type !== 'annotation' || !ws.selection),
  );
  const selected = $derived(ws.selection?.type === 'space' && ws.selection.id === space.id);
  const total = $derived(ws.annotationsUnder(space.id).length);

  function toggleExpand(event: MouseEvent) {
    event.stopPropagation();
    if (expanded) ws.expanded.delete(space.id);
    else ws.expanded.add(space.id);
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
  onclick={() => ws.focusSpace(space.id)}
  onkeydown={(e) => {
    if (e.key === 'Enter') ws.focusSpace(space.id);
    if (e.key === 'ArrowRight') ws.expanded.add(space.id);
    if (e.key === 'ArrowLeft') ws.expanded.delete(space.id);
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
  <span class="kind"><SpaceIcon kind={space.kind} /></span>
  <span class="name">{space.name}</span>
  {#if cut}<span class="tag">非表示階</span>{/if}
  {#if total > 0 && !expanded}<span class="badge">{total}</span>{/if}
  {#if space.parentId}
    <button
      class="eye"
      class:off={selfHidden}
      class:inherited={inheritedHidden}
      title={selfHidden ? '表示する' : '非表示にする'}
      aria-label={selfHidden ? `${space.name} を表示` : `${space.name} を非表示`}
      onclick={(e) => {
        e.stopPropagation();
        ws.toggleSpace(space.id);
      }}
    >
      {#if selfHidden || inheritedHidden}<EyeOff size={15} />{:else}<Eye size={15} />{/if}
    </button>
  {/if}
</div>

{#if expanded}
  <div role="group">
    {#each children as child (child.id)}
      <TreeItem space={child} depth={depth + 1} />
    {/each}
    {#each annotations as annotation (annotation.id)}
      {@const active = ws.selection?.type === 'annotation' && ws.selection.id === annotation.id}
      <div
        class="row leaf"
        class:selected={active}
        class:dim={ws.effectiveHidden.has(space.id) || cut}
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
