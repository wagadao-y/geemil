import {
  BoxGeometry,
  Camera,
  EdgesGeometry,
  Frustum,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Object3D,
  Points,
  Sphere,
  Vector3,
} from 'three';
import type { Box3, OrthographicCamera, PerspectiveCamera, WebGLRenderer } from 'three';
import { attributeNormalization, DEFAULT_DECODED_ATTRIBUTES, nodeOrigin } from './decode.js';
import type { DecodedBatchNode, DecodedNodeData } from './decode.js';
import type { NodeDecodeTiming } from './decode.js';
import { DecoderPool } from './decoder-pool.js';
import { makeNodeBatches } from './batches.js';
import type { NodeBatch } from './batches.js';
import type { EncodedNodeCache } from './encoded-cache.js';
import { createNodeGeometry } from './node-geometry.js';
import { createRoot, parseHierarchyChunk, validateMetadata } from './format.js';
import type { OctreeNode, PotreeV2Metadata } from './format.js';
import { fetchRange, responseError } from './http.js';
import { isThrottled, RequestGate, sleep } from './request-gate.js';
import { LoadWaiters } from './load-waiters.js';
import { PointPicker } from './picking.js';
import type { PickHit, PickLayer, PickTarget } from './picking.js';
import { PotreeV2PointMaterial } from './material.js';
import type { PotreeV2PointMaterialOptions } from './material.js';
import { colorTypeAttribute } from './point-color.js';
import type { PotreeV2PointColorType } from './point-color.js';
import { pointOccupancy } from './occupancy.js';
import { nodeExtent, occupancyLevelOffset, VisibleNodesTexture } from './point-size.js';
import {
  appendClippingKey,
  clipBoxCount,
  clipNode,
  grownCapacity,
  NO_CLIP,
  sameKey,
  snapshotClipping,
} from './clipping.js';
import type { ClipSnapshot, NodeClip, PotreeV2Clipping } from './clipping.js';

export interface PotreeV2Options {
  /** Minimum projected node radius in pixels for loading children. Default: 30, as in Potree. */
  minNodePixelSize?: number;
  /**
   * Decoder Workers. All clouds share one pool, sized by the largest request among
   * live clouds. Default: hardwareConcurrency - 1, between 1 and 4.
   */
  decoderWorkers?: number;
  /**
   * Keep this cloud's octree payloads in its PotreeV2PointCloudSet's encoded cache, so that
   * evicted nodes are decoded again without another request. Default: true for BROTLI URLs,
   * false for DEFAULT, whose payloads are as large as the decoded points, and for local files.
   */
  cacheEncodedNodes?: boolean;
  /** Initial `material` settings, named as its properties. */
  material?: PotreeV2PointMaterialOptions;
  /** Show boxes around currently displayed nodes. Default: false. */
  showBoundingBoxes?: boolean;
  /** Clip boxes and planes; one PotreeV2Clipping can be shared by several clouds. Default: null. */
  clipping?: PotreeV2Clipping | null;
  /**
   * metadata.json attribute names to decode and upload as geometry attributes.
   * `position` and the attribute of `material.colorType` are always decoded. Default: `['position', 'rgb']` (rgb only when present).
   */
  attributes?: string[];
  /**
   * Delay before retrying a failed load; doubles per failure up to 30 s. Default: 1000.
   * Also the first pause of the origin after a 429 or 503 without Retry-After.
   */
  retryDelayMs?: number;
  /** Override fetch, for authenticated or custom transports. */
  fetch?: typeof fetch;
  /**
   * Abandons loadPotreeV2() and loadPotreeV2FromFiles(): pending requests are aborted, the
   * partly loaded cloud is disposed and the promise rejects with the signal's reason.
   * Aborting after the promise resolved has no effect; dispose() the cloud instead.
   */
  signal?: AbortSignal;
  /**
   * Receives asynchronous errors from update-triggered loads. Throttled responses
   * (429, 503) are not reported: they pause requests to the origin and are retried.
   */
  onError?: (error: Error, node: string) => void;
}

/**
 * For measurement and debugging, such as the playground's statistics. Unstable: its fields may
 * change in any release, without a major version.
 */
export interface PotreeV2FetchStats {
  /** Successfully fetched and decoded octree Range batches. */
  rangeRequests: number;
  /** Nodes included in those batches; encoded-cache hits are excluded. */
  fetchedNodes: number;
}

/**
 * For measurement and debugging, such as the playground's statistics. Unstable: its fields may
 * change in any release, without a major version.
 */
export interface PotreeV2LoadDiagnostics {
  state: 'loading' | 'complete';
  seconds: number;
  requiredNodes: number;
  decodedNodes: number;
  pendingSceneNodes: number;
  decodedReadySeconds: number | null;
  sceneReadySeconds: number | null;
  lastSceneConversionSeconds: number | null;
  sceneConversions: number;
  startedBatches: number;
  completedBatches: number;
  loadedNodes: number;
  activeBatches: number;
  lastBatchDoneSeconds: number | null;
  hierarchyStarted: number;
  hierarchyCompleted: number;
  hierarchyMs: number;
  fetchMs: number;
  codecSetupMs: number;
  brotliMs: number;
  attributesMs: number;
  fetchedBytes: number;
  /** 429 and 503 responses to hierarchy and octree requests. */
  throttledResponses: number;
  /** Octree requests aborted because the view no longer needed any of their nodes. */
  abortedRequests: number;
}

export interface PotreeV2PickOptions {
  /**
   * Also accept points drawn within this many CSS pixels of the position.
   * Default: 0, only a point drawn under that pixel.
   */
  radius?: number;
}

export interface PotreeV2PickResult {
  /** The cloud of the point; with a PotreeV2PointCloudSet's pick(), any of its clouds. */
  cloud: PotreeV2PointCloud;
  /** Octree node name, such as `r024`. */
  node: string;
  /** Point index within the node. */
  index: number;
  /** Position in world space, including `group`'s transform. */
  position: Vector3;
  /** Position in the metadata.json coordinate system. */
  sourcePosition: [number, number, number];
  /**
   * Other decoded attributes by metadata.json name, read from the geometry. `rgb` holds 0–255
   * values. 64-bit scalars, normalized for the GPU, are mapped back to metadata.json's range,
   * so they approximate the source values to about 1e-7 of that range.
   */
  attributes: Record<string, number[]>;
  /** Distance from the requested position to the hit pixel, in CSS pixels. */
  distance: number;
}

function emptyDiagnostics(): PotreeV2LoadDiagnostics {
  return {
    state: 'loading',
    seconds: 0,
    requiredNodes: 0,
    decodedNodes: 0,
    pendingSceneNodes: 0,
    decodedReadySeconds: null,
    sceneReadySeconds: null,
    lastSceneConversionSeconds: null,
    sceneConversions: 0,
    startedBatches: 0,
    completedBatches: 0,
    loadedNodes: 0,
    activeBatches: 0,
    lastBatchDoneSeconds: null,
    hierarchyStarted: 0,
    hierarchyCompleted: 0,
    hierarchyMs: 0,
    fetchMs: 0,
    codecSetupMs: 0,
    brotliMs: 0,
    attributesMs: 0,
    fetchedBytes: 0,
    throttledResponses: 0,
    abortedRequests: 0,
  };
}

type NodeState = {
  points?: Points;
  boxHelper?: LineSegments;
  loading?: Promise<void>;
  queued?: boolean;
  /** Consecutive failed loads; cleared by a successful load. */
  failures: number;
  /** performance.now() before which a failed node is not requested again. */
  retryAt: number;
  /** Update stamp when the node was last installed or displayed; orders eviction across clouds. */
  displayedAt: number;
};

const MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 1000;
/** An octree request still fetching is aborted once none of its nodes was selected for this long. */
const STALE_REQUEST_MS = 300;
/** A view counts as loaded once all its nodes stayed in the scene this long. */
const LOAD_COMPLETE_MS = 500;
/** Poll interval while load() waits for room in the decoder backlog. */
const BACKLOG_POLL_MS = 16;
/** Attempts for requests made by load(), which no update loop retries. */
const LOAD_ATTEMPTS = 6;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function defaultDecoderWorkers(): number {
  const cores = globalThis.navigator?.hardwareConcurrency;
  return Math.min(4, Math.max(1, (cores ?? 4) - 1));
}

function resolveDecodedAttributes(
  metadata: PotreeV2Metadata,
  requested?: string[],
  colorType?: PotreeV2PointColorType,
): string[] {
  const available = new Set(metadata.attributes.map((a) => a.name));
  const colorAttribute = colorType && colorTypeAttribute(colorType);
  for (const name of [...(requested ?? []), ...(colorAttribute ? [colorAttribute] : [])]) {
    if (!available.has(name)) throw new Error(`Potree v2 metadata has no attribute: ${name}`);
  }
  const names = new Set([
    'position',
    ...(requested ?? DEFAULT_DECODED_ATTRIBUTES),
    ...(colorAttribute ? [colorAttribute] : []),
  ]);
  return [...names].filter((name) => available.has(name));
}

function defaultIntensityRange(metadata: PotreeV2Metadata): [number, number] {
  const attribute = metadata.attributes.find((a) => a.name === 'intensity');
  const min = attribute?.min?.[0];
  const max = attribute?.max?.[0];
  return min !== undefined &&
    max !== undefined &&
    Number.isFinite(min) &&
    Number.isFinite(max) &&
    max > min
    ? [min, max]
    : [0, 65535];
}

/** One cloud's part of an update that may traverse several clouds together. */
type Traversal = {
  cloud: PotreeV2PointCloud;
  /** Enabled clips at this update; undefined when nothing is clipped. */
  clip?: ClipSnapshot;
  selected: Set<OctreeNode>;
  /**
   * Selected nodes without points. The converter may move every point of a sparse node
   * to its ancestors; as in Potree, adaptive sizes still count the node as displayed.
   */
  empty: OctreeNode[];
  pending: OctreeNode[];
  hierarchyPending: number;
  sceneReady: boolean;
};

type Candidate = { node: OctreeNode; pixels: number; traversal: Traversal; clip: NodeClip };

/** Incremented by every traversing update, shared by all clouds so their LRU orders compare. */
let displayStamp = 0;

/**
 * What a PotreeV2PointCloudSet shares with its clouds.
 * @internal
 */
export interface CloudSetMembership {
  remove(cloud: PotreeV2PointCloud): boolean;
  /** Encoded payloads of every member that caches encoded nodes. */
  readonly encodedCache: EncodedNodeCache;
}

/**
 * Clouds that belong to a PotreeV2PointCloudSet, which owns their updates and budgets.
 * @internal
 */
export const cloudSets = new WeakMap<PotreeV2PointCloud, CloudSetMembership>();

/**
 * Network requests in progress for the clouds that share it; each request returns its slot here.
 * @internal
 */
export class LoadSlots {
  inFlight = 0;
}

/**
 * Budgets and limits of one update, shared by the clouds it traverses.
 * @internal
 */
export interface UpdateLimits {
  pointBudget: number;
  cachePointBudget: number;
  maxConcurrentLoads: number;
  maxNodesToGPUPerFrame: number;
  slots: LoadSlots;
}

/** PotreeV2PointCloud's private loader, for loadPotreeV2(). */
let loadPointCloud: (
  metadataUrl: string | URL,
  options: PotreeV2Options,
) => Promise<PotreeV2PointCloud>;

/**
 * Select, load and evict nodes of `clouds` under `limits`. `force` traverses even
 * when every cloud's view and settings are unchanged.
 * @internal
 */
export let updatePointClouds: (
  clouds: readonly PotreeV2PointCloud[],
  camera: Camera,
  viewportHeight: number,
  limits: UpdateLimits,
  force: boolean,
) => boolean;

/**
 * Pick the nearest point drawn by any of `clouds`; see PotreeV2PointCloud.pick().
 * @internal
 */
export let pickPointClouds: (
  clouds: readonly PotreeV2PointCloud[],
  renderer: WebGLRenderer,
  camera: Camera,
  x: number,
  y: number,
  options: PotreeV2PickOptions,
) => Promise<PotreeV2PickResult | null>;

/** A decoded node waiting for installation; `rank` is scratch space for installDecodedNodes. */
type DecodedQueueItem = {
  node: OctreeNode;
  attributes: DecodedNodeData;
  occupancy?: number;
  rank: number;
};

/** An octree batch a cloud could request now; `rank` orders plans across clouds. */
type BatchPlan = {
  cloud: PotreeV2PointCloud;
  nodes: OctreeNode[];
  rank: number;
  /** Decoded from the encoded cache as one job, without a request. Otherwise one octree range. */
  cached: boolean;
};

/** Nodes of the encoded cache decoded as one job, as many as a range batch holds at most. */
const MAX_CACHED_PLAN_NODES = 16;

/** Bound on decoded nodes of the clouds updated together, waiting for installation, before they stop requesting more. */
const MAX_DECODED_QUEUE = 32;

/** An octree batch request that may be aborted while its bytes are still arriving. */
type BatchRequest = { nodes: OctreeNode[]; controller: AbortController; wantedAt: number };

/** Largest projected nodes first, without sorting the entire frontier on each pop. */
class CandidateHeap {
  private readonly items: Candidate[] = [];

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }

  push(item: Candidate): void {
    let index = this.items.length;
    this.items.push(item);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent]!.pixels >= item.pixels) break;
      this.items[index] = this.items[parent]!;
      index = parent;
    }
    this.items[index] = item;
  }

  pop(): Candidate {
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length === 0) return top;
    let index = 0;
    while (index * 2 + 1 < this.items.length) {
      let child = index * 2 + 1;
      if (
        child + 1 < this.items.length &&
        this.items[child + 1]!.pixels > this.items[child]!.pixels
      )
        child++;
      if (last.pixels >= this.items[child]!.pixels) break;
      this.items[index] = this.items[child]!;
      index = child;
    }
    this.items[index] = last;
    return top;
  }
}

/** Reused by every update; updates run synchronously and clear it before returning. */
const sharedCandidates = new CandidateHeap();

/** Unit box edges and their material, shared by the bounding boxes of every cloud. */
type BoxResources = { geometry: EdgesGeometry; material: LineBasicMaterial; references: number };
let boxResources: BoxResources | undefined;

/** Take the shared box resources, created on first use; give them back with releaseBoxResources(). */
function acquireBoxResources(): BoxResources {
  if (!boxResources) {
    const unitBox = new BoxGeometry(1, 1, 1);
    // Both points and box edges are opaque depth-tested geometry. Box edges
    // must write depth even when Three.js sorts their material before points.
    boxResources = {
      geometry: new EdgesGeometry(unitBox),
      material: new LineBasicMaterial({
        color: 0x58dfd2,
        toneMapped: false,
        depthTest: true,
        depthWrite: true,
      }),
      references: 0,
    };
    unitBox.dispose();
  }
  boxResources.references++;
  return boxResources;
}

/** The last release disposes the shared box resources. */
function releaseBoxResources(resources: BoxResources): void {
  if (--resources.references > 0) return;
  if (boxResources === resources) boxResources = undefined;
  resources.geometry.dispose();
  resources.material.dispose();
}

/**
 * A camera-driven, additive LOD Potree v2 point cloud. Add `group` to a Three.js scene and the
 * cloud to a PotreeV2PointCloudSet, whose update() selects and loads its nodes.
 */
export class PotreeV2PointCloud {
  readonly group = new Group();
  /** @internal */
  readonly root: OctreeNode;
  readonly metadata: PotreeV2Metadata;
  readonly material: PotreeV2PointMaterial;

  minNodePixelSize: number;
  showBoundingBoxes: boolean;
  /** Clip boxes and planes applied to drawing, picking and node selection from the next update(). */
  clipping: PotreeV2Clipping | null;
  retryDelayMs: number;
  onError?: (error: Error, node: string) => void;

  private readonly metadataUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly decodedAttributes: string[];
  /** Nodes with load, queue or retry state. Idle entries are removed. */
  private readonly states = new Map<OctreeNode, NodeState>();
  /** Nodes installed in the scene, least recently displayed first. */
  private readonly installed = new Map<OctreeNode, NodeState>();
  private displayed = new Set<OctreeNode>();
  /** Displayed nodes for adaptive point sizes. */
  private readonly visibleNodes = new VisibleNodesTexture();
  /** Nodes in visibleNodes: the displayed ones and the selected empty ones. */
  private lodNodes = new Set<OctreeNode>();
  /** Density level offsets of installed nodes, for adaptive point sizes. */
  private readonly levelOffsets = new Map<OctreeNode, number>();
  /** Decoded nodes waiting for installation; `rank` is scratch space for installDecodedNodes. */
  private readonly decodedQueue: DecodedQueueItem[] = [];
  private readonly controller = new AbortController();
  private decoder: DecoderPool;
  private cachesEncodedNodes: boolean;
  /** Shared bounding box edges, taken when the first box is shown. */
  private boxResources?: BoxResources;
  private readonly decoderWorkers: number;
  /** This cloud's network requests in progress; a batch releases its slot once its bytes arrive. */
  private inFlight = 0;
  /** Batches started by requestBatches that have not finished fetching and decoding. */
  private activeLoads = 0;
  private activeDecodeBatches = 0;
  /** Inputs of the last full update; reused when the view and settings are unchanged. */
  private readonly lastView = new Matrix4();
  private lastViewportHeight = 0;
  private lastPointBudget = NaN;
  private lastCachePointBudget = NaN;
  private lastMinNodePixelSize = NaN;
  private lastShowBoundingBoxes = false;
  /** `group.layers` last given to the node objects. */
  private layersMask = this.group.layers.mask;
  /** `group` and all its ancestors were visible at the last update. */
  private shown = true;
  private lastClipping: PotreeV2Clipping | null = null;
  /** Clip state of the last traversal, compared to decide whether to traverse again. */
  private lastClipKey: number[] = [];
  private clipKey: number[] = [];
  /** Clips changed at this update, so the shaders draw differently even if no node does. */
  private clipChanged = false;
  /** Clips of the nodes selected by the last traversal; nodes without clips are absent. */
  private nodeClips = new Map<OctreeNode, NodeClip>();
  /** Every selected node is in the scene and no load or installation is pending. */
  private settled = false;
  /** Scratch objects reused by every traversal. */
  private readonly projection = new Matrix4();
  private readonly frustum = new Frustum();
  private readonly cameraPosition = new Vector3();
  private readonly projectedSphere = new Sphere();
  /** Position of each node in the last selection; lower is more important. */
  private readonly selectionRank = new Map<OctreeNode, number>();
  /** Octree batch requests whose bytes have not arrived yet. */
  private readonly fetchingRequests = new Set<BatchRequest>();
  private cachedPoints = 0;
  private readonly fetchStatsState: PotreeV2FetchStats = { rangeRequests: 0, fetchedNodes: 0 };
  private fetchStatsGeneration = 0;
  private diagnosticsState = emptyDiagnostics();
  private diagnosticsGeneration = 0;
  private diagnosticsStartedAt = performance.now();
  private sceneReadySince: number | null = null;
  private requiredLastFrame = new Set<OctreeNode>();
  private picker?: PointPicker;
  private readonly loadWaiters = new LoadWaiters();
  /** Admission shared with every cloud from the same origin. */
  private readonly gate: RequestGate;
  private disposed = false;

  private constructor(url: URL, metadata: PotreeV2Metadata, options: PotreeV2Options) {
    const material = options.material ?? {};
    this.decodedAttributes = resolveDecodedAttributes(
      metadata,
      options.attributes,
      material.colorType,
    );
    this.metadataUrl = url;
    this.metadata = metadata;
    this.root = createRoot(metadata);
    this.fetcher = options.fetch ?? fetch;
    this.cachesEncodedNodes = options.cacheEncodedNodes ?? metadata.encoding === 'BROTLI';
    this.minNodePixelSize = options.minNodePixelSize ?? 30;
    this.decoderWorkers = Math.max(
      1,
      Math.floor(options.decoderWorkers ?? defaultDecoderWorkers()),
    );
    this.showBoundingBoxes = options.showBoundingBoxes ?? false;
    this.clipping = options.clipping ?? null;
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.gate = RequestGate.for(url);
    this.onError = options.onError;
    this.material = new PotreeV2PointMaterial(
      {
        ...material,
        colorType:
          material.colorType ?? (this.decodedAttributes.includes('rgb') ? 'rgb' : 'elevation'),
        elevationRange: material.elevationRange ?? [
          metadata.boundingBox.min[2],
          metadata.boundingBox.max[2],
        ],
        intensityRange: material.intensityRange ?? defaultIntensityRange(metadata),
      },
      {
        spacing: metadata.spacing,
        visibleNodes: this.visibleNodes,
        attributes: this.decodedAttributes,
        sourceOriginZ: metadata.boundingBox.min[2],
      },
    );
    this.group.name = metadata.name ?? 'Potree v2 point cloud';
    // Last, so that options rejected above, such as an empty gradient, leave no Workers behind.
    this.decoder = DecoderPool.acquire(this.decoderWorkers);
    // Workers and the WASM decoder start while the first hierarchy chunk is fetched.
    this.decoder.warm(metadata.encoding === 'BROTLI');
  }

  /**
   * The octree's bounding box in `group`'s local space, from the origin to the size of
   * metadata.json's bounding box. A new copy on each call.
   */
  get boundingBox(): Box3 {
    return this.root.box.clone();
  }

  /** metadata.json position of `group`'s local origin, the bounding box minimum. A new copy on each call. */
  get worldOffset(): Vector3 {
    return new Vector3(...this.metadata.boundingBox.min);
  }

  /**
   * Whether this cloud keeps octree payloads in its set's encoded cache; see the option of the
   * same name. Setting false drops its entries there.
   */
  get cacheEncodedNodes(): boolean {
    return this.cachesEncodedNodes;
  }
  set cacheEncodedNodes(value: boolean) {
    this.cachesEncodedNodes = value;
    if (!value) cloudSets.get(this)?.encodedCache.deleteOwner(this);
  }

  /** The cache this cloud reads and stores encoded nodes in, or undefined when it caches none. */
  private get encodedCache(): EncodedNodeCache | undefined {
    if (!this.cachesEncodedNodes) return undefined;
    const cache = cloudSets.get(this)?.encodedCache;
    // A set may disable its cache; then no payload is copied for it.
    return cache && cache.maxBytes > 0 ? cache : undefined;
  }

  /**
   * Traverse at the next update even if the view and budgets are unchanged, as when the cloud
   * joins or leaves a set: its last selection was made under another budget, or none.
   * @internal
   */
  invalidateSelection(): void {
    this.settled = false;
  }

  /** Cumulative successful octree range loads since construction or the last clear. Unstable, see PotreeV2FetchStats. */
  get fetchStats(): PotreeV2FetchStats {
    return { ...this.fetchStatsState };
  }

  /** Reset counters without counting batches already in progress. */
  clearFetchStats(): void {
    this.fetchStatsGeneration++;
    this.fetchStatsState.rangeRequests = 0;
    this.fetchStatsState.fetchedNodes = 0;
  }

  /** Timings for the current view load, including Worker decode and scene installation. Unstable, see PotreeV2LoadDiagnostics. */
  get loadDiagnostics(): PotreeV2LoadDiagnostics {
    const seconds =
      this.diagnosticsState.state === 'loading'
        ? (performance.now() - this.diagnosticsStartedAt) / 1000
        : this.diagnosticsState.seconds;
    return { ...this.diagnosticsState, seconds, activeBatches: this.activeDecodeBatches };
  }

  /** Start a new measurement; current cache contents are retained. */
  resetLoadDiagnostics(): void {
    this.diagnosticsGeneration++;
    this.diagnosticsStartedAt = performance.now();
    this.diagnosticsState = emptyDiagnostics();
    this.sceneReadySince = null;
    this.requiredLastFrame.clear();
    // Measure the current view from the next update() on.
    this.settled = false;
  }

  /**
   * True until its set's update() finds every node it selected in the scene, with no hierarchy
   * chunk, range or decode of this cloud pending, and again from the next update() that needs
   * more. It is decided by update() alone, so it is true before the first one, including while
   * the cloud is in no set, and does not see a camera move until the next one. A node that keeps
   * failing keeps it true; see onError. A hidden cloud selects nothing, so it is loaded at once.
   * False once disposed.
   */
  get loading(): boolean {
    return !this.disposed && !this.settled;
  }

  /**
   * Resolves at the end of the next update() of its set after which `loading` is
   * false, for screenshots, tests or progress indicators. It waits for an update() even when
   * `loading` is already false, since the view may have changed since the last one. Rejects
   * with the signal's reason when `signal` aborts, and with an AbortError on dispose().
   */
  whenLoaded(options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.disposed)
      return Promise.reject(new DOMException('The point cloud was disposed', 'AbortError'));
    return this.loadWaiters.wait(options.signal);
  }

  private static async load(
    metadataUrl: string | URL,
    options: PotreeV2Options = {},
  ): Promise<PotreeV2PointCloud> {
    const url = new URL(String(metadataUrl), globalThis.location?.href);
    const fetcher = options.fetch ?? fetch;
    const gate = RequestGate.for(url);
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    const abortSignal = options.signal;
    abortSignal?.throwIfAborted();
    let metadata: PotreeV2Metadata;
    try {
      metadata = validateMetadata(
        await gate.retry(
          () =>
            gate.request(
              async () => {
                const response = await fetcher(url, { signal: abortSignal });
                if (!response.ok) throw await responseError(url, response);
                return response.json() as Promise<unknown>;
              },
              retryDelayMs,
              abortSignal,
            ),
          LOAD_ATTEMPTS,
          abortSignal,
        ),
      );
    } catch (error) {
      // The gate's own waits reject with a plain AbortError; report the caller's reason.
      abortSignal?.throwIfAborted();
      throw error;
    }
    abortSignal?.throwIfAborted();
    const cloud = new PotreeV2PointCloud(url, metadata, options);
    const signal = cloud.controller.signal;
    const abort = () => cloud.controller.abort(abortSignal!.reason);
    abortSignal?.addEventListener('abort', abort, { once: true });
    try {
      await gate.retry(() => cloud.loadHierarchy(cloud.root), LOAD_ATTEMPTS, signal);
      if (cloud.root.numPoints > 0) {
        await gate.retry(
          async () => {
            // Like update()'s batches, wait for room in the shared decoder backlog first.
            await cloud.waitForDecoderRoom(signal);
            const [failure] = await cloud.loadBatch([cloud.root]);
            if (failure) throw failure.error;
          },
          LOAD_ATTEMPTS,
          signal,
        );
        PotreeV2PointCloud.installDecodedNodes([cloud], Infinity);
      }
      abortSignal?.throwIfAborted();
      return cloud;
    } catch (error) {
      cloud.dispose();
      abortSignal?.throwIfAborted();
      throw error;
    } finally {
      abortSignal?.removeEventListener('abort', abort);
    }
  }

  private state(node: OctreeNode): NodeState {
    let state = this.states.get(node);
    if (!state) {
      state = { failures: 0, retryAt: 0, displayedAt: 0 };
      this.states.set(node, state);
    }
    return state;
  }

  /** Drop a state that no longer carries scene, load, queue or retry information. */
  private releaseState(node: OctreeNode, state: NodeState): void {
    if (state.points || state.boxHelper || state.loading || state.queued || state.failures > 0)
      return;
    if (this.states.get(node) === state) this.states.delete(node);
  }

  private waitingToRetry(state: NodeState): boolean {
    return state.failures > 0 && performance.now() < state.retryAt;
  }

  private noteFailure(state: NodeState): void {
    state.failures++;
    state.retryAt =
      performance.now() +
      Math.min(this.retryDelayMs * 2 ** (state.failures - 1), MAX_RETRY_DELAY_MS);
  }

  /**
   * Pass a load error to onError. An exception from onError is rethrown on its own, as an
   * event listener's is, so that it neither stops the caller's bookkeeping, such as the
   * retry delays of the other failed nodes, nor becomes an unhandled rejection of a load.
   */
  private reportError(error: unknown, node: string): void {
    try {
      this.onError?.(error instanceof Error ? error : new Error(String(error)), node);
    } catch (thrown) {
      queueMicrotask(() => {
        throw thrown;
      });
    }
  }

  private async loadHierarchy(node: OctreeNode): Promise<void> {
    if (node.hierarchyLoaded) return;
    const generation = this.diagnosticsGeneration;
    const startedAt = performance.now();
    this.diagnosticsState.hierarchyStarted++;
    const data = await this.fetchBytes(
      'hierarchy.bin',
      node.hierarchyByteOffset,
      node.hierarchyByteSize,
    );
    if (!this.disposed) parseHierarchyChunk(node, data);
    if (!this.disposed && generation === this.diagnosticsGeneration) {
      this.diagnosticsState.hierarchyCompleted++;
      this.diagnosticsState.hierarchyMs += performance.now() - startedAt;
    }
  }

  /** Fetch one byte range through the origin's gate. */
  private async fetchBytes(
    file: 'hierarchy.bin' | 'octree.bin',
    offset: bigint,
    size: bigint,
    signal = this.controller.signal,
  ): Promise<ArrayBuffer> {
    try {
      return await this.gate.request(
        () => fetchRange(new URL(file, this.metadataUrl), offset, size, this.fetcher, signal),
        this.retryDelayMs,
        signal,
      );
    } catch (error) {
      if (isThrottled(error) && !this.disposed) this.diagnosticsState.throttledResponses++;
      throw error;
    }
  }

  /**
   * The shared decoder pool. A pool whose Workers failed rejects every decode, so it is
   * exchanged for the current one; otherwise retries of this cloud could never succeed.
   */
  private liveDecoder(): DecoderPool {
    if (this.decoder.failed && !this.disposed) {
      this.decoder.release();
      this.decoder = DecoderPool.acquire(this.decoderWorkers);
      this.decoder.warm(this.metadata.encoding === 'BROTLI');
    }
    return this.decoder;
  }

  /**
   * Wait until the decoder pool's backlog has room. The pool is looked up again on every
   * check: a pool whose Workers fail while this waits is replaced, and the room must be
   * in the pool that will decode.
   */
  private async waitForDecoderRoom(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      if (!this.liveDecoder().full) return;
      await sleep(BACKLOG_POLL_MS, signal);
    }
  }

  private noteDecodeTiming(timing: NodeDecodeTiming, generation: number): void {
    if (this.disposed || generation !== this.diagnosticsGeneration) return;
    this.diagnosticsState.codecSetupMs += timing.setupMs;
    this.diagnosticsState.brotliMs += timing.brotliMs;
    this.diagnosticsState.attributesMs += timing.attributesMs;
  }

  /**
   * `onFetched` runs once every octree range of this load has arrived or failed.
   * `signal` aborts the ranges still being fetched; dispose() aborts them as well.
   * Returns the nodes that failed, with the error of their range or cache decode;
   * the other nodes are queued for installation even when some failed.
   */
  private async loadBatch(
    nodes: OctreeNode[],
    onFetched?: () => void,
    signal?: AbortSignal,
  ): Promise<{ nodes: OctreeNode[]; error: unknown }[]> {
    if (this.disposed || nodes.length === 0) {
      onFetched?.();
      return [];
    }
    const diagnosticsGeneration = this.diagnosticsGeneration;
    const cached: { node: OctreeNode; bytes: ArrayBuffer }[] = [];
    const missing: OctreeNode[] = [];
    for (const node of nodes) {
      const bytes = this.encodedCache?.get(node);
      if (bytes) cached.push({ node, bytes });
      else missing.push(node);
    }
    const batches = makeNodeBatches(missing);
    let fetching = batches.length;
    if (fetching === 0) onFetched?.();
    const fetched = () => {
      if (--fetching === 0) onFetched?.();
    };
    // Each task's results follow the order of its node list.
    const taskNodes = batches.map((batch) => batch.nodes);
    const tasks: Promise<DecodedBatchNode[]>[] = batches.map((batch) =>
      this.fetchAndDecodeBatch(batch, diagnosticsGeneration, fetched, signal),
    );
    if (cached.length > 0) {
      taskNodes.push(cached.map((item) => item.node));
      tasks.push(this.decodeCachedNodes(cached, diagnosticsGeneration));
    }
    // Wait for every task, so a failed range neither discards the others' nodes nor
    // releases the request slot while they are still fetching.
    const results = await Promise.allSettled(tasks);
    if (this.disposed) return [];
    const failures: { nodes: OctreeNode[]; error: unknown }[] = [];
    for (const [task, result] of results.entries()) {
      const expected = taskNodes[task]!;
      if (result.status === 'rejected') {
        failures.push({ nodes: expected, error: result.reason });
        continue;
      }
      const decoded = result.value;
      const unexpected = decoded.find((item, index) => expected[index]?.name !== item.name);
      if (unexpected) {
        failures.push({
          nodes: expected,
          error: new Error(`Unexpected decoded node ${unexpected.name}`),
        });
        continue;
      }
      for (const [index, item] of decoded.entries()) {
        const node = expected[index]!;
        this.state(node).queued = true;
        this.decodedQueue.push({
          node,
          attributes: item.attributes,
          occupancy: item.occupancy,
          rank: 0,
        });
      }
    }
    return failures;
  }

  private async fetchAndDecodeBatch(
    batch: NodeBatch,
    diagnosticsGeneration: number,
    onFetched: () => void,
    signal?: AbortSignal,
  ): Promise<DecodedBatchNode[]> {
    const statsGeneration = this.fetchStatsGeneration;
    const startedAt = performance.now();
    this.activeDecodeBatches++;
    if (diagnosticsGeneration === this.diagnosticsGeneration)
      this.diagnosticsState.startedBatches++;
    try {
      let bytes: ArrayBuffer;
      try {
        bytes = await this.fetchBytes('octree.bin', batch.start, batch.end - batch.start, signal);
      } finally {
        onFetched();
      }
      if (this.disposed) return [];
      if (diagnosticsGeneration === this.diagnosticsGeneration) {
        this.diagnosticsState.fetchMs += performance.now() - startedAt;
        this.diagnosticsState.fetchedBytes += bytes.byteLength;
      }
      // The batch buffer is transferred to the Worker. Keep only selected node
      // ranges, copied before the transfer, so gaps do not consume cache space.
      const encoded = this.encodedCache
        ? batch.nodes.map((node) => {
            const at = Number(node.byteOffset - batch.start);
            return bytes.slice(at, at + Number(node.byteSize));
          })
        : [];
      const decoded = await this.liveDecoder().decodeBatch(
        bytes,
        batch.start,
        batch.nodes.map((node) => ({
          name: node.name,
          pointCount: node.numPoints,
          offset: node.byteOffset,
          size: node.byteSize,
          origin: nodeOrigin(node),
          extent: nodeExtent(node.box),
        })),
        this.metadata,
        (timing) => this.noteDecodeTiming(timing, diagnosticsGeneration),
        this.decodedAttributes,
        this.controller.signal,
      );
      // Cached only once decoded, so that bytes which fail to decode are fetched again on retry.
      const cache = this.disposed ? undefined : this.encodedCache;
      if (cache) {
        for (const [index, node] of batch.nodes.entries()) {
          if (encoded[index]) cache.put(node, encoded[index], this);
        }
      }
      if (!this.disposed && statsGeneration === this.fetchStatsGeneration) {
        this.fetchStatsState.rangeRequests++;
        this.fetchStatsState.fetchedNodes += batch.nodes.length;
      }
      if (!this.disposed && diagnosticsGeneration === this.diagnosticsGeneration) {
        this.diagnosticsState.completedBatches++;
        this.diagnosticsState.loadedNodes += batch.nodes.length;
        this.diagnosticsState.lastBatchDoneSeconds =
          (performance.now() - this.diagnosticsStartedAt) / 1000;
      }
      return decoded;
    } finally {
      this.activeDecodeBatches--;
    }
  }

  private decodeCachedNodes(
    cached: { node: OctreeNode; bytes: ArrayBuffer }[],
    diagnosticsGeneration: number,
  ): Promise<DecodedBatchNode[]> {
    const size = cached.reduce((sum, item) => sum + item.bytes.byteLength, 0);
    const combined = new Uint8Array(size);
    const requests = [];
    let offset = 0;
    for (const { node, bytes } of cached) {
      combined.set(new Uint8Array(bytes), offset);
      requests.push({
        name: node.name,
        pointCount: node.numPoints,
        offset: BigInt(offset),
        size: BigInt(bytes.byteLength),
        origin: nodeOrigin(node),
        extent: nodeExtent(node.box),
      });
      offset += bytes.byteLength;
    }
    return this.liveDecoder().decodeBatch(
      combined.buffer,
      0n,
      requests,
      this.metadata,
      (timing) => this.noteDecodeTiming(timing, diagnosticsGeneration),
      this.decodedAttributes,
      this.controller.signal,
    );
  }

  /**
   * Turn up to `limit` decoded nodes of any cloud into scene objects, spreading geometry
   * creation across frames. Returns true when at least one node was added.
   */
  private static installDecodedNodes(
    clouds: readonly PotreeV2PointCloud[],
    limit: number,
  ): boolean {
    const waiting = clouds.filter((cloud) => cloud.decodedQueue.length > 0);
    const total = waiting.reduce((n, cloud) => n + cloud.decodedQueue.length, 0);
    if (total === 0) return false;
    if (total <= limit) {
      // Everything is installed this frame, so the order does not matter.
      for (const cloud of waiting) {
        while (cloud.decodedQueue.length > 0) cloud.installNode(cloud.decodedQueue.pop()!);
      }
      return true;
    }
    // Prefer the current view's largest projected nodes of any cloud, regardless of which
    // Range batch happened to finish first. Keep offscreen results last. Each queue is
    // sorted in reverse so pop() takes its most important node.
    for (const cloud of waiting) {
      const rank = cloud.selectionRank;
      for (const item of cloud.decodedQueue)
        item.rank = rank.get(item.node) ?? Number.MAX_SAFE_INTEGER;
      cloud.decodedQueue.sort((a, b) => b.rank - a.rank);
    }
    for (let installed = 0; installed < limit; installed++) {
      let best: PotreeV2PointCloud | undefined;
      for (const cloud of waiting) {
        const last = cloud.decodedQueue.at(-1);
        if (last && (!best || last.rank < best.decodedQueue.at(-1)!.rank)) best = cloud;
      }
      if (!best) break;
      best.installNode(best.decodedQueue.pop()!);
    }
    return true;
  }

  private installNode({ node, attributes, occupancy }: DecodedQueueItem): void {
    const geometry = createNodeGeometry(attributes, node.box);
    // The decoder counted the occupancy, so installing does not walk the points.
    const extent = nodeExtent(node.box);
    this.levelOffsets.set(
      node,
      occupancyLevelOffset(
        occupancy ?? pointOccupancy(attributes.position!.array, extent),
        extent,
        node.level,
        this.metadata.spacing,
      ),
    );
    const points = new Points(geometry, this.material);
    points.name = node.name;
    // Positions are relative to the node's minimum; the large offset stays in double-precision matrices.
    points.position.copy(node.box.min);
    points.matrixAutoUpdate = false;
    points.updateMatrix();
    points.visible = false;
    points.frustumCulled = false;
    points.layers.mask = this.layersMask;
    // Every node draws with the shared material, so its clips are uploaded right before its draw.
    points.onBeforeRender = () =>
      this.material.setNode(node, this.nodeClips.get(node) ?? NO_CLIP, node.box.min);
    this.group.add(points);
    const state = this.state(node);
    state.queued = false;
    state.points = points;
    state.displayedAt = displayStamp;
    this.installed.set(node, state);
    this.cachedPoints += node.numPoints;
    this.diagnosticsState.sceneConversions++;
    this.diagnosticsState.lastSceneConversionSeconds =
      (performance.now() - this.diagnosticsStartedAt) / 1000;
  }

  private ensureBoxHelper(node: OctreeNode, state: NodeState): LineSegments {
    if (!state.boxHelper) {
      this.boxResources ??= acquireBoxResources();
      const helper = new LineSegments(this.boxResources.geometry, this.boxResources.material);
      helper.name = `${node.name} bounding box`;
      node.box.getCenter(helper.position);
      node.box.getSize(helper.scale);
      helper.frustumCulled = false; // The corresponding points were already selected.
      helper.layers.mask = this.layersMask;
      this.group.add(helper);
      state.boxHelper = helper;
    }
    return state.boxHelper;
  }

  private requestHierarchy(node: OctreeNode, limits: UpdateLimits): void {
    const state = this.state(node);
    const slots = limits.slots;
    if (
      state.loading ||
      this.waitingToRetry(state) ||
      slots.inFlight >= limits.maxConcurrentLoads ||
      this.gate.available() <= 0
    )
      return;
    slots.inFlight++;
    this.inFlight++;
    state.loading = this.loadHierarchy(node)
      .then(
        () => {
          state.failures = 0;
        },
        (error) => {
          // A throttled node is not at fault: the gate pauses the origin and update() retries it.
          if (!this.disposed && !isAbort(error) && !isThrottled(error)) {
            this.noteFailure(state);
            this.reportError(error, node.name);
          }
        },
      )
      .finally(() => {
        state.loading = undefined;
        slots.inFlight--;
        this.inFlight--;
        this.releaseState(node, state);
      });
  }

  /**
   * Start the most important batches of all clouds while request slots are free.
   * Network and decoding overlap: a batch frees its request slot once its bytes
   * arrive. Requests are bounded by the request slots and decode jobs by the pool's
   * backlog, so a small pool does not limit how many ranges are fetched at once.
   * No batch starts while the backlog is full, so the network does not run ahead of
   * decoding with priorities that the view may no longer have.
   */
  private static requestBatches(
    work: readonly { cloud: PotreeV2PointCloud; pending: OctreeNode[] }[],
    limits: UpdateLimits,
  ): void {
    // Like the other limits, the installation backlog is bounded across the clouds updated together.
    const queued = work.reduce((n, { cloud }) => n + cloud.decodedQueue.length, 0);
    if (queued >= MAX_DECODED_QUEUE) return;
    const plans = work.flatMap(({ cloud, pending }) => cloud.planBatches(pending));
    plans.sort((a, b) => a.rank - b.rank);
    for (const plan of plans) {
      const { cloud } = plan;
      if (cloud.liveDecoder().full) continue;
      // Each plan is one request or one cached decode, so these checks cover all it starts.
      if (
        !plan.cached &&
        (limits.slots.inFlight >= limits.maxConcurrentLoads || cloud.gate.available() <= 0)
      )
        continue;
      cloud.startBatch(plan, limits.slots);
    }
  }

  /**
   * Group this cloud's first loadable nodes into range batches and cached decodes,
   * ranked by their best selection rank. Cache hits are split off here, before
   * batching, so that a plan starts exactly the work its limits were checked for.
   */
  private planBatches(nodes: OctreeNode[]): BatchPlan[] {
    if (nodes.length === 0) return [];
    // Limit grouping work on each frame. Selection order already reflects visual priority,
    // so the first 64 loadable nodes are the ones that matter.
    const candidates: OctreeNode[] = [];
    for (const node of nodes) {
      const state = this.states.get(node);
      if (
        !state ||
        (!state.points && !state.loading && !state.queued && !this.waitingToRetry(state))
      ) {
        if (candidates.push(node) >= 64) break;
      }
    }
    // Nodes outside the last selection keep the order they were given in, after selected ones.
    const rank = new Map(
      candidates.map((node, index) => [node, this.selectionRank.get(node) ?? 2 ** 40 + index]),
    );
    const plan = (nodes: OctreeNode[], cached: boolean): BatchPlan => ({
      cloud: this,
      nodes,
      cached,
      rank: Math.min(...nodes.map((node) => rank.get(node)!)),
    });
    const cache = this.encodedCache;
    const cached = cache ? candidates.filter((node) => cache.has(node)) : [];
    const plans = makeNodeBatches(
      cache ? candidates.filter((node) => !cache.has(node)) : candidates,
    ).map((batch) => plan(batch.nodes, false));
    for (let i = 0; i < cached.length; i += MAX_CACHED_PLAN_NODES) {
      plans.push(plan(cached.slice(i, i + MAX_CACHED_PLAN_NODES), true));
    }
    return plans;
  }

  /**
   * Start one plan. loadBatch() splits nodes by the encoded cache and batches them again;
   * a plan is already split that way and is one batch, so it starts one request or one decode.
   */
  private startBatch({ nodes, cached }: BatchPlan, slots: LoadSlots): void {
    this.activeLoads++;
    let releaseRequest = () => {};
    let signal: AbortSignal | undefined;
    if (!cached) {
      slots.inFlight++;
      this.inFlight++;
      const request: BatchRequest = {
        nodes,
        controller: new AbortController(),
        wantedAt: performance.now(),
      };
      this.fetchingRequests.add(request);
      signal = request.controller.signal;
      let fetching = true;
      releaseRequest = () => {
        if (!fetching) return;
        fetching = false;
        this.fetchingRequests.delete(request);
        slots.inFlight--;
        this.inFlight--;
      };
    }
    const states = nodes.map((node) => this.state(node));
    const fail = (failed: readonly OctreeNode[], error: unknown) => {
      // A throttled node is not at fault: the gate pauses the origin and update() retries it.
      if (this.disposed || isAbort(error) || isThrottled(error)) return;
      for (const node of failed) {
        this.noteFailure(this.state(node));
        this.reportError(error, node.name);
      }
    };
    const promise = this.loadBatch(nodes, releaseRequest, signal)
      .then(
        (failures) => {
          const failed = new Set(failures.flatMap((failure) => failure.nodes));
          for (const [index, node] of nodes.entries()) {
            if (!failed.has(node)) states[index]!.failures = 0;
          }
          for (const failure of failures) fail(failure.nodes, failure.error);
        },
        (error) => fail(nodes, error),
      )
      .finally(() => {
        for (const [index, node] of nodes.entries()) {
          states[index]!.loading = undefined;
          this.releaseState(node, states[index]!);
        }
        releaseRequest();
        this.activeLoads--;
      });
    for (const state of states) state.loading = promise;
  }

  static {
    loadPointCloud = (metadataUrl, options) => PotreeV2PointCloud.load(metadataUrl, options);
    updatePointClouds = (clouds, camera, viewportHeight, limits, force) =>
      PotreeV2PointCloud.updateAll(clouds, camera, viewportHeight, limits, force);
    pickPointClouds = (clouds, renderer, camera, x, y, options) =>
      PotreeV2PointCloud.pickAll(clouds, renderer, camera, x, y, options);
  }

  private static updateAll(
    clouds: readonly PotreeV2PointCloud[],
    camera: Camera,
    viewportHeight: number,
    limits: UpdateLimits,
    force: boolean,
  ): boolean {
    const { pointBudget, cachePointBudget } = limits;
    const active = clouds.filter((cloud) => !cloud.disposed);
    if (active.length === 0) return false;
    if (!validViewportHeight(viewportHeight)) return false;
    // From the parents down: a camera in a rig moved since the last render has stale matrices.
    camera.updateWorldMatrix(true, false);
    let unchanged = !force;
    let layersChanged = false;
    for (const cloud of active) {
      if (cloud.syncLayers()) layersChanged = true;
      if (!cloud.prepareView(camera, viewportHeight, pointBudget, cachePointBudget))
        unchanged = false;
    }
    if (unchanged) {
      for (const cloud of active) {
        cloud.finishLoadDiagnostics();
        cloud.loadWaiters.resolveAll();
      }
      return layersChanged;
    }
    const stamp = ++displayStamp;
    // One heap across clouds: the budget goes to the largest projected nodes of any cloud, as in Potree.
    const candidates = sharedCandidates;
    // A traversal that throws, such as on an invalid clip box, is repeated by the next update.
    for (const cloud of active) cloud.settled = false;
    let traversals: Traversal[];
    try {
      traversals = active.map((cloud) => cloud.beginTraversal(camera, candidates));
      let pointsUsed = 0;
      let selectedCount = 0;
      while (candidates.size > 0) {
        const candidate = candidates.pop();
        const { node, traversal } = candidate;
        const cloud = traversal.cloud;
        if (node.numPoints > 0) {
          // Candidates arrive largest first, so every remaining node would be less
          // important than the one that no longer fits: stop, as Potree does.
          if (pointsUsed + node.numPoints > pointBudget) break;
          pointsUsed += node.numPoints;
          cloud.selectionRank.set(node, selectedCount++);
          traversal.selected.add(node);
          if (candidate.clip !== NO_CLIP) cloud.nodeClips.set(node, candidate.clip);
        } else if (node.type !== 2 || node.hierarchyLoaded) {
          traversal.empty.push(node);
        }
        if (node.type === 2 && !node.hierarchyLoaded) {
          traversal.hierarchyPending++;
          cloud.requestHierarchy(node, limits);
          continue;
        }
        if (node.numPoints > 0) traversal.pending.push(node);
        cloud.pushChildren(candidate, camera, viewportHeight, candidates);
      }
    } finally {
      // The heap is shared by every update; candidates left by a throw would join the next selection.
      candidates.clear();
    }
    for (const cloud of active) cloud.fitClipCapacity();
    for (const { cloud, selected } of traversals) cloud.abortStaleRequests(selected);
    let changed = PotreeV2PointCloud.installDecodedNodes(active, limits.maxNodesToGPUPerFrame);
    PotreeV2PointCloud.requestBatches(traversals, limits);
    for (const traversal of traversals) {
      if (traversal.cloud.finishTraversal(traversal, stamp) || traversal.cloud.clipChanged)
        changed = true;
    }
    if (PotreeV2PointCloud.evictLeastRecent(traversals, cachePointBudget)) changed = true;
    for (const { cloud, sceneReady } of traversals) {
      cloud.settled =
        sceneReady &&
        cloud.decodedQueue.length === 0 &&
        cloud.inFlight === 0 &&
        cloud.activeLoads === 0;
      if (cloud.settled) cloud.loadWaiters.resolveAll();
    }
    return changed || layersChanged;
  }

  /** Give the node objects the layers of `group`; returns true when they changed. */
  private syncLayers(): boolean {
    const mask = this.group.layers.mask;
    if (mask === this.layersMask) return false;
    this.layersMask = mask;
    for (const state of this.states.values()) {
      if (state.points) state.points.layers.mask = mask;
      if (state.boxHelper) state.boxHelper.layers.mask = mask;
    }
    return true;
  }

  /** Compute this frame's view; returns true when it and the settings match a settled previous update. */
  private prepareView(
    camera: Camera,
    viewportHeight: number,
    pointBudget: number,
    cachePointBudget: number,
  ): boolean {
    this.group.updateWorldMatrix(true, false);
    const projection = this.projection
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .multiply(this.group.matrixWorld);
    const clipKey = this.clipKey;
    clipKey.length = 0;
    if (this.clipping) appendClippingKey(this.clipping, this.group.matrixWorld, clipKey);
    this.clipChanged = this.clipping !== this.lastClipping || !sameKey(clipKey, this.lastClipKey);
    const shown = isShown(this.group);
    const unchanged =
      this.settled &&
      shown === this.shown &&
      projection.equals(this.lastView) &&
      viewportHeight === this.lastViewportHeight &&
      pointBudget === this.lastPointBudget &&
      cachePointBudget === this.lastCachePointBudget &&
      this.minNodePixelSize === this.lastMinNodePixelSize &&
      this.showBoundingBoxes === this.lastShowBoundingBoxes &&
      !this.clipChanged;
    this.clipKey = this.lastClipKey;
    this.lastClipKey = clipKey;
    this.lastClipping = this.clipping;
    this.lastView.copy(projection);
    this.lastViewportHeight = viewportHeight;
    this.lastPointBudget = pointBudget;
    this.lastCachePointBudget = cachePointBudget;
    this.lastMinNodePixelSize = this.minNodePixelSize;
    this.lastShowBoundingBoxes = this.showBoundingBoxes;
    this.shown = shown;
    return unchanged;
  }

  private beginTraversal(camera: Camera, candidates: CandidateHeap): Traversal {
    this.encodedCache?.trim();
    camera.getWorldPosition(this.cameraPosition);
    this.frustum.setFromProjectionMatrix(this.projection);
    this.selectionRank.clear();
    const clip = this.clipping
      ? snapshotClipping(this.clipping, this.group.matrixWorld)
      : undefined;
    const traversal: Traversal = {
      cloud: this,
      clip,
      selected: new Set(),
      empty: [],
      pending: [],
      hierarchyPending: 0,
      sceneReady: false,
    };
    this.nodeClips = new Map();
    // Nodes outside the view or clipped away are never queued, so the heap only holds visible candidates.
    // A hidden cloud selects nothing, as in Potree: it spends no budget, and its nodes
    // become the least recently displayed ones to evict.
    if (!this.shown || !this.frustum.intersectsBox(this.root.box)) return traversal;
    const rootClip = clip ? clipNode(clip.root, this.root.box, clip.keepPrune) : NO_CLIP;
    if (rootClip) candidates.push({ node: this.root, pixels: Infinity, traversal, clip: rootClip });
    return traversal;
  }

  private pushChildren(
    { node, traversal, clip }: Candidate,
    camera: Camera,
    viewportHeight: number,
    candidates: CandidateHeap,
  ): void {
    for (const child of node.children) {
      if (!child || !this.frustum.intersectsBox(child.box)) continue;
      const radius = projectedRadius(
        camera,
        this.cameraPosition,
        child.box,
        this.group.matrixWorld,
        this.projectedSphere,
        viewportHeight,
      );
      if (radius < this.minNodePixelSize) continue;
      const childClip = traversal.clip
        ? clipNode(clip, child.box, traversal.clip.keepPrune)
        : NO_CLIP;
      if (childClip) candidates.push({ node: child, pixels: radius, traversal, clip: childClip });
    }
  }

  /** Grow the shaders' clip capacity when a selected node crosses more clips than they hold. */
  private fitClipCapacity(): void {
    let boxes = 0;
    let planes = 0;
    for (const clip of this.nodeClips.values()) {
      boxes = Math.max(boxes, clipBoxCount(clip));
      planes = Math.max(planes, clip.planes.length);
    }
    this.material.setClipCapacity(grownCapacity(this.material.clipCapacity, { boxes, planes }));
  }

  /** Show one cloud's selection; returns true when its scene changed. */
  private finishTraversal(traversal: Traversal, stamp: number): boolean {
    const changed = this.updateDisplayedNodes(traversal.selected, traversal.empty, stamp);
    traversal.sceneReady = this.updateLoadDiagnostics(
      traversal.selected,
      traversal.hierarchyPending,
    );
    return changed;
  }

  /** Abort octree requests still fetching when the view has not needed any of their nodes for a while. */
  private abortStaleRequests(selected: Set<OctreeNode>): void {
    const now = performance.now();
    for (const request of this.fetchingRequests) {
      if (request.nodes.some((node) => selected.has(node))) {
        request.wantedAt = now;
      } else if (now - request.wantedAt >= STALE_REQUEST_MS) {
        this.fetchingRequests.delete(request);
        request.controller.abort();
        this.diagnosticsState.abortedRequests++;
      }
    }
  }

  /**
   * Show selected installed nodes and hide the ones displayed last frame, without
   * visiting every cached node. Displayed nodes move to the most recent end of the LRU.
   */
  private updateDisplayedNodes(
    selected: Set<OctreeNode>,
    empty: readonly OctreeNode[],
    stamp: number,
  ): boolean {
    let changed = false;
    const show = (object: Object3D | undefined, visible: boolean) => {
      if (!object || object.visible === visible) return;
      object.visible = visible;
      changed = true;
    };
    for (const node of this.displayed) {
      if (selected.has(node)) continue;
      const state = this.installed.get(node);
      if (!state) continue;
      show(state.points, false);
      show(state.boxHelper, false);
    }
    const displayed = new Set<OctreeNode>();
    for (const node of selected) {
      const state = this.installed.get(node);
      if (!state) continue;
      // A node hidden by clips that do not prune stays selected, loaded and budgeted, but is not drawn.
      const visible = !this.nodeClips.get(node)?.hidden;
      show(state.points, visible);
      const showBox = this.showBoundingBoxes && visible;
      if (showBox && !state.boxHelper) changed = true;
      show(showBox ? this.ensureBoxHelper(node, state) : state.boxHelper, showBox);
      state.displayedAt = stamp;
      this.installed.delete(node);
      this.installed.set(node, state);
      displayed.add(node);
    }
    const lodNodes = new Set([...displayed, ...empty]);
    if (
      lodNodes.size !== this.lodNodes.size ||
      [...lodNodes].some((node) => !this.lodNodes.has(node))
    ) {
      // Empty nodes have no density to measure, so their offset is 0, as in Potree.
      this.visibleNodes.update(lodNodes, (node) => this.levelOffsets.get(node) ?? 0);
      this.lodNodes = lodNodes;
      changed = true;
    }
    this.displayed = displayed;
    return changed;
  }

  /** Returns true when every selected node is in the scene. */
  private updateLoadDiagnostics(selected: Set<OctreeNode>, hierarchyPending: number): boolean {
    let sceneNodes = 0;
    let decodedNodes = 0;
    let newlyRequired = false;
    for (const node of selected) {
      const inScene = this.installed.has(node);
      if (inScene) sceneNodes++;
      if (inScene || this.states.get(node)?.queued) decodedNodes++;
      if (!inScene && !this.requiredLastFrame.has(node)) newlyRequired = true;
    }
    if (this.diagnosticsState.state === 'complete' && newlyRequired) {
      this.resetLoadDiagnostics();
    }
    this.requiredLastFrame = selected;
    const metrics = this.diagnosticsState;
    metrics.requiredNodes = selected.size;
    metrics.decodedNodes = decodedNodes;
    metrics.pendingSceneNodes = decodedNodes - sceneNodes;
    const elapsed = (performance.now() - this.diagnosticsStartedAt) / 1000;
    if (hierarchyPending === 0 && decodedNodes === selected.size) {
      metrics.decodedReadySeconds ??= elapsed;
    } else {
      metrics.decodedReadySeconds = null;
    }
    if (hierarchyPending === 0 && sceneNodes === selected.size) {
      metrics.sceneReadySeconds ??= elapsed;
      this.sceneReadySince ??= performance.now();
      this.finishLoadDiagnostics();
      return true;
    }
    metrics.sceneReadySeconds = null;
    this.sceneReadySince = null;
    metrics.state = 'loading';
    return false;
  }

  /** Mark the measurement complete once the scene stayed ready; also runs while update() skips traversal. */
  private finishLoadDiagnostics(): void {
    const metrics = this.diagnosticsState;
    if (metrics.state !== 'loading' || this.sceneReadySince === null) return;
    const now = performance.now();
    if (now - this.sceneReadySince < LOAD_COMPLETE_MS) return;
    metrics.state = 'complete';
    metrics.seconds = (now - this.diagnosticsStartedAt) / 1000;
  }

  /**
   * Release least recently displayed nodes of any cloud until their decoded points fit
   * `budget`. Each cloud's installed map is already in LRU order, so this merges them.
   */
  private static evictLeastRecent(traversals: readonly Traversal[], budget: number): boolean {
    let total = traversals.reduce((sum, { cloud }) => sum + cloud.cachedPoints, 0);
    if (total <= budget) return false;
    type Cursor = {
      traversal: Traversal;
      entries: Iterator<[OctreeNode, NodeState]>;
      head?: [OctreeNode, NodeState];
    };
    const advance = (cursor: Cursor) => {
      const { cloud, selected } = cursor.traversal;
      cursor.head = undefined;
      for (;;) {
        const next = cursor.entries.next();
        if (next.done) return;
        const [node] = next.value;
        if (node === cloud.root) continue;
        // Displayed nodes were just moved to the end, so everything after is displayed too.
        if (selected.has(node)) return;
        cursor.head = next.value;
        return;
      }
    };
    const cursors = traversals.map((traversal) => {
      const cursor: Cursor = { traversal, entries: traversal.cloud.installed.entries() };
      advance(cursor);
      return cursor;
    });
    let evicted = false;
    while (total > budget) {
      let oldest: Cursor | undefined;
      for (const cursor of cursors) {
        if (cursor.head && (!oldest || cursor.head[1].displayedAt < oldest.head![1].displayedAt))
          oldest = cursor;
      }
      if (!oldest) break;
      const [node, state] = oldest.head!;
      total -= node.numPoints;
      oldest.traversal.cloud.evictNode(node, state);
      evicted = true;
      advance(oldest);
    }
    return evicted;
  }

  private evictNode(node: OctreeNode, state: NodeState): void {
    const points = state.points!;
    this.group.remove(points);
    points.geometry.dispose();
    state.points = undefined;
    if (state.boxHelper) {
      this.group.remove(state.boxHelper);
      state.boxHelper = undefined;
    }
    this.installed.delete(node);
    this.levelOffsets.delete(node);
    this.cachedPoints -= node.numPoints;
    this.releaseState(node, state);
  }

  /**
   * Find the point drawn at `x`, `y` (CSS pixels from the canvas' top-left corner)
   * among the nodes displayed by the last `update()`. The IDs are rendered on the GPU
   * and read back asynchronously; attribute values come from the decoded arrays.
   * Returns null while `group` or an ancestor is hidden. Other clouds do not hide the
   * points of this one; a PotreeV2PointCloudSet's pick() tests its clouds together.
   */
  pick(
    renderer: WebGLRenderer,
    camera: Camera,
    x: number,
    y: number,
    options: PotreeV2PickOptions = {},
  ): Promise<PotreeV2PickResult | null> {
    return PotreeV2PointCloud.pickAll([this], renderer, camera, x, y, options);
  }

  private static async pickAll(
    clouds: readonly PotreeV2PointCloud[],
    renderer: WebGLRenderer,
    camera: Camera,
    x: number,
    y: number,
    options: PotreeV2PickOptions,
  ): Promise<PotreeV2PickResult | null> {
    const layers = clouds.map((cloud) => cloud.pickLayer()).filter((layer) => layer !== undefined);
    // Every cloud holds the same shared picker.
    const picker = layers[0]?.owner.picker;
    if (!picker) return null;
    const hit = await picker.pick(renderer, camera, layers, x, y, options.radius ?? 0);
    if (!hit || hit.layer.owner.disposed) return null;
    return hit.layer.owner.pickResult(hit, renderer.getPixelRatio());
  }

  /** The nodes displayed by the last update(), or undefined while the cloud is hidden. */
  private pickLayer(): PickLayer<PotreeV2PointCloud> | undefined {
    if (this.disposed || !isShown(this.group)) return undefined;
    const targets: PickTarget[] = [];
    for (const node of this.displayed) {
      const points = this.installed.get(node)?.points;
      if (points?.visible)
        targets.push({ node, points, clip: this.nodeClips.get(node) ?? NO_CLIP });
    }
    this.group.updateWorldMatrix(true, false);
    this.picker ??= PointPicker.acquire();
    return {
      owner: this,
      display: this.material,
      groupMatrix: this.group.matrixWorld,
      groupOrder: this.group.renderOrder,
      targets,
    };
  }

  private pickResult(
    { target, index, distance }: PickHit<PotreeV2PointCloud>,
    pixelRatio: number,
  ): PotreeV2PickResult {
    const geometry = target.points.geometry;
    // Node-relative position to the cloud's local space, where boundingBox.min is the origin.
    const position = new Vector3()
      .fromBufferAttribute(geometry.getAttribute('position'), index)
      .applyMatrix4(target.points.matrix);
    const min = this.metadata.boundingBox.min;
    const attributes: Record<string, number[]> = {};
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      if (name === 'position') continue;
      const { array, itemSize } = attribute;
      // color carries an opaque alpha byte that is not part of the source rgb attribute.
      const values = Array.from(array.slice(index * itemSize, (index + 1) * itemSize));
      if (name === 'color') {
        attributes.rgb = values.slice(0, 3);
        continue;
      }
      const source = this.metadata.attributes.find((attribute) => attribute.name === name);
      const normalization = source && attributeNormalization(source);
      attributes[name] = normalization
        ? values.map((value) => normalization.offset + value * normalization.span)
        : values;
    }
    return {
      cloud: this,
      node: target.node.name,
      index,
      sourcePosition: [position.x + min[0], position.y + min[1], position.z + min[2]],
      position: position.applyMatrix4(this.group.matrixWorld),
      attributes,
      distance: distance / pixelRatio,
    };
  }

  /** Abort pending loads and release geometries and the material. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cloudSets.get(this)?.remove(this);
    this.controller.abort();
    this.loadWaiters.abortAll();
    for (const request of this.fetchingRequests) request.controller.abort();
    this.fetchingRequests.clear();
    this.decoder.release();
    for (const state of this.installed.values()) {
      this.group.remove(state.points!);
      state.points!.geometry.dispose();
      if (state.boxHelper) this.group.remove(state.boxHelper);
    }
    this.installed.clear();
    this.displayed.clear();
    this.lodNodes.clear();
    this.states.clear();
    this.decodedQueue.length = 0;
    if (this.picker) {
      this.picker.forget(this.material);
      this.picker.release();
    }
    this.material.dispose();
    this.visibleNodes.dispose();
    this.levelOffsets.clear();
    if (this.boxResources) releaseBoxResources(this.boxResources);
  }
}

/** update() selects nothing for other heights, such as a canvas not laid out yet. */
export function validViewportHeight(height: number): boolean {
  return Number.isFinite(height) && height > 0;
}

/** False when `object` or any of its ancestors is hidden, so that Three.js does not draw it. */
function isShown(object: Object3D): boolean {
  for (let current: Object3D | null = object; current; current = current.parent) {
    if (!current.visible) return false;
  }
  return true;
}

function projectedRadius(
  camera: Camera,
  cameraPosition: Vector3,
  box: import('three').Box3,
  worldMatrix: Matrix4,
  sphere: Sphere,
  height: number,
): number {
  box.getBoundingSphere(sphere).applyMatrix4(worldMatrix);
  // Pixels per world unit (at distance 1 for perspective cameras), read from the matrix
  // the view is rendered with, so `zoom` and view offsets count as they do on screen.
  const pixelsPerUnit = (camera.projectionMatrix.elements[5]! * height) / 2;
  // Flags rather than instanceof, which fails when two copies of Three.js are bundled.
  if ((camera as OrthographicCamera).isOrthographicCamera === true)
    return sphere.radius * pixelsPerUnit;
  if ((camera as PerspectiveCamera).isPerspectiveCamera === true) {
    const distance = cameraPosition.distanceTo(sphere.center);
    if (distance < sphere.radius) return Infinity;
    return (sphere.radius * pixelsPerUnit) / distance;
  }
  return Infinity;
}

/**
 * Load a Potree v2 point cloud from the URL of its metadata.json. Resolves when metadata, the
 * first hierarchy chunk and the root node are ready; add `group` to a scene and the cloud to a
 * PotreeV2PointCloudSet to display it.
 */
export function loadPotreeV2(
  metadataUrl: string | URL,
  options: PotreeV2Options = {},
): Promise<PotreeV2PointCloud> {
  return loadPointCloud(metadataUrl, options);
}
