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
// input.tsx IS THIS FILE'S SPECIFICATION, NOT MERELY ITS NEIGHBOUR.
//
// Every token below - boundary colour, border width, radius, fill, text colour,
// text size, placeholder colour, focus treatment, disabled treatment, invalid
// treatment and transition - is the same choice input.tsx makes, class for class.
// That is the requirement rather than a coincidence: a title field and a body
// field stacked in one form have to read as one control family, and two
// independently plausible sets of field tokens would read as two near-misses.
//
// It is a deliberate copy and not an import. Each primitive in this directory
// stands alone, so nothing is re-exported between them and there is no shared
// field base to inherit from; the two files are instead kept in step by review,
// and a field token changed in one has to change in the other in the same
// commit. input.tsx says the same thing from its side.
//
// Only the box geometry diverges, and only where a multi-line control genuinely
// needs it: no fixed height, vertical padding to match, and a resize handle
// constrained to one axis. Each of those three is justified at its class below.
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
        // --- Box -------------------------------------------------------------
        // `block` because a <textarea> is inline-block by default, which leaves
        // a baseline gap under it that reads as uneven spacing in a form column.
        //
        // `w-full min-w-0` is the pair that keeps the field off the horizontal
        // scrollbar. A <textarea> carries an intrinsic minimum width from its
        // `cols` attribute - twenty character columns even when nothing sets it
        // - so without `min-w-0` a field inside a flex row refuses to shrink
        // and forces overflow at the narrow viewport the responsive criteria
        // test. This is the same reason input.tsx carries it.
        //
        // `min-h-24` is the floor described in the sizing contract above, taken
        // from the engine's `--spacing` scale rather than written as a length,
        // and `rounded-md` from its radius scale. No `h-*`: a fixed height would
        // override `rows` and make the resize handle pointless.
        //
        // `px-3` is input.tsx's horizontal padding unchanged. `py-2.5` is the
        // vertical half a single-line field has no need of, chosen so the first
        // line of text lands where `Input` puts its own: that control centres a
        // 1.5rem line box in a 2.75rem box, an optical inset of 10px, which is
        // what this step of the spacing scale resolves to. A title field and a
        // body field in one form therefore share a text edge.
        //
        // Both padding utilities emit LOGICAL properties - `padding-inline` and
        // `padding-block` - so the field is correct under a right-to-left
        // writing mode without a second declaration.
        'block min-h-24 w-full min-w-0 rounded-md px-3 py-2.5',

        // `resize-y`, not the browser's default `resize: both`. Horizontal drag
        // is not a feature being withheld: it lets a visitor widen the field
        // past its container and produce exactly the horizontal overflow the
        // responsive criteria forbid at every width. Vertical growth is the axis
        // a writer actually wants, and it costs the layout nothing.
        'resize-y',

        // --- Surface, boundary and text --------------------------------------
        // `border-border-strong`, NOT `border-border`. globals.css splits those
        // two deliberately: `--color-border` is a decorative hairline (1.23:1 in
        // light, 1.73:1 in dark) which WCAG 1.4.11 exempts for card outlines and
        // table rules, whereas the boundary of an interactive control is what
        // identifies the control and has to clear 3:1. `--color-border-strong`
        // measures 4.77:1 on the light surface and 3.74:1 on the dark one, and
        // that file names textarea among its intended consumers by name.
        //
        // `shadow-xs` is what keeps the field readable when it sits flush on a
        // `bg-surface` card, where the fill alone cannot distinguish it.
        //
        // `text-base` is 1rem and is chosen over `text-sm` for the entire field
        // family: iOS Safari zooms the viewport when a focused control's text is
        // smaller than 16px, a real defect at the 375px viewport the responsive
        // criteria test - and a body field is where a visitor spends the most
        // time zoomed in.
        'border-border-strong bg-surface text-foreground border text-base shadow-xs',

        // --- Placeholder -----------------------------------------------------
        // A placeholder is a hint, not content, so it takes the secondary text
        // token - which still clears 4.5:1 on every canvas, so the hint stays
        // legible rather than merely faint.
        'placeholder:text-muted-foreground',

        // --- Focus -----------------------------------------------------------
        // An outline, not a `ring` box-shadow, and restated here rather than
        // left to the `:focus-visible` floor in globals.css. Three reasons: the
        // outline survives an ancestor's `overflow: hidden`; `outline-2` and
        // `outline-offset-2` are exactly what that floor emits, so layering on
        // the same mechanism cannot change the indicator's thickness or
        // position; and utilities outrank the base layer, so the field keeps a
        // visible indicator even if the document floor is ever narrowed.
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
        // The border and outline colours ease between states instead of
        // snapping. `motion-safe:` is the engine's own `prefers-reduced-motion:
        // no-preference` variant, which is how the accessibility guidance
        // requires transitions to be gated - this is not a hand-authored media
        // query, and the file authors no responsive breakpoint at all.
        //
        // `transition-colors` and not `transition-all`: the field's height
        // changes when the user drags the handle, and animating that would fight
        // the pointer.
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
