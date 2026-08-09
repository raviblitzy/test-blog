/**
 * Component tests for `@/components/ui/avatar` - the three-part avatar primitive
 * (`Avatar`, `AvatarImage`, `AvatarFallback`) that this tier's design system layer
 * builds over @radix-ui/react-avatar.
 *
 * `review_rules` reports NO USER RULES for this project, so the binding bar here is
 * the set of self-imposed enterprise standards the plan records: accessibility as a
 * floor, blocking quality gates, zero hardcoded presentation values, and pinned
 * dependencies. Each one shaped a decision below, and the decisions are written down
 * rather than left to be re-derived.
 *
 * ---------------------------------------------------------------------------------
 * WHAT IS ACTUALLY UNDER TEST: THE FALLBACK
 *
 * A user's `avatar_url` is nullable by design, and this product has no upload or
 * object-storage pipeline - an avatar is a URL somebody typed into a profile. So the
 * fallback is not an edge case. It is the COMMON case: every freshly seeded account,
 * every user who never set an avatar, every URL whose host has since gone away, and
 * the interval before a slow image arrives. `AvatarFallback` is what turns all four
 * of those into initials instead of a broken-image glyph, and a regression there
 * would degrade every byline, every comment thread and the whole admin user table in
 * one go. That is why the first describe block below carries the weight of this file
 * and why it stubs nothing whatsoever.
 *
 * ---------------------------------------------------------------------------------
 * THE jsdom IMAGE CAVEAT, AND WHY THE SECOND DESCRIBE BLOCK EXISTS
 *
 * Radix renders `AvatarImage` as `null` until its loading status reaches `'loaded'`,
 * and it derives that status from a probe image with
 *
 *     image.complete ? (image.naturalWidth > 0 ? 'loaded' : 'error') : 'loading'
 *
 * jsdom implements no image decoding at all. Measured in this exact setup: after
 * assigning a `src`, `complete` stays `false`, `naturalWidth` stays `0`, and NEITHER
 * a `load` NOR an `error` event ever fires. The status therefore pins at `'loading'`
 * forever, so the `<img>` element never enters the document no matter what `src`
 * says - which is precisely the reality the `fallback` block asserts against, and it
 * is deterministic rather than racy.
 *
 * The consequence is that `src`, `alt`, the accessible name, the `referrerPolicy`
 * default and prop pass-through on the image part would be entirely unverifiable at
 * this level. The `image` block therefore lends jsdom the ONE capability it lacks -
 * a completed decode - by making the two DOM getters Radix reads report a decoded
 * bitmap. Being explicit about the boundary of that:
 *
 *   - NOTHING in `@/components/ui/avatar` is mocked, replaced or bypassed. The host
 *     policy still filters `src`, the `referrerPolicy` default still applies, and
 *     Radix's own loading state machine still runs unmodified and still decides what
 *     to render. The `<img>` asserted on is the real element Radix mounts.
 *   - The two spies are installed per test and restored by explicit handles, so they
 *     cannot reach the `fallback` block or any other file. `vi.restoreAllMocks()` is
 *     deliberately NOT used: the shared setup file installs `window.matchMedia` as a
 *     bare `vi.fn()`, which has no original to restore, so a blanket restore would
 *     quietly strip it.
 *   - The last case in that block sets a `src` the shared host policy denies while
 *     the decode capability is installed. It still renders initials - which is how
 *     the policy is proven to be doing the work rather than the environment.
 *
 * ---------------------------------------------------------------------------------
 * WHAT THIS FILE DELIBERATELY NEVER ASSERTS
 *
 * No class name, no `className`, no inline style, no computed style, no snapshot,
 * and no size, radius or layout-shift claim. The token layer owns every one of those
 * values and is free to change them, so a test that pinned one would fail on a
 * palette edit while the component still worked. jsdom computes no layout either, so
 * a "no layout shift" assertion here would be theatre; that claim belongs to the
 * Playwright projects, which run a real browser at real viewports. What is left is
 * what a reader actually gets: visible text, accessible names, roles, and attributes.
 *
 * Initials derivation is also absent on purpose. This primitive imports no domain
 * type and computes nothing - the consumer derives initials and passes them as
 * children - so that logic belongs to its owner's test, not to this one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

/**
 * An avatar URL whose HOST the shared image-host policy admits, carrying an
 * unmistakably fake path.
 *
 * A made-up hostname is not an option for this one fixture, and that is a property of
 * the component rather than a preference: `AvatarImage` drops any `src` outside the
 * shared allowlist to `undefined` before it reaches the DOM, so an invented host could
 * never reach the loaded state and the cases below would silently be re-testing the
 * policy instead of the image. Every admitted host is a real delivery host, so one of
 * those is used - with a path that could not be mistaken for a real asset.
 *
 * It is still not a network dependency, which is the point of the rule it bends.
 * Measured in this setup: jsdom has no resource loader, so assigning a `src` issues no
 * request and fires neither `load` nor `error`; the decode is supplied locally instead.
 * Nothing in this suite can reach, or wait on, the internet.
 */
const ADMITTED_AVATAR_URL = 'https://images.unsplash.com/fixture-not-a-real-avatar.png';

/**
 * An avatar URL that can never resolve and that the policy denies twice over: the
 * host is not on the allowlist, and `.invalid` is reserved by RFC 2606 precisely so
 * that it is guaranteed never to exist in the DNS. This is the stored-URL-has-gone-
 * away case.
 */
const DENIED_AVATAR_URL = 'https://avatars.example.invalid/fixture-not-a-real-avatar.png';

/** The display name an avatar stands in for; used as `alt` where the image is meaningful. */
const AUTHOR_DISPLAY_NAME = 'Ada Lovelace';

/** Initials a consumer derived from {@link AUTHOR_DISPLAY_NAME} and handed to the fallback. */
const AUTHOR_INITIALS = 'AD';

/**
 * Fallback text that no initials algorithm could have produced from
 * {@link AUTHOR_DISPLAY_NAME}. Using it proves the fallback renders what it is GIVEN
 * rather than something it computed.
 */
const UNDERIVED_FALLBACK_TEXT = 'ZZ';

/**
 * Intrinsic width reported for a decoded bitmap. Radix only ever tests
 * `naturalWidth > 0`, so the magnitude is irrelevant and `1` keeps it obvious that
 * this is a decode sentinel and not a size.
 */
const DECODED_INTRINSIC_WIDTH = 1;

describe('Avatar', () => {
  describe('fallback', () => {
    it('renders the initials when no image is supplied at all', async () => {
      // `avatar_url === null` is a valid state on a public user, not an error. The
      // composition is simply the root plus the fallback, and identity still reaches
      // the reader as visible text.
      const { container } = render(
        <Avatar>
          <AvatarFallback>{AUTHOR_INITIALS}</AvatarFallback>
        </Avatar>,
      );

      expect(await screen.findByText(AUTHOR_INITIALS)).toBeVisible();
      expect(container.querySelector('img')).toBeNull();
    });

    it('renders the initials, and no image at all, when the stored URL cannot resolve', async () => {
      // The regression this guards is the one that would hurt most: a broken-image
      // glyph where initials should be. Radix keeps the image out of the document
      // until it has decoded, so there is nothing for a browser to draw a glyph for.
      const { container } = render(
        <Avatar>
          <AvatarImage src={DENIED_AVATAR_URL} alt={AUTHOR_DISPLAY_NAME} />
          <AvatarFallback>{AUTHOR_INITIALS}</AvatarFallback>
        </Avatar>,
      );

      expect(await screen.findByText(AUTHOR_INITIALS)).toBeVisible();

      // Nothing image-like is exposed to assistive technology, under either role an
      // <img> can take: `img` when it has alt text, `presentation` when it does not.
      expect(screen.queryByRole('img')).toBeNull();
      expect(screen.queryByRole('presentation')).toBeNull();

      // And nothing image-like is in the document either. A tag lookup is the only
      // way to state that precisely; it involves no class name.
      expect(container.querySelector('img')).toBeNull();
    });

    it('renders the initials while an admitted image has not decoded yet', async () => {
      // Same visible outcome, different cause: this URL passes the host policy, so
      // the image is genuinely in flight rather than rejected. A reader must see
      // initials during that interval instead of an empty hole.
      render(
        <Avatar>
          <AvatarImage src={ADMITTED_AVATAR_URL} alt={AUTHOR_DISPLAY_NAME} />
          <AvatarFallback>{AUTHOR_INITIALS}</AvatarFallback>
        </Avatar>,
      );

      expect(await screen.findByText(AUTHOR_INITIALS)).toBeVisible();
      expect(screen.queryByRole('img')).toBeNull();
    });

    it('renders exactly the children it is handed, deriving nothing', async () => {
      // Initials are the consumer's to compute. This primitive is a container for
      // whatever it is given, which is what keeps it free of any domain type.
      render(
        <Avatar>
          <AvatarFallback>{UNDERIVED_FALLBACK_TEXT}</AvatarFallback>
        </Avatar>,
      );

      expect(await screen.findByText(UNDERIVED_FALLBACK_TEXT)).toBeVisible();
      expect(screen.queryByText(AUTHOR_INITIALS)).toBeNull();
    });

    it('honours a delayMs the caller passes without leaking it to the DOM', async () => {
      // The wrapper sets no default `delayMs`, so the fallback appears immediately -
      // right for a user who has no avatar at all, who should never see a blank
      // disc. A caller that would rather stay blank briefly passes its own value,
      // and the wrapper must forward it to Radix rather than swallow it or spill it
      // onto the span as an invalid attribute.
      render(
        <Avatar>
          <AvatarImage src={ADMITTED_AVATAR_URL} alt={AUTHOR_DISPLAY_NAME} />
          <AvatarFallback delayMs={0} data-testid="delayed-fallback">
            {AUTHOR_INITIALS}
          </AvatarFallback>
        </Avatar>,
      );

      const fallback = await screen.findByTestId('delayed-fallback');

      expect(fallback).toHaveTextContent(AUTHOR_INITIALS);
      expect(fallback).not.toHaveAttribute('delayms');
    });

    it('passes arbitrary attributes through to the root and to the fallback', async () => {
      // Both parts spread the rest of their props onto the primitive, which is what
      // lets a consumer hang an id, a test hook or an aria-* attribute on either one
      // without this file growing a prop for it.
      render(
        <Avatar id="avatar-root" data-testid="avatar-root">
          <AvatarFallback id="avatar-fallback" data-testid="avatar-fallback">
            {AUTHOR_INITIALS}
          </AvatarFallback>
        </Avatar>,
      );

      const root = await screen.findByTestId('avatar-root');
      const fallback = screen.getByTestId('avatar-fallback');

      expect(root).toHaveAttribute('id', 'avatar-root');
      expect(fallback).toHaveAttribute('id', 'avatar-fallback');
      expect(root).toContainElement(fallback);
    });
  });

  describe('image', () => {
    /**
     * Restores the two DOM getters this block overrides. Held as an explicit handle
     * rather than delegating to `vi.restoreAllMocks()`, which would also reach the
     * `vi.fn()` stubs the shared setup file installs and leave them with no
     * implementation.
     */
    let restoreImageDecode: (() => void) | undefined;

    beforeEach(() => {
      // Lend jsdom the one capability it has no implementation for: reporting that an
      // image finished decoding. These are the exact two getters Radix reads to
      // compute its loading status, so overriding them lets its real, unmodified
      // state machine reach `'loaded'` and mount the element the cases below assert
      // on. Nothing in `@/components/ui/avatar` is touched.
      const complete = vi
        .spyOn(window.HTMLImageElement.prototype, 'complete', 'get')
        .mockReturnValue(true);
      const naturalWidth = vi
        .spyOn(window.HTMLImageElement.prototype, 'naturalWidth', 'get')
        .mockReturnValue(DECODED_INTRINSIC_WIDTH);

      restoreImageDecode = () => {
        complete.mockRestore();
        naturalWidth.mockRestore();
      };
    });

    afterEach(() => {
      restoreImageDecode?.();
      restoreImageDecode = undefined;
    });

    it('mounts a plain img element carrying the src and alt it was given', async () => {
      render(
        <Avatar>
          <AvatarImage
            src={ADMITTED_AVATAR_URL}
            alt={AUTHOR_DISPLAY_NAME}
            data-testid="avatar-image"
          />
          <AvatarFallback>{AUTHOR_INITIALS}</AvatarFallback>
        </Avatar>,
      );

      const image = await screen.findByRole('img', { name: AUTHOR_DISPLAY_NAME });

      // A real <img>, rendered by Radix's own image part from inside node_modules -
      // which is how this tier gets the element it needs without writing the JSX that
      // `@next/next/no-img-element` would flag under the zero-warning lint gate.
      expect(image.tagName).toBe('IMG');
      expect(image).toHaveAttribute('src', ADMITTED_AVATAR_URL);
      expect(image).toHaveAttribute('alt', AUTHOR_DISPLAY_NAME);

      // The URL reaches the DOM verbatim, and there is no candidate set. Together
      // those say no image optimiser is involved: `next/image` would have rewritten
      // `src` to a `/_next/image` route and added a `srcset`. Staying off that path
      // is deliberate - it is what keeps Radix's load/error handshake intact.
      expect(image.getAttribute('src')).not.toContain('/_next/image');
      expect(image).not.toHaveAttribute('srcset');

      // The rest of the props spread through here too, exactly as on the other parts.
      expect(image).toHaveAttribute('data-testid', 'avatar-image');
    });

    it('takes its accessible name from alt when the avatar stands alone', async () => {
      // The wrapper invents no `alt`, `aria-label` or `role`, so an avatar that has
      // no visible name beside it is named by whatever the caller passed - and that
      // is the only thing standing between a screen-reader user and an unlabelled
      // graphic.
      render(
        <Avatar>
          <AvatarImage src={ADMITTED_AVATAR_URL} alt={AUTHOR_DISPLAY_NAME} />
          <AvatarFallback>{AUTHOR_INITIALS}</AvatarFallback>
        </Avatar>,
      );

      const image = await screen.findByRole('img', { name: AUTHOR_DISPLAY_NAME });

      expect(image).toHaveAccessibleName(AUTHOR_DISPLAY_NAME);
    });

    it('keeps a decorative avatar out of the accessibility tree when alt is empty', async () => {
      // Beside a visible byline the avatar is duplication, so the caller passes
      // `alt=""` and the picture is shown without being announced a second time. An
      // empty `alt` maps the element to the presentation role, which removes it from
      // the accessibility tree while leaving it on screen.
      render(
        <Avatar>
          <AvatarImage src={ADMITTED_AVATAR_URL} alt="" data-testid="decorative-image" />
          <AvatarFallback>{AUTHOR_INITIALS}</AvatarFallback>
        </Avatar>,
      );

      const decorative = await screen.findByTestId('decorative-image');

      expect(decorative.tagName).toBe('IMG');
      expect(decorative).toHaveAttribute('alt', '');
      expect(screen.queryByRole('img')).toBeNull();
      expect(screen.getByRole('presentation')).toBe(decorative);
    });

    it('replaces the initials once the image has decoded', async () => {
      // The two parts are mutually exclusive by construction: the fallback unmounts
      // the moment the image is available, so a reader never sees initials layered
      // over a photograph.
      render(
        <Avatar>
          <AvatarImage src={ADMITTED_AVATAR_URL} alt={AUTHOR_DISPLAY_NAME} />
          <AvatarFallback>{AUTHOR_INITIALS}</AvatarFallback>
        </Avatar>,
      );

      await screen.findByRole('img', { name: AUTHOR_DISPLAY_NAME });

      expect(screen.queryByText(AUTHOR_INITIALS)).toBeNull();
    });

    it('defaults referrerPolicy to no-referrer', async () => {
      // A privacy default the wrapper adds rather than inherits: even a delivery host
      // the policy admits has no business learning which page a reader was on.
      render(
        <Avatar>
          <AvatarImage src={ADMITTED_AVATAR_URL} alt={AUTHOR_DISPLAY_NAME} />
          <AvatarFallback>{AUTHOR_INITIALS}</AvatarFallback>
        </Avatar>,
      );

      const image = await screen.findByRole('img', { name: AUTHOR_DISPLAY_NAME });

      expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    });

    it('lets a caller override referrerPolicy', async () => {
      // It is a default, not a lock-in: a host with referrer-based hotlink
      // protection needs a different value, so the prop still wins.
      render(
        <Avatar>
          <AvatarImage
            src={ADMITTED_AVATAR_URL}
            alt={AUTHOR_DISPLAY_NAME}
            referrerPolicy="origin"
          />
          <AvatarFallback>{AUTHOR_INITIALS}</AvatarFallback>
        </Avatar>,
      );

      const image = await screen.findByRole('img', { name: AUTHOR_DISPLAY_NAME });

      expect(image).toHaveAttribute('referrerpolicy', 'origin');
    });

    it('never mounts an image for a src the shared host policy denies', async () => {
      // The decode capability is installed for this case too, so the environment
      // COULD render an image. It still shows initials - which places the decision
      // squarely in the component: a host the policy excludes is dropped before it
      // reaches the DOM, so no reader's browser is ever made to contact it, and the
      // avatar degrades exactly the way a missing one does.
      const { container } = render(
        <Avatar>
          <AvatarImage src={DENIED_AVATAR_URL} alt={AUTHOR_DISPLAY_NAME} />
          <AvatarFallback>{AUTHOR_INITIALS}</AvatarFallback>
        </Avatar>,
      );

      expect(await screen.findByText(AUTHOR_INITIALS)).toBeVisible();
      expect(screen.queryByRole('img')).toBeNull();
      expect(screen.queryByRole('presentation')).toBeNull();
      expect(container.querySelector('img')).toBeNull();
    });
  });
});
