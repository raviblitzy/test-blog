// =============================================================================
// textarea.tsx - the design system's multi-line text field.
//
// One of the fifteen primitives under src/components/ui/ that ARE this project's
// design system. No component library was specified for this product, so this
// directory is the system - and the behavioural-primitive library the six
// wrapper primitives draw on ships no textarea at all, so this file is the whole
// of that element's treatment rather than a skin over someone else's. The
// project rule "project primitives over raw elements" names <textarea>
// explicitly, and THIS FILE is the one place that element is wrapped:
// src/components/blog/post-editor.tsx and src/components/blog/comment-form.tsx
// import `Textarea` instead of writing their own field.
//
// input.tsx IS THIS FILE'S SPECIFICATION, AND NOW ITS SOURCE.
//
// Boundary colour, border width, radius, inline padding, fill, text colour, text
// size, focus treatment, disabled treatment, invalid treatment and transition are
// not restated here: they are IMPORTED from input.tsx as FIELD_CONTROL_CLASSES
// and FIELD_INVALID_CLASSES. A title field and a body field stacked in one form
// have to read as one control family, and two independently plausible sets of
// field tokens read as two near-misses - so the family has one definition and
// this file consumes it.
//
// That import replaces what used to be a deliberate copy kept in step by review.
// The copy was the defect: nothing failed when the two drifted, so "change both in
// the same commit" was an obligation with no enforcement behind it. select.tsx's
// trigger consumes the same two constants, so all three controls now change
// together by construction. input.tsx says the same thing from its side.
//
// Only what a multi-line control genuinely needs is declared below: no fixed
// height, a minimum height, vertical padding to match input's optical inset, a
// resize handle constrained to one axis, and its own `::placeholder` rule. Each is
// justified at its class.
//
// DELIBERATELY ABSENT. Please do not add:
//
//   1. `'use client'`. This module has no hook, no state and no browser API, so
//      it stays a shared module usable from either environment. The forms that
//      use it are already client components themselves - the directive belongs
//      to them, not here.
//   2. `forwardRef`. On React 19 `ref` is an ordinary prop and rides the spread
//      below into the DOM node. A `forwardRef` wrapper would still work but adds
//      an indirection the runtime no longer needs, and `ref` reaching the
//      element is load-bearing here (see the react-hook-form note below).
//   3. Auto-growing height, in either of its two forms. A JavaScript
//      implementation needs `scrollHeight` and a ResizeObserver, which would
//      force `'use client'` onto every route that renders a field and
//      contradict the first entry above. The declarative form,
//      `field-sizing-content`, does
//      exist in the installed engine - verified by compiling it - but the
//      underlying `field-sizing` property is Chromium-only, so the primitive's
//      geometry would depend on the visitor's browser, which is not something a
//      design system may leave undecided. `resize-y` hands the choice to the
//      user instead, in every browser, with no client bundle.
//   4. A `rows` default. The min-height floor below already governs the resting
//      size, so a default here would be a second, competing height authority -
//      and the one a caller is most likely to set. `rows` is passed through and
//      wins whenever it asks for more than the floor.
//   5. A `dark:` conditional. Every colour below is a semantic token, and
//      src/app/globals.css gives each one a `:root` value and a `.dark` value.
//      The field themes with no branching in this file - that indirection is the
//      whole point of the token layer.
//   6. A `class-variance-authority` variant table. cva earns its keep from two
//      or more independent axes; this primitive has exactly one boolean, so a
//      `cn()` conditional is the smaller and more legible form. button.tsx and
//      badge.tsx, which do have size and intent axes, are where cva belongs.
//   7. A toolbar, a contenteditable surface, or any Markdown parsing. Authoring
//      in this product is plain Markdown with a live preview, and both halves of
//      that belong to post-editor.tsx: the preview is its concern, and rich-text
//      WYSIWYG authoring is out of scope for the product entirely. This file
//      contributes a field, not an editor.
//   8. An `aria-label`, or any other invented accessible name. See the
//      accessibility contract on the component below.
//   9. A literal colour, length, radius or shadow. This file resolves every one
//      of those to a token; globals.css is the only place such a value is
//      allowed to be written down.
//  10. A breakpoint variant. The editor's responsive behaviour - stacked below
//      48rem, side-by-side at 64rem - is the page's layout decision, taken in
//      post-editor.tsx and its route. A field that carried its own breakpoints
//      would fight whatever container it was placed in.
// =============================================================================

import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

import { FIELD_CONTROL_CLASSES, FIELD_INVALID_CLASSES } from './input';

type TextareaProps = ComponentProps<'textarea'> & {
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
 * The design system's multi-line text field.
 *
 * A thin, fully transparent wrapper around a native `<textarea>`: it contributes
 * token styling, the `invalid` state and nothing else. Every prop the element
 * accepts is forwarded untouched.
 *
 * ### Sizing contract
 *
 * The field has a token minimum height and no fixed height, so the two ways a
 * caller can size it compose instead of competing:
 *
 * - `rows` sets the resting height whenever it asks for more than the floor - a
 *   long-form body field passes `rows={16}` and gets it.
 * - The `min-h-24` floor applies otherwise, so a field that omits `rows`
 *   resolves to roughly three lines rather than the browser's default two. To go
 *   *below* the floor, pass a smaller `min-h-*` in `className`; `cn` resolves
 *   the conflict in the caller's favour.
 * - The user then has the final say through the vertical resize handle.
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
 * @example A labelled, validated body field
 * ```tsx
 * <Label htmlFor="content">Content</Label>
 * <Textarea id="content" rows={16} placeholder="Write your post..."
 *           invalid={Boolean(errors.content)}
 *           aria-describedby={errors.content ? 'content-error' : undefined}
 *           {...register('content')} />
 * {errors.content ? <p id="content-error">{errors.content.message}</p> : null}
 * ```
 */
export function Textarea({
  className,
  invalid = false,
  'aria-invalid': ariaInvalid,
  ...props
}: TextareaProps) {
  return (
    <textarea
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
        // Surface, boundary, text, focus, disabled and motion - the shared field
        // vocabulary declared in ./input, consumed identically by that control and
        // by select.tsx's trigger.
        FIELD_CONTROL_CLASSES,

        // --- What is specific to a multi-line control -------------------------
        // `block` because a <textarea> is inline-block by default, which leaves a
        // baseline gap under it that reads as uneven spacing in a form column.
        //
        // `min-h-24` is the floor described in the sizing contract above, taken
        // from the engine's `--spacing` scale rather than written as a length. No
        // `h-*`: a fixed height would override `rows` and make the resize handle
        // pointless, which is why this control takes a minimum where Input takes
        // `h-11`.
        //
        // `py-2.5` is the vertical padding a single-line field has no need of,
        // chosen so the first line of text lands where `Input` puts its own: that
        // control centres a 1.5rem line box in a 2.75rem box, an optical inset of
        // 10px, which is what this step of the spacing scale resolves to. A title
        // field and a body field in one form therefore share a text edge. It emits
        // `padding-block`, so it is correct under a right-to-left writing mode.
        'block min-h-24 py-2.5',

        // `resize-y`, not the browser's default `resize: both`. Horizontal drag is
        // not a feature being withheld: it lets a visitor widen the field past its
        // container and produce exactly the horizontal overflow the responsive
        // criteria forbid at every width. Vertical growth is the axis a writer
        // actually wants, and it costs the layout nothing.
        'resize-y',

        // A placeholder is a hint, not content, so it takes the secondary text
        // token - which still clears 4.5:1 on every canvas. This is the real
        // `::placeholder` pseudo-element, which is why it is stated per control
        // rather than shared: the select trigger has none and reaches the same
        // intent through Radix's `data-placeholder` attribute.
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
