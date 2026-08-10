'use client';

/**
 * Row actions for the administrative comment moderation queue: approve, reject, re-queue, delete.
 *
 * This component is the client face of the comment moderation state machine. The product
 * requirement asked for a dashboard that manages comments without ever naming a moderation state;
 * the plan concluded that "managing comments" implies a state an administrator can change, which is
 * why `comments` carries a moderation enum at all and why this file exists. The state is therefore
 * treated as first-class domain data - shown as text, changed through a declared endpoint, and
 * settled on the server's answer - rather than as decoration.
 *
 * ---------------------------------------------------------------------------
 * THE AUTHORITY THIS FILE HOLDS, AND WHY IT IS THE ONLY ONE THAT HOLDS IT
 *
 * `@/lib/api/admin#updateAdminCommentStatus` is the ONLY function in the frontend permitted to
 * change a comment's moderation state, and this is the only component that calls it. The public
 * comment wrapper, `@/lib/api/comments`, treats `status` as strictly read-only - an author may edit
 * their own comment's BODY and nothing else - so that wrapper is deliberately NOT imported here.
 * Importing it would not be a convenience, it would be a design error: two client paths to one
 * piece of state, only one of which the service actually accepts.
 *
 * Note the path asymmetry the admin namespace reproduces from the service, because getting it wrong
 * produces a 404 or a 405 nowhere near the call site: the comment and post STATUS transitions
 * address a `/status` sub-resource, while the account and category updates address the resource
 * itself. `updateAdminCommentStatus` builds the sub-resource path; `deleteAdminComment` addresses
 * the comment. Neither path is spelled in this file - see the next section.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS COMPONENT IS NOT
 *
 * - **Not a transport.** No `fetch`, no URL, no header, no status-code branch. Both operations go
 *   through `@/lib/api/admin`, which delegates to `@/lib/api/client` - the tier's only HTTP module.
 *   The single import from that client is `isApiError`, a type guard, not a transport call.
 * - **Not an authority check.** `require_admin` is applied once, as a router-level dependency on
 *   the whole administrative include, so authority is established server-side before any handler
 *   runs. This component gates nothing and hides nothing on the basis of a role: hiding a control
 *   is not a security boundary. The corollary is the part that matters here - a refusal SURFACES.
 *   A `403` is rendered as a real, legible error toast carrying the service's own problem detail,
 *   never swallowed and never flattened into a silent no-op.
 * - **Not an optimistic surface.** The plan confines optimistic updates to the like button and the
 *   PUBLIC comment components under `src/components/blog/`. The moderation queue is deliberately
 *   excluded: an operator must never see a comment as approved when the server never accepted the
 *   transition, so every mutation here settles on the server's response and the cached queue is
 *   invalidated rather than patched.
 * - **Not a fetcher of its own list.** The queue is `GET /admin/comments`, fetched by
 *   `src/app/(admin)/admin/comments/page.tsx` and rendered by `@/components/admin/data-table`.
 *   That page injects this component into a column's `cell`; the coupling runs one way, so nothing
 *   in this folder is imported here.
 * - **Not a configuration reader.** No environment variable is read, directly or indirectly.
 *
 * ---------------------------------------------------------------------------
 * THE ONE NON-OBVIOUS RADIX DETAIL
 *
 * A `DropdownMenuItem` that opens a `Dialog` MUST call `event.preventDefault()` in its `onSelect`.
 * Without it the menu closes on selection, and the closing menu restores focus to its own trigger
 * at the same moment the dialog mounts and tries to claim focus - a race whose loser is the
 * dialog, leaving a modal open with focus outside it. Preventing the default keeps the menu open
 * beneath the dialog, so the dialog's focus scope is the only one taking focus, and dismissing the
 * dialog returns focus to the menu item the operator actually selected. The moderation-state items
 * do NOT prevent the default, because closing the menu is the correct outcome there.
 *
 * ---------------------------------------------------------------------------
 * ONE BUSY STATE ACROSS BOTH WRITES
 *
 * Moderating and deleting the same comment are conflicting writes, and the second must not be
 * startable while the first is on the wire: two requests launched a moment apart settle in whichever
 * order the network chooses, and the loser silently overwrites the winner - a removal landing after
 * an approval leaves an approved comment that no longer exists, and an approval landing after a
 * removal answers 404 for a row the operator watched disappear. `isBusy` therefore spans BOTH
 * mutations and makes every mutually exclusive affordance inert: each state row, the destructive row,
 * and the trigger that would otherwise serve up a second menu.
 *
 * The confirmation is gated separately, by `isDeleting`, because the two facts are different. A
 * request that has already been sent cannot be recalled, so dismissing the dialog would not cancel
 * the deletion - it would only hide whichever answer arrives, which is the one message the operator
 * most needs. Each gate lives in exactly one handler, so no exit path can be added later that
 * quietly bypasses it.
 *
 * ---------------------------------------------------------------------------
 * TWO MUTATIONS ON ONE ROW, AND THEREFORE ONE BUSY STATE
 *
 * This row offers a moderation transition and a deletion on the SAME record, and they are not
 * compatible operations - a `PATCH` and a `DELETE` in flight together resolve in whatever order the
 * network chose, and the loser is answered `404` after a success toast has already been shown for
 * the winner. So the two are not guarded independently: `isBusy` spans both, and every conflicting
 * affordance is closed while either is running, including the confirmation dialog's own dismissal
 * while the DELETE specifically is in flight. See {@link CommentModerationActions}'s `isBusy` and
 * `handleConfirmationOpenChange` for the three interleavings that were reachable before it did.
 *
 * Both success handlers AWAIT their cache invalidation, so "busy" ends when the queue in front of
 * the operator has caught up rather than when the write returned. Ending it earlier re-armed the
 * menu over a row still painting its previous state.
 *
 * ---------------------------------------------------------------------------
 * DESIGN SYSTEM COMPLIANCE
 *
 * `review_rules` reports that no user-specified rules were provided for this project, so nothing
 * here is invented to satisfy one and the bar is not lowered either. The binding constraints are
 * the plan's own standards, and five of them shape this file:
 *
 * | Standard                        | How this file satisfies it                                    |
 * | ------------------------------- | ------------------------------------------------------------- |
 * | Project primitives, not raw DOM | Button, Badge, Dialog and DropdownMenu only; no raw `<button>` |
 * | Behavioural primitives          | Radix menu and dialog supply roles, focus trapping, Escape     |
 * | Zero hardcoded values           | Every class is a token utility; no colour, px, radius, shadow  |
 * | One breakpoint vocabulary       | No breakpoint variant and no media query appears here at all   |
 * | Accessibility as a floor        | Named trigger, named dialog, text-bearing state, hidden icons  |
 *
 * Colour never carries meaning alone. The current moderation state is rendered as a `Badge` whose
 * TEXT says what the state is, the destructive action says "Delete comment" rather than relying on
 * its danger tint, and the menu row matching the current state is ticked, suffixed in words and
 * disabled. This is the one screen where approved-versus-rejected is the entire point, so a
 * colour-only signal would be a functional failure rather than a cosmetic one.
 *
 * @module
 */

import { useState } from 'react';
import type { JSX } from 'react';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, CircleCheck, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';

import { Badge, COMMENT_STATUS_BADGE_VARIANTS } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { invalidateForAdminMutation } from '@/lib/admin-cache';
import { deleteAdminComment, updateAdminCommentStatus } from '@/lib/api/admin';
import { isApiError } from '@/lib/api/client';
import { COMMENT_STATUSES } from '@/lib/types';
import type { AdminComment, AdminCommentStatusUpdate, CommentStatus } from '@/lib/types';

/* -------------------------------------------------------------------------- */
/* The moderation vocabulary                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What each moderation row DOES, keyed by the state it moves the comment to.
 *
 * The menu is generated from `COMMENT_STATUSES` rather than from a hand-written pair of rows, and
 * that is the difference between offering the state machine and offering part of it. The union is
 * single-sourced with the service's `comment_status` type and the route accepts any member of it -
 * `PATCH /admin/comments/{id}/status` is documented as "approve, reject or re-queue", and
 * `AdminCommentStatusUpdate` exists precisely because "a rejection is reversible, and a decision
 * made in error is not permanent". A menu that reached only `APPROVED` and `REJECTED` therefore
 * stranded every decided comment: nothing in this dashboard could return one to the queue, even
 * though the service, the schema and the shared type all support it.
 *
 * A `Record` over the closed union rather than a conditional, so a fourth state added to the service
 * widens the union and fails to compile here until it has been given words - where a `switch` would
 * fall through to whichever branch it happened to end on and mislabel a row silently. Each label is
 * a complete instruction rather than a bare noun, because that is what `role="menuitem"` promises a
 * screen reader: activating the row does the thing the row says.
 */
const MODERATION_ACTION_LABELS: Readonly<Record<CommentStatus, string>> = {
  PENDING: 'Return to review',
  APPROVED: 'Approve comment',
  REJECTED: 'Reject comment',
};

/**
 * The glyph beside each destination, keyed the same way.
 *
 * Decorative in every case - each row's words carry the meaning, and every glyph below is rendered
 * `aria-hidden` - so this table exists for scannability rather than for semantics. `RotateCcw` reads
 * as "put it back" for the re-queue row, which is the one transition an operator reaches for after
 * changing their mind.
 */
const MODERATION_ACTION_ICONS: Readonly<Record<CommentStatus, LucideIcon>> = {
  PENDING: RotateCcw,
  APPROVED: CircleCheck,
  REJECTED: Ban,
};

/**
 * What each moderation state is called on screen.
 *
 * A `Record` over the closed union rather than a conditional, so a fourth state added to the
 * service would fail to compile here until it had been given a label - where a `switch` would fall
 * through to whichever branch it happened to end on and mislabel a row silently. The primitive
 * layer deliberately carries no labels (`COMMENT_STATUS_BADGE_VARIANTS` maps a state to a TONE
 * only), because the same state is worded differently in different places; the wording is the
 * caller's, and this is the caller.
 *
 * `PENDING` reads "Pending review" rather than "Pending", because the queue is a list of decisions
 * still to be taken and the noun is what says so.
 */
const MODERATION_STATE_LABELS: Readonly<Record<CommentStatus, string>> = {
  PENDING: 'Pending review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

/**
 * Confirmation wording per destination state, keyed by the state the SERVER reported.
 *
 * Keyed on the response rather than on the requested value, so the toast can never claim a
 * transition the service did not perform. `PENDING` is reachable from the menu - a rejection is
 * reversible - so this row reports a real outcome rather than covering an unreachable case.
 */
const MODERATION_SUCCESS_MESSAGES: Readonly<Record<CommentStatus, string>> = {
  PENDING: 'Comment returned to review.',
  APPROVED: 'Comment approved.',
  REJECTED: 'Comment rejected.',
};

/** Menu label, dialog title suffix and confirm-button label for removal. */
const DELETE_LABEL = 'Delete comment';

/**
 * Confirm-button label while the removal request is in flight.
 *
 * The pending state is carried by the LABEL and not only by the dimming, so it is announced rather
 * than merely visible - the button's accessible name changes, which assistive technology reports.
 */
const DELETE_PENDING_LABEL = 'Deleting comment…';

/**
 * Appended to a state's label on the menu row that matches the comment's current state.
 *
 * The tick glyph beside it is decorative and hidden from assistive technology, so this text - plus
 * the row's disabled state - is what actually conveys "you are already here".
 */
const CURRENT_STATE_SUFFIX = ' (current state)';

/** Accessible name of the moderation-state group inside the menu. */
const MODERATION_GROUP_LABEL = 'Moderation state';

/** Dialog heading for the destructive confirmation. */
const DELETE_DIALOG_TITLE = 'Delete this comment?';

/** Cancel affordance in the destructive confirmation. */
const CANCEL_LABEL = 'Cancel';

/** Headline of the toast confirming a removal. */
const DELETION_SUCCESS_MESSAGE = 'Comment deleted.';

/**
 * Supporting line of the removal toast, and the same fact the dialog states before the act.
 *
 * The cascade is enforced by the schema - the self-referencing parent carries `ON DELETE CASCADE` -
 * never by this client walking a thread and deleting replies one at a time.
 */
const DELETION_CASCADE_NOTE = 'Any replies beneath it were removed with it.';

/** Headline of the toast reporting a failed moderation transition. */
const MODERATION_FAILURE_MESSAGE = 'The comment could not be moderated.';

/** Headline of the toast reporting a failed removal. */
const DELETION_FAILURE_MESSAGE = 'The comment could not be deleted.';

/**
 * Fallback name for a record whose author projection carries a blank display name.
 *
 * The contract types `display_name` as non-nullable and the service derives it from the username at
 * registration, so this is unreachable in practice. It exists because a blank string is not `null`
 * and would otherwise render as an empty possessive in a destructive confirmation - the one place a
 * nameless record must not appear.
 */
const UNKNOWN_AUTHOR_NAME = 'an unknown author';

/* -------------------------------------------------------------------------- */
/* Cache invalidation lives in `@/lib/admin-cache`, not here                  */
/*                                                                            */
/* This file no longer names a query key. The two it used to declare - the     */
/* queue's prefix and the overview counts - were correct for these two         */
/* mutations, but they were also the third copy of the same convention in the  */
/* folder, and the convention is a statement about the SERVER's cascades       */
/* rather than about any one screen. Declaring it once, next to the cascade    */
/* that justifies each edge, is what stops the next mutation added here from   */
/* being reasoned about locally and getting it wrong.                          */
/*                                                                            */
/* The graph still says exactly what this file said: a moderation transition   */
/* stales the queue alone, because `AdminStats.comment_count` spans pending,   */
/* approved and rejected alike; a deletion stales the queue AND the counts,    */
/* because the comment and every reply beneath it leave the corpus.            */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Presentation helpers                                                       */
/* -------------------------------------------------------------------------- */

/** How much of a comment body is quoted in the trigger's accessible name. */
const EXCERPT_CODE_POINT_LIMIT = 60;

/** Marks a quoted excerpt that was cut short. */
const ELLIPSIS = '…';

/**
 * A single-line, plain-text excerpt of a comment body.
 *
 * Used only to build an accessible NAME, never to render the body: the body itself is rendered in
 * full as a text node, because sanitisation belongs to the service on write and this component
 * introduces no HTML rendering of any kind.
 *
 * Iterating with a spread counts and cuts by CODE POINT, so an emoji or any other astral character
 * cannot be sliced into a lone surrogate. Whitespace is collapsed first because a body's newlines
 * would otherwise be read out as a run of pauses inside a control's name.
 *
 * @param body - The comment text exactly as it arrived on the wire.
 * @returns An excerpt of at most {@link EXCERPT_CODE_POINT_LIMIT} code points, ellipsised when
 * shortened, or the empty string for a body that is blank or whitespace only.
 */
function excerptOf(body: string): string {
  const collapsed = body.replace(/\s+/gu, ' ').trim();
  const codePoints = [...collapsed];

  if (codePoints.length <= EXCERPT_CODE_POINT_LIMIT) {
    return collapsed;
  }

  return `${codePoints.slice(0, EXCERPT_CODE_POINT_LIMIT).join('')}${ELLIPSIS}`;
}

/**
 * The name to show for a comment's author.
 *
 * @param comment - The queue row.
 * @returns The display name, the username when the display name is blank, and a neutral stand-in
 * when both are - so no surface can ever render an empty possessive or the word "undefined".
 */
function authorNameOf(comment: AdminComment): string {
  const displayName = comment.author.display_name.trim();

  if (displayName.length > 0) {
    return displayName;
  }

  const username = comment.author.username.trim();

  return username.length > 0 ? username : UNKNOWN_AUTHOR_NAME;
}

/**
 * Accessible name for the row's action trigger.
 *
 * A comment has no title, so the name is composed from what the record does have: its author, plus
 * a short quotation of its body. This matters more here than anywhere else in the dashboard - a
 * moderation queue is a list of untitled records, and a column of controls all named "More" is
 * unusable with a screen reader, while a column of controls named after their author and their
 * first words is navigable.
 *
 * @param comment - The queue row.
 * @returns A name that identifies this row among its neighbours.
 */
function triggerNameOf(comment: AdminComment): string {
  const authorName = authorNameOf(comment);
  const excerpt = excerptOf(comment.body);

  return excerpt.length > 0
    ? `Moderate comment by ${authorName}: ${excerpt}`
    : `Moderate comment by ${authorName}`;
}

/**
 * The service's own explanation of a failure, for the supporting line of an error toast.
 *
 * Every rejection reaching this component is the API client's normalised error, carrying the one
 * problem document the service renders for every failure path. `detail` explains the particular
 * occurrence and `title` names the kind, so `detail` is preferred and `title` is the fallback -
 * the same order `@/components/admin/data-table` uses for its error panel, so a refusal reads the
 * same way whether it lands on the grid or on a row action.
 *
 * A `403` is the case this exists for. Authority is re-checked server-side on every protected
 * operation, so an operator whose privilege was revoked mid-session can still press these controls,
 * and the answer has to be readable rather than silent.
 *
 * @param error - Whatever the mutation rejected with.
 * @returns The explanation, or `undefined` when there is nothing more to add than the headline.
 */
function describeFailure(error: unknown): string | undefined {
  if (isApiError(error)) {
    const detail = error.problem.detail.trim();

    if (detail.length > 0) {
      return detail;
    }

    const title = error.problem.title.trim();

    return title.length > 0 ? title : undefined;
  }

  if (error instanceof Error) {
    const message = error.message.trim();

    return message.length > 0 ? message : undefined;
  }

  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

/** Props of {@link CommentModerationActions}. */
export interface CommentModerationActionsProps {
  /**
   * The queue row to act on, exactly as `GET /admin/comments` returned it.
   *
   * Read under its wire names - `id`, `body`, `status`, `author` - because there is no camelCase
   * translation layer anywhere in this tier. `id` is the server-generated UUID both endpoints
   * address; nothing here derives an identifier or accepts one from the caller.
   */
  readonly comment: AdminComment;

  /**
   * Optional side effect fired after a successful transition or removal, in ADDITION to the cache
   * invalidation this component already performs.
   *
   * The queue refreshes without it - invalidating the `['admin', 'comments']` prefix is what does
   * that - so this is for something the screen owns and this component cannot know about, such as
   * stepping back a page whose last row has just been deleted. It must not fetch, and it must not
   * be used to patch a cached moderation state: this surface settles on the server's answer.
   */
  readonly onChanged?: () => void;
}

/**
 * Approve, reject, re-queue and delete affordances for one row of the comment moderation queue.
 *
 * Renders the comment's current state as a text-bearing pill beside a single action trigger, so a
 * long queue stays scannable and every row exposes exactly one control. Every moderation state the
 * service accepts is a menu row - including the return to review, which is what makes a decision
 * revisable - and none needs a confirmation, because each is itself reversible. Deletion is behind a
 * modal confirmation because it cascades to the comment's replies and cannot be undone.
 *
 * Intended composition - injected into a column's `cell` by the queue screen, never imported by the
 * grid itself:
 *
 * ```tsx
 * const columns: ReadonlyArray<DataTableColumn<AdminComment>> = [
 *   { id: 'comment', header: 'Comment', cell: (comment) => comment.body },
 *   {
 *     id: 'actions',
 *     header: 'Actions',
 *     label: '',
 *     align: 'end',
 *     cell: (comment) => <CommentModerationActions comment={comment} />,
 *   },
 * ];
 * ```
 *
 * @param props - See {@link CommentModerationActionsProps}.
 * @returns The state pill, the action menu and the destructive confirmation.
 */
export function CommentModerationActions({
  comment,
  onChanged,
}: CommentModerationActionsProps): JSX.Element {
  const queryClient = useQueryClient();

  /*
   * Both overlays are CONTROLLED, and by one component rather than two, because they are not
   * independent: the destructive menu item prevents its own default so that the menu stays open
   * while the dialog mounts (see the module header), which means the menu is still open underneath
   * and something has to close it when the dialog goes away. Holding both flags here is what makes
   * "the confirmation is over" a single act - see {@link closeOverlays} - instead of two states
   * that can disagree.
   *
   * Measured in a browser before this was controlled: dismissing the dialog with Escape left the
   * menu open with NOTHING focused, `pointer-events: none` still on the body and the rest of the
   * page still `aria-hidden`, until a second Escape closed the menu. A keyboard operator lost their
   * place in the queue on every cancelled deletion.
   */
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isConfirmingDeletion, setIsConfirmingDeletion] = useState(false);

  /*
   * The moderation transition. No `retry`, `staleTime`, `gcTime` or `refetchOnWindowFocus` is
   * restated - `@/providers/query-provider` sets the tier-wide defaults, including `retry: 0` for
   * mutations, and a call site that restated them would be the second place they were decided.
   *
   * There is deliberately no `onMutate`: patching the cached row before the server answers is
   * exactly the failure this screen cannot tolerate, because it would show an operator a comment as
   * approved that the service refused to approve.
   */
  const moderation = useMutation({
    mutationFn: (status: CommentStatus): Promise<AdminComment> => {
      // Named as the request body it is, so the shape is checked against the contract at the call
      // site rather than at the boundary. `status` is required: naming no destination is not a
      // request, which is why the type has no optional member.
      const payload: AdminCommentStatusUpdate = { status };

      return updateAdminCommentStatus(comment.id, payload);
    },
    onSuccess: async (moderated: AdminComment): Promise<void> => {
      // AWAITED, so the mutation stays pending - and this row stays inert, see `isBusy` below -
      // until the queue in front of the operator actually shows the new state. Dropping the promise
      // ended the pending state as soon as the WRITE returned, which re-armed the menu over a row
      // still painting its old badge.
      await invalidateForAdminMutation(queryClient, 'comment.status');
      // Keyed on what the service reported, not on what was asked for.
      toast.success(MODERATION_SUCCESS_MESSAGES[moderated.status]);
      onChanged?.();
    },
    onError: (error: Error): void => {
      toast.error(MODERATION_FAILURE_MESSAGE, { description: describeFailure(error) });
    },
  });

  /*
   * The removal. Answers `204 No Content`, so there is no body and nothing to read back - the only
   * evidence of success is the absence of a rejection, which is why the queue and the overview
   * counts are both invalidated here rather than a response being inspected.
   */
  const deletion = useMutation({
    mutationFn: (): Promise<void> => deleteAdminComment(comment.id),
    onSuccess: async (): Promise<void> => {
      // Awaited BEFORE the overlays close, before the toast and before the caller's callback, so the
      // sequence the operator sees is the true one: the request settled, the queue caught up, and only
      // then did the confirmation go away. In the interval the confirm control reads "Deleting…" and
      // is disabled, which is exactly the state to be in.
      //
      // The two row actions on users and posts dismiss their confirmation first and await afterwards,
      // and that is safe there for the same reason it would be safe here - the mutation stays pending
      // either way, so the stale row is never actionable. The order differs deliberately rather than by
      // oversight: this handler also drives `onChanged`, which the moderation screen uses to move the
      // operator within the queue, and firing that before the queue has refetched would move them
      // relative to a list that was about to change underneath them.
      await invalidateForAdminMutation(queryClient, 'comment.delete');
      closeOverlays();
      toast.success(DELETION_SUCCESS_MESSAGE, { description: DELETION_CASCADE_NOTE });
      onChanged?.();
    },
    onError: (error: Error): void => {
      // The dialog stays open on failure: the operator asked for something that did not happen, and
      // closing the confirmation would leave that outcome to be inferred from a toast alone.
      toast.error(DELETION_FAILURE_MESSAGE, { description: describeFailure(error) });
    },
  });

  /**
   * Whether the removal in particular is on the wire.
   *
   * Named separately from {@link isBusy} because it governs a different thing: the confirmation's
   * own exits. A request that has already been sent cannot be recalled, so dismissing the dialog
   * would not cancel the deletion - it would only hide whichever answer arrives.
   */
  const isDeleting = deletion.isPending;

  /**
   * Whether EITHER administrative write is on the wire.
   *
   * One flag over both mutations, because the two are mutually exclusive in fact and were not in
   * code. Moderating and deleting the same comment are conflicting writes: launched a moment apart
   * they settle in whichever order the network chooses, and the loser silently overwrites the
   * winner - a `DELETE` landing after an approval leaves an approved comment that no longer exists,
   * an approval landing after a `DELETE` answers 404 for a row the operator watched disappear.
   * Neither outcome is recoverable from the queue, so this component refuses to start the second
   * write rather than racing it. It is also the reason a row goes inert as a whole: the state rows
   * previously consulted only the moderation flag, which left the destructive row live throughout a
   * transition.
   */
  const isBusy = moderation.isPending || isDeleting;

  /**
   * Takes both overlays down together: the confirmation, and the menu behind it.
   *
   * Both, always, so no path can leave one of them on screen. Focus restoration is then unambiguous:
   * the dialog's own restoration is suppressed (it would aim at a menu item that is unmounting in this
   * same commit) and the menu's built-in restoration returns focus to the trigger, which is where the
   * operator was.
   *
   * Unconditional, and reached from exactly two places: `handleConfirmationOpenChange`, which decides
   * whether a dismissal is allowed - it gates all five of the dialog's exits, the corner control
   * included - and the deletion's own `onSuccess`, which is closing them BECAUSE the request finished
   * and must not be subject to that decision.
   */
  function closeOverlays(): void {
    setIsConfirmingDeletion(false);
    setIsMenuOpen(false);
  }

  const authorName = authorNameOf(comment);

  /**
   * The single gate on the action menu's open state.
   *
   * Two independent refusals, and each closes a specific hole:
   *
   *   - **Opening while a write is on the wire** is refused, so the trigger cannot serve up a second
   *     menu mid-request. It pairs with `aria-disabled` on the trigger rather than with `disabled`,
   *     and the distinction is deliberate: `aria-disabled` is announced and, through the Button
   *     primitive's own `aria-disabled:pointer-events-none`, makes the control inert to the pointer,
   *     while leaving it FOCUSABLE. A real `disabled` attribute would make Radix's focus restoration
   *     - which fires as the menu closes on a moderation selection, in the same commit that sets the
   *     flag - aim at an element that cannot take focus, dropping the operator onto `<body>`. This
   *     handler is what stops keyboard activation, which `pointer-events` alone does not.
   *   - **Closing while the deletion is on the wire** is refused, because the panel is deliberately
   *     kept mounted beneath the confirmation (see the module header) and its dismissal would take
   *     the operator out of both surfaces while the request was still running.
   *
   * @param nextOpen - The state Radix is asking for.
   */
  function handleMenuOpenChange(nextOpen: boolean): void {
    if (nextOpen && isBusy) {
      return;
    }

    if (!nextOpen && isDeleting) {
      return;
    }

    setIsMenuOpen(nextOpen);
  }

  /**
   * The single gate on every one of the confirmation's exits.
   *
   * Radix routes Escape, an outside press, the corner close control and any `DialogClose` through
   * `onOpenChange`, so this one test covers all five paths at once: a deletion already on the wire
   * cannot be dismissed out from under itself. `onSuccess` closes the dialog by setting state
   * directly rather than by asking to close, which is what lets it through this gate - React Query
   * dispatches its `success` state only AFTER the success callback has run, so the mutation is still
   * reported as pending at that moment and a request routed through here would be refused.
   *
   * @param nextOpen - The state Radix is asking for.
   */
  function handleConfirmationOpenChange(nextOpen: boolean): void {
    if (isDeleting) {
      return;
    }

    if (nextOpen) {
      setIsConfirmingDeletion(true);

      return;
    }

    closeOverlays();
  }

  return (
    /* `justify-end` keeps the pair at the trailing edge of an actions cell, which is block-level at
       md and above. `ms-auto` does the same job in the ONE context where `justify-end` cannot: below
       md the table primitive turns each cell into a flex row, so this element becomes a flex item
       sized to its content and its own justification has nothing left to distribute. An auto inline
       margin pushes it to the end there and computes to zero on a block-level box, so one class
       covers both presentations and neither needs a breakpoint variant. */
    <div aria-busy={isBusy} className="ms-auto flex items-center justify-end gap-2">
      {/* The current state, as TEXT. The variant only tones it - the label is what carries the
          meaning for anyone who cannot distinguish these colours, and on this screen the state IS
          the information. It is also the reading a screen-reader user actually takes the state from,
          because the menu row that marks it is disabled and therefore not reachable by keyboard. */}
      <Badge variant={COMMENT_STATUS_BADGE_VARIANTS[comment.status]}>
        {MODERATION_STATE_LABELS[comment.status]}
      </Badge>

      <DropdownMenu open={isMenuOpen} onOpenChange={handleMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          {/* `asChild` so the menu's `aria-haspopup`, `aria-expanded` and keyboard handlers land on
              this Button instead of a second, competing one. No `id` is passed, here or through the
              child: Radix derives the trigger and panel ids from one root and labels the panel with
              `aria-labelledby={triggerId}`, which an id of ours would silently break.

              `w-8 px-0` squares the `sm` size (`h-8`) into an icon-only control, which is the
              composition the Button size table prescribes instead of a fourth size, and `shrink-0`
              keeps that footprint when the cell is a flex row in the stacked-card presentation.

              BLITZY [A11Y]: the resulting target is 32x32, below the 44x44 minimum. Deliberate and
              specified: `size="sm"` exists precisely for these dense admin row actions - a 44px
              control in every cell of every column would make the moderation table unusable - and
              button.tsx carries the same flag on that size. Implemented as specified and flagged for
              designer review rather than silently enlarged.

              `aria-disabled` rather than `disabled` while a write is on the wire, and the primitive
              supplies both halves of that: it is announced, and its own
              `aria-disabled:pointer-events-none` makes the control inert to the pointer. Keeping the
              element focusable is the point - see `handleMenuOpenChange`, which refuses the keyboard
              path `pointer-events` cannot gate. */}
          <Button
            aria-disabled={isBusy || undefined}
            variant="ghost"
            size="sm"
            className="w-8 shrink-0 px-0"
          >
            <MoreHorizontal aria-hidden="true" />
            {/* The control's whole accessible name, and it identifies the RECORD. Visually hidden
                rather than an `aria-label`, which is the pattern the layout components use. */}
            <span className="sr-only">{triggerNameOf(comment)}</span>
          </Button>
        </DropdownMenuTrigger>

        {/* `align="end"` because the trigger sits at the trailing edge of its cell. The panel is
            portalled by the primitive, so the table's horizontal scroll container cannot clip it,
            and no width is set here - the primitive sizes to its longest label.

            `invisible` while the confirmation is open, because the panel has to stay MOUNTED - that
            is what stops its unmounting from racing the dialog for focus - but a menu painted on top
            of a modal scrim reads as two competing surfaces. Visibility only: the element keeps its
            box, its dismissal handlers and its focus restoration, and both overlays close in one
            commit so nothing flashes back into view on the way out. Not an accessibility change
            either - Radix already marks everything outside the dialog `aria-hidden` while it is
            open. `invisible` carries no colour, dimension or radius, so no token is bypassed. */}
        <DropdownMenuContent align="end" className={isConfirmingDeletion ? 'invisible' : undefined}>
          {/* One group, announced as a set: these two rows are the moderation state, and the
              deletion below them is a different kind of act. The primitive layer offers no
              separator or label part, so the group's own accessible name does that work. */}
          <DropdownMenuGroup aria-label={MODERATION_GROUP_LABEL}>
            {/* One row per member of the moderation union, in the order the service declares them,
                so every transition the endpoint accepts is reachable - including the return to
                review that makes a rejection reversible. Generated rather than written out, which is
                what keeps the menu and the union from drifting apart again. */}
            {COMMENT_STATUSES.map((status) => {
              const isCurrent = status === comment.status;
              const DestinationIcon = MODERATION_ACTION_ICONS[status];

              return (
                <DropdownMenuItem
                  // The programmatic half of "you are already here". The visible half is the tick
                  // and the suffix beside it, and the pill in the cell carries it a third time,
                  // because a disabled row is not reachable by keyboard.
                  aria-current={isCurrent ? 'true' : undefined}
                  // Non-actionable when it is the state the comment is already in - the service
                  // treats that as an accepted no-op, but a request that cannot change anything is
                  // not worth offering - and inert for EVERY row while either write is on the wire.
                  // The primitive turns this into `data-disabled`, dims the row and drops it out of
                  // arrow-key and typeahead traversal.
                  disabled={isCurrent || isBusy}
                  key={status}
                  onSelect={(): void => {
                    moderation.mutate(status);
                  }}
                >
                  {isCurrent ? (
                    <Check aria-hidden="true" />
                  ) : (
                    <DestinationIcon aria-hidden="true" />
                  )}
                  {isCurrent
                    ? `${MODERATION_STATE_LABELS[status]}${CURRENT_STATE_SUFFIX}`
                    : MODERATION_ACTION_LABELS[status]}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>

          <DropdownMenuItem
            variant="destructive"
            // Inert while EITHER write is on the wire. This row is the one the previous version left
            // live throughout a moderation transition, which is how two conflicting administrative
            // writes could be launched a moment apart.
            disabled={isBusy}
            onSelect={(event: Event): void => {
              // See the module header: without this the closing menu and the mounting dialog race
              // for focus, and the dialog loses.
              event.preventDefault();
              setIsConfirmingDeletion(true);
            }}
          >
            <Trash2 aria-hidden="true" />
            {DELETE_LABEL}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Controlled, and rendered as a sibling of the menu rather than inside it, so its lifetime is
          this row's rather than the panel's. `DialogContent` supplies its own portal, scrim and
          corner dismiss control; Radix supplies the role, the modal semantics, focus trapping and
          Escape.

          Every dismissal - Escape, the scrim, Cancel, the corner control - arrives here as
          `onOpenChange(false)` and closes the menu with it, unless the removal is already on the
          wire: see `handleConfirmationOpenChange`, which is the one place all five exits are gated.
          The corner control in particular can only be neutralised here, because `DialogContent`
          renders it for itself and takes no `disabled` from a caller. */}
      <Dialog open={isConfirmingDeletion} onOpenChange={handleConfirmationOpenChange}>
        {/* Focus restoration is deliberately handed to the MENU. This dialog would aim at the
            element focused before it opened - the destructive menu item - which unmounts in the same
            commit as the dialog, so restoring to it lands on `<body>`: measured, and it left a
            keyboard operator with no focus ring at all. Suppressing it leaves exactly one authority,
            the menu's own built-in restoration, which focuses the trigger the operator started
            from. Nothing is lost by suppressing it, because the two would otherwise compete for one
            focus. */}
        <DialogContent
          onCloseAutoFocus={(event: Event): void => {
            event.preventDefault();
          }}
        >
          {/* Mandatory: without it the modal has no accessible name. */}
          <DialogTitle>{DELETE_DIALOG_TITLE}</DialogTitle>

          {/* Names the record AND states the real consequence. The cascade is the fact an operator
              cannot infer from the row in front of them, so it is said before the act, not only in
              the toast afterwards. */}
          <DialogDescription>
            {`Deleting ${authorName}'s comment also removes every reply beneath it. This cannot be undone.`}
          </DialogDescription>

          {/* The body, as a TEXT NODE. Never `dangerouslySetInnerHTML` and never a Markdown or HTML
              renderer: sanitisation is the service's on write, and this surface adds no rendering
              path that could reintroduce the injection it removes.

              THE PADDING IS ON THE WRAPPER AND THE CLAMP IS ON THE QUOTE, and the split is
              load-bearing rather than tidy. Overflow is clipped at an element's PADDING box, so a
              clamped element that also carries padding paints its first overflowing line into that
              padding: measured in Chrome 151 at 375px with both on one element, the box was sized to
              three lines and drew its ellipsis, and a fourth line was still painted through the
              padding and sliced mid-glyph. With the padding moved out, the quote's padding box is
              its content box and the clip lands exactly on the third line.

              `wrap-anywhere` rather than `break-words`, because this is a grid item whose automatic
              minimum size resolves to min-content - the one case where `overflow-wrap: break-word`
              provably does not shrink the box - so a long unbroken token would otherwise be the
              classic source of horizontal overflow at the narrowest viewport. */}
          <div className="bg-surface-muted border-border rounded-md border p-3">
            <blockquote className="text-foreground line-clamp-3 text-sm wrap-anywhere">
              {comment.body}
            </blockquote>
          </div>

          {/* `flex-wrap` rather than a breakpoint variant: the two labels sit side by side wherever
              they fit and stack where they do not, at every width, with no media query. */}
          <div className="flex flex-wrap justify-end gap-2">
            {/* Disabled while the removal is in flight, matching the confirm control beside it.
                Offering a way out of a request that cannot be recalled would misrepresent what
                cancelling does, and the guard on `onOpenChange` refuses the dismissal anyway - so a
                live Cancel would be a control that visibly does nothing. */}
            <DialogClose asChild>
              <Button disabled={isDeleting} variant="secondary">
                {CANCEL_LABEL}
              </Button>
            </DialogClose>

            {/* Disabled on `isBusy` rather than on this mutation alone, so the removal cannot be
                started while a moderation transition on the same record is still in flight - the
                two requests would otherwise race and the service would decide the outcome. Also
                RELABELLED, so the pending state is announced rather than only dimmed. */}
            <Button
              aria-busy={isDeleting}
              variant="destructive"
              disabled={isBusy}
              onClick={(): void => {
                deletion.mutate();
              }}
            >
              <Trash2 aria-hidden="true" />
              {isDeleting ? DELETE_PENDING_LABEL : DELETE_LABEL}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
