import type { OctreeNode } from './format.js';

type Entry = { bytes: ArrayBuffer; owner: object };

/** Byte-bounded LRU of node payloads as stored in octree.bin, possibly shared by several clouds. */
export class EncodedNodeCache {
  private readonly entries = new Map<OctreeNode, Entry>();
  private usedBytes = 0;

  constructor(public maxBytes: number) {}

  get bytes(): number { return this.usedBytes; }
  get size(): number { return this.entries.size; }

  /** Whether `node` is cached, without marking it as recently used. */
  has(node: OctreeNode): boolean { return this.entries.has(node); }

  get(node: OctreeNode): ArrayBuffer | undefined {
    const entry = this.entries.get(node);
    if (entry) {
      this.entries.delete(node);
      this.entries.set(node, entry);
    }
    return entry?.bytes;
  }

  /** `owner` is the cloud of `node`, so that deleteOwner() can drop its entries. */
  put(node: OctreeNode, bytes: ArrayBuffer, owner: object = this): void {
    const previous = this.entries.get(node);
    if (previous) {
      this.entries.delete(node);
      this.usedBytes -= previous.bytes.byteLength;
    }
    if (bytes.byteLength <= this.maxBytes && this.maxBytes > 0) {
      this.entries.set(node, { bytes, owner });
      this.usedBytes += bytes.byteLength;
    }
    this.trim();
  }

  trim(): void {
    while (this.usedBytes > this.maxBytes && this.entries.size > 0) {
      const oldest = this.entries.keys().next().value as OctreeNode;
      this.usedBytes -= this.entries.get(oldest)!.bytes.byteLength;
      this.entries.delete(oldest);
    }
  }

  /** Drop the entries put by `owner`, such as a cloud leaving a set that shares this cache. */
  deleteOwner(owner: object): void {
    for (const [node, entry] of this.entries) {
      if (entry.owner !== owner) continue;
      this.entries.delete(node);
      this.usedBytes -= entry.bytes.byteLength;
    }
  }

  clear(): void {
    this.entries.clear();
    this.usedBytes = 0;
  }
}
