'use client';

// Theme toggle - the control half of the dark-mode requirement (R10).
//
// src/providers/theme-provider.tsx owns the MECHANISM: it configures next-themes
// with `attribute="class"`, so the resolved theme lands on the document element
// as a `dark` class, and it persists the visitor's choice. This file owns the one
// affordance that CHANGES that choice, and nothing else. It knows no colour, no
// storage key and no class name.
//
// The cycle is three selections in a fixed order - system, light, dark - because
// `system` is a real selection rather than the absence of one: it keeps tracking
// the operating-system preference after first paint, so a two-state toggle would
// strand a visitor who once clicked the control with no way back to it.
//
// ---------------------------------------------------------------------------
// 1. THE CRUX: CSS PICKS THE GLYPH, JAVASCRIPT NEVER DOES
//
// Both glyphs are rendered on every pass, and the `dark:` variant decides which
// one paints - `Sun` visible by default and hidden under `dark:`, `Moon` the
// other way round. Nothing in the returned markup reads `theme` or
// `resolvedTheme`, so the server's HTML and the client's first render are
// byte-identical and the correct glyph is already painted in the first frame,
// before any of this component's JavaScript has run.
//
// That is not a micro-optimisation, it is what makes the whole file correct. The
// provider's own notes record the measurement: a consumer that renders the theme
// VALUE raises React #418 on every load, because `useTheme()` reports `theme` as
// undefined while rendering on the server and as a real value on the client. The
// two usual escapes from that are both defects here:
//
//   * `const [mounted, setMounted] = useState(false); if (!mounted) return null`
//     - the most-copied next-themes snippet there is. It does not remove the
//     mismatch, it removes the CONTROL: the button pops into existence after
//     hydration, which is a visible flash and a layout shift in the site header.
//     It is forbidden in this file, and the point is that the design above makes
//     it unnecessary rather than merely unfashionable - there is nothing left to
//     gate.
//   * Picking the icon from `resolvedTheme` in the render body. Same #418, same
//     flash, and it puts a second source of truth beside the `dark` class that
//     globals.css already keys every token off.
//
// ACCEPTED AND DELIBERATE LIMIT, recorded rather than hidden. Because the class
// on the document element carries the RESOLVED appearance and never the
// selection - verified in next-themes' compiled source, which resolves `system`
// to `light` or `dark` before touching `classList` - CSS cannot distinguish
// "system, currently light" from "light". Both therefore show the sun. Two
// glyphs reflecting the resolved appearance is the honest maximum a
// zero-JavaScript indicator can express; a third `Monitor` glyph would have to
// depend on hydrated state and would reintroduce exactly the mismatch and flash
// this design exists to avoid. The live region below closes the gap for
// assistive technology by announcing the SELECTION, which is the part CSS cannot
// show.
//
// ---------------------------------------------------------------------------
// 2. DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT.
//
//   1. `aria-pressed`. It is a BINARY state and this control has three
//      selections, so it would misreport two of them whichever way it was wired.
//   2. An accessible name that names the current or next theme ("Switch to dark
//      mode"). That string differs between the server render and the hydrated
//      render, so it both mismatches and misleads before hydration. The name here
//      is a constant.
//   3. `resolvedTheme`, `systemTheme` or `themes` from the hook. Rendering any of
//      them is the #418 defect above; none is needed for the cycle, which turns
//      on the SELECTION; and destructuring a binding this file does not use would
//      fail `npm run lint`, which runs with `--max-warnings=0`.
//   4. Any direct write to `document.documentElement`, `localStorage`,
//      `document.cookie` or `matchMedia`. All four belong to next-themes, and a
//      second mechanism racing it is what reintroduces the flash of wrong theme.
//      vitest.setup.ts stubs `matchMedia` for the provider's benefit, not this
//      component's.
//   5. The `setTheme(previous => ...)` updater form, which next-themes does
//      support. Passing the resolved string instead keeps the call trivially
//      assertable - `expect(setTheme).toHaveBeenCalledWith('dark')` - and the
//      closure cannot go stale, because click and keydown are discrete events
//      and React flushes the re-render between them.
//   6. A colour, dimension, radius or shadow class of any kind. The `ghost`
//      variant supplies the surface, foreground and focus treatment, and the
//      `icon` size supplies the square footprint and the glyph size; adding
//      anything here would be a second source of truth for a decision the
//      primitive already owns.
//   7. `useCallback` around the handler. There is no memoised child below it and
//      no effect depending on it, so it would buy a dependency array to get wrong
//      and nothing else.
//   8. A `title` attribute. It is not a reliable accessible name and is invisible
//      to touch and keyboard users; the hidden label below is the name.

import { useState, type JSX } from 'react';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The three theme selections this application offers.
 *
 * These are the *selections* a visitor can make, not the two appearances a
 * selection resolves to: `system` defers to the operating-system preference and
 * keeps following it, which is why it is a member here and why the cycle returns
 * to it. The names are next-themes' own - `defaultTheme="system"` and
 * `enableSystem` in src/providers/theme-provider.tsx - so this union is a
 * character-for-character contract with that package's string values.
 *
 * Exported so the theme end-to-end spec and any component test can name the same
 * domain this component cycles through, instead of restating three string
 * literals that could drift from it.
 */
export type ThemeSelection = 'system' | 'light' | 'dark';

/**
 * The cycle, declared exactly once: system to light, light to dark, dark back to
 * system.
 *
 * Typed as an exhaustive record over {@link ThemeSelection} rather than a looser
 * string map on purpose - adding a fourth selection to the union then fails to
 * compile until this table accounts for it, so the two cannot fall out of step
 * silently.
 */
const THEME_CYCLE: Readonly<Record<ThemeSelection, ThemeSelection>> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

/**
 * Where the cycle starts when the current selection is not yet known.
 *
 * `useTheme()` reports `theme` as `undefined` in two real situations: while
 * rendering on the server, and when the component is rendered outside a
 * provider, where next-themes falls back to a no-op context. `light` is the
 * chosen entry point because it is the appearance the stylesheet declares at the
 * document root, so the first click moves the visitor to something they can see
 * has changed rather than to a selection that may render identically.
 */
const FALLBACK_SELECTION: ThemeSelection = 'light';

/**
 * The words announced to assistive technology after a selection changes.
 *
 * Kept beside the cycle so the two are read together, and exhaustive over
 * {@link ThemeSelection} for the same compile-time reason as {@link THEME_CYCLE}.
 */
const SELECTION_ANNOUNCEMENTS: Readonly<Record<ThemeSelection, string>> = {
  system: 'System theme',
  light: 'Light theme',
  dark: 'Dark theme',
};

/**
 * The control's accessible name - a constant, and required to stay one.
 *
 * It describes what the control DOES rather than what it will do next, so it is
 * identical on the server and after hydration and correct in all three
 * selections. Interpolating the current or next theme into it would reintroduce
 * a hydration mismatch and would announce the wrong thing before hydration.
 */
const TOGGLE_LABEL = 'Switch colour theme';

/**
 * Narrows an arbitrary next-themes value to a selection this component handles.
 *
 * `theme` is typed `string | undefined` by next-themes and can in principle hold
 * anything a caller passed to the provider's `themes` prop, so the domain is
 * checked rather than asserted. No non-null assertion and no cast appears in
 * this file as a result.
 */
function isThemeSelection(value: string | undefined): value is ThemeSelection {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * Resolves the selection that follows `current`.
 *
 * Total over its whole input type: every member of {@link ThemeSelection} maps
 * through {@link THEME_CYCLE}, and `undefined` or any unrecognised string yields
 * {@link FALLBACK_SELECTION}. It is pure - no hook, no browser API, no clock -
 * so the cycle can be asserted directly without rendering anything:
 *
 * ```ts
 * expect(nextThemeSelection('system')).toBe('light');
 * expect(nextThemeSelection('light')).toBe('dark');
 * expect(nextThemeSelection('dark')).toBe('system');
 * expect(nextThemeSelection(undefined)).toBe('light');
 * ```
 *
 * @param current - The active selection, as `useTheme()` reports it.
 * @returns The next selection in the cycle. Never `undefined`, never throws.
 */
export function nextThemeSelection(current: string | undefined): ThemeSelection {
  return isThemeSelection(current) ? THEME_CYCLE[current] : FALLBACK_SELECTION;
}

/**
 * Props for {@link ThemeToggle}.
 *
 * Kept local and unexported, matching the other components in this tier: the
 * consumers render `<ThemeToggle />` or `<ThemeToggle className="..." />` and
 * need no reference to the type.
 */
interface ThemeToggleProps {
  /**
   * Utility classes for the control itself, forwarded to the underlying
   * {@link Button} and resolved against its variant classes by `cn`, so a
   * caller's class reliably wins its own property group - including the
   * `shrink-0` this component sets, which a caller may therefore override.
   *
   * This exists so that src/components/layout/site-header.tsx and
   * src/components/layout/mobile-nav.tsx can POSITION the control - order it in
   * a flex row, hide it at a breakpoint - without either file reaching for a
   * literal value. It is not an appearance hook: the `ghost` variant and the
   * `icon` size already decide how the control looks, and re-deciding that here
   * would put a second source of truth beside the primitive.
   */
  className?: string | undefined;
}

/**
 * The affordance that cycles the colour theme: system, then light, then dark.
 *
 * Rendered once in the site header, and optionally again inside the mobile
 * navigation drawer:
 *
 * ```tsx
 * <ThemeToggle />
 * <ThemeToggle className="ms-auto" />
 * ```
 *
 * Everything the visitor can observe is supplied by parts that already exist:
 * `@/components/ui/button` gives the 44x44 square target, the centring, the
 * `:focus-visible` outline drawn from `--color-ring` and the `motion-safe`
 * colour transition; the `dark:` variant compiled out of src/app/globals.css
 * decides which glyph paints; and next-themes performs the class change and the
 * persistence. This component contributes the cycle and the accessible name.
 *
 * Accessibility, all of it deliberate:
 *
 *   * The name comes from hidden TEXT inside the control rather than from
 *     `aria-label`, so the button has real text content, is reachable by
 *     text-based tooling and needs no attribute to stay correct.
 *   * Both glyphs are `aria-hidden`, because a sun and a moon carry no
 *     information a screen-reader user can act on - the name and the
 *     announcement carry it instead.
 *   * The announcement lives in a polite live region that is a SIBLING of the
 *     button, never a child. A child's text would join the button's own
 *     accessible name through name-from-content, which would make the name
 *     change on every click - the exact instability the constant label avoids.
 *   * That region renders empty on the server and on first paint and is written
 *     only by the click handler, so it can neither mismatch nor announce
 *     anything on load.
 *
 * @param className - Positioning classes for the control. Optional.
 * @returns The control, followed by its polite live region.
 */
export function ThemeToggle({ className }: ThemeToggleProps): JSX.Element {
  // `theme` is the SELECTION and is read for one purpose only - to compute the
  // next one inside the handler below. It is never rendered. `resolvedTheme` is
  // deliberately not destructured; see note 3 in the header.
  const { theme, setTheme } = useTheme();

  // Empty on the server and on first paint, which is what keeps the live region
  // silent on load and identical across hydration.
  const [announcement, setAnnouncement] = useState('');

  /**
   * Advances the cycle by one step.
   *
   * The next selection is computed HERE rather than during render, from the
   * value current at click time: a handler can only run after hydration, so
   * `theme` is reliably known by the time this executes and the cycle never
   * depends on a first-render value. Persisting the choice and moving the class
   * on the document element are next-themes' work, not this function's.
   */
  function selectNextTheme(): void {
    const next = nextThemeSelection(theme);

    setTheme(next);
    setAnnouncement(SELECTION_ANNOUNCEMENTS[next]);
  }

  return (
    <>
      {/* `shrink-0` is the one class this component contributes, and it belongs
          here rather than in the primitive: the Button is deliberately
          layout-agnostic, but this control is always rendered as a flex item
          beside a site title or a navigation row. A flex item's automatic
          minimum size is content-based, so without it the 44x44 box would
          collapse toward the 20px glyph under pressure at a narrow viewport -
          which is the fixed footprint failing in the one place it matters. It
          sits before `className` so a caller can still override it. */}
      <Button
        variant="ghost"
        size="icon"
        className={cn('shrink-0', className)}
        onClick={selectNextTheme}
      >
        {/* Both glyphs render every time. `dark:hidden` and `hidden dark:block`
            are the whole switch, so the right one is painted in the first frame
            with no JavaScript. Neither carries a size class: the `icon` size
            already applies `[&_svg]:size-5` and `[&_svg]:shrink-0` to both, so
            the footprint is fixed by the primitive and swapping glyphs cannot
            shift the header. */}
        <Sun aria-hidden="true" className="dark:hidden" />
        <Moon aria-hidden="true" className="hidden dark:block" />
        <span className="sr-only">{TOGGLE_LABEL}</span>
      </Button>

      {/* Outside the button on purpose - see the accessibility notes above. The
          element is present from the first render so assistive technology has a
          region to observe before its content ever changes. */}
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
