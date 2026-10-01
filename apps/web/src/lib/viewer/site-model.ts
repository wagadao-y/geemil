import {
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  type Material,
  type Object3D,
} from 'three';
import type { DemoBuilding } from '$lib/api/demo-data';
import type { SpaceNode } from '$lib/types';

/**
 * Stand-in for the drone photogrammetry mesh of the demo site, built from boxes and cylinders.
 * Real sites load a glTF/3D Tiles mesh instead; the viewer only relies on the groups below.
 */
export interface SiteModel {
  /** Ground, roads, tanks and racks: the outdoor mesh of the `outdoor` node. */
  outdoor: Group;
  /** Exterior shells of the buildings, by building node; one child group per level band. */
  shells: Map<string, Group>;
  /** Floor slabs and columns, by floor node; drawn with the indoor data. */
  interiors: Map<string, Group>;
  /** Materials whose opacity follows the outdoor mesh opacity. */
  shellMaterials: MeshStandardMaterial[];
  dispose(): void;
}

const EDGE = new LineBasicMaterial({ color: 0x1b2026, transparent: true, opacity: 0.35 });

function solid(color: string, options: Partial<MeshStandardMaterial> = {}) {
  return new MeshStandardMaterial({
    color: new Color(color),
    roughness: 0.92,
    metalness: 0.02,
    ...options,
  });
}

function box(
  sx: number,
  sy: number,
  sz: number,
  x: number,
  y: number,
  z: number,
  material: Material,
  edges = true,
): Object3D {
  const mesh = new Mesh(new BoxGeometry(sx, sy, sz), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (edges) mesh.add(new LineSegments(new EdgesGeometry(mesh.geometry), EDGE));
  return mesh;
}

function cylinder(
  r: number,
  h: number,
  x: number,
  y: number,
  z: number,
  material: Material,
  segments = 32,
): Mesh {
  const mesh = new Mesh(new CylinderGeometry(r, r, h, segments), material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(x, y, z + h / 2);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildOutdoor(materials: Material[]): Group {
  const group = new Group();
  group.name = 'outdoor';
  const water = solid('#0e1a24', { roughness: 0.35, metalness: 0.1 });
  const land = solid('#3a3f3c');
  const asphalt = solid('#24282b');
  const concrete = solid('#7d817f');
  const grass = solid('#3d4a35');
  const tank = solid('#d9dcdc', { roughness: 0.6, metalness: 0.2 });
  const steel = solid('#8a9399', { roughness: 0.5, metalness: 0.4 });
  const marking = solid('#c9b458', { roughness: 0.8 });
  const revetment = solid('#56595a');
  materials.push(water, land, asphalt, concrete, grass, tank, steel, marking, revetment);

  const sea = new Mesh(new PlaneGeometry(900, 900), water);
  sea.position.z = -2.2;
  sea.receiveShadow = true;
  group.add(sea);

  group.add(box(224, 164, 2, 0, 0, -1, revetment, false));
  const ground = box(216, 156, 0.2, 0, 0, 0.0, land, false);
  group.add(ground);

  // Ring road and site roads.
  for (const [sx, sy, x, y] of [
    [196, 8, 0, -64],
    [196, 8, 0, 64],
    [8, 136, -96, 0],
    [8, 136, 96, 0],
    [180, 7, 0, -16],
    [7, 120, -32, 0],
    [7, 120, 52, 4],
  ]) {
    group.add(box(sx, sy, 0.1, x, y, 0.12, asphalt, false));
  }
  for (let x = -92; x <= 92; x += 8) {
    group.add(box(3, 0.25, 0.02, x, -64, 0.18, marking, false));
    group.add(box(3, 0.25, 0.02, x, 64, 0.18, marking, false));
  }

  // Parking in front of the admin building.
  group.add(box(34, 22, 0.1, -66, -6, 0.13, asphalt, false));
  for (let x = -81; x <= -51; x += 3) group.add(box(0.15, 5, 0.02, x, -1, 0.19, concrete, false));

  // Green strips.
  for (const [sx, sy, x, y] of [
    [40, 10, -66, -54],
    [30, 14, 76, 40],
    [24, 10, 10, 50],
  ]) {
    group.add(box(sx, sy, 0.3, x, y, 0.15, grass, false));
  }

  // Fuel tanks with a dike.
  group.add(box(52, 36, 0.2, -66, 44, 0.15, concrete, false));
  for (const [x, y] of [
    [-76, 40],
    [-56, 48],
  ]) {
    group.add(cylinder(8, 12, x, y, 0.2, tank, 48));
    const top = new Mesh(new CircleGeometry(8, 48), steel);
    top.position.set(x, y, 12.25);
    group.add(top);
  }

  // Pipe rack between the buildings.
  for (let x = -44; x <= 50; x += 6) {
    group.add(box(0.4, 0.4, 6, x, -14, 3, steel, false));
    group.add(box(0.4, 0.4, 6, x, -18, 3, steel, false));
    group.add(box(0.3, 4.4, 0.3, x, -16, 6, steel, false));
  }
  for (const [y, z, r] of [
    [-15, 6.5, 0.35],
    [-16, 6.5, 0.3],
    [-17, 6.5, 0.45],
  ]) {
    const pipe = new Mesh(new CylinderGeometry(r, r, 96, 12), steel);
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(3, y, z);
    pipe.castShadow = true;
    group.add(pipe);
  }

  // Transformers and sheds.
  for (const [sx, sy, sz, x, y] of [
    [8, 5, 4, 62, 4],
    [8, 5, 4, 62, 14],
    [6, 10, 3.5, -88, 20],
    [10, 6, 3, 30, 52],
    [6, 4, 3, 84, -6],
  ]) {
    group.add(box(sx, sy, sz, x, y, sz / 2, concrete));
  }

  // Stack of the utility building.
  group.add(cylinder(1.6, 42, 86, -30, 0, steel));

  return group;
}

/** Splits a building's walls into one group per level band so floors above can be cut away. */
function buildShell(building: DemoBuilding, material: MeshStandardMaterial): Group {
  const shell = new Group();
  shell.name = `shell:${building.nodeId}`;
  const [x0, y0] = building.min;
  const [x1, y1] = building.max;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const w = x1 - x0;
  const d = y1 - y0;
  const t = 0.5;
  const { levels } = building;
  const windowMaterial = solid('#2a3138', { roughness: 0.3, metalness: 0.3 });
  windowMaterial.transparent = true;
  for (let i = 0; i < levels.length - 1; i++) {
    const band = new Group();
    band.name = `band:${i}`;
    band.userData.level = i;
    const z0 = levels[i];
    const h = levels[i + 1] - z0;
    const zc = z0 + h / 2;
    band.add(box(w, t, h, cx, y0 + t / 2, zc, material));
    band.add(box(w, t, h, cx, y1 - t / 2, zc, material));
    band.add(box(t, d - 2 * t, h, x0 + t / 2, cy, zc, material));
    band.add(box(t, d - 2 * t, h, x1 - t / 2, cy, zc, material));
    // Window strips on the long sides.
    const wz = z0 + h * 0.62;
    band.add(box(w * 0.86, 0.1, h * 0.22, cx, y0 - 0.02, wz, windowMaterial, false));
    band.add(box(w * 0.86, 0.1, h * 0.22, cx, y1 + 0.02, wz, windowMaterial, false));
    shell.add(band);
  }
  const roof = new Group();
  roof.name = 'roof';
  roof.userData.level = levels.length - 1;
  const top = levels[levels.length - 1];
  roof.add(box(w, d, 0.6, cx, cy, top + 0.3, material));
  roof.add(box(w + 0.6, 0.6, 1.2, cx, y0, top + 0.6, material));
  roof.add(box(w + 0.6, 0.6, 1.2, cx, y1, top + 0.6, material));
  // Rooftop equipment.
  const unit = solid('#9aa0a2');
  for (let i = 0; i < Math.floor(w / 14); i++) {
    roof.add(box(4, 3, 2, x0 + 7 + i * 14, cy + d * 0.2, top + 1.6, unit));
  }
  shell.add(roof);
  return shell;
}

function buildInterior(floor: SpaceNode, building: DemoBuilding): Group {
  const group = new Group();
  group.name = `interior:${floor.id}`;
  const slab = solid('#8d9296');
  const column = solid('#a7abad');
  const [x0, y0] = building.min;
  const [x1, y1] = building.max;
  const z = floor.elevation ?? floor.bounds.min[2];
  const top = floor.bounds.max[2];
  group.add(box(x1 - x0 - 1, y1 - y0 - 1, 0.3, (x0 + x1) / 2, (y0 + y1) / 2, z + 0.05, slab));
  for (let x = x0 + 8; x < x1 - 2; x += 8) {
    for (let y = y0 + 8; y < y1 - 2; y += 8) {
      group.add(box(0.7, 0.7, top - z, x, y, z + (top - z) / 2, column, false));
    }
  }
  return group;
}

export function buildSiteModel(buildings: DemoBuilding[], nodes: SpaceNode[]): SiteModel {
  const materials: Material[] = [];
  const outdoor = buildOutdoor(materials);
  const shells = new Map<string, Group>();
  const interiors = new Map<string, Group>();
  const shellMaterials: MeshStandardMaterial[] = [];

  for (const building of buildings) {
    const material = solid(building.color);
    shellMaterials.push(material);
    shells.set(building.nodeId, buildShell(building, material));
    for (const floor of nodes.filter((n) => n.parentId === building.nodeId && n.kind === 'floor')) {
      interiors.set(floor.id, buildInterior(floor, building));
    }
  }

  return {
    outdoor,
    shells,
    interiors,
    shellMaterials,
    dispose() {
      const roots: Object3D[] = [outdoor, ...shells.values(), ...interiors.values()];
      for (const root of roots) {
        root.traverse((object) => {
          if (object instanceof Mesh || object instanceof LineSegments) {
            (object.geometry as BufferGeometry).dispose();
            const material = object.material as Material;
            if (material !== EDGE) material.dispose();
          }
        });
      }
    },
  };
}
