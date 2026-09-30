// Writes the pump sample as PotreeConverter's uncompressed output ("encoding": "DEFAULT"),
// so the tests can compare it with the BROTLI original. PotreeConverter writes each node as
// its points interleaved in attribute order, position as int32 and rgb as uint16.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '../public/pump')
export const defaultDataDir = join(here, 'data/pump-default')

interface Attribute { name: string; size: number }

/** Bits of one of the three axes interleaved in a 48-bit Morton code. */
function deinterleave(bytes: Uint8Array, at: number, axis: number): number {
  let value = 0
  for (let bit = 0; bit < 16; bit++) {
    const m = bit * 3 + axis
    if (bytes[at + (m >> 3)]! & (1 << (m & 7))) value |= 1 << bit
  }
  return value
}

function writeDefaultEncoding(): void {
  const metadata = JSON.parse(readFileSync(join(source, 'metadata.json'), 'utf8')) as {
    encoding: string; attributes: Attribute[]
  }
  if (metadata.encoding !== 'BROTLI') throw new Error(`Expected a BROTLI sample, got ${metadata.encoding}`)
  const hierarchy = new Uint8Array(readFileSync(join(source, 'hierarchy.bin')))
  const octree = readFileSync(join(source, 'octree.bin'))
  // BROTLI stores positions and colors as Morton codes, and one column per attribute.
  const storage = (a: Attribute) => a.name === 'position' ? 16 : a.name === 'rgb' ? 8 : a.size
  const pointSize = metadata.attributes.reduce((n, a) => n + a.size, 0)
  const view = new DataView(hierarchy.buffer, hierarchy.byteOffset, hierarchy.byteLength)
  const nodes: Buffer[] = []
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
    view.setBigUint64(at + 6, BigInt(written), true)
    view.setBigUint64(at + 14, BigInt(points.byteLength), true)
    nodes.push(points)
    written += points.byteLength
  }
  mkdirSync(defaultDataDir, { recursive: true })
  writeFileSync(join(defaultDataDir, 'hierarchy.bin'), hierarchy)
  writeFileSync(join(defaultDataDir, 'octree.bin'), Buffer.concat(nodes))
  // Written last, so an interrupted run is redone.
  writeFileSync(join(defaultDataDir, 'metadata.json'), JSON.stringify({ ...metadata, encoding: 'DEFAULT' }, null, '\t'))
}

export default function globalSetup(): void {
  const target = join(defaultDataDir, 'metadata.json')
  const upToDate = existsSync(target) &&
    statSync(target).mtimeMs >= Math.max(...['metadata.json', 'hierarchy.bin', 'octree.bin']
      .map(name => statSync(join(source, name)).mtimeMs))
  if (!upToDate) writeDefaultEncoding()
}
