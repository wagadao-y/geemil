import test from 'node:test';
import assert from 'node:assert/strict';
import { Color } from 'three';
import { GRADIENT_SIZE, PotreeV2Classification, PotreeV2Gradients, sampleGradient } from '../dist/point-color.js';
import { PotreeV2PointMaterial } from '../dist/material.js';
import { VisibleNodesTexture } from '../dist/point-size.js';

const texel = (data, i) => Array.from(data.slice(i * 4, i * 4 + 4));

test('gradients interpolate between stops in sRGB and hold the end colors', () => {
  const data = sampleGradient([[0.25, '#000000'], [0.75, '#ff0080']]);
  assert.equal(data.length, GRADIENT_SIZE * 4);
  assert.deepEqual(texel(data, 0), [0, 0, 0, 255]);
  assert.deepEqual(texel(data, GRADIENT_SIZE - 1), [255, 0, 128, 255]);
  // The centre texel is halfway between the stops.
  const middle = texel(data, Math.round((GRADIENT_SIZE - 1) / 2));
  assert.ok(Math.abs(middle[0] - 128) <= 1 && Math.abs(middle[2] - 64) <= 1, `${middle}`);
  // Stops may be given in any order.
  assert.deepEqual(sampleGradient([[1, '#ffffff'], [0, '#000000']]), sampleGradient(PotreeV2Gradients.GRAYSCALE));
  assert.deepEqual(texel(sampleGradient(PotreeV2Gradients.SPECTRAL), 0), [0x5e, 0x4f, 0xa2, 255]);
  assert.throws(() => sampleGradient([]));
  assert.throws(() => sampleGradient([[1.5, '#ffffff']]));
});

test('a classification scheme starts with Potree colors and stores sRGB bytes and visibility', () => {
  const scheme = new PotreeV2Classification({ 6: { color: '#102030' }, 7: { visible: false } });
  const data = scheme.texture.image.data;
  assert.deepEqual(texel(data, 2), [0xa1, 0x52, 0x2e, 255]);
  assert.deepEqual(texel(data, 6), [0x10, 0x20, 0x30, 255]);
  assert.deepEqual(texel(data, 7).slice(3), [0]);
  assert.deepEqual(texel(data, 200), [0x4d, 0x99, 0x99, 255]);
  assert.equal(scheme.isVisible(7), false);
  assert.equal(scheme.getColor(6).getHexString(), new Color('#102030').getHexString());
  scheme.setVisible(7, true);
  assert.equal(scheme.isVisible(7), true);
  assert.throws(() => scheme.setColor(256, '#ffffff'));
  assert.throws(() => scheme.setVisible(1.5, false));
  scheme.reset();
  assert.deepEqual(texel(data, 6), [0xff, 0xa8, 0x00, 255]);
  scheme.dispose();
});

function material(options = {}) {
  return new PotreeV2PointMaterial({
    size: 2, shape: 'square', sizeType: 'fixed', minSize: 2, maxSize: 50, spacing: 1,
    visibleNodes: new VisibleNodesTexture(), attributes: ['position'], colorType: 'elevation',
    sourceOriginZ: 100, elevationRange: [100, 110], intensityRange: [0, 65535],
    gradient: PotreeV2Gradients.SPECTRAL, ...options,
  });
}

test('color types need their decoded attribute', () => {
  assert.throws(() => material({ colorType: 'intensity' }), /intensity/);
  const m = material({ attributes: ['position', 'rgb', 'classification'] });
  assert.equal(m.defines.POINT_COLOR_ELEVATION, '');
  assert.equal(m.defines.POTREE_CLASSIFICATION, '');
  m.colorType = 'classification';
  assert.equal(m.defines.POINT_COLOR_ELEVATION, false);
  assert.equal(m.defines.POINT_COLOR_CLASSIFICATION, '');
  assert.throws(() => { m.colorType = 'intensity'; });
  assert.equal(m.colorType, 'classification');
  assert.equal(material().defines.POTREE_CLASSIFICATION, false);
  m.dispose();
});

test('elevation uniforms map metadata z onto the range per node', () => {
  const m = material();
  const node = { name: 'r0', level: 1, box: { min: { x: 0, y: 0, z: 4 }, max: { x: 1, y: 1, z: 5 } }, children: [] };
  m.setNode(node, { planes: [], keep: null, hide: [], hidden: false }, node.box.min);
  // A node-local z of 0 is metadata z 104, 40 % of the range.
  assert.equal(m.uniforms.elevationOffset.value, 4);
  m.onBeforeRender({ getCurrentViewport: target => target.set(0, 0, 100, 100), getPixelRatio: () => 1 });
  assert.equal(m.uniforms.elevationScale.value, 0.1);
  assert.equal((0 + m.uniforms.elevationOffset.value) * m.uniforms.elevationScale.value, 0.4);
  m.dispose();
});
