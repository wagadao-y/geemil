import {
  BufferGeometry, Color, Frustum, GLSL3, Matrix4, NearestFilter, Points, RGBAIntegerFormat, Scene,
  ShaderMaterial, UnsignedIntType, Vector2, WebGLRenderTarget,
} from 'three';
import type { Camera, OrthographicCamera, PerspectiveCamera, Texture, WebGLRenderer } from 'three';
import type { OctreeNode } from './format.js';
import { ClipUniforms, clipVertex, clipVertexPars } from './clipping.js';
import type { NodeClip } from './clipping.js';
import { classificationDefines, classificationVertex, classificationVertexPars } from './point-color.js';
import { pointShapeDefines, pointShapeFragment } from './material.js';
import type { PotreeV2PointMaterial, PotreeV2PointShape } from './material.js';
import { PointSizeUniforms, pointSizeDefines, pointSizeVertexPars } from './point-size.js';
import type { PotreeV2PointSizeType } from './point-size.js';

/** A displayed node that can be hit by a pick. */
export interface PickTarget {
  node: OctreeNode;
  points: Points;
  /** The node's clips, applied exactly as when it is drawn. */
  clip: NodeClip;
}

/**
 * One cloud's displayed nodes. Each layer is drawn with pick shaders that match its display
 * material, into one depth-tested target, so the nearest point of any layer hits.
 */
export interface PickLayer<Owner> {
  owner: Owner;
  display: PotreeV2PointMaterial;
  /** World matrix of the cloud's group. */
  groupMatrix: Matrix4;
  targets: PickTarget[];
}

export interface PickHit<Owner> {
  layer: PickLayer<Owner>;
  target: PickTarget;
  /** Point index in the node geometry, i.e. gl_VertexID. */
  index: number;
  /** Distance from the requested position to the hit pixel centre, in device pixels. */
  distance: number;
}

const vertexShader = /* glsl */`
${pointSizeVertexPars}
${clipVertexPars}
${classificationVertexPars}
flat out highp uint vIndex;
void main() {
  // Each node is one non-indexed Points object drawn from vertex 0, so the
  // vertex ID is the index into the node's attribute arrays.
  vIndex = uint(gl_VertexID);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = pointSize();
  ${clipVertex}
  ${classificationVertex}
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

/** The ID material of one display material, compiled with the same tests and sizes. */
class PickShader {
  readonly clip = new ClipUniforms();
  readonly pointSize = new PointSizeUniforms();
  readonly material = new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader, fragmentShader,
    uniforms: {
      nodeId: { value: 0 }, classificationStyles: { value: null as Texture | null },
      ...this.pointSize.uniforms, ...this.clip.uniforms,
    },
    defines: {
      ...this.clip.defines, ...pointShapeDefines('square'), ...pointSizeDefines('fixed'), ...classificationDefines(false),
    },
  });
  private shape: PotreeV2PointShape = 'square';
  private sizeType: PotreeV2PointSizeType = 'fixed';
  private classified = false;

  /**
   * Follow `display`'s clips, point size and shape, so both materials cover the same pixels.
   * `height` is the pick target's, which covers the view offset region.
   */
  sync(display: PotreeV2PointMaterial, pixelRatio: number, height: number): void {
    const { shape, sizeType } = display;
    if (this.clip.resize(display.clipCapacity)) {
      this.material.defines = { ...this.material.defines, ...this.clip.defines };
      this.material.needsUpdate = true;
    }
    if (shape !== this.shape) {
      this.shape = shape;
      this.material.defines = { ...this.material.defines, ...pointShapeDefines(shape) };
      this.material.needsUpdate = true;
    }
    if (sizeType !== this.sizeType) {
      this.sizeType = sizeType;
      this.material.defines = { ...this.material.defines, ...pointSizeDefines(sizeType) };
      this.material.needsUpdate = true;
    }
    // Points of hidden classes are not hit, as they are not drawn.
    const classified = display.attributes.includes('classification');
    if (classified !== this.classified) {
      this.classified = classified;
      this.material.defines = { ...this.material.defines, ...classificationDefines(classified) };
      this.material.needsUpdate = true;
    }
    this.material.uniforms.classificationStyles!.value = display.classification.texture;
    this.pointSize.write(display.sizeSettings, pixelRatio, height, display.spacing, display.visibleNodes.texture);
  }

  dispose(): void { this.material.dispose(); }
}

/** What one proxy draws in the current pick. */
type Drawn<Owner> = { layer: PickLayer<Owner>; target: PickTarget; shader: PickShader };

let shared: PointPicker | undefined;

/**
 * Renders node and point IDs around a pixel into an integer target and reads
 * them back through a pixel pack buffer, so the caller never stalls on the GPU.
 * One picker is shared by every cloud.
 */
export class PointPicker {
  private references = 0;
  /** Pick shaders by display material; a cloud's is dropped by forget() when it is disposed. */
  private readonly shaders = new Map<PotreeV2PointMaterial, PickShader>();
  // RGBA_INTEGER/UNSIGNED_INT is the read format WebGL2 guarantees for unsigned
  // integer attachments, so the readback does not depend on implementation formats.
  private readonly renderTarget = new WebGLRenderTarget(1, 1, {
    format: RGBAIntegerFormat, type: UnsignedIntType, internalFormat: 'RGBA32UI',
    minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false, depthBuffer: true,
  });
  private readonly scene = new Scene();
  /** Reused stand-ins that draw node geometries with the ID materials; proxy i writes ID i + 1. */
  private readonly proxies: Points<BufferGeometry, ShaderMaterial>[] = [];
  /** Held by proxies between picks, so that they keep no node geometry alive after its eviction. */
  private readonly emptyGeometry = new BufferGeometry();
  /** What each proxy draws in the current pick. */
  private readonly drawing: Drawn<unknown>[] = [];
  private readonly frustum = new Frustum();
  private readonly projection = new Matrix4();
  private readonly drawingBuffer = new Vector2();
  private readonly clearColor = new Color();

  /** The picker shared by every cloud, created on first use and disposed with the last release(). */
  static acquire(): PointPicker {
    shared ??= new PointPicker();
    shared.references++;
    return shared;
  }

  private constructor() {
    // Proxy world matrices are set directly from the node objects.
    this.scene.matrixWorldAutoUpdate = false;
  }

  /** Give back the picker from acquire(); the last release disposes it. */
  release(): void {
    if (--this.references > 0) return;
    if (shared === this) shared = undefined;
    this.dispose();
  }

  /** Dispose the pick shader of a display material that is no longer used. */
  forget(display: PotreeV2PointMaterial): void {
    this.shaders.get(display)?.dispose();
    this.shaders.delete(display);
  }

  /**
   * `x`, `y` are CSS pixels from the canvas' top-left corner, and `radius` is CSS pixels too.
   * With radius 0 only a point drawn under that pixel hits. The layers are drawn together
   * with depth testing, so a point hidden behind another cloud's points is not hit.
   */
  async pick<Owner>(
    renderer: WebGLRenderer, camera: Camera, layers: readonly PickLayer<Owner>[],
    x: number, y: number, radius: number,
  ): Promise<PickHit<Owner> | null> {
    if (!layers.some(layer => layer.targets.length > 0) || !isPickCamera(camera)) return null;
    const gl = renderer.getContext();
    if (!(gl instanceof WebGL2RenderingContext) || gl.isContextLost()) return null;
    const pixelRatio = renderer.getPixelRatio();
    const { x: bufferWidth, y: bufferHeight } = renderer.getDrawingBufferSize(this.drawingBuffer);
    const cx = x * pixelRatio;
    const cy = y * pixelRatio;
    const r = Math.max(0, radius) * pixelRatio;
    // Largest point drawn by any layer, in device pixels.
    const size = Math.max(...layers.map(({ display }) => {
      const settings = display.sizeSettings;
      return (settings.type === 'fixed' ? settings.size : settings.maxSize) * pixelRatio;
    }));

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

    // Snapshot the drawn targets: the proxies may be reused by another pick while this one waits.
    const drawn: Drawn<Owner>[] = [];
    this.scene.clear();
    for (const layer of layers) {
      this.projection.multiplyMatrices(pickCamera.projectionMatrix, pickCamera.matrixWorldInverse).multiply(layer.groupMatrix);
      this.frustum.setFromProjectionMatrix(this.projection);
      let shader: PickShader | undefined;
      for (const target of layer.targets) {
        if (!this.frustum.intersectsBox(target.node.box)) continue;
        if (!shader) {
          shader = this.shader(layer.display);
          shader.sync(layer.display, pixelRatio, height);
        }
        const proxy = this.proxy(drawn.length);
        proxy.geometry = target.points.geometry;
        proxy.material = shader.material;
        proxy.matrixWorld.multiplyMatrices(layer.groupMatrix, target.points.matrix);
        const item = { layer, target, shader };
        this.drawing[drawn.length] = item;
        this.scene.add(proxy);
        drawn.push(item);
      }
    }
    if (drawn.length === 0) return null;

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
      for (let i = 0; i < drawn.length; i++) this.proxies[i]!.geometry = this.emptyGeometry;
      this.drawing.length = 0;
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

    let best: PickHit<Owner> | null = null;
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
        const item = drawn[id - 1];
        const index = pixels[at + 1]!;
        if (!item || index >= item.target.points.geometry.getAttribute('position').count) continue;
        best = { layer: item.layer, target: item.target, index, distance };
      }
    }
    return best;
  }

  private shader(display: PotreeV2PointMaterial): PickShader {
    let shader = this.shaders.get(display);
    if (!shader) {
      shader = new PickShader();
      this.shaders.set(display, shader);
    }
    return shader;
  }

  private proxy(index: number): Points<BufferGeometry, ShaderMaterial> {
    let proxy = this.proxies[index];
    if (!proxy) {
      proxy = new Points(this.emptyGeometry);
      proxy.matrixAutoUpdate = false;
      proxy.frustumCulled = false;
      const id = index + 1;
      // Proxies of one layer share its material, so the node ID and clip uniforms must be re-uploaded per object.
      proxy.onBeforeRender = () => {
        const { layer, target, shader } = this.drawing[index]!;
        shader.clip.write(target.clip, target.node.box.min);
        shader.pointSize.writeNode(target.node, layer.display.visibleNodes.index(target.node));
        shader.material.uniforms.nodeId!.value = id;
        shader.material.uniformsNeedUpdate = true;
      };
      this.proxies[index] = proxy as Points<BufferGeometry, ShaderMaterial>;
    }
    return proxy as Points<BufferGeometry, ShaderMaterial>;
  }

  private dispose(): void {
    this.scene.clear();
    this.proxies.length = 0;
    this.emptyGeometry.dispose();
    for (const shader of this.shaders.values()) shader.dispose();
    this.shaders.clear();
    this.renderTarget.dispose();
  }
}
