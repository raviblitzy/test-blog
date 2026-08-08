// Flat ESLint configuration for the Next.js tier - this file IS the frontend
// lint gate.
//
// `npm run lint` is `eslint . --max-warnings=0` (frontend/package.json), and it
// is what the root Makefile's `lint-frontend` target and CI both invoke. That
// gate is BLOCKING, not advisory: one warning anywhere in the tree fails it.
// Which is why this file is deliberately tiny - every rule added here is a rule
// the whole project must then satisfy, and every rule removed here is a defect
// class that silently stops being caught.
//
// ---------------------------------------------------------------------------
// 1. HOW THE NEXT CONFIG IS LOADED - THE ONE NON-OBVIOUS THING IN THIS FILE
//
// eslint-config-next@16.3.0 publishes its flat-config arrays as DEFAULT exports
// on two subpaths, and offers nothing else:
//
//     eslint-config-next/core-web-vitals  ->  default export, 4 entries
//     eslint-config-next/typescript       ->  default export, 5 entries
//
// Measured, not assumed: the module namespace for either subpath contains only
// ['default', 'module.exports']. Three approaches that look right and are not:
//
//   * `new FlatCompat().extends('next/core-web-vitals')` - the widely
//     documented migration path. It does not load against this version, and
//     @eslint/eslintrc is not a declared dependency of this project, so the
//     approach is not even installable here.
//   * `import { configs } from 'eslint-config-next'`, or any other named
//     import. There is no such named export on the package or its subpaths.
//   * An `extends` key inside this array. That is eslintrc syntax; ESLint 9
//     flat config has no top-level `extends`.
//
// Spreading the two default exports is the only form that loads. Confirm with
// `npx eslint --print-config src/app/page.tsx`, which resolves 113 rules - a
// load failure there is the exact symptom of one of the three mistakes above.
//
// ---------------------------------------------------------------------------
// 2. WHY THE ARRAY IS NAMED INSTEAD OF EXPORTED ANONYMOUSLY
//
// The `next` base entry applies to '**/*.{js,jsx,mjs,ts,tsx,mts,cts}', so this
// file lints ITSELF - and that entry enables `import/no-anonymous-default-
// export` at 'warn', the only import/* rule in the set. Exporting the array
// literal directly emits:
//
//     warning  Assign array to a variable before exporting as module default
//
// which `--max-warnings=0` turns into a failed run (exit 1). Binding the array
// to `config` first is therefore not a style preference, it is what makes the
// gate passable. frontend/postcss.config.mjs and frontend/next.config.ts bind a
// named constant for exactly the same reason; frontend/vitest.config.ts and
// frontend/playwright.config.ts export a `defineConfig(...)` call, which the
// rule permits because it allows call expressions.
//
// ---------------------------------------------------------------------------
// 3. VERSION CEILINGS - DO NOT RAISE EITHER PIN
//
//   eslint      9.39.5  eslint-plugin-import, eslint-plugin-jsx-a11y and
//                       eslint-plugin-react - all bundled by eslint-config-next
//                       - cap at `eslint ^9`. The registry's `latest` is 10.x
//                       and is unusable here, so do not reach for a config API
//                       introduced in ESLint 10.
//   typescript  6.0.3   the bundled typescript-eslint peers on
//                       `>=4.8.4 <6.1.0`. Under TypeScript 7 ESLint aborts with
//                       exit code 2 and `typescript-eslint does not support
//                       TS 7.0.` Exit code 2 means ESLint itself failed rather
//                       than finding lint problems; if it ever appears, check
//                       that pin before anything else.
//
// Both pins live in frontend/package.json and are carried as standing risks in
// the plan. Any future bump has to re-run this gate before it can land.
//
// ---------------------------------------------------------------------------
// 4. DELIBERATELY ABSENT. DO NOT ADD.
//
//   * Rule overrides of any kind. The two spreads pass `--max-warnings=0` as
//     they stand. If some rule ever genuinely blocks correct code, add a block
//     narrowed by a `files` glob with a one-line reason - never a blanket
//     `rules: { '...': 'off' }`, and never one at the top level.
//   * Any relaxation of jsx-a11y/* (6 rules - the project's automated
//     accessibility floor), react-hooks/* (16 rules - what protects the client
//     islands' hook usage) or @next/next/* (22 rules - the entire reason
//     core-web-vitals exists). Fix the component instead of the config.
//   * eslint-plugin-prettier or eslint-config-prettier. Neither is a declared
//     dependency. Formatting belongs to frontend/.prettierrc.json and runs
//     separately through `make format`; conflating the two would add an
//     undeclared package and make one failure look like the other.
//   * languageOptions, extra plugins or a parser override. The spreads already
//     wire typescript-eslint/parser plus the React and Next.js globals.
//
// One console message is worth knowing about, because it is not a lint finding
// and must not be "fixed" here. `@next/next/no-html-link-for-pages` looks for
// pages/, src/pages/, app/ and src/app/; if it finds NONE of them it prints
// "Pages directory cannot be found at .../pages or .../src/pages" to stderr and
// then does nothing at all. That can only happen while src/app/ is missing - on
// a complete tree the rule finds the App Router directory and the whole run
// produces no output on either stream. Verified by adding src/app/page.tsx and
// watching the message disappear. So if it ever shows up, a route directory is
// missing; do not silence it by disabling or re-optioning the rule.
//
// Finally, the `.mjs` extension is load-bearing. frontend/package.json omits
// `"type": "module"` on purpose - setting it would reinterpret every .js file
// in the tree - so the extension is the only thing making `import` and
// `export default` valid here. Never rename this file to .js, .cjs or .ts.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/** @type {import('eslint').Linter.Config[]} */
const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,

  // Global ignores. A config object carrying only `ignores` applies to the
  // whole run regardless of where it sits in the array.
  //
  // These mirror the build and report paths in the root .gitignore, so lint
  // never reports on a file git does not track. `src/**` and `tests/**` are
  // deliberately NOT here: every file beneath them is new code, and the
  // component tests in tests/components and the specs in tests/e2e need the
  // accessibility and import rules just as much as the application does.
  {
    ignores: [
      '.next/**', // Next.js build output
      'out/**', // `next build` static export output
      'node_modules/**', // dependencies
      'coverage/**', // vitest coverage reports
      'playwright-report/**', // playwright html reporter
      'blob-report/**', // playwright blob reporter (sharded runs)
      'test-results/**', // playwright traces, screenshots and videos
      'next-env.d.ts', // regenerated by `next dev` and `next build`
    ],
  },
];

export default config;
