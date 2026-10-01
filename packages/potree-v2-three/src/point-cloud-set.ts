import type { Camera, WebGLRenderer } from 'three';
import { EncodedNodeCache } from './encoded-cache.js';
import { LoadWaiters } from './load-waiters.js';
import {
  cloudSets,
  LoadSlots,
  pickPointClouds,
  updatePointClouds,
  validViewportHeight,
} from './point-cloud.js';
import type {
  PotreeV2PickOptions,
  PotreeV2PickResult,
  PotreeV2PointCloud,
  UpdateLimits,
} from './point-cloud.js';

export interface PotreeV2PointCloudSetOptions {
  /** Maximum points selected for display per update, across all clouds. Default: 2,000,000. */
  pointBudget?: number;
  /** Override the decoded cache limit across all clouds. Default: twice the current pointBudget. */
  cachePointBudget?: number;
  /** Simultaneous HTTP range requests across all clouds. Default: 6. */
  maxConcurrentLoads?: number;
  /** Maximum decoded nodes of all clouds installed as Three.js objects per update. Default: 8. */
  maxNodesToGPUPerFrame?: number;
  /**
   * Byte limit for octree payloads before decoding, across the clouds whose
   * cacheEncodedNodes is true (BROTLI URLs by default); 0 disables it. Default: 128 MiB.
   */
  encodedCacheByteBudget?: number;
}

/**
 * Selects, loads and evicts the nodes of its point clouds under one point budget, decoded and
 * encoded caches, request limit and per-frame installation limit, as Potree's global budget
 * does. Clouds own no such limits: even a single cloud is displayed through a set. The largest
 * projected nodes of any cloud are selected, requested and installed first, and the least
 * recently displayed nodes of any cloud are evicted first. Add each cloud's `group` to the
 * scene as usual and call the set's `update()` once per frame. `pick()` tests the clouds
 * together, so a point behind another cloud's points is not hit. Decoder Workers are shared
 * by every cloud of any set.
 */
export class PotreeV2PointCloudSet {
  pointBudget: number;
  maxConcurrentLoads: number;
  maxNodesToGPUPerFrame: number;
  private cachePointBudgetOverride?: number;
  private readonly slots = new LoadSlots();
  /** @internal */
  readonly encodedCache: EncodedNodeCache;
  private readonly members: PotreeV2PointCloud[] = [];
  /** Membership changed: traverse even when every cloud's view is unchanged. */
  private membershipChanged = false;
  private readonly loadWaiters = new LoadWaiters();

  constructor(options: PotreeV2PointCloudSetOptions = {}) {
    this.pointBudget = options.pointBudget ?? 2_000_000;
    this.cachePointBudgetOverride = options.cachePointBudget;
    this.maxConcurrentLoads = Math.max(1, Math.floor(options.maxConcurrentLoads ?? 6));
    this.maxNodesToGPUPerFrame = Math.max(1, Math.floor(options.maxNodesToGPUPerFrame ?? 8));
    this.encodedCache = new EncodedNodeCache(options.encodedCacheByteBudget ?? 128 * 1024 * 1024);
  }

  /** Byte limit for encoded octree nodes across the clouds; setting 0 disables that cache. */
  get encodedCacheByteBudget(): number {
    return this.encodedCache.maxBytes;
  }
  set encodedCacheByteBudget(value: number) {
    this.encodedCache.maxBytes = value;
    this.encodedCache.trim();
  }

  /** Decoded point limit across clouds; follows pointBudget unless explicitly overridden. */
  get cachePointBudget(): number {
    return this.cachePointBudgetOverride ?? this.pointBudget * 2;
  }
  set cachePointBudget(value: number) {
    this.cachePointBudgetOverride = value;
  }

  get clouds(): readonly PotreeV2PointCloud[] {
    return this.members;
  }

  /** True while any cloud of the set is `loading`; an empty set is not. */
  get loading(): boolean {
    return this.members.some((cloud) => cloud.loading);
  }

  /**
   * Resolves at the end of the next update() after which no cloud of the set is `loading`,
   * as PotreeV2PointCloud.whenLoaded() does. Rejects with the signal's reason when `signal` aborts.
   */
  whenLoaded(options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.loadWaiters.wait(options.signal);
  }

  /**
   * A cloud belongs to at most one set; disposing it removes it. Its nodes stay as they are
   * until the set's next update().
   */
  add(cloud: PotreeV2PointCloud): void {
    const owner = cloudSets.get(cloud);
    if (owner === this) return;
    if (owner) throw new Error('This point cloud already belongs to another PotreeV2PointCloudSet');
    cloud.invalidateSelection();
    cloudSets.set(cloud, this);
    this.members.push(cloud);
    this.membershipChanged = true;
  }

  /**
   * Stop updating `cloud` and drop its encoded nodes from the set's cache. Its displayed nodes
   * stay in its `group`, unchanged, until it is added to a set again.
   */
  remove(cloud: PotreeV2PointCloud): boolean {
    const index = this.members.indexOf(cloud);
    if (index < 0) return false;
    this.members.splice(index, 1);
    cloudSets.delete(cloud);
    this.encodedCache.deleteOwner(cloud);
    // Its last selection used this set's budget; another set may select differently.
    cloud.invalidateSelection();
    this.membershipChanged = true;
    return true;
  }

  /**
   * Recompute visible nodes of every cloud and start background loads. Call once per render
   * frame. Returns true when any cloud's nodes, clipping or layers changed and should be
   * rendered again. After changing materials (size, color, classification, etc.), request a
   * render in the application. When the view, viewport and settings are unchanged and all
   * loads have settled, the traversal is skipped. Node objects take the layers of their
   * cloud's `group`. While a `group` or an ancestor is hidden, that cloud selects and loads nothing.
   */
  update(camera: Camera, viewportHeight: number): boolean {
    const force = this.membershipChanged;
    this.membershipChanged = false;
    const changed = updatePointClouds(this.members, camera, viewportHeight, this.limits(), force);
    if (validViewportHeight(viewportHeight) && !this.loading) this.loadWaiters.resolveAll();
    return changed;
  }

  /** @internal */
  limits(): UpdateLimits {
    return {
      pointBudget: this.pointBudget,
      cachePointBudget: this.cachePointBudget,
      maxConcurrentLoads: this.maxConcurrentLoads,
      maxNodesToGPUPerFrame: this.maxNodesToGPUPerFrame,
      slots: this.slots,
    };
  }

  /**
   * Find the point drawn at `x`, `y` (CSS pixels from the canvas' top-left corner) among the
   * nodes every visible cloud displayed at the last `update()`. The clouds are drawn together
   * with depth testing, so the nearest point of any cloud hits; `cloud` of the result tells
   * which. Otherwise as PotreeV2PointCloud.pick().
   */
  pick(
    renderer: WebGLRenderer,
    camera: Camera,
    x: number,
    y: number,
    options: PotreeV2PickOptions = {},
  ): Promise<PotreeV2PickResult | null> {
    return pickPointClouds(this.members, renderer, camera, x, y, options);
  }
}
