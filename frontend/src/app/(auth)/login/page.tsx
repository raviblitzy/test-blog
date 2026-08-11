'use client';

/* =================================================================================================
 * src/app/(auth)/login/page.tsx - the sign-in screen, served at /login.
 *
 * Discharges the log-in half of AAP requirement R1 ("Users can sign up, log in" with "JWT
 * authentication"). AAP §0.7.3.1 fixes the rendering mode as CLIENT and the deliverable as a
 * "validated credential form with inline field errors and submission feedback", which is the whole
 * of what this file is.
 *
 * The only file in its directory, by design. Route boundaries live at the src/app/ root, the group
 * shell is (auth)/layout.tsx, and every frontend test lives under frontend/tests/.
 *
 * -------------------------------------------------------------------------------------------------
 * 1. THE URL IS /login, AND `(auth)` IS NOT PART OF IT
 *
 * `(auth)` is a route GROUP: a filesystem grouping directory whose name is ERASED from the URL. So
 * this file serves /login, and a link or redirect written from the directory name compiles,
 * type-checks, lints, renders - and 404s at run time. Not one address below is spelled that way, and
 * the two this file does name (/login and /signup) are module constants so they are spelled once.
 *
 * -------------------------------------------------------------------------------------------------
 * 2. WHY THE FORM SITS INSIDE A <Suspense> BOUNDARY
 *
 * {@link LoginForm} calls `useSearchParams()`, which reads EMPTY while a route is being prerendered -
 * and this route is prerendered. `next build` reports it as `○ /login`, static content, because it is
 * a Client Component with no dynamic signal on the server at all: no `searchParams` prop is read, no
 * cookie, no header. That is the difference from src/app/page.tsx, which deliberately carries no
 * boundary because reading `searchParams` in its exported functions makes it server-rendered on
 * demand. A client file also cannot export route-segment config (`dynamic`, `revalidate`, `runtime`),
 * so opting this route out of prerendering is not available either.
 *
 * THE BOUNDARY IS WHAT PUTS THE HEADING IN THE PRERENDERED HTML, and that was measured on this
 * version of the framework rather than assumed - `next build` succeeds either way on Next 16.3.0, so
 * a build that passes proves nothing here. The evidence is the prerendered document itself,
 * .next/server/app/login.html, built both ways:
 *
 * | Configuration | `<h1>` in the HTML | fallback text | the form's fields |
 * | ------------- | ------------------ | ------------- | ----------------- |
 * | with boundary | 1                  | 1             | deferred          |
 * | no boundary   | **0**              | 0             | deferred          |
 *
 * Without it, the framework takes the WHOLE page out of the static output - heading included - and
 * the delivered document carries no part of this screen until JavaScript has run. With it, the
 * heading is prerendered and only the URL-dependent subtree is deferred, which is exactly the split
 * this file wants.
 *
 * So the h1 stays OUTSIDE the boundary, in the card's header, and the fallback carries no heading of
 * its own. The single-h1 invariant then holds during the fallback as well as after it.
 *
 * -------------------------------------------------------------------------------------------------
 * 3. THIS FILE IS THE SOLE VALIDATOR OF THE `next` PARAMETER
 *
 * src/middleware.ts refuses /dashboard/*, /posts/* and /admin/* to an unauthenticated visitor and
 * redirects to /login?next=<the path it refused>. Its own header states the three things the sign-in
 * form owes in return: bounce back to that path, default to '/' when the parameter is absent, and
 * REJECT anything that is not a same-origin relative path. The middleware only ever writes a path
 * taken from a request it is already serving, so every ounce of the danger is on this, the reading
 * side - the parameter is attacker-controlled in exactly the way a phished link is.
 *
 * {@link resolveSafeNext} is that validator. It is pure, module-local and total: every input yields
 * either the input unchanged or {@link FALLBACK_ROUTE}.
 *
 * -------------------------------------------------------------------------------------------------
 * 4. GOVERNING STANDARDS
 *
 * `review_rules` reports NO user-specified rules for this project - a complete answer, not a
 * truncated one - so nothing here is invented to satisfy one, and their absence is not licence to
 * lower the bar. The binding constraints are AAP §0.10.1's enterprise standards and AAP §0.8.5's
 * design-system rules. Nine of the former govern this file:
 *
 *   Layered separation of concerns   Presentation only. No transport code, no URL, no header, no
 *       serialisation. The form calls `useAuth().login(...)` and nothing lower; the provider owns
 *       the cookie and the credential store, @/lib/api/client owns HTTP, and @/lib/api/auth owns the
 *       one place the address is mapped onto the OAuth 2 grant's `username` field.
 *   Pinned, reproducible dependencies  Five packages, every one already in frontend/package.json.
 *       Nothing is added.
 *   Explicit API contracts           Failures are read through the single normalised problem
 *       document, by the documented `isApiError` guard, using the wire's own snake_case names.
 *   Secure-by-default authentication A password is never logged, echoed, stored past its submission
 *       or written to an attribute; no token is decoded, parsed or inspected; a rate-limit refusal
 *       is surfaced rather than silently retried; a `401` is reported without disclosing whether the
 *       address exists; and no authority is claimed here, because authority is the service's.
 *   Blocking quality gates           Strict `tsc --noEmit`, `eslint --max-warnings=0`, `next build`,
 *       prettier, Vitest and Playwright at 375/768/1440 all pass. No `any`, no `@ts-ignore`, no
 *       suppression comment of any kind.
 *   Zero hardcoded presentation values  Every class below is a semantic token or a step on one of
 *       the engine's own scales. The permitted literals never appear because none is needed.
 *   Accessibility as a floor         One h1; both controls named by a real <Label htmlFor>; the
 *       invalid state carried by `aria-invalid` AND by text; each message referenced through
 *       `aria-describedby`; the pending state announced as words rather than as an appearance.
 *   Configuration from the environment only  Expressed here as a prohibition: this file reads NO
 *       environment variable, not even a NEXT_PUBLIC_ one.
 *   No secrets in the repository     No credential appears, as a default value or otherwise, and the
 *       seeded administrator's variables are not named.
 *
 * -------------------------------------------------------------------------------------------------
 * 5. DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT HERE.
 *
 *   1. `metadata` or `generateMetadata`. Illegal in a client file, and (auth)/layout.tsx is the
 *      group's single metadata site - it already declares the shared title and `noindex, follow`.
 *   2. An import of @/lib/api/auth. Its `login` bypasses the provider's cookie and credential-store
 *      writes, so calling it here would open a second credential path and leave the session
 *      half-established with both halves believing they owned the transition.
 *   3. A locally declared, extended or re-derived schema. @/lib/validation/auth is its single
 *      definition site, and a second copy is how a client silently becomes stricter than the API.
 *   4. Renaming `email` to `username`. That is the OAuth 2 password grant's field name, and mapping
 *      onto it belongs to @/lib/api/auth alone. See {@link toLoginFieldError} for the one place this
 *      distinction has a visible consequence.
 *   5. A provider of any kind. The root layout mounts ThemeProvider, QueryProvider and AuthProvider
 *      once each; a second AuthProvider here would create a divergent session that no error reports.
 *   6. A cookie, storage or credential-store write, and any reading of a token. Not one of
 *      `setCredentials`, `clearCredentials`, `getAccessToken` or `AUTH_COOKIE_NAME` is named.
 *   7. `sonner`. The destructive Alert is the designated submission-error surface for this group: a
 *      toast for a form failure disappears before a screen-reader user reaches the control it
 *      concerns, and cannot be referenced by `aria-describedby`.
 *   8. `lucide-react`, and so no password-visibility toggle. It is not requested, and it would need
 *      both an icon and a second control beside the field.
 *   9. `@tanstack/react-query`. Signing in is not cached, shared or invalidated data; it is one
 *      action whose state is the form's own `isSubmitting`.
 *  10. `next/image`, a stylesheet of any kind, an import of globals.css, an inline style, an
 *      `!important`, and any `dark:` variant or `useTheme` call. The twelve semantic tokens each
 *      carry a light and a dark value, so this file re-themes for free.
 *  11. A raw <button>, <input>, <textarea>, <select> or <table>. Those belong inside
 *      src/components/ui/ and are reached here through the primitives that wrap them once.
 *  12. `decodeURIComponent`. See {@link resolveSafeNext}; calling it would be a defect, not an
 *      omission.
 *  13. A password-reset link, an email-verification notice or a federated "Continue with ..."
 *      control. AAP §0.9.3 excludes all three, and an affordance for a capability the product does
 *      not have is a dead end a locked-out visitor tries first.
 *  14. Anything from the retired demo surface - its collection route, its model or that model's
 *      three-field shape. An integration test asserts their absence from the delivered product, and
 *      a sign-in form has no use for them; the guard is against copied boilerplate.
 * ============================================================================================== */

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { FormEvent, JSX } from 'react';
import { Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import { isApiError } from '@/lib/api/client';
import type { LoginRequest, ProblemDetail, ValidationErrorItem } from '@/lib/types';
import { cn } from '@/lib/utils';
import { loginSchema } from '@/lib/validation/auth';
import type { LoginFormValues } from '@/lib/validation/auth';

/* -------------------------------------------------------------------------------------------------
 * Addresses
 *
 * Spelled once each, because a route GROUP name is erased from the URL and an address written from
 * the directory layout fails only at run time. None of these is a parenthesised path.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Where a sign-in goes when the request carried no usable return target.
 *
 * The home feed: public, always present, and the one address that cannot itself require a session.
 * Every rejection in {@link resolveSafeNext} lands here, so a hostile parameter is not an error the
 * visitor has to understand - it is simply a sign-in that finishes at the front page.
 */
const FALLBACK_ROUTE = '/';

/** This route. Named so {@link isCredentialRoute} can refuse to bounce a sign-in back to it. */
const LOGIN_ROUTE = '/login';

/** The sibling credential screen, linked from the card's footer. */
const SIGNUP_ROUTE = '/signup';

/**
 * The query parameter carrying the return target.
 *
 * Matches `RETURN_TO_PARAM` in src/middleware.ts, which writes it, and in
 * src/app/(dashboard)/layout.tsx, whose sign-in link writes it too. All three must agree
 * character for character; nothing in the type system relates them.
 */
const RETURN_TO_PARAM = 'next';

/* -------------------------------------------------------------------------------------------------
 * The open-redirect guard
 *
 * The security control of this route group. Read section 3 of the file header first.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Matches any ASCII control character.
 *
 * Rejected outright rather than stripped. A browser removes tab, carriage return and line feed from
 * a URL before resolving it, so a value containing one does not mean what it appears to mean:
 * `/\thttps://evil.com` reads as an innocuous relative path and normalises into an absolute one.
 * Refusing the whole value is the only test that cannot be defeated by where the character sits.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/** Splits a return target at the start of its query string or fragment, whichever comes first. */
const QUERY_OR_FRAGMENT = /[?#]/;

/**
 * The path part of a return target: everything before its query string and fragment.
 *
 * @param target - A value that has already been established to begin with a single `/`.
 * @returns The path, which is the whole value when it carries neither a query nor a fragment.
 */
function pathnameOf(target: string): string {
  const boundary = target.search(QUERY_OR_FRAGMENT);

  return boundary === -1 ? target : target.slice(0, boundary);
}

/**
 * Whether a path addresses one of the two credential screens.
 *
 * Bouncing a SUCCESSFUL sign-in back to /login or /signup would present a form the visitor has just
 * completed, which reads as a failure - and on /login specifically it would look like the credential
 * was rejected. So both are refused and the visitor lands on the feed instead.
 *
 * A single trailing slash is normalised away before comparing, because `/login/` addresses this same
 * route once the framework normalises it, and comparison is case-insensitive even though App Router
 * paths are case-sensitive: `/Login` is a 404 rather than a credential screen, so treating it as one
 * only ever sends a visitor somewhere that exists.
 *
 * @param path - The path part of a candidate return target.
 * @returns `true` when the path is a credential screen and must not be returned to.
 */
function isCredentialRoute(path: string): boolean {
  const normalised = (
    path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  ).toLowerCase();

  return normalised === LOGIN_ROUTE || normalised === SIGNUP_ROUTE;
}

/**
 * Resolve the `next` parameter into an address it is safe to navigate to.
 *
 * PURE and total: no hook, no `window`, no `document`, no router, no state, and the same input
 * always yields the same output. That is what makes it testable through the rendered page and
 * reviewable on its own.
 *
 * ### It REJECTS; it never sanitises
 *
 * Every failure returns {@link FALLBACK_ROUTE} and the accepted value is returned VERBATIM. Nothing
 * is trimmed, unescaped or stripped-and-retried, because strip-and-retry is itself a bypass: each
 * pass produces a new string that the previous pass's rules never saw.
 *
 * ### It does NOT decode
 *
 * `useSearchParams().get()` is backed by `URLSearchParams`, which returns the value ALREADY DECODED.
 * A second `decodeURIComponent` would therefore be one decode too many, and that is not a
 * cosmetic surplus - it is the subtlest defect this file could contain. A doubly-encoded
 * `%252F%252Fevil.com` arrives here as `%2F%2Fevil.com`, which this function rejects on the leading
 * `%`; decode it again and it becomes `//evil.com`, a protocol-relative URL that navigates
 * off-site while still looking like a path in the address bar.
 *
 * ### What survives
 *
 * Only a same-origin absolute path: exactly one leading `/`, with the next character neither `/` nor
 * `\`, no ASCII control character anywhere, and a path that is not a credential screen. A query
 * string and a fragment may follow and are preserved, so `/dashboard?tab=drafts` and
 * `/blog/a-slug#comments` both round-trip intact.
 *
 * Requiring the leading `/` is what makes a scheme check unnecessary rather than merely convenient:
 * no scheme can produce it, so `javascript:`, `data:`, `vbscript:`, `https://evil.com` and
 * `HTTPS://EVIL.COM` all fail the same test, and the question of case never arises. `//evil.com` and
 * `/\evil.com` fail on the second character, which is the pair that a leading-slash test alone
 * would let through - a protocol-relative URL and the backslash form that browsers normalise into
 * one.
 *
 * @param raw - The parameter exactly as `useSearchParams().get()` returned it, or `null` when the
 * URL carried none. Duplicated parameters need no special handling: `.get()` answers with the first,
 * which is a definite choice rather than an ambiguous one.
 * @returns The return target, or {@link FALLBACK_ROUTE} for every value that is not provably a safe
 * same-origin path.
 */
function resolveSafeNext(raw: string | null): string {
  // Absent, and the ordinary case: most visitors arrive at /login by choice rather than by refusal.
  if (raw === null || raw.length === 0) {
    return FALLBACK_ROUTE;
  }

  // Before anything is read positionally, because a control character changes what the rest of the
  // value MEANS once a browser has stripped it.
  if (CONTROL_CHARACTERS.test(raw)) {
    return FALLBACK_ROUTE;
  }

  // Exactly one leading slash. This single test disposes of every absolute URL, every dangerous
  // scheme, every relative path (`dashboard`, `./dashboard`, `../admin`) and every whitespace-only
  // value, in every combination of case.
  if (!raw.startsWith('/')) {
    return FALLBACK_ROUTE;
  }

  // The second character decides whether the value is a path or an authority. `charAt` is used
  // rather than an index because it answers with '' past the end, so a bare '/' needs no separate
  // length check.
  const second = raw.charAt(1);

  if (second === '/' || second === '\\') {
    return FALLBACK_ROUTE;
  }

  if (isCredentialRoute(pathnameOf(raw))) {
    return FALLBACK_ROUTE;
  }

  return raw;
}

/**
 * The sibling screen's address, carrying the return target across.
 *
 * (auth)/layout.tsx deliberately leaves this cross-link to the pages and records why: only the page
 * knows which sibling it should point at, and this one owes the `next` value onward. Without that,
 * a visitor refused at /posts/new who chooses to register instead loses the destination they were
 * heading for and lands on the feed after signing up.
 *
 * The value forwarded is the VALIDATED one, so a hostile parameter is never propagated - it has
 * already collapsed to {@link FALLBACK_ROUTE}, and a target equal to the fallback is omitted rather
 * than written out, keeping the common link clean.
 *
 * `encodeURIComponent` is what makes a path carrying its own query string survive as ONE parameter,
 * and it is the same encoding src/middleware.ts and (dashboard)/layout.tsx apply when they write
 * this contract.
 *
 * @param returnTo - A target already through {@link resolveSafeNext}.
 * @returns `/signup`, or `/signup?next=<encoded target>`.
 */
function signupHref(returnTo: string): string {
  if (returnTo === FALLBACK_ROUTE) {
    return SIGNUP_ROUTE;
  }

  return `${SIGNUP_ROUTE}?${RETURN_TO_PARAM}=${encodeURIComponent(returnTo)}`;
}

/* -------------------------------------------------------------------------------------------------
 * Failure reporting
 *
 * Every rejection from the session layer arrives as ONE normalised problem document - there is a
 * single error contract for the whole API and @/lib/api/client maps every non-2xx response onto it -
 * so this section has one entry point and no second branch for a second shape.
 * ---------------------------------------------------------------------------------------------- */

/** The credential was refused. Deliberately indistinguishable between a wrong address and a wrong password. */
const UNAUTHORIZED_STATUS = 401;

/** The credential was right and the account is deactivated. */
const FORBIDDEN_STATUS = 403;

/** The request conflicts with the account's current state. */
const CONFLICT_STATUS = 409;

/** The service rejected a field. Carries `errors`, which is what makes a per-field message possible. */
const UNPROCESSABLE_CONTENT_STATUS = 422;

/** The rate-limit window is exhausted. Every authentication route is limited. */
const TOO_MANY_REQUESTS_STATUS = 429;

/** `setError`'s reason code for a message the SERVICE produced rather than the resolver. */
const SERVER_ERROR_TYPE = 'server';

/** A failure rendered as a headline and, when there is more worth saying, an explanation beneath it. */
interface FailureCopy {
  readonly headline: string;
  readonly explanation: string | null;
}

/**
 * The `401` message, and the one piece of copy in this file that is fixed rather than taken from the
 * service.
 *
 * ACCOUNT ENUMERATION IS THE DEFECT THIS PREVENTS. A message distinguishing "no such address" from
 * "wrong password" turns the sign-in form into an oracle: anyone can test an address and learn
 * whether it is registered, which is how a credential-stuffing list gets narrowed and how a private
 * membership stops being private. The service already answers both cases identically and its own
 * contract says a caller must present one message for both - so the document's `detail` is
 * deliberately NOT used here, even though it is used for every other status.
 *
 * The closing sentence says plainly that the ambiguity is intentional, because a visitor who has
 * mistyped their address deserves to know which two things to check rather than being left to assume
 * the form is broken.
 */
const INVALID_CREDENTIALS_COPY: FailureCopy = {
  headline: 'That email address or password is not correct.',
  explanation:
    'Check both and try again. For your security we do not say which of the two did not match.',
};

/**
 * The `403` message.
 *
 * Reached when the credential itself was accepted and `users.is_active` is false - a state an
 * administrator sets through the admin API, and one no amount of retrying will change. So the copy
 * names the cause and points at the only person who can undo it, rather than inviting another
 * attempt.
 */
const DEACTIVATED_ACCOUNT_COPY: FailureCopy = {
  headline: 'This account has been deactivated.',
  explanation:
    'Its password is still correct, but an administrator has turned off access. Ask them to restore ' +
    'the account, then sign in again.',
};

/** Headline for a throttled window. */
const RATE_LIMITED_HEADLINE = 'Too many sign-in attempts.';

/** Explanation for a throttled window whose response named no interval. */
const RATE_LIMITED_EXPLANATION =
  'The service is temporarily refusing further attempts from here. Wait a short while, then try again.';

/** Headline for anything with no usable prose of its own - a network failure, or an empty document. */
const UNEXPECTED_FAILURE_HEADLINE = 'Your sign-in could not be completed.';

/** Explanation paired with {@link UNEXPECTED_FAILURE_HEADLINE}. */
const UNEXPECTED_FAILURE_EXPLANATION =
  'Something went wrong before the service could answer. Check your connection and try again.';

/** The whole of what a rejection that never reached the API is allowed to say. */
const UNEXPECTED_FAILURE_COPY: FailureCopy = {
  headline: UNEXPECTED_FAILURE_HEADLINE,
  explanation: UNEXPECTED_FAILURE_EXPLANATION,
};

/**
 * Describe how long the visitor must wait, when the refusal said so.
 *
 * Worth surfacing rather than dropping: an attempt made inside this interval is refused again, so
 * someone who is not told the interval reads a working form as a broken one. Guarded against a
 * non-finite or non-positive value so a malformed `Retry-After` degrades to the generic sentence
 * instead of rendering "Try again in NaN seconds".
 *
 * @param seconds - `ApiError.retryAfterSeconds`, or `null` when the response carried no interval.
 * @returns A sentence, or `null` when there is no interval worth reporting.
 */
function describeRetryInterval(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  const whole = Math.ceil(seconds);

  return `Try again in ${String(whole)} ${whole === 1 ? 'second' : 'seconds'}.`;
}

/**
 * Join the sentences that are actually present into one paragraph.
 *
 * @param parts - Sentences, any of which may be absent.
 * @returns The joined paragraph, or `null` when none of them was present.
 */
function joinSentences(...parts: readonly (string | null)[]): string | null {
  const present = parts.filter((part): part is string => part !== null && part.length > 0);

  return present.length > 0 ? present.join(' ') : null;
}

/**
 * Report a problem document in the service's own words.
 *
 * `title` is the constant summary of the problem KIND and `detail` the sentence about this specific
 * request, so the title becomes the headline and the detail the explanation beneath it - unless the
 * detail merely repeats the title, in which case it is dropped rather than said twice. This mirrors
 * how the administrative surfaces report the same contract, so one error shape is reported one way
 * across the product.
 *
 * `instance`, `type`, `status` and `request_id` are never rendered. They are correlation and
 * classification data for a log, and a visitor cannot act on any of them.
 *
 * @param problem - The document, exactly as the client normalised it.
 * @param retry - A wait sentence from {@link describeRetryInterval}, appended when present.
 * @returns Copy safe to show to the person who caused the failure.
 */
function describeProblem(problem: ProblemDetail, retry: string | null): FailureCopy {
  const title = problem.title.trim();
  const detail = problem.detail.trim();

  if (title.length > 0) {
    const explanation = detail.length > 0 && detail !== title ? detail : null;

    return { headline: title, explanation: joinSentences(explanation, retry) };
  }

  if (detail.length > 0) {
    return { headline: detail, explanation: retry };
  }

  return {
    headline: UNEXPECTED_FAILURE_HEADLINE,
    explanation: joinSentences(UNEXPECTED_FAILURE_EXPLANATION, retry),
  };
}

/**
 * Turn any rejection into copy for the form-level notice.
 *
 * The two fixed branches are the ones where the service's own prose is either unsafe to repeat
 * (`401`, which must not say which half was wrong) or less actionable than a definite sentence
 * (`403` and `429`). Everything else - `409`, an unexpected `4xx`, a `5xx`, and a `422` whose field
 * detail named nothing on this form - is reported in the service's words, which are more specific
 * than anything that could be written here in advance.
 *
 * A rejection that is not a problem document at all reached no service: an offline browser, a
 * refused preflight, an aborted request. It gets {@link UNEXPECTED_FAILURE_COPY} and never its own
 * `message`, because that string is written for a developer and can carry a URL or an internal
 * detail that has no business on a credential screen.
 *
 * @param failure - The rejection, still unnarrowed.
 * @returns Copy for {@link Alert}.
 */
function resolveFailureCopy(failure: unknown): FailureCopy {
  if (!isApiError(failure)) {
    return UNEXPECTED_FAILURE_COPY;
  }

  const retry = describeRetryInterval(failure.retryAfterSeconds);

  switch (failure.status) {
    case UNAUTHORIZED_STATUS:
      return INVALID_CREDENTIALS_COPY;

    case FORBIDDEN_STATUS:
      return DEACTIVATED_ACCOUNT_COPY;

    case TOO_MANY_REQUESTS_STATUS:
      return {
        headline: RATE_LIMITED_HEADLINE,
        // No automatic retry anywhere in this file: retrying inside the window is refused again and
        // spends the visitor's next allowance. The interval is reported and the choice stays theirs.
        explanation: retry ?? RATE_LIMITED_EXPLANATION,
      };

    // A conflict is named explicitly rather than left to fall through unremarked, and then reported
    // in the service's words on purpose: only the service knows what conflicted.
    case CONFLICT_STATUS:
    default:
      return describeProblem(failure.problem, retry);
  }
}

/* -------------------------------------------------------------------------------------------------
 * Field-level failures
 * ---------------------------------------------------------------------------------------------- */

/**
 * The two fields this form registers.
 *
 * Derived from the schema's inferred output rather than written out, so a change to
 * @/lib/validation/auth cannot leave a stale literal behind here.
 */
type LoginFieldName = keyof LoginFormValues;

/**
 * Match a validation item to a control on THIS form, or refuse it.
 *
 * The field name is checked against the two known keys rather than trusted, because `field` is a
 * dotted path in the submitted body's own syntax and the body is not this form: it may name a
 * nested member, it may be empty when the failure cannot be attributed, and on this route it may
 * name `username` - the field the OAuth 2 password grant uses to carry the address. Handing an
 * unmatched name to `setError` would attach a message to a control that does not exist, where no
 * visitor would ever see it.
 *
 * `username` is deliberately NOT mapped onto the email control. That mapping is @/lib/api/auth's
 * alone, and reproducing it here would put a second, divergent copy of the grant encoding in the
 * presentation tier. An item naming it therefore falls back to the form-level notice, where it is
 * still read.
 *
 * @param item - One entry from the document's `errors` array.
 * @returns The control and the message to attach, or `null` when the item names nothing on this form
 * or carries no message worth rendering.
 */
function toLoginFieldError(
  item: ValidationErrorItem,
): { field: LoginFieldName; message: string } | null {
  const field = item.field.trim();
  const message = item.message.trim();

  if (message.length === 0) {
    return null;
  }

  if (field === 'email' || field === 'password') {
    return { field, message };
  }

  return null;
}

/**
 * Pin a `422`'s field detail onto the controls that caused it.
 *
 * A `422` is the one failure with somewhere better to put its message than a summary notice: a
 * visitor told only that "the request was invalid" has to guess which of two fields to change. The
 * message goes under the control instead, wired through `aria-describedby`, with the control marked
 * `aria-invalid` by the primitive.
 *
 * `errors` is omitted entirely rather than sent empty when there is no field detail, so its presence
 * is a complete test and a length check would add nothing.
 *
 * @param failure - The rejection, still unnarrowed.
 * @param attach - `setError`, narrowed to this form's two fields.
 * @returns `true` when at least one message was attached, which is what tells the caller a
 * form-level notice would be redundant. `false` leaves the caller to report the failure as a whole -
 * including for a `422` whose every item named a field this form does not have.
 */
function attachFieldFailures(
  failure: unknown,
  attach: (field: LoginFieldName, message: string) => void,
): boolean {
  if (
    !isApiError(failure) ||
    failure.status !== UNPROCESSABLE_CONTENT_STATUS ||
    failure.errors === undefined
  ) {
    return false;
  }

  let attached = false;

  for (const item of failure.errors) {
    const mapped = toLoginFieldError(item);

    if (mapped !== null) {
      attach(mapped.field, mapped.message);
      attached = true;
    }
  }

  return attached;
}

/**
 * Join the ids that are actually present into an `aria-describedby` value.
 *
 * `undefined` rather than `''` when nothing applies, because an empty `aria-describedby` points at
 * nothing and is worse than an absent one. Deliberately not `cn`: that composes CLASS names and
 * resolves conflicts between them, and running an identifier list through a class-conflict resolver
 * is a category error waiting to misbehave.
 *
 * @param ids - Identifiers, any of which may be absent or conditionally `false`.
 * @returns The space-separated list, or `undefined`.
 */
function describedBy(...ids: readonly (string | false | null | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);

  return present.length > 0 ? present.join(' ') : undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Copy
 *
 * Declared as constants because each string is asserted on by the end-to-end journey, which selects
 * by accessible name and visible text rather than by class name - so a wording change is a change
 * with a known blast radius instead of a surprise.
 * ---------------------------------------------------------------------------------------------- */

/** The page's single heading. */
const HEADING_TEXT = 'Sign in';

/** One line under the heading saying what the form is for. */
const INTRO_TEXT = 'Use the email address and password you registered with.';

/** The email control's visible label, and therefore its accessible name. */
const EMAIL_LABEL = 'Email address';

/** The password control's visible label, and therefore its accessible name. */
const PASSWORD_LABEL = 'Password';

/** The submit control at rest. */
const SUBMIT_TEXT = 'Sign in';

/**
 * The submit control while a sign-in is in flight.
 *
 * A DIFFERENT WORD, not merely a dimmer button: the pending state has to be readable without
 * perceiving colour or opacity, and a disabled control that still says "Sign in" tells a screen
 * reader nothing has changed.
 */
const SUBMIT_PENDING_TEXT = 'Signing in…';

/** Leading half of the footer's cross-link line. */
const SIGNUP_PROMPT_TEXT = 'Don’t have an account?';

/** The cross-link's visible text, and its accessible name. Descriptive enough to read out of context. */
const SIGNUP_LINK_TEXT = 'Create an account';

/** What the Suspense fallback says while the form's own module is still arriving. */
const FALLBACK_TEXT = 'Loading the sign-in form…';

/* -------------------------------------------------------------------------------------------------
 * Class tables
 *
 * Module constants so the markup below reads as structure rather than as a wall of utilities, and
 * composed through `cn` so a later class resolves last-wins within its own Tailwind group instead of
 * being decided by stylesheet source order. Every value is a semantic token from the tier's only
 * stylesheet or a step on one of the engine's own scales: there is not one literal colour, length,
 * radius, shadow or font size among them, no `dark:` variant, and no media query.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The form's column.
 *
 * `gap-5` rather than margins between siblings, so the spacing survives a field's error paragraph
 * appearing and disappearing. The notice, the two fields and the submit control are the four
 * children.
 */
const FORM_LAYOUT = 'flex flex-col gap-5';

/**
 * One field: label, control, and the error paragraph when there is one.
 *
 * `min-w-0` removes a flex item's automatic content-based minimum, which is what keeps a long
 * validation message from widening the column and pushing the panel past the viewport at 375px.
 */
const FIELD_LAYOUT = 'flex min-w-0 flex-col gap-2';

/**
 * A field's validation message.
 *
 * `text-danger` measures 5.86:1 on the light recessed ground and 5.07:1 on the dark one, so it clears
 * the 4.5:1 body-text floor in both themes. The colour is never the signal on its own: this element
 * is real text, and the control it belongs to is marked `aria-invalid` by the primitive.
 */
const FIELD_ERROR = 'text-danger text-xs font-medium';

/**
 * The submit control.
 *
 * Full width, because it is the screen's single primary action and a narrow button beside empty space
 * in a 28rem panel reads as secondary. The primitive already supplies the 44px height, the token
 * fill and the focus treatment.
 */
const SUBMIT_LAYOUT = 'w-full';

/**
 * The heading.
 *
 * `text-2xl` overrides the card primitive's own type step because this is a PAGE heading rather than
 * a card heading inside a feed - the same override src/app/error.tsx makes for the same reason. Both
 * values are `--text-*` tokens.
 */
const HEADING_CLASSES = 'text-2xl';

/** The line under the heading. Secondary emphasis; `muted-foreground` still clears 4.5:1 in both themes. */
const INTRO_CLASSES = 'text-muted-foreground text-sm';

/** The footer's cross-link line, which is ordinary prose with one link inside it. */
const SIGNUP_PROMPT_CLASSES = 'text-muted-foreground text-sm';

/**
 * The cross-link to /signup.
 *
 * `underline` is present AT REST rather than only on hover: this link sits inside a sentence, so
 * without it the affordance would be carried by colour alone. `text-primary` measures 6.44:1 on the
 * light surface and 4.70:1 on the tightest dark ground, and the hover colour steps to `accent`
 * (8.07:1 and 8.88:1) so the state change is legible without the underline having to move.
 *
 * `min-h-11` gives the anchor a 44px activation height, clearing the WCAG 2.5.5 target-size floor
 * that a `text-sm` line box alone would miss - the same reasoning (auth)/layout.tsx records for its
 * route home, and no design source specifies a smaller target because the plan records no design
 * source at all. `rounded-sm` exists to SHAPE the document-wide `:focus-visible` ring rather than to
 * draw a second one. The transition is gated on the engine's own reduced-motion variant.
 */
const SIGNUP_LINK_CLASSES = cn(
  'inline-flex min-h-11 items-center rounded-sm',
  'font-medium text-primary underline underline-offset-4',
  'hover:text-accent',
  'motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out',
);

/**
 * A placeholder bar in the Suspense fallback.
 *
 * The same vocabulary `@/components/ui/skeleton` uses - the recessed fill token, the engine's
 * `--animate-pulse` token and its radius token - reproduced here rather than imported, because that
 * primitive is outside this file's sanctioned consumption list. `motion-reduce:animate-none` and not
 * `motion-safe:animate-pulse`, for the reason that file records: the bare utility can be overridden
 * by a caller's `animate-none`, and the prefixed one cannot.
 */
const FALLBACK_BAR = cn('bg-surface-muted animate-pulse rounded-md', 'motion-reduce:animate-none');

/** A label-sized placeholder bar. `h-4` matches the label's line box; `w-28` is a spacing-scale step. */
const FALLBACK_LABEL_BAR = cn(FALLBACK_BAR, 'h-4 w-28');

/** A control-sized placeholder bar. `h-11` is exactly the height `Input` renders at. */
const FALLBACK_CONTROL_BAR = cn(FALLBACK_BAR, 'h-11 w-full');

/** A placeholder for the footer's cross-link line, so the panel does not change height on swap. */
const FALLBACK_PROMPT_BAR = cn(FALLBACK_BAR, 'h-4 w-56');

/**
 * The fallback's action row.
 *
 * Occupies the submit control's place and its `min-h-11` height, which is what makes the fallback and
 * the form the same height to the pixel - so the panel does not jump when one replaces the other.
 * Putting the loading sentence here rather than adding a line of its own is what buys that: the row
 * that says "you cannot act yet" is exactly the row the action will occupy.
 */
const FALLBACK_ACTION = 'flex min-h-11 items-center justify-center';

/** The fallback's sentence. */
const FALLBACK_TEXT_CLASSES = 'text-muted-foreground text-sm';

/* -------------------------------------------------------------------------------------------------
 * The form
 * ---------------------------------------------------------------------------------------------- */

/**
 * The credential form and the footer's cross-link: everything on this screen that depends on the URL.
 *
 * Module-local and unexported. It exists as a separate component for one structural reason - it reads
 * `useSearchParams()`, so it must sit inside the `<Suspense>` boundary that {@link LoginPage} places
 * around it, while the heading must stay outside. See section 2 of the file header.
 *
 * It renders the card's content and footer slots rather than a wrapper of its own, so those two
 * remain direct children of the panel and the boundary contributes no element to the layout.
 *
 * @returns The form, and the cross-link that carries the return target onward.
 */
function LoginForm(): JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Exactly three members, of the eight the session context carries. `user` is not read: this screen
  // renders nothing about the account, and `isAuthenticated` already answers the only question it has.
  const { isAuthenticated, isLoading, login } = useAuth();

  /**
   * The form-level notice, or `null` when there is nothing to report.
   *
   * Holds copy and never a submitted value: no password, and no rejected credential of any kind,
   * reaches component state, a data attribute, a log line or the DOM.
   */
  const [failure, setFailure] = useState<FailureCopy | null>(null);

  // Generated rather than hardcoded, so nothing collides if this form is ever rendered twice on one
  // document. `Label`'s `htmlFor` and its control's `id` are paired from the same value, which is what
  // gives each control its accessible name.
  const emailId = useId();
  const emailErrorId = useId();
  const passwordId = useId();
  const passwordErrorId = useId();

  /** Validated once per render, and the only value read out of the URL. */
  const returnTo = resolveSafeNext(searchParams.get(RETURN_TO_PARAM));

  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
    setError,
  } = useForm<LoginFormValues>({
    // Empty, never a demonstration credential: a pre-filled address or password would be a secret
    // committed to the repository and a hint to anyone who opens the page.
    defaultValues: { email: '', password: '' },
    resolver: zodResolver(loginSchema),
  });

  /**
   * Whether this component has already navigated away.
   *
   * A ref rather than state, because nothing renders differently for it and a re-render is not
   * wanted. It makes the navigation happen EXACTLY ONCE however it is reached: a successful
   * submission navigates directly, and the same success also flips `isAuthenticated`, which fires the
   * effect below - so without this guard one sign-in would issue two identical replacements.
   */
  const hasLeftRef = useRef(false);

  /**
   * Leave for the return target, at most once.
   *
   * `replace` rather than `push`, so the credential screen does not sit in the browser's history: a
   * back-press after signing in should return to whatever preceded the sign-in, not to a form the
   * visitor has already completed - which would look like being signed out again.
   */
  const leaveForReturnTarget = useCallback((): void => {
    if (hasLeftRef.current) {
      return;
    }

    hasLeftRef.current = true;
    router.replace(returnTo);
  }, [returnTo, router]);

  /**
   * Send an already-signed-in visitor on to the target instead of showing them a form they do not
   * need - the case where someone reaches /login from a bookmark, or from a link in an old email,
   * with a live session.
   *
   * In an effect and never during render: navigating from a render body is a side effect in a pure
   * function, and React may run that body more than once per commit. Gated on `!isLoading` so the
   * one-time session restoration is allowed to finish first, because `user` is `null` while it runs
   * and redirecting on that would send every visitor away from the form they came for.
   */
  useEffect(() => {
    if (isLoading || !isAuthenticated) {
      return;
    }

    leaveForReturnTarget();
  }, [isAuthenticated, isLoading, leaveForReturnTarget]);

  /**
   * Every control is inert while a submission is in flight, while the session is still being
   * restored, and once a session exists and the replacement is on its way. One value, because the
   * three are not independent choices: in all three the form has nothing useful to accept.
   */
  const controlsDisabled = isSubmitting || isLoading || isAuthenticated;

  /**
   * The submit path, assembled when the form is SUBMITTED rather than while it renders.
   *
   * That placement is load-bearing twice over, so it should not be flattened back into a
   * `const submit = handleSubmit(...)` at the top of the component:
   *
   *   * `handleSubmit(...)` would then be a call made DURING RENDER receiving a callback that reaches
   *     {@link leaveForReturnTarget}, and so reaches a ref. `react-hooks/refs` rejects exactly that
   *     ("passing a ref to a function may read its value during render"), and it is right to: it
   *     cannot know the callback runs later. `eslint --max-warnings=0` is a blocking gate and no
   *     suppression comment is permitted, so the fix is to stop making the call during render.
   *   * The ref it protects is what keeps the navigation exactly-once, and the ref is the only
   *     construct that does so under BOTH possible orderings. A successful `login` populates the
   *     session, which flips `isAuthenticated` and fires the effect above; whether React commits that
   *     render before or after this function's `await` continuation resumes is a scheduling detail
   *     rather than a contract. A state flag read from this closure would be stale in one of the two
   *     orderings and issue a second replacement; a ref is read and written in the same synchronous
   *     block, so it is correct in both.
   *
   * The second argument is the resolver's own rejection path, supplied for ONE purpose: clearing a
   * stale notice. Without it a previous attempt's `401` would still be sitting above the fields on the
   * next submission the resolver rejects, and the visitor would read a fresh field error and a spent
   * server failure as one message.
   *
   * `void` states plainly that the returned promise is not awaited. It cannot reject: every failure
   * inside the handler is caught below and turned into rendered copy.
   */
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    void handleSubmit(
      async (values: LoginFormValues): Promise<void> => {
        setFailure(null);

        // Projected member by member rather than passed through. `loginSchema` is a strict object and
        // `LoginRequest` has exactly these two fields, so this is also the guard that keeps any state
        // the form might grow later out of a credential payload.
        const credentials: LoginRequest = { email: values.email, password: values.password };

        try {
          // Resolves to `void`: the account is context state, not a return value. There is nothing to
          // destructure, no token to read, and nothing to inspect.
          await login(credentials);
        } catch (error: unknown) {
          const attached = attachFieldFailures(error, (field, message): void => {
            setError(field, { message, type: SERVER_ERROR_TYPE });
          });

          if (!attached) {
            setFailure(resolveFailureCopy(error));
          }

          return;
        }

        leaveForReturnTarget();
      },
      (): void => {
        setFailure(null);
      },
    )(event);
  };

  return (
    <>
      <CardContent>
        {/* `noValidate` hands validation to the resolver alone. The browser's own bubbles would
            otherwise appear first, in wording nobody chose, for rules that are declared in
            @/lib/validation/auth - which is also why no control below carries `required`. */}
        <form className={FORM_LAYOUT} noValidate onSubmit={onSubmit}>
          {failure === null ? null : (
            // `destructive` selects both the tone and, inside the primitive, `role="alert"`. That is
            // why no `role`, `aria-live` or `aria-atomic` is written here: authoring one would put a
            // second live region around the same text and announce it twice.
            <Alert variant="destructive">
              <AlertTitle>{failure.headline}</AlertTitle>
              {failure.explanation === null ? null : (
                <AlertDescription>{failure.explanation}</AlertDescription>
              )}
            </Alert>
          )}

          <div className={FIELD_LAYOUT}>
            <Label htmlFor={emailId}>{EMAIL_LABEL}</Label>
            <Input
              aria-describedby={describedBy(errors.email !== undefined && emailErrorId)}
              autoComplete="email"
              disabled={controlsDisabled}
              id={emailId}
              // Drives the token error treatment AND `aria-invalid` inside the primitive, so the
              // attribute is deliberately not written here as well.
              invalid={errors.email !== undefined}
              type="email"
              {...register('email')}
            />
            {errors.email === undefined ? null : (
              <p className={FIELD_ERROR} id={emailErrorId}>
                {errors.email.message}
              </p>
            )}
          </div>

          <div className={FIELD_LAYOUT}>
            <Label htmlFor={passwordId}>{PASSWORD_LABEL}</Label>
            <Input
              aria-describedby={describedBy(errors.password !== undefined && passwordErrorId)}
              // `current-password`, not `new-password`: this form presents an existing credential, so
              // a password manager should offer the stored one rather than generate a replacement.
              autoComplete="current-password"
              disabled={controlsDisabled}
              id={passwordId}
              invalid={errors.password !== undefined}
              type="password"
              {...register('password')}
            />
            {errors.password === undefined ? null : (
              <p className={FIELD_ERROR} id={passwordErrorId}>
                {errors.password.message}
              </p>
            )}
          </div>

          {/* `type="submit"` is explicit because the primitive defaults to `button` - which is the
              right default there, and would silently make this control do nothing here. */}
          <Button className={SUBMIT_LAYOUT} disabled={controlsDisabled} type="submit">
            {isSubmitting ? SUBMIT_PENDING_TEXT : SUBMIT_TEXT}
          </Button>
        </form>
      </CardContent>

      <CardFooter>
        {/* The cross-link (auth)/layout.tsx leaves to the pages, carrying the return target onward so
            a visitor who registers instead of signing in still arrives where they were headed. The
            route home is NOT duplicated here; the shell owns that one. */}
        <p className={SIGNUP_PROMPT_CLASSES}>
          {SIGNUP_PROMPT_TEXT}{' '}
          <Link className={SIGNUP_LINK_CLASSES} href={signupHref(returnTo)}>
            {SIGNUP_LINK_TEXT}
          </Link>
        </p>
      </CardFooter>
    </>
  );
}

/**
 * What stands in for {@link LoginForm} until it is ready.
 *
 * Two field-shaped bars, a sentence where the submit control will be, and a bar where the cross-link
 * will be - so the panel is the same height before and after the swap and nothing on the screen
 * moves. The bars are decorative and say so with `aria-hidden`, which leaves the sentence as the only
 * thing announced; the sentence is real text rather than a live region, because there is nothing here
 * to interrupt anyone about.
 *
 * No `Skeleton` import: that primitive is outside this file's sanctioned consumption list, so the
 * bars are authored here from the same tokens it uses.
 *
 * @returns The placeholder content and footer.
 */
function LoginFormFallback(): JSX.Element {
  return (
    <>
      <CardContent>
        <div className={FORM_LAYOUT}>
          <div className={FIELD_LAYOUT}>
            <div aria-hidden="true" className={FALLBACK_LABEL_BAR} />
            <div aria-hidden="true" className={FALLBACK_CONTROL_BAR} />
          </div>

          <div className={FIELD_LAYOUT}>
            <div aria-hidden="true" className={FALLBACK_LABEL_BAR} />
            <div aria-hidden="true" className={FALLBACK_CONTROL_BAR} />
          </div>

          <div className={FALLBACK_ACTION}>
            <p className={FALLBACK_TEXT_CLASSES}>{FALLBACK_TEXT}</p>
          </div>
        </div>
      </CardContent>

      <CardFooter>
        <div aria-hidden="true" className={FALLBACK_PROMPT_BAR} />
      </CardFooter>
    </>
  );
}

/* -------------------------------------------------------------------------------------------------
 * The page
 * ---------------------------------------------------------------------------------------------- */

/**
 * The /login screen: one panel carrying the page's single heading and the credential form.
 *
 * The panel is composed here and nowhere else. (auth)/layout.tsx renders no card of its own - it
 * supplies only the centred, measure-constrained column and the route home - so this page owns the
 * surface, its four slots and its heading outright, and nothing nests inside anything.
 *
 * No measure, padding or breakpoint variant is added: the shell already caps the column at the
 * `--container-md` step and steps its inset up once at the `sm` breakpoint, so the card simply fills
 * what it is given and there is no horizontal overflow at 375px.
 *
 * Named `LoginPage` for readability; the framework keys on the file name and the default export,
 * never on the function's name.
 *
 * @returns The panel. The surrounding column is the group shell's, and the document, its landmarks
 * and its providers are the root layout's.
 */
export default function LoginPage(): JSX.Element {
  return (
    <Card>
      <CardHeader>
        {/* The route's single h1, emitted through the primitive's configurable heading level. The
            group shell contains no heading at all, so this is the only one on the page - and it sits
            outside the boundary below, which keeps that true during the fallback as well. */}
        <CardTitle as="h1" className={HEADING_CLASSES}>
          {HEADING_TEXT}
        </CardTitle>
        <p className={INTRO_CLASSES}>{INTRO_TEXT}</p>
      </CardHeader>

      {/* Load-bearing, not precautionary: everything inside reads the URL's query string, and section
          2 of the file header records the measurement - remove this boundary and the heading above
          leaves the prerendered document along with the rest of the screen. The boundary renders no
          element of its own, so the two card slots inside it stay direct children of the panel. */}
      <Suspense fallback={<LoginFormFallback />}>
        <LoginForm />
      </Suspense>
    </Card>
  );
}
