// Flat ESLint configuration.
//
// eslint-config-next@16 publishes its flat-config arrays as DEFAULT exports on
// the `core-web-vitals` and `typescript` subpaths. The legacy
// FlatCompat.extends('next/core-web-vitals') path does not load, and named
// imports are not provided - the defaults must be spread.
//
// The array is bound to a named constant before being exported because
// `import/no-anonymous-default-export` (enabled by core-web-vitals) otherwise
// warns on this very file, which fails the `--max-warnings=0` gate.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/** @type {import('eslint').Linter.Config[]} */
const config = [
  {
    ignores: [
      '.next/**',
      'out/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'next-env.d.ts',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
];

export default config;
