import { Box3, Vector3 } from 'three';

export type PotreeV2AttributeType =
  | 'int8'
  | 'uint8'
  | 'int16'
  | 'uint16'
  | 'int32'
  | 'uint32'
  | 'int64'
  | 'uint64'
  | 'float'
  | 'double';

/** One attribute of metadata.json, read-only as the decoders and shaders were built from it. */
export interface PotreeV2Attribute {
  readonly name: string;
  readonly type: PotreeV2AttributeType;
  readonly size: number;
  readonly numElements: number;
  readonly elementSize: number;
  readonly min?: readonly number[];
  readonly max?: readonly number[];
  readonly scale?: readonly number[];
  readonly offset?: readonly number[];
  readonly description?: string;
}

/** metadata.json, read-only at every level: the octree, decoders and shaders were built from it. */
export interface PotreeV2Metadata {
  readonly version: string;
  readonly name?: string;
  /**
   * `DEFAULT` stores the points uncompressed and `BROTLI` compresses them, as PotreeConverter
   * writes and Potree reads them.
   */
  readonly encoding: 'DEFAULT' | 'BROTLI';
  readonly projection?: string;
  readonly points: number;
  readonly spacing: number;
  readonly scale: readonly [number, number, number];
  readonly offset: readonly [number, number, number];
  readonly boundingBox: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  readonly hierarchy: {
    readonly firstChunkSize: number;
    readonly stepSize?: number;
    readonly depth?: number;
  };
  readonly attributes: readonly PotreeV2Attribute[];
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
    name: 'r',
    level: 0,
    box: new Box3(new Vector3(), max),
    children: [],
    type: 2,
    numPoints: 0,
    byteOffset: 0n,
    byteSize: 0n,
    hierarchyByteOffset: 0n,
    hierarchyByteSize: BigInt(metadata.hierarchy.firstChunkSize),
    hierarchyLoaded: false,
  };
}

function childBox(parent: Box3, index: number): Box3 {
  const box = parent.clone();
  const center = box.getCenter(new Vector3());
  if (index & 4) box.min.x = center.x;
  else box.max.x = center.x;
  if (index & 2) box.min.y = center.y;
  else box.max.y = center.y;
  if (index & 1) box.min.z = center.z;
  else box.max.z = center.z;
  return box;
}

/** Parse one 22-byte-record breadth-first hierarchy chunk. Proxy records point to other chunks. */
export function parseHierarchyChunk(root: OctreeNode, buffer: ArrayBuffer): void {
  if (buffer.byteLength === 0 || buffer.byteLength % 22 !== 0) {
    throw new Error(`Invalid Potree v2 hierarchy chunk size: ${buffer.byteLength}`);
  }
  const view = new DataView(buffer);
  const count = buffer.byteLength / 22;
  // Validate the whole chunk before changing any node, so that a failed parse leaves the
  // tree as it was and the chunk is fetched again instead of leaving half-built nodes.
  let records = 1;
  for (let i = 0; i < count; i++) {
    if (i >= records) throw new Error('Invalid Potree v2 hierarchy: missing child record');
    const type = view.getUint8(i * 22);
    if (type > 2) throw new Error(`Invalid Potree v2 node type: ${type}`);
    if (type !== 2) records += childCount(view.getUint8(i * 22 + 1));
  }
  if (records !== count) throw new Error('Invalid Potree v2 hierarchy: record count mismatch');
  const nodes: OctreeNode[] = [root];
  for (let i = 0; i < count; i++) {
    const node = nodes[i]!;
    const at = i * 22;
    const type = view.getUint8(at);
    const mask = view.getUint8(at + 1);
    const points = view.getUint32(at + 2, true);
    const offset = view.getBigUint64(at + 6, true);
    const size = view.getBigUint64(at + 14, true);
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
        name: `${node.name}${child}`,
        level: node.level + 1,
        box: childBox(node.box, child),
        children: [],
        type: 2,
        numPoints: 0,
        byteOffset: 0n,
        byteSize: 0n,
        hierarchyByteOffset: 0n,
        hierarchyByteSize: 0n,
        hierarchyLoaded: false,
      };
      node.children[child] = childNode;
      nodes.push(childNode);
    }
  }
  root.hierarchyLoaded = true;
}

/** Children in a node's child mask. */
function childCount(mask: number): number {
  let count = 0;
  for (let bits = mask; bits !== 0; bits &= bits - 1) count++;
  return count;
}

const typeSizes: Record<PotreeV2AttributeType, number> = {
  int8: 1,
  uint8: 1,
  int16: 2,
  uint16: 2,
  int32: 4,
  uint32: 4,
  int64: 8,
  uint64: 8,
  float: 4,
  double: 8,
};

function isFiniteVector(value: readonly unknown[]): value is readonly [number, number, number] {
  return value.length === 3 && value.every(Number.isFinite);
}

export function validateMetadata(value: unknown): PotreeV2Metadata {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid Potree metadata');
  const m = value as PotreeV2Metadata;
  if (m.version !== '2.0') throw new Error(`Expected Potree v2 metadata, got ${String(m.version)}`);
  if (m.encoding !== 'BROTLI' && m.encoding !== 'DEFAULT') {
    throw new Error(
      `Unsupported Potree v2 encoding: ${String(m.encoding)} (supported: DEFAULT, BROTLI)`,
    );
  }
  // Array.isArray() narrows a readonly array to any[]; the checks go through unknown to keep the types.
  if (!Array.isArray(m.attributes as unknown) || !m.attributes.some((a) => a.name === 'position')) {
    throw new Error('Potree v2 metadata has no position attribute');
  }
  if (
    !Array.isArray(m.scale as unknown) ||
    !Array.isArray(m.offset as unknown) ||
    !Array.isArray(m.boundingBox?.min as unknown) ||
    !Array.isArray(m.boundingBox?.max as unknown) ||
    typeof m.hierarchy !== 'object' ||
    m.hierarchy === null
  ) {
    throw new Error('Incomplete Potree v2 metadata');
  }
  if (!isFiniteVector(m.scale) || !m.scale.every((value) => value > 0)) {
    throw new Error('Invalid Potree v2 metadata: scale must be three positive numbers');
  }
  if (!isFiniteVector(m.offset))
    throw new Error('Invalid Potree v2 metadata: offset must be three finite numbers');
  const { min, max } = m.boundingBox;
  if (
    !isFiniteVector(min) ||
    !isFiniteVector(max) ||
    !min.every((value, axis) => max[axis]! > value)
  ) {
    throw new Error(
      'Invalid Potree v2 metadata: boundingBox must have three finite axes with max above min',
    );
  }
  if (!Number.isFinite(m.spacing) || !(m.spacing > 0)) {
    throw new Error('Invalid Potree v2 metadata: spacing must be a positive number');
  }
  const { firstChunkSize } = m.hierarchy;
  if (!Number.isSafeInteger(firstChunkSize) || firstChunkSize < 22 || firstChunkSize % 22 !== 0) {
    throw new Error(
      'Invalid Potree v2 metadata: hierarchy.firstChunkSize must be a positive multiple of 22',
    );
  }
  for (const a of m.attributes) {
    if (
      !(a.type in typeSizes) ||
      !Number.isInteger(a.numElements) ||
      a.numElements < 1 ||
      a.elementSize !== typeSizes[a.type] ||
      a.size !== a.numElements * a.elementSize
    ) {
      throw new Error(`Invalid Potree v2 attribute: ${a.name}`);
    }
  }
  // The decoders read these two as PotreeConverter writes them, in both encodings.
  for (const [name, type] of [
    ['position', 'int32'],
    ['rgb', 'uint16'],
  ] as const) {
    const a = m.attributes.find((attribute) => attribute.name === name);
    if (a && (a.type !== type || a.numElements !== 3)) {
      throw new Error(
        `Unsupported Potree v2 ${name} attribute: expected 3 × ${type}, got ${a.numElements} × ${a.type}`,
      );
    }
  }
  return m;
}
