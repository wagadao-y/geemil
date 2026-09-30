import { Color, ShaderMaterial, UniformsLib, UniformsUtils } from 'three';
import type { Vector3, WebGLRenderer } from 'three';
import { ClipUniforms, clipVertex, clipVertexPars } from './clipping.js';
import type { ClipCapacity, NodeClip } from './clipping.js';

/** `square` fills the whole point sprite; `circle` discards its corners. */
export type PotreeV2PointShape = 'square' | 'circle';

/** Shader defines for a point shape, shared by the display and pick materials. */
export function pointShapeDefines(shape: PotreeV2PointShape): Record<string, string | false> {
  // Three.js skips false defines; any other value, even undefined, is emitted.
  return { POINT_SHAPE_CIRCLE: shape === 'circle' ? '' : false };
}

/** Discards fragments outside the point shape; the first statement of a point fragment shader. */
export const pointShapeFragment = /* glsl */`
#ifdef POINT_SHAPE_CIRCLE
  vec2 pointCoord = 2.0 * gl_PointCoord - 1.0;
  if (dot(pointCoord, pointCoord) > 1.0) discard;
#endif`;

const vertexShader = /* glsl */`
#include <common>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
uniform float size;
${clipVertexPars}
void main() {
  #include <color_vertex>
#ifdef USE_COLOR
  // Potree's RGB bytes are display-encoded colors. Three.js expects linear
  // vertex colors and applies an sRGB output transform, which would brighten
  // the points unless the bytes are decoded before that transform.
  vColor.rgb = mix(
    pow(vColor.rgb * 0.9478672986 + vec3(0.0521327014), vec3(2.4)),
    vColor.rgb * 0.0773993808,
    lessThanEqual(vColor.rgb, vec3(0.04045))
  );
#endif
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  ${clipVertex}
  gl_PointSize = size;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}`;

const fragmentShader = /* glsl */`
uniform vec3 diffuse;
#include <common>
#include <color_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
void main() {
  ${pointShapeFragment}
  #include <logdepthbuf_fragment>
  vec4 diffuseColor = vec4(diffuse, 1.0);
  #include <color_fragment>
  gl_FragColor = vec4(diffuseColor.rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/**
 * Square or circular screen-space points of a Potree cloud, with per-node clip uniforms.
 * `size` is in CSS pixels, as PointsMaterial's with sizeAttenuation off.
 */
export class PotreeV2PointMaterial extends ShaderMaterial {
  readonly clip: ClipUniforms;
  private cssSize: number;
  private pointShape: PotreeV2PointShape;

  constructor(options: { size: number; shape: PotreeV2PointShape; vertexColors: boolean }) {
    const clip = new ClipUniforms();
    super({
      vertexShader, fragmentShader,
      uniforms: {
        ...UniformsUtils.merge([UniformsLib.fog]),
        diffuse: { value: new Color(0xffffff) },
        size: { value: options.size },
        ...clip.uniforms,
      },
      defines: { ...clip.defines, ...pointShapeDefines(options.shape) },
      vertexColors: options.vertexColors,
      fog: true,
    });
    this.clip = clip;
    this.cssSize = options.size;
    this.pointShape = options.shape;
  }

  /** Point size in CSS pixels. */
  get size(): number { return this.cssSize; }
  set size(value: number) { this.cssSize = value; }

  /** Point shape; changing it recompiles the shader. */
  get shape(): PotreeV2PointShape { return this.pointShape; }
  set shape(value: PotreeV2PointShape) {
    if (value === this.pointShape) return;
    this.pointShape = value;
    this.defines = { ...this.defines, ...pointShapeDefines(value) };
    this.needsUpdate = true;
  }

  get clipCapacity(): ClipCapacity { return this.clip.capacity; }

  /** Recompile with room for `capacity` clips per node. */
  setClipCapacity(capacity: ClipCapacity): void {
    if (!this.clip.resize(capacity)) return;
    this.defines = { ...this.defines, ...this.clip.defines };
    this.needsUpdate = true;
  }

  /** Called for each node right before it is drawn. */
  setNodeClip(clip: NodeClip, origin: Vector3): void {
    if (this.clip.write(clip, origin)) this.uniformsNeedUpdate = true;
  }

  override onBeforeRender(renderer: WebGLRenderer): void {
    const size = this.cssSize * renderer.getPixelRatio();
    const uniform = this.uniforms.size!;
    if (uniform.value !== size) {
      uniform.value = size;
      this.uniformsNeedUpdate = true;
    }
  }
}
