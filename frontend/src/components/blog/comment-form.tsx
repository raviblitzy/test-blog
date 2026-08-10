'use client';

/* =================================================================================================
 * comment-form.tsx - the one control a reader uses to say something.
 *
 * Serves requirement R4 (comments, likes and sharing). One component covers all three ways a
 * comment is written, because all three are the same form over the same single field and only the
 * request they end in differs:
 *
 * | Mode  | Trigger                        | Request                                  | Payload             |
 * | ----- | ------------------------------ | ---------------------------------------- | ------------------- |
 * | root  | no `comment`, no `parentId`    | `POST /api/v1/posts/{postId}/comments`   | `{ body }`          |
 * | reply | no `comment`, `parentId` given | `POST /api/v1/posts/{postId}/comments`   | `{ body, parent_id }` |
 * | edit  | `comment` given                | `PATCH /api/v1/comments/{comment.id}`    | `{ body }`          |
 *
 * THE PRESENCE OF `parent_id` IS THE WHOLE OF THREADING. There is no reply endpoint, no reply type
 * and no depth field on the wire, so root mode omits the member entirely rather than sending
 * `parent_id: null` - `@/lib/api/comments` would normalise a null away, but a form that sends one is
 * a form that has confused "no parent" with "a parent whose value is empty", and the next reader of
 * this file should not have to rediscover which.
 *
 * `postId` IS A PATH PARAMETER AND NEVER A BODY MEMBER. `CommentCreate` has no `post_id`, the
 * service takes it from the URL, and its request models are `extra="forbid"`, so sending one would
 * be refused - and `commentCreateSchema` is a `z.strictObject`, so it would not even reach the
 * network. The same is true of `id`, `author_id` and `status`: identity is a server-generated UUID,
 * the author is the resolved principal, and moderation state is read-only to this whole tier.
 *
 * WHY MODERATION SHAPES THE SUCCESS PATH, AND NOT ONLY THE COPY.
 * `comments.status` server-defaults to `PENDING`, and the public thread lists `APPROVED` comments
 * only - so a comment that was accepted is normally INVISIBLE the moment it is accepted. Worse for
 * the edit case: the service returns an `APPROVED` comment to `PENDING` whenever its body changes,
 * for every actor including an administrator, because approval attaches to the text a moderator
 * read rather than to the row that held it. A form that answered "posted!" and cleared itself would
 * therefore be lying twice over. So the returned `CommentPublic.status` is read on every success and
 * the reader is told, in words, that their text is waiting for approval.
 *
 * WHY THERE IS NO OPTIMISTIC CACHE WRITE HERE, THOUGH ONE WOULD BE PERMITTED.
 * AAP 0.6.5 confines optimistic updates to this component and `like-button.tsx`, and this file
 * declines the licence for two independent reasons, either of which alone would settle it:
 *
 *   1. The thread's query key belongs to `comment-list.tsx`, which is not among this file's
 *      dependencies and therefore cannot be read here. Writing a provisional node into a GUESSED
 *      key produces a cache entry nothing reads and a thread that never updates, with nothing
 *      failing. The instruction for exactly this situation is to invalidate rather than write, and a
 *      correct-but-slower path beats a silently-wrong cache.
 *   2. Even with the key in hand, the insert would be wrong for this product: the created comment
 *      comes back `PENDING`, so an optimistic node would appear and then be REMOVED when the server
 *      answered. Showing a reader their comment and then taking it away is worse than never showing
 *      it and saying why.
 *
 * What replaces it is deliberate and complete: `onSuccess` is called with the returned
 * `CommentPublic` so the thread that owns the data updates itself, and every cached query that names
 * both the comment scope and this post is invalidated through a shape-tolerant predicate, so the
 * refresh lands whichever of the plausible key idioms the thread happens to use.
 *
 * THE DRAFT SURVIVES EVERY FAILURE. `reset()` is called on the success path and nowhere else -
 * never in `onError`, never in `onSettled`. Losing a reader's typed comment to a network blip is the
 * defect this rule exists to prevent, and it is also what makes retrying safe.
 *
 * DELIBERATELY ABSENT. Please do not add:
 *
 *   1. A raw `<textarea>`, `<input>` or `<button>`. The field is `@/components/ui/textarea` and both
 *      actions are `@/components/ui/button`; `src/components/ui/` is the only place in the product
 *      where those elements are written.
 *   2. An `aria-invalid` attribute. `Textarea` computes it from its own `invalid` prop, so authoring
 *      it here would be a second source of truth for one fact.
 *   3. A `role` or an `aria-live` on either notice. `@/components/ui/alert` derives the role from the
 *      variant - `destructive` announces assertively, `warning` and `success` politely - which is
 *      why the variant is the only thing chosen at this call site.
 *   4. A sanitiser, an HTML stripper or a Markdown parser. The body is plain text on the way out;
 *      `bleach` sanitises on write in `comment_service.py` and `rehype-sanitize` sanitises on render.
 *      Stripping here would silently alter what the reader typed and secure nothing.
 *   5. A moderation control, or `status` in any request body. This component reads that field and
 *      never writes it; `PATCH /api/v1/admin/comments/{id}/status` is the only route that changes it.
 *   6. A `fetch`, an axios instance or a second HTTP module. `@/lib/api/comments` is the only door,
 *      and the component test suite fails on a stray request through MSW's `onUnhandledRequest`.
 *   7. `retry`, `staleTime`, `gcTime` or `refetchOnWindowFocus`. `@/providers/query-provider` owns
 *      all four for the tier and already sets `mutations: { retry: 0 }`, which is what makes a
 *      refused submission exactly one attempt - a `422` must never be replayed.
 *   8. A second `<Toaster />`. One is mounted for the whole application in `src/app/layout.tsx`;
 *      only `toast` is imported here.
 *   9. Any token decoding or verification. Hiding this form from a signed-out visitor is a courtesy,
 *      not a boundary: the route requires a bearer and re-checks it server-side either way.
 *  10. A heading of any level. This form is a fragment inside a discussion whose heading structure
 *      belongs to the page, so `AlertTitle` renders at its default `div` rather than as an `h*`.
 *  11. `useSearchParams`. The sign-in link needs the current path only, and that hook would force a
 *      Suspense boundary onto whichever route renders the thread - a build-time failure waiting for
 *      a consumer that did not know it owed one. `usePathname` carries no such obligation.
 *  12. A literal colour, length, radius or shadow. Every value below resolves to a semantic token
 *      declared in `src/app/globals.css`, and the field's own border, ring, error and placeholder
 *      colours are owned by the primitive rather than restated here.
 * ============================================================================================== */

import type { JSX } from 'react';
import { useEffect, useId } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, LogIn, Send } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { isApiError } from '@/lib/api/client';
import { createComment, updateComment } from '@/lib/api/comments';
import type { CommentCreate, CommentPublic, CommentStatus } from '@/lib/types';
import { cn } from '@/lib/utils';
import { commentCreateSchema, commentUpdateSchema } from '@/lib/validation/comment';
import type { CommentUpdateFormValues } from '@/lib/validation/comment';

/* -------------------------------------------------------------------------------------------------
 * Contract constants
 *
 * Each one names a value this file must agree with something else about, so each is written once.
 * ---------------------------------------------------------------------------------------------- */

/** The single registered field. Used for `register`, `setError` and `setFocus` alike. */
const BODY_FIELD = 'body';

/**
 * The moderation state in which a comment is publicly visible.
 *
 * Annotated as {@link CommentStatus} rather than left as a bare string so the compiler checks the
 * spelling against the union `@/lib/types` derives from the service's own label type. Everything
 * else in the set - `PENDING`, `REJECTED` - means "the reader will not see this in the thread yet",
 * which is why the comparison below is against this one value rather than a list.
 */
const APPROVED_STATUS: CommentStatus = 'APPROVED';

/** Refusal carrying per-field detail in `ProblemDetail.errors`. */
const UNPROCESSABLE_CONTENT_STATUS = 422;

/**
 * Refusal meaning the credential is gone.
 *
 * `@/lib/api/client` already refreshes once, under a single-flight guard, before surfacing this - so
 * a `401` arriving here means the refresh itself terminally failed and the session really is over.
 */
const UNAUTHORIZED_STATUS = 401;

/** The `type` react-hook-form records for a message the SERVER attributed to the field. */
const SERVER_ERROR_TYPE = 'server';

/** First segment of the sign-in route. Matches `LOGIN_PATH` in `src/middleware.ts`. */
const LOGIN_PATH = '/login';

/** Query parameter carrying the route to return to. Matches `RETURN_TO_PARAM` in the middleware. */
const RETURN_TO_PARAM = 'next';

/** Where a sign-in bounces back to when the current path cannot be read. */
const DEFAULT_RETURN_TO = '/';

/**
 * The element of a cached query key that marks it as being about comments.
 *
 * Used by {@link describesThread} to find the thread's entries without knowing the exact key shape
 * `comment-list.tsx` chose. See the header for why this is a search rather than a constant key.
 */
const COMMENT_QUERY_SCOPE = 'comments';

/**
 * Resting height of the field, in rows.
 *
 * Four lines: enough to hold a whole short comment without scrolling, and enough to read as a place
 * to write prose rather than a single-line box. It clears the primitive's own `min-h` floor, so the
 * resting size is decided here rather than inherited, and the reader still has the last word through
 * the vertical resize handle the primitive leaves them.
 */
const BODY_ROWS = 4;

/* -------------------------------------------------------------------------------------------------
 * Copy
 *
 * Every reader-facing string is a module constant rather than JSX text, for two reasons that both
 * matter. `react/no-unescaped-entities` is an error in this project and an apostrophe is one of the
 * characters it refuses, so prose belongs outside JSX; and a spec asserting on an accessible name
 * imports the constant instead of restating the sentence, which is what stops the two drifting.
 * ---------------------------------------------------------------------------------------------- */

/** Which of the three jobs this instance is doing. Derived once, from the props. */
type CommentFormMode = 'root' | 'reply' | 'edit';

/** The strings that differ between the three modes. */
interface ModeCopy {
  /** The visible `<label>` text, and therefore the field's accessible name. */
  readonly label: string;
  /** Placeholder hint. Never the accessible name - a placeholder disappears when typing starts. */
  readonly placeholder: string;
  /** The submit button's resting label. */
  readonly submit: string;
  /** The submit button's label while the request is in flight. */
  readonly pending: string;
  /** Shown when a failure never reached the API, so no problem document exists to quote. */
  readonly failureFallback: string;
  /** Confirmation for the rare case that the answer comes back already approved. */
  readonly approved: string;
  /** Confirmation for the normal case: accepted, and waiting for a moderator. */
  readonly held: string;
  /** The held notice's own explanation, shown next to the form rather than in a toast. */
  readonly heldDetail: string;
  /** The sign-in call to action shown to a visitor with no session. */
  readonly signIn: string;
}

const COPY: Readonly<Record<CommentFormMode, ModeCopy>> = {
  root: {
    label: 'Add a comment',
    placeholder: 'Share what you made of this post',
    submit: 'Post comment',
    pending: 'Posting…',
    failureFallback: 'Your comment could not be posted. Please try again.',
    approved: 'Your comment has been posted.',
    held: 'Your comment was received and is waiting for approval.',
    heldDetail:
      'It has been saved, but a moderator has to approve it before it joins the discussion. There is nothing more for you to do.',
    signIn: 'Sign in to comment',
  },
  reply: {
    label: 'Write a reply',
    placeholder: 'Reply to this comment',
    submit: 'Post reply',
    pending: 'Posting…',
    failureFallback: 'Your reply could not be posted. Please try again.',
    approved: 'Your reply has been posted.',
    held: 'Your reply was received and is waiting for approval.',
    heldDetail:
      'It has been saved, but a moderator has to approve it before it appears beneath the comment you answered.',
    signIn: 'Sign in to reply',
  },
  edit: {
    label: 'Edit your comment',
    placeholder: 'Update your comment',
    submit: 'Save changes',
    pending: 'Saving…',
    failureFallback: 'Your changes could not be saved. Please try again.',
    approved: 'Your comment has been updated.',
    held: 'Your comment was updated and is waiting for approval again.',
    heldDetail:
      'The new text has been saved. Because an edit re-opens moderation, the comment stays hidden until a moderator approves it.',
    signIn: 'Sign in to edit your comment',
  },
};

/**
 * The secondary action's label.
 *
 * The same word in every mode, because it means the same thing in every mode and a reader who has
 * learned it on a reply box should not have to re-read it on an editor.
 */
const CANCEL_LABEL = 'Cancel';

/** Title of the notice shown when a submission was accepted but is not yet public. */
const HELD_TITLE = 'Waiting for approval';

/** Title of the notice shown when a submission was refused. */
const FAILURE_TITLE = 'That did not go through';

/** Appended to a refusal when a message was pinned to the field, so the reader knows where to look. */
const FAILURE_FIELD_HINT = 'The message under the box explains what to change.';

/** Shown for a `401`, which after the client's own refresh attempt means the session is really over. */
const SESSION_EXPIRED_MESSAGE =
  'Your sign-in has expired, so nothing was saved. Sign in again and submit once more - your text has been kept.';

/** Reported when a submission somehow arrives with no text. See {@link CommentForm}. */
const EMPTY_SUBMISSION_MESSAGE = 'Write something before submitting.';

/** Guidance for the two modes that create a comment. Always true: creation always lands `PENDING`. */
const CREATE_HELPER =
  'Comments are read by a moderator before they appear publicly, so yours will not show up straight away.';

/** Guidance for editing a comment that is currently public. */
const EDIT_APPROVED_HELPER =
  'Saving an edit sends the comment back for approval, so it will be hidden again until a moderator approves the new text.';

/** Guidance for editing a comment that is still in the queue. */
const EDIT_PENDING_HELPER =
  'This comment is still waiting for approval, so no other reader can see it yet. Editing it now replaces the text a moderator will read.';

/** Guidance for editing a comment a moderator has already turned down. */
const EDIT_REJECTED_HELPER =
  'A moderator rejected this comment, so it is not shown to readers. Editing it does not put it back in the queue.';

/** Heading of the panel a signed-out visitor sees in place of the form. */
const ANONYMOUS_TITLE = 'Sign in to join the discussion';

/** Body of that panel. States the return trip, because the link genuinely provides one. */
const ANONYMOUS_DETAIL =
  'Commenting needs an account. Signing in brings you straight back to this page.';

/** Announced while the session is still being resolved, so the wait is not silent. */
const SESSION_LOADING_MESSAGE = 'Checking whether you are signed in…';

/* -------------------------------------------------------------------------------------------------
 * Form values
 *
 * `CommentUpdateFormValues` is `{ body?: string }` - every member optional - and using it for BOTH
 * modes is load-bearing rather than lazy.
 *
 * `Resolver<T>` from react-hook-form is INVARIANT in `T`, because `T` appears both as a parameter
 * (the values handed to the resolver) and inside the result (the values handed back). So
 * `mode === 'edit' ? zodResolver(commentUpdateSchema) : zodResolver(commentCreateSchema)` does not
 * typecheck in either direction, and forcing it needs a cast that asserts something the compiler has
 * correctly refused to believe.
 *
 * Typing the FIELD values as the all-optional shape dissolves the problem instead of asserting past
 * it: `commentCreateSchema` requires `body` and permits `parent_id`, `commentUpdateSchema` requires
 * nothing, and both are valid `z.ZodType<CommentFormValues, CommentFormValues>` - see the `schema`
 * binding in {@link CommentForm} - so `zodResolver` yields a single `Resolver<CommentFormValues>`
 * with no assertion anywhere in this file.
 *
 * The cost is one honest narrowing at the submit boundary, where `body` has to be proved present
 * before it can be sent. That check is in {@link CommentForm}, with the reason it can never fire.
 * ---------------------------------------------------------------------------------------------- */
type CommentFormValues = CommentUpdateFormValues;

/* -------------------------------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Which of the three jobs a given set of props describes.
 *
 * Stated once, here, so that no branch further down can disagree with another about what this
 * instance is. `comment` wins over `parentId` because editing a reply is still editing: the reply's
 * parent is already recorded on the row and is not resubmitted.
 */
function deriveMode(
  comment: CommentPublic | undefined,
  parentId: string | null | undefined,
): CommentFormMode {
  if (comment !== undefined) {
    return 'edit';
  }
  return parentId === undefined || parentId === null ? 'root' : 'reply';
}

/**
 * The always-present guidance under the field.
 *
 * Mode alone is not enough for the edit case, because what an edit does to visibility depends on
 * where the comment already stands: an approved comment is withdrawn from the thread by its own
 * edit, a pending one was never in it, and a rejected one cannot be returned to the queue by
 * editing - the service refuses that explicitly, so an author cannot re-open a rejection at will.
 * Saying the same sentence for all three would be wrong twice.
 */
function helperFor(mode: CommentFormMode, status: CommentStatus | undefined): string {
  if (mode !== 'edit') {
    return CREATE_HELPER;
  }
  switch (status) {
    case 'APPROVED':
      return EDIT_APPROVED_HELPER;
    case 'REJECTED':
      return EDIT_REJECTED_HELPER;
    default:
      return EDIT_PENDING_HELPER;
  }
}

/**
 * The create document, with `parent_id` present only when there really is a parent.
 *
 * The conditional spread is the point of the function. `{ body, parent_id: parentId ?? undefined }`
 * would look equivalent and is not: it puts the member in the object with an `undefined` value,
 * which `JSON.stringify` drops but which any reader of the object sees as "a parent that is
 * missing" rather than "no parent". Building the two documents separately keeps root mode's payload
 * exactly `{ body }`.
 */
function createDocument(body: string, parentId: string | null | undefined): CommentCreate {
  if (parentId === undefined || parentId === null) {
    return { body };
  }
  return { body, parent_id: parentId };
}

/**
 * Join the ids that are actually present into an `aria-describedby` value.
 *
 * Returns `undefined` rather than `''` when nothing applies, because an empty `aria-describedby`
 * points at nothing and is worse than an absent one. The type predicate keeps the filter honest so
 * no assertion is needed to get from `(string | false | null | undefined)[]` to `string[]`.
 */
function describedBy(...ids: readonly (string | false | null | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return present.length > 0 ? present.join(' ') : undefined;
}

/**
 * The human-readable sentence to show for a failed request.
 *
 * Every failure from the API layer arrives as one normalised problem document, so this reads
 * `detail` first - the specific sentence about THIS request - and falls back to the generic `title`,
 * then to the caller's own wording for anything that never reached the API at all (an aborted
 * request, an offline browser). The legacy `{"message": ...}` envelope that `app.py:L18,L39`
 * returned has no reader here; there is exactly one error contract.
 */
function problemMessage(error: unknown, fallback: string): string {
  if (!isApiError(error)) {
    return fallback;
  }
  const { detail, title } = error.problem;
  if (detail.length > 0) {
    return detail;
  }
  return title.length > 0 ? title : fallback;
}

/**
 * The sentence for the summary notice, with the one status that needs its own wording split out.
 *
 * A `401` is the only failure whose problem document would mislead: the API says "not
 * authenticated", which reads to the person as though they had done something wrong, when in fact
 * their session simply ran out mid-visit and their text is safe. Everything else - `403` on
 * somebody else's comment, `404` on a deleted post, `422` on a refused body, a `5xx` - is described
 * better by the service than by anything this file could invent.
 */
function failureMessage(error: unknown, fallback: string): string {
  if (isApiError(error) && error.status === UNAUTHORIZED_STATUS) {
    return SESSION_EXPIRED_MESSAGE;
  }
  return problemMessage(error, fallback);
}

/** Narrow an unknown key member to something whose values can be inspected. */
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
 * Deliberately a search rather than an equality test against one key. The thread's key is chosen by
 * `comment-list.tsx`, which is not a dependency of this file and so cannot be read from here, and
 * the plausible spellings differ in structure rather than in content: `['comments', postId, page]`,
 * `['posts', postId, 'comments']` and `['comments', { postId, page }]` all identify the same
 * collection. Matching on "names the comment scope AND names this post" recognises every one of
 * them, and refuses everything else - a posts feed key names the post but not the scope, and the
 * administrative queue names the scope but not this post.
 *
 * The failure mode is benign in both directions, which is what makes the looseness acceptable: a
 * key this misses is simply not refreshed, and `onSuccess` has already handed the thread the
 * authoritative comment; a key this matches unnecessarily is refetched once. Neither can corrupt a
 * cache, which is exactly the property a guessed optimistic WRITE would not have had.
 */
function describesThread(queryKey: readonly unknown[], postId: string): boolean {
  return (
    queryKey.some((member) => member === COMMENT_QUERY_SCOPE) &&
    queryKey.some((member) => mentions(member, postId))
  );
}

/**
 * The sign-in route to send a signed-out visitor to, remembering where they were.
 *
 * Matches the contract `src/middleware.ts` writes when it refuses a protected route: the path is
 * `/login` and the return trip travels in a `next` parameter escaped by `URLSearchParams`, so
 * `/blog/scaling-fastapi` arrives as `next=%2Fblog%2Fscaling-fastapi`. Producing the same shape by
 * hand rather than importing one is unavoidable - the middleware runs in a different environment and
 * exports nothing - so the two constants above name the two halves that must agree.
 *
 * Only the path travels, never the query string. A comment thread is identified entirely by its
 * post, and the search parameters on a post page belong to other controls.
 */
function loginHref(pathname: string): string {
  const returnTo = pathname.length > 0 ? pathname : DEFAULT_RETURN_TO;
  const query = new URLSearchParams({ [RETURN_TO_PARAM]: returnTo });
  return `${LOGIN_PATH}?${query.toString()}`;
}

/**
 * Whether a problem document attributed a failure to the body field.
 *
 * The path is dotted in the syntax of the submitted document, so it is split rather than compared
 * whole: the service names `body` today, and a member nested under a future wrapper would still be
 * recognised instead of silently falling through to the summary notice. Anything that names a
 * different member - `parent_id`, say, which this form has no control for - deliberately does NOT
 * match, because pinning a message to a control that is not on screen hides it completely.
 */
function namesBodyField(field: string): boolean {
  return field.split('.').includes(BODY_FIELD);
}

/* -------------------------------------------------------------------------------------------------
 * Props
 * ---------------------------------------------------------------------------------------------- */

interface CommentFormProps {
  /**
   * The post the comment belongs to, as the API's UUID.
   *
   * Used as the PATH parameter of `POST /api/v1/posts/{postId}/comments` and as the identifier the
   * cache invalidation looks for - never as a member of any request body, because `CommentCreate`
   * has no `post_id` and the service reads it from the URL.
   *
   * Required in every mode, including `edit`: the edit request addresses the comment rather than the
   * post, but the thread that has to be refreshed afterwards is still this post's.
   */
  readonly postId: string;

  /**
   * The comment being answered, when this form is a reply box.
   *
   * Its presence is the ENTIRE threading mechanism - it becomes `parent_id` on the created comment,
   * and there is no other reply marker on the wire. Absent, `null` and omitted all mean the same
   * thing (a top-level comment) and all produce a payload with no `parent_id` member at all.
   *
   * Ignored when {@link CommentFormProps.comment} is given: editing a reply does not resubmit its
   * parent, which is immutable on the row.
   */
  readonly parentId?: string | null;

  /**
   * The comment being edited, which switches the form into `edit` mode.
   *
   * Its `body` seeds the field and its `id` addresses `PATCH /api/v1/comments/{id}`; its `status`
   * chooses the guidance under the field, because what an edit does to visibility depends on where
   * the comment already stands. Nothing else on it is read, and nothing on it is ever sent back.
   *
   * The initial text is bound ONCE. A caller that swaps one comment for another on a mounted form
   * must give the element a React `key`, or the field will keep showing the first comment's text.
   */
  readonly comment?: CommentPublic;

  /**
   * Called when the reader abandons the form.
   *
   * Supplying it is what makes a Cancel button appear, so a root form that is always on screen omits
   * it while a reply or edit affordance passes the handler that closes itself. It is wired to a
   * `type="button"` control, so pressing it cannot submit.
   */
  readonly onCancel?: () => void;

  /**
   * Called with the comment the server returned, after a successful create or edit.
   *
   * This is how the thread learns about the new node, and it is deliberately the primary channel
   * rather than a cache write - see the header. The argument is the authoritative `CommentPublic`,
   * including its `status`, so a caller can decide for itself whether the comment is one a reader
   * would currently see.
   */
  readonly onSuccess?: (comment: CommentPublic) => void;

  /**
   * Take keyboard focus to the field once it is on screen.
   *
   * Meant for an affordance that has just been opened - activating "Reply" should land the caret in
   * the reply box rather than leaving a keyboard user to hunt for it. Implemented through
   * react-hook-form's `setFocus` in an effect rather than the DOM `autoFocus` attribute, so focus is
   * taken when the field genuinely appears (which, on a first paint that is still resolving the
   * session, is not the first render) and never on a control that is not there yet.
   *
   * @defaultValue false
   */
  readonly autoFocus?: boolean;

  /** Extra classes for the outermost element. Layout only; every colour is already a token. */
  readonly className?: string;
}

/* -------------------------------------------------------------------------------------------------
 * Component
 * ---------------------------------------------------------------------------------------------- */

/**
 * The form a reader writes a comment, a reply or an edit in.
 *
 * One field, three modes, one request each. See this module's header for the payload table, the
 * reason `parent_id` is omitted rather than nulled in root mode, why moderation state changes what
 * success says, and why no optimistic cache write happens here.
 *
 * ### What the reader sees, in order of precedence
 *
 * 1. While the session is resolving - a neutral placeholder of the same geometry as the panel that
 *    replaces it, so the region does not flash between two answers before settling on one.
 * 2. With no session - a sign-in prompt carrying a `next` parameter back to the current path.
 *    Courtesy, not security: the route requires a bearer and re-checks it server-side regardless,
 *    and nothing here reads, decodes or verifies a token.
 * 3. Otherwise - the form.
 *
 * ### Accessibility contract
 *
 * The field's accessible name is its real, visible `<label>`, bound by `htmlFor` to an id from
 * `useId()` - not a hardcoded one, because a thread renders one of these per reply affordance and a
 * fixed id would give every field the same name and break every label but the first. A validation
 * failure is conveyed three ways that do not depend on perceiving colour: the message is text, the
 * control points at it through `aria-describedby`, and the primitive marks the control
 * `aria-invalid`. Both notices take their `role` from the `Alert` variant rather than from this call
 * site. Every control is reachable and operable by keyboard with a token focus ring, and after a
 * refusal focus is returned to the field - pressing a button that then disables itself drops focus
 * to `<body>`, which would otherwise leave a keyboard user reading a message at the top of the
 * document with no way back to what they must change.
 *
 * @example A thread's root form
 * ```tsx
 * <CommentForm onSuccess={handleCommentAdded} postId={post.id} />
 * ```
 *
 * @example A reply box opened from a comment, and the same component editing that comment
 * ```tsx
 * <CommentForm autoFocus onCancel={closeReply} parentId={comment.id} postId={post.id} />
 * <CommentForm autoFocus comment={comment} onCancel={closeEditor} postId={post.id} />
 * ```
 */
export function CommentForm({
  postId,
  parentId,
  comment,
  onCancel,
  onSuccess: onCommentSaved,
  autoFocus = false,
  className,
}: CommentFormProps): JSX.Element {
  /* The mode is derived ONCE, here, and everything downstream reads it. Deciding "is this a reply?"
     twice is how one branch ends up disagreeing with another about which request to send. */
  const mode = deriveMode(comment, parentId);
  const copy = COPY[mode];

  const { isAuthenticated, isLoading } = useAuth();
  const pathname = usePathname();
  const queryClient = useQueryClient();

  /* One generated stem, three derived ids. A discussion mounts one of these per reply affordance, so
     nothing here may be a literal: duplicate ids would collapse every label onto the first field. */
  const fieldId = useId();
  const helperId = `${fieldId}-helper`;
  const errorId = `${fieldId}-error`;

  /**
   * The mode's schema, annotated as a schema over the form's own value shape.
   *
   * This one annotation is what keeps the whole file assertion-free; the reasoning is on
   * {@link CommentFormValues}. `commentCreateSchema` requires `body` and accepts an optional
   * `parent_id`, `commentUpdateSchema` requires nothing, and both are valid
   * `z.ZodType<CommentFormValues, CommentFormValues>`.
   */
  const schema: z.ZodType<CommentFormValues, CommentFormValues> =
    mode === 'edit' ? commentUpdateSchema : commentCreateSchema;

  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
    reset,
    setError,
    setFocus,
  } = useForm<CommentFormValues>({
    defaultValues: { body: comment?.body ?? '' },
    mode: 'onBlur',
    resolver: zodResolver(schema),
  });

  /**
   * The one request this form makes, chosen by mode inside `mutationFn`.
   *
   * Carries `mutationFn`, `onError` and `onSuccess` and nothing else. `retry`, `staleTime`, `gcTime`
   * and `refetchOnWindowFocus` all belong to `@/providers/query-provider`, which already sets
   * `mutations: { retry: 0 }` - so a refused submission is exactly one attempt, which is the only
   * correct number for a `422`.
   *
   * `mutate` rather than `mutateAsync` at the call site: everything that happens after the request
   * is expressible as a callback, and a rejected promise nobody awaits is an unhandled rejection
   * waiting to be introduced by the next person to touch the submit handler.
   */
  const mutation = useMutation({
    mutationFn: (body: string): Promise<CommentPublic> =>
      comment === undefined
        ? createComment(postId, createDocument(body, parentId))
        : updateComment(comment.id, { body }),

    /* Pin a field-level refusal onto the control that caused it. A `422` carries a problem document
       whose `errors` array names the offending members, and leaving those messages only in the
       summary notice would make the reader guess which part of their text was rejected. `setError`
       puts the message under the box, wired through `aria-describedby`, with the control marked
       `aria-invalid` by the primitive. Statuses other than 422 never carry per-field detail, and a
       member this form has no control for stays in the summary rather than being pinned to nothing.
       Nothing here resets the form: the draft survives every failure. */
    onError: (error: Error): void => {
      if (!isApiError(error) || error.status !== UNPROCESSABLE_CONTENT_STATUS) {
        return;
      }
      for (const item of error.errors ?? []) {
        if (namesBodyField(item.field)) {
          setError(BODY_FIELD, { message: item.message, type: SERVER_ERROR_TYPE });
          return;
        }
      }
    },

    /* THE ONLY PLACE THE FORM IS EVER RESET, and the two modes reset differently on purpose. A
       created comment leaves an empty box ready for the next one. An edited comment re-baselines to
       the text the server stored, which clears the dirty state while KEEPING the new words - a bare
       `reset()` there would restore the original body and silently undo the edit on screen.

       The confirmation reads the returned `status` rather than assuming one. Creation lands
       `PENDING` and an edit returns an approved comment to `PENDING`, so in this product the usual
       answer is "saved, and waiting for a moderator" - and a form that said "posted!" while the
       comment was nowhere in the thread would leave the reader hunting for text that was never
       going to appear.

       The returned promise is deliberate: react-query awaits it, so the pending state lasts until
       the thread has been told to refetch rather than ending while the discussion still shows the
       old rows. */
    onSuccess: (saved: CommentPublic): Promise<void> => {
      if (comment === undefined) {
        reset();
      } else {
        reset({ body: saved.body });
      }

      toast.success(saved.status === APPROVED_STATUS ? copy.approved : copy.held);
      onCommentSaved?.(saved);

      return queryClient.invalidateQueries({
        predicate: (query) => describesThread(query.queryKey, postId),
      });
    },
  });

  const isBusy = mutation.isPending || isSubmitting;
  const fieldError = errors.body?.message;
  const pinnedByServer = errors.body?.type === SERVER_ERROR_TYPE;
  const failure =
    mutation.error === null ? null : failureMessage(mutation.error, copy.failureFallback);
  const heldForApproval = mutation.data !== undefined && mutation.data.status !== APPROVED_STATUS;

  /* Whether the field is on screen at all. Both effects below act on the control, so both have to
     wait for the branch that renders it - and `isLoading` is genuinely true on a first paint, so an
     effect that ran only on mount would reach for a field that did not exist yet. */
  const fieldIsRendered = !isLoading && isAuthenticated;

  /* Land the caret in the field when the caller asked for it. Guarded on `fieldIsRendered` so the
     focus is taken when the field appears rather than when this component mounts, which is what
     makes `autoFocus` work on a reply box opened while the session is still resolving.
     `setFocus` defers the call through a `setTimeout` of its own, so the focus lands on the tick
     after this effect - which is why a test has to wait for it rather than assert synchronously. */
  useEffect(() => {
    if (!autoFocus || !fieldIsRendered) {
      return;
    }
    setFocus(BODY_FIELD);
  }, [autoFocus, fieldIsRendered, setFocus]);

  /* Return focus to the field once a server refusal has named it.
     Submitting disables every control, and a disabled element cannot hold focus - so pressing the
     button drops focus onto `<body>`, and a `422` that pins a message under the box would otherwise
     leave the reader reading it with the keyboard parked at the top of the document.
     Three guards, each removing a way this could misbehave: it waits for the request to settle,
     because the target is disabled until then; it acts only when the server actually named the
     field, so a client-side failure the resolver already focused is left alone; and it acts only
     while focus is still on `<body>`, so it never steals focus from someone who moved on. */
  useEffect(() => {
    if (isBusy || !pinnedByServer || !fieldIsRendered) {
      return;
    }
    if (document.activeElement !== document.body) {
      return;
    }
    setFocus(BODY_FIELD);
  }, [fieldIsRendered, isBusy, pinnedByServer, setFocus]);

  /* ---------------------------------------------------------------------------------------------
   * The session is still being resolved
   *
   * A placeholder rather than either real answer, because flashing the sign-in prompt at a reader
   * who IS signed in - or the form at one who is not - is worse than a moment of nothing. It borrows
   * the informational panel so the geometry matches whatever replaces it and the region does not
   * jump. The bars are decorative and hidden from assistive technology; the sentence beside them is
   * what a screen reader hears, so the wait is described rather than silent.
   * ------------------------------------------------------------------------------------------ */
  if (isLoading) {
    return (
      <Alert className={cn('gap-3', className)} variant="info">
        <span className="sr-only">{SESSION_LOADING_MESSAGE}</span>
        <span
          aria-hidden="true"
          className="bg-border h-4 w-1/3 rounded-md motion-safe:animate-pulse"
        />
        <span
          aria-hidden="true"
          className="bg-border h-24 w-full rounded-md motion-safe:animate-pulse"
        />
        <span
          aria-hidden="true"
          className="bg-border h-10 w-32 rounded-md motion-safe:animate-pulse"
        />
      </Alert>
    );
  }

  /* ---------------------------------------------------------------------------------------------
   * No session
   *
   * A prompt instead of a form that would only earn a 401 on submit. The link carries the current
   * path in the same `next` parameter `src/middleware.ts` writes, so signing in returns the reader
   * to the discussion they were reading. `asChild` makes the anchor wear the button's treatment
   * while staying a real link - so it opens in a new tab, copies as a URL and is crawlable.
   *
   * `info` is the right variant precisely because it supplies NO role: this is a call to action a
   * reader arrives at, not an alert that interrupts them.
   * ------------------------------------------------------------------------------------------ */
  if (!isAuthenticated) {
    return (
      <Alert className={cn('gap-3', className)} variant="info">
        <LogIn aria-hidden="true" />
        <AlertTitle>{ANONYMOUS_TITLE}</AlertTitle>
        <AlertDescription>{ANONYMOUS_DETAIL}</AlertDescription>
        <div>
          <Button asChild size="sm" variant="primary">
            <Link href={loginHref(pathname)}>{copy.signIn}</Link>
          </Button>
        </div>
      </Alert>
    );
  }

  /* ---------------------------------------------------------------------------------------------
   * The form
   *
   * `noValidate` hands validation entirely to the resolver. Without it the browser's own bubble
   * fires first, on its own wording, in its own position, and the message this form renders beside
   * the field never gets the chance to be read.
   * ------------------------------------------------------------------------------------------ */
  return (
    <form
      className={cn('flex min-w-0 flex-col gap-4', className)}
      noValidate
      onSubmit={handleSubmit((values: CommentFormValues): void => {
        const body = values.body;
        if (body === undefined) {
          /* Unreachable under both schemas - `commentCreateSchema` requires the member, and in edit
             mode the control is registered with a string default so the resolver sees `''` and
             rejects it on the minimum length. Reported beside the field rather than thrown, so a
             schema regression surfaces as a message a person can act on instead of an unhandled
             rejection nobody sees. */
          setError(BODY_FIELD, { message: EMPTY_SUBMISSION_MESSAGE, type: 'client' });
          return;
        }
        mutation.mutate(body);
      })}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor={fieldId}>{copy.label}</Label>
        {/* `aria-invalid` is conspicuously absent: `Textarea` computes it from `invalid`, so
            authoring it here would be a second source of truth for the same fact. */}
        <Textarea
          aria-describedby={describedBy(helperId, fieldError !== undefined && errorId)}
          disabled={isBusy}
          id={fieldId}
          invalid={Boolean(errors.body)}
          placeholder={copy.placeholder}
          rows={BODY_ROWS}
          {...register(BODY_FIELD)}
        />
        <p className="text-muted-foreground text-xs" id={helperId}>
          {helperFor(mode, comment?.status)}
        </p>
        {/* The message is text and the control is marked `aria-invalid`, so the failure is conveyed
            two ways that do not depend on perceiving the colour. */}
        {fieldError === undefined ? null : (
          <p className="text-danger text-xs font-medium" id={errorId}>
            {fieldError}
          </p>
        )}
      </div>

      {/* A refusal, adjacent to the control the reader has to fix. `destructive` supplies
          `role="alert"`; nothing here authors a role or an `aria-live`, because the variant already
          determines both. No toast alongside it: the form is never dismissed by a failure, so the
          notice stays on screen next to the field and a second, transient copy of the same sentence
          would only announce it twice. */}
      {failure === null ? null : (
        <Alert variant="destructive">
          <AlertTitle>{FAILURE_TITLE}</AlertTitle>
          <AlertDescription>
            <p>{failure}</p>
            {pinnedByServer ? <p>{FAILURE_FIELD_HINT}</p> : null}
          </AlertDescription>
        </Alert>
      )}

      {/* Accepted, but not yet public. This is the NORMAL outcome, not an edge case, so it gets a
          durable notice rather than only a toast that scrolls away: there is no evidence of the
          comment anywhere in the thread, and a reader left without this sentence would conclude
          their text had vanished. `warning` supplies `role="status"`, which announces politely
          without interrupting. An approved comment gets no panel - the thread itself is the
          confirmation, and the toast has already said so. */}
      {heldForApproval ? (
        <Alert variant="warning">
          <AlertTitle>{HELD_TITLE}</AlertTitle>
          <AlertDescription>{copy.heldDetail}</AlertDescription>
        </Alert>
      ) : null}

      {/* Stacked below 40rem and a right-aligned row from there up, using only the engine's own
          breakpoint scale - no custom media query anywhere in this file. DOM order is Cancel then
          submit at EVERY width, so the visual order and the focus order never disagree, and the
          primary action still ends up last in the row where the platform convention puts it. Both
          controls are full width while stacked, which is what keeps them comfortable targets at
          375px inside a reply form that its parent has already indented. */}
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
        {onCancel === undefined ? null : (
          <Button
            className="w-full sm:w-auto"
            disabled={isBusy}
            onClick={onCancel}
            type="button"
            variant="secondary"
          >
            {CANCEL_LABEL}
          </Button>
        )}
        <Button className="w-full sm:w-auto" disabled={isBusy} type="submit" variant="primary">
          {/* The pending state is carried by the LABEL as well as the spinner, so it is perceivable
              without seeing motion or colour. The icons are decorative in both states - the button's
              own text is its accessible name - and the spin is gated on `motion-safe`. */}
          {isBusy ? (
            <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
          ) : (
            <Send aria-hidden="true" />
          )}
          {isBusy ? copy.pending : copy.submit}
        </Button>
      </div>
    </form>
  );
}
