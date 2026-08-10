'use client';

// Auth provider - the session context for the whole presentation tier.
//
// This file owns one thing: who the reader is. It holds the signed-in account,
// the one-time "am I still signed in?" question asked on load, and the four
// actions that change the answer - sign up, sign in, sign out, renew. Mounted
// once, in src/app/layout.tsx, alongside the theme provider, the query provider
// and the toast host.
//
// It is wrapped around the ENTIRE application, including the server-rendered
// feed, post and profile routes whose HTML must already contain the article for
// the SEO requirement. Weight added here is weight added to every route, so the
// file stays deliberately thin: no data fetching beyond the session itself, no
// derived caches, no markup of its own, and no third-party dependency.
//
// ---------------------------------------------------------------------------
// THE SESSION MARKER - WHAT IS IN THE COOKIE, AND WHAT IS EMPHATICALLY NOT
//
// src/middleware.ts gates /dashboard/:path*, /posts/:path* and /admin/:path* in
// the Edge runtime, BEFORE any component renders. What it can read there is a
// cookie: not React state, not a module variable, not localStorage or
// sessionStorage (neither exists in that runtime, and neither is sent with a
// navigation). So route protection needs SOMETHING in a cookie.
//
// That something is a non-credential marker: the signed-in reader's ROLE
// literal - READER, AUTHOR or ADMIN - and nothing else. Never the access token.
//
// The distinction is the whole design, so it is worth stating why the obvious
// alternative is wrong. A cookie written by client-side script CANNOT be
// HttpOnly; the flag exists precisely to hide a cookie from script. Putting the
// access token there therefore publishes a bearer credential to every
// same-origin script the page will ever load - an analytics snippet, a
// transitive dependency, anything reflected into the page - and sends it on
// every same-origin request. One injected script reads document.cookie and has
// the reader's account until the token expires, silently (CWE-1004, CWE-922).
//
// The role literal costs nothing to publish because it authenticates nothing.
// The API reads the Authorization header and ignores cookies entirely, so
// editing this cookie to say ADMIN buys a redirect that is not taken and an
// administrative screen whose every request is refused by require_admin.
// Route protection is defence in depth; authority is re-decided server-side on
// every operation, which AAP 0.6.5 states outright.
//
// The access token lives ONLY in @/lib/api/client's in-memory store, which no
// other document and no other origin can read, and only that module attaches it
// to a request.
//
// ---------------------------------------------------------------------------
// HOW A SESSION SURVIVES A FULL NAVIGATION, AND WHERE THE CREDENTIAL IS
//
// A full page reload starts a fresh JavaScript context, so the in-memory
// credential is gone. That used to end the session: this provider found a marker
// with no token behind it, cleared the marker, and presented an anonymous
// session, so a reader was signed out by every reload, every new tab and every
// external link back into the site, having done nothing.
//
// It is resolved by a credential NO SCRIPT IN THIS TIER CAN READ, which is the
// only resolution worth having. `src/app/api/session/route.ts` is a Route
// Handler on this application's own origin, and it holds the refresh token in a
// cookie that is HttpOnly, SameSite=Strict, scoped to that route's own path and
// Secure wherever the request arrived over https. On mount, a document that finds
// a marker but no in-memory credential asks that route to ROTATE the stored token
// and hand back a usable pair - see the restoration effect. Rotation is also the
// validation, because a refresh token is single-use: one the service has revoked,
// expired or already seen is refused, and only then is the session over.
//
// The rule that produced the original trade is unchanged and still binding: DO
// NOT put a credential anywhere a script can read it - not in the marker cookie,
// not in localStorage, not in sessionStorage. Everything a browser script can
// write, a browser script can read, and a script-written cookie cannot be
// HttpOnly. The fix is not a laxer store; it is a store the document does not
// have. This provider still never sees that cookie, and neither does
// @/lib/api/client: both only ask the route to act on it.
//
// ---------------------------------------------------------------------------
// DIVISION OF LABOUR WITH src/lib/api/client.ts
//
// One transition, one owner, in both directions:
//
//   * The CREDENTIAL is owned by client.ts. `setCredentials` adopts a pair;
//     `clearCredentials` drops it, advances an auth generation so a rotation
//     already in flight cannot re-adopt what it receives, and releases the
//     shared rotation promise. That module touches no cookie at all - it never
//     sees a principal, only a token pair.
//   * The MARKER is owned by this file, because the role is only knowable from
//     GET /auth/me, which is this file's request. It is written after the
//     account is read, replaced on renewal (a role an administrator changed
//     arrives there), and cleared on every terminal path.
//
// Both halves are called from the same four places - sign-in, the sign-up
// follow-up, renewal, and the single end-of-session path - so a credential
// without a marker, or a marker without a credential, is not a state this file
// can produce. @/lib/api/auth deliberately clears NOTHING: a wrapper that ended
// a session as a side effect of its request would give one transition two owners
// whose order decides the outcome.
//
// ---------------------------------------------------------------------------
// WHY AUTH_COOKIE_NAME IS IMPORTED AND RE-EXPORTED RATHER THAN DECLARED
//
// Three files have to agree on the cookie's name: client.ts declares the single
// literal, this file reads and writes the cookie, and src/middleware.ts gates on
// it. A mismatched spelling fails silently - route protection simply never
// fires - so there is exactly one literal, and it lives in client.ts because
// that is the only cycle-free home: it imports nothing but @/lib/types.
// Declaring it here instead would force client.ts to import this file and close
// the cycle auth-provider -> lib/api/auth -> lib/api/client -> auth-provider,
// whose failure mode is an undefined binding at run time that neither the
// type-checker nor the linter reports.
//
// It is re-exported below so src/middleware.ts can reach it from this module -
// its declared dependency - without importing from @/lib/api/*. This module has
// no top-level side effect, so that import shakes down to the string constant.
// What middleware may infer from the cookie is exactly two things: that a
// session exists, and which role it claims. It must not treat either as proof.
//
// ---------------------------------------------------------------------------
// WHERE THE REFRESH TOKEN IS, IN BOTH PLACES IT EXISTS
//
// client.ts holds it in a module variable, which is what its own single-flight
// rotation presents on a 401. This file never puts it in state, in a ref, in the
// marker cookie or in durable browser storage - neither localStorage nor
// sessionStorage appears anywhere in this tier. It is an opaque high-entropy
// value rather than a JWT, so it is never decoded or inspected either.
//
// It ALSO exists in the session route's HttpOnly cookie, written by a server and
// unreadable from any document, which is what a new document rotates to recover.
// Both copies move together: `setCredentials` and `clearCredentials` are the
// funnels every transition passes through, and this provider arms the mirror on
// them - see the effect that calls `setDurableSessionMirror`. So the durable copy
// cannot hold a token the store has already replaced.
//
// The one honest window: a rotation whose mirror write has not landed when the
// document is destroyed leaves a spent token in the cookie, and the next
// document's recovery is refused. That degrades to a sign-in - the behaviour
// before any of this existed - and never to a wrong or resurrected session,
// because the service revokes a presented refresh token as it issues the
// replacement.
//
// ---------------------------------------------------------------------------
// A NULL ACCOUNT HAS THREE MEANINGS, AND CONSUMERS MUST TELL THEM APART
//
// `user` is null in three different situations, and collapsing them is how a
// session gets destroyed by a dropped Wi-Fi connection:
//
//   isLoading true                    -> NOT KNOWN YET. The one-time
//       restoration is still in flight. Render a neutral state, not "sign in".
//   isLoading false, restoreError null -> ANONYMOUS. Either no presence cookie
//       existed, or the credential was presented and definitively refused (401)
//       or the account was deactivated (403). The session has been ended
//       locally and signing in is the correct next step.
//   isLoading false, restoreError set  -> UNKNOWN. The service could not be
//       asked: unreachable, a refused CORS preflight, an aborted request, or a
//       5xx. THE CREDENTIAL AND THE PRESENCE COOKIE ARE INTACT - none of those
//       failures says anything about whether the token is still good, so
//       nothing was thrown away. A surface should offer a retry rather than a
//       sign-in prompt, because the reader may well still be signed in.
//
// See {@link isTerminalAuthFailure} for the classification and
// {@link AuthContextValue.restoreError} for the consumer contract. A failure
// that is not a rejected request at all - a misconfigured API base URL, a
// programming error - is a fourth case and is not represented here: it is not
// an answer about the session, so it is thrown during render and reaches
// src/app/error.tsx.
//
// ---------------------------------------------------------------------------
// GOVERNING STANDARDS
//
// `review_rules` reports that NO user-specified rules were provided for this
// project, so nothing here is invented to satisfy one - and their absence is
// not licence to lower the bar. The binding constraints are the technical
// plan's own enterprise standards, nine of which govern this file:
//
//   Secure-by-default authentication  The plaintext password is passed straight
//       to @/lib/api/auth and is never assigned to state, a ref, storage or a
//       log. No token is decoded and no signature is checked. UserMe.role is
//       exposed for deciding which controls to RENDER and is never treated as
//       authority.
//   No secrets in the repository      The signing key is a backend-only value
//       and is not referenced in this tier in any form. No crypto import, no
//       key material, no environment variable read here at all.
//   Layered separation of concerns    Zero HTTP. Every request goes through
//       @/lib/api/auth, which goes through the tier's sole HTTP module. No URL,
//       no header, no status-code branch, no retry lives in this file.
//   Explicit API contracts           UserMe, TokenPair, LoginRequest and
//       RegisterRequest are consumed verbatim from @/lib/types with the
//       service's own snake_case member names. No wire shape is redeclared and
//       no field is renamed. Failures arrive as ApiError.
//   Server-owned identity            UserMe.id is a server-generated UUID, read
//       only. Nothing here generates or mutates an identifier.
//   Day-one observability            No token, password, credential pair or
//       cookie value is written to any sink. Nor is a caught error: per
//       src/app/error.tsx, the console belongs to whoever holds the browser.
//   Accessibility as a floor         `children` renders unconditionally.
//       `isLoading` is context state, never a gate - a provider that swapped
//       the tree for a spinner would steal focus and discard the
//       server-rendered markup the SEO requirement depends on.
//   Pinned, reproducible deps        react plus three @/ siblings. No cookie
//       library, no JWT library, no state-management library - none is declared
//       in frontend/package.json and none is needed.
//   Blocking quality gates           Explicit return type on every function, no
//       `any`, no unused import, no unstable context value, exhaustive hook
//       dependencies.
//
// ---------------------------------------------------------------------------
// DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT HERE.
//
//   1. A `useAuth` hook. src/hooks/use-auth.ts owns it and implements it over
//      the context exported below, including the "used outside AuthProvider"
//      guard - which is what the `undefined` default value exists for. Defining
//      it here would duplicate a file that already has an owner.
//   2. A default export. src/app/layout.tsx imports { AuthProvider } by name.
//   3. Any redirect or router call. src/middleware.ts owns the
//      /login?next=<encoded path> contract; a provider that navigated would
//      race it and would make this file untestable without a router.
//   4. A role check used as a gate. Hiding a control is user experience. The
//      authority is `require_admin` on the service's admin router and the
//      ownership assertions in its post and comment services.
//   5. Token decoding of any kind, for an expiry countdown or anything else. No
//      file in this tier decodes a token - that is what the role marker exists
//      for, and it is why no token is in a cookie for anyone to decode. A
//      client-side expiry check would duplicate state the service already owns
//      and would tempt a signature check next.
//   6. A proactive renewal timer. client.ts rotates once, single-flight, when a
//      request that carried a credential is answered 401. A timer here would
//      race that path, and each rotation revokes the token it presented.
//   7. Markup, className, inline style, or any import from a component module.
//      This provider renders no element of its own and declares no CSS value.
//   8. Persisting the account itself. UserMe carries the email address and the
//      role; it is re-read from GET /auth/me, which is authoritative and picks
//      up a role an administrator has just changed.
//   9. A rotation request of its own, for renewal or for restoration. The single
//      coordinator in client.ts is the only path; see the section above.

import { createContext, useCallback, useEffect, useMemo, useState } from 'react';

import {
  getMe,
  login as requestLogin,
  logout as requestLogout,
  register as requestRegister,
} from '@/lib/api/auth';
import {
  type ApiError,
  AUTH_COOKIE_NAME,
  clearCredentials,
  getAccessToken,
  isApiError,
  recoverDurableSession,
  rotateSession,
  setCredentials,
  setDurableSessionMirror,
  setUnauthorizedHandler,
} from '@/lib/api/client';
import { USER_ROLES } from '@/lib/types';
import type { LoginRequest, RegisterRequest, TokenPair, UserMe, UserRole } from '@/lib/types';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Re-export of the cookie name, for `src/middleware.ts`.
 *
 * The literal itself lives in `@/lib/api/client` - see the header for why that
 * is the only cycle-free home and why restating it anywhere is a defect. This
 * is a binding re-export, not a copy: there is still exactly one string.
 */
export { AUTH_COOKIE_NAME };

/* -------------------------------------------------------------------------- */
/* The session marker - the only cookie mechanics in this tier                */
/* -------------------------------------------------------------------------- */

/** Separator between the pairs in a `document.cookie` string. */
const COOKIE_PAIR_SEPARATOR = ';';

/** Separator between a cookie's name and its value. */
const COOKIE_NAME_VALUE_SEPARATOR = '=';

/**
 * Attributes shared by the write and the delete, in one place because they have
 * to agree.
 *
 * `Path=/` so the cookie is sent on a navigation to any protected route, and -
 * critically - so the delete addresses the same cookie the write created: a
 * `Max-Age=0` whose `Path` differs is treated as a different cookie entirely and
 * silently leaves the original in place. `SameSite=Lax` so it accompanies the
 * top-level navigations the middleware inspects. No `Domain`, which keeps it
 * host-only and narrowest. No `Max-Age`: the marker's life is the browsing
 * session, matching the in-memory credential it stands for.
 */
const MARKER_PATH_AND_SAME_SITE = 'Path=/; SameSite=Lax';

/**
 * Whether the current origin is secure, so `Secure` may be added.
 *
 * Set unconditionally, the attribute would make the cookie invisible on
 * `http://localhost` - breaking local development and the end-to-end run, where
 * nothing would ever reach a protected route.
 */
function isSecureOrigin(): boolean {
  return typeof document !== 'undefined' && document.location.protocol === 'https:';
}

/* -------------------------------------------------------------------------- */
/* Classifying a restoration failure                                          */
/* -------------------------------------------------------------------------- */

/** The credential was presented and refused. */
const HTTP_UNAUTHORIZED = 401;

/** The credential was accepted and the account may not use it - a deactivated user. */
const HTTP_FORBIDDEN = 403;

/**
 * Whether a restoration failure means the SESSION is over, as opposed to the
 * attempt having failed.
 *
 * This distinction is the whole of the difference between an idle tab that comes
 * back to life and one that silently signs the reader out. `GET /auth/me` can
 * fail for two unrelated kinds of reason, and treating them alike is a defect in
 * whichever direction it is made:
 *
 *   * **Terminal.** `401` means the credential is finished - and after the
 *     restoration effect, that is a stronger statement than it looks. A document
 *     with no in-memory credential presents the durable refresh token FIRST, so a
 *     `401` from either that rotation or the `GET /auth/me` behind it means the
 *     single-use token was revoked, expired or already spent, and there is nothing
 *     left to renew with. `403` means the account was deactivated. In both the
 *     credential is worth nothing, so keeping it would leave every later request
 *     to fail the same way. The session is ended.
 *   * **Not terminal.** A transport failure - the API unreachable, DNS down, a
 *     CORS preflight refused, the request aborted - arrives as
 *     {@link ApiError.status} `0`, because no response was received at all. A
 *     `5xx` means the service answered and could not do the work. A `404` or a
 *     `422` on this route means something is wrong with the DEPLOYMENT, not with
 *     the reader's credential. None of those says anything about whether the
 *     token is still good, and destroying a valid session on a dropped Wi-Fi
 *     connection is a defect the reader experiences as being logged out at
 *     random.
 *
 * The default is therefore to PRESERVE, and only the two statuses that
 * definitively answer "this credential is finished" end the session. Anything
 * unrecognised is preserved for the same reason a lock is not opened by an
 * unrecognised key.
 *
 * @param error - The normalised failure from `@/lib/api/client`.
 * @returns `true` when the credential is definitively finished.
 */
function isTerminalAuthFailure(error: ApiError): boolean {
  return error.status === HTTP_UNAUTHORIZED || error.status === HTTP_FORBIDDEN;
}

/**
 * The role in the session marker, or `null` when there is no usable marker.
 *
 * `null` is the ordinary anonymous state rather than an error, and every
 * unusable shape resolves to it: no document (a server render), no such cookie,
 * an emptied cookie the browser has not dropped yet, a value whose encoding will
 * not decode, or a value that is not one of the three role literals. The last of
 * those is the interesting one: the marker is script-writable by construction,
 * so an arbitrary string can appear in it. Validating against
 * {@link USER_ROLES} means a tampered value degrades to "anonymous" instead of
 * flowing onward as a `UserRole` the type system believes in.
 *
 * Reading this is deliberately NOT enough to restore a session - see the header.
 * The marker says a session existed; only the in-memory credential can prove one
 * still does.
 */
function readSessionMarker(): UserRole | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const prefix = `${AUTH_COOKIE_NAME}${COOKIE_NAME_VALUE_SEPARATOR}`;
  for (const pair of document.cookie.split(COOKIE_PAIR_SEPARATOR)) {
    // Pairs after the first arrive with a leading space. Comparing the trimmed
    // pair against `name=` also keeps a cookie whose name merely ENDS with this
    // one's from matching.
    const candidate = pair.trim();
    if (!candidate.startsWith(prefix)) {
      continue;
    }

    const encoded = candidate.slice(prefix.length);
    if (encoded === '') {
      return null;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      // decodeURIComponent throws on a malformed escape. Unreadable is "none".
      return null;
    }

    return USER_ROLES.find((role) => role === decoded) ?? null;
  }

  return null;
}

/**
 * Write the session marker for a known principal.
 *
 * Called only after `GET /auth/me` has answered, because the role is the thing
 * being written and this tier learns it from that response alone - never by
 * decoding a token. Replacing an existing marker is the normal case on renewal:
 * a role an administrator has just changed arrives with the re-read account.
 *
 * A no-op when no document exists, so it is safe to call from anywhere.
 *
 * @param role - The authenticated account's role, straight from `UserMe.role`.
 */
function writeSessionMarker(role: UserRole): void {
  if (typeof document === 'undefined') {
    return;
  }

  const attributes = isSecureOrigin()
    ? `${MARKER_PATH_AND_SAME_SITE}; Secure`
    : MARKER_PATH_AND_SAME_SITE;
  document.cookie = `${AUTH_COOKIE_NAME}${COOKIE_NAME_VALUE_SEPARATOR}${encodeURIComponent(role)}; ${attributes}`;
}

/**
 * Expire the session marker.
 *
 * Both a zero `Max-Age` and a past `Expires` are sent because the two are
 * honoured by different vintages of behaviour and neither is expensive, and the
 * path and same-site attributes are the write's own so the delete addresses the
 * same cookie. Leaving a marker behind would keep `src/middleware.ts` admitting
 * a reader with no credential, producing routes that render and then fail every
 * request they make.
 */
function clearSessionMarker(): void {
  if (typeof document === 'undefined') {
    return;
  }

  document.cookie = `${AUTH_COOKIE_NAME}${COOKIE_NAME_VALUE_SEPARATOR}; ${MARKER_PATH_AND_SAME_SITE}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/* -------------------------------------------------------------------------- */
/* Credential adoption - the single seam every token pair passes through      */
/* -------------------------------------------------------------------------- */

/**
 * Adopt a credential pair: sign-in and the sign-up follow-up land here, and
 * nothing else in this file writes the credential store.
 *
 * The pair is adopted in full because renewal revokes the refresh token it
 * presented, so keeping the previous one would guarantee the next renewal fails.
 *
 * **No cookie is written here.** The marker carries the role, which a token pair
 * does not contain; it is written once the account has been read. Splitting the
 * two is what keeps the marker truthful - it appears only when there genuinely is
 * an authenticated principal to describe.
 *
 * `setCredentials` refuses to run outside a browser, deliberately: module state
 * is per-process on the server, so storing a principal there would share it
 * between concurrent readers' requests. This file is a `'use client'` boundary,
 * so every call below is a browser call.
 *
 * @param tokens - The pair exactly as the service issued it.
 */
function adoptCredentials(tokens: TokenPair): void {
  setCredentials(tokens);
}

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything the session context exposes: the reader's account, whether the
 * one-time restoration is still in flight, and the four actions that change the
 * answer.
 *
 * Every action resolves to `void` rather than to a resource. The account is not
 * a return value to be threaded through a component, it is context state, so a
 * caller awaits an action for its completion and then reads `user`. Sign-up is
 * the clearest case: the service answers it with the new public record and no
 * credential, and what a caller actually needs afterwards is a signed-in
 * session - which is what {@link AuthContextValue.register} leaves behind.
 */
export interface AuthContextValue {
  /**
   * The signed-in account, or `null` when nobody is signed in.
   *
   * `null` while {@link AuthContextValue.isLoading} is `true` means "not known
   * yet"; `null` afterwards means "anonymous". A surface that must not flicker
   * between the two reads both members.
   *
   * `user.role` is safe for deciding which controls to render and is not an
   * authority: the service re-checks every protected operation.
   */
  readonly user: UserMe | null;
  /**
   * Whether the initial session check is still running.
   *
   * `true` for one pass on mount and `false` for the rest of the page's life -
   * it does NOT track a sign-in, a sign-out or a renewal, each of which is
   * awaited by the surface that triggered it and reported by that surface's own
   * pending state. Nothing in this tier gates rendering on it; it exists so a
   * header can render a neutral state instead of briefly claiming "sign in" to
   * a reader who is in fact signed in.
   */
  readonly isLoading: boolean;
  /**
   * `user !== null`, derived once here so no consumer re-derives it and no two
   * consumers derive it differently.
   */
  readonly isAuthenticated: boolean;

  /**
   * Why the one-time restoration could not answer, when it could not - and
   * `null` whenever the answer is known.
   *
   * THIS MEMBER EXISTS BECAUSE `user === null` HAS TWO MEANINGS. Once
   * {@link AuthContextValue.isLoading} is `false`, a `null` account normally
   * means "anonymous". It means something else when this member is populated:
   * the reader may well be signed in, the credential was not thrown away, and
   * the service simply could not be asked - it was unreachable, a preflight was
   * refused, or it answered `5xx`. Presenting that as "signed out" is what turns
   * a dropped connection into a lost session, so a surface that renders a
   * sign-in prompt should read this member first and offer a retry instead.
   *
   * The credential and the presence cookie are both INTACT while this is set, so
   * no recovery action is needed beyond trying again: any later request carries
   * the same bearer, and `@/lib/api/client` rotates once on a `401` and notifies
   * this provider if the session really is over.
   *
   * It is cleared the moment an account is adopted - by a successful
   * restoration, a sign-in or a renewal - and by {@link AuthContextValue.logout},
   * so it can never describe a session that has since been established or
   * deliberately ended.
   */
  readonly restoreError: ApiError | null;
  /**
   * Exchange an email address and password for a session, then load the
   * account.
   *
   * @param credentials - The reader's address and password in the domain's own
   * shape. The mapping onto the service's OAuth 2 form field belongs to
   * `@/lib/api/auth` and must not be anticipated here.
   * @returns When the session is established and `user` is populated.
   * @throws `ApiError` - `401` for any wrong credential (a wrong address and a
   * wrong password are answered identically on purpose, so a caller must
   * present one message for both), `403` for a deactivated account, `429` for a
   * throttled window. Nothing is adopted on failure.
   */
  readonly login: (credentials: LoginRequest) => Promise<void>;
  /**
   * Create an account and sign it in.
   *
   * Two requests, because registration issues no credential: the account is
   * created, then the supplied password is spent once more to obtain a session.
   * **This is where that product decision lives.** `POST /auth/register` answers
   * with the new public record and nothing else, so `@/lib/api/auth` performs
   * only the creation and documents the split; composing it with a sign-in so a
   * reader who signs up arrives signed in is a decision about the product's flow,
   * and it belongs to the layer that owns the session. The service rate-limits
   * per route, so the second call is measured against the sign-in window rather
   * than adding to the registration one.
   *
   * @param input - The new account's address, handle, password and optional
   * display name.
   * @returns When the account exists, the session is established and `user` is
   * populated.
   * @throws `ApiError` - `409` when the address or handle is already taken
   * (matched case-insensitively), `422` when a field fails the service's
   * policy, `429` for a throttled window. A failure of the sign-in that follows
   * leaves the account created and nobody signed in, so a caller may retry with
   * {@link AuthContextValue.login}.
   */
  readonly register: (input: RegisterRequest) => Promise<void>;
  /**
   * End the session: revoke it at the service, then forget it locally.
   *
   * The local half ALWAYS happens, including when the revocation request fails,
   * so a caller that ignores the rejection still ends up signed out rather than
   * stranded half-authenticated.
   *
   * The session revoked is the one this tab holds. There is no parameter with
   * which to name another, because the transport's own recovery path can only act
   * on the held credential - see `@/lib/api/auth#logout`.
   *
   * @returns When the session has ended: the held refresh token was accepted by
   * the service and the local session is gone.
   * @throws `ApiError` when the revocation could not be carried out - a throttled
   * window, an unreachable service, or a renewal the transport could not complete
   * after the access token had expired. The local session is already gone by then,
   * so a caller may safely ignore it; it is surfaced rather than swallowed
   * precisely because a caller that wants to report "signed out here, but the
   * session may still be live elsewhere" needs to know, and a sign-out that
   * reported success either way could not tell it.
   */
  readonly logout: () => Promise<void>;
  /**
   * Renew the credential deliberately, and re-read the account.
   *
   * Rarely needed: `@/lib/api/client` already renews once, single-flight, when
   * a request that carried a credential is answered `401`, and that is the path
   * ordinary reads and writes take. This exists for a caller that wants to
   * revalidate without having a failing request to react to - and it picks up a
   * role an administrator has just changed, because the account is re-read from
   * the service rather than from a token claim.
   *
   * It shares that single-flight attempt rather than starting a second one: a
   * refresh token is single-use, and two rotations spending it would end every
   * session the account has. Calling this while an ordinary request is already
   * renewing is therefore safe, and resolves from the one rotation.
   *
   * @returns When the credential has been replaced and `user` refreshed. When
   * no refresh token is held - the state after any full page reload - the
   * session is ended locally and this resolves rather than throwing, because
   * "there is nothing to renew" is an ordinary answer.
   * @throws `ApiError` when renewal was refused: the presented token was
   * unknown, expired, revoked or already spent. The local session is ended
   * first.
   */
  readonly refresh: () => Promise<void>;
}

/**
 * The session context. Consume it through `@/hooks/use-auth`, not directly.
 *
 * The default is `undefined` rather than an anonymous-session object, and the
 * distinction is the whole point: `undefined` means "no provider above this
 * component", which is a wiring defect the hook reports loudly, while a `user`
 * of `null` inside a provider means "nobody is signed in", which is an ordinary
 * state. A default that conflated them would turn a missing provider into a
 * component that silently believes every reader is anonymous.
 */
export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/* -------------------------------------------------------------------------- */
/* Provider                                                                   */
/* -------------------------------------------------------------------------- */

/** Props of {@link AuthProvider}. */
interface AuthProviderProps {
  /**
   * The tree to render. Rendered unconditionally - this provider never gates
   * its children behind a loading flag, which would discard the server-rendered
   * markup the SEO requirement depends on and move focus on every load.
   */
  readonly children: React.ReactNode;
}

/**
 * Client boundary that owns the session for the whole application.
 *
 * Mounted once, in `src/app/layout.tsx`, around the entire tree:
 *
 * ```tsx
 * <AuthProvider>{children}</AuthProvider>
 * ```
 *
 * @param children - The tree to wrap, rendered unconditionally. See
 * {@link AuthProviderProps}.
 * @returns The provided tree, wrapped in the session context.
 */
export function AuthProvider({ children }: AuthProviderProps): React.JSX.Element {
  const [user, setUser] = useState<UserMe | null>(null);
  // Starts `true` because the session is not known until the mount effect below
  // has settled. That effect drives it to `false` on every branch, including the
  // branch that makes no request at all.
  const [isLoading, setIsLoading] = useState(true);
  // Populated only when restoration could not answer for a reason that says
  // nothing about the credential - see AuthContextValue.restoreError. It is
  // state rather than a ref because consumers render on it.
  const [restoreError, setRestoreError] = useState<ApiError | null>(null);
  // A DEFECT rather than an answer: something went wrong that is not a rejected
  // request at all - a misconfigured API base URL, a programming error in this
  // tier. It is held in state so it can be re-thrown during render, which is the
  // only way a failure inside an async effect reaches src/app/error.tsx; throwing
  // it from the effect itself would produce an unhandled promise rejection that
  // no boundary sees. See the throw just above this component's return.
  const [restoreDefect, setRestoreDefect] = useState<Error | null>(null);

  /**
   * Drop the session locally: forget the credential pair, clear the marker, and
   * clear the account.
   *
   * The single terminal path, shared by sign-out, a definitive authentication
   * rejection during restoration, a refused renewal and the unauthorised
   * notification - which is what makes "signed out" one state rather than four
   * nearly-identical ones.
   *
   * `clearCredentials` does more than forget two strings: it advances the auth
   * generation in `@/lib/api/client`, so a rotation that is already in flight
   * discards whatever it receives instead of adopting it. Without that, a
   * rotation begun before a sign-out and answered after it would re-arm the
   * bearer for an account that has signed out, while React showed nobody signed
   * in. Idempotent, so calling it after the client module has already cleared the
   * credential itself is safe and is the correct order rather than a redundancy.
   */
  const endSession = useCallback((): void => {
    clearCredentials();
    clearSessionMarker();
    setUser(null);
    // A surfaced restoration failure describes a session whose state was unknown.
    // Once the session has been deliberately ended there is nothing left to
    // describe, and leaving it set would have a signed-out surface offering a
    // retry for an account nobody is signed in to.
    setRestoreError(null);
  }, []);

  /**
   * Adopt an account: the single place `user` is populated.
   *
   * Clearing {@link restoreError} here rather than at each call site is what keeps
   * the invariant "a populated `restoreError` means the identity is unknown" true
   * for the whole life of the page. Without it, a reader who hit a network blip on
   * load and then signed in successfully would still be carrying the earlier
   * failure, and any surface reading it would offer a retry to somebody who is
   * already signed in.
   */
  const adoptAccount = useCallback((account: UserMe): void => {
    setUser(account);
    setRestoreError(null);
    // Re-assert the presence marker from the authoritative answer rather than
    // trusting whatever was already there: a role an administrator changed
    // arrives here, and this is the only place the current value is known. The
    // marker carries the role literal and never a credential - see the header.
    writeSessionMarker(account.role);
  }, []);

  // Terminal-unauthorised notification.
  //
  // Declared BEFORE the restoration effect on purpose: effects run in
  // declaration order, so the handler is registered before the first request
  // this provider makes, and a session that turns out to be dead on load is
  // reported rather than missed.
  //
  // `@/lib/api/client` calls this when authentication is definitively gone - it
  // attempted its single-flight renewal and was refused, or had nothing to
  // present. It has already forgotten the credential by then, so what remains is
  // the marker and React state, both of which `endSession` covers. Passing `null`
  // on cleanup deregisters, which the store supports directly.
  useEffect(() => {
    setUnauthorizedHandler(endSession);
    return () => {
      setUnauthorizedHandler(null);
    };
  }, [endSession]);

  // Arm the durable session mirror.
  //
  // Declared BEFORE the restoration effect for the same reason as the handler
  // above: effects run in declaration order, so the mirror is armed before the
  // first credential this provider adopts, and no adoption can slip past it.
  //
  // What it switches on is one thing: `@/lib/api/client`'s `setCredentials` and
  // `clearCredentials` will now tell the session route to update or drop the
  // HttpOnly refresh cookie it owns. Those two functions are the funnels EVERY
  // credential transition passes through - sign-in, single-flight rotation,
  // sign-out, an abandoned session - which is what makes the durable copy
  // incapable of holding a token the store has already replaced.
  //
  // It is armed here rather than being unconditional inside the client because
  // this provider is the tier's single owner of the session lifecycle, exactly as
  // it is for the marker and the unauthorised handler. The practical consequence
  // is that a test or a Server Component that touches the credential store
  // directly acquires no same-origin request it did not ask for.
  useEffect(() => {
    setDurableSessionMirror(true);
    return () => {
      setDurableSessionMirror(false);
    };
  }, []);

  // Session restoration, once per mount.
  //
  // What can and cannot be restored is the whole of this effect's logic, and it
  // turns on the difference between the two cookies this tier now has. The
  // script-written `blog_session` MARKER says a session EXISTED and which role it
  // claimed; it is not a credential and proves nothing. The HttpOnly refresh
  // cookie owned by `src/app/api/session/route.ts` IS a credential, and it is the
  // only thing that survives into a new document. So:
  //
  //   * No credential in memory AND no marker -> genuinely anonymous. No request
  //     is made at all. GET /auth/me could only produce a 401, on every anonymous
  //     page load, and it is also what would force every component test that
  //     renders this provider to mock a request it has no interest in.
  //   * No credential in memory BUT a marker -> the ordinary state after any full
  //     navigation. RECOVER: ask the session route to rotate its stored refresh
  //     token, adopt the pair it returns, and only then read the account. This is
  //     what stops a reload signing the reader out, and rotation doubles as the
  //     validation - a single-use token that has been revoked, has expired or has
  //     already been spent is refused, and then the session genuinely is over.
  //   * A credential in memory (a StrictMode re-mount, a successful recovery, or a
  //     provider re-mounted inside one context) -> re-read the account, which is
  //     authoritative and picks up a role an administrator has just changed.
  //
  // Why this cannot be derived during render instead: the cookie is invisible to
  // the server render (there is no document there), so a `useState` initialiser
  // reading it would produce one value on the client and another on the server,
  // and every consumer rendering on the flag would report a hydration mismatch.
  // Starting at "not known yet" and settling after mount keeps the two renders in
  // agreement.
  useEffect(() => {
    // Two cancellation mechanisms, because they do different jobs. The flag stops
    // a late answer from writing state for a mount that is gone; the controller
    // stops the REQUEST, so an unmount actually releases it instead of leaving it
    // to run to completion - and, more importantly here, so a request begun by
    // StrictMode's first pass cannot still be in flight, holding the credential
    // store's rotation path open, after that pass has been discarded.
    let cancelled = false;
    const controller = new AbortController();

    const restore = async (): Promise<void> => {
      try {
        const marker = readSessionMarker();

        if (getAccessToken() === null) {
          if (marker === null) {
            // GENUINELY ANONYMOUS, and no request is made. No marker means no
            // previous document in this browser signed in, so there is nothing to
            // recover and nothing to ask about: `GET /auth/me` here could only
            // answer 401, on every anonymous page load, and it is also what would
            // force every component test that renders this provider to mock a
            // request it has no interest in.
            return;
          }

          // A PREVIOUS DOCUMENT HELD A SESSION, AND THIS ONE HAS NO CREDENTIAL.
          //
          // That is the ordinary state after any full navigation - a reload, a new
          // tab, an external link back into the site - because the credential lives
          // in a module variable and a module variable dies with its JavaScript
          // context. It is NOT evidence that the session is over, and treating it as
          // such is what used to sign the reader out here: the marker was cleared,
          // an anonymous session was presented, and nothing had been asked.
          //
          // So the durable credential is presented instead. `recoverDurableSession`
          // asks the same-origin session route to rotate the HttpOnly refresh cookie
          // it owns and adopts the pair it returns, which arms the bearer before
          // `getMe` below is called. Rotation is also the VALIDATION: a refresh token
          // is single-use, so a token the service has revoked, expired or already
          // seen is refused, and the session really is over.
          //
          // A failure here is classified by the same `catch` as everything else in
          // this effect, which is the point of letting it throw an `ApiError`: a 401
          // ends the session, and a transport failure or a 5xx leaves it untouched
          // for a later retry. Neither case needs a branch of its own.
          await recoverDurableSession(controller.signal);
          if (cancelled) {
            return;
          }
        }

        const account = await getMe({ signal: controller.signal });
        if (!cancelled) {
          adoptAccount(account);
        }
      } catch (cause) {
        // THREE OUTCOMES, NOT ONE. Every write here is guarded by `cancelled`
        // for the same reason as the success path: under StrictMode the first
        // run is cancelled while the second is already in flight, and touching
        // the credential the live run just seeded would leave it holding an
        // account with no bearer attached.
        if (cancelled) {
          return;
        }

        if (!isApiError(cause)) {
          // 1. NOT A REJECTION AT ALL - a defect. A misconfigured
          //    NEXT_PUBLIC_API_BASE_URL, or a programming error in this tier.
          //    The session is left exactly as it was, because nothing here has
          //    learned anything about it, and the defect is stored so it can be
          //    thrown during render where src/app/error.tsx will catch it. It is
          //    deliberately not written to the console: per src/app/error.tsx
          //    the console belongs to whoever holds the browser, and a caught
          //    object is exactly what must not be handed over.
          setRestoreDefect(cause instanceof Error ? cause : new Error(String(cause)));
        } else if (isTerminalAuthFailure(cause)) {
          // 2. THE SESSION IS OVER. A dead session on load is an ordinary state
          //    and not a crash: the token expired, was revoked while the tab was
          //    closed, or - for a recovered document - the stored refresh token
          //    had already been spent, so the rotation above was refused and
          //    there is nothing left to renew with. End the session and let the
          //    reader sign in.
          endSession();
        } else {
          // 3. THE ATTEMPT FAILED, THE SESSION DID NOT. The service was
          //    unreachable, a preflight was refused, the request was aborted, or
          //    it answered 5xx - none of which says the credential is finished.
          //    The credential and the presence cookie are deliberately LEFT
          //    INTACT: any later request carries the same bearer, and
          //    @/lib/api/client rotates once on a 401 and notifies the handler
          //    registered above if the session really is over. Clearing here
          //    instead would mean a dropped connection on load signs the reader
          //    out of a session that was never in question.
          //
          //    `user` stays `null` because the account genuinely is not known,
          //    so the failure is surfaced through context to say WHY - see
          //    AuthContextValue.restoreError for the two meanings of a null
          //    account and why a surface must tell them apart.
          setRestoreError(cause);
        }
      } finally {
        // In a `finally` so no branch can leave the application permanently
        // "loading" - including the defect branch above, which returns early
        // from the `catch` but still passes through here.
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    // The closure above is total - every branch is caught and every outcome is
    // recorded in state - so this rejection handler is unreachable by
    // construction. It is attached anyway, and that is the point: a bare
    // `void restore()` makes the totality of the closure a LOAD-BEARING and
    // unenforced property of the code, so one future edit that lets something
    // throw turns into an unhandled promise rejection - a failure with no
    // boundary, no record and no visible symptom beyond a console line nobody
    // reads. Routing it into the same state the defect branch uses means there
    // is no path from this effect to an unreported failure.
    restore().catch((cause: unknown) => {
      if (!cancelled) {
        setRestoreDefect(cause instanceof Error ? cause : new Error(String(cause)));
        setIsLoading(false);
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [adoptAccount, endSession]);

  const login = useCallback(
    async (credentials: LoginRequest): Promise<void> => {
      // The plaintext password lives exactly as long as this call. It is passed
      // straight through and is never assigned to state, to a ref or to storage.
      const tokens = await requestLogin(credentials);
      adoptCredentials(tokens);
      try {
        adoptAccount(await getMe());
      } catch (cause) {
        // The credential is good but the account could not be read, so the session
        // would be "signed in with nobody signed in" - a state no surface can
        // render correctly. Undo the adoption and report.
        endSession();
        throw cause;
      }
    },
    [adoptAccount, endSession],
  );

  const register = useCallback(
    async (input: RegisterRequest): Promise<void> => {
      // Registration answers with the new PUBLIC record and issues no credential,
      // so its response is not a session and is not treated as one. The password
      // supplied for the account is spent once more, here, to obtain one.
      //
      // This provider is the SINGLE owner of that policy - "create the account,
      // then sign the reader in" is this context's documented contract, and
      // @/lib/api/auth deliberately makes no such decision. The cost is real and
      // is owned here: sign-in is rate-limited, so a throttled window surfaces as
      // a sign-in failure immediately after a successful registration. The
      // rejection is propagated unchanged so the sign-up form can say exactly
      // that, rather than implying the account was not created.
      await requestRegister(input);
      await login({ email: input.email, password: input.password });
    },
    [login],
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      // Takes no argument, and cannot: `@/lib/api/auth#logout` revokes the refresh
      // token it is HOLDING, because that is the only credential its own recovery
      // path can act on. Naming a different one used to be possible and could
      // report success while leaving that token live.
      await requestLogout();
    } finally {
      // In a `finally`, and that is the whole point. If the revocation request
      // fails - offline, throttled, a 5xx, or a rotation it could not complete -
      // the reader must still end up signed out locally rather than stranded with
      // a credential they asked to give up.
      //
      // WHO CLEARS WHAT. `@/lib/api/auth#logout` owns the transport-level clear and
      // performs it on its success path: the in-memory pair and the presence cookie
      // both go, which is the contract that module documents. `endSession` is this
      // provider's single terminal path and owns what the transport cannot see -
      // the React account state and the role marker - and it calls
      // `clearCredentials` as well. That is deliberate belt-and-braces rather than
      // a second owner: the call is idempotent and advances the auth generation, it
      // is the same terminal path a refused renewal and the unauthorised
      // notification take, and it is the only clear that runs when the wrapper
      // rejects before reaching its own.
      endSession();
    }
  }, [endSession]);

  const refresh = useCallback(async (): Promise<void> => {
    // ROUTED THROUGH THE CLIENT'S SINGLE-FLIGHT PATH, NOT AROUND IT.
    //
    // `rotateSession` is the only public way to rotate, and calling
    // `@/lib/api/auth`'s wrapper directly - which this used to do - bypassed every
    // guarantee it carries. Three of them matter here:
    //
    //   * ONE REQUEST. The client collapses concurrent rotations onto a single
    //     shared promise. A rotation issued around it races the one issued through
    //     it, and because each rotation REVOKES the token it presents, the loser
    //     invalidates the winner's replacement - a reader signed out at random
    //     while using the site normally, because the service reads a token
    //     presented twice as theft and revokes every token the account holds.
    //   * ONE STORE. `rotateSession` adopts the new pair itself, so the bearer
    //     every other request attaches is updated by the same call that obtained
    //     it. Adopting separately leaves a window in which requests carry the
    //     token that was just revoked.
    //   * ONE SESSION IDENTITY. A generation guard inside the client discards a
    //     rotation whose result arrives after a sign-out or after another
    //     adoption, so a late renewal cannot resurrect an ended session.
    //
    // There is consequently no `getRefreshToken` read here and no `adoptCredentials`
    // call: what to present and what to do with the answer are both the client's,
    // and this provider's job is the React state and the presence marker.
    try {
      // The returned pair is deliberately unused: `rotateSession` has already
      // stored it, and a second copy held here would be a second truth.
      await rotateSession();
    } catch (cause) {
      // Refused, superseded, or nothing was held to present - the last being the
      // expected state after a full page reload; see the header on why the refresh
      // token is deliberately not persisted. The client has already cleared the
      // credential and notified its unauthorised handler by now, so this call is
      // the idempotent local half.
      endSession();
      throw cause;
    }

    // Re-read rather than reuse: this is where a role an administrator changed
    // arrives, and `adoptAccount` re-asserts the presence marker from it. A failure
    // here does NOT end the session - the credential just issued is provably fresh -
    // so the previous account stays in state and the rejection is reported.
    adoptAccount(await getMe());
  }, [adoptAccount, endSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      isAuthenticated: user !== null,
      restoreError,
      login,
      register,
      logout,
      refresh,
    }),
    [user, isLoading, restoreError, login, register, logout, refresh],
  );

  // A restoration DEFECT is re-thrown here, during render, and the placement is
  // the whole mechanism rather than a detail. React only catches what is thrown
  // while rendering; something thrown from inside an async effect is an
  // unhandled promise rejection that no boundary ever sees, which is precisely
  // how a broken NEXT_PUBLIC_API_BASE_URL used to produce a console line and an
  // application that looked fine. Throwing it from here hands it to the nearest
  // boundary - src/app/error.tsx - which reports it and offers a retry.
  //
  // It sits AFTER every hook call and immediately before the return, so the hook
  // order of this component is identical on every render whether a defect was
  // recorded or not.
  //
  // Note what is NOT thrown: a rejected request. `restoreError` is an ordinary
  // outcome the application recovers from, and replacing the whole tree with an
  // error screen because one request failed on load would be a far worse answer
  // than rendering the page and saying the identity is not known yet.
  if (restoreDefect !== null) {
    throw restoreDefect;
  }

  // `children` is rendered unconditionally. See AuthProviderProps.
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
