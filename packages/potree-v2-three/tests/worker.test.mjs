import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { brotliCompressSync } from 'node:zlib';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { DecoderPool } from '../dist/decoder-pool.js';
import { decodeBatchNode } from '../dist/decode.js';
import { makeNodeBatches } from '../dist/batches.js';
import { fetchRange } from '../dist/http.js';
import { loadPotreeV2 } from '../dist/index.js';

const metadata = {
  version: '2.0', encoding: 'DEFAULT', points: 1, spacing: 1,
  scale: [1, 1, 1], offset: [0, 0, 0],
  boundingBox: { min: [0, 0, 0], max: [8, 8, 8] },
  hierarchy: { firstChunkSize: 22 },
  attributes: [{ name: 'position', type: 'int32', size: 12, numElements: 3, elementSize: 4 }],
};

function installNodeWorker() {
  const original = globalThis.Worker;
  globalThis.Worker = class {
    constructor() {
      this.thread = new NodeWorker(new URL('./worker-shim.mjs', import.meta.url));
      this.thread.on('message', data => this.onmessage?.({ data }));
      this.thread.on('error', error => this.onerror?.({ message: error.message, preventDefault() {} }));
    }
    postMessage(message, transfer) { this.thread.postMessage(message, transfer); }
    terminate() { this.thread.terminate(); }
  };
  return () => { globalThis.Worker = original; };
}

test('reuses one worker and transfers decoded arrays', { timeout: 5000 }, async () => {
  const originalWorker = globalThis.Worker;
  let created = 0;
  globalThis.Worker = class {
    constructor() {
      created++;
      this.thread = new NodeWorker(new URL('./worker-shim.mjs', import.meta.url));
      this.thread.on('message', data => this.onmessage?.({ data }));
      this.thread.on('error', error => this.onerror?.({ message: error.message, preventDefault() {} }));
    }
    postMessage(message, transfer) { this.thread.postMessage(message, transfer); }
    terminate() { this.thread.terminate(); }
  };
  const pool = new DecoderPool(1);
  try {
    const bytes1 = new ArrayBuffer(12);
    const bytes2 = new ArrayBuffer(12);
    new DataView(bytes1).setInt32(0, 3, true);
    new DataView(bytes2).setInt32(0, 5, true);
    const [first, second] = await Promise.all([
      pool.decode(bytes1, 'r', 1, metadata),
      pool.decode(bytes2, 'r0', 1, metadata),
    ]);
    assert.equal(created, 1);
    assert.equal(bytes1.byteLength, 0);
    assert.deepEqual([...first.position.array], [3, 0, 0]);
    assert.deepEqual([...second.position.array], [5, 0, 0]);
    const mortonPosition = new ArrayBuffer(16);
    new DataView(mortonPosition).setBigUint64(8, 65n, true); // x = 5
    const compressed = brotliCompressSync(Buffer.from(mortonPosition));
    const compressedBytes = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength);
    const third = await pool.decode(compressedBytes, 'r1', 1, { ...metadata, encoding: 'BROTLI' });
    assert.deepEqual([...third.position.array], [5, 0, 0]);
    let timing;
    const batch = await pool.decodeBatch(
      compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength),
      0n, [{ name: 'r1', offset: 0n, size: BigInt(compressed.byteLength), pointCount: 1 }],
      { ...metadata, encoding: 'BROTLI' }, value => { timing = value; },
    );
    assert.deepEqual([...batch[0].attributes.position.array], [5, 0, 0]);
    for (const key of ['setupMs', 'brotliMs', 'attributesMs']) {
      assert.ok(Number.isFinite(timing[key]) && timing[key] >= 0, key);
    }
  } finally {
    pool.dispose();
    globalThis.Worker = originalWorker;
  }
});

test('groups adjacent nodes but rejects large gaps', () => {
  const nodes = [
    { name: 'r2', byteOffset: 24n, byteSize: 12n, numPoints: 1 },
    { name: 'r0', byteOffset: 0n, byteSize: 12n, numPoints: 1 },
    { name: 'r1', byteOffset: 12n, byteSize: 12n, numPoints: 1 },
    { name: 'r3', byteOffset: 100_000n, byteSize: 12n, numPoints: 1 },
  ];
  const batches = makeNodeBatches(nodes);
  assert.deepEqual(batches.map(b => b.nodes.map(n => n.name)), [['r0', 'r1', 'r2'], ['r3']]);
  assert.deepEqual([batches[0].start, batches[0].end], [0n, 36n]);
});

test('main thread fetches one authenticated range and transfers it to one batch decoder', { timeout: 5000 }, async () => {
  const restore = installNodeWorker();
  const bytes = new Uint8Array(24);
  new DataView(bytes.buffer).setInt32(0, 3, true);
  new DataView(bytes.buffer).setInt32(12, 7, true);
  const ranges = [];
  const server = createServer((request, response) => {
    ranges.push(request.headers.range);
    assert.equal(request.headers.authorization, 'Bearer test-token');
    response.writeHead(206, { 'Content-Range': 'bytes 0-23/24' });
    response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const pool = new DecoderPool(1);
  try {
    const nodes = [
      { name: 'r0', offset: 0n, size: 12n, pointCount: 1 },
      { name: 'r1', offset: 12n, size: 12n, pointCount: 1 },
    ];
    const url = new URL(`http://127.0.0.1:${server.address().port}/octree.bin`);
    let customFetchCalls = 0;
    const authenticatedFetch = (input, init) => {
      customFetchCalls++;
      return fetch(input, { ...init, headers: { ...init.headers, Authorization: 'Bearer test-token' } });
    };
    const range = await fetchRange(url, 0n, 24n, authenticatedFetch);
    const result = await pool.decodeBatch(range, 0n, nodes, metadata);
    assert.equal(customFetchCalls, 1);
    assert.equal(range.byteLength, 0);
    assert.deepEqual(ranges, ['bytes=0-23']);
    assert.deepEqual(result.map(n => [...n.attributes.position.array]), [[3, 0, 0], [7, 0, 0]]);
  } finally {
    pool.dispose();
    server.close();
    restore();
  }
});

test('decodes Brotli nodes in place from a batch buffer with gaps', { timeout: 5000 }, async () => {
  const restore = installNodeWorker();
  const pool = new DecoderPool(1);
  try {
    const node = x => {
      const raw = new ArrayBuffer(16);
      new DataView(raw).setBigUint64(8, BigInt(x) === 5n ? 65n : 8n, true); // x = 5 or 2
      return brotliCompressSync(Buffer.from(raw));
    };
    const first = node(5);
    const second = node(2);
    const gap = 7;
    const batch = new Uint8Array(first.byteLength + gap + second.byteLength);
    batch.set(first, 0);
    batch.set(second, first.byteLength + gap);
    const start = 100n;
    const result = await pool.decodeBatch(batch.buffer, start, [
      { name: 'r0', offset: start, size: BigInt(first.byteLength), pointCount: 1 },
      { name: 'r1', offset: start + BigInt(first.byteLength + gap), size: BigInt(second.byteLength), pointCount: 1 },
    ], { ...metadata, encoding: 'BROTLI' });
    assert.deepEqual(result.map(n => [...n.attributes.position.array]), [[5, 0, 0], [2, 0, 0]]);
  } finally {
    pool.dispose();
    restore();
  }
});

test('warm starts every worker and loads Brotli before the first decode', { timeout: 5000 }, async () => {
  const originalWorker = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    constructor() {
      workers.push(this);
      this.messages = [];
      this.thread = new NodeWorker(new URL('./worker-shim.mjs', import.meta.url));
      this.thread.on('message', data => this.onmessage?.({ data }));
      this.thread.on('error', error => this.onerror?.({ message: error.message, preventDefault() {} }));
    }
    postMessage(message, transfer) { this.messages.push(message); this.thread.postMessage(message, transfer); }
    terminate() { this.thread.terminate(); }
  };
  const pool = new DecoderPool(3);
  try {
    pool.warm(true);
    assert.equal(workers.length, 3);
    for (const worker of workers) assert.deepEqual(worker.messages, [{ warm: true, brotli: true }]);
    const mortonPosition = new ArrayBuffer(16);
    new DataView(mortonPosition).setBigUint64(8, 65n, true); // x = 5
    const compressed = brotliCompressSync(Buffer.from(mortonPosition));
    const decoded = await pool.decode(
      compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength),
      'r', 1, { ...metadata, encoding: 'BROTLI' },
    );
    assert.deepEqual([...decoded.position.array], [5, 0, 0]);
    assert.equal(workers.length, 3);
  } finally {
    pool.dispose();
    globalThis.Worker = originalWorker;
  }
});

test('an aborted job leaves the queue while a running job completes', { timeout: 5000 }, async () => {
  const originalWorker = globalThis.Worker;
  const posted = [];
  globalThis.Worker = class {
    postMessage(message) { posted.push({ worker: this, message }); }
    terminate() {}
  };
  const pool = new DecoderPool(1);
  try {
    const controller = new AbortController();
    const running = pool.decodeBatch(new ArrayBuffer(0), 0n, [], metadata, undefined, undefined, controller.signal);
    const queued = pool.decodeBatch(new ArrayBuffer(0), 0n, [], metadata, undefined, undefined, controller.signal);
    assert.equal(pool.backlog, 2);
    controller.abort();
    await assert.rejects(queued, { name: 'AbortError' });
    assert.equal(pool.backlog, 1);
    const { worker, message } = posted[0];
    worker.onmessage({ data: { id: message.id, nodes: [] } });
    assert.deepEqual(await running, []);
    assert.equal(pool.backlog, 0);
  } finally {
    pool.dispose();
    globalThis.Worker = originalWorker;
  }
});

test('a response that cannot be deserialized rejects its job and frees the Worker', { timeout: 5000 }, async () => {
  const originalWorker = globalThis.Worker;
  const posted = [];
  globalThis.Worker = class {
    postMessage(message) { posted.push({ worker: this, message }); }
    terminate() {}
  };
  const pool = new DecoderPool(1);
  try {
    const first = pool.decodeBatch(new ArrayBuffer(0), 0n, [], metadata);
    const second = pool.decodeBatch(new ArrayBuffer(0), 0n, [], metadata);
    posted[0].worker.onmessageerror(new MessageEvent('messageerror'));
    await assert.rejects(first, /could not be deserialized/);
    // The Worker takes the next job, and the pool stays usable.
    assert.equal(posted.length, 2);
    assert.equal(pool.failed, false);
    const { worker, message } = posted[1];
    worker.onmessage({ data: { id: message.id, nodes: [] } });
    assert.deepEqual(await second, []);
    assert.equal(pool.backlog, 0);
  } finally {
    pool.dispose();
    globalThis.Worker = originalWorker;
  }
});

test('a cloud whose shared pool failed decodes with a new pool', { timeout: 5000 }, async () => {
  const restore = installNodeWorker();
  const point = new Uint8Array(12);
  new DataView(point.buffer).setInt32(0, 3, true);
  const hierarchy = new Uint8Array(44);
  const view = new DataView(hierarchy.buffer);
  const record = (at, type, mask, offset) => {
    view.setUint8(at, type);
    view.setUint8(at + 1, mask);
    view.setUint32(at + 2, 1, true);
    view.setBigUint64(at + 6, BigInt(offset), true);
    view.setBigUint64(at + 14, 12n, true);
  };
  record(0, 1, 1, 0);
  record(22, 0, 0, 12);
  const files = { 'hierarchy.bin': hierarchy, 'octree.bin': new Uint8Array([...point, ...point]) };
  const fetcher = async (url, init = {}) => {
    const name = new URL(url).pathname.split('/').at(-1);
    if (name === 'metadata.json') return new Response(JSON.stringify({ ...metadata, points: 2, hierarchy: { firstChunkSize: 44 } }));
    const match = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    return new Response(files[name].slice(Number(match[1]), Number(match[2]) + 1), { status: 206 });
  };
  const cloud = await loadPotreeV2('https://example.test/cloud/metadata.json', { fetch: fetcher, decoderWorkers: 1 });
  try {
    const failed = cloud.decoder;
    failed.failWorkers(new Error('Worker script failed to load'));
    const child = cloud.root.children[0];
    assert.deepEqual(await cloud.loadBatch([child]), []);
    assert.notEqual(cloud.decoder, failed);
    assert.equal(cloud.decoder.failed, false);
    assert.deepEqual([...cloud.decodedQueue.at(-1).attributes.position.array], [3, 0, 0]);
  } finally {
    cloud.dispose();
    restore();
  }
});

test('batch decoding counts the point occupancy of nodes given their extent', { timeout: 5000 }, async () => {
  const restore = installNodeWorker();
  const pool = new DecoderPool(1);
  try {
    // Two points in one cell and one in another of the node's 32³ grid: 3 / 2 points per cell, truncated to 1.
    const bytes = new ArrayBuffer(36);
    const view = new DataView(bytes);
    [[0, 0, 0], [0, 0, 0], [7, 7, 7]].forEach((p, i) => p.forEach((v, j) => view.setInt32(i * 12 + j * 4, v, true)));
    const nodes = [
      { name: 'r', offset: 0n, size: 36n, pointCount: 3, extent: [8, 8, 8] },
      { name: 'r0', offset: 0n, size: 24n, pointCount: 2, extent: [8, 8, 8] },
      { name: 'r1', offset: 0n, size: 12n, pointCount: 1 },
    ];
    const decoded = await pool.decodeBatch(bytes, 0n, nodes, { ...metadata, points: 3 });
    assert.deepEqual(decoded.map(node => node.occupancy), [1, 2, undefined]);
  } finally {
    pool.dispose();
    restore();
  }
});

test('loading waits for room in the shared decoder backlog before fetching the root', { timeout: 5000 }, async () => {
  const originalWorker = globalThis.Worker;
  const posted = [];
  globalThis.Worker = class {
    postMessage(message) { if (message.id !== undefined) posted.push({ worker: this, message }); }
    terminate() {}
  };
  const respond = async ({ worker, message }) => {
    const nodes = [];
    for (const node of message.nodes) nodes.push(await decodeBatchNode(message.bytes, message.start, node, message.metadata));
    worker.onmessage({ data: { id: message.id, nodes } });
  };
  // Another cloud's two jobs fill the backlog of one Worker.
  const pool = DecoderPool.acquire(1);
  const busy = [0, 1].map(() => pool.decodeBatch(new ArrayBuffer(0), 0n, [], metadata));
  const ranges = [];
  const point = new Uint8Array(12);
  new DataView(point.buffer).setInt32(0, 3, true);
  const hierarchy = new Uint8Array(22);
  const view = new DataView(hierarchy.buffer);
  view.setUint32(2, 1, true);
  view.setBigUint64(14, 12n, true);
  const files = { 'hierarchy.bin': hierarchy, 'octree.bin': point };
  const fetcher = async (url, init = {}) => {
    const name = new URL(url).pathname.split('/').at(-1);
    if (name === 'metadata.json') return new Response(JSON.stringify(metadata));
    ranges.push(name);
    const match = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    return new Response(files[name].slice(Number(match[1]), Number(match[2]) + 1), { status: 206 });
  };
  try {
    const loading = loadPotreeV2('https://example.test/cloud/metadata.json', { fetch: fetcher, decoderWorkers: 1 });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(ranges, ['hierarchy.bin']);
    assert.equal(pool.backlog, 2);
    await respond(posted.shift());
    await busy[0];
    // One job left in the backlog: the root is fetched, and its job waits for the Worker.
    const deadline = Date.now() + 1000;
    while (ranges.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(ranges, ['hierarchy.bin', 'octree.bin']);
    await respond(posted.shift());
    await busy[1];
    while (posted.length < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    await respond(posted.shift()); // The root's job.
    const cloud = await loading;
    assert.equal(cloud.group.children.length, 1);
    cloud.dispose();
  } finally {
    pool.release();
    globalThis.Worker = originalWorker;
  }
});

test('a load waiting for the backlog checks the new pool when the waited one fails', { timeout: 5000 }, async () => {
  const originalWorker = globalThis.Worker;
  const posted = [];
  globalThis.Worker = class {
    postMessage(message) { if (message.id !== undefined) posted.push({ worker: this, message }); }
    terminate() {}
  };
  const respond = async ({ worker, message }) => {
    const nodes = [];
    for (const node of message.nodes) nodes.push(await decodeBatchNode(message.bytes, message.start, node, message.metadata));
    worker.onmessage({ data: { id: message.id, nodes } });
  };
  const fill = pool => [0, 1].map(() => pool.decodeBatch(new ArrayBuffer(0), 0n, [], metadata));
  const failed = DecoderPool.acquire(1);
  const lost = fill(failed).map(job => job.catch(error => error));
  const ranges = [];
  const point = new Uint8Array(12);
  const hierarchy = new Uint8Array(22);
  const view = new DataView(hierarchy.buffer);
  view.setUint32(2, 1, true);
  view.setBigUint64(14, 12n, true);
  const files = { 'hierarchy.bin': hierarchy, 'octree.bin': point };
  const fetcher = async (url, init = {}) => {
    const name = new URL(url).pathname.split('/').at(-1);
    if (name === 'metadata.json') return new Response(JSON.stringify(metadata));
    ranges.push(name);
    const match = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    return new Response(files[name].slice(Number(match[1]), Number(match[2]) + 1), { status: 206 });
  };
  let replacement;
  try {
    const loading = loadPotreeV2('https://example.test/cloud/metadata.json', { fetch: fetcher, decoderWorkers: 1 });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(ranges, ['hierarchy.bin']);
    // The waited pool fails, and its replacement is already full with another cloud's jobs.
    failed.failWorkers(new Error('Worker crashed'));
    await Promise.all(lost);
    replacement = DecoderPool.acquire(1);
    assert.notEqual(replacement, failed);
    posted.length = 0;
    const busy = fill(replacement);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(ranges, ['hierarchy.bin'], 'the root waits for the replacement pool');
    for (let i = 0; i < 2; i++) {
      await respond(posted.shift());
      await busy[i];
    }
    const deadline = Date.now() + 1000;
    while (posted.length < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(ranges, ['hierarchy.bin', 'octree.bin']);
    await respond(posted.shift()); // The root's job.
    const cloud = await loading;
    assert.equal(cloud.decoder, replacement);
    cloud.dispose();
  } finally {
    replacement?.release();
    failed.release();
    globalThis.Worker = originalWorker;
  }
});

test('the decoder worker imports only package modules, not Three.js', () => {
  // Every Worker would otherwise load Three.js, and a bare specifier fails in unbundled Workers.
  const seen = new Set();
  const visit = url => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const source = readFileSync(url, 'utf8');
    for (const [, specifier] of source.matchAll(/(?:\bfrom|\bimport\s*\(?)\s*['"]([^'"]+)['"]/g)) {
      assert.ok(specifier.startsWith('.'), `${url.pathname} imports ${specifier}`);
      visit(new URL(specifier, url));
    }
  };
  visit(new URL('../dist/decode-worker.js', import.meta.url));
  assert.ok([...seen].some(href => href.endsWith('/occupancy.js')));
});
