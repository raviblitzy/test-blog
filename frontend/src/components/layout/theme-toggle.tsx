'use client';

// Theme toggle - the control half of the dark-mode requirement (R10).
//
// src/providers/theme-provider.tsx owns the MECHANISM: it configures next-themes
// with `attribute="class"`, so the resolved theme lands on the document element
// as a `dark` class, and it persists the visitor's choice. This file owns the one
// affordance that CHANGES that choice, and nothing else. It knows no colour, no
// storage key and no class name.
//
// The setting has THREE values - system, light and dark - because `system` is a
// real selection rather than the absence of one: it keeps tracking the operating
// -system preference after first paint, so a control that offered only the two
// appearances would strand a visitor who once chose one with no way back to it.
//
// ---------------------------------------------------------------------------
// 1. WHY A MENU BUTTON OVER A RADIO GROUP, AND NOT A BUTTON THAT CYCLES
//
// A three-valued setting has to answer two questions at all times: what may I
// choose, and what is chosen NOW. A single button that advances through the
// values answers neither, and every attempt to make it answer them fails on its
// own terms:
//
//   * `aria-pressed` is binary. Whichever way it is wired it misreports two of
//     the three values.
//   * An accessible name that states the next value ("Switch to dark mode")
//     describes a state the visitor is not in, and differs between the server
//     render and the hydrated render, so it both misleads and mismatches.
//   * A live region that speaks after activation says nothing at all to a
//     visitor who has just arrived, reloaded, or come back tomorrow - the
//     selection is persisted, so it long outlives the announcement that
//     accompanied it. An empty region on load is an empty answer.
//
// A radio group inside a menu states both halves directly and permanently.
// @radix-ui/react-dropdown-menu gives each row `role="menuitemradio"` and
// maintains `aria-checked` from the group's `value`, and
// `@/components/ui/dropdown-menu` paints a tick in the selected row's indicator
// gutter - so the current value is exposed PROGRAMMATICALLY and VISIBLY,
// simultaneously, without the visitor having to activate anything to find out.
// The three rows are the domain, so what may be chosen is on screen too.
//
// ---------------------------------------------------------------------------
// 2. WHY THAT IS STILL HYDRATION-SAFE - THE CRUX OF THE FILE
//
// The control is two halves with two different relationships to hydration, and
// keeping them apart is what makes the whole thing correct.
//
// THE TRIGGER renders no theme value whatsoever. Both glyphs are rendered on
// every pass and the `dark:` variant decides which one paints - `Sun` visible by
// default and hidden under `dark:`, `Moon` the other way round - so the server's
// HTML and the client's first render are byte-identical and the correct glyph is
// already painted in the first frame, before any of this component's JavaScript
// has run.
//
// THE MENU is where the selection is exposed, and it does not exist until the
// visitor opens it. Radix mounts panel content through @radix-ui/react-presence
// only while the menu is open, so the radio group's `value` - the one expression
// in this file derived from `useTheme()` - is first read into the DOM by an
// interaction, which can only happen after hydration. The server's HTML contains
// the trigger and nothing else, so there is no rendered theme value for the two
// passes to disagree about.
//
// That separation is not a micro-optimisation. The provider's own notes record
// the measurement: a consumer that renders the theme VALUE during the initial
// pass raises React #418 on every load, because `useTheme()` reports `theme` as
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
//   * Picking the trigger's icon from `resolvedTheme` in the render body. Same
//     #418, same flash, and it puts a second source of truth beside the `dark`
//     class that globals.css already keys every token off.
//
// ---------------------------------------------------------------------------
// 3. WHAT THE TRIGGER GLYPH MEANS, AND WHAT THE MENU ADDS
//
// The class on the document element carries the RESOLVED appearance and never
// the selection - verified in next-themes' compiled source, which resolves
// `system` to `light` or `dark` before touching `classList`. So CSS alone cannot
// tell "system, currently light" apart from "light", and the trigger shows a sun
// for both. Two glyphs reflecting the resolved appearance is the honest maximum
// a zero-JavaScript indicator can express, and a third `Monitor` glyph on the
// trigger would have to depend on hydrated state, reintroducing exactly the
// mismatch and flash section 2 exists to avoid.
//
// The menu is what closes that gap, and it closes it for everyone rather than
// for assistive technology alone: open it and the tick sits against System or
// against Light, unambiguously, in text and in a glyph. The trigger therefore
// answers "what am I looking at" with no JavaScript, and the menu answers "what
// did I choose" with one interaction. Neither has to lie to do its job.
//
// ---------------------------------------------------------------------------
// 4. DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT.
//
//   1. A cycling `onClick`, a next-value lookup table, and `aria-pressed`. All
//      three belong to the design section 1 rejects. The control now discloses a
//      menu; it does not advance a counter.
//   2. A polite live region announcing the new selection. It was redundant the
//      moment the rows became `role="menuitemradio"`: Radix moves focus to the
//      checked row when the menu opens, so its label and checked state are
//      announced on open, on arrow-key traversal and on selection. A second
//      channel saying the same thing would double every announcement.
//   3. An accessible name for the trigger that names the current or next theme.
//      That string differs between the server render and the hydrated render, so
//      it both mismatches and misleads before hydration. The name here is a
//      constant - and it is also the MENU's name, because Radix labels the panel
//      with `aria-labelledby={triggerId}`, which is why it reads as the setting
//      ("Colour theme") rather than as an instruction.
//   4. `resolvedTheme`, `systemTheme` or `themes` from the hook. Rendering any of
//      them in the initial pass is the #418 defect above; none is needed, because
//      the radio group turns on the SELECTION; and destructuring a binding this
//      file does not use would fail `npm run lint`, which runs with
//      `--max-warnings=0`.
//   5. Any direct write to `document.documentElement`, `localStorage`,
//      `document.cookie` or `matchMedia`. All four belong to next-themes, and a
//      second mechanism racing it is what reintroduces the flash of wrong theme.
//      vitest.setup.ts stubs `matchMedia` for the provider's benefit, not this
//      component's.
//   6. A colour, radius or shadow class of any kind. The `ghost` variant supplies
//      the trigger's surface, foreground and focus treatment, and
//      `@/components/ui/dropdown-menu` supplies the panel and row visuals, so
//      restating any of it here would be a second source of truth for a decision
//      a primitive already owns. The three token utilities this file DOES pass -
//      `w-11 px-0 [&_svg]:size-5` - are the composition that makes an icon-only
//      control out of the default size, which the Button size table documents in
//      place of a fourth size; each is justified at the call site below and none
//      of them is a literal.
//   7. A per-row glyph beside System, Light and Dark. The tick already marks the
//      selection and the labels already name the options, so a second glyph adds
//      no information - and a sun beside "Light" sits inches from the trigger's
//      sun, which means the RESOLVED appearance, inviting exactly the confusion
//      section 3 works to remove.
//   8. `useCallback` around the change handler, and a `title` attribute on the
//      trigger. The first would buy a dependency array to get wrong and nothing
//      else - there is no memoised child and no effect depending on it. The
//      second is not a reliable accessible name and is invisible to touch and
//      keyboard users; the hidden label is the name.

import type { JSX } from 'react';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * The three theme selections this application offers.
 *
 * These are the *selections* a visitor can make, not the two appearances a
 * selection resolves to: `system` defers to the operating-system preference and
 * keeps following it, which is why it is a member here and why it is offered as
 * an option of its own. The names are next-themes' own - `defaultTheme="system"`
 * and `enableSystem` in src/providers/theme-provider.tsx - so this union is a
 * character-for-character contract with that package's string values.
 *
 * Exported so the theme end-to-end spec and any component test can name the same
 * domain this component offers, instead of restating three string literals that
 * could drift from it.
 */
export type ThemeSelection = 'system' | 'light' | 'dark';

/**
 * The options, in the order they are presented: system first, then the two
 * explicit appearances.
 *
 * Declared once and mapped over, so the rows cannot fall out of step with the
 * labels beside them or with {@link ThemeSelection}. `system` leads because it is
 * the provider's default and the value a visitor who has never chosen is already
 * on, so the checked row is the first row on a first visit.
 */
const THEME_SELECTIONS: readonly ThemeSelection[] = ['system', 'light', 'dark'];

/**
 * The visible label of each option - and, through name-from-content, its
 * accessible name.
 *
 * Typed as an exhaustive record over {@link ThemeSelection} rather than a looser
 * string map on purpose: adding a fourth selection to the union then fails to
 * compile until this table accounts for it, so the two cannot fall out of step
 * silently.
 */
const SELECTION_LABELS: Readonly<Record<ThemeSelection, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/**
 * Which row is shown as checked when the current selection is not a value this
 * component offers.
 *
 * `useTheme()` reports `theme` as `undefined` in two real situations - while
 * rendering on the server, and when the component is rendered outside a
 * provider, where next-themes falls back to a no-op context - and as an
 * arbitrary string if a caller ever widened the provider's `themes` prop.
 * `system` is the honest answer in all three: it is what
 * src/providers/theme-provider.tsx declares as `defaultTheme`, so it is the
 * value in force whenever no explicit choice is known.
 *
 * This is a display fallback only. It is never written back through `setTheme`,
 * so it cannot silently overwrite a selection this component failed to
 * recognise.
 */
const DEFAULT_SELECTION: ThemeSelection = 'system';

/**
 * The trigger's accessible name - a constant, and required to stay one.
 *
 * It names the SETTING rather than an action or a state, so it is identical on
 * the server and after hydration and correct in all three selections.
 * Interpolating the current or next theme into it would reintroduce a hydration
 * mismatch and would announce the wrong thing before hydration.
 *
 * It names the panel too: Radix labels the menu with
 * `aria-labelledby={triggerId}`, so a screen reader reads this string as the
 * menu's name when it opens. A noun reads correctly in both roles ("Colour
 * theme, menu button", then "Colour theme, menu"); an instruction would not.
 */
const TRIGGER_LABEL = 'Colour theme';

/**
 * Narrows an arbitrary next-themes value to a selection this component offers.
 *
 * `theme` is typed `string | undefined` by next-themes and `onValueChange` hands
 * back a bare `string`, and either can in principle hold anything a caller
 * passed to the provider's `themes` prop, so the domain is checked rather than
 * asserted. No non-null assertion and no cast appears in this file as a result.
 */
function isThemeSelection(value: string | undefined): value is ThemeSelection {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * Resolves the row to show as checked, given whatever `useTheme()` reports.
 *
 * Total over its whole input type: every member of {@link ThemeSelection} passes
 * through unchanged, and `undefined` or any unrecognised string yields
 * {@link DEFAULT_SELECTION}. It is pure - no hook, no browser API, no clock - so
 * the mapping can be asserted directly without rendering anything:
 *
 * ```ts
 * expect(currentThemeSelection('dark')).toBe('dark');
 * expect(currentThemeSelection(undefined)).toBe('system');
 * expect(currentThemeSelection('sepia')).toBe('system');
 * ```
 *
 * @param current - The active selection, as `useTheme()` reports it.
 * @returns The selection to mark as checked. Never `undefined`, never throws.
 */
export function currentThemeSelection(current: string | undefined): ThemeSelection {
  return isThemeSelection(current) ? current : DEFAULT_SELECTION;
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
   * Utility classes for the trigger, forwarded to the underlying {@link Button}
   * and resolved against its variant classes by `cn`, so a caller's class
   * reliably wins its own property group - including the `shrink-0` this
   * component sets, which a caller may therefore override.
   *
   * This exists so that src/components/layout/site-header.tsx and
   * src/components/layout/mobile-nav.tsx can POSITION the control - order it in
   * a flex row, hide it at a breakpoint - without either file reaching for a
   * literal value. It is not an appearance hook: the `ghost` variant and the
   * icon-only composition below already decide how the trigger looks, and
   * re-deciding that here would put a second source of truth beside the
   * primitive. It reaches the trigger only; the panel's appearance belongs to
   * `@/components/ui/dropdown-menu`.
   */
  className?: string | undefined;
}

/**
 * The affordance that chooses the colour theme: System, Light or Dark.
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
 * colour transition; `@/components/ui/dropdown-menu` gives the panel, the
 * 44px-high rows, the highlight and the tick; the `dark:` variant compiled out
 * of src/app/globals.css decides which trigger glyph paints; and next-themes
 * performs the class change and the persistence. This component contributes the
 * option list, the current value and the accessible name.
 *
 * Accessibility, all of it deliberate:
 *
 *   * The trigger's name comes from hidden TEXT inside it rather than from
 *     `aria-label`, so the button has real text content, is reachable by
 *     text-based tooling, needs no attribute to stay correct, and gives the
 *     panel a name through Radix's `aria-labelledby`.
 *   * Both trigger glyphs are `aria-hidden`, because a sun and a moon carry no
 *     information a screen-reader user can act on - the name carries it, and the
 *     rows carry the selection.
 *   * The current selection is exposed by `aria-checked` on the checked row and
 *     by that row's tick, so it is available programmatically and visually at
 *     the same moment, and it survives a reload because it is derived from the
 *     persisted value rather than from something that happened in this session.
 *   * Keyboard operation is entirely Radix's: Enter, Space or arrow keys open
 *     the menu with focus on the checked row, arrows traverse, Enter or Space
 *     selects, Escape closes, and focus returns to the trigger.
 *
 * @param className - Positioning classes for the trigger. Optional.
 * @returns The trigger and its menu of the three selections.
 */
export function ThemeToggle({ className }: ThemeToggleProps): JSX.Element {
  // `theme` is the SELECTION. It is read for one purpose - to mark the checked
  // row - and that row exists only while the menu is open, which is what keeps
  // the initial pass free of any theme value. `resolvedTheme` is deliberately
  // not destructured; see note 4 in the header.
  const { theme, setTheme } = useTheme();

  /**
   * Records a selection.
   *
   * `onValueChange` types its argument as a bare `string`, so the value is
   * narrowed rather than trusted: an unrecognised one is ignored instead of
   * being written through to the provider, which keeps this handler total
   * without a cast. Persisting the choice and moving the class on the document
   * element are next-themes' work, not this function's.
   */
  function selectTheme(value: string): void {
    if (isThemeSelection(value)) {
      setTheme(value);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* Three token utilities, no literals, and each one earns its place.

            `w-11 px-0` squares the default size: that variant is `h-11 px-5`, so
            dropping the inline padding and matching the width to the height turns
            it into the 44x44 box an icon-only control needs - the composition the
            Button size table prescribes instead of a dedicated `icon` size.
            `[&_svg]:size-5` raises both glyphs from the primitive's 16px default
            to 20px, which is the proportion a lone glyph needs inside a 44px box.
            `tailwind-merge` resolves all three against the variant's own `px-5`
            and `[&_svg]:size-4` in this file's favour, so the result is one class
            per property rather than a specificity fight.

            `shrink-0` is layout rather than appearance, and belongs here rather
            than in the primitive: the Button is deliberately layout-agnostic, but
            this control is always rendered as a flex item beside a site title or a
            navigation row. A flex item's automatic minimum size is content-based,
            so without it the 44x44 box would collapse toward the 20px glyph under
            pressure at a narrow viewport - which is the fixed footprint failing in
            the one place it matters.

            All four sit before `className` so a caller can still override any of
            them. */}
        <Button variant="ghost" className={cn('w-11 shrink-0 px-0 [&_svg]:size-5', className)}>
          {/* Both glyphs render every time. `dark:hidden` and `hidden dark:block`
              are the whole switch, so the right one is painted in the first frame
              with no JavaScript. Neither carries a size class of its own: the
              `[&_svg]:size-5` on the control applies to both, and the primitive's
              `[&_svg]:shrink-0` keeps them from being squashed, so the footprint
              is fixed once and swapping glyphs cannot shift the header. */}
          <Sun aria-hidden="true" className="dark:hidden" />
          <Moon aria-hidden="true" className="hidden dark:block" />
          <span className="sr-only">{TRIGGER_LABEL}</span>
        </Button>
      </DropdownMenuTrigger>

      {/* `align="end"` because the control's place is the trailing edge of the
          site header: an end-aligned panel opens inward, so it cannot push the
          document's scroll width at the 375px viewport. Nothing else is
          positioned here - the panel sits flush against its trigger, which is
          the primitive's documented default and the same distance
          `@/components/ui/select` keeps. */}
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={currentThemeSelection(theme)} onValueChange={selectTheme}>
          {THEME_SELECTIONS.map((selection) => (
            <DropdownMenuRadioItem key={selection} value={selection}>
              {SELECTION_LABELS[selection]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
