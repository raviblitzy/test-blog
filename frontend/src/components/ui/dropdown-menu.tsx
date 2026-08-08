'use client';

// Dropdown menu - the "user menu and row actions" primitive of this design system.
//
// This is one of the SIX primitives under src/components/ui/ that WRAP an accessible
// behavioural primitive rather than author one (select, label, dialog, dropdown-menu, tabs,
// avatar). The other nine - button, input, textarea, card, badge, table, pagination, alert,
// skeleton - are built over raw elements because Radix ships no equivalent. Which half a file
// belongs to determines what it is allowed to contain, and this one contributes token-derived
// VISUALS and nothing else.
//
// Its consumers are src/components/layout/user-menu.tsx and the three admin row-action menus
// (user-row-actions, post-row-actions, comment-moderation-actions). Those three offer delete
// actions, which is why the item part carries a destructive treatment rather than leaving each
// call site to invent one.
//
// ---------------------------------------------------------------------------
// 1. WHAT RADIX OWNS - AND MUST NOT BE REIMPLEMENTED HERE
//
// @radix-ui/react-dropdown-menu@2.1.24 already supplies, correctly:
//
//   * roving focus - one tab stop for the whole menu, arrow keys moving the highlight
//   * typeahead - typing "si" jumps to "Sign out"
//   * dismissal - Escape, outside pointer-down, and focus leaving the menu
//   * focus restoration - focus returns to the trigger when the menu closes
//   * portalling, and collision-aware positioning through @radix-ui/react-popper
//   * the role="menu" / role="menuitem" semantics, aria-haspopup and aria-expanded on the
//     trigger, and the data-state / data-highlighted / data-disabled attributes styled below
//
// So there is deliberately NO onKeyDown handler, NO click-outside listener, NO positioning
// arithmetic and NO hand-written role or aria-* attribute in this file. Each would be a second,
// competing implementation of behaviour that is already correct, and the two would drift.
// Crucially, `data-[highlighted]` is the primitive's OWN focus signal: styling against it means
// the visual highlight cannot fall out of step with which item is actually focused, which a
// hand-tracked "activeIndex" inevitably would.
//
// ---------------------------------------------------------------------------
// 2. EVERY VALUE HERE IS A TOKEN
//
// No literal colour, length, radius or shadow appears below - the tokens live in
// src/app/globals.css and this file only names them. The semantic mapping used:
//
//   panel fill        --color-surface             bg-surface
//   panel hairline    --color-border              border-border
//   body text         --color-foreground          text-foreground
//   highlighted item  --color-accent              data-[highlighted]:bg-accent
//   highlight label   --color-primary-foreground  data-[highlighted]:text-primary-foreground
//   destructive item  --color-danger              text-danger / data-[highlighted]:bg-danger
//   focus ring        --color-ring                focus-visible:ring-ring
//
// The two highlight pairs are the ones globals.css sanctions explicitly: it records
// primary-foreground over accent at 8.07:1 (light) and 10.04:1 (dark), and over danger at
// 6.42:1 and 6.97:1 - all clear of the 4.5:1 floor in BOTH themes, so neither needs an
// accessibility flag. That same file also warns that `accent` is the BRAND emphasis colour and
// not a neutral wash, which is exactly why the highlight flips the label to
// primary-foreground instead of leaving it as foreground.
//
// `border-border` rather than `border-border-strong` is deliberate. globals.css reserves the
// strong token for boundaries that IDENTIFY an interactive control (input, textarea, select),
// where WCAG 1.4.11 applies. A menu panel's outline is decorative - the items are identified by
// their labels - so the decorative hairline is the correct choice.
//
// There is no `dark:` conditional anywhere below, and there must never be one. Dark mode is a
// token-layer concern: globals.css declares each token twice and src/providers/theme-provider
// .tsx puts `.dark` on the document element, so this file themes itself for free.
//
// ---------------------------------------------------------------------------
// 3. BLITZY [DESIGN_SYSTEM_GAP]: THE PANEL HAS NO ENTER/EXIT MOTION, ON PURPOSE
//
// Radix's presence machinery (@radix-ui/react-presence) keys EXCLUSIVELY on `animation-name`
// and the animationstart / animationend / animationcancel events. On close it reads the
// computed animation name and, finding "none", unmounts the panel immediately - so a CSS
// TRANSITION is never given a frame to render, and `data-[state=closed]:opacity-0` would be
// permanently invisible dead code. The enter direction is no better: the panel mounts already
// carrying data-state="open", so there is no start value to move from.
//
// Only a @keyframes animation works, and the engine's --animate-* scale ships exactly four -
// spin, ping, pulse, bounce - every one of them `infinite` and none of them a fade or a zoom.
// Supplying one would require a literal duration and transform in this file (breaking the
// zero-hardcoded-values rule), or an animation plugin that is not in the pinned dependency set,
// or a new token in globals.css - whose own header lists --animate-* re-declarations under
// "deliberately absent". The panel therefore appears and disappears instantly, which is
// defensible rather than merely tolerable: it is also precisely what a reduced-motion visitor
// would be served either way.
//
// Resolution, should motion ever be wanted: add a fade/zoom pair to the --animate-* namespace
// in globals.css and reference it here as `data-[state=open]:animate-<name>`, alongside
// `data-[side=*]` for direction. Nothing else in this file needs to change.
//
// The motion budget is instead spent where it is both token-expressible and actually
// observable - the item's highlight - through `motion-safe:transition-colors` and
// `motion-safe:ease-out`. `motion-safe:` is the engine's own
// `prefers-reduced-motion: no-preference` variant, not a hand-written media query, and the
// duration comes from --default-transition-duration (150ms), inside the 150-300ms band.
//
// ---------------------------------------------------------------------------
// 4. DELIBERATELY ABSENT - DO NOT ADD
//
//   1. DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuCheckboxItem,
//      DropdownMenuRadioItem, DropdownMenuSub* and a "shortcut" span. The contract is fixed at
//      five parts, and none of the four described consumers needs more: the user menu is a flat
//      list of links plus sign-out, and each admin row menu is a flat list of actions. An
//      unused export is dead weight the lint gate can flag, and every extra part is one more
//      surface to keep themed. Add one only when a real consumer needs it.
//   2. An import of ./button. Consumers compose that themselves through
//      `<DropdownMenuTrigger asChild><Button /></DropdownMenuTrigger>`; importing it here would
//      couple two independent primitives and force the button into every bundle that opens a
//      menu.
//   3. class-variance-authority. It earns its keep on a multi-axis table like button's
//      variant x size; for a single two-valued axis a frozen lookup is smaller, has no
//      dependency and types identically.
//   4. forwardRef. React 19 passes `ref` through as an ordinary prop, and
//      ComponentProps<typeof Primitive.X> already includes it, so the spread forwards it.
//   5. Any `style` prop, stylesheet or !important. Utilities only, merged through cn() so a
//      caller's className still wins its property group.

import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import type { ComponentProps, JSX } from 'react';

import { cn } from '@/lib/utils';

/**
 * Gap between the trigger and the panel, in CSS pixels.
 *
 * Radix's positioning props are numbers, not class names, so this is the one value in the file
 * that cannot be a utility. It is still traceable to the scale: 4 is exactly one step of the
 * engine's `--spacing` unit (0.25rem = 4px), the same step `p-1` applies inside the panel.
 * Callers override it with the `sideOffset` prop.
 */
const CONTENT_SIDE_OFFSET = 4;

/**
 * Panel classes.
 *
 * `min-w-48` (12 spacing steps) keeps a short menu from collapsing to the width of its longest
 * label, and `max-w-xs` (`--container-xs`, 20rem) caps it below the 375px viewport the
 * responsive criteria test. Together with Radix's collision handling - `avoidCollisions`
 * defaults to true, and the popper positions the panel with `strategy: "fixed"`, so it cannot
 * contribute to the document's scroll width - that is what keeps an end-aligned menu in the
 * site header from ever forcing horizontal overflow.
 *
 * `overflow-hidden` clips each item's highlight fill to the panel's rounded corners. It is also
 * why items draw an INSET focus ring rather than an outline: see MENU_ITEM_BASE.
 */
const CONTENT_CLASSES =
  'z-50 min-w-48 max-w-xs overflow-hidden rounded-md border border-border bg-surface p-1 text-foreground shadow-lg';

/**
 * Menu-row classes shared by both variants.
 *
 * `min-h-11` is 2.75rem - 44px on the `--spacing` scale - rather than the ~2rem a desktop menu
 * row conventionally uses. This project has no design source of any kind (no Figma file, no
 * mockup, no reference screenshot), so there is nothing authorising a smaller target and the
 * 44x44 floor applies in full; the rule in that situation is to meet it, never to silently
 * shrink. It matters in practice too, because the header's user menu is reached by thumb at the
 * narrow viewport.
 *
 * `outline-none` plus the inset `focus-visible:` ring is a pairing, not a contradiction. The
 * global `:focus-visible` floor in globals.css draws a 2px outline with a 2px offset, and an
 * ancestor's `overflow: hidden` clips a descendant's outline - so on the first and last item
 * that floor would be shaved by the panel's rounded corners. The ring redraws the same 2px in
 * the same `--color-ring` INSIDE the item's box, where nothing can clip it, and `outline-none`
 * suppresses the cropped original so the two cannot double up.
 *
 * WHAT THE RING IS, AND WHAT IT IS NOT. It is the row's focus indicator, bound to
 * `:focus-visible` as the accessibility floor requires. It is NOT a reliable way to tell
 * keyboard focus apart from mouse hover, and it must not be documented or depended on as one.
 * That reading is intuitive and was measured to be wrong: Radix sets `data-highlighted` for
 * both pointer hover and keyboard focus, and its trigger calls `preventDefault()` on
 * `pointerdown` so that opening the menu never moves focus to the trigger - which means that on
 * a freshly loaded page NOTHING has been mouse-focused, Chrome never leaves its default focus
 * modality, and every programmatic `.focus()` Radix performs then satisfies `:focus-visible`.
 * Verified in a browser: after a pointer-only open, hovering a row produced a pointer frame and
 * a keyboard frame that were byte-identical. Once anything on the page HAS been mouse-focused,
 * pointer modality latches and the ring does disappear on hover - so the distinction exists,
 * it is simply not dependable. Recovering it would mean tracking input modality by hand, which
 * is precisely the hand-rolled interaction logic this layer refuses to write.
 *
 * None of that is a visual defect: the ring is a subtle 2px inset edge, and the row is marked
 * either way by the fill, which is the PRIMARY indicator and the one that satisfies the
 * visible-focus requirement on its own - measured in a browser at 8.09:1 against the panel
 * surface in light and 8.87:1 in dark.
 *
 * BLITZY [A11Y]: the ring has low LUMINANCE contrast against the fill it sits on. Measured:
 * 1.25:1 over the accent fill in light (indigo-600 on indigo-700 - one step apart on the same
 * ramp) and 1.01:1 over the danger fill, where it stays clearly visible but by HUE alone. It is
 * painted correctly - pixel-verified at exactly 2px inset on all four sides, both themes, both
 * variants - it simply is not a strong second signal on top of a filled row. Accepted rather
 * than corrected, and flagged here for designer review, for two reasons: the fill already
 * carries the indicator at 8.09:1, and the design system fixes the focus ring to
 * `--color-ring`, so reaching for a higher-contrast token would break the semantic mapping to
 * win a ratio nothing is relying on. The resolution, if a stronger indicator is ever wanted,
 * belongs in globals.css - give `--color-ring` more separation from `--color-accent` - not at
 * this call site.
 *
 * The nested-SVG rules size any icon a consumer nests to 4 spacing steps and stop it shrinking
 * inside the flex row; `pointer-events-none` keeps an icon from becoming the event target, so
 * hover and highlight always resolve against the item itself.
 *
 * `wrap-anywhere` (`overflow-wrap: anywhere`) is NOT interchangeable with `break-words`, and
 * this is the one line in the file most likely to be "simplified" back into a bug. A long
 * unbroken label - a signed-in email address in the session menu, a slug in an admin row -
 * measured 447px of text inside a 286px content box and was HARD-CLIPPED mid-character by the
 * panel's `overflow-hidden`: 44 characters survived, one was sliced at 65% of its glyph, and 20
 * more were destroyed outright, with no ellipsis, no tooltip and no scrollbar to hint that
 * anything was lost. `break-words` cannot fix it, and measuring showed the computed value here
 * is ALREADY `break-word`, inherited from the `body` rule in globals.css - it simply has no
 * effect, because a bare text node in a flex row is an anonymous flex item whose automatic
 * minimum size resolves to min-content, and per CSS Text `overflow-wrap: break-word` does not
 * reduce min-content intrinsic size. `anywhere` does, so the item can finally shrink and the
 * label wraps instead of being cut. Short labels are untouched: `anywhere` only breaks a word
 * that would otherwise overflow, and the panel still sizes to its longest label because the
 * popper wrapper measures `max-content`, which `overflow-wrap` does not affect. `min-h-11` is a
 * minimum, so a wrapped row grows rather than clipping. A caller who prefers truncation over
 * wrapping can wrap the label in a `truncate` span themselves.
 */
const MENU_ITEM_BASE =
  'relative flex min-h-11 cursor-default select-none items-center gap-2 rounded-sm px-3 py-2 text-sm wrap-anywhere outline-none motion-safe:transition-colors motion-safe:ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:pointer-events-none';

/**
 * Per-variant item classes.
 *
 * `destructive` tints the label with `--color-danger` at rest and inverts to a solid danger
 * fill when highlighted, mirroring how the default variant behaves with `--color-accent` so the
 * two feel like one component. Colour is never the only signal: a destructive item still says
 * what it does ("Delete user"), which is what carries the meaning for anyone who cannot
 * distinguish the tint.
 */
const MENU_ITEM_VARIANTS = {
  default: 'data-[highlighted]:bg-accent data-[highlighted]:text-primary-foreground',
  destructive:
    'text-danger data-[highlighted]:bg-danger data-[highlighted]:text-primary-foreground',
} as const;

/** The two item treatments. Derived from the lookup so the pair cannot drift apart. */
type MenuItemVariant = keyof typeof MENU_ITEM_VARIANTS;

type DropdownMenuContentProps = ComponentProps<typeof DropdownMenuPrimitive.Content>;

type DropdownMenuItemProps = ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  /**
   * Visual treatment. `destructive` is for irreversible actions - the delete entries in the
   * admin row menus. Defaults to `default`.
   */
  variant?: MenuItemVariant;
};

/**
 * Menu root. Owns open state; render a trigger and a content part inside it.
 *
 * Re-exported unstyled because it renders no element of its own - the correct outcome for a
 * thin wrapper, and it keeps `open`, `defaultOpen`, `onOpenChange`, `modal` and `dir` reaching
 * the primitive untouched.
 */
const DropdownMenu = DropdownMenuPrimitive.Root;

/**
 * The control that opens the menu.
 *
 * Re-exported unstyled so `asChild` passes straight through: the intended composition is
 * `<DropdownMenuTrigger asChild><Button variant="ghost" /></DropdownMenuTrigger>`, which keeps
 * one button implementation and lets Radix merge `aria-haspopup`, `aria-expanded` and its
 * keyboard handlers onto it. Without `asChild` the primitive renders its own bare `<button>`,
 * so styling this part would produce a second, competing button.
 *
 * DO NOT give this part an explicit `id`, and do not put one on the element you pass through
 * `asChild`. Radix derives the trigger id and the panel id from a single `useId()` root and
 * labels the panel with `aria-labelledby={triggerId}`; because a caller's props spread last
 * onto the primitive, your `id` replaces the generated one and leaves that `aria-labelledby`
 * pointing at nothing. Verified in a browser: the menu's accessible name silently becomes
 * EMPTY where it should read the trigger's own text, and nothing warns. If an id is genuinely
 * unavoidable, pass a matching `aria-labelledby` to `DropdownMenuContent` as well so the panel
 * keeps a name.
 */
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

/**
 * Groups related items so assistive technology announces them as a set.
 *
 * Re-exported unstyled: the primitive renders a `role="group"` wrapper, and spacing between
 * groups belongs to the caller's layout rather than to this primitive.
 */
const DropdownMenuGroup = DropdownMenuPrimitive.Group;

/**
 * The floating panel that holds the items.
 *
 * Always rendered through `DropdownMenuPrimitive.Portal`, so the panel escapes any ancestor
 * that clips or scrolls. That is not cosmetic: the admin row menus sit inside a horizontally
 * scrollable table container, and an unportalled panel would be cropped by it.
 *
 * `align` ("start" | "center" | "end") and every other positioning prop - `side`,
 * `alignOffset`, `collisionPadding`, `avoidCollisions` - reach the primitive through the
 * spread, as do the behavioural ones such as `loop`. `sideOffset` is the only one given a
 * default, which a caller can still override.
 *
 * Arrow keys CLAMP at the first and last row rather than wrapping, because Radix's `loop`
 * defaults to false and this wrapper does not override it. Pass `loop` if a menu wants
 * wrap-around traversal.
 *
 * @example An end-aligned session menu, as the site header composes it
 * ```tsx
 * <DropdownMenu>
 *   <DropdownMenuTrigger asChild>
 *     <Button variant="ghost">Account</Button>
 *   </DropdownMenuTrigger>
 *   <DropdownMenuContent align="end">
 *     <DropdownMenuGroup>
 *       <DropdownMenuItem onSelect={goToDashboard}>Dashboard</DropdownMenuItem>
 *       <DropdownMenuItem onSelect={signOut}>Sign out</DropdownMenuItem>
 *     </DropdownMenuGroup>
 *   </DropdownMenuContent>
 * </DropdownMenu>
 * ```
 *
 * @example An admin row menu, where the last action is irreversible
 * ```tsx
 * <DropdownMenuContent align="end">
 *   <DropdownMenuItem onSelect={editPost}>Edit post</DropdownMenuItem>
 *   <DropdownMenuItem variant="destructive" onSelect={deletePost}>
 *     Delete post
 *   </DropdownMenuItem>
 * </DropdownMenuContent>
 * ```
 */
function DropdownMenuContent({
  className,
  sideOffset = CONTENT_SIDE_OFFSET,
  ...props
}: DropdownMenuContentProps): JSX.Element {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(CONTENT_CLASSES, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

/**
 * A single actionable row. Radix gives it `role="menuitem"`, so its accessible name is its
 * visible label - keep that label real text rather than an icon alone.
 *
 * Icons nested inside are sized and pinned by the base classes, and the consumer owns their
 * semantics: a decorative icon must carry `aria-hidden="true"` so it is not announced, while an
 * icon that is the only thing conveying an action needs its own accessible name.
 *
 * Use `onSelect` rather than `onClick`. Radix fires it for pointer activation and for Enter and
 * Space alike, and it is the hook that closes the menu - calling `event.preventDefault()`
 * inside it keeps the menu open, which is what a "load more" style row wants.
 *
 * `disabled` is forwarded to the primitive, which sets `data-disabled` and drops the row out of
 * arrow-key and typeahead traversal; the base classes then dim it and stop it taking pointer
 * events. `data-variant` is mirrored onto the element so an end-to-end spec can confirm the
 * destructive treatment without asserting on class names, which the test conventions forbid.
 */
function DropdownMenuItem({
  className,
  variant = 'default',
  ...props
}: DropdownMenuItemProps): JSX.Element {
  return (
    <DropdownMenuPrimitive.Item
      data-variant={variant}
      className={cn(MENU_ITEM_BASE, MENU_ITEM_VARIANTS[variant], className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
};
