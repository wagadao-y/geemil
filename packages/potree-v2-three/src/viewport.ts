import type { Vector4, WebGLRenderer } from 'three';

/**
 * Reapply a viewport set with `setViewport()` that `setRenderTarget()` replaced, such as one
 * rounded differently at a fractional pixel ratio, without changing the renderer's `getViewport()`.
 */
export function restoreViewport(renderer: WebGLRenderer, viewport: Vector4, scratch: Vector4): void {
  if (!renderer.getCurrentViewport(scratch).equals(viewport)) renderer.setViewport(renderer.getViewport(scratch));
}
