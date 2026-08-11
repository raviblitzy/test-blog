/**
 * The AUTHENTICATION JOURNEY, end to end - one of the six specs `playwright.config.ts`
 * collects from `./tests/e2e`, and therefore three of the eighteen project-spec combinations
 * AAP §0.9.4.6 requires green.
 *
 * WHAT THIS FILE PROVES, and where the AAP asks for it:
 *
 *   §0.9.4.4 "Registration and login" - register, then sign in, then reach a protected route
 *            with the resulting session.
 *   §0.9.4.4 "Token lifecycle"        - refresh rotates the refresh token, the superseded one
 *            is refused, sign-out revokes, and an unusable credential answers 401.
 *   §0.9.4.4 "Authorisation negatives" (the route-protection half) - the dashboard and admin
 *            families turn an unauthenticated visitor away, the return target survives the
 *            round trip, an off-site return target is refused, and a non-administrator gets
 *            no administrative access.
 *   §0.9.4.3 "Errors are uniform"     - the 401 body is the one machine-readable problem
 *            document the single registered exception handler emits.
 *   §0.6.5                            - client-side route protection is DEFENCE IN DEPTH
 *            ONLY. Two tests below tamper with the client's own session marker precisely to
 *            demonstrate that it is not a security boundary.
 *
 * GOVERNING STANDARDS. `review_rules` reports that NO user-specified rules exist for this
 * project - a complete response, not a truncated one - so nothing here is written to a user
 * rule and none is invented. The bar is instead the thirteen enterprise standards the AAP
 * imposes on itself (§0.10.1). Five bind this file:
 *
 *   - "Blocking quality gates". This is a gate, not a diagnostic. Nothing below is focused,
 *     skipped, marked pending, disabled by a condition, or asserted softly, and no exception
 *     handler anywhere turns a failure into a pass. Authentication is width-independent, so
 *     there is no viewport branching either: every test asserts the same thing at 375, 768
 *     and 1440.
 *   - "Accessibility as a floor". `signs in under keyboard control ...` drives a credential
 *     form with nothing but `Tab`, typing and `Enter`, proves the email field is reachable by
 *     `Tab` alone from a cold page, and reads the submit control's COMPUTED focus outline to
 *     prove the indicator is actually visible. (Modal focus-trapping belongs to
 *     `home-feed.spec.ts` and `admin.spec.ts`; the credential form's keyboard path is ours.)
 *   - Behaviour over implementation (§0.8.5, §0.7.2). Every element is addressed by role,
 *     accessible name or visible text. There is not one class selector, class assertion or
 *     test-id hook in this file.
 *   - "Pinned, reproducible dependencies". The only import is `@playwright/test`, pinned at
 *     1.62.1 in `frontend/package.json`. Everything else - form encoding, cookie forgery,
 *     problem-document parsing, identity generation - is built from Playwright's own API.
 *   - "No secrets in the repository". Every account is created at run time under a unique
 *     throwaway identity and abandoned; the only password literals are self-describing
 *     non-secrets. No credential is read from a fixture file and none is written to one. The
 *     seeded administrator is deliberately NOT used: nothing here needs administrative
 *     authority (the non-administrator refusal is the point), and the deeper admin coverage
 *     belongs to `admin.spec.ts`.
 *
 * WHAT THE CODE ACTUALLY DOES, where it differs from the obvious guess. Every statement below
 * was verified against the implementation and then against a running stack:
 *
 *   1. The client's session cookie is `blog_session` and it carries a ROLE MARKER - one of
 *      `READER`, `AUTHOR`, `ADMIN` - not a JWT. `src/lib/api/client.ts` owns the name,
 *      `src/providers/auth-provider.tsx` writes it, `src/middleware.ts` reads it, and
 *      middleware types its own constant as `typeof AuthProviderModule.AUTH_COOKIE_NAME`, so
 *      the three cannot drift apart without a compile error.
 *   2. The access and refresh tokens are NEVER in a readable cookie. The access token lives in
 *      module memory; the refresh token is mirrored into `blog_refresh`, an HttpOnly cookie
 *      scoped to `/api/session`, by the route handler of the same name.
 *   3. Because the marker is only a claim, `middleware.ts` has exactly two outcomes, and which
 *      one a test gets depends on the cookie it set up:
 *        - marker ABSENT or not a role literal -> 307 to `/login?next=<encoded original path>`;
 *        - marker present and not `ADMIN`, on an admin path -> 307 to `/`;
 *        - marker present and admissible -> the route renders, and the route-group layout
 *          re-resolves the principal against the API. A marker that cannot be authenticated
 *          therefore produces the layout's SIGNED-OUT PANEL rather than a redirect.
 *   4. Registration grants the AUTHOR role, so the marker written after sign-up is `AUTHOR`.
 *   5. Sign-in is an OAuth 2 password grant: `application/x-www-form-urlencoded`, with the
 *      account's EMAIL in the field named `username`. Refresh and sign-out are JSON.
 *   6. Sign-out answers 204 with a zero-byte body and needs BOTH the bearer and the refresh
 *      token in the body.
 *   7. An access token is a signed assertion with no server-side record, so signing out cannot
 *      withdraw it before it expires - `GET /auth/me` with a post-sign-out access token still
 *      answers 200, by design. Revocation is therefore proven where it is real, on
 *      `POST /auth/refresh`, and the 401 assertions use an absent and a bogus bearer.
 *
 * ONE OPERATIONAL PREREQUISITE, stated because a failure to meet it looks like an application
 * defect. All five credential routes are rate limited (`AUTH_RATE_LIMIT`, counted per route
 * per client address), and this spec necessarily calls them repeatedly from one address, three
 * times over. The limit must therefore admit the suite. A 429 is never retried or swallowed
 * here: it fails the test with a message naming the variable, so the cause is legible at once.
 */
import { expect, test } from '@playwright/test';
import type {
  APIRequestContext,
  APIResponse,
  BrowserContext,
  Locator,
  Page,
} from '@playwright/test';

/* ------------------------------------------------------------------------------------------
 * Configuration read from the environment, and nothing else
 *
 * "Configuration from the environment only" (§0.10.1). `playwright.config.ts` loads the
 * project's own env files with `@next/env` before anything reads a value, and Playwright
 * re-evaluates that config inside every worker, so these keys are populated here for the same
 * reason `baseURL` is. Both reads fail closed with the key named: a suite silently pointed at
 * the wrong service reports a green gate for something nothing exercised.
 * ---------------------------------------------------------------------------------------- */

/** The key naming the API the pages call. `.env.example` documents it WITH the version prefix. */
const API_BASE_URL_KEY = 'NEXT_PUBLIC_API_BASE_URL';

/** Composed onto the base only when the configured value omits it, exactly as `client.ts` does. */
const API_VERSION_PREFIX = '/api/v1';

/** Trailing separators are trimmed so path composition can never produce a double slash. */
const TRAILING_SLASHES = /\/+$/;

function requireEnvironmentValue(key: string): string {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      `${key} is not set, so this spec does not know which API to drive. Playwright loads ` +
        `frontend/.env.local through playwright.config.ts; copy the NEXT_PUBLIC_ block of ` +
        `.env.example into it, or export the value for this run.`,
    );
  }
  return raw.trim();
}

/** Absolute base of the versioned API namespace, e.g. `http://127.0.0.1:8000/api/v1`. */
const apiBaseUrl = ((): string => {
  const configured = requireEnvironmentValue(API_BASE_URL_KEY).replace(TRAILING_SLASHES, '');
  return configured.endsWith(API_VERSION_PREFIX)
    ? configured
    : `${configured}${API_VERSION_PREFIX}`;
})();

/** Namespace-relative path to an absolute URL. Callers pass `/auth/login`, never the prefix. */
function apiUrl(path: string): string {
  return `${apiBaseUrl}${path}`;
}

/* ------------------------------------------------------------------------------------------
 * The contract this spec asserts against
 *
 * Declared locally and deliberately NOT imported from `src/`. A test that imports the
 * application's own types would assert that the application agrees with itself; restating the
 * wire shape here means a change to it has to be made twice, on purpose, and shows up as a
 * failure rather than as a silently-updated expectation.
 * ---------------------------------------------------------------------------------------- */

/** Credential routes, relative to the versioned namespace. */
const REGISTER_PATH = '/auth/register';
const LOGIN_PATH = '/auth/login';
const REFRESH_PATH = '/auth/refresh';
const LOGOUT_PATH = '/auth/logout';
const ME_PATH = '/auth/me';

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_UNAUTHORIZED = 401;
const HTTP_TOO_MANY_REQUESTS = 429;

/** The `/errors/...` discriminator every unauthorized problem document carries. */
const UNAUTHORIZED_PROBLEM_TYPE = '/errors/unauthorized';

/** RFC 9457 media type the single registered exception handler answers with. */
const PROBLEM_MEDIA_TYPE = 'application/problem+json';

/** Sent with every 401 so browser code can tell "no credential" from "wrong credential". */
const WWW_AUTHENTICATE_HEADER = 'www-authenticate';
const BEARER_CHALLENGE = 'Bearer';

/** The token response of `POST /auth/login` and `POST /auth/refresh`. */
interface TokenPair {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly token_type: string;
  readonly expires_in: number;
}

/** The subset of `UserPublic` this spec reads back from `POST /auth/register`. */
interface RegisteredAccount {
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
}

/** The uniform error document - six members in a fixed order, plus an optional `errors`. */
interface ProblemDocument {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly request_id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/* ------------------------------------------------------------------------------------------
 * Throwaway identities
 *
 * "No secrets in the repository" (§0.10.1), and correctness too. `email` and `username` are
 * unique and CASE-INSENSITIVE (`citext`) in PostgreSQL, and the three viewport projects run
 * against ONE database - concurrently when Playwright has the workers for it. A literal
 * identity would collide across projects and across repeat runs and answer 409, so every
 * account is named at run time from the clock, a random component and a per-file counter.
 *
 * The domain is `example.com` on purpose: `email-validator` REJECTS the special-use TLDs
 * (`.test`, `.invalid`, `.localhost`, `.example`) with a 422, which was measured rather than
 * assumed. `example.com` is the reserved documentation domain and is accepted.
 * ---------------------------------------------------------------------------------------- */

/**
 * The password every throwaway account is created with.
 *
 * Not a secret and not shaped like one: it says so in its own text, it belongs only to accounts
 * this file creates and abandons, and it cannot match any credential-provider pattern. It does
 * satisfy `src/lib/validation/auth.ts` and the server-side policy it mirrors - at least 12
 * characters drawing on at least three of the five character groups (here: lowercase,
 * uppercase, digit and punctuation).
 */
const THROWAWAY_PASSWORD = 'e2e-throwaway-not-a-secret-Aa1';

/** A second, different non-secret, used only to be refused. Same policy, so the 401 is the
 *  server's verdict on the credential rather than a client-side validation failure. */
const THROWAWAY_WRONG_PASSWORD = 'e2e-wrong-value-not-a-secret-Zz9';

/** Distinguishes identities minted within the same millisecond. */
let identitySequence = 0;

interface ThrowawayIdentity {
  readonly email: string;
  readonly username: string;
  readonly password: string;
}

/**
 * Mint an identity no other project, worker or previous run can be holding.
 *
 * The username satisfies the 3-30 character rule and the
 * `^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$` pattern: it starts with a letter, ends with a
 * base-36 digit and contains only lowercase letters, digits and hyphens.
 */
function mintIdentity(): ThrowawayIdentity {
  identitySequence += 1;
  const unique = [
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 8),
    identitySequence.toString(36),
  ].join('');
  const username = `e2e-auth-${unique}`;
  return { email: `${username}@example.com`, username, password: THROWAWAY_PASSWORD };
}

/* ------------------------------------------------------------------------------------------
 * Talking to the API directly
 *
 * `APIRequestContext` ships with `@playwright/test`, so the token-level facts in "Token
 * lifecycle" - which no UI surface exposes - cost no dependency. These helpers also provision
 * accounts for the browser tests: registering over HTTP rather than through the sign-up form
 * keeps each test's setup out of the behaviour it is asserting.
 * ---------------------------------------------------------------------------------------- */

/**
 * Assert an exact status, and make the two failures that are NOT application defects legible.
 *
 * A 429 means the credential limiter refused the harness, which is configuration rather than
 * behaviour; saying so in the assertion message is the difference between a five-second
 * diagnosis and a long one. The response body is attached on any mismatch because a problem
 * document names its own cause. Nothing is caught, retried or downgraded: the assertion runs
 * either way and a wrong status still fails the test.
 */
async function expectStatus(
  operation: string,
  response: APIResponse,
  expected: number,
): Promise<void> {
  const actual = response.status();
  const throttled =
    actual === HTTP_TOO_MANY_REQUESTS
      ? ' The credential limiter refused this call: all five /auth routes are rate limited per' +
        ' route per client address, and this suite calls them repeatedly from one address in' +
        ' three viewport projects. Raise AUTH_RATE_LIMIT for the end-to-end run.'
      : '';
  const body = actual === expected ? '' : ` Response body: ${await response.text()}`;
  expect(
    actual,
    `${operation} answered ${String(actual)}, expected ${String(expected)}.${throttled}${body}`,
  ).toBe(expected);
}

function parseTokenPair(payload: unknown, operation: string): TokenPair {
  if (!isRecord(payload)) {
    throw new Error(`${operation} did not answer with a JSON object.`);
  }
  const {
    access_token: access,
    refresh_token: refresh,
    token_type: kind,
    expires_in: expires,
  } = payload;
  if (typeof access !== 'string' || access === '') {
    throw new Error(`${operation} answered without a non-empty access_token.`);
  }
  if (typeof refresh !== 'string' || refresh === '') {
    throw new Error(`${operation} answered without a non-empty refresh_token.`);
  }
  if (typeof kind !== 'string' || kind !== 'bearer') {
    throw new Error(`${operation} answered token_type ${JSON.stringify(kind)}, expected "bearer".`);
  }
  if (typeof expires !== 'number' || !Number.isFinite(expires)) {
    throw new Error(`${operation} answered without a numeric expires_in.`);
  }
  return { access_token: access, refresh_token: refresh, token_type: kind, expires_in: expires };
}

function parseRegisteredAccount(payload: unknown): RegisteredAccount {
  if (!isRecord(payload)) {
    throw new Error('Registration did not answer with a JSON object.');
  }
  const { id, username, display_name: displayName } = payload;
  if (typeof id !== 'string' || id === '') {
    throw new Error('Registration answered without a server-generated id.');
  }
  if (typeof username !== 'string' || username === '') {
    throw new Error('Registration answered without a username.');
  }
  if (typeof displayName !== 'string' || displayName === '') {
    throw new Error('Registration answered without a display_name.');
  }
  return { id, username, display_name: displayName };
}

function parseProblemDocument(payload: unknown, operation: string): ProblemDocument {
  if (!isRecord(payload)) {
    throw new Error(`${operation} did not answer with a problem document object.`);
  }
  const { type, title, status, detail, instance, request_id: requestId } = payload;
  if (
    typeof type !== 'string' ||
    typeof title !== 'string' ||
    typeof status !== 'number' ||
    typeof detail !== 'string' ||
    typeof instance !== 'string' ||
    typeof requestId !== 'string'
  ) {
    throw new Error(
      `${operation} answered a body that is not the uniform problem document. Expected the six ` +
        `members type, title, status, detail, instance and request_id; received ` +
        `${JSON.stringify(payload)}.`,
    );
  }
  return { type, title, status, detail, instance, request_id: requestId };
}

/** Create an account. Answers 201 with the public projection; no token is issued here. */
async function registerAccount(
  request: APIRequestContext,
  identity: ThrowawayIdentity,
): Promise<RegisteredAccount> {
  const response = await request.post(apiUrl(REGISTER_PATH), {
    data: {
      email: identity.email,
      username: identity.username,
      password: identity.password,
    },
  });
  await expectStatus(`POST ${API_VERSION_PREFIX}${REGISTER_PATH}`, response, HTTP_CREATED);
  return parseRegisteredAccount(await response.json());
}

/**
 * Exchange a credential for a token pair.
 *
 * `form` makes Playwright send `application/x-www-form-urlencoded`, which is what this one
 * route consumes, and the account's EMAIL goes in the field named `username` - that name comes
 * from the OAuth 2 password grant, while this API's identifier is an email address. Crossing
 * this encoding with the JSON one used by refresh is the single likeliest way to break a direct
 * API call here, so it is spelled out rather than left to be inferred.
 */
async function signInForTokens(
  request: APIRequestContext,
  identity: ThrowawayIdentity,
): Promise<TokenPair> {
  const response = await request.post(apiUrl(LOGIN_PATH), {
    form: { username: identity.email, password: identity.password },
  });
  await expectStatus(`POST ${API_VERSION_PREFIX}${LOGIN_PATH}`, response, HTTP_OK);
  return parseTokenPair(await response.json(), `POST ${API_VERSION_PREFIX}${LOGIN_PATH}`);
}

/** Spend a refresh token. Returned raw so a test can assert a refusal as readily as a success. */
function rotateRefreshToken(
  request: APIRequestContext,
  refreshToken: string,
): Promise<APIResponse> {
  return request.post(apiUrl(REFRESH_PATH), { data: { refresh_token: refreshToken } });
}

/** Revoke a refresh token. Needs the bearer as well: the body says which session, the header
 *  says who is asking, and the effect is bounded by the second. */
function signOut(request: APIRequestContext, tokens: TokenPair): Promise<APIResponse> {
  return request.post(apiUrl(LOGOUT_PATH), {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    data: { refresh_token: tokens.refresh_token },
  });
}

/** Read the authenticated principal. `bearer` is omitted to exercise the absent-credential path. */
function readPrincipal(request: APIRequestContext, bearer?: string): Promise<APIResponse> {
  return request.get(
    apiUrl(ME_PATH),
    bearer === undefined ? {} : { headers: { Authorization: `Bearer ${bearer}` } },
  );
}

/**
 * A bearer that is shaped like a signed assertion but is signed by nobody.
 *
 * Assembled at run time rather than written as a literal, for two reasons. It keeps anything
 * resembling a credential out of the tracked file - this is emphatically NOT one, and cannot
 * authenticate anything anywhere - and it makes the structure explicit: three dot-separated
 * base64url segments, so the request gets far enough to be REJECTED BY THE HANDLER'S OWN
 * verification rather than discarded as malformed before it.
 */
function unsignedBearer(): string {
  const segment = (value: Record<string, string>): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return [
    segment({ alg: 'HS256', typ: 'JWT' }),
    segment({ sub: 'nobody', type: 'access' }),
    'this-signature-was-produced-by-nobody',
  ].join('.');
}

/* ------------------------------------------------------------------------------------------
 * Talking to the browser
 *
 * The session marker is non-HttpOnly and scoped to `/`, and the durable refresh cookie, while
 * HttpOnly, is still ours to set from the harness. That is what makes every branch of
 * `middleware.ts` and of the two route-group layouts reachable from a test: read the pair to
 * observe a session, write it to construct one, and tamper with it to prove it is only a claim.
 * ---------------------------------------------------------------------------------------- */

/** Written by `auth-provider.tsx`, read by `middleware.ts`. Value is a role literal. */
const SESSION_MARKER_COOKIE = 'blog_session';

/** HttpOnly mirror of the refresh token, written by the `/api/session` route handler. */
const DURABLE_SESSION_COOKIE = 'blog_refresh';

/** The durable cookie's `Path`. Narrower than `/` so it is sent only to its own route. */
const DURABLE_SESSION_PATH = '/api/session';

/** The three role literals `middleware.ts` will accept in the marker. */
type SessionRole = 'READER' | 'AUTHOR' | 'ADMIN';

/** What registration grants, and therefore what an ordinary account's marker holds. */
const AUTHOR_ROLE: SessionRole = 'AUTHOR';

/** The only role `middleware.ts` admits onto an administrative path. */
const ADMIN_ROLE: SessionRole = 'ADMIN';

/** Rendered URLs. Route-group parentheses are never URL segments, so these are the real paths. */
const LOGIN_ROUTE = '/login';
const SIGNUP_ROUTE = '/signup';
const HOME_ROUTE = '/';
const DASHBOARD_ROUTE = '/dashboard';
const ADMIN_ROUTE = '/admin';
const NEW_POST_ROUTE = '/posts/new';

/** The query parameter `middleware.ts` writes and the sign-in page validates. */
const RETURN_TO_PARAM = 'next';

/** Upper bound on the keyboard walk to the first form control. Generous enough for the widest
 *  viewport, where the header additionally offers a navigation landmark and a search field, and
 *  small enough that a genuinely unreachable control fails rather than hangs. */
const MAX_TAB_STEPS = 40;

function siteUrl(baseURL: string | undefined, path: string): string {
  if (baseURL === undefined || baseURL === '') {
    throw new Error(
      'baseURL is not configured, so a relative path cannot be resolved. It comes from ' +
        'NEXT_PUBLIC_SITE_URL through playwright.config.ts.',
    );
  }
  return new URL(path, baseURL).toString();
}

/** `/login?next=<url-encoded path>` - exactly what `middleware.ts` builds with `searchParams`. */
function loginUrlReturningTo(baseURL: string | undefined, returnTo: string): string {
  return siteUrl(baseURL, `${LOGIN_ROUTE}?${RETURN_TO_PARAM}=${encodeURIComponent(returnTo)}`);
}

/** The marker's current value, or `null` when no marker cookie is set. */
async function readSessionMarker(
  context: BrowserContext,
  baseURL: string | undefined,
): Promise<string | null> {
  const cookies = await context.cookies(siteUrl(baseURL, HOME_ROUTE));
  const marker = cookies.find((cookie) => cookie.name === SESSION_MARKER_COOKIE);
  return marker === undefined || marker.value === '' ? null : marker.value;
}

/** Whether the HttpOnly refresh mirror is in place - the precondition for restoring a session
 *  across a full page load. */
async function hasDurableSession(
  context: BrowserContext,
  baseURL: string | undefined,
): Promise<boolean> {
  const cookies = await context.cookies(siteUrl(baseURL, DURABLE_SESSION_PATH));
  return cookies.some((cookie) => cookie.name === DURABLE_SESSION_COOKIE && cookie.value !== '');
}

/**
 * Put a session into the browser without driving the sign-in form.
 *
 * Both cookies are written exactly as the application writes them, so the page under test
 * cannot tell the difference: the marker at `Path=/` with `SameSite=Lax`, and the refresh mirror
 * HttpOnly at `Path=/api/session` with `SameSite=Strict`. `role` is a parameter rather than
 * derived, which is the whole point of the two tampering tests - the marker is a claim the
 * client makes about itself, and passing a claim that is not true is how its authority (none)
 * gets measured.
 */
async function seedSession(
  context: BrowserContext,
  baseURL: string | undefined,
  role: SessionRole,
  tokens: TokenPair | null,
): Promise<void> {
  const origin = new URL(siteUrl(baseURL, HOME_ROUTE));
  await context.addCookies([
    {
      name: SESSION_MARKER_COOKIE,
      value: role,
      domain: origin.hostname,
      path: HOME_ROUTE,
      sameSite: 'Lax',
    },
  ]);
  if (tokens !== null) {
    await context.addCookies([
      {
        name: DURABLE_SESSION_COOKIE,
        value: tokens.refresh_token,
        domain: origin.hostname,
        path: DURABLE_SESSION_PATH,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
  }
}

/** The header's signed-in affordance, addressed by the accessible name `user-menu.tsx` gives it. */
function accountMenuTrigger(page: Page, displayName: string): Locator {
  return page.getByRole('button', { name: `Account menu for ${displayName}`, exact: true });
}

/**
 * Fill and submit the sign-in form.
 *
 * Waits for the control to be enabled rather than for a timeout: the form is behind a
 * `<Suspense>` boundary and its inputs stay disabled while the provider resolves the session, so
 * a fixed sleep would race the settled state either way it went.
 */
async function submitSignInForm(page: Page, email: string, password: string): Promise<void> {
  const submit = page.getByRole('button', { name: 'Sign in' });
  await expect(submit).toBeEnabled();
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await submit.click();
}

/** Fill and submit the registration form. There is no display-name control: the server derives
 *  the display name from the username, which is why the account menu is named after it. */
async function submitSignUpForm(page: Page, identity: ThrowawayIdentity): Promise<void> {
  const submit = page.getByRole('button', { name: 'Create account', exact: true });
  await expect(submit).toBeEnabled();
  await page.getByLabel('Email address').fill(identity.email);
  await page.getByLabel('Username').fill(identity.username);
  await page.getByLabel('Password').fill(identity.password);
  await submit.click();
}

/** `/login?next=<raw>` with the value percent-encoded, so a hostile target reaches the page
 *  exactly as an attacker would deliver it. */
function loginRouteWithRawReturnTo(rawReturnTo: string): string {
  return `${LOGIN_ROUTE}?${RETURN_TO_PARAM}=${encodeURIComponent(rawReturnTo)}`;
}

/* ==========================================================================================
 * §0.9.4.4 "Registration and login"
 * ========================================================================================== */

test.describe('Registration and sign-in', () => {
  test('a visitor can create an account through the sign-up form and is left signed in', async ({
    page,
    context,
    baseURL,
  }) => {
    const identity = mintIdentity();

    await page.goto(SIGNUP_ROUTE);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Create your account', exact: true }),
    ).toBeVisible();

    await submitSignUpForm(page, identity);

    // Registration is followed by an automatic sign-in, and the sign-up page then hands the
    // visitor to the credential page, which finds an authenticated principal and leaves for the
    // return target. No target was requested, so that is the home feed.
    await expect(page).toHaveURL(siteUrl(baseURL, HOME_ROUTE));

    // The display name defaults to the username, because the form collects no display name -
    // which is what the header's account control is named after.
    await expect(accountMenuTrigger(page, identity.username)).toBeVisible();

    // Registration grants AUTHOR. It is assigned by the service rather than nominated by the
    // caller: the registration payload carries no role field at all.
    expect(await readSessionMarker(context, baseURL)).toBe(AUTHOR_ROLE);
    await expect.poll(() => hasDurableSession(context, baseURL)).toBe(true);
  });

  test('a registered visitor can sign in and reach the protected author workspace', async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    const identity = mintIdentity();
    const account = await registerAccount(request, identity);

    await page.goto(LOGIN_ROUTE);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Sign in', exact: true }),
    ).toBeVisible();
    await submitSignInForm(page, identity.email, identity.password);

    // A session exists: the header reflects the principal, the marker records the role, and the
    // refresh mirror is in place so the session survives a full page load.
    await expect(accountMenuTrigger(page, account.display_name)).toBeVisible();
    expect(await readSessionMarker(context, baseURL)).toBe(AUTHOR_ROLE);
    await expect.poll(() => hasDurableSession(context, baseURL)).toBe(true);

    // §0.9.4.4's "call a protected route with the returned bearer token successfully", expressed
    // through the interface: a full page load of a guarded route, restored from the mirror.
    await page.goto(DASHBOARD_ROUTE);
    await expect(page).toHaveURL(siteUrl(baseURL, DASHBOARD_ROUTE));
    await expect(
      page.getByRole('heading', { level: 1, name: 'Your posts', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Workspace', exact: true })).toBeVisible();

    // Neither way the workspace refuses a visitor is on screen - so this is the workspace
    // itself, not a redirect that happened to keep the URL and not the signed-out panel.
    await expect(
      page.getByRole('heading', { name: 'Sign in to reach your workspace' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'We could not confirm your session' }),
    ).toHaveCount(0);
  });

  test('signs in under keyboard control alone, and a wrong password is refused without revealing whether the account exists', async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    const identity = mintIdentity();
    const account = await registerAccount(request, identity);

    await page.goto(LOGIN_ROUTE);
    const emailField = page.getByLabel('Email address');
    const passwordField = page.getByLabel('Password');
    const submit = page.getByRole('button', { name: 'Sign in', exact: true });
    await expect(submit).toBeEnabled();

    // KEYBOARD REACHABILITY ("Accessibility as a floor"). The first control must be reachable
    // from a cold page with Tab and nothing else. The number of stops before it differs by
    // width - the header's navigation landmark is hidden below md and its search field below lg
    // - so the walk is BOUNDED rather than counted, which keeps one assertion honest at all
    // three viewports without branching on viewport.
    //
    // The precondition is asserted first, and it is what makes the walk mean something: a
    // freshly loaded page places focus nowhere, so every step below is a genuine keyboard
    // traversal rather than a field that arrived already focused.
    expect(
      await page.evaluate(() => document.activeElement?.tagName ?? null),
      'a freshly loaded credential page must place focus on the document body',
    ).toBe('BODY');

    let tabSteps = 0;
    while (
      tabSteps < MAX_TAB_STEPS &&
      !(await emailField.evaluate((node) => node === document.activeElement))
    ) {
      await page.keyboard.press('Tab');
      tabSteps += 1;
    }
    expect(
      tabSteps,
      `the email field was not reachable within ${String(MAX_TAB_STEPS)} Tab presses`,
    ).toBeLessThan(MAX_TAB_STEPS);
    await expect(emailField).toBeFocused();

    await page.keyboard.type(identity.email);
    await page.keyboard.press('Tab');
    await expect(passwordField).toBeFocused();
    await page.keyboard.type(THROWAWAY_WRONG_PASSWORD);
    await page.keyboard.press('Tab');
    await expect(submit).toBeFocused();

    // VISIBLE FOCUS INDICATOR. Read from the COMPUTED style, never from a class name: what the
    // criterion requires is that the ring is actually painted, and the token layer paints it as
    // an outline under `:focus-visible` so it survives an overflow-clipped ancestor.
    const focusIndicator = await submit.evaluate((node) => {
      const computed = window.getComputedStyle(node);
      return {
        matchesFocusVisible: node.matches(':focus-visible'),
        outlineStyle: computed.outlineStyle,
        outlineWidth: Number.parseFloat(computed.outlineWidth),
      };
    });
    expect(
      focusIndicator.matchesFocusVisible,
      'a keyboard-focused submit control must match :focus-visible',
    ).toBe(true);
    expect(focusIndicator.outlineStyle, 'the focus indicator must be drawn').not.toBe('none');
    expect(focusIndicator.outlineWidth, 'the focus outline must have width').toBeGreaterThan(0);

    // Submitting from the keyboard, with a password that is wrong rather than malformed - so the
    // 401 below is the service's verdict on the credential and not client-side validation.
    await page.keyboard.press('Enter');

    // Scoped to the main landmark on purpose. Next.js keeps a permanently mounted, empty
    // `role="alert"` route announcer in the body for client-side navigations, so an unscoped
    // `getByRole('alert')` matches two elements and fails strict mode. The main region contains
    // the page's own live region and not the framework's.
    const failure = page.getByRole('main').getByRole('alert');
    await expect(failure).toBeVisible();
    await expect(failure).toContainText('That email address or password is not correct.');
    await expect(failure).toContainText('we do not say which of the two did not match');

    // NO ENUMERATION. The refusal is deliberately undifferentiated: it names neither the address
    // nor the account, so the form cannot be used to discover which accounts exist.
    await expect(failure).not.toContainText(identity.email);
    await expect(failure).not.toContainText(account.username);
    await expect(page).toHaveURL(siteUrl(baseURL, LOGIN_ROUTE));
    expect(await readSessionMarker(context, baseURL)).toBeNull();

    // Correct the entry without touching the pointer: back one stop, replace the value, submit.
    await page.keyboard.press('Shift+Tab');
    await expect(passwordField).toBeFocused();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(identity.password);
    await page.keyboard.press('Enter');

    await expect(accountMenuTrigger(page, account.display_name)).toBeVisible();
    expect(await readSessionMarker(context, baseURL)).toBe(AUTHOR_ROLE);
  });
});

/* ==========================================================================================
 * §0.9.4.4 "Token lifecycle"
 *
 * Driven over `APIRequestContext` because these are token-level facts no interface surface
 * exposes: the refresh token is never readable from the page, and the rotation and revocation
 * rules are only observable by presenting credentials directly.
 * ========================================================================================== */

test.describe('Token lifecycle', () => {
  test('refreshing rotates the refresh token, and the superseded one is refused and takes its successor with it', async ({
    request,
  }) => {
    const identity = mintIdentity();
    await registerAccount(request, identity);
    const issued = await signInForTokens(request, identity);

    const rotationLabel = `POST ${API_VERSION_PREFIX}${REFRESH_PATH}`;
    const rotatedResponse = await rotateRefreshToken(request, issued.refresh_token);
    await expectStatus(rotationLabel, rotatedResponse, HTTP_OK);
    const rotated = parseTokenPair(await rotatedResponse.json(), rotationLabel);

    // ROTATION, not reissue. A refresh token is single-use: the one presented is revoked in the
    // same statement that issues its replacement, so the value must have changed. Compared as a
    // boolean rather than with `not.toBe`, so a failure reports the verdict instead of printing
    // two credentials into the report and the trace.
    expect(
      rotated.refresh_token === issued.refresh_token,
      'refresh must rotate the refresh token rather than return the same value',
    ).toBe(false);
    expect(rotated.token_type).toBe('bearer');
    expect(rotated.expires_in).toBeGreaterThan(0);

    // The ACCESS token is deliberately NOT asserted to differ, and the omission is a finding
    // rather than an oversight. It is a signed assertion over the subject, the role and
    // whole-second issued-at and expiry claims, so two mintings for the same account inside one
    // second are byte-identical by construction - measured here, where the rotation completes in
    // milliseconds. Rotation is a property of the refresh token, which is the credential with
    // server-side state; §0.9.4.4 asks for exactly that.

    // The replacement pair is usable, which is what makes the rotation a rotation rather than a
    // revocation with extra steps.
    const principalLabel = `GET ${API_VERSION_PREFIX}${ME_PATH}`;
    const principalResponse = await readPrincipal(request, rotated.access_token);
    await expectStatus(principalLabel, principalResponse, HTTP_OK);
    const principal: unknown = await principalResponse.json();
    expect(isRecord(principal)).toBe(true);
    expect(isRecord(principal) ? principal.username : undefined).toBe(identity.username);
    expect(isRecord(principal) ? principal.role : undefined).toBe(AUTHOR_ROLE);

    // REUSE DETECTION, and deliberately the last thing this test does. Presenting a spent token
    // is treated as evidence of theft, so it does not merely fail - it revokes every outstanding
    // token the account holds, including the successor obtained above. Anything asserted after
    // this point would be asserting against a deliberately emptied session.
    const replayResponse = await rotateRefreshToken(request, issued.refresh_token);
    await expectStatus(
      `${rotationLabel} replaying a spent token`,
      replayResponse,
      HTTP_UNAUTHORIZED,
    );
    const replayProblem = parseProblemDocument(await replayResponse.json(), rotationLabel);
    expect(replayProblem.type).toBe(UNAUTHORIZED_PROBLEM_TYPE);
    expect(replayProblem.status).toBe(HTTP_UNAUTHORIZED);
    expect(replayProblem.instance).toBe(`${API_VERSION_PREFIX}${REFRESH_PATH}`);
    expect(replayProblem.request_id).not.toBe('');

    // The successor is gone too. Without this the previous assertion would be satisfied by a
    // service that merely refused the old value while leaving the stolen session alive.
    await expectStatus(
      `${rotationLabel} after a replay has revoked the account's tokens`,
      await rotateRefreshToken(request, rotated.refresh_token),
      HTTP_UNAUTHORIZED,
    );
  });

  test('signing out revokes the refresh token, and an unusable bearer is refused with the uniform problem document', async ({
    request,
  }) => {
    const identity = mintIdentity();
    await registerAccount(request, identity);
    const issued = await signInForTokens(request, identity);

    // Sign-out needs both credentials - the body says which session to end, the header says who
    // is asking - and answers 204 with nothing in it.
    const signOutLabel = `POST ${API_VERSION_PREFIX}${LOGOUT_PATH}`;
    const signedOut = await signOut(request, issued);
    await expectStatus(signOutLabel, signedOut, HTTP_NO_CONTENT);
    expect(await signedOut.text(), '204 must carry no body').toBe('');

    // REVOCATION. The refresh token presented at sign-out no longer buys a session.
    const rotationLabel = `POST ${API_VERSION_PREFIX}${REFRESH_PATH}`;
    const afterSignOut = await rotateRefreshToken(request, issued.refresh_token);
    await expectStatus(`${rotationLabel} after signing out`, afterSignOut, HTTP_UNAUTHORIZED);
    expect(parseProblemDocument(await afterSignOut.json(), rotationLabel).type).toBe(
      UNAUTHORIZED_PROBLEM_TYPE,
    );

    // An absent credential and a structurally-plausible but unsigned one are refused
    // identically, and both answer the SAME machine-readable document - the point of a single
    // registered exception handler, replacing the ad-hoc, per-call-site errors the retired
    // application raised.
    const unusableBearers: readonly (readonly [string, string | undefined])[] = [
      ['no bearer at all', undefined],
      ['a structurally valid but unsigned bearer', unsignedBearer()],
    ];
    for (const [description, bearer] of unusableBearers) {
      const label = `GET ${API_VERSION_PREFIX}${ME_PATH} with ${description}`;
      const refused = await readPrincipal(request, bearer);
      await expectStatus(label, refused, HTTP_UNAUTHORIZED);

      // The challenge header `client.ts` documents as part of its 401 normalisation: without it
      // browser code cannot tell "no credential was sent" from "the credential was rejected".
      expect(refused.headers()[WWW_AUTHENTICATE_HEADER], `${label} must challenge`).toBe(
        BEARER_CHALLENGE,
      );
      expect(refused.headers()['content-type']).toContain(PROBLEM_MEDIA_TYPE);

      const problem = parseProblemDocument(await refused.json(), label);
      expect(problem.type).toBe(UNAUTHORIZED_PROBLEM_TYPE);
      expect(problem.status).toBe(HTTP_UNAUTHORIZED);
      expect(problem.instance).toBe(`${API_VERSION_PREFIX}${ME_PATH}`);
      expect(problem.title).not.toBe('');
      expect(problem.detail).not.toBe('');
      expect(problem.request_id).not.toBe('');
    }
  });
});

/* ==========================================================================================
 * §0.9.4.4 "Authorisation negatives" - the route-protection half
 *
 * The API-level refusals (`require_admin`, the ownership assertions) belong to the specs that
 * own those journeys. What is asserted here is the client-side gate reached through the
 * authentication journey, INCLUDING the two cases that prove it is only a gate and never the
 * authority (§0.6.5).
 * ========================================================================================== */

test.describe('Route protection for the dashboard and admin route groups', () => {
  test('an unauthenticated visitor is turned away from every protected family with the original path preserved', async ({
    page,
    context,
    baseURL,
  }) => {
    // Explicit rather than incidental: Playwright builds a fresh context per test, and this
    // states the precondition the assertion depends on.
    await context.clearCookies();
    expect(await readSessionMarker(context, baseURL)).toBeNull();

    // All three guarded families, because `middleware.ts` matches three and a matcher that
    // silently stopped covering one would be invisible if only the dashboard were checked.
    for (const guarded of [DASHBOARD_ROUTE, NEW_POST_ROUTE, ADMIN_ROUTE]) {
      await page.goto(guarded);
      await expect(page).toHaveURL(loginUrlReturningTo(baseURL, guarded));

      // The parameter carries the original path URL-ENCODED - so a path separator arrives as
      // %2F - and decodes back to exactly what was asked for.
      expect(page.url()).toContain(`${RETURN_TO_PARAM}=${encodeURIComponent(guarded)}`);
      expect(new URL(page.url()).searchParams.get(RETURN_TO_PARAM)).toBe(guarded);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Sign in', exact: true }),
      ).toBeVisible();
    }
  });

  test('signing in from the redirect returns the visitor to the path they originally asked for', async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    const identity = mintIdentity();
    const account = await registerAccount(request, identity);

    await context.clearCookies();
    await page.goto(DASHBOARD_ROUTE);
    await expect(page).toHaveURL(loginUrlReturningTo(baseURL, DASHBOARD_ROUTE));

    await submitSignInForm(page, identity.email, identity.password);

    // The round trip: back to the guarded route that was asked for, not to the home feed.
    await expect(page).toHaveURL(siteUrl(baseURL, DASHBOARD_ROUTE));
    await expect(
      page.getByRole('heading', { level: 1, name: 'Your posts', exact: true }),
    ).toBeVisible();
    await expect(accountMenuTrigger(page, account.display_name)).toBeVisible();
  });

  test('an off-site return target is refused and the visitor lands on the home feed', async ({
    page,
    baseURL,
    request,
  }) => {
    const identity = mintIdentity();
    const account = await registerAccount(request, identity);
    const siteHost = new URL(siteUrl(baseURL, HOME_ROUTE)).host;

    // Every main-frame navigation is recorded, so the assertion can be about where the browser
    // went and not merely about where it came to rest.
    const visited: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        visited.push(frame.url());
      }
    });

    // A PROTOCOL-RELATIVE target is discarded before any credential is submitted. The sign-up
    // cross-link is built from the same resolved value, so its landing on a bare /signup - with
    // no return target carried over - is proof the hostile host was already dropped.
    await page.goto(loginRouteWithRawReturnTo('//not-this-site.example.com/stolen'));
    await page.getByRole('link', { name: 'Create an account', exact: true }).click();
    await expect(page).toHaveURL(siteUrl(baseURL, SIGNUP_ROUTE));

    // An ABSOLUTE off-site target is discarded too, and signing in is what proves it: the guard
    // accepts only same-site relative paths and falls back to the home feed.
    await page.goto(loginRouteWithRawReturnTo('https://not-this-site.example.com/stolen'));
    await submitSignInForm(page, identity.email, identity.password);

    await expect(page).toHaveURL(siteUrl(baseURL, HOME_ROUTE));
    await expect(accountMenuTrigger(page, account.display_name)).toBeVisible();

    const offSite = visited.filter(
      (url) => url.startsWith('http') && new URL(url).host !== siteHost,
    );
    expect(offSite, 'the browser must never be navigated to the return target’s origin').toEqual(
      [],
    );
  });

  test('a session marker that cannot be authenticated renders the signed-out panel instead of redirecting', async ({
    page,
    context,
    baseURL,
  }) => {
    // A marker with NO refresh mirror behind it. Middleware admits the request, because the
    // marker is a claim the client makes about itself and the Edge runtime holds no key to check
    // one; the route-group layout then fails to resolve a principal and renders its refusal.
    // This is the second of the two legitimate outcomes in §0.6.5 - a redirect and a rendered
    // panel are both correct, and which one appears follows from the cookie state.
    await seedSession(context, baseURL, AUTHOR_ROLE, null);
    expect(await hasDurableSession(context, baseURL)).toBe(false);

    await page.goto(DASHBOARD_ROUTE);

    await expect(
      page.getByRole('heading', { name: 'Sign in to reach your workspace' }),
    ).toBeVisible();
    await expect(page.getByText('This workspace belongs to a signed-in author')).toBeVisible();

    // Not a redirect. The request was admitted and the refusal was rendered in place.
    await expect(page).toHaveURL(siteUrl(baseURL, DASHBOARD_ROUTE));

    // The workspace itself is not on screen, and the unusable marker is discarded rather than
    // left to fail again on the next request.
    await expect(page.getByRole('navigation', { name: 'Workspace', exact: true })).toHaveCount(0);
    await expect.poll(() => readSessionMarker(context, baseURL)).toBe(null);

    // The panel's own way out carries the same return target the middleware would have set.
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(loginUrlReturningTo(baseURL, DASHBOARD_ROUTE));
  });

  test('a signed-in author is refused the admin dashboard and returned to the home feed with the session intact', async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    const identity = mintIdentity();
    const account = await registerAccount(request, identity);
    const tokens = await signInForTokens(request, identity);
    await seedSession(context, baseURL, AUTHOR_ROLE, tokens);

    await page.goto(ADMIN_ROUTE);

    // Refused by the middleware, which reads the role from the marker and sends a
    // non-administrator home rather than to the credential page - there is nothing to sign in
    // as, because this account is already signed in and simply holds no administrative
    // authority.
    await expect(page).toHaveURL(siteUrl(baseURL, HOME_ROUTE));

    // A refusal, not a sign-out: the session survives it untouched.
    const trigger = accountMenuTrigger(page, account.display_name);
    await expect(trigger).toBeVisible();
    expect(await readSessionMarker(context, baseURL)).toBe(AUTHOR_ROLE);

    // And the account is offered no administrative entry point to begin with.
    await trigger.click();
    await expect(page.getByRole('menuitem', { name: 'Dashboard', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Admin', exact: true })).toHaveCount(0);
  });

  test('a session marker tampered to claim administrator confers no administrative access', async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    const identity = mintIdentity();
    const account = await registerAccount(request, identity);
    const tokens = await signInForTokens(request, identity);

    // The marker is written by client-side script, so anything that can run script can forge it.
    // Claiming ADMIN is enough to get PAST the middleware - which is precisely why §0.6.5 calls
    // client-side protection defence in depth and puts the real gate in the service.
    await seedSession(context, baseURL, ADMIN_ROLE, tokens);

    await page.goto(ADMIN_ROUTE);

    // Admitted: no redirect home and none to the credential page. The claim was believed, because
    // the middleware has no way to disbelieve it.
    await expect(page).toHaveURL(siteUrl(baseURL, ADMIN_ROUTE));

    // And it bought nothing. The administrative navigation is never rendered for this account,
    // whatever its cookie says.
    await expect(page.getByRole('navigation', { name: 'Admin sections' })).toHaveCount(0);

    // The session that actually resolved is the author's own, and the provider overwrites the
    // forged claim with the role the service reported - so the lie does not even outlive the
    // page it was told on.
    await expect(accountMenuTrigger(page, account.display_name)).toBeVisible();
    await expect.poll(() => readSessionMarker(context, baseURL)).toBe(AUTHOR_ROLE);
  });
});
