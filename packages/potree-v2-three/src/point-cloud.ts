import {
  BoxGeometry, Camera, EdgesGeometry, Frustum, Group, LineBasicMaterial,
  LineSegments, Matrix4, Object3D, OrthographicCamera, PerspectiveCamera,
  Points, PointsMaterial, Sphere, Vector3,
} from 'three';
import type { WebGLRenderer } from 'three';
import { createNodeGeometry, DEFAULT_DECODED_ATTRIBUTES, nodeOrigin } from './decode.js';
import type { DecodedNodeData } from './decode.js';
import type { NodeDecodeTiming } from './decode.js';
import { DecoderPool } from './decoder-pool.js';
import { makeNodeBatches } from './batches.js';
import type { NodeBatch } from './batches.js';
import { EncodedNodeCache } from './encoded-cache.js';
import { createRoot, parseHierarchyChunk, validateMetadata } from './format.js';
import type { OctreeNode, PotreeV2Metadata } from './format.js';
import { fetchRange, responseError } from './http.js';
import { isThrottled, RequestGate } from './request-gate.js';
import { PointPicker } from './picking.js';
import type { PickHit, PickTarget } from './picking.js';

export interface PotreeV2Options {
  /** Maximum points selected for display per update. Default: 2,000,000. Unused in a PotreeV2PointCloudSet. */
  pointBudget?: number;
  /** Override the decoded cache limit. Default: twice the current pointBudget. Unused in a PotreeV2PointCloudSet. */
  cachePointBudget?: number;
  /** Byte limit for octree payloads before decoding. Default: 128 MiB for BROTLI, otherwise 0. */
  encodedCacheByteBudget?: number;
  /** Minimum projected node radius in pixels for loading children. Default: 30, as in Potree. */
  minNodePixelSize?: number;
  /**
   * Simultaneous HTTP range requests for hierarchy chunks and octree batches. Default: 6.
   * Unused in a PotreeV2PointCloudSet.
   */
  maxConcurrentLoads?: number;
  /**
   * Decoder Workers. All clouds share one pool, sized by the largest request among
   * live clouds. Default: hardwareConcurrency - 1, between 1 and 4.
   */
  decoderWorkers?: number;
  /** Maximum decoded nodes installed as Three.js objects per update. Default: 8. Unused in a PotreeV2PointCloudSet. */
  maxNodesToGPUPerFrame?: number;
  /** Point size in CSS pixels. Default: 2. */
  pointSize?: number;
  /** Show boxes around currently displayed nodes. Default: false. */
  showBoundingBoxes?: boolean;
  /**
   * metadata.json attribute names to decode and upload as geometry attributes.
   * `position` is always decoded. Default: `['position', 'rgb']` (rgb only when present).
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
   * Receives asynchronous errors from update-triggered loads. Throttled responses
   * (429, 503) are not reported: they pause requests to the origin and are retried.
   */
  onError?: (error: Error, node: string) => void;
}

export interface PotreeV2FetchStats {
  /** Successfully fetched and decoded octree Range batches. */
  rangeRequests: number;
  /** Nodes included in those batches; encoded-cache hits are excluded. */
  fetchedNodes: number;
}

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
  /** Octree node name, such as `r024`. */
  node: string;
  /** Point index within the node. */
  index: number;
  /** Position in world space, including `group`'s transform. */
  position: Vector3;
  /** Position in the metadata.json coordinate system. */
  sourcePosition: [number, number, number];
  /** Other decoded attributes by metadata.json name. `rgb` holds 0–255 values. */
  attributes: Record<string, number[]>;
  /** Distance from the requested position to the hit pixel, in CSS pixels. */
  distance: number;
}

function emptyDiagnostics(): PotreeV2LoadDiagnostics {
  return {
    state: 'loading', seconds: 0, requiredNodes: 0, decodedNodes: 0,
    pendingSceneNodes: 0, decodedReadySeconds: null, sceneReadySeconds: null,
    lastSceneConversionSeconds: null, sceneConversions: 0, startedBatches: 0,
    completedBatches: 0, loadedNodes: 0, activeBatches: 0,
    lastBatchDoneSeconds: null, hierarchyStarted: 0, hierarchyCompleted: 0,
    hierarchyMs: 0, fetchMs: 0, codecSetupMs: 0, brotliMs: 0,
    attributesMs: 0, fetchedBytes: 0, throttledResponses: 0,
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
/** Attempts for requests made by load(), which no update loop retries. */
const LOAD_ATTEMPTS = 6;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function defaultDecoderWorkers(): number {
  const cores = globalThis.navigator?.hardwareConcurrency;
  return Math.min(4, Math.max(1, (cores ?? 4) - 1));
}

function resolveDecodedAttributes(metadata: PotreeV2Metadata, requested?: string[]): string[] {
  const available = new Set(metadata.attributes.map(a => a.name));
  for (const name of requested ?? []) {
    if (!available.has(name)) throw new Error(`Potree v2 metadata has no attribute: ${name}`);
  }
  const names = new Set(['position', ...(requested ?? DEFAULT_DECODED_ATTRIBUTES)]);
  return [...names].filter(name => available.has(name));
}

/** One cloud's part of an update that may traverse several clouds together. */
type Traversal = {
  cloud: PotreeV2PointCloud;
  selected: Set<OctreeNode>;
  pending: OctreeNode[];
  hierarchyPending: number;
  sceneReady: boolean;
};

type Candidate = { node: OctreeNode; pixels: number; traversal: Traversal };

/** Incremented by every traversing update, shared by all clouds so their LRU orders compare. */
let displayStamp = 0;

/** Clouds that belong to a PotreeV2PointCloudSet, which then owns their updates and budgets. */
export const cloudSets = new WeakMap<PotreeV2PointCloud, { remove(cloud: PotreeV2PointCloud): boolean }>();

/** Network requests in progress for the clouds that share it; each request returns its slot here. */
export class LoadSlots {
  inFlight = 0;
}

/** Budgets and limits of one update, shared by the clouds it traverses. */
export interface UpdateLimits {
  pointBudget: number;
  cachePointBudget: number;
  maxConcurrentLoads: number;
  maxNodesToGPUPerFrame: number;
  slots: LoadSlots;
}

/**
 * Select, load and evict nodes of `clouds` under `limits`. `force` traverses even
 * when every cloud's view and settings are unchanged.
 */
export let updatePointClouds: (
  clouds: readonly PotreeV2PointCloud[], camera: Camera, viewportHeight: number, limits: UpdateLimits, force: boolean,
) => boolean;

/** An octree batch a cloud could request now; `rank` orders plans across clouds. */
type BatchPlan = { cloud: PotreeV2PointCloud; batch: NodeBatch; rank: number };

/** Bound on decoded nodes waiting for installation before a cloud stops requesting more. */
const MAX_DECODED_QUEUE = 32;

/** An octree batch request that may be aborted while its bytes are still arriving. */
type BatchRequest = { nodes: OctreeNode[]; controller: AbortController; wantedAt: number };

/** Largest projected nodes first, without sorting the entire frontier on each pop. */
class CandidateHeap {
  private readonly items: Candidate[] = [];

  get size(): number { return this.items.length; }

  clear(): void { this.items.length = 0; }

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
      if (child + 1 < this.items.length && this.items[child + 1]!.pixels > this.items[child]!.pixels) child++;
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

/** A camera-driven, additive LOD Potree v2 point cloud. Add `group` to a Three.js scene. */
export class PotreeV2PointCloud {
  readonly group = new Group();
  readonly root: OctreeNode;
  readonly metadata: PotreeV2Metadata;
  readonly worldOffset: Vector3;
  readonly material: PointsMaterial;

  pointBudget: number;
  private cachePointBudgetOverride?: number;
  minNodePixelSize: number;
  maxConcurrentLoads: number;
  maxNodesToGPUPerFrame: number;
  showBoundingBoxes: boolean;
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
  /** Decoded nodes waiting for installation; `rank` is scratch space for installDecodedNodes. */
  private readonly decodedQueue: { node: OctreeNode; attributes: DecodedNodeData; rank: number }[] = [];
  private readonly controller = new AbortController();
  private readonly decoder: DecoderPool;
  private readonly encodedCache: EncodedNodeCache;
  private readonly boxGeometry: EdgesGeometry;
  private readonly boxMaterial: LineBasicMaterial;
  readonly decoderWorkers: number;
  /** This cloud's network requests in progress; a batch releases its slot once its bytes arrive. */
  private inFlight = 0;
  /** Request slots when this cloud is updated on its own. */
  private readonly ownSlots = new LoadSlots();
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
  /** Admission shared with every cloud from the same origin. */
  private readonly gate: RequestGate;
  private disposed = false;

  private constructor(url: URL, metadata: PotreeV2Metadata, options: PotreeV2Options) {
    this.decodedAttributes = resolveDecodedAttributes(metadata, options.attributes);
    this.metadataUrl = url;
    this.metadata = metadata;
    this.root = createRoot(metadata);
    this.worldOffset = new Vector3(...metadata.boundingBox.min);
    this.fetcher = options.fetch ?? fetch;
    this.pointBudget = options.pointBudget ?? 2_000_000;
    this.cachePointBudgetOverride = options.cachePointBudget;
    this.encodedCache = new EncodedNodeCache(options.encodedCacheByteBudget ??
      (metadata.encoding === 'BROTLI' ? 128 * 1024 * 1024 : 0));
    this.minNodePixelSize = options.minNodePixelSize ?? 30;
    this.maxConcurrentLoads = Math.max(1, Math.floor(options.maxConcurrentLoads ?? 6));
    this.decoderWorkers = Math.max(1, Math.floor(options.decoderWorkers ?? defaultDecoderWorkers()));
    this.maxNodesToGPUPerFrame = Math.max(1, Math.floor(options.maxNodesToGPUPerFrame ?? 8));
    this.showBoundingBoxes = options.showBoundingBoxes ?? false;
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.gate = RequestGate.for(url);
    this.decoder = DecoderPool.acquire(this.decoderWorkers);
    // Workers and the WASM decoder start while the first hierarchy chunk is fetched.
    this.decoder.warm(metadata.encoding === 'BROTLI');
    const unitBox = new BoxGeometry(1, 1, 1);
    this.boxGeometry = new EdgesGeometry(unitBox);
    unitBox.dispose();
    // Both points and box edges are opaque depth-tested geometry. Box edges
    // must write depth even when Three.js sorts their material before points.
    this.boxMaterial = new LineBasicMaterial({
      color: 0x58dfd2, toneMapped: false, depthTest: true, depthWrite: true,
    });
    this.onError = options.onError;
    this.material = new PointsMaterial({
      color: 0xffffff, size: options.pointSize ?? 2, sizeAttenuation: false,
      vertexColors: this.decodedAttributes.includes('rgb'),
    });
    if (this.material.vertexColors) {
      // Potree's RGB bytes are display-encoded colors. Three.js expects linear
      // vertex colors and applies an sRGB output transform, which would brighten
      // the points unless the bytes are decoded before that transform.
      this.material.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <color_vertex>',
          `#include <color_vertex>
#ifdef USE_COLOR
  vColor.rgb = mix(
    pow(vColor.rgb * 0.9478672986 + vec3(0.0521327014), vec3(2.4)),
    vColor.rgb * 0.0773993808,
    lessThanEqual(vColor.rgb, vec3(0.04045))
  );
#endif`,
        );
      };
    }
    this.group.name = metadata.name ?? 'Potree v2 point cloud';
  }

  /** Decoded point limit; follows pointBudget unless explicitly overridden. */
  get cachePointBudget(): number { return this.cachePointBudgetOverride ?? this.pointBudget * 2; }
  set cachePointBudget(value: number) { this.cachePointBudgetOverride = value; }

  /** Byte limit for encoded octree nodes; setting 0 disables that cache. */
  get encodedCacheByteBudget(): number { return this.encodedCache.maxBytes; }
  set encodedCacheByteBudget(value: number) {
    this.encodedCache.maxBytes = value;
    this.encodedCache.trim();
  }

  /** Cumulative successful octree range loads since construction or the last clear. */
  get fetchStats(): PotreeV2FetchStats { return { ...this.fetchStatsState }; }

  /** Reset counters without counting batches already in progress. */
  clearFetchStats(): void {
    this.fetchStatsGeneration++;
    this.fetchStatsState.rangeRequests = 0;
    this.fetchStatsState.fetchedNodes = 0;
  }

  /** Timings for the current view load, including Worker decode and scene installation. */
  get loadDiagnostics(): PotreeV2LoadDiagnostics {
    const seconds = this.diagnosticsState.state === 'loading'
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

  /** Resolves when metadata, the first hierarchy chunk and the root node are ready. */
  static async load(metadataUrl: string | URL, options: PotreeV2Options = {}): Promise<PotreeV2PointCloud> {
    const url = new URL(String(metadataUrl), globalThis.location?.href);
    const fetcher = options.fetch ?? fetch;
    const gate = RequestGate.for(url);
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    const metadata = validateMetadata(await gate.retry(() => gate.request(async () => {
      const response = await fetcher(url);
      if (!response.ok) throw await responseError(url, response);
      return response.json() as Promise<unknown>;
    }, retryDelayMs), LOAD_ATTEMPTS));
    const cloud = new PotreeV2PointCloud(url, metadata, options);
    const signal = cloud.controller.signal;
    try {
      await gate.retry(() => cloud.loadHierarchy(cloud.root), LOAD_ATTEMPTS, signal);
      if (cloud.root.numPoints > 0) {
        await gate.retry(() => cloud.loadBatch([cloud.root]), LOAD_ATTEMPTS, signal);
        PotreeV2PointCloud.installDecodedNodes([cloud], Infinity);
      }
      return cloud;
    } catch (error) {
      cloud.dispose();
      throw error;
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
    if (state.points || state.boxHelper || state.loading || state.queued || state.failures > 0) return;
    if (this.states.get(node) === state) this.states.delete(node);
  }

  private waitingToRetry(state: NodeState): boolean {
    return state.failures > 0 && performance.now() < state.retryAt;
  }

  private noteFailure(state: NodeState): void {
    state.failures++;
    state.retryAt = performance.now() +
      Math.min(this.retryDelayMs * 2 ** (state.failures - 1), MAX_RETRY_DELAY_MS);
  }

  private async loadHierarchy(node: OctreeNode): Promise<void> {
    if (node.hierarchyLoaded) return;
    const generation = this.diagnosticsGeneration;
    const startedAt = performance.now();
    this.diagnosticsState.hierarchyStarted++;
    const data = await this.fetchBytes('hierarchy.bin', node.hierarchyByteOffset, node.hierarchyByteSize);
    if (!this.disposed) parseHierarchyChunk(node, data);
    if (!this.disposed && generation === this.diagnosticsGeneration) {
      this.diagnosticsState.hierarchyCompleted++;
      this.diagnosticsState.hierarchyMs += performance.now() - startedAt;
    }
  }

  /** Fetch one byte range through the origin's gate. */
  private async fetchBytes(
    file: 'hierarchy.bin' | 'octree.bin', offset: bigint, size: bigint, signal = this.controller.signal,
  ): Promise<ArrayBuffer> {
    try {
      return await this.gate.request(() => fetchRange(
        new URL(file, this.metadataUrl), offset, size, this.fetcher, signal,
      ), this.retryDelayMs);
    } catch (error) {
      if (isThrottled(error) && !this.disposed) this.diagnosticsState.throttledResponses++;
      throw error;
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
   */
  private async loadBatch(nodes: OctreeNode[], onFetched?: () => void, signal?: AbortSignal): Promise<void> {
    if (this.disposed || nodes.length === 0) {
      onFetched?.();
      return;
    }
    const diagnosticsGeneration = this.diagnosticsGeneration;
    const cached: { node: OctreeNode; bytes: ArrayBuffer }[] = [];
    const missing: OctreeNode[] = [];
    for (const node of nodes) {
      const bytes = this.encodedCache.get(node);
      if (bytes) cached.push({ node, bytes });
      else missing.push(node);
    }
    const batches = makeNodeBatches(missing);
    let fetching = batches.length;
    if (fetching === 0) onFetched?.();
    const fetched = () => { if (--fetching === 0) onFetched?.(); };
    // Each task's results follow the order of its node list.
    const taskNodes = batches.map(batch => batch.nodes);
    const tasks: Promise<{ name: string; attributes: DecodedNodeData }[]>[] =
      batches.map(batch => this.fetchAndDecodeBatch(batch, diagnosticsGeneration, fetched, signal));
    if (cached.length > 0) {
      taskNodes.push(cached.map(item => item.node));
      tasks.push(this.decodeCachedNodes(cached, diagnosticsGeneration));
    }
    const results = await Promise.all(tasks);
    if (this.disposed) return;
    for (const [task, decoded] of results.entries()) {
      const expected = taskNodes[task]!;
      for (const [index, item] of decoded.entries()) {
        const node = expected[index];
        if (node?.name !== item.name) throw new Error(`Unexpected decoded node ${item.name}`);
        this.state(node).queued = true;
        this.decodedQueue.push({ node, attributes: item.attributes, rank: 0 });
      }
    }
  }

  private async fetchAndDecodeBatch(batch: NodeBatch, diagnosticsGeneration: number,
    onFetched: () => void, signal?: AbortSignal): Promise<{ name: string; attributes: DecodedNodeData }[]> {
    const statsGeneration = this.fetchStatsGeneration;
    const startedAt = performance.now();
    this.activeDecodeBatches++;
    if (diagnosticsGeneration === this.diagnosticsGeneration) this.diagnosticsState.startedBatches++;
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
      if (this.encodedCache.maxBytes > 0) {
        for (const node of batch.nodes) {
          const at = Number(node.byteOffset - batch.start);
          this.encodedCache.put(node, bytes.slice(at, at + Number(node.byteSize)));
        }
      }
      const decoded = await this.decoder.decodeBatch(
        bytes, batch.start,
        batch.nodes.map(node => ({
          name: node.name, pointCount: node.numPoints, offset: node.byteOffset, size: node.byteSize, origin: nodeOrigin(node),
        })),
        this.metadata, timing => this.noteDecodeTiming(timing, diagnosticsGeneration),
        this.decodedAttributes, this.controller.signal,
      );
      if (!this.disposed && statsGeneration === this.fetchStatsGeneration) {
        this.fetchStatsState.rangeRequests++;
        this.fetchStatsState.fetchedNodes += batch.nodes.length;
      }
      if (!this.disposed && diagnosticsGeneration === this.diagnosticsGeneration) {
        this.diagnosticsState.completedBatches++;
        this.diagnosticsState.loadedNodes += batch.nodes.length;
        this.diagnosticsState.lastBatchDoneSeconds = (performance.now() - this.diagnosticsStartedAt) / 1000;
      }
      return decoded;
    } finally {
      this.activeDecodeBatches--;
    }
  }

  private decodeCachedNodes(cached: { node: OctreeNode; bytes: ArrayBuffer }[],
    diagnosticsGeneration: number): Promise<{ name: string; attributes: DecodedNodeData }[]> {
    const size = cached.reduce((sum, item) => sum + item.bytes.byteLength, 0);
    const combined = new Uint8Array(size);
    const requests = [];
    let offset = 0;
    for (const { node, bytes } of cached) {
      combined.set(new Uint8Array(bytes), offset);
      requests.push({
        name: node.name, pointCount: node.numPoints, offset: BigInt(offset), size: BigInt(bytes.byteLength),
        origin: nodeOrigin(node),
      });
      offset += bytes.byteLength;
    }
    return this.decoder.decodeBatch(combined.buffer, 0n, requests, this.metadata,
      timing => this.noteDecodeTiming(timing, diagnosticsGeneration), this.decodedAttributes, this.controller.signal);
  }

  /**
   * Turn up to `limit` decoded nodes of any cloud into scene objects, spreading geometry
   * creation across frames. Returns true when at least one node was added.
   */
  private static installDecodedNodes(clouds: readonly PotreeV2PointCloud[], limit: number): boolean {
    const waiting = clouds.filter(cloud => cloud.decodedQueue.length > 0);
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
      for (const item of cloud.decodedQueue) item.rank = rank.get(item.node) ?? Number.MAX_SAFE_INTEGER;
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

  private installNode({ node, attributes }: { node: OctreeNode; attributes: DecodedNodeData }): void {
    const geometry = createNodeGeometry(attributes, node.box);
    const points = new Points(geometry, this.material);
    points.name = node.name;
    // Positions are relative to the node's minimum; the large offset stays in double-precision matrices.
    points.position.copy(node.box.min);
    points.matrixAutoUpdate = false;
    points.updateMatrix();
    points.visible = false;
    points.frustumCulled = false;
    this.group.add(points);
    const state = this.state(node);
    state.queued = false;
    state.points = points;
    state.displayedAt = displayStamp;
    this.installed.set(node, state);
    this.cachedPoints += node.numPoints;
    this.diagnosticsState.sceneConversions++;
    this.diagnosticsState.lastSceneConversionSeconds = (performance.now() - this.diagnosticsStartedAt) / 1000;
  }

  private ensureBoxHelper(node: OctreeNode, state: NodeState): LineSegments {
    if (!state.boxHelper) {
      const helper = new LineSegments(this.boxGeometry, this.boxMaterial);
      helper.name = `${node.name} bounding box`;
      node.box.getCenter(helper.position);
      node.box.getSize(helper.scale);
      helper.frustumCulled = false; // The corresponding points were already selected.
      this.group.add(helper);
      state.boxHelper = helper;
    }
    return state.boxHelper;
  }

  private requestHierarchy(node: OctreeNode, limits: UpdateLimits): void {
    const state = this.state(node);
    const slots = limits.slots;
    if (state.loading || this.waitingToRetry(state) || slots.inFlight >= limits.maxConcurrentLoads ||
        this.gate.available() <= 0) return;
    slots.inFlight++;
    this.inFlight++;
    state.loading = this.loadHierarchy(node).then(() => {
      state.failures = 0;
    }, error => {
      // A throttled node is not at fault: the gate pauses the origin and update() retries it.
      if (!this.disposed && !isAbort(error) && !isThrottled(error)) {
        this.noteFailure(state);
        this.onError?.(error instanceof Error ? error : new Error(String(error)), node.name);
      }
    }).finally(() => {
      state.loading = undefined;
      slots.inFlight--;
      this.inFlight--;
      this.releaseState(node, state);
    });
  }

  private ownLimits(): UpdateLimits {
    return {
      pointBudget: this.pointBudget, cachePointBudget: this.cachePointBudget,
      maxConcurrentLoads: this.maxConcurrentLoads, maxNodesToGPUPerFrame: this.maxNodesToGPUPerFrame,
      slots: this.ownSlots,
    };
  }

  /**
   * Start the most important batches of all clouds while request slots are free.
   * Network and decoding overlap: a batch frees its request slot once its bytes
   * arrive, while fetched bytes waiting for a Worker are bounded by the pool's backlog.
   */
  private static requestBatches(
    work: readonly { cloud: PotreeV2PointCloud; pending: OctreeNode[] }[], limits: UpdateLimits,
  ): void {
    if (limits.slots.inFlight >= limits.maxConcurrentLoads) return;
    const plans = work.flatMap(({ cloud, pending }) => cloud.planBatches(pending));
    plans.sort((a, b) => a.rank - b.rank);
    for (const { cloud, batch } of plans) {
      if (limits.slots.inFlight >= limits.maxConcurrentLoads) break;
      const decoder = cloud.decoder;
      if (cloud.gate.available() <= 0 || decoder.backlog >= decoder.maxWorkers * 2) continue;
      cloud.startBatch(batch, limits.slots);
    }
  }

  /** Group this cloud's first loadable nodes into batches ranked by their best selection rank. */
  private planBatches(nodes: OctreeNode[]): BatchPlan[] {
    if (nodes.length === 0 || this.decodedQueue.length >= MAX_DECODED_QUEUE) return [];
    // Limit grouping work on each frame. Selection order already reflects visual priority,
    // so the first 64 loadable nodes are the ones that matter.
    const candidates: OctreeNode[] = [];
    for (const node of nodes) {
      const state = this.states.get(node);
      if (!state || (!state.points && !state.loading && !state.queued && !this.waitingToRetry(state))) {
        if (candidates.push(node) >= 64) break;
      }
    }
    // Nodes outside the last selection keep the order they were given in, after selected ones.
    const rank = new Map(candidates.map((node, index) => [node, this.selectionRank.get(node) ?? 2 ** 40 + index]));
    return makeNodeBatches(candidates).map(batch => ({
      cloud: this, batch, rank: Math.min(...batch.nodes.map(node => rank.get(node)!)),
    }));
  }

  private startBatch(batch: NodeBatch, slots: LoadSlots): void {
    slots.inFlight++;
    this.inFlight++;
    this.activeLoads++;
    const request: BatchRequest = { nodes: batch.nodes, controller: new AbortController(), wantedAt: performance.now() };
    this.fetchingRequests.add(request);
    let fetching = true;
    const releaseRequest = () => {
      if (!fetching) return;
      fetching = false;
      this.fetchingRequests.delete(request);
      slots.inFlight--;
      this.inFlight--;
    };
    const states = batch.nodes.map(node => this.state(node));
    const promise = this.loadBatch(batch.nodes, releaseRequest, request.controller.signal).then(() => {
      for (const state of states) state.failures = 0;
    }, error => {
      if (!this.disposed && !isAbort(error) && !isThrottled(error)) {
        for (const [index, node] of batch.nodes.entries()) {
          this.noteFailure(states[index]!);
          this.onError?.(error instanceof Error ? error : new Error(String(error)), node.name);
        }
      }
    }).finally(() => {
      for (const [index, node] of batch.nodes.entries()) {
        states[index]!.loading = undefined;
        this.releaseState(node, states[index]!);
      }
      releaseRequest();
      this.activeLoads--;
    });
    for (const state of states) state.loading = promise;
  }

  /**
   * Recompute visible nodes and start background loads. Call once per render frame.
   * Returns true when the scene changed and should be rendered again. When the view,
   * viewport and settings are unchanged and all loads have settled, the traversal is skipped.
   * A cloud added to a PotreeV2PointCloudSet is updated through the set instead.
   */
  update(camera: Camera, viewportHeight: number): boolean {
    if (cloudSets.has(this)) {
      throw new Error('This point cloud belongs to a PotreeV2PointCloudSet; call the set\'s update() instead');
    }
    return updatePointClouds([this], camera, viewportHeight, this.ownLimits(), false);
  }

  static {
    updatePointClouds = (clouds, camera, viewportHeight, limits, force) =>
      PotreeV2PointCloud.updateAll(clouds, camera, viewportHeight, limits, force);
  }

  private static updateAll(
    clouds: readonly PotreeV2PointCloud[], camera: Camera, viewportHeight: number, limits: UpdateLimits, force: boolean,
  ): boolean {
    const { pointBudget, cachePointBudget } = limits;
    const active = clouds.filter(cloud => !cloud.disposed);
    if (active.length === 0) return false;
    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return false;
    camera.updateMatrixWorld();
    let unchanged = !force;
    for (const cloud of active) {
      if (!cloud.prepareView(camera, viewportHeight, pointBudget, cachePointBudget)) unchanged = false;
    }
    if (unchanged) {
      for (const cloud of active) cloud.finishLoadDiagnostics();
      return false;
    }
    const stamp = ++displayStamp;
    // One heap across clouds: the budget goes to the largest projected nodes of any cloud, as in Potree.
    const candidates = sharedCandidates;
    const traversals = active.map(cloud => cloud.beginTraversal(camera, candidates));
    let pointsUsed = 0;
    let selectedCount = 0;
    while (candidates.size > 0) {
      const { node, traversal } = candidates.pop();
      const cloud = traversal.cloud;
      if (node.numPoints > 0) {
        // Candidates arrive largest first, so every remaining node would be less
        // important than the one that no longer fits: stop, as Potree does.
        if (pointsUsed + node.numPoints > pointBudget && selectedCount > 0) break;
        pointsUsed += node.numPoints;
        cloud.selectionRank.set(node, selectedCount++);
        traversal.selected.add(node);
      }
      if (node.type === 2 && !node.hierarchyLoaded) {
        traversal.hierarchyPending++;
        cloud.requestHierarchy(node, limits);
        continue;
      }
      if (node.numPoints > 0) traversal.pending.push(node);
      cloud.pushChildren(node, traversal, camera, viewportHeight, candidates);
    }
    candidates.clear();
    for (const { cloud, selected } of traversals) cloud.abortStaleRequests(selected);
    let changed = PotreeV2PointCloud.installDecodedNodes(active, limits.maxNodesToGPUPerFrame);
    PotreeV2PointCloud.requestBatches(traversals, limits);
    for (const traversal of traversals) {
      if (traversal.cloud.finishTraversal(traversal, stamp)) changed = true;
    }
    if (PotreeV2PointCloud.evictLeastRecent(traversals, cachePointBudget)) changed = true;
    for (const { cloud, sceneReady } of traversals) {
      cloud.settled = sceneReady && cloud.decodedQueue.length === 0 && cloud.inFlight === 0 && cloud.activeLoads === 0;
    }
    return changed;
  }

  /** Compute this frame's view; returns true when it and the settings match a settled previous update. */
  private prepareView(camera: Camera, viewportHeight: number, pointBudget: number, cachePointBudget: number): boolean {
    this.group.updateWorldMatrix(true, false);
    const projection = this.projection
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .multiply(this.group.matrixWorld);
    const unchanged = this.settled && projection.equals(this.lastView) && viewportHeight === this.lastViewportHeight &&
      pointBudget === this.lastPointBudget && cachePointBudget === this.lastCachePointBudget &&
      this.minNodePixelSize === this.lastMinNodePixelSize && this.showBoundingBoxes === this.lastShowBoundingBoxes;
    this.lastView.copy(projection);
    this.lastViewportHeight = viewportHeight;
    this.lastPointBudget = pointBudget;
    this.lastCachePointBudget = cachePointBudget;
    this.lastMinNodePixelSize = this.minNodePixelSize;
    this.lastShowBoundingBoxes = this.showBoundingBoxes;
    return unchanged;
  }

  private beginTraversal(camera: Camera, candidates: CandidateHeap): Traversal {
    this.encodedCache.trim();
    camera.getWorldPosition(this.cameraPosition);
    this.frustum.setFromProjectionMatrix(this.projection);
    this.selectionRank.clear();
    const traversal: Traversal = { cloud: this, selected: new Set(), pending: [], hierarchyPending: 0, sceneReady: false };
    // Nodes outside the view are never queued, so the heap only holds visible candidates.
    if (this.frustum.intersectsBox(this.root.box)) candidates.push({ node: this.root, pixels: Infinity, traversal });
    return traversal;
  }

  private pushChildren(
    node: OctreeNode, traversal: Traversal, camera: Camera, viewportHeight: number, candidates: CandidateHeap,
  ): void {
    for (const child of node.children) {
      if (!child || !this.frustum.intersectsBox(child.box)) continue;
      const radius = projectedRadius(
        camera, this.cameraPosition, child.box, this.group.matrixWorld, this.projectedSphere, viewportHeight,
      );
      if (radius >= this.minNodePixelSize) candidates.push({ node: child, pixels: radius, traversal });
    }
  }

  /** Show one cloud's selection; returns true when its scene changed. */
  private finishTraversal(traversal: Traversal, stamp: number): boolean {
    const changed = this.updateDisplayedNodes(traversal.selected, stamp);
    traversal.sceneReady = this.updateLoadDiagnostics(traversal.selected, traversal.hierarchyPending);
    return changed;
  }

  /** Abort octree requests still fetching when the view has not needed any of their nodes for a while. */
  private abortStaleRequests(selected: Set<OctreeNode>): void {
    const now = performance.now();
    for (const request of this.fetchingRequests) {
      if (request.nodes.some(node => selected.has(node))) {
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
  private updateDisplayedNodes(selected: Set<OctreeNode>, stamp: number): boolean {
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
      show(state.points, true);
      if (this.showBoundingBoxes && !state.boxHelper) changed = true;
      show(this.showBoundingBoxes ? this.ensureBoxHelper(node, state) : state.boxHelper, this.showBoundingBoxes);
      state.displayedAt = stamp;
      this.installed.delete(node);
      this.installed.set(node, state);
      displayed.add(node);
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
    type Cursor = { traversal: Traversal; entries: Iterator<[OctreeNode, NodeState]>; head?: [OctreeNode, NodeState] };
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
    const cursors = traversals.map(traversal => {
      const cursor: Cursor = { traversal, entries: traversal.cloud.installed.entries() };
      advance(cursor);
      return cursor;
    });
    let evicted = false;
    while (total > budget) {
      let oldest: Cursor | undefined;
      for (const cursor of cursors) {
        if (cursor.head && (!oldest || cursor.head[1].displayedAt < oldest.head![1].displayedAt)) oldest = cursor;
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
    this.cachedPoints -= node.numPoints;
    this.releaseState(node, state);
  }

  /**
   * Find the point drawn at `x`, `y` (CSS pixels from the canvas' top-left corner)
   * among the nodes displayed by the last `update()`. The IDs are rendered on the GPU
   * and read back asynchronously; attribute values come from the decoded arrays.
   */
  async pick(
    renderer: WebGLRenderer, camera: Camera, x: number, y: number, options: PotreeV2PickOptions = {},
  ): Promise<PotreeV2PickResult | null> {
    if (this.disposed) return null;
    const targets: PickTarget[] = [];
    for (const node of this.displayed) {
      const points = this.installed.get(node)?.points;
      if (points?.visible) targets.push({ node, points });
    }
    this.group.updateWorldMatrix(true, false);
    this.picker ??= new PointPicker();
    const hit = await this.picker.pick(
      renderer, camera, targets, this.group.matrixWorld, x, y, this.material.size, options.radius ?? 0,
    );
    if (!hit || this.disposed) return null;
    return this.pickResult(hit, renderer.getPixelRatio());
  }

  private pickResult({ target, index, distance }: PickHit, pixelRatio: number): PotreeV2PickResult {
    const geometry = target.points.geometry;
    // Node-relative position to the cloud's local space, where boundingBox.min is the origin.
    const position = new Vector3().fromBufferAttribute(geometry.getAttribute('position'), index)
      .applyMatrix4(target.points.matrix);
    const min = this.metadata.boundingBox.min;
    const attributes: Record<string, number[]> = {};
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      if (name === 'position') continue;
      const { array, itemSize } = attribute;
      // color carries an opaque alpha byte that is not part of the source rgb attribute.
      const values = Array.from(array.slice(index * itemSize, (index + 1) * itemSize));
      if (name === 'color') attributes.rgb = values.slice(0, 3);
      else attributes[name] = values;
    }
    return {
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
    this.states.clear();
    this.decodedQueue.length = 0;
    this.encodedCache.clear();
    this.material.dispose();
    this.picker?.dispose();
    this.boxGeometry.dispose();
    this.boxMaterial.dispose();
  }
}

function projectedRadius(
  camera: Camera, cameraPosition: Vector3, box: import('three').Box3,
  worldMatrix: Matrix4, sphere: Sphere, height: number,
): number {
  box.getBoundingSphere(sphere).applyMatrix4(worldMatrix);
  if (camera instanceof OrthographicCamera) return sphere.radius * height * camera.zoom / (camera.top - camera.bottom);
  if (camera instanceof PerspectiveCamera) {
    const distance = cameraPosition.distanceTo(sphere.center);
    if (distance < sphere.radius) return Infinity;
    return sphere.radius * height / (2 * distance * Math.tan(camera.fov * Math.PI / 360));
  }
  return Infinity;
}

export const loadPotreeV2 = PotreeV2PointCloud.load;
