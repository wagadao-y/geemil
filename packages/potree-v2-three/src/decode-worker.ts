import { initBrotli } from './brotli-codecs.js';
import { decodeNodeData } from './decode.js';
import type { DecodedNodeData } from './decode.js';
import type { NodeDecodeTiming, NodeOrigin } from './decode.js';
import type { PotreeV2Metadata } from './format.js';

export interface BatchNodeRequest {
  name: string; pointCount: number; offset: bigint; size: bigint;
  /** Origin of the decoded positions, normally the node's box minimum. Default: the cloud origin. */
  origin?: NodeOrigin;
}

/** Sent once after the Worker starts; it gets no response. */
export interface WarmRequest { warm: true; brotli: boolean }

export interface DecodeRequest {
  id: number;
  metadata: PotreeV2Metadata;
  /** Attribute names to decode; defaults to position and rgb. */
  attributes?: string[];
  bytes?: ArrayBuffer;
  nodeName?: string;
  pointCount?: number;
  origin?: NodeOrigin;
  start?: bigint;
  nodes?: BatchNodeRequest[];
}

export interface DecodeResponse {
  id: number;
  attributes?: DecodedNodeData;
  nodes?: { name: string; attributes: DecodedNodeData }[];
  error?: string;
  timing?: NodeDecodeTiming;
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<DecodeRequest | WarmRequest>) => void) | null;
  postMessage: (message: DecodeResponse, transfer?: Transferable[]) => void;
};

scope.onmessage = async event => {
  if ('warm' in event.data) {
    // A failed initialization is retried, and reported, by the first decode.
    if (event.data.brotli) await initBrotli().catch(() => {});
    return;
  }
  const { id, bytes, nodeName, pointCount, origin, metadata, attributes: names, start, nodes } = event.data;
  try {
    if (!bytes) throw new Error('Missing decoder bytes');
    const timing: NodeDecodeTiming = { setupMs: 0, brotliMs: 0, attributesMs: 0 };
    const addTiming = (sample: NodeDecodeTiming) => {
      timing.setupMs += sample.setupMs;
      timing.brotliMs += sample.brotliMs;
      timing.attributesMs += sample.attributesMs;
    };
    if (nodeName !== undefined && pointCount !== undefined) {
      const attributes = await decodeNodeData(bytes, nodeName, pointCount, metadata, addTiming, names, origin);
      scope.postMessage({ id, attributes, timing }, Object.values(attributes).map(a => a.array.buffer));
      return;
    }
    if (start === undefined || !nodes) throw new Error('Incomplete batch request');
    const size = BigInt(bytes.byteLength);
    const decoded: NonNullable<DecodeResponse['nodes']> = [];
    const transfer: Transferable[] = [];
    for (const node of nodes) {
      const offset = node.offset - start;
      if (offset < 0n || node.size < 0n || offset + node.size > size) throw new Error(`Node ${node.name}: range outside batch`);
      const attributes = await decodeNodeData(
        new Uint8Array(bytes, Number(offset), Number(node.size)), node.name, node.pointCount, metadata, addTiming, names,
        node.origin,
      );
      decoded.push({ name: node.name, attributes });
      transfer.push(...Object.values(attributes).map(a => a.array.buffer));
    }
    scope.postMessage({ id, nodes: decoded, timing }, transfer);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
