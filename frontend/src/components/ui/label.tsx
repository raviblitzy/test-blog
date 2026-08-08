// Label - the form-label primitive of this project's design system.
//
// src/components/ui/ IS the design system: feature code consumes these fifteen
// primitives and never reaches past them to a raw element or to Radix directly.
// This file is one of the six that WRAP an accessible Radix behavioural
// primitive - select, label, dialog, dropdown-menu, tabs, avatar - rather than
// one of the nine authored over semantic HTML. The distinction sets the scope of
// this module precisely: it adds token typography and nothing else. Behaviour,
// markup and the accessible name all belong to the primitive underneath.
//
// It is load-bearing for the project's accessibility floor - "every form control
// is associated with a label" - so it is used by every credential form, the post
// editor, the comment form and the admin category form, always as
// `<Label htmlFor={id}>` beside a control carrying that same `id`.
//
// ---------------------------------------------------------------------------
// 1. WHY THIS WRAPS RADIX RATHER THAN RENDERING A RAW <label>
//
// Two behaviours, and only the first is native:
//
//   * Click-to-focus. A native `<label for="x">` moves focus to (and activates)
//     the control with `id="x"`. That is the browser's doing, and it is why
//     `htmlFor` has to reach the DOM untouched - see the JSDoc below.
//   * Double-click without text selection. Radix attaches an `onMouseDown` that
//     calls `preventDefault()` when `event.detail > 1`, so double-clicking a
//     label focuses the control instead of selecting the label's words. It first
//     bails out when the event originated inside a nested button, input, select
//     or textarea, so a control rendered *within* a label keeps its own
//     semantics, and it invokes a caller's own `onMouseDown` before deciding -
//     which is why a consumer's handler still runs and can opt out by calling
//     `preventDefault()` itself.
//
// The second is exactly the kind of hand-rolled interaction the project rule
// "behavioural primitives over hand-rolled interaction" exists to prevent being
// reimplemented per component. Nothing below overrides `onMouseDown`.
//
// ---------------------------------------------------------------------------
// 2. WHY THERE IS NO 'use client' DIRECTIVE - DO NOT ADD ONE
//
// This module calls no hook, reads no browser API and holds no state, so it has
// no reason to open a client boundary. `@radix-ui/react-label` already ships
// `"use client"` at the top of its own bundle, so the boundary is drawn at the
// package - one level lower - and is drawn whether this file asks for it or not.
//
// Leaving this module directive-free is what lets a Server Component render a
// form label directly, keeping the label text in the initial HTML. Adding the
// directive would pull every consumer of this file into the client graph and
// widen the islands that the server-rendering rule deliberately keeps narrow.
//
// ---------------------------------------------------------------------------
// 3. WHY THERE IS NO forwardRef
//
// React 19 passes `ref` as an ordinary prop to function components, so the rest
// spread below carries it through to the primitive with no ceremony. `ref` is
// part of the derived props type because Radix's `Root` is a
// `ForwardRefExoticComponent`, so `<Label ref={...}>` type-checks and lands on
// the underlying `<label>` element.
//
// ---------------------------------------------------------------------------
// 4. DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT.
//
//   1. A wrapper element. Exactly one node is rendered. A <div> or <span> around
//      the primitive would break `flex`/`grid` parents that expect the label to
//      be a direct child, and would defeat the `peer-disabled:` variant by
//      inserting a node between the peer control and the styled sibling.
//   2. A nested <label>. Nested labels are invalid HTML and give a control two
//      competing accessible names.
//   3. An injected `aria-label` (or `aria-labelledby`, or `title`) default.
//      `aria-label` overrides the element's text as the accessible name, so a
//      default here would silently rename every control in the application and
//      make the accessible-name assertions in the component tests describe
//      something the user cannot see. A caller may still pass one explicitly.
//   4. Any transformation of `children` - no required-field asterisk, no
//      `String(children)`, no wrapping span. The visible text is the accessible
//      name and must stay exactly what the caller wrote. A required marker is
//      content, so it belongs in the caller's children.
//   5. A re-export of `LabelPrimitive.Root`, `LabelPrimitive.Label` or a
//      `labelVariants` table. The component mapping lists exactly one part for
//      this file - `Label` - and the label has exactly one appearance, so a
//      variant table would be an empty abstraction. Consumers that need a
//      different size or weight pass `className`, which wins deterministically.
//   6. `display` of any kind - no `block`, no `inline-flex`, no `gap`. A label
//      is inline by default and the field wrappers that use it own their own
//      layout; forcing a display value here would fight them and would change
//      behaviour, which this wrapper is not permitted to do.
//   7. A focus ring. globals.css already applies a `:focus-visible` outline to
//      every focusable element, and a label is not focusable in the first place.
//   8. A `dark:` conditional. The colour tokens are dual-valued - declared once
//      at `:root` and again under `.dark` - so `text-foreground` themes itself.
//      A `dark:` variant here would be a second, competing source of truth.
//   9. `select-none`. Radix's `onMouseDown` already suppresses the double-click
//      selection that motivates it, and blocking selection outright would take
//      away a reader's ability to copy a field name.
//  10. Any literal colour, size, radius or shadow. Every value below resolves to
//      a named token - see the Typography note on the component's own doc block.
//  11. `overflow-wrap: break-word`. Considered and rejected: globals.css already
//      applies it to the flow containers that hold reader-supplied text, whereas
//      a field caption is short, developer-authored copy. Forcing a wrapping
//      rule here would be a layout decision, not typography, and this wrapper's
//      remit is typography. A caption that genuinely needs it - one carrying an
//      unbroken slug or URL - passes `wrap-break-word` through `className`.

import type { ComponentProps, JSX } from 'react';

import * as LabelPrimitive from '@radix-ui/react-label';

import { cn } from '@/lib/utils';

/**
 * Props of the underlying Radix label root, derived from the component itself so
 * this wrapper cannot drift from the installed package's real surface.
 *
 * Because that component is a `ForwardRefExoticComponent`, the derived type
 * already includes `ref` alongside every intrinsic `<label>` attribute -
 * `htmlFor`, `children`, `id`, `className`, `style`, every `on*` handler, every
 * `aria-*` and every `data-*`. Nothing is added and nothing is omitted, so any
 * attribute a consumer could put on a `<label>` is accepted here and reaches the
 * DOM unchanged.
 *
 * Kept module-local on purpose: the public surface of this module is the single
 * `Label` component. A consumer that needs the type derives it the same way,
 * with `ComponentProps<typeof Label>`, which cannot fall out of step.
 */
type LabelProps = ComponentProps<typeof LabelPrimitive.Root>;

/**
 * The design-system form label.
 *
 * A thin, token-styled wrapper over `@radix-ui/react-label`. It renders a single
 * `<label>` element, adds the project's label typography, and forwards every
 * prop - including `ref` - to the primitive untouched.
 *
 * ### Associating the label with its control
 *
 * `htmlFor` must carry the `id` of the control being labelled. That pairing is
 * what gives the control its accessible name and what makes clicking the label
 * focus it; without it the label is decorative text and the control is unnamed.
 *
 * ```tsx
 * <Label htmlFor="post-title">Title</Label>
 * <Input id="post-title" name="title" />
 * ```
 *
 * Wrapping the control in the label instead of pairing by `id` also works, and
 * the primitive handles it correctly - a mouse press that starts inside the
 * nested control is left entirely alone.
 *
 * ### The disabled affordance, and the DOM order it requires
 *
 * When the labelled control is disabled the label turns muted and shows a
 * `not-allowed` cursor. This is driven by Tailwind's built-in `peer-disabled:`
 * variant, which compiles to a *following-sibling* selector, so it applies only
 * when the label comes **after** an element marked `peer` in the same parent:
 *
 * ```tsx
 * <div className="flex items-center gap-2">
 *   <Input id="notify" type="checkbox" className="peer" disabled />
 *   <Label htmlFor="notify">Email me about replies</Label>
 * </div>
 * ```
 *
 * With the label placed first in the DOM - the usual arrangement for a stacked
 * field, where the caption sits above its control - CSS cannot look forward to
 * the control, so the affordance stays inert rather than misfiring. That is a
 * property of the sibling combinator, not a defect here, and it is why the
 * styling is additive: a label with no `peer` before it simply renders in its
 * rest appearance, so the two arrangements differ only in whether the muted
 * treatment appears.
 *
 * ### Typography
 *
 * Every value resolves to a token from `src/app/globals.css` or the engine's own
 * scales - `--text-sm`, the medium font weight, `--leading-tight`,
 * `--color-foreground` and `--color-muted-foreground`. There is no literal
 * colour, size, radius or shadow, and no `dark:` conditional: the colour tokens
 * are dual-valued, so the label follows the active theme on its own.
 *
 * @param className - Extra classes, merged last so they win their Tailwind
 * group. This is the supported way to change the label's size, weight or colour
 * at a call site; `cn` resolves the conflict deterministically.
 * @param props - Every other `<label>` attribute, including `htmlFor`,
 * `children` and `ref`. Spread onto the primitive verbatim.
 * @returns One `<label>` element carrying the label typography.
 */
export function Label({ className, ...props }: LabelProps): JSX.Element {
  return (
    <LabelPrimitive.Root
      className={cn(
        // Rest appearance. `text-foreground` is deliberately explicit rather
        // than inherited from the body: it gives the disabled colour below a
        // definite value to revert from, and keeps the label readable inside a
        // container that sets a different text colour.
        //
        // THE ORDER OF THESE FOUR IS LOAD-BEARING - do not shuffle them.
        // `leading-tight` MUST stay after `text-sm`, because tailwind-merge
        // treats the font-size group as conflicting with the leading group (a
        // Tailwind `text-*` size also carries a line height). Measured: this
        // string round-trips through `cn` intact, while the same four classes
        // with `leading-tight` moved in front of `text-sm` come back as
        // `text-foreground text-sm font-medium` - the leading token silently
        // dropped, with no failing test and no lint warning to notice it by.
        // The order below is also what prettier-plugin-tailwindcss produces, so
        // `prettier --write` keeps it rather than reintroducing the hazard.
        'text-foreground text-sm leading-tight font-medium',
        // Disabled affordance, additive and inert unless a `peer` control
        // precedes the label. A muted token rather than an opacity value, so the
        // result stays a real, contrast-checked colour in both themes.
        'peer-disabled:text-muted-foreground peer-disabled:cursor-not-allowed',
        className,
      )}
      {...props}
    />
  );
}
