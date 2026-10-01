// Renders one point cloud at a fixed view for the Playwright tests; they call `window.harness`.
import {
  loadPotreeV2, PotreeV2Clipping, PotreeV2Gradients, PotreeV2PointCloudSet, type PotreeV2Options,
  type PotreeV2PointCloud, type PotreeV2PointColorType,
} from '@geemil/potree-v2-three'
import { PerspectiveCamera, Plane, Scene, Vector3, WebGLRenderer } from 'three'

const SIZE = 300

const renderer = new WebGLRenderer({ preserveDrawingBuffer: true })
renderer.setSize(SIZE, SIZE, false)
document.body.append(renderer.domElement)
const shaderErrors: string[] = []
renderer.debug.onShaderError = (gl, _program, vertexShader, fragmentShader) => {
  shaderErrors.push(`${gl.getShaderInfoLog(vertexShader) ?? ''}${gl.getShaderInfoLog(fragmentShader) ?? ''}`)
}
const gl = renderer.getContext()
const scene = new Scene()
const camera = new PerspectiveCamera(60, 1, 0.01, 1000)
let cloud: PotreeV2PointCloud | undefined

export interface Capture {
  /** Pixels not left at the black clear color. */
  drawn: number
  /** Mean sRGB color of the drawn pixels. */
  mean: [number, number, number]
  /** SHA-256 of the RGBA pixels, to compare two images exactly. */
  digest: string
}

export interface ColorSettings {
  type: PotreeV2PointColorType
  solid?: string
  gradient?: keyof typeof PotreeV2Gradients
  intensityGamma?: number
}

const harness = {
  /** Load `url` in place of the current cloud and wait until the fixed view is loaded. */
  async load(url: string, options: Pick<PotreeV2Options, 'attributes' | 'pointColorType'> = {}) {
    if (cloud) {
      scene.remove(cloud.group)
      cloud.dispose()
    }
    cloud = await loadPotreeV2(url, { ...options, pointBudget: 10_000_000, minNodePixelSize: 10 })
    scene.add(cloud.group)
    const box = cloud.boundingBox
    const center = box.getCenter(new Vector3())
    const size = box.getSize(new Vector3()).length()
    camera.up.set(0, 0, 1)
    camera.position.copy(center).add(new Vector3(0, -size * 0.8, size * 0.3))
    camera.lookAt(center)
    const deadline = performance.now() + 60_000
    while (cloud.loadDiagnostics.state !== 'complete') {
      if (performance.now() > deadline) throw new Error('The view did not finish loading')
      cloud.update(camera, SIZE)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return {
      encoding: cloud.metadata.encoding,
      attributes: [...cloud.material.attributes],
      colorType: cloud.material.colorType,
      nodes: cloud.loadDiagnostics.requiredNodes,
    }
  },

  setColor({ type, solid, gradient, intensityGamma }: ColorSettings) {
    const material = current().material
    material.colorType = type
    if (solid !== undefined) material.color.set(solid)
    if (gradient !== undefined) material.gradient = PotreeV2Gradients[gradient]
    if (intensityGamma !== undefined) material.intensityGamma = intensityGamma
  },

  setClassVisible(code: number, visible: boolean) {
    current().material.classification.setVisible(code, visible)
  },

  setClassColor(code: number, color: string) {
    current().material.classification.setColor(code, color)
  },

  /** Drawn pixels by `#rrggbb` color; fails when the image has more than `limit` colors. */
  palette(limit = 64): Record<string, number> {
    const pixels = render()
    const counts: Record<string, number> = {}
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] === 0 && pixels[i + 1] === 0 && pixels[i + 2] === 0) continue
      const hex = `#${[pixels[i]!, pixels[i + 1]!, pixels[i + 2]!].map(v => v.toString(16).padStart(2, '0')).join('')}`
      counts[hex] = (counts[hex] ?? 0) + 1
      if (Object.keys(counts).length > limit) throw new Error(`The image has more than ${limit} colors`)
    }
    return counts
  },

  async capture(): Promise<Capture> {
    const pixels = render()
    let drawn = 0
    const sum = [0, 0, 0]
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] === 0 && pixels[i + 1] === 0 && pixels[i + 2] === 0) continue
      drawn++
      sum[0] += pixels[i]!
      sum[1] += pixels[i + 1]!
      sum[2] += pixels[i + 2]!
    }
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))
    return {
      drawn,
      mean: sum.map(value => Math.round(value / Math.max(drawn, 1))) as Capture['mean'],
      digest: Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join(''),
    }
  },

  /** The point drawn nearest `x`, `y` (0 to 1 across the view, from the top left), by default the centre. */
  async pick(x = 0.5, y = 0.5) {
    const hit = await current().pick(renderer, camera, x * SIZE, y * SIZE, { radius: 10 })
    return hit && { node: hit.node, index: hit.index, sourcePosition: hit.sourcePosition, attributes: hit.attributes }
  },

  /** Node geometries the picker still references after its picks; 0 unless one is in progress. */
  pickerGeometries(): number {
    const picker = (current() as unknown as { picker?: { proxies: { geometry: { attributes: object } }[] } }).picker
    return picker?.proxies.filter(proxy => 'position' in proxy.geometry.attributes).length ?? 0
  },

  /**
   * Draw two clouds of `url` side by side, with equal settings so that they share one shader
   * program, clipped by opposite planes. Returns, for each of several frames, the pixels that
   * differ from the two clouds drawn alone, and the pixels each cloud draws alone. With a
   * `pointBudget` of 1 each cloud draws only its root, so every frame starts with the node,
   * and the clip, that the cloud drew last in the frame before.
   */
  async sharedProgramClipping(url: string, pointBudget: number) {
    if (cloud) {
      scene.remove(cloud.group)
      cloud.dispose()
      cloud = undefined
    }
    const clouds = await Promise.all([0, 1].map(() => loadPotreeV2(url, { pointBudget, minNodePixelSize: 10 })))
    try {
      const size = clouds[0]!.boundingBox.getSize(new Vector3())
      clouds[1]!.group.position.x = size.x * 1.5
      const middle = size.z / 2
      // Each plane cuts through the cloud, so some nodes test it and others need no clip.
      const planes = [new Plane(new Vector3(0, 0, 1), -middle), new Plane(new Vector3(0, 0, -1), middle)]
      clouds.forEach((current, i) => {
        current.clipping = new PotreeV2Clipping()
        current.clipping.addPlane({ plane: planes[i]!, prune: false })
        scene.add(current.group)
      })
      const center = new Vector3(size.x * 1.25, size.y / 2, size.z / 2)
      const extent = size.clone().setX(size.x * 2.5).length()
      camera.up.set(0, 0, 1)
      camera.position.copy(center).add(new Vector3(0, -extent * 0.8, extent * 0.3))
      camera.lookAt(center)
      const deadline = performance.now() + 60_000
      while (clouds.some(current => current.loadDiagnostics.state !== 'complete')) {
        if (performance.now() > deadline) throw new Error('The view did not finish loading')
        for (const current of clouds) current.update(camera, SIZE)
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      const alone = clouds.map(current => {
        for (const other of clouds) other.group.visible = other === current
        return render()
      })
      for (const current of clouds) current.group.visible = true
      const differing: number[] = []
      for (let frame = 0; frame < 3; frame++) {
        const together = render()
        let count = 0
        for (let i = 0; i < together.length; i += 4) {
          const first = alone[0]!
          const expected = first[i] || first[i + 1] || first[i + 2] ? first : alone[1]!
          if ([0, 1, 2].some(c => together[i + c] !== expected[i + c])) count++
        }
        differing.push(count)
      }
      const drawn = alone.map(pixels => {
        let count = 0
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i] || pixels[i + 1] || pixels[i + 2]) count++
        return count
      })
      const [first, second] = clouds.map(current => (renderer.properties.get(current.material) as { currentProgram?: object }).currentProgram)
      return { differing, drawn, nodes: clouds.map(current => current.loadDiagnostics.requiredNodes), sharedProgram: first !== undefined && first === second }
    } finally {
      for (const current of clouds) {
        scene.remove(current.group)
        current.dispose()
      }
    }
  },

  /**
   * Draw two clouds of `url` in a set, a red one partly in front of a blue one, and pick a grid
   * of pixels through the set. Counts the picks whose cloud differs from the color drawn at
   * that pixel, and the front hits where the back cloud picked alone also has a point.
   */
  async pickAcrossClouds(url: string) {
    if (cloud) {
      scene.remove(cloud.group)
      cloud.dispose()
      cloud = undefined
    }
    const options = { pointBudget: 10_000_000, minNodePixelSize: 10, pointColorType: 'solid' } as const
    const [back, front] = await Promise.all([0, 1].map(() => loadPotreeV2(url, options)))
    const set = new PotreeV2PointCloudSet({ pointBudget: 10_000_000 })
    try {
      back!.material.color.set('#0000ff')
      front!.material.color.set('#ff0000')
      const size = back!.boundingBox.getSize(new Vector3())
      // Toward the camera and aside, so that it covers part of the back cloud.
      front!.group.position.set(size.x * 0.3, -size.y * 0.5, 0)
      for (const current of [back!, front!]) {
        set.add(current)
        scene.add(current.group)
      }
      const center = back!.boundingBox.getCenter(new Vector3())
      const extent = size.length()
      camera.up.set(0, 0, 1)
      camera.position.copy(center).add(new Vector3(0, -extent * 0.8, extent * 0.3))
      camera.lookAt(center)
      const deadline = performance.now() + 60_000
      while ([back!, front!].some(current => current.loadDiagnostics.state !== 'complete')) {
        if (performance.now() > deadline) throw new Error('The view did not finish loading')
        set.update(camera, SIZE)
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      const pixels = render()
      const counts = { front: 0, back: 0, mismatched: 0, occluded: 0 }
      for (let y = 5; y < SIZE; y += 10) {
        for (let x = 5; x < SIZE; x += 10) {
          const hit = await set.pick(renderer, camera, x + 0.5, y + 0.5)
          const at = ((SIZE - 1 - y) * SIZE + x) * 4
          const drawn = pixels[at] ? 'front' : pixels[at + 2] ? 'back' : null
          const picked = hit ? (hit.cloud === front ? 'front' : 'back') : null
          if (picked !== drawn) counts.mismatched++
          if (picked === 'back') counts.back++
          if (picked === 'front') {
            counts.front++
            if (await back!.pick(renderer, camera, x + 0.5, y + 0.5)) counts.occluded++
          }
        }
      }
      return counts
    } finally {
      for (const current of [back!, front!]) {
        scene.remove(current.group)
        current.dispose()
      }
    }
  },

  errors() {
    return { shaderErrors: [...shaderErrors], glError: gl.getError() }
  },
}

/** Draw the view and read back its RGBA pixels. */
function render(): Uint8Array<ArrayBuffer> {
  renderer.render(scene, camera)
  const pixels = new Uint8Array(SIZE * SIZE * 4)
  gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
  return pixels
}

function current(): PotreeV2PointCloud {
  if (!cloud) throw new Error('No point cloud is loaded')
  return cloud
}

export type Harness = typeof harness

declare global {
  interface Window { harness: Harness }
}
window.harness = harness
