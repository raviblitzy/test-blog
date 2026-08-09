/**
 * Component test for `src/components/blog/share-bar.tsx` - the post page's share row.
 *
 * ---------------------------------------------------------------------------------------------
 * 1. THE UNIT, AND WHY THE ABSENCE OF A REQUEST IS PART OF ITS CONTRACT
 *
 * `ShareBar` is the only piece of the requested feature set that ships with no backend surface at
 * all: R4's "social sharing" is built entirely client-side from the post's canonical URL, so there
 * is no share endpoint, no share schema and no share migration. That makes "no HTTP happened" a
 * property worth protecting rather than an omission to apologise for, and this file protects it
 * structurally rather than by assertion:
 *
 *   - Nothing here mocks an endpoint, registers a request handler or spreads
 *     `tests/msw/handlers.ts` into a server. That module deliberately owns no server instance and
 *     no lifecycle, and a spec that stood one up for a component which issues no request would be
 *     asserting against scaffolding it had built itself.
 *   - The component's import graph reaches `@/lib/seo`, `@/components/ui/button`, `@/lib/utils`,
 *     `lucide-react` and `sonner`. It reaches no module under `@/lib/api`, which is the only place
 *     in the tier permitted to perform HTTP - so there is no code path from here to the network.
 *   - Were one to appear, it would fail loudly rather than pass quietly. `vitest.config.ts` pins
 *     `NEXT_PUBLIC_API_BASE_URL` to a loopback port nothing binds while this suite runs, so a
 *     stray request rejects on a refused connection and surfaces as a failure or an unhandled
 *     rejection.
 *
 * ---------------------------------------------------------------------------------------------
 * 2. `navigator.clipboard` AND `navigator.share` ARE DEFINED HERE, PER CASE - BY DESIGN
 *
 * `vitest.setup.ts` fills in a closed list of browser APIs: `matchMedia`, `ResizeObserver`,
 * `IntersectionObserver`, `scrollIntoView`, pointer capture and `DOMRect`. Neither clipboard nor
 * Web Share is on it, that list belongs to another file, and it must not be edited to accommodate
 * this one. Measured in this environment: both members are `undefined` and neither appears on
 * `Navigator.prototype`.
 *
 * That absence is the point. The component feature-detects both precisely because they are missing
 * here, missing on most desktop browsers, and - in the clipboard's case - missing on any real
 * browser served over plain `http:` from a non-localhost origin. So each capability is opted into
 * by the case that needs it, through {@link withClipboard} and {@link withWebShare}, and removed
 * again in `afterEach` by {@link forgetNavigatorCapabilities}. A case that opts into neither
 * therefore exercises the degradation path a real browser will take, and no case can leak a
 * fabricated browser into the next one.
 *
 * ---------------------------------------------------------------------------------------------
 * 3. NOT ONE CLASS NAME IS ASSERTED, AND NOT ONE ORIGIN IS SPELLED OUT
 *
 * Every assertion below targets an accessible name, a role, visible text, an `href` or an
 * accessibility attribute. There is no `toHaveClass`, no `className` read, no class-based
 * `querySelector`, no `getComputedStyle` and no snapshot - appearance belongs to the token layer
 * and is free to change without a test noticing.
 *
 * The canonical URL is likewise never written out. `NEXT_PUBLIC_SITE_URL` and
 * `NEXT_PUBLIC_SITE_NAME` are pinned with `vi.stubEnv` so the value is deterministic, and the
 * expectation is then produced by the same builder the component uses: `absoluteUrl` over
 * `postPath` from `@/lib/seo`, the tier's only reader of that variable and its only normalisation
 * point. A hard-coded origin in an expectation would silently stop testing the normalisation - the
 * trailing slash the builder strips, the host it lower-cases, the default port it drops - and would
 * start testing a string literal instead.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { ShareBar } from '@/components/blog/share-bar';
import { absoluteUrl, postPath } from '@/lib/seo';
import type { PostSummary } from '@/lib/types';

/*
 * The toast library, replaced by spies.
 *
 * `sonner` renders through a single `<Toaster />` host mounted in `src/app/layout.tsx`, which is
 * not part of this tree - so a real `toast(…)` call would produce no DOM and there would be
 * nothing honest to assert on. Mounting a second host here and asserting on its markup would test
 * `sonner` rather than `ShareBar`. Spying on the module is what proves the component's own
 * confirmation and failure paths ran, which is the behaviour this file owns.
 *
 * Only the two members the component calls are provided: it uses `toast.success` and `toast.error`
 * and never the callable form. Anything else it reached for would fail here as "not a function",
 * which is the correct outcome - this factory is the recorded contract, not a convenience.
 */
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);

/* -------------------------------------------------------------------------------------------------
 * Pinned configuration
 *
 * Inputs to the builder, never expectations. `vitest.config.ts` already pins both variables for the
 * whole suite; they are re-pinned here so this file's expectations cannot change meaning if that
 * block is ever re-tuned, and so the origin under test differs from the default and proves the
 * builder is genuinely being read rather than coincidentally agreeing.
 * ---------------------------------------------------------------------------------------------- */

/** Absolute, bare, `https:` - the only shape `normaliseSiteOrigin` accepts. */
const STUBBED_SITE_ORIGIN = 'https://example.test';

/** Required by `@/lib/seo`, which refuses to resolve a blank site name. */
const STUBBED_SITE_NAME = 'Example Blog';

/* -------------------------------------------------------------------------------------------------
 * Fixture
 *
 * Blog-domain values, typed off the wire contract. `Pick<PostSummary, …>` is what the component's
 * own props are built from, so a rename on either side of the API contract breaks this file at the
 * type level rather than at runtime.
 * ---------------------------------------------------------------------------------------------- */

const POST: Pick<PostSummary, 'slug' | 'title'> = {
  slug: 'scaling-fastapi-on-postgres',
  title: 'Scaling FastAPI on PostgreSQL',
};

/* -------------------------------------------------------------------------------------------------
 * The component's own copy, restated
 *
 * None of these strings is exported by the component - its public surface is the single component -
 * so they are declared here as the contract this file holds it to. A wording change is then a
 * deliberate two-file edit rather than a silently passing test.
 * ---------------------------------------------------------------------------------------------- */

/** Accessible name of the `<nav>` landmark wrapping the row. */
const GROUP_LABEL = 'Share this post';

/** Appended to each social link's accessible name, so a new-tab context switch is announced. */
const NEW_TAB_HINT = ' (opens in a new tab)';

/** Accessible name of the clipboard control, composed from its visible text alone. */
const COPY_LABEL = 'Copy link';

/** Accessible name of the Web Share control. Its visible text is the shorter "Share". */
const NATIVE_SHARE_LABEL = 'Share using your device';

const COPY_SUCCEEDED_MESSAGE = 'Link copied to your clipboard.';

const COPY_UNAVAILABLE_MESSAGE =
  'Copying is not available in this browser. The link is shown below - select it to copy.';

const COPY_FAILED_MESSAGE = 'The link could not be copied. It is shown below - select it to copy.';

const NATIVE_SHARE_FAILED_MESSAGE = 'Your device share sheet could not be opened.';

/**
 * The visually hidden preamble on the manual-copy fallback.
 *
 * Declared without the trailing space the component emits: Testing Library normalises an element's
 * text before matching, so the trimmed form is what a text query can actually find.
 */
const MANUAL_COPY_PREAMBLE = 'Copy this link manually:';

/* -------------------------------------------------------------------------------------------------
 * Share destinations, as this file expects to observe them
 *
 * One row per social control, describing what is observable from the outside: the accessible name
 * it is found by, the host it must reach, the query parameter carrying the canonical URL, and the
 * parameter carrying the title - or `null` where the platform ignores one, which is a decision the
 * component records and this file therefore verifies rather than assumes away.
 * ---------------------------------------------------------------------------------------------- */

interface ShareTargetExpectation {
  /** The control's visible text, and the whole of its accessible name bar {@link NEW_TAB_HINT}. */
  readonly label: string;

  /** Host the composed share URL must address. */
  readonly hostname: string;

  /** Query parameter that must carry the post's canonical URL, unencoded once parsed. */
  readonly urlParam: string;

  /**
   * Query parameter that must carry the post title, or `null` for a platform that ignores one.
   *
   * `null` is asserted as an absence rather than skipped: Facebook's `quote` and LinkedIn's legacy
   * `title`/`summary` parameters are dropped by those sharers, so passing the title would add a
   * dead parameter to every shared URL and promise the reader prefilled text they will not get.
   */
  readonly titleParam: string | null;
}

const SHARE_TARGETS: readonly ShareTargetExpectation[] = [
  {
    label: 'Share on X',
    // `twitter.com/intent/tweet` rather than `x.com/…`: the long-documented endpoint, which
    // redirects to the current host and so cannot 404 while a newer path settles.
    hostname: 'twitter.com',
    urlParam: 'url',
    titleParam: 'text',
  },
  {
    label: 'Share on Facebook',
    hostname: 'www.facebook.com',
    urlParam: 'u',
    titleParam: null,
  },
  {
    label: 'Share on LinkedIn',
    hostname: 'www.linkedin.com',
    urlParam: 'url',
    titleParam: null,
  },
];

/** The accessible name a social control is found by: its label plus the new-tab hint. */
function accessibleNameOf(target: ShareTargetExpectation): string {
  return `${target.label}${NEW_TAB_HINT}`;
}

/* -------------------------------------------------------------------------------------------------
 * Browser capabilities, opted into per case
 *
 * Each helper installs one API as an OWN property of `navigator` and hands back the spy, so a case
 * reads as an explicit statement about the browser it is describing. `configurable: true` is what
 * makes the installation reversible; `writable: true` mirrors how a real implementation appears.
 *
 * Both members are declared non-optional by `lib.dom.d.ts`, which describes the surface of a
 * complete browser rather than the presence of one in whatever actually loaded the module. The
 * narrow casts below are confined to these two helpers for exactly that reason - no `any` anywhere,
 * and no widening that leaks into an assertion.
 * ---------------------------------------------------------------------------------------------- */

/** Signature of `Clipboard.writeText`, narrowed to the one member the component calls. */
type WriteText = (data: string) => Promise<void>;

/** Signature of `Navigator.share`. */
type WebShare = (data?: ShareData) => Promise<void>;

/** The two capabilities this file installs. Named once so teardown cannot drift from setup. */
const OPTIONAL_NAVIGATOR_CAPABILITIES = ['clipboard', 'share'] as const;

/**
 * Install one optional capability on `navigator` for the duration of a single case.
 *
 * @param name - Member to define. Constrained to the two this file is allowed to touch.
 * @param value - The stand-in implementation.
 */
function defineNavigatorCapability(
  name: (typeof OPTIONAL_NAVIGATOR_CAPABILITIES)[number],
  value: unknown,
): void {
  Object.defineProperty(navigator, name, {
    value,
    configurable: true,
    writable: true,
  });
}

/**
 * Give this case a working Clipboard API.
 *
 * @param writeText - Optional pre-built spy, so a case can supply one that rejects. Defaults to a
 *   spy that resolves, which is what a granted clipboard permission does.
 * @returns The `writeText` spy, for assertions on what was copied.
 */
function withClipboard(
  writeText: Mock<WriteText> = vi.fn<WriteText>(() => Promise.resolve()),
): Mock<WriteText> {
  // Only `writeText` is provided: `resolveClipboard` checks for exactly that member and the
  // component calls nothing else. A fuller fake would invite a test to depend on a capability the
  // component does not use.
  defineNavigatorCapability('clipboard', { writeText } as unknown as Clipboard);

  return writeText;
}

/**
 * Give this case a working Web Share API.
 *
 * Must be called BEFORE `render`. Availability is read through `useSyncExternalStore` whose
 * subscription never notifies - correctly, since whether an engine implements the API is fixed for
 * the lifetime of a document - so a capability installed after the first render is never observed.
 *
 * @param share - Optional pre-built spy, so a case can supply one that rejects. Defaults to a spy
 *   that resolves, which is what a completed share sheet does.
 * @returns The share spy. The component binds it to `navigator` before calling, and a bound
 *   function still records its call on the underlying spy.
 */
function withWebShare(
  share: Mock<WebShare> = vi.fn<WebShare>(() => Promise.resolve()),
): Mock<WebShare> {
  defineNavigatorCapability('share', share);

  return share;
}

/**
 * Return `navigator` to the shape this environment really has.
 *
 * Both members are absent here and absent from `Navigator.prototype`, so deleting the own property
 * installed above restores the genuine absence rather than unmasking an inherited stand-in. Running
 * unconditionally over the whole list keeps teardown correct however many capabilities a case took.
 */
function forgetNavigatorCapabilities(): void {
  for (const name of OPTIONAL_NAVIGATOR_CAPABILITIES) {
    Reflect.deleteProperty(navigator, name);
  }
}

/* -------------------------------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------------------------------- */

beforeEach(() => {
  // Pinned before every render, because the component derives the canonical URL in its render body
  // and `@/lib/seo` reads the variable at call time.
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', STUBBED_SITE_ORIGIN);
  vi.stubEnv('NEXT_PUBLIC_SITE_NAME', STUBBED_SITE_NAME);
});

afterEach(() => {
  // Capabilities first: a case that installed one must not be able to hand it to the next case, or
  // to any other spec file, whatever else teardown does afterwards.
  forgetNavigatorCapabilities();
  vi.unstubAllEnvs();

  // Clears recorded calls on the toast spies without discarding their implementations, so the next
  // case starts from silence. `vitest.config.ts` sets no `clearMocks`, so this is not redundant.
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------------------------------
 * Shared expectations
 * ---------------------------------------------------------------------------------------------- */

/**
 * The post's canonical absolute URL, produced by the same builder the component uses.
 *
 * Called inside a case rather than at module scope: at module scope it would evaluate before
 * `beforeEach` had pinned the origin, and `@/lib/seo` throws rather than substituting a default.
 */
function canonicalPostUrl(): string {
  return absoluteUrl(postPath(POST.slug));
}

/**
 * Assert a control is named by its label alone, with its glyph excluded from the accessible name.
 *
 * Two halves of one guarantee, and both are asserted as OUTCOMES rather than as the component's
 * spelling of them. `toHaveAccessibleName` compares the COMPUTED name for equality, so a glyph that
 * reached the accessibility tree would lengthen the name and fail here; `aria-hidden="true"` on
 * every `<svg>` is the mechanism that keeps it out.
 *
 * Worth knowing why the second half is not merely a restatement of the component's own attribute:
 * `lucide-react@1.29.0` applies `aria-hidden="true"` itself unless the caller passes an `aria-*`,
 * `role` or `title` prop, so the guarantee survives whether or not the component spells the
 * attribute out - and it breaks precisely when a glyph is given a name of its own, which is the
 * defect worth catching. Verified by mutation: labelling one glyph fails eight cases here.
 *
 * `querySelectorAll('svg')` selects by element, never by class - appearance is not under assertion.
 *
 * @param control - The rendered link or button.
 * @param accessibleName - The name the control must have, exactly.
 */
function expectNamedByLabelAlone(control: HTMLElement, accessibleName: string): void {
  expect(control).toHaveAccessibleName(accessibleName);

  const glyphs = control.querySelectorAll('svg');
  expect(glyphs.length).toBeGreaterThan(0);

  for (const glyph of glyphs) {
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
  }
}

/** The rendered clipboard control, found the way a reader reaches it. */
function copyControl(): HTMLElement {
  return screen.getByRole('button', { name: COPY_LABEL });
}

/** The rendered Web Share control, found the way a reader reaches it. */
function nativeShareControl(): HTMLElement {
  return screen.getByRole('button', { name: NATIVE_SHARE_LABEL });
}

/* -------------------------------------------------------------------------------------------------
 * Cases
 * ---------------------------------------------------------------------------------------------- */

describe('ShareBar', () => {
  describe('share links', () => {
    it('names the landmark so it is distinguishable from the site header', () => {
      render(<ShareBar {...POST} />);

      // A named `<nav>` rather than an ARIA group: three of these controls navigate off-site, which
      // is what the landmark role is for, and an unnamed landmark is useless in a landmark list.
      expect(screen.getByRole('navigation', { name: GROUP_LABEL })).toBeInTheDocument();
    });

    it('renders every social destination as a real anchor with a descriptive name', () => {
      render(<ShareBar {...POST} />);

      // Anchors, not buttons wrapping `window.open`. The control is composed as
      // `<Button asChild>` over `@radix-ui/react-slot`, so what reaches the DOM is the anchor
      // itself - the `link` role below is the whole point of that composition, and the classes that
      // make it look like a button are none of this file's business.
      expect(screen.getAllByRole('link')).toHaveLength(SHARE_TARGETS.length);

      for (const target of SHARE_TARGETS) {
        const link = screen.getByRole('link', { name: accessibleNameOf(target) });

        // "Share on X", not a bare glyph: the name says what the control does and where it goes.
        expect(link).toHaveAccessibleName(accessibleNameOf(target));
        expect(link).toHaveTextContent(target.label);

        const href = link.getAttribute('href') ?? '';
        expect(href.length).toBeGreaterThan(0);
      }
    });

    it('opens every destination in a new tab without leaking this one', () => {
      render(<ShareBar {...POST} />);

      for (const target of SHARE_TARGETS) {
        const link = screen.getByRole('link', { name: accessibleNameOf(target) });

        expect(link).toHaveAttribute('target', '_blank');

        // `noopener` severs the opened page's `window.opener` handle so it cannot navigate this
        // tab; `noreferrer` withholds the referrer. Both are required, and `rel` is a
        // space-separated token list, so membership is what matters rather than the exact spelling.
        const relTokens = (link.getAttribute('rel') ?? '').split(/\s+/);
        expect(relTokens).toContain('noopener');
        expect(relTokens).toContain('noreferrer');
      }
    });

    it('embeds the canonical post URL in the parameter each platform reads', () => {
      render(<ShareBar {...POST} />);

      const expectedUrl = canonicalPostUrl();

      // The builder's normalisation, restated without naming an origin: the canonical URL is the
      // configured origin joined to `/blog/{slug}` with exactly one separator and no trailing
      // slash, which is what keeps it byte-identical to the `alternates.canonical` link the post
      // page emits. A social platform that saw two spellings would split the article's ranking
      // signal across them.
      expect(expectedUrl.endsWith(postPath(POST.slug))).toBe(true);
      expect(expectedUrl).not.toMatch(/\/$/);

      for (const target of SHARE_TARGETS) {
        const link = screen.getByRole('link', { name: accessibleNameOf(target) });
        const shareUrl = new URL(link.getAttribute('href') ?? '');

        expect(shareUrl.protocol).toBe('https:');
        expect(shareUrl.hostname).toBe(target.hostname);

        // `searchParams.get` returns the DECODED value, which is what proves the component
        // percent-encoded the URL rather than interpolating it raw into a query string.
        expect(shareUrl.searchParams.get(target.urlParam)).toBe(expectedUrl);
      }
    });

    it('embeds the title only where the platform accepts one', () => {
      render(<ShareBar {...POST} />);

      for (const target of SHARE_TARGETS) {
        const link = screen.getByRole('link', { name: accessibleNameOf(target) });
        const shareUrl = new URL(link.getAttribute('href') ?? '');

        if (target.titleParam === null) {
          // Asserted as an absence rather than left unchecked: a platform that ignores the title
          // must not be handed one, or every shared URL carries a dead parameter.
          for (const value of shareUrl.searchParams.values()) {
            expect(value).not.toContain(POST.title);
          }

          continue;
        }

        expect(shareUrl.searchParams.get(target.titleParam)).toBe(POST.title);
      }
    });

    it('keeps the decorative glyphs out of every accessible name', () => {
      render(<ShareBar {...POST} />);

      // `lucide-react` renders an `<svg>` inside each control. Hidden from the accessibility tree
      // it contributes nothing to the name, which is what makes "Share on X" the whole
      // announcement. A control announced as anything else is the defect this asserts against.
      for (const target of SHARE_TARGETS) {
        expectNamedByLabelAlone(
          screen.getByRole('link', { name: accessibleNameOf(target) }),
          accessibleNameOf(target),
        );
      }

      expectNamedByLabelAlone(copyControl(), COPY_LABEL);
    });
  });

  describe('copy link', () => {
    it('writes the canonical URL to the clipboard', async () => {
      const writeText = withClipboard();

      render(<ShareBar {...POST} />);

      // `fireEvent`, not `userEvent`: `@testing-library/user-event` is not in the declared
      // dependency set, and a click is the whole interaction here.
      fireEvent.click(copyControl());

      await waitFor(() => {
        // Exactly the canonical URL - no query string, no fragment, no tracking parameter. What the
        // reader pastes has to be the same address the canonical link names.
        expect(writeText).toHaveBeenCalledWith(canonicalPostUrl());
      });

      expect(writeText).toHaveBeenCalledTimes(1);
    });

    it('confirms a successful copy and reports nothing as failed', async () => {
      withClipboard();

      render(<ShareBar {...POST} />);
      fireEvent.click(copyControl());

      await waitFor(() => {
        expect(toastSuccess).toHaveBeenCalledWith(COPY_SUCCEEDED_MESSAGE);
      });

      expect(toastSuccess).toHaveBeenCalledTimes(1);
      expect(toastError).not.toHaveBeenCalled();
    });

    it('leaves the row compact when the copy succeeds', async () => {
      withClipboard();

      render(<ShareBar {...POST} />);
      fireEvent.click(copyControl());

      await waitFor(() => {
        expect(toastSuccess).toHaveBeenCalledWith(COPY_SUCCEEDED_MESSAGE);
      });

      // The manual fallback is a response to a failed attempt, so a successful one must not reveal
      // it: a URL left on screen after a working copy reads as though the copy did not happen.
      expect(screen.queryByText(canonicalPostUrl())).toBeNull();
      expect(screen.queryByText(MANUAL_COPY_PREAMBLE)).toBeNull();
    });

    it('surfaces a refused copy as a failure rather than throwing', async () => {
      // A permission denial rejects even where the API exists, which is the case this describes.
      const writeText = withClipboard(
        vi.fn<WriteText>(() => Promise.reject(new DOMException('Write permission denied.'))),
      );

      render(<ShareBar {...POST} />);
      fireEvent.click(copyControl());

      await waitFor(() => {
        expect(toastError).toHaveBeenCalledWith(COPY_FAILED_MESSAGE);
      });

      expect(writeText).toHaveBeenCalledTimes(1);
      expect(toastSuccess).not.toHaveBeenCalled();

      // Degradation is a working route to the same outcome, not a dead end: the URL is revealed as
      // selectable text so the reader can still copy it by hand. The awaited rejection is handled
      // inside the component, so nothing escapes as an unhandled rejection either.
      expect(await screen.findByText(canonicalPostUrl())).toBeVisible();
      expect(screen.getByText(MANUAL_COPY_PREAMBLE)).toBeInTheDocument();
    });

    it('degrades to a selectable URL when the Clipboard API is absent', async () => {
      // No `withClipboard()`. This is the environment as it really is here, and as a real browser
      // over plain `http:` from a non-localhost origin really is.
      render(<ShareBar {...POST} />);

      expect(screen.getAllByRole('link')).toHaveLength(SHARE_TARGETS.length);

      // No `navigator.clipboard.writeText` is reached, so nothing throws a TypeError. The component
      // resolves the capability first and takes the fallback branch synchronously.
      expect(() => {
        fireEvent.click(copyControl());
      }).not.toThrow();

      await waitFor(() => {
        expect(toastError).toHaveBeenCalledWith(COPY_UNAVAILABLE_MESSAGE);
      });

      expect(toastSuccess).not.toHaveBeenCalled();
      expect(await screen.findByText(canonicalPostUrl())).toBeVisible();

      // The visually hidden preamble is what gives the bare URL a purpose when a screen reader
      // reaches it out of context.
      expect(screen.getByText(MANUAL_COPY_PREAMBLE)).toBeInTheDocument();

      // The social controls are untouched by the clipboard's absence - they never needed it.
      expect(screen.getAllByRole('link')).toHaveLength(SHARE_TARGETS.length);
      for (const target of SHARE_TARGETS) {
        expect(screen.getByRole('link', { name: accessibleNameOf(target) })).toBeVisible();
      }
    });
  });

  describe('feature detection', () => {
    it('omits the device share control where the API is absent', () => {
      // Neither capability installed. This is the desktop-browser case, and the case this test
      // environment presents by default.
      render(<ShareBar {...POST} />);

      // Absent, not disabled. A reader cannot tell why an enabled-looking control does nothing, and
      // the three anchors already cover every browser - so there is nothing to apologise for.
      expect(screen.queryByRole('button', { name: NATIVE_SHARE_LABEL })).toBeNull();

      // The clipboard control is still there, and it is the only button: proof the row degrades by
      // dropping one affordance rather than by collapsing.
      expect(screen.getAllByRole('button')).toHaveLength(1);
      expect(copyControl()).toBeVisible();
      expect(screen.getAllByRole('link')).toHaveLength(SHARE_TARGETS.length);
    });

    it('offers the device share control where the API exists', async () => {
      const share = withWebShare();

      render(<ShareBar {...POST} />);

      const control = nativeShareControl();

      // Named more fully than its visible "Share", and named by its label alone - the glyph is
      // hidden here for the same reason it is on every other control.
      expectNamedByLabelAlone(control, NATIVE_SHARE_LABEL);
      expect(screen.getAllByRole('button')).toHaveLength(2);

      fireEvent.click(control);

      await waitFor(() => {
        // Title and canonical URL, and nothing else. The share sheet is handed the same address the
        // clipboard control writes and the canonical link names.
        expect(share).toHaveBeenCalledWith({ title: POST.title, url: canonicalPostUrl() });
      });

      expect(share).toHaveBeenCalledTimes(1);
      expect(toastError).not.toHaveBeenCalled();
    });

    it('treats a dismissed share sheet as a completed interaction', async () => {
      // `DOMException` with `name: 'AbortError'` is exactly what a browser rejects with when the
      // reader closes the sheet - and jsdom's `DOMException` does not put `Error.prototype` in its
      // prototype chain, which is why the component duck-types on `name` instead of using
      // `instanceof`. Constructing the real type here is what exercises that decision.
      const share = withWebShare(
        vi.fn<WebShare>(() => Promise.reject(new DOMException('Share cancelled.', 'AbortError'))),
      );

      render(<ShareBar {...POST} />);
      fireEvent.click(nativeShareControl());

      await waitFor(() => {
        expect(share).toHaveBeenCalledTimes(1);
      });

      // The component awaits the rejected promise, so its `catch` runs in a microtask enqueued by
      // the click above. Draining the queue once makes the ordering of the assertions below
      // explicit rather than incidental.
      await Promise.resolve();

      // Silence is the correct outcome: a reader who changed their mind completed the interaction
      // and must not be shown a failure. Nothing escapes as an unhandled rejection either.
      expect(toastError).not.toHaveBeenCalled();
      expect(toastSuccess).not.toHaveBeenCalled();
    });

    it('reports a share sheet that fails for any other reason', async () => {
      const share = withWebShare(
        vi.fn<WebShare>(() => Promise.reject(new DOMException('Not allowed.', 'NotAllowedError'))),
      );

      render(<ShareBar {...POST} />);
      fireEvent.click(nativeShareControl());

      await waitFor(() => {
        expect(toastError).toHaveBeenCalledWith(NATIVE_SHARE_FAILED_MESSAGE);
      });

      expect(share).toHaveBeenCalledTimes(1);
      expect(toastSuccess).not.toHaveBeenCalled();
    });

    it('resolves each capability independently of the other', async () => {
      // The two APIs are unrelated: a browser can have one without the other, and the component
      // resolves them through separate helpers. Installing only the clipboard must therefore leave
      // the share control absent while the copy path works - which also demonstrates that the
      // previous cases' capabilities did not leak into this one.
      const writeText = withClipboard();

      render(<ShareBar {...POST} />);

      expect(screen.queryByRole('button', { name: NATIVE_SHARE_LABEL })).toBeNull();

      fireEvent.click(copyControl());

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(canonicalPostUrl());
      });
    });
  });
});
