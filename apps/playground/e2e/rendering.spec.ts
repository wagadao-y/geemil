import { expect, test, type Page } from '@playwright/test';
import { CLASS_BANDS } from './global-setup';
import type { Capture, ColorSettings, Harness } from './harness';

/** The 2000-point pump sample's two PotreeConverter outputs, copied by global-setup.ts. */
const BROTLI = '/e2e/data/pump-brotli/metadata.json';
const DEFAULT = '/e2e/data/pump-default/metadata.json';
/** DEFAULT with the classes of CLASS_BANDS by x, also written by global-setup.ts. */
const CLASSES = '/e2e/data/pump-classes/metadata.json';
/** Three flat points, with red and blue siblings on either side of their x boundary. */
const FLAT_SIBLINGS = '/e2e/data/flat-siblings/metadata.json';
const COLOR_ATTRIBUTES = ['rgb', 'intensity', 'classification'];
/** Potree's colors of the classes in CLASS_BANDS; 200 has none, so it takes the default. */
const CLASS_COLORS: Record<number, string> = {
  2: '#a1522e',
  3: '#00ff00',
  6: '#ffa800',
  9: '#0000ff',
  200: '#4d9999',
};

declare const window: { harness: Harness };

async function open(page: Page): Promise<void> {
  // Report why the harness failed to start, such as a WebGL context that could not be created.
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.goto('/e2e/harness.html');
  await page
    .waitForFunction(() => 'harness' in window, undefined, { timeout: 15_000 })
    .catch((error) => {
      throw new Error(`The harness did not start: ${pageErrors.join(' / ') || error}`);
    });
}

const load = (page: Page, url: string, options: Parameters<Harness['load']>[1] = {}) =>
  page.evaluate(([url, options]) => window.harness.load(url, options), [url, options] as const);
const setColor = (page: Page, settings: ColorSettings) =>
  page.evaluate((settings) => window.harness.setColor(settings), settings);
const capture = (page: Page): Promise<Capture> => page.evaluate(() => window.harness.capture());
const pick = (page: Page) => page.evaluate(() => window.harness.pick());
const palette = (page: Page) => page.evaluate(() => window.harness.palette());
const setClassVisible = (page: Page, code: number, visible: boolean) =>
  page.evaluate(([code, visible]) => window.harness.setClassVisible(code, visible), [
    code,
    visible,
  ] as const);

/** Classes of the points picked over a grid across the view. */
async function pickedClasses(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const classes: number[] = [];
    for (let y = 0.1; y < 1; y += 0.1) {
      for (let x = 0.1; x < 1; x += 0.1) {
        const hit = await window.harness.pick(x, y);
        if (hit) classes.push(hit.attributes.classification![0]!);
      }
    }
    return classes;
  });
}

const sorted = (values: Iterable<string>) => [...values].sort();

test.beforeEach(async ({ page }) => {
  await open(page);
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.harness.errors())).toEqual({
    shaderErrors: [],
    glError: 0,
  });
});

test('every color type compiles and draws its colors', async ({ page }) => {
  const loaded = await load(page, BROTLI, { attributes: COLOR_ATTRIBUTES });
  expect(loaded.attributes).toEqual(['position', ...COLOR_ATTRIBUTES]);
  expect(loaded.colorType).toBe('rgb');

  const images: Record<string, Capture> = {};
  for (const type of ['rgb', 'elevation', 'intensity', 'classification'] as const) {
    await setColor(page, { type });
    images[type] = await capture(page);
    expect(images[type].drawn, type).toBeGreaterThan(1000);
  }
  // The sample's classes are all 0, whose default color is #808080; sRGB colors survive exactly.
  expect(images.classification!.mean).toEqual([128, 128, 128]);
  const [r, g, b] = images.intensity!.mean;
  expect(g).toBe(r);
  expect(b).toBe(r);
  expect(new Set(Object.values(images).map((image) => image.digest)).size).toBe(4);

  await setColor(page, { type: 'solid', solid: '#ff0000' });
  expect((await capture(page)).mean).toEqual([255, 0, 0]);

  // A gradient or gamma change redraws the same points differently.
  await setColor(page, { type: 'elevation', gradient: 'VIRIDIS' });
  const viridis = await capture(page);
  expect(viridis.drawn).toBe(images.elevation!.drawn);
  expect(viridis.digest).not.toBe(images.elevation!.digest);
  await setColor(page, { type: 'intensity', intensityGamma: 0.3 });
  expect((await capture(page)).mean[0]).toBeGreaterThan(r);
});

test('the picker keeps no node geometry after a pick', async ({ page }) => {
  await load(page, BROTLI);
  expect(await pick(page)).not.toBeNull();
  expect(await page.evaluate(() => window.harness.pickerGeometries())).toBe(0);
  // Proxies reused by the next pick still draw their nodes.
  expect(await pick(page)).not.toBeNull();
});

test('hidden classes are neither drawn nor picked', async ({ page }) => {
  await load(page, BROTLI, { attributes: COLOR_ATTRIBUTES });
  expect(await pick(page)).not.toBeNull();
  await page.evaluate(() => window.harness.setClassVisible(0, false));
  expect((await capture(page)).drawn).toBe(0);
  expect(await pick(page)).toBeNull();
});

test('each class is drawn in its own color', async ({ page }) => {
  await load(page, CLASSES, { material: { colorType: 'classification' } });
  const counts = await palette(page);
  expect(sorted(Object.keys(counts))).toEqual(
    sorted(CLASS_BANDS.map((code) => CLASS_COLORS[code]!)),
  );
  // The outer bands cover less of the pump, so only require that each is clearly drawn.
  for (const [color, count] of Object.entries(counts)) expect(count, color).toBeGreaterThan(100);
  // Every band is picked with its decoded class.
  expect(sorted(new Set((await pickedClasses(page)).map(String)))).toEqual(
    sorted(CLASS_BANDS.map(String)),
  );
});

test('hiding or recoloring one class changes only that class', async ({ page }) => {
  await load(page, CLASSES, { material: { colorType: 'classification' } });
  const all = CLASS_BANDS.map((code) => CLASS_COLORS[code]!);

  await setClassVisible(page, 6, false);
  expect(sorted(Object.keys(await palette(page)))).toEqual(
    sorted(all.filter((color) => color !== CLASS_COLORS[6])),
  );
  expect(await pickedClasses(page)).not.toContain(6);

  await setClassVisible(page, 6, true);
  await page.evaluate(() => window.harness.setClassColor(3, '#123456'));
  expect(sorted(Object.keys(await palette(page)))).toEqual(
    sorted(all.map((color) => (color === CLASS_COLORS[3] ? '#123456' : color))),
  );
});

test('hidden classes are hidden in every color type', async ({ page }) => {
  await load(page, CLASSES, { attributes: COLOR_ATTRIBUTES });
  for (const type of ['rgb', 'intensity', 'elevation'] as const) {
    await setColor(page, { type });
    for (const code of CLASS_BANDS) await setClassVisible(page, code, true);
    const full = (await capture(page)).drawn;
    // Only the last band stays.
    for (const code of CLASS_BANDS.slice(0, -1)) await setClassVisible(page, code, false);
    const kept = (await capture(page)).drawn;
    expect(kept, type).toBeGreaterThan(0);
    expect(kept, type).toBeLessThan(full / 2);
    const classes = await pickedClasses(page);
    expect(classes.length, type).toBeGreaterThan(0);
    expect(new Set(classes), type).toEqual(new Set([CLASS_BANDS.at(-1)]));
  }
});

test('only position and rgb are decoded by default', async ({ page }) => {
  const loaded = await load(page, BROTLI);
  expect(loaded.attributes).toEqual(['position', 'rgb']);
  await expect(setColor(page, { type: 'intensity' })).rejects.toThrow(
    /needs the decoded attribute 'intensity'/,
  );
  const colored = await load(page, BROTLI, { material: { colorType: 'classification' } });
  expect(colored.attributes).toEqual(['position', 'rgb', 'classification']);
});

test('DEFAULT and BROTLI encodings draw the same pixels', async ({ page }) => {
  const draw = async (url: string) => {
    const loaded = await load(page, url, { attributes: COLOR_ATTRIBUTES });
    const images: string[] = [];
    for (const type of ['rgb', 'intensity', 'elevation'] as const) {
      await setColor(page, { type });
      images.push((await capture(page)).digest);
    }
    // PotreeConverter orders a node's points differently in each encoding, so only the picked
    // point itself, not its index in the node, is the same.
    const { index: _, ...picked } = (await pick(page))!;
    return { encoding: loaded.encoding, nodes: loaded.nodes, images, pick: picked };
  };
  const brotli = await draw(BROTLI);
  const uncompressed = await draw(DEFAULT);
  expect(brotli.encoding).toBe('BROTLI');
  expect(uncompressed.encoding).toBe('DEFAULT');
  expect({ ...uncompressed, encoding: 'BROTLI' }).toEqual(brotli);
});

test('clouds sharing a shader program keep their own clips on every frame', async ({ page }) => {
  // Only the roots, then the whole view.
  for (const rootOnly of [true, false]) {
    const result = await page.evaluate(
      ([url, rootOnly]) => window.harness.sharedProgramClipping(url, rootOnly),
      [BROTLI, rootOnly] as const,
    );
    expect(result.sharedProgram).toBe(true);
    if (rootOnly) expect(result.nodes).toEqual([1, 1]);
    expect(result.drawn[0]).toBeGreaterThan(100);
    expect(result.drawn[1]).toBeGreaterThan(100);
    expect(result.differing).toEqual([0, 0, 0]);
  }
});

test('a cloud set picks the nearest drawn point of any cloud', async ({ page }) => {
  const counts = await page.evaluate((url) => window.harness.pickAcrossClouds(url), BROTLI);
  // Each pick hits the cloud drawn at its pixel, so a point behind the front cloud is not hit.
  expect(counts.mismatched).toBe(0);
  expect(counts.front).toBeGreaterThan(20);
  expect(counts.back).toBeGreaterThan(20);
  // Where the back cloud alone has a point, the set still hits the front one.
  expect(counts.occluded).toBeGreaterThan(5);
});

test('picks follow a logarithmic depth buffer far from the camera', async ({ page }) => {
  const counts = await page.evaluate((url) => window.harness.pickAcrossClouds(url, 'far'), BROTLI);
  // The front cloud covers the back one; a standard depth buffer would let either win.
  expect(counts.front).toBeGreaterThan(20);
  expect(counts.mismatched).toBe(0);
});

test('picks resolve equal depths in the order the display draws the clouds', async ({ page }) => {
  const counts = await page.evaluate((url) => window.harness.pickAcrossClouds(url, 'same'), BROTLI);
  // Both clouds are at one place; the one drawn last covers the other.
  expect(counts.front).toBeGreaterThan(20);
  expect(counts.back).toBe(0);
  expect(counts.mismatched).toBe(0);
});

test('orthographic picks match flat sibling points with equal depths and reversed creation order', async ({
  page,
}) => {
  const result = await page.evaluate(
    (url) => window.harness.pickAcrossSiblingNodes(url),
    FLAT_SIBLINGS,
  );
  // Guard the regression setup: selection visits r0 before r4, but the original Points IDs
  // put r4 first. The display draws r0 last when material and view depth are equal.
  expect(result.creationOrder).toEqual(['r4', 'r0']);
  expect(result.alone).toEqual({ r0: [255, 0, 0], r4: [0, 0, 255] });
  expect(result.drawn).toEqual([255, 0, 0]);
  // Reusing the proxies must preserve the same winner on every pick.
  expect(result.picks).toEqual(
    Array.from({ length: 3 }, () => ({
      node: 'r0',
      color: result.drawn,
      height: 2,
    })),
  );
});

for (const [name, left, bottom, width, height, ratio, layer, options] of [
  ['left half', 0, 0, 150, 300, 1, 0, {}],
  ['offset viewport at high DPI', 150, 75, 150, 150, 2, 0, {}],
  // 151 × 1.5 rounds up in setViewport() but down in setRenderTarget(null).
  ['odd viewport at a fractional pixel ratio', 1, 1, 151, 151, 1.5, 0, {}],
  ['layer 2', 0, 0, 300, 300, 1, 2, {}],
  [
    'perspective viewport with camera view offset',
    0,
    0,
    150,
    300,
    1,
    0,
    { perspective: true, viewOffset: true },
  ],
  ['render target viewport at high DPI', 150, 75, 150, 150, 2, 0, { renderTarget: true }],
] as const) {
  test(`picking and EDL match a point in ${name}`, async ({ page }) => {
    const result = await page.evaluate((args) => window.harness.viewportPoint(...args), [
      FLAT_SIBLINGS,
      left,
      bottom,
      width,
      height,
      ratio,
      layer,
      options,
    ] as const);
    expect(result.direct).toBe(100 * ratio * ratio);
    expect.soft(result.hit).toBe('r');
    expect.soft(result.empty).toBeNull();
    expect.soft(result.excluded).toBeNull();
    expect.soft(result.edl).toBe(result.direct);
    expect(result.viewportRestored).toBe(true);
  });
}
