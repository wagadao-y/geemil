import { decodeNodeData } from './decode.js';
import type { DecodedNodeData } from './decode.js';
import type { NodeDecodeTiming, NodeOrigin } from './decode.js';
import type { DecodeRequest, DecodeResponse } from './decode-worker.js';
import type { BatchNodeRequest } from './decode-worker.js';
import type { PotreeV2Metadata } from './format.js';

type DecodeJob = {
  request: DecodeRequest;
  onTiming?: (timing: NodeDecodeTiming) => void;
  resolve: (response: DecodeResponse) => void;
  reject: (error: Error) => void;
  /** Detaches the abort listener once the job leaves the queue. */
  cleanup?: () => void;
};

type WorkerSlot = {
  worker: Worker;
  job?: DecodeJob;
  /** The Worker was asked to load the Brotli decoder. */
  brotliWarm: boolean;
};

let shared: DecoderPool | undefined;

function abortError(): Error {
  return new DOMException('Point cloud disposed', 'AbortError');
}

/** A small reusable worker pool for decoding transferred byte ranges. */
export class DecoderPool {
  private readonly workers: WorkerSlot[] = [];
  private readonly queue: DecodeJob[] = [];
  private nextId = 0;
  private disposed = false;
  private workerFailure?: Error;
  private references = 0;
  /** Batches being fetched to be decoded here; counted so that fetched bytes waiting for a Worker stay bounded. */
  private fetching = 0;

  /**
   * The pool shared by every point cloud, created on first use and disposed with the
   * last release(). It grows to the largest `maxWorkers` requested while it lives.
   * A pool whose Workers failed is replaced for later callers.
   */
  static acquire(maxWorkers: number): DecoderPool {
    if (!shared || shared.disposed || shared.workerFailure) shared = new DecoderPool(maxWorkers);
    shared.maxWorkers = Math.max(shared.maxWorkers, maxWorkers);
    shared.references++;
    return shared;
  }

  constructor(public maxWorkers: number) {}

  /** Its Workers failed, so every decode rejects; acquire() returns a new pool. */
  get failed(): boolean { return this.workerFailure !== undefined; }

  /** Jobs waiting for or running on a Worker, and batches reserved by reserveFetch() still being fetched. */
  get backlog(): number {
    return this.fetching + this.queue.length + this.workers.reduce((n, slot) => n + (slot.job ? 1 : 0), 0);
  }

  /**
   * Count a batch being fetched in the backlog, so that batches finishing together
   * cannot queue beyond it. The returned function ends the reservation; call it once
   * the bytes have arrived, right before they are submitted, or when the fetch fails.
   */
  reserveFetch(): () => void {
    this.fetching++;
    let reserved = true;
    return () => {
      if (!reserved) return;
      reserved = false;
      this.fetching--;
    };
  }

  /** Give back a pool from acquire(); the last release disposes it. */
  release(): void {
    if (--this.references > 0) return;
    if (shared === this) shared = undefined;
    this.dispose();
  }

  /**
   * Start every Worker now, and load the Brotli decoder in each when `brotli` is set,
   * so the first decodes do not wait for module and WASM initialization.
   */
  warm(brotli: boolean): void {
    if (this.disposed || this.workerFailure || typeof Worker === 'undefined') return;
    while (this.workers.length < this.maxWorkers) {
      if (!this.createWorker()) return;
    }
    // Creating a Worker already loads its module; only Brotli needs a message.
    if (!brotli) return;
    for (const slot of this.workers) {
      if (slot.brotliWarm) continue;
      try {
        slot.worker.postMessage({ warm: true, brotli });
      } catch (error) {
        this.failWorkers(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      slot.brotliWarm = true;
    }
  }

  async decode(bytes: ArrayBuffer, nodeName: string, pointCount: number,
    metadata: PotreeV2Metadata, attributeNames?: string[], origin?: NodeOrigin): Promise<DecodedNodeData> {
    if (this.disposed) return Promise.reject(abortError());
    if (this.workerFailure) return Promise.reject(this.workerFailure);
    if (typeof Worker === 'undefined') {
      return decodeNodeData(bytes, nodeName, pointCount, metadata, undefined, attributeNames, origin);
    }
    const result = await this.run({ id: ++this.nextId, bytes, nodeName, pointCount, origin, metadata, attributes: attributeNames });
    if (!result.attributes) throw new Error(`Node ${nodeName}: empty decoder response`);
    return result.attributes;
  }

  /** `signal` withdraws the job while it still waits for a Worker; a running job completes. */
  async decodeBatch(
    bytes: ArrayBuffer, start: bigint, nodes: BatchNodeRequest[], metadata: PotreeV2Metadata,
    onTiming?: (timing: NodeDecodeTiming) => void, attributeNames?: string[], signal?: AbortSignal,
  ): Promise<{ name: string; attributes: DecodedNodeData }[]> {
    if (this.disposed) throw abortError();
    if (typeof Worker === 'undefined') {
      const decoded = [];
      for (const node of nodes) {
        const offset = Number(node.offset - start);
        if (offset < 0 || node.size < 0n || BigInt(offset) + node.size > BigInt(bytes.byteLength)) {
          throw new Error(`Node ${node.name}: range outside batch`);
        }
        const attributes = await decodeNodeData(
          new Uint8Array(bytes, offset, Number(node.size)), node.name, node.pointCount, metadata, onTiming, attributeNames,
          node.origin,
        );
        decoded.push({ name: node.name, attributes });
      }
      return decoded;
    }
    const result = await this.run(
      { id: ++this.nextId, bytes, start, nodes, metadata, attributes: attributeNames }, onTiming, signal,
    );
    if (!result.nodes || result.nodes.length !== nodes.length) throw new Error('Incomplete batch decoder response');
    return result.nodes;
  }

  private run(
    request: DecodeRequest, onTiming?: (timing: NodeDecodeTiming) => void, signal?: AbortSignal,
  ): Promise<DecodeResponse> {
    if (this.disposed || signal?.aborted) return Promise.reject(abortError());
    if (this.workerFailure) return Promise.reject(this.workerFailure);
    return new Promise((resolve, reject) => {
      const job: DecodeJob = { request, onTiming, resolve, reject };
      if (signal) {
        const onAbort = () => {
          const index = this.queue.indexOf(job);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        job.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.queue.push(job);
      this.pump();
    });
  }

  private createWorker(): WorkerSlot | undefined {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./decode-worker.js', import.meta.url), { type: 'module' });
    } catch (error) {
      this.failWorkers(error instanceof Error ? error : new Error(String(error)));
      return undefined;
    }
    const slot: WorkerSlot = { worker, brotliWarm: false };
    worker.onmessage = (event: MessageEvent<DecodeResponse>) => {
      const job = slot.job;
      if (!job || event.data.id !== job.request.id) return;
      slot.job = undefined;
      if (event.data.error) job.reject(new Error(event.data.error));
      else {
        if (event.data.timing) job.onTiming?.(event.data.timing);
        job.resolve(event.data);
      }
      this.pump();
    };
    worker.onerror = event => {
      event.preventDefault();
      this.failWorkers(new Error(`Potree decoder worker failed: ${event.message}`));
    };
    this.workers.push(slot);
    return slot;
  }

  private pump(): void {
    while (!this.disposed && !this.workerFailure && this.queue.length > 0) {
      const slot = this.workers.find(item => !item.job) ??
        (this.workers.length < this.maxWorkers ? this.createWorker() : undefined);
      if (!slot) return;
      const job = this.queue.shift()!;
      job.cleanup?.();
      slot.job = job;
      try {
        slot.worker.postMessage(job.request, job.request.bytes ? [job.request.bytes] : []);
      } catch (error) {
        slot.job = undefined;
        job.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private failWorkers(error: Error): void {
    this.workerFailure = error;
    for (const job of this.queue.splice(0)) { job.cleanup?.(); job.reject(error); }
    for (const slot of this.workers) {
      slot.worker.terminate();
      slot.job?.reject(error);
      slot.job = undefined;
    }
    this.workers.length = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = abortError();
    for (const job of this.queue.splice(0)) { job.cleanup?.(); job.reject(error); }
    for (const slot of this.workers) {
      slot.worker.terminate();
      slot.job?.reject(error);
      slot.job = undefined;
    }
    this.workers.length = 0;
  }
}
