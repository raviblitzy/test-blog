/* =================================================================================================
 * comment-form.test.tsx - the component spec for `@/components/blog/comment-form`.
 *
 * `CommentForm` is one field and three requests, and the whole security story of the comment surface
 * lives in what its request bodies DO NOT carry:
 *
 *   - `post_id` arrives in the route path of `POST /api/v1/posts/{id}/comments`, so a client cannot
 *     retarget a comment at a different post than the one whose authority the service checked.
 *   - `author_id` is the principal the bearer resolves to, so a client cannot attribute its text to
 *     somebody else.
 *   - `status` is read-only to this entire tier, so a commenter cannot approve their own comment past
 *     moderation - `PATCH /api/v1/admin/comments/{id}/status` is the only route that moves it.
 *
 * None of those three is visible anywhere in the user interface, so no rendering assertion could ever
 * catch a regression that started sending one. This file therefore CAPTURES THE REQUEST BODY at the
 * network boundary and asserts, by name, that each is absent - and asserts the complete member list
 * besides, so a fourth member appearing is a failure rather than an omission nobody wrote a case for.
 *
 * WHICH INTERCEPTION ROUTE THIS FILE TOOK, AND WHY (recorded because there were two)
 *
 * `frontend/vitest.setup.ts` deliberately owns NO `setupServer` instance and exports none: its header
 * assigns the server, its default handler list and its `listen`/`resetHandlers`/`close` hooks to
 * "whichever spec owns the server lifecycle", and `frontend/tests/msw/handlers.ts` says the same of
 * itself - it is "one flat array, spread into `setupServer` by whichever spec owns the server
 * lifecycle". So this spec owns exactly ONE instance, seeded with that shared array and layered with
 * this file's own capturing overrides, exactly as `post-editor.test.tsx` does for the authoring
 * surface. There is no second instance anywhere in this file.
 *
 * The alternative was to mock `@/lib/api/comments` and assert on the argument object. It is rejected:
 * `vitest.setup.ts` forbids mocking `fetch` or `src/lib/api/client.ts` because that client owns token
 * attachment, refresh-on-401 and error normalisation, and mocking the wrapper one layer above it
 * retires the same code just as effectively. Intercepting HTTP proves the members that actually left
 * the browser; intercepting a function call proves only what a function was handed.
 *
 * WHERE THIS FILE DIVERGES FROM AN EXPECTATION, IT FOLLOWS THE SOURCE
 *
 * A failed submission raises NO toast. The component renders the refusal in an adjacent
 * `Alert variant="destructive"` - which supplies `role="alert"` from the variant - and its header
 * states why a toast would be wrong there: the form is never dismissed by a failure, so a transient
 * second copy of the same sentence would announce it twice. The failure cases below therefore assert
 * the live region the component really renders AND assert that no toast channel fired, which is what
 * would catch a regression that added one.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO. Please do not add:
 *
 *   1. Any assertion on a class name. No `toHaveClass`, no `className` read, no class-based
 *      `querySelector`, no `getComputedStyle`, no snapshot. Every value in the component resolves to
 *      a semantic token in `src/app/globals.css` and is free to change; validation state is asserted
 *      through `aria-invalid` and the message text, never through a colour.
 *   2. Any assertion that the form sanitises HTML. It must not: `bleach` sanitises on write in
 *      `backend/app/services/comment_service.py` and `rehype-sanitize` sanitises at render. One case
 *      below proves markup travels VERBATIM, because silently mangling what a reader typed would
 *      secure nothing and lose their words.
 *   3. A second `setupServer`, a `fetch` patch, or a mock of `@/lib/api/client` or
 *      `@/lib/api/comments`. See above.
 *   4. A hardcoded body length or validation message. The ceiling is discovered from
 *      `commentCreateSchema` itself and every refusal message is read out of the schema, so a bound
 *      changing in `@/lib/validation/comment` cannot leave this file asserting a stale number.
 *   5. `@testing-library/user-event`. It is not a declared dependency; typing is `fireEvent.change`
 *      followed by `fireEvent.blur`, which is also what makes the form's `mode: 'onBlur'` validation
 *      genuinely exercised rather than accidentally deferred to submit.
 *   6. A jest-dom import or a manual `cleanup()`. `vitest.setup.ts` registers the matchers and
 *      unmounts between tests.
 *   7. A real `AuthProvider`. It restores a session over HTTP and touches cookies, neither of which
 *      this component does; `useAuth` throws outside a provider, so `AuthContext.Provider` is given a
 *      fully typed stub instead. Nothing here builds, decodes or verifies a token.
 *   8. A 5xx failure. `@/providers/query-provider` sets `mutations: { retry: 0 }` and refuses to retry
 *      a 4xx query, so every failure below is a 4xx: deterministic, single-attempt, and
 *      representative of the refusals a reader actually meets.
 *   9. A `<Toaster />`. One is mounted for the whole application in `src/app/layout.tsx`; here `toast`
 *      is a spy.
 *  10. A responsive assertion. jsdom applies no media query, so the stacked-versus-row action bar is
 *      verified at three viewports in `frontend/tests/e2e/comments-likes.spec.ts` instead.
 *  11. `.only` or `.skip`.
 * ============================================================================================== */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HttpResponse, delay, http } from 'msw';
import type { RequestHandler } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactElement } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommentForm } from '@/components/blog/comment-form';
import { clearCredentials, setCredentials } from '@/lib/api/client';
import type {
  CommentPublic,
  ProblemDetail,
  UserMe,
  UserPublic,
  ValidationErrorItem,
} from '@/lib/types';
import { commentCreateSchema, commentUpdateSchema } from '@/lib/validation/comment';
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
   * Every `toast` channel, not only the one the component calls.
   *
   * `success` is the single channel the source uses, and it uses it on the success path alone. The
   * other three are spied precisely so that "no toast was raised" is an assertable fact about a
   * failure rather than an untested assumption - a regression that announced a refusal twice would
   * fail here instead of only being noticed by a reader hearing it twice.
   */
  toastStub: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: toastStub }));

/** The route a reader is on while the form is mounted. Feeds the signed-out prompt's return trip. */
const POST_PATHNAME = '/blog/scaling-fastapi-to-a-million-requests';

/**
 * The single App Router hook this component reads.
 *
 * `usePathname` is what the signed-out prompt turns into a `next` parameter, and it resolves from a
 * context no test render provides. `next/link` is deliberately NOT mocked: measured in this
 * configuration it renders a plain anchor under jsdom with no router context present, and mocking it
 * would replace the one thing worth asserting about the prompt - the `href` the component builds.
 */
vi.mock('next/navigation', () => ({ usePathname: (): string => POST_PATHNAME }));

/* -------------------------------------------------------------------------------------------------
 * Contract vocabulary
 * ---------------------------------------------------------------------------------------------- */

/** Where a signed-out visitor is sent. Matches `LOGIN_PATH` in `src/middleware.ts`. */
const LOGIN_PATH = '/login';

/** The parameter carrying the route to come back to. Matches `RETURN_TO_PARAM` in the middleware. */
const RETURN_TO_PARAM = 'next';

/** The header the client attaches a held credential through. */
const AUTHORIZATION_HEADER = 'Authorization';

/** Scheme prefix of that header's value, including its separating space. */
const BEARER_SCHEME = 'Bearer ';

/** The media type every failure path of this API answers with. */
const PROBLEM_JSON_MEDIA_TYPE = 'application/problem+json';

/** The challenge a 401 carries, and the one thing that distinguishes it from a 403 on the wire. */
const WWW_AUTHENTICATE_BEARER = 'Bearer';

/**
 * The only two members a comment request body may ever carry.
 *
 * `commentCreateSchema` is a `z.strictObject` over exactly these two and `commentUpdateSchema` over
 * the first alone, so this is the whole form contract rather than a sample of it. Cases assert the
 * captured body's key list against the applicable subset, which is what turns "a new member appeared"
 * into a failure rather than something no case happened to look at.
 */
const MEMBER_BODY = 'body';
const MEMBER_PARENT_ID = 'parent_id';

/**
 * The post identifier. Named so the absence assertions can cite it.
 *
 * It travels in the PATH and never in the body. A second copy in the body would be a second,
 * contradictable answer to "which post is this about" - and the one the service's authority check did
 * not consult.
 */
const MEMBER_POST_ID = 'post_id';

/** Authorship. The resolved principal, never a client claim - this is the impersonation guard. */
const MEMBER_AUTHOR_ID = 'author_id';

/** Moderation state. Read-only to this tier - this is the self-approval guard. */
const MEMBER_STATUS = 'status';

/**
 * Every member the service owns, which no request body from this form may carry.
 *
 * The three headline entries come first and each has its own named constant above, because each is
 * refused for its own distinct reason and a reader of a failing assertion should be told which
 * guarantee broke. The rest are the remaining members of the `CommentPublic` projection: a form that
 * echoed any of them back would be claiming authority over a value the database or the service
 * produced.
 *
 * Checked by {@link expectNoServerOwnedMembers} on EVERY captured body rather than per case, so the
 * guarantee is uniform across the create, reply and edit routes instead of being restated three times
 * and forgotten in one of them.
 */
const SERVER_OWNED_MEMBERS: readonly string[] = [
  MEMBER_POST_ID,
  MEMBER_AUTHOR_ID,
  MEMBER_STATUS,
  'id',
  'author',
  'created_at',
  'updated_at',
  'reply_count',
  'has_more_replies',
  'replies',
];

/* -------------------------------------------------------------------------------------------------
 * Copy
 *
 * The component declares each of these as a module constant and exports none of them, so a spec has
 * to restate the string it asserts on. Collected here rather than inline for the same reason the
 * component collects them: the accessible names of its controls are its contract with a screen
 * reader, and a change to one should be a one-line edit in each file rather than a hunt.
 * ---------------------------------------------------------------------------------------------- */

/** The visible label, and therefore the field's accessible name, in each of the three modes. */
const LABEL_ROOT = 'Add a comment';
const LABEL_REPLY = 'Write a reply';
const LABEL_EDIT = 'Edit your comment';

/** The submit control's accessible name at rest, per mode. */
const SUBMIT_ROOT = 'Post comment';
const SUBMIT_REPLY = 'Post reply';
const SUBMIT_EDIT = 'Save changes';

/** The submit control's accessible name while a request is in flight, per mode. */
const PENDING_CREATE = 'Posting…';
const PENDING_EDIT = 'Saving…';

/** The secondary action, which appears only when the caller supplies a handler for it. */
const CANCEL = 'Cancel';

/** Placeholder of the root form's field. Never its accessible name - a placeholder disappears. */
const PLACEHOLDER_ROOT = 'Share what you made of this post';

/** The guidance rendered under the field, which differs for an edit by the comment's own state. */
const HELPER_CREATE =
  'Comments are read by a moderator before they appear publicly, so yours will not show up straight away.';
const HELPER_EDIT_APPROVED =
  'Saving an edit sends the comment back for approval, so it will be hidden again until a moderator approves the new text.';

/** The confirmation toasts, which are chosen by the moderation state the server answered with. */
const TOAST_HELD_CREATE = 'Your comment was received and is waiting for approval.';
const TOAST_APPROVED_CREATE = 'Your comment has been posted.';
const TOAST_HELD_EDIT = 'Your comment was updated and is waiting for approval again.';

/** The durable notice shown beside the form when a submission was accepted but is not yet public. */
const HELD_TITLE = 'Waiting for approval';

/** The durable notice shown beside the form when a submission was refused. */
const FAILURE_TITLE = 'That did not go through';

/** Appended to a refusal that was pinned to the field, so the reader knows where to look. */
const FAILURE_FIELD_HINT = 'The message under the box explains what to change.';

/** The component's own wording for a 401, which it prefers over the API's less reassuring one. */
const SESSION_EXPIRED_MESSAGE =
  'Your sign-in has expired, so nothing was saved. Sign in again and submit once more - your text has been kept.';

/** The signed-out panel: its heading, its explanation, and the link's name in each mode. */
const ANONYMOUS_TITLE = 'Sign in to join the discussion';
const ANONYMOUS_DETAIL =
  'Commenting needs an account. Signing in brings you straight back to this page.';
const SIGN_IN_ROOT = 'Sign in to comment';
const SIGN_IN_REPLY = 'Sign in to reply';

/** What a screen reader hears while the session is still resolving, so the wait is not silent. */
const SESSION_LOADING_MESSAGE = 'Checking whether you are signed in…';

/* -------------------------------------------------------------------------------------------------
 * Bounds and messages, asked of the schema rather than restated
 *
 * `@/lib/validation/comment` deliberately exports neither its bounds nor its messages: its surface is
 * the two schemas and their two inferred types, and it says a re-exported bound "would invite a
 * component to render a character counter against a copy that can drift". A spec is under exactly the
 * same obligation - a hardcoded 5000 here would keep passing after the service raised its own limit,
 * while asserting a stale refusal - so both are DISCOVERED from the schema at collection time.
 * ---------------------------------------------------------------------------------------------- */

/** The shape a `safeParse` result needs for the two helpers below, without naming the validator. */
interface ParseOutcome {
  readonly success: boolean;
  readonly error?: { readonly issues: readonly { readonly message: string }[] };
}

/** Where the exponential probe starts. Comfortably inside any plausible ceiling. */
const CEILING_PROBE_START = 1024;

/** Where it gives up, so a schema that accepted everything fails loudly instead of looping. */
const CEILING_PROBE_LIMIT = 1_048_576;

/** A body of a given length, in a single-code-unit character so length and code points agree. */
function bodyOfLength(length: number): string {
  return 'x'.repeat(length);
}

/** Whether the create schema accepts a body of exactly this length. */
function acceptsLength(length: number): boolean {
  return commentCreateSchema.safeParse({ [MEMBER_BODY]: bodyOfLength(length) }).success;
}

/**
 * The longest body `commentCreateSchema` accepts, found by asking it.
 *
 * Doubles until a length is refused, then bisects the gap, so the answer is the exact boundary rather
 * than "somewhere past a number this file chose". Roughly two dozen parses, all synchronous, all at
 * collection time.
 *
 * The bisection invariant is that `accepted` always parses and `rejected` always does not, so the
 * loop closes on adjacent values and returns the last accepted one. `acceptsLength(1)` is the seed
 * for `accepted` and is guaranteed by the schema's own floor of one character.
 */
function discoverBodyCeiling(): number {
  let accepted = 1;
  let rejected = CEILING_PROBE_START;
  while (acceptsLength(rejected)) {
    accepted = rejected;
    rejected *= 2;
    if (rejected > CEILING_PROBE_LIMIT) {
      throw new Error(
        'commentCreateSchema accepted a body larger than this probe is willing to build, so its ' +
          'ceiling could not be discovered. Raise CEILING_PROBE_LIMIT only if the service really ' +
          'did raise its own limit.',
      );
    }
  }
  while (rejected - accepted > 1) {
    const midpoint = Math.floor((accepted + rejected) / 2);
    if (acceptsLength(midpoint)) {
      accepted = midpoint;
    } else {
      rejected = midpoint;
    }
  }
  return accepted;
}

/** The longest accepted body, and the shortest refused one. Both derived, neither written down. */
const BODY_CEILING = discoverBodyCeiling();
const BODY_OVER_CEILING = BODY_CEILING + 1;

/**
 * The message the schema itself produces for a value it refuses.
 *
 * Reading the wording out of the schema is what lets a case assert that the reader sees the SAME
 * sentence the validator produced, without this file holding a second copy of it that could drift.
 * Throws rather than returning a placeholder when the value was accepted, because a silent empty
 * string would turn a broken premise into an assertion that vacuously passes.
 */
function refusalMessage(outcome: ParseOutcome): string {
  const [issue] = outcome.error?.issues ?? [];
  if (outcome.success || issue === undefined) {
    throw new Error(
      'A value this suite requires the comment schema to refuse was accepted, so no message could ' +
        'be read from it. The schema and this spec now disagree about what is valid.',
    );
  }
  return issue.message;
}

/** What a reader is told when a comment box is submitted empty, or with only whitespace. */
const MESSAGE_CREATE_EMPTY = refusalMessage(
  commentCreateSchema.safeParse({ [MEMBER_BODY]: '   ' }),
);

/** What a reader is told when an existing comment's text is cleared. Worded for that case. */
const MESSAGE_UPDATE_EMPTY = refusalMessage(commentUpdateSchema.safeParse({ [MEMBER_BODY]: '' }));

/** What a reader is told when the body is past the ceiling, naming the limit so they can cut. */
const MESSAGE_TOO_LONG = refusalMessage(
  commentCreateSchema.safeParse({ [MEMBER_BODY]: bodyOfLength(BODY_OVER_CEILING) }),
);

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 *
 * Every identifier is a UUID-shaped STRING. Identity in this system is generated by the database -
 * `gen_random_uuid()` on every relation - so an integer here would misrepresent the wire and quietly
 * reintroduce the client-supplied identity the legacy surface had.
 * ---------------------------------------------------------------------------------------------- */

/** The post the thread belongs to. Travels in the PATH of every create, and in no body. */
const POST_ID = '3f5c1d2e-9b4a-4c8d-a1e6-7f2b8c9d0a11';

/** The comment a reply answers. Its presence in a body is the entire threading mechanism. */
const PARENT_ID = '5a7e2c4b-1d6f-4b3a-9c8e-2f1d7a6b5c40';

/** The identifier the create route answers with - the server's, never one this form supplied. */
const CREATED_COMMENT_ID = 'b1c2d3e4-5f6a-4b7c-8d9e-0f1a2b3c4d5e';

/** Instants are fixed strings so every assertion is an equality rather than a range. */
const INSTANT_CREATED = '2024-05-11T08:30:00Z';
const INSTANT_UPDATED = '2024-05-12T09:45:00Z';

/** The reader as other people see them: the public projection embedded in every comment. */
const reader: UserPublic = {
  id: 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  username: 'ada',
  display_name: 'Ada Lovelace',
  bio: 'Writes about compilers.',
  avatar_url: null,
  created_at: '2024-01-04T10:15:00Z',
};

/**
 * The same person as their own account: the shape `useAuth().user` carries.
 *
 * Spread from {@link reader} so the two can never disagree about who this is, then extended with the
 * four members `UserMe` adds. `READER` is the right role for this surface: commenting needs an
 * account and nothing more, and using an elevated role here would hide a privilege check that does
 * not exist.
 */
const account: UserMe = {
  ...reader,
  email: 'ada@example.test',
  role: 'READER',
  is_active: true,
  updated_at: '2024-02-02T11:20:00Z',
};

/**
 * The comment the editor edits: complete, snake_case, no cast anywhere.
 *
 * `APPROVED` deliberately, because that is the state whose edit has a consequence worth telling the
 * reader about - saving withdraws the comment from the thread until a moderator approves the new
 * text - and it is the guidance one case below asserts on.
 */
const existingComment: CommentPublic = {
  id: '7c9e4a1b-3f5d-4e2a-8b7c-1d6f9a2b3c50',
  post_id: POST_ID,
  parent_id: null,
  author: reader,
  body: 'The cascade is recursive, not one level deep.',
  status: 'APPROVED',
  created_at: INSTANT_CREATED,
  updated_at: INSTANT_UPDATED,
  reply_count: 2,
  has_more_replies: false,
  replies: [],
};

/**
 * The comment the create route answers with.
 *
 * `PENDING`, because that is the product's moderation default and answering `APPROVED` would teach
 * every case here that a submission appears immediately - the opposite of what the reader will see.
 * Its `id`, `post_id` and both instants are the SERVER's; none of them was submitted, and the form
 * adopting them is what proves the round trip.
 */
function createdComment(body: string, parentId: string | null): CommentPublic {
  return {
    id: CREATED_COMMENT_ID,
    post_id: POST_ID,
    parent_id: parentId,
    author: reader,
    body,
    status: 'PENDING',
    created_at: INSTANT_CREATED,
    updated_at: INSTANT_CREATED,
    reply_count: 0,
    has_more_replies: false,
    replies: [],
  };
}

/**
 * The comment the edit route answers with.
 *
 * `PENDING` again, and for a reason specific to editing: the service returns an approved comment to
 * the queue whenever its body changes, because approval attaches to the text a moderator read rather
 * than to the row that held it.
 */
function updatedComment(body: string): CommentPublic {
  return { ...existingComment, body, status: 'PENDING', updated_at: INSTANT_UPDATED };
}

/**
 * A fully typed {@link AuthContextValue}, with the four actions as spies.
 *
 * `AuthContext.Provider` is fed this directly rather than mounting `AuthProvider`, which would
 * restore a session over HTTP and write a cookie - neither of which this component does. `useAuth`
 * throws outside a provider, so the stub is not optional.
 *
 * @param user - The principal, or `null` for a signed-out visitor.
 * @param isLoading - `true` for the first paint, while the session is still being resolved.
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

/**
 * One uniform problem document - the only error shape this API emits.
 *
 * It replaces the ad-hoc `{"detail": "..."}` raise the legacy service repeated at three separate call
 * sites. `request_id` is always populated because the client synthesises a replacement document for
 * any problem body that omits it, which would mask the very `detail` a failure case asserts on.
 *
 * `errors` is typed as the non-empty tuple `ProblemDetail` declares, so the compiler - not a failing
 * assertion - insists each item carries all three of `field`, `message` and `type`. The client drops
 * an item missing any one of them, so an under-specified fixture would silently stop reaching the
 * form.
 */
function problem(
  status: number,
  title: string,
  detail: string,
  errors?: readonly [ValidationErrorItem, ...ValidationErrorItem[]],
): ProblemDetail {
  const document: ProblemDetail = {
    type: `/errors/${String(status)}`,
    title,
    status,
    detail,
    instance: `/api/v1/posts/${POST_ID}/comments`,
    request_id: 'req-00000000-0000-4000-8000-0000000000ff',
  };
  return errors === undefined ? document : { ...document, errors: [...errors] };
}

/**
 * Answer with a problem document, in the media type the service really sends.
 *
 * Built through the low-level constructor rather than `HttpResponse.json`, which would stamp
 * `application/json` over `application/problem+json`. Typed as the platform `Response` because the
 * body is a serialised string: `HttpResponse<T>`'s parameter describes the PARSED body, so it would
 * have to claim `string` and would then be describing the wrong thing.
 */
function problemResponse(
  document: ProblemDetail,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new HttpResponse(JSON.stringify(document), {
    status: document.status,
    headers: {
      'Content-Type': PROBLEM_JSON_MEDIA_TYPE,
      'X-Request-ID': document.request_id,
      ...headers,
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

/** One intercepted request, reduced to the four things a contract assertion needs. */
interface CapturedRequest {
  readonly method: string;
  readonly pathname: string;
  /** The parsed JSON body, or `null` for a request that carried none. */
  readonly body: Readonly<Record<string, unknown>> | null;
  /**
   * The verbatim `Authorization` header, or `null` when the request carried none.
   *
   * Captured rather than merely gated on, so "the credential travelled" is something a case can state
   * about the wire, and so the one case that deliberately writes without a credential can prove the
   * header's ABSENCE rather than infer it from a refusal. The value is an obvious placeholder string
   * from the shared fixtures; nothing here builds, decodes or verifies a token.
   */
  readonly authorization: string | null;
}

let captured: CapturedRequest[] = [];

/** Narrow parsed JSON to a keyed object without asserting past the compiler. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a request body without assuming there is one.
 *
 * `request.json()` throws on an empty payload, so the text is read first and an empty string becomes
 * `null`. That distinction is part of what is being tested: a body that never existed cannot be hiding
 * a member in it.
 */
async function readBody(request: Request): Promise<Readonly<Record<string, unknown>> | null> {
  const text = await request.text();
  if (text.length === 0) {
    return null;
  }
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : null;
}

/** Record one request, before deciding how to answer it. */
async function record(request: Request): Promise<void> {
  captured.push({
    method: request.method,
    pathname: new URL(request.url).pathname,
    body: await readBody(request),
    authorization: request.headers.get(AUTHORIZATION_HEADER),
  });
}

/**
 * The credential these overrides expect, built from the pair `beforeEach` actually installs.
 *
 * Derived from {@link fixtureTokenPair} rather than restated, so the expectation cannot drift from the
 * value the client holds: a changed fixture moves both ends together or neither.
 */
const EXPECTED_AUTHORIZATION = `${BEARER_SCHEME}${fixtureTokenPair.access_token}`;

/** How long the deliberately slow handler holds a request open, in milliseconds. */
const IN_FLIGHT_DELAY_MS = 50;

/**
 * The capturing overrides for the two routes this form can reach.
 *
 * Registered for EVERY test, so a case asserting "no request was issued" is checking an empty capture
 * log rather than the absence of a handler, and a case asserting on a body never depends on which
 * fixture the shared array happens to hold. Each resolver records first and answers second, so an
 * attempt is visible even when the answer is a refusal.
 *
 * The create resolver echoes the submitted body back through {@link createdComment}, which is what
 * lets the round-trip cases assert that the server's own comment - its identifier, its `PENDING`
 * status, its instants - is what reaches `onSuccess` and the field.
 */
function captureHandlers(): RequestHandler[] {
  return [
    http.post('*/api/v1/posts/:postId/comments', async ({ request }) => {
      await record(request);
      const submitted = captured[captured.length - 1]?.body ?? {};
      const body = submitted[MEMBER_BODY];
      const parentId = submitted[MEMBER_PARENT_ID];
      return HttpResponse.json(
        createdComment(
          typeof body === 'string' ? body : '',
          typeof parentId === 'string' ? parentId : null,
        ),
        { status: 201 },
      );
    }),
    http.patch('*/api/v1/comments/:commentId', async ({ request }) => {
      await record(request);
      const submitted = captured[captured.length - 1]?.body ?? {};
      const body = submitted[MEMBER_BODY];
      return HttpResponse.json(
        updatedComment(typeof body === 'string' ? body : existingComment.body),
        { status: 200 },
      );
    }),
  ];
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

interface RenderOptions {
  /** The signed-in principal. Pass `null` for a visitor with no session. */
  readonly user?: UserMe | null;
  /** `true` to render the first paint, while the session is still resolving. */
  readonly isLoading?: boolean;
  /** Supplying this is what makes the form a reply box. */
  readonly parentId?: string | null;
  /** Supplying this is what switches the form into edit mode. */
  readonly comment?: CommentPublic;
  /** Supplying this is what makes a Cancel control appear. */
  readonly onCancel?: () => void;
  /** Called with the comment the server returned. */
  readonly onSuccess?: (comment: CommentPublic) => void;
  /** Take keyboard focus to the field once it is on screen. */
  readonly autoFocus?: boolean;
}

/**
 * Mount the form inside the two providers a post page would give it.
 *
 * The REAL {@link QueryProvider} rather than a bespoke client, so the tier's own `defaultOptions`
 * apply - notably `mutations: { retry: 0 }`, which is what makes every failure case below a single
 * deterministic attempt, and a retry predicate that refuses 4xx, which is why no case here uses a 5xx.
 *
 * The props are passed through individually rather than spread, so each optional member is either
 * given or genuinely absent: passing `parentId={undefined}` and omitting it are the same to the
 * component, but passing `comment={undefined}` explicitly is how a mode bug hides.
 */
function renderCommentForm(options: RenderOptions = {}): void {
  const user = options.user === undefined ? account : options.user;
  const value = session(user, options.isLoading ?? false);

  const tree: ReactElement = (
    <CommentForm
      autoFocus={options.autoFocus ?? false}
      comment={options.comment}
      onCancel={options.onCancel}
      onSuccess={options.onSuccess}
      parentId={options.parentId}
      postId={POST_ID}
    />
  );

  render(
    <QueryProvider>
      <AuthContext.Provider value={value}>{tree}</AuthContext.Provider>
    </QueryProvider>,
  );
}

/* -------------------------------------------------------------------------------------------------
 * Query helpers
 *
 * Every one resolves an element by its ROLE or its LABEL. Nothing here reads a class name, an
 * attribute selector over styling, or the DOM structure around a control.
 * ---------------------------------------------------------------------------------------------- */

/** The single registered field, by its visible label - which is also its accessible name. */
const field = (label: string): HTMLTextAreaElement => {
  const element = screen.getByLabelText(label);
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error(
      `The control labelled "${label}" is not a <textarea>. The comment body is authored through ` +
        '@/components/ui/textarea, so a different element means the primitive changed.',
    );
  }
  return element;
};

/** A control by its accessible name. */
const action = (name: string): HTMLElement => screen.getByRole('button', { name });

/** The assertive live region the destructive `Alert` variant supplies. */
const failureNotice = (): HTMLElement => screen.getByRole('alert');

/** The polite live region the warning and success `Alert` variants supply. */
const statusNotice = (): HTMLElement => screen.getByRole('status');

/**
 * Type into the field the way a keystroke does, then leave it so `onBlur` validation runs.
 *
 * Both events, and the second is not decoration. The form is built with `mode: 'onBlur'`, so leaving
 * the field is what runs the resolver against it and what puts a message beside the control before
 * anything is submitted. Firing only `change` would mean every validation case here was really
 * testing submit-time validation, and switching the form to `mode: 'onSubmit'` would silently
 * withdraw every inline message a reader relies on while writing.
 */
function type(label: string, value: string): void {
  const control = field(label);
  fireEvent.change(control, { target: { value } });
  fireEvent.blur(control);
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

/** The body of that request, refusing to pass vacuously when the request carried none. */
function onlyRequestBody(): Readonly<Record<string, unknown>> {
  const { body } = onlyRequest();
  if (body === null) {
    throw new Error(
      'The captured request carried no JSON body, so no member assertion can be made about it.',
    );
  }
  return body;
}

/**
 * Assert a body carries none of the members the service owns.
 *
 * The three headline members are named individually first, so a failure reports WHICH guarantee broke
 * rather than only that one did, and the remaining projection members are checked in a loop.
 */
function expectNoServerOwnedMembers(body: Readonly<Record<string, unknown>>): void {
  expect(body).not.toHaveProperty(MEMBER_POST_ID);
  expect(body).not.toHaveProperty(MEMBER_AUTHOR_ID);
  expect(body).not.toHaveProperty(MEMBER_STATUS);
  for (const member of SERVER_OWNED_MEMBERS) {
    expect(body).not.toHaveProperty(member);
  }
}

/** Assert every request a case provoked is free of those members, whatever it was. */
function expectNoServerOwnedMembersAnywhere(): void {
  for (const entry of captured) {
    if (entry.body !== null) {
      expectNoServerOwnedMembers(entry.body);
    }
  }
}

/**
 * Assert the exact member list of a body, sorted.
 *
 * Stronger than a set of absence checks on its own: it fails on a member nobody thought to prohibit,
 * which is the failure mode a fixed prohibition list cannot cover.
 */
function expectExactMembers(
  body: Readonly<Record<string, unknown>>,
  members: readonly string[],
): void {
  expect(Object.keys(body).sort()).toEqual([...members].sort());
}

/** Assert the credential the client holds travelled with every request the case provoked. */
function expectBearerOnEveryRequest(): void {
  expect(captured.length).toBeGreaterThan(0);
  for (const entry of captured) {
    expect(entry.authorization).toBe(EXPECTED_AUTHORIZATION);
  }
}

/** Assert nothing left the browser at all. */
function expectNoRequests(): void {
  expect(captured).toHaveLength(0);
}

/** Assert no toast channel was used - the failure paths announce through a live region instead. */
function expectNoToast(): void {
  expect(toastStub.success).not.toHaveBeenCalled();
  expect(toastStub.error).not.toHaveBeenCalled();
  expect(toastStub.info).not.toHaveBeenCalled();
  expect(toastStub.warning).not.toHaveBeenCalled();
}

/**
 * A pattern matching an accessible description that CONTAINS the given sentence.
 *
 * Containment rather than equality, because the field's description is the always-present guidance
 * followed by the refusal - a reader hears both - so an exact match would be asserting that the
 * guidance had disappeared. Every regular-expression metacharacter is escaped, so the argument stays
 * ordinary prose at the call site and a message containing a full stop or brackets cannot silently
 * widen the pattern.
 */
function describing(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/**
 * Assert the field is reporting a refusal, in both of the ways that do not depend on colour.
 *
 * `aria-invalid` is computed by `@/components/ui/textarea` from its own `invalid` prop, and the
 * message is reached through `aria-describedby` - which is what `toHaveAccessibleDescription`
 * resolves. Asserting the computed description rather than merely that the text exists somewhere is
 * the difference between "a message is on the page" and "a screen reader on this control will read
 * it".
 */
async function expectFieldRefused(label: string, message: string): Promise<void> {
  await waitFor(() => {
    expect(field(label)).toHaveAttribute('aria-invalid', 'true');
  });
  expect(field(label)).toHaveAccessibleDescription(describing(message));
}

/* =================================================================================================
 * Cases
 * ============================================================================================== */

describe('CommentForm', () => {
  describe('create mode', () => {
    it('renders one labelled field and a submit action, and no cancel the caller did not ask for', () => {
      renderCommentForm();

      // Both queries, deliberately: the first proves a real `<label for>` association exists, the
      // second proves that association is what a screen reader computes as the control's name.
      expect(field(LABEL_ROOT)).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: LABEL_ROOT })).toBeInTheDocument();
      expect(field(LABEL_ROOT)).toHaveAttribute('placeholder', PLACEHOLDER_ROOT);

      expect(action(SUBMIT_ROOT)).toBeEnabled();
      // Cancel is gated on the HANDLER, not on the mode: a root form that is always on screen has
      // nothing to cancel back to, so offering the control would be offering a dead end.
      expect(screen.queryByRole('button', { name: CANCEL })).not.toBeInTheDocument();
    });

    it('describes the field with the moderation guidance a reader needs before writing', () => {
      renderCommentForm();

      // Always true for a create: the service defaults a new comment to PENDING, so telling the
      // reader afterwards would be telling them too late.
      expect(field(LABEL_ROOT)).toHaveAccessibleDescription(describing(HELPER_CREATE));
      expect(field(LABEL_ROOT)).not.toHaveAttribute('aria-invalid');
    });

    it('lands keyboard focus in the field when the caller asks for it', async () => {
      renderCommentForm({ autoFocus: true });

      // `setFocus` defers through a timeout of its own, so the focus lands on the tick after the
      // effect. Awaited rather than asserted synchronously for exactly that reason.
      await waitFor(() => {
        expect(field(LABEL_ROOT)).toHaveFocus();
      });
    });

    it('leaves focus alone when the caller does not', () => {
      renderCommentForm();

      expect(field(LABEL_ROOT)).not.toHaveFocus();
    });

    it('submits POST /api/v1/posts/{id}/comments carrying the body and nothing the server owns', async () => {
      const written = 'The trigram fallback is the part I had not seen before.';
      renderCommentForm();

      type(LABEL_ROOT, written);
      fireEvent.click(action(SUBMIT_ROOT));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });
      const request = onlyRequest();
      expect(request.method).toBe('POST');
      // The post identifier is in the PATH. This is the assertion that says so.
      expect(request.pathname).toBe(`/api/v1/posts/${POST_ID}/comments`);

      const body = onlyRequestBody();
      expect(body[MEMBER_BODY]).toBe(written);
      // The whole contract: one member, and none of the ten the service owns. `parent_id` is absent
      // rather than null, because root mode omits the member entirely.
      expectExactMembers(body, [MEMBER_BODY]);
      expect(body).not.toHaveProperty(MEMBER_PARENT_ID);
      expectNoServerOwnedMembers(body);
      expectBearerOnEveryRequest();
    });

    it('hands the comment the server returned to onSuccess', async () => {
      const written = 'Agreed, though the second half surprised me.';
      const onSuccess = vi.fn<(comment: CommentPublic) => void>();
      renderCommentForm({ onSuccess });

      type(LABEL_ROOT, written);
      fireEvent.click(action(SUBMIT_ROOT));

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
      // The SERVER's comment, in full: its generated identifier, the post it resolved from the path,
      // and the PENDING status that decides whether a thread should show it at all. This callback is
      // how the discussion learns about the new node, so the whole projection has to arrive.
      expect(onSuccess).toHaveBeenCalledWith(createdComment(written, null));
      expectNoServerOwnedMembersAnywhere();
    });

    it('clears the field, confirms in a toast, and says the comment is awaiting approval', async () => {
      renderCommentForm();

      type(LABEL_ROOT, 'Looking forward to the follow-up.');
      fireEvent.click(action(SUBMIT_ROOT));

      await waitFor(() => {
        expect(toastStub.success).toHaveBeenCalledTimes(1);
      });
      // The held wording, not the approved wording. A comment that was accepted is invisible in the
      // thread until a moderator passes it, so "posted!" would be a lie the reader could check.
      expect(toastStub.success).toHaveBeenCalledWith(TOAST_HELD_CREATE);
      expect(toastStub.success).not.toHaveBeenCalledWith(TOAST_APPROVED_CREATE);

      // A durable notice as well as the transient toast, because there is no evidence of the comment
      // anywhere in the thread and a reader left without this sentence would think it had vanished.
      // `warning` supplies `role="status"`, which announces politely rather than interrupting.
      expect(statusNotice()).toHaveTextContent(HELD_TITLE);

      // Empty and ready for the next comment - the only place the form is ever reset.
      await waitFor(() => {
        expect(field(LABEL_ROOT)).toHaveValue('');
      });
    });

    it('submits markup verbatim, leaving sanitisation to the server and the renderer', async () => {
      // Reader-authored text is cleaned in exactly two places, and neither is this form: `bleach`
      // sanitises on write in `backend/app/services/comment_service.py`, and `rehype-sanitize`
      // sanitises at render. A form that quietly stripped markup would change what somebody wrote and
      // secure nothing, since the API is callable without it.
      const written = 'Try <b>bold</b> and <script>alert(1)</script> to see what the server keeps.';
      renderCommentForm();

      type(LABEL_ROOT, written);
      fireEvent.click(action(SUBMIT_ROOT));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });
      expect(onlyRequestBody()[MEMBER_BODY]).toBe(written);
    });

    it('disables both the field and the action while the request is in flight, so one click is one comment', async () => {
      server.use(
        http.post('*/api/v1/posts/:postId/comments', async ({ request }) => {
          await record(request);
          await delay(IN_FLIGHT_DELAY_MS);
          return HttpResponse.json(createdComment('Held open on purpose.', null), { status: 201 });
        }),
      );
      renderCommentForm();

      type(LABEL_ROOT, 'Held open on purpose.');
      fireEvent.click(action(SUBMIT_ROOT));

      // The pending state is carried by the LABEL as well as by the disabled attribute, so it is
      // perceivable without seeing motion or colour.
      await waitFor(() => {
        expect(action(PENDING_CREATE)).toBeDisabled();
      });
      expect(field(LABEL_ROOT)).toBeDisabled();

      // A second and third press while the first is open. A disabled control cannot be activated, so
      // the count below is what proves a double submission cannot create two comments.
      fireEvent.click(action(PENDING_CREATE));
      fireEvent.click(action(PENDING_CREATE));

      await waitFor(() => {
        expect(toastStub.success).toHaveBeenCalledTimes(1);
      });
      expect(captured).toHaveLength(1);
      expect(action(SUBMIT_ROOT)).toBeEnabled();
    });

    it('offers a cancel action when the caller supplies a handler, and issues no request when it is used', () => {
      const onCancel = vi.fn<() => void>();
      renderCommentForm({ onCancel });

      const cancel = action(CANCEL);
      // `type="button"`, so pressing it cannot submit the form it sits in.
      expect(cancel).toHaveAttribute('type', 'button');
      fireEvent.click(cancel);

      expect(onCancel).toHaveBeenCalledTimes(1);
      expectNoRequests();
      expectNoToast();
    });
  });

  describe('reply mode', () => {
    it('labels the field and the action as a reply', () => {
      renderCommentForm({ parentId: PARENT_ID });

      expect(screen.getByRole('textbox', { name: LABEL_REPLY })).toBeInTheDocument();
      expect(action(SUBMIT_REPLY)).toBeEnabled();
      // Root wording must be gone, not merely joined - one form, one job.
      expect(screen.queryByRole('textbox', { name: LABEL_ROOT })).not.toBeInTheDocument();
    });

    it('sends parent_id, which is the entire threading mechanism, and still nothing the server owns', async () => {
      const written = 'Replying to exactly that point.';
      renderCommentForm({ parentId: PARENT_ID });

      type(LABEL_REPLY, written);
      fireEvent.click(action(SUBMIT_REPLY));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });
      const request = onlyRequest();
      // A reply is created on the POST's collection, exactly as a root comment is. There is no reply
      // endpoint: the body member below is the only difference between the two.
      expect(request.pathname).toBe(`/api/v1/posts/${POST_ID}/comments`);

      const body = onlyRequestBody();
      expect(body[MEMBER_PARENT_ID]).toBe(PARENT_ID);
      expect(body[MEMBER_BODY]).toBe(written);
      expectExactMembers(body, [MEMBER_BODY, MEMBER_PARENT_ID]);
      expectNoServerOwnedMembers(body);
      expectBearerOnEveryRequest();
    });

    it('treats an explicitly null parent as a top-level comment and omits the member', async () => {
      // Absent, `null` and omitted all mean "top-level", and the payload that leaves the browser says
      // so by carrying no member at all rather than a null one.
      //
      // This is a COMPOSITE guarantee and the case is deliberately written against the wire, which is
      // where it matters: `@/lib/api/comments` projects a null parent away as well, so the request is
      // clean whether the omission happened in the component or in the wrapper. Measured by mutation:
      // making the component send `parent_id: null` does not change what this asserts, because the
      // wrapper still removes it - and that is the right answer, since the service is what must never
      // receive it.
      renderCommentForm({ parentId: null });

      type(LABEL_ROOT, 'A top-level comment, written through the reply-capable form.');
      fireEvent.click(action(SUBMIT_ROOT));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });
      const body = onlyRequestBody();
      expect(body).not.toHaveProperty(MEMBER_PARENT_ID);
      expectExactMembers(body, [MEMBER_BODY]);
      expectNoServerOwnedMembers(body);
    });

    it('can be dismissed without issuing a request, which is how a reply affordance closes itself', () => {
      const onCancel = vi.fn<() => void>();
      renderCommentForm({ onCancel, parentId: PARENT_ID });

      fireEvent.click(action(CANCEL));

      expect(onCancel).toHaveBeenCalledTimes(1);
      expectNoRequests();
      expectNoToast();
    });
  });

  describe('edit mode', () => {
    it('pre-fills the field with the comment body and names the action as a save', () => {
      renderCommentForm({ comment: existingComment });

      expect(screen.getByRole('textbox', { name: LABEL_EDIT })).toHaveValue(existingComment.body);
      expect(action(SUBMIT_EDIT)).toBeEnabled();
      // Neither creation wording survives into an edit.
      expect(screen.queryByRole('button', { name: SUBMIT_ROOT })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: SUBMIT_REPLY })).not.toBeInTheDocument();
    });

    it('warns that editing an approved comment sends it back for approval', () => {
      renderCommentForm({ comment: existingComment });

      // Guidance chosen by the comment's CURRENT state, not by the mode alone: an approved comment is
      // withdrawn from the thread by its own edit, which is the one consequence a reader cannot guess.
      expect(field(LABEL_EDIT)).toHaveAccessibleDescription(describing(HELPER_EDIT_APPROVED));
      expect(field(LABEL_EDIT)).not.toHaveAccessibleDescription(describing(HELPER_CREATE));
    });

    it('submits PATCH /api/v1/comments/{id}, keyed on the comment rather than the post', async () => {
      const corrected = 'Corrected: the cascade is recursive, and it takes the whole subtree.';
      renderCommentForm({ comment: existingComment });

      type(LABEL_EDIT, corrected);
      fireEvent.click(action(SUBMIT_EDIT));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });
      const request = onlyRequest();
      expect(request.method).toBe('PATCH');
      // The asymmetry that matters: creation addresses the POST's collection, editing addresses the
      // COMMENT. Asserting the post id is absent from this path is how a regression that edited
      // through the thread route would be caught.
      expect(request.pathname).toBe(`/api/v1/comments/${existingComment.id}`);
      expect(request.pathname).not.toContain(POST_ID);

      const body = onlyRequestBody();
      expect(body[MEMBER_BODY]).toBe(corrected);
      // One member. `parent_id` is refused by the update schema outright - this route cannot move a
      // comment - and the moderation state stays out for the same reason it does on creation.
      expectExactMembers(body, [MEMBER_BODY]);
      expect(body).not.toHaveProperty(MEMBER_PARENT_ID);
      expectNoServerOwnedMembers(body);
      expectBearerOnEveryRequest();
    });

    it('keeps the newly saved text in the field rather than restoring the original', async () => {
      const corrected = 'Corrected once, and this is the text that must remain on screen.';
      renderCommentForm({ comment: existingComment });

      type(LABEL_EDIT, corrected);
      fireEvent.click(action(SUBMIT_EDIT));

      await waitFor(() => {
        expect(toastStub.success).toHaveBeenCalledTimes(1);
      });
      // An edit re-baselines to what the server stored, which clears the dirty state while KEEPING the
      // new words. A bare reset would restore the original body and silently undo the edit on screen.
      expect(field(LABEL_EDIT)).toHaveValue(corrected);
      expect(field(LABEL_EDIT)).not.toHaveValue(existingComment.body);
      // Its own wording, because an edit re-opens moderation rather than posting something new.
      expect(toastStub.success).toHaveBeenCalledWith(TOAST_HELD_EDIT);
    });

    it('passes the updated comment to onSuccess so the thread can replace its node', async () => {
      const corrected = 'One more pass over the same paragraph.';
      const onSuccess = vi.fn<(comment: CommentPublic) => void>();
      renderCommentForm({ comment: existingComment, onSuccess });

      type(LABEL_EDIT, corrected);
      fireEvent.click(action(SUBMIT_EDIT));

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
      // The identifier is unchanged and the status has returned to PENDING: editing does not create a
      // new comment, it withdraws an existing one from the thread until it is approved again.
      expect(onSuccess).toHaveBeenCalledWith(updatedComment(corrected));
    });

    it('ignores a parent on an edit, because a comment cannot be re-parented', async () => {
      // `comment` wins over `parentId`: editing a reply is still editing, and the reply's own parent is
      // already on the row. Re-parenting would restructure a discussion other readers have replied
      // within, and this API has no such operation.
      renderCommentForm({ comment: existingComment, parentId: PARENT_ID });

      expect(screen.getByRole('textbox', { name: LABEL_EDIT })).toBeInTheDocument();
      type(LABEL_EDIT, 'Edited, and still where it was.');
      fireEvent.click(action(SUBMIT_EDIT));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });
      expect(onlyRequest().pathname).toBe(`/api/v1/comments/${existingComment.id}`);
      expectExactMembers(onlyRequestBody(), [MEMBER_BODY]);
    });

    it('announces a pending save with its own wording', async () => {
      server.use(
        http.patch('*/api/v1/comments/:commentId', async ({ request }) => {
          await record(request);
          await delay(IN_FLIGHT_DELAY_MS);
          return HttpResponse.json(updatedComment('Saving takes a moment.'), { status: 200 });
        }),
      );
      renderCommentForm({ comment: existingComment });

      type(LABEL_EDIT, 'Saving takes a moment.');
      fireEvent.click(action(SUBMIT_EDIT));

      await waitFor(() => {
        expect(action(PENDING_EDIT)).toBeDisabled();
      });
      // Saving, not posting. The same control, and a reader is told which of the two is happening.
      expect(screen.queryByRole('button', { name: PENDING_CREATE })).not.toBeInTheDocument();

      await waitFor(() => {
        expect(toastStub.success).toHaveBeenCalledTimes(1);
      });
      expect(captured).toHaveLength(1);
    });
  });

  describe('validation', () => {
    it('refuses an empty submission, reports it on the field, and sends nothing', async () => {
      renderCommentForm();

      fireEvent.click(action(SUBMIT_ROOT));

      // The message the SCHEMA produced, read from it rather than restated here.
      await expectFieldRefused(LABEL_ROOT, MESSAGE_CREATE_EMPTY);
      // The whole point of validating in the browser: the network was never touched.
      expectNoRequests();
      expectNoToast();
    });

    it('refuses a body of only whitespace, because the schema trims before it measures', async () => {
      renderCommentForm();

      type(LABEL_ROOT, '      ');
      fireEvent.click(action(SUBMIT_ROOT));

      // Trimming first is what turns padding into a "too short" refusal rather than a stored blank
      // that renders as an empty bubble in a thread.
      await expectFieldRefused(LABEL_ROOT, MESSAGE_CREATE_EMPTY);
      expectNoRequests();
    });

    it('refuses a body one character past the ceiling the schema itself reports', async () => {
      renderCommentForm();

      type(LABEL_ROOT, bodyOfLength(BODY_OVER_CEILING));
      fireEvent.click(action(SUBMIT_ROOT));

      // Both the length and the wording come from `commentCreateSchema`, so raising the service's
      // limit and mirroring it in the validator moves this case with it instead of breaking it.
      await expectFieldRefused(LABEL_ROOT, MESSAGE_TOO_LONG);
      expectNoRequests();
    });

    it('accepts a body of exactly the ceiling, so the limit refuses nothing the API would store', async () => {
      const atCeiling = bodyOfLength(BODY_CEILING);
      renderCommentForm();

      type(LABEL_ROOT, atCeiling);
      fireEvent.click(action(SUBMIT_ROOT));

      // The other half of the boundary, and the half a "too long" case alone cannot cover: a validator
      // that was one character stricter than the service would refuse, in the reader's own words, a
      // comment the API would have accepted.
      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });
      expect(onlyRequestBody()[MEMBER_BODY]).toBe(atCeiling);
      expect(field(LABEL_ROOT)).not.toHaveAttribute('aria-invalid');
    });

    it('refuses a cleared editor with wording written for that situation', async () => {
      renderCommentForm({ comment: existingComment });

      type(LABEL_EDIT, '');
      fireEvent.click(action(SUBMIT_EDIT));

      // Different wording from the create case on purpose: clearing the text of a published comment
      // looks like an attempt to withdraw it, so the message names the two things the reader can
      // actually do rather than only refusing.
      await expectFieldRefused(LABEL_EDIT, MESSAGE_UPDATE_EMPTY);
      expectNoRequests();
    });

    it('lets a reader correct a refusal and submit successfully', async () => {
      renderCommentForm();

      fireEvent.click(action(SUBMIT_ROOT));
      await expectFieldRefused(LABEL_ROOT, MESSAGE_CREATE_EMPTY);

      type(LABEL_ROOT, 'Written on the second attempt.');
      fireEvent.click(action(SUBMIT_ROOT));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });
      // The refusal clears once the value satisfies the rule, so the control does not stay marked
      // invalid after the reader has already fixed it.
      await waitFor(() => {
        expect(field(LABEL_ROOT)).not.toHaveAttribute('aria-invalid');
      });
      expect(onlyRequestBody()[MEMBER_BODY]).toBe('Written on the second attempt.');
    });
  });

  describe('failure', () => {
    /** The per-field refusal a 422 carries, which the form pins onto the control that caused it. */
    const FIELD_REFUSAL: ValidationErrorItem = {
      field: MEMBER_BODY,
      message: 'Write something a moderator can read.',
      type: 'string_too_short',
    };

    /** The generic sentence a 422 carries alongside it. */
    const VALIDATION_DETAIL = 'The submitted comment is not valid.';

    it('pins a 422 field message onto the control, keeps the draft, and tries exactly once', async () => {
      const draft = 'Text the reader must not lose.';
      server.use(
        http.post('*/api/v1/posts/:postId/comments', async ({ request }) => {
          await record(request);
          return problemResponse(
            problem(422, 'Unprocessable Content', VALIDATION_DETAIL, [FIELD_REFUSAL]),
          );
        }),
      );
      renderCommentForm();

      type(LABEL_ROOT, draft);
      fireEvent.click(action(SUBMIT_ROOT));

      // Beside the field, wired through `aria-describedby`, so the reader is told WHICH part of what
      // they wrote was rejected rather than being left to guess from a summary.
      await expectFieldRefused(LABEL_ROOT, FIELD_REFUSAL.message);

      // And in the summary notice, whose `role="alert"` comes from the destructive variant rather than
      // from the call site. The hint is what connects the two.
      const notice = failureNotice();
      expect(notice).toHaveTextContent(FAILURE_TITLE);
      expect(notice).toHaveTextContent(VALIDATION_DETAIL);
      expect(notice).toHaveTextContent(FAILURE_FIELD_HINT);

      // A failed submission simply leaves the draft in the form. Losing a reader's words to a refusal
      // is the defect the reset-on-success-only rule exists to prevent, and it is what makes retrying
      // safe.
      expect(field(LABEL_ROOT)).toHaveValue(draft);

      // One attempt. `mutations: { retry: 0 }` in the tier's query provider is what guarantees it, and
      // a replayed 422 would be a second refusal the reader never asked for.
      expect(captured).toHaveLength(1);
      expectExactMembers(onlyRequestBody(), [MEMBER_BODY]);
      expectNoServerOwnedMembersAnywhere();
      expectNoToast();
    });

    it('returns focus to the field after a refusal names it', async () => {
      server.use(
        http.post('*/api/v1/posts/:postId/comments', async ({ request }) => {
          await record(request);
          return problemResponse(
            problem(422, 'Unprocessable Content', VALIDATION_DETAIL, [FIELD_REFUSAL]),
          );
        }),
      );
      renderCommentForm();

      type(LABEL_ROOT, 'Focus has to come back here.');
      fireEvent.click(action(SUBMIT_ROOT));

      // Submitting disables every control, and a disabled element cannot hold focus - so the press
      // drops focus onto `<body>`. Without this, a keyboard reader would be left reading a message at
      // the top of the document with no way back to the box they have to change.
      await waitFor(() => {
        expect(field(LABEL_ROOT)).toHaveFocus();
      });
    });

    it('explains a 401 in its own words, keeps the draft, and sends no credential it does not hold', async () => {
      const draft = 'Written just as the session ran out.';
      // Cleared for this case only, so the request goes out with no bearer. That also makes the outcome
      // deterministic: the client rotates a credential only when a 401 answers a request that actually
      // carried one, so with none held there is exactly one attempt and no refresh round trip.
      clearCredentials();
      server.use(
        http.post('*/api/v1/posts/:postId/comments', async ({ request }) => {
          await record(request);
          return problemResponse(
            problem(401, 'Unauthorized', 'Authentication credentials are missing or invalid.'),
            { 'WWW-Authenticate': WWW_AUTHENTICATE_BEARER },
          );
        }),
      );
      renderCommentForm();

      type(LABEL_ROOT, draft);
      fireEvent.click(action(SUBMIT_ROOT));

      // The API says "not authenticated", which reads to a person as though they had done something
      // wrong. The form substitutes the truth: the session ran out mid-visit and the text is safe.
      await waitFor(() => {
        expect(failureNotice()).toHaveTextContent(SESSION_EXPIRED_MESSAGE);
      });
      expect(field(LABEL_ROOT)).toHaveValue(draft);

      expect(captured).toHaveLength(1);
      expect(onlyRequest().authorization).toBeNull();
      // A 401 carries no per-field detail, so nothing is pinned to the control - the notice alone
      // carries it, and marking the box invalid would blame the text rather than the session.
      expect(field(LABEL_ROOT)).not.toHaveAttribute('aria-invalid');
      expectNoToast();
    });

    it('surfaces a 403 as the service worded it, without blaming the field', async () => {
      const detail = 'You may only edit your own comments.';
      server.use(
        http.patch('*/api/v1/comments/:commentId', async ({ request }) => {
          await record(request);
          return problemResponse(problem(403, 'Forbidden', detail));
        }),
      );
      renderCommentForm({ comment: existingComment });

      type(LABEL_EDIT, 'An edit somebody else is not allowed to make.');
      fireEvent.click(action(SUBMIT_EDIT));

      // Every failure except a 401 is described better by the service than by anything this form could
      // invent, so the problem document's own `detail` is what a reader sees.
      await waitFor(() => {
        expect(failureNotice()).toHaveTextContent(detail);
      });
      expect(failureNotice()).not.toHaveTextContent(FAILURE_FIELD_HINT);
      expect(field(LABEL_EDIT)).not.toHaveAttribute('aria-invalid');
      expect(captured).toHaveLength(1);
      expectNoToast();
    });

    it('leaves a per-field message in the summary when it names a control the form does not show', async () => {
      const parentRefusal: ValidationErrorItem = {
        field: MEMBER_PARENT_ID,
        message: 'The comment being replied to was not found on this post.',
        type: 'value_error',
      };
      server.use(
        http.post('*/api/v1/posts/:postId/comments', async ({ request }) => {
          await record(request);
          return problemResponse(
            problem(422, 'Unprocessable Content', VALIDATION_DETAIL, [parentRefusal]),
          );
        }),
      );
      renderCommentForm({ parentId: PARENT_ID });

      type(LABEL_REPLY, 'A reply whose target went missing.');
      fireEvent.click(action(SUBMIT_REPLY));

      // `parent_id` is supplied by the affordance, never typed, so there is no control to pin it to -
      // and pinning a message to a control that is not on screen hides it completely. It stays in the
      // summary, and the field is not marked invalid for something the reader did not do.
      await waitFor(() => {
        expect(failureNotice()).toHaveTextContent(VALIDATION_DETAIL);
      });
      expect(field(LABEL_REPLY)).not.toHaveAttribute('aria-invalid');
      expect(failureNotice()).not.toHaveTextContent(FAILURE_FIELD_HINT);
      expect(field(LABEL_REPLY)).toHaveValue('A reply whose target went missing.');
    });

    it('lets a reader retry after a refusal, and the retry carries the same contract', async () => {
      let attempts = 0;
      server.use(
        http.post('*/api/v1/posts/:postId/comments', async ({ request }) => {
          await record(request);
          attempts += 1;
          if (attempts === 1) {
            return problemResponse(
              problem(422, 'Unprocessable Content', VALIDATION_DETAIL, [FIELD_REFUSAL]),
            );
          }
          return HttpResponse.json(createdComment('Second time, unchanged.', null), {
            status: 201,
          });
        }),
      );
      renderCommentForm();

      type(LABEL_ROOT, 'Second time, unchanged.');
      fireEvent.click(action(SUBMIT_ROOT));
      await waitFor(() => {
        expect(failureNotice()).toBeInTheDocument();
      });

      // The draft survived, so pressing again is a real retry rather than a re-typing exercise.
      fireEvent.click(action(SUBMIT_ROOT));

      await waitFor(() => {
        expect(toastStub.success).toHaveBeenCalledTimes(1);
      });
      expect(captured).toHaveLength(2);
      // Both attempts, not merely the successful one: a retry assembled differently from the first
      // attempt would be the easiest place for a prohibited member to appear.
      for (const entry of captured) {
        expect(entry.body).not.toBeNull();
        if (entry.body !== null) {
          expectExactMembers(entry.body, [MEMBER_BODY]);
        }
      }
      expectNoServerOwnedMembersAnywhere();
      expectBearerOnEveryRequest();
    });
  });

  describe('session states', () => {
    it('offers a signed-out visitor a sign-in link back to the post, and no field to type in', () => {
      renderCommentForm({ user: null });

      // Hiding the form is a courtesy, not a boundary: the route requires a bearer and the service
      // re-checks it either way. Nothing here reads, decodes or verifies a token.
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: SUBMIT_ROOT })).not.toBeInTheDocument();

      expect(screen.getByText(ANONYMOUS_TITLE)).toBeInTheDocument();
      expect(screen.getByText(ANONYMOUS_DETAIL)).toBeInTheDocument();

      // A real link, not a button: it copies as a URL, opens in a new tab and is crawlable. The return
      // trip travels in the same `next` parameter `src/middleware.ts` writes when it refuses a route.
      const signIn = screen.getByRole('link', { name: SIGN_IN_ROOT });
      const query = new URLSearchParams({ [RETURN_TO_PARAM]: POST_PATHNAME });
      expect(signIn).toHaveAttribute('href', `${LOGIN_PATH}?${query.toString()}`);
      expectNoRequests();
    });

    it('words the sign-in prompt for the affordance the visitor pressed', () => {
      renderCommentForm({ parentId: PARENT_ID, user: null });

      // A visitor who pressed "Reply" is answered about replying. The prompt is the only thing on
      // screen at that point, so generic wording would lose the thread of what they were doing.
      expect(screen.getByRole('link', { name: SIGN_IN_REPLY })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: SIGN_IN_ROOT })).not.toBeInTheDocument();
    });

    it('announces the wait while the session is still resolving, and shows neither answer', () => {
      renderCommentForm({ isLoading: true, user: null });

      // Flashing the sign-in prompt at a reader who IS signed in - or the form at one who is not - is
      // worse than a moment of nothing, so the first paint commits to neither. The sentence is what a
      // screen reader hears; the bars beside it are hidden from assistive technology.
      expect(screen.getByText(SESSION_LOADING_MESSAGE)).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: SIGN_IN_ROOT })).not.toBeInTheDocument();
      expectNoRequests();
    });

    it('shows the form once a session resolves, without losing the caller-requested focus', async () => {
      renderCommentForm({ autoFocus: true });

      // `autoFocus` is implemented against the field's arrival rather than the component's mount,
      // which is what makes it work on a reply box opened while the session is still resolving.
      await waitFor(() => {
        expect(field(LABEL_ROOT)).toHaveFocus();
      });
      expect(screen.queryByText(SESSION_LOADING_MESSAGE)).not.toBeInTheDocument();
      expect(screen.queryByText(ANONYMOUS_TITLE)).not.toBeInTheDocument();
    });
  });
});
