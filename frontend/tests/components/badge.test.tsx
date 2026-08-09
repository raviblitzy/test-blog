// Badge - component test for the design system's category and status pill.
//
// UNIT UNDER TEST: src/components/ui/badge.tsx. That module publishes the
// `Badge` component, the `badgeVariants` class-variance-authority table (exported
// so a sibling can carry the identical appearance on an element that is not a
// `<span>` - `badge-link.tsx` is that consumer), and the two lookup tables
// POST_STATUS_BADGE_VARIANTS / COMMENT_STATUS_BADGE_VARIANTS that map a wire
// literal onto the variant that renders it.
//
// ---------------------------------------------------------------------------
// 1. WHAT THIS FILE DELIBERATELY DOES NOT ASSERT
//
// Not one assertion below reads a class name, a computed style, or a snapshot,
// and there is no class-based DOM query anywhere in it. That absence is a
// requirement rather than an omission, and it comes from two directions at once:
//
//   - The token discipline. Every colour, radius, size and space the pill wears
//     resolves to a semantic token declared in src/app/globals.css, and each of
//     those tokens is declared TWICE - once at the document root and once under
//     `.dark`. A test that pinned the utility string for `published` would fail
//     the next time the token layer was re-toned, while the component stayed
//     correct: it would be measuring the design system's private vocabulary, not
//     the component's contract. The variant axis is therefore covered by
//     rendering each documented variant and proving the pill still renders its
//     label - which proves the prop is accepted, and nothing more.
//
//   - The accessibility floor. Colour is never this pill's message; its own
//     visible text is. Asserting the tone would be asserting the very channel
//     that must not carry meaning on its own. So the assertions target visible
//     text and accessible names, which is exactly what a reader who cannot
//     distinguish these hues relies on.
//
// Tailwind utilities are not resolved to real declarations in this environment
// either, so a style-based assertion would be measuring nothing regardless.
//
// ---------------------------------------------------------------------------
// 2. WHY THE STATUS ARRAYS ARE TYPED RATHER THAN LOOSE
//
// `postStatuses` and `commentStatuses` are annotated `readonly PostStatus[]` and
// `readonly CommentStatus[]`, reached through a TYPE-ONLY import from
// `@/lib/types`. Both unions are derived from `as const` tuples in that module -
// string-literal unions, never TypeScript `enum`s, so `src/middleware.ts` can
// reach them with `import type` and have the import elided entirely.
//
// The annotation is what turns this file into a contract check as well as a
// rendering check. A literal that the service never emits fails `tsc --noEmit`
// here rather than passing silently, and the two coverage tests below close the
// other half: they compare each array against the keys of the corresponding
// lookup table, which is a `Readonly<Record<PostStatus, BadgeVariant>>` and
// therefore exhaustive over the union at compile time. So if the service's
// `post_status` or `comment_status` type ever gains a member, badge.tsx must
// give it a tone before it compiles, and this file must iterate it before it
// passes. Neither can silently under-cover the other.
//
// ---------------------------------------------------------------------------
// 3. RUNTIME NOTES
//
//   - The test API is imported explicitly. `globals: true` is set in
//     vitest.config.ts, but frontend/tsconfig.json includes every *.tsx without
//     a `vitest/globals` types entry, so leaning on the globals would pass the
//     runner and fail the type gate with TS2593/TS2304. Both gates block.
//   - jest-dom's matchers are registered once in vitest.setup.ts and `cleanup()`
//     is already in an `afterEach` there, so neither is repeated here.
//   - No React import: tsconfig sets `"jsx": "react-jsx"`, the automatic runtime.
//   - No request interception, because this file issues no HTTP at all. `Badge`
//     renders one span from its props and reads nothing from the network, so
//     there is no server to stand up and no handler list to install.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  Badge,
  badgeVariants,
  COMMENT_STATUS_BADGE_VARIANTS,
  POST_STATUS_BADGE_VARIANTS,
  type BadgeVariant,
} from '@/components/ui/badge';
import type { CommentStatus, PostStatus } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * The domain states this pill has to render, and the text each one shows.
 *
 * Ordered as the service's own types declare them - lifecycle order for a post, queue order for a
 * comment - so a failure report reads in the same sequence a status filter would.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every member of the `PostStatus` union.
 *
 * Annotated rather than inferred: the annotation is what makes an invented literal a compile error,
 * and the "iterates every post state" case below is what makes a MISSING literal a test failure.
 * Between them the two directions are closed, which no single check achieves on its own.
 */
const postStatuses: readonly PostStatus[] = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];

/** Every member of the `CommentStatus` moderation union, in moderation-queue order. */
const commentStatuses: readonly CommentStatus[] = ['PENDING', 'APPROVED', 'REJECTED'];

/**
 * The visible label rendered for each post state.
 *
 * A `Record` over the union rather than a loose object, so the table cannot fall out of step with
 * the union: a fourth lifecycle state stops this file compiling until it has been given a label.
 * The labels are this test's own wording - badge.tsx deliberately carries no label table, because a
 * pill's text belongs to the caller.
 */
const postStatusLabels: Readonly<Record<PostStatus, string>> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
};

/** The visible label rendered for each moderation state. Exhaustive for the same reason. */
const commentStatusLabels: Readonly<Record<CommentStatus, string>> = {
  PENDING: 'Pending review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

/**
 * Every variant `badgeVariants` documents, assembled rather than transcribed.
 *
 * The six status tones are read out of the two lookup tables, so this list follows badge.tsx if a
 * state is ever re-toned. Only `neutral` and `category` are named directly, because neither
 * corresponds to a wire literal - and the `readonly BadgeVariant[]` annotation means even those two
 * stop compiling if the table drops them.
 */
const documentedVariants: readonly BadgeVariant[] = [
  'neutral',
  'category',
  ...postStatuses.map((status) => POST_STATUS_BADGE_VARIANTS[status]),
  ...commentStatuses.map((status) => COMMENT_STATUS_BADGE_VARIANTS[status]),
];

describe('Badge', () => {
  it('renders its children as the pill text', () => {
    render(<Badge>Engineering</Badge>);

    expect(screen.getByText('Engineering')).toBeInTheDocument();
  });

  it('renders the neutral pill when no variant is supplied', () => {
    // The documented use for a value with no state semantics - an account's role.
    // `defaultVariants` in badge.tsx resolves this to `neutral`, so a bare pill can never
    // accidentally assert a lifecycle state it was not given.
    render(<Badge>ADMIN</Badge>);

    expect(screen.getByText('ADMIN')).toBeInTheDocument();
  });

  it('renders a category pill carrying the category name', () => {
    render(<Badge variant="category">Design systems</Badge>);

    expect(screen.getByText('Design systems')).toBeInTheDocument();
  });

  it.each(postStatuses)('accepts the %s post state and shows its label', (status) => {
    const label = postStatusLabels[status];

    // The variant comes from the lookup table, which is how every real consumer reaches it: a
    // dashboard row spells `variant={POST_STATUS_BADGE_VARIANTS[post.status]}` rather than
    // choosing a tone at the call site.
    render(<Badge variant={POST_STATUS_BADGE_VARIANTS[status]}>{label}</Badge>);

    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it.each(commentStatuses)('accepts the %s moderation state and shows its label', (status) => {
    const label = commentStatusLabels[status];

    render(<Badge variant={COMMENT_STATUS_BADGE_VARIANTS[status]}>{label}</Badge>);

    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('iterates every post state the lookup table maps', () => {
    // The table is a `Readonly<Record<PostStatus, BadgeVariant>>`, so its key set IS the union as
    // far as the compiler is concerned. Comparing against it is what stops this suite quietly
    // under-covering a widened union: badge.tsx would fail to compile without a tone for the new
    // state, and this assertion fails until `postStatuses` above iterates it.
    expect([...postStatuses].sort()).toEqual(Object.keys(POST_STATUS_BADGE_VARIANTS).sort());
  });

  it('iterates every moderation state the lookup table maps', () => {
    expect([...commentStatuses].sort()).toEqual(Object.keys(COMMENT_STATUS_BADGE_VARIANTS).sort());
  });

  it('forwards aria-label so a caller can name the pill for assistive technology', () => {
    render(
      <Badge
        variant={POST_STATUS_BADGE_VARIANTS.PUBLISHED}
        aria-label="Publication state: published"
      >
        Published
      </Badge>,
    );

    // Queried by the text a sighted reader sees, then asserted on the name a screen reader
    // announces - the two channels that carry this pill's meaning, neither of which is its tone.
    expect(screen.getByText('Published')).toHaveAccessibleName('Publication state: published');
  });

  it('forwards id and data attributes onto the rendered pill', () => {
    render(
      <Badge
        variant={COMMENT_STATUS_BADGE_VARIANTS.PENDING}
        id="comment-7-moderation"
        data-testid="moderation-state"
        data-state="PENDING"
      >
        Pending review
      </Badge>,
    );

    // badge.tsx destructures `variant` and the style override out, then spreads everything else
    // LAST, which is what lets a consumer attach an id, a data attribute or an `aria-*` hook
    // without the primitive having to enumerate them. This is that guarantee, asserted.
    const pill = screen.getByTestId('moderation-state');

    expect(pill).toHaveAttribute('id', 'comment-7-moderation');
    expect(pill).toHaveAttribute('data-state', 'PENDING');
    expect(pill).toHaveTextContent('Pending review');
  });

  it('stays non-interactive, so nothing announces a span as a control', () => {
    render(<Badge variant="category">Engineering</Badge>);

    const pill = screen.getByText('Engineering');

    // badge.tsx documents this as an invariant: a pill that responds to a pointer while announcing
    // itself as a span is a control no keyboard can reach. A clickable chip is a link or a button
    // with `asChild`, both of which are focusable and both of which already exist.
    expect(pill).not.toHaveAttribute('role');
    expect(pill).not.toHaveAttribute('tabindex');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('exposes badgeVariants as a callable producing a non-empty class string', () => {
    expect(typeof badgeVariants).toBe('function');

    // Called with no argument and with an empty argument, because both are how a consumer reaches
    // the default appearance. WHAT the string contains is never asserted anywhere in this file -
    // that is the design system's private vocabulary, and pinning it is what the token discipline
    // forbids. Only that a string arrives, and that it is not empty.
    const withoutArguments = badgeVariants();
    const withEmptyArguments = badgeVariants({});

    expect(typeof withoutArguments).toBe('string');
    expect(withoutArguments.length).toBeGreaterThan(0);
    expect(typeof withEmptyArguments).toBe('string');
    expect(withEmptyArguments.length).toBeGreaterThan(0);
  });

  it.each(documentedVariants)('resolves badgeVariants for the %s variant', (variant) => {
    expect(() => badgeVariants({ variant })).not.toThrow();

    const resolved = badgeVariants({ variant });

    expect(typeof resolved).toBe('string');
    expect(resolved.length).toBeGreaterThan(0);
  });

  it.each(documentedVariants)('renders a pill for the %s variant with its own text', (variant) => {
    // The variant axis, covered end to end at the component boundary: every documented variant is
    // accepted as a prop and the pill still renders the label it was handed. Proving the prop is
    // honoured without asserting what it paints is the whole point.
    render(<Badge variant={variant}>{`State: ${variant}`}</Badge>);

    expect(screen.getByText(`State: ${variant}`)).toBeInTheDocument();
  });
});
