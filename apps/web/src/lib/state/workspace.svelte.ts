import { getContext, setContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { api, currentUser, newId } from '$lib/api/client';
import type {
  Annotation,
  AnnotationCategory,
  CameraState,
  Panorama,
  SavedView,
  SiteBundle,
  SpaceNode,
  Vec3,
} from '$lib/types';
import type { Viewer } from '$lib/viewer/viewer';

export type Tool = 'select' | 'measure' | 'annotate';

export type Selection =
  { type: 'annotation'; id: string } | { type: 'node'; id: string } | { type: 'draft' };

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error';
}

export const categoryLabels: Record<AnnotationCategory, string> = {
  equipment: '設備',
  note: 'メモ',
  issue: '要対応',
};

function contains(node: SpaceNode, p: Vec3): boolean {
  const { min, max } = node.bounds;
  return p.every((v, i) => v >= min[i] - 0.01 && v <= max[i] + 0.01);
}

/** UI state of one opened site, shared by the components through context. */
export class Workspace {
  readonly bundle: SiteBundle;
  viewer = $state<Viewer | null>(null);

  annotations = $state<Annotation[]>([]);
  savedViews = $state<SavedView[]>([]);

  readonly hiddenNodes = new SvelteSet<string>();
  readonly expanded = new SvelteSet<string>();
  layers = $state({ mesh: true, pointcloud: true, panorama: true, annotation: true });
  meshOpacity = $state(0.7);
  floorFilter = $state<string | null>(null);

  selection = $state<Selection | null>(null);
  /** Node the breadcrumb points at: the last node or annotation location flown to. */
  focusNodeId = $state<string>('');
  tool = $state<Tool>('select');
  panoramaId = $state<string | null>(null);
  draft = $state<Annotation | null>(null);
  measurePoints = $state<Vec3[]>([]);
  leftTab = $state<'tree' | 'views'>('tree');
  showLeft = $state(true);
  toasts = $state<Toast[]>([]);

  readonly nodesById: Map<string, SpaceNode>;
  readonly children: Map<string | null, SpaceNode[]>;
  readonly root: SpaceNode;

  constructor(bundle: SiteBundle) {
    this.bundle = bundle;
    this.annotations = bundle.annotations;
    this.savedViews = bundle.savedViews;
    this.nodesById = new Map(bundle.nodes.map((n) => [n.id, n]));
    this.children = new Map();
    for (const node of [...bundle.nodes].sort((a, b) => a.order - b.order)) {
      const list = this.children.get(node.parentId) ?? [];
      list.push(node);
      this.children.set(node.parentId, list);
    }
    this.root = this.children.get(null)![0];
    this.focusNodeId = this.root.id;
    this.expanded.add(this.root.id);
  }

  // ------------------------------------------------------------ hierarchy

  /** Hidden nodes including the descendants of hidden nodes. */
  effectiveHidden = $derived.by(() => {
    const hidden = new Set<string>();
    const walk = (node: SpaceNode, parentHidden: boolean) => {
      const isHidden = parentHidden || this.hiddenNodes.has(node.id);
      if (isHidden) hidden.add(node.id);
      for (const child of this.children.get(node.id) ?? []) walk(child, isHidden);
    };
    walk(this.root, false);
    return hidden;
  });

  path(nodeId: string): SpaceNode[] {
    const path: SpaceNode[] = [];
    for (
      let n = this.nodesById.get(nodeId);
      n;
      n = n.parentId ? this.nodesById.get(n.parentId) : undefined
    ) {
      path.unshift(n);
    }
    return path;
  }

  pathLabel(nodeId: string): string {
    return this.path(nodeId)
      .slice(1)
      .map((n) => n.name)
      .join(' / ');
  }

  descendants(nodeId: string): SpaceNode[] {
    const out: SpaceNode[] = [];
    const walk = (id: string) => {
      for (const child of this.children.get(id) ?? []) {
        out.push(child);
        walk(child.id);
      }
    };
    walk(nodeId);
    return out;
  }

  /** The deepest node whose bounds contain the point, preferring indoor nodes. */
  nodeAt(p: Vec3): SpaceNode {
    let best = this.root;
    const visit = (node: SpaceNode, depth: number, bestDepth: { d: number }) => {
      for (const child of this.children.get(node.id) ?? []) {
        if (child.kind === 'outdoor') continue;
        if (contains(child, p)) {
          if (depth + 1 > bestDepth.d) {
            best = child;
            bestDepth.d = depth + 1;
          }
          visit(child, depth + 1, bestDepth);
        }
      }
    };
    visit(this.root, 0, { d: 0 });
    if (best === this.root) {
      return (this.children.get(this.root.id) ?? []).find((n) => n.kind === 'outdoor') ?? best;
    }
    return best;
  }

  /** True when the floor filter cuts away the floor that contains a node. */
  isCutAway(nodeId: string): boolean {
    const cut = this.floorFilter ? this.nodesById.get(this.floorFilter) : undefined;
    if (!cut) return false;
    const floor = this.path(nodeId).find((n) => n.kind === 'floor');
    return (
      !!floor && floor.parentId === cut.parentId && (floor.elevation ?? 0) > (cut.elevation ?? 0)
    );
  }

  /** Visible in the 3D view: not hidden, not cut by the floor filter. */
  isNodeShown(nodeId: string): boolean {
    return !this.effectiveHidden.has(nodeId) && !this.isCutAway(nodeId);
  }

  toggleNode(nodeId: string) {
    if (this.hiddenNodes.has(nodeId)) this.hiddenNodes.delete(nodeId);
    else this.hiddenNodes.add(nodeId);
  }

  /** Floors of the building that contains the focused node, for the floor switcher. */
  focusedBuilding = $derived.by(() => {
    const path = this.path(this.focusNodeId);
    return path.find((n) => n.kind === 'building') ?? null;
  });

  // ------------------------------------------------------------ navigation

  focusNode(nodeId: string, options: { select?: boolean } = {}) {
    const node = this.nodesById.get(nodeId);
    if (!node) return;
    this.focusNodeId = nodeId;
    for (const n of this.path(nodeId).slice(0, -1)) this.expanded.add(n.id);
    if (options.select !== false)
      this.selection = node.parentId ? { type: 'node', id: nodeId } : null;
    // Entering a floor cuts the building above it; leaving the building clears the cut.
    if (node.kind === 'floor') this.floorFilter = node.id;
    else {
      const floor = this.path(nodeId).find((n) => n.kind === 'floor');
      this.floorFilter = floor?.id ?? null;
    }
    if (this.panoramaId) void this.closePanorama(false);
    void this.viewer?.frameBox(node.bounds);
  }

  selectAnnotation(id: string, options: { fly?: boolean } = {}) {
    const annotation = this.annotations.find((a) => a.id === id);
    if (!annotation) return;
    this.selection = { type: 'annotation', id };
    this.focusNodeId = annotation.nodeId;
    for (const n of this.path(annotation.nodeId)) this.expanded.add(n.id);
    // Flying to an indoor annotation cuts the floors above it, as entering its floor does.
    const floor = this.path(annotation.nodeId).find((n) => n.kind === 'floor');
    if (floor && (options.fly || this.isCutAway(annotation.nodeId))) this.floorFilter = floor.id;
    if (options.fly && !this.panoramaId) {
      if (annotation.extent) {
        void this.viewer?.frameBox(annotation.extent);
      } else {
        this.viewer?.focusPoint(annotation.position);
      }
    }
  }

  clearSelection() {
    this.selection = null;
    this.draft = null;
  }

  selectedAnnotation = $derived.by(() => {
    const s = this.selection;
    if (s?.type === 'draft') return this.draft;
    if (s?.type !== 'annotation') return null;
    return this.annotations.find((a) => a.id === s.id) ?? null;
  });

  home() {
    this.focusNodeId = this.root.id;
    this.floorFilter = null;
    void this.viewer?.flyTo({ position: [-95, -150, 110], target: [0, 0, 0] }, 900);
  }

  // ------------------------------------------------------------ panoramas

  panorama = $derived.by(() =>
    this.panoramaId ? (this.bundle.panoramas.find((p) => p.id === this.panoramaId) ?? null) : null,
  );

  /** Panoramas near the given one, in capture order, for the film strip. */
  panoramasNear(pano: Panorama): Panorama[] {
    return this.bundle.panoramas
      .filter((p) => p.nodeId === pano.nodeId || p.id === pano.id)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  nearestPanorama(p: Vec3): Panorama | null {
    let best: Panorama | null = null;
    let bestDistance = 30;
    for (const pano of this.bundle.panoramas) {
      const d = Math.hypot(...pano.position.map((v, i) => v - p[i]));
      if (d < bestDistance && Math.abs(pano.position[2] - p[2]) < 5) {
        best = pano;
        bestDistance = d;
      }
    }
    return best;
  }

  async openPanorama(pano: Panorama, lookAt?: Vec3) {
    this.panoramaId = pano.id;
    this.focusNodeId = pano.nodeId;
    for (const n of this.path(pano.nodeId).slice(0, -1)) this.expanded.add(n.id);
    this.tool = 'select';
    this.measurePoints = [];
    const floor = this.path(pano.nodeId).find((n) => n.kind === 'floor');
    if (floor) this.floorFilter = floor.id;
    let heading = pano.heading;
    if (lookAt) {
      heading =
        (Math.atan2(lookAt[0] - pano.position[0], lookAt[1] - pano.position[1]) * 180) / Math.PI;
    }
    await this.viewer?.enterPanorama(pano, heading);
  }

  async closePanorama(restore = true) {
    this.panoramaId = null;
    if (restore) await this.viewer?.exitPanorama();
    else this.viewer?.exitPanorama();
  }

  // ------------------------------------------------------------ annotations

  startDraft(position: Vec3) {
    const node = this.nodeAt(position);
    const now = new Date().toISOString();
    this.tool = 'select';
    if (this.draft && this.selection?.type === 'draft') {
      // Picking again while the form is open moves the pin and keeps what was typed.
      this.draft.position = position;
      this.draft.nodeId = node.id;
      return;
    }
    this.draft = {
      id: newId('an'),
      siteId: this.bundle.site.id,
      nodeId: node.id,
      category: 'note',
      title: '',
      description: '',
      position,
      links: [],
      attachments: [],
      comments: [],
      createdBy: currentUser,
      createdAt: now,
      updatedAt: now,
    };
    this.selection = { type: 'draft' };
    this.tool = 'select';
  }

  async saveDraft() {
    if (!this.draft) return;
    const saved = await api().saveAnnotation($state.snapshot(this.draft) as Annotation);
    this.annotations.push(saved);
    this.draft = null;
    this.selection = { type: 'annotation', id: saved.id };
    for (const n of this.path(saved.nodeId)) this.expanded.add(n.id);
    this.toast('注記を追加しました', 'success');
  }

  async updateAnnotation(annotation: Annotation) {
    const saved = await api().saveAnnotation($state.snapshot(annotation) as Annotation);
    this.replaceAnnotation(saved);
  }

  async deleteAnnotation(id: string) {
    await api().deleteAnnotation(id);
    this.annotations = this.annotations.filter((a) => a.id !== id);
    if (this.selection?.type === 'annotation' && this.selection.id === id) this.selection = null;
    this.toast('注記を削除しました');
  }

  replaceAnnotation(annotation: Annotation) {
    const index = this.annotations.findIndex((a) => a.id === annotation.id);
    if (index >= 0) this.annotations[index] = annotation;
  }

  annotationsUnder(nodeId: string): Annotation[] {
    const ids = new Set([nodeId, ...this.descendants(nodeId).map((n) => n.id)]);
    return this.annotations.filter((a) => ids.has(a.nodeId));
  }

  // ------------------------------------------------------------ views

  currentView(): { camera: CameraState; hiddenNodeIds: string[]; floorFilter: string | null } {
    return {
      camera: this.viewer?.getCamera() ?? { position: [0, 0, 100], target: [0, 0, 0] },
      hiddenNodeIds: [...this.hiddenNodes],
      floorFilter: this.floorFilter,
    };
  }

  applyView(view: Pick<SavedView, 'camera' | 'hiddenNodeIds' | 'floorFilter'>) {
    if (this.panoramaId) void this.closePanorama(false);
    this.hiddenNodes.clear();
    for (const id of view.hiddenNodeIds) this.hiddenNodes.add(id);
    this.floorFilter = view.floorFilter;
    if (view.floorFilter) this.focusNodeId = view.floorFilter;
    else this.focusNodeId = this.root.id;
    void this.viewer?.flyTo(view.camera, 900);
  }

  async saveCurrentView(name: string) {
    const view: SavedView = {
      id: newId('v'),
      siteId: this.bundle.site.id,
      name,
      ...this.currentView(),
      thumbnail: this.viewer?.thumbnail(),
      createdBy: currentUser,
      createdAt: new Date().toISOString(),
    };
    await api().saveView(view);
    this.savedViews.push(view);
    this.toast('ビューを保存しました', 'success');
  }

  async deleteView(id: string) {
    await api().deleteView(id);
    this.savedViews = this.savedViews.filter((v) => v.id !== id);
  }

  /** URL that reopens the current camera, filters and selection. */
  shareUrl(): string {
    const view = this.currentView();
    const params = new URLSearchParams();
    params.set('cam', [...view.camera.position, ...view.camera.target].join(','));
    if (view.hiddenNodeIds.length) params.set('hide', view.hiddenNodeIds.join(','));
    if (view.floorFilter) params.set('floor', view.floorFilter);
    if (this.selection?.type === 'annotation') params.set('a', this.selection.id);
    if (this.panoramaId) params.set('pano', this.panoramaId);
    return `${location.origin}${location.pathname}?${params}`;
  }

  annotationUrl(id: string): string {
    return `${location.origin}${location.pathname}?a=${encodeURIComponent(id)}`;
  }

  // ------------------------------------------------------------ toasts

  private toastId = 0;

  toast(message: string, tone: Toast['tone'] = 'info') {
    const id = ++this.toastId;
    this.toasts.push({ id, message, tone });
    setTimeout(() => (this.toasts = this.toasts.filter((t) => t.id !== id)), 2600);
  }

  async copy(text: string, message: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast(message, 'success');
    } catch {
      this.toast('コピーできませんでした', 'error');
    }
  }
}

const KEY = Symbol('workspace');

export function provideWorkspace(ws: Workspace) {
  setContext(KEY, ws);
}

export function useWorkspace(): Workspace {
  return getContext<Workspace>(KEY);
}
