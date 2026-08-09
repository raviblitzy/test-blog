/**
 * Component tests for `src/components/blog/search-input.tsx` — the home feed's free-text search
 * control, and the sole writer of the feed's `q` search parameter.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS UNDER TEST, AND WHAT DELIBERATELY IS NOT
 *
 * The search feature is split across two modules, and the split is the reason this file can assert
 * the *whole* search contract with nothing but a router spy and fake timers:
 *
 *   * `src/hooks/use-debounced-value.ts` DEBOUNCES. It is generic over its value, knows nothing
 *     about search, URLs or the API, and never navigates. It is covered on its own terms.
 *   * `src/components/blog/search-input.tsx` NAVIGATES. It takes what the hook returns and writes
 *     the settled term into the query string.
 *
 * So every assertion below is about a NAVIGATION — the href the control asks the router for — and
 * never about a timer internal to the hook, which this file only ever advances.
 *
 * ---------------------------------------------------------------------------
 * NO HTTP IS PERFORMED, SO NONE IS MOCKED
 *
 * The control holds no result state, reads no environment variable and imports nothing from
 * `src/lib/api/*`. Changing the URL *is* the mechanism: the feed's Server Component re-renders for
 * the new parameters and fetches the ranked results through the API layer, which is the only tier
 * permitted to perform HTTP.
 *
 * There is therefore no request interception here — no `setupServer`, no handler list, no endpoint
 * stub — and no assertion about a request. If this suite ever reports an unhandled request, the
 * control has started reaching the network and that is a defect in the control, not a gap in this
 * file to be papered over with a handler.
 *
 * ---------------------------------------------------------------------------
 * NOT ONE CLASS NAME IS ASSERTED
 *
 * Every value the control renders resolves to a design token, and the token layer owns those class
 * names and is free to change them: a palette edit, a spacing change or a `tailwind-merge`
 * resolution order must never fail a test. So there is no `toHaveClass`, no `className` read, no
 * class-based `querySelector`, no `getComputedStyle` and no snapshot anywhere below.
 *
 * The single `querySelectorAll('svg')` call is a tag query used to assert an ACCESSIBILITY attribute
 * (`aria-hidden`) on the decorative glyphs, which carry no ARIA role and so cannot be reached by
 * `getByRole` at all. Nothing about presentation is inspected.
 *
 * Everything else is queried the way a reader meets it: by accessible name, by role, by placeholder
 * and by value.
 *
 * ---------------------------------------------------------------------------
 * TWO CONTRACT FACTS WORTH STATING UP FRONT
 *
 *   1. The control calls `router.replace`, NEVER `router.push`. Debounced typing through `push`
 *      would deposit one history entry per keystroke pause, so Back would walk the reader backwards
 *      through "f", "fa", "fas" instead of leaving the feed. `push` is spied on precisely so its
 *      absence is asserted rather than assumed.
 *   2. The field is `<input type="search">`, whose ARIA role is `searchbox` — not `textbox`. That is
 *      the semantic the control wants (a search key on mobile keyboards, and a search box announced
 *      as one), so `searchbox` is the role queried throughout and `textbox` is asserted absent.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The unit under test. It is imported here, above the `vi.mock` call below, because Vitest hoists
// every `vi.mock` and `vi.hoisted` call above the whole import block during transform — so the
// navigation mock is installed before this module evaluates, while the file still reads top-down and
// keeps every import in one place.
import { SearchInput } from '@/components/blog/search-input';

/* -------------------------------------------------------------------------- */
/* Types for the navigation harness                                           */
/* -------------------------------------------------------------------------- */

/**
 * The navigation options this control passes, mirrored locally rather than imported.
 *
 * Next.js does not publish this shape from `next/navigation`, and reaching into its internals for
 * it would couple this suite to a private path. Declaring the one option the control actually uses
 * keeps the spies fully typed with no `any` and no fragile deep import.
 */
interface NavigateOptions {
  /** `false` keeps the viewport on the results instead of jumping to the top of the document. */
  scroll?: boolean;
}

/**
 * Signature of `router.push` and `router.replace`.
 *
 * Naming it once and handing it to `vi.fn<…>()` is what makes `replace.mock.calls` a typed tuple
 * rather than an implicit `any[]`, so `lastNavigation` can destructure the href and the options with
 * no cast and no `any` anywhere in this file.
 */
type NavigateFn = (href: string, options?: NavigateOptions) => void;

/** Signature of `router.prefetch`. */
type PrefetchFn = (href: string) => void;

/** Signature of `router.back`, `router.forward` and `router.refresh`. */
type HistoryFn = () => void;

/* -------------------------------------------------------------------------- */
/* The navigation harness                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Hoisted App Router state.
 *
 * `vi.mock` factories run before the module body is evaluated, so anything a factory references has
 * to be created by `vi.hoisted` or it is still in its temporal dead zone. Everything the mock needs
 * therefore lives in here: the pathname, the mutable search parameters, and the router spies.
 *
 * `params` is held as a single instance that a test REPLACES rather than mutates, so
 * `useSearchParams()` returns a referentially stable object across renders exactly as the real
 * router does. Returning a freshly built `URLSearchParams` on every call would instead invalidate
 * the control's `useCallback` on every render — a difference this suite must not invent.
 */
const nav = vi.hoisted(() => ({
  /** The route the feed is mounted on. */
  pathname: '/',

  /**
   * Swapped wholesale by a test before it renders; reset in `beforeEach`.
   *
   * Held behind a container object rather than as a bare property so the swap is a write to a
   * mutable field the mock reads on every call, which is what lets a test choose the incoming query
   * string without re-registering the module mock.
   */
  state: { params: new URLSearchParams() },

  /**
   * All six methods of the router, so the mock is a complete router rather than a partial one that
   * throws the moment a dependency reaches for an affordance this control does not use.
   */
  router: {
    push: vi.fn<NavigateFn>(),
    replace: vi.fn<NavigateFn>(),
    prefetch: vi.fn<PrefetchFn>(),
    back: vi.fn<HistoryFn>(),
    forward: vi.fn<HistoryFn>(),
    refresh: vi.fn<HistoryFn>(),
  },
}));

/**
 * jsdom has no App Router context, so the three navigation hooks are supplied here.
 *
 * `useSearchParams` returns a real `URLSearchParams`, not a stub, so `.get()`, `.has()` and
 * `.toString()` behave exactly as they do in the browser — which matters, because the control's
 * "preserve every other parameter" guarantee is implemented by copying `.toString()`.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.state.params,
}));

/* -------------------------------------------------------------------------- */
/* Contract constants, mirrored from the modules under test                   */
/* -------------------------------------------------------------------------- */

/** Mirrors `DEFAULT_LABEL` in the control: the field's accessible name when none is supplied. */
const DEFAULT_LABEL = 'Search posts';

/** Mirrors `DEFAULT_PLACEHOLDER` in the control. Deliberately not equal to the label. */
const DEFAULT_PLACEHOLDER = 'Search posts by title or content';

/** The clear affordance's accessible name — real `sr-only` text, not an invented `aria-label`. */
const CLEAR_LABEL = 'Clear search';

/**
 * Mirrors `DEFAULT_DEBOUNCE_DELAY_MS` in `src/hooks/use-debounced-value.ts`.
 *
 * The control passes `delayMs` through as `undefined` when a caller omits it, so the hook's own
 * default is the effective window and this is the number a test must advance past.
 */
const DEFAULT_DELAY_MS = 300;

/** A window well short of {@link DEFAULT_DELAY_MS}, used to type "inside" the quiet period. */
const PARTIAL_DELAY_MS = 100;

/**
 * Base used only to turn a relative href into a parsable `URL`.
 *
 * The control emits root-relative hrefs (`/?q=…`), which `new URL()` cannot parse alone. Nothing is
 * asserted about the origin itself.
 */
const ASSERTION_ORIGIN = 'http://localhost';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Advance the debounce and let React flush whatever state change results.
 *
 * The debounce is a real `setTimeout` inside the hook, so it is driven by fake timers rather than by
 * sleeping: a real wait would make this suite slow and flaky at once. The `act` wrapper is what
 * turns the resulting `setState` into a completed render before the next assertion runs — without
 * it React warns, and the assertion reads stale output.
 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

/**
 * The one search field the control renders.
 *
 * Queried by role rather than by test id or by markup position, so the query passes only while the
 * field is genuinely exposed as a search box to assistive technology.
 */
function searchField(): HTMLElement {
  return screen.getByRole('searchbox');
}

/** The clear affordance, queried by the accessible name a reader actually hears. */
function clearButton(): HTMLElement {
  return screen.getByRole('button', { name: CLEAR_LABEL });
}

/**
 * Type a term into the field.
 *
 * `fireEvent.change` rather than a per-character helper: `@testing-library/user-event` is not part
 * of the pinned dependency set, and a controlled input only ever observes the resulting `change`,
 * so this is the same event React sees in the browser.
 */
function typeTerm(term: string): void {
  fireEvent.change(searchField(), { target: { value: term } });
}

/**
 * The most recent navigation the control asked for, parsed.
 *
 * The href is deliberately never compared as a string: `URLSearchParams` has no defined ordering
 * guarantee that a test should depend on, so a string comparison would fail the day a parameter is
 * added or reordered even though the contract still held. Reading `searchParams` instead makes every
 * assertion order-independent, and distinguishes an ABSENT parameter from an empty one — which is
 * the whole point of the "no `?q=`" rule.
 */
function lastNavigation(): { url: URL; options: NavigateOptions | undefined } {
  const call = nav.router.replace.mock.calls.at(-1);

  if (call === undefined) {
    throw new Error('Expected the control to have navigated, but router.replace was never called.');
  }

  const [href, options] = call;

  return { url: new URL(href, ASSERTION_ORIGIN), options };
}

/** Every parameter name the last navigation carried, for asserting a parameter is gone. */
function lastNavigationParamNames(): string[] {
  return Array.from(lastNavigation().url.searchParams.keys());
}

beforeEach(() => {
  // A fresh, empty query string unless the test under way seeds one. Replaced rather than cleared so
  // no instance leaks between tests.
  nav.state.params = new URLSearchParams();

  // `clearAllMocks` resets recorded calls and keeps implementations, which is what the shared jsdom
  // stubs in vitest.setup.ts need; `resetAllMocks` would strip `matchMedia`'s implementation.
  vi.clearAllMocks();

  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SearchInput', () => {
  /* ------------------------------------------------------------------------ */
  /* Accessibility                                                            */
  /* ------------------------------------------------------------------------ */

  describe('accessibility', () => {
    it('associates the field with a real label rather than an invented aria-label', () => {
      render(<SearchInput />);

      // Two independent routes to the same element. `getByLabelText` proves the `<label for>`
      // association exists at all; `getByRole` with a name proves that association is what the
      // accessibility tree actually computes as the field's name. Either alone can pass while the
      // other fails — an `aria-label` satisfies the second and not the first — so both are asserted,
      // and they must land on the one element.
      const byLabelText = screen.getByLabelText(DEFAULT_LABEL);
      const byRole = screen.getByRole('searchbox', { name: DEFAULT_LABEL });

      expect(byRole).toBe(byLabelText);
    });

    it('exposes the field as a search box and not as a plain text box', () => {
      render(<SearchInput />);

      // `type="search"` is the semantic the control chooses on purpose: the field takes the
      // `searchbox` role and mobile keyboards offer a search key. Downgrading it to `type="text"`
      // would silently lose both, and this pair of assertions is what makes that visible.
      expect(searchField()).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).toBeNull();

      // The form is promoted to a search landmark, so assistive technology can jump straight to it.
      expect(screen.getByRole('search')).toBeInTheDocument();
    });

    it('accepts an overriding label so two search surfaces can be told apart', () => {
      const label = 'Search your drafts';

      render(<SearchInput label={label} />);

      expect(screen.getByRole('searchbox', { name: label })).toBe(screen.getByLabelText(label));
      expect(screen.queryByLabelText(DEFAULT_LABEL)).toBeNull();
    });

    it('renders the default placeholder as a hint distinct from the label', () => {
      render(<SearchInput />);

      // A placeholder is a hint about what to type; the label states what the control is. They are
      // deliberately different strings, and the placeholder is never the accessible name.
      expect(screen.getByPlaceholderText(DEFAULT_PLACEHOLDER)).toBe(searchField());
      expect(searchField()).toHaveAccessibleName(DEFAULT_LABEL);
    });

    it('renders a supplied placeholder', () => {
      const placeholder = 'Search by title, tag or author';

      render(<SearchInput placeholder={placeholder} />);

      expect(screen.getByPlaceholderText(placeholder)).toBe(searchField());
    });

    it('keeps both decorative glyphs out of the accessibility tree', () => {
      // Seeded so the clear affordance — and therefore its glyph — is rendered alongside the search
      // glyph, and both are covered by one assertion.
      nav.state.params = new URLSearchParams('q=fastapi');

      const { container } = render(<SearchInput />);

      // A tag query, not a class query: an `<svg>` carries no implicit ARIA role, so `getByRole`
      // cannot reach it and the only way to assert it is hidden is to read the attribute that hides
      // it. Nothing about presentation is inspected here.
      const glyphs = Array.from(container.querySelectorAll('svg'));

      expect(glyphs).toHaveLength(2);

      for (const glyph of glyphs) {
        expect(glyph).toHaveAttribute('aria-hidden', 'true');
      }

      // Neither glyph is exposed as an image, even when hidden elements are included in the query.
      expect(screen.queryAllByRole('img', { hidden: true })).toHaveLength(0);

      // And neither contributes to the name of the control it decorates: the field is named by its
      // label alone, the button by its own text alone.
      expect(searchField()).toHaveAccessibleName(DEFAULT_LABEL);
      expect(clearButton()).toHaveAccessibleName(CLEAR_LABEL);
    });
  });

  /* ------------------------------------------------------------------------ */
  /* Debounced navigation                                                     */
  /* ------------------------------------------------------------------------ */

  describe('debounced navigation', () => {
    it('hydrates the field from the URL so a shared search link is correct on first paint', () => {
      nav.state.params = new URLSearchParams('q=fastapi');

      render(<SearchInput />);

      expect(searchField()).toHaveValue('fastapi');
    });

    it('navigates nowhere on mount, leaving a deep-linked page intact', async () => {
      // The URL a reader can be sent: a term AND a page. Re-writing it on mount would strip the page
      // out from under them, so arriving is silent even though the field is populated.
      nav.state.params = new URLSearchParams('q=fastapi&page=3');

      render(<SearchInput />);
      await advance(DEFAULT_DELAY_MS * 2);

      expect(nav.router.replace).not.toHaveBeenCalled();
      expect(nav.router.push).not.toHaveBeenCalled();
    });

    it('does not navigate while the reader is still typing', () => {
      render(<SearchInput />);

      typeTerm('fast');

      // Timers are deliberately NOT advanced. A control that navigated here would drive one request
      // per keystroke, which is precisely what the debounce exists to prevent.
      expect(nav.router.replace).not.toHaveBeenCalled();
      expect(searchField()).toHaveValue('fast');
    });

    it('navigates exactly once, with the term and without scrolling, after the quiet period', async () => {
      render(<SearchInput />);

      typeTerm('fastapi');
      await advance(DEFAULT_DELAY_MS);

      expect(nav.router.replace).toHaveBeenCalledTimes(1);

      const { url, options } = lastNavigation();

      expect(url.pathname).toBe(nav.pathname);
      expect(url.searchParams.get('q')).toBe('fastapi');

      // `scroll: false` keeps the viewport on the results. Omitting it would yank the reader to the
      // top of the document at every keystroke pause.
      expect(options).toEqual({ scroll: false });
    });

    it('collapses rapid typing into a single navigation carrying the final term', async () => {
      render(<SearchInput />);

      // Three edits, each landing inside the previous one's quiet period, so each cancels its
      // predecessor's pending commit instead of queueing a second one. This is the difference between
      // a debounce and a throttle, and it is the single most valuable assertion in this file.
      typeTerm('fa');
      await advance(PARTIAL_DELAY_MS);

      typeTerm('fast');
      await advance(PARTIAL_DELAY_MS);

      typeTerm('fastapi');
      expect(nav.router.replace).not.toHaveBeenCalled();

      await advance(DEFAULT_DELAY_MS);

      expect(nav.router.replace).toHaveBeenCalledTimes(1);
      expect(lastNavigation().url.searchParams.get('q')).toBe('fastapi');
    });

    it('preserves every sibling parameter it does not own', async () => {
      // `category` belongs to the category filter and `sort` to the feed's ordering control. This
      // control reads neither and must clobber neither: the failure is invisible in isolation and
      // only shows up when a reader uses two controls together.
      nav.state.params = new URLSearchParams('category=engineering&sort=relevance');

      render(<SearchInput />);
      typeTerm('postgres');
      await advance(DEFAULT_DELAY_MS);

      const { url } = lastNavigation();

      expect(url.searchParams.get('q')).toBe('postgres');
      expect(url.searchParams.get('category')).toBe('engineering');
      expect(url.searchParams.get('sort')).toBe('relevance');
    });

    it('drops the page parameter, because a new term invalidates the old position', async () => {
      nav.state.params = new URLSearchParams('page=3&category=engineering');

      render(<SearchInput />);
      typeTerm('postgres');
      await advance(DEFAULT_DELAY_MS);

      const { url } = lastNavigation();

      // Deleted outright rather than rewritten to `page=1`: the pagination control omits the
      // parameter for the first page, so the two agree on one canonical shape for "page one". A
      // search that stranded the reader on page 3 of a shorter result set is the bug this guards.
      expect(url.searchParams.has('page')).toBe(false);
      expect(url.searchParams.get('q')).toBe('postgres');
      expect(url.searchParams.get('category')).toBe('engineering');
    });

    it('removes the term entirely rather than leaving an empty parameter', async () => {
      nav.state.params = new URLSearchParams('q=fastapi&category=engineering');

      render(<SearchInput />);
      typeTerm('');
      await advance(DEFAULT_DELAY_MS);

      const { url } = lastNavigation();

      // `has` is the assertion that matters: a trailing `?q=` would satisfy a `get(...) === ''`
      // check while being a second, distinct crawlable URL for one unfiltered result set.
      expect(url.searchParams.has('q')).toBe(false);
      expect(url.searchParams.get('category')).toBe('engineering');
    });

    it('honours a caller-supplied delay instead of the hook default', async () => {
      const delayMs = 1_000;

      render(<SearchInput delayMs={delayMs} />);
      typeTerm('dark mode');

      // Past the hook's own default, and still short of the supplied window.
      await advance(delayMs - 1);
      expect(nav.router.replace).not.toHaveBeenCalled();

      await advance(1);
      expect(nav.router.replace).toHaveBeenCalledTimes(1);

      // Round-tripped through `URLSearchParams`, so the space survives encoding.
      expect(lastNavigation().url.searchParams.get('q')).toBe('dark mode');
    });

    it('searches immediately on submit, without a second navigation from the pending debounce', async () => {
      render(<SearchInput />);
      typeTerm('postgres');

      // Pressing Enter is an explicit instruction, so waiting out the quiet period would be wrong.
      fireEvent.submit(screen.getByRole('search'));

      expect(nav.router.replace).toHaveBeenCalledTimes(1);
      expect(lastNavigation().url.searchParams.get('q')).toBe('postgres');

      // The submit consumed the reader's intent, so the timer still in flight commits nothing.
      await advance(DEFAULT_DELAY_MS * 2);
      expect(nav.router.replace).toHaveBeenCalledTimes(1);
    });

    it('never navigates after unmounting mid-window', async () => {
      const { unmount } = render(<SearchInput />);

      typeTerm('postgres');
      unmount();

      // The hook clears its pending timer on unmount. Without that, a stale term would land after
      // the reader had already navigated elsewhere, replacing the URL of whatever page they reached.
      await advance(DEFAULT_DELAY_MS * 2);

      expect(nav.router.replace).not.toHaveBeenCalled();
    });

    it('writes the URL through replace only, touching no other router affordance', async () => {
      render(<SearchInput />);

      typeTerm('fastapi');
      await advance(DEFAULT_DELAY_MS);

      expect(nav.router.replace).toHaveBeenCalledTimes(1);

      // `push` would deposit one history entry per keystroke pause, so Back would walk the reader
      // backwards through their own typing instead of leaving the feed.
      expect(nav.router.push).not.toHaveBeenCalled();
      expect(nav.router.prefetch).not.toHaveBeenCalled();
      expect(nav.router.back).not.toHaveBeenCalled();
      expect(nav.router.forward).not.toHaveBeenCalled();
      expect(nav.router.refresh).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------------ */
  /* Clear                                                                    */
  /* ------------------------------------------------------------------------ */

  describe('clear', () => {
    it('offers no clear affordance while the field is empty', () => {
      render(<SearchInput />);

      expect(screen.queryByRole('button', { name: CLEAR_LABEL })).toBeNull();
    });

    it('offers a named clear affordance once the field has a term', () => {
      render(<SearchInput />);

      typeTerm('fastapi');

      // Named with real text rather than a bare glyph, so a reader hears what the control does
      // instead of hearing nothing.
      expect(clearButton()).toBeInTheDocument();
    });

    it('empties the field and drops the term at once, without waiting out the debounce', async () => {
      nav.state.params = new URLSearchParams('q=fastapi&category=engineering&page=3');

      render(<SearchInput />);
      fireEvent.click(clearButton());

      // Immediate on purpose: a cleared box sitting above stale filtered results for another quiet
      // period reads as a bug.
      expect(nav.router.replace).toHaveBeenCalledTimes(1);
      expect(searchField()).toHaveValue('');

      const { url, options } = lastNavigation();

      expect(url.searchParams.has('q')).toBe(false);
      expect(url.searchParams.has('page')).toBe(false);
      expect(url.searchParams.get('category')).toBe('engineering');
      expect(options).toEqual({ scroll: false });

      // Clearing consumed the intent, so nothing else commits when the window elapses.
      await advance(DEFAULT_DELAY_MS * 2);
      expect(nav.router.replace).toHaveBeenCalledTimes(1);
    });

    it('withdraws the clear affordance once there is nothing left to clear', () => {
      nav.state.params = new URLSearchParams('q=fastapi');

      render(<SearchInput />);
      fireEvent.click(clearButton());

      expect(screen.queryByRole('button', { name: CLEAR_LABEL })).toBeNull();

      // Focus returns to the field rather than falling to the document body, so a keyboard reader
      // stays exactly where they were, ready to type a new term.
      expect(searchField()).toHaveFocus();
    });

    it('lands on a bare path when clearing the only parameter', () => {
      nav.state.params = new URLSearchParams('q=fastapi');

      render(<SearchInput />);
      fireEvent.click(clearButton());

      // No parameter survives, so the href carries no query string at all — `/`, never `/?`.
      expect(lastNavigation().url.pathname).toBe(nav.pathname);
      expect(lastNavigationParamNames()).toHaveLength(0);
    });

    it('clears a term the reader typed but never committed', async () => {
      render(<SearchInput />);

      typeTerm('postgres');
      fireEvent.click(clearButton());

      expect(searchField()).toHaveValue('');

      // The typed term was never in the URL, so clearing it has nothing to write: the query string
      // is already the one the control would produce, and the no-op guard suppresses the navigation.
      expect(nav.router.replace).not.toHaveBeenCalled();

      // And the timer left over from that typing commits nothing either.
      await advance(DEFAULT_DELAY_MS * 2);
      expect(nav.router.replace).not.toHaveBeenCalled();
    });
  });
});
