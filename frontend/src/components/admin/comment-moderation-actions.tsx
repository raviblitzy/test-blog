'use client';

/**
 * Row actions for the administrative comment moderation queue: approve, reject, delete.
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
 * dialog returns focus to the menu item the operator actually selected. The approve and reject
 * items do NOT prevent the default, because closing the menu is the correct outcome there.
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
 * its danger tint, and the menu row matching the current state is both ticked and disabled. This is
 * the one screen where approved-versus-rejected is the entire point, so a colour-only signal would
 * be a functional failure rather than a cosmetic one.
 *
 * @module
 */

import { useState } from 'react';
import type { JSX } from 'react';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, CircleCheck, MoreHorizontal, Trash2 } from 'lucide-react';
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
import { deleteAdminComment, updateAdminCommentStatus } from '@/lib/api/admin';
import { isApiError } from '@/lib/api/client';
import type { AdminComment, AdminCommentStatusUpdate, CommentStatus } from '@/lib/types';

/* -------------------------------------------------------------------------- */
/* The moderation vocabulary                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Destination state of the approve transition.
 *
 * Annotated `CommentStatus` and NOT asserted with a cast, which is the whole point: the union is
 * single-sourced with the service's `comment_status` type, so if that label set ever changes this
 * line stops compiling instead of sending a value the service will reject at runtime. The same
 * guarantee is why no status literal appears inline anywhere below.
 */
const APPROVED_STATUS: CommentStatus = 'APPROVED';

/** Destination state of the reject transition. @see {@link APPROVED_STATUS} */
const REJECTED_STATUS: CommentStatus = 'REJECTED';

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
 * transition the service did not perform. `PENDING` is present because the endpoint can move a
 * comment back - a rejection is reversible - and because the `Record` is exhaustive over the union
 * whether or not this component offers that transition today.
 */
const MODERATION_SUCCESS_MESSAGES: Readonly<Record<CommentStatus, string>> = {
  PENDING: 'Comment returned to review.',
  APPROVED: 'Comment approved.',
  REJECTED: 'Comment rejected.',
};

/** Menu label for the approve transition while it is available. */
const APPROVE_LABEL = 'Approve comment';

/** Menu label for the reject transition while it is available. */
const REJECT_LABEL = 'Reject comment';

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
/* Cache keys                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The moderation queue's cache prefix.
 *
 * The four administrative screens register their listings under
 * `['admin', 'users' | 'posts' | 'comments' | 'categories', params]`, so invalidating the two-member
 * prefix matches every window and filter combination of the comment queue that is currently cached
 * - which is exactly right, because a state change can move a row in or out of a filtered view that
 * this component knows nothing about.
 */
const COMMENTS_QUERY_KEY = ['admin', 'comments'] as const;

/**
 * The overview counts.
 *
 * Invalidated after a DELETION only. Approving or rejecting moves a comment between states without
 * changing how many exist, and `AdminStats.comment_count` spans every moderation state, so a
 * transition cannot alter it; removing a comment can and does.
 */
const STATS_QUERY_KEY = ['admin', 'stats'] as const;

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
 * Approve, reject and delete affordances for one row of the comment moderation queue.
 *
 * Renders the comment's current state as a text-bearing pill beside a single action trigger, so a
 * long queue stays scannable and every row exposes exactly one control. The two reversible
 * transitions are menu items and need no confirmation; deletion is behind a modal confirmation
 * because it cascades to the comment's replies and cannot be undone.
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
   * "the confirmation is over" a single act - see {@link closeConfirmation} - instead of two states
   * that can disagree.
   *
   * Measured in a browser before this was controlled: dismissing the dialog with Escape left the
   * menu open with NOTHING focused, `pointer-events: none` still on the body and the rest of the
   * page still `aria-hidden`, until a second Escape closed the menu. A keyboard operator lost their
   * place in the queue on every cancelled deletion.
   */
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isConfirmingDeletion, setIsConfirmingDeletion] = useState(false);

  /**
   * Ends the confirmation: the dialog and the menu behind it close together.
   *
   * Called from every exit - Escape, the scrim, Cancel, the corner control, and a successful
   * deletion - so no path can leave one of the two overlays behind. Focus restoration is then
   * unambiguous: the dialog's own restoration is suppressed (it would aim at a menu item that is
   * unmounting in this same commit) and the menu's built-in restoration returns focus to the
   * trigger, which is where the operator was.
   */
  function closeConfirmation(): void {
    setIsConfirmingDeletion(false);
    setIsMenuOpen(false);
  }

  /**
   * Drops every cached window of the queue so the row re-reads from the service.
   *
   * A prefix match rather than an exact key: the screen's key carries its filter and page
   * parameters, and a transition can move a row out of a filtered view, so every window has to be
   * refetched rather than only the one currently on screen.
   */
  function invalidateQueue(): void {
    void queryClient.invalidateQueries({ queryKey: COMMENTS_QUERY_KEY });
  }

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
    onSuccess: (moderated: AdminComment): void => {
      invalidateQueue();
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
    onSuccess: (): void => {
      invalidateQueue();
      // A deletion changes the corpus, so the overview screen's totals are now stale.
      void queryClient.invalidateQueries({ queryKey: STATS_QUERY_KEY });
      closeConfirmation();
      toast.success(DELETION_SUCCESS_MESSAGE, { description: DELETION_CASCADE_NOTE });
      onChanged?.();
    },
    onError: (error: Error): void => {
      // The dialog stays open on failure: the operator asked for something that did not happen, and
      // closing the confirmation would leave that outcome to be inferred from a toast alone.
      toast.error(DELETION_FAILURE_MESSAGE, { description: describeFailure(error) });
    },
  });

  const isApproved = comment.status === APPROVED_STATUS;
  const isRejected = comment.status === REJECTED_STATUS;
  const authorName = authorNameOf(comment);

  return (
    /* `justify-end` keeps the pair at the trailing edge of an actions cell, which is block-level at
       md and above. `ms-auto` does the same job in the ONE context where `justify-end` cannot: below
       md the table primitive turns each cell into a flex row, so this element becomes a flex item
       sized to its content and its own justification has nothing left to distribute. An auto inline
       margin pushes it to the end there and computes to zero on a block-level box, so one class
       covers both presentations and neither needs a breakpoint variant. */
    <div className="ms-auto flex items-center justify-end gap-2">
      {/* The current state, as TEXT. The variant only tones it - the label is what carries the
          meaning for anyone who cannot distinguish these colours, and on this screen the state IS
          the information. */}
      <Badge variant={COMMENT_STATUS_BADGE_VARIANTS[comment.status]}>
        {MODERATION_STATE_LABELS[comment.status]}
      </Badge>

      <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
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
              designer review rather than silently enlarged. */}
          <Button variant="ghost" size="sm" className="w-8 shrink-0 px-0">
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
            <DropdownMenuItem
              disabled={isApproved || moderation.isPending}
              onSelect={(): void => {
                moderation.mutate(APPROVED_STATUS);
              }}
            >
              {isApproved ? <Check aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}
              {isApproved
                ? `${MODERATION_STATE_LABELS[APPROVED_STATUS]}${CURRENT_STATE_SUFFIX}`
                : APPROVE_LABEL}
            </DropdownMenuItem>

            <DropdownMenuItem
              disabled={isRejected || moderation.isPending}
              onSelect={(): void => {
                moderation.mutate(REJECTED_STATUS);
              }}
            >
              {isRejected ? <Check aria-hidden="true" /> : <Ban aria-hidden="true" />}
              {isRejected
                ? `${MODERATION_STATE_LABELS[REJECTED_STATUS]}${CURRENT_STATE_SUFFIX}`
                : REJECT_LABEL}
            </DropdownMenuItem>
          </DropdownMenuGroup>

          <DropdownMenuItem
            variant="destructive"
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
          `onOpenChange(false)` and closes the menu with it. */}
      <Dialog
        open={isConfirmingDeletion}
        onOpenChange={(open: boolean): void => {
          if (open) {
            setIsConfirmingDeletion(true);

            return;
          }

          closeConfirmation();
        }}
      >
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
            <DialogClose asChild>
              <Button variant="secondary">{CANCEL_LABEL}</Button>
            </DialogClose>

            {/* Disabled while in flight, so the request cannot be issued twice, and RELABELLED so
                the pending state is announced rather than only dimmed. */}
            <Button
              variant="destructive"
              disabled={deletion.isPending}
              onClick={(): void => {
                deletion.mutate();
              }}
            >
              <Trash2 aria-hidden="true" />
              {deletion.isPending ? DELETE_PENDING_LABEL : DELETE_LABEL}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
