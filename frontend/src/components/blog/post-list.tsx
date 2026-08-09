// Post list - the windowed grid of post cards, and the SINGLE OWNER of the feed's grid geometry.
//
// Three surfaces render it: the home feed (`src/app/page.tsx`), an author's public profile
// (`src/app/u/[username]/page.tsx`) and the author workspace (`src/app/(dashboard)/dashboard/
// page.tsx`). Each hands in one `Page<PostSummary>` envelope and gets back the same layout, so the
// one/two/three-column rhythm is defined here once instead of three times.
//
// `src/components/blog/post-card.tsx` is deliberately width-agnostic - it sets no width, no
// max-width and no column count - precisely so that this file can own the tracks. The two files are
// two halves of one decision, and the seam between them is that the card sizes itself to whatever
// track it lands in.
//
// ---------------------------------------------------------------------------
// 1. NO `'use client'`. THIS IS THE MOST CONSEQUENTIAL LINE IN THE FILE.
//
// There is no state, no effect, no hook, no event handler and no browser API below, so the module
// stays shared and renders on the server. That is what puts every card's title, link, excerpt,
// byline and category chips into the INITIAL HTML response - which the plan calls the single most
// consequential SEO decision it makes, because a crawler has to see the feed without executing any
// client JavaScript.
//
// The trap this file exists to avoid is `@/hooks/use-pagination`. That hook builds the page URLs and
// it is genuinely the tier's only implementation of page arithmetic - but it calls
// `useSearchParams`, `usePathname` and `useRouter`, so importing it HERE would force a client
// directive onto this module and pull the entire feed - every card, every excerpt, every title -
// behind hydration and out of the server-rendered HTML.
//
// So the hook is reached THROUGH `@/components/ui/pagination`, which is the client island that
// consumes it, and which was authored over `<nav>` with real `<a href>` links for exactly this
// reason. It takes serializable numbers only, a Server Component can therefore render it directly,
// and because the App Router server-renders client components too, its anchors still land in the
// initial HTML. This file passes numbers down and builds no URL of its own.
//
// ---------------------------------------------------------------------------
// 2. WHY THE LOADED BRANCH IS A `<ul>` OF `<li>` AND THE LOADING BRANCH IS NOT
//
// A feed is a list of items, so the loaded branch is a real list: a screen-reader user hears "list,
// twelve items" and can step between them, which is information a run of sibling `<article>`
// elements does not carry. `list-none` is on the `<ul>` not because Preflight leaves markers behind
// (it does not) but because `@tailwindcss/typography` re-enables them for any `ul` inside a `.prose`
// container - so the utility is what makes this component immune to where it is placed.
//
// That wrapper also settles a question `post-card.tsx` explicitly hands to this file. A CSS grid
// stretches its items to the tallest in the row, and the card is a flex column whose footer carries
// no `mt-auto`, so a stretched card gains trailing space INSIDE its box - measured there at up to
// ~300px on the sparsest card of a three-column row. The card offers two levers: `items-start` on
// the grid, or `mt-auto` on the card's last slot. The second is not available from out here without
// reaching into the primitive's internals (`[&>*:last-child]:mt-auto`), which the design-system
// rules forbid outright. The `<li>` resolves it instead: the LIST ITEM becomes the grid item and is
// stretched, while the card inside it is an ordinary block at its content height. Cards therefore
// have aligned tops and honest bottoms, and no card ever shows an unexplained empty region.
//
// The loading branch is a plain `<div>`, because its children are placeholders that are hidden from
// assistive technology - a list of nothing announced as "list, six items" would be a lie - and
// because that container is the ONE live region this component renders. See note 3. Both branches
// share the same grid class string, so switching between them shifts nothing.
//
// ---------------------------------------------------------------------------
// 3. HOW LOADING IS ANNOUNCED - ONCE, AND WHY `aria-busy` IS ABSENT
//
// `PostCardSkeleton` is `aria-hidden` and deliberately carries no `role="status"` of its own,
// because a live region per placeholder would announce "loading" once per card. The announcement
// belongs to the wrapper around the run, and the pattern below is the one both `post-card.tsx` and
// `ui/skeleton.tsx` document: a single container with `role="status"` and an `aria-label`.
//
// `aria-busy="true"` is NOT set on that container, and its absence is a decision rather than an
// oversight. `aria-busy` on a live region - or on any ancestor of one - instructs assistive
// technology to DEFER announcing until it becomes false, which is the exact opposite of what a
// loading notice needs. The two mechanisms are mutually defeating, so this file picks the one that
// speaks. (`ui/table` is marked busy instead of named, which is right for a grid whose rows are
// being swapped underneath a caption that never changes; a card run has no such caption.)
//
// ---------------------------------------------------------------------------
// 4. WHY THE EMPTY STATE AUTHORS NO `role`, `aria-live` OR `aria-atomic`
//
// `ui/alert.tsx` DERIVES the live-region role from the variant: `destructive` announces assertively,
// `success` and `warning` politely, and `info` and `empty` announce nothing at all. That last entry
// is the one that matters here. An empty panel this component renders is present in the very first
// HTML the server sends, so a live region would make every page load announce "no posts found"
// unprompted, out of document order, ahead of the heading and the search field that would let the
// visitor act on it. An empty state is CONTENT; it is read when the reader arrives at it.
//
// So the variant is selected and nothing is authored on top of it. `components/admin/data-table.tsx`
// does pass `role="status"` explicitly, and that is not an inconsistency: that grid is a client
// island whose panel appears IN an already-loaded screen in response to a filter change or a
// deletion, which is the opt-in case the primitive names. This file is the other case.
//
// Discoverability is not lost by staying silent. The empty state's title renders as a HEADING at the
// same level the cards would have used, so it appears in the document outline and a screen-reader
// user navigating by heading finds it exactly where the results would have been.
//
// ---------------------------------------------------------------------------
// 5. THE PAGE CONTROL IS KEPT FOR AN EMPTY WINDOW. ON PURPOSE.
//
// One rule, applied in both branches: the control renders when `pages > 1`, whatever `items` holds.
//
// The emptiest window the service produces is not an empty collection - it is a page PAST THE END of
// a collection that does have rows. `Page<T>` documents that a page beyond the last is not an error:
// the service echoes the requested page back verbatim with an empty `items` array. A reader gets
// there from a stale bookmark, or by narrowing a filter while on page five. Dropping the control
// would strand them on a blank screen whose only way out is the browser's back button.
//
// This emits no crawlable link to nothing, because `pages > 1` means those pages exist, and
// `ui/pagination` clamps every href it builds. A genuinely empty collection reports `pages: 0`, so
// the gate is false and nothing renders - and the primitive independently returns `null` below two
// pages, so the two guards agree. The RESULT RANGE is what gets dropped instead: "0 of 47" beneath a
// panel already saying there is nothing here is noise, not information.
//
// ---------------------------------------------------------------------------
// 6. WHAT THIS FILE DELIBERATELY DOES NOT DO. Please do not add.
//
//   1. A `'use client'` directive, or an import of `@/hooks/use-pagination`. See note 1.
//   2. An HTTP call - no `fetch`, no `@/lib/api/*`. `src/lib/api/client.ts` is this tier's only HTTP
//      module, and the envelope arrives already fetched by the route that renders this list.
//   3. Any read of the environment. No module below `src/components/` reads one.
//   4. Client-side filtering, sorting, searching or slicing of `page.items`. Search, category
//      filtering, author filtering, ordering and windowing are composed into ONE SQL statement by
//      `backend/app/repositories/post_repository.py`, and `total` and `pages` come out of that same
//      statement. Re-filtering here would silently contradict both.
//   5. A filter, sort or search prop. Query state lives in the URL and the consuming page reads it,
//      which is what keeps every result set linkable, shareable, crawlable and correct under
//      browser back and forward navigation.
//   6. An `<h1>`, or a section heading of its own. The page owns its single top-level heading.
//   7. A literal colour, length, radius, shadow or font size, a `style` prop, a stylesheet, a CSS
//      module or a media query. Every value below is a token-backed utility, and the engine's five
//      breakpoints are the entire responsive vocabulary - of which this file uses `md` and `lg`.
//   8. A `dark:` variant. Every token named below is declared twice in `src/app/globals.css`, once
//      at the document root and once under `.dark`, so this re-themes with no conditional.
//   9. A raw `<button>`, `<input>`, `<textarea>`, `<select>` or `<table>`. Those live only in
//      `src/components/ui/`. The empty panel, the page control and the placeholders all come from
//      primitives rather than being hand-rolled here.
//  10. A virtualiser or an infinite scroller. Pagination is page-based and crawlable by design, and
//      either package would replace the anchors that make it so.
//  11. An array index as a key for a real post. `post.id` is a server-generated UUID and is the
//      identity that survives reordering. Placeholders are the one exception - see
//      {@link SKELETON_CARD_KEY_PREFIX}.
//  12. A `message`/`data` envelope, an `/items` path or an `Item` shape. Note that `Page<T>.items`
//      below IS correct: it is the uniform collection field every endpoint in this product returns,
//      and it has nothing to do with the retired demonstration resource of the same name.

import type { JSX } from 'react';

import { PostCard, PostCardSkeleton } from '@/components/blog/post-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Pagination } from '@/components/ui/pagination';
import { derivePagination, FIRST_PAGE, formatResultRange } from '@/lib/pagination';
import type { Page, PostSummary } from '@/lib/types';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Heading level
 * ---------------------------------------------------------------------------------------------- */

/**
 * Heading levels this list may render at.
 *
 * The same closed union `PostCard` accepts, restated rather than imported because that component
 * does not export it. `1` is excluded because a page spends its single `<h1>` on the route heading,
 * so nothing inside a list can be one; `5` and `6` are excluded because a card title nested that
 * deep means the surrounding outline has already gone wrong, and the constraint surfaces that at
 * compile time instead of in an audit.
 */
type PostListHeadingLevel = 2 | 3 | 4;

/**
 * `h2`, matching `PostCard`'s own default.
 *
 * The three surfaces that render a feed all spend their `h1` on the page heading, so the items
 * beneath it are the second level. A section that has already introduced an `h2` of its own passes
 * `3` so no level is skipped.
 */
const DEFAULT_HEADING_LEVEL: PostListHeadingLevel = 2;

/**
 * The heading tags {@link PostListHeadingLevel} maps to, for the empty state's title.
 *
 * A `Record` over the closed union rather than a ternary, so adding a level fails to compile until
 * it has been given a tag. Indexing it with a `PostListHeadingLevel` yields a tag rather than
 * `tag | undefined` - these are declared properties, not an index signature, so
 * `noUncheckedIndexedAccess` has nothing to widen.
 *
 * The values are narrowed to the three levels this component offers, which is what lets the lookup
 * satisfy `AlertTitle`'s discriminated `as` prop: that union's heading branch accepts
 * `'h2' | 'h3' | 'h4' | 'h5' | 'h6'`, and a value typed as a subset of it selects that branch.
 */
const EMPTY_TITLE_TAG_BY_LEVEL: Readonly<Record<PostListHeadingLevel, 'h2' | 'h3' | 'h4'>> = {
  2: 'h2',
  3: 'h3',
  4: 'h4',
};

/* -------------------------------------------------------------------------------------------------
 * Default copy
 * ---------------------------------------------------------------------------------------------- */

/**
 * Shown when a list has nothing to render and its caller named no copy of its own.
 *
 * Deliberately generic, because this component cannot know WHY the window is empty - and the
 * distinction matters to the reader. "No posts match your search" and "this author has not published
 * anything yet" are different facts and lead to different next actions, so the surface that knows
 * which one applies says it through `emptyTitle` and `emptyDescription`.
 */
const DEFAULT_EMPTY_TITLE = 'No posts found';

/** @see {@link DEFAULT_EMPTY_TITLE} */
const DEFAULT_EMPTY_DESCRIPTION =
  'Nothing matches this view yet. Try a different search term, or clear the category filter to see everything.';

/**
 * Accessible name of the loading region.
 *
 * The placeholders inside it contribute no text at all - they are hidden from assistive technology -
 * so this label is the whole of what a screen reader announces for the loading state. It is
 * therefore a sentence fragment that stands on its own rather than a decoration on visible copy.
 */
const LOADING_LABEL = 'Loading posts';

/* -------------------------------------------------------------------------------------------------
 * Loading placeholder geometry
 * ---------------------------------------------------------------------------------------------- */

/**
 * How many placeholders to draw while a page is in flight.
 *
 * Six, which is exactly two full rows at three columns, three at two columns and six stacked at one
 * - so the run fills the widest layout without a ragged final row at any of the three.
 *
 * FIXED rather than derived from `page.page_size`, unlike the administrative grid's row count, and
 * for two reasons. A caller loading its first page often has no envelope yet and passes zeroed
 * numbers, so the window size is not reliably known at the moment the count is needed. And a card is
 * an order of magnitude taller than a table row: the service permits a window of 100, and drawing a
 * hundred throwaway cards would cost far more than the layout stability it buys. Holding the fold
 * steady is the entire purpose of drawing placeholders, and two rows does that.
 */
const SKELETON_CARD_COUNT = 6;

/**
 * Prefix for placeholder keys.
 *
 * Placeholders are the one place in this component where a positional key is correct. A real post is
 * keyed by `post.id` because it has a server-generated identity that survives reordering; a
 * placeholder has none - it is a position in a fixed-length run and nothing else - so its index IS
 * its identity. The prefix keeps those keys from ever colliding with a real identifier.
 */
const SKELETON_CARD_KEY_PREFIX = 'placeholder-card-';

/* -------------------------------------------------------------------------------------------------
 * Class recipes
 *
 * Module-scope constants rather than inline strings, so each group can carry the note explaining why
 * it is there and the JSX below reads as structure. Every value is a token-backed utility; there is
 * not one literal colour, length, radius, shadow or font size in this file.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The component root: a vertical stack of regions.
 *
 * `gap-6` between the grid and the footer, so neither region carries a margin that could collapse
 * against a sibling or double up against the page's own rhythm. Deliberately NO width, max-width or
 * horizontal inset - the consuming layout owns the outer measure, and a width here would fight it.
 */
const ROOT_CLASSES = 'flex flex-col gap-6';

/**
 * THE GRID. This one string is this file's defining responsibility.
 *
 * One column below `48rem`, two from `48rem`, three from `64rem` - authored mobile-first, so the
 * single-column form is the base and each breakpoint adds a track. `md` and `lg` are drawn from the
 * engine's own five-breakpoint scale (`sm` 40rem, `md` 48rem, `lg` 64rem, `xl` 80rem, `2xl` 96rem);
 * there is no custom media query, no `sm:`, `xl:` or `2xl:` variant, and no bespoke flex fallback.
 *
 * Because those variants are `min-width` queries, the two-column layout is active AT 768px rather
 * than above it - 768px is exactly `48rem` at a 16px root - which is what the responsive gate
 * measures at that width.
 *
 * `grid-cols-<n>` expands to `repeat(<n>, minmax(0, 1fr))`, and the `0` floor is what keeps a long
 * unbroken title from widening a track past its share; see {@link GRID_ITEM_CLASSES} for the other
 * half of that guarantee.
 *
 * `gap-6` is the `--spacing` scale and is the only separation between cards, matching the card's own
 * `p-6` inset so the gutter and the padding read as one rhythm. No max-width and no row height: the
 * page owns the measure, and rows size to their content.
 *
 * `list-none` is here rather than left to Preflight because `@tailwindcss/typography` re-enables
 * list markers for any `ul` inside a `.prose` container - so the utility is what makes this list
 * immune to where it is placed. It is inert on the loading branch's `<div>`, which shares this
 * string precisely so the two states are geometrically identical and switching shifts nothing.
 */
const GRID_CLASSES = 'grid list-none grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3';

/**
 * A grid cell.
 *
 * `min-w-0` removes the item's automatic content-based minimum size, and it is load-bearing rather
 * than defensive. The card floors its own min-content with `min-w-0`, but it wraps long text with
 * `overflow-wrap: break-word` - and CSS Text 3 excludes the soft-wrap opportunities that value
 * introduces from MIN-CONTENT sizing, so an unbroken token in a title can still push a grid item
 * wider than its track and put the document into horizontal scroll. This is the utility that stops
 * it, and the no-overflow criterion at 375, 768 and 1440px depends on it.
 *
 * Nothing else: no padding, no border, no background. A cell is a positioning slot, and the card it
 * holds is the visible surface.
 */
const GRID_ITEM_CLASSES = 'min-w-0';

/**
 * The footer: the result range above the page control.
 *
 * A centred stack at every width. `items-center` shrinks the range line to its own content so it
 * centres under the control rather than stretching across the measure; the control itself is
 * `w-full` and centres its own row, so the two share one axis. `gap-4` is a tighter step than the
 * root's, which groups the pair as one region instead of three equally spaced siblings.
 */
const FOOTER_CLASSES = 'flex flex-col items-center gap-4';

/** The result range: supporting copy, so the recessed foreground token and the small step. */
const RANGE_CLASSES = 'text-sm text-muted-foreground';

/* -------------------------------------------------------------------------------------------------
 * Result range
 *
 * There is no arithmetic here any more, and that is the fix rather than an omission. This file used to
 * carry its own `positiveIntegerOr` and `resultSummary`, with a note acknowledging that the sentence was
 * duplicated verbatim in `components/admin/data-table.tsx` and that a shared module "would be a larger
 * change than the duplication it saves". It was not: the duplication existed only because the arithmetic
 * lived in `@/hooks/use-pagination`, and this component is a SERVER component - no `'use client'`, so the
 * rows reach the initial HTML for the SEO requirement - which cannot call a hook at all.
 *
 * `@/lib/pagination` is that arithmetic with the hook removed, so this file now calls exactly what the
 * client-side control and the administrative grid call. One range calculation, one sentence, three
 * consumers.
 * ---------------------------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------------------------------
 * PostList
 * ---------------------------------------------------------------------------------------------- */

/**
 * Props for {@link PostList}.
 */
interface PostListProps {
  /**
   * The window to render, as the API's uniform page envelope.
   *
   * Exactly the five fields `Page<T>` declares - `items`, `total`, `page`, `page_size`, `pages` - in
   * the service's own snake_case, because there is no camelCase adaptation layer anywhere in this
   * tier. Pass the response through unchanged; no field is derived, renamed or recomputed here.
   *
   * `items` may be empty for two different reasons - a collection with no rows, and a page past the
   * end of one that has rows - and both render the empty state. See note 5 in the module header for
   * why only the second keeps its page control.
   */
  page: Page<PostSummary>;
  /**
   * Whether the window is still in flight. Defaults to `false`.
   *
   * While `true` the grid holds {@link SKELETON_CARD_COUNT} placeholders instead of cards, and
   * `page` is not read at all - so a caller with no envelope yet may pass a zeroed one. Loading takes
   * precedence over every other state, so a stale envelope cannot show through a refresh.
   */
  isLoading?: boolean;
  /**
   * Headline of the empty state. Defaults to {@link DEFAULT_EMPTY_TITLE}.
   *
   * Worth setting on every surface, because the default cannot be specific: a filtered home feed, an
   * author with no published posts and a dashboard with no drafts are three different facts.
   */
  emptyTitle?: string;
  /** Supporting copy of the empty state. Defaults to {@link DEFAULT_EMPTY_DESCRIPTION}. */
  emptyDescription?: string;
  /**
   * Heading level for each card's title, and for the empty state's headline. Defaults to `2`.
   *
   * Passed straight through to `PostCard`, so the consuming page owns its outline: a feed directly
   * under the page's `<h1>` leaves this alone, while a section that has already introduced an `<h2>`
   * of its own passes `3` so no level is skipped. There is no level `1` - see
   * {@link PostListHeadingLevel}.
   */
  headingLevel?: PostListHeadingLevel;
  /**
   * Whether the FIRST card's cover should load eagerly at high priority. Defaults to `false`.
   *
   * An opt-in, and one the consuming page has to make, because only it knows whether this list sits
   * above the fold. The home feed's first cover is the page's Largest Contentful Paint candidate and
   * benefits; the same list further down a profile page does not.
   *
   * It applies to the first card ONLY. Prioritising every cover is actively harmful - it makes the
   * browser contend for bandwidth on images nobody has scrolled to - and `next/image` warns while
   * the Core Web Vitals lint rules object. There is deliberately no way to ask for more than one.
   */
  prioritizeFirstCover?: boolean;
  /**
   * Extra utilities for the component root, merged last so they win their Tailwind group.
   *
   * The seam for the consuming layout's own concerns - its outer measure, its vertical rhythm. Note
   * that the GRID is not addressable from here: the one/two/three-column geometry is this component's
   * contract, and a caller overriding it would break the responsive criteria the whole product is
   * measured against.
   */
  className?: string;
}

/**
 * A windowed grid of post cards, with its own loading, empty and paginated states.
 *
 * Renders exactly one of three things, then optionally a footer beneath it:
 *
 *   * **Loading** - {@link SKELETON_CARD_COUNT} placeholders in the same grid the cards will occupy,
 *     inside the single live region that announces the wait.
 *   * **Empty** - a quiet dashed panel whose headline is a heading at `headingLevel`, so the absence
 *     of results is findable in the document outline exactly where the results would have been.
 *   * **Loaded** - one `PostCard` per row, as a semantic list, keyed by each post's server-generated
 *     identifier.
 *
 * The footer carries the result range - dropped when the window is empty - and the page control,
 * which appears whenever the collection occupies more than one page.
 *
 * ### What it renders in the initial HTML
 *
 * All of it, including the page control's anchors. This module declares no client directive, so on a
 * Server Component page a crawler receives the whole feed - titles, links, excerpts, bylines and the
 * pagination hrefs - without executing any JavaScript. See note 1 in the module header.
 *
 * ### The grid, which is this component's contract
 *
 * One column below `48rem`, two from `48rem`, three from `64rem`, with a token gutter and no
 * max-width. Cards are width-agnostic and size themselves to the track they land in.
 *
 * ### State precedence
 *
 * `isLoading` wins over everything, then emptiness, then the loaded list. Resolved in one place below
 * so no two branches can both believe they are showing.
 *
 * @param props - See {@link PostListProps}.
 * @returns The rendered list. Never `null` - an empty window still renders its panel, which is the
 *   whole point of having one.
 *
 * @example The home feed, whose page heading is the `h1`
 * ```tsx
 * const feed = await listPosts({ page, q, category });
 * return (
 *   <PostList
 *     emptyDescription="Try a different search term, or clear the category filter."
 *     emptyTitle="No posts match your search"
 *     page={feed}
 *     prioritizeFirstCover
 *   />
 * );
 * ```
 *
 * @example An author profile, inside a section that has already spent an `h2`
 * ```tsx
 * <section>
 *   <h2>Published articles</h2>
 *   <PostList
 *     emptyTitle="Nothing published yet"
 *     headingLevel={3}
 *     page={posts}
 *   />
 * </section>
 * ```
 *
 * @example A client island that refetches, passing a zeroed envelope on the first render
 * ```tsx
 * <PostList isLoading={isPending} page={data ?? EMPTY_PAGE} />
 * ```
 */
export function PostList({
  page,
  isLoading = false,
  emptyTitle = DEFAULT_EMPTY_TITLE,
  emptyDescription = DEFAULT_EMPTY_DESCRIPTION,
  headingLevel = DEFAULT_HEADING_LEVEL,
  prioritizeFirstCover = false,
  className,
}: PostListProps): JSX.Element {
  /*
   * State precedence, decided once: loading beats empty, empty beats loaded. Booleans rather than a
   * nested ternary chain in the JSX, so each branch below is a single condition and the markup reads
   * as structure.
   */
  const showsPlaceholders = isLoading;
  const showsCards = !isLoading && page.items.length > 0;
  const showsEmptyState = !isLoading && page.items.length === 0;

  /*
   * `null` for an empty window, which doubles as the gate for the range line - see note 5. Computed
   * before the JSX so the footer's own condition stays a plain boolean comparison.
   */
  // One derivation, used for the range sentence and for the control's own gate, so the two cannot
  // disagree about whether this window has rows.
  const derived = derivePagination(page);
  const summary = isLoading ? null : formatResultRange(derived);

  /*
   * The page control is gated on the envelope's own count and NOT on whether there are rows, so a
   * reader who has run off the end of a collection keeps their way back. `ui/pagination` independently
   * returns `null` at or below one page, so this gate and that one agree; it is written out here
   * anyway, because the footer must not render an empty wrapper around a component that decided to
   * render nothing.
   */
  const showsPagination = !isLoading && derived.pages > FIRST_PAGE;

  return (
    <div className={cn(ROOT_CLASSES, className)}>
      {showsPlaceholders ? (
        /*
         * The ONE live region this component renders, named rather than marked busy - see note 3.
         * `PostCardSkeleton` is `aria-hidden` and carries no role of its own, so nothing inside
         * contributes text and this label is the whole announcement.
         */
        <div aria-label={LOADING_LABEL} className={GRID_CLASSES} role="status">
          {Array.from({ length: SKELETON_CARD_COUNT }, (_, index) => (
            /*
             * A positional key, which is correct here and only here: a placeholder is a position in a
             * fixed-length run and has no identity of its own. See {@link SKELETON_CARD_KEY_PREFIX}.
             *
             * No wrapping `<li>`, because this container is not a list - and none is needed for
             * geometry either, since every placeholder has identical dimensions and so cannot be
             * stretched unevenly by its row.
             */
            <PostCardSkeleton key={`${SKELETON_CARD_KEY_PREFIX}${index}`} />
          ))}
        </div>
      ) : null}

      {showsCards ? (
        <ul className={GRID_CLASSES}>
          {page.items.map((post, index) => (
            /*
             * Keyed by the post's server-generated identifier - never by `index`, which would make
             * React reuse the wrong card's DOM when the reader turns the page or changes the sort.
             *
             * The `<li>` is the grid item; the card inside it is an ordinary block at its content
             * height. That is what gives every row aligned tops without leaving trailing space inside
             * a sparse card. See note 2.
             */
            <li className={GRID_ITEM_CLASSES} key={post.id}>
              <PostCard
                headingLevel={headingLevel}
                post={post}
                /*
                 * The first cover only, and only when the consuming page has said this list is above
                 * the fold. `index === 0` is the position in THIS window, so page two's first card is
                 * eligible too - which is right, because it occupies the same place on screen.
                 */
                priority={prioritizeFirstCover && index === 0}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {showsEmptyState ? (
        /*
         * No `role`, `aria-live` or `aria-atomic` here. The `empty` variant announces nothing by
         * design, and that is correct for a panel the server renders into a page - see note 4.
         *
         * No `className` either, so this panel is byte-identical to the administrative grid's empty
         * state. Consistency across the product's list surfaces is worth more than a bespoke inset.
         */
        <Alert variant="empty">
          {/*
           * A heading, at the level the cards would have used, so the empty state occupies the same
           * place in the document outline that the results would have and a screen-reader user
           * navigating by heading finds it there. The lookup is narrowed to three levels, which
           * selects the heading branch of `AlertTitle`'s discriminated `as` union.
           */}
          <AlertTitle as={EMPTY_TITLE_TAG_BY_LEVEL[headingLevel]}>{emptyTitle}</AlertTitle>
          <AlertDescription>{emptyDescription}</AlertDescription>
        </Alert>
      ) : null}

      {summary !== null || showsPagination ? (
        <div className={FOOTER_CLASSES}>
          {summary === null ? null : <p className={RANGE_CLASSES}>{summary}</p>}

          {showsPagination ? (
            /*
             * Serializable numbers only. No callback, because a function cannot cross the
             * server-to-client boundary and this module is a Server Component on every surface that
             * renders it; no `hrefForPage`, because the default - `@/hooks/use-pagination`, reached
             * from inside that client island - is the correct source for a page addressed by the
             * query string, which is all three of them.
             *
             * `total` and `page_size` are the primitive's documented recovery path for an envelope
             * whose `pages` did not survive as a usable number. They cost nothing and they come from
             * the same envelope as the other two, so the four cannot disagree.
             */
            <Pagination
              page={page.page}
              page_size={page.page_size}
              pages={page.pages}
              total={page.total}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
