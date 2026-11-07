import js from '@eslint/js';
import globals from 'globals';

// Runtime bundles and captured/exported artwork are checked through their sources.
export default [
  {
    ignores: [
      'node_modules/**',
      '.releases/**',
      'dist/**',
      '.wrangler/**',
      'assets/**',
      'design/**',
      'hybrid-artwork.js',
      'hybrid-firstview.js',
      'hybrid-enhancement.js',
      'hybrid-original.js',
      'display-engine.js',
      'finish-worker.js',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  { files: ['*.js'], languageOptions: { globals: { ...globals.browser } } },
  {
    files: ['*.mjs', '*.cjs', 'scripts/**', 'tests/**', 'server/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['artwork-worker.js'],
    languageOptions: { globals: { ...globals.worker, ObservatoryArt: 'readonly' } },
  },
];
