/**
 * Component test for `src/components/ui/tabs.tsx` - the token-styled wrapper over
 * @radix-ui/react-tabs@1.1.21 that exports `Tabs`, `TabsList`, `TabsTrigger` and
 * `TabsContent`, and the primitive the author workspace uses to group a writer's own posts
 * by lifecycle state and the admin shell uses to switch sections.
 *
 * WHAT IS UNDER TEST HERE, AND WHAT IS DELIBERATELY NOT
 *
 * The wrapper authors no `role`, no `aria-*`, no `tabIndex` and no `onKeyDown` - it says so
 * itself, and the reason it may say so is that the primitive underneath supplies the whole
 * WAI-ARIA Tabs pattern: `role="tablist"` / `role="tab"` / `role="tabpanel"`, `aria-selected`
 * on the active trigger, the `aria-controls` / `aria-labelledby` pairing between a trigger and
 * its panel, and the roving-focus keyboard model. That inheritance is exactly what this file
 * checks. A wrapper that quietly dropped the primitive - reimplementing the list over plain
 * buttons, say - would still look identical and would still pass any styling assertion, and
 * these tests are what would fail instead.
 *
 * So the contract asserted below is roles, accessible names, ARIA relationships, focus and
 * selection state. There is deliberately NO assertion about appearance: no `toHaveClass`, no
 * `className` read, no class-based `querySelector`, no `getComputedStyle` and no snapshot.
 * Class names belong to the token layer (`src/app/globals.css` maps every semantic token, and
 * dark mode is a second value for each one), so a palette edit or a token rename must not be
 * able to fail this suite. Concretely: the active tab is asserted through
 * `aria-selected="true"` - never through the raised `--color-surface` panel that also marks
 * it, and never through `data-state="active"`, which exists for the stylesheet's benefit where
 * `aria-selected` is the state a screen reader is actually told about. Likewise the focus
 * checks use `toHaveFocus()`; the `--color-ring` outline that makes focus visible is a token
 * and is not this file's business.
 *
 * THREE MEASURED FACTS ABOUT THE PRIMITIVE THAT SHAPE THE TESTS
 *
 *   1. Selection commits on POINTER DOWN. The primitive's trigger listens on `onMouseDown`
 *      (plus Enter/Space, plus focus under automatic activation) and not on `click`. Measured
 *      against the installed 1.1.21: dispatching only a `click` leaves `aria-selected`
 *      unchanged. `clickTab` below therefore fires the full mousedown -> mouseup -> click
 *      sequence a real pointer produces, so the assertions that follow it are about the
 *      component rather than about a no-op. `@testing-library/user-event` would model this for
 *      us, but it is not in the declared dependency set, and this tier's dependencies are
 *      exact pins - so `fireEvent` it is.
 *   2. Arrow-key focus movement is DEFERRED. The roving-focus group moves focus inside a
 *      `setTimeout`, so the new tab is not focused on the line after `fireEvent.keyDown`.
 *      Those assertions are wrapped in `waitFor`, and they always wait for the state that is
 *      about to become true (the NEW tab holding focus) rather than the one that already is -
 *      waiting on a condition that already holds passes on the first poll and proves nothing.
 *   3. Unselected panels stay MOUNTED BUT EMPTY. The primitive keeps every panel element in
 *      the document, marks the inactive ones with the `hidden` attribute and renders no
 *      children into them. Both halves are asserted, because both matter: `hidden` is what
 *      keeps the panel out of the accessibility tree, and the stripped children are what keep
 *      a draft count out of the page for anyone reading the DOM. That is why an inactive
 *      panel's text is queried with `queryByText`, while the panel elements themselves are
 *      counted with the `hidden: true` escape hatch.
 *
 * The tab values are the real `PostStatus` union, imported type-only from `@/lib/types`, not a
 * set of stand-in strings. That makes this file a lifecycle contract check as well as a widget
 * check: the author workspace groups posts by exactly these three states, `onValueChange` has
 * to hand back the status LITERAL (which the caller feeds straight into a query filter) rather
 * than the human label, and if the union ever gains or loses a member the exhaustive label and
 * panel-text maps below stop compiling here instead of silently under-covering.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { PostStatus } from '@/lib/types';

/**
 * The three lifecycle states, in the order the dashboard lists them.
 *
 * Typed as the product's own union rather than `string[]`, so a value that is not a real
 * status fails `tsc --noEmit` in this file. No cast is involved: each member is a literal the
 * union already admits.
 */
const statuses: readonly PostStatus[] = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];

/**
 * The accessible name each trigger carries. `Record<PostStatus, string>` is exhaustive, so
 * adding a fourth lifecycle state to the union is a compile error here rather than a tab that
 * silently never gets exercised.
 */
const tabLabels: Record<PostStatus, string> = {
  DRAFT: 'Drafts',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
};

/**
 * Distinct text per panel, so "the right panel is showing" can be asserted on visible content
 * instead of on markup. Exhaustive for the same reason as {@link tabLabels}.
 */
const panelText: Record<PostStatus, string> = {
  DRAFT: '3 drafts',
  PUBLISHED: '12 published posts',
  ARCHIVED: '1 archived post',
};

/**
 * Narrows the primitive's `string` callback argument to a `PostStatus`, the way a real
 * consumer must: the dashboard cannot pass a bare `string` to a status-filtered query.
 *
 * Deriving the guard from {@link statuses} keeps it cast-free - `find` returns
 * `PostStatus | undefined`, and the union is recovered by ruling out `undefined`. It also
 * makes the controlled harness an assertion in its own right: if the primitive ever reported
 * the display label instead of the value, this would throw inside the change handler and the
 * test would fail loudly rather than quietly comparing two strings that are both wrong.
 */
function toPostStatus(value: string): PostStatus {
  const status = statuses.find((candidate) => candidate === value);
  if (status === undefined) {
    throw new Error(`Tabs reported ${JSON.stringify(value)}, which is not a PostStatus`);
  }
  return status;
}

/**
 * Presses a trigger the way a pointer does: `mousedown`, `mouseup`, then `click`.
 *
 * The `mousedown` is the load-bearing one - see fact 1 in the file header. `mouseup` and
 * `click` are fired too so the sequence stays a faithful model of a real press rather than a
 * minimal poke at the one handler that happens to be listening today.
 */
function clickTab(tab: HTMLElement): void {
  fireEvent.mouseDown(tab);
  fireEvent.mouseUp(tab);
  fireEvent.click(tab);
}

/**
 * Moves focus to an element the way the browser would, inside `act` so the state updates the
 * primitive performs on focus are flushed before the next assertion runs. `fireEvent.focus`
 * would dispatch the event without moving `document.activeElement`, which would leave
 * `toHaveFocus()` asserting nothing.
 */
function focusElement(element: HTMLElement): void {
  act(() => {
    element.focus();
  });
}

/** The triggers and panels shared by both harnesses, one per lifecycle state. */
function StatusTabsBody({ disabledStatus }: { disabledStatus?: PostStatus }) {
  return (
    <>
      <TabsList>
        {statuses.map((status) => (
          <TabsTrigger key={status} value={status} disabled={status === disabledStatus}>
            {tabLabels[status]}
          </TabsTrigger>
        ))}
      </TabsList>
      {statuses.map((status) => (
        <TabsContent key={status} value={status}>
          {panelText[status]}
        </TabsContent>
      ))}
    </>
  );
}

/**
 * Uncontrolled harness - the shape the author workspace uses when it just needs a landing
 * tab. `onValueChange` is typed `(value: string) => void` because that is the primitive's own
 * signature; the tests are what pin the runtime value to a lifecycle literal.
 */
function StatusTabs({
  defaultValue = 'PUBLISHED',
  disabledStatus,
  onValueChange,
}: {
  defaultValue?: PostStatus;
  disabledStatus?: PostStatus;
  onValueChange?: (value: string) => void;
}) {
  return (
    <Tabs defaultValue={defaultValue} onValueChange={onValueChange}>
      <StatusTabsBody disabledStatus={disabledStatus} />
    </Tabs>
  );
}

/**
 * Controlled harness - the shape a consumer uses when the selected status also drives
 * something else, such as the query the dashboard runs. State is held as a `PostStatus`, so
 * the narrowing guard is exercised on every change exactly as it would be in production.
 */
function ControlledStatusTabs({
  initialStatus,
  onStatusChange,
}: {
  initialStatus: PostStatus;
  onStatusChange?: (status: PostStatus) => void;
}) {
  const [status, setStatus] = useState<PostStatus>(initialStatus);

  return (
    <Tabs
      value={status}
      onValueChange={(value) => {
        const next = toPostStatus(value);
        setStatus(next);
        onStatusChange?.(next);
      }}
    >
      <StatusTabsBody />
    </Tabs>
  );
}

describe('Tabs', () => {
  describe('roles and relationships', () => {
    it('exposes one tablist, one tab per lifecycle state and a single panel', () => {
      render(<StatusTabs />);

      const list = screen.getByRole('tablist');
      expect(list).toBeInTheDocument();
      // Orientation is announced rather than merely styled, which is what lets assistive
      // technology describe the arrow keys that move between the tabs.
      expect(list).toHaveAttribute('aria-orientation', 'horizontal');

      // Three lifecycle states, so three tabs. Pinning the cardinality is what stops every
      // `for` loop and `statuses.length` comparison in this file from passing vacuously were
      // the array ever emptied.
      expect(statuses).toHaveLength(3);
      expect(screen.getAllByRole('tab')).toHaveLength(statuses.length);

      // One panel, not three: `getAllByRole` reads the accessibility tree, and the primitive
      // marks the two unselected panels `hidden`, which excludes them from it.
      expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    });

    it('gives every trigger the accessible name a screen reader announces', () => {
      render(<StatusTabs />);

      for (const status of statuses) {
        const tab = screen.getByRole('tab', { name: tabLabels[status] });
        expect(tab).toHaveAccessibleName(tabLabels[status]);
      }
    });

    it('selects exactly one tab, and it is the one named by defaultValue', () => {
      render(<StatusTabs defaultValue="PUBLISHED" />);

      const selected = screen
        .getAllByRole('tab')
        .filter((tab) => tab.getAttribute('aria-selected') === 'true');
      expect(selected).toHaveLength(1);

      expect(screen.getByRole('tab', { name: tabLabels.PUBLISHED })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByRole('tab', { name: tabLabels.DRAFT })).toHaveAttribute(
        'aria-selected',
        'false',
      );
      expect(screen.getByRole('tab', { name: tabLabels.ARCHIVED })).toHaveAttribute(
        'aria-selected',
        'false',
      );

      // The selection and the visible panel agree - `defaultValue` is not just an attribute.
      expect(within(screen.getByRole('tabpanel')).getByText(panelText.PUBLISHED)).toBeVisible();
    });

    it('pairs the selected tab with its panel through aria-controls and aria-labelledby', () => {
      render(<StatusTabs defaultValue="PUBLISHED" />);

      const tab = screen.getByRole('tab', { name: tabLabels.PUBLISHED });
      const panel = screen.getByRole('tabpanel');

      // Both ends of the pairing need a real id before matching them proves anything: two
      // empty strings would compare equal and assert nothing at all.
      expect(tab.id).not.toBe('');
      expect(panel.id).not.toBe('');

      // Forward: the trigger names the panel it controls.
      expect(tab).toHaveAttribute('aria-controls', panel.id);
      // Back: the panel names the trigger that labels it.
      expect(panel).toHaveAttribute('aria-labelledby', tab.id);
      // And the pairing is functional rather than merely present - the panel takes its
      // accessible name from the trigger, which is how a reader announces the region it has
      // just moved into.
      expect(panel).toHaveAccessibleName(tabLabels.PUBLISHED);
    });

    it('pairs every tab with a panel, including the states not on screen', () => {
      render(<StatusTabs defaultValue="PUBLISHED" />);

      // `hidden: true` reaches past the accessibility tree on purpose here: the point of this
      // case is that all three panel elements exist and are individually addressable, not that
      // all three are exposed - the very next case asserts that they are not.
      const panelIds = screen.getAllByRole('tabpanel', { hidden: true }).map((panel) => panel.id);
      expect(panelIds).toHaveLength(statuses.length);

      for (const status of statuses) {
        const controls = screen
          .getByRole('tab', { name: tabLabels[status] })
          .getAttribute('aria-controls');
        expect(controls).not.toBeNull();
        expect(panelIds).toContain(controls);
      }
    });

    it('keeps the unselected panels out of the accessibility tree and empty of content', () => {
      render(<StatusTabs defaultValue="PUBLISHED" />);

      // Mounted: three panel elements in the document...
      expect(screen.getAllByRole('tabpanel', { hidden: true })).toHaveLength(statuses.length);
      // ...but exposed: one. The `hidden` attribute on the other two removes them from the
      // accessibility tree, so a reader cannot land in a panel that is not on screen.
      expect(screen.getAllByRole('tabpanel')).toHaveLength(1);

      // And their content is not merely hidden, it is not rendered - so an unpublished draft
      // count is absent from the document rather than one CSS rule away from being read.
      expect(screen.queryByText(panelText.DRAFT)).toBeNull();
      expect(screen.queryByText(panelText.ARCHIVED)).toBeNull();
      expect(screen.getByText(panelText.PUBLISHED)).toBeVisible();
    });

    it('lets a keyboard user move focus into the exposed panel', () => {
      render(<StatusTabs />);

      // The primitive gives the panel a tab stop of its own, so Tab from the active trigger
      // reaches the panel's content directly. Asserted behaviourally - the panel accepts
      // focus - rather than by reading the `tabindex` attribute off it.
      const panel = screen.getByRole('tabpanel');
      focusElement(panel);
      expect(panel).toHaveFocus();
    });
  });

  describe('switching', () => {
    it('moves the selection and the exposed panel when another tab is pressed', () => {
      render(<StatusTabs defaultValue="PUBLISHED" />);

      clickTab(screen.getByRole('tab', { name: tabLabels.DRAFT }));

      expect(screen.getByRole('tab', { name: tabLabels.DRAFT })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByRole('tab', { name: tabLabels.PUBLISHED })).toHaveAttribute(
        'aria-selected',
        'false',
      );

      // Still exactly one panel, and it is the new one.
      expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
      expect(within(screen.getByRole('tabpanel')).getByText(panelText.DRAFT)).toBeVisible();
      expect(screen.queryByText(panelText.PUBLISHED)).toBeNull();
    });

    it('activates the tab that ArrowRight moves focus to', async () => {
      render(<StatusTabs defaultValue="PUBLISHED" />);

      const published = screen.getByRole('tab', { name: tabLabels.PUBLISHED });
      focusElement(published);
      expect(published).toHaveFocus();

      fireEvent.keyDown(published, { key: 'ArrowRight' });

      // Deferred focus move - see fact 2 in the file header. The wait is on the tab that is
      // about to take focus, so the poll cannot succeed before the primitive has acted.
      const archived = screen.getByRole('tab', { name: tabLabels.ARCHIVED });
      await waitFor(() => {
        expect(archived).toHaveFocus();
      });

      // Automatic activation: arriving is selecting, so a keyboard user never has to press a
      // second key to see the panel they moved to.
      expect(archived).toHaveAttribute('aria-selected', 'true');
      expect(published).toHaveAttribute('aria-selected', 'false');
      expect(within(screen.getByRole('tabpanel')).getByText(panelText.ARCHIVED)).toBeVisible();
      expect(screen.queryByText(panelText.PUBLISHED)).toBeNull();
    });

    it('activates the tab that ArrowLeft moves focus to', async () => {
      render(<StatusTabs defaultValue="PUBLISHED" />);

      const published = screen.getByRole('tab', { name: tabLabels.PUBLISHED });
      focusElement(published);

      fireEvent.keyDown(published, { key: 'ArrowLeft' });

      const drafts = screen.getByRole('tab', { name: tabLabels.DRAFT });
      await waitFor(() => {
        expect(drafts).toHaveFocus();
      });

      expect(drafts).toHaveAttribute('aria-selected', 'true');
      expect(within(screen.getByRole('tabpanel')).getByText(panelText.DRAFT)).toBeVisible();
    });

    it('jumps to the last and first tab on End and Home', async () => {
      render(<StatusTabs defaultValue="PUBLISHED" />);

      const published = screen.getByRole('tab', { name: tabLabels.PUBLISHED });
      focusElement(published);

      fireEvent.keyDown(published, { key: 'End' });
      const archived = screen.getByRole('tab', { name: tabLabels.ARCHIVED });
      await waitFor(() => {
        expect(archived).toHaveFocus();
      });
      expect(archived).toHaveAttribute('aria-selected', 'true');

      fireEvent.keyDown(archived, { key: 'Home' });
      const drafts = screen.getByRole('tab', { name: tabLabels.DRAFT });
      await waitFor(() => {
        expect(drafts).toHaveFocus();
      });
      expect(drafts).toHaveAttribute('aria-selected', 'true');
      expect(within(screen.getByRole('tabpanel')).getByText(panelText.DRAFT)).toBeVisible();
    });

    it('reports the PostStatus literal to onValueChange rather than the visible label', () => {
      const onValueChange = vi.fn<(value: string) => void>();
      render(<StatusTabs defaultValue="PUBLISHED" onValueChange={onValueChange} />);

      clickTab(screen.getByRole('tab', { name: tabLabels.ARCHIVED }));

      // The literal is what a caller feeds to a status-filtered query, so it is the value that
      // has to come back - typed here as a `PostStatus` so a drift in the union is a compile
      // error in this expectation and not a silently passing assertion.
      const expected: PostStatus = 'ARCHIVED';
      expect(onValueChange).toHaveBeenCalledTimes(1);
      expect(onValueChange).toHaveBeenCalledWith(expected);
      expect(onValueChange).not.toHaveBeenCalledWith(tabLabels.ARCHIVED);
    });
  });

  describe('controlled mode', () => {
    it('exposes the panel named by the value prop with no interaction at all', () => {
      render(<ControlledStatusTabs initialStatus="ARCHIVED" />);

      expect(screen.getByRole('tab', { name: tabLabels.ARCHIVED })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(within(screen.getByRole('tabpanel')).getByText(panelText.ARCHIVED)).toBeVisible();
      expect(screen.queryByText(panelText.PUBLISHED)).toBeNull();
      expect(screen.queryByText(panelText.DRAFT)).toBeNull();
    });

    it('round-trips a change through a consumer holding PostStatus state', () => {
      const onStatusChange = vi.fn<(status: PostStatus) => void>();
      render(<ControlledStatusTabs initialStatus="DRAFT" onStatusChange={onStatusChange} />);

      clickTab(screen.getByRole('tab', { name: tabLabels.PUBLISHED }));

      // Reaching this line at all means the narrowing guard accepted the reported value: it
      // throws on anything outside the union, and the throw would surface as a failure here.
      const expected: PostStatus = 'PUBLISHED';
      expect(onStatusChange).toHaveBeenCalledTimes(1);
      expect(onStatusChange).toHaveBeenCalledWith(expected);

      // The panel followed the consumer's state, which only happens if `value` and
      // `onValueChange` complete the loop - a controlled tab set that ignored `value` would
      // still have moved its own selection and would pass a naive assertion.
      expect(screen.getByRole('tab', { name: tabLabels.PUBLISHED })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(within(screen.getByRole('tabpanel')).getByText(panelText.PUBLISHED)).toBeVisible();
      expect(screen.queryByText(panelText.DRAFT)).toBeNull();
    });
  });

  describe('a disabled trigger', () => {
    it('is exposed as disabled and ignores a press', () => {
      const onValueChange = vi.fn<(value: string) => void>();
      render(
        <StatusTabs
          defaultValue="PUBLISHED"
          disabledStatus="ARCHIVED"
          onValueChange={onValueChange}
        />,
      );

      // The primitive renders a real `<button>`, so unavailability is the native `disabled`
      // state rather than an `aria-disabled` annotation.
      const archived = screen.getByRole('tab', { name: tabLabels.ARCHIVED });
      expect(archived).toBeDisabled();

      clickTab(archived);

      expect(archived).toHaveAttribute('aria-selected', 'false');
      expect(screen.getByRole('tab', { name: tabLabels.PUBLISHED })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(within(screen.getByRole('tabpanel')).getByText(panelText.PUBLISHED)).toBeVisible();
      expect(onValueChange).not.toHaveBeenCalled();
    });

    it('is skipped by arrow navigation', async () => {
      render(<StatusTabs defaultValue="PUBLISHED" disabledStatus="ARCHIVED" />);

      const published = screen.getByRole('tab', { name: tabLabels.PUBLISHED });
      focusElement(published);

      fireEvent.keyDown(published, { key: 'ArrowRight' });

      // ARCHIVED sits immediately to the right but is not focusable, and the list loops by
      // default, so focus passes over it and wraps round to the first tab instead.
      const drafts = screen.getByRole('tab', { name: tabLabels.DRAFT });
      await waitFor(() => {
        expect(drafts).toHaveFocus();
      });

      expect(drafts).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: tabLabels.ARCHIVED })).toHaveAttribute(
        'aria-selected',
        'false',
      );
      expect(screen.queryByText(panelText.ARCHIVED)).toBeNull();
    });
  });
});
