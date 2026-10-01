import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Matrix4, PerspectiveCamera, Plane, Quaternion, Vector3 } from 'three';
import { loadPotreeV2, PotreeV2Clipping, PotreeV2PointCloudSet } from '../dist/index.js';
import { ClipUniforms, clipNode, NO_CLIP, snapshotClipping } from '../dist/clipping.js';

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for background node load');
}

function boxMatrix(center, size, rotation = new Quaternion()) {
  return new Matrix4().compose(new Vector3(...center), rotation, new Vector3(...size));
}

function box3(min, max) {
  return new Box3(new Vector3(...min), new Vector3(...max));
}

/** Evaluates the shader's potreeClipped() with the uploaded float32 uniform values. */
function clippedByUniforms({ uniforms, capacity }, [x, y, z]) {
  if (capacity.planes > 0) {
    const planes = uniforms.potreeClipPlanes.value;
    for (let i = 0; i < uniforms.potreeClipPlaneCount.value; i++) {
      if (planes[i * 4] * x + planes[i * 4 + 1] * y + planes[i * 4 + 2] * z + planes[i * 4 + 3] < 0)
        return true;
    }
  }
  if (capacity.boxes === 0) return false;
  const rows = uniforms.potreeClipBoxes.value;
  const keepCount = uniforms.potreeClipKeepCount.value;
  let kept = keepCount === 0;
  for (let i = 0; i < uniforms.potreeClipBoxCount.value; i++) {
    const q = [0, 1, 2].map((row) => {
      const at = (i * 3 + row) * 4;
      return rows[at] * x + rows[at + 1] * y + rows[at + 2] * z + rows[at + 3];
    });
    if (q.every((value) => Math.abs(value) <= 0.5)) {
      if (i >= keepCount) return true;
      kept = true;
    }
  }
  return !kept;
}

function snapshot(configure, group = new Matrix4()) {
  const clipping = new PotreeV2Clipping();
  configure(clipping);
  return snapshotClipping(clipping, group);
}

test('a node inside a hide box is pruned, outside it is unclipped and across it keeps the box', () => {
  const clip = snapshot((c) =>
    c.addBox({ matrix: boxMatrix([2, 2, 2], [4, 4, 4]), mode: 'hide-inside' }),
  );
  assert.equal(clipNode(clip.root, box3([0.5, 0.5, 0.5], [3.5, 3.5, 3.5]), clip.keepPrune), null);
  assert.equal(clipNode(clip.root, box3([5, 5, 5], [8, 8, 8]), clip.keepPrune), NO_CLIP);
  const crossing = clipNode(clip.root, box3([3, 3, 3], [6, 6, 6]), clip.keepPrune);
  assert.equal(crossing.hide.length, 1);
  assert.equal(crossing.keep, null);
  assert.equal(crossing.hidden, false);
  // Descendants test only the clips that still cross them.
  assert.equal(clipNode(crossing, box3([4.5, 4.5, 4.5], [6, 6, 6]), clip.keepPrune), NO_CLIP);
});

test('keep boxes form a union: inside any skips the test, outside all prunes', () => {
  const clip = snapshot((c) => {
    c.addBox({ matrix: boxMatrix([2, 2, 2], [4, 4, 4]), mode: 'keep-inside' });
    c.addBox({ matrix: boxMatrix([6, 2, 2], [4, 4, 4]), mode: 'keep-inside' });
  });
  assert.equal(
    clipNode(clip.root, box3([4.5, 0.5, 0.5], [7.5, 3.5, 3.5]), clip.keepPrune),
    NO_CLIP,
  );
  assert.equal(clipNode(clip.root, box3([0, 5, 0], [8, 8, 8]), clip.keepPrune), null);
  const crossing = clipNode(clip.root, box3([3, 0, 0], [5, 4, 4]), clip.keepPrune);
  assert.equal(crossing.keep.length, 2);
});

test('clips that do not prune hide a node without removing it from the traversal', () => {
  const hide = snapshot((c) =>
    c.addBox({ matrix: boxMatrix([2, 2, 2], [4, 4, 4]), mode: 'hide-inside', prune: false }),
  );
  const hidden = clipNode(hide.root, box3([1, 1, 1], [3, 3, 3]), hide.keepPrune);
  assert.equal(hidden.hidden, true);
  assert.equal(clipNode(hidden, box3([1, 1, 1], [2, 2, 2]), hide.keepPrune), hidden);
  // Outside every keep box prunes only when all keep boxes prune.
  const keep = snapshot((c) => {
    c.addBox({ matrix: boxMatrix([2, 2, 2], [4, 4, 4]), mode: 'keep-inside' });
    c.addBox({ matrix: boxMatrix([20, 2, 2], [4, 4, 4]), mode: 'keep-inside', prune: false });
  });
  assert.equal(clipNode(keep.root, box3([8, 8, 8], [9, 9, 9]), keep.keepPrune).hidden, true);
  // A pruning clip wins over one that only hides.
  const both = snapshot((c) => {
    c.addBox({ matrix: boxMatrix([2, 2, 2], [4, 4, 4]), mode: 'hide-inside', prune: false });
    c.addPlane({ plane: new Plane(new Vector3(1, 0, 0), -5) });
  });
  assert.equal(clipNode(both.root, box3([1, 1, 1], [3, 3, 3]), both.keepPrune), null);
});

test('planes keep the side their normal points to', () => {
  const clip = snapshot((c) => c.addPlane({ plane: new Plane(new Vector3(0, 0, 1), -4) }));
  assert.equal(clipNode(clip.root, box3([0, 0, 4], [8, 8, 8]), clip.keepPrune), NO_CLIP);
  assert.equal(clipNode(clip.root, box3([0, 0, 0], [8, 8, 3.9]), clip.keepPrune), null);
  assert.equal(clipNode(clip.root, box3([0, 0, 0], [8, 8, 8]), clip.keepPrune).planes.length, 1);
});

test('disabled clips are ignored and invalid clips are rejected', () => {
  assert.equal(
    snapshot((c) =>
      c.addBox({ matrix: boxMatrix([0, 0, 0], [1, 1, 1]), mode: 'hide-inside', enabled: false }),
    ),
    undefined,
  );
  const clipping = new PotreeV2Clipping();
  assert.throws(
    () => clipping.addBox({ matrix: boxMatrix([0, 0, 0], [1, 0, 1]), mode: 'keep-inside' }),
    /invertible/,
  );
  assert.throws(() => clipping.addPlane({ plane: new Plane(new Vector3(0, 0, 0), 1) }), /normal/);
  const box = clipping.addBox({ matrix: boxMatrix([0, 0, 0], [1, 1, 1]), mode: 'keep-inside' });
  box.matrix.makeScale(0, 1, 1);
  assert.throws(() => snapshotClipping(clipping, new Matrix4()), /invertible/);
  assert.equal(clipping.remove(box), true);
  assert.equal(clipping.remove(box), false);
});

test('shader uniforms apply keep, hide and plane clips in node-local float32 coordinates', () => {
  // Far from the origin, as a node of a large cloud would be.
  const far = 1_000_000;
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 6);
  const clip = snapshot((c) => {
    c.addBox({
      matrix: boxMatrix([far + 4, far + 4, far + 4], [6, 6, 6], rotation),
      mode: 'keep-inside',
    });
    c.addBox({ matrix: boxMatrix([far + 4, far + 4, far + 4], [1, 1, 1]), mode: 'hide-inside' });
    c.addPlane({ plane: new Plane(new Vector3(0, 0, 1), -(far + 2)) });
  });
  const node = clipNode(
    clip.root,
    box3([far, far, far], [far + 8, far + 8, far + 8]),
    clip.keepPrune,
  );
  assert.equal(node.keep.length, 1);
  assert.equal(node.hide.length, 1);
  assert.equal(node.planes.length, 1);
  const uniforms = new ClipUniforms();
  uniforms.resize({ boxes: 16, planes: 8 });
  const origin = new Vector3(far, far, far);
  assert.equal(uniforms.write(node, origin), true);
  assert.equal(uniforms.write(node, origin), false);
  assert.equal(uniforms.uniforms.potreeClipKeepCount.value, 1);
  assert.equal(uniforms.uniforms.potreeClipBoxCount.value, 2);
  // Node-local points: kept, inside the hide box, below the plane, outside the keep box.
  assert.equal(clippedByUniforms(uniforms, [4, 4, 3]), false);
  assert.equal(clippedByUniforms(uniforms, [4.4, 4.4, 4.4]), true);
  assert.equal(clippedByUniforms(uniforms, [4, 4, 1.99]), true);
  assert.equal(clippedByUniforms(uniforms, [4, 4, 2.01]), false);
  assert.equal(clippedByUniforms(uniforms, [4, 4, 7.1]), true);
  assert.equal(clippedByUniforms(uniforms, [4, 4, 6.9]), false);
});

test('clip arrays are uploaded only for nodes that test clips, while counts always are', () => {
  const clip = snapshot((c) => {
    c.addBox({ matrix: boxMatrix([4, 4, 4], [2, 2, 2]), mode: 'hide-inside' });
    c.addPlane({ plane: new Plane(new Vector3(0, 0, 1), -2) });
  });
  const crossing = clipNode(clip.root, box3([0, 0, 0], [8, 8, 8]), clip.keepPrune);
  const planeOnly = clipNode(clip.root, box3([0, 0, 0], [2, 2, 8]), clip.keepPrune);
  assert.equal(planeOnly.hide.length, 0);
  assert.equal(planeOnly.planes.length, 1);
  const uniforms = new ClipUniforms();
  uniforms.resize({ boxes: 16, planes: 8 });
  const {
    potreeClipBoxes: boxes,
    potreeClipPlanes: planes,
    potreeClipBoxCount,
    potreeClipPlaneCount,
  } = uniforms.uniforms;
  const origin = new Vector3();
  uniforms.write(crossing, origin);
  assert.deepEqual([boxes.needsUpdate, planes.needsUpdate], [true, true]);
  // Without clips the shader reads no array element, so only the zero counts are uploaded.
  uniforms.write(NO_CLIP, origin);
  assert.deepEqual([boxes.needsUpdate, planes.needsUpdate], [false, false]);
  assert.deepEqual([potreeClipBoxCount.value, potreeClipPlaneCount.value], [0, 0]);
  assert.equal(potreeClipBoxCount.needsUpdate, undefined);
  uniforms.write(planeOnly, origin);
  assert.deepEqual([boxes.needsUpdate, planes.needsUpdate], [false, true]);
  assert.deepEqual([potreeClipBoxCount.value, potreeClipPlaneCount.value], [0, 1]);
});

const base = {
  version: '2.0',
  encoding: 'DEFAULT',
  points: 4,
  spacing: 1,
  scale: [0.5, 0.5, 0.5],
  offset: [100, 200, 300],
  boundingBox: { min: [100, 200, 300], max: [108, 208, 308] },
  hierarchy: { firstChunkSize: 88 },
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
  for (const a of arrays) {
    data.set(a, at);
    at += a.byteLength;
  }
  return data;
}

function uncompressedPoint(x, y, z) {
  const data = new ArrayBuffer(18);
  const view = new DataView(data);
  [x, y, z].forEach((v, i) => view.setInt32(i * 4, v, true));
  return new Uint8Array(data);
}

/**
 * A root spanning 0..8 in the cloud's local space with children r0 (z 0..4), r1 (z 4..8)
 * and r2 (y 4..8, z 0..4), one point each.
 */
async function loadFixture(options = {}) {
  const hierarchy = concat(
    record(1, 7, 1, 0, 18),
    record(0, 0, 1, 18, 18),
    record(0, 0, 1, 36, 18),
    record(0, 0, 1, 54, 18),
  );
  // Integer positions are scaled by 0.5 and offset by (100, 200, 300).
  const octree = concat(
    uncompressedPoint(8, 8, 8),
    uncompressedPoint(2, 2, 2),
    uncompressedPoint(2, 2, 12),
    uncompressedPoint(2, 12, 2),
  );
  const fetcher = async (url, init = {}) => {
    const name = new URL(url).pathname.split('/').at(-1);
    if (name === 'metadata.json') return new Response(JSON.stringify(base));
    const file = name === 'hierarchy.bin' ? hierarchy : octree;
    const match = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    return new Response(file.slice(Number(match[1]), Number(match[2]) + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${match[1]}-${match[2]}/${file.byteLength}` },
    });
  };
  const cloud = await loadPotreeV2('https://example.test/cloud/metadata.json', {
    fetch: fetcher,
    minNodePixelSize: 1,
    ...options,
  });
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(4, 4, 20);
  camera.lookAt(4, 4, 4);
  return { cloud, camera };
}

/** Display `cloud` through a set of its own, as an application with one cloud does. */
function display(cloud) {
  const set = new PotreeV2PointCloudSet();
  set.add(cloud);
  return set;
}

function shownNodes(cloud) {
  return cloud.group.children
    .filter((child) => child.isPoints && child.visible)
    .map((child) => child.name)
    .sort();
}

async function settle(set, camera) {
  await waitFor(() => {
    set.update(camera, 600);
    return set.clouds.every((cloud) => cloud.settled);
  });
}

test('a pruning hide box keeps its nodes out of the selection and the network', async () => {
  const clipping = new PotreeV2Clipping();
  const box = clipping.addBox({
    matrix: boxMatrix([2, 2, 2], [4.2, 4.2, 4.2]),
    mode: 'hide-inside',
  });
  const { cloud, camera } = await loadFixture({ clipping });
  const set = display(cloud);
  try {
    await settle(set, camera);
    assert.deepEqual(shownNodes(cloud), ['r', 'r1', 'r2']);
    assert.deepEqual(cloud.fetchStats, { rangeRequests: 2, fetchedNodes: 3 });
    assert.equal(set.update(camera, 600), false);

    // Not pruning: the node loads and stays budgeted, but is not drawn.
    box.prune = false;
    await settle(set, camera);
    assert.equal(cloud.fetchStats.fetchedNodes, 4);
    assert.deepEqual(shownNodes(cloud), ['r', 'r1', 'r2']);
    assert.equal(cloud.group.children.filter((child) => child.isPoints).length, 4);

    // Disabling the box is noticed without any notification from the application.
    box.enabled = false;
    assert.equal(set.update(camera, 600), true);
    assert.deepEqual(shownNodes(cloud), ['r', 'r0', 'r1', 'r2']);
  } finally {
    cloud.dispose();
  }
});

test('keep boxes and planes select only nodes that can show points, and compile the clip test', async () => {
  const clipping = new PotreeV2Clipping();
  const { cloud, camera } = await loadFixture({ clipping });
  const set = display(cloud);
  try {
    assert.equal(cloud.material.defines.POTREE_CLIP_BOXES, 0);
    const keep = clipping.addBox({ matrix: boxMatrix([2, 2, 6], [2, 2, 2]), mode: 'keep-inside' });
    await settle(set, camera);
    assert.deepEqual(shownNodes(cloud), ['r', 'r1']);
    assert.equal(cloud.material.defines.POTREE_CLIP_BOXES, 16);
    assert.equal(cloud.material.defines.POTREE_CLIP_PLANES, 8);
    assert.match(cloud.material.vertexShader, /potreeClipped\(position\)/);

    // The root crosses the keep box, so its points are tested in the shader.
    const root = cloud.group.children.find((child) => child.name === 'r');
    root.onBeforeRender();
    const { clip } = cloud.material;
    assert.equal(clip.uniforms.potreeClipKeepCount.value, 1);
    assert.equal(clippedByUniforms(clip, [2, 2, 6]), false);
    assert.equal(clippedByUniforms(clip, [4, 4, 4]), true);
    // r1 starts at z = 4, so the same box is converted into its node-local coordinates.
    const r1 = cloud.group.children.find((child) => child.name === 'r1');
    r1.onBeforeRender();
    assert.equal(clip.uniforms.potreeClipBoxCount.value, 1);
    assert.equal(clippedByUniforms(clip, [2, 2, 2]), false);
    assert.equal(clippedByUniforms(clip, [2, 2, 0.5]), true);

    clipping.remove(keep);
    // Keeps y <= 3.9, so r2 (y 4..8) is pruned.
    clipping.addPlane({ plane: new Plane(new Vector3(0, -1, 0), 3.9) });
    await settle(set, camera);
    assert.deepEqual(shownNodes(cloud), ['r', 'r0', 'r1']);
    root.onBeforeRender();
    assert.equal(clip.uniforms.potreeClipPlaneCount.value, 1);
    assert.equal(clippedByUniforms(clip, [4, 3, 4]), false);
    assert.equal(clippedByUniforms(clip, [4, 5, 4]), true);

    // The clip applies in world space: moving the cloud moves its nodes relative to the plane.
    cloud.group.position.y = -4;
    await settle(set, camera);
    assert.deepEqual(shownNodes(cloud), ['r', 'r0', 'r1', 'r2']);
  } finally {
    cloud.dispose();
  }
});

test('clouds sharing a clipping pick up its changes and grow the shader capacity when needed', async () => {
  const clipping = new PotreeV2Clipping();
  const a = await loadFixture({ clipping });
  const b = await loadFixture({ clipping });
  try {
    // Seventeen hide boxes crossing the root exceed the initial capacity of 16.
    for (let i = 0; i < 17; i++) {
      clipping.addBox({
        matrix: boxMatrix([7.9, 7.9, 0.1 + i * 0.1], [0.05, 0.05, 0.05]),
        mode: 'hide-inside',
      });
    }
    const set = display(a.cloud);
    set.add(b.cloud);
    await settle(set, a.camera);
    for (const { cloud } of [a, b]) {
      assert.equal(cloud.material.defines.POTREE_CLIP_BOXES, 32);
      assert.equal(cloud.material.clip.uniforms.potreeClipBoxes.value.length, 32 * 12);
    }
    clipping.clear();
    // No node changes visibility, but the shader no longer clips, so the scene must be drawn again.
    assert.equal(set.update(a.camera, 600), true);
    await settle(set, a.camera);
    // The capacity never shrinks, so clearing clips does not recompile.
    assert.equal(a.cloud.material.defines.POTREE_CLIP_BOXES, 32);
  } finally {
    a.cloud.dispose();
    b.cloud.dispose();
  }
});

test('a traversal that throws leaves no candidates for the next one and is repeated', async () => {
  // Keeps every point, so the first cloud pushes its root before the second one throws.
  const kept = new PotreeV2Clipping();
  kept.addPlane({ plane: new Plane(new Vector3(0, 0, 1), 1000) });
  const broken = new PotreeV2Clipping();
  const box = broken.addBox({ matrix: boxMatrix([50, 50, 50], [1, 1, 1]), mode: 'hide-inside' });
  const a = await loadFixture({ clipping: kept });
  const b = await loadFixture({ clipping: broken });
  // Exactly the four one-point nodes of each cloud fit.
  const set = new PotreeV2PointCloudSet({ pointBudget: 8 });
  set.add(a.cloud);
  set.add(b.cloud);
  const required = () =>
    a.cloud.loadDiagnostics.requiredNodes + b.cloud.loadDiagnostics.requiredNodes;
  try {
    await waitFor(() => {
      set.update(a.camera, 600);
      return a.cloud.settled && b.cloud.settled;
    });
    assert.equal(required(), 8);

    box.matrix.makeScale(0, 0, 0);
    assert.throws(() => set.update(a.camera, 600), /invertible/);
    // The view is unchanged, but the failed traversal is not taken as settled.
    assert.throws(() => set.update(a.camera, 600), /invertible/);

    // Candidates left by the throws would take part of the budget.
    box.matrix.copy(boxMatrix([50, 50, 50], [1, 1, 1]));
    set.update(a.camera, 600);
    assert.equal(required(), 8);
    assert.deepEqual(shownNodes(a.cloud), ['r', 'r0', 'r1', 'r2']);
    assert.deepEqual(shownNodes(b.cloud), ['r', 'r0', 'r1', 'r2']);
  } finally {
    a.cloud.dispose();
    b.cloud.dispose();
  }
});
