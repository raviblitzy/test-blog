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
// IT IS ALSO THE HOUSE STYLE FOR THE WHOLE FIELD FAMILY, AND NOW LITERALLY SO.
// The shared surface, boundary, focus, disabled, motion and invalid classes are
// exported from this file as FIELD_CONTROL_CLASSES and FIELD_INVALID_CLASSES;
// textarea.tsx and select.tsx's trigger import them. The three therefore read as
// one control family by construction rather than by three copies of the same
// string being edited in the same commit and hoped to stay in step - which is how
// a "near-miss" family happens. Each of the three keeps only what is genuinely
// its own: its display mode, its height or minimum height, its resize behaviour,
// its placeholder mechanism, and in the select's case the flex row that holds a
// value beside a chevron.
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

/**
 * The field-control class set shared by every control in this family.
 *
 * Imported by `@/components/ui/textarea` and by `@/components/ui/select`'s
 * trigger, so a change here reaches all three at once and the family cannot
 * drift. Each group below is here because it is genuinely identical across the
 * three; anything element-specific is left at the call site.
 *
 *   `w-full min-w-0 rounded-md px-3`
 *     A field fills its form row, and `min-w-0` is what lets it also SHRINK
 *     inside a flex row. Every one of these controls carries an intrinsic minimum
 *     width - an `<input>` from its `size`, a `<textarea>` from its `cols`, the
 *     select trigger from its own content - and without this a field in a flex
 *     container forces horizontal overflow at narrow viewports, which the
 *     responsive criteria forbid at every width. Radius and inline padding come
 *     from the engine's `--radius-*` and `--spacing` scales; `px-*` emits
 *     `padding-inline`, so it is already correct under a right-to-left writing
 *     mode.
 *
 *   `border-muted-foreground bg-surface text-foreground border text-base shadow-xs`
 *     `border-muted-foreground`, NOT `border-border`. `--color-border` is a
 *     decorative hairline (1.23:1 in light, 1.73:1 in dark) which WCAG 1.4.11
 *     exempts for card outlines and table rules, whereas the boundary of an
 *     interactive control is what identifies the control and has to clear 3:1.
 *     The fourteen-token catalogue in globals.css is closed, so this composes
 *     from the one neutral already guaranteed legible on every canvas:
 *     `--color-muted-foreground` measures 7.23:1 on the light background and
 *     6.90:1 on light surface-muted, 7.68:1 and 5.58:1 in dark. That file names
 *     input, textarea, the select trigger and the secondary button as the
 *     consumers of this composition.
 *     `shadow-xs` is what keeps a field readable when it sits flush on a
 *     `bg-surface` card, where the fill alone cannot distinguish it. `text-base`
 *     is 1rem and is chosen over `text-sm` for the whole family: iOS Safari zooms
 *     the viewport when a focused control's text is smaller than 16px, a real
 *     defect at the 375px viewport the responsive criteria test.
 *
 *   the `focus-visible:` group
 *     An outline, not a `ring` box-shadow, and restated here rather than left to
 *     the `:focus-visible` floor in globals.css. Three reasons: the outline
 *     survives an ancestor's `overflow: hidden`; `outline-2` and
 *     `outline-offset-2` are exactly what that floor emits, so layering on the
 *     same mechanism cannot change the indicator's thickness or position; and
 *     utilities outrank the base layer, so a field keeps a visible indicator even
 *     if the document floor is ever narrowed. `focus-visible:border-ring` adds a
 *     second cue inside the control's own edge. No bare `outline-none` appears
 *     anywhere in this family - removing the indicator would breach the
 *     accessibility floor outright.
 *
 *   the `disabled:` group
 *     A recessed fill plus a not-allowed cursor, so the state is readable from
 *     both the surface and the pointer rather than from opacity alone. WCAG 1.4.3
 *     exempts inactive controls from the contrast minimum, which is what makes
 *     the dimming legitimate here and nowhere else. It reaches the select trigger
 *     too, because Radix forwards `disabled` to a real `<button>`.
 *
 *   the `motion-safe:` group
 *     Border and outline colours ease between states instead of snapping.
 *     `motion-safe:` is the engine's own `prefers-reduced-motion: no-preference`
 *     variant, which is how transitions are required to be gated; it is not a
 *     hand-authored media query, and no file in this family authors one.
 *     `transition-colors` and not `transition-all`, so a textarea being dragged
 *     by its resize handle does not animate against the pointer.
 *
 * Deliberately NOT included: the placeholder colour. `<input>` and `<textarea>`
 * tint a real `::placeholder`, while the select trigger has no placeholder
 * pseudo-element and tints itself through Radix's `data-placeholder` attribute
 * instead. They are two different mechanisms for one intent, so each control
 * states its own and neither emits a rule the other cannot use.
 */
export const FIELD_CONTROL_CLASSES = cn(
  'w-full min-w-0 rounded-md px-3',
  'border-muted-foreground bg-surface text-foreground border text-base shadow-xs',
  'focus-visible:border-ring focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',
  'disabled:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60',
  'motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out',
);

/**
 * The classes added to any control in this family when it is in an invalid state.
 *
 * A danger border plus a soft halo of the same token, so the error reads at a
 * glance without the field having to grow or move.
 *
 * The two `focus-visible:` entries are the point of this set rather than an
 * afterthought: they OVERRIDE the brand-coloured focus treatment in
 * {@link FIELD_CONTROL_CLASSES}, because a field that turned indigo the moment it
 * was focused would drop its error signal exactly when the user arrived to fix
 * it. globals.css measures `--color-danger` at 6.42:1 on the light surface and
 * 6.97:1 on the dark one, so a red indicator still clears the 3:1 non-text floor
 * and focus stays as visible as it is on a valid field.
 *
 * Colour is never the only signal: each control mirrors its invalid state into
 * `aria-invalid`, and the owning form supplies the visible half by rendering its
 * message and pointing `aria-describedby` at it, so the reason is readable rather
 * than merely implied by a hue.
 */
export const FIELD_INVALID_CLASSES =
  'border-danger ring-danger/20 focus-visible:border-danger focus-visible:outline-danger ring-2';

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
        // Surface, boundary, text, focus, disabled and motion - the whole shared
        // vocabulary, declared once above and consumed identically by
        // textarea.tsx and select.tsx's trigger.
        FIELD_CONTROL_CLASSES,

        // --- What is specific to a single-line input --------------------------
        // `block` because a bare <input> is inline-block, which leaves a baseline
        // gap under it that reads as uneven spacing in a form column.
        //
        // `h-11` is 2.75rem = 44px, the WCAG 2.5.5 target-size floor. No design
        // source specifies a smaller field (the plan records zero attachments and
        // zero Figma frames), so the accessible minimum governs; select.tsx's
        // trigger matches it exactly, which is what makes a picker and a text
        // field line up in the same form row, and textarea.tsx uses a minimum
        // height instead because a body field grows.
        'block h-11',

        // A placeholder is a hint, not content, so it takes the secondary text
        // token - which still clears 4.5:1 on every canvas, so the hint stays
        // legible rather than merely faint. This is the real `::placeholder`
        // pseudo-element; the select trigger reaches the same intent through
        // Radix's `data-placeholder` attribute instead, which is why the rule is
        // not in the shared set.
        'placeholder:text-muted-foreground',

        invalid && FIELD_INVALID_CLASSES,

        // Last, so a caller's class wins its Tailwind group. That determinism is
        // `cn()`'s whole purpose and is what keeps consumers from reaching for an
        // arbitrary value or an inline style to win a specificity fight.
        className,
      )}
      {...props}
    />
  );
}
