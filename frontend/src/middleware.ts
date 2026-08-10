// Route protection for the authoring and administrative route groups.
//
// This file keeps a visitor with no session out of /dashboard, /posts and /admin,
// and a non-administrator out of /admin, before any component renders. It runs in
// the Edge runtime, on navigation, and decides purely from the incoming request.
//
// ---------------------------------------------------------------------------
// THIS IS NOT A SECURITY BOUNDARY. IT IS DEFENCE IN DEPTH.
//
// AAP 0.6.5 states it outright: "Route protection is defence in depth, not a
// substitute." What this file buys is that an anonymous visitor is sent to the
// sign-in form instead of loading a shell that renders and then fails every
// request it makes. It buys nothing else, and it MUST NOT be relied on for
// anything else.
//
// Authority is re-decided server-side on every single operation:
//
//   * `require_admin`, applied once on the /admin router include in
//     backend/app/api/v1/router.py, so no administrative route can omit it.
//   * Ownership assertions inside backend/app/services/post_service.py and
//     comment_service.py, so an author may act only on their own content.
//
// The API authenticates from the `Authorization` header alone and never reads a
// cookie. So the cookie this file inspects is script-writable and worth exactly
// nothing as proof: a visitor who edits it to say ADMIN buys a redirect that is
// not taken and an administrative screen whose every request is refused. That is
// the intended, harmless outcome - NOT a hole to be closed by hardening this
// file. Hardening belongs on the service, where it already is.
//
// The corollary matters just as much: DO NOT WEAKEN A SERVER-SIDE CHECK BECAUSE
// THIS FILE APPEARS TO HAVE ALREADY MADE IT. It has not.
//
// ---------------------------------------------------------------------------
// WHAT IS IN THE COOKIE - A ROLE LITERAL, AND EMPHATICALLY NOT A TOKEN
//
// The Edge runtime has no localStorage and no sessionStorage, and a module
// variable in the browser is not sent with a navigation, so the only thing this
// file can read is a cookie. That cookie carries the signed-in reader's ROLE
// literal - READER, AUTHOR or ADMIN, percent-encoded - and nothing else.
//
// It does NOT carry the access token, and adding one would be a real
// vulnerability rather than a convenience. A cookie written by client-side
// script cannot be HttpOnly - that flag exists precisely to hide a cookie from
// script - so a token placed there is published to every same-origin script the
// page will ever load and sent on every same-origin request (CWE-1004,
// CWE-922). src/providers/auth-provider.tsx and src/lib/api/client.ts both
// document this at length; the access token lives only in that client module's
// in-memory store.
//
// There IS a second cookie in this tier, and this file never reads it. The
// refresh credential that lets a new document recover a session is held in
// `blog_refresh`, written by src/app/api/session/route.ts on the SERVER, so it is
// HttpOnly and scoped to that route's own path - which means it is not sent with
// a navigation and is not visible here even in principle. That is the whole
// reason it is safe to keep, and the reason this file is unchanged by its
// existence: route protection still decides from a role literal that
// authenticates nothing.
//
// Two consequences for this file, both deliberate:
//
//   1. THERE IS NOTHING TO DECODE AND NO SIGNATURE TO VERIFY. No JWT parsing, no
//      base64 handling, no `atob`, no crypto import, and above all no signing
//      key - JWT_SECRET_KEY is a backend-only value and shipping it into a
//      browser bundle would be the vulnerability this design avoids. Reading a
//      role literal is the whole job.
//   2. THERE IS NO EXPIRY TO CHECK, so this file cannot sign anybody out. That
//      is the correct behaviour and not an omission, and it is what makes the
//      cross-document bootstrap possible at all. A visitor arriving on a fresh
//      document has NO credential in memory - a module variable dies with its
//      JavaScript context - and recovers one by asking
//      src/app/api/session/route.ts to rotate the HttpOnly refresh cookie it
//      owns; src/providers/auth-provider.tsx does that on mount, before it reads
//      GET /auth/me. Equally, a visitor whose access token has merely expired is
//      renewed by src/lib/api/client.ts's single-flight rotation on the first
//      401. Both recoveries happen INSIDE the route, so the route has to be
//      reachable: redirecting here on a marker whose credential this file cannot
//      see would sign out a reader who was never signed out. Nothing sensitive
//      renders in the meantime, because the service refuses a stale bearer
//      regardless.
//
//      The corollary is that the marker admitting a navigation is not a promise
//      that a session will be restored. It is a claim that one existed, and the
//      recovery either succeeds or ends the session and sends the reader to sign
//      in from inside the route. That is a redirect this file does not make and
//      must not try to.
//
// ---------------------------------------------------------------------------
// WHY THE COOKIE NAME IS RESTATED HERE, AND WHY THAT IS NOW DRIFT-PROOF
//
// Three files must agree on the name character for character:
// src/lib/api/client.ts declares the literal, src/providers/auth-provider.tsx
// writes and clears the cookie, and this file reads it. A mismatch fails
// SILENTLY - route protection simply never fires.
//
// The obvious fix, `import { AUTH_COOKIE_NAME } from '@/providers/auth-provider'`,
// is broken, and broken in the worst available way. That module carries the
// 'use client' directive, so when it is reached from the Edge runtime Next.js
// replaces every one of its exports with a client-reference proxy. The emitted
// middleware then calls `cookies.get(<proxy>)`, which matches no cookie ever -
// while `next build`, `tsc --noEmit` and `eslint` all pass. Verified against
// this exact toolchain: with that import in place the string 'blog_session'
// appears ZERO times in .next/server/edge/chunks, replaced by
// `registerClientReference(function(){ throw Error("Attempted to call
// AUTH_COOKIE_NAME() from the server...") })`. 'use client' is a boundary
// directive, not a statement about side effects, so no amount of tree-shaking
// helps. DO NOT REINSTATE THAT IMPORT.
//
// Restating the literal is therefore what its owner prescribes - client.ts says
// this file "necessarily restates the literal" - and the restatement is made
// safe by checking it against the single source of truth AT COMPILE TIME:
//
//   type SessionCookieName = typeof AuthProviderModule.AUTH_COOKIE_NAME;
//
// `import type` is erased entirely, so this costs no runtime import, pulls in no
// React, no zod and no HTTP module, and produces no client reference. But the
// declared type is the literal type of the real constant, so a drifted spelling
// is a compile error (TS2322) instead of a silent outage. The same technique
// makes the role table exhaustive: `Record<UserRole, ...>` fails to compile
// (TS2741) if a fourth role is ever added to the union without being handled
// here. Both were verified by deliberately breaking them.
//
// ---------------------------------------------------------------------------
// THE FILE NAME IS DELIBERATE. DO NOT RUN THE CODEMOD.
//
// Next.js 16.3 prints "The 'middleware' file convention is deprecated. Please
// use 'proxy' instead." and offers `npx @next/codemod middleware-to-proxy`. The
// build completes and the function is wired regardless - it is an advisory, not
// an error. This file stays at src/middleware.ts because the technical plan
// names that exact path (AAP 0.4.5.3, 0.7.1.7, 0.9.2) and because
// src/lib/api/client.ts, src/lib/types.ts, src/providers/auth-provider.tsx and
// eslint.config.mjs all name `src/middleware.ts` in the contracts they document.
// Renaming the file would silently invalidate all of them. If the convention is
// ever migrated, migrate those references in the same change.
//
// ---------------------------------------------------------------------------
// THE /login?next= CONTRACT, WHICH src/app/(auth)/login/page.tsx MUST HONOUR
//
// An unauthenticated visitor is sent to /login with the route they asked for
// preserved in a `next` parameter. The sign-in form owes two things in return:
// bounce back to that path once sign-in succeeds, and default to '/' when the
// parameter is missing. It must ALSO reject anything that is not a same-origin
// relative path - a value beginning with a scheme, with '//', or with a
// backslash - or the parameter becomes an open redirect. This file only ever
// writes a path taken from the request it is already serving, so the danger is
// entirely on the reading side.
//
// ---------------------------------------------------------------------------
// GOVERNING STANDARDS
//
// `review_rules` reports NO user-specified rules for this project, so nothing
// here is invented to satisfy one - and their absence is not licence to lower
// the bar. The binding constraints are AAP 0.10.1's own enterprise standards,
// five of which govern this file:
//
//   Configuration from the environment only  This file reads NO environment
//       variable and hard-codes no origin. Every redirect is built by cloning
//       `request.nextUrl`, so it is correct on any host, port or scheme.
//   No secrets in the repository             No signing key, no credential, no
//       crypto import, and no token value is read, logged or thrown.
//   Secure-by-default authentication        No signature is verified, because
//       verifying one here would require the backend's key. The role is treated
//       as a hint about what to SHOW, never as authority.
//   Layered separation of concerns          Zero HTTP: no `fetch`, no backend
//       call, and no import from @/lib/api/*. The decision uses only the
//       incoming request.
//   Blocking quality gates                  Explicit return type on every
//       function, no `any`, no unused import, and a return type that makes
//       falling off the end of the function a compile error.
//
// AAP 0.8.5 design-system compliance is vacuous here: this file renders no
// markup, imports no component and declares no CSS value.
//
// ---------------------------------------------------------------------------
// DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT HERE.
//
//   1. Static-asset or _next exclusion logic in the function body. The matcher
//      names three route families explicitly, so this code never runs for '/',
//      /blog/*, /u/*, /login, /signup, /sitemap.xml, /robots.txt or /_next/*.
//      A body guard would be dead code.
//   2. A catch-all negative-lookahead matcher such as '/((?!_next|api|.*\\..*).*)'.
//      It would run this function for every public route to reach three.
//   3. Any matcher entry naming a route GROUP. '(dashboard)' and '(admin)' are
//      organisational only and never appear in a URL: the group directories
//      render /dashboard, /posts/new, /posts/<id>/edit and /admin/*. Matching on
//      a parenthesised name would match nothing at all.
//   4. A guard on /blog/*. Public post pages live there and must stay reachable
//      by anyone, including a crawler. /posts/* is the authoring surface and is
//      a different, non-overlapping family.
//   5. A role check on /dashboard or /posts. Any signed-in reader may open the
//      authoring surface; which posts they may actually change is per-post
//      ownership, which only the service can decide.
//   6. Rewrites, response headers, cookie writes or logging. The cookie belongs
//      to auth-provider.tsx, response headers to the API's own middleware, and a
//      log line here would run on every protected navigation while being able to
//      report only what the visitor already knows.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import type { UserRole } from '@/lib/types';
import type * as AuthProviderModule from '@/providers/auth-provider';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The literal type of the real cookie-name constant, reached without importing
 * its value.
 *
 * `import type` is erased at compile time, so this creates no runtime edge
 * between this file and a `'use client'` module - see the header for why a value
 * import of the same binding is silently broken.
 */
type SessionCookieName = typeof AuthProviderModule.AUTH_COOKIE_NAME;

/**
 * Name of the cookie that says "a session exists, and it claims this role".
 *
 * Annotated with {@link SessionCookieName} rather than inferred, which is the
 * whole point: if the literal in `src/lib/api/client.ts` is ever changed, this
 * assignment stops compiling instead of quietly disabling route protection.
 */
export const AUTH_COOKIE_NAME: SessionCookieName = 'blog_session';

/**
 * Every role literal the session marker may legitimately carry.
 *
 * Declared as `Record<UserRole, UserRole>` so the compiler REQUIRES one entry
 * per member of the union. A role added to `UserRole` in `@/lib/types` without a
 * decision being made here is a build failure, not an unhandled value that
 * degrades to "anonymous" and locks a new kind of account out of the dashboard.
 */
const ROLE_LITERALS: Readonly<Record<UserRole, UserRole>> = {
  READER: 'READER',
  AUTHOR: 'AUTHOR',
  ADMIN: 'ADMIN',
};

/**
 * The same literals as a lookup keyed by arbitrary string.
 *
 * A `Map` rather than a plain-object membership test on purpose. The marker is
 * script-writable, so its value is attacker-chosen: `constructor`, `toString`
 * and `__proto__` all answer truthily to the `in` operator on an object literal
 * because it walks the prototype chain. A `Map` has no prototype keys, so those
 * values resolve to `undefined` and degrade to "anonymous" like any other
 * unrecognised string.
 */
const ROLE_BY_MARKER_VALUE: ReadonlyMap<string, UserRole> = new Map(Object.entries(ROLE_LITERALS));

/** The only role admitted to the administrative route group. */
const ADMIN_ROLE: UserRole = ROLE_LITERALS.ADMIN;

/** Where a visitor with no usable session is sent. */
const LOGIN_PATH = '/login';

/** Where a signed-in non-administrator is sent from an administrative route. */
const HOME_PATH = '/';

/** Query parameter carrying the route the visitor originally asked for. */
const RETURN_TO_PARAM = 'next';

/** First segment of the administrative route group's URLs. */
const ADMIN_PATH_PREFIX = '/admin';

/* -------------------------------------------------------------------------- */
/* Reading the session marker                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The role the request claims, or `null` when it claims none usably.
 *
 * `null` is the ordinary anonymous answer rather than an error, and every
 * unusable shape resolves to it: no such cookie, an emptied cookie the browser
 * has not dropped yet (which is exactly what signing out leaves behind), a value
 * whose percent-encoding will not decode, or a value that is not one of the
 * three role literals.
 *
 * The classification is deliberately identical to `readSessionMarker` in
 * `src/providers/auth-provider.tsx`. If the two disagreed, a visitor could be
 * admitted here and presented as anonymous by the very shell that just rendered.
 *
 * **This function cannot throw**, which is the property that matters most.
 * `decodeURIComponent` throws on a malformed escape such as `%`, and an
 * exception raised in middleware becomes a 500 on every protected route rather
 * than a redirect - turning a junk cookie into an outage.
 *
 * @param request - The incoming request, whose parsed cookie jar is used rather
 *   than the raw `Cookie` header.
 * @returns The claimed role, or `null`. Never a value outside `UserRole`.
 */
function readSessionRole(request: NextRequest): UserRole | null {
  const encoded = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (encoded === undefined || encoded === '') {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }

  return ROLE_BY_MARKER_VALUE.get(decoded) ?? null;
}

/**
 * Whether a path belongs to the administrative route group.
 *
 * Matched as a whole first segment - `/admin` itself, or something beneath
 * `/admin/` - rather than as a bare prefix. A `startsWith('/admin')` test would
 * also claim a future `/administrators` route and gate it by accident.
 *
 * @param pathname - `request.nextUrl.pathname`, already normalised by the
 *   framework for RSC and data requests.
 * @returns `true` for `/admin` and any descendant.
 */
function isAdministrativePath(pathname: string): boolean {
  return pathname === ADMIN_PATH_PREFIX || pathname.startsWith(`${ADMIN_PATH_PREFIX}/`);
}

/* -------------------------------------------------------------------------- */
/* Redirects                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Send an unauthenticated visitor to sign in, remembering where they were going.
 *
 * The target is built by cloning the incoming URL, so the redirect inherits the
 * request's own scheme, host and port and stays correct behind a proxy, on a
 * preview host and in the end-to-end run - none of which a hard-coded origin or
 * an environment variable would survive.
 *
 * The protected route's own query string is folded into the `next` value and
 * then cleared, so a `?page=2` on the original route cannot collide with the
 * sign-in form's own parameters. `URLSearchParams` applies the escaping, which
 * is why `/dashboard` arrives as `next=%2Fdashboard`.
 *
 * @param request - The request being refused.
 * @returns A redirect to {@link LOGIN_PATH} carrying {@link RETURN_TO_PARAM}.
 */
function redirectToLogin(request: NextRequest): NextResponse {
  const returnTo = `${request.nextUrl.pathname}${request.nextUrl.search}`;

  const target = request.nextUrl.clone();
  target.pathname = LOGIN_PATH;
  target.search = '';
  target.searchParams.set(RETURN_TO_PARAM, returnTo);

  return NextResponse.redirect(target);
}

/**
 * Send a signed-in visitor who may not be here back to the feed.
 *
 * No `next` parameter is attached, and that is the difference from
 * {@link redirectToLogin}: this visitor is already signed in, so there is
 * nothing for them to do that would make the administrative route work. Offering
 * to return would invite them to sign in again to no effect.
 *
 * @param request - The request being refused.
 * @returns A redirect to {@link HOME_PATH} on the request's own origin.
 */
function redirectToHome(request: NextRequest): NextResponse {
  const target = request.nextUrl.clone();
  target.pathname = HOME_PATH;
  target.search = '';

  return NextResponse.redirect(target);
}

/* -------------------------------------------------------------------------- */
/* The gate                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Decide whether a request for a protected route may proceed.
 *
 * Two independent questions, asked in this order because the second is only
 * meaningful once the first has an answer:
 *
 *   1. Is there a session at all? No usable marker means sign in first,
 *      whichever route was asked for.
 *   2. Is this the administrative group, and is the claimed role `ADMIN`?
 *      `READER` and `AUTHOR` are sent to the feed. Any signed-in role may use
 *      /dashboard and /posts, where per-post ownership - not role - decides what
 *      may actually be changed, and only the service can decide that.
 *
 * The declared `NextResponse` return type is load-bearing: it makes an
 * unhandled path a compile error rather than an implicit `undefined` that the
 * framework would read as "continue".
 *
 * Exported by name rather than as a default export, which is the framework's
 * documented convention and also keeps `import/no-anonymous-default-export`
 * quiet under `eslint --max-warnings=0`.
 *
 * @param request - The incoming request, already narrowed to {@link config}'s
 *   three route families.
 * @returns A redirect, or `NextResponse.next()` to let the request through.
 */
export function middleware(request: NextRequest): NextResponse {
  const claimedRole = readSessionRole(request);

  if (claimedRole === null) {
    return redirectToLogin(request);
  }

  if (claimedRole !== ADMIN_ROLE && isAdministrativePath(request.nextUrl.pathname)) {
    return redirectToHome(request);
  }

  return NextResponse.next();
}

/**
 * The three route families this file gates, and nothing else.
 *
 * `:path*` is zero-or-more segments, so each entry covers the bare path as well
 * as everything beneath it - `/dashboard` and `/dashboard/anything`, `/admin`
 * and `/admin/users`. Confirmed against the compiled matcher in
 * `.next/server/middleware-manifest.json`, where the sub-path group is emitted
 * as optional, and again by request at run time.
 *
 * The families are URLs, not directories. `src/app/(dashboard)/` and
 * `src/app/(admin)/` are route groups whose parenthesised names are erased from
 * the URL, which is why '/posts/:path*' is here: `(dashboard)/posts/new/` serves
 * /posts/new. Public post pages are at /blog/[slug] and are deliberately not
 * matched.
 *
 * Keep this list in step with the disallow rules in `src/app/robots.ts`: a route
 * worth gating from a visitor is a route worth keeping out of the index.
 */
export const config = {
  matcher: ['/dashboard/:path*', '/posts/:path*', '/admin/:path*'],
};
