import test from 'node:test';
import assert from 'node:assert/strict';
import { Color, Group, Mesh, PerspectiveCamera, Scene, Vector4 } from 'three';
import { PotreeV2EDL } from '../dist/edl.js';

/** Records what each render call would draw, without WebGL. */
function mockRenderer() {
  const calls = [];
  let target = null;
  const viewport = new Vector4(0, 0, 640, 480);
  const cssViewport = new Vector4(0, 0, 320, 240);
  const visibleNames = (root) => {
    const names = [];
    root.traverseVisible((object) => {
      if (object.name) names.push(object.name);
    });
    return names;
  };
  const renderer = {
    autoClear: true,
    capabilities: { logarithmicDepthBuffer: false },
    getRenderTarget: () => target,
    setRenderTarget: (value) => {
      target = value;
      viewport.copy(value?.viewport ?? cssViewport.clone().multiplyScalar(2));
    },
    getCurrentViewport: (value) => value.copy(viewport),
    getViewport: (value) => value.copy(cssViewport),
    setViewport: (value) => {
      cssViewport.copy(value);
      viewport.copy(value).multiplyScalar(2);
    },
    getDrawingBufferSize: (size) => size.set(640, 480),
    getPixelRatio: () => 2,
    getClearColor: (color) => color.set(0x123456),
    getClearAlpha: () => 0.5,
    setClearColor: () => {},
    clear: () => {},
    render: (scene, camera) => {
      calls.push({
        target: target ? 'edl' : 'screen',
        drawn: visibleNames(scene),
        background: scene.background ?? null,
        autoClear: renderer.autoClear,
        camera,
        viewport: viewport.clone(),
      });
    },
  };
  return { renderer, calls };
}

function named(object, name) {
  object.name = name;
  return object;
}

test('EDL draws the scene without clouds, then the clouds alone, then the composite', () => {
  const scene = named(new Scene(), 'scene');
  scene.background = new Color(0x202020);
  const holder = named(new Group(), 'holder');
  const cloudGroup = named(new Group(), 'cloud');
  cloudGroup.add(named(new Mesh(), 'node'));
  holder.add(cloudGroup, named(new Mesh(), 'sibling'));
  const hiddenMesh = named(new Mesh(), 'hidden');
  hiddenMesh.visible = false;
  scene.add(holder, named(new Mesh(), 'other'), hiddenMesh);
  const camera = new PerspectiveCamera();

  const { renderer, calls } = mockRenderer();
  const edl = new PotreeV2EDL();
  edl.render(renderer, scene, camera, [{ group: cloudGroup }]);

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].drawn, ['scene', 'holder', 'sibling', 'other']);
  assert.equal(calls[0].target, 'screen');
  assert.equal(calls[0].background, scene.background);
  assert.equal(calls[0].autoClear, true);

  assert.deepEqual(calls[1].drawn, ['scene', 'holder', 'cloud', 'node']);
  assert.equal(calls[1].target, 'edl');
  assert.equal(calls[1].background, null);
  assert.equal(calls[1].autoClear, false);

  assert.equal(calls[2].target, 'screen');
  assert.equal(calls[2].autoClear, false);

  // Everything is restored.
  assert.equal(renderer.autoClear, true);
  assert.equal(renderer.getRenderTarget(), null);
  assert.ok(scene.background instanceof Color);
  const visible = [];
  scene.traverseVisible((object) => visible.push(object.name));
  assert.deepEqual(visible, ['scene', 'holder', 'cloud', 'node', 'sibling', 'other']);
  assert.equal(hiddenMesh.visible, false);
  edl.dispose();
});

test('EDL without visible clouds renders the scene once', () => {
  const scene = new Scene();
  const cloudGroup = new Group();
  cloudGroup.visible = false;
  scene.add(cloudGroup);
  const { renderer, calls } = mockRenderer();
  const edl = new PotreeV2EDL();
  edl.render(renderer, scene, new PerspectiveCamera(), [{ group: cloudGroup }]);
  assert.equal(calls.length, 1);
  assert.equal(cloudGroup.visible, false);
  edl.dispose();
});

test('EDL sizes its target to the current viewport and restores it before compositing', () => {
  const scene = new Scene();
  const group = new Group();
  scene.add(group);
  const { renderer, calls } = mockRenderer();
  renderer.setViewport(new Vector4(40, 20, 150, 100));
  const original = renderer.getCurrentViewport(new Vector4());
  const edl = new PotreeV2EDL();
  edl.render(renderer, scene, new PerspectiveCamera(), [{ group }]);
  assert.deepEqual(
    calls.map((call) => call.viewport.toArray()),
    [original.toArray(), [0, 0, 300, 200], original.toArray()],
  );
  assert.deepEqual(edl.material.uniforms.resolution.value.toArray(), [300, 200]);
  assert.deepEqual(renderer.getCurrentViewport(new Vector4()), original);
  edl.dispose();
});
