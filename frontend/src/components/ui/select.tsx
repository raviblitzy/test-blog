'use client';

// Select - the "category / status picker" primitive of this design system.
//
// One of the SIX primitives under src/components/ui/ that WRAP an accessible behavioural
// primitive rather than author one (select, label, dialog, dropdown-menu, tabs, avatar). The
// other nine - button, input, textarea, card, badge, table, pagination, alert, skeleton - are
// built over raw elements because Radix ships no equivalent. Which half a file belongs to
// decides what it may contain, and this one contributes token-derived VISUALS and nothing else.
//
// Its consumers are src/components/blog/category-filter.tsx (the home feed's category picker),
// the category and status pickers in src/components/blog/post-editor.tsx, and the admin filter
// rows. The feed's filter is a client island that mirrors its selection into the URL query
// string, so this primitive has to work as a CONTROLLED component driven by a value derived
// from the URL - which is why `value` / `onValueChange` reach the root untouched.
//
// THERE IS NO RAW <select> ANYWHERE BELOW, AND THAT IS THE POINT. The project rule "project
// primitives over raw elements" names <select> explicitly, and this file is nominally the one
// place it could be reached for. The Radix trigger/content pair REPLACES it outright instead,
// which is the better outcome rather than a workaround: a native <option> list cannot be styled
// with tokens, cannot show a check indicator, and cannot be themed for dark mode at all on most
// platforms. No other file under src/ may use a raw <select> either.
//
// ---------------------------------------------------------------------------
// 1. WHAT RADIX OWNS - AND MUST NOT BE REIMPLEMENTED HERE
//
// @radix-ui/react-select@2.3.7 already supplies, correctly:
//
//   * the combobox/listbox/option ARIA model - role="combobox" plus aria-controls,
//     aria-expanded, aria-required and aria-autocomplete on the trigger; role="listbox" on the
//     viewport; role="option" with aria-selected on each item
//   * typeahead - typing "te" jumps to the "Technology" option
//   * roving focus - one tab stop for the whole control, arrow keys moving the highlight,
//     Home/End jumping to the ends
//   * dismissal - Escape, outside pointer-down, and focus leaving the panel
//   * focus restoration - focus returns to the trigger when the panel closes
//   * portalling, and collision-aware positioning through @radix-ui/react-popper
//   * the data-state / data-placeholder / data-highlighted / data-disabled attributes styled
//     below, and scroll buttons that appear only while the list actually overflows
//
// So there is deliberately NO onKeyDown handler, NO click-outside listener, NO positioning
// arithmetic, and NO hand-written role, aria-expanded or aria-activedescendant in this file.
// Each would be a second, competing implementation of behaviour that is already correct, and
// the two would drift. `data-[highlighted]` in particular is the primitive's OWN focus signal:
// styling against it means the visual highlight cannot fall out of step with which option is
// actually focused, which a hand-tracked "activeIndex" inevitably would.
//
// ---------------------------------------------------------------------------
// 2. EVERY VALUE HERE IS A TOKEN
//
// No literal colour, length, radius or shadow appears below - the tokens live in
// src/app/globals.css and this file only names them. The semantic mapping used:
//
//   field boundary     --color-border-strong       border-border-strong
//   field + panel fill --color-surface             bg-surface
//   panel hairline     --color-border              border-border
//   body text          --color-foreground          text-foreground
//   placeholder        --color-muted-foreground    data-[placeholder]:text-muted-foreground
//   scroll affordance  --color-muted-foreground    text-muted-foreground
//   focus indicator    --color-ring                focus-visible:outline-ring / ring-ring
//   highlighted option --color-accent              data-[highlighted]:bg-accent
//   highlight label    --color-primary-foreground  data-[highlighted]:text-primary-foreground
//   disabled fill      --color-surface-muted       disabled:bg-surface-muted
//
// TWO OF THOSE CHOICES ARE EASY TO "CORRECT" INTO A BUG, so both are stated outright.
//
// `border-border-strong` on the TRIGGER, not `border-border`. globals.css splits the two
// deliberately and names this file in the split: `--color-border` is a decorative hairline that
// measures 1.23:1 on the light surface and 1.73:1 on the dark one, which WCAG 1.4.11 exempts for
// card outlines and table rules; the boundary of an interactive control is what IDENTIFIES the
// control and has to clear 3:1. `--color-border-strong` (slate-500, and theme-invariant, so it
// is absent from the `.dark` block) measures 4.77:1 and 3.74:1. That file's A11Y note lists
// "input, textarea, select and checkbox" as its consumers by name.
//
// `border-border` on the PANEL, for the mirror-image reason, matching dropdown-menu.tsx. A
// floating panel's outline is decorative - the options inside are identified by their own text -
// so the decorative hairline is correct there and the strong token would put a mid-grey rule
// around every open picker.
//
// The highlight pair is the one globals.css sanctions explicitly: it records
// primary-foreground over accent at 8.07:1 in light and 10.04:1 in dark, both clear of the
// 4.5:1 floor, so no accessibility flag is needed. That file also warns that `accent` is the
// BRAND emphasis colour and not a neutral wash, which is exactly why the highlight flips the
// label to primary-foreground rather than leaving it as foreground.
//
// There is no `dark:` conditional anywhere below, and there must never be one. Dark mode is a
// token-layer concern: globals.css declares each token twice and src/providers/theme-provider
// .tsx puts `.dark` on the document element, so this file themes itself for free.
//
// ---------------------------------------------------------------------------
// 3. THE TRIGGER IS A FIELD, AND IT IS PINNED TO input.tsx
//
// A picker and a text field sit in the same form row in the post editor - "Title" beside
// "Category" - and in the admin filter bars. input.tsx therefore declares itself the house
// style for the whole field family and names this file's trigger as a member: "select.tsx's
// trigger is styled to match it, so the three read as one control family rather than three
// near-misses. A field token changed here has to change there in the same commit."
//
// TRIGGER_CLASSES below copies that vocabulary group for group - height, inline padding, radius,
// boundary token, fill, text size, elevation, focus treatment, disabled treatment and motion are
// all byte-identical to input.tsx, as is the `invalid` group in TRIGGER_INVALID_CLASSES and the
// `aria-invalid` handling that goes with it. Two differences are structural rather than stylistic
// and are required by this control: `flex items-center justify-between` (input.tsx uses `block`)
// because the trigger has to lay out a value and a chevron, and `text-start` because a <button>
// centres its text where an <input> does not.
//
// A mechanical check of that claim is worth running after any edit to either file: every field
// token input.tsx uses must still appear here. The one group that is legitimately WIDER here is
// the panel's, which adds `rounded-sm`, `text-sm`, `border-border` and `shadow-lg` for surfaces
// input.tsx has no counterpart to.
//
// THE TEXT SIZE IS text-base, NOT text-sm, and that is deliberate. input.tsx records why: 1rem
// is the threshold below which iOS Safari zooms the viewport on a focused control, and the whole
// field family shares the value so the row lines up. The panel's options use `text-sm`, which is
// the MENU family's size and matches dropdown-menu.tsx - the two scales belong to two different
// surfaces, and neither should be conformed to the other.
//
// ---------------------------------------------------------------------------
// 4. BLITZY [DESIGN_SYSTEM_GAP]: THE PANEL HAS NO ENTER/EXIT MOTION, ON PURPOSE
//
// Identical in cause and resolution to the note in dropdown-menu.tsx, restated here so this file
// can be read on its own.
//
// Radix's presence machinery (@radix-ui/react-presence) keys EXCLUSIVELY on `animation-name` and
// the animationstart / animationend / animationcancel events. On close it reads the computed
// animation name and, finding "none", unmounts the panel immediately - so a CSS TRANSITION is
// never given a frame to render, and `data-[state=closed]:opacity-0` would be permanently
// invisible dead code. The enter direction is no better: the panel mounts already carrying
// data-state="open", so there is no start value to move from.
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
// Resolution, should motion ever be wanted: add a fade/zoom pair to the --animate-* namespace in
// globals.css and reference it here as `data-[state=open]:animate-<name>`, alongside
// `data-[side=*]` for direction. Radix already publishes
// `--radix-select-content-transform-origin` for exactly that, and nothing else in this file
// needs to change.
//
// The motion budget is instead spent where it is both token-expressible and actually observable:
// the trigger's border and outline colours, and the option's highlight, through
// `motion-safe:transition-colors` and `motion-safe:ease-out`. `motion-safe:` is the engine's own
// `prefers-reduced-motion: no-preference` variant, not a hand-written media query, and the
// duration comes from the engine's own scale.
//
// ---------------------------------------------------------------------------
// 5. DELIBERATELY ABSENT - DO NOT ADD
//
//   1. SelectGroup, SelectLabel and SelectSeparator. The contract is fixed at the six parts the
//      design system specifies, and none of the described consumers needs a grouped list: a
//      category picker and a status picker are both flat. An unused export is dead weight the
//      lint gate can flag, and every extra part is one more surface to keep themed. Add one only
//      when a real consumer needs it.
//   2. EXPORTS for the scroll buttons. They are rendered internally by SelectContent because
//      Radix hides the viewport's scrollbar (see SCROLL_BUTTON_CLASSES), so they are load-bearing
//      rather than optional - but a consumer never composes them by hand, so they stay private.
//   3. An import of ./input or ./label. The field vocabulary is copied from input.tsx
//      deliberately, not imported: they are independent primitives, and importing one into the
//      other would couple them and force input into every bundle that renders a picker. Labels
//      are composed by the caller - see the accessibility note on SelectTrigger.
//   4. A raw <select>, an <option>, or a native form fallback. Radix already renders a hidden
//      native <select> mirror of its own for form integration - 1x1px, clipped,
//      `aria-hidden="true"`, `tabindex="-1"` - so uncontrolled form submission works without one
//      and the `name` passed to the root reaches it.
//
//      Two verified details about that mirror, because both are easy to misread. It is emitted
//      during server render and on first client render even OUTSIDE a form, because Radix cannot
//      know whether the trigger has a `<form>` ancestor until its ref resolves; it then unmounts
//      itself once it learns there is none, so at runtime outside a form the document contains no
//      <select> at all. And while it exists, Chrome's Issues panel reports "A form field element
//      should have an id or name attribute" once per Select root, because Radix gives the mirror
//      neither. That advisory is upstream, transient, invisible and hidden from assistive
//      technology; it is not a console error, not an accessibility defect, and not something to
//      "fix" here. Passing `name` to the root silences it where a consumer cares.
//   5. class-variance-authority. This file has no variant axis at all; every part has exactly
//      one appearance. cva belongs in button.tsx and badge.tsx, which do have size and intent
//      axes.
//   6. forwardRef. React 19 passes `ref` through as an ordinary prop, and
//      ComponentProps<typeof Primitive.X> already includes it, so the spread forwards it.
//   7. Any `style` prop, stylesheet or !important. Utilities only, merged through cn() so a
//      caller's className still wins its property group.
//   8. A `dark:` conditional, a media query, or a literal colour, length, radius or shadow.

import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import type { ComponentProps, JSX } from 'react';

import { cn } from '@/lib/utils';

/**
 * Gap between the trigger and the panel, in CSS pixels, used only in `popper` positioning.
 *
 * Radix's positioning props are numbers, not class names, so this is the one value in the file
 * that cannot be a utility. It is still traceable to the scale rather than invented: 4 is exactly
 * one step of the engine's `--spacing` unit (0.25rem = 4px), the same step `p-1` applies inside
 * the panel, and the same constant dropdown-menu.tsx uses so the two floating surfaces sit at an
 * identical distance from their triggers. Callers override it with the `sideOffset` prop.
 */
const CONTENT_SIDE_OFFSET = 4;

/**
 * Trigger classes - the field half of this primitive.
 *
 * Group for group this is input.tsx's vocabulary, and the two must be changed together. Reading
 * top to bottom:
 *
 *   `flex w-full min-w-0 items-center justify-between gap-2` - the value on one side, the chevron
 *     on the other. `w-full` so the picker fills its form row; `min-w-0` so it can also SHRINK
 *     inside a flex row, without which a field in a flex container forces horizontal overflow at
 *     narrow viewports - which the responsive criteria forbid at every width. `gap-2` keeps the
 *     value clear of the chevron when the two nearly meet.
 *   `h-11 rounded-md px-3` - 2.75rem is 44px, the WCAG 2.5.5 target-size floor. No design source
 *     exists for this project (zero attachments, zero Figma frames), so nothing authorises a
 *     smaller target and the accessible minimum governs. Identical to input.tsx, which is what
 *     makes a picker and a text field line up in the same row.
 *   `border-border-strong bg-surface text-foreground border text-base shadow-xs` - see section 2
 *     of the header for why the boundary is the STRONG token, and section 3 for why the text is
 *     `text-base` rather than `text-sm`. `shadow-xs` is what keeps the field readable when it
 *     sits flush on a `bg-surface` card, where the fill alone cannot distinguish it.
 *   `text-start` - a <button> centres its text; an <input> does not. Without this the selected
 *     value would sit in the middle of the field while the sibling text input's value sits at the
 *     start, which is the most visible way these two could fail to look like one family.
 *   `data-[placeholder]:text-muted-foreground` - Radix sets `data-placeholder` on the trigger
 *     while nothing is selected, so an empty picker reads as a hint rather than as a value. This
 *     is the exact counterpart of input.tsx's `placeholder:text-muted-foreground`; the token
 *     still clears 4.5:1 on every canvas, so the hint stays legible rather than merely faint.
 *   `[&>span]:min-w-0 [&>span]:truncate` - SelectValue renders a <span>, and a long option label
 *     ("Software Architecture and Systems Design") would otherwise push the chevron out of the
 *     field or force the trigger to overflow. Truncation needs BOTH: `min-w-0` because a flex
 *     item's automatic minimum size is min-content and would refuse to shrink, and `truncate` for
 *     the ellipsis. The chevron carries `shrink-0` from the other side of the same problem.
 *   the `focus-visible:` group - an outline rather than a `ring` box-shadow, restated here rather
 *     than left to the `:focus-visible` floor in globals.css. Three reasons, all from input.tsx:
 *     an outline survives an ancestor's `overflow: hidden`; `outline-2` and `outline-offset-2` are
 *     exactly what that floor emits, so layering the same mechanism cannot change the indicator's
 *     thickness or position; and utilities outrank the base layer, so the field keeps a visible
 *     indicator even if the document floor is ever narrowed. `focus-visible:border-ring` adds a
 *     second cue inside the control's own edge. No bare `outline-none` appears on the trigger -
 *     removing the indicator would breach the accessibility floor outright.
 *   `disabled:*` - Radix forwards `disabled` to the real <button>, so these native variants apply
 *     directly. A recessed fill plus a not-allowed cursor makes the state readable from both the
 *     surface and the pointer rather than from opacity alone; WCAG 1.4.3 exempts inactive
 *     controls from the contrast minimum, which is what makes the dimming legitimate here.
 *   `motion-safe:*` - the border and outline colours ease between states instead of snapping.
 *     `motion-safe:` is the engine's own `prefers-reduced-motion: no-preference` variant, which
 *     is how transitions are required to be gated; it is not a hand-authored media query, and
 *     this file authors no responsive breakpoint at all.
 */
const TRIGGER_CLASSES =
  'flex h-11 w-full min-w-0 items-center justify-between gap-2 rounded-md px-3 border-border-strong bg-surface text-foreground border text-base text-start shadow-xs data-[placeholder]:text-muted-foreground [&>span]:min-w-0 [&>span]:truncate focus-visible:border-ring focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2 disabled:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60 motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out';

/**
 * The chevron that marks the trigger as a picker.
 *
 * `size-4` is 4 spacing steps; `shrink-0` stops the flex row from squeezing it when the value is
 * long (the truncating span absorbs that instead); `opacity-60` reads it as secondary to the
 * value without introducing a second text colour. It is decorative - the trigger's accessible
 * name comes from the caller's <label> and its state from Radix's `aria-expanded` - so it is
 * hidden from assistive technology at the call site.
 */
const TRIGGER_ICON_CLASSES = 'size-4 shrink-0 opacity-60';

/**
 * Trigger classes added when the `invalid` prop is set - again byte-identical to input.tsx's.
 *
 * A danger border plus a soft halo of the same token, so the error reads at a glance without the
 * field having to grow or move.
 *
 * The two `focus-visible:` entries are the point of this group rather than an afterthought: they
 * OVERRIDE the brand-coloured focus treatment in TRIGGER_CLASSES, because a picker that turned
 * indigo the moment it was focused would drop its error signal exactly when the user arrived to
 * fix it. globals.css measures `--color-danger` at 6.42:1 on the light surface and 6.97:1 on the
 * dark one, so a red indicator still clears the 3:1 non-text floor and focus stays as visible as
 * it is on a valid field.
 *
 * Colour is never the only signal. `invalid` supplies the programmatic half by mirroring itself
 * into `aria-invalid`; the owning form supplies the visible half by rendering its message and
 * pointing `aria-describedby` at it, so the reason is readable rather than merely implied by a hue.
 */
const TRIGGER_INVALID_CLASSES =
  'border-danger ring-danger/20 focus-visible:border-danger focus-visible:outline-danger ring-2';

/**
 * Panel classes, applied in both positioning modes.
 *
 * `flex flex-col` IS LOAD-BEARING AND MUST NOT BE REMOVED. Radix gives the viewport
 * `flex: 1; overflow: hidden auto` inline, but sets no `display` on the content element in
 * EITHER mode - `popper` adds only `box-sizing` and its custom properties, and `item-aligned`
 * adds only `box-sizing` and `max-height: 100%`. Without a flex column here that `flex: 1` is
 * inert, the viewport grows to its natural height, and a list longer than the panel is silently
 * CLIPPED by the `overflow-hidden` below instead of scrolling. With it, the viewport becomes the
 * bounded scroll container and the two scroll buttons stay pinned above and below it as
 * non-shrinking siblings.
 *
 * `max-h-(--radix-select-content-available-height)` is not a hardcoded dimension and not
 * positioning arithmetic - it READS the height Radix measured for the space between the trigger
 * and the viewport edge, which is the only compliant way to bound the panel. Computing it here
 * would be exactly the hand-rolled positioning logic this layer refuses to write. In
 * `item-aligned` mode Radix's own inline `max-height: 100%` wins over this class, which is
 * correct: that mode owns its geometry entirely.
 *
 * `min-w-48` keeps a picker with short options ("All", "Draft") from collapsing to the width of
 * its longest label. `max-w-xs` (`--container-xs`, 20rem) caps it below the 375px viewport the
 * responsive criteria test. Where the trigger is WIDER than that cap - a full-width category
 * field in the editor - CONTENT_POPPER_CLASSES raises the minimum to the trigger's own width, and
 * CSS resolves the pair in favour of the minimum (per CSS 2.1 §10.4 a `min-width` above
 * `max-width` replaces it), so the panel matches the field rather than being pinned at 20rem.
 * That is the intended reading of both utilities together, not an accident.
 *
 * Horizontal overflow is impossible at any width even so: Radix's popper positions with
 * `strategy: fixed` and `avoidCollisions` defaults to true, so the panel cannot contribute to the
 * document's scroll width.
 *
 * `overflow-hidden` clips each option's highlight fill to the panel's rounded corners. It is also
 * why options draw an INSET focus ring rather than an outline: see ITEM_CLASSES.
 */
const CONTENT_CLASSES =
  'relative z-50 flex flex-col max-h-(--radix-select-content-available-height) min-w-48 max-w-xs overflow-hidden rounded-md border border-border bg-surface text-foreground shadow-lg';

/**
 * Panel classes applied only when `position` is `popper`.
 *
 * Binds the panel's minimum width to the trigger's measured width, so a picker looks like it
 * belongs to the field it opened from rather than like a floating menu that happens to be nearby.
 * Radix re-namespaces `--radix-popper-anchor-width` to this name on the content element, so the
 * value exists only in this mode - which is why it is applied conditionally rather than in the
 * base string, where it would resolve to nothing in `item-aligned` mode and silently drop the
 * `min-w-48` floor with it.
 */
const CONTENT_POPPER_CLASSES = 'min-w-(--radix-select-trigger-width)';

/**
 * Scrolling-region classes.
 *
 * `p-1` insets the options from the panel's border, matching dropdown-menu.tsx, and lives here
 * rather than on the panel so that a scrolled option passes under the padding instead of being
 * clipped at a hard edge. `max-h-96` (96 spacing steps, 24rem) caps a long category list at a
 * readable height on a tall screen, while the panel's collision-aware maximum takes over on a
 * short one - whichever is smaller wins, which is the correct behaviour in both directions.
 *
 * No `overflow` utility: Radix sets `overflow: hidden auto` inline, and restating it as a class
 * would lose to the inline style anyway.
 */
const VIEWPORT_CLASSES = 'p-1 max-h-96';

/**
 * Option classes.
 *
 * `min-h-11` is 2.75rem - 44px on the `--spacing` scale - rather than the ~2rem a desktop listbox
 * row conventionally uses, for the same reason the trigger is `h-11`: no design source authorises
 * a smaller target, so the 44x44 floor applies in full, and the rule in that situation is to meet
 * it rather than silently shrink. It is a MINIMUM, so a wrapped label grows the row instead of
 * clipping it. The feed's category filter is reached by thumb at the narrow viewport.
 *
 * `ps-9 pe-2` are logical (`padding-inline-start` / `-end`), so the reserved gutter follows the
 * writing direction rather than always sitting on the left - which matters because Radix
 * forwards a `dir` prop and this primitive must not fight it. The start gutter is what the check
 * indicator occupies; `pe-2` balances it visually without a second full gutter.
 *
 * `outline-hidden` plus the inset `focus-visible:` ring is a pairing, not a contradiction, and it
 * is the same resolution dropdown-menu.tsx reached. The global `:focus-visible` floor in
 * globals.css draws a 2px outline with a 2px offset, and an ancestor's `overflow: hidden` clips a
 * descendant's outline - so on the first and last option that floor would be shaved by the
 * panel's rounded corners. The ring redraws the same 2px in the same `--color-ring` INSIDE the
 * option's box, where nothing can clip it, and the outline is suppressed so the two cannot double
 * up. `outline-hidden` is used rather than `outline-none` deliberately: it emits the same
 * `outline-style: none` but ALSO restores a transparent 2px outline under
 * `@media (forced-colors: active)`, so a Windows High Contrast user keeps an indicator even
 * though the forced palette overrides the highlight fill below.
 *
 * The highlight fill is the PRIMARY indicator and satisfies the visible-focus requirement on its
 * own; the inset ring is a second, subtler cue. Note that `data-highlighted` is set for pointer
 * hover AND keyboard focus, so the ring is not a reliable way to tell the two apart and must not
 * be documented as one - recovering that distinction would mean tracking input modality by hand,
 * which is precisely the interaction logic this layer refuses to write.
 *
 * `wrap-anywhere` (`overflow-wrap: anywhere`) is NOT interchangeable with `break-words`, and this
 * is the line most likely to be "simplified" back into a defect. A bare text node in a flex row
 * is an anonymous flex item whose automatic minimum size resolves to min-content, and per CSS
 * Text `overflow-wrap: break-word` does not reduce min-content intrinsic size - so a long
 * unbroken label would be hard-clipped mid-character by the panel's `overflow-hidden`, with no
 * ellipsis and no scrollbar to hint that anything was lost. `anywhere` does reduce it, so the
 * label wraps instead. Short labels are untouched, because `anywhere` only breaks a word that
 * would otherwise overflow.
 *
 * The nested-SVG rules size the check indicator and any icon a consumer nests, stop it shrinking
 * in the flex row, and keep it from becoming the event target so hover and highlight always
 * resolve against the option itself.
 */
const ITEM_CLASSES =
  'relative flex min-h-11 w-full cursor-default select-none items-center gap-2 rounded-sm py-2 ps-9 pe-2 text-sm wrap-anywhere outline-hidden data-[highlighted]:bg-accent data-[highlighted]:text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[disabled]:pointer-events-none data-[disabled]:opacity-50 motion-safe:transition-colors motion-safe:ease-out [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:pointer-events-none';

/**
 * Check-indicator classes.
 *
 * Radix mounts the indicator only for the selected option, so no "unchecked" state needs styling.
 * It is positioned absolutely in the gutter `ps-9` reserved above, using the logical `start-2` so
 * it follows the writing direction; taking it out of flow is what keeps every label starting at
 * the same inline offset whether or not its row is the selected one. The tick inherits its size
 * from ITEM_CLASSES' nested-SVG rule and its colour from the row, so it flips to
 * `primary-foreground` along with the label when the row is highlighted - no separate colour to
 * keep in step.
 */
const ITEM_INDICATOR_CLASSES = 'absolute start-2 flex items-center justify-center';

/**
 * Scroll-button classes, shared by the up and down buttons.
 *
 * THESE BUTTONS ARE REQUIRED, NOT DECORATIVE. Radix injects a stylesheet of its own that hides
 * the viewport's scrollbar outright - `scrollbar-width: none`, `-ms-overflow-style: none` and
 * `::-webkit-scrollbar { display: none }` - so a pointer user faced with a long category list
 * would have NO affordance to scroll it without them. Radix mounts each one only while the list
 * actually overflows in that direction, so a short list renders neither.
 *
 * `text-muted-foreground` marks them as chrome rather than content, `py-1` keeps them compact so
 * they cost little of the panel's height, and `cursor-default` matches the options they sit
 * between. They are presentational affordances rather than tab stops - Radix drives them from
 * pointer hover and the keyboard scrolls the viewport directly - so their chevrons are hidden
 * from assistive technology at the call site.
 */
const SCROLL_BUTTON_CLASSES =
  'flex cursor-default items-center justify-center py-1 text-muted-foreground';

type SelectTriggerProps = ComponentProps<typeof SelectPrimitive.Trigger> & {
  /**
   * Marks the picker as having failed validation.
   *
   * Present so the field family stays coherent: input.tsx exposes the identical prop, and a form
   * row whose title field turned red while its required category picker did not would be exactly
   * the mismatch that file's "one control family rather than three near-misses" rule forbids. The
   * post editor's category selection is the consumer that needs it.
   *
   * Drives two things at once, which is why it is a prop rather than a class the caller applies:
   * the `--color-danger` border and halo, and the `aria-invalid` attribute that carries the same
   * fact to assistive technology. Styling the field red by hand would announce nothing.
   *
   * @defaultValue false
   */
  invalid?: boolean;
};

type SelectContentProps = ComponentProps<typeof SelectPrimitive.Content>;

type SelectItemProps = ComponentProps<typeof SelectPrimitive.Item>;

/**
 * Picker root. Owns the open and selected state; render a trigger and a content part inside it.
 *
 * Re-exported unstyled because it renders no element of its own - the correct outcome for a thin
 * wrapper, and it keeps every behavioural prop reaching the primitive untouched: `value` and
 * `onValueChange` for controlled use, `defaultValue` for uncontrolled, plus `open`,
 * `defaultOpen`, `onOpenChange`, `disabled`, `required`, `name`, `dir` and `autoComplete`.
 *
 * CONTROLLED USE IS THE PRIMARY CASE HERE. The home feed's category filter derives its `value`
 * from the URL query string and pushes the next selection back into it from `onValueChange`, so
 * a filtered feed stays linkable, shareable, crawlable and correct under browser back and
 * forward navigation. Passing `value` without `onValueChange` produces a picker that cannot be
 * changed; pass `defaultValue` instead if that is genuinely wanted.
 *
 * Radix has no notion of an "empty" option value - passing `value=""` is how it is told to show
 * the placeholder, so a real "all categories" choice needs a non-empty sentinel value of its own
 * (`"all"`) which the caller maps to an absent query parameter.
 *
 * Passing `name` makes Radix render a hidden native input alongside the trigger, so this picker
 * participates in ordinary form submission without any native <select> needing to exist.
 */
const Select = SelectPrimitive.Root;

/**
 * The selected option's text, or the placeholder while nothing is selected.
 *
 * Re-exported unstyled: it renders a bare <span> whose only job is to hold whichever label is
 * current, and the trigger already styles it - `[&>span]:min-w-0 [&>span]:truncate` for a long
 * label, `data-[placeholder]:text-muted-foreground` on the trigger itself for the empty state.
 * Styling it again here would be a second, competing authority over the same element.
 *
 * Give it a `placeholder`. Without one an unselected picker renders an empty field with no hint
 * of what it chooses, and a sighted user has only the chevron to go on.
 */
const SelectValue = SelectPrimitive.Value;

/**
 * The label of a single option.
 *
 * Re-exported unstyled, and NOT optional even though `SelectItem` renders it for you.
 *
 * WHY IT EXISTS AT ALL, since Radix's item renders its children directly: the item is
 * `role="option"` with `aria-labelledby` pointing at the id this part generates, and it is this
 * part that registers the option's text for typeahead and for the value the trigger displays.
 * Text placed in an item OUTSIDE it is therefore visible but nameless - the option's accessible
 * name is empty, typing its first letters jumps nowhere, and the trigger shows a blank value
 * after selection. Nothing warns.
 *
 * `SelectItem` wraps its children in this part automatically, so the common case needs no thought.
 * Reach for it explicitly when an option's content is not a single run of text - an icon or a
 * badge beside the label - so that the TEXT is registered and the decoration is not:
 *
 * ```tsx
 * <SelectItem value="published">
 *   <SelectItemText>Published</SelectItemText>
 *   <Badge variant="success">live</Badge>
 * </SelectItem>
 * ```
 *
 * Nesting it inside an item that already received plain children is harmless - Radix tolerates
 * the extra level - but there is no reason to.
 */
const SelectItemText = SelectPrimitive.ItemText;

/**
 * The field that opens the picker.
 *
 * Styled to match `@/components/ui/input` exactly, so a picker and a text field align in the same
 * form row; see section 3 of the header for the full contract and for why that pinning is not
 * cosmetic. Radix renders a real `<button type="button">`, so `disabled` behaves natively.
 *
 * ### Accessibility contract
 *
 * This component deliberately does **not** name itself. A field's accessible name must come from
 * a real, visible label, so pass an `id` and bind `@/components/ui/label` to it with `htmlFor`:
 *
 * ```tsx
 * <Label htmlFor="category">Category</Label>
 * <Select value={category} onValueChange={setCategory}>
 *   <SelectTrigger id="category">
 *     <SelectValue placeholder="All categories" />
 *   </SelectTrigger>
 *   <SelectContent>
 *     <SelectItem value="engineering">Engineering</SelectItem>
 *   </SelectContent>
 * </Select>
 * ```
 *
 * An `aria-label` invented here would give every picker a name no sighted user can see and that
 * no label could override, so none is added.
 *
 * `id`, `aria-labelledby` and `aria-describedby` all reach the element untouched through the
 * spread. THAT IS SAFE ON THIS PRIMITIVE, WHICH IS WORTH SAYING because the sibling
 * dropdown-menu.tsx documents the opposite prohibition for its own trigger: that primitive
 * derives its trigger and panel ids from one `useId()` root and labels the panel with
 * `aria-labelledby={triggerId}`, so a caller's `id` there silently empties the panel's name.
 * Radix Select generates no id for its trigger and nothing reads one - the panel is identified
 * through `aria-controls` in the other direction - so an `id` here collides with nothing. The two
 * files disagree because the primitives do, not by oversight.
 *
 * Everything else Radix needs is already on the element and must not be duplicated:
 * `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-required` and `aria-autocomplete`.
 *
 * ### `react-hook-form` compatibility
 *
 * A picker is registered with `<Controller>` rather than `register()`, because the value changes
 * through `onValueChange` on the root instead of a DOM event on the field. Put `onBlur` and `ref`
 * from the controller's `field` on this trigger and `value` / `onChange` on `Select`.
 */
function SelectTrigger({
  className,
  children,
  invalid = false,
  'aria-invalid': ariaInvalid,
  ...props
}: SelectTriggerProps): JSX.Element {
  return (
    <SelectPrimitive.Trigger
      // `invalid` is mirrored into ARIA, but an explicitly supplied `aria-invalid` always wins -
      // a form that computes the attribute itself keeps control. `??` rather than `||` so a
      // deliberate `aria-invalid={false}` survives instead of being treated as absent. When
      // neither is supplied the attribute is omitted altogether, because rendering a literal
      // `aria-invalid="false"` on every picker would be noise in the accessibility tree that says
      // nothing the default state does not already say. Identical handling to input.tsx.
      aria-invalid={ariaInvalid ?? (invalid || undefined)}
      className={cn(TRIGGER_CLASSES, invalid && TRIGGER_INVALID_CLASSES, className)}
      {...props}
    >
      {children}
      {/* `asChild` so the chevron IS the icon slot rather than being wrapped in an extra span
          that would add a third flex child to the row. Decorative: the trigger's name comes from
          the caller's label and its state from Radix's `aria-expanded`, so announcing it would
          only repeat what is already there. */}
      <SelectPrimitive.Icon asChild>
        <ChevronDown aria-hidden="true" className={TRIGGER_ICON_CLASSES} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/**
 * Pointer affordance for scrolling a long list upward.
 *
 * Intentionally NOT exported - see SCROLL_BUTTON_CLASSES for why it is required and item 2 of the
 * header for why it stays private. Radix mounts it only while the list overflows upward.
 */
function SelectScrollUpButton(): JSX.Element {
  return (
    <SelectPrimitive.ScrollUpButton className={SCROLL_BUTTON_CLASSES}>
      <ChevronUp aria-hidden="true" />
    </SelectPrimitive.ScrollUpButton>
  );
}

/**
 * Pointer affordance for scrolling a long list downward. Not exported; see above.
 */
function SelectScrollDownButton(): JSX.Element {
  return (
    <SelectPrimitive.ScrollDownButton className={SCROLL_BUTTON_CLASSES}>
      <ChevronDown aria-hidden="true" />
    </SelectPrimitive.ScrollDownButton>
  );
}

/**
 * The floating panel that holds the options.
 *
 * Always rendered through `SelectPrimitive.Portal`, so the panel escapes any ancestor that clips
 * or scrolls. That is not cosmetic: the admin filter rows sit inside a horizontally scrollable
 * table container, and the editor's category picker sits inside a card, either of which would
 * crop an unportalled panel.
 *
 * `position` defaults to `popper` rather than to Radix's own `item-aligned`. Both are supported
 * and a caller may pass either, but `popper` is the right default here: it anchors the panel below
 * the field like every other floating surface in the product, it is collision-aware, and it is
 * the mode that publishes the trigger's measured width so the panel can match the field.
 * `item-aligned` overlays the panel so the selected option lands on the trigger, which reads as a
 * native platform picker and is deliberately not this product's idiom.
 *
 * `align`, `side`, `alignOffset`, `collisionPadding`, `avoidCollisions` and every other
 * positioning prop reach the primitive through the spread; `sideOffset` is the only one given a
 * default, which a caller can still override.
 *
 * The two scroll buttons and the viewport are composed here rather than left to the caller,
 * because a panel missing them is not a styling difference but a list that cannot be scrolled by
 * pointer - see SCROLL_BUTTON_CLASSES.
 *
 * @example A status picker in the author workspace
 * ```tsx
 * <Select value={status} onValueChange={setStatus}>
 *   <SelectTrigger id="status">
 *     <SelectValue placeholder="Any status" />
 *   </SelectTrigger>
 *   <SelectContent>
 *     <SelectItem value="draft">Draft</SelectItem>
 *     <SelectItem value="published">Published</SelectItem>
 *     <SelectItem value="archived">Archived</SelectItem>
 *   </SelectContent>
 * </Select>
 * ```
 */
function SelectContent({
  className,
  children,
  position = 'popper',
  sideOffset = CONTENT_SIDE_OFFSET,
  ...props
}: SelectContentProps): JSX.Element {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        sideOffset={sideOffset}
        className={cn(
          CONTENT_CLASSES,
          // Only in `popper` mode does `--radix-select-trigger-width` exist to be read.
          position === 'popper' && CONTENT_POPPER_CLASSES,
          className,
        )}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport className={VIEWPORT_CLASSES}>{children}</SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

/**
 * A single choosable option.
 *
 * `value` is required by Radix and must be a non-empty string: an empty value is reserved as the
 * signal that clears the selection back to the placeholder, so an "any"/"all" option needs a real
 * sentinel of its own.
 *
 * Children are wrapped in `SelectItemText` automatically, which is what registers the option's
 * text for typeahead, for the trigger's displayed value, and for its own accessible name - see
 * the note on `SelectItemText` for why that wrapping is load-bearing rather than convenience, and
 * for the case where you should reach for the part explicitly instead.
 *
 * The check indicator is rendered for you in the gutter the base classes reserve, so a caller
 * never has to think about the selected state. Radix mounts it only for the selected option.
 *
 * `disabled` is forwarded to the primitive, which sets `data-disabled` and drops the option out of
 * arrow-key and typeahead traversal; the base classes then dim it and stop it taking pointer
 * events. Prefer omitting an unavailable option entirely over disabling it, unless its absence
 * would itself be confusing.
 *
 * Colour is never the only signal that an option is selected: the check indicator carries the same
 * fact as the fill, so the selected row is identifiable without relying on hue at all.
 *
 * On the ARIA side, note that Radix computes `aria-selected` as "selected AND focused", so it
 * reads `false` on the chosen option once the highlight moves elsewhere in the list, while
 * `data-state="checked"` persists. That is upstream `@radix-ui/react-select` behaviour, not
 * something this wrapper sets or can override - which is another reason the check indicator is
 * rendered unconditionally for the selected option rather than being treated as decoration.
 */
function SelectItem({ className, children, ...props }: SelectItemProps): JSX.Element {
  return (
    <SelectPrimitive.Item className={cn(ITEM_CLASSES, className)} {...props}>
      <SelectPrimitive.ItemIndicator className={ITEM_INDICATOR_CLASSES}>
        {/* Decorative: `aria-selected` already carries the selected state, so announcing the
            tick as well would say it twice. Sized by ITEM_CLASSES' nested-SVG rule. */}
        <Check aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectItemText };
