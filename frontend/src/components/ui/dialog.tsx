'use client';

// dialog.tsx - the modal surface of the design system layer.
//
// Two consumers with very different shapes depend on this one primitive, and
// both have to work without either of them reaching past it:
//
//   * src/components/layout/mobile-nav.tsx - the navigation drawer. Below the
//     `md` (48rem) breakpoint the site header collapses its links into this
//     dialog, so the panel has to be comfortable at 375px and must never widen
//     the document.
//   * the admin row actions - destructive confirmations shown before a user,
//     post, comment or category is deleted.
//
// Everything below is therefore deliberately unopinionated about content. These
// parts supply a scrim, a panel, a heading, a description and a close
// affordance; what goes inside the panel is the caller's business.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A CLIENT MODULE
//
// `open` and `onOpenChange` are functions, and a function prop cannot cross a
// server-to-client boundary. The boundary therefore has to sit at or below this
// file, so it is declared here - and the island is kept as narrow as it can be:
// this module adds styling and nothing else. No state, no effect, no data
// fetching, no event handler of its own.
//
// ---------------------------------------------------------------------------
// WHAT RADIX SUPPLIES, AND MUST NOT BE REIMPLEMENTED HERE
//
// @radix-ui/react-dialog already owns every behaviour a modal needs: the focus
// trap while open, focus restoration to the trigger on close, `Escape` to
// dismiss, outside-click dismissal, scroll locking, `role="dialog"`, and the
// `aria-labelledby` / `aria-describedby` wiring between the panel and its title
// and description.
//
// One correction to the obvious assumption, because it was measured rather than
// assumed: Radix does NOT emit `aria-modal`. There are zero occurrences of it in
// the compiled package. Instead it applies `aria-hidden="true"` to every other
// child of `document.body` while the dialog is open - the better-supported
// equivalent, and verified working at runtime. So the absence of `aria-modal` on
// the panel is correct and expected; do not "fix" it by adding one, which would
// double up on a modality signal Radix already conveys.
//
// None of that is written here, and none of it should be added: no keydown
// listener, no `document.body.style.overflow`, no `tabIndex` juggling, no
// hand-written `role` or `aria-modal`. Each would be a second implementation
// racing the primitive's own, and the usual symptoms are focus escaping the
// panel or the page staying scroll-locked after the dialog closes.
//
// ---------------------------------------------------------------------------
// THE ONE OBLIGATION THIS FILE PUSHES BACK ONTO CALLERS
//
// A dialog needs an accessible name, and Radix takes it from `DialogTitle`.
// Render a `DialogContent` without one and Radix logs a warning while the panel
// is announced with no name at all. So every `DialogContent` must contain a
// `DialogTitle` - and should also contain a `DialogDescription`, because Radix
// points `aria-describedby` at one and warns when that target is missing. A
// title that should not be shown still belongs in the tree; wrap it in the
// engine's `sr-only` utility rather than omitting it.
//
// ---------------------------------------------------------------------------
// ANIMATION - MEASURED, NOT ASSUMED
//
// The entrance is `@starting-style` (the `starting:` variant) over the engine's
// own default transition duration and `--ease-out`. It is written that way
// because `animate-in`, `fade-in-0` and `zoom-in-95` DO NOT EXIST in this
// project: those ship with tailwindcss-animate / tw-animate-css, neither of
// which is a declared dependency, and the engine's own `--animate-*` scale
// holds only spin, ping, pulse and bounce - none of which is a dialog
// entrance. Compiling the candidate class list against the installed engine
// confirmed it. Reach for one of those names and it emits no rule at all: dead
// markup, with no error, no warning and no animation.
//
// Both the transition and the starting style sit behind `motion-safe:`, which
// compiles to `@media (prefers-reduced-motion: no-preference)`, so a visitor
// who has asked for reduced motion simply gets the panel with no movement.
//
// Exit is not animated, and that is honest rather than an oversight: Radix
// keeps a closing node mounted only while a CSS *animation* is running, and
// this file declares transitions rather than keyframes. A `data-[state=closed]`
// fade would be authored, compiled, and then never seen.
//
// ---------------------------------------------------------------------------
// TOKENS ONLY
//
// Every value here resolves to a token from src/app/globals.css or to one of
// the engine's own scales. There is no literal colour, dimension, radius or
// shadow, and no `dark:` conditional anywhere - dark mode is handled entirely
// by the token layer, which re-points each `--app-*` value under `.dark` while
// this file changes nothing.
//
// The panel is `bg-surface` (the raised canvas, lighter than `background` in
// both themes). Its hairline is the decorative `border-border`, not
// `border-border-strong`: the A11Y note in globals.css reserves the stronger
// token for the boundary of an interactive control, where the border is what
// identifies the control at all. A dialog panel is an outline around content,
// the same case as a card, so the hairline is correct here.

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps, JSX } from 'react';

import { cn } from '@/lib/utils';

/**
 * Root of a dialog. Owns the open state and distributes it to every other part.
 *
 * Re-exported unchanged: the root renders no element of its own, so there is
 * nothing here to style. Use it uncontrolled, or controlled with the `open` and
 * `onOpenChange` pair.
 */
export const Dialog = DialogPrimitive.Root;

/**
 * The control that opens the dialog. Renders a `<button type="button">` already
 * wired to the root's open state, and is the element focus returns to when the
 * dialog closes.
 *
 * Re-exported unchanged - a trigger is styled by whatever it is in the calling
 * surface (a `Button`, an icon control, a menu item), so imposing a look here
 * would be wrong. Compose with `asChild` to keep your own element.
 */
export const DialogTrigger = DialogPrimitive.Trigger;

/**
 * Portal that moves the dialog out to the end of `document.body`, so no
 * ancestor's `overflow`, `transform` or stacking context can clip it.
 *
 * Re-exported unchanged, and rarely needed directly: {@link DialogContent}
 * already renders its own portal. Reach for this only when composing a panel by
 * hand from {@link DialogOverlay} and the underlying primitive.
 */
export const DialogPortal = DialogPrimitive.Portal;

/**
 * Any control that dismisses the dialog - a Cancel button, a "Not now" link.
 *
 * Re-exported unchanged for the same reason as the trigger: the caller owns how
 * it looks. This is *not* the corner close affordance, which
 * {@link DialogContent} renders for itself.
 */
export const DialogClose = DialogPrimitive.Close;

/**
 * The scrim behind the panel: a full-viewport wash that dims the page and
 * absorbs the click that dismisses the dialog.
 *
 * {@link DialogContent} renders one of these already, so this export exists for
 * hand-composed panels only. Rendering both yields two stacked scrims and a
 * visibly doubled wash.
 *
 * The wash is `bg-foreground/60` - a semantic token carrying an opacity
 * modifier, never a literal `rgba()`. That indirection matters: because
 * `--color-foreground` points at `var(--app-foreground)` rather than at a
 * literal, the engine cannot fold the value at build time and instead emits
 * `color-mix(in oklab, var(--color-foreground) 60%, transparent)`, which
 * re-resolves per theme at use time.
 *
 * @param className - Merged after the base classes, so it wins its own Tailwind
 *   group.
 */
export function DialogOverlay({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Overlay>): JSX.Element {
  return (
    <DialogPrimitive.Overlay
      /* BLITZY [COLOR]: The scrim INVERTS between themes, and that is a known
         limitation of the token catalogue rather than an oversight here.
         Measured in the browser: over the light canvas it composites to
         rgb(108,114,127), an 82% drop in luminance - a textbook dimming scrim.
         Over the dark canvas it composites to rgb(150,152,161), a ~150x RISE in
         luminance - a pale wash that brightens roughly 91% of the viewport
         instead of dimming it, which also inverts this system's "raised is
         lighter" elevation metaphor.

         Why it is written this way anyway: none of the semantic tokens is dark
         in BOTH themes. `foreground` / `muted-foreground` are dark in light and
         light in dark; `background` / `surface` / `surface-muted` /
         `primary-foreground` are the reverse - and `bg-background/*` produces no
         visible dimming at all in light mode, because the scrim and the page
         canvas are then the same token. The only theme-invariant colour is
         `--color-border-strong`, which is reserved for interactive control
         boundaries and would be a semantic misuse here. A `dark:` conditional is
         not permitted in this layer.

         The fix belongs one level down, in the token layer, and is deliberately
         NOT applied here because that file is outside this component's scope:
         add a non-inverting `--color-scrim` to src/app/globals.css carrying a
         DARK value in BOTH the `:root` and `.dark` blocks - a token is not
         obliged to invert - then change `bg-foreground/60` below to `bg-scrim`.
         That keeps zero `dark:` conditionals and zero literals while fixing both
         the glare and the elevation inversion. Flagged for design-system review
         rather than silently worked around.

         Not in question: all four text pairs clear WCAG AA in both themes (title
         17.83:1 light / 17.04:1 dark, description 7.58:1 / 6.78:1), and backdrop
         contrast collapses in both themes, so the scrim does still function as a
         de-emphasis device today. */
      className={cn(
        'bg-foreground/60 fixed inset-0 z-50',
        'motion-safe:transition-opacity motion-safe:ease-out motion-safe:starting:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

/**
 * The dialog panel, and the part callers actually reach for.
 *
 * Renders its own portal, its own {@link DialogOverlay} and its own corner
 * close affordance, so a correct modal is one element:
 *
 * ```tsx
 * <Dialog>
 *   <DialogTrigger asChild>
 *     <Button>Delete post</Button>
 *   </DialogTrigger>
 *   <DialogContent>
 *     <DialogTitle>Delete this post?</DialogTitle>
 *     <DialogDescription>This cannot be undone.</DialogDescription>
 *     <DialogClose asChild>
 *       <Button variant="secondary">Cancel</Button>
 *     </DialogClose>
 *   </DialogContent>
 * </Dialog>
 * ```
 *
 * A `DialogTitle` is mandatory - see the note at the top of this file.
 *
 * ### How the panel is positioned, and why it cannot overflow
 *
 * The panel is NOT positioned by insets. It is a centred flex item inside a
 * fixed, padded frame, and that indirection is the whole trick: it moves the
 * sizing out of CSS's absolutely-positioned over-constraint rules and into
 * ordinary flow, where percentages mean what you want them to mean.
 *
 * The frame is `fixed inset-0 p-4 flex items-center justify-center`. Its
 * content box is therefore exactly the viewport minus one spacing step on every
 * side. The panel then takes `w-full max-w-lg` (so it fills that content box up
 * to `--container-lg` and no further) and `max-h-full` (so it can never be
 * taller than that content box), with `overflow-y-auto` scrolling anything
 * longer inside the panel. Centring is the frame's `items-center
 * justify-center`, so no `translate` is involved and the entrance `scale` has
 * the transform to itself.
 *
 * Both of the obvious one-element alternatives were tried and MEASURED in
 * Chrome, and both are wrong. They are recorded here so nobody re-introduces
 * them:
 *
 *   * `fixed inset-4 m-auto w-full` over-constrains the INLINE axis. The end
 *     inset is dropped, the panel renders one full viewport wide starting one
 *     step in from the start edge, and the document gains real horizontal
 *     overflow at every width.
 *   * `fixed inset-4 m-auto h-fit`, with or without `max-h-full`, breaks the
 *     BLOCK axis. `fit-content` is a *definite* height, so with `top` and
 *     `bottom` both set the box is over-constrained and CSS resolves it through
 *     the auto margins - `margin-block = (viewportHeight - 2 * inset -
 *     usedHeight) / 2` - rather than by shrinking the box. It does not clamp to
 *     `stretch`. In a 420px-tall viewport the drawer resolved to 645.5px with
 *     margins of -128.75px, hanging off both edges with the title and the close
 *     button entirely off-screen, and - because the box had grown to its full
 *     content height - `scrollHeight` equalled `clientHeight`, so there was no
 *     scroll range and the last links were unreachable. Adding `max-h-full`
 *     instead capped the height at the full viewport height (percentages
 *     resolve against the viewport for a fixed box, not against the inset box),
 *     which restored scrolling but drove the margins to `-1rem` and put the
 *     panel flush against both edges.
 *
 * The frame carries `pointer-events-none` and the panel `pointer-events-auto`,
 * so the frame cannot become the click target: a press outside the panel passes
 * straight through to the overlay beneath, which is what Radix's outside-press
 * dismissal already keys on. The frame changes where the panel sits, and
 * nothing else.
 *
 * @param className - Merged after the base classes. This is the seam a consumer
 *   uses to widen the panel (`max-w-xl`) or to drop the padding for a flush
 *   drawer; `cn` resolves the conflict in the caller's favour.
 * @param children - Panel content. Must include a {@link DialogTitle}.
 */
export function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>): JSX.Element {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      {/* Centring frame. Its padding is what gives the panel its token margin
          at narrow widths, and its content box is what `max-h-full` and
          `w-full` on the panel resolve against. `pointer-events-none` keeps it
          from stealing the outside-press that dismisses the dialog. */}
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
        <DialogPrimitive.Content
          className={cn(
            'pointer-events-auto relative grid max-h-full w-full max-w-lg gap-4 overflow-y-auto',
            'border-border bg-surface rounded-lg border p-6 shadow-xl',
            'motion-safe:transition motion-safe:ease-out',
            'motion-safe:starting:scale-95 motion-safe:starting:opacity-0',
            className,
          )}
          {...props}
        >
          {children}
          {/* The corner dismiss control. Radix renders a real `<button
              type="button">`, so it is keyboard operable with no help from here.
              `size-11` is eleven spacing steps - 44px - which meets the touch
              target floor; no design source specifies a smaller one, so the
              floor applies rather than being overridden. The icon is decorative
              and hidden from assistive technology, and the accessible name comes
              from the visually hidden label beside it.

              `absolute` here is why the panel carries `relative` above. The
              panel used to be the fixed element and so was its own containing
              block; now that it is a flex item inside the fixed frame, dropping
              `relative` would make this control resolve against the FRAME and
              land in the viewport's corner rather than the panel's. Measured at
              768px wide, a frame-anchored button would sit 129px away from where
              this one actually renders, so the mistake would be obvious - but it
              would only show up once someone removed `relative`, hence the note.

              One accepted consequence: the panel is a scroll container, so an
              absolutely positioned control scrolls away with the content in a
              drawer long enough to overflow. That is left as is rather than made
              `sticky`, which would turn it into a grid item and disturb the
              `gap-4` rhythm for every consumer. Nothing becomes unreachable -
              `Escape`, an outside press, and any `DialogClose` in the body all
              still dismiss. */}
          <DialogPrimitive.Close
            className={cn(
              'absolute end-4 top-4 inline-flex size-11 items-center justify-center',
              'text-muted-foreground rounded-md',
              'motion-safe:transition motion-safe:ease-out',
              'hover:bg-surface-muted hover:text-foreground',
              'focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',
            )}
          >
            <X aria-hidden="true" className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Portal>
  );
}

/**
 * Accessible name of the dialog, and the one part {@link DialogContent} cannot
 * supply for you.
 *
 * Radix renders a real heading element and links it to the panel through
 * `aria-labelledby`, so there is no `role="heading"` here and none should be
 * added. To name a dialog without showing the heading, keep the element and
 * pass the engine's `sr-only` utility as `className`.
 *
 * `pe-9` is load-bearing rather than decorative. The close affordance sits
 * `end-4` in from the panel edge and is `size-11` wide, so it covers the
 * inline-end 2.25rem of the panel's padding box; without matching
 * padding-inline-end a long title would run underneath it. Nine spacing steps
 * is exactly that overlap, and it is a logical property, so the reservation
 * follows the writing direction instead of assuming left-to-right. Verified in
 * Chrome at 375, 768 and 1440: the title's content-box edge lands on the close
 * button's leading edge to within 0.000px at every width, and the rendered text
 * clears the button by 14px at the narrowest and 48px above it.
 *
 * `leading-tight` rather than `leading-none`, for two reasons. A dialog title
 * genuinely wraps - the navigation drawer's title runs to three lines at 375px -
 * and at `line-height: 1` the 18px line boxes are shorter than the ~21px glyph
 * boxes, so consecutive lines very nearly touch. It is also the more
 * token-faithful choice: `leading-tight` resolves to `var(--leading-tight)` from
 * the engine's leading scale, whereas `leading-none` emits a bare literal `1`.
 *
 * @param className - Merged after the base classes.
 */
export function DialogTitle({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>): JSX.Element {
  return (
    <DialogPrimitive.Title
      className={cn(
        'text-foreground pe-9 text-lg leading-tight font-semibold tracking-tight',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Supporting copy beneath the title - the consequence of a destructive action,
 * or what a drawer contains.
 *
 * Worth rendering even when the design shows no description, because Radix
 * points the panel's `aria-describedby` at one and warns when that target is
 * missing. Pair it with `sr-only` in that case.
 *
 * `text-muted-foreground` is the secondary-text token, which still clears the
 * 4.5:1 body-text threshold against all three canvases in both themes, so this
 * reads as secondary rather than merely faint.
 *
 * @param className - Merged after the base classes.
 */
export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>): JSX.Element {
  return (
    <DialogPrimitive.Description
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  );
}
