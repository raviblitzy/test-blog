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
// THE COOKIE CONTRACT - THE REASON A COOKIE IS INVOLVED AT ALL
//
// src/middleware.ts gates /dashboard/:path*, /posts/:path* and /admin/:path* in
// the Edge runtime, BEFORE any component renders. What it can read there is a
// cookie. What it cannot read is React state, a module-scoped variable, or any
// durable browser storage - localStorage and sessionStorage are not available
// in that runtime and would not be sent with the navigation anyway. So a
// session is visible to route protection if, and only if, the access token is
// mirrored into a cookie.
//
// That is not stated in the technical plan. It is a consequence of where the
// middleware runs, and the failure mode if it is missed is the worst kind:
// nothing errors and nothing warns, the middleware simply never finds a token,
// treats every reader as anonymous, and route protection quietly does not
// exist. Note also that the service sets NO cookie of its own - it answers with
// the credential pair in the JSON response body and authenticates from the
// Authorization header alone - so mirroring it is entirely this tier's job.
//
// ---------------------------------------------------------------------------
// DIVISION OF LABOUR WITH src/lib/api/client.ts - WHO WRITES THE COOKIE
//
// The cookie is written in exactly ONE place in this tier, and it is not here:
// `setCredentials` in src/lib/api/client.ts adopts a credential pair and writes
// the presence cookie in the same call, and `clearCredentials` drops the pair
// and expires the cookie in the same call. That module also refreshes the
// cookie from inside its own single-flight rotation, which this file never sees.
//
// So the contract above is satisfied by CALLING those two functions on every
// path that gains or loses a credential - which this file does, without
// exception - rather than by writing a second cookie writer here. Two writers
// would mean two attribute lists that have to agree character for character
// (Path in particular: a delete whose Path differs from the write silently
// leaves the original in place), and one of them would inevitably be the one
// rotation does not go through. One writer, one deleter, called from here.
//
// What this file does own is the READ, because client.ts exposes no reader: on
// load, the in-memory pair is empty and the cookie is the only surviving trace
// of a session. See {@link readAuthCookie}, the single cookie mechanic below.
//
// ---------------------------------------------------------------------------
// THE COOKIE'S LIFETIME - A DECISION, NOT AN OVERSIGHT
//
// The cookie client.ts writes is a SESSION cookie: Path=/, SameSite=Lax,
// Secure only on an https origin, no Domain, and deliberately no Max-Age. Two
// properties of it are worth knowing here, because both look like defects until
// the alternative is written out.
//
//   * It cannot be HttpOnly. A cookie written by client-side script never can
//     be - the flag exists to hide a cookie FROM script. This one is a presence
//     and role signal for the middleware, not a credential the service trusts:
//     the API reads the Authorization header and never a cookie, and re-checks
//     authority on every request.
//   * Its lifetime is the browsing session rather than TokenPair.expires_in.
//     Deriving Max-Age from the access token's remaining seconds sounds
//     tighter, and is worse: the cookie would then die at the exact moment the
//     access token does, and the middleware would bounce a reader to /login
//     whose session is perfectly alive because a rotation would have renewed it
//     - a visible defect on an ordinary idle-then-navigate. The failure mode of
//     the session cookie is the cheaper direction: the middleware may admit a
//     navigation whose access token is already dead, the first request answers
//     401, client.ts rotates once, and if rotation is refused it clears the
//     cookie and the pair and notifies the handler this file registers, which
//     drops the account from state. Route protection is defence in depth, never
//     the boundary - every protected operation is re-checked server-side - so
//     admitting a render that then corrects itself costs a redirect, while
//     bouncing a live session costs the reader their session. If that policy is
//     ever revisited, `writeAuthCookie` in src/lib/api/client.ts is the one
//     place to change, and it stays one place precisely because this file does
//     not write a competing cookie.
//
// ---------------------------------------------------------------------------
// WHY AUTH_COOKIE_NAME IS IMPORTED AND RE-EXPORTED RATHER THAN DECLARED
//
// Three files have to agree on the cookie's name: src/lib/api/client.ts writes
// and expires it, this file reads it, and src/middleware.ts gates on it. A
// mismatched spelling fails silently, so there is exactly one literal and it
// lives in client.ts - the only cycle-free home, because client.ts imports
// nothing but @/lib/types. Declaring it here instead would force client.ts to
// import this file and close the cycle
// auth-provider -> lib/api/auth -> lib/api/client -> auth-provider, whose
// failure mode is an undefined binding at run time that neither the
// type-checker nor the linter reports.
//
// It is re-exported below so src/middleware.ts can reach it from this module -
// its declared dependency - without importing from @/lib/api/*. This module has
// no top-level side effect of any kind, so that import shakes down to the
// string constant. (Should the Edge bundle ever object to the 'use client'
// directive on this path, importing AUTH_COOKIE_NAME straight from
// @/lib/api/client is the equivalent escape hatch: it is the same single
// definition site, reached one hop earlier. Restating the literal is not.)
//
// ---------------------------------------------------------------------------
// THE REFRESH TOKEN IS MEMORY-ONLY, AND WHAT THAT COSTS
//
// client.ts holds the refresh token in a module variable and nothing else -
// this file never puts it in state, in a ref, in a cookie or in durable browser
// storage (neither localStorage nor sessionStorage appears anywhere in this
// tier). It is an opaque high-entropy value rather than a JWT, so it is never
// decoded or inspected either.
//
// The accepted consequence, stated plainly so nobody "fixes" it: after a full
// page reload, the refresh token is gone. If the access token in the cookie has
// already expired, the session cannot be renewed and the reader signs in again.
// That is the correct trade - a long-lived refresh token in storage that any
// script on the origin can read is strictly worse than one re-login - and it is
// NOT to be resolved by persisting the refresh token client-side.
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
//   5. Token decoding of any kind, for an expiry countdown or anything else.
//      src/middleware.ts is the only file that decodes the payload - unverified
//      and only for the role claim. A client-side expiry check would duplicate
//      state the service already owns and would tempt a signature check next.
//   6. A proactive renewal timer. client.ts rotates once, single-flight, when a
//      request that carried a credential is answered 401. A timer here would
//      race that path, and each rotation revokes the token it presented.
//   7. Markup, className, inline style, or any import from a component module.
//      This provider renders no element of its own and declares no CSS value.
//   8. Persisting the account itself. UserMe carries the email address and the
//      role; it is re-read from GET /auth/me, which is authoritative and picks
//      up a role an administrator has just changed.

import { createContext, useCallback, useEffect, useMemo, useState } from 'react';

import {
  getMe,
  login as requestLogin,
  logout as requestLogout,
  refresh as requestRefresh,
  register as requestRegister,
} from '@/lib/api/auth';
import {
  AUTH_COOKIE_NAME,
  clearCredentials,
  getRefreshToken,
  isApiError,
  setCredentials,
  setUnauthorizedHandler,
} from '@/lib/api/client';
import type { LoginRequest, RegisterRequest, TokenPair, UserMe } from '@/lib/types';

/**
 * Re-export of the cookie name, for `src/middleware.ts`.
 *
 * The literal itself lives in `@/lib/api/client` - see the header for why that
 * is the only cycle-free home and why restating it anywhere is a defect. This
 * is a binding re-export, not a copy: there is still exactly one string.
 */
export { AUTH_COOKIE_NAME };

/* -------------------------------------------------------------------------- */
/* Cookie reading - the one cookie mechanic this file owns                    */
/* -------------------------------------------------------------------------- */

/** Separator between the pairs in a `document.cookie` string. */
const COOKIE_PAIR_SEPARATOR = ';';

/** Separator between a cookie's name and its value. */
const COOKIE_NAME_VALUE_SEPARATOR = '=';

/**
 * The `refresh_token` member of a pair synthesised while restoring a session.
 *
 * Empty rather than absent because {@link TokenPair} declares the member
 * non-optional, and empty is the honest value: the refresh token is held in
 * memory only, so a reload leaves none. `@/lib/api/client` reads an empty
 * string as "nothing to present" and abandons the session rather than sending
 * it, which is exactly the intended behaviour.
 */
const NO_REFRESH_TOKEN = '';

/**
 * The `expires_in` member of a pair synthesised while restoring a session.
 *
 * The remaining lifetime of a restored access token is unknown here and stays
 * unknown: learning it would mean decoding the token, which this tier does not
 * do. Nothing reads this member - the credential store keeps the two tokens and
 * the cookie's lifetime is the browsing session - so the value is inert.
 */
const UNKNOWN_EXPIRES_IN = 0;

/**
 * The access token in the presence cookie, or `null` when there is none.
 *
 * A `null` answer is the ordinary anonymous state, and it is load-bearing
 * beyond efficiency: it is what lets the mount effect below decide NOT to make
 * a request, so a component test can render this provider with no request
 * mocked at all.
 *
 * Returns `null` rather than throwing for every unusable shape - no document,
 * no such cookie, a cleared cookie the browser has not dropped yet, or a value
 * whose percent-encoding will not decode. None of those is an error condition;
 * each simply means no session can be restored.
 */
function readAuthCookie(): string | null {
  // No document while server rendering. A no-op there rather than a guard at
  // the call site, so the function is safe wherever it is called from.
  if (typeof document === 'undefined') {
    return null;
  }

  const prefix = `${AUTH_COOKIE_NAME}${COOKIE_NAME_VALUE_SEPARATOR}`;
  for (const pair of document.cookie.split(COOKIE_PAIR_SEPARATOR)) {
    // Pairs after the first arrive with a leading space. Comparing the trimmed
    // pair against `name=` also keeps a cookie whose name merely ENDS with this
    // one's - `previous_access_token`, say - from matching.
    const candidate = pair.trim();
    if (!candidate.startsWith(prefix)) {
      continue;
    }

    const encoded = candidate.slice(prefix.length);
    if (encoded === '') {
      return null;
    }
    try {
      return decodeURIComponent(encoded);
    } catch {
      // decodeURIComponent throws on a malformed escape. A token that cannot be
      // read is a token that cannot be presented, so this is "no session".
      return null;
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Credential adoption - the single seam every token pair passes through      */
/* -------------------------------------------------------------------------- */

/**
 * Adopt a credential pair: sign-in, the sign-up follow-up and renewal all land
 * here, and nothing else in this file touches the credential store.
 *
 * One call does three things, which is why it is one call: the access token
 * becomes the bearer on subsequent requests, the refresh token becomes what a
 * rotation presents, and the presence cookie `src/middleware.ts` gates on is
 * written or replaced. Keeping them together is what makes it impossible for
 * this file to hold a credential the middleware cannot see.
 *
 * @param tokens - The pair exactly as the service issued it. Both members are
 * adopted: renewal revokes the refresh token it presented, so keeping the
 * previous one would guarantee the next renewal fails.
 */
function adoptCredentials(tokens: TokenPair): void {
  setCredentials(tokens);
}

/**
 * Adopt an access token recovered from the presence cookie on load.
 *
 * The cookie carries the access token and nothing else, so the pair handed to
 * the credential store is completed here rather than fabricated at the call
 * site - see {@link NO_REFRESH_TOKEN} and {@link UNKNOWN_EXPIRES_IN} for why
 * each stand-in is the honest value rather than a placeholder.
 *
 * @param accessToken - The token read from the cookie, already decoded.
 */
function adoptRestoredAccessToken(accessToken: string): void {
  adoptCredentials({
    access_token: accessToken,
    refresh_token: NO_REFRESH_TOKEN,
    token_type: 'bearer',
    expires_in: UNKNOWN_EXPIRES_IN,
  });
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
   * Whether the initial restoration from the presence cookie is still running.
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
   * @returns When the session has ended.
   * @throws `ApiError` when the revocation request itself failed. The local
   * session is already gone by then, so a caller may safely ignore it; it is
   * surfaced rather than swallowed because a caller that wants to report "signed
   * out here, but the session may still be live elsewhere" needs to know.
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
  // Starts `true` because a cookie may be present and the account is not known
  // until the service has answered. The mount effect below drives it to `false`
  // on every branch, including the branch that makes no request at all.
  const [isLoading, setIsLoading] = useState(true);

  /**
   * Drop the session locally: forget the credential pair, expire the presence
   * cookie, and clear the account.
   *
   * The single terminal path, shared by sign-out, a failed restoration, a
   * refused renewal and the unauthorised notification - which is what makes
   * "signed out" one state rather than four nearly-identical ones. Idempotent,
   * so calling it after `@/lib/api/client` has already cleared the credential
   * itself is safe and is the correct order rather than a redundancy.
   */
  const endSession = useCallback((): void => {
    clearCredentials();
    setUser(null);
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
  // present. It has already forgotten the credential and expired the cookie by
  // then, so what remains is React state, and `endSession` covers that whether
  // or not the caller cleared first. Passing `null` on cleanup deregisters,
  // which the store supports directly.
  useEffect(() => {
    setUnauthorizedHandler(endSession);
    return () => {
      setUnauthorizedHandler(null);
    };
  }, [endSession]);

  // Session restoration, once per mount.
  //
  // The effect body only STARTS the work: it declares the cancellation flag and
  // invokes the closure below. Every state write lives inside that closure, and
  // there is exactly one settle site - the `finally` - which every branch
  // reaches, including the branch that makes no request at all.
  //
  // Why this cannot be derived during render instead, which is the alternative
  // the react-hooks/set-state-in-effect rule exists to push code towards: the
  // cookie is invisible to the server render (there is no document there), so a
  // `useState` initialiser reading it would produce `true` on the client where
  // the server produced `false` and every consumer rendering on the flag would
  // report a hydration mismatch. Starting at "not known yet" and settling after
  // mount is what keeps the two renders in agreement. `useSyncExternalStore` -
  // the rule's other suggestion - would remove the settle for the anonymous
  // case and introduce a worse defect: the cookie would become a reactive
  // dependency of this effect, so every rotation (which rewrites it) would
  // re-run the restoration and re-request the account.
  useEffect(() => {
    // Flipped by the cleanup below so a late answer cannot write state for a
    // mount that is gone. React 19's StrictMode runs this effect twice in
    // development, and without this flag the first run's answer would land
    // after the second run had replaced it.
    let cancelled = false;

    const restore = async (): Promise<void> => {
      try {
        const restored = readAuthCookie();
        if (restored === null) {
          // No cookie, so no session to restore and - deliberately - NO
          // REQUEST. Asking GET /auth/me without a credential would answer 401
          // on every anonymous page load, and it is also what would force every
          // component test that renders this provider to mock a request it has
          // no interest in. The `finally` still settles the flag.
          return;
        }

        // Seed the credential store first: the read below is authenticated by
        // the bearer this installs.
        adoptRestoredAccessToken(restored);

        const account = await getMe();
        if (!cancelled) {
          setUser(account);
        }
      } catch (cause) {
        // A dead cookie on load is an ordinary state, not a crash: the token
        // expired or was revoked while the tab was closed, and there is no
        // refresh token after a reload to renew it with. End the session and
        // let the reader sign in.
        //
        // Guarded like every other write on this path: under StrictMode the
        // first run is cancelled while the second is already in flight, and
        // clearing the credential the live run just seeded would leave it
        // holding an account with no bearer attached.
        if (!cancelled) {
          endSession();
        }
        // A failure that is not an ApiError is not a rejection at all - a
        // missing API base URL, say - so it is a defect rather than an answer
        // and is re-thrown to surface. It is deliberately not written to the
        // console: per src/app/error.tsx the console belongs to whoever holds
        // the browser, and a caught object is exactly what must not be handed
        // over.
        if (!isApiError(cause)) {
          throw cause;
        }
      } finally {
        // In a `finally` so no branch can leave the application permanently
        // "loading" - including the re-thrown defect above.
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void restore();

    return () => {
      cancelled = true;
    };
  }, [endSession]);

  const login = useCallback(
    async (credentials: LoginRequest): Promise<void> => {
      // The plaintext password lives exactly as long as this call. It is passed
      // straight through and is never assigned to state, to a ref or to storage.
      const tokens = await requestLogin(credentials);
      adoptCredentials(tokens);
      try {
        setUser(await getMe());
      } catch (cause) {
        // The credential is good but the account could not be read, so the
        // session would be "signed in with nobody signed in" - a state no
        // surface can render correctly. Undo the adoption and report.
        endSession();
        throw cause;
      }
    },
    [endSession],
  );

  const register = useCallback(
    async (input: RegisterRequest): Promise<void> => {
      // Registration answers with the new PUBLIC record and issues no
      // credential, so its response is not a session and is not treated as one.
      // The password supplied for the account is spent once more, here, to
      // obtain one.
      await requestRegister(input);
      await login({ email: input.email, password: input.password });
    },
    [login],
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      // No argument: the refresh token currently held is the one revoked, which
      // is the ordinary case - end the session this tab is signed in with.
      await requestLogout();
    } finally {
      // In a `finally`, and that is the whole point. If the revocation request
      // fails - offline, throttled, a 5xx - the reader must still end up signed
      // out locally rather than stranded with a credential they asked to give
      // up. The wrapper clears on success only, so this is what makes sign-out
      // unconditional.
      endSession();
    }
  }, [endSession]);

  const refresh = useCallback(async (): Promise<void> => {
    // Opaque, never decoded, never inspected - only presented.
    const presented = getRefreshToken();
    if (presented === null || presented === '') {
      // Nothing to renew. The expected state after any full page reload; see
      // the header on why the refresh token is deliberately not persisted.
      endSession();
      return;
    }

    let tokens: TokenPair;
    try {
      tokens = await requestRefresh({ refresh_token: presented });
    } catch (cause) {
      // Renewal was refused, so the session is over: the presented token was
      // unknown, expired, revoked or already spent, and no other token exists.
      endSession();
      throw cause;
    }

    // Both members are replaced: the presented refresh token was revoked as
    // this pair was issued.
    adoptCredentials(tokens);
    // Re-read rather than reuse: this is where a role an administrator changed
    // arrives. A failure here does NOT end the session - the credential just
    // issued is provably fresh - so the previous account stays in state and the
    // rejection is reported.
    setUser(await getMe());
  }, [endSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      isAuthenticated: user !== null,
      login,
      register,
      logout,
      refresh,
    }),
    [user, isLoading, login, register, logout, refresh],
  );

  // `children` is rendered unconditionally. See AuthProviderProps.
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
