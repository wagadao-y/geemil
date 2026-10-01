// Runs in the decoder Workers: keep this module free of Three.js imports (type imports are erased).
import type { OctreeNode, PotreeV2Attribute, PotreeV2AttributeType, PotreeV2Metadata } from './format.js';
import { decompressBrotli } from './brotli-codecs.js';
import { pointOccupancy } from './occupancy.js';
import type { NodeExtent } from './occupancy.js';

/** DataView reader for one element type, chosen once per attribute instead of per value. */
function elementReader(view: DataView, type: PotreeV2AttributeType): (at: number) => number {
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
const typedArrays: Partial<Record<PotreeV2AttributeType, NumberArrayConstructor>> = {
  int8: Int8Array, uint8: Uint8Array, int16: Int16Array, uint16: Uint16Array,
  int32: Int32Array, uint32: Uint32Array, float: Float32Array, double: Float64Array,
};

/** Potree data is little-endian; typed array views use the platform's byte order. */
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * 8- and 16-bit integers keep their type: WebGL reads them as float attributes without
 * normalization, in a half or a quarter of the memory.
 */
const compactArrays: Partial<Record<PotreeV2AttributeType, new (length: number) => DecodedArray>> = {
  int8: Int8Array, uint8: Uint8Array, int16: Int16Array, uint16: Uint16Array,
};

/**
 * How a 64-bit scalar attribute keeps useful precision in a GPU float: it is stored as
 * `(value - offset) / span`, from metadata.json's min and max. Undefined for other attributes,
 * which are stored as they are.
 */
export function attributeNormalization(attribute: PotreeV2Attribute): { offset: number; span: number } | undefined {
  const min = attribute.min?.[0];
  const max = attribute.max?.[0];
  if (attribute.elementSize !== 8 || attribute.numElements !== 1 || !Number.isFinite(min) || !Number.isFinite(max)) {
    return undefined;
  }
  return { offset: min!, span: max! - min! };
}

/**
 * Decode an attribute other than position and rgb into floats, or into its own type for
 * 8- and 16-bit integers. `start` is the byte offset of the first point's value and
 * `pointStride` the bytes between points.
 */
function decodeGenericAttribute(
  data: Uint8Array, view: DataView, attribute: PotreeV2Attribute, pointCount: number,
  start: number, pointStride: number,
): DecodedArray {
  const { numElements, elementSize, type } = attribute;
  const count = pointCount * numElements;
  const values = new (compactArrays[type] ?? Float32Array)(count);
  const normalization = attributeNormalization(attribute);
  const normalize = normalization !== undefined;
  const offset = normalization?.offset ?? 0;
  const span = normalization?.span ?? 1;
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

/**
 * Bits to drop from the stored rgb values, or undefined to guess per value. PotreeConverter
 * copies LAS colors unscaled, and many LAS writers store 8-bit values in the 16-bit fields,
 * so the metadata's maximum tells the two apart for the whole dataset. Without it, values
 * above 255 are taken as 16-bit, as in Potree, which brightens dark 16-bit colors.
 */
function rgbShift(attribute: PotreeV2Attribute): number | undefined {
  const max = attribute.max;
  if (!max || max.length !== 3 || !max.every(Number.isFinite)) return undefined;
  return max.some(value => value > 255) ? 8 : 0;
}

function storageSize(attribute: PotreeV2Attribute, compressed: boolean): number {
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

/** One node of a batch request. */
export interface BatchNodeRequest {
  name: string; pointCount: number; offset: bigint; size: bigint;
  /** Origin of the decoded positions, normally the node's box minimum. Default: the cloud origin. */
  origin?: NodeOrigin;
  /** The node's box size; when given, the point occupancy for adaptive sizes is counted too. */
  extent?: NodeExtent;
}

export interface DecodedBatchNode {
  name: string;
  attributes: DecodedNodeData;
  /** pointOccupancy() of the node, when its extent was requested. */
  occupancy?: number;
}

/**
 * Decode one node of a batch whose buffer starts at file offset `start`, reading its
 * range in place. Used by the decoder Workers and by the main thread without Workers.
 */
export async function decodeBatchNode(
  bytes: ArrayBuffer, start: bigint, node: BatchNodeRequest, metadata: PotreeV2Metadata,
  onTiming?: (timing: NodeDecodeTiming) => void, attributeNames?: readonly string[],
): Promise<DecodedBatchNode> {
  const offset = node.offset - start;
  if (offset < 0n || node.size < 0n || offset + node.size > BigInt(bytes.byteLength)) {
    throw new Error(`Node ${node.name}: range outside batch`);
  }
  const attributes = await decodeNodeData(
    new Uint8Array(bytes, Number(offset), Number(node.size)), node.name, node.pointCount, metadata, onTiming,
    attributeNames, node.origin,
  );
  if (!node.extent) return { name: node.name, attributes };
  const startedAt = performance.now();
  const occupancy = pointOccupancy(attributes.position?.array ?? [], node.extent);
  onTiming?.({ setupMs: 0, brotliMs: 0, attributesMs: performance.now() - startedAt });
  return { name: node.name, attributes, occupancy };
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
      const shift = rgbShift(attribute);
      if (compressed) {
        for (let i = 0; i < pointCount; i++) {
          const at = attributeOffset + i * size;
          let r = 0, g = 0, b = 0;
          for (let byte = 0; byte < 6; byte++) {
            const index = byte * 256 + data[at + byte]!;
            r |= mortonX[index]!; g |= mortonY[index]!; b |= mortonZ[index]!;
          }
          const output = i * 4;
          if (shift === undefined) {
            values[output] = r > 255 ? r >>> 8 : r;
            values[output + 1] = g > 255 ? g >>> 8 : g;
            values[output + 2] = b > 255 ? b >>> 8 : b;
          } else {
            values[output] = r >>> shift;
            values[output + 1] = g >>> shift;
            values[output + 2] = b >>> shift;
          }
          values[output + 3] = 255;
        }
      } else {
        for (let i = 0; i < pointCount; i++) {
          const at = attributeOffset + i * stride;
          const output = i * 4;
          const r = view.getUint16(at, true);
          const g = view.getUint16(at + 2, true);
          const b = view.getUint16(at + 4, true);
          if (shift === undefined) {
            values[output] = r > 255 ? r >>> 8 : r;
            values[output + 1] = g > 255 ? g >>> 8 : g;
            values[output + 2] = b > 255 ? b >>> 8 : b;
          } else {
            values[output] = r >>> shift;
            values[output + 1] = g >>> shift;
            values[output + 2] = b >>> shift;
          }
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

/** A node's box minimum, the origin of its decoded positions. */
export function nodeOrigin(node: OctreeNode): NodeOrigin {
  return [node.box.min.x, node.box.min.y, node.box.min.z];
}
