/**
 * Component tests for `@/components/ui/pagination` - the page control every windowed
 * collection in the product shares.
 *
 * ---------------------------------------------------------------------------
 * 1. THE PRIMARY SUBJECT OF THIS FILE IS THE `href`
 *
 * A page control can be built two ways, and only one of them is correct here. The
 * shorter way is `<button onClick={() => setPage(n)}>`, which produces a destination
 * that exists only while JavaScript is running: nothing to crawl, nothing to
 * middle-click, nothing to copy, nothing in the browser's history. The plan requires
 * the opposite - AAP §0.8.6 specifies this primitive as authored over `<nav>` "with
 * anchor-based links so pages remain crawlable, satisfying the SEO requirement as well
 * as the interaction one".
 *
 * That makes this the one component in the tier where an interaction requirement and an
 * SEO requirement are discharged by the *same* DOM node, and it makes the `href` the
 * assertion this file must never omit. A refactor to `<button onClick>` would keep every
 * naive interaction test green while silently deleting an AAP R9 deliverable; asserting
 * that every page affordance is an anchor carrying a real, parseable, site-relative URL
 * is what makes that refactor impossible to land unnoticed.
 *
 * Three properties of those URLs are asserted individually, because each one is a
 * separate promise the control makes to the crawler and to the reader:
 *
 *   * Page one is addressed by the BARE PATH. `/?page=1` would be a second URL for
 *     byte-identical content, and the sitemap and the canonical link would then
 *     disagree with each other (AAP §0.9.4.5).
 *   * Every later page carries `page=N`, and nothing else changes.
 *   * The reader's `q`, `category` and `sort` survive, so turning the page never
 *     discards their search or their filter (AAP §0.6.5).
 *
 * Every URL is asserted by parsing it with `new URL(...)` and reading `searchParams`,
 * so the assertions are order-independent rather than brittle string comparisons. That
 * origin is a parse base only - nothing in this file performs or provokes any HTTP.
 *
 * ---------------------------------------------------------------------------
 * 2. WHAT IS DELIBERATELY NOT ASSERTED, AND WHY THAT IS A REQUIREMENT
 *
 * NOT ONE CLASS NAME. The control borrows `buttonVariants` from
 * `@/components/ui/button` so its anchors look like buttons, and none of that is this
 * file's business. AAP §0.7.2 and §0.8.5 put every presentation value in the token
 * layer precisely so it can change freely; a test that pinned a class would convert a
 * legitimate token change into a red build and would teach the next author to stop
 * changing tokens. So there is no `toHaveClass` here, no `className` read, no
 * class-based `querySelector`, no `getComputedStyle` and no snapshot - including no
 * attempt to prove the anchors "look like buttons".
 *
 * The `href` replaces all of it, and is a far stronger assertion than any styling check
 * could be: it is the contract, not the costume. The only `querySelector` calls in this
 * file select by TAG (`svg`, `li`) to reach elements that carry no role of their own,
 * which is a structural lookup rather than a styling one.
 *
 * ---------------------------------------------------------------------------
 * 3. THE APP ROUTER HARNESS
 *
 * `Pagination` is a `'use client'` island, and it reaches `next/navigation` through
 * `usePagination`/`hrefForPage` in `@/hooks/use-pagination`, which reads
 * `useSearchParams`, `usePathname` and `useRouter`. jsdom has no App Router context, so
 * the module is mocked below with a swappable query string and pathname. Two details
 * matter:
 *
 *   * `useSearchParams` returns a REAL `URLSearchParams`, so `.get()` and `.toString()`
 *     behave exactly as they do in the browser and the hook's parameter-preservation
 *     logic is genuinely exercised rather than approximated.
 *   * The mutable state lives in `vi.hoisted(...)`. `vi.mock` is hoisted above every
 *     import, so a plain module-level `let` would still be in its temporal dead zone
 *     when the factory first runs.
 *
 * `next/link` is NOT mocked. Measured in this configuration, it renders a real
 * `<a href>` in jsdom without an App Router context, so mocking it would only put a
 * stand-in between the test and the exact attribute under test.
 *
 * The one thing jsdom cannot do is follow a link, and it reports that as
 * `Not implemented: navigation to another Document` on every click. A document-level
 * click listener cancels the default action instead - which is what the real App Router
 * does on every intercepted link click - and, because it runs on the BUBBLE phase after
 * React's own handler, it can first record whether anything in the component tree had
 * already cancelled the event. That turns an environment limitation into the assertion
 * in `never cancels the click`: the control's documented contract is that
 * `onPageChange` fires ALONGSIDE navigation and never instead of it, so a
 * `preventDefault()` appearing in that handler is a defect this file catches.
 *
 * ---------------------------------------------------------------------------
 * 4. GOVERNING STANDARDS
 *
 * `review_rules` reports that NO user-specified rules were provided for this project,
 * and AAP §0.10.1 records the same, so the binding constraints are the plan's own
 * enterprise standards. Six of them govern this file: accessibility as a floor (every
 * query below is by role and accessible name, never by markup shape); zero hardcoded
 * presentation values (section 2); explicit API contracts (the fixture is typed
 * `Page<PostSummary>`, so a drift in the five snake_case envelope fields fails `tsc`
 * here rather than at run time in a browser); API versioning (no URL in this file is an
 * API path - every asserted `href` is a site path, and one case asserts that directly);
 * pinned dependencies (`vitest` and `@testing-library/react` are the entire test
 * surface - `@testing-library/user-event` is not a declared dependency, so `fireEvent`
 * is used); and blocking quality gates (this file passes `npm run test -- --run`,
 * `tsc --noEmit` under `strict` and `eslint --max-warnings=0`, with no suppression
 * comment of any kind, no `.only`, no `.skip` and no `any`).
 *
 * Also deliberately absent: any import of `@testing-library/jest-dom`, whose matchers
 * `frontend/vitest.setup.ts` already registers globally; any call to `cleanup`, which
 * that file already runs after every test; and any `setupServer`, because this control
 * issues no request and there is nothing to intercept.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fireEvent, render, screen, within } from '@testing-library/react';

import { Pagination } from '@/components/ui/pagination';
import type { Page, PostSummary } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * The App Router harness
 * ---------------------------------------------------------------------------------------------- */

/**
 * The URL the mocked App Router reports, mutable per test.
 *
 * Declared through `vi.hoisted` so the hoisted `vi.mock` factory below can close over it
 * safely. `beforeEach` restores both fields, so a test that changes neither is reading the
 * home feed's address.
 */
const routerState = vi.hoisted(() => ({
  /** What `usePathname()` returns. `'/'` is the home feed; other surfaces set their own. */
  pathname: '/',
  /** The query string `useSearchParams()` is built from. Empty means an unfiltered first visit. */
  query: '',
}));

/**
 * The full `AppRouterInstance` surface, as spies.
 *
 * All six exist rather than only the `push` that `usePagination` actually calls, for two
 * reasons. A faithful stand-in means a future hook change that reaches for `refresh()` fails
 * an assertion instead of throwing `is not a function` from inside a render. And the spies are
 * themselves an assertion: this control's contract is that THE ANCHOR IS THE NAVIGATION, so
 * `performs no imperative navigation of its own` proves that clicking never routes
 * programmatically. That is the defect the component's own documentation warns about - a
 * callback that navigates fires a second transition for one click, leaving two history entries
 * and a back button that appears dead.
 */
const routerSpies = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
}));

/*
 * The three hooks are plain arrow functions rather than `vi.fn()` wrappers on purpose: the
 * `vi.clearAllMocks()` in `beforeEach` clears call history, and a mock implementation here would
 * be one refactor away from being reset out from under every test in the file.
 */
vi.mock('next/navigation', () => ({
  useSearchParams: (): URLSearchParams => new URLSearchParams(routerState.query),
  usePathname: (): string => routerState.pathname,
  useRouter: () => routerSpies,
}));

/* -------------------------------------------------------------------------------------------------
 * Navigation interception
 * ---------------------------------------------------------------------------------------------- */

/** Origin used only as a base for parsing relative hrefs. Never requested. */
const PARSE_ORIGIN = 'http://localhost';

/**
 * What the document-level listener observed about the last click.
 *
 * `null` means no click reached the document at all, which is why the click assertions check
 * for an explicit `false` - it distinguishes "nothing cancelled the event" from "no event was
 * ever dispatched".
 */
const lastClick: { cancelledBeforeDocument: boolean | null } = {
  cancelledBeforeDocument: null,
};

/**
 * Stand in for the App Router's link interception.
 *
 * Registered on `document` for the BUBBLE phase, so it runs after the handler React attached
 * to the render container: by the time it fires, `defaultPrevented` reflects what the component
 * tree did and nothing else. Recording that value and then cancelling gives both halves of what
 * this file needs - the component's non-cancellation is observable, and jsdom never attempts a
 * document navigation it cannot perform.
 */
function interceptDocumentNavigation(event: Event): void {
  lastClick.cancelledBeforeDocument = event.defaultPrevented;
  event.preventDefault();
}

beforeEach(() => {
  routerState.pathname = '/';
  routerState.query = '';
  lastClick.cancelledBeforeDocument = null;
  vi.clearAllMocks();
  document.addEventListener('click', interceptDocumentNavigation);
});

afterEach(() => {
  document.removeEventListener('click', interceptDocumentNavigation);
});

/* -------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Parse a link's `href` into a `URL` so its path and parameters can be asserted individually.
 *
 * A missing `href` throws rather than being coerced to an empty string: an anchor with no
 * destination is the precise defect this file exists to catch, and it should fail loudly at the
 * point of discovery rather than turn into a confusing comparison further down.
 *
 * @param link - The anchor to read.
 * @returns The absolute form of its `href`, resolved against {@link PARSE_ORIGIN}.
 */
function urlOf(link: Element): URL {
  const href = link.getAttribute('href');

  if (href === null) {
    throw new Error(
      `Expected a link named "${link.textContent ?? ''}" to carry an href, but it had none.`,
    );
  }

  return new URL(href, PARSE_ORIGIN);
}

/**
 * Read the `page` parameter of a link as a number, treating its absence as page one.
 *
 * Absence is not a missing value here, it is the encoding: page one is addressed by the bare
 * path, so no `page` parameter and `page=1` mean the same page.
 *
 * @param link - The anchor to read.
 * @returns The page the link addresses.
 */
function pageAddressedBy(link: Element): number {
  const page = urlOf(link).searchParams.get('page');

  return page === null ? 1 : Number(page);
}

/**
 * Locate the boundary control that stands in for an unavailable edge affordance.
 *
 * It cannot be found by role: the component deliberately renders a `<span>` carrying
 * `aria-disabled` rather than an `<a>` without an `href`, because an href-less anchor is neither
 * focusable nor activatable while still looking like a control. So it is reached through its
 * visually hidden name and asserted one level up, on the element that carries the state.
 *
 * @param label - The control's accessible name, `'Previous page'` or `'Next page'`.
 * @returns The element carrying the disabled state.
 */
function inertControlNamed(label: string): HTMLElement {
  const name = screen.getByText(label);
  const control = name.parentElement;

  if (control === null) {
    throw new Error(`Expected the text "${label}" to sit inside a control element.`);
  }

  return control;
}

/**
 * The decorative glyph inside a control, selected by tag because an `aria-hidden` icon has no
 * role to query it by.
 *
 * @param control - The control to look inside.
 * @returns Its icon element.
 */
function glyphOf(control: Element): Element {
  const glyph = control.querySelector('svg');

  if (glyph === null) {
    throw new Error('Expected the control to render an icon.');
  }

  return glyph;
}

/**
 * The list item enclosing an element, selected by tag for the same reason as {@link glyphOf}:
 * an `aria-hidden` item is removed from the accessibility tree and so has no queryable role.
 *
 * @param element - The element to walk up from.
 * @returns Its enclosing `<li>`.
 */
function enclosingListItem(element: Element): Element {
  const item = element.closest('li');

  if (item === null) {
    throw new Error('Expected the element to sit inside a list item.');
  }

  return item;
}

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** The marker the control renders for a collapsed run of omitted pages. */
const OMITTED_RUN_MARKER = '\u2026';

/**
 * Window size of the feed envelope below: the service's own default.
 *
 * `DEFAULT_PAGE_SIZE` in `backend/app/core/pagination.py` is 20, and the feed endpoint declares it as
 * the default of its `page_size` parameter - so a caller that omits the parameter receives twenty rows
 * and this control is asked to describe a twenty-row window. Ten was the number here previously, and
 * the description "matching the service's default" was the part that was wrong rather than the number
 * being harmful: every arithmetic assertion below derives its expected range from this constant, so a
 * wrong value produced consistent-but-fictional expectations.
 *
 * The service's bounds are 1 and 100 with 20 in the middle; nothing in this control cares which of
 * those it is handed, and the cases below that need a different window pass their own literal.
 *
 * Restated as a literal rather than imported: the number lives in the service, and the only frontend
 * module that names any part of the range is `@/lib/api/users`, which declares the two BOUNDS and
 * deliberately declares no default so an omitted parameter reaches the API unset. A test that imported
 * a constant to check it against would agree with whatever that constant said.
 */
const FEED_PAGE_SIZE = 20;

/** The service's inclusive window bounds, restated for the same reason. */
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 100;

/**
 * One row of the feed envelope.
 *
 * Complete rather than partial, and typed rather than cast, because the point of the envelope
 * fixture is that a REAL `Page<PostSummary>` from the API spreads straight into this control
 * with no adapter in between. A partial row would need a cast, and a cast is exactly the escape
 * hatch that lets a contract drift without a test noticing.
 *
 * @param index - Row position, used to keep the identifiers and slugs distinct.
 * @returns A published post summary.
 */
function postSummary(index: number): PostSummary {
  const suffix = String(index).padStart(2, '0');

  return {
    id: `00000000-0000-4000-8000-0000000000${suffix}`,
    title: `Scaling FastAPI, part ${String(index)}`,
    slug: `scaling-fastapi-part-${String(index)}`,
    excerpt: 'How the service layer keeps the query in one place.',
    cover_image_url: null,
    status: 'PUBLISHED',
    published_at: '2024-05-10T12:00:00Z',
    view_count: index,
    created_at: '2024-05-01T09:00:00Z',
    author: {
      id: '00000000-0000-4000-8000-0000000000aa',
      username: 'ada',
      display_name: 'Ada Lovelace',
      bio: null,
      avatar_url: null,
      created_at: '2024-01-01T00:00:00Z',
    },
    categories: [
      { id: '00000000-0000-4000-8000-0000000000bb', name: 'Engineering', slug: 'engineering' },
    ],
  };
}

/**
 * A result window exactly as `GET /posts` returns one: the third page of forty-seven matching
 * posts at a window size of ten.
 *
 * Typed as `Page<PostSummary>` deliberately. The control reads four of the envelope's five
 * fields - `page`, `pages`, `total` and `page_size` - and reads none of them through a
 * camelCase mirror, because there is no mapping layer anywhere in this tier. Declaring the
 * fixture against the shared type means a rename of any wire field breaks compilation HERE,
 * next to the assertion that depends on it.
 */
const feedPage: Page<PostSummary> = {
  items: Array.from({ length: FEED_PAGE_SIZE }, (_row, index) => postSummary(index + 21)),
  total: 47,
  page: 3,
  page_size: FEED_PAGE_SIZE,
  pages: 5,
};

/* -------------------------------------------------------------------------------------------------
 * Suite
 * ---------------------------------------------------------------------------------------------- */

describe('Pagination', () => {
  /*
   * The crawlability contract. Section 1 of the file header explains why these are the
   * assertions that carry the most weight in this file: they are simultaneously the interaction
   * contract and an AAP R9 deliverable, and they are what a plausible-looking refactor to
   * `<button onClick>` would silently delete.
   */
  describe('crawlable hrefs', () => {
    it('renders every page affordance as a real anchor carrying a site-relative href', () => {
      routerState.query = 'q=fastapi&category=engineering&sort=relevance';

      render(<Pagination page={5} pages={10} total={97} page_size={FEED_PAGE_SIZE} />);

      // First page, a collapsed run, the current page with a sibling either side, a second
      // collapsed run, the last page, and an edge control at each end.
      const links = screen.getAllByRole('link');
      expect(links).toHaveLength(7);

      for (const link of links) {
        // The single assertion this file must never omit: a destination exists in the markup,
        // so the page is reachable without executing any client script.
        expect(link).toHaveAttribute('href', expect.any(String));

        const url = urlOf(link);

        // A SITE path, never an API path. The control issues no request and must never link
        // into the versioned service namespace.
        expect(url.pathname).toBe('/');
        expect(url.pathname.startsWith('/api')).toBe(false);
      }
    });

    it('addresses page one with the bare path so it keeps a single canonical URL', () => {
      render(<Pagination page={2} pages={5} total={feedPage.total} page_size={FEED_PAGE_SIZE} />);

      const firstPage = screen.getByRole('link', { name: 'Page 1' });

      // `/?page=1` would be a second URL for byte-identical content, and the sitemap and the
      // canonical link would then disagree with each other.
      expect(firstPage).toHaveAttribute('href', '/');

      const url = urlOf(firstPage);
      expect(url.pathname).toBe('/');
      expect(url.searchParams.has('page')).toBe(false);
      expect(url.search).toBe('');

      // The edge control shares that one canonical address rather than minting its own.
      expect(screen.getByRole('link', { name: 'Previous page' })).toHaveAttribute('href', '/');
    });

    it('carries page=N for every page after the first', () => {
      render(<Pagination page={1} pages={5} total={feedPage.total} page_size={FEED_PAGE_SIZE} />);

      expect(urlOf(screen.getByRole('link', { name: 'Page 2' })).searchParams.get('page')).toBe(
        '2',
      );
      expect(urlOf(screen.getByRole('link', { name: 'Page 5' })).searchParams.get('page')).toBe(
        '5',
      );

      // The edge control is built from the same resolver, so it agrees with the numbered link.
      expect(urlOf(screen.getByRole('link', { name: 'Next page' })).searchParams.get('page')).toBe(
        '2',
      );
    });

    it('preserves the search and filter parameters the reader arrived with', () => {
      routerState.query = 'q=fastapi&category=engineering&sort=relevance';

      render(<Pagination page={1} pages={4} total={31} page_size={FEED_PAGE_SIZE} />);

      const url = urlOf(screen.getByRole('link', { name: 'Page 2' }));

      expect(url.searchParams.get('q')).toBe('fastapi');
      expect(url.searchParams.get('category')).toBe('engineering');
      expect(url.searchParams.get('sort')).toBe('relevance');
      expect(url.searchParams.get('page')).toBe('2');

      // Compared as a whole, and order-independently, so this also proves nothing extra was
      // introduced and nothing was silently dropped.
      expect(Object.fromEntries(url.searchParams)).toStrictEqual({
        q: 'fastapi',
        category: 'engineering',
        sort: 'relevance',
        page: '2',
      });
    });

    it('drops an empty-valued parameter rather than minting a second URL for it', () => {
      routerState.query = 'q=&category=engineering&sort=';

      render(<Pagination page={1} pages={3} total={25} page_size={FEED_PAGE_SIZE} />);

      // `?q=` carries no filter, so a URL bearing it would address identical content under a
      // second address - the same defect `page=1` would be.
      expect(
        Object.fromEntries(urlOf(screen.getByRole('link', { name: 'Page 2' })).searchParams),
      ).toStrictEqual({ category: 'engineering', page: '2' });

      expect(screen.getByRole('link', { name: 'Page 1' })).toHaveAttribute(
        'href',
        '/?category=engineering',
      );
    });

    it('links an author profile with profile-relative site paths', () => {
      // The `u/[username]` published-post list (AAP R5) is one of the three surfaces that share
      // this control, and it is not addressed at the site root.
      routerState.pathname = '/u/ada';
      routerState.query = 'page=2';

      render(<Pagination page={2} pages={3} total={25} page_size={FEED_PAGE_SIZE} />);

      expect(screen.getByRole('link', { name: 'Page 1' })).toHaveAttribute('href', '/u/ada');

      const url = urlOf(screen.getByRole('link', { name: 'Page 3' }));
      expect(url.pathname).toBe('/u/ada');

      // The incoming `page` is replaced, never duplicated or appended to.
      expect(Object.fromEntries(url.searchParams)).toStrictEqual({ page: '3' });
    });

    it('links an administrative table with admin site paths and keeps its filter', () => {
      routerState.pathname = '/admin/comments';
      routerState.query = 'status=PENDING';

      render(
        <Pagination
          ariaLabel="Comment queue pagination"
          page={1}
          pages={2}
          page_size={FEED_PAGE_SIZE}
          total={15}
        />,
      );

      const url = urlOf(screen.getByRole('link', { name: 'Page 2' }));

      expect(url.pathname).toBe('/admin/comments');
      expect(url.pathname.startsWith('/api')).toBe(false);
      expect(Object.fromEntries(url.searchParams)).toStrictEqual({
        status: 'PENDING',
        page: '2',
      });
    });

    it('never addresses a page past the last one, even from a stale URL', () => {
      // The service echoes an out-of-range page back rather than raising (AAP §0.9.4.4), so a
      // hand-edited or bookmarked `?page=99` reaches this control as an ordinary input. It is
      // clamped for display, and no href it emits may address a page that does not exist.
      render(<Pagination page={99} pages={5} total={feedPage.total} page_size={FEED_PAGE_SIZE} />);

      for (const link of screen.getAllByRole('link')) {
        expect(pageAddressedBy(link)).toBeLessThanOrEqual(5);
      }

      expect(screen.getByRole('link', { name: 'Page 5' })).toHaveAttribute('aria-current', 'page');
      expect(screen.queryByRole('link', { name: 'Next page' })).toBeNull();
    });

    it('routes page links and both edge controls through an href override alike', () => {
      // A caller paging something the current URL does not address supplies its own resolver.
      // One resolver serves every link, so a single call cannot end up with two URL schemes -
      // half the control pointing at the override and half at the query string.
      const hrefForPage = (page: number): string => `/admin/users?cursor=${String(page)}`;

      render(<Pagination hrefForPage={hrefForPage} page={3} pages={5} />);

      expect(screen.getByRole('link', { name: 'Previous page' })).toHaveAttribute(
        'href',
        '/admin/users?cursor=2',
      );
      expect(screen.getByRole('link', { name: 'Page 1' })).toHaveAttribute(
        'href',
        '/admin/users?cursor=1',
      );
      expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute(
        'href',
        '/admin/users?cursor=4',
      );

      for (const link of screen.getAllByRole('link')) {
        expect(urlOf(link).pathname).toBe('/admin/users');
      }
    });

    it('accepts a Page envelope straight from the API with no adapter', () => {
      // The documented Server Component usage: `<Pagination {...feed} />`. The envelope's
      // numeric fields ARE this control's props, which is what lets the server-rendered feed
      // and profile render it without a mapping layer - and what puts these anchors into the
      // initial HTML, where a crawler can see them.
      render(<Pagination {...feedPage} />);

      expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: `Page ${String(feedPage.page)}` })).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(
        urlOf(
          screen.getByRole('link', { name: `Page ${String(feedPage.pages)}` }),
        ).searchParams.get('page'),
      ).toBe('5');
    });
  });

  /*
   * The accessibility floor (AAP §0.10.1, §0.7.3.5). Every query here is by role and accessible
   * name, so these tests describe what a screen-reader user perceives rather than what the
   * markup happens to look like - which is also why a token or class change cannot break one.
   */
  describe('accessibility', () => {
    it('names the navigation landmark so assistive technology can identify it', () => {
      render(<Pagination page={2} pages={5} total={feedPage.total} page_size={FEED_PAGE_SIZE} />);

      // An unnamed `<nav>` is announced as an anonymous "navigation" that a screen-reader user
      // has to enter to identify. The name is the difference between that and "Pagination
      // navigation" in a landmark list.
      const landmark = screen.getByRole('navigation', { name: 'Pagination' });

      expect(landmark).toHaveAccessibleName('Pagination');
      expect(within(landmark).getAllByRole('link')).toHaveLength(7);
    });

    it('takes a caller-supplied name so two controls on one screen are distinguishable', () => {
      // An administrative screen can page a table above and a moderation queue below; two
      // anonymous "navigation" entries in a landmark list would be indistinguishable.
      render(<Pagination ariaLabel="Comment queue pagination" page={2} pages={5} />);

      expect(
        screen.getByRole('navigation', { name: 'Comment queue pagination' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();
    });

    it('exposes the pages as a list so their number and position are announced', () => {
      render(<Pagination page={2} pages={5} total={feedPage.total} page_size={FEED_PAGE_SIZE} />);

      const landmark = screen.getByRole('navigation', { name: 'Pagination' });

      // A row of loose links cannot convey "3 of 5"; a list can.
      expect(within(landmark).getAllByRole('list')).toHaveLength(1);
      expect(within(landmark).getAllByRole('listitem')).toHaveLength(7);
    });

    it('gives every page link a complete accessible name beside its visible digit', () => {
      render(<Pagination page={3} pages={5} total={feedPage.total} page_size={FEED_PAGE_SIZE} />);

      // "4" is a poor name for a link; "Page 4" is unambiguous. Asserting the exact name also
      // proves the visible digit is hidden from assistive technology - were it not, the computed
      // name would read "Page 4 4" or, without the separating whitespace, "Page 44".
      for (const page of [1, 2, 3, 4, 5]) {
        const label = `Page ${String(page)}`;

        expect(screen.getByRole('link', { name: label })).toHaveAccessibleName(label);
      }

      // The digit is still on screen for a sighted reader.
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('marks only the current page with aria-current', () => {
      render(<Pagination page={3} pages={5} total={feedPage.total} page_size={FEED_PAGE_SIZE} />);

      // The current page stays a link - removing its href would cost the page its own canonical
      // self-reference - and `aria-current` is the non-visual half of the distinction that
      // colour alone cannot carry.
      expect(screen.getByRole('link', { name: 'Page 3' })).toHaveAttribute('aria-current', 'page');

      for (const page of [1, 2, 4, 5]) {
        expect(screen.getByRole('link', { name: `Page ${String(page)}` })).not.toHaveAttribute(
          'aria-current',
        );
      }

      expect(screen.getByRole('link', { name: 'Previous page' })).not.toHaveAttribute(
        'aria-current',
      );
      expect(screen.getByRole('link', { name: 'Next page' })).not.toHaveAttribute('aria-current');
    });

    it('names each edge control with text and hides its decorative glyph', () => {
      render(<Pagination page={3} pages={5} total={feedPage.total} page_size={FEED_PAGE_SIZE} />);

      const previous = screen.getByRole('link', { name: 'Previous page' });
      const next = screen.getByRole('link', { name: 'Next page' });

      // Text rather than an `aria-label`: an attribute leaves a speech-input user with no
      // visible name to say, and it is invisible to the translation layer that rewrites text
      // nodes, so a localised page would announce an English name.
      expect(previous).toHaveAccessibleName('Previous page');
      expect(next).toHaveAccessibleName('Next page');

      // The chevron is decoration; the name must not depend on it and it must not be announced.
      expect(glyphOf(previous)).toHaveAttribute('aria-hidden', 'true');
      expect(glyphOf(next)).toHaveAttribute('aria-hidden', 'true');

      // Sequence relations for the user agents and reading-mode extensions that read them.
      expect(previous).toHaveAttribute('rel', 'prev');
      expect(next).toHaveAttribute('rel', 'next');
    });

    it('renders the first-page boundary as an inert announced control, not a link', () => {
      render(<Pagination page={1} pages={5} total={feedPage.total} page_size={FEED_PAGE_SIZE} />);

      // Deliberately NOT an `<a>` without an `href`: such an anchor is neither focusable nor
      // activatable while still looking like a control, which is a real accessibility defect
      // rather than a shortcut. It is also not omitted, so the row does not shift by a control's
      // width as the reader crosses the first page.
      expect(screen.queryByRole('link', { name: 'Previous page' })).toBeNull();

      const boundary = inertControlNamed('Previous page');

      expect(boundary).toHaveAttribute('aria-disabled', 'true');
      expect(boundary).not.toHaveAttribute('href');

      // The other end is still live, so the reader is not stranded.
      expect(screen.getByRole('link', { name: 'Next page' })).toBeInTheDocument();
    });

    it('renders the last-page boundary the same way', () => {
      render(<Pagination page={5} pages={5} total={feedPage.total} page_size={FEED_PAGE_SIZE} />);

      expect(screen.queryByRole('link', { name: 'Next page' })).toBeNull();

      const boundary = inertControlNamed('Next page');

      expect(boundary).toHaveAttribute('aria-disabled', 'true');
      expect(boundary).not.toHaveAttribute('href');

      expect(screen.getByRole('link', { name: 'Previous page' })).toBeInTheDocument();
    });

    it('keeps the omitted-page markers out of the accessibility tree', () => {
      render(<Pagination page={5} pages={10} total={97} page_size={FEED_PAGE_SIZE} />);

      const landmark = screen.getByRole('navigation', { name: 'Pagination' });
      const markers = within(landmark).getAllByText(OMITTED_RUN_MARKER);

      // One collapsed run below the window and one above it.
      expect(markers).toHaveLength(2);

      for (const marker of markers) {
        expect(enclosingListItem(marker)).toHaveAttribute('aria-hidden', 'true');
      }

      // Nine items are rendered, and exactly the seven that address something are announced -
      // so the item count a screen reader reports equals the number of pages actually offered.
      expect(landmark.querySelectorAll('li')).toHaveLength(9);
      expect(within(landmark).getAllByRole('listitem')).toHaveLength(7);
    });

    it('renders nothing when one page holds the whole collection', () => {
      // An empty landmark is noise in a landmark list, and a single-page result has nothing to
      // navigate. `post-list.tsx` also guards on `pages > 1`, so this is defence in depth.
      const { container } = render(<Pagination page={1} pages={1} total={4} page_size={10} />);

      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole('navigation')).toBeNull();
    });

    it('renders nothing for an empty collection', () => {
      // The service reports `pages: 0` for an empty collection rather than `1`, so a zero page
      // count is an ordinary answer this control has to absorb without emitting a bare landmark.
      const { container } = render(<Pagination page={1} pages={0} total={0} page_size={10} />);

      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole('link')).toBeNull();
    });

    it('renders identically at either bound of the service window, deriving nothing from it', () => {
      // The envelope fixture carries the service's DEFAULT window, and this case is what keeps that a
      // documented fact rather than a decorative one: the control accepts `page_size` because a whole
      // `Page<T>` spreads into it, and then uses it for nothing rendered - `pagination.tsx` says so of
      // both `total` and `page_size`. So the same page position must produce the same markup at 1 row
      // per page and at 100.
      expect(feedPage.page_size).toBe(FEED_PAGE_SIZE);
      expect(FEED_PAGE_SIZE).toBeGreaterThanOrEqual(MIN_PAGE_SIZE);
      expect(FEED_PAGE_SIZE).toBeLessThanOrEqual(MAX_PAGE_SIZE);

      const { container: narrow, unmount } = render(
        <Pagination page={2} pages={5} page_size={MIN_PAGE_SIZE} total={feedPage.total} />,
      );
      const narrowMarkup = narrow.innerHTML;
      unmount();

      const { container: wide } = render(
        <Pagination page={2} pages={5} page_size={MAX_PAGE_SIZE} total={feedPage.total} />,
      );

      // Markup equality is the assertion here rather than an assertion about WHAT the markup is: the
      // claim is indifference, and the day this control starts rendering a "showing 21-40 of 97" range
      // it will need cases of its own instead of inheriting a fixture value nobody checked.
      expect(wide.innerHTML).toBe(narrowMarkup);
    });
  });

  /*
   * `onPageChange` is enhancement LAYERED ON a working anchor, never a replacement for one. Each
   * test below therefore asserts the callback AND the surviving href together: a suite that
   * checked only the callback would pass just as happily against a `<button onClick>`, which is
   * the exact regression this file exists to prevent.
   */
  describe('progressive enhancement', () => {
    it('reports the target page to onPageChange without disturbing the anchor', () => {
      const onPageChange = vi.fn();

      render(
        <Pagination
          onPageChange={onPageChange}
          page={2}
          pages={5}
          page_size={FEED_PAGE_SIZE}
          total={feedPage.total}
        />,
      );

      const target = screen.getByRole('link', { name: 'Page 3' });

      fireEvent.click(target);

      expect(onPageChange).toHaveBeenCalledTimes(1);
      expect(onPageChange).toHaveBeenCalledWith(3);

      // The half that matters: the handler did not replace the link. The destination is still in
      // the markup after the click, exactly as it was before.
      expect(target).toHaveAttribute('href', '/?page=3');
      expect(pageAddressedBy(target)).toBe(3);
    });

    it('reports the neighbouring page from each edge control', () => {
      routerState.query = 'q=fastapi';

      const onPageChange = vi.fn();

      render(
        <Pagination
          onPageChange={onPageChange}
          page={3}
          pages={5}
          page_size={FEED_PAGE_SIZE}
          total={feedPage.total}
        />,
      );

      fireEvent.click(screen.getByRole('link', { name: 'Previous page' }));
      expect(onPageChange).toHaveBeenLastCalledWith(2);

      fireEvent.click(screen.getByRole('link', { name: 'Next page' }));
      expect(onPageChange).toHaveBeenLastCalledWith(4);

      expect(onPageChange).toHaveBeenCalledTimes(2);

      // And both still carry a destination that preserves the reader's search term.
      expect(screen.getByRole('link', { name: 'Previous page' })).toHaveAttribute(
        'href',
        '/?q=fastapi&page=2',
      );
      expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute(
        'href',
        '/?q=fastapi&page=4',
      );
    });

    it('never cancels the click, so the anchor performs the navigation', () => {
      const onPageChange = vi.fn();

      render(<Pagination onPageChange={onPageChange} page={2} pages={5} />);

      fireEvent.click(screen.getByRole('link', { name: 'Page 4' }));

      expect(onPageChange).toHaveBeenCalledWith(4);

      // Observed on the bubble phase, after React's handler has already run: `false` means
      // nothing in the component tree called `preventDefault()`. A `preventDefault()` in that
      // handler would take back everything the anchor was chosen for - the browser would never
      // follow the link, and the control would be a button wearing an anchor's markup.
      expect(lastClick.cancelledBeforeDocument).toBe(false);
    });

    it('performs no imperative navigation of its own', () => {
      const onPageChange = vi.fn();

      render(<Pagination onPageChange={onPageChange} page={2} pages={5} />);

      fireEvent.click(screen.getByRole('link', { name: 'Page 3' }));
      fireEvent.click(screen.getByRole('link', { name: 'Next page' }));

      expect(onPageChange).toHaveBeenCalledTimes(2);

      // The anchor IS the navigation. A control that also routed programmatically would run two
      // transitions for one click, leaving two history entries and a back button that appears
      // dead - which is precisely why `usePagination`'s `goToPage` must never be passed as
      // `onPageChange`.
      for (const spy of Object.values(routerSpies)) {
        expect(spy).not.toHaveBeenCalled();
      }
    });

    it('renders and stays clickable with no callback supplied', () => {
      // The server-rendered feed and profile pass no callback at all: a function is not
      // serializable, so a Server Component cannot. The links must work regardless.
      render(<Pagination page={2} pages={5} total={feedPage.total} page_size={FEED_PAGE_SIZE} />);

      const target = screen.getByRole('link', { name: 'Page 3' });

      expect(target).toHaveAttribute('href', '/?page=3');
      expect(() => {
        fireEvent.click(target);
      }).not.toThrow();

      expect(target).toHaveAttribute('href', '/?page=3');
      expect(lastClick.cancelledBeforeDocument).toBe(false);

      for (const spy of Object.values(routerSpies)) {
        expect(spy).not.toHaveBeenCalled();
      }
    });
  });
});
