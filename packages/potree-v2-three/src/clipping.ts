import { Box3, Matrix4, Plane, Vector3 } from 'three';

/** `keep-inside` shows only points inside some keep box; `hide-inside` hides points inside the box. */
export type PotreeV2ClipBoxMode = 'keep-inside' | 'hide-inside';

export interface PotreeV2ClipBoxOptions {
  /** World transform of the unit cube from -0.5 to 0.5; copied into `box.matrix`. */
  matrix: Matrix4;
  mode: PotreeV2ClipBoxMode;
  /** Default: true. A disabled box is ignored, as if it were removed. */
  enabled?: boolean;
  /**
   * Skip loading and budgeting nodes this box hides entirely. Default: true.
   * With false, such nodes stay loaded and only drawing hides them, so they reappear
   * without loading when the box is disabled or moved.
   */
  prune?: boolean;
}

export interface PotreeV2ClipPlaneOptions {
  /** World-space plane; points on the side its normal points to are kept. Copied into `plane.plane`. */
  plane: Plane;
  /** Default: true. */
  enabled?: boolean;
  /** Skip loading and budgeting nodes entirely behind the plane. Default: true. */
  prune?: boolean;
}

export class PotreeV2ClipBox {
  readonly matrix = new Matrix4();
  mode: PotreeV2ClipBoxMode;
  enabled: boolean;
  prune: boolean;

  constructor(options: PotreeV2ClipBoxOptions) {
    this.matrix.copy(options.matrix);
    this.mode = options.mode;
    this.enabled = options.enabled ?? true;
    this.prune = options.prune ?? true;
  }
}

export class PotreeV2ClipPlane {
  readonly plane = new Plane();
  enabled: boolean;
  prune: boolean;

  constructor(options: PotreeV2ClipPlaneOptions) {
    this.plane.copy(options.plane);
    this.enabled = options.enabled ?? true;
    this.prune = options.prune ?? true;
  }
}

function assertBoxMatrix(matrix: Matrix4): void {
  const determinant = matrix.determinant();
  if (!Number.isFinite(determinant) || determinant === 0) {
    throw new Error('A clip box matrix must be invertible; its scale must not be zero');
  }
}

function assertPlane(plane: Plane): void {
  const { normal, constant } = plane;
  if (!Number.isFinite(constant) || !(normal.lengthSq() > 0) || !Number.isFinite(normal.lengthSq())) {
    throw new Error('A clip plane needs a non-zero, finite normal and a finite constant');
  }
}

/**
 * Clip boxes and planes in world space, shared by every cloud it is assigned to.
 * A point is visible when it is on the kept side of every plane, inside some keep box
 * (when any keep box is enabled), and inside no hide box. Changes to boxes and planes,
 * including their matrices and `enabled`, are picked up by the next `update()`.
 */
export class PotreeV2Clipping {
  private readonly boxList: PotreeV2ClipBox[] = [];
  private readonly planeList: PotreeV2ClipPlane[] = [];

  get boxes(): readonly PotreeV2ClipBox[] { return this.boxList; }
  get planes(): readonly PotreeV2ClipPlane[] { return this.planeList; }

  addBox(options: PotreeV2ClipBoxOptions): PotreeV2ClipBox {
    assertBoxMatrix(options.matrix);
    const box = new PotreeV2ClipBox(options);
    this.boxList.push(box);
    return box;
  }

  addPlane(options: PotreeV2ClipPlaneOptions): PotreeV2ClipPlane {
    assertPlane(options.plane);
    const plane = new PotreeV2ClipPlane(options);
    this.planeList.push(plane);
    return plane;
  }

  remove(clip: PotreeV2ClipBox | PotreeV2ClipPlane): boolean {
    const list: (PotreeV2ClipBox | PotreeV2ClipPlane)[] = clip instanceof PotreeV2ClipBox ? this.boxList : this.planeList;
    const index = list.indexOf(clip);
    if (index < 0) return false;
    list.splice(index, 1);
    return true;
  }

  clear(): void {
    this.boxList.length = 0;
    this.planeList.length = 0;
  }
}

/**
 * Append everything a clipping snapshot depends on, so an update can tell whether
 * any box, plane or the cloud's transform changed since the last traversal.
 */
export function appendClippingKey(clipping: PotreeV2Clipping, groupMatrix: Matrix4, out: number[]): void {
  out.push(...groupMatrix.elements);
  for (const box of clipping.boxes) {
    out.push(box.enabled ? 1 : 0, box.mode === 'keep-inside' ? 1 : 0, box.prune ? 1 : 0, ...box.matrix.elements);
  }
  // Separates boxes from planes, so moving a clip between the lists changes the key.
  out.push(NaN);
  for (const { plane, enabled, prune } of clipping.planes) {
    out.push(enabled ? 1 : 0, prune ? 1 : 0, plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
  }
}

/** Keys compare with Object.is so the NaN separator matches itself. */
export function sameKey(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

/** A plane in the cloud's local space; points with a negative distance are clipped. */
export interface PlaneClip { plane: Plane; prune: boolean }

/** A box as the transform from the cloud's local space into its unit cube, with its local bounds. */
export interface BoxClip { fromCloud: Matrix4; bounds: Box3; prune: boolean }

/**
 * The clips a node's points still have to be tested against. Clips that keep or miss the
 * whole node are dropped, so descendants only test the clips that cut through them.
 */
export interface NodeClip {
  planes: PlaneClip[];
  /** Keep boxes crossing the node; null when no keep test is needed. */
  keep: BoxClip[] | null;
  hide: BoxClip[];
  /** Every point is hidden, but a clip with prune: false keeps the node in the budget. */
  hidden: boolean;
}

export const NO_CLIP: NodeClip = { planes: [], keep: null, hide: [], hidden: false };
const HIDDEN_CLIP: NodeClip = { planes: [], keep: null, hide: [], hidden: true };

/** Enabled clips of one cloud at one update, in the cloud's local space. */
export interface ClipSnapshot {
  root: NodeClip;
  /** A node outside every keep box is pruned only when every keep box prunes. */
  keepPrune: boolean;
}

const UNIT_CUBE = new Box3(new Vector3(-0.5, -0.5, -0.5), new Vector3(0.5, 0.5, 0.5));

/** Returns undefined when no clip is enabled. */
export function snapshotClipping(clipping: PotreeV2Clipping, groupMatrix: Matrix4): ClipSnapshot | undefined {
  const toCloud = groupMatrix.clone().invert();
  const planes: PlaneClip[] = [];
  const keep: BoxClip[] = [];
  const hide: BoxClip[] = [];
  let keepPrune = true;
  for (const { plane, enabled, prune } of clipping.planes) {
    if (!enabled) continue;
    assertPlane(plane);
    planes.push({ plane: plane.clone().applyMatrix4(toCloud), prune });
  }
  for (const box of clipping.boxes) {
    if (!box.enabled) continue;
    assertBoxMatrix(box.matrix);
    const boxToCloud = toCloud.clone().multiply(box.matrix);
    const clip: BoxClip = {
      fromCloud: boxToCloud.clone().invert(),
      bounds: UNIT_CUBE.clone().applyMatrix4(boxToCloud),
      prune: box.prune,
    };
    if (box.mode === 'keep-inside') {
      keep.push(clip);
      keepPrune &&= box.prune;
    } else {
      hide.push(clip);
    }
  }
  if (planes.length === 0 && keep.length === 0 && hide.length === 0) return undefined;
  return { root: { planes, keep: keep.length > 0 ? keep : null, hide, hidden: false }, keepPrune };
}

const enum Relation { Outside, Crossing, Inside }

const corner = new Vector3();
const localBounds = new Box3();

function boxRelation(clip: BoxClip, box: Box3): Relation {
  if (!clip.bounds.intersectsBox(box)) return Relation.Outside;
  localBounds.makeEmpty();
  let inside = true;
  for (let i = 0; i < 8; i++) {
    corner.set(
      i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z,
    ).applyMatrix4(clip.fromCloud);
    if (Math.abs(corner.x) > 0.5 || Math.abs(corner.y) > 0.5 || Math.abs(corner.z) > 0.5) inside = false;
    localBounds.expandByPoint(corner);
  }
  if (inside) return Relation.Inside;
  // Both bounds tests are conservative, so an oriented box may still count as crossing.
  return localBounds.intersectsBox(UNIT_CUBE) ? Relation.Crossing : Relation.Outside;
}

/** Inside: the whole box is kept. Outside: the whole box is clipped. */
function planeRelation({ normal, constant }: Plane, box: Box3): Relation {
  const cx = (box.min.x + box.max.x) / 2, ex = (box.max.x - box.min.x) / 2;
  const cy = (box.min.y + box.max.y) / 2, ey = (box.max.y - box.min.y) / 2;
  const cz = (box.min.z + box.max.z) / 2, ez = (box.max.z - box.min.z) / 2;
  const distance = normal.x * cx + normal.y * cy + normal.z * cz + constant;
  const reach = Math.abs(normal.x) * ex + Math.abs(normal.y) * ey + Math.abs(normal.z) * ez;
  if (distance - reach >= 0) return Relation.Inside;
  if (distance + reach < 0) return Relation.Outside;
  return Relation.Crossing;
}

/**
 * Narrow the parent's clips to a node's box (in the cloud's local space). Returns null
 * when the node is hidden entirely by a pruning clip and should not be traversed.
 */
export function clipNode(parent: NodeClip, box: Box3, keepPrune: boolean): NodeClip | null {
  if (parent.hidden) return parent;
  let hidden = false;
  const planes: PlaneClip[] = [];
  for (const clip of parent.planes) {
    const relation = planeRelation(clip.plane, box);
    if (relation === Relation.Crossing) planes.push(clip);
    else if (relation === Relation.Outside) {
      if (clip.prune) return null;
      hidden = true;
    }
  }
  const hide: BoxClip[] = [];
  for (const clip of parent.hide) {
    const relation = boxRelation(clip, box);
    if (relation === Relation.Crossing) hide.push(clip);
    else if (relation === Relation.Inside) {
      if (clip.prune) return null;
      hidden = true;
    }
  }
  let keep: BoxClip[] | null = null;
  if (parent.keep) {
    keep = [];
    for (const clip of parent.keep) {
      const relation = boxRelation(clip, box);
      if (relation === Relation.Inside) { keep = null; break; }
      if (relation === Relation.Crossing) keep.push(clip);
    }
    if (keep?.length === 0) {
      if (keepPrune) return null;
      hidden = true;
    }
  }
  if (hidden) return HIDDEN_CLIP;
  if (planes.length === 0 && hide.length === 0 && keep === null) return NO_CLIP;
  return { planes, keep, hide, hidden: false };
}

export function clipBoxCount(clip: NodeClip): number {
  return (clip.keep?.length ?? 0) + clip.hide.length;
}

/**
 * Vertex shader declarations shared by drawing and picking. POTREE_CLIP_BOXES and
 * POTREE_CLIP_PLANES are the per-node capacities; 0 compiles the test out.
 */
export const clipVertexPars = /* glsl */`
#if POTREE_CLIP_PLANES > 0
uniform vec4 potreeClipPlanes[POTREE_CLIP_PLANES];
uniform int potreeClipPlaneCount;
#endif
#if POTREE_CLIP_BOXES > 0
// Rows of node-local to unit-cube affine transforms: keep boxes first, then hide boxes.
uniform vec4 potreeClipBoxes[POTREE_CLIP_BOXES * 3];
uniform int potreeClipKeepCount;
uniform int potreeClipBoxCount;
#endif
bool potreeClipped(vec3 p) {
#if POTREE_CLIP_PLANES > 0
  for (int i = 0; i < POTREE_CLIP_PLANES; i++) {
    if (i >= potreeClipPlaneCount) break;
    if (dot(potreeClipPlanes[i].xyz, p) + potreeClipPlanes[i].w < 0.0) return true;
  }
#endif
#if POTREE_CLIP_BOXES > 0
  bool kept = potreeClipKeepCount == 0;
  vec4 h = vec4(p, 1.0);
  for (int i = 0; i < POTREE_CLIP_BOXES; i++) {
    if (i >= potreeClipBoxCount) break;
    vec3 q = vec3(dot(potreeClipBoxes[i * 3], h), dot(potreeClipBoxes[i * 3 + 1], h), dot(potreeClipBoxes[i * 3 + 2], h));
    if (all(lessThanEqual(abs(q), vec3(0.5)))) {
      if (i >= potreeClipKeepCount) return true;
      kept = true;
    }
  }
  return !kept;
#else
  return false;
#endif
}
`;

/** Moves a clipped point outside the clip volume after gl_Position is set, so it is not drawn. */
export const clipVertex = /* glsl */`
if (potreeClipped(position)) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
`;

export interface ClipCapacity { boxes: number; planes: number }

type ClipUniformValues = {
  potreeClipPlanes: { value: Float32Array };
  potreeClipPlaneCount: { value: number };
  potreeClipBoxes: { value: Float32Array };
  potreeClipKeepCount: { value: number };
  potreeClipBoxCount: { value: number };
};

/**
 * One material's clip uniforms. `write` converts a node's clips into its node-local
 * space: node positions are relative to `origin` (the node's minimum in the cloud).
 */
export class ClipUniforms {
  readonly capacity: ClipCapacity = { boxes: 0, planes: 0 };
  readonly uniforms: ClipUniformValues = {
    potreeClipPlanes: { value: new Float32Array(0) },
    potreeClipPlaneCount: { value: 0 },
    potreeClipBoxes: { value: new Float32Array(0) },
    potreeClipKeepCount: { value: 0 },
    potreeClipBoxCount: { value: 0 },
  };
  private lastClip?: NodeClip;
  private lastOrigin?: Vector3;

  get defines(): Record<string, number> {
    return { POTREE_CLIP_BOXES: this.capacity.boxes, POTREE_CLIP_PLANES: this.capacity.planes };
  }

  /** Returns true when the capacity changed and the shader has to be recompiled. */
  resize(capacity: ClipCapacity): boolean {
    if (capacity.boxes === this.capacity.boxes && capacity.planes === this.capacity.planes) return false;
    this.capacity.boxes = capacity.boxes;
    this.capacity.planes = capacity.planes;
    this.uniforms.potreeClipBoxes.value = new Float32Array(capacity.boxes * 12);
    this.uniforms.potreeClipPlanes.value = new Float32Array(capacity.planes * 4);
    this.lastClip = undefined;
    return true;
  }

  /** Returns true when the uniforms changed and have to be uploaded. */
  write(clip: NodeClip, origin: Vector3): boolean {
    if (this.capacity.boxes === 0 && this.capacity.planes === 0) return false;
    // Uniforms without clips do not depend on the node's origin.
    const empty = clip.planes.length === 0 && clip.hide.length === 0 && clip.keep === null;
    if (clip === this.lastClip && (origin === this.lastOrigin || empty)) return false;
    this.lastClip = clip;
    this.lastOrigin = origin;
    const { uniforms } = this;
    const planes = uniforms.potreeClipPlanes.value;
    const planeCount = Math.min(clip.planes.length, this.capacity.planes);
    for (let i = 0; i < planeCount; i++) {
      const { normal, constant } = clip.planes[i]!.plane;
      planes[i * 4] = normal.x;
      planes[i * 4 + 1] = normal.y;
      planes[i * 4 + 2] = normal.z;
      planes[i * 4 + 3] = constant + normal.x * origin.x + normal.y * origin.y + normal.z * origin.z;
    }
    uniforms.potreeClipPlaneCount.value = planeCount;
    const boxes = uniforms.potreeClipBoxes.value;
    const keep = clip.keep ?? [];
    const list = [...keep, ...clip.hide];
    const boxCount = Math.min(list.length, this.capacity.boxes);
    for (let i = 0; i < boxCount; i++) {
      // fromCloud × translate(origin), composed in double precision; elements are column-major.
      const e = list[i]!.fromCloud.elements;
      for (let row = 0; row < 3; row++) {
        const at = (i * 3 + row) * 4;
        boxes[at] = e[row]!;
        boxes[at + 1] = e[4 + row]!;
        boxes[at + 2] = e[8 + row]!;
        boxes[at + 3] = e[row]! * origin.x + e[4 + row]! * origin.y + e[8 + row]! * origin.z + e[12 + row]!;
      }
    }
    uniforms.potreeClipKeepCount.value = Math.min(keep.length, boxCount);
    uniforms.potreeClipBoxCount.value = boxCount;
    return true;
  }
}

/**
 * Capacity large enough for `needed`, growing in powers of two. The first clip allocates
 * room for 16 boxes and 8 planes at once, so typical use compiles the clip test only once.
 */
export function grownCapacity(current: ClipCapacity, needed: ClipCapacity): ClipCapacity {
  const first = current.boxes === 0 && current.planes === 0 && (needed.boxes > 0 || needed.planes > 0);
  const grow = (have: number, need: number, minimum: number) => {
    if (first) need = Math.max(need, minimum);
    if (need <= have) return have;
    let next = Math.max(have, minimum);
    while (next < need) next *= 2;
    return next;
  };
  return { boxes: grow(current.boxes, needed.boxes, 16), planes: grow(current.planes, needed.planes, 8) };
}
