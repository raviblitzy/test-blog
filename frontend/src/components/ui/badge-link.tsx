// BadgeLink - the design system's pill-shaped NAVIGATION chip.
//
// One primitive under src/components/ui/, and the sixteenth in a layer that
// together IS this project's design system: feature code consumes this layer and
// never reaches past it. It exists because two feature components - the post
// page's category row and the feed card's category footer - had each grown their
// own pill-shaped link out of `badgeVariants`, and the two copies had drifted
// apart in the three ways a duplicated affordance always does: they disagreed on
// the hover treatment, they disagreed on what a long label should do, and only
// one of them had a note about the target size. A chip that navigates is one
// element with one behaviour, so it is declared once, here.
//
// WHY THIS IS NOT A CHANGE TO ui/badge.tsx. That file renders a `<span>` and
// states plainly that it must not become interactive - "no hover step, no focus
// ring, no `tabIndex` and no click handling, because a span that reacts to a
// pointer is a control no keyboard can reach" - and it exports `badgeVariants`
// expressly so that "a category chip that navigates is a `Link`" can wear the
// pill's appearance on the focusable element itself. This file is the other half
// of that sentence: the appearance comes from there, the behaviour is declared
// here, and neither file has to know about the other's concern. Widening the
// badge's own base scale to fit an interactive target would have been the
// alternative and is worse - it would inflate every static status pill in every
// admin table to satisfy a rule (WCAG 2.5.8) that governs interactive targets
// only.
//
// FOUR THINGS THIS FILE DELIBERATELY OMITS. Each one looks like an improvement.
//
//   1. `'use client'`. Nothing here touches a hook, a browser API or an event
//      handler, so the module stays shared - and that is load-bearing rather
//      than tidy. Its first consumer, src/components/blog/post-content.tsx, is
//      deliberately directive-free so that a post's article text and its
//      category links are in the server-rendered HTML with no client JavaScript
//      executed, which is the SEO acceptance criterion this product is held to.
//      A directive here would pull that component - and the post page above it -
//      across the client boundary to render an anchor.
//   2. A `variant` prop. It looks like free generality and is not: the hover
//      step below moves `primary` to `accent`, which globals.css defines as the
//      emphasis step `primary` hovers to. That relationship holds for the
//      `category` tone and for no other - hovering a `draft` pill to `accent`
//      would change its HUE and say something the state does not mean, and
//      hovering a `danger` pill toward emphasis would say the opposite of what it
//      means. A chip in another tone needs a hover step chosen for that tone, so
//      it earns its own entry here rather than a parameter on this one.
//   3. `forwardRef`. React 19 hands `ref` to a function component as an ordinary
//      prop, so the wrapper would buy a display-name obligation and change
//      nothing observable. `ref` still works - it arrives inside `...props` and
//      reaches the anchor `next/link` renders.
//   4. An `external` mode. `next/link` is the right element for an href this
//      tier BUILDS (a category's feed URL, from `@/lib/seo`); it is the wrong
//      element for an href some author typed. Authored links stay plain anchors
//      in the component that renders authored content, and this primitive is not
//      asked to serve both.
//
// Every utility below resolves to a token or to an engine scale - verified by
// compiling this exact class list against the installed engine: `min-h-6` and
// `min-w-6` emit `calc(var(--spacing) * 6)`, the focus ring emits
// `var(--app-ring)` by way of `--color-ring`, and `max-w-full`,
// `whitespace-normal`, `wrap-anywhere` and `justify-center` emit keywords. There
// is no literal colour, no pixel dimension, no radius value, no `style` prop and
// no stylesheet of its own: src/app/globals.css is this tier's only stylesheet.

import Link from 'next/link';
import type { ComponentProps, JSX } from 'react';

import { badgeVariants } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * The chip's complete appearance and interaction, composed once at module scope
 * so the string is not rebuilt per render and cannot be assembled differently by
 * a second call site.
 *
 * `badgeVariants({ variant: 'category' })` supplies the pill itself - the tone
 * triple (ground, text, boundary), the `rounded-full` shape, the `px-2`/`py-0.5`
 * rhythm, the `text-xs font-medium` type and the leading-glyph sizing. Nothing
 * about the pill's look is chosen here, which is what keeps a navigating chip
 * visually identical to a static one.
 *
 * The four groups added on top are the concerns a non-interactive `<span>` has no
 * business carrying:
 *
 *   * **A long label wraps inside its box.** `whitespace-normal` displaces the
 *     pill's own `whitespace-nowrap` (the same property group, so the class
 *     merger settles it by call order rather than by stylesheet order),
 *     `wrap-anywhere` sets `overflow-wrap: anywhere`, and `max-w-full` caps the
 *     element at its container.
 *
 *     `wrap-anywhere` rather than `break-words` is the load-bearing choice, and
 *     the difference is not cosmetic: `overflow-wrap: anywhere` is the value that
 *     also shrinks the box's MIN-CONTENT size, and a chip is always a flex item -
 *     of the post page's pill row, of the feed card's footer - whose automatic
 *     minimum size is exactly that min-content size. With `break-word` the
 *     element still refuses to shrink below its longest unbreakable run, which is
 *     how an 80-character category name pushed past a 375px card and put the
 *     whole document into horizontal scroll; with `anywhere` the same name wraps
 *     inside the pill and the row reflows. That is why neither `min-w-0` nor
 *     `overflow-hidden` appears here: with the minimum size gone there is nothing
 *     left to clip, and clipping was only ever the mitigation for not wrapping.
 *
 *     Wrapping is the right answer HERE even though `ui/badge.tsx` chose
 *     `nowrap`, and the two are not in conflict: that file's reason is that a
 *     two-word lifecycle state ("Pending review") broken across lines reads as
 *     two pills - a real risk for a closed set of short, product-authored labels.
 *     A category name is neither closed nor short: it is administrator-authored
 *     free text with an 80-code-point ceiling, so the label this chip carries is
 *     the one case the badge's assumption does not cover.
 *
 *     Measured in a real browser rather than reasoned about: an 80-character name
 *     inside a feed card at a 375px viewport renders 293px wide and 38px tall -
 *     two 16px lines plus the padding and borders - with its right edge at 334
 *     against the card's 359, and the document's `scrollWidth` equal to its
 *     `clientWidth` at 375, 768 and 1440. The same name in the post page's pill
 *     row stays inside its list item at every one of those widths.
 *
 *   * **The target is at least 24px in both directions.** `min-h-6`/`min-w-6` are
 *     `calc(var(--spacing) * 6)`. The pill's own geometry is 22px tall - a
 *     `text-xs` 16px line box, `py-0.5`'s 4px and two 1px borders - which is 2px
 *     under WCAG 2.5.8 AA, and `items-center` (from the badge base) centres the
 *     label in the 2px the minimum adds. `min-w-6` closes the degenerate
 *     one-character label, and `justify-center` keeps that label centred in the
 *     box the minimum widened; both are inert for every label the taxonomy
 *     actually produces, since 16px of horizontal padding plus any real name
 *     already exceeds 24px.
 *
 *     BLITZY [A11Y]: this clears 2.5.8 (AA, 24x24) and does NOT reach 2.5.5
 *     (AAA, 44x44), which is a deliberate stop rather than an oversight. A 44px
 *     chip would be twice the height of every other pill in the product - a real
 *     design-system violation traded for a notional one - and growing the hit
 *     area with a pseudo-element instead would overlap the excerpt above, the
 *     card edge below and, across a `gap-2` row, the neighbouring chip, turning a
 *     small target into a mis-tapped one. Flagged for designer review at the size
 *     the system specifies. The mitigations are real: the chip is a true anchor,
 *     reachable and operable by keyboard with a 2px focus ring, its full name is
 *     always in the accessible tree, and it is never the only route to that
 *     content - the feed's own filter control reaches the same URL.
 *
 *   * **Hover is announced twice.** `hover:border-accent hover:text-accent` steps
 *     to the emphasis token globals.css designates as the one `primary` hovers
 *     to, so the chip brightens in the direction of the active theme with no
 *     per-theme branching; `hover:underline` means the affordance is not carried
 *     by colour alone, which is what a visitor who cannot distinguish these two
 *     tones needs. This is the treatment the feed card had and the post page did
 *     not - resolved in favour of the accessible one.
 *
 *     One property of the engine worth knowing before debugging this: it compiles
 *     every `hover:` utility inside `@media (hover: hover)`, verified in the
 *     compiled stylesheet. A touch device therefore never gets a hover state
 *     stuck on after a tap - and a browser that reports no hovering pointer at
 *     all, which a headless one does, will not show the step even under a
 *     synthetic mouse. Neither is a fault in this file.
 *
 *   * **Focus is visible, and motion is optional.** A 2px `--color-ring` outline
 *     offset by 2px, which the pill's `rounded-full` shapes; and the colour
 *     transition sits behind `motion-safe:` so a visitor who has asked for less
 *     motion gets the same states with no animation.
 */
const BADGE_LINK_CLASSES = cn(
  badgeVariants({ variant: 'category' }),
  'max-w-full whitespace-normal wrap-anywhere',
  'min-h-6 min-w-6 justify-center',
  'hover:border-accent hover:text-accent hover:underline',
  'focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',
  'motion-safe:transition-colors motion-safe:ease-out',
);

/**
 * Props accepted by {@link BadgeLink}.
 *
 * Every `next/link` prop, which makes `href` required - there is no such thing as
 * a chip that navigates nowhere, and a caller with nothing to link to wants
 * `Badge`. Not exported, to keep this module's documented surface to the
 * component alone; a caller that needs the shape derives it, which also keeps it
 * correct if a prop is ever added:
 *
 * ```ts
 * type MyProps = ComponentProps<typeof BadgeLink>;
 * ```
 */
type BadgeLinkProps = ComponentProps<typeof Link>;

/**
 * A pill-shaped link: the badge's `category` appearance on an element that
 * navigates.
 *
 * Renders exactly one anchor - the pill IS the link, so the shape, the label, the
 * focus ring and the click target are one element rather than a `<span>` nested
 * inside an `<a>` with the appearance on one and the ring on the other. It is
 * server-renderable and crawlable, which is the point of using it for a category:
 * the taxonomy is discoverable from a post without executing any client
 * JavaScript.
 *
 * **The children are the label and the accessible name.** Pass the category's
 * name and nothing else is needed - no `aria-label`, no title attribute, no
 * visually hidden twin. A name of any length is safe: the chip wraps rather than
 * overflowing, and the full text stays in the DOM, in the accessible tree and in
 * the server-rendered HTML either way.
 *
 * **Build the `href`, do not write it.** A category has no route of its own in
 * this product - its page IS the category-filtered feed - so the href comes from
 * `categoryFeedPath` in `@/lib/seo`, which is the one builder the feed's filter
 * control and the generated sitemap also use. A hand-written query string here is
 * how those three come to disagree about how a category is addressed.
 *
 * For a chip that does NOT navigate, use `Badge` from
 * `@/components/ui/badge` - it is the same pill without any interactive state.
 * For an authored link inside a body of prose, use a plain anchor: this component
 * is for hrefs this tier builds.
 *
 * @param className - Merged through `cn()`, so a caller's utility wins its own
 *   property group. The practical case is a roomier surface than a feed card:
 *   `className="text-sm"` replaces the type size with the next `--text-*` step
 *   and leaves the tone, the shape and every interactive state intact.
 * @param props - Every other `next/link` prop, `href`, `children` and `ref`
 *   included, spread onto the element last so a caller can override any
 *   attribute.
 * @returns The rendered chip.
 *
 * @example A post's category row, in a Server Component
 * ```tsx
 * <BadgeLink href={categoryFeedPath(category)}>{category.name}</BadgeLink>
 * ```
 *
 * @example With a leading glyph, which the pill sizes to the label
 * ```tsx
 * <BadgeLink href={categoryFeedPath(category)}>
 *   <TagIcon aria-hidden="true" />
 *   {category.name}
 * </BadgeLink>
 * ```
 */
export function BadgeLink({ className, ...props }: BadgeLinkProps): JSX.Element {
  // `className` is destructured out above so the spread cannot clobber the
  // composed string; every other attribute a caller passes still wins, which is
  // what lets a consumer add `rel`, `prefetch` or a data attribute without this
  // primitive having to enumerate them.
  return <Link className={cn(BADGE_LINK_CLASSES, className)} {...props} />;
}
