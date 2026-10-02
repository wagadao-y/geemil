// Usage: node packed-check.mjs /absolute/path/package.tgz [versions...]
// Installs only into a new temporary directory; never updates the workspace lockfile.
import { mkdtemp, mkdir, writeFile, cp, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { brotliCompressSync } from 'node:zlib';
import assert from 'node:assert/strict';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(join(workspace, 'apps/playground/package.json'));
const { chromium } = require('@playwright/test');
const tarball = resolve(process.argv[2]);
const versions = process.argv.slice(3);
if (versions.length === 0)
  versions.push('0.180.0', '0.181.0', '0.182.0', '0.183.0', '0.184.0', '0.185.0', '0.186.1');
const temp = await mkdtemp(join(tmpdir(), 'potree-packed-audit-'));
console.log(JSON.stringify({ temp, tarball, versions }));
function command(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let log = '';
    child.stdout.on('data', (b) => {
      log += b;
    });
    child.stderr.on('data', (b) => {
      log += b;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(log) : reject(new Error(`${cmd} exit ${code}\n${log}`)),
    );
  });
}
const env = { ...process.env };
delete env.DISPLAY;
delete env.WAYLAND_DISPLAY;
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ozone-platform=headless'],
  env,
});
try {
  for (const version of versions) {
    const dir = join(temp, version);
    await mkdir(dir);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await command(
      'npm',
      ['install', '--no-audit', '--no-fund', tarball, `three@${version}`, 'vite@8.3.0'],
      dir,
    );
    const packageDir = join(dir, 'packages/potree-v2-three');
    await mkdir(packageDir, { recursive: true });
    await cp(join(workspace, 'packages/potree-v2-three/tests'), join(packageDir, 'tests'), {
      recursive: true,
    });
    await symlink(join(dir, 'node_modules/@geemil/potree-v2-three/dist'), join(packageDir, 'dist'));
    const pumpParent = join(dir, 'apps/playground/public');
    await mkdir(pumpParent, { recursive: true });
    await symlink(join(workspace, 'apps/playground/public/pump'), join(pumpParent, 'pump'));
    const files = (await readdir(join(packageDir, 'tests')))
      .filter((f) => f.endsWith('.test.mjs'))
      .map((f) => join(packageDir, 'tests', f));
    const unitLog = await command('node', ['--test', ...files], dir);
    await writeFile(join(dir, 'unit.log'), unitLog);
    const summary = unitLog
      .split('\n')
      .filter((l) => /tests |pass |fail |duration_ms/.test(l))
      .join('; ');
    await writeFile(join(dir, 'index.html'), '<script type="module" src="/main.js"></script>');
    const defaultData = new Uint8Array(19);
    const view = new DataView(defaultData.buffer);
    [4, 4, 4].forEach((v, i) => view.setInt32(i * 4, v, true));
    view.setUint16(12, 255, true);
    defaultData[18] = 6;
    const raw = new Uint8Array(25);
    new DataView(raw.buffer).setBigUint64(8, 448n, true);
    // Independent bit interleaving of 16-bit RGB, without the library decoder.
    let morton = 0n;
    for (let i = 0; i < 16; i++) if (255 & (1 << i)) morton |= 1n << BigInt(i * 3);
    new DataView(raw.buffer).setBigUint64(16, morton, true);
    raw[24] = 6;
    await writeFile(
      join(dir, 'points.json'),
      JSON.stringify({ DEFAULT: [...defaultData], BROTLI: [...brotliCompressSync(raw)] }),
    );
    await writeFile(join(dir, 'main.js'), source());
    const vite = await import(pathToFileURL(join(dir, 'node_modules/vite/dist/node/index.js')));
    await vite.build({ root: dir, logLevel: 'silent' });
    const server = await vite.preview({
      root: dir,
      logLevel: 'silent',
      preview: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    try {
      await page.goto(server.resolvedUrls.local[0]);
      await page.waitForFunction(() => 'auditDone' in globalThis, undefined, { timeout: 30000 });
      const result = await page.evaluate(() => globalThis.auditDone);
      assert.equal(result.revision, version.split('.')[1]);
      assert.deepEqual(
        result.results.map((r) => r.pixel),
        [
          [255, 0, 0, 255],
          [255, 0, 0, 255],
        ],
      );
      assert.deepEqual(
        result.results.map((r) => r.pick),
        [
          [4, 4, 4],
          [4, 4, 4],
        ],
      );
      assert.deepEqual(
        result.results.map((r) => r.edl),
        [
          [255, 0, 0, 255],
          [255, 0, 0, 255],
        ],
      );
      assert.deepEqual(
        result.results.map((r) => r.hidden),
        [null, null],
      );
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          version,
          unit: summary,
          browserVersion: browser.version(),
          artifacts: await readdir(join(dir, 'dist/assets')),
          result,
          errors,
        }),
      );
    } finally {
      await page.close();
      await new Promise((resolve) => server.httpServer.close(resolve));
    }
  }
} finally {
  await browser.close();
}

// Defined as a function declaration to initialize before the loop above.
function source() {
  return `
import * as THREE from 'three';
import {loadPotreeV2, PotreeV2PointCloudSet, PotreeV2Clipping, PotreeV2EDL} from '@geemil/potree-v2-three';
import points from './points.json';
const renderer = new THREE.WebGLRenderer({preserveDrawingBuffer:true, logarithmicDepthBuffer:true}); renderer.setSize(100,100,false); document.body.append(renderer.domElement);
const gl = renderer.getContext(); const debug=gl.getExtension('WEBGL_debug_renderer_info');
const results=[];
for(const encoding of ['DEFAULT','BROTLI']) {
 const metadata={version:'2.0',encoding,points:1,spacing:0.25,scale:[1,1,1],offset:[0,0,0],boundingBox:{min:[0,0,0],max:[8,8,8]},hierarchy:{firstChunkSize:22},attributes:[{name:'position',type:'int32',size:12,numElements:3,elementSize:4},{name:'rgb',type:'uint16',size:6,numElements:3,elementSize:2,max:[255,255,255]},{name:'classification',type:'uint8',size:1,numElements:1,elementSize:1}]};
 const octree=new Uint8Array(points[encoding]); const hierarchy=new Uint8Array(22); const h=new DataView(hierarchy.buffer); h.setUint8(0,1);h.setUint32(2,1,true);h.setBigUint64(14,BigInt(octree.length),true);
 const cloud=await loadPotreeV2('https://packed.audit/metadata.json',{decoderWorkers:1,attributes:['rgb','classification'],material:{sizeType:'adaptive',shape:'circle',minSize:10,maxSize:10},fetch:async(input,init)=>{const name=new URL(String(input)).pathname.split('/').at(-1); if(name==='metadata.json')return new Response(JSON.stringify(metadata));const b=name==='hierarchy.bin'?hierarchy:octree;const r=/bytes=(\\d+)-(\\d+)/.exec(new Headers(init.headers).get('Range'));return new Response(b.slice(Number(r[1]),Number(r[2])+1),{status:206});}});
 const set=new PotreeV2PointCloudSet();set.add(cloud); const scene=new THREE.Scene();scene.add(cloud.group);const camera=new THREE.PerspectiveCamera(60,1,0.1,100);camera.position.set(4,4,20);camera.lookAt(4,4,0);
 const clipping=new PotreeV2Clipping();clipping.addPlane({plane:new THREE.Plane(new THREE.Vector3(0,0,1),-3)});cloud.clipping=clipping;set.update(camera,100);
 const pixel=()=>{const p=new Uint8Array(4);gl.readPixels(50,49,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return [...p];};renderer.render(scene,camera);const direct=pixel();const hit=await cloud.pick(renderer,camera,50,50);
 const edl=new PotreeV2EDL({strength:0});edl.render(renderer,scene,camera,[cloud]);const edlPixel=pixel();cloud.material.classification.setVisible(6,false);renderer.render(scene,camera);const hidden=await cloud.pick(renderer,camera,50,50);
 results.push({encoding,pixel:direct,pick:hit?.sourcePosition,edl:edlPixel,hidden,glError:gl.getError()});cloud.dispose();edl.dispose();
}
window.auditDone={revision:THREE.REVISION,results,gpu:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};
renderer.dispose();
`;
}
