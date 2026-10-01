import { createReadStream, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Serves the demo site's asset files on the dev server only, under the URL the Go API will use
 * (`/api/sites/{site}/assets/{asset}/files/{name}`), so they are not part of the build. Both demo
 * point clouds are the playground's `pump`. Supports HTTP Range, which the point cloud loader needs.
 */
const pump = resolve(import.meta.dirname, '../../playground/public/pump');

const assetDirs: Record<string, Record<string, string>> = {
  'bay-energy': { 'a-pump-a': pump, 'a-pump-b': pump },
};

const files = new Set(['metadata.json', 'hierarchy.bin', 'octree.bin']);

const route = /^\/api\/sites\/([^/]+)\/assets\/([^/]+)\/files\/([^/]+)$/;

export function demoAssets(): Plugin {
  return {
    name: 'demo-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = route.exec(new URL(req.url ?? '', 'http://localhost').pathname);
        if (!match) return next();
        const [, site, asset, name] = match.map(decodeURIComponent);
        const dir = assetDirs[site]?.[asset];
        if (!dir || !files.has(name) || (req.method !== 'GET' && req.method !== 'HEAD')) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const path = resolve(dir, name);
        const { size } = statSync(path);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader(
          'Content-Type',
          name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        );

        let start = 0;
        let end = size - 1;
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        if (range) {
          if (range[1] === '') {
            start = Math.max(0, size - Number(range[2]));
          } else {
            start = Number(range[1]);
            if (range[2] !== '') end = Math.min(Number(range[2]), size - 1);
          }
          if (start > end || start >= size) {
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${size}`);
            res.end();
            return;
          }
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        }
        res.setHeader('Content-Length', end - start + 1);
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        createReadStream(path, { start, end }).pipe(res);
      });
    },
  };
}
