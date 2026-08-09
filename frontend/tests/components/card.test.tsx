/* =============================================================================
 * card.test.tsx - the component suite for the `Card` primitive
 * (src/components/ui/card.tsx).
 *
 * WHAT THIS FILE IS FOR, AND WHY IT IS NOT A FORMALITY
 *
 * `Card` reads as a purely presentational wrapper - a surface, a hairline, a
 * corner radius and a shadow - which is exactly why its two SEMANTIC features
 * are the ones that regress without anybody noticing:
 *
 *   1. The polymorphic root. `as="article"` is what makes a feed item a
 *      self-contained, independently distributable thing in the accessibility
 *      tree; the default `div` is what keeps a stat tile or an auth panel from
 *      claiming to be one. A refactor that hard-wires either spelling breaks
 *      the other consumer silently, because nothing about the rendered pixels
 *      changes.
 *   2. The configurable heading level. `CardTitle` takes its level from the
 *      PAGE, because only the page knows its own outline. A card that emitted a
 *      fixed level would produce a second `h1` on the post detail route (which
 *      spends its single `h1` on the article title) or a skipped level in the
 *      feed. Both are invalid document structure, both are invisible on screen,
 *      and both damage the crawler-facing outline the project's SEO
 *      requirement rests on.
 *
 * Those two behaviours are the reason this file exists. Everything else here
 * exists so that the five parts cannot quietly stop composing.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DELIBERATELY DOES NOT ASSERT
 *
 * Not one class name, and not one computed style. There is no `toHaveClass`, no
 * `className` read, no class-based `querySelector`, no `getComputedStyle` and no
 * snapshot anywhere below, and none may be added.
 *
 * That is a design rule rather than an omission. The card's entire appearance is
 * the semantic token layer - `--color-surface`, `--color-border`,
 * `--color-foreground`, `--color-muted-foreground` and the `--radius-*` and
 * `--shadow-*` scales, all declared in src/app/globals.css and all dual-valued
 * for light and dark. Those tokens are free to change: a palette edit, a radius
 * change or a utility rename is a legitimate, non-breaking change to this
 * project. A test that asserted `rounded-xl` would fail on such an edit while
 * the component remained perfectly correct, which trains people to delete tests
 * instead of trusting them.
 *
 * Assertions therefore target only what a user or a crawler can actually
 * perceive: ARIA roles, heading levels, accessible names, visible text and
 * forwarded attributes. vitest.config.ts reinforces this from its own side - it
 * configures no snapshot serialiser and no class-name matcher, and it notes that
 * Tailwind utilities are not resolved to real declarations under `css: true`, so
 * a computed-style assertion here would be measuring nothing.
 *
 * Two further exclusions, both intentional:
 *
 *   - No responsive assertion. jsdom applies no media query, so a breakpoint
 *     check here would pass regardless of the truth. The one/two/three-column
 *     feed and the sub-`md` stacked-card presentation are verified at 375, 768
 *     and 1440 pixels by the Playwright journeys under tests/e2e/.
 *   - No HTTP. `Card` imports only `cn`; it fetches nothing and knows no domain
 *     type. This file therefore installs no request interception and needs
 *     none - it names no server, imports nothing from tests/msw/, and issues no
 *     request that an unhandled-request policy could trip over.
 *
 * ---------------------------------------------------------------------------
 * CONVENTIONS INHERITED FROM THE RUNNER
 *
 * `describe`, `it` and `expect` are IMPORTED rather than taken from the globals
 * vitest.config.ts enables. Both spellings run, but frontend/tsconfig.json
 * includes every *.tsx in the type-check program, so a file that leaned on the
 * globals would fail `tsc --noEmit` with "Cannot find name 'describe'" while
 * passing at runtime. Both gates block, so the import is the only spelling that
 * satisfies both.
 *
 * The jest-dom matchers (`toBeInTheDocument`, `toHaveAccessibleName`,
 * `toHaveAttribute`) are registered once by frontend/vitest.setup.ts through the
 * `/vitest` subpath, and `cleanup()` is registered there in its own `afterEach`.
 * Neither is repeated here: re-importing the matchers would register them twice
 * and calling `cleanup()` again would be dead code.
 *
 * `@testing-library/user-event` is not in the pinned dependency set and is not
 * used. Nothing in this unit is interactive - `Card` is documented as a
 * container that must never be made clickable, because a card holds a title
 * link, a like button and a share control, and nesting those inside an outer
 * anchor or button is invalid HTML - so there is no interaction to drive.
 * ========================================================================== */

import type { ComponentProps } from 'react';

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * Blog-domain content throughout: a post title, an excerpt, an author, a
 * category, a titled region, an administrative figure.
 *
 * The generic demonstration resource this repository once served - the one with
 * a client-supplied integer key and a currency field, which the backend contract
 * suite now asserts is absent from the generated API document - is retired, and
 * it stays retired here too. Test fixtures are the last place a dead vocabulary
 * survives, so none of it is spoken below.
 *
 * Every string is passed as a JSX expression rather than typed inline as JSX
 * text, so an apostrophe in a title could never trip `react/no-unescaped-
 * entities`, which the lint gate treats as an error.
 */

/** A post title - the string a feed card puts in its heading. */
const POST_TITLE = 'Scaling a FastAPI service behind the App Router';

/** A post excerpt - the string a feed card puts in its content slot. */
const POST_EXCERPT = 'Why weighted full-text search belongs in PostgreSQL rather than a sidecar.';

/** An author name - the kind of thing that sits beside a title in the header. */
const AUTHOR_NAME = 'Ada Whitfield';

/** A category name - the kind of thing that sits in the footer as a badge. */
const CATEGORY_NAME = 'Engineering';

/** A titled region's heading, for the `section` root. */
const SECTION_TITLE = 'Editor picks';

/** An administrative stat tile's label and figure, for the default `div` root. */
const STAT_LABEL = 'Published posts';
const STAT_VALUE = '128';

/**
 * The `id` an `aria-labelledby` reference points at.
 *
 * Declared once and used on both ends of every naming test, so the reference and
 * its target cannot drift apart and leave a test that silently proves nothing:
 * an `aria-labelledby` aimed at a missing id yields no accessible name at all,
 * which is precisely the failure these tests are here to catch.
 */
const TITLE_ID = 'card-heading';

/* -------------------------------------------------------------------------- */
/* Heading-level cases                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The heading tags `CardTitle` accepts, DERIVED from the component rather than
 * restated here.
 *
 * This mirrors the convention the real consumers already follow -
 * blog/post-card.tsx and admin/stat-card.tsx both reach for
 * `ComponentProps<typeof CardTitle>['as']` instead of writing the union out
 * again - and it is what stops this file from drifting: if `CardTitle` ever
 * narrows or widens its accepted levels, the type below changes with it and the
 * exhaustive record underneath stops compiling until it is brought back into
 * step.
 */
type CardTitleTag = NonNullable<ComponentProps<typeof CardTitle>['as']>;

/** One heading tag paired with the ARIA level it must resolve to. */
interface HeadingCase {
  /** The value handed to `CardTitle`'s `as` prop. */
  readonly as: CardTitleTag;
  /** The `aria-level` that tag must expose, queried through `getByRole`. */
  readonly level: 1 | 2 | 3 | 4;
}

/**
 * Every accepted tag, keyed by itself.
 *
 * A `Record` over the closed union rather than a bare array, and that is the
 * whole point: a `Record` is exhaustive, so adding a level to `CardTitle`
 * without adding it here is a COMPILE error rather than a silently uncovered
 * case. That makes this declaration a drift alarm on the component's public
 * contract, not just a list of inputs.
 *
 * `Object.values` on a `Record<K, V>` is typed `V[]`, so the flat list below
 * needs no cast and no assertion to stay type-safe.
 */
const HEADING_CASE_BY_TAG: Readonly<Record<CardTitleTag, HeadingCase>> = {
  h1: { as: 'h1', level: 1 },
  h2: { as: 'h2', level: 2 },
  h3: { as: 'h3', level: 3 },
  h4: { as: 'h4', level: 4 },
};

/** The same cases as a list, for the exhaustive test to walk. */
const HEADING_CASES: readonly HeadingCase[] = Object.values(HEADING_CASE_BY_TAG);

/** The accessible name given to the heading rendered for a given level. */
function headingNameForLevel(level: HeadingCase['level']): string {
  return `${POST_TITLE} at level ${level}`;
}

/* -------------------------------------------------------------------------- */
/* Suite                                                                      */
/* -------------------------------------------------------------------------- */

describe('Card', () => {
  describe('composition', () => {
    /*
     * The five parts are a compositional API, not a prop-driven one: consumers
     * put arbitrary children in each slot - a cover image, a byline, a category
     * badge row, a like button - so what has to hold is that all four slots
     * render, and render INSIDE the root rather than beside it. Locating the
     * root and asserting through `within` is what distinguishes the two, and it
     * is the guarantee `within(article)` queries elsewhere in the application
     * quietly depend on.
     */
    it('renders the header, title, content and footer slots inside one root', () => {
      render(
        <Card data-testid="card-root">
          <CardHeader>
            <CardTitle>{POST_TITLE}</CardTitle>
            <p>{AUTHOR_NAME}</p>
          </CardHeader>
          <CardContent>{POST_EXCERPT}</CardContent>
          <CardFooter>{CATEGORY_NAME}</CardFooter>
        </Card>,
      );

      const root = within(screen.getByTestId('card-root'));

      // The title arrives as a real heading, not as styled text.
      expect(root.getByRole('heading')).toHaveAccessibleName(POST_TITLE);

      // Header sibling, content and footer, each distinct and each nested.
      expect(root.getByText(AUTHOR_NAME)).toBeInTheDocument();
      expect(root.getByText(POST_EXCERPT)).toBeInTheDocument();
      expect(root.getByText(CATEGORY_NAME)).toBeInTheDocument();
    });
  });

  describe('polymorphic root', () => {
    /*
     * The default is a `div`, which carries no role of its own. That is the
     * correct element for a panel with no independent meaning - an admin stat
     * tile, the centred auth shell - and asserting the ABSENCE of the article
     * role is the only way to pin it: a `div` and an `article` look identical on
     * screen, so nothing else would notice the difference.
     */
    it('renders a div by default, exposing no article role', () => {
      render(
        <Card>
          <CardHeader>
            <CardTitle>{STAT_LABEL}</CardTitle>
          </CardHeader>
          <CardContent>{STAT_VALUE}</CardContent>
        </Card>,
      );

      expect(screen.queryByRole('article')).toBeNull();

      // The children still render - the absence above is the root's role, not a
      // failure to render anything at all.
      expect(screen.getByRole('heading')).toHaveAccessibleName(STAT_LABEL);
      expect(screen.getByText(STAT_VALUE)).toBeInTheDocument();
    });

    /*
     * `as` is optional only on the `div` branch of the props union, which is
     * what makes a bare `<Card />` resolve to that branch at all. Stating the
     * discriminant explicitly must therefore be accepted and must behave
     * identically to omitting it - this test is the pair to the one above, and
     * together they cover the union's `div` member in both of its spellings.
     */
    it('treats an explicit div the same as the omitted default', () => {
      render(
        <Card as="div">
          <CardHeader>
            <CardTitle>{STAT_LABEL}</CardTitle>
          </CardHeader>
          <CardContent>{STAT_VALUE}</CardContent>
        </Card>,
      );

      expect(screen.queryByRole('article')).toBeNull();
      expect(screen.getByRole('heading')).toHaveAccessibleName(STAT_LABEL);
      expect(screen.getByText(STAT_VALUE)).toBeInTheDocument();
    });

    /*
     * `as="article"` is the exact behaviour blog/post-card.tsx depends on: a
     * feed item is syndicable on its own, so it is an article, and assistive
     * technology can then enumerate and skip between the items in the feed.
     */
    it('renders an article when marked as a self-contained item', () => {
      render(
        <Card as="article">
          <CardHeader>
            <CardTitle as="h2">{POST_TITLE}</CardTitle>
          </CardHeader>
          <CardContent>{POST_EXCERPT}</CardContent>
        </Card>,
      );

      const item = screen.getByRole('article');

      expect(item).toBeInTheDocument();
      expect(within(item).getByRole('heading', { level: 2 })).toHaveAccessibleName(POST_TITLE);
      expect(within(item).getByText(POST_EXCERPT)).toBeInTheDocument();
    });

    /*
     * An article's own accessible name comes from whatever names it, and the
     * natural thing to name it with is the title it already contains. Both ends
     * of that reference cross a component boundary - `aria-labelledby` is
     * forwarded by `Card`, `id` by `CardTitle` - so this is the test that proves
     * the two halves meet. A reference to a missing id produces no name at all,
     * which is why the assertion is on the resolved NAME rather than on the
     * attribute.
     */
    it('takes its accessible name from the title an article is pointed at', () => {
      render(
        <Card as="article" aria-labelledby={TITLE_ID}>
          <CardHeader>
            <CardTitle as="h2" id={TITLE_ID}>
              {POST_TITLE}
            </CardTitle>
          </CardHeader>
          <CardContent>{POST_EXCERPT}</CardContent>
        </Card>,
      );

      expect(screen.getByRole('article')).toHaveAccessibleName(POST_TITLE);
    });

    /*
     * `as="section"` is for a titled region of a larger document, and the
     * component's own guidance is to pair it with a `CardTitle` so the region
     * has an accessible name. The next two tests are that guidance, executed:
     * named, a section IS a landmark region; unnamed, it is not exposed as one
     * at all. Both halves matter, because only the pair explains why the
     * pairing is required rather than merely recommended.
     */
    it('exposes a section as a named region when pointed at its title', () => {
      render(
        <Card as="section" aria-labelledby={TITLE_ID}>
          <CardHeader>
            <CardTitle as="h2" id={TITLE_ID}>
              {SECTION_TITLE}
            </CardTitle>
          </CardHeader>
          <CardContent>{POST_EXCERPT}</CardContent>
        </Card>,
      );

      expect(screen.getByRole('region')).toHaveAccessibleName(SECTION_TITLE);
    });

    it('exposes no region for a section that nothing names', () => {
      render(
        <Card as="section">
          <CardHeader>
            <CardTitle as="h2">{SECTION_TITLE}</CardTitle>
          </CardHeader>
          <CardContent>{POST_EXCERPT}</CardContent>
        </Card>,
      );

      expect(screen.queryByRole('region')).toBeNull();

      // Still rendered, still a heading - only the landmark is missing.
      expect(screen.getByRole('heading', { level: 2 })).toHaveAccessibleName(SECTION_TITLE);
    });

    /*
     * `as="li"` exists for a genuine list, and the consumer owns the `ul` or
     * `ol` parent - which is why the parent is supplied here. The `listitem`
     * role is contingent on that parent, so a test that rendered the card alone
     * would prove nothing about the case the prop was added for.
     */
    it('renders a list item inside a list', () => {
      render(
        <ul>
          <Card as="li">
            <CardHeader>
              <CardTitle as="h2">{POST_TITLE}</CardTitle>
            </CardHeader>
            <CardContent>{POST_EXCERPT}</CardContent>
          </Card>
        </ul>,
      );

      const item = within(screen.getByRole('list')).getByRole('listitem');

      expect(item).toBeInTheDocument();
      expect(within(item).getByRole('heading', { level: 2 })).toHaveAccessibleName(POST_TITLE);
    });
  });

  describe('CardTitle heading level', () => {
    /*
     * `CardTitle` is rendered on its own in this block, deliberately. It reads
     * nothing from a surrounding `Card` - no context, no cloned props - so
     * isolating it keeps each assertion about the level alone, and proves the
     * independence at the same time.
     *
     * Each override also asserts that the DEFAULT level is absent. Without that
     * half, a component that ignored the prop entirely and always rendered its
     * default would still pass one of these tests, which is the exact regression
     * the block exists to catch.
     */
    it('renders a level 2 heading when asked for h2', () => {
      render(<CardTitle as="h2">{POST_TITLE}</CardTitle>);

      expect(screen.getByRole('heading', { level: 2 })).toHaveAccessibleName(POST_TITLE);
      expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
    });

    it('renders a level 3 heading when asked for h3', () => {
      render(<CardTitle as="h3">{POST_TITLE}</CardTitle>);

      expect(screen.getByRole('heading', { level: 3 })).toHaveAccessibleName(POST_TITLE);
      expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    });

    /*
     * The default is `h3`, read from the component rather than chosen here. It
     * is a safe default precisely because it is not `h1`: a page keeps its
     * single `h1` for its own heading, so a card that fell back to `h1` would
     * duplicate it, and one that fell back to `h2` would collide with a section
     * heading. Pinning the actual default is what makes an accidental change to
     * it visible.
     */
    it('defaults to a level 3 heading', () => {
      render(<CardTitle>{POST_TITLE}</CardTitle>);

      expect(screen.getByRole('heading', { level: 3 })).toHaveAccessibleName(POST_TITLE);
      expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
      expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    });

    /*
     * Every level the component's own union allows, walked exhaustively. The
     * record this list comes from is keyed by that union, so a level added to
     * `CardTitle` cannot reach production without a case here - the file stops
     * compiling first.
     *
     * All four render into one tree with distinct names, so each `getByRole`
     * below is unambiguous and a tag that rendered at the wrong level would
     * collide with its neighbour instead of quietly passing.
     *
     * The length assertion is not decoration. A `for` loop over an empty list
     * passes without asserting anything, so without it a bug that emptied the
     * case list would turn this test green rather than red - the worst possible
     * outcome for the one test that exists to be exhaustive.
     */
    it('renders every level its declared union allows', () => {
      render(
        <>
          {HEADING_CASES.map(({ as, level }) => (
            <CardTitle key={as} as={as}>
              {headingNameForLevel(level)}
            </CardTitle>
          ))}
        </>,
      );

      expect(HEADING_CASES).toHaveLength(4);

      for (const { level } of HEADING_CASES) {
        expect(screen.getByRole('heading', { level })).toHaveAccessibleName(
          headingNameForLevel(level),
        );
      }
    });
  });

  describe('attribute forwarding', () => {
    /*
     * Every part spreads the remaining props onto the element it renders, and
     * consumers rely on that for the things a container cannot own itself: the
     * `id` an `aria-labelledby` elsewhere points at, an `aria-busy` while a stat
     * tile loads, an `aria-hidden` on a skeleton. One render covers all five
     * parts, and covers both attribute families at once - `getByTestId`
     * succeeding proves the `data-*` attribute arrived, and the `id` assertion
     * proves a standard attribute did too.
     *
     * The three role-less slots are located by test id because that is what they
     * are: plain containers with no semantics of their own to query. The root
     * and the title are located by role instead, since they have one.
     */
    it('forwards id and data attributes to the element each part renders', () => {
      render(
        <Card as="article" id="post-card">
          <CardHeader data-testid="card-header" id="post-card-header">
            <CardTitle as="h2" id="post-card-title">
              {POST_TITLE}
            </CardTitle>
          </CardHeader>
          <CardContent data-testid="card-content" id="post-card-content">
            {POST_EXCERPT}
          </CardContent>
          <CardFooter data-testid="card-footer" id="post-card-footer">
            {CATEGORY_NAME}
          </CardFooter>
        </Card>,
      );

      expect(screen.getByRole('article')).toHaveAttribute('id', 'post-card');
      expect(screen.getByTestId('card-header')).toHaveAttribute('id', 'post-card-header');
      expect(screen.getByRole('heading', { level: 2 })).toHaveAttribute('id', 'post-card-title');
      expect(screen.getByTestId('card-content')).toHaveAttribute('id', 'post-card-content');
      expect(screen.getByTestId('card-footer')).toHaveAttribute('id', 'post-card-footer');
    });
  });
});
