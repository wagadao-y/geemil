<script lang="ts">
  import { ArrowRight, Camera, MapPin, MessageSquare, Search } from '@lucide/svelte';
  import { api, currentUser } from '$lib/api/client';
  import type { Site } from '$lib/types';
  import Logo from '$lib/components/Logo.svelte';

  let sites = $state<Site[]>([]);
  let query = $state('');
  $effect(() => {
    void api()
      .listSites()
      .then((list) => (sites = list));
  });
  const filtered = $derived(
    sites.filter((s) => !query.trim() || `${s.name}${s.address}`.includes(query.trim())),
  );
</script>

<svelte:head><title>施設一覧 · Spatial Hub</title></svelte:head>

<div class="page">
  <header>
    <Logo />
    <span class="avatar" style:background={currentUser.color}>{currentUser.initials}</span>
  </header>

  <main>
    <div class="intro">
      <h1>施設</h1>
      <p>現地に行く前に、まずここで確認。メッシュ・点群・360°写真を同じ空間で見られます。</p>
    </div>

    <label class="search">
      <Search size={16} />
      <input bind:value={query} placeholder="施設名・所在地で絞り込み" />
    </label>

    <div class="grid">
      {#each filtered as site (site.id)}
        <a class="card" href={`/sites/${site.id}`}>
          <div class="thumb" class:empty={site.stats.spaces === 0}>
            <svg viewBox="0 0 220 120" aria-hidden="true">
              <rect x="20" y="16" width="180" height="88" rx="6" fill="#3a4044" />
              {#if site.stats.spaces > 0}
                <rect x="88" y="34" width="56" height="36" fill="#a6aeb1" />
                <rect x="40" y="70" width="28" height="18" fill="#c4c8c4" />
                <rect x="150" y="72" width="26" height="22" fill="#98a0a2" />
                <circle cx="46" cy="36" r="8" fill="#d6dada" />
                <circle cx="64" cy="30" r="8" fill="#d6dada" />
                <circle cx="116" cy="54" r="4" fill="#2dd4bf" stroke="#fff" stroke-width="1.5" />
              {/if}
            </svg>
            {#if site.stats.spaces === 0}<span>3D データ未登録</span>{/if}
          </div>
          <div class="info">
            <h2>{site.name}</h2>
            <div class="addr"><MapPin size={13} /> {site.address}</div>
            <div class="stats">
              <span><MessageSquare size={13} /> 注記 {site.stats.annotations}</span>
              <span><Camera size={13} /> 写真 {site.stats.panoramas}</span>
              <span class="date">撮影 {site.capturedAt.replaceAll('-', '.')}</span>
            </div>
          </div>
          <span class="go"><ArrowRight size={16} /></span>
        </a>
      {/each}
    </div>
  </main>
</div>

<style>
  .page {
    min-height: 100vh;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 56px;
    padding: 0 24px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }
  .avatar {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    color: #fff;
    font-weight: 600;
  }
  main {
    max-width: 1080px;
    margin: 0 auto;
    padding: 40px 24px;
  }
  h1 {
    margin: 0 0 4px;
    font-size: 24px;
  }
  .intro p {
    margin: 0 0 24px;
    color: var(--muted);
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 360px;
    height: 38px;
    margin-bottom: 20px;
    padding: 0 12px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--panel);
    color: var(--muted);
  }
  .search input {
    flex: 1;
    border: 0;
    outline: none;
    background: none;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 16px;
  }
  .card {
    position: relative;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel);
    color: inherit;
    text-decoration: none;
    transition:
      box-shadow 0.15s,
      border-color 0.15s;
  }
  .card:hover {
    border-color: var(--accent-line);
    box-shadow: var(--shadow-lg);
  }
  .thumb {
    position: relative;
    display: grid;
    place-items: center;
    background: #12171c;
  }
  .thumb svg {
    width: 100%;
    display: block;
  }
  .thumb span {
    position: absolute;
    color: #9aa3aa;
    font-size: 12px;
  }
  .info {
    padding: 14px 16px 16px;
  }
  h2 {
    margin: 0 0 2px;
    font-size: 16px;
  }
  .addr,
  .stats {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--muted);
    font-size: 12px;
  }
  .stats {
    gap: 14px;
    margin-top: 10px;
  }
  .stats span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .date {
    margin-left: auto;
  }
  .go {
    position: absolute;
    top: 12px;
    right: 12px;
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: #fff;
    color: var(--accent);
    opacity: 0;
    transition: opacity 0.15s;
  }
  .card:hover .go {
    opacity: 1;
  }
</style>
