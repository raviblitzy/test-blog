'use client';

// user-row-actions.tsx - the per-row action menu of the administrative users table.
//
// It is the affordance behind the plan's acceptance criterion for the admin dashboard: "an
// administrator can change a user's role and active state". Three capabilities, one menu:
// reassign authority across the three roles, deactivate or reactivate the credential, and delete
// the account behind a confirmation.
//
// It is also the FIRST of the three admin row menus to be written, and the other two -
// post-row-actions.tsx and comment-moderation-actions.tsx - repeat the shape established here:
//
//     select a menu item -> (confirm, if the action is irreversible) -> mutate -> invalidate the
//     listing (and the overview counts, when a count changed) -> toast the outcome
//
// The component is injected into a column's `cell` renderer by the users screen - the JSDoc on
// @/components/admin/data-table spells the call out as `cell: (user) => <UserRowActions
// user={user} />` - and the coupling runs ONE WAY through that signature. This file therefore
// imports no sibling in this folder: not the grid, not the row, not the page.
//
// ---------------------------------------------------------------------------
// 1. THE SECURITY RULING, WHICH IS THE MOST IMPORTANT LINE IN THIS FILE
//
// Nothing here is a security boundary, and nothing here is written as though it were. The plan is
// explicit that hiding a control is not a security boundary: authority is enforced server-side by
// the `require_admin` dependency applied once on the administrative router include - so no
// administrative route can omit it - plus the ownership assertions in the service layer.
//
// Three consequences, each visible in the code below:
//
//   * No token is read, decoded or inspected. This component never sees a credential; the bearer
//     is attached by @/lib/api/client, which is the only module in the tier that performs HTTP.
//   * No item is hidden or disabled to express permission. The `disabled` props below express
//     TRANSIENT UNAVAILABILITY (a mutation is in flight) and CURRENT STATE (this is already the
//     account's role), never authority.
//   * A refusal is surfaced, never swallowed. A `403` arrives as an ApiError carrying the
//     service's problem document, and its `detail` is shown verbatim in an error toast. Treating a
//     403 as impossible - because the screen is "admin only" - is exactly the assumption the
//     ruling above forbids.
//
// There is deliberately NO self-action prohibition. A client-side "you cannot demote yourself"
// check would be precisely the client-only pseudo-security the plan rejects; if the service
// refuses such a change, its problem document says so and the toast repeats it.
//
// ---------------------------------------------------------------------------
// 2. WHAT THIS FILE IS NOT ALLOWED TO CONTAIN - AND DOES NOT
//
//   * Transport. No `fetch`, no URL, no header, no status-code branch. The two operations arrive
//     from @/lib/api/admin, which delegates to the tier's single HTTP module.
//   * Optimistic updates. The plan confines those to the like button and the comment surface;
//     administrative mutations settle on the server's response. Every message below is written
//     from the AdminUser the service returned, not from the value that was requested, so the UI
//     cannot claim a change the service did not make.
//   * Restated React Query defaults. @/providers/query-provider owns `staleTime`, `gcTime`,
//     `refetchOnWindowFocus`, the query retry predicate AND `mutations: { retry: 0 }`. None is
//     repeated here.
//   * `window.confirm`. It has no focus management, cannot be themed from the token layer, and -
//     decisively - frontend/vitest.setup.ts stubs only `matchMedia`, `ResizeObserver`,
//     `IntersectionObserver` and `DOMRect`, so no other browser API may be assumed to exist. The
//     same fact rules out `navigator.clipboard` and `localStorage`, neither of which appears here.
//   * An environment variable, a secret, or a literal colour, length, radius or shadow.
//   * Anything the plan does not name: no password reset, no email verification, no invitation, no
//     impersonation, no bulk action, no audit log. The first two are explicitly out of scope.
//
// ---------------------------------------------------------------------------
// 3. THREE CONTRACTS THAT DIFFER FROM THE OBVIOUS GUESS. READ BEFORE EDITING.
//
//   1. The API functions are `updateAdminUser` and `deleteAdminUser`, not `updateUser`/
//      `deleteUser`. `updateAdminUser` addresses the account itself with no sub-path (unlike the
//      post and comment status transitions, which use a `/status` sub-path) and returns the
//      updated AdminUser; `deleteAdminUser` resolves `204 No Content`, so there is no body to
//      read and its `onSuccess` receives nothing.
//   2. `ProblemDetail.detail` is a NON-OPTIONAL string. `detail ?? title` can therefore never
//      reach `title` and is a bug that type-checks; the empty string is the only "nothing to say"
//      value, which is why {@link failureMessage} compares against it. That mirrors how ApiError
//      derives its own `message`.
//   3. `@/components/ui/dropdown-menu` does export a radio pair, and this file still does not use
//      it. A radio group is the right shape for a SETTING the visitor owns (the colour theme is
//      that case, and the primitive's own notes say so); a role reassignment is an ACT performed
//      on somebody else's record, each occurrence a separate request that can be refused. Plain
//      items say "Make author" - an action, which is what a menu row is - and let the current row
//      be marked as unavailable rather than merely unselected. The primitive is not edited from
//      here either way: it belongs to another folder.
//
// ---------------------------------------------------------------------------
// 4. TOKENS AND PRIMITIVES ONLY
//
// Every value below resolves to a semantic token from src/app/globals.css or to one of the
// engine's own scales, and every visual decision that could have been made here was instead
// inherited:
//
//   destructive item tint    --color-danger    `variant="destructive"` on the item
//   highlighted item         --color-accent    the item's own base classes
//   focus indicator          --color-ring      the item's inset ring, the Button's outline, and
//                                              the `:focus-visible` floor in globals.css
//
// The destructive item treatment exists in the primitive specifically "for the delete actions the
// admin row menus expose", so it is consumed rather than re-authored. Focus styling is NOT
// restated: globals.css sets a document-wide `:focus-visible` floor and both primitives draw
// their own indicator, so a third declaration here would be a competing source of truth. There is
// no `dark:` conditional and there must never be one - each token is declared twice in the token
// layer, so this component themes itself.
//
// Radix owns every interaction: roving focus, typeahead, `role="menu"`/`role="menuitem"`,
// dismissal and focus restoration for the menu; the focus trap, `Escape`, scroll locking and the
// `aria-labelledby`/`aria-describedby` wiring for the dialog. None of it is reimplemented here,
// and no `role` or `aria-modal` is hand-written.

import { useRef, useState } from 'react';
import type { JSX } from 'react';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Ellipsis, Trash2, UserCheck, UserX } from 'lucide-react';
import { toast } from 'sonner';

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
import type { AdminMutation } from '@/lib/admin-cache';
import { deleteAdminUser, updateAdminUser } from '@/lib/api/admin';
import { isApiError } from '@/lib/api/client';
import { USER_ROLES } from '@/lib/types';
import type { AdminUser, UserRole } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Cache invalidation lives in `@/lib/admin-cache`, not here
 *
 * This file used to name its own two keys - the users listing and the overview counts - and that list
 * was short by three tables on the one mutation that matters most.
 *
 * `DELETE /admin/users/{id}` is the widest cascade in the API. `admin_service.delete_user` issues a
 * single statement; every foreign key referencing `users.id` carries `ON DELETE CASCADE`, so
 * PostgreSQL removes the account's posts, comments, likes and refresh tokens, then cascades again from
 * each removed post to that post's own comments and likes, and the `post_categories` filings that go
 * with those posts move `post_count` on the category table. Refreshing users and the counts alone left
 * the POSTS table and the MODERATION QUEUE serving rows the service had already removed - actionable,
 * for the whole stale window, each action answered `404` with nothing on screen to explain it.
 *
 * The role and deactivation mutations are genuinely narrower, and the graph says so: `AdminUser` is
 * the only projection carrying a role or an active flag, and `AdminPost.author` is a `UserPublic`
 * which carries neither - so neither mutation stales another table, and neither moves a count.
 *
 * Both facts belong next to the server behaviour that justifies them rather than in a row action, so
 * they live in that module's graph. See its header for why every invalidation is awaited.
 * ---------------------------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------------------------------
 * Copy
 *
 * Both tables are exhaustive records over UserRole rather than looser string maps, so adding a
 * fourth role to the union fails to compile until the labels account for it. That is what stops a
 * new role from silently rendering as its uppercase wire label.
 *
 * The order the rows appear in is USER_ROLES' own order, which the contract module documents as
 * least privilege first - so the menu lists the least powerful option first without this file
 * restating a sequence.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Visible label - and therefore, through name-from-content, the accessible name - of each role
 * row.
 *
 * Phrased as the ACTION rather than as the role's name. "Reader" alone would leave a row in a
 * menu of actions reading as a noun, and the reader would have to infer the verb; "Make reader"
 * says what selecting it does, which is what a `role="menuitem"` promises. It also means the row
 * that is already current reads sensibly when marked unavailable: the act is unavailable precisely
 * because it has already happened.
 */
const ROLE_ACTION_LABELS: Readonly<Record<UserRole, string>> = {
  READER: 'Make reader',
  AUTHOR: 'Make author',
  ADMIN: 'Make administrator',
};

/**
 * Sentence fragment naming the authority an account now holds, for the success toast.
 *
 * Carries its own article so the message reads as English in all three cases ("... is now an
 * administrator.") without the caller concatenating "a"/"an" by guessing at the first letter.
 */
const ROLE_OUTCOME_LABELS: Readonly<Record<UserRole, string>> = {
  READER: 'a reader',
  AUTHOR: 'an author',
  ADMIN: 'an administrator',
};

/* -------------------------------------------------------------------------------------------------
 * Pure helpers
 *
 * Both are module-level and side-effect free, so they can be asserted directly without rendering
 * anything and neither closes over component state.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Turns a rejection into a sentence that is safe to show to a person.
 *
 * Every failure the API layer can produce - a rejection from the service, an unreachable service,
 * an aborted request, a body that would not parse - arrives as a single error type carrying a
 * well-formed problem document, so there is exactly one branch here and no status-code reasoning.
 * `detail` is the member the service writes to be readable; it is a non-optional string and is
 * empty only when the service had nothing occurrence-specific to say, in which case the constant
 * `title` is the better sentence.
 *
 * This is the path a `403` takes. It is not special-cased, and it must not be: an authorisation
 * refusal is a real answer from the server and the administrator is entitled to read it.
 *
 * @param error - The caught value, whatever it is. Not assumed to be an Error.
 * @param fallback - Sentence to use when the value did not come from the API layer at all, which
 *   would mean a defect in this component rather than a transport failure.
 * @returns A single human-readable sentence. Never empty, never a status code, never a stack.
 */
function failureMessage(error: unknown, fallback: string): string {
  if (isApiError(error)) {
    return error.problem.detail === '' ? error.problem.title : error.problem.detail;
  }
  return fallback;
}

/**
 * The name to show a person for an account.
 *
 * `display_name` mirrors a `TEXT NOT NULL` column, so it is never null - but "not null" does not
 * mean "not blank", and a blank one would render as nothing at all inside a sentence that is
 * asking for confirmation of an irreversible act. The username is the safe fallback: it is unique
 * and case-insensitively constrained, so it always identifies exactly one account.
 *
 * @param user - The account being described.
 * @returns The display name when it carries any non-whitespace text, otherwise the username.
 */
function accountLabel(user: AdminUser): string {
  return user.display_name.trim() === '' ? user.username : user.display_name;
}

/* -------------------------------------------------------------------------------------------------
 * Component
 * ---------------------------------------------------------------------------------------------- */

/** Props of {@link UserRowActions}. */
interface UserRowActionsProps {
  /**
   * The account this menu acts on, exactly as the listing returned it.
   *
   * Read rather than copied into state: `role` and `is_active` decide which row is marked current
   * and whether the access row offers to deactivate or to activate, and after a successful
   * mutation the listing is invalidated and this component is re-rendered with the server's new
   * values. Mirroring either field into local state would create a second truth that could
   * disagree with the row beside it.
   */
  readonly user: AdminUser;

  /**
   * Called once after each mutation the service accepted, and never after one it refused.
   *
   * Optional, and the screen is expected to omit it in the common case: the listing refresh is
   * handled here by invalidating the cache, so this exists for a caller that has its own state to
   * settle - closing a detail panel, clearing a row selection. It is invoked before the refetch is
   * awaited so a caller is not made to wait on the network to dismiss its own UI.
   */
  readonly onChanged?: (() => void) | undefined;
}

/**
 * The row-action menu for one account in the administrative users table.
 *
 * ```tsx
 * const columns: ReadonlyArray<DataTableColumn<AdminUser>> = [
 *   // ...
 *   { id: 'actions', header: 'Actions', label: '', align: 'end',
 *     cell: (user) => <UserRowActions user={user} /> },
 * ];
 * ```
 *
 * ### Why the confirmation dialog is a sibling of the menu rather than a child of it
 *
 * The dialog's open state is held HERE, above both parts, and the dialog is rendered next to the
 * menu instead of inside it. That is the arrangement that makes focus behave, and the reasoning is
 * worth recording because the two obvious alternatives are the usual source of a modal that opens
 * unfocused:
 *
 *   * Selecting the delete row lets the menu close normally. React batches the close with the
 *     state change that opens the dialog into ONE commit, and in that commit React runs the
 *     unmounting subtree's effect cleanups before the mounting subtree's effects - so the menu
 *     restores focus to its trigger first and the dialog's focus trap claims focus second. The
 *     dialog wins, and because it captured the trigger as the previously-focused element,
 *     dismissing it returns focus exactly where the visitor started.
 *   * Calling `preventDefault()` in that row's `onSelect` would instead leave the menu OPEN behind
 *     the dialog, so two trapped layers would compete for focus. The primitive documents that
 *     escape hatch for a row that should not dismiss the menu at all, which is not this case.
 *   * The body's pointer-events lock is reference-counted across dismissable layers, so the
 *     handover leaves nothing behind: the page is interactive again once the dialog closes.
 *
 * The current-role row is the one place `preventDefault()` IS used, for the opposite reason - it
 * has nothing to do, so it should not dismiss the menu either.
 *
 * ### Accessibility
 *
 *   * The trigger's name identifies the record ("Actions for alice"), because a table of twenty
 *     rows would otherwise contain twenty identically-named controls with no way to tell a screen
 *     reader which one is which. It comes from visually hidden TEXT rather than an attribute, so
 *     the control has real content and Radix's `aria-labelledby` gives the panel the same name.
 *   * Each group carries a name, so the rows are announced as a set with a purpose rather than as
 *     one flat list.
 *   * The current role is conveyed THREE ways that do not depend on each other: the word
 *     "Current", `aria-disabled` on the row, and a tick. Never by the glyph alone and never by
 *     colour alone.
 *   * The destructive row pairs its tint with the word "Delete", for the same reason.
 *   * Every icon is decorative and hidden from assistive technology; the labels carry the meaning.
 *   * The confirmation is named by its `DialogTitle` and described by its `DialogDescription`,
 *     which is what Radix points `aria-labelledby` and `aria-describedby` at. Focus lands on
 *     Cancel - the safe action is first in the DOM - and `Escape` dismisses.
 *
 * @param user - The account to act on. See {@link UserRowActionsProps.user}.
 * @param onChanged - Optional callback after an accepted mutation.
 * @returns The trigger, its menu, and the delete confirmation.
 */
export function UserRowActions({ user, onChanged }: UserRowActionsProps): JSX.Element {
  const queryClient = useQueryClient();

  /*
   * Whether the delete confirmation is open. Controlled rather than left to the dialog, because
   * the row that opens it is a menu item rather than a `DialogTrigger` - the menu has to be free
   * to close as part of the same interaction, which is the focus handover described above.
   */
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  /*
   * The row's trigger, held so the confirmation can hand focus back to it.
   *
   * MEASURED, NOT ASSUMED, and the correction is worth recording because the intuitive reading is
   * wrong. Radix's FocusScope stores whatever was focused when the panel mounted and returns focus
   * there on close, which normally needs no help - but here the element focused at that moment is
   * the "Delete user" MENU ITEM, and the menu unmounts as the dialog mounts. Verified in Chrome:
   * dismissing the confirmation left `document.activeElement === document.body`, so a keyboard
   * visitor who cancelled a delete lost their place in the table entirely. `onCloseAutoFocus`
   * below is what repairs it, and this ref is what it aims at.
   */
  const triggerRef = useRef<HTMLButtonElement>(null);

  /**
   * Refreshes everything the named mutation staled, and resolves once it has.
   *
   * A one-line delegation to `@/lib/admin-cache`, kept so the three handlers below read the same way
   * they did when the keys were local. Awaited by each of them, so the mutation remains pending until
   * the affected tables have actually caught up - which is what stops a stale row from being visible
   * next to a toast announcing it changed, and stops a second press acting on it.
   */
  async function refreshAfter(mutation: AdminMutation): Promise<void> {
    await invalidateForAdminMutation(queryClient, mutation);
  }

  /*
   * THREE MUTATIONS RATHER THAN ONE, and the reason is legibility rather than fashion. A single
   * mutation over `AdminUserUpdate` would have to work out from the payload which of two things it
   * had just done in order to write its message, and that reconstruction needs a branch whose last
   * arm is unreachable - a shape the zero-placeholder rule rightly treats as a smell. Split by
   * intent, each handler describes exactly one outcome and every branch below is reachable.
   *
   * None of them passes `retry`, `staleTime`, `gcTime` or `refetchOnWindowFocus`:
   * @/providers/query-provider sets those for the whole tier, including `mutations: { retry: 0 }`,
   * and a mutation this file issues is not safe to blindly repeat.
   *
   * Every `onSuccess` reads the AdminUser the SERVICE returned rather than the value that was
   * requested. That is the no-optimistic-updates rule in practice: nothing is announced or
   * rendered until the server has said it happened.
   */

  /** Reassigns authority. `PATCH /admin/users/{id}` with `role` only, so `is_active` is untouched. */
  const roleMutation = useMutation({
    mutationFn: (role: UserRole) => updateAdminUser(user.id, { role }),
    onSuccess: async (updated) => {
      toast.success(`${updated.username} is now ${ROLE_OUTCOME_LABELS[updated.role]}.`);
      onChanged?.();
      await refreshAfter('user.update');
    },
    onError: (error) => {
      toast.error(failureMessage(error, `${user.username}'s role could not be changed.`));
    },
  });

  /**
   * Turns the credential on or off. `PATCH /admin/users/{id}` with `is_active` only, so the role is
   * untouched - the two members of the payload are independent by design.
   */
  const accessMutation = useMutation({
    mutationFn: (isActive: boolean) => updateAdminUser(user.id, { is_active: isActive }),
    onSuccess: async (updated) => {
      toast.success(
        updated.is_active
          ? `${updated.username} can sign in again.`
          : `${updated.username} can no longer sign in.`,
      );
      onChanged?.();
      await refreshAfter('user.update');
    },
    onError: (error) => {
      toast.error(
        failureMessage(
          error,
          user.is_active
            ? `${user.username} could not be deactivated.`
            : `${user.username} could not be reactivated.`,
        ),
      );
    },
  });

  /**
   * Deletes the account. `DELETE /admin/users/{id}` resolves `204 No Content`, so `onSuccess`
   * receives nothing and the message is written from the props - which is correct here, because
   * the record it describes no longer exists to be read back.
   *
   * The confirmation is dismissed FIRST, before the refetch is awaited. Closing it last would
   * leave a panel open over a table that had already dropped the row, and would hold a disabled
   * confirm button on screen for the length of a request whose outcome is already known.
   */
  const deleteMutation = useMutation({
    mutationFn: () => deleteAdminUser(user.id),
    onSuccess: async () => {
      setIsConfirmingDelete(false);
      toast.success(`${user.username}'s account has been deleted.`);
      onChanged?.();
      // FOUR TABLES AND THE COUNTS, not two keys: a deletion is the one action in this menu whose
      // effects reach past the users listing. The cascade the service performs - the account's posts,
      // comments, likes and rotation credentials, then each removed post's own comments and likes, and
      // with them the category filings that feed `post_count` - is what makes the posts table, the
      // moderation queue and the category tallies stale too, and it is why more than one overview count
      // moves. The full list, and the justification for each edge, is in `@/lib/admin-cache`.
      await refreshAfter('user.delete');
    },
    onError: (error) => {
      toast.error(failureMessage(error, `${user.username}'s account could not be deleted.`));
    },
  });

  /*
   * Whether ANY of the three is in flight.
   *
   * Used to make the actionable rows unavailable, which closes the only double-submission window
   * the menu has: selecting a row dismisses the menu, so a second selection requires re-opening it
   * while the first request is still running. Short, but real - and a duplicate DELETE would be
   * answered with a 404 the administrator has no way to interpret.
   */
  const isBusy = roleMutation.isPending || accessMutation.isPending || deleteMutation.isPending;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* Icon-only, composed from token utilities rather than from a dedicated size: the
              primitive has no `icon` size and prescribes exactly this composition. `size="sm"` is
              `h-8`, so `w-8 px-0` squares it, and `[&_svg]:size-4` lifts the glyph from the small
              size's 14px to 16px, which is the proportion a lone glyph needs in a 32px box. Both
              resolve against the variant's own `px-3` and `[&_svg]:size-3.5` in this file's favour.
              `shrink-0` keeps the box from collapsing toward the glyph when the cell becomes a flex
              row below the `md` breakpoint.

              BLITZY [A11Y]: `size="sm"` is 32px, below the 44x44 target-size minimum. The size
              exists for exactly this surface - the primitive's own note says it is "for the dense
              admin row actions in src/components/admin/, where a 44px control in every cell would
              make the moderation tables unusable" - so this is a deliberate, named opt-in rather
              than an accidental small target, and it is flagged here for designer review rather
              than silently enlarged. The menu ROWS it opens are `min-h-11`, so every action the
              trigger leads to clears the floor. */}
          <Button
            ref={triggerRef}
            variant="ghost"
            size="sm"
            className="w-8 shrink-0 px-0 [&_svg]:size-4"
          >
            <Ellipsis aria-hidden="true" />
            {/* The name identifies the record, and it is text rather than an `aria-label` so the
                control has real content and Radix's `aria-labelledby` gives the panel the same
                name when it opens. */}
            <span className="sr-only">Actions for {user.username}</span>
          </Button>
        </DropdownMenuTrigger>

        {/* `align="end"` because the actions column sits at the trailing edge of the table: an
            end-aligned panel opens inward, so it cannot add to the document's scroll width at the
            375px viewport. No `sideOffset`: the panel sits flush against its trigger, which is the
            primitive's documented default and would otherwise require a raw number in a component.
            The primitive portals the panel to the body, so the table's horizontal scroll container
            cannot clip it. */}
        <DropdownMenuContent align="end">
          <DropdownMenuGroup aria-label="Change role">
            {USER_ROLES.map((role) => {
              const isCurrentRole = role === user.role;

              return (
                <DropdownMenuItem
                  key={role}
                  /* THE ATTRIBUTE AND THE PROP SAY DIFFERENT THINGS, AND BOTH ARE NEEDED.
                     `aria-disabled` is the announcement: this row is unavailable, either because
                     it is already the account's role or because a request is in flight.
                     `disabled` is the platform behaviour, and the current row deliberately does
                     NOT get it - the primitive drops a `disabled` row out of arrow-key and
                     typeahead traversal, which would make the account's CURRENT role the one
                     thing a keyboard user could not reach in a menu whose entire purpose is to
                     change it. Selection on that row is neutralised by the handler below instead.

                     The attribute is computed for BOTH cases rather than for the current row
                     alone, and that is not cosmetic. A caller's props spread last onto the
                     primitive, which had already computed `aria-disabled` from its own `disabled`
                     - so passing `undefined` here would REMOVE the attribute the primitive had
                     just set, leaving a busy row visibly dimmed and out of traversal while
                     announcing itself as available. Every branch therefore agrees with the
                     primitive: `true` when unavailable, absent when actionable. */
                  aria-disabled={isCurrentRole || isBusy ? true : undefined}
                  disabled={!isCurrentRole && isBusy}
                  onSelect={
                    isCurrentRole
                      ? (event) => {
                          // Nothing to do, so do not dismiss the menu either: closing it would
                          // look like the selection was accepted. This is the one place the
                          // primitive's keep-open escape hatch is the right tool.
                          event.preventDefault();
                        }
                      : () => {
                          roleMutation.mutate(role);
                        }
                  }
                >
                  {ROLE_ACTION_LABELS[role]}
                  {isCurrentRole ? (
                    /* The state marker. `ms-auto` pushes it to the logical trailing edge of the
                       row, so it follows the writing direction rather than assuming
                       left-to-right. It inherits the row's colour deliberately - a muted token
                       here would not invert with the row and would sit at low contrast on the
                       highlight fill - and it carries the WORD as well as the tick, so the state
                       survives for anyone who cannot see the glyph. */
                    <span className="ms-auto inline-flex items-center gap-1 text-xs">
                      <Check aria-hidden="true" />
                      Current
                    </span>
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>

          {/* The two account-level actions, separated from the role rows by a hairline drawn from
              the border token. The primitive ships no separator part on purpose and states that
              spacing between groups belongs to the caller's layout, so this is that spacing -
              utilities and a semantic token, no literal. */}
          <DropdownMenuGroup
            aria-label="Manage account"
            className="border-border mt-1 border-t pt-1"
          >
            <DropdownMenuItem
              disabled={isBusy}
              onSelect={() => {
                // The payload is the NEGATION of the current state, read straight from the row.
                // `is_active` is snake_case verbatim: there is no camelCase layer in this tier.
                accessMutation.mutate(!user.is_active);
              }}
            >
              {/* Two glyphs, one row: which one paints follows the action, not the state. */}
              {user.is_active ? <UserX aria-hidden="true" /> : <UserCheck aria-hidden="true" />}
              {/* Labelled by the ACTION rather than by the state, so the row says what selecting
                  it will do. A label naming the state would leave the reader to work out whether
                  it is a description or an instruction. */}
              {user.is_active ? 'Deactivate account' : 'Activate account'}
            </DropdownMenuItem>

            <DropdownMenuItem
              variant="destructive"
              disabled={isBusy}
              onSelect={() => {
                // No `preventDefault()`: the menu closes, and the focus handover described in this
                // component's documentation is what puts focus inside the dialog.
                setIsConfirmingDelete(true);
              }}
            >
              <Trash2 aria-hidden="true" />
              {/* The tint is never the only signal - the label says "Delete". */}
              Delete user
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* The confirmation. `DialogContent` renders its own portal, scrim and corner dismiss
          control, so a correct modal is one element and neither `DialogPortal` nor `DialogOverlay`
          belongs here - rendering a second overlay would visibly double the wash. No width is set:
          the primitive's panel is `w-full max-w-lg` inside a padded fixed frame, which is what
          keeps it inside the viewport at 375px without contributing to horizontal overflow.

          `Escape`, an outside press and the corner control all dismiss, and none of them is
          blocked while the request is in flight. Trapping a visitor inside a panel to protect a
          request they can no longer influence would be the wrong trade: the mutation continues and
          its toast still reports the outcome. */}
      <Dialog open={isConfirmingDelete} onOpenChange={setIsConfirmingDelete}>
        <DialogContent
          /* Returns focus to the row's trigger, rather than letting it fall to the document.
             `preventDefault()` suppresses the primitive's own restore - which would aim at the
             menu item that opened this panel, an element that no longer exists - and the explicit
             `focus()` puts the visitor back exactly where they were. Without this pair, cancelling
             a delete drops focus to `<body>`: measured in Chrome, not inferred.

             `focus()` on a detached node is a no-op, which is the right behaviour after a
             SUCCESSFUL delete: the row is on its way out with the refetch, so there is nothing to
             return to and nothing throws. */
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          {/* Names the record, and names it by the handle, which is unique and
              case-insensitively constrained - so the title cannot describe two accounts. */}
          <DialogTitle>Delete {user.username}?</DialogTitle>
          <DialogDescription>
            This permanently deletes {accountLabel(user)} ({user.email}) along with every post,
            comment and like the account owns, and it cannot be undone. Deactivate the account
            instead to stop it signing in while keeping its contributions.
          </DialogDescription>

          {/* One grid item, so the panel's own `gap-4` rhythm holds. `flex-wrap` lets the two
              controls stack rather than overflow if the panel is ever narrower than they are, and
              `justify-end` puts the affirmative action at the trailing edge. */}
          <div className="flex flex-wrap justify-end gap-3">
            {/* The safe action is FIRST in the DOM, which is what Radix's initial focus lands on -
                the correct default for a confirmation that cannot be undone. */}
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              /* The double-submission guard. Disabling the real control is what makes a second
                 press impossible; the label change is what makes the pending state perceivable
                 rather than merely visual, so it is not carried by a spinner alone. */
              disabled={deleteMutation.isPending}
              onClick={() => {
                deleteMutation.mutate();
              }}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete account'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
