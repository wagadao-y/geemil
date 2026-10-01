<script lang="ts">
  import {
    Crosshair,
    Eye,
    EyeOff,
    MapPinPlus,
    Camera,
    ScanLine,
    Mountain,
    ChevronRight,
    MessageSquare,
  } from '@lucide/svelte';
  import type { SpaceNode } from '$lib/types';
  import { useWorkspace } from '$lib/state/workspace.svelte';
  import PanelHeader from './PanelHeader.svelte';
  import NodeIcon from './NodeIcon.svelte';
  import CategoryIcon from './CategoryIcon.svelte';

  let { node }: { node: SpaceNode } = $props();
  const ws = useWorkspace();

  const kindLabels = {
    site: '施設',
    outdoor: '屋外',
    building: '建屋',
    floor: '階',
    area: 'エリア',
  };
  const subtree = $derived(new Set([node.id, ...ws.descendants(node.id).map((n) => n.id)]));
  const annotations = $derived(ws.annotations.filter((a) => subtree.has(a.nodeId)));
  const panoramas = $derived(ws.bundle.panoramas.filter((p) => subtree.has(p.nodeId)));
  const assets = $derived(ws.bundle.assets.filter((a) => subtree.has(a.nodeId)));
  const children = $derived(ws.children.get(node.id) ?? []);
  const hidden = $derived(ws.hiddenNodes.has(node.id));
  const size = $derived(node.bounds.max.map((v, i) => v - node.bounds.min[i]));
  const issues = $derived(annotations.filter((a) => a.category === 'issue').length);
</script>

<div class="panel">
  <PanelHeader label={`選択中の${kindLabels[node.kind]}`} />

  <div class="body scroll">
    <section class="hero">
      <div class="title">
        <span class="icon"><NodeIcon kind={node.kind} size={20} /></span>
        <div>
          <h1>{node.name}</h1>
          <div class="path">{ws.pathLabel(node.parentId ?? '') || ws.root.name}</div>
        </div>
      </div>
      <div class="actions">
        <button class="btn outline" onclick={() => ws.viewer?.frameBox(node.bounds)}>
          <Crosshair size={15} /> フォーカス
        </button>
        <button class="btn" onclick={() => ws.toggleNode(node.id)}>
          {#if hidden}<Eye size={15} /> 表示する{:else}<EyeOff size={15} /> 非表示にする{/if}
        </button>
      </div>
    </section>

    <section class="stats">
      <div><strong>{annotations.length}</strong><span>注記</span></div>
      <div class:warn={issues > 0}><strong>{issues}</strong><span>要対応</span></div>
      <div><strong>{panoramas.length}</strong><span>360°写真</span></div>
      <div>
        <strong>{Math.round(size[0])}×{Math.round(size[1])}</strong><span>範囲 (m)</span>
      </div>
    </section>

    {#if children.length}
      <section>
        <h2>構成</h2>
        <div class="list">
          {#each children as child (child.id)}
            <button class="item" onclick={() => ws.focusNode(child.id)}>
              <span class="item-icon"><NodeIcon kind={child.kind} size={14} /></span>
              <span class="item-name">{child.name}</span>
              <span class="item-meta">{ws.annotationsUnder(child.id).length} 件</span>
              <ChevronRight size={14} />
            </button>
          {/each}
        </div>
      </section>
    {/if}

    <section>
      <div class="section-head">
        <h2>注記</h2>
        <button class="btn sm ghost" onclick={() => (ws.tool = 'annotate')}>
          <MapPinPlus size={14} /> 追加
        </button>
      </div>
      <div class="list">
        {#each annotations as a (a.id)}
          <button class="item" onclick={() => ws.selectAnnotation(a.id, { fly: true })}>
            <span class="item-icon cat {a.category}"
              ><CategoryIcon category={a.category} size={14} /></span
            >
            <span class="item-name">
              {a.title}
              {#if a.code}<span class="mono code">{a.code}</span>{/if}
            </span>
            {#if a.comments.length}<span class="item-meta comments"
                ><MessageSquare size={12} /> {a.comments.length}</span
              >{/if}
            <ChevronRight size={14} />
          </button>
        {:else}
          <p class="empty">まだ注記はありません。3D 上の位置をクリックして追加できます。</p>
        {/each}
      </div>
    </section>

    {#if panoramas.length}
      <section>
        <h2>360°写真</h2>
        <div class="chips">
          {#each panoramas as p (p.id)}
            <button class="pano" onclick={() => ws.openPanorama(p)}>
              <Camera size={13} />
              <span class="mono">{p.name}</span>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    {#if assets.length}
      <section>
        <h2>3D データ</h2>
        <div class="list">
          {#each assets as asset (asset.id)}
            <div class="asset">
              <span class="item-icon">
                {#if asset.kind === 'pointcloud'}<ScanLine size={14} />{:else}<Mountain
                    size={14}
                  />{/if}
              </span>
              <div>
                <div class="item-name">{asset.name}</div>
                <div class="item-meta">
                  {asset.source} · {asset.capturedAt.replaceAll('-', '.')}
                  {#if asset.pointCount}· {(asset.pointCount / 1e6).toFixed(1)}M 点{/if}
                </div>
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .body {
    flex: 1;
    min-height: 0;
  }
  section {
    padding: 14px 16px;
    border-top: 1px solid var(--line);
  }
  .hero {
    padding-top: 2px;
    border-top: 0;
  }
  .title {
    display: flex;
    gap: 12px;
    margin-bottom: 14px;
  }
  .icon {
    display: grid;
    flex: none;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: 10px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
  }
  .path {
    color: var(--muted);
  }
  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
    text-align: center;
  }
  .stats div {
    display: grid;
    padding: 6px 0;
    border-radius: 6px;
    background: var(--panel-2);
  }
  .stats strong {
    font-size: 16px;
    font-variant-numeric: tabular-nums;
  }
  .stats span {
    color: var(--muted);
    font-size: 11px;
  }
  .stats .warn strong {
    color: var(--warn);
  }
  h2 {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 600;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .section-head h2 {
    margin: 0;
  }
  .list {
    display: grid;
    gap: 2px;
  }
  .item,
  .asset {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--faint);
    text-align: left;
  }
  .item:hover {
    background: var(--panel-2);
  }
  .item-icon {
    display: grid;
    flex: none;
    place-items: center;
    width: 26px;
    height: 26px;
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--muted);
  }
  .cat.equipment {
    color: var(--accent);
  }
  .cat.issue {
    color: var(--warn);
  }
  .cat.note {
    color: var(--info);
  }
  .item-name {
    flex: 1;
    min-width: 0;
    color: var(--text);
    font-weight: 500;
  }
  .code {
    margin-left: 4px;
    color: var(--faint);
    font-size: 11px;
    font-weight: 400;
  }
  .item-meta {
    color: var(--muted);
    font-size: 12px;
  }
  .comments {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .empty {
    margin: 0;
    color: var(--faint);
    font-size: 12px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .pano {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    background: var(--panel);
    font-size: 12px;
  }
  .pano:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
