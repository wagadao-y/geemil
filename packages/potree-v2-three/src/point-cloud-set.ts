import type { Camera, WebGLRenderer } from 'three';
import { EncodedNodeCache } from './encoded-cache.js';
import { cloudSets, LoadSlots, pickPointClouds, updatePointClouds } from './point-cloud.js';
import type { PotreeV2PickOptions, PotreeV2PickResult, PotreeV2PointCloud } from './point-cloud.js';

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
   * Byte limit for octree payloads before decoding, across the clouds whose own
   * encodedCacheByteBudget is above 0 (BROTLI clouds by default). Default: 128 MiB.
   */
  encodedCacheByteBudget?: number;
}

/**
 * Point clouds that share one point budget, decoded and encoded caches, request limit and
 * per-frame installation limit, as Potree's global budget does. The largest projected nodes of
 * any cloud are selected, requested and installed first, and the least recently
 * displayed nodes of any cloud are evicted first. Each cloud's own pointBudget,
 * cachePointBudget, maxConcurrentLoads, maxNodesToGPUPerFrame and the size of its
 * encodedCacheByteBudget are ignored while it belongs to the set; add each cloud's `group`
 * to the scene as usual and call the set's `update()` once per frame. `pick()` tests the
 * clouds together, so a point behind another cloud's points is not hit. Decoder Workers
 * are shared by every cloud anyway.
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

  constructor(options: PotreeV2PointCloudSetOptions = {}) {
    this.pointBudget = options.pointBudget ?? 2_000_000;
    this.cachePointBudgetOverride = options.cachePointBudget;
    this.maxConcurrentLoads = Math.max(1, Math.floor(options.maxConcurrentLoads ?? 6));
    this.maxNodesToGPUPerFrame = Math.max(1, Math.floor(options.maxNodesToGPUPerFrame ?? 8));
    this.encodedCache = new EncodedNodeCache(options.encodedCacheByteBudget ?? 128 * 1024 * 1024);
  }

  /** Byte limit for encoded octree nodes across the clouds; setting 0 disables that cache. */
  get encodedCacheByteBudget(): number { return this.encodedCache.maxBytes; }
  set encodedCacheByteBudget(value: number) {
    this.encodedCache.maxBytes = value;
    this.encodedCache.trim();
  }

  /** Decoded point limit across clouds; follows pointBudget unless explicitly overridden. */
  get cachePointBudget(): number { return this.cachePointBudgetOverride ?? this.pointBudget * 2; }
  set cachePointBudget(value: number) { this.cachePointBudgetOverride = value; }

  get clouds(): readonly PotreeV2PointCloud[] { return this.members; }

  /**
   * A cloud belongs to at most one set; disposing it removes it. The encoded nodes it cached
   * on its own are dropped, as are those it cached in the set when it is removed.
   */
  add(cloud: PotreeV2PointCloud): void {
    const owner = cloudSets.get(cloud);
    if (owner === this) return;
    if (owner) throw new Error('This point cloud already belongs to another PotreeV2PointCloudSet');
    cloud.dropEncodedNodes(this.encodedCache);
    cloud.invalidateSelection();
    cloudSets.set(cloud, this);
    this.members.push(cloud);
    this.membershipChanged = true;
  }

  remove(cloud: PotreeV2PointCloud): boolean {
    const index = this.members.indexOf(cloud);
    if (index < 0) return false;
    this.members.splice(index, 1);
    cloudSets.delete(cloud);
    cloud.dropEncodedNodes(this.encodedCache);
    // Its last selection shared the set's budget; on its own it may select more.
    cloud.invalidateSelection();
    this.membershipChanged = true;
    return true;
  }

  /**
   * Recompute visible nodes of every cloud and start background loads. Call once per
   * render frame. Returns true when any cloud's nodes, clipping or layers changed.
   * After changing materials, request a render in the application.
   */
  update(camera: Camera, viewportHeight: number): boolean {
    const force = this.membershipChanged;
    this.membershipChanged = false;
    return updatePointClouds(this.members, camera, viewportHeight, {
      pointBudget: this.pointBudget, cachePointBudget: this.cachePointBudget,
      maxConcurrentLoads: this.maxConcurrentLoads, maxNodesToGPUPerFrame: this.maxNodesToGPUPerFrame,
      slots: this.slots,
    }, force);
  }

  /**
   * Find the point drawn at `x`, `y` (CSS pixels from the canvas' top-left corner) among the
   * nodes every visible cloud displayed at the last `update()`. The clouds are drawn together
   * with depth testing, so the nearest point of any cloud hits; `cloud` of the result tells
   * which. Otherwise as PotreeV2PointCloud.pick().
   */
  pick(
    renderer: WebGLRenderer, camera: Camera, x: number, y: number, options: PotreeV2PickOptions = {},
  ): Promise<PotreeV2PickResult | null> {
    return pickPointClouds(this.members, renderer, camera, x, y, options);
  }
}
