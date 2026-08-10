/* =================================================================================================
 * comment-item.test.tsx - the component spec for `@/components/blog/comment-item`.
 *
 * `CommentItem` is one comment plus every comment beneath it, and the two decisions that make it
 * correct are both only observable through NEGATIVE assertions:
 *
 *   1. A THREAD ARRIVES IN ONE RESPONSE. `GET /api/v1/posts/{id}/comments` pages TOP-LEVEL comments
 *      only, and every reply travels nested inside `CommentPublic.replies`. So the recursion reads a
 *      tree it already holds and issues NO request of its own. Nothing rendered on screen could ever
 *      reveal a regression that started fetching per node - the thread would look identical while
 *      quietly becoming an N+1 storm that grows with the discussion. This file therefore keeps a LOG
 *      of every intercepted request and asserts it is EMPTY after a three-level thread has rendered.
 *
 *   2. A DELETED PARENT'S REPLIES GO WITH IT BECAUSE OF THE DATABASE, NOT THE CLIENT.
 *      `comments.parent_id` is a self-referencing foreign key with `ON DELETE CASCADE`, so only the
 *      SERVER knows which descendants a deletion took. The component therefore invalidates the thread
 *      and lets the refetch answer, and never walks `replies` to prune anything. This file is
 *      careful never to encode client-side pruning as expected behaviour: after a reply is deleted it
 *      asserts the surrounding nodes are STILL rendered, because the props are the only thing this
 *      harness gives the component and a component that pruned locally would have removed them.
 *
 * WHICH INTERCEPTION ROUTE THIS FILE TOOK, AND WHY (recorded because there were two)
 *
 * `frontend/vitest.setup.ts` deliberately owns NO `setupServer` instance and exports none: its header
 * assigns the server, its default handler list and its `listen`/`resetHandlers`/`close` hooks to
 * "whichever spec owns the server lifecycle", and `frontend/tests/msw/handlers.ts` says the same of
 * itself - it is one flat array, spread into `setupServer` by whichever spec owns that lifecycle. So
 * this spec owns exactly ONE instance, seeded with the shared array and layered with this file's own
 * capturing overrides, exactly as `comment-form.test.tsx`, `like-button.test.tsx` and
 * `post-editor.test.tsx` do. There is no second instance anywhere in this file.
 *
 * The alternative was to mock `@/lib/api/comments` and assert on the argument. It is rejected:
 * `vitest.setup.ts` forbids mocking `fetch` or `src/lib/api/client.ts` because that client owns token
 * attachment, refresh-on-401 and error normalisation, and mocking the wrapper one layer above it
 * retires the same code just as effectively. Intercepting HTTP proves what left the browser;
 * intercepting a function call proves only what a function was handed. It would also make the central
 * claim of this file unprovable - "no request was issued" is a statement about the wire.
 *
 * WHERE THIS FILE DIVERGES FROM AN EXPECTATION, IT FOLLOWS THE SOURCE
 *
 * `maxDepth` DOES NOT TRUNCATE, so this file does not assert that it does. The component's own
 * documentation is explicit - "past the cap the replies are still rendered in full - nothing is
 * hidden, nothing is truncated - they simply stop stepping further in" - and the single effect of
 * crossing the cap is which inset class the reply container carries. That is a token-derived visual
 * and asserting it is forbidden here, so the honest case is the inverse one: a `maxDepth` shallower
 * than the fixture's nesting still renders the deepest reply. A spec asserting truncation would be
 * asserting a bug, and would pass only until somebody fixed it.
 *
 * The real "the discussion continues" affordance is not depth-driven at all. When `replies` is a
 * PREFIX - `reply_count` exceeds the rows delivered - the component reports the shortfall in a
 * SENTENCE rather than fetching the remainder, which is the same design decision as (1) seen from the
 * other side. One case below asserts the sentence appears and that it is not a control.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO. Please do not add:
 *
 *   1. Any assertion on a class name. No `toHaveClass`, no `className` read, no class-based
 *      `querySelector`, no `getComputedStyle`, no snapshot - and in particular no assertion about
 *      reply indentation or nesting depth as a VISUAL. Every value in the component resolves to a
 *      semantic token in `src/app/globals.css` and is free to change. Nesting is asserted
 *      STRUCTURALLY, with `within`, so a reply is proven to sit inside its parent's subtree rather
 *      than merely to be further from the margin. The one `querySelector` here selects `time` by
 *      ELEMENT NAME, which is the same route `author-byline.test.tsx` takes and carries no styling.
 *   2. A per-node request expectation, or a handler shaped to satisfy one. See note 1. The counting
 *      overrides exist to prove those requests are ABSENT.
 *   3. A JSON body on the comment `DELETE`. It answers `204 No Content`, so the override answers with
 *      `new HttpResponse(null, { status: 204 })`. `unlikePost` is the one DELETE in this API that
 *      carries a body; this is not it, and answering JSON here would model a route that does not
 *      exist.
 *   4. An approve or reject control. Moderation `status` is READ-ONLY to this component - it renders
 *      the state to explain why a comment is not public and never writes it. Only
 *      `PATCH /api/v1/admin/comments/{id}/status` moves it, from the admin surface. One case asserts
 *      the absence of any such control.
 *   5. A second `setupServer`, a `fetch` patch, or a mock of `@/lib/api/client` or
 *      `@/lib/api/comments`. See above.
 *   6. Anything from the retired `/items` surface. There is no `/items` path, no `Item` type and no
 *      `{ id, name, price }` object anywhere below: AAP §0.9.4.3 requires that surface provably
 *      absent, and every identifier in every fixture here is a server-generated UUID string.
 *   7. A real `AuthProvider`. It restores a session over HTTP and touches cookies, neither of which
 *      this component does; `useAuth` throws outside a provider, so `AuthContext.Provider` is given a
 *      fully typed stub instead. Nothing here builds, decodes, verifies or asserts on a token, and no
 *      real credential appears - the bearer is an obvious placeholder from the shared fixtures.
 *   8. A 5xx failure. `@/providers/query-provider` sets `mutations: { retry: 0 }` and its query
 *      predicate refuses to replay a 4xx, so the one failure below is a 403: deterministic,
 *      single-attempt, and the refusal a reader actually meets when they act on someone else's
 *      comment.
 *   9. `@testing-library/user-event`. It is not a declared dependency; interaction is `fireEvent`.
 *  10. A jest-dom import or a manual `cleanup()`. `vitest.setup.ts` registers the matchers and
 *      unmounts between tests.
 *  11. A `<Toaster />`. One is mounted for the whole application in `src/app/layout.tsx`; here
 *      `toast` is a spy, and every channel is spied so "no toast fired" is assertable.
 *  12. `vi.stubEnv`. `vitest.config.ts` pins `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_SITE_NAME` and the
 *      API base URL in its own `test.env` block, and `profilePath` builds a RELATIVE path, so there
 *      is no absolute URL here to pin and nothing to restore.
 *  13. A responsive assertion. jsdom applies no media query; the three viewports are asserted in
 *      `frontend/tests/e2e/comments-likes.spec.ts`.
 *  14. `.only` or `.skip`.
 * ============================================================================================== */

import { useQuery } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { RequestHandler } from 'msw';
import { setupServer } from 'msw/node';
import type { JSX, ReactElement } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommentItem } from '@/components/blog/comment-item';
import { clearCredentials, setCredentials } from '@/lib/api/client';
import { listComments } from '@/lib/api/comments';
import { EMPTY_VALUE, formatDate, formatMachineDate, formatRelativeTime } from '@/lib/format';
import { profilePath } from '@/lib/seo';
import type { CommentPublic, ProblemDetail, UserMe, UserPublic } from '@/lib/types';
import { AuthContext } from '@/providers/auth-provider';
import type { AuthContextValue } from '@/providers/auth-provider';
import { QueryProvider } from '@/providers/query-provider';

import { fixtureTokenPair, handlers } from '../msw/handlers';

/* -------------------------------------------------------------------------------------------------
 * Module mocks
 *
 * `vi.hoisted` rather than a bare `const`, because `vi.mock` is lifted above every import in the
 * file: a factory closing over an ordinary module-level binding throws "Cannot access '...' before
 * initialization" at collection time, before a single test runs.
 * ---------------------------------------------------------------------------------------------- */

const { toastStub } = vi.hoisted(() => ({
  /**
   * Every `toast` channel, not only the two the component calls.
   *
   * The source uses `success` on a completed deletion and `error` on a refused one. `info` and
   * `warning` are spied precisely so that "no toast was raised" is an assertable fact rather than an
   * untested assumption - a regression that announced a confirmation before the request landed, or
   * announced anything at all on a plain render, would fail here rather than only being noticed by a
   * reader hearing it.
   */
  toastStub: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: toastStub }));

/** The route a reader is on while the thread is mounted. Feeds the signed-out prompt's return trip. */
const POST_PATHNAME = '/blog/scaling-fastapi-to-a-million-requests';

/**
 * The single App Router hook this component reads.
 *
 * `usePathname` is what the signed-out prompt turns into a `next` parameter, and it resolves from a
 * context no test render provides. `CommentForm` reads the same hook and nothing else from this
 * module, so the narrow mock covers the reply and edit modes too.
 *
 * `next/link` is deliberately NOT mocked: measured in this configuration it renders a plain anchor
 * under jsdom with no router context present, so the profile link and the sign-in prompt are both
 * reachable by their `link` role - and mocking it would replace the one thing worth asserting about
 * them, which is the `href` the component builds.
 */
vi.mock('next/navigation', () => ({ usePathname: (): string => POST_PATHNAME }));

/* -------------------------------------------------------------------------------------------------
 * Contract vocabulary
 *
 * Every value the wire, the route table or the component's copy fixes, named once so a failing
 * assertion cites the contract it broke rather than a bare literal.
 * ---------------------------------------------------------------------------------------------- */

/** The versioned prefix every path in this API carries. No unversioned path appears in this file. */
const API_PREFIX = '/api/v1';

/** The header the client attaches a held credential through. */
const AUTHORIZATION_HEADER = 'Authorization';

/** Scheme prefix of that header's value, including its separating space. */
const BEARER_SCHEME = 'Bearer ';

/** The media type every failure path of this API answers with. */
const PROBLEM_JSON_MEDIA_TYPE = 'application/problem+json';

/** The status a successful comment deletion answers with. No body accompanies it. */
const STATUS_NO_CONTENT = 204;

/** The status a deletion of somebody else's comment answers with. */
const STATUS_FORBIDDEN = 403;

/** The element of a cached query key that marks it as being about comments. */
const COMMENT_QUERY_SCOPE = 'comments';

/** Pagination is 1-based across this API, and the thread probe holds the first page. */
const FIRST_PAGE = 1;

/** Where a signed-out reader is sent. Matches `LOGIN_PATH` in `src/middleware.ts`. */
const LOGIN_PATH = '/login';

/** The parameter carrying the route to come back to. Matches `RETURN_TO_PARAM` in the middleware. */
const RETURN_TO_PARAM = 'next';

/* ------------------------------------------- copy ------------------------------------------------
 * The component declares each of these as a module constant and exports none of them, so a spec has
 * to restate the string it asserts on - the same position `comment-form.test.tsx` is in. Collected
 * here rather than written inline because the accessible names of these controls are the component's
 * contract with a screen reader, so a change should be a one-line edit rather than a hunt.
 * ---------------------------------------------------------------------------------------------- */

/** Visible label of the reply affordance. Its accessible name adds the author - see {@link replyName}. */
const REPLY_LABEL = 'Reply';

/** Visible label of the edit affordance. */
const EDIT_LABEL = 'Edit';

/** Visible label of the delete affordance. */
const DELETE_LABEL = 'Delete';

/** What a signed-out reader is offered in place of a control that could only answer `401`. */
const SIGN_IN_LABEL = 'Sign in to reply';

/** Marks a comment whose text has changed since it was written. Text, never colour alone. */
const EDITED_LABEL = 'edited';

/** Accessible name of the confirmation, taken from its `DialogTitle`. */
const DELETE_DIALOG_TITLE = 'Delete this comment?';

/** The confirmation's primary action, at rest. */
const DELETE_CONFIRM_LABEL = 'Delete comment';

/** The confirmation's way out, and the corner affordance `DialogContent` always renders. */
const CANCEL_LABEL = 'Cancel';
const CLOSE_AFFORDANCE_LABEL = 'Close';

/** Headline and description of the toast confirming a deletion. */
const DELETE_SUCCESS_MESSAGE = 'Comment deleted.';
const DELETE_CASCADE_NOTE = 'Every reply beneath it was removed with it.';

/** Headline of the toast reporting a refused deletion. */
const DELETE_FAILURE_MESSAGE = 'The comment could not be deleted.';

/** The moderation labels, keyed by the wire literal. `APPROVED` renders no badge at all. */
const PENDING_LABEL = 'Awaiting approval';
const REJECTED_LABEL = 'Not approved';

/** The accessible names `CommentForm` gives its field in the two modes this component opens it in. */
const REPLY_FIELD_LABEL = 'Write a reply';
const EDIT_FIELD_LABEL = 'Edit your comment';

/**
 * The reply affordance's accessible name, built the way the component builds it.
 *
 * Derived rather than restated per case, so a thread of four differently-authored nodes can be
 * queried unambiguously: each control names its own comment's author, which is exactly the property
 * that lets a keyboard operator tell forty Reply buttons apart.
 */
function replyName(author: UserPublic): string {
  return `${REPLY_LABEL} to ${author.display_name}`;
}

/** The edit affordance's accessible name. Same construction as {@link replyName}. */
function editName(author: UserPublic): string {
  return `${EDIT_LABEL} comment by ${author.display_name}`;
}

/** The delete affordance's accessible name. Same construction as {@link replyName}. */
function deleteName(author: UserPublic): string {
  return `${DELETE_LABEL} comment by ${author.display_name}`;
}

/**
 * The sign-in trip a signed-out reader is offered, escaped the way the component escapes it.
 *
 * Built through `URLSearchParams` rather than written out with a hand-escaped `%2F`, so the
 * expectation is the contract - path plus `next` parameter - rather than a transcription of one
 * encoder's output that would drift if the component ever switched encoders.
 */
function loginHref(pathname: string): string {
  return `${LOGIN_PATH}?${new URLSearchParams({ [RETURN_TO_PARAM]: pathname }).toString()}`;
}

/** The pathname `deleteComment` addresses for a given comment. Versioned, as every path here is. */
function commentPathname(commentId: string): string {
  return `${API_PREFIX}/comments/${commentId}`;
}

/** The pathname the thread read addresses. The route a per-node fetch would have to reach. */
function threadPathname(postId: string): string {
  return `${API_PREFIX}/posts/${postId}/comments`;
}

/* -------------------------------------------------------------------------------------------------
 * Identity, and why every one of these is a UUID-shaped string
 *
 * The service generates every primary key with `gen_random_uuid()`, so an integer here would
 * misrepresent the wire and quietly reintroduce the client-supplied identity the retired surface had -
 * the defect where a duplicate identifier permanently shadows a later record. Nothing in this file
 * supplies an identifier to the API; every one of these is a value the server is modelled as having
 * produced.
 * ---------------------------------------------------------------------------------------------- */

/** The post the discussion belongs to. Travels as a prop, and in the path of the thread read only. */
const POST_ID = '3f5c1d2e-9b4a-4c8d-a1e6-7f2b8c9d0a11';

/** The four nodes of the nested fixture, top-level first. */
const COMMENT_ID_ROOT = '7c9e4a1b-3f5d-4e2a-8b7c-1d6f9a2b3c50';
const COMMENT_ID_REPLY_ONE = 'b1c2d3e4-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const COMMENT_ID_REPLY_TWO = 'c2d3e4f5-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const COMMENT_ID_GRANDCHILD = 'd3e4f5a6-7b8c-4d9e-8f01-2b3c4d5e6f70';

/**
 * Instants, written fully normalised so every assertion is an equality rather than a range.
 *
 * `formatMachineDate` answers with `Date.prototype.toISOString`, so for an input in this exact
 * spelling its output is byte-identical to the literal - which lets the `dateTime` assertion below
 * check the formatter's output AND the literal itself, and prove they are the same string.
 *
 * `INSTANT_UPDATED` is deliberately far past the component's one-second edit tolerance, so the case
 * that asserts the "edited" marker is unambiguous; every other fixture leaves `updated_at` equal to
 * `created_at`, which is the state of a comment nobody has touched.
 */
const INSTANT_CREATED = '2024-05-11T08:30:00.000Z';
const INSTANT_UPDATED = '2024-05-12T09:45:00.000Z';
const INSTANT_ACCOUNT = '2024-01-04T10:15:00.000Z';

/* ------------------------------------------ accounts ---------------------------------------------
 * Four principals, because `canModify` is a three-way rule and its first paint is a fourth state.
 *
 * Each `UserPublic` is spread into its `UserMe` rather than restated, so the two projections of one
 * person can never disagree about who they are. `avatar_url` is `null` on every one of them: the
 * Radix avatar resolves an image asynchronously and reports a loading status while it does, so an
 * author with a URL would make the initials fallback's presence a race rather than a fact.
 * ---------------------------------------------------------------------------------------------- */

/** The comment's author, as other people see them. A `READER`: commenting needs no more than that. */
const commenter: UserPublic = {
  id: 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  username: 'bob',
  display_name: 'Bob Nakamura',
  bio: null,
  avatar_url: null,
  created_at: INSTANT_ACCOUNT,
};

/** A second person, who authors the first reply. Distinct name, so its controls are distinguishable. */
const replier: UserPublic = {
  id: 'e5f6a7b8-9c0d-4e1f-8a2b-3c4d5e6f7081',
  username: 'alice',
  display_name: 'Alice Rivera',
  bio: 'Backend engineer.',
  avatar_url: null,
  created_at: INSTANT_ACCOUNT,
};

/** A third person, who authors the second reply. */
const bystander: UserPublic = {
  id: 'f6a7b8c9-0d1e-4f2a-8b3c-4d5e6f708192',
  username: 'cara',
  display_name: 'Cara Mendes',
  bio: null,
  avatar_url: null,
  created_at: INSTANT_ACCOUNT,
};

/** The administrator, who authors the deepest reply so the thread is not three-author. */
const moderator: UserPublic = {
  id: '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d',
  username: 'dana',
  display_name: 'Dana Osei',
  bio: 'Maintains the token layer.',
  avatar_url: null,
  created_at: INSTANT_ACCOUNT,
};

/** The comment's author as their own account. `user.id === comment.author.id` is the owner branch. */
const commenterAccount: UserMe = {
  ...commenter,
  email: 'bob@example.test',
  role: 'READER',
  is_active: true,
  updated_at: INSTANT_ACCOUNT,
};

/**
 * A signed-in reader who authored nothing in the fixture.
 *
 * `READER` and a different identifier, which is the whole point: neither half of `canModify` holds,
 * so this is the principal that proves the controls are withheld.
 */
const otherReaderAccount: UserMe = {
  ...bystander,
  email: 'cara@example.test',
  role: 'READER',
  is_active: true,
  updated_at: INSTANT_ACCOUNT,
};

/**
 * An administrator, who also authored nothing they will be asked to act on.
 *
 * `ADMIN` is the second half of `canModify`: authority over a comment they did not write. Using an
 * account that happened to own the comment would make the case pass for the wrong reason.
 */
const adminAccount: UserMe = {
  ...moderator,
  email: 'dana@example.test',
  role: 'ADMIN',
  is_active: true,
  updated_at: INSTANT_ACCOUNT,
};

/* ------------------------------------------ comments ---------------------------------------------
 * One builder and one nested tree, both fully typed with no cast anywhere.
 * ---------------------------------------------------------------------------------------------- */

/** Bodies, distinct per node so a `within` assertion can prove which subtree holds which text. */
const BODY_ROOT = 'The pool sizing point is the one I keep getting wrong.';
const BODY_REPLY_ONE = 'Right - and the pool has to be sized per worker, not per process.';
const BODY_REPLY_TWO = 'Adding the readiness probe alongside this changed how we deploy it.';
const BODY_GRANDCHILD = 'Two levels down, and still delivered inside the parent payload.';

/**
 * A complete {@link CommentPublic}, with every member the wire carries and no cast.
 *
 * `Partial` overrides are spread over a complete base rather than assembled from optional members, so
 * a member added to the contract is a COMPILE error here - the base stops satisfying the interface -
 * rather than an `undefined` that only some case happens to notice. `APPROVED` and matched
 * `created_at`/`updated_at` are the defaults because they are the ordinary state of a comment in a
 * public thread: no moderation badge, no "edited" marker, so a case that wants either asks for it.
 *
 * `reply_count` defaults to `0` and every nested fixture below sets it to `replies.length`. That
 * agreement is deliberate: the component reports a shortfall between the two as a sentence, so a
 * fixture that left `reply_count` high would render an unasked-for note into every other case.
 */
function makeComment(overrides: Partial<CommentPublic> = {}): CommentPublic {
  const base: CommentPublic = {
    id: COMMENT_ID_ROOT,
    post_id: POST_ID,
    parent_id: null,
    author: commenter,
    body: BODY_ROOT,
    status: 'APPROVED',
    created_at: INSTANT_CREATED,
    updated_at: INSTANT_CREATED,
    reply_count: 0,
    has_more_replies: false,
    replies: [],
  };

  return { ...base, ...overrides };
}

/** The deepest node: a reply to a reply, which is what makes the recursion two levels rather than one. */
const grandchildReply: CommentPublic = makeComment({
  id: COMMENT_ID_GRANDCHILD,
  parent_id: COMMENT_ID_REPLY_ONE,
  author: moderator,
  body: BODY_GRANDCHILD,
});

/** The first reply, carrying its own reply - so `depth` reaches 2 and `maxDepth` is exercisable. */
const firstReply: CommentPublic = makeComment({
  id: COMMENT_ID_REPLY_ONE,
  parent_id: COMMENT_ID_ROOT,
  author: replier,
  body: BODY_REPLY_ONE,
  reply_count: 1,
  replies: [grandchildReply],
});

/** The second reply, a leaf - so the sibling case and the empty-replies path are both covered. */
const secondReply: CommentPublic = makeComment({
  id: COMMENT_ID_REPLY_TWO,
  parent_id: COMMENT_ID_ROOT,
  author: bystander,
  body: BODY_REPLY_TWO,
});

/**
 * The nested fixture: a root with two replies, the first of which has its own reply.
 *
 * Four nodes across three levels, delivered as ONE value. That is the whole shape of the threading
 * contract - `listComments` pages roots only and nests everything beneath them - and it is what makes
 * the empty request log below a statement about the design rather than about an idle component.
 */
const threadedComment: CommentPublic = makeComment({
  reply_count: 2,
  replies: [firstReply, secondReply],
});

/** A leaf comment. Used wherever a case wants exactly one node's controls on screen. */
const leafComment: CommentPublic = makeComment();

/* -------------------------------------------------------------------------------------------------
 * Session stubs
 * ---------------------------------------------------------------------------------------------- */

/**
 * A fully typed {@link AuthContextValue}, with the four actions as spies.
 *
 * `AuthContext.Provider` is fed this directly rather than mounting `AuthProvider`, which would restore
 * a session over HTTP and write a cookie - neither of which this component does. `useAuth` throws
 * outside a provider, so the stub is not optional; and it is built here rather than per case so all
 * eight members of the contract are supplied every time.
 *
 * @param user - The principal, or `null` for a signed-out visitor.
 * @param isLoading - `true` for the first paint, while the session is still being resolved. The
 * component withholds all three affordances in that state, which is the fourth principal this file
 * covers even though it is not a person.
 */
function session(user: UserMe | null, isLoading = false): AuthContextValue {
  return {
    user,
    isLoading,
    isAuthenticated: user !== null,
    restoreError: null,
    login: vi.fn(() => Promise.resolve()),
    register: vi.fn(() => Promise.resolve()),
    logout: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
  };
}

/* -------------------------------------------------------------------------------------------------
 * Problem documents
 * ---------------------------------------------------------------------------------------------- */

/**
 * One uniform problem document - the only error shape this API emits.
 *
 * It replaces the ad-hoc `{"detail": "..."}` raise the legacy service repeated at three separate call
 * sites. `request_id` is always populated because the client synthesises a replacement document for
 * any problem body that omits it, which would mask the very `detail` the failure case asserts on.
 */
function problem(status: number, title: string, detail: string, instance: string): ProblemDetail {
  return {
    type: `/errors/${status === STATUS_FORBIDDEN ? 'forbidden' : 'unexpected'}`,
    title,
    status,
    detail,
    instance,
    request_id: 'req-00000000-0000-4000-8000-0000000000ff',
  };
}

/**
 * Answer with a problem document, in the media type the service really sends.
 *
 * Built through the low-level constructor rather than `HttpResponse.json`, which would stamp
 * `application/json` over `application/problem+json`. Typed as the platform `Response` because the
 * body is a serialised string: `HttpResponse<T>`'s parameter describes the PARSED body, so it would
 * have to claim `string` and would then be describing the wrong thing.
 */
function problemResponse(document: ProblemDetail): Response {
  return new HttpResponse(JSON.stringify(document), {
    status: document.status,
    headers: {
      'Content-Type': PROBLEM_JSON_MEDIA_TYPE,
      'X-Request-ID': document.request_id,
    },
  });
}

/* -------------------------------------------------------------------------------------------------
 * Request interception and capture
 *
 * ONE server instance for this file, seeded with the shared happy-path handler array and then layered
 * with this file's capturing overrides in `beforeEach`. Layering rather than replacing matters twice
 * over: a request this file did not anticipate still reaches a real handler instead of escaping, and
 * `onUnhandledRequest: 'error'` makes anything genuinely unmodelled fail the test loudly rather than
 * silently reaching the network.
 * ---------------------------------------------------------------------------------------------- */

const server = setupServer(...handlers);

/** One intercepted request, reduced to the three things an assertion here needs. */
interface CapturedRequest {
  readonly method: string;
  readonly pathname: string;
  /**
   * The verbatim `Authorization` header, or `null` when the request carried none.
   *
   * Captured rather than merely gated on, so "the credential travelled" is something a case can state
   * about the wire. The value is an obvious placeholder string from the shared fixtures; nothing here
   * builds, decodes or verifies a token.
   */
  readonly authorization: string | null;
}

/**
 * Every request this file's overrides saw, in order.
 *
 * THE CENTRAL INSTRUMENT OF THIS FILE. The shared handler array already answers the thread read, so
 * `onUnhandledRequest: 'error'` could never catch a per-node fetch - it would be answered silently
 * and the suite would stay green while the component developed an N+1. Reading this log is the only
 * way to assert the ABSENCE of a request.
 *
 * Kept as a log rather than a counter so a failure names the request that should not have happened,
 * and so an unexpected EXTRA request fails a whole-log equality instead of hiding behind a filter.
 */
let captured: CapturedRequest[] = [];

function record(request: Request): void {
  captured.push({
    method: request.method,
    pathname: new URL(request.url).pathname,
    authorization: request.headers.get(AUTHORIZATION_HEADER),
  });
}

/** Every captured request whose method matches, for the per-route assertions. */
function capturedWithMethod(method: string): CapturedRequest[] {
  return captured.filter((entry) => entry.method === method);
}

/**
 * The credential these overrides expect, built from the pair `beforeEach` actually installs.
 *
 * Derived from {@link fixtureTokenPair} rather than restated, so the expectation cannot drift from the
 * value the client holds: a changed fixture moves both ends together or neither.
 */
const EXPECTED_AUTHORIZATION = `${BEARER_SCHEME}${fixtureTokenPair.access_token}`;

/**
 * A thread page, in the shape `GET /api/v1/posts/{id}/comments` really answers with.
 *
 * Only the thread probe reads this, and it has to satisfy the real zod decoder the API wrapper runs -
 * which is the point: the probe exercises the genuine read path, so an invalidation that reaches it is
 * an invalidation that would reach the page's own thread query.
 */
function threadPage(): {
  items: CommentPublic[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
} {
  return { items: [threadedComment], total: 1, page: FIRST_PAGE, page_size: 20, pages: 1 };
}

/**
 * The overrides, registered for EVERY test.
 *
 * Registered unconditionally so that a case asserting "no request was issued" is reading an empty
 * capture log rather than relying on the absence of a handler, and so no case depends on which
 * fixture the shared array happens to hold. Each resolver records first and answers second, so an
 * attempt is visible even when the answer is a refusal.
 *
 * The second entry is the load-bearing one. `GET /api/v1/comments/{id}` IS NOT A ROUTE in this API -
 * there is no per-comment read - and it is registered here precisely because a component that had
 * started fetching a node's replies would most plausibly reach for it. Registering it turns "that
 * request never happened" into a positive observation instead of an unhandled-request crash whose
 * message would be about routing rather than about the design.
 */
function captureHandlers(): RequestHandler[] {
  return [
    http.get('*/api/v1/posts/:postId/comments', ({ request }) => {
      record(request);
      return HttpResponse.json(threadPage());
    }),
    http.get('*/api/v1/comments/:commentId', ({ request }) => {
      record(request);
      return HttpResponse.json(leafComment);
    }),
    http.post('*/api/v1/posts/:postId/comments', ({ request }) => {
      record(request);
      return HttpResponse.json(leafComment, { status: 201 });
    }),
    http.patch('*/api/v1/comments/:commentId', ({ request }) => {
      record(request);
      return HttpResponse.json(leafComment);
    }),
    // 204 and NO BODY. `deleteComment` resolves to `void` because there is nothing to read back, and
    // the cascade that removes the subtree is the database's - see this file's header, note 2.
    // `unlikePost` is the one DELETE in this API that answers with a body; this is not it.
    http.delete('*/api/v1/comments/:commentId', ({ request }) => {
      record(request);
      return new HttpResponse(null, { status: STATUS_NO_CONTENT });
    }),
  ];
}

/** The sentence the service puts in `detail` when it refuses a deletion. Surfaced by the toast. */
const FORBIDDEN_DETAIL = 'Only the comment\u2019s author or an administrator may delete it.';

/**
 * Refuse the deletion the way the service refuses one the caller has no authority over.
 *
 * Layered over the 204 override for one test only. It records the attempt before refusing it, so the
 * "exactly one attempt" assertion is reading the wire rather than inferring from the toast.
 */
function forbiddenDeleteHandler(commentId: string): RequestHandler {
  return http.delete('*/api/v1/comments/:commentId', ({ request }) => {
    record(request);
    return problemResponse(
      problem(STATUS_FORBIDDEN, 'Forbidden', FORBIDDEN_DETAIL, commentPathname(commentId)),
    );
  });
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

beforeEach(() => {
  captured = [];
  toastStub.error.mockClear();
  toastStub.info.mockClear();
  toastStub.success.mockClear();
  toastStub.warning.mockClear();
  // The real client's in-memory credential store, filled through its own exported API so the genuine
  // bearer-attachment path runs. The value is an obvious placeholder from the shared fixtures.
  setCredentials(fixtureTokenPair);
  server.use(...captureHandlers());
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

/**
 * A probe holding the thread query the component's invalidation is aimed at.
 *
 * Opt-in, and mounted by exactly one case. The component answers a completed deletion by invalidating
 * every cached query that describes this post's thread and awaiting the refetch - it never prunes
 * `replies` locally, because only the server knows what the cascade took. That behaviour is invisible
 * from the rendered output, so this probe makes it observable: it holds a live query on the thread key,
 * so an invalidation that reaches it produces a SECOND `GET` in the capture log.
 *
 * It renders nothing. The assertion is about the request log, and a visible element would only add a
 * node for another query to trip over.
 *
 * The query function is the real `listComments`, so the refetch travels through the genuine client and
 * the genuine decoder rather than a stand-in. That is what makes the probe evidence about the
 * component's cache behaviour rather than about the probe's own wiring.
 */
function ThreadProbe({ postId }: { readonly postId: string }): JSX.Element | null {
  useQuery({
    queryKey: [COMMENT_QUERY_SCOPE, postId, FIRST_PAGE],
    queryFn: () => listComments(postId),
  });

  return null;
}

interface RenderOptions {
  /** The comment to render, with its replies nested inside it. Defaults to the leaf. */
  readonly comment?: CommentPublic;
  /** The signed-in principal. Pass `null` for a visitor with no session. Defaults to the author. */
  readonly user?: UserMe | null;
  /** `true` to render the first paint, while the session is still resolving. */
  readonly isLoading?: boolean;
  /** How deep this node sits. Omitted by a page mounting a root; the recursion supplies it. */
  readonly depth?: number;
  /** How many levels are drawn with an indent before the nesting goes flush. */
  readonly maxDepth?: number;
  /** Mount {@link ThreadProbe} alongside, so a cache invalidation becomes an observable request. */
  readonly withThreadProbe?: boolean;
}

/**
 * Mount the comment inside the two providers a post page would give it.
 *
 * The REAL {@link QueryProvider} rather than a bespoke client, so the tier's own `defaultOptions`
 * apply - notably `mutations: { retry: 0 }`, which makes the failure case below a single deterministic
 * attempt, and a query predicate that refuses to replay a 4xx, which is why no case here uses a 5xx.
 *
 * `depth` and `maxDepth` are forwarded only when the caller named them, so "omitted" and "passed as
 * `undefined`" stay distinguishable: the component's own defaults are part of its contract, and a case
 * that passed `maxDepth={undefined}` would be testing the default while appearing to test a bound.
 *
 * @returns The render result, so a case can reach `container` for the one element-name query this file
 * makes - `time`, which carries no role of its own and cannot be resolved any other way.
 */
function renderCommentItem(options: RenderOptions = {}): ReturnType<typeof render> {
  const comment = options.comment ?? leafComment;
  const user = options.user === undefined ? commenterAccount : options.user;
  const value = session(user, options.isLoading ?? false);

  // Named `subject` rather than `item`: the retired `/items` surface and its `Item` model are required
  // to be provably absent from this tier (AAP §0.9.4.3), and a local called `item` would be the one
  // identifier here that a grep for that surface would surface.
  const subject: ReactElement =
    options.depth === undefined ? (
      options.maxDepth === undefined ? (
        <CommentItem comment={comment} postId={POST_ID} />
      ) : (
        <CommentItem comment={comment} maxDepth={options.maxDepth} postId={POST_ID} />
      )
    ) : options.maxDepth === undefined ? (
      <CommentItem comment={comment} depth={options.depth} postId={POST_ID} />
    ) : (
      <CommentItem
        comment={comment}
        depth={options.depth}
        maxDepth={options.maxDepth}
        postId={POST_ID}
      />
    );

  return render(
    <QueryProvider>
      <AuthContext.Provider value={value}>
        {options.withThreadProbe === true && <ThreadProbe postId={POST_ID} />}
        {subject}
      </AuthContext.Provider>
    </QueryProvider>,
  );
}

/* -------------------------------------------------------------------------------------------------
 * Query helpers
 *
 * Every one resolves an element by its ROLE, its accessible name or its visible text. Nothing here
 * reads a class name or a class-based selector, and the single `querySelector` selects an element by
 * NAME - `time` exposes no role, so there is no other way to reach it.
 * ---------------------------------------------------------------------------------------------- */

/** A control by its exact accessible name. Exact, so "Delete comment" cannot match a Delete trigger. */
function action(name: string): HTMLElement {
  return screen.getByRole('button', { name });
}

/** A control by its accessible name, or `null` when the component withheld it. */
function maybeAction(name: string | RegExp): HTMLElement | null {
  return screen.queryByRole('button', { name });
}

/** The `<time>` element, or `null` when the component declined to emit one. */
function timeElement(container: HTMLElement): HTMLElement | null {
  return container.querySelector('time');
}

/** The confirmation panel, awaited because opening it is a state change plus a portal mount. */
function openConfirmation(): Promise<HTMLElement> {
  return screen.findByRole('dialog');
}

/**
 * The outermost comment `<article>`, as the accessibility tree exposes it.
 *
 * Two properties of this query are worth knowing before using it.
 *
 * It scopes text lookups to the thread itself, which matters once a confirmation has QUOTED the
 * comment body - Radix portals its panel to `document.body`, so the quote sits outside every article
 * and a bare text query would find two matches.
 *
 * And it resolves NOTHING while a confirmation is open, which is not a limitation but the modality
 * guarantee being observed: Radix conveys modality by applying `aria-hidden="true"` to every other
 * child of `document.body` rather than by emitting `aria-modal`, so the whole thread genuinely leaves
 * the accessibility tree for as long as the dialog holds it. A case that needs the article therefore
 * dismisses the dialog first, which is also what a reader does.
 */
function rootArticle(): HTMLElement {
  const [article] = screen.getAllByRole('article');

  if (article === undefined) {
    throw new Error(
      'The component rendered no <article>. Every comment node is wrapped in one, so its absence ' +
        'means the component rendered nothing at all.',
    );
  }

  return article;
}

/** The `<article>` wrapping a node, found by the body text it contains. */
function subtreeContaining(body: string): HTMLElement {
  const paragraph = screen.getByText(body);
  const article = paragraph.closest('article');

  if (article === null) {
    throw new Error(
      `The comment whose body is "${body}" is not inside an <article>. The component wraps every ` +
        'node in one, so a different element means its structure changed.',
    );
  }

  return article;
}

/* -------------------------------------------------------------------------------------------------
 * Assertion helpers
 * ---------------------------------------------------------------------------------------------- */

/** The one request a case provoked, refusing to guess when there were none or several. */
function onlyRequest(): CapturedRequest {
  expect(captured).toHaveLength(1);
  const [entry] = captured;

  if (entry === undefined) {
    throw new Error('No request was captured, so there is nothing to assert about the wire.');
  }

  return entry;
}

/** No toast on any channel. Asserted wherever the component should have announced nothing. */
function expectNoToast(): void {
  expect(toastStub.success).not.toHaveBeenCalled();
  expect(toastStub.error).not.toHaveBeenCalled();
  expect(toastStub.info).not.toHaveBeenCalled();
  expect(toastStub.warning).not.toHaveBeenCalled();
}

/* =================================================================================================
 * Specs
 * ============================================================================================== */

describe('CommentItem', () => {
  describe('rendering', () => {
    it('renders the comment body as text', () => {
      renderCommentItem();

      expect(screen.getByText(BODY_ROOT)).toBeVisible();
    });

    it('links the author name to their profile at /u/{username}', () => {
      renderCommentItem();

      const link = screen.getByRole('link', { name: commenter.display_name });

      // The link TEXT is the name, which is what makes it descriptive rather than "click here"; and
      // the href is the relative path `@/lib/seo` builds, never an absolute URL, so a reader stays
      // inside the client-side router.
      expect(link).toHaveAttribute('href', profilePath(commenter.username));
      expect(link).toHaveAccessibleName(commenter.display_name);
    });

    it('falls back to the username as the link text when the display name is blank', () => {
      // `display_name` mirrors a `TEXT NOT NULL` column, so this is a BLANKNESS case rather than a
      // null one: `'   '` would render a link with no perceivable text, which is a WCAG failure and
      // not merely a cosmetic one.
      const blankNamed: UserPublic = { ...commenter, display_name: '   ' };
      renderCommentItem({ comment: makeComment({ author: blankNamed }) });

      const link = screen.getByRole('link', { name: commenter.username });

      expect(link).toHaveAttribute('href', profilePath(commenter.username));
    });

    it('emits a <time> carrying the machine-readable instant in dateTime', () => {
      const { container } = renderCommentItem();

      const time = timeElement(container);

      // Two assertions on one attribute, deliberately. The first says the element carries what the
      // format module produces; the second says that value is the ISO instant the wire sent, which is
      // only true because the fixture is written fully normalised. Together they prove the attribute
      // is the unambiguous instant assistive technology and crawlers read, rather than a formatted
      // phrase they would have to parse.
      expect(time).toHaveAttribute('dateTime', formatMachineDate(INSTANT_CREATED));
      expect(time).toHaveAttribute('dateTime', INSTANT_CREATED);
      expect(Date.parse(time?.getAttribute('dateTime') ?? '')).toBe(Date.parse(INSTANT_CREATED));
    });

    it('shows the relative phrase the format module produces, and keeps the absolute date reachable', () => {
      const { container } = renderCommentItem();

      // Compared against the formatter's own output rather than a hardcoded phrase: the component
      // measures against an instant it captures itself, so a literal here would encode one machine's
      // clock. The fixture is two years old, so the distance is reported in years and a few
      // milliseconds of drift between the component's reference instant and this one cannot change
      // the wording - verified against date-fns for this input.
      const expectedRelative = formatRelativeTime(INSTANT_CREATED, new Date().toISOString());
      const time = timeElement(container);

      expect(expectedRelative).not.toBe(EMPTY_VALUE);
      expect(time?.textContent).toBe(expectedRelative);
      // The absolute date is not lost: it is the element's `title`, and it is only set while the
      // visible text is the relative phrase - a tooltip repeating the text beneath it would be noise.
      expect(time).toHaveAttribute('title', formatDate(INSTANT_CREATED));
    });

    it('marks a comment whose text has changed since it was written', () => {
      renderCommentItem({
        comment: makeComment({ updated_at: INSTANT_UPDATED }),
      });

      // Words, not a colour and not an icon: an edit is a fact about the comment and has to survive
      // being read aloud.
      expect(screen.getByText(EDITED_LABEL)).toBeVisible();
    });

    it('leaves an untouched comment unmarked', () => {
      renderCommentItem();

      expect(screen.queryByText(EDITED_LABEL)).toBeNull();
    });

    it('emits no heading, because the page owns its h1 and the list owns the discussion heading', () => {
      renderCommentItem({ comment: threadedComment });

      // A node that emitted a heading would insert a level into somebody else's document outline.
      expect(screen.queryAllByRole('heading')).toHaveLength(0);
    });

    it('hides the avatar from assistive technology, because the name is already adjacent', () => {
      renderCommentItem();

      // The initials are decorative: announcing "BN Bob Nakamura" would spell the name out twice. The
      // fallback text is therefore present in the DOM but outside the accessibility tree, which is
      // what `queryByText` with `ignore` cannot express and `toBeVisible` on the link can - so the
      // assertion is that the name resolves EXACTLY once as an accessible name.
      expect(screen.getAllByRole('link', { name: commenter.display_name })).toHaveLength(1);
    });

    it('announces nothing on a plain render', () => {
      renderCommentItem({ comment: threadedComment });

      expectNoToast();
    });
  });

  describe('replies', () => {
    it('renders every reply from the parent payload, at every level', () => {
      renderCommentItem({ comment: threadedComment });

      // Four nodes, three levels, one value. Each is found by its own text, which is what "the thread
      // is discoverable" means for a screen-reader user stepping through it.
      expect(screen.getByText(BODY_ROOT)).toBeVisible();
      expect(screen.getByText(BODY_REPLY_ONE)).toBeVisible();
      expect(screen.getByText(BODY_REPLY_TWO)).toBeVisible();
      expect(screen.getByText(BODY_GRANDCHILD)).toBeVisible();
    });

    it('nests each reply inside its parent subtree', () => {
      renderCommentItem({ comment: threadedComment });

      // STRUCTURE, not indentation. `within` proves containment in the DOM, which is the fact a
      // screen reader conveys and which survives every change to the token layer; the inset is a
      // token-derived visual and is asserted nowhere in this file.
      const root = subtreeContaining(BODY_ROOT);
      expect(within(root).getByText(BODY_REPLY_ONE)).toBeVisible();
      expect(within(root).getByText(BODY_REPLY_TWO)).toBeVisible();

      const firstReplySubtree = subtreeContaining(BODY_REPLY_ONE);
      expect(within(firstReplySubtree).getByText(BODY_GRANDCHILD)).toBeVisible();

      // And the sibling is NOT inside the other sibling, which is what makes the containment above a
      // statement about the tree rather than about everything being inside everything.
      const secondReplySubtree = subtreeContaining(BODY_REPLY_TWO);
      expect(within(secondReplySubtree).queryByText(BODY_GRANDCHILD)).toBeNull();
      expect(within(secondReplySubtree).queryByText(BODY_REPLY_ONE)).toBeNull();
    });

    it('exposes the replies as a list, so a screen reader can step between them', () => {
      renderCommentItem({ comment: threadedComment });

      const root = subtreeContaining(BODY_ROOT);
      // The root's own reply collection is the first list inside it: two items, one per reply. A run
      // of sibling articles would carry none of that - "list, 2 items" is information the roles add.
      const lists = within(root).getAllByRole('list');
      const [rootList] = lists;

      if (rootList === undefined) {
        throw new Error('The component rendered no list for a comment that has replies.');
      }

      expect(within(rootList).getAllByRole('listitem').length).toBeGreaterThanOrEqual(2);
    });

    it('emits no list for a leaf comment, so the recursion terminates cleanly', () => {
      renderCommentItem({ comment: leafComment });

      expect(screen.queryAllByRole('list')).toHaveLength(0);
    });

    it('issues NO request while rendering a three-level thread', async () => {
      renderCommentItem({ comment: threadedComment, user: adminAccount });

      // Every node is on screen before the log is read, so this is "nothing was fetched" rather than
      // "nothing had been fetched yet".
      await waitFor(() => {
        expect(screen.getByText(BODY_GRANDCHILD)).toBeVisible();
      });

      // THE CENTRAL ASSERTION OF THIS FILE. The overrides in `beforeEach` cover the thread read, a
      // per-comment read that is not even a route, and both mutations - so this is a counter that
      // stayed at zero rather than a route nobody was watching. Replies came from
      // `CommentPublic.replies`; had they come from a fetch per node, four nodes would have produced
      // requests here and the discussion would have got slower as it grew.
      expect(captured).toStrictEqual([]);
    });

    it('reports a reply collection that is only a prefix in words, and not as a control', () => {
      // `reply_count` is the service's real tally, counted under the same moderation filter as the
      // rows; `replies` may carry only the first few. The shortfall is the one case where a component
      // could be tempted into a per-node fetch, so the component states it instead.
      renderCommentItem({
        comment: makeComment({ reply_count: 5, replies: [firstReply] }),
        user: otherReaderAccount,
      });

      expect(screen.getByText('4 more replies on this comment.')).toBeVisible();
      // Not a button, not a link: continuing a wide reply collection belongs to whichever surface owns
      // the thread's pagination, and this component issues no request of its own.
      expect(maybeAction(/more repl/i)).toBeNull();
      expect(screen.queryByRole('link', { name: /more repl/i })).toBeNull();
      expect(captured).toStrictEqual([]);
    });

    it('says nothing when the delivered rows already account for the tally', () => {
      renderCommentItem({ comment: threadedComment, user: otherReaderAccount });

      expect(screen.queryByText(/more repl/i)).toBeNull();
    });
  });

  describe('depth and maxDepth', () => {
    it('accepts an explicit depth and still renders the comment', () => {
      // `depth` decides one thing only - whether this node's replies step further in - so a caller
      // rendering a subtree in isolation may legitimately start it anywhere. No indentation is
      // asserted, here or anywhere: the inset is a token-derived visual.
      renderCommentItem({ comment: threadedComment, depth: 3 });

      expect(screen.getByText(BODY_ROOT)).toBeVisible();
      expect(screen.getByText(BODY_REPLY_ONE)).toBeVisible();
      expect(screen.getByText(BODY_GRANDCHILD)).toBeVisible();
    });

    it('renders the deepest reply in full even when maxDepth is shallower than the nesting', () => {
      // maxDepth IS NOT A TRUNCATION, and this case exists to hold that line. The component's own
      // documentation is explicit: past the cap "the replies are still rendered in full - nothing is
      // hidden, nothing is truncated - they simply stop stepping further in". The cap is a
      // responsiveness bound, because each level costs inline space and an uncapped indent puts a deep
      // thread into horizontal scroll at 375px.
      //
      // So the honest assertion is that nothing disappears. Asserting the opposite would be asserting
      // a bug - a reply silently dropped from a discussion - and the only thing crossing the cap
      // actually changes is which inset class the container carries, which this file may not read.
      renderCommentItem({ comment: threadedComment, maxDepth: 0 });

      expect(screen.getByText(BODY_ROOT)).toBeVisible();
      expect(screen.getByText(BODY_REPLY_ONE)).toBeVisible();
      expect(screen.getByText(BODY_REPLY_TWO)).toBeVisible();
      expect(screen.getByText(BODY_GRANDCHILD)).toBeVisible();

      // And it stays a real list at every level, so the flush presentation costs no semantics.
      const firstReplySubtree = subtreeContaining(BODY_REPLY_ONE);
      expect(within(firstReplySubtree).getByText(BODY_GRANDCHILD)).toBeVisible();
    });

    it('renders the whole thread on the default maxDepth without being told one', () => {
      renderCommentItem({ comment: threadedComment });

      expect(screen.getByText(BODY_GRANDCHILD)).toBeVisible();
    });
  });

  /* -----------------------------------------------------------------------------------------------
   * Permissions
   *
   * EVERY ASSERTION IN THIS BLOCK IS ABOUT WHAT IS ON SCREEN, AND NOTHING MORE.
   *
   * `canModify` mirrors the service's rule so that the controls a reader sees match the requests that
   * would succeed. It is not what makes them safe. AAP §0.6.5 is explicit that client-side gating is
   * not a security boundary: `PATCH` and `DELETE /api/v1/comments/{id}` re-check ownership in
   * `backend/app/services/comment_service.py` on every request and answer `403` otherwise, and that
   * server-side authority is proven in `backend/tests/integration/test_comments_api.py`. A withheld
   * button is a courtesy to the reader, so these cases are named as the user-experience assertions
   * they are.
   * -------------------------------------------------------------------------------------------- */
  describe('permissions (which controls are OFFERED - authority is re-checked server-side)', () => {
    it('offers Edit and Delete to the comment author', () => {
      renderCommentItem({ user: commenterAccount });

      // The owner branch of `canModify`: `user.id === comment.author.id`.
      expect(commenterAccount.id).toBe(leafComment.author.id);
      expect(action(editName(commenter))).toBeVisible();
      expect(action(deleteName(commenter))).toBeVisible();
    });

    it('offers Edit and Delete to an ADMIN on a comment somebody else wrote', () => {
      renderCommentItem({ user: adminAccount });

      // The role branch of `canModify`, and the two guards below are what stop this case passing for
      // the wrong reason: the administrator is a DIFFERENT person from the author, so ownership cannot
      // be what put the controls on screen.
      expect(adminAccount.id).not.toBe(leafComment.author.id);
      expect(adminAccount.role).toBe('ADMIN');
      expect(action(editName(commenter))).toBeVisible();
      expect(action(deleteName(commenter))).toBeVisible();
    });

    it('does not offer Edit or Delete to a signed-in READER who wrote neither', () => {
      renderCommentItem({ user: otherReaderAccount });

      expect(otherReaderAccount.id).not.toBe(leafComment.author.id);
      expect(otherReaderAccount.role).toBe('READER');
      expect(maybeAction(/edit/i)).toBeNull();
      expect(maybeAction(/delete/i)).toBeNull();
    });

    it('still offers Reply to a signed-in READER, because replying needs no authority over the comment', () => {
      renderCommentItem({ user: otherReaderAccount });

      // `canReply` and `canModify` are separate conditions, and this is the case that keeps them
      // separate: a reader who may not edit a comment may certainly answer it.
      expect(action(replyName(commenter))).toBeVisible();
    });

    it('offers a signed-out reader the sign-in trip instead of a control that could only be refused', () => {
      renderCommentItem({ user: null });

      expect(maybeAction(/edit/i)).toBeNull();
      expect(maybeAction(/delete/i)).toBeNull();
      expect(maybeAction(new RegExp(REPLY_LABEL, 'i'))).toBeNull();

      // A LINK rather than a button, because it navigates - and it remembers where the reader was, so
      // signing in brings them back to the discussion rather than to the home page.
      const signIn = screen.getByRole('link', { name: SIGN_IN_LABEL });
      expect(signIn).toHaveAttribute('href', loginHref(POST_PATHNAME));
    });

    it('offers nothing at all while the session is still resolving', () => {
      renderCommentItem({ user: null, isLoading: true });

      // A `null` account means "anonymous" only once the restore has finished. Rendering against it
      // earlier is what makes controls appear, vanish and reappear on one paint, so all four
      // affordances are withheld - including the sign-in prompt.
      expect(maybeAction(/edit/i)).toBeNull();
      expect(maybeAction(/delete/i)).toBeNull();
      expect(maybeAction(new RegExp(REPLY_LABEL, 'i'))).toBeNull();
      expect(screen.queryByRole('link', { name: SIGN_IN_LABEL })).toBeNull();

      // The comment itself is never withheld: content does not wait on a session.
      expect(screen.getByText(BODY_ROOT)).toBeVisible();
    });

    it('names each control after its own comment, so a thread of them stays distinguishable', () => {
      renderCommentItem({ comment: threadedComment, user: adminAccount });

      // Four differently-authored nodes, four uniquely named Delete controls. This is WCAG 2.5.3 in
      // practice: the visible label is a prefix of the accessible name, and the name says which
      // comment the control acts on rather than leaving a keyboard operator to count buttons.
      for (const author of [commenter, replier, bystander, moderator]) {
        expect(action(deleteName(author))).toBeVisible();
        expect(action(replyName(author))).toBeVisible();
      }
    });
  });

  describe('reply and edit delegate to CommentForm', () => {
    it('reveals a labelled reply field when Reply is pressed', () => {
      renderCommentItem({ user: otherReaderAccount });

      expect(screen.queryByRole('textbox', { name: REPLY_FIELD_LABEL })).toBeNull();

      fireEvent.click(action(replyName(commenter)));

      // The field's internals belong to `comment-form.test.tsx`; what matters here is that the
      // delegation happened and that the disclosure is announced, which the toggle's `aria-expanded`
      // is what carries.
      expect(screen.getByRole('textbox', { name: REPLY_FIELD_LABEL })).toBeVisible();
      expect(action(replyName(commenter))).toHaveAttribute('aria-expanded', 'true');
      expect(captured).toStrictEqual([]);
    });

    it('closes the reply field when Reply is pressed again', () => {
      renderCommentItem({ user: otherReaderAccount });

      fireEvent.click(action(replyName(commenter)));
      fireEvent.click(action(replyName(commenter)));

      expect(screen.queryByRole('textbox', { name: REPLY_FIELD_LABEL })).toBeNull();
      expect(captured).toStrictEqual([]);
    });

    it('reveals an editor pre-filled with the comment body when Edit is pressed', () => {
      renderCommentItem({ user: commenterAccount });

      fireEvent.click(action(editName(commenter)));

      // Pre-filled from the comment the component was given, which is what proves the edit mode was
      // handed the right node rather than an empty form that happened to appear.
      expect(screen.getByRole('textbox', { name: EDIT_FIELD_LABEL })).toHaveValue(BODY_ROOT);
      expect(captured).toStrictEqual([]);
    });

    it('replaces the body with the editor rather than showing the comment twice', () => {
      renderCommentItem({ user: commenterAccount });

      fireEvent.click(action(editName(commenter)));

      // The paragraph is gone: a comment and a copy of it being edited on screen at once would leave a
      // reader unsure which one they were changing. The text now lives only in the field's value.
      expect(screen.queryByText(BODY_ROOT)).toBeNull();
      expect(screen.getByRole('textbox', { name: EDIT_FIELD_LABEL })).toHaveValue(BODY_ROOT);
    });

    it('keeps the reply field on a node while its own subtree stays rendered', () => {
      renderCommentItem({ comment: threadedComment, user: adminAccount });

      fireEvent.click(action(replyName(replier)));

      const firstReplySubtree = subtreeContaining(BODY_REPLY_ONE);
      expect(
        within(firstReplySubtree).getByRole('textbox', { name: REPLY_FIELD_LABEL }),
      ).toBeVisible();
      // The reply box belongs to the node that opened it, and opening one changes nothing else about
      // the thread - the grandchild is still there beneath it.
      expect(within(firstReplySubtree).getByText(BODY_GRANDCHILD)).toBeVisible();
      expect(captured).toStrictEqual([]);
    });
  });

  describe('delete', () => {
    it('asks for confirmation before issuing anything, and names the dialog from its title', async () => {
      renderCommentItem({ user: commenterAccount });

      fireEvent.click(action(deleteName(commenter)));

      const dialog = await openConfirmation();

      // Radix supplies `role="dialog"` and wires `aria-labelledby` to `DialogTitle`, so the panel's
      // accessible name IS the question being asked. A confirmation a screen reader could not name
      // would be a modal of unknown purpose.
      expect(dialog).toHaveAccessibleName(DELETE_DIALOG_TITLE);
      // The dialog is a gate, not a formality: opening it must not have deleted anything.
      expect(captured).toStrictEqual([]);
      expectNoToast();
    });

    it('states the cascade before the act, not only afterwards', async () => {
      renderCommentItem({ comment: threadedComment, user: commenterAccount });

      fireEvent.click(action(deleteName(commenter)));

      const dialog = await openConfirmation();

      // The subtree going with the parent is the one fact a reader cannot infer from the comment in
      // front of them, so it is stated in the description AND quantified from `reply_count` - the
      // service's own tally, never `replies.length`, which may be a prefix.
      expect(within(dialog).getByText(/along with every reply beneath it/i)).toBeVisible();
      expect(within(dialog).getByText(/2 direct replies/i)).toBeVisible();
      expect(captured).toStrictEqual([]);
    });

    it('issues nothing when the confirmation is dismissed with Escape', async () => {
      renderCommentItem({ user: commenterAccount });

      fireEvent.click(action(deleteName(commenter)));
      await openConfirmation();

      fireEvent.keyDown(document, { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(captured).toStrictEqual([]);
      expectNoToast();
    });

    it('issues nothing when the confirmation is cancelled', async () => {
      renderCommentItem({ user: commenterAccount });

      fireEvent.click(action(deleteName(commenter)));
      const dialog = await openConfirmation();

      fireEvent.click(within(dialog).getByRole('button', { name: CANCEL_LABEL }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(captured).toStrictEqual([]);
      expectNoToast();
    });

    it('issues nothing when the confirmation is closed from its corner affordance', async () => {
      renderCommentItem({ user: commenterAccount });

      fireEvent.click(action(deleteName(commenter)));
      const dialog = await openConfirmation();

      fireEvent.click(within(dialog).getByRole('button', { name: CLOSE_AFFORDANCE_LABEL }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(captured).toStrictEqual([]);
    });

    it('sends DELETE /api/v1/comments/{id} with the credential once the deletion is confirmed', async () => {
      renderCommentItem({ user: commenterAccount });

      fireEvent.click(action(deleteName(commenter)));
      const dialog = await openConfirmation();
      fireEvent.click(within(dialog).getByRole('button', { name: DELETE_CONFIRM_LABEL }));

      await waitFor(() => {
        expect(toastStub.success).toHaveBeenCalledWith(DELETE_SUCCESS_MESSAGE, {
          description: DELETE_CASCADE_NOTE,
        });
      });

      // Exactly one request, on the versioned path, carrying the bearer the client holds. The override
      // answers `204` with a NULL body, which is what the route really does - `deleteComment` resolves
      // to `void` because there is nothing to read back. `unlikePost` is the one DELETE in this API
      // that carries a body; this is not it, and modelling one here would invent a contract.
      expect(onlyRequest()).toStrictEqual({
        method: 'DELETE',
        pathname: commentPathname(leafComment.id),
        authorization: EXPECTED_AUTHORIZATION,
      });
      expect(toastStub.error).not.toHaveBeenCalled();
    });

    it('closes the confirmation once the deletion has actually landed', async () => {
      renderCommentItem({ user: commenterAccount });

      fireEvent.click(action(deleteName(commenter)));
      const dialog = await openConfirmation();
      fireEvent.click(within(dialog).getByRole('button', { name: DELETE_CONFIRM_LABEL }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    });

    it('invalidates the post thread so the server decides what the cascade removed', async () => {
      // THE POSITIVE HALF OF "INVALIDATED, NOT PRUNED". The probe holds a live query on this post's
      // thread; the component's `onSuccess` invalidates every cached query that describes that thread
      // and AWAITS the refetch before announcing anything. So a second `GET` in the log is proof that
      // the refresh is real, and the success toast arriving after it is proof of the ordering: the
      // reader is told the comment is gone only once the thread in front of them has caught up.
      renderCommentItem({ user: commenterAccount, withThreadProbe: true });

      await waitFor(() => {
        expect(capturedWithMethod('GET')).toHaveLength(1);
      });

      fireEvent.click(action(deleteName(commenter)));
      const dialog = await openConfirmation();
      fireEvent.click(within(dialog).getByRole('button', { name: DELETE_CONFIRM_LABEL }));

      await waitFor(() => {
        expect(toastStub.success).toHaveBeenCalledTimes(1);
      });

      expect(capturedWithMethod('DELETE')).toHaveLength(1);
      // Two reads of THIS post's thread and nothing else: the probe's own mount, then the refetch the
      // invalidation provoked. Asserting the pathnames rather than only the count is what proves the
      // invalidation was aimed at this discussion instead of sweeping the whole cache.
      expect(capturedWithMethod('GET').map((entry) => entry.pathname)).toStrictEqual([
        threadPathname(POST_ID),
        threadPathname(POST_ID),
      ]);
    });

    it('does not prune the surrounding replies itself when a reply is deleted', async () => {
      // The cascade belongs to the DATABASE: `comments.parent_id` is a self-referencing foreign key
      // with `ON DELETE CASCADE`, so removing a comment removes its whole subtree in one statement and
      // only the SERVER knows which descendants went with it. A client that walked `replies` to prune
      // children would be a second definition of a rule the schema already guarantees - and the copy
      // that forgets a relation added later.
      //
      // This harness gives the component its tree as a PROP and nothing else, so if the component had
      // spliced that array the surrounding nodes would be gone from the DOM. They are still here. The
      // refreshed thread - asserted in the case above - is the only evidence of what was removed.
      renderCommentItem({ comment: threadedComment, user: adminAccount });

      fireEvent.click(action(deleteName(replier)));
      const dialog = await openConfirmation();
      fireEvent.click(within(dialog).getByRole('button', { name: DELETE_CONFIRM_LABEL }));

      await waitFor(() => {
        expect(toastStub.success).toHaveBeenCalledTimes(1);
      });

      expect(onlyRequest()).toStrictEqual({
        method: 'DELETE',
        pathname: commentPathname(firstReply.id),
        authorization: EXPECTED_AUTHORIZATION,
      });

      // No local surgery on the tree, and no follow-up read invented to paper over one.
      expect(screen.getByText(BODY_ROOT)).toBeVisible();
      expect(screen.getByText(BODY_REPLY_TWO)).toBeVisible();
      expect(screen.getByText(BODY_GRANDCHILD)).toBeVisible();
      expect(capturedWithMethod('GET')).toStrictEqual([]);
    });

    it('reports a refused deletion, keeps the confirmation open and tries exactly once', async () => {
      server.use(forbiddenDeleteHandler(leafComment.id));
      // A signed-in reader who owns nothing would not be OFFERED the control, so the refusal is driven
      // through the administrator - a principal the client believes may act - which is precisely the
      // case that proves the client's belief is not the boundary.
      renderCommentItem({ user: adminAccount });

      fireEvent.click(action(deleteName(commenter)));
      const dialog = await openConfirmation();
      fireEvent.click(within(dialog).getByRole('button', { name: DELETE_CONFIRM_LABEL }));

      await waitFor(() => {
        expect(toastStub.error).toHaveBeenCalledWith(DELETE_FAILURE_MESSAGE, {
          description: FORBIDDEN_DETAIL,
        });
      });

      // ONE attempt. `@/providers/query-provider` sets `mutations: { retry: 0 }`, so a refusal is not
      // replayed into three identical refusals.
      expect(capturedWithMethod('DELETE')).toHaveLength(1);
      expect(toastStub.success).not.toHaveBeenCalled();

      // The dialog stays open: the reader asked for something that did not happen, and dismissing the
      // confirmation would leave that outcome to be inferred from a toast alone.
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      // The request settled, so the confirmation is dismissible again - and once it is dismissed the
      // comment is still there, in its own article rather than surviving only as the dialog's quote.
      // Nothing was removed on the strength of a request that was refused.
      fireEvent.click(within(dialog).getByRole('button', { name: CANCEL_LABEL }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });

      expect(within(rootArticle()).getByText(BODY_ROOT)).toBeVisible();
      expect(action(deleteName(commenter))).toBeVisible();
    });

    it('takes the thread out of the accessibility tree while the confirmation holds it', async () => {
      renderCommentItem({ user: commenterAccount });

      // Present before, because the comment is an `<article>` and nothing is hiding it.
      expect(screen.getAllByRole('article')).toHaveLength(1);

      fireEvent.click(action(deleteName(commenter)));
      const dialog = await openConfirmation();

      // Gone while the dialog is open. This IS the modality: Radix applies `aria-hidden="true"` to
      // every other child of `document.body` rather than emitting `aria-modal`, which is the
      // better-supported signal and the one `src/components/ui/dialog.tsx` records and forbids
      // "fixing". A screen-reader user cannot wander out of the confirmation into the thread behind it.
      expect(screen.queryAllByRole('article')).toHaveLength(0);
      expect(dialog).toHaveAccessibleName(DELETE_DIALOG_TITLE);

      // And restored on dismissal, so the modality is scoped to the dialog's lifetime.
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });

      expect(screen.getAllByRole('article')).toHaveLength(1);
      expect(captured).toStrictEqual([]);
    });
  });

  /* -----------------------------------------------------------------------------------------------
   * Moderation
   *
   * This component READS `status` and never writes it. `CommentPublic.status` is read-only from a
   * client's point of view - it is not settable through `CommentCreate` or `CommentUpdate` - and
   * `PATCH /api/v1/admin/comments/{id}/status` is the only route that moves it, reached from the admin
   * surface through `@/lib/api/admin`. So the assertions here are one presence and one absence.
   * -------------------------------------------------------------------------------------------- */
  describe('moderation status is read-only', () => {
    it('explains a comment awaiting approval in words', () => {
      renderCommentItem({ comment: makeComment({ status: 'PENDING' }), user: commenterAccount });

      // The badge's WORDS carry the meaning, never its tone: a state conveyed by colour alone would be
      // invisible to a screen reader and to anyone who cannot distinguish the hue.
      expect(screen.getByText(PENDING_LABEL)).toBeVisible();
    });

    it('explains a rejected comment in words', () => {
      renderCommentItem({ comment: makeComment({ status: 'REJECTED' }), user: adminAccount });

      expect(screen.getByText(REJECTED_LABEL)).toBeVisible();
    });

    it('says nothing about an approved comment, because the public thread holds only those', () => {
      renderCommentItem({ comment: makeComment({ status: 'APPROVED' }) });

      // A badge on every comment would be noise; it is rendered only for the states a reader could not
      // otherwise know about.
      expect(screen.queryByText(PENDING_LABEL)).toBeNull();
      expect(screen.queryByText(REJECTED_LABEL)).toBeNull();
    });

    it('offers no control that would change the moderation state, even to an ADMIN', async () => {
      renderCommentItem({ comment: makeComment({ status: 'PENDING' }), user: adminAccount });

      expect(screen.getByText(PENDING_LABEL)).toBeVisible();

      // No approve, no reject, no hold - in any control role. Moderation lives in the admin surface,
      // and a second way to reach it here would be a second policy to keep in step with the first.
      for (const pattern of [/approve/i, /reject/i, /moderat/i, /publish/i]) {
        expect(maybeAction(pattern)).toBeNull();
        expect(screen.queryByRole('link', { name: pattern })).toBeNull();
        expect(screen.queryByRole('checkbox', { name: pattern })).toBeNull();
        expect(screen.queryByRole('combobox', { name: pattern })).toBeNull();
      }

      // And nothing was sent. A `PATCH` from this component would be the request that writes `status`,
      // so an empty log is the assertion that it cannot.
      await waitFor(() => {
        expect(screen.getByText(BODY_ROOT)).toBeVisible();
      });
      expect(capturedWithMethod('PATCH')).toStrictEqual([]);
      expect(captured).toStrictEqual([]);
    });
  });
});
