'use client';

// Theme provider - the mechanism half of the dark-mode requirement (R10).
//
// Dark mode in this project is a TOKEN-LAYER concern, not a per-component one.
// src/app/globals.css declares every semantic token twice: once at the document
// root and once under a `.dark` selector. A component written against
// `--color-surface` therefore themes itself with no conditional logic anywhere.
// This file's entire job is to put the `dark` class on the document element so
// that second set of declarations wins. Nothing here knows a colour, and
// nothing here should ever learn one.
//
// `attribute="class"` is the load-bearing line. next-themes defaults `attribute`
// to `data-theme`, and the Tailwind 4 dark variant compiled out of globals.css
// matches a CLASS. Change or drop that prop and every dark style in the
// application stops applying - silently, with no error, no failed build and no
// visible symptom until someone toggles the theme.
//
// Five things are deliberately ABSENT. Each looks like an improvement and is a
// defect; do not add them.
//
//   1. A `mounted` gate. `const [mounted, setMounted] = useState(false); if
//      (!mounted) return null;` is the most widely copied next-themes snippet on
//      the internet and it is wrong here: it renders nothing on the server and
//      on first paint, which discards the server-rendered article HTML that the
//      SEO requirement depends on - a crawler must see the content without
//      executing client JavaScript. `children` is rendered unconditionally.
//      Where that gate DOES belong is the consumer: `useTheme()` reports
//      `theme` as undefined while rendering on the server and as a real value
//      on the client, so any component that renders the theme VALUE - a label,
//      or an icon picked from `resolvedTheme` - has to absorb that difference
//      itself. Measured, not assumed: a consumer printing `theme` raises React
//      #418 on every load, while this provider on its own hydrates with a
//      silent console. Gate the small toggle if you must; never the tree.
//   2. Hand-rolled first-paint handling. No inline <script>, no classList write
//      in an effect, no cookie, no manual localStorage read. next-themes injects
//      its own blocking pre-hydration script (already carrying
//      suppressHydrationWarning) and persists the choice to localStorage under
//      its default `theme` key. A second mechanism racing that one is exactly
//      what reintroduces the flash of wrong theme and the hydration warning the
//      end-to-end theme spec asserts against. The server cannot know the
//      client's stored preference, so the resulting root-element difference is
//      expected and is absorbed by `suppressHydrationWarning` on <html> in
//      src/app/layout.tsx - it belongs there, not here.
//   3. A re-export of `useTheme`. Consumers - src/components/layout/theme-toggle
//      .tsx among them - import it straight from `next-themes`. A convenience
//      alias is a second name for one thing and drifts from the package.
//   4. A hand-written props interface. The type is derived from the component
//      itself, so it cannot fall out of step with the installed package.
//   5. Any environment read, network call, markup, className or inline style.
//      This provider is pure client state: it owns the theme strategy and
//      nothing else.

import { ThemeProvider as NextThemesProvider } from 'next-themes';

/**
 * Props of the underlying next-themes provider, derived from the component so
 * the wrapper cannot drift from the installed package's real surface.
 */
type ThemeProviderProps = React.ComponentProps<typeof NextThemesProvider>;

/**
 * Client boundary that owns theme selection for the whole application.
 *
 * Mounted once, in `src/app/layout.tsx`, around the entire tree:
 *
 * ```tsx
 * <ThemeProvider>{children}</ThemeProvider>
 * ```
 *
 * Behaviour, all of it supplied by next-themes rather than reimplemented here:
 * the active theme is written to the document element as a class, the initial
 * value follows the operating-system preference until the visitor chooses
 * otherwise, and that choice survives a reload and stays in step across tabs.
 *
 * The four defaults below are applied before `props` is spread, so a caller -
 * a test rendering a fixed theme, for instance - can override any of them
 * without this component having to anticipate the case.
 *
 * @param children - The tree to render. Rendered unconditionally, on the server
 * and on first paint, so no server-rendered markup is ever discarded.
 * @param props - Any other next-themes provider prop, spread after the defaults
 * so that it overrides them.
 */
export function ThemeProvider({ children, ...props }: ThemeProviderProps): React.JSX.Element {
  return (
    <NextThemesProvider
      // Toggle a class on <html>, matching the `.dark`-scoped token block in
      // globals.css. Not a default: next-themes would otherwise use data-theme.
      attribute="class"
      // Follow the operating-system preference until the visitor picks a theme.
      defaultTheme="system"
      // Offer `system` alongside `light` and `dark` so the toggle can cycle all
      // three and so the OS preference keeps being tracked after first paint.
      enableSystem
      // Suppress colour transitions for the instant the class flips, so
      // switching theme does not smear every surface through an animation.
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
