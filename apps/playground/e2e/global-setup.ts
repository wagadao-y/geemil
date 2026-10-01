// Copies the 2000-point pump sample's PotreeConverter outputs, BROTLI and uncompressed
// ("encoding": "DEFAULT"), so the tests can compare them. The sample's classes are all 0,
// so a third copy of the uncompressed output assigns classes by x for the class tests.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '../../../packages/potree-v2-three/tests/data/pump-2000pts');
const dataDir = join(here, 'data');

/**
 * Classes of `pump-classes`, one per band of equal width along x, from the smallest x.
 * 200 has no default color of its own.
 */
export const CLASS_BANDS = [2, 3, 6, 9, 200];

const DATA_FILES = ['metadata.json', 'hierarchy.bin', 'octree.bin'];

interface Attribute {
  name: string;
  size: number;
  min?: number[];
  max?: number[];
}

interface Metadata {
  encoding: string;
  scale: [number, number, number];
  offset: [number, number, number];
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  attributes: Attribute[];
}

/** The sample's classes by band of x instead of 0, written into interleaved `points`. */
function assignClassBands(
  metadata: Metadata,
  points: Buffer,
  numPoints: number,
  pointSize: number,
): void {
  let classOffset = -1;
  let positionOffset = -1;
  let field = 0;
  for (const attribute of metadata.attributes) {
    if (attribute.name === 'classification') classOffset = field;
    if (attribute.name === 'position') positionOffset = field;
    field += attribute.size;
  }
  if (classOffset < 0 || positionOffset < 0)
    throw new Error('The sample needs position and classification');
  const min = metadata.boundingBox.min[0];
  const width = metadata.boundingBox.max[0] - min;
  for (let i = 0; i < numPoints; i++) {
    const x =
      points.readInt32LE(i * pointSize + positionOffset) * metadata.scale[0] + metadata.offset[0];
    const band = Math.min(
      CLASS_BANDS.length - 1,
      Math.max(0, Math.floor(((x - min) / width) * CLASS_BANDS.length)),
    );
    points.writeUInt8(CLASS_BANDS[band]!, i * pointSize + classOffset);
  }
}

function writeDatasets(): void {
  for (const encoding of ['brotli', 'default']) {
    const dir = join(dataDir, `pump-${encoding}`);
    mkdirSync(dir, { recursive: true });
    // metadata.json last, so an interrupted run is redone.
    for (const name of [...DATA_FILES].reverse())
      copyFileSync(join(source, encoding, name), join(dir, name));
  }
  const uncompressed = join(source, 'default');
  const metadata = JSON.parse(
    readFileSync(join(uncompressed, 'metadata.json'), 'utf8'),
  ) as Metadata;
  if (metadata.encoding !== 'DEFAULT')
    throw new Error(`Expected an uncompressed sample, got ${metadata.encoding}`);
  const hierarchy = readFileSync(join(uncompressed, 'hierarchy.bin'));
  // Uncompressed nodes are their points interleaved in attribute order, one after another.
  const points = readFileSync(join(uncompressed, 'octree.bin'));
  const pointSize = metadata.attributes.reduce((n, a) => n + a.size, 0);
  assignClassBands(metadata, points, points.byteLength / pointSize, pointSize);
  const classAttributes = metadata.attributes.map((a) =>
    a.name === 'classification'
      ? { ...a, min: [Math.min(...CLASS_BANDS)], max: [Math.max(...CLASS_BANDS)] }
      : a,
  );
  writeDataset('pump-classes', { ...metadata, attributes: classAttributes }, hierarchy, [points]);
  writeFlatSiblingDataset();
}

/**
 * Three points at z = 2. The red r0 and blue r4 points straddle x = 4 closely enough
 * that their sprites overlap from above. Their sibling boxes also have equal view depth.
 * Keep a non-zero bounding-box height, as a valid octree requires it even for flat points.
 */
function writeFlatSiblingDataset(): void {
  const metadata = {
    version: '2.0',
    name: 'Flat sibling boundary',
    encoding: 'DEFAULT',
    points: 3,
    spacing: 1,
    scale: [0.01, 0.01, 0.01] as [number, number, number],
    offset: [0, 0, 0] as [number, number, number],
    boundingBox: {
      min: [0, 0, 0] as [number, number, number],
      max: [8, 8, 8] as [number, number, number],
    },
    hierarchy: { firstChunkSize: 66 },
    attributes: [
      { name: 'position', type: 'int32', size: 12, numElements: 3, elementSize: 4 },
      {
        name: 'rgb',
        type: 'uint16',
        size: 6,
        numElements: 3,
        elementSize: 2,
        max: [255, 255, 255],
      },
    ],
  };
  const hierarchy = Buffer.alloc(3 * 22);
  // File order r, r0, r4: one child batch arrives together, and both children are installed
  // in one frame. This creates r4 before r0, the reverse of their selection order.
  const points = [
    [700, 700, 200, 0, 255, 0], // Root point, away from the sibling overlap.
    [399, 200, 200, 255, 0, 0], // r0: (3.99, 2, 2), red.
    [401, 200, 200, 0, 0, 255], // r4: (4.01, 2, 2), blue.
  ];
  const nodes = points.map((point, i) => {
    const at = i * 22;
    hierarchy.writeUInt8(i === 0 ? 0 : 1, at);
    hierarchy.writeUInt8(i === 0 ? (1 << 0) | (1 << 4) : 0, at + 1);
    hierarchy.writeUInt32LE(1, at + 2);
    hierarchy.writeBigUInt64LE(BigInt(i * 18), at + 6);
    hierarchy.writeBigUInt64LE(18n, at + 14);
    const bytes = Buffer.alloc(18);
    point.forEach((value, component) => {
      if (component < 3) bytes.writeInt32LE(value, component * 4);
      else bytes.writeUInt16LE(value, 12 + (component - 3) * 2);
    });
    return bytes;
  });
  writeDataset('flat-siblings', metadata, hierarchy, nodes);
}

function writeDataset(
  name: string,
  metadata: Metadata,
  hierarchy: Uint8Array,
  nodes: Buffer[],
): void {
  const dir = join(dataDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hierarchy.bin'), hierarchy);
  writeFileSync(join(dir, 'octree.bin'), Buffer.concat(nodes));
  // Written last, so an interrupted run is redone.
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify(metadata, null, '\t'));
}

export default function globalSetup(): void {
  // Redone when the sample or this script changes.
  const inputs = [
    ...['brotli', 'default'].flatMap((encoding) =>
      DATA_FILES.map((name) => join(source, encoding, name)),
    ),
    fileURLToPath(import.meta.url),
  ];
  const newestInput = Math.max(...inputs.map((path) => statSync(path).mtimeMs));
  const upToDate = ['pump-brotli', 'pump-default', 'pump-classes', 'flat-siblings'].every(
    (name) => {
      const target = join(dataDir, name, 'metadata.json');
      return existsSync(target) && statSync(target).mtimeMs >= newestInput;
    },
  );
  if (!upToDate) writeDatasets();
}
