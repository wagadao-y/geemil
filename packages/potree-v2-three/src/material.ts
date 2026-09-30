import { Color, ShaderMaterial, UniformsLib, UniformsUtils } from 'three';
import { Vector4 } from 'three';
import type { Vector3, WebGLRenderer } from 'three';
import { ClipUniforms, clipVertex, clipVertexPars } from './clipping.js';
import type { ClipCapacity, NodeClip } from './clipping.js';
import type { OctreeNode } from './format.js';
import { PointSizeUniforms, pointSizeDefines, pointSizeVertexPars } from './point-size.js';
import type { PointSizeSettings, PotreeV2PointSizeType, VisibleNodesTexture } from './point-size.js';

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
${pointSizeVertexPars}
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
  // Before clipVertex, which moves clipped points out of the view.
  gl_PointSize = pointSize();
  ${clipVertex}
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
 * With `sizeType` `fixed`, `size` is in CSS pixels, as PointsMaterial's with sizeAttenuation off.
 */
export class PotreeV2PointMaterial extends ShaderMaterial {
  readonly clip: ClipUniforms;
  /** Root spacing of the cloud, in its local units. */
  readonly spacing: number;
  readonly visibleNodes: VisibleNodesTexture;
  /** CSS pixels for `fixed`, otherwise a factor of the spacing. */
  size: number;
  /** Lower limit in CSS pixels for `attenuated` and `adaptive`. */
  minSize: number;
  /** Upper limit in CSS pixels for `attenuated` and `adaptive`. */
  maxSize: number;
  private readonly pointSize: PointSizeUniforms;
  private pointShape: PotreeV2PointShape;
  private pointSizeType: PotreeV2PointSizeType;
  private readonly viewport = new Vector4();

  constructor(options: {
    size: number; shape: PotreeV2PointShape; sizeType: PotreeV2PointSizeType; minSize: number; maxSize: number;
    spacing: number; visibleNodes: VisibleNodesTexture; vertexColors: boolean;
  }) {
    const clip = new ClipUniforms();
    const pointSize = new PointSizeUniforms();
    super({
      vertexShader, fragmentShader,
      uniforms: {
        ...UniformsUtils.merge([UniformsLib.fog]),
        diffuse: { value: new Color(0xffffff) },
        ...pointSize.uniforms,
        ...clip.uniforms,
      },
      defines: { ...clip.defines, ...pointShapeDefines(options.shape), ...pointSizeDefines(options.sizeType) },
      vertexColors: options.vertexColors,
      fog: true,
    });
    this.clip = clip;
    this.pointSize = pointSize;
    this.spacing = options.spacing;
    this.visibleNodes = options.visibleNodes;
    this.size = options.size;
    this.minSize = options.minSize;
    this.maxSize = options.maxSize;
    this.pointShape = options.shape;
    this.pointSizeType = options.sizeType;
  }

  /** Point shape; changing it recompiles the shader. */
  get shape(): PotreeV2PointShape { return this.pointShape; }
  set shape(value: PotreeV2PointShape) {
    if (value === this.pointShape) return;
    this.pointShape = value;
    this.defines = { ...this.defines, ...pointShapeDefines(value) };
    this.needsUpdate = true;
  }

  /** How `size` becomes pixels; changing it recompiles the shader. */
  get sizeType(): PotreeV2PointSizeType { return this.pointSizeType; }
  set sizeType(value: PotreeV2PointSizeType) {
    if (value === this.pointSizeType) return;
    this.pointSizeType = value;
    this.defines = { ...this.defines, ...pointSizeDefines(value) };
    this.needsUpdate = true;
  }

  get sizeSettings(): PointSizeSettings {
    return { type: this.pointSizeType, size: this.size, minSize: this.minSize, maxSize: this.maxSize };
  }

  get clipCapacity(): ClipCapacity { return this.clip.capacity; }

  /** Recompile with room for `capacity` clips per node. */
  setClipCapacity(capacity: ClipCapacity): void {
    if (!this.clip.resize(capacity)) return;
    this.defines = { ...this.defines, ...this.clip.defines };
    this.needsUpdate = true;
  }

  /** Called for each node right before it is drawn. */
  setNode(node: OctreeNode, clip: NodeClip, origin: Vector3): void {
    const clipChanged = this.clip.write(clip, origin);
    const nodeChanged = this.pointSize.writeNode(node, this.visibleNodes.index(node));
    if (clipChanged || nodeChanged) this.uniformsNeedUpdate = true;
  }

  override onBeforeRender(renderer: WebGLRenderer): void {
    const viewportHeight = renderer.getCurrentViewport(this.viewport).w;
    if (this.pointSize.write(
      this.sizeSettings, renderer.getPixelRatio(), viewportHeight, this.spacing, this.visibleNodes.texture,
    )) this.uniformsNeedUpdate = true;
  }
}
