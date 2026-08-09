/**
 * Component tests for `@/components/ui/select` - the category and status picker of this design
 * system, and the primitive that replaces the native `<select>` outright.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS UNDER TEST, AND WHAT DELIBERATELY IS NOT
 *
 * The unit is the project WRAPPER, never `@radix-ui/react-select` itself, and that distinction
 * shapes every assertion below. The primitive already owns - correctly - the
 * combobox/listbox/option ARIA model, roving focus, typeahead, Escape dismissal, focus restoration
 * and portalling. `select.tsx` contributes token-derived visuals, a conditional `SelectItemText`
 * wrap, and two decorative glyphs. Re-testing Radix would be someone else's suite; what this file
 * checks is that the six exported parts STILL EXPOSE the model Radix supplies - because a styling
 * wrapper is precisely what can break it silently. A prop that stops being spread, an `id`
 * swallowed before it reaches the trigger, an unconditional `ItemText` wrap that folds decoration
 * into an option's accessible name, or a glyph that loses `aria-hidden`: none of those produce a
 * type error, a lint warning or a visual difference, and every one of them is caught here.
 *
 * ---------------------------------------------------------------------------
 * ACCESSIBILITY IS THE CONTRACT, SO ACCESSIBILITY IS WHAT IS ASSERTED
 *
 * Interactive widgets in this project are built on unstyled behavioural primitives so that focus
 * management, keyboard operation and ARIA come from one correct implementation instead of being
 * hand-rolled per component. That makes the following the wrapper's observable surface, and each
 * one has a case below: the trigger's `combobox` role and its accessible name; `aria-expanded`
 * flipping in both directions; `aria-controls` pointing at the panel; the `listbox` role on the
 * open content; an `option` role per choice, each with its own accessible name; `aria-selected` on
 * the chosen option and on no other; `disabled` removing the control from operation and from the
 * tab order; and the decorative chevron and tick contributing no accessible name at all.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY HARNESS CARRIES A REAL, VISIBLE <Label>
 *
 * Measured, not assumed: `role="combobox"` takes NO accessible name from its subtree. A trigger
 * rendered without a label, an `aria-label` or an `aria-labelledby` computes an accessible name of
 * the EMPTY STRING - the placeholder text inside it contributes nothing, because the combobox role
 * is not one of the roles that supports name-from-content.
 *
 * That is exactly the contract `select.tsx` documents: the trigger "deliberately does not name
 * itself", and a caller supplies an `id` bound to `@/components/ui/label` with `htmlFor`. Both
 * harnesses below therefore do that, which tests two things at once - that the `id` survives the
 * wrapper's prop spread, and that the resulting name is EXACTLY the label text with nothing
 * appended. The placeholder is a separate concern and is asserted as VISIBLE TEXT rather than as a
 * name, because that is what it actually is.
 *
 * ---------------------------------------------------------------------------
 * WHY fireEvent, AND NOT userEvent
 *
 * `@testing-library/user-event` is NOT a declared dependency of this tier, and the dependency set
 * is a set of exact pins rather than a suggestion, so it is not available and is not added.
 * Interaction is driven with `fireEvent` instead. `fireEvent.keyDown` on the focused trigger is
 * the most reliable way to open a Radix Select under jsdom and is used throughout; `fireEvent.click`
 * on an option is used for the pointer path, and both were verified to work against the pinned
 * primitive.
 *
 * ---------------------------------------------------------------------------
 * REACHING THE PORTALLED PANEL
 *
 * `SelectContent` renders through a portal, so the panel lands OUTSIDE the container `render`
 * returns. It is therefore always reached through `screen` (or through `within(listbox)` once the
 * listbox itself has been found), never through the render result, and always with `findByRole` /
 * `waitFor` rather than a bare synchronous read.
 *
 * ---------------------------------------------------------------------------
 * NO CLASS NAMES, NO COMPUTED STYLES, NO SNAPSHOTS
 *
 * The wrapper's whole visual contribution is a set of design tokens - the field vocabulary it
 * shares with `input.tsx`, a radius and elevation on the panel, an accent highlight on the focused
 * option. NONE of it is asserted here, deliberately. The token layer owns those values and is free
 * to change them: a palette edit or a radius change must never fail a test. So there is no
 * `toHaveClass`, no `className` read, no class-based `querySelector`, no `getComputedStyle` and no
 * snapshot anywhere in this file.
 *
 * The same rule bars `data-highlighted` and `data-state`, which are the primitive's styling hooks
 * and would be a proxy for appearance. Where they carry state, ARIA carries the same state
 * properly - `aria-selected` for the chosen option, `aria-expanded` for the panel - so ARIA is
 * asserted every time it exists. The `querySelectorAll` calls below are TAG-based rather than
 * class-based, and there are only two kinds: one reads the `aria-hidden` ATTRIBUTE off a decorative
 * glyph, which is an accessibility fact rather than a presentation one, and one proves the ABSENCE
 * of the native element this primitive replaces. Neither reads a class or a computed style.
 *
 * ---------------------------------------------------------------------------
 * TWO UPSTREAM BEHAVIOURS THE ASSERTIONS ARE SHAPED AROUND
 *
 *   1. Radix computes `aria-selected` as "selected AND focused", so the chosen option reports
 *      `false` again once the highlight moves elsewhere in the list. `select.tsx` documents this
 *      and cannot override it. The selected-state case therefore waits for the chosen option to
 *      hold the highlight BEFORE asserting, and that ordering must not be rearranged.
 *   2. Radix resolves an arrow key against `event.target` and then moves focus inside a
 *      `setTimeout`. So a keyboard move is fired on the OPTION that currently holds the highlight
 *      (firing on the panel instead merely re-focuses the first option), and the resulting focus is
 *      awaited through `waitFor` rather than read synchronously.
 *
 * ---------------------------------------------------------------------------
 * FIXTURES
 *
 * Blog-domain throughout: the home feed's categories and the author workspace's post-status
 * literals, which are the two real consumers of this primitive. Nothing here resembles the retired
 * demonstration resource this repository used to expose.
 *
 * `@testing-library/jest-dom` is registered globally by `frontend/vitest.setup.ts`, which also
 * unmounts every rendered tree in an `afterEach`, so this file neither re-imports the matchers nor
 * calls `cleanup`. No request is issued by any case below, so no request-interception lifecycle is
 * started either.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, type JSX } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/**
 * A category as the home feed's filter control sees one.
 *
 * `slug` is the value that travels: the filter writes it straight into the URL's `category` search
 * parameter and the server render reads it back to constrain the query. `name` is only ever shown.
 * Keeping the two visibly different is what makes the "reports the slug, not the label" case able
 * to fail.
 */
interface CategoryOption {
  readonly slug: string;
  readonly name: string;
}

/**
 * A post-status option as the author workspace's picker sees one.
 *
 * `postCount` is rendered BESIDE the label as decoration, which is the composition that requires an
 * explicit `SelectItemText`. It exists so that an option's visible text and its accessible name are
 * provably different strings.
 */
interface StatusOption {
  readonly literal: string;
  readonly name: string;
  readonly postCount: number;
}

/** Highlighted by Radix when the panel opens with nothing selected. */
const FIRST_CATEGORY: CategoryOption = { slug: 'engineering', name: 'Engineering' };

/** The neighbour both keyboard cases land on - one step down from the first, one step up from the
 * last - which is what makes those two cases prove the roving-focus model rather than restate it. */
const MIDDLE_CATEGORY: CategoryOption = { slug: 'design', name: 'Design' };

/** Highlighted by Radix when the panel opens with this category already selected. */
const LAST_CATEGORY: CategoryOption = { slug: 'product', name: 'Product' };

/**
 * The option set both category harnesses render, built FROM the named constants above so a fixture
 * and the case that asserts against it cannot drift apart.
 */
const CATEGORY_OPTIONS: readonly CategoryOption[] = [
  FIRST_CATEGORY,
  MIDDLE_CATEGORY,
  LAST_CATEGORY,
];

const DRAFT_STATUS: StatusOption = { literal: 'draft', name: 'Draft', postCount: 4 };
const PUBLISHED_STATUS: StatusOption = { literal: 'published', name: 'Published', postCount: 11 };
const ARCHIVED_STATUS: StatusOption = { literal: 'archived', name: 'Archived', postCount: 2 };

/** The three lifecycle states a post moves through, in the order the workspace lists them. */
const STATUS_OPTIONS: readonly StatusOption[] = [DRAFT_STATUS, PUBLISHED_STATUS, ARCHIVED_STATUS];

/* Field identity. The id is what binds the visible <Label> to the trigger, and the label text is
 * therefore also the trigger's expected accessible name. */
const CATEGORY_FIELD_ID = 'category';
const CATEGORY_FIELD_LABEL = 'Category';
const CATEGORY_PLACEHOLDER = 'All categories';

const STATUS_FIELD_ID = 'status';
const STATUS_FIELD_LABEL = 'Status';
const STATUS_PLACEHOLDER = 'Any status';

/* -------------------------------------------------------------------------------------------------
 * Harnesses
 * ---------------------------------------------------------------------------------------------- */

interface CategoryPickerProps {
  /**
   * Drives the picker as a controlled component, exactly as the home feed does when it derives the
   * current filter from the URL. Omitted, the picker starts on its placeholder.
   */
  readonly value?: string;

  /** Radix reports the chosen option's `value`, typed as the primitive types it. */
  readonly onValueChange?: (next: string) => void;

  /** Forwarded to the root, which is the documented way to disable the whole control. */
  readonly disabled?: boolean;
}

/**
 * The home feed's category filter, composed exactly as a consumer composes it: a visible `Label`
 * bound by `htmlFor` to the trigger's `id`, a `SelectValue` carrying a placeholder, and one
 * `SelectItem` per category with plain text children so the wrapper supplies the `SelectItemText`.
 */
function CategoryPicker({ value, onValueChange, disabled }: CategoryPickerProps): JSX.Element {
  return (
    <>
      <Label htmlFor={CATEGORY_FIELD_ID}>{CATEGORY_FIELD_LABEL}</Label>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger id={CATEGORY_FIELD_ID}>
          <SelectValue placeholder={CATEGORY_PLACEHOLDER} />
        </SelectTrigger>
        <SelectContent>
          {CATEGORY_OPTIONS.map((option) => (
            <SelectItem key={option.slug} value={option.slug}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}

interface StatusPickerProps {
  /** Notified in addition to the internal state update, so a case can assert on both at once. */
  readonly onValueChange?: (next: string) => void;
}

/**
 * The author workspace's status picker, and the second harness for two reasons.
 *
 * It holds its own state, so `onValueChange` can be shown to actually DRIVE the displayed value
 * rather than merely to fire - a picker given a `value` it never updates would pass a spy
 * assertion while being unusable.
 *
 * And every option composes `SelectItemText` explicitly with a visible post count beside it, which
 * is the one composition that exercises the wrapper's conditional-wrap contract: the count must
 * stay out of the option's accessible name and out of the value the trigger displays.
 */
function StatusPicker({ onValueChange }: StatusPickerProps): JSX.Element {
  const [status, setStatus] = useState<string>('');

  const handleValueChange = (next: string): void => {
    setStatus(next);
    onValueChange?.(next);
  };

  return (
    <>
      <Label htmlFor={STATUS_FIELD_ID}>{STATUS_FIELD_LABEL}</Label>
      <Select value={status} onValueChange={handleValueChange}>
        <SelectTrigger id={STATUS_FIELD_ID}>
          <SelectValue placeholder={STATUS_PLACEHOLDER} />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((option) => (
            <SelectItem key={option.literal} value={option.literal}>
              <SelectItemText>{option.name}</SelectItemText>
              <span>{option.postCount}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p>{status === '' ? 'No status chosen' : `Filtering by ${status}`}</p>
    </>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Focus the trigger, open the panel with a key, and resolve to the portalled listbox.
 *
 * The focus call is not decoration: Radix's trigger handles the key itself, and the point of every
 * keyboard case here is that the control is operable from the keyboard alone, which starts with the
 * trigger being the focused element.
 *
 * `findByRole` rather than `getByRole` even though the panel does in fact mount synchronously -
 * `fireEvent` wraps the dispatch in `act`, so React has already flushed the open state by the time
 * it returns. Awaiting is free when there is nothing to wait for, and it is the form that stays
 * correct if the primitive ever defers the mount.
 */
async function openWithKey(trigger: HTMLElement, key: string): Promise<HTMLElement> {
  trigger.focus();
  fireEvent.keyDown(trigger, { key });

  return screen.findByRole('listbox');
}

/**
 * Wait for the roving highlight to settle on `option`.
 *
 * Radix moves focus inside a `setTimeout`, so this genuinely cannot be read synchronously - and a
 * bare read is the one thing that would make these cases intermittent. `waitFor` is used rather
 * than any timer of our own.
 */
async function waitForHighlight(option: HTMLElement): Promise<void> {
  await waitFor(() => {
    expect(option).toHaveFocus();
  });
}

/**
 * Build an anchored matcher for `toHaveTextContent`.
 *
 * Asserting that a field shows one string and NOTHING ELSE is how the decorative chevron and the
 * options' post counts are shown not to leak into the value on display - an unanchored substring
 * match would pass either way. Every argument below is a literal fixture string declared in this
 * file, none of which contains a regular-expression metacharacter.
 */
function exactText(text: string): RegExp {
  return new RegExp(`^${text}$`);
}

/**
 * Assert that every glyph inside `host` is hidden from the accessibility tree.
 *
 * Reaches the glyph by TAG rather than by class, and reads only `aria-hidden` - an ARIA attribute,
 * not a presentation one. `expectedCount` is asserted too, because "no glyph is exposed" would
 * otherwise pass vacuously on a host that renders no glyph at all.
 */
function expectGlyphsHiddenFromAssistiveTech(host: HTMLElement, expectedCount: number): void {
  const glyphs = Array.from(host.querySelectorAll('svg'));

  expect(glyphs).toHaveLength(expectedCount);

  for (const glyph of glyphs) {
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
  }
}

/* -------------------------------------------------------------------------------------------------
 * Suite
 * ---------------------------------------------------------------------------------------------- */

describe('Select', () => {
  describe('trigger', () => {
    it('renders as a combobox named by its associated label', () => {
      render(<CategoryPicker />);

      const trigger = screen.getByRole('combobox', { name: CATEGORY_FIELD_LABEL });

      // The name is EXACTLY the label text. That is the whole of the wrapper's naming contract: it
      // adds no name of its own, and it did not swallow the `id` the <Label> is bound to.
      expect(trigger).toHaveAccessibleName(CATEGORY_FIELD_LABEL);
      expect(trigger).toBeEnabled();
    });

    it('shows the placeholder while nothing is selected', () => {
      render(<CategoryPicker />);

      const trigger = screen.getByRole('combobox', { name: CATEGORY_FIELD_LABEL });

      // Visible text, not accessible name - the placeholder is a sighted-reader hint, and the
      // combobox role takes no name from its subtree in any case.
      expect(within(trigger).getByText(CATEGORY_PLACEHOLDER)).toBeVisible();

      // Anchored, so the field is showing the hint and nothing else: no category name has leaked in
      // and the chevron has contributed no text.
      expect(trigger).toHaveTextContent(exactText(CATEGORY_PLACEHOLDER));
    });

    it('reports aria-expanded false while the panel is closed', () => {
      render(<CategoryPicker />);

      expect(screen.getByRole('combobox', { name: CATEGORY_FIELD_LABEL })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('keeps the decorative chevron out of the accessible name', () => {
      render(<CategoryPicker />);

      const trigger = screen.getByRole('combobox', { name: CATEGORY_FIELD_LABEL });

      // Two halves of one fact. The name is exactly the label, with no glyph text appended...
      expect(trigger).toHaveAccessibleName(CATEGORY_FIELD_LABEL);

      // ...and the chevron itself is hidden from assistive technology, which is why. Exactly one
      // glyph: the field renders the chevron and nothing else.
      expectGlyphsHiddenFromAssistiveTech(trigger, 1);
    });

    it('cannot be opened while the picker is disabled', () => {
      render(<CategoryPicker disabled />);

      const trigger = screen.getByRole('combobox', { name: CATEGORY_FIELD_LABEL });

      expect(trigger).toBeDisabled();

      // A disabled control is out of the tab order as well as inoperable, so the focus call cannot
      // land on it.
      trigger.focus();
      expect(trigger).not.toHaveFocus();

      // Every route in: two keys and the pointer.
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });
      fireEvent.keyDown(trigger, { key: 'Enter' });
      fireEvent.click(trigger);

      // Read synchronously on purpose, and it is sound rather than a race: `fireEvent` dispatches
      // inside `act`, and the enabled picker's panel is in the document the instant the equivalent
      // call returns (every other case here relies on that). A null here is therefore a real
      // refusal to open, not a measurement taken too early.
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    it('supersedes the native select element entirely', () => {
      render(<CategoryPicker />);

      // The design system forbids a raw <select> outside the primitive that replaces it, and this
      // primitive replaces it rather than wrapping it: the control a reader operates is a button
      // with the combobox role, and no native picker exists anywhere in the document to shadow it.
      expect(screen.getByRole('combobox', { name: CATEGORY_FIELD_LABEL })).toBeInstanceOf(
        HTMLButtonElement,
      );
      expect(Array.from(document.querySelectorAll('select'))).toHaveLength(0);
      expect(Array.from(document.querySelectorAll('option'))).toHaveLength(0);
    });
  });

  describe('open and choose', () => {
    it('reveals a listbox holding one option per category', async () => {
      render(<CategoryPicker onValueChange={vi.fn()} />);

      const trigger = screen.getByRole('combobox', { name: CATEGORY_FIELD_LABEL });
      const listbox = await openWithKey(trigger, 'ArrowDown');

      expect(listbox).toBeVisible();
      expect(trigger).toHaveAttribute('aria-expanded', 'true');

      // The relationship Radix publishes between the field and its panel. Guard the id first, so
      // this cannot pass by comparing one empty string against another.
      expect(listbox.id).not.toBe('');
      expect(trigger).toHaveAttribute('aria-controls', listbox.id);

      const options = within(listbox).getAllByRole('option');
      expect(options).toHaveLength(CATEGORY_OPTIONS.length);

      // Each choice is an addressable option with its own accessible name - which is what makes the
      // list operable by a screen reader and by name-based queries alike.
      for (const category of CATEGORY_OPTIONS) {
        expect(within(listbox).getByRole('option', { name: category.name })).toBeVisible();
      }
    });

    it('reports the chosen slug rather than the display text', async () => {
      const onValueChange = vi.fn<(next: string) => void>();
      render(<CategoryPicker onValueChange={onValueChange} />);

      const trigger = screen.getByRole('combobox', { name: CATEGORY_FIELD_LABEL });
      const listbox = await openWithKey(trigger, 'ArrowDown');

      fireEvent.click(within(listbox).getByRole('option', { name: MIDDLE_CATEGORY.name }));

      await waitFor(() => {
        expect(onValueChange).toHaveBeenCalledTimes(1);
      });

      // THE ASSERTION THIS FILE EXISTS FOR. The feed's filter writes whatever arrives here straight
      // into the URL's `category` parameter, and the server render matches it against a slug. A
      // wrapper that passed the display text would produce a filter that silently matches nothing -
      // no error, no empty-state bug report, just a feed that quietly returns zero posts. Only the
      // pair below tells the two apart.
      expect(onValueChange).toHaveBeenCalledWith(MIDDLE_CATEGORY.slug);
      expect(onValueChange).not.toHaveBeenCalledWith(MIDDLE_CATEGORY.name);
    });

    it('displays the matching option text once a value is supplied', () => {
      render(<CategoryPicker value={LAST_CATEGORY.slug} onValueChange={vi.fn()} />);

      const trigger = screen.getByRole('combobox', { name: CATEGORY_FIELD_LABEL });

      // A controlled value resolves to the matching item's LABEL in the field, not to the raw slug
      // it was given, and the placeholder gives way to it.
      expect(within(trigger).getByText(LAST_CATEGORY.name)).toBeVisible();
      expect(trigger).toHaveTextContent(exactText(LAST_CATEGORY.name));
      expect(within(trigger).queryByText(CATEGORY_PLACEHOLDER)).toBeNull();
    });

    it('marks only the chosen option as selected', async () => {
      render(<CategoryPicker value={MIDDLE_CATEGORY.slug} onValueChange={vi.fn()} />);

      const trigger = screen.getByRole('combobox', { name: CATEGORY_FIELD_LABEL });
      const listbox = await openWithKey(trigger, 'ArrowDown');
      const chosen = within(listbox).getByRole('option', { name: MIDDLE_CATEGORY.name });

      // ORDER IS LOAD-BEARING: Radix computes `aria-selected` as "selected AND focused", so this
      // must be read while the chosen option still holds the highlight Radix gave it on open. Do not
      // move these assertions after a keyboard move.
      await waitForHighlight(chosen);
      expect(chosen).toHaveAttribute('aria-selected', 'true');

      for (const category of CATEGORY_OPTIONS.filter(
        (option) => option.slug !== MIDDLE_CATEGORY.slug,
      )) {
        expect(within(listbox).getByRole('option', { name: category.name })).toHaveAttribute(
          'aria-selected',
          'false',
        );
      }

      // The tick that marks the selection is decorative - `aria-selected` already carries the fact -
      // so the option's name stays exactly its label, and only the selected option mounts a glyph.
      expect(chosen).toHaveAccessibleName(MIDDLE_CATEGORY.name);
      expectGlyphsHiddenFromAssistiveTech(chosen, 1);
      expectGlyphsHiddenFromAssistiveTech(
        within(listbox).getByRole('option', { name: FIRST_CATEGORY.name }),
        0,
      );
    });

    it('closes the panel and shows the new value once a choice is made', async () => {
      render(<StatusPicker />);

      const trigger = screen.getByRole('combobox', { name: STATUS_FIELD_LABEL });

      expect(within(trigger).getByText(STATUS_PLACEHOLDER)).toBeVisible();
      expect(screen.getByText('No status chosen')).toBeVisible();

      const listbox = await openWithKey(trigger, 'ArrowDown');
      fireEvent.click(within(listbox).getByRole('option', { name: PUBLISHED_STATUS.name }));

      await waitFor(() => {
        expect(screen.queryByRole('listbox')).toBeNull();
      });

      expect(trigger).toHaveAttribute('aria-expanded', 'false');

      // `onValueChange` did not merely fire - it drove the state that renders the field and the
      // read-out beside it, with the literal the API stores reaching the consumer intact.
      expect(within(trigger).getByText(PUBLISHED_STATUS.name)).toBeVisible();
      expect(screen.getByText(`Filtering by ${PUBLISHED_STATUS.literal}`)).toBeVisible();
    });

    it('keeps decoration composed beside SelectItemText out of the option name', async () => {
      render(<StatusPicker />);

      const trigger = screen.getByRole('combobox', { name: STATUS_FIELD_LABEL });
      const listbox = await openWithKey(trigger, 'ArrowDown');

      expect(within(listbox).getAllByRole('option')).toHaveLength(STATUS_OPTIONS.length);

      // The count is VISIBLE in every row but absent from every row's NAME. That gap is the
      // wrapper's conditional-wrap contract holding: because the caller composed `SelectItemText`
      // itself, the wrapper added no second one, so only the label is registered as the option's
      // text. Had it wrapped unconditionally, the outer part would have swallowed the count into the
      // name, into what typeahead matches, and into what the field displays - silently, and in all
      // three places at once.
      for (const status of STATUS_OPTIONS) {
        const option = within(listbox).getByRole('option', { name: status.name });

        expect(option).toHaveAccessibleName(status.name);
        expect(option).toHaveTextContent(String(status.postCount));
      }

      fireEvent.click(within(listbox).getByRole('option', { name: PUBLISHED_STATUS.name }));

      await waitFor(() => {
        expect(screen.queryByRole('listbox')).toBeNull();
      });

      // The third place: the field shows the label alone, with the count left behind in the list.
      expect(trigger).toHaveTextContent(exactText(PUBLISHED_STATUS.name));
    });
  });

  describe('keyboard', () => {
    it('opens from the focused trigger with Enter', async () => {
      render(<CategoryPicker onValueChange={vi.fn()} />);

      const trigger = screen.getByRole('combobox', { name: CATEGORY_FIELD_LABEL });
      const listbox = await openWithKey(trigger, 'Enter');

      expect(listbox).toBeVisible();
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
    });

    it('opens from the focused trigger with Space', async () => {
      render(<CategoryPicker onValueChange={vi.fn()} />);

      const trigger = screen.getByRole('combobox', { name: CATEGORY_FIELD_LABEL });
      const listbox = await openWithKey(trigger, ' ');

      expect(listbox).toBeVisible();
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
    });

    it('moves the highlight down with ArrowDown and chooses with Enter', async () => {
      const onValueChange = vi.fn<(next: string) => void>();
      render(<CategoryPicker onValueChange={onValueChange} />);

      const trigger = screen.getByRole('combobox', { name: CATEGORY_FIELD_LABEL });
      const listbox = await openWithKey(trigger, 'ArrowDown');

      // Opening with nothing selected puts the highlight on the first option.
      const first = within(listbox).getByRole('option', { name: FIRST_CATEGORY.name });
      await waitForHighlight(first);

      // Fired on the highlighted OPTION, not on the panel: Radix resolves the step from
      // `event.target`, so a key aimed at the panel would only re-focus the first option and this
      // case would prove nothing.
      fireEvent.keyDown(first, { key: 'ArrowDown' });

      const second = within(listbox).getByRole('option', { name: MIDDLE_CATEGORY.name });
      await waitForHighlight(second);

      fireEvent.keyDown(second, { key: 'Enter' });

      await waitFor(() => {
        expect(onValueChange).toHaveBeenCalledTimes(1);
      });

      // The NEIGHBOUR's slug, not the first option's - so the highlight really moved, and the value
      // committed is the one the highlight had reached.
      expect(onValueChange).toHaveBeenCalledWith(MIDDLE_CATEGORY.slug);
    });

    it('moves the highlight up with ArrowUp and chooses with Enter', async () => {
      const onValueChange = vi.fn<(next: string) => void>();
      render(<CategoryPicker value={LAST_CATEGORY.slug} onValueChange={onValueChange} />);

      const trigger = screen.getByRole('combobox', { name: CATEGORY_FIELD_LABEL });
      const listbox = await openWithKey(trigger, 'ArrowDown');

      // Opening with a selection puts the highlight on the selected option, so the list can be
      // walked upward from the end as well as downward from the start.
      const last = within(listbox).getByRole('option', { name: LAST_CATEGORY.name });
      await waitForHighlight(last);

      fireEvent.keyDown(last, { key: 'ArrowUp' });

      const previous = within(listbox).getByRole('option', { name: MIDDLE_CATEGORY.name });
      await waitForHighlight(previous);

      fireEvent.keyDown(previous, { key: 'Enter' });

      await waitFor(() => {
        expect(onValueChange).toHaveBeenCalledTimes(1);
      });

      expect(onValueChange).toHaveBeenCalledWith(MIDDLE_CATEGORY.slug);
    });

    it('closes on Escape, restores focus to the trigger and reopens', async () => {
      render(<CategoryPicker onValueChange={vi.fn()} />);

      const trigger = screen.getByRole('combobox', { name: CATEGORY_FIELD_LABEL });
      const listbox = await openWithKey(trigger, 'ArrowDown');

      fireEvent.keyDown(listbox, { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByRole('listbox')).toBeNull();
        expect(trigger).toHaveFocus();
      });

      expect(trigger).toHaveAttribute('aria-expanded', 'false');

      // Dismissal did not wedge the control: with focus back where it started, the same key opens it
      // again. A picker that could be closed once and never reopened would pass every assertion
      // above and still be broken.
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });

      expect(await screen.findByRole('listbox')).toBeVisible();
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
    });
  });
});
