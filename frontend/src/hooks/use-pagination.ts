'use client';

import { useCallback, useMemo } from 'react';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { derivePagination, FIRST_PAGE, toPageNumber } from '@/lib/utils';
import type {
  PageWindowGapSlot,
  PageWindowPageSlot,
  PaginationDerivation,
  PaginationSource,
} from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * The arithmetic contract, re-exported so a consumer has one import
 *
 * Every number below is derived by the page-arithmetic section of `@/lib/utils`, which is deliberately
 * hook-free and directive-free: the same rules have to serve `components/blog/post-list.tsx`, a Server
 * Component that cannot call a hook at all. These re-exports exist so `@/components/ui/pagination` and
 * the administrative grid need not know which of the two modules a given member comes from.
 * ---------------------------------------------------------------------------------------------- */

export type { PaginationSource, PaginationDerivation } from '@/lib/utils';
export { formatResultRange, PAGE_WINDOW_SIBLING_COUNT } from '@/lib/utils';

/** A collapsed run of omitted pages. The pure module's sentinel, re-aliased for consumers. */
export type PaginationGapSlot = PageWindowGapSlot;

/**
 * One page in the rendered window, with the href an anchor needs.
 *
 * The page number and the current-page flag are the pure module's; the href is this hook's only
 * addition, and it is exactly why the two layers are split - a URL needs the *current* URL, which needs
 * a client boundary, while the window itself needs nothing but numbers.
 */
export interface PaginationPageSlot extends PageWindowPageSlot {
  /** Ready-to-use relative href, identical to `hrefForPage(page)`. */
  readonly href: string;
}

/** One entry in the bounded window: a page to link to, or a gap standing in for a run of pages. */
export type PaginationSlot = PaginationPageSlot | PaginationGapSlot;

/**
 * The URL half of the tier's single page arithmetic.
 *
 * Three list surfaces window their results identically — the home feed (AAP R3), an author's published
 * posts (R5) and all four administrative tables (R11) — because AAP §0.1.3 requires that they *"window
 * results identically or the client cannot share one pagination component"*. A second implementation of
 * any of it is therefore a defect, not a convenience: two can disagree, and the symptom is a control
 * that offers a page the service will not serve.
 *
 * **The arithmetic itself lives in `@/lib/utils`, not here.** This hook adds only what genuinely
 * needs a client boundary: reading the current query string, building each page's href from it, and
 * imperative navigation. The split exists because one of the three surfaces —
 * `components/blog/post-list.tsx` — is a Server Component, deliberately, so the feed's rows reach the
 * initial HTML for the SEO requirement; it cannot call a hook, and while these rules lived here it
 * necessarily grew its own copy of the range calculation. Now it calls the same pure function this hook
 * calls. That the arithmetic sits in `@/lib/utils` rather than in a module of its own is what AAP
 * §0.4.5.3's four-module `src/lib/` inventory prescribes; the property that matters to this file is
 * unchanged, because that module carries no `'use client'` directive either.
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

/**
 * Everything a page control needs, derived from one result window and the current URL.
 *
 * `page` and `pages` are two of the three props AAP §0.8.3 specifies for
 * `@/components/ui/pagination`; `hrefForPage` and {@link PaginationView.slots} are what let that
 * component be built from anchors rather than buttons, which is what §0.8.6 requires of it.
 *
 * The third specified prop, `onPageChange`, is deliberately **not** answered by
 * {@link PaginationView.goToPage}. Because every page is a real anchor, that component's callback
 * fires *in addition to* a navigation the link has already performed, so a navigator passed into it
 * would run twice. `goToPage` exists for affordances that are not anchors at all - see its own
 * documentation for the distinction and for what belongs in `onPageChange` instead.
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
   * Navigate to a page **imperatively**, for a caller that cannot render an anchor.
   *
   * Built on {@link PaginationView.hrefForPage}, so the URL it produces is byte-identical to the one the
   * equivalent anchor carries. Pushes rather than replaces - a page change is a destination a reader
   * should be able to come back from - and no-ops when the target is already the current URL, so a
   * redundant click cannot leave a history entry that makes the back button appear dead.
   *
   * **Do NOT pass this as the `onPageChange` prop of `@/components/ui/pagination`.** That was the
   * documented usage and it caused a double navigation: every page in that control is a real `<a href>`,
   * which navigates on its own, and `onPageChange` fires on the same click *in addition* to the
   * navigation - so a callback that also pushes produces two transitions and two history entries for one
   * click, and the reader's back button then appears to do nothing. `onPageChange` is for side effects
   * only (analytics, scroll restoration); the anchor is the navigation.
   *
   * The legitimate use for this is a surface with no anchor to click: a page-size control, a keyboard
   * shortcut, a form submission, or a jump-to-page input.
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
 *       <p>{formatResultRange(pagination)}</p>
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
  // rather than on `searchParams`, for two distinct reasons. The identity of the parameters object can
  // change between renders while the query is unchanged, so depending on the object would rebuild every
  // callback on every render and defeat the memoisation entirely. And a callback body that touched the
  // object would oblige the exhaustive-dependencies rule to demand the object as a dependency - the rule
  // is fatal here, so the shape of this line is what keeps the gate green.
  const search = searchParams.toString();

  // The URL's page is the FALLBACK, not the source: the envelope's own page is preferred because it is
  // the page the rendered rows belong to, and because `useSearchParams()` reads empty on a statically
  // rendered route until hydration.
  const urlPage = searchParams.get(PAGE_PARAM);

  // Destructured so the memo below depends on individual numbers rather than on `source`. A caller that
  // builds its argument inline gets a new object identity every render; depending on the numbers means
  // the memo still holds. `items` is reduced to a count for the same reason - the array's identity is
  // irrelevant here and would churn the dependency array, whereas its length is a primitive.
  const {
    total: reportedTotal,
    page: reportedPage,
    page_size: reportedPageSize,
    pages: reportedPages,
  } = source;
  const rowCount = source.items === undefined ? null : source.items.length;

  /*
   * ALL of the arithmetic, in one call to the module that owns it.
   *
   * Nothing about page counts, clamping, emptiness, out-of-range detection or the result range is
   * computed in this file any more, and that is the point of the split: `components/blog/post-list.tsx`
   * is a Server Component and cannot call a hook, so while these rules lived here it necessarily grew
   * its own copy of the range calculation, and the administrative grid grew a second copy of the range
   * sentence. One implementation, three consumers, no possibility of disagreement.
   */
  const derived = useMemo<PaginationDerivation>(
    () =>
      derivePagination(
        {
          total: reportedTotal,
          page: reportedPage,
          page_size: reportedPageSize,
          pages: reportedPages,
          ...(rowCount === null ? {} : { items: new Array<unknown>(rowCount) }),
        },
        urlPage,
      ),
    [reportedTotal, reportedPage, reportedPageSize, reportedPages, rowCount, urlPage],
  );

  const { page, pages, isEmpty, isOutOfRange, hasPrevious, hasNext, total, firstItem, lastItem } =
    derived;

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

  /*
   * The window is the pure module's; this only attaches an href to each page in it.
   *
   * Which is the whole division of labour in this file: `@/lib/utils` decides WHICH pages are
   * rendered, this decides WHERE each one points. A gap sentinel passes through untouched, because a gap
   * has no destination.
   */
  const slots = useMemo<readonly PaginationSlot[]>(
    () =>
      derived.pageWindow.map((slot) =>
        slot.kind === 'gap' ? slot : { ...slot, href: hrefForPage(slot.page) },
      ),
    [derived.pageWindow, hrefForPage],
  );

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
