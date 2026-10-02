// Independent one-point data and real WebGL probes for the audit.
import {
  loadPotreeV2,
  PotreeV2PointCloudSet,
  PotreeV2EDL,
  PotreeV2Clipping,
} from '@geemil/potree-v2-three';
import {
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';

async function fixture() {
  const metadata = {
    version: '2.0',
    encoding: 'DEFAULT',
    points: 1,
    spacing: 0.25,
    scale: [1, 1, 1],
    offset: [0, 0, 0],
    boundingBox: { min: [0, 0, 0], max: [8, 8, 8] },
    hierarchy: { firstChunkSize: 22 },
    attributes: [
      { name: 'position', type: 'int32', size: 12, numElements: 3, elementSize: 4 },
      { name: 'classification', type: 'uint8', size: 1, numElements: 1, elementSize: 1 },
    ],
  };
  const hierarchy = new Uint8Array(22);
  const h = new DataView(hierarchy.buffer);
  h.setUint8(0, 1);
  h.setUint32(2, 1, true);
  h.setBigUint64(14, 13n, true);
  const octree = new Uint8Array(13);
  const p = new DataView(octree.buffer);
  p.setInt32(0, 4, true);
  p.setInt32(4, 4, true);
  p.setInt32(8, 4, true);
  octree[12] = 6;
  return loadPotreeV2('https://browser.audit/metadata.json', {
    attributes: ['classification'],
    decoderWorkers: 1,
    material: { colorType: 'solid', color: '#ff0000', size: 10 },
    fetch: async (input, init) => {
      const name = new URL(String(input)).pathname.split('/').at(-1);
      if (name === 'metadata.json') return new Response(JSON.stringify(metadata));
      const bytes = name === 'hierarchy.bin' ? hierarchy : octree;
      const match = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('Range')!);
      return new Response(bytes.slice(Number(match![1]), Number(match![2]) + 1), { status: 206 });
    },
  });
}

export async function probe(logDepth = false) {
  const renderer = new WebGLRenderer({
    preserveDrawingBuffer: true,
    logarithmicDepthBuffer: logDepth,
  });
  renderer.setSize(100, 100, false);
  document.body.append(renderer.domElement);
  const gl = renderer.getContext();
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const environment = {
    version: gl.getParameter(gl.VERSION),
    renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    maxVertexUniforms: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  };
  const shaderErrors: string[] = [];
  renderer.debug.onShaderError = (ctx, _program, vertex, fragment) =>
    shaderErrors.push(`${ctx.getShaderInfoLog(vertex)} ${ctx.getShaderInfoLog(fragment)}`);
  const cloud = await fixture();
  const set = new PotreeV2PointCloudSet();
  set.add(cloud);
  const scene = new Scene();
  scene.add(cloud.group);
  const camera = logDepth
    ? new PerspectiveCamera(60, 1, 0.1, 100)
    : new OrthographicCamera(-4, 4, 4, -4, 0.1, 100);
  camera.position.set(4, 4, 20);
  camera.lookAt(4, 4, 0);
  set.update(camera, 100);
  const edl = new PotreeV2EDL({ strength: 0 });
  const pixel = () => {
    const bytes = new Uint8Array(4);
    gl.readPixels(50, 49, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return [...bytes];
  };
  const draw = () => {
    renderer.render(scene, camera);
    return pixel();
  };
  try {
    const direct = draw();
    const normalPick = await cloud.pick(renderer, camera, 50, 50);
    renderer.setScissor(0, 0, 10, 10);
    renderer.setScissorTest(true);
    // A full clear first ensures no old point is left outside the scissor.
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.setScissorTest(true);
    const scissorPixel = draw();
    const scissorPick = await cloud.pick(renderer, camera, 50, 50);
    const scissorRestored = renderer.getScissorTest();
    renderer.setScissorTest(false);

    // ShaderMaterial exposes colorWrite / visible; picking should agree with rendered points.
    cloud.material.colorWrite = false;
    const colorWritePixel = draw();
    const colorWritePick = await cloud.pick(renderer, camera, 50, 50);
    cloud.material.colorWrite = true;
    cloud.material.visible = false;
    const invisibleMaterialPixel = draw();
    const invisibleMaterialPick = await cloud.pick(renderer, camera, 50, 50);
    cloud.material.visible = true;

    // EDL's normal-object depth composition: independently located planes in front / behind.
    const mesh = new Mesh(new PlaneGeometry(4, 4), new MeshBasicMaterial({ color: '#0000ff' }));
    mesh.position.set(4, 4, 5);
    scene.add(mesh);
    edl.render(renderer, scene, camera, [cloud]);
    const frontMesh = pixel();
    mesh.position.z = 3;
    edl.render(renderer, scene, camera, [cloud]);
    const backMesh = pixel();
    scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();

    // Combined clipping, classification, adaptive and circle, with transformed ancestry.
    const holder = new Group();
    scene.remove(cloud.group);
    scene.add(holder);
    holder.add(cloud.group);
    holder.position.set(-1, 0, 0);
    cloud.group.position.set(1, 0, 0);
    holder.scale.set(-1, 1.2, 1);
    holder.position.set(9, -0.8, 0);
    cloud.group.position.set(1, 0, 0); // local (4,4,4) still maps to (4,4,4).
    const clipping = new PotreeV2Clipping();
    clipping.addBox({
      matrix: new Matrix4().makeScale(2, 2, 2).setPosition(4, 4, 4),
      mode: 'keep-inside',
    });
    clipping.addPlane({ plane: new Plane(new Vector3(0, 0, 1), -3) });
    cloud.clipping = clipping;
    cloud.material.sizeType = 'adaptive';
    cloud.material.shape = 'circle';
    cloud.material.minSize = 10;
    cloud.material.maxSize = 10;
    set.update(camera, 100);
    const combinedPixel = draw();
    const combinedPick = await cloud.pick(renderer, camera, 50, 50);
    cloud.material.classification.setVisible(6, false);
    const hiddenPixel = draw();
    const hiddenPick = await cloud.pick(renderer, camera, 50, 50);
    cloud.material.classification.setVisible(6, true);

    // On the real renderer, inject a failure in the second EDL draw.
    const originalRender = renderer.render.bind(renderer);
    let calls = 0;
    renderer.render = (...args) => {
      if (++calls === 2) throw new Error('audit point pass exception');
      originalRender(...args);
    };
    let exception = '';
    try {
      edl.render(renderer, scene, camera, [cloud]);
    } catch (error) {
      exception = String(error);
    }
    const autoClearAfterException = renderer.autoClear;
    renderer.render = originalRender;
    renderer.autoClear = true;
    return {
      environment,
      logDepth,
      direct,
      normalPick: normalPick?.node ?? null,
      scissorPixel,
      scissorPick: scissorPick?.node ?? null,
      scissorRestored,
      colorWritePixel,
      colorWritePick: colorWritePick?.node ?? null,
      invisibleMaterialPixel,
      invisibleMaterialPick: invisibleMaterialPick?.node ?? null,
      frontMesh,
      backMesh,
      combinedPixel,
      combinedPick: combinedPick?.sourcePosition ?? null,
      hiddenPixel,
      hiddenPick: hiddenPick?.node ?? null,
      exception,
      autoClearAfterException,
      shaderErrors,
      glError: gl.getError(),
    };
  } finally {
    cloud.dispose();
    edl.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }
}
