// =============================================================================
// input.tsx - the design system's single-line text field.
//
// One of the fifteen primitives under src/components/ui/ that ARE this project's
// design system. No component library was specified for this product, so this
// directory is the system: feature code consumes it and never reaches past it.
// The project rule "project primitives over raw elements" names <input>
// explicitly, and THIS FILE is the one place that element is wrapped. Everything
// under src/app/, src/components/blog/, src/components/layout/ and
// src/components/admin/ imports `Input` instead of writing its own field.
//
// IT IS ALSO THE HOUSE STYLE FOR THE WHOLE FIELD FAMILY. textarea.tsx shares
// this token vocabulary and select.tsx's trigger is styled to match it, so the
// three read as one control family rather than three near-misses. A field token
// changed here has to change there in the same commit.
//
// Because that boundary is only honourable if nothing is lost by crossing it,
// every native attribute passes straight through - `id`, `name`, `value`,
// `defaultValue`, `placeholder`, `required`, `readOnly`, `disabled`,
// `autoComplete`, `inputMode`, `pattern`, `min`, `max`, `step`, `maxLength`,
// every event handler and `ref`. A consumer never has to reach for a raw
// <input> to get at one of them.
//
// DELIBERATELY ABSENT. Please do not add:
//
//   1. `'use client'`. This module has no hook, no state and no browser API, so
//      it stays a shared module usable from either environment. A Server
//      Component can render a field without turning its route into a client
//      island, and the interactive forms that use it are already client
//      components themselves - the directive belongs to them, not here.
//   2. `forwardRef`. On React 19 `ref` is an ordinary prop and rides the spread
//      below into the DOM node. A `forwardRef` wrapper would still work but adds
//      an indirection the runtime no longer needs.
//   3. A `class-variance-authority` variant table. cva earns its keep from two
//      or more independent axes; this primitive has exactly one boolean, so a
//      `cn()` conditional is the smaller and more legible form. button.tsx and
//      badge.tsx, which do have size and intent axes, are where cva belongs.
//   4. A `dark:` conditional. Every colour below is a semantic token, and
//      src/app/globals.css gives each one a `:root` value and a `.dark` value.
//      The field themes with no branching in this file - that indirection is the
//      whole point of the token layer.
//   5. `file:` utilities. Cover images and avatars are remote URL references and
//      the product ships no upload pipeline at all, so styling the
//      `::file-selector-button` part would be decoration for a surface that does
//      not exist. A `type="file"` field still renders and still works; it simply
//      gets the browser's own button.
//   6. `selection:` utilities. globals.css already binds `::selection` to the
//      brand pair document-wide, so repeating it here would be a second copy of
//      one decision.
//   7. An `aria-label`, or any other invented accessible name. See the
//      accessibility contract on the component below.
//   8. A literal colour, length, radius or shadow. This file resolves every one
//      of those to a token; globals.css is the only place such a value is
//      allowed to be written down.
// =============================================================================

import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

type InputProps = ComponentProps<'input'> & {
  /**
   * Marks the field as having failed validation.
   *
   * Drives two things at once, which is why it exists as a prop rather than as a
   * class the caller applies: the `--color-danger` border and halo below, and
   * the `aria-invalid` attribute that carries the same fact to assistive
   * technology. Styling the field red by hand would announce nothing.
   *
   * Colour is never the only signal. `invalid` supplies the programmatic half;
   * the owning form supplies the visible half by rendering its message and
   * pointing `aria-describedby` at it, so the reason is readable rather than
   * merely implied by a hue.
   *
   * @defaultValue false
   */
  invalid?: boolean;
};

/**
 * The design system's text field.
 *
 * A thin, fully transparent wrapper around a native `<input>`: it contributes
 * token styling, the `invalid` state and nothing else. Every prop the element
 * accepts is forwarded untouched.
 *
 * ### Accessibility contract
 *
 * This component deliberately does **not** name itself. A field's accessible
 * name must come from a real, visible `<label>`, so pass an `id` and bind
 * `@/components/ui/label` to it with `htmlFor`. An `aria-label` invented here
 * would give every field a name that no sighted user can see and that no
 * `<label>` can override.
 *
 * The focus indicator is a token-bound outline in `--color-ring`, applied
 * through `focus-visible` so keyboard and assistive-technology users see it
 * while a mouse click does not ring the control.
 *
 * ### `react-hook-form` compatibility
 *
 * `register()` returns `{ name, onChange, onBlur, ref }` and callers spread that
 * object onto this component. All four land on the DOM node through the rest
 * spread - none is destructured, renamed, wrapped or defaulted - so
 * registration, validation and `ref`-based focus management all work exactly as
 * they do on a bare element. This is the single most important correctness
 * property of the file: intercepting any one of those four props would break
 * every form in the product silently, with no type error to catch it.
 *
 * @example A labelled, validated field
 * ```tsx
 * <Label htmlFor="email">Email</Label>
 * <Input id="email" type="email" invalid={Boolean(errors.email)}
 *        aria-describedby={errors.email ? 'email-error' : undefined}
 *        {...register('email')} />
 * {errors.email ? <p id="email-error">{errors.email.message}</p> : null}
 * ```
 */
export function Input({
  className,
  type = 'text',
  invalid = false,
  'aria-invalid': ariaInvalid,
  ...props
}: InputProps) {
  return (
    <input
      // Defaulted rather than hardcoded: a caller passing `type="email"`,
      // `"password"`, `"search"` or `"number"` wins, because a destructuring
      // default only applies when the prop is absent. Naming it explicitly means
      // a field is never left as the browser's implicit text input by accident.
      type={type}
      // `invalid` is mirrored into ARIA, but an explicitly supplied
      // `aria-invalid` always wins - a form that computes the attribute itself,
      // or that needs `"grammar"` or `"spelling"` rather than a boolean, keeps
      // control. `??` rather than `||` so a deliberate `aria-invalid={false}`
      // survives instead of being treated as absent.
      //
      // When neither is supplied the attribute is omitted altogether. Rendering
      // a literal `aria-invalid="false"` on every field in the product would be
      // noise in the accessibility tree that says nothing the default state does
      // not already say.
      aria-invalid={ariaInvalid ?? (invalid || undefined)}
      className={cn(
        // --- Box -------------------------------------------------------------
        // `block w-full` so a field fills its form row. `min-w-0` so it can also
        // shrink inside a flex row: an <input> carries an intrinsic minimum
        // width from its `size` attribute, and without this a field in a flex
        // container forces horizontal overflow at narrow viewports - which the
        // responsive criteria forbid at every width.
        //
        // `h-11` is 2.75rem = 44px, the WCAG 2.5.5 target-size floor. No design
        // source specifies a smaller field (the plan records zero attachments
        // and zero Figma frames), so the accessible minimum governs, and
        // textarea.tsx and select.tsx match it. Height, padding and radius all
        // come from the engine's `--spacing` and `--radius-*` scales.
        'block h-11 w-full min-w-0 rounded-md px-3',

        // --- Surface, boundary and text --------------------------------------
        // `border-border-strong`, NOT `border-border`. globals.css splits those
        // two deliberately: `--color-border` is a decorative hairline (1.23:1 in
        // light, 1.73:1 in dark) which WCAG 1.4.11 exempts for card outlines and
        // table rules, whereas the boundary of an interactive control is what
        // identifies the control and has to clear 3:1. `--color-border-strong`
        // measures 4.77:1 on the light surface and 3.74:1 on the dark one, and
        // that file names input, textarea, select and checkbox as its consumers.
        //
        // `shadow-xs` is what keeps the field readable when it sits flush on a
        // `bg-surface` card, where the fill alone cannot distinguish it.
        //
        // `text-base` is 1rem = 16px and is chosen over `text-sm` for the entire
        // field family: iOS Safari zooms the viewport when a focused control's
        // text is smaller than 16px, a real defect at the 375px viewport the
        // responsive criteria test.
        'border-border-strong bg-surface text-foreground border text-base shadow-xs',

        // --- Placeholder -----------------------------------------------------
        // A placeholder is a hint, not content, so it takes the secondary text
        // token - which still clears 4.5:1 on every canvas, so the hint stays
        // legible rather than merely faint.
        'placeholder:text-muted-foreground',

        // --- Focus -----------------------------------------------------------
        // An outline, not a `ring` box-shadow, and restated here rather than left
        // to the `:focus-visible` floor in globals.css. Three reasons: the
        // outline survives an ancestor's `overflow: hidden`; `outline-2` and
        // `outline-offset-2` are exactly what that floor emits, so layering on
        // the same mechanism cannot change the indicator's thickness or position;
        // and utilities outrank the base layer, so the field keeps a visible
        // indicator even if the document floor is ever narrowed.
        //
        // `focus-visible:border-ring` adds a second cue inside the control's own
        // edge, so focus is legible even where an outline is clipped. No bare
        // `outline-none` appears anywhere in this file - removing the indicator
        // would breach the accessibility floor outright.
        'focus-visible:border-ring focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',

        // --- Disabled --------------------------------------------------------
        // Recessed fill plus a not-allowed cursor, so the state is readable from
        // both the surface and the pointer rather than from opacity alone.
        // WCAG 1.4.3 exempts inactive controls from the contrast minimum, which
        // is what makes the dimming legitimate here and nowhere else.
        'disabled:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60',

        // --- Motion ----------------------------------------------------------
        // The border and outline colours ease between states instead of snapping.
        // `motion-safe:` is the engine's own `prefers-reduced-motion:
        // no-preference` variant, which is how the accessibility guidance
        // requires transitions to be gated - this is not a hand-authored media
        // query, and the file authors no responsive breakpoint at all.
        'motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out',

        // --- Invalid ---------------------------------------------------------
        // Danger border plus a soft halo of the same token, so the error reads
        // at a glance without the field having to grow or move.
        //
        // The two `focus-visible:` entries are the point of this group: they
        // override the brand-coloured focus treatment above, because a field
        // that turned indigo the moment it was focused would drop its error
        // signal exactly when the user arrived to fix it. `--color-danger`
        // measures 6.42:1 on the light surface and 6.97:1 on the dark one, so a
        // red indicator still clears the 3:1 non-text floor and focus stays as
        // visible as it is on a valid field.
        invalid &&
          'border-danger ring-danger/20 focus-visible:border-danger focus-visible:outline-danger ring-2',

        // Last, so a caller's class wins its Tailwind group. That determinism is
        // `cn()`'s whole purpose and is what keeps consumers from reaching for an
        // arbitrary value or an inline style to win a specificity fight.
        className,
      )}
      {...props}
    />
  );
}
