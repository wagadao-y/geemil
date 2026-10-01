import type { Attachment } from 'svelte/attachments';
import type { Vec3 } from '$lib/types';
import type { Viewer } from './viewer';

/** Keeps the element over a point of the 3D view; reattaches when the arguments change. */
export function anchor(
  viewer: Viewer | null,
  position: Vec3,
  options?: { maxDistance?: number; minDistance?: number },
): Attachment<HTMLElement> {
  return (el) => viewer?.addAnchor(el, position, options);
}
