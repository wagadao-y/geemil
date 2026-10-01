import { BufferAttribute, BufferGeometry, Sphere } from 'three';
import type { Box3 } from 'three';
import { decodeNodeData, DEFAULT_DECODED_ATTRIBUTES, nodeOrigin } from './decode.js';
import type { DecodedNodeData } from './decode.js';
import type { OctreeNode, PotreeV2Metadata } from './format.js';

/**
 * Build the Three.js geometry on the render thread without copying decoded arrays.
 * Positions are relative to `box.min`, so the geometry's bounds are too.
 */
export function createNodeGeometry(attributes: DecodedNodeData, box: Box3): BufferGeometry {
  const geometry = new BufferGeometry();
  for (const [name, attribute] of Object.entries(attributes)) {
    geometry.setAttribute(name, new BufferAttribute(attribute.array, attribute.itemSize, attribute.normalized));
  }
  geometry.boundingBox = box.clone().translate(box.min.clone().negate());
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());
  return geometry;
}

/** Decode one node locally, useful when Web Workers are unavailable. Positions are relative to `node.box.min`. */
export async function decodeNode(
  bytes: ArrayBuffer, node: OctreeNode, metadata: PotreeV2Metadata,
  attributeNames: readonly string[] = DEFAULT_DECODED_ATTRIBUTES,
): Promise<BufferGeometry> {
  const attributes = await decodeNodeData(
    bytes, node.name, node.numPoints, metadata, undefined, attributeNames, nodeOrigin(node),
  );
  return createNodeGeometry(attributes, node.box);
}
