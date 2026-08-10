/**
 * The presentation tier's only HTTP module.
 *
 * Every request this application makes to the REST service is issued from this file. Route
 * segments, layouts, client islands, hooks, providers, `src/app/sitemap.ts`, `src/app/robots.ts`
 * and the seven typed wrappers beside this module (`auth`, `posts`, `categories`, `comments`,
 * `likes`, `users`, `admin`) all reach the API *through* here and never around it. `fetch`,
 * `Headers`, `AbortSignal` handling, per-attempt deadlines, bearer attachment,
 * refresh-on-unauthorised, retry, response validation and error normalisation live in this module
 * exclusively; a wrapper that reaches for any of them, or that branches on a status code, has taken
 * on transport logic that belongs here.
 *
 * That concentration is the whole point. There is exactly one place where a credential is attached,
 * one place where a rotation can race, one place where a request can hang, one place where a body is
 * checked against its declared contract, one place where a failure becomes a typed error and one
 * place where the API's origin is read. Each of those is a defect class that cannot be distributed
 * across forty call sites if it only exists once.
 *
 * ## Four properties worth knowing before calling anything here
 *
 * 1. **Every attempt is bounded.** `fetch` has no timeout, so a stalled connection would otherwise
 *    hang a render or a mutation indefinitely. Each attempt gets {@link DEFAULT_TIMEOUT_MS},
 *    composed with the caller's own `signal` so both remain effective and remain distinguishable -
 *    see {@link startDeadline}.
 * 2. **Every JSON body is validated.** A JSON call takes a {@link ResponseDecoder} and a body that
 *    does not satisfy it is rejected as `/errors/malformed-response` rather than cast to the declared
 *    type. `@/lib/types` declares one decoder per response shape beside the interface it checks.
 * 3. **The credential store is browser-only.** A module global on a server is shared by every
 *    concurrent render, so nothing is stored there; a server render passes its credential per request
 *    through {@link RequestOptions.bearer}. The API's address is resolved per context too - see
 *    {@link resolveApiBaseUrl}.
 * 4. **Rotation happens once, in one place, and can be superseded.** {@link rotateSession} is the
 *    only public way to rotate; concurrent callers share one request, and a rotation whose result
 *    arrives after a sign-out is discarded rather than adopted.
 *
 * ## What this module does NOT do, and must never start doing
 *
 * - **No `'use client'` directive, and no browser-only global touched at module scope.** Server
 *   Components render the feed, the post page, the profile page and the sitemap, so this module is
 *   evaluated on the server as often as in the browser. `document` and `process.env` are read
 *   inside functions, behind guards, never while the module is being evaluated.
 * - **No React, no `@tanstack/react-query`, no provider, hook, component or route import.** The
 *   dependency arrow points strictly outward: this module imports one thing, `@/lib/types`, and it
 *   imports it as **types only** - which is why the one decoder it needs for itself,
 *   {@link tokenPairDecoder}, is written out here rather than imported. Cache invalidation, mutation
 *   state and navigation belong to the layers above; see {@link setUnauthorizedHandler} for the one
 *   callback seam that exists instead.
 * - **No redirect and no navigation.** `src/middleware.ts` owns the `/login?next=<encoded path>`
 *   contract. When authentication is definitively gone this module clears the credential, notifies
 *   the registered handler and throws {@link ApiError}. It does not decide where the reader goes.
 * - **No import of `@/lib/api/auth`.** That wrapper imports *this* module, so importing it back
 *   would close an ES-module cycle whose failure mode is an undefined binding at run time that
 *   neither the type-checker nor the linter reports. The rotation request is therefore issued
 *   inline here (see {@link refreshCredentials}); the one duplicated path string is the deliberate
 *   and correct trade.
 * - **No `axios`, no `swr`, no third-party package of any kind.** None is declared in
 *   `frontend/package.json` and none is needed: `fetch`, `Headers`, `URLSearchParams` and
 *   `AbortSignal` are platform globals on Node 24 and in every supported browser.
 * - **No camel-case translation layer.** Wire field names are the service's own snake_case, exactly
 *   as `@/lib/types` mirrors them. Re-spelling a field produces a type that compiles and a value
 *   that is `undefined`.
 *
 * ## Credential modes: a wrapper states which kind of route it wraps
 *
 * {@link RequestOptions} is the full transport surface and is what the low-level entry points take,
 * because this module has to be able to express every request - including the deliberately
 * unauthenticated ones it issues itself. A namespace wrapper takes one of three narrower types
 * instead: {@link PublicRequestOptions}, {@link OptionalAuthRequestOptions} or
 * {@link ProtectedRequestOptions}. The credential mode belongs to the route, so encoding it in the
 * wrapper's signature is what makes the two mistakes it prevents unrepresentable rather than merely
 * discouraged - a public read cannot transmit a held bearer, and a protected call cannot drop one.
 *
 * ## Path convention: callers pass namespace-relative paths
 *
 * A caller passes `/posts`, `/auth/login` or `/admin/users` - never `/api/v1/posts`. The version
 * namespace is composed here, exactly once, which is what makes it impossible for a wrapper to emit
 * an unversioned path.
 *
 * The prefix is composed **idempotently**, and that detail is contractual rather than defensive
 * habit. `.env.example` documents `NEXT_PUBLIC_API_BASE_URL` as *including* the `/api/v1` prefix
 * (`http://localhost:8000/api/v1`), because "the prefix lives here and only here". So
 * {@link resolveApiBaseUrl} appends the prefix only when the configured base does not already carry
 * it: a base URL of `http://localhost:8000/api/v1` is used as it stands, and a bare origin such as
 * `http://api.example.com` is completed to `http://api.example.com/api/v1`. Either configuration
 * produces the prefix exactly once, never twice. A caller that passes a path already carrying the
 * prefix is a defect in that caller and is rejected loudly rather than silently repaired - two
 * coexisting conventions is the state this rule exists to prevent.
 *
 * ## Governing standards
 *
 * `review_rules` reports that **no user-specified rules were provided** for this project, so nothing
 * here is invented to satisfy one. The binding constraints are the technical plan's own enterprise
 * standards, seven of which govern this module:
 *
 * | Standard                        | How this module satisfies it                                                                                    |
 * | ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
 * | Layered separation of concerns  | Sole HTTP module; imports only `@/lib/types`; no inward import; no `'use client'`; no navigation                 |
 * | Explicit API contracts          | {@link ProblemDetail} is the one error shape; every JSON call carries a {@link ResponseDecoder} checked at runtime |
 * | API versioning                  | `/api/v1` composed here once, idempotently; no caller can emit an unversioned path                              |
 * | Secure-by-default authentication | Bearer attachment, one single-flight rotation guarded by a generation counter, browser-only credential store; the cross-document credential is an `HttpOnly` cookie this module can ask about but never read |
 * | Configuration from environment  | One key, `NEXT_PUBLIC_API_BASE_URL`, read lazily at call time rather than captured at module scope               |
 * | Blocking quality gates          | Compiles under `tsc --noEmit`, lints at `--max-warnings=0`, explicit return type on every exported function      |
 * | No secrets in the repository    | No credential is written to `console`, to a thrown message, to a query string or onto a serialised error         |
 *
 * @module
 */

import type { ProblemDetail, TokenPair, ValidationErrorItem } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * Name of the cookie that signals "a session exists" to `src/middleware.ts`.
 *
 * **A three-file shared constant, and the agreement has to be character for character.**
 * `src/providers/auth-provider.tsx` writes and clears it, `src/middleware.ts` reads it to gate
 * `/dashboard/:path*`, `/posts/:path*` and `/admin/:path*`, and this module only declares the
 * literal. A mismatched literal does not fail anywhere: route protection simply never fires,
 * silently.
 *
 * `src/middleware.ts` runs in the Edge runtime and cannot import from `@/lib/api`, so it
 * necessarily restates the literal. `auth-provider.tsx` imports this constant rather than
 * restating it, because `providers -> lib` is a permitted dependency direction.
 *
 * **THE COOKIE CARRIES THE ROLE LITERAL AND NEVER A CREDENTIAL**, which is why this module writes
 * no cookie at all. A cookie written by client-side script cannot be `HttpOnly`, so putting the
 * access token in it publishes a reusable bearer to every script on the origin (CWE-1004,
 * CWE-922) - and the middleware never needed the token, only the role. The credential that DOES
 * survive a document is {@link DURABLE_SESSION_COOKIE_NAME}, and the difference is exactly the one
 * this paragraph is about: it is written by a server, so it can be `HttpOnly`, and this module can
 * only ask the session route to act on it rather than read it. This module sees token
 * pairs and never a principal, so it could not write the marker even if it should: the role is
 * knowable only from `GET /auth/me`, which is the provider's request. Presence and role are a
 * client-tier signal and nothing more: the API authenticates from the `Authorization` header
 * alone, never reads a cookie, and re-makes every authority decision server-side. Hiding a route
 * is user experience, not a security boundary.
 */
export const AUTH_COOKIE_NAME = 'blog_session';

/**
 * The version namespace every API path sits beneath. Composed by {@link resolveApiBaseUrl} exactly
 * once - see the module header for why the composition is idempotent.
 */
const API_VERSION_PREFIX = '/api/v1';

/** Spelled out for diagnostics; the read itself is a static member access, see {@link resolveApiBaseUrl}. */
const API_BASE_URL_ENV_KEY = 'NEXT_PUBLIC_API_BASE_URL';

/**
 * Rotation endpoint, stated here rather than imported from `@/lib/api/auth` to keep this module free
 * of the import cycle described in the header.
 */
const REFRESH_PATH = '/auth/refresh';

/** Wire field name of the rotation credential, mirroring `RefreshRequest` in `@/lib/types`. */
const REFRESH_TOKEN_FIELD = 'refresh_token';

const JSON_MEDIA_TYPE = 'application/json';
const PROBLEM_JSON_MEDIA_TYPE = 'application/problem+json';
const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';

const ACCEPT_HEADER = 'Accept';
const AUTHORIZATION_HEADER = 'Authorization';
const CONTENT_TYPE_HEADER = 'Content-Type';

/** Correlation header the service sets from the same value it writes to `ProblemDetail.request_id`. */
const REQUEST_ID_HEADER = 'X-Request-ID';

/** Present on the service's 429, whose interval is the only actionable part of a throttled answer. */
const RETRY_AFTER_HEADER = 'Retry-After';

/**
 * Present on the service's 401, naming the scheme the route expects - `Bearer`.
 *
 * Readable from a browser only because the service lists it in the CORS `Access-Control-Expose-
 * Headers` response header; a cross-origin response otherwise exposes just six safelisted headers
 * and this is not one of them. It is carried onto {@link ApiError.wwwAuthenticate} so a consumer can
 * distinguish "no credential presented" from "the credential presented was rejected" without
 * re-reading a response it no longer has.
 */
const WWW_AUTHENTICATE_HEADER = 'WWW-Authenticate';

/** The scheme literal, with its trailing space, used to build the credential header. */
const BEARER_SCHEME = 'Bearer ';

/**
 * Member names read out of an *untrusted* problem document.
 *
 * Named constants rather than destructured identifiers so the wire spelling is stated once and so
 * the snake_case key never has to appear as a local binding.
 */
const REQUEST_ID_FIELD = 'request_id';
const VALIDATION_ERRORS_FIELD = 'errors';

/** `Retry-After` in its delta-seconds form: ASCII digits and nothing else. */
const DELTA_SECONDS_PATTERN = /^\d+$/;

/** One or more trailing slashes on a configured base URL, stripped before joining. */
const TRAILING_SLASHES_PATTERN = /\/+$/;

const MILLISECONDS_PER_SECOND = 1000;

const HTTP_UNAUTHORIZED = 401;
const HTTP_NO_CONTENT = 204;

/**
 * How much of a decoder's rejection message reaches a problem document's `detail`.
 *
 * Enough to name the offending member and say what was wrong with it, and short enough that a
 * validator which quotes the payload cannot turn an error surface into a data dump. See
 * {@link describeDecodeFailure}.
 */
const DECODE_FAILURE_DETAIL_LIMIT = 200;

/**
 * `status` on a synthesised document for which no response was ever received.
 *
 * Zero is not an HTTP status and is chosen precisely because it cannot collide with one: a consumer
 * reading `error.status === 0` knows the request never reached an answer, rather than having to
 * distinguish a real 502 emitted by the service from a connection that never opened.
 */
const NO_RESPONSE_STATUS = 0;

/**
 * `type` values for documents this module synthesises when the service could not supply one.
 *
 * `/errors/http-error` is borrowed from the service's own closed set (`backend/app/core/
 * exceptions.py`) because it means the same thing there: an HTTP failure with no more specific
 * classification. The other three are **client-only** and are never emitted by the service, so a
 * consumer branching on `type` can tell a transport failure from a rejection.
 */
const ERROR_TYPE_HTTP = '/errors/http-error';
const ERROR_TYPE_NETWORK = '/errors/network-error';
const ERROR_TYPE_ABORTED = '/errors/request-aborted';
const ERROR_TYPE_TIMEOUT = '/errors/request-timeout';
const ERROR_TYPE_MALFORMED_RESPONSE = '/errors/malformed-response';

/**
 * How long one attempt may take before it is abandoned, in milliseconds.
 *
 * A default rather than an option a caller has to remember, because the failure it prevents is
 * silent: `fetch` has no timeout of its own, so a connection that opens and then stalls - a hung
 * upstream, a black-holed route, a container that is up but not answering - leaves a promise pending
 * for as long as the platform allows. In a Server Component that is a request that never renders; in
 * a client island it is a spinner that never resolves and a mutation whose outcome is unknown.
 *
 * Fifteen seconds is chosen against what this API actually does rather than as a round number. The
 * slowest documented operations are the ranked full-text feed query and the recursive comment
 * descent, both of which are index-backed and measured in single-digit milliseconds against seeded
 * data; argon2id verification on sign-in is the deliberate outlier and is still far below this.
 * Anything approaching this bound is a fault rather than a slow success, and reporting it as one is
 * more useful than waiting.
 *
 * **Per attempt, not per call.** A `401` that rotates and retries gives each of its three requests
 * its own deadline, because each is a distinct network operation that can stall independently.
 *
 * Override per call with {@link RequestOptions.timeoutMs}; a non-positive value removes the deadline
 * entirely, which is the honest way to express "this one may take as long as it takes".
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/* -------------------------------------------------------------------------------------------------
 * Public option and payload types
 * ---------------------------------------------------------------------------------------------- */

/** The HTTP methods this API surface uses. No route anywhere needs another. */
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * A single query-string value before encoding.
 *
 * `undefined`, `null` and the empty string are all *omissions* rather than values - see
 * {@link buildQueryString} - so a caller can pass its whole filter state through without first
 * pruning the parts the reader left blank.
 */
export type QueryValue = string | number | boolean | null | undefined;

/** A query string as a record. Order of iteration is the record's own insertion order. */
export type QueryParams = Readonly<Record<string, QueryValue>>;

/**
 * Fields of an `application/x-www-form-urlencoded` body.
 *
 * Values are already strings because form encoding has no other type. Used by exactly one route -
 * see {@link apiPostForm}.
 */
export type FormFields = Readonly<Record<string, string>>;

/**
 * Framework revalidation controls, passed straight through to `fetch`.
 *
 * Structurally identical to the framework's own `NextFetchRequestConfig`, restated here so a
 * caller can name the type without importing anything from the framework. `tags` is a mutable
 * array rather than a readonly one for exactly that assignability.
 */
export interface RevalidationOptions {
  /** Seconds before a cached response is considered stale, or `false` to cache indefinitely. */
  revalidate?: number | false;
  /** Cache tags this response participates in, for targeted invalidation. */
  tags?: string[];
}

/** Per-call controls available to every transport function. */
export interface RequestOptions {
  /**
   * Query parameters. Entries whose value is `undefined`, `null` or `''` are omitted, so an
   * unfiltered feed request produces a clean URL rather than `?q=&category=`.
   */
  query?: QueryParams;
  /** Cancellation signal. An aborted request surfaces as an {@link ApiError} like any other failure. */
  signal?: AbortSignal;
  /**
   * Force an unauthenticated request: no `Authorization` header is sent even when a credential is
   * held, and a `401` is **not** treated as a rotation opportunity.
   *
   * Anonymity is a normal state rather than an error condition - `GET /posts`, `GET /posts/{slug}`,
   * `GET /categories`, `GET /users/{username}`, `GET /posts/{id}/likes` and
   * `GET /posts/{id}/comments` all answer without a credential - so this flag exists for the rarer
   * case of *deliberately* withholding one that is held.
   */
  anonymous?: boolean;
  /** Framework cache mode, passed straight through so a Server Component can control caching. */
  cache?: RequestCache;
  /** Framework revalidation controls, passed straight through. */
  next?: RevalidationOptions;
  /**
   * Per-attempt deadline in milliseconds, overriding {@link DEFAULT_TIMEOUT_MS}.
   *
   * A non-positive value removes the deadline. Composed with `signal` rather than replacing it: both
   * can fire, whichever comes first wins, and the two are distinguishable afterwards - a deadline
   * produces `/errors/request-timeout` and a caller's abort produces `/errors/request-aborted`.
   */
  timeoutMs?: number;
  /**
   * An explicit credential for **this request only**, used instead of the stored one.
   *
   * This is how a Server Component makes an authenticated read. The credential store is a module
   * global and is therefore browser-only by construction: on a server it would be shared by every
   * concurrent render, which is one reader's token answering another reader's request. So a server
   * caller passes the token it resolved from that request's own context - a cookie, a header - and
   * nothing is retained between renders.
   *
   * Rotation is **disabled** for a request that carries this: renewing a credential the caller owns
   * would write a pair into a store the caller is not reading, and on a server there is nowhere to
   * write it at all. A `401` therefore surfaces unchanged, which is the correct answer for a server
   * render - the page can redirect, or fall back to the anonymous view.
   *
   * Ignored when `anonymous` is set, because a deliberately unauthenticated request has no bearer.
   */
  bearer?: string;
  /**
   * Whether a `401` may trigger a credential rotation. Defaults to `true`.
   *
   * Set `false` where a rotation would invalidate the request itself. Sign-out is the case that
   * matters: its body carries the refresh token being revoked, so rotating mid-flight would spend
   * that token and then replay a body naming the spent one - revoking nothing and leaving the
   * successor alive. `@/lib/api/auth` sets this and re-issues the request with the post-rotation
   * token instead.
   */
  allowRefresh?: boolean;
  /**
   * Whether this request may be replayed once **without a credential** after the session has been
   * definitively abandoned.
   *
   * For public reads only, and it exists because a held-but-dead credential must not break a page
   * that needs none. The feed, a post, a profile, the taxonomy, a like summary and a comment thread
   * all answer anonymously; without this, a reader whose session expired in a background tab gets a
   * `401` on a page a signed-out visitor renders perfectly. Never set it on a request whose answer
   * depends on who is asking - an anonymous replay would silently return the public projection.
   */
  anonymousFallback?: boolean;
}

/* -------------------------------------------------------------------------------------------------
 * Credential modes
 *
 * `RequestOptions` is the full transport surface and is what the low-level entry points below
 * accept. It is deliberately permissive, because this module has to be able to express every kind of
 * request - including the deliberately unauthenticated ones it issues itself, such as rotation.
 *
 * A namespace WRAPPER is not permissive. Every endpoint in this API belongs to exactly one of three
 * credential modes, that mode is a property of the route rather than of the call site, and the three
 * types below are how a wrapper states which one it is wrapping. The point is what each one makes
 * UNREPRESENTABLE:
 *
 * - a public read cannot be talked into transmitting a bearer the caller happens to be holding, and
 * - a protected mutation cannot be talked into dropping the bearer it requires.
 *
 * Neither mistake produces a type error under the plain `RequestOptions`, and neither is visible at
 * the call site: the first quietly hands an unrelated service a credential it has no business
 * seeing, and the second quietly turns an authenticated action into a `401` at best - or, on a route
 * whose answer varies by principal, into the public projection silently standing in for the private
 * one. So the mode is encoded in the type rather than left to a comment.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Options for a route that resolves **no principal at all**, where the wrapper forces anonymity.
 *
 * The public profile reads (`GET /users/{username}`, `GET /users/{username}/posts`) and both
 * taxonomy reads (`GET /categories`, `GET /categories/{slug}`) are these: their handlers take
 * neither a required nor an optional principal, so a bearer sent with them cannot change a single
 * byte of the answer. Transmitting one anyway is a needless disclosure - the token travels, is
 * available to anything logging the request, and buys nothing - so the wrapper sets
 * `anonymous: true` itself and the caller has no member with which to countermand it.
 *
 * Four members are consequently absent, all for the same reason: with anonymity forced, none of them
 * can do anything. `anonymous` is the wrapper's to set, `bearer` would be ignored, `allowRefresh`
 * governs a rotation that a request carrying no credential cannot provoke, and `anonymousFallback`
 * is a replay of exactly the request that is already being made. What remains - `query` where the
 * wrapper does not own it, `signal`, `cache`, `next`, `timeoutMs` - is the whole of what a caller
 * legitimately controls on a public read.
 */
export type PublicRequestOptions = Omit<
  RequestOptions,
  'anonymous' | 'bearer' | 'allowRefresh' | 'anonymousFallback'
>;

/**
 * Options for a route that resolves an **optional** principal, where the credential mode is the
 * caller's to choose.
 *
 * Four routes answer differently depending on who is asking and answer perfectly well to nobody:
 * `GET /posts` and `GET /posts/{slug}` (an author or an administrator additionally sees drafts),
 * `GET /posts/{id}/comments` (moderation state) and `GET /posts/{id}/likes` (whether the caller has
 * liked). A held credential is therefore meaningful here and is attached by default, and `anonymous`
 * remains available for the genuine case of wanting the public projection on purpose - previewing
 * what a signed-out reader sees, say.
 *
 * `bearer` remains too, because that is how a Server Component makes an authenticated read: the
 * credential store is a module global and so browser-only by construction, and a server render
 * passes the token it resolved from its own request context instead.
 *
 * Only `anonymousFallback` is withheld. It is the wrapper's to set - a public read must not break
 * for a reader whose held credential has expired in a background tab - and a caller has no
 * information with which to make that decision better.
 */
export type OptionalAuthRequestOptions = Omit<RequestOptions, 'anonymousFallback'>;

/**
 * Options for a route that **requires** a credential, where anonymity is unrepresentable.
 *
 * Everything a reader has to be signed in to do: `POST /auth/logout`, `GET /auth/me`,
 * `PATCH /users/me`, every post and comment mutation, like and unlike, and all fourteen
 * administrative operations. Sending one of these without a credential cannot succeed, so the option
 * that would do it is removed rather than documented as a mistake.
 *
 * `bearer` is retained, and is the reason this is an `Omit` rather than a bare `Pick`: a Server
 * Component or a route handler acting on behalf of one request passes that request's own token, and
 * rotation is disabled for it automatically because there is nowhere on a server to write a rotated
 * pair. `allowRefresh` is retained for the one route whose body names a credential -
 * `@/lib/api/auth#logout` sets it `false` and handles the unauthorised case itself.
 *
 * `anonymousFallback` is absent for the same reason `anonymous` is: replaying a protected request
 * without a credential cannot produce the resource, and on a route whose public projection differs
 * it would produce something worse than a failure - a plausible answer to a different question.
 */
export type ProtectedRequestOptions = Omit<RequestOptions, 'anonymous' | 'anonymousFallback'>;

/**
 * {@link RequestOptions} plus a request body, for the low-level {@link apiRequest} and
 * {@link apiRequestNoContent} entry points.
 *
 * `json` and `form` are mutually exclusive; supplying both is a programming error and throws. When
 * neither is present the request carries **no body and no `Content-Type` header**, which is what an
 * empty mutation such as `POST /posts/{id}/publish` requires.
 */
export interface PayloadRequestOptions extends RequestOptions {
  /**
   * Body to serialise as JSON. `null` is a legitimate JSON body; `undefined` means "no body", which
   * is why absence rather than nullishness is the test.
   */
  json?: unknown;
  /** Body to serialise as `application/x-www-form-urlencoded`. */
  form?: FormFields;
}

/**
 * Notified when authentication is definitively gone: a rotation was attempted and refused, or there
 * was no rotation credential left to present.
 *
 * Invoked at most once per failed rotation, from a microtask, after {@link clearCredentials} has
 * already run - so a handler that reads {@link getAccessToken} sees `null`. The microtask hop is
 * deliberate: it means a handler that throws surfaces as its own unhandled error rather than
 * replacing the {@link ApiError} the caller is about to receive.
 *
 * The handler must not navigate on this module's behalf; it exists so the auth provider can drop
 * its React state and surface a notice. Routing is `src/middleware.ts`'s contract.
 */
export type UnauthorizedHandler = () => void;

/** A serialised request body together with the media type that describes it. */
interface Payload {
  readonly contentType: string;
  readonly body: string;
}

/**
 * Fully resolved per-request state handed to {@link dispatch}. Every member is explicit and
 * non-optional so no branch downstream has to re-derive a default.
 */
interface DispatchOptions {
  readonly payload: Payload | undefined;
  readonly query: QueryParams | undefined;
  readonly signal: AbortSignal | undefined;
  readonly anonymous: boolean;
  readonly cache: RequestCache | undefined;
  readonly next: RevalidationOptions | undefined;
  /** Per-attempt deadline in milliseconds. Non-positive means no deadline. */
  readonly timeoutMs: number;
  /** A request-scoped credential supplied by the caller, or `undefined` to use the stored one. */
  readonly bearer: string | undefined;
  /**
   * Whether a `401` may trigger a rotation. `false` for the rotation request itself, which is what
   * makes recursion impossible rather than merely unlikely, and `false` whenever the caller supplied
   * its own `bearer` or asked for rotation to be skipped.
   */
  readonly allowRefresh: boolean;
  /** Whether one anonymous replay is permitted after the session is abandoned. */
  readonly anonymousFallback: boolean;
}

/**
 * One network attempt: the response, and the deadline that is still armed around it.
 *
 * The two travel together because the deadline outlives the response - it has to stay armed until the
 * body has been read, and it has to be disposed exactly once afterwards. Returning the response alone
 * would leave the timer with no owner.
 */
interface Attempt {
  readonly response: Response;
  readonly deadline: Deadline;
}

/**
 * A bounded per-attempt deadline: the signal to hand `fetch`, and the means to tell afterwards
 * whether it was the deadline that fired.
 */
interface Deadline {
  /** The signal for this attempt - the caller's abort and the timer, composed. */
  readonly signal: AbortSignal | undefined;
  /** Whether the timer fired, as opposed to the caller aborting or nothing happening at all. */
  expired: () => boolean;
  /** Clear the timer and detach the listener. Idempotent, and mandatory - see {@link startDeadline}. */
  dispose: () => void;
}

/**
 * A runtime check that a decoded JSON body really is the shape the wrapper declared.
 *
 * Structural on purpose, so that a `zod` schema satisfies it with no adapter - `schema.parse` has
 * exactly this signature - while nothing here imports `zod` or depends on it. A hand-written guard
 * that throws on a mismatch satisfies it equally.
 *
 * The contract is narrow: given an already-parsed JSON value, return the value typed as `T`, or
 * **throw**. Returning something malformed rather than throwing defeats the purpose, and returning a
 * default silently substitutes data the service did not send.
 *
 * @typeParam T - The response type the caller declared, from `@/lib/types`.
 */
export interface ResponseDecoder<T> {
  /** Validate and return, or throw. The thrown value is normalised; it never reaches a caller raw. */
  parse: (value: unknown) => T;
}

/** Constructor input for a document this module synthesises rather than receives. */
interface SynthesisedProblem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly requestId?: string;
}

/* -------------------------------------------------------------------------------------------------
 * The one error type
 *
 * Every failure this module can produce - a rejection from the service, a body that was not a
 * problem document, an unreachable service, an aborted request, a 2xx whose body would not parse -
 * arrives as an ApiError carrying a well-formed ProblemDetail. A consumer needs exactly one `catch`
 * and never a status-code branch: `error.status`, `error.problem.type` and `error.errors` answer
 * every question a caller has, and the wrappers therefore contain no transport reasoning at all.
 * ---------------------------------------------------------------------------------------------- */

/**
 * A failed API request, normalised into the service's single error contract.
 *
 * The service renders one `application/problem+json` document for *every* failure path - domain
 * errors, request validation, framework-raised statuses, rate-limit rejections and unhandled
 * exceptions alike - so a well-behaved rejection needs no interpretation, only parsing. This class
 * additionally guarantees the shape for the cases the service cannot speak for: a gateway that
 * answered with HTML, a connection that never opened, a signal that fired first.
 *
 * The `message` is {@link ProblemDetail.detail}, which the service writes to be safe to show to a
 * person. **No credential is ever placed on this object**, in the message or in any field: the
 * document carries the failing path without its query string precisely because a query string is
 * where a stray credential would end up.
 */
export class ApiError extends Error {
  /** The full problem document. `problem.type` is the member that is safe to branch on. */
  readonly problem: ProblemDetail;

  /**
   * The HTTP status, lifted from the document for convenience. {@link NO_RESPONSE_STATUS} (`0`) when
   * no response was received at all.
   */
  readonly status: number;

  /**
   * Correlation identifier, identical to the response's `X-Request-ID`. Safe to render in an error
   * surface and quote in a support report: every structured log line for the failing request carries
   * the same value. Empty only when no response was received.
   */
  readonly requestId: string;

  /**
   * Seconds to wait before retrying, parsed from `Retry-After`, or `null` when the response carried
   * no such header.
   *
   * Reachable on **every** authentication route, not as an edge case: all five of register, sign in,
   * rotate, sign out and read-principal are rate limited, so a form that retries without honouring
   * this interval will be refused again.
   */
  readonly retryAfterSeconds: number | null;

  /**
   * Per-field validation detail, present only on a request-validation failure and then never empty.
   *
   * `undefined` is the only no-errors state - the service omits the member rather than sending `null`
   * or `[]` - so `if (error.errors)` is a complete test and a length check adds nothing.
   */
  readonly errors: readonly ValidationErrorItem[] | undefined;

  /**
   * The `WWW-Authenticate` challenge the response carried, or `null` when it carried none.
   *
   * Present on this API's `401` and nowhere else, where its value is `Bearer`. Worth keeping because
   * it is the only part of the answer that distinguishes *why* a route refused: the service sends the
   * header on an absent, malformed or expired credential alike, so its presence confirms the refusal
   * is an authentication one rather than an authorisation one - which a `403` would be, and which no
   * fresh credential can fix.
   *
   * `null` in a browser also means the service did not expose the header through CORS. It does; if
   * this is unexpectedly `null` on a cross-origin `401`, the `Access-Control-Expose-Headers` list is
   * where to look.
   */
  readonly wwwAuthenticate: string | null;

  constructor(
    problem: ProblemDetail,
    retryAfterSeconds: number | null = null,
    wwwAuthenticate: string | null = null,
  ) {
    super(problem.detail === '' ? problem.title : problem.detail);
    this.name = 'ApiError';
    this.problem = problem;
    this.status = problem.status;
    this.requestId = problem.request_id;
    this.retryAfterSeconds = retryAfterSeconds;
    this.errors = problem.errors;
    this.wwwAuthenticate = wwwAuthenticate;
    // Some bundler/transpiler targets rewrite `class ... extends Error` in a way that loses the
    // prototype link, which would make `instanceof ApiError` - and therefore isApiError - answer
    // false for a genuine instance. Restoring it explicitly costs one call and removes the risk.
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

/**
 * Narrow an unknown caught value to {@link ApiError}.
 *
 * Prefer this to a bare `instanceof` at call sites: it is the documented test, and it keeps the
 * single-error-type contract visible in consumer code.
 */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/* -------------------------------------------------------------------------------------------------
 * Problem-document construction and defensive parsing
 * ---------------------------------------------------------------------------------------------- */

/**
 * Build a conforming {@link ProblemDetail} for a failure the service did not describe.
 *
 * `request_id` defaults to the empty string, which is the only conforming value when no response
 * carried one - the member is declared non-optional precisely so that a document is always
 * self-describing, so it is filled rather than omitted.
 */
function synthesiseProblemDetail(source: SynthesisedProblem): ProblemDetail {
  return {
    type: source.type,
    title: source.title,
    status: source.status,
    detail: source.detail,
    instance: source.instance,
    request_id: source.requestId ?? '',
  };
}

/**
 * Validate and copy a `ValidationErrorItem` list out of an untrusted payload.
 *
 * Returns `undefined` for anything that is not an array of well-formed entries, and for an array
 * that contains none - which collapses `null`, `[]` and a malformed list onto the single no-errors
 * state the contract defines. The non-empty tuple return type is how `ProblemDetail.errors` is
 * declared, so a consumer inside `if (error.errors)` knows the first element exists.
 */
function readValidationErrors(
  payload: unknown,
): [ValidationErrorItem, ...ValidationErrorItem[]] | undefined {
  if (!Array.isArray(payload)) {
    return undefined;
  }
  const entries: unknown[] = payload;
  const items: ValidationErrorItem[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const { field, message, type } = entry as Record<string, unknown>;
    if (typeof field !== 'string' || typeof message !== 'string' || typeof type !== 'string') {
      continue;
    }
    items.push({ field, message, type });
  }
  const [first, ...rest] = items;
  return first === undefined ? undefined : [first, ...rest];
}

/**
 * Read a {@link ProblemDetail} out of an untrusted payload, falling back when it is not one.
 *
 * The service always sends a conforming document, but the network between the two tiers does not:
 * a proxy 502 arrives as HTML, a gateway timeout as plain text, a misconfigured origin as an
 * unrelated JSON object. Every member is therefore type-checked before it is trusted, and the
 * document is rebuilt member by member rather than cast - so a stray property on the wire cannot
 * ride along into a consumer, and a missing one cannot surface as `undefined` behind a type that
 * claims otherwise.
 */
function readProblemDetail(
  payload: unknown,
  fallback: ProblemDetail,
  httpStatus: number,
): ProblemDetail {
  if (typeof payload !== 'object' || payload === null) {
    return fallback;
  }
  const record = payload as Record<string, unknown>;
  const { type, title, status, detail, instance } = record;
  const requestId = record[REQUEST_ID_FIELD];
  if (
    typeof type !== 'string' ||
    typeof title !== 'string' ||
    typeof status !== 'number' ||
    typeof detail !== 'string' ||
    typeof instance !== 'string' ||
    typeof requestId !== 'string'
  ) {
    return fallback;
  }
  const problem: ProblemDetail = {
    type,
    title,
    // THE HTTP STATUS WINS, ALWAYS - the body's own `status` member is read only to check that it is
    // a number, and then discarded. The two agree on every response this service sends, so this
    // costs nothing in the ordinary case; it earns its place where they do not. A body is
    // attacker-influenceable in a way a status line is not, and an intermediary can rewrite one
    // without the other: a gateway that turns a 502 into a wrapper carrying `"status": 200`, or a
    // cached error document replayed under a different code. `ApiError.status` is what consumers
    // branch on - the rotation path in this module keys on 401 - so trusting the body would let a
    // response body decide whether a credential gets rotated, which is authority in the wrong place.
    status: httpStatus,
    detail,
    instance,
    request_id: requestId,
  };
  const errors = readValidationErrors(record[VALIDATION_ERRORS_FIELD]);
  return errors === undefined ? problem : { ...problem, errors };
}

/**
 * Parse `Retry-After`, which HTTP permits in two forms.
 *
 * The service emits an integer number of seconds; a proxy in front of it may emit an HTTP date
 * instead, so both are handled. A date already in the past yields `0` - "retry now" - rather than a
 * negative interval a caller would have to guard against. Anything unparseable yields `null`.
 */
function parseRetryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get(RETRY_AFTER_HEADER);
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (DELTA_SECONDS_PATTERN.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const deadline = Date.parse(trimmed);
  if (Number.isNaN(deadline)) {
    return null;
  }
  return Math.max(0, Math.ceil((deadline - Date.now()) / MILLISECONDS_PER_SECOND));
}

/* -------------------------------------------------------------------------------------------------
 * Base URL, path composition and query strings
 * ---------------------------------------------------------------------------------------------- */

/**
 * Resolve the API base URL, prefix included, from the environment.
 *
 * **Read lazily, at call time, and never captured into a module-level constant.** That placement is
 * a correctness requirement with two independent causes, and violating it breaks each in a way that
 * looks like something else:
 *
 * 1. `frontend/vitest.config.ts` applies its pinned `test.env` block *before* a test module is
 *    evaluated but the value is only observable once module evaluation has happened; a module-scope
 *    capture would freeze whatever ambient value existed at import time, and a request built from a
 *    URL fixed at module evaluation cannot be intercepted at the network boundary at all. The
 *    component suite runs Mock Service Worker with `onUnhandledRequest: 'error'`, so that failure
 *    surfaces as every component test failing for an unrelated-looking reason.
 * 2. A deployment supplies the address at run time - an orchestrator's environment, a container's
 *    `--env-file` - and a module-scope capture in a server process would freeze whatever was set
 *    when the module was first imported rather than what the deployment configured.
 *
 * The key is written as a static member access rather than a computed one because the framework
 * inlines `process.env.NEXT_PUBLIC_*` textually at build time; an indexed read would not be
 * substituted and would resolve to `undefined` in the browser bundle.
 *
 * ## One key, two execution contexts, and why that is a deployment decision
 *
 * This module runs in two places - a browser fetching from a client island, and the Next.js server
 * process rendering a Server Component, a route handler or the generated sitemap - and both resolve
 * the same single value. That is deliberate: `.env.example` is a closed fifteen-key contract, and a
 * second server-only address would grow it to sixteen in order to encode a routing decision as
 * configuration.
 *
 * The obligation it places on a deployment is therefore explicit: `NEXT_PUBLIC_API_BASE_URL` must be
 * an address that resolves from **both** contexts. Publishing the API at one hostname and routing it
 * - an ingress, a shared hostname, a reverse proxy in front of both tiers - satisfies that, and it
 * is what a deployment serving a browser over the public network already has to do. Local
 * development satisfies it too, because `http://localhost:8000/api/v1` is reachable from the browser
 * and from the Next.js process on the same host.
 *
 * @throws Error when the variable yields no value. Deliberately loud: a silent default origin would
 * turn a missing deployment variable into requests quietly aimed at the wrong service.
 */
function resolveApiBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (configured === undefined || configured.trim() === '') {
    throw new Error(
      `${API_BASE_URL_ENV_KEY} is not set, so the presentation tier has no API to call. ` +
        `Copy the NEXT_PUBLIC_ block of .env.example into frontend/.env.local; the documented ` +
        `value is http://localhost:8000${API_VERSION_PREFIX}. It must resolve from a reader's ` +
        `browser and from the Next.js server process alike, so a deployment publishes the API at ` +
        `one routable address rather than configuring a second one here.`,
    );
  }
  const base = configured.trim().replace(TRAILING_SLASHES_PATTERN, '');
  // Idempotent composition. `.env.example` documents the configured value as already carrying the
  // version prefix, so the common case appends nothing; a bare origin is completed. Either way the
  // prefix ends up present exactly once, which is the guarantee that lets callers pass bare paths.
  return base.endsWith(API_VERSION_PREFIX) ? base : `${base}${API_VERSION_PREFIX}`;
}

/**
 * Normalise a caller's namespace-relative path and reject one that has already been versioned.
 *
 * A leading slash is optional for the caller's convenience and always present in the result. A path
 * that already carries `/api/v1` is a defect in the calling wrapper: repairing it silently would let
 * two path conventions coexist, which is precisely what the single-composition rule exists to
 * prevent, and doubling it would produce a 404 whose cause is far from the mistake.
 *
 * @throws Error when the path already carries the version prefix.
 */
function normaliseApiPath(path: string): string {
  const relative = path.startsWith('/') ? path : `/${path}`;
  if (relative === API_VERSION_PREFIX || relative.startsWith(`${API_VERSION_PREFIX}/`)) {
    throw new Error(
      `API path "${path}" already carries the ${API_VERSION_PREFIX} prefix. Callers pass ` +
        `namespace-relative paths such as /posts or /auth/login; the version prefix is composed ` +
        `once by frontend/src/lib/api/client.ts.`,
    );
  }
  return relative;
}

/**
 * Serialise query parameters, omitting the ones the caller does not actually have.
 *
 * `undefined`, `null` and `''` are treated as absent, which is what lets a caller forward its whole
 * filter state - a blank search box, an unselected category, a default sort - and still produce
 * `GET /posts` rather than `GET /posts?q=&category=&sort=`. Booleans and numbers are stringified;
 * arrays are deliberately not supported, because no endpoint in this API takes a repeated parameter
 * and inventing an encoding for one would be a convention nothing agrees with.
 *
 * @returns The empty string when nothing survives, otherwise a string beginning with `?`.
 */
export function buildQueryString(params?: QueryParams): string {
  if (params === undefined) {
    return '';
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    const encoded = typeof value === 'string' ? value : String(value);
    if (encoded === '') {
      continue;
    }
    search.append(key, encoded);
  }
  const serialised = search.toString();
  return serialised === '' ? '' : `?${serialised}`;
}

/**
 * The `instance` member for a document this module synthesises: the failing path, version prefix
 * included and query string deliberately excluded.
 *
 * Excluding the query is the same rule the service applies, and for the same reason - the query is
 * not part of a failure's identity and is where a stray credential would end up. Including the
 * prefix makes a synthesised document indistinguishable in shape from a received one.
 */
function problemInstance(relativePath: string): string {
  return `${API_VERSION_PREFIX}${relativePath}`;
}

/* -------------------------------------------------------------------------------------------------
 * Credential store
 *
 * Module-scoped rather than React state, because every client island in the tab needs the same
 * credential and none of them shares a React tree with the others. The auth provider drives these
 * functions; this module owns no component state and re-renders nothing.
 *
 * BROWSER-ONLY, AND THAT IS A SECURITY PROPERTY RATHER THAN A LIMITATION
 *
 * A module global on a server is shared by every concurrent render in the process. Storing a
 * per-reader credential there means one reader's token is attached to another reader's request - not
 * as a race that is hard to hit, but as the ordinary behaviour once two people load a page at the
 * same time. So the store is inert outside a browser: nothing is written, nothing is read, and
 * `dispatch` attaches no stored bearer.
 *
 * A server render that needs an authenticated read therefore passes the credential explicitly, per
 * request, through {@link RequestOptions.bearer}, resolved from that request's own context. Rotation
 * is disabled for such a request, because there is nowhere to put a new pair and the caller owns the
 * one it supplied.
 * ---------------------------------------------------------------------------------------------- */

let accessToken: string | null = null;
let refreshToken: string | null = null;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * How many times the held credential has been replaced or cleared.
 *
 * The session identity a rotation is checked against. A rotation is an in-flight network request, and
 * anything can happen while it is running: the reader signs out, another tab's restore adopts a
 * different pair, a `401` elsewhere abandons the session. Adopting a rotation's result unconditionally
 * would then *resurrect* a session that had been ended, or overwrite a newer pair with an older one.
 *
 * So {@link rotateCredentials} reads this before it dispatches and compares it before it adopts: if
 * the number moved, the rotation has been superseded and its result is discarded rather than stored.
 * A monotonic counter rather than a token comparison because it also detects a return to the *same*
 * value - cleared and then re-adopted - which comparing tokens would miss.
 */
let credentialGeneration = 0;

/**
 * The single in-flight rotation, or `null` when none is running. See {@link refreshCredentials} for
 * why one shared promise is the whole of the single-flight guarantee.
 */
let rotationInFlight: Promise<TokenPair | null> | null = null;

/**
 * Whether this code is executing in a browser.
 *
 * `window` rather than `document`, because the two answer different questions: `document` is about
 * whether a cookie can be written, and this is about whether there is a single reader whose
 * credential a module global may hold. Both are false on a server, but they are checked separately so
 * neither reads as a proxy for the other.
 */
function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/** Options of {@link setCredentials}. */
export interface AdoptCredentialsOptions {
  /**
   * Whether to mirror the adopted refresh token into the durable session store.
   *
   * `true` by default, which is right for every ordinary adoption - a sign-in or a rotation produces
   * a token the next document will need. Pass `false` from {@link recoverDurableSession} alone: the
   * session route has already written that pair's refresh token into its own cookie, so mirroring it
   * back would be a request writing the value that is already there.
   *
   * Only consulted when the mirror is armed at all; see {@link setDurableSessionMirror}.
   */
  readonly persist?: boolean;
}

/**
 * Adopt a credential pair: sign-in, rotation and session restore all land here.
 *
 * Writes **no cookie itself**, and that distinction is worth keeping precise now that two cookies
 * exist. The session marker `src/middleware.ts` reads is the provider's to write, because it carries
 * the principal's role and this module never sees a principal - only a token pair. The durable
 * refresh cookie is written by `src/app/api/session/route.ts`, on the server, because it is
 * `HttpOnly` and therefore not writable from a document at all; this function asks that route to
 * update it and never touches `document.cookie`. See {@link AUTH_COOKIE_NAME} for why the marker is
 * not the token, and the durable-session section for why the credential is not in a script-readable
 * store.
 *
 * @param tokens - The pair to adopt.
 * @param options - See {@link AdoptCredentialsOptions}.
 */
export function setCredentials(tokens: TokenPair, options?: AdoptCredentialsOptions): void {
  // Inert outside a browser. A server has no single reader to hold a credential for, and the store
  // is a module global shared by every concurrent render - see the section header. A server-side
  // caller that has a token uses `RequestOptions.bearer`, which is scoped to one request.
  if (!isBrowser()) {
    return;
  }
  accessToken = tokens.access_token;
  refreshToken = tokens.refresh_token;
  credentialGeneration += 1;

  // AFTER the store is updated, never before: this document's own requests must be able to proceed on
  // the new bearer whether or not the mirror write lands. Inert unless the provider has armed it.
  if (options?.persist !== false) {
    persistDurableSession(tokens.refresh_token);
  }
}

/**
 * Forget the credential entirely: sign-out, a refused rotation, or a session that cannot be
 * restored.
 *
 * Clears the in-memory pair only. Expiring the session marker is the provider's half of the same
 * transition - it owns every cookie write in this tier - and it calls this function alongside its
 * own clear, so the two always move together.
 */
export function clearCredentials(): void {
  accessToken = null;
  refreshToken = null;
  // The durable copy goes with the in-memory one, so a session that has ended cannot be recovered by
  // the next document. Inert unless the provider has armed the mirror, and it deliberately runs even
  // when there was nothing in the store to clear - the intent is what matters, and a document that
  // never held a token in memory can still be the one that ends the session.
  forgetDurableSession();
  // Bumped even when there was nothing to clear, and deliberately: an in-flight rotation must be
  // superseded by the *intent* to end the session, not merely by a token having changed. A sign-out
  // that lands while a rotation is in flight is exactly the case, and it is the one where adopting
  // the rotation's result would sign the reader back in.
  credentialGeneration += 1;
}

/**
 * The access token currently held, or `null`.
 *
 * `null` is an ordinary state, not an error: the feed, a post, a profile, the category list and both
 * public read endpoints on a post all answer without a credential.
 */
export function getAccessToken(): string | null {
  return heldAccessToken();
}

/**
 * The stored access token, or `null` outside a browser.
 *
 * The internal read every code path in this module uses, so the browser-only rule is enforced in one
 * place rather than at each of the four sites that want the token. On a server the store is never
 * written, so this is `null` there in any case - but reading through this function states the rule
 * rather than relying on it.
 */
function heldAccessToken(): string | null {
  return isBrowser() ? accessToken : null;
}

/**
 * The rotation credential currently held, or `null` - which it always is outside a browser.
 *
 * Exposed for exactly one caller: `@/lib/api/auth`'s sign-out, which has to name the token it is
 * revoking in a request body. Rotation itself does **not** go through here - {@link rotateSession}
 * reads the store internally - because a caller that reads the token and then presents it separately
 * is a caller racing the single-flight path.
 *
 * It is an **opaque** high-entropy string, not a JWT: never decode it, never parse it, never put it in
 * a URL, a log or a rendered surface. The service keeps only its hash, so it cannot be recovered
 * there either.
 */
export function getRefreshToken(): string | null {
  return isBrowser() ? refreshToken : null;
}

/**
 * Register - or, with `null`, remove - the callback invoked when authentication is definitively gone.
 *
 * Exactly one handler is held; registering replaces it, which suits a provider that mounts once.
 * Pass `null` from an effect's cleanup. See {@link UnauthorizedHandler} for what a handler may and
 * may not do.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

/**
 * Give up on the session: clear the credential, then notify.
 *
 * The notification is scheduled as a microtask rather than called inline. A handler is application
 * code that may throw; called inline, its exception would propagate out of this module's failure
 * path and *replace* the {@link ApiError} the caller is waiting for, turning a legible 401 into
 * something unrelated. Scheduled, a throwing handler surfaces as its own unhandled error and the
 * caller still receives the real failure.
 */
function abandonSession(): void {
  clearCredentials();
  const handler = unauthorizedHandler;
  if (handler === null) {
    return;
  }
  queueMicrotask(handler);
}

/* -------------------------------------------------------------------------------------------------
 * The durable session, and the one same-origin route in this module
 *
 * WHAT PROBLEM THIS SOLVES
 *
 * The credential store above is a module global, so it dies with the JavaScript context. A full page
 * reload, a middle-click into a new tab, or following an external link back into the site therefore
 * arrived with no access token and no refresh token - while the session marker cookie
 * `src/middleware.ts` reads was still there, because it is a cookie. The route protection admitted
 * the navigation on the strength of that marker and the new document then had nothing to
 * authenticate with, so the provider cleared the marker and presented an anonymous session. The
 * reader was signed out by every full navigation, having done nothing.
 *
 * WHY THE CREDENTIAL CANNOT SIMPLY BE PERSISTED HERE
 *
 * Everything a browser script can write, a browser script can read. `localStorage`,
 * `sessionStorage` and a script-written cookie are all readable by every same-origin script the page
 * will ever load - an analytics snippet, a transitive dependency, anything reflected into the page -
 * and a cookie written by script CANNOT be `HttpOnly`, because that flag exists precisely to hide a
 * cookie from script. Putting a refresh token in any of them publishes a long-lived credential to
 * all of them (CWE-522, CWE-1004, CWE-922). The session marker is safe to write from script for
 * exactly the opposite reason: it authenticates nothing.
 *
 * SO THE CREDENTIAL IS HELD BY A SERVER THIS APPLICATION ALREADY RUNS
 *
 * `src/app/api/session/route.ts` is a Next.js Route Handler on this application's OWN origin. It
 * writes the refresh token into a cookie that is `HttpOnly`, `SameSite=Strict`, path-scoped to that
 * route and `Secure` wherever the request arrived over https. No script in the document can read it,
 * it is not attached to any other request, and a cross-site request cannot carry it. The three
 * operations below are the whole of this tier's view of it:
 *
 *   {@link persistDurableSession}  hand the token over after adoption
 *   {@link recoverDurableSession}  ask the route to rotate and hand back a usable pair
 *   {@link forgetDurableSession}   drop it at the end of the session
 *
 * The token is still held in memory here as well, and that is not a weakening: memory is where the
 * bearer is attached from, and rotation revokes and replaces both halves at once. The durable copy
 * exists so that the NEXT document has something to rotate.
 *
 * THE MIRROR IS ARMED, NOT UNCONDITIONAL
 *
 * `setCredentials` and `clearCredentials` are the two funnels every credential transition passes
 * through - sign-in, single-flight rotation, sign-out, an abandoned session - so mirroring from them
 * is what makes the durable copy incapable of holding a token the store has already replaced. But
 * they are also called directly by tests that have no interest in a session route, and by a component
 * spec whose request mocking fails the test on any unhandled request. So the mirror is switched on by
 * the provider that owns the session lifecycle - see {@link setDurableSessionMirror} - exactly as the
 * unauthorised handler is registered by it. Nothing else in the tier may arm it.
 *
 * WHAT THIS SECTION DELIBERATELY DOES NOT DO
 *
 *   * **It does not rotate.** {@link recoverDurableSession} asks the ROUTE to rotate, because the
 *     durable copy is the only token a fresh document holds and the route is the only thing that can
 *     read it. In-document rotation stays where it belongs, in the single-flight path above.
 *   * **It does not decide who the reader is.** No principal is resolved and no marker is touched;
 *     that is the provider's, which reads `GET /auth/me` once a credential exists.
 *   * **It does not report its own failures to the caller of an ordinary request.** A mirror write
 *     that fails costs recoverability on the next document and nothing else, so it is swallowed
 *     rather than allowed to fail a sign-in that has already succeeded.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Path of the session route, on this application's own origin.
 *
 * Relative and absolute-from-root, never composed onto {@link resolveApiBaseUrl}: this is NOT the
 * API. It is a route in this Next.js application, and the two live at different origins in every
 * deployment where the service is a separate container.
 *
 * Exported so `src/app/api/session/route.ts` can scope its cookie's `Path` to the same literal it is
 * served at - one declaration, so the cookie cannot end up scoped to a path the route does not
 * occupy, which would fail silently by simply never being sent.
 */
export const DURABLE_SESSION_ROUTE = '/api/session';

/**
 * Name of the cookie the session route owns.
 *
 * Declared here beside {@link AUTH_COOKIE_NAME} so the two names that make up this tier's session are
 * visible together, and so the difference between them is stated once: `blog_session` is a
 * script-written ROLE MARKER that authenticates nothing, and `blog_refresh` is an `HttpOnly`
 * CREDENTIAL that no script in this tier can read - not even this module, which only ever asks the
 * route to act on it.
 */
export const DURABLE_SESSION_COOKIE_NAME = 'blog_refresh';

/**
 * Whether credential transitions are mirrored into the durable store. See the section header.
 *
 * `false` by default, so a module imported without a provider - a Server Component, a unit test, a
 * component spec that seeds the store directly - issues no same-origin request it did not ask for.
 */
let durableSessionArmed = false;

/**
 * Arm or disarm the durable session mirror for this document.
 *
 * Called once by `src/providers/auth-provider.tsx`, which is the single owner of the session
 * lifecycle: `true` on mount, `false` from the effect's cleanup. Idempotent, and inert outside a
 * browser - there is no single reader to hold a session for on a server, and the credential store is
 * inert there for the same reason.
 *
 * @param enabled - `true` to mirror adoption and clearing into the session route.
 */
export function setDurableSessionMirror(enabled: boolean): void {
  durableSessionArmed = enabled && isBrowser();
}

/**
 * Issue one request to the session route.
 *
 * Written against `fetch` directly rather than through {@link dispatch}, and the separation is
 * deliberate: `dispatch` composes the API base URL, attaches the bearer, and rotates on a `401`.
 * Every one of those is wrong here. This route is on a different origin from the API, it
 * authenticates from its own cookie rather than from a bearer, and a `401` from it MEANS the session
 * is over - rotating in response would be the recursion this module is otherwise careful to make
 * impossible.
 *
 * `credentials: 'same-origin'` is explicit rather than relied upon as the default: the cookie is the
 * entire point of the request, and a default that changed would disable the feature silently.
 *
 * @param method - `PUT` to adopt, `POST` to rotate, `DELETE` to clear.
 * @param body - The JSON body, or `undefined` for the two operations that carry none.
 * @returns The raw response. Status interpretation belongs to each caller, which is why nothing is
 * thrown here.
 */
async function requestDurableSession(
  method: 'PUT' | 'POST' | 'DELETE',
  body?: Readonly<Record<string, string>>,
): Promise<Response> {
  return fetch(DURABLE_SESSION_ROUTE, {
    method,
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { [CONTENT_TYPE_HEADER]: JSON_MEDIA_TYPE } }),
  });
}

/**
 * Hand a freshly adopted refresh token to the session route, so the next document can use it.
 *
 * Fire-and-forget by design, with every failure swallowed. It runs immediately after a sign-in or a
 * rotation that has already succeeded, and the only thing a failure costs is recoverability on the
 * next document - the in-memory pair is intact and this document continues to work. Failing the
 * sign-in over it would turn a recovery aid into a new way to be unable to sign in.
 *
 * The window this leaves is named honestly rather than papered over: a rotation whose mirror write
 * has not landed when the document is destroyed leaves a spent token in the cookie, and the next
 * document's recovery is refused. That degrades to a sign-in - the behaviour before any of this
 * existed - and never to a wrong or resurrected session, because the service revokes a presented
 * refresh token as it issues the replacement.
 */
function persistDurableSession(refreshCredential: string): void {
  if (!durableSessionArmed) {
    return;
  }
  void requestDurableSession('PUT', { [REFRESH_TOKEN_FIELD]: refreshCredential }).catch(() => {
    // Deliberately empty: see the docblock. There is no caller to report to and nothing to retry
    // against, and a rejected promise left unhandled here would surface as an unrelated error.
  });
}

/**
 * Tell the session route to drop the durable credential.
 *
 * Fire-and-forget for the same reason as {@link persistDurableSession}: it runs on a transition that
 * has already happened locally. A failure leaves a cookie whose token the service has revoked -
 * `POST /auth/logout` revokes it, and a refused recovery clears the cookie on the way out - so the
 * next document's recovery is refused and the reader signs in, which is the correct outcome for
 * somebody who signed out.
 */
function forgetDurableSession(): void {
  if (!durableSessionArmed) {
    return;
  }
  void requestDurableSession('DELETE').catch(() => {
    // Deliberately empty: see the docblock.
  });
}

/**
 * Recover this document's session from the durable credential, or report that there is none.
 *
 * The FIRST thing a new document does when the session marker says a session existed. It asks the
 * session route to rotate: the route reads its own `HttpOnly` cookie, presents it to
 * `POST /api/v1/auth/refresh`, writes the replacement back into the cookie, and returns the new pair.
 * The pair is then adopted here, so the bearer is armed before `GET /auth/me` is ever called - which
 * is why the provider can treat a `401` from that read as a real answer rather than as the expected
 * consequence of having no credential.
 *
 * Rotation-before-validation is the correct order and not merely convenient. A refresh token is
 * single-use, so presenting the stored one is also what PROVES the session is still live: a token the
 * service has revoked, expired or seen twice is refused, and the session is over with no further
 * question to ask.
 *
 * Adopted with `persist: false`, because the route has already written the rotated token into the
 * cookie; mirroring it straight back would be a second request writing the value that is already
 * there.
 *
 * @param signal - Cancellation from the caller's effect, so an unmounted provider releases the
 * request rather than leaving it to run to completion.
 * @returns The adopted pair.
 * @throws {@link ApiError} for every failure, classified so the caller can tell the two apart that
 * matter: a `401` means there is no usable durable credential and the session is genuinely over,
 * while a transport failure or a `5xx` means the question could not be asked and the session must be
 * left exactly as it was.
 */
export async function recoverDurableSession(signal?: AbortSignal): Promise<TokenPair> {
  let response: Response;
  try {
    response = await fetch(DURABLE_SESSION_ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    // No response at all: offline, aborted, or the route unreachable. Says nothing about the
    // credential, so it is reported as a transport failure and the caller leaves the session alone.
    throw new ApiError(
      synthesiseProblemDetail({
        type: isAbortError(cause) ? ERROR_TYPE_ABORTED : ERROR_TYPE_NETWORK,
        title: isAbortError(cause) ? 'Request cancelled' : 'Network error',
        status: NO_RESPONSE_STATUS,
        detail: isAbortError(cause)
          ? 'The session could not be restored because the request was cancelled.'
          : 'The session could not be restored because the application could not be reached.',
        instance: DURABLE_SESSION_ROUTE,
      }),
    );
  }

  if (!response.ok) {
    throw new ApiError(
      synthesiseProblemDetail({
        type: ERROR_TYPE_HTTP,
        title: response.status === HTTP_UNAUTHORIZED ? 'Session expired' : 'Session not restored',
        status: response.status,
        detail:
          response.status === HTTP_UNAUTHORIZED
            ? 'The stored session could not be renewed. Sign in again to continue.'
            : 'The stored session could not be renewed.',
        instance: DURABLE_SESSION_ROUTE,
      }),
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  let recovered: TokenPair;
  try {
    recovered = tokenPairDecoder.parse(payload);
  } catch {
    // A body that is not a token pair must never be STORED as one - that failure mode makes every
    // later request fail instead of this one. Reported as a malformed answer, which the caller
    // classifies as a defect rather than as a dead session.
    throw new ApiError(
      synthesiseProblemDetail({
        type: ERROR_TYPE_MALFORMED_RESPONSE,
        title: 'Malformed response',
        status: response.status,
        detail: 'The session route did not answer with a credential pair.',
        instance: DURABLE_SESSION_ROUTE,
      }),
    );
  }

  setCredentials(recovered, { persist: false });
  return recovered;
}

/* -------------------------------------------------------------------------------------------------
 * Request body encoding
 * ---------------------------------------------------------------------------------------------- */

/** Serialise form fields. Used by exactly one route; see {@link apiPostForm} for which and why. */
function encodeFormFields(fields: FormFields): string {
  const encoded = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    encoded.append(key, value);
  }
  return encoded.toString();
}

/**
 * Decide what body, if any, a request carries.
 *
 * Returning `undefined` is meaningful rather than a fallback: a request with no body sends **no
 * `Content-Type` header at all**, which is what an empty mutation such as
 * `POST /posts/{id}/publish` or `POST /posts/{id}/unpublish` needs. Declaring a JSON content type
 * over an absent body describes the request incorrectly.
 *
 * @throws Error when both encodings are requested, which is a programming error rather than a
 * runtime condition - one request has one body.
 */
function buildPayload(options: PayloadRequestOptions): Payload | undefined {
  const { json, form } = options;
  if (json !== undefined && form !== undefined) {
    throw new Error(
      'An API request carries either a JSON body or a form-encoded body, never both. ' +
        'Sign-in is the only form-encoded route; every other route takes JSON.',
    );
  }
  if (form !== undefined) {
    return { contentType: FORM_MEDIA_TYPE, body: encodeFormFields(form) };
  }
  if (json !== undefined) {
    return { contentType: JSON_MEDIA_TYPE, body: JSON.stringify(json) };
  }
  return undefined;
}

/**
 * Collapse the public options plus a resolved payload into the fully explicit dispatch shape.
 *
 * Three defaults are resolved here rather than downstream, so no branch below has to re-derive one:
 *
 * * `timeoutMs` falls back to {@link DEFAULT_TIMEOUT_MS} when the caller said nothing. A caller that
 *   passed `0` or a negative number said something - "no deadline" - and it is preserved.
 * * `allowRefresh` is the AND of what this call site permits and what the caller permits, and a
 *   caller-supplied `bearer` removes it outright: rotation writes into a store that request is not
 *   reading, and on a server there is no store at all.
 * * `anonymousFallback` is opt-in, so a request whose answer depends on who is asking can never be
 *   silently downgraded to the public projection.
 */
function toDispatchOptions(options: PayloadRequestOptions, allowRefresh: boolean): DispatchOptions {
  const callerBearer = options.anonymous === true ? undefined : options.bearer;
  return {
    payload: buildPayload(options),
    query: options.query,
    signal: options.signal,
    anonymous: options.anonymous === true,
    cache: options.cache,
    next: options.next,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    bearer: callerBearer,
    allowRefresh: allowRefresh && options.allowRefresh !== false && callerBearer === undefined,
    anonymousFallback: options.anonymousFallback === true,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The per-attempt deadline
 * ---------------------------------------------------------------------------------------------- */

/**
 * Arm a deadline for one attempt, composed with whatever cancellation the caller supplied.
 *
 * Composed by hand rather than with `AbortSignal.any`, for two reasons that both matter. The first is
 * reach: this module runs in a browser, in the Node server runtime, and under `jsdom` in the component
 * suite, and hand composition needs nothing beyond `AbortController` and `addEventListener`. The
 * second is diagnosis: composing signals loses *which* one fired, and a request that timed out is a
 * different fact from a request the reader cancelled - one is a fault worth reporting, the other is
 * the reader getting what they asked for.
 *
 * Returns `signal: undefined` only when there is nothing to arm at all: no caller signal and a
 * non-positive timeout. That case passes no `signal` to `fetch` rather than an inert one.
 *
 * **{@link Deadline.dispose} must be called**, and after the body has been consumed rather than after
 * the response arrives: aborting a signal mid-body cancels the read. A pending timer keeps the runtime
 * alive and, more visibly, would abort a completed request's stream some seconds later. Every caller
 * below disposes in a `finally`.
 */
function startDeadline(timeoutMs: number, callerSignal: AbortSignal | undefined): Deadline {
  if (timeoutMs <= 0) {
    // Nothing to arm. The caller's own signal, if any, is used directly - wrapping it would add a
    // listener and a controller for no behaviour.
    return { signal: callerSignal, expired: () => false, dispose: () => undefined };
  }

  const controller = new AbortController();
  let timedOut = false;
  let disposed = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // The caller's abort has to be forwarded, because `fetch` is given this controller's signal and
  // not the caller's. Forwarded WITHOUT setting `timedOut`, which is what keeps the two causes
  // distinguishable afterwards.
  const forwardAbort = (): void => {
    controller.abort();
  };
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) {
      // Already cancelled before the request was built. Abort immediately rather than waiting for an
      // event that has already fired and will not fire again.
      forwardAbort();
    } else {
      callerSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    expired: () => timedOut,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', forwardAbort);
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Response body reading and failure construction
 * ---------------------------------------------------------------------------------------------- */

/** Whether a caught value is the abort a cancelled `fetch` rejects with. */
function isAbortError(cause: unknown): boolean {
  return (
    typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'AbortError'
  );
}

/**
 * Wrap a `fetch`-level rejection - no response was ever received - as an {@link ApiError}.
 *
 * Offline, DNS failure, refused connection, TLS failure and cancellation all land here, so a caller
 * still has exactly one failure type to catch. The cause is deliberately **not** attached: a
 * platform error's message and stack can carry the full request URL, and this module does not
 * republish a URL onto an object that application code may log or serialise.
 */
function toTransportError(cause: unknown, instance: string, timedOut = false): ApiError {
  if (timedOut) {
    // Checked before the abort branch, because a deadline aborts the request and therefore arrives as
    // an AbortError too. Reporting that as a cancellation would blame the reader for a stalled
    // service, and the two need different handling: a cancellation is expected and usually silent,
    // whereas a timeout is worth surfacing and worth retrying.
    return new ApiError(
      synthesiseProblemDetail({
        type: ERROR_TYPE_TIMEOUT,
        title: 'Request timed out',
        status: NO_RESPONSE_STATUS,
        detail: 'The API did not answer in time. It may be unreachable or overloaded.',
        instance,
      }),
    );
  }
  if (isAbortError(cause)) {
    return new ApiError(
      synthesiseProblemDetail({
        type: ERROR_TYPE_ABORTED,
        title: 'Request aborted',
        status: NO_RESPONSE_STATUS,
        detail: 'The request was cancelled before the API answered.',
        instance,
      }),
    );
  }
  return new ApiError(
    synthesiseProblemDetail({
      type: ERROR_TYPE_NETWORK,
      title: 'Network error',
      status: NO_RESPONSE_STATUS,
      detail: 'The API could not be reached. Check the connection and that the service is running.',
      instance,
    }),
  );
}

/**
 * Read a body as text, treating a mid-stream failure as no body at all.
 *
 * Used only while building a failure. A connection that dies while the error body is arriving must
 * not mask the status code that was already received, which is the one fact worth reporting.
 */
async function readBodyTextOrEmpty(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    // The status is already known and is the more useful signal; an unreadable body degrades to no
    // body, which readProblemDetail turns into the synthesised fallback.
    return '';
  }
}

/**
 * Parse a JSON document from text, or return `undefined` when it is not JSON at all.
 *
 * A gateway 502 arrives as HTML and a load-balancer timeout as plain text; neither is a defect in
 * this module and neither may be allowed to throw a `SyntaxError` in place of the real failure.
 */
function parseJsonOrUndefined(text: string): unknown {
  if (text.trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON. The caller falls back to a synthesised document built from the status line.
    return undefined;
  }
}

/**
 * Turn a non-OK response into the {@link ApiError} a caller will receive.
 *
 * The body is read **exactly once and always**, which matters for two reasons beyond tidiness: an
 * unread body holds its connection open, and the rotation path needs to be able to throw this error
 * *later* if the rotation is refused - which is only possible if the body was already consumed into a
 * value rather than left on the stream.
 */
async function toApiError(response: Response, instance: string): Promise<ApiError> {
  const requestId = response.headers.get(REQUEST_ID_HEADER) ?? '';
  const statusText = response.statusText.trim();
  const statusLabel = statusText === '' ? `HTTP ${String(response.status)}` : statusText;
  const fallback = synthesiseProblemDetail({
    type: ERROR_TYPE_HTTP,
    title: statusLabel,
    status: response.status,
    detail: `The API answered ${String(response.status)} ${statusLabel} and its body was not a problem document.`,
    instance,
    requestId,
  });
  const payload = parseJsonOrUndefined(await readBodyTextOrEmpty(response));
  return new ApiError(
    readProblemDetail(payload, fallback, response.status),
    parseRetryAfterSeconds(response),
    response.headers.get(WWW_AUTHENTICATE_HEADER),
  );
}

/**
 * Read a successful response as JSON.
 *
 * Two failure modes are converted rather than allowed to escape, so a caller never has to catch
 * anything but {@link ApiError}: a body that is absent where a resource was expected, and a body that
 * will not parse. The first is the `204` trap seen from the other side - a caller that asked for a
 * resource and received no content has hit a contract mismatch, and saying so is far more useful
 * than handing back a value that lies about its type.
 */
async function readJsonBody<T>(
  attempt: Attempt,
  decoder: ResponseDecoder<T>,
  instance: string,
): Promise<T> {
  const { response, deadline } = attempt;
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    const timedOut = deadline.expired();
    throw toTransportError(cause, instance, timedOut);
  } finally {
    // The body is read, so the deadline has done its job. Disposed here rather than by the caller
    // because every exit from this function - value, decode failure, transport failure - passes
    // through it, and a timer that outlives its request would abort a stream nobody is waiting on.
    deadline.dispose();
  }

  const requestId = response.headers.get(REQUEST_ID_HEADER) ?? '';
  if (response.status === HTTP_NO_CONTENT || text.trim() === '') {
    throw new ApiError(
      synthesiseProblemDetail({
        type: ERROR_TYPE_MALFORMED_RESPONSE,
        title: 'Empty response body',
        status: response.status,
        detail: `The API answered ${String(response.status)} with no body where a JSON resource was expected. Use the no-content form of this call for a route that answers 204.`,
        instance,
        requestId,
      }),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(
      synthesiseProblemDetail({
        type: ERROR_TYPE_MALFORMED_RESPONSE,
        title: 'Malformed response body',
        status: response.status,
        detail: `The API answered ${String(response.status)} with a body that is not valid JSON.`,
        instance,
        requestId,
      }),
    );
  }

  // THE DECODE IS THE CONTRACT CHECK, and it is what a bare `as T` never was. `JSON.parse` returns
  // whatever arrived; asserting a type over it is a compile-time claim about a runtime value that
  // nothing verified, so a body missing a member, carrying a null where a string was declared, or
  // answering an entirely different shape satisfied the generic and reached consumers as a value that
  // lies about itself. The failure then surfaced far from here - a component reading `post.author.
  // username` off an undefined author - or, worse, did not surface at all: an unrecognised token
  // response was adopted as a credential and every later request failed instead.
  //
  // Two properties make this worth doing at the boundary rather than at the point of use. The
  // rejection names the endpoint and carries the request identifier, so a contract drift is
  // diagnosable from the error alone; and it is the same `ApiError` every other failure is, so no
  // caller needs a second kind of catch.
  try {
    return decoder.parse(parsed);
  } catch (cause) {
    throw new ApiError(
      synthesiseProblemDetail({
        type: ERROR_TYPE_MALFORMED_RESPONSE,
        title: 'Unexpected response shape',
        status: response.status,
        detail: `The API answered ${String(response.status)} with a body that does not match the declared response contract for this endpoint: ${describeDecodeFailure(cause)}`,
        instance,
        requestId,
      }),
    );
  }
}

/**
 * Reduce a decoder's rejection to one short, safe line for a problem document's `detail`.
 *
 * Deliberately lossy. A validator's own message can be long, structured and shaped by the payload it
 * rejected, and a document's `detail` is a member the service writes to be safe to show to a person -
 * so the *content* of a rejected body must not be pasted into it. The message is taken when there is
 * one, trimmed, and truncated; anything else becomes a fixed phrase.
 */
function describeDecodeFailure(cause: unknown): string {
  const message =
    cause instanceof Error && cause.message.trim() !== ''
      ? cause.message.trim()
      : 'the response did not satisfy its schema';
  return message.length > DECODE_FAILURE_DETAIL_LIMIT
    ? `${message.slice(0, DECODE_FAILURE_DETAIL_LIMIT)}...`
    : message;
}

/**
 * Consume and discard the body of a response whose content is not wanted.
 *
 * The `204` path never touches `.json()` - calling it on an empty body throws - but it does read the
 * stream, because an unread body keeps its connection from being released. A `204` and a zero-length
 * `200` are handled identically: there is nothing to parse in either case.
 */
async function discardBody(attempt: Attempt): Promise<void> {
  try {
    await readBodyTextOrEmpty(attempt.response);
  } finally {
    attempt.deadline.dispose();
  }
}

/* -------------------------------------------------------------------------------------------------
 * Transport
 * ---------------------------------------------------------------------------------------------- */

/**
 * Issue one HTTP request. No retry, no rotation, no interpretation of the status.
 *
 * Header construction is owned here and is not extensible by a caller, which is the point: there is
 * one `Accept`, one credential scheme and one rule about `Content-Type`, so no call site can weaken
 * any of them. `credentials: 'omit'` is likewise deliberate rather than incidental - the two tiers
 * are separate origins, authentication is stateless bearer-token based, and session cookies are
 * excluded as a credential by design. Omitting them keeps ambient cookies off cross-origin requests
 * and keeps the service free of any need to allow credentialed CORS.
 */
async function sendRequest(
  method: HttpMethod,
  url: string,
  options: DispatchOptions,
  bearer: string | null,
  instance: string,
): Promise<Attempt> {
  const headers = new Headers();
  headers.set(ACCEPT_HEADER, `${JSON_MEDIA_TYPE}, ${PROBLEM_JSON_MEDIA_TYPE}`);
  if (options.payload !== undefined) {
    headers.set(CONTENT_TYPE_HEADER, options.payload.contentType);
  }
  if (bearer !== null) {
    headers.set(AUTHORIZATION_HEADER, `${BEARER_SCHEME}${bearer}`);
  }

  const init: RequestInit = { method, headers, credentials: 'omit' };
  if (options.payload !== undefined) {
    init.body = options.payload.body;
  }
  if (options.cache !== undefined) {
    init.cache = options.cache;
  }
  if (options.next !== undefined) {
    init.next = options.next;
  }

  // Armed here rather than in `dispatch`, so each attempt of a rotate-and-retry gets its own bound:
  // three network operations that can stall independently deserve three deadlines, and a single
  // shared one would let a slow first attempt eat the budget of the retry that was going to succeed.
  const deadline = startDeadline(options.timeoutMs, options.signal);
  if (deadline.signal !== undefined) {
    init.signal = deadline.signal;
  }

  try {
    return { response: await fetch(url, init), deadline };
  } catch (cause) {
    // Disposed on this path only. On the success path the deadline stays armed until the caller has
    // consumed the body, because aborting mid-stream would cancel that read - see `Deadline.dispose`.
    const timedOut = deadline.expired();
    deadline.dispose();
    throw toTransportError(cause, instance, timedOut);
  }
}

/**
 * Obtain a fresh credential pair, at most once concurrently. Internal; {@link rotateSession} is the
 * public entry point and the only one a consumer should reach for.
 *
 * **The single-flight guarantee is the shared promise, and nothing else.** A page mounts a feed, a
 * like button and a comment thread that all request at once; when the access token has expired they
 * all receive `401` within milliseconds of each other. Each rotation *revokes the token it presented*,
 * so three independent rotations would race to invalidate one another's replacement and at most one
 * of the three could survive - the observable symptom being a reader signed out at random while
 * using the site normally.
 *
 * The guard is therefore: if a rotation is running, hand back the very promise that is running
 * rather than starting another. The promise is cleared in `finally`, so a later expiry rotates again
 * rather than reusing a stale result. N concurrent unauthorised responses produce exactly ONE
 * request to `POST /api/v1/auth/refresh`.
 *
 * A second guard sits inside {@link rotateCredentials} and answers a different question: not "how
 * many rotations are running" but "is the session this rotation belongs to still the current one".
 * Sharing a promise cannot help there, because the interference arrives from outside rotation
 * entirely - a sign-out, or a restore adopting a different pair - so the result is compared against
 * {@link credentialGeneration} before it is adopted.
 *
 * @returns The new pair, or `null` when rotation was refused or there was nothing to present. `null`
 * means the session is over and {@link abandonSession} has already run.
 */
function refreshCredentials(): Promise<TokenPair | null> {
  if (rotationInFlight === null) {
    // `const` is safe despite the self-reference: the callback runs only when the rotation settles,
    // which is necessarily after this binding is initialised.
    const started: Promise<TokenPair | null> = rotateCredentials().finally(() => {
      // Release the slot only if it still holds THIS rotation. Nulling another one would silently
      // break the single-flight guarantee for every request still waiting behind it.
      if (rotationInFlight === started) {
        rotationInFlight = null;
      }
    });
    rotationInFlight = started;
  }
  return rotationInFlight;
}

/**
 * The rotation request itself, issued inline rather than through `@/lib/api/auth`.
 *
 * Two properties make recursion impossible rather than unlikely: the call is `anonymous`, so no
 * credential is attached and the unauthorised branch in {@link dispatch} cannot apply; and it is
 * dispatched with `allowRefresh: false`, so even a future change to the first condition cannot make a
 * refused rotation trigger another rotation.
 *
 * A refusal is swallowed into `null` on purpose. The caller's own request is the one that failed and
 * its normalised error is what a caller can act on; replacing it with the rotation's error would
 * report a request the application never made. Anything that is *not* an {@link ApiError} - a missing
 * environment variable, say - is a defect rather than a rejection and is re-thrown so it surfaces.
 */
async function rotateCredentials(): Promise<TokenPair | null> {
  const presented = refreshToken;
  if (presented === null || presented === '') {
    abandonSession();
    return null;
  }
  // Captured BEFORE the request, so the comparison after it spans the whole time the request was in
  // flight - which is the interval anything else could have changed the session in.
  const generation = credentialGeneration;
  try {
    const rotated = await dispatchJson<TokenPair>(
      'POST',
      REFRESH_PATH,
      { json: { [REFRESH_TOKEN_FIELD]: presented }, anonymous: true },
      tokenPairDecoder,
      false,
    );
    if (credentialGeneration !== generation) {
      // Superseded while in flight: the reader signed out, another rotation completed first, or a
      // session restore adopted a different pair. Adopting now would resurrect an ended session or
      // overwrite a newer credential with an older one, so the result is DISCARDED - and the session
      // is deliberately NOT abandoned, because whatever moved the generation is the authority on what
      // the session should be. The caller sees `null` and throws its original 401, which is honest:
      // this request did not get a usable credential.
      return null;
    }
    // Rotation replaces BOTH tokens: the presented refresh token is revoked as the new pair is
    // issued, so keeping the old one would guarantee the next rotation fails.
    setCredentials(rotated);
    return rotated;
  } catch (cause) {
    if (credentialGeneration !== generation) {
      // Refused, but the session has already moved on without this rotation - most likely because a
      // sign-out revoked the very token being presented. Abandoning here would clear a credential
      // that a concurrent sign-in may already have installed, so the failure is simply reported.
      if (!isApiError(cause)) {
        throw cause;
      }
      return null;
    }
    abandonSession();
    if (!isApiError(cause)) {
      throw cause;
    }
    return null;
  }
}

/**
 * The decoder for the one response this module reads on its own behalf: a rotated credential pair.
 *
 * Hand-written rather than imported from `@/lib/types`, and that is a deliberate cost of ten lines.
 * {@link ResponseDecoder} is structural precisely so that this is possible: keeping the check here
 * leaves this module with a single **type-only** import and no runtime dependency of its own, which
 * is what lets it be imported from a Server Component, a route handler, a middleware and a client
 * island alike without dragging a validator into each of those bundles. Every wrapper's decoder comes
 * from `@/lib/types`; this one cannot, because the module those live in must be free to import nothing
 * but its validator.
 *
 * It is also the decoder that matters most. A rotation's answer is **adopted as a credential**, so a
 * body that is not a token pair used to be stored as one, and every request afterwards failed instead
 * of the one that was actually wrong. Rejecting it here turns that into a refused rotation, which the
 * session-abandonment path already handles correctly.
 */
const tokenPairDecoder: ResponseDecoder<TokenPair> = {
  parse: (value: unknown): TokenPair => {
    if (typeof value !== 'object' || value === null) {
      throw new Error('a token pair was expected');
    }
    const record = value as Record<string, unknown>;
    const {
      access_token: access,
      refresh_token: refresh,
      token_type: type,
      expires_in: expires,
    } = record;
    if (
      typeof access !== 'string' ||
      access === '' ||
      typeof refresh !== 'string' ||
      refresh === '' ||
      type !== 'bearer' ||
      typeof expires !== 'number'
    ) {
      throw new Error('a token pair was expected');
    }
    return { access_token: access, refresh_token: refresh, token_type: type, expires_in: expires };
  },
};

/**
 * Rotate the session's credential, through the one single-flight path, and report the outcome.
 *
 * **This is the only public way to rotate**, and it exists so that no consumer has to reach for the
 * `POST /auth/refresh` wrapper directly. Calling that wrapper bypasses everything this function is:
 * the shared promise that collapses N concurrent rotations into one request, the generation guard
 * that stops a late rotation resurrecting an ended session, and the adoption of the new pair into the
 * store the rest of the tier reads. A rotation issued around this module is a rotation that can
 * revoke the token a rotation issued *through* it just obtained.
 *
 * Concurrency is therefore free: two callers arriving together receive the same promise and the same
 * pair, and exactly one request is made.
 *
 * @returns The newly adopted pair.
 * @throws {@link ApiError} when rotation was refused, when nothing was held to present, or when the
 * result was superseded mid-flight by a sign-out or another adoption. The session has already been
 * abandoned in the first two cases - {@link setUnauthorizedHandler}'s handler has run - so a caller
 * needs no cleanup of its own beyond dropping its view state.
 */
export async function rotateSession(): Promise<TokenPair> {
  const rotated = await refreshCredentials();
  if (rotated !== null) {
    return rotated;
  }
  throw new ApiError(
    synthesiseProblemDetail({
      type: ERROR_TYPE_HTTP,
      title: 'Session expired',
      status: HTTP_UNAUTHORIZED,
      detail: 'The session could not be renewed. Sign in again to continue.',
      instance: problemInstance(REFRESH_PATH),
    }),
  );
}

/**
 * Issue a request, and on a single unauthorised answer rotate the credential and retry it once.
 *
 * The sequence, and every branch that deliberately does *not* rotate:
 *
 * 1. Send. A `fetch`-level rejection is already an {@link ApiError} by the time it arrives here.
 * 2. On success, hand the attempt back for the caller's chosen body treatment - deadline included,
 *    still armed, for the caller to dispose once the body is read.
 * 3. On failure, normalise it *first* - which consumes the body exactly once, and lets the deadline be
 *    disposed immediately - and then decide.
 * 4. Rotate only when all three hold: the status is `401`, a credential was actually attached, and
 *    this dispatch permits rotation. A `403` is an authority decision that a fresh token cannot
 *    change and must surface unchanged; a `401` on a request that carried no credential is the
 *    ordinary "this route needs signing in" answer with nothing to refresh; and the rotation request,
 *    a caller-supplied `bearer` and an explicit `allowRefresh: false` are each excluded outright.
 * 5. **Before rotating, check whether the credential has already moved on.** A `401` answering a token
 *    that is no longer the held one is a stale answer, not a reason to rotate: something else rotated
 *    while this request was in flight, and a second rotation would revoke the pair that first one just
 *    obtained. Replay once with the current token instead.
 * 6. If rotation is refused, the session is over. A request marked {@link
 *    RequestOptions.anonymousFallback} is replayed once with no credential, because a public read must
 *    not fail merely because the reader was holding a dead token; anything else throws the original
 *    `401`.
 * 7. Otherwise retry **once**, with the new credential. A second `401` means the freshly issued token
 *    was rejected too, so the session is abandoned and that failure is thrown. There is no third
 *    rotation and no loop anywhere on this path: every branch below either returns or throws, and each
 *    of the three replay branches is guarded by a condition that cannot be true twice.
 */
async function dispatch(
  method: HttpMethod,
  path: string,
  options: DispatchOptions,
): Promise<Attempt> {
  const relativePath = normaliseApiPath(path);
  const instance = problemInstance(relativePath);
  const url = `${resolveApiBaseUrl()}${relativePath}${buildQueryString(options.query)}`;
  // A caller-supplied bearer wins over the store, and outside a browser the store is empty by
  // construction - so a server render is anonymous unless it passed a credential explicitly.
  const bearer = options.anonymous ? null : (options.bearer ?? heldAccessToken());

  const attempt = await sendRequest(method, url, options, bearer, instance);
  if (attempt.response.ok) {
    return attempt;
  }

  const failure = await toApiError(attempt.response, instance);
  attempt.deadline.dispose();
  if (failure.status !== HTTP_UNAUTHORIZED || bearer === null || !options.allowRefresh) {
    throw failure;
  }

  // A LATE 401 FOR A TOKEN THAT IS NO LONGER CURRENT. Two requests go out with token A1, both are
  // refused, the first rotates to A2 and succeeds - and then this one arrives holding a refusal that
  // describes A1. Rotating again would spend A2's refresh token and, if that rotation failed for any
  // reason, would clear a session that was working a moment ago. So the request is simply replayed
  // with what is current. Reached at most once: after the replay this function returns or throws.
  const current = heldAccessToken();
  if (current !== null && current !== bearer) {
    return await replay(method, url, options, current, instance);
  }

  const rotated = await refreshCredentials();
  if (rotated === null) {
    // The session is gone. For a public read that is not fatal - the endpoint answers without a
    // credential - so one anonymous replay is permitted, and only where the caller opted in.
    if (options.anonymousFallback) {
      return await replay(method, url, options, null, instance);
    }
    throw failure;
  }

  return await replay(method, url, options, rotated.access_token, instance);
}

/**
 * Send one request again with a different credential, and abandon the session if *that* is refused.
 *
 * The single retry shared by all three replay branches in {@link dispatch}, so the "one more attempt,
 * then give up" rule is written once. It performs no rotation itself, which is what makes a loop
 * structurally impossible rather than merely unlikely.
 *
 * A `401` here abandons the session because every path that reaches it has already presented the best
 * credential available: a freshly issued one, the one that superseded the request's own, or none at
 * all on a public read. If that is refused too, there is nothing left to try.
 */
async function replay(
  method: HttpMethod,
  url: string,
  options: DispatchOptions,
  bearer: string | null,
  instance: string,
): Promise<Attempt> {
  const retried = await sendRequest(method, url, options, bearer, instance);
  if (retried.response.ok) {
    return retried;
  }
  const retryFailure = await toApiError(retried.response, instance);
  retried.deadline.dispose();
  if (retryFailure.status === HTTP_UNAUTHORIZED && bearer !== null) {
    abandonSession();
  }
  throw retryFailure;
}

/** Internal JSON dispatch, parameterised by the decoder and by whether rotation is permitted. */
async function dispatchJson<T>(
  method: HttpMethod,
  path: string,
  options: PayloadRequestOptions,
  decoder: ResponseDecoder<T>,
  allowRefresh: boolean,
): Promise<T> {
  const dispatchOptions = toDispatchOptions(options, allowRefresh);
  const attempt = await dispatch(method, path, dispatchOptions);
  return readJsonBody(attempt, decoder, problemInstance(normaliseApiPath(path)));
}

/** Attach a JSON body to a caller's options, or leave the request bodyless when there is none. */
function withJsonBody(body: unknown, options: RequestOptions | undefined): PayloadRequestOptions {
  return body === undefined ? { ...options } : { ...options, json: body };
}

/* -------------------------------------------------------------------------------------------------
 * Public transport surface
 *
 * These ten functions are the whole of a wrapper's vocabulary. Between them they cover every one of
 * the thirty endpoints in the API - including the four asymmetries that fail silently if a caller
 * assumes uniformity:
 *
 *   1. Sign-in is form-encoded (apiPostForm); register and rotate are JSON.
 *   2. Sign-out and most deletions answer 204 (the *NoContent forms).
 *   3. Un-liking answers 200 with a body, unlike every other deletion (apiDelete, not
 *      apiDeleteNoContent).
 *   4. Nothing here presumes a response SHAPE at all - a page envelope and a bare representation are
 *      alike to this module, because the shape is whatever the caller's decoder accepts. Every
 *      collection in the API answers with the envelope, including the category taxonomy; this module
 *      simply does not depend on that being true, and the decoder is what makes the caller's claim
 *      about it checkable rather than assumed.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Issue a request and parse a JSON resource from the answer. The general form; prefer a verb helper.
 *
 * @typeParam T - The response shape, from `@/lib/types`. Always supply it: there is no default and no
 * `any` anywhere on this path, so an unannotated call is a compile error rather than a silent hole.
 * @throws {@link ApiError} for every failure: a rejection from the service, an unreachable service, a
 * cancelled request, a body that is absent where a resource was expected, or a body that will not
 * parse.
 */
export function apiRequest<T>(
  method: HttpMethod,
  path: string,
  decoder: ResponseDecoder<T>,
  options: PayloadRequestOptions = {},
): Promise<T> {
  return dispatchJson(method, path, options, decoder, true);
}

/**
 * Issue a request that answers with no content, and never touch `.json()`.
 *
 * This is the explicit answer to the `204` trap: `POST /auth/logout`, `DELETE /posts/{id}`,
 * `DELETE /comments/{id}` and the administrative deletions all answer `204 No Content`, and calling
 * `.json()` on an empty body throws a `SyntaxError` that has nothing to do with the request. A
 * zero-length `200` is treated identically, because there is equally nothing to parse.
 *
 * @throws {@link ApiError} for every failure.
 */
export async function apiRequestNoContent(
  method: HttpMethod,
  path: string,
  options: PayloadRequestOptions = {},
): Promise<void> {
  const attempt = await dispatch(method, path, toDispatchOptions(options, true));
  await discardBody(attempt);
}

/**
 * `GET` a JSON resource.
 *
 * The read verb for the feed, a post, a profile, the category list, a comment thread, a like summary
 * and every administrative table. Pass filters through `options.query`; blank ones are dropped.
 */
export function apiGet<T>(
  path: string,
  decoder: ResponseDecoder<T>,
  options?: RequestOptions,
): Promise<T> {
  return apiRequest('GET', path, decoder, { ...options });
}

/**
 * `POST` a JSON body - or no body at all - and parse the resource that comes back.
 *
 * Omitting `body` sends no body and no `Content-Type`, which is exactly what
 * `POST /posts/{id}/publish` and `POST /posts/{id}/unpublish` require: they carry no request
 * document and answer with the updated post.
 */
export function apiPost<T>(
  path: string,
  decoder: ResponseDecoder<T>,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  return apiRequest('POST', path, decoder, withJsonBody(body, options));
}

/**
 * `POST` a JSON body - or no body - to a route that answers with no content.
 *
 * `POST /auth/logout` is the case: it carries the rotation credential as JSON and answers `204`.
 */
export function apiPostNoContent(
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<void> {
  return apiRequestNoContent('POST', path, withJsonBody(body, options));
}

/**
 * `POST` an `application/x-www-form-urlencoded` body.
 *
 * **Sign-in and nothing else.** `POST /api/v1/auth/login` consumes the OAuth 2 password grant, so
 * the service reads its fields from a form body; sending JSON to it is answered with a `422` whose
 * cause is entirely unobvious from the call site. The grant names its identifier field `username`
 * while this API's identifier is an email address, so the value that belongs in that field is the
 * account's **email** - a mapping that belongs to `@/lib/api/auth`, not here.
 *
 * Every other route on the API takes JSON. This is not the default for anything.
 */
export function apiPostForm<T>(
  path: string,
  decoder: ResponseDecoder<T>,
  fields: FormFields,
  options?: RequestOptions,
): Promise<T> {
  return apiRequest('POST', path, decoder, { ...options, form: fields });
}

/**
 * `PATCH` a partial update and parse the updated resource.
 *
 * Genuinely partial: send only the members that change. Used by profile self-update, post update,
 * comment edit and every administrative mutation.
 */
export function apiPatch<T>(
  path: string,
  decoder: ResponseDecoder<T>,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  return apiRequest('PATCH', path, decoder, withJsonBody(body, options));
}

/**
 * `PUT` and parse the resource that comes back.
 *
 * `PUT /posts/{id}/like` is the case, and it is idempotent by construction rather than by
 * convention - the service's composite primary key means a repeated like cannot inflate a count - so
 * this call is safe to retry.
 */
export function apiPut<T>(
  path: string,
  decoder: ResponseDecoder<T>,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  return apiRequest('PUT', path, decoder, withJsonBody(body, options));
}

/**
 * `DELETE` a resource **and parse a body from the answer**.
 *
 * For the one deletion in this API that answers with content: `DELETE /posts/{id}/like` returns the
 * updated like summary with a `200`, not a `204`, because a reader who has just un-liked needs the
 * new count. All three like routes answer the same shape.
 *
 * Every other deletion answers `204` and belongs to {@link apiDeleteNoContent}. Nothing in this
 * module infers a body treatment from the verb, so both are available and neither is a special case.
 */
export function apiDelete<T>(
  path: string,
  decoder: ResponseDecoder<T>,
  options?: RequestOptions,
): Promise<T> {
  return apiRequest('DELETE', path, decoder, { ...options });
}

/**
 * `DELETE` a resource that answers `204 No Content`.
 *
 * The usual deletion: a post, a comment, and each administrative removal. Cascades are the service's
 * concern - deleting a post takes its comments and likes with it - so there is nothing to read back.
 */
export function apiDeleteNoContent(path: string, options?: RequestOptions): Promise<void> {
  return apiRequestNoContent('DELETE', path, { ...options });
}
