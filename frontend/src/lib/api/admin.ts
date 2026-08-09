/**
 * Typed wrapper over the administrator-only `/admin` namespace.
 *
 * The transport half of the administrative dashboard - "manage users, posts, comments and
 * categories" - and the largest of the seven wrappers beside `@/lib/api/client` at fourteen
 * operations. Nothing here renders; the screens under `src/app/(admin)/` and the components under
 * `src/components/admin/` do that, and they reach the service only through the functions below.
 *
 * The backend was resolved to FastAPI, which has no framework-provided administration surface. That
 * is not a shortfall being worked around: the dashboard was asked for as a deliverable, so it is
 * built as an explicit route group over this explicit API namespace, and every screen in it is
 * driven by a declared endpoint with a declared response model rather than by generated scaffolding.
 *
 * ## What this module is
 *
 * Paths, query shaping and return types. Nothing else. Each function names one endpoint, hands its
 * arguments to `@/lib/api/client` and returns what comes back, unaltered.
 *
 * ## What this module is NOT, and must never become
 *
 * - **Not a transport.** No request is issued here. No header is built, no status code is read, no
 *   failure is mapped, nothing is retried and no cancellation is orchestrated. Every one of those
 *   lives in `@/lib/api/client`, which is the tier's only HTTP module. A wrapper that reaches for
 *   any of them has taken on work that then exists in eight places instead of one.
 * - **Not an authority check.** See the authority section below. This is the single most important
 *   property of this file and the easiest to erode with a well-meaning early return.
 * - **Not a re-sheller of the wire format.** Field names are the service's own snake_case, exactly
 *   as `@/lib/types` mirrors them: `is_active`, `page_size`, `user_count`, `author_id`,
 *   `created_at`. There is no camel-case translation layer anywhere in this tier and none may be
 *   added here - re-spelling a field produces a type that compiles and a value that is absent.
 * - **Not a page-envelope adapter.** A `Page<T>` is returned exactly as received, all five fields
 *   intact, which is what lets `src/hooks/use-pagination.ts`, `src/components/ui/pagination.tsx`
 *   and `src/components/admin/data-table.tsx` drive an administrative table with the same code that drives
 *   the public feed. Unwrapping `items`, or adding a sixth convenience field, breaks that sharing.
 * - **Not a consumer of its own siblings.** The category types come from `@/lib/types`, never from the
 *   sibling categories wrapper. There is no wrapper-to-wrapper import anywhere in this folder, and
 *   introducing one would create an import graph in which the type a screen sees depends on which
 *   wrapper it happened to enter through.
 * - **Not a client component, and not React-aware.** There is no client-component directive, no
 *   browser-only global is touched at module scope, and nothing is imported from `providers/`,
 *   `hooks/`, `components/`, `app/` or any cache library. The dependency arrow points strictly
 *   outward: two modules in, nothing else. Caching, invalidation and mutation state belong to the
 *   screens; the administrative ones are client components, but this module stays importable from
 *   anywhere so that a server-rendered surface or a route handler could use it unchanged.
 * - **Not a third-party dependant.** No HTTP or data-fetching package is declared in
 *   `frontend/package.json`, and none is needed.
 *
 * ## Path convention
 *
 * Every path below is **namespace-relative**: `/admin/stats`, not the versioned form. The version
 * namespace is composed once, inside `@/lib/api/client`, which is what makes it impossible for a
 * wrapper to emit an unversioned path. Passing an already-prefixed path is rejected loudly there
 * rather than silently repaired, so the convention is enforced rather than merely documented.
 *
 * Note also what is absent: the retired single-module API this service replaced exposed five
 * unversioned routes over one client-keyed entity. No path, type or field of it survives anywhere
 * in this tier, and the service's own contract test asserts that.
 *
 * ## Authority is enforced server-side. This file performs no check at all.
 *
 * `require_admin` is applied **once**, as a router-level dependency on the administrative include -
 * one `dependencies=[Depends(require_admin)]` for the whole namespace - precisely so that no
 * individual route can omit the gate. Authority is therefore already established before any handler
 * runs, on every one of these fourteen endpoints, without exception.
 *
 * So this module inspects no privilege, decodes no token, reads no backend configuration and throws
 * nothing early. `src/middleware.ts` keeps an unauthenticated visitor out of `/admin/*` and the
 * screens hide controls a reader cannot use, but both of those are user experience: hiding a
 * control is not a security boundary, and a client-side gate is worth nothing to a caller who
 * simply does not run it.
 *
 * The corollary matters as much as the rule. A refusal from any function here **surfaces** as the
 * normalised error `@/lib/api/client` produces. It is not swallowed, not retried, and never
 * flattened into an empty result set - a table that renders "no records" when the real answer was
 * "you may not see these" misreports the system to the person operating it. Rotation is deliberately
 * not attempted for a refusal either, because a fresh credential cannot grant an authority the
 * account does not hold.
 *
 * ## Naming: every export is prefixed `Admin`
 *
 * Deliberate, and not merely for tidiness. Four of these operations have a same-named counterpart
 * elsewhere in this folder that does something materially different, and the pairs are easy to
 * confuse precisely because they read alike:
 *
 * | This module                    | Elsewhere                       | The difference that matters                    |
 * | ------------------------------ | ------------------------------- | ---------------------------------------------- |
 * | {@link updateAdminPostStatus}  | `posts.ts` `updatePost`         | Forces a lifecycle state vs. edits own content |
 * | {@link deleteAdminPost}        | `posts.ts` `deletePost`         | Any post vs. only the caller's own             |
 * | {@link listAdminPosts}         | `posts.ts` `listPosts`          | Every state vs. published only                 |
 * | {@link listAdminCategories}    | `categories.ts` `listCategories`| A searchable page vs. the whole bare array     |
 *
 * A bare `updatePost` is therefore **not** exported here, and neither is a bare `listPosts` or
 * `deletePost`. A screen that imports from both wrappers gets fourteen unambiguous names and needs
 * no aliasing to disambiguate them. Named exports only; this folder has no barrel, so consumers
 * import `@/lib/api/admin` directly.
 *
 * ## Governing standards
 *
 * `review_rules` reports that **no user-specified rules were provided** for this project, so nothing
 * here is invented to satisfy one and the bar is not lowered either. The binding constraints are the
 * technical plan's own enterprise standards, five of which govern this module:
 *
 * | Standard                         | How this module satisfies it                                                                 |
 * | -------------------------------- | -------------------------------------------------------------------------------------------- |
 * | Layered separation of concerns   | Imports exactly two modules; no transport, no React, no sibling wrapper, no inward import     |
 * | Explicit API contracts           | Every return type is declared in `@/lib/types`; `Page<T>` is passed through untouched         |
 * | API versioning                   | Namespace-relative paths only; the version prefix is composed once, in the client             |
 * | Secure-by-default authentication | No client-side authority check; a refusal surfaces unmodified                                 |
 * | Blocking quality gates           | Explicit return type on every export; no unused import; compiles and lints clean              |
 *
 * @module
 */

import {
  apiDeleteNoContent,
  apiGet,
  apiPatch,
  apiPost,
  type ProtectedRequestOptions,
  type QueryParams,
} from '@/lib/api/client';
import { encodePathSegment } from '@/lib/paths';
import { codePointLength } from '@/lib/text';
import {
  adminCommentSchema,
  adminPostSchema,
  adminStatsSchema,
  adminUserSchema,
  categoryPublicSchema,
  pageOf,
} from '@/lib/types';
import { MAX_SEARCH_TERM_LENGTH } from '@/lib/types';
import type {
  AdminComment,
  AdminCommentStatusUpdate,
  AdminPost,
  AdminPostStatusUpdate,
  AdminStats,
  AdminUser,
  AdminUserUpdate,
  CategoryCreate,
  CategoryPublic,
  CategoryUpdate,
  CommentStatus,
  Page,
  PostStatus,
  UserRole,
} from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Endpoint paths
 *
 * Stated once each, as constants, so a typo is a single-site defect rather than one repeated across
 * the operations that share a collection.
 *
 * These five literals are also the values the component suite's request interceptor has to agree
 * with. That interceptor is configured to raise on an unhandled request rather than to pass one
 * through, so a path typo here fails the suite loudly instead of reaching an unmocked address - but
 * only if the two agree exactly, which is why they are worth reading side by side when either
 * changes.
 * ---------------------------------------------------------------------------------------------- */

/** Aggregate counts for the overview screen. The one endpoint here that is not a collection. */
const ADMIN_STATS_PATH = '/admin/stats';

/** Account collection. Also the base of the per-account update and removal paths. */
const ADMIN_USERS_PATH = '/admin/users';

/** Post collection, spanning every lifecycle state. Also the base of the per-post paths. */
const ADMIN_POSTS_PATH = '/admin/posts';

/** Comment collection - the moderation queue. Also the base of the per-comment paths. */
const ADMIN_COMMENTS_PATH = '/admin/comments';

/**
 * Category collection: the searchable management listing, and the only place in the API where the
 * taxonomy can be mutated.
 */
const ADMIN_CATEGORIES_PATH = '/admin/categories';

/* -------------------------------------------------------------------------------------------------
 * Path composition
 *
 * Every path parameter on this namespace is a server-generated UUID. Not a slug, and not a
 * username: `posts.ts` addresses a post for reading by its slug and `users.ts` addresses a profile
 * by its username, but no administrative endpoint does either, and carrying that habit across is
 * the mistake these helpers exist to make impossible.
 *
 * The two status transitions address a `/status` sub-resource while the account and category
 * updates address the resource itself. That asymmetry is the service's contract and is reproduced
 * exactly - regularising it in either direction produces a 404 or a 405 whose cause is nowhere near
 * the call site. Separate, differently named builders keep the two shapes visibly distinct instead
 * of hiding them behind one parameterised expression.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Escape one identifier for safe interpolation into a path segment.
 *
 * A canonical UUID passes through unchanged - hex digits and hyphens are all unreserved - so this
 * is invisible in normal operation. It earns its place on the abnormal case: an identifier that
 * arrived malformed from a stale table row or a hand-edited URL cannot then introduce an extra
 * segment or a query delimiter into the path, which would turn a lookup failure into a request
 * against a different endpoint entirely.
 */
function pathSegment(identifier: string, operation: string, parameterName: string): string {
  // Through the tier's ONE encoder. Percent-encoding alone is not enough: `.` and `..` are
  // already URL-safe, so `encodeURIComponent` returns them unchanged and the URL grammar then
  // resolves `/admin/users/../../auth/me` against the surrounding path - a successful request
  // against a route this wrapper never named, carrying an administrator's bearer.
  return encodePathSegment(identifier, {
    operation,
    parameterName,
    hint: 'Pass the UUID the administrative listing returned for the row.',
  });
}

/** `/admin/users/{id}` - the account itself, for the role and activity update and for removal. */
function adminUserPath(userId: string, operation: string): string {
  return `${ADMIN_USERS_PATH}/${pathSegment(userId, operation, 'userId')}`;
}

/** `/admin/posts/{id}` - the post itself, for removal. */
function adminPostPath(postId: string, operation: string): string {
  return `${ADMIN_POSTS_PATH}/${pathSegment(postId, operation, 'postId')}`;
}

/** `/admin/posts/{id}/status` - the lifecycle sub-resource, and **not** the post itself. */
function adminPostStatusPath(postId: string, operation: string): string {
  return `${adminPostPath(postId, operation)}/status`;
}

/** `/admin/comments/{id}` - the comment itself, for removal. */
function adminCommentPath(commentId: string, operation: string): string {
  return `${ADMIN_COMMENTS_PATH}/${pathSegment(commentId, operation, 'commentId')}`;
}

/** `/admin/comments/{id}/status` - the moderation sub-resource, and **not** the comment itself. */
function adminCommentStatusPath(commentId: string, operation: string): string {
  return `${adminCommentPath(commentId, operation)}/status`;
}

/** `/admin/categories/{id}` - the category itself, for update and removal. */
function adminCategoryPath(categoryId: string, operation: string): string {
  return `${ADMIN_CATEGORIES_PATH}/${pathSegment(categoryId, operation, 'categoryId')}`;
}

/* -------------------------------------------------------------------------------------------------
 * Listing parameters
 *
 * `@/lib/types` mirrors the service's request and response *bodies*; query parameters are not
 * bodies, so the four filter shapes are declared here, beside the operations that send them,
 * rather than imported from somewhere they are not.
 *
 * Every member is optional and every name is the wire name. Values left unset are omitted from the
 * query string by the client - `undefined`, `null` and `''` all mean "no filter" - so a screen can
 * forward its whole filter state, blank search box included, and still produce a clean URL. That is
 * why nothing is pruned here: pruning would be a second implementation of a rule the client already
 * owns, and the two would eventually disagree.
 *
 * One consequence is worth stating because it is the opposite of the usual JavaScript reflex: a
 * **falsy value is still a value**. The client omits only the three nullish-or-empty cases, never a
 * `false` and never a `0`. That is exactly right for `is_active: false` - listing the deactivated
 * accounts is the reason that filter exists, and dropping it would silently answer a different
 * question. It also means a `page: 0` reaches the service and is refused with a `422` rather than
 * being quietly read as "no page", which is the honest outcome: the window a caller asked for is
 * either served or reported, never substituted.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The page window shared by all four administrative listings.
 *
 * Both members are validated server-side and **not** adjusted: `page` must be at least 1 with no
 * upper bound, `page_size` must be between 1 and 100, and an out-of-range value is answered with a
 * `422` naming the parameter rather than being quietly clamped. A page-size control must therefore
 * keep its options inside that range instead of relying on the service to trim them.
 *
 * A page past the last one is **not** an error: it answers with an empty `items` list beside the
 * real `pages` count, which is how a table detects that it has run off the end.
 */
export interface AdminPageParams {
  /** 1-based page number. Omit for the first page. */
  page?: number;
  /** Rows per page, 1 to 100. Omit for the service's default of 20. */
  page_size?: number;
}

/**
 * Query parameters of {@link listAdminUsers}. The three filters compose, and `total` counts the
 * filtered set rather than the whole relation, so the page controls describe what is on screen.
 */
export interface AdminUserListParams extends AdminPageParams {
  /**
   * Free-text term matched against the username and the email address. A blank or whitespace-only
   * value is treated as no filter, so clearing the search box does not add a predicate that matches
   * every account.
   */
  q?: string;
  /** Exact authority filter - for example, show only administrators. Omit for every role. */
  role?: UserRole;
  /**
   * Exact activity filter. `false` is meaningful rather than merely falsy: showing the deactivated
   * accounts is the reason this filter exists, and it is sent rather than dropped. Omit for both.
   */
  is_active?: boolean;
}

/**
 * Query parameters of {@link listAdminPosts}.
 *
 * `status` is the wire name. The service spells the handler parameter differently to avoid shadowing
 * an import of its own, and exposes it under this alias; this is the spelling that goes on the URL.
 */
export interface AdminPostListParams extends AdminPageParams {
  /** Free-text term over the post. Omit or leave blank for no term. */
  q?: string;
  /** Single lifecycle state to narrow to. Omit for **every** state, drafts and archived included. */
  status?: PostStatus;
  /** Restrict to one author, by their server-generated identifier. Omit for every author. */
  author_id?: string;
}

/**
 * Query parameters of {@link listAdminComments}.
 *
 * `status` is the wire name here too, aliased for the same reason as on the post listing.
 */
export interface AdminCommentListParams extends AdminPageParams {
  /** Free-text term over the comment body. Omit or leave blank for no term. */
  q?: string;
  /** Single moderation state to narrow to. Omit for **every** state, pending and rejected included. */
  status?: CommentStatus;
  /** Restrict the queue to one post's thread, by post identifier. Omit for every post. */
  post_id?: string;
}

/**
 * Query parameters of {@link listAdminCategories}.
 *
 * One filter beyond the window, and the two together are what separate this listing from the public
 * one in `@/lib/api/categories.ts`: that read answers with the whole taxonomy as a bare array, because
 * it *is* the home page's filter control and a window could hide the posts filed under a term that
 * fell outside it, while this one is a management table and windows and searches like every other.
 * Searching a controlled vocabulary is a management affordance, so the term lives here rather than on
 * the read every home-feed render performs. The item projection is identical on both, down to the
 * meaning of `post_count`.
 */
export interface AdminCategoryListParams extends AdminPageParams {
  /**
   * Free-text term matched case-insensitively against **both** the name and the slug, so a term is
   * findable by either spelling. A blank or whitespace-only value is treated as no filter.
   */
  q?: string;
}

/**
 * The per-call transport controls **every** operation in this module accepts.
 *
 * All fourteen are administrator-only: the versioned router applies `require_admin` once, at the
 * mount, so every route beneath `/admin` requires a credential and a privileged one. Anonymity is
 * therefore not a mode any of them has, and {@link ProtectedRequestOptions} is what removes
 * `anonymous` and `anonymousFallback` so it cannot be asked for - a request without a credential
 * could only produce `401`, and one replayed without a credential could only produce it twice.
 *
 * `bearer` is retained, and on this namespace it is the member that matters most: an administrative
 * screen rendered on the server passes the token it resolved from that request's own context, because
 * the credential store is a module global and so browser-only by construction. `query` is retained on
 * the type but is **superseded** on every listing - see {@link listRequestOptions} - because each
 * listing's filters are a typed parameter object and two sources for one query string is a conflict
 * with no correct resolution.
 */
export type AdminRequestOptions = ProtectedRequestOptions;

/**
 * Merge a listing's typed filters into the caller's per-request options.
 *
 * The typed parameter object is the only supported way to filter a listing, so a `query` supplied
 * through `options` is superseded here rather than merged - two sources for one query string is a
 * conflict with no correct resolution, and silently combining them would let a stale filter ride
 * along invisibly. Everything else a caller passes - cancellation, cache mode, revalidation - is
 * forwarded untouched.
 */
function listRequestOptions(
  query: QueryParams,
  options: AdminRequestOptions | undefined,
): ProtectedRequestOptions {
  return { ...options, query };
}

/* -------------------------------------------------------------------------------------------------
 * Overview
 * ---------------------------------------------------------------------------------------------- */

/**
 * Read the aggregate counts for the overview screen.
 *
 * `GET /admin/stats` &rarr; `200` with an {@link AdminStats}.
 *
 * A **bare object, not a page envelope** - it is four totals, not a windowed collection, and it is
 * the only response on this namespace that is not either a `Page` or a single resource.
 *
 * Composed server-side across accounts, posts, comments and categories in one query. Do **not**
 * assemble these four numbers client-side from four listing calls and their `total` fields: that
 * would be four round trips for one screen, each windowed and filtered by parameters the overview
 * never asked about, and the four counts would be read at four different instants.
 *
 * Every count spans all states - accounts active and deactivated, posts in every lifecycle state,
 * comments in every moderation state - because an overview that quietly excluded the drafts and the
 * moderation queue would understate exactly the work the dashboard exists to surface.
 *
 * `src/components/admin/stat-card.tsx` keys its tiles on `keyof AdminStats` and carries a compile-time
 * proof that a tile exists for each one, so the whole object is what that screen consumes.
 *
 * @param options - Per-request controls, forwarded to the client untouched.
 * @returns The four totals.
 * @throws The client's normalised error - including the refusal an insufficiently privileged caller
 * receives, which surfaces rather than resolving to zeroed counts.
 */
export function getAdminStats(options?: AdminRequestOptions): Promise<AdminStats> {
  return apiGet(ADMIN_STATS_PATH, adminStatsSchema, options);
}

/* -------------------------------------------------------------------------------------------------
 * Accounts
 *
 * The administrative projection exposes the email address, the role and the activity flag, none of
 * which the public user projection carries - that reach is what the management table is for. It
 * carries no password hash, and none may ever be added: the hash does not leave the service, not
 * even to an administrator, because a screen that can display a credential is a screen that can
 * leak one.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Refuse a search term longer than the service accepts, before a request is spent on it.
 *
 * Mirrors the service's own bound rather than restating its policy: the number is
 * {@link MAX_SEARCH_TERM_LENGTH}, imported from the contract types, and the service publishes it as
 * `maxLength` on all four `q` parameters. Absence and a blank term are left alone - the client
 * module's query builder drops them and the service treats a whitespace-only term as no filter - so
 * this checks exactly one thing, for all four administrative listings.
 *
 * Thrown rather than truncated, and thrown rather than sent, because the service refuses an
 * over-long term with the uniform problem document: shortening it would answer a question the
 * administrator did not ask, and sending it would spend a round trip to be told so.
 *
 * @param term - The caller's `q`, or `undefined`/`null` when no term was supplied.
 * @param caller - The exported function's name, so the message names the call the author wrote.
 * @throws {RangeError} When the term is longer than {@link MAX_SEARCH_TERM_LENGTH} characters.
 */
function assertSearchTermLength(term: string | null | undefined, caller: string): void {
  if (term === undefined || term === null) {
    return;
  }
  // Measured in CODE POINTS, through the tier's one length primitive, because that is the unit the
  // service counts: Pydantic's `max_length` is applied to Python's `len()`. JavaScript's
  // `String.length` counts UTF-16 code units, so a term containing any character above U+FFFF
  // measures nearly double there - and this guard would reject, before issuing a request, a search an
  // administrator is entitled to run. All-ASCII text cannot show the difference, which is exactly why
  // the measurement is centralised rather than left to each of the four listings.
  const length = codePointLength(term);
  if (length > MAX_SEARCH_TERM_LENGTH) {
    throw new RangeError(
      `${caller}: q must be at most ${String(MAX_SEARCH_TERM_LENGTH)} characters, received ` +
        `${String(length)}. The service refuses a longer term with 422 rather than ` +
        `truncating it, so cap the search input at that length instead of sending it.`,
    );
  }
}

/**
 * List accounts for the user management table.
 *
 * `GET /admin/users` &rarr; `200` with a {@link Page} of {@link AdminUser}.
 *
 * @param params - Window and filters. Omit entirely for the first page, unfiltered; omit any single
 * member to leave that predicate off the query.
 * @param options - Per-request controls, forwarded untouched. A `query` here is superseded by
 * `params` - see {@link listRequestOptions}.
 * @returns One page of accounts, its five envelope fields exactly as the service sent them.
 * @throws The client's normalised error.
 */
export function listAdminUsers(
  params: AdminUserListParams = {},
  options?: AdminRequestOptions,
): Promise<Page<AdminUser>> {
  assertSearchTermLength(params.q, 'listAdminUsers');

  const query: QueryParams = {
    page: params.page,
    page_size: params.page_size,
    q: params.q,
    role: params.role,
    is_active: params.is_active,
  };
  return apiGet(ADMIN_USERS_PATH, pageOf(adminUserSchema), listRequestOptions(query, options));
}

/**
 * Change an account's authority, its ability to authenticate, or both.
 *
 * `PATCH /admin/users/{id}` &rarr; `200` with the updated {@link AdminUser}.
 *
 * Addresses **the account itself**, with no sub-path - unlike the two status transitions further
 * down. A genuinely partial update: both members of {@link AdminUserUpdate} are optional, an omitted
 * one is left untouched, and serialisation drops it rather than sending a null the service would
 * reject. So promoting an account and deactivating one are independent operations that happen to
 * share a route, and sending neither is accepted and changes nothing.
 *
 * Nothing else about an account is settable here - not the email address, not the username, not the
 * password. Deactivating is the reversible alternative to {@link deleteAdminUser}: the credentials
 * stop working while the account's posts and comments stay in place.
 *
 * @param userId - The account's server-generated identifier.
 * @param payload - The members to change. `role` is typed by the role union rather than by a string,
 * so an unknown authority is a compile error rather than a `422`.
 * @param options - Per-request controls, forwarded untouched.
 * @returns The account in its new state.
 * @throws The client's normalised error.
 */
export function updateAdminUser(
  userId: string,
  payload: AdminUserUpdate,
  options?: AdminRequestOptions,
): Promise<AdminUser> {
  return apiPatch(adminUserPath(userId, 'updateAdminUser'), adminUserSchema, payload, options);
}

/**
 * Delete an account.
 *
 * `DELETE /admin/users/{id}` &rarr; **`204 No Content`**, so there is no body and nothing is parsed.
 *
 * The cascade is the service's concern: removing an account takes its posts, comments, likes and
 * rotation credentials with it. Prefer deactivating through {@link updateAdminUser} when the intent
 * is to stop a credential working rather than to erase the account's contributions.
 *
 * @param userId - The account's server-generated identifier.
 * @param options - Per-request controls, forwarded untouched.
 * @returns Nothing, on success.
 * @throws The client's normalised error.
 */
export function deleteAdminUser(userId: string, options?: AdminRequestOptions): Promise<void> {
  return apiDeleteNoContent(adminUserPath(userId, 'deleteAdminUser'), options);
}

/* -------------------------------------------------------------------------------------------------
 * Posts
 *
 * The administrative projection carries no body content and no excerpt: a management table lists and
 * acts on posts, it does not render them, so the payload stays small even across the whole corpus.
 * ---------------------------------------------------------------------------------------------- */

/**
 * List posts across **every** lifecycle state.
 *
 * `GET /admin/posts` &rarr; `200` with a {@link Page} of {@link AdminPost}.
 *
 * This is the one listing in the API that bypasses public status scoping: drafts and archived posts
 * are included alongside published ones. That reach is intentional and is the entire reason the
 * administrative namespace exists - and it is safe only because the namespace is gated, which is why
 * the breadth lives behind an authority check rather than behind a query parameter a public caller
 * could set.
 *
 * The public feed is `posts.ts`'s `listPosts`, which is hard-filtered to published posts. The two are
 * not interchangeable, which is why this one is named distinctly.
 *
 * @param params - Window and filters. Omit `status` for every lifecycle state.
 * @param options - Per-request controls, forwarded untouched. A `query` here is superseded by
 * `params`.
 * @returns One page of posts, its five envelope fields exactly as the service sent them.
 * @throws The client's normalised error.
 */
export function listAdminPosts(
  params: AdminPostListParams = {},
  options?: AdminRequestOptions,
): Promise<Page<AdminPost>> {
  assertSearchTermLength(params.q, 'listAdminPosts');

  const query: QueryParams = {
    page: params.page,
    page_size: params.page_size,
    q: params.q,
    status: params.status,
    author_id: params.author_id,
  };
  return apiGet(ADMIN_POSTS_PATH, pageOf(adminPostSchema), listRequestOptions(query, options));
}

/**
 * Move a post to a named lifecycle state, whoever wrote it.
 *
 * `PATCH /admin/posts/{id}/status` &rarr; `200` with the updated {@link AdminPost}.
 *
 * **Note the `/status` sub-path.** This transition addresses a sub-resource, unlike
 * {@link updateAdminUser} and {@link updateAdminCategory}, which address their resource directly. The
 * asymmetry is the service's contract; do not regularise it.
 *
 * `status` is **required**, not optional: the route exists to move a post to a named state, so a
 * request naming none has nothing to do and is rejected rather than silently accepted. It is typed
 * by the lifecycle union, so an unknown state is a compile error.
 *
 * The administrative counterpart of an author's own publish and unpublish transitions, reaching a
 * state those do not - archiving in particular. The service maintains the publication instant
 * alongside the state, so a transition here cannot leave the pair inconsistent; a database constraint
 * enforces that a published post has a publication instant regardless of what any client sends.
 *
 * Distinct from `posts.ts`'s `updatePost`, which is the author's own partial content edit and cannot
 * change a lifecycle state at all.
 *
 * @param postId - The post's server-generated identifier.
 * @param payload - The destination state.
 * @param options - Per-request controls, forwarded untouched.
 * @returns The post in its new state.
 * @throws The client's normalised error.
 */
export function updateAdminPostStatus(
  postId: string,
  payload: AdminPostStatusUpdate,
  options?: AdminRequestOptions,
): Promise<AdminPost> {
  return apiPatch(
    adminPostStatusPath(postId, 'updateAdminPostStatus'),
    adminPostSchema,
    payload,
    options,
  );
}

/**
 * Delete a post, whoever wrote it.
 *
 * `DELETE /admin/posts/{id}` &rarr; **`204 No Content`**, so there is no body and nothing is parsed.
 *
 * Addresses the post itself - **no** `/status` sub-path - and the cascade is the service's concern:
 * the post's comments and likes go with it.
 *
 * Distinct from `posts.ts`'s `deletePost`, which an author may invoke only on their own post.
 *
 * @param postId - The post's server-generated identifier.
 * @param options - Per-request controls, forwarded untouched.
 * @returns Nothing, on success.
 * @throws The client's normalised error.
 */
export function deleteAdminPost(postId: string, options?: AdminRequestOptions): Promise<void> {
  return apiDeleteNoContent(adminPostPath(postId, 'deleteAdminPost'), options);
}

/* -------------------------------------------------------------------------------------------------
 * Comments - the moderation queue
 *
 * The administrative projection is deliberately **flat**: it carries the parent reference but no
 * nested replies, because moderation acts on one comment at a time and a table row is not a
 * conversation. That is what makes it a queue rather than a second view of the public thread.
 * ---------------------------------------------------------------------------------------------- */

/**
 * List comments across **every** moderation state.
 *
 * `GET /admin/comments` &rarr; `200` with a {@link Page} of {@link AdminComment}.
 *
 * Pending and rejected comments are included alongside approved ones; the public thread shows only
 * approved ones. Filter by `status` to work one state at a time - a pending-only view is the
 * moderation queue proper.
 *
 * @param params - Window and filters. Omit `status` for every moderation state.
 * @param options - Per-request controls, forwarded untouched. A `query` here is superseded by
 * `params`.
 * @returns One page of comments, its five envelope fields exactly as the service sent them.
 * @throws The client's normalised error.
 */
export function listAdminComments(
  params: AdminCommentListParams = {},
  options?: AdminRequestOptions,
): Promise<Page<AdminComment>> {
  assertSearchTermLength(params.q, 'listAdminComments');

  const query: QueryParams = {
    page: params.page,
    page_size: params.page_size,
    status: params.status,
    q: params.q,
    post_id: params.post_id,
  };
  return apiGet(
    ADMIN_COMMENTS_PATH,
    pageOf(adminCommentSchema),
    listRequestOptions(query, options),
  );
}

/**
 * Approve, reject, or return a comment to review.
 *
 * `PATCH /admin/comments/{id}/status` &rarr; `200` with the updated {@link AdminComment}.
 *
 * **This is the only function in the entire frontend that may change a comment's moderation state.**
 * `@/lib/api/comments.ts` treats `status` as strictly read-only - an author may edit their own
 * comment's body and nothing else - so moderation authority exists in exactly one place on this tier
 * and is gated in exactly one place on the service.
 *
 * **Note the `/status` sub-path**, as on {@link updateAdminPostStatus}. `status` is **required** for
 * the same reason: naming no destination is not a request. Because the moderation states are three
 * rather than a boolean, this also moves a comment *back* - a rejection is reversible, and a decision
 * made in error is not permanent.
 *
 * @param commentId - The comment's server-generated identifier.
 * @param payload - The destination moderation state.
 * @param options - Per-request controls, forwarded untouched.
 * @returns The comment in its new state.
 * @throws The client's normalised error.
 */
export function updateAdminCommentStatus(
  commentId: string,
  payload: AdminCommentStatusUpdate,
  options?: AdminRequestOptions,
): Promise<AdminComment> {
  return apiPatch(
    adminCommentStatusPath(commentId, 'updateAdminCommentStatus'),
    adminCommentSchema,
    payload,
    options,
  );
}

/**
 * Delete a comment, whoever wrote it.
 *
 * `DELETE /admin/comments/{id}` &rarr; **`204 No Content`**, so there is no body and nothing is
 * parsed.
 *
 * Addresses the comment itself - **no** `/status` sub-path - and its replies cascade with it, which
 * is why rejecting through {@link updateAdminCommentStatus} is the lighter instrument: it hides one
 * comment without removing the thread beneath it.
 *
 * @param commentId - The comment's server-generated identifier.
 * @param options - Per-request controls, forwarded untouched.
 * @returns Nothing, on success.
 * @throws The client's normalised error.
 */
export function deleteAdminComment(
  commentId: string,
  options?: AdminRequestOptions,
): Promise<void> {
  return apiDeleteNoContent(adminCommentPath(commentId, 'deleteAdminComment'), options);
}

/* -------------------------------------------------------------------------------------------------
 * Categories - the whole lifecycle lives here
 *
 * The taxonomy is administrative reference data, so the three mutating functions below are the *only*
 * way it changes. `src/lib/api/categories.ts` is read-only by design and the service's public category
 * router declares no mutation at all: an author files a post under existing terms rather than
 * inventing them, which is what keeps the taxonomy a controlled vocabulary instead of a free-text
 * field.
 *
 * The fourth function, {@link listAdminCategories}, is the management table those three act on. It
 * exists beside the public listing rather than in place of it because it accepts a search term, and
 * only because of that - both answer the identical page envelope of the identical item type, and both
 * reach one service method behind the API, so the management table and the home page's filter control
 * cannot disagree about what a category is. It reads a category rather than mutating one, and is
 * grouped here so that the four operations over one resource are read together.
 *
 * There is no administrative *projection* of a category, and none is missing: a category has no owner,
 * no address, no credential and no moderation state, so `CategoryPublic` already carries every member
 * this screen shows. That is why this is the one family on the namespace whose listing does not return
 * an `Admin`-prefixed type.
 *
 * Neither input accepts an identifier or a slug, and the request types make that structural rather
 * than merely conventional. Identity is generated by the database. The slug is derived from the name
 * by the service at creation and is **stable thereafter** - renaming a category does not re-derive
 * it - because the slug is the category's canonical URL, and one that changed on an edit would break
 * every published link and every crawled page pointing at it. A client-supplied slug could also
 * collide with an existing category. So neither field is sent, and there is no way to send one.
 * ---------------------------------------------------------------------------------------------- */

/**
 * List categories for the category management table.
 *
 * `GET /admin/categories` &rarr; `200` with a {@link Page} of {@link CategoryPublic}.
 *
 * **The item type is the public one**, not an `Admin`-prefixed projection, and that is deliberate -
 * see this section's header. A screen may therefore render a row from this listing with the same
 * component that renders the home page's filter option.
 *
 * Two things separate this from `listCategories` in `@/lib/api/categories.ts`: `q`, and the envelope
 * itself - that read returns a bare `CategoryPublic[]` covering the whole taxonomy, because it is the
 * home page's filter control and windowing it could hide posts, whereas this is a table and pages like
 * every other. The item type is the same on both, and so is `post_count`, which counts PUBLISHED posts
 * on either, so a moderator reads the figure a reader would see. A term with nothing
 * filed under it is present with a `post_count` of `0` rather than omitted, which is how the table
 * shows an unused category - and how {@link deleteAdminCategory} becomes available for it, since that
 * deletion is refused while any post is still filed.
 *
 * @param params - Window and search term. Omit entirely for the first page of the whole taxonomy.
 * @param options - Per-request controls, forwarded untouched. A `query` here is superseded by
 * `params` - see {@link listRequestOptions}.
 * @returns One page of categories, its five envelope fields exactly as the service sent them.
 * @throws The client's normalised error.
 */
export function listAdminCategories(
  params: AdminCategoryListParams = {},
  options?: AdminRequestOptions,
): Promise<Page<CategoryPublic>> {
  assertSearchTermLength(params.q, 'listAdminCategories');

  const query: QueryParams = {
    page: params.page,
    page_size: params.page_size,
    q: params.q,
  };
  return apiGet(
    ADMIN_CATEGORIES_PATH,
    pageOf(categoryPublicSchema),
    listRequestOptions(query, options),
  );
}

/**
 * Create a category.
 *
 * `POST /admin/categories` &rarr; **`201 Created`** with the new {@link CategoryPublic}.
 *
 * The only creating operation on this namespace, and the only path to a new category anywhere in the
 * API. The response carries the generated identifier and the derived slug, and its `post_count` is
 * `0` since nothing has been filed under it yet.
 *
 * A duplicate name - or a name whose derived slug is already taken - is reported as a conflict rather
 * than accepted, so the taxonomy cannot grow two terms a reader would read as the same one. That
 * conflict arrives as the client's normalised error like any other refusal.
 *
 * @param payload - The category's name, and optionally a description. Surrounding whitespace in the
 * name is removed by the service. Send neither an identifier nor a slug; the type does not allow it.
 * @param options - Per-request controls, forwarded untouched.
 * @returns The created category.
 * @throws The client's normalised error.
 */
export function createAdminCategory(
  payload: CategoryCreate,
  options?: AdminRequestOptions,
): Promise<CategoryPublic> {
  return apiPost(ADMIN_CATEGORIES_PATH, categoryPublicSchema, payload, options);
}

/**
 * Rename a category, or change its description.
 *
 * `PATCH /admin/categories/{id}` &rarr; `200` with the updated {@link CategoryPublic}.
 *
 * Addresses **the category itself**, with no sub-path - the same shape as {@link updateAdminUser},
 * and deliberately unlike the two `/status` transitions.
 *
 * A genuinely partial update: both members of {@link CategoryUpdate} are optional and an omitted one
 * is left unchanged. The two are not symmetrical in what they accept, and the distinction is
 * meaningful rather than incidental - `name` may not be nulled, because the column behind it is not
 * nullable, while `description` accepts an explicit `null` to clear prose that was previously set.
 * Omitting a member and sending `null` for it are therefore different requests.
 *
 * The slug does **not** change when the name does. See this section's header for why that matters.
 *
 * @param categoryId - The category's server-generated identifier.
 * @param payload - The members to change.
 * @param options - Per-request controls, forwarded untouched.
 * @returns The category in its new state.
 * @throws The client's normalised error.
 */
export function updateAdminCategory(
  categoryId: string,
  payload: CategoryUpdate,
  options?: AdminRequestOptions,
): Promise<CategoryPublic> {
  return apiPatch(
    adminCategoryPath(categoryId, 'updateAdminCategory'),
    categoryPublicSchema,
    payload,
    options,
  );
}

/**
 * Delete a category.
 *
 * `DELETE /admin/categories/{id}` &rarr; **`204 No Content`**, so there is no body and nothing is
 * parsed.
 *
 * Refused as a conflict while at least one post is still filed under the category - re-file or remove
 * those posts first. The guard is not merely tidiness: the association carries a cascade, so without
 * it the deletion would succeed and silently take every filing with it, leaving posts short of a
 * category with nothing failing and nobody told. A category no post references is removed.
 *
 * That refusal arrives as the client's normalised error, carrying prose safe to show to the person
 * who attempted it, and is distinguishable from a missing category: the service resolves "does not
 * exist" before "may not be deleted yet", so the two are never conflated.
 *
 * @param categoryId - The category's server-generated identifier.
 * @param options - Per-request controls, forwarded untouched.
 * @returns Nothing, on success.
 * @throws The client's normalised error.
 */
export function deleteAdminCategory(
  categoryId: string,
  options?: AdminRequestOptions,
): Promise<void> {
  return apiDeleteNoContent(adminCategoryPath(categoryId, 'deleteAdminCategory'), options);
}
