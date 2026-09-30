import { Color, ShaderMaterial, UniformsLib, UniformsUtils } from 'three';
import { Vector2, Vector4 } from 'three';
import type { DataTexture, Vector3, WebGLRenderer } from 'three';
import { ClipUniforms, clipVertex, clipVertexPars } from './clipping.js';
import type { ClipCapacity, NodeClip } from './clipping.js';
import type { OctreeNode } from './format.js';
import {
  classificationDefines, classificationVertex, classificationVertexPars, colorTypeAttribute, createGradientTexture,
  GRADIENT_SIZE, pointColorDefines, PotreeV2Classification, sampleGradient,
} from './point-color.js';
import type { PotreeV2Gradient, PotreeV2PointColorType } from './point-color.js';
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
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
${pointSizeVertexPars}
${clipVertexPars}
${classificationVertexPars}
uniform vec3 diffuse;
#if defined(POINT_COLOR_RGB)
attribute vec4 color;
#elif defined(POINT_COLOR_INTENSITY)
attribute float intensity;
uniform vec2 intensityRange;
uniform float intensityGamma;
#elif defined(POINT_COLOR_ELEVATION)
uniform sampler2D gradient;
// Maps the node-local z to 0 and 1 at the ends of the elevation range.
uniform float elevationOffset;
uniform float elevationScale;
#endif
varying vec3 vPointColor;
// Potree's RGB bytes and intensities are display-encoded values. Three.js expects linear
// colors and applies an sRGB output transform, which would brighten the points unless
// they are decoded before that transform.
vec3 srgbToLinear(vec3 c) {
  return mix(pow(c * 0.9478672986 + vec3(0.0521327014), vec3(2.4)), c * 0.0773993808, lessThanEqual(c, vec3(0.04045)));
}
vec3 pointColor() {
#if defined(POINT_COLOR_RGB)
  return srgbToLinear(color.rgb);
#elif defined(POINT_COLOR_INTENSITY)
  float t = clamp((intensity - intensityRange.x) / max(intensityRange.y - intensityRange.x, 1e-30), 0.0, 1.0);
  return srgbToLinear(vec3(pow(t, intensityGamma)));
#elif defined(POINT_COLOR_ELEVATION)
  float t = clamp((position.z + elevationOffset) * elevationScale, 0.0, 1.0);
  // The texture is sRGB, so sampling returns linear colors.
  return texture2D(gradient, vec2((t * ${GRADIENT_SIZE - 1}.0 + 0.5) / ${GRADIENT_SIZE}.0, 0.5)).rgb;
#elif defined(POINT_COLOR_CLASSIFICATION) && defined(POTREE_CLASSIFICATION)
  return classificationStyle().rgb;
#else
  return diffuse;
#endif
}
void main() {
  vPointColor = pointColor();
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  // Before clipVertex, which moves clipped points out of the view.
  gl_PointSize = pointSize();
  ${clipVertex}
  ${classificationVertex}
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}`;

const fragmentShader = /* glsl */`
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
varying vec3 vPointColor;
void main() {
  ${pointShapeFragment}
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(vPointColor, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** @internal */
export interface PointMaterialOptions {
  size: number; shape: PotreeV2PointShape; sizeType: PotreeV2PointSizeType; minSize: number; maxSize: number;
  spacing: number; visibleNodes: VisibleNodesTexture;
  /** Decoded attribute names; the color types that need a missing one cannot be selected. */
  attributes: readonly string[];
  colorType: PotreeV2PointColorType;
  /** metadata.json z of the cloud's local origin, the bounding box minimum. */
  sourceOriginZ: number;
  elevationRange: [number, number];
  intensityRange: [number, number];
  gradient: PotreeV2Gradient;
  /** Shared scheme; when omitted, the material owns one with Potree's defaults. */
  classification?: PotreeV2Classification;
}

/**
 * Square or circular screen-space points of a Potree cloud, with per-node clip uniforms.
 * With `sizeType` `fixed`, `size` is in CSS pixels, as PointsMaterial's with sizeAttenuation off.
 */
export class PotreeV2PointMaterial extends ShaderMaterial {
  /** @internal */
  readonly clip: ClipUniforms;
  /**
   * Root spacing of the cloud, in its local units.
   * @internal
   */
  readonly spacing: number;
  /** @internal */
  readonly visibleNodes: VisibleNodesTexture;
  /** CSS pixels for `fixed`, otherwise a factor of the spacing. */
  size: number;
  /** Lower limit in CSS pixels for `attenuated` and `adaptive`. */
  minSize: number;
  /** Upper limit in CSS pixels for `attenuated` and `adaptive`. */
  maxSize: number;
  /** metadata.json z range mapped onto the gradient by `elevation`; points beyond it take the end colors. */
  elevationRange: [number, number];
  /** Intensities mapped from black to white by `intensity`. */
  intensityRange: [number, number];
  /** Exponent applied to the normalized intensity; below 1 brightens dark points. */
  intensityGamma = 1;
  /** Decoded attribute names. */
  readonly attributes: readonly string[];
  private readonly pointSize: PointSizeUniforms;
  private pointShape: PotreeV2PointShape;
  private pointSizeType: PotreeV2PointSizeType;
  private pointColorType: PotreeV2PointColorType;
  private readonly sourceOriginZ: number;
  private gradientStops: PotreeV2Gradient;
  private readonly gradientTexture: DataTexture;
  private classificationScheme: PotreeV2Classification;
  /** Created by this material, so disposed with it. */
  private readonly ownClassification?: PotreeV2Classification;
  private readonly viewport = new Vector4();

  /** @internal */
  constructor(options: PointMaterialOptions) {
    const clip = new ClipUniforms();
    const pointSize = new PointSizeUniforms();
    assertColorType(options.colorType, options.attributes);
    const ownClassification = options.classification ? undefined : new PotreeV2Classification();
    const classification = options.classification ?? ownClassification!;
    const gradientTexture = createGradientTexture(options.gradient);
    super({
      vertexShader, fragmentShader,
      uniforms: {
        ...UniformsUtils.merge([UniformsLib.fog]),
        diffuse: { value: new Color(0xffffff) },
        intensityRange: { value: new Vector2() },
        intensityGamma: { value: 1 },
        gradient: { value: gradientTexture },
        elevationOffset: { value: 0 },
        elevationScale: { value: 1 },
        classificationStyles: { value: classification.texture },
        ...pointSize.uniforms,
        ...clip.uniforms,
      },
      defines: {
        ...clip.defines, ...pointShapeDefines(options.shape), ...pointSizeDefines(options.sizeType),
        ...pointColorDefines(options.colorType), ...classificationDefines(options.attributes.includes('classification')),
      },
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
    this.attributes = options.attributes;
    this.pointColorType = options.colorType;
    this.sourceOriginZ = options.sourceOriginZ;
    this.elevationRange = [...options.elevationRange];
    this.intensityRange = [...options.intensityRange];
    this.gradientStops = options.gradient;
    this.gradientTexture = gradientTexture;
    this.classificationScheme = classification;
    this.ownClassification = ownClassification;
  }

  /** Color of every point for `solid`, in Three.js' working color space. */
  get color(): Color { return this.uniforms.diffuse!.value as Color; }

  /**
   * How points are colored; changing it recompiles the shader. `rgb`, `intensity` and
   * `classification` throw unless that attribute was decoded; see the `attributes` option.
   */
  get colorType(): PotreeV2PointColorType { return this.pointColorType; }
  set colorType(value: PotreeV2PointColorType) {
    if (value === this.pointColorType) return;
    assertColorType(value, this.attributes);
    this.pointColorType = value;
    this.defines = { ...this.defines, ...pointColorDefines(value) };
    this.needsUpdate = true;
  }

  /** Gradient of `elevation`, such as a PotreeV2Gradients entry. */
  get gradient(): PotreeV2Gradient { return this.gradientStops; }
  set gradient(value: PotreeV2Gradient) {
    sampleGradient(value, this.gradientTexture.image.data as Uint8Array<ArrayBuffer>);
    this.gradientStops = value;
    this.gradientTexture.needsUpdate = true;
  }

  /** Class colors and visibility; one scheme can be shared by several clouds. */
  get classification(): PotreeV2Classification { return this.classificationScheme; }
  set classification(value: PotreeV2Classification) {
    this.classificationScheme = value;
    this.uniforms.classificationStyles!.value = value.texture;
    this.uniformsNeedUpdate = true;
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

  /** @internal */
  get sizeSettings(): PointSizeSettings {
    return { type: this.pointSizeType, size: this.size, minSize: this.minSize, maxSize: this.maxSize };
  }

  /** @internal */
  get clipCapacity(): ClipCapacity { return this.clip.capacity; }

  /**
   * Recompile with room for `capacity` clips per node.
   * @internal
   */
  setClipCapacity(capacity: ClipCapacity): void {
    if (!this.clip.resize(capacity)) return;
    this.defines = { ...this.defines, ...this.clip.defines };
    this.needsUpdate = true;
  }

  /**
   * Called for each node right before it is drawn.
   * @internal
   */
  setNode(node: OctreeNode, clip: NodeClip, origin: Vector3): void {
    const clipChanged = this.clip.write(clip, origin);
    const nodeChanged = this.pointSize.writeNode(node, this.visibleNodes.index(node));
    let elevationChanged = false;
    if (this.pointColorType === 'elevation') {
      // Combined in double precision; the float32 node-local z only adds a small value.
      const offset = origin.z + this.sourceOriginZ - this.elevationRange[0];
      const u = this.uniforms.elevationOffset!;
      if (u.value !== offset) {
        u.value = offset;
        elevationChanged = true;
      }
    }
    if (clipChanged || nodeChanged || elevationChanged) this.uniformsNeedUpdate = true;
  }

  override onBeforeRender(renderer: WebGLRenderer): void {
    const viewportHeight = renderer.getCurrentViewport(this.viewport).w;
    if (this.pointSize.write(
      this.sizeSettings, renderer.getPixelRatio(), viewportHeight, this.spacing, this.visibleNodes.texture,
    )) this.uniformsNeedUpdate = true;
    const u = this.uniforms;
    const [low, high] = this.elevationRange;
    const scale = high > low ? 1 / (high - low) : 0;
    const intensity = u.intensityRange!.value as Vector2;
    if (u.elevationScale!.value !== scale || intensity.x !== this.intensityRange[0] ||
      intensity.y !== this.intensityRange[1] || u.intensityGamma!.value !== this.intensityGamma) {
      u.elevationScale!.value = scale;
      intensity.set(this.intensityRange[0], this.intensityRange[1]);
      u.intensityGamma!.value = this.intensityGamma;
      this.uniformsNeedUpdate = true;
    }
  }

  override dispose(): void {
    this.gradientTexture.dispose();
    this.ownClassification?.dispose();
    super.dispose();
  }
}

function assertColorType(type: PotreeV2PointColorType, attributes: readonly string[]): void {
  const attribute = colorTypeAttribute(type);
  if (attribute && !attributes.includes(attribute)) {
    throw new Error(`Point color type '${type}' needs the decoded attribute '${attribute}'; add it to the attributes option`);
  }
}
