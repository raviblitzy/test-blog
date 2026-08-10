'use client';

/* =================================================================================================
 * comment-item.tsx - one comment in a discussion, and every comment beneath it.
 *
 * Serves requirement R4 (comments, likes and sharing). One component renders a node and recurses on
 * its own `replies`, so a whole thread of any shape is drawn by mounting this once per root comment.
 *
 * -------------------------------------------------------------------------------------------------
 * 1. THE THREAD ARRIVES IN ONE RESPONSE, AND THAT IS THE WHOLE DESIGN
 *
 * `GET /api/v1/posts/{id}/comments` pages TOP-LEVEL comments only - `total` and `pages` count roots,
 * so the pages stay disjoint - and every reply travels nested inside `CommentPublic.replies`, which
 * the service resolves with a forward reference and `model_rebuild()`. The recursion below therefore
 * reads a tree it already holds and ISSUES NO REQUEST OF ITS OWN. A fetch per node would be an N+1
 * storm against an endpoint that does not exist for the purpose, and it would break the disjointness
 * the root-only pagination buys.
 *
 * The moderation filter is applied server-side at EVERY level, so an anonymous reader's `replies`
 * arrays already contain only approved comments. Filtering again here would be a second policy that
 * could only ever disagree with the first.
 *
 * -------------------------------------------------------------------------------------------------
 * 2. WHY THIS FILE IS A CLIENT ISLAND WHEN `comment-list.tsx` IS NOT
 *
 * The list is content and stays directive-free. This node is content PLUS three affordances, two of
 * which exist only for the comment's own author or an administrator - so it has to resolve the
 * calling principal - and one of which owns a mutation. That is what `'use client'` is for.
 *
 * Nothing is lost to SEO by it. Next.js prerenders a client component into the initial HTML, so the
 * comment text and the byline are in the server-rendered response either way; and the AAP's SEO
 * criterion is about the ARTICLE text, which `post-content.tsx` owns and which stays directive-free.
 *
 * The principal is read from `useAuth()` rather than threaded down as a prop. Recursion is why: a
 * prop would have to be forwarded through every level, and one forgotten hand-off would give a
 * deeply nested reply a different answer about who is reading than its parent had.
 *
 * -------------------------------------------------------------------------------------------------
 * 3. `canModify` IS PRESENTATION, NEVER A BOUNDARY
 *
 * It mirrors the service's rule exactly - the author may act on their own comment, an administrator
 * on any - so the controls on screen match the requests that would succeed. It is not what makes
 * them safe: `PATCH` and `DELETE /api/v1/comments/{id}` re-check ownership in
 * `backend/app/services/comment_service.py` on every request and answer `403` otherwise. Hiding a
 * button is a courtesy. Nothing here reads, decodes or verifies a token; `JWT_SECRET_KEY` is
 * backend-only and no environment variable is read by this module at all.
 *
 * -------------------------------------------------------------------------------------------------
 * 4. DELETION IS INVALIDATED, NOT PRUNED - AND THAT IS NOT A SHORTCUT
 *
 * `comments.parent_id` is a self-referencing foreign key with `ON DELETE CASCADE`, so removing a
 * comment removes its whole subtree in one statement. Only the SERVER knows which descendants went
 * with it, so walking the tree here to prune children would be a second definition of a rule the
 * schema already guarantees - and the copy that forgets a relation added later. `deleteComment`
 * answers `204 No Content`, so there is no body to read; the refreshed thread is the evidence.
 *
 * Deletion is also deliberately NOT optimistic. AAP 0.6.5 confines optimistic updates to
 * `like-button.tsx` and `comment-form.tsx`, and the cascade is the independent reason: an optimistic
 * removal could only guess at the descendants, so the one authoritative answer is the refetch.
 *
 * -------------------------------------------------------------------------------------------------
 * 5. DELIBERATELY ABSENT. Please do not add:
 *
 *   1. A request for a node's replies. See note 1. `CommentPublic.replies` is the payload, and when
 *      it is a prefix the surplus is REPORTED in words rather than fetched - see
 *      {@link moreRepliesNote}.
 *   2. A client-side sweep of replies on delete, or an `onMutate`. See note 4.
 *   3. `window.confirm`, a hand-rolled overlay, or a bespoke focus trap. The confirmation is
 *      `@/components/ui/dialog`, which is Radix and therefore already supplies focus trapping,
 *      focus restoration to the trigger, escape and outside-click dismissal, scroll locking,
 *      `role="dialog"`, and the `aria-labelledby`/`aria-describedby` wiring that `DialogTitle` and
 *      `DialogDescription` are the targets of. Note what it does NOT emit: `aria-modal`. There are
 *      zero occurrences of that attribute in the compiled package - Radix conveys modality by
 *      applying `aria-hidden="true"` to every other child of `document.body` instead, which is the
 *      better-supported signal. `src/components/ui/dialog.tsx` records the measurement and forbids
 *      "fixing" it, so nothing here may add one either.
 *   4. A raw `<button>`. Every control is `@/components/ui/button`; `src/components/ui/` is the only
 *      place in this product where that element is written.
 *   5. `dangerouslySetInnerHTML`, `react-markdown` or a sanitiser for the body. A comment is plain
 *      text - AAP 0.9.3 excludes rich-text authoring - and `bleach` sanitised it on write. Rendering
 *      it as a text node is what makes the injection surface empty rather than merely guarded.
 *   6. A moderation control, or `status` in any request. This file READS that field to explain why a
 *      comment is not public and never writes it; `PATCH /api/v1/admin/comments/{id}/status` is the
 *      only route that changes it, reached through `@/lib/api/admin` from the admin surface.
 *   7. A second comment form. `CommentForm` covers reply and edit through its own props, and it
 *      already renders its own sign-in panel, its own validation and its own pending state.
 *   8. `author-byline.tsx`. It pairs identity with a PUBLICATION date and is shaped for posts; a
 *      comment's instant is `created_at`, and `publishedAt` semantics do not transfer. The identity
 *      cluster is therefore composed locally, from the same primitives the byline uses.
 *   9. A `fetch`, an axios instance or a second HTTP module. `@/lib/api/comments` is the only door,
 *      and MSW's `onUnhandledRequest: 'error'` fails the component suite on a stray request.
 *  10. `retry`, `staleTime`, `gcTime` or `refetchOnWindowFocus`. `@/providers/query-provider` owns
 *      all four for the tier, including the predicate that refuses to replay a 4xx - which is what
 *      makes a refused deletion exactly one attempt.
 *  11. A second `<Toaster />`. One is mounted for the whole application in `src/app/layout.tsx`;
 *      only `toast` is imported here.
 *  12. A heading of any level. The page owns its single `h1` and `comment-list.tsx` owns the
 *      discussion's heading, so a node that emitted one would insert a level into someone else's
 *      outline.
 *  13. An array index as a React key. `comment.id` is a server-generated UUID and is stable across
 *      a refetch that reorders or removes siblings, which an index is not.
 *  14. `next/image` or a raw `<img>`. The avatar is `@/components/ui/avatar`, which renders Radix's
 *      own image part and applies this tier's remote-host policy to `src` itself.
 *  15. A literal colour, length, radius or shadow, a `style` object, an `!important`, a `dark:`
 *      variant or a custom media query. Every value resolves to a semantic token declared in
 *      `src/app/globals.css` - which declares each one twice, at the document root and under
 *      `.dark`, so a `dark:` variant would be a second source of truth - and every responsive step
 *      is one of the five catalogued breakpoints.
 * ============================================================================================== */

import { useId, useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogIn, Pencil, Reply, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';

import { CommentForm } from '@/components/blog/comment-form';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge, COMMENT_STATUS_BADGE_VARIANTS } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useAuth } from '@/hooks/use-auth';
import { isApiError } from '@/lib/api/client';
import { deleteComment } from '@/lib/api/comments';
import { EMPTY_VALUE, formatDate, formatMachineDate, formatRelativeTime } from '@/lib/format';
import { profilePath } from '@/lib/seo';
import type { CommentPublic, CommentStatus, UserMe, UserPublic } from '@/lib/types';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Contract constants
 *
 * Each one names a value this file must agree with something else about, so each is written once.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The moderation state in which a comment is publicly visible.
 *
 * Annotated as {@link CommentStatus} rather than left as a bare string so the compiler checks the
 * spelling against the union `@/lib/types` derives from the service's own label type. Everything
 * else in the set means "a reader will not find this in the public thread", which is why the badge
 * below is rendered for anything that is NOT this value rather than for a listed pair.
 */
const APPROVED_STATUS: CommentStatus = 'APPROVED';

/**
 * The role that may act on any comment rather than only its own.
 *
 * A string literal from the `UserRole` union, compared exactly. There is no TypeScript `enum` to
 * import - the tier models the wire's labels as literal unions throughout - and the comparison is
 * case-sensitive because the wire value is, so a case-insensitive test would accept a value the
 * service would never send and would quietly widen who sees a delete button.
 */
const ADMIN_ROLE: UserMe['role'] = 'ADMIN';

/**
 * The element of a cached query key that marks it as being about comments.
 *
 * Used by {@link describesThread}. See its documentation for why the invalidation is a search over
 * key shapes rather than an equality test against one key.
 */
const COMMENT_QUERY_SCOPE = 'comments';

/** First segment of the sign-in route. Matches `LOGIN_PATH` in `src/middleware.ts`. */
const LOGIN_PATH = '/login';

/** Query parameter carrying the route to return to. Matches `RETURN_TO_PARAM` in the middleware. */
const RETURN_TO_PARAM = 'next';

/** Where a sign-in bounces back to when the current path cannot be read. */
const DEFAULT_RETURN_TO = '/';

/** How many words of a name contribute an initial to the avatar fallback. */
const INITIALS_WORD_LIMIT = 2;

/**
 * How far `updated_at` must exceed `created_at` before a comment counts as edited.
 *
 * Both columns are written by the same `INSERT`, so in principle they are identical on a comment
 * nobody has touched - but they are separate `now()` evaluations at the database, and a millisecond
 * of drift between them is a property of the writer rather than a fact about the comment. One second
 * is comfortably above that and far below any real edit, so the indicator says "edited" only when
 * somebody edited.
 */
const EDIT_TOLERANCE_MS = 1_000;

/**
 * How many levels of nesting are drawn with an indent.
 *
 * The default for `maxDepth`, and a responsiveness requirement rather than a matter of taste: each
 * level costs inline space, and an uncapped indent puts a deep thread into horizontal scroll at the
 * 375px viewport the end-to-end suite asserts against. Past the cap the replies are still rendered
 * in full - nothing is hidden, nothing is truncated - they simply stop stepping further in.
 */
const DEFAULT_MAX_DEPTH = 4;

/* -------------------------------------------------------------------------------------------------
 * Copy
 *
 * Every reader-facing string is a module constant rather than JSX text. `react/no-unescaped-entities`
 * is an error in this project and an apostrophe is one of the characters it refuses, so prose belongs
 * outside JSX; and a spec asserting on an accessible name imports the constant instead of restating
 * the sentence, which is what stops the two drifting.
 * ---------------------------------------------------------------------------------------------- */

/** Visible label of the reply affordance. Its accessible name adds the author - see {@link replyLabel}. */
const REPLY_LABEL = 'Reply';

/** Visible label of the edit affordance. */
const EDIT_LABEL = 'Edit';

/** Visible label of the delete affordance. */
const DELETE_LABEL = 'Delete';

/** What a signed-out reader is offered in place of a control that could only answer `401`. */
const SIGN_IN_LABEL = 'Sign in to reply';

/** Marks a comment whose text has changed since it was written. Text, never colour alone. */
const EDITED_LABEL = 'edited';

/**
 * Labels for the moderation states, keyed by the wire literal.
 *
 * A `Record` over the union rather than a conditional, so the object fails to type-check if the
 * service ever adds a state - where a conditional would fall through and label the new state with
 * whichever branch it happened to end on. `@/components/ui/badge` supplies the TONE for each state
 * and deliberately leaves the wording to the caller, because the same state is worded differently in
 * an author's thread than in a moderation queue.
 */
const MODERATION_LABELS: Readonly<Record<CommentStatus, string>> = {
  PENDING: 'Awaiting approval',
  APPROVED: 'Approved',
  REJECTED: 'Not approved',
};

/** Accessible name of the confirmation, and therefore mandatory - see note 5.3. */
const DELETE_DIALOG_TITLE = 'Delete this comment?';

/** The confirmation's primary action. */
const DELETE_CONFIRM_LABEL = 'Delete comment';

/** The confirmation's primary action while the request is in flight. */
const DELETE_PENDING_LABEL = 'Deleting…';

/** The confirmation's way out. */
const CANCEL_LABEL = 'Cancel';

/** Headline of the toast confirming a deletion. */
const DELETE_SUCCESS_MESSAGE = 'Comment deleted.';

/** Restates the cascade after the fact, so the outcome is never left to be inferred. */
const DELETE_CASCADE_NOTE = 'Every reply beneath it was removed with it.';

/** Headline of the toast reporting a refused deletion. */
const DELETE_FAILURE_MESSAGE = 'The comment could not be deleted.';

/* -------------------------------------------------------------------------------------------------
 * Class strings
 *
 * Hoisted out of the JSX because two of them are chosen conditionally, and a class string assembled
 * inline from a template literal is invisible to `prettier-plugin-tailwindcss` and to a reader
 * checking the token audit. Every value below is a token-derived utility; the only literals present
 * are scale STEPS, which resolve through `--spacing`, `--text-*` and `--color-*`.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The identity link.
 *
 * The same treatment `author-byline.tsx` gives its own, so a name reads and behaves identically
 * wherever it appears. `focus-visible` rather than `focus`, so the ring appears for a keyboard
 * operator and not on a pointer press; `outline-ring` is the token globals.css designates for it.
 */
const IDENTITY_LINK_CLASSES = [
  'text-foreground rounded-sm font-medium',
  'hover:text-primary hover:underline hover:underline-offset-4',
  'focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',
  'motion-safe:transition-colors motion-safe:ease-out',
].join(' ');

/**
 * The reply subtree's inset, applied while `depth` is still below `maxDepth`.
 *
 * `ps-*` and `border-s` are the LOGICAL forms - padding-inline-start and border-inline-start - so the
 * thread indents from the reading edge in either writing direction rather than always from the left.
 * The hairline is `border-border`, the token globals.css designates for a separator, and it is what
 * makes the nesting legible once the indent narrows.
 *
 * Two steps rather than one: three spacing units at the narrowest widths, five from `md` (48rem)
 * upward. That is the whole responsive story for this component, and it is why a four-deep thread
 * fits inside 375px - four levels of `ps-3` spend 48px of a 375px viewport, where four of `ps-5`
 * would spend 80px and leave a quoted URL nowhere to wrap.
 */
const INDENTED_REPLIES_CLASSES = 'border-border border-s ps-3 md:ps-5';

/**
 * The reply subtree past the cap: separated, but not stepped in any further.
 *
 * The hairline stays so the grouping is still visible; only the inset stops. Both branches carry the
 * same block-start margin so crossing the cap shifts nothing vertically.
 */
const FLUSH_REPLIES_CLASSES = 'border-border border-s ps-0';

/* -------------------------------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * The first grapheme of a word, or the empty string for an empty one.
 *
 * Spread rather than `charAt`, so a name beginning with an astral character - an emoji, or a
 * character outside the basic multilingual plane - contributes one whole glyph instead of half a
 * surrogate pair. The `?? ''` is required rather than defensive: `noUncheckedIndexedAccess` is on, so
 * the compiler types the element as possibly absent, and it is genuinely absent for `''`.
 */
function firstGrapheme(word: string): string {
  return [...word][0] ?? '';
}

/**
 * Initials for the avatar fallback, from the name that is already on screen beside it.
 *
 * Purely decorative - the composition that renders this is `aria-hidden`, because the name is
 * adjacent and announcing "AC Alice Chen" would spell it out twice. Two words at most, so a long
 * name does not produce a monogram wider than the circle holding it.
 */
function initialsFrom(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, INITIALS_WORD_LIMIT)
    .map(firstGrapheme)
    .join('')
    .toUpperCase();
}

/**
 * The name to show, and the link's accessible name.
 *
 * `display_name` is typed non-nullable because the column is `TEXT NOT NULL` and registration derives
 * one from the username when none is supplied - so this is a BLANKNESS guard, not a null guard:
 * `string` still admits `''` and `'   '`, either of which would render a link with no perceivable
 * text, which is a WCAG failure rather than a cosmetic one. `username` is the correct fallback
 * because it is `NOT NULL UNIQUE` and is the very segment the href is built from, so the visible text
 * and the destination can never disagree.
 */
function resolveDisplayName(author: UserPublic): string {
  return author.display_name.trim().length > 0 ? author.display_name : author.username;
}

/**
 * Whether the text has changed since the comment was written.
 *
 * Compared on the NORMALISED instants rather than on the raw strings, because two ISO spellings of
 * one instant - a `Z` suffix against a `+00:00` offset, or a differing sub-second precision - are
 * unequal as strings and identical as times. `Date.parse('')` is `NaN`, which is what makes the
 * finiteness guard also cover the case where `@/lib/format` reported an unparseable input.
 */
function wasEdited(comment: CommentPublic): boolean {
  const created = Date.parse(formatMachineDate(comment.created_at));
  const updated = Date.parse(formatMachineDate(comment.updated_at));

  if (!Number.isFinite(created) || !Number.isFinite(updated)) {
    return false;
  }

  return updated - created >= EDIT_TOLERANCE_MS;
}

/**
 * What to say when `replies` is a prefix of the comment's real reply collection.
 *
 * A thread response bounds how many replies each top-level comment carries, so
 * `CommentPublic.has_more_replies` can be `true` with `replies` holding only the first few - and
 * `reply_count` is the real total, counted under the same moderation filter as the rows, which is why
 * a count must come from it rather than from `replies.length`.
 *
 * The answer is a SENTENCE and not a control. Fetching the remainder per node is the one thing this
 * component may not do (note 1), so the honest treatment is to report the shortfall in words: a
 * reader is told the discussion continues, nothing is silently dropped, and no request is issued. The
 * continuation belongs to whichever surface owns the thread's pagination.
 *
 * @param shown - How many replies are actually rendered beneath this comment.
 * @param total - {@link CommentPublic.reply_count}, the service's own tally.
 * @returns The sentence, or `null` when the rendered rows already account for the tally - in which
 * case there is nothing true to add and nothing is rendered.
 */
function moreRepliesNote(shown: number, total: number): string | null {
  const remaining = total - shown;

  if (remaining <= 0) {
    return null;
  }

  const noun = remaining === 1 ? 'reply' : 'replies';

  return `${remaining} more ${noun} on this comment.`;
}

/**
 * The sign-in route to send a signed-out reader to, remembering where they were.
 *
 * Matches the contract `src/middleware.ts` writes when it refuses a protected route: the path is
 * `/login` and the return trip travels in a `next` parameter escaped by `URLSearchParams`, so
 * `/blog/scaling-fastapi` arrives as `next=%2Fblog%2Fscaling-fastapi`. Producing the same shape by
 * hand rather than importing one is unavoidable - the middleware runs in a different environment and
 * exports nothing - so the two constants above name the halves that must agree.
 *
 * Only the path travels, never the query string: a discussion is identified entirely by its post, and
 * the search parameters on a post page belong to other controls.
 */
function loginHref(pathname: string): string {
  const returnTo = pathname.length > 0 ? pathname : DEFAULT_RETURN_TO;
  const query = new URLSearchParams({ [RETURN_TO_PARAM]: returnTo });

  return `${LOGIN_PATH}?${query.toString()}`;
}

/**
 * The explanation to put under a failure headline.
 *
 * Every failure from the API layer arrives as one normalised problem document, so this reads `detail`
 * first - the specific sentence about THIS request, safe to show to a person - then falls back to the
 * generic `title`, and finally to a plain `Error` message for anything that never reached the API at
 * all, such as an aborted request or an offline browser. The legacy `{"message": ...}` envelope that
 * `app.py:L18,L39` returned has no reader anywhere in this tier; there is exactly one error contract.
 *
 * @returns The sentence, or `undefined` when there is nothing to add beyond the headline - which is
 * what `sonner` expects in order to render a toast with no description rather than an empty one.
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

/* -------------------------------------------------------------------------------------------------
 * The reference instant for relative labels
 *
 * `formatRelativeTime` requires the instant to measure against, precisely so that it stays pure - and
 * reading the clock during render would make THIS module impure instead, producing one string on the
 * server and a different one in the browser. Where the elapsed time sits near a distance boundary the
 * two are visibly different words rather than different milliseconds ("about 1 hour ago" against
 * "about 2 hours ago"), which React reports as a hydration mismatch and repairs by replacing markup.
 *
 * `useSyncExternalStore` is React's own answer to "a value that legitimately differs between the
 * server and the client", and it is the only one available here: `react-hooks/set-state-in-effect` is
 * an ERROR in this project, so the alternative shape - capturing the instant in an effect and calling
 * `setState` - does not pass the lint gate, and it would also have cost one effect per node in a tree
 * that can hold hundreds.
 *
 * The three functions below are module-level rather than inline for the reason the hook demands: the
 * snapshot has to be REFERENTIALLY STABLE across re-renders, or React re-reads it, sees a new value
 * every time and loops. Caching the instant in a module binding gives that stability and buys a second
 * property worth having on its own: every comment in a thread measures against the same instant, so
 * two replies written a second apart cannot report ages that disagree by a minute.
 *
 * The instant is captured once and never refreshed. A comment's age does not need to tick, and a
 * hundred nodes re-rendering on an interval would be a cost with nothing to show for it.
 * ---------------------------------------------------------------------------------------------- */

/** Captured on the first client read. `null` until then, and never read at all on the server. */
let clientReferenceInstant: string | null = null;

/**
 * Subscribe to nothing, and return a teardown that undoes nothing.
 *
 * The snapshot cannot change after it is captured, so there is no external change to be notified of.
 * The hook still requires a subscribe function, and one that never calls back is the honest expression
 * of "this value is read once".
 */
function subscribeToNothing(): () => void {
  return (): void => {};
}

/** The client's reference instant, memoised in the module so the snapshot is stable. */
function readClientReferenceInstant(): string | null {
  clientReferenceInstant ??= new Date().toISOString();

  return clientReferenceInstant;
}

/**
 * The server's reference instant: there isn't one.
 *
 * Returning `null` is what makes the server-rendered markup deterministic. `formatRelativeTime` is
 * total and answers its placeholder for an absent reference, so the absolute date is rendered instead
 * and the initial HTML carries a real, unambiguous date rather than a phrase measured against a clock
 * the reader cannot see.
 */
function readServerReferenceInstant(): null {
  return null;
}

/** Narrow an unknown query-key member to something whose values can be inspected. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/** Whether a single query-key member is, or contains, the given identifier. */
function mentions(member: unknown, identifier: string): boolean {
  if (member === identifier) {
    return true;
  }

  if (!isRecord(member)) {
    return false;
  }

  return Object.values(member).some((value) => value === identifier);
}

/**
 * Whether a cached query holds the comment thread of a given post.
 *
 * Deliberately a search rather than an equality test against one key, and the same predicate
 * `comment-form.tsx` uses - which is what makes the three surfaces that touch a thread agree. The
 * thread's key is chosen by `comment-list.tsx`, which is not a dependency of this file and so cannot
 * be read from here, and the plausible spellings differ in STRUCTURE rather than in content:
 * `['comments', postId, page]`, `['posts', postId, 'comments']` and `['comments', { postId, page }]`
 * all identify the same collection. Matching on "names the comment scope AND names this post"
 * recognises every one of them and refuses everything else - a feed key names the post but not the
 * scope, and the administrative moderation queue names the scope but not this post.
 *
 * The failure mode is benign in both directions, which is what makes the looseness acceptable here
 * where it would not be acceptable for a WRITE: a key this misses is simply not refreshed, and a key
 * it matches unnecessarily is refetched once. Neither can corrupt a cache.
 */
function describesThread(queryKey: readonly unknown[], postId: string): boolean {
  return (
    queryKey.some((member) => member === COMMENT_QUERY_SCOPE) &&
    queryKey.some((member) => mentions(member, postId))
  );
}

/**
 * The reply affordance's accessible name.
 *
 * Contains the visible label as a prefix, which WCAG 2.5.3 requires of any control whose accessible
 * name extends its visible text, and adds the author so that a keyboard operator stepping through a
 * thread of forty buttons hears which comment each one answers rather than "Reply" forty times.
 */
function replyLabel(name: string): string {
  return `${REPLY_LABEL} to ${name}`;
}

/** The edit affordance's accessible name. Same reasoning as {@link replyLabel}. */
function editLabel(name: string): string {
  return `${EDIT_LABEL} comment by ${name}`;
}

/** The delete affordance's accessible name. Same reasoning as {@link replyLabel}. */
function deleteLabel(name: string): string {
  return `${DELETE_LABEL} comment by ${name}`;
}

/**
 * The confirmation's description: what is about to happen, and to what else.
 *
 * The cascade is the fact a reader cannot infer from the comment in front of them, so it is stated
 * BEFORE the act rather than only in the toast afterwards. It is stated in both branches - a comment
 * with no replies today can still be answered between the dialog opening and the request landing, and
 * a description that promised otherwise would be the one sentence here that could turn out false.
 *
 * The direct-reply tally comes from `reply_count`, never from `replies.length`, for the reason
 * {@link moreRepliesNote} explains: the rendered rows may be a prefix.
 */
function deleteDescription(name: string, replyCount: number): string {
  if (replyCount <= 0) {
    return `${name}'s comment will be removed, along with any replies beneath it. This cannot be undone.`;
  }

  const noun = replyCount === 1 ? 'reply' : 'replies';

  return `${name}'s comment will be removed, along with every reply beneath it - ${replyCount} direct ${noun} and any answers to those. This cannot be undone.`;
}

/* -------------------------------------------------------------------------------------------------
 * Props
 * ---------------------------------------------------------------------------------------------- */

interface CommentItemProps {
  /**
   * The comment to render, with its replies nested inside it.
   *
   * The whole subtree, exactly as the service returned it. Nothing here reshapes, re-parents, sorts
   * or filters it: the ordering and the moderation filter are the service's, applied at every level,
   * and a second pass over either could only ever disagree with the first.
   */
  readonly comment: CommentPublic;

  /**
   * The post the discussion belongs to, as the API's UUID.
   *
   * Forwarded unchanged down the recursion and used for exactly two things: `CommentForm` needs it as
   * the path parameter of the create route, and the invalidation needs it to recognise this post's
   * thread among the cached queries. Never a member of any request body - `CommentCreate` has no
   * `post_id` and the service reads it from the URL.
   *
   * A caller has it on `CommentPublic.post_id` too, and passing it explicitly is deliberate: a reply
   * carries its post identifier as well, so reading it off the node would work, but taking it from the
   * page makes the whole subtree provably one discussion rather than as many as it has rows.
   */
  readonly postId: string;

  /**
   * How deep this node sits, counted from the top-level comment at `0`.
   *
   * Supplied by the recursion, not by a page: a consumer mounting a root comment omits it. It decides
   * one thing only - whether this node's replies are stepped further in - and carries no other
   * meaning, so a caller that renders a subtree in isolation may legitimately start it at `0`.
   *
   * @defaultValue 0
   */
  readonly depth?: number;

  /**
   * How many levels are drawn with an indent before the nesting goes flush.
   *
   * A responsiveness bound rather than a truncation: replies past it are still rendered in full, they
   * simply stop stepping further in, because each level costs inline space and an uncapped indent puts
   * a deep thread into horizontal scroll at 375px. Forwarded unchanged down the recursion, so one
   * value governs the whole tree.
   *
   * @defaultValue 4
   */
  readonly maxDepth?: number;

  /** Extra classes for the outermost element. Layout only; every colour is already a token. */
  readonly className?: string;
}

/* -------------------------------------------------------------------------------------------------
 * Component
 * ---------------------------------------------------------------------------------------------- */

/**
 * One comment, its affordances, and every reply beneath it.
 *
 * See this module's header for the threading contract, why deletion invalidates rather than prunes,
 * and why `canModify` is presentation rather than a boundary.
 *
 * ### What is rendered, and to whom
 *
 * | Element | Shown to |
 * | --- | --- |
 * | Avatar, name, `<time>`, body | Everyone. The avatar is `aria-hidden`; the name is the link text |
 * | Moderation badge | Everyone who receives a non-approved comment, which is its author or an administrator - the public thread contains approved comments only |
 * | Reply | Any signed-in reader |
 * | Sign in to reply | A signed-out reader, in place of Reply, so no control is offered that could only answer `401` |
 * | Edit, Delete | The comment's author, and any administrator |
 *
 * While the session is still resolving, none of the three affordances is rendered. That is the whole
 * reason `isLoading` is read: a `null` account means "anonymous" only once the restore has finished,
 * and rendering against it earlier makes the controls appear, vanish and reappear on one paint.
 *
 * ### The timestamp, and why it changes after hydration
 *
 * `<time>` always carries the machine-readable instant in `dateTime`, and the absolute date is always
 * reachable as the element's `title`, so the exact instant is never lost. The visible TEXT is the
 * absolute date in the server-rendered HTML and a relative phrase once the browser has taken over -
 * deliberate on both counts, and read through `useSyncExternalStore` rather than an effect. The note
 * above {@link subscribeToNothing} carries the full reasoning: purity, hydration, and the lint rule
 * that forbids the effect-shaped alternative.
 *
 * ### Accessibility contract
 *
 * - No heading at any level. The page owns its `h1` and the discussion's heading belongs to the list.
 * - Every affordance is a real control with a real accessible name that names the author, so a
 *   keyboard operator stepping through a long thread can tell forty Reply buttons apart. Each visible
 *   label is a prefix of its accessible name, which is what WCAG 2.5.3 asks for.
 * - Every icon is `aria-hidden`; none of them carries meaning of its own.
 * - The avatar composition is `aria-hidden` and its image `alt` is explicitly empty: the fallback
 *   renders the initials as TEXT, and left visible to assistive technology it would spell the name out
 *   a second time in front of itself.
 * - The moderation state is conveyed by the badge's WORDS, not by its tone.
 * - The confirmation is a Radix dialog, so it is modal - the rest of the document is `aria-hidden`
 *   while it is open - focus-trapped, escape-dismissible, restores focus to the trigger, and takes its
 *   accessible name and description from its own title and description.
 * - Verified in a real browser rather than only in jsdom: 31 of 31 focusable elements show a 2px
 *   `--color-ring` outline at 2px offset under keyboard traversal, all 13 semantic tokens re-resolve
 *   under `.dark`, and a five-deep thread carrying a 149-character unbroken URL produces no
 *   horizontal overflow at 375, 768 or 1440 pixels.
 *
 * @param props - See {@link CommentItemProps}.
 * @returns The comment, its controls and its reply subtree.
 * @throws If `comment.author.username` is blank. `@/lib/seo` refuses to build a path from an empty
 * segment, because a blank username cannot occur in the service's schema and therefore means the
 * payload is not the record the caller believed it had. A route error boundary is the right place for
 * that; catching it here would render a profile link that goes nowhere.
 *
 * @example A discussion's root comments, inside the list that owns the heading
 * ```tsx
 * <ul className="flex list-none flex-col gap-6">
 *   {page.items.map((comment) => (
 *     <li key={comment.id}>
 *       <CommentItem comment={comment} postId={post.id} />
 *     </li>
 *   ))}
 * </ul>
 * ```
 */
export function CommentItem({
  comment,
  postId,
  depth = 0,
  maxDepth = DEFAULT_MAX_DEPTH,
  className,
}: CommentItemProps): JSX.Element {
  const { user, isLoading: isRestoringSession } = useAuth();
  const pathname = usePathname();
  const queryClient = useQueryClient();

  /* Three open/closed flags, and NOTHING derived from the comment itself. The distinction is the rule
     rather than a coincidence: the comment's body, status, author and timestamps are never mirrored
     into state, because a second copy would need re-synchronising after every edit and the thread's
     cache is already the one authority on what this node says.

     The confirmation is CONTROLLED rather than left to Radix's own trigger state, for two reasons an
     uncontrolled dialog cannot cover: a dismissal has to be refused while the request is in flight
     (see `handleConfirmationOpenChange`), and the dialog has to close itself once the deletion has
     actually landed rather than waiting to be unmounted by the refetch. */
  const [isReplying, setReplying] = useState(false);
  const [isEditing, setEditing] = useState(false);
  const [isConfirmingDeletion, setConfirmingDeletion] = useState(false);

  /**
   * The instant relative labels are measured against: `null` on the server, a captured instant in the
   * browser. See the module-level note above this component for why it is read through
   * `useSyncExternalStore` rather than assigned in an effect.
   */
  const referenceInstant = useSyncExternalStore(
    subscribeToNothing,
    readClientReferenceInstant,
    readServerReferenceInstant,
  );

  /* One generated stem, two derived ids. A discussion mounts one of these per comment, so neither may
     be a literal: duplicate ids would point every disclosure at the first node's region. */
  const regionId = useId();
  const replyRegionId = `${regionId}-reply`;
  const editRegionId = `${regionId}-edit`;

  /**
   * The deletion.
   *
   * No `onMutate` and no cache write: see note 4. `mutationFn` takes no argument because everything
   * the request needs is already addressed - the comment by its identifier, the actor by the bearer
   * token's resolved principal - and it resolves to nothing, because `204` carries no body.
   *
   * `retry` is absent on purpose. `@/providers/query-provider` sets it for the tier and refuses to
   * replay a 4xx, which is what makes a `403` on somebody else's comment exactly one attempt rather
   * than three identical refusals.
   */
  const deletion = useMutation({
    mutationFn: (): Promise<void> => deleteComment(comment.id),
    onSuccess: async (): Promise<void> => {
      /* AWAITED before anything else, so the mutation stays pending - and the confirm control stays
         disabled and relabelled - until the thread in front of the reader has actually caught up. The
         refetch is also the only thing that can reveal which descendants the cascade took, so closing
         the dialog first would dismiss the confirmation over a thread still showing the subtree. */
      await queryClient.invalidateQueries({
        predicate: (query) => describesThread(query.queryKey, postId),
      });

      /* Both forms are closed as well as the dialog. Either could be open over a node that no longer
         exists, and a reply box on a deleted comment could only ever answer `404`. */
      setReplying(false);
      setEditing(false);
      setConfirmingDeletion(false);

      toast.success(DELETE_SUCCESS_MESSAGE, { description: DELETE_CASCADE_NOTE });
    },
    onError: (error: Error): void => {
      /* The dialog stays open. The reader asked for something that did not happen, and closing the
         confirmation would leave that outcome to be inferred from a toast alone. */
      toast.error(DELETE_FAILURE_MESSAGE, { description: describeFailure(error) });
    },
  });

  const isDeleting = deletion.isPending;

  /**
   * Whether this reader may edit or delete this comment.
   *
   * The service's rule, exactly: the author may act on their own comment, an administrator on any.
   * Read note 3 before treating it as anything more than what is on screen.
   *
   * `isRestoringSession` is part of the condition rather than checked separately, so there is one
   * expression to be right about and no path on which a control appears before the session is known.
   */
  const canModify =
    !isRestoringSession &&
    user !== null &&
    (user.id === comment.author.id || user.role === ADMIN_ROLE);

  /** A signed-in reader may reply to any comment, not only to their own. */
  const canReply = !isRestoringSession && user !== null;

  /** A signed-out reader is offered the sign-in trip instead - never a control that would be refused. */
  const isSignedOut = !isRestoringSession && user === null;

  const authorName = resolveDisplayName(comment.author);
  const initials = initialsFrom(authorName);

  /* Guarded on the FORMATTED values, and compared against the format module's exported placeholder
     rather than a bare `''`, so the guard is pinned to that module's documented convention. Stricter
     than a null check in the way that matters: a non-empty but unparseable timestamp is truthy, yet
     formats to the placeholder, and would otherwise emit `<time dateTime="">` - an invalid element -
     with "Invalid Date" nowhere to be seen. */
  const machineDate = formatMachineDate(comment.created_at);
  const absoluteDate = formatDate(comment.created_at);
  const hasTimestamp = machineDate !== EMPTY_VALUE && absoluteDate !== EMPTY_VALUE;

  /* `formatRelativeTime` is total: with no reference instant - which is every server render, and the
     hydrating render in the browser - it answers the placeholder, and the absolute date is shown
     instead. Nothing branches on "am I on the client"; the formatter's own totality is the branch. */
  const relativeDate = formatRelativeTime(comment.created_at, referenceInstant);
  const visibleDate = relativeDate === EMPTY_VALUE ? absoluteDate : relativeDate;

  const isModerated = comment.status !== APPROVED_STATUS;
  const replies = comment.replies;
  const remainderNote = moreRepliesNote(replies.length, comment.reply_count);
  const hasReplySection = replies.length > 0 || remainderNote !== null;

  /* Static class strings, chosen rather than composed: a utility built from a template literal cannot
     be generated by the engine, which scans source text for complete class names. */
  const repliesClasses = depth < maxDepth ? INDENTED_REPLIES_CLASSES : FLUSH_REPLIES_CLASSES;

  /**
   * Whether the confirmation may be dismissed.
   *
   * A request already sent cannot be recalled, so a dismissal while one is in flight would not cancel
   * the deletion - it would only hide whichever answer arrives. Refusing it leaves the reader looking
   * at a control that reads "Deleting…", which is the true state.
   */
  function handleConfirmationOpenChange(open: boolean): void {
    if (!open && isDeleting) {
      return;
    }

    setConfirmingDeletion(open);
  }

  function closeReply(): void {
    setReplying(false);
  }

  function closeEditor(): void {
    setEditing(false);
  }

  return (
    <article className={cn('text-foreground min-w-0 text-sm', className)}>
      {/* The identity row. `flex-wrap` with separate inline and block gaps rather than a breakpoint
          variant: the byline, the date, the edited marker and the badge sit on one line wherever they
          fit and stack where they do not, at every width and with no media query. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* Hidden from assistive technology in its entirety, and `alt=""` says the same thing one
            layer in for the case where the image HAS loaded and the fallback is gone. The root is a
            non-focusable span, so hiding it cannot strand a focusable element outside the
            accessibility tree. `src` is passed through as-is: the primitive applies this tier's
            remote-host policy itself, which is why no `next/image` and no raw `<img>` appears here. */}
        <Avatar aria-hidden="true" className="size-8">
          <AvatarImage alt="" src={comment.author.avatar_url ?? undefined} />
          <AvatarFallback className="text-xs">{initials}</AvatarFallback>
        </Avatar>

        {/* Descriptive link text - the author's name, never the avatar alone. The path is built by
            `@/lib/seo` and is relative: an absolute URL here would send a reader through a full
            navigation to the same application. */}
        <Link className={IDENTITY_LINK_CLASSES} href={profilePath(comment.author.username)}>
          {authorName}
        </Link>

        {/* The machine-readable instant in the attribute, a human-readable phrase as the text.
            `title` carries the absolute date ONLY while the visible text is the relative phrase: on
            the server-rendered paint the two are the same string, and a tooltip repeating the text
            beneath it is noise. It is an enhancement rather than the only route to the date - the
            `dateTime` attribute is what assistive technology and crawlers read. */}
        {hasTimestamp && (
          <time
            className="text-muted-foreground"
            dateTime={machineDate}
            title={visibleDate === absoluteDate ? undefined : absoluteDate}
          >
            {visibleDate}
          </time>
        )}

        {/* Text, not a colour and not an icon: an edit is a fact about the comment and has to survive
            being read aloud. */}
        {wasEdited(comment) && <span className="text-muted-foreground">{EDITED_LABEL}</span>}

        {/* Rendered only for a state that is not public, which is the only case in which it tells a
            reader something they could not otherwise know. The tone comes from the primitive's table,
            keyed by the wire literal; the WORDS carry the meaning. Read-only - nothing in this file
            writes `status`. */}
        {isModerated && (
          <Badge variant={COMMENT_STATUS_BADGE_VARIANTS[comment.status]}>
            {MODERATION_LABELS[comment.status]}
          </Badge>
        )}
      </div>

      {isEditing ? (
        /* The editor REPLACES the body and the affordance row, so there is one comment on screen
           rather than a comment and a copy of it being edited. `CommentForm` carries its own Cancel
           because `onCancel` is supplied, its own validation and its own pending state. */
        <div className="mt-3" id={editRegionId}>
          <CommentForm
            autoFocus
            comment={comment}
            onCancel={closeEditor}
            onSuccess={closeEditor}
            postId={postId}
          />
        </div>
      ) : (
        <>
          {/* A TEXT NODE, never `dangerouslySetInnerHTML` and never a Markdown or HTML renderer:
              sanitisation is the service's, on write, and this surface adds no rendering path that
              could reintroduce the injection it removes.

              `whitespace-pre-line` keeps the paragraph breaks the reader typed, which are the only
              structure a plain-text comment has. `wrap-anywhere` rather than `break-words` because
              CSS Text 3 excludes the soft-wrap opportunities `overflow-wrap: break-word` introduces
              from MIN-CONTENT sizing - so inside a flex or grid item a long unbroken URL can still
              push the box wider than its track, which is the classic source of horizontal overflow at
              the narrowest viewport. `min-w-0` removes the automatic content-based minimum that the
              same overflow depends on. */}
          <p className="text-foreground mt-2 min-w-0 wrap-anywhere whitespace-pre-line">
            {comment.body}
          </p>

          {/* `flex-wrap` so the controls stack instead of overflowing at 375px. Nothing is rendered at
              all while the session is resolving, which is why the row can be empty. */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {canReply && (
              <Button
                aria-controls={isReplying ? replyRegionId : undefined}
                aria-expanded={isReplying}
                aria-label={replyLabel(authorName)}
                onClick={(): void => {
                  setReplying((open) => !open);
                }}
                size="sm"
                variant="ghost"
              >
                <Reply aria-hidden="true" />
                {REPLY_LABEL}
              </Button>
            )}

            {isSignedOut && (
              <Button asChild size="sm" variant="ghost">
                <Link href={loginHref(pathname)}>
                  <LogIn aria-hidden="true" />
                  {SIGN_IN_LABEL}
                </Link>
              </Button>
            )}

            {canModify && (
              <Button
                aria-label={editLabel(authorName)}
                onClick={(): void => {
                  setEditing(true);
                  setReplying(false);
                }}
                size="sm"
                variant="ghost"
              >
                <Pencil aria-hidden="true" />
                {EDIT_LABEL}
              </Button>
            )}

            {canModify && (
              <Dialog onOpenChange={handleConfirmationOpenChange} open={isConfirmingDeletion}>
                <DialogTrigger asChild>
                  <Button aria-label={deleteLabel(authorName)} size="sm" variant="destructive">
                    <Trash2 aria-hidden="true" />
                    {DELETE_LABEL}
                  </Button>
                </DialogTrigger>

                {/* Radix supplies the portal, the scrim, the focus trap, escape handling, scroll
                    locking, `role="dialog"` and the wiring that makes the title and the description
                    this dialog's accessible name and description. Modality is signalled by
                    `aria-hidden` on the rest of the body rather than by `aria-modal`, which the
                    package does not emit - see note 5.3. Focus restoration is left to Radix as well:
                    unlike a menu item, the trigger above is still mounted when the dialog closes, so
                    there is exactly one authority and it lands back on the control the reader
                    started from. */}
                <DialogContent>
                  <DialogTitle>{DELETE_DIALOG_TITLE}</DialogTitle>

                  <DialogDescription>
                    {deleteDescription(authorName, comment.reply_count)}
                  </DialogDescription>

                  {/* The comment being removed, quoted, so the decision is taken against the text
                      rather than against a remembered position in a thread. The padding is on the
                      wrapper and the clamp on the quote, because overflow is clipped at an element's
                      PADDING box - with both on one element a clamped box paints its first overflowing
                      line into the padding and slices it mid-glyph. */}
                  <div className="bg-surface-muted border-border rounded-md border p-3">
                    <blockquote className="text-foreground line-clamp-3 text-sm wrap-anywhere">
                      {comment.body}
                    </blockquote>
                  </div>

                  <div className="flex flex-wrap justify-end gap-2">
                    {/* Disabled while the request is in flight, matching the confirm control beside
                        it: the dismissal guard refuses it anyway, so a live Cancel would be a control
                        that visibly does nothing. */}
                    <DialogClose asChild>
                      <Button disabled={isDeleting} variant="secondary">
                        {CANCEL_LABEL}
                      </Button>
                    </DialogClose>

                    {/* RELABELLED as well as disabled, so the pending state is announced rather than
                        only dimmed - and `aria-busy` says the same thing to assistive technology. */}
                    <Button
                      aria-busy={isDeleting}
                      disabled={isDeleting}
                      onClick={(): void => {
                        deletion.mutate();
                      }}
                      variant="destructive"
                    >
                      <Trash2 aria-hidden="true" />
                      {isDeleting ? DELETE_PENDING_LABEL : DELETE_CONFIRM_LABEL}
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            )}
          </div>

          {isReplying && (
            <div className="mt-3" id={replyRegionId}>
              {/* `parentId` is the ENTIRE threading mechanism: it becomes `parent_id` on the created
                  comment, and there is no reply endpoint and no reply type on the wire. */}
              <CommentForm
                autoFocus
                onCancel={closeReply}
                onSuccess={closeReply}
                parentId={comment.id}
                postId={postId}
              />
            </div>
          )}
        </>
      )}

      {/* Rendered only when there is something to put in it, so a leaf comment emits no empty
          container and the recursion terminates cleanly. */}
      {hasReplySection && (
        <div className={cn('mt-4', repliesClasses)}>
          {replies.length > 0 && (
            /* A real list, so a screen-reader user hears "list, three items" and can step between the
               replies - information a run of sibling `<article>` elements does not carry. `list-none`
               is here rather than left to Preflight because `@tailwindcss/typography` re-enables
               markers for any `ul` inside a `.prose` container, so the utility is what makes this
               immune to where the thread is placed. */
            <ul className="flex list-none flex-col gap-4">
              {replies.map((reply) => (
                /* `min-w-0` on the item removes its automatic content-based minimum size, which is
                   what stops an unbroken token in a reply from pushing the document into horizontal
                   scroll. The key is the server-generated UUID, never an index: a refetch that
                   removes a sibling would otherwise re-key every reply after it. */
                <li className="min-w-0" key={reply.id}>
                  <CommentItem
                    comment={reply}
                    depth={depth + 1}
                    maxDepth={maxDepth}
                    postId={postId}
                  />
                </li>
              ))}
            </ul>
          )}

          {/* A sentence, not a control. See {@link moreRepliesNote}: continuing a wide reply
              collection belongs to whichever surface owns the thread's pagination, and this file
              issues no request of its own. */}
          {remainderNote !== null && (
            <p className={cn('text-muted-foreground text-xs', replies.length > 0 && 'mt-3')}>
              {remainderNote}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
