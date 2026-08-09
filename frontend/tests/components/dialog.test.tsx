/**
 * Component tests for `src/components/ui/dialog.tsx` - the modal surface of the
 * design system layer.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY IGNORES
 *
 * The unit under test is a token-only wrapper over `@radix-ui/react-dialog`.
 * The primitive owns every behaviour a modal needs - the focus trap, focus
 * restoration to the trigger, `Escape` dismissal, outside-press dismissal,
 * scroll locking, `role="dialog"`, and the `aria-labelledby` /
 * `aria-describedby` wiring between the panel and its title and description -
 * and the wrapper adds a scrim, a panel, type treatments and a named corner
 * close affordance on top.
 *
 * So the job here is NOT to re-test Radix. It is to prove the wrapper did not
 * break what Radix provides, because focus trapping, escape handling and ARIA
 * wiring are precisely what a hand-rolled modal gets wrong. That is why every
 * assertion below targets a ROLE, an ACCESSIBLE NAME, a FOCUS POSITION or a
 * DISMISSAL, and none targets the thing the wrapper actually contributes.
 *
 * This is the unit-level half of the keyboard criterion "modal focus is trapped
 * and escape closes it". Both halves are covered here and both are real rather
 * than vacuous - see the note on Tab below.
 *
 * NO CLASS NAMES, NO COMPUTED STYLE, NO SNAPSHOTS. The wrapper's whole
 * contribution is a translucent scrim, a `surface` panel with a `border`
 * hairline, a radius and an elevation, and every one of those resolves to a
 * token in `src/app/globals.css`. The token layer is free to change - a palette
 * edit, a radius bump, a rename - and a test that pinned any of it would fail on
 * a change that broke nothing. There is therefore no `toHaveClass`, no
 * `className` read, no class-based `querySelector`, no `getComputedStyle` and no
 * snapshot anywhere in this file, and none should be added. Scroll locking is
 * likewise unasserted: jsdom has no scrollbar to lock.
 *
 * Responsiveness is also out of scope here. The navigation drawer consumes this
 * dialog only below the `md` (48rem) breakpoint, but jsdom applies no media
 * query, so that behaviour belongs to the Playwright suite at a 375px viewport
 * rather than to any assertion below.
 *
 * ---------------------------------------------------------------------------
 * THE PANEL IS PORTALLED - REACH IT THROUGH `screen`
 *
 * `DialogContent` renders its own portal, so the panel mounts at the end of
 * `document.body` and NOT inside the container `render` returns. Queries
 * therefore go through `screen` (which searches `document.body`) rather than
 * through the render result, and the panel is awaited with
 * `findByRole('dialog')` rather than grabbed synchronously: opening is a state
 * update whose portal subtree lands on a later tick, and a synchronous
 * `getByRole` is the classic intermittent failure here.
 *
 * ---------------------------------------------------------------------------
 * `aria-modal` IS ABSENT, AND THAT IS THE CORRECT BEHAVIOUR
 *
 * The obvious assertion for a modal is `aria-modal="true"`, and it would fail.
 * Measured against the installed `@radix-ui/react-dialog@1.1.23`: there are ZERO
 * occurrences of `aria-modal` in the compiled package, and the open panel
 * carries exactly `role`, `id`, `data-state`, `tabindex="-1"`,
 * `aria-labelledby` and `aria-describedby`. Radix conveys modality the
 * better-supported way instead, by applying `aria-hidden="true"` to every other
 * child of `document.body` while the dialog is open.
 *
 * This file pins that contract from both ends: the panel must NOT grow a
 * hand-written `aria-modal` (which would double up on a signal already
 * conveyed), and the rest of the page must genuinely leave the accessibility
 * tree while the dialog is open and return to it afterwards. The second half is
 * asserted at the level that matters to a screen reader - the trigger stops
 * being reachable by role - rather than only as an attribute.
 *
 * ---------------------------------------------------------------------------
 * `fireEvent`, NOT `userEvent` - AND WHY THE Tab CASE IS STILL HONEST
 *
 * `@testing-library/user-event` is not a declared dependency of this tier, and
 * the dependency story here is exact pins rather than convenient additions, so
 * every interaction below is a `fireEvent`.
 *
 * That normally rules out testing a focus trap, because jsdom implements no
 * native sequential focus navigation: a synthesised Tab moves nothing, so an
 * assertion that focus "stayed inside" would pass whether or not a trap
 * existed. It does not rule it out here, and the reason is specific. Radix's
 * focus scope does not rely on the browser's Tab handling at all - it intercepts
 * the `keydown` itself and calls `focus()` on the opposite edge of the panel.
 * Verified against the installed version: with focus on the LAST tabbable
 * control, a synthesised Tab moves focus to the FIRST one, and Shift+Tab from
 * the first moves it to the last. Both are real state changes with observable
 * before-and-after positions, so the cases below cannot pass vacuously.
 *
 * What remains genuinely unobservable in jsdom is what a real browser does with
 * a Tab the scope does NOT intercept - a press in the middle of the panel, where
 * the trap is not the thing being exercised. That is covered by the Playwright
 * admin journey, which carries the modal-focus obligation in a real browser.
 *
 * ---------------------------------------------------------------------------
 * NO NETWORK
 *
 * The unit under test performs no data access - it has no state, no effect and
 * no fetch of its own - so this file starts no request-interception server and
 * issues no HTTP. The component suite errors on any unhandled request, which is
 * exactly the signal wanted if that ever stops being true.
 *
 * The jest-dom matchers and the between-test unmount are both registered by
 * `vitest.setup.ts`, so neither is imported or invoked again here.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

/* -------------------------------------------------------------------------- */
/* Copy                                                                       */
/* -------------------------------------------------------------------------- */

/*
 * Realistic copy from the surfaces that actually consume this primitive: the
 * destructive confirmations shown before a post, a comment or a user is
 * removed. Held in constants so a query and the element it resolves to can
 * never drift apart, and so the accessible-name assertions read against the
 * same string the harness renders.
 */

/** Label of the control that opens the confirmation. */
const TRIGGER_LABEL = 'Delete post';

/** Heading inside the panel. Radix derives the dialog's accessible name from it. */
const DIALOG_TITLE = 'Delete this post?';

/** Supporting copy. Radix points `aria-describedby` at it. */
const DIALOG_DESCRIPTION = 'This will permanently remove the post and its comments and likes.';

/**
 * A `DialogClose` rendered in the panel BODY by the caller - the "Cancel" half
 * of a confirmation. Distinct from the corner affordance below, which
 * `DialogContent` renders for itself.
 */
const CANCEL_LABEL = 'Keep the post';

/**
 * Accessible name of the corner dismiss control. It comes from the visually
 * hidden label the wrapper renders beside the icon, which is the point: the
 * glyph itself is hidden from assistive technology, so a nameless control here
 * would be a real accessibility defect rather than a cosmetic one.
 */
const CLOSE_AFFORDANCE_LABEL = 'Close';

/** Copy for the second, admin-flavoured confirmation used by the controlled harnesses. */
const REMOVE_USER_TRIGGER_LABEL = 'Remove user';
const REMOVE_USER_TITLE = 'Remove this user?';
const REMOVE_USER_DESCRIPTION = 'Their posts, comments and likes are removed with them.';
const REMOVE_USER_CANCEL_LABEL = 'Keep the user';

/** Marker rendered inside a hand-composed scrim, to observe where the portal put it. */
const HAND_COMPOSED_MARKER = 'Hand-composed overlay subtree';

/* -------------------------------------------------------------------------- */
/* Harnesses                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The uncontrolled shape, and the one almost every caller uses: a trigger plus
 * a `DialogContent` holding a title, a description and a body-level dismiss
 * control.
 *
 * Note what is NOT here. `DialogContent` renders its own portal, its own
 * overlay and its own corner close affordance, so composing `DialogPortal` or
 * `DialogOverlay` around it would stack a second scrim over the first. The
 * hand-composed case at the end of this file is the only place those two parts
 * appear, which is the only place they belong.
 */
function ConfirmDeletePostDialog() {
  return (
    <Dialog>
      <DialogTrigger>{TRIGGER_LABEL}</DialogTrigger>
      <DialogContent>
        <DialogTitle>{DIALOG_TITLE}</DialogTitle>
        <DialogDescription>{DIALOG_DESCRIPTION}</DialogDescription>
        <DialogClose>{CANCEL_LABEL}</DialogClose>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A FULLY controlled harness: `open` is whatever the caller passes and is never
 * derived from state, so the panel cannot close itself.
 *
 * That is the point of it. A dismissal here is expected to report through
 * `onOpenChange` and otherwise change nothing, which is the behaviour a consumer
 * relies on when it needs to run work - a delete request, a confirmation toast -
 * between the intent to close and the close itself.
 *
 * @param open - Whether the panel is shown. Fixed by the caller, never internal.
 * @param onOpenChange - Notified with the requested next state.
 */
function FullyControlledRemoveUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (nextOpen: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger>{REMOVE_USER_TRIGGER_LABEL}</DialogTrigger>
      <DialogContent>
        <DialogTitle>{REMOVE_USER_TITLE}</DialogTitle>
        <DialogDescription>{REMOVE_USER_DESCRIPTION}</DialogDescription>
        <DialogClose>{REMOVE_USER_CANCEL_LABEL}</DialogClose>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The other controlled shape, and the realistic one: the parent holds the open
 * state and applies what `onOpenChange` reports, so a dismissal does close the
 * panel. This is what an admin row action looks like.
 *
 * @param onOpenChange - Observed alongside the state update, so a test can check
 *   both the report and its effect from the same interaction.
 */
function StatefulRemoveUserDialog({ onOpenChange }: { onOpenChange: (nextOpen: boolean) => void }) {
  const [open, setOpen] = useState(true);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        onOpenChange(nextOpen);
      }}
    >
      <DialogTrigger>{REMOVE_USER_TRIGGER_LABEL}</DialogTrigger>
      <DialogContent>
        <DialogTitle>{REMOVE_USER_TITLE}</DialogTitle>
        <DialogDescription>{REMOVE_USER_DESCRIPTION}</DialogDescription>
        <DialogClose>{REMOVE_USER_CANCEL_LABEL}</DialogClose>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Open the uncontrolled confirmation and hand back its panel.
 *
 * The `await findByRole` is load-bearing rather than stylistic: the panel is
 * portalled, so it appears on a later tick than the click that requested it.
 *
 * @returns The panel element, once it is in the accessibility tree.
 */
async function openConfirmation(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: TRIGGER_LABEL }));

  return screen.findByRole('dialog');
}

/**
 * Wait until no dialog is exposed any more.
 *
 * Closing unmounts a portalled subtree, so the disappearance is asynchronous
 * too. `waitFor` is used rather than a timer: nothing here should be pinned to a
 * duration, and a `setTimeout` would be both slower and less reliable.
 */
async function expectDialogToBeGone(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
}

/* -------------------------------------------------------------------------- */
/* Suite                                                                      */
/* -------------------------------------------------------------------------- */

describe('Dialog', () => {
  describe('opening and closing', () => {
    it('exposes only its trigger before it is opened', () => {
      render(<ConfirmDeletePostDialog />);

      // Nothing is rendered eagerly: no panel, and - just as importantly - no
      // panel content leaking into the page while closed. A confirmation whose
      // copy were readable before it opened would announce a destructive action
      // nobody had asked for yet.
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByText(DIALOG_TITLE)).toBeNull();
      expect(screen.queryByText(DIALOG_DESCRIPTION)).toBeNull();

      // The trigger, by contrast, is a real button with a real name.
      expect(screen.getByRole('button', { name: TRIGGER_LABEL })).toBeInTheDocument();
    });

    it('opens when its trigger is clicked', async () => {
      render(<ConfirmDeletePostDialog />);

      const dialog = await openConfirmation();

      expect(dialog).toBeInTheDocument();
      expect(dialog).toBeVisible();
    });

    it('closes when Escape is pressed', async () => {
      render(<ConfirmDeletePostDialog />);
      await openConfirmation();

      // Dispatched on the document because that is where the primitive listens,
      // and because it is the honest model of the interaction: a visitor presses
      // Escape without first aiming at anything.
      fireEvent.keyDown(document, { key: 'Escape' });

      await expectDialogToBeGone();
    });

    it('closes when Escape is pressed on the panel itself', async () => {
      render(<ConfirmDeletePostDialog />);
      const dialog = await openConfirmation();

      // The same press originating INSIDE the panel, which is where a real one
      // starts: opening moves focus into the panel, so the visitor's keystroke
      // has a descendant of the dialog as its target, not the document.
      //
      // What this case does NOT prove, stated because the obvious reading is
      // wrong: it is not a guard against a stray `stopPropagation` in the
      // wrapper. The primitive registers its keydown listener on the document
      // with `{ capture: true }`, so the press is handled on the way DOWN and no
      // descendant handler can suppress it. Verified by mutation - adding a
      // bubble-phase `stopPropagation` to the panel left all of these cases
      // green. A regression of that kind is a browser-level concern and belongs
      // to the Playwright suite.
      fireEvent.keyDown(dialog, { key: 'Escape' });

      await expectDialogToBeGone();
    });

    it('closes when the corner close affordance is clicked', async () => {
      render(<ConfirmDeletePostDialog />);
      const dialog = await openConfirmation();

      fireEvent.click(within(dialog).getByRole('button', { name: CLOSE_AFFORDANCE_LABEL }));

      await expectDialogToBeGone();
    });

    it('closes when a DialogClose control in the panel body is clicked', async () => {
      render(<ConfirmDeletePostDialog />);
      const dialog = await openConfirmation();

      // The caller-supplied dismiss control, as opposed to the one the wrapper
      // renders in the corner. Both must work; only the corner one is the
      // wrapper's own.
      fireEvent.click(within(dialog).getByRole('button', { name: CANCEL_LABEL }));

      await expectDialogToBeGone();
    });

    it('returns focus to the trigger after it closes', async () => {
      render(<ConfirmDeletePostDialog />);
      await openConfirmation();

      fireEvent.keyDown(document, { key: 'Escape' });
      await expectDialogToBeGone();

      // The other half of trapping focus is giving it back. Without this a
      // keyboard visitor who dismissed a confirmation would be returned to the
      // top of the document and have to navigate to the control they were
      // already on.
      expect(screen.getByRole('button', { name: TRIGGER_LABEL })).toHaveFocus();
    });

    it('can be reopened after being dismissed', async () => {
      render(<ConfirmDeletePostDialog />);

      await openConfirmation();
      fireEvent.keyDown(document, { key: 'Escape' });
      await expectDialogToBeGone();

      // Dismissal must be a state change rather than a teardown. This is the
      // case that fails if closing ever leaves the trigger detached from the
      // accessibility tree, or leaves a stale portal node behind that a second
      // open would duplicate.
      const reopened = await openConfirmation();

      expect(reopened).toHaveAccessibleName(DIALOG_TITLE);
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
    });
  });

  describe('accessibility wiring', () => {
    it('takes its accessible name from DialogTitle', async () => {
      render(<ConfirmDeletePostDialog />);

      const dialog = await openConfirmation();

      // The one obligation the wrapper pushes back onto callers, and the wiring
      // most easily broken by a wrapper that forgets to forward props: Radix
      // gives the title an id and points the panel's `aria-labelledby` at it.
      // Without this a screen reader announces an unnamed dialog.
      expect(dialog).toHaveAccessibleName(DIALOG_TITLE);

      // Asserted as a heading as well as a name, because the title is a real
      // `h2` rather than a styled span - which is what keeps the panel navigable
      // by heading and keeps the document outline intact.
      expect(within(dialog).getByRole('heading', { name: DIALOG_TITLE })).toBeInTheDocument();
    });

    it('takes its accessible description from DialogDescription', async () => {
      render(<ConfirmDeletePostDialog />);

      const dialog = await openConfirmation();

      // `aria-describedby` is what makes the consequence of a destructive action
      // audible at the moment the dialog is announced, rather than only on the
      // way down through its content.
      expect(dialog).toHaveAccessibleDescription(DIALOG_DESCRIPTION);
    });

    it('conveys modality by removing the rest of the page from the accessibility tree, not with aria-modal', async () => {
      render(<ConfirmDeletePostDialog />);

      const dialog = await openConfirmation();

      // Measured against the installed primitive: `aria-modal` appears nowhere in
      // it, deliberately. Its absence here is therefore the correct state, and
      // this assertion is what stops a well-meaning edit from adding one and
      // doubling up on a modality signal that is already being conveyed.
      expect(dialog).not.toHaveAttribute('aria-modal');

      // What is conveyed instead, checked where it counts: the trigger sat in the
      // accessibility tree a moment ago and is now unreachable by role, because
      // everything outside the panel has been hidden from assistive technology.
      expect(screen.queryByRole('button', { name: TRIGGER_LABEL })).toBeNull();

      // ...and the mechanism itself, so a regression points at its own cause
      // rather than only at the symptom above. Every top-level node that does not
      // contain the panel is hidden; the one that does is untouched.
      const nodesOutsideTheDialog = Array.from(document.body.children).filter(
        (node) => !node.contains(dialog),
      );
      expect(nodesOutsideTheDialog.length).toBeGreaterThan(0);
      nodesOutsideTheDialog.forEach((node) => {
        expect(node).toHaveAttribute('aria-hidden', 'true');
      });

      // Modality is scoped to the open state. If hiding the page were not undone
      // on close, the trigger would stay silently unreachable for the rest of the
      // session - a far worse defect than never hiding it at all.
      fireEvent.keyDown(document, { key: 'Escape' });
      await expectDialogToBeGone();

      expect(screen.getByRole('button', { name: TRIGGER_LABEL })).toBeInTheDocument();
    });

    it('moves focus into the panel when it opens', async () => {
      render(<ConfirmDeletePostDialog />);

      const dialog = await openConfirmation();

      // The general claim, and the one the keyboard criterion actually makes:
      // focus is somewhere inside the panel rather than left behind on the
      // trigger. `Node.contains` accepts a possibly-null argument, so this needs
      // no cast and cannot pass on a null active element - `document.activeElement`
      // is `body` at worst, which the panel does not contain.
      expect(dialog.contains(document.activeElement)).toBe(true);

      // The specific element, so a regression is legible rather than merely red:
      // the primitive sends focus to the first tabbable control in the panel,
      // which here is the caller's dismiss button.
      expect(within(dialog).getByRole('button', { name: CANCEL_LABEL })).toHaveFocus();
    });

    it('cycles focus from the last control in the panel back to the first', async () => {
      render(<ConfirmDeletePostDialog />);
      const dialog = await openConfirmation();

      const cancel = within(dialog).getByRole('button', { name: CANCEL_LABEL });
      const cornerClose = within(dialog).getByRole('button', {
        name: CLOSE_AFFORDANCE_LABEL,
      });

      // Start at the far edge of the panel, which is where a trap either holds or
      // fails. The focus scope intercepts the keydown itself rather than relying
      // on the browser's own Tab handling, which is why this is observable here.
      cornerClose.focus();
      expect(cornerClose).toHaveFocus();

      fireEvent.keyDown(cornerClose, { key: 'Tab' });

      expect(cancel).toHaveFocus();
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it('cycles focus backwards from the first control in the panel to the last', async () => {
      render(<ConfirmDeletePostDialog />);
      const dialog = await openConfirmation();

      const cancel = within(dialog).getByRole('button', { name: CANCEL_LABEL });
      const cornerClose = within(dialog).getByRole('button', {
        name: CLOSE_AFFORDANCE_LABEL,
      });

      // The reverse edge. Worth its own case because a trap that only holds
      // forwards still lets Shift+Tab walk a keyboard visitor out of the panel
      // and into the page that has just been hidden from assistive technology -
      // the worst of both states.
      cancel.focus();
      expect(cancel).toHaveFocus();

      fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });

      expect(cornerClose).toHaveFocus();
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it('gives its corner close affordance an accessible name rather than a bare glyph', async () => {
      render(<ConfirmDeletePostDialog />);

      const dialog = await openConfirmation();

      // The affordance is an icon control, and the icon is hidden from assistive
      // technology - correctly, since a decorative glyph should not be announced.
      // That makes the visually hidden label the only thing naming the button, so
      // this query resolving at all is the assertion: had the label been dropped,
      // the control would be announced as an unnamed button.
      const closeAffordance = within(dialog).getByRole('button', {
        name: CLOSE_AFFORDANCE_LABEL,
      });

      expect(closeAffordance).toBeInTheDocument();
      expect(closeAffordance).toHaveAccessibleName(CLOSE_AFFORDANCE_LABEL);
    });

    it('renders its title, description and close affordance inside the dialog node', async () => {
      render(<ConfirmDeletePostDialog />);

      const dialog = await openConfirmation();
      const panel = within(dialog);

      // Being on the page is not the same as being in the dialog. Content that
      // rendered as a sibling of the panel would read correctly in a `screen`
      // query and still be outside the modal boundary - hidden from assistive
      // technology by the very `aria-hidden` sweep asserted above, and unreachable
      // by the focus scope. Scoping each query to the panel is what rules that out.
      expect(panel.getByRole('heading', { name: DIALOG_TITLE })).toBeInTheDocument();
      expect(panel.getByText(DIALOG_DESCRIPTION)).toBeInTheDocument();
      expect(panel.getByRole('button', { name: CLOSE_AFFORDANCE_LABEL })).toBeInTheDocument();
      expect(panel.getByRole('button', { name: CANCEL_LABEL })).toBeInTheDocument();
    });
  });

  describe('controlled mode', () => {
    it('renders from the open prop with no interaction, in a fully controlled harness', async () => {
      render(<FullyControlledRemoveUserDialog open onOpenChange={vi.fn()} />);

      // No click anywhere. This is the shape an admin row action needs: the
      // parent decides a confirmation is due and the panel appears already open,
      // named and described.
      const dialog = await screen.findByRole('dialog');

      expect(dialog).toHaveAccessibleName(REMOVE_USER_TITLE);
      expect(dialog).toHaveAccessibleDescription(REMOVE_USER_DESCRIPTION);
    });

    it('stays closed when the open prop is false, in a fully controlled harness', () => {
      render(<FullyControlledRemoveUserDialog open={false} onOpenChange={vi.fn()} />);

      // The prop is authoritative in both directions. A panel that ignored a
      // `false` and opened itself from a trigger click would defeat the whole
      // point of controlling it.
      expect(screen.queryByRole('dialog')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: REMOVE_USER_TRIGGER_LABEL }));

      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('reports an Escape dismissal through onOpenChange and stays open until the parent updates, in a fully controlled harness', async () => {
      const onOpenChange = vi.fn();
      render(<FullyControlledRemoveUserDialog open onOpenChange={onOpenChange} />);
      await screen.findByRole('dialog');

      fireEvent.keyDown(document, { key: 'Escape' });

      // The report happens...
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onOpenChange).toHaveBeenCalledTimes(1);

      // ...and nothing else does, because this harness never feeds the reported
      // state back in. Deliberate, and the behaviour a consumer depends on when it
      // has work to run between the intent to close and the close: awaiting a
      // delete request, showing a failure, keeping the panel up if it failed.
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('reports a close-affordance dismissal through onOpenChange, in a fully controlled harness', async () => {
      const onOpenChange = vi.fn();
      render(<FullyControlledRemoveUserDialog open onOpenChange={onOpenChange} />);
      const dialog = await screen.findByRole('dialog');

      // The corner affordance the wrapper renders for itself has to route through
      // the same reporting path as Escape - it is not a private shortcut that
      // bypasses the controlled contract.
      fireEvent.click(within(dialog).getByRole('button', { name: CLOSE_AFFORDANCE_LABEL }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('closes when a state-backed parent applies the reported change', async () => {
      const onOpenChange = vi.fn();
      render(<StatefulRemoveUserDialog onOpenChange={onOpenChange} />);
      await screen.findByRole('dialog');

      fireEvent.keyDown(document, { key: 'Escape' });

      // The realistic controlled shape: the parent holds the state, applies what
      // it is told, and the panel closes as a consequence. Asserting the report
      // and its effect together is what proves the two are actually connected
      // rather than coincidentally both true.
      await expectDialogToBeGone();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe('hand-composed parts', () => {
    it('portals the DialogPortal and DialogOverlay subtree out of the render container', async () => {
      const { container } = render(
        <Dialog open>
          <DialogPortal>
            <DialogOverlay>
              <span>{HAND_COMPOSED_MARKER}</span>
            </DialogOverlay>
          </DialogPortal>
        </Dialog>,
      );

      // `DialogContent` renders a portal and an overlay for itself, so these two
      // parts exist for the rare panel assembled by hand. They are still public
      // API, so they still need a test - and one assertion covers both: the marker
      // is a child of the overlay, so finding it proves the overlay mounted and
      // rendered its subtree, and finding it OUTSIDE the render container proves
      // the portal moved that subtree to the end of the document.
      //
      // That escape is not cosmetic. It is what stops an ancestor's `overflow`,
      // `transform` or stacking context from clipping a modal, which is the defect
      // an in-place modal hits as soon as it is nested in a scrolling panel.
      const marker = await screen.findByText(HAND_COMPOSED_MARKER);

      expect(document.body.contains(marker)).toBe(true);
      expect(container.contains(marker)).toBe(false);
    });
  });
});
