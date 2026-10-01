// PotreeConverter's own output, rather than data written by these tests: 2,000 points of the
// pump sample converted without --encoding (DEFAULT) and with --encoding BROTLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRoot, parseHierarchyChunk, validateMetadata } from '../dist/format.js';
import { decodeNode } from '../dist/node-geometry.js';
import { loadPotreeV2 } from '../dist/index.js';

const data = new URL('./data/pump-2000pts/', import.meta.url);
/** The full pump sample the 2,000 points were taken from. */
const pumpDir = new URL('../../../apps/playground/public/pump/', import.meta.url);
const ATTRIBUTES = ['position', 'rgb', 'intensity', 'classification', 'point source id'];

function readDataset(dir) {
  const metadata = validateMetadata(
    JSON.parse(readFileSync(new URL('metadata.json', dir), 'utf8')),
  );
  const hierarchy = readFileSync(new URL('hierarchy.bin', dir));
  const octree = readFileSync(new URL('octree.bin', dir));
  return { metadata, hierarchy, octree };
}

const slice = (buffer, offset, size) =>
  buffer.buffer.slice(
    buffer.byteOffset + Number(offset),
    buffer.byteOffset + Number(offset + size),
  );

/** Every node with points, loading each hierarchy chunk as the traversal reaches its proxy. */
function nodesWithPoints({ metadata, hierarchy }) {
  const nodes = [];
  const stack = [createRoot(metadata)];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.type === 2 && !node.hierarchyLoaded) {
      parseHierarchyChunk(node, slice(hierarchy, node.hierarchyByteOffset, node.hierarchyByteSize));
    }
    if (node.numPoints > 0) nodes.push(node);
    for (const child of node.children) if (child) stack.push(child);
  }
  return nodes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Decoded attributes of every node by name, positions in the metadata coordinate system. */
async function decodeAll(dataset, attributes = ATTRIBUTES) {
  const decoded = new Map();
  for (const node of nodesWithPoints(dataset)) {
    const geometry = await decodeNode(
      slice(dataset.octree, node.byteOffset, node.byteSize),
      node,
      dataset.metadata,
      attributes,
    );
    const position = geometry.getAttribute('position').array;
    const source = Array.from(
      position,
      (value, i) =>
        value + node.box.min.getComponent(i % 3) + dataset.metadata.boundingBox.min[i % 3],
    );
    const values = Object.fromEntries(
      Object.entries(geometry.attributes).map(([name, attribute]) => [
        name,
        Array.from(attribute.array),
      ]),
    );
    decoded.set(node.name, { numPoints: node.numPoints, source, values });
    geometry.dispose();
  }
  return decoded;
}

const brotli = readDataset(new URL('brotli/', data));
const uncompressed = readDataset(new URL('default/', data));

test('PotreeConverter writes DEFAULT without --encoding, and both outputs describe the same cloud', () => {
  assert.equal(uncompressed.metadata.encoding, 'DEFAULT');
  assert.equal(brotli.metadata.encoding, 'BROTLI');
  assert.deepEqual({ ...uncompressed.metadata, encoding: 'BROTLI' }, brotli.metadata);
  const pointSize = uncompressed.metadata.attributes.reduce((n, a) => n + a.size, 0);
  // Uncompressed nodes are exactly their points, back to back.
  assert.equal(uncompressed.octree.byteLength, uncompressed.metadata.points * pointSize);
});

/** Each point of a node as one row of all its decoded values, sorted, so point order does not matter. */
function rows({ numPoints, values }) {
  const columns = Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1));
  return Array.from({ length: numPoints }, (_, i) =>
    columns
      .map(([, column]) => {
        const size = column.length / numPoints;
        return column.slice(i * size, (i + 1) * size).join(' ');
      })
      .join(' | '),
  ).sort();
}

test('DEFAULT and BROTLI outputs decode to the same nodes and points', async () => {
  const a = await decodeAll(uncompressed);
  const b = await decodeAll(brotli);
  assert.deepEqual([...a.keys()], [...b.keys()]);
  assert.equal(
    [...a.values()].reduce((n, node) => n + node.numPoints, 0),
    2000,
  );
  // BROTLI sorts each node's points by Morton code before compressing them (Writer.cpp).
  for (const [name, node] of a) assert.deepEqual(rows(node), rows(b.get(name)), name);
});

test('every decoded point is a point of the full pump sample', async () => {
  // Both clouds use millimetre steps. PotreeConverter truncates (x - offset) / scale to int32,
  // so a coordinate drops by 1 mm where the division falls just short. Each cloud was converted
  // from the source separately, so they differ by up to 1 mm on each axis.
  const millimetres = (source, i) =>
    source.slice(i * 3, i * 3 + 3).map((v) => Math.round(v * 1000));
  const value = (node, i) =>
    [...node.values.color.slice(i * 4, i * 4 + 3), node.values.intensity[i]].join(',');
  const pumpPoints = new Map();
  for (const node of (
    await decodeAll(readDataset(pumpDir), ['position', 'rgb', 'intensity'])
  ).values()) {
    for (let i = 0; i < node.numPoints; i++) {
      const key = millimetres(node.source, i).join(',');
      pumpPoints.set(key, [...(pumpPoints.get(key) ?? []), value(node, i)]);
    }
  }
  let checked = 0;
  let exact = 0;
  for (const [name, node] of await decodeAll(uncompressed)) {
    for (let i = 0; i < node.numPoints; i++) {
      const [x, y, z] = millimetres(node.source, i);
      const shifts = [];
      for (const dx of [-1, 0, 1])
        for (const dy of [-1, 0, 1])
          for (const dz of [-1, 0, 1]) {
            if (pumpPoints.get(`${x + dx},${y + dy},${z + dz}`)?.includes(value(node, i))) {
              shifts.push(Math.abs(dx) + Math.abs(dy) + Math.abs(dz));
            }
          }
      assert.ok(
        shifts.length > 0,
        `${name} point ${i} at ${[x, y, z]} with ${value(node, i)} is not in the pump sample`,
      );
      if (shifts.includes(0)) exact++;
      checked++;
    }
  }
  assert.equal(checked, 2000);
  // Most points are not shifted on every axis; a systematic offset would show here.
  assert.ok(exact > 0, 'no point matched without a shift');
});

test('the DEFAULT output loads through the HTTP loader', async () => {
  const files = {
    'metadata.json': JSON.stringify(uncompressed.metadata),
    'hierarchy.bin': uncompressed.hierarchy,
    'octree.bin': uncompressed.octree,
  };
  const fetcher = async (url, init = {}) => {
    const file = files[new URL(url).pathname.split('/').at(-1)];
    if (typeof file === 'string') return new Response(file);
    const [, first, last] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    return new Response(file.subarray(Number(first), Number(last) + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${first}-${last}/${file.byteLength}` },
    });
  };
  const cloud = await loadPotreeV2('https://example.test/pump-2000pts/metadata.json', {
    fetch: fetcher,
  });
  try {
    const root = cloud.group.children.find((child) => child.name === 'r');
    assert.equal(root.geometry.getAttribute('position').count, cloud.root.numPoints);
    assert.ok(cloud.root.numPoints > 0);
  } finally {
    cloud.dispose();
  }
});
