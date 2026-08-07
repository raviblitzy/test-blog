// PostCSS pipeline for the Next.js tier.
//
// This file does exactly one thing: it hands every stylesheet Next.js compiles
// to the Tailwind CSS 4 engine. That single hand-off is what turns the `@theme`
// block in src/app/globals.css into (a) real CSS custom properties and (b) the
// utility classes that src/components/ui/* and every feature component compose
// from. Without it the token layer is inert - the semantic tokens never reach
// the browser, `dark:` never emits a `.dark`-scoped rule, and the project's
// zero-hardcoded-values rule stops being mechanically enforced and becomes a
// convention nobody can check. The brevity of this file is not a measure of how
// much depends on it.
//
// Four things are deliberately ABSENT. Do not add them.
//
//   1. A `tailwindcss` plugin entry. Tailwind 4 moved its PostCSS integration
//      into the separate `@tailwindcss/postcss` package; registering
//      `tailwindcss` itself is the Tailwind 3 pattern and fails on 4.
//   2. `autoprefixer`. Tailwind 4 handles vendor prefixing internally (through
//      Lightning CSS), and autoprefixer is not a declared dependency of this
//      project - adding it would break reproducible installs for no gain.
//   3. `postcss-import`, `postcss-nesting`, `cssnano` or any other plugin.
//      Tailwind 4 resolves `@import` and flattens nesting itself, Next.js
//      minifies production CSS on its own, and none of these is declared in
//      frontend/package.json.
//   4. A `content` array, or any reference to a `tailwind.config.{js,ts,mjs}`
//      file. Tailwind 4 is CSS-first: it discovers source files automatically
//      and the entire token layer is declared in src/app/globals.css. No
//      `tailwind.config.*` exists in this repository and none should be added.
//
// Two mechanical constraints that are easy to break silently:
//
//   * The `.mjs` extension is load-bearing. frontend/package.json deliberately
//     omits `"type": "module"` - Next.js does not set it, and setting it would
//     reinterpret every `.js` file in the tree - so the extension is the only
//     thing making this module ESM, and therefore the only thing making
//     `export default` valid. Never use `module.exports`, and never rename this
//     file to `.js`, `.cjs` or `.ts`.
//   * The configuration object is bound to a named constant before it is
//     exported. `import/no-anonymous-default-export`, enabled through
//     eslint-config-next/core-web-vitals, warns on an anonymous default export,
//     and `npm run lint` runs with `--max-warnings=0` - so exporting the object
//     literal directly would fail the lint gate.
//
// The nested empty object is the per-plugin options slot. It stays empty
// because the engine takes its configuration from the stylesheet, and it stays
// present so that any option ever needed has one obvious home.
//
// The annotation below is structural on purpose. `postcss-load-config`, whose
// `Config` type would be the conventional choice, is not a declared dependency
// and is not in frontend/package-lock.json, so importing its type would be a
// reference to a package that is never installed.

/** @type {{ plugins: Record<string, Record<string, unknown>> }} */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
