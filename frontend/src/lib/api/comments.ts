/**
 * The comment half of requirement R4: the presentation tier's typed wrapper over discussion.
 *
 * Four operations, and between them they are everything a reader, an author or a moderator can do
 * to a comment from this tier:
 *
 * | Function                | Method and path                            | Credential                |
 * | ----------------------- | ------------------------------------------ | ------------------------- |
 * | {@link listComments}    | `GET /api/v1/posts/{post_id}/comments`     | none; caller-aware        |
 * | {@link createComment}   | `POST /api/v1/posts/{post_id}/comments`    | bearer                    |
 * | {@link updateComment}   | `PATCH /api/v1/comments/{comment_id}`      | bearer, author or admin   |
 * | {@link deleteComment}   | `DELETE /api/v1/comments/{comment_id}`     | bearer, author or admin   |
 *
 * Nothing else. There is no reply-listing call, because threading is a property of the *response
 * shape* rather than of the route table - a whole thread arrives nested inside
 * `CommentPublic.replies` - and there is no moderation call, for the reason recorded under
 * "Moderation is read-only from this module" below.
 *
 * ## Two path families, mirrored from the service
 *
 * `backend/app/api/v1/routers/comments.py` is the one route module in the service that exports
 * **two** `APIRouter` objects, and the split is structural rather than stylistic: reading and
 * writing a thread are addressed *through the post that owns it*, while correcting or removing a
 * single comment addresses that comment directly by its own identifier. The service's aggregate
 * mounts the first router beneath `/posts` and the second beneath `/comments`, and files all four
 * operations under one `comments` section of the generated document.
 *
 * This module mirrors that split exactly. {@link listComments} and {@link createComment} compose
 * `/posts/{id}/comments`; {@link updateComment} and {@link deleteComment} compose
 * `/comments/{id}`; and **no function here mixes the two prefixes.** Both identifiers are the
 * server-generated UUIDs the API emits - never a slug. A slug keys the *post* detail read in
 * `@/lib/api/posts`, and no slug-keyed comment route exists anywhere in this API, so the habit does
 * not carry across.
 *
 * ## What this module deliberately does not do
 *
 * - **No transport.** No `fetch`, no `Headers`, no `AbortController`, no read of `response.ok` or
 *   `response.status`, no retry, no bearer attachment and no error mapping. `@/lib/api/client` is
 *   the tier's only HTTP module and owns every one of those concerns; this file contributes paths,
 *   query shaping, request-body shaping and return types, and delegates the rest.
 * - **No re-shaping of the page.** {@link listComments} returns the service's envelope byte for
 *   byte. See {@link listComments} for why recounting it would be a defect rather than a
 *   correction.
 * - **No moderation.** `CommentPublic.status` is published so an author can see their comment is
 *   queued and a moderation screen can render a state, and **nothing here can change it.** The
 *   single mutation site is `PATCH /api/v1/admin/comments/{id}/status`, wrapped by
 *   `@/lib/api/admin`, behind an administrator dependency the service applies at router level. An
 *   approve or reject function on this module would be a moderation bypass on a surface a
 *   commenter can reach, so its absence is a security boundary rather than a missing convenience.
 * - **No subtree walk on delete.** `comments.parent_id` is a self-referencing foreign key with
 *   `ON DELETE CASCADE`, so one statement in the database removes a comment and every reply beneath
 *   it at any depth. {@link deleteComment} issues exactly one request.
 * - **No sanitisation.** The service cleans a submitted body with `bleach` before storing it, and
 *   `@/components/blog/post-content` sanitises again where content is rendered. This module does
 *   not strip, escape, trim or otherwise mutate the text it carries in either direction: a wrapper
 *   that quietly edited a body would make the two sanitisation policies three, and the third would
 *   be the one nobody knows about.
 * - **No permission check.** "The author, or an administrator" is compared inside
 *   `backend/app/services/comment_service.py` against the row it has already loaded, which is the
 *   only place that comparison can be made. A copy written here could only ever disagree with it,
 *   and pre-empting a `403` would also hide it: an attempt the caller was not entitled to make must
 *   surface as the API's own normalised rejection.
 * - **No client state.** Comment creation is one of the two interactions this product updates
 *   optimistically, and the rollback that makes optimism safe belongs to the hook that owns the
 *   cache entry. This module holds no state, caches nothing, and imports no query client - which is
 *   precisely what lets a hook wrap it and own the rollback.
 * - **No `'use client'` directive and no browser-only global.** `src/app/blog/[slug]/page.tsx` is a
 *   Server Component that renders a thread into the initial HTML, so `window`, `document` and
 *   `localStorage` are unreachable from this module by construction.
 * - **No third-party import, no camel-case translation, no barrel.** `frontend/package.json`
 *   declares neither `axios` nor `swr` and neither is needed. Wire field names stay in the
 *   service's own snake_case exactly as `@/lib/types` mirrors them - re-spelling `parent_id` would
 *   produce a type that compiles and a reply that silently becomes a root comment. There is no
 *   `@/lib/api/index`; consumers import `@/lib/api/comments` directly.
 *
 * ## Every failure arrives as a rejection
 *
 * All four functions are `async`, and that is a contract rather than an accident of style. A
 * rejected request, an unreachable service and a malformed identifier passed by a caller all reach
 * the caller through the same channel, so `try`/`catch` around an `await` - or a `.catch()` on the
 * returned promise - is sufficient in every case and nothing can escape as a synchronous throw from
 * a call that looks asynchronous. Rejections are `ApiError` - the single normalised failure of
 * `@/lib/api/client`, carrying the service's problem document - for anything the transport saw, and
 * a plain `Error` for the one caller defect described on {@link identifierSegment}.
 *
 * ## Governing standards
 *
 * `review_rules` reports that this project supplies **no user-specified rules**, so none is
 * invented here and the technical plan's own enterprise standards stand in their place. Five decide
 * the shape of this module:
 *
 * | Standard                         | How this module satisfies it                                                                   |
 * | -------------------------------- | ---------------------------------------------------------------------------------------------- |
 * | Layered separation of concerns   | Imports `@/lib/api/client` and `@/lib/types` and nothing else; no transport, no state, no view  |
 * | Explicit API contracts           | Every export declares a return type from `@/lib/types`; the page envelope is passed through     |
 * | API versioning                   | Namespace-relative paths only; `/api/v1` is composed once, by `@/lib/api/client`                |
 * | Secure-by-default authentication | No permission test here; authority and moderation stay server-side and in the admin namespace   |
 * | Blocking quality gates           | Compiles under `tsc --noEmit`, lints at `--max-warnings=0`, explicit return type on every export |
 *
 * @module
 */

import { apiDeleteNoContent, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import { encodePathSegment } from '@/lib/paths';
import type { RequestOptions } from '@/lib/api/client';
import { commentPublicSchema, pageOf } from '@/lib/types';
import type { CommentCreate, CommentPublic, CommentUpdate, Page } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Path composition
 *
 * Two builders, one per family, and each writes its family's shape exactly once. Paths are
 * namespace-relative: `@/lib/api/client` composes `/api/v1` in a single place and rejects a path
 * that arrives already carrying it, so neither builder below may name a version.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Turn a caller-supplied identifier into one safe path segment, or reject it.
 *
 * Two things happen here and the distinction between them matters:
 *
 * 1. **A blank identifier is refused, loudly.** `''` or whitespace would compose `/posts//comments`
 *    or `/comments/`, which the service answers with a `404` or a `422` whose cause is nowhere near
 *    the mistake that produced it. `@/lib/api/client` sets the precedent for this: it throws when a
 *    caller hands it a path that already carries the version prefix, and when the API base URL is
 *    unset, rather than silently repairing either.
 * 2. **What survives is percent-encoded.** `@/lib/api/client` interpolates a path into the request
 *    URL verbatim - correctly, since encoding a whole path would destroy its separators - so
 *    encoding a *segment* is this module's job. For the canonical hyphenated UUID the API actually
 *    emits the call is a no-op; for anything else it is containment, keeping a stray `/`, `?` or `#`
 *    inside the segment instead of letting it restructure the request.
 *
 * Deliberately **not** a format check. Whether an identifier names a real comment, and whether it
 * is a well-formed UUID, are decided server-side and reported as `404` and `422` respectively;
 * `@/lib/validation/comment` checks the shape of a *submitted* parent before it is ever sent. A
 * third copy of that rule here would be the copy that has to be found and changed if identity ever
 * stops being a UUID.
 *
 * @param value - The identifier as the caller supplied it.
 * @param parameterName - The parameter's own name, so the message names the argument at fault.
 * @returns The trimmed, percent-encoded value, ready to interpolate.
 * @throws Error when `value` is empty or contains only whitespace. A programming error in the
 * caller, surfaced as a rejection because every function in this module is `async`.
 */
function identifierSegment(value: string, parameterName: string, operation: string): string {
  // Through the tier's ONE encoder, which refuses more than a blank value: `.` and `..` are
  // already URL-safe, so percent-encoding leaves them intact and the URL grammar resolves
  // `/posts/../auth/me/comments` against the surrounding path - a successful request against a
  // route this wrapper never named, carrying the reader's bearer and reporting no error.
  return encodePathSegment(value, {
    operation,
    parameterName,
    hint: 'Pass the UUID the API emitted for the resource.',
  });
}

/**
 * `/posts/{post_id}/comments` - the post-scoped family, for {@link listComments} and
 * {@link createComment}.
 *
 * The post is named in the path and nowhere else, which is an authorisation property rather than a
 * tidiness one: the service's request model forbids a `post_id` in the body precisely so that a
 * caller cannot name a second post the request was never authorised against.
 */
function threadPath(postId: string, operation: string): string {
  return `/posts/${identifierSegment(postId, 'postId', operation)}/comments`;
}

/**
 * `/comments/{comment_id}` - the standalone family, for {@link updateComment} and
 * {@link deleteComment}.
 *
 * A comment is addressed by its own identifier here, with no post segment: the service loads the
 * row and derives the post from it, so a caller cannot assert one.
 */
function commentPath(commentId: string, operation: string): string {
  return `/comments/${identifierSegment(commentId, 'commentId', operation)}`;
}

/* -------------------------------------------------------------------------------------------------
 * Caller-facing option and parameter shapes
 * ---------------------------------------------------------------------------------------------- */

/**
 * The per-call transport controls these four operations accept: everything `RequestOptions` offers
 * **except** `query`.
 *
 * Forwarding the rest is what lets a Server Component decide how its data is cached
 * (`cache`, `next.revalidate`, `next.tags`), lets a client island cancel a request it no longer
 * needs (`signal`), and lets a caller deliberately withhold a credential it holds (`anonymous`) to
 * see a thread exactly as an anonymous reader would.
 *
 * `query` is omitted rather than merged, and the omission is load-bearing: the only query surface
 * these routes have is the page window, {@link listComments} builds it from
 * {@link ListCommentsParams}, and a second source for it could silently override the window a
 * caller asked for. Making that a compile error is cheaper than making it a bug.
 */
export type CommentRequestOptions = Omit<RequestOptions, 'query'>;

/**
 * The page window for {@link listComments}, in the wire's own spelling.
 *
 * These two are the entire query surface of `GET /api/v1/posts/{id}/comments` - the service's page
 * dependency declares `page` and `page_size` and nothing else - so there is no sort, no author
 * filter and, deliberately, **no status filter**: which moderation states are in scope is decided
 * from the caller's credential server-side, at every level of the thread, and a client-supplied
 * status would be a request to see comments the service has already decided are not for this
 * caller.
 *
 * `page_size` keeps its snake_case wire name on purpose. There is no camel-case translation layer
 * anywhere in this tier, so a camel-cased member would serialise to a parameter the service ignores
 * and the only symptom would be a window silently reverting to its default.
 *
 * Both members are optional and both omissions are meaningful: the service defaults `page` to 1 and
 * `page_size` to 20, and omitting a member is how a caller asks for that default rather than
 * restating it. Neither is validated here - the service accepts `page >= 1` and `page_size` in
 * 1..100 and **rejects** anything else with a `422` naming the parameter rather than quietly
 * clamping it, so a control offering page sizes must keep its own options inside that range.
 */
export interface ListCommentsParams {
  /** 1-based page of top-level comments. Omit for the service's default of 1. */
  page?: number;
  /** Threads per page, 1 to 100. Omit for the service's default of 20. */
  page_size?: number;
}

/* -------------------------------------------------------------------------------------------------
 * Request-body shaping
 *
 * Both service input models are declared with `extra="forbid"`, so a surplus member is a `422`
 * rather than a value the service politely ignores. Each helper below therefore constructs the
 * outgoing document member by member instead of forwarding the caller's object, which is what makes
 * "only these members can travel" a property of the code rather than a promise about it.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Build the create document: the text, and the parent only when there genuinely is one.
 *
 * `parent_id` is the *entire* difference between a comment and a reply, so its treatment is the one
 * subtlety in this file's write path. `undefined` and `null` mean "this is a top-level comment" and
 * the member is left out of the document altogether: the service accepts an omitted *or* null parent
 * as top-level, and `@/lib/validation/comment` permits a form to submit `parent_id: null` for a root
 * comment, so the normalisation is reached in practice rather than being defensive decoration.
 *
 * **A blank or whitespace-only value is REFUSED rather than normalised**, and the distinction is the
 * point. Silently dropping `''` posted a reply as a NEW ROOT COMMENT: the reader saw their answer
 * detached from the message they were answering, with nothing failing anywhere and no way to tell
 * that the thread had been reshaped. An empty string is not a caller saying "top level" - it is a
 * caller whose identifier went missing, and the only honest answer is to say so before a request is
 * spent creating the wrong resource.
 *
 * What cannot appear, and why each absence is deliberate: `post_id`, because the post comes from the
 * path and a body-supplied one would be a second, unchecked way to name it; `author_id`, because
 * authorship is taken from the bearer token's resolved principal and could not be attributed by a
 * request; `status`, because a new comment is created awaiting moderation and a caller that could
 * set it could approve its own text.
 *
 * `body` is passed through untouched - not trimmed, not escaped, not truncated. The service trims
 * and sanitises it, and doing either here would put a third policy in play.
 */
function toCreateDocument(input: CommentCreate): CommentCreate {
  const parentId = input.parent_id;
  if (parentId === undefined || parentId === null) {
    return { body: input.body };
  }
  if (parentId.trim() === '') {
    throw new TypeError(
      'createComment: parent_id was supplied but is blank, so it cannot address a comment. ' +
        'Omit the member (or pass null) for a top-level comment; otherwise pass the UUID the API ' +
        'emitted for the comment being replied to - dropping a blank value would post the reply ' +
        'as a new root comment with nothing reporting an error.',
    );
  }
  return { body: input.body, parent_id: parentId };
}

/**
 * Build the edit document: the replacement text, and only that.
 *
 * The route's whole contract is "edit a comment's body". An omitted `body` is a legitimate empty
 * patch that the service accepts and that changes nothing, so `{}` is produced rather than a member
 * carrying `undefined` - the service rejects an explicit `null` for this member, and an empty
 * document says the same thing without testing that boundary.
 *
 * `status` and `parent_id` are absent, and the service refuses both. `status` on a route the
 * comment's own author can reach would let a commenter approve a replacement body after an
 * innocuous one was approved; `parent_id` would silently re-parent a comment other readers have
 * already replied within, taking its subtree with it. A thread's shape is fixed when its rows are
 * written, and moving a comment is not an operation this API has.
 */
function toUpdateDocument(input: CommentUpdate): CommentUpdate {
  return input.body === undefined ? {} : { body: input.body };
}

/* -------------------------------------------------------------------------------------------------
 * Family A - the post-scoped routes, beneath `/posts/{post_id}/comments`
 * ---------------------------------------------------------------------------------------------- */

/**
 * Read one page of a post's discussion.
 *
 * Public: no credential is required, and an anonymous caller receives approved comments only,
 * nested replies included. A caller whose credential the client is holding is additionally shown
 * the comments that principal is entitled to see - their own comment awaiting moderation, or, for an
 * administrator, the queue - which is why this is described as caller-aware rather than anonymous.
 * Pass `anonymous: true` through {@link CommentRequestOptions} to see the thread as an anonymous
 * reader would even while a credential is held.
 *
 * ## The page counts threads, not comments - and it is returned untouched
 *
 * The envelope's members are the post's **top-level** comments, each arriving with the replies that
 * answer it already nested inside `CommentPublic.replies`. `total` and `pages` therefore count
 * *threads*, and a reply is never a page member in its own right.
 *
 * That is deliberate and load-bearing, so **do not "fix" the count.** Were replies counted as page
 * members, a page boundary could put a comment on one page and one of its own replies on the next,
 * where the client would re-nest it under a parent it had already rendered: the same reply would
 * appear twice, `total` would describe a set no client could reconstruct, and adding one reply would
 * reshuffle every subsequent page. Counting threads is what keeps consecutive pages disjoint and
 * `total` stable.
 *
 * This function consequently returns the service's envelope **exactly as received**. It is not
 * flattened, re-sliced, re-ordered, re-counted or re-windowed here, and the page arithmetic is
 * performed once, server-side, so every collection in this API windows identically and one
 * pagination control drives them all. A page beyond the last one is not an error: it answers with an
 * empty `items` array beside the real `total` and `pages`, which is how a caller detects that it has
 * run off the end.
 *
 * @param postId - Identifier of the post whose thread to read.
 * @param params - The page window. Omit either member to take the service's default.
 * @param options - Transport controls; typically `next.revalidate` from a Server Component.
 * @returns One page of top-level comments, each carrying its nested replies.
 * @throws `ApiError` with status `404` when no post carries that identifier **or** the post is not
 * visible to this caller - a draft's thread is unreachable to anyone but its author and an
 * administrator, and reporting it as absent rather than forbidden is what stops the response
 * confirming that the draft exists. `422` when the window falls outside the accepted range.
 *
 * @example
 * ```ts
 * // A Server Component rendering the second page of a thread into the initial HTML.
 * const thread = await listComments(post.id, { page: 2 }, { next: { revalidate: 60 } });
 * // thread.pages is 0 for a post nobody has commented on - render no control at all.
 * ```
 */
export async function listComments(
  postId: string,
  params: ListCommentsParams = {},
  options?: CommentRequestOptions,
): Promise<Page<CommentPublic>> {
  // Both members are forwarded unconditionally because the client's query serialiser drops an
  // undefined one: a call that names no window therefore produces a bare path with no query string
  // at all, and the service applies its own defaults. Nothing is defaulted here, which leaves
  // exactly one definition of "page 1, twenty rows" - the service's.
  return apiGet(threadPath(postId, 'listComments'), pageOf(commentPublicSchema), {
    ...options,
    anonymousFallback: true,
    query: { page: params.page, page_size: params.page_size },
  });
}

/**
 * Add a comment to a post, or a reply to a comment on it.
 *
 * Requires a credential and nothing more: no role is needed, so a reader who has just registered may
 * join a discussion. Supplying `parent_id` on `input` is what makes the new comment a reply, and the
 * parent must belong to the post named here - the service verifies that rather than trusting it, and
 * reports a parent that is missing, that hangs off another post, that is itself awaiting moderation
 * or that already sits at the maximum reply depth as a `422` against the field.
 *
 * The response is `201` with the created comment. Two things about it are worth rendering
 * deliberately. Its `status` is the moderation state the service assigned, not one the author asked
 * for, so a new comment should be presented as the author's own contribution *awaiting review*
 * rather than as something already public. And its `replies` array is empty, which is simply true: a
 * comment that has just been written has nothing answering it yet.
 *
 * **A rejected submission has written nothing**, which is what makes an optimistic insertion sound:
 * the rollback restores the truth, and the draft is still in the form to re-submit. The optimistic
 * entry and its rollback belong to the hook that owns the cache; this function neither performs nor
 * assumes either.
 *
 * **This is not an idempotent operation and there is no idempotency key.** A retry is safe only when
 * the request demonstrably did not reach the service - a rejection, a refusal, or an abort before
 * dispatch. A request that committed and whose response was lost has already created the comment,
 * and re-sending it creates a second one, so a resubmission after an ambiguous failure (a timeout,
 * an aborted read, a network error mid-response) must be a decision the reader makes rather than one
 * the client makes for them. Re-reading the thread reconciles it: a duplicate is visible there, and
 * its author can delete it.
 *
 * @param postId - Identifier of the post being commented on. The only source for it, by design.
 * @param input - The text, and optionally the comment being replied to. Nothing else is sent.
 * @param options - Transport controls; a `signal` to abandon a submission, for instance.
 * @returns The created comment, as the service projected it.
 * @throws `ApiError` with status `401` when no usable credential is held, `404` when the post does
 * not exist or is not visible to this caller, `422` when the text or the named parent is rejected,
 * and `409` when the post, the parent or the account is removed between validation and the insert -
 * which reports a row that is gone rather than a transient fault, so re-sending the same body will
 * report it again.
 *
 * @example
 * ```ts
 * const comment = await createComment(post.id, { body: 'Clear, thank you.' });
 * const reply = await createComment(post.id, { body: 'Agreed.', parent_id: comment.id });
 * ```
 */
export async function createComment(
  postId: string,
  input: CommentCreate,
  options?: CommentRequestOptions,
): Promise<CommentPublic> {
  return apiPost(
    threadPath(postId, 'createComment'),
    commentPublicSchema,
    toCreateDocument(input),
    options,
  );
}

/* -------------------------------------------------------------------------------------------------
 * Family B - the standalone routes, beneath `/comments/{comment_id}`
 * ---------------------------------------------------------------------------------------------- */

/**
 * Correct a comment's text.
 *
 * A genuine partial update of a single member: the replacement text and nothing else travels, and an
 * `input` with no `body` is an accepted empty patch that changes nothing. Authority is "the author,
 * or an administrator", and it is decided server-side against the row the service has already
 * loaded; anyone else receives `403`. There is no ownership test here, and adding one would be a
 * defect rather than defence in depth - a second copy of that rule is the copy that eventually
 * disagrees, and hiding an edit control in the UI does not stop the request being sent anyway.
 *
 * The returned comment's `status` may differ from the value the caller last saw without the caller
 * having asked for a change: an accepted edit to an approved comment returns it to awaiting
 * moderation, so replaced text is reviewed before it is public again. Treat the response as
 * authoritative rather than merging the submitted text into the comment already on screen.
 *
 * **The response carries the comment's reply tree**, nested to full depth in `replies` and narrowed
 * to the moderation states this caller may see - the same states {@link listComments} would show
 * them. So replacing the edited node in a cached thread with this response is the correct update and
 * loses nothing: the discussion beneath it comes back with it. (It did not always: an earlier
 * revision answered with `replies: []`, and replacing a cached node with that answer silently
 * removed every descendant from the rendered thread.) A comment with no visible replies still comes
 * back with an empty array rather than an absent one, so the field never has to be guarded.
 *
 * @param commentId - Identifier of the comment to edit.
 * @param input - The replacement text, or an empty patch. Carries no `status` and no `parent_id`.
 * @param options - Transport controls.
 * @returns The updated comment, as the service projected it.
 * @throws `ApiError` with status `401` when no usable credential is held, `404` when no comment
 * carries that identifier - reported before authority is considered, so a comment the caller may not
 * touch is indistinguishable from one that is absent - `403` when the principal neither wrote the
 * comment nor holds the administrator role, and `422` when the replacement sanitises to nothing.
 *
 * @example
 * ```ts
 * const corrected = await updateComment(comment.id, { body: 'Corrected: the cascade recurses.' });
 * // corrected.status may now be awaiting review again, even for an administrator.
 * ```
 */
export async function updateComment(
  commentId: string,
  input: CommentUpdate,
  options?: CommentRequestOptions,
): Promise<CommentPublic> {
  return apiPatch(
    commentPath(commentId, 'updateComment'),
    commentPublicSchema,
    toUpdateDocument(input),
    options,
  );
}

/**
 * Remove a comment, and with it every reply beneath it.
 *
 * Answers `204 No Content`, so this call resolves to nothing and **no body is read**: the
 * no-content path of `@/lib/api/client` is used precisely because calling `.json()` on an empty body
 * throws a parse error that has nothing to do with the request. The status code is the entire
 * answer.
 *
 * The subtree is removed by the database, not by this module. `comments.parent_id` is a
 * self-referencing foreign key with `ON DELETE CASCADE`, so one statement clears the comment and
 * every descendant at any depth. This function therefore issues exactly one request and walks
 * nothing: a client-side sweep would be a second definition of a rule the schema already guarantees,
 * it would be the copy that forgets a relation added later, and it is exactly the shape being retired
 * from this project's original single-module service, which scanned a list and removed one element at
 * a time. There is no companion cleanup to perform either - the likes and replies that hung off the
 * comment go with it.
 *
 * Authority is "the author, or an administrator", checked server-side; anyone else receives `403`.
 * Deletion is final and is **not** the moderation tool: a comment that should stop being public
 * without ceasing to exist is rejected through `@/lib/api/admin` instead, which keeps the decision
 * reversible and the author's history intact.
 *
 * @param commentId - Identifier of the comment to remove.
 * @param options - Transport controls.
 * @returns Nothing. A `204` carries no body, so there is nothing to parse and nothing to return.
 * @throws `ApiError` with status `401` when no usable credential is held, `404` when no comment
 * carries that identifier, and `403` when the principal neither wrote the comment nor holds the
 * administrator role.
 *
 * @example
 * ```ts
 * await deleteComment(comment.id);
 * // Every reply beneath it is gone too, in the same statement, without a second request.
 * ```
 */
export async function deleteComment(
  commentId: string,
  options?: CommentRequestOptions,
): Promise<void> {
  return apiDeleteNoContent(commentPath(commentId, 'deleteComment'), options);
}
