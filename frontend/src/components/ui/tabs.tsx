'use client';

// Tabs - the token-styled wrapper over @radix-ui/react-tabs, and one of the
// fifteen primitives in src/components/ui/ that together ARE this project's
// design system. No third-party component library was specified, so this
// directory is the library; feature code consumes these parts and never reaches
// past them to a raw element or to Radix directly.
//
// WHY THIS FILE IS A CLIENT MODULE
//
// A tab set is stateful interactive UI, and its documented props include
// `onValueChange` - a function. A function cannot cross a server-to-client
// boundary, so the boundary has to sit at or above the component that receives
// it. Declaring it here rather than in every consumer keeps the island narrow:
// this module contains no state, no effect, no fetch and no logic beyond
// composing class strings, so nothing beyond the styling itself is pulled into
// the client bundle. A Server Component may still render <Tabs> - React inserts
// the boundary at this import.
//
// WHAT RADIX OWNS, AND MUST NOT BE REIMPLEMENTED HERE
//
// @radix-ui/react-tabs@1.1.21 depends on @radix-ui/react-roving-focus, and that
// is the whole reason it is in the dependency set. Verified against the
// installed package rather than assumed, the primitive emits every one of the
// following on its own:
//
//   role="tablist" | "tab" | "tabpanel"     the WAI-ARIA Tabs pattern
//   aria-selected                            on the active trigger
//   aria-controls / aria-labelledby          the trigger-to-panel pairing
//   aria-orientation                         from the `orientation` prop
//   data-state="active" | "inactive"         on both trigger and panel
//   data-disabled, data-orientation          state hooks for styling
//   tabIndex={0} on the panel                so the panel itself is focusable
//   hidden on every inactive panel           one panel is ever displayed
//
// plus the roving-focus model: one stop in the page tab sequence for the whole
// list, ArrowRight/ArrowLeft (ArrowDown/ArrowUp when vertical) to move between
// triggers, Home/End to jump to the ends, and Enter/Space to activate under
// `activationMode="manual"`.
//
// So this file authors NO role, NO aria-* attribute, NO tabIndex and NO
// onKeyDown handler. Adding any of them does not augment the pattern, it
// competes with it: a hand-written tabIndex breaks the roving-focus contract by
// putting every trigger back into the page tab sequence, and a hand-written
// aria-selected can disagree with the primitive's own idea of which tab is
// selected. Hand-rolling behaviour a primitive already supplies is explicitly
// out of bounds for this layer.
//
// THE ACTIVE STATE IS AN ATTRIBUTE SELECTOR, NEVER A MANAGED CLASS
//
// The selected trigger is styled through `data-[state=active]:`, which compiles
// to `[data-state="active"]` - the exact attribute Radix writes beside
// `aria-selected`. Both come from one source of truth, so the visual state
// cannot drift out of step with the state assistive technology is told about.
// The alternative - reading the value in the consumer and toggling a class -
// reintroduces exactly that divergence and is why it is not done here.
//
// The active tab is not signalled by colour alone: it gains a raised
// `--color-surface` panel and a shadow against the recessed list ground, and it
// carries `aria-selected="true"` for anyone not looking at pixels.
//
// STYLING RULES THIS FILE IS HELD TO
//
//   * Zero hardcoded values. Every colour, radius, spacing step, font size,
//     shadow and outline width is an engine-generated utility resolving to a
//     token. There is no hex, no rgb()/hsl(), no px/rem literal and no
//     arbitrary bracket value carrying a colour or a dimension.
//   * Semantic tokens only - `bg-surface-muted`, `text-muted-foreground`,
//     `bg-surface`, `text-foreground`, `outline-ring`. Never a primitive colour
//     family and shade; that mapping belongs to src/app/globals.css alone.
//   * No `dark:` conditional anywhere. Dark mode is a token-layer concern: each
//     semantic token is declared twice in globals.css, so these classes
//     re-theme with no change to this file. A `dark:` variant here would be a
//     second, competing theming mechanism.
//   * One breakpoint vocabulary. This file needs no responsive variant at all -
//     see the wrapping note on TabsList - and authors no media query. The only
//     at-rule involved is the one `motion-safe:` generates for us.
//
// WHY `outline-*` RATHER THAN `ring-*` FOR FOCUS
//
// Two reasons, both concrete. globals.css already sets a global
// `:focus-visible { outline: 2px solid var(--color-ring); outline-offset: 2px }`
// floor and notes that a primitive layering its own `focus-visible:outline-2`
// lands on exactly that width instead of visibly changing thickness - so
// outline utilities reinforce the floor where ring utilities would double it.
// And `ring-*` is box-shadow based, which means it needs a ring-offset COLOUR
// matching whatever sits behind the control; inside the list that is
// `--color-surface-muted`, not `--color-background`, so a ring would either
// paint a wrong-coloured halo or hard-code its own backdrop assumption. An
// outline needs no such knowledge and is not clipped by an overflow container.
//
// DELIBERATELY ABSENT. DO NOT ADD.
//
//   1. A default export, or any part beyond the four below. Radix exposes
//      Root/List/Trigger/Content and consumers compose them; collapsing them
//      into one prop-driven <Tabs items={...} /> component would take the
//      composition away and force a new prop for every future arrangement.
//   2. `forwardRef`. On React 19 `ref` is an ordinary prop, so it rides the
//      `...props` spread into the primitive with nothing to wrap.
//   3. A hover FILL on a trigger. The hover treatment this component does carry
//      is a text-colour step on inactive triggers only (see TabsTrigger); a fill
//      is deliberately not used, because any ground applied on hover approaches
//      the active tab's own `bg-surface` and makes a hovered inactive tab read as
//      the selected one. The state change between panels remains the primary
//      affordance, and `motion-safe:transition-colors` animates both.
//   4. Domain knowledge. The author workspace happens to group posts by the
//      DRAFT/PUBLISHED/ARCHIVED lifecycle and the admin shell switches between
//      sections, but those values are supplied by the caller. This primitive
//      imports no domain type and knows no field name.
//   5. `overflow-hidden` on the list, or any scroll container. It would clip
//      the focus outline of the first and last trigger.

import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * Root of a tab set. Owns the selected value and the orientation.
 *
 * Renders a vertical flow so the list sits above its panel. The panel's own
 * `mbs-*` supplies the space between the two, so no `gap` is declared here -
 * carrying both would double the separation, and a margin that travels with the
 * panel keeps the rhythm correct even when a caller wraps the panel in a
 * container of its own.
 *
 * Controlled with `value` + `onValueChange`, or uncontrolled with
 * `defaultValue`. `activationMode="manual"` switches the list from selecting a
 * tab as focus arrives to requiring Enter or Space, which is the better choice
 * when a panel is expensive to render.
 *
 * For `orientation="vertical"` pass `className="flex-row"` here and
 * `className="flex-col"` to the list: `cn()` resolves those against the base
 * classes deterministically, because a caller's class always wins its own
 * property group.
 *
 * @example Post-status grouping in the author workspace
 * ```tsx
 * <Tabs defaultValue="published">
 *   <TabsList>
 *     <TabsTrigger value="published">Published</TabsTrigger>
 *     <TabsTrigger value="draft">Drafts</TabsTrigger>
 *     <TabsTrigger value="archived">Archived</TabsTrigger>
 *   </TabsList>
 *   <TabsContent value="published">{publishedPosts}</TabsContent>
 *   <TabsContent value="draft">{draftPosts}</TabsContent>
 *   <TabsContent value="archived">{archivedPosts}</TabsContent>
 * </Tabs>
 * ```
 */
function Tabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root className={cn('flex flex-col', className)} {...props} />;
}

/**
 * The `role="tablist"` container. Wraps its triggers in a recessed
 * `--color-surface-muted` ground so the active trigger's raised
 * `--color-surface` panel reads as lifted out of it.
 *
 * Sized to its content rather than to its container: as a flex item of the root
 * it would otherwise stretch to full width, since `align-items` resolves to
 * `stretch` and that would defeat `inline-flex`. `w-fit` restores the
 * content-hugging segmented-control shape and is a harmless no-op if a caller
 * ever overrides the root's display.
 *
 * `max-w-full` and `flex-wrap` together are what keep the narrowest supported
 * viewport free of horizontal overflow. The list can never exceed its
 * container, and once capped its triggers wrap onto a second row instead of
 * pushing the document sideways - so no responsive variant and no media query
 * is needed, and no scroll container is introduced that could clip a focus
 * outline or hide a trigger off-screen. `gap-1` keeps wrapped rows and
 * neighbouring triggers apart.
 *
 * `loop` is forwarded to the primitive and controls whether arrow navigation
 * wraps from the last trigger back to the first.
 */
function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        'bg-surface-muted text-muted-foreground inline-flex w-fit max-w-full flex-wrap items-center justify-center gap-1 rounded-lg p-1',
        className,
      )}
      {...props}
    />
  );
}

/**
 * One `role="tab"` control, rendered by the primitive as a real `<button>`.
 *
 * Inactive triggers sit in `--color-muted-foreground`, inherited from the list.
 * The active one is selected purely by `data-[state=active]`, gaining the
 * raised `--color-surface` panel, `--color-foreground` text and a shadow. That
 * attribute is written by Radix alongside `aria-selected`, so the two can never
 * disagree.
 *
 * `whitespace-nowrap` keeps a label on one line; the list wraps whole triggers
 * instead of breaking their text.
 *
 * Hovering an INACTIVE trigger lifts its label from the list's
 * `text-muted-foreground` to the full-strength `text-foreground`, so a pointer
 * user gets feedback that the tab is actionable before committing to it. The
 * active trigger is unaffected: the rule is scoped to `data-state="inactive"`,
 * which Radix sets on every unselected trigger, so hover can never imitate
 * selection.
 *
 * The colour transition is scoped by `motion-safe:`, which the engine compiles
 * to `@media (prefers-reduced-motion: no-preference)` - so a visitor who has
 * asked for reduced motion gets the state change instantly rather than animated,
 * and this file still authors no media query of its own.
 *
 * Pass `disabled` to render an unavailable tab: the primitive skips it during
 * arrow navigation, and the native `:disabled` state dims it and takes it out
 * of pointer reach. Focus remains ringed regardless, because a control that can
 * receive focus must always show that it has.
 *
 * @example An icon paired with a label
 * ```tsx
 * <TabsTrigger value="drafts">
 *   <FileText aria-hidden="true" className="size-4" />
 *   Drafts
 * </TabsTrigger>
 * ```
 */
function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'focus-visible:outline-ring data-[state=active]:bg-surface data-[state=active]:text-foreground inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm motion-safe:transition-colors',
        // Hover, on the INACTIVE tabs only. Scoped by `data-[state=inactive]:`
        // rather than by a bare `hover:`, which is what makes it impossible for
        // this line to touch the selected tab: Radix marks every unselected
        // trigger `data-state="inactive"`, so the active tab's own ground and
        // foreground above are never in the same fight. It is a text-colour step
        // to the full-strength foreground token, not a fill - a fill would
        // approach the active tab's `bg-surface` and make a hovered inactive tab
        // read as selected, which is the one thing a tab hover must not do.
        // `disabled:` above sits later in the cascade and keeps a disabled
        // trigger out of pointer reach, so it cannot pick this up either.
        'data-[state=inactive]:hover:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

/**
 * The `role="tabpanel"` region paired with the trigger of the same `value`.
 *
 * Deliberately carries no ground, border or padding of its own: a panel holds
 * arbitrary content - a table, a card grid, a form - and each of those brings
 * its own surface. Imposing one here would double every border and inset.
 *
 * Two classes, and a reason for each. `mbs-2` is the panel's inset below the tab
 * list, and it lives here rather than as a `gap` on the root so that it holds
 * even when a caller nests the panel inside a container. It cannot strand
 * itself on a hidden panel either, because the primitive renders only the
 * selected one.
 *
 * `mbs-2` is the LOGICAL utility - it emits `margin-block-start`, not
 * `margin-top` - so the inset follows the writing mode rather than assuming a
 * top-to-bottom one. That matches the rest of this file, since the engine's
 * `px-*` and `py-*` already emit `padding-inline` and `padding-block`. One
 * consequence worth knowing when overriding it: pass `mbs-*` rather than `mt-*`.
 * `margin-block-start` and `margin-top` are genuinely different properties, so
 * `cn()` correctly declines to treat them as one group - `mbs-6` replaces this
 * value, whereas `mt-6` would sit alongside it and leave the winner to
 * stylesheet order.
 *
 * The focus outline is not redundant: the primitive gives the panel
 * `tabIndex={0}`, so pressing Tab from the active trigger moves focus into the
 * panel itself - a deliberate part of the pattern, letting a keyboard user
 * reach panel content directly. A focusable element with no visible focus
 * indicator is exactly the failure the accessibility floor forbids.
 *
 * Pass `forceMount` to keep an inactive panel mounted when an animation library
 * needs to control its exit.
 */
function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn(
        'focus-visible:outline-ring mbs-2 focus-visible:outline-2 focus-visible:outline-offset-2',
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
