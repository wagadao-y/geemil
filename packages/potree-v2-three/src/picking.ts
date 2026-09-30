import {
  BufferGeometry, Color, Frustum, GLSL3, Matrix4, NearestFilter, Points, RGBAIntegerFormat, Scene,
  ShaderMaterial, UnsignedIntType, Vector2, WebGLRenderTarget,
} from 'three';
import type { Camera, OrthographicCamera, PerspectiveCamera, WebGLRenderer } from 'three';
import type { OctreeNode } from './format.js';
import { ClipUniforms, clipVertex, clipVertexPars } from './clipping.js';
import type { ClipCapacity, NodeClip } from './clipping.js';
import { pointShapeDefines, pointShapeFragment } from './material.js';
import type { PotreeV2PointShape } from './material.js';

/** A displayed node that can be hit by a pick. */
export interface PickTarget {
  node: OctreeNode;
  points: Points;
  /** The node's clips, applied exactly as when it is drawn. */
  clip: NodeClip;
}

export interface PickHit {
  target: PickTarget;
  /** Point index in the node geometry, i.e. gl_VertexID. */
  index: number;
  /** Distance from the requested position to the hit pixel centre, in device pixels. */
  distance: number;
}

const vertexShader = /* glsl */`
uniform float size;
${clipVertexPars}
flat out highp uint vIndex;
void main() {
  // Each node is one non-indexed Points object drawn from vertex 0, so the
  // vertex ID is the index into the node's attribute arrays.
  vIndex = uint(gl_VertexID);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  ${clipVertex}
  gl_PointSize = size;
}`;

const fragmentShader = /* glsl */`
uniform highp uint nodeId;
flat in highp uint vIndex;
layout(location = 0) out highp uvec4 pickId;
void main() {
  ${pointShapeFragment}
  pickId = uvec4(nodeId, vIndex, 0u, 0u);
}`;

type PickCamera = PerspectiveCamera | OrthographicCamera;

function isPickCamera(camera: Camera): camera is PickCamera {
  return (camera as PerspectiveCamera).isPerspectiveCamera === true ||
    (camera as OrthographicCamera).isOrthographicCamera === true;
}

async function waitForSync(gl: WebGL2RenderingContext, sync: WebGLSync): Promise<boolean> {
  for (;;) {
    if (gl.isContextLost()) return false;
    const status = gl.clientWaitSync(sync, 0, 0);
    if (status === gl.WAIT_FAILED) return false;
    if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) return true;
    await new Promise(resolve => setTimeout(resolve, 4));
  }
}

/**
 * Renders node and point IDs around a pixel into an integer target and reads
 * them back through a pixel pack buffer, so the caller never stalls on the GPU.
 */
export class PointPicker {
  private readonly clip = new ClipUniforms();
  private readonly material = new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader, fragmentShader,
    uniforms: { size: { value: 1 }, nodeId: { value: 0 }, ...this.clip.uniforms },
    defines: { ...this.clip.defines, ...pointShapeDefines('square') },
  });
  private shape: PotreeV2PointShape = 'square';
  // RGBA_INTEGER/UNSIGNED_INT is the read format WebGL2 guarantees for unsigned
  // integer attachments, so the readback does not depend on implementation formats.
  private readonly renderTarget = new WebGLRenderTarget(1, 1, {
    format: RGBAIntegerFormat, type: UnsignedIntType, internalFormat: 'RGBA32UI',
    minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false, depthBuffer: true,
  });
  private readonly scene = new Scene();
  /** Reused stand-ins that draw node geometries with the ID material; proxy i writes ID i + 1. */
  private readonly proxies: Points<BufferGeometry, ShaderMaterial>[] = [];
  /** The target each proxy draws in the current pick. */
  private readonly proxyTargets: PickTarget[] = [];
  private readonly frustum = new Frustum();
  private readonly projection = new Matrix4();
  private readonly drawingBuffer = new Vector2();
  private readonly clearColor = new Color();

  constructor() {
    // Proxy world matrices are set directly from the node objects.
    this.scene.matrixWorldAutoUpdate = false;
  }

  /**
   * `x`, `y` are CSS pixels from the canvas' top-left corner, and `pointSize` and
   * `radius` are CSS pixels too. With radius 0 only a point drawn under that pixel hits.
   * `clipCapacity` and `shape` are the display material's, so both compile the same
   * clip test and cover the same pixels.
   */
  async pick(
    renderer: WebGLRenderer, camera: Camera, targets: PickTarget[], groupMatrix: Matrix4,
    x: number, y: number, pointSize: number, radius: number, clipCapacity: ClipCapacity,
    shape: PotreeV2PointShape,
  ): Promise<PickHit | null> {
    if (targets.length === 0 || !isPickCamera(camera)) return null;
    if (this.clip.resize(clipCapacity)) {
      this.material.defines = { ...this.material.defines, ...this.clip.defines };
      this.material.needsUpdate = true;
    }
    if (shape !== this.shape) {
      this.shape = shape;
      this.material.defines = { ...this.material.defines, ...pointShapeDefines(shape) };
      this.material.needsUpdate = true;
    }
    const gl = renderer.getContext();
    if (!(gl instanceof WebGL2RenderingContext) || gl.isContextLost()) return null;
    const pixelRatio = renderer.getPixelRatio();
    const { x: bufferWidth, y: bufferHeight } = renderer.getDrawingBufferSize(this.drawingBuffer);
    const cx = x * pixelRatio;
    const cy = y * pixelRatio;
    const r = Math.max(0, radius) * pixelRatio;
    const size = pointSize * pixelRatio;

    // Pixels searched for hits, in device pixels from the top-left corner.
    const innerX0 = Math.max(0, Math.floor(cx - r));
    const innerY0 = Math.max(0, Math.floor(cy - r));
    const innerX1 = Math.min(bufferWidth, Math.floor(cx + r) + 1);
    const innerY1 = Math.min(bufferHeight, Math.floor(cy + r) + 1);
    if (innerX1 <= innerX0 || innerY1 <= innerY0) return null;
    // A point is clipped when its centre leaves the view, so render half a point
    // beyond the searched pixels. Stay inside the canvas, as the display does.
    const margin = Math.ceil(size / 2);
    const x0 = Math.max(0, innerX0 - margin);
    const y0 = Math.max(0, innerY0 - margin);
    const x1 = Math.min(bufferWidth, innerX1 + margin);
    const y1 = Math.min(bufferHeight, innerY1 + margin);
    const width = x1 - x0;
    const height = y1 - y0;

    camera.updateMatrixWorld();
    const pickCamera = new (camera.constructor as new () => PickCamera)().copy(camera as never, false) as PickCamera;
    // Keep the copied world matrices; recomputing them would drop a parent's transform.
    pickCamera.matrixWorldAutoUpdate = false;
    pickCamera.setViewOffset(bufferWidth, bufferHeight, x0, y0, width, height);
    pickCamera.updateProjectionMatrix();
    this.projection.multiplyMatrices(pickCamera.projectionMatrix, pickCamera.matrixWorldInverse).multiply(groupMatrix);
    this.frustum.setFromProjectionMatrix(this.projection);

    // Snapshot the drawn targets: the proxies may be reused by another pick while this one waits.
    const drawn: PickTarget[] = [];
    this.scene.clear();
    for (const target of targets) {
      if (!this.frustum.intersectsBox(target.node.box)) continue;
      const proxy = this.proxy(drawn.length);
      proxy.geometry = target.points.geometry;
      proxy.matrixWorld.multiplyMatrices(groupMatrix, target.points.matrix);
      this.proxyTargets[drawn.length] = target;
      this.scene.add(proxy);
      drawn.push(target);
    }
    if (drawn.length === 0) return null;
    this.material.uniforms.size!.value = size;

    const pixels = new Uint32Array(width * height * 4);
    const previousTarget = renderer.getRenderTarget();
    const previousClearColor = renderer.getClearColor(this.clearColor);
    const previousClearAlpha = renderer.getClearAlpha();
    const previousAutoClear = renderer.autoClear;
    let packBuffer: WebGLBuffer | null = null;
    let sync: WebGLSync | null = null;
    try {
      this.renderTarget.setSize(width, height);
      renderer.setRenderTarget(this.renderTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.autoClear = false;
      renderer.render(this.scene, pickCamera);

      packBuffer = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, packBuffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, pixels.byteLength, gl.STREAM_READ);
      gl.readPixels(0, 0, width, height, gl.RGBA_INTEGER, gl.UNSIGNED_INT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
    } finally {
      renderer.autoClear = previousAutoClear;
      renderer.setClearColor(previousClearColor, previousClearAlpha);
      renderer.setRenderTarget(previousTarget);
      this.scene.clear();
      this.proxyTargets.length = 0;
    }

    try {
      if (!sync || !(await waitForSync(gl, sync))) return null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, packBuffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    } finally {
      if (sync) gl.deleteSync(sync);
      gl.deleteBuffer(packBuffer);
    }

    let best: PickHit | null = null;
    // The pixel under (cx, cy) has its centre at most √½ px away, so it always qualifies.
    const maxDistance = r + Math.SQRT1_2;
    for (let py = innerY0; py < innerY1; py++) {
      // readPixels rows start at the bottom of the render target.
      const row = y1 - 1 - py;
      for (let px = innerX0; px < innerX1; px++) {
        const at = (row * width + (px - x0)) * 4;
        const id = pixels[at]!;
        if (id === 0) continue;
        const distance = Math.hypot(px + 0.5 - cx, py + 0.5 - cy);
        if (distance > maxDistance || (best && distance >= best.distance)) continue;
        const target = drawn[id - 1];
        const index = pixels[at + 1]!;
        if (!target || index >= target.points.geometry.getAttribute('position').count) continue;
        best = { target, index, distance };
      }
    }
    return best;
  }

  private proxy(index: number): Points<BufferGeometry, ShaderMaterial> {
    let proxy = this.proxies[index];
    if (!proxy) {
      proxy = new Points(new BufferGeometry(), this.material);
      proxy.matrixAutoUpdate = false;
      proxy.frustumCulled = false;
      const id = index + 1;
      // All proxies share one material, so the node ID and clip uniforms must be re-uploaded per object.
      proxy.onBeforeRender = () => {
        const target = this.proxyTargets[index]!;
        this.clip.write(target.clip, target.node.box.min);
        this.material.uniforms.nodeId!.value = id;
        this.material.uniformsNeedUpdate = true;
      };
      this.proxies[index] = proxy;
    }
    return proxy;
  }

  dispose(): void {
    this.scene.clear();
    this.proxies.length = 0;
    this.material.dispose();
    this.renderTarget.dispose();
  }
}
