/**
 * Domain types of the app. The coordinate system is the facility's local frame in meters, Z up;
 * every asset is registered into it when it is uploaded.
 */

export type Vec3 = [number, number, number];

export interface Box {
  min: Vec3;
  max: Vec3;
}

export interface Site {
  id: string;
  name: string;
  address: string;
  /** Label of the local frame shown in the status bar. */
  crs: string;
  /** Latest capture date among the site's assets (ISO date). */
  capturedAt: string;
  thumbnail?: string;
  stats: { nodes: number; annotations: number; panoramas: number };
}

/** Kind of a node in the facility hierarchy; only changes the icon and the default labels. */
export type SpaceKind = 'site' | 'outdoor' | 'building' | 'floor' | 'area';

/** A node of the facility tree. The tree can be any depth. */
export interface SpaceNode {
  id: string;
  siteId: string;
  parentId: string | null;
  kind: SpaceKind;
  name: string;
  /** Order among siblings. */
  order: number;
  /** Extent in the site frame, used to fly to the node and to locate annotations. */
  bounds: Box;
  /** Floors only: the slab elevation, used to cut away the floors above. */
  elevation?: number;
}

export type AssetKind = 'mesh' | 'pointcloud';

/** A 3D dataset attached to a node; hiding the node hides its assets. */
export interface Asset {
  id: string;
  nodeId: string;
  kind: AssetKind;
  name: string;
  source: string;
  capturedAt: string;
  /** URL of metadata.json for point clouds; unset for the demo's procedural mesh. */
  url?: string;
  /** Translation from the asset's own coordinates into the site frame. */
  position: Vec3;
  /** Rotation about Z in degrees. */
  rotationZ: number;
  pointCount?: number;
}

export interface Panorama {
  id: string;
  nodeId: string;
  name: string;
  /** Camera center in the site frame. */
  position: Vec3;
  /** Direction of the image center, in degrees clockwise from +Y. */
  heading: number;
  capturedAt: string;
  /** Equirectangular image; without it the viewer shows the 3D scene from the same spot. */
  imageUrl?: string;
}

export type AnnotationCategory = 'equipment' | 'note' | 'issue';

export interface ExternalLink {
  id: string;
  title: string;
  /** Name of the linked system, such as 設備台帳. */
  system: string;
  url: string;
}

export interface Attachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  url: string;
  uploadedBy: string;
  uploadedAt: string;
}

export interface Comment {
  id: string;
  author: User;
  body: string;
  createdAt: string;
}

export interface User {
  id: string;
  name: string;
  /** Short label for the avatar. */
  initials: string;
  color: string;
}

/** A pin in space carrying comments, links and attachments. */
export interface Annotation {
  id: string;
  siteId: string;
  nodeId: string;
  category: AnnotationCategory;
  /** Identifier in the linked systems, such as an equipment number. */
  code?: string;
  title: string;
  description: string;
  position: Vec3;
  /** Optional box drawn around the subject when selected. */
  extent?: Box;
  links: ExternalLink[];
  attachments: Attachment[];
  comments: Comment[];
  createdBy: User;
  createdAt: string;
  updatedAt: string;
}

export interface CameraState {
  position: Vec3;
  target: Vec3;
}

export interface SavedView {
  id: string;
  siteId: string;
  name: string;
  camera: CameraState;
  hiddenNodeIds: string[];
  floorFilter: string | null;
  thumbnail?: string;
  createdBy: User;
  createdAt: string;
}

export interface SiteBundle {
  site: Site;
  nodes: SpaceNode[];
  assets: Asset[];
  panoramas: Panorama[];
  annotations: Annotation[];
  savedViews: SavedView[];
}
