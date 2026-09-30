import { expect, test, type Page } from '@playwright/test'
import type { Capture, ColorSettings, Harness } from './harness'

const BROTLI = '/pump/metadata.json'
/** Written by global-setup.ts from the BROTLI sample. */
const DEFAULT = '/e2e/data/pump-default/metadata.json'
const COLOR_ATTRIBUTES = ['rgb', 'intensity', 'classification']

declare const window: { harness: Harness }

async function open(page: Page): Promise<void> {
  // Report why the harness failed to start, such as a WebGL context that could not be created.
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()) })
  await page.goto('/e2e/harness.html')
  await page.waitForFunction(() => 'harness' in window, undefined, { timeout: 15_000 }).catch(error => {
    throw new Error(`The harness did not start: ${pageErrors.join(' / ') || error}`)
  })
}

const load = (page: Page, url: string, options: Parameters<Harness['load']>[1] = {}) =>
  page.evaluate(([url, options]) => window.harness.load(url, options), [url, options] as const)
const setColor = (page: Page, settings: ColorSettings) =>
  page.evaluate(settings => window.harness.setColor(settings), settings)
const capture = (page: Page): Promise<Capture> => page.evaluate(() => window.harness.capture())
const pick = (page: Page) => page.evaluate(() => window.harness.pick())

test.beforeEach(async ({ page }) => {
  await open(page)
})

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.harness.errors())).toEqual({ shaderErrors: [], glError: 0 })
})

test('every color type compiles and draws its colors', async ({ page }) => {
  const loaded = await load(page, BROTLI, { attributes: COLOR_ATTRIBUTES })
  expect(loaded.attributes).toEqual(['position', ...COLOR_ATTRIBUTES])
  expect(loaded.colorType).toBe('rgb')

  const images: Record<string, Capture> = {}
  for (const type of ['rgb', 'elevation', 'intensity', 'classification'] as const) {
    await setColor(page, { type })
    images[type] = await capture(page)
    expect(images[type].drawn, type).toBeGreaterThan(1000)
  }
  // The sample's classes are all 0, whose default color is #808080; sRGB colors survive exactly.
  expect(images.classification!.mean).toEqual([128, 128, 128])
  const [r, g, b] = images.intensity!.mean
  expect(g).toBe(r)
  expect(b).toBe(r)
  expect(new Set(Object.values(images).map(image => image.digest)).size).toBe(4)

  await setColor(page, { type: 'solid', solid: '#ff0000' })
  expect((await capture(page)).mean).toEqual([255, 0, 0])

  // A gradient or gamma change redraws the same points differently.
  await setColor(page, { type: 'elevation', gradient: 'VIRIDIS' })
  const viridis = await capture(page)
  expect(viridis.drawn).toBe(images.elevation!.drawn)
  expect(viridis.digest).not.toBe(images.elevation!.digest)
  await setColor(page, { type: 'intensity', intensityGamma: 0.3 })
  expect((await capture(page)).mean[0]).toBeGreaterThan(r)
})

test('hidden classes are neither drawn nor picked', async ({ page }) => {
  await load(page, BROTLI, { attributes: COLOR_ATTRIBUTES })
  expect(await pick(page)).not.toBeNull()
  await page.evaluate(() => window.harness.setClassVisible(0, false))
  expect((await capture(page)).drawn).toBe(0)
  expect(await pick(page)).toBeNull()
})

test('only position and rgb are decoded by default', async ({ page }) => {
  const loaded = await load(page, BROTLI)
  expect(loaded.attributes).toEqual(['position', 'rgb'])
  await expect(setColor(page, { type: 'intensity' })).rejects.toThrow(/needs the decoded attribute 'intensity'/)
  const colored = await load(page, BROTLI, { pointColorType: 'classification' })
  expect(colored.attributes).toEqual(['position', 'rgb', 'classification'])
})

test('DEFAULT and BROTLI encodings draw the same pixels', async ({ page }) => {
  const draw = async (url: string) => {
    const loaded = await load(page, url, { attributes: COLOR_ATTRIBUTES })
    const images: string[] = []
    for (const type of ['rgb', 'intensity', 'elevation'] as const) {
      await setColor(page, { type })
      images.push((await capture(page)).digest)
    }
    return { encoding: loaded.encoding, nodes: loaded.nodes, images, pick: await pick(page) }
  }
  const brotli = await draw(BROTLI)
  const uncompressed = await draw(DEFAULT)
  expect(brotli.encoding).toBe('BROTLI')
  expect(uncompressed.encoding).toBe('DEFAULT')
  expect(brotli.pick).not.toBeNull()
  expect({ ...uncompressed, encoding: 'BROTLI' }).toEqual(brotli)
})
