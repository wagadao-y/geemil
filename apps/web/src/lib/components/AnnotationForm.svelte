<script lang="ts">
  import { MapPin, Crosshair } from '@lucide/svelte';
  import type { Annotation, AnnotationCategory } from '$lib/types';
  import { categoryLabels, useWorkspace } from '$lib/state/workspace.svelte';
  import PanelHeader from './PanelHeader.svelte';
  import CategoryIcon from './CategoryIcon.svelte';

  let {
    annotation = $bindable(),
    mode,
    onsave,
    oncancel,
  }: {
    annotation: Annotation;
    mode: 'create' | 'edit';
    onsave?: () => void | Promise<void>;
    oncancel?: () => void;
  } = $props();

  const ws = useWorkspace();
  let saving = $state(false);
  const categories: AnnotationCategory[] = ['equipment', 'note', 'issue'];

  const nodeOptions = $derived(
    ws.bundle.nodes
      .filter((n) => n.parentId)
      .map((n) => ({ id: n.id, label: ws.pathLabel(n.id), depth: ws.path(n.id).length - 2 }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ja')),
  );

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!annotation.title.trim() || saving) return;
    saving = true;
    try {
      annotation.title = annotation.title.trim();
      annotation.code = annotation.code?.trim() || undefined;
      if (mode === 'create') await ws.saveDraft();
      else await onsave?.();
    } finally {
      saving = false;
    }
  }

  function cancel() {
    if (mode === 'create') ws.clearSelection();
    else oncancel?.();
  }
</script>

<form class="panel" onsubmit={submit}>
  <PanelHeader label={mode === 'create' ? '新しい注記' : '注記を編集'} />

  <div class="body scroll">
    <div class="field">
      <span>種類</span>
      <div class="segmented" role="radiogroup">
        {#each categories as c (c)}
          <label class="seg {c}" class:active={annotation.category === c}>
            <input type="radio" name="category" value={c} bind:group={annotation.category} />
            <CategoryIcon category={c} size={14} />
            {categoryLabels[c]}
          </label>
        {/each}
      </div>
    </div>

    <label class="field">
      <span>タイトル <em>必須</em></span>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="input"
        bind:value={annotation.title}
        placeholder={annotation.category === 'equipment'
          ? '例：冷却水ポンプ C'
          : '例：床面のひび割れ'}
        autofocus
        required
      />
    </label>

    <label class="field">
      <span>ID・設備番号</span>
      <input
        class="input mono"
        value={annotation.code ?? ''}
        oninput={(e) => (annotation.code = e.currentTarget.value)}
        placeholder="例：P-102A（連携先のシステムと同じ番号）"
      />
    </label>

    <label class="field">
      <span>説明</span>
      <textarea
        class="input"
        rows="3"
        bind:value={annotation.description}
        placeholder="現地で気づいたこと、関係者に伝えたいことなど"></textarea>
    </label>

    <div class="field">
      <span>位置</span>
      <div class="where">
        <MapPin size={14} />
        <select class="input" bind:value={annotation.nodeId} aria-label="所属する場所">
          {#each nodeOptions as o (o.id)}
            <option value={o.id}>{o.label}</option>
          {/each}
        </select>
      </div>
      <div class="coords mono">
        X {annotation.position[0].toFixed(2)} · Y {annotation.position[1].toFixed(2)} · Z {annotation.position[2].toFixed(
          2,
        )}
      </div>
      {#if mode === 'create'}
        <button type="button" class="btn sm ghost repick" onclick={() => (ws.tool = 'annotate')}>
          <Crosshair size={14} /> 3D 上で位置を指定し直す
        </button>
      {/if}
    </div>

    {#if mode === 'create'}
      <p class="note">保存すると、関連リンク・添付ファイル・コメントを追加できます。</p>
    {/if}
  </div>

  <div class="foot">
    <button type="button" class="btn" onclick={cancel}>キャンセル</button>
    <button class="btn primary" disabled={!annotation.title.trim() || saving}>
      {mode === 'create' ? '注記を追加' : '保存'}
    </button>
  </div>
</form>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .body {
    display: grid;
    flex: 1;
    align-content: start;
    gap: 16px;
    min-height: 0;
    padding: 4px 16px 16px;
  }
  em {
    margin-left: 4px;
    color: var(--danger);
    font-size: 10px;
    font-style: normal;
  }
  .segmented {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }
  .seg {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 34px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    color: var(--muted);
    font-weight: 500;
    cursor: pointer;
  }
  .seg input {
    position: absolute;
    opacity: 0;
  }
  .seg:has(input:focus-visible) {
    outline: 2px solid var(--accent-bright);
  }
  .seg.active.equipment {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
  }
  .seg.active.note {
    border-color: var(--info);
    background: var(--info-soft);
    color: var(--info);
  }
  .seg.active.issue {
    border-color: var(--warn);
    background: var(--warn-soft);
    color: var(--warn);
  }
  .where {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
  }
  .coords {
    margin-left: 22px;
    color: var(--faint);
    font-size: 11px;
  }
  .repick {
    justify-self: start;
    margin-left: 14px;
    color: var(--accent);
  }
  .note {
    margin: 0;
    padding: 10px 12px;
    border-radius: var(--radius);
    background: var(--panel-2);
    color: var(--muted);
    font-size: 12px;
  }
  .foot {
    display: grid;
    flex: none;
    grid-template-columns: 1fr 2fr;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--line);
  }
</style>
