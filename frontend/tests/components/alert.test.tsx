// alert.test.tsx - the component test for `@/components/ui/alert`.
//
// ---------------------------------------------------------------------------
// THE ONE CONTRACT THIS FILE EXISTS TO GUARD
//
// `Alert` serves two opposite jobs from a single component - an inline notice
// that has to be ANNOUNCED the moment it appears, and an empty-state panel that
// is ordinary page content and must announce nothing at all - and what
// reconciles them is that the live-region role is DERIVED FROM THE VARIANT
// rather than fixed. Read off the component's own exhaustive role table, the
// derivation is:
//
//     destructive        ->  role="alert"   assertive: interrupts the reader
//     success | warning  ->  role="status"  polite: announced once idle
//     info | empty       ->  no role        content: reached in document order,
//                                           like any other paragraph
//
// `info` is the default variant, so THE DEFAULT IS SILENCE. That is the subtle
// half of the contract and the half most likely to regress unnoticed. A live
// region is a promise that an element's content will change and that the change
// is worth interrupting the reader for; `info` and `empty` panels are in the very
// first HTML the server sends, so giving them one makes every page load announce
// "no posts match your search" unprompted, ahead of the heading and the search
// field that would let the visitor act on it.
//
// Because the role is derived rather than authored per call site, the consumers
// author no ARIA of their own and simply trust this table:
//
//   - src/components/blog/post-list.tsx renders `<Alert variant="empty">` for a
//     feed with no results and relies on getting SILENCE.
//   - src/components/admin/data-table.tsx renders `<Alert role="status"
//     variant="empty">`, opting in explicitly because its empty state appears in
//     response to a filter the administrator just changed.
//   - src/components/blog/post-editor.tsx, src/app/error.tsx and
//     src/components/admin/category-form.tsx rely on `destructive` supplying
//     `role="alert"`, post-editor.tsx additionally on `warning` supplying
//     `role="status"`, and src/app/not-found.tsx on `info` supplying none.
//
// A regression in the derivation therefore strips or invents announcements
// across five surfaces at once, and none of those files can catch it because none
// of them authors the role. This is the only place it can be caught. Every case
// below accordingly asserts BOTH that the expected role is present AND that the
// other one is absent - half an assertion would still pass while a variant
// announced at the wrong urgency.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE DELIBERATELY DOES NOT ASSERT. PLEASE DO NOT ADD.
//
//   1. Class names, and therefore tone. Not one `toHaveClass`, `className` read,
//      class-based `querySelector`, `getComputedStyle` call or snapshot appears
//      below, per the token discipline in the plan (§0.7.2, §0.8.5). The variants
//      resolve to `--color-danger`, `--color-success`, `--color-warning`,
//      `--color-surface-muted` and `--color-border`, and that mapping is the
//      token layer's business: globals.css is free to re-tune it without
//      breaking any promise made to a user. Colour is never the sole carrier of
//      meaning here - the title and description always say what happened - so
//      the variant's one OBSERVABLE consequence is the role, and the role is
//      what these tests pin. `alertVariants` is exercised for shape only, never
//      for the content of the string it returns.
//   2. `aria-live`, `aria-atomic` or `aria-relevant`. `role="alert"` already
//      implies `aria-live="assertive"` and `role="status"` implies
//      `aria-live="polite"`; the component authors none of the three on purpose,
//      so asserting them would test the platform's defaults rather than this
//      unit, and re-deriving them here would contradict the roles.
//   3. An accessible NAME taken from the title. Measured against the same
//      accessible-name implementation these matchers use, it is the empty string
//      - and correctly so: `alert` and `status` take their name from the author,
//      never from their contents, and this component authors no `aria-label` or
//      `aria-labelledby`. What a reader hears is the SUBTREE, so the assertions
//      that matter are that the title and description sit inside the region
//      (below, through `within`) and that no stray label has appeared to
//      displace them. The name and description wiring is exercised through the
//      consumer path the component does support - `aria-labelledby` and
//      `aria-describedby` spread onto the root - which is where `AlertTitle` and
//      `AlertDescription` really do resolve them.
//
// No HTTP is issued from this file, so it registers no request handlers: the
// component takes no data and calls nothing. `@testing-library/jest-dom` is
// registered globally by vitest.setup.ts and `cleanup` already runs after every
// test there, so neither is repeated here.

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Alert, AlertDescription, AlertTitle, alertVariants } from '@/components/ui/alert';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/*                                                                            */
/* Real copy from the surfaces that render each variant, so a failure message  */
/* reads like the product rather than like a test.                            */
/* -------------------------------------------------------------------------- */

/** A rejected comment submission - the failure `role="alert"` exists for. */
const COMMENT_FAILURE_TITLE = 'Comment could not be posted';
const COMMENT_FAILURE_DETAIL = 'The comment was not saved. Post it again in a moment.';

/** A completed publish: an outcome of something the author just did, so polite. */
const PUBLISH_SUCCESS_TITLE = 'Post published';
const PUBLISH_SUCCESS_DETAIL = 'It is live on the home feed and on your public profile.';

/** A partial publish: also an outcome, also polite, but not a success. */
const PUBLISH_WARNING_TITLE = 'Saved, but not published';
const PUBLISH_WARNING_DETAIL = 'The post is stored as a draft. Publishing is a separate step.';

/** A standing informational notice: page content, present on first paint, silent. */
const DRAFT_NOTICE_TITLE = 'This post is still a draft';
const DRAFT_NOTICE_DETAIL = 'Only you and an administrator can read it until you publish it.';

/** An empty result set: page content too, and the case the home feed depends on. */
const EMPTY_FEED_TITLE = 'No posts match your search';
const EMPTY_FEED_DETAIL = 'Try a broader phrase, or clear the category filter.';

/* -------------------------------------------------------------------------- */
/* The contract, as a table                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The variants `Alert` declares.
 *
 * Read off the component's own props rather than restated as a string union
 * here, so the two cannot drift: renaming a variant in the source breaks this
 * file at compile time instead of leaving a case silently asserting a variant
 * that no longer exists.
 */
type AlertVariant = NonNullable<Parameters<typeof Alert>[0]['variant']>;

/**
 * The urgency each variant is expected to announce at, or `null` for the two that
 * must announce nothing at all.
 *
 * Keyed by {@link AlertVariant}, which makes it exhaustive: a sixth variant added
 * to the source stops this FILE compiling until its announcement behaviour has
 * been decided here. That is deliberately the same guarantee the component gives
 * itself by declaring its roles as a table rather than as a ternary - a new
 * variant must not be able to inherit whichever branch a conditional happened to
 * end on, in the source or in its test.
 */
const EXPECTED_ROLE_BY_VARIANT: Readonly<Record<AlertVariant, 'alert' | 'status' | null>> = {
  info: null,
  empty: null,
  success: 'status',
  warning: 'status',
  destructive: 'alert',
};

/** Every declared variant, walked by the exhaustiveness case below. */
const ALERT_VARIANTS: readonly AlertVariant[] = [
  'info',
  'success',
  'warning',
  'destructive',
  'empty',
];

/**
 * Asserts the announcement urgency of the single panel currently rendered.
 *
 * Both halves of the contract live in one place on purpose. The interesting
 * failure is not "the role went missing" but "the role changed", and a case that
 * only checked for the role it wanted would pass while a destructive error had
 * quietly demoted itself to polite. Routing every case through this helper means
 * no case can assert one half and forget the other.
 *
 * The positive check uses `getByRole`, whose failure attaches the rendered DOM
 * and the roles that were actually found - far more useful than a bare `null`.
 *
 * @param expected - The role the variant under test should announce through, or
 *   `null` when it must expose neither live-region role.
 */
function expectAnnouncement(expected: 'alert' | 'status' | null): void {
  if (expected === 'alert') {
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    return;
  }

  if (expected === 'status') {
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    return;
  }

  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
}

describe('Alert', () => {
  describe('live-region role', () => {
    it('announces a destructive failure assertively, because the reader has to act on it', () => {
      render(
        <Alert variant="destructive">
          <AlertTitle>{COMMENT_FAILURE_TITLE}</AlertTitle>
          <AlertDescription>{COMMENT_FAILURE_DETAIL}</AlertDescription>
        </Alert>,
      );

      expectAnnouncement('alert');
    });

    it('announces a success politely, because an outcome should not interrupt', () => {
      render(
        <Alert variant="success">
          <AlertTitle>{PUBLISH_SUCCESS_TITLE}</AlertTitle>
          <AlertDescription>{PUBLISH_SUCCESS_DETAIL}</AlertDescription>
        </Alert>,
      );

      expectAnnouncement('status');
    });

    it('announces a warning politely too, since a partial outcome is still an outcome', () => {
      render(
        <Alert variant="warning">
          <AlertTitle>{PUBLISH_WARNING_TITLE}</AlertTitle>
          <AlertDescription>{PUBLISH_WARNING_DETAIL}</AlertDescription>
        </Alert>,
      );

      expectAnnouncement('status');
    });

    it('leaves an informational notice silent, because it is content and not an outcome', () => {
      render(
        <Alert variant="info">
          <AlertTitle>{DRAFT_NOTICE_TITLE}</AlertTitle>
          <AlertDescription>{DRAFT_NOTICE_DETAIL}</AlertDescription>
        </Alert>,
      );

      expectAnnouncement(null);

      // Silent is not the same as absent. The copy is rendered and reached in
      // document order, exactly like the paragraph beside it.
      expect(screen.getByText(DRAFT_NOTICE_TITLE)).toBeInTheDocument();
      expect(screen.getByText(DRAFT_NOTICE_DETAIL)).toBeInTheDocument();
    });

    it('leaves an empty state silent, so a server-rendered feed does not announce on load', () => {
      // The case src/components/blog/post-list.tsx and the profile's empty result
      // set depend on: this panel is in the first HTML the server sends, so an
      // announcement here would fire before the heading and the search field that
      // would let the visitor do something about it.
      render(
        <Alert variant="empty">
          <AlertTitle>{EMPTY_FEED_TITLE}</AlertTitle>
          <AlertDescription>{EMPTY_FEED_DETAIL}</AlertDescription>
        </Alert>,
      );

      expectAnnouncement(null);

      expect(screen.getByText(EMPTY_FEED_TITLE)).toBeInTheDocument();
      expect(screen.getByText(EMPTY_FEED_DETAIL)).toBeInTheDocument();
    });

    it('falls back to the silent informational variant when no variant is supplied', () => {
      render(
        <Alert>
          <AlertTitle>{DRAFT_NOTICE_TITLE}</AlertTitle>
          <AlertDescription>{DRAFT_NOTICE_DETAIL}</AlertDescription>
        </Alert>,
      );

      // Compared against the table's own `info` entry rather than a repeated
      // literal, so "the default is `info`" and "`info` is silent" stay one fact.
      expectAnnouncement(EXPECTED_ROLE_BY_VARIANT.info);

      expect(screen.getByText(DRAFT_NOTICE_TITLE)).toBeInTheDocument();
    });

    it('lets a consumer opt a silent empty state into a polite announcement', () => {
      // The path src/components/admin/data-table.tsx takes. Its empty state
      // appears in response to a filter the administrator just changed, so there
      // it really is an outcome and does deserve announcing. The variant-derived
      // role is applied BEFORE the props spread, which is what lets this win.
      render(
        <Alert variant="empty" role="status">
          <AlertTitle>{EMPTY_FEED_TITLE}</AlertTitle>
          <AlertDescription>{EMPTY_FEED_DETAIL}</AlertDescription>
        </Alert>,
      );

      expectAnnouncement('status');
    });

    it('lets a consumer suppress an announcement it has already made itself', () => {
      // The same override in the opposite direction, for a caller that has
      // wrapped the alert in its own live region. Without it the failure would be
      // announced twice.
      render(
        <Alert variant="destructive" role="none">
          <AlertTitle>{COMMENT_FAILURE_TITLE}</AlertTitle>
          <AlertDescription>{COMMENT_FAILURE_DETAIL}</AlertDescription>
        </Alert>,
      );

      expectAnnouncement(null);

      // Suppressing the announcement must not suppress the message.
      expect(screen.getByText(COMMENT_FAILURE_TITLE)).toBeInTheDocument();
    });

    it('derives an announcement for every variant it declares, and for nothing else', () => {
      // `EXPECTED_ROLE_BY_VARIANT` is keyed by the component's own prop type, so
      // the compiler already refuses a missing or invented variant. This assertion
      // adds the runtime half: that the list actually walked below is that table
      // and not a stale subset of it.
      expect([...ALERT_VARIANTS].sort()).toEqual(Object.keys(EXPECTED_ROLE_BY_VARIANT).sort());

      for (const variant of ALERT_VARIANTS) {
        const view = render(
          <Alert variant={variant}>
            <AlertTitle>{DRAFT_NOTICE_TITLE}</AlertTitle>
          </Alert>,
        );

        expectAnnouncement(EXPECTED_ROLE_BY_VARIANT[variant]);

        // Unmounted before the next iteration, because `screen` searches the whole
        // document and `cleanup` runs between TESTS, not between renders inside
        // one. Two panels in the document at once would defeat the "the other role
        // is absent" half of every assertion above.
        view.unmount();
      }
    });
  });

  describe('composition', () => {
    it('places the title and the description inside the region that announces them', () => {
      render(
        <Alert variant="destructive">
          <AlertTitle>{COMMENT_FAILURE_TITLE}</AlertTitle>
          <AlertDescription>{COMMENT_FAILURE_DETAIL}</AlertDescription>
        </Alert>,
      );

      // A live region announces its own subtree, so "somewhere on the page" is not
      // good enough: copy rendered as a sibling of the region would be silent
      // while every text query in this file still passed.
      const region = within(screen.getByRole('alert'));

      expect(region.getByText(COMMENT_FAILURE_TITLE)).toBeInTheDocument();
      expect(region.getByText(COMMENT_FAILURE_DETAIL)).toBeInTheDocument();
    });

    it('keeps a silent empty panel whole, which is the shape the feed renders', () => {
      // A test id is the handle of last resort, and a panel that deliberately has
      // no role is exactly the case it exists for - there is nothing else to query
      // the root by, which is the point. src/components/blog/post-list.tsx renders
      // precisely this shape for a feed with no results: `variant="empty"`, a
      // heading at the level the cards would have used, a description, and no ARIA
      // of its own.
      render(
        <Alert variant="empty" data-testid="empty-feed-panel">
          <AlertTitle as="h2">{EMPTY_FEED_TITLE}</AlertTitle>
          <AlertDescription>{EMPTY_FEED_DETAIL}</AlertDescription>
        </Alert>,
      );

      const panel = within(screen.getByTestId('empty-feed-panel'));

      expect(panel.getByRole('heading', { level: 2, name: EMPTY_FEED_TITLE })).toBeInTheDocument();
      expect(panel.getByText(EMPTY_FEED_DETAIL)).toBeInTheDocument();

      // A heading a screen-reader user can navigate to is still not a live region,
      // so the panel stays silent even once it occupies the document outline.
      expectAnnouncement(null);
    });

    it('renders the title as a non-heading by default, so it cannot corrupt an outline', () => {
      // Heading order is a page-level concern and a primitive cannot know where in
      // an outline it has been placed, so the level is the consumer's to choose.
      render(
        <Alert variant="warning">
          <AlertTitle>{PUBLISH_WARNING_TITLE}</AlertTitle>
          <AlertDescription>{PUBLISH_WARNING_DETAIL}</AlertDescription>
        </Alert>,
      );

      const region = within(screen.getByRole('status'));

      expect(region.getByText(PUBLISH_WARNING_TITLE)).toBeInTheDocument();
      expect(region.queryByRole('heading')).toBeNull();
    });
  });

  describe('accessible name and description', () => {
    it('authors neither itself, because a live region announces its contents', () => {
      render(
        <Alert variant="destructive">
          <AlertTitle>{COMMENT_FAILURE_TITLE}</AlertTitle>
          <AlertDescription>{COMMENT_FAILURE_DETAIL}</AlertDescription>
        </Alert>,
      );

      const region = screen.getByRole('alert');

      // `alert` and `status` take their name from the author and never from their
      // contents, and this component authors no `aria-label`, `aria-labelledby` or
      // `aria-describedby` - so both computations are empty by design, and what
      // the reader hears is the subtree asserted immediately below. This case pins
      // that design: it fails the moment a label is introduced that would displace
      // the copy with a shorter summary of it.
      expect(region).not.toHaveAccessibleName();
      expect(region).not.toHaveAccessibleDescription();

      expect(region).toHaveTextContent(COMMENT_FAILURE_TITLE);
      expect(region).toHaveTextContent(COMMENT_FAILURE_DETAIL);
    });

    it('resolves its name from AlertTitle once a consumer wires aria-labelledby', () => {
      render(
        <Alert variant="destructive" aria-labelledby="comment-failure-title">
          <AlertTitle id="comment-failure-title">{COMMENT_FAILURE_TITLE}</AlertTitle>
          <AlertDescription>{COMMENT_FAILURE_DETAIL}</AlertDescription>
        </Alert>,
      );

      expect(screen.getByRole('alert')).toHaveAccessibleName(COMMENT_FAILURE_TITLE);
    });

    it('resolves its description from AlertDescription once a consumer wires it', () => {
      render(
        <Alert variant="destructive" aria-describedby="comment-failure-detail">
          <AlertTitle>{COMMENT_FAILURE_TITLE}</AlertTitle>
          <AlertDescription id="comment-failure-detail">{COMMENT_FAILURE_DETAIL}</AlertDescription>
        </Alert>,
      );

      expect(screen.getByRole('alert')).toHaveAccessibleDescription(COMMENT_FAILURE_DETAIL);
    });
  });

  describe('prop pass-through', () => {
    it('spreads a consumer id and data attribute onto the panel that carries the role', () => {
      render(
        <Alert variant="success" id="publish-outcome" data-testid="publish-outcome">
          <AlertTitle>{PUBLISH_SUCCESS_TITLE}</AlertTitle>
          <AlertDescription>{PUBLISH_SUCCESS_DETAIL}</AlertDescription>
        </Alert>,
      );

      const region = screen.getByRole('status');

      expect(region).toHaveAttribute('id', 'publish-outcome');
      expect(region).toHaveAttribute('data-testid', 'publish-outcome');

      // The same element reached both ways, which is the part worth proving: the
      // spread lands on the root that announces, not on a wrapper around it, so a
      // consumer's `id` really is the one an `aria-labelledby` elsewhere can point
      // at.
      expect(screen.getByTestId('publish-outcome')).toBe(region);
    });
  });

  describe('alertVariants', () => {
    it('is a callable class table', () => {
      expect(typeof alertVariants).toBe('function');
    });

    it('returns a non-empty class string for every declared variant', () => {
      for (const variant of ALERT_VARIANTS) {
        const classes = alertVariants({ variant });

        // Shape only. WHICH classes come back is the token layer's business, and
        // pinning them here would turn a palette edit in globals.css into a
        // failure in a file that has no opinion about colour.
        expect(typeof classes).toBe('string');
        expect(classes.length).toBeGreaterThan(0);
      }
    });

    it('falls back to the informational treatment when called with no arguments', () => {
      const fallback = alertVariants();

      expect(typeof fallback).toBe('string');
      expect(fallback.length).toBeGreaterThan(0);

      // Compared against the table's own output rather than against a literal, so
      // the default variant is pinned without a single class name appearing in
      // this file. This is the styling counterpart of the silent-by-default role
      // asserted above.
      expect(fallback).toBe(alertVariants({ variant: 'info' }));
    });
  });
});
