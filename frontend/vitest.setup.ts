/**
 * Vitest bootstrap for the frontend component-test suite.
 *
 * `frontend/vitest.config.mts` names this module as its only `setupFiles` entry,
 * so every statement below runs once per test file, before that file's own
 * modules are evaluated.
 *
 * The suite it prepares is a blocking gate: `make test` runs
 * `npm run test -- --run`, and the CI workflow fails the build on the result. A
 * gate whose outcome depends on ambient machine state - a stray dev server, a
 * developer's `.env.local`, a reachable network - proves nothing, so this module
 * pins each of those inputs rather than hoping they are absent.
 *
 * Five responsibilities, in the order they appear below:
 *
 *   1. Register the jest-dom matchers, so a test can assert on an accessible
 *      name or on visible text instead of on markup structure. Styling and
 *      design-token changes must never be able to break a test.
 *   2. Pin the public runtime configuration, so no test reads a developer's
 *      environment.
 *   3. Own the Mock Service Worker lifecycle, intercepting HTTP at the network
 *      boundary.
 *   4. Unmount every rendered tree between tests.
 *   5. Fill in the browser APIs jsdom does not implement.
 *
 * Deliberately absent, and not to be added:
 *
 *   - Any mock of `fetch` or of `src/lib/api/client.ts`. That client is the only
 *     module in the frontend permitted to perform HTTP, and it owns token
 *     attachment, refresh-on-401 and error normalisation. Mocking it - or the
 *     `fetch` beneath it - would retire exactly the logic most worth covering.
 *     Requests are intercepted one layer lower instead, so the real client runs.
 *   - Any silencing of `console`. A suppressed React hydration warning is
 *     precisely the defect the dark-mode journey exists to catch.
 *   - Any class-name matcher or snapshot serialiser. Tests assert on behaviour
 *     and on accessible names; class names belong to the token layer and are
 *     free to change without a test noticing.
 *   - Anything Playwright-related. `tests/e2e/**` is a separate runner with a
 *     separate lifecycle, and `vitest.config.mts` already excludes it.
 */

// 1. DOM assertion matchers. The `/vitest` subpath extends Vitest's `expect`;
// the bare `@testing-library/jest-dom` entry point extends Jest's and would
// register nothing here, leaving `toHaveAccessibleName`, `toBeVisible` and the
// rest undefined at the point a test tries to use them. This import has to stay
// above the others so the matchers exist before anything can assert with them.
import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';

// `tests/` sits outside `src/`, and the only alias `vitest.config.mts` declares
// is `@` -> `./src/`. This import therefore has to stay relative; `@/tests/...`
// does not resolve.
import { handlers } from './tests/msw/handlers';

/* -------------------------------------------------------------------------- */
/* 2. Hermetic public configuration                                           */
/* -------------------------------------------------------------------------- */

/*
 * The three `NEXT_PUBLIC_*` values, fixed to what `.env.example` documents.
 *
 * These are assigned unconditionally rather than defaulted, on purpose: a
 * developer's `frontend/.env.local` must not be able to change the outcome of a
 * gate. Neither URL can reach a real service from a component test, because MSW
 * is started with `onUnhandledRequest: 'error'` below and so raises instead of
 * opening a socket.
 *
 * The base URL carries the `/api/v1` prefix, matching the contract: client code
 * appends paths such as `/posts` to it and never repeats the prefix.
 *
 * Note that ES module imports are hoisted, so `./tests/msw/handlers` is
 * evaluated before these assignments run. A handler module that reads the base
 * URL at module scope therefore has to carry the same documented default
 * itself - which is why the values here are the documented ones rather than
 * invented test hostnames.
 */
process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:8000/api/v1';
process.env.NEXT_PUBLIC_SITE_URL = 'http://localhost:3000';
process.env.NEXT_PUBLIC_SITE_NAME = 'Modern Blog';

/* -------------------------------------------------------------------------- */
/* 3. Mock Service Worker lifecycle                                           */
/* -------------------------------------------------------------------------- */

/**
 * The single request-interception server shared by every component test.
 *
 * Exported so an individual test can narrow behaviour for itself with
 * `server.use(...)` - an error status, a delay, a specific payload. Those
 * overrides are discarded after each test by the `resetHandlers` hook below, so
 * one test can never inherit another's mock.
 */
export const server = setupServer(...handlers);

beforeAll(() => {
  // `'error'` is the point of this line and must not be relaxed to `'warn'` or
  // `'bypass'`. An unhandled request means a component reached for the network
  // with no mock behind it, which under a blocking gate has to fail loudly
  // rather than pass quietly. It also keeps the suite honest about the API
  // client being the only module allowed to perform HTTP: anything else that
  // quietly fetches surfaces here as a failure.
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

/* -------------------------------------------------------------------------- */
/* 4. Rendered-tree cleanup                                                   */
/* -------------------------------------------------------------------------- */

/*
 * Unmount anything a test rendered.
 *
 * Testing Library registers this for itself only when Vitest runs with
 * `globals: true`. That is set today, but depending on it would mean a later
 * config change silently starts leaking DOM between tests, where the symptom is
 * an unrelated `getByRole` failing with "found multiple elements" rather than
 * anything that points at the cause. Registering it here makes the guarantee
 * explicit, and it is idempotent - a second `cleanup()` on an already-unmounted
 * tree is a no-op.
 *
 * This is a separate hook from `resetHandlers` above so that a throw in either
 * cannot skip the other. The two touch disjoint state - the DOM and MSW's
 * handler registry - and both are synchronous, so their relative order carries
 * no meaning.
 */
afterEach(() => {
  cleanup();
});

/* -------------------------------------------------------------------------- */
/* 5. Browser APIs jsdom 30 does not implement                                */
/* -------------------------------------------------------------------------- */

/*
 * Every stub below exists for a named package in the pinned dependency set,
 * recorded beside it so a future reader can delete the stub outright once its
 * consumer is gone. Nothing here is speculative, and each stub is wrapped in a
 * presence check so this file stays correct if a later jsdom implements the API
 * natively.
 *
 * The globals are installed on `window`, which in Vitest's jsdom environment is
 * the same object as `globalThis`. A library that references a bare
 * `ResizeObserver` therefore resolves to the stub.
 */

/**
 * `matchMedia` - `next-themes` resolves the system colour-scheme preference
 * through it, and `sonner` uses it to honour reduced-motion. Without it, every
 * test that renders through the theme provider or the toast host throws.
 */
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = vi.fn((query: string): MediaQueryList => ({
    // Fixing this to `false` pins the system preference to light, which keeps
    // the resolved default theme deterministic. A test that cares about dark
    // mode sets the theme explicitly instead of depending on this value.
    matches: false,
    media: query,
    onchange: null,
    // The pre-EventTarget pair. Deprecated, but still called by libraries
    // that support older browsers, so both have to be present.
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  }));
}

/**
 * `ResizeObserver` - `@radix-ui/react-popper` and `@radix-ui/react-use-size`
 * measure a trigger and its floating content with it. Those are the packages
 * behind `@radix-ui/react-select` and, via `@radix-ui/react-menu`,
 * `@radix-ui/react-dropdown-menu`; Next.js also uses it internally.
 */
if (typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = class ResizeObserverStub implements ResizeObserver {
    // Parameters are omitted rather than declared-and-unused: the lint gate runs
    // with `--max-warnings=0` and grants no underscore exemption, and a narrower
    // signature still satisfies the wider DOM one.
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/**
 * `IntersectionObserver` - Next.js uses it for `next/link` prefetching and
 * `next/image` lazy loading (`next/dist/client/use-intersection`), both of which
 * a rendered post card reaches.
 */
if (typeof window.IntersectionObserver === 'undefined') {
  window.IntersectionObserver = class IntersectionObserverStub implements IntersectionObserver {
    readonly root: Element | Document | null = null;
    readonly rootMargin: string = '0px';
    readonly scrollMargin: string = '0px';
    readonly thresholds: ReadonlyArray<number> = [0];

    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}

    // Nothing is ever observed, so there is genuinely nothing to report.
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  };
}

/**
 * `scrollIntoView` - `@radix-ui/react-select` scrolls the highlighted item into
 * view as the keyboard moves through the list.
 */
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

/**
 * Pointer capture - `@radix-ui/react-select` checks for and releases pointer
 * capture while a drag passes across its items. `setPointerCapture` is the
 * counterpart of the two calls the primitive makes, kept so a path that captures
 * before releasing cannot fall through to an undefined method.
 */
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  // `false` is the truthful answer in an environment that never captures, and it
  // is the branch the primitive is written to handle.
  Element.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
    return false;
  };
}

if (typeof Element.prototype.setPointerCapture !== 'function') {
  Element.prototype.setPointerCapture = function setPointerCapture(): void {};
}

if (typeof Element.prototype.releasePointerCapture !== 'function') {
  Element.prototype.releasePointerCapture = function releasePointerCapture(): void {};
}

/**
 * `getBoundingClientRect` - jsdom does implement this and already reports the
 * zeroed geometry the Radix positioning logic needs, so the numbers are left
 * exactly as jsdom reports them and no layout defect can hide behind this block.
 * What jsdom returns is a plain object rather than a real `DOMRect`, though, so
 * `toJSON` is missing; only that gap is closed, and only when it is genuinely
 * absent.
 */
if (typeof document.createElement('div').getBoundingClientRect().toJSON !== 'function') {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return new DOMRect(0, 0, 0, 0);
  };
}
