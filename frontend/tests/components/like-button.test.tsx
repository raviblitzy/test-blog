/* =================================================================================================
 * Component tests for `@/components/blog/like-button` - the like half of requirement R4, "Each blog
 * page should support comments, likes, and social sharing".
 *
 * WHAT THIS FILE EXISTS TO PROTECT
 *
 * Two properties are the whole reason this component is shaped the way it is, and neither is visible
 * on screen. A reviewer cannot see them and a screenshot cannot show them, so they need a test:
 *
 *  1. **The update settles on the response the mutation already returned.** All three like routes
 *     answer with the same `LikeSummary`, so `onSuccess` writes that answer into the cache and the
 *     interaction is over - no `invalidateQueries`, no `refetch`, no second `GET`. A follow-up read
 *     would cost a request per click and make the count flicker under the pointer that caused it.
 *     Adding one would look like a correctness improvement and would throw away the reason
 *     `DELETE /api/v1/posts/{id}/like` answers with a body at all. This file asserts the ABSENCE of that
 *     request, because absence is the contract.
 *  2. **Two likes leave the count at one.** `post_likes` has no surrogate key - its primary key is
 *     the pair `(post_id, user_id)` and the insert ignores conflicts - so idempotency is structural
 *     rather than defended in code. That is what makes `PUT /api/v1/posts/{id}/like` safely
 *     retryable and what removes any need for application-level de-duplication. The client half
 *     of that guarantee is that the control renders the tally the SERVICE reported and never a
 *     figure it accumulated locally: if the service says the count did not move, the optimistic
 *     `+1` must be discarded.
 *
 * The rest of the file covers the states a reader actually meets: a seeded first paint, a like, an
 * un-like, an anonymous visit, and four refusals.
 *
 * HOW THIS FILE IS WIRED, AND THE FOUR DECISIONS BEHIND IT
 *
 * 1. **THIS SPEC OWNS THE MOCK SERVICE WORKER LIFECYCLE, AND THAT IS THE PROJECT'S CONVENTION
 *    RATHER THAN A SECOND INTERCEPTOR.** `frontend/vitest.setup.ts` deliberately owns no server
 *    instance - its header assigns `setupServer`, `listen`, `resetHandlers` and `close` to "the specs
 *    that need them", and it imports nothing from `tests/` so that the runner stays bootable on its
 *    own. `tests/msw/handlers.ts` states the same division from its side ("It owns no server instance
 *    and no lifecycle") and describes its export as "one flat array, spread into `setupServer` by
 *    whichever spec owns the server lifecycle". There is therefore NO singleton to import: the
 *    instance below is this file's only one, exactly as in `post-editor.test.tsx` and
 *    `handlers.contract.test.ts`, and Vitest isolates per test FILE so nothing races anything.
 *    Interception stays at the NETWORK boundary, which is the point - `src/lib/api/client.ts` is the
 *    tier's only HTTP module, and mocking `@/lib/api/likes` instead would have proved the same
 *    rendering contracts while retiring the base-URL composition, the bearer attachment, the
 *    problem-document normalisation and the schema decoding that sit between this component and the
 *    wire. Nothing here patches `fetch` and nothing here mocks `@/lib/api/client`.
 * 2. **Every like request is RECORDED, and the log is what proves the two properties above.** The
 *    base handler array answers all three like routes perfectly well, so `onUnhandledRequest: 'error'`
 *    would NOT catch a stray follow-up read - it would be answered silently and the test would still
 *    pass. {@link likeHandlers} therefore layers recording resolvers over the base list, and the
 *    assertions read {@link captured} directly. That is the "counter that stayed at zero", kept as a
 *    log rather than a number so a failure names the request that should not have happened.
 * 3. **The credential is seeded through the client's own public API.** `PUT` and `DELETE` are
 *    authenticated routes and the client reads its bearer from the in-memory store `setCredentials`
 *    fills, so calling that exported function is using the client as designed rather than mocking it.
 *    The fixture token is an obvious placeholder string: nothing here builds, decodes, inspects or
 *    asserts on a JWT, and no cookie is touched.
 * 4. **Only `sonner` and `next/navigation` are mocked, and only because they are hosts this file does
 *    not mount.** `<Toaster />` lives in `src/app/layout.tsx`, so `toast.error` would write into
 *    nothing; and `useRouter`/`usePathname` have no App Router provider outside a Next.js render, so
 *    the sign-in navigation needs a stub to land on. `AuthContext.Provider` is supplied directly
 *    rather than mounting the real `AuthProvider`, which would perform a session restore over HTTP
 *    that has nothing to do with this control - while `useAuth` throws outside a provider, so some
 *    context has to be there. `user: null` inside a live provider is a valid anonymous visitor; a
 *    missing provider is a developer error, and the two must not be confused.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT ASSERT
 *
 * - **No class, no computed style, no snapshot, and no "the heart is filled".** Appearance belongs to
 *   the token layer and is free to change without a test noticing. The liked state's observable form
 *   is `aria-pressed` and the tally - both of which survive greyscale, a colour-vision deficiency and
 *   a screen reader - so those are what every state assertion below reads.
 * - **No server-side authority.** Hiding or re-labelling a control is a courtesy, not a security
 *   boundary: `PUT` and `DELETE /api/v1/posts/{id}/like` re-resolve the principal on every call. The
 *   anonymous cases below are framed as user-experience assertions for that reason, and the authority
 *   itself is proved by the backend suite and by `tests/e2e/comments-likes.spec.ts`.
 * - **No 5xx.** The tier's mutation policy is `retry: 0` and its query predicate refuses to retry
 *   4xx, so every refusal below is a 4xx: one attempt, deterministic, and representative of what a
 *   reader actually meets. A 5xx would be retried and would make the request log non-deterministic.
 * - **No responsive behaviour and no theming.** jsdom applies no media query and resolves no token,
 *   so an assertion here could only ever be a false negative. Both are verified across the three
 *   viewports in `tests/e2e/comments-likes.spec.ts` and `tests/e2e/theme.spec.ts`.
 * - **Nothing from the retired legacy resource.** The demonstration collection this repository began
 *   as has no blog-domain counterpart and is superseded, so no trace of it appears below - and no
 *   unversioned path does either. Every route this file names, in prose and in code alike, carries
 *   the `/api/v1` prefix.
 * ============================================================================================== */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { RequestHandler } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LikeButton } from '@/components/blog/like-button';
import { clearCredentials, setCredentials } from '@/lib/api/client';
import { formatCount } from '@/lib/format';
import type { LikeSummary, ProblemDetail, UserMe } from '@/lib/types';
import { AuthContext } from '@/providers/auth-provider';
import type { AuthContextValue } from '@/providers/auth-provider';
import { QueryProvider } from '@/providers/query-provider';

import {
  FIXTURE_REQUEST_ID,
  fixtureAuthorAccount,
  fixtureLikeSummary,
  fixtureTokenPair,
  handlers,
} from '../msw/handlers';

/* -------------------------------------------------------------------------------------------------
 * Module mocks
 *
 * `vi.hoisted` rather than a bare `const`, because `vi.mock` is lifted above every import in the
 * file: a factory closing over an ordinary module-level binding throws "Cannot access '...' before
 * initialization" at collection time, before a single test runs.
 * ---------------------------------------------------------------------------------------------- */

const { currentPathname, routerStub, toastStub } = vi.hoisted(() => ({
  /**
   * The route the reader is on when they meet the control.
   *
   * A post reading page, because that is where this component lives, and the value matters: the
   * sign-in prompt folds this path into its destination so the visitor comes back to the article
   * they were reading rather than to the home feed.
   */
  currentPathname: '/blog/scaling-fastapi-under-load',

  /**
   * The only App Router member this component touches.
   *
   * One navigation and nothing else - no `replace`, no `refresh`, no `prefetch`. Anything else the
   * component reached for would fail here as "not a function", which is the correct outcome: this
   * stub is the recorded contract rather than a convenience.
   */
  routerStub: { push: vi.fn() },

  /**
   * The one `toast` channel this component uses.
   *
   * `error` only. A like that succeeds needs no announcement - the count moving under the pointer IS
   * the confirmation - so a `toast.success` here would be a surface the component does not have.
   */
  toastStub: { error: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  usePathname: (): string => currentPathname,
  useRouter: () => routerStub,
}));

vi.mock('sonner', () => ({ toast: toastStub }));

/* -------------------------------------------------------------------------------------------------
 * Contract vocabulary
 *
 * The three accessible names and the tally phrase are what an assistive technology announces, so they
 * are contracts rather than decoration - the same strings `tests/e2e/comments-likes.spec.ts` matches
 * on. Written out here rather than imported, deliberately: the component does not export them, and a
 * test that derived the expected name from the same expression the component uses would pass no
 * matter what that expression said.
 * ---------------------------------------------------------------------------------------------- */

/** What pressing does while the caller has not liked the post. */
const LABEL_LIKE = 'Like this post';

/** What pressing does while the caller HAS liked the post. */
const LABEL_UNLIKE = 'Unlike this post';

/**
 * What pressing does for a visitor with no session.
 *
 * It names the consequence - going to the sign-in form - rather than the state of the post, because
 * pressing does not like anything. A name that promised otherwise would be a lie an assistive
 * technology user cannot see through.
 */
const LABEL_SIGN_IN = 'Sign in to like this post';

/** The sentence shown when a like fails and the service offered no explanation of its own. */
const LIKE_FAILURE_FALLBACK = 'Your like could not be saved.';

/** The sentence shown when an un-like fails and the service offered no explanation of its own. */
const UNLIKE_FAILURE_FALLBACK = 'Your like could not be removed.';

/**
 * Where the sign-in prompt sends a visitor, with the route to come back to folded in.
 *
 * Written as the literal string the router should receive rather than recomposed with
 * `URLSearchParams`, so this asserts the contract `src/middleware.ts` also writes instead of
 * re-implementing the component's own encoding and agreeing with itself. The `%2F` sequences are the
 * encoded path separators of {@link currentPathname}.
 */
const EXPECTED_SIGN_IN_HREF = '/login?next=%2Fblog%2Fscaling-fastapi-under-load';

/** The credential header the client attaches, and the one this file's handlers accept. */
const AUTHORIZATION_HEADER = 'Authorization';

/** Scheme prefix of that header's value. */
const BEARER_SCHEME = 'Bearer ';

/** The one media type every failure path in this API answers with. */
const PROBLEM_JSON_MEDIA_TYPE = 'application/problem+json';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 *
 * Derived from `tests/msw/handlers.ts` wherever the shared module already holds the value, so a
 * changed fixture moves both ends together or neither. Restating `12` beside an import of the
 * summary that already says `12` is how a test and its harness drift apart.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The post under test, addressed by its **server-generated UUID and never by its slug**.
 *
 * This is the one path-keying asymmetry in the tier: every like route addresses
 * `/api/v1/posts/{id}`, while only the post read addresses `/api/v1/posts/{slug}`. Passing a slug
 * compiles perfectly and answers 404 at run time. Taken from the shared summary rather than
 * pasted, which also keeps it UUID-shaped by construction - identity is the service's to generate,
 * never this client's to invent.
 */
const postId = fixtureLikeSummary.post_id;

/**
 * The tally as an anonymous reader - or a signed-in reader who has not liked this post - sees it.
 *
 * The shared fixture already IS this state: twelve likes, none of them the caller's. Reusing it means
 * the numbers this file asserts on and the numbers the base handlers would answer with cannot
 * disagree.
 */
const notLiked: LikeSummary = fixtureLikeSummary;

/** The same post one like later: the tally moved by one and the flag is now the caller's own. */
const liked: LikeSummary = { post_id: postId, like_count: 13, liked_by_caller: true };

/** A post nobody has liked yet - the base state for the idempotency cases. */
const untouched: LikeSummary = { post_id: postId, like_count: 0, liked_by_caller: false };

/** That same post after exactly one like, however many times the like was sent. */
const singleLike: LikeSummary = { post_id: postId, like_count: 1, liked_by_caller: true };

/**
 * The answer to a like the service had already recorded: the flag is the caller's, the tally did NOT
 * move.
 *
 * This is `ON CONFLICT DO NOTHING` as a client sees it, and it is the case that separates a control
 * which renders the service's number from one which renders its own arithmetic. The optimistic write
 * guesses thirteen; the service says twelve; twelve is the truth.
 */
const alreadyLiked: LikeSummary = {
  post_id: postId,
  like_count: notLiked.like_count,
  liked_by_caller: true,
};

/**
 * A settled tally the optimistic write could not possibly have guessed.
 *
 * Twenty-eight other readers liked the post while this one was reading it, so the service answers
 * forty-one where the optimistic `+1` predicted thirteen. Any assertion that reaches this number
 * proves the settle came from the RESPONSE rather than from the local guess - which the ordinary
 * twelve-to-thirteen case cannot prove, because there the two agree.
 */
const likedElsewhere: LikeSummary = { post_id: postId, like_count: 41, liked_by_caller: true };

/**
 * A stale snapshot: the caller is recorded as having liked a post whose tally reads zero.
 *
 * Not a state the service can produce, and that is the point - it is what a client can HOLD after
 * another reader's un-like lands between the seed being fetched and the control being pressed. It
 * exercises the optimistic decrement's floor.
 */
const staleLiked: LikeSummary = { post_id: postId, like_count: 0, liked_by_caller: true };

/**
 * The signed-in principal.
 *
 * The shared account rather than a local invention, because the handlers resolve their principal from
 * the TOKEN: `fixtureTokenPair` is this account's pair, so a locally-authored user would make the
 * context and the wire disagree about who is asking. It is a fully-typed `UserMe` - UUID-shaped `id`,
 * snake_case members, and a `role` literal drawn from the `UserRole` union - with no cast anywhere.
 */
const authorAccount: UserMe = fixtureAuthorAccount;

/**
 * The complete accessible name in each state: what pressing does, then how many likes there are.
 *
 * The digit comes from `@/lib/format` so the expectation and the render share one formatter, while the
 * noun is written out per constant - that is the singular/plural contract itself, and deriving it
 * would mean re-implementing the rule under test.
 */
const NAME_NOT_LIKED = `${LABEL_LIKE}, ${formatCount(notLiked.like_count)} likes`;
const NAME_LIKED = `${LABEL_UNLIKE}, ${formatCount(liked.like_count)} likes`;
const NAME_ALREADY_LIKED = `${LABEL_UNLIKE}, ${formatCount(alreadyLiked.like_count)} likes`;
const NAME_LIKED_ELSEWHERE = `${LABEL_UNLIKE}, ${formatCount(likedElsewhere.like_count)} likes`;
const NAME_SIGN_IN = `${LABEL_SIGN_IN}, ${formatCount(notLiked.like_count)} likes`;
const NAME_NO_LIKES = `${LABEL_LIKE}, ${formatCount(untouched.like_count)} likes`;
const NAME_SINGLE_LIKE = `${LABEL_UNLIKE}, ${formatCount(singleLike.like_count)} like`;
const NAME_STALE_LIKED = `${LABEL_UNLIKE}, ${formatCount(staleLiked.like_count)} likes`;

/**
 * A fresh, fully-typed auth context value for a signed-in reader.
 *
 * A factory rather than a shared constant so no test can observe a call another test made. All four
 * actions are stubs: this control never signs anybody in or out, and `restoreError` is `null` because
 * a session that restored cleanly is the state every case here starts from.
 */
function authenticatedAuth(): AuthContextValue {
  return {
    user: authorAccount,
    isLoading: false,
    isAuthenticated: true,
    restoreError: null,
    login: vi.fn(() => Promise.resolve()),
    register: vi.fn(() => Promise.resolve()),
    logout: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
  };
}

/**
 * A visitor with no session - a valid, first-class audience rather than a degraded one.
 *
 * `user: null` inside a live provider is precisely what an anonymous reader looks like. It is NOT the
 * same thing as no provider at all, which `useAuth` treats as a developer error and throws for.
 */
function anonymousAuth(): AuthContextValue {
  return { ...authenticatedAuth(), user: null, isAuthenticated: false };
}

/* -------------------------------------------------------------------------------------------------
 * Request interception
 *
 * The server is seeded with the shared happy-path array and then has this file's RECORDING resolvers
 * layered over it in `beforeEach`. Layering rather than replacing matters twice over: a request this
 * file did not anticipate still reaches a real handler instead of escaping to the network, and
 * `onUnhandledRequest: 'error'` fails anything genuinely unmodelled loudly.
 *
 * Every path below is under `/api/v1`. No unversioned path exists in this API and none appears here.
 * ---------------------------------------------------------------------------------------------- */

/** `PUT` and `DELETE` both address this route. Singular - it names one caller's like of one post. */
const LIKE_PATHNAME = `/api/v1/posts/${postId}/like`;

/**
 * `GET` addresses this one. Plural, because it names the tally - which belongs to the post rather
 * than to any one caller.
 */
const LIKES_PATHNAME = `/api/v1/posts/${postId}/likes`;

/**
 * The interception patterns.
 *
 * The leading `*` matches whatever origin the client composed from `NEXT_PUBLIC_API_BASE_URL`, which
 * `vitest.config.ts` pins - so the pattern follows the configured base URL instead of restating a
 * hostname this file would then have to keep in step. The post identifier is written into the pattern
 * rather than captured as a parameter, so a request for a DIFFERENT post could not be quietly
 * answered by a resolver this file installed for this one.
 */
const LIKE_ROUTE = `*${LIKE_PATHNAME}`;
const LIKES_ROUTE = `*${LIKES_PATHNAME}`;

/** The exact header value the client should attach once `setCredentials` has been called. */
const EXPECTED_AUTHORIZATION = `${BEARER_SCHEME}${fixtureTokenPair.access_token}`;

/**
 * What one intercepted like route answers with: the settled summary, or a refusal.
 *
 * A union rather than two parameters because each route answers exactly one of the two, and the union
 * lets {@link respond} decide the status and the media type from the value itself - so no case can
 * pair a problem document with a 200.
 */
type LikeAnswer = LikeSummary | ProblemDetail;

/**
 * Distinguish a refusal from a summary.
 *
 * `status` is the discriminator because `ProblemDetail` carries it and `LikeSummary` does not - the
 * two shapes have no member in common, so this is a total test rather than a heuristic.
 */
function isProblem(answer: LikeAnswer): answer is ProblemDetail {
  return 'status' in answer;
}

/**
 * Turn an answer into the response the service would send.
 *
 * A refusal carries its own status and `application/problem+json`, which is the one media type every
 * failure path in this API uses; a summary is a plain 200. Typed as the platform `Response` rather
 * than `HttpResponse<T>` because the two branches produce different body types and `HttpResponse`
 * extends `Response`, so a resolver accepts either.
 */
function respond(answer: LikeAnswer): Response {
  if (isProblem(answer)) {
    return HttpResponse.json(answer, {
      status: answer.status,
      headers: { 'Content-Type': PROBLEM_JSON_MEDIA_TYPE },
    });
  }
  return HttpResponse.json(answer);
}

/**
 * One uniform problem document - the only error shape this API emits.
 *
 * `request_id` is always populated because the client synthesises a replacement document for any
 * problem body that omits one, which would discard the very `detail` a failure case asserts on. The
 * shared fixture identifier is used rather than a new literal: it is an obvious placeholder
 * correlation value, not a credential.
 *
 * @param status - The HTTP status, which is also the status the document declares.
 * @param title - The kind of failure. Read by the component only when `detail` is empty.
 * @param detail - The sentence explaining THIS occurrence. Preferred by the component over `title`.
 */
function problem(status: number, title: string, detail: string): ProblemDetail {
  return {
    type: `/errors/${String(status)}`,
    title,
    status,
    detail,
    instance: LIKE_PATHNAME,
    request_id: FIXTURE_REQUEST_ID,
  };
}

/** One intercepted request, reduced to the three things an assertion here needs. */
interface CapturedRequest {
  readonly method: string;
  readonly pathname: string;
  /**
   * The verbatim credential header, or `null` when the request carried none.
   *
   * Captured rather than merely gated on, so "the credential travelled" and "the read needed no
   * credential" are both things a case can assert rather than infer from an outcome.
   */
  readonly authorization: string | null;
}

/**
 * Every like request this test provoked, in order.
 *
 * THE CENTRAL INSTRUMENT OF THIS FILE. The base handler array answers all three like routes, so
 * `onUnhandledRequest: 'error'` cannot catch a stray follow-up read - it would be answered silently
 * and the test would still pass. Reading this log is therefore the only way to assert the ABSENCE of a
 * request, and absence is exactly what the settle-from-the-response design guarantees.
 *
 * Kept as a log rather than a counter so a failure names the request that should not have happened.
 */
let captured: CapturedRequest[] = [];

function record(request: Request): void {
  captured.push({
    method: request.method,
    pathname: new URL(request.url).pathname,
    authorization: request.headers.get(AUTHORIZATION_HEADER),
  });
}

/** Every request whose method matches, for the per-route assertions. */
function capturedWithMethod(method: string): CapturedRequest[] {
  return captured.filter((entry) => entry.method === method);
}

/**
 * The mutation request a case expects, written as a value so a whole-log equality can assert the
 * method, the versioned path and the credential in one place.
 *
 * Comparing the ENTIRE log rather than picking an element out of it is deliberate on two counts: it
 * needs no indexing (which `noUncheckedIndexedAccess` would make `possibly undefined`), and an
 * unexpected extra request fails the assertion instead of hiding behind a filter.
 */
function likeRequest(method: 'PUT' | 'DELETE', authorization: string | null): CapturedRequest {
  return { method, pathname: LIKE_PATHNAME, authorization };
}

/** The tally read a case expects. Plural path, and the credential is whatever the caller held. */
function readRequest(authorization: string | null): CapturedRequest {
  return { method: 'GET', pathname: LIKES_PATHNAME, authorization };
}

/**
 * What each of the three routes should answer with, when a case wants something specific.
 *
 * Any member left out falls back to the summary the real service would send for this fixture state:
 * a like moves twelve to thirteen, an un-like moves it back, and a read reports twelve un-liked. Those
 * are the values the shared handlers themselves compute for this post and this principal, so the
 * defaults are faithful rather than convenient.
 */
interface LikeProgramme {
  readonly onLike?: LikeAnswer;
  readonly onUnlike?: LikeAnswer;
  readonly onRead?: LikeAnswer;
  /**
   * Hold both mutation answers until the test opens the gate.
   *
   * Two assertions are impossible without it. "The tally moves before the service answers" needs the
   * in-flight state to be observable, and `onMutate` awaits a query cancellation before it writes, so
   * that state does not exist synchronously after the click. And "the count REVERTS" is vacuous
   * unless the count is first seen to have moved - a revert that restores the same snapshot it took
   * is indistinguishable from never having written at all.
   *
   * Timer-free by construction: the resolver awaits a promise the test resolves, so there is no
   * interval to tune and no race to lose.
   */
  readonly gate?: Promise<void>;
}

/** A response held open until the test decides the service may answer. */
interface Gate {
  /** Awaited by the gated resolvers. */
  readonly wait: Promise<void>;
  /** Lets the held answers through. Safe to call more than once. */
  open: () => void;
}

function createGate(): Gate {
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    wait,
    open: (): void => {
      release?.();
    },
  };
}

/**
 * The three recording resolvers.
 *
 * Installed with the defaults in `beforeEach`, and layered again by any case that needs a different
 * answer - Mock Service Worker prefers the most recently added handler, so the later installation wins
 * while STILL recording, which is what keeps the request log complete no matter how a case is
 * programmed. `server.resetHandlers()` in `afterEach` removes both layers, so nothing leaks between
 * tests.
 *
 * A `GET` resolver is always installed even by cases that expect no read at all: an override that is
 * never reached is what makes "the counter stayed at zero" an assertion rather than an assumption.
 */
function likeHandlers(programme: LikeProgramme = {}): RequestHandler[] {
  const likeAnswer = programme.onLike ?? liked;
  const unlikeAnswer = programme.onUnlike ?? notLiked;
  const readAnswer = programme.onRead ?? notLiked;
  const gate = programme.gate;

  /** Record first, then hold if the case asked for it, so the log is complete even while gated. */
  async function answer(request: Request, chosen: LikeAnswer): Promise<Response> {
    record(request);
    if (gate !== undefined) {
      await gate;
    }
    return respond(chosen);
  }

  return [
    http.put(LIKE_ROUTE, ({ request }) => answer(request, likeAnswer)),
    http.delete(LIKE_ROUTE, ({ request }) => answer(request, unlikeAnswer)),
    // The read is never gated: no case needs to observe an in-flight read, and gating it would make
    // the "no follow-up request" assertions depend on a promise nobody opens.
    http.get(LIKES_ROUTE, ({ request }) => {
      record(request);
      return respond(readAnswer);
    }),
  ];
}

const server = setupServer(...handlers);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

beforeEach(() => {
  captured = [];
  routerStub.push.mockClear();
  toastStub.error.mockClear();
  // The real client's in-memory credential store, filled through its own exported API so the genuine
  // bearer-attachment path runs. An obvious placeholder string; nothing here builds or decodes a
  // token. The anonymous cases clear it again as their first act.
  setCredentials(fixtureTokenPair);
  server.use(...likeHandlers());
});

afterEach(() => {
  server.resetHandlers();
  clearCredentials();
});

afterAll(() => {
  server.close();
});

/* -------------------------------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------------------------------- */

interface RenderOptions {
  /** Defaults to a signed-in reader; pass {@link anonymousAuth} for a visitor with no session. */
  readonly auth?: AuthContextValue;
  /**
   * Omit it to make the control read the tally itself, which is a supported path rather than a
   * degraded one.
   */
  readonly initialSummary?: LikeSummary;
}

/**
 * Mount the control inside the providers a post reading page would give it.
 *
 * The REAL {@link QueryProvider} rather than a bespoke client, so the tier's own `defaultOptions`
 * apply: `mutations: { retry: 0 }` is what makes every refusal below a single deterministic attempt,
 * and `staleTime` is what makes a seeded mount issue no request. Restating either here would fork the
 * policy and test something the product does not do.
 */
function renderLikeButton(options: RenderOptions = {}): void {
  render(
    <QueryProvider>
      <AuthContext.Provider value={options.auth ?? authenticatedAuth()}>
        <LikeButton initialSummary={options.initialSummary} postId={postId} />
      </AuthContext.Provider>
    </QueryProvider>,
  );
}

/**
 * The control itself.
 *
 * Resolved by ROLE with no name filter, deliberately: the tree holds exactly one button, so this also
 * asserts that the control is a single `<button>` rather than a link or a pair of elements - and it
 * leaves the accessible name to be asserted separately, as a value, rather than being smuggled into
 * the query that found the element.
 */
function control(): HTMLElement {
  return screen.getByRole('button');
}

/**
 * The tally as a reader sees it, without hovering.
 *
 * Queried by its visible text so the assertion is about what is on screen. It cannot collide with the
 * announced phrase: that node reads "Like this post, 12 likes", and an exact text match for "12" does
 * not match it.
 */
function visibleCount(summary: LikeSummary): HTMLElement {
  return screen.getByText(formatCount(summary.like_count));
}

/**
 * Let anything already dispatched actually reach the interceptor and be recorded.
 *
 * NEEDED ONLY BY THE CASES THAT ASSERT AN EMPTY OR UNCHANGED REQUEST LOG, and only because reading the
 * log immediately after a `render` or a click would prove nothing: Mock Service Worker's resolvers run
 * asynchronously, so a request dispatched during mount is recorded on a later tick. React's async
 * `act` drains the microtask queue and crosses a task boundary, which is enough for a dispatched
 * request to have reached {@link record} - and that adequacy is PROVEN rather than assumed by the
 * anonymous read case below, which observes a mount-time `GET` through this primitive and nothing
 * else. If it were insufficient, that case would fail.
 *
 * It is deliberately NOT used to wait for a rendered state. React Query batches its notifications, so
 * a state change can outlast a single pass; every assertion about what is on screen goes through
 * `waitFor` or `findBy*` instead, which poll until the DOM agrees.
 *
 * No timer is involved anywhere. A `setTimeout` race would make the negative assertions flaky in
 * exactly the direction that hides a defect.
 */
async function settlePendingRequests(): Promise<void> {
  await act(async () => {});
}

/* -------------------------------------------------------------------------------------------------
 * Cases
 * ---------------------------------------------------------------------------------------------- */

describe('LikeButton', () => {
  describe('rendering', () => {
    it('renders a seeded summary as an unpressed toggle and asks the service for nothing', async () => {
      renderLikeButton({ initialSummary: notLiked });

      expect(control()).toHaveAccessibleName(NAME_NOT_LIKED);
      // The state a reader with assistive technology gets. `aria-pressed` is present in BOTH states -
      // absent would mean the control is not a toggle at all - so `'false'` is asserted as a value
      // rather than by the attribute merely being missing.
      expect(control()).toHaveAttribute('aria-pressed', 'false');
      // Live, not busy: the seed means there is nothing to wait for, so no advisory disabled state.
      expect(control()).not.toHaveAttribute('aria-disabled');
      expect(visibleCount(notLiked)).toBeVisible();

      // The seed is the whole point of the prop: a page that already fetched the tally server-side
      // hands it in, and the mount then costs nothing. A `GET` resolver IS installed, so this is a
      // counter that stayed at zero rather than a route nobody was watching.
      await settlePendingRequests();
      expect(captured).toEqual([]);
    });

    it('reflects a summary the caller has already liked as a pressed toggle', async () => {
      renderLikeButton({ initialSummary: liked });

      expect(control()).toHaveAccessibleName(NAME_LIKED);
      expect(control()).toHaveAttribute('aria-pressed', 'true');
      expect(visibleCount(liked)).toBeVisible();

      // Nothing here second-guesses the summary it was handed: `liked_by_caller` is mirrored verbatim,
      // which is what makes the pressed state right whenever the seed is right.
      await settlePendingRequests();
      expect(captured).toEqual([]);
    });

    it('keeps the heart glyph and the visible digit out of the accessible name', () => {
      renderLikeButton({ initialSummary: notLiked });

      // An EXACT-equality assertion, and that is the assertion. The glyph is `aria-hidden`, so it
      // contributes nothing; the visible digit is `aria-hidden` too, so the tally is announced once
      // from the phrase rather than twice. Either leaking in would lengthen this string and fail here.
      expect(control()).toHaveAccessibleName(NAME_NOT_LIKED);
      expect(control()).not.toHaveAccessibleDescription();
    });

    it('announces a tally of exactly one in the singular', () => {
      renderLikeButton({ initialSummary: singleLike });

      // "1 likes" is the defect this exists to catch, and it is invisible on screen: the digit alone is
      // what a reader sees, while the noun only ever reaches somebody using a screen reader.
      expect(control()).toHaveAccessibleName(NAME_SINGLE_LIKE);
      expect(visibleCount(singleLike)).toBeVisible();
    });

    it('shows no tally and refuses to act until an unseeded read lands', async () => {
      renderLikeButton();

      // Before the read resolves there is genuinely nothing truthful to render, so the control shows
      // no number rather than guessing at zero - a placeholder tally is a wrong tally.
      expect(control()).toHaveAttribute('aria-disabled', 'true');
      expect(control()).toHaveAccessibleName(LABEL_LIKE);
      expect(screen.queryByText(formatCount(notLiked.like_count))).toBeNull();

      // And once it lands the control comes fully to life, with no advisory disabled state left over.
      expect(await screen.findByRole('button', { name: NAME_NOT_LIKED })).toBeInTheDocument();
      expect(control()).not.toHaveAttribute('aria-disabled');
      expect(visibleCount(notLiked)).toBeVisible();
    });
  });

  describe('liking', () => {
    it('sends PUT /api/v1/posts/{id}/like and settles the count from the response', async () => {
      renderLikeButton({ initialSummary: notLiked });

      fireEvent.click(control());

      await waitFor(() => {
        expect(control()).toHaveAccessibleName(NAME_LIKED);
      });
      expect(control()).toHaveAttribute('aria-pressed', 'true');
      expect(visibleCount(liked)).toBeVisible();

      // The versioned path, the idempotent method, and the credential the client attached from its own
      // store. One entry, so the mount issued no read either.
      expect(captured).toEqual([likeRequest('PUT', EXPECTED_AUTHORIZATION)]);
    });

    it('adopts the tally the service returned rather than the one it guessed', async () => {
      // The service answers forty-one where the optimistic `+1` predicted thirteen, because other
      // readers liked the post in the meantime. Only a control that renders the RESPONSE can pass.
      server.use(...likeHandlers({ onLike: likedElsewhere }));
      renderLikeButton({ initialSummary: notLiked });

      fireEvent.click(control());

      await waitFor(() => {
        expect(control()).toHaveAccessibleName(NAME_LIKED_ELSEWHERE);
      });
      expect(visibleCount(likedElsewhere)).toBeVisible();
      expect(screen.queryByText(formatCount(liked.like_count))).toBeNull();
      expect(captured).toEqual([likeRequest('PUT', EXPECTED_AUTHORIZATION)]);
    });

    it('moves the tally immediately, before the service has answered', async () => {
      const gate = createGate();
      server.use(...likeHandlers({ gate: gate.wait, onLike: likedElsewhere }));
      renderLikeButton({ initialSummary: notLiked });

      fireEvent.click(control());

      // In flight: the tally has already moved by one and the toggle already reads as pressed, so the
      // reader gets an answer at the moment of the press rather than a round trip later. This is one of
      // only two surfaces in the product permitted an optimistic update, and it is permitted precisely
      // because the write is idempotent at the database level and therefore safe to assume succeeded.
      await waitFor(() => {
        expect(control()).toHaveAccessibleName(NAME_LIKED);
      });
      expect(control()).toHaveAttribute('aria-pressed', 'true');
      // Busy while the write is on the wire: announced as unavailable, but still a `<button>` in the
      // tab order - `aria-disabled` rather than `disabled`, so a keyboard reader does not lose focus.
      expect(control()).toHaveAttribute('aria-disabled', 'true');

      gate.open();

      // Settled: the guess is replaced by the service's own figure.
      await waitFor(() => {
        expect(control()).toHaveAccessibleName(NAME_LIKED_ELSEWHERE);
      });
      expect(control()).not.toHaveAttribute('aria-disabled');
    });

    it('makes no follow-up read once the like has settled', async () => {
      renderLikeButton({ initialSummary: notLiked });

      fireEvent.click(control());

      await waitFor(() => {
        expect(control()).toHaveAccessibleName(NAME_LIKED);
      });

      // THE PROPERTY THIS FILE EXISTS FOR. All three like routes answer with the same summary, so the
      // mutation's response IS the settled truth and the interaction is over. An `invalidateQueries`
      // or a `refetch` here would cost a request per click and make the count flicker under the
      // pointer that caused it - and `DELETE /api/v1/posts/{id}/like` answering with a body, the
      // one deletion of its kind in this API, exists for exactly this reason.
      //
      // The `GET` resolver installed in `beforeEach` is the counter. It must never have fired.
      expect(capturedWithMethod('GET')).toEqual([]);
      expect(captured).toHaveLength(1);
    });
  });

  describe('unliking', () => {
    it('sends DELETE /api/v1/posts/{id}/like and reads the settled summary from its body', async () => {
      renderLikeButton({ initialSummary: liked });

      fireEvent.click(control());

      await waitFor(() => {
        expect(control()).toHaveAccessibleName(NAME_NOT_LIKED);
      });
      expect(control()).toHaveAttribute('aria-pressed', 'false');
      expect(visibleCount(notLiked)).toBeVisible();

      // THIS IS THE ONE `DELETE` IN THE ENTIRE API THAT ANSWERS WITH A BODY RATHER THAN 204. A reader
      // who has just un-liked needs the new number, and a second round trip to learn it would make the
      // count flicker. Any "a deletion carries no content" assumption - in the client wrapper, in a
      // mock, or in a future refactor that swaps this call onto the no-content helper - discards the
      // tally the caller came for, and this assertion is what fails when it does.
      expect(captured).toEqual([likeRequest('DELETE', EXPECTED_AUTHORIZATION)]);
      expect(capturedWithMethod('GET')).toEqual([]);
    });

    it('restores the pressed state and the tally when an un-like is refused', async () => {
      server.use(
        ...likeHandlers({ onUnlike: problem(409, 'Conflict', 'That like is already gone.') }),
      );
      renderLikeButton({ initialSummary: liked });

      fireEvent.click(control());

      await waitFor(() => {
        expect(toastStub.error).toHaveBeenCalledWith('That like is already gone.');
      });
      // Back to where the reader left it, flag and figure together - a revert that moved one without
      // the other would leave a pressed control showing an un-liked tally.
      expect(control()).toHaveAccessibleName(NAME_LIKED);
      expect(control()).toHaveAttribute('aria-pressed', 'true');
      expect(visibleCount(liked)).toBeVisible();
      expect(captured).toEqual([likeRequest('DELETE', EXPECTED_AUTHORIZATION)]);
    });
  });

  describe('idempotency', () => {
    it('discards the optimistic increment when the service reports the tally did not move', async () => {
      // `post_likes` is keyed on the pair `(post_id, user_id)` and the insert ignores conflicts, so a
      // like the service had already recorded leaves the count exactly where it was. The optimistic
      // write guesses thirteen; the service says twelve; the control must end at twelve.
      server.use(...likeHandlers({ onLike: alreadyLiked }));
      renderLikeButton({ initialSummary: notLiked });

      fireEvent.click(control());

      await waitFor(() => {
        expect(control()).toHaveAccessibleName(NAME_ALREADY_LIKED);
      });
      expect(control()).toHaveAttribute('aria-pressed', 'true');
      expect(visibleCount(alreadyLiked)).toBeVisible();
      // Never the guess. This is the assertion that distinguishes a control which renders the
      // service's number from one which renders its own arithmetic.
      expect(screen.queryByText(formatCount(liked.like_count))).toBeNull();
    });

    it('leaves the count at one when the control is clicked twice in quick succession', async () => {
      server.use(...likeHandlers({ onLike: singleLike }));
      renderLikeButton({ initialSummary: untouched });

      fireEvent.click(control());
      fireEvent.click(control());

      await waitFor(() => {
        expect(control()).toHaveAccessibleName(NAME_SINGLE_LIKE);
      });
      expect(control()).toHaveAttribute('aria-pressed', 'true');
      expect(visibleCount(singleLike)).toBeVisible();
      // Two identical inserts leave a count of one - measured against the running database, not
      // assumed - and the rendered tally has to agree. Two would mean the client had counted its own
      // clicks instead of reading the service's answer.
      expect(screen.queryByText(formatCount(2))).toBeNull();

      // AND NOTE WHAT IS NOT ASSERTED: not that only one request went out. Both presses land inside a
      // single task here, before React has re-rendered with the pending flag, so both reach the wire -
      // and that is genuinely fine rather than a defect being tolerated. Every like this control sends
      // is the same bodyless write to the same path, and `post_likes` is keyed on `(post_id, user_id)`
      // with a conflict-ignoring insert, so a repeat cannot inflate anything. That is the whole reason
      // this component is allowed an optimistic update and needs no de-duplication of its own.
      captured.forEach((entry) => {
        expect(entry).toEqual(likeRequest('PUT', EXPECTED_AUTHORIZATION));
      });
    });

    it('sends no second like while the first is still on the wire', async () => {
      const gate = createGate();
      server.use(...likeHandlers({ gate: gate.wait, onLike: singleLike }));
      renderLikeButton({ initialSummary: untouched });

      fireEvent.click(control());

      // Wait for the guard to actually be raised before pressing again. This is the state a real double
      // click meets - two genuine presses are tens of milliseconds and separate tasks apart, so the
      // pending flag has always reached the render by the time the second arrives - and it is
      // deterministic rather than a race, because the gated response holds the flag up indefinitely.
      await waitFor(() => {
        expect(control()).toHaveAttribute('aria-disabled', 'true');
      });
      expect(captured).toEqual([likeRequest('PUT', EXPECTED_AUTHORIZATION)]);

      fireEvent.click(control());

      // Refused, and note precisely what the guard is for. It is NOT de-duplication - that is the
      // database's job, and a repeated like could not inflate the tally anyway. It is there so a second
      // mutation cannot queue behind the first and resolve out of order, leaving the cache holding the
      // earlier answer. `aria-disabled` is advisory and does not stop Enter or Space on a focused
      // button, so this guard is what closes the keyboard path too.
      await settlePendingRequests();
      expect(captured).toEqual([likeRequest('PUT', EXPECTED_AUTHORIZATION)]);

      gate.open();

      await waitFor(() => {
        expect(control()).toHaveAccessibleName(NAME_SINGLE_LIKE);
      });
      expect(captured).toEqual([likeRequest('PUT', EXPECTED_AUTHORIZATION)]);
    });

    it('never renders a count below zero when the snapshot it decrements is stale', async () => {
      // A tally of zero that the caller is nonetheless recorded as having liked cannot come from the
      // service - it is what a client HOLDS after somebody else's un-like lands between the seed being
      // fetched and this control being pressed. Decrementing it naively would render `-1`, which is
      // not a number of likes anything can have.
      const gate = createGate();
      server.use(...likeHandlers({ gate: gate.wait, onUnlike: untouched }));
      renderLikeButton({ initialSummary: staleLiked });

      expect(control()).toHaveAccessibleName(NAME_STALE_LIKED);

      fireEvent.click(control());

      await waitFor(() => {
        expect(control()).toHaveAttribute('aria-pressed', 'false');
      });
      // Clamped in flight, and the settle then confirms zero from the service's own answer.
      expect(visibleCount(untouched)).toBeVisible();
      expect(screen.queryByText('-1')).toBeNull();

      gate.open();

      await waitFor(() => {
        expect(control()).not.toHaveAttribute('aria-disabled');
      });
      expect(control()).toHaveAccessibleName(NAME_NO_LIKES);
      expect(screen.queryByText('-1')).toBeNull();
    });
  });

  /*
   * A visitor with no session, framed throughout as USER EXPERIENCE rather than authorisation.
   *
   * Nothing asserted here is a security boundary. `PUT` and `DELETE /api/v1/posts/{id}/like`
   * re-resolve the principal server-side on every call, so a control that was mislabelled, or not
   * gated at all, would still be refused by the service. The prompt exists so a visitor is not
   * handed an action that could only answer 401 - and so that it is never a silent no-op either.
   * The authority itself is proved by the backend suite and by
   * `tests/e2e/comments-likes.spec.ts`.
   */
  describe('anonymous', () => {
    it('offers a sign-in prompt in place of a like for a visitor with no session', () => {
      clearCredentials();
      renderLikeButton({ auth: anonymousAuth(), initialSummary: notLiked });

      // Named for what pressing DOES - it goes to the sign-in form - rather than for the state of the
      // post, because pressing likes nothing.
      expect(control()).toHaveAccessibleName(NAME_SIGN_IN);
      expect(control()).not.toHaveAttribute('aria-disabled');
    });

    it('still shows the tally to a visitor with no session', () => {
      clearCredentials();
      renderLikeButton({ auth: anonymousAuth(), initialSummary: notLiked });

      // A tally is public information, so the number is never hidden from a reader without an account.
      expect(visibleCount(notLiked)).toBeVisible();
      // `liked_by_caller` is `false` for somebody holding no credential, and that is the correct thing
      // to render rather than a missing or indeterminate state. It also keeps the control a genuine
      // toggle: `aria-pressed` is a state of `role="button"` and is not supported on a link, which is
      // why this stays a `<button>` even though pressing it navigates.
      expect(control()).toHaveAttribute('aria-pressed', 'false');
    });

    it('sends a signed-out visitor to the sign-in form carrying the route to return to', async () => {
      clearCredentials();
      renderLikeButton({ auth: anonymousAuth(), initialSummary: notLiked });

      fireEvent.click(control());

      // The current route travels as `next`, so the reader lands back on the article rather than on the
      // home feed. `src/middleware.ts` writes the same shape when it turns an unauthenticated visitor
      // away from a protected route, so the sign-in form needs one reader for both origins.
      expect(routerStub.push).toHaveBeenCalledTimes(1);
      expect(routerStub.push).toHaveBeenCalledWith(EXPECTED_SIGN_IN_HREF);

      // And it is never a silent no-op: no write is attempted, so no refusal is provoked and no error
      // is announced for something the reader did nothing wrong to trigger.
      await settlePendingRequests();
      expect(captured).toEqual([]);
      expect(toastStub.error).not.toHaveBeenCalled();
    });

    it('reads the tally without a credential when no summary is supplied', async () => {
      clearCredentials();
      renderLikeButton({ auth: anonymousAuth() });

      // `GET /api/v1/posts/{id}/likes` requires no bearer - "no credential required" means it must
      // SUCCEED without one, not that one is refused when held - so an anonymous reader who was
      // handed no seed still gets the number.
      await settlePendingRequests();
      expect(captured).toEqual([readRequest(null)]);

      expect(await screen.findByRole('button', { name: NAME_SIGN_IN })).toBeInTheDocument();
      expect(visibleCount(notLiked)).toBeVisible();
    });
  });

  /*
   * Every refusal here is a 4xx, and that is a requirement rather than a preference: the tier's query
   * predicate refuses to retry 4xx and its mutation policy is `retry: 0`, so each case below is a
   * single deterministic attempt whose request log can be asserted exactly. A 5xx would be retried and
   * would make that log non-deterministic.
   */
  describe('failure', () => {
    it('reverts the tally it optimistically moved when a like is refused', async () => {
      const gate = createGate();
      const detail = 'Your session has expired. Sign in again to like this post.';
      server.use(
        ...likeHandlers({ gate: gate.wait, onLike: problem(401, 'Unauthorized', detail) }),
      );
      // No credential in the store, so the client attaches none and the refusal is final: rotation is
      // attempted only for a 401 that answered a request which actually CARRIED a bearer. That keeps
      // this case a single attempt, and the request log below proves it.
      clearCredentials();
      renderLikeButton({ initialSummary: notLiked });

      fireEvent.click(control());

      // Moved first - which is what makes "reverts" mean something. A revert that restored the same
      // snapshot it took, with nothing ever having been written, would pass a final-state assertion
      // vacuously.
      await waitFor(() => {
        expect(control()).toHaveAccessibleName(NAME_LIKED);
      });

      gate.open();

      // Then put back exactly as the reader left it. Restored from the snapshot rather than refetched:
      // the component already holds the number, so a read here would cost a request to learn it twice.
      await waitFor(() => {
        expect(control()).toHaveAccessibleName(NAME_NOT_LIKED);
      });
      expect(control()).toHaveAttribute('aria-pressed', 'false');
      expect(visibleCount(notLiked)).toBeVisible();
      expect(screen.queryByText(formatCount(liked.like_count))).toBeNull();
    });

    it('reports the refusal rather than letting the tally spring back in silence', async () => {
      const detail = 'Your session has expired. Sign in again to like this post.';
      server.use(...likeHandlers({ onLike: problem(401, 'Unauthorized', detail) }));
      clearCredentials();
      renderLikeButton({ initialSummary: notLiked });

      fireEvent.click(control());

      // Silence is the real defect: a count that springs back with no explanation reads as the control
      // being broken rather than as the request having failed. The `detail` is preferred over the
      // `title` because it explains THIS occurrence - "Your session has expired" is of more use to a
      // reader than "Unauthorized".
      await waitFor(() => {
        expect(toastStub.error).toHaveBeenCalledWith(detail);
      });
      expect(toastStub.error).toHaveBeenCalledTimes(1);
    });

    it('makes one attempt and no rotation when a credential-less like answers 401', async () => {
      server.use(
        ...likeHandlers({ onLike: problem(401, 'Unauthorized', 'Authentication is required.') }),
      );
      clearCredentials();
      renderLikeButton({ initialSummary: notLiked });

      fireEvent.click(control());

      await waitFor(() => {
        expect(toastStub.error).toHaveBeenCalledTimes(1);
      });

      // Exactly one request, carrying no credential. A 401 answering a request that presented nothing
      // is the ordinary "this route needs signing in" answer with nothing to refresh, so there is no
      // second attempt and no rotation - and no follow-up read either, on the failure path just as on
      // the success one.
      expect(captured).toEqual([likeRequest('PUT', null)]);
    });

    it('reverts and reports when a like is forbidden, without attempting a rotation', async () => {
      const detail = 'This account may not like posts.';
      server.use(...likeHandlers({ onLike: problem(403, 'Forbidden', detail) }));
      renderLikeButton({ initialSummary: notLiked });

      fireEvent.click(control());

      await waitFor(() => {
        expect(toastStub.error).toHaveBeenCalledWith(detail);
      });
      expect(control()).toHaveAccessibleName(NAME_NOT_LIKED);
      expect(control()).toHaveAttribute('aria-pressed', 'false');

      // The credential DID travel here, and a 403 is still a single attempt: an authority decision is
      // one a fresh token cannot change, so it must surface unchanged rather than provoke a rotation.
      expect(captured).toEqual([likeRequest('PUT', EXPECTED_AUTHORIZATION)]);
    });

    it('reverts and reports when the post a like addresses is gone', async () => {
      const detail = 'No post is stored under that identifier.';
      server.use(...likeHandlers({ onLike: problem(404, 'Not Found', detail) }));
      renderLikeButton({ initialSummary: notLiked });

      fireEvent.click(control());

      await waitFor(() => {
        expect(toastStub.error).toHaveBeenCalledWith(detail);
      });
      expect(control()).toHaveAccessibleName(NAME_NOT_LIKED);
      expect(visibleCount(notLiked)).toBeVisible();
      expect(captured).toEqual([likeRequest('PUT', EXPECTED_AUTHORIZATION)]);
    });

    it('falls back to the problem title when the document carries no detail', async () => {
      server.use(...likeHandlers({ onLike: problem(409, 'Conflict', '') }));
      renderLikeButton({ initialSummary: notLiked });

      fireEvent.click(control());

      // Second choice, not first: `title` names the KIND of failure while `detail` explains the
      // occurrence, so it is only reached when there is no occurrence-specific sentence to show.
      await waitFor(() => {
        expect(toastStub.error).toHaveBeenCalledWith('Conflict');
      });
      expect(control()).toHaveAccessibleName(NAME_NOT_LIKED);
    });

    it('falls back to its own sentence when the problem document explains nothing', async () => {
      server.use(...likeHandlers({ onLike: problem(422, '', '') }));
      renderLikeButton({ initialSummary: notLiked });

      fireEvent.click(control());

      // A readable sentence, always. Never an empty toast, never a stack, and never an internal
      // message: `type`, `instance` and `request_id` are for a log, not for a reader.
      await waitFor(() => {
        expect(toastStub.error).toHaveBeenCalledWith(LIKE_FAILURE_FALLBACK);
      });
      expect(control()).toHaveAccessibleName(NAME_NOT_LIKED);
    });

    it('names the un-like rather than the like when an un-like explains nothing', async () => {
      server.use(...likeHandlers({ onUnlike: problem(422, '', '') }));
      renderLikeButton({ initialSummary: liked });

      fireEvent.click(control());

      // The fallback is specific to what was actually attempted, which is why the intent is threaded
      // through the mutation rather than re-read from the cache the optimistic write had just flipped.
      await waitFor(() => {
        expect(toastStub.error).toHaveBeenCalledWith(UNLIKE_FAILURE_FALLBACK);
      });
      expect(control()).toHaveAccessibleName(NAME_LIKED);
      expect(control()).toHaveAttribute('aria-pressed', 'true');
    });
  });
});
