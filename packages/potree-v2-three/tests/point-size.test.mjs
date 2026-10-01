import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Vector3 } from 'three';
import { pointOccupancy } from '../dist/occupancy.js';
import {
  densityLevelOffset, occupancyLevelOffset, PointSizeUniforms, VisibleNodesTexture,
} from '../dist/point-size.js';
import { PotreeV2PointMaterial } from '../dist/material.js';
import { NO_CLIP } from '../dist/clipping.js';

function node(name, box) {
  return { name, level: name.length - 1, box, children: [] };
}

function addChild(parent, index) {
  const box = parent.box.clone();
  const center = box.getCenter(new Vector3());
  if (index & 4) box.min.x = center.x; else box.max.x = center.x;
  if (index & 2) box.min.y = center.y; else box.max.y = center.y;
  if (index & 1) box.min.z = center.z; else box.max.z = center.z;
  const child = node(`${parent.name}${index}`, box);
  parent.children[index] = child;
  return child;
}

/** Evaluates the shader's displayedLevel() on the texture data, from `start` at a cloud-local position. */
function displayedLevel(texture, start, position) {
  const data = texture.texture.image.data;
  const floats = new Float32Array(data.buffer);
  const p = position.clone().sub(start.box.min);
  const extent = start.box.getSize(new Vector3());
  let index = texture.index(start);
  let level = start.level;
  for (let i = 0; i < 24; i++) {
    const mask = data[index * 4];
    extent.multiplyScalar(0.5);
    const octant = [p.x / extent.x, p.y / extent.y, p.z / extent.z].map(v => Math.min(1, Math.max(0, Math.floor(v))));
    const child = octant[0] * 4 + octant[1] * 2 + octant[2];
    if (!(mask & (1 << child))) return level + floats[index * 4 + 2];
    let skipped = 0;
    for (let b = 0; b < child; b++) if (mask & (1 << b)) skipped++;
    index = data[index * 4 + 1] + skipped;
    p.sub(new Vector3(...octant).multiply(extent));
    level++;
  }
  return level;
}

/** Level of the deepest displayed node containing `position`, found from the boxes. */
function deepestDisplayed(displayed, position) {
  let level = -1;
  for (const n of displayed) if (n.box.containsPoint(position)) level = Math.max(level, n.level);
  return level;
}

test('visible node texture finds the deepest displayed node at any position', () => {
  const root = node('r', new Box3(new Vector3(), new Vector3(8, 8, 8)));
  const r0 = addChild(root, 0);
  const r3 = addChild(root, 3);
  const r5 = addChild(root, 5);
  const r7 = addChild(root, 7);
  const r30 = addChild(r3, 0);
  const r36 = addChild(r3, 6);
  const r361 = addChild(r36, 1);
  const r71 = addChild(r7, 1);
  addChild(r5, 2);
  // r5 and r71 are loaded but not displayed, so their regions stay at the parent's level.
  const displayed = [r361, root, r3, r0, r36, r7, r30];
  void r71;

  const texture = new VisibleNodesTexture();
  texture.update(displayed, () => 0);
  const data = texture.texture.image.data;
  assert.equal(data[texture.index(root) * 4], (1 << 0) | (1 << 3) | (1 << 7));
  assert.equal(data[texture.index(root) * 4 + 1], texture.index(r0));
  assert.equal(data[texture.index(r3) * 4 + 1], texture.index(r30));
  assert.equal(data[texture.index(r36) * 4], 1 << 1);
  assert.equal(data[texture.index(r0) * 4], 0);

  for (let i = 0; i < 2000; i++) {
    // Keep off the octant boundaries, where containment is ambiguous.
    const position = new Vector3(Math.random(), Math.random(), Math.random()).multiplyScalar(7.998).addScalar(0.001);
    if ([position.x, position.y, position.z].some(v => Math.abs(v * 8 - Math.round(v * 8)) < 1e-6)) continue;
    const expected = deepestDisplayed(displayed, position);
    assert.equal(displayedLevel(texture, root, position), expected, `at ${position.toArray()}`);
    for (const start of displayed) {
      if (start.box.containsPoint(position)) assert.equal(displayedLevel(texture, start, position), expected);
    }
  }
  texture.dispose();
});

test('visible node texture grows past one row', () => {
  const root = node('r', new Box3(new Vector3(), new Vector3(1, 1, 1)));
  const nodes = [root];
  for (let i = 0; i < 8; i++) {
    const child = addChild(root, i);
    nodes.push(child);
    for (let j = 0; j < 8; j++) {
      const grandchild = addChild(child, j);
      nodes.push(grandchild);
      for (let k = 0; k < 8; k++) nodes.push(addChild(grandchild, k));
    }
  }
  const texture = new VisibleNodesTexture();
  texture.update(nodes, () => 0);
  assert.ok(texture.texture.image.width * texture.texture.image.height >= nodes.length);
  const last = nodes.at(-1);
  const p = last.box.getCenter(new Vector3());
  assert.equal(displayedLevel(texture, root, p), 3);
  texture.dispose();
});

test('the density offset applies where the walk stops', () => {
  const root = node('r', new Box3(new Vector3(), new Vector3(8, 8, 8)));
  const r0 = addChild(root, 0);
  const texture = new VisibleNodesTexture();
  texture.update([root, r0], n => (n === r0 ? 1.5 : 0.25));
  assert.equal(displayedLevel(texture, root, new Vector3(1, 1, 1)), 2.5);
  assert.equal(displayedLevel(texture, root, new Vector3(7, 7, 7)), 0.25);
  texture.dispose();
});

test('density level offset follows points per occupied cell, as Potree', () => {
  const box = new Box3(new Vector3(), new Vector3(32, 32, 32));
  // A plane with n × n points over the 32 × 32 cells it crosses.
  const plane = n => {
    const values = [];
    const step = 32 / n;
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) values.push((x + 0.5) * step, (y + 0.5) * step, 16);
    return new Float32Array(values);
  };
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
  // Potree's lodOffset, log2(occupancy) / 2 - 1.5, for a root spacing of the size / 128.
  const potree = occupancy => Math.log2(occupancy) / 2 - 1.5;
  near(densityLevelOffset(plane(32), box, 0, 32 / 128), potree(1));
  near(densityLevelOffset(plane(64), box, 0, 32 / 128), potree(4));
  // Fewer points than cells still read as one point per occupied cell.
  near(densityLevelOffset(plane(16), box, 0, 32 / 128), potree(1));
  // The offset is relative to the node's own level.
  near(densityLevelOffset(plane(64), box, 2, 4 * 32 / 128), potree(4));
  assert.equal(densityLevelOffset(new Float32Array(), box, 0, 1), 0);
  // The decoder counts the occupancy, and installation only converts it.
  assert.equal(pointOccupancy(plane(64), [32, 32, 32]), 4);
  assert.equal(pointOccupancy(new Float32Array(), [32, 32, 32]), 0);
  near(occupancyLevelOffset(4, [32, 32, 32], 0, 32 / 128), potree(4));
});

test('point size uniforms scale only pixel sizes by the pixel ratio', () => {
  const uniforms = new PointSizeUniforms();
  const nodes = new VisibleNodesTexture();
  assert.equal(uniforms.write({ type: 'fixed', size: 3, minSize: 2, maxSize: 50 }, 2, 600, 0.5, nodes.texture), true);
  assert.equal(uniforms.uniforms.size.value, 6);
  assert.equal(uniforms.uniforms.maxPointSize.value, 100);
  assert.equal(uniforms.write({ type: 'fixed', size: 3, minSize: 2, maxSize: 50 }, 2, 600, 0.5, nodes.texture), false);
  uniforms.write({ type: 'adaptive', size: 1.5, minSize: 2, maxSize: 50 }, 2, 600, 0.5, nodes.texture);
  assert.equal(uniforms.uniforms.size.value, 1.5);
  assert.equal(uniforms.uniforms.minPointSize.value, 4);
  nodes.dispose();
});

test('only the adaptive size type uploads uniforms for each node', () => {
  const root = node('r', new Box3(new Vector3(0, 0, 0), new Vector3(8, 8, 8)));
  const child = addChild(root, 1);
  const visibleNodes = new VisibleNodesTexture();
  visibleNodes.update([root, child], () => 0);
  const material = new PotreeV2PointMaterial({
    size: 1, colorType: 'rgb', elevationRange: [0, 8], intensityRange: [0, 65535],
  }, { spacing: 1, visibleNodes, attributes: ['position', 'rgb'], sourceOriginZ: 0 });
  const draw = target => {
    material.uniformsNeedUpdate = false;
    material.setNode(target, NO_CLIP, target.box.min);
    return material.uniformsNeedUpdate;
  };
  try {
    assert.equal(draw(root), false);
    assert.equal(draw(child), false);
    // The values are kept current, so the recompiled adaptive shader starts with them.
    assert.equal(material.uniforms.nodeIndex.value, 1);
    assert.equal(material.uniforms.nodeLevel.value, 1);

    material.sizeType = 'adaptive';
    assert.equal(draw(root), true);
    assert.equal(draw(root), false);
    assert.equal(draw(child), true);
  } finally {
    material.dispose();
    visibleNodes.dispose();
  }
});
