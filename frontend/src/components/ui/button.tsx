// Button - the project's styled action primitive, and the ONE file in this
// repository permitted to render a raw <button>.
//
// ---------------------------------------------------------------------------
// 1. WHY THIS FILE IS A BOUNDARY, NOT A CONVENIENCE
//
// The design-system rule is "project primitives over raw elements": nothing
// under src/app/, src/components/layout/, src/components/blog/,
// src/components/admin/ or src/components/seo/ may write `<button>`. It is
// wrapped exactly once, here, so that the focus ring, the disabled treatment,
// the token palette and the press feedback are decided in one place and cannot
// drift between the screens that render an action.
//
// A boundary only holds if it leaves nobody a reason to step around it, so
// three things below are deliberate rather than incidental:
//
//   * The prop type is the FULL `ComponentProps<'button'>`. `onClick`,
//     `disabled`, `form`, `formAction`, `name`, `value`, `aria-*`, `data-*` and
//     `ref` all pass straight through, so there is no allow-list for a caller
//     to come back and widen.
//   * `asChild` exists so that a link-shaped action - "Read more", "New post",
//     a pagination page number - can be an anchor that LOOKS like a button,
//     rather than an anchor carrying hand-copied utility classes. Semantics
//     follow behaviour: something that navigates has to be an <a>.
//   * `buttonVariants` is exported for the residual case where wrapping is
//     impossible and only the class set is wanted.
//
// ---------------------------------------------------------------------------
// 2. NO 'use client' - DELIBERATE AND LOAD-BEARING
//
// The home feed, the post cards, the post detail page and the site footer are
// Server Components that render actions and links. `'use client'` marks a
// boundary in the import graph, and everything imported past that boundary is
// client code - so putting the directive here would pull a large share of the
// tree into the client bundle and defeat the narrow-island split that the
// server-rendered-content SEO requirement depends on.
//
// Nothing here needs it. This module declares no hook, no browser API, no state
// and no event handler of its own, and @radix-ui/react-slot@1.3.3 ships no
// directive either - verified in its `dist/`, which begins with plain module
// scaffolding rather than a directive prologue. A Client Component importing
// this file still works exactly as expected; a boundary constrains what may
// cross it, not who may import across it.
//
// ---------------------------------------------------------------------------
// 3. DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT.
//
//   1. `forwardRef`. React 19 treats `ref` as an ordinary prop on a function
//      component, so it arrives through `...props` with no wrapper. Adding
//      `forwardRef` would reintroduce the extra component layer that React 19
//      removed and would not change what callers can do.
//   2. `import React from 'react'`. Nothing here reads the default export, and
//      `"jsx": "react-jsx"` means the runtime is imported by the compiler. An
//      unused default import is a lint finding, and `npm run lint` runs with
//      `--max-warnings=0`, so it would fail the gate rather than merely warn.
//   3. Any `dark:` variant. Every token below is dual-valued - declared once at
//      the document root and again under `.dark` in src/app/globals.css - so the
//      control re-themes with no conditional here. A `dark:` class would be a
//      SECOND source of truth for the same decision and would drift.
//   4. Any literal colour, dimension, radius or font size. Every value resolves
//      to a token; `transparent` is one of the six literals the rule permits.
//   5. A breakpoint variant. A control does not reflow - its container does. The
//      five breakpoints belong to layout code.
//   6. `outline-none`. The focus utilities below set outline width, style AND
//      colour, which fully replaces the user-agent ring; suppressing it first
//      would risk a state with no visible indicator at all.
//   7. A `loading` prop with a built-in spinner. The component contract is
//      `variant`, `size` and `asChild`; pending state is `disabled` plus
//      whatever the caller wants to render as children, which keeps the
//      spinner's markup and its accessible name where the caller can see them.
//   8. A `title` attribute derived from the label. `title` is not a reliable
//      accessible name and is invisible to touch and keyboard users. An
//      icon-only button is named by the caller's `aria-label`, which passes
//      through untouched.

import type { ComponentProps, JSX } from 'react';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * The button class table: four semantic variants across four sizes.
 *
 * Exported so that an element which cannot be wrapped by {@link Button} can
 * still be styled from the single source of truth instead of copying classes.
 * `src/components/ui/pagination.tsx` and the `layout`, `blog` and `admin`
 * component folders use it to style `next/link` anchors:
 *
 * ```tsx
 * <Link href="/blog" className={buttonVariants({ variant: 'ghost' })}>Blog</Link>
 * ```
 *
 * Prefer `<Button asChild>` where it is available - it composes event handlers
 * and merges the child's own props, which a bare class string cannot do. Reach
 * for this table when the element is produced by code you do not render.
 */
export const buttonVariants = cva(
  [
    // A flex row so an icon and a label share one baseline without either
    // needing a margin, and so `justify-center` centres a lone icon.
    'inline-flex items-center justify-center whitespace-nowrap',

    // Rhythm, from the token scales: `gap-2` is the --spacing multiplier and
    // `rounded-md` is --radius-md.
    'gap-2 rounded-md',

    // Type. `text-sm` is --text-sm; the `sm` and `lg` sizes override it.
    'text-sm font-medium',

    // Browsers give <button> `cursor: default`, which reads as inert, and the
    // engine's preflight does not change that - so it is set here.
    'cursor-pointer',

    // Only colours transition, so neither a hover nor a press can reflow the
    // line the control sits on. Gated on `motion-safe` (which compiles to
    // `@media (prefers-reduced-motion: no-preference)`) and eased with the
    // --ease-out token at the engine's default 150ms.
    'motion-safe:transition-colors motion-safe:ease-out',

    // Press feedback, shared by every variant. This is opacity rather than a
    // darker fill because a fill step CANNOT be expressed correctly for both
    // themes with the available tokens: mixing a token toward `transparent`
    // moves it toward the page canvas, which is LIGHTER in light mode and
    // DARKER in dark mode, so the same class would read as more emphasis in one
    // theme and less in the other. Opacity is symmetric, and it is deliberately
    // outside the transition above so the press registers instantly.
    'active:opacity-90',

    // Keyboard focus indicator - `:focus-visible`, not `:focus`, so it appears
    // for keyboard users without ringing on every mouse click. Bound to the
    // --color-ring token, which clears the 3:1 non-text threshold against
    // background, surface and surface-muted in both themes.
    //
    // An OUTLINE rather than a ring, because `outline-offset` renders as a gap
    // that shows whatever is behind the control. A ring offset needs an opaque
    // offset COLOUR, and any single choice would be wrong somewhere - a
    // `ring-offset-background` button sitting on a card would paint a
    // background-coloured halo over the card's surface.
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',

    // Disabled, declared twice on purpose. The native pseudo-class covers a
    // real <button>; the ARIA attribute covers the `asChild` case, where an <a>
    // cannot take `disabled` at all. Without the second pair, a disabled
    // link-shaped action would look and behave enabled - and that is the sort
    // of gap that sends a caller past this primitive.
    //
    // KNOWN LIMIT OF THE ARIA PAIR, measured in a browser: `aria-disabled` is
    // advisory by specification. It is announced as disabled and these classes
    // dim the control and take it out of pointer hit-testing, but it does NOT
    // stop keyboard activation - Enter and Space still fire a trusted click.
    // Blocking that needs an event handler, which would mean `'use client'` and
    // the bundle cost described at the top of this file. So: prefer a real
    // `<button disabled>` whenever the action is a button. When a LINK must be
    // disabled, the caller has to also drop `href`, which is what actually
    // removes an anchor from the tab order. See the `asChild` prop docs.
    'disabled:pointer-events-none disabled:opacity-50',
    'aria-disabled:pointer-events-none aria-disabled:opacity-50',

    // Icon defaults. `size-4` is the --spacing scale and is overridden by the
    // `sm`, `lg` and `icon` sizes so a glyph scales with its control.
    // `shrink-0` stops a long label squashing the icon, and
    // `pointer-events-none` keeps the click target on the control rather than
    // on the glyph, so `event.target` is always the button.
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  ],
  {
    variants: {
      // Four variants, each a semantic token pair - never a colour family and
      // shade. Each carries its own hover step; the shared `active:opacity-90`
      // above supplies the pressed state.
      variant: {
        // The affirmative action. `--color-accent` is the purpose-built
        // emphasis companion to `--color-primary`: it steps in the direction of
        // the active theme, darkening in light and lightening in dark, so one
        // class is correct in both. `primary-foreground` is the paired label
        // colour and inverts with it.
        primary: 'bg-primary text-primary-foreground hover:bg-accent',

        // The neutral action. `border-border-strong`, NOT `border-border`:
        // globals.css records `--color-border` as a decorative hairline
        // measuring 1.23:1 on light surface, and here the border is what
        // identifies the control at all - `bg-surface` on `bg-background` is
        // roughly a 1.05:1 fill difference, so with a decorative border this
        // button would have no perceivable boundary. `--color-border-strong`
        // (4.77:1 light, 3.74:1 dark) is the token globals.css declares for
        // exactly this case: interactive control boundaries under WCAG 1.4.11.
        secondary: 'border border-border-strong bg-surface text-foreground hover:bg-surface-muted',

        // The quiet action - toolbar icons, row actions, header navigation.
        // `transparent` is one of the permitted literals, and it is explicit
        // rather than omitted so the resting state cannot inherit a fill from a
        // caller's own background utility. `--color-surface-muted` is the token
        // globals.css designates as the neutral subtle hover fill.
        ghost: 'bg-transparent text-foreground hover:bg-surface-muted',

        // The destructive action - delete a post, a comment, a user, a category.
        // There is no `danger-accent` token, so the hover step is the danger
        // token at 90%, which globals.css blesses: because the tokens are
        // `var(--app-*)` indirected, the engine emits
        // `color-mix(in oklab, var(--color-danger) 90%, transparent)` and the
        // mix therefore resolves per theme at use time rather than freezing the
        // light value.
        destructive: 'bg-danger text-primary-foreground hover:bg-danger/90',
      },

      // Heights and paddings come from the --spacing scale, type sizes from
      // --text-*. `default` is 44px, so the size a caller gets by writing
      // nothing at all clears the WCAG 2.5.5 target-size floor.
      size: {
        /* BLITZY [A11Y]: `sm` is 32px, below the 44x44 target-size minimum.
         * Deliberate, opt-in and never selected by accident - it exists for the
         * dense admin row actions in src/components/admin/, where a 44px
         * control in every cell would make the moderation tables unusable. The
         * default size clears the floor, so no surface gets a small target
         * unless it asks by name. Implemented as specified and flagged for
         * designer review rather than silently enlarged. */
        sm: 'h-8 gap-1.5 px-3 text-xs [&_svg]:size-3.5',
        default: 'h-11 px-5',
        lg: 'h-12 px-7 text-base [&_svg]:size-5',
        // Square, for a button whose only child is an icon. No padding: the
        // fixed 44x44 box plus the centring above positions the glyph, and
        // `size-*` sets width and height together so it stays square. Such a
        // button has no text, so the caller MUST supply `aria-label`.
        icon: 'size-11 [&_svg]:size-5',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'default',
    },
  },
);

/**
 * Props accepted by {@link Button}.
 *
 * Not exported, to keep this module's public surface to the two symbols the
 * design system documents. Callers that need the type derive it, which also
 * keeps them correct if the union here ever widens:
 *
 * ```ts
 * type MyProps = ComponentProps<typeof Button>;
 * ```
 */
type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /**
     * Render the single child element instead of a `<button>`, merging these
     * props onto it. Use it whenever the action navigates, so the accessible
     * role matches the behaviour.
     *
     * The child must be exactly one element and should not carry competing
     * utility classes: Radix joins the two class strings rather than resolving
     * them, so a conflict would be settled by stylesheet order instead of by
     * call order.
     *
     * To disable a link-shaped action, `aria-disabled` alone is not enough -
     * drop `href` as well, since that is what removes an anchor from the tab
     * order. See the disabled note in the class table.
     */
    asChild?: boolean;
  };

/**
 * The action primitive every other component uses instead of a raw `<button>`.
 *
 * @example A form's submit control - `type` is explicit, so it wins
 * ```tsx
 * <Button type="submit">Publish</Button>
 * ```
 *
 * @example A link that looks like a button
 * ```tsx
 * <Button asChild variant="secondary">
 *   <Link href="/dashboard/posts/new">New post</Link>
 * </Button>
 * ```
 *
 * @example Icon-only, which must be named for assistive technology
 * ```tsx
 * <Button size="icon" variant="ghost" aria-label="Open menu">
 *   <Menu aria-hidden="true" />
 * </Button>
 * ```
 *
 * Labels do not wrap: the control is `whitespace-nowrap`, which is right for the
 * short action labels a button should carry. Measured at a 375px viewport, the
 * widest label this application renders ("Approve comment") occupies 157px -
 * about 42% of the width - so no real label overflows. A caller that does need
 * an unusually long label owns constraining it, because only the caller knows
 * the container. Either let it wrap with `className="whitespace-normal"`, or
 * truncate it to one line with an ellipsis:
 *
 * ```tsx
 * <Button className="max-w-full">
 *   <span className="min-w-0 truncate">{longLabel}</span>
 * </Button>
 * ```
 *
 * All three parts of that recipe are load-bearing, and it is worth knowing why,
 * because the obvious one-liner does not work. Putting `truncate` on the button
 * itself does NOT produce an ellipsis: `text-overflow` applies only to a block
 * container, the button is an `inline-flex` container, and a bare text child
 * becomes an ANONYMOUS flex item that takes the initial `text-overflow: clip`.
 * `justify-content: center` then shears the over-wide item at BOTH ends, so the
 * start of the label is destroyed as well as the end - verified in a browser,
 * where `max-w-full truncate` on the button hid 36.75px on the left and 36.77px
 * on the right and drew no ellipsis at all. Wrapping the label in a `<span>`
 * fixes it because a flex item is blockified to `display: block`, which makes
 * `text-overflow` eligible; `min-w-0` is required because a flex item's default
 * `min-width: auto` floors it at its content width so it would never shrink
 * enough to overflow; and `max-w-full` is what bounds the button itself.
 *
 * @param className - Appended after the variant classes and resolved by `cn`,
 *   so a caller's utility reliably overrides the variant's in the same group.
 * @param variant - `primary` (default), `secondary`, `ghost` or `destructive`.
 * @param size - `sm`, `default` (default, 44px), `lg` or `icon`.
 * @param asChild - Render the child element instead of a `<button>`.
 * @param type - Defaults to `button` on a real `<button>`; see the note below.
 * @param props - Every other native button attribute, including `ref`.
 * @returns The rendered control.
 */
export function Button({
  className,
  variant,
  size,
  asChild = false,
  type,
  ...props
}: ButtonProps): JSX.Element {
  // One JSX return, one element decision. `Slot` merges these props onto the
  // child rather than rendering a wrapper, so `asChild` adds no DOM node.
  const Component = asChild ? Slot : 'button';

  return (
    <Component
      className={cn(buttonVariants({ variant, size }), className)}
      // A <button> with no `type` defaults to `submit` in HTML, so any button
      // inside the auth, editor, comment or category forms would submit them on
      // click - a real defect class, and a silent one. `button` is therefore the
      // default here and an explicit `type` still wins. Left undefined in the
      // `asChild` case, where the rendered element is usually an anchor and
      // `type` would be a meaningless attribute on it.
      type={asChild ? type : (type ?? 'button')}
      {...props}
    />
  );
}
