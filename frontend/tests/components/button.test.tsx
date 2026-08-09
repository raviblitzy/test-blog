/**
 * Component tests for `Button` - src/components/ui/button.tsx.
 *
 * That module exports two symbols and both are exercised here: the `Button`
 * component, which is the one file in this repository permitted to render a raw
 * `<button>`, and `buttonVariants`, the class-variance-authority table it styles
 * itself from and which anchors that cannot be wrapped borrow instead of copying
 * classes. `Button` is reached by every route group and by the `layout`, `blog`
 * and `admin` component folders, so a regression here is a regression
 * everywhere - which is why the `asChild` group below is as long as it is.
 *
 * ---------------------------------------------------------------------------
 * NOT ONE CLASS NAME IS ASSERTED BELOW, AND THAT IS THE WHOLE DESIGN
 *
 * `Button`'s entire variant behaviour is expressed as utility classes, so the
 * obvious test - render `variant="destructive"`, assert the danger class landed -
 * is precisely the test this project forbids. Class names belong to the token
 * layer in src/app/globals.css, which is free to re-map a semantic token or
 * rename a utility without changing one behaviour; a suite asserting on them
 * would turn a palette edit into a wall of red and would teach the next author to
 * reach for `toHaveClass` instead of for the accessibility tree. AAP §0.7.2 puts
 * it directly - component tests assert on accessible names and visible text
 * rather than on class names - and the zero-hardcoded-presentation-values
 * standard in AAP §0.10.1 is the rule it serves.
 *
 * The following are therefore deliberately absent, and must stay absent:
 *
 *   - `toHaveClass`, and any read of or comparison against `className`
 *   - `querySelector` with a class selector
 *   - `getComputedStyle`, which in jsdom computes no cascade for utility classes
 *     anyway, so such an assertion would be confidently meaningless as well as
 *     banned
 *   - snapshots of any kind, which smuggle markup and class names into a fixture
 *     nobody reads and nobody updates deliberately
 *
 * Every assertion in this file targets one of five things: a ROLE, an ACCESSIBLE
 * NAME, an ATTRIBUTE, FOCUS, or a CALL COUNT. What that leaves for the `variant`
 * and `size` axes is the part actually worth protecting - that each documented
 * value is accepted, and that a control given it still renders under its
 * accessible name and still answers a click. For `buttonVariants`: that it is
 * callable, that it returns a non-empty string, and that no documented
 * combination throws. Never what the string contains.
 *
 * The focus RING falls under the same rule. button.tsx draws it with
 * `focus-visible:outline-*` utilities bound to the --color-ring token, which is a
 * token decision; the behavioural half - that the control can hold focus at all -
 * is what belongs to this suite, so `toHaveFocus()` appears and no ring assertion
 * does.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE KEYBOARD CASE CAN AND CANNOT PROVE IN THIS RUNNER
 *
 * Measured in this environment rather than assumed: jsdom does NOT implement the
 * activation behaviour that makes Enter or Space fire a click on a focused native
 * button. After `keyDown` and `keyUp` for both keys the click handler had been
 * called zero times. Asserting otherwise would not test the component, it would
 * test a browser that is not present, and it would fail.
 *
 * The keyboard case below therefore proves the three things this runner can
 * prove - focus reaches the control, key events reach its handlers, and
 * activation reaches its click handler - and leaves the trusted
 * Enter/Space-to-click path to the real browser in tests/e2e/**, which is the
 * runner that has one.
 *
 * ---------------------------------------------------------------------------
 * IMPORTS, AND THE THREE THINGS THIS FILE MUST NOT IMPORT
 *
 *   - `@testing-library/user-event` is NOT in the pinned dependency set in
 *     frontend/package.json, so interaction is driven with `fireEvent`. Adding a
 *     package to reach `userEvent.click` would trade the tier's exact-pin story
 *     for one line of ergonomics.
 *   - `@testing-library/jest-dom` is registered once by frontend/vitest.setup.ts,
 *     through its `/vitest` subpath so that Vitest's `expect` is the one extended.
 *     Importing it again here would be a second source of truth for the matcher
 *     set.
 *   - `cleanup` likewise: vitest.setup.ts registers it in an `afterEach` of its
 *     own, so a manual call here would be redundant at best.
 *
 * `describe`, `it`, `expect` and `vi` ARE imported even though
 * frontend/vitest.config.ts sets `globals: true`, because frontend/tsconfig.json
 * includes every `.tsx` file in the `tsc --noEmit` program, and a test leaning on
 * those globals fails that gate with TS2593 while passing at runtime. Both gates
 * block, so "it runs" is only half the bar.
 *
 * No request interception is configured and none is needed: `Button` performs no
 * HTTP, so this file issues none.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIXTURE URL IS A CONSTANT RATHER THAN AN INLINE STRING LITERAL
 *
 * `POST_HREF` is used by both the render and the `toHaveAttribute` assertion,
 * which is worth doing on its own - the two cannot drift apart. It is also
 * load-bearing for the lint gate, which runs as `eslint . --max-warnings=0`.
 * `@next/next/no-html-link-for-pages` reports any JSX `<a>` whose href is a
 * STRING LITERAL matching an application route, and src/app/blog/[slug]/page.tsx
 * makes `/blog/hello-world` exactly such a route (a dynamic segment compiles to a
 * catch-all regex, so any single-segment slug matches). Measured with that route
 * in place: the literal spelling fails the gate with an error, while the
 * expression spelling passes, because the rule inspects only literal attribute
 * values. The rendered DOM and the assertion are identical either way, so the
 * constant costs nothing and keeps a blocking gate green as the route tree fills
 * in. It is the right fix rather than an inline `eslint-disable` - and
 * frontend/eslint.config.mjs rules out relaxing the rule in configuration.
 *
 * A plain `<a>` rather than `next/link` is the correct child for these cases:
 * what is under test is Slot composition, and a router-aware link would drag an
 * App Router context into a unit test to prove nothing extra.
 */
import type { ComponentProps, MouseEvent as ReactMouseEvent } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Button, buttonVariants } from '@/components/ui/button';

/*
 * The two prop axes, DERIVED from the component rather than restated beside it.
 *
 * button.tsx keeps its props type private and documents deriving it with
 * `ComponentProps<typeof Button>`; doing that here means a renamed, removed or
 * added variant is caught by `tsc --noEmit` in this file rather than leaving a
 * case that runs but asserts nothing about the axis it claims to cover.
 * `NonNullable` strips the `null | undefined` that class-variance-authority adds
 * to every variant prop.
 */
type ButtonVariant = NonNullable<ComponentProps<typeof Button>['variant']>;
type ButtonSize = NonNullable<ComponentProps<typeof Button>['size']>;

/** Every `variant` the component documents, in table order. */
const VARIANTS: readonly ButtonVariant[] = ['primary', 'secondary', 'ghost', 'destructive'];

/** Every `size` the component documents, in table order. */
const SIZES: readonly ButtonSize[] = ['sm', 'default', 'lg'];

/** The post URL the `asChild` cases navigate to. See the header for why it is a constant. */
const POST_HREF = '/blog/hello-world';

describe('Button', () => {
  describe('accessible name', () => {
    it('takes its accessible name from its children', () => {
      render(<Button>Publish</Button>);

      // Queried BY the name as well as asserted on it: `getByRole` with a `name`
      // filter fails if the accessibility tree disagrees, so the query is half
      // the test and the matcher states the expectation in the failure message.
      const button = screen.getByRole('button', { name: 'Publish' });

      expect(button).toHaveAccessibleName('Publish');
    });

    it('takes its accessible name from aria-label when its only child is an icon', () => {
      // The icon-only shape button.tsx documents: no `icon` size exists, the
      // caller squares the default size with token utilities, the glyph is hidden
      // from assistive technology, and `aria-label` is what names the control.
      // Without that label this button would have no accessible name at all,
      // which is the regression this case exists to catch.
      render(
        <Button aria-label="Open menu">
          <svg aria-hidden="true" focusable="false" />
        </Button>,
      );

      const button = screen.getByRole('button', { name: 'Open menu' });

      expect(button).toHaveAccessibleName('Open menu');
    });
  });

  describe('activation', () => {
    it('calls its click handler exactly once when clicked', () => {
      const onClick = vi.fn();
      render(<Button onClick={onClick}>Publish</Button>);

      fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

      // Once, not "at least once": a primitive that double-fired would corrupt
      // every mutation the dashboard and admin screens submit through it.
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('reports itself disabled and swallows the click when `disabled` is set', () => {
      const onClick = vi.fn();
      render(
        <Button disabled onClick={onClick}>
          Publish
        </Button>,
      );

      const button = screen.getByRole('button', { name: 'Publish' });

      // Two halves of one contract. `toBeDisabled` is what a screen reader
      // announces and what the platform enforces; the silent handler is what the
      // caller depends on when it disables a control mid-submission.
      expect(button).toBeDisabled();

      fireEvent.click(button);

      expect(onClick).not.toHaveBeenCalled();
    });

    it('holds focus and receives Enter and Space while focused', () => {
      const onKeyDown = vi.fn();
      const onClick = vi.fn();
      render(
        <Button onKeyDown={onKeyDown} onClick={onClick}>
          Publish
        </Button>,
      );

      const button = screen.getByRole('button', { name: 'Publish' });

      // 1. The control is focusable. This is the behavioural half of the focus
      //    contract; the visible ring is a token concern and is not asserted.
      button.focus();
      expect(button).toHaveFocus();

      // 2. Key events reach the control's own handlers, so a caller that needs
      //    key handling gets it. Both activation keys are checked.
      fireEvent.keyDown(button, { key: 'Enter', code: 'Enter' });
      fireEvent.keyDown(button, { key: ' ', code: 'Space' });
      expect(onKeyDown).toHaveBeenCalledTimes(2);

      // 3. Activation of the FOCUSED control reaches the click handler. This is
      //    the closest this runner gets to keyboard activation: jsdom does not
      //    turn Enter or Space into a click, as the header records, and the
      //    trusted-event path is covered by the browser suite instead.
      fireEvent.click(button);
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  /*
   * The variant and size axes.
   *
   * These two groups look thin and are not. Both props exist ONLY to select a
   * class set, so the one thing a test may not do is check the class set, and
   * what is left to verify is the contract around it: the value is accepted, the
   * control still renders under its accessible name, it is still enabled, and it
   * still answers a click. That is exactly the regression a typo in the variance
   * table produces - class-variance-authority silently falls back rather than
   * throwing on an unknown key, so a renamed variant does not fail loudly; it
   * fails as an unstyled control that still passes every naive test. Deriving
   * `ButtonVariant` and `ButtonSize` from the component is the other half of that
   * guard: a renamed key stops `tsc --noEmit` here.
   */
  describe('variant', () => {
    it.each(VARIANTS)('accepts variant "%s" and keeps the control operable', (variant) => {
      const onClick = vi.fn();
      render(
        <Button variant={variant} onClick={onClick}>
          Publish
        </Button>,
      );

      const button = screen.getByRole('button', { name: 'Publish' });

      expect(button).toHaveAccessibleName('Publish');
      expect(button).toBeEnabled();

      fireEvent.click(button);

      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('size', () => {
    it.each(SIZES)('accepts size "%s" and keeps the control operable', (size) => {
      const onClick = vi.fn();
      render(
        <Button size={size} onClick={onClick}>
          Publish
        </Button>,
      );

      const button = screen.getByRole('button', { name: 'Publish' });

      expect(button).toHaveAccessibleName('Publish');
      expect(button).toBeEnabled();

      fireEvent.click(button);

      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  /*
   * `asChild` - the group with the most riding on it.
   *
   * A link-shaped action must be a real `<a href>`, not a button that navigates
   * in script: the pagination control is required to emit crawlable anchors, and
   * the header navigation and every "Read post" affordance are the same shape. If
   * `asChild` regresses to rendering a `<button>`, an SEO requirement regresses
   * with it silently - the page still looks right and the links stop being links.
   * Hence the negative assertion in the first case: it is not enough that a link
   * appears, no button may remain.
   */
  describe('asChild', () => {
    it('renders its single child element instead of a button', () => {
      render(
        <Button asChild>
          <a href={POST_HREF}>Read post</a>
        </Button>,
      );

      const link = screen.getByRole('link', { name: 'Read post' });

      expect(link).toHaveAccessibleName('Read post');
      expect(link).toHaveAttribute('href', POST_HREF);

      // The role swap has to be total. Slot merges onto the child rather than
      // wrapping it, so a surviving button role would mean either an extra node
      // or the wrong element entirely.
      expect(screen.queryByRole('button')).toBeNull();
    });

    it('leaves the button-only `type` attribute off the rendered child', () => {
      render(
        <Button asChild>
          <a href={POST_HREF}>Read post</a>
        </Button>,
      );

      // button.tsx defaults `type` to "button" on a real <button> and deliberately
      // leaves it undefined under `asChild`, where the child is usually an anchor
      // and `type` would be a meaningless attribute on it.
      expect(screen.getByRole('link', { name: 'Read post' })).not.toHaveAttribute('type');
    });

    it('composes its click handler onto the child', () => {
      // `preventDefault` is not decoration: without it jsdom follows the href and
      // prints "Not implemented: navigation to another Document" to stderr, and
      // this project forbids silencing the console, so the noise would be
      // permanent. Suppressing the default action leaves the assertion - that the
      // click reached the composed handler - untouched.
      //
      // The event is typed against `HTMLButtonElement` because that is what the
      // component's `onClick` prop declares, even though Slot lands the handler on
      // the anchor. That mismatch is the component's contract, not this test's.
      const onClick = vi.fn((event: ReactMouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
      });
      render(
        <Button asChild onClick={onClick}>
          <a href={POST_HREF}>Read post</a>
        </Button>,
      );

      fireEvent.click(screen.getByRole('link', { name: 'Read post' }));

      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('leaves an enabled link focusable and in the tab order', () => {
      render(
        <Button asChild>
          <a href={POST_HREF}>Read post</a>
        </Button>,
      );

      const link = screen.getByRole('link', { name: 'Read post' });

      // No tabIndex is imposed on an enabled control: the platform default is
      // correct, and overriding it would be a change nobody asked for.
      expect(link).not.toHaveAttribute('tabindex');

      link.focus();

      expect(link).toHaveFocus();
    });

    it('takes an aria-disabled link out of the sequential tab order', () => {
      render(
        <Button asChild aria-disabled>
          <a href={POST_HREF}>Read post</a>
        </Button>,
      );

      const link = screen.getByRole('link', { name: 'Read post' });

      // An anchor cannot take `disabled`, so the disabled contract for a
      // link-shaped action is `aria-disabled` for the announcement plus
      // `tabIndex={-1}` so keyboard traversal never lands on it. Both are
      // attributes, which is exactly the level this suite asserts at.
      expect(link).toHaveAttribute('aria-disabled', 'true');
      expect(link).toHaveAttribute('tabindex', '-1');
    });

    it('recognises the string spelling of aria-disabled', () => {
      // A caller may write the boolean or the string; markup only carries the
      // string, so both have to reach the same conclusion.
      render(
        <Button asChild aria-disabled="true">
          <a href={POST_HREF}>Read post</a>
        </Button>,
      );

      const link = screen.getByRole('link', { name: 'Read post' });

      expect(link).toHaveAttribute('aria-disabled', 'true');
      expect(link).toHaveAttribute('tabindex', '-1');
    });

    it('lets an explicit tabIndex win over the aria-disabled default', () => {
      render(
        <Button asChild aria-disabled tabIndex={0}>
          <a href={POST_HREF}>Read post</a>
        </Button>,
      );

      const link = screen.getByRole('link', { name: 'Read post' });

      expect(link).toHaveAttribute('tabindex', '0');
      expect(link).toHaveAttribute('aria-disabled', 'true');
    });
  });

  describe('native button attributes', () => {
    it('defaults its type to "button" so it cannot submit a form by accident', () => {
      render(<Button>Publish</Button>);

      // The documented default, and a defect class closed rather than a
      // preference: HTML makes a typeless <button> a submit control, so a button
      // rendered inside the auth, editor, comment or category forms would submit
      // them on click.
      expect(screen.getByRole('button', { name: 'Publish' })).toHaveAttribute('type', 'button');
    });

    it('lets an explicit type win over that default', () => {
      render(<Button type="submit">Publish</Button>);

      expect(screen.getByRole('button', { name: 'Publish' })).toHaveAttribute('type', 'submit');
    });

    it('forwards arbitrary native attributes and the ref', () => {
      const ref = vi.fn();
      render(
        <Button ref={ref} form="post-editor" name="action" value="publish">
          Publish
        </Button>,
      );

      const button = screen.getByRole('button', { name: 'Publish' });

      // button.tsx accepts the full `ComponentProps<'button'>` on purpose, so
      // that no caller ever needs a widened allow-list to pass a native
      // attribute. These three are the ones a form-bound action actually uses.
      expect(button).toHaveAttribute('form', 'post-editor');
      expect(button).toHaveAttribute('name', 'action');
      expect(button).toHaveAttribute('value', 'publish');

      // `ref` arrives as an ordinary prop - button.tsx deliberately has no
      // `forwardRef`, because React 19 removed the need for that wrapper. A
      // callback ref proves it reaches the DOM node the role query found.
      expect(ref).toHaveBeenCalledWith(button);
    });
  });

  describe('buttonVariants', () => {
    it('is a callable class table returning a non-empty string', () => {
      expect(typeof buttonVariants).toBe('function');

      const classes = buttonVariants();

      // The SHAPE of the return value is the contract - a non-empty class string
      // an unwrappable anchor can be given. Its CONTENT belongs to the token
      // layer, so nothing here inspects it. That is what keeps this test alive
      // through a palette change.
      expect(classes).toBeTypeOf('string');
      expect(classes.length).toBeGreaterThan(0);
    });

    it('accepts every documented variant and size combination without throwing', () => {
      for (const variant of VARIANTS) {
        for (const size of SIZES) {
          expect(() => buttonVariants({ variant, size })).not.toThrow();
          expect(buttonVariants({ variant, size })).toBeTypeOf('string');
        }
      }
    });

    it('accepts each axis on its own, as callers that set only one do', () => {
      for (const variant of VARIANTS) {
        expect(buttonVariants({ variant })).toBeTypeOf('string');
      }

      for (const size of SIZES) {
        expect(buttonVariants({ size })).toBeTypeOf('string');
      }
    });
  });
});
