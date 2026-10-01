<script lang="ts">
  import {
    Crosshair,
    Camera,
    ExternalLink,
    Plus,
    Link2,
    Download,
    Trash2,
    Paperclip,
    Ellipsis,
    Pencil,
    SendHorizontal,
    MapPin,
    FileText,
    FileImage,
    File as FileIcon,
    X,
  } from '@lucide/svelte';
  import { api } from '$lib/api/client';
  import type { Annotation } from '$lib/types';
  import { categoryLabels, useWorkspace } from '$lib/state/workspace.svelte';
  import { formatBytes, formatDateTime, relativeTime } from '$lib/viewer/format';
  import PanelHeader from './PanelHeader.svelte';
  import CategoryIcon from './CategoryIcon.svelte';
  import AnnotationForm from './AnnotationForm.svelte';
  import Popover from './Popover.svelte';

  let { annotation }: { annotation: Annotation } = $props();
  const ws = useWorkspace();

  let editing = $state(false);
  let editCopy = $state<Annotation | null>(null);
  let menu = $state(false);
  let linkForm = $state(false);
  let link = $state({ title: '', system: '', url: '' });
  let comment = $state('');
  let sending = $state(false);
  let dragging = $state(false);
  let uploading = $state(0);
  let fileInput = $state<HTMLInputElement>();

  const nearest = $derived(ws.nearestPanorama(annotation.position));
  const linkValid = $derived(link.title.trim() !== '' && /^https?:\/\/\S+$/.test(link.url.trim()));

  function startEdit() {
    menu = false;
    editCopy = $state.snapshot(annotation) as Annotation;
    editing = true;
  }

  async function saveEdit() {
    if (!editCopy) return;
    await ws.updateAnnotation(editCopy);
    editing = false;
    ws.toast('注記を更新しました', 'success');
  }

  async function remove() {
    menu = false;
    if (
      !confirm(
        `「${annotation.title}」を削除しますか？\nコメント・リンク・添付ファイルも削除されます。`,
      )
    )
      return;
    await ws.deleteAnnotation(annotation.id);
  }

  function focus() {
    if (ws.panoramaId) void ws.closePanorama();
    ws.selectAnnotation(annotation.id, { fly: true });
  }

  async function addLink() {
    if (!linkValid) return;
    const created = await api().addLink(annotation.id, {
      title: link.title.trim(),
      system: link.system.trim() || new URL(link.url.trim()).host,
      url: link.url.trim(),
    });
    annotation.links.push(created);
    link = { title: '', system: '', url: '' };
    linkForm = false;
  }

  async function removeLink(id: string) {
    await api().removeLink(annotation.id, id);
    annotation.links = annotation.links.filter((l) => l.id !== id);
  }

  async function upload(files: FileList | File[]) {
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) {
        ws.toast(`${file.name} は 20 MB を超えています`, 'error');
        continue;
      }
      uploading++;
      try {
        const attachment = await api().uploadAttachment(annotation.id, file);
        annotation.attachments.push(attachment);
      } finally {
        uploading--;
      }
    }
  }

  async function removeAttachment(id: string) {
    await api().removeAttachment(annotation.id, id);
    annotation.attachments = annotation.attachments.filter((f) => f.id !== id);
  }

  async function send() {
    const body = comment.trim();
    if (!body || sending) return;
    sending = true;
    try {
      const created = await api().addComment(annotation.id, body);
      annotation.comments.push(created);
      comment = '';
    } finally {
      sending = false;
    }
  }

  function fileKind(mime: string, name: string) {
    if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
    if (mime.startsWith('image/')) return 'image';
    return 'other';
  }
</script>

{#if editing && editCopy}
  <AnnotationForm
    bind:annotation={editCopy}
    mode="edit"
    onsave={saveEdit}
    oncancel={() => (editing = false)}
  />
{:else}
  <div class="panel">
    <PanelHeader label="選択中の注記">
      {#snippet actions()}
        <div class="menu-wrap">
          <button class="icon-btn" aria-label="その他の操作" onclick={() => (menu = !menu)}>
            <Ellipsis size={17} />
          </button>
          <Popover bind:open={menu} align="right">
            <div class="menu">
              <button onclick={startEdit}><Pencil size={14} /> 編集</button>
              <button class="danger" onclick={remove}><Trash2 size={14} /> 削除</button>
            </div>
          </Popover>
        </div>
      {/snippet}
    </PanelHeader>

    <div class="body scroll">
      <section class="hero">
        <span class="chip {annotation.category}">
          <CategoryIcon category={annotation.category} size={12} />
          {categoryLabels[annotation.category]}
        </span>
        <h1>{annotation.title}</h1>
        {#if annotation.code}<div class="code mono">{annotation.code}</div>{/if}
        {#if annotation.description}<p class="desc">{annotation.description}</p>{/if}
      </section>

      <section>
        <h2>位置</h2>
        <button class="location" onclick={() => ws.focusNode(annotation.nodeId, { select: false })}>
          <MapPin size={14} />
          {ws.pathLabel(annotation.nodeId) || '敷地'}
        </button>
        <div class="coords mono">
          X {annotation.position[0].toFixed(2)} · Y {annotation.position[1].toFixed(2)} · Z {annotation.position[2].toFixed(
            2,
          )}
        </div>
        <div class="actions">
          <button class="btn outline" onclick={focus}>
            <Crosshair size={15} /> フォーカス
          </button>
          <button
            class="btn"
            disabled={!nearest}
            title={nearest ? `${nearest.name} から見る` : '近くに 360°写真がありません'}
            onclick={() => nearest && ws.openPanorama(nearest, annotation.position)}
          >
            <Camera size={15} /> 360°写真で見る
          </button>
        </div>
      </section>

      <section>
        <div class="section-head">
          <h2>関連システム</h2>
          {#if !linkForm}
            <button class="btn sm ghost" onclick={() => (linkForm = true)}>
              <Plus size={14} /> 追加
            </button>
          {/if}
        </div>
        {#if linkForm}
          <form
            class="link-form"
            onsubmit={(e) => {
              e.preventDefault();
              void addLink();
            }}
          >
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="input"
              placeholder="表示名（例：設備台帳）"
              bind:value={link.title}
              autofocus
            />
            <input
              class="input"
              placeholder="システム名（例：社内設備管理システム）"
              bind:value={link.system}
            />
            <input class="input mono" placeholder="https://" bind:value={link.url} type="url" />
            <div class="row">
              <button type="button" class="btn sm ghost" onclick={() => (linkForm = false)}
                >取消</button
              >
              <button class="btn sm primary" disabled={!linkValid}>追加</button>
            </div>
          </form>
        {/if}
        <div class="links">
          {#each annotation.links as l (l.id)}
            <div class="link">
              <a href={l.url} target="_blank" rel="noopener noreferrer">
                <span class="link-text">
                  <strong>{l.title}</strong>
                  <span>{l.system}</span>
                </span>
                <ExternalLink size={16} />
              </a>
              <button
                class="icon-btn remove"
                aria-label="リンクを削除"
                onclick={() => removeLink(l.id)}
              >
                <X size={14} />
              </button>
            </div>
          {:else}
            {#if !linkForm}
              <p class="empty">設備台帳・点検履歴・図面などへのリンクを追加できます</p>
            {/if}
          {/each}
        </div>
      </section>

      <section
        class="files"
        class:dragging
        ondragover={(e) => {
          e.preventDefault();
          dragging = true;
        }}
        ondragleave={() => (dragging = false)}
        ondrop={(e) => {
          e.preventDefault();
          dragging = false;
          if (e.dataTransfer?.files.length) void upload(e.dataTransfer.files);
        }}
        aria-label="添付ファイル"
      >
        <div class="section-head">
          <h2>添付ファイル</h2>
          <button class="btn sm ghost" onclick={() => fileInput?.click()}>
            <Paperclip size={14} /> 追加
          </button>
          <input
            bind:this={fileInput}
            type="file"
            multiple
            hidden
            onchange={(e) => {
              const input = e.currentTarget;
              if (input.files?.length) void upload([...input.files]);
              input.value = '';
            }}
          />
        </div>
        {#each annotation.attachments as f (f.id)}
          {@const kind = fileKind(f.mimeType, f.name)}
          <div class="file">
            <span class="file-icon {kind}">
              {#if kind === 'pdf'}<FileText size={18} />
              {:else if kind === 'image'}<FileImage size={18} />
              {:else}<FileIcon size={18} />{/if}
            </span>
            <span class="file-text">
              <span class="file-name">{f.name}</span>
              <span class="file-meta">{formatBytes(f.size)} · {f.uploadedBy}</span>
            </span>
            <a
              class="icon-btn"
              href={f.url}
              download={f.name}
              aria-label="ダウンロード"
              title="ダウンロード"
            >
              <Download size={15} />
            </a>
            <button
              class="icon-btn remove"
              aria-label="削除"
              onclick={() => removeAttachment(f.id)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        {/each}
        {#if uploading}
          <div class="file uploading"><span class="bar"></span>アップロード中…</div>
        {/if}
        <button class="drop" onclick={() => fileInput?.click()}>
          ここにファイルをドロップ、またはクリックして選択
        </button>
        <p class="hint">点検記録・文書の原本は連携先のシステムで管理します</p>
      </section>

      <section>
        <h2>コメント <span class="count">{annotation.comments.length}</span></h2>
        <ol class="comments">
          {#each annotation.comments as c (c.id)}
            <li>
              <span class="avatar" style:background={c.author.color}>{c.author.initials}</span>
              <div class="bubble">
                <div class="who">
                  <strong>{c.author.name}</strong>
                  <time datetime={c.createdAt} title={formatDateTime(c.createdAt)}>
                    {relativeTime(c.createdAt)}
                  </time>
                </div>
                <p>{c.body}</p>
              </div>
            </li>
          {/each}
        </ol>
        <form
          class="composer"
          onsubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            class="input"
            rows="2"
            placeholder="コメントを書く（Ctrl + Enter で送信）"
            bind:value={comment}
            onkeydown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void send();
              }
            }}></textarea>
          <button class="send" disabled={!comment.trim() || sending} aria-label="送信">
            <SendHorizontal size={16} />
          </button>
        </form>
      </section>

      <section class="foot">
        作成 {annotation.createdBy.name} · {formatDateTime(annotation.createdAt)}<br />
        更新 {formatDateTime(annotation.updatedAt)}
      </section>
    </div>

    <div class="sticky">
      <button
        class="btn outline block"
        onclick={() =>
          ws.copy(ws.annotationUrl(annotation.id), 'この注記へのリンクをコピーしました')}
      >
        <Link2 size={15} /> この注記のリンクをコピー
      </button>
    </div>
  </div>
{/if}

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
  section.hero {
    padding-top: 2px;
    border-top: 0;
  }
  h1 {
    margin: 8px 0 2px;
    font-size: 20px;
    font-weight: 600;
    line-height: 1.35;
  }
  .code {
    color: var(--muted);
    font-size: 14px;
  }
  .desc {
    margin: 10px 0 0;
    color: var(--text-2);
  }
  h2 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 600;
  }
  .count {
    color: var(--faint);
    font-weight: 400;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .section-head h2 {
    margin: 0;
  }
  .location {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-2);
    text-align: left;
  }
  .location:hover {
    color: var(--accent);
    text-decoration: underline;
  }
  .location :global(svg) {
    flex: none;
    color: var(--muted);
  }
  .coords {
    margin: 2px 0 12px 20px;
    color: var(--faint);
    font-size: 11px;
  }
  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .links {
    display: grid;
    gap: 8px;
  }
  .link {
    position: relative;
  }
  .link a {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 9px 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    color: var(--muted);
    text-decoration: none;
    transition:
      border-color 0.12s,
      background 0.12s;
  }
  .link a:hover {
    border-color: var(--accent-line);
    background: var(--accent-soft);
    color: var(--accent);
  }
  .link-text {
    display: grid;
    min-width: 0;
  }
  .link-text strong {
    color: var(--accent);
    font-weight: 600;
  }
  .link-text span {
    overflow: hidden;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .remove {
    opacity: 0;
    transition: opacity 0.12s;
  }
  .link .remove {
    position: absolute;
    top: 4px;
    right: 38px;
    width: 24px;
    height: 24px;
  }
  .link:hover .remove,
  .file:hover .remove,
  .remove:focus-visible {
    opacity: 1;
  }
  .link-form {
    display: grid;
    gap: 6px;
    margin-bottom: 10px;
    padding: 10px;
    border-radius: var(--radius);
    background: var(--panel-2);
  }
  .row {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
  .empty {
    margin: 0;
    color: var(--faint);
    font-size: 12px;
  }
  .files.dragging {
    background: var(--accent-soft);
    outline: 2px dashed var(--accent);
    outline-offset: -6px;
  }
  .file {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 4px;
    border-bottom: 1px solid var(--line);
  }
  .file:last-of-type {
    border-bottom: 0;
  }
  .file-icon {
    display: grid;
    flex: none;
    place-items: center;
    width: 32px;
    height: 36px;
    border: 1px solid var(--line);
    border-radius: 5px;
    color: var(--muted);
  }
  .file-icon.pdf {
    border-color: #f3c4bf;
    background: #fdf1ef;
    color: #c0392b;
  }
  .file-icon.image {
    border-color: #c7d2fe;
    background: var(--info-soft);
    color: var(--info);
  }
  .file-text {
    display: grid;
    flex: 1;
    min-width: 0;
  }
  .file-name {
    overflow: hidden;
    font-weight: 500;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .file-meta {
    color: var(--faint);
    font-size: 11px;
  }
  .uploading {
    gap: 8px;
    color: var(--muted);
  }
  .bar {
    width: 60px;
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(90deg, var(--accent) 40%, var(--line) 40%);
    background-size: 200% 100%;
    animation: load 1s linear infinite;
  }
  @keyframes load {
    from {
      background-position: 100% 0;
    }
    to {
      background-position: -100% 0;
    }
  }
  .drop {
    width: 100%;
    margin-top: 8px;
    padding: 10px;
    border: 1px dashed var(--line-strong);
    border-radius: var(--radius);
    background: none;
    color: var(--faint);
    font-size: 12px;
  }
  .drop:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .hint {
    margin: 10px 0 0;
    color: var(--faint);
    font-size: 11px;
  }
  .comments {
    display: grid;
    gap: 12px;
    margin: 0 0 12px;
    padding: 0;
    list-style: none;
  }
  .comments li {
    display: flex;
    gap: 10px;
  }
  .avatar {
    display: grid;
    flex: none;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    color: #fff;
    font-size: 12px;
    font-weight: 600;
  }
  .bubble {
    flex: 1;
    min-width: 0;
  }
  .who {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .who strong {
    font-size: 12px;
  }
  time {
    color: var(--faint);
    font-size: 11px;
  }
  .bubble p {
    margin: 2px 0 0;
    color: var(--text-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .composer {
    position: relative;
  }
  .composer textarea {
    min-height: 60px;
    padding-right: 44px;
  }
  .send {
    position: absolute;
    right: 8px;
    bottom: 8px;
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: 0;
    border-radius: 6px;
    background: var(--accent);
    color: #fff;
  }
  .send:disabled {
    background: var(--line);
    color: var(--faint);
    cursor: default;
  }
  .foot {
    color: var(--faint);
    font-size: 11px;
  }
  .sticky {
    flex: none;
    padding: 12px 16px;
    border-top: 1px solid var(--line);
    background: var(--panel);
  }
  .menu-wrap {
    position: relative;
  }
  .menu {
    display: grid;
    min-width: 140px;
    padding: 4px;
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border: 0;
    border-radius: 5px;
    background: none;
    text-align: left;
  }
  .menu button:hover {
    background: var(--panel-2);
  }
  .menu .danger {
    color: var(--danger);
  }
  .menu .danger:hover {
    background: var(--danger-soft);
  }
</style>
