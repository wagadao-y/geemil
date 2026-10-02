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
  Space,
  Vec3,
} from '$lib/types';
import type { Viewer } from '$lib/viewer/viewer';

export type Tool = 'select' | 'measure' | 'annotate';

export type Selection =
  { type: 'annotation'; id: string } | { type: 'space'; id: string } | { type: 'draft' };

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

function contains(space: Space, p: Vec3): boolean {
  const { min, max } = space.bounds;
  return p.every((v, i) => v >= min[i] - 0.01 && v <= max[i] + 0.01);
}

/** UI state of one opened site, shared by the components through context. */
export class Workspace {
  readonly bundle: SiteBundle;
  viewer = $state<Viewer | null>(null);

  annotations = $state<Annotation[]>([]);
  savedViews = $state<SavedView[]>([]);

  readonly hiddenSpaces = new SvelteSet<string>();
  readonly expanded = new SvelteSet<string>();
  layers = $state({ mesh: true, pointcloud: true, panorama: true, annotation: true });
  meshOpacity = $state(0.7);
  floorFilter = $state<string | null>(null);

  selection = $state<Selection | null>(null);
  /** Space the breadcrumb points at: the last space or annotation location flown to. */
  focusSpaceId = $state<string>('');
  tool = $state<Tool>('select');
  panoramaId = $state<string | null>(null);
  draft = $state<Annotation | null>(null);
  measurePoints = $state<Vec3[]>([]);
  leftTab = $state<'tree' | 'views'>('tree');
  showLeft = $state(true);
  toasts = $state<Toast[]>([]);

  readonly spacesById: Map<string, Space>;
  readonly children: Map<string | null, Space[]>;
  readonly root: Space;

  constructor(bundle: SiteBundle) {
    this.bundle = bundle;
    this.annotations = bundle.annotations;
    this.savedViews = bundle.savedViews;
    this.spacesById = new Map(bundle.spaces.map((n) => [n.id, n]));
    this.children = new Map();
    for (const space of [...bundle.spaces].sort((a, b) => a.order - b.order)) {
      const list = this.children.get(space.parentId) ?? [];
      list.push(space);
      this.children.set(space.parentId, list);
    }
    this.root = this.children.get(null)![0];
    this.focusSpaceId = this.root.id;
    this.expanded.add(this.root.id);
  }

  // ------------------------------------------------------------ hierarchy

  /** Hidden spaces including the descendants of hidden spaces. */
  effectiveHidden = $derived.by(() => {
    const hidden = new Set<string>();
    const walk = (space: Space, parentHidden: boolean) => {
      const isHidden = parentHidden || this.hiddenSpaces.has(space.id);
      if (isHidden) hidden.add(space.id);
      for (const child of this.children.get(space.id) ?? []) walk(child, isHidden);
    };
    walk(this.root, false);
    return hidden;
  });

  path(spaceId: string): Space[] {
    const path: Space[] = [];
    for (
      let n = this.spacesById.get(spaceId);
      n;
      n = n.parentId ? this.spacesById.get(n.parentId) : undefined
    ) {
      path.unshift(n);
    }
    return path;
  }

  pathLabel(spaceId: string): string {
    return this.path(spaceId)
      .slice(1)
      .map((n) => n.name)
      .join(' / ');
  }

  descendants(spaceId: string): Space[] {
    const out: Space[] = [];
    const walk = (id: string) => {
      for (const child of this.children.get(id) ?? []) {
        out.push(child);
        walk(child.id);
      }
    };
    walk(spaceId);
    return out;
  }

  /** The deepest space whose bounds contain the point, preferring indoor spaces. */
  spaceAt(p: Vec3): Space {
    let best = this.root;
    const visit = (space: Space, depth: number, bestDepth: { d: number }) => {
      for (const child of this.children.get(space.id) ?? []) {
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

  /** True when the floor filter cuts away the floor that contains a space. */
  isCutAway(spaceId: string): boolean {
    const cut = this.floorFilter ? this.spacesById.get(this.floorFilter) : undefined;
    if (!cut) return false;
    const floor = this.path(spaceId).find((n) => n.kind === 'floor');
    return (
      !!floor && floor.parentId === cut.parentId && (floor.elevation ?? 0) > (cut.elevation ?? 0)
    );
  }

  /** Visible in the 3D view: not hidden, not cut by the floor filter. */
  isSpaceShown(spaceId: string): boolean {
    return !this.effectiveHidden.has(spaceId) && !this.isCutAway(spaceId);
  }

  toggleSpace(spaceId: string) {
    if (this.hiddenSpaces.has(spaceId)) this.hiddenSpaces.delete(spaceId);
    else this.hiddenSpaces.add(spaceId);
  }

  /** Floors of the building that contains the focused space, for the floor switcher. */
  focusedBuilding = $derived.by(() => {
    const path = this.path(this.focusSpaceId);
    return path.find((n) => n.kind === 'building') ?? null;
  });

  // ------------------------------------------------------------ navigation

  focusSpace(spaceId: string, options: { select?: boolean } = {}) {
    const space = this.spacesById.get(spaceId);
    if (!space) return;
    this.focusSpaceId = spaceId;
    for (const n of this.path(spaceId).slice(0, -1)) this.expanded.add(n.id);
    if (options.select !== false)
      this.selection = space.parentId ? { type: 'space', id: spaceId } : null;
    // Entering a floor cuts the building above it; leaving the building clears the cut.
    if (space.kind === 'floor') this.floorFilter = space.id;
    else {
      const floor = this.path(spaceId).find((n) => n.kind === 'floor');
      this.floorFilter = floor?.id ?? null;
    }
    if (this.panoramaId) void this.closePanorama(false);
    void this.viewer?.frameBox(space.bounds);
  }

  selectAnnotation(id: string, options: { fly?: boolean } = {}) {
    const annotation = this.annotations.find((a) => a.id === id);
    if (!annotation) return;
    this.selection = { type: 'annotation', id };
    this.focusSpaceId = annotation.spaceId;
    for (const n of this.path(annotation.spaceId)) this.expanded.add(n.id);
    // Flying to an indoor annotation cuts the floors above it, as entering its floor does.
    const floor = this.path(annotation.spaceId).find((n) => n.kind === 'floor');
    if (floor && (options.fly || this.isCutAway(annotation.spaceId))) this.floorFilter = floor.id;
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
    this.focusSpaceId = this.root.id;
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
      .filter((p) => p.spaceId === pano.spaceId || p.id === pano.id)
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
    this.focusSpaceId = pano.spaceId;
    for (const n of this.path(pano.spaceId).slice(0, -1)) this.expanded.add(n.id);
    this.tool = 'select';
    this.measurePoints = [];
    const floor = this.path(pano.spaceId).find((n) => n.kind === 'floor');
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
    const space = this.spaceAt(position);
    const now = new Date().toISOString();
    this.tool = 'select';
    if (this.draft && this.selection?.type === 'draft') {
      // Picking again while the form is open moves the pin and keeps what was typed.
      this.draft.position = position;
      this.draft.spaceId = space.id;
      return;
    }
    this.draft = {
      id: newId('an'),
      siteId: this.bundle.site.id,
      spaceId: space.id,
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
    for (const n of this.path(saved.spaceId)) this.expanded.add(n.id);
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

  annotationsUnder(spaceId: string): Annotation[] {
    const ids = new Set([spaceId, ...this.descendants(spaceId).map((n) => n.id)]);
    return this.annotations.filter((a) => ids.has(a.spaceId));
  }

  // ------------------------------------------------------------ views

  currentView(): { camera: CameraState; hiddenSpaceIds: string[]; floorFilter: string | null } {
    return {
      camera: this.viewer?.getCamera() ?? { position: [0, 0, 100], target: [0, 0, 0] },
      hiddenSpaceIds: [...this.hiddenSpaces],
      floorFilter: this.floorFilter,
    };
  }

  applyView(view: Pick<SavedView, 'camera' | 'hiddenSpaceIds' | 'floorFilter'>) {
    if (this.panoramaId) void this.closePanorama(false);
    this.hiddenSpaces.clear();
    for (const id of view.hiddenSpaceIds) this.hiddenSpaces.add(id);
    this.floorFilter = view.floorFilter;
    if (view.floorFilter) this.focusSpaceId = view.floorFilter;
    else this.focusSpaceId = this.root.id;
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
    if (view.hiddenSpaceIds.length) params.set('hide', view.hiddenSpaceIds.join(','));
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
