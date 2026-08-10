/* =================================================================================================
 * comment-list.test.tsx - the component spec for `@/components/blog/comment-list`.
 *
 * `CommentList` is the ONE place the thread's `Page<CommentPublic>` envelope is read, and the one
 * module in the comments feature that is deliberately NOT a client island. Everything this file
 * asserts follows from those two facts.
 *
 * THE CONTRACT THAT MATTERS MOST, AND THE FIXTURE BUILT TO CATCH IT
 *
 * `GET /api/v1/posts/{id}/comments` windows TOP-LEVEL comments only. Each root arrives with its
 * replies already nested inside `CommentPublic.replies`, so `total` and `pages` count THREADS and
 * consecutive pages stay disjoint - which is what lets the same pagination arithmetic serve the feed,
 * a profile and the four administrative tables and mean the same thing in all six places. If `total`
 * counted every reply instead, page two would overlap page one the moment somebody answered a
 * comment on page one.
 *
 * A naive fixture hides that distinction completely: two roots with no replies makes the node count
 * and `total` the same number, so an implementation that walked the payload and counted nodes would
 * pass. {@link singlePageThread} therefore carries FOUR comments and a `total` of TWO, and the
 * heading case below asserts the count is `formatCount(2)` and explicitly NOT `formatCount(4)`.
 *
 * WHY A DIRECTIVE-FREE COMPONENT STILL NEEDS TWO PROVIDERS AND A ROUTER
 *
 * `CommentList` uses no hook, but it renders three children that do: `CommentForm` and `CommentItem`
 * both call `useAuth()`, which THROWS outside a provider, and `Pagination` reads the URL through
 * `usePagination`. So every render below is wrapped in the real `QueryProvider` and in
 * `AuthContext.Provider` with a fully typed stub, and `next/navigation` is mocked with all three
 * hooks the tree consumes. `next/link` is deliberately NOT mocked - measured in this configuration it
 * renders a real anchor under jsdom, and the `href` it renders is the one thing worth asserting about
 * a crawlable page control.
 *
 * WHICH MSW ROUTE THIS FILE TOOK, AND WHY (recorded because there were two)
 *
 * `frontend/vitest.setup.ts` owns NO `setupServer` instance and exports none - it registers the
 * jest-dom matchers, an `afterEach` unmount and four jsdom stubs, and its header assigns the server
 * and its lifecycle to "whichever spec owns the server lifecycle". `frontend/tests/msw/handlers.ts`
 * says the same of itself: it is one flat array and imports nothing from `msw/node`. So this spec
 * owns exactly ONE instance, seeded with that shared array, exactly as `comment-item.test.tsx` and
 * `comment-form.test.tsx` do. There is no second instance anywhere in this file.
 *
 * On top of it sit TWO independent guarantees that this component performs no HTTP:
 *
 *   1. A counting guard handler on the thread's list operation - a `GET` on the versioned
 *      `posts/:postId/comments` path, spelled once in {@link THREAD_LIST_PATTERN} - layered per test
 *      through `server.use`. It records every list request and answers a refusal. It must never fire.
 *   2. A `server.events.on('request:start')` counter, which observes EVERY intercepted request
 *      whatever its path. The shared handler array covers the whole `/api/v1` surface, so a stray
 *      request to some other endpoint would be answered silently rather than tripping
 *      `onUnhandledRequest: 'error'`; this counter is what makes "no HTTP at all" assertable rather
 *      than merely "no unhandled request".
 *
 * Both are asserted empty in an `afterEach` that runs for EVERY case, not only for the cases in the
 * "performs no HTTP" group, so the guarantee is uniform instead of being restated per case and
 * forgotten in one of them.
 *
 * The rejected alternative was to mock `@/lib/api/comments` and assert its list function was never
 * called. It proves less: it says nothing about a component that reached for `fetch` directly, and
 * `vitest.setup.ts` forbids mocking `fetch` or `src/lib/api/client.ts` precisely because that client
 * owns token attachment, refresh-on-401 and error normalisation.
 *
 * WHERE THIS FILE DIVERGES FROM AN EXPECTATION, IT FOLLOWS THE SOURCE
 *
 * The empty panel announces NOTHING. `@/components/ui/alert` derives its live-region role from the
 * variant, and its `ALERT_ROLES` table maps both `info` and `empty` to `undefined`, on the reasoning
 * that an empty state is CONTENT - present in the server's very first HTML - rather than an outcome
 * worth interrupting a reader for. `comment-list.tsx` renders `<Alert variant="empty">` and authors
 * no `role`, `aria-live` or `aria-atomic` in either direction. So the empty-state case asserts the
 * visible title and description AND asserts that neither `status` nor `alert` is present: a static
 * empty thread must not be shouted, and asserting the role the variant table actually declares is
 * what keeps this file honest about the primitive's contract.
 *
 * MODERATION IS NOT THIS COMPONENT'S JOB
 *
 * Only APPROVED comments reach a public caller, and that filter is composed once, server-side, in
 * `backend/app/repositories/comment_repository.py`. It is verified by the backend suite and by
 * `frontend/tests/e2e/comments-likes.spec.ts`, and NOT here: a case that handed this component a
 * `PENDING` comment and expected it to be hidden would be asserting a client-side security boundary
 * that deliberately does not exist. What this file does assert is the opposite and is genuinely this
 * component's contract - a non-approved comment handed to it is rendered, with the moderation badge
 * `CommentItem` gives it and with no approve or reject control anywhere, because
 * `PATCH /api/v1/admin/comments/{id}/status` is the only route that moves a status and
 * `src/components/admin/comment-moderation-actions.tsx` is the only surface that calls it.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO. Please do not add:
 *
 *   1. Any assertion on a class name. No `toHaveClass`, no `className` read, no class-based
 *      `querySelector`, no `getComputedStyle`, no snapshot - and, specifically, no assertion about
 *      the indentation of a reply. Every value in the component resolves to a semantic token in
 *      `src/app/globals.css` and is free to change; the two `closest()` calls below select by ELEMENT
 *      NAME, which is the only way to reach an `article` or a `ul` from a descendant.
 *   2. A list-endpoint mock used to FEED the component. The envelope is a prop. The only handler this
 *      file registers for the list path is the guard that must never fire.
 *   3. A camelCase envelope, an envelope with anything other than the five documented fields, or a
 *      `total` that counts replies. `Page<CommentPublic>` is imported as a type and every fixture
 *      satisfies it with no cast.
 *   4. A second `setupServer`, a `fetch` patch, or a mock of `@/lib/api/client` or
 *      `@/lib/api/comments`. See above.
 *   5. An expectation that the component filters by moderation status. See above.
 *   6. Anything from the retired surface: no `/items` path, no `Item` type and no `id`/`name`/`price`
 *      triple - AAP §0.9.4.3 requires that surface provably absent from this tier. `Page<T>.items` is
 *      the AAP's own uniform collection field and is unrelated to the retired route; the local that
 *      holds the element under test is called `subject` for the same reason.
 *   7. A real `AuthProvider`. It restores a session over HTTP and touches cookies, neither of which
 *      this component does. Nothing here builds, decodes, stores or asserts on a token, and no
 *      credential is set: this component performs no HTTP, so it needs none.
 *   8. A 5xx failure. `@/providers/query-provider`'s retry predicate refuses to replay a 4xx and sets
 *      `mutations: { retry: 0 }`, so the one refusal this file declares - inside the guard handler
 *      that must never run - is a 4xx.
 *   9. `@testing-library/user-event`. It is not a declared dependency; the single interaction below
 *      is `fireEvent.click`.
 *  10. A jest-dom import or a manual `cleanup()`. `vitest.setup.ts` registers the matchers and
 *      unmounts between tests.
 *  11. A responsive assertion. jsdom applies no media query, so viewport behaviour is verified in
 *      `frontend/tests/e2e/comments-likes.spec.ts`.
 *  12. `.only` or `.skip`.
 * ============================================================================================== */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { RequestHandler } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactElement } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommentList } from '@/components/blog/comment-list';
import { formatCount } from '@/lib/format';
import type { CommentPublic, Page, ProblemDetail, UserMe, UserPublic } from '@/lib/types';
import { AuthContext } from '@/providers/auth-provider';
import type { AuthContextValue } from '@/providers/auth-provider';
import { QueryProvider } from '@/providers/query-provider';

import { handlers } from '../msw/handlers';

/* -------------------------------------------------------------------------------------------------
 * The App Router harness
 *
 * `vi.hoisted` rather than a bare `const`, because `vi.mock` is lifted above every import in the
 * file: a factory closing over an ordinary module-level binding throws "Cannot access '...' before
 * initialization" at collection time, before a single test runs.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The URL the mocked App Router reports, restored by `beforeEach`.
 *
 * The pathname is a post route because that is the only surface that renders this component, and it
 * is what both the page control's hrefs and the signed-out form's return trip are built from.
 */
const routerState = vi.hoisted(() => ({
  pathname: '/blog/scaling-fastapi',
  query: '',
}));

/**
 * The full `AppRouterInstance` surface, as spies.
 *
 * All six rather than only the `push` that `usePagination` would reach for, and they are themselves
 * an assertion rather than mere scaffolding: this thread's page control is passed no `onPageChange`,
 * so THE ANCHOR IS THE NAVIGATION. A click that routed programmatically would fire a second
 * transition for one click, leaving two history entries and a back button that appears dead - and the
 * "no imperative navigation" case below is what would catch it.
 */
const routerSpies = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
}));

/*
 * All three hooks the rendered tree consumes: `usePathname` for `CommentForm` and `CommentItem`, and
 * `useSearchParams` plus `useRouter` for `Pagination` by way of `usePagination`.
 *
 * Plain arrow functions rather than `vi.fn()` wrappers on purpose: the `vi.clearAllMocks()` in
 * `beforeEach` clears call history, and a mock implementation here would be one refactor away from
 * being reset out from under every test in the file. `useSearchParams` returns a REAL
 * `URLSearchParams`, so `.get()` and `.toString()` behave exactly as the hook's callers expect.
 */
vi.mock('next/navigation', () => ({
  useSearchParams: (): URLSearchParams => new URLSearchParams(routerState.query),
  usePathname: (): string => routerState.pathname,
  useRouter: () => routerSpies,
}));

/* -------------------------------------------------------------------------------------------------
 * Contract vocabulary
 *
 * The component declares each of these as a module constant and exports none of them, so a spec has
 * to restate the string it asserts on. Collected here rather than written inline because the
 * accessible names of a section, a field and a page control are its contract with a screen reader,
 * and a change to one should be a one-line edit rather than a hunt.
 * ---------------------------------------------------------------------------------------------- */

/** The heading's label. The count is appended in parentheses, separated by one space. */
const HEADING_LABEL = 'Comments';

/** The default heading level. A page spends its single `h1` on the route heading (AAP §0.7.3.5). */
const DEFAULT_HEADING_LEVEL = 2;

/** The level a consumer that has already introduced an `h2` above the thread passes instead. */
const NESTED_HEADING_LEVEL = 3;

/** The level that must never appear: the post page owns the page's one `h1`. */
const FORBIDDEN_HEADING_LEVEL = 1;

/** Headline of the empty panel. */
const EMPTY_TITLE = 'No comments yet';

/** Supporting copy of the empty panel, which points at the form directly above it. */
const EMPTY_DESCRIPTION = 'Be the first to share your thoughts on this post.';

/** Accessible name of the root form's field, from `COPY.root.label` in `comment-form.tsx`. */
const ROOT_FIELD_LABEL = 'Add a comment';

/** The root form's submit control, from `COPY.root.submit`. */
const ROOT_SUBMIT_LABEL = 'Post comment';

/** Heading of the panel a signed-out visitor sees in place of the field. */
const ANONYMOUS_TITLE = 'Sign in to join the discussion';

/** The call to action inside that panel, from `COPY.root.signIn`. */
const ANONYMOUS_LINK_LABEL = 'Sign in to comment';

/** Where a signed-out visitor is sent. Matches `LOGIN_PATH` in `src/middleware.ts`. */
const LOGIN_PATH = '/login';

/** The parameter carrying the route to come back to. Matches `RETURN_TO_PARAM` in the middleware. */
const RETURN_TO_PARAM = 'next';

/** Accessible name this surface gives the page control's landmark, overriding its bare default. */
const PAGINATION_LABEL = 'Comments pagination';

/** The query parameter the page control addresses a window through. */
const PAGE_PARAM = 'page';

/**
 * A parameter of the reader's own, standing in for whatever a shared link happens to carry.
 *
 * Nothing in this product writes it. Its only job is to be something the page control was never told
 * about, so that "sibling parameters survive turning the page" is an assertion about behaviour rather
 * than about a parameter the implementation already knows by name.
 */
const REFERRAL_PARAM = 'ref';
const REFERRAL_VALUE = 'newsletter';

/** The moderation badge a `PENDING` comment carries, from `MODERATION_LABELS` in `comment-item.tsx`. */
const PENDING_BADGE_LABEL = 'Awaiting approval';

/** Origin used only as a base for parsing a relative `href`. Never requested. */
const PARSE_ORIGIN = 'http://localhost';

/** The one refusal this file declares, inside a handler that must never run. A 4xx, never a 5xx. */
const STATUS_NOT_FOUND = 404;

/** Media type every failure path of this API answers with. */
const PROBLEM_JSON_MEDIA_TYPE = 'application/problem+json';

/** Path pattern of the thread's list operation, matching `tests/msw/handlers.ts` exactly. */
const THREAD_LIST_PATTERN = '*/api/v1/posts/:postId/comments';

/* -------------------------------------------------------------------------------------------------
 * Identity
 *
 * Every identifier here is a UUID-shaped string, never an integer. That is not decoration: the
 * retired surface made the CLIENT the sole source of a small integer key, which is exactly the defect
 * class server-generated UUIDs remove (AAP §0.2.3, §0.10.1 "Server-owned identity and
 * database-enforced integrity"). A fixture keyed by `1` would be describing the old contract.
 *
 * The post's identifier also reaches the DOM: `comment-list.tsx` builds its heading's `id` from it
 * rather than from `useId()`, because a hook would force `'use client'` on a component whose whole
 * purpose is to be server-rendered.
 * ---------------------------------------------------------------------------------------------- */

const POST_ID = '5e8a3c14-7b62-4d0f-9a35-2c1e6f8b4d70';

const COMMENT_ID_ROOT_ONE = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const COMMENT_ID_ROOT_TWO = '1b2c3d4e-5f6a-4b7c-9d8e-1f2a3b4c5d6e';
const COMMENT_ID_REPLY_ONE = '2c3d4e5f-6a7b-4c8d-8e9f-2a3b4c5d6e7f';
const COMMENT_ID_REPLY_TWO = '3d4e5f6a-7b8c-4d9e-9f01-3b4c5d6e7f80';
const COMMENT_ID_LATER_ONE = '4e5f6a7b-8c9d-4e0f-8123-4c5d6e7f8091';
const COMMENT_ID_LATER_TWO = '5f6a7b8c-9d0e-4f01-9234-5d6e7f8091a2';
const COMMENT_ID_PENDING = '6a7b8c9d-0e1f-4012-8345-6e7f8091a2b3';

const USER_ID_READER = '7b8c9d0e-1f20-4123-9456-7f8091a2b3c4';
const USER_ID_ALICE = '8c9d0e1f-2031-4234-8567-8091a2b3c4d5';
const USER_ID_BRUNO = '9d0e1f20-3142-4345-9678-91a2b3c4d5e6';
const USER_ID_CARA = '0e1f2031-4253-4456-8789-a1b2c3d4e5f6';

/* -------------------------------------------------------------------------------------------------
 * Instants
 *
 * Fixed ISO strings so nothing in a rendered byline depends on when the suite runs. `CommentItem`
 * captures one client reference instant per module and measures every node against it, so a relative
 * phrase stays internally consistent - but no case below asserts on a timestamp, which is
 * `comment-item.test.tsx`'s subject rather than this file's.
 * ---------------------------------------------------------------------------------------------- */

/** When every fixture comment was written. */
const INSTANT_CREATED = '2024-05-12T09:30:00Z';

/** When every fixture account was created and last updated. */
const INSTANT_ACCOUNT = '2024-01-08T08:00:00Z';

/* -------------------------------------------------------------------------------------------------
 * Authors
 *
 * `avatar_url: null` throughout. `CommentItem` renders `@/components/ui/avatar`, whose Radix image
 * part resolves asynchronously; with no URL the fallback initials render synchronously and the whole
 * subtree is deterministic, which is what keeps every case below free of an `act(...)` warning. The
 * avatar is `aria-hidden` in any case, so nothing is lost.
 *
 * Four distinct display names, so an assertion scoped to one subtree cannot pass because of a name
 * that appears in another.
 * ---------------------------------------------------------------------------------------------- */

/** A complete public author projection, with no cast and no omitted member. */
function makeAuthor(overrides: Partial<UserPublic> = {}): UserPublic {
  const base: UserPublic = {
    id: USER_ID_ALICE,
    username: 'alice',
    display_name: 'Alice Nkemdirim',
    bio: null,
    avatar_url: null,
    created_at: INSTANT_ACCOUNT,
  };

  return { ...base, ...overrides };
}

const alice: UserPublic = makeAuthor();

const bruno: UserPublic = makeAuthor({
  id: USER_ID_BRUNO,
  username: 'bruno',
  display_name: 'Bruno Salgado',
});

const cara: UserPublic = makeAuthor({
  id: USER_ID_CARA,
  username: 'cara',
  display_name: 'Cara Whitfield',
});

/**
 * The signed-in principal for most cases: an ordinary reader who wrote none of these comments.
 *
 * `READER` and an identifier that matches no comment's author, which is deliberate. Neither half of
 * `CommentItem`'s ownership predicate holds, so its Edit and Delete controls stay withheld and the
 * cases below are not accidentally asserting against a tree full of destructive affordances. Nothing
 * about this account is a credential: it is a projection handed to a stubbed context.
 */
const readerAccount: UserMe = {
  id: USER_ID_READER,
  username: 'devon',
  display_name: 'Devon Ashworth',
  bio: null,
  avatar_url: null,
  created_at: INSTANT_ACCOUNT,
  email: 'devon@example.test',
  role: 'READER',
  is_active: true,
  updated_at: INSTANT_ACCOUNT,
};

/* -------------------------------------------------------------------------------------------------
 * Comments
 *
 * Bodies are distinct per node, so a `within` assertion proves WHICH subtree holds which text rather
 * than merely that the text appears somewhere on screen.
 * ---------------------------------------------------------------------------------------------- */

const BODY_ROOT_ONE = 'The connection-pool sizing point is the one I keep getting wrong.';
const BODY_ROOT_TWO = 'Weighted relevance search was the part I did not expect to be built in.';
const BODY_REPLY_ONE = 'Right - the pool has to be sized per worker, not per process.';
const BODY_REPLY_TWO = 'We paired it with a readiness probe and it changed how we deploy.';
const BODY_LATER_ONE = 'Arriving here from page two, which is what makes the window worth testing.';
const BODY_LATER_TWO = 'And this one is its neighbour, so the page holds more than a single row.';
const BODY_PENDING =
  'Held in the queue, and handed to the component exactly as the service sent it.';

/**
 * A complete {@link CommentPublic}, with every member the wire carries and no cast.
 *
 * `Partial` overrides are spread over a COMPLETE base rather than assembled from optional members, so
 * a member added to the contract is a compile error here - the base stops satisfying the interface -
 * rather than an `undefined` that only some case happens to notice.
 *
 * `reply_count` defaults to `0` and every nested fixture below sets it to `replies.length`. That
 * agreement is deliberate: `CommentItem` renders a sentence when its tally exceeds the replies it was
 * given, so a fixture that left the two disagreeing would put an unasked-for note into every case.
 */
function makeComment(overrides: Partial<CommentPublic> = {}): CommentPublic {
  const base: CommentPublic = {
    id: COMMENT_ID_ROOT_ONE,
    post_id: POST_ID,
    parent_id: null,
    author: alice,
    body: BODY_ROOT_ONE,
    status: 'APPROVED',
    created_at: INSTANT_CREATED,
    updated_at: INSTANT_CREATED,
    reply_count: 0,
    has_more_replies: false,
    replies: [],
  };

  return { ...base, ...overrides };
}

/** First reply to the first root. Delivered INSIDE its parent's payload, never fetched. */
const replyOne: CommentPublic = makeComment({
  id: COMMENT_ID_REPLY_ONE,
  parent_id: COMMENT_ID_ROOT_ONE,
  author: bruno,
  body: BODY_REPLY_ONE,
});

/** Second reply to the first root, so the nested list has more than one item. */
const replyTwo: CommentPublic = makeComment({
  id: COMMENT_ID_REPLY_TWO,
  parent_id: COMMENT_ID_ROOT_ONE,
  author: cara,
  body: BODY_REPLY_TWO,
});

/** The first root: two replies nested inside it, which is what makes the node count exceed `total`. */
const rootOne: CommentPublic = makeComment({
  reply_count: 2,
  replies: [replyOne, replyTwo],
});

/** The second root: a leaf, so the same page exercises both the nested and the childless path. */
const rootTwo: CommentPublic = makeComment({
  id: COMMENT_ID_ROOT_TWO,
  author: bruno,
  body: BODY_ROOT_TWO,
});

/** A root on the second page. Its body is unique, which is how page disjointness stays observable. */
const laterRootOne: CommentPublic = makeComment({
  id: COMMENT_ID_LATER_ONE,
  author: cara,
  body: BODY_LATER_ONE,
});

/** Its neighbour on the second page. */
const laterRootTwo: CommentPublic = makeComment({
  id: COMMENT_ID_LATER_TWO,
  author: alice,
  body: BODY_LATER_TWO,
});

/**
 * A comment still in the moderation queue.
 *
 * A public caller never receives one - the filter is composed server-side - so this fixture exists to
 * assert what the component does with what it is HANDED, which is to render it verbatim with the
 * badge its status earns. See this file's header.
 */
const pendingRoot: CommentPublic = makeComment({
  id: COMMENT_ID_PENDING,
  author: cara,
  body: BODY_PENDING,
  status: 'PENDING',
});

/* -------------------------------------------------------------------------------------------------
 * Page envelopes
 *
 * Exactly the five fields `Page<T>` declares - `items`, `total`, `page`, `page_size`, `pages` - in the
 * service's own snake_case, with no camelCase variant and no cast anywhere. The type annotation is
 * what enforces that: a sixth member, a renamed member or a missing one fails `tsc --noEmit`.
 * ---------------------------------------------------------------------------------------------- */

/** The service's own default window, echoed back on every page it produces. */
const DEFAULT_PAGE_SIZE = 20;

/** A complete envelope over the rows it is given, with the four numeric members overridable. */
function makePage(
  items: CommentPublic[],
  overrides: Partial<Omit<Page<CommentPublic>, 'items'>> = {},
): Page<CommentPublic> {
  const base: Page<CommentPublic> = {
    items,
    total: items.length,
    page: 1,
    page_size: DEFAULT_PAGE_SIZE,
    pages: items.length === 0 ? 0 : 1,
  };

  return { ...base, ...overrides };
}

/**
 * THE FIXTURE THIS FILE IS BUILT AROUND: four comments, and a `total` of two.
 *
 * Two roots, the first carrying two replies. `total` and `pages` count the ROOTS the service windowed,
 * so the heading must read two - and an implementation that walked the payload counting nodes would
 * read four. That gap is the only thing that makes the distinction testable, and a fixture without
 * nested replies would hide it completely.
 */
const singlePageThread: Page<CommentPublic> = makePage([rootOne, rootTwo], { total: 2, pages: 1 });

/** How many comments {@link singlePageThread} actually renders, replies included. */
const SINGLE_PAGE_NODE_COUNT = 4;

/**
 * The second page of a three-page thread.
 *
 * `total` is a real unwindowed tally of roots at this window size - 45 threads across 3 pages of 20 -
 * so the page control's arithmetic is exercised against numbers that agree with each other. The rows
 * are only two, which is legitimate: `comment-list.tsx` passes no `items` to `Pagination`, so the
 * control reads the numbers and never the array length.
 */
const multiPageThread: Page<CommentPublic> = makePage([laterRootOne, laterRootTwo], {
  total: 45,
  page: 2,
  pages: 3,
});

/**
 * An empty thread.
 *
 * `pages: 0` is what the service returns for a collection with nothing in it, and it is below the
 * one-page floor, so no page control renders. Note this is an ORDINARY input rather than an error
 * state - and it is also what a page past the end of a real thread looks like, which AAP §0.9.4.4
 * requires to render rather than throw.
 */
const emptyThread: Page<CommentPublic> = makePage([], { total: 0, pages: 0 });

/** A one-row thread whose only comment is still awaiting approval. */
const moderatedThread: Page<CommentPublic> = makePage([pendingRoot], { total: 1, pages: 1 });

/* -------------------------------------------------------------------------------------------------
 * The session stub
 *
 * `useAuth()` throws outside a provider, and the real `AuthProvider` restores a session over HTTP and
 * touches cookies - neither of which this component does. So the context is given a fully typed value
 * instead: all eight members of `AuthContextValue`, with the four asynchronous ones as spies that
 * resolve. Nothing here builds, decodes, stores or asserts on a token; the principal is a projection,
 * and every authority decision is re-made server-side regardless (AAP §0.2.3).
 * ---------------------------------------------------------------------------------------------- */

/**
 * One complete {@link AuthContextValue}.
 *
 * @param user - The signed-in principal, or `null` for a visitor with no session.
 * @returns A value the provider can hold, with no member missing and no cast.
 */
function session(user: UserMe | null): AuthContextValue {
  return {
    user,
    isLoading: false,
    isAuthenticated: user !== null,
    restoreError: null,
    login: vi.fn(() => Promise.resolve()),
    register: vi.fn(() => Promise.resolve()),
    logout: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
  };
}

/* -------------------------------------------------------------------------------------------------
 * The network boundary
 *
 * ONE server instance for this file, seeded with the shared handler array. See the header for why the
 * instance lives here rather than in `vitest.setup.ts`, and for the two independent counters below.
 * ---------------------------------------------------------------------------------------------- */

const server = setupServer(...handlers);

/**
 * Every request the guard handler on the thread's list path saw, as its full URL.
 *
 * Must stay empty. This component takes its envelope as a prop from the Server Component that fetched
 * it, so a list request originating here would mean the layering had collapsed.
 */
let threadListRequests: string[] = [];

/**
 * Every request MSW intercepted at all, as `METHOD /path`, whatever its endpoint.
 *
 * Broader than the guard on purpose. The shared array answers the entire `/api/v1` surface, so a
 * stray request to some other endpoint would be served silently instead of tripping
 * `onUnhandledRequest: 'error'` - this list is what turns "performs no HTTP" into an assertable fact
 * rather than an assumption. Recorded as method and path only, because a query string would make the
 * failure message noisier without making it clearer.
 */
let observedRequests: string[] = [];

/**
 * The guard that must never fire.
 *
 * It records the request and answers the API's one uniform problem document with a 4xx, so a
 * regression that started fetching fails loudly on BOTH counts - the counter, and a thread that
 * cannot render. Layered per test through `server.use`, above the shared handler for the same path,
 * because `server.resetHandlers()` in `afterEach` drops runtime overrides and leaves the shared array
 * intact.
 */
function threadListGuard(): RequestHandler {
  return http.get(THREAD_LIST_PATTERN, ({ request }) => {
    threadListRequests.push(request.url);

    const refusal: ProblemDetail = {
      type: '/errors/not-found',
      title: 'Not Found',
      status: STATUS_NOT_FOUND,
      detail: 'CommentList must never request the thread it was handed as a prop.',
      instance: new URL(request.url).pathname,
      request_id: 'req-00000000-0000-4000-8000-000000000000',
    };

    return HttpResponse.json(refusal, {
      status: STATUS_NOT_FOUND,
      headers: { 'Content-Type': PROBLEM_JSON_MEDIA_TYPE },
    });
  });
}

/**
 * Stand in for the App Router's link interception.
 *
 * Registered on `document` for the BUBBLE phase, so it runs after the handler React attached to the
 * render container: by the time it fires, `defaultPrevented` reflects what the component tree did and
 * nothing else. Recording that value and then cancelling gives both halves of what this file needs -
 * the tree's non-cancellation is observable, and jsdom never attempts a document navigation it cannot
 * perform.
 */
const lastClick: { cancelledBeforeDocument: boolean | null } = {
  cancelledBeforeDocument: null,
};

function interceptDocumentNavigation(event: Event): void {
  lastClick.cancelledBeforeDocument = event.defaultPrevented;
  event.preventDefault();
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });

  /*
   * Registered once for the whole file rather than per test, because a listener added in `beforeEach`
   * would accumulate one copy per case and count a single request many times.
   */
  server.events.on('request:start', ({ request }) => {
    observedRequests.push(`${request.method} ${new URL(request.url).pathname}`);
  });
});

beforeEach(() => {
  routerState.pathname = '/blog/scaling-fastapi';
  routerState.query = '';
  threadListRequests = [];
  observedRequests = [];
  lastClick.cancelledBeforeDocument = null;
  vi.clearAllMocks();
  document.addEventListener('click', interceptDocumentNavigation);
  server.use(threadListGuard());
});

/*
 * The no-HTTP guarantee, asserted for EVERY case rather than only for the group named after it.
 *
 * The tree is STILL MOUNTED here, which is worth stating because the opposite is easy to assume.
 * Vitest's `sequence.hooks` defaults to `stack`, so "after" hooks run in REVERSE registration order:
 * `vitest.setup.ts` registers its `cleanup()` first and therefore runs LAST, after this hook.
 * Measured with a probe that read `document.body` from its own `afterEach` and still found the rendered
 * text there.
 *
 * That ordering costs this guarantee nothing. Nothing in the tree issues a request on unmount - React
 * Query cancels in-flight queries when a component goes away rather than starting one - and the cases
 * that turn on the point call {@link settle} while mounted, which is where a request provoked by the
 * render would have appeared.
 *
 * Teardown happens BEFORE the assertions deliberately. An `expect` that throws would otherwise abandon
 * the rest of the hook, leaving this file's runtime override and its document listener in place for
 * every case that followed and turning one real failure into a cascade of unrelated ones.
 */
afterEach(() => {
  document.removeEventListener('click', interceptDocumentNavigation);
  server.resetHandlers();

  expect(threadListRequests).toHaveLength(0);
  expect(observedRequests).toHaveLength(0);
});

afterAll(() => {
  server.close();
});

/* -------------------------------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------------------------------- */

interface RenderOptions {
  /** The envelope to hand over. Defaults to {@link singlePageThread}. */
  readonly page?: Page<CommentPublic>;
  /** The signed-in principal. Pass `null` for a visitor with no session. Defaults to a reader. */
  readonly user?: UserMe | null;
  /** The heading level. Omitted so the component's own default is what renders. */
  readonly headingLevel?: 2 | 3;
  /** Extra utilities for the section. Omitted by every case but the one that tests the seam. */
  readonly className?: string;
}

/**
 * Mount the thread inside the two providers a post page would give it.
 *
 * The REAL {@link QueryProvider} rather than a bespoke client, so this tier's own `defaultOptions`
 * apply - including the retry predicate that refuses to replay a 4xx, which is why the one refusal
 * this file declares is a 404 and why no case uses a 5xx.
 *
 * `headingLevel` and `className` are forwarded only when the caller named them, so "omitted" and
 * "passed as `undefined`" stay distinguishable: the component's default heading level is part of its
 * contract, and a case that passed `headingLevel={undefined}` would be testing the default while
 * appearing to test a level.
 *
 * @param options - See {@link RenderOptions}.
 * @returns The render result.
 */
function renderCommentList(options: RenderOptions = {}): ReturnType<typeof render> {
  const page = options.page ?? singlePageThread;
  const user = options.user === undefined ? readerAccount : options.user;

  /*
   * Named `subject` rather than `item`: the retired surface and its model are required to be provably
   * absent from this tier (AAP §0.9.4.3), and a local called `item` would be the one identifier here
   * that a grep for that surface would turn up.
   */
  const subject: ReactElement =
    options.headingLevel === undefined ? (
      options.className === undefined ? (
        <CommentList page={page} postId={POST_ID} />
      ) : (
        <CommentList className={options.className} page={page} postId={POST_ID} />
      )
    ) : options.className === undefined ? (
      <CommentList headingLevel={options.headingLevel} page={page} postId={POST_ID} />
    ) : (
      <CommentList
        className={options.className}
        headingLevel={options.headingLevel}
        page={page}
        postId={POST_ID}
      />
    );

  return render(
    <QueryProvider>
      <AuthContext.Provider value={session(user)}>{subject}</AuthContext.Provider>
    </QueryProvider>,
  );
}

/* -------------------------------------------------------------------------------------------------
 * Query helpers
 *
 * Every one resolves an element by ROLE, by accessible name, by visible text or by ELEMENT NAME.
 * Nothing here reads a class, selects on one, or measures a computed style.
 * ---------------------------------------------------------------------------------------------- */

/** The heading's accessible name for a given tally, built the way the component builds it. */
function headingName(total: number): string {
  return `${HEADING_LABEL} (${formatCount(total)})`;
}

/**
 * The nearest ancestor matching an element name, or a thrown failure.
 *
 * `closest` is used for exactly three element names - `article`, which each comment is, and the `li`
 * and `ul` the thread is marked up with - because none can be reached from a descendant any other
 * way. All three are ELEMENT selectors; no class appears in any call, and nothing here would notice a
 * token changing.
 *
 * Throwing rather than returning `null` keeps the caller free of a narrowing dance and turns a
 * structural regression into a message that names the element that went missing.
 */
function closestElement(node: HTMLElement, elementName: 'article' | 'li' | 'ul'): HTMLElement {
  const ancestor = node.closest(elementName);

  if (!(ancestor instanceof HTMLElement)) {
    throw new Error(`Expected an ancestor <${elementName}> above the matched node.`);
  }

  return ancestor;
}

/** The `article` a comment's body sits in - that comment's whole subtree, replies included. */
function subtreeOf(body: string): HTMLElement {
  return closestElement(screen.getByText(body), 'article');
}

/** Whether one element renders before another in document order. */
function rendersBefore(first: HTMLElement, second: HTMLElement): boolean {
  const relation = first.compareDocumentPosition(second);

  return (relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/**
 * A link's `href`, parsed so its path and parameters can be asserted individually.
 *
 * A missing `href` throws rather than being coerced: an anchor with no destination is the defect a
 * crawlable page control exists to prevent, and it should fail here rather than parse as the origin.
 */
function destinationOf(link: HTMLElement): URL {
  const href = link.getAttribute('href');

  if (href === null) {
    throw new Error('Expected the link to carry an href.');
  }

  return new URL(href, PARSE_ORIGIN);
}

/**
 * Let React and any scheduled work settle, then let the assertions speak.
 *
 * Wrapped in `act` so a state update a child queued on mount is flushed inside the boundary React
 * expects, which is what keeps the console free of an `act(...)` warning. The await of a resolved
 * promise drains the microtask queue, which is where a query kicked off during commit would place its
 * request - so "no request was made" is a statement about work that had its chance to run rather than
 * about a moment too early to tell.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/* =================================================================================================
 * Cases
 * ============================================================================================== */

describe('CommentList', () => {
  describe('heading and count', () => {
    it('renders its heading at level 2 by default, and never an h1', () => {
      renderCommentList();

      expect(
        screen.getByRole('heading', {
          level: DEFAULT_HEADING_LEVEL,
          name: headingName(singlePageThread.total),
        }),
      ).toBeInTheDocument();

      // The route owns the page's single `h1` (AAP §0.7.3.5). A discussion that minted a second one
      // would corrupt the outline of every page that renders it.
      expect(screen.queryByRole('heading', { level: FORBIDDEN_HEADING_LEVEL })).toBeNull();
    });

    it('renders its heading at level 3 when the consumer has already spent an h2', () => {
      renderCommentList({ headingLevel: NESTED_HEADING_LEVEL });

      expect(
        screen.getByRole('heading', {
          level: NESTED_HEADING_LEVEL,
          name: headingName(singlePageThread.total),
        }),
      ).toBeInTheDocument();

      expect(screen.queryByRole('heading', { level: DEFAULT_HEADING_LEVEL })).toBeNull();
      expect(screen.queryByRole('heading', { level: FORBIDDEN_HEADING_LEVEL })).toBeNull();
    });

    it('counts the roots the service windowed, not every node it rendered', () => {
      renderCommentList();

      // The fixture is four comments with a `total` of two. This pair of assertions is the whole
      // point of that gap: the first says the heading reports the service's thread tally, the second
      // says it did not walk the payload and count replies as well.
      expect(screen.getByRole('heading', { name: headingName(2) })).toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { name: headingName(SINGLE_PAGE_NODE_COUNT) }),
      ).toBeNull();

      // And the nodes really are there, so the case cannot be passing because the replies never
      // rendered in the first place.
      expect(screen.getAllByRole('article')).toHaveLength(SINGLE_PAGE_NODE_COUNT);
    });

    it('reports the unwindowed thread tally rather than the rows on this page', () => {
      renderCommentList({ page: multiPageThread });

      // Two rows on screen, forty-five threads in the collection. `total` ignores the window, which is
      // what a "N comments" label has to read from.
      expect(screen.getByRole('heading', { name: headingName(45) })).toBeInTheDocument();
      expect(screen.getAllByRole('article')).toHaveLength(multiPageThread.items.length);
    });

    it('renders a zero tally as a real count on an empty thread', () => {
      renderCommentList({ page: emptyThread });

      // Zero is a meaningful tally rather than an absence, so it is displayed rather than suppressed.
      expect(
        screen.getByRole('heading', { level: DEFAULT_HEADING_LEVEL, name: headingName(0) }),
      ).toBeInTheDocument();
    });

    it('names the section as a landmark using the heading it already renders', () => {
      renderCommentList();

      // `aria-labelledby` points at the heading's own id, so the landmark's name and the visible text
      // cannot drift apart. An unnamed `section` is not a `region` at all and never reaches a screen
      // reader's landmark list.
      const region = screen.getByRole('region', { name: headingName(singlePageThread.total) });

      expect(within(region).getByText(BODY_ROOT_ONE)).toBeInTheDocument();
    });
  });

  describe('the root comment form', () => {
    it('offers a labelled field for a signed-in reader', () => {
      renderCommentList();

      // The form's internals belong to `comment-form.test.tsx`; what this file owns is that the thread
      // renders the root form at all, in root mode, with a label a screen reader can announce.
      expect(screen.getByRole('textbox', { name: ROOT_FIELD_LABEL })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: ROOT_SUBMIT_LABEL })).toBeInTheDocument();
    });

    it('renders the form before the first comment', () => {
      renderCommentList();

      // The primary action on a discussion is joining it, so a keyboard or screen-reader user reaches
      // the field without traversing however many comment subtrees precede it.
      const field = screen.getByRole('textbox', { name: ROOT_FIELD_LABEL });

      expect(rendersBefore(field, screen.getByText(BODY_ROOT_ONE))).toBe(true);
    });

    it('still offers the form when the thread is empty', () => {
      renderCommentList({ page: emptyThread });

      // The empty panel invites the first comment, so the thing it invites has to be on screen.
      expect(screen.getByRole('textbox', { name: ROOT_FIELD_LABEL })).toBeInTheDocument();
    });
  });

  describe('thread rendering', () => {
    it('renders one list item per envelope row, in the order the envelope gave them', () => {
      renderCommentList();

      // The top-level `ul` reached from a root's body: `p` -> `article` -> `li` -> `ul`. A nested
      // replies list is a DESCENDANT of that path rather than an ancestor, so this cannot resolve to
      // one by accident.
      const threadList = closestElement(screen.getByText(BODY_ROOT_ONE), 'ul');
      const rows = Array.from(threadList.children).filter((child) => child.tagName === 'LI');

      expect(rows).toHaveLength(singlePageThread.items.length);

      expect(rendersBefore(screen.getByText(BODY_ROOT_ONE), screen.getByText(BODY_ROOT_TWO))).toBe(
        true,
      );
    });

    it('marks the thread up as a list, so its length is announced', () => {
      renderCommentList();

      const row = closestElement(screen.getByText(BODY_ROOT_ONE), 'li');

      // The element stays a `ul` and each row a `li`, which is what tells assistive technology how
      // many comments the page holds - information a run of sibling articles cannot convey. The
      // marker is removed through the token engine's own utility rather than by changing the element.
      expect(row).toHaveRole('listitem');
      expect(closestElement(row, 'ul')).toHaveRole('list');
    });

    it('renders each reply inside its own root, from the payload it arrived in', () => {
      renderCommentList();

      const firstRoot = subtreeOf(BODY_ROOT_ONE);
      const secondRoot = subtreeOf(BODY_ROOT_TWO);

      // Both replies travelled nested inside the first root and are rendered by the same component
      // recursing over `CommentPublic.replies`.
      expect(within(firstRoot).getByText(BODY_REPLY_ONE)).toBeInTheDocument();
      expect(within(firstRoot).getByText(BODY_REPLY_TWO)).toBeInTheDocument();

      // And they belong to that root rather than merely to the page, which is the half of the
      // assertion a document-wide `getByText` would not make.
      expect(within(secondRoot).queryByText(BODY_REPLY_ONE)).toBeNull();
      expect(within(secondRoot).queryByText(BODY_REPLY_TWO)).toBeNull();
    });

    it('renders a whole page of replies without a single request', async () => {
      renderCommentList();
      await settle();

      expect(screen.getAllByRole('article')).toHaveLength(SINGLE_PAGE_NODE_COUNT);

      // The positive statement of the layering: one response carried the whole page of the discussion,
      // however deep it went, and the component that renders it fetches nothing per node. A per-node
      // fetch would also break the disjointness of consecutive top-level pages.
      expect(threadListRequests).toHaveLength(0);
      expect(observedRequests).toHaveLength(0);
    });

    it('renders the rows of a later page as the envelope gave them', () => {
      renderCommentList({ page: multiPageThread });

      expect(screen.getByText(BODY_LATER_ONE)).toBeInTheDocument();
      expect(screen.getByText(BODY_LATER_TWO)).toBeInTheDocument();

      // Page two holds none of page one's rows. Roots are windowed, so the pages stay disjoint.
      expect(screen.queryByText(BODY_ROOT_ONE)).toBeNull();
      expect(screen.queryByText(BODY_REPLY_ONE)).toBeNull();
    });
  });

  describe('moderation', () => {
    it('renders a comment it is handed whatever its status, and offers no moderation control', () => {
      renderCommentList({ page: moderatedThread });

      // Only approved comments reach a public caller, and that filter is the API's - composed once in
      // `backend/app/repositories/comment_repository.py`, verified by the backend suite and by
      // `frontend/tests/e2e/comments-likes.spec.ts`. This tier re-filtering would be a second answer
      // to a question the query already settled, and could only ever disagree with it.
      expect(screen.getByText(BODY_PENDING)).toBeInTheDocument();
      expect(screen.getByText(PENDING_BADGE_LABEL)).toBeInTheDocument();

      // Read-only, though: a status moves through the administrative route alone, and this surface
      // offers no control that would pretend otherwise.
      expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /reject/i })).toBeNull();
    });
  });

  describe('empty state', () => {
    it('invites the first comment', () => {
      renderCommentList({ page: emptyThread });

      expect(screen.getByText(EMPTY_TITLE)).toBeInTheDocument();
      expect(screen.getByText(EMPTY_DESCRIPTION)).toBeInTheDocument();

      // The copy says there are none YET rather than that nobody has commented, because a thread with
      // comments in the moderation queue is empty for a public reader and this tier cannot tell the
      // two apart.
      expect(screen.queryByText(BODY_ROOT_ONE)).toBeNull();
      expect(screen.queryByRole('article')).toBeNull();
    });

    it('announces nothing, because an empty thread is content rather than an outcome', () => {
      renderCommentList({ page: emptyThread });

      // Anchored on the panel being present, so the two negatives below are statements about what it
      // announces rather than about a panel that failed to render.
      expect(screen.getByText(EMPTY_TITLE)).toBeInTheDocument();

      // `@/components/ui/alert` derives the live-region role from the variant, and its table maps
      // `empty` to no role at all. A panel present in the server's first HTML must not interrupt a
      // reader on arrival - and it certainly must not be shouted, which is what `alert` would do. The
      // call site authors no `role`, `aria-live` or `aria-atomic` in either direction.
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('adds no second heading inside the empty panel', () => {
      renderCommentList({ page: emptyThread });

      // The section already has its heading, and a second one would put two headings in a region that
      // describes one thing. `post-list.tsx` makes the opposite choice because it owns no heading.
      expect(screen.getAllByRole('heading')).toHaveLength(1);
    });
  });

  describe('pagination', () => {
    it('renders the page control when the thread spans more than one page', () => {
      renderCommentList({ page: multiPageThread });

      const control = screen.getByRole('navigation', { name: PAGINATION_LABEL });

      // Anchors, not buttons: a page of a discussion has its own address, so it is linkable,
      // shareable and crawlable. Every link the control renders carries a destination.
      const links = within(control).getAllByRole('link');

      expect(links.length).toBeGreaterThan(0);

      for (const link of links) {
        expect(link).toHaveAttribute('href');
      }
    });

    it('renders no page control for a single-page thread', () => {
      renderCommentList();

      // Gated on the envelope's own `pages`, which keeps a client island out of the tree entirely for
      // the overwhelmingly common single-page thread rather than mounting one that renders nothing.
      expect(screen.queryByRole('navigation', { name: PAGINATION_LABEL })).toBeNull();
    });

    it('renders no page control for an empty thread', () => {
      renderCommentList({ page: emptyThread });

      expect(screen.queryByRole('navigation')).toBeNull();
    });

    it('marks the page the envelope reports as the current one', () => {
      renderCommentList({ page: multiPageThread });

      const control = screen.getByRole('navigation', { name: PAGINATION_LABEL });
      const current = within(control).getByRole('link', { name: `Page ${multiPageThread.page}` });

      // The envelope's page wins over the URL's, because it is the page the rendered rows belong to.
      // `aria-current` is the non-visual half of the distinction: colour alone cannot carry it.
      expect(current).toHaveAttribute('aria-current', 'page');
    });

    it('builds its links from the URL the reader is on, keeping the envelope as the current page', () => {
      // A shared link can carry a stale page number and parameters of its own. Both matter, and they
      // pull in opposite directions, which is why they are asserted together.
      routerState.query = `${PAGE_PARAM}=99&${REFERRAL_PARAM}=${REFERRAL_VALUE}`;

      renderCommentList({ page: multiPageThread });

      const control = screen.getByRole('navigation', { name: PAGINATION_LABEL });

      // The rows on screen came from the envelope, so the envelope's page is the one marked current.
      // A control that trusted the URL would be describing a window nobody is looking at.
      expect(
        within(control).getByRole('link', { name: `Page ${multiPageThread.page}` }),
      ).toHaveAttribute('aria-current', 'page');

      const third = destinationOf(within(control).getByRole('link', { name: 'Page 3' }));

      // The stale page is replaced rather than carried forward...
      expect(third.searchParams.get(PAGE_PARAM)).toBe('3');
      // ...while every sibling parameter survives, because `comment-list.tsx` passes no `hrefForPage`
      // override and lets the control derive each URL from the address the reader actually has. An
      // override built here would have to re-derive the query string and would drop whatever it had
      // not been told about.
      expect(third.searchParams.get(REFERRAL_PARAM)).toBe(REFERRAL_VALUE);
    });

    it('addresses the remaining pages through the page query parameter', () => {
      renderCommentList({ page: multiPageThread });

      const control = screen.getByRole('navigation', { name: PAGINATION_LABEL });
      const third = destinationOf(within(control).getByRole('link', { name: 'Page 3' }));

      expect(third.pathname).toBe(routerState.pathname);
      expect(third.searchParams.get(PAGE_PARAM)).toBe('3');

      // Page one is the bare path. Emitting `page=1` would give it a second URL and contradict the
      // canonical-URL guarantee the SEO work rests on.
      const first = destinationOf(within(control).getByRole('link', { name: 'Page 1' }));

      expect(first.pathname).toBe(routerState.pathname);
      expect(first.searchParams.has(PAGE_PARAM)).toBe(false);
    });

    it('leaves the navigation to the anchor and issues nothing of its own', async () => {
      renderCommentList({ page: multiPageThread });

      const control = screen.getByRole('navigation', { name: PAGINATION_LABEL });
      const third = within(control).getByRole('link', { name: 'Page 3' });

      fireEvent.click(third);
      await settle();

      // Nothing in the tree cancelled the event, so the browser would follow the link - which is the
      // whole reason the control is an anchor rather than a button.
      expect(lastClick.cancelledBeforeDocument).toBe(false);

      // And no imperative transition happened alongside it. `comment-list.tsx` passes no
      // `onPageChange`, deliberately: a callback that navigated would fire a second transition for one
      // click, leaving two history entries and a back button that appears dead.
      for (const spy of Object.values(routerSpies)) {
        expect(spy).not.toHaveBeenCalled();
      }

      // Turning the page is the consuming route's fetch, not this component's.
      expect(threadListRequests).toHaveLength(0);
    });
  });

  describe('performs no HTTP', () => {
    it('requests nothing for a thread it was handed', async () => {
      renderCommentList();
      await settle();

      // The envelope arrives as a prop from the Server Component that fetched it through
      // `@/lib/api/comments`. This component reads it and renders; `src/lib/api/client.ts` is the only
      // module in this tier permitted to perform HTTP, and none of it runs here.
      expect(threadListRequests).toHaveLength(0);
      expect(observedRequests).toHaveLength(0);
    });

    it('requests nothing for an empty thread', async () => {
      renderCommentList({ page: emptyThread });
      await settle();

      // An empty page is not a cue to go looking for rows somewhere else.
      expect(screen.getByText(EMPTY_TITLE)).toBeInTheDocument();
      expect(threadListRequests).toHaveLength(0);
      expect(observedRequests).toHaveLength(0);
    });

    it('requests nothing for a later page, and does not refetch the window it was given', async () => {
      renderCommentList({ page: multiPageThread });
      await settle();

      expect(screen.getByRole('navigation', { name: PAGINATION_LABEL })).toBeInTheDocument();
      expect(threadListRequests).toHaveLength(0);
      expect(observedRequests).toHaveLength(0);
    });
  });

  describe('props and principal', () => {
    it('accepts extra utilities for the section without changing what it renders', () => {
      renderCommentList({ className: 'mt-12' });

      // The seam exists for the consuming layout's concerns - the space between the article and the
      // discussion. What is asserted is that the thread still renders, never the class itself: every
      // value in the component resolves to a token and is free to change.
      expect(
        screen.getByRole('region', { name: headingName(singlePageThread.total) }),
      ).toBeInTheDocument();
      expect(screen.getByText(BODY_ROOT_ONE)).toBeInTheDocument();
      expect(screen.getByText(BODY_ROOT_TWO)).toBeInTheDocument();
    });

    it('shows the whole discussion to a visitor with no session', () => {
      renderCommentList({ user: null });

      // Comments are public, so every body and every reply still renders.
      expect(screen.getByText(BODY_ROOT_ONE)).toBeInTheDocument();
      expect(screen.getByText(BODY_ROOT_TWO)).toBeInTheDocument();
      expect(within(subtreeOf(BODY_ROOT_ONE)).getByText(BODY_REPLY_ONE)).toBeInTheDocument();
      expect(
        screen.getByRole('heading', {
          level: DEFAULT_HEADING_LEVEL,
          name: headingName(singlePageThread.total),
        }),
      ).toBeInTheDocument();
    });

    it('replaces the field with a sign-in prompt that comes back to the discussion', () => {
      renderCommentList({ user: null });

      // A prompt rather than a field that would only earn a 401 on submit. `CommentForm` resolves the
      // principal itself - `CommentList` passes no `user` and makes no authority decision, because a
      // second check here could only ever disagree with the service's.
      expect(screen.queryByRole('textbox', { name: ROOT_FIELD_LABEL })).toBeNull();
      expect(screen.getByText(ANONYMOUS_TITLE)).toBeInTheDocument();

      const returnTrip = destinationOf(screen.getByRole('link', { name: ANONYMOUS_LINK_LABEL }));

      expect(returnTrip.pathname).toBe(LOGIN_PATH);
      expect(returnTrip.searchParams.get(RETURN_TO_PARAM)).toBe(routerState.pathname);
    });
  });
});
