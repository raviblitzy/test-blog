/**
 * Typed wrapper over the `/users` namespace: one authenticated self-update and two public
 * profile reads.
 *
 * Together these three calls are the transport half of "include user profiles showing published
 * articles". `src/app/u/[username]/page.tsx` renders a profile from the first two, `src/app/
 * sitemap.ts` enumerates author profiles through them, and the account settings form submits
 * through the third.
 *
 * | Export          | Operation                      | Credential | Answers             |
 * | --------------- | ------------------------------ | ---------- | ------------------- |
 * | {@link updateMe}      | `PATCH /users/me`              | bearer     | `UserMe`            |
 * | {@link getProfile}    | `GET /users/{username}`        | none       | `UserPublic`        |
 * | {@link getUserPosts}  | `GET /users/{username}/posts`  | none       | `Page<PostSummary>` |
 *
 * Paths are **namespace-relative**. The version namespace is composed exactly once, by
 * `@/lib/api/client`, from the configured API base URL; a wrapper that spelled the version prefix
 * itself would emit it twice, and that module rejects such a path rather than repairing it. So the
 * three literals above are the whole of this module's contribution to a URL.
 *
 * ## What this module does NOT do
 *
 * - **No transport logic.** No request is issued here, no header is built, no response is
 *   inspected and no status code is branched on. `@/lib/api/client` is the tier's only HTTP
 *   module: it attaches the bearer credential, rotates it once on an unauthorised answer, and
 *   normalises every failure - a rejection from the service, an unreachable service, a cancelled
 *   request - into a single `ApiError` carrying the service's one problem document. A caller
 *   therefore needs exactly one `catch` and never a status-code test, and this file contains
 *   nothing it would have to keep in step with.
 * - **No `'use client'`, and no browser-only global touched anywhere.** Two of these three calls
 *   are made during server rendering, one of them at build time from the sitemap, so a reference
 *   to a browser global would fail there rather than in a component test.
 * - **No provider, hook, component or route import.** The dependency arrow points strictly
 *   outward: this module imports `@/lib/api/client` and `@/lib/types`, and nothing else. Cache
 *   invalidation, form state and navigation belong to the layers above.
 * - **No third-party package.** None is needed, and neither an HTTP library nor a data-fetching
 *   library is declared in `frontend/package.json`.
 * - **No camel-case translation.** `page_size`, `display_name`, `avatar_url` and every other
 *   member below are the service's own wire spellings, exactly as `@/lib/types` mirrors them.
 *   Re-spelling one produces a type that compiles and a value that is `undefined` at run time.
 * - **No response reshaping.** `getUserPosts` returns the page envelope unmodified, with its five
 *   members intact. That uniformity is why one pagination control drives the home feed, a profile
 *   listing and the administrative tables alike, and unwrapping it here would break that reuse for
 *   this one surface only.
 *
 * ## The two confidentiality boundaries, and why neither is a conditional
 *
 * 1. **The public read answers `UserPublic`, never `UserMe`.** `UserPublic` publishes the
 *    identifier, handle, display name, biography, avatar and creation instant; it withholds the
 *    email address, the role and the active flag. The service enforces that by projection, and
 *    this module mirrors it by *return type*: {@link getProfile} is declared
 *    `Promise<UserPublic>`, so a component that reached for a private member would fail to
 *    compile rather than render one. `UserMe` is answered by exactly one operation here -
 *    {@link updateMe} - where the credential has already proved the record is the caller's own.
 *
 * 2. **The author listing is published-only, and there is no way to widen it.** The service
 *    filters that listing on a module constant holding one lifecycle state and exposes no
 *    parameter, no flag and no principal through which any caller could extend the set: an
 *    administrator and the author themselves see exactly what an anonymous crawler sees.
 *    {@link getUserPosts} accepts `page` and `page_size` and nothing else, and the type it accepts
 *    for its per-call controls has the query surface removed, so a filter cannot be injected
 *    through the back door either. Modelling a lifecycle-state argument here would advertise an
 *    override the service does not implement - which is worse than omitting it, because the caller
 *    would believe it worked. An author reviewing their own drafts asks the feed for them,
 *    authenticated, through `@/lib/api/posts`.
 *
 * ## Path keying: three different keys in one folder
 *
 * Both public reads key on the **handle**, not on an identifier. Elsewhere in this folder a post
 * detail keys on a slug and every mutation keys on a generated identifier, so the habit does not
 * carry across. Two consequences are load-bearing here:
 *
 * - **The literal self path is distinct from the parameterised family.** On the service the
 *   literal is declared above `/{username}` because the first pattern that accepts a URL wins, and
 *   the reverse order would silently swallow the literal segment as a handle. On this side the
 *   equivalent discipline is simply never to route a self-update through the handle path, which is
 *   why {@link updateMe} takes no handle at all: the record it writes is the one the credential
 *   resolves to, so it is incapable of addressing another account.
 * - **The handle is passed through as given.** `users.username` is a case-insensitive unique
 *   column, so `Alice` and `alice` resolve to one account and the index performs the fold. Folding
 *   it here would restate a guarantee the schema already makes, in a second place that could drift
 *   from it. The segment is percent-encoded - a no-op for the letters, digits, underscores and
 *   hyphens a handle may contain, and correct for anything else.
 *
 * ## Governing standards
 *
 * `review_rules` reports that **no user-specified rules were provided** for this project, so
 * nothing here is invented to satisfy one and the bar is not lowered. The binding constraints are
 * the technical plan's own enterprise standards, five of which govern this module:
 *
 * | Standard                         | How this module satisfies it                                                                 |
 * | -------------------------------- | -------------------------------------------------------------------------------------------- |
 * | Layered separation of concerns   | Paths, query shaping and return types only; every request is delegated; no inward import      |
 * | Explicit API contracts           | Every return type is a declared shape from `@/lib/types`; the page envelope is passed through |
 * | API versioning                   | Namespace-relative paths; the version prefix is composed once, by the client module           |
 * | Secure-by-default authentication | The self-update cannot be requested anonymously; neither public read requires a credential    |
 * | Blocking quality gates           | Compiles under `tsc --noEmit`, lints at `--max-warnings=0`, explicit return type on every export |
 *
 * @module
 */

import { apiGet, apiPatch, type RequestOptions } from '@/lib/api/client';
import { encodePathSegment } from '@/lib/paths';

import { pageOf, postSummarySchema, userMeSchema, userPublicSchema } from '@/lib/types';
import type { Page, PostSummary, UserMe, UserPublic, UserUpdate } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Paths
 *
 * Written out as whole literals rather than composed from a shared `/users` root. Two reasons: a
 * grep for the address of any of these three operations finds it here in the form it takes on the
 * wire, and a composed root is one indirection between a reader and the question they are actually
 * asking. The prefix is namespace-relative in every case - see the module header.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The authenticated principal's own record. A literal segment, deliberately not a handle: the row
 * written is the one the presented credential resolves to.
 */
const SELF_PROFILE_PATH = '/users/me';

/** Everything before the handle on both public reads. */
const AUTHOR_PROFILE_PATH_PREFIX = '/users/';

/** Everything after the handle on the author's published listing. */
const AUTHOR_POSTS_PATH_SUFFIX = '/posts';

/**
 * The one segment the public reads must never be handed.
 *
 * A caller reaching for "my own profile" and passing this string would address the self route's
 * spelling through the parameterised family, where it is interpreted as a handle. It cannot ever
 * match a real account - a handle is at least three characters, so this two-character string is
 * unregistrable - which is exactly what makes rejecting it safe: the guard has no false positive
 * available to it, and without the guard the mistake presents as a bare "no such profile".
 *
 * The comparison folds case because the mistake is the same mistake in any case. The value
 * *transmitted* is never folded - see {@link authorSegment}.
 */
const RESERVED_SELF_SEGMENT = 'me';

/* -------------------------------------------------------------------------------------------------
 * Page-window bounds
 *
 * Mirrored from the service's own page-window dependency, which VALIDATES rather than clamps: it
 * answers a request outside these bounds with the uniform problem document naming the offending
 * parameter, and never quietly substitutes a different window. This module rejects the same values
 * for the same reason - clamping here would contradict the service and hand the caller a window it
 * did not ask for - and it does so before a request is issued, so a programming error costs no
 * round trip.
 *
 * Note the asymmetry: `page_size` is capped because an uncapped one is a full-table read, while
 * `page` has no service-side ceiling at all. A page past the last one is NOT an error - it answers
 * with an empty item list beside the real totals, so a caller can tell it has run off the end.
 * ---------------------------------------------------------------------------------------------- */

/** Smallest accepted `page`. The window is 1-based, so page zero is not a synonym for the first. */
const MIN_PAGE = 1;

/** Smallest accepted `page_size`. Zero rows per page has no meaningful page count. */
const MIN_PAGE_SIZE = 1;

/** Largest accepted `page_size`. */
const MAX_PAGE_SIZE = 100;

/**
 * Largest `page` this module will transmit.
 *
 * The service imposes no ceiling, so this bound is not its. It is the point beyond which a page
 * number stops being representable exactly, and past which stringification switches to exponential
 * notation that an integer parser rejects - so a value above it could not be sent faithfully even
 * though it is a finite integer.
 */
const MAX_PAGE = Number.MAX_SAFE_INTEGER;

/* -------------------------------------------------------------------------------------------------
 * Per-call controls
 *
 * Both shapes are DERIVED from the client module's own options type rather than restated, so a
 * control added there becomes available here without an edit, and neither can drift from it. What
 * each derivation removes is the interesting part, and in both cases the removal is a contract
 * expressed in the type system rather than in a comment.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Per-call controls for the two public profile reads.
 *
 * The query surface is removed, and that is the mechanism rather than a nicety: with `query` gone,
 * neither read can be handed an arbitrary parameter, so the published-only guarantee described in
 * the module header cannot be circumvented from the call site. Both operations take their entire
 * input from the path and - for the listing - from {@link AuthorPostsWindow}.
 *
 * What remains is what a caller legitimately needs:
 *
 * - `signal` to cancel a read whose result is no longer wanted.
 * - `cache` and `next` to let a Server Component choose how long a profile stays fresh, which is
 *   how the profile route and the sitemap avoid re-reading an unchanged author on every request.
 * - `anonymous` to *deliberately* withhold a credential that is held. Neither read requires one -
 *   the service resolves no principal on either, and the answer is identical for every caller - so
 *   this is never needed to make a read succeed. It is there for the case where a held credential
 *   should not travel: the sitemap, for instance, describes the public view of the site and has no
 *   business presenting a signed-in reader's token to do it.
 */
export type ProfileReadOptions = Omit<RequestOptions, 'query'>;

/**
 * Per-call controls for the authenticated self-update.
 *
 * Deliberately narrower than {@link ProfileReadOptions}, and each omission is a statement:
 *
 * - No `query`, because the operation takes none.
 * - No `anonymous`, because the route has no anonymous behaviour to fall back on - the record
 *   being edited is identified by the credential itself, so a request without one is refused
 *   rather than answered differently. Removing the flag makes that unaskable instead of merely
 *   inadvisable.
 * - No `cache` and no `next`, because a mutation is not a cacheable read. Revalidating the routes
 *   that display the updated account is the caller's concern and belongs to the layer that knows
 *   which routes those are.
 *
 * `signal` remains, so a form that unmounts mid-flight can abandon its request.
 */
export type SelfUpdateOptions = Pick<RequestOptions, 'signal'>;

/**
 * The page window for {@link getUserPosts}: the complete set of parameters that operation accepts.
 *
 * Member names are the wire spellings, so a caller passes the window straight through with no
 * translation step in between. Both members are optional and an omitted one is simply not sent -
 * the service applies its own default window then, so the common call needs neither.
 *
 * **There is deliberately no third member.** No lifecycle state, no draft flag, no ordering, no
 * search term: the service accepts none of them on this route, by design rather than by omission.
 * See the second confidentiality boundary in the module header.
 */
export interface AuthorPostsWindow {
  /**
   * 1-based page to read. Omit for the first page. Must be a whole number of at least
   * {@link MIN_PAGE}; a page past the last one is legitimate and answers with an empty item list.
   */
  page?: number;

  /**
   * Rows per page, between {@link MIN_PAGE_SIZE} and {@link MAX_PAGE_SIZE}. Omit to accept the
   * service's default window.
   */
  page_size?: number;
}

/* -------------------------------------------------------------------------------------------------
 * Argument checks
 *
 * These validate what a caller passed, before anything is sent. That is not the transport logic
 * this module is forbidden to hold: nothing below inspects a response, branches on a status code or
 * maps a failure. A rejected argument never becomes a request at all, which is precisely why it
 * cannot be reported as one - there is no problem document to carry, because there is no exchange.
 *
 * So the two failure vocabularies stay distinct and stay meaningful. A request that reached the
 * service and was refused arrives as the client module's single error type. A call that was
 * malformed before it left throws a plain `TypeError` or `RangeError` naming the operation, the
 * parameter and the accepted range - a programming error, surfaced at the call site that caused it
 * rather than one network round trip later disguised as a rejection from the service.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Turn a caller's handle into a percent-encoded path segment, refusing the two values that cannot
 * address a profile.
 *
 * The value is encoded **exactly as given**. It is neither trimmed nor case-folded, because the
 * handle column is case-insensitively unique and the index is what resolves `Alice` and `alice` to
 * one account; a fold here would duplicate that guarantee somewhere it could drift from it, and a
 * trim would silently repair a caller's malformed value instead of letting the service answer for
 * it. Encoding is a no-op for every character a handle may legally contain.
 *
 * @param username - The handle as the caller supplied it.
 * @param operation - Name of the calling export, so the thrown message names it too. A message that
 * says which call was wrong is the difference between a one-line fix and a search.
 * @returns The percent-encoded path segment.
 * @throws {TypeError} When the handle is absent, blank, or the reserved self segment. The first two
 * are checked at run time and not merely typed, because a handle reaches this boundary from a URL:
 * a route parameter read under a renamed segment, or a search parameter asserted non-null, are both
 * typed `string` and both `undefined` in fact - and either would otherwise be transmitted as the
 * literal text of its own absence and answered "no such profile".
 */
function authorSegment(username: string, operation: string): string {
  if (typeof username !== 'string' || username.trim() === '') {
    throw new TypeError(
      `${operation}: a username is required to address a profile, received ` +
        `${JSON.stringify(username)}. The handle comes from the profile route's own path segment; ` +
        `check that it was read under the name the segment declares.`,
    );
  }

  if (username.trim().toLowerCase() === RESERVED_SELF_SEGMENT) {
    throw new TypeError(
      `${operation}: "${username}" is the self route's segment, not a public handle, and no ` +
        `account can hold it. Read the authenticated principal's own record through ` +
        `@/lib/api/auth and update it with updateMe from this module.`,
    );
  }

  // The reserved-segment and absence checks above answer with information the shared encoder
  // cannot, so they stay. The URL rules are the encoder's: notably a DOT SEGMENT, which is
  // unreserved and therefore survives percent-encoding, so `/users/../auth/me` would be composed,
  // resolved by the URL grammar and answered by a route this wrapper never named.
  return encodePathSegment(username, {
    operation,
    parameterName: 'username',
    hint:
      "The handle comes from the profile route's own path segment; check that it was read " +
      'under the name the segment declares.',
  });
}

/**
 * Validate a requested page number, or pass through its absence.
 *
 * @param page - The caller's `page`, or `undefined` to let the service apply the first page.
 * @returns The value unchanged, or `undefined`.
 * @throws {RangeError} When the value is not a whole number, is below {@link MIN_PAGE}, or exceeds
 * {@link MAX_PAGE}. Rejected rather than clamped, because the service rejects too and a client that
 * quietly substituted a different page would render a window nobody asked for.
 */
function validatePage(page: number | undefined): number | undefined {
  if (page === undefined) {
    return undefined;
  }

  // Number.isInteger is the finite-and-whole test in one call: false for a fraction, and equally
  // false for NaN and for either infinity, each of which a parsed URL segment can produce.
  if (!Number.isInteger(page) || page < MIN_PAGE || page > MAX_PAGE) {
    throw new RangeError(
      `getUserPosts: page must be a whole number from ${MIN_PAGE} to ${MAX_PAGE}, received ` +
        `${String(page)}. Requesting a page past the last one is legitimate and answers with an ` +
        `empty item list, but a page below the first has no window to describe.`,
    );
  }

  return page;
}

/**
 * Validate a requested window size, or pass through its absence.
 *
 * @param pageSize - The caller's `page_size`, or `undefined` to accept the service's default.
 * @returns The value unchanged, or `undefined`.
 * @throws {RangeError} When the value is not a whole number or falls outside
 * {@link MIN_PAGE_SIZE}..{@link MAX_PAGE_SIZE}. A control offering a choice of window size must
 * keep its options inside that range: the upper bound is what stops one request from reading an
 * unbounded number of rows, so the service enforces it rather than trimming to it.
 */
function validatePageSize(pageSize: number | undefined): number | undefined {
  if (pageSize === undefined) {
    return undefined;
  }

  if (!Number.isInteger(pageSize) || pageSize < MIN_PAGE_SIZE || pageSize > MAX_PAGE_SIZE) {
    throw new RangeError(
      `getUserPosts: page_size must be a whole number from ${MIN_PAGE_SIZE} to ${MAX_PAGE_SIZE}, ` +
        `received ${String(pageSize)}.`,
    );
  }

  return pageSize;
}

/**
 * Build the self-update body from the three members the service accepts, and only those.
 *
 * Two properties matter, and they pull in opposite directions:
 *
 * 1. **Genuine partiality.** A member the caller did not supply is left out of the body entirely,
 *    so the service leaves the stored value alone. Filling an absent member with an empty string
 *    would erase a biography the reader never touched - which is the defect this function exists to
 *    make impossible rather than merely discouraged.
 * 2. **An explicit `null` survives.** For the biography and the avatar, `null` is not absence: it
 *    is the instruction to clear a value that was set. So the test is against `undefined`
 *    specifically, never against nullishness, and the two members that accept it carry it through
 *    untouched. The display name has no such state - its column is not nullable and the service
 *    refuses `null` for it - which is why it is typed to exclude it.
 *
 * The body is also **rebuilt member by member rather than forwarded**, and that is deliberate. The
 * request schema forbids members it does not declare, so an unexpected one is a rejection rather
 * than something quietly dropped - and the compiler only checks for excess members on an object
 * written out at the call site. A wider object arriving from anywhere else would type-check and
 * then be refused by the service. Copying three names by hand cannot carry a fourth.
 *
 * @param changes - The caller's requested changes. An empty object is legitimate: the service
 * treats an empty body as a valid no-op that answers with the record unchanged.
 * @returns A body containing exactly the supplied members, with no member left holding `undefined`.
 */
function toSelfUpdateBody(changes: UserUpdate): UserUpdate {
  const body: UserUpdate = {};

  if (changes.display_name !== undefined) {
    body.display_name = changes.display_name;
  }

  if (changes.bio !== undefined) {
    body.bio = changes.bio;
  }

  if (changes.avatar_url !== undefined) {
    body.avatar_url = changes.avatar_url;
  }

  return body;
}

/* -------------------------------------------------------------------------------------------------
 * The three operations
 * ---------------------------------------------------------------------------------------------- */

/**
 * Update the authenticated account's own display name, biography and avatar.
 *
 * `PATCH /users/me`, **bearer-authenticated**, answering the caller's own record. This is the one
 * operation in this module that answers `UserMe`, and it is entitled to: the record returned is the
 * record the presented credential resolves to, so the private members it carries - the email
 * address, the role, the active flag and the modification instant - are being shown to their own
 * subject. Render one of these where a public author reference belongs and those members travel
 * into a surface anyone can read; `UserPublic` is the shape for that, and {@link getProfile}
 * returns it.
 *
 * **A genuine partial update.** A member omitted from `changes` is left exactly as it was, so a
 * form that submits one field cannot revert the other two. Send `null` for `bio` or `avatar_url` to
 * clear a value that was set; `display_name` does not accept `null`, having no cleared state to
 * hold.
 *
 * **The editable surface is these three members and no others.** The email address, the handle, the
 * role, the active flag and the identifier are not merely undocumented here - the request schema
 * forbids members it does not declare, so proposing one is refused rather than ignored. Identity
 * and authority are not self-mutable: a role or an activation state is changed by an administrator,
 * through `@/lib/api/admin`.
 *
 * There is no handle parameter and no identifier in the body, which is what makes this operation
 * incapable of editing another account rather than merely disinclined to.
 *
 * @param changes - The members to change. An empty object is a valid no-op and answers with the
 * record unchanged.
 * @param options - Optional cancellation. See {@link SelfUpdateOptions} for why this operation
 * accepts nothing else.
 * @returns The updated account as its own private view, including the instant the service stamped.
 * @throws {ApiError} From `@/lib/api/client`, as every failure does: no usable credential; a
 * deactivated account; a value the schema rejects, such as a blank display name, an avatar URL
 * whose scheme is not permitted, or a member the schema does not declare.
 *
 * @example
 * ```ts
 * // Clear the biography, leave the display name and avatar exactly as they were.
 * const me = await updateMe({ bio: null });
 * ```
 */
export function updateMe(changes: UserUpdate, options?: SelfUpdateOptions): Promise<UserMe> {
  return apiPatch(SELF_PROFILE_PATH, userMeSchema, toSelfUpdateBody(changes), options);
}

/**
 * Read one author's public profile by handle.
 *
 * `GET /users/{username}`, **public**. Backs the `/u/[username]` route, which is server-rendered,
 * linkable and crawled, and the sitemap that enumerates it.
 *
 * The answer is `UserPublic`: identifier, handle, display name, biography, avatar and creation
 * instant. It withholds the email address, the role and the active flag, and the return type is
 * where that boundary is enforced on this side - there is no widening argument, and no variant of
 * this call answers the private view.
 *
 * A credential changes nothing about the response, because the service resolves no principal on
 * this route. One is sent anyway when one is held, which is harmless; pass `anonymous` to withhold
 * it deliberately, as the sitemap does.
 *
 * The handle matches case-insensitively, so `Alice` and `alice` address one account. An unclaimed
 * handle and a deactivated account are reported identically and cannot be told apart - whether a
 * deactivated account exists is not something an anonymous caller is entitled to learn.
 *
 * @param username - The author's handle, exactly as the profile URL carries it. Not the reserved
 * self segment: this route addresses other people's profiles, never the caller's own.
 * @param options - Optional cancellation, caching and revalidation controls.
 * @returns The author's public identity.
 * @throws {TypeError} When the handle is absent, blank or the reserved self segment - a programming
 * error, thrown before any request is issued.
 * @throws {ApiError} From `@/lib/api/client`, when no visible account holds the handle or the
 * service cannot be reached.
 *
 * @example
 * ```ts
 * const author = await getProfile(username, { next: { revalidate: 300 } });
 * ```
 */
export function getProfile(username: string, options?: ProfileReadOptions): Promise<UserPublic> {
  const segment = authorSegment(username, 'getProfile');

  return apiGet(`${AUTHOR_PROFILE_PATH_PREFIX}${segment}`, userPublicSchema, {
    ...options,
    anonymousFallback: true,
  });
}

/**
 * Read one page of an author's **published** posts.
 *
 * `GET /users/{username}/posts`, **public**, answering the same five-member page envelope every
 * collection in this API answers - so the profile listing and the home feed are driven by one
 * pagination control, and the envelope is returned here exactly as it arrived.
 *
 * **Drafts and archived posts are never included, for any caller.** The service filters this
 * listing on a single lifecycle state held in a module constant and exposes nothing through which
 * the set could be replaced or extended: an administrator and the author themselves receive
 * precisely what an anonymous crawler receives. That is stricter than the feed, which does widen
 * for a known caller, and the asymmetry is the point - a profile is a public, crawled, shareable
 * surface, and a hard-coded state set cannot leak a draft through a mistake in a visibility test
 * because there is no test to get wrong.
 *
 * This function therefore accepts `page` and `page_size` and nothing else, and its per-call
 * controls have the query surface removed so that nothing can be added from the call site either.
 * An author reviewing their own drafts asks the feed for them, authenticated, through
 * `@/lib/api/posts`.
 *
 * Each row is a `PostSummary`, which deliberately carries **no body content** - a listing may
 * return up to a hundred rows, and including the article text would multiply every profile response
 * by the size of the articles in it. Read `PostDetail` through `@/lib/api/posts` when the body is
 * actually going to be rendered.
 *
 * Two properties of the envelope are contractual and a control that ignores either renders the
 * wrong thing: `total` counts every published post by the author and ignores the window, and a page
 * past the last one is not an error - it answers with an empty item list beside the real totals and
 * echoes the page that was asked for, so a caller can tell it has run off the end.
 *
 * @param username - The author's handle, exactly as the profile URL carries it.
 * @param pageWindow - The window to read. Omit it, or omit either member, to accept the service's
 * default window.
 * @param options - Optional cancellation, caching and revalidation controls.
 * @returns One page of the author's published posts, unmodified.
 * @throws {TypeError} When the handle is absent, blank or the reserved self segment.
 * @throws {RangeError} When `page` or `page_size` falls outside the accepted window - rejected
 * before a request is issued, exactly as the service would reject it.
 * @throws {ApiError} From `@/lib/api/client`, when no visible account holds the handle or the
 * service cannot be reached. Note that an unknown author is reported as a missing profile rather
 * than as an author who has written nothing.
 *
 * @example
 * ```ts
 * const { items, total, pages } = await getUserPosts(username, { page, page_size: 12 });
 * ```
 */
export function getUserPosts(
  username: string,
  pageWindow: AuthorPostsWindow = {},
  options?: ProfileReadOptions,
): Promise<Page<PostSummary>> {
  const segment = authorSegment(username, 'getUserPosts');
  const path = `${AUTHOR_PROFILE_PATH_PREFIX}${segment}${AUTHOR_POSTS_PATH_SUFFIX}`;

  return apiGet(path, pageOf(postSummarySchema), {
    ...options,
    anonymousFallback: true,
    // Both members are omitted from the URL when absent - the client module drops an undefined
    // query value - so the default call produces a bare path rather than one carrying blanks.
    query: {
      page: validatePage(pageWindow.page),
      page_size: validatePageSize(pageWindow.page_size),
    },
  });
}
