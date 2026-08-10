/**
 * Mock Service Worker request handlers for the component test suite.
 *
 * WHAT THIS MODULE IS
 *
 * The single, shared description of how the REST service behaves, expressed at the network
 * boundary. Component tests intercept HTTP here rather than mocking `fetch` or
 * `src/lib/api/client.ts`, so the real client runs on every request a test provokes: its lazy base
 * URL resolution, its bearer attachment, its refresh-on-401 rotation, its problem-document
 * normalisation and its per-endpoint response decoding are all exercised instead of retired. That
 * client is the only module in the presentation tier permitted to perform HTTP, and intercepting
 * one layer beneath it is what keeps that rule honest under test.
 *
 * WHAT THIS MODULE IS NOT
 *
 * It owns no server instance and no lifecycle. `setupServer`, `listen`, `resetHandlers` and `close`
 * belong to the specs that need them, alongside `frontend/vitest.setup.ts`'s jsdom preparation.
 * This module exports handlers and fixtures; nothing here imports `msw/node`, so it stays free of a
 * Node-only entry point and can be consumed from any environment.
 *
 * THE TWO PROPERTIES EVERY HANDLER HERE MAINTAINS
 *
 *  1. STATELESS. `server.resetHandlers()` restores the handler array between tests but cannot
 *     reset module state, so a counter or a pushed-to array would leak one test's writes into the
 *     next in declaration order and produce failures that look like component defects. Every
 *     resolver below derives its answer from the incoming request and the frozen fixtures alone.
 *     Nothing in this module is reassigned or mutated after it is declared.
 *  2. IDEMPOTENT. A repeated request yields a byte-identical answer. `PUT /posts/{id}/like` is the
 *     clearest case: the service guarantees idempotence structurally, through a composite primary
 *     key on `(post_id, user_id)` with a conflict-ignoring insert, so a mock that incremented a
 *     count would contradict the system it stands in for. The like answer is nonetheless a function
 *     of the CALLER - a caller who had not liked a post sees the count rise once and stay there -
 *     which is per-principal without being stateful, because who has already liked what is a frozen
 *     fixture rather than something a request writes.
 *  3. REFUSING. Every rule the service enforces is enforced here, and that is not a nicety: a mock
 *     that accepts what the service refuses makes the refusal path of every form and every guard
 *     unreachable under test, so an assertion written against it says nothing about the case it
 *     names. Concretely - a window outside `1..100` is a 422 and never clamped; an unrecognised
 *     bearer is a 401 and never the author; a deactivated account is a 403 on a protected route and
 *     anonymous on an optional one; the administrative namespace requires the `ADMIN` role and not
 *     merely a credential; a draft is readable by its author and an administrator and by nobody
 *     else; authoring requires the `AUTHOR` role; a mutation requires ownership, refused 404 before
 *     403 so a refusal cannot confirm a draft exists; a like or a comment on an unknown post is a
 *     404; a created comment is `PENDING`; an approved comment returns to `PENDING` when it is
 *     edited; an undeclared member is `extra_forbidden`; and every text member is bounded in code
 *     points as `pydantic.StringConstraints` bounds it.
 *
 * THE CONTRACTS IT HONOURS
 *
 *  - Every collection answers with the five-field `Page<T>` envelope: `items`, `total`, `page`,
 *    `page_size`, `pages`, windowed at `page_size` **20** by default - the service's own number.
 *    `GET /categories` is the one documented exception across the whole API - it answers with a bare
 *    array, ordered by name ascending, because it powers the home page's filter control and is
 *    un-paginated by contract.
 *  - Every failure answers with one uniform `ProblemDetail` under the
 *    `application/problem+json` media type, built by the single `problem` helper below so the error
 *    contract is declared once. Its `type` and `title` values match the closed `/errors/...` set the
 *    service emits, and its `request_id` is populated because `src/lib/api/client.ts` substitutes a
 *    synthesised document for any problem body that omits it. `X-Request-ID` is set on every
 *    response, a 204 included, exactly as `app.middleware.request_context` sets it.
 *  - Every domain path sits under `/api/v1`. The two operational probes, `/healthz` and `/readyz`,
 *    are the only unversioned paths.
 *  - Field names stay snake_case, exactly as the API emits them: there is no camelCase translation
 *    layer anywhere in the tier, so introducing one here would test a shape that never ships.
 *  - Identity is a UUID string and every timestamp is an ISO-8601 string, never a `Date`. JSON
 *    carries no date type, so a `Date` in a fixture would be silently stringified and would let a
 *    component that mishandles the string form pass anyway.
 *
 * HOW AUTHENTICATION AND AUTHORISATION ARE MODELLED
 *
 * The default handler array is the happy path **for a caller who is entitled to it**, and it models
 * authentication and authorisation properly rather than by the presence of a header.
 *
 * A request carries a token from a small closed set, and which token it carries decides who the
 * caller is: `FIXTURE_AUTHOR_ACCESS_TOKEN`, `FIXTURE_READER_ACCESS_TOKEN`,
 * `FIXTURE_ADMIN_ACCESS_TOKEN`, the three rotated tokens
 * (`FIXTURE_ROTATED_ACCESS_TOKEN`, `FIXTURE_READER_ROTATED_ACCESS_TOKEN`,
 * `FIXTURE_ADMIN_ROTATED_ACCESS_TOKEN` - one per principal, because a rotation replaces a credential
 * and never moves an identity) and `FIXTURE_SUSPENDED_ACCESS_TOKEN` are the whole vocabulary.
 * Anything else - including `FIXTURE_UNKNOWN_ACCESS_TOKEN`, which exists so a spec can attach a
 * *wrong* credential deliberately - is a 401 with `WWW-Authenticate: Bearer`, which is also what an
 * absent header earns and what the client's single-flight rotation keys on.
 *
 * The `Authorization` header is parsed the way `app.core.dependencies` parses it: the scheme is
 * matched **case-insensitively** (RFC 7235 declares `auth-scheme` case-insensitive), the split is on
 * the first space, and the parse distinguishes **no header** from **a header that cannot be used** -
 * another scheme, an empty `Bearer`, a raw token with no scheme. Only the first of those is anonymous.
 *
 * From there the three gates are the service's own: `authenticate` for a route that needs a
 * principal, `authenticateAdmin` for the administrative namespace, and `optionalPrincipal` for a
 * public route whose answer is nonetheless viewer-scoped. The last of those has **three** outcomes
 * rather than two - a principal, anonymous, or a 401 - because the service does: an unusable or
 * unrecognised credential on a public read is refused rather than downgraded, and only an absent
 * header or a deactivated account is answered anonymously. Role and ownership refusals are therefore
 * reachable from the **default** array by presenting the credential of somebody who is not entitled
 * - which is how a spec should reach them, because that is how a browser will.
 *
 * The named failure handlers exported at the end of this module remain for the refusals the defaults
 * cannot express: a 401 to a caller whose credential *is* valid (an expired token, from the client's
 * side), a 403 to a caller who *is* an administrator, a 404 to a resource that does exist, and the
 * 409, 422 and 429 documents for a body or a rate limit the defaults would have accepted.
 *
 * PATH PREDICATE AND ORDERING RULES
 *
 * Predicates are origin-agnostic - every one begins with `*` - because the base URL is supplied by
 * the environment and is not knowable here. Nothing in this module reads `process.env` or names an
 * origin. Order matters, because msw answers with the first matching handler, so the fixed
 * relative order below is load-bearing rather than stylistic: `/users/me` precedes
 * `/users/:username`, every `/posts/:postId/...` sub-path precedes the bare `/posts/:slug`, and
 * `/admin/posts/:postId/status` precedes `/admin/posts/:postId`.
 */

import { http, HttpResponse } from 'msw';

import type {
  AdminComment,
  AdminPost,
  AdminStats,
  AdminUser,
  CategoryPublic,
  CategorySummary,
  CommentPublic,
  CommentStatus,
  LikeSummary,
  Page,
  PostDetail,
  PostStatus,
  PostSummary,
  ProblemDetail,
  TokenPair,
  UserMe,
  UserPublic,
  UserRole,
  ValidationErrorItem,
} from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Operational probe contracts
 *
 * `@/lib/types` describes the blog domain and exports no liveness or readiness shape, because no
 * typed client wrapper calls either probe - they are read by an orchestrator, which decides on the
 * status code alone. The two shapes are therefore declared here rather than imported from a module
 * that does not provide them, and they mirror the service's own `LivenessResponse` and
 * `ReadinessResponse` field for field so a test asserting on a probe body asserts on what ships.
 * ---------------------------------------------------------------------------------------------- */

/** Liveness answer: the process is running. Carries no database claim, and touches no database. */
export interface LivenessReport {
  status: 'alive';
}

/** Readiness answer: the process is running *and* a trivial query against its database succeeded. */
export interface ReadinessReport {
  status: 'ready';
  database: boolean;
}

/* -------------------------------------------------------------------------------------------------
 * Response and problem-document vocabulary
 *
 * The `/errors/...` type references and their titles are the closed set the service emits, so a
 * component branching on `problem.type` in a test branches on the value it will see in production.
 * ---------------------------------------------------------------------------------------------- */

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE_CONTENT = 422;
const HTTP_TOO_MANY_REQUESTS = 429;

const ERROR_TYPE_UNAUTHORIZED = '/errors/unauthorized';
const ERROR_TYPE_FORBIDDEN = '/errors/forbidden';
const ERROR_TYPE_NOT_FOUND = '/errors/not-found';
const ERROR_TYPE_CONFLICT = '/errors/conflict';
const ERROR_TYPE_VALIDATION = '/errors/validation-error';
const ERROR_TYPE_RATE_LIMITED = '/errors/rate-limit-exceeded';

const ERROR_TITLE_UNAUTHORIZED = 'Unauthorized';
const ERROR_TITLE_FORBIDDEN = 'Forbidden';
const ERROR_TITLE_NOT_FOUND = 'Not Found';
const ERROR_TITLE_CONFLICT = 'Conflict';
const ERROR_TITLE_VALIDATION = 'Validation Error';
const ERROR_TITLE_RATE_LIMITED = 'Too Many Requests';

const AUTHORIZATION_HEADER = 'Authorization';
/**
 * The one scheme this API accepts, folded to lower case for comparison.
 *
 * Lower case because RFC 7235 declares `auth-scheme` case-insensitive and
 * `app.core.dependencies` compares `scheme.lower()` against exactly this literal. The value is the
 * comparison target, never something written into a header - see {@link WWW_AUTHENTICATE_BEARER} for
 * the challenge's own canonical spelling.
 */
const BEARER_SCHEME = 'bearer';
const WWW_AUTHENTICATE_HEADER = 'WWW-Authenticate';
const WWW_AUTHENTICATE_BEARER = 'Bearer';
const RETRY_AFTER_HEADER = 'Retry-After';
const REQUEST_ID_HEADER = 'X-Request-ID';
const CONTENT_TYPE_HEADER = 'Content-Type';

/**
 * The media type every failure carries, and the reason `problem` does not use `HttpResponse.json`.
 *
 * `app.core.exceptions.PROBLEM_JSON_MEDIA_TYPE`. Successful responses stay `application/json`, which
 * is what `HttpResponse.json` sets, so only the failure builder needs to say so explicitly.
 */
const PROBLEM_JSON_MEDIA_TYPE = 'application/problem+json';

/**
 * The correlation identifier every problem document and every successful response carries.
 *
 * Fixed rather than generated: `src/lib/api/client.ts` surfaces it as `ApiError.requestId`, and a
 * value that changed per request could not be asserted on.
 */
export const FIXTURE_REQUEST_ID = 'req-00000000-0000-4000-8000-000000000000';

/** Seconds a rate-limited caller is told to wait, mirrored into the `Retry-After` header. */
export const FIXTURE_RETRY_AFTER_SECONDS = 42;

/**
 * The default window size the service applies when a caller names no `page_size`.
 *
 * **Twenty, which is the service's own number** - `app.core.dependencies.DEFAULT_PAGE_SIZE`, and the
 * value `@/lib/types` documents for the contract ("defaulting to 20 when it is not sent"). It was
 * ten here, and that is worth recording rather than quietly correcting: every spec that computed an
 * expected `pages` count from this export agreed with the mock and disagreed with production, so a
 * pagination control could have been off by a factor of two in every test and in none of them
 * visibly. A number a fixture invents is not a default; it is a second contract.
 *
 * Exported because a test computing an expected `pages` count needs the same divisor the handlers
 * use; duplicating the literal in a spec is how the two drift apart.
 */
export const DEFAULT_PAGE_SIZE = 20;

/** Smallest window the service will serve. A `page_size` below it is refused, not raised. */
export const MIN_PAGE_SIZE = 1;

/**
 * Largest window the service will serve.
 *
 * `app.core.dependencies.MAX_PAGE_SIZE`, declared there as `Query(le=100)` - so a larger value is
 * **rejected with 422, never clamped**, and the typed wrappers forward it untouched rather than
 * enforcing anything themselves. This module used to clamp, which silently turned every
 * out-of-range request in every spec into a successful one and made the 422 branch of a caller's
 * error handling unreachable under test.
 */
export const MAX_PAGE_SIZE = 100;

const FIRST_PAGE = 1;

/* -------------------------------------------------------------------------------------------------
 * Enumerated members, restated for runtime narrowing
 *
 * `@/lib/types` exports these as runtime constants, but this module imports types only - a value
 * import would pull the schema library into a fixture module for no benefit. Restating them under
 * their imported union types costs nothing and buys the drift protection that matters: if a member
 * is ever added to or renamed in the contract, these annotations stop compiling here.
 * ---------------------------------------------------------------------------------------------- */

const POST_STATUS_VALUES: readonly PostStatus[] = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];
const COMMENT_STATUS_VALUES: readonly CommentStatus[] = ['PENDING', 'APPROVED', 'REJECTED'];
const USER_ROLE_VALUES: readonly UserRole[] = ['READER', 'AUTHOR', 'ADMIN'];

/** The moderation state at which a comment becomes visible to an anonymous reader. */
/**
 * The shape `uuid.UUID` accepts: 8-4-4-4-12 hexadecimal, case-insensitively.
 *
 * Restated here rather than validated by a library because the mock may import nothing but `msw`.
 * Pydantic also accepts a `urn:uuid:` prefix and an unhyphenated form; neither is anything this
 * client sends, and admitting them would widen the mock past the values the API is asked for.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VISIBLE_COMMENT_STATUS: CommentStatus = 'APPROVED';

/**
 * The moderation state a newly written comment enters, which is NOT the visible one.
 *
 * `comment_service` creates at `PENDING`, and an accepted edit returns an `APPROVED` comment to
 * `PENDING` whoever made it. This module used to answer `APPROVED` on create, which taught every
 * comment-form spec that a submission appears in the thread immediately - the opposite of what a
 * reader sees, and a difference a component's own success message has to reflect.
 */
const PENDING_COMMENT_STATUS: CommentStatus = 'PENDING';

/** `comment_service.PUBLIC_COMMENT_STATUSES`: what an ordinary reader may see, and nothing more. */
const PUBLIC_COMMENT_STATUSES: readonly CommentStatus[] = [VISIBLE_COMMENT_STATUS];

/** `app.schemas.post.PostSortOption`, a closed set of two - so a third value is a 422. */
const POST_SORT_OPTIONS: readonly string[] = ['recent', 'relevance'];

/** The lifecycle state at which a post enters the public feed. */
const VISIBLE_POST_STATUS: PostStatus = 'PUBLISHED';

/** The one role the administrative namespace admits. */
const ADMIN_ROLE: UserRole = 'ADMIN';

/** The roles that may author a post. `ensure_can_author` refuses a `READER` with 403. */
const AUTHORING_ROLES: readonly UserRole[] = ['AUTHOR', 'ADMIN'];

/**
 * The detail a deactivated account is refused with, on sign-in and on every protected route alike.
 *
 * One sentence for both, quoted from `app.core.dependencies.get_current_active_user` and reused by
 * `app.services.auth_service`, so a client tells one consistent story about a suspended account
 * whether it is signing in or presenting a token it already holds.
 */
const DEACTIVATED_ACCOUNT_DETAIL = 'This account has been deactivated.';

/**
 * The detail a registration conflict carries, for a taken address and a taken handle ALIKE.
 *
 * Deliberately ambiguous, and quoted from `app.services.auth_service._IDENTIFIER_TAKEN`. Naming
 * which of the two collided would turn the one unauthenticated write in the API into an oracle for
 * both the address list and the handle list - so a sign-up form cannot mark a single control from
 * this document, and must not be built or tested as though it could.
 */
const IDENTIFIER_TAKEN_DETAIL = 'That email address or username is already registered.';

/**
 * `CategoryService`'s refusal to delete a category posts are still filed under, verbatim.
 *
 * Phrased as an instruction because the conflict is entirely resolvable by the caller, and because the
 * alternative to refusing is data loss - `post_categories.category_id` cascades.
 */
/**
 * The three lockout refusals, quoted from `app.services.admin_service`.
 *
 * Each is rendered verbatim as a problem document's `detail`, and each names the remedy rather than
 * only the refusal - "ask another administrator" is the whole of what the operator can do - so the
 * wording is part of the contract a component renders and not decoration.
 */
const SELF_DEMOTION_DETAIL =
  'An administrator cannot remove their own administrator role. Ask another administrator to make ' +
  'this change.';
const SELF_DEACTIVATION_DETAIL =
  'An administrator cannot deactivate their own account. Ask another administrator to make this ' +
  'change.';
const SELF_DELETION_DETAIL =
  'An administrator cannot delete their own account. Ask another administrator to make this change.';

const CATEGORY_IN_USE_DETAIL =
  'Posts are still filed under this category. Re-file them before deleting it.';

/** The detail every refused sign-in carries, whichever half of the pair was wrong. */
const CREDENTIAL_REFUSED_DETAIL = 'Incorrect email or password.';

/* -------------------------------------------------------------------------------------------------
 * Identity
 *
 * Every primary key is a UUID string, because the service generates identity server-side; the
 * integer, client-supplied keys of the retired demonstration API have no counterpart anywhere in
 * this contract. The literals are deliberately obviously-fake and readable, with one hexadecimal
 * digit reserved per entity kind, so a failing assertion names the row it is about: `1...` users,
 * `a...` categories, `b...` posts, `c...` comments.
 * ---------------------------------------------------------------------------------------------- */

const USER_ID_AUTHOR = '11111111-1111-4111-8111-111111111111';
const USER_ID_READER = '12222222-2222-4222-8222-222222222222';
const USER_ID_ADMIN = '13333333-3333-4333-8333-333333333333';
const USER_ID_SUSPENDED = '14444444-4444-4444-8444-444444444444';

const CATEGORY_ID_ENGINEERING = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CATEGORY_ID_DESIGN = 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const CATEGORY_ID_PRODUCT = 'aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const CATEGORY_ID_UNUSED = 'aaaaaaa4-aaaa-4aaa-8aaa-aaaaaaaaaaa4';

const POST_ID_SCALING = 'bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const POST_ID_TOKENS = 'bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const POST_ID_SEARCH = 'bbbbbbb3-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
const POST_ID_DIALOGS = 'bbbbbbb4-bbbb-4bbb-8bbb-bbbbbbbbbbb4';
const POST_ID_DARK_MODE = 'bbbbbbb5-bbbb-4bbb-8bbb-bbbbbbbbbbb5';
const POST_ID_DRAFT = 'bbbbbbb6-bbbb-4bbb-8bbb-bbbbbbbbbbb6';
const POST_ID_ARCHIVED = 'bbbbbbb7-bbbb-4bbb-8bbb-bbbbbbbbbbb7';

const COMMENT_ID_ROOT_APPROVED = 'ccccccc1-cccc-4ccc-8ccc-ccccccccccc1';
const COMMENT_ID_REPLY_APPROVED = 'ccccccc2-cccc-4ccc-8ccc-ccccccccccc2';
const COMMENT_ID_ROOT_SECOND = 'ccccccc3-cccc-4ccc-8ccc-ccccccccccc3';
const COMMENT_ID_ROOT_PENDING = 'ccccccc4-cccc-4ccc-8ccc-ccccccccccc4';
const COMMENT_ID_ROOT_REJECTED = 'ccccccc5-cccc-4ccc-8ccc-ccccccccccc5';

/**
 * The identifier every creation route answers with.
 *
 * One fixed value per created kind rather than a generated one, because a stateless mock cannot
 * remember what it minted and a test asserting on a created resource needs a value to compare
 * against. Distinct from every stored fixture identifier, so a create is never mistaken for a read.
 */
const CREATED_POST_ID = 'bbbbbbbf-bbbb-4bbb-8bbb-bbbbbbbbbbbf';
const CREATED_COMMENT_ID = 'ccccccdf-cccc-4ccc-8ccc-cccccccccccf';
const CREATED_CATEGORY_ID = 'aaaaaaaf-aaaa-4aaa-8aaa-aaaaaaaaaaaf';
const CREATED_USER_ID = '1fffffff-ffff-4fff-8fff-ffffffffffff';

/* -------------------------------------------------------------------------------------------------
 * Instants
 *
 * ISO-8601 strings with an explicit UTC offset, ordered so that "recent" and "relevance" orderings
 * of the published set are provably different sequences rather than coincidentally equal ones.
 * ---------------------------------------------------------------------------------------------- */

const INSTANT_ACCOUNT_CREATED = '2023-09-14T08:30:00Z';
const INSTANT_ACCOUNT_UPDATED = '2024-05-06T11:45:00Z';

const INSTANT_POST_SCALING_CREATED = '2024-04-28T09:15:00Z';
const INSTANT_POST_SCALING_PUBLISHED = '2024-05-02T07:00:00Z';
const INSTANT_POST_SCALING_UPDATED = '2024-05-03T16:20:00Z';

const INSTANT_POST_TOKENS_CREATED = '2024-04-12T13:05:00Z';
const INSTANT_POST_TOKENS_PUBLISHED = '2024-04-18T06:30:00Z';

const INSTANT_POST_SEARCH_CREATED = '2024-03-30T18:40:00Z';
const INSTANT_POST_SEARCH_PUBLISHED = '2024-04-02T09:10:00Z';

const INSTANT_POST_DIALOGS_CREATED = '2024-03-05T10:00:00Z';
const INSTANT_POST_DIALOGS_PUBLISHED = '2024-03-11T08:25:00Z';

const INSTANT_POST_DARK_MODE_CREATED = '2024-02-20T15:55:00Z';
const INSTANT_POST_DARK_MODE_PUBLISHED = '2024-02-27T07:45:00Z';

const INSTANT_POST_DRAFT_CREATED = '2024-05-05T12:00:00Z';
const INSTANT_POST_DRAFT_UPDATED = '2024-05-06T09:30:00Z';

const INSTANT_POST_ARCHIVED_CREATED = '2023-10-30T11:20:00Z';
const INSTANT_POST_ARCHIVED_PUBLISHED = '2023-11-05T08:00:00Z';
const INSTANT_POST_ARCHIVED_UPDATED = '2024-01-09T14:10:00Z';

const INSTANT_COMMENT_CREATED = '2024-05-03T10:05:00Z';
const INSTANT_COMMENT_UPDATED = '2024-05-03T10:05:00Z';

const INSTANT_CATEGORY_CREATED = '2023-09-20T09:00:00Z';

/**
 * The publication instant a `POST /posts/{id}/publish` stamps, and the creation instant a `POST`
 * route reports.
 *
 * Fixed so that the publish transition is assertable on an exact value rather than only on
 * non-nullness, and so two runs of the same spec cannot differ.
 */
export const FIXTURE_PUBLISHED_AT = '2024-05-10T12:00:00Z';
const INSTANT_CREATED_RESOURCE = '2024-05-10T11:59:00Z';

/* -------------------------------------------------------------------------------------------------
 * Credential fixtures
 *
 * Obviously-fake placeholders. Nothing here is a real credential, no value matches any provider's
 * token grammar, and no route ever echoes a submitted password back into a response.
 * ---------------------------------------------------------------------------------------------- */

/** Access-token lifetime the service reports, in seconds. */
const ACCESS_TOKEN_LIFETIME_SECONDS = 900;

/**
 * The access-token placeholders, one per signable-in account, plus the rotated one.
 *
 * They exist so that the identity of the caller is a property of the *request* rather than of
 * remembered state. `GET /auth/me` answers with whichever account the presented token names, so an
 * administrative spec can sign in as the administrator and be recognised as one, without this
 * module holding a session anywhere.
 *
 * **A bearer this set does not name is refused with 401.** It used to be admitted as the author, and
 * that single line of convenience is what finding C5 is about: it made every credentialled route
 * answer a *forged* token with the happy path, so no spec could distinguish a component that
 * attached its credential correctly from one that attached a wrong value, or nothing at all beyond a
 * non-empty string. A mock that accepts any token is not a lenient mock; it is a mock with no
 * authentication in it, and the assertions written against it say nothing about authentication.
 */
export const FIXTURE_AUTHOR_ACCESS_TOKEN = 'fixture-author-access-token';
export const FIXTURE_READER_ACCESS_TOKEN = 'fixture-reader-access-token';
export const FIXTURE_ADMIN_ACCESS_TOKEN = 'fixture-admin-access-token';

/**
 * The access tokens a rotation hands back - **one per principal, and that is the point**.
 *
 * A rotation replaces the credential without changing who holds it: `AuthService.issue_token_pair`
 * is called with the account the presented refresh token belongs to. One shared rotated token,
 * mapped to the author, therefore made a refresh *change identity* - a reader or an administrator who
 * rotated came back as the author, and every assertion made after that rotation was about the wrong
 * principal. Three tokens, three accounts, no identity movement.
 */
export const FIXTURE_ROTATED_ACCESS_TOKEN = 'fixture-author-rotated-access-token';
export const FIXTURE_READER_ROTATED_ACCESS_TOKEN = 'fixture-reader-rotated-access-token';
export const FIXTURE_ADMIN_ROTATED_ACCESS_TOKEN = 'fixture-admin-rotated-access-token';

/**
 * The suspended account's access token. Recognised, and therefore refused with **403, not 401**.
 *
 * The distinction is the contract's, not this module's: `get_current_active_user` resolves the
 * credential first and *then* rejects a deactivated account, so the answer says the credential was
 * genuine and the account is not usable - which no fresh token can fix, and which a client must
 * therefore not attempt a rotation for. Reachable only because this token exists; with an
 * accept-anything resolver it was not reachable at all.
 *
 * On an OPTIONAL-authentication read the same token resolves to **anonymous** instead, which is a
 * different rule rather than an inconsistency - see {@link optionalPrincipal}.
 */
export const FIXTURE_SUSPENDED_ACCESS_TOKEN = 'fixture-suspended-access-token';

/**
 * The suspended account's refresh token, and the only way to reach refresh's own refusal for it.
 *
 * `POST /auth/refresh` answers a token whose owner has been **deactivated or removed** with the same
 * **401** it answers a token that was never issued: `AuthService.rotate_refresh_token` raises
 * `UnauthorizedError(_INVALID_REFRESH_TOKEN)` for all of them, deliberately, because naming the
 * failed check tells an attacker which one to fix. It never emits 403 on this route - so the 403 this
 * module used to answer here was a status the client could never actually receive, and a spec written
 * against it would have encoded a refusal that does not exist.
 */
export const FIXTURE_SUSPENDED_REFRESH_TOKEN = 'fixture-suspended-refresh-token';

/**
 * A syntactically plausible token that names no account, for driving the refusal deliberately.
 *
 * Exported so a spec asserting "this component must attach the credential it was given" has a value
 * to attach that is wrong rather than absent - the two failures are answered identically by the
 * service and were answered identically-and-successfully by this module before.
 */
export const FIXTURE_UNKNOWN_ACCESS_TOKEN = 'fixture-unknown-access-token';

/**
 * The one password every fixture account was created with.
 *
 * Sign-in compares against it, so a wrong password earns a 401 exactly as an unregistered address
 * does - with the *same* document, which is the property that keeps the route from being an oracle
 * for which addresses are registered. Obviously fake, long enough and varied enough to satisfy the
 * published policy, and never echoed into any response.
 */
export const FIXTURE_PASSWORD = 'fixture-Password-1';

/** The pair `POST /auth/login` answers with for the author, and the default for any other email. */
export const fixtureTokenPair: TokenPair = {
  access_token: FIXTURE_AUTHOR_ACCESS_TOKEN,
  refresh_token: 'fixture-author-refresh-token',
  token_type: 'bearer',
  expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
};

/** The pair signing in as the reader yields. */
export const fixtureReaderTokenPair: TokenPair = {
  access_token: FIXTURE_READER_ACCESS_TOKEN,
  refresh_token: 'fixture-reader-refresh-token',
  token_type: 'bearer',
  expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
};

/** The pair signing in as the administrator yields; the credential an admin spec presents. */
export const fixtureAdminTokenPair: TokenPair = {
  access_token: FIXTURE_ADMIN_ACCESS_TOKEN,
  refresh_token: 'fixture-admin-refresh-token',
  token_type: 'bearer',
  expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
};

/**
 * The pair `POST /auth/refresh` answers a rotating AUTHOR with.
 *
 * Both members differ from every pair above, which is the whole point: a test can prove the client
 * replaced its held credentials rather than merely re-read them, and can prove the refresh token
 * itself rotated rather than being reissued unchanged.
 *
 * It is the author's pair specifically. See {@link fixtureReaderRotatedTokenPair} and
 * {@link fixtureAdminRotatedTokenPair} for the other two, and {@link rotatedPairsByAccountId} for the
 * mapping that keeps a rotation from moving the principal.
 */
export const fixtureRotatedTokenPair: TokenPair = {
  access_token: FIXTURE_ROTATED_ACCESS_TOKEN,
  refresh_token: 'fixture-author-rotated-refresh-token',
  token_type: 'bearer',
  expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
};

/** The pair a rotating READER receives. Distinct from the author's, because the principal is. */
export const fixtureReaderRotatedTokenPair: TokenPair = {
  access_token: FIXTURE_READER_ROTATED_ACCESS_TOKEN,
  refresh_token: 'fixture-reader-rotated-refresh-token',
  token_type: 'bearer',
  expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
};

/** The pair a rotating ADMINISTRATOR receives, so an admin spec keeps its authority across a rotation. */
export const fixtureAdminRotatedTokenPair: TokenPair = {
  access_token: FIXTURE_ADMIN_ROTATED_ACCESS_TOKEN,
  refresh_token: 'fixture-admin-rotated-refresh-token',
  token_type: 'bearer',
  expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
};

/* -------------------------------------------------------------------------------------------------
 * Account fixtures
 *
 * Stored once each in their richest projection, `UserMe`, and narrowed on the way out by
 * `toPublicUser` and `toAdminUser`. One source of truth per person means a public profile response
 * cannot leak `email`, `role` or `is_active` by omission - the projection is the only path to a
 * `UserPublic`, and it names the six fields that shape carries.
 *
 * Four accounts, chosen to cover all three roles, both states of `is_active`, and both states of
 * every nullable field: the author has a bio and an avatar, the reader has neither, the
 * administrator has a bio only, and the suspended reader has an avatar only. The suspended account
 * exists so the administrative table's active column renders both states without deactivating any
 * of the three accounts a component test signs in as.
 * ---------------------------------------------------------------------------------------------- */

/** An AUTHOR. Owns four of the seven stored posts, including the draft. */
export const fixtureAuthorAccount: UserMe = {
  id: USER_ID_AUTHOR,
  username: 'alice',
  display_name: 'Alice Rivera',
  bio: 'Backend engineer. Writes about databases, latency and the unglamorous parts of shipping.',
  avatar_url: 'https://avatars.githubusercontent.com/u/1000001?v=4',
  created_at: INSTANT_ACCOUNT_CREATED,
  email: 'alice@example.com',
  role: 'AUTHOR',
  is_active: true,
  updated_at: INSTANT_ACCOUNT_UPDATED,
};

/** A READER. Authors comments but no posts, and carries `bio: null` and `avatar_url: null`. */
export const fixtureReaderAccount: UserMe = {
  id: USER_ID_READER,
  username: 'bob',
  display_name: 'Bob Nakamura',
  bio: null,
  avatar_url: null,
  created_at: INSTANT_ACCOUNT_CREATED,
  email: 'bob@example.com',
  role: 'READER',
  is_active: true,
  updated_at: INSTANT_ACCOUNT_UPDATED,
};

/** An ADMIN. Also authors posts, so the administrative listings are not single-author. */
export const fixtureAdminAccount: UserMe = {
  id: USER_ID_ADMIN,
  username: 'dana',
  display_name: 'Dana Osei',
  bio: 'Design systems and accessibility. Maintains the token layer.',
  avatar_url: null,
  created_at: INSTANT_ACCOUNT_CREATED,
  email: 'dana@example.com',
  role: 'ADMIN',
  is_active: true,
  updated_at: INSTANT_ACCOUNT_UPDATED,
};

/**
 * A deactivated READER, present so `is_active: false` is exercised.
 *
 * Authors nothing, so deactivating it cannot subtract a row from the feed, a profile listing or a
 * comment thread. It is the row an administrative reactivation test acts on.
 */
export const fixtureSuspendedAccount: UserMe = {
  id: USER_ID_SUSPENDED,
  username: 'erin',
  display_name: 'Erin Halvorsen',
  bio: null,
  avatar_url: 'https://avatars.githubusercontent.com/u/1000004?v=4',
  created_at: INSTANT_ACCOUNT_CREATED,
  email: 'erin@example.com',
  role: 'READER',
  is_active: false,
  updated_at: INSTANT_ACCOUNT_UPDATED,
};

/** Every stored account, in the order the administrative listing reports them. */
const storedAccounts: readonly UserMe[] = [
  fixtureAuthorAccount,
  fixtureReaderAccount,
  fixtureAdminAccount,
  fixtureSuspendedAccount,
];

/* -------------------------------------------------------------------------------------------------
 * Projections
 *
 * Each one names every field of its target shape explicitly instead of spreading a richer object.
 * That is deliberate: a spread would carry `email` into a `UserPublic`, `content` into a
 * `PostSummary` and `replies` into an `AdminComment`, and none of those fields belongs to the shape
 * the route declares. Naming the fields makes the omission structural rather than remembered.
 * ---------------------------------------------------------------------------------------------- */

/** Narrow an account to the shape a public profile, byline or author reference exposes. */
function toPublicUser(account: UserMe): UserPublic {
  return {
    id: account.id,
    username: account.username,
    display_name: account.display_name,
    bio: account.bio,
    avatar_url: account.avatar_url,
    created_at: account.created_at,
  };
}

/** Project an account into the administrative row, which does expose email, role and state. */
function toAdminUser(account: UserMe): AdminUser {
  return {
    id: account.id,
    email: account.email,
    username: account.username,
    display_name: account.display_name,
    role: account.role,
    is_active: account.is_active,
    created_at: account.created_at,
    updated_at: account.updated_at,
  };
}

/** Narrow a category to the slim projection embedded in a post. */
function toCategorySummary(category: CategoryPublic): CategorySummary {
  return { id: category.id, name: category.name, slug: category.slug };
}

/** Narrow a post to the list projection, which carries no body content. */
function toPostSummary(post: PostDetail): PostSummary {
  return {
    id: post.id,
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    cover_image_url: post.cover_image_url,
    status: post.status,
    published_at: post.published_at,
    view_count: post.view_count,
    created_at: post.created_at,
    author: post.author,
    categories: post.categories,
  };
}

/** Project a post into the administrative row: no body, no excerpt, no categories. */
function toAdminPost(post: PostDetail): AdminPost {
  return {
    id: post.id,
    title: post.title,
    slug: post.slug,
    status: post.status,
    published_at: post.published_at,
    view_count: post.view_count,
    author: post.author,
    created_at: post.created_at,
    updated_at: post.updated_at,
  };
}

/** Project a comment into the moderation row, which is flat: replies are separate rows there. */
function toAdminComment(comment: CommentPublic): AdminComment {
  return {
    id: comment.id,
    post_id: comment.post_id,
    parent_id: comment.parent_id,
    author: comment.author,
    body: comment.body,
    status: comment.status,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}

/** The author as a reader sees them: a byline, a profile header, a post's `author` member. */
export const fixtureAuthor: UserPublic = toPublicUser(fixtureAuthorAccount);

/** The reader as a reader sees them - the `author` of most of the comment thread. */
export const fixtureReader: UserPublic = toPublicUser(fixtureReaderAccount);

/** The administrator as a reader sees them; they author posts too, so this appears in bylines. */
export const fixtureAdmin: UserPublic = toPublicUser(fixtureAdminAccount);

/* -------------------------------------------------------------------------------------------------
 * Taxonomy fixtures
 *
 * Three categories. Two carry a description; the third carries `description: null`, so the filter
 * control renders both without a spec having to construct one by hand. Each `post_count` is the
 * number of PUBLISHED posts classified under it - the control is public, so counting a draft there
 * would disclose one - and each is consistent with the stored post set below.
 * ---------------------------------------------------------------------------------------------- */

/** The busiest category: three published posts, and the draft as well. */
export const fixtureEngineeringCategory: CategoryPublic = {
  id: CATEGORY_ID_ENGINEERING,
  name: 'Engineering',
  slug: 'engineering',
  description: 'Services, storage and the seams between them.',
  post_count: 3,
  created_at: INSTANT_CATEGORY_CREATED,
};

/** A second populated category, so a category filter has more than one non-empty choice. */
export const fixtureDesignCategory: CategoryPublic = {
  id: CATEGORY_ID_DESIGN,
  name: 'Design',
  slug: 'design',
  description: 'Tokens, type and the accessibility floor.',
  post_count: 3,
  created_at: INSTANT_CATEGORY_CREATED,
};

/** The null-description category, and the sparsest: one published post, plus the archived one. */
export const fixtureProductCategory: CategoryPublic = {
  id: CATEGORY_ID_PRODUCT,
  name: 'Product',
  slug: 'product',
  description: null,
  post_count: 1,
  created_at: INSTANT_CATEGORY_CREATED,
};

/**
 * A category nothing is filed under, and the only one that can be DELETED.
 *
 * Two things need it. The service documents that a term with nothing filed under it is reported with
 * `post_count: 0` rather than omitted, so the filter control has to render that case; and the in-use
 * guard on `DELETE /admin/categories/{id}` refuses every category a post still references, so without
 * an empty one the successful delete path would be unreachable against these fixtures. Both paths are
 * now available: this one deletes, the other three conflict.
 */
export const fixtureUnusedCategory: CategoryPublic = {
  id: CATEGORY_ID_UNUSED,
  name: 'Operations',
  slug: 'operations',
  description: 'Nothing is filed here yet.',
  post_count: 0,
  created_at: INSTANT_CATEGORY_CREATED,
};

/**
 * Every category, **in the order `GET /categories` reports them**: by name, ascending.
 *
 * `category_repository` applies `ORDER BY name ASC` at all three of its read sites, so this is the
 * sequence the home page's filter control renders. It was declaration order - Engineering, Design,
 * Product - which is not sorted, so a control that relied on the array arriving ordered agreed with
 * this fixture and disagreed with the service. The handler sorts as well, belt and braces, so adding
 * a term here out of order cannot reintroduce the drift.
 */
export const fixtureCategories: readonly CategoryPublic[] = [
  fixtureDesignCategory,
  fixtureEngineeringCategory,
  fixtureUnusedCategory,
  fixtureProductCategory,
];

const engineeringSummary = toCategorySummary(fixtureEngineeringCategory);
const designSummary = toCategorySummary(fixtureDesignCategory);
const productSummary = toCategorySummary(fixtureProductCategory);

/* -------------------------------------------------------------------------------------------------
 * Post fixtures
 *
 * Seven posts, stored in their richest projection and narrowed on the way out. The set is built to
 * make the feed's own behaviour testable rather than merely to be non-empty:
 *
 *  - FIVE are PUBLISHED, so `page_size=2` yields three pages and page three is a partial window.
 *  - ONE is a DRAFT with `published_at: null`, which is the null path components must render, and
 *    which must never appear in the feed, in a category-filtered result or on a public profile.
 *  - ONE is ARCHIVED with a non-null `published_at`, because archiving something that was published
 *    does not unset the instant it was published at. It is absent from the feed for the same reason
 *    the draft is: only PUBLISHED is public.
 *  - `excerpt` and `cover_image_url` are each populated on some and `null` on others.
 *  - Every cover image sits on a host in the optimiser's allowlist, so `next/image` accepts it.
 *  - Titles carry distinct search terms, and `view_count` values are all distinct, so a relevance
 *    ordering is provably a different sequence from the recency default rather than accidentally
 *    the same one.
 * ---------------------------------------------------------------------------------------------- */

/** The flagship published post: the one a post-detail spec addresses by slug. */
export const fixturePost: PostDetail = {
  id: POST_ID_SCALING,
  title: 'Scaling FastAPI in production',
  slug: 'scaling-fastapi-in-production',
  excerpt: 'Connection pools, worker counts, and the two settings that actually move latency.',
  cover_image_url: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa',
  status: 'PUBLISHED',
  published_at: INSTANT_POST_SCALING_PUBLISHED,
  view_count: 128,
  created_at: INSTANT_POST_SCALING_CREATED,
  author: fixtureAuthor,
  categories: [engineeringSummary],
  content:
    '## Pools before workers\n\nA worker count tuned against a pool size that cannot serve it ' +
    'buys queueing, not throughput. Size the pool first, then the workers.\n',
  updated_at: INSTANT_POST_SCALING_UPDATED,
};

/** A published post in two categories, with `cover_image_url: null`. */
export const fixtureMultiCategoryPost: PostDetail = {
  id: POST_ID_TOKENS,
  title: 'Designing with semantic tokens',
  slug: 'designing-with-semantic-tokens',
  excerpt: 'Why a component should never name a colour, and what it names instead.',
  cover_image_url: null,
  status: 'PUBLISHED',
  published_at: INSTANT_POST_TOKENS_PUBLISHED,
  view_count: 76,
  created_at: INSTANT_POST_TOKENS_CREATED,
  author: fixtureAdmin,
  categories: [designSummary, engineeringSummary],
  content:
    '## One indirection\n\nA component written against a semantic token themes itself. A component ' +
    'written against a palette entry has to be edited twice.\n',
  updated_at: INSTANT_POST_TOKENS_PUBLISHED,
};

/** A published post with `excerpt: null`, so a card renders the missing-excerpt path. */
export const fixtureNoExcerptPost: PostDetail = {
  id: POST_ID_SEARCH,
  title: 'Ranked full-text search in Postgres',
  slug: 'ranked-full-text-search-in-postgres',
  excerpt: null,
  cover_image_url: 'https://picsum.photos/id/1024/1200/630',
  status: 'PUBLISHED',
  published_at: INSTANT_POST_SEARCH_PUBLISHED,
  view_count: 41,
  created_at: INSTANT_POST_SEARCH_CREATED,
  author: fixtureAuthor,
  categories: [engineeringSummary],
  content:
    '## A generated column\n\nStore the vector, weight the title above the body, and the index ' +
    'maintains itself on write.\n',
  updated_at: INSTANT_POST_SEARCH_PUBLISHED,
};

/** The most-viewed published post, so a relevance ordering has a distinct leader. */
export const fixtureMostViewedPost: PostDetail = {
  id: POST_ID_DIALOGS,
  title: 'A field guide to accessible dialogs',
  slug: 'a-field-guide-to-accessible-dialogs',
  excerpt: 'Focus trapping, escape handling, and why none of it should be hand-rolled.',
  cover_image_url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
  status: 'PUBLISHED',
  published_at: INSTANT_POST_DIALOGS_PUBLISHED,
  view_count: 202,
  created_at: INSTANT_POST_DIALOGS_CREATED,
  author: fixtureAdmin,
  categories: [designSummary],
  content:
    '## Borrow the behaviour\n\nAn unstyled primitive supplies the roles and the focus order. The ' +
    'project layer supplies the tokens.\n',
  updated_at: INSTANT_POST_DIALOGS_PUBLISHED,
};

/** The least-viewed published post, and the oldest, so it is last under both orderings. */
export const fixtureLeastViewedPost: PostDetail = {
  id: POST_ID_DARK_MODE,
  title: 'Shipping a dark mode without a flash',
  slug: 'shipping-a-dark-mode-without-a-flash',
  excerpt: 'A class on the document element, a system default, and no hydration mismatch.',
  cover_image_url: null,
  status: 'PUBLISHED',
  published_at: INSTANT_POST_DARK_MODE_PUBLISHED,
  view_count: 19,
  created_at: INSTANT_POST_DARK_MODE_CREATED,
  author: fixtureAuthor,
  categories: [designSummary, productSummary],
  content:
    '## Declare the token twice\n\nOnce at the root, once under the dark selector. Components stay ' +
    'unaware that there are two themes.\n',
  updated_at: INSTANT_POST_DARK_MODE_PUBLISHED,
};

/**
 * The DRAFT, with `published_at: null`.
 *
 * Readable by its author or an administrator and by nobody else, and absent from every public
 * listing. A spec that asserts draft confidentiality addresses this slug anonymously and expects
 * 404 rather than 403, because disclosing that a draft exists is itself a disclosure.
 */
export const fixtureDraftPost: PostDetail = {
  id: POST_ID_DRAFT,
  title: 'An unfinished draft about caching',
  slug: 'an-unfinished-draft-about-caching',
  excerpt: 'Notes towards an argument about invalidation.',
  cover_image_url: null,
  status: 'DRAFT',
  published_at: null,
  view_count: 0,
  created_at: INSTANT_POST_DRAFT_CREATED,
  author: fixtureAuthor,
  categories: [engineeringSummary],
  content:
    '## Still an outline\n\nInvalidation is the hard half. This section is not written yet.\n',
  updated_at: INSTANT_POST_DRAFT_UPDATED,
};

/** The ARCHIVED post: retired from the feed, but it keeps the instant it was published at. */
export const fixtureArchivedPost: PostDetail = {
  id: POST_ID_ARCHIVED,
  title: 'Archived notes on release rituals',
  slug: 'archived-notes-on-release-rituals',
  excerpt: null,
  cover_image_url: null,
  status: 'ARCHIVED',
  published_at: INSTANT_POST_ARCHIVED_PUBLISHED,
  view_count: 12,
  created_at: INSTANT_POST_ARCHIVED_CREATED,
  author: fixtureAdmin,
  categories: [productSummary],
  content: '## Superseded\n\nKept for the record. The process it describes no longer applies.\n',
  updated_at: INSTANT_POST_ARCHIVED_UPDATED,
};

/**
 * Every stored post, in recency order over `published_at` with the draft interleaved by creation.
 *
 * Declaration order is not what any listing relies on - each handler sorts explicitly - but keeping
 * it close to the default ordering makes the fixtures readable next to the assertions about them.
 */
export const fixturePosts: readonly PostDetail[] = [
  fixturePost,
  fixtureMultiCategoryPost,
  fixtureNoExcerptPost,
  fixtureMostViewedPost,
  fixtureLeastViewedPost,
  fixtureDraftPost,
  fixtureArchivedPost,
];

/* -------------------------------------------------------------------------------------------------
 * Comment fixtures
 *
 * A thread is a list of roots, each carrying its own replies nested inside `replies`. That nesting
 * is what the pagination contract is drawn around: a page of comments windows the ROOTS, and
 * `total` and `pages` count roots, because a reply arriving does not push a root onto another page.
 *
 * Five comments cover what the two surfaces need. The public thread needs a root with a nested
 * reply, so threading renders, and a root without replies, so the empty-replies path renders. The
 * moderation queue needs one comment in each of the three states, so the admin table's status
 * column and its approve and reject actions all have a row to act on.
 * ---------------------------------------------------------------------------------------------- */

/** An APPROVED reply, nested inside the first root rather than listed beside it. */
export const fixtureReply: CommentPublic = {
  id: COMMENT_ID_REPLY_APPROVED,
  post_id: POST_ID_SCALING,
  parent_id: COMMENT_ID_ROOT_APPROVED,
  author: fixtureAuthor,
  body: 'Right - and the pool has to be sized per worker, not per process.',
  status: 'APPROVED',
  created_at: INSTANT_COMMENT_CREATED,
  updated_at: INSTANT_COMMENT_UPDATED,
  reply_count: 0,
  has_more_replies: false,
  replies: [],
};

/** An APPROVED root with one nested reply. `parent_id` is null, which is what makes it a root. */
export const fixtureRootComment: CommentPublic = {
  id: COMMENT_ID_ROOT_APPROVED,
  post_id: POST_ID_SCALING,
  parent_id: null,
  author: fixtureReader,
  body: 'The pool sizing point is the one I keep getting wrong.',
  status: 'APPROVED',
  created_at: INSTANT_COMMENT_CREATED,
  updated_at: INSTANT_COMMENT_UPDATED,
  reply_count: 1,
  has_more_replies: false,
  replies: [fixtureReply],
};

/** A second APPROVED root, with no replies. */
export const fixtureChildlessComment: CommentPublic = {
  id: COMMENT_ID_ROOT_SECOND,
  post_id: POST_ID_SCALING,
  parent_id: null,
  author: fixtureAdmin,
  body: 'Adding the readiness probe alongside this changed how we deploy it.',
  status: 'APPROVED',
  created_at: INSTANT_COMMENT_CREATED,
  updated_at: INSTANT_COMMENT_UPDATED,
  reply_count: 0,
  has_more_replies: false,
  replies: [],
};

/** A PENDING root: in the moderation queue, invisible in the public thread. */
export const fixturePendingComment: CommentPublic = {
  id: COMMENT_ID_ROOT_PENDING,
  post_id: POST_ID_SCALING,
  parent_id: null,
  author: fixtureReader,
  body: 'Held for moderation until an administrator approves or rejects it.',
  status: 'PENDING',
  created_at: INSTANT_COMMENT_CREATED,
  updated_at: INSTANT_COMMENT_UPDATED,
  reply_count: 0,
  has_more_replies: false,
  replies: [],
};

/** A REJECTED root, on a different post, so the queue is not single-post. */
export const fixtureRejectedComment: CommentPublic = {
  id: COMMENT_ID_ROOT_REJECTED,
  post_id: POST_ID_TOKENS,
  parent_id: null,
  author: fixtureReader,
  body: 'Rejected by a moderator, and therefore never rendered to a reader.',
  status: 'REJECTED',
  created_at: INSTANT_COMMENT_CREATED,
  updated_at: INSTANT_COMMENT_UPDATED,
  reply_count: 0,
  has_more_replies: false,
  replies: [],
};

/**
 * Every stored comment, roots and replies alike, flattened.
 *
 * The moderation queue reads this list: an administrator moderates a reply exactly as they moderate
 * a root, so a reply is a row there even though it is nested in the public thread.
 */
export const fixtureComments: readonly CommentPublic[] = [
  fixtureRootComment,
  fixtureReply,
  fixtureChildlessComment,
  fixturePendingComment,
  fixtureRejectedComment,
];

/**
 * The publicly visible thread on the flagship post: two APPROVED roots, one of them with a reply.
 *
 * Exported so a comment-list spec can assert against the same two roots the handler serves rather
 * than restating them.
 */
export const fixtureCommentThread: readonly CommentPublic[] = [
  fixtureRootComment,
  fixtureChildlessComment,
];

/* -------------------------------------------------------------------------------------------------
 * Engagement fixtures
 *
 * Like counts are keyed by post so that a like control on one card cannot borrow another's count.
 * Every post the fixtures know about has an entry, including the draft and the archived one, so a
 * detail view of either still has a count to render.
 * ---------------------------------------------------------------------------------------------- */

const likeCountsByPostId: ReadonlyMap<string, number> = new Map([
  [POST_ID_SCALING, 12],
  [POST_ID_TOKENS, 7],
  [POST_ID_SEARCH, 3],
  [POST_ID_DIALOGS, 31],
  [POST_ID_DARK_MODE, 1],
  [POST_ID_DRAFT, 0],
  [POST_ID_ARCHIVED, 4],
]);

/** Count a post carries when the fixtures know nothing about it - an unlikeable, unliked post. */
const UNKNOWN_POST_LIKE_COUNT = 0;

/**
 * Which accounts have already liked each post, so `liked_by_caller` is a fact about the CALLER.
 *
 * The reason this exists rather than a boolean derived from "is a credential present": a like is keyed
 * on `(post_id, user_id)` in the service, so two different signed-in readers see two different answers
 * for the same post, and a client's optimistic control has to be correct for both. With the old
 * derivation every authenticated caller was reported as having liked everything, so an optimistic
 * update could not be distinguished from a no-op and the count never moved.
 *
 * The reader has liked the two most-discussed posts and the author has liked one of them, which gives
 * a spec three distinguishable states to assert on: liked by this caller, liked by others but not by
 * this caller, and liked by nobody.
 */
const likedByAccountId: ReadonlyMap<string, readonly string[]> = new Map([
  [POST_ID_SCALING, [USER_ID_READER, USER_ID_ADMIN]],
  [POST_ID_DIALOGS, [USER_ID_READER, USER_ID_AUTHOR]],
  [POST_ID_TOKENS, [USER_ID_ADMIN]],
]);

/**
 * The like state of the flagship post as an anonymous reader sees it.
 *
 * `liked_by_caller` is false because no credential was presented; the count is unaffected by that,
 * which is why the summary carries both members rather than only the flag.
 */
export const fixtureLikeSummary: LikeSummary = {
  post_id: POST_ID_SCALING,
  like_count: 12,
  liked_by_caller: false,
};

/**
 * Aggregate counts for the administrative overview, **derived from the collections they count**.
 *
 * `AdminService.get_stats` issues four `SELECT count(*)` statements over `users`, `posts`, `comments`
 * and `categories`, each unfiltered - every lifecycle state, every moderation state, deactivated
 * accounts included. So the honest fixture is the length of each stored collection, not a literal
 * beside it: written out by hand, `category_count` said three while four categories were stored, and
 * an overview screen asserting the tile against the taxonomy it also renders could not be right about
 * both.
 *
 * Deriving them also means adding a fixture cannot silently invalidate this object.
 */
export const fixtureAdminStats: AdminStats = {
  user_count: storedAccounts.length,
  post_count: fixturePosts.length,
  comment_count: fixtureComments.length,
  category_count: fixtureCategories.length,
};

/* -------------------------------------------------------------------------------------------------
 * Reading the request
 *
 * Everything a resolver needs about an incoming request is read through the helpers below. They are
 * total functions: a missing path parameter, an absent body, a body that is not JSON and a field of
 * the wrong type each yield `undefined` rather than throwing, so a component that sends something
 * unexpected produces a diagnosable response instead of an unhandled rejection inside msw.
 *
 * None of them uses `any`. The request body is read as `unknown` and narrowed, which is the honest
 * type for input that arrives over the wire, and which keeps the narrowing visible rather than
 * asserted.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Reduce a matched path parameter to a single decoded segment.
 *
 * msw types a parameter as a string or an array of them, because a pattern may bind a repeating
 * segment; every pattern here binds exactly one, so the first value is the value. Segments arrive
 * percent-encoded, because the typed wrappers compose paths with `encodeURIComponent`, and a
 * malformed encoding is returned verbatim rather than allowed to throw.
 */
function pathParam(value: string | readonly string[] | undefined): string {
  const raw = typeof value === 'string' ? value : (value?.[0] ?? '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/* -------------------------------------------------------------------------------------------------
 * The readers that used to live here are gone, and their absence is the point.
 *
 * `readJsonBody`, `asRecord`, `readJsonRecord`, `readString`, `readNullableString`,
 * `readStringArray`, `readPostStatus`, `readCommentStatus`, `readUserRole`, `readBoolean` and
 * `readFormField` all shared one signature: they answered `undefined` for anything they did not
 * like, and every call site paired that with `?? aDefault`. Deleting them rather than leaving them
 * unused is deliberate - a reader that cannot fail is the mechanism finding C10 names, and leaving
 * one available is leaving the next resolver free to reintroduce it.
 *
 * Their replacements sit further down, under "Request-body validation": the same reads, each
 * collecting the rejection FastAPI would have answered with instead of substituting a value the
 * caller never sent.
 * ---------------------------------------------------------------------------------------------- */

/**
 * What the request presented in `Authorization`, as three outcomes rather than two.
 *
 * `app.core.dependencies._bearer_token` separates exactly these cases, and the separation is the
 * whole reason it exists as its own dependency:
 *
 * - **`absent`** - no header at all. The only anonymous request there is.
 * - **`unusable`** - a header that is present and cannot be used: another scheme, a `Bearer` with
 *   nothing after it, or a raw token pasted with no scheme. The service answers **401** for all
 *   three, on the optional-authentication reads as much as on the protected ones.
 * - **`bearer`** - a syntactically usable credential. Whether it *names* an account is the next
 *   question, and {@link accountsByAccessToken} is where that is answered.
 *
 * Collapsing the first two into one value is the defect: a component holding a stale or malformed
 * credential would be served the public projection forever, with nothing in the response to tell it
 * the session had lapsed - which is precisely the signal `src/lib/api/client.ts` keys its
 * single-flight rotation on.
 */
type PresentedCredential =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unusable' }
  | { readonly kind: 'bearer'; readonly token: string };

const CREDENTIAL_ABSENT: PresentedCredential = { kind: 'absent' };
const CREDENTIAL_UNUSABLE: PresentedCredential = { kind: 'unusable' };

/**
 * Parse `Authorization` the way the service parses it, scheme name included.
 *
 * **The scheme match is case-insensitive**, because RFC 7235 declares `auth-scheme` case-insensitive
 * and the service honours that: it folds the parsed scheme with `.lower()` before comparing, so
 * `bearer`, `Bearer` and `BEARER` are one scheme. Matching `'Bearer '` by prefix, as this module did,
 * made a client that spelled it unconventionally look anonymous rather than authenticated.
 *
 * The split is on the FIRST space, matching `fastapi.security.utils.get_authorization_scheme_param`,
 * which yields `("", "")` for a value with no space in it - so a raw token with no scheme is
 * `unusable` rather than treated as the credential itself.
 */
function presentedCredential(request: Request): PresentedCredential {
  const header = request.headers.get(AUTHORIZATION_HEADER);
  if (header === null) {
    return CREDENTIAL_ABSENT;
  }
  const separator = header.indexOf(' ');
  if (separator === -1) {
    return CREDENTIAL_UNUSABLE;
  }
  const scheme = header.slice(0, separator);
  const token = header.slice(separator + 1).trim();
  if (scheme.toLowerCase() !== BEARER_SCHEME || token === '') {
    return CREDENTIAL_UNUSABLE;
  }
  return { kind: 'bearer', token };
}

/**
 * Which account a presented access token names. A token absent from this map names nobody.
 *
 * **Each rotated token names the account that rotated it**, never a single shared principal: a
 * rotation replaces the credential and leaves the identity where it was, so a reader who refreshes
 * and then calls `GET /auth/me` must still be the reader.
 */
const accountsByAccessToken: ReadonlyMap<string, UserMe> = new Map([
  [FIXTURE_AUTHOR_ACCESS_TOKEN, fixtureAuthorAccount],
  [FIXTURE_READER_ACCESS_TOKEN, fixtureReaderAccount],
  [FIXTURE_ADMIN_ACCESS_TOKEN, fixtureAdminAccount],
  [FIXTURE_ROTATED_ACCESS_TOKEN, fixtureAuthorAccount],
  [FIXTURE_READER_ROTATED_ACCESS_TOKEN, fixtureReaderAccount],
  [FIXTURE_ADMIN_ROTATED_ACCESS_TOKEN, fixtureAdminAccount],
  [FIXTURE_SUSPENDED_ACCESS_TOKEN, fixtureSuspendedAccount],
]);

/** Which pair signing in with a given address yields. An address absent from this map is unknown. */
const tokenPairsByEmail: ReadonlyMap<string, TokenPair> = new Map([
  [fixtureAuthorAccount.email, fixtureTokenPair],
  [fixtureReaderAccount.email, fixtureReaderTokenPair],
  [fixtureAdminAccount.email, fixtureAdminTokenPair],
]);

/**
 * Every refresh token this module has issued, so an unissued one can be refused.
 *
 * Each rotated refresh token is here too, mapped to the same account as the token it replaced, which
 * is what makes a second rotation by the same principal answerable rather than a 401.
 *
 * The suspended account's token is present **on purpose**: it is the only way to reach the refusal
 * `rotate_refresh_token` gives a token whose owner is no longer usable, and that refusal is a 401
 * like every other - see {@link FIXTURE_SUSPENDED_REFRESH_TOKEN}.
 */
const accountsByRefreshToken: ReadonlyMap<string, UserMe> = new Map([
  [fixtureTokenPair.refresh_token, fixtureAuthorAccount],
  [fixtureReaderTokenPair.refresh_token, fixtureReaderAccount],
  [fixtureAdminTokenPair.refresh_token, fixtureAdminAccount],
  [fixtureRotatedTokenPair.refresh_token, fixtureAuthorAccount],
  [fixtureReaderRotatedTokenPair.refresh_token, fixtureReaderAccount],
  [fixtureAdminRotatedTokenPair.refresh_token, fixtureAdminAccount],
  [FIXTURE_SUSPENDED_REFRESH_TOKEN, fixtureSuspendedAccount],
]);

/**
 * The pair each principal receives when it rotates, keyed by account.
 *
 * The account comes from {@link accountsByRefreshToken} - the presented token decides whose rotation
 * this is - and this map decides what that principal gets back. An account absent from it has no
 * rotation fixture, which the resolver reports as a 401 rather than substituting somebody else's
 * pair; the suspended account is deliberately absent, because its refusal comes first anyway.
 */
const rotatedPairsByAccountId: ReadonlyMap<string, TokenPair> = new Map([
  [USER_ID_AUTHOR, fixtureRotatedTokenPair],
  [USER_ID_READER, fixtureReaderRotatedTokenPair],
  [USER_ID_ADMIN, fixtureAdminRotatedTokenPair],
]);

/**
 * Resolve the calling principal where authentication is OPTIONAL - in three outcomes, not two.
 *
 * `get_current_user_optional` treats the three kinds of request asymmetrically, and this function
 * reproduces that asymmetry exactly:
 *
 * - **`undefined` - anonymous.** Reached by a request with **no `Authorization` header**, and by a
 *   usable credential naming a **deactivated** account. The second is the contract's own rule rather
 *   than a simplification: the operation is public, so a suspended reader may still read what anyone
 *   with no account reads, and narrowing them to anonymous *before the value leaves this function* is
 *   what stops a suspended author being shown their own drafts by `canViewPost`.
 * - **a `Response` - 401.** Reached by a credential that is present and cannot be used: a scheme
 *   other than `Bearer`, an empty `Bearer`, a raw token with no scheme, or a token that names no
 *   account. **This is not quietly downgraded to anonymous**, and that is the finding: the client
 *   owns refresh-on-401, so a 401 is the signal that makes it rotate and retry. Swallowing it leaves
 *   a reader holding a lapsed token, permanently served the public projection, with no route to
 *   recovering the session - and every spec asserting that a bogus or stale credential is refused
 *   would receive a success shape and pass.
 * - **the account** - a usable credential for an active account.
 *
 * Callers narrow with {@link isRefusal} and return the refusal, exactly as they do for
 * {@link authenticate}. Where authentication is REQUIRED, use that instead: the deactivated case
 * stops being anonymous there and earns 403.
 */
function optionalPrincipal(request: Request): UserMe | Response | undefined {
  const credential = presentedCredential(request);
  if (credential.kind === 'absent') {
    return undefined;
  }
  if (credential.kind === 'unusable') {
    return unauthorized(request);
  }
  const account = accountsByAccessToken.get(credential.token);
  if (account === undefined) {
    return unauthorized(request);
  }
  // Narrowed to anonymous BEFORE the value leaves this function, so no visibility predicate
  // downstream can be handed an inactive principal even by mistake.
  return account.is_active ? account : undefined;
}

/**
 * Resolve the calling principal where authentication is REQUIRED, or the refusal to answer with.
 *
 * Three outcomes, and each is a different statement to a client:
 *
 * - **401 with `WWW-Authenticate: Bearer`** - no credential, or one that names nobody. Retrying with
 *   a fresh token can help, which is precisely why `src/lib/api/client.ts` keys its single-flight
 *   rotation on this status.
 * - **403** - the credential is genuine and the account is deactivated. No token can fix it, so a
 *   client must *not* rotate; the detail is the same sentence `get_current_active_user` sends.
 * - the account itself.
 *
 * Returned as a union with `Response` rather than through an out-parameter or a thrown value so that
 * a resolver reads as `const principal = authenticate(request); if (isRefusal(principal)) return
 * principal;` - one line that cannot be forgotten silently, because the following line would not
 * type-check without it.
 */
function authenticate(request: Request): UserMe | Response {
  const credential = presentedCredential(request);
  // An absent header and an unusable one answer identically here - which check failed is not a
  // caller's business - but they are still parsed apart, because `optionalPrincipal` needs the
  // distinction and both resolvers read the same parse.
  if (credential.kind !== 'bearer') {
    return unauthorized(request);
  }
  const account = accountsByAccessToken.get(credential.token);
  if (account === undefined) {
    return unauthorized(request);
  }
  if (!account.is_active) {
    return forbidden(request, DEACTIVATED_ACCOUNT_DETAIL);
  }
  return account;
}

/**
 * Resolve the calling principal where **administrative authority** is required, or the refusal.
 *
 * `require_admin` is mounted on the whole `/admin` router, so every operation beneath it is gated
 * identically: 401 for an absent or unrecognised credential, 403 for a deactivated account, and 403
 * for an active `READER` or `AUTHOR`. The last of those is the one the default handler set used to
 * omit - it checked only that *some* bearer was present - so every administrative screen's test
 * passed while presenting a reader's credential, and the server-side half of the gate that AAP
 * §0.10.1 #6 requires was untested by construction.
 *
 * The 403 says only that permission is lacking, never which role would suffice.
 */
function authenticateAdmin(request: Request): UserMe | Response {
  const principal = authenticate(request);
  if (isRefusal(principal)) {
    return principal;
  }
  if (principal.role !== ADMIN_ROLE) {
    return forbidden(request, 'This operation is restricted to administrators.');
  }
  return principal;
}

/**
 * Narrow an authentication outcome to the refusal half.
 *
 * Accepts `undefined` as well as an account, so the one predicate serves both {@link authenticate}
 * and {@link optionalPrincipal} - and so an optional-authentication resolver cannot forget the
 * refusal branch: the anonymous value survives the narrowing and the refusal does not.
 */
function isRefusal(outcome: UserMe | Response | undefined): outcome is Response {
  return outcome instanceof Response;
}

/** The `instance` a problem document reports: the path the caller addressed. */
function requestInstance(request: Request): string {
  return new URL(request.url).pathname;
}

/** The query string of the request, as a read-only view. */
function searchParams(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

/** Read a query parameter, treating an absent or blank value as unset. */
function readQuery(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key);
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The strict query readers, and why the lenient ones below them are not enough.
 *
 * A query parameter declared as an enum, a `bool` or a `uuid.UUID` is validated by Pydantic before a
 * route function is entered, so a value outside the type is a **422 naming the parameter** - not a
 * filter that was accepted and then quietly dropped. The readers immediately below answer `undefined`
 * for anything they do not recognise, and `undefined` at a call site means "no filter", so
 * `?status=PUBLSIHED` returned the unfiltered listing with a 200 and `?is_active=maybe` returned every
 * account. A component that builds one of those values from a control had no way to observe its own
 * typo.
 *
 * These three collect the rejection instead, in Pydantic's own `type`/`message` vocabulary, so a
 * consumer switching on `ValidationErrorItem.type` behaves under test as it will in production.
 */

/** Render a closed set the way Pydantic renders it in an `enum` message: `'A', 'B' or 'C'`. */
function describeAllowed(allowed: readonly string[]): string {
  const quoted = allowed.map((member) => `'${member}'`);
  const last = quoted[quoted.length - 1];
  if (last === undefined) {
    return '';
  }
  return quoted.length === 1 ? last : `${quoted.slice(0, -1).join(', ')} or ${last}`;
}

/** Read a query parameter constrained to a closed set, collecting the 422 an outsider earns. */
function readQueryEnum<T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly T[],
  errors: ValidationErrorItem[],
): T | undefined {
  const value = readQuery(params, key);
  if (value === undefined) {
    return undefined;
  }
  const member = allowed.find((candidate) => candidate === value);
  if (member === undefined) {
    errors.push({
      field: key,
      message: `Input should be ${describeAllowed(allowed)}`,
      type: 'enum',
    });
    return undefined;
  }
  return member;
}

/**
 * The strings Pydantic's lax boolean mode accepts, folded to lower case.
 *
 * Restated from Pydantic's own set rather than narrowed to `true`/`false`, because a query parameter
 * is a string and `?mine=1` is a request this API answers. Anything outside the set is
 * `bool_parsing`.
 */
const TRUE_LITERALS: readonly string[] = ['1', 'on', 't', 'true', 'y', 'yes'];
const FALSE_LITERALS: readonly string[] = ['0', 'off', 'f', 'false', 'n', 'no'];

/** Read a boolean query parameter as Pydantic reads one, collecting the 422 a non-boolean earns. */
function readQueryBooleanStrict(
  params: URLSearchParams,
  key: string,
  errors: ValidationErrorItem[],
): boolean | undefined {
  const value = readQuery(params, key);
  if (value === undefined) {
    return undefined;
  }
  const folded = value.toLowerCase();
  if (TRUE_LITERALS.includes(folded)) {
    return true;
  }
  if (FALSE_LITERALS.includes(folded)) {
    return false;
  }
  errors.push({
    field: key,
    message: 'Input should be a valid boolean, unable to interpret input',
    type: 'bool_parsing',
  });
  return undefined;
}

/**
 * Read a `uuid.UUID` query parameter, collecting the 422 a malformed identifier earns.
 *
 * `author_id` on the administrative post listing and `post_id` on the moderation queue are both
 * `uuid.UUID | None`, so a value that is not one is refused before anything is filtered - not read as
 * "no filter", which answered the whole unfiltered listing to a caller who had asked for one row's
 * worth of it.
 */
function readQueryUuid(
  params: URLSearchParams,
  key: string,
  errors: ValidationErrorItem[],
): string | undefined {
  const value = readQuery(params, key);
  if (value === undefined) {
    return undefined;
  }
  if (!UUID_PATTERN.test(value)) {
    errors.push({
      field: key,
      message: 'Input should be a valid UUID, invalid character',
      type: 'uuid_parsing',
    });
    return undefined;
  }
  return value;
}

/* -------------------------------------------------------------------------------------------------
 * Building the response
 *
 * Two builders and one envelope. `problem` is the only way a failure leaves this module, which is
 * what makes the error contract a single declaration rather than a shape repeated per call site;
 * `paginate` is the only way a collection leaves it, which is what keeps the five-field envelope
 * identical across the feed, the profile listing and every administrative table, so the one shared
 * pagination component behaves under test exactly as it behaves in production.
 * ---------------------------------------------------------------------------------------------- */

/** A field-level validation failure, as the `errors` member of a 422 problem document carries it. */
type ValidationErrors = [ValidationErrorItem, ...ValidationErrorItem[]];

/**
 * The outcome of reading something out of a request: the value, or the rejection to answer with.
 *
 * Used instead of "read it and substitute a default", which is the shape this module was written in
 * and the root of finding C10: a reader that cannot fail turns an absent member, a wrong type, a
 * malformed body and a value outside its bounds all into a *successful* request carrying a plausible
 * substitute. Every 422 in this API then became unreachable under test, and the mock disagreed with
 * the service on precisely the inputs a form is most likely to send.
 */
type Resolved<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: ValidationErrors };

/** Collapse a collected error list into a `Resolved` rejection, or the value when it is empty. */
function resolved<T>(value: T, errors: readonly ValidationErrorItem[]): Resolved<T> {
  const [first, ...rest] = errors;
  return first === undefined ? { ok: true, value } : { ok: false, errors: [first, ...rest] };
}

interface ProblemOptions {
  /** HTTP status, and the `status` member of the document; the two are always the same number. */
  readonly status: number;
  /** Stable machine-readable reference from the service's closed `/errors/...` set. */
  readonly type: string;
  /** Short human-readable summary, stable for the status. */
  readonly title: string;
  /** What went wrong on this occasion. */
  readonly detail: string;
  /** The path addressed, so a caller can tell which request a document belongs to. */
  readonly instance: string;
  /** Field-level failures. Present on 422 and absent otherwise. */
  readonly errors?: ValidationErrors;
  /** Extra response headers - `WWW-Authenticate` on a 401, `Retry-After` on a 429. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Build the one problem document every failure in this module answers with.
 *
 * `request_id` is populated deliberately: `src/lib/api/client.ts` accepts a problem body only when
 * every member including that one is present and correctly typed, and silently substitutes a
 * synthesised document otherwise - so a mock that omitted it would quietly stop testing the
 * normalisation path it exists to test.
 *
 * Declared as returning `Response` rather than `HttpResponse<ProblemDetail>`, as are the four
 * builders beneath it. That is not laziness about the type: a resolver that can answer either a
 * resource or a problem returns a union, and msw infers its single `ResponseBodyType` parameter from
 * that union - so a narrower annotation here would make every guarded handler in this module fail to
 * compile with an error about the *success* shape. The body stays fully checked, because every call
 * site passes a value already annotated against its contract type.
 */
function problem(options: ProblemOptions): Response {
  const document: ProblemDetail = {
    type: options.type,
    title: options.title,
    status: options.status,
    detail: options.detail,
    instance: options.instance,
    request_id: FIXTURE_REQUEST_ID,
  };
  const body: ProblemDetail =
    options.errors === undefined ? document : { ...document, errors: options.errors };
  // `HttpResponse.json` would set `application/json`, and the service sets
  // `application/problem+json` on every failure - so the body is serialised here and the header set
  // explicitly. The difference is not cosmetic: `src/lib/api/client.ts` sends
  // `Accept: application/json, application/problem+json` and a mock that never produced the second
  // half was reproducing a wire this service does not speak, leaving any assertion about the media
  // type - present or future, here or in a consumer - asserting a fiction.
  return new HttpResponse(JSON.stringify(body), {
    status: options.status,
    headers: {
      [CONTENT_TYPE_HEADER]: PROBLEM_JSON_MEDIA_TYPE,
      [REQUEST_ID_HEADER]: FIXTURE_REQUEST_ID,
      ...options.headers,
    },
  });
}

/**
 * A 422 carrying a populated per-field error list, which is the only form of it the service sends.
 *
 * Every request-validation refusal in this module goes through here rather than composing a document
 * of its own, so the `errors` array is never empty and never absent - `ApiError.errors` treats
 * `undefined` as the single no-errors state, so a 422 without entries tells a form nothing about
 * which control to mark.
 */
function validationProblem(request: Request, errors: ValidationErrors, detail?: string): Response {
  return problem({
    status: HTTP_UNPROCESSABLE_CONTENT,
    type: ERROR_TYPE_VALIDATION,
    title: ERROR_TITLE_VALIDATION,
    detail: detail ?? 'The request payload failed validation.',
    instance: requestInstance(request),
    errors,
  });
}

/** A 409, for the two conflicts this API reports: a taken identity and a category still in use. */
function conflict(request: Request, detail: string): Response {
  return problem({
    status: HTTP_CONFLICT,
    type: ERROR_TYPE_CONFLICT,
    title: ERROR_TITLE_CONFLICT,
    detail,
    instance: requestInstance(request),
  });
}

/** 401 for a protected route addressed without a credential, with the challenge header set. */
function unauthorized(request: Request): Response {
  return problem({
    status: HTTP_UNAUTHORIZED,
    type: ERROR_TYPE_UNAUTHORIZED,
    title: ERROR_TITLE_UNAUTHORIZED,
    detail: 'This operation requires an authenticated principal. Present a bearer access token.',
    instance: requestInstance(request),
    headers: { [WWW_AUTHENTICATE_HEADER]: WWW_AUTHENTICATE_BEARER },
  });
}

/**
 * 422 for one of the feed's two mode rules: `status` without `mine`, or `author` with it.
 *
 * Carries the same populated `errors` list the service does, keyed on the offending parameter, so a
 * form or a hook can attach the message to the control that produced it.
 */
function feedModeProblem(request: Request, field: string, detail: string): Response {
  return problem({
    status: HTTP_UNPROCESSABLE_CONTENT,
    type: ERROR_TYPE_VALIDATION,
    title: ERROR_TITLE_VALIDATION,
    detail: `\`${field}\` is not accepted in this mode.`,
    instance: requestInstance(request),
    errors: [{ field, message: detail, type: 'value_error' }],
  });
}

/** 403 for a credential that is valid but insufficient. */
function forbidden(request: Request, detail: string): Response {
  return problem({
    status: HTTP_FORBIDDEN,
    type: ERROR_TYPE_FORBIDDEN,
    title: ERROR_TITLE_FORBIDDEN,
    detail,
    instance: requestInstance(request),
  });
}

/** 404 for a resource the fixtures do not hold, or one the caller may not know exists. */
function notFound(request: Request, detail: string): Response {
  return problem({
    status: HTTP_NOT_FOUND,
    type: ERROR_TYPE_NOT_FOUND,
    title: ERROR_TITLE_NOT_FOUND,
    detail,
    instance: requestInstance(request),
  });
}

/**
 * A 204 answer. The body is null, because a 204 that carries one is not a valid response.
 *
 * The correlation header is set here as well, and that is the correction rather than a flourish:
 * `app.middleware.request_context` stamps `X-Request-ID` on **every** response, a 204 included, and
 * `src/lib/api/client.ts` reads it off the 204 path too. A 204 without it produced an empty
 * `requestId` for exactly the operations - sign out, delete a post, delete a comment, delete an
 * account - whose failures are hardest to reconstruct without one.
 */
function noContent(): Response {
  return new HttpResponse(null, {
    status: HTTP_NO_CONTENT,
    headers: { [REQUEST_ID_HEADER]: FIXTURE_REQUEST_ID },
  });
}

/** A 200 answer carrying a resource representation and the correlation header. */
function ok<T extends object>(body: T): Response {
  return HttpResponse.json(body, {
    status: HTTP_OK,
    headers: { [REQUEST_ID_HEADER]: FIXTURE_REQUEST_ID },
  });
}

/** A 201 answer carrying the created representation. */
function created<T extends object>(body: T): Response {
  return HttpResponse.json(body, {
    status: HTTP_CREATED,
    headers: { [REQUEST_ID_HEADER]: FIXTURE_REQUEST_ID },
  });
}

/** A resolved page request: which window of a collection the caller asked for. */
interface PageRequest {
  readonly page: number;
  readonly pageSize: number;
}

/**
 * Resolve `page` and `page_size` from the query string, or report why they cannot be resolved.
 *
 * **`app.core.dependencies.PageParams` VALIDATES; it does not normalise.** The two parameters are
 * declared as `Query(ge=1)` and `Query(ge=1, le=100)`, so FastAPI refuses an out-of-range or
 * non-numeric value at the request boundary with a 422 naming the parameter - and
 * `@/lib/types` states the same contract in as many words: "an out-of-range value is **rejected**,
 * not corrected - `?page_size=1000` and `?page_size=0` each answer 422."
 *
 * This function used to fall back to the default in every one of those cases. The consequence was
 * not a small infidelity: `?page_size=0`, `?page_size=1000` and `?page_size=abc` all became
 * successful requests under test, so a caller's 422 branch was unreachable, and a component that
 * built an out-of-range window would have passed its tests and failed in production.
 *
 * A page number *past the last page* is a different matter and is still honoured: it is in range, it
 * is a legitimate request, and its answer is an empty window rather than an error.
 *
 * The `type` on each reported entry is the validator pydantic actually names - `int_parsing` for a
 * value that is not a whole number, `greater_than_equal` and `less_than_equal` for the bounds - so a
 * consumer switching on `ValidationErrorItem.type` sees under test what it will see in production.
 */
function readPageRequest(params: URLSearchParams): Resolved<PageRequest> {
  const errors: ValidationErrorItem[] = [];
  const page = readBoundedInteger(readQuery(params, 'page'), {
    field: 'page',
    minimum: FIRST_PAGE,
    fallback: FIRST_PAGE,
    errors,
  });
  const pageSize = readBoundedInteger(readQuery(params, 'page_size'), {
    field: 'page_size',
    minimum: MIN_PAGE_SIZE,
    maximum: MAX_PAGE_SIZE,
    fallback: DEFAULT_PAGE_SIZE,
    errors,
  });
  return resolved({ page, pageSize }, errors);
}

/** Where a bounded query integer is read from, and where its rejection is collected. */
interface BoundedInteger {
  /** The query parameter's name, as it appears in a `ValidationErrorItem.field`. */
  readonly field: string;
  /** Smallest accepted value. */
  readonly minimum: number;
  /** Largest accepted value, or absent when the parameter is bounded below only. */
  readonly maximum?: number;
  /** The value used when the parameter is absent. */
  readonly fallback: number;
  /** Collector the rejection is appended to, so both parameters are reported from one request. */
  readonly errors: ValidationErrorItem[];
}

/**
 * Read one bounded query integer, appending a rejection rather than throwing or defaulting.
 *
 * Both parameters are read before either is reported, because FastAPI validates the whole request
 * and answers with **every** field it rejected - a form that highlighted only the first one would be
 * built against a document this API does not send.
 */
function readBoundedInteger(raw: string | undefined, options: BoundedInteger): number {
  if (raw === undefined) {
    return options.fallback;
  }
  if (!/^-?\d+$/.test(raw.trim())) {
    options.errors.push({
      field: options.field,
      message: 'Input should be a valid integer, unable to parse string as an integer',
      type: 'int_parsing',
    });
    return options.fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(parsed)) {
    options.errors.push({
      field: options.field,
      message: 'Input should be a valid integer',
      type: 'int_parsing',
    });
    return options.fallback;
  }
  if (parsed < options.minimum) {
    options.errors.push({
      field: options.field,
      message: `Input should be greater than or equal to ${String(options.minimum)}`,
      type: 'greater_than_equal',
    });
    return options.fallback;
  }
  if (options.maximum !== undefined && parsed > options.maximum) {
    options.errors.push({
      field: options.field,
      message: `Input should be less than or equal to ${String(options.maximum)}`,
      type: 'less_than_equal',
    });
    return options.fallback;
  }
  return parsed;
}

/**
 * Window a collection into the uniform five-field envelope.
 *
 * `pages` is zero for an empty collection rather than one, so a caller can distinguish "no results"
 * from "one page of results". A page beyond the last yields an empty `items` array while `total`
 * and `pages` continue to describe the whole collection, which is what lets a pagination control
 * stay rendered and offer a way back.
 */
function paginate<T>(rows: readonly T[], request: PageRequest): Page<T> {
  const total = rows.length;
  const start = (request.page - FIRST_PAGE) * request.pageSize;
  return {
    items: rows.slice(start, start + request.pageSize),
    total,
    page: request.page,
    page_size: request.pageSize,
    pages: total === 0 ? 0 : Math.ceil(total / request.pageSize),
  };
}

/**
 * Answer with a windowed collection, or with the 422 its window parameters earned.
 *
 * The single exit for every list route in this module, which is what makes the pagination contract -
 * the five-field envelope on success, a field-named 422 on a bad window - one declaration rather
 * than a shape and a refusal repeated eleven times.
 */
function pageResponse<T>(rows: readonly T[], request: Request): Response {
  const window = readPageRequest(searchParams(request));
  return window.ok ? ok(paginate(rows, window.value)) : validationProblem(request, window.errors);
}

/* -------------------------------------------------------------------------------------------------
 * Looking things up, and composing the feed
 *
 * The feed is the one query in the service with real composition in it - relevance ranking, a
 * category join, an author filter, status scoping, an ordering and a window, all in one statement -
 * and it is the one place a mock earns its keep by actually composing rather than by answering with
 * a fixed list. A search term that matches nothing must produce an empty page, a category filter
 * must subtract rows, and page two must be disjoint from page one, or the home-feed specs assert
 * against a constant and pass whatever the components do.
 * ---------------------------------------------------------------------------------------------- */

/** Locate an account by its handle. Handles are case-insensitive in the service's `citext` columns. */
function findAccountByUsername(username: string): UserMe | undefined {
  const wanted = username.trim().toLowerCase();
  return storedAccounts.find((account) => account.username.toLowerCase() === wanted);
}

/** Locate an account by its primary key. */
function findAccountById(userId: string): UserMe | undefined {
  return storedAccounts.find((account) => account.id === userId);
}

/** Locate a post by its slug, which is what a public URL addresses. */
function findPostBySlug(slug: string): PostDetail | undefined {
  const wanted = slug.trim().toLowerCase();
  return fixturePosts.find((post) => post.slug.toLowerCase() === wanted);
}

/** Locate a post by its primary key, which is what a mutation addresses. */
function findPostById(postId: string): PostDetail | undefined {
  return fixturePosts.find((post) => post.id === postId);
}

/** Locate a category by its slug. */
function findCategoryBySlug(slug: string): CategoryPublic | undefined {
  const wanted = slug.trim().toLowerCase();
  return fixtureCategories.find((category) => category.slug.toLowerCase() === wanted);
}

/** Locate a category by its primary key. */
function findCategoryById(categoryId: string): CategoryPublic | undefined {
  return fixtureCategories.find((category) => category.id === categoryId);
}

/** Locate a comment by its primary key, across roots and replies alike. */
function findCommentById(commentId: string): CommentPublic | undefined {
  return fixtureComments.find((comment) => comment.id === commentId);
}

/** Resolve submitted category identifiers to the slim projections a post embeds. */
function toCategorySummaries(categoryIds: readonly string[]): CategorySummary[] {
  const resolved: CategorySummary[] = [];
  for (const categoryId of categoryIds) {
    const category = findCategoryById(categoryId);
    if (category !== undefined) {
      resolved.push(toCategorySummary(category));
    }
  }
  return resolved;
}

/** Every post a reader may see: PUBLISHED only, so neither a draft nor an archived post leaks. */
function publiclyVisiblePosts(): readonly PostDetail[] {
  return fixturePosts.filter((post) => post.status === VISIBLE_POST_STATUS);
}

/**
 * Derive a URL-safe slug from a title, the way the service does at creation time.
 *
 * Applied on creation only. A slug is never re-derived on update, because a canonical URL that
 * changed when a title was corrected would invalidate every link and every crawl of the post.
 */
function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  );
}

/**
 * Derive a slug and step past any that is already taken, the way `app.core.slug.unique_slug` does.
 *
 * **A slug is unique by database constraint, so a creation route cannot answer with one that is
 * already in use** - and both create paths in this module did. Filing a second post or category whose
 * title derives an existing slug returned that same slug with a 201, which is a response the service
 * cannot produce: `PostService.create` and `CategoryService.create` read the slug family, hand it to
 * `unique_slug`, and take the first free suffix - `-2`, then `-3`, and so on. A component that built a
 * canonical URL from the answer was therefore handed one that resolves to somebody else's row.
 *
 * Deterministic and pure: the suffix depends only on the title and the taken set, both of which come
 * from the frozen fixtures, so the same request always answers the same slug and this module keeps the
 * statelessness `server.resetHandlers()` requires of it.
 *
 * @param title - The submitted title or name.
 * @param taken - Every slug already in the family's namespace.
 * @returns The first slug in the sequence `base`, `base-2`, `base-3`, ... that nothing holds.
 */
function allocateSlug(title: string, taken: readonly string[]): string {
  const base = slugify(title);
  const held = new Set(taken.map((slug) => slug.toLowerCase()));
  if (!held.has(base)) {
    return base;
  }
  // Bounded by the size of the taken set plus one: with N slugs held, one of the first N+1 candidates
  // is necessarily free, so this terminates without a guard on the loop.
  for (let suffix = 2; suffix <= held.size + 2; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`;
    if (!held.has(candidate)) {
      return candidate;
    }
  }
  return `${base}-${String(held.size + 2)}`;
}

/**
 * How strongly a post answers a search term.
 *
 * Weighted, because the service weights a title match above a body match with `setweight` before
 * ranking with `ts_rank`; a title hit therefore outranks an excerpt hit here too. Zero means the
 * post does not match at all and is excluded rather than ranked last.
 */
function relevanceScore(post: PostDetail, term: string): number {
  const needle = term.toLowerCase();
  const titleWeight = post.title.toLowerCase().includes(needle) ? 4 : 0;
  const excerptWeight = (post.excerpt ?? '').toLowerCase().includes(needle) ? 2 : 0;
  const contentWeight = post.content.toLowerCase().includes(needle) ? 1 : 0;
  return titleWeight + excerptWeight + contentWeight;
}

/**
 * Trigram similarity between a title and a term, approximating `pg_trgm`'s `similarity()`.
 *
 * The repository's ordering uses it as the SECOND key whenever a term is present - `similarity(title,
 * :term) DESC` - and it is the only key that meaningfully orders a row matched solely by the
 * typo-tolerant fallback, whose `ts_rank` against a query it does not satisfy is zero. Approximated
 * rather than reproduced exactly: this is the Jaccard ratio over the two trigram sets, which is the
 * shape `pg_trgm` computes, and it is enough to make "the closer title leads" observable without
 * claiming to be the extension's arithmetic to the digit.
 */
function trigramSimilarity(title: string, term: string): number {
  const trigrams = (value: string): ReadonlySet<string> => {
    const padded = `  ${value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()} `;
    const found = new Set<string>();
    for (let index = 0; index + 3 <= padded.length; index += 1) {
      found.add(padded.slice(index, index + 3));
    }
    return found;
  };
  const left = trigrams(title);
  const right = trigrams(term);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const gram of right) {
    if (left.has(gram)) {
      shared += 1;
    }
  }
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * The tiebreaker every listing in the service ends on: `posts.id` **descending**.
 *
 * Not decoration, and not interchangeable with any other tiebreaker. `published_at` is not unique - a
 * seed run or a bulk publish stamps many rows from one transaction clock - and neither is a rank, so
 * without a *total* order two rows with equal keys can be returned by both page one and page two
 * while a third is returned by neither. The primary key breaks every remaining tie, which is what
 * makes page two provably disjoint from page one.
 */
function byIdDescending(left: PostDetail, right: PostDetail): number {
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? 1 : -1;
}

/**
 * Recency ordering: newest publication first, falling back to creation for an unpublished post.
 *
 * The fallback stands in for `NULLS LAST` on `published_at`, which the repository applies only when a
 * listing admits drafts. It does **not** tiebreak on the title: `_build_ordering` has no title clause
 * anywhere, so ordering two rows that share a publication instant alphabetically invented a sequence
 * the service cannot produce - and one that is stable, which made the overlapping-pagination defect
 * the real tiebreaker exists to prevent impossible to observe.
 */
function byRecency(left: PostDetail, right: PostDetail): number {
  const leftAt = left.published_at ?? left.created_at;
  const rightAt = right.published_at ?? right.created_at;
  if (leftAt === rightAt) {
    return byIdDescending(left, right);
  }
  return leftAt < rightAt ? 1 : -1;
}

/**
 * The ordering a searched listing gets, as `_build_ordering` composes it.
 *
 * Two clause lists, chosen by the requested sort, and both of them end on the primary key:
 *
 * - `relevance` → **rank, similarity, recency, id**. Best match first, ties broken by how close the
 *   title is, then by recency.
 * - `recent` → **recency, rank, similarity, id**. Newest first, with rank and similarity deciding
 *   only between posts that share a publication instant.
 *
 * **`view_count` appears in neither, and that is the correction.** Nothing in this product advances
 * that column and the plan states outright that there is deliberately no `"popular"` sort, so ranking
 * ties by engagement invented an ordering the service has no equivalent of - and it did so in the one
 * place a home-feed spec would read as authoritative.
 *
 * Only ever applied WITH a term - see {@link resolveFeedSort} - because with nothing to rank against
 * every post scores zero and the sequence would collapse onto the tiebreakers alone.
 */
function byTermOrdering(term: string, sort: FeedSort) {
  return (left: PostDetail, right: PostDetail): number => {
    const rank = relevanceScore(right, term) - relevanceScore(left, term);
    const similarity = trigramSimilarity(right.title, term) - trigramSimilarity(left.title, term);
    const recency = byRecency(left, right);

    const clauses =
      sort === 'relevance' ? [rank, similarity, recency] : [recency, rank, similarity];
    for (const clause of clauses) {
      if (clause !== 0) {
        return clause;
      }
    }
    return byIdDescending(left, right);
  };
}

/** The two orderings the feed offers, spelled as the wire spells them. */
type FeedSort = 'recent' | 'relevance';

/**
 * The ordering the service would apply, from the term and the requested sort together.
 *
 * TWO service rules, and the mock had each of them backwards.
 *
 * 1. **Omitting `sort` is not the same as sending `recent`.** `post_service._default_sort_for`
 *    returns `"relevance"` when a term is present and `"recent"` otherwise, and the route passes
 *    `sort=None` when the caller expressed no preference - so the default follows what the caller
 *    DID, not a fixed value. A search with no explicit sort ranks by relevance; a browse with no
 *    explicit sort leads with the newest post. Ordering a searched page by recency, as this mock did,
 *    made a relevance-ranked feed impossible to observe without the caller opting in explicitly -
 *    which the home feed does not do.
 * 2. **`relevance` with no term degrades to recency.** `PostRepository` takes its ranking branch on
 *    the PRESENCE OF THE TERM rather than on the requested sort, because `ts_rank` against an empty
 *    query ranks nothing. `?sort=relevance` with an empty search box therefore returns the newest
 *    posts rather than raising. Ranking by engagement instead, as this mock did, invented an ordering
 *    the service has no equivalent of - and the plan states outright that there is deliberately no
 *    `"popular"` sort, precisely because nothing in the product advances `view_count`.
 *
 * @param term - The search term, or `undefined` when none was supplied.
 * @param requested - The `sort` parameter as sent, or `undefined` when it was omitted.
 * @returns The ordering to apply.
 */
function resolveFeedSort(term: string | undefined, requested: string | undefined): FeedSort {
  if (term === undefined) {
    // Rule 2: nothing to rank against, whatever was asked for.
    return 'recent';
  }
  // Rule 1: a term with no explicit sort is a search, and a search is ranked.
  return requested === 'recent' ? 'recent' : 'relevance';
}

/** The filters and ordering the feed composes, as read from the query string. */
interface FeedQuery {
  readonly term: string | undefined;
  readonly categorySlug: string | undefined;
  readonly authorUsername: string | undefined;
  readonly sort: FeedSort;
  /**
   * The private author workspace, or `undefined` for the public feed.
   *
   * Carries the principal's username rather than a flag, because the workspace's scope *is* the
   * principal: modelling it as a boolean would leave the handler free to read `author` instead,
   * which is the widening the service refuses.
   */
  readonly ownedBy: string | undefined;
  /** The lifecycle state the workspace is narrowed to, parsed against the closed set. */
  readonly status: PostStatus | undefined;
}

/**
 * Read the feed's own parameters, leaving `page` and `page_size` to `readPageRequest`.
 *
 * **Every one of them is a typed parameter, so every one of them can be a 422.** Three were being
 * read as raw strings and compared, which meant a value outside the type became a *filter that was
 * silently not applied*:
 *
 * - `sort` is `Literal["recent", "relevance"]`. A third value is a 422 naming the parameter, not a
 *   quiet fall back to recency - a typo in an ordering control produced a perfectly ordered page and
 *   no signal at all.
 * - `mine` is `bool`. `?mine=maybe` is `bool_parsing`, **not** the public feed: answering the public
 *   feed to a workspace request is exactly the substitution the route refuses for a missing
 *   credential, and it looks to an author like their drafts were deleted.
 * - `status` is `PostStatus | None`. `?status=PUBLSIHED` is `enum`, not "every state" and not an
 *   empty page: an empty page reads as "you have no drafts", which is a different and untrue answer.
 *
 * `mine` is resolved to the principal's username rather than kept as a flag, because the workspace's
 * scope *is* the principal - see {@link FeedQuery.ownedBy}. The caller has already established that a
 * credential was presented, so `principal` is only ever `undefined` here when `mine` is false.
 */
function readFeedQuery(
  params: URLSearchParams,
  principal: UserMe | undefined,
): Resolved<FeedQuery> {
  const errors: ValidationErrorItem[] = [];
  const sort = readQuery(params, 'sort');
  if (sort !== undefined && !POST_SORT_OPTIONS.includes(sort)) {
    errors.push({
      field: 'sort',
      message: `Input should be ${describeAllowed(POST_SORT_OPTIONS)}`,
      type: 'literal_error',
    });
  }
  const term = readQuery(params, 'q');
  const wantsOwn = readQueryBooleanStrict(params, 'mine', errors);
  const status = readQueryEnum(params, 'status', POST_STATUS_VALUES, errors);
  // The window is read here as well, so ONE request reports every parameter it got wrong: FastAPI
  // validates the whole request and answers with each rejected field, and a caller that sent both a
  // bad `sort` and a bad `page` must not have to fix them one round trip at a time. `pageResponse`
  // re-reads the same two values when it windows the result, which is a pure read of the same query
  // string and cannot disagree with this one.
  const pageWindow = readPageRequest(params);
  if (!pageWindow.ok) {
    errors.push(...pageWindow.errors);
  }
  return resolved(
    {
      term,
      categorySlug: readQuery(params, 'category'),
      authorUsername: readQuery(params, 'author'),
      // The ordering is DERIVED rather than read: `resolveFeedSort` reproduces the service's two
      // rules (an omitted `sort` follows the presence of a term, and `relevance` with no term
      // degrades to recency), while the check above keeps an unrecognised value a 422 rather than a
      // silent fall back to recency.
      sort: resolveFeedSort(term, sort),
      ownedBy: wantsOwn === true ? principal?.username : undefined,
      status,
    },
    errors,
  );
}

/**
 * Compose the feed: scope to what this caller asked for, filter, then order.
 *
 * Filtering precedes ordering because ranking a row that the filter removes would change nothing
 * and cost something - and because `total` must count what survives the filter, not what survives
 * the ranking.
 *
 * **There are exactly two scopes, and no viewer widens either of them.**
 *
 * - The **public feed** is `status = PUBLISHED` for every caller - anonymous, reader, author and
 *   administrator alike. `?author=<self>` does not widen it: an author asking the public feed for
 *   their own posts is answered with their published ones, because one URL is one result set. The
 *   route's own description says so, and a draft appears here for nobody.
 * - The **workspace**, reached only by `mine=true` with a credential, replaces that scope outright:
 *   every lifecycle state, but only the principal's own rows, narrowed further by `status` when it
 *   was sent.
 *
 * @param query - The parsed parameters.
 * @param scopedAuthor - The account `?author=` named, when it named one this module knows.
 */
function composeFeed(query: FeedQuery, scopedAuthor: UserMe | undefined): readonly PostDetail[] {
  // The workspace scope replaces the public one outright: every lifecycle state, but only the
  // principal's own rows. The public branch is published-only for EVERY caller - an administrator
  // and an author included - which is why there is no credential test on it at all.
  const owner = query.ownedBy?.toLowerCase();
  let rows =
    owner === undefined
      ? publiclyVisiblePosts()
      : fixturePosts.filter(
          (post) =>
            post.author.username.toLowerCase() === owner &&
            (query.status === undefined || post.status === query.status),
        );
  const term = query.term;
  if (term !== undefined) {
    rows = rows.filter((post) => relevanceScore(post, term) > 0);
  }
  const categorySlug = query.categorySlug?.toLowerCase();
  if (categorySlug !== undefined) {
    rows = rows.filter((post) =>
      post.categories.some((category) => category.slug.toLowerCase() === categorySlug),
    );
  }
  if (scopedAuthor !== undefined) {
    rows = rows.filter((post) => post.author.username === scopedAuthor.username);
  }
  // With a term, both orderings are the repository's four-clause lists; with none, recency then the
  // primary key. `sort` is already resolved against the presence of the term by `resolveFeedSort`, so
  // there is no `relevance`-with-no-term branch left to take here.
  return [...rows].sort(term === undefined ? byRecency : byTermOrdering(term, query.sort));
}

/**
 * The like state of a post as the calling principal sees it.
 *
 * The count is a property of the post and the flag a property of the caller, which is exactly why
 * the contract carries both: an anonymous reader still sees how many people liked something.
 *
 * **The flag is now resolved per principal**, from {@link likedByAccountId}, rather than from the mere
 * presence of a credential - and the count moves with it, so a caller who had not liked a post sees
 * the number rise by one when they do and stay there when they repeat the request. That pairing is
 * the whole of what makes a like idempotent from a client's point of view, and asserting it was
 * impossible while the mock reported the same two values whoever asked and whatever they did.
 *
 * @param postId - The post being reported on.
 * @param viewer - The calling principal, or `undefined` for an anonymous reader.
 * @param transition - `true` after a like, `false` after an unlike, `undefined` for a plain read.
 */
function likeSummaryFor(
  postId: string,
  viewer: UserMe | undefined,
  transition: boolean | undefined,
): LikeSummary {
  const stored = likeCountsByPostId.get(postId) ?? UNKNOWN_POST_LIKE_COUNT;
  const alreadyLiked =
    viewer !== undefined && (likedByAccountId.get(postId) ?? []).includes(viewer.id);
  if (transition === undefined) {
    return { post_id: postId, like_count: stored, liked_by_caller: alreadyLiked };
  }
  const delta = transition ? (alreadyLiked ? 0 : 1) : alreadyLiked ? -1 : 0;
  return {
    post_id: postId,
    like_count: stored + delta,
    liked_by_caller: transition,
  };
}

/**
 * Which moderation states *viewer* may see in the thread on *post*.
 *
 * `comment_service._visible_comment_statuses`, exactly: **every** state for an administrator and for
 * the post's own author, and the public state alone for everyone else - an authenticated reader on
 * somebody else's post included. A suspended account arrives here as `undefined`, because the
 * optional resolver treats a deactivated account as anonymous, so a suspended author sees the public
 * view of their own thread.
 */
function visibleCommentStatuses(
  post: PostDetail,
  viewer: UserMe | undefined,
): readonly CommentStatus[] {
  if (viewer !== undefined && (viewer.id === post.author.id || viewer.role === ADMIN_ROLE)) {
    return COMMENT_STATUS_VALUES;
  }
  return PUBLIC_COMMENT_STATUSES;
}

/**
 * A comment as a given viewer sees it: itself, with only the replies in *statuses* nested beneath it.
 *
 * Recursive, because a reply may itself carry replies and a moderator's rejection of one must not
 * publish the ones beneath it. Returns a fresh object rather than editing the fixture, which is what
 * keeps the fixture set immutable across requests.
 */
function threadVisibleTo(
  comment: CommentPublic,
  statuses: readonly CommentStatus[],
): CommentPublic {
  const visible = comment.replies
    .filter((reply) => statuses.includes(reply.status))
    .map((reply) => threadVisibleTo(reply, statuses));
  return {
    ...comment,
    // Recomputed rather than spread from the fixture, because the API counts replies under the same
    // moderation filter it returns them under: a public reader is told how many APPROVED replies a
    // comment has, not how many rows exist. Carrying the fixture's number through would let a
    // component be written against a count that reveals withheld comments.
    reply_count: visible.length,
    has_more_replies: false,
    replies: visible,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Request-body validation
 *
 * The answer to finding C10, and the shape of it is the point. Every reader above - `readString`,
 * `readNullableString`, `readStringArray`, `readPostStatus` - returns `undefined` for anything it does
 * not like, and every call site paired that with `?? someDefault`. So an absent member, a member of
 * the wrong type, a malformed body and a value outside its bounds all produced the SAME outcome as a
 * valid request: a 2xx carrying a plausible substitute the caller never sent.
 *
 * That is not leniency. It means the 422 branch of every form in this application was unreachable
 * under test, and that a component submitting `{}` - or `null`, or an array, or a number where a
 * string belongs - was indistinguishable from one submitting a correct body. The readers below
 * therefore *collect* rejections instead of swallowing them, and each route hands the collection to
 * `validationProblem` when it is non-empty.
 *
 * The `type` on each entry is the validator pydantic names for that failure, and the message is the
 * one it writes, so a consumer switching on `ValidationErrorItem.type` or rendering its `message`
 * behaves under test as it will in production.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The field bounds every write route enforces, restated from the schemas that own them.
 *
 * Restated rather than imported, for the reason the enumerated members above are: the production
 * bounds live in `app/schemas/*.py` and are mirrored by module-private constants in
 * `src/lib/validation/*.ts`, neither of which this fixture module can reach - the Python side is
 * another tier and the TypeScript side does not export them. Naming them here, together, with the
 * schema each belongs to, at least makes a divergence a single visible table rather than a value
 * buried in a resolver.
 */
const BOUNDS = {
  /** `app.schemas.auth.USERNAME_MIN_LENGTH` / `USERNAME_MAX_LENGTH`. */
  username: { minimum: 3, maximum: 30 },
  /** `app.schemas.auth.PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_LENGTH`. */
  password: { minimum: 12, maximum: 128 },
  /** `app.schemas.auth.REFRESH_TOKEN_MAX_LENGTH`. */
  refreshToken: { minimum: 1, maximum: 512 },
  /** `app.schemas.user.DISPLAY_NAME_MIN_LENGTH` / `DISPLAY_NAME_MAX_LENGTH`. */
  displayName: { minimum: 1, maximum: 80 },
  /** `app.schemas.user.BIO_MAX_LENGTH`. */
  bio: { minimum: 0, maximum: 500 },
  /** `app.schemas.post.TITLE_MIN_LENGTH` / `TITLE_MAX_LENGTH`. */
  postTitle: { minimum: 1, maximum: 120 },
  /** `app.schemas.post.EXCERPT_MAX_LENGTH`. */
  postExcerpt: { minimum: 0, maximum: 500 },
  /** `app.schemas.post.CONTENT_MAX_LENGTH`, with the model's own non-empty floor. */
  postContent: { minimum: 1, maximum: 100_000 },
  /** `pydantic.HttpUrl`'s own ceiling, which `OptionalCoverImageUrl` inherits. */
  url: { minimum: 1, maximum: 2083 },
  /** `app.schemas.comment.BODY_MIN_LENGTH` / `BODY_MAX_LENGTH`. */
  commentBody: { minimum: 1, maximum: 5000 },
  /** `app.schemas.category.NAME_MAX_LENGTH`. */
  categoryName: { minimum: 1, maximum: 80 },
  /** `app.schemas.category.DESCRIPTION_MAX_LENGTH`. */
  categoryDescription: { minimum: 0, maximum: 500 },
} as const;

/** `app.schemas.post.MAX_CATEGORIES_PER_POST`. */
const MAX_CATEGORIES_PER_POST = 10;

/** The schemes `pydantic.HttpUrl` admits, and therefore the only ones a cover or avatar may name. */
const ALLOWED_URL_SCHEMES: readonly string[] = ['http:', 'https:'];

/** A length range a text member must fall inside, counted in code points as pydantic counts them. */
interface LengthBounds {
  readonly minimum: number;
  readonly maximum: number;
}

/** Count code points, not UTF-16 units: `pydantic.StringConstraints` bounds the former. */
function codePointLength(value: string): number {
  return [...value].length;
}

/** Append the rejection a text member outside *bounds* earns, and report whether it was rejected. */
function rejectLength(
  value: string,
  field: string,
  bounds: LengthBounds,
  errors: ValidationErrorItem[],
): boolean {
  const length = codePointLength(value);
  if (length < bounds.minimum) {
    errors.push({
      field,
      message: `String should have at least ${String(bounds.minimum)} characters`,
      type: 'string_too_short',
    });
    return true;
  }
  if (length > bounds.maximum) {
    errors.push({
      field,
      message: `String should have at most ${String(bounds.maximum)} characters`,
      type: 'string_too_long',
    });
    return true;
  }
  return false;
}

/** Read a required string member, collecting the rejection an absent or wrong-typed one earns. */
function requireString(
  body: Record<string, unknown>,
  field: string,
  bounds: LengthBounds,
  errors: ValidationErrorItem[],
): string | undefined {
  if (!(field in body)) {
    errors.push({ field, message: 'Field required', type: 'missing' });
    return undefined;
  }
  const value = body[field];
  if (typeof value !== 'string') {
    errors.push({ field, message: 'Input should be a valid string', type: 'string_type' });
    return undefined;
  }
  // `strip_whitespace=True` is declared on every one of these members, so the length that matters is
  // the stripped one - which is what makes a whitespace-only value too short rather than acceptable.
  const stripped = value.trim();
  return rejectLength(stripped, field, bounds, errors) ? undefined : stripped;
}

/**
 * Read an optional `string | null` member, distinguishing all three of its states.
 *
 * Absent leaves the field alone, `null` clears it, a string sets it - the distinction a partial
 * update is *for*. A blank string is folded to `null` because the schemas declare a
 * `BeforeValidator` that does exactly that, so a cleared form control reaches the column as a null
 * rather than as an empty string.
 */
function readOptionalText(
  body: Record<string, unknown>,
  field: string,
  bounds: LengthBounds,
  errors: ValidationErrorItem[],
): string | null | undefined {
  if (!(field in body)) {
    return undefined;
  }
  const value = body[field];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    errors.push({ field, message: 'Input should be a valid string', type: 'string_type' });
    return undefined;
  }
  const stripped = value.trim();
  if (stripped === '') {
    return null;
  }
  return rejectLength(stripped, field, bounds, errors) ? undefined : stripped;
}

/**
 * Read a member that is optional but **not nullable and not blankable**, collecting its rejections.
 *
 * The distinction from {@link readOptionalText} is a schema fact, not a nicety. That reader folds a
 * blank string to `null` because `app.schemas.user.OptionalBio` and `OptionalAvatarUrl` each declare
 * `BeforeValidator(_blank_to_none)` - their columns are nullable, so "" and `NULL` are one state.
 * `DisplayName` declares **no such validator**, because `users.display_name` is `TEXT NOT NULL`: a
 * cleared control cannot mean "remove the name" when there is no state for that to produce, so `""`
 * and `"   "` are measured after stripping and reported as **too short**.
 *
 * Reading it with the folding reader turned a blank submission into a successful no-op that answered
 * 200 with the name the account already had - a form clearing its only required field, told it
 * succeeded.
 *
 * An explicit `null` is *not* handled here: the two schemas that use this reader reject null with
 * their own message (`UserUpdate.reject_null_display_name`), so the call site raises that itself and
 * this reader is reached only for a present, non-null value.
 */
function readRequiredTextIfPresent(
  body: Record<string, unknown>,
  field: string,
  bounds: LengthBounds,
  errors: ValidationErrorItem[],
): string | undefined {
  if (!(field in body)) {
    return undefined;
  }
  const value = body[field];
  if (typeof value !== 'string') {
    errors.push({ field, message: 'Input should be a valid string', type: 'string_type' });
    return undefined;
  }
  // Stripped first, exactly as `strip_whitespace=True` strips before the length rules run.
  const stripped = value.trim();
  return rejectLength(stripped, field, bounds, errors) ? undefined : stripped;
}

/**
 * Read an optional `UUID | null` member, refusing anything that is not one.
 *
 * `app.schemas.comment.CommentCreate.parent_id` is `uuid.UUID | None`, and the difference between
 * that and a nullable *string* is the finding: read with the blank-folding text reader, `""` became
 * `null` and a reply whose parent identifier the client failed to supply was silently accepted as a
 * **root comment** - posted at the top of the thread instead of beneath the comment it answered, with
 * a 201 to say it worked. Pydantic answers a blank or malformed identifier with a 422 naming the
 * member, and so does this.
 *
 * `null` and absence both remain meaningful and distinct: absent leaves the member unset, `null` is
 * an explicit "this is a root comment".
 */
function readOptionalUuid(
  body: Record<string, unknown>,
  field: string,
  errors: ValidationErrorItem[],
): string | null | undefined {
  if (!(field in body)) {
    return undefined;
  }
  const value = body[field];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    errors.push({ field, message: 'Input should be a valid UUID', type: 'uuid_type' });
    return undefined;
  }
  if (!UUID_PATTERN.test(value.trim())) {
    errors.push({
      field,
      message: 'Input should be a valid UUID, invalid character',
      type: 'uuid_parsing',
    });
    return undefined;
  }
  return value.trim();
}

/** Read an optional absolute `http(s)` URL member, refusing every other scheme and every relative form. */
function readOptionalUrl(
  body: Record<string, unknown>,
  field: string,
  errors: ValidationErrorItem[],
): string | null | undefined {
  const raw = readOptionalText(body, field, BOUNDS.url, errors);
  if (raw === undefined || raw === null) {
    return raw;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    errors.push({
      field,
      message: 'Input should be a valid URL, relative URL without a base',
      type: 'url_parsing',
    });
    return undefined;
  }
  if (!ALLOWED_URL_SCHEMES.includes(parsed.protocol)) {
    errors.push({
      field,
      message: "URL scheme should be 'http' or 'https'",
      type: 'url_scheme',
    });
    return undefined;
  }
  return raw;
}

/** Read an optional list of category identifiers, bounded as the schema bounds it. */
function readOptionalCategoryIds(
  body: Record<string, unknown>,
  errors: ValidationErrorItem[],
): string[] | undefined {
  const field = 'category_ids';
  if (!(field in body)) {
    return undefined;
  }
  const value = body[field];
  if (!Array.isArray(value)) {
    errors.push({ field, message: 'Input should be a valid list', type: 'list_type' });
    return undefined;
  }
  const members: unknown[] = value;
  if (members.length > MAX_CATEGORIES_PER_POST) {
    errors.push({
      field,
      message: `List should have at most ${String(MAX_CATEGORIES_PER_POST)} items after validation, not ${String(members.length)}`,
      type: 'too_long',
    });
    return undefined;
  }
  const identifiers: string[] = [];
  for (const [index, member] of members.entries()) {
    if (typeof member !== 'string') {
      errors.push({
        field: `${field}.${String(index)}`,
        message: 'Input should be a valid UUID',
        type: 'uuid_type',
      });
      continue;
    }
    identifiers.push(member);
  }
  return identifiers;
}

/**
 * Read an optional member constrained to a closed set, rejecting anything outside it.
 *
 * `readPostStatus` and its siblings above answer `undefined` for a value outside the set, which the
 * old call sites turned into "keep what the row already had" - so `{"status": "PUBLSIHED"}` reported
 * success and changed nothing. FastAPI answers a value outside a `Literal` or an enum with a 422
 * naming the member, and so does this.
 */
function readEnumMember<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  errors: ValidationErrorItem[],
): T | undefined {
  if (!(field in body)) {
    return undefined;
  }
  const value = body[field];
  const member = allowed.find((candidate) => candidate === value);
  if (member === undefined) {
    errors.push({
      field,
      message: `Input should be ${allowed.map((option) => `'${option}'`).join(' or ')}`,
      type: 'enum',
    });
  }
  return member;
}

/** Read a REQUIRED closed-set member: absent is `missing`, outside the set is `enum`. */
function requireEnumMember<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  errors: ValidationErrorItem[],
): T | undefined {
  if (!(field in body)) {
    errors.push({ field, message: 'Field required', type: 'missing' });
    return undefined;
  }
  return readEnumMember(body, field, allowed, errors);
}

/** Read an optional boolean member, rejecting a value of any other type. */
function readBooleanMember(
  body: Record<string, unknown>,
  field: string,
  errors: ValidationErrorItem[],
): boolean | undefined {
  if (!(field in body)) {
    return undefined;
  }
  const value = body[field];
  if (typeof value !== 'boolean') {
    errors.push({
      field,
      message: 'Input should be a valid boolean',
      type: 'bool_type',
    });
    return undefined;
  }
  return value;
}

/**
 * Reject any member the model does not declare.
 *
 * Every write model in this API sets `extra="forbid"`, and that is a security property rather than
 * strictness for its own sake: `RegisterRequest` refusing an unknown member is what makes
 * `{"role": "ADMIN"}` a 422 instead of a silently-ignored escalation attempt, and `UserUpdate`
 * refusing one is what keeps `email`, `username`, `role`, `is_active` and `id` unsettable through the
 * self-update. A mock that ignored extras answered 201 to both.
 */
function rejectExtraMembers(
  body: Record<string, unknown>,
  declared: readonly string[],
  errors: ValidationErrorItem[],
): void {
  for (const field of Object.keys(body)) {
    if (!declared.includes(field)) {
      errors.push({ field, message: 'Extra inputs are not permitted', type: 'extra_forbidden' });
    }
  }
}

/**
 * Read a request body that must be a JSON object, or the rejection it earns.
 *
 * `asRecord` used to turn a null body, an array, a number and unparseable bytes into `{}`, so a route
 * receiving any of them proceeded on defaults. FastAPI answers each of them with a 422 whose single
 * entry names `body`, and so does this.
 */
async function objectBody(request: Request): Promise<Resolved<Record<string, unknown>>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return {
      ok: false,
      errors: [{ field: 'body', message: 'JSON decode error', type: 'json_invalid' }],
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      errors: [
        {
          field: 'body',
          message: 'Input should be a valid dictionary or object to extract fields from',
          type: 'model_attributes_type',
        },
      ],
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Read a body that carries NO members at all - the shape `POST /publish` and `/unpublish` take.
 *
 * Those two routes declare no request model, so FastAPI ignores whatever arrives. `undefined` is
 * therefore the only outcome, and it is spelled out so a reader is not left wondering whether the
 * omission is deliberate.
 */
function ignoredBody(): undefined {
  return undefined;
}

/**
 * Strip the markup `app.services.post_service` and `comment_service` strip on write.
 *
 * A deliberately small approximation of `bleach.clean(strip=True)` over an inline allow-list: a
 * disallowed ELEMENT is removed while the text it wrapped survives, so `<script>alert(1)</script>`
 * stores `alert(1)` and `<p onclick="x">Hi</p>` stores `Hi`. It exists so that a component asserting
 * "what I typed came back" is asserting against a value the service would actually have stored, and
 * so that a spec submitting hostile markup can observe it not surviving. It is NOT a sanitiser and
 * nothing in the application relies on it; the real one runs in the service and the client sanitises
 * again where it renders.
 */
function sanitiseText(raw: string): string {
  return raw.replace(/<[^>]*>/g, '').trim();
}

/** The password grant's identifier field name - `username`, carrying an EMAIL address. */
const GRANT_USERNAME_FIELD = 'username';

/** The password grant's secret field name. */
const GRANT_PASSWORD_FIELD = 'password';

/**
 * Read the named fields out of a form-encoded body, or the 422 a non-form body earns.
 *
 * The sign-in route's whole contract, and the reason it needs its own reader: `request.formData()`
 * throws on a JSON body, and FastAPI answers that same request with a 422 naming the two form fields
 * that are missing - measured directly against the running service. A mock that caught the throw and
 * defaulted the fields turned the most common client mistake on this route into a success.
 */
async function readFormFields(
  request: Request,
  fields: readonly string[],
): Promise<Resolved<Record<string, string>>> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    const [first, ...rest] = fields.map((field): ValidationErrorItem => ({
      field,
      message: 'Field required',
      type: 'missing',
    }));
    return first === undefined
      ? { ok: false, errors: [{ field: 'body', message: 'Field required', type: 'missing' }] }
      : { ok: false, errors: [first, ...rest] };
  }
  const values: Record<string, string> = {};
  const errors: ValidationErrorItem[] = [];
  for (const field of fields) {
    const value = form.get(field);
    if (typeof value !== 'string' || value === '') {
      errors.push({ field, message: 'Field required', type: 'missing' });
      continue;
    }
    values[field] = value;
  }
  return resolved(values, errors);
}

/** Read the one member the refresh and logout bodies declare, bounded as `RefreshRequest` bounds it. */
async function readRefreshToken(request: Request): Promise<Resolved<string>> {
  const parsed = await objectBody(request);
  if (!parsed.ok) {
    return parsed;
  }
  const errors: ValidationErrorItem[] = [];
  rejectExtraMembers(parsed.value, REFRESH_MEMBERS, errors);
  const token = requireString(parsed.value, 'refresh_token', BOUNDS.refreshToken, errors);
  return resolved(token ?? '', errors);
}

/** Whether a free-text administrative filter matches any of a row's searchable fields. */
function matchesTerm(term: string | undefined, ...fields: readonly (string | null)[]): boolean {
  if (term === undefined) {
    return true;
  }
  const needle = term.toLowerCase();
  return fields.some((field) => field !== null && field.toLowerCase().includes(needle));
}

/* =================================================================================================
 * HANDLERS
 *
 * Grouped by namespace, and within the posts namespace ordered so that every `/posts/{id}/...`
 * sub-path is declared before the bare `/posts/{slug}` read. msw answers with the first matching
 * handler, so that order is behaviour, not layout.
 * ============================================================================================== */

/* ------------------------------------------------ auth ------------------------------------------
 * Five operations. Two of them are unlike anything else in the API and are easy to get wrong:
 * sign-in consumes `application/x-www-form-urlencoded` under the OAuth2 password grant, and its
 * `username` field carries the account's EMAIL rather than its handle; refresh is ordinary JSON and
 * is called by the client itself, never by a component, as part of its rotation path.
 *
 * THESE ROUTES REFUSE THINGS NOW, which is the substance of finding C5. Before, registration accepted
 * any body and invented what was missing, sign-in issued a credential for an address the fixtures do
 * not hold, rotation succeeded for a token that was never issued, and the conflict document named
 * which identity collided. Each of those made a *refusal path* in the application unreachable under
 * test - and the last of them would have taught a sign-up form to mark a control the service
 * deliberately declines to identify.
 * ---------------------------------------------------------------------------------------------- */

/** The members `RegisterRequest` declares. Anything else is `extra_forbidden`, including `role`. */
const REGISTER_MEMBERS: readonly string[] = ['email', 'username', 'password', 'display_name'];

/** The members `UserUpdate` declares. `email`, `username`, `role`, `is_active` and `id` are absent. */
const SELF_UPDATE_MEMBERS: readonly string[] = ['display_name', 'bio', 'avatar_url'];

/** The members `PostCreate` and `PostUpdate` declare. */
const POST_MEMBERS: readonly string[] = [
  'title',
  'excerpt',
  'content',
  'cover_image_url',
  'category_ids',
];

/** The members `CommentCreate` declares; `post_id` comes from the path and is not one of them. */
const COMMENT_CREATE_MEMBERS: readonly string[] = ['body', 'parent_id'];

/** The single member `CommentUpdate` declares - moderation state is not editable by an author. */
const COMMENT_UPDATE_MEMBERS: readonly string[] = ['body'];

/** The members `CategoryCreate` and `CategoryUpdate` declare; `id` and `slug` are server-owned. */
const CATEGORY_MEMBERS: readonly string[] = ['name', 'description'];

/** The members `AdminUserUpdate` declares. */
const ADMIN_USER_MEMBERS: readonly string[] = ['role', 'is_active'];

/** The single member each administrative status change declares. */
const STATUS_MEMBER: readonly string[] = ['status'];

/** The single member `RefreshRequest` and the logout body declare. */
const REFRESH_MEMBERS: readonly string[] = ['refresh_token'];

/** A simple deliverable-address check, standing in for `email-validator`'s. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value);
}

/** Whether either identity in a registration body is already held by a stored account. */
function identityIsTaken(email: string, username: string): boolean {
  const wantedEmail = email.toLowerCase();
  const wantedUsername = username.toLowerCase();
  return storedAccounts.some(
    (account) =>
      account.email.toLowerCase() === wantedEmail ||
      account.username.toLowerCase() === wantedUsername,
  );
}

/** 401 for a credential this API refuses to say anything more about. */
function credentialRefused(request: Request): Response {
  return problem({
    status: HTTP_UNAUTHORIZED,
    type: ERROR_TYPE_UNAUTHORIZED,
    title: ERROR_TITLE_UNAUTHORIZED,
    detail: CREDENTIAL_REFUSED_DETAIL,
    instance: requestInstance(request),
    headers: { [WWW_AUTHENTICATE_HEADER]: WWW_AUTHENTICATE_BEARER },
  });
}

const authHandlers = [
  /**
   * Create an account.
   *
   * Answers with the public projection - never with a token, and never with a credential of any kind,
   * because registration does not sign the new account in. Three members are required, `display_name`
   * is optional and defaults to the username, and **any undeclared member is a 422**: that is what
   * makes `{"role": "ADMIN"}` an explicit refusal rather than a silently dropped escalation attempt.
   *
   * A collision on either identity is a **409 that does not say which one**, quoted from
   * `_IDENTIFIER_TAKEN`. A sign-up form therefore cannot mark a single control from this document and
   * must ask the visitor to change either - which is the behaviour a spec should be written against,
   * because the alternative turns the one unauthenticated write in the API into a membership oracle.
   */
  http.post('*/api/v1/auth/register', async ({ request }) => {
    const parsed = await objectBody(request);
    if (!parsed.ok) {
      return validationProblem(request, parsed.errors);
    }
    const body = parsed.value;
    const errors: ValidationErrorItem[] = [];
    rejectExtraMembers(body, REGISTER_MEMBERS, errors);
    const email = requireString(body, 'email', { minimum: 3, maximum: 254 }, errors);
    if (email !== undefined && !looksLikeEmail(email)) {
      errors.push({
        field: 'email',
        message: 'value is not a valid email address',
        type: 'value_error',
      });
    }
    const username = requireString(body, 'username', BOUNDS.username, errors);
    if (username !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/.test(username)) {
      errors.push({
        field: 'username',
        message: 'String should match pattern',
        type: 'string_pattern_mismatch',
      });
    }
    // The password is bounded but NEVER echoed, quoted or reported back beyond the rule it broke.
    requireString(body, 'password', BOUNDS.password, errors);
    // Optional but not blankable, exactly as on `PATCH /users/me`: `UserRegister.display_name` is
    // `Annotated[str, StringConstraints(min_length=1, strip_whitespace=True)] | None` with no
    // blank-folding validator, and its own description says a whitespace-only value is rejected
    // rather than stored blank. Omitting it - or sending null - is what asks for the username to be
    // used instead; sending `"  "` is a 422.
    const displayName =
      body['display_name'] === null
        ? null
        : readRequiredTextIfPresent(body, 'display_name', BOUNDS.displayName, errors);
    const [first, ...rest] = errors;
    if (first !== undefined) {
      return validationProblem(
        request,
        [first, ...rest],
        'The submitted registration is not valid.',
      );
    }
    if (email === undefined || username === undefined) {
      return validationProblem(request, [
        { field: 'body', message: 'Field required', type: 'missing' },
      ]);
    }
    if (identityIsTaken(email, username)) {
      return conflict(request, IDENTIFIER_TAKEN_DETAIL);
    }
    const account: UserPublic = {
      id: CREATED_USER_ID,
      username,
      display_name: displayName ?? username,
      bio: null,
      avatar_url: null,
      created_at: INSTANT_CREATED_RESOURCE,
    };
    return created(account);
  }),

  /**
   * Verify credentials and issue a pair.
   *
   * Read with `formData`, because this is the one form-encoded route in the API and `request.json()`
   * would throw on its body - a JSON body is therefore a 422 naming the two form fields it lacks,
   * measured against the running service and not assumed.
   *
   * An address the fixtures do not hold and a wrong password answer **the same 401 with the same
   * detail**, which is the property that keeps the route from being an oracle for which addresses are
   * registered. A recognised address belonging to a *deactivated* account answers 403 with the
   * deactivation sentence instead: the credential was genuine, and saying so is not a disclosure
   * because the caller supplied it.
   */
  http.post('*/api/v1/auth/login', async ({ request }) => {
    const form = await readFormFields(request, [GRANT_USERNAME_FIELD, GRANT_PASSWORD_FIELD]);
    if (!form.ok) {
      return validationProblem(request, form.errors);
    }
    const email = form.value[GRANT_USERNAME_FIELD] ?? '';
    const password = form.value[GRANT_PASSWORD_FIELD] ?? '';
    const account = storedAccounts.find(
      (candidate) => candidate.email.toLowerCase() === email.trim().toLowerCase(),
    );
    if (account === undefined || password !== FIXTURE_PASSWORD) {
      return credentialRefused(request);
    }
    if (!account.is_active) {
      return forbidden(request, DEACTIVATED_ACCOUNT_DETAIL);
    }
    const pair = tokenPairsByEmail.get(account.email);
    return pair === undefined ? credentialRefused(request) : ok(pair);
  }),

  /**
   * Rotate the refresh token and mint a new access token.
   *
   * Both members of the answer differ from every other pair, so a rotation is observable rather than
   * merely assumed. A token this module never issued is refused with 401 and the bearer challenge,
   * which is what makes the client's "rotation failed, abandon the session" path reachable from the
   * default handler set rather than only from an override.
   *
   * **The pair is the PRESENTING principal's.** `rotate_refresh_token` resolves the token's owner and
   * issues that account a new pair, so a reader who rotates stays the reader. Answering one shared
   * pair - the author's - meant a rotation silently switched identity mid-spec.
   *
   * **Every refusal on this route is a 401**, including a token whose owner has been deactivated or
   * removed: the service raises one `UnauthorizedError` for "never issued", "already spent",
   * "expired" and "owner unusable" alike, because naming the failed check tells an attacker which one
   * to fix. There is no 403 branch here to reproduce.
   */
  http.post('*/api/v1/auth/refresh', async ({ request }) => {
    const submitted = await readRefreshToken(request);
    if (!submitted.ok) {
      return validationProblem(request, submitted.errors);
    }
    const account = accountsByRefreshToken.get(submitted.value);
    // One refusal for all four causes: unissued, and owner deactivated, are the two reachable here.
    if (account === undefined || !account.is_active) {
      return unauthorized(request);
    }
    const rotated = rotatedPairsByAccountId.get(account.id);
    return rotated === undefined ? unauthorized(request) : ok(rotated);
  }),

  /**
   * Revoke the presented refresh token. 204 with no body: there is nothing to report.
   *
   * Requires both halves - the access token identifies the caller, the body names the credential to
   * withdraw - so a client that dropped the body would see the refusal rather than a false success.
   */
  http.post('*/api/v1/auth/logout', async ({ request }) => {
    const principal = authenticate(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const submitted = await readRefreshToken(request);
    if (!submitted.ok) {
      return validationProblem(request, submitted.errors);
    }
    return noContent();
  }),

  /** The authenticated principal, in the self projection that carries email, role and state. */
  http.get('*/api/v1/auth/me', ({ request }) => {
    const principal = authenticate(request);
    return isRefusal(principal) ? principal : ok(principal);
  }),
];

/* ----------------------------------------------- users ------------------------------------------
 * `/users/me` is declared before `/users/:username`. The two cannot collide on method today, but
 * the ordering is stated rather than relied upon, because a later addition of `GET /users/me` would
 * otherwise be answered by the profile resolver with `me` as a handle - and the typed wrapper
 * refuses `me` as a handle precisely because no account can hold it.
 * ---------------------------------------------------------------------------------------------- */

const userHandlers = [
  /**
   * Update the principal's own profile.
   *
   * A genuine partial update: each of the three mutable members is applied only when submitted, and
   * an explicit `null` clears a nullable one rather than being ignored. `updated_at` advances, which
   * is what a component comparing before and after has to see.
   *
   * `extra="forbid"` is enforced, and it is the security half of this route: `email`, `username`,
   * `role`, `is_active` and `id` are not declared members, so submitting one is a 422 naming it
   * rather than a quietly dropped escalation attempt. An avatar must be an absolute `http(s)` URL,
   * because the stored value is rendered into an `<img src>` on every byline this account appears on.
   */
  http.patch('*/api/v1/users/me', async ({ request }) => {
    const principal = authenticate(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const parsed = await objectBody(request);
    if (!parsed.ok) {
      return validationProblem(request, parsed.errors);
    }
    const body = parsed.value;
    const errors: ValidationErrorItem[] = [];
    rejectExtraMembers(body, SELF_UPDATE_MEMBERS, errors);
    // `users.display_name` is NOT NULL, so an explicit null is refused rather than folded away -
    // omit the member to leave it alone.
    if (body['display_name'] === null) {
      errors.push({
        field: 'display_name',
        message: 'Input should be a valid string',
        type: 'string_type',
      });
    }
    // NOT the blank-folding reader: `DisplayName` carries no `_blank_to_none` validator, because
    // `users.display_name` is NOT NULL. A blank submission is too short, not a no-op. `bio` and
    // `avatar_url` below DO fold, because their columns are nullable and their aliases say so.
    const displayName = readRequiredTextIfPresent(body, 'display_name', BOUNDS.displayName, errors);
    const bio = readOptionalText(body, 'bio', BOUNDS.bio, errors);
    const avatarUrl = readOptionalUrl(body, 'avatar_url', errors);
    const [first, ...rest] = errors;
    if (first !== undefined) {
      return validationProblem(request, [first, ...rest]);
    }
    const updated: UserMe = {
      ...principal,
      display_name: displayName ?? principal.display_name,
      bio: bio === undefined ? principal.bio : bio,
      avatar_url: avatarUrl === undefined ? principal.avatar_url : avatarUrl,
      updated_at: FIXTURE_PUBLISHED_AT,
    };
    return ok(updated);
  }),

  /**
   * That author's posts, hard-filtered to PUBLISHED and declared before the bare profile read.
   *
   * The filter is not a convenience. A profile is a public surface, so a draft appearing here would
   * disclose unpublished work to anyone who visited it; the service filters on status in the query
   * rather than in the caller, and so does this - for **every** caller, the author included, which is
   * the case a viewer-scoped filter would get wrong. Only `page` and `page_size` are honoured: a
   * profile listing offers no search, no category filter and no ordering choice.
   *
   * A deactivated account answers 404 rather than an empty profile, because the service resolves it
   * as absent rather than as suspended - a profile page must not become a way to enumerate
   * suspensions.
   */
  http.get('*/api/v1/users/:username/posts', ({ request, params }) => {
    const username = pathParam(params.username);
    const account = findAccountByUsername(username);
    if (account === undefined || !account.is_active) {
      return notFound(request, `No author is registered under the handle "${username}".`);
    }
    const authored = publiclyVisiblePosts()
      .filter((post) => post.author.username === account.username)
      .sort(byRecency)
      .map(toPostSummary);
    return pageResponse(authored, request);
  }),

  /**
   * A public author profile, keyed on the handle.
   *
   * Answers with `UserPublic`, and therefore discloses no address, no role and no account state. An
   * unknown handle is 404 rather than an empty profile, so a component cannot render a header for
   * somebody who does not exist - and so is a deactivated one, for the reason above.
   */
  http.get('*/api/v1/users/:username', ({ request, params }) => {
    const username = pathParam(params.username);
    const account = findAccountByUsername(username);
    if (account === undefined || !account.is_active) {
      return notFound(request, `No author is registered under the handle "${username}".`);
    }
    return ok(toPublicUser(account));
  }),
];

/* ----------------------------------------------- posts ------------------------------------------
 * DECLARATION ORDER IS LOAD-BEARING HERE. The collection patterns come first, then every
 * `/posts/:postId/...` sub-path - like, likes, comments, publish, unpublish - and only then the
 * bare `/posts/:slug` read and the two mutations addressed by identifier. A pattern segment matches
 * one path segment and cannot swallow a slash, so the sub-paths would in fact survive a different
 * order; declaring them first states the constraint instead of depending on that detail.
 *
 * Note which key each operation is addressed by, because they differ deliberately: the public read
 * is keyed on the SLUG, because that is what a canonical URL carries, while every mutation is keyed
 * on the UUID, because a slug is a presentation concern and an identifier is not.
 *
 * THREE RULES THIS GROUP NOW ENFORCES, and each was absent - finding C7. **Draft visibility is
 * scoped to the VIEWER**: a credential used to be enough to read anybody's draft, so the
 * confidentiality guarantee AAP §0.9.4.4 states was not merely untested but contradicted by the
 * mock. **Authoring is role-gated**: `ensure_can_author` refuses a `READER` with 403, so a component
 * that offered a reader a compose form passed its tests. **Mutation is ownership-scoped**: an author
 * may act on their own post and an administrator on any, and the two refusals are ordered 404 before
 * 403 so that refusing an edit cannot confirm a draft exists.
 * ---------------------------------------------------------------------------------------------- */

/** Whether *viewer* may read *post*: published, or their own, or theirs to administer. */
function canViewPost(post: PostDetail, viewer: UserMe | undefined): boolean {
  if (post.status === VISIBLE_POST_STATUS) {
    return true;
  }
  if (viewer === undefined) {
    return false;
  }
  return viewer.id === post.author.id || viewer.role === ADMIN_ROLE;
}

/** Whether *viewer* may change *post*: `can_modify` - the owner, or an administrator. */
function canModifyPost(post: PostDetail, viewer: UserMe): boolean {
  return viewer.id === post.author.id || viewer.role === ADMIN_ROLE;
}

/**
 * Resolve a post a caller means to mutate, or the refusal that resolution earns.
 *
 * The ORDER of the two refusals is the contract: a post the caller may not even see is **404**, and
 * only a post they can see but may not change is **403**. Reversed, a 403 on somebody else's draft
 * would confirm that a draft exists at that identifier, which is exactly the disclosure the draft
 * status exists to prevent.
 */
function postToModify(request: Request, postId: string, viewer: UserMe): PostDetail | Response {
  const post = findPostById(postId);
  if (post === undefined || !canViewPost(post, viewer)) {
    return notFound(request, 'No post is stored under that identifier.');
  }
  if (!canModifyPost(post, viewer)) {
    return forbidden(request, 'Only the post\u2019s author or an administrator may change it.');
  }
  return post;
}

/** Narrow a post-resolution outcome to the refusal half. */
function isPostRefusal(outcome: PostDetail | Response): outcome is Response {
  return outcome instanceof Response;
}

const postCollectionHandlers = [
  /**
   * The feed. Composes free-text ranking, category membership, author scoping, ordering and
   * windowing over the published set, exactly as the service's single feed statement does.
   *
   * Public, and therefore scoped to PUBLISHED: neither the draft nor the archived post can appear,
   * under any combination of parameters, **and no credential widens it** - the feed has no
   * viewer-scoped branch, so an author sees their own draft on their dashboard and never here.
   *
   * A page beyond the last answers with an empty `items` array and the true `total`, never an error,
   * because asking for a page that does not exist is a legitimate request with an empty answer. A
   * `page` or `page_size` outside its bounds is a different matter and is a 422 - see
   * {@link readPageRequest}. `sort` is likewise closed: `PostSortOption` admits `recent` and
   * `relevance` and nothing else, so a third value is refused rather than silently read as `recent`.
   */
  http.get('*/api/v1/posts', ({ request }) => {
    const params = searchParams(request);
    // Resolved FIRST, and its refusal returned before any parameter is read: an unusable credential
    // is rejected during dependency resolution in the service, which happens before the query
    // parameters this route declares are validated.
    const principal = optionalPrincipal(request);
    if (isRefusal(principal)) {
      return principal;
    }

    // PARSED FIRST, and this order is the service's rather than a preference. Every parameter this
    // route declares is validated by the framework before the route function is entered, so a
    // malformed `mine`, `status`, `sort`, `page` or `page_size` is a 422 that never reaches the mode
    // rules below - which are ordinary statements inside the function body. Applying a mode rule to
    // an unparsed string is what let `?mine=maybe` be read as "not mine" and answered with the
    // public feed.
    const query = readFeedQuery(params, principal);
    if (!query.ok) {
      return validationProblem(request, query.errors);
    }

    // The three mode rules, in the order the service applies them. Each refuses rather than
    // ignores, because a dashboard answered with the public feed looks to its owner like their
    // drafts were deleted, and a filter that was accepted and dropped looks like it was applied.
    //
    // `mine` is re-read as a parsed boolean rather than taken from `query.value.ownedBy`: that
    // member is `undefined` both for "did not ask" and for "asked with no credential", and those two
    // are a 200 and a 401.
    const wantsOwn = readQueryBooleanStrict(params, 'mine', []) === true;
    if (wantsOwn && principal === undefined) {
      return unauthorized(request);
    }
    if (wantsOwn && query.value.authorUsername !== undefined) {
      return feedModeProblem(
        request,
        'author',
        'The workspace listing is scoped to the authenticated account, so it cannot be pointed ' +
          'at another author.',
      );
    }
    if (!wantsOwn && query.value.status !== undefined) {
      return feedModeProblem(
        request,
        'status',
        'The public feed answers published posts only, so narrowing it by lifecycle state is ' +
          'either a no-op or a request for another author\u2019s unpublished work.',
      );
    }

    // `?author=` is RESOLVED before anything is filtered, so a name the service does not know is a
    // 404 rather than an empty page. The asymmetry with `?category=`, which correctly answers an
    // empty page, is the service's: an unknown author is an unresolvable address, while an unknown
    // category is a filter that matches nothing.
    let scopedAuthor: UserMe | undefined;
    const authorUsername = query.value.authorUsername;
    if (authorUsername !== undefined) {
      scopedAuthor = findAccountByUsername(authorUsername);
      if (scopedAuthor === undefined) {
        return notFound(request, `The \`author\` filter names no account: "${authorUsername}".`);
      }
    }

    const rows = composeFeed(query.value, scopedAuthor).map(toPostSummary);
    return pageResponse(rows, request);
  }),

  /**
   * Create a draft.
   *
   * Answers 201 with the full detail projection at `status: 'DRAFT'` and `published_at: null` -
   * creation never publishes, because publication is a separate transition with its own route. The
   * slug is derived from the submitted title here and never re-derived afterwards.
   *
   * Gated on the AUTHOR role as well as on a credential: `ensure_can_author` refuses a `READER` with
   * **403**, and that refusal is a server-side check rather than a hidden control, so it must be
   * reachable under test. `title` and `content` are required, every text member is bounded, a cover
   * image must be an absolute `http(s)` URL, and an unknown category identifier is a **404** resolved
   * before anything is written.
   */
  http.post('*/api/v1/posts', async ({ request }) => {
    const principal = authenticate(request);
    if (isRefusal(principal)) {
      return principal;
    }
    if (!AUTHORING_ROLES.includes(principal.role)) {
      return forbidden(request, 'This operation requires the author or administrator role.');
    }
    const parsed = await objectBody(request);
    if (!parsed.ok) {
      return validationProblem(request, parsed.errors);
    }
    const body = parsed.value;
    const errors: ValidationErrorItem[] = [];
    rejectExtraMembers(body, POST_MEMBERS, errors);
    const title = requireString(body, 'title', BOUNDS.postTitle, errors);
    const content = requireString(body, 'content', BOUNDS.postContent, errors);
    const excerpt = readOptionalText(body, 'excerpt', BOUNDS.postExcerpt, errors);
    const coverImageUrl = readOptionalUrl(body, 'cover_image_url', errors);
    const categoryIds = readOptionalCategoryIds(body, errors) ?? [];
    const [first, ...rest] = errors;
    if (first !== undefined) {
      return validationProblem(request, [first, ...rest]);
    }
    const unknown = categoryIds.find((categoryId) => findCategoryById(categoryId) === undefined);
    if (unknown !== undefined) {
      return notFound(request, `No category is stored under the identifier ${unknown}.`);
    }
    const draft: PostDetail = {
      id: CREATED_POST_ID,
      title: title ?? '',
      // Collision-safe: a title that derives a slug an existing post holds gets the next free suffix,
      // because `posts.slug` is uniquely constrained and the service allocates around it.
      slug: allocateSlug(
        title ?? '',
        fixturePosts.map((post) => post.slug),
      ),
      excerpt: excerpt ?? null,
      cover_image_url: coverImageUrl ?? null,
      status: 'DRAFT',
      published_at: null,
      view_count: 0,
      created_at: INSTANT_CREATED_RESOURCE,
      author: toPublicUser(principal),
      categories: toCategorySummaries(categoryIds),
      // Sanitised on write, as `post_service` sanitises all three text members, so a spec submitting
      // hostile markup observes it not surviving rather than being echoed back intact.
      content: sanitiseText(content ?? ''),
      updated_at: INSTANT_CREATED_RESOURCE,
    };
    return created(draft);
  }),
];

const postSubResourceHandlers = [
  /**
   * Like a post. Idempotent by construction: the answer does not depend on how many times it has
   * been called, because the service's composite primary key on `(post_id, user_id)` makes a repeat
   * insert a no-op.
   *
   * **Per-principal, and 404 for a post the caller cannot see.** `like_service` raises `NotFoundError`
   * for an unknown *or* non-visible post, so an identifier the fixtures do not hold is not a
   * successful like of nothing - which is what this module used to answer, count zero and all. The
   * count returned is the post's own plus this caller if they had not already liked it, so a spec can
   * assert that a second call leaves the number where the first put it.
   */
  http.put('*/api/v1/posts/:postId/like', ({ request, params }) => {
    const principal = authenticate(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const post = findPostById(pathParam(params.postId));
    if (post === undefined || !canViewPost(post, principal)) {
      return notFound(request, 'No post is stored under that identifier.');
    }
    return ok(likeSummaryFor(post.id, principal, true));
  }),

  /**
   * Remove a like.
   *
   * The one DELETE in the whole API that answers with a body rather than 204: the caller needs the
   * new count to render, and a second round trip to fetch it would make the control flicker. Also
   * idempotent - removing a like that was never granted leaves the count alone.
   */
  http.delete('*/api/v1/posts/:postId/like', ({ request, params }) => {
    const principal = authenticate(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const post = findPostById(pathParam(params.postId));
    if (post === undefined || !canViewPost(post, principal)) {
      return notFound(request, 'No post is stored under that identifier.');
    }
    return ok(likeSummaryFor(post.id, principal, false));
  }),

  /**
   * The like state of a post. Requires no credential - an anonymous reader still sees the count, and
   * simply sees `liked_by_caller: false`, which is why the summary carries both members.
   *
   * `liked_by_caller` is resolved against the **presented principal** rather than against the mere
   * presence of a credential, so a reader who has not liked a post is reported as not having liked it.
   */
  http.get('*/api/v1/posts/:postId/likes', ({ request, params }) => {
    const viewer = optionalPrincipal(request);
    if (isRefusal(viewer)) {
      return viewer;
    }
    const post = findPostById(pathParam(params.postId));
    if (post === undefined || !canViewPost(post, viewer)) {
      return notFound(request, 'No post is stored under that identifier.');
    }
    return ok(likeSummaryFor(post.id, viewer, undefined));
  }),

  /**
   * A page of comments on a post, WINDOWED OVER ROOTS.
   *
   * `total` and `pages` count top-level comments, and a reply is nested inside its parent's
   * `replies` array rather than occupying a slot of its own. Windowing over a flattened thread would
   * let a busy discussion push a root onto a later page as replies arrived beneath an earlier one.
   *
   * **Visibility is viewer-scoped, in the one way the service scopes it**: an administrator and the
   * post's own author see every moderation state, and everyone else - an authenticated reader on
   * somebody else's post included - sees only what is approved. An unknown post is a 404 rather than
   * an empty page.
   */
  http.get('*/api/v1/posts/:postId/comments', ({ request, params }) => {
    const viewer = optionalPrincipal(request);
    if (isRefusal(viewer)) {
      return viewer;
    }
    const post = findPostById(pathParam(params.postId));
    if (post === undefined || !canViewPost(post, viewer)) {
      return notFound(request, 'No post is stored under that identifier.');
    }
    const statuses = visibleCommentStatuses(post, viewer);
    // `parent` selects the continuation window: that comment's direct replies become the page
    // members instead of the post's top-level comments. Modelled rather than ignored, because a
    // component that pages a wide thread would otherwise be handed the roots again and appear to
    // work while looping over the wrong collection.
    const parent = searchParams(request).get('parent');
    const members = fixtureComments
      .filter(
        (comment) =>
          comment.post_id === post.id &&
          (parent === null ? comment.parent_id === null : comment.parent_id === parent) &&
          statuses.includes(comment.status),
      )
      .map((comment) => threadVisibleTo(comment, statuses));
    return pageResponse(members, request);
  }),

  /**
   * Add a comment, or a reply when `parent_id` is submitted.
   *
   * The post identifier comes from the path, not the body, so the body carries no `post_id` to echo.
   *
   * **The created comment is `PENDING`, not `APPROVED`.** That is the product's moderation default -
   * nothing a reader writes becomes public until it is approved - and answering `APPROVED` taught
   * every comment-form spec that a submission appears immediately, which is the opposite of what the
   * reader will see. `parent_id` must name a comment the caller can see on *this* post, and the body
   * is bounded and sanitised on write.
   */
  http.post('*/api/v1/posts/:postId/comments', async ({ request, params }) => {
    const principal = authenticate(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const post = findPostById(pathParam(params.postId));
    if (post === undefined || !canViewPost(post, principal)) {
      return notFound(request, 'No post is stored under that identifier.');
    }
    const parsed = await objectBody(request);
    if (!parsed.ok) {
      return validationProblem(request, parsed.errors);
    }
    const errors: ValidationErrorItem[] = [];
    rejectExtraMembers(parsed.value, COMMENT_CREATE_MEMBERS, errors);
    const text = requireString(parsed.value, 'body', BOUNDS.commentBody, errors);
    // A UUID, not a bounded string: `CommentCreate.parent_id` is `uuid.UUID | None`, so a blank or
    // malformed identifier is a 422 naming the member rather than a comment quietly posted at the top
    // of the thread instead of beneath the one it replies to.
    const parentId = readOptionalUuid(parsed.value, 'parent_id', errors);
    const [first, ...rest] = errors;
    if (first !== undefined) {
      return validationProblem(request, [first, ...rest], 'The submitted comment is not valid.');
    }
    if (parentId !== undefined && parentId !== null) {
      const parent = findCommentById(parentId);
      const visible = visibleCommentStatuses(post, principal);
      if (parent === undefined || parent.post_id !== post.id || !visible.includes(parent.status)) {
        return validationProblem(
          request,
          [
            {
              field: 'parent_id',
              message: 'The comment being replied to was not found on this post.',
              type: 'value_error',
            },
          ],
          'The submitted comment is not valid.',
        );
      }
    }
    const comment: CommentPublic = {
      id: CREATED_COMMENT_ID,
      post_id: post.id,
      parent_id: parentId ?? null,
      author: toPublicUser(principal),
      body: sanitiseText(text ?? ''),
      status: PENDING_COMMENT_STATUS,
      created_at: INSTANT_CREATED_RESOURCE,
      updated_at: INSTANT_CREATED_RESOURCE,
      reply_count: 0,
      has_more_replies: false,
      replies: [],
    };
    return created(comment);
  }),

  /**
   * Publish a post: transition to PUBLISHED and stamp the publication instant.
   *
   * Carries no request body, so the resolver must not read one. The stamped instant is a fixed
   * value rather than the current time, so the transition is assertable on equality and two runs of
   * the same spec cannot disagree. Ownership-scoped: the author or an administrator, 404 before 403.
   */
  http.post('*/api/v1/posts/:postId/publish', ({ request, params }) => {
    ignoredBody();
    const principal = authenticate(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const post = postToModify(request, pathParam(params.postId), principal);
    if (isPostRefusal(post)) {
      return post;
    }
    const published: PostDetail = {
      ...post,
      status: VISIBLE_POST_STATUS,
      published_at: FIXTURE_PUBLISHED_AT,
      updated_at: FIXTURE_PUBLISHED_AT,
    };
    return ok(published);
  }),

  /**
   * Unpublish a post: transition back to DRAFT.
   *
   * `published_at` is retained rather than cleared, which is not an oversight - the service's check
   * constraint requires the instant only while the status is PUBLISHED, and keeping it means
   * republishing does not lose the date the post first went out.
   */
  http.post('*/api/v1/posts/:postId/unpublish', ({ request, params }) => {
    ignoredBody();
    const principal = authenticate(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const post = postToModify(request, pathParam(params.postId), principal);
    if (isPostRefusal(post)) {
      return post;
    }
    const withdrawn: PostDetail = { ...post, status: 'DRAFT', updated_at: FIXTURE_PUBLISHED_AT };
    return ok(withdrawn);
  }),
];

const postResourceHandlers = [
  /**
   * Post detail, KEYED ON THE SLUG.
   *
   * An unknown slug is 404. So is a slug that names an unpublished post the caller may not read, and
   * 404 rather than 403 on purpose: answering 403 would confirm that a draft exists at that address,
   * which is itself the disclosure the status is meant to prevent.
   *
   * **"May not read" is now the service's own predicate** - the post's author or an administrator -
   * where it used to be "presents any credential". Under the old rule an authenticated reader could
   * read every draft in the fixture set, so a draft-confidentiality assertion written against this
   * module would have passed against a component that leaked one.
   */
  http.get('*/api/v1/posts/:slug', ({ request, params }) => {
    const viewer = optionalPrincipal(request);
    if (isRefusal(viewer)) {
      return viewer;
    }
    const slug = pathParam(params.slug);
    const post = findPostBySlug(slug);
    if (post === undefined || !canViewPost(post, viewer)) {
      return notFound(request, `No published post is available at "${slug}".`);
    }
    return ok(post);
  }),

  /**
   * Partial update, KEYED ON THE UUID.
   *
   * Genuinely partial: only submitted members are applied, and an explicit `null` clears a nullable
   * one. The slug is deliberately NOT re-derived from a changed title - a canonical URL is written
   * once at creation and must not move afterwards, or every link to and every crawl of the post is
   * invalidated by an editorial correction.
   *
   * Bounded exactly as creation is, because `PostUpdate` restates every bound `PostCreate` declares;
   * ownership-scoped, 404 before 403; and an unknown category identifier is a 404.
   */
  http.patch('*/api/v1/posts/:postId', async ({ request, params }) => {
    const principal = authenticate(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const post = postToModify(request, pathParam(params.postId), principal);
    if (isPostRefusal(post)) {
      return post;
    }
    const parsed = await objectBody(request);
    if (!parsed.ok) {
      return validationProblem(request, parsed.errors);
    }
    const body = parsed.value;
    const errors: ValidationErrorItem[] = [];
    rejectExtraMembers(body, POST_MEMBERS, errors);
    // `posts.title` and `posts.content` are NOT NULL, so an explicit null is refused rather than
    // folded to a default - omit the member to leave the stored value alone.
    const title =
      'title' in body ? requireString(body, 'title', BOUNDS.postTitle, errors) : undefined;
    const content =
      'content' in body ? requireString(body, 'content', BOUNDS.postContent, errors) : undefined;
    const excerpt = readOptionalText(body, 'excerpt', BOUNDS.postExcerpt, errors);
    const coverImageUrl = readOptionalUrl(body, 'cover_image_url', errors);
    const categoryIds = readOptionalCategoryIds(body, errors);
    const [first, ...rest] = errors;
    if (first !== undefined) {
      return validationProblem(request, [first, ...rest]);
    }
    const unknown = (categoryIds ?? []).find(
      (categoryId) => findCategoryById(categoryId) === undefined,
    );
    if (unknown !== undefined) {
      return notFound(request, `No category is stored under the identifier ${unknown}.`);
    }
    const updated: PostDetail = {
      ...post,
      title: title ?? post.title,
      excerpt: excerpt === undefined ? post.excerpt : excerpt,
      cover_image_url: coverImageUrl === undefined ? post.cover_image_url : coverImageUrl,
      content: content === undefined ? post.content : sanitiseText(content),
      categories: categoryIds === undefined ? post.categories : toCategorySummaries(categoryIds),
      updated_at: FIXTURE_PUBLISHED_AT,
    };
    return ok(updated);
  }),

  /** Delete a post. 204 with no body; its comments and likes go with it by cascade. */
  http.delete('*/api/v1/posts/:postId', ({ request, params }) => {
    const principal = authenticate(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const post = postToModify(request, pathParam(params.postId), principal);
    return isPostRefusal(post) ? post : noContent();
  }),
];

/* -------------------------------------------------- categories ----------------------------------
 * `GET /categories` answers with a BARE ARRAY. It is the single documented exception to the page
 * envelope across the entire API: the taxonomy is small, bounded and read in full to populate the
 * home page's filter control, so paginating it would oblige that control to page through a list it
 * always needs whole. Wrapping it in an envelope here would break the filter component's tests in a
 * way that reads as a component defect rather than as a fixture one, which is why it is called out.
 *
 * The array is ORDERED BY NAME, ascending. `category_repository` applies `ORDER BY name ASC` at every
 * one of its three read sites, so the order is part of what the filter control renders and not an
 * accident of insertion - a control that relied on the fixture's declaration order would have
 * rendered a different sequence in production, and its test would have said nothing.
 * ---------------------------------------------------------------------------------------------- */

/** The taxonomy in the order the service returns it: by name, ascending, case-insensitively. */
function categoriesByName(): readonly CategoryPublic[] {
  return [...fixtureCategories].sort((left, right) => left.name.localeCompare(right.name));
}

/** Detail for the pre-checked collision on the unique `categories.name`, quoted from the service. */
const CATEGORY_NAME_TAKEN_DETAIL = 'A category with that name already exists.';

/**
 * Whether another category already holds this name, case-insensitively.
 *
 * `categories.name` is uniquely constrained and `CategoryService` pre-checks it on **create and
 * update alike** - `update` asks the question again and raises the same 409, because a rename onto a
 * taken name is the same collision as a creation onto one. The mock enforced it on create only, so a
 * rename that the service refuses came back 200 with two categories apparently sharing a name.
 *
 * @param name - The submitted name.
 * @param excludingId - The category being renamed, so re-submitting its own name is not a collision.
 */
function nameIsTaken(name: string, excludingId: string | undefined): boolean {
  const wanted = name.trim().toLowerCase();
  return fixtureCategories.some(
    (category) => category.id !== excludingId && category.name.toLowerCase() === wanted,
  );
}

/**
 * Whether any stored post is filed under this category - the question `is_in_use` answers.
 *
 * **Not `post_count`.** That member counts PUBLISHED posts only, because the join condition that
 * produces it carries `status = PUBLISHED` for a public filter control. `CategoryRepository.is_in_use`
 * is an `EXISTS` over `post_categories` with **no status predicate at all**, so a draft or an archived
 * post keeps a category undeletable while `post_count` reports zero. Keying the delete on the count
 * therefore permitted a delete the service refuses - and the association cascades, so "permitted"
 * would have meant silently unfiling the term from every post that used it.
 */
function categoryIsInUse(categoryId: string): boolean {
  return fixturePosts.some((post) => post.categories.some((entry) => entry.id === categoryId));
}

const categoryHandlers = [
  /** Every category with its published-post count, un-paginated by contract and name-ordered. */
  http.get('*/api/v1/categories', () => ok(categoriesByName())),

  /** One category, keyed on its slug, as the category landing surface reads it. */
  http.get('*/api/v1/categories/:slug', ({ request, params }) => {
    const slug = pathParam(params.slug);
    const category = findCategoryBySlug(slug);
    if (category === undefined) {
      return notFound(request, `No category is registered under the slug "${slug}".`);
    }
    return ok(category);
  }),
];

/* --------------------------------------------- comments -----------------------------------------
 * The two thread-scoped operations live with the posts sub-paths above, because their paths are
 * `/posts/{id}/comments`. What remains here is addressed by comment identifier: editing a body and
 * deleting a comment, both scoped to the owner or an administrator by the service.
 *
 * BOTH RULES ARE ENFORCED NOW - finding C8. Any credential used to be able to edit or delete any
 * comment, so a spec could not distinguish a component that showed its own reader the edit control
 * from one that showed it to everybody. And an accepted edit **returns an APPROVED comment to
 * PENDING**, whoever made it, which is a visible consequence a comment component has to render: the
 * edited text leaves the public thread until it is approved again.
 * ---------------------------------------------------------------------------------------------- */

/** Whether *viewer* may change *comment*: its author, or an administrator. */
function canModifyComment(comment: CommentPublic, viewer: UserMe): boolean {
  return viewer.id === comment.author.id || viewer.role === ADMIN_ROLE;
}

const commentHandlers = [
  /**
   * Edit a comment's body.
   *
   * Only the body is mutable - authorship, thread position and moderation state are not editable by
   * their author, and a moderation change is an administrative operation with its own route. So
   * `status` in the body is `extra_forbidden` rather than honoured.
   *
   * An `APPROVED` comment returns to `PENDING`; a `REJECTED` one is left rejected, because an edit
   * must not lift a rejection or a rejected author could republish by re-saving.
   *
   * **`{}` is a valid no-op, not a 422.** `CommentUpdate` declares its single member optional and the
   * service applies `model_dump(exclude_unset=True)`, so an omitted `body` means "leave it alone" -
   * which is what makes this a genuine partial update rather than the whole-object replacement the
   * retired `PUT /items/{item_id}` performed. Reading the member as required refused a request the
   * service accepts, and refused it with "Field required" against a member the caller was entitled to
   * omit. A member that IS present is still validated: `{"body": ""}` is too short, and
   * `{"body": null}` is a type error, because the column is NOT NULL.
   */
  http.patch('*/api/v1/comments/:commentId', async ({ request, params }) => {
    const principal = authenticate(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const comment = findCommentById(pathParam(params.commentId));
    if (comment === undefined) {
      return notFound(request, 'No comment is stored under that identifier.');
    }
    if (!canModifyComment(comment, principal)) {
      return forbidden(
        request,
        'Only the comment\u2019s author or an administrator may change it.',
      );
    }
    const parsed = await objectBody(request);
    if (!parsed.ok) {
      return validationProblem(request, parsed.errors);
    }
    const errors: ValidationErrorItem[] = [];
    rejectExtraMembers(parsed.value, COMMENT_UPDATE_MEMBERS, errors);
    // Validated only when the key is present, which is what makes `{}` the no-op the schema declares.
    const text =
      'body' in parsed.value
        ? requireString(parsed.value, 'body', BOUNDS.commentBody, errors)
        : undefined;
    const [first, ...rest] = errors;
    if (first !== undefined) {
      return validationProblem(request, [first, ...rest], 'The submitted comment is not valid.');
    }
    // Nothing sent means nothing written: the stored body, the stored moderation state and the
    // stored `updated_at` all stand, because a no-op that advanced the timestamp or re-queued an
    // approved comment for moderation would be a write dressed up as leaving things alone.
    if (text === undefined) {
      return ok(comment);
    }
    const edited: CommentPublic = {
      ...comment,
      body: sanitiseText(text),
      status: comment.status === VISIBLE_COMMENT_STATUS ? PENDING_COMMENT_STATUS : comment.status,
      updated_at: FIXTURE_PUBLISHED_AT,
    };
    return ok(edited);
  }),

  /** Delete a comment. 204 with no body; any replies beneath it go with it by cascade. */
  http.delete('*/api/v1/comments/:commentId', ({ request, params }) => {
    const principal = authenticate(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const comment = findCommentById(pathParam(params.commentId));
    if (comment === undefined) {
      return notFound(request, 'No comment is stored under that identifier.');
    }
    return canModifyComment(comment, principal)
      ? noContent()
      : forbidden(request, 'Only the comment\u2019s author or an administrator may delete it.');
  }),
];

/* ---------------------------------------------- admin -------------------------------------------
 * Thirteen operations across four entities plus the overview counts - the namespace the AAP's REST
 * inventory declares (§0.6.2). There is deliberately no `GET /admin/categories`: the taxonomy has one
 * read, the public bare array, and the management screen consumes it. Two things are worth stating
 * before reading the rest.
 *
 * FIRST, the path asymmetry is real and not a slip: a status change addresses a `/status` sub-path
 * (`PATCH /admin/posts/{id}/status`, `PATCH /admin/comments/{id}/status`) while a user or category
 * change addresses the resource itself (`PATCH /admin/users/{id}`). The sub-path patterns are
 * declared before the resource patterns accordingly.
 *
 * SECOND, these listings are the only ones that bypass public scoping. The post listing spans DRAFT,
 * PUBLISHED and ARCHIVED, and the comment listing spans PENDING, APPROVED and REJECTED, because a
 * moderation queue that could not see unmoderated rows would have nothing to moderate.
 *
 * EVERY OPERATION BELOW CHECKS THE ROLE, which is finding C6. They used to check only that some
 * bearer was present, so a reader's credential opened every administrative screen under test and the
 * server-side half of the gate AAP §0.10.1 #6 requires was untested by construction - the exported
 * `adminForbiddenHandlers` were the only way to reach a 403, which meant the refusal was reachable
 * only by asking for it. `require_admin` is mounted on the router in production, so the gate is
 * expressed here once, in {@link authenticateAdmin}, and no individual resolver can omit it.
 * ---------------------------------------------------------------------------------------------- */

const adminHandlers = [
  /** Aggregate counts for the overview screen's four stat tiles. */
  http.get('*/api/v1/admin/stats', ({ request }) => {
    const principal = authenticateAdmin(request);
    return isRefusal(principal) ? principal : ok(fixtureAdminStats);
  }),

  /**
   * Every account, filterable by free text over handle and address, by role and by active state.
   * Discloses the address and the role, which the public projection never does.
   *
   * **The term is matched against `username` and `email`, and nothing else.** `UserRepository` builds
   * `username ILIKE :pattern OR email ILIKE :pattern` over those two columns only; including
   * `display_name` here made the mock find rows the service does not, so a search spec could pass
   * against a listing that comes back empty in production.
   *
   * `role` and `is_active` are typed parameters, so a value outside `UserRole` or outside Pydantic's
   * boolean vocabulary is a **422 naming the parameter** rather than a filter accepted and dropped -
   * which is how `?is_active=maybe` came to answer with every account, deactivated ones included.
   */
  http.get('*/api/v1/admin/users', ({ request }) => {
    const principal = authenticateAdmin(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const params = searchParams(request);
    const errors: ValidationErrorItem[] = [];
    const term = readQuery(params, 'q');
    const role = readQueryEnum(params, 'role', USER_ROLE_VALUES, errors);
    const isActive = readQueryBooleanStrict(params, 'is_active', errors);
    const [first, ...rest] = errors;
    if (first !== undefined) {
      return validationProblem(request, [first, ...rest]);
    }
    const rows = storedAccounts
      .filter((account) => matchesTerm(term, account.username, account.email))
      .filter((account) => role === undefined || account.role === role)
      .filter((account) => isActive === undefined || account.is_active === isActive)
      .map(toAdminUser);
    return pageResponse(rows, request);
  }),

  /**
   * Change an account's role or active state. Both members are optional and applied when present.
   *
   * **THE LOCKOUT GUARD.** `AdminService.update_user` refuses three moves an administrator makes
   * against *their own* row, each with a **409**, and it refuses them after resolving the row and
   * before assigning anything, so a refused request leaves the account exactly as it was:
   *
   * - a `role` that was sent and is not `ADMIN` - self-demotion;
   * - `is_active: false` - self-deactivation;
   * - (and self-deletion, on the route below).
   *
   * Three moves are deliberately NOT refused, and modelling them as refusals would be as wrong as
   * omitting the guard: an **empty patch** is a successful no-op (a management form submitted without
   * edits is legitimate), re-sending **`ADMIN`** is a no-op because the actor already holds it, and
   * `is_active: true` is a request to stay active rather than a lockout.
   *
   * The guard is the server's rule and `UserRowActions` deliberately does not duplicate it - it relies
   * on this refusal arriving - so a mock that let an administrator demote, suspend or delete itself
   * made the one path that protects an installation from being locked out untestable.
   */
  http.patch('*/api/v1/admin/users/:userId', async ({ request, params }) => {
    const principal = authenticateAdmin(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const account = findAccountById(pathParam(params.userId));
    if (account === undefined) {
      return notFound(request, 'No account is stored under that identifier.');
    }
    const parsed = await objectBody(request);
    if (!parsed.ok) {
      return validationProblem(request, parsed.errors);
    }
    const errors: ValidationErrorItem[] = [];
    rejectExtraMembers(parsed.value, ADMIN_USER_MEMBERS, errors);
    const role = readEnumMember(parsed.value, 'role', USER_ROLE_VALUES, errors);
    const isActive = readBooleanMember(parsed.value, 'is_active', errors);
    const [first, ...rest] = errors;
    if (first !== undefined) {
      return validationProblem(request, [first, ...rest]);
    }
    if (account.id === principal.id) {
      // `role !== undefined` is the test for "was sent", exactly as the service uses
      // `payload.role is not None`; and `isActive === false` rather than a falsy test, because
      // `undefined` means the member was omitted.
      if (role !== undefined && role !== ADMIN_ROLE) {
        return conflict(request, SELF_DEMOTION_DETAIL);
      }
      if (isActive === false) {
        return conflict(request, SELF_DEACTIVATION_DETAIL);
      }
    }
    const updated: AdminUser = {
      ...toAdminUser(account),
      role: role ?? account.role,
      is_active: isActive ?? account.is_active,
      updated_at: FIXTURE_PUBLISHED_AT,
    };
    return ok(updated);
  }),

  /**
   * Remove an account. 204; their posts, comments, likes and tokens go with it by cascade.
   *
   * The third lockout guard: deleting **your own** account is a 409, because an administrator who
   * removed themselves would take their authority with them and no route remains to restore it.
   */
  http.delete('*/api/v1/admin/users/:userId', ({ request, params }) => {
    const principal = authenticateAdmin(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const account = findAccountById(pathParam(params.userId));
    if (account === undefined) {
      return notFound(request, 'No account is stored under that identifier.');
    }
    return account.id === principal.id ? conflict(request, SELF_DELETION_DETAIL) : noContent();
  }),

  /**
   * Every post across ALL three lifecycle states - the one listing that ignores public scoping.
   *
   * **The term is matched against `title`, `excerpt` and `content`.** The service ranks this listing
   * with the same full-text search the public feed uses, and that vector is built from those three
   * members - so a term that appears only in an article's body finds it. The slug is not searched: it
   * is a derived address, not authored text, and matching it made the mock find rows on a value no
   * operator types.
   *
   * `status` and `author_id` are typed parameters, so an unrecognised lifecycle state or a malformed
   * identifier is a 422 rather than an unfiltered listing.
   */
  http.get('*/api/v1/admin/posts', ({ request }) => {
    const principal = authenticateAdmin(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const params = searchParams(request);
    const errors: ValidationErrorItem[] = [];
    const term = readQuery(params, 'q');
    const status = readQueryEnum(params, 'status', POST_STATUS_VALUES, errors);
    const authorId = readQueryUuid(params, 'author_id', errors);
    const [first, ...rest] = errors;
    if (first !== undefined) {
      return validationProblem(request, [first, ...rest]);
    }
    const rows = fixturePosts
      .filter((post) => matchesTerm(term, post.title, post.excerpt, post.content))
      .filter((post) => status === undefined || post.status === status)
      .filter((post) => authorId === undefined || post.author.id === authorId)
      .sort(byRecency)
      .map(toAdminPost);
    return pageResponse(rows, request);
  }),

  /** Force a post's lifecycle state. Declared before the resource pattern below. */
  http.patch('*/api/v1/admin/posts/:postId/status', async ({ request, params }) => {
    const principal = authenticateAdmin(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const post = findPostById(pathParam(params.postId));
    if (post === undefined) {
      return notFound(request, 'No post is stored under that identifier.');
    }
    const parsed = await objectBody(request);
    if (!parsed.ok) {
      return validationProblem(request, parsed.errors);
    }
    const errors: ValidationErrorItem[] = [];
    rejectExtraMembers(parsed.value, STATUS_MEMBER, errors);
    // `status` has no default on this model, so an empty body is a 422 naming it rather than a
    // silent no-op that reports the state the row already held.
    const status = requireEnumMember(parsed.value, 'status', POST_STATUS_VALUES, errors);
    const [first, ...rest] = errors;
    if (first !== undefined) {
      return validationProblem(request, [first, ...rest]);
    }
    const updated: AdminPost = {
      ...toAdminPost(post),
      status: status ?? post.status,
      published_at:
        status === VISIBLE_POST_STATUS
          ? (post.published_at ?? FIXTURE_PUBLISHED_AT)
          : post.published_at,
      updated_at: FIXTURE_PUBLISHED_AT,
    };
    return ok(updated);
  }),

  /** Remove a post administratively. 204. */
  http.delete('*/api/v1/admin/posts/:postId', ({ request, params }) => {
    const principal = authenticateAdmin(request);
    if (isRefusal(principal)) {
      return principal;
    }
    return findPostById(pathParam(params.postId)) === undefined
      ? notFound(request, 'No post is stored under that identifier.')
      : noContent();
  }),

  /**
   * The moderation queue: every comment in every state, roots and replies alike, flattened.
   *
   * **The term is matched against the body, and only the body.** `CommentRepository` applies a single
   * `body ILIKE :pattern`; searching the author's handle as well made the mock answer a moderator's
   * search for a phrase with every comment a matching *person* wrote, which is a different query.
   *
   * `status` and `post_id` are typed, so an unrecognised moderation state or a malformed identifier is
   * a 422 rather than the whole queue.
   */
  http.get('*/api/v1/admin/comments', ({ request }) => {
    const principal = authenticateAdmin(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const params = searchParams(request);
    const errors: ValidationErrorItem[] = [];
    const term = readQuery(params, 'q');
    const status = readQueryEnum(params, 'status', COMMENT_STATUS_VALUES, errors);
    const postId = readQueryUuid(params, 'post_id', errors);
    const [first, ...rest] = errors;
    if (first !== undefined) {
      return validationProblem(request, [first, ...rest]);
    }
    const rows = fixtureComments
      .filter((comment) => matchesTerm(term, comment.body))
      .filter((comment) => status === undefined || comment.status === status)
      .filter((comment) => postId === undefined || comment.post_id === postId)
      .map(toAdminComment);
    return pageResponse(rows, request);
  }),

  /** Approve or reject a comment. Declared before the resource pattern below. */
  http.patch('*/api/v1/admin/comments/:commentId/status', async ({ request, params }) => {
    const principal = authenticateAdmin(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const comment = findCommentById(pathParam(params.commentId));
    if (comment === undefined) {
      return notFound(request, 'No comment is stored under that identifier.');
    }
    const parsed = await objectBody(request);
    if (!parsed.ok) {
      return validationProblem(request, parsed.errors);
    }
    const errors: ValidationErrorItem[] = [];
    rejectExtraMembers(parsed.value, STATUS_MEMBER, errors);
    const status = requireEnumMember(parsed.value, 'status', COMMENT_STATUS_VALUES, errors);
    const [first, ...rest] = errors;
    if (first !== undefined) {
      return validationProblem(request, [first, ...rest]);
    }
    const updated: AdminComment = {
      ...toAdminComment(comment),
      status: status ?? comment.status,
      updated_at: FIXTURE_PUBLISHED_AT,
    };
    return ok(updated);
  }),

  /** Remove a comment administratively. 204. */
  http.delete('*/api/v1/admin/comments/:commentId', ({ request, params }) => {
    const principal = authenticateAdmin(request);
    if (isRefusal(principal)) {
      return principal;
    }
    return findCommentById(pathParam(params.commentId)) === undefined
      ? notFound(request, 'No comment is stored under that identifier.')
      : noContent();
  }),

  // There is deliberately NO handler for a GET on the admin categories collection, because the
  // service declares no such operation: the taxonomy has one collection, the public
  // `GET /categories`, and the administrative management table renders and filters over the bare
  // array that read answers with. A mock for a route the API does not publish is how a component
  // comes to depend on one.

  /**
   * Create a category. 201, with the slug derived from the submitted name and no posts in it yet.
   *
   * `id` and `slug` are server-owned and are therefore `extra_forbidden` rather than ignored: a client
   * that believed it had chosen a canonical URL, and had not, would generate links that never resolve.
   *
   * A name already in the taxonomy is a **409** - `categories.name` is uniquely constrained and the
   * service pre-checks it. A *slug* collision is not: the service derives the slug from the name and
   * allocates around whatever is taken, so "Machine Learning" filed beside an existing
   * `machine-learning` succeeds with a suffixed address, and that resolved value comes back in the
   * response for the client to link to.
   */
  http.post('*/api/v1/admin/categories', async ({ request }) => {
    const principal = authenticateAdmin(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const parsed = await objectBody(request);
    if (!parsed.ok) {
      return validationProblem(request, parsed.errors);
    }
    const errors: ValidationErrorItem[] = [];
    rejectExtraMembers(parsed.value, CATEGORY_MEMBERS, errors);
    const name = requireString(parsed.value, 'name', BOUNDS.categoryName, errors);
    const description = readOptionalText(
      parsed.value,
      'description',
      BOUNDS.categoryDescription,
      errors,
    );
    const [first, ...rest] = errors;
    if (first !== undefined) {
      return validationProblem(request, [first, ...rest]);
    }
    if (nameIsTaken(name ?? '', undefined)) {
      return conflict(request, CATEGORY_NAME_TAKEN_DETAIL);
    }
    const category: CategoryPublic = {
      id: CREATED_CATEGORY_ID,
      name: name ?? '',
      slug: allocateSlug(
        name ?? '',
        fixtureCategories.map((existing) => existing.slug),
      ),
      description: description ?? null,
      // A category created a moment ago has no post filed under it: `post_categories` rows are
      // written by the post lifecycle and nothing on this path writes one.
      post_count: 0,
      created_at: INSTANT_CREATED_RESOURCE,
    };
    return created(category);
  }),

  /**
   * Rename a category or change its description.
   *
   * The slug is retained on a rename, for the same reason a post's is: it is the address the
   * taxonomy is linked and crawled under, and renaming a label is not a reason to break that.
   *
   * **A rename onto a name another category holds is a 409**, the same refusal a creation earns:
   * `CategoryService.update` re-asks the uniqueness question rather than trusting that only creation
   * can collide. Re-submitting the category's *own* name is not a collision and is a plain no-op.
   */
  http.patch('*/api/v1/admin/categories/:categoryId', async ({ request, params }) => {
    const principal = authenticateAdmin(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const category = findCategoryById(pathParam(params.categoryId));
    if (category === undefined) {
      return notFound(request, 'No category is stored under that identifier.');
    }
    const parsed = await objectBody(request);
    if (!parsed.ok) {
      return validationProblem(request, parsed.errors);
    }
    const errors: ValidationErrorItem[] = [];
    rejectExtraMembers(parsed.value, CATEGORY_MEMBERS, errors);
    const name =
      'name' in parsed.value
        ? requireString(parsed.value, 'name', BOUNDS.categoryName, errors)
        : undefined;
    const description = readOptionalText(
      parsed.value,
      'description',
      BOUNDS.categoryDescription,
      errors,
    );
    const [first, ...rest] = errors;
    if (first !== undefined) {
      return validationProblem(request, [first, ...rest]);
    }
    if (name !== undefined && nameIsTaken(name, category.id)) {
      return conflict(request, CATEGORY_NAME_TAKEN_DETAIL);
    }
    const updated: CategoryPublic = {
      ...category,
      name: name ?? category.name,
      description: description === undefined ? category.description : description,
    };
    return ok(updated);
  }),

  /**
   * Remove a category. 204, unless a post is still filed under it, which is a 409.
   *
   * The guard is keyed on the ASSOCIATIONS, not on `post_count` - see {@link categoryIsInUse} for why
   * those are different questions and why using the count permitted a delete the service refuses.
   */
  http.delete('*/api/v1/admin/categories/:categoryId', ({ request, params }) => {
    const principal = authenticateAdmin(request);
    if (isRefusal(principal)) {
      return principal;
    }
    const category = findCategoryById(pathParam(params.categoryId));
    if (category === undefined) {
      return notFound(request, 'No category is stored under that identifier.');
    }
    return categoryIsInUse(category.id) ? conflict(request, CATEGORY_IN_USE_DETAIL) : noContent();
  }),
];

/* ---------------------------------------------- health ------------------------------------------
 * The only two UNVERSIONED paths in the API, and the patterns below say so.
 *
 * They used to be `'*​/healthz'` and `'*​/readyz'`, and a leading `*` matches any number of segments -
 * so `/api/v1/healthz` matched too, and a probe addressed under the version prefix answered 200 in
 * every spec while answering 404 in production. `app.main` mounts the health router with no prefix
 * precisely so a probe does not move when the API is versioned, and a fixture that answered both
 * addresses made that guarantee unobservable.
 *
 * The regular expressions therefore anchor on the ORIGIN: `healthz` must be the first path segment.
 * The two prefixed addresses are then answered explicitly with the 404 the service sends, rather than
 * left unmatched - an unmatched request under `onUnhandledRequest: 'error'` fails as a harness fault,
 * and the point here is that the address genuinely does not exist.
 * ---------------------------------------------------------------------------------------------- */

/** Matches `<origin>/healthz` and nothing nested beneath a prefix. */
const LIVENESS_PATTERN = /^[a-z]+:\/\/[^/]+\/healthz\/?(?:\?.*)?$/;

/** Matches `<origin>/readyz` and nothing nested beneath a prefix. */
const READINESS_PATTERN = /^[a-z]+:\/\/[^/]+\/readyz\/?(?:\?.*)?$/;

const healthHandlers = [
  /** Liveness. Answers without touching a database, and claims nothing about one. */
  http.get(LIVENESS_PATTERN, () => {
    const report: LivenessReport = { status: 'alive' };
    return ok(report);
  }),

  /** Readiness. Answers only while a trivial query succeeds, so it does claim something about one. */
  http.get(READINESS_PATTERN, () => {
    const report: ReadinessReport = { status: 'ready', database: true };
    return ok(report);
  }),

  /** Neither probe is mounted under the version prefix, so both prefixed addresses are 404. */
  http.get('*/api/v1/healthz', ({ request }) =>
    notFound(request, 'The health probes are unversioned. Address /healthz.'),
  ),
  http.get('*/api/v1/readyz', ({ request }) =>
    notFound(request, 'The health probes are unversioned. Address /readyz.'),
  ),
];

/* =================================================================================================
 * THE DEFAULT HANDLER SET
 *
 * One flat array, spread into `setupServer` by whichever spec owns the server lifecycle. The order
 * of the groups reproduces the ordering constraints documented above: the posts collection patterns
 * precede the posts sub-paths, which precede the posts resource patterns, and the users group has
 * `/users/me` ahead of `/users/:username`.
 *
 * Coverage here is complete rather than representative, because a suite listening with
 * `onUnhandledRequest: 'error'` fails any test that provokes a request this array does not answer.
 * That is the intended feedback loop: an uncovered request surfaces as a failure naming the URL, and
 * the fix is a handler added here - never a loosened listen option.
 *
 * Thirty-seven versioned operations plus the two operational probes.
 * ============================================================================================== */

export const handlers = [
  ...authHandlers,
  ...userHandlers,
  ...postCollectionHandlers,
  ...postSubResourceHandlers,
  ...postResourceHandlers,
  ...categoryHandlers,
  ...commentHandlers,
  ...adminHandlers,
  ...healthHandlers,
];

/* =================================================================================================
 * FAILURE HANDLERS
 *
 * Deliberately NOT part of `handlers`. The default array is the happy path; a spec that wants to
 * assert on error presentation overrides one route for the duration of one test:
 *
 *     server.use(...postNotFoundHandlers);
 *
 * Each group is an array so it spreads the same way `handlers` does, and each answers through the
 * same `problem` builder, so an error surface rendered under test is rendering the one problem
 * document the service actually emits - the same `type`, the same `title`, a populated `request_id`,
 * and the same `Retry-After` and `WWW-Authenticate` headers the client reads.
 * ============================================================================================== */

/**
 * Every post read answers 404, whatever slug is addressed.
 *
 * Distinct from the default set's own miss handling, which 404s only an unknown slug: this one 404s
 * the slug the fixtures DO hold, which is what lets a spec drive the not-found branch of a detail
 * page without inventing an address the component would refuse to build a link to.
 */
export const postNotFoundHandlers = [
  http.get('*/api/v1/posts/:slug', ({ request }) =>
    notFound(request, 'No published post is available at that address.'),
  ),
];

/** Every profile read answers 404, so a profile page's not-found branch is reachable. */
export const profileNotFoundHandlers = [
  http.get('*/api/v1/users/:username/posts', ({ request }) =>
    notFound(request, 'No author is registered under that handle.'),
  ),
  http.get('*/api/v1/users/:username', ({ request }) =>
    notFound(request, 'No author is registered under that handle.'),
  ),
];

/**
 * The protected reads answer 401 unconditionally - even to a caller presenting a VALID bearer.
 *
 * Still needed after finding C5, and for a narrower reason than before: the default set now refuses
 * an unknown or forged bearer on its own, so a spec that merely wants "the credential is not
 * accepted" can attach {@link FIXTURE_UNKNOWN_ACCESS_TOKEN} instead. What only this group can do is
 * refuse a credential that *is* recognised, which is what an expired-token rotation looks like from
 * the client's side.
 *
 * This is what drives the client's single-flight rotation: it sees a 401 on a request that carried a
 * credential, calls `POST /auth/refresh` once however many requests are in flight, and replays. Pair
 * it with `refreshRejectedHandlers` to make that rotation fail and observe the session being
 * abandoned, or leave the default refresh handler in place to observe a successful replay.
 */
export const unauthorizedHandlers = [
  http.get('*/api/v1/auth/me', ({ request }) => unauthorized(request)),
  http.patch('*/api/v1/users/me', ({ request }) => unauthorized(request)),
  http.post('*/api/v1/posts', ({ request }) => unauthorized(request)),
  http.get('*/api/v1/admin/stats', ({ request }) => unauthorized(request)),
];

/**
 * Rotation itself fails.
 *
 * With this in place a 401 on a credentialled request cannot be recovered, so the client clears its
 * credentials and invokes the unauthorized handler the session provider registered - which is the
 * path a "your session expired" surface is built on.
 */
export const refreshRejectedHandlers = [
  http.post('*/api/v1/auth/refresh', ({ request }) =>
    problem({
      status: HTTP_UNAUTHORIZED,
      type: ERROR_TYPE_UNAUTHORIZED,
      title: ERROR_TITLE_UNAUTHORIZED,
      detail: 'The refresh token has been revoked or has expired. Sign in again to continue.',
      instance: requestInstance(request),
      headers: { [WWW_AUTHENTICATE_HEADER]: WWW_AUTHENTICATE_BEARER },
    }),
  ),
];

/**
 * The administrative namespace answers 403 to **any** authenticated caller, an administrator included.
 *
 * 403 rather than 401 is the distinction that matters: the credential is fine, the authority is not,
 * so retrying with a fresh token cannot help and the client must not attempt a rotation.
 *
 * Note what this is now *for*, because it changed. The default set refuses a reader or an author on
 * its own - see {@link authenticateAdmin} - so a spec asserting "a reader is refused the
 * administrative screens" should present `FIXTURE_READER_ACCESS_TOKEN` against the defaults and
 * observe the real gate. This group remains for the case the defaults cannot express: refusing a
 * caller who *is* an administrator, which is how a spec drives an authorisation error surface without
 * having to hold a credential that is wrong for some other reason.
 */
export const adminForbiddenHandlers = [
  http.get('*/api/v1/admin/stats', ({ request }) =>
    forbidden(request, 'This operation is restricted to administrators.'),
  ),
  http.get('*/api/v1/admin/users', ({ request }) =>
    forbidden(request, 'This operation is restricted to administrators.'),
  ),
  http.get('*/api/v1/admin/posts', ({ request }) =>
    forbidden(request, 'This operation is restricted to administrators.'),
  ),
  http.get('*/api/v1/admin/comments', ({ request }) =>
    forbidden(request, 'This operation is restricted to administrators.'),
  ),
];

/**
 * Registration collides with an existing account.
 *
 * 409 with the detail the service actually sends, which **does not say which identity collided** -
 * `auth_service._IDENTIFIER_TAKEN`, one sentence for a taken address and a taken handle alike. It
 * used to read "An account already exists with that email address", and that was not a harmless
 * paraphrase: it would have taught a sign-up form to mark the email control specifically, from a
 * document that cannot support the claim, and it modelled the route as an oracle for which addresses
 * are registered. Both identities are case-insensitively unique, so a differently-cased address
 * collides too - and still without being named.
 *
 * The default set reaches this on its own for a body naming a fixture account's address or handle;
 * this group forces it for any body at all.
 */
export const registrationConflictHandlers = [
  http.post('*/api/v1/auth/register', ({ request }) => conflict(request, IDENTIFIER_TAKEN_DETAIL)),
];

/**
 * Deleting a category is refused because posts are still filed under it.
 *
 * The override the delete handler's commentary used to promise and `errorHandlers` did not contain.
 * The default handler now raises this conflict by itself for any fixture whose `post_count` is
 * non-zero, so this group exists for the other direction: forcing the refusal on a category that has
 * none, which is how a spec drives `CategoryForm`'s in-place refusal without depending on which
 * fixture happens to carry posts.
 */
export const categoryInUseHandlers = [
  http.delete('*/api/v1/admin/categories/:categoryId', ({ request }) =>
    conflict(request, CATEGORY_IN_USE_DETAIL),
  ),
];

/**
 * Registration is refused field by field.
 *
 * The `errors` member is populated, because a form that maps field-level failures back onto its own
 * inputs cannot be tested against a problem document that carries only a summary. Each entry names
 * the field, the message to render beside it and the machine-readable reason.
 */
export const registrationValidationHandlers = [
  http.post('*/api/v1/auth/register', ({ request }) =>
    problem({
      status: HTTP_UNPROCESSABLE_CONTENT,
      type: ERROR_TYPE_VALIDATION,
      title: ERROR_TITLE_VALIDATION,
      detail: 'The submitted registration is not valid.',
      instance: requestInstance(request),
      errors: [
        { field: 'email', message: 'Enter a valid email address.', type: 'value_error' },
        {
          field: 'password',
          message: 'Use at least 12 characters.',
          type: 'string_too_short',
        },
      ],
    }),
  ),
];

/** A comment submission is refused field by field, for the comment form's own error surface. */
export const commentValidationHandlers = [
  http.post('*/api/v1/posts/:postId/comments', ({ request }) =>
    problem({
      status: HTTP_UNPROCESSABLE_CONTENT,
      type: ERROR_TYPE_VALIDATION,
      title: ERROR_TITLE_VALIDATION,
      detail: 'The submitted comment is not valid.',
      instance: requestInstance(request),
      errors: [{ field: 'body', message: 'Write something first.', type: 'string_too_short' }],
    }),
  ),
];

/**
 * Sign-in is rate limited.
 *
 * The `Retry-After` header is set as well as the document, because the client parses that header
 * into `ApiError.retryAfterSeconds` and a form that tells the visitor how long to wait reads it from
 * there rather than from the prose.
 */
export const loginRateLimitedHandlers = [
  http.post('*/api/v1/auth/login', ({ request }) =>
    problem({
      status: HTTP_TOO_MANY_REQUESTS,
      type: ERROR_TYPE_RATE_LIMITED,
      title: ERROR_TITLE_RATE_LIMITED,
      detail: 'Too many sign-in attempts. Wait before trying again.',
      instance: requestInstance(request),
      headers: { [RETRY_AFTER_HEADER]: String(FIXTURE_RETRY_AFTER_SECONDS) },
    }),
  ),
];

/**
 * Every named failure group, keyed by the scenario it stands for.
 *
 * Convenient when a spec parameterises over error presentation - iterating the entry set renders
 * each surface in turn - and it keeps the groups discoverable from one symbol.
 */
export const errorHandlers = {
  postNotFound: postNotFoundHandlers,
  profileNotFound: profileNotFoundHandlers,
  unauthorized: unauthorizedHandlers,
  refreshRejected: refreshRejectedHandlers,
  adminForbidden: adminForbiddenHandlers,
  categoryInUse: categoryInUseHandlers,
  registrationConflict: registrationConflictHandlers,
  registrationValidation: registrationValidationHandlers,
  commentValidation: commentValidationHandlers,
  loginRateLimited: loginRateLimitedHandlers,
} as const;
