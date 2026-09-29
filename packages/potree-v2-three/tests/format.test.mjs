import test from 'node:test';
import assert from 'node:assert/strict';
import { brotliCompressSync } from 'node:zlib';
import { createRoot, parseHierarchyChunk, validateMetadata } from '../dist/format.js';
import { decodeNode } from '../dist/decode.js';
import { fetchRange, HttpError, parseRetryAfter } from '../dist/http.js';
import { RequestGate } from '../dist/request-gate.js';
import { EncodedNodeCache } from '../dist/encoded-cache.js';
import { loadPotreeV2, loadPotreeV2FromFiles, PotreeV2PointCloudSet, selectPotreeV2Files } from '../dist/index.js';
import { Box3, PerspectiveCamera, Vector3 } from 'three';

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for background node load');
}

const base = {
  version: '2.0', encoding: 'UNCOMPRESSED', points: 2, spacing: 1,
  scale: [0.5, 0.5, 0.5], offset: [100, 200, 300],
  boundingBox: { min: [100, 200, 300], max: [108, 208, 308] },
  hierarchy: { firstChunkSize: 44 },
  attributes: [
    { name: 'position', type: 'int32', size: 12, numElements: 3, elementSize: 4 },
    { name: 'rgb', type: 'uint16', size: 6, numElements: 3, elementSize: 2 },
  ],
};

function record(type, mask, points, offset, size) {
  const data = new ArrayBuffer(22);
  const view = new DataView(data);
  view.setUint8(0, type);
  view.setUint8(1, mask);
  view.setUint32(2, points, true);
  view.setBigUint64(6, BigInt(offset), true);
  view.setBigUint64(14, BigInt(size), true);
  return new Uint8Array(data);
}

function concat(...arrays) {
  const data = new Uint8Array(arrays.reduce((n, a) => n + a.byteLength, 0));
  let at = 0;
  for (const a of arrays) { data.set(a, at); at += a.byteLength; }
  return data;
}

function uncompressedPoint(x, y, z, r, g, b) {
  const data = new ArrayBuffer(18);
  const view = new DataView(data);
  [x, y, z].forEach((v, i) => view.setInt32(i * 4, v, true));
  [r, g, b].forEach((v, i) => view.setUint16(12 + i * 2, v, true));
  return new Uint8Array(data);
}

function morton(x, y, z, bits) {
  let result = 0n;
  for (let i = 0n; i < BigInt(bits); i++) {
    result |= ((BigInt(x) >> i) & 1n) << (3n * i);
    result |= ((BigInt(y) >> i) & 1n) << (3n * i + 1n);
    result |= ((BigInt(z) >> i) & 1n) << (3n * i + 2n);
  }
  return result;
}

test('rejects metadata outside Potree v2', () => {
  assert.throws(() => validateMetadata({ ...base, version: '3.0' }), /Expected Potree v2/);
});

test('parses child boxes and proxy hierarchy chunks', () => {
  const root = createRoot(base);
  const chunk = concat(record(1, 1, 1, 0, 18), record(2, 0, 1, 44, 22));
  parseHierarchyChunk(root, chunk.buffer);
  assert.equal(root.numPoints, 1);
  assert.equal(root.children[0].name, 'r0');
  assert.deepEqual(root.children[0].box.max.toArray(), [4, 4, 4]);
  assert.equal(root.children[0].hierarchyByteOffset, 44n);
  parseHierarchyChunk(root.children[0], record(0, 0, 1, 18, 18).buffer);
  assert.equal(root.children[0].byteOffset, 18n);
  assert.equal(root.children[0].type, 0);
});

test('decodes uncompressed positions and 16-bit colors', async () => {
  const node = createRoot(base);
  node.numPoints = 1;
  const data = uncompressedPoint(2, 4, 6, 65535, 128, 256);
  const geometry = await decodeNode(data.buffer, node, base);
  assert.deepEqual([...geometry.getAttribute('position').array], [1, 2, 3]);
  assert.deepEqual([...geometry.getAttribute('color').array], [255, 128, 1, 255]);
  geometry.dispose();
});

test('decodes positions relative to the node minimum with matching bounds', async () => {
  const node = { name: 'r0', numPoints: 1, box: new Box3(new Vector3(4, 6, 2), new Vector3(8, 8, 8)) };
  // Cloud-local (5, 6, 7), i.e. (1, 0, 5) from the node minimum.
  const geometry = await decodeNode(uncompressedPoint(10, 12, 14, 0, 0, 0).buffer, node, base);
  assert.deepEqual([...geometry.getAttribute('position').array], [1, 0, 5]);
  assert.deepEqual(geometry.boundingBox.min.toArray(), [0, 0, 0]);
  assert.deepEqual(geometry.boundingBox.max.toArray(), [4, 2, 6]);
  assert.deepEqual(geometry.boundingSphere.center.toArray(), [2, 1, 3]);
  geometry.dispose();
});

test('node-relative positions keep millimetres far from the cloud origin', async () => {
  const metadata = {
    ...base, scale: [0.001, 0.001, 0.001], offset: [500_000, 4_000_000, 0],
    boundingBox: { min: [500_000, 4_000_000, 0], max: [532_768, 4_032_768, 32_768] },
  };
  // 20 km from the cloud minimum, where float32 steps are about 2 mm.
  const node = { name: 'r7', numPoints: 1, box: new Box3(new Vector3(20_000, 20_000, 20_000), new Vector3(20_001, 20_001, 20_001)) };
  const geometry = await decodeNode(uncompressedPoint(20_000_001, 20_000_002, 20_000_003, 0, 0, 0).buffer, node, metadata);
  const [x, y, z] = geometry.getAttribute('position').array;
  assert.ok(Math.abs(x + 20_000 - 20_000.001) < 1e-6);
  assert.ok(Math.abs(y + 20_000 - 20_000.002) < 1e-6);
  assert.ok(Math.abs(z + 20_000 - 20_000.003) < 1e-6);
  geometry.dispose();
});

test('decodes Brotli Morton positions and colors', async () => {
  const metadata = { ...base, encoding: 'BROTLI' };
  const node = createRoot(metadata);
  node.numPoints = 1;
  const raw = new ArrayBuffer(24);
  const view = new DataView(raw);
  view.setBigUint64(0, morton(0, 0, 0, 16), true);
  view.setBigUint64(8, morton(2, 4, 6, 16), true);
  view.setBigUint64(16, morton(100, 200, 300, 16), true);
  const compressed = brotliCompressSync(Buffer.from(raw));
  const geometry = await decodeNode(compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength), node, metadata);
  assert.deepEqual([...geometry.getAttribute('position').array], [1, 2, 3]);
  assert.deepEqual([...geometry.getAttribute('color').array], [100, 200, 1, 255]);
  geometry.dispose();
});

test('decodes all 32 position bits and 16 color bits from Brotli Morton columns', async () => {
  const positions = [
    [0, 0, 0],
    [65_535, 65_536, -1],
    [2_147_483_647, -2_147_483_648, 0x12345678],
    [-123_456_789, 42, 0xabcdef01 | 0],
  ];
  const colors = [[0, 255, 256], [65_535, 1_024, 1], [300, 100, 255], [1, 2, 3]];
  const raw = new ArrayBuffer(positions.length * 24);
  const view = new DataView(raw);
  for (let i = 0; i < positions.length; i++) {
    const upper = positions[i].map(value => (value >>> 16) & 0xffff);
    const lower = positions[i].map(value => value & 0xffff);
    view.setBigUint64(i * 16, morton(...upper, 16), true);
    view.setBigUint64(i * 16 + 8, morton(...lower, 16), true);
    view.setBigUint64(positions.length * 16 + i * 8, morton(...colors[i], 16), true);
  }
  const compressed = brotliCompressSync(Buffer.from(raw));
  const node = createRoot(base);
  node.numPoints = positions.length;
  const metadata = {
    ...base, encoding: 'BROTLI', scale: [1, 1, 1], offset: [0, 0, 0],
    boundingBox: { min: [0, 0, 0], max: [1, 1, 1] },
  };
  const geometry = await decodeNode(
    compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength), node, metadata,
  );
  assert.deepEqual(
    [...geometry.getAttribute('position').array],
    [...Float32Array.from(positions.flat())],
  );
  assert.deepEqual(
    [...geometry.getAttribute('color').array],
    colors.flatMap(rgb => [...rgb.map(value => value > 255 ? value >>> 8 : value), 255]),
  );
  geometry.dispose();
});

test('rejects full-file responses without reading their body', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024)); },
    cancel() { cancelled = true; },
  });
  const fetcher = async () => new Response(body, { status: 200 });
  await assert.rejects(fetchRange(new URL('https://example.test/octree.bin'), 2n, 2n, fetcher), /expected HTTP 206/);
  assert.ok(cancelled);
});

/** A 206 response whose body arrives in chunks, without Content-Length. */
function chunkedRange(chunks, headers = {}) {
  return async () => new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  }), { status: 206, headers });
}

test('reads chunked range responses without Content-Length', async () => {
  const result = await fetchRange(new URL('https://example.test/octree.bin'), 2n, 5n, chunkedRange([[2, 3], [4], [5, 6]]));
  assert.deepEqual([...new Uint8Array(result)], [2, 3, 4, 5, 6]);
});

test('requires range responses of exactly the requested size', async () => {
  const url = new URL('https://example.test/octree.bin');
  await assert.rejects(fetchRange(url, 2n, 3n, chunkedRange([[2, 3], [4, 5]])), /longer than the requested 3 bytes/);
  await assert.rejects(fetchRange(url, 2n, 3n, chunkedRange([[2, 3]])), /short byte range, got 2 of 3 bytes/);
  await assert.rejects(
    fetchRange(url, 2n, 3n, chunkedRange([[2, 3, 4]], { 'Content-Range': 'bytes 0-2/10' })),
    /unexpected Content-Range/,
  );
});

test('encoded node cache evicts by bytes in least recently used order', () => {
  const cache = new EncodedNodeCache(5);
  const a = { name: 'a' }, b = { name: 'b' }, c = { name: 'c' };
  cache.put(a, new ArrayBuffer(3));
  cache.put(b, new ArrayBuffer(2));
  assert.equal(cache.bytes, 5);
  cache.get(a);
  cache.put(c, new ArrayBuffer(2));
  assert.equal(cache.get(b), undefined);
  assert.ok(cache.get(a));
  assert.ok(cache.get(c));
  cache.maxBytes = 2;
  cache.trim();
  assert.equal(cache.bytes, 2);
  assert.equal(cache.get(a), undefined);
  cache.clear();
  assert.equal(cache.bytes, 0);
});

test('loads metadata, hierarchy and root through HTTP ranges', async () => {
  const hierarchy = concat(record(1, 1, 1, 0, 18), record(0, 0, 1, 18, 18));
  const octree = concat(uncompressedPoint(2, 4, 6, 255, 0, 0), uncompressedPoint(4, 6, 8, 0, 255, 0));
  const files = { 'metadata.json': JSON.stringify(base), 'hierarchy.bin': hierarchy, 'octree.bin': octree };
  const fetcher = async (url, init = {}) => {
    const name = new URL(url).pathname.split('/').at(-1);
    const file = files[name];
    if (!file) return new Response(null, { status: 404 });
    if (name === 'metadata.json') return new Response(file);
    const range = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const bytes = file.slice(Number(range[1]), Number(range[2]) + 1);
    return new Response(bytes, { status: 206, headers: { 'Content-Range': `bytes ${range[1]}-${range[2]}/${file.byteLength}` } });
  };
  const cloud = await loadPotreeV2('https://example.test/cloud/metadata.json', { fetch: fetcher, minNodePixelSize: 1 });
  assert.deepEqual(cloud.fetchStats, { rangeRequests: 1, fetchedNodes: 1 });
  assert.equal(cloud.maxNodesToGPUPerFrame, 8);
  assert.equal(cloud.cachePointBudget, 4_000_000);
  cloud.pointBudget = 3_000_000;
  assert.equal(cloud.cachePointBudget, 6_000_000);
  cloud.pointBudget = 2_000_000;
  assert.equal(cloud.group.children.length, 1);
  assert.equal(cloud.worldOffset.x, 100);
  const shader = { vertexShader: '#include <color_vertex>', fragmentShader: '' };
  cloud.material.onBeforeCompile(shader);
  assert.match(shader.vertexShader, /lessThanEqual\(vColor\.rgb, vec3\(0\.04045\)\)/);
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(4, 4, 20);
  camera.lookAt(4, 4, 4);
  cloud.minNodePixelSize = 120;
  cloud.update(camera, 600);
  assert.deepEqual(cloud.fetchStats, { rangeRequests: 1, fetchedNodes: 1 });
  cloud.minNodePixelSize = 90;
  cloud.update(camera, 600);
  await waitFor(() => { cloud.update(camera, 600); return cloud.group.children.length === 2; });
  assert.deepEqual(cloud.fetchStats, { rangeRequests: 2, fetchedNodes: 2 });
  const measured = cloud.loadDiagnostics;
  assert.equal(measured.requiredNodes, 2);
  assert.equal(measured.decodedNodes, 2);
  assert.equal(measured.pendingSceneNodes, 0);
  assert.ok(measured.sceneReadySeconds !== null);
  assert.equal(measured.startedBatches, 2);
  assert.equal(measured.completedBatches, 2);
  assert.equal(measured.sceneConversions, 2);
  cloud.resetLoadDiagnostics();
  cloud.update(camera, 600);
  assert.equal(cloud.loadDiagnostics.startedBatches, 0);
  assert.equal(cloud.loadDiagnostics.sceneConversions, 0);
  assert.ok(cloud.loadDiagnostics.sceneReadySeconds !== null);
  cloud.clearFetchStats();
  assert.deepEqual(cloud.fetchStats, { rangeRequests: 0, fetchedNodes: 0 });
  assert.equal(cloud.group.children.length, 2);
  cloud.group.position.x = 100;
  camera.position.set(104, 4, 20);
  camera.lookAt(104, 4, 4);
  cloud.update(camera, 600);
  assert.equal(cloud.group.children[0].visible, true);
  for (const points of cloud.group.children) {
    const node = points.name === 'r' ? cloud.root : cloud.root.children[0];
    assert.equal(points.matrixAutoUpdate, false);
    assert.deepEqual(points.position.toArray(), node.box.min.toArray());
    assert.deepEqual(points.matrix.elements.slice(12, 15), node.box.min.toArray());
  }
  cloud.showBoundingBoxes = true;
  cloud.update(camera, 600);
  const boxes = cloud.group.children.filter(child => child.isLineSegments);
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes[0].position.toArray(), [4, 4, 4]);
  assert.deepEqual(boxes[0].scale.toArray(), [8, 8, 8]);
  assert.equal(boxes[0].geometry, boxes[1].geometry);
  assert.equal(boxes[0].material.depthTest, true);
  assert.equal(boxes[0].material.depthWrite, true);
  assert.equal(boxes[0].material.transparent, false);
  assert.ok(boxes.every(box => box.visible));
  cloud.showBoundingBoxes = false;
  cloud.update(camera, 600);
  assert.ok(boxes.every(box => !box.visible));
  cloud.dispose();
  assert.equal(cloud.group.children.length, 0);
});

test('cloud update groups adjacent children and installs visible nodes by priority', async () => {
  const metadata = { ...base, points: 4, hierarchy: { firstChunkSize: 88 } };
  const hierarchy = concat(
    record(1, 7, 1, 0, 18), record(0, 0, 1, 18, 18),
    record(0, 0, 1, 36, 18), record(0, 0, 1, 54, 18),
  );
  const octree = concat(
    uncompressedPoint(2, 4, 6, 255, 0, 0),
    uncompressedPoint(4, 6, 8, 0, 255, 0),
    uncompressedPoint(6, 8, 10, 0, 0, 255),
    uncompressedPoint(8, 10, 12, 255, 255, 0),
  );
  const ranges = [];
  const fetcher = async (url, init = {}) => {
    const name = new URL(url).pathname.split('/').at(-1);
    if (name === 'metadata.json') return new Response(JSON.stringify(metadata));
    const file = name === 'hierarchy.bin' ? hierarchy : octree;
    const match = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    if (name === 'octree.bin') ranges.push(init.headers.Range);
    return new Response(file.slice(Number(match[1]), Number(match[2]) + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${match[1]}-${match[2]}/${file.byteLength}` },
    });
  };
  const cloud = await loadPotreeV2('https://example.test/cloud/metadata.json', {
    fetch: fetcher, minNodePixelSize: 1, maxNodesToGPUPerFrame: 2,
  });
  try {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(4, 4, 20);
    camera.lookAt(4, 4, 4);
    cloud.update(camera, 600);
    await waitFor(() => cloud.decodedQueue.length === 3);
    assert.deepEqual(cloud.fetchStats, { rangeRequests: 2, fetchedNodes: 4 });
    assert.equal(cloud.group.children.length, 1);
    // The last traversal's selection order decides which decoded nodes go first.
    cloud.selectionRank.clear();
    [cloud.root, cloud.root.children[2], cloud.root.children[0], cloud.root.children[1]]
      .forEach((node, index) => cloud.selectionRank.set(node, index));
    cloud.constructor.installDecodedNodes([cloud], cloud.maxNodesToGPUPerFrame);
    assert.deepEqual(cloud.group.children.map(node => node.name), ['r', 'r2', 'r0']);
    cloud.update(camera, 600);
    assert.equal(cloud.group.children.length, 4);
    assert.deepEqual(ranges, ['bytes=0-17', 'bytes=18-71']);
  } finally {
    cloud.dispose();
  }
});

test('starts the highest-priority Range batch even when its file offset is later', async () => {
  const metadata = { ...base, points: 3, hierarchy: { firstChunkSize: 66 } };
  const hierarchy = concat(
    record(1, 3, 1, 0, 18), record(0, 0, 1, 18, 18), record(0, 0, 1, 70_000, 18),
  );
  const octree = new Uint8Array(70_018);
  octree.set(uncompressedPoint(2, 4, 6, 255, 0, 0), 0);
  octree.set(uncompressedPoint(4, 6, 8, 0, 255, 0), 18);
  octree.set(uncompressedPoint(6, 8, 10, 0, 0, 255), 70_000);
  const ranges = [];
  const fetcher = async (url, init = {}) => {
    const name = new URL(url).pathname.split('/').at(-1);
    if (name === 'metadata.json') return new Response(JSON.stringify(metadata));
    const file = name === 'hierarchy.bin' ? hierarchy : octree;
    const match = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    if (name === 'octree.bin') ranges.push(init.headers.Range);
    return new Response(file.slice(Number(match[1]), Number(match[2]) + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${match[1]}-${match[2]}/${file.byteLength}` },
    });
  };
  const cloud = await loadPotreeV2('https://example.test/cloud/metadata.json', {
    fetch: fetcher, maxConcurrentLoads: 1,
  });
  try {
    cloud.constructor.requestBatches([{ cloud, pending: [cloud.root.children[1], cloud.root.children[0]] }], cloud.ownLimits());
    await waitFor(() => cloud.fetchStats.rangeRequests === 2);
    assert.deepEqual(ranges, ['bytes=0-17', 'bytes=70000-70017']);
  } finally {
    cloud.dispose();
  }
});

test('Brotli nodes are re-decoded from the encoded cache without another range request', async () => {
  const raw = new ArrayBuffer(16);
  new DataView(raw).setBigUint64(8, morton(2, 4, 6, 16), true);
  const compressed = new Uint8Array(brotliCompressSync(Buffer.from(raw)));
  const metadata = {
    ...base, encoding: 'BROTLI', points: 2,
    attributes: [base.attributes[0]], hierarchy: { firstChunkSize: 44 },
  };
  const hierarchy = concat(
    record(1, 1, 1, 0, compressed.length),
    record(0, 0, 1, compressed.length, compressed.length),
  );
  const octree = concat(compressed, compressed);
  const ranges = [];
  const fetcher = async (url, init = {}) => {
    const name = new URL(url).pathname.split('/').at(-1);
    if (name === 'metadata.json') return new Response(JSON.stringify(metadata));
    const file = name === 'hierarchy.bin' ? hierarchy : octree;
    const match = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    if (name === 'octree.bin') ranges.push(init.headers.Range);
    return new Response(file.slice(Number(match[1]), Number(match[2]) + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${match[1]}-${match[2]}/${file.byteLength}` },
    });
  };
  const cloud = await loadPotreeV2('https://example.test/cloud/metadata.json', { fetch: fetcher });
  try {
    assert.equal(cloud.minNodePixelSize, 30);
    assert.equal(cloud.encodedCacheByteBudget, 128 * 1024 * 1024);
    const child = cloud.root.children[0];
    await cloud.loadBatch([child]);
    await cloud.loadBatch([child]);
    assert.equal(ranges.length, 2); // root and first child load; second child load is a cache hit.
    assert.deepEqual(cloud.fetchStats, { rangeRequests: 2, fetchedNodes: 2 });
    assert.equal(cloud.decodedQueue.length, 2);
    cloud.encodedCacheByteBudget = 0;
    const inFlight = cloud.loadBatch([child]);
    cloud.clearFetchStats();
    await inFlight;
    assert.equal(ranges.length, 3);
    assert.deepEqual(cloud.fetchStats, { rangeRequests: 0, fetchedNodes: 0 });
  } finally {
    cloud.dispose();
  }
});

test('loads a selected local folder using slices of the binary files', async () => {
  const hierarchy = concat(record(1, 1, 1, 0, 18), record(0, 0, 1, 18, 18));
  const octree = concat(uncompressedPoint(2, 4, 6, 255, 0, 0), uncompressedPoint(4, 6, 8, 0, 255, 0));
  const reads = [];
  class TrackedFile extends File {
    slice(start, end) { reads.push([this.name, start, end]); return super.slice(start, end); }
  }
  const files = [
    new TrackedFile([JSON.stringify(base)], 'metadata.json'),
    new TrackedFile([hierarchy], 'hierarchy.bin'),
    new TrackedFile([octree], 'octree.bin'),
    new File(['ignored'], 'notes.txt'),
  ];
  for (const file of files) {
    Object.defineProperty(file, 'webkitRelativePath', { value: `selected/cloud/${file.name}` });
  }
  const cloud = await loadPotreeV2FromFiles(files, { minNodePixelSize: 1 });
  assert.equal(cloud.encodedCacheByteBudget, 0);
  assert.deepEqual(reads, [['hierarchy.bin', 0, 44], ['octree.bin', 0, 18]]);
  assert.equal(cloud.group.children.length, 1);
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(4, 4, 20);
  camera.lookAt(4, 4, 4);
  cloud.update(camera, 600);
  await waitFor(() => { cloud.update(camera, 600); return cloud.group.children.length === 2; });
  assert.deepEqual(reads.at(-1), ['octree.bin', 18, 36]);
  assert.equal(cloud.group.children.length, 2);
  cloud.dispose();
});

test('requires exactly one complete local dataset', () => {
  assert.throws(() => selectPotreeV2Files([new File(['{}'], 'metadata.json')]), /3ファイル/);
  const names = ['metadata.json', 'hierarchy.bin', 'octree.bin'];
  const files = ['first', 'second'].flatMap(dir => names.map(name => {
    const file = new File([''], name);
    Object.defineProperty(file, 'webkitRelativePath', { value: `${dir}/${name}` });
    return file;
  }));
  assert.throws(() => selectPotreeV2Files(files), /複数/);
});

function flakyCloudFetcher(files, failures, status = 500, headers = {}) {
  const requests = [];
  const fetcher = async (url, init = {}) => {
    const name = new URL(url).pathname.split('/').at(-1);
    if (name === 'metadata.json') return new Response(files[name]);
    const range = init.headers.Range;
    requests.push(`${name} ${range}`);
    const key = `${name} ${range}`;
    if (failures[key] > 0) {
      failures[key]--;
      return new Response(null, { status, headers });
    }
    const file = files[name];
    const match = /bytes=(\d+)-(\d+)/.exec(range);
    return new Response(file.slice(Number(match[1]), Number(match[2]) + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${match[1]}-${match[2]}/${file.byteLength}` },
    });
  };
  return { fetcher, requests };
}

function childViewCamera() {
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(4, 4, 20);
  camera.lookAt(4, 4, 4);
  return camera;
}

const childFiles = {
  'metadata.json': JSON.stringify(base),
  'hierarchy.bin': concat(record(1, 1, 1, 0, 18), record(0, 0, 1, 18, 18)),
  'octree.bin': concat(uncompressedPoint(2, 4, 6, 255, 0, 0), uncompressedPoint(4, 6, 8, 0, 255, 0)),
};

test('retries a node whose octree range failed transiently', async () => {
  const { fetcher } = flakyCloudFetcher(childFiles, { 'octree.bin bytes=18-35': 1 });
  const errors = [];
  const cloud = await loadPotreeV2('https://example.test/cloud/metadata.json', {
    fetch: fetcher, minNodePixelSize: 1, retryDelayMs: 10,
    onError: (error, node) => errors.push(node),
  });
  try {
    const camera = childViewCamera();
    await waitFor(() => { cloud.update(camera, 600); return cloud.group.children.length === 2; });
    assert.deepEqual(errors, ['r0']);
    await waitFor(() => { cloud.update(camera, 600); return cloud.loadDiagnostics.sceneReadySeconds !== null; });
  } finally {
    cloud.dispose();
  }
});

test('retries a hierarchy chunk that failed transiently', async () => {
  const files = {
    'metadata.json': JSON.stringify(base),
    // Root, then a proxy child whose own chunk lives at byte 44.
    'hierarchy.bin': concat(record(1, 1, 1, 0, 18), record(2, 0, 1, 44, 22), record(0, 0, 1, 18, 18)),
    'octree.bin': childFiles['octree.bin'],
  };
  const { fetcher } = flakyCloudFetcher(files, { 'hierarchy.bin bytes=44-65': 1 });
  const errors = [];
  const cloud = await loadPotreeV2('https://example.test/cloud/metadata.json', {
    fetch: fetcher, minNodePixelSize: 1, retryDelayMs: 10,
    onError: (error, node) => errors.push(node),
  });
  try {
    const camera = childViewCamera();
    await waitFor(() => { cloud.update(camera, 600); return cloud.group.children.length === 2; });
    assert.equal(cloud.root.children[0].hierarchyLoaded, true);
    assert.deepEqual(errors, ['r0']);
  } finally {
    cloud.dispose();
  }
});

test('waits for the retry delay before requesting a failed node again', async () => {
  const { fetcher, requests } = flakyCloudFetcher(childFiles, { 'octree.bin bytes=18-35': 1 });
  const errors = [];
  const cloud = await loadPotreeV2('https://example.test/cloud/metadata.json', {
    fetch: fetcher, minNodePixelSize: 1, retryDelayMs: 60_000,
    onError: (error, node) => errors.push(node),
  });
  try {
    const camera = childViewCamera();
    await waitFor(() => { cloud.update(camera, 600); return errors.length === 1; });
    for (let i = 0; i < 20; i++) {
      cloud.update(camera, 600);
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(requests.filter(r => r === 'octree.bin bytes=18-35').length, 1);
    assert.equal(cloud.group.children.length, 1);
  } finally {
    cloud.dispose();
  }
});

test('parses Retry-After seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:05 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')), 5000);
  assert.equal(parseRetryAfter('soon'), undefined);
  assert.equal(parseRetryAfter(null), undefined);
});

test('range requests report the HTTP status and Retry-After', async () => {
  const fetcher = async () => new Response('busy', { status: 429, headers: { 'Retry-After': '2' } });
  const error = await fetchRange(new URL('https://example.test/octree.bin'), 0n, 2n, fetcher).catch(e => e);
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterMs, 2000);
  assert.equal(error.throttled, true);
});

test('a throttled origin pauses new requests and halves concurrency', async () => {
  const gate = new RequestGate();
  assert.equal(gate.available(), Infinity);
  const releases = [];
  const pending = [];
  for (let i = 0; i < 4; i++) {
    pending.push(gate.request(() => new Promise((resolve, reject) => releases.push({ resolve, reject })), 1000));
  }
  releases[0].reject(new HttpError('busy', 429, 40));
  await assert.rejects(pending[0], HttpError);
  assert.equal(gate.available(), 0);
  // Other requests of the same burst do not halve the limit again.
  releases[1].reject(new HttpError('busy', 503));
  await assert.rejects(pending[1], HttpError);
  assert.equal(gate.concurrencyLimit, 2);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(gate.available(), 0, 'two requests are still in flight');
  releases[2].resolve();
  releases[3].resolve();
  await Promise.all(pending.slice(2));
  assert.equal(gate.available(), 3, 'two successes at limit 2 raise it to 3');
});

test('retry waits for the gate and gives up on other errors', async () => {
  const gate = new RequestGate();
  let calls = 0;
  const result = await gate.retry(() => gate.request(async () => {
    if (++calls < 3) throw new HttpError('busy', 503);
    return 'ok';
  }, 5), 6);
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(gate.retry(() => gate.request(async () => {
    calls++;
    throw new HttpError('missing', 404);
  }, 5), 6), /missing/);
  assert.equal(calls, 1);
});

test('load retries throttled metadata and root requests', async () => {
  let metadataFailures = 1;
  const { fetcher } = flakyCloudFetcher(childFiles, { 'hierarchy.bin bytes=0-43': 1, 'octree.bin bytes=0-17': 1 }, 429);
  const throttledMetadata = async (url, init) => {
    if (new URL(url).pathname.endsWith('metadata.json') && metadataFailures-- > 0) {
      return new Response(null, { status: 503, headers: { 'Retry-After': '0' } });
    }
    return fetcher(url, init);
  };
  const cloud = await loadPotreeV2('https://throttled-load.test/cloud/metadata.json', {
    fetch: throttledMetadata, retryDelayMs: 5,
  });
  try {
    assert.equal(cloud.group.children.length, 1);
    assert.equal(cloud.loadDiagnostics.throttledResponses, 2);
  } finally {
    cloud.dispose();
  }
});

test('throttled node loads are retried without reporting errors', async () => {
  const { fetcher, requests } = flakyCloudFetcher(childFiles, { 'octree.bin bytes=18-35': 1 }, 429);
  const errors = [];
  const cloud = await loadPotreeV2('https://throttled-node.test/cloud/metadata.json', {
    fetch: fetcher, minNodePixelSize: 1, retryDelayMs: 20,
    onError: (error, node) => errors.push(node),
  });
  try {
    const camera = childViewCamera();
    await waitFor(() => { cloud.update(camera, 600); return requests.includes('octree.bin bytes=18-35'); });
    await waitFor(() => { cloud.update(camera, 600); return cloud.group.children.length === 2; });
    assert.deepEqual(errors, []);
    assert.equal(requests.filter(r => r === 'octree.bin bytes=18-35').length, 2);
    assert.equal(cloud.loadDiagnostics.throttledResponses, 1);
  } finally {
    cloud.dispose();
  }
});

test('stops selecting once the most important remaining node exceeds the point budget', async () => {
  const metadata = { ...base, points: 7, hierarchy: { firstChunkSize: 66 } };
  const files = {
    'metadata.json': JSON.stringify(metadata),
    // r0 (near the camera, 5 points) outranks r1 (1 point), which alone would still fit.
    'hierarchy.bin': concat(record(1, 3, 1, 0, 18), record(0, 0, 5, 18, 90), record(0, 0, 1, 108, 18)),
    'octree.bin': concat(uncompressedPoint(2, 4, 6, 255, 0, 0), new Uint8Array(108)),
  };
  const { fetcher, requests } = flakyCloudFetcher(files, {});
  const cloud = await loadPotreeV2('https://example.test/cloud/metadata.json', {
    fetch: fetcher, minNodePixelSize: 1, pointBudget: 3,
  });
  try {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(2, 2, -10);
    camera.lookAt(2, 2, 2);
    cloud.update(camera, 600);
    assert.equal(cloud.loadDiagnostics.requiredNodes, 1);
    assert.deepEqual(requests.filter(r => r.startsWith('octree.bin')), ['octree.bin bytes=0-17']);
  } finally {
    cloud.dispose();
  }
});

test('aborts octree requests the view stopped needing and requests them again later', async () => {
  let hang = true;
  const { fetcher: files } = flakyCloudFetcher(childFiles, {});
  const signals = [];
  const fetcher = (url, init = {}) => {
    if (init.headers?.Range === 'bytes=18-35' && hang) {
      hang = false;
      signals.push(init.signal);
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'));
      }));
    }
    return files(url, init);
  };
  const errors = [];
  const cloud = await loadPotreeV2('https://example.test/cloud/metadata.json', {
    fetch: fetcher, minNodePixelSize: 1, onError: (error, node) => errors.push(node),
  });
  try {
    const camera = childViewCamera();
    cloud.update(camera, 600);
    assert.equal(signals.length, 1);
    // The child is no longer needed, but its request is kept briefly in case the view returns.
    cloud.minNodePixelSize = 10_000;
    cloud.update(camera, 600);
    assert.equal(signals[0].aborted, false);
    await waitFor(() => { cloud.update(camera, 600); return signals[0].aborted; });
    assert.equal(cloud.loadDiagnostics.abortedRequests, 1);
    cloud.minNodePixelSize = 1;
    await waitFor(() => { cloud.update(camera, 600); return cloud.group.children.length === 2; });
    assert.deepEqual(errors, []);
  } finally {
    cloud.dispose();
  }
});

test('update skips traversal as soon as the view is in the scene and still completes the measurement', async () => {
  const { fetcher } = flakyCloudFetcher(childFiles, {});
  const cloud = await loadPotreeV2('https://example.test/cloud/metadata.json', { fetch: fetcher, minNodePixelSize: 1 });
  try {
    const camera = childViewCamera();
    await waitFor(() => { cloud.update(camera, 600); return cloud.settled; });
    assert.equal(cloud.loadDiagnostics.state, 'loading');
    let traversals = 0;
    const updateLoadDiagnostics = cloud.updateLoadDiagnostics.bind(cloud);
    cloud.updateLoadDiagnostics = (...args) => { traversals++; return updateLoadDiagnostics(...args); };
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(cloud.update(camera, 600), false);
    assert.equal(traversals, 0);
    assert.equal(cloud.loadDiagnostics.state, 'complete');
  } finally {
    cloud.dispose();
  }
});

const intensityMetadata = {
  ...base,
  attributes: [
    base.attributes[0],
    { name: 'intensity', type: 'uint16', size: 2, numElements: 1, elementSize: 2 },
    base.attributes[1],
  ],
};

test('decodes only position and rgb by default and skips other attributes', async () => {
  const node = createRoot(intensityMetadata);
  node.numPoints = 1;
  const point = uncompressedPoint(2, 4, 6, 255, 128, 1);
  const data = concat(point.subarray(0, 12), new Uint8Array([0x34, 0x12]), point.subarray(12));
  const geometry = await decodeNode(data.buffer, node, intensityMetadata);
  assert.deepEqual(Object.keys(geometry.attributes).sort(), ['color', 'position']);
  assert.deepEqual([...geometry.getAttribute('position').array], [1, 2, 3]);
  assert.deepEqual([...geometry.getAttribute('color').array], [255, 128, 1, 255]);
  geometry.dispose();

  const selected = await decodeNode(data.buffer, node, intensityMetadata, ['position', 'intensity']);
  assert.deepEqual(Object.keys(selected.attributes).sort(), ['intensity', 'position']);
  assert.deepEqual([...selected.getAttribute('intensity').array], [0x1234]);
  selected.dispose();
});

test('skips unrequested Brotli attribute columns', async () => {
  const metadata = { ...intensityMetadata, encoding: 'BROTLI' };
  const node = createRoot(metadata);
  node.numPoints = 1;
  const raw = new ArrayBuffer(26);
  const view = new DataView(raw);
  view.setBigUint64(8, morton(2, 4, 6, 16), true);
  view.setUint16(16, 0x1234, true);
  view.setBigUint64(18, morton(100, 200, 300, 16), true);
  const compressed = brotliCompressSync(Buffer.from(raw));
  const bytes = () => compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength);
  const geometry = await decodeNode(bytes(), node, metadata);
  assert.deepEqual(Object.keys(geometry.attributes).sort(), ['color', 'position']);
  assert.deepEqual([...geometry.getAttribute('color').array], [100, 200, 1, 255]);
  geometry.dispose();
  const selected = await decodeNode(bytes(), node, metadata, ['position', 'intensity']);
  assert.deepEqual([...selected.getAttribute('intensity').array], [0x1234]);
  selected.dispose();
});

/**
 * Generic attributes covering element types, multi-element values and 64-bit
 * normalization. In a 3-point Brotli node the columns before `flag` are aligned for
 * typed-array views, and `flag` misaligns the columns after it.
 */
const genericAttributes = [
  {
    name: 'pair', type: 'uint16', size: 4, numElements: 2, elementSize: 2,
    write: (view, at, i) => { view.setUint16(at, 1000 + i, true); view.setUint16(at + 2, 65535 - i, true); },
    expected: i => [1000 + i, 65535 - i],
  },
  {
    name: 'height', type: 'float', size: 4, numElements: 1, elementSize: 4,
    write: (view, at, i) => view.setFloat32(at, -1.5 * i, true), expected: i => [-1.5 * i],
  },
  {
    name: 'time', type: 'double', size: 8, numElements: 1, elementSize: 8, min: [1000], max: [1100],
    write: (view, at, i) => view.setFloat64(at, 1000 + i * 2, true), expected: i => [Math.fround(i * 2 / 100)],
  },
  {
    name: 'id', type: 'int64', size: 8, numElements: 1, elementSize: 8, min: [-10], max: [90],
    write: (view, at, i) => view.setBigInt64(at, BigInt(i * 10 - 10), true), expected: i => [Math.fround(i / 10)],
  },
  {
    name: 'flag', type: 'int8', size: 1, numElements: 1, elementSize: 1,
    write: (view, at, i) => view.setInt8(at, 1 - i), expected: i => [1 - i],
  },
  {
    name: 'count', type: 'uint32', size: 4, numElements: 1, elementSize: 4,
    write: (view, at, i) => view.setUint32(at, 4_000_000_000 + i, true), expected: i => [Math.fround(4_000_000_000 + i)],
  },
  {
    name: 'constant', type: 'double', size: 8, numElements: 1, elementSize: 8, min: [5], max: [5],
    write: (view, at) => view.setFloat64(at, 5, true), expected: () => [0],
  },
];
const genericNames = genericAttributes.map(a => a.name);

/** A node whose point i stores the generic attribute values for i + seed. */
function genericNode(encoding, pointCount, seed = 0) {
  const metadata = {
    ...base, encoding, points: pointCount,
    attributes: [base.attributes[0], ...genericAttributes.map(({ write, expected, ...attribute }) => attribute)],
  };
  const node = createRoot(metadata);
  node.numPoints = pointCount;
  const compressed = encoding === 'BROTLI';
  const positionSize = compressed ? 16 : 12;
  const pointSize = positionSize + genericAttributes.reduce((n, a) => n + a.size, 0);
  const raw = new ArrayBuffer(pointSize * pointCount);
  const view = new DataView(raw);
  for (let i = 0; i < pointCount; i++) {
    if (compressed) view.setBigUint64(i * 16 + 8, morton(i, i, i, 16), true);
    else [i, i, i].forEach((value, axis) => view.setInt32(i * pointSize + axis * 4, value, true));
  }
  let column = positionSize * pointCount;
  let field = positionSize;
  for (const attribute of genericAttributes) {
    for (let i = 0; i < pointCount; i++) {
      attribute.write(view, compressed ? column + i * attribute.size : i * pointSize + field, i + seed);
    }
    column += attribute.size * pointCount;
    field += attribute.size;
  }
  const bytes = compressed ? brotliCompressSync(Buffer.from(raw)) : new Uint8Array(raw);
  return { metadata, node, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

function assertGenericValues(geometry, pointCount, seed = 0) {
  for (const attribute of genericAttributes) {
    const expected = Array.from({ length: pointCount }, (_, i) => attribute.expected(i + seed)).flat();
    assert.deepEqual([...geometry.getAttribute(attribute.name).array], expected, attribute.name);
  }
}

for (const encoding of ['UNCOMPRESSED', 'BROTLI']) {
  test(`decodes generic ${encoding} attributes of every layout`, async () => {
    const { metadata, node, bytes } = genericNode(encoding, 3);
    const geometry = await decodeNode(bytes, node, metadata, ['position', ...genericNames]);
    assertGenericValues(geometry, 3);
    geometry.dispose();
  });
}

test('Brotli results stay valid after the decoder reuses its memory', async () => {
  const first = genericNode('BROTLI', 3, 0);
  const second = genericNode('BROTLI', 3, 7);
  const a = await decodeNode(first.bytes, first.node, first.metadata, ['position', ...genericNames]);
  const b = await decodeNode(second.bytes, second.node, second.metadata, ['position', ...genericNames]);
  assertGenericValues(a, 3, 0);
  assertGenericValues(b, 3, 7);
  assert.deepEqual([...a.getAttribute('position').array], [0, 0, 0, 0.5, 0.5, 0.5, 1, 1, 1]);
});

test('attributes option selects decoded attributes and rejects unknown names', async () => {
  const files = {
    'metadata.json': JSON.stringify({ ...intensityMetadata, hierarchy: { firstChunkSize: 22 } }),
    'hierarchy.bin': record(0, 0, 1, 0, 20),
    'octree.bin': concat(uncompressedPoint(2, 4, 6, 1, 2, 3).subarray(0, 12), new Uint8Array([7, 0]),
      uncompressedPoint(0, 0, 0, 1, 2, 3).subarray(12)),
  };
  const { fetcher } = flakyCloudFetcher(files, {});
  const cloud = await loadPotreeV2('https://example.test/cloud/metadata.json', {
    fetch: fetcher, attributes: ['intensity'],
  });
  try {
    const geometry = cloud.group.children[0].geometry;
    assert.deepEqual(Object.keys(geometry.attributes).sort(), ['intensity', 'position']);
    assert.deepEqual([...geometry.getAttribute('intensity').array], [7]);
    assert.equal(cloud.material.vertexColors, false);
  } finally {
    cloud.dispose();
  }
  await assert.rejects(
    loadPotreeV2('https://example.test/cloud/metadata.json', { fetch: fetcher, attributes: ['Intensity'] }),
    /no attribute: Intensity/,
  );
});

test('evicts least recently displayed nodes and drops their idle state', async () => {
  const { fetcher, requests } = flakyCloudFetcher(childFiles, {});
  const cloud = await loadPotreeV2('https://example.test/cloud/metadata.json', {
    fetch: fetcher, minNodePixelSize: 1, cachePointBudget: 1,
  });
  try {
    const camera = childViewCamera();
    const child = cloud.root.children[0];
    await waitFor(() => { cloud.update(camera, 600); return cloud.group.children.length === 2; });
    // Displayed nodes are kept even over the cache budget.
    cloud.update(camera, 600);
    assert.equal(cloud.group.children.length, 2);
    assert.deepEqual([...cloud.installed.keys()], [cloud.root, child]);

    cloud.minNodePixelSize = 10_000;
    cloud.update(camera, 600);
    assert.deepEqual(cloud.group.children.map(node => node.name), ['r']);
    assert.deepEqual([...cloud.installed.keys()], [cloud.root]);
    assert.equal(cloud.states.has(child), false);
    assert.equal(cloud.states.size, 1);

    cloud.minNodePixelSize = 1;
    await waitFor(() => { cloud.update(camera, 600); return cloud.group.children.length === 2; });
    assert.equal(requests.filter(request => request === 'octree.bin bytes=18-35').length, 2);
  } finally {
    cloud.dispose();
  }
});

test('a batch frees its request slot while it waits for decoding', async () => {
  const metadata = { ...base, points: 3, hierarchy: { firstChunkSize: 66 } };
  const files = {
    'metadata.json': JSON.stringify(metadata),
    'hierarchy.bin': concat(record(1, 3, 1, 0, 18), record(0, 0, 1, 18, 18), record(0, 0, 1, 70_000, 18)),
    'octree.bin': new Uint8Array(70_018),
  };
  const { fetcher, requests } = flakyCloudFetcher(files, {});
  const cloud = await loadPotreeV2('https://example.test/cloud/metadata.json', {
    fetch: fetcher, maxConcurrentLoads: 1, decoderWorkers: 2,
  });
  const releases = [];
  const decodeBatch = cloud.decoder.decodeBatch.bind(cloud.decoder);
  cloud.decoder.decodeBatch = (...args) => new Promise(resolve => releases.push(() => resolve(decodeBatch(...args))));
  try {
    const [r0, r1] = cloud.root.children;
    cloud.constructor.requestBatches([{ cloud, pending: [r0, r1] }], cloud.ownLimits());
    await waitFor(() => releases.length === 1);
    assert.equal(cloud.inFlight, 0);
    cloud.constructor.requestBatches([{ cloud, pending: [r0, r1] }], cloud.ownLimits());
    await waitFor(() => releases.length === 2);
    assert.deepEqual(requests.filter(r => r.startsWith('octree.bin')).slice(1),
      ['octree.bin bytes=18-35', 'octree.bin bytes=70000-70017']);
    releases.forEach(release => release());
    await waitFor(() => cloud.decodedQueue.length === 2);
  } finally {
    cloud.dispose();
  }
});

test('update skips unchanged settled views and reports scene changes', async () => {
  const { fetcher } = flakyCloudFetcher(childFiles, {});
  const cloud = await loadPotreeV2('https://example.test/cloud/metadata.json', { fetch: fetcher, minNodePixelSize: 1 });
  try {
    const camera = childViewCamera();
    let changed = false;
    await waitFor(() => { changed = cloud.update(camera, 600) || changed; return cloud.group.children.length === 2; });
    assert.equal(changed, true);
    const deadline = Date.now() + 3000;
    while (cloud.loadDiagnostics.state !== 'complete' || !cloud.settled) {
      assert.ok(Date.now() < deadline, 'load did not settle');
      cloud.update(camera, 600);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    let traversals = 0;
    const updateLoadDiagnostics = cloud.updateLoadDiagnostics.bind(cloud);
    cloud.updateLoadDiagnostics = (...args) => { traversals++; return updateLoadDiagnostics(...args); };
    assert.equal(cloud.update(camera, 600), false);
    assert.equal(cloud.update(camera, 600), false);
    assert.equal(traversals, 0);

    // A settings change forces a traversal, which hides the child.
    cloud.minNodePixelSize = 10_000;
    assert.equal(cloud.update(camera, 600), true);
    assert.equal(cloud.group.children.find(child => child.name === 'r0').visible, false);
    // Camera movement is detected as well.
    cloud.minNodePixelSize = 1;
    camera.position.z = 19;
    assert.equal(cloud.update(camera, 600), true);
    assert.ok(traversals >= 2);
  } finally {
    cloud.dispose();
  }
});

async function loadChildClouds(count) {
  const clouds = [];
  for (let i = 0; i < count; i++) {
    const { fetcher } = flakyCloudFetcher(childFiles, {});
    clouds.push(await loadPotreeV2(`https://example.test/cloud${i}/metadata.json`, { fetch: fetcher, minNodePixelSize: 1 }));
  }
  return clouds;
}

test('a cloud set shares one point budget, preferring the larger projected nodes of any cloud', async () => {
  const [near, far] = await loadChildClouds(2);
  const set = new PotreeV2PointCloudSet({ pointBudget: 3 });
  set.add(near);
  set.add(far);
  try {
    far.group.position.z = -20; // Its child projects smaller than the near cloud's child.
    const camera = childViewCamera();
    await waitFor(() => { set.update(camera, 600); return near.group.children.length === 2; });
    set.update(camera, 600);
    // Two roots and one child fit in 3 points; each cloud's own 2,000,000 budget is ignored.
    assert.equal(near.loadDiagnostics.requiredNodes, 2);
    assert.equal(far.loadDiagnostics.requiredNodes, 1);
    assert.equal(far.group.children.length, 1);
    set.pointBudget = 4;
    await waitFor(() => { set.update(camera, 600); return far.group.children.length === 2; });
  } finally {
    near.dispose();
    far.dispose();
  }
});

test('a cloud set evicts the least recently displayed node across clouds', async () => {
  const [a, b] = await loadChildClouds(2);
  const set = new PotreeV2PointCloudSet({ pointBudget: 10, cachePointBudget: 10 });
  set.add(a);
  set.add(b);
  try {
    const camera = childViewCamera();
    await waitFor(() => {
      set.update(camera, 600);
      return a.group.children.length === 2 && b.group.children.length === 2;
    });
    a.minNodePixelSize = 10_000; // a's child was displayed before b's child.
    set.update(camera, 600);
    b.minNodePixelSize = 10_000;
    set.update(camera, 600);
    assert.equal(a.group.children.length, 2);
    assert.equal(b.group.children.length, 2);
    set.cachePointBudget = 3;
    assert.equal(set.update(camera, 600), true);
    assert.deepEqual(a.group.children.map(node => node.name), ['r']);
    assert.deepEqual(b.group.children.map(node => node.name), ['r', 'r0']);
  } finally {
    a.dispose();
    b.dispose();
  }
});

test('a cloud in a set is updated through the set until removed or disposed', async () => {
  const [a, b] = await loadChildClouds(2);
  const set = new PotreeV2PointCloudSet();
  const other = new PotreeV2PointCloudSet();
  try {
    set.add(a);
    set.add(b);
    assert.throws(() => other.add(a), /another PotreeV2PointCloudSet/);
    assert.throws(() => a.update(childViewCamera(), 600), /call the set's update/);
    assert.equal(set.remove(a), true);
    assert.doesNotThrow(() => a.update(childViewCamera(), 600));
    other.add(a);
    assert.doesNotThrow(() => other.update(childViewCamera(), 600));
    b.dispose();
    assert.deepEqual(set.clouds, []);
  } finally {
    a.dispose();
    b.dispose();
  }
});

test('clouds share one decoder pool until the last one is disposed', async () => {
  const [a, b] = await loadChildClouds(2);
  const { fetcher } = flakyCloudFetcher(childFiles, {});
  const c = await loadPotreeV2('https://example.test/cloud-c/metadata.json', { fetch: fetcher, decoderWorkers: 7 });
  assert.equal(a.decoder, b.decoder);
  assert.equal(a.decoder, c.decoder);
  assert.equal(a.decoder.maxWorkers, 7);
  const pool = a.decoder;
  a.dispose();
  c.dispose();
  assert.equal(b.decoder, pool);
  b.dispose();
  const [d] = await loadChildClouds(1);
  assert.notEqual(d.decoder, pool);
  d.dispose();
});

test('a cloud set shares request slots and requests the most important cloud first', async () => {
  const clouds = [];
  const octreeRequests = [];
  const held = [];
  for (const name of ['near', 'far']) {
    const { fetcher } = flakyCloudFetcher(childFiles, {});
    const holding = async (url, init) => {
      if (clouds.length === 2 && String(url).endsWith('octree.bin')) {
        octreeRequests.push(`${name} ${init.headers.Range}`);
        await new Promise(resolve => held.push(resolve));
      }
      return fetcher(url, init);
    };
    clouds.push(await loadPotreeV2(`https://example.test/${name}/metadata.json`, { fetch: holding, minNodePixelSize: 1 }));
  }
  const [near, far] = clouds;
  const set = new PotreeV2PointCloudSet({ maxConcurrentLoads: 1 });
  set.add(far);
  set.add(near);
  try {
    far.group.position.z = -20;
    const camera = childViewCamera();
    set.update(camera, 600);
    set.update(camera, 600);
    await waitFor(() => octreeRequests.length === 1);
    assert.deepEqual(octreeRequests, ['near bytes=18-35']);
    held.shift()();
    await waitFor(() => { set.update(camera, 600); return octreeRequests.length === 2; });
    assert.equal(octreeRequests[1], 'far bytes=18-35');
    held.shift()();
    await waitFor(() => { set.update(camera, 600); return far.group.children.length === 2; });
  } finally {
    near.dispose();
    far.dispose();
  }
});

test('a cloud set installs the most important decoded nodes of any cloud first', async () => {
  const [near, far] = await loadChildClouds(2);
  const set = new PotreeV2PointCloudSet({ maxNodesToGPUPerFrame: 1 });
  set.add(far);
  set.add(near);
  try {
    far.group.position.z = -20;
    const camera = childViewCamera();
    set.update(camera, 600);
    await waitFor(() => near.decodedQueue.length === 1 && far.decodedQueue.length === 1);
    set.update(camera, 600);
    assert.equal(near.group.children.length, 2);
    assert.equal(far.group.children.length, 1);
    set.update(camera, 600);
    assert.equal(far.group.children.length, 2);
  } finally {
    near.dispose();
    far.dispose();
  }
});
