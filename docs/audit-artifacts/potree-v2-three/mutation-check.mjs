import { mkdtemp, cp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'potree-mutation-audit-'));
await cp(join(workspace, 'packages/potree-v2-three/dist'), join(temp, 'dist'), { recursive: true });
await mkdir(join(temp, 'tests'));
await cp(
  join(workspace, 'packages/potree-v2-three/tests/point-size.test.mjs'),
  join(temp, 'tests/point-size.test.mjs'),
);
await symlink(join(workspace, 'packages/potree-v2-three/node_modules'), join(temp, 'node_modules'));
await writeFile(join(temp, 'package.json'), '{"type":"module"}');
const path = join(temp, 'dist/point-size.js');
const source = await readFile(path, 'utf8');
if (!source.includes('if (this.texture.image.height < rows)'))
  throw new Error('mutation marker missing');
await writeFile(path, source.replace('if (this.texture.image.height < rows)', 'if (false)'));
const result = spawnSync('node', ['--test', join(temp, 'tests/point-size.test.mjs')], {
  encoding: 'utf8',
});
console.log(
  JSON.stringify({ temp, mutation: 'disable visible node texture growth', exit: result.status }),
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
