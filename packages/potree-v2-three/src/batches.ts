import type { OctreeNode } from './format.js';

export interface NodeBatch {
  nodes: OctreeNode[];
  start: bigint;
  end: bigint;
}

/** Coalesce nearby byte ranges, bounded so sparse legacy octrees stay cheap to read. */
export function makeNodeBatches(nodes: OctreeNode[]): NodeBatch[] {
  const sorted = [...nodes].sort((a, b) => a.byteOffset < b.byteOffset ? -1 : a.byteOffset > b.byteOffset ? 1 : 0);
  const batches: NodeBatch[] = [];
  let wanted = 0n;
  let points = 0;
  for (const node of sorted) {
    const end = node.byteOffset + node.byteSize;
    let batch = batches[batches.length - 1];
    const nextEnd = batch && end > batch.end ? end : batch?.end ?? end;
    const gap = batch && node.byteOffset > batch.end ? node.byteOffset - batch.end : 0n;
    const span = batch ? nextEnd - batch.start : node.byteSize;
    const nextWanted = wanted + node.byteSize;
    if (!batch || batch.nodes.length >= 16 || points + node.numPoints > 500_000 ||
        span > 2n * 1024n * 1024n || gap > 32n * 1024n ||
        (span > nextWanted && (span - nextWanted) * 4n > span)) {
      batch = { nodes: [], start: node.byteOffset, end };
      batches.push(batch);
      wanted = 0n;
      points = 0;
    }
    batch.nodes.push(node);
    if (end > batch.end) batch.end = end;
    wanted += node.byteSize;
    points += node.numPoints;
  }
  return batches;
}
