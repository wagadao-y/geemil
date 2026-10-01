import {
  Color, DepthTexture, FloatType, HalfFloatType, Mesh, NearestFilter, OrthographicCamera, PlaneGeometry,
  ShaderMaterial, Vector2, Vector4, WebGLRenderTarget,
} from 'three';
import type { Camera, Object3D, Scene, WebGLRenderer } from 'three';
import { restoreViewport } from './viewport.js';

export interface PotreeV2EDLOptions {
  /** Shading strength. Default: 0.4, as Potree's viewer sets it. */
  strength?: number;
  /** Distance to the sampled neighbours in CSS pixels. Default: 1.4, as in Potree. */
  radius?: number;
}

const NEIGHBOURS = 8;

const vertexShader = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const fragmentShader = /* glsl */`
#include <common>
#include <packing>
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform vec2 resolution;
uniform float radius;
uniform float strength;
uniform float cameraNear;
uniform float cameraFar;
uniform vec2 neighbours[${NEIGHBOURS}];
varying vec2 vUv;

// log2 of the distance along the view direction, as Potree stores it for EDL.
float logViewDepth(float depth) {
#if defined(EDL_LOG_DEPTH)
  // Inverse of logdepthbuf_fragment for perspective cameras.
  return log2(exp2(depth * log2(cameraFar + 1.0)) - 1.0);
#elif defined(EDL_PERSPECTIVE)
  return log2(-perspectiveDepthToViewZ(depth, cameraNear, cameraFar));
#else
  return log2(max(-orthographicDepthToViewZ(depth, cameraNear, cameraFar), 1e-6));
#endif
}

void main() {
  float depth = texture2D(depthTexture, vUv).x;
  if (depth >= 1.0) discard;
  float center = logViewDepth(depth);
  vec2 offset = radius / resolution;
  // Christian Boucheny's EDL, as adapted from CloudCompare by Potree: darken
  // where neighbours are nearer the camera.
  float sum = 0.0;
  for (int i = 0; i < ${NEIGHBOURS}; i++) {
    float neighbour = texture2D(depthTexture, vUv + offset * neighbours[i]).x;
    if (neighbour < 1.0) sum += max(0.0, center - logViewDepth(neighbour));
  }
  float shade = exp(-sum / float(${NEIGHBOURS}) * 300.0 * strength);
  gl_FragColor = vec4(texture2D(colorTexture, vUv).rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // Potree shades display-encoded colors; shading linear ones would look weaker.
  gl_FragColor.rgb *= shade;
  gl_FragDepth = depth;
}`;

/**
 * Eye-Dome Lighting for Potree point clouds, as in Potree. Replaces `renderer.render(scene, camera)`:
 * the scene is drawn without the clouds, then the clouds alone into an offscreen target,
 * which is shaded from its depth and composited with depth testing against the scene.
 * Everything under a cloud's group is shaded, including its bounding boxes.
 */
export class PotreeV2EDL {
  strength: number;
  radius: number;

  private readonly target = new WebGLRenderTarget(1, 1, {
    type: HalfFloatType, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false,
    depthTexture: new DepthTexture(1, 1, FloatType),
  });
  private readonly material = new ShaderMaterial({
    vertexShader, fragmentShader,
    uniforms: {
      colorTexture: { value: this.target.texture },
      depthTexture: { value: this.target.depthTexture },
      resolution: { value: new Vector2() },
      radius: { value: 1 },
      strength: { value: 0.4 },
      cameraNear: { value: 0.1 },
      cameraFar: { value: 1000 },
      neighbours: {
        value: Array.from({ length: NEIGHBOURS }, (_, i) =>
          new Vector2(Math.cos(2 * Math.PI * i / NEIGHBOURS), Math.sin(2 * Math.PI * i / NEIGHBOURS))),
      },
    },
    depthTest: true,
    depthWrite: true,
  });
  private readonly quad = new Mesh(new PlaneGeometry(2, 2), this.material);
  private readonly quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly size = new Vector2();
  private readonly viewport = new Vector4();
  private readonly restored = new Vector4();
  private readonly clearColor = new Color();
  private readonly hidden: Object3D[] = [];

  constructor(options: PotreeV2EDLOptions = {}) {
    this.strength = options.strength ?? 0.4;
    this.radius = options.radius ?? 1.4;
    this.quad.frustumCulled = false;
  }

  /**
   * Render `scene` with EDL on the `clouds` (their `group`s must be in `scene`) into the
   * renderer's current target and viewport. `renderer.autoClear` applies to the scene as usual.
   */
  render(renderer: WebGLRenderer, scene: Scene, camera: Camera, clouds: Iterable<{ group: Object3D }>): void {
    const groups = [...clouds].map(cloud => cloud.group).filter(group => group.visible);
    const output = renderer.getRenderTarget();
    const viewport = renderer.getCurrentViewport(this.viewport);
    this.size.set(viewport.z, viewport.w);

    // The scene without the clouds.
    for (const group of groups) group.visible = false;
    try {
      renderer.render(scene, camera);
    } finally {
      for (const group of groups) group.visible = true;
    }
    if (groups.length === 0) return;

    // The clouds alone, rendered through the scene so parent transforms and fog still apply.
    const background = scene.background;
    const autoClear = renderer.autoClear;
    const clearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearColor);
    this.isolate(groups);
    try {
      scene.background = null;
      this.target.setSize(this.size.x, this.size.y);
      renderer.setRenderTarget(this.target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.autoClear = false;
      renderer.render(scene, camera);
    } finally {
      for (const object of this.hidden) object.visible = true;
      this.hidden.length = 0;
      scene.background = background;
      renderer.setClearColor(this.clearColor, clearAlpha);
      renderer.setRenderTarget(output);
      restoreViewport(renderer, viewport, this.restored);
    }

    // Shade and composite, keeping the clouds' depth so the scene still occludes them.
    try {
      this.updateUniforms(renderer, camera);
      renderer.render(this.quad, this.quadCamera);
    } finally {
      renderer.autoClear = autoClear;
    }
  }

  dispose(): void {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }

  /** Hide every visible object that is neither a cloud group, inside one, nor an ancestor of one. */
  private isolate(groups: Object3D[]): void {
    const keep = new Set<Object3D>();
    for (const group of groups) {
      for (let object: Object3D | null = group; object && !keep.has(object); object = object.parent) keep.add(object);
    }
    const inside = new Set(groups);
    for (const object of keep) {
      if (inside.has(object)) continue;
      for (const child of object.children) {
        if (keep.has(child) || !child.visible) continue;
        child.visible = false;
        this.hidden.push(child);
      }
    }
  }

  private updateUniforms(renderer: WebGLRenderer, camera: Camera): void {
    const u = this.material.uniforms;
    const perspective = (camera as { isPerspectiveCamera?: boolean }).isPerspectiveCamera === true;
    const logDepth = perspective && renderer.capabilities.logarithmicDepthBuffer;
    const defines = {
      EDL_PERSPECTIVE: perspective ? '' : false,
      EDL_LOG_DEPTH: logDepth ? '' : false,
    } as Record<string, string | false>;
    if (this.material.defines.EDL_PERSPECTIVE !== defines.EDL_PERSPECTIVE ||
      this.material.defines.EDL_LOG_DEPTH !== defines.EDL_LOG_DEPTH) {
      this.material.defines = { ...this.material.defines, ...defines };
      this.material.needsUpdate = true;
    }
    const { near, far } = camera as unknown as { near: number; far: number };
    u.cameraNear!.value = near;
    u.cameraFar!.value = far;
    u.resolution!.value.copy(this.size);
    // Potree draws at CSS resolution; scale so the outline width matches on high-DPI screens.
    u.radius!.value = this.radius * renderer.getPixelRatio();
    u.strength!.value = this.strength;
  }
}
