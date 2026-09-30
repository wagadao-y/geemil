import { Box3, BufferAttribute, BufferGeometry, Sphere } from 'three';
import type { OctreeNode, PotreeAttribute, PotreeAttributeType, PotreeV2Metadata } from './format.js';
import { decompressBrotli } from './brotli-codecs.js';

/** DataView reader for one element type, chosen once per attribute instead of per value. */
function elementReader(view: DataView, type: PotreeAttributeType): (at: number) => number {
  switch (type) {
    case 'int8': return at => view.getInt8(at);
    case 'uint8': return at => view.getUint8(at);
    case 'int16': return at => view.getInt16(at, true);
    case 'uint16': return at => view.getUint16(at, true);
    case 'int32': return at => view.getInt32(at, true);
    case 'uint32': return at => view.getUint32(at, true);
    case 'int64': return at => Number(view.getBigInt64(at, true));
    case 'uint64': return at => Number(view.getBigUint64(at, true));
    case 'float': return at => view.getFloat32(at, true);
    case 'double': return at => view.getFloat64(at, true);
  }
}

type NumberArrayConstructor = new (buffer: ArrayBufferLike, byteOffset: number, length: number) => ArrayLike<number>;

/** Views for element types readable in place; 64-bit integers need BigInt conversion. */
const typedArrays: Partial<Record<PotreeAttributeType, NumberArrayConstructor>> = {
  int8: Int8Array, uint8: Uint8Array, int16: Int16Array, uint16: Uint16Array,
  int32: Int32Array, uint32: Uint32Array, float: Float32Array, double: Float64Array,
};

/** Potree data is little-endian; typed array views use the platform's byte order. */
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * 8- and 16-bit integers keep their type: WebGL reads them as float attributes without
 * normalization, in a half or a quarter of the memory.
 */
const compactArrays: Partial<Record<PotreeAttributeType, new (length: number) => DecodedArray>> = {
  int8: Int8Array, uint8: Uint8Array, int16: Int16Array, uint16: Uint16Array,
};

/**
 * Decode an attribute other than position and rgb into floats, or into its own type for
 * 8- and 16-bit integers. `start` is the byte offset of the first point's value and
 * `pointStride` the bytes between points.
 */
function decodeGenericAttribute(
  data: Uint8Array, view: DataView, attribute: PotreeAttribute, pointCount: number,
  start: number, pointStride: number,
): DecodedArray {
  const { numElements, elementSize, type } = attribute;
  const count = pointCount * numElements;
  const values = new (compactArrays[type] ?? Float32Array)(count);
  // Preserve useful precision for 64-bit scalar values in a GPU float attribute.
  const min = attribute.min?.[0];
  const max = attribute.max?.[0];
  const normalize = elementSize === 8 && numElements === 1 && Number.isFinite(min) && Number.isFinite(max);
  const offset = normalize ? min! : 0;
  const span = normalize ? max! - min! : 1;
  if (span === 0) return values;

  // Contiguous, aligned values (Brotli columns, or a lone uncompressed attribute) are viewed in place.
  const NumberArray = littleEndian ? typedArrays[type] : undefined;
  const byteOffset = data.byteOffset + start;
  if (NumberArray && pointStride === attribute.size && byteOffset % elementSize === 0) {
    const source = new NumberArray(data.buffer, byteOffset, count);
    if (!normalize) values.set(source);
    else for (let i = 0; i < count; i++) values[i] = (source[i]! - offset) / span;
    return values;
  }
  const read = elementReader(view, type);
  for (let i = 0; i < pointCount; i++) {
    const at = start + i * pointStride;
    for (let j = 0; j < numElements; j++) {
      values[i * numElements + j] = (read(at + j * elementSize) - offset) / span;
    }
  }
  return values;
}

// One 48-bit Morton code occupies six useful bytes. Decode each byte's
// contribution to the three 16-bit coordinates without per-point BigInts.
const mortonX = new Uint16Array(6 * 256);
const mortonY = new Uint16Array(6 * 256);
const mortonZ = new Uint16Array(6 * 256);
for (let byte = 0; byte < 6; byte++) {
  for (let value = 0; value < 256; value++) {
    const index = byte * 256 + value;
    for (let bit = 0; bit < 8; bit++) {
      if ((value & (1 << bit)) === 0) continue;
      const mortonBit = byte * 8 + bit;
      const coordinateBit = 1 << Math.floor(mortonBit / 3);
      if (mortonBit % 3 === 0) mortonX[index] = mortonX[index]! | coordinateBit;
      else if (mortonBit % 3 === 1) mortonY[index] = mortonY[index]! | coordinateBit;
      else mortonZ[index] = mortonZ[index]! | coordinateBit;
    }
  }
}

function storageSize(attribute: PotreeAttribute, compressed: boolean): number {
  if (compressed && attribute.name === 'position') return 16;
  if (compressed && attribute.name === 'rgb') return 8;
  return attribute.size;
}

export type DecodedArray = Float32Array | Uint8Array | Int8Array | Uint16Array | Int16Array;

export interface DecodedAttribute {
  array: DecodedArray;
  itemSize: number;
  normalized: boolean;
}

export type DecodedNodeData = Record<string, DecodedAttribute>;

/** Attributes decoded when no explicit list is given. Missing names are skipped. */
export const DEFAULT_DECODED_ATTRIBUTES: readonly string[] = ['position', 'rgb'];

export interface NodeDecodeTiming {
  setupMs: number;
  brotliMs: number;
  attributesMs: number;
}

/** A point in the cloud's local space, where boundingBox.min is the origin. */
export type NodeOrigin = readonly [number, number, number];

/**
 * CPU-heavy Brotli and attribute decoding. Safe to run in a Web Worker. Positions are
 * relative to `origin`, normally the node's box minimum, to keep float32 precision.
 */
export async function decodeNodeData(
  bytes: ArrayBuffer | Uint8Array, nodeName: string, pointCount: number, metadata: PotreeV2Metadata,
  onTiming?: (timing: NodeDecodeTiming) => void,
  attributeNames: readonly string[] = DEFAULT_DECODED_ATTRIBUTES,
  origin: NodeOrigin = [0, 0, 0],
): Promise<DecodedNodeData> {
  const compressed = metadata.encoding === 'BROTLI';
  // A Uint8Array may be a view into a larger batch buffer; it is read in place.
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (compressed && pointCount > 0) {
    // Attributes are decoded straight from the decoder's memory, without copying its output.
    const expectedSize = pointCount * bytesPerPoint(metadata);
    const decoded = await decompressBrotli(input, expectedSize,
      data => decodeAttributes(data, nodeName, pointCount, metadata, attributeNames, origin));
    onTiming?.({ setupMs: decoded.setupMs, brotliMs: decoded.brotliMs, attributesMs: decoded.consumeMs });
    return decoded.result;
  }
  const startedAt = performance.now();
  const attributes = decodeAttributes(input, nodeName, pointCount, metadata, attributeNames, origin);
  onTiming?.({ setupMs: 0, brotliMs: 0, attributesMs: performance.now() - startedAt });
  return attributes;
}

function bytesPerPoint(metadata: PotreeV2Metadata): number {
  const compressed = metadata.encoding === 'BROTLI';
  return metadata.attributes.reduce((n, a) => n + storageSize(a, compressed), 0);
}

/**
 * Decode point attributes from decompressed node bytes. Every returned array is newly
 * allocated, so `data` may be a view that is released afterwards.
 */
function decodeAttributes(
  data: Uint8Array, nodeName: string, pointCount: number, metadata: PotreeV2Metadata,
  attributeNames: readonly string[], origin: NodeOrigin,
): DecodedNodeData {
  const wanted = new Set(attributeNames);
  const compressed = metadata.encoding === 'BROTLI';
  const pointSize = bytesPerPoint(metadata);
  const expectedSize = pointCount * pointSize;
  if (data.byteLength !== expectedSize) {
    throw new Error(`Node ${nodeName}: expected ${expectedSize} decoded bytes, got ${data.byteLength}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const attributes: DecodedNodeData = {};
  // DEFAULT stores points interleaved; BROTLI stores one column per attribute.
  const stride = compressed ? 0 : pointSize;
  let attributeOffset = 0;
  for (const attribute of metadata.attributes) {
    const size = storageSize(attribute, compressed);
    if (!wanted.has(attribute.name)) {
      // Skip the column (BROTLI) or field (uncompressed) without decoding it.
      attributeOffset += compressed ? size * pointCount : size;
      continue;
    }
    if (attribute.name === 'position') {
      const values = new Float32Array(pointCount * 3);
      const [sx, sy, sz] = metadata.scale;
      // Offsets are combined in double precision; only the node-relative result is float32.
      const ox = metadata.offset[0]! - metadata.boundingBox.min[0]! - origin[0];
      const oy = metadata.offset[1]! - metadata.boundingBox.min[1]! - origin[1];
      const oz = metadata.offset[2]! - metadata.boundingBox.min[2]! - origin[2];
      if (compressed) {
        // Converter stores the high and low 48-bit Morton codes in that order.
        for (let i = 0; i < pointCount; i++) {
          const at = attributeOffset + i * size;
          let hx = 0, hy = 0, hz = 0;
          let lx = 0, ly = 0, lz = 0;
          for (let byte = 0; byte < 6; byte++) {
            const high = byte * 256 + data[at + byte]!;
            const low = byte * 256 + data[at + 8 + byte]!;
            hx |= mortonX[high]!; hy |= mortonY[high]!; hz |= mortonZ[high]!;
            lx |= mortonX[low]!; ly |= mortonY[low]!; lz |= mortonZ[low]!;
          }
          const output = i * 3;
          values[output] = ((hx << 16) | lx) * sx! + ox;
          values[output + 1] = ((hy << 16) | ly) * sy! + oy;
          values[output + 2] = ((hz << 16) | lz) * sz! + oz;
        }
      } else {
        for (let i = 0; i < pointCount; i++) {
          const at = attributeOffset + i * stride;
          const output = i * 3;
          values[output] = view.getInt32(at, true) * sx! + ox;
          values[output + 1] = view.getInt32(at + 4, true) * sy! + oy;
          values[output + 2] = view.getInt32(at + 8, true) * sz! + oz;
        }
      }
      attributes.position = { array: values, itemSize: 3, normalized: false };
    } else if (attribute.name === 'rgb') {
      // RGBA: 3-byte vertex formats are converted on the CPU by some drivers (ANGLE on D3D11).
      const values = new Uint8Array(pointCount * 4);
      if (compressed) {
        for (let i = 0; i < pointCount; i++) {
          const at = attributeOffset + i * size;
          let r = 0, g = 0, b = 0;
          for (let byte = 0; byte < 6; byte++) {
            const index = byte * 256 + data[at + byte]!;
            r |= mortonX[index]!; g |= mortonY[index]!; b |= mortonZ[index]!;
          }
          const output = i * 4;
          values[output] = r > 255 ? r >>> 8 : r;
          values[output + 1] = g > 255 ? g >>> 8 : g;
          values[output + 2] = b > 255 ? b >>> 8 : b;
          values[output + 3] = 255;
        }
      } else {
        for (let i = 0; i < pointCount; i++) {
          const at = attributeOffset + i * stride;
          const output = i * 4;
          const r = view.getUint16(at, true);
          const g = view.getUint16(at + 2, true);
          const b = view.getUint16(at + 4, true);
          values[output] = r > 255 ? r >>> 8 : r;
          values[output + 1] = g > 255 ? g >>> 8 : g;
          values[output + 2] = b > 255 ? b >>> 8 : b;
          values[output + 3] = 255;
        }
      }
      attributes.color = { array: values, itemSize: 4, normalized: true };
    } else {
      const values = decodeGenericAttribute(
        data, view, attribute, pointCount, attributeOffset, compressed ? size : stride,
      );
      attributes[attribute.name] = { array: values, itemSize: attribute.numElements, normalized: false };
    }
    attributeOffset += compressed ? size * pointCount : size;
  }
  return attributes;
}

/**
 * Build the Three.js geometry on the render thread without copying decoded arrays.
 * Positions are relative to `box.min`, so the geometry's bounds are too.
 */
export function createNodeGeometry(attributes: DecodedNodeData, box: Box3): BufferGeometry {
  const geometry = new BufferGeometry();
  for (const [name, attribute] of Object.entries(attributes)) {
    geometry.setAttribute(name, new BufferAttribute(attribute.array, attribute.itemSize, attribute.normalized));
  }
  geometry.boundingBox = box.clone().translate(box.min.clone().negate());
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());
  return geometry;
}

/** A node's box minimum, the origin of its decoded positions. */
export function nodeOrigin(node: OctreeNode): NodeOrigin {
  return [node.box.min.x, node.box.min.y, node.box.min.z];
}

/** Decode one node locally, useful when Web Workers are unavailable. Positions are relative to `node.box.min`. */
export async function decodeNode(
  bytes: ArrayBuffer, node: OctreeNode, metadata: PotreeV2Metadata,
  attributeNames: readonly string[] = DEFAULT_DECODED_ATTRIBUTES,
): Promise<BufferGeometry> {
  const attributes = await decodeNodeData(
    bytes, node.name, node.numPoints, metadata, undefined, attributeNames, nodeOrigin(node),
  );
  return createNodeGeometry(attributes, node.box);
}
