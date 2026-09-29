import type { Camera } from 'three';
import { cloudSets, LoadSlots, updatePointClouds } from './point-cloud.js';
import type { PotreeV2PointCloud } from './point-cloud.js';

export interface PotreeV2PointCloudSetOptions {
  /** Maximum points selected for display per update, across all clouds. Default: 2,000,000. */
  pointBudget?: number;
  /** Override the decoded cache limit across all clouds. Default: twice the current pointBudget. */
  cachePointBudget?: number;
  /** Simultaneous HTTP range requests across all clouds. Default: 6. */
  maxConcurrentLoads?: number;
  /** Maximum decoded nodes of all clouds installed as Three.js objects per update. Default: 8. */
  maxNodesToGPUPerFrame?: number;
}

/**
 * Point clouds that share one point budget, decoded cache, request limit and per-frame
 * installation limit, as Potree's global budget does. The largest projected nodes of
 * any cloud are selected, requested and installed first, and the least recently
 * displayed nodes of any cloud are evicted first. Each cloud's own pointBudget,
 * cachePointBudget, maxConcurrentLoads and maxNodesToGPUPerFrame are ignored while it
 * belongs to the set; add each cloud's `group` to the scene as usual and call the
 * set's `update()` once per frame. Decoder Workers are shared by every cloud anyway.
 */
export class PotreeV2PointCloudSet {
  pointBudget: number;
  maxConcurrentLoads: number;
  maxNodesToGPUPerFrame: number;
  private cachePointBudgetOverride?: number;
  private readonly slots = new LoadSlots();
  private readonly members: PotreeV2PointCloud[] = [];
  /** Membership changed: traverse even when every cloud's view is unchanged. */
  private membershipChanged = false;

  constructor(options: PotreeV2PointCloudSetOptions = {}) {
    this.pointBudget = options.pointBudget ?? 2_000_000;
    this.cachePointBudgetOverride = options.cachePointBudget;
    this.maxConcurrentLoads = Math.max(1, Math.floor(options.maxConcurrentLoads ?? 6));
    this.maxNodesToGPUPerFrame = Math.max(1, Math.floor(options.maxNodesToGPUPerFrame ?? 8));
  }

  /** Decoded point limit across clouds; follows pointBudget unless explicitly overridden. */
  get cachePointBudget(): number { return this.cachePointBudgetOverride ?? this.pointBudget * 2; }
  set cachePointBudget(value: number) { this.cachePointBudgetOverride = value; }

  get clouds(): readonly PotreeV2PointCloud[] { return this.members; }

  /** A cloud belongs to at most one set; disposing it removes it. */
  add(cloud: PotreeV2PointCloud): void {
    const owner = cloudSets.get(cloud);
    if (owner === this) return;
    if (owner) throw new Error('This point cloud already belongs to another PotreeV2PointCloudSet');
    cloudSets.set(cloud, this);
    this.members.push(cloud);
    this.membershipChanged = true;
  }

  remove(cloud: PotreeV2PointCloud): boolean {
    const index = this.members.indexOf(cloud);
    if (index < 0) return false;
    this.members.splice(index, 1);
    cloudSets.delete(cloud);
    this.membershipChanged = true;
    return true;
  }

  /**
   * Recompute visible nodes of every cloud and start background loads. Call once per
   * render frame. Returns true when any cloud's scene changed and should be rendered again.
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
}
