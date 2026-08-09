'use client';

// use-auth - the one supported way to read the session.
//
// AAP §0.7.1.7 lists this file under Group 7 (Frontend Foundation) with the purpose "Session
// access", serving R1 - "Users can sign up, log in" with "JWT authentication". It is the SOLE
// definition site of `useAuth` in this tier: `@/providers/auth-provider` deliberately declares no
// such hook, so there is no competing implementation and no fallback for a consumer to reach for.
//
// The file is short because everything it could usefully add belongs somewhere else. It reads a
// context and returns it unchanged. What it contributes is the GUARD below, plus a single import
// path every session consumer shares - so the provider's contract can grow without every component
// that depends on it having to change with it.
//
// -----------------------------------------------------------------------------------------------
// 1. THE THROW IS THE FEATURE
//
// `AuthContext` defaults to `undefined`, and the provider says why: `undefined` means "no provider
// above this component", which is a wiring defect, while a `user` of `null` INSIDE a provider means
// "nobody is signed in", which is an ordinary state. A hook that simply returned the default would
// hand a component `undefined` and let it behave as though every reader were anonymous - a bug that
// surfaces far from its cause, as a header offering "Sign in" to a signed-in administrator, with
// nothing in the console to explain it.
//
// Throwing turns that silent mystery into an immediate, located failure carrying its own fix. It is
// also what makes the return type sound: TypeScript narrows `AuthContextValue | undefined` to
// `AuthContextValue` after the guard, so no consumer ever writes `auth?.user`. That narrowing is
// EARNED at run time. A non-null assertion or a cast would produce the identical type with none of
// the safety, and is the one shortcut this file must not take.
//
// -----------------------------------------------------------------------------------------------
// 2. FOUR STATES REACH THIS HOOK, AND ONLY ONE OF THEM IS AN ERROR
//
// Conflating "no provider" with "not signed in" is the likeliest defect here, so the guard
// tests the CONTEXT and never the user:
//
//   context nullish                     -> the provider is missing. A DEVELOPER error, unrelated to
//       any visitor and unfixable at run time. Throw.
//   user null, isLoading true           -> not known yet; the one-time restoration is in flight.
//       Ordinary. Returned.
//   user null, isLoading false,
//     restoreError null                 -> ANONYMOUS, and expected: the (auth)/login and
//       (auth)/signup pages call this hook with nobody signed in, so throwing for them would break
//       the sign-in flow outright. Ordinary. Returned.
//   user null, restoreError set         -> the service could not be ASKED, so the reader may well
//       still be signed in and the credential was not discarded. Ordinary, and NOT the same as
//       anonymous. Returned; see the member's own documentation on the provider.
//
// Only the first is this hook's business. The other three are the provider's state, passed straight
// through for the caller to tell apart.
//
// -----------------------------------------------------------------------------------------------
// 3. DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT HERE.
//
//   1. Any HTTP, and any import from `@/lib/api/*`. AAP §0.6.4 designates `@/lib/api/client` this
//      tier's only HTTP module, and all four actions returned below are already the provider's own.
//      Calling `@/lib/api/auth` from here would open a second path to the same endpoints, bypassing
//      the provider's presence-cookie write and client.ts's in-memory credential store and leaving
//      the session desynchronised while both halves believed they owned the transition.
//   2. Token decoding, parsing or verification of any kind. The signing key is a backend-only value
//      and is not referenced in this tier in any form. The one place a token payload is read at all
//      is `src/middleware.ts`, and only because AAP §0.6.5 makes client-side route protection
//      defence in depth; real authority is re-decided server-side on every operation.
//   3. Cookie, localStorage or sessionStorage access. The provider owns the single cookie this tier
//      writes, and `AUTH_COOKIE_NAME` is NOT read here even though the provider re-exports it for
//      `src/middleware.ts`.
//   4. Derived state or convenience flags. `isAuthenticated` is already on the context, derived
//      once there so no two consumers disagree. An `isAdmin` added here would invite being
//      read as an authorisation decision, which it is not: authority is `require_admin` on the
//      service's admin router and the ownership assertions in its post and comment services. A
//      caller that needs the distinction compares `user?.role` itself, for rendering only.
//   5. `useState`, `useEffect` or any subscription. The provider owns every piece of session state;
//      a copy cached here would go stale, and logic that needs state belongs in the provider.
//   6. An import from `@/components/*`. Dependency direction is components -> hooks, never back.
//   7. A default export, an `index.ts` barrel, or a colocated test. Consumers import
//      `{ useAuth }` by name; all frontend tests live under `frontend/tests/**` per AAP §0.4.5.3.

import { useContext } from 'react';

import { AuthContext, type AuthContextValue } from '@/providers/auth-provider';

/**
 * What a developer sees when the provider is missing.
 *
 * Written to be acted on without opening another file, because the stack trace points at the
 * consuming component and says nothing about the cause: it names the hook, the component that must
 * be an ancestor, and where that component is actually mounted. The closing sentence exists to
 * pre-empt the wrong fix - a reader who is merely signed out does NOT reach this message, so anyone
 * seeing it has a wiring problem rather than an empty session to handle.
 */
const MISSING_PROVIDER_MESSAGE =
  'useAuth() was called outside of AuthProvider, so there is no session context to read. ' +
  'Wrap the component tree in <AuthProvider>, which is mounted once for the whole application ' +
  'in frontend/src/app/layout.tsx alongside ThemeProvider and QueryProvider. If the component is ' +
  'rendered outside that tree - in a test or a separate React root - wrap it there too. ' +
  'Note that a signed-out visitor never triggers this: inside the provider that is an ordinary ' +
  'state, reported as user: null with isAuthenticated: false.';

/**
 * Read the current session.
 *
 * The only supported way to reach {@link AuthContext}. Consume this rather than the context object
 * directly, so the missing-provider guard below cannot be skipped.
 *
 * Returns the provider's value **unchanged** - this hook adds nothing to it and derives nothing
 * from it. The members are:
 *
 * - `user` - the signed-in account (`UserMe`), or `null` when nobody is signed in. `user.role` is
 *   safe for deciding which controls to *render* and is never an authority; the service re-checks
 *   every protected operation.
 * - `isLoading` - `true` for one pass on mount while the initial session check runs, `false`
 *   for the rest of the page's life. It does not track a sign-in, sign-out or renewal. Read with
 *   `user` so a surface can render a neutral state instead of briefly claiming "sign in" to a
 *   reader who is in fact signed in - which keeps the `(dashboard)` and `(admin)` groups from
 *   flashing a redirect while the session is still resolving.
 * - `isAuthenticated` - `user !== null`, derived once by the provider so no two consumers disagree.
 * - `restoreError` - why the initial check could not answer, or `null` when the answer is known.
 *   When this is set, a `null` `user` does **not** mean anonymous: the credential is intact and the
 *   service simply could not be asked, so offer a retry rather than a sign-in prompt.
 * - `login(credentials)` - exchange an email address and password for a session, then load the
 *   account. Rejects with `ApiError` (`401` for any wrong credential, `403` deactivated, `429`
 *   throttled); nothing is adopted on failure.
 * - `register(input)` - create an account and sign it in. Rejects with `ApiError` (`409` address or
 *   handle taken, `422` policy, `429` throttled).
 * - `logout()` - revoke the session at the service, then forget it locally. The local half always
 *   happens, so a caller that ignores the rejection still ends up signed out.
 * - `refresh()` - renew the credential deliberately and re-read the account, which is how a role an
 *   administrator has just changed arrives.
 *
 * Every action resolves to `void`: the account is context state, not a return value, so await an
 * action for its completion and then read `user`.
 *
 * @returns The live session context, never `undefined`.
 * @throws {Error} When called outside `AuthProvider`. That signals a missing provider - a developer
 * error - and never an anonymous visitor, for whom the hook returns normally with `user: null`. See
 * {@link MISSING_PROVIDER_MESSAGE} for the message and the reasoning behind its wording.
 *
 * @example
 * ```tsx
 * 'use client';
 *
 * export function UserMenu() {
 *   const { user, isLoading, isAuthenticated, logout } = useAuth();
 *
 *   // Distinguish "not known yet" from "definitely anonymous" so the menu does not flicker.
 *   if (isLoading) return <MenuSkeleton />;
 *   if (!isAuthenticated) return <SignInLink />;
 *
 *   // `user` is non-null here, because `isAuthenticated` is exactly `user !== null`.
 *   return <MenuFor account={user} onSignOut={logout} />;
 * }
 * ```
 */
export function useAuth(): AuthContextValue {
  // Called first and unconditionally. `react-hooks/rules-of-hooks` is active and blocking in
  // frontend/eslint.config.mjs, so the guard has to follow this line rather than precede it -
  // and it must, because there is nothing to guard until the context has been read.
  const context = useContext(AuthContext);

  // Nullish, not falsy-in-general and not `=== undefined`: the loose comparison is deliberate
  // and is the one place in this file where `==` is the correct operator. It matches `null` and
  // `undefined` and nothing else, so the guard holds whether the provider makes the context with an
  // `undefined` default (as it does today) or is ever changed to a `null` one. Do not "fix" it to
  // `===`, which would silently stop covering one of the two.
  //
  // Note what is NOT tested here: `context.user`. A `null` user inside a live provider is an
  // anonymous visitor - an entirely valid state that the login and signup pages depend on - and
  // throwing for it would break the sign-in flow. Guard the context; never the user.
  if (context == null) {
    throw new Error(MISSING_PROVIDER_MESSAGE);
  }

  // Returned as-is. The guard above has narrowed away the `undefined`, so the declared return type
  // needs no assertion to be true - which is the entire reason the throw exists.
  return context;
}
