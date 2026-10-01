import {
  loadPotreeV2,
  PotreeV2EDL,
  PotreeV2PointCloudSet,
  type PotreeV2PointCloud,
} from '@geemil/potree-v2-three';
import {
  BackSide,
  Box3,
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { DemoBuilding } from '$lib/api/demo-data';
import type { Box, CameraState, Panorama, SiteBundle, Vec3 } from '$lib/types';
import { buildSiteModel, type SiteModel } from './site-model';

export interface ViewerVisibility {
  /** Nodes hidden directly or through an ancestor. */
  hidden: ReadonlySet<string>;
  layers: { mesh: boolean; pointcloud: boolean; panorama: boolean; annotation: boolean };
  meshOpacity: number;
  /** Floor node whose building is cut above it, or null. */
  floorFilter: string | null;
}

export type ViewDirection = 'top' | 'front' | 'back' | 'left' | 'right' | 'iso';

export interface FrameInfo {
  camera: PerspectiveCamera;
  width: number;
  height: number;
  /** Meters per CSS pixel at the orbit target. */
  metersPerPixel: number;
  /** Degrees clockwise from +Y (north) of the view direction. */
  heading: number;
  target: Vector3;
}

interface Anchor {
  el: HTMLElement;
  position: Vector3;
  maxDistance: number;
  minDistance: number;
}

interface Flight {
  fromPosition: Vector3;
  fromTarget: Vector3;
  toPosition: Vector3;
  toTarget: Vector3;
  start: number;
  duration: number;
  resolve: () => void;
}

const UP = new Vector3(0, 0, 1);
/**
 * Layer of the transparent objects drawn after the point clouds. EDL composites the clouds last
 * and a transparent object writes no depth, so drawn before, it would not tint the points behind.
 */
const OVERLAY_LAYER = 1;
const DEFAULT_FOV = 50;

function vec(v: Vec3): Vector3 {
  return new Vector3(v[0], v[1], v[2]);
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function isShown(object: Object3D): boolean {
  for (let o: Object3D | null = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

export class Viewer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(DEFAULT_FOV, 1, 0.1, 4000);
  readonly controls: OrbitControls;
  private readonly clouds = new PotreeV2PointCloudSet({ pointBudget: 3_000_000 });
  private readonly edl = new PotreeV2EDL({ strength: 0.6, radius: 1.4 });
  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly frameListeners = new Set<(info: FrameInfo) => void>();
  private readonly anchors = new Set<Anchor>();
  private readonly cloudsByAsset = new Map<string, PotreeV2PointCloud>();
  private readonly assetNode = new Map<string, string>();
  private readonly highlight = new Group();
  private readonly measure = new Group();
  private model: SiteModel | null = null;
  private buildings: DemoBuilding[] = [];
  private nodeParent = new Map<string, string | null>();
  private floorElevation = new Map<string, number>();
  private outdoorNodeId: string | null = null;
  private flight: Flight | null = null;
  private needsRender = true;
  private frameHandle = 0;
  private disposed = false;
  private panoSphere: Mesh | null = null;
  private beforePanorama: CameraState | null = null;
  private visibility: ViewerVisibility | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.domElement.classList.add('viewer-canvas');
    container.appendChild(this.renderer.domElement);

    this.scene.background = new Color('#12171c');
    this.camera.up.copy(UP);
    this.camera.position.set(-95, -150, 110);

    const sky = new HemisphereLight(0xe4ecf2, 0x30353a, 1.7);
    sky.layers.enable(OVERLAY_LAYER);
    this.scene.add(sky);
    const sun = new DirectionalLight(0xfff4e6, 2.4);
    sun.position.set(-70, -110, 160);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    Object.assign(sun.shadow.camera, { left: -140, right: 140, top: 120, bottom: -120 });
    sun.shadow.camera.far = 500;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    sun.layers.enable(OVERLAY_LAYER);
    this.scene.add(sun);

    this.scene.add(this.highlight, this.measure);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 900;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('change', () => (this.needsRender = true));
    this.controls.addEventListener('start', () => (this.flight = null));

    this.renderer.domElement.addEventListener('wheel', this.onPanoramaWheel, { passive: false });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  // ---------------------------------------------------------------- site

  async setSite(bundle: SiteBundle, buildings: DemoBuilding[]) {
    this.buildings = buildings;
    this.nodeParent = new Map(bundle.nodes.map((n) => [n.id, n.parentId]));
    this.outdoorNodeId = bundle.nodes.find((n) => n.kind === 'outdoor')?.id ?? null;
    this.floorElevation = new Map(
      bundle.nodes.filter((n) => n.kind === 'floor').map((n) => [n.id, n.elevation ?? 0]),
    );
    this.model = buildSiteModel(buildings, bundle.nodes);
    this.scene.add(this.model.outdoor, ...this.model.shells.values());
    // Only the wall faces, whose opacity the slider changes; edges and windows stay in the scene.
    const walls = new Set<unknown>(this.model.shellMaterials);
    for (const shell of this.model.shells.values()) {
      shell.traverse((object) => {
        if (object instanceof Mesh && walls.has(object.material)) {
          object.layers.enable(OVERLAY_LAYER);
        }
      });
    }
    for (const [floorId, interior] of this.model.interiors) {
      interior.userData.nodeId = floorId;
      this.scene.add(interior);
    }
    if (this.visibility) this.applyVisibility(this.visibility);

    await Promise.all(
      bundle.assets
        .filter((asset) => asset.kind === 'pointcloud' && asset.url)
        .map(async (asset) => {
          const cloud = await loadPotreeV2(asset.url!, {
            material: { size: 1.1, sizeType: 'adaptive', shape: 'circle', minSize: 1.5 },
            minNodePixelSize: 60,
          });
          if (this.disposed) {
            cloud.dispose();
            return;
          }
          cloud.group.position.set(...asset.position);
          cloud.group.rotation.z = MathUtils.degToRad(asset.rotationZ);
          this.cloudsByAsset.set(asset.id, cloud);
          this.assetNode.set(asset.id, asset.nodeId);
          this.clouds.add(cloud);
          this.scene.add(cloud.group);
          if (this.visibility) this.applyVisibility(this.visibility);
          this.needsRender = true;
        }),
    );
  }

  /** Floor index of a floor node within its building, for the floor filter. */
  private floorLevel(floorId: string): { buildingId: string; level: number } | null {
    const buildingId = this.nodeParent.get(floorId);
    const building = this.buildings.find((b) => b.nodeId === buildingId);
    const elevation = this.floorElevation.get(floorId);
    if (!building || !buildingId || elevation === undefined) return null;
    return { buildingId, level: Math.max(0, building.levels.indexOf(elevation)) };
  }

  /** True when the floor filter cuts away the floor that contains a node. */
  isCutAway(nodeId: string): boolean {
    const floorFilter = this.visibility?.floorFilter;
    const cut = floorFilter ? this.floorLevel(floorFilter) : null;
    if (!cut) return false;
    for (const floorId of this.floorElevation.keys()) {
      if (this.ancestorIn(nodeId, floorId)) {
        const level = this.floorLevel(floorId);
        return !!level && level.buildingId === cut.buildingId && level.level > cut.level;
      }
    }
    return false;
  }

  private ancestorIn(nodeId: string, id: string): boolean {
    for (let n: string | null | undefined = nodeId; n; n = this.nodeParent.get(n)) {
      if (n === id) return true;
    }
    return false;
  }

  applyVisibility(visibility: ViewerVisibility) {
    this.visibility = visibility;
    const { hidden, layers, meshOpacity, floorFilter } = visibility;
    const cut = floorFilter ? this.floorLevel(floorFilter) : null;
    const model = this.model;
    if (model) {
      const outdoorHidden = !!this.outdoorNodeId && hidden.has(this.outdoorNodeId);
      model.outdoor.visible = layers.mesh && !outdoorHidden;
      for (const material of model.shellMaterials) {
        material.opacity = meshOpacity;
        material.transparent = meshOpacity < 1;
        material.depthWrite = meshOpacity >= 1;
        material.needsUpdate = true;
      }
      for (const [buildingId, shell] of model.shells) {
        shell.visible = layers.mesh && !hidden.has(buildingId);
        for (const band of shell.children) {
          const level = band.userData.level as number;
          band.visible = !(cut && cut.buildingId === buildingId && level > cut.level);
        }
      }
      for (const [floorId, interior] of model.interiors) {
        interior.visible = layers.pointcloud && !hidden.has(floorId) && !this.isCutAway(floorId);
      }
    }
    for (const [assetId, cloud] of this.cloudsByAsset) {
      const nodeId = this.assetNode.get(assetId)!;
      cloud.group.visible = layers.pointcloud && !hidden.has(nodeId) && !this.isCutAway(nodeId);
    }
    this.needsRender = true;
  }

  // ---------------------------------------------------------------- camera

  getCamera(): CameraState {
    const p = this.camera.position;
    const t = this.controls.target;
    const round = (v: number) => Math.round(v * 100) / 100;
    return {
      position: [round(p.x), round(p.y), round(p.z)],
      target: [round(t.x), round(t.y), round(t.z)],
    };
  }

  flyTo(state: CameraState, duration = 700): Promise<void> {
    return this.flyToVectors(vec(state.position), vec(state.target), duration);
  }

  private flyToVectors(position: Vector3, target: Vector3, duration: number): Promise<void> {
    this.flight?.resolve();
    return new Promise((resolve) => {
      this.flight = {
        fromPosition: this.camera.position.clone(),
        fromTarget: this.controls.target.clone(),
        toPosition: position,
        toTarget: target,
        start: performance.now(),
        duration: Math.max(1, duration),
        resolve,
      };
      this.needsRender = true;
    });
  }

  /** Frames a box from the current direction, looking down at least 30°. */
  frameBox(b: Box, duration = 800): Promise<void> {
    const box = new Box3(vec(b.min), vec(b.max));
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const radius = Math.max(size.length() / 2, 4);
    const distance = radius / Math.sin(MathUtils.degToRad(this.camera.fov / 2)) / 1.1;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const elevation = Math.asin(MathUtils.clamp(dir.z, -1, 1));
    const minElevation = MathUtils.degToRad(32);
    if (elevation < minElevation) {
      const horizontal = new Vector3(dir.x, dir.y, 0);
      if (horizontal.lengthSq() < 1e-6) horizontal.set(0, -1, 0);
      horizontal.normalize().multiplyScalar(Math.cos(minElevation));
      dir.set(horizontal.x, horizontal.y, Math.sin(minElevation));
    }
    return this.flyToVectors(center.clone().addScaledVector(dir, distance), center, duration);
  }

  /** Moves the orbit target to a point, keeping the offset. */
  panTo(x: number, y: number, duration = 500) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const target = new Vector3(x, y, this.controls.target.z);
    void this.flyToVectors(target.clone().add(offset), target, duration);
  }

  /** Zooms toward a point without changing the direction. */
  focusPoint(point: Vec3, distance = 12) {
    const target = vec(point);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    void this.flyToVectors(target.clone().addScaledVector(dir, distance), target, 600);
  }

  setView(direction: ViewDirection) {
    const target = this.controls.target.clone();
    const distance = this.camera.position.distanceTo(target);
    const dirs: Record<ViewDirection, Vector3> = {
      top: new Vector3(0, -0.02, 1),
      front: new Vector3(0, -1, 0.12),
      back: new Vector3(0, 1, 0.12),
      left: new Vector3(-1, 0, 0.12),
      right: new Vector3(1, 0, 0.12),
      iso: new Vector3(-0.6, -1, 0.85),
    };
    const dir = dirs[direction].normalize();
    void this.flyToVectors(target.clone().addScaledVector(dir, distance), target, 600);
  }

  zoom(factor: number) {
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target).multiplyScalar(factor);
    void this.flyToVectors(target.clone().add(offset), target.clone(), 250);
  }

  // ---------------------------------------------------------------- panorama

  get inPanorama(): boolean {
    return this.beforePanorama !== null;
  }

  async enterPanorama(pano: Panorama, heading = pano.heading) {
    if (!this.beforePanorama) this.beforePanorama = this.getCamera();
    const position = vec(pano.position);
    const rad = MathUtils.degToRad(heading);
    const target = position.clone().add(new Vector3(Math.sin(rad), Math.cos(rad), -0.02));
    this.controls.enablePan = false;
    this.controls.enableZoom = false;
    this.controls.zoomToCursor = false;
    this.controls.minDistance = 0;
    this.controls.maxPolarAngle = Math.PI;
    this.controls.rotateSpeed = -0.35;
    this.setPanoramaImage(pano.imageUrl, position, heading);
    await this.flyToVectors(position, target, 900);
    // Orbiting a target a few centimeters ahead turns the camera in place.
    const dir = this.controls.target.clone().sub(this.camera.position).normalize();
    this.controls.target.copy(this.camera.position).addScaledVector(dir, 0.01);
    this.controls.update();
  }

  async exitPanorama() {
    const before = this.beforePanorama;
    if (!before) return;
    this.beforePanorama = null;
    this.setPanoramaImage(undefined);
    this.camera.fov = DEFAULT_FOV;
    this.camera.updateProjectionMatrix();
    this.controls.enablePan = true;
    this.controls.enableZoom = true;
    this.controls.zoomToCursor = true;
    this.controls.minDistance = 1.5;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.rotateSpeed = 1;
    const dir = this.controls.target.clone().sub(this.camera.position).normalize();
    this.controls.target.copy(this.camera.position).addScaledVector(dir, 8);
    await this.flyTo(before, 800);
  }

  private setPanoramaImage(url: string | undefined, position?: Vector3, heading = 0) {
    if (this.panoSphere) {
      this.scene.remove(this.panoSphere);
      this.panoSphere.geometry.dispose();
      const material = this.panoSphere.material as MeshBasicMaterial;
      material.map?.dispose();
      material.dispose();
      this.panoSphere = null;
    }
    if (!url || !position) return;
    const texture = new TextureLoader().load(url, () => (this.needsRender = true));
    texture.colorSpace = SRGBColorSpace;
    const sphere = new Mesh(
      new SphereGeometry(50, 64, 32),
      new MeshBasicMaterial({ map: texture, side: BackSide, depthTest: false, depthWrite: false }),
    );
    sphere.rotation.x = Math.PI / 2;
    sphere.rotation.y = MathUtils.degToRad(-heading);
    sphere.position.copy(position);
    sphere.renderOrder = -1;
    this.panoSphere = sphere;
    this.scene.add(sphere);
  }

  private onPanoramaWheel = (event: WheelEvent) => {
    if (!this.inPanorama) return;
    event.preventDefault();
    this.camera.fov = MathUtils.clamp(this.camera.fov + event.deltaY * 0.04, 25, 95);
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  };

  // ---------------------------------------------------------------- overlays

  setHighlight(b: Box | null) {
    for (const child of [...this.highlight.children]) {
      this.highlight.remove(child);
      (child as Mesh).geometry.dispose();
    }
    if (b) {
      const size = new Vector3(...b.max).sub(vec(b.min));
      const center = vec(b.min).addScaledVector(size, 0.5);
      const geometry = new BoxGeometry(size.x, size.y, size.z);
      const fill = new Mesh(
        geometry,
        new MeshBasicMaterial({
          color: 0x14b8a6,
          transparent: true,
          opacity: 0.16,
          depthWrite: false,
        }),
      );
      const edges = new LineSegments(
        new EdgesGeometry(geometry),
        new LineBasicMaterial({ color: 0x5eead4, depthTest: false, transparent: true }),
      );
      fill.position.copy(center);
      edges.position.copy(center);
      edges.renderOrder = 10;
      fill.layers.set(OVERLAY_LAYER);
      edges.layers.set(OVERLAY_LAYER);
      this.highlight.add(fill, edges);
    }
    this.needsRender = true;
  }

  setMeasure(points: Vec3[]) {
    for (const child of [...this.measure.children]) {
      this.measure.remove(child);
      (child as Line).geometry.dispose();
    }
    if (points.length >= 2) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(points.flat(), 3));
      const line = new Line(
        geometry,
        new LineBasicMaterial({ color: 0xfbbf24, depthTest: false, transparent: true }),
      );
      line.renderOrder = 11;
      line.layers.set(OVERLAY_LAYER);
      this.measure.add(line);
    }
    this.needsRender = true;
  }

  /** Keeps an element over a 3D point. Returns the function that stops it. */
  addAnchor(
    el: HTMLElement,
    position: Vec3,
    options: { maxDistance?: number; minDistance?: number } = {},
  ): () => void {
    const anchor: Anchor = {
      el,
      position: vec(position),
      maxDistance: options.maxDistance ?? Infinity,
      minDistance: options.minDistance ?? 0,
    };
    this.anchors.add(anchor);
    this.placeAnchor(anchor, this.container.clientWidth, this.container.clientHeight);
    return () => this.anchors.delete(anchor);
  }

  private readonly projected = new Vector3();

  private placeAnchor(anchor: Anchor, width: number, height: number) {
    const p = this.projected.copy(anchor.position).project(this.camera);
    const distance = this.camera.position.distanceTo(anchor.position);
    const visible =
      p.z < 1 &&
      p.z > -1 &&
      distance <= anchor.maxDistance &&
      distance >= anchor.minDistance &&
      Math.abs(p.x) < 1.2 &&
      Math.abs(p.y) < 1.2;
    anchor.el.style.visibility = visible ? 'visible' : 'hidden';
    if (!visible) return;
    const x = ((p.x + 1) / 2) * width;
    const y = ((1 - p.y) / 2) * height;
    anchor.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    anchor.el.style.zIndex = String(Math.round(10000 - distance));
  }

  onFrame(listener: (info: FrameInfo) => void): () => void {
    this.frameListeners.add(listener);
    this.needsRender = true;
    return () => this.frameListeners.delete(listener);
  }

  requestRender() {
    this.needsRender = true;
  }

  // ---------------------------------------------------------------- picking

  /** The nearest point of a cloud or a mesh under a canvas position, in the site frame. */
  async pick(x: number, y: number): Promise<Vec3 | null> {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const ndc = new Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1);
    const raycaster = new Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    const targets: Object3D[] = [];
    if (this.model) {
      targets.push(this.model.outdoor, ...this.model.interiors.values());
      if ((this.visibility?.meshOpacity ?? 1) >= 0.5) targets.push(...this.model.shells.values());
    }
    const meshHit = raycaster
      .intersectObjects(targets, true)
      .find((hit) => hit.object instanceof Mesh && isShown(hit.object));

    let cloudHit: Vector3 | null = null;
    if (this.clouds.clouds.length > 0) {
      const hit = await this.clouds.pick(this.renderer, this.camera, x, y, { radius: 4 });
      cloudHit = hit?.position ?? null;
    }
    const camera = this.camera.position;
    const candidates = [meshHit?.point, cloudHit].filter((p): p is Vector3 => !!p);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.distanceTo(camera) - b.distanceTo(camera));
    const p = candidates[0];
    const round = (v: number) => Math.round(v * 1000) / 1000;
    return [round(p.x), round(p.y), round(p.z)];
  }

  /** Captures the current view as a small JPEG data URL. */
  thumbnail(width = 320): string {
    const source = this.renderer.domElement;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.round((width * source.height) / source.width);
    canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.78);
  }

  // ---------------------------------------------------------------- loop

  private resize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  private loop = () => {
    if (this.disposed) return;
    this.frameHandle = requestAnimationFrame(this.loop);
    if (this.flight) {
      const f = this.flight;
      const t = Math.min(1, (performance.now() - f.start) / f.duration);
      const k = easeInOut(t);
      this.camera.position.lerpVectors(f.fromPosition, f.toPosition, k);
      this.controls.target.lerpVectors(f.fromTarget, f.toTarget, k);
      this.needsRender = true;
      if (t >= 1) {
        this.flight = null;
        f.resolve();
      }
    }
    if (this.controls.update()) this.needsRender = true;
    const height = this.container.clientHeight;
    if (this.clouds.update(this.camera, height)) this.needsRender = true;
    if (!this.needsRender) return;
    this.needsRender = false;
    this.render();
    this.emitFrame();
  };

  /**
   * Draws the scene, then the overlay layer over the composited clouds. Transparent shells stay
   * in the first pass without color, so they still cast shadows.
   */
  private render() {
    const { renderer, camera, scene } = this;
    const shellMaterials = this.model?.shellMaterials ?? [];
    const transparentShells = (this.visibility?.meshOpacity ?? 1) < 1;
    if (transparentShells) for (const material of shellMaterials) material.colorWrite = false;
    camera.layers.set(0);
    if (this.clouds.clouds.length > 0) {
      this.edl.render(renderer, scene, camera, this.clouds.clouds);
    } else {
      renderer.render(scene, camera);
    }
    if (transparentShells) for (const material of shellMaterials) material.colorWrite = true;

    // Opaque shells were drawn in the first pass; only transparent ones belong to the overlay.
    const shells = [...(this.model?.shells.values() ?? [])];
    const shellVisible = shells.map((shell) => shell.visible);
    if (!transparentShells) for (const shell of shells) shell.visible = false;
    // A color background clears the canvas even without autoClear.
    const { autoClear } = renderer;
    const { background } = scene;
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    scene.background = null;
    camera.layers.set(OVERLAY_LAYER);
    renderer.render(scene, camera);
    camera.layers.set(0);
    scene.background = background;
    renderer.shadowMap.autoUpdate = true;
    renderer.autoClear = autoClear;
    shells.forEach((shell, i) => (shell.visible = shellVisible[i]));
  }

  private emitFrame() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    for (const anchor of this.anchors) this.placeAnchor(anchor, width, height);
    if (this.frameListeners.size === 0) return;
    const target = this.controls.target;
    const distance = this.camera.position.distanceTo(target);
    const metersPerPixel =
      (2 * distance * Math.tan(MathUtils.degToRad(this.camera.fov / 2))) / height;
    const dir = this.camera.getWorldDirection(new Vector3());
    const heading = (MathUtils.radToDeg(Math.atan2(dir.x, dir.y)) + 360) % 360;
    const info: FrameInfo = { camera: this.camera, width, height, metersPerPixel, heading, target };
    for (const listener of this.frameListeners) listener(info);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('wheel', this.onPanoramaWheel);
    this.controls.dispose();
    for (const cloud of this.cloudsByAsset.values()) cloud.dispose();
    this.model?.dispose();
    this.setPanoramaImage(undefined);
    this.edl.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
