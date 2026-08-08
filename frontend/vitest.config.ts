/**
 * Vitest configuration for the Next.js tier - this file IS the frontend
 * component-test runner.
 *
 * It is the SINGLE source of Vitest configuration for this tier, mirroring the
 * way backend/pyproject.toml is the single source of pytest configuration for
 * the other one. There is deliberately no vitest.workspace.ts (there is one
 * project here, not several), no vite.config.* (Next.js owns the application
 * build; Vite exists in this tree only as the transform Vitest runs on), and no
 * `test` block hiding in another config file. Two configs would be worse than a
 * wrong one, for the reason spelled out under FILENAME below.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS RESPONSIBLE FOR
 *
 * `npm run test` is bare `vitest` (frontend/package.json), so the gate the root
 * Makefile and CI both invoke is:
 *
 *     cd frontend && npm run test -- --run
 *
 * That is BLOCKING, not advisory. Three consequences shape every option below:
 *
 *   1. Appending `--run` must be sufficient to get a single non-watching pass.
 *      Nothing here may re-enable watch mode or otherwise keep the process
 *      alive after the last test resolves.
 *   2. `passWithNoTests` is NOT set, and must never be. A suite that collects
 *      nothing has to fail. Until frontend/tests/components/*.test.tsx exists
 *      the gate therefore reports "No test files found" and exits non-zero -
 *      which is the correct answer to "did the component suite pass?", and the
 *      exact failure a silently-empty run would hide.
 *   3. Nothing may narrow collection in a way that skips a real test file. The
 *      include/exclude pair below is drawn to be exhaustive over the component
 *      suite and disjoint from the Playwright suite, never to trim it.
 *
 * The other half of the job is providing an environment in which a test can
 * assert on an ACCESSIBLE NAME or on VISIBLE TEXT rather than on markup or
 * class names. That is what `environment: 'jsdom'` plus `setupFiles` buy, and
 * it is why no class-name matcher and no snapshot serialiser is configured
 * here: the token layer owns class names and is free to change them, so a test
 * that asserted on one would fail on a palette edit. Accessibility is a floor
 * for this project, and this file is where the suite is given the DOM to check
 * it against.
 *
 * ---------------------------------------------------------------------------
 * FILENAME - `.ts`, AND WHY THE EXTENSION IS NOT ARBITRARY
 *
 * `vitest.config.ts`. Measured from the installed runner, vitest@4.1.10
 * resolves its config by crossing two lists:
 *
 *     CONFIG_NAMES      = ['vitest.config', 'vite.config']
 *     CONFIG_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']
 *
 * `.ts` is FIRST. So `vitest.config.ts` wins against every other spelling, and
 * a sibling `vitest.config.mts` left next to it would never be read again -
 * dead config that looks live, where the symptom of editing it is that nothing
 * whatsoever changes. Exactly one of these files may exist, and this is it.
 *
 * `.ts` works despite frontend/package.json omitting `"type": "module"`, which
 * would otherwise make `import`/`export` and `import.meta` in a `.ts` file a
 * CommonJS violation under Node 24. It works because Vite never hands this file
 * to Node: `configLoader` defaults to `"bundle"`, so the config is
 * esbuild-bundled to a temporary `.mjs` and THAT is what gets imported. The
 * source extension never reaches Node's module resolver. (frontend/
 * eslint.config.mjs and frontend/postcss.config.mjs are a genuinely different
 * case - ESLint and PostCSS DO hand those to Node, so their `.mjs` extensions
 * are load-bearing and must not be changed.)
 *
 * ---------------------------------------------------------------------------
 * ONE EXPECTED WARNING - KNOWN, HARMLESS, AND NOT TO BE "FIXED" HERE
 *
 * Because of that same CJS-vs-ESM mismatch, every Vitest invocation prints this
 * to STDERR exactly once, before any test output:
 *
 *     (!) Your Vite config uses features that are unsupported by
 *         `configLoader: 'native'`, which is planned to become the default in a
 *         future major version of Vite:
 *       - ESM syntax in a file loaded as CommonJS (vitest.config.ts, at the
 *         first import below). Use a `.mjs` extension or set
 *         `"type": "module"` in the closest package.json
 *     Set `VITE_CONFIG_NATIVE_IGNORE_WARNING=true` to suppress this warning.
 *
 * It is a FORWARD-COMPATIBILITY notice about a loader that is not the default
 * yet, not a defect and not a deprecation of anything in use. Measured: the
 * gate exits 0 with the warning present, the warning appears on stderr and
 * never on stdout, and `--configLoader bundle` (today's default) behaves
 * identically. Nothing about collection, resolution or exit codes changes.
 *
 * All three remedies Vite suggests are rejected here, deliberately:
 *
 *   - Renaming to `.mts`. The filename is mandated, and per the section above a
 *     `.ts` sibling would win resolution anyway. Renaming trades a cosmetic
 *     warning for a config that can be silently shadowed.
 *   - `"type": "module"` in frontend/package.json. That would reinterpret every
 *     `.js` file in the tier at once - a real behavioural change to the whole
 *     package to quiet one line of yellow text. eslint.config.mjs documents the
 *     same prohibition from its side.
 *   - `VITE_CONFIG_NATIVE_IGNORE_WARNING=true` in the `test` script. Inline
 *     environment assignment is not portable to a Windows shell, and muting a
 *     forward-compatibility signal is worse than reading it.
 *
 * The warning is bounded rather than open-ended: vitest is pinned exactly at
 * 4.1.10 and package-lock.json pins the vite it brings with it, so the "future
 * major version" this refers to cannot arrive without a deliberate dependency
 * bump - which has to re-run this gate before it can land, exactly like the
 * TypeScript 6.0.3 and ESLint 9.39.5 ceilings. If that bump ever makes
 * `native` the default, the fix is to revisit the three options above with the
 * plan, not to patch around it here.
 *
 * `defineConfig` is imported from 'vitest/config', not from 'vite'. Only the
 * former types the `test` key; the latter would leave every option below
 * unchecked and silently accept a typo.
 *
 * Exporting the `defineConfig(...)` call directly is fine under the lint gate:
 * `import/no-anonymous-default-export` is enabled at 'warn' by
 * eslint-config-next and `--max-warnings=0` makes it fatal, but the rule
 * permits call expressions. Only a bare object or array literal would need to
 * be bound to a named constant first, which is why eslint.config.mjs and
 * next.config.ts do that and this file does not.
 */
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  /*
   * JSX transform. @vitejs/plugin-react is what lets a .tsx test file - and
   * every component it imports - be parsed at all. frontend/tsconfig.json sets
   * `"jsx": "react-jsx"` (the automatic runtime Next.js requires), and this
   * plugin's default matches it, so a component never needs a React import to
   * render under test.
   */
  plugins: [react()],

  resolve: {
    /*
     * THE ALIAS MIRROR - the one thing in this file that cannot be inferred
     * from a default, and the single most likely reason a component test fails
     * to run at all.
     *
     * Vitest resolves modules through Vite, and Vite does not read `paths` from
     * tsconfig.json. frontend/tsconfig.json declares
     *
     *     "paths": { "@/*": ["./src/*"] }
     *
     * and that alias is the mandated import style across the tier: UI
     * primitives arrive as `@/components/ui/*`, API modules as `@/lib/api/*`,
     * the class-merge helper as `@/lib/utils`. TypeScript therefore accepts
     * every one of those imports and `tsc --noEmit` stays green - while the
     * test run fails on "Cannot find module '@/components/ui/button'" unless
     * the mapping is restated HERE, for Vite, in Vite's own vocabulary.
     *
     * The two declarations are one logical mapping written twice. If either
     * moves, move both.
     *
     * On the exact form: `fileURLToPath` converts the file:// URL to a native
     * path. Reaching for `new URL(...).pathname` instead - the shortcut that
     * looks equivalent - yields "/C:/..." on Windows and leaves any percent-
     * encoding in the path intact, so it is wrong on two counts even though it
     * happens to work on Linux and macOS. Vite requires the replacement to be
     * absolute, which is what makes `import.meta.url` (rather than a bare
     * './src') the right base: it anchors the path to THIS file's directory, so
     * the alias holds no matter which working directory `vitest` was launched
     * from.
     *
     * There is no trailing slash, deliberately. Vite converts an object alias
     * into {find, replacement} pairs, and for a string `find` the matcher fires
     * only on an exact equality or on `find + '/'`. That is what keeps a bare
     * '@' safe: `@/lib/utils` is rewritten, while `@radix-ui/react-dialog`,
     * `@testing-library/react` and `@tanstack/react-query` are left alone
     * because none of them begins with '@/'.
     *
     * Note that `@` reaches src/ ONLY. frontend/tests/ sits outside src/, so
     * test-internal imports - one component test importing a fixture from
     * another, or the request-interception lifecycle the test-support boundary
     * adds pulling in its own handler list - are relative, and `@/tests/...`
     * resolves to nothing.
     *
     * vite-tsconfig-paths would also solve this. It is not used: it is not in
     * the declared dependency set, and adding an undeclared package to a tier
     * whose whole dependency story is exact pins costs more than the six lines
     * below save.
     */
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  test: {
    /*
     * A real DOM. jsdom@30.0.1 is pinned in frontend/package.json for exactly
     * this line and nothing else, and it is the precondition for the whole
     * accessibility floor: `getByRole`, `toHaveAccessibleName` and `toBeVisible`
     * all need a document with computed accessibility semantics behind them.
     * The default 'node' environment would leave every component test unable to
     * render.
     */
    environment: 'jsdom',

    /*
     * `describe`/`it`/`expect` reachable without an import at RUNTIME.
     *
     * This is a convenience, not a load-bearing setting, and frontend/
     * vitest.setup.ts is written so that it stays correct either way: it
     * registers `cleanup()` in an explicit `afterEach` rather than relying on
     * the automatic registration @testing-library/react performs only when
     * globals are on. That matters because the failure mode of losing cleanup
     * silently is an unrelated `getByRole` reporting "found multiple elements"
     * - a symptom that points nowhere near this file.
     *
     * IMPORTANT, AND THE REASON THIS COMMENT IS LONG: this setting buys nothing
     * from TypeScript. frontend/tsconfig.json includes **\/*.tsx, so every test
     * file is part of the `tsc --noEmit` program, and a test that LEANS on
     * these globals instead of importing them fails that gate with
     *
     *     error TS2593: Cannot find name 'describe'
     *     error TS2304: Cannot find name 'expect'
     *
     * even while the same file passes at runtime. Both gates are blocking, so
     * "it runs" is only half the bar.
     *
     * The convention that satisfies both - and the one already set by
     * vitest.setup.ts, which imports `afterAll`, `afterEach`, `beforeAll` and
     * `vi` explicitly - is to IMPORT the test API in every test file:
     *
     *     import { describe, expect, it } from 'vitest';
     *
     * That typechecks, and it works whether or not globals are enabled, so a
     * test written this way cannot be broken by a later change to this line.
     *
     * The alternative - a `types: ['vitest/globals']` entry in
     * frontend/tsconfig.json - is deliberately NOT used. A `types` array
     * replaces the automatic inclusion of every package under
     * node_modules/@types rather than adding to it, which here would silently
     * drop sixteen of them (node, react, react-dom, hast, mdast, unist and the
     * rest) and trade a tidy import line for a much larger problem. tsconfig.json
     * is also load-bearing for `next build`, which rewrites it when it disagrees
     * with an option, so it is the wrong file to experiment in.
     */
    globals: true,

    /*
     * The three public runtime values, pinned HERE and nowhere else.
     *
     * This is the single source of truth for what a component test sees in
     * `process.env.NEXT_PUBLIC_*`, and the placement is load-bearing rather than
     * a matter of taste. Vitest applies this block before a setup file or a test
     * module is evaluated; an assignment written inside vitest.setup.ts could
     * not, because ES module imports are hoisted, so every module that file
     * imports - and every module those import - would already have evaluated
     * against whatever the machine happened to have set. A module that reads a
     * NEXT_PUBLIC_ value at its top level would therefore observe a developer's
     * frontend/.env.local instead of the pinned value, and the gate's outcome
     * would depend on ambient state.
     *
     * The values are the ones .env.example documents, not invented test
     * hostnames, so a module that carries the documented default and a module
     * that reads the environment agree. The base URL includes the /api/v1 prefix
     * exactly as the contract requires: client code appends bare resource paths
     * such as /posts and never repeats the prefix.
     *
     * Neither URL is reachable from a component test: both name a loopback port
     * that nothing binds while this suite runs, so a component that fetched
     * without being told what to answer fails on a refused connection rather
     * than reaching a service. Request interception is not configured here or in
     * vitest.setup.ts - the handler module and its `listen`/`resetHandlers`/
     * `close` lifecycle arrive with the component suite that needs them, so this
     * entry never depends on a module the setup file cannot see. `msw` is pinned
     * in package.json ready for that suite.
     */
    env: {
      NEXT_PUBLIC_API_BASE_URL: 'http://localhost:8000/api/v1',
      NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
      NEXT_PUBLIC_SITE_NAME: 'Modern Blog',
      NEXT_PUBLIC_IMAGE_HOST_ALLOWLIST:
        'images.unsplash.com,picsum.photos,res.cloudinary.com,avatars.githubusercontent.com',
    },

    /*
     * The suite's bootstrap, resolved relative to this file's directory.
     *
     * frontend/vitest.setup.ts runs once per test file, before that file's own
     * modules evaluate, and it is where three things happen that no test should
     * have to repeat: the jest-dom matchers are registered (via the `/vitest`
     * subpath, so they extend Vitest's `expect` rather than Jest's), every
     * rendered tree is unmounted between tests, and the browser APIs jsdom omits
     * are filled in - matchMedia, ResizeObserver, IntersectionObserver,
     * scrollIntoView and pointer capture. The public configuration is pinned by
     * the `env` block above rather than in that file, for the ordering reason
     * recorded there.
     *
     * Request interception is deliberately not among them. The Mock Service
     * Worker server, its handler list and its lifecycle hooks arrive with the
     * suite they serve, at the boundary that introduces tests/**, so this
     * bootstrap imports nothing from tests/ and stays runnable on its own.
     *
     * That last group is what the Radix-backed primitives need. A dialog,
     * dropdown menu, select, tab set or avatar throws on `ResizeObserver is not
     * defined` or `matchMedia is not a function` the moment this wiring is
     * wrong, so those errors are the signal that this entry - not the component
     * - is at fault.
     */
    setupFiles: ['./vitest.setup.ts'],

    /*
     * The component suite lives under tests/, so collection is rooted there.
     *
     * Kept narrower than Vitest's default (which sweeps the whole project) on
     * purpose: a stray *.test.tsx under src/ would then be collected from a
     * location nothing else in the tier expects tests to live, which is how a
     * test ends up running with a different set of neighbours than the author
     * intended. Component tests belong in tests/components/*.test.tsx; if a
     * co-located convention is ever wanted, it is a deliberate edit here rather
     * than something that happens by accident.
     *
     * `.test.` is also the half of the naming convention this runner owns.
     * Playwright's specs end in `.spec.ts`, and frontend/playwright.config.ts
     * pins a `testMatch` restricted to that suffix from its side, so the two
     * runners cannot collect each other's files even before the exclude below
     * is considered.
     */
    include: ['tests/**/*.test.{ts,tsx}'],

    /*
     * `tests/e2e/**` is the entry that matters here.
     *
     * The six Playwright journeys are *.spec.ts, so the include glob above
     * already misses them - but they are excluded EXPLICITLY anyway, because
     * the failure that follows from Vitest collecting one is genuinely
     * confusing: @playwright/test refuses to run outside its own runner and
     * reports it as a broken import rather than as a misrouted file. Belt and
     * braces on a boundary between two test runners is cheap; a maintainer
     * losing an afternoon to that error message is not.
     *
     * Vitest replaces its default exclude list rather than extending it, so
     * node_modules/** and .next/** have to be restated or they stop being
     * excluded. Both mirror entries in the root .gitignore: the first is
     * dependencies (which carry their own tests), the second is Next.js build
     * output (which carries compiled copies of application code).
     */
    exclude: ['node_modules/**', '.next/**', 'tests/e2e/**'],

    /*
     * Process CSS imports instead of throwing on them.
     *
     * frontend/src/app/globals.css is the tier's only stylesheet, and a
     * component reached transitively through a layout can pull it in. Tailwind
     * utilities are NOT resolved to real declarations in this environment, and
     * that is fine rather than a limitation to work around: tests assert on
     * accessible names and visible text, never on computed styles or class
     * names, precisely so that a token change cannot break one.
     */
    css: true,

    coverage: {
      /*
       * './coverage' resolves to frontend/coverage/, which the root .gitignore
       * already excludes via a `coverage/` pattern (no leading slash, so it
       * matches at any depth) and which eslint.config.mjs already ignores. Any
       * other directory would leave `git status --porcelain` dirty after a
       * coverage run and put generated LCOV in front of the linter, so this
       * value is the one that keeps a working tree clean - not a free choice.
       *
       * Vitest additionally refuses a reportsDirectory equal to the project
       * root or the cwd, since it clears the directory before each run.
       * frontend/coverage/ is neither.
       */
      reportsDirectory: './coverage',

      /*
       * 'text' for a human reading terminal output, 'lcov' for anything that
       * consumes a report file. Nothing HTML: it would be the largest artefact
       * produced by the suite and nothing in this project reads it.
       */
      reporter: ['text', 'lcov'],

      /*
       * DELIBERATELY NO `thresholds`.
       *
       * The eighty-percent coverage floor is a BACKEND requirement, enforced
       * there by `pytest --cov-fail-under=80`. The frontend gate is
       * `npm run test -- --run` plus the six Playwright journeys, and no
       * frontend coverage percentage is required anywhere. Adding one here
       * would invent a requirement and hand the tier a gate that fails for a
       * reason nobody asked for.
       *
       * Note also that `--coverage` needs a provider package
       * (@vitest/coverage-v8) which is not part of the declared dependency set.
       * The block above is therefore inert until one is added deliberately -
       * and it exists now so that whoever adds it inherits the correct output
       * directory rather than choosing a new one.
       */
    },

    /*
     * DELIBERATELY ABSENT FROM THIS BLOCK. DO NOT ADD.
     *
     *   - `passWithNoTests`. See the header: an empty collection must fail.
     *   - `pool`, `poolOptions`, `maxWorkers`, `minWorkers`, `fileParallelism`.
     *     The defaults are correct here and tuning them without a measured
     *     problem trades real isolation guarantees for an imagined speed-up.
     *     The suite is per-file isolated as shipped.
     *   - `testTimeout` / `hookTimeout` overrides. A component test renders in
     *     jsdom against pinned loopback URLs nothing binds, so none of them
     *     waits on a network round trip and the defaults have ample headroom.
     *   - Any snapshot or class-name serialiser. Assertions target accessible
     *     names and visible text; see the header.
     *   - Anything Playwright-related, including reporters and projects.
     *     tests/e2e/** is a separate runner with a separate lifecycle and its
     *     own config, and the exclude above is the whole of this file's
     *     relationship with it.
     */
  },
});
