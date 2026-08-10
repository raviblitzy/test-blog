// Component test - `src/components/blog/post-list.tsx`, the windowed grid three surfaces share.
//
// The home feed (`src/app/page.tsx`), an author's public profile (`src/app/u/[username]/page.tsx`)
// and the author workspace all hand this component ONE `Page<PostSummary>` envelope and get back the
// same layout. That is the whole reason it exists, and it is the reason this file is worth having:
// the envelope is the uniform pagination contract, so a drift in it breaks three screens at once and
// this is the cheapest place in the product to catch that.
//
// ---------------------------------------------------------------------------
// 1. THE ENVELOPE IS TYPED AS THE REAL GENERIC, WHICH IS THIS FILE'S MAIN JOB
//
// {@link makePage} returns `Page<PostSummary>` - the actual exported type, reached through a
// TYPE-ONLY import, with no cast, no local restatement and no camelCase adaptation. `@/lib/types`
// documents the envelope as EXACTLY five snake_case fields (`items`, `total`, `page`, `page_size`,
// `pages`) mirroring `backend/app/core/pagination.py`, and there is no adaptation layer anywhere in
// this tier. So a renamed, added or removed field fails `tsc --noEmit` on these fixtures rather than
// surfacing as an undefined page count in a browser.
//
// `Page<T>.items` is the uniform collection field every paged endpoint in this product returns and is
// correct here. It has nothing to do with the retired demonstration resource that happened to share
// the name: that route, its model and its three-field shape appear nowhere in this file.
//
// ---------------------------------------------------------------------------
// 2. EVERY ASSERTION IS A ROLE, A NAME OR A NUMBER. NOT ONE IS A CLASS.
//
// There is no `toHaveClass`, no `className` read, no class-based `querySelector`, no
// `getComputedStyle` and no snapshot below, because the presentation is entirely token-derived and a
// class assertion would pin the token layer's spelling rather than the component's behaviour.
//
// The sharpest case is the GRID, and it is deliberately not tested here. This component is the single
// owner of the one/two/three-column geometry - one column below 48rem, two from 48rem, three from
// 64rem - which makes it the most tempting file in the suite to reach into the class string for. It
// would prove nothing: jsdom applies no media query and computes no layout, so a passing class
// assertion would say only that a string is present, and it would keep saying so after the layout
// broke. Column counts are verified where a real engine resolves them, in
// `tests/e2e/home-feed.spec.ts` at the 375, 768 and 1440px projects. What this file asserts instead
// is HOW MANY cards render and IN WHAT ORDER - facts the grid cannot supply and the envelope can.
//
// For the same reason there is no `matchMedia` manipulation and no width stubbing here. The
// `matchMedia` stub in `vitest.setup.ts` exists so theme-aware components can mount; it is not an
// invitation to fake a breakpoint.
//
// ---------------------------------------------------------------------------
// 3. THE LIVE-REGION ASSERTIONS, AND WHY THE EMPTY STATE IS SILENT
//
// This component authors ARIA in exactly ONE place: the loading branch, which wraps its run of
// placeholders in a single `role="status"` region named "Loading posts". The placeholders themselves
// are `aria-hidden` and carry no role, so that one region is the whole announcement - which is why
// the loading case below asserts the region by ROLE AND NAME and then asserts that no `article` is
// reachable at all.
//
// The empty branch authors NOTHING, and verifying that delegation is the point of the empty cases.
// `@/components/ui/alert` DERIVES the live-region role from the variant, and its `ALERT_ROLES` table
// maps `destructive` to `alert`, `success` and `warning` to `status`, and `info` and `empty` to
// `undefined`. So `<Alert variant="empty">` renders a plain container with NO role, and the tests
// below assert that BOTH `status` and `alert` are absent for an empty window.
//
// That is not a gap. An empty panel is present in the very first HTML the server sends, so a live
// region would make every page load announce "no posts found" unprompted, out of document order,
// ahead of the heading and the search field that would let the visitor act on it. The primitive
// documents this, and note 4 of `post-list.tsx` documents choosing it. Discoverability is preserved a
// different way, and that IS asserted: the empty headline renders as a HEADING at the same level the
// cards would have used, so it sits in the document outline exactly where the results would have
// been. A consumer that genuinely needs the announcement - the administrative grid, whose panel
// appears in an already-loaded screen in response to a filter change - opts in by passing `role`
// itself, which is the primitive's documented escape hatch and is not this component's case.
//
// ---------------------------------------------------------------------------
// 4. NO ENDPOINT IS MOCKED, AND THE ABSENCE OF HTTP IS ASSERTED RATHER THAN ASSUMED
//
// `PostList` performs no HTTP. The route that renders it fetches through `@/lib/api/posts` and hands
// the already-fetched envelope in as a prop, which is what keeps data access out of the presentation
// layer. So there is no request handler here and no `setupServer`: mocking an endpoint for this
// component would document a dependency it does not have.
//
// Silence is easy to pass by accident, so {@link postListHttpBehaviour} spies on `fetch` and asserts
// it was never called, and asserts that no router navigation was performed either. The page links are
// real anchors - navigation IS the anchor - so a `router.push` during render would mean the control
// had grown a handler that duplicates it.
//
// ---------------------------------------------------------------------------
// 5. WHY `next/navigation` IS MOCKED AND NOTHING ELSE IS
//
// `PostList` is directive-free so the feed reaches the initial HTML, but the page control it renders
// is a `'use client'` island that reads the URL through `usePagination` - `usePathname`,
// `useSearchParams` and `useRouter`, all three. Outside the App Router there is no context to read,
// so those three are replaced with a fixed pathname, a real `URLSearchParams` and a router of spies.
// Everything else renders for real: `next/link` emits genuine `<a href>` elements in this
// environment, and no cover image is fetched because every fixture carries `cover_image_url: null` -
// so `next/image` never enters the tree and its host allow-list is never consulted. Author fixtures
// carry `avatar_url: null` for the same reason, which keeps the avatar primitive on its text fallback
// (the whole avatar composition is `aria-hidden` regardless).
//
// ---------------------------------------------------------------------------
// 6. DELIBERATELY ABSENT. PLEASE DO NOT ADD.
//
//   1. A class, style, computed-style, snapshot or grid assertion of any kind. See note 2.
//   2. A `matchMedia` override, a viewport width stub or any other simulated breakpoint. See note 2.
//   3. A request handler, `setupServer`, or any import from `tests/msw/`. See note 4.
//   4. An import of `@testing-library/jest-dom` - `vitest.setup.ts` already registers the matchers -
//      or a call to `cleanup`, which the same file already runs after every test.
//   5. `.only` or `.skip` on any block, and `any` anywhere. The lint gate runs at
//      `--max-warnings=0` and the type gate runs under `strict` with `noUncheckedIndexedAccess`.
//   6. A cast on a fixture. If a fixture stops satisfying `Page<PostSummary>` that is the finding,
//      not an inconvenience to silence. See note 1.
//   7. An integer identifier. Every `id` below is a UUID-shaped string, because identity in this
//      product is generated by the database and never chosen by a client.
//   8. `userEvent`, or any interaction at all. Nothing here is interactive: the cards are links and
//      the page control is links. Clicking an anchor is a navigation, which belongs to the
//      end-to-end suite.
//   9. A coverage threshold. The enforced floor in this product is the backend's.

import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { PostList } from '@/components/blog/post-list';
import type { CategorySummary, Page, PostSummary, UserPublic } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * App Router harness
 *
 * Hoisted, because `vi.mock` factories are lifted above the imports and would otherwise close over a
 * binding that is still uninitialised when the mocked module is first evaluated. `vi.hoisted` is the
 * supported way to put mutable state where a factory can reach it.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The navigation context every render below sees.
 *
 * A fixed pathname, an empty but REAL `URLSearchParams` - `usePagination` calls both `.get()` and
 * `.toString()` on it, so a bare object would not do - and a router whose every method is a spy.
 *
 * The router exists because the hook resolves one, not because anything here should use it: the page
 * control is built from anchors, so `push` and `replace` must stay untouched. {@link
 * postListHttpBehaviour} asserts exactly that.
 */
const navigationContext = vi.hoisted(() => ({
  pathname: '/',
  searchParams: new URLSearchParams(),
  router: {
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  usePathname: (): string => navigationContext.pathname,
  useSearchParams: (): URLSearchParams => navigationContext.searchParams,
  useRouter: (): typeof navigationContext.router => navigationContext.router,
}));

/* -------------------------------------------------------------------------------------------------
 * The component's contract, restated
 *
 * These values are declared in `post-list.tsx`, `ui/pagination.tsx` and `lib/utils.ts` as
 * module-private constants, so they cannot be imported. Restating them is the correct shape for a
 * test rather than a duplication to remove: the test is what PINS the contract, so changing the
 * default copy or the placeholder count becomes a deliberate two-file edit instead of a silent one.
 * ---------------------------------------------------------------------------------------------- */

/** The path the mocked router reports, and therefore the path every generated `href` is built on. */
const FEED_PATHNAME = '/';

/** Accessible name of the page control's `<nav>` landmark, from `ui/pagination.tsx`. */
const PAGINATION_LABEL = 'Pagination';

/** Accessible name of the one live region this component renders, from `post-list.tsx`. */
const LOADING_LABEL = 'Loading posts';

/** How many placeholders the loading branch draws - fixed, never derived from `page_size`. */
const SKELETON_CARD_COUNT = 6;

/** The empty state's headline when the caller names none. */
const DEFAULT_EMPTY_TITLE = 'No posts found';

/** The empty state's supporting copy when the caller names none. */
const DEFAULT_EMPTY_DESCRIPTION =
  'Nothing matches this view yet. Try a different search term, or clear the category filter to see everything.';

/** The level a card title renders at when the caller does not ask for another. */
const DEFAULT_HEADING_LEVEL = 2;

/** The level a section that has already spent an `h2` asks for. Inside the prop's `2 | 3 | 4` union. */
const NESTED_HEADING_LEVEL = 3;

/** The level nothing inside a list may ever be: the page spends its single one on its own heading. */
const TOP_LEVEL_HEADING = 1;

/** The separator `formatResultRange` puts between the two ends of the range - an en dash, not a hyphen. */
const EN_DASH = '\u2013';

/** Matches the result-range sentence whatever its numbers, for asserting that it is absent. */
const RESULT_RANGE_PATTERN = /^Showing /;

/**
 * Base for resolving a relative `href` into a `URL`.
 *
 * Every `href` the control emits is root-relative - `/` for page one, `/?page=N` above it - so it
 * needs an origin before `URL` will parse it. Parsing rather than string-matching is deliberate: it
 * asserts the PATH and the PARAMETER independently, so a control that started emitting `?page=3&page=3`
 * or `/feed?page=3` fails on the field that actually changed.
 */
const HREF_ORIGIN = 'http://localhost';

/**
 * Stands in for a missing `href` so a null can never satisfy the assertions that follow it.
 *
 * `new URL('', HREF_ORIGIN)` resolves to the origin root, whose pathname is `/` - which is exactly
 * what the page-one assertions look for, so an empty fallback would let a missing attribute pass. A
 * path that matches nothing cannot.
 */
const MISSING_HREF = '/href-was-absent';

/* -------------------------------------------------------------------------------------------------
 * Window shapes
 *
 * Named rather than inline, so each envelope below reads as the situation it represents instead of as
 * four unexplained numbers.
 * ---------------------------------------------------------------------------------------------- */

/** Rows per page in every fixture. Small so a multi-page collection needs few rows to build. */
const WINDOW_SIZE = 3;

/** A collection that fits in one page: `ceil(3 / 3)` is 1, so the page control has nothing to do. */
const SINGLE_PAGE_TOTAL = 3;

/** A collection spanning four pages: `ceil(10 / 3)` is 4, and the last page is partial. */
const MULTI_PAGE_TOTAL = 10;

/** The page a multi-page fixture is currently showing - deliberately not the first or the last. */
const MULTI_PAGE_CURRENT = 2;

/** How many pages {@link MULTI_PAGE_TOTAL} occupies at {@link WINDOW_SIZE}. */
const MULTI_PAGE_COUNT = 4;

/** The page after the current one, whose link the href assertions inspect. */
const MULTI_PAGE_NEXT = 3;

/** A page number well past the end of {@link MULTI_PAGE_TOTAL}, as a stale bookmark would name. */
const OUT_OF_RANGE_PAGE = 9;

/**
 * An origin on the remote-image allow-list, used to give a row a cover that actually renders.
 *
 * Written out rather than imported: `IMAGE_HOST_ALLOWLIST` in `@/lib/utils` is the single source of the
 * policy and is deliberately source code rather than configuration, so this literal is the restatement
 * with a note pointing at its origin. If the allow-list ever loses this host, this is the line that has
 * to follow it.
 */
const ADMITTED_COVER_HOST = 'https://images.unsplash.com';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/**
 * A stable, UUID-shaped identifier built from a namespace digit and an index.
 *
 * Identity in this product is generated by the database, so every fixture identifier is a string in
 * UUID form rather than a small integer a client picked. The shape matters beyond realism: it is what
 * keeps these fixtures honest about the contract they stand in for, and `post-list.tsx` keys its rows
 * on exactly this field.
 *
 * @param namespace - A single digit distinguishing posts from authors from categories.
 * @param index - The item's 1-based position, padded into the final group.
 * @returns A canonical version-4-shaped identifier, unique for each `namespace`/`index` pair.
 */
function makeIdentifier(namespace: number, index: number): string {
  const group = String(namespace).repeat(4);
  const tail = String(index).padStart(12, '0');

  return `${group}${group}-${group}-4${group.slice(1)}-8${group.slice(1)}-${tail}`;
}

/**
 * The author projection a card renders its byline from.
 *
 * `avatar_url` is `null` on purpose: the byline's avatar then stays on its text fallback instead of
 * driving the primitive's asynchronous image state machine, and nothing below depends on an image
 * loading. The whole avatar composition is `aria-hidden` either way, so this changes nothing that is
 * asserted - it only removes a source of flake.
 *
 * @param index - Distinguishes one author from another when a fixture needs several.
 * @returns A complete {@link UserPublic}; every field the type declares is present.
 */
function makeAuthor(index: number): UserPublic {
  return {
    id: makeIdentifier(2, index),
    username: `author-${String(index)}`,
    display_name: `Author ${String(index)}`,
    bio: null,
    avatar_url: null,
    created_at: '2024-01-01T00:00:00Z',
  };
}

/**
 * The slim taxonomy projection a card's footer renders as chips.
 *
 * @param index - Distinguishes one category from another.
 * @returns A complete {@link CategorySummary}.
 */
function makeCategory(index: number): CategorySummary {
  return {
    id: makeIdentifier(3, index),
    name: `Category ${String(index)}`,
    slug: `category-${String(index)}`,
  };
}

/**
 * One row of a feed page, as the LIST projection.
 *
 * Every field {@link PostSummary} declares is present, in the service's own snake_case, with no cast
 * and no `any`. There is deliberately no body content: the type carries none, because a feed page
 * returns up to a hundred of these and the Markdown body would multiply every response by the size of
 * the articles in it.
 *
 * `status` is `PUBLISHED` with a non-null `published_at`, which is the pair a database check
 * constraint guarantees and therefore the only combination a public listing can contain.
 *
 * @param index - The row's 1-based position, giving it a distinct title and slug so assertions can
 *   tell the cards apart and check their order.
 * @returns A complete {@link PostSummary}.
 */
function makePostSummary(index: number): PostSummary {
  return {
    id: makeIdentifier(1, index),
    title: `Scaling FastAPI, part ${String(index)}`,
    slug: `scaling-fastapi-part-${String(index)}`,
    excerpt: `What part ${String(index)} covers, in one sentence.`,
    cover_image_url: null,
    status: 'PUBLISHED',
    published_at: '2024-05-10T12:00:00Z',
    view_count: 0,
    created_at: '2024-05-01T09:30:00Z',
    author: makeAuthor(index),
    categories: [makeCategory(index)],
  };
}

/**
 * A run of distinct rows.
 *
 * @param count - How many rows to build.
 * @returns The rows, in ascending index order, which is the order the assertions expect to see them
 *   rendered in.
 */
function makePostSummaries(count: number): PostSummary[] {
  return Array.from({ length: count }, (_, offset) => makePostSummary(offset + 1));
}

/**
 * The four numeric fields that describe a window, named exactly as the wire names them.
 *
 * snake_case throughout, matching {@link Page} and `ui/pagination.tsx`'s own props, because there is
 * no camelCase mapping layer in this tier and a hand-typed `pageSize` would compile cleanly and read
 * `undefined` at run time.
 */
interface WindowShape {
  /** The 1-based page being described. May legitimately exceed the collection's page count. */
  readonly page: number;
  /** Rows per page. Always positive here, which is what keeps the derived page count well defined. */
  readonly page_size: number;
  /** How many rows match in total, ignoring the window. */
  readonly total: number;
}

/**
 * Wrap rows into the API's uniform page envelope.
 *
 * The return type is the real exported generic, so all five snake_case fields are required and no
 * sixth is permitted - `has_next`, `has_prev`, `offset` and cursors are all absent from the contract
 * and stay absent here.
 *
 * `pages` is COMPUTED as `ceil(total / page_size)`, which is the service's own arithmetic, so the five
 * fields cannot disagree with one another and an empty collection reports `pages: 0` rather than `1`
 * exactly as the contract documents. That also means a fixture cannot accidentally assert against a
 * page count the service would never produce.
 *
 * @param items - The rows on this page. Copied into a fresh array so no fixture shares state.
 * @param shape - The window's numbers. See {@link WindowShape}.
 * @returns A `Page<PostSummary>` whose five fields are mutually consistent.
 */
function makePage(items: readonly PostSummary[], shape: WindowShape): Page<PostSummary> {
  return {
    items: [...items],
    total: shape.total,
    page: shape.page,
    page_size: shape.page_size,
    pages: Math.ceil(shape.total / shape.page_size),
  };
}

/**
 * A collection that occupies exactly one page, so the page control renders nothing.
 *
 * @returns Three rows, `page: 1`, `pages: 1`.
 */
function singlePageWindow(): Page<PostSummary> {
  return makePage(makePostSummaries(SINGLE_PAGE_TOTAL), {
    page: 1,
    page_size: WINDOW_SIZE,
    total: SINGLE_PAGE_TOTAL,
  });
}

/**
 * A full window whose every row carries a cover on an ADMITTED host.
 *
 * The distinction from {@link singlePageWindow} is the whole reason this builder exists.
 * `makePostSummary` sets `cover_image_url: null`, so no card in that window renders an `img` at all -
 * and `prioritizeFirstCover` then has nothing to act on, which means a component that ignored the flag
 * entirely would satisfy every other case in this file.
 *
 * The host is `images.unsplash.com`, which is on the allow-list `@/lib/utils` declares and
 * `next.config.ts` derives `images.remotePatterns` from. That matters twice: `next/image` throws on a
 * host absent from that list, and the card's own `allowedImageUrl` guard withholds the element for an
 * unlisted one - so an unadmitted host here would produce no image and quietly restore the same blind
 * spot.
 *
 * @returns Three rows, each with a distinct admitted cover URL, `page: 1`, `pages: 1`.
 */
function coveredWindow(): Page<PostSummary> {
  const rows = makePostSummaries(SINGLE_PAGE_TOTAL).map((post, offset) => ({
    ...post,
    cover_image_url: `${ADMITTED_COVER_HOST}/photo-${String(offset + 1)}.jpg`,
  }));

  return makePage(rows, { page: 1, page_size: WINDOW_SIZE, total: SINGLE_PAGE_TOTAL });
}

/**
 * The middle page of a four-page collection, so the control renders and has a page either side.
 *
 * @returns A full window of three rows, `page: 2`, `pages: 4`.
 */
function multiPageWindow(): Page<PostSummary> {
  return makePage(makePostSummaries(WINDOW_SIZE), {
    page: MULTI_PAGE_CURRENT,
    page_size: WINDOW_SIZE,
    total: MULTI_PAGE_TOTAL,
  });
}

/**
 * A genuinely empty collection: nothing matches, so there is nothing to page through.
 *
 * `total: 0` makes `pages` come out as `0`, which is the documented answer and the reason the page
 * control is correctly absent here while being correctly PRESENT in {@link outOfRangeWindow}.
 *
 * @returns No rows, `total: 0`, `pages: 0`.
 */
function emptyCollectionWindow(): Page<PostSummary> {
  return makePage([], { page: 1, page_size: WINDOW_SIZE, total: 0 });
}

/**
 * A page past the end of a collection that does have rows - a stale bookmark, or a filter narrowed
 * while the reader was on a later page.
 *
 * This is the emptiest window the service actually produces, and it is NOT an error: the page is
 * echoed back verbatim with an empty `items` array. It is the case that distinguishes "no rows" from
 * "no collection", and therefore the case that proves the page control is gated on the envelope's own
 * `pages` rather than on `items.length`.
 *
 * @returns No rows, `page: 9`, `pages: 4`.
 */
function outOfRangeWindow(): Page<PostSummary> {
  return makePage([], {
    page: OUT_OF_RANGE_PAGE,
    page_size: WINDOW_SIZE,
    total: MULTI_PAGE_TOTAL,
  });
}

/* -------------------------------------------------------------------------------------------------
 * Assertion helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * The accessible name `ui/pagination.tsx` gives a page-number link.
 *
 * The control renders the complete phrase in one visually hidden node beside an `aria-hidden` digit,
 * precisely so the computed name does not depend on whitespace between siblings. Querying by this
 * name rather than by the visible digit is what makes these assertions independent of that detail.
 *
 * @param page - The page the link addresses.
 * @returns The link's accessible name, for example `'Page 3'`.
 */
function pageLinkName(page: number): string {
  return `Page ${String(page)}`;
}

/**
 * Resolve a link's `href` into a `URL` so its path and parameters can be asserted separately.
 *
 * @param link - The anchor to read.
 * @returns The absolute form of the link's destination, resolved against {@link HREF_ORIGIN}.
 */
function destinationOf(link: HTMLElement): URL {
  const href = link.getAttribute('href');
  expect(href).not.toBeNull();

  // The assertion above is the real guard; the fallback exists only so this expression is total
  // without a non-null assertion, and it is a path nothing below matches.
  return new URL(href ?? MISSING_HREF, HREF_ORIGIN);
}

/* -------------------------------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------------------------------- */

describe('PostList', () => {
  beforeEach(() => {
    // Router call history only. `vitest.setup.ts` already unmounts every tree after each test, so the
    // DOM needs nothing here, and the mocked module's implementations are untouched by this.
    vi.clearAllMocks();
  });

  describe('page envelope contract', () => {
    it('matches a wire envelope written out independently of the builders', () => {
      // THE ORACLE IS FROZEN, not computed. Every other envelope in this file comes from `makePage`,
      // which derives `pages` as `ceil(total / page_size)` - so asserting that derivation against a
      // constant derived the same way proves only that the helper agrees with itself. This case is the
      // one place the arithmetic is checked against numbers a person wrote down: the literal below is
      // a verbatim `GET /api/v1/posts?page=2&page_size=3` response body for a ten-row collection, with
      // `pages: 4` because four is what `ceil(10 / 3)` comes to and 4 is what the service sends.
      //
      // The comparison runs in both directions. Equality against the frozen literal catches a helper
      // that starts producing a different shape, and the key-set assertion catches an ADDED sixth
      // field - which the type-only import cannot, since an extra property is still assignable.
      const frozen = {
        items: [],
        page: 2,
        page_size: 3,
        pages: 4,
        total: 10,
      } as const;

      const built = makePage([], {
        page: frozen.page,
        page_size: frozen.page_size,
        total: frozen.total,
      });

      expect(built).toEqual(frozen);
      expect(Object.keys(built).sort()).toEqual(['items', 'page', 'page_size', 'pages', 'total']);

      // The three boundary answers of that arithmetic, each written as a literal rather than derived:
      // an empty collection reports ZERO pages (not one), a collection that does not divide evenly
      // rounds up, and one that divides evenly does not gain a trailing empty page. The first of those
      // is the number that separates "nothing matches" from "you are past the end", and the two states
      // render differently further down this file.
      expect(makePage([], { page: 1, page_size: 3, total: 0 }).pages).toBe(0);
      expect(makePage([], { page: 1, page_size: 3, total: 10 }).pages).toBe(4);
      expect(makePage([], { page: 1, page_size: 3, total: 9 }).pages).toBe(3);
      expect(makePage([], { page: 1, page_size: 3, total: 1 }).pages).toBe(1);
    });

    it('carries exactly the five snake_case fields the service returns', () => {
      // The uniform pagination contract, pinned once, in the one file that reads the envelope's
      // numeric fields. `Page<T>` documents EXACTLY five: `has_next`, `has_prev`, `offset`, cursors
      // and hypermedia links are all absent from it and must stay absent, because every one of them is
      // computable from these five and a sixth would be a sixth thing this tier, the service's model
      // and the endpoint reference all have to agree about.
      //
      // The type-only import already catches a RENAMED or REMOVED field at compile time; this catches
      // an ADDED one at run time, which the type cannot. Sorted, so the assertion is about the SET of
      // names rather than about their declaration order.
      expect(Object.keys(multiPageWindow()).sort()).toEqual([
        'items',
        'page',
        'page_size',
        'pages',
        'total',
      ]);

      // And the arithmetic those five obey: `pages` is `ceil(total / page_size)`, so an empty
      // collection reports zero pages rather than one. That single number is what separates "nothing
      // matches" from "you are past the end", and the two states render differently below.
      expect(multiPageWindow().pages).toBe(MULTI_PAGE_COUNT);
      expect(emptyCollectionWindow().pages).toBe(0);
    });
  });

  describe('loaded window', () => {
    it('renders exactly one card per row in the envelope', () => {
      const feed = singlePageWindow();

      render(<PostList page={feed} />);

      // One `article` per row - the card's root element, not a class - so the count is asserted
      // through the accessibility tree rather than through markup this component does not own.
      expect(screen.getAllByRole('article')).toHaveLength(feed.items.length);

      // And each row is really the one that was passed in, found by its title's accessible name.
      for (const post of feed.items) {
        expect(screen.getByRole('heading', { name: post.title })).toBeInTheDocument();
      }
    });

    it('renders the window as one list whose items are the rows', () => {
      const feed = singlePageWindow();

      render(<PostList page={feed} />);

      // COLLECTION SEMANTICS, which the per-card `article` count does not carry. A screen reader
      // announces "list, 3 items" from these roles and nothing else, so a grid of sibling cards with no
      // list around them reads as three unrelated articles - and a reader has no way to know how many
      // results are in front of them or where the set ends. The component's own header records that
      // this is why the loaded branch is a `<ul>` of `<li>` while the loading branch deliberately is
      // not, so the roles are the contract rather than an implementation detail.
      const list = screen.getByRole('list');
      const items = within(list).getAllByRole('listitem');
      expect(items).toHaveLength(feed.items.length);

      // Exactly ONE list: a nested or duplicated list would double every announced count. The category
      // pills inside a card are `navigation` landmarks rather than lists, which is what keeps this
      // count at one.
      expect(screen.getAllByRole('list')).toHaveLength(1);

      // Each list item holds exactly one card, so the two structures agree rather than merely
      // coexisting - one `li` per row AND one `article` per `li`.
      for (const [index, item] of items.entries()) {
        const row = feed.items[index];
        if (row === undefined) {
          throw new Error(`Expected a row at index ${String(index)}.`);
        }
        expect(within(item).getAllByRole('article')).toHaveLength(1);
        expect(within(item).getByRole('heading', { name: row.title })).toBeInTheDocument();
      }
    });

    it('preserves the order the service returned', () => {
      const feed = singlePageWindow();

      render(<PostList page={feed} />);

      // The feed's default ordering is "recent published posts first", composed into one SQL
      // statement server-side. This component windows and lays out; it must never re-sort. Comparing
      // the rendered headings in document order against `page.items` in array order is what catches a
      // sort, a reverse or a stable-key mix-up that a per-title existence check would not.
      const renderedTitles = screen
        .getAllByRole('heading', { level: DEFAULT_HEADING_LEVEL })
        .map((heading) => heading.textContent);

      expect(renderedTitles).toEqual(feed.items.map((post) => post.title));
    });

    it('renders card titles at level two by default and never emits a level-one heading', () => {
      const feed = singlePageWindow();

      render(<PostList page={feed} />);

      expect(screen.getAllByRole('heading', { level: DEFAULT_HEADING_LEVEL })).toHaveLength(
        feed.items.length,
      );

      // The consuming page owns the document's single top-level heading, so nothing inside a list may
      // be one. Asserted on every rendering path, because this is the outline guarantee that lets the
      // same component drop into the feed, a profile and the workspace without corrupting any of them.
      expect(screen.queryByRole('heading', { level: TOP_LEVEL_HEADING })).not.toBeInTheDocument();
    });

    it('propagates the requested heading level to every card title', () => {
      const feed = singlePageWindow();

      render(<PostList headingLevel={NESTED_HEADING_LEVEL} page={feed} />);

      const renderedTitles = screen
        .getAllByRole('heading', { level: NESTED_HEADING_LEVEL })
        .map((heading) => heading.textContent);

      expect(renderedTitles).toEqual(feed.items.map((post) => post.title));

      // Every title moved, not just the first: a section that has already spent an `h2` must not be
      // left with a mixture of levels beneath it.
      expect(screen.queryAllByRole('heading', { level: DEFAULT_HEADING_LEVEL })).toHaveLength(0);
      expect(screen.queryByRole('heading', { level: TOP_LEVEL_HEADING })).not.toBeInTheDocument();
    });

    it('accepts the presentational props without changing what renders', () => {
      const feed = singlePageWindow();

      // `className` is the consuming layout's seam for its own outer measure and vertical rhythm, and
      // `prioritizeFirstCover` is the above-the-fold opt-in for the first card's cover. Neither may
      // alter the content, and neither is asserted through a class: the value of exercising them here
      // is that a rename or removal fails the type gate, and that the cards demonstrably still render.
      render(<PostList className="mt-10" page={feed} prioritizeFirstCover />);

      expect(screen.getAllByRole('article')).toHaveLength(feed.items.length);

      for (const post of feed.items) {
        expect(screen.getByRole('heading', { name: post.title })).toBeInTheDocument();
      }
    });

    it('prioritises the first cover and only the first when asked to', () => {
      const feed = coveredWindow();

      const { container } = render(<PostList page={feed} prioritizeFirstCover />);

      // Every row in this window has a cover on an admitted host, which is what makes the branch
      // reachable at all: the other windows in this file carry `cover_image_url: null`, so no `img` is
      // rendered and `prioritizeFirstCover` has nothing to act on - the flag could be ignored entirely
      // and those cases would still pass.
      const covers = Array.from(container.querySelectorAll('img'));
      expect(covers).toHaveLength(feed.items.length);

      // The first cover loads eagerly, because on the first page of the feed it is the Largest
      // Contentful Paint candidate. `loading` is the observable consequence in jsdom; the
      // fetch-priority hint itself is the browser's business and is not asserted.
      expect(covers[0]?.getAttribute('loading')).not.toBe('lazy');

      // AND ONLY THE FIRST. `index === 0` is the whole of the rule, and a flag applied to every card
      // would make every below-the-fold cover contend for bandwidth with the one above it - which is
      // the exact regression this half of the assertion catches and the previous version could not.
      for (const cover of covers.slice(1)) {
        expect(cover.getAttribute('loading')).toBe('lazy');
      }
    });

    it('defers every cover when not asked to prioritise one', () => {
      const feed = coveredWindow();

      const { container } = render(<PostList page={feed} />);

      // The default, and the correct one for a list that may be rendered anywhere on a page: nothing
      // is above the fold until a caller says so.
      const covers = Array.from(container.querySelectorAll('img'));
      expect(covers).toHaveLength(feed.items.length);
      for (const cover of covers) {
        expect(cover.getAttribute('loading')).toBe('lazy');
      }
    });
  });

  describe('loading window', () => {
    it('renders the fixed run of placeholders inside one named live region', () => {
      // A NON-empty envelope, deliberately: `isLoading` outranks every other state, so a stale
      // window must not show through a refresh.
      render(<PostList isLoading page={singlePageWindow()} />);

      // One live region for the whole run, named rather than marked busy - `aria-busy` on a live
      // region defers the very announcement a loading notice needs. Its children are the placeholders,
      // so their count is read from the region located by role and name, never from a class selector.
      const loadingRegion = screen.getByRole('status', { name: LOADING_LABEL });

      expect(loadingRegion.children).toHaveLength(SKELETON_CARD_COUNT);

      // The placeholders are hidden from assistive technology and are not `article` elements, so
      // neither the default query nor the one that includes hidden nodes reaches them. That is how a
      // reader tells "still loading" from "here are your results".
      expect(screen.queryAllByRole('article')).toHaveLength(0);
      expect(screen.queryAllByRole('article', { hidden: true })).toHaveLength(0);
    });

    it('suppresses the footer while a window is in flight', () => {
      // Four pages' worth of envelope, which would certainly render a control were it not loading.
      render(<PostList isLoading page={multiPageWindow()} />);

      expect(screen.getByRole('status', { name: LOADING_LABEL })).toBeInTheDocument();

      // Neither the page control nor the result range appears, because both would describe a window
      // that has not arrived yet.
      expect(screen.queryByRole('navigation', { name: PAGINATION_LABEL })).not.toBeInTheDocument();
      expect(screen.queryByText(RESULT_RANGE_PATTERN)).not.toBeInTheDocument();
    });
  });

  describe('empty window', () => {
    it('renders the default copy as a heading and shows no cards', () => {
      const feed = emptyCollectionWindow();

      // The contract the envelope itself asserts: an empty collection reports zero pages, not one.
      expect(feed.items).toHaveLength(0);
      expect(feed.total).toBe(0);
      expect(feed.pages).toBe(0);

      render(<PostList page={feed} />);

      // A HEADING at the level the cards would have used, which is how the absence of results stays
      // findable in the document outline exactly where the results would have been.
      expect(
        screen.getByRole('heading', { level: DEFAULT_HEADING_LEVEL, name: DEFAULT_EMPTY_TITLE }),
      ).toBeInTheDocument();
      expect(screen.getByText(DEFAULT_EMPTY_DESCRIPTION)).toBeInTheDocument();

      expect(screen.queryAllByRole('article')).toHaveLength(0);
    });

    it('renders caller-supplied copy in place of the defaults', () => {
      // The defaults cannot be specific, and the difference matters to the reader: "no posts match
      // your search" and "this author has not published anything yet" lead to different next actions.
      const emptyTitle = 'No posts match your search';
      const emptyDescription = 'Try a different search term, or clear the category filter.';

      render(
        <PostList
          emptyDescription={emptyDescription}
          emptyTitle={emptyTitle}
          page={emptyCollectionWindow()}
        />,
      );

      expect(
        screen.getByRole('heading', { level: DEFAULT_HEADING_LEVEL, name: emptyTitle }),
      ).toBeInTheDocument();
      expect(screen.getByText(emptyDescription)).toBeInTheDocument();

      // Replaced, not appended.
      expect(screen.queryByText(DEFAULT_EMPTY_TITLE)).not.toBeInTheDocument();
      expect(screen.queryByText(DEFAULT_EMPTY_DESCRIPTION)).not.toBeInTheDocument();
    });

    it('renders the empty headline at the requested heading level', () => {
      render(<PostList headingLevel={NESTED_HEADING_LEVEL} page={emptyCollectionWindow()} />);

      // The empty headline follows `headingLevel` for the same reason the card titles do: whichever
      // branch renders, the outline beneath the consuming page's own heading stays ordered.
      expect(
        screen.getByRole('heading', { level: NESTED_HEADING_LEVEL, name: DEFAULT_EMPTY_TITLE }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: TOP_LEVEL_HEADING })).not.toBeInTheDocument();
    });

    it('announces nothing, because the alert variant carries no live-region role', () => {
      render(<PostList page={emptyCollectionWindow()} />);

      // The panel is on screen and readable in document order...
      expect(
        screen.getByRole('heading', { level: DEFAULT_HEADING_LEVEL, name: DEFAULT_EMPTY_TITLE }),
      ).toBeInTheDocument();
      expect(screen.getByText(DEFAULT_EMPTY_DESCRIPTION)).toBeInTheDocument();

      // ...and it announces NOTHING, which is the delegation this case exists to verify. This
      // component authors no `role`, `aria-live` or `aria-atomic` for the empty state; the primitive
      // DERIVES the role from the variant, and its table maps the empty variant - like the
      // informational one - to no role at all. An empty result served in the page's first HTML must
      // not interrupt the reader ahead of the heading and the search field that would let them act on
      // it, and it must certainly not be shouted: `alert` is assertive and is reserved for a failure.
      //
      // Both are asserted, because each rules out a different mistake. A `status` here would mean the
      // panel had been given a polite live region it should not have; an `alert` would mean an
      // ordinary absence of results was being reported as an error.
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('drops the result range for an empty window', () => {
      render(<PostList page={emptyCollectionWindow()} />);

      // "0 of 0" beneath a panel already saying there is nothing here is noise, not information.
      expect(screen.queryByText(RESULT_RANGE_PATTERN)).not.toBeInTheDocument();
    });
  });

  describe('page control', () => {
    it('omits the control for a single-page collection but keeps the result range', () => {
      const feed = singlePageWindow();

      expect(feed.pages).toBe(1);

      render(<PostList page={feed} />);

      // Nothing to navigate, and an empty landmark is noise in a screen reader's landmark list.
      expect(screen.queryByRole('navigation', { name: PAGINATION_LABEL })).not.toBeInTheDocument();

      // The range still renders, and its numbers come from the envelope: three rows starting at the
      // first, out of a total of three.
      expect(
        screen.getByText(
          `Showing 1${EN_DASH}${String(feed.items.length)} of ${String(feed.total)} results`,
        ),
      ).toBeInTheDocument();
    });

    it('renders the control for a multi-page collection with a real destination on every link', () => {
      const feed = multiPageWindow();

      expect(feed.page).toBe(MULTI_PAGE_CURRENT);
      expect(feed.pages).toBe(MULTI_PAGE_COUNT);

      render(<PostList page={feed} />);

      const control = screen.getByRole('navigation', { name: PAGINATION_LABEL });
      const links = within(control).getAllByRole('link');

      expect(links.length).toBeGreaterThan(0);

      // Every control is an anchor with a destination, which is what makes pagination crawlable,
      // middle-clickable and copyable rather than a state change that exists only while scripting
      // runs. A control built from buttons would still render links here - it would just have no
      // `href` - so this is the assertion that distinguishes the two.
      for (const link of links) {
        expect(link).toHaveAttribute('href');
      }

      // Both ends of the envelope's page count reached the control: the first page and the last are
      // always in the rendered window, whatever the surrounding elision does.
      expect(within(control).getByRole('link', { name: pageLinkName(1) })).toBeInTheDocument();
      expect(
        within(control).getByRole('link', { name: pageLinkName(feed.pages) }),
      ).toBeInTheDocument();
    });

    it('marks the envelope page as current and addresses its neighbour by query parameter', () => {
      const feed = multiPageWindow();

      render(<PostList page={feed} />);

      const control = screen.getByRole('navigation', { name: PAGINATION_LABEL });

      // Exactly one control is marked current, and it is the page the rendered rows belong to - the
      // envelope's own `page`, not something re-derived here. It stays a link, because removing the
      // href would cost the page its canonical self-reference, and `aria-current` is the non-visual
      // half of a distinction that colour alone cannot carry.
      const currentPage = within(control).getByRole('link', { current: 'page' });

      expect(currentPage).toHaveAccessibleName(pageLinkName(feed.page));

      // The next page is addressed by the `page` parameter on the current path. Parsed rather than
      // string-compared so the path and the parameter are two independent assertions.
      const nextPage = within(control).getByRole('link', { name: pageLinkName(MULTI_PAGE_NEXT) });
      const destination = destinationOf(nextPage);

      expect(destination.pathname).toBe(FEED_PATHNAME);
      expect(destination.searchParams.get('page')).toBe(String(MULTI_PAGE_NEXT));
    });

    it('addresses page one by the bare path so it keeps a single canonical URL', () => {
      render(<PostList page={multiPageWindow()} />);

      const control = screen.getByRole('navigation', { name: PAGINATION_LABEL });
      const firstPage = within(control).getByRole('link', { name: pageLinkName(1) });
      const destination = destinationOf(firstPage);

      expect(destination.pathname).toBe(FEED_PATHNAME);

      // No `page=1`. Emitting it would mint a second URL for byte-identical content, and the sitemap
      // and the canonical link would then disagree with each other.
      expect(destination.searchParams.has('page')).toBe(false);
    });

    it('keeps the control for a window past the end of the collection', () => {
      const feed = outOfRangeWindow();

      // The emptiest window the service actually produces: a page beyond the last is not an error, so
      // the requested page comes back verbatim with no rows.
      expect(feed.items).toHaveLength(0);
      expect(feed.page).toBeGreaterThan(feed.pages);
      expect(feed.pages).toBeGreaterThan(1);

      render(<PostList page={feed} />);

      // The control survives, because those pages exist and dropping it would strand a reader who
      // arrived from a stale bookmark on a blank screen with no way out but the back button. This is
      // the case that proves the gate is the envelope's `pages` and not `items.length`.
      expect(screen.getByRole('navigation', { name: PAGINATION_LABEL })).toBeInTheDocument();

      // The empty panel still renders and no card does...
      expect(screen.queryAllByRole('article')).toHaveLength(0);
      expect(screen.getByRole('heading', { name: DEFAULT_EMPTY_TITLE })).toBeInTheDocument();

      // ...and the RANGE is what gets dropped instead, since there is no range to state.
      expect(screen.queryByText(RESULT_RANGE_PATTERN)).not.toBeInTheDocument();
    });
  });

  describe('layering', () => {
    it('issues no HTTP request and performs no navigation', () => {
      // No endpoint is mocked for this component, because it has no endpoint: the route that renders
      // it fetches through the API layer and hands the envelope in already resolved. Spying is how
      // that separation becomes an assertion instead of an assumption - silence is otherwise
      // indistinguishable from a request nobody looked for.
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      onTestFinished(() => {
        fetchSpy.mockRestore();
      });

      render(<PostList page={multiPageWindow()} />);

      // Rendered fully, control and all, so the assertion below is about a tree that really mounted.
      expect(screen.getAllByRole('article')).toHaveLength(WINDOW_SIZE);
      expect(screen.getByRole('navigation', { name: PAGINATION_LABEL })).toBeInTheDocument();

      expect(fetchSpy).not.toHaveBeenCalled();

      // Nor did anything navigate. The page links ARE the navigation, so a router transition during
      // render would mean the control had grown a handler that duplicates its own anchors - two
      // history entries for one click. `prefetch` is deliberately not asserted: it is the framework's
      // own optimisation and is none of this component's business either way.
      expect(navigationContext.router.push).not.toHaveBeenCalled();
      expect(navigationContext.router.replace).not.toHaveBeenCalled();
      expect(navigationContext.router.back).not.toHaveBeenCalled();
      expect(navigationContext.router.forward).not.toHaveBeenCalled();
      expect(navigationContext.router.refresh).not.toHaveBeenCalled();
    });
  });
});
