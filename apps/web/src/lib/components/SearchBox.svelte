<script lang="ts">
  import { Search, MapPin, Camera, Box } from '@lucide/svelte';
  import { useWorkspace } from '$lib/state/workspace.svelte';
  import CategoryIcon from './CategoryIcon.svelte';

  const ws = useWorkspace();
  let query = $state('');
  let open = $state(false);
  let active = $state(0);
  let input = $state<HTMLInputElement>();

  interface Result {
    key: string;
    group: string;
    title: string;
    code?: string;
    sub: string;
    kind: 'annotation' | 'node' | 'panorama';
    category?: 'equipment' | 'note' | 'issue';
    run: () => void;
  }

  function norm(s: string) {
    return s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  }

  const results = $derived.by((): Result[] => {
    const q = norm(query);
    if (!q) return [];
    const hit = (...texts: (string | undefined)[]) => texts.some((t) => t && norm(t).includes(q));
    const annotations = ws.annotations
      .filter((a) => hit(a.title, a.code, ws.pathLabel(a.nodeId)))
      .slice(0, 8)
      .map((a): Result => ({
        key: a.id,
        group: '注記・設備',
        title: a.title,
        code: a.code,
        sub: ws.pathLabel(a.nodeId),
        kind: 'annotation',
        category: a.category,
        run: () => ws.selectAnnotation(a.id, { fly: true }),
      }));
    const nodes = ws.bundle.nodes
      .filter((n) => n.parentId && hit(n.name, ws.pathLabel(n.id)))
      .slice(0, 6)
      .map((n): Result => ({
        key: n.id,
        group: '場所',
        title: n.name,
        sub: ws.pathLabel(n.id),
        kind: 'node',
        run: () => ws.focusNode(n.id),
      }));
    const panos = ws.bundle.panoramas
      .filter((p) => hit(p.name, ws.pathLabel(p.nodeId)))
      .slice(0, 5)
      .map((p): Result => ({
        key: p.id,
        group: '360°写真',
        title: p.name,
        sub: `${ws.pathLabel(p.nodeId)} · ${p.capturedAt}`,
        kind: 'panorama',
        run: () => void ws.openPanorama(p),
      }));
    return [...annotations, ...nodes, ...panos];
  });

  $effect(() => {
    void query;
    active = 0;
  });

  function choose(result: Result) {
    result.run();
    open = false;
    query = '';
    input?.blur();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = Math.min(active + 1, results.length - 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = Math.max(active - 1, 0);
    } else if (event.key === 'Enter' && results[active]) {
      choose(results[active]);
    }
  }

  function onWindowKeydown(event: KeyboardEvent) {
    const typing = (event.target as HTMLElement).closest('input, textarea');
    if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing)) {
      event.preventDefault();
      input?.focus();
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="search" class:open={open && query}>
  <Search size={16} />
  <input
    bind:this={input}
    bind:value={query}
    onfocus={() => (open = true)}
    onblur={() => setTimeout(() => (open = false), 150)}
    onkeydown={onKeydown}
    placeholder="設備名・ID・場所を検索"
    aria-label="検索"
  />
  <kbd>Ctrl K</kbd>

  {#if open && query}
    <div class="results">
      {#if results.length === 0}
        <div class="empty">「{query}」に一致するものはありません</div>
      {/if}
      {#each results as result, i (result.kind + result.key)}
        {#if i === 0 || results[i - 1].group !== result.group}
          <div class="group">{result.group}</div>
        {/if}
        <button
          class="result"
          class:active={i === active}
          onmousemove={() => (active = i)}
          onclick={() => choose(result)}
        >
          <span class="icon {result.kind}">
            {#if result.kind === 'annotation' && result.category}
              <CategoryIcon category={result.category} size={14} />
            {:else if result.kind === 'panorama'}<Camera size={14} />
            {:else}<Box size={14} />{/if}
          </span>
          <span class="text">
            <span class="title">
              {#if result.code}<span class="mono code">{result.code}</span>{/if}
              {result.title}
            </span>
            <span class="sub"><MapPin size={11} /> {result.sub || '敷地'}</span>
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .search {
    position: relative;
    display: flex;
    flex: 1;
    align-items: center;
    gap: 8px;
    max-width: 620px;
    height: 36px;
    padding: 0 10px 0 12px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--panel-2);
    color: var(--muted);
  }
  .search:focus-within {
    border-color: var(--accent);
    background: var(--panel);
    box-shadow: 0 0 0 3px rgb(15 118 110 / 12%);
  }
  input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    outline: none;
    color: var(--text);
  }
  input::placeholder {
    color: var(--faint);
  }
  kbd {
    padding: 1px 6px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--panel);
    color: var(--faint);
    font-family: var(--mono);
    font-size: 10px;
  }
  .results {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    left: 0;
    z-index: 100;
    max-height: 60vh;
    overflow: auto;
    padding: 6px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--panel);
    box-shadow: var(--shadow-lg);
  }
  .group {
    padding: 8px 10px 4px;
    color: var(--faint);
    font-size: 11px;
    font-weight: 600;
  }
  .empty {
    padding: 14px 10px;
    color: var(--muted);
  }
  .result {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    text-align: left;
  }
  .result.active {
    background: var(--accent-soft);
  }
  .icon {
    display: grid;
    flex: none;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 6px;
    background: var(--panel-2);
    border: 1px solid var(--line);
    color: var(--muted);
  }
  .text {
    display: grid;
    min-width: 0;
  }
  .title {
    color: var(--text);
    font-weight: 500;
  }
  .code {
    margin-right: 6px;
    color: var(--accent);
    font-size: 12px;
  }
  .sub {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    overflow: hidden;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
</style>
