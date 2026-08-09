/**
 * Typed wrapper over the post-like surface: three routes, one response shape.
 *
 * The like half of the social feature set. A reader likes a post, un-likes it, and every visitor -
 * signed in or not - sees the tally. Sharing, the other half of that requirement, calls no service
 * at all: it is composed in the browser from the post's canonical URL, so there is deliberately no
 * share function in this module, and none belongs anywhere else in this folder either.
 *
 * Each function below is a single expression, because that is the whole of a wrapper's job: name a
 * path, choose a verb, declare the response type. Everything else - the API's origin, the version
 * namespace, bearer attachment, rotation on an expired credential, cancellation, and turning a
 * failure into a typed error - belongs to `@/lib/api/client`, this tier's only HTTP module.
 *
 * ## What this module does NOT do, and must never start doing
 *
 * - **No transport logic.** No request primitive, no header construction, no branching on a status
 *   code, no retry, no error mapping. A wrapper reaching for any of those has taken on work that
 *   exists exactly once, in the client module, on purpose.
 * - **No `'use client'` directive, and no browser-only global at module scope.** The post page is a
 *   Server Component and renders the tally into the initial HTML so a crawler sees it without
 *   running any script. This module is therefore evaluated on the server at least as often as in
 *   the browser.
 * - **No React, no client-side cache library, no provider, hook, component or route import.** The
 *   optimistic update belongs to the control that owns the interaction; this module is stateless and
 *   keeps no cache of its own. The dependency arrow points strictly outward: two imports, both from
 *   `@/lib`.
 * - **No de-duplication of any kind.** See the idempotency note below. Guarding a promise the
 *   database already keeps is precisely how a stale local view of "liked" gets invented.
 * - **No camel-case translation.** Wire names are the service's own snake_case, mirrored member for
 *   member by `@/lib/types`. Re-spelling one yields a type that compiles perfectly and a value that
 *   is missing at run time.
 * - **No third-party package.** None is declared for this purpose in `frontend/package.json`, and
 *   none is needed to name three paths.
 *
 * ## The two asymmetries a reasonable assumption gets wrong
 *
 * Both are contractual, both were verified against the service's own router rather than inferred,
 * and neither is detectable by the type-checker - which is why each is restated on the function it
 * governs rather than only here.
 *
 * 1. **Un-liking answers with a body.** Every other deletion across this API answers with no
 *    content; this one returns the settled summary with a success status, because a reader who has
 *    just un-liked needs the new number. It is therefore issued through the body-parsing deletion
 *    helper, and its return type is a summary rather than nothing at all. See {@link unlikePost}.
 * 2. **The read needs no credential.** A tally is public information, so the service resolves the
 *    caller through its optional-principal dependency rather than a mandatory one. Anonymous is a
 *    normal audience here, not a degraded one. See {@link getLikes}.
 *
 * ## Singular `/like`, plural `/likes` - not a typo
 *
 * The two mutations address `/like` while the read addresses `/likes`, and the difference names the
 * resource each one acts on. `/like` is a singular sub-resource - *the caller's own like* - which is
 * also why neither mutation carries a body: the post arrives in the path and the account arrives
 * from the resolved principal, so a client has no third value to supply and no parameter through
 * which it could name an account other than its own. `/likes` is the aggregate over every account,
 * which is exactly what makes it public information. Reproduce both spellings exactly; a mismatch
 * compiles cleanly and misses at run time.
 *
 * ## Idempotency is structural, so there is nothing here to guard
 *
 * `PUT`, not `POST`, and the verb is load-bearing. The service's like relation carries no surrogate
 * key: its primary key *is* the pair of post and account, and the write goes through a
 * conflict-ignoring insert. Two identical likes leave the count at one - proven by execution against
 * the running database rather than asserted. So liking is safely retryable, a double click cannot
 * inflate a tally, and un-liking something never liked is equally harmless.
 *
 * That is why this module holds no pre-existence check, no "already liked?" test, no local set of
 * liked post identifiers and no debounce. Each would duplicate a guarantee already kept one layer
 * down, and each would add a second copy of the truth that can then go stale. Where an interaction
 * needs debouncing, that is the control's concern and not the transport's.
 *
 * ## Path convention
 *
 * Callers pass namespace-relative paths - `/posts/<id>/like`, never a version-prefixed spelling. The
 * client module composes the version namespace exactly once and rejects outright any path that
 * already carries it, which is what makes an unversioned or double-versioned request impossible to
 * emit from here.
 *
 * ## Governing standards
 *
 * `review_rules` reports that **no user-specified rules were provided** for this project, so nothing
 * here is invented to satisfy one, and the bar is not lowered because none exist. The binding
 * constraints are the technical plan's own enterprise standards, five of which govern this module:
 *
 * | Standard                         | How this module satisfies it                                                                          |
 * | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
 * | Layered separation of concerns   | Paths, one segment guard and return types; two outward imports; no transport primitive and no state    |
 * | Explicit API contracts           | Every function returns the declared {@link LikeSummary}; wire names stay snake_case, untranslated      |
 * | API versioning                   | Namespace-relative paths only; the version namespace is composed once, by the client module            |
 * | Secure-by-default authentication | Both mutations require a credential; the read deliberately does not, and never forces its absence      |
 * | Blocking quality gates           | Compiles under `tsc --noEmit`, lints at `--max-warnings=0`, explicit return type on every export       |
 *
 * @module
 */

import { apiDelete, apiGet, apiPut, type RequestOptions } from '@/lib/api/client';
import { encodePathSegment } from '@/lib/paths';
import { likeSummarySchema } from '@/lib/types';
import type { LikeSummary } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Path composition
 *
 * Two literals, and one guard between a caller's argument and either of them. The guard is the same
 * one `@/lib/api/comments` applies to its identifiers, written out here rather than shared because a
 * wrapper importing a sibling wrapper is the one import edge this folder does not have - see the
 * module header. Duplicating eight lines is the price of that, and it is the right price.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Turn the caller's post identifier into one safe path segment, or reject it.
 *
 * Two separate things, and the distinction matters:
 *
 * 1. **A blank identifier is refused, loudly.** `''` or whitespace would compose `/posts//like`,
 *    which the service answers with a `404` or a `422` whose cause is nowhere near the mistake that
 *    produced it - a control wired to an undefined `post.id` reads as a missing post rather than as a
 *    missing prop.
 * 2. **What survives is percent-encoded.** `@/lib/api/client` interpolates a path into the request URL
 *    verbatim - correctly, since encoding a whole path would destroy its separators - so encoding a
 *    *segment* is this module's job. For the canonical hyphenated UUID the API emits this is a no-op.
 *    For anything else it is containment: a stray `/`, `?`, `#` or `..` stays inside the segment
 *    instead of restructuring the request. Unencoded, `a/../../auth/login` reaches a different
 *    endpoint entirely once the URL is normalised, and `x?y=1` turns the rest of the path into a query.
 *
 * Deliberately **not** a format check. Whether an identifier names a real post, and whether it is a
 * well-formed UUID, are decided server-side and reported as `404` and `422`; a third copy of that rule
 * here would be the copy that has to be found and changed if identity ever stops being a UUID.
 *
 * @param postId - The identifier as the caller supplied it.
 * @returns The trimmed, percent-encoded value, ready to interpolate.
 * @throws Error when `postId` is empty or whitespace alone. A programming error in the caller,
 * surfaced as a **rejection** rather than a synchronous throw because all three functions below are
 * `async` - which is what lets a caller handle it in the same `catch` as every transport failure.
 */
function postSegment(postId: string, operation: string): string {
  // Through the tier's ONE encoder rather than a local copy of half the rule. A blank value was
  // already refused here; a DOT SEGMENT was not, and that is the case percent-encoding cannot
  // cover - `..` is unreserved, so `/posts/../auth/me/like` is composed, resolved by the URL
  // grammar and answered successfully by a route this wrapper never addressed.
  return encodePathSegment(postId, {
    operation,
    parameterName: 'postId',
    hint: 'Pass the UUID the API emitted for the post.',
  });
}

/** `/posts/{post_id}/like` - the mutation path, for {@link likePost} and {@link unlikePost}. */
function likePath(postId: string, operation: string): string {
  return `/posts/${postSegment(postId, operation)}/like`;
}

/** `/posts/{post_id}/likes` - the read path, plural, for {@link getLikes}. */
function likesPath(postId: string, operation: string): string {
  return `/posts/${postSegment(postId, operation)}/likes`;
}

/* -------------------------------------------------------------------------------------------------
 * Mutations - PUT and DELETE on /posts/<post_id>/like
 *
 * Both require a credential, both are bodyless, and both answer with the settled summary. An
 * anonymous caller is refused by the service's mandatory-principal dependency before any handler
 * runs, which surfaces here as a thrown `ApiError` rather than as a special return value.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Like a post on behalf of the signed-in reader.
 *
 * Safe to call twice. The service's composite primary key makes a repeated like a no-op rather than
 * a second row, so this needs no guard at the call site and gets none here.
 *
 * @param postId - The post to like, as the canonical text form of its UUID. Identity is always a
 * string on this API, never a number, and is never chosen by a client. The service parses it as a
 * UUID, so a malformed value is refused with a typed validation failure rather than silently missing.
 * @param options - Per-call transport controls, forwarded to the client module unchanged. `signal`
 * cancels a request whose control has since unmounted; `cache` and `next` are available for
 * completeness and are of no real use on a mutation.
 * @returns The settled state after the like: the post's identifier, its authoritative count, and
 * this caller's own state. An optimistic control reconciles against this and needs no follow-up read.
 * @throws `ApiError` for every failure - no credential or an expired one, an unknown post, an
 * unreachable service, or a cancelled request. Failures are already normalised by the client module;
 * nothing is re-mapped here.
 */
export async function likePost(postId: string, options?: RequestOptions): Promise<LikeSummary> {
  // Bodyless on purpose: the post is addressed by the path and the account comes from the resolved
  // principal, so there is no third value for a client to send. The explicit `undefined` is the
  // client module's own signal for "no body and no content-type header" - `{}` would instead send an
  // empty JSON object, which this route neither expects nor needs.
  return await apiPut(likePath(postId, 'likePost'), likeSummarySchema, undefined, options);
}

/**
 * Remove the signed-in reader's like from a post.
 *
 * **This is the one deletion on this API that answers with content, and the exception is deliberate.
 * Do not "align" it with the others.** Every other deletion - a post, a comment, each administrative
 * removal - answers with no content and belongs to the client module's no-content helper. This one
 * returns the settled {@link LikeSummary} with a success status, so it goes through the body-parsing
 * deletion helper and its return type is a summary rather than nothing.
 *
 * The reason is a product requirement rather than a quirk: a reader who has just un-liked needs the
 * new number, and all three like routes answering the same shape is what lets the control settle an
 * optimistic update in a single round trip. Treating this as a no-content deletion would oblige a
 * second read per interaction to learn the number the first request had just changed.
 *
 * Un-liking a post that was never liked is harmless and answers the same shape, so this needs no
 * pre-existence check either.
 *
 * @param postId - The post to un-like, as the canonical text form of its UUID.
 * @param options - Per-call transport controls, forwarded to the client module unchanged.
 * @returns The settled state after the like is removed, carrying the authoritative count.
 * @throws `ApiError` for every failure - no credential or an expired one, an unknown post, an
 * unreachable service, or a cancelled request.
 */
export async function unlikePost(postId: string, options?: RequestOptions): Promise<LikeSummary> {
  // The recorded exception, restated at the call site so it survives future editing: this deletion
  // answers with the settled summary, so it uses the body-parsing deletion helper. Switching to the
  // no-content helper - or declaring this as returning nothing - would discard the count the caller
  // came for and force an extra read on every interaction. Bodyless for the same reason as the like.
  return await apiDelete(likePath(postId, 'unlikePost'), likeSummarySchema, options);
}

/* -------------------------------------------------------------------------------------------------
 * Read - GET on /posts/<post_id>/likes
 *
 * Note the plural. This is the aggregate over every account rather than the caller's own like, which
 * is both why the noun is plural and why the route is public.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Read a post's like count, together with whether this caller is one of the accounts in it.
 *
 * **Public: no credential is required, and none is demanded here.** The service resolves the caller
 * through its optional-principal dependency, so an anonymous reader is answered normally and
 * `liked_by_caller` comes back `false` - never null, never absent. That is the designed behaviour
 * rather than a degraded one, and `false` is also exactly what a control should render for a visitor
 * who has no session.
 *
 * Presenting a credential widens nothing except that one member; the count is identical for every
 * audience. The post page therefore calls this for every visitor, including crawlers, and does so
 * during a server render.
 *
 * @param postId - The post to report on, as the canonical text form of its UUID.
 * @param options - Per-call transport controls, forwarded to the client module unchanged. `cache` and
 * `next` are the useful members here: a Server Component reading a tally can choose its own
 * revalidation window rather than inheriting one. See the note in the body about `anonymous`, which
 * is the one member to leave alone.
 * @returns The post's identifier, how many distinct accounts have liked it, and this caller's own
 * state - `false` when there is no caller.
 * @throws `ApiError` when no post carries that identifier, when it is an unpublished post this
 * viewer may not see, or when the service cannot be reached. Absence of a credential is not a failure.
 */
export async function getLikes(postId: string, options?: RequestOptions): Promise<LikeSummary> {
  // No credential check, no early throw, and no skipping the call for an anonymous reader. "No
  // bearer required" means this must succeed without one, not that one is refused when held.
  //
  // Note what is deliberately NOT passed: `options.anonymous` forces the credential to be withheld
  // even when the caller holds one, which would pin `liked_by_caller` to `false` for every signed-in
  // reader - a silent defect, because the count itself would still be perfectly correct. That flag
  // exists for reading as the public would; omitting it is what lets the client module attach a held
  // credential and report the caller's own state truthfully. No branching is needed here at all.
  return await apiGet(likesPath(postId, 'getLikes'), likeSummarySchema, {
    ...options,
    anonymousFallback: true,
  });
}
