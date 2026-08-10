/**
 * The session route: the only thing in this tier that can hold a credential across documents.
 *
 * A Route Handler on this application's OWN origin, serving three operations on one cookie:
 *
 * | Method   | Purpose                                                              | Answers          |
 * | -------- | -------------------------------------------------------------------- | ---------------- |
 * | `PUT`    | Adopt the refresh token a sign-in or an in-document rotation produced | `204`            |
 * | `POST`   | Rotate the stored token and hand back a usable pair                  | `200` token pair |
 * | `DELETE` | Drop the stored token                                                | `204`            |
 *
 * ## WHY THIS EXISTS
 *
 * `@/lib/api/client` holds the access token and the refresh token in module variables, which is the
 * right place for them: no other document and no other origin can read a module variable, and the
 * bearer is attached from there. The cost is that a module variable dies with its JavaScript context.
 * A reload, a new tab or an external link back into the site therefore arrived holding nothing, while
 * the script-written `blog_session` role marker - being a cookie - was still present. `src/middleware.ts`
 * admitted the protected navigation on the strength of that marker, the new document had no credential
 * to authenticate with, and the provider cleared the marker and presented an anonymous session. The
 * reader was signed out by every full navigation, having done nothing.
 *
 * ## WHY THE CREDENTIAL LIVES HERE AND NOT IN THE DOCUMENT
 *
 * Everything a browser script can write, a browser script can read. `localStorage`, `sessionStorage`
 * and a script-written cookie are all readable by every same-origin script the page will ever load,
 * and a cookie written by script cannot be `HttpOnly` - that flag exists precisely to hide a cookie
 * from script. A refresh token in any of them is a long-lived credential published to an analytics
 * snippet, a transitive dependency, or anything reflected into the page (CWE-522, CWE-1004, CWE-922).
 *
 * A cookie written by a SERVER can be `HttpOnly`, and this application already runs one. So the
 * refresh token is written here, with every flag that narrows it:
 *
 *   `HttpOnly`             no script in the document can read it, including `@/lib/api/client`
 *   `SameSite=Strict`      a cross-site request cannot carry it, which is this route's CSRF answer
 *   `Path=/api/session`    it is not attached to any other request this application serves
 *   `Secure` (see below)   it is not sent over plaintext where the connection is encrypted at all
 *
 * The role marker stays exactly what it was: script-written, script-readable, and authenticating
 * nothing. It says a session existed and which role it claimed, and `src/middleware.ts` treats it as
 * a hint about what to SHOW. Authority is still re-decided server-side on every operation by
 * `require_admin` and by the ownership assertions in the service layer.
 *
 * ## WHAT THIS ROUTE IS NOT
 *
 * - **Not an authenticator.** It resolves no principal, reads no `Authorization` header and makes no
 *   authority decision. It moves one opaque string between a cookie and the API's rotation endpoint.
 *   Who the reader is comes from `GET /api/v1/auth/me`, which the provider calls once a credential
 *   exists.
 * - **Not a transport of its own.** The upstream rotation goes through `apiPost` in
 *   `@/lib/api/client`, which is the tier's only HTTP module - so the base-URL resolution from
 *   `NEXT_PUBLIC_API_BASE_URL`, the timeout and the problem-document parsing all apply here exactly as
 *   they do everywhere else. This file composes no URL and reads no environment variable.
 * - **Not a second rotation path.** In-document rotation stays in the client's single-flight path,
 *   where one shared promise collapses N concurrent `401`s into one request. This route rotates only
 *   for a document that has nothing in memory to rotate WITH, which is by definition a document that
 *   has issued no requests yet.
 * - **Not a log of credentials.** No token value is written to the console, to an error message or to
 *   a response body other than the one the caller is entitled to. The upstream failure is reported by
 *   status alone.
 *
 * ## THE `Secure` FLAG, STATED HONESTLY
 *
 * It is set whenever the request arrived over https, which is every deployed environment. On plain
 * http - local development only - it is omitted, because a browser refuses to store a `Secure` cookie
 * from an insecure origin and marking it would disable this feature entirely rather than harden it.
 *
 * ## LIFETIME
 *
 * A session cookie: no `Max-Age` and no `Expires`, so it lives for the browser session and is gone
 * when the browser closes. That covers every case the defect was about - a reload, a new tab,
 * following a link back in - without keeping a credential on disk, and it needs no configuration knob
 * that could drift from the service's own `REFRESH_TOKEN_EXPIRE_DAYS`. A token that outlives the
 * cookie is simply rotated on the next document; a cookie that outlives the token is refused by the
 * service and cleared here.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import {
  DURABLE_SESSION_COOKIE_NAME,
  DURABLE_SESSION_ROUTE,
  apiPost,
  isApiError,
} from '@/lib/api/client';
import { tokenPairSchema } from '@/lib/types';
import type { TokenPair } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The API's rotation endpoint, namespace-relative.
 *
 * `apiPost` composes the `/api/v1` prefix and the configured base URL, so this is the bare path -
 * the same convention every wrapper under `@/lib/api` follows.
 */
const REFRESH_PATH = '/auth/refresh';

/** The member `POST /api/v1/auth/refresh` reads the presented credential from. */
const REFRESH_TOKEN_FIELD = 'refresh_token';

const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_BAD_GATEWAY = 502;

/**
 * Every attribute of the durable cookie except `secure`, which depends on the request.
 *
 * `path` is taken from the client's own exported constant rather than written again, so the cookie
 * cannot end up scoped to a path this route is not served at - a mismatch that fails silently, by the
 * cookie simply never being sent.
 */
const COOKIE_ATTRIBUTES = {
  httpOnly: true,
  sameSite: 'strict',
  path: DURABLE_SESSION_ROUTE,
} as const;

/* -------------------------------------------------------------------------------------------------
 * Cookie handling
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether this request arrived over an encrypted connection.
 *
 * Read from the request rather than from configuration, so one build is correct on http locally and
 * https everywhere else with no variable to set and none to get wrong. Next.js has already resolved
 * `nextUrl.protocol` from the forwarded-proto header where a proxy terminates TLS.
 */
function isSecureRequest(request: NextRequest): boolean {
  return request.nextUrl.protocol === 'https:';
}

/**
 * Write the durable credential onto a response.
 *
 * @param response - The response being returned to the caller.
 * @param request - The request, for the `secure` decision alone.
 * @param refreshCredential - The opaque token the service issued. Never logged, never echoed.
 * @returns The same response, for chaining at the call site.
 */
function writeDurableCookie(
  response: NextResponse,
  request: NextRequest,
  refreshCredential: string,
): NextResponse {
  response.cookies.set({
    name: DURABLE_SESSION_COOKIE_NAME,
    value: refreshCredential,
    secure: isSecureRequest(request),
    ...COOKIE_ATTRIBUTES,
  });

  return response;
}

/**
 * Expire the durable credential on a response.
 *
 * Set to an empty value with `maxAge: 0` rather than deleted by name, because the attributes have to
 * MATCH for a browser to replace the right cookie: a `Path` mismatch leaves the original in place and
 * the clear appears to have worked. Reusing {@link COOKIE_ATTRIBUTES} is what guarantees they do.
 *
 * @param response - The response being returned to the caller.
 * @param request - The request, for the `secure` decision alone.
 * @returns The same response, for chaining at the call site.
 */
function clearDurableCookie(response: NextResponse, request: NextRequest): NextResponse {
  response.cookies.set({
    name: DURABLE_SESSION_COOKIE_NAME,
    value: '',
    secure: isSecureRequest(request),
    maxAge: 0,
    ...COOKIE_ATTRIBUTES,
  });

  return response;
}

/**
 * The stored credential, or `null` when there is none usable.
 *
 * An empty value counts as none: that is exactly what a cleared-but-not-yet-dropped cookie looks
 * like, and presenting it to the service would be a request that could only be refused.
 */
function readDurableCookie(request: NextRequest): string | null {
  const stored = request.cookies.get(DURABLE_SESSION_COOKIE_NAME)?.value;

  return stored === undefined || stored === '' ? null : stored;
}

/**
 * The refresh token a `PUT` body carries, or `null` when the body does not carry a usable one.
 *
 * Total by construction: a body that is not JSON, is not an object, or whose member is absent or not
 * a non-empty string all resolve to `null`, so a malformed request is answered `400` rather than
 * storing something that is not a credential.
 */
async function readSubmittedCredential(request: NextRequest): Promise<string | null> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return null;
  }

  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const submitted = (payload as Record<string, unknown>)[REFRESH_TOKEN_FIELD];

  return typeof submitted === 'string' && submitted !== '' ? submitted : null;
}

/* -------------------------------------------------------------------------------------------------
 * Handlers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Adopt a refresh token into the durable store.
 *
 * Called by `@/lib/api/client` immediately after it adopts a pair, which is to say after a sign-in or
 * after an in-document rotation. Answers `204`: there is nothing to report but success, and the caller
 * already holds the pair it just handed over.
 *
 * The token is NOT validated against the service here, and deliberately. It arrived from a response
 * this same application read moments ago, a probe request would revoke it - rotation is single-use -
 * and a token that turns out to be unusable is discovered at recovery time, where the answer is
 * already "sign in".
 *
 * @param request - The incoming request. Its body carries `refresh_token`.
 * @returns `204` on success, `400` for a body that carries no usable credential.
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const submitted = await readSubmittedCredential(request);
  if (submitted === null) {
    return NextResponse.json(
      { detail: `A JSON body carrying a non-empty "${REFRESH_TOKEN_FIELD}" is required.` },
      { status: HTTP_BAD_REQUEST },
    );
  }

  return writeDurableCookie(
    new NextResponse(null, { status: HTTP_NO_CONTENT }),
    request,
    submitted,
  );
}

/**
 * Rotate the durable credential and hand the new pair back to the document.
 *
 * The recovery path, and the only operation here that talks to the service. Four outcomes, and each
 * one is a distinct answer because the caller acts differently on each:
 *
 *   * **No cookie** -> `401`. There is nothing to recover from; the reader signs in.
 *   * **The service refuses the token** -> its own status, and the cookie is CLEARED on the way out.
 *     A refresh token is single-use, so a refusal means revoked, expired or already spent, and keeping
 *     it would make every later document repeat this same failed request.
 *   * **The service could not be reached, or answered `5xx`** -> `502`, and the cookie is KEPT. That
 *     failure says nothing about the credential, and discarding it would sign a reader out because the
 *     service restarted.
 *   * **Success** -> `200` with the new pair, and the replacement written into the cookie in the same
 *     response. Both halves move together, which is what makes this atomic from the document's point
 *     of view: there is no window in which the cookie holds a token the document does not have.
 *
 * @param request - The incoming request. Carries no body; the credential is the cookie.
 * @returns `200` with a {@link TokenPair}, or one of the failures above.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const stored = readDurableCookie(request);
  if (stored === null) {
    return NextResponse.json(
      { detail: 'No stored session. Sign in to continue.' },
      { status: HTTP_UNAUTHORIZED },
    );
  }

  let rotated: TokenPair;
  try {
    rotated = await apiPost(
      REFRESH_PATH,
      tokenPairSchema,
      { [REFRESH_TOKEN_FIELD]: stored },
      // `anonymous`, so the client attaches no bearer and its rotate-on-401 branch cannot apply -
      // this IS the rotation. On a server its credential store is inert in any case, but stating it
      // makes the intent explicit rather than dependent on that.
      { anonymous: true },
    );
  } catch (cause) {
    // A rejection the service described - a refused or spent token. Its status is passed through, and
    // the cookie is cleared: it can never succeed again.
    if (isApiError(cause) && cause.status >= HTTP_BAD_REQUEST && cause.status < HTTP_BAD_GATEWAY) {
      return clearDurableCookie(
        NextResponse.json(
          { detail: 'The stored session could not be renewed. Sign in again to continue.' },
          { status: cause.status },
        ),
        request,
      );
    }

    // Anything else - unreachable, timed out, `5xx`, a malformed body - says nothing about the
    // credential, so it is KEPT and the caller is told the question could not be answered.
    return NextResponse.json(
      { detail: 'The session could not be renewed because the service could not be reached.' },
      { status: HTTP_BAD_GATEWAY },
    );
  }

  return writeDurableCookie(
    NextResponse.json(rotated, { status: HTTP_OK }),
    request,
    rotated.refresh_token,
  );
}

/**
 * Drop the durable credential.
 *
 * Called when the session ends locally - a sign-out, a refused rotation, a session that could not be
 * restored. Idempotent and unconditional: `204` whether or not a cookie was there, because "there is
 * no durable session" is the outcome either way and reporting the difference would tell a caller
 * something it has no use for.
 *
 * Revoking the token at the SERVICE is a separate act with a separate owner: `POST /auth/logout`,
 * issued by `@/lib/api/auth` from the document that is signing out. This route only forgets it.
 *
 * @param request - The incoming request, for the `secure` decision alone.
 * @returns `204`, with the cookie expired.
 */
export function DELETE(request: NextRequest): NextResponse {
  return clearDurableCookie(new NextResponse(null, { status: HTTP_NO_CONTENT }), request);
}
