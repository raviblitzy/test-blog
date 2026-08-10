// Badge - the design system's category and status pill, in both of its forms.
//
// One of the fifteen primitives under src/components/ui/ that together ARE this
// project's design system: feature code consumes this layer and never reaches
// past it. Radix publishes no badge, so this is one of the nine primitives
// authored directly over a plain element.
//
// The module publishes TWO components over ONE appearance table:
//
//   Badge      a `<span>`. A pill that LABELS - a category name beside a title,
//              a lifecycle state on a dashboard row. A run of text with a shape
//              rather than a control: it is not interactive and must not become
//              so.
//   BadgeLink  the anchor `next/link` renders. A pill that NAVIGATES - a
//              category chip reaching the category-filtered feed. It IS a
//              control, so it carries the hover step, the focus ring, the
//              long-label wrapping and the minimum target size that a span has
//              no business carrying.
//
// Section 3 records why the two share a module, and why sharing one is not the
// same thing as making the span interactive.
//
// ---------------------------------------------------------------------------
// 1. WHAT THE VARIANTS ARE KEYED ON, AND WHY THEY ARE NOT KEYED ON TONE
//
// The eight keys are DOMAIN STATES, not colours: `neutral`, `category`, the
// three `PostStatus` members and the three `CommentStatus` members. Two tables
// below - POST_STATUS_BADGE_VARIANTS and COMMENT_STATUS_BADGE_VARIANTS - map a
// wire literal straight to its key, so a consumer in src/components/blog/ or
// src/components/admin/ never has to decide what colour a state is.
//
// That is the whole point. If the keys were tones (`success`, `warning`,
// `destructive`, as alert.tsx's are - correctly, because an alert's caller is
// choosing an announcement, not describing a record) then every call site would
// have to hold an opinion about which colour `ARCHIVED` deserves, and the eight
// or nine places that render a status pill would drift apart one by one. Keyed
// on the state, the decision lives here once and a later re-tone is a one-line
// edit in this file. There is therefore deliberately NO tone-named key, and
// adding one would reopen exactly that drift; a call site that wants an
// affirmative pill wants `published` or `approved`, and one of those is what it
// actually has in hand.
//
// Two pairs share a treatment on purpose - `draft`/`pending` are both cautionary
// and `published`/`approved` are both affirmative - and they stay separate keys
// anyway, because they are separate states that happen to agree today. Nothing
// renders both: a post's lifecycle and a comment's moderation state never appear
// in one list.
//
// UserRole gets no key and no table. table.tsx renders `<Badge>{user.role}</Badge>`
// with no variant, which is right: authority is not a state with a tone, and the
// neutral pill is what it should look like.
//
// ---------------------------------------------------------------------------
// 2. COLOUR IS NEVER THE MESSAGE
//
// Every pill's meaning is carried by its own visible text - "Draft",
// "Published", "Pending" - and the tone only reinforces it. That is what keeps
// the component usable by a visitor who cannot distinguish these hues, and it is
// why there is no icon-only or dot-only mode and no `aria-hidden` here: whatever
// the caller puts inside is the accessible content, and it must say the state.
//
// Every text/ground pair below was computed against the token layer rather than
// eyeballed, and each clears the WCAG AA 4.5:1 body-text floor in BOTH themes at
// this 12px size - the tightest is `published`/`approved` at 4.51:1 in light. No
// tone in the table is therefore implemented below a threshold.
//
// The file's one BLITZY [A11Y] deferral is not about contrast and does not belong
// to the table: it sits on BADGE_LINK_CLASSES, where the navigating chip clears
// WCAG 2.5.8's 24x24 AA target minimum and stops deliberately short of 2.5.5's
// 44x44 AAA size. The reasoning, the mitigations and the browser measurements are
// recorded there.
//
// The per-variant figures quoted below are the token layer's own published
// measurements, taken from the A11Y table in src/app/globals.css so that they
// cannot drift from the values they describe. A browser rounds the wide-gamut
// tokens into 8-bit sRGB before compositing, which lands a hundredth or two
// lower on two of them - `warning` measures 4.59:1 and `primary` 4.67:1 in the
// rendered document rather than the table's 4.61 and 4.70. Both still clear the
// floor, and the difference is quantisation rather than disagreement; it is
// recorded here so nobody re-derives it and concludes the table is wrong.
//
// The SPAN is NOT interactive and must not become so. No `role`, no `tabIndex`,
// no `onClick`, no focus ring and no hover step on `Badge` - a badge that
// responds to a click while announcing itself as a span is a control a keyboard
// cannot reach. A category chip that NAVIGATES is `BadgeLink` at the foot of this
// file, a real anchor that is focusable by construction; a chip that performs an
// action rather than navigating is a `Button` with `asChild`. Both of those
// exist, so `Badge` never has to grow a handler.
//
// `BadgeLink` does carry a hover step, a focus ring and a 24px minimum target,
// and that is not an exception to the paragraph above. Those states are declared
// on the anchor, in a class list `Badge` never reads, and a span cannot inherit
// them from a sibling export.
//
// ---------------------------------------------------------------------------
// 3. TWO COMPONENTS, ONE MODULE - AND WHY THE SPAN STAYS INERT
//
// `BadgeLink` exists because two feature components - the post page's category
// row and the feed card's category footer - had each grown their own pill-shaped
// link out of `badgeVariants`, and the two copies had drifted apart in the three
// ways a duplicated affordance always does: they disagreed on the hover
// treatment, they disagreed on what a long label should do, and only one of them
// had a note about the target size. A chip that navigates is one element with one
// behaviour, so it is declared exactly once.
//
// It is declared HERE, beside `Badge`, rather than in a module of its own,
// because the design system is a fixed inventory of fifteen primitives and the
// pill is ONE of them. An element that is the pill's appearance carried on a
// focusable tag is still the pill; it is not a sixteenth primitive, and giving it
// its own file would say otherwise. Keeping both halves against the single
// appearance table they share has a second, practical payoff: a re-tone or a
// shape change stays one edit that reaches the labelling pill and the navigating
// one together, which is what a duplicated class list could never guarantee.
//
// Sharing a module is NOT the same as making the span interactive, and three
// structural facts keep them apart rather than a convention anyone has to
// remember:
//
//   * They are different ELEMENTS. `Badge` renders `<span>`; `BadgeLink` renders
//     the anchor `next/link` emits. Neither can acquire the other's semantics,
//     and no prop on either reaches the other.
//   * They are different CLASS LISTS. `badgeVariants` is the appearance both
//     wear. The hover step, the focus ring, the long-label wrapping and the
//     minimum target are composed into BADGE_LINK_CLASSES alone, which `Badge`
//     never reads.
//   * The shared base is not WIDENED for the anchor. Growing it to clear WCAG
//     2.5.8's 24px interactive minimum would inflate every static status pill in
//     every admin table to satisfy a rule that governs interactive targets only,
//     so the two missing pixels are added by the anchor's own `min-h-6`/`min-w-6`
//     instead. That is the same reason the two disagree about `whitespace`: the
//     base holds a two-word lifecycle state on one line, and the anchor displaces
//     that for the free-text category name it alone carries.
//
// `BadgeLink` takes no `variant` prop, and that is a constraint rather than an
// omission waiting to be filled in. Its hover step moves `primary` to `accent`,
// which src/app/globals.css defines as the emphasis step `primary` hovers to.
// That relationship holds for the `category` tone and for no other - hovering a
// `draft` pill to `accent` would change its HUE and say something the state does
// not mean, and hovering a `danger` pill toward emphasis would say the opposite
// of what it means. A navigating chip in another tone needs a hover step chosen
// for that tone, so it earns its own export here rather than a parameter on this
// one.
//
// ---------------------------------------------------------------------------
// 4. WHAT THIS FILE DELIBERATELY OMITS
//
//   1. `'use client'`. There is no hook, no state, no browser API and no event
//      handler in either component, so the module stays shared - and that is
//      load-bearing rather than tidy. The surfaces that render the most pills are
//      Server Components: the server-rendered feed cards, the post detail page's
//      category row and the author profile. src/components/blog/post-content.tsx
//      in particular is deliberately directive-free so that a post's article text
//      AND its category links are in the server-rendered HTML with no client
//      JavaScript executed, which is the SEO acceptance criterion this product is
//      held to. A directive here would pull that component - and the post page
//      above it - across the client boundary to paint a static span and an
//      anchor. `next/link` needs no directive of ours: a Server Component may
//      render a Client Component, and Next.js server-renders the anchor into the
//      same initial HTML.
//   2. `forwardRef`, on either component. React 19 hands `ref` to a function
//      component as an ordinary prop, so it arrives inside `...props` and lands
//      on the span, or reaches the anchor `next/link` renders, like any other
//      attribute. Wrapping would buy a display-name obligation and change
//      nothing observable.
//   3. A `dark:` variant, anywhere. Every colour below resolves to a semantic
//      token that src/app/globals.css declares TWICE - once at the document root
//      and once under `.dark`. The pill therefore re-themes itself, and a
//      conditional here would be a second, competing source of truth for a
//      value this file must not own. The two values are named there and
//      deliberately not transcribed here.
//   4. A stylesheet, a `<style>` tag, a `style` prop, a media query and a
//      breakpoint. globals.css is this tier's only stylesheet and the engine's
//      five breakpoints are the entire responsive vocabulary; a pill is the same
//      size at every viewport, so it needs none of them.
//   5. An `external` mode on `BadgeLink`. `next/link` is the right element for an
//      href this tier BUILDS - a category's feed URL, from `@/lib/seo`. It is the
//      wrong element for an href some author typed: authored links stay plain
//      anchors in the component that renders authored content, and this primitive
//      is not asked to serve both.
//
// Every utility in both class lists resolves to a token or to an engine scale,
// verified by compiling them against the installed engine: `min-h-6` and `min-w-6`
// emit `calc(var(--spacing) * 6)`, the focus ring emits `var(--app-ring)` by way
// of `--color-ring`, and `max-w-full`, `whitespace-normal`, `wrap-anywhere` and
// `justify-center` emit keywords. There is no literal colour, no pixel dimension
// and no radius value anywhere below.

import Link from 'next/link';
import type { ComponentProps, JSX } from 'react';

import { cva, type VariantProps } from 'class-variance-authority';

import type { CommentStatus, PostStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * The pill's appearance, as a `class-variance-authority` table.
 *
 * Exported because this exact appearance is sometimes needed on an element that
 * is not a `<span>`. {@link BadgeLink} at the foot of this file is the first such
 * consumer - a category chip that navigates is an anchor - and the sibling `blog`
 * and `admin` folders reach for the table directly when a chip is part of another
 * element's own markup, such as a Radix select option. Those call sites spell
 * `className={badgeVariants({ variant: 'category' })}` rather than nesting a
 * `Badge` inside another element or, worse, restating the class list. Reach for
 * {@link Badge} for a pill that labels and {@link BadgeLink} for one that
 * navigates; reach for this table only when the element has to be something else
 * again.
 *
 * Every value in the table comes from the token layer. There is no literal
 * colour, radius, size or spacing here that could drift from
 * src/app/globals.css, and no colour family and shade - only the semantic names.
 */
export const badgeVariants = cva(
  [
    // A flex row so a leading glyph and the label share one baseline without a
    // margin between them, and so the `gap` below is what separates them rather
    // than a sibling margin.
    'inline-flex items-center gap-1',

    // `whitespace-nowrap` keeps a two-word state on one line: "Pending review"
    // broken across two lines inside a pill reads as two pills.
    //
    // Note what is NOT here, because it looks like an omission: the
    // `overflow-hidden`/`text-ellipsis` truncation triple. `text-overflow` is
    // not an inherited property and applies to a block container, while this
    // element is a FLEX container whose label sits in an anonymous flex item -
    // so the class would be inert here and only look like a safeguard. A caller
    // with an arbitrarily long label truncates the text it owns, or constrains
    // the element around the pill; the labels this product actually renders are
    // short - three lifecycle states, three moderation states and a seeded
    // category taxonomy.
    'whitespace-nowrap',

    // Shape and rhythm, from the token scales. `rounded-full` is the engine's
    // own pill utility rather than a `--radius-*` step, and that is the intent:
    // the design system calls this element a pill, `--radius-full` is not a
    // token in the catalogue, and `rounded-md` would make it a small card
    // indistinguishable in shape from a Card or an Input. `px-2`/`py-0.5` are
    // --spacing multiples, which is what keeps the chip's rhythm in step with
    // every other primitive.
    'rounded-full px-2 py-0.5',

    // A hairline, whose COLOUR each variant sets. Bare `border` is width only;
    // the base layer in globals.css already points `border-color` at the
    // hairline token, so this is never `currentColor` even for a moment, and
    // each variant's `border-*` overrides it from the utilities layer.
    //
    // The boundary is decorative: this is not an interactive control, so WCAG
    // 1.4.11's 3:1 requirement - which governs the boundary that IDENTIFIES a
    // control - does not apply to it, and `border-border` at 1.23:1 in light is
    // the correct decorative hairline rather than a shortfall. The variants that
    // carry a chromatic tone reach 4.51:1 or better on the same ground anyway.
    'border',

    // Type. `text-xs` is --text-xs and `font-medium` is the weight step that
    // keeps a 12px label legible without shouting.
    'text-xs font-medium',

    // An optional leading glyph - a check on an approved comment, a tag on a
    // category chip. Sized to the label's own 12px so the two share an optical
    // line, and `shrink-0` stops a long label squashing it. Without this pair
    // the `gap-1` above would have nothing to separate.
    '[&>svg]:size-3 [&>svg]:shrink-0',
  ],
  {
    variants: {
      /**
       * The domain state the pill describes. Selects the tone only - the label
       * text the caller passes is what carries the meaning.
       *
       * Every entry is a complete tone triple (ground, text, boundary) rather
       * than a colour spliced into a shared ground, so one row is the whole
       * answer for one state and nothing has to be read two places at once.
       * `bg-surface-muted` is the ground throughout, which is the treatment
       * alert.tsx established for a status tone: a solid chromatic fill is the
       * loudest thing the token layer can paint, and a feed card carrying two
       * category chips or an admin table carrying forty status pills would
       * become unreadable long before it became informative.
       */
      variant: {
        /**
         * The default, and what `<Badge>` with no variant renders. A neutral
         * chip for a value that has no state semantics - a user's role, a tag, a
         * count. Full-strength `foreground` text at 16.28:1 light and 14.00:1
         * dark, with the decorative hairline.
         */
        neutral: 'border-border bg-surface-muted text-foreground',

        /**
         * A category chip, on a feed card, a post's header or a filter summary.
         *
         * `primary` is the brand's resting token and this is a resting element;
         * `accent` is deliberately not used, because globals.css defines it as
         * the EMPHASIS step primary hovers to, and spending it here would make a
         * static chip look like a hovered control. Measured 5.88:1 light and
         * 4.70:1 dark on this ground - the pair globals.css itself lists as the
         * tightest dark case it accepts.
         */
        category: 'border-primary bg-surface-muted text-primary',

        /**
         * `PostStatus.DRAFT` - authored but not public, and the state every post
         * is created in. Cautionary rather than quiet: a draft is unfinished
         * business its author is expected to act on, and it is the state that
         * explains why a post is missing from the feed.
         *
         * `warning` is the token globals.css names for exactly this state ("an
         * unpublished draft"), and it exists precisely so a cautionary state is
         * not spelled with `accent` - which would collide with emphasis - or
         * with `danger` - which would make "not finished" and "destructive" the
         * same colour. Measured 4.61:1 light and 8.54:1 dark.
         */
        draft: 'border-warning bg-surface-muted text-warning',

        /**
         * `PostStatus.PUBLISHED` - public, listed, filterable and crawlable.
         * `success` is the token globals.css designates for the affirmative
         * states in this file. The tightest pair in the whole table at 4.51:1
         * light (8.26:1 dark), which is why the ground here stays
         * `surface-muted` rather than becoming a tint: mixing the token toward
         * transparent moves it toward the page canvas, and that canvas is
         * lighter in light mode and darker in dark, so a tint would read as more
         * emphasis in one theme and less in the other.
         */
        published: 'border-success bg-surface-muted text-success',

        /**
         * `PostStatus.ARCHIVED` - withdrawn from the public surface after having
         * been published, without being deleted.
         *
         * Quiet on purpose, and the one status that is NOT chromatic. Archiving
         * is neither a failure nor an outstanding task: `danger` would overstate
         * a deliberate, reversible withdrawal, and `warning` would ask the
         * reader to act on something already decided. `muted-foreground` is the
         * secondary-text token, still at 6.90:1 light and 5.58:1 dark, so the
         * pill reads as receded rather than faint - and the three post states
         * stay mutually distinguishable in an admin table listing all of them.
         */
        archived: 'border-border bg-surface-muted text-muted-foreground',

        /**
         * `CommentStatus.PENDING` - submitted, invisible in the public thread,
         * and waiting in the moderation queue. Cautionary for the same reason
         * `draft` is: it is work still to be done. globals.css names "a comment
         * held for moderation" among the states `warning` backs.
         */
        pending: 'border-warning bg-surface-muted text-warning',

        /**
         * `CommentStatus.APPROVED` - moderated and public, and the only comment
         * state a public caller ever sees. Affirmative, so it shares
         * `published`'s tone.
         */
        approved: 'border-success bg-surface-muted text-success',

        /**
         * `CommentStatus.REJECTED` - moderated and refused. The one genuinely
         * negative state either domain has, and the only one that earns
         * `danger`: a decision was taken against this record, which is different
         * from `pending`'s "not yet decided" and from `archived`'s "withdrawn
         * without prejudice". Measured 5.86:1 light and 5.07:1 dark. Still
         * reversible - an administrator can move it back - which is why the pill
         * is toned rather than filled.
         */
        rejected: 'border-danger bg-surface-muted text-danger',
      },
    },
    defaultVariants: {
      // `neutral` rather than a status, so `<Badge>` with no variant cannot
      // accidentally assert a lifecycle state it was never given.
      variant: 'neutral',
    },
  },
);

/**
 * The variant names {@link badgeVariants} accepts, with `null` and `undefined`
 * removed.
 *
 * Exported so the two lookup tables below - and any consumer that stores a
 * variant, such as an admin filter's column configuration - can name the union
 * without restating eight literals that would then be free to drift from the
 * table.
 */
export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

/**
 * Every {@link PostStatus} wire literal, mapped to the variant that renders it.
 *
 * The reason this is a table and not a `switch` in each consumer: `Record` over
 * the union is exhaustive at COMPILE time, so if the service ever adds a fourth
 * lifecycle state, `PostStatus` widens and this object fails to type-check until
 * the new state has been given a tone. A conditional would instead fall through
 * to whichever branch it happened to end on and render the wrong pill, silently,
 * in the feed and in the admin table at once.
 *
 * Keys are the literals exactly as they travel on the wire - uppercase, no
 * camelCase layer anywhere in this tier - so a consumer indexes with the value
 * it was handed rather than transforming it first.
 *
 * The LABEL is deliberately not here. A pill's text is the caller's to write,
 * because the same state is worded differently in different places ("Draft" on a
 * dashboard row, "Not published" in a confirmation) and a single table could not
 * serve both without becoming a translation layer this project does not have.
 *
 * @example A dashboard row, in a Server Component
 * ```tsx
 * <Badge variant={POST_STATUS_BADGE_VARIANTS[post.status]}>{postStatusLabel}</Badge>
 * ```
 */
export const POST_STATUS_BADGE_VARIANTS: Readonly<Record<PostStatus, BadgeVariant>> = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  ARCHIVED: 'archived',
};

/**
 * Every {@link CommentStatus} wire literal, mapped to the variant that renders
 * it. Exhaustive over the union for the same reason
 * {@link POST_STATUS_BADGE_VARIANTS} is, and carries no label for the same
 * reason.
 *
 * Only the administrative moderation queue renders all three: the public thread
 * shows approved comments alone, because the service filters on that state
 * rather than trusting the client to.
 *
 * @example A row in the moderation queue
 * ```tsx
 * <Badge variant={COMMENT_STATUS_BADGE_VARIANTS[comment.status]}>{moderationLabel}</Badge>
 * ```
 */
export const COMMENT_STATUS_BADGE_VARIANTS: Readonly<Record<CommentStatus, BadgeVariant>> = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

/**
 * Props accepted by {@link Badge}.
 *
 * Not exported, to keep this module's documented surface to the symbols above.
 * A caller that needs the type derives it, which also keeps it correct if the
 * variant union ever widens:
 *
 * ```ts
 * type MyProps = ComponentProps<typeof Badge>;
 * ```
 */
type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

/**
 * A small pill labelling a category or a domain state.
 *
 * Renders exactly one `<span>` and nothing else. It is not interactive and has
 * no interactive state: no hover step, no focus ring, no `tabIndex` and no click
 * handling, because a span that reacts to a pointer is a control no keyboard can
 * reach. A category chip that navigates is {@link BadgeLink} below - the same
 * pill on a real anchor - and a chip that performs an action is a `Button` with
 * `asChild`; reach for one of those instead of adding a handler here.
 *
 * **The children are the message.** Tone reinforces the state; it never carries
 * it. Pass text that says what the state is, and the pill remains unambiguous to
 * a visitor who cannot distinguish these colours. Nothing is hidden from
 * assistive technology, so whatever is passed is announced as written.
 *
 * Map a wire literal to a variant with {@link POST_STATUS_BADGE_VARIANTS} or
 * {@link COMMENT_STATUS_BADGE_VARIANTS} rather than choosing a tone at the call
 * site.
 *
 * Accepts every `<span>` attribute, `ref` included - React 19 delivers it as an
 * ordinary prop, so it arrives through the spread and lands on the element.
 *
 * @param variant - The domain state to render. Defaults to `neutral`.
 * @param className - Merged through `cn()`, so a caller's utility overrides the
 *   variant's within the same property group: `className="bg-surface"` replaces
 *   the ground and leaves the tone and shape intact.
 * @param props - Every other `span` attribute, including `ref` and `children`,
 *   spread onto the element last so a caller can override any attribute.
 * @returns The rendered pill.
 *
 * @example A post's lifecycle state on a dashboard row
 * ```tsx
 * <Badge variant={POST_STATUS_BADGE_VARIANTS[post.status]}>Draft</Badge>
 * ```
 *
 * @example A category chip with a leading glyph, in a Server Component
 * ```tsx
 * <Badge variant="category">
 *   <TagIcon aria-hidden="true" />
 *   {category.name}
 * </Badge>
 * ```
 *
 * @example A neutral chip for a value with no state semantics
 * ```tsx
 * <Badge>{user.role}</Badge>
 * ```
 */
export function Badge({ variant, className, ...props }: BadgeProps): JSX.Element {
  // `className` is destructured out above, so the spread cannot clobber the
  // composed string; every other attribute a caller passes still wins, which is
  // what lets a consumer add `title`, `id` or a data attribute without this
  // primitive having to enumerate them.
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/* -------------------------------------------------------------------------- */
/* BadgeLink                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The navigating chip's complete appearance and interaction, composed once at
 * module scope so the string is not rebuilt per render and cannot be assembled
 * differently by a second call site.
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
 *     Wrapping is the right answer HERE even though the shared base above chose
 *     `nowrap`, and the two are not in conflict: the base's reason is that a
 *     two-word lifecycle state ("Pending review") broken across lines reads as
 *     two pills - a real risk for a closed set of short, product-authored labels.
 *     A category name is neither closed nor short: it is administrator-authored
 *     free text with an 80-code-point ceiling, so the label this chip carries is
 *     the one case the base's assumption does not cover.
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
 * {@link Badge}. Not exported, for the reason {@link BadgeProps} is not: this
 * module's documented surface is its two components and its three tables. A
 * caller that needs the shape derives it, which also keeps it correct if a prop
 * is ever added:
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
 * For a chip that does NOT navigate, use {@link Badge} above - it is the same
 * pill without any interactive state. For an authored link inside a body of
 * prose, use a plain anchor: this component is for hrefs this tier builds.
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
