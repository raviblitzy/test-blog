// The home feed - the root route, and requirement R3 in full: recent posts with
// search, category filters and pagination.
//
// It is also the route the whole rendering split exists for. A crawler has to be
// able to read the feed - titles, excerpts, bylines, category badges and the
// pagination hrefs - without executing a line of JavaScript, so this module is a
// Server Component that fetches during render and hands the result to a
// directive-free list component. The two interactive controls are the only client
// code on the screen, and they are islands rather than the page.
//
// ---------------------------------------------------------------------------
// 1. NO `'use client'`. THIS IS THE FILE'S LOAD-BEARING DECISION.
//
// The feed must be in the initial HTML. Adding the directive would move the fetch
// to the browser, empty the server response of every article, and quietly delete
// the SEO requirement while leaving the page looking identical to a human.
//
// It also has to stay absent for `await` to be legal here at all: only a Server
// Component may be an async function, and `searchParams` arrives as a Promise.
//
// Interactivity is not lost by this - it is relocated. `search-input.tsx` and
// `category-filter.tsx` carry their own `'use client'`, and both write to the URL
// rather than to state. A URL change re-renders THIS component on the server,
// which fetches the narrowed page. So the reader gets live controls and the
// crawler gets rendered content from one code path.
//
// ---------------------------------------------------------------------------
// 2. THE QUERY STATE LIVES IN THE URL, AND IT IS EXACTLY FOUR PARAMETERS.
//
//     q         free-text search term
//     category  category slug
//     page      1-based page number
//     sort      'recent' | 'relevance'
//
// Holding them in the address bar rather than in component state is what makes
// every result set linkable, shareable, crawlable and correct under browser Back
// and Forward. It is also why `page_size` is deliberately NOT among them: the
// window is a rendering decision, not part of the resource's identity, and
// exposing it would mint an unbounded family of URLs serving the same posts.
//
// Every one of the four arrives as an attacker-controlled string, so each is
// normalised before it reaches the API rather than forwarded on trust. See the
// normalisation section for what each guard prevents.
//
// ---------------------------------------------------------------------------
// 3. THE GRID AND THE PAGE CONTROL ARE NOT WRITTEN HERE.
//
// `@/components/blog/post-list.tsx` is the single declared owner of the feed's
// one/two/three-column geometry and of the pagination placement beneath it.
// Restating either would create a second authority for the same layout, and the
// two would drift the first time the tracks changed. So this file renders the
// page shell, the heading, the controls row and `<PostList>`, and nothing about
// columns or page links.
//
// The same division is why `src/app/loading.tsx` renders `<PostList isLoading>`
// instead of its own placeholder grid. That file is this one's skeleton mirror,
// and the class recipes below are deliberately byte-identical to its own so the
// swap from fallback to content moves nothing on screen.
//
// ---------------------------------------------------------------------------
// 4. THIS FILE PERFORMS NO HTTP AND READS NO ENVIRONMENT VARIABLE.
//
// Two reads happen, both through the typed wrappers in `@/lib/api`, whose
// `client.ts` is the only module in this tier that touches `fetch`. There is no
// URL construction, no header handling and no status-code branching here.
//
// The canonical site origin belongs to `@/lib/seo`, and the API base URL belongs
// to `@/lib/api/client`. Neither is read here, so there is no `process.env` in
// this module at all.
//
// ---------------------------------------------------------------------------
// 5. WHAT THIS FILE DELIBERATELY DOES NOT DO. Please do not add.
//
//   1. `'use client'`. See note 1.
//   2. `import React from 'react'`. `"jsx": "react-jsx"` is set in
//      frontend/tsconfig.json, so the runtime is injected by the compiler and the
//      default import is dead weight that also trips the lint gate.
//   3. A bare `fetch`, or any import from `@/lib/api/client`. See note 4.
//   4. Any read of `process.env`. See note 4.
//   5. A grid, column or pagination utility, or a `<Pagination>` element. See
//      note 3.
//   6. A fifth search parameter, or `page_size` in the URL. See note 2.
//   7. A camelCase rewrite of the page envelope. `Page<T>` carries `items`,
//      `total`, `page`, `page_size` and `pages` in the service's own snake_case,
//      there is no adaptation layer anywhere in this tier, and renaming a field
//      into a local produces something that compiles and reads `undefined`.
//   8. `.items` on the category array. `GET /api/v1/categories` is the API's one
//      sanctioned exception to the page envelope and answers a BARE array; there
//      is no envelope to unwrap and reaching for one is a type error.
//   9. A client-side status filter, or a `status` parameter on the feed request.
//      The public feed is published-only for every caller, enforced in
//      backend/app/repositories/post_repository.py. A second definition of draft
//      confidentiality in this tier is how a draft eventually leaks.
//  10. A raw `<button>`, `<input>`, `<select>` or `<table>`. The search box is
//      `SearchInput`, the filter is `CategoryFilter`, and the page links are
//      inside `PostList`.
//  11. A literal colour, length, radius, shadow or font size, a `style` prop, a
//      stylesheet, a CSS module or a media query of any kind. Every value below
//      is a token-backed utility, and the engine's five breakpoints (`sm` 40rem,
//      `md` 48rem, `lg` 64rem, `xl` 80rem, `2xl` 96rem) are the entire responsive
//      vocabulary - of which this file uses `sm` and `md`.
//  12. A second `<h1>`, or a `<main>`, `<header>` or `<footer>`. src/app/layout.tsx
//      owns the shell and emits no heading of any level, so the single `<h1>`
//      below is the document's only one and every heading beneath it descends
//      from it.
//  13. An OpenGraph image override. The root metadata's default card and the
//      generated `opengraph-image.tsx` route already cover this route.
//  14. `export const dynamic`, `revalidate` or `force-dynamic`. Reading
//      `searchParams` already makes this route dynamic, which is exactly right
//      for URL-driven query state; restating it is configuration with no effect.
//  15. A `<Suspense>` boundary around either control. One was written for each,
//      measured, and removed: a pending boundary is delivered as a `<div hidden>`
//      that an inline script reveals, so wrapping the pickers took them OUT of the
//      server-rendered HTML - the exact opposite of why the taxonomy is passed to
//      `CategoryFilter` as a prop. The boundary those components ask for guards a
//      route the framework tries to PRERENDER, and this one cannot be: it reads
//      `searchParams`, the build reports it as `ƒ`, and all three gates pass
//      without a boundary. See the measurements on {@link HomePage}.

import type { Metadata } from 'next';
import { cache, type JSX } from 'react';

import { CategoryFilter } from '@/components/blog/category-filter';
import { PostList } from '@/components/blog/post-list';
import { SearchInput } from '@/components/blog/search-input';
import { listCategories } from '@/lib/api/categories';
import { listPosts } from '@/lib/api/posts';
import { buildFeedMetadata } from '@/lib/seo';
import { MAX_SEARCH_TERM_LENGTH, POST_SORTS } from '@/lib/types';
import type { CategoryPublic, PostSort } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Request shape
 * ---------------------------------------------------------------------------------------------- */

/**
 * The props the App Router hands a page component.
 *
 * `searchParams` is a **Promise** in this major version and must be awaited; a synchronous read
 * compiles under a looser annotation and then yields a Promise where a record was expected, which is
 * the single most likely mistake in this file. The shape is structurally identical to the framework's
 * own generated `PageProps<'/'>`, and it is restated locally rather than referenced so that
 * `tsc --noEmit` succeeds on a clean checkout - that global is emitted into `.next/types` by a build,
 * and a type-check that depends on a build artefact is a type-check that fails on a fresh clone.
 *
 * A repeated parameter (`?q=a&q=b`) arrives as `string[]`, and an absent one as `undefined`. Both are
 * handled by {@link firstValue} rather than assumed away.
 *
 * `params` is deliberately absent: the root route has no dynamic segments, so accepting it would be
 * dead surface.
 */
interface HomePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/** Name of the free-text search parameter. Written by `@/components/blog/search-input`. */
const SEARCH_PARAM = 'q';

/** Name of the category-slug parameter. Written by `@/components/blog/category-filter`. */
const CATEGORY_PARAM = 'category';

/** Name of the page parameter. Written by `@/components/ui/pagination` through `@/hooks/use-pagination`. */
const PAGE_PARAM = 'page';

/** Name of the ordering parameter. */
const SORT_PARAM = 'sort';

/**
 * The first page, 1-based, matching the service's own numbering and `Page.page`.
 *
 * Also the floor {@link readPage} clamps to. There is deliberately no ceiling constant beside it -
 * see that function for why a page past the end must survive the trip.
 */
const FIRST_PAGE = 1;

/**
 * How many posts one page of the feed holds.
 *
 * **Twelve, because it divides evenly into one, two and three columns**, so no page of a full
 * collection ends in a ragged final row at any of the three layouts the grid takes. It sits inside
 * the service's accepted `page_size` range of 1..100 - that range is *validated* rather than clamped,
 * so a value outside it would be refused with a problem document rather than quietly corrected.
 *
 * A module constant and **not** a search parameter, for the reason given in note 2 of the header: the
 * window is this route's rendering decision, not part of the resource's identity. `src/app/loading.tsx`
 * declares the same number so its zeroed envelope describes the request genuinely in flight; the two
 * should be changed together.
 */
const FEED_PAGE_SIZE = 12;

/**
 * Longest reader-supplied term this page will quote back inside a sentence, in code points.
 *
 * Well below {@link MAX_SEARCH_TERM_LENGTH}, which bounds what the *service* accepts rather than what
 * reads as a sentence: quoting 256 characters back in an empty-state message looks like a
 * malfunction. See {@link clipForDisplay}.
 */
const DISPLAY_TERM_MAX_LENGTH = 48;

/**
 * Prefix for this module's server-side log lines, so a degraded read is attributable at a glance.
 *
 * Matches the convention `src/app/sitemap.ts` uses for the same purpose.
 */
const LOG_PREFIX = '[home-feed]';

/**
 * The accessible name of this page's search field.
 *
 * Overrides `SearchInput`'s own default of "Search posts", and the reason is a real ambiguity rather
 * than a preference. From `lg` upward `src/components/layout/site-header.tsx` renders its own separate
 * native search form, so two search fields are on screen at once - and with both taking the component
 * default they were announced by the identical name, leaving a screen-reader user no way to tell the
 * site-wide box in the banner from the one that filters the feed. Verified in a browser at 1280px:
 * both resolved to `searchbox "Search posts"`.
 *
 * Naming this one for its scope resolves it from the consuming side, which is the right side: the
 * component exposes `label` for exactly this, so no shared file has to change. A noun phrase, as that
 * prop documents, because it is announced on every focus.
 */
const SEARCH_LABEL = 'Search all posts';

/* -------------------------------------------------------------------------------------------------
 * Class recipes
 *
 * Module-scope constants rather than inline strings, so each can carry the note explaining the
 * geometry it establishes while the JSX below reads as structure. Every value is a token-backed
 * utility: there is not one literal colour, length, radius, shadow or font size in this file. Each
 * string is ordered as prettier-plugin-tailwindcss orders it, so none churns on format.
 *
 * The first four are byte-identical to their counterparts in `src/app/loading.tsx`. That is the point
 * rather than a coincidence - that file is this one's Suspense fallback, and any divergence in the
 * measure, the insets or the field widths would slide the whole fold sideways at the moment the
 * server's data arrived.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The page shell: the measure, the insets and the vertical stack, in one element.
 *
 * `max-w-6xl` is the `--container-6xl` token (72rem), the cap `src/components/layout/site-header.tsx`
 * and `site-footer.tsx` both establish - so the feed's content lines up with the shell above and
 * below it - and wide enough for the three-column grid the page reaches at `lg`. `px-4 sm:px-6` is
 * the shared gutter, stepping once at the only breakpoint that needs it, and `py-12` the shared
 * vertical rhythm; `src/app/layout.tsx` gives `<main>` no padding or measure of its own precisely so
 * each route sets these.
 *
 * `mx-auto` centres it and `w-full` keeps it filling the space below the cap. `flex flex-col gap-8`
 * lets this one element be both the measure and the stack, rather than adding a DOM level with no
 * visual behaviour. `gap-8` is a step above the grid's internal `gap-6`, which reads the cards as one
 * region beneath the controls instead of a third equally spaced sibling.
 */
const SHELL_CLASSES = 'mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-12 sm:px-6';

/**
 * The controls row: the search field beside the category picker.
 *
 * Stacked below `md`, one row from `md` up - the same breakpoint at which the grid takes its second
 * column, so the controls and the cards change shape together rather than at two different widths.
 * `items-center` puts the two fields on one axis once they share a row, and `gap-4` is a tighter step
 * than the shell's, which reads the pair as a single region.
 */
const CONTROLS_CLASSES = 'flex flex-col gap-4 md:flex-row md:items-center';

/**
 * Placement for the search field.
 *
 * `md:flex-1` rather than a second `w-full`: once the row exists the field takes the leftover space,
 * and `flex: 1 1 0` is what expresses that without fighting the picker's fixed width beside it. The
 * component's own root already carries `w-full`, which governs the stacked layout below `md`, so the
 * two variants compose rather than conflict.
 */
const SEARCH_PLACEMENT_CLASSES = 'md:flex-1';

/**
 * Placement for the category picker.
 *
 * `md:w-56` is the shape a short list of category names takes beside a flexing search field. The
 * component's own root carries `w-full min-w-0`, so it fills the width while stacked and can still
 * shrink inside the row without pushing the document into horizontal scroll.
 */
const CATEGORY_PLACEMENT_CLASSES = 'md:w-56';

/**
 * The introduction block: the `<h1>` and its supporting line.
 *
 * `gap-2` is the tightest step in this file, which binds the two as one block rather than as two
 * items in the shell's `gap-8` stack.
 *
 * Rendered as a `<div>` and deliberately **not** a `<header>`. `src/components/layout/site-header.tsx`
 * owns the document's one `<header>`, and while a second one nested inside `<main>` would map to a
 * generic role rather than a second `banner` landmark, relying on that nesting rule to keep the
 * landmark count correct is a fragile way to structure a page. A heading and a sentence need no
 * landmark of their own.
 */
const INTRO_CLASSES = 'flex flex-col gap-2';

/**
 * The document's single `<h1>`.
 *
 * `text-3xl` is the route-heading step, whose line box is the `h-9` band `src/app/loading.tsx` draws
 * in its place. `font-semibold` and `tracking-tight` are the type-scale tokens a heading takes at
 * this size, and `text-balance` distributes a wrapped heading across its lines evenly instead of
 * leaving one orphaned word - it degrades to normal wrapping where unsupported, so it costs nothing.
 */
const HEADING_CLASSES = 'text-3xl font-semibold tracking-tight text-balance';

/**
 * The supporting line beneath the heading.
 *
 * `text-muted-foreground` is the recessed foreground token, which is what marks this as orientation
 * rather than content. `max-w-2xl` caps it at the `--container-2xl` measure so the sentence stays at
 * a readable line length on a wide viewport instead of running the full 72rem of the shell.
 */
const TAGLINE_CLASSES = 'max-w-2xl text-muted-foreground';

/* -------------------------------------------------------------------------------------------------
 * Reading the query string
 *
 * Everything in this section exists because the four values are attacker-controlled text arriving
 * from a URL bar, and each guard below prevents a specific, reproducible failure rather than a
 * hypothetical one. The API wrappers are deliberately faithful forwarders - they do not sanitise on a
 * caller's behalf - so this is where a malformed parameter has to stop.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The one value of a search parameter, whether it arrived once, repeatedly, or not at all.
 *
 * A repeated key (`?q=react&q=fastapi`) arrives as an array, and letting one reach the API would send
 * a parameter the service declares as a scalar. Taking the first is the conventional resolution and
 * matches what a browser form submission would produce.
 *
 * The `undefined` in the return type is not decorative: `noUncheckedIndexedAccess` is on, so indexing
 * an array yields `string | undefined` and an empty array - which `?q` with no `=` can produce - is
 * handled by the type system rather than by a runtime surprise.
 *
 * @param raw - The value as `searchParams` delivered it.
 * @returns The single value, or `undefined` when the parameter is absent or empty.
 */
function firstValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * The free-text search term, trimmed, length-capped, and `undefined` when it narrows nothing.
 *
 * Three things happen here, and the third is the one that matters most:
 *
 * 1. **Trimmed.** `@/lib/api/posts` forwards `q` verbatim on purpose, because the service parses it
 *    with a full-text query parser that understands its own operator syntax and normalising it would
 *    strip an operator a reader typed deliberately. Surrounding whitespace is not part of that
 *    syntax, so removing it is safe and keeps `? q = react ` from reading as a different search.
 * 2. **Empty becomes absent.** A bare `?q=` must not become a search for nothing: the service treats
 *    a blank term as no filter, so forwarding one would produce a second URL for the unfiltered feed
 *    and - because the term drives the empty-state copy and the page title - a screen that claims to
 *    have searched.
 * 3. **Capped at the service's own limit, measured in CODE POINTS.** `listPosts` refuses a longer term
 *    by throwing before it spends a request, and its message says to cap the input rather than send
 *    one. `search-input.tsx` does exactly that with `maxLength`, but a URL is not typed into that
 *    field: without this cap, `?q=` followed by 257 characters would throw inside the page's own
 *    render and turn a crafted link into a 500 on the site's most important route. The unit is code
 *    points because that is what the service counts, so an emoji costs one character here and not two.
 *
 * @param raw - The value as `searchParams` delivered it.
 * @returns The term to search for, or `undefined` when there is nothing to search for.
 */
function readTerm(raw: string | string[] | undefined): string | undefined {
  const trimmed = firstValue(raw)?.trim();

  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }

  // Iterating the string yields whole code points, so the slice can never land inside a surrogate
  // pair and produce a lone half - which would be a malformed term rather than a shorter one.
  const codePoints = [...trimmed];
  return codePoints.length > MAX_SEARCH_TERM_LENGTH
    ? codePoints.slice(0, MAX_SEARCH_TERM_LENGTH).join('')
    : trimmed;
}

/**
 * The category slug to filter by, or `undefined` when no filter is requested.
 *
 * Trimmed and emptied-to-absent for the same reasons as the search term, and then **passed through
 * unchanged**. In particular the case is preserved: `categories.slug` is a case-insensitive column and
 * the service documents the filter as matched case-insensitively, so `?category=Engineering` resolves
 * correctly on its own. Folding it here would duplicate a guarantee the database already makes and
 * publish a canonical URL that disagrees with every link pointing at the same category.
 *
 * A slug that matches no category is not an error - it answers an empty page, which is what the
 * narrowed empty state below is for.
 *
 * @param raw - The value as `searchParams` delivered it.
 * @returns The slug, or `undefined` when the taxonomy is not being filtered.
 */
function readCategorySlug(raw: string | string[] | undefined): string | undefined {
  const trimmed = firstValue(raw)?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The requested page: a whole number no smaller than one, and **never clamped from above**.
 *
 * The floor is required rather than defensive. The service *validates* `page` instead of correcting
 * it, so `?page=0` and `?page=-3` would each answer `422` with a problem document and, since the feed
 * read is fatal to this route, escalate a nonsense URL into the error boundary. Flooring turns all of
 * them into the first page, which is what a reader who mangled a link expects to see.
 *
 * The absence of a ceiling is equally deliberate and is the harder half to get right. A page beyond
 * the last one is a documented, non-error state: the service echoes the requested number back beside
 * the real totals and an empty `items`, which is precisely how a caller detects it has run off the end
 * rather than being silently redirected to a page it never asked for. Clamping against `pages` here
 * is impossible anyway - the total is not known until the response arrives - and clamping afterwards
 * would answer a question the reader did not ask. So an out-of-range page renders the empty state with
 * its page control intact, and the reader walks back.
 *
 * Rejected inputs - `abc`, ``, `1.5`, `1e999`, `Infinity`, `NaN`, a value past the safe-integer range -
 * all collapse to the first page. `Number.parseInt` is used with an explicit radix and its result is
 * checked with `Number.isSafeInteger`, which excludes `NaN`, both infinities and anything the API
 * could not represent faithfully in JSON.
 *
 * @param raw - The value as `searchParams` delivered it.
 * @returns A safe integer greater than or equal to {@link FIRST_PAGE}.
 */
function readPage(raw: string | string[] | undefined): number {
  const value = firstValue(raw);

  if (value === undefined) {
    return FIRST_PAGE;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > FIRST_PAGE ? parsed : FIRST_PAGE;
}

/**
 * The ordering the reader explicitly asked for, or `undefined` when they did not ask.
 *
 * Narrowed against the contract's own closed member list rather than cast, so nothing but `recent` or
 * `relevance` can reach the API - a bare `?sort=popular` would otherwise be answered with a `422` and
 * take the whole route into the error boundary. `Array.prototype.find` returns the matching member at
 * its literal type, which is what makes this a genuine narrowing with no assertion anywhere.
 *
 * The distinction between "not asked" and "asked for `recent`" is preserved rather than collapsed, and
 * both callers need it: {@link effectiveSort} turns an unasked ordering into relevance when there is a
 * term to rank against, and the canonical URL omits the default so `/` and `/?sort=recent` do not
 * become two addresses for one result set.
 *
 * @param raw - The value as `searchParams` delivered it.
 * @returns The requested ordering, or `undefined` when none was requested or the value was not one of
 * the two the service accepts.
 */
function readSort(raw: string | string[] | undefined): PostSort | undefined {
  const value = firstValue(raw);
  return POST_SORTS.find((candidate) => candidate === value);
}

/**
 * The feed's URL state, normalised.
 *
 * `requestedSort` keeps the reader's *explicit* choice rather than a resolved one, because the two
 * consumers of this object need different answers from it - see {@link effectiveSort} for the request
 * and {@link generateMetadata} for the canonical URL. Collapsing them into one field is the subtle way
 * to publish `/?q=react&sort=relevance` as the canonical address of `/?q=react`.
 */
interface FeedQuery {
  /** The search term, or `undefined` when the feed is not being searched. */
  term: string | undefined;
  /** The category slug, or `undefined` when the taxonomy is not being filtered. */
  categorySlug: string | undefined;
  /** The requested page, floored at {@link FIRST_PAGE} and never capped. */
  page: number;
  /** The ordering the reader explicitly chose, or `undefined` when they chose none. */
  requestedSort: PostSort | undefined;
}

/**
 * Read and normalise all four parameters in one pass.
 *
 * Exactly four are read, and any other parameter in the URL is ignored rather than forwarded - which
 * is what keeps a stray tracking parameter from becoming a filter the service has to reject. The page
 * control preserves unknown parameters when it builds its links, so ignoring them here loses nothing.
 *
 * @param searchParams - The awaited search parameters.
 * @returns The normalised query state.
 */
function readFeedQuery(searchParams: Record<string, string | string[] | undefined>): FeedQuery {
  return {
    term: readTerm(searchParams[SEARCH_PARAM]),
    categorySlug: readCategorySlug(searchParams[CATEGORY_PARAM]),
    page: readPage(searchParams[PAGE_PARAM]),
    requestedSort: readSort(searchParams[SORT_PARAM]),
  };
}

/**
 * The ordering to actually request: the reader's explicit choice, or the one that suits the query.
 *
 * With a term and no explicit choice this resolves to `relevance`, because ordering a search by
 * recency throws away the ranking the service computed for it - the newest post mentioning a word is
 * rarely the best answer for it. With no term it resolves to `recent`, since relevance against an
 * empty query is meaningless.
 *
 * This mirrors what the service does for an absent `sort` rather than contradicting it, so sending the
 * resolved value changes no result. It is sent explicitly all the same: the request then states its own
 * ordering instead of depending on a default declared in another tier, which is the difference between
 * a contract and a coincidence.
 *
 * @param query - The normalised query state.
 * @returns The ordering to send to the API.
 */
function effectiveSort(query: FeedQuery): PostSort {
  if (query.requestedSort !== undefined) {
    return query.requestedSort;
  }
  return query.term === undefined ? 'recent' : 'relevance';
}

/**
 * A short, readable echo of reader-supplied text for use inside a sentence.
 *
 * The term reaching this point can be up to {@link MAX_SEARCH_TERM_LENGTH} code points, and quoting
 * three sentences of it back inside an empty-state message reads as a malfunction. Overflow is not the
 * risk - `@/components/ui/alert` carries `wrap-anywhere`, so even one unbroken token wraps rather than
 * pushing the page sideways - so this is purely about the copy staying a sentence.
 *
 * Cut on a code-point boundary for the same reason as {@link readTerm}, and marked with an ellipsis so
 * a reader can see the value was shortened rather than mistyped.
 *
 * @param text - The reader-supplied text.
 * @returns The text, shortened and suffixed when it was too long to quote in full.
 */
function clipForDisplay(text: string): string {
  const codePoints = [...text];
  return codePoints.length > DISPLAY_TERM_MAX_LENGTH
    ? `${codePoints.slice(0, DISPLAY_TERM_MAX_LENGTH).join('')}\u2026`
    : text;
}

/**
 * The empty-state copy for this exact view.
 *
 * Three cases, because the envelope makes three genuinely different situations distinguishable and a
 * single message would misdescribe two of them:
 *
 * 1. **Ran off the end** - the window is empty but the collection is not. The page control is still
 *    rendered by `PostList` in this case, so the copy points at it.
 * 2. **Nothing matches the filters** - narrowed, and the collection really is empty. The copy names
 *    what was asked for and how to widen it, differing again by whether that was a term, a category,
 *    or both.
 * 3. **Nothing published at all** - not narrowed and nothing to show. The copy says so plainly rather
 *    than inviting the reader to adjust a filter that does not exist.
 *
 * @param query - The normalised query state.
 * @param total - The collection's unwindowed count, from the page envelope.
 * @returns The headline and supporting copy to hand to `PostList`.
 */
function emptyStateCopy(query: FeedQuery, total: number): { title: string; description: string } {
  if (total > 0) {
    return {
      title: `Nothing on page ${String(query.page)}`,
      description:
        'That page is past the end of these results. Use the page links below to go back, or start again from the first page.',
    };
  }

  if (query.term !== undefined && query.categorySlug !== undefined) {
    return {
      title: 'No posts match your search',
      description: `Nothing matches \u201C${clipForDisplay(query.term)}\u201D within that category. Try a different term, or clear the category filter to search everything.`,
    };
  }

  if (query.term !== undefined) {
    return {
      title: 'No posts match your search',
      description: `Nothing matches \u201C${clipForDisplay(query.term)}\u201D. Try a shorter or more general term, or clear the search to browse everything.`,
    };
  }

  if (query.categorySlug !== undefined) {
    return {
      title: 'No posts in this category',
      description:
        'Nothing has been published under this category yet. Clear the category filter to see every post.',
    };
  }

  return {
    title: 'No posts published yet',
    description:
      'This feed fills up as soon as the first post is published. Nothing is being hidden from you - there is simply nothing here yet.',
  };
}

/* -------------------------------------------------------------------------------------------------
 * Reads
 *
 * Two, and they fail differently on purpose. The feed IS this page, so a feed that cannot be read has
 * no page to degrade into and its failure propagates to `src/app/error.tsx`. The taxonomy is one
 * control on that page, so a taxonomy that cannot be read costs the reader a filter and nothing else -
 * failing the whole route over it would take the article feed, and with it the server-rendered content
 * the SEO requirement depends on, off the screen to hide a select element.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The complete category taxonomy, read once per request and never able to reject.
 *
 * **Wrapped in React's request-scoped memo**, which is what makes it safe for both
 * {@link generateMetadata} and {@link HomePage} to ask for it: the framework runs the two in the same
 * request, so the second call returns the first one's result and exactly one HTTP request is issued.
 * Without the memo the site's busiest route would read the taxonomy twice on every render to put a
 * category's name in a `<title>`.
 *
 * `GET /api/v1/categories` answers a **bare array** - the API's one sanctioned exception to the page
 * envelope, because this array *is* the filter control and a window there could hide the posts filed
 * under whatever fell outside it. There is no `items` member to read and no `pages` to follow.
 *
 * A failure is reported once to the server log and answered with an empty array. `CategoryFilter`
 * renders nothing at all for an empty array, so the degraded state is a page with no category filter
 * rather than a page with a dead control - and `buildFeedMetadata` treats a missing category as "less
 * specific", not as an error.
 *
 * @returns Every category, or an empty array when the taxonomy could not be read.
 */
const loadCategories = cache(async (): Promise<CategoryPublic[]> => {
  try {
    return await listCategories();
  } catch (cause) {
    const reason =
      cause instanceof Error ? `${cause.name}: ${cause.message}` : 'a non-Error value was thrown';
    console.error(
      `${LOG_PREFIX} Could not read the category taxonomy, so the feed is rendered without its ` +
        `category filter. The posts themselves are unaffected. Cause: ${reason}`,
    );
    return [];
  }
});

/**
 * The category a slug names, matched the way the database matches it.
 *
 * **Case-insensitively**, because `categories.slug` is a case-insensitive column and the feed's filter
 * is documented as matched that way: `?category=Engineering` really does return the Engineering posts,
 * so the metadata for that URL has to recognise the spelling too. Comparing with strict equality would
 * publish the generic site title over a page that was plainly filtered.
 *
 * @param categories - The taxonomy, as {@link loadCategories} returned it.
 * @param slug - The requested slug, or `undefined` when no category is filtered.
 * @returns The matching category, or `null` when none is requested or the slug matches nothing.
 */
function findCategory(
  categories: CategoryPublic[],
  slug: string | undefined,
): CategoryPublic | null {
  if (slug === undefined) {
    return null;
  }

  const folded = slug.toLowerCase();
  return categories.find((category) => category.slug.toLowerCase() === folded) ?? null;
}

/* -------------------------------------------------------------------------------------------------
 * Metadata
 * ---------------------------------------------------------------------------------------------- */

/**
 * Per-view metadata for the feed, including its canonical URL.
 *
 * The feed is the one route whose address varies with its own query state, which makes it the one route
 * where a hand-written canonical would most easily be wrong. So none of it is written here:
 * `buildFeedMetadata` in `@/lib/seo` owns the decision, `feedPath` beneath it decides which parameters
 * are part of the resource's identity, and this function's whole job is to hand over the normalised
 * state and the resolved category.
 *
 * Three properties of the result follow from that, and each one prevents a duplicate address for a
 * single result set:
 *
 * - **`page` is omitted when it is the first page**, so `/` and `/?page=1` do not compete. This is the
 *   same convention `hrefForPage` in `@/hooks/use-pagination` implements when it builds the page links,
 *   so the canonical and the links agree on one spelling of "page one".
 * - **`sort` is omitted when it is the default**, and the *requested* ordering is passed rather than the
 *   resolved one. This is the reason {@link FeedQuery} keeps the two apart: on `/?q=react` the request
 *   is ranked by relevance, but the canonical must stay `/?q=react` rather than becoming
 *   `/?q=react&sort=relevance`, which would be a second address for a page the reader can only reach
 *   at the first.
 * - **A blank parameter contributes nothing**, so `/?q=` canonicalises to `/`.
 * - **A resolved category is spelled the way the API spells it**, not the way the reader typed it. The
 *   slug column is case-insensitive, so `?category=engineering`, `?category=ENGINEERING` and
 *   `?category=EnGiNeErInG` all return the same 30 posts; echoing the reader's casing back would
 *   publish three canonical URLs for one result set, which is precisely what a canonical exists to
 *   prevent. It would also contradict `src/app/sitemap.ts`, which enumerates category feeds through
 *   `categoryFeedPath` and therefore always advertises `category.slug`. So the resolved slug wins, and
 *   an unresolved one falls back to what was asked because there is no better answer available.
 *
 * The resolved category is what upgrades a filtered feed from the site's default title and description
 * to the category's own - a category's `description` exists precisely to be the description of its
 * page. It costs no extra request: `loadCategories` is request-memoised and {@link HomePage} needs the
 * same array for the filter control. When the taxonomy could not be read, or the slug matches nothing,
 * the page keeps the root title and the site description, which is correct and merely less specific.
 *
 * No `openGraph.images` override, deliberately: the root metadata's default card and the generated
 * `opengraph-image.tsx` route already cover this route, and a third declaration would be a third thing
 * to keep in step.
 *
 * @param props - The route props. Only `searchParams` is read.
 * @returns The feed view's metadata.
 */
export async function generateMetadata({ searchParams }: HomePageProps): Promise<Metadata> {
  const query = readFeedQuery(await searchParams);
  const category = findCategory(await loadCategories(), query.categorySlug);

  return buildFeedMetadata(
    {
      q: query.term,
      // The canonical spelling when the slug resolved, the requested one otherwise. See the note above.
      category: category?.slug ?? query.categorySlug,
      page: query.page,
      // The requested ordering, NOT the effective one. See the note above.
      sort: query.requestedSort,
    },
    category,
  );
}

/* -------------------------------------------------------------------------------------------------
 * HomePage
 * ---------------------------------------------------------------------------------------------- */

/**
 * The home feed: recent published posts, with search, a category filter and pagination.
 *
 * Renders the page shell, the document's single `<h1>`, the two controls and the list. The list, its
 * one/two/three-column grid, its result range and its page control all belong to `PostList`; the search
 * term and the category slug belong to the two client islands, which write them into the URL and so
 * cause this component to re-render and re-fetch. Nothing on this screen holds state.
 *
 * ### Why both reads start together
 *
 * The posts and the taxonomy are independent, and this is the site's most requested route, so awaiting
 * them in sequence would add the taxonomy's whole round trip to time-to-first-byte for no reason.
 * `Promise.all` starts both and waits once.
 *
 * The failure asymmetry survives that: `loadCategories` catches its own failure and resolves to an empty
 * array, so it can never reject, which leaves `listPosts` as the only rejection `Promise.all` can
 * observe. A feed that cannot be read therefore propagates to `src/app/error.tsx` - correctly, because
 * there is no home page without the feed - while a taxonomy that cannot be read costs one control.
 *
 * ### Why the two islands are NOT wrapped in Suspense
 *
 * Both call `useSearchParams`, and both record a consumer requirement to be wrapped in a `<Suspense>`
 * boundary because "Next.js fails the build otherwise". That is true of a consumer the framework tries
 * to **prerender**, and it is not true here - so a boundary was written, measured, and then removed.
 *
 * This route can never be prerendered. It reads `searchParams` in both exported functions, which is an
 * unconditional dynamic signal, and it reads them because the feed's query state has to live in the URL
 * for any result set to be linkable, shareable and crawlable. The build agrees: it reports this route as
 * `ƒ` - server-rendered on demand - and `tsc --noEmit`, `eslint --max-warnings=0` and `next build` all
 * pass with no boundary and no `useSearchParams` complaint.
 *
 * Removing them is not a saving of two elements, it is what puts the controls in the initial HTML.
 * React streams a pending boundary's resolved content into a `<div hidden>` and reveals it with an
 * inline `$RC(...)` script, so a wrapped control is delivered *hidden*. Measured on this page, three
 * configurations of the delivered bytes:
 *
 * | Configuration                       | `<div hidden>` | pending boundaries | reveal scripts | controls inline |
 * | ----------------------------------- | -------------- | ------------------ | -------------- | --------------- |
 * | boundaries + `loading.tsx`          | 7              | 5                  | 6              | no              |
 * | no boundaries + `loading.tsx`       | 5              | 3                  | 4              | no              |
 * | no boundaries, no `loading.tsx`     | **1**          | **0**              | **0**          | **yes**         |
 *
 * The third row is this component's own output with nothing deferred at all, and reaching it is the
 * whole reason `CategoryFilter` takes its taxonomy as a prop instead of fetching: so the options are in
 * the server-rendered HTML. Wrapping it would have put those options in a hidden div and quietly
 * undone that.
 *
 * The remaining gap is not this file's to close. `src/app/loading.tsx` is the route-level Suspense
 * fallback the framework wires up by convention, and while it exists every byte of this page is
 * streamed inside its boundary - which is why rows one and two above are identical on the visible
 * outcome. The feed is still wholly present in the delivered HTML either way, and a reader with
 * scripting enabled sees it revealed during parsing, before hydration.
 *
 * ### Draft confidentiality
 *
 * Nothing here filters by lifecycle state and nothing asks for one. The public feed is published-only
 * for every caller - anonymous, reader, author and administrator alike - and that is enforced in
 * `backend/app/repositories/post_repository.py`. A second definition of the rule in this tier is how a
 * draft eventually leaks through one of them.
 *
 * @param props - The route props. Only `searchParams` is read.
 * @returns The rendered feed. Never `null`: an empty collection still renders its heading, its controls
 *   and `PostList`'s own empty panel.
 */
export default async function HomePage({ searchParams }: HomePageProps): Promise<JSX.Element> {
  const query = readFeedQuery(await searchParams);

  const [feed, categories] = await Promise.all([
    listPosts({
      q: query.term,
      category: query.categorySlug,
      sort: effectiveSort(query),
      page: query.page,
      page_size: FEED_PAGE_SIZE,
      // No `author`, no `mine` and no `status`. This is the public feed: the first belongs to the
      // profile route, and the other two switch the endpoint to the private author workspace.
    }),
    loadCategories(),
  ]);

  // Read from the envelope's own `total`, so the copy describes what the service actually found rather
  // than what this render asked for.
  const empty = emptyStateCopy(query, feed.total);

  return (
    <div className={SHELL_CLASSES}>
      <div className={INTRO_CLASSES}>
        {/*
         * The document's single `<h1>`. Neither `SiteHeader` nor `SiteFooter` emits a heading of any
         * level, so this is the only one, and `PostList`'s cards sit at level 2 directly beneath it.
         */}
        <h1 className={HEADING_CLASSES}>Latest posts</h1>
        <p className={TAGLINE_CLASSES}>
          Recent writing from across the community. Search the archive, or filter by category to
          narrow the list.
        </p>
      </div>

      <div className={CONTROLS_CLASSES}>
        {/*
         * `label` is set rather than defaulted, so this field and the banner's own search box do not
         * share one accessible name once both are visible from `lg`. See {@link SEARCH_LABEL}.
         */}
        <SearchInput className={SEARCH_PLACEMENT_CLASSES} label={SEARCH_LABEL} />

        {/*
         * The taxonomy is handed over as a prop rather than fetched by the control, so its options are
         * in the server-rendered HTML. An empty array - the degraded read - makes `CategoryFilter`
         * render nothing, which is why there is no condition around it here: the component owns that
         * decision, and duplicating it would give the toolbar a second opinion about whether a filter
         * exists.
         */}
        <CategoryFilter categories={categories} className={CATEGORY_PLACEMENT_CLASSES} />
      </div>

      {/*
       * The envelope is passed through unchanged - all five snake_case fields, nothing renamed and
       * nothing recomputed. `headingLevel` is stated rather than left to its default so this page's
       * outline is declared at the point that owns the `<h1>`, and `prioritizeFirstCover` opts the
       * first cover into an eager, high-priority load because on this route it is the Largest
       * Contentful Paint candidate.
       */}
      <PostList
        emptyDescription={empty.description}
        emptyTitle={empty.title}
        headingLevel={2}
        page={feed}
        prioritizeFirstCover
      />
    </div>
  );
}
