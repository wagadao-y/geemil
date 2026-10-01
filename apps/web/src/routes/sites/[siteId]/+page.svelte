<script lang="ts">
  import { page } from '$app/state';
  import { api } from '$lib/api/client';
  import WorkspaceView from '$lib/components/WorkspaceView.svelte';

  const siteId = $derived(page.params.siteId ?? '');
  const bundle = $derived(api().getSite(siteId));
</script>

{#await bundle}
  <div class="state">
    <div class="spinner"></div>
    <p>施設を読み込んでいます…</p>
  </div>
{:then bundle}
  {#if bundle}
    {#key bundle.site.id}
      <WorkspaceView {bundle} />
    {/key}
  {:else}
    <div class="state">
      <h1>この施設には 3D データがまだありません</h1>
      <p>メッシュ・点群・360°写真を登録すると、ここに統合ビューが表示されます。</p>
      <a class="btn" href="/">施設一覧へ戻る</a>
    </div>
  {/if}
{/await}

<style>
  .state {
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 8px;
    height: 100vh;
    color: var(--muted);
    text-align: center;
  }
  h1 {
    margin: 0;
    color: var(--text);
    font-size: 18px;
  }
  p {
    margin: 0 0 8px;
  }
  .spinner {
    width: 28px;
    height: 28px;
    border: 3px solid var(--line);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
