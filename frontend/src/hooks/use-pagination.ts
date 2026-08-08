'use client';

import { useCallback, useMemo } from 'react';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import type { Page } from '@/lib/types';

/**
 * The presentation tier's single implementation of page arithmetic.
 *
 * Three list surfaces window their results through this one hook — the home feed (AAP R3), an
 * author's published posts (R5) and all four administrative tables (R11) — because AAP §0.1.3
 * requires that they *"window results identically or the client cannot share one pagination
 * component"*. A second implementation of any calculation below is therefore a defect, not a
 * convenience: two of them can disagree, and the symptom is a control that offers a page the
 * service will not serve.
 *
 * ## What this hook is, and what it deliberately is not
 *
 * It is a **pure derivation over one {@link Page} envelope plus the current URL**. It performs no
 * network access of any kind: no `fetch`, no `@/lib/api/*` wrapper, no query client. The caller
 * fetches — a Server Component during render, or a client island through the shared HTTP module —
 * and hands the resolved envelope in. That boundary is the frontend form of the plan's
 * layered-separation standard (AAP §0.10.1), and it is what lets this file be exercised with
 * nothing but four numbers.
 *
 * It holds **no state**. There is no `useState` and no `useEffect` here, and neither may be added.
 * AAP §0.6.5 is explicit: *"Query state lives in the URL. `q`, `category`, `page`, and `sort` are
 * search parameters, so every result set is linkable, shareable, crawlable, and correct under
 * browser back and forward navigation."* A hook that mirrored the page into local state would be a
 * second source of truth that the URL can contradict — and correct back/forward behaviour, which
 * is free when the page is derived, would then need an effect to sync it. Everything below is
 * derived on every render from values the caller already has.
 *
 * ## Two properties of the contract that drive every branch here
 *
 * `frontend/src/lib/types.ts` documents both, and the service guarantees both:
 *
 * 1. **An empty collection reports `pages: 0`, not `1`.** So a zero page count is a legitimate
 *    answer rather than a bug to repair, and {@link PaginationView.isEmpty} — not a page count of
 *    zero — is the signal that a control should render nothing.
 * 2. **A page beyond the last one is not an error.** The service echoes back whatever `page` was
 *    requested, returns an empty `items` array and raises nothing (AAP §0.9.4.4: *"an out-of-range
 *    page returns an empty item list rather than an error"*). This hook mirrors that: it clamps for
 *    display and reports {@link PaginationView.isOutOfRange}, and it never throws.
 *
 * ## The Suspense caveat, for whoever writes the consuming component
 *
 * `useSearchParams()` is a client-only hook, and on a **statically rendered** route it returns an
 * empty set of parameters until hydration completes. Two consequences, neither of which is solved
 * here — this note exists so they are solved in the right place:
 *
 * - A component calling this hook must sit inside a `<Suspense>` boundary, or the whole route opts
 *   out of static rendering.
 * - The Server Components that render a list (`src/app/page.tsx`, `src/app/u/[username]/page.tsx`)
 *   must read `searchParams` from **their own props** for the server render, and pass the resolved
 *   envelope down. That is also why {@link PaginationView.page} is taken from the envelope in
 *   preference to the URL: the envelope arrives as a prop and is correct on the very first paint,
 *   whereas the URL is momentarily empty on a static route.
 *
 * ## Governing standards
 *
 * No user-specified rules were provided for this project — `review_rules` reports exactly that, and
 * AAP §0.10.1 records the same. The binding constraints are therefore the plan's own enterprise
 * standards, and six of them govern this module: layered separation (no network access, and no
 * import from `@/components/*` — the arrow points component → hook and never back); pinned
 * dependencies (`react` and `next/navigation` are the entire third-party surface); explicit API
 * contracts ({@link PaginationSource} is *derived from* {@link Page}, so the five snake_case wire
 * names cannot drift and no camelCase mirror exists); accessibility as a floor (see
 * {@link PaginationView.hrefForPage}); configuration from the environment only (nothing here reads
 * an environment variable — an absolute canonical URL is `@/lib/seo`'s job, and pagination hrefs
 * are relative); and blocking quality gates (this file compiles under `tsc --noEmit` and lints at
 * `--max-warnings=0` with no suppression comment of any kind).
 *
 * @module
 */

/**
 * The one URL parameter this hook writes.
 *
 * `frontend/src/components/blog/search-input.tsx` declares the same key for the same reason and
 * *deletes* it whenever the search term changes: resetting to page one when a filter changes
 * belongs to the control that changed the filter, not here. This hook only ever moves between
 * pages of the result set it was given.
 */
const PAGE_PARAM = 'page';

/** The lowest page number that exists. Pages are 1-based across the whole product, never 0-based. */
const FIRST_PAGE = 1;

/**
 * How many pages are rendered either side of the current one before the window collapses into a
 * gap.
 *
 * `@/components/ui/pagination` renders one anchor per {@link PaginationSlot}, so the window has to
 * be bounded — a 500-page collection cannot become 500 links. With this value the slot list holds
 * at most `2 * PAGE_WINDOW_SIBLING_COUNT + 5` entries (first, a gap, the current page and its
 * siblings, a second gap, last), which is **7** today and stays legible at the narrowest verified
 * viewport of 375px.
 */
export const PAGE_WINDOW_SIBLING_COUNT = 1;

/**
 * Matches a bare run of ASCII digits, and nothing else.
 *
 * A `page` read from the URL is untrusted input, so it is tested against this before `Number` is
 * allowed near it. `Number` is far more permissive than a page number ought to be — it accepts
 * `'0x2'` as 2, `'1e3'` as 1000, `'+2'`, `'2.0'` and `''` (as `0`) — and none of those is a form any
 * link in this application produces. Surrounding whitespace is trimmed before the test rather than
 * rejected by it, so a hand-typed `?page=%202` still resolves to page 2: trimming cannot admit an
 * invalid value, because the pattern still has to match afterwards. Declared at module scope so the
 * expression is compiled once rather than on each parse.
 */
const DIGITS_ONLY = /^\d+$/;

/**
 * Coerce a reported count into a non-negative integer that is safe to do arithmetic with.
 *
 * Applied to `total`, `page_size` and `pages` on the way in. The service validates all three, so in
 * practice this is a no-op — but the envelope reaches this hook as plain JSON through a caller this
 * file cannot see, and one `NaN` propagating into a subtraction would put `NaN` on screen. Nothing
 * this function returns can be `NaN`, `Infinity`, negative, fractional, or negative zero:
 * `Math.max(0, …)` resolves `-0` to `+0`, which matters because `-0` stringifies as `"0"` but is
 * not `0` under `Object.is` and would leak a phantom difference into a memo comparison.
 *
 * The upper bound is not decoration either. JavaScript switches to exponent notation when
 * stringifying at `1e21` and above, so a page count that large would put a literal `page=1e+21` in
 * an href — a parameter the service answers with `422`. Capping at the largest exactly
 * representable integer keeps every number this module stringifies a plain run of digits.
 *
 * @param value - A count as it arrived from the service.
 * @returns The value truncated toward zero and confined to `0 .. Number.MAX_SAFE_INTEGER`; `0` when
 *   it is not a finite number.
 */
function toCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(0, Math.trunc(value)), Number.MAX_SAFE_INTEGER);
}

/**
 * Whether a number is a page position this hook is willing to work with.
 *
 * @param value - Candidate page number.
 * @returns `true` for an integer in `1 .. Number.MAX_SAFE_INTEGER`; `false` for everything else,
 *   `NaN` and both infinities included.
 */
function isUsablePageNumber(value: number): boolean {
  return Number.isInteger(value) && value >= FIRST_PAGE && value <= Number.MAX_SAFE_INTEGER;
}

/**
 * Coerce an untrusted page position into a usable 1-based page number, or reject it outright.
 *
 * Rejection is reported as `null` rather than repaired to a default, so each call site can choose
 * its own fallback — which is what lets {@link usePagination} prefer the envelope's page and fall
 * back to the URL's, rather than having the two collapse into one another.
 *
 * `Number.isInteger` is the finite-and-integer test in a single call: it is `false` for `NaN` and
 * for both infinities, so no comparison is ever performed against a value whose comparisons are all
 * false. The upper bound matters for the same reason: a 21-digit path segment parses to a finite,
 * integral `1e21` that would sail past a naive `> 0` check and then poison every offset derived
 * from it.
 *
 * @param value - A page position from the envelope (a `number`) or from the URL (a `string`, or
 *   `null` when the parameter is absent).
 * @returns The page number when it is an integer in `1 .. Number.MAX_SAFE_INTEGER`, else `null`.
 */
function toPageNumber(value: number | string | null | undefined): number | null {
  if (typeof value === 'number') {
    return isUsablePageNumber(value) ? value : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!DIGITS_ONLY.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);

  return isUsablePageNumber(parsed) ? parsed : null;
}

/**
 * Resolve how many pages the collection actually occupies.
 *
 * The service's own `pages` is preferred over recomputing it, deliberately: `backend/app/core/
 * pagination.py` owns that arithmetic, and a client that re-derived it could round differently and
 * offer a page the service will not serve. A reported `0` is *accepted* rather than repaired when
 * the collection is genuinely empty, because that is the documented answer for `total: 0`.
 *
 * The recomputation is a repair path for two situations the service cannot produce but a caller
 * can: a `pages` that did not survive as a usable number, and a `pages` of `0` alongside a non-zero
 * `total`. It sits behind the `windowSize > 0` guard, which is the only reason no division by zero
 * is reachable in this module.
 *
 * @param reportedPages - The envelope's `pages`, unsanitised.
 * @param total - The already-sanitised total row count.
 * @param windowSize - The already-sanitised `page_size`.
 * @returns A non-negative page count; `0` only when the collection is empty or its window size is
 *   unusable.
 */
function resolvePageCount(reportedPages: number, total: number, windowSize: number): number {
  const reported = toCount(reportedPages);
  if (reported > 0) {
    return reported;
  }

  if (total === 0 || windowSize <= 0) {
    return 0;
  }

  return Math.ceil(total / windowSize);
}

/**
 * The facts about a result window that this hook needs in order to derive a page control.
 *
 * Deliberately **derived from {@link Page}** with `Pick` rather than restated. The five wire names
 * are snake_case because there is no camelCase mapping layer anywhere in this tier, and a hand-typed
 * copy of `page_size` could be misspelled as `pageSize` in a way that compiles perfectly and reads
 * `undefined` at run time. Deriving the type makes that impossible: if the envelope's contract ever
 * moves, this stops compiling instead of quietly returning the wrong numbers.
 *
 * Every `Page<T>` is accepted with no cast — `Page<PostSummary>` from the feed, `Page<AdminUser>`
 * and `Page<AdminComment>` from the administrative tables, `Page<CommentPublic>` from a post's
 * thread — and so is a bare object of just the four numeric fields, which is what makes the
 * arithmetic exercisable without inventing rows to go with it.
 *
 * `items` is read for its **length only**, never for its contents, and only as a cross-check on
 * emptiness (see {@link PaginationView.isEmpty}). Typing it as `readonly unknown[]` rather than
 * generically is what keeps this hook free of a type parameter it would otherwise have to thread
 * through purely to ignore.
 */
export type PaginationSource = Pick<Page<unknown>, 'total' | 'page' | 'page_size' | 'pages'> & {
  readonly items?: readonly unknown[];
};

/** One page in the rendered window: a real destination, with the href an anchor needs. */
export interface PaginationPageSlot {
  /** Discriminant. Switch on this rather than probing for the presence of a field. */
  readonly kind: 'page';
  /** The 1-based page this slot navigates to. Also the label a control should render. */
  readonly page: number;
  /** Ready-to-use relative href, identical to `hrefForPage(page)`. */
  readonly href: string;
  /** Whether this is the page currently on screen — render `aria-current="page"` when it is. */
  readonly isCurrent: boolean;
}

/**
 * A collapsed run of pages that the window omits.
 *
 * A typed sentinel rather than a magic string: a consumer switches on `kind` and never parses a
 * label. `side` distinguishes the two possible gaps — the run between the first page and the window
 * (`'start'`) and the run between the window and the last page (`'end'`) — which gives each slot a
 * stable, unique React key without the hook having to mint one. A gap conveys no destination, so a
 * control should render it as inert, decorative text hidden from assistive technology.
 */
export interface PaginationGapSlot {
  /** Discriminant. Switch on this rather than probing for the presence of a field. */
  readonly kind: 'gap';
  /** Which side of the current page the omitted run falls on. */
  readonly side: 'start' | 'end';
}

/**
 * One entry in the bounded page window: either a page to link to, or a gap standing in for a run of
 * pages the window left out.
 */
export type PaginationSlot = PaginationPageSlot | PaginationGapSlot;

/**
 * Everything a page control needs, derived from one result window and the current URL.
 *
 * `page`, `pages` and `goToPage` are the three props AAP §0.8.3 specifies for
 * `@/components/ui/pagination`; `hrefForPage` and {@link PaginationView.slots} are what let that
 * component be built from anchors rather than buttons.
 */
export interface PaginationView {
  /**
   * The page currently on screen, 1-based and always within `1 .. pages`.
   *
   * Taken from the envelope in preference to the URL, because the envelope is the page the rows on
   * screen actually belong to: mid-transition the URL may already name the next page while the
   * previous page's rows are still rendered, and highlighting the rows the reader can see is the
   * honest answer. A page beyond the end is clamped to the last page rather than rejected.
   */
  readonly page: number;
  /**
   * How many pages the control should offer, floored at `1`.
   *
   * The service reports `pages: 0` for an empty collection; this field reads `1` there instead, so
   * no consumer has to reason about a zero-length page range. Guard on `isEmpty` (or on
   * `pages <= 1`) to render nothing at all — do not treat a `0` here as the empty signal, because
   * it never appears.
   */
  readonly pages: number;
  /** Total matching rows, ignoring the window — the "of N" in a results label. `0` when empty. */
  readonly total: number;
  /**
   * Whether this window has no rows to render.
   *
   * True in both of the ways the service produces an empty window: the collection is empty, or the
   * requested page ran off the end of it. Taken from `items.length` when `items` was supplied, and
   * inferred from `total` and `isOutOfRange` when only the numeric facts were.
   */
  readonly isEmpty: boolean;
  /**
   * Whether the requested page was past the last one — a hand-edited or stale URL.
   *
   * `page` has already been clamped, so this is the only way to tell that the reader asked for
   * somewhere that does not exist. It is `false` for an empty collection, which is not an
   * out-of-range request but simply nothing to page through.
   */
  readonly isOutOfRange: boolean;
  /** Whether a previous page exists. `false` on page one and on an empty collection. */
  readonly hasPrevious: boolean;
  /** Whether a following page exists. `false` on the last page and on an empty collection. */
  readonly hasNext: boolean;
  /** Href of the previous page, or `null` when there is none — render inert markup for `null`. */
  readonly previousHref: string | null;
  /** Href of the next page, or `null` when there is none — render inert markup for `null`. */
  readonly nextHref: string | null;
  /**
   * 1-based index of the first row in this window, for a "showing X–Y of Z" label. `0` when empty.
   */
  readonly firstItem: number;
  /**
   * 1-based index of the last row in this window. On a partial final page this is `total`, never
   * `page * page_size`. `0` when empty.
   */
  readonly lastItem: number;
  /**
   * The bounded window to render: first page, current page and its siblings, last page, with a
   * {@link PaginationGapSlot} standing in for each omitted run. Never longer than
   * `2 * PAGE_WINDOW_SIBLING_COUNT + 5` entries.
   */
  readonly slots: readonly PaginationSlot[];
  /**
   * Build the relative href for a page, preserving every other search parameter on the current URL.
   *
   * This is why the hook exists in this shape rather than exposing a click handler alone. AAP §0.8.3
   * specifies `@/components/ui/pagination` as *"authored over `<nav>` with anchor-based links so
   * pages remain crawlable"*: an `<a href>` is keyboard-operable, middle-clickable and indexable,
   * where a `<button onClick>` is none of those and would silently cost the product its basic-SEO
   * requirement (R9).
   *
   * Three guarantees:
   *
   * - **Other parameters survive.** `q`, `category`, `sort` and anything else a surface has put in
   *   the URL come through untouched, so paginating never drops the reader's search or filter.
   * - **Page one carries no `page` parameter.** Its canonical URL is `/`, not `/?page=1`; emitting
   *   the parameter would mint a second URL for identical content and break the single-canonical-URL
   *   guarantee in AAP §0.9.4.5. Empty-valued parameters are dropped for the same reason, so `?q=`
   *   never appears.
   * - **The target is clamped**, so no consumer can construct a URL past the last page or below the
   *   first, whatever number it passes.
   *
   * @param page - Target page. Anything unusable — `0`, negative, fractional, `NaN` — is treated as
   *   page one; anything past the end is clamped to the last page.
   * @returns A relative href: `pathname`, or `pathname?query` when parameters remain.
   */
  readonly hrefForPage: (page: number) => string;
  /**
   * Navigate to a page, for the client islands where a handler is the natural affordance.
   *
   * Built on {@link PaginationView.hrefForPage}, so the URL it produces is byte-identical to the one
   * the equivalent anchor carries. Pushes rather than replaces — a page change is a destination a
   * reader should be able to come back from — and no-ops when the target is already the current URL,
   * so a redundant click cannot leave a history entry that makes the back button appear dead.
   *
   * Pass it straight through as the `onPageChange` prop of `@/components/ui/pagination`.
   *
   * @param page - Target page, clamped exactly as `hrefForPage` clamps it.
   */
  readonly goToPage: (page: number) => void;
}

/**
 * Derive a complete page control from one result window and the current URL.
 *
 * Signature: `usePagination(source: PaginationSource): PaginationView`
 *
 * The caller fetches; this hook does the arithmetic and builds the links. It reads the URL for the
 * parameters it must preserve and writes only `page`, holds no state, runs no effect, and never
 * throws — an empty collection, a zero window size and a page past the end are all ordinary inputs
 * with defined answers rather than error conditions (AAP §0.9.4.4).
 *
 * Every returned function is memoised and the returned object is memoised, so a consumer can pass
 * the whole view down or spread it into props without re-rendering on each parent render. The memos
 * key on **primitive** values only — the query string rather than the parameters object, and the
 * envelope's individual numbers rather than the envelope — which keeps them effective even when the
 * caller constructs its argument inline, and keeps the parameters object out of every dependency
 * array where its shifting identity would otherwise force a recompute on every render.
 *
 * @param source - The resolved {@link Page} envelope, or just its four numeric fields.
 * @returns A {@link PaginationView}: the current position, the counts, the navigation flags and
 *   hrefs, the display range, the bounded page window and the two navigation functions.
 *
 * @example
 * ```tsx
 * 'use client';
 *
 * export function PostList({ page }: { page: Page<PostSummary> }) {
 *   const pagination = usePagination(page);
 *
 *   if (pagination.isEmpty) {
 *     return <EmptyState />;
 *   }
 *
 *   return (
 *     <>
 *       <ul>{page.items.map((post) => <PostCard key={post.id} post={post} />)}</ul>
 *       <p>
 *         Showing {pagination.firstItem}–{pagination.lastItem} of {pagination.total}
 *       </p>
 *       {pagination.pages > 1 ? <Pagination {...pagination} /> : null}
 *     </>
 *   );
 * }
 * ```
 */
export function usePagination(source: PaginationSource): PaginationView {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // A primitive snapshot of the query string, taken once per render. Every memo below keys on THIS
  // rather than on `searchParams`, for two distinct reasons. The identity of the parameters object
  // can change between renders while the query is unchanged, so depending on the object would
  // rebuild every callback on every render and defeat the memoisation entirely. And a callback body
  // that touched the object would oblige the exhaustive-dependencies rule to demand the object as a
  // dependency — the rule is fatal here, so the shape of this line is what keeps the gate green.
  const search = searchParams.toString();

  // Destructured so the memos below can depend on individual numbers instead of on `source`. A
  // caller that builds its argument inline gets a new object identity every render; depending on
  // the numbers means the memos still hold.
  const {
    total: reportedTotal,
    page: reportedPage,
    page_size: reportedPageSize,
    pages: reportedPages,
  } = source;

  // `items` is reduced to a count immediately: the array's identity is irrelevant here and would
  // churn the dependency arrays, whereas its length is a primitive. `null` records "the caller
  // supplied only the numeric facts", which is a different statement from "the window is empty".
  const rowCount = source.items === undefined ? null : source.items.length;

  const total = toCount(reportedTotal);
  const windowSize = toCount(reportedPageSize);

  // The true page count, which may legitimately be 0 for an empty collection...
  const pageCount = resolvePageCount(reportedPages, total, windowSize);

  // ...and the count a control renders against, floored at one so no consumer has to handle a
  // zero-length range. `isEmpty` carries the "render nothing" signal instead.
  const pages = Math.max(pageCount, FIRST_PAGE);

  // The envelope's page wins over the URL's. It is the page the rendered rows belong to, it arrives
  // as a prop so it is already correct on the first paint, and it is immune to `useSearchParams()`
  // reading empty on a statically rendered route before hydration. The URL is the fallback for the
  // case where the envelope's own value did not survive as a usable number, and both go through the
  // same untrusted-input guard: absent, `'abc'`, `'1.5'`, `'0'` and `'-5'` all resolve to page one.
  const requestedPage =
    toPageNumber(reportedPage) ?? toPageNumber(searchParams.get(PAGE_PARAM)) ?? FIRST_PAGE;

  // Clamped for display. The service echoes an out-of-range page back verbatim; a control that
  // highlighted page 99 of 3 would be describing a window that does not exist.
  const page = Math.min(requestedPage, pages);

  // An empty collection is not an out-of-range request - there is simply nothing to page through -
  // so this stays false when there are no pages at all.
  const isOutOfRange = pageCount > 0 && requestedPage > pageCount;

  // Prefer the observed row count when the caller supplied rows; fall back to the two ways the
  // service produces an empty window. The two paths agree on every real envelope, because the
  // service returns an empty `items` array in exactly those cases.
  const isEmpty = rowCount === null ? total === 0 || isOutOfRange : rowCount === 0;

  const hasPrevious = page > FIRST_PAGE;
  const hasNext = page < pages;

  // Rows before this window. `page` is at least 1 and `windowSize` at least 0, so this is a
  // non-negative finite integer for every input, and `Math.min` below keeps the labels inside the
  // collection even when the two disagree.
  const rowsBefore = (page - FIRST_PAGE) * windowSize;
  const firstItem = isEmpty ? 0 : Math.min(rowsBefore + 1, total);
  // Capped at `total` rather than `page * page_size`, which is what makes the label correct on a
  // partial final page. The outer `Math.max` keeps the range coherent if a caller ever pairs a
  // window size of zero with a non-empty collection, which the service cannot produce.
  const lastItem = isEmpty ? 0 : Math.max(firstItem, Math.min(rowsBefore + windowSize, total));

  const hrefForPage = useCallback(
    (targetPage: number): string => {
      const clamped = Math.min(toPageNumber(targetPage) ?? FIRST_PAGE, pages);

      // Rebuilt from filtered entries rather than mutating a copy, for two reasons. `delete(key)`
      // removes *every* entry for a key, so dropping an empty `q` would also drop a real one in a
      // `?q=&q=fastapi` pair. And appending preserves repeated keys, which a surface is free to use.
      // Note the source is a fresh, mutable `URLSearchParams` built from the snapshot string: the
      // object `useSearchParams()` returns is read-only and throws on mutation.
      const nextParams = new URLSearchParams();
      for (const [key, value] of new URLSearchParams(search)) {
        if (key === PAGE_PARAM) {
          // Rewritten below from the clamped target, so any incoming value is discarded here.
          continue;
        }
        if (value === '') {
          // An empty value carries no filter and would mint a second URL for identical content.
          continue;
        }
        nextParams.append(key, value);
      }

      // Page one is addressed by the bare path. Emitting `page=1` would give it a second URL and
      // contradict the canonical-URL guarantee the SEO work depends on.
      if (clamped > FIRST_PAGE) {
        nextParams.set(PAGE_PARAM, String(clamped));
      }

      const query = nextParams.toString();

      return query ? `${pathname}?${query}` : pathname;
    },
    [pages, pathname, search],
  );

  const goToPage = useCallback(
    (targetPage: number): void => {
      const nextHref = hrefForPage(targetPage);

      // Compared against the URL as it actually stands, not against the canonical href of the
      // current page: a stale `?page=99` must still navigate when the reader clicks page 3, even
      // though 99 and 3 both clamp to the same place.
      const currentHref = search ? `${pathname}?${search}` : pathname;
      if (nextHref === currentHref) {
        return;
      }

      // `push`, not `replace`: each page is a destination in its own right, so back and forward
      // move between pages. Nothing else is needed to make that correct, because the page is
      // derived from what the navigation itself produces rather than mirrored into local state.
      router.push(nextHref);
    },
    [hrefForPage, pathname, router, search],
  );

  const slots = useMemo<readonly PaginationSlot[]>(() => {
    const windowStart = Math.max(FIRST_PAGE, page - PAGE_WINDOW_SIBLING_COUNT);
    const windowEnd = Math.min(pages, page + PAGE_WINDOW_SIBLING_COUNT);

    // The first page, the window, and the last page. A Set drops the duplicates that arise when the
    // window touches either end, and preserves insertion order - which is already ascending here,
    // because `FIRST_PAGE <= windowStart` and `windowEnd <= pages` both hold by construction. No
    // sort is therefore needed, and none is performed.
    const numbers = new Set<number>([FIRST_PAGE]);
    for (let candidate = windowStart; candidate <= windowEnd; candidate += 1) {
      numbers.add(candidate);
    }
    numbers.add(pages);

    const pageSlot = (candidate: number): PaginationPageSlot => ({
      kind: 'page',
      page: candidate,
      href: hrefForPage(candidate),
      isCurrent: candidate === page,
    });

    const built: PaginationSlot[] = [];
    let previous: number | null = null;

    for (const candidate of numbers) {
      if (previous !== null) {
        const omitted = candidate - previous - 1;

        if (omitted === 1) {
          // Exactly one page would be hidden. Render it instead: an ellipsis promises a run of
          // omitted pages, and standing in for a single one costs the same width while telling the
          // reader less.
          built.push(pageSlot(previous + 1));
        } else if (omitted > 1) {
          // A genuine run was left out, so it gets the sentinel. There are at most two such runs -
          // one below the window and one above it - which is why the two sides are always distinct
          // and each one makes a unique React key.
          built.push({ kind: 'gap', side: previous < page ? 'start' : 'end' });
        }
      }

      built.push(pageSlot(candidate));
      previous = candidate;
    }

    return built;
  }, [hrefForPage, page, pages]);

  return useMemo<PaginationView>(
    () => ({
      page,
      pages,
      total,
      isEmpty,
      isOutOfRange,
      hasPrevious,
      hasNext,
      previousHref: hasPrevious ? hrefForPage(page - 1) : null,
      nextHref: hasNext ? hrefForPage(page + 1) : null,
      firstItem,
      lastItem,
      slots,
      hrefForPage,
      goToPage,
    }),
    [
      firstItem,
      goToPage,
      hasNext,
      hasPrevious,
      hrefForPage,
      isEmpty,
      isOutOfRange,
      lastItem,
      page,
      pages,
      slots,
      total,
    ],
  );
}
