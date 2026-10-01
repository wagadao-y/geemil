<script lang="ts">
  import { Building2, ChevronDown, Share2, Check } from '@lucide/svelte';
  import { api, currentUser } from '$lib/api/client';
  import type { Site } from '$lib/types';
  import { useWorkspace } from '$lib/state/workspace.svelte';
  import Logo from './Logo.svelte';
  import SearchBox from './SearchBox.svelte';
  import Popover from './Popover.svelte';

  const ws = useWorkspace();
  let sites = $state<Site[]>([]);
  let siteMenu = $state(false);
  let userMenu = $state(false);

  $effect(() => {
    void api()
      .listSites()
      .then((list) => (sites = list));
  });
</script>

<header>
  <a class="brand" href="/" aria-label="施設一覧へ">
    <Logo />
  </a>

  <div class="site-switch">
    <button class="site-btn" onclick={() => (siteMenu = !siteMenu)} aria-expanded={siteMenu}>
      <Building2 size={16} />
      <span>{ws.bundle.site.name}</span>
      <ChevronDown size={14} />
    </button>
    <Popover bind:open={siteMenu} align="left">
      <div class="menu">
        <div class="menu-label">施設を切り替え</div>
        {#each sites as site (site.id)}
          <a class="menu-item" href={`/sites/${site.id}`} onclick={() => (siteMenu = false)}>
            <span class="site-name">{site.name}</span>
            <span class="site-sub">{site.address} · 撮影 {site.capturedAt}</span>
            {#if site.id === ws.bundle.site.id}<span class="check"><Check size={14} /></span>{/if}
          </a>
        {/each}
        <a class="menu-foot" href="/">すべての施設を見る</a>
      </div>
    </Popover>
  </div>

  <SearchBox />

  <div class="actions">
    <button
      class="btn outline"
      onclick={() => ws.copy(ws.shareUrl(), '現在のビューのリンクをコピーしました')}
      title="カメラ位置・表示状態・選択中の注記を含むリンクをコピー"
    >
      <Share2 size={15} /> ビューを共有
    </button>
    <div class="user">
      <button class="avatar-btn" onclick={() => (userMenu = !userMenu)} aria-label="アカウント">
        <span class="avatar" style:background={currentUser.color}>{currentUser.initials}</span>
        <ChevronDown size={14} />
      </button>
      <Popover bind:open={userMenu} align="right">
        <div class="menu">
          <div class="who">
            <strong>{currentUser.name}</strong>
            <span>保全部 設備課</span>
          </div>
          <button class="menu-item" onclick={() => (userMenu = false)}>表示設定</button>
          <button class="menu-item" onclick={() => (userMenu = false)}
            >キーボードショートカット</button
          >
          <button class="menu-item" onclick={() => (userMenu = false)}>ログアウト</button>
        </div>
      </Popover>
    </div>
  </div>
</header>

<style>
  header {
    grid-area: header;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 16px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
    z-index: 40;
  }
  .brand {
    display: flex;
    align-items: center;
    width: 248px;
    color: inherit;
    text-decoration: none;
  }
  .site-switch {
    position: relative;
  }
  .site-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 10px 0 12px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--panel);
    font-weight: 500;
  }
  .site-btn:hover {
    border-color: var(--faint);
  }
  .site-btn :global(svg) {
    color: var(--muted);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-left: auto;
  }
  .user {
    position: relative;
  }
  .avatar-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px;
    border: 0;
    background: none;
    color: var(--muted);
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
  .menu {
    display: grid;
    min-width: 260px;
    padding: 6px;
  }
  .menu-label {
    padding: 6px 10px 4px;
    color: var(--faint);
    font-size: 11px;
    font-weight: 600;
  }
  .menu-item {
    position: relative;
    display: grid;
    gap: 1px;
    padding: 8px 32px 8px 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    text-align: left;
    text-decoration: none;
  }
  .menu-item:hover {
    background: var(--panel-2);
  }
  .site-name {
    font-weight: 500;
  }
  .site-sub {
    color: var(--muted);
    font-size: 12px;
  }
  .check {
    position: absolute;
    top: 50%;
    right: 10px;
    translate: 0 -50%;
    color: var(--accent);
  }
  .menu-foot {
    margin-top: 4px;
    padding: 8px 10px;
    border-top: 1px solid var(--line);
    font-size: 12px;
    text-decoration: none;
  }
  .who {
    display: grid;
    padding: 8px 10px 10px;
    margin-bottom: 4px;
    border-bottom: 1px solid var(--line);
  }
  .who span {
    color: var(--muted);
    font-size: 12px;
  }
  @media (max-width: 1280px) {
    .brand {
      width: auto;
    }
  }
</style>
