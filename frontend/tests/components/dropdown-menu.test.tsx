/**
 * Component tests for `@/components/ui/dropdown-menu`.
 *
 * That module is the design system's "user menu and row actions" primitive: seven parts -
 * `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuGroup`, `DropdownMenuContent`,
 * `DropdownMenuItem`, `DropdownMenuRadioGroup` and `DropdownMenuRadioItem` - wrapping
 * `@radix-ui/react-dropdown-menu@2.1.24`. Every one of them is exercised below.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE TESTS ARE FOR, GIVEN THAT RADIX IS ALREADY TESTED
 *
 * The primitive owns the whole interaction model: roving focus (one tab stop, arrow keys moving
 * the highlight), typeahead, dismissal on Escape and on outside pointer-down, focus restoration
 * to the trigger, portalling, and the `role="menu"` / `role="menuitem"` semantics together with
 * `aria-haspopup`, `aria-expanded`, `aria-disabled` and `aria-checked`. None of that is
 * reimplemented in the wrapper, and none of it is this suite's to prove correct in the abstract.
 *
 * What this suite proves is that the wrapper PRESERVED it. A thin wrapper has exactly two
 * realistic failure modes, and both are silent:
 *
 *   1. A part stops forwarding something - a `disabled`, an `onSelect`, an `align`, a
 *      `sideOffset`, or the props spread itself - so behaviour the primitive supplies never
 *      reaches the DOM.
 *   2. A part interposes an element or a handler that swallows a role, a name or an event, so
 *      the semantics collapse while the menu still looks right.
 *
 * Every assertion below therefore targets the OBSERVABLE contract a consumer and an assistive
 * technology actually receive: accessible names, roles, `aria-*` state, focus, and whether a
 * handler ran. `src/components/layout/user-menu`, `theme-toggle` and the three admin row-action
 * menus (`user-row-actions`, `post-row-actions`, `comment-moderation-actions`) all depend on
 * precisely that contract.
 *
 * THE HIGHEST-VALUE CASE IN THIS FILE is "dismisses on Escape without invoking any action
 * handler". Every irreversible action in the admin dashboard - remove a user, delete a post,
 * delete a comment - is reached through this menu, so a wrapper that conflated dismissal with
 * selection would let an administrator destroy a record by pressing Escape. No role assertion
 * and no styling assertion would ever reveal that; only spying on every handler across a
 * dismissal does.
 *
 * ---------------------------------------------------------------------------
 * NO CLASS NAMES, NO COLOURS, NO SNAPSHOTS - AND WHAT THAT MEANS FOR THE DESTRUCTIVE ROW
 *
 * The token layer owns every class name in the unit under test and is free to change them; a
 * palette edit in `src/app/globals.css` must not be able to fail a test. So this file contains
 * no `toHaveClass`, no `className` inspection, no class-based `querySelector`, no
 * `getComputedStyle` and no snapshot, and it asserts nothing about the panel's position,
 * alignment or offset - jsdom computes no layout, so any such assertion would be theatre.
 *
 * The tempting exception is the destructive row, which the wrapper tints with `--color-danger`.
 * It is deliberately NOT asserted as "the delete row is red". It is asserted by its accessible
 * name, `Delete post`, because that name is the ENTIRE presentation a screen-reader user
 * receives and the only signal that survives when the tint cannot be seen - which makes it the
 * assertion that actually matters. The unit additionally mirrors its `variant` prop onto the
 * element as `data-variant` expressly so a test can confirm the treatment without reading a
 * class; that attribute is asserted once, as evidence the prop is FORWARDED, and it carries no
 * claim about colour.
 *
 * `data-highlighted` is likewise never asserted. It is the primitive's own highlight signal, so
 * using it as a proxy for "this row is current" would test the styling hook rather than the
 * state; focus and `aria-*` are asserted instead.
 *
 * ---------------------------------------------------------------------------
 * HOW THE MENU IS DRIVEN - MEASURED, NOT ASSUMED
 *
 * `@testing-library/user-event` is not in the declared dependency set (see
 * `frontend/package.json`), so events come from `fireEvent`. Two measured facts shape every
 * helper below:
 *
 *   * `fireEvent.click(trigger)` does NOT open the menu. The primitive opens on `pointerdown`,
 *     and a bare `click` never produces one. `openMenu()` therefore uses
 *     `fireEvent.keyDown(trigger, { key: 'ArrowDown' })` - which is also the path the
 *     accessibility floor cares about - and one dedicated case covers the pointer route with
 *     `fireEvent.pointerDown`.
 *   * Radix moves focus inside a timeout, so focus is never observable on the line after the
 *     event that caused it. Every focus assertion is awaited through `waitFor`, and every
 *     appearance through `findBy*`. Nothing in this file waits on a bare timer: `setTimeout`
 *     based waiting both flakes and produces `act()` warnings, where `waitFor` does neither.
 *
 * `DropdownMenuContent` renders inside a portal, so the panel is not a descendant of the
 * container `render()` returns. Every query goes through `screen` (or `within` a node found
 * through `screen`), never through the render result.
 *
 * ---------------------------------------------------------------------------
 * PROJECT CONVENTIONS THIS FILE HONOURS
 *
 * `review_rules` reports that no user rules were provided for this project, so the binding
 * constraints are the enterprise standards the plan sets out: accessibility as a floor (which
 * is what the role, name, `aria-*` and focus assertions discharge), blocking quality gates
 * (`npm run test -- --run`, `tsc --noEmit` under `strict`, `eslint . --max-warnings=0` - so no
 * `.only`, no `.skip`, no `any` and no unused symbol appears below), zero hardcoded
 * presentation values (the class and colour prohibitions above), and pinned dependencies (only
 * declared packages are imported, and `@radix-ui/react-dropdown-menu` is deliberately not one
 * of them - testing the wrapper means importing only the wrapper).
 *
 * The test API is imported rather than taken from Vitest's globals. `frontend/tsconfig.json`
 * includes every `.tsx` file in the `tsc --noEmit` program, and that gate fails with TS2593 on
 * a bare `describe`, so importing it is what keeps both gates green. `cleanup` and the jest-dom
 * matchers are already handled by `frontend/vitest.setup.ts` and must not be repeated here, and
 * no request interception is configured because this file performs no HTTP.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { JSX } from 'react';
import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/*
 * The harness is modelled on a real consumer - src/components/admin/post-row-actions.tsx -
 * rather than on a minimal two-item menu, because the shape of that consumer is what the
 * contract has to survive: a record-identifying trigger name, a NAMED group of lifecycle
 * actions of which one is disabled, and a second group holding the single irreversible action.
 * A menu of two enabled items would pass while every one of those distinctions was broken.
 *
 * The trigger is the primitive's own bare `<button>` with text children. The real consumer
 * composes `<DropdownMenuTrigger asChild><Button /></DropdownMenuTrigger>` instead, which is
 * not reproducible here: `@/components/ui/button` is not among this file's declared
 * dependencies, and importing it would put a second primitive's regressions inside this one's
 * suite. Text children give the trigger the same accessible name the consumer's `aria-label`
 * does, which is all these assertions read.
 */

/**
 * Accessible name of the trigger. It identifies the RECORD, exactly as the admin row menus do:
 * a table of identically-named "Actions" buttons is ambiguous in a screen reader's element list
 * and unusable by voice control. Radix also labels the panel with this name through
 * `aria-labelledby`, which one case below asserts.
 */
const TRIGGER_NAME = 'Actions for Scaling FastAPI';

/** Accessible name of the group wrapping the lifecycle actions. */
const LIFECYCLE_GROUP_NAME = 'Post lifecycle';

const EDIT_ACTION = 'Edit post';
const STATUS_ACTION = 'Change status';

/**
 * The irreversible action. Asserted by THIS STRING throughout - never by its `--color-danger`
 * treatment - for the reason recorded in the file header.
 */
const DELETE_ACTION = 'Delete post';

/** Every action the harness renders, in DOM order. */
const ALL_ACTIONS = [EDIT_ACTION, STATUS_ACTION, DELETE_ACTION] as const;

interface RowActionsMenuProps {
  /** Handler for the first lifecycle action. */
  readonly onEditPost: () => void;
  /** Handler for the second lifecycle action, which is the one a test may disable. */
  readonly onChangeStatus: () => void;
  /** Handler for the destructive action. */
  readonly onDeletePost: () => void;
  /** Renders the status action non-actionable, as a row does while a request is in flight. */
  readonly statusChangeDisabled: boolean;
  /** Forwarded to the content part untouched; `undefined` leaves the primitive's own default. */
  readonly align?: 'start' | 'center' | 'end';
  /** Forwarded to the content part untouched; `undefined` leaves the primitive's own default. */
  readonly sideOffset?: number;
}

function RowActionsMenu({
  onEditPost,
  onChangeStatus,
  onDeletePost,
  statusChangeDisabled,
  align,
  sideOffset,
}: RowActionsMenuProps): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>{TRIGGER_NAME}</DropdownMenuTrigger>

      <DropdownMenuContent align={align} sideOffset={sideOffset}>
        {/* A named group, because `role="group"` around lifecycle rows is what tells assistive
            technology they are one setting rather than unrelated commands. */}
        <DropdownMenuGroup aria-label={LIFECYCLE_GROUP_NAME}>
          <DropdownMenuItem onSelect={onEditPost}>{EDIT_ACTION}</DropdownMenuItem>
          <DropdownMenuItem disabled={statusChangeDisabled} onSelect={onChangeStatus}>
            {STATUS_ACTION}
          </DropdownMenuItem>
        </DropdownMenuGroup>

        {/* The irreversible action, in its own group - the consumer's arrangement. `variant`
            is the only prop the wrapper adds to the primitive's item. */}
        <DropdownMenuGroup>
          <DropdownMenuItem variant="destructive" onSelect={onDeletePost}>
            {DELETE_ACTION}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One spy per action, so a case can assert that exactly one of them ran - or that none did. */
interface RowActionSpies {
  readonly editPost: Mock;
  readonly changeStatus: Mock;
  readonly deletePost: Mock;
}

interface RenderRowActionsOptions {
  readonly statusChangeDisabled?: boolean;
  readonly align?: 'start' | 'center' | 'end';
  readonly sideOffset?: number;
}

/**
 * Renders the harness and returns its spies.
 *
 * Fresh spies per call rather than module-level ones: a shared spy would leak call counts
 * between cases, and the "no handler ran" assertion is only meaningful against a spy that
 * cannot have been called by an earlier test.
 */
function renderRowActions(options: RenderRowActionsOptions = {}): RowActionSpies {
  const spies: RowActionSpies = {
    editPost: vi.fn(),
    changeStatus: vi.fn(),
    deletePost: vi.fn(),
  };

  render(
    <RowActionsMenu
      onEditPost={spies.editPost}
      onChangeStatus={spies.changeStatus}
      onDeletePost={spies.deletePost}
      statusChangeDisabled={options.statusChangeDisabled ?? false}
      align={options.align}
      sideOffset={options.sideOffset}
    />,
  );

  return spies;
}

/** The trigger, found the way a consumer's user finds it: by role and accessible name. */
function getTrigger(): HTMLElement {
  return screen.getByRole('button', { name: TRIGGER_NAME });
}

/**
 * Opens the menu from the keyboard and resolves with the panel.
 *
 * `ArrowDown` on the focused trigger is the documented keyboard affordance, and - measured -
 * the reliable one in jsdom, where a bare `click` produces no `pointerdown` for the primitive
 * to open on. Resolving through `findByRole` rather than `getByRole` accounts for the panel
 * mounting through a portal on a later tick.
 */
async function openMenu(): Promise<HTMLElement> {
  const trigger = getTrigger();
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });

  return screen.findByRole('menu');
}

/** Asserts that not one of the harness's action handlers ran. */
function expectNoActionRan(spies: RowActionSpies): void {
  expect(spies.editPost).not.toHaveBeenCalled();
  expect(spies.changeStatus).not.toHaveBeenCalled();
  expect(spies.deletePost).not.toHaveBeenCalled();
}

/*
 * A second harness for the radio pair, modelled on src/components/layout/theme-toggle.tsx.
 *
 * These two parts exist because the colour theme is a THREE-valued setting, and the unit's own
 * documentation is explicit that no boolean control can state which of the three is current.
 * They are part of the module's public API, so they are covered here rather than left to the
 * end-to-end theme journey - and they behave differently enough from a plain item to need their
 * own cases: the primitive gives a radio row `role="menuitemradio"` with `aria-checked`, and
 * `getAllByRole('menuitem')` does NOT match that role.
 */

const THEME_TRIGGER_NAME = 'Colour theme';

/*
 * The three options, each pairing the value the group reports with the label a reader sees. One
 * declaration per option, and the tuple built from them, so a label is written once and no
 * assertion has to index into the tuple - `noUncheckedIndexedAccess` is on, and an indexed read
 * would arrive as possibly-undefined.
 */
const SYSTEM_THEME = { value: 'system', label: 'System' } as const;
const LIGHT_THEME = { value: 'light', label: 'Light' } as const;
const DARK_THEME = { value: 'dark', label: 'Dark' } as const;
const THEME_OPTIONS = [SYSTEM_THEME, LIGHT_THEME, DARK_THEME] as const;

/** The option the harness starts on, so "which one is checked" has a definite answer. */
const CURRENT_THEME = SYSTEM_THEME;

/** The option a case switches to, so the reported value has something to be checked against. */
const CHOSEN_THEME = DARK_THEME;

interface ThemeMenuProps {
  readonly onValueChange: (value: string) => void;
}

function ThemeMenu({ onValueChange }: ThemeMenuProps): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>{THEME_TRIGGER_NAME}</DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={CURRENT_THEME.value} onValueChange={onValueChange}>
          {THEME_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Renders the theme harness and returns the spy that receives the newly chosen option. */
function renderThemeMenu(): Mock {
  const onValueChange: Mock = vi.fn();

  render(<ThemeMenu onValueChange={onValueChange} />);

  return onValueChange;
}

/** Opens the theme harness's menu from the keyboard and resolves with the panel. */
async function openThemeMenu(): Promise<HTMLElement> {
  const trigger = screen.getByRole('button', { name: THEME_TRIGGER_NAME });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });

  return screen.findByRole('menu');
}

/* -------------------------------------------------------------------------- */
/* Suite                                                                      */
/* -------------------------------------------------------------------------- */

describe('DropdownMenu', () => {
  describe('opening', () => {
    it('renders nothing but the trigger until the menu is opened', () => {
      renderRowActions();

      // The trigger is present and nameable. `getByRole` would throw if it were not, so this
      // is a real assertion rather than a formality.
      expect(getTrigger()).toBeVisible();

      // No panel, and - just as importantly - no action leaked into the document while the
      // menu is closed. A wrapper that rendered its content outside the primitive's presence
      // machinery would expose every row, including the destructive one, to a keyboard user
      // who never opened the menu.
      expect(screen.queryByRole('menu')).toBeNull();
      for (const action of ALL_ACTIONS) {
        expect(screen.queryByRole('menuitem', { name: action })).toBeNull();
      }
    });

    it('advertises a collapsed menu on the trigger before it is opened', () => {
      renderRowActions();
      const trigger = getTrigger();

      // The pair that tells a screen reader this control owns a menu and that the menu is not
      // showing. Both come from the primitive; the wrapper re-exports the trigger unstyled
      // precisely so they cannot be displaced by a hand-written attribute.
      expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    it('reveals every action, each with its accessible name, and reports itself expanded', async () => {
      renderRowActions();
      const trigger = getTrigger();

      const menu = await openMenu();

      expect(menu).toBeVisible();
      expect(trigger).toHaveAttribute('aria-expanded', 'true');

      for (const action of ALL_ACTIONS) {
        expect(screen.getByRole('menuitem', { name: action })).toBeVisible();
      }
    });

    it('opens for a pointer user as well as for a keyboard one', async () => {
      renderRowActions();

      // The primitive opens on `pointerdown`, not on `click`, so this is the event a pointer
      // user actually generates. Asserted separately from the keyboard path because a wrapper
      // that intercepted the trigger's pointer handling would break only this one.
      fireEvent.pointerDown(getTrigger(), { button: 0, ctrlKey: false });

      const menu = await screen.findByRole('menu');
      expect(within(menu).getByRole('menuitem', { name: EDIT_ACTION })).toBeVisible();
    });

    it('names the open menu after the trigger that owns it', async () => {
      renderRowActions();

      const menu = await openMenu();

      // Radix labels the panel with the trigger's id through `aria-labelledby`, so the menu
      // inherits the trigger's name and a screen reader announces WHICH record's menu is open.
      // That link is fragile in one specific way the unit documents: an explicit `id` on the
      // trigger replaces the generated one and silently empties this name. Asserting the
      // computed name - rather than the attribute - is what would catch that.
      expect(menu).toHaveAccessibleName(TRIGGER_NAME);
    });

    it('renders every action inside the menu and none outside it', async () => {
      renderRowActions();

      const menu = await openMenu();

      // Scoped to the panel, so an action rendered as a sibling of it - which is what a broken
      // portal or a swallowed group would produce - fails here rather than passing a global
      // query.
      expect(within(menu).getAllByRole('menuitem')).toHaveLength(ALL_ACTIONS.length);
      expect(screen.getAllByRole('menuitem')).toHaveLength(ALL_ACTIONS.length);
    });

    it('keeps grouped actions discoverable as menu items', async () => {
      renderRowActions();

      const menu = await openMenu();

      // `DropdownMenuGroup` is re-exported unstyled, and the risk it carries is that a
      // grouping wrapper swallows the roles of what it contains. Both halves are asserted: the
      // group is exposed with its own name, and its children are still menu items.
      const lifecycleGroup = within(menu).getByRole('group', { name: LIFECYCLE_GROUP_NAME });

      expect(within(lifecycleGroup).getByRole('menuitem', { name: EDIT_ACTION })).toBeVisible();
      expect(within(lifecycleGroup).getByRole('menuitem', { name: STATUS_ACTION })).toBeVisible();
      expect(within(lifecycleGroup).getAllByRole('menuitem')).toHaveLength(2);

      // The destructive action sits in the harness's second, unnamed group - so two groups,
      // which is what tells us the second one was not silently merged into the first.
      expect(within(menu).getAllByRole('group')).toHaveLength(2);
    });

    it('accepts the positioning props its consumers pass', async () => {
      // `align` and `sideOffset` are the two the admin row menus and the site header actually
      // use, and the wrapper defaults NEITHER - it spreads them straight through. What is
      // asserted is that passing them changes nothing about the menu's semantics: the panel
      // still opens with every action reachable. Where the panel ends up is deliberately not
      // asserted, because jsdom computes no layout and any coordinate here would be fiction.
      renderRowActions({ align: 'end', sideOffset: 4 });

      const menu = await openMenu();

      expect(menu).toHaveAccessibleName(TRIGGER_NAME);
      expect(within(menu).getAllByRole('menuitem')).toHaveLength(ALL_ACTIONS.length);
    });
  });

  describe('selection', () => {
    it('invokes only the handler of the action that was chosen', async () => {
      const spies = renderRowActions();
      await openMenu();

      fireEvent.click(screen.getByRole('menuitem', { name: EDIT_ACTION }));

      // Exactly once - not zero (a swallowed `onSelect`) and not twice (a wrapper that added
      // its own click handler on top of the primitive's selection path).
      await waitFor(() => {
        expect(spies.editPost).toHaveBeenCalledTimes(1);
      });
      expect(spies.changeStatus).not.toHaveBeenCalled();
      expect(spies.deletePost).not.toHaveBeenCalled();
    });

    it('dismisses the menu once an action is chosen', async () => {
      renderRowActions();
      await openMenu();

      fireEvent.click(screen.getByRole('menuitem', { name: EDIT_ACTION }));

      await waitFor(() => {
        expect(screen.queryByRole('menu')).toBeNull();
      });
      expect(getTrigger()).toHaveAttribute('aria-expanded', 'false');
    });

    it('runs the destructive action, identified by its accessible name', async () => {
      const spies = renderRowActions();
      const menu = await openMenu();

      // The destructive row is found the way every consumer of it is found: by name. Its
      // `--color-danger` treatment is deliberately not asserted - see the file header - because
      // the name is what a screen-reader user receives and what survives a palette change.
      const deleteAction = within(menu).getByRole('menuitem', { name: DELETE_ACTION });
      expect(deleteAction).toBeVisible();

      fireEvent.click(deleteAction);

      await waitFor(() => {
        expect(spies.deletePost).toHaveBeenCalledTimes(1);
      });
      expect(spies.editPost).not.toHaveBeenCalled();
      expect(spies.changeStatus).not.toHaveBeenCalled();
    });

    it('forwards the destructive variant to the attribute the unit mirrors it onto', async () => {
      renderRowActions();
      const menu = await openMenu();

      // `variant` is the ONLY prop the wrapper adds to the primitive's item, and the unit
      // mirrors it onto the element as `data-variant` expressly so a test can confirm the
      // treatment reached the DOM without reading a class name. This asserts the FORWARDING of
      // that prop and makes no claim about colour: the default rows carry the default value,
      // the destructive row carries its own.
      expect(within(menu).getByRole('menuitem', { name: DELETE_ACTION })).toHaveAttribute(
        'data-variant',
        'destructive',
      );
      expect(within(menu).getByRole('menuitem', { name: EDIT_ACTION })).toHaveAttribute(
        'data-variant',
        'default',
      );
    });

    it('exposes a disabled action as disabled and refuses to activate it', async () => {
      const spies = renderRowActions({ statusChangeDisabled: true });
      await openMenu();

      const statusAction = screen.getByRole('menuitem', { name: STATUS_ACTION });

      // The primitive turns `disabled` into `aria-disabled`, which is the only form assistive
      // technology can read on a `role="menuitem"` element - a `div` cannot carry the HTML
      // `disabled` attribute, which is also why jest-dom's `toBeDisabled` is not the matcher
      // for this. The enabled sibling is asserted too, so the attribute is shown to be a
      // consequence of the prop rather than something every row happens to carry.
      expect(statusAction).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByRole('menuitem', { name: EDIT_ACTION })).not.toHaveAttribute(
        'aria-disabled',
      );

      fireEvent.click(statusAction);
      fireEvent.keyDown(statusAction, { key: 'Enter' });

      // Neither route activates it, and the menu is still open - a disabled row must be inert,
      // not a quiet way to dismiss the menu.
      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeVisible();
      });
      expectNoActionRan(spies);
    });
  });

  describe('keyboard', () => {
    it('focuses the first action when the menu is opened from the keyboard', async () => {
      renderRowActions();
      await openMenu();

      // Awaited, because the primitive moves focus on a later tick; a synchronous assertion
      // here reads the pre-focus state and would report a false failure.
      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: EDIT_ACTION })).toHaveFocus();
      });
    });

    it('moves the highlight with the arrow keys and steps over a disabled action', async () => {
      renderRowActions({ statusChangeDisabled: true });
      await openMenu();

      const editAction = screen.getByRole('menuitem', { name: EDIT_ACTION });
      const deleteAction = screen.getByRole('menuitem', { name: DELETE_ACTION });

      await waitFor(() => {
        expect(editAction).toHaveFocus();
      });

      // One ArrowDown lands on the DESTRUCTIVE row rather than the disabled one between them:
      // roving focus is working AND the disabled row is out of traversal. Two guarantees in one
      // keystroke, and the pair is what makes a disabled row genuinely unreachable rather than
      // merely dimmed.
      fireEvent.keyDown(editAction, { key: 'ArrowDown' });
      await waitFor(() => {
        expect(deleteAction).toHaveFocus();
      });

      // And back again, so the traversal is not one-directional.
      fireEvent.keyDown(deleteAction, { key: 'ArrowUp' });
      await waitFor(() => {
        expect(editAction).toHaveFocus();
      });
    });

    it('activates the focused action with Enter', async () => {
      const spies = renderRowActions();
      await openMenu();

      const editAction = screen.getByRole('menuitem', { name: EDIT_ACTION });
      await waitFor(() => {
        expect(editAction).toHaveFocus();
      });

      fireEvent.keyDown(editAction, { key: 'Enter' });

      // `onSelect` - not `onClick` - is the hook the unit documents, and it must fire for
      // keyboard activation as well as for pointer activation. A wrapper that reached for
      // `onClick` would pass the pointer case above and fail this one.
      await waitFor(() => {
        expect(spies.editPost).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(screen.queryByRole('menu')).toBeNull();
      });
    });

    it('jumps to an action by typeahead', async () => {
      renderRowActions();
      await openMenu();

      const editAction = screen.getByRole('menuitem', { name: EDIT_ACTION });
      await waitFor(() => {
        expect(editAction).toHaveFocus();
      });

      // Typing a character moves the highlight to the first row whose label starts with it -
      // "d" for "Delete post". Asserted because it IS drivable here, and because it is one more
      // behaviour a wrapper that added its own `onKeyDown` to the item would silently break.
      fireEvent.keyDown(editAction, { key: 'd' });

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: DELETE_ACTION })).toHaveFocus();
      });
    });

    it('dismisses on Escape without invoking any action handler', async () => {
      // THE most important case in this file. Every irreversible action in the admin dashboard
      // is reached through this menu, so a wrapper that conflated dismissal with selection
      // would let an administrator delete a record by pressing Escape - and every role, name
      // and styling assertion in this suite would still pass. Escape is fired on the FOCUSED
      // row, which is the state a real dismissal happens from and the one where a confusion
      // between "dismiss" and "activate the highlighted row" would actually surface.
      const spies = renderRowActions();
      await openMenu();

      const editAction = screen.getByRole('menuitem', { name: EDIT_ACTION });
      await waitFor(() => {
        expect(editAction).toHaveFocus();
      });

      fireEvent.keyDown(editAction, { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByRole('menu')).toBeNull();
      });
      expectNoActionRan(spies);
      expect(getTrigger()).toHaveAttribute('aria-expanded', 'false');
    });

    it('returns focus to the trigger after the menu is dismissed', async () => {
      renderRowActions();
      await openMenu();

      const editAction = screen.getByRole('menuitem', { name: EDIT_ACTION });
      await waitFor(() => {
        expect(editAction).toHaveFocus();
      });

      fireEvent.keyDown(editAction, { key: 'Escape' });

      // Focus restoration is the difference between a dismissable menu and a keyboard trap:
      // without it, focus is left on a node that has just been removed from the document and
      // the next Tab restarts from the top of the page.
      await waitFor(() => {
        expect(getTrigger()).toHaveFocus();
      });
    });
  });

  describe('selection state', () => {
    it('exposes each option as a checkable menu item with the current one checked', async () => {
      renderThemeMenu();

      const menu = await openThemeMenu();

      // Every option is present and named, and the group states WHICH one is active. That is
      // the whole reason these two parts exist rather than a cycling button: the selection is
      // announced rather than inferred.
      for (const option of THEME_OPTIONS) {
        expect(within(menu).getByRole('menuitemradio', { name: option.label })).toBeVisible();
      }
      expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(THEME_OPTIONS.length);

      const currentOption = within(menu).getByRole('menuitemradio', { name: CURRENT_THEME.label });
      const lightOption = within(menu).getByRole('menuitemradio', { name: LIGHT_THEME.label });
      const chosenOption = within(menu).getByRole('menuitemradio', { name: CHOSEN_THEME.label });

      expect(currentOption).toBeChecked();
      expect(lightOption).not.toBeChecked();
      expect(chosenOption).not.toBeChecked();

      // The tick the checked row paints is `aria-hidden`, because `aria-checked` already carries
      // the state - so the indicator must not add a second announcement, and the row's
      // accessible name has to stay the option's label alone.
      expect(currentOption).toHaveAccessibleName(CURRENT_THEME.label);
    });

    it('reports the option the reader chose', async () => {
      const onValueChange = renderThemeMenu();

      const menu = await openThemeMenu();
      fireEvent.click(within(menu).getByRole('menuitemradio', { name: CHOSEN_THEME.label }));

      // The value, not merely the fact of a click: a radio row that reported the wrong value
      // would switch the site to the wrong theme while every role assertion above still passed.
      await waitFor(() => {
        expect(onValueChange).toHaveBeenCalledWith(CHOSEN_THEME.value);
      });
      expect(onValueChange).toHaveBeenCalledTimes(1);
    });
  });
});
