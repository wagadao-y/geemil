// Observation tests: passing means the reported defect was reproduced, not fixed.
// Run after pnpm --filter @geemil/potree-v2-three build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync } from 'node:zlib';
import { createServer } from 'node:http';
import {
  loadPotreeV2,
  PotreeV2PointCloudSet,
  selectPotreeV2Files,
  PotreeV2EDL,
} from '../../../packages/potree-v2-three/dist/index.js';
import { createRoot, validateMetadata } from '../../../packages/potree-v2-three/dist/format.js';
import { decodeNodeData, decodeBatchNode } from '../../../packages/potree-v2-three/dist/decode.js';
import { DecoderPool } from '../../../packages/potree-v2-three/dist/decoder-pool.js';
import {
  occupancyLevelOffset,
  VisibleNodesTexture,
} from '../../../packages/potree-v2-three/dist/point-size.js';
import {
  PotreeV2Clipping,
  snapshotClipping,
  clipNode,
} from '../../../packages/potree-v2-three/dist/clipping.js';
import { fetchRange } from '../../../packages/potree-v2-three/dist/http.js';

const require = createRequire(
  new URL('../../../packages/potree-v2-three/package.json', import.meta.url),
);
const { Box3, Color, Group, Matrix4, OrthographicCamera, Plane, Scene, Vector3, Vector4 } =
  await import(pathToFileURL(require.resolve('three')));
const position = { name: 'position', type: 'int32', size: 12, numElements: 3, elementSize: 4 };
const base = {
  version: '2.0',
  encoding: 'DEFAULT',
  points: 1,
  spacing: 1,
  scale: [1, 1, 1],
  offset: [0, 0, 0],
  boundingBox: { min: [0, 0, 0], max: [8, 8, 8] },
  hierarchy: { firstChunkSize: 22 },
  attributes: [position],
};
function record(type, mask, points, offset, size) {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, type);
  view.setUint8(1, mask);
  view.setUint32(2, points, true);
  view.setBigUint64(6, BigInt(offset), true);
  view.setBigUint64(14, BigInt(size), true);
  return bytes;
}
function concat(...buffers) {
  return Uint8Array.from(buffers.flatMap((b) => [...b]));
}
function fetcher(
  metadata = base,
  hierarchy = record(1, 0, 1, 0, 12),
  octree = new Uint8Array(12),
  requests = [],
) {
  return async (url, init = {}) => {
    const name = new URL(url).pathname.split('/').at(-1);
    requests.push({ url: String(url), range: init.headers?.Range });
    if (name === 'metadata.json') return new Response(JSON.stringify(metadata));
    const file = name === 'hierarchy.bin' ? hierarchy : octree;
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    return new Response(file.slice(Number(a), Number(b) + 1), { status: 206 });
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('controlled task did not reach checkpoint');
}
function camera() {
  const c = new OrthographicCamera(-8, 8, 8, -8, 0.1, 100);
  c.position.set(4, 4, 20);
  c.lookAt(4, 4, 0);
  return c;
}

test('A01: metadata accepts invalid point totals, duplicate names and infinite computed extent', async () => {
  for (const points of [undefined, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.doesNotThrow(() => validateMetadata({ ...base, points }));
  const duplicated = { ...base, attributes: [position, position] };
  validateMetadata(duplicated);
  const bytes = new Uint8Array(24);
  new DataView(bytes.buffer).setInt32(12, 7, true);
  assert.equal((await decodeNodeData(bytes, 'r', 1, duplicated)).position.array[0], 7);
  const huge = validateMetadata({
    ...base,
    boundingBox: { min: [-1e308, 0, 0], max: [1e308, 8, 8] },
  });
  assert.equal(createRoot(huge).box.max.x, Infinity);
});

test('A02: uint64 loses small differences before normalization in both encodings', async () => {
  const low = 1n << 60n;
  for (const encoding of ['DEFAULT', 'BROTLI']) {
    const metadata = {
      ...base,
      encoding,
      attributes: [
        position,
        {
          name: 'id',
          type: 'uint64',
          size: 8,
          numElements: 1,
          elementSize: 8,
          min: [Number(low)],
          max: [Number(low + 256n)],
        },
      ],
    };
    const raw = new Uint8Array(encoding === 'DEFAULT' ? 20 : 24);
    new DataView(raw.buffer).setBigUint64(encoding === 'DEFAULT' ? 12 : 16, low + 128n, true);
    const bytes = encoding === 'BROTLI' ? brotliCompressSync(raw) : raw;
    const decoded = await decodeNodeData(bytes, 'r', 1, metadata, undefined, ['position', 'id']);
    const independentExpected = Number(low + 128n - low) / Number(256n);
    assert.equal(independentExpected, 0.5);
    assert.equal(decoded.id.array[0], 0);
  }
});

test('A03: repeated proxy range extends the tree beyond declared depth with pointBudget zero', async () => {
  const requests = [];
  const metadata = { ...base, points: 0, hierarchy: { firstChunkSize: 44, depth: 2 } };
  const hierarchy = concat(record(0, 1, 0, 0, 0), record(2, 0, 0, 0, 44));
  const cloud = await loadPotreeV2('https://cycle.audit/metadata.json', {
    fetch: fetcher(metadata, hierarchy, new Uint8Array(), requests),
    minNodePixelSize: 0,
  });
  const set = new PotreeV2PointCloudSet({ pointBudget: 0 });
  set.add(cloud);
  try {
    for (let i = 0; i < 12; i++) {
      set.update(camera(), 300);
      await until(() => cloud.inFlight === 0);
    }
    let deepest = cloud.root;
    while (deepest.children[0]) deepest = deepest.children[0];
    assert.ok(deepest.level >= 12);
    assert.equal(requests.filter((r) => r.range === 'bytes=0-43').length, 13);
    assert.equal(cloud.loading, true);
  } finally {
    cloud.dispose();
  }
});

test('A04: abort during a running root Worker job does not settle load until response', async () => {
  const original = globalThis.Worker;
  const posted = [];
  const workers = [];
  globalThis.Worker = class {
    constructor() {
      workers.push(this);
    }
    postMessage(message) {
      if (message.id) posted.push({ worker: this, message });
    }
    terminate() {
      this.terminated = true;
    }
  };
  const controller = new AbortController();
  const reason = new Error('cancel root decode');
  let settled = false;
  const loading = loadPotreeV2('https://abort.audit/metadata.json', {
    fetch: fetcher(),
    decoderWorkers: 1,
    signal: controller.signal,
  });
  loading.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await until(() => posted.length === 1);
    controller.abort(reason);
    await tick();
    await tick();
    assert.equal(settled, false);
    assert.equal(workers[0].terminated, undefined);
    const { worker, message } = posted[0];
    const nodes = [];
    for (const node of message.nodes)
      nodes.push(await decodeBatchNode(message.bytes, message.start, node, message.metadata));
    worker.onmessage({ data: { id: message.id, nodes } });
    await assert.rejects(loading, (e) => e === reason);
    assert.equal(workers[0].terminated, true);
  } finally {
    globalThis.Worker = original;
  }
});

test('A05: decoded scene queue exceeds its 32-node guard before the next frame', async () => {
  const count = 73;
  const hierarchy = concat(
    ...Array.from({ length: count }, (_, i) =>
      record(i < 9 ? 0 : 1, i < 9 ? 255 : 0, 1, i * 12, 12),
    ),
  );
  const metadata = { ...base, points: count, hierarchy: { firstChunkSize: hierarchy.length } };
  const octree = new Uint8Array(count * 12);
  const values = new DataView(octree.buffer);
  for (let i = 0; i < count; i++) {
    const parent = i < 9 ? i - 1 : Math.floor((i - 9) / 8);
    const child = (i - 9) % 8;
    for (let axis = 0; axis < 3; axis++) {
      const bit = 4 >> axis;
      const v =
        i === 0
          ? 4
          : i < 9
            ? parent & bit
              ? 6
              : 2
            : (parent & bit ? 4 : 0) + (child & bit ? 2 : 0) + 1;
      values.setInt32(i * 12 + axis * 4, v, true);
    }
  }
  const cloud = await loadPotreeV2('https://queue.audit/metadata.json', {
    fetch: fetcher(metadata, hierarchy, octree),
    minNodePixelSize: 0,
  });
  const set = new PotreeV2PointCloudSet({ maxNodesToGPUPerFrame: 1 });
  set.add(cloud);
  try {
    set.update(camera(), 300);
    await until(() => cloud.activeLoads === 0);
    assert.equal(cloud.decodedQueue.length, 64);
  } finally {
    cloud.dispose();
  }
});

test('A06: zero cache budget retains all unselected root geometries', async () => {
  const set = new PotreeV2PointCloudSet({ pointBudget: 0, cachePointBudget: 0 });
  const clouds = await Promise.all(
    [1, 2].map((i) => loadPotreeV2(`https://cache${i}.audit/metadata.json`, { fetch: fetcher() })),
  );
  try {
    clouds.forEach((c) => set.add(c));
    set.update(camera(), 300);
    assert.equal(
      clouds.reduce((n, c) => n + c.cachedPoints, 0),
      2,
    );
    assert.equal(
      clouds.every((c) => !c.group.children[0].visible),
      true,
    );
  } finally {
    clouds.forEach((c) => c.dispose());
  }
});

test('A07: duplicate local names silently select the final file', () => {
  const first = new File(['first'], 'metadata.json');
  const last = new File(['last'], 'metadata.json');
  const selected = selectPotreeV2Files([
    first,
    new File([], 'hierarchy.bin'),
    last,
    new File([], 'octree.bin'),
  ]);
  assert.equal(selected['metadata.json'], last);
});

test('A08: EDL leaves autoClear false when the point pass throws', () => {
  const scene = new Scene();
  const group = new Group();
  scene.add(group);
  scene.background = new Color('red');
  const initialBackground = scene.background;
  let output = null;
  let renders = 0;
  const viewport = new Vector4(0, 0, 300, 300);
  const renderer = {
    autoClear: true,
    getRenderTarget: () => output,
    setRenderTarget: (t) => {
      output = t;
    },
    getCurrentViewport: (v) => v.copy(viewport),
    getClearAlpha: () => 1,
    getClearColor: (c) => c.set('black'),
    setClearColor() {},
    clear() {},
    render() {
      if (++renders === 2) throw new Error('point pass failed');
    },
  };
  const edl = new PotreeV2EDL();
  try {
    assert.throws(() => edl.render(renderer, scene, camera(), [{ group }]), /point pass failed/);
    assert.equal(renderer.autoClear, false);
    assert.equal(group.visible, true);
    assert.equal(scene.background, initialBackground);
    assert.equal(output, null);
  } finally {
    edl.dispose();
  }
});

test('A09: NaN GPU installation limit leaves decoded children pending forever', async () => {
  const metadata = { ...base, points: 2, hierarchy: { firstChunkSize: 44 } };
  const hierarchy = concat(record(0, 1, 1, 0, 12), record(1, 0, 1, 12, 12));
  const cloud = await loadPotreeV2('https://nan.audit/metadata.json', {
    fetch: fetcher(metadata, hierarchy, new Uint8Array(24)),
    minNodePixelSize: 0,
  });
  const set = new PotreeV2PointCloudSet({ maxNodesToGPUPerFrame: NaN });
  set.add(cloud);
  try {
    for (let i = 0; i < 3; i++) {
      set.update(camera(), 300);
      await tick();
    }
    assert.equal(cloud.group.children.length, 1);
    assert.equal(cloud.decodedQueue.length, 1);
    assert.equal(cloud.loading, true);
  } finally {
    cloud.dispose();
  }
});

test('A10: hidden ancestor clip discards descendant prune tests', () => {
  const clipping = new PotreeV2Clipping();
  clipping.addPlane({ plane: new Plane(new Vector3(1, 0, 0), -20), prune: false });
  clipping.addBox({
    matrix: new Matrix4().makeScale(4, 4, 4).setPosition(2, 2, 2),
    mode: 'hide-inside',
  });
  const snapshot = snapshotClipping(clipping, new Matrix4());
  const root = clipNode(
    snapshot.root,
    new Box3(new Vector3(), new Vector3(8, 8, 8)),
    snapshot.keepPrune,
  );
  const child = new Box3(new Vector3(), new Vector3(4, 4, 4));
  assert.equal(clipNode(snapshot.root, child, snapshot.keepPrune), null);
  assert.equal(clipNode(root, child, snapshot.keepPrune).hidden, true);
});

test('A11: Content-Range total smaller than returned range is accepted', async () => {
  const data = await fetchRange(
    new URL('https://range.audit/octree.bin'),
    10n,
    2n,
    async () =>
      new Response(new Uint8Array(2), {
        status: 206,
        headers: { 'Content-Range': 'bytes 10-11/1' },
      }),
  );
  assert.equal(data.byteLength, 2);
});

test('G01: existing texture row-growth fixture has only 585 nodes; 2049 really grows', () => {
  assert.equal(1 + 8 + 64 + 512, 585);
  const texture = new VisibleNodesTexture();
  const nodes = Array.from({ length: 2049 }, (_, i) => ({
    name: `r${String(i).padStart(4, '0')}`,
    level: 1,
    children: [],
  }));
  try {
    texture.update(nodes, () => 0);
    assert.equal(texture.texture.image.height, 2);
    assert.equal(texture.index(nodes.at(-1)), 2048);
  } finally {
    texture.dispose();
  }
});

test('A12: pool capacity retains a disposed cloud highest worker count', () => {
  const a = DecoderPool.acquire(4);
  const b = DecoderPool.acquire(1);
  assert.equal(a, b);
  a.release();
  try {
    assert.equal(b.maxWorkers, 4);
  } finally {
    b.release();
  }
});

test('A13: a generic color attribute overwrites the decoded rgb geometry attribute', async () => {
  const metadata = {
    ...base,
    attributes: [
      position,
      { name: 'rgb', type: 'uint16', size: 6, numElements: 3, elementSize: 2 },
      { name: 'color', type: 'uint8', size: 1, numElements: 1, elementSize: 1 },
    ],
  };
  validateMetadata(metadata);
  const bytes = new Uint8Array(19);
  new DataView(bytes.buffer).setUint16(12, 255, true);
  bytes[18] = 42;
  const decoded = await decodeNodeData(bytes, 'r', 1, metadata, undefined, [
    'position',
    'rgb',
    'color',
  ]);
  assert.equal(decoded.color.itemSize, 1);
  assert.equal(decoded.color.normalized, false);
  assert.deepEqual([...decoded.color.array], [42]);
});

test('A14: moving a fetching cloud to another set bypasses that set request limit', async () => {
  const metadata = { ...base, points: 3, hierarchy: { firstChunkSize: 66 } };
  const hierarchy = concat(
    record(0, 3, 1, 0, 12),
    record(1, 0, 1, 12, 12),
    record(1, 0, 1, 70000, 12),
  );
  const original = fetcher(metadata, hierarchy, new Uint8Array(70012));
  const held = [];
  const cloud = await loadPotreeV2('https://move.audit/metadata.json', {
    minNodePixelSize: 0,
    fetch: (url, init) => {
      if (
        !init.headers?.Range ||
        init.headers.Range.startsWith('bytes=0-') ||
        !String(url).endsWith('octree.bin')
      )
        return original(url, init);
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(init.signal.reason);
        init.signal.addEventListener('abort', onAbort, { once: true });
        held.push({
          signal: init.signal,
          release: () => {
            init.signal.removeEventListener('abort', onAbort);
            resolve(original(url, init));
          },
        });
      });
    },
  });
  const a = new PotreeV2PointCloudSet({ maxConcurrentLoads: 1 });
  const b = new PotreeV2PointCloudSet({ maxConcurrentLoads: 1 });
  try {
    a.add(cloud);
    a.update(camera(), 300);
    assert.equal(held.length, 1);
    a.remove(cloud);
    b.add(cloud);
    b.update(camera(), 300);
    assert.equal(held.length, 2);
    assert.equal(cloud.inFlight, 2);
    assert.equal(b.slots.inFlight, 1);
    assert.equal(a.slots.inFlight, 1);
    b.encodedCacheByteBudget = 0;
    held.forEach((r) => r.release());
    await until(() => cloud.activeLoads === 0);
    assert.equal(b.encodedCache.bytes, 0);
  } finally {
    cloud.dispose();
    await tick();
  }
});

test('V01: disposing one cloud during shared Worker decode does not destroy its peer or accept late data', async () => {
  const originalWorker = globalThis.Worker;
  const posted = [];
  const workers = [];
  let hold = false;
  const respond = async ({ worker, message }) => {
    const nodes = [];
    for (const node of message.nodes)
      nodes.push(await decodeBatchNode(message.bytes, message.start, node, message.metadata));
    worker.onmessage({ data: { id: message.id, nodes } });
  };
  globalThis.Worker = class {
    constructor() {
      workers.push(this);
    }
    postMessage(message) {
      if (!message.id) return;
      const item = { worker: this, message };
      if (hold) posted.push(item);
      else void respond(item);
    }
    terminate() {
      this.terminated = true;
    }
  };
  const metadata = { ...base, points: 2, hierarchy: { firstChunkSize: 44 } };
  const hierarchy = concat(record(0, 1, 1, 0, 12), record(1, 0, 1, 12, 12));
  let a;
  let b;
  try {
    a = await loadPotreeV2('https://dispose-a.audit/metadata.json', {
      decoderWorkers: 1,
      minNodePixelSize: 0,
      cacheEncodedNodes: true,
      fetch: fetcher(metadata, hierarchy, new Uint8Array(24)),
    });
    b = await loadPotreeV2('https://dispose-b.audit/metadata.json', {
      decoderWorkers: 1,
      minNodePixelSize: 0,
      fetch: fetcher(metadata, hierarchy, new Uint8Array(24)),
    });
    assert.equal(a.decoder, b.decoder);
    const setA = new PotreeV2PointCloudSet();
    const setB = new PotreeV2PointCloudSet();
    setA.add(a);
    setB.add(b);
    hold = true;
    setA.update(camera(), 300);
    await until(() => posted.length === 1);
    a.dispose();
    setB.update(camera(), 300);
    assert.equal(workers[0].terminated, undefined);
    await respond(posted.shift());
    await until(() => posted.length === 1);
    await respond(posted.shift());
    await until(() => b.activeLoads === 0);
    setB.update(camera(), 300);
    assert.equal(a.group.children.length, 0);
    assert.equal(a.decodedQueue.length, 0);
    assert.equal(setA.encodedCache.size, 0);
    assert.equal(b.group.children.length, 2);
    assert.equal(b.loading, false);
    b.dispose();
    assert.equal(workers[0].terminated, true);
  } finally {
    a?.dispose();
    b?.dispose();
    globalThis.Worker = originalWorker;
  }
});

test('R01: an accepted safe-integer range reaches impossible allocation without cancelling body', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(12));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    fetchRange(
      new URL('https://allocation.audit/octree.bin'),
      0n,
      BigInt(Number.MAX_SAFE_INTEGER),
      async () => new Response(body, { status: 206 }),
    ),
    RangeError,
  );
  assert.equal(cancelled, false);
  await body.cancel(); // Explicit cleanup by this observation test.
});

test('A17: density correction differs from the reference Potree uint8-quantized texture', () => {
  const offset = occupancyLevelOffset(3, [32, 32, 32], 0, 32 / 128);
  const textureByte = new Uint8Array([(Math.log2(3) / 2 - 1.5 + 10) * 10])[0];
  const referenceOffset = textureByte / 10 - 10;
  assert.ok(Math.abs(offset - referenceOffset) > 0.09);
  assert.ok(Math.abs(2 ** referenceOffset / 2 ** offset - 1) > 0.06);
});

test('V02: real HTTP rejects chunked overlong/short ranges and a truncated Content-Length body', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.headers.range, 'bytes=0-2');
    if (request.url === '/overlong') {
      response.writeHead(206);
      response.write(new Uint8Array(4));
      response.end();
    } else if (request.url === '/short') {
      response.writeHead(206);
      response.write(new Uint8Array(2));
      response.end();
    } else {
      response.writeHead(206, { 'Content-Length': '3' });
      response.flushHeaders();
      response.write(new Uint8Array(1));
      setImmediate(() => response.destroy());
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(
      fetchRange(new URL(`${baseUrl}/overlong`), 0n, 3n, fetch, AbortSignal.timeout(2000)),
      /longer than/,
    );
    await assert.rejects(
      fetchRange(new URL(`${baseUrl}/short`), 0n, 3n, fetch, AbortSignal.timeout(2000)),
      /short byte range/,
    );
    await assert.rejects(
      fetchRange(new URL(`${baseUrl}/truncated`), 0n, 3n, fetch, AbortSignal.timeout(2000)),
      TypeError,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
