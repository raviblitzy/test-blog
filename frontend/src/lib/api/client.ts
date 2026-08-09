/**
 * The presentation tier's only HTTP module.
 *
 * Every request this application makes to the REST service is issued from this file. Route
 * segments, layouts, client islands, hooks, providers, `src/app/sitemap.ts`, `src/app/robots.ts`
 * and the seven typed wrappers beside this module (`auth`, `posts`, `categories`, `comments`,
 * `likes`, `users`, `admin`) all reach the API *through* here and never around it. `fetch`,
 * `Headers`, `AbortSignal` handling, bearer attachment, refresh-on-unauthorised, retry and error
 * normalisation live in this module exclusively; a wrapper that reaches for any of them, or that
 * branches on a status code, has taken on transport logic that belongs here.
 *
 * That concentration is the whole point. There is exactly one place where a credential is attached,
 * one place where a rotation can race, one place where a failure becomes a typed error and one
 * place where the API's origin is read. Each of those is a defect class that cannot be distributed
 * across forty call sites if it only exists once.
 *
 * ## What this module does NOT do, and must never start doing
 *
 * - **No `'use client'` directive, and no browser-only global touched at module scope.** Server
 *   Components render the feed, the post page, the profile page and the sitemap, so this module is
 *   evaluated on the server as often as in the browser. `document` and `process.env` are read
 *   inside functions, behind guards, never while the module is being evaluated.
 * - **No React, no `@tanstack/react-query`, no provider, hook, component or route import.** The
 *   dependency arrow points strictly outward: this module imports one thing, `@/lib/types`, and it
 *   imports it as types only. Cache invalidation, mutation state and navigation belong to the
 *   layers above; see {@link setUnauthorizedHandler} for the one callback seam that exists instead.
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
 * the `http://backend:8000` a container network resolves is completed to
 * `http://backend:8000/api/v1`. Either configuration produces the prefix exactly once, never twice.
 * A caller that passes a path already carrying the prefix is a defect in that caller and is
 * rejected loudly rather than silently repaired - two coexisting conventions is the state this rule
 * exists to prevent.
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
 * | Explicit API contracts          | {@link ProblemDetail} is the one error shape; every transport function is generic over a caller-supplied type    |
 * | API versioning                  | `/api/v1` composed here once, idempotently; no caller can emit an unversioned path                              |
 * | Secure-by-default authentication | Bearer attachment, single-flight rotation, cookie cleared on sign-out, no credential logged or echoed          |
 * | Configuration from environment  | One key, `NEXT_PUBLIC_API_BASE_URL`, read lazily; no hard-coded origin and no environment-gated fallback         |
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
 * `src/providers/auth-provider.tsx` writes it, `src/middleware.ts` reads it to gate
 * `/dashboard/:path*`, `/posts/:path*` and `/admin/:path*`, and this module clears it in
 * {@link clearCredentials} and keeps it in step with rotation in {@link setCredentials}. A
 * mismatched literal does not fail anywhere: route protection simply never fires, silently.
 *
 * `src/middleware.ts` runs in the Edge runtime and cannot import from `@/lib/api`, so it
 * necessarily restates the literal. `auth-provider.tsx` should import this constant rather than
 * restate it, because `providers -> lib` is a permitted dependency direction.
 *
 * The cookie carries the access token as its value because the middleware needs the role claim to
 * gate the administrative route group. It is a *presence and role* signal for the client tier and
 * nothing more: the API authenticates from the `Authorization` header alone and never reads a
 * cookie, and every authority decision is re-made server-side. Hiding a route is user experience,
 * not a security boundary.
 */
export const AUTH_COOKIE_NAME = 'access_token';

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
const ERROR_TYPE_MALFORMED_RESPONSE = '/errors/malformed-response';

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
}

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
  /**
   * Whether a `401` may trigger a rotation. `false` for the rotation request itself, which is what
   * makes recursion impossible rather than merely unlikely.
   */
  readonly allowRefresh: boolean;
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

  constructor(problem: ProblemDetail, retryAfterSeconds: number | null = null) {
    super(problem.detail === '' ? problem.title : problem.detail);
    this.name = 'ApiError';
    this.problem = problem;
    this.status = problem.status;
    this.requestId = problem.request_id;
    this.retryAfterSeconds = retryAfterSeconds;
    this.errors = problem.errors;
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
function readProblemDetail(payload: unknown, fallback: ProblemDetail): ProblemDetail {
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
    status,
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
 * 2. `docker-compose.yml` resolves the value against the internal service hostname, which is only
 *    meaningful at run time inside the container network.
 *
 * The single environment key this module reads. It is written as a static member access rather than
 * a computed one because the framework inlines `process.env.NEXT_PUBLIC_*` textually at build time;
 * an indexed read would not be substituted and would resolve to `undefined` in the browser bundle.
 *
 * @throws Error when the variable is unset or blank. Deliberately loud: a silent default origin
 * would turn a missing deployment variable into requests quietly aimed at the wrong service.
 */
function resolveApiBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (configured === undefined || configured.trim() === '') {
    throw new Error(
      `${API_BASE_URL_ENV_KEY} is not set, so the presentation tier has no API to call. ` +
        `Copy the NEXT_PUBLIC_ block of .env.example into frontend/.env.local; the documented ` +
        `value is http://localhost:8000${API_VERSION_PREFIX}.`,
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
 * Module-scoped rather than React state, because a Server Component, a route handler and a client
 * island all need the same credential and none of them shares a React tree with the others. The auth
 * provider drives these functions; this module owns no component state and re-renders nothing.
 * ---------------------------------------------------------------------------------------------- */

let accessToken: string | null = null;
let refreshToken: string | null = null;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * The single in-flight rotation, or `null` when none is running. See {@link refreshCredentials} for
 * why one shared promise is the whole of the single-flight guarantee.
 */
let rotationInFlight: Promise<TokenPair | null> | null = null;

/** Whether a document object exists - false during server rendering and in a route handler. */
function isDocumentAvailable(): boolean {
  return typeof document !== 'undefined';
}

/**
 * Write the presence cookie `src/middleware.ts` gates on.
 *
 * Deliberately a **session** cookie with no `Max-Age` and no `Expires`. Deriving a lifetime from
 * `TokenPair.expires_in` - which is a count of **seconds**, not milliseconds - would expire the
 * cookie when the *access* token expires, and the middleware would then bounce a reader whose
 * session is perfectly alive because rotation had renewed it. Presence is refreshed on every
 * rotation instead, so the cookie tracks the session rather than one token in it.
 *
 * A no-op when no document exists, so the function is safe to call from server-rendered code
 * without a caller-side guard.
 */
function writeAuthCookie(token: string): void {
  if (!isDocumentAvailable()) {
    return;
  }
  const attributes = ['Path=/', 'SameSite=Lax'];
  if (document.location.protocol === 'https:') {
    attributes.push('Secure');
  }
  document.cookie = `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; ${attributes.join('; ')}`;
}

/**
 * Expire the presence cookie.
 *
 * `Path=/` must match the path the cookie was written with or the browser treats it as a different
 * cookie and the original survives - which would leave the middleware admitting a reader who has
 * signed out. Both a zero `Max-Age` and a past `Expires` are sent because the two are honoured by
 * different vintages of behaviour and neither is expensive.
 */
function expireAuthCookie(): void {
  if (!isDocumentAvailable()) {
    return;
  }
  document.cookie = `${AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
}

/**
 * Adopt a credential pair: sign-in, rotation and session restore all land here.
 *
 * Also refreshes the presence cookie, so the signal `src/middleware.ts` reads stays in step with
 * rotation. The auth provider remains the owner of the *initial* write at sign-in; because both
 * writes use {@link AUTH_COOKIE_NAME} and `Path=/`, they address one cookie and the later write
 * simply replaces the earlier value.
 */
export function setCredentials(tokens: TokenPair): void {
  accessToken = tokens.access_token;
  refreshToken = tokens.refresh_token;
  writeAuthCookie(tokens.access_token);
}

/**
 * Forget the credential entirely: sign-out, a refused rotation, or a session that cannot be
 * restored.
 *
 * Clears the in-memory pair *and* expires the presence cookie, because leaving the cookie behind
 * would keep `src/middleware.ts` admitting a reader who has no credential left - a route that
 * renders and then fails every request it makes.
 */
export function clearCredentials(): void {
  accessToken = null;
  refreshToken = null;
  expireAuthCookie();
}

/**
 * The access token currently held, or `null`.
 *
 * `null` is an ordinary state, not an error: the feed, a post, a profile, the category list and both
 * public read endpoints on a post all answer without a credential.
 */
export function getAccessToken(): string | null {
  return accessToken;
}

/**
 * The rotation credential currently held, or `null`.
 *
 * Exposed so the auth provider can persist and restore a session across reloads. It is an **opaque**
 * high-entropy string, not a JWT: never decode it, never parse it, never put it in a URL, a log or a
 * rendered surface. The service keeps only its hash, so it cannot be recovered there either.
 */
export function getRefreshToken(): string | null {
  return refreshToken;
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

/** Collapse the public options plus a resolved payload into the fully explicit dispatch shape. */
function toDispatchOptions(options: PayloadRequestOptions, allowRefresh: boolean): DispatchOptions {
  return {
    payload: buildPayload(options),
    query: options.query,
    signal: options.signal,
    anonymous: options.anonymous === true,
    cache: options.cache,
    next: options.next,
    allowRefresh,
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
function toTransportError(cause: unknown, instance: string): ApiError {
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
  return new ApiError(readProblemDetail(payload, fallback), parseRetryAfterSeconds(response));
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
async function readJsonBody<T>(response: Response, instance: string): Promise<T> {
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw toTransportError(cause, instance);
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
  try {
    return JSON.parse(text) as T;
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
}

/**
 * Consume and discard the body of a response whose content is not wanted.
 *
 * The `204` path never touches `.json()` - calling it on an empty body throws - but it does read the
 * stream, because an unread body keeps its connection from being released. A `204` and a zero-length
 * `200` are handled identically: there is nothing to parse in either case.
 */
async function discardBody(response: Response): Promise<void> {
  await readBodyTextOrEmpty(response);
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
): Promise<Response> {
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
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }
  if (options.cache !== undefined) {
    init.cache = options.cache;
  }
  if (options.next !== undefined) {
    init.next = options.next;
  }

  try {
    return await fetch(url, init);
  } catch (cause) {
    throw toTransportError(cause, instance);
  }
}

/**
 * Obtain a fresh credential pair, at most once concurrently.
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
 * @returns The new pair, or `null` when rotation was refused or there was nothing to present. `null`
 * means the session is over and {@link abandonSession} has already run.
 */
function refreshCredentials(): Promise<TokenPair | null> {
  if (rotationInFlight === null) {
    rotationInFlight = rotateCredentials().finally(() => {
      rotationInFlight = null;
    });
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
  try {
    const rotated = await dispatchJson<TokenPair>(
      'POST',
      REFRESH_PATH,
      { json: { [REFRESH_TOKEN_FIELD]: presented }, anonymous: true },
      false,
    );
    // Rotation replaces BOTH tokens: the presented refresh token is revoked as the new pair is
    // issued, so keeping the old one would guarantee the next rotation fails.
    setCredentials(rotated);
    return rotated;
  } catch (cause) {
    abandonSession();
    if (!isApiError(cause)) {
      throw cause;
    }
    return null;
  }
}

/**
 * Issue a request, and on a single unauthorised answer rotate the credential and retry it once.
 *
 * The sequence, and every branch that deliberately does *not* rotate:
 *
 * 1. Send. A `fetch`-level rejection is already an {@link ApiError} by the time it arrives here.
 * 2. On success, hand the response back for the caller's chosen body treatment.
 * 3. On failure, normalise it *first* - which consumes the body exactly once - and then decide.
 * 4. Rotate only when all three hold: the status is `401`, a credential was actually attached, and
 *    this dispatch permits rotation. A `403` is an authority decision that a fresh token cannot
 *    change and must surface unchanged; a `401` on a request that carried no credential is the
 *    ordinary "this route needs signing in" answer with nothing to refresh; and the rotation request
 *    itself is excluded outright.
 * 5. If rotation is refused, throw the original `401`. The session is already abandoned.
 * 6. Otherwise retry **once**, with the new credential. A second `401` means the freshly issued token
 *    was rejected too, so the session is abandoned and that failure is thrown. There is no third
 *    attempt and no loop anywhere on this path.
 */
async function dispatch(
  method: HttpMethod,
  path: string,
  options: DispatchOptions,
): Promise<Response> {
  const relativePath = normaliseApiPath(path);
  const instance = problemInstance(relativePath);
  const url = `${resolveApiBaseUrl()}${relativePath}${buildQueryString(options.query)}`;
  const bearer = options.anonymous ? null : accessToken;

  const response = await sendRequest(method, url, options, bearer, instance);
  if (response.ok) {
    return response;
  }

  const failure = await toApiError(response, instance);
  if (failure.status !== HTTP_UNAUTHORIZED || bearer === null || !options.allowRefresh) {
    throw failure;
  }

  const rotated = await refreshCredentials();
  if (rotated === null) {
    throw failure;
  }

  const retried = await sendRequest(method, url, options, rotated.access_token, instance);
  if (retried.ok) {
    return retried;
  }
  const retryFailure = await toApiError(retried, instance);
  if (retryFailure.status === HTTP_UNAUTHORIZED) {
    abandonSession();
  }
  throw retryFailure;
}

/** Internal JSON dispatch, parameterised by whether rotation is permitted. */
async function dispatchJson<T>(
  method: HttpMethod,
  path: string,
  options: PayloadRequestOptions,
  allowRefresh: boolean,
): Promise<T> {
  const dispatchOptions = toDispatchOptions(options, allowRefresh);
  const response = await dispatch(method, path, dispatchOptions);
  return readJsonBody<T>(response, problemInstance(normaliseApiPath(path)));
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
 *   4. The category list is a bare array rather than a page envelope - which is a matter for the
 *      caller's type argument, and works because nothing here presumes an envelope.
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
  options: PayloadRequestOptions = {},
): Promise<T> {
  return dispatchJson<T>(method, path, options, true);
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
  const response = await dispatch(method, path, toDispatchOptions(options, true));
  await discardBody(response);
}

/**
 * `GET` a JSON resource.
 *
 * The read verb for the feed, a post, a profile, the category list, a comment thread, a like summary
 * and every administrative table. Pass filters through `options.query`; blank ones are dropped.
 */
export function apiGet<T>(path: string, options?: RequestOptions): Promise<T> {
  return apiRequest<T>('GET', path, { ...options });
}

/**
 * `POST` a JSON body - or no body at all - and parse the resource that comes back.
 *
 * Omitting `body` sends no body and no `Content-Type`, which is exactly what
 * `POST /posts/{id}/publish` and `POST /posts/{id}/unpublish` require: they carry no request
 * document and answer with the updated post.
 */
export function apiPost<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  return apiRequest<T>('POST', path, withJsonBody(body, options));
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
  fields: FormFields,
  options?: RequestOptions,
): Promise<T> {
  return apiRequest<T>('POST', path, { ...options, form: fields });
}

/**
 * `PATCH` a partial update and parse the updated resource.
 *
 * Genuinely partial: send only the members that change. Used by profile self-update, post update,
 * comment edit and every administrative mutation.
 */
export function apiPatch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  return apiRequest<T>('PATCH', path, withJsonBody(body, options));
}

/**
 * `PUT` and parse the resource that comes back.
 *
 * `PUT /posts/{id}/like` is the case, and it is idempotent by construction rather than by
 * convention - the service's composite primary key means a repeated like cannot inflate a count - so
 * this call is safe to retry.
 */
export function apiPut<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  return apiRequest<T>('PUT', path, withJsonBody(body, options));
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
export function apiDelete<T>(path: string, options?: RequestOptions): Promise<T> {
  return apiRequest<T>('DELETE', path, { ...options });
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
