import { Box3, Vector3 } from 'three';

export type PotreeAttributeType =
  | 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32'
  | 'int64' | 'uint64' | 'float' | 'double';

export interface PotreeAttribute {
  name: string;
  type: PotreeAttributeType;
  size: number;
  numElements: number;
  elementSize: number;
  min?: number[];
  max?: number[];
  scale?: number[];
  offset?: number[];
  description?: string;
}

export interface PotreeV2Metadata {
  version: string;
  name?: string;
  /**
   * `DEFAULT` stores the points uncompressed and `BROTLI` compresses them, as PotreeConverter
   * writes and Potree reads them.
   */
  encoding: 'DEFAULT' | 'BROTLI';
  projection?: string;
  points: number;
  spacing: number;
  scale: [number, number, number];
  offset: [number, number, number];
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  hierarchy: { firstChunkSize: number; stepSize?: number; depth?: number };
  attributes: PotreeAttribute[];
}

export interface OctreeNode {
  readonly name: string;
  readonly level: number;
  readonly box: Box3;
  readonly children: (OctreeNode | undefined)[];
  type: number;
  numPoints: number;
  byteOffset: bigint;
  byteSize: bigint;
  hierarchyByteOffset: bigint;
  hierarchyByteSize: bigint;
  hierarchyLoaded: boolean;
}

export function createRoot(metadata: PotreeV2Metadata): OctreeNode {
  const min = new Vector3(...metadata.boundingBox.min);
  const max = new Vector3(...metadata.boundingBox.max).sub(min);
  return {
    name: 'r', level: 0, box: new Box3(new Vector3(), max), children: [],
    type: 2, numPoints: 0, byteOffset: 0n, byteSize: 0n,
    hierarchyByteOffset: 0n,
    hierarchyByteSize: BigInt(metadata.hierarchy.firstChunkSize),
    hierarchyLoaded: false,
  };
}

function childBox(parent: Box3, index: number): Box3 {
  const box = parent.clone();
  const center = box.getCenter(new Vector3());
  if (index & 4) box.min.x = center.x; else box.max.x = center.x;
  if (index & 2) box.min.y = center.y; else box.max.y = center.y;
  if (index & 1) box.min.z = center.z; else box.max.z = center.z;
  return box;
}

/** Parse one 22-byte-record breadth-first hierarchy chunk. Proxy records point to other chunks. */
export function parseHierarchyChunk(root: OctreeNode, buffer: ArrayBuffer): void {
  if (buffer.byteLength === 0 || buffer.byteLength % 22 !== 0) {
    throw new Error(`Invalid Potree v2 hierarchy chunk size: ${buffer.byteLength}`);
  }
  const view = new DataView(buffer);
  const nodes: OctreeNode[] = [root];
  const count = buffer.byteLength / 22;
  for (let i = 0; i < count; i++) {
    const node = nodes[i];
    if (!node) throw new Error('Invalid Potree v2 hierarchy: missing child record');
    const at = i * 22;
    const type = view.getUint8(at);
    const mask = view.getUint8(at + 1);
    const points = view.getUint32(at + 2, true);
    const offset = view.getBigUint64(at + 6, true);
    const size = view.getBigUint64(at + 14, true);
    if (type > 2) throw new Error(`Invalid Potree v2 node type: ${type}`);
    if (node.type === 2 && i === 0) {
      // The first record replaces the proxy for this chunk's root.
      node.byteOffset = offset;
      node.byteSize = size;
    } else if (type === 2) {
      node.hierarchyByteOffset = offset;
      node.hierarchyByteSize = size;
    } else {
      node.byteOffset = offset;
      node.byteSize = size;
    }
    node.type = type;
    node.numPoints = type === 2 ? points : size === 0n ? 0 : points;
    if (type === 2) continue;
    for (let child = 0; child < 8; child++) {
      if (!(mask & (1 << child))) continue;
      const childNode: OctreeNode = {
        name: `${node.name}${child}`, level: node.level + 1,
        box: childBox(node.box, child), children: [],
        type: 2, numPoints: 0, byteOffset: 0n, byteSize: 0n,
        hierarchyByteOffset: 0n, hierarchyByteSize: 0n, hierarchyLoaded: false,
      };
      node.children[child] = childNode;
      nodes.push(childNode);
    }
  }
  if (nodes.length !== count) throw new Error('Invalid Potree v2 hierarchy: record count mismatch');
  root.hierarchyLoaded = true;
}

const typeSizes: Record<PotreeAttributeType, number> = {
  int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4,
  int64: 8, uint64: 8, float: 4, double: 8,
};

export function validateMetadata(value: unknown): PotreeV2Metadata {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid Potree metadata');
  const m = value as PotreeV2Metadata;
  if (m.version !== '2.0') throw new Error(`Expected Potree v2 metadata, got ${String(m.version)}`);
  if (m.encoding !== 'BROTLI' && m.encoding !== 'DEFAULT') {
    throw new Error(`Unsupported Potree v2 encoding: ${String(m.encoding)} (supported: DEFAULT, BROTLI)`);
  }
  if (!Array.isArray(m.attributes) || !m.attributes.some(a => a.name === 'position')) {
    throw new Error('Potree v2 metadata has no position attribute');
  }
  if (!Array.isArray(m.scale) || m.scale.length !== 3 ||
      !Array.isArray(m.offset) || m.offset.length !== 3 ||
      !Array.isArray(m.boundingBox?.min) || !Array.isArray(m.boundingBox?.max) ||
      !Number.isSafeInteger(m.hierarchy?.firstChunkSize) || m.hierarchy.firstChunkSize < 22) {
    throw new Error('Incomplete Potree v2 metadata');
  }
  for (const a of m.attributes) {
    if (!(a.type in typeSizes) || !Number.isInteger(a.numElements) || a.numElements < 1 ||
        a.elementSize !== typeSizes[a.type] || a.size !== a.numElements * a.elementSize) {
      throw new Error(`Invalid Potree v2 attribute: ${a.name}`);
    }
  }
  return m;
}
