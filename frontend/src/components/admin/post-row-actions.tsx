'use client';

// Post row actions - the per-row action menu of the administrative posts table.
//
// One column's `cell` in `@/components/admin/data-table.tsx` renders this component, and the
// coupling runs ONE WAY: `src/app/(admin)/admin/posts/page.tsx` owns the query and injects this
// through a column definition, so nothing here imports the grid, a sibling in this folder, or the
// page. That is what keeps the grid renderable without dragging four entity-specific components
// along with it, and it is why this file has no knowledge of pagination, filtering or sorting.
//
// It exposes exactly the two administrative mutations the plan gives the posts table:
//
//   PATCH /api/v1/admin/posts/{id}/status   force a lifecycle state, whoever wrote the post
//   DELETE /api/v1/admin/posts/{id}         remove a post, whoever wrote it
//
// ---------------------------------------------------------------------------
// 1. THE `/status` SUB-PATH IS NOT INTERCHANGEABLE WITH ANYTHING ELSE
//
// This is the single most important correctness point in the file, because four different
// operations look like they would do the job and three of them are wrong:
//
//   * `updateAdminPostStatus` from `@/lib/api/admin` - PATCH /admin/posts/{id}/status. CORRECT.
//     Administrator authority, reaches every lifecycle state including ARCHIVED, and the service
//     maintains the publication instant alongside the state so the pair cannot fall out of step.
//   * `updatePost` from `@/lib/api/posts` - PATCH /posts/{id}. WRONG. That is the author's partial
//     CONTENT edit and cannot change a lifecycle state at all.
//   * `publishPost` / `unpublishPost` from `@/lib/api/posts` - POST /posts/{id}/publish and
//     /unpublish. WRONG. Those are the AUTHOR's first-class transitions and carry different
//     authority semantics; routing an administrator through them would quietly bypass the
//     administrative path the dashboard is meant to exercise, and neither can archive.
//   * `updateAdminUser` / `updateAdminCategory` - those address their RESOURCE directly, with no
//     sub-path. The asymmetry is deliberate: on this namespace only the post and comment STATUS
//     mutations address a sub-resource. `@/lib/api/admin` says outright not to regularise it.
//
// So this file imports from `@/lib/api/admin` and from nowhere else on the transport side, and it
// imports NOTHING from `@/lib/api/posts`. It contains no URL, no method, no header and no
// status-code branch: `@/lib/api/admin` wraps the routes and `@/lib/api/client` is the tier's only
// HTTP module. A stray `fetch` here would also fail the component suite outright, because request
// interception is configured to error on any request no handler claims.
//
// ---------------------------------------------------------------------------
// 2. NO OPTIMISTIC UPDATES, AND THIS IS THE FILE THAT MOST NEEDS THE RULE
//
// Optimism is confined to the like button and the comment surface, where a failed attempt is safe
// to retry and the latency is visible enough to matter. A FORCED STATUS CHANGE is the exact
// opposite: it is the operation an operator must not be misled about. Painting a row as PUBLISHED
// before the service has agreed would show a post as publicly visible when it may still be a
// draft - and the refusal that produced it (a `403` from `require_admin`, a `404` from a post
// another operator deleted a moment earlier) would arrive after the lie had already been read.
//
// Every state this component renders is therefore derived from the `post` prop - the server's own
// answer - and never from local mutation state. Nothing is written into the cache by hand. On
// success the affected keys are invalidated and the grid re-reads.
//
// ---------------------------------------------------------------------------
// 3. THE MENU-TO-MODAL FOCUS HANDOFF, WHICH IS NOT AUTOMATIC
//
// A destructive menu item that opens a modal is a documented trap. The menu closes as part of the
// selection, its focus scope unmounts and RESTORES FOCUS TO THE TRIGGER, and the dialog that just
// mounted is left without it - so a keyboard user is dropped back on the row while a modal they
// cannot reach sits on screen.
//
// Two halves fix it, and both are explicit here rather than hoped for:
//
//   a. The dialog's open state is HOISTED ABOVE BOTH, and the dialog is a SIBLING of the menu
//      rather than a descendant of its content. A descendant would be unmounted the instant the
//      menu closed, taking the modal with it.
//   b. `onCloseAutoFocus` on the menu content suppresses the menu's focus restoration for exactly
//      the one selection that hands off to the dialog, and for no other. Escape, an outside press
//      and every non-destructive selection keep the restoration, because losing it there would
//      strand focus on the document body. The intent is carried in a ref rather than in state
//      precisely because it must not cause a render.
//
// The return journey is explicit too. A controlled dialog has no `DialogTrigger` to restore focus
// to, and the element that was focused when it opened - the menu item - is gone by then. So
// `onCloseAutoFocus` on the dialog content sends focus back to the row's action trigger, which is
// where the visitor was and the only stable landing point in the row.
//
// ---------------------------------------------------------------------------
// 4. EVERY VALUE IS A TOKEN, AND EVERY PRIMITIVE IS THE PROJECT'S OWN
//
// No literal colour, length, radius, shadow or font size appears below. The status pill's tone
// comes from `POST_STATUS_BADGE_VARIANTS`, which `@/components/ui/badge` maintains as an
// exhaustive table over `PostStatus` - so a fourth lifecycle state would fail to compile rather
// than render an arbitrary colour here. The destructive menu row uses the primitive's own
// `destructive` variant, which exists for exactly these admin deletes. There is no raw `<button>`,
// `<select>`, `<input>` or `<table>`, no `dark:` conditional (the token layer is dual-valued, so
// this file re-themes for free), no stylesheet, no custom media query and no `!important`.
//
// Focus indicators are deliberately NOT restated. `src/app/globals.css` sets a document-wide
// `:focus-visible` outline floor from `--color-ring`, and the button and menu-item primitives layer
// their own ring on top at the same width - so the trigger, all four menu rows and both dialog
// controls are already ringed, and a fourth declaration here would be a competing source of truth.
//
// ---------------------------------------------------------------------------
// 5. DELIBERATELY ABSENT - DO NOT ADD
//
//   1. `window.confirm`. It cannot be token-styled, manages no focus, and is not among the browser
//      APIs the component suite's environment provides - `matchMedia`, `ResizeObserver`,
//      `IntersectionObserver`, `scrollIntoView`, pointer capture and `DOMRect` are the whole list.
//      The same reasoning rules out `navigator.clipboard`, `document.execCommand` and `localStorage`.
//   2. An inline title or content editor, a slug field, scheduled publishing, a bulk action,
//      revision history, and a "view public page" link. None is named in the plan. The slug in
//      particular is derived once at creation and never changes, because it IS the canonical URL the
//      SEO requirement depends on, so presenting it as editable would be actively wrong; and a
//      public-view link would misrepresent a DRAFT, which is not publicly reachable at all.
//   3. Any React Query default. `@/providers/query-provider` sets `staleTime`, `gcTime`,
//      `refetchOnWindowFocus` and the retry policy for the whole tier - mutations at `retry: 0`,
//      because a mutation is not safe to blindly repeat. Restating any of them here would be a
//      second source of truth that could drift.
//   4. A `<Toaster />`. The host is mounted once in `src/app/layout.tsx`; a second one would render
//      every toast twice.
//   5. Any environment variable. Nothing here is configurable per deployment.
//   6. A client-side role check as a gate. `require_admin` on the service's admin router is the
//      boundary; hiding a control is user experience, not authorisation. Which is why a `403` is
//      surfaced as a real, legible error here rather than swallowed - see `resolveErrorMessage`.
//   7. `DropdownMenuRadioGroup`/`DropdownMenuRadioItem`, although the primitive does export them.
//      A radio group is driven by a `value` and cannot express either half of what this menu needs:
//      the current state must be genuinely NON-ACTIONABLE, and every row must go inert while a
//      mutation is in flight so a second, conflicting transition cannot be launched. Plain items
//      with `disabled` express both, and the current state is still exposed three ways - the pill in
//      the cell, `aria-current` on the row, and a tick plus the word "Current" beside its label.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, MoreHorizontal, Trash2 } from 'lucide-react';
import { useRef, useState, type JSX } from 'react';
import { toast } from 'sonner';

import { POST_STATUS_BADGE_VARIANTS, Badge } from '@/components/ui/badge';
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
import { deleteAdminPost, updateAdminPostStatus } from '@/lib/api/admin';
import { isApiError } from '@/lib/api/client';
import { POST_STATUSES, type AdminPost, type PostStatus } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Cache invalidation lives in `@/lib/admin-cache`, not here
 *
 * Neither of this file's mutations names a query key any more, and that is a correctness change
 * rather than tidying. Both invalidations were wrong while they were local, in the same way: they
 * refreshed the entity this component is named after and nothing else, and BOTH of this file's
 * mutations stale rows in a table this component never mentions.
 *
 * A forced status change moves `post_count` on the CATEGORY table, because that tally is a `COUNT`
 * over published posts rather than a stored column - so publishing a filed draft left the category
 * listing one short. A deletion cascades the post's comments, so it stales the MODERATION QUEUE as
 * well, and removes the `post_categories` filings that fed the same tally.
 *
 * Neither fact is visible from inside a posts row action, which is exactly why the dependency graph
 * is declared once, next to the server behaviour that justifies each edge, and consulted from here.
 * See that module's header for the full graph and for why each invalidation is awaited.
 * ---------------------------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------------------------------
 * Labels
 *
 * Both tables are `Record` over the `PostStatus` union rather than conditionals, so they are
 * EXHAUSTIVE AT COMPILE TIME: if the service ever adds a fourth lifecycle state, the union widens and
 * these objects fail to type-check until the new state has been given words. A `switch` would instead
 * fall through to whichever branch it happened to end on and mislabel the row silently.
 *
 * Held here rather than in `@/components/ui/badge`, which deliberately carries no labels: the same
 * state is worded differently in different places, and a single shared table could not serve both
 * without becoming a translation layer this project does not have.
 * ---------------------------------------------------------------------------------------------- */

/** The state a post is IN, for the row's pill and for the checked menu row. */
const POST_STATUS_LABELS: Readonly<Record<PostStatus, string>> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
};

/**
 * The state a menu row MOVES a post to.
 *
 * Phrased as a complete instruction rather than as a bare noun so each row's accessible name says
 * what activating it does, which is what `role="menuitem"` promises a screen reader.
 */
const POST_STATUS_ACTION_LABELS: Readonly<Record<PostStatus, string>> = {
  DRAFT: 'Set status to draft',
  PUBLISHED: 'Set status to published',
  ARCHIVED: 'Set status to archived',
};

/**
 * Announced by the pill and read into the success toast, in the past tense the wire uses nowhere.
 *
 * Separate from {@link POST_STATUS_LABELS} because "is now Published." reads as a label pasted into
 * a sentence, while "is now published." reads as a sentence.
 */
const POST_STATUS_SENTENCE_LABELS: Readonly<Record<PostStatus, string>> = {
  DRAFT: 'a draft',
  PUBLISHED: 'published',
  ARCHIVED: 'archived',
};

/**
 * Accessible name of the group holding the three lifecycle rows.
 *
 * Radix renders `role="group"` there, so this name is what tells a screen reader that the rows
 * beneath it are one setting rather than three unrelated commands.
 */
const STATUS_GROUP_LABEL = 'Post status';

/** Marker on the row whose state the post is already in. Visible text, not a glyph alone. */
const CURRENT_STATUS_MARKER = 'Current';

/** Label of the destructive row, and of the dialog's confirm control at rest. */
const DELETE_ACTION_LABEL = 'Delete post';

/** Label of the confirm control while its request is on the wire. */
const DELETE_PENDING_LABEL = 'Deleting…';

/** Title of the confirmation modal. Radix links it to the panel through `aria-labelledby`. */
const DELETE_DIALOG_TITLE = 'Delete this post?';

/** Dismissal control of the confirmation modal. */
const CANCEL_ACTION_LABEL = 'Cancel';

/**
 * Shown when a post carries no usable title.
 *
 * `AdminPost.title` is typed as a `string`, so this is not a type gap - it is the defensive floor
 * that keeps an empty or whitespace-only title from producing the accessible name "Actions for ",
 * which would leave the one control in the row unnamed. Never renders the words "null" or
 * "undefined" as visible text.
 */
const UNTITLED_POST_LABEL = 'Untitled post';

/** Fallback when a status change fails and the failure carried no readable description. */
const STATUS_FAILURE_FALLBACK = 'The post’s status could not be changed. Please try again.';

/** Fallback when a deletion fails and the failure carried no readable description. */
const DELETE_FAILURE_FALLBACK = 'The post could not be deleted. Please try again.';

/* -------------------------------------------------------------------------------------------------
 * Presentation classes
 *
 * Every class below is a token utility or a layout utility generated from `--spacing`,
 * `--breakpoint-*` and `--container-*`. There is no literal colour, length, radius, shadow or font
 * size, and the only literals in the file at all are `0` (`px-0`) and `transparent`, which the
 * `ghost` button variant supplies rather than this file.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The cell's own row: the status pill, then the action trigger.
 *
 * `justify-end` is what right-aligns the pair at `md` and up, where the column is declared
 * `align: 'end'` and the cell is a real `<td>`. Below `48rem` it is inert and harmless: the table
 * primitive turns each cell into a `justify-between` label/value row, so this element is already the
 * trailing item and sizes to its own content.
 *
 * No breakpoint logic and no width. The three-tier responsive contract - one card per record below
 * `48rem`, a table whose excess width scrolls inside its own container from `48rem`, every column
 * from `64rem` - belongs to `@/components/ui/table` and the grid, and a second responsive layer here
 * would fight the one the 768px viewport project measures. Radix portals both the menu panel and the
 * modal to the document body, so neither is clipped by that scroll container and neither can add to
 * the document's own scroll width.
 */
const ROOT_CLASSES = 'flex items-center justify-end gap-2';

/**
 * The icon-only trigger.
 *
 * `w-8 px-0` squares the `sm` size, which is `h-8` with inline padding: dropping the padding and
 * matching the width to the height is the composition the button's size table prescribes instead of a
 * dedicated `icon` size, and `tailwind-merge` resolves both against the variant's own `px-3` in this
 * file's favour. `[&_svg]:size-4` lifts the glyph from the `sm` size's 14px to 16px, the proportion a
 * lone glyph needs inside a 32px box. `shrink-0` is layout rather than appearance and belongs at the
 * call site: the control is always a flex item beside the pill, and a flex item's automatic minimum
 * size is content-based, so without it the square would collapse toward the glyph in a narrow cell.
 *
 * BLITZY [A11Y]: this control is 32x32, below the WCAG 2.5.5 44x44 target-size minimum. Deliberate
 * and opted into by name: `size="sm"` exists for exactly the dense administrative row actions in this
 * folder - a 44px control in every cell of a moderation table would make the table unusable - and the
 * button primitive carries the same flag on that size for the same reason. The default size clears the
 * floor, so no surface gets a small target unless it asks. Implemented as specified and flagged for
 * designer review rather than silently enlarged.
 */
const TRIGGER_CLASSES = 'w-8 shrink-0 px-0 [&_svg]:size-4';

/**
 * Gutter reserving the tick's width on EVERY lifecycle row, checked or not, so the three labels line
 * up instead of shifting by the width of a glyph as the state moves. Mirrors the indicator gutter the
 * menu primitive's own radio rows use, and it is the same 4-step box the primitive sizes icons to.
 *
 * The menu row is a flex container, so this `<span>` is blockified as a flex item and the size applies
 * - which it would not on an inline element.
 */
const STATUS_INDICATOR_CLASSES = 'flex size-4 shrink-0 items-center justify-center';

/**
 * The "Current" marker beside the checked row's label.
 *
 * `ms-auto` pushes it to the row's logical inline end, so it follows the writing direction rather than
 * assuming left-to-right. `text-muted-foreground` recedes it below the label without hiding it, and
 * `text-xs` matches the pill's own step.
 */
const CURRENT_MARKER_CLASSES = 'text-muted-foreground ms-auto text-xs';

/**
 * Separation between the lifecycle group and the destructive one.
 *
 * The menu primitive exports no separator part and says so deliberately - spacing between groups is
 * the caller's layout, not the primitive's - so the hairline is composed here from the decorative
 * border token, inset by the panel's own padding. A destructive action sharing an unbroken list with
 * three routine ones is the kind of adjacency that gets mis-clicked.
 */
const DESTRUCTIVE_GROUP_CLASSES = 'border-border mt-1 border-t pt-1';

/**
 * A long unbroken title - a pasted URL, a slug - would otherwise establish a min-content width wider
 * than the panel and overflow it. `wrap-anywhere` is `overflow-wrap: anywhere`, which is the one value
 * that reduces min-content intrinsic size; `break-words` does not, and would look like a safeguard
 * while doing nothing.
 */
const DIALOG_DESCRIPTION_CLASSES = 'wrap-anywhere';

/**
 * The modal's action row.
 *
 * `flex-col-reverse` at the narrow viewport stacks the controls with the destructive one on top,
 * where the thumb is, and `sm:flex-row sm:justify-end` restores the conventional trailing pair from
 * `40rem` - the first of the five catalogued breakpoints, and the only one this file names.
 */
const DIALOG_ACTIONS_CLASSES = 'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end';

/* -------------------------------------------------------------------------------------------------
 * Failure reporting
 * ---------------------------------------------------------------------------------------------- */

/**
 * Turn a rejected mutation into one line a person can read.
 *
 * `@/lib/api/client` normalises EVERY failure path into an `ApiError` carrying a well-formed problem
 * document - a domain refusal, a request-validation failure, a rate-limit rejection, an unreachable
 * service, an aborted request - so there is exactly one shape to interrogate and never a status-code
 * branch. `problem.detail` is what the service writes to be safe to show; `problem.title` is the
 * human-readable half of a document this tier synthesised, where `detail` is the empty string rather
 * than absent, which is why this is an emptiness test and not a nullish one.
 *
 * **A `403` reaches the operator as a real error.** `require_admin` on the service's admin router is
 * the authorisation boundary, and a refusal from it is information - it means the credential in play
 * is not privileged, or no longer is. Swallowing it, or replacing it with a generic "something went
 * wrong", would leave an operator retrying an action that cannot succeed.
 *
 * Total by construction: every branch returns a non-empty string, so a caller never has to guard the
 * result and no toast can render an empty body.
 *
 * @param error - The rejection value, as caught. Anything at all.
 * @param fallback - Shown when the rejection carried no readable description, or was not an
 *   `ApiError` at all - a bug in this component would arrive that way.
 * @returns A non-empty message.
 */
function resolveErrorMessage(error: unknown, fallback: string): string {
  if (isApiError(error)) {
    const detail = error.problem.detail.trim();
    if (detail !== '') {
      return detail;
    }

    const title = error.problem.title.trim();
    if (title !== '') {
      return title;
    }
  }

  return fallback;
}

/* -------------------------------------------------------------------------------------------------
 * Component
 * ---------------------------------------------------------------------------------------------- */

/** Props of {@link PostRowActions}. */
export interface PostRowActionsProps {
  /**
   * The row this menu acts on, exactly as `GET /api/v1/admin/posts` returned it.
   *
   * The administrative listing is the one listing in the whole API that bypasses public status
   * scoping, so a `DRAFT` or `ARCHIVED` post here is normal rather than exceptional - which is why
   * every state below is written to read correctly for a draft, including its `published_at` of
   * `null`. That field is deliberately not rendered by this component at all: a management row acts
   * on posts, it does not describe them.
   *
   * This prop is the ONLY source of the state this component renders. Nothing is derived from
   * in-flight mutation state, so what the operator sees is always what the service last said.
   */
  readonly post: AdminPost;

  /**
   * Called after a status change or a deletion the service accepted, once the affected query keys
   * have been invalidated.
   *
   * Optional, and independent of cache invalidation - that happens either way. This is the hook for
   * whatever the SCREEN owes the operator that the cache cannot express: returning to the first page
   * after deleting the last row of the last one, closing a filter panel, moving focus. A screen with
   * nothing to do simply omits it.
   */
  readonly onChanged?: () => void;
}

/**
 * The per-row action menu of the administrative posts table: the post's current lifecycle state, a
 * forced transition to any of the three states, and a confirmed deletion.
 *
 * Renders a status pill and one action trigger. Everything else - the menu panel and the confirmation
 * modal - is portalled to the document body by Radix, so the control stays compact enough for a narrow
 * cell and neither panel can be clipped by the grid's horizontal scroll container.
 *
 * Both mutations settle on the server's response. Neither writes to the cache by hand, and neither is
 * optimistic: see section 2 of this file's header for why a forced status change in particular must
 * not be.
 *
 * @param post - The row to act on. See {@link PostRowActionsProps.post}.
 * @param onChanged - Optional post-success hook. See {@link PostRowActionsProps.onChanged}.
 * @returns The rendered pill and menu.
 *
 * @example A column definition on the administrative posts screen. The coupling runs one way - the
 * page injects this, and this knows nothing of the page.
 * ```tsx
 * const columns: DataTableColumn<AdminPost>[] = [
 *   { id: 'title', header: 'Title', cell: (post) => post.title },
 *   {
 *     id: 'actions',
 *     header: 'Actions',
 *     align: 'end',
 *     cell: (post) => <PostRowActions post={post} onChanged={returnToFirstPage} />,
 *   },
 * ];
 * ```
 */
export function PostRowActions({ post, onChanged }: PostRowActionsProps): JSX.Element {
  const queryClient = useQueryClient();

  // Hoisted ABOVE both the menu and the dialog, which is half of what makes the handoff in section 3
  // work: the dialog is a sibling of the menu, so the menu closing cannot unmount it.
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  // Where focus goes when the modal closes. A controlled dialog has no `DialogTrigger` to restore to,
  // and the element focused when it opened - the menu row - no longer exists by then.
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Whether the menu is closing in order to hand focus to the modal. A ref rather than state because
  // it must not cause a render, and because it is read inside an event handler during the same commit
  // that sets it - a state update would not have landed yet.
  const isHandingOffToDialog = useRef(false);

  // The record's name, used for the trigger's accessible name, the modal's copy and both toasts. The
  // trim guard is the defensive floor described at UNTITLED_POST_LABEL: a blank title must not be able
  // to leave the row's only control unnamed.
  const title = post.title.trim() === '' ? UNTITLED_POST_LABEL : post.title;

  const statusMutation = useMutation({
    // The `/status` SUB-PATH, and deliberately not `updatePost`, `publishPost` or `unpublishPost` -
    // see section 1 of the header. `status` is required by the contract, so there is no partial form
    // of this request.
    mutationFn: (status: PostStatus) => updateAdminPostStatus(post.id, { status }),
    onSuccess: async (updated): Promise<void> => {
      // AWAITED, and the `await` is the fix rather than a style choice.
      //
      // React Query holds a mutation `isPending` until this handler's promise settles, and `isBusy`
      // below is derived from that - so awaiting here is what keeps the menu closed until the table
      // in front of the operator actually shows the new state. Dropping the promise instead ended the
      // pending state the moment the WRITE returned, one refetch too early: the pill repainted the
      // OLD status, the menu re-opened offering the same transition, and a second press sent a second
      // `PATCH` for a change that had already happened.
      //
      // It is deliberately not solved by painting the new state early. That is the optimism section 2
      // of this file's header rules out, and on a forced transition in particular: what the operator
      // must see is the state the SERVICE resolved, not the one this component asked for.
      //
      // Which keys go stale is decided by `@/lib/admin-cache`, because a status change also moves
      // `post_count` on the category table - see the note above the imports.
      await invalidateForAdminMutation(queryClient, 'post.status');

      // Reported from the state the SERVICE returned rather than the one requested, so the message
      // cannot claim a transition the service resolved differently.
      toast.success(`“${title}” is now ${POST_STATUS_SENTENCE_LABELS[updated.status]}.`);
      onChanged?.();
    },
    onError: (error) => {
      toast.error(resolveErrorMessage(error, STATUS_FAILURE_FALLBACK));
    },
    // No `retry`, `staleTime`, `gcTime` or `refetchOnWindowFocus` here or in the mutation below. The
    // tier's defaults live in `@/providers/query-provider` - mutations at `retry: 0` - and restating
    // one would be a second source of truth.
  });

  const deleteMutation = useMutation({
    // `204 No Content`, so nothing is parsed and there is no updated record to report. The cascade -
    // the post's comments and likes going with it - is the service's concern, enforced by
    // `ON DELETE CASCADE`, and is never simulated here.
    mutationFn: () => deleteAdminPost(post.id),
    onSuccess: async (): Promise<void> => {
      // Dismissed only now that the service has agreed. Closing on submit would have hidden a refusal
      // behind a modal that had already gone.
      setIsConfirmingDelete(false);

      // AWAITED, for the reason on the status mutation above, and here the cost of not awaiting was
      // worse: the row stayed actionable over a post the service had already removed, so a second
      // press sent a `DELETE` answered `404` - a failure the operator has no way to interpret, because
      // the row they pressed was still on screen.
      //
      // The cascade is the service's - `ON DELETE CASCADE` takes the post's comments and likes - and
      // it is never simulated here. It is, though, what makes the moderation queue and the category
      // tallies stale as well as this table; `@/lib/admin-cache` owns that list.
      await invalidateForAdminMutation(queryClient, 'post.delete');

      toast.success(`“${title}” was deleted, along with its comments and likes.`);
      onChanged?.();
    },
    onError: (error) => {
      // The modal deliberately stays OPEN on failure, so the operator can read the reason and decide,
      // rather than being returned to a table that looks unchanged for no stated cause.
      toast.error(resolveErrorMessage(error, DELETE_FAILURE_FALLBACK));
    },
  });

  const isDeleting = deleteMutation.isPending;

  // Any request in flight makes every row inert. Two conflicting transitions launched a moment apart
  // would resolve in whichever order the network chose, and the loser would silently overwrite the
  // winner - so the menu refuses to start a second one rather than racing.
  const isBusy = statusMutation.isPending || isDeleting;

  /**
   * Runs as the menu's focus scope tears down.
   *
   * `preventDefault()` here suppresses the menu's focus restoration, and it has to be understood
   * precisely: the primitive composes this handler BEFORE its own, and its own is what imperatively
   * focuses the trigger, so preventing the default is what stops that from happening at all. Done for
   * exactly the one selection that opens the modal, and reset immediately - Escape, an outside press
   * and the three lifecycle selections all keep the restoration, because suppressing it there would
   * leave focus on the document body.
   */
  function handleMenuCloseAutoFocus(event: Event): void {
    if (!isHandingOffToDialog.current) {
      return;
    }

    isHandingOffToDialog.current = false;
    event.preventDefault();
  }

  /**
   * Runs as the modal's focus scope tears down, however it was dismissed - the confirm control, the
   * Cancel control, the corner close, Escape or an outside press.
   *
   * Sends focus back to the row's action trigger, which is where the visitor was and the only stable
   * landing point in the row. `preventDefault()` first, because the element the dialog would otherwise
   * restore to is the menu row that no longer exists. Safe when the row itself has gone: the ref is
   * `null` after unmount, and this handler cannot run at all once the component is gone.
   */
  function handleDialogCloseAutoFocus(event: Event): void {
    event.preventDefault();
    triggerRef.current?.focus();
  }

  /**
   * Opens the confirmation modal from the destructive menu row.
   *
   * `onSelect` is deliberately NOT prevented: the menu should close, and the ref above is what keeps it
   * from taking focus with it. Preventing it instead would leave a menu panel open underneath a modal.
   */
  function handleDeleteSelected(): void {
    isHandingOffToDialog.current = true;
    setIsConfirmingDelete(true);
  }

  /**
   * The single guard on every one of the modal's dismissal paths.
   *
   * Radix routes Escape, an outside press, the corner close and any `DialogClose` through
   * `onOpenChange`, so one test here covers all five: a deletion already on the wire must not be
   * dismissed out from under itself, because the request cannot be recalled and closing would hide its
   * outcome. `onSuccess` and `onError` are what release it.
   */
  function handleConfirmOpenChange(nextOpen: boolean): void {
    if (deleteMutation.isPending) {
      return;
    }

    setIsConfirmingDelete(nextOpen);
  }

  return (
    <div className={ROOT_CLASSES} aria-busy={isBusy}>
      {/* The state at a glance, so a DRAFT row is distinguishable in a listing that spans every
          lifecycle state. Its tone comes from the primitive's exhaustive table rather than from a
          colour chosen here, and its LABEL is always present - the tone reinforces the state and
          never carries it, so the row reads correctly for anyone who cannot distinguish these
          colours. This is also the reading that assistive technology gets: it is plain text in the
          cell, independent of the menu. */}
      <Badge variant={POST_STATUS_BADGE_VARIANTS[post.status]}>
        {POST_STATUS_LABELS[post.status]}
      </Badge>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* The accessible name IDENTIFIES THE RECORD. A full table would otherwise present as many
              identically-named controls as it has rows, which is unusable by voice control and
              ambiguous in a screen reader's element list. Radix labels the panel with this same name
              through `aria-labelledby`, so the menu inherits it - which is also why no explicit `id`
              is passed here: one would replace the generated id the panel's label points at. */}
          <Button
            ref={triggerRef}
            variant="ghost"
            size="sm"
            className={TRIGGER_CLASSES}
            aria-label={`Actions for ${title}`}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>

        {/* `align="end"` because the column is the trailing one: an end-aligned panel opens inward, so
            it cannot push the document's scroll width at the 375px viewport. Nothing else is
            positioned - the panel sits flush against its trigger, which is the primitive's documented
            default and the same distance every other floating surface in the tier keeps. No width
            either: the primitive already bounds the panel below the narrow viewport. */}
        <DropdownMenuContent align="end" onCloseAutoFocus={handleMenuCloseAutoFocus}>
          {/* The lifecycle group. Named, because `role="group"` with three state rows inside it is
              what tells a screen reader these are one setting rather than three unrelated commands.

              All three states are offered - this is the administrative transition, and it reaches
              ARCHIVED, which the author's own publish and unpublish routes cannot. */}
          <DropdownMenuGroup aria-label={STATUS_GROUP_LABEL}>
            {POST_STATUSES.map((status) => {
              const isCurrent = status === post.status;

              return (
                <DropdownMenuItem
                  key={status}
                  // Non-actionable when it is the state the post is already in, and inert for every
                  // row while a request is in flight. The primitive turns this into `aria-disabled`,
                  // dims the row and drops it out of arrow-key and typeahead traversal.
                  disabled={isCurrent || isBusy}
                  // The programmatic half of "which one is current". The visible half is the tick and
                  // the marker text beside it, and the pill in the cell carries it a third time -
                  // deliberately, because a disabled row is not reachable by keyboard, so the pill is
                  // what a screen-reader user actually reads the state from.
                  aria-current={isCurrent ? 'true' : undefined}
                  onSelect={() => {
                    statusMutation.mutate(status);
                  }}
                >
                  <span aria-hidden="true" className={STATUS_INDICATOR_CLASSES}>
                    {isCurrent ? <Check aria-hidden="true" /> : null}
                  </span>

                  {isCurrent ? (
                    <>
                      {POST_STATUS_LABELS[status]}
                      {/* An explicit space, and it is load-bearing rather than cosmetic. Without it
                          the label text node and the marker element below are adjacent with no
                          whitespace between them, and accessible-name computation concatenates
                          adjacent inline content verbatim - measured, the row announced as the single
                          word "PublishedCurrent". It costs nothing visually: a whitespace-only text
                          run in a flex container is not rendered as an anonymous flex item at all,
                          and the marker is pushed to the row's far end regardless. */}{' '}
                      <span className={CURRENT_MARKER_CLASSES}>{CURRENT_STATUS_MARKER}</span>
                    </>
                  ) : (
                    POST_STATUS_ACTION_LABELS[status]
                  )}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>

          {/* The irreversible action, in its own group behind a hairline. The primitive's own
              `destructive` treatment exists for exactly this row, so no colour is chosen here - and
              the row still says what it does in words, which is what carries the meaning when the
              tint cannot be seen. */}
          <DropdownMenuGroup className={DESTRUCTIVE_GROUP_CLASSES}>
            <DropdownMenuItem
              variant="destructive"
              disabled={isBusy}
              onSelect={handleDeleteSelected}
            >
              <Trash2 aria-hidden="true" />
              {DELETE_ACTION_LABEL}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* A SIBLING of the menu, controlled from state hoisted above both. Radix supplies
          `role="dialog"`, focus trapping, Escape, scroll locking and the `aria-labelledby` /
          `aria-describedby` wiring from the title and description below, so none of it is written
          here. `DialogContent` renders its own portal, overlay and corner close.

          It notably does NOT emit `aria-modal`, and none is added here. This version of the
          primitive conveys modality by marking the rest of the document `aria-hidden` instead -
          confirmed in a browser, where opening this dialog put `aria-hidden="true"` on the sibling
          body content and `overflow: hidden` on the body - which `@/components/ui/dialog` records as
          a measured fact. Adding the attribute would state the same thing twice. */}
      <Dialog open={isConfirmingDelete} onOpenChange={handleConfirmOpenChange}>
        <DialogContent onCloseAutoFocus={handleDialogCloseAutoFocus}>
          <DialogTitle>{DELETE_DIALOG_TITLE}</DialogTitle>

          {/* Names the record AND states the real consequence. The cascade is not a warning invented
              for reassurance - deleting a post removes its comments and likes, enforced by the
              database rather than by anything client-side - and an operator who is not told that is
              being asked to confirm something other than what happens. Built as one template literal
              so the typographic quotes are JavaScript string content rather than JSX text. */}
          <DialogDescription className={DIALOG_DESCRIPTION_CLASSES}>
            {`“${title}” will be permanently deleted, together with every comment and like it has received. This cannot be undone.`}
          </DialogDescription>

          <div className={DIALOG_ACTIONS_CLASSES}>
            {/* Dismissal, routed through the same `onOpenChange` guard as every other path. Disabled
                while the request is on the wire, matching the confirm control - offering a way out of
                a modal whose action cannot be recalled would only misrepresent what cancelling does. */}
            <DialogClose asChild>
              <Button variant="secondary" disabled={isDeleting}>
                {CANCEL_ACTION_LABEL}
              </Button>
            </DialogClose>

            {/* The pending state is in the LABEL, not only in the dimming: a control that merely looks
                different has told a screen-reader user nothing, and `aria-busy` alone is advisory.
                Changing the accessible name is what makes the wait perceivable everywhere. */}
            <Button
              variant="destructive"
              disabled={isDeleting}
              aria-busy={isDeleting}
              onClick={() => {
                deleteMutation.mutate();
              }}
            >
              <Trash2 aria-hidden="true" />
              {isDeleting ? DELETE_PENDING_LABEL : DELETE_ACTION_LABEL}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
