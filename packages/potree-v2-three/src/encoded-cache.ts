import type { OctreeNode } from './format.js';

/** Byte-bounded LRU of node payloads as stored in octree.bin. */
export class EncodedNodeCache {
  private readonly entries = new Map<OctreeNode, ArrayBuffer>();
  private usedBytes = 0;

  constructor(public maxBytes: number) {}

  get bytes(): number { return this.usedBytes; }
  get size(): number { return this.entries.size; }

  /** Whether `node` is cached, without marking it as recently used. */
  has(node: OctreeNode): boolean { return this.entries.has(node); }

  get(node: OctreeNode): ArrayBuffer | undefined {
    const bytes = this.entries.get(node);
    if (bytes) {
      this.entries.delete(node);
      this.entries.set(node, bytes);
    }
    return bytes;
  }

  put(node: OctreeNode, bytes: ArrayBuffer): void {
    const previous = this.entries.get(node);
    if (previous) {
      this.entries.delete(node);
      this.usedBytes -= previous.byteLength;
    }
    if (bytes.byteLength <= this.maxBytes && this.maxBytes > 0) {
      this.entries.set(node, bytes);
      this.usedBytes += bytes.byteLength;
    }
    this.trim();
  }

  trim(): void {
    while (this.usedBytes > this.maxBytes && this.entries.size > 0) {
      const oldest = this.entries.keys().next().value as OctreeNode;
      this.usedBytes -= this.entries.get(oldest)!.byteLength;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
    this.usedBytes = 0;
  }
}
