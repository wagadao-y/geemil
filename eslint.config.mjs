import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import svelteConfig from './apps/web/svelte.config.js';

export default defineConfig([
  globalIgnores([
    '**/node_modules/',
    '.pnpm-store/',
    'ref/',
    '**/dist/',
    '**/vendor/',
    '**/test-results/',
    '**/playwright-report/',
    '**/.svelte-kit/',
    'apps/web/build/',
    'apps/playground/e2e/data/',
    'apps/playground/public/',
    'packages/potree-v2-three/tests/data/',
  ]),
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    extends: [js.configs.recommended],
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
  },
  {
    files: ['packages/potree-v2-three/src/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['packages/potree-v2-three/src/load-waiters.ts'],
    rules: {
      // AbortSignal.reason may be any value; preserve it when forwarding a rejection.
      '@typescript-eslint/prefer-promise-reject-errors': [
        'error',
        { allowThrowingAny: true, allowThrowingUnknown: true },
      ],
    },
  },
  {
    files: ['apps/web/**/*.svelte', 'apps/web/**/*.svelte.ts'],
    extends: [svelte.configs.recommended],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.svelte'],
        svelteConfig,
      },
    },
    rules: {
      // Links are plain hrefs of a client-only SPA without a base path.
      'svelte/no-navigation-without-resolve': 'off',
      // Flags every local Map/Set/Date/URLSearchParams, including temporaries that are built and
      // returned; state that must be reactive uses SvelteSet explicitly.
      'svelte/prefer-svelte-reactivity': 'off',
    },
  },
  // typescript-eslint turns off no-undef for TypeScript, whose globals come from tsconfig's lib.
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  // Formatting belongs to Prettier; disable overlapping ESLint rules last.
  prettier,
  svelte.configs.prettier,
]);
