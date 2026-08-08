'use client';

// ShareBar - the share affordances on a post's reading page, and the one
// component in this application that talks to nothing at all.
//
// ---------------------------------------------------------------------------
// 1. SHARING NEEDS NO BACKEND. THAT IS THE WHOLE REQUIREMENT.
//
// The plan's restatement of R4 is exact: share affordances are "built entirely
// client-side from the post's canonical URL, requiring no backend endpoint."
// There is no `POST /api/v1/posts/{id}/share`, there is no share counter, and
// there is nothing to fetch - a share target is a pure function of one string.
// So this file imports no API module, issues no request, and holds no server
// state. The component test proves it rather than asserting it: it runs with a
// spy over `fetch` and fails if anything is called.
//
// That also settles what NOT to add. No analytics call on click, no `via=`
// campaign parameter, no platform SDK and no vendor embed script - the plan
// excludes analytics, A/B testing and feature flags outright, and loading a
// third-party script would smuggle in both an undeclared dependency and a
// privacy surface for a control that works perfectly as four links.
//
// ---------------------------------------------------------------------------
// 2. THE URL COMES FROM @/lib/seo, AND ONLY FROM THERE
//
// `postPath(slug)` then `absoluteUrl(...)`. Not the browser's own location
// object, not a template literal over an origin, and not a read of the process
// environment - this file reads no environment variable at all, because
// `src/lib/seo.ts` is the tier's only reader of
// `NEXT_PUBLIC_SITE_URL` and normalises it through `new URL().origin`, which
// strips a trailing slash, lower-cases the host and drops a default port.
//
// That single source is load-bearing rather than tidy. The URL shared here has
// to be byte-identical to the `alternates.canonical` link the post page emits
// from `buildPostMetadata`, or a social platform treats the two spellings as
// two separate pages and splits the article's ranking signal across them.
// Reading the live document location would break exactly that: on a preview
// deployment it yields the preview host while the canonical tag still names the
// production origin, so every share would point somewhere the canonical tag
// disowns.
//
// ---------------------------------------------------------------------------
// 3. WHY NOTHING HERE IS WRAPPED IN try/catch - DELIBERATE
//
// `absoluteUrl` throws when the site origin is unset or malformed, and
// `postPath` throws on a blank slug. Neither is caught, and catching would be
// the defect rather than the fix:
//
//   * A missing origin is already fatal one layer up. `generateMetadata` on
//     `/blog/[slug]` calls `buildPostMetadata`, which calls `absoluteUrl`, so a
//     misconfigured deployment fails the whole route before this component ever
//     renders. Swallowing the same error here would remove a share row from a
//     page that is already a 500 - it cannot save the reader anything.
//   * A blank slug is a caller defect. `src/lib/seo.ts` says so in as many
//     words: a blank value "means the record was not the one the caller
//     believed it had". Rendering nothing would hide a bug that a thrown error
//     surfaces at once.
//   * The failure mode of catching is silence. A share bar that quietly
//     disappears on a misconfigured origin is precisely the invisible failure
//     the plan's loud-configuration standard exists to prevent.
//
// The clipboard and Web Share calls ARE wrapped, and section 4 explains why the
// two cases are not comparable: those fail per-interaction, on a working page,
// for reasons the reader can act on.
//
// ---------------------------------------------------------------------------
// 4. EVERY BROWSER API IS FEATURE-DETECTED. THIS IS NOT DEFENSIVENESS.
//
// `frontend/vitest.setup.ts` stubs `matchMedia`, the two observers and a few
// `Element` methods - and nothing else. That list is closed, it belongs to
// another folder, and it must not be edited to accommodate this file. Under
// jsdom, therefore:
//
//   * `navigator.clipboard` is undefined, so an unguarded
//     `navigator.clipboard.writeText(...)` throws a TypeError and fails the
//     test suite.
//   * `navigator.share` is undefined too - as it is in most desktop browsers
//     regardless of any test environment.
//
// Both are resolved through the narrow helpers below, which check the member is
// actually callable before returning it. `navigator.clipboard` is also absent
// on a real browser over plain `http:` on a non-localhost origin, so the guard
// earns its place in production and not only in the test runner.
//
// Degradation is a working path, not a dead end: when the clipboard is missing
// or the promise rejects on a permission denial, the canonical URL is revealed
// as selectable text and the toast says so, so the reader can still copy it.
//
// ---------------------------------------------------------------------------
// 5. EVERY SOCIAL TARGET IS A REAL <a href>
//
// Not a button with a `window.open` handler. An anchor needs no JavaScript at
// all, is keyboard-operable by the platform, and can be middle-clicked,
// long-pressed, copied or opened in a background tab - none of which a scripted
// popup supports. The Web Share control in section 6 is layered ON TOP of the
// working anchors and never replaces them, mirroring the decision already taken
// for `src/components/ui/pagination.tsx`, whose `href` is mandatory and whose
// click handler is optional.
//
// `rel="noopener noreferrer"` is mandatory on each. `noopener` severs the
// opened page's `window.opener` handle so it cannot navigate this tab, and it is
// also what satisfies `react/jsx-no-target-blank` under `--max-warnings=0`.
//
// ---------------------------------------------------------------------------
// 6. DELIBERATELY ABSENT, OR DELIBERATELY PRESENT. EACH IS A DECISION.
//
//   1. The legacy synchronous copy command on `document`. Deprecated, and it
//      needs a throwaway DOM node plus a selection dance. The feature-detected
//      Clipboard API with the visible fallback below covers every browser this
//      application supports.
//   2. `alert`, `confirm`, `prompt`. Modal, unstyled, unthemed and untestable.
//      Feedback is a `sonner` toast.
//   3. A second toaster host. It is mounted once, in `src/app/layout.tsx`.
//      Mounting another here would duplicate every toast on the post page, so
//      `toast` is the only symbol imported from the toast library.
//   4. A heading. This is a control strip inside an article, not a section of
//      it; a heading of any level here would inject a phantom entry into the
//      post's document outline and break the ordered-heading guarantee the post
//      page owns. The group is named by the `<nav>`'s label instead.
//   5. `useMemo` around the canonical URL. It is one function call over one
//      prop. Memoising it would add a dependency array to review and a cache to
//      reason about, and save nothing measurable.
//   6. A breakpoint variant. The row wraps; it does not reflow. `flex-wrap`
//      handles 320px through 4K with no media query, and there is no
//      `md:`-and-up presentation to keep in sync with a `sr-only` twin. Section
//      7 explains why the usual icon-only-below-`md` pattern is unavailable
//      here specifically.
//   7. A `Check` icon swapping in after a successful copy. The toast already
//      confirms it; a second confirmation would need transient state and a
//      timer for no added information.

import { useState, useSyncExternalStore, type JSX } from 'react';

import { Copy, ExternalLink, Share2, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { absoluteUrl, postPath } from '@/lib/seo';
import type { PostSummary } from '@/lib/types';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Copy
 *
 * Every string the reader can see or hear is declared once here, so a wording change is one edit
 * and the component body stays readable. None is exported: the module's public surface is the single
 * component, and a test asserts on rendered text rather than on a constant.
 * ---------------------------------------------------------------------------------------------- */

/** Accessible name of the group. Announced when a screen reader enters the landmark. */
const GROUP_LABEL = 'Share this post';

/**
 * Appended to each social link's accessible name, composed in JavaScript rather than in markup.
 *
 * The link opens a new tab, and an unannounced context switch is disorienting for a screen-reader or
 * magnifier user. The phrase is not visible because four repetitions of it would be visual noise, so
 * it reaches assistive technology through an `aria-label` built from this constant.
 *
 * A visually-hidden sibling span was the first implementation and is deliberately NOT used, for a
 * measured reason rather than a stylistic one: the accessible-name computation trims each node's
 * contribution before concatenating them, so a leading space inside the hidden span is discarded and
 * the composed name comes out as "Share on X(opens in a new tab)" with the word boundary gone. That
 * was reproduced against `dom-accessibility-api` - the same algorithm browsers implement - across
 * four markup shapes; only putting the separator in a bare text node adjacent to the span survived,
 * and that depends on JSX whitespace semantics that a formatter is free to change. Composing the
 * string here cannot be reformatted into a different accessible name.
 *
 * WCAG 2.5.3 still holds, because the composed label CONTAINS the visible text: a voice-control user
 * saying "click Share on Facebook" activates the control.
 */
const NEW_TAB_HINT = ' (opens in a new tab)';

/** Visible and accessible label of the clipboard control. */
const COPY_LABEL = 'Copy link';

/** Visible label of the Web Share control. Named more fully by {@link NATIVE_SHARE_HINT}. */
const NATIVE_SHARE_LABEL = 'Share';

/**
 * Completes the Web Share control's accessible name to "Share using your device".
 *
 * Composed into an `aria-label` for the same reason as {@link NEW_TAB_HINT}. The visible "Share" is a
 * prefix of the result, so WCAG 2.5.3 is satisfied and "click Share" still activates it by voice.
 */
const NATIVE_SHARE_HINT = ' using your device';

/** Confirmation after the URL reaches the clipboard. */
const COPY_SUCCEEDED_MESSAGE = 'Link copied to your clipboard.';

/**
 * Shown when the Clipboard API is not available at all.
 *
 * It names the fallback explicitly, because the fallback is the reader's route to the same outcome
 * and an error that only says "failed" would leave them stuck.
 */
const COPY_UNAVAILABLE_MESSAGE =
  'Copying is not available in this browser. The link is shown below - select it to copy.';

/** Shown when the Clipboard API exists but refused, which is almost always a permission denial. */
const COPY_FAILED_MESSAGE = 'The link could not be copied. It is shown below - select it to copy.';

/** Visually hidden preamble that gives the revealed URL a purpose when it is read out of context. */
const MANUAL_COPY_PREAMBLE = 'Copy this link manually: ';

/** Shown when the device share sheet cannot be opened for a reason other than the reader closing it. */
const NATIVE_SHARE_FAILED_MESSAGE = 'Your device share sheet could not be opened.';

/* -------------------------------------------------------------------------------------------------
 * Share targets
 * ---------------------------------------------------------------------------------------------- */

/**
 * One social destination.
 *
 * `buildShareUrl` is a function rather than a prepared string because the descriptors are
 * module-level constants while the canonical URL is derived per render from a prop - and because
 * the three platforms do not accept the same parameters, which the implementations below record
 * individually.
 */
interface ShareTarget {
  /** Stable React key. Never rendered. */
  readonly id: string;

  /**
   * The control's visible text, which is also the whole of its accessible name apart from
   * {@link NEW_TAB_HINT}. Self-describing on purpose - see the gap note in {@link SHARE_TARGETS}.
   */
  readonly label: string;

  /** Decorative glyph. Rendered with `aria-hidden` so it never enters the accessible name. */
  readonly Icon: LucideIcon;

  /**
   * Compose the platform's share URL.
   *
   * @param canonicalUrl - The post's canonical absolute URL, unencoded.
   * @param title - The post title, unencoded.
   * @returns An absolute `https:` URL. Both arguments are percent-encoded by the implementation.
   */
  readonly buildShareUrl: (canonicalUrl: string, title: string) => string;
}

// BLITZY [DESIGN_SYSTEM_GAP]: lucide-react@1.29.0 ships NO brand icons - verified by enumerating
// all 6,026 exports of the installed package, where `Twitter`, `Facebook`, `Linkedin`,
// `Instagram`, `Github` and every other brand name are `undefined`, and where its `exports` map has
// no brand subpath. `X` exists but is the close/dismiss glyph; using it as the X wordmark would
// read as "close" and would be a semantic lie. The catalogued icon set is the only one available -
// `react-share` and its peers are not declared dependencies and may not be added - so this resolves
// at step 2 of the degradation ladder: nearest available component, annotated. `ExternalLink` is
// used for all three because it states something uniformly TRUE of them ("this leaves the site in a
// new tab") and pairs with `target="_blank"` and NEW_TAB_HINT. Three DIFFERENT generic glyphs were
// rejected: they would imply a per-platform meaning that does not exist. Platform identity is
// therefore carried by the TEXT, which is why each label is a full self-describing phrase - and why
// the usual icon-only-below-`md` presentation is not used here, since three identical brandless
// glyphs would be indistinguishable without their labels. Revisit if the set regains brand marks.
/**
 * The social destinations, in render order. Adding a fourth is one entry.
 */
const SHARE_TARGETS: readonly ShareTarget[] = [
  {
    id: 'x',
    label: 'Share on X',
    Icon: ExternalLink,
    // The only one of the three that still honours a title. `twitter.com/intent/tweet` is used
    // rather than `x.com/...` because it is the long-documented endpoint and redirects to the
    // current host, so it cannot 404 while a newer path settles.
    buildShareUrl: (canonicalUrl, title) =>
      `https://twitter.com/intent/tweet?url=${encodeURIComponent(canonicalUrl)}&text=${encodeURIComponent(title)}`,
  },
  {
    id: 'facebook',
    label: 'Share on Facebook',
    Icon: ExternalLink,
    // `u` only. The `quote` parameter is ignored by the sharer, so passing the title would add a
    // dead parameter to every shared URL and invite the reader to expect prefilled text.
    buildShareUrl: (canonicalUrl) =>
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(canonicalUrl)}`,
  },
  {
    id: 'linkedin',
    label: 'Share on LinkedIn',
    Icon: ExternalLink,
    // `url` only, for the same reason: the legacy `title` and `summary` parameters are ignored, and
    // LinkedIn reads the page's own OpenGraph tags - which `buildPostMetadata` already emits.
    buildShareUrl: (canonicalUrl) =>
      `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(canonicalUrl)}`,
  },
];

/* -------------------------------------------------------------------------------------------------
 * Capability resolution
 *
 * Two helpers, each answering one question: is this API actually here and callable? They are module
 * scope and pure-ish - they read the environment but change nothing - so they are safe to call from
 * an effect and from an event handler alike.
 *
 * Both widen a type the DOM library declares as non-optional. That is not a workaround for a bad
 * type: `lib.dom.d.ts` describes the API SURFACE of a complete browser, while the values here come
 * from whatever actually loaded the module - jsdom, an `http:` origin, an embedded webview. The
 * declared type is a promise about shape, not about presence, and treating it as a promise about
 * presence is exactly the mistake that makes a component untestable.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The Clipboard API, if this environment really has a callable one.
 *
 * Absent under jsdom (nothing in `vitest.setup.ts` supplies it) and absent on a real browser served
 * over plain `http:` from a non-localhost origin, because the API is restricted to secure contexts.
 * Both are ordinary conditions rather than edge cases, so the caller must handle `undefined`.
 *
 * @returns The clipboard, or `undefined` when writing is not possible here.
 */
function resolveClipboard(): Clipboard | undefined {
  if (typeof navigator === 'undefined') {
    return undefined;
  }

  const candidate: Clipboard | undefined = navigator.clipboard;

  if (candidate === undefined || typeof candidate.writeText !== 'function') {
    return undefined;
  }

  return candidate;
}

/**
 * The Web Share API, bound to `navigator`, if this environment really has a callable one.
 *
 * Binding matters: `navigator.share` is a method, so an unbound reference loses its receiver and
 * throws an illegal-invocation `TypeError` when called. Absent under jsdom and on most desktop
 * browsers, which is why the control it powers renders only once this returns a function.
 *
 * @returns A callable share function, or `undefined` when the API is not available here.
 */
function resolveNativeShare(): ((data: ShareData) => Promise<void>) | undefined {
  if (typeof navigator === 'undefined') {
    return undefined;
  }

  const candidate: Navigator['share'] | undefined = navigator.share;

  if (typeof candidate !== 'function') {
    return undefined;
  }

  return candidate.bind(navigator);
}

/* -------------------------------------------------------------------------------------------------
 * Web Share availability as an external store
 *
 * Availability is a fact about the browser, not React state, and it differs between the server
 * render and the client - which is the exact problem `useSyncExternalStore` exists to solve. It
 * takes a server snapshot for the initial HTML and hydration, then reconciles against the client
 * snapshot, so the two renders agree by construction and no mismatch is possible.
 *
 * The obvious alternative - `useState(false)` promoted by an effect - is rejected, and not only on
 * taste: it sets state synchronously in an effect body, which cascades an extra render and which
 * `react-hooks/set-state-in-effect` reports as an error under `--max-warnings=0`. This form needs no
 * effect at all.
 *
 * All three callbacks are module scope so their identities are stable across renders; a `subscribe`
 * recreated per render would make React tear down and re-establish the subscription every time.
 * ---------------------------------------------------------------------------------------------- */

/** Stable no-op unsubscribe handle. Declared once so its identity never changes. */
function noOpUnsubscribe(): void {
  return undefined;
}

/**
 * Subscribe to changes in Web Share availability - of which there are none.
 *
 * Whether a browser implements the API is fixed for the lifetime of the document: it is a property
 * of the engine and the origin's secure-context status, neither of which changes without a
 * navigation. So there is nothing to listen to, and the store notifies never. The declared
 * `onStoreChange` parameter is omitted rather than accepted-and-ignored, which keeps the unused
 * argument out of the lint report while remaining assignable to what the hook expects.
 */
function subscribeToNativeShare(): () => void {
  return noOpUnsubscribe;
}

/** Client snapshot: does this browser really have a callable share sheet? */
function getNativeShareSnapshot(): boolean {
  return resolveNativeShare() !== undefined;
}

/**
 * Server snapshot: always `false`.
 *
 * There is no `navigator` during a server render, and guessing from a user-agent string would be
 * both unreliable and a second source of truth. `false` means the server emits the three anchors
 * and the clipboard control - all of which work everywhere - and the share sheet is added on the
 * client only where it genuinely exists.
 */
function getNativeShareServerSnapshot(): boolean {
  return false;
}

/**
 * Whether a rejection is the reader dismissing the share sheet rather than a failure.
 *
 * The Web Share API rejects with an `AbortError` when the sheet is cancelled, which is a completed
 * interaction with a deliberate outcome - toasting an error there would scold the reader for
 * changing their mind. Every other rejection is a real failure and is reported.
 *
 * Matched by DUCK-TYPING on `name`, and neither `instanceof DOMException` nor `instanceof Error`
 * will do. This is a measured constraint rather than a precaution: an `instanceof Error` guard was
 * the first implementation and the ad-hoc suite failed it, because jsdom's `DOMException` does not
 * put `Error.prototype` in its prototype chain even though a browser's does. The consequence of
 * getting it wrong is user-visible - a reader who simply closed the share sheet would be shown a
 * failure toast - and it is invisible in any browser-only test. The `name` is what the Web Share
 * specification actually guarantees, so it is what this checks, and the check holds across realms,
 * embeddings and polyfills alike.
 */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}

/* -------------------------------------------------------------------------------------------------
 * Component
 * ---------------------------------------------------------------------------------------------- */

/**
 * Props accepted by {@link ShareBar}.
 *
 * Two primitives picked off the post contract rather than the whole resource, which is a type-level
 * guard in both directions. It keeps the component trivially renderable from a test or a Storybook
 * entry with two string literals; and it makes it impossible for this file to reach for `content`,
 * `status` or `author`, none of which a share control has any business reading. Because the fields
 * are `Pick`ed from `PostSummary`, a `PostDetail` - which extends it - satisfies them by spreading,
 * and the props cannot drift from the API contract.
 *
 * Not exported, matching `src/components/ui/button.tsx`: the module's public surface is the
 * component. A caller needing the type writes `ComponentProps<typeof ShareBar>`.
 */
type ShareBarProps = Pick<PostSummary, 'slug' | 'title'> & {
  /**
   * Appended to the row's own classes and resolved by `cn`, so a caller's utility wins inside the
   * same group. Intended for placement only - margin, alignment, a top rule - never for restyling
   * the controls, which own their appearance through the `Button` primitive.
   */
  className?: string;
};

/**
 * The share row for a post: three social links, a clipboard control, and - where the device offers
 * one - the native share sheet.
 *
 * @example On the post reading page, below the article body
 * ```tsx
 * <ShareBar slug={post.slug} title={post.title} className="my-8" />
 * ```
 *
 * @example Spreading the resource the route already loaded
 * ```tsx
 * <ShareBar {...post} />
 * ```
 *
 * The example spacing is `my-8` rather than a `mt-*` spelling deliberately, and the reason is worth
 * carrying to any caller: the engine compiles `mx-*`, `my-*`, `px-*` and `py-*` to the LOGICAL
 * `margin-inline`, `margin-block`, `padding-inline` and `padding-block`, while `mt-*` and `pt-*`
 * compile to the physical `margin-top` and `padding-top` - verified against the generated
 * stylesheet. The logical spelling is the one to reach for. This component's own classes contain no
 * directional property on either axis, so nothing here needs converting.
 *
 * @param slug - {@link PostSummary.slug}, exactly as the API returned it. The canonical URL is
 *   derived from it; a blank value throws from `@/lib/seo` rather than producing `/blog/`.
 * @param title - {@link PostSummary.title}, unencoded. Percent-encoded per target.
 * @param className - Placement utilities for the row.
 * @returns The rendered share row.
 */
export function ShareBar({ slug, title, className }: ShareBarProps): JSX.Element {
  // The one URL everything below is built from. Derived in the body because it is a pure function of
  // a prop - see section 6.5 of the header for why it is not memoised, and section 2 for why it
  // comes from here rather than from the live document location.
  const canonicalUrl = absoluteUrl(postPath(slug));

  // Web Share availability, read through the external-store hook rather than branched on during
  // render. A bare `resolveNativeShare() !== undefined` in the body would be a hydration mismatch:
  // Next.js renders this component on the server first, where there is no `navigator`, so the
  // server would emit markup without the control and the first client render would emit markup with
  // it. The hook takes the server snapshot for hydration and reconciles afterwards - see the note
  // above the three snapshot functions.
  const canShareNatively = useSyncExternalStore(
    subscribeToNativeShare,
    getNativeShareSnapshot,
    getNativeShareServerSnapshot,
  );

  // Whether the URL is on screen as selectable text. Set only after a copy attempt fails, so the
  // resting row stays compact and the reveal reads as a response to the reader's action.
  const [isManualCopyVisible, setIsManualCopyVisible] = useState(false);

  /**
   * Put the canonical URL on the clipboard, or make it copyable by hand.
   *
   * Three outcomes, all of them terminal and all of them reported: copied, API absent, or API
   * present and refusing. The `catch` is what turns a rejected promise into a toast instead of an
   * unhandled rejection - a permission denial rejects even where the API exists.
   */
  async function copyCanonicalUrl(): Promise<void> {
    const clipboard = resolveClipboard();

    if (clipboard === undefined) {
      setIsManualCopyVisible(true);
      toast.error(COPY_UNAVAILABLE_MESSAGE);
      return;
    }

    try {
      await clipboard.writeText(canonicalUrl);
      // Retract a fallback left over from an earlier failure: the reader has what they wanted, and
      // leaving the URL on screen would suggest the copy did not work.
      setIsManualCopyVisible(false);
      toast.success(COPY_SUCCEEDED_MESSAGE);
    } catch {
      setIsManualCopyVisible(true);
      toast.error(COPY_FAILED_MESSAGE);
    }
  }

  /**
   * Hand the post to the device share sheet.
   *
   * Re-resolves the API at click time rather than trusting the snapshot the control was rendered
   * from, because the two observations are separated by however long the reader spent reading, and
   * because a resolved function must be bound to `navigator` at the point it is called. A cancelled
   * sheet is not a failure and is swallowed; anything else is reported.
   */
  async function shareNatively(): Promise<void> {
    const share = resolveNativeShare();

    if (share === undefined) {
      toast.error(NATIVE_SHARE_FAILED_MESSAGE);
      return;
    }

    try {
      await share({ title, url: canonicalUrl });
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      toast.error(NATIVE_SHARE_FAILED_MESSAGE);
    }
  }

  return (
    // A named <nav> rather than a `role="group"` div. Three of these controls navigate to an
    // external destination, `<nav>` carries that landmark role natively, and the guidance is to
    // reach for ARIA only where native semantics fall short - which here they do not. The label is
    // what makes the landmark worth having, since an unnamed one is indistinguishable from the site
    // header's in a landmark list.
    //
    // `inline-flex` so the row shrink-wraps its controls and can sit beside other content;
    // `max-w-full` so shrink-wrapping can never exceed the container; `flex-wrap` so a narrow
    // viewport wraps to a second and third line instead of overflowing horizontally. `gap-2` is the
    // --spacing scale, and it is a gap rather than margins between siblings, so no rule has to be
    // undone for the first or last control.
    <nav
      aria-label={GROUP_LABEL}
      className={cn('inline-flex max-w-full flex-wrap items-center gap-2', className)}
    >
      {SHARE_TARGETS.map(({ id, label, Icon, buildShareUrl }) => (
        // `asChild` renders the anchor itself and merges the button's classes onto it, so the
        // control looks like a button and IS a link. `ghost` is the variant the primitive documents
        // for toolbars, which keeps four controls from competing with the article they follow.
        <Button key={id} asChild variant="ghost">
          <a
            href={buildShareUrl(canonicalUrl, title)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${label}${NEW_TAB_HINT}`}
          >
            <Icon aria-hidden="true" />
            {label}
          </a>
        </Button>
      ))}

      {/* A genuine button, so no `asChild`: it acts on this page and navigates nowhere. `type` is
          explicit even though the primitive defaults to it, because this control will often sit
          inside a page that also renders forms and an accidental submit is a silent defect. The
          handler is wrapped so the click listener returns void rather than a promise. */}
      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          void copyCanonicalUrl();
        }}
      >
        <Copy aria-hidden="true" />
        {COPY_LABEL}
      </Button>

      {/* Rendered only where the device actually has a share sheet. A disabled control would be
          worse than none: the reader cannot tell why an enabled-looking button does nothing, and the
          three anchors already cover every browser. */}
      {canShareNatively ? (
        <Button
          type="button"
          variant="ghost"
          aria-label={`${NATIVE_SHARE_LABEL}${NATIVE_SHARE_HINT}`}
          onClick={() => {
            void shareNatively();
          }}
        >
          <Share2 aria-hidden="true" />
          {NATIVE_SHARE_LABEL}
        </Button>
      ) : null}

      {/* The fallback that always works, revealed only after a copy attempt could not complete.
          `basis-full` puts it on its own line within the wrapping row; `select-all` makes one click
          or one tap select the whole URL; `break-all` is right for a string with no spaces, so a
          long slug wraps inside the container instead of widening it. No `role="status"`: the toast
          that accompanies this reveal is already announced by the toaster's own live region, and a
          live region mounted at the same moment as its content is unreliable anyway - the toast
          message names the fallback, so a screen-reader user is told where to find it. */}
      {isManualCopyVisible ? (
        <p className="text-muted-foreground basis-full text-sm">
          <span className="sr-only">{MANUAL_COPY_PREAMBLE}</span>
          <span className="break-all select-all">{canonicalUrl}</span>
        </p>
      ) : null}
    </nav>
  );
}
