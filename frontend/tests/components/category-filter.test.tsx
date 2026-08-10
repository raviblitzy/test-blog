// Component tests for src/components/blog/category-filter.tsx - the home feed's category picker.
//
// The unit under test is `CategoryFilter`, the SOLE writer of the feed's `category` search
// parameter. Everything this spec asserts is therefore about two things that no visual check and no
// type checker can catch on their own: the exact value that reaches the URL, and the accessible
// names and states the control publishes while it does it.
//
// ---------------------------------------------------------------------------
// 1. THE TAXONOMY IS A BARE ARRAY. THERE IS NO ENVELOPE AND NO `.items`.
//
// `listCategories` in @/lib/api/categories answers `CategoryPublic[]` - the ONE collection in this
// thirty-endpoint API that is NOT wrapped in `Page<T>`, and a specified exception rather than an
// oversight: the array *is* this control, so a window could hide the posts filed under whatever
// fell outside it.
//
// So `categories` below is a plain array, typed `readonly CategoryPublic[]`, and this file
// constructs no `Page<CategoryPublic>`, reads no `.items`, no `total` and no `pages`. Typing the
// fixture is the point rather than decoration - a well-meaning envelope unwrap is the single most
// likely defect around this component, and an accurate type is what turns it into a compile error
// here instead of an empty filter in production.
//
// `CategoryPublic` rather than `CategorySummary` is equally deliberate. The slim projection
// embedded in a post carries `id`, `name` and `slug` only; the full one adds `description`,
// `post_count` and `created_at`, and the tally is what this control displays. All six fields are
// therefore populated, in snake_case, exactly as the wire delivers them.
//
// ---------------------------------------------------------------------------
// 2. NO HTTP IS PERFORMED, SO NOTHING IS MOCKED AT THE NETWORK
//
// The component receives the already-fetched array as a PROP: src/app/page.tsx is a Server
// Component that fetches the taxonomy for its own render, so the options are in the initial HTML
// rather than arriving a frame after hydration. That is an SEO decision in the component and it is
// what makes this spec simple - there is no request to intercept, so there is no `setupServer`
// here, no handler list, and no assertion about a request.
//
// tests/msw/handlers.ts exists for the specs that DO exercise @/lib/api, and it carries category
// fixtures of its own. They are deliberately not reused here: their post counts mirror the seeded
// post set, so none of them is large enough to exercise the compact number formatter this control
// renders its tallies through. The fixture below is declared locally for that reason and typed
// against the real contract, which is what keeps it honest.
//
// The one thing that DOES have to be supplied is App Router context: `CategoryFilter` is a
// 'use client' island calling `useSearchParams`, `usePathname` and `useRouter`, none of which
// resolve outside a Next.js render. `vi.mock('next/navigation', ...)` below provides all three -
// a real `URLSearchParams` for the incoming query string, and spies for the navigation the control
// performs. Asserting on those spies IS asserting the feature: query state lives in the URL so
// that any filtered result set is linkable, shareable, crawlable and correct under Back and
// Forward.
//
// ---------------------------------------------------------------------------
// 3. NOT ONE CLASS NAME IS ASSERTED
//
// No `toHaveClass`, no `className` read, no class-based `querySelector`, no `getComputedStyle` and
// no snapshot appears below, and none may be added. The token layer owns every class in the
// component and is free to change any of them; a spec that pinned one would fail on a palette edit
// while proving nothing about behaviour. Every assertion here is on an accessible role, an
// accessible name, an accessible description, an ARIA state, visible text, or a pushed URL.
//
// For the same reason `data-state` and `data-highlighted` are not asserted either. Radix sets both,
// but they are styling hooks, and the facts they carry are already published as `aria-expanded` on
// the trigger and `aria-selected` on the option - which is what a screen-reader user actually
// receives, and therefore what is worth defending.
//
// ---------------------------------------------------------------------------
// 4. THE PICKER IS DRIVEN WITH `fireEvent`, DELIBERATELY
//
// `@testing-library/user-event` is NOT a declared dependency of this project, so it is not used
// here. Radix's own key handling is what makes that a non-issue: its trigger opens on
// ' ', 'Enter', 'ArrowUp' and 'ArrowDown', so `fireEvent.keyDown(trigger, { key: 'ArrowDown' })`
// is a faithful open, and an item selects on click or on 'Enter' while focused.
//
// Two properties of the primitive shape every interaction below, and both were confirmed against
// the installed @radix-ui/react-select@2.3.7 rather than assumed:
//
//   * The panel is PORTALLED and is mounted only while open, so it is reached through `screen`
//     rather than the render container, and `await screen.findByRole('listbox')` is used instead of
//     a synchronous query. vitest.setup.ts's matchMedia, ResizeObserver, scrollIntoView, pointer
//     capture and DOMRect stubs are what let the floating content mount and measure in jsdom.
//   * Arrow-key focus movement inside the panel happens in a `setTimeout`, so it is AWAITED with
//     `waitFor(... toHaveFocus())`. That is the fix for the flake, not a tolerance of it.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CategoryFilter } from '@/components/blog/category-filter';
import { formatCount } from '@/lib/format';
import type { CategoryPublic } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Copy and contract constants
 *
 * Mirrored here rather than imported because the component exports its copy as module-private
 * constants. Naming them once keeps a rename to a single edit per string and makes each assertion
 * below read as a sentence about the product rather than as a bare literal.
 * ---------------------------------------------------------------------------------------------- */

/** The control's accessible name when the caller supplies no `label`. */
const DEFAULT_LABEL = 'Filter by category';

/** Visible text of the reset option, and what the trigger reads while nothing is filtered. */
const ALL_CATEGORIES_LABEL = 'All categories';

/** A caller-supplied name, used to prove `label` reaches the accessible name. */
const CUSTOM_LABEL = 'Topic';

/** The route the feed lives on; every pushed URL must stay on it. */
const FEED_PATHNAME = '/';

/**
 * Base used to parse a pushed href.
 *
 * `router.push` receives a ROOT-RELATIVE href, which `new URL` cannot parse alone. Supplying a base
 * makes `searchParams` available, which is the only way this spec inspects a pushed URL - never by
 * comparing the href to a string, because parameter order is an implementation detail of
 * `URLSearchParams` and asserting on it would make the spec brittle for no gain.
 */
const TEST_ORIGIN = 'http://localhost';

/** The search parameter this control owns. */
const CATEGORY_PARAM = 'category';

/** The search parameter this control clears but never sets. Owned by the pagination control. */
const PAGE_PARAM = 'page';

/** A sibling control's parameter, used to prove it survives a filter change. */
const QUERY_PARAM = 'q';

/** A second sibling parameter, for the same reason. */
const SORT_PARAM = 'sort';

/* -------------------------------------------------------------------------------------------------
 * App Router harness
 *
 * Hoisted so the state and the spies exist before `vi.mock`'s factory runs, and so the factory
 * closes over the SAME objects each test mutates.
 * ---------------------------------------------------------------------------------------------- */

/** The options object `CategoryFilter` passes alongside every href. */
interface NavigateOptions {
  readonly scroll?: boolean;
}

/** Shape of the two navigation methods this control could plausibly call. */
type Navigate = (href: string, options?: NavigateOptions) => void;

const nav = vi.hoisted(() => ({
  /**
   * The incoming query string, replaced per test.
   *
   * A real `URLSearchParams` rather than a stub, so `get`, `has` and `toString` behave exactly as
   * they do in the browser - which matters, because the component both reads a parameter and copies
   * the whole set to build its next URL.
   */
  searchParams: new URLSearchParams(),

  /**
   * One STABLE router object, created once rather than rebuilt per render.
   *
   * Next.js returns a stable instance, and the component lists the router in a `useCallback`
   * dependency array; a fresh object per render would invalidate that callback on every render and
   * make the harness less faithful than the thing it stands in for.
   */
  router: {
    push: vi.fn<Navigate>(),
    replace: vi.fn<Navigate>(),
    prefetch: vi.fn<(href: string) => void>(),
    back: vi.fn<() => void>(),
    forward: vi.fn<() => void>(),
    refresh: vi.fn<() => void>(),
  },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: (): URLSearchParams => nav.searchParams,
  usePathname: (): string => FEED_PATHNAME,
  useRouter: (): typeof nav.router => nav.router,
}));

/* -------------------------------------------------------------------------------------------------
 * Taxonomy fixture
 *
 * Three categories, each a complete `CategoryPublic` with all six snake_case fields, no cast and no
 * `any`. Every identifier is a UUID-shaped STRING, because identity in this system is generated by
 * the database rather than supplied by a client - an integer id here would misrepresent the wire.
 *
 * The `post_count` values are chosen to exercise all three branches of the shared formatter and the
 * component's own pluralisation: a four-figure tally that must come back abbreviated, a tally of
 * exactly one that must read in the singular, and a legitimately empty category, which the
 * component deliberately shows rather than hides. `description` is prose on two and `null` on the
 * third, because both arrive from the API.
 * ---------------------------------------------------------------------------------------------- */

/** The busiest category: a four-figure tally, so the compact formatter is genuinely exercised. */
const engineering: CategoryPublic = {
  id: '3f7c1b52-2f4a-4b0e-8b6d-0d3a6f1c9a11',
  name: 'Engineering',
  slug: 'engineering',
  description: 'Services, storage, and the seams between them.',
  post_count: 1284,
  created_at: '2024-01-05T09:00:00Z',
};

/** A single-post category, so the announced tally has to be singularised. */
const design: CategoryPublic = {
  id: '8a1e4d6c-7b93-4f21-9c0a-2e5d8b7f4c33',
  name: 'Design',
  slug: 'design',
  description: 'Tokens, type, and the accessibility floor.',
  post_count: 1,
  created_at: '2024-02-11T10:30:00Z',
};

/** An empty category with no description: both are real states the API produces. */
const product: CategoryPublic = {
  id: 'c5d90e18-6a24-4e77-bf13-9a0c7e2d5b48',
  name: 'Product',
  slug: 'product',
  description: null,
  post_count: 0,
  created_at: '2024-03-19T15:45:00Z',
};

/**
 * The whole taxonomy, in the order the server really reports it: BY NAME, ASCENDING.
 *
 * `category_repository.py` orders `GET /api/v1/categories` by `Category.name.asc()`, so Design comes
 * before Engineering before Product - and the order is alphabetical rather than by tally, by creation
 * instant or by identifier. This array was previously `[engineering, design, product]` while the case
 * that consumed it claimed "in server order", which is the combination worth avoiding: the claim read
 * as verified while the fixture described an ordering the API never sends, so a component that decided
 * to sort by `post_count` descending would have looked correct against it.
 *
 * A BARE array - what `listCategories` answers - and `readonly`, so no test can quietly reorder or
 * extend the set another test depends on.
 */
const categories: readonly CategoryPublic[] = [design, engineering, product];

/** The announced tally for a category, assembled exactly as the component assembles it. */
function tallyPhrase(category: CategoryPublic): string {
  return `${formatCount(category.post_count)} ${category.post_count === 1 ? 'post' : 'posts'}`;
}

/* -------------------------------------------------------------------------------------------------
 * Render and interaction helpers
 * ---------------------------------------------------------------------------------------------- */

/** Everything a test may vary about a render. */
interface RenderOptions {
  /** The incoming query string, without its leading `?`. Defaults to none. */
  readonly search?: string;
  /** A caller-supplied accessible name. Omitted to exercise the default. */
  readonly label?: string;
  /** The taxonomy to render. Defaults to the full fixture. */
  readonly categories?: readonly CategoryPublic[];
}

/**
 * Render the control against a given URL.
 *
 * The fixture is spread into a fresh mutable array because the component's prop is
 * `CategoryPublic[]`: a copy satisfies it without a cast and without letting the component reach
 * the shared `readonly` fixture at all.
 */
function renderFilter(options: RenderOptions = {}): void {
  const { search = '', label, categories: taxonomy = categories } = options;

  nav.searchParams = new URLSearchParams(search);

  render(<CategoryFilter categories={[...taxonomy]} label={label} />);
}

/**
 * Mount the picker and hand back a function that navigates the URL beneath it.
 *
 * The distinction from {@link renderFilter} is the whole point of the reconciliation group below: a
 * single render can only ever prove hydration on FIRST paint. Back, Forward and an in-app link all
 * change the query string and re-render the same mounted component, which is a second observation this
 * file could not make while every case rendered once.
 *
 * The returned function replaces the parameter instance - the router hands out a new one rather than
 * mutating - and then re-renders the same element, exactly as the App Router does.
 */
function renderFilterWithNavigation(options: RenderOptions = {}): (search: string) => void {
  const { search = '', label, categories: taxonomy = categories } = options;

  nav.searchParams = new URLSearchParams(search);

  const { rerender } = render(<CategoryFilter categories={[...taxonomy]} label={label} />);

  return (nextSearch: string): void => {
    nav.searchParams = new URLSearchParams(nextSearch);
    rerender(<CategoryFilter categories={[...taxonomy]} label={label} />);
  };
}

/** The trigger, found the only way a reader finds it: by its accessible name. */
function getTrigger(name: string = DEFAULT_LABEL): HTMLElement {
  return screen.getByRole('combobox', { name });
}

/**
 * Open the picker and hand back its listbox.
 *
 * 'ArrowDown' rather than a click, because it is the one gesture Radix's trigger handles
 * identically whatever pointer type the environment reports. The panel is portalled and mounts only
 * once open, so it is awaited through `screen` rather than queried synchronously.
 *
 * ONE CONSEQUENCE WORTH KNOWING, and it is upstream behaviour rather than a quirk of this harness:
 * while the panel is open Radix hides everything outside it from the accessibility tree, which is
 * the correct modal-listbox semantic and is what stops a screen-reader user wandering out of the
 * list. The trigger is among the things hidden, so `getByRole('combobox', ...)` cannot find it
 * during that window - role queries exclude what the accessibility tree excludes. Any test that
 * needs the trigger afterwards therefore captures the element BEFORE opening and asserts on that
 * same node.
 */
async function openPicker(): Promise<HTMLElement> {
  fireEvent.keyDown(getTrigger(), { key: 'ArrowDown' });

  return screen.findByRole('listbox');
}

/**
 * The single URL this control pushed, parsed.
 *
 * Asserts the count and the METHOD on the way through: this control pushes, so that a filter change
 * becomes a history entry the Back button returns through, where the debounced search field
 * replaces. Proving `replace` was untouched is what keeps those two from being confused.
 */
function pushedUrl(): URL {
  expect(nav.router.push).toHaveBeenCalledTimes(1);
  expect(nav.router.replace).not.toHaveBeenCalled();

  const [href = ''] = nav.router.push.mock.calls[0] ?? [];

  return new URL(href, TEST_ORIGIN);
}

/* -------------------------------------------------------------------------------------------------
 * Specification
 * ---------------------------------------------------------------------------------------------- */

describe('CategoryFilter', () => {
  beforeEach(() => {
    // A fresh, EMPTY query string per test. The unfiltered feed is the default state, and any test
    // that needs another URL says so explicitly through `renderFilter`.
    nav.searchParams = new URLSearchParams();

    // Fresh spies, so a call count asserted in one test can never be inherited by the next.
    vi.clearAllMocks();
  });

  describe('accessibility', () => {
    it('takes its accessible name from its label rather than from the selected value', () => {
      renderFilter();

      const trigger = getTrigger();

      expect(trigger).toHaveAccessibleName(DEFAULT_LABEL);
      // The label query resolves to the trigger ITSELF, which is what proves the caption names the
      // control a reader operates rather than merely sitting beside it.
      expect(screen.getByLabelText(DEFAULT_LABEL)).toBe(trigger);
    });

    it('lets a caller rename the control', () => {
      renderFilter({ label: CUSTOM_LABEL });

      // The supplied name reaches BOTH halves of the naming - the visually hidden caption and the
      // trigger - so the default is genuinely replaced rather than merely supplemented.
      expect(getTrigger(CUSTOM_LABEL)).toHaveAccessibleName(CUSTOM_LABEL);
      expect(screen.getByText(CUSTOM_LABEL)).toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: DEFAULT_LABEL })).toBeNull();
    });

    it('renders a real label element wired to the trigger', async () => {
      renderFilter();

      // Captured BEFORE opening, for the reason set out on `openPicker`.
      const trigger = getTrigger();

      // Activating the caption operates the control, which is the behaviour the `<label>`/`id`
      // association buys and the thing an `aria-label` alone could not deliver. Asserted through
      // that behaviour rather than by reading the attributes, so the test survives any change
      // to how the id is generated.
      fireEvent.click(screen.getByText(DEFAULT_LABEL));

      expect(await screen.findByRole('listbox')).toBeInTheDocument();
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
    });

    it('reports itself collapsed, with no options in the document, until it is opened', () => {
      renderFilter();

      expect(getTrigger()).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(screen.queryAllByRole('option')).toHaveLength(0);
    });

    it('reports itself expanded once it is opened', async () => {
      renderFilter();

      // Captured BEFORE opening, for the reason set out on `openPicker`.
      const trigger = getTrigger();

      await openPicker();

      expect(trigger).toHaveAttribute('aria-expanded', 'true');
    });

    it('marks the active option selected, so the state is never carried by colour alone', async () => {
      renderFilter();

      const listbox = await openPicker();
      const reset = within(listbox).getByRole('option', { name: ALL_CATEGORIES_LABEL });

      // Nothing is filtered, so the reset option is the active one. Radix focuses the active option
      // when the panel appears, which is what makes `aria-selected` readable at that moment.
      await waitFor(() => {
        expect(reset).toHaveAttribute('aria-selected', 'true');
      });
    });
  });

  describe('the taxonomy arrives as a bare array', () => {
    it('offers one option per category, in server order, plus the reset option', async () => {
      renderFilter();

      const listbox = await openPicker();
      const options = within(listbox).getAllByRole('option');

      // The reset option first, then every category exactly as the server ordered them. The
      // component neither reorders the taxonomy nor hides a term whose tally is zero: an empty
      // category is a truthful, useful thing to show.
      const expectedNames = [ALL_CATEGORIES_LABEL, ...categories.map((category) => category.name)];

      expect(options).toHaveLength(categories.length + 1);
      options.forEach((option, index) => {
        expect(option).toHaveAccessibleName(expectedNames[index]);
      });

      // THE FIXTURE'S ORDER IS THE SERVER'S, asserted rather than asserted-about. Without this the
      // case above only proves the component preserves whatever order it was handed, which is true of
      // a fixture in any order at all - and the claim being made is the stronger one: the order a
      // reader sees is the alphabetical order the API sends, so a component that sorted by tally, or
      // a fixture that drifted out of the API's order, is a failure rather than a rewording.
      const renderedNames = categories.map((category) => category.name);
      expect(renderedNames).toEqual(
        [...renderedNames].sort((left, right) => left.localeCompare(right)),
      );
      // And not the orders it must NOT be, so the assertion above cannot be satisfied by coincidence.
      expect(renderedNames).not.toEqual(
        [...categories]
          .sort((left, right) => right.post_count - left.post_count)
          .map((c) => c.name),
      );
    });

    it('names each option by its category alone and announces the tally as a description', async () => {
      renderFilter();

      const listbox = await openPicker();

      for (const category of categories) {
        const option = within(listbox).getByRole('option', { name: category.name });

        // The NAME is the category name and nothing else. Folding the tally in would make the
        // option answer to a digit, make typeahead match that digit, and make the trigger read
        // "Engineering 1.3K" once the option was chosen.
        expect(option).toHaveAccessibleName(category.name);
        // Supplementary information belongs in the DESCRIPTION, which is also what stops a sighted
        // reader receiving a fact a screen-reader user does not get.
        expect(option).toHaveAccessibleDescription(tallyPhrase(category));
      }
    });

    it('renders the tally through the shared compact formatter', async () => {
      renderFilter();

      const listbox = await openPicker();
      const busiest = within(listbox).getByRole('option', { name: engineering.name });

      // Compared against the formatter's own output rather than against a literal, so this spec
      // cannot disagree with @/lib/format about what a four-figure tally looks like.
      expect(within(busiest).getByText(formatCount(engineering.post_count))).toBeInTheDocument();
      // And the raw figure is provably absent, which is what proves the value went THROUGH the
      // formatter rather than merely being rendered beside it.
      expect(within(busiest).queryByText(String(engineering.post_count))).toBeNull();
    });

    it('renders nothing at all when the taxonomy is empty', () => {
      // A freshly migrated database before seeding. The component returns nothing rather than a
      // dead control: reference categories are inserted by migration 0003, so an empty taxonomy
      // means something upstream is genuinely wrong, and a disabled picker in the toolbar would
      // present that as a normal state a reader should try to use.
      renderFilter({ categories: [] });

      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.queryByText(DEFAULT_LABEL)).toBeNull();
      expect(screen.queryByText(ALL_CATEGORIES_LABEL)).toBeNull();
    });
  });

  describe('hydrating the selection from the URL', () => {
    it('shows the category the URL names, so a shared filtered link is right on first paint', async () => {
      renderFilter({ search: `${CATEGORY_PARAM}=${design.slug}` });

      const trigger = getTrigger();

      // The trigger displays the human NAME while the URL carries the SLUG: the two halves of one
      // contract, and the reason a crawled or shared `?category=` link needs no reconciliation.
      expect(trigger).toHaveTextContent(design.name);
      // And the accessible name is still the control's PURPOSE. A name that drifted to the current
      // value would rename the control on every choice and be unusable to a screen-reader user.
      expect(trigger).toHaveAccessibleName(DEFAULT_LABEL);

      const listbox = await openPicker();

      await waitFor(() => {
        expect(within(listbox).getByRole('option', { name: design.name })).toHaveAttribute(
          'aria-selected',
          'true',
        );
      });
      expect(within(listbox).getByRole('option', { name: ALL_CATEGORIES_LABEL })).toHaveAttribute(
        'aria-selected',
        'false',
      );
    });

    it('resolves the slug case-insensitively, because the service does', async () => {
      // `categories.slug` is a `citext` column and the feed's `category` filter is documented as
      // matched case-insensitively, so this URL returns the Design posts. A control comparing with
      // `===` did not recognise it and displayed "All categories" over a plainly filtered page - the
      // picker contradicting the result set beneath it.
      renderFilter({ search: `${CATEGORY_PARAM}=${design.slug.toUpperCase()}` });

      const trigger = getTrigger();

      expect(trigger).toHaveTextContent(design.name);
      expect(trigger).not.toHaveTextContent(ALL_CATEGORIES_LABEL);

      const listbox = await openPicker();

      await waitFor(() => {
        expect(within(listbox).getByRole('option', { name: design.name })).toHaveAttribute(
          'aria-selected',
          'true',
        );
      });
    });

    it('names the still-active filter when the URL points at a category that no longer exists', async () => {
      renderFilter({ search: `${CATEGORY_PARAM}=does-not-exist` });

      const trigger = getTrigger();

      // A category deleted from the admin dashboard leaves live links pointing at its slug. Two
      // things must hold on one of those, and only the first used to.
      //
      // The trigger must not go blank - Radix has no item to take a label from, so the label is
      // resolved in the component and passed to `SelectValue` as children.
      //
      // AND it must not claim the feed is unfiltered. The parameter is still in the URL, `listPosts`
      // still forwards it, and the service still filters on it: an unmatched slug answers an EMPTY
      // page rather than an error. "All categories" over an empty feed told the reader the one thing
      // that was false and hid the only thing that explained what they were seeing.
      expect(trigger).toHaveTextContent('Unknown category: does-not-exist');
      expect(trigger).not.toHaveTextContent(ALL_CATEGORIES_LABEL);

      const listbox = await openPicker();

      // No option claims to be selected either, because on that URL none of the LISTED ones is
      // active - which is what keeps the reset affordance a genuine change rather than a no-op.
      for (const option of within(listbox).getAllByRole('option')) {
        expect(option).toHaveAttribute('aria-selected', 'false');
      }
    });

    it('calls a blank category unfiltered, and still lets the reader canonicalise it', async () => {
      // `?category=` is the one present-but-unresolvable value that really IS the unfiltered feed:
      // `post_service._omit_blank` folds a whitespace-only filter to `None` before the query is
      // built. So the label tells the truth about the results, while the VALUE stays unresolved so
      // that choosing "All categories" is a real change and deletes the redundant parameter.
      renderFilter({ search: `${CATEGORY_PARAM}=` });

      expect(getTrigger()).toHaveTextContent(ALL_CATEGORIES_LABEL);

      const listbox = await openPicker();
      fireEvent.click(within(listbox).getByRole('option', { name: ALL_CATEGORIES_LABEL }));

      expect(pushedUrl().searchParams.has(CATEGORY_PARAM)).toBe(false);
    });
  });

  /* -----------------------------------------------------------------------------------------------
   * Reconciling with a URL that changed after the first paint
   *
   * `category-filter.tsx` records the decision this group verifies: there is NO `useState` in that
   * file and no effect synchronising one, because the selection is derived from `useSearchParams()` on
   * every render. That design is what makes Back, Forward and an in-app link correct for free - and it
   * is also exactly the kind of decision a later "optimisation" undoes by mirroring the URL into local
   * state. A mirror passes every hydration case above, because those render once; it fails here.
   * -------------------------------------------------------------------------------------------- */
  describe('reconciling with an external URL change', () => {
    it('follows the URL when Back moves to a different category', () => {
      const navigate = renderFilterWithNavigation({
        search: `${CATEGORY_PARAM}=${design.slug}`,
      });
      expect(getTrigger()).toHaveTextContent(design.name);

      navigate(`${CATEGORY_PARAM}=${engineering.slug}`);

      // The trigger reads the truth about the feed beneath it, which has already changed. A mirrored
      // selection would still be showing Design over a feed filtered to Engineering.
      expect(getTrigger()).toHaveTextContent(engineering.name);
      expect(getTrigger()).not.toHaveTextContent(design.name);
      // And following the URL is not the same as writing it: nothing is pushed by a reconciliation, or
      // the reader's own Back press would be undone a moment after it landed.
      expect(nav.router.push).not.toHaveBeenCalled();
    });

    it('returns to the unfiltered label when Back leaves the filter behind', () => {
      const navigate = renderFilterWithNavigation({
        search: `${CATEGORY_PARAM}=${engineering.slug}&${PAGE_PARAM}=3`,
      });
      expect(getTrigger()).toHaveTextContent(engineering.name);

      navigate('');

      expect(getTrigger()).toHaveTextContent(ALL_CATEGORIES_LABEL);
      expect(nav.router.push).not.toHaveBeenCalled();
    });

    it('adopts a filter that arrives on a URL which had none', () => {
      const navigate = renderFilterWithNavigation();
      expect(getTrigger()).toHaveTextContent(ALL_CATEGORIES_LABEL);

      // An in-app link into the filtered feed - a category chip on a post card, which is a real
      // navigation this control has to answer for without being the one that made it.
      navigate(`${CATEGORY_PARAM}=${product.slug}&${QUERY_PARAM}=indexes`);

      expect(getTrigger()).toHaveTextContent(product.name);
      expect(nav.router.push).not.toHaveBeenCalled();
    });

    it('names the still-active filter when a URL change points at a category that no longer exists', () => {
      const navigate = renderFilterWithNavigation({
        search: `${CATEGORY_PARAM}=${design.slug}`,
      });

      // The administrator deletes a category while the reader is on it, and Forward carries them onto
      // a URL naming the deleted slug. Two things have to hold on that URL, and the second is the one
      // this case used to get backwards.
      //
      // The trigger must stop displaying a term the taxonomy no longer contains - Radix has no item
      // left to take a label from.
      //
      // AND it must not claim the feed is unfiltered. The parameter is still in the URL, the feed
      // still forwards it and the service still filters on it: an unmatched slug answers an EMPTY
      // page rather than an error, so "All categories" over an empty feed asserts the one thing that
      // is false and hides the only thing that explains what the reader is looking at.
      navigate(`${CATEGORY_PARAM}=deleted-in-the-meantime`);

      expect(getTrigger()).toHaveTextContent('Unknown category: deleted-in-the-meantime');
      expect(getTrigger()).not.toHaveTextContent(ALL_CATEGORIES_LABEL);
      expect(getTrigger()).not.toHaveTextContent(design.name);
    });
  });

  describe('selection writes the URL', () => {
    it('writes the chosen category as its SLUG, never as its display name', async () => {
      renderFilter();

      const listbox = await openPicker();
      fireEvent.click(within(listbox).getByRole('option', { name: design.name }));

      const url = pushedUrl();

      // The signature assertion of this file, and the one defect a visual check cannot find. The
      // feed's Server Component reads `category` back and the repository joins on the slug, so
      // pushing the display name would produce a filter that looks live and silently returns an
      // empty result set.
      expect(url.searchParams.get(CATEGORY_PARAM)).toBe(design.slug);
      expect(url.searchParams.get(CATEGORY_PARAM)).not.toBe(design.name);
      expect(url.pathname).toBe(FEED_PATHNAME);

      // `scroll: false`, because the results are already in view and jumping to the top of the
      // document would lose the reader's place.
      const [, options] = nav.router.push.mock.calls[0] ?? [];

      expect(options).toEqual({ scroll: false });
    });

    it("preserves the sibling controls' parameters", async () => {
      renderFilter({ search: `${QUERY_PARAM}=fastapi&${SORT_PARAM}=relevance` });

      const listbox = await openPicker();
      fireEvent.click(within(listbox).getByRole('option', { name: engineering.name }));

      const url = pushedUrl();

      // The next URL is built from a COPY of the incoming parameters, which is what lets a reader
      // search and filter at the same time. Clobbering a sibling's slice is invisible in isolation
      // and only ever surfaces when both controls are in use.
      expect(url.searchParams.get(QUERY_PARAM)).toBe('fastapi');
      expect(url.searchParams.get(SORT_PARAM)).toBe('relevance');
      expect(url.searchParams.get(CATEGORY_PARAM)).toBe(engineering.slug);
    });

    it("drops the reader's page position when the filter changes", async () => {
      renderFilter({ search: `${QUERY_PARAM}=fastapi&${PAGE_PARAM}=4` });

      const listbox = await openPicker();
      fireEvent.click(within(listbox).getByRole('option', { name: product.name }));

      const url = pushedUrl();

      // Page four of one category has no counterpart in a differently sized result set, so the
      // parameter is DELETED rather than rewritten to 1 - which is also the shape the pagination
      // control emits for a first page, so the two agree on one canonical URL for it.
      expect(url.searchParams.has(PAGE_PARAM)).toBe(false);
      expect(url.searchParams.get(CATEGORY_PARAM)).toBe(product.slug);
      expect(url.searchParams.get(QUERY_PARAM)).toBe('fastapi');
    });

    it('selects with the keyboard as well as with a pointer', async () => {
      renderFilter();

      const listbox = await openPicker();
      const reset = within(listbox).getByRole('option', { name: ALL_CATEGORIES_LABEL });
      // Derived from the taxonomy rather than named, so this case follows the server's ordering
      // instead of encoding a guess at which term happens to come first.
      const [firstTerm] = categories;
      if (firstTerm === undefined) {
        throw new Error('Expected the taxonomy fixture to be non-empty.');
      }
      const firstCategory = within(listbox).getByRole('option', { name: firstTerm.name });

      // Radix supplies the roving-focus model; driving it here is what proves the wrapper has not
      // broken it. Focus starts on the active option, and the arrow-key move is applied in a
      // `setTimeout`, so both steps are awaited rather than assumed.
      await waitFor(() => {
        expect(reset).toHaveFocus();
      });
      fireEvent.keyDown(reset, { key: 'ArrowDown' });
      await waitFor(() => {
        expect(firstCategory).toHaveFocus();
      });
      fireEvent.keyDown(firstCategory, { key: 'Enter' });

      expect(pushedUrl().searchParams.get(CATEGORY_PARAM)).toBe(firstTerm.slug);
    });

    it('does not navigate when the category chosen is already the active one', async () => {
      renderFilter({ search: `${CATEGORY_PARAM}=${design.slug}` });

      const listbox = await openPicker();
      fireEvent.click(within(listbox).getByRole('option', { name: design.name }));

      // Radix fires its change handler on a re-selection of the current value, and navigating there
      // would deposit a duplicate history entry - so the Back button would appear to do nothing.
      expect(nav.router.push).not.toHaveBeenCalled();
      expect(nav.router.replace).not.toHaveBeenCalled();
    });
  });

  describe('reset', () => {
    it('removes the category parameter instead of writing a sentinel', async () => {
      renderFilter({
        search: `${CATEGORY_PARAM}=${engineering.slug}&${QUERY_PARAM}=fastapi&${SORT_PARAM}=relevance`,
      });

      const listbox = await openPicker();
      fireEvent.click(within(listbox).getByRole('option', { name: ALL_CATEGORIES_LABEL }));

      const url = pushedUrl();

      // ABSENT, not merely empty - and `has` being false is the complete proof, because a sentinel
      // value, a literal `all`, and even a bare `category=` would each make it true. The unfiltered
      // feed must have exactly one canonical URL; a second one is duplicate content on a page built
      // to be crawled.
      expect(url.searchParams.has(CATEGORY_PARAM)).toBe(false);
      expect(url.searchParams.get(CATEGORY_PARAM)).toBeNull();

      // Clearing this control's slice leaves every other control's alone.
      expect(url.searchParams.get(QUERY_PARAM)).toBe('fastapi');
      expect(url.searchParams.get(SORT_PARAM)).toBe('relevance');
    });

    it('lands on the bare feed route when it clears the only filter', async () => {
      renderFilter({ search: `${CATEGORY_PARAM}=${engineering.slug}` });

      const listbox = await openPicker();
      fireEvent.click(within(listbox).getByRole('option', { name: ALL_CATEGORIES_LABEL }));

      const url = pushedUrl();

      // `/` rather than `/?`, so the unfiltered feed has one address and not two.
      expect(url.pathname).toBe(FEED_PATHNAME);
      expect([...url.searchParams.keys()]).toHaveLength(0);
    });

    it('keeps a stale category clearable', async () => {
      renderFilter({ search: `${CATEGORY_PARAM}=does-not-exist` });

      const listbox = await openPicker();
      fireEvent.click(within(listbox).getByRole('option', { name: ALL_CATEGORIES_LABEL }));

      // The half of stale-slug handling that is easy to miss. Were an unresolvable slug mapped onto
      // the reset option's own value, choosing "All categories" would be a no-change, the change
      // handler would never run, and the junk parameter would stick forever behind an affordance
      // that looks live.
      expect(pushedUrl().searchParams.has(CATEGORY_PARAM)).toBe(false);
    });

    it('does not navigate when the feed is already unfiltered', async () => {
      renderFilter();

      const listbox = await openPicker();
      fireEvent.click(within(listbox).getByRole('option', { name: ALL_CATEGORIES_LABEL }));

      // The URL is already canonical, so there is nothing to write and no history entry to add.
      expect(nav.router.push).not.toHaveBeenCalled();
      expect(nav.router.replace).not.toHaveBeenCalled();
    });
  });
});
