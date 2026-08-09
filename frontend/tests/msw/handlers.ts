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
 *     count would contradict the system it stands in for.
 *
 * THE CONTRACTS IT HONOURS
 *
 *  - Every collection answers with the five-field `Page<T>` envelope: `items`, `total`, `page`,
 *    `page_size`, `pages`. `GET /categories` is the one documented exception across the whole API -
 *    it answers with a bare array, because it powers the home page's filter control and is
 *    un-paginated by contract.
 *  - Every failure answers with one uniform `ProblemDetail`, built by the single `problem` helper
 *    below so the error contract is declared once. Its `type` and `title` values match the closed
 *    `/errors/...` set the service emits, and its `request_id` is populated because
 *    `src/lib/api/client.ts` substitutes a synthesised document for any problem body that omits it.
 *  - Every domain path sits under `/api/v1`. The two operational probes, `/healthz` and `/readyz`,
 *    are the only unversioned paths.
 *  - Field names stay snake_case, exactly as the API emits them: there is no camelCase translation
 *    layer anywhere in the tier, so introducing one here would test a shape that never ships.
 *  - Identity is a UUID string and every timestamp is an ISO-8601 string, never a `Date`. JSON
 *    carries no date type, so a `Date` in a fixture would be silently stringified and would let a
 *    component that mishandles the string form pass anyway.
 *
 * HOW AUTHORISATION IS MODELLED
 *
 * The default handler array is the happy path, and it authenticates by the presence of a bearer
 * credential: a protected route answers 401 with `WWW-Authenticate: Bearer` when the request
 * carries no `Authorization` header, so no privileged shape is ever returned to an anonymous
 * caller, and so the client's single-flight refresh path is reachable. It deliberately does not
 * model roles - any bearer is admitted to the administrative namespace - because role refusal is a
 * failure scenario a test opts into with `server.use(...)`. The named failure handlers exported at
 * the end of this module cover exactly that: unconditional 401, 403, 404, 409, 422 and 429
 * answers, kept out of the default array so the default array stays the happy path.
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
const BEARER_PREFIX = 'Bearer ';
const WWW_AUTHENTICATE_HEADER = 'WWW-Authenticate';
const WWW_AUTHENTICATE_BEARER = 'Bearer';
const RETRY_AFTER_HEADER = 'Retry-After';
const REQUEST_ID_HEADER = 'X-Request-ID';

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
 * Exported because a test computing an expected `pages` count needs the same divisor the handlers
 * use; duplicating the literal in a spec is how the two drift apart.
 */
export const DEFAULT_PAGE_SIZE = 10;

/** Largest window the service will serve, matching the ceiling the typed wrappers enforce. */
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
const VISIBLE_COMMENT_STATUS: CommentStatus = 'APPROVED';

/** The lifecycle state at which a post enters the public feed. */
const VISIBLE_POST_STATUS: PostStatus = 'PUBLISHED';

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
 * The three access-token placeholders, one per signable-in account, plus the rotated one.
 *
 * They exist so that the identity of the caller is a property of the *request* rather than of
 * remembered state. `GET /auth/me` answers with whichever account the presented token names, so an
 * administrative spec can sign in as the administrator and be recognised as one, without this
 * module holding a session anywhere. Any bearer this map does not know is admitted as the author,
 * so a spec that invents a token still reaches the happy path.
 */
export const FIXTURE_AUTHOR_ACCESS_TOKEN = 'fixture-author-access-token';
export const FIXTURE_READER_ACCESS_TOKEN = 'fixture-reader-access-token';
export const FIXTURE_ADMIN_ACCESS_TOKEN = 'fixture-admin-access-token';
export const FIXTURE_ROTATED_ACCESS_TOKEN = 'fixture-rotated-access-token';

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
 * The pair `POST /auth/refresh` answers with.
 *
 * Both members differ from every pair above, which is the whole point: a test can prove the client
 * replaced its held credentials rather than merely re-read them, and can prove the refresh token
 * itself rotated rather than being reissued unchanged.
 */
export const fixtureRotatedTokenPair: TokenPair = {
  access_token: FIXTURE_ROTATED_ACCESS_TOKEN,
  refresh_token: 'fixture-rotated-refresh-token',
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

/** Every category, in the order `GET /categories` reports them. */
export const fixtureCategories: readonly CategoryPublic[] = [
  fixtureEngineeringCategory,
  fixtureDesignCategory,
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
 * Aggregate counts for the administrative overview.
 *
 * Consistent with the stored fixtures: four accounts, seven posts, five comments, three categories.
 * A spec that renders four stat tiles and asserts the figures reads them from here.
 */
export const fixtureAdminStats: AdminStats = {
  user_count: 4,
  post_count: 7,
  comment_count: 5,
  category_count: 3,
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

/** Parse a request body as JSON, yielding `undefined` for an absent or unparseable body. */
async function readJsonBody(request: Request): Promise<unknown> {
  try {
    const parsed: unknown = await request.json();
    return parsed;
  } catch {
    return undefined;
  }
}

/** View an unknown value as a keyed record, yielding an empty one for anything else. */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

/** Read a request body as a keyed record in one step. */
async function readJsonRecord(request: Request): Promise<Record<string, unknown>> {
  return asRecord(await readJsonBody(request));
}

/** Read a string member, yielding `undefined` when it is absent or not a string. */
function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Read a member that the contract declares as `string | null`.
 *
 * Three outcomes, and the distinction between the last two is the whole point of a partial update:
 * a string sets the field, an explicit `null` clears it, and `undefined` leaves it untouched.
 */
function readNullableString(
  source: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = source[key];
  if (value === null) {
    return null;
  }
  return typeof value === 'string' ? value : undefined;
}

/** Read an array-of-strings member, ignoring any element that is not a string. */
function readStringArray(source: Record<string, unknown>, key: string): string[] | undefined {
  const value = source[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const members: unknown[] = value;
  return members.filter((member): member is string => typeof member === 'string');
}

/** Read a member constrained to the post lifecycle set, yielding `undefined` for anything else. */
function readPostStatus(source: Record<string, unknown>, key: string): PostStatus | undefined {
  const value = source[key];
  return POST_STATUS_VALUES.find((candidate) => candidate === value);
}

/** Read a member constrained to the moderation set. */
function readCommentStatus(
  source: Record<string, unknown>,
  key: string,
): CommentStatus | undefined {
  const value = source[key];
  return COMMENT_STATUS_VALUES.find((candidate) => candidate === value);
}

/** Read a member constrained to the role set. */
function readUserRole(source: Record<string, unknown>, key: string): UserRole | undefined {
  const value = source[key];
  return USER_ROLE_VALUES.find((candidate) => candidate === value);
}

/** Read a boolean member. */
function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Read a single form field from an `application/x-www-form-urlencoded` body. */
async function readFormField(request: Request, field: string): Promise<string | undefined> {
  try {
    const body = await request.formData();
    const value = body.get(field);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The bearer credential the request presents, or `undefined` when it presents none.
 *
 * Presence, not cryptographic validity: the default handler set has no key to verify against, and
 * inventing a token store would be exactly the mutable state this module is built to avoid. What it
 * buys is that no protected route ever answers an anonymous caller with a privileged shape, and
 * that the client's single-flight refresh path is reachable from a realistic 401.
 */
function bearerToken(request: Request): string | undefined {
  const header = request.headers.get(AUTHORIZATION_HEADER);
  if (header === null || !header.startsWith(BEARER_PREFIX)) {
    return undefined;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token === '' ? undefined : token;
}

/** Which account a presented access token names. Unrecognised placeholders resolve to the author. */
const accountsByAccessToken: ReadonlyMap<string, UserMe> = new Map([
  [FIXTURE_AUTHOR_ACCESS_TOKEN, fixtureAuthorAccount],
  [FIXTURE_READER_ACCESS_TOKEN, fixtureReaderAccount],
  [FIXTURE_ADMIN_ACCESS_TOKEN, fixtureAdminAccount],
  [FIXTURE_ROTATED_ACCESS_TOKEN, fixtureAuthorAccount],
]);

/** Which pair signing in with a given address yields. */
const tokenPairsByEmail: ReadonlyMap<string, TokenPair> = new Map([
  [fixtureAuthorAccount.email, fixtureTokenPair],
  [fixtureReaderAccount.email, fixtureReaderTokenPair],
  [fixtureAdminAccount.email, fixtureAdminTokenPair],
]);

/**
 * Resolve the calling principal from the request alone.
 *
 * `undefined` means anonymous, which every protected resolver answers with 401. A recognised token
 * names its account; anything else present is admitted as the author.
 */
function resolvePrincipal(request: Request): UserMe | undefined {
  const token = bearerToken(request);
  if (token === undefined) {
    return undefined;
  }
  return accountsByAccessToken.get(token) ?? fixtureAuthorAccount;
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

/** Read a query parameter constrained to the post lifecycle set. */
function readQueryPostStatus(params: URLSearchParams, key: string): PostStatus | undefined {
  const value = readQuery(params, key);
  return POST_STATUS_VALUES.find((candidate) => candidate === value);
}

/** Read a query parameter constrained to the moderation set. */
function readQueryCommentStatus(params: URLSearchParams, key: string): CommentStatus | undefined {
  const value = readQuery(params, key);
  return COMMENT_STATUS_VALUES.find((candidate) => candidate === value);
}

/** Read a query parameter constrained to the role set. */
function readQueryUserRole(params: URLSearchParams, key: string): UserRole | undefined {
  const value = readQuery(params, key);
  return USER_ROLE_VALUES.find((candidate) => candidate === value);
}

/**
 * Read a query parameter that carries a boolean.
 *
 * The client serialises a boolean query value with `String(value)`, so `true` and `false` arrive as
 * those two words and nothing else is a boolean.
 */
function readQueryBoolean(params: URLSearchParams, key: string): boolean | undefined {
  const value = readQuery(params, key);
  if (value === 'true') {
    return true;
  }
  return value === 'false' ? false : undefined;
}

/** Read a whole number at or above one, ignoring anything else. */
function readPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= FIRST_PAGE ? parsed : undefined;
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
  return HttpResponse.json(body, {
    status: options.status,
    headers: { [REQUEST_ID_HEADER]: FIXTURE_REQUEST_ID, ...options.headers },
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

/** A 204 answer. The body is null, because a 204 that carries one is not a valid response. */
function noContent(): Response {
  return new HttpResponse(null, { status: HTTP_NO_CONTENT });
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
 * Resolve `page` and `page_size` from the query string, applying the service's own bounds.
 *
 * An unparseable or out-of-bounds value falls back to the default rather than failing the request,
 * which mirrors a normalising dependency rather than a validating one; a page number past the last
 * page is legitimate and is honoured, because the answer to it is an empty window, not an error.
 */
function readPageRequest(params: URLSearchParams): PageRequest {
  const page = readPositiveInteger(readQuery(params, 'page')) ?? FIRST_PAGE;
  const requested = readPositiveInteger(readQuery(params, 'page_size')) ?? DEFAULT_PAGE_SIZE;
  return { page, pageSize: Math.min(requested, MAX_PAGE_SIZE) };
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

/** Window a collection read straight from the query string. */
function pageOf<T>(rows: readonly T[], request: Request): Page<T> {
  return paginate(rows, readPageRequest(searchParams(request)));
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

/** Recency ordering: newest publication first, falling back to creation for an unpublished post. */
function byRecency(left: PostDetail, right: PostDetail): number {
  const leftAt = left.published_at ?? left.created_at;
  const rightAt = right.published_at ?? right.created_at;
  if (leftAt === rightAt) {
    return left.title.localeCompare(right.title);
  }
  return leftAt < rightAt ? 1 : -1;
}

/**
 * Relevance ordering: strongest match first, then most-viewed, then most recent.
 *
 * With no search term every post scores zero, so the ordering degrades to engagement - which is
 * still a different sequence from recency, and deliberately so: a spec that switches `sort` from
 * `recent` to `relevance` must be able to observe that the order changed.
 */
function byRelevance(term: string) {
  return (left: PostDetail, right: PostDetail): number => {
    const scoreDelta = relevanceScore(right, term) - relevanceScore(left, term);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    if (right.view_count !== left.view_count) {
      return right.view_count - left.view_count;
    }
    return byRecency(left, right);
  };
}

/** The filters and ordering the feed composes, as read from the query string. */
interface FeedQuery {
  readonly term: string | undefined;
  readonly categorySlug: string | undefined;
  readonly authorUsername: string | undefined;
  readonly relevance: boolean;
}

/** Read the feed's own parameters, leaving `page` and `page_size` to `readPageRequest`. */
function readFeedQuery(params: URLSearchParams): FeedQuery {
  return {
    term: readQuery(params, 'q'),
    categorySlug: readQuery(params, 'category'),
    authorUsername: readQuery(params, 'author'),
    relevance: readQuery(params, 'sort') === 'relevance',
  };
}

/**
 * Compose the feed: scope to published, filter, then order.
 *
 * Filtering precedes ordering because ranking a row that the filter removes would change nothing
 * and cost something - and because `total` must count what survives the filter, not what survives
 * the ranking.
 */
function composeFeed(query: FeedQuery): readonly PostDetail[] {
  let rows = publiclyVisiblePosts();
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
  const authorUsername = query.authorUsername?.toLowerCase();
  if (authorUsername !== undefined) {
    rows = rows.filter((post) => post.author.username.toLowerCase() === authorUsername);
  }
  return [...rows].sort(query.relevance ? byRelevance(term ?? '') : byRecency);
}

/**
 * The like state of a post as the calling principal sees it.
 *
 * The count is a property of the post and the flag a property of the caller, which is exactly why
 * the contract carries both: an anonymous reader still sees how many people liked something. A post
 * the fixtures do not know about reports zero rather than 404, because a count is defined for any
 * identifier and answering 404 here would make an optimistic like control unable to recover.
 */
function likeSummaryFor(postId: string, likedByCaller: boolean): LikeSummary {
  return {
    post_id: postId,
    like_count: likeCountsByPostId.get(postId) ?? UNKNOWN_POST_LIKE_COUNT,
    liked_by_caller: likedByCaller,
  };
}

/**
 * A comment as a public reader sees it: itself, with only its visible replies nested beneath it.
 *
 * Recursive, because a reply may itself carry replies and a moderator's rejection of one must not
 * publish the ones beneath it. Returns a fresh object rather than editing the fixture, which is what
 * keeps the fixture set immutable across requests.
 */
function visibleThread(comment: CommentPublic): CommentPublic {
  return {
    ...comment,
    replies: comment.replies
      .filter((reply) => reply.status === VISIBLE_COMMENT_STATUS)
      .map(visibleThread),
  };
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
 * ---------------------------------------------------------------------------------------------- */

const authHandlers = [
  /** Create an account. Answers with the public projection - never with a token, and never with a
   * credential of any kind, because registration does not sign the new account in. */
  http.post('*/api/v1/auth/register', async ({ request }) => {
    const body = await readJsonRecord(request);
    const username = readString(body, 'username') ?? 'newcomer';
    const displayName = readNullableString(body, 'display_name');
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
   * would throw on its body. The pair returned names the account whose address was submitted, so a
   * spec signing in as the administrator is subsequently recognised as one; an address the fixtures
   * do not hold still receives the author's pair, because the default set does not refuse
   * credentials - refusal is the exported 401 failure handler's job.
   */
  http.post('*/api/v1/auth/login', async ({ request }) => {
    const email = await readFormField(request, 'username');
    const pair = email === undefined ? undefined : tokenPairsByEmail.get(email.toLowerCase());
    return ok(pair ?? fixtureTokenPair);
  }),

  /** Rotate the refresh token and mint a new access token. Both members differ from every other
   * pair, so a rotation is observable rather than merely assumed. */
  http.post('*/api/v1/auth/refresh', () => ok(fixtureRotatedTokenPair)),

  /** Revoke the presented refresh token. 204 with no body: there is nothing to report. */
  http.post('*/api/v1/auth/logout', ({ request }) =>
    resolvePrincipal(request) === undefined ? unauthorized(request) : noContent(),
  ),

  /** The authenticated principal, in the self projection that carries email, role and state. */
  http.get('*/api/v1/auth/me', ({ request }) => {
    const principal = resolvePrincipal(request);
    return principal === undefined ? unauthorized(request) : ok(principal);
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
   */
  http.patch('*/api/v1/users/me', async ({ request }) => {
    const principal = resolvePrincipal(request);
    if (principal === undefined) {
      return unauthorized(request);
    }
    const body = await readJsonRecord(request);
    const displayName = readString(body, 'display_name');
    const bio = readNullableString(body, 'bio');
    const avatarUrl = readNullableString(body, 'avatar_url');
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
   * rather than in the caller, and so does this. Only `page` and `page_size` are honoured - a
   * profile listing offers no search, no category filter and no ordering choice.
   */
  http.get('*/api/v1/users/:username/posts', ({ request, params }) => {
    const username = pathParam(params.username);
    const account = findAccountByUsername(username);
    if (account === undefined) {
      return notFound(request, `No author is registered under the handle "${username}".`);
    }
    const authored = publiclyVisiblePosts()
      .filter((post) => post.author.username === account.username)
      .sort(byRecency)
      .map(toPostSummary);
    return ok(pageOf(authored, request));
  }),

  /**
   * A public author profile, keyed on the handle.
   *
   * Answers with `UserPublic`, and therefore discloses no address, no role and no account state. An
   * unknown handle is 404 rather than an empty profile, so a component cannot render a header for
   * somebody who does not exist.
   */
  http.get('*/api/v1/users/:username', ({ request, params }) => {
    const username = pathParam(params.username);
    const account = findAccountByUsername(username);
    if (account === undefined) {
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
 * ---------------------------------------------------------------------------------------------- */

const postCollectionHandlers = [
  /**
   * The feed. Composes free-text ranking, category membership, author scoping, ordering and
   * windowing over the published set, exactly as the service's single feed statement does.
   *
   * Public, and therefore scoped to PUBLISHED: neither the draft nor the archived post can appear,
   * under any combination of parameters. A page beyond the last answers with an empty `items` array
   * and the true `total`, never an error, because asking for a page that does not exist is a
   * legitimate request with an empty answer.
   */
  http.get('*/api/v1/posts', ({ request }) => {
    const params = searchParams(request);
    const rows = composeFeed(readFeedQuery(params)).map(toPostSummary);
    return ok(paginate(rows, readPageRequest(params)));
  }),

  /**
   * Create a draft.
   *
   * Answers 201 with the full detail projection at `status: 'DRAFT'` and `published_at: null` -
   * creation never publishes, because publication is a separate transition with its own route. The
   * slug is derived from the submitted title here and never re-derived afterwards.
   */
  http.post('*/api/v1/posts', async ({ request }) => {
    const principal = resolvePrincipal(request);
    if (principal === undefined) {
      return unauthorized(request);
    }
    const body = await readJsonRecord(request);
    const title = readString(body, 'title') ?? 'Untitled draft';
    const draft: PostDetail = {
      id: CREATED_POST_ID,
      title,
      slug: slugify(title),
      excerpt: readNullableString(body, 'excerpt') ?? null,
      cover_image_url: readNullableString(body, 'cover_image_url') ?? null,
      status: 'DRAFT',
      published_at: null,
      view_count: 0,
      created_at: INSTANT_CREATED_RESOURCE,
      author: toPublicUser(principal),
      categories: toCategorySummaries(readStringArray(body, 'category_ids') ?? []),
      content: readString(body, 'content') ?? '',
      updated_at: INSTANT_CREATED_RESOURCE,
    };
    return created(draft);
  }),
];

const postSubResourceHandlers = [
  /**
   * Like a post. Idempotent by construction: the answer does not depend on how many times it has
   * been called, because the service's composite primary key on `(post_id, user_id)` makes a repeat
   * insert a no-op. A handler that counted would be modelling a system that does not exist.
   */
  http.put('*/api/v1/posts/:postId/like', ({ request, params }) => {
    const principal = resolvePrincipal(request);
    if (principal === undefined) {
      return unauthorized(request);
    }
    const postId = pathParam(params.postId);
    return ok(likeSummaryFor(postId, true));
  }),

  /**
   * Remove a like.
   *
   * The one DELETE in the whole API that answers with a body rather than 204: the caller needs the
   * new count to render, and a second round trip to fetch it would make the control flicker.
   */
  http.delete('*/api/v1/posts/:postId/like', ({ request, params }) => {
    const principal = resolvePrincipal(request);
    if (principal === undefined) {
      return unauthorized(request);
    }
    const postId = pathParam(params.postId);
    return ok(likeSummaryFor(postId, false));
  }),

  /**
   * The like state of a post. Requires no credential - an anonymous reader still sees the count, and
   * simply sees `liked_by_caller: false`, which is why the summary carries both members.
   */
  http.get('*/api/v1/posts/:postId/likes', ({ request, params }) => {
    const postId = pathParam(params.postId);
    const liked = resolvePrincipal(request) !== undefined;
    return ok(likeSummaryFor(postId, liked));
  }),

  /**
   * A page of comments on a post, WINDOWED OVER ROOTS.
   *
   * `total` and `pages` count top-level comments, and a reply is nested inside its parent's
   * `replies` array rather than occupying a slot of its own. Windowing over a flattened thread would
   * let a busy discussion push a root onto a later page as replies arrived beneath an earlier one.
   * Public, so only comments at the visible moderation state are reported.
   */
  http.get('*/api/v1/posts/:postId/comments', ({ request, params }) => {
    const postId = pathParam(params.postId);
    const roots = fixtureComments
      .filter(
        (comment) =>
          comment.post_id === postId &&
          comment.parent_id === null &&
          comment.status === VISIBLE_COMMENT_STATUS,
      )
      .map(visibleThread);
    return ok(pageOf(roots, request));
  }),

  /**
   * Add a comment, or a reply when `parent_id` is submitted.
   *
   * The post identifier comes from the path, not the body, so the body carries no `post_id` to
   * echo. The submitted text is echoed verbatim so a form spec can assert on what it typed.
   */
  http.post('*/api/v1/posts/:postId/comments', async ({ request, params }) => {
    const principal = resolvePrincipal(request);
    if (principal === undefined) {
      return unauthorized(request);
    }
    const body = await readJsonRecord(request);
    const comment: CommentPublic = {
      id: CREATED_COMMENT_ID,
      post_id: pathParam(params.postId),
      parent_id: readString(body, 'parent_id') ?? null,
      author: toPublicUser(principal),
      body: readString(body, 'body') ?? '',
      status: VISIBLE_COMMENT_STATUS,
      created_at: INSTANT_CREATED_RESOURCE,
      updated_at: INSTANT_CREATED_RESOURCE,
      replies: [],
    };
    return created(comment);
  }),

  /**
   * Publish a post: transition to PUBLISHED and stamp the publication instant.
   *
   * Carries no request body, so the resolver must not read one. The stamped instant is a fixed
   * value rather than the current time, so the transition is assertable on equality and two runs of
   * the same spec cannot disagree.
   */
  http.post('*/api/v1/posts/:postId/publish', ({ request, params }) => {
    const principal = resolvePrincipal(request);
    if (principal === undefined) {
      return unauthorized(request);
    }
    const post = findPostById(pathParam(params.postId));
    if (post === undefined) {
      return notFound(request, 'No post is stored under that identifier.');
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
    const principal = resolvePrincipal(request);
    if (principal === undefined) {
      return unauthorized(request);
    }
    const post = findPostById(pathParam(params.postId));
    if (post === undefined) {
      return notFound(request, 'No post is stored under that identifier.');
    }
    const withdrawn: PostDetail = { ...post, status: 'DRAFT', updated_at: FIXTURE_PUBLISHED_AT };
    return ok(withdrawn);
  }),
];

const postResourceHandlers = [
  /**
   * Post detail, KEYED ON THE SLUG.
   *
   * An unknown slug is 404. So is a slug that names an unpublished post when the caller presents no
   * credential, and 404 rather than 403 on purpose: answering 403 would confirm that a draft exists
   * at that address, which is itself the disclosure the status is meant to prevent. A caller with a
   * credential reads it.
   */
  http.get('*/api/v1/posts/:slug', ({ request, params }) => {
    const slug = pathParam(params.slug);
    const post = findPostBySlug(slug);
    const readable =
      post !== undefined &&
      (post.status === VISIBLE_POST_STATUS || resolvePrincipal(request) !== undefined);
    if (!readable) {
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
   */
  http.patch('*/api/v1/posts/:postId', async ({ request, params }) => {
    const principal = resolvePrincipal(request);
    if (principal === undefined) {
      return unauthorized(request);
    }
    const post = findPostById(pathParam(params.postId));
    if (post === undefined) {
      return notFound(request, 'No post is stored under that identifier.');
    }
    const body = await readJsonRecord(request);
    const excerpt = readNullableString(body, 'excerpt');
    const coverImageUrl = readNullableString(body, 'cover_image_url');
    const categoryIds = readStringArray(body, 'category_ids');
    const updated: PostDetail = {
      ...post,
      title: readString(body, 'title') ?? post.title,
      excerpt: excerpt === undefined ? post.excerpt : excerpt,
      cover_image_url: coverImageUrl === undefined ? post.cover_image_url : coverImageUrl,
      content: readString(body, 'content') ?? post.content,
      categories: categoryIds === undefined ? post.categories : toCategorySummaries(categoryIds),
      updated_at: FIXTURE_PUBLISHED_AT,
    };
    return ok(updated);
  }),

  /** Delete a post. 204 with no body; its comments and likes go with it by cascade. */
  http.delete('*/api/v1/posts/:postId', ({ request, params }) => {
    const principal = resolvePrincipal(request);
    if (principal === undefined) {
      return unauthorized(request);
    }
    return findPostById(pathParam(params.postId)) === undefined
      ? notFound(request, 'No post is stored under that identifier.')
      : noContent();
  }),
];

/* -------------------------------------------- categories ----------------------------------------
 * `GET /categories` answers with a BARE ARRAY. It is the single documented exception to the page
 * envelope across the entire API: the taxonomy is small, bounded and read in full to populate the
 * home page's filter control, so paginating it would oblige that control to page through a list it
 * always needs whole. Wrapping it in an envelope here would break the filter component's tests in a
 * way that reads as a component defect rather than as a fixture one, which is why it is called out.
 * ---------------------------------------------------------------------------------------------- */

const categoryHandlers = [
  /** Every category with its published-post count, un-paginated by contract. */
  http.get('*/api/v1/categories', () => ok(fixtureCategories)),

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
 * ---------------------------------------------------------------------------------------------- */

const commentHandlers = [
  /**
   * Edit a comment's body.
   *
   * Only the body is mutable - authorship, thread position and moderation state are not editable by
   * their author, and a moderation change is an administrative operation with its own route.
   */
  http.patch('*/api/v1/comments/:commentId', async ({ request, params }) => {
    const principal = resolvePrincipal(request);
    if (principal === undefined) {
      return unauthorized(request);
    }
    const comment = findCommentById(pathParam(params.commentId));
    if (comment === undefined) {
      return notFound(request, 'No comment is stored under that identifier.');
    }
    const body = await readJsonRecord(request);
    const edited: CommentPublic = {
      ...comment,
      body: readString(body, 'body') ?? comment.body,
      updated_at: FIXTURE_PUBLISHED_AT,
    };
    return ok(edited);
  }),

  /** Delete a comment. 204 with no body; any replies beneath it go with it by cascade. */
  http.delete('*/api/v1/comments/:commentId', ({ request, params }) => {
    const principal = resolvePrincipal(request);
    if (principal === undefined) {
      return unauthorized(request);
    }
    return findCommentById(pathParam(params.commentId)) === undefined
      ? notFound(request, 'No comment is stored under that identifier.')
      : noContent();
  }),
];

/* ---------------------------------------------- admin -------------------------------------------
 * Fourteen operations across four entities plus the overview counts. Two things are worth stating
 * before reading them.
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
 * They authenticate by the presence of a bearer and deliberately do not check the role. Role refusal
 * is a scenario a spec opts into with `server.use(adminForbiddenHandlers)`, so that the default
 * array remains the happy path for the administrative screens.
 * ---------------------------------------------------------------------------------------------- */

const adminHandlers = [
  /** Aggregate counts for the overview screen's four stat tiles. */
  http.get('*/api/v1/admin/stats', ({ request }) =>
    resolvePrincipal(request) === undefined ? unauthorized(request) : ok(fixtureAdminStats),
  ),

  /** Every account, filterable by free text over handle, address and display name, by role and by
   * active state. Discloses the address and the role, which the public projection never does. */
  http.get('*/api/v1/admin/users', ({ request }) => {
    if (resolvePrincipal(request) === undefined) {
      return unauthorized(request);
    }
    const params = searchParams(request);
    const term = readQuery(params, 'q');
    const role = readQueryUserRole(params, 'role');
    const isActive = readQueryBoolean(params, 'is_active');
    const rows = storedAccounts
      .filter((account) => matchesTerm(term, account.username, account.email, account.display_name))
      .filter((account) => role === undefined || account.role === role)
      .filter((account) => isActive === undefined || account.is_active === isActive)
      .map(toAdminUser);
    return ok(paginate(rows, readPageRequest(params)));
  }),

  /** Change an account's role or active state. Both members are optional and applied when present. */
  http.patch('*/api/v1/admin/users/:userId', async ({ request, params }) => {
    if (resolvePrincipal(request) === undefined) {
      return unauthorized(request);
    }
    const account = findAccountById(pathParam(params.userId));
    if (account === undefined) {
      return notFound(request, 'No account is stored under that identifier.');
    }
    const body = await readJsonRecord(request);
    const updated: AdminUser = {
      ...toAdminUser(account),
      role: readUserRole(body, 'role') ?? account.role,
      is_active: readBoolean(body, 'is_active') ?? account.is_active,
      updated_at: FIXTURE_PUBLISHED_AT,
    };
    return ok(updated);
  }),

  /** Remove an account. 204; their posts, comments, likes and tokens go with it by cascade. */
  http.delete('*/api/v1/admin/users/:userId', ({ request, params }) => {
    if (resolvePrincipal(request) === undefined) {
      return unauthorized(request);
    }
    return findAccountById(pathParam(params.userId)) === undefined
      ? notFound(request, 'No account is stored under that identifier.')
      : noContent();
  }),

  /** Every post across ALL three lifecycle states - the one listing that ignores public scoping. */
  http.get('*/api/v1/admin/posts', ({ request }) => {
    if (resolvePrincipal(request) === undefined) {
      return unauthorized(request);
    }
    const params = searchParams(request);
    const term = readQuery(params, 'q');
    const status = readQueryPostStatus(params, 'status');
    const authorId = readQuery(params, 'author_id');
    const rows = fixturePosts
      .filter((post) => matchesTerm(term, post.title, post.slug, post.excerpt))
      .filter((post) => status === undefined || post.status === status)
      .filter((post) => authorId === undefined || post.author.id === authorId)
      .sort(byRecency)
      .map(toAdminPost);
    return ok(paginate(rows, readPageRequest(params)));
  }),

  /** Force a post's lifecycle state. Declared before the resource pattern below. */
  http.patch('*/api/v1/admin/posts/:postId/status', async ({ request, params }) => {
    if (resolvePrincipal(request) === undefined) {
      return unauthorized(request);
    }
    const post = findPostById(pathParam(params.postId));
    if (post === undefined) {
      return notFound(request, 'No post is stored under that identifier.');
    }
    const status = readPostStatus(await readJsonRecord(request), 'status') ?? post.status;
    const updated: AdminPost = {
      ...toAdminPost(post),
      status,
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
    if (resolvePrincipal(request) === undefined) {
      return unauthorized(request);
    }
    return findPostById(pathParam(params.postId)) === undefined
      ? notFound(request, 'No post is stored under that identifier.')
      : noContent();
  }),

  /** The moderation queue: every comment in every state, roots and replies alike, flattened. */
  http.get('*/api/v1/admin/comments', ({ request }) => {
    if (resolvePrincipal(request) === undefined) {
      return unauthorized(request);
    }
    const params = searchParams(request);
    const term = readQuery(params, 'q');
    const status = readQueryCommentStatus(params, 'status');
    const postId = readQuery(params, 'post_id');
    const rows = fixtureComments
      .filter((comment) => matchesTerm(term, comment.body, comment.author.username))
      .filter((comment) => status === undefined || comment.status === status)
      .filter((comment) => postId === undefined || comment.post_id === postId)
      .map(toAdminComment);
    return ok(paginate(rows, readPageRequest(params)));
  }),

  /** Approve or reject a comment. Declared before the resource pattern below. */
  http.patch('*/api/v1/admin/comments/:commentId/status', async ({ request, params }) => {
    if (resolvePrincipal(request) === undefined) {
      return unauthorized(request);
    }
    const comment = findCommentById(pathParam(params.commentId));
    if (comment === undefined) {
      return notFound(request, 'No comment is stored under that identifier.');
    }
    const status = readCommentStatus(await readJsonRecord(request), 'status') ?? comment.status;
    const updated: AdminComment = {
      ...toAdminComment(comment),
      status,
      updated_at: FIXTURE_PUBLISHED_AT,
    };
    return ok(updated);
  }),

  /** Remove a comment administratively. 204. */
  http.delete('*/api/v1/admin/comments/:commentId', ({ request, params }) => {
    if (resolvePrincipal(request) === undefined) {
      return unauthorized(request);
    }
    return findCommentById(pathParam(params.commentId)) === undefined
      ? notFound(request, 'No comment is stored under that identifier.')
      : noContent();
  }),

  /**
   * Every category as an administrative page.
   *
   * Note that this one IS enveloped, unlike the public `GET /categories`. The two are different
   * operations with different contracts: the public read populates a filter control and is bounded,
   * while the administrative table shares one pagination component with the other three tables.
   */
  http.get('*/api/v1/admin/categories', ({ request }) => {
    if (resolvePrincipal(request) === undefined) {
      return unauthorized(request);
    }
    const params = searchParams(request);
    const term = readQuery(params, 'q');
    const rows = fixtureCategories.filter((category) =>
      matchesTerm(term, category.name, category.slug, category.description),
    );
    return ok(paginate(rows, readPageRequest(params)));
  }),

  /** Create a category. 201, with the slug derived from the submitted name and no posts in it yet. */
  http.post('*/api/v1/admin/categories', async ({ request }) => {
    if (resolvePrincipal(request) === undefined) {
      return unauthorized(request);
    }
    const body = await readJsonRecord(request);
    const name = readString(body, 'name') ?? 'Untitled category';
    const category: CategoryPublic = {
      id: CREATED_CATEGORY_ID,
      name,
      slug: slugify(name),
      description: readNullableString(body, 'description') ?? null,
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
   */
  http.patch('*/api/v1/admin/categories/:categoryId', async ({ request, params }) => {
    if (resolvePrincipal(request) === undefined) {
      return unauthorized(request);
    }
    const category = findCategoryById(pathParam(params.categoryId));
    if (category === undefined) {
      return notFound(request, 'No category is stored under that identifier.');
    }
    const body = await readJsonRecord(request);
    const description = readNullableString(body, 'description');
    const updated: CategoryPublic = {
      ...category,
      name: readString(body, 'name') ?? category.name,
      description: description === undefined ? category.description : description,
    };
    return ok(updated);
  }),

  /** Remove a category. 204; the service refuses one still in use, which is an exported 409. */
  http.delete('*/api/v1/admin/categories/:categoryId', ({ request, params }) => {
    if (resolvePrincipal(request) === undefined) {
      return unauthorized(request);
    }
    return findCategoryById(pathParam(params.categoryId)) === undefined
      ? notFound(request, 'No category is stored under that identifier.')
      : noContent();
  }),
];

/* ---------------------------------------------- health ------------------------------------------
 * The only two unversioned paths in the API. The wildcard predicates match them whether or not an
 * environment's base URL happens to place them under the version prefix, so a probe is reachable
 * either way without this module knowing which origin is configured.
 * ---------------------------------------------------------------------------------------------- */

const healthHandlers = [
  /** Liveness. Answers without touching a database, and claims nothing about one. */
  http.get('*/healthz', () => {
    const report: LivenessReport = { status: 'alive' };
    return ok(report);
  }),

  /** Readiness. Answers only while a trivial query succeeds, so it does claim something about one. */
  http.get('*/readyz', () => {
    const report: ReadinessReport = { status: 'ready', database: true };
    return ok(report);
  }),
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
 * Thirty-eight versioned operations plus the two operational probes.
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
 * The protected reads answer 401 unconditionally - even to a caller presenting a bearer.
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
 * The administrative namespace answers 403 to an authenticated caller.
 *
 * 403 rather than 401 is the distinction that matters: the credential is fine, the authority is not,
 * so retrying with a fresh token cannot help and the client must not attempt a rotation. A spec
 * asserting that a reader is refused the administrative screens uses this.
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
  http.get('*/api/v1/admin/categories', ({ request }) =>
    forbidden(request, 'This operation is restricted to administrators.'),
  ),
];

/**
 * Registration collides with an existing account.
 *
 * 409 with a `detail` naming which identity collided, because a sign-up form has to tell the visitor
 * which of the two fields to change. Both identities are case-insensitively unique in the service, so
 * a differently-cased address collides too.
 */
export const registrationConflictHandlers = [
  http.post('*/api/v1/auth/register', ({ request }) =>
    problem({
      status: HTTP_CONFLICT,
      type: ERROR_TYPE_CONFLICT,
      title: ERROR_TITLE_CONFLICT,
      detail: 'An account already exists with that email address.',
      instance: requestInstance(request),
    }),
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
  registrationConflict: registrationConflictHandlers,
  registrationValidation: registrationValidationHandlers,
  commentValidation: commentValidationHandlers,
  loginRateLimited: loginRateLimitedHandlers,
} as const;
