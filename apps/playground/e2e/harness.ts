// Renders one point cloud at a fixed view for the Playwright tests; they call `window.harness`.
import {
  loadPotreeV2, PotreeV2Gradients, type PotreeV2Options, type PotreeV2PointCloud, type PotreeV2PointColorType,
} from '@geemil/potree-v2-three'
import { PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three'

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
    const box = cloud.root.box
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

  async capture(): Promise<Capture> {
    renderer.render(scene, camera)
    const pixels = new Uint8Array(SIZE * SIZE * 4)
    gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
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

  /** The point drawn nearest the view centre. */
  async pick() {
    const hit = await current().pick(renderer, camera, SIZE / 2, SIZE / 2, { radius: 10 })
    return hit && { node: hit.node, index: hit.index, sourcePosition: hit.sourcePosition, attributes: hit.attributes }
  },

  errors() {
    return { shaderErrors: [...shaderErrors], glError: gl.getError() }
  },
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
