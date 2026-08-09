/**
 * The tier's single page arithmetic. Pure, URL-free, and importable from a Server Component.
 *
 * Three surfaces window results - the home feed, an author's profile, and all four administrative
 * tables - and AAP §0.1.3 lists "a uniform pagination contract" as a prerequisite precisely so they
 * cannot disagree. `@/hooks/use-pagination` was that single implementation, and it very nearly worked:
 * being a hook, it is only reachable from a client component, so `components/blog/post-list.tsx` - a
 * Server Component, deliberately, because the feed's rows must be in the initial HTML for the SEO
 * requirement - could not call it and grew its own private range calculation instead, while
 * `components/admin/data-table.tsx` grew a second copy of the range sentence. Two copies of one rule
 * is how "Showing 37-47 of 47 results" and "Showing 37-48 of 47 results" end up on two pages of the
 * same product.
 *
 * So the arithmetic lives here, with no `'use client'` directive and no import from `next/navigation`,
 * and both kinds of consumer reach it:
 *
 * - `@/hooks/use-pagination` derives from this and adds the URL concerns that genuinely need a client
 *   boundary - reading the current query, building each page's href, and imperative navigation.
 * - A Server Component calls {@link derivePagination} and {@link formatResultRange} directly.
 *
 * What this module will never contain: a hook, a React import, a `next/navigation` import, a fetch, a
 * class name. It takes numbers and returns numbers.
 *
 * @module
 */

import type { Page } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/** The first page of any collection, 1-based. Named so the arithmetic reads as intent. */
export const FIRST_PAGE = 1;

/**
 * How many pages are rendered either side of the current one in the bounded window.
 *
 * Exported because `@/components/ui/pagination` reasons about the window's width when it narrows the
 * control on a small viewport, and restating the number there would let the two drift.
 */
export const PAGE_WINDOW_SIBLING_COUNT = 1;

/**
 * Matches a bare run of ASCII digits, and nothing else.
 *
 * A `page` read from a URL is untrusted input, so it is tested against this before `Number` is allowed
 * near it. `Number` is far more permissive than a page number ought to be - it accepts `'0x2'` as 2,
 * `'1e3'` as 1000, `'+2'`, `'2.0'` and `''` (as `0`) - and none of those is a form any link in this
 * application produces. Surrounding whitespace is trimmed before the test rather than rejected by it,
 * so a hand-typed `?page=%202` still resolves to page 2: trimming cannot admit an invalid value,
 * because the pattern still has to match afterwards.
 */
const DIGITS_ONLY = /^\d+$/;

/** An en dash for a numeric range, escaped so this module stays ASCII-only like its siblings. */
const EN_DASH = '\u2013';

/* -------------------------------------------------------------------------------------------------
 * Untrusted-input guards
 *
 * Every number reaching this module is untrusted, and from two different directions: an envelope
 * field is typed `number` but a fixture or a partially-populated first render can carry `0`, a
 * negative, a fraction, `NaN` or an infinity; and a page read from a URL is a caller-typed string.
 * AAP §0.9.4.4 requires an out-of-range page to answer an empty window rather than an error, so every
 * guard here clamps or falls back and none throws.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Coerce a reported count into a non-negative integer that is safe to do arithmetic with.
 *
 * Applied to `total`, `page_size` and `pages` on the way in. Nothing this returns can be `NaN`,
 * `Infinity`, negative, fractional, or negative zero: `Math.max(0, ...)` resolves `-0` to `+0`, which
 * matters because `-0` stringifies as `"0"` but is not `0` under `Object.is` and would leak a phantom
 * difference into a memo comparison upstream.
 *
 * The upper bound is not decoration either. JavaScript switches to exponent notation when stringifying
 * at `1e21` and above, so a page count that large would put a literal `page=1e+21` into an href - a
 * parameter the service answers with `422`. Capping at the largest exactly representable integer keeps
 * every number derived here a plain run of digits.
 */
function toCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(0, Math.trunc(value)), Number.MAX_SAFE_INTEGER);
}

/**
 * Whether a number is a page position worth working with.
 *
 * `Number.isInteger` is the finite-and-integer test in one call: it is `false` for `NaN` and for both
 * infinities, so no comparison is ever performed against a value whose comparisons are all false. The
 * upper bound matters for the same reason as in {@link toCount}: a 21-digit path segment parses to a
 * finite, integral `1e21` that would sail past a naive `> 0` check and then poison every offset
 * derived from it.
 */
function isUsablePageNumber(value: number): boolean {
  return Number.isInteger(value) && value >= FIRST_PAGE && value <= Number.MAX_SAFE_INTEGER;
}

/**
 * Read a page number from a value that may be a number, a URL string, or neither.
 *
 * `Number('abc')` is `NaN` and every `NaN` comparison is false, so the check is explicit rather than
 * relational. A string is required to be digits only, which rejects `'1.5'`, `'1e3'`, `'-5'` and
 * `' 1 '`-with-padding-plus-junk in one rule.
 *
 * @param value - A candidate page: an envelope field, a search parameter, or `null`/`undefined`.
 * @returns The page, or `null` when the value cannot name one.
 */
export function toPageNumber(value: number | string | null | undefined): number | null {
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
 * The service's own `pages` is preferred over recomputing it, deliberately:
 * `backend/app/core/pagination.py` owns that arithmetic, and a client that re-derived it could round
 * differently and offer a page the service will not serve. A reported `0` is *accepted* rather than
 * repaired when the collection is genuinely empty, because that is the documented answer for
 * `total: 0`.
 *
 * The recomputation is a repair path for two situations the service cannot produce but a caller can: a
 * `pages` that did not survive as a usable number, and a `pages` of `0` alongside a non-zero `total`.
 * It sits behind the `windowSize > 0` guard, which is the only reason no division by zero is
 * reachable in this module.
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

/* -------------------------------------------------------------------------------------------------
 * Input and output shapes
 * ---------------------------------------------------------------------------------------------- */

/**
 * The facts about a result window that the arithmetic needs.
 *
 * Deliberately **derived from {@link Page}** with `Pick` rather than restated. The five wire names are
 * snake_case because there is no camelCase mapping layer anywhere in this tier, and a hand-typed copy
 * of `page_size` could be misspelled as `pageSize` in a way that compiles perfectly and reads
 * `undefined` at run time. Deriving the type makes that impossible: if the envelope's contract ever
 * moves, this stops compiling instead of quietly returning the wrong numbers.
 *
 * Every `Page<T>` is accepted with no cast - `Page<PostSummary>` from the feed, `Page<AdminUser>` and
 * `Page<AdminComment>` from the administrative tables, `Page<CommentPublic>` from a post's thread - and
 * so is a bare object of just the four numeric fields, which is what makes the arithmetic exercisable
 * without inventing rows to go with it.
 *
 * `items` is read for its **length only**, never for its contents, and only as a cross-check on
 * emptiness. Typing it as `readonly unknown[]` rather than generically keeps this free of a type
 * parameter it would otherwise have to thread through purely to ignore.
 */
export type PaginationSource = Pick<Page<unknown>, 'total' | 'page' | 'page_size' | 'pages'> & {
  readonly items?: readonly unknown[];
};

/** One page in the rendered window: a real destination, without the href a client adds. */
export interface PageWindowPageSlot {
  /** Discriminant. Switch on this rather than probing for the presence of a field. */
  readonly kind: 'page';
  /** The 1-based page this slot navigates to. Also the label a control should render. */
  readonly page: number;
  /** Whether this is the page currently on screen - render `aria-current="page"` when it is. */
  readonly isCurrent: boolean;
}

/**
 * A collapsed run of pages that the window omits.
 *
 * A typed sentinel rather than a magic string: a consumer switches on `kind` and never parses a label.
 * `side` distinguishes the two possible gaps - the run between the first page and the window
 * (`'start'`) and the run between the window and the last page (`'end'`) - which gives each slot a
 * stable, unique React key without anything having to mint one. A gap conveys no destination, so a
 * control renders it as inert, decorative text hidden from assistive technology.
 */
export interface PageWindowGapSlot {
  /** Discriminant. Switch on this rather than probing for the presence of a field. */
  readonly kind: 'gap';
  /** Which side of the current page the omitted run falls on. */
  readonly side: 'start' | 'end';
}

/** One entry in the bounded page window: a page, or a gap standing in for a run of omitted pages. */
export type PageWindowSlot = PageWindowPageSlot | PageWindowGapSlot;

/**
 * Everything derivable about a result window from the window alone - no URL, no navigation.
 *
 * `@/hooks/use-pagination` returns this plus the href and navigation members; a Server Component uses
 * it directly.
 */
export interface PaginationDerivation {
  /**
   * The page currently on screen, 1-based and always within `1 .. pages`.
   *
   * Taken from the envelope in preference to any other source, because the envelope is the page the
   * rows on screen actually belong to: mid-transition a URL may already name the next page while the
   * previous page's rows are still rendered, and describing the rows the reader can see is the honest
   * answer. A page beyond the end is clamped rather than rejected.
   */
  readonly page: number;
  /**
   * How many pages a control should offer, floored at `1`.
   *
   * The service reports `pages: 0` for an empty collection; this reads `1` there instead, so no
   * consumer has to reason about a zero-length page range. Guard on `isEmpty` (or on `pages <= 1`) to
   * render nothing - do not treat a `0` here as the empty signal, because it never appears.
   */
  readonly pages: number;
  /** The true page count, which IS `0` for an empty collection. Rarely needed; `pages` usually is. */
  readonly pageCount: number;
  /** Total matching rows, ignoring the window - the "of N" in a results label. `0` when empty. */
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
   * Whether the requested page was past the last one - a hand-edited or stale URL.
   *
   * `page` has already been clamped, so this is the only way to tell that the reader asked for
   * somewhere that does not exist. `false` for an empty collection, which is not an out-of-range
   * request but simply nothing to page through.
   */
  readonly isOutOfRange: boolean;
  /** Whether a previous page exists. `false` on page one and on an empty collection. */
  readonly hasPrevious: boolean;
  /** Whether a following page exists. `false` on the last page and on an empty collection. */
  readonly hasNext: boolean;
  /** 1-based index of the first row in this window, for a range label. `0` when empty. */
  readonly firstItem: number;
  /**
   * 1-based index of the last row in this window. On a partial final page this is `total`, never
   * `page * page_size`. `0` when empty.
   */
  readonly lastItem: number;
  /**
   * The bounded window to render: first page, current page and its siblings, last page, with a
   * {@link PageWindowGapSlot} standing in for each omitted run. Never longer than
   * `2 * PAGE_WINDOW_SIBLING_COUNT + 5` entries.
   */
  readonly pageWindow: readonly PageWindowSlot[];
}

/* -------------------------------------------------------------------------------------------------
 * The derivation
 * ---------------------------------------------------------------------------------------------- */

/**
 * Build the bounded window of pages to render.
 *
 * First page, the current page with its siblings, last page - and a sentinel for each run left out.
 * A run of exactly one page is rendered rather than elided: an ellipsis promises a run of hidden
 * pages, and standing in for a single one costs the same width while telling the reader less.
 */
function buildPageWindow(page: number, pages: number): readonly PageWindowSlot[] {
  const windowStart = Math.max(FIRST_PAGE, page - PAGE_WINDOW_SIBLING_COUNT);
  const windowEnd = Math.min(pages, page + PAGE_WINDOW_SIBLING_COUNT);

  // A Set drops the duplicates that arise when the window touches either end, and preserves insertion
  // order - which is already ascending here, because `FIRST_PAGE <= windowStart` and
  // `windowEnd <= pages` both hold by construction. No sort is therefore needed, and none is done.
  const numbers = new Set<number>([FIRST_PAGE]);
  for (let candidate = windowStart; candidate <= windowEnd; candidate += 1) {
    numbers.add(candidate);
  }
  numbers.add(pages);

  const pageSlot = (candidate: number): PageWindowPageSlot => ({
    kind: 'page',
    page: candidate,
    isCurrent: candidate === page,
  });

  const built: PageWindowSlot[] = [];
  let previous: number | null = null;

  for (const candidate of numbers) {
    if (previous !== null) {
      const omitted = candidate - previous - 1;

      if (omitted === 1) {
        built.push(pageSlot(previous + 1));
      } else if (omitted > 1) {
        // At most two runs are ever omitted - one below the window and one above it - which is why
        // the two sides are always distinct and each one makes a unique React key.
        built.push({ kind: 'gap', side: previous < page ? 'start' : 'end' });
      }
    }

    built.push(pageSlot(candidate));
    previous = candidate;
  }

  return built;
}

/**
 * Derive every page fact from one result window.
 *
 * Never throws. An empty collection, a zero window size, a fractional total and a page past the end
 * are all ordinary inputs with defined answers (AAP §0.9.4.4), and no returned field is ever `NaN`,
 * `Infinity` or `-0`.
 *
 * @param source - The result window: a whole `Page<T>`, or just its four numeric fields.
 * @param fallbackPage - The page to use when the envelope's own `page` did not survive as a usable
 *   number. `@/hooks/use-pagination` passes the page it read from the URL here; a Server Component
 *   usually omits it and gets page one.
 * @returns The derived facts, all clamped and coherent with one another.
 */
export function derivePagination(
  source: PaginationSource,
  fallbackPage?: number | string | null,
): PaginationDerivation {
  const total = toCount(source.total);
  const windowSize = toCount(source.page_size);

  // The true page count, which may legitimately be 0 for an empty collection...
  const pageCount = resolvePageCount(source.pages, total, windowSize);
  // ...and the count a control renders against, floored at one so no consumer has to handle a
  // zero-length range. `isEmpty` carries the "render nothing" signal instead.
  const pages = Math.max(pageCount, FIRST_PAGE);

  // The envelope's page wins: it is the page the rendered rows belong to, and it is already correct on
  // the first paint because it arrives with them. The fallback covers only the case where that value
  // did not survive as a usable number.
  const requestedPage = toPageNumber(source.page) ?? toPageNumber(fallbackPage) ?? FIRST_PAGE;

  // Clamped for display. The service echoes an out-of-range page back verbatim; a control that
  // highlighted page 99 of 3 would be describing a window that does not exist.
  const page = Math.min(requestedPage, pages);

  // An empty collection is not an out-of-range request - there is simply nothing to page through - so
  // this stays false when there are no pages at all.
  const isOutOfRange = pageCount > 0 && requestedPage > pageCount;

  // The observed row count is authoritative when the caller supplied rows, because it is what is on
  // screen; the two numeric paths agree on every real envelope, since the service returns an empty
  // `items` array in exactly those cases.
  const rowCount = source.items === undefined ? null : source.items.length;
  const isEmpty = rowCount === null ? total === 0 || isOutOfRange : rowCount === 0;

  // Rows before this window. `page` is at least 1 and `windowSize` at least 0, so this is a
  // non-negative finite integer for every input.
  const rowsBefore = (page - FIRST_PAGE) * windowSize;
  const firstItem = isEmpty ? 0 : Math.min(rowsBefore + 1, Math.max(total, 1));

  // The last index is capped at `total` rather than at `page * page_size`, which is what makes a range
  // label correct on a partial final page. When the caller supplied rows, their count is preferred:
  // it is the only source that stays right if a zeroed `page_size` is paired with real rows, which a
  // fixture can do even though the service cannot.
  const observedLast = rowCount === null ? 0 : rowsBefore + rowCount;
  const windowLast = rowCount === null ? rowsBefore + windowSize : observedLast;
  const lastItem = isEmpty
    ? 0
    : Math.max(firstItem, Math.min(windowLast, Math.max(total, firstItem)));

  return {
    page,
    pages,
    pageCount,
    total,
    isEmpty,
    isOutOfRange,
    hasPrevious: page > FIRST_PAGE,
    hasNext: page < pages,
    firstItem,
    lastItem,
    pageWindow: buildPageWindow(page, pages),
  };
}

/**
 * The one "Showing X-Y of N results" sentence in the product.
 *
 * Every windowed surface phrases its range identically because every windowed surface calls this: the
 * feed through `components/blog/post-list.tsx`, an author's profile through the same component, and
 * the four administrative tables through `components/admin/data-table.tsx`. It used to be written out
 * twice, once in each of those files, with a note in each acknowledging the duplication.
 *
 * `null` for an empty window, where a range would say nothing the empty panel beside it has not
 * already said - which is also why the caller does not have to guard before calling.
 *
 * @param derivation - The result of {@link derivePagination} for the window being labelled.
 * @returns The sentence, or `null` when there is nothing to summarise.
 */
export function formatResultRange(derivation: PaginationDerivation): string | null {
  if (derivation.isEmpty) {
    return null;
  }

  const { firstItem, lastItem, total } = derivation;

  return `Showing ${String(firstItem)}${EN_DASH}${String(lastItem)} of ${String(total)} ${
    total === 1 ? 'result' : 'results'
  }`;
}
