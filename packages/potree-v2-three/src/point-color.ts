import { Color, DataTexture, LinearFilter, NearestFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';
import type { ColorRepresentation } from 'three';

/**
 * `rgb`: the rgb attribute. `solid`: `material.color`. `elevation`: `material.gradient` over
 * `material.elevationRange`. `intensity`: grayscale over `material.intensityRange`.
 * `classification`: `material.classification`'s color of each class.
 */
export type PotreeV2PointColorType = 'rgb' | 'solid' | 'elevation' | 'intensity' | 'classification';

/** Gradient stops: positions from 0 to 1 and sRGB colors, as a CSS linear-gradient. */
export type PotreeV2Gradient = readonly (readonly [number, ColorRepresentation])[];

/** Gradients of Potree; SPECTRAL is its default for elevation. */
export const PotreeV2Gradients = {
  SPECTRAL: [
    [0, '#5e4fa2'], [0.1, '#3288bd'], [0.2, '#66c2a5'], [0.3, '#abdda4'], [0.4, '#e6f598'], [0.5, '#ffffbf'],
    [0.6, '#fee08b'], [0.7, '#fdae61'], [0.8, '#f46d43'], [0.9, '#d53e4f'], [1, '#9e0142'],
  ],
  VIRIDIS: [[0, '#440154'], [0.25, '#3b528b'], [0.5, '#21918c'], [0.75, '#5ec962'], [1, '#fde725']],
  INFERNO: [[0, '#000004'], [0.2, '#420a68'], [0.4, '#932667'], [0.6, '#dd513a'], [0.8, '#fca50a'], [1, '#fcffa4']],
  RAINBOW: [
    [0, '#4700b6'], [1 / 6, '#0000ff'], [2 / 6, '#00ffff'], [3 / 6, '#00ff00'], [4 / 6, '#ffff00'],
    [5 / 6, '#ffa300'], [1, '#ff0000'],
  ],
  GRAYSCALE: [[0, '#000000'], [1, '#ffffff']],
} as const satisfies Record<string, PotreeV2Gradient>;

/** The decoded attribute a color type reads; undefined when it needs none beyond position. */
export function colorTypeAttribute(type: PotreeV2PointColorType): string | undefined {
  return type === 'rgb' || type === 'intensity' || type === 'classification' ? type : undefined;
}

/** Shader defines for a color type. */
export function pointColorDefines(type: PotreeV2PointColorType): Record<string, string | false> {
  return {
    POINT_COLOR_RGB: type === 'rgb' ? '' : false,
    POINT_COLOR_ELEVATION: type === 'elevation' ? '' : false,
    POINT_COLOR_INTENSITY: type === 'intensity' ? '' : false,
    POINT_COLOR_CLASSIFICATION: type === 'classification' ? '' : false,
  };
}

const scratch = new Color();

/** sRGB bytes of a color given in Three.js' usual conventions. */
function srgbBytes(color: ColorRepresentation): [number, number, number] {
  scratch.set(color).getRGB(scratch, SRGBColorSpace);
  const byte = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255);
  return [byte(scratch.r), byte(scratch.g), byte(scratch.b)];
}

/** Texels of a gradient texture; the shader maps 0 and 1 to the centres of the first and last. */
export const GRADIENT_SIZE = 256;

/** Sample `gradient` into RGBA sRGB bytes, interpolating between stops in sRGB as a CSS gradient does. */
export function sampleGradient(gradient: PotreeV2Gradient, out = new Uint8Array(GRADIENT_SIZE * 4)): Uint8Array {
  if (gradient.length === 0) throw new Error('A gradient needs at least one stop');
  const stops = gradient.map(([at, color]) => {
    if (!Number.isFinite(at) || at < 0 || at > 1) throw new Error(`Gradient stop outside 0 to 1: ${at}`);
    return { at, rgb: srgbBytes(color) };
  }).sort((a, b) => a.at - b.at);
  const texels = out.length / 4;
  let next = 0;
  for (let i = 0; i < texels; i++) {
    const t = texels === 1 ? 0 : i / (texels - 1);
    while (next < stops.length && stops[next]!.at <= t) next++;
    const before = stops[Math.max(0, next - 1)]!;
    const after = stops[Math.min(stops.length - 1, next)]!;
    const f = after.at > before.at ? Math.min(1, Math.max(0, (t - before.at) / (after.at - before.at))) : 0;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(before.rgb[c]! + (after.rgb[c]! - before.rgb[c]!) * f);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** One-row sRGB texture of a gradient, sampled with linear filtering. */
export function createGradientTexture(gradient: PotreeV2Gradient): DataTexture {
  const texture = new DataTexture(sampleGradient(gradient), GRADIENT_SIZE, 1, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export interface PotreeV2ClassStyle {
  /** sRGB color, as any Three.js ColorRepresentation. */
  color?: ColorRepresentation;
  /** Hidden classes are neither drawn nor picked. Default: true. */
  visible?: boolean;
}

/** Potree's default colors of the ASPRS LAS classes; other codes use DEFAULT_CLASS_COLOR. */
export const DEFAULT_CLASS_COLORS: Readonly<Record<number, ColorRepresentation>> = {
  0: '#808080', // never classified
  1: '#808080', // unclassified
  2: '#a1522e', // ground
  3: '#00ff00', // low vegetation
  4: '#00cc00', // medium vegetation
  5: '#009900', // high vegetation
  6: '#ffa800', // building
  7: '#ff00ff', // low point (noise)
  8: '#ff0000', // key point
  9: '#0000ff', // water
  12: '#ffff00', // overlap
};
export const DEFAULT_CLASS_COLOR: ColorRepresentation = '#4d9999';

/** Classification codes a scheme covers; LAS codes are bytes. */
const CLASS_COUNT = 256;

function assertClassCode(code: number): void {
  if (!Number.isInteger(code) || code < 0 || code >= CLASS_COUNT) {
    throw new Error(`Classification code must be an integer from 0 to ${CLASS_COUNT - 1}: ${code}`);
  }
}

/**
 * Color and visibility of each classification code, shared by every cloud it is assigned to.
 * Visibility applies to any color type when the cloud decodes `classification`. Changes are
 * uploaded with the next render.
 */
export class PotreeV2Classification {
  /** One RGBA texel per code: sRGB color, and alpha 255 when visible or 0 when hidden. */
  readonly texture: DataTexture;
  private readonly data = new Uint8Array(CLASS_COUNT * 4);

  /** `styles` overrides Potree's defaults for the codes it lists. */
  constructor(styles: Readonly<Record<number, PotreeV2ClassStyle>> = {}) {
    this.texture = new DataTexture(this.data, CLASS_COUNT, 1, RGBAFormat, UnsignedByteType);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = NearestFilter;
    this.texture.magFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.reset();
    for (const [code, style] of Object.entries(styles)) this.set(Number(code), style);
  }

  /** Restore Potree's default colors and show every class. */
  reset(): void {
    for (let code = 0; code < CLASS_COUNT; code++) {
      this.data.set([...srgbBytes(DEFAULT_CLASS_COLORS[code] ?? DEFAULT_CLASS_COLOR), 255], code * 4);
    }
    this.texture.needsUpdate = true;
  }

  set(code: number, style: PotreeV2ClassStyle): void {
    if (style.color !== undefined) this.setColor(code, style.color);
    if (style.visible !== undefined) this.setVisible(code, style.visible);
  }

  setColor(code: number, color: ColorRepresentation): void {
    assertClassCode(code);
    this.data.set(srgbBytes(color), code * 4);
    this.texture.needsUpdate = true;
  }

  /** The class color in Three.js' working color space, as `new Color(color)` would give. */
  getColor(code: number, target = new Color()): Color {
    assertClassCode(code);
    const at = code * 4;
    return target.setRGB(this.data[at]! / 255, this.data[at + 1]! / 255, this.data[at + 2]! / 255, SRGBColorSpace);
  }

  setVisible(code: number, visible: boolean): void {
    assertClassCode(code);
    this.data[code * 4 + 3] = visible ? 255 : 0;
    this.texture.needsUpdate = true;
  }

  isVisible(code: number): boolean {
    assertClassCode(code);
    return this.data[code * 4 + 3] !== 0;
  }

  dispose(): void { this.texture.dispose(); }
}

/**
 * Vertex shader declarations shared by drawing and picking. POTREE_CLASSIFICATION is
 * defined when the geometry has a classification attribute.
 */
export const classificationVertexPars = /* glsl */`
#ifdef POTREE_CLASSIFICATION
attribute float classification;
uniform sampler2D classificationStyles;
vec4 classificationStyle() {
  return texelFetch(classificationStyles, ivec2(int(clamp(classification, 0.0, 255.0)), 0), 0);
}
#endif
`;

/** Moves a point of a hidden class outside the clip volume after gl_Position is set. */
export const classificationVertex = /* glsl */`
#ifdef POTREE_CLASSIFICATION
if (classificationStyle().a < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
#endif
`;

/** Shader defines for whether the geometry has a classification attribute. */
export function classificationDefines(enabled: boolean): Record<string, string | false> {
  return { POTREE_CLASSIFICATION: enabled ? '' : false };
}
