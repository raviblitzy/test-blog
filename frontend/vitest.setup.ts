/**
 * Vitest bootstrap for the frontend component-test suite.
 *
 * `frontend/vitest.config.ts` names this module as its only `setupFiles` entry,
 * so every statement below runs once per test file, before that file's own
 * modules are evaluated.
 *
 * The suite it prepares is a blocking gate: `make test` runs
 * `npm run test -- --run`, and the CI workflow fails the build on the result. A
 * gate whose outcome depends on ambient machine state - a stray dev server, a
 * developer's `.env.local`, a reachable network - proves nothing, so each of
 * those inputs is pinned rather than hoped to be absent.
 *
 * The public runtime configuration is pinned by `vitest.config.ts` through its
 * `test.env` block and NOT here, and that placement is load-bearing rather than
 * tidy: ES module imports are hoisted, so any assignment written in this file
 * would run *after* every module this file imports had already been evaluated,
 * and a module that reads `process.env.NEXT_PUBLIC_*` at its top level would
 * observe a developer's ambient value instead of the pinned one. Vitest applies
 * `test.env` before a setup file or a test module is evaluated, which makes that
 * block the single source of truth for the four values and makes the ordering
 * correct by construction rather than by convention.
 *
 * Three responsibilities, in the order they appear below:
 *
 *   1. Register the jest-dom matchers, so a test can assert on an accessible
 *      name or on visible text instead of on markup structure. Styling and
 *      design-token changes must never be able to break a test.
 *   2. Unmount every rendered tree between tests.
 *   3. Fill in the browser APIs jsdom does not implement.
 *
 * WHERE THE REQUEST-INTERCEPTION LIFECYCLE LIVES, AND WHY NOT HERE
 *
 * Component tests intercept HTTP at the network boundary with Mock Service
 * Worker rather than by mocking `fetch` or `src/lib/api/client.ts`, and `msw` is
 * pinned in package.json for exactly that. The server instance, its default
 * handler list and its `listen`/`resetHandlers`/`close` hooks all belong to the
 * test-support boundary that introduces `tests/**` alongside the first specs
 * that need them - not to this file.
 *
 * The distinction is not bookkeeping. Naming a module here that the test-support
 * boundary has not written yet makes this file the reason that module has to
 * exist, which inverts the dependency: an unresolved import fails every test
 * file at collection time, so the runner cannot be exercised at all until an
 * out-of-boundary path is materialised to satisfy it. This module therefore
 * imports nothing from `tests/`, and the suite it prepares is runnable on its own
 * from the moment the first spec lands.
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
 *     separate lifecycle, and `vitest.config.ts` already excludes it.
 */

// 1. DOM assertion matchers. The `/vitest` subpath extends Vitest's `expect`;
// the bare `@testing-library/jest-dom` entry point extends Jest's and would
// register nothing here, leaving `toHaveAccessibleName`, `toBeVisible` and the
// rest undefined at the point a test tries to use them. This import has to stay
// above the others so the matchers exist before anything can assert with them.
import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/* -------------------------------------------------------------------------- */
/* 2. Rendered-tree cleanup                                                   */
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
 * It is registered as a hook of its own rather than folded into any other
 * teardown this file might later gain, so that a throw elsewhere in teardown
 * cannot skip the unmount and leak a tree into the next test.
 */
afterEach(() => {
  cleanup();
});

/* -------------------------------------------------------------------------- */
/* 3. Browser APIs jsdom 30 does not implement                                */
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
