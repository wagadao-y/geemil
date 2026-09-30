// Writes the pump sample as PotreeConverter's uncompressed output ("encoding": "DEFAULT"),
// so the tests can compare it with the BROTLI original. PotreeConverter writes each node as
// its points interleaved in attribute order, position as int32 and rgb as uint16.
// The sample's classes are all 0, so a second copy assigns classes by x for the class tests.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '../public/pump')
const dataDir = join(here, 'data')

/**
 * Classes of `pump-classes`, one per band of equal width along x, from the smallest x.
 * 200 has no default color of its own.
 */
export const CLASS_BANDS = [2, 3, 6, 9, 200]

interface Attribute { name: string; size: number; min?: number[]; max?: number[] }

interface Metadata {
  encoding: string
  scale: [number, number, number]
  offset: [number, number, number]
  boundingBox: { min: [number, number, number]; max: [number, number, number] }
  attributes: Attribute[]
}

/** Bits of one of the three axes interleaved in a 48-bit Morton code. */
function deinterleave(bytes: Uint8Array, at: number, axis: number): number {
  let value = 0
  for (let bit = 0; bit < 16; bit++) {
    const m = bit * 3 + axis
    if (bytes[at + (m >> 3)]! & (1 << (m & 7))) value |= 1 << bit
  }
  return value
}

/** The sample's classes by band of x instead of 0, written into interleaved `points`. */
function assignClassBands(metadata: Metadata, points: Buffer, numPoints: number, pointSize: number): void {
  let classOffset = -1
  let positionOffset = -1
  let field = 0
  for (const attribute of metadata.attributes) {
    if (attribute.name === 'classification') classOffset = field
    if (attribute.name === 'position') positionOffset = field
    field += attribute.size
  }
  if (classOffset < 0 || positionOffset < 0) throw new Error('The sample needs position and classification')
  const min = metadata.boundingBox.min[0]
  const width = metadata.boundingBox.max[0] - min
  for (let i = 0; i < numPoints; i++) {
    const x = points.readInt32LE(i * pointSize + positionOffset) * metadata.scale[0] + metadata.offset[0]
    const band = Math.min(CLASS_BANDS.length - 1, Math.max(0, Math.floor((x - min) / width * CLASS_BANDS.length)))
    points.writeUInt8(CLASS_BANDS[band]!, i * pointSize + classOffset)
  }
}

function writeDatasets(): void {
  const metadata = JSON.parse(readFileSync(join(source, 'metadata.json'), 'utf8')) as Metadata
  if (metadata.encoding !== 'BROTLI') throw new Error(`Expected a BROTLI sample, got ${metadata.encoding}`)
  const hierarchy = new Uint8Array(readFileSync(join(source, 'hierarchy.bin')))
  const octree = readFileSync(join(source, 'octree.bin'))
  // BROTLI stores positions and colors as Morton codes, and one column per attribute.
  const storage = (a: Attribute) => a.name === 'position' ? 16 : a.name === 'rgb' ? 8 : a.size
  const pointSize = metadata.attributes.reduce((n, a) => n + a.size, 0)
  const view = new DataView(hierarchy.buffer, hierarchy.byteOffset, hierarchy.byteLength)
  const nodes: Buffer[] = []
  const classNodes: Buffer[] = []
  let written = 0
  // Every hierarchy chunk is a run of 22-byte records, so the whole file can be walked at once.
  for (let at = 0; at < hierarchy.byteLength; at += 22) {
    const type = view.getUint8(at)
    const numPoints = view.getUint32(at + 2, true)
    const offset = Number(view.getBigUint64(at + 6, true))
    const size = Number(view.getBigUint64(at + 14, true))
    // Proxies point into hierarchy.bin.
    if (type === 2 || size === 0) continue
    const columns = brotliDecompressSync(octree.subarray(offset, offset + size))
    const points = Buffer.alloc(numPoints * pointSize)
    let column = 0
    let field = 0
    for (const attribute of metadata.attributes) {
      const stored = storage(attribute)
      for (let i = 0; i < numPoints; i++) {
        const from = column + i * stored
        const to = i * pointSize + field
        if (attribute.name === 'position') {
          for (let axis = 0; axis < 3; axis++) {
            const high = deinterleave(columns, from, axis)
            const low = deinterleave(columns, from + 8, axis)
            points.writeInt32LE((high << 16) | low, to + axis * 4)
          }
        } else if (attribute.name === 'rgb') {
          for (let c = 0; c < 3; c++) points.writeUInt16LE(deinterleave(columns, from, c), to + c * 2)
        } else {
          columns.copy(points, to, from, from + stored)
        }
      }
      column += stored * numPoints
      field += attribute.size
    }
    // Uncompressed nodes keep their size, so both copies share the rewritten hierarchy.
    view.setBigUint64(at + 6, BigInt(written), true)
    view.setBigUint64(at + 14, BigInt(points.byteLength), true)
    nodes.push(points)
    const classes = Buffer.from(points)
    assignClassBands(metadata, classes, numPoints, pointSize)
    classNodes.push(classes)
    written += points.byteLength
  }
  const classAttributes = metadata.attributes.map(a => a.name === 'classification'
    ? { ...a, min: [Math.min(...CLASS_BANDS)], max: [Math.max(...CLASS_BANDS)] } : a)
  writeDataset('pump-default', { ...metadata, encoding: 'DEFAULT' }, hierarchy, nodes)
  writeDataset('pump-classes', { ...metadata, encoding: 'DEFAULT', attributes: classAttributes }, hierarchy, classNodes)
}

function writeDataset(name: string, metadata: Metadata, hierarchy: Uint8Array, nodes: Buffer[]): void {
  const dir = join(dataDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'hierarchy.bin'), hierarchy)
  writeFileSync(join(dir, 'octree.bin'), Buffer.concat(nodes))
  // Written last, so an interrupted run is redone.
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify(metadata, null, '\t'))
}

export default function globalSetup(): void {
  // Redone when the sample or this script changes.
  const inputs = [...['metadata.json', 'hierarchy.bin', 'octree.bin'].map(name => join(source, name)), fileURLToPath(import.meta.url)]
  const newestInput = Math.max(...inputs.map(path => statSync(path).mtimeMs))
  const upToDate = ['pump-default', 'pump-classes'].every(name => {
    const target = join(dataDir, name, 'metadata.json')
    return existsSync(target) && statSync(target).mtimeMs >= newestInput
  })
  if (!upToDate) writeDatasets()
}
