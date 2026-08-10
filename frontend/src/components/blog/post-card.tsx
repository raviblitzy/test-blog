// Post card - one post as the home feed, the author profile and the dashboard render it.
//
// This is the unit the feed is made of. `src/components/blog/post-list.tsx` places N of these in a
// grid, `src/app/page.tsx` server-renders that grid, and `src/app/u/[username]/page.tsx` reuses the
// same component for an author's published posts - so a change here is one edit rather than three,
// and every surface that lists posts stays visually identical by construction.
//
// It consumes `PostSummary`, the LIST projection, and everything about this file follows from that
// one fact. See note 1.
//
// ---------------------------------------------------------------------------
// 1. WHY THERE IS NO BODY TEXT AND NO READING TIME HERE
//
// `PostSummary` carries no `content` field, deliberately: `@/lib/types` records that a feed page
// returns up to a hundred of these and that including the Markdown body would multiply every
// home-feed, profile and dashboard response by the size of the articles in it. The type is the
// enforcement - `post.content` does not compile - and this component is the reason the type is
// shaped that way.
//
// So `ReadingTime` is NOT composed here, and that is not an omission. `@/lib/format` documents the
// asymmetry explicitly: an estimate derived from an excerpt is not a reading time, it is a reading
// time for the excerpt, and publishing it beside a post would be a wrong number rather than a
// missing one. Reading time belongs to the post-detail page, which has the body to measure.
//
// ---------------------------------------------------------------------------
// 2. NO `'use client'` - AND THAT IS THE MOST CONSEQUENTIAL LINE IN THE FILE
//
// There is no state, no effect, no hook, no event handler and no browser API below, so the module
// stays shared and renders on the server. That is what puts every card's title, link, excerpt,
// byline and category chips into the INITIAL HTML response, which is the whole basis of the SEO
// requirement: a crawler has to see the feed without executing client JavaScript.
//
// The card therefore has no interactivity of its own. The pieces that genuinely need the client -
// the search input, the category filter, the like button, the comment form, the theme toggle - are
// separate islands mounted elsewhere on the page. Adding a directive here to make one of them
// convenient would pull the entire feed behind hydration.
//
// ---------------------------------------------------------------------------
// 3. THE TITLE IS THE ONLY LINK IN THE CARD BODY, AND THE CARD IS NEVER AN ANCHOR
//
// `ui/card.tsx` states the rule and the reason: a card contains a title link, a byline link and
// category chips, so wrapping the whole thing in an anchor is invalid HTML, breaks keyboard
// navigation and hands a screen reader one enormous unusable accessible name. The title link is the
// primary target; `AuthorByline` owns a second link to `/u/{username}`; each category chip is a
// third. None of them nests inside another.
//
// There is no "Read more" affordance either. It would be a second link to the same destination -
// which a screen-reader user hears twice per card - and its accessible name would have to carry the
// post title anyway to be descriptive, at which point it says nothing the title link did not.
//
// ---------------------------------------------------------------------------
// 4. WHAT THIS FILE DELIBERATELY DOES NOT DO. Please do not add.
//
//   1. A width, a max-width or a column count. `post-list.tsx` owns the grid - one column below
//      48rem, two at 48rem, three at 64rem - and the card is width-agnostic so it fits whichever
//      track it lands in. A width here would fight that grid at exactly one viewport.
//   2. A `dark:` variant. Every colour resolves to a semantic token that `src/app/globals.css`
//      declares twice, once at the document root and once under `.dark`, so the card re-themes with
//      no conditional. A `dark:` class would be a second source of truth for a value this file must
//      not own.
//   3. A literal colour, length, radius, shadow or font size, a `style` prop, a stylesheet, a CSS
//      module or a media query. Every value below is a token-backed utility, and the engine's five
//      breakpoints are the entire responsive vocabulary.
//   4. A raw `<button>`, `<input>`, `<textarea>`, `<select>` or `<table>`. Those live only in
//      `src/components/ui/`. A raw `<img>` is excluded too - `@next/next/no-img-element` is active
//      under `--max-warnings=0`, and the cover has a host allow-list to respect. See note 5.
//   5. An `<h1>`. The page owns its single top-level heading; this card renders `h2` by default and
//      accepts `h3`/`h4` so a section that already spent an `h2` can keep the outline ordered.
//   6. An HTTP call. `src/lib/api/client.ts` is this tier's only HTTP module and the data arrives as
//      a prop, already fetched by the route that renders the list.
//   7. A `message`/`data` envelope, an `/items` path or an `Item` shape. The legacy demonstration
//      surface those came from is retired; `post.id` is a real UUID on a real blog entity.
//   8. An upload control. `cover_image_url` is a URL reference - this product has no upload,
//      image-processing or object-storage pipeline at all.
//   9. A view tally, or any other reading of `post.view_count`. The field is on the wire and the
//      card deliberately ignores it: NO endpoint in this product increments it. `posts.view_count`
//      is a column nothing measures - `backend/app/models/post.py` says so in as many words, and
//      `backend/app/schemas/post.py` gives the same fact as the reason `PostSortOption` offers no
//      "popular" value - so the only values it can ever hold are the zero the column defaults to
//      and whatever the demonstration seeder wrote. Rendering either beside a title states an
//      audience figure that no read produced, which is worse than showing none: a reader cannot
//      tell an unmeasured number from a measured one. If reads are ever counted, the counter path
//      lands in the service first and this card follows it - not the other way round.
//
// ---------------------------------------------------------------------------
// 5. THE COVER IMAGE IS THE ONE PLACE THIS COMPONENT CAN FAIL AT RUNTIME
//
// `next/image` throws when handed a host absent from `next.config.ts`'s `images.remotePatterns`, and
// the service accepts ANY absolute http(s) URL for `cover_image_url` (`pydantic.HttpUrl`) - so a
// stored record can legitimately name a host this tier will not fetch from. That gap is real, and
// `@/lib/utils` exists to close it: `allowedImageUrl` is the single predicate every image-rendering
// component asks first, and `next.config.ts` DERIVES its `remotePatterns` from the very same list.
// One source of truth, so the optimiser's answer and this component's answer cannot disagree.
//
// The predicate is total - `null`, an empty string, a relative path, an unparseable string, plain
// `http`, an embedded credential and an unlisted host all answer "no" without throwing - which is
// why there is no `try`/`catch` here. Writing one would be dead code, and inventing a host list here
// would be the second copy the derivation exists to prevent.
//
// When the answer is no, the card renders no image element and no reserved box: it degrades to a
// text-only card rather than to a card with a hole in it.

import Image from 'next/image';
import Link from 'next/link';
import type { ComponentProps, JSX } from 'react';

import { AuthorByline } from '@/components/blog/author-byline';
import { Badge, BadgeLink, POST_STATUS_BADGE_VARIANTS } from '@/components/ui/badge';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { categoryFeedPath, postPath } from '@/lib/seo';
import type { PostStatus, PostSummary } from '@/lib/types';
import { allowedImageUrl, cn } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Heading level
 * ---------------------------------------------------------------------------------------------- */

/**
 * Heading levels a card may render its title at.
 *
 * `1` is excluded, and the exclusion is the point: a page has exactly one `<h1>` and spends it on
 * the route heading, so a card in a list can never be one. `5` and `6` are excluded because
 * `CardTitle` does not accept them - a card title nested that deep means the surrounding outline has
 * gone wrong, and the constraint surfaces that at compile time rather than in an audit.
 */
type PostCardHeadingLevel = 2 | 3 | 4;

/**
 * The heading tags those levels map to, derived from `CardTitle`'s own prop rather than restated.
 *
 * This is the composition guidance `ui/card.tsx` documents for wrappers: if that primitive ever
 * narrows the levels it accepts, this file fails to compile instead of quietly passing a tag the
 * primitive no longer supports.
 */
type PostCardHeadingTag = Exclude<NonNullable<ComponentProps<typeof CardTitle>['as']>, 'h1'>;

/**
 * `h2`, because the surfaces that render a feed of cards - the home page, an author profile, the
 * author dashboard - all spend their `h1` on the page heading, so the cards beneath it are the
 * second level. A section that has already introduced an `h2` of its own passes `3` instead.
 */
const DEFAULT_HEADING_LEVEL: PostCardHeadingLevel = 2;

/**
 * Level-to-tag lookup.
 *
 * A `Record` over the closed union, so adding a level to {@link PostCardHeadingLevel} fails to
 * compile until it has been given a tag here. Indexing it with a `PostCardHeadingLevel` yields a tag
 * rather than `tag | undefined` - these are declared properties, not an index signature, so
 * `noUncheckedIndexedAccess` has nothing to widen.
 */
const HEADING_TAG_BY_LEVEL: Readonly<Record<PostCardHeadingLevel, PostCardHeadingTag>> = {
  2: 'h2',
  3: 'h3',
  4: 'h4',
};

/* -------------------------------------------------------------------------------------------------
 * Lifecycle pill
 * ---------------------------------------------------------------------------------------------- */

/**
 * The lifecycle state a card does NOT label.
 *
 * Every post in a public listing is published, so a "Published" pill on the home feed would be
 * noise on every card without ever distinguishing one from another. The pill is therefore rendered
 * only for the states that are genuinely exceptional in the surface that shows them - a draft or an
 * archived post in the author dashboard or an administrative table.
 *
 * Gated on the value rather than on a `showStatus` prop, so a dashboard cannot forget to switch it
 * on and a public feed cannot switch it on by mistake.
 */
const UNLABELLED_STATUS: PostStatus = 'PUBLISHED';

/**
 * The visible text of the lifecycle pill.
 *
 * `ui/badge.tsx` maps a wire literal to a TONE and deliberately carries no label, because the same
 * state is worded differently in different places. This is this surface's wording, declared once.
 *
 * The pill's meaning is carried by this text and not by its colour, which is what keeps it readable
 * for a visitor who cannot distinguish the tones - so the entry is a word, never an icon or a dot.
 *
 * Exhaustive over `PostStatus` even though `PUBLISHED` is never rendered: a `Record` over the union
 * fails to compile if the service adds a fourth lifecycle state, which is exactly the moment someone
 * needs to decide what this surface calls it.
 */
const POST_STATUS_LABELS: Readonly<Record<PostStatus, string>> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
};

/* -------------------------------------------------------------------------------------------------
 * Class recipes
 *
 * Module-scope constants rather than inline strings, so each group can carry the note explaining why
 * it is there and the JSX below stays readable. Every value is a token-backed utility; there is not
 * one literal colour, length, radius, shadow or font size in this file.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The cover image's frame.
 *
 * Five utilities, each load-bearing:
 *
 *   * `relative` - `next/image` with `fill` positions itself absolutely, so it needs a positioned
 *     ancestor. Without this the image escapes the card entirely.
 *   * `aspect-video` - the engine's own token-backed ratio utility, compiling to
 *     `aspect-ratio: var(--aspect-video)`. This is what RESERVES the space before the image loads,
 *     so the card does not jump when it arrives. An arbitrary `aspect-[16/9]` would be the
 *     hardcoded value the token discipline forbids, and a fixed height would break the fluid grid.
 *   * `w-full` - fills the track the grid gave the card, which is what gives `aspect-ratio` a
 *     definite width to derive its height from. This is not a width the card chose; it is the
 *     absence of one.
 *   * `overflow-hidden` - `object-cover` crops by overflowing, so without this the excess bleeds
 *     past the rounded corners below.
 *   * `bg-surface-muted` - visible only while the image is in flight, or permanently if the host
 *     serves an error. A recessed panel reads as intentional; a transparent hole reads as broken.
 *
 * The corners are the LOGICAL start-start and start-end pair rather than physical `rounded-t-*`, so
 * they follow the writing mode, and they match the `--radius-xl` the `Card` root uses - anything
 * else leaves a hairline of card surface peeking around the image.
 */
const COVER_FRAME_CLASSES = cn(
  'relative aspect-video w-full overflow-hidden',
  'rounded-ss-xl rounded-se-xl',
  'bg-surface-muted',
);

/**
 * The cover image itself: crop to fill the frame rather than distort to fit it.
 *
 * `next/image` supplies its own `position`, `inset` and dimensions inline for `fill`; this is the
 * only appearance decision left, and it belongs to the consumer because only the consumer knows the
 * frame is a fixed ratio.
 */
const COVER_IMAGE_CLASSES = 'object-cover';

/**
 * The layout hint the browser uses to pick a source from the generated `srcset`, mirroring the grid
 * `post-list.tsx` owns: three columns from 64rem, two from 48rem, one below that.
 *
 * These literals are deliberate and are not a token violation. `sizes` is an HTML attribute whose
 * media conditions are evaluated by the image-selection algorithm BEFORE any stylesheet applies, so
 * it cannot reference a CSS custom property - there is no token-based spelling of this value. The two
 * widths are the engine's own `md` and `lg` breakpoints, in the same `rem` units the generated media
 * queries use, so the hint and the layout switch at exactly the same points.
 *
 * Getting this wrong is not cosmetic: omit it and the browser assumes `100vw` and downloads a
 * full-width image for a third-width slot, which is a Core Web Vitals regression the lint gate flags.
 */
const COVER_SIZES = '(min-width: 64rem) 33vw, (min-width: 48rem) 50vw, 100vw';

/**
 * The title link.
 *
 * The repository's text-link recipe, restated here with a note per group rather than imported, so
 * this file explains its own affordances:
 *
 *   * `rounded-sm` keeps the focus outline hugging the text instead of tracing a hard rectangle.
 *   * `hover:` is gated by the engine behind `@media (hover: hover)`, so a touch device never leaves
 *     the state stuck on after a tap. The underline travels with the colour change, so the
 *     affordance is never carried by colour alone.
 *   * `focus-visible:`, never `:focus`, so the ring appears for keyboard and assistive-technology
 *     users and not on every mouse click. `globals.css` already sets a document-wide floor at this
 *     width, colour and offset; restating it keeps the card correct if that floor is ever narrowed,
 *     and lands on the same values so nothing changes thickness today. The outline is never
 *     suppressed first - there is no state here without a visible indicator.
 *   * `motion-safe:` runs the colour transition only for visitors who have not asked for less motion.
 *
 * No `line-clamp` here, and that is considered rather than forgotten. `CardTitle` applies
 * `text-balance` to distribute a wrapped title evenly, which is precisely the feed-card case;
 * `line-clamp-*` sets `display: -webkit-box`, which would silently defeat it. A long title instead
 * wraps and breaks, because the `Card` root sets `wrap-break-word` and every child inherits it -
 * `globals.css` applies `overflow-wrap` to flow containers only, never to headings, so the root's
 * class is what covers this one.
 */
const TITLE_LINK_CLASSES = cn(
  'rounded-sm',
  'hover:text-primary hover:underline',
  'focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',
  'motion-safe:transition-colors motion-safe:ease-out',
);

/**
 * The excerpt: secondary text, capped at three lines.
 *
 * `text-muted-foreground` is the secondary-text token, so the excerpt recedes behind the title
 * without becoming faint. `line-clamp-3` caps the visual height so a grid row of cards stays even
 * whatever length the authors wrote - the text remains in the DOM and in the accessible tree, so
 * nothing is withheld from a crawler or a screen reader, and the full copy is one click away on the
 * post page.
 */
const EXCERPT_CLASSES = 'text-muted-foreground line-clamp-3 text-sm';

/* -------------------------------------------------------------------------------------------------
 * PostCard
 * ---------------------------------------------------------------------------------------------- */

/**
 * Props for {@link PostCard}.
 */
interface PostCardProps {
  /**
   * The post to render, as the API's LIST projection.
   *
   * `PostSummary` and nothing wider. `PostDetail` extends it, so a detail payload is accepted
   * unchanged and its extra fields are simply unused - which is the right relationship, because a
   * card must never depend on a field the feed does not send.
   *
   * Every nullable member is a real, expected value rather than an error case: `excerpt` is `null`
   * when the author wrote none, `cover_image_url` when the post has no cover, and `published_at`
   * whenever the post has never been published. Each is handled by omitting the affordance.
   */
  post: PostSummary;
  /**
   * Heading level for the title. Defaults to `2`.
   *
   * The consuming page owns its outline: a feed directly under the page's `<h1>` leaves this alone,
   * while a section that has already introduced an `<h2>` of its own passes `3` so no level is
   * skipped. There is no level `1` - see {@link PostCardHeadingLevel}.
   */
  headingLevel?: PostCardHeadingLevel;
  /**
   * Whether the cover image should load eagerly at high priority. Defaults to `false`.
   *
   * Opt in for the first card of the first page only, where the cover is the largest element above
   * the fold and is therefore the page's Largest Contentful Paint candidate. Setting it on every
   * card is actively harmful: it makes the browser contend for bandwidth on images nobody has
   * scrolled to yet, and `next/image` warns while the Core Web Vitals lint rules object.
   *
   * With `false`, `next/image` lazy-loads and decodes asynchronously on its own.
   */
  priority?: boolean;
  /**
   * Extra utilities for the card root, merged last so they win their Tailwind group.
   *
   * The seam for a consuming layout's own concerns. Note that a width or a max-width here fights
   * the grid: `post-list.tsx` owns the one/two/three-column layout and sizes the track.
   */
  className?: string;
}

/**
 * One post, as a self-contained card.
 *
 * Renders an `<article>` - a post card is independently distributable, which is exactly what that
 * element means - containing an optional cover image, the title as the card's heading and only
 * link into the post, the author byline, the excerpt, the lifecycle pill when it is not published
 * and its category chips. It renders no readership figure; note 9 in the module header records why.
 *
 * ### What a screen reader hears
 *
 * The heading and its link named exactly by the post title; then the byline as
 * `"{author}, link"` followed by the publication date; then the excerpt; then the lifecycle pill's
 * word if there is one, and each category as a link named by the category. The cover image
 * contributes nothing - it is decorative and explicitly hidden.
 *
 * ### What it renders in the initial HTML
 *
 * All of it. This module declares no client directive, so on a Server Component page the whole card
 * is in the HTML a crawler receives without running any JavaScript.
 *
 * ### Layout is the caller's
 *
 * The root sets no width, no max-width, no column count and no breakpoint variant, so it fits
 * whichever grid track it is placed in and reflows by wrapping at every viewport.
 *
 * That extends to ROW ALIGNMENT, which is worth stating because it is visible. A CSS grid stretches
 * its items to the tallest in the row by default, so a card with less content than its row-mates
 * gains trailing space inside its box - measured at 1280 in a three-column grid, up to ~300px on the
 * sparsest card. Nothing here is going to change: the slots and their insets are byte-identical at
 * every width, and the surplus is the card BOX being stretched, not a slot rendering empty.
 *
 * The lever belongs to the grid owner, `post-list.tsx`, which has exactly two and can pick either:
 * `items-start` on the grid gives content-height cards with uneven bottom edges, or `mt-auto` on
 * this card's last slot pins footers to a common baseline. Neither is baked in here, and that is
 * deliberate rather than an omission - a card is rendered by the feed, by an author profile, by the
 * dashboard and by a related-posts strip, and hard-coding one row aesthetic would impose it on all
 * four with no way to opt out from the outside.
 *
 * @param props - See {@link PostCardProps}.
 * @returns The rendered card. Never `null` - there is always a title to show.
 * @throws If `post.slug` is blank, or if `post.author.username` is blank. `@/lib/seo` refuses to
 * build a path from an empty segment because the service generates both and constrains them
 * `UNIQUE`, so a blank one means the payload is not the record the caller believed it had. A link to
 * `/blog/` is a wrong destination that looks right; the route error boundary is the correct place
 * for that, and `src/app/error.tsx` is it.
 *
 * @example The home feed, whose page heading is the `h1`
 * ```tsx
 * {page.items.map((post, index) => (
 *   <PostCard key={post.id} post={post} priority={index === 0} />
 * ))}
 * ```
 *
 * @example Inside a section that has already spent an `h2` on its own title
 * ```tsx
 * <section>
 *   <h2>Most recent</h2>
 *   {posts.map((post) => (
 *     <PostCard key={post.id} headingLevel={3} post={post} />
 *   ))}
 * </section>
 * ```
 */
export function PostCard({
  post,
  headingLevel = DEFAULT_HEADING_LEVEL,
  priority = false,
  className,
}: PostCardProps): JSX.Element {
  // Resolved once, above the JSX, so each guard below is a plain boolean and the markup reads as
  // structure rather than as a chain of conditions.

  // `undefined` when the post has no cover, or when the stored host is one this tier will not fetch
  // from - see note 5 in the module header. The predicate is total, so this needs no guard.
  const coverImageUrl = allowedImageUrl(post.cover_image_url);

  // A blankness guard, not a null guard: `excerpt` is typed `string | null`, and `string` still
  // admits `''` and `'   '`. Either would render an empty paragraph that adds a line of padding to
  // this card and to no other, so the slot is omitted rather than rendered empty.
  const hasExcerpt = post.excerpt !== null && post.excerpt.trim().length > 0;

  const showStatus = post.status !== UNLABELLED_STATUS;
  const hasCategories = post.categories.length > 0;

  // The footer is omitted entirely when it would be empty, rather than rendered as a blank band of
  // padding at the bottom of the card. The slot above it already pays its own bottom inset, so the
  // card closes cleanly either way. `post.view_count` is deliberately not a third condition here -
  // see note 9 in the module header.
  const hasFooter = showStatus || hasCategories;

  return (
    // `article`, not the default `div`: one card is one self-contained, independently distributable
    // item. The element is the primitive's `as` prop rather than a wrapper around it, so the card's
    // own surface, border, radius and shadow land on the semantic element itself.
    <Card as="article" className={className}>
      {coverImageUrl === undefined ? null : (
        <div className={COVER_FRAME_CLASSES}>
          {/*
           * `alt=""` - decorative, and deliberately not the post title.
           *
           * The title sits immediately below inside the very same card, as the heading and as the
           * link's accessible name. Repeating it here would make a screen reader announce the same
           * words twice per card, once as an image and once as the heading, which is exactly the
           * defect `author-byline.tsx` documents for its avatar fallback. `PostSummary` carries no
           * caption or image description either, so there is no alternative text available that
           * would add anything the title does not already say.
           *
           * The image is therefore not a link. Making it one would need a non-empty `alt` to have
           * any accessible name at all, which reintroduces the duplication - and would put a second
           * link to the same destination in every card.
           */}
          <Image
            alt=""
            className={COVER_IMAGE_CLASSES}
            fill
            priority={priority}
            sizes={COVER_SIZES}
            src={coverImageUrl}
          />
        </div>
      )}

      <CardHeader>
        <CardTitle as={HEADING_TAG_BY_LEVEL[headingLevel]}>
          {/*
           * The link lives INSIDE the heading, which is what gives it an accessible name of exactly
           * the post title and leaves the rest of the card free of it. The href is the RELATIVE
           * route path from `@/lib/seo`: an absolute URL on a `next/link` is treated as an external
           * destination, which bypasses the router and loses the prefetch, the shared layout and
           * the scroll position. Hand-building `/blog/${slug}` is excluded for a different reason -
           * `@/lib/seo` owns the `/blog` prefix and the segment encoding, and is the module the
           * canonical tag and the sitemap read from too.
           */}
          <Link className={TITLE_LINK_CLASSES} href={postPath(post.slug)}>
            {post.title}
          </Link>
        </CardTitle>

        {/*
         * The byline owns the avatar, the link to `/u/{username}` and the `<time dateTime>` element,
         * so none of that is duplicated here. `size="sm"` is the scale its own documentation names
         * for a dense surface such as a feed card. `published_at` is passed straight through: it is
         * `null` for a draft, and the byline responds by rendering no date at all rather than
         * substituting the authoring instant.
         */}
        <AuthorByline author={post.author} publishedAt={post.published_at} size="sm" />
      </CardHeader>

      {hasExcerpt ? (
        <CardContent>
          <p className={EXCERPT_CLASSES}>{post.excerpt}</p>
        </CardContent>
      ) : null}

      {hasFooter ? (
        <CardFooter>
          {showStatus ? (
            // Not interactive, so this one really is a `Badge`. The tone comes from the primitive's
            // own exhaustive table rather than from a decision taken here, and the visible word is
            // what carries the meaning.
            <Badge variant={POST_STATUS_BADGE_VARIANTS[post.status]}>
              {POST_STATUS_LABELS[post.status]}
            </Badge>
          ) : null}

          {/*
           * Each chip is a crawlable link to the category-filtered feed. A category has no route of
           * its own - its page IS the filtered feed - so the href comes from `categoryFeedPath`,
           * which is the same builder the filter control and the sitemap use. Keyed by `id`, the
           * server-generated identifier, rather than by an array index or by the slug.
           *
           * `BadgeLink` is the design system's pill-shaped link, and reaching for it here rather than
           * composing `badgeVariants` into a local class list is what makes this footer and the post
           * page's own category row the SAME affordance. The three things this file used to decide for
           * itself now belong to that primitive and are decided once: an over-long category name wraps
           * inside the pill instead of being clipped without an ellipsis, the interactive target meets
           * WCAG 2.5.8's 24px minimum instead of sitting 2px under it, and the hover step is the same
           * colour-plus-underline pair on both surfaces.
           */}
          {post.categories.map((category) => (
            <BadgeLink href={categoryFeedPath(category)} key={category.id}>
              {category.name}
            </BadgeLink>
          ))}
        </CardFooter>
      ) : null}
    </Card>
  );
}

/* -------------------------------------------------------------------------------------------------
 * PostCardSkeleton
 *
 * The loading stand-in for a {@link PostCard}. `ui/skeleton.tsx` names this file's skeleton state as
 * one of its consumers, and `post-list.tsx` renders a run of these while a page of posts is in
 * flight.
 *
 * GEOMETRIC PARITY IS THE ENTIRE POINT, so every block below is sized against the real card's own
 * type scale rather than eyeballed. Swapping a placeholder for real content must not move anything:
 *
 *   cover        the same `aspect-video` frame, so its reserved height is identical by construction
 *   title        two `h-5` bars with `gap-2` = 3rem, against a two-line `text-lg`/`leading-snug`
 *                heading at 2 x 1.547rem = 3.09rem
 *   byline       a `size-6` disc beside an `h-4` bar, which is the `sm` byline's own avatar diameter
 *                and `text-xs` line box - the disc sets the row height in both
 *   excerpt      three `h-4` bars with `gap-1.5` = 3.75rem, against three `text-sm` lines at
 *                3 x 1.25rem = 3.75rem exactly, which is the height `line-clamp-3` caps the real
 *                excerpt at
 *   footer       two `h-6` chips, against the 1.5rem interactive minimum `ui/badge.tsx`
 *                sets for a category chip (`min-h-6`), which is what makes the real footer row 24px
 *                tall whether or not the lifecycle badge is rendered beside it - that badge is
 *                1.375rem and shorter, so the chips govern the height - and nothing else, because
 *                the real footer holds only a lifecycle pill and category chips
 *
 * The tiny gaps between bars are deliberate rather than parity error: with none, adjacent
 * placeholders merge into one block and stop reading as lines of text. Each gap is a `--spacing`
 * multiple and each is paid for by a correspondingly shorter bar.
 * ---------------------------------------------------------------------------------------------- */

/** The cover placeholder: fills the frame, and drops the primitive's own radius so the frame clips. */
const SKELETON_COVER_CLASSES = 'size-full rounded-none';

/** The title block: two lines, the second short, the way a wrapped headline actually falls. */
const SKELETON_TITLE_BLOCK_CLASSES = 'flex flex-col gap-2';
const SKELETON_TITLE_LINE_CLASSES = 'h-5';
const SKELETON_TITLE_LAST_LINE_CLASSES = 'h-5 w-3/5';

/** The byline row: the `sm` byline's avatar diameter and gap, so the row height matches. */
const SKELETON_BYLINE_ROW_CLASSES = 'flex items-center gap-1.5';
const SKELETON_AVATAR_CLASSES = 'size-6 shrink-0 rounded-full';
const SKELETON_BYLINE_TEXT_CLASSES = 'h-4 w-32';

/** The excerpt block: three lines at `text-sm`'s line box, the last one short. */
const SKELETON_EXCERPT_BLOCK_CLASSES = 'flex flex-col gap-1.5';
const SKELETON_EXCERPT_LINE_CLASSES = 'h-4';
const SKELETON_EXCERPT_LAST_LINE_CLASSES = 'h-4 w-4/5';

/**
 * Two category chips, mirroring the footer's wrapping row.
 *
 * `h-6` is the real chip's own `min-h-6`, which `BadgeLink` in `ui/badge.tsx` sets, so the
 * placeholder row and the loaded row are the same height to the pixel and nothing below the card
 * moves when the posts arrive.
 */
const SKELETON_CHIP_CLASSES = 'h-6 w-20 rounded-full';
const SKELETON_CHIP_NARROW_CLASSES = 'h-6 w-16 rounded-full';

/**
 * Props for {@link PostCardSkeleton}.
 */
interface PostCardSkeletonProps {
  /**
   * Extra utilities for the card root, merged last so they win their Tailwind group.
   *
   * The only prop, on purpose. Everything else about this component is fixed because its GEOMETRY is
   * its contract: a `lines` or `showCover` prop would let a caller produce a placeholder that does
   * not match the card it is standing in for, which is the one failure mode a skeleton has.
   */
  className?: string;
}

/**
 * The loading placeholder for a {@link PostCard}.
 *
 * Renders the same `Card` shell filled with pulsing blocks laid out to the real card's measurements,
 * so replacing it with a loaded card shifts nothing on the page.
 *
 * ### Hidden from assistive technology, and announced by the list instead
 *
 * The root is `aria-hidden="true"` and the component contains no text at all, so a screen reader
 * hears nothing from it. It deliberately carries NO `role="status"`: `post-list.tsx` renders a run of
 * these, and a live region per placeholder would announce "loading" once per card. The announcement
 * belongs to the wrapper around the run, which is where the meaning actually lives - the pattern
 * `ui/skeleton.tsx` documents.
 *
 * Nothing here is focusable, so hiding the subtree cannot strand a control outside the accessibility
 * tree.
 *
 * ### The cover frame is always reserved
 *
 * A skeleton has to commit to one geometry, and a post with a cover is the common case - the space is
 * reserved by the same `aspect-video` frame the real card uses, so the two agree exactly whenever
 * there is a cover and the card settles slightly shorter when there is not.
 *
 * The pulse comes from the `Skeleton` primitive, which draws it from the engine's `--animate-pulse`
 * token and stills it under `prefers-reduced-motion: reduce`. There is no `@keyframes` block here and
 * no stylesheet of any kind - `globals.css` is this tier's only one.
 *
 * @param props - See {@link PostCardSkeletonProps}.
 * @returns The rendered placeholder. Never `null`.
 *
 * @example A loading feed, announced once for the whole run
 * ```tsx
 * <div aria-label="Loading posts" role="status">
 *   {Array.from({ length: 6 }, (unused, index) => (
 *     <PostCardSkeleton key={index} />
 *   ))}
 * </div>
 * ```
 */
export function PostCardSkeleton({ className }: PostCardSkeletonProps): JSX.Element {
  return (
    // The default `div` rather than `article`: a placeholder is a panel with no independent meaning,
    // and it is hidden from assistive technology anyway - it is not an independently distributable
    // item the way a real post card is. The choice costs nothing in layout, so parity is unaffected.
    <Card aria-hidden="true" className={className}>
      <div className={COVER_FRAME_CLASSES}>
        <Skeleton className={SKELETON_COVER_CLASSES} />
      </div>

      <CardHeader>
        <div className={SKELETON_TITLE_BLOCK_CLASSES}>
          <Skeleton className={SKELETON_TITLE_LINE_CLASSES} />
          <Skeleton className={SKELETON_TITLE_LAST_LINE_CLASSES} />
        </div>

        <div className={SKELETON_BYLINE_ROW_CLASSES}>
          <Skeleton className={SKELETON_AVATAR_CLASSES} />
          <Skeleton className={SKELETON_BYLINE_TEXT_CLASSES} />
        </div>
      </CardHeader>

      <CardContent>
        <div className={SKELETON_EXCERPT_BLOCK_CLASSES}>
          <Skeleton className={SKELETON_EXCERPT_LINE_CLASSES} />
          <Skeleton className={SKELETON_EXCERPT_LINE_CLASSES} />
          <Skeleton className={SKELETON_EXCERPT_LAST_LINE_CLASSES} />
        </div>
      </CardContent>

      <CardFooter>
        <Skeleton className={SKELETON_CHIP_CLASSES} />
        <Skeleton className={SKELETON_CHIP_NARROW_CLASSES} />
      </CardFooter>
    </Card>
  );
}
