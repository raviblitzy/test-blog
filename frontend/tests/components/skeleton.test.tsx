// Component tests for `Skeleton` - src/components/ui/skeleton.tsx.
//
// The unit is the smallest primitive in the design system: one `<div>`, no
// state, no effect, no variant table, no endpoint. Everything observable about
// it is therefore either STRUCTURE (how many elements, what tag, whether it has
// children), an ATTRIBUTE (what the caller passed through), or ACCESSIBILITY
// (whether it reaches the accessibility tree, and under what name). Those three
// categories are exactly what this file asserts on, and nothing else.
//
// ---------------------------------------------------------------------------
// WHY THERE IS NOT A SINGLE CLASS-NAME ASSERTION BELOW
//
// `Skeleton`'s entire *visible* behaviour is a class string: `bg-surface-muted`,
// `animate-pulse`, `rounded-md`, `motion-reduce:animate-none`. Asserting on it
// is the obvious move and it is the one thing this file must not do.
//
// The plan is explicit about it - component tests "assert on accessible names
// and visible text rather than on class names, so token or styling changes do
// not break them" (§0.7.2), and the token layer in src/app/globals.css exists
// precisely so a palette, radius or animation decision is a one-file edit
// (§0.8.5). A `toHaveClass('bg-surface-muted')` here would quietly convert that
// one-file edit into a two-file edit and make the test suite a veto on the
// design system. So: no `toHaveClass`, no `className` read, no class selector,
// no `getComputedStyle`, no DOM snapshot. If this component's fill, radius or
// pulse ever changes, every test below must still pass - that is the point.
//
// The corollary is that `className` IS exercised (a caller passing one must not
// break anything) while remaining unasserted: see 'accepts a className without
// disturbing anything else'.
//
// ---------------------------------------------------------------------------
// THE TWO ACCESSIBILITY BRANCHES, AND WHY BOTH ARE TESTED
//
// `Skeleton` writes `aria-hidden="true"` BEFORE spreading `...props`, so the
// default is decorative - a screen reader announcing a row of empty boxes is
// noise - but a caller can override it like any other attribute. Both halves of
// that design are load-bearing for real callers:
//
//   * src/app/loading.tsx and the post-card / post-list placeholder states
//     compose several `Skeleton`s inside ONE announced wrapper. The wrapper owns
//     `role="status"` and the accessible name; the placeholders stay hidden.
//     Covered by 'composes inside an announced wrapper without contributing to
//     its name'.
//   * A surface that wants a single placeholder to be the announced region opts
//     back in with `aria-hidden={false}`. Covered by 'exposes the accessible
//     name once a consumer opts back in'.
//
// The negative branch is asserted the sharp way rather than the easy way: a
// role AND a name are supplied and the node is still proven absent from the
// accessibility tree, which no amount of trivially-null querying would show.
//
// ---------------------------------------------------------------------------
// SETUP THIS FILE DELIBERATELY DOES NOT REPEAT
//
//   * `@testing-library/jest-dom` - vitest.setup.ts imports the `/vitest` entry
//     already, so `toBeInTheDocument`, `toHaveAttribute`, `toHaveAccessibleName`
//     and `toBeEmptyDOMElement` are registered globally. Importing it again
//     would register the matchers twice.
//   * `cleanup()` - vitest.setup.ts runs it in `afterEach`. A second call is
//     redundant and hides cross-test leakage rather than preventing it.
//   * MSW - `Skeleton` imports only `cn` and reads tokens; it cannot issue a
//     request. tests/msw/handlers.ts is therefore not imported here, and an
//     unused import would fail `eslint --max-warnings=0` anyway.
//   * `@testing-library/user-event` - not a declared dependency of this project
//     (frontend/package.json), so interaction goes through `fireEvent`. One
//     click on a div needs nothing more.
//   * `import React from 'react'` - tsconfig.json sets `"jsx": "react-jsx"`, so
//     the default import would be both unnecessary and an unused-variable
//     warning, which `--max-warnings=0` turns into a failed run.

import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Skeleton } from '@/components/ui/skeleton';

/**
 * The ARIA live-region role a caller opts into when a placeholder should be
 * announced. Named once so the role string in the render and the role string in
 * the query can never drift apart.
 */
const STATUS_ROLE = 'status';

/** Accessible name used by the opt-in cases. */
const LOADING_LABEL = 'Loading posts';

/** Accessible name used by the composed-wrapper case. */
const WRAPPER_LABEL = 'Loading author';

/**
 * `data-testid` is how a *decorative* node is retrieved: it is invisible to
 * every accessibility query by design, and `getByTestId` is the one query
 * family that does not consult the accessibility tree. It doubles as proof that
 * `data-*` attributes pass through.
 */
const TEST_ID = 'skeleton';

describe('Skeleton', () => {
  it('renders a single empty element by default', () => {
    const { container } = render(<Skeleton />);

    // Structure, not styling: one element, no wrapper, no children. A caller
    // composing a shape out of several placeholders depends on each one being
    // exactly one node it can position.
    expect(container.childElementCount).toBe(1);

    const placeholder = container.firstElementChild;

    expect(placeholder).not.toBeNull();
    expect(placeholder).toBeInTheDocument();
    expect(placeholder?.tagName).toBe('DIV');
    expect(placeholder).toBeEmptyDOMElement();
  });

  it('forwards every native div attribute it is given', () => {
    render(
      <Skeleton id="cover-placeholder" data-testid={TEST_ID} data-slot="cover" tabIndex={-1} />,
    );

    const placeholder = screen.getByTestId(TEST_ID);

    // The concrete proof of the `ComponentProps<'div'>` contract: a plain
    // attribute, two `data-*` attributes, and a camel-cased React prop that
    // React maps onto the lower-case DOM attribute.
    expect(placeholder).toHaveAttribute('id', 'cover-placeholder');
    expect(placeholder).toHaveAttribute('data-testid', TEST_ID);
    expect(placeholder).toHaveAttribute('data-slot', 'cover');
    expect(placeholder).toHaveAttribute('tabindex', '-1');

    // Caller attributes must not cost the component its own default. `props` is
    // spread after `aria-hidden`, so anything the caller did NOT set survives.
    expect(placeholder).toHaveAttribute('aria-hidden', 'true');
  });

  it('forwards a ref through the prop spread', () => {
    const ref = createRef<HTMLDivElement>();

    render(<Skeleton data-testid={TEST_ID} ref={ref} />);

    // The component uses no `forwardRef`: under React 19 `ref` arrives as an
    // ordinary prop and lands on the div with the rest of the spread. Asserting
    // it here is what keeps a well-meaning `forwardRef` wrapper - or its
    // removal - from silently breaking measurement callers.
    expect(ref.current).toBe(screen.getByTestId(TEST_ID));
  });

  it('stays out of the accessibility tree by default', () => {
    render(<Skeleton data-testid={TEST_ID} />);

    // Decoration, so it is hidden without the caller asking. The node exists in
    // the DOM - `getByTestId` found it - but announces nothing.
    expect(screen.getByTestId(TEST_ID)).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole(STATUS_ROLE)).toBeNull();
  });

  it('stays out of the accessibility tree even when a role and a name are supplied', () => {
    render(<Skeleton data-testid={TEST_ID} role={STATUS_ROLE} aria-label={LOADING_LABEL} />);

    const placeholder = screen.getByTestId(TEST_ID);

    // Both attributes really are on the node...
    expect(placeholder).toHaveAttribute('role', STATUS_ROLE);
    expect(placeholder).toHaveAttribute('aria-label', LOADING_LABEL);

    // ...and it is still absent from the accessibility tree, because the
    // component's `aria-hidden` default was not overridden. Asserting the
    // negative WITH a role present is what makes it meaningful: the accessible
    // query finds nothing while the same query including hidden nodes finds
    // exactly one, so the miss is caused by `aria-hidden` rather than by there
    // being nothing to find.
    expect(screen.queryByRole(STATUS_ROLE)).toBeNull();
    expect(screen.queryAllByRole(STATUS_ROLE, { hidden: true })).toHaveLength(1);
  });

  it('exposes the accessible name once a consumer opts back in', () => {
    render(
      <Skeleton
        data-testid={TEST_ID}
        role={STATUS_ROLE}
        aria-label={LOADING_LABEL}
        aria-hidden={false}
      />,
    );

    // The query itself is accessibility-based: reaching the node through
    // `getByRole` proves it is in the accessibility tree, and the identity check
    // proves it is the same node the component rendered.
    const region = screen.getByRole(STATUS_ROLE);

    expect(region).toBe(screen.getByTestId(TEST_ID));
    expect(region).toHaveAccessibleName(LOADING_LABEL);
  });

  it('composes inside an announced wrapper without contributing to its name', () => {
    render(
      <div role={STATUS_ROLE} aria-label={WRAPPER_LABEL}>
        <Skeleton data-testid="avatar-placeholder" />
        <Skeleton data-testid="byline-placeholder" />
      </div>,
    );

    // The pattern app/loading.tsx and the post-card placeholder state use: the
    // meaning lives on the wrapper, the placeholders stay decoration. There is
    // no `count` or `lines` prop precisely so the consumer's own layout says how
    // many there are.
    const region = screen.getByRole(STATUS_ROLE);

    expect(region).toHaveAccessibleName(WRAPPER_LABEL);
    expect(screen.getByTestId('avatar-placeholder')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('byline-placeholder')).toHaveAttribute('aria-hidden', 'true');

    // Empty decorative children contribute no text, so the wrapper's name comes
    // from its label alone and never from the placeholders.
    expect(screen.queryAllByRole(STATUS_ROLE)).toHaveLength(1);
  });

  it('forwards DOM event handlers', () => {
    const handleClick = vi.fn();

    render(<Skeleton data-testid={TEST_ID} onClick={handleClick} />);

    fireEvent.click(screen.getByTestId(TEST_ID));

    // `ComponentProps<'div'>` covers handlers as well as attributes, and the
    // spread is what delivers them. Placeholders are rarely interactive, but a
    // skeleton row standing in for a clickable card is a real case.
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('accepts a className without disturbing anything else', () => {
    render(
      <Skeleton
        className="size-10 rounded-full"
        data-testid={TEST_ID}
        role={STATUS_ROLE}
        aria-label={LOADING_LABEL}
        aria-hidden={false}
      />,
    );

    // Geometry is the caller's job, expressed as utility classes. This case
    // proves passing them is accepted and costs the component nothing - and
    // then deliberately stops. What the merged class string contains is the
    // token layer's business, not this suite's; see the header.
    const region = screen.getByRole(STATUS_ROLE);

    expect(region).toBe(screen.getByTestId(TEST_ID));
    expect(region).toHaveAccessibleName(LOADING_LABEL);
    expect(region).toBeEmptyDOMElement();
  });
});
