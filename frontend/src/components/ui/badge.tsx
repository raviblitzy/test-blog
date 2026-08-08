// Badge - the design system's category and status pill.
//
// One of the fifteen primitives under src/components/ui/ that together ARE this
// project's design system: feature code consumes this layer and never reaches
// past it. Radix publishes no badge, so this is one of the nine primitives
// authored directly over a plain element - here a `<span>`, because a pill is a
// run of text with a shape, not a control.
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
// this 12px size - the tightest is `published`/`approved` at 4.51:1 in light. So
// there is no BLITZY [A11Y] deferral in this file: nothing here is implemented
// below a threshold.
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
// The pill is NOT interactive and must not become so. No `role`, no `tabIndex`,
// no `onClick`, no focus ring, no hover step - a badge that responds to a click
// while announcing itself as a span is a control a keyboard cannot reach. A
// clickable category chip is a `Button` with `asChild` wrapping a `Link`, or a
// bare `Link`; both of those already exist and both are focusable.
//
// ---------------------------------------------------------------------------
// 3. FOUR THINGS THIS FILE DELIBERATELY OMITS
//
//   1. `'use client'`. There is no hook, no state, no browser API and no event
//      handler here, so the module stays shared - and that is load-bearing. The
//      surfaces that render the most badges are Server Components: the
//      server-rendered feed cards, the post detail page's category row and the
//      author profile. The directive would pull this module and its callers into
//      the client bundle to paint a static span, and it would take the initial
//      HTML those pages need for SEO with it.
//   2. `forwardRef`. React 19 hands `ref` to a function component as an ordinary
//      prop, so it arrives inside `...props` and lands on the span like any
//      other attribute. Wrapping would buy a display-name obligation and change
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

import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, JSX } from 'react';

import type { CommentStatus, PostStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * The pill's appearance, as a `class-variance-authority` table.
 *
 * Exported because the sibling `blog` and `admin` component folders sometimes
 * need this exact appearance on an element that is not a `<span>` - a category
 * chip that navigates is a `<Link>`, and a chip inside a Radix select option is
 * part of that option's own markup. Those call sites spell
 * `className={badgeVariants({ variant: 'category' })}` rather than nesting a
 * `Badge` inside another element or, worse, restating the class list. Reach for
 * {@link Badge} for the ordinary case; reach for this only when the element has
 * to be something else.
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
 * reach. A category chip that navigates is a `Link`, or a `Button` with
 * `asChild` wrapping one - reach for those instead of adding a handler here.
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
