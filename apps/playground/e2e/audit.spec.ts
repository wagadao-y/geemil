import { expect, test } from '@playwright/test';
import type { probe } from './audit-harness';

for (const logDepth of [false, true]) {
  test(`audit observation: scissor, material flags, EDL exception and combined features (log=${logDepth})`, async ({
    page,
  }) => {
    await page.goto('/e2e/harness.html');
    const result = await page.evaluate(async (logDepth) => {
      const path = '/e2e/audit-harness.ts';
      const module = (await import(path)) as { probe: typeof probe };
      return module.probe(logDepth);
    }, logDepth);
    console.log(JSON.stringify(result));
    expect(result.direct.slice(0, 3)).toEqual([255, 0, 0]);
    expect(result.normalPick).toBe('r');
    expect(result.scissorPixel.slice(0, 3)).toEqual([0, 0, 0]);
    expect(result.scissorPick).toBe('r'); // Defect observation, not desired behavior.
    expect(result.scissorRestored).toBe(true);
    expect(result.invisibleMaterialPixel.slice(0, 3)).toEqual([0, 0, 0]);
    expect(result.invisibleMaterialPick).toBe('r');
    expect(result.frontMesh.slice(0, 3)).toEqual([0, 0, 255]);
    expect(result.backMesh.slice(0, 3)).toEqual([255, 0, 0]);
    expect(result.combinedPixel.slice(0, 3)).toEqual([255, 0, 0]);
    expect(result.combinedPick).toEqual([4, 4, 4]);
    expect(result.hiddenPixel.slice(0, 3)).toEqual([0, 0, 0]);
    expect(result.hiddenPick).toBeNull();
    expect(result.exception).toContain('audit point pass exception');
    expect(result.autoClearAfterException).toBe(false);
    expect(result.shaderErrors).toEqual([]);
    expect(result.glError).toBe(0);
  });
}
