'use client';

// The sign-up screen - `/signup`.
//
// AAP §0.4.5.2 and §0.7.1.9 name exactly one file for this route, and this is it: there is no
// per-route layout, no extracted form module and no colocated test here. It serves R1 - "Users can
// sign up, log in" with "JWT authentication" - and is the ONE unauthenticated write surface in the
// product, which is why almost every decision below is about refusing to do slightly more than
// creating an account.
//
// -----------------------------------------------------------------------------------------------
// 1. WHAT THIS FILE IS *NOT* RESPONSIBLE FOR
//
// Three ancestors already render the frame, and repeating any of it would nest a landmark or a panel
// inside itself:
//
//   `src/app/layout.tsx`          <html suppressHydrationWarning>, <body>, the skip link, the
//                                 ThemeProvider -> QueryProvider -> AuthProvider nest, <SiteHeader>,
//                                 the <main> landmark, <SiteFooter> and sonner's <Toaster>.
//   `src/app/(auth)/layout.tsx`   the centred, measure-constrained column (max-w-md, gap-6, the
//                                 responsive padding), this route group's `metadata`, and the
//                                 group's single "back to home" link. It deliberately renders no
//                                 Card and no `h1`, so both belong here.
//   `src/app/globals.css`         every token. It is imported once, by the root layout.
//
// So this file mounts no provider, no <Toaster>, no landmark, no second back-to-home link and no
// stylesheet, and it declares no width, centring or breakpoint utility of its own. It renders a
// panel and a form inside a column that already has a measure.
//
// It also exports NO `metadata`, no `generateMetadata` and no route segment config. All three are
// Server-Component-only and are a build error beneath the `'use client'` directive above; the group
// layout is the metadata site for both credential routes.
//
// -----------------------------------------------------------------------------------------------
// 2. THE CREDENTIAL PATH IS `useAuth().register`, AND NOTHING ELSE
//
// This component performs no HTTP. `@/lib/api/auth` is deliberately NOT imported, and neither is any
// verb helper, cookie name or credential accessor from `@/lib/api/client` - only `ApiError`, to
// narrow a rejection. AAP §0.6.4 makes `@/providers/auth-provider` the single writer of the presence
// cookie and of client.ts's in-memory credential store, and `@/hooks/use-auth` states the same rule
// for itself. A second path to `POST /api/v1/auth/register` would create the account without those
// writes, leaving the session desynchronised while both halves believed they owned the transition.
//
// Nothing here reads an environment variable, and no versioned API path is spelled out: the base
// URL belongs to `@/lib/api/client`. No token is decoded, parsed or inspected in any form - `src/middleware.ts` is
// the one file in this tier licensed to read a payload, and that licence does not extend here. The
// password is passed straight through to `register` and is never logged, stored, echoed into a
// message or a toast, or retained after the call.
//
// -----------------------------------------------------------------------------------------------
// 3. WHERE A SUCCESSFUL REGISTRATION GOES
//
// `POST /api/v1/auth/register` answers `201` with the public account projection and issues no
// credential (AAP §0.6.2), and `register()` resolves to `void` rather than to an account. So this
// form cannot treat a success as a session, and it does not: it sends the new member to `/login`,
// carrying the `next` parameter through untouched, which completes an interrupted journey as
// `signup -> /login?next=X -> sign in -> X`.
//
// `@/providers/auth-provider` currently chooses to sign the reader in immediately after creating the
// account. That is the provider's documented policy and is none of this file's business - which is
// exactly why the destination is a fixed literal rather than something derived from the session. The
// two guards on {@link SignupFormPanel}'s already-signed-in branch exist for that policy: without
// them the panel would swap to "you are already signed in" for a frame, on top of the form the
// visitor just submitted, while the replace navigation was still in flight.
//
// -----------------------------------------------------------------------------------------------
// 4. `next` IS OPAQUE HERE. THAT IS A SECURITY BOUNDARY, NOT A SIMPLIFICATION.
//
// `next` is read, re-encoded onto the fixed, same-origin, literal path `/login`, and used for
// nothing else. It is never a navigation target from this page, never validated, never tested for
// same-origin, never stripped and never rewritten. The open-redirect guard lives in
// `src/app/(auth)/login/page.tsx` and only there, because a check duplicated in two files is a check
// that will eventually disagree with itself - and the copy that is wrong is the one nobody audited.
// `src/middleware.ts` writes the parameter as `pathname + search`, so it can carry a query of its
// own; {@link buildLoginHref} therefore composes it with `URLSearchParams` rather than by
// concatenation, which is what makes `?next=/admin` come back out as `?next=%2Fadmin`.
//
// -----------------------------------------------------------------------------------------------
// 5. DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT HERE.
//
//   1. A `role` control of any kind - selector, toggle or hidden input. Authority is an attribute of
//      the stored account, defaulted to READER by the service and changed only through the
//      administrative API. `signupSchema` is a `z.strictObject` and the service declares
//      `extra='forbid'`, so the key is REPORTED rather than silently dropped at both ends. Offering
//      it would be a privilege-escalation affordance.
//   2. A `confirm_password` box, a terms checkbox or a "remember me". None has a wire counterpart,
//      and `signupSchema` is strict, so any of them would have to be projected away before
//      validating - state this form would carry for no benefit.
//   3. A `display_name` control. The field exists on the schema and is optional; the service
//      defaults it to the username (`auth_service.py`: `display_name=payload.display_name or
//      payload.username`). Omitting it is therefore complete rather than lossy, and it keeps this
//      route to the three credentials AAP §0.6.2 requires. A member renames themselves from their
//      own profile, through `PATCH /api/v1/users/me`.
//   4. Any re-statement, extension or narrowing of the validation rules. `@/lib/validation/auth`
//      mirrors `backend/app/schemas/auth.py` field for field and owns every message and every
//      normalisation - including the `.trim()` on email and username. A local rule here would drift.
//   5. Password-reset, email-verification, transactional-email and third-party-identity
//      affordances. All four are explicitly out of scope per AAP §0.9.3.
//   6. A retry timer, an automatic resubmission, or a permanent disable after a refusal. See
//      {@link describeRetryInterval}.
//   7. `aria-invalid`, `role` and `aria-live` written by hand. `Input` derives the first from
//      `invalid` and `Alert` derives the second from `variant`; writing either here would either
//      duplicate or silently override a primitive's own accessibility contract.

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { CircleAlert, LoaderCircle, UserCheck, UserPlus } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/use-auth';
import { ApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { signupSchema } from '@/lib/validation/auth';
import type { SignupFormValues } from '@/lib/validation/auth';

/* -------------------------------------------------------------------------------------------------
 * Addresses
 *
 * Literals, and deliberately so. `@/lib/routes` exists for the `(dashboard)` and `(admin)` groups,
 * whose parenthesised directory names are ERASED from the URL and are therefore easy to spell wrong;
 * neither address below has that hazard. Both match the constants `src/middleware.ts` and
 * `src/app/(dashboard)/layout.tsx` already declare, which is what keeps the three files agreeing.
 *
 * Note that neither is written with its route group. `(auth)` is organisational only, so the served
 * URLs are `/signup` and `/login`; `/(auth)/login` would 404.
 * ---------------------------------------------------------------------------------------------- */

/** The sign-in route this form hands off to. Matches `LOGIN_PATH` in `src/middleware.ts`. */
const LOGIN_PATH = '/login';

/** The home feed - where an already-signed-in visitor is offered, never `next`. */
const SITE_HOME_PATH = '/';

/**
 * Query parameter carrying the route to return to after signing in.
 *
 * Matches `RETURN_TO_PARAM` in `src/middleware.ts`, which writes it when it refuses a request, and
 * the same constant in `src/app/(dashboard)/layout.tsx`. A different name here would silently drop
 * the destination for every visitor either of those sent this way.
 */
const RETURN_TO_PARAM = 'next';

/* -------------------------------------------------------------------------------------------------
 * Control identifiers
 *
 * Stable literals rather than `useId()` output, because exactly one instance of this form exists on
 * this route - so the identifiers cannot collide, and being fixed makes them addressable from
 * `frontend/tests/e2e/auth.spec.ts` without a query. Nothing here is derived from `Math.random()`,
 * `Date.now()` or a counter: each would differ between the server and the client render and produce
 * the hydration mismatch AAP §0.9.4.5 forbids.
 * ---------------------------------------------------------------------------------------------- */

const EMAIL_FIELD_ID = 'signup-email';
const EMAIL_ERROR_ID = 'signup-email-error';
const USERNAME_FIELD_ID = 'signup-username';
const USERNAME_HINT_ID = 'signup-username-hint';
const USERNAME_ERROR_ID = 'signup-username-error';
const PASSWORD_FIELD_ID = 'signup-password';
const PASSWORD_HINT_ID = 'signup-password-hint';
const PASSWORD_ERROR_ID = 'signup-password-error';

/* -------------------------------------------------------------------------------------------------
 * Copy
 *
 * Named constants rather than inline strings, so the wording is reviewable in one place and a test
 * can assert against the same value the component renders. No message quotes a password, a token or
 * a request body back to the visitor.
 * ---------------------------------------------------------------------------------------------- */

/** The route's single `h1`. */
const PAGE_HEADING = 'Create your account';

/** The supporting sentence under the heading. Plain text - no heading element and no link. */
const PAGE_SUBHEADING =
  'Publish your own posts, join the discussion and follow the authors you like.';

const EMAIL_LABEL = 'Email address';
const EMAIL_PLACEHOLDER = 'you@example.com';

const USERNAME_LABEL = 'Username';
const USERNAME_PLACEHOLDER = 'ada-lovelace';

/**
 * Why the username rules are stated up front rather than left to a rejection.
 *
 * The handle is a URL path segment before it is a label - it addresses this site's `/u/[username]`
 * profile and the API's `GET /api/v1/users/{username}` - so its character set is restricted in a way
 * no visitor can guess. Saying so satisfies WCAG 3.3.2 and removes a guaranteed round trip. The
 * bounds mirror `USERNAME_MIN_LENGTH` and `USERNAME_MAX_LENGTH` in `@/lib/validation/auth`.
 */
const USERNAME_HINT =
  '3 to 30 characters: letters, digits, hyphens and underscores. This becomes your public profile ' +
  'address, so choose one you are happy to be found by.';

const PASSWORD_LABEL = 'Password';

/**
 * The password policy, stated before it can be failed.
 *
 * Mirrors `PASSWORD_MIN_LENGTH` and the character-group rule in `@/lib/validation/auth`, which in
 * turn mirror the service. This is the one field whose rule is genuinely undiscoverable, so leaving
 * it to the rejection message would mean every visitor who does not already know it loses an
 * attempt.
 */
const PASSWORD_HINT =
  'At least 12 characters, drawing on at least 3 kinds of character — for example lowercase ' +
  'letters, uppercase letters and digits.';

const SUBMIT_LABEL = 'Create account';

/**
 * The submit control's label while a registration is in flight.
 *
 * A changed *label*, not merely a spinner: the accessible name is what a screen reader announces, so
 * a busy state carried only by a rotating glyph is carried only for people who can see it.
 */
const SUBMIT_BUSY_LABEL = 'Creating account…';

const LOGIN_PROMPT = 'Already have an account?';
const LOGIN_LINK_LABEL = 'Sign in';

/** Confirmation shown as the hand-off to `/login` begins. Carries no credential of any kind. */
const REGISTERED_TOAST = 'Account created — please sign in.';

const SIGNED_IN_NOTICE_TITLE = 'You are already signed in';
const SIGNED_IN_NOTICE_DETAIL =
  'There is nothing to create while you are signed in. Sign out first if you want a second ' +
  'account, or carry on reading.';
const SIGNED_IN_HOME_LABEL = 'Go to the home feed';

const CONFLICT_HEADLINE = 'That account already exists';

/** Used when the refusal carried no sentence of its own. Mirrors the service's `_IDENTIFIER_TAKEN`. */
const CONFLICT_FALLBACK_DETAIL = 'That email address or username is already registered.';

/**
 * Why the remedy says capitalisation explicitly.
 *
 * `users.email` and `users.username` are `citext` columns under unique indexes, so `Alice` and
 * `alice` are the same account. A message that merely said "already taken" invites the one retry
 * that cannot possibly work, and the visitor reads the second identical refusal as a broken form.
 *
 * The refusal also never says WHICH identifier collided, and this component never guesses: the
 * service publishes one conflict document for both, precisely so the only unauthenticated write in
 * the API is not a membership oracle. Marking a single control here would leak exactly what that
 * design withholds.
 */
const CONFLICT_REMEDY =
  'Capitalisation is ignored when accounts are matched, so a different case will not free it. ' +
  'Choose a different email address or username, or sign in below.';

const THROTTLED_HEADLINE = 'Too many attempts';
const THROTTLED_FALLBACK_DETAIL = 'Please wait a moment and try again.';

/**
 * Headline for every failure the two branches above do not name.
 *
 * Deliberately one constant rather than one per status. The headline says what did not happen, which
 * is identical whichever way the attempt was refused; what differs is the explanation beneath it,
 * and that is where the distinction is drawn.
 */
const SUBMIT_FAILURE_HEADLINE = 'We could not create your account';

/**
 * The fixed sentence shown for a `5xx`, a request that never reached the service, and any rejection
 * that is not one of the service's problem documents.
 *
 * Fixed on purpose. A server-side failure message and a thrown `TypeError`'s message are both
 * written for whoever operates the system, and either can name an internal host, a driver or a
 * constraint. Neither is rendered, and `error.stack` never is.
 *
 * "Nothing was created" is a claim worth making: registration is a single request, so a refusal that
 * never reached the service or that failed inside it leaves no half-made account behind, and saying
 * so is what tells the visitor it is safe to try the same details again.
 */
const SERVICE_FAILURE_DETAIL =
  'Something went wrong at our end, so nothing was created. Please try again in a moment.';

/**
 * Last-resort explanation for a client-side refusal that arrived with no sentence of its own.
 *
 * Close to unreachable - `ProblemDetail.detail` is a required member and the service always fills it
 * - but a form-level alert with a headline and nothing beneath it tells the visitor only that they
 * have failed, so the empty case gets words rather than a blank.
 */
const REQUEST_REFUSED_DETAIL = 'Please check the details you entered and try again.';

/* -------------------------------------------------------------------------------------------------
 * Presentation
 *
 * Every value resolves to a token declared in `frontend/src/app/globals.css` or to a utility
 * generated from the token scales. There is no literal colour, dimension, radius or shadow in this
 * file, no arbitrary-value bracket utility and no custom media query; the only breakpoint vocabulary
 * available is the engine's own five, and this page needs none of them because `(auth)/layout.tsx`
 * already constrains the measure. Dark mode needs no conditional code: each semantic token carries a
 * light value at the document root and a dark value under the dark selector.
 * ---------------------------------------------------------------------------------------------- */

/** Vertical rhythm between field groups, and between the last group and the submit control. */
const FIELD_STACK_CLASSES = 'flex flex-col gap-5';

/** One label, one control, its hint and its message, stacked. */
const FIELD_GROUP_CLASSES = 'flex flex-col gap-2';

/** A hint is secondary text - still 4.5:1 on both canvases, so it stays legible rather than faint. */
const FIELD_HINT_CLASSES = 'text-muted-foreground text-sm';

/**
 * A field message is `--color-danger` AND is programmatically associated.
 *
 * Colour is never the only signal: the control mirrors its state into `aria-invalid` through
 * `Input`'s `invalid` prop, and `aria-describedby` points at this element so the reason is read
 * rather than inferred from a hue.
 */
const FIELD_ERROR_CLASSES = 'text-danger text-sm font-medium';

/** Separates the form-level alert from the first field. */
const GENERAL_ALERT_CLASSES = 'mb-5';

/** The busy glyph. `motion-safe:` so it is still at rest for a visitor who asked for less motion. */
const SPINNER_CLASSES = 'motion-safe:animate-spin';

/**
 * The in-sentence link to `/login`.
 *
 * Underlined at rest rather than on hover only. This link sits inside a paragraph, so hue alone
 * would be the sole indicator that part of the sentence is actionable; the underline is what keeps
 * it discoverable to a visitor who cannot distinguish the two colours.
 */
const CROSS_LINK_CLASSES = cn(
  'text-primary rounded-sm font-medium underline underline-offset-4',
  'hover:text-accent',
  'focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',
  'motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out',
);

/** The footer sentence carrying that link. */
const CROSS_LINK_PROMPT_CLASSES = 'text-muted-foreground text-sm';

/** The submit control spans the panel, matching the full-width fields above it. */
const SUBMIT_CLASSES = 'w-full';

/* -------------------------------------------------------------------------------------------------
 * Failure classification
 *
 * `@/lib/api/client` has already normalised every failure - a problem document, a transport fault, a
 * timeout, an abort - into one thrown `ApiError` or, for a defect in this tier, an ordinary `Error`.
 * So nothing below re-parses a response (there is none to read), invents an error shape or
 * constructs a `ProblemDetail`.
 * ---------------------------------------------------------------------------------------------- */

/** Lower bound of the client-error range. Below it lies `0`, which means no response arrived. */
const HTTP_BAD_REQUEST = 400;

/** The identifier collision. */
const HTTP_CONFLICT = 409;

/** Lower bound of the server-error range. */
const HTTP_SERVER_ERROR_FLOOR = 500;

/** The rate-limit refusal `slowapi` raises on every credential route. */
const HTTP_TOO_MANY_REQUESTS = 429;

/** Marks the messages this component attaches, distinguishing them from the resolver's own. */
const SERVER_ERROR_TYPE = 'server';

/**
 * The controls a service-reported field error may be attached to.
 *
 * Exactly the three this form renders. It is not the schema's key set - `display_name` is a real
 * member of `signupSchema` and is deliberately absent here - so a message naming it has nowhere to
 * go and must fall back to the form-level alert rather than reach `setError` with a path this form
 * has no control for.
 */
const ATTACHABLE_FIELD_NAMES = ['email', 'username', 'password'] as const;

/** One of {@link ATTACHABLE_FIELD_NAMES}. Every member is a valid field path of the form values. */
type AttachableFieldName = (typeof ATTACHABLE_FIELD_NAMES)[number];

/** Attaches one service-authored message to one control. */
type FieldErrorSetter = (field: AttachableFieldName, message: string) => void;

/**
 * Reduce a reported field path to one of this form's controls, or `null` if it names none.
 *
 * The service reports the path in the syntax of the submitted body, so `email` for a top-level
 * member and `parent.0` for a nested one; the first segment is therefore the member being complained
 * about. A path this form has no control for - `display_name`, or the documented blank case where a
 * failure cannot be attributed to any field at all - returns `null` so the caller renders it at form
 * level rather than dropping it or calling `setError` with a path that does not exist.
 *
 * @param field - The reported path, as carried in `ValidationErrorItem.field`.
 * @returns The matching control, or `null`.
 */
function toAttachableFieldName(field: string): AttachableFieldName | null {
  // `noUncheckedIndexedAccess` is on, so the first element is `string | undefined` even though
  // `String.prototype.split` never returns an empty array. Handled rather than asserted away.
  const [head] = field.split('.');

  if (head === undefined) {
    return null;
  }

  return ATTACHABLE_FIELD_NAMES.find((candidate) => candidate === head) ?? null;
}

/** What {@link applyFieldFailures} found, and what it could not place. */
interface FieldFailureOutcome {
  /** `true` when at least one message was attached to a control. */
  readonly attached: boolean;

  /**
   * Messages the document carried that name no control on this form.
   *
   * Surfaced at form level by the caller rather than discarded. A validation refusal whose messages
   * all vanished would leave the visitor looking at a form that simply refuses to submit, with
   * nothing on screen to act on.
   */
  readonly unattributed: readonly string[];
}

/**
 * Attach a refusal's per-field detail to the controls the service itself blamed.
 *
 * Exactly one class of failure carries attributable detail: the request-validation document, which
 * lists one entry per rejected member. `@/lib/api/client` lifts that list onto `ApiError.errors` and
 * omits the member entirely when there is none, so `!== undefined` is a complete test and a length
 * check would add nothing.
 *
 * A `409` is deliberately NOT attributable and takes the form-level path instead - see
 * {@link CONFLICT_REMEDY} for why guessing the field would leak what the service withholds.
 *
 * @param cause - The rejection, still unnarrowed.
 * @param setFieldError - Attaches one message to one control.
 * @returns What was attached, and what was left over.
 */
function applyFieldFailures(cause: unknown, setFieldError: FieldErrorSetter): FieldFailureOutcome {
  if (!(cause instanceof ApiError) || cause.errors === undefined) {
    return { attached: false, unattributed: [] };
  }

  let attached = false;
  const unattributed: string[] = [];

  for (const item of cause.errors) {
    const message = item.message.trim();

    if (message.length === 0) {
      continue;
    }

    const field = toAttachableFieldName(item.field);

    if (field === null) {
      unattributed.push(message);
      continue;
    }

    setFieldError(field, message);
    attached = true;
  }

  return { attached, unattributed };
}

/**
 * Say how long the visitor has to wait, when the refusal said so.
 *
 * Worth surfacing rather than dropping: every credential route is rate limited, so a visitor who
 * retries inside the interval is refused again and reads a working form as a broken one.
 *
 * This is the whole of this file's response to a `429`. There is no timer, no automatic
 * resubmission and no retry loop - each would spend the visitor's next allowance without their
 * asking - and the form is never disabled permanently, so the interval passing is enough to make it
 * usable again.
 *
 * @param seconds - `ApiError.retryAfterSeconds`, or `null` when no interval was sent.
 * @returns A sentence, or `null` when there is no interval to report.
 */
function describeRetryInterval(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  const whole = Math.ceil(seconds);

  return `Try again in ${String(whole)} ${whole === 1 ? 'second' : 'seconds'}.`;
}

/** A form-level failure, rendered as a headline and - when there is more to say - a paragraph. */
interface FailureCopy {
  readonly headline: string;
  readonly explanation: string | null;
}

/**
 * Join the sentences that are actually present into one paragraph.
 *
 * @param parts - Sentences, any of which may be absent.
 * @returns The joined paragraph, or `null` when none were present.
 */
function joinSentences(...parts: ReadonlyArray<string | null>): string | null {
  const present = parts.filter((part): part is string => part !== null && part.trim().length > 0);

  return present.length > 0 ? present.join(' ') : null;
}

/**
 * Turn any rejection into copy that is both safe and useful to show the person who caused it.
 *
 * The dividing line is whether the words came from the service about a request this form made. A
 * `4xx` document's `detail` did, so it is rendered; a `5xx`, a request that never got an answer, and
 * a thrown `Error` did not, so a fixed sentence is rendered instead and the original message is
 * discarded. `error.stack` is never read.
 *
 * The `title` member is deliberately never used as the headline. The service's titles are register
 * entries rather than prose - `"Conflict"`, `"Validation Error"` - so the headlines here are this
 * page's own, and only the `detail` is quoted.
 *
 * @param cause - The rejection, still unnarrowed.
 * @param unattributed - Messages from {@link applyFieldFailures} that named no control.
 * @returns The headline, and an explanation when there is one.
 */
function resolveFailureCopy(cause: unknown, unattributed: readonly string[]): FailureCopy {
  const leftovers = unattributed.length > 0 ? unattributed.join(' ') : null;

  if (!(cause instanceof ApiError)) {
    return { headline: SUBMIT_FAILURE_HEADLINE, explanation: SERVICE_FAILURE_DETAIL };
  }

  // `status` is `0` when no response arrived at all, so one comparison covers a transport fault, a
  // timeout and an abort alongside every `5xx`.
  if (cause.status < HTTP_BAD_REQUEST || cause.status >= HTTP_SERVER_ERROR_FLOOR) {
    return { headline: SUBMIT_FAILURE_HEADLINE, explanation: SERVICE_FAILURE_DETAIL };
  }

  const detail = cause.problem.detail.trim();
  const retry = describeRetryInterval(cause.retryAfterSeconds);

  if (cause.status === HTTP_CONFLICT) {
    return {
      headline: CONFLICT_HEADLINE,
      explanation: joinSentences(
        detail.length > 0 ? detail : CONFLICT_FALLBACK_DETAIL,
        CONFLICT_REMEDY,
      ),
    };
  }

  if (cause.status === HTTP_TOO_MANY_REQUESTS) {
    return {
      headline: THROTTLED_HEADLINE,
      explanation: joinSentences(
        detail.length > 0 ? detail : null,
        retry ?? THROTTLED_FALLBACK_DETAIL,
      ),
    };
  }

  return {
    headline: SUBMIT_FAILURE_HEADLINE,
    explanation:
      joinSentences(leftovers, detail.length > 0 ? detail : null, retry) ?? REQUEST_REFUSED_DETAIL,
  };
}

/**
 * Compose the sign-in address, carrying `next` through unchanged.
 *
 * The single derivation of that address in this file: the same string is the cross-link's `href` and
 * the post-success navigation target, so the two cannot drift apart.
 *
 * `URLSearchParams` does the encoding, which is the point rather than a convenience.
 * `src/middleware.ts` writes `next` as `pathname + search`, so the value routinely contains `/` and
 * can contain `?`, `&` and `=` of its own; interpolating it into a template literal would splice
 * those straight into this URL's own query and change which parameters `/login` sees. Composed this
 * way, `/signup?next=/admin` yields exactly `/login?next=%2Fadmin`.
 *
 * An absent or empty `next` produces a bare `/login` - no trailing `?`, no empty `next=` - because
 * `toString()` on an empty instance is the empty string.
 *
 * The value is treated as entirely opaque: it is not inspected, validated, tested for same-origin,
 * or used as a target. `LOGIN_PATH` is a fixed same-origin literal, so no value of `next` can
 * redirect this navigation anywhere; `src/app/(auth)/login/page.tsx` is the sole owner of the
 * open-redirect guard.
 *
 * @param returnTo - The raw `next` parameter, or `null` when the visitor arrived without one.
 * @returns An in-app path, ready for `<Link href>` or `router.replace`.
 */
function buildLoginHref(returnTo: string | null): string {
  const params = new URLSearchParams();

  if (returnTo !== null && returnTo.length > 0) {
    params.set(RETURN_TO_PARAM, returnTo);
  }

  const query = params.toString();

  return query.length > 0 ? `${LOGIN_PATH}?${query}` : LOGIN_PATH;
}

/* -------------------------------------------------------------------------------------------------
 * The panel's body
 * ---------------------------------------------------------------------------------------------- */

/**
 * What the controls hold, as distinct from what a valid submission produces.
 *
 * The two are genuinely different types, and conflating them does not compile. `signupSchema`
 * transforms - `display_name` accepts `string | null` and yields `string | undefined` - so its input
 * and output shapes differ, and `Resolver<T>` from react-hook-form is INVARIANT in `T` because `T`
 * appears both as a parameter (the values handed to the resolver) and inside the result. Declaring
 * `useForm<SignupFormValues>` therefore fails with a variance error on `ResolverOptions`, and the
 * only ways past it are a cast that asserts something the compiler has correctly refused to believe,
 * or naming both types - which is what react-hook-form's third generic parameter exists for.
 *
 * Derived from the schema rather than written out, so this is not a re-statement of the contract:
 * `@/lib/validation/auth` remains the single authority, and a field added there arrives here without
 * an edit.
 */
type SignupFormInput = z.input<typeof signupSchema>;

/**
 * The values every control starts from.
 *
 * Empty strings rather than an omitted `defaultValues`, so each input is controlled from the first
 * render and the server and client agree on its value - an uncontrolled-then-controlled input is a
 * hydration difference. Only `signupSchema`'s own keys appear, because the schema is strict and
 * rejects an unknown one rather than stripping it; `display_name` is optional there and is
 * deliberately absent here.
 */
const DEFAULT_VALUES: SignupFormInput = { email: '', username: '', password: '' };

/**
 * The placeholder shown in the panel's body while something is still being resolved.
 *
 * Serves two states, and sharing one component is what guarantees they cannot diverge: the
 * `<Suspense>` fallback around {@link SignupFormPanel}, and the pass during which the session is
 * still being restored.
 *
 * It contains no heading, so `CardTitle` upstairs remains the document's only `h1` at every moment,
 * including before this boundary resolves. `Skeleton` already carries `aria-hidden` and
 * `motion-reduce:animate-none`, so this is silent to assistive technology and still at rest for a
 * visitor who asked for less motion - and no `role` or `aria-live` is written here, because a
 * hand-rolled live region is precisely what the primitives exist to avoid.
 *
 * The heights are the real ones - `h-4` for a label and `h-11` for a control, the latter matching
 * `Input`'s own control height, which is itself the WCAG target-size floor - so the panel does not
 * resize when the form arrives.
 */
function SignupFormPlaceholder(): JSX.Element {
  return (
    <CardContent>
      <div className={FIELD_STACK_CLASSES}>
        {[EMAIL_FIELD_ID, USERNAME_FIELD_ID, PASSWORD_FIELD_ID].map((field: string) => (
          <div className={FIELD_GROUP_CLASSES} key={field}>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-11" />
          </div>
        ))}
        <Skeleton className="h-11" />
      </div>
    </CardContent>
  );
}

/**
 * The form, the form-level alert and the cross-link to `/login`.
 *
 * Split out from {@link SignupPage} for one reason: it calls `useSearchParams()`, which Next.js
 * requires to sit beneath a `<Suspense>` boundary. Without the split the whole route would deopt out
 * of prerendering - or fail the build outright with "useSearchParams() should be wrapped in a
 * suspense boundary" - and `npm run build` is a blocking gate under AAP §0.9.4.1.
 *
 * It is a local, non-exported component rather than a second file. The instruction for this route is
 * that `page.tsx` is the entire content of its folder, and a component declared here adds no file.
 * Keeping `CardHeader`/`CardTitle` in the parent, above the boundary, is the other half of the
 * arrangement: the `h1` is then present during the fallback as well as after it.
 */
function SignupFormPanel(): JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();

  // `register` is aliased because `form.register` below is a different function entirely, and a
  // shadowed name here would be a genuinely hard bug to see.
  const { register: registerAccount, isAuthenticated, isLoading } = useAuth();

  /**
   * The form-level failure on screen, or `null`.
   *
   * Held in state rather than derived, because a rejection is an event: it has to survive the
   * re-renders that follow it and be cleared deliberately at the start of the next attempt.
   */
  const [failure, setFailure] = useState<FailureCopy | null>(null);

  /**
   * Latches once a registration has succeeded on this instance, and never unlatches.
   *
   * State rather than a ref, because it has to be RENDERED: it feeds {@link isBusy}, and through it
   * both the already-signed-in guard and the controls' `disabled`.
   *
   * `@/providers/auth-provider` signs the new member in as part of `register`, so `isAuthenticated`
   * turns true before `router.replace` has committed. Without this latch the already-signed-in branch
   * would replace the form for a frame, telling the visitor there was "nothing to create" immediately
   * after they created it - and the form would stay live throughout the hand-off, so a second click
   * would register again and be refused against their own new account.
   */
  const [hasRegistered, setHasRegistered] = useState(false);

  /**
   * Whether a registration is already in flight, tracked SYNCHRONOUSLY.
   *
   * A ref rather than state, and that is the whole point. `isSubmitting` below is RENDERED state, so
   * the `disabled` attribute it drives only exists once React has re-rendered - which makes a
   * disabled control a guard against a second EVENT rather than against a second CALL. Two
   * activations dispatched inside one synchronous task both observe `disabled === false` and both
   * reach the handler, and the measured consequence is ugly: the first request creates the account,
   * the second collides with the unique index, and the visitor is shown "that account already
   * exists" for the account they have just successfully created.
   *
   * A ref is written and read in the same tick, so this latch closes that window outright. It is
   * cleared ONLY on the failure path - a completed registration leaves it held for the life of this
   * instance, because the component is navigating away and no later submission from it could be
   * correct. See {@link onSubmit}.
   */
  const submissionInFlight = useRef(false);

  // Three generics, and each says something true: the controls hold {@link SignupFormInput}, there is
  // no resolver context, and a valid submission yields `SignupFormValues`. See
  // {@link SignupFormInput} for why the one-generic form does not compile.
  const form = useForm<SignupFormInput, unknown, SignupFormValues>({
    resolver: zodResolver(signupSchema),
    defaultValues: DEFAULT_VALUES,
  });

  const { errors, isSubmitting } = form.formState;

  /**
   * Whether the form should be inert.
   *
   * Two conditions, because the hand-off to `/login` has two phases and both need the controls
   * closed. `isSubmitting` covers the request. `hasRegistered` covers the window AFTER the handler
   * resolves and BEFORE `router.replace` commits - measured at over a second when the target has to
   * be fetched - during which the form would otherwise still be live, so an ordinary second click
   * would register again and be refused with a conflict against the visitor's own brand-new account.
   *
   * A refusal deliberately does NOT set it: `hasRegistered` stays `false`, `isSubmitting` returns to
   * `false`, and the form re-enables itself with the entered values intact. So a rate-limit or a
   * server failure never leaves the form permanently closed.
   *
   * This is a PRESENTATION flag, and only that. The guarantee that one submission means one request
   * belongs to {@link submissionInFlight}, which is why the distinction matters: `isSubmitting` is a
   * single shared boolean inside react-hook-form, so a *programmatic* `form.requestSubmit()` during
   * the hand-off completes its own cycle immediately (the latch returns at once) and clears the flag
   * while the real submission is still in flight - measured at roughly a second of the controls
   * un-greying. That is deliberately left alone rather than papered over with a second, state-backed
   * copy of the latch: no request can be issued in that window, no human input path reaches it (a
   * real second click lands on an already-disabled button and dispatches no submit event at all), and
   * two sources of truth for one fact is a worse defect than a cosmetic gap only a script can open.
   */
  const isBusy = isSubmitting || hasRegistered;

  // Read once, and used for exactly two things: this href and the navigation below. Both go to the
  // same fixed literal path, so `next` is never itself a target.
  const loginHref = buildLoginHref(searchParams.get(RETURN_TO_PARAM));

  const emailError = errors.email?.message;
  const usernameError = errors.username?.message;
  const passwordError = errors.password?.message;

  /**
   * Create the account, then hand the new member to `/login`.
   *
   * `values` are passed straight through. `SignupFormValues` is constrained assignable to
   * `RegisterRequest` by `@/lib/validation/auth` itself, so no cast, no re-shaping and no wider
   * object is needed - and adding a key would be rejected by the strict schema at both ends.
   *
   * Nothing is re-thrown. A rejected submission has to leave the visitor on a usable form with their
   * email address and username still typed, which is exactly what this does: the caught failure
   * becomes either a per-control message or the form-level alert, and the form re-enables itself.
   */
  const onSubmit = async (values: SignupFormValues): Promise<void> => {
    // The synchronous half of the double-submission guard, and the FIRST statement for that reason:
    // it has to run before any await yields control. The latch is deliberately NOT cleared on this
    // path - the attempt that holds it owns clearing it, so a re-entrant call cannot release the
    // guard on its way out. See {@link submissionInFlight}.
    if (submissionInFlight.current) {
      return;
    }

    submissionInFlight.current = true;

    // Cleared next, so a message from the previous attempt cannot outlive it and be read as the
    // outcome of this one.
    setFailure(null);

    try {
      await registerAccount(values);
    } catch (cause) {
      // Released here rather than in a `finally`, and only here. On the success path below the
      // component is on its way to `/login`, so the latch stays held and this instance can never
      // submit again; on this path the visitor has to be able to correct their details and retry.
      submissionInFlight.current = false;

      const outcome = applyFieldFailures(cause, (field: AttachableFieldName, message: string) => {
        form.setError(field, { type: SERVER_ERROR_TYPE, message });
      });

      // The form-level alert is suppressed only when every message the refusal carried found a
      // control of its own. Anything left over, and anything that named no control at all, is
      // reported here rather than lost.
      //
      // No focus is moved and no announcement is forced in the fully-attributed case, and that is a
      // considered position rather than an omission. WCAG 3.3.1 asks that the item in error be
      // identified and the error described in text, which `invalid` (via `aria-invalid`) and
      // `aria-describedby` together satisfy; it does not ask for a live region. Moving focus from
      // here could not work anyway - every control is still `disabled` at this instant, because
      // react-hook-form clears `isSubmitting` only after this handler returns - so it would need an
      // effect that fires on the next pass, and an unrequested effect on a form this simple is more
      // to get wrong than it is worth. The path is also close to unreachable in practice:
      // `signupSchema` mirrors `backend/app/schemas/auth.py` field for field and runs first, so a
      // server-side field rejection means the mirror has drifted.
      if (!outcome.attached || outcome.unattributed.length > 0) {
        setFailure(resolveFailureCopy(cause, outcome.unattributed));
      }

      return;
    }

    setHasRegistered(true);
    toast.success(REGISTERED_TOAST);
    router.replace(loginHref);
  };

  /**
   * The `<form>`'s submit listener.
   *
   * `form.handleSubmit(onSubmit)` is built HERE, inside the event, rather than during render. That is
   * required rather than stylistic: `onSubmit` closes over {@link submissionInFlight}, and
   * `react-hooks/refs` - a blocking rule in `frontend/eslint.config.mjs` - refuses a ref-reading
   * closure passed as an argument to a call made during render, because it cannot prove the callee
   * will not read `.current` there. Building the handler at event time satisfies the rule honestly:
   * the ref is then only ever touched inside an event handler, which is exactly where React says a
   * ref belongs. The factory is cheap, so constructing it per submission costs nothing.
   *
   * The returned promise is deliberately discarded with `void`. `handleSubmit` never rejects - it
   * catches whatever the validator or the handler throws and records it on the form - so there is
   * nothing to await and nothing to handle, and a floating promise here would be the only unhandled
   * rejection path in the file.
   */
  const handleFormSubmit = (event: FormEvent<HTMLFormElement>): void => {
    void form.handleSubmit(onSubmit)(event);
  };

  // The session is still being restored. Rendering the form now and swapping it a moment later is
  // the flash this avoids; the placeholder holds the panel's height and carries no second heading.
  if (isLoading) {
    return <SignupFormPlaceholder />;
  }

  // Gated on `isBusy`, which is what makes this branch correct rather than merely present.
  // `@/providers/auth-provider` signs the new member in as part of `register`, so `isAuthenticated`
  // turns true DURING a submission and again while the replace navigation is in flight - and in both
  // of those windows the form, not this notice, is the right thing on screen. `isBusy` covers exactly
  // those two windows. See {@link isBusy}.
  //
  // Note there is no effect here and no automatic redirect: an effect that navigated on
  // `isAuthenticated` could re-fire on arrival and loop. The visitor is offered a link and chooses.
  //
  // `restoreError` deliberately gets no branch of its own. When the initial session check could not
  // reach the service, `user` stays `null` and so `isAuthenticated` is `false` - which lands here, on
  // the form, and the form is the right affordance for somebody who came to register. If they are in
  // fact already signed in, the service answers the registration with a `409` and this component says
  // so.
  if (isAuthenticated && !isBusy) {
    return (
      <>
        <CardContent>
          {/* `info`, not `destructive`: this is an ordinary state a visitor arrived at, not a
              failure. The variant selects a neutral tone AND silence - no live-region role - so it
              is read in document order after the heading instead of announced over it. */}
          <Alert variant="info">
            {/* First child, which is the primitive's leading-icon slot, and hidden because the
                title and description already carry the whole meaning. */}
            <UserCheck aria-hidden="true" />
            <AlertTitle>{SIGNED_IN_NOTICE_TITLE}</AlertTitle>
            <AlertDescription>{SIGNED_IN_NOTICE_DETAIL}</AlertDescription>
          </Alert>
        </CardContent>
        <CardFooter>
          {/* Home, never `next`. A visitor who is already signed in did not ask to go anywhere in
              particular, and `next` belongs to an interrupted journey that is not theirs. A real
              anchor, so it still works if the client bundle fails. */}
          <Button asChild>
            <Link href={SITE_HOME_PATH}>{SIGNED_IN_HOME_LABEL}</Link>
          </Button>
        </CardFooter>
      </>
    );
  }

  return (
    <>
      <CardContent>
        {failure === null ? null : (
          /* The destructive variant is what gives this panel its assertive live-region semantics,
             so it announces itself the moment it appears. Neither that attribute nor a politeness
             setting is written here: the primitive derives both from the variant, and restating
             either would be redundant at best and a silent override at worst. */
          <Alert className={GENERAL_ALERT_CLASSES} variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{failure.headline}</AlertTitle>
            {failure.explanation === null ? null : (
              <AlertDescription>{failure.explanation}</AlertDescription>
            )}
          </Alert>
        )}

        {/* `noValidate` hands validation entirely to the resolver. Without it the browser's own
            bubble fires first on `type="email"` and on a missing value, in its own styling and with
            its own wording - pre-empting the messages `@/lib/validation/auth` mirrors from the
            service, which are the ones that agree with what the API will actually accept.

            A raw `<form>` is correct here: no primitive wraps one, it is not on the prohibited
            raw-element list, and it is what gives submit-on-Enter from any field for free. */}
        <form className={FIELD_STACK_CLASSES} noValidate onSubmit={handleFormSubmit}>
          {/* --- Email ------------------------------------------------------------------------
              First, because it is the identifier the service treats as the account's address, and
              because it is what `/login` will ask for. The field stays `email` and is NOT renamed:
              the OAuth 2 password-grant encoding that carries an email in a field the grant calls
              `username` applies to the sign-in route alone and lives in `@/lib/api/auth`.

              No trimming or lowercasing happens here. `signupSchema` owns normalisation, and doing
              it twice is how the two ends stop agreeing. */}
          <div className={FIELD_GROUP_CLASSES}>
            <Label htmlFor={EMAIL_FIELD_ID}>{EMAIL_LABEL}</Label>
            <Input
              {...form.register('email')}
              // Only referenced once the message exists, so the control is not pointed at an element
              // that is not in the document.
              aria-describedby={emailError === undefined ? undefined : EMAIL_ERROR_ID}
              autoComplete="email"
              disabled={isBusy}
              id={EMAIL_FIELD_ID}
              // Drives the danger border AND `aria-invalid`. Never hand-write the attribute.
              invalid={emailError !== undefined}
              placeholder={EMAIL_PLACEHOLDER}
              type="email"
            />
            {emailError === undefined ? null : (
              <p className={FIELD_ERROR_CLASSES} id={EMAIL_ERROR_ID}>
                {emailError}
              </p>
            )}
          </div>

          {/* --- Username ---------------------------------------------------------------------
              `username`, and never `name`. The demonstration API this project retired modelled its
              single entity with a client-supplied integer identifier, a bare `name` and a monetary
              amount. None of that vocabulary survives into the blog domain - identity is a UUID the
              database generates, and the public handle is `username` - so `name` is the one field
              name that must not reappear here, however familiar it looks. */}
          <div className={FIELD_GROUP_CLASSES}>
            <Label htmlFor={USERNAME_FIELD_ID}>{USERNAME_LABEL}</Label>
            <Input
              {...form.register('username')}
              // The hint is always referenced; the message is added only once it exists.
              aria-describedby={
                usernameError === undefined
                  ? USERNAME_HINT_ID
                  : `${USERNAME_HINT_ID} ${USERNAME_ERROR_ID}`
              }
              autoComplete="username"
              disabled={isBusy}
              id={USERNAME_FIELD_ID}
              invalid={usernameError !== undefined}
              placeholder={USERNAME_PLACEHOLDER}
              type="text"
            />
            <p className={FIELD_HINT_CLASSES} id={USERNAME_HINT_ID}>
              {USERNAME_HINT}
            </p>
            {usernameError === undefined ? null : (
              <p className={FIELD_ERROR_CLASSES} id={USERNAME_ERROR_ID}>
                {usernameError}
              </p>
            )}
          </div>

          {/* --- Password ---------------------------------------------------------------------
              `new-password` rather than `current-password`, which is what tells a password manager
              to offer to generate and store one instead of filling an existing credential. */}
          <div className={FIELD_GROUP_CLASSES}>
            <Label htmlFor={PASSWORD_FIELD_ID}>{PASSWORD_LABEL}</Label>
            <Input
              {...form.register('password')}
              aria-describedby={
                passwordError === undefined
                  ? PASSWORD_HINT_ID
                  : `${PASSWORD_HINT_ID} ${PASSWORD_ERROR_ID}`
              }
              autoComplete="new-password"
              disabled={isBusy}
              id={PASSWORD_FIELD_ID}
              invalid={passwordError !== undefined}
              type="password"
            />
            <p className={FIELD_HINT_CLASSES} id={PASSWORD_HINT_ID}>
              {PASSWORD_HINT}
            </p>
            {passwordError === undefined ? null : (
              <p className={FIELD_ERROR_CLASSES} id={PASSWORD_ERROR_ID}>
                {passwordError}
              </p>
            )}
          </div>

          {/* `disabled` while in flight is what makes a double submission impossible, which would
              otherwise race two registrations against the same identifiers - one of which is bound
              to lose to the unique index and be reported as a conflict the visitor did not cause.
              The label changes with it, so the busy state reaches a screen reader too rather than
              being carried by the spinning glyph alone. */}
          <Button className={SUBMIT_CLASSES} disabled={isBusy} type="submit">
            {isBusy ? (
              <LoaderCircle aria-hidden="true" className={SPINNER_CLASSES} />
            ) : (
              <UserPlus aria-hidden="true" />
            )}
            {isBusy ? SUBMIT_BUSY_LABEL : SUBMIT_LABEL}
          </Button>
        </form>
      </CardContent>

      <CardFooter>
        {/* The cross-link, carrying `next` so an interrupted journey survives the trip between the
            two credential forms. `href` is the same single derivation the navigation above uses. */}
        <p className={CROSS_LINK_PROMPT_CLASSES}>
          {LOGIN_PROMPT}{' '}
          <Link className={CROSS_LINK_CLASSES} href={loginHref}>
            {LOGIN_LINK_LABEL}
          </Link>
        </p>
      </CardFooter>
    </>
  );
}

/* -------------------------------------------------------------------------------------------------
 * The route
 * ---------------------------------------------------------------------------------------------- */

/**
 * `/signup` - the panel, its single `h1`, and the boundary the form needs.
 *
 * The `Card` root stays a `<div>`, its default. A credential panel is not a self-contained,
 * syndicable item, so `<article>` would claim an outline role it does not have.
 *
 * `CardTitle` renders at `h1` here, which the primitive exposes precisely so a page can own its own
 * heading level; the group layout above deliberately renders none. It is the only `h1` on this route,
 * and it sits OUTSIDE the `<Suspense>` boundary so it is in the document during the fallback as well
 * as after it. Nothing below it is a heading: the supporting sentence is a `<p>`, and the alerts use
 * `AlertTitle`'s non-heading default, so no level is skipped and no second `h1` can appear in any
 * state this route has.
 */
export default function SignupPage(): JSX.Element {
  return (
    <Card>
      <CardHeader>
        {/* `text-2xl` steps the heading up from the primitive's card-sized default; both values are
            `--text-*` tokens, so this is a token substitution and not an override of the scale. */}
        <CardTitle as="h1" className="text-2xl">
          {PAGE_HEADING}
        </CardTitle>
        <p className={FIELD_HINT_CLASSES}>{PAGE_SUBHEADING}</p>
      </CardHeader>
      <Suspense fallback={<SignupFormPlaceholder />}>
        <SignupFormPanel />
      </Suspense>
    </Card>
  );
}
