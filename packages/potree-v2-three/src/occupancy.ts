// Runs in the decoder Workers: keep this module free of Three.js imports.

/** Cells per axis of the occupancy grid, as in Potree's decoder. */
export const GRID = 32;
const occupiedCells = new Uint8Array(GRID ** 3);

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
