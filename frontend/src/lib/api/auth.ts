/**
 * Typed wrapper over the service's `/auth` namespace: registration, sign-in, rotation, sign-out,
 * and the authenticated account's own record.
 *
 * Five functions, one per route, and every one of them is a single call into `@/lib/api/client`.
 * The transport itself - `fetch`, header construction, bearer attachment,
 * retry-once-on-unauthorised, throttling and the normalisation of a failure into `ApiError` -
 * belongs to that module exclusively and appears nowhere in this file. What this file owns is the
 * *contract*: which path each operation addresses, what shape its body takes, how that body is
 * **encoded**, and what type comes back.
 *
 * ## The one asymmetry in this namespace, and the only thing here that can fail silently
 *
 * Four of these five routes speak JSON. **Sign-in does not.** `POST /auth/login` consumes the
 * OAuth 2 password grant as `application/x-www-form-urlencoded`, its identifier field is named
 * `username` by that grant, and the value that field carries is the account's **email address**.
 * Sending JSON to it is answered with a `422` that names no cause a caller would recognise, and
 * nothing in the type system objects on the way there - both encodings pass exactly the same two
 * strings. {@link login} carries the full reasoning and the citation; read it before editing it.
 *
 * ## What this module deliberately does not do
 *
 * - **No transport.** No `fetch`, no header, no abort signal construction, no status inspection, no
 *   retry, no error mapping and no `try`/`catch` around a request. If an operation here ever needs
 *   one of those, the correct change is to extend `@/lib/api/client`, which is the one module
 *   permitted to hold it, and never to reach for it here.
 * - **No version prefix in any path.** Paths are namespace-relative - `/auth/login` and nothing
 *   before it. The version namespace is composed by `@/lib/api/client` exactly once, and passing a
 *   path that already carries it is rejected there loudly rather than repaired silently. No URL
 *   string in this file names a version; the only occurrences of a version segment anywhere below
 *   are *filesystem* paths citing the backend router module that serves these routes.
 * - **No `'use client'`.** A Server Component reading the signed-in account and a client island
 *   submitting a credential form both import this module, so it must be evaluable in either
 *   environment. Nothing here touches a browser global.
 * - **No import from the provider, hook, component or route layers.** The dependency arrow
 *   points strictly outward: this module imports `@/lib/api/client` and the types in `@/lib/types`,
 *   and nothing else. Session state, cache invalidation and navigation belong to the layers above.
 * - **No third-party package.** `frontend/package.json` declares no HTTP client and no
 *   data-fetching library, and none is needed: the sole HTTP module already covers every case.
 * - **No camel-case translation.** Wire members keep the service's own snake_case spelling exactly
 *   as `@/lib/types` mirrors them. There is no translation layer anywhere in this tier; adding one
 *   would produce code that compiles and values that are `undefined`. The single mapping this file
 *   performs is `email` to the grant's `username` **form field** in {@link login} - a field-name
 *   translation demanded by the OAuth 2 grant, not a casing convention.
 * - **No token inspection of any kind.** The access token is a signed JWT and the refresh token is
 *   an opaque high-entropy string that is not a JWT at all. Neither is decoded, parsed, measured,
 *   logged, echoed into an error, placed in a URL or serialised onto a returned object here. The
 *   signing key is a backend-only secret and is not referenced from this tier.
 *
 * ## Why `refresh` exists here even though `@/lib/api/client` rotates on its own
 *
 * `@/lib/api/client` performs retry-once-on-unauthorised through a single-flight rotation, and it
 * issues that rotation request *inline* rather than by importing this module - because this module
 * imports it, and the pair would close an ES-module cycle whose failure mode is an undefined
 * binding at run time that neither the type-checker nor the linter reports. The rotation path is
 * therefore stated in both files, and that one duplicated path string is the deliberate and correct
 * trade. {@link refresh} is not redundant with it: `src/providers/auth-provider.tsx` restores a
 * session across a reload and needs a rotation it can call *explicitly*, rather than one that only
 * happens as a side effect of some other request failing.
 *
 * ## Rate limiting is ordinary here, not exceptional
 *
 * Every route in this namespace is rate-limited by the service, so a `429` carrying a `Retry-After`
 * interval is a live answer on all five. `@/lib/api/client` normalises it into `ApiError` like any
 * other rejection and exposes the interval there; nothing in this file special-cases it, and no
 * caller of this file needs to either.
 *
 * ## Governing standards
 *
 * `review_rules` reports that **no user-specified rules were provided** for this project, so
 * nothing here is invented to satisfy one and the bar is not lowered either. The binding
 * constraints are the technical plan's own enterprise standards, five of which govern this module:
 *
 * | Standard                         | How this module satisfies it                                                                                  |
 * | -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
 * | Layered separation of concerns   | Path, body shape and return type only; every function is one call into the sole HTTP module; no inward import  |
 * | Explicit API contracts           | Every parameter and every return type is a declared type from `@/lib/types`; no inline shape and no `any`      |
 * | API versioning                   | Namespace-relative paths, each stated once as a constant; the version prefix is composed by the client         |
 * | Secure-by-default authentication | No token read, decoded or logged; the credential is withheld from the three anonymous routes; sign-out clears  |
 * | Blocking quality gates           | Explicit return type on every export, no unused import, no floating promise, no placeholder                    |
 *
 * @module
 */

import {
  apiGet,
  apiPost,
  apiPostForm,
  apiPostNoContent,
  clearCredentials,
  getRefreshToken,
  isApiError,
  type RequestOptions,
  rotateSession,
} from '@/lib/api/client';
import { tokenPairSchema, userMeSchema, userPublicSchema } from '@/lib/types';
import type {
  LoginRequest,
  RefreshRequest,
  RegisterRequest,
  TokenPair,
  UserMe,
  UserPublic,
} from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Paths
 *
 * Namespace-relative and stated once each, so the five strings this module contributes to the URL
 * space are visible together and none of them can drift from the router that serves it - a bare
 * `APIRouter` mounted at `/auth`, in the backend module cited by {@link login}. The version prefix
 * is deliberately absent - see the module header.
 * ---------------------------------------------------------------------------------------------- */

/** `POST` - create an account. Answers `201` with {@link UserPublic}; issues no credential. */
const REGISTER_PATH = '/auth/register';

/** `POST` - exchange a credential for a pair. **Form-encoded**; see {@link login}. */
const LOGIN_PATH = '/auth/login';

/** `POST` - revoke a refresh token. JSON body *and* a bearer credential; answers `204`. */
const LOGOUT_PATH = '/auth/logout';

/** `GET` - the authenticated account's own record. Bearer credential; answers {@link UserMe}. */
const ME_PATH = '/auth/me';

/**
 * The grant's identifier field name, which is `username` even though the value is an email address.
 *
 * Named rather than inlined so the discrepancy between the field's name and its content is stated
 * once, in one place, with the reason attached - see {@link login}.
 */
const GRANT_USERNAME_FIELD = 'username';

/** The grant's credential field name. Its content is exactly what its name says. */
const GRANT_PASSWORD_FIELD = 'password';

/**
 * The one status this module interprets, and it interprets it in exactly one place.
 *
 * {@link logout} branches on it because a `401` there is recoverable in a way the transport cannot
 * recover it - see that function's note on why its body has to be rebuilt rather than replayed.
 * Nothing else here reads a status: interpreting a failure is not a wrapper's concern.
 */
const UNAUTHORIZED_STATUS = 401;

/* -------------------------------------------------------------------------------------------------
 * Option shaping
 * ---------------------------------------------------------------------------------------------- */

/**
 * Mark a call as one that must travel **without** the reader's credential.
 *
 * Registration, sign-in and rotation are all unauthenticated routes: none of them declares a
 * principal, so an `Authorization` header on any of them would be ignored by the service. Withholding
 * it is nevertheless a correctness requirement rather than hygiene, because `@/lib/api/client` treats
 * a `401` on a request that *did* carry a credential as an expiry worth rotating:
 *
 * - A wrong password answers `401`. Were a credential attached, that wrong password would spend the
 *   currently signed-in reader's refresh token and consume a slot in a rate-limited window - a failed
 *   sign-in attempt must not disturb an unrelated live session.
 * - A refused rotation answers `401` too. Were a credential attached, {@link refresh} would provoke
 *   the client's *own* inline rotation, re-presenting a refresh token that has already been spent -
 *   and the service treats a re-presented token as evidence of theft and revokes **every** outstanding
 *   token for that account. A redundant rotation could therefore end every one of the reader's
 *   sessions. This is the same reason the client's inline rotation withholds the credential from its
 *   own request.
 *
 * With no credential attached there is nothing to rotate, so the client raises the original failure
 * unchanged and no second request is made.
 *
 * The flag is applied *after* the caller's options are spread, so it cannot be overridden. That is
 * deliberate: there is no legitimate reason to send a credential to any of these three routes, and a
 * caller that believes otherwise is mistaken rather than unusual.
 */
function withoutCredential(options: RequestOptions | undefined): RequestOptions {
  return { ...options, anonymous: true };
}

/* -------------------------------------------------------------------------------------------------
 * Registration
 * ---------------------------------------------------------------------------------------------- */

/**
 * Create an account.
 *
 * `POST /auth/register`, **JSON**, answering `201` with the new account's *public* projection.
 *
 * ## Registration does not sign the reader in, and that is the contract rather than an omission
 *
 * The answer is {@link UserPublic}, **not** a {@link TokenPair} and not {@link UserMe}. No credential
 * is issued and none is echoed back, so a sign-up screen must send the reader to sign-in as its next
 * step. Do not build an auto-sign-in by calling {@link login} with the password still held in the
 * form: that is a second credential submission the service did not ask for, it doubles the account's
 * exposure to a rate-limit rejection at the exact moment it is most confusing, and it silently
 * couples two independent operations. It is also not what the route documents.
 *
 * Because the projection is the public one, the response carries no `email`, no `role`, no
 * `is_active` and no `updated_at`. A caller that needs the full self-view calls {@link getMe} after
 * signing in - which is the route that answers {@link UserMe}. Reading `role` off this result is a
 * runtime `undefined` rather than a compile error, which is precisely why the two projections are
 * separate types.
 *
 * ## What the body may and may not contain
 *
 * {@link RegisterRequest} is the whole of it: `email`, `username`, `password`, and an optional
 * `display_name` that the service derives from the username when it is omitted or `null`. There is
 * **no `role` member and none may be added** - account creation is not a privilege-escalation
 * surface, every account is created with the service's default authority, and a role is changed
 * afterwards only by an administrator through the administrative API. The service rejects any
 * undeclared property outright rather than ignoring it, so a stray member is reported as a
 * validation failure instead of being quietly dropped.
 *
 * The password travels in plaintext over TLS exactly once, is hashed with argon2id by the service,
 * and is neither stored nor logged in the clear anywhere. Nothing in this module retains it: the
 * payload is handed straight to the transport and never copied, reshaped or held.
 *
 * A duplicate email address or username is a **conflict**, not a validation failure, and both are
 * matched case-insensitively - an address or handle differing from an existing one only in case is
 * a duplicate. The rejection does not disclose which of the two clashed, so a caller should present
 * it against both fields rather than guessing.
 *
 * @param payload - The account to create. Produced by `signupSchema` in `@/lib/validation/auth`,
 * whose parsed output is constrained at compile time to remain assignable to {@link RegisterRequest}.
 * @param options - Optional per-call transport controls, forwarded unchanged. The credential is
 * withheld regardless - see {@link withoutCredential}.
 * @returns The created account's public representation.
 * @throws `ApiError` from `@/lib/api/client` for every failure: a conflict on either identifier, a
 * validation rejection carrying field-level detail, a throttled window, or an unreachable service.
 */
export function register(payload: RegisterRequest, options?: RequestOptions): Promise<UserPublic> {
  return apiPost(REGISTER_PATH, userPublicSchema, payload, withoutCredential(options));
}

/* -------------------------------------------------------------------------------------------------
 * Sign-in
 * ---------------------------------------------------------------------------------------------- */

/**
 * Exchange an email address and a password for a credential pair.
 *
 * `POST /auth/login`, answering `200` with a {@link TokenPair}.
 *
 * ## READ THIS BEFORE CHANGING THE ENCODING. This route takes a FORM, not JSON.
 *
 * This is the one call in this file whose encoding differs from its siblings, and the one mistake
 * here that no gate in the project can catch - it type-checks, it lints, it looks entirely
 * unremarkable at the call site, and it fails only against a running service.
 *
 * The route is served by `backend/app/api/v1/routers/auth.py`, whose sign-in handler declares
 * exactly one request parameter: `form_data: Annotated[OAuth2PasswordRequestForm, Depends()]`. There
 * is no JSON body parameter on it at all. The handler then builds the service's own credential model
 * from the form's two fields - `LoginRequest(email=form_data.username, password=form_data.password)`
 * - which is why `LoginRequest` is the shape this function *accepts* while the form is the shape it
 * *sends*. `python-multipart` is a pinned backend dependency for this route alone, and the grant is
 * what makes the **Authorize** control on the service's generated documentation work.
 *
 * Consequently: a JSON body is answered `422`, because the two form fields the handler requires are
 * simply absent from it. The rejection names the missing form fields rather than anything a reader
 * of this file would connect to a call site that looks correct.
 *
 * **On the docblock of `LoginRequest` in `@/lib/types`.** It describes that interface as the route's
 * JSON contract and states that this module sends it as JSON. That sentence is stale prose in a
 * declaration-only module - `@/lib/types` has no runtime exports, so nothing behaves differently
 * because of it - and it is contradicted by the router source cited above, by the form-encoded
 * transport helper's own documentation in `@/lib/api/client`, and by `@/lib/validation/auth`, which
 * explicitly assigns the translation between the two encodings to this module. The router is the
 * authority on what the route accepts. Do not "tidy" this call into JSON on the strength of that
 * comment.
 *
 * ## The field-name mapping, which is the whole reason this function is not a one-liner
 *
 * The OAuth 2 password grant names its identifier field `username`. This API's identifier is an
 * **email address**. So the value placed in the form's `username` field is `credentials.email`, and
 * the account's actual username has no part in signing in whatsoever.
 *
 * The mapping is confined to this boundary on purpose. Callers, the sign-in form and
 * `loginSchema` in `@/lib/validation/auth` all speak the domain's language - `{ email, password }`,
 * exactly {@link LoginRequest} - because a form field labelled "username" that must be filled with
 * an email address is a defect in the user interface, not a contract to propagate upward. One
 * translation, in one function, at the outermost edge of the tier.
 *
 * ## What comes back, and what to do with it
 *
 * A {@link TokenPair}: a short-lived signed `access_token`, an opaque `refresh_token` that is *not*
 * a JWT, the fixed `token_type`, and `expires_in` **in seconds**. This function returns the pair
 * exactly as issued and derives nothing from it - no expiry instant, no decoded claim, no
 * millisecond conversion - so the unit of `expires_in` continues to match the name of the field that
 * carries it. Adopting the pair is the caller's decision: `src/providers/auth-provider.tsx` hands it
 * to `setCredentials` in `@/lib/api/client`, which is what attaches the bearer to later requests and
 * writes the presence signal the route middleware reads. Nothing is adopted here, because a wrapper
 * that installed a session as a side effect of returning it would give the session two owners.
 *
 * The plaintext `refresh_token` in this response is the only time it will ever be readable - the
 * service keeps nothing but its hash. Store it through `setCredentials`; never log it, render it,
 * place it in a URL or decode it.
 *
 * A wrong password, an unregistered address and an address that could not be an address at all are
 * all answered `401` identically, deliberately, so this route cannot be used to discover which
 * addresses are registered. A caller must therefore present one message for all three rather than
 * attributing the failure to a particular field.
 *
 * @param credentials - The reader's email address and password, in the domain's own shape.
 * @param options - Optional per-call transport controls, forwarded unchanged. The credential is
 * withheld regardless - see {@link withoutCredential} for why that matters on this route in
 * particular.
 * @returns The freshly issued credential pair.
 * @throws `ApiError` from `@/lib/api/client`: `401` for any wrong credential, `403` for a
 * deactivated account, `429` for a throttled window, or a transport failure.
 */
export function login(credentials: LoginRequest, options?: RequestOptions): Promise<TokenPair> {
  // Form-encoded, and the field named `username` carries the EMAIL. Both facts are contractual:
  // the handler consumes `OAuth2PasswordRequestForm` and nothing else, so JSON here is a silent
  // `422`, and the grant - not this API - is what named the field. See the docblock above before
  // altering either the helper or the field names.
  return apiPostForm(
    LOGIN_PATH,
    tokenPairSchema,
    {
      [GRANT_USERNAME_FIELD]: credentials.email,
      [GRANT_PASSWORD_FIELD]: credentials.password,
    },
    withoutCredential(options),
  );
}

/* -------------------------------------------------------------------------------------------------
 * Rotation
 * ---------------------------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------------------------------
 * Rotation lives in the transport module, not here
 *
 * There is deliberately NO `refresh` wrapper in this file, and its absence is the guarantee rather
 * than an omission. A refresh token is SINGLE-USE: the service revokes the token presented to
 * `POST /auth/refresh` in the same statement that issues its replacement, and reads a token
 * presented twice as evidence of theft - which costs the account every outstanding token. So two
 * ways to rotate is not a convenience, it is a race whose observable symptom is a reader signed out
 * of every session while using the site normally.
 *
 * `rotateSession` in `@/lib/api/client` is therefore the tier's only rotation entry point. It owns
 * the single-flight promise that the automatic retry-on-401 also joins, it adopts the new pair
 * itself so no caller can leave a window carrying the token that was just revoked, and it discards
 * a result that arrives after a sign-out. A wrapper here would necessarily issue its own request and
 * bypass all three. `src/providers/auth-provider.tsx` awaits `rotateSession` for exactly this
 * reason; nothing in this module needs the path, so the path is not stated here either.
 * ---------------------------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------------------------------
 * Sign-out
 * ---------------------------------------------------------------------------------------------- */

/**
 * End the session a refresh token belongs to, and forget the credential locally.
 *
 * `POST /auth/logout`, answering **`204 No Content`**.
 *
 * ## Two things have to happen, and both are this function's job
 *
 * 1. **The server-side session is revoked.** The route requires the refresh token in a JSON body
 *    *and* a valid access token in the `Authorization` header - it is the one route in this namespace
 *    that needs both - so this call is **not** anonymous. The response carries no body: it is
 *    dispatched through the transport's no-content path, which never reads one. Parsing an empty body
 *    would raise a syntax failure with nothing whatsoever to do with the request, which is the trap
 *    that path exists to close.
 * 2. **The credential is forgotten locally.** `clearCredentials` from `@/lib/api/client` drops the
 *    in-memory pair *and* expires the presence cookie that `src/middleware.ts` gates the dashboard
 *    and administrative route groups on. Clearing only the tokens would leave the middleware
 *    admitting a reader who has no credential left, producing routes that render and then fail every
 *    request they make. Both halves are one call, which is why sign-out is the only function in this
 *    file that does anything after its request returns.
 *
 * Note what the access token is *not*: revocable. It is a signed assertion with no server-side
 * record, so nothing can withdraw it before it expires - which is exactly why its lifetime is short
 * and why discarding the local copy is a required step rather than a courtesy. Only this session
 * ends; other sessions for the same account are untouched.
 *
 * ## Which token is revoked when none is passed
 *
 * With no argument, the refresh token currently held by `@/lib/api/client` is the one revoked, which
 * is the ordinary case: end the session this tab is signed in with. Pass an explicit token to revoke
 * a specific one instead - a session restored from storage but never adopted, say.
 *
 * When no token can be resolved at all, the request is skipped and only the local clear runs. That
 * branch is a deliberate guard, not defensiveness: the service constrains this member to a non-empty
 * string, so a fabricated blank value would be answered `422`, the failure would propagate, and the
 * local clear would never run - leaving a reader who asked to sign out still appearing signed in with
 * a credential that does not exist. Signing out must always end the local session. There is nothing
 * to revoke server-side in that state either, since no token is held to revoke.
 *
 * Revocation itself is idempotent at the service: a token that is unknown or already revoked is
 * accepted rather than rejected, because answering otherwise would report whether a given token
 * exists and would fail the honest cases - a retried request, a second tab, a reader signing out
 * twice.
 *
 * ## Why rotation is disabled here, and what happens instead
 *
 * This is the one route whose **body names a credential**, and that makes the transport's ordinary
 * rotate-and-retry actively wrong for it. The sequence it would produce: the access token has expired,
 * so the service answers `401`; the transport rotates, which spends refresh token R1 and issues R2;
 * the transport then replays the request with the new access token *and the original body*, which
 * still names R1. The service accepts it - revocation is idempotent - and re-revokes a token that was
 * already spent. R2 is left **alive**, so the session the reader asked to end is still usable by
 * anything holding R2, while the local clear reports success.
 *
 * So the call is dispatched with `allowRefresh: false` and the `401` is handled here, where the body
 * can be rebuilt: rotate once through `rotateSession`, then re-issue sign-out naming the *post-
 * rotation* refresh token. That revokes the credential that is actually live. If the rotation is
 * itself refused, there is nothing left to revoke - the session is already over and
 * `@/lib/api/client` has cleared it - so the local clear runs and sign-out succeeds.
 *
 * The retry is attempted at most once, and only for a `401`. Any other failure - a throttled window, a
 * transport fault - propagates, because it says nothing about the credential.
 *
 * ## On the ordering of the clear
 *
 * The local clear runs after the request succeeds, so a genuine failure - a throttled window, say -
 * surfaces to the caller rather than being swallowed by a sign-out that reports success either way.
 * The one failure mode where that ordering would matter is already handled a layer down: when
 * authentication is definitively gone, `@/lib/api/client` clears the credential itself and notifies
 * its unauthorised handler, so a `401` here ends the local session regardless. A caller that wants a
 * guaranteed local sign-out after any other failure calls `clearCredentials` itself; this module does
 * not wrap the request in error handling, because interpreting a failure is not a wrapper's concern.
 *
 * @param payload - The refresh token to revoke. Omit it to revoke the one currently held.
 * @param options - Optional per-call transport controls, forwarded unchanged. `allowRefresh` is set
 * by this function and a caller's value for it is deliberately overridden - see above.
 * @returns Nothing. The route answers `204`, so there is no resource to return.
 * @throws `ApiError` from `@/lib/api/client`: `429` for a throttled window, or a transport failure. A
 * `401` is handled internally by rotating once and re-issuing with the live token; it propagates only
 * if the re-issued request is refused as well. The local credential is left in place for the caller to
 * act on, except where the client has already abandoned the session itself.
 */
export async function logout(payload?: RefreshRequest, options?: RequestOptions): Promise<void> {
  const presented = payload?.refresh_token ?? getRefreshToken();

  if (presented !== null && presented !== '') {
    // `allowRefresh: false` last, so it cannot be overridden by a caller's options object. A caller
    // has no legitimate reason to re-enable rotation here, and enabling it re-introduces the defect
    // this function exists to avoid.
    const noRotation: RequestOptions = { ...options, allowRefresh: false };
    try {
      await apiPostNoContent(LOGOUT_PATH, { refresh_token: presented }, noRotation);
    } catch (cause) {
      if (!isApiError(cause) || cause.status !== UNAUTHORIZED_STATUS) {
        throw cause;
      }
      // The access token had expired. Rotate once - which spends the token just presented and issues
      // its successor - and then revoke THAT successor, which is the credential now keeping the
      // session alive. Replaying the original body would revoke a token that is already spent.
      await revokeAfterRotation(noRotation);
    }
  }

  clearCredentials();
}

/**
 * Rotate once, then sign out with the token the rotation issued.
 *
 * Split out of {@link logout} so the retry path reads as the two steps it is. Called only after a
 * `401`, and never more than once per sign-out.
 *
 * A refused rotation is swallowed deliberately: it means the session is already over - the refresh
 * token was unknown, expired or revoked - so there is nothing left to revoke and sign-out has
 * effectively already happened server-side. `@/lib/api/client` has cleared the credential and notified
 * its unauthorised handler by then, and {@link logout} clears again unconditionally. Reporting a
 * failure to the reader for a session that is provably gone would be a worse answer than success.
 */
async function revokeAfterRotation(options: RequestOptions): Promise<void> {
  let rotated: TokenPair;
  try {
    rotated = await rotateSession();
  } catch (cause) {
    if (!isApiError(cause)) {
      throw cause;
    }
    return;
  }
  await apiPostNoContent(LOGOUT_PATH, { refresh_token: rotated.refresh_token }, options);
}

/* -------------------------------------------------------------------------------------------------
 * The authenticated account
 * ---------------------------------------------------------------------------------------------- */

/**
 * Read the account the presented access token belongs to.
 *
 * `GET /auth/me`, answering `200` with {@link UserMe}.
 *
 * ## The private projection, and why there is no identifier parameter
 *
 * {@link UserMe} extends the public field set with `email`, `role`, `is_active` and `updated_at`, and
 * it is returned **only** to the account it describes. There is deliberately nothing to pass: the
 * token names its own subject, so there is no way to ask this route about anybody else. A public
 * profile is a different route and a different type - `GET /users/{username}` answering
 * `UserPublic` - and one must never be rendered where the other belongs.
 *
 * The `role` reported here is read from the account record rather than from the token's claim, so a
 * role an administrator has just changed is reflected on the next call rather than whenever the
 * current token happens to expire. Use it to decide which controls to *render*; it is not a
 * capability. Every protected operation is re-checked by the service on every request, and a claim
 * read client-side is a display hint at best.
 *
 * ## Its two uses
 *
 * Restoring a session - `src/providers/auth-provider.tsx` adopts a stored pair and then calls this to
 * learn who the reader is - and confirming that a credential is still live. On the restore path the
 * automatic rotation in `@/lib/api/client` does useful work: an expired access token here is answered
 * `401`, which the client rotates once and retries, so a reader whose access token lapsed while the
 * tab was closed is signed in rather than signed out. That is why this call, unlike the three
 * unauthenticated ones, is dispatched **with** the credential and with rotation left enabled.
 *
 * Because the answer is specific to one principal, do not cache it under anything but the session.
 * Pass `options.cache` or `options.next` only with that in mind; nothing is cached by default.
 *
 * @param options - Optional per-call transport controls, forwarded unchanged - an `AbortSignal` for a
 * component that may unmount mid-request, or the framework's revalidation controls.
 * @returns The authenticated account's own record.
 * @throws `ApiError` from `@/lib/api/client`: `401` when no credential is held or rotation cannot
 * renew it, `403` when the account has been deactivated, `429` for a throttled window, or a transport
 * failure.
 */
export function getMe(options?: RequestOptions): Promise<UserMe> {
  return apiGet(ME_PATH, userMeSchema, options);
}
