import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import { demoAssets } from './dev/demo-assets';

export default defineConfig({
  plugins: [sveltekit(), demoAssets()],
  // SvelteKit narrows the dev server's file access to the app; the point cloud library's
  // decoder Worker is loaded from the workspace package.
  server: { fs: { allow: [searchForWorkspaceRoot(process.cwd())] } },
});
