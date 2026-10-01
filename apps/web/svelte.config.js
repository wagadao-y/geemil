import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    // A single-page app: the Go server returns index.html for every route it does not own.
    adapter: adapter({ fallback: 'index.html' }),
  },
};
