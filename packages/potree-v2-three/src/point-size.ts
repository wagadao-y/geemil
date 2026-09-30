import { DataTexture, NearestFilter, RGBAIntegerFormat, UnsignedIntType, Vector3 } from 'three';
import type { Box3 } from 'three';
import type { OctreeNode } from './format.js';

/**
 * `fixed`: `size` CSS pixels. `attenuated`: `size` times the root spacing, in world units.
 * `adaptive`: `size` times 1.7 × the spacing of the deepest displayed node at the point, in world units;
 * the level is corrected by the node's measured point density, as Potree's lodOffset.
 */
export type PotreeV2PointSizeType = 'fixed' | 'attenuated' | 'adaptive';

export interface PointSizeSettings {
  type: PotreeV2PointSizeType;
  /** CSS pixels for `fixed`, otherwise a factor of the spacing. */
  size: number;
  /** Limits in CSS pixels for `attenuated` and `adaptive`. */
  minSize: number;
  maxSize: number;
}

/** Deepest octree level walked from a node; Potree v2 hierarchies are far shallower. */
const MAX_DEPTH = 24;
const TEXTURE_WIDTH = 2048;
/** Cells per axis of the occupancy grid, as in Potree's decoder. */
const GRID = 32;
const occupiedCells = new Uint8Array(GRID ** 3);
/** Potree's calibration: its lodOffset is half a level deeper than the surface estimate. */
const POTREE_LOD_BIAS = 0.5;

/** A node's size along x, y and z, in the cloud's local units. */
export type NodeExtent = readonly [number, number, number];

/**
 * Points per occupied cell of a 32³ grid over a node, truncated to an integer as
 * Potree's decoder does; 0 without points. Positions are relative to the node's minimum.
 * The decoder Workers count it, so that installing a node does not walk its points.
 */
export function pointOccupancy(positions: ArrayLike<number>, extent: NodeExtent): number {
  const count = positions.length / 3;
  if (count === 0) return 0;
  const [sx, sy, sz] = extent;
  occupiedCells.fill(0);
  let occupied = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const ix = Math.min(GRID - 1, Math.max(0, Math.floor(positions[i]! / sx * GRID)));
    const iy = Math.min(GRID - 1, Math.max(0, Math.floor(positions[i + 1]! / sy * GRID)));
    const iz = Math.min(GRID - 1, Math.max(0, Math.floor(positions[i + 2]! / sz * GRID)));
    const cell = ix + (iy + iz * GRID) * GRID;
    if (occupiedCells[cell] === 0) {
      occupiedCells[cell] = 1;
      occupied++;
    }
  }
  return Math.floor(count / occupied);
}

/**
 * Levels to add to a node's level so that it matches the node's measured point spacing.
 * `occupancy` is pointOccupancy(), as Potree's; on a surface, n points in a cell of edge c
 * are about c / √n apart. An octree stops splitting where few points remain, not where they
 * are sparse, so a coarse leaf of a scan is often as dense as the deeper nodes around it;
 * without this, its points are drawn several times larger. With at least one point per
 * occupied cell, spacings above the cell edge read as the cell edge.
 * Matches Potree's `log2(occupancy) / 2 - 1.5` for PotreeConverter 2 output, whose spacing is
 * the root size / 128, including its truncated occupancy and half-level bias, so that the same
 * `size` looks the same as in Potree.
 */
export function occupancyLevelOffset(occupancy: number, extent: NodeExtent, level: number, rootSpacing: number): number {
  if (occupancy === 0) return 0;
  const [sx, sy, sz] = extent;
  const pointSpacing = Math.cbrt(sx * sy * sz) / GRID / Math.sqrt(occupancy);
  const levelSpacing = rootSpacing / 2 ** level;
  return Math.log2(levelSpacing / pointSpacing) + POTREE_LOD_BIAS;
}

/** occupancyLevelOffset() of a node's positions, relative to the minimum of `box`. */
export function densityLevelOffset(positions: ArrayLike<number>, box: Box3, level: number, rootSpacing: number): number {
  const extent = nodeExtent(box);
  return occupancyLevelOffset(pointOccupancy(positions, extent), extent, level, rootSpacing);
}

/** The size of a node's box. */
export function nodeExtent(box: Box3): NodeExtent {
  return [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z];
}

export const pointSizeVertexPars = /* glsl */`
uniform float size;
#if defined(POINT_SIZE_ATTENUATED) || defined(POINT_SIZE_ADAPTIVE)
uniform float minPointSize;
uniform float maxPointSize;
uniform float pointSpacing;
uniform float viewportHeight;
#endif
#ifdef POINT_SIZE_ADAPTIVE
// One texel per displayed node: child mask, index of its first displayed child and
// the float bits of its density level offset.
uniform highp usampler2D visibleNodes;
uniform highp uint nodeIndex;
uniform float nodeLevel;
uniform vec3 nodeSize;
// Level of the deepest displayed node containing a node-local position, as Potree's getLOD().
float displayedLevel(vec3 p) {
  highp uint index = nodeIndex;
  float level = nodeLevel;
  vec3 extent = nodeSize;
  for (int i = 0; i < ${MAX_DEPTH}; i++) {
    uvec3 entry = texelFetch(visibleNodes, ivec2(int(index % ${TEXTURE_WIDTH}u), int(index / ${TEXTURE_WIDTH}u)), 0).rgb;
    extent *= 0.5;
    uvec3 octant = uvec3(clamp(floor(p / extent), 0.0, 1.0));
    uint child = octant.x * 4u + octant.y * 2u + octant.z;
    if ((entry.r & (1u << child)) == 0u) return level + uintBitsToFloat(entry.b);
    // Displayed siblings are stored contiguously in child order.
    uint before = entry.r & ((1u << child) - 1u);
    uint skipped = 0u;
    for (int b = 0; b < 8; b++) skipped += (before >> uint(b)) & 1u;
    index = entry.g + skipped;
    p -= vec3(octant) * extent;
    level += 1.0;
  }
  return level;
}
#endif
float pointSize() {
#if defined(POINT_SIZE_ATTENUATED) || defined(POINT_SIZE_ADAPTIVE)
  // Device pixels per world unit at this depth; w is 1 for orthographic cameras.
  float scale = length(modelViewMatrix[0].xyz);
  float projFactor = projectionMatrix[1][1] * 0.5 * viewportHeight * scale / max(gl_Position.w, 1e-6);
  #ifdef POINT_SIZE_ADAPTIVE
  float worldSize = size * pointSpacing * 1.7 / exp2(displayedLevel(position));
  #else
  float worldSize = size * pointSpacing;
  #endif
  return clamp(worldSize * projFactor, minPointSize, maxPointSize);
#else
  return size;
#endif
}`;

/** Shader defines for a size type, shared by the display and pick materials. */
export function pointSizeDefines(type: PotreeV2PointSizeType): Record<string, string | false> {
  return {
    POINT_SIZE_ATTENUATED: type === 'attenuated' ? '' : false,
    POINT_SIZE_ADAPTIVE: type === 'adaptive' ? '' : false,
  };
}

/**
 * The displayed nodes of one cloud, level by level, so a shader can walk from a node
 * to the deepest displayed descendant at a position.
 */
export class VisibleNodesTexture {
  texture = VisibleNodesTexture.create(1);
  private readonly indices = new Map<OctreeNode, number>();

  /** Texture index of a node given to the last update(); 0 when absent. */
  index(node: OctreeNode): number { return this.indices.get(node) ?? 0; }

  /** `levelOffset` gives each node's densityLevelOffset(). */
  update(nodes: Iterable<OctreeNode>, levelOffset: (node: OctreeNode) => number): void {
    // Level order with siblings in child order, as Potree sorts node names.
    const sorted = [...nodes].sort((a, b) => a.level - b.level || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const rows = Math.max(1, Math.ceil(sorted.length / TEXTURE_WIDTH));
    if (this.texture.image.height < rows) {
      this.texture.dispose();
      this.texture = VisibleNodesTexture.create(2 ** Math.ceil(Math.log2(rows)));
    }
    const data = this.texture.image.data as Uint32Array;
    const floats = new Float32Array(data.buffer);
    this.indices.clear();
    sorted.forEach((node, i) => this.indices.set(node, i));
    for (const [i, node] of sorted.entries()) {
      let mask = 0;
      for (const [child, childNode] of node.children.entries()) {
        const childIndex = childNode && this.indices.get(childNode);
        if (childIndex === undefined) continue;
        if (mask === 0) data[i * 4 + 1] = childIndex;
        mask |= 1 << child;
      }
      data[i * 4] = mask;
      floats[i * 4 + 2] = levelOffset(node);
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void { this.texture.dispose(); }

  private static create(rows: number): DataTexture {
    const texture = new DataTexture(
      new Uint32Array(TEXTURE_WIDTH * rows * 4), TEXTURE_WIDTH, rows, RGBAIntegerFormat, UnsignedIntType,
    );
    texture.internalFormat = 'RGBA32UI';
    texture.minFilter = NearestFilter;
    texture.magFilter = NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }
}

/** Point size uniforms of one material. */
export class PointSizeUniforms {
  readonly uniforms = {
    size: { value: 1 },
    minPointSize: { value: 1 },
    maxPointSize: { value: 1 },
    pointSpacing: { value: 1 },
    viewportHeight: { value: 1 },
    visibleNodes: { value: null as DataTexture | null },
    nodeIndex: { value: 0 },
    nodeLevel: { value: 0 },
    nodeSize: { value: new Vector3() },
  };

  /** Write per-draw values; returns true when any uniform changed. */
  write(
    settings: PointSizeSettings, pixelRatio: number, viewportHeight: number, spacing: number,
    visibleNodes: DataTexture,
  ): boolean {
    const u = this.uniforms;
    // World-space sizes are projected with the viewport in device pixels, so only pixel sizes scale.
    const size = settings.type === 'fixed' ? settings.size * pixelRatio : settings.size;
    const minSize = settings.minSize * pixelRatio;
    const maxSize = settings.maxSize * pixelRatio;
    if (u.size.value === size && u.minPointSize.value === minSize && u.maxPointSize.value === maxSize &&
      u.viewportHeight.value === viewportHeight && u.pointSpacing.value === spacing && u.visibleNodes.value === visibleNodes) {
      return false;
    }
    u.size.value = size;
    u.minPointSize.value = minSize;
    u.maxPointSize.value = maxSize;
    u.viewportHeight.value = viewportHeight;
    u.pointSpacing.value = spacing;
    u.visibleNodes.value = visibleNodes;
    return true;
  }

  /** Write the node about to be drawn; returns true when any uniform changed. */
  writeNode(node: OctreeNode, index: number): boolean {
    const u = this.uniforms;
    const { min, max } = node.box;
    const extent = u.nodeSize.value;
    if (u.nodeIndex.value === index && u.nodeLevel.value === node.level &&
      extent.x === max.x - min.x && extent.y === max.y - min.y && extent.z === max.z - min.z) {
      return false;
    }
    u.nodeIndex.value = index;
    u.nodeLevel.value = node.level;
    extent.subVectors(max, min);
    return true;
  }
}
