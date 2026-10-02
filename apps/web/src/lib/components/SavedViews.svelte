<script lang="ts">
  import { Plus, Trash2, Link, Eye } from '@lucide/svelte';
  import { useWorkspace } from '$lib/state/workspace.svelte';

  const ws = useWorkspace();
  let naming = $state(false);
  let name = $state('');

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    await ws.saveCurrentView(trimmed);
    naming = false;
    name = '';
  }

  function viewUrl(view: (typeof ws.savedViews)[number]) {
    const params = new URLSearchParams();
    params.set('cam', [...view.camera.position, ...view.camera.target].join(','));
    if (view.hiddenSpaceIds.length) params.set('hide', view.hiddenSpaceIds.join(','));
    if (view.floorFilter) params.set('floor', view.floorFilter);
    return `${location.origin}${location.pathname}?${params}`;
  }

  function date(iso: string) {
    return new Date(iso).toLocaleDateString('ja-JP');
  }
</script>

<div class="views">
  {#if naming}
    <form
      class="new"
      onsubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <!-- svelte-ignore a11y_autofocus -->
      <input class="input" bind:value={name} placeholder="ビューの名前" autofocus />
      <div class="row">
        <button type="button" class="btn sm ghost" onclick={() => (naming = false)}>取消</button>
        <button class="btn sm primary" disabled={!name.trim()}>保存</button>
      </div>
    </form>
  {:else}
    <button class="btn block" onclick={() => (naming = true)}>
      <Plus size={15} /> 現在のビューを保存
    </button>
  {/if}

  {#each ws.savedViews as view (view.id)}
    <article class="card">
      <button class="open" onclick={() => ws.applyView(view)} title="このビューを開く">
        <div class="thumb">
          {#if view.thumbnail}
            <img src={view.thumbnail} alt="" />
          {:else}
            <Eye size={20} />
          {/if}
        </div>
        <div class="meta">
          <strong>{view.name}</strong>
          <span>{view.createdBy.name} · {date(view.createdAt)}</span>
        </div>
      </button>
      <div class="tools">
        <button
          class="icon-btn"
          title="リンクをコピー"
          aria-label="リンクをコピー"
          onclick={() => ws.copy(viewUrl(view), 'ビューのリンクをコピーしました')}
        >
          <Link size={14} />
        </button>
        <button
          class="icon-btn"
          title="削除"
          aria-label="削除"
          onclick={() => ws.deleteView(view.id)}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </article>
  {:else}
    <p class="empty">よく見る場所の視点を保存しておくと、ワンクリックで戻れます。</p>
  {/each}
</div>

<style>
  .views {
    display: grid;
    gap: 10px;
    padding: 12px;
  }
  .new {
    display: grid;
    gap: 8px;
  }
  .row {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
  .card {
    position: relative;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--panel);
  }
  .card:hover {
    border-color: var(--accent-line);
    box-shadow: var(--shadow);
  }
  .open {
    display: block;
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
    text-align: left;
  }
  .thumb {
    display: grid;
    place-items: center;
    aspect-ratio: 16 / 8;
    background: linear-gradient(160deg, #26313a, #12171c);
    color: #5c6b75;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .meta {
    display: grid;
    padding: 8px 10px;
  }
  .meta span {
    color: var(--muted);
    font-size: 12px;
  }
  .tools {
    position: absolute;
    top: 6px;
    right: 6px;
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius-sm);
    background: rgb(255 255 255 / 92%);
    opacity: 0;
    transition: opacity 0.12s;
  }
  .card:hover .tools,
  .card:focus-within .tools {
    opacity: 1;
  }
  .empty {
    margin: 4px 2px;
    color: var(--muted);
  }
</style>
