import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    '**/node_modules/',
    '.pnpm-store/',
    'ref/',
    '**/dist/',
    '**/vendor/',
    '**/test-results/',
    '**/playwright-report/',
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
    files: [
      'packages/potree-v2-three/src/**/*.ts',
      'apps/playground/src/**/*.ts',
      'apps/playground/e2e/harness.ts',
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['packages/potree-v2-three/src/decode-worker.ts'],
    languageOptions: {
      globals: {
        ...Object.fromEntries(Object.keys(globals.browser).map((name) => [name, 'off'])),
        ...globals.worker,
      },
    },
  },
  {
    files: [
      '*.mjs',
      'packages/potree-v2-three/tests/**/*.mjs',
      'apps/playground/playwright.config.ts',
      'apps/playground/e2e/**/*.ts',
    ],
    ignores: ['apps/playground/e2e/harness.ts'],
    languageOptions: { globals: globals.node },
  },
  // Formatting belongs to Prettier; disable overlapping ESLint rules last.
  prettier,
]);
