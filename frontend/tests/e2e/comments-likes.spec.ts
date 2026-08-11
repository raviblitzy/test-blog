/**
 * Comments, likes and sharing - the end-to-end journey for AAP requirement R4, plus the
 * moderation-visibility half of the implicit "comment moderation states" prerequisite.
 *
 * This is one of the six specs `frontend/playwright.config.ts` collects from `./tests/e2e`
 * (`testMatch: '**\/*.spec.ts'`), and every test here runs three times - once per viewport
 * project (mobile 375, tablet 768, desktop 1440) - for three of the eighteen project-spec
 * combinations AAP §0.9.4.6 requires green. Nothing in this file branches on width: the
 * comment, like and share behaviours are width-independent, and the responsive proof
 * (collapsed navigation, one/two/three-column feed, stacked admin tables) belongs to
 * `home-feed.spec.ts` and `admin.spec.ts`.
 *
 * WHICH CRITERIA THIS FILE DISCHARGES (AAP §0.9.4.4 and §0.9.4.5)
 *
 *   - "Comments - An authenticated user can comment and reply; a non-owner cannot edit
 *     another's comment; deleting a parent removes its replies; only approved comments are
 *     visible publicly."
 *   - "Likes are idempotent - Two consecutive `PUT /api/v1/posts/{id}/like` calls leave the
 *     count at 1."
 *   - Sharing is client-side only: `share-bar.tsx` builds every affordance from the post's
 *     canonical URL and calls no backend endpoint.
 *
 * GOVERNING STANDARDS - `review_rules` reports that **NO user-specified rules exist for this
 * project**, so no user rule governs this file and none is invented. AAP §0.10.1's
 * self-imposed enterprise standards are binding instead, and five of them bind here:
 *
 *   1. "Blocking quality gates". Every test below passes in all three viewport projects. Not one
 *      of them is marked exclusive, disabled or expected-to-fail, neither individually nor at
 *      the group level; no assertion is switched off conditionally; no `try`/`catch` swallows a
 *      failure; and no soft assertion stands in for a real one. `forbidOnly` is on in CI, so an
 *      exclusive marker committed here would fail the build rather than quietly shrink the gate.
 *   2. "Accessibility as a floor". The comment field is reached through `getByLabel`, which
 *      only resolves because `comment-form.tsx` associates its `<Label htmlFor>` with the
 *      textarea; one comment submission is driven entirely from the keyboard, including
 *      tabbing to the submit control and activating it with Enter; and the delete
 *      confirmation is proven dismissible with Escape. Exhaustive modal focus-trap coverage
 *      is `home-feed.spec.ts`'s and `admin.spec.ts`'s, not duplicated here.
 *   3. Behaviour over implementation (§0.8.5, §0.7.2). Every locator is a role, an accessible
 *      name, a label or visible text. Not one CSS class is selected on, and not one class list
 *      is asserted against, anywhere in this file: moderation state is read from the badge's
 *      visible words and reply nesting from DOM containment (`role=article` inside
 *      `role=article`), never from an indentation utility. The only attribute assertions are on
 *      semantic anchor attributes (`href`, `target`, `rel`) and on ARIA state (`aria-pressed`),
 *      which are part of the contract rather than of the styling.
 *   4. "Pinned, reproducible dependencies". The single import is `@playwright/test`, pinned at
 *      1.62.1 in `frontend/package.json`. No faker (unique text comes from `Date.now()`, a
 *      module counter and `Math.random()`), no page-object framework, no assertion library.
 *   5. "No secrets in the repository". Every account is registered at run time with a unique
 *      identity - email and username are `citext UNIQUE`, and the three projects run
 *      concurrently against one database, so a fixed literal would collide and answer 409 -
 *      and its password is synthesised from that same unique token. The seeded administrator,
 *      needed only as setup for the moderation-visibility assertion, is read from
 *      `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`. Nothing is written into the working tree;
 *      Playwright's own report directories are already gitignored.
 *
 * ============================================================================================
 * THE ONE MEASURED CONSTRAINT THAT SHAPES EVERY TEST BELOW - READ THIS BEFORE EDITING
 * ============================================================================================
 *
 * `blog/[slug]/page.tsx` is a server component that reads through the framework's Data Cache:
 * `getPost(slug, { next: { revalidate: 300 } })`, `listComments(post.id, { page }, { next: {
 * revalidate: 60 } })` and `getLikes(post.id, { next: { revalidate: 60 } })`. Nothing in
 * `frontend/src` reads request cookies, so those three reads are always **anonymous** - which
 * is why a server-rendered thread shows approved comments only and always reports
 * `liked_by_caller: false`. `CommentList` is a server component handed a `page` prop, and the
 * client pieces only call `invalidateQueries`, which cannot re-render it; `like-button.tsx`
 * seeds `useQuery` with `initialData` while `QueryProvider` sets `staleTime: 60_000`, so it
 * does not refetch on mount either.
 *
 * Measured directly against a production build of this checkout: after approving a comment,
 * a **second** request for the same `/blog/{slug}` still rendered "No comments yet"; after two
 * likes, a later request still rendered no count. So:
 *
 *   >>> ONE URL YIELDS EXACTLY ONE LIVE, CACHE-COLD THREAD RENDER. <<<
 *
 * Two consequences, and both are deliberate design here rather than a workaround:
 *
 *   (a) Server state is established through the API **before** the first navigation to a URL,
 *       so the render that matters observes live data. A test that mutated first and then
 *       reloaded expecting to see the change would pass or fail on where it happened to fall
 *       inside a 60-second window - the definition of a flaky gate, which standard 1 forbids.
 *   (b) When a test needs a *second* live reading of server state through a full page
 *       navigation, it navigates to `/blog/{slug}?page=N` with N >= 2. That is a genuinely
 *       different comments-fetch URL (`?page=N`), so it is always cache-cold, and the thread
 *       heading it renders - "Comments (N)" - is `page.total`, the **live** count of root
 *       comments visible to an anonymous reader. Measured: the same post read "Comments (2)",
 *       then "Comments (1)" after a delete cascade, then "Comments (0)" after a rejection.
 *       That is a real page load, served by the real server, with no sleep and no retry.
 *
 * No fixed-duration wait appears anywhere in this file, and no assertion is propped up by a
 * retry. Every wait is a web-first, auto-retrying `expect`.
 *
 * WHAT THIS FILE DOES NOT TOUCH
 *
 *   - The retired demonstration resource this project supersedes, and the check that proves its
 *     paths are absent from the generated OpenAPI document. That belongs to
 *     `backend/tests/integration/test_openapi_contract.py` (AAP §0.9.4.3), and neither the
 *     retired resource's paths nor its fields are named anywhere here. (A server-generated UUID
 *     `id` is a legitimate blog-domain field and is used throughout.)
 *   - The administrative dashboard's own screens, controls and moderation queue: that is
 *     `admin.spec.ts`. The seeded administrator is used here only through the API, and only
 *     as the setup that makes a comment publicly visible or withdraws it.
 *   - Console output. Nothing installs a console filter or swallows a page error, because
 *     `theme.spec.ts` asserts the absence of hydration warnings and depends on the console
 *     being intact.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from '@playwright/test';

/* ============================================================================================
 * Configuration read from the environment - never from a hard-coded literal
 * ==========================================================================================*/

/** Base URL of the API the pages under test call. `.env.example` documents it. */
const API_BASE_URL_KEY = 'NEXT_PUBLIC_API_BASE_URL';

/** Canonical site origin. Every share URL and canonical link is built from it. */
const SITE_URL_KEY = 'NEXT_PUBLIC_SITE_URL';

/** Seeded administrator identity. Setup only, for the moderation-visibility assertion. */
const ADMIN_EMAIL_KEY = 'SEED_ADMIN_EMAIL';
const ADMIN_PASSWORD_KEY = 'SEED_ADMIN_PASSWORD';

/** The version prefix `client.ts` composes onto every namespace-relative path. */
const API_VERSION_PREFIX = '/api/v1';

/* ============================================================================================
 * Contract constants - HTTP statuses, paths and the accessible names the components publish
 * ==========================================================================================*/

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

const LOGIN_PATH = '/login';
const RETURN_TO_PARAM = 'next';
const POST_PATH_PREFIX = '/blog';

/** Sign-in form, from `(auth)/login/page.tsx`. */
const EMAIL_LABEL = 'Email address';
const PASSWORD_LABEL = 'Password';
const SIGN_IN_SUBMIT = 'Sign in';

/** Comment form copy, from `comment-form.tsx`. */
const ROOT_COMMENT_LABEL = 'Add a comment';
const ROOT_COMMENT_SUBMIT = 'Post comment';
const REPLY_LABEL = 'Write a reply';
const REPLY_SUBMIT = 'Post reply';
const EDIT_LABEL = 'Edit your comment';
const EDIT_SUBMIT = 'Save changes';
const HELD_FOR_APPROVAL_TITLE = 'Waiting for approval';
const ANONYMOUS_FORM_TITLE = 'Sign in to join the discussion';
const ANONYMOUS_FORM_LINK = 'Sign in to comment';
const COMMENT_HELD_TOAST = 'Your comment was received and is waiting for approval.';
const REPLY_HELD_TOAST = 'Your reply was received and is waiting for approval.';
const EDIT_HELD_TOAST = 'Your comment was updated and is waiting for approval again.';

/**
 * The body of the root form's "Waiting for approval" alert, matched as a substring.
 *
 * Only the root form's is needed: a reply form and an edit form close themselves on success and
 * take their own alert with them, so the toast is what a reader is left with there. Matching on
 * the shared title rather than this mode-specific line would also be wrong, because a root form
 * and an open reply form can each be showing their own acknowledgement at the same time.
 */
const COMMENT_HELD_DETAIL = 'before it joins the discussion';

/** Comment item copy, from `comment-item.tsx`. */
const SIGN_IN_TO_REPLY = 'Sign in to reply';
const DELETE_DIALOG_TITLE = 'Delete this comment?';
const DELETE_CONFIRM = 'Delete comment';
const DELETE_SUCCESS_TOAST = 'Comment deleted.';
const DELETE_CASCADE_TOAST = 'Every reply beneath it was removed with it.';
const PENDING_BADGE = 'Awaiting approval';
const REJECTED_BADGE = 'Not approved';

/** Comment list copy, from `comment-list.tsx`. */
const THREAD_REGION_NAME = /^Comments\b/;
const EMPTY_THREAD_TITLE = 'No comments yet';

/** Share bar copy, from `share-bar.tsx`. */
const SHARE_REGION_NAME = 'Share this post';
const COPY_LINK = 'Copy link';
const NATIVE_SHARE_NAME = 'Share using your device';
const COPY_SUCCEEDED_TOAST = 'Link copied to your clipboard.';
const COPY_UNAVAILABLE_TOAST = 'Copying is not available in this browser.';
const MANUAL_COPY_PREAMBLE = 'Copy this link manually:';

/**
 * The three outbound share targets, exactly as `share-bar.tsx` declares them: an accessible
 * name, and the query member each one carries the canonical URL in.
 */
const SHARE_TARGETS: readonly { readonly name: string; readonly urlParam: string }[] = [
  { name: 'Share on X (opens in a new tab)', urlParam: 'url' },
  { name: 'Share on Facebook (opens in a new tab)', urlParam: 'u' },
  { name: 'Share on LinkedIn (opens in a new tab)', urlParam: 'url' },
];

/**
 * Hosts the outbound share anchors navigate to. Activating an anchor is part of exercising
 * every share affordance, so each host is answered from inside the browser context with a
 * stub: the gate must not depend on reaching a third party, and a real navigation would make
 * the assertion about someone else's uptime.
 */
const EXTERNAL_SHARE_HOSTS = /^https:\/\/(twitter\.com|www\.facebook\.com|www\.linkedin\.com)\//;

/* ============================================================================================
 * Wire types - declared here because `@/lib/types` is not a dependency of this file and the
 * only import permitted is `@playwright/test`. They mirror the API's response models.
 * ==========================================================================================*/

type CommentStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

interface WireUser {
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
}

interface WirePost {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
}

interface WireComment {
  readonly id: string;
  readonly post_id: string;
  readonly parent_id: string | null;
  readonly author: WireUser;
  readonly body: string;
  readonly status: CommentStatus;
  readonly created_at: string;
  readonly updated_at: string;
  readonly reply_count: number;
  readonly has_more_replies: boolean;
  readonly replies: readonly WireComment[];
}

/** The uniform collection envelope every list endpoint returns (AAP §0.6.2). */
interface WirePage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly page_size: number;
  readonly pages: number;
}

/** The one shape `PUT`, `DELETE` and `GET` on the like resource all answer with. */
interface WireLikeSummary {
  readonly post_id: string;
  readonly like_count: number;
  readonly liked_by_caller: boolean;
}

/** The single machine-readable error contract (AAP §0.6.2). */
interface WireProblem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly request_id: string;
}

interface WireTokenPair {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly token_type: string;
  readonly expires_in: number;
}

/** A throwaway account this run created, with the bearer token it signs API calls with. */
interface Account {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly displayName: string;
  readonly password: string;
  readonly bearer: string;
}

/* ============================================================================================
 * Environment resolution - fails closed, and never echoes a value
 * ==========================================================================================*/

/**
 * Read a required environment key, or stop the run with a message naming the key and the fix.
 *
 * No message quotes the value. Two of these keys carry a credential, and Playwright reproduces
 * an assertion message in its terminal output, its HTML report and its trace.
 */
function requiredEnv(key: string, purpose: string): string {
  const raw = process.env[key]?.trim();
  if (raw === undefined || raw === '') {
    throw new Error(
      `${key} is not set, and it has no default. ${purpose} Export it before running the ` +
        `end-to-end gate; .env.example documents every variable this project reads.`,
    );
  }
  return raw;
}

/**
 * Origin-and-prefix base for direct API calls, composed the way `src/lib/api/client.ts`
 * composes it: trailing slashes trimmed, and `/api/v1` appended unless the value already
 * carries it. The declared value includes the prefix, so appending twice must not happen.
 */
function apiBaseUrl(): string {
  const configured = requiredEnv(
    API_BASE_URL_KEY,
    'It names the API this spec provisions its fixtures through and asserts the server-side ' +
      'refusals against.',
  ).replace(/\/+$/, '');
  return configured.endsWith(API_VERSION_PREFIX)
    ? configured
    : `${configured}${API_VERSION_PREFIX}`;
}

/** Bare origin of the API, used to scope the "no backend endpoint was called" observer. */
function apiOrigin(): string {
  return new URL(apiBaseUrl()).origin;
}

/**
 * The canonical site origin, normalised exactly as `lib/seo.ts` normalises it: `URL.origin`
 * lower-cases the scheme and host, drops a default port and removes any trailing slash. That
 * normalisation is what makes the canonical URL this spec expects byte-identical to the one
 * `absoluteUrl(postPath(slug))` produces inside the application.
 */
function siteOrigin(): string {
  return new URL(
    requiredEnv(
      SITE_URL_KEY,
      'Every canonical link, share URL and sitemap entry is built from it, so the share ' +
        'assertions have nothing to compare against without it.',
    ),
  ).origin;
}

/** The canonical absolute URL of a post, as `share-bar.tsx` builds it. */
function canonicalPostUrl(slug: string): string {
  return `${siteOrigin()}${postPath(slug)}`;
}

/** Root-relative path of a post's public page. */
function postPath(slug: string): string {
  return `${POST_PATH_PREFIX}/${encodeURIComponent(slug)}`;
}

/* ============================================================================================
 * Unique-identity generation - parallel-safe by construction
 * ==========================================================================================*/

/**
 * Monotonic within a worker; combined with the clock and a random suffix it is unique across
 * workers, across the three viewport projects that run concurrently against one database, and
 * across earlier runs whose rows are still there.
 */
let identitySequence = 0;

const TOKEN_RADIX = 36;
const RANDOM_SUFFIX_START = 2;
const RANDOM_SUFFIX_END = 8;

/**
 * A short, lower-case alphanumeric token. Alphanumeric matters: the API constrains a username
 * to `^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$` at 3 to 30 characters, and a token built
 * from base-36 digits satisfies both ends of that pattern with no sanitising step.
 */
function uniqueToken(): string {
  identitySequence += 1;
  const clock = Date.now().toString(TOKEN_RADIX);
  const counter = identitySequence.toString(TOKEN_RADIX);
  const random = Math.random().toString(TOKEN_RADIX).slice(RANDOM_SUFFIX_START, RANDOM_SUFFIX_END);
  return `${clock}${counter}${random}`;
}

/** Prefix that makes a row's provenance obvious to anyone reading the database. */
const IDENTITY_PREFIX = 'e2ecl';

/** Domain reserved for documentation examples; the API's own schema examples use it. */
const IDENTITY_EMAIL_DOMAIN = 'example.com';

/**
 * Stem of every throwaway password. Not a credential: the usable value is this stem joined to
 * the account's own unique token, minted in this process, for an account created seconds
 * earlier and never referenced again. It satisfies the API's policy - at least 12 characters
 * drawn from at least three of five character classes - by construction.
 */
const THROWAWAY_PASSWORD_STEM = 'E2E-Throwaway-Only';

/* ============================================================================================
 * API helpers - Playwright's own `APIRequestContext`, so no dependency is added
 * ==========================================================================================*/

/** Decode a JSON body. `APIResponse.json()` is untyped, so the shape is named at the call. */
async function readJson<T>(response: APIResponse): Promise<T> {
  return (await response.json()) as T;
}

/** `Authorization` header for a bearer token. */
function bearerHeaders(bearer: string): Record<string, string> {
  return { Authorization: `Bearer ${bearer}` };
}

/**
 * Sign in through the API's password grant. The route is form-encoded and takes the email
 * address in the grant's `username` member - the one form-encoded route in the whole API.
 */
async function requestTokens(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<WireTokenPair> {
  const response = await request.post(`${apiBaseUrl()}/auth/login`, {
    form: { username: email, password },
  });
  expect(response.status(), 'signing in through the API should answer 200').toBe(HTTP_OK);
  return readJson<WireTokenPair>(response);
}

/**
 * Register a throwaway account and return it with a bearer token.
 *
 * `role` is a one-character label that keeps the generated identities legible when two
 * accounts appear in one thread ('c' commenter, 'o' owner, 'b' bystander). The display name is
 * unique too, because `comment-item.tsx` builds its `Reply to …` / `Edit comment by …` /
 * `Delete comment by …` accessible names from it - two accounts sharing a display name would
 * make those names ambiguous and the locators strict-mode violations.
 */
async function registerAccount(request: APIRequestContext, role: string): Promise<Account> {
  const token = uniqueToken();
  const username = `${IDENTITY_PREFIX}${role}${token}`;
  const email = `${username}@${IDENTITY_EMAIL_DOMAIN}`;
  const password = `${THROWAWAY_PASSWORD_STEM}-${token}`;
  const displayName = `Reader ${token}`;

  const created = await request.post(`${apiBaseUrl()}/auth/register`, {
    data: { email, username, password, display_name: displayName },
  });
  expect(created.status(), `registering ${username} should answer 201`).toBe(HTTP_CREATED);
  const account = await readJson<WireUser>(created);

  const tokens = await requestTokens(request, email, password);
  return {
    id: account.id,
    email,
    username,
    displayName,
    password,
    bearer: tokens.access_token,
  };
}

/**
 * Bearer token for the seeded administrator, memoised for the worker.
 *
 * Memoising a token is not shared test state: every test still provisions its own post,
 * accounts and comments, and a test run on its own simply fills the memo on first use. What it
 * avoids is re-signing-in as the same administrator once per test - and `GET /api/v1/auth/me`
 * and `POST /api/v1/auth/login` both carry the authentication rate limit, so an end-to-end
 * suite that spends credential attempts it does not need is a suite that eventually answers
 * 429 for reasons that have nothing to do with the behaviour under test.
 */
let memoisedAdminBearer: string | null = null;

async function adminBearer(request: APIRequestContext): Promise<string> {
  if (memoisedAdminBearer !== null) {
    return memoisedAdminBearer;
  }
  const email = requiredEnv(
    ADMIN_EMAIL_KEY,
    'The moderation-visibility assertion needs an administrator to approve a comment with, ' +
      'and the seeded administrator is the only one this project defines.',
  );
  const password = requiredEnv(
    ADMIN_PASSWORD_KEY,
    'It is the seeded administrator credential; the suite never hard-codes one.',
  );
  const tokens = await requestTokens(request, email, password);
  memoisedAdminBearer = tokens.access_token;
  return memoisedAdminBearer;
}

/**
 * Create a post and publish it, so it is readable at `/blog/{slug}` by anyone.
 *
 * Every test creates its own. Reusing seeded demonstration content would make an assertion
 * about comment or like counts depend on what earlier runs and sibling projects had done to
 * that row, and AAP §0.9.4.4 requires a *published* post for a comment to exist under: a draft
 * answers 404 to a public reader, so its page would never render.
 *
 * `title` deliberately carries a unique token, because the service derives the slug from the
 * title and constrains it UNIQUE - a shared title would collide across concurrent projects.
 */
async function publishPost(
  request: APIRequestContext,
  author: Account,
  subject: string,
): Promise<WirePost> {
  const created = await request.post(`${apiBaseUrl()}/posts`, {
    headers: bearerHeaders(author.bearer),
    data: {
      title: `Comments and likes ${subject} ${uniqueToken()}`,
      excerpt: 'Fixture post created by the comments, likes and sharing end-to-end journey.',
      content:
        '## Fixture\n\nThis post exists so the comment thread, the like control and the share ' +
        'affordances have something real to act on.',
    },
  });
  expect(created.status(), 'creating a post should answer 201').toBe(HTTP_CREATED);
  const draft = await readJson<WirePost>(created);
  expect(draft.status, 'a newly created post starts as a draft').toBe('DRAFT');

  const published = await request.post(`${apiBaseUrl()}/posts/${draft.id}/publish`, {
    headers: bearerHeaders(author.bearer),
  });
  expect(published.status(), 'publishing should answer 200').toBe(HTTP_OK);
  const live = await readJson<WirePost>(published);
  expect(live.status, 'publishing transitions the post to PUBLISHED').toBe('PUBLISHED');
  return live;
}

/**
 * Add a comment, or a reply when `parentId` is given.
 *
 * The body carries neither `post_id` (the path supplies it) nor `status` (the server owns it),
 * and the response is asserted to come back PENDING: AAP §0.9.4.4 turns on new comments being
 * held for moderation, and a change to that default has to break a test rather than silently
 * weaken one.
 *
 * A caller may only reply to a comment they can see - measured: replying to somebody else's
 * PENDING comment answers 422 naming `parent_id` - so a fixture that has one account reply to
 * another's comment must approve the parent first.
 */
async function addComment(
  request: APIRequestContext,
  author: Account,
  postId: string,
  body: string,
  parentId?: string,
): Promise<WireComment> {
  const payload = parentId === undefined ? { body } : { body, parent_id: parentId };
  const response = await request.post(`${apiBaseUrl()}/posts/${postId}/comments`, {
    headers: bearerHeaders(author.bearer),
    data: payload,
  });
  expect(response.status(), 'adding a comment should answer 201').toBe(HTTP_CREATED);
  const comment = await readJson<WireComment>(response);
  expect(comment.status, 'a new comment is created awaiting moderation').toBe('PENDING');
  expect(comment.body, 'the stored body is the body that was sent').toBe(body);
  expect(comment.parent_id, 'parent_id is what makes a comment a reply').toBe(parentId ?? null);
  return comment;
}

/**
 * Move a comment to a moderation state through the administrative namespace - the only route
 * in the API that changes one. Setup for the visibility assertions; the moderation queue and
 * its controls are `admin.spec.ts`'s subject.
 */
async function setCommentStatus(
  request: APIRequestContext,
  admin: string,
  commentId: string,
  status: CommentStatus,
): Promise<void> {
  const response = await request.patch(`${apiBaseUrl()}/admin/comments/${commentId}/status`, {
    headers: bearerHeaders(admin),
    data: { status },
  });
  expect(response.status(), `moving a comment to ${status} should answer 200`).toBe(HTTP_OK);
  const moderated = await readJson<WireComment>(response);
  expect(moderated.status, 'the response reports the state the comment was moved to').toBe(status);
}

/**
 * Read one page of a post's thread. Omit `bearer` to read it exactly as an anonymous visitor -
 * and therefore exactly as the server renders it - which is the authoritative, uncached view of
 * what the public may see.
 */
async function readThread(
  request: APIRequestContext,
  postId: string,
  bearer?: string,
): Promise<WirePage<WireComment>> {
  const response = await request.get(`${apiBaseUrl()}/posts/${postId}/comments`, {
    headers: bearer === undefined ? {} : bearerHeaders(bearer),
  });
  expect(response.status(), 'reading a thread should answer 200').toBe(HTTP_OK);
  return readJson<WirePage<WireComment>>(response);
}

/** The root comment at `index`, with a message that says what was actually there instead. */
function rootAt(thread: WirePage<WireComment>, index: number): WireComment {
  const root = thread.items[index];
  if (root === undefined) {
    throw new Error(
      `the thread carried ${String(thread.items.length)} root comments, so there is no root at ` +
        `index ${String(index)}`,
    );
  }
  return root;
}

/** The root comment carrying `id`, with a message that lists what was there instead. */
function rootWithId(thread: WirePage<WireComment>, id: string): WireComment {
  const root = thread.items.find((item) => item.id === id);
  if (root === undefined) {
    throw new Error(
      `no root comment on this page carries id ${id}; the page carried ` +
        `${thread.items.map((item) => item.id).join(', ')}`,
    );
  }
  return root;
}

/** Bodies of the comments on a thread page, roots and their nested replies alike. */
function bodiesOf(comments: readonly WireComment[]): string[] {
  return comments.flatMap((comment) => [comment.body, ...bodiesOf(comment.replies)]);
}

/** Find a comment anywhere in a thread by the exact body it carries. */
function commentWithBody(comments: readonly WireComment[], body: string): WireComment {
  for (const comment of comments) {
    if (comment.body === body) {
      return comment;
    }
    const nested = comment.replies.find((reply) => reply.body === body);
    if (nested !== undefined) {
      return nested;
    }
    const deeper = comment.replies.flatMap((reply) => reply.replies);
    if (deeper.length > 0 && bodiesOf(deeper).includes(body)) {
      return commentWithBody(deeper, body);
    }
  }
  throw new Error(
    `no comment in this thread carries the body ${JSON.stringify(body)}; the thread carried ` +
      `${JSON.stringify(bodiesOf(comments))}`,
  );
}

/**
 * Assert a comment row is gone, at the row level rather than by its absence from a list.
 *
 * `PATCH /api/v1/comments/{id}` addressed by the comment's own author answers 404 only when no
 * comment carries that identifier - the route reports a missing comment before it considers
 * authority - so this is the server itself stating the row does not exist. Absence from a
 * listing would be weaker: a moderation filter can also hide a row that is still there.
 *
 * Only ever called *after* a deletion, on an identifier that is expected to address nothing, so
 * it cannot perturb the state a later assertion reads.
 */
async function expectCommentGone(
  request: APIRequestContext,
  owner: Account,
  commentId: string,
  description: string,
): Promise<void> {
  const response = await request.patch(`${apiBaseUrl()}/comments/${commentId}`, {
    headers: bearerHeaders(owner.bearer),
    data: {},
  });
  expect(
    response.status(),
    `${description} no longer exists, so not even its own author can address it`,
  ).toBe(HTTP_NOT_FOUND);
}

/** Read the like tally. Omit `bearer` to prove the summary needs no credential at all. */
async function readLikes(
  request: APIRequestContext,
  postId: string,
  bearer?: string,
): Promise<WireLikeSummary> {
  const response = await request.get(`${apiBaseUrl()}/posts/${postId}/likes`, {
    headers: bearer === undefined ? {} : bearerHeaders(bearer),
  });
  expect(response.status(), 'reading the like tally should answer 200').toBe(HTTP_OK);
  return readJson<WireLikeSummary>(response);
}

/**
 * Assert a like summary carries the whole documented shape for `postId`.
 *
 * Worth asserting rather than assuming: it is precisely because `PUT`, `DELETE` and `GET` all
 * answer with this shape that `like-button.tsx` can settle an optimistic update from the
 * mutation response with no invalidation and no follow-up read.
 */
function expectLikeSummary(
  summary: WireLikeSummary,
  postId: string,
  count: number,
  likedByCaller: boolean,
): void {
  expect(summary.post_id, 'the summary names the post it counts').toBe(postId);
  expect(summary.like_count, 'the like tally').toBe(count);
  expect(summary.liked_by_caller, 'whether the calling principal has liked').toBe(likedByCaller);
}

/* ============================================================================================
 * Browser helpers
 * ==========================================================================================*/

/** Root-relative sign-in URL that returns to `returnTo` once the credential is accepted. */
function signInPath(returnTo: string): string {
  return `${LOGIN_PATH}?${new URLSearchParams({ [RETURN_TO_PARAM]: returnTo }).toString()}`;
}

/**
 * Sign in through the real sign-in form and land on `returnTo`.
 *
 * Deliberately the UI path rather than an injected token: `use.storageState` is unset in
 * `playwright.config.ts` precisely so no spec inherits a session, and driving the published
 * form keeps this spec's setup made of the same affordances a reader has. The final assertion
 * is on the URL, so the test only proceeds once the session has actually been adopted and the
 * form has handed control back to the page under test.
 */
async function signIn(page: Page, account: Account, returnTo: string): Promise<void> {
  await page.goto(signInPath(returnTo));
  await page.getByLabel(EMAIL_LABEL).fill(account.email);
  await page.getByLabel(PASSWORD_LABEL).fill(account.password);
  await page.getByRole('button', { name: SIGN_IN_SUBMIT, exact: true }).click();
  await expect(page, 'accepting the credential returns to the page that asked for it').toHaveURL(
    returnTo,
  );
}

/**
 * The comment thread's landmark: `<section aria-labelledby>` the heading "Comments (N)".
 *
 * Every text assertion about the thread is scoped through this, and that is load-bearing rather
 * than tidy. React streams a server-rendered page in pieces and swaps late-arriving content in
 * from a container carrying the `hidden` attribute, so for a moment a page can hold two copies
 * of the same words. A role locator resolves only against the accessibility tree, which excludes
 * anything hidden, so scoping through this landmark makes an assertion see the copy a reader
 * sees - measured: the same assertion written page-wide resolved to two elements under load and
 * to one when the page happened to settle first, which is a flake rather than a finding.
 */
function thread(page: Page): Locator {
  return page.getByRole('region', { name: THREAD_REGION_NAME });
}

/**
 * The heading that reports how many **root** comments the thread has.
 *
 * `comment-list.tsx` renders `page.total`, and the API paginates top-level comments only, so
 * this number counts threads and not nodes. It is the honest place to read "did adding a reply
 * consume a page slot" from.
 */
function threadHeading(page: Page, roots: number): Locator {
  return page.getByRole('heading', { name: `Comments (${String(roots)})` });
}

/**
 * One rendered comment, located by the text it shows.
 *
 * `comment-item.tsx` renders every comment as an `<article>` and nests a parent's replies
 * inside it, so scoping this call to a parent's article is the structural, class-free way to
 * assert nesting: `commentCard(commentCard(page, parentBody), replyBody)`.
 */
function commentCard(scope: Page | Locator, body: string): Locator {
  return scope.getByRole('article').filter({ hasText: body });
}

/**
 * The like control: one button whose accessible name carries the action and the tally.
 *
 * The pattern is deliberately case-insensitive and deliberately loose about the verb, because
 * `like-button.tsx` publishes three different names for the same control - "Like this post",
 * "Unlike this post" and "Sign in to like this post" - and this locator has to find it in all
 * three states. Every assertion on the settled name below is exact.
 */
function likeControl(page: Page): Locator {
  return page.getByRole('button', { name: /like this post/i });
}

/** The share landmark: `<nav aria-label="Share this post">`. */
function shareBar(page: Page): Locator {
  return page.getByRole('navigation', { name: SHARE_REGION_NAME });
}

/**
 * Wait until the like control is interactive.
 *
 * It renders `aria-disabled` while the session is being restored and while a like is in
 * flight, and its class set turns pointer events off in that state, so clicking before this
 * resolves would fail on actionability rather than on behaviour. Playwright treats
 * `aria-disabled` as disabled, so this is a genuine readiness assertion and not a sleep.
 */
async function waitForLikeControl(page: Page): Promise<Locator> {
  const control = likeControl(page);
  await expect(control, 'the like control renders').toBeVisible();
  await expect(
    control,
    'the like control becomes interactive once the session resolves',
  ).toBeEnabled();
  return control;
}

/**
 * Assert the acknowledgement the **root** comment form gets when the API holds a submission.
 *
 * This *is* the author-visible outcome of posting, and there is no alternative to assert
 * instead: a new comment is created PENDING, every server render of the thread is anonymous,
 * and an anonymous reader sees approved comments only - so a just-posted comment cannot appear
 * in the thread, by design rather than by omission. The root form stays mounted after an
 * accepted submission, because `comment-list.tsx` hands it no success callback, so its
 * live-region alert persists; it is asserted before the toast for exactly that reason, since a
 * persistent element cannot race the toast's own dismissal.
 */
async function expectHeldNotice(
  page: Page,
  heldDetail: string,
  toastMessage: string,
): Promise<void> {
  const notice = page.getByRole('status').filter({ hasText: heldDetail });
  await expect(
    notice,
    'a submission held for moderation is acknowledged in a live region',
  ).toBeVisible();
  await expect(
    notice.getByText(HELD_FOR_APPROVAL_TITLE),
    'and that acknowledgement is titled for what is happening',
  ).toBeVisible();
  await expect(page.getByText(toastMessage), 'and the toast says the same thing').toBeVisible();
}

/**
 * Assert the acknowledgement a **reply** or an **edit** gets.
 *
 * Those two forms close themselves once a submission is accepted - `comment-item.tsx` hands each
 * of them a success callback that does exactly that - so their own alert is unmounted with them
 * and the message a reader is left with is the toast. The form closing is asserted alongside it,
 * because that is the persistent half of the same outcome and it is what tells the reader the
 * submission is no longer theirs to edit.
 */
async function expectHeldToast(
  page: Page,
  toastMessage: string,
  closingField: Locator,
): Promise<void> {
  await expect(
    page.getByText(toastMessage),
    'the reader is told the submission was received and is held',
  ).toBeVisible();
  await expect(
    closingField,
    'and the form closes itself once the submission has been accepted',
  ).toHaveCount(0);
}

/* ============================================================================================
 * The journey
 * ==========================================================================================*/

test.describe('Comments, likes and sharing', () => {
  /**
   * AAP §0.9.4.4, "Comments": *An authenticated user can comment and reply.*
   *
   * Also discharges, in the same run, the two properties the collection contract turns on:
   * a reply is nested inside its parent rather than listed beside it, and it consumes no
   * top-level page slot, because `GET /api/v1/posts/{id}/comments` paginates roots only.
   *
   * The order of the three page visits is the whole design of this test. An approved root and
   * an approved reply are established through the API *before* the first navigation, so the
   * one cache-cold render of `/blog/{slug}` observes them live; the two live re-readings of the
   * public root total afterwards go to `?page=2` and `?page=3`, which are distinct
   * comments-fetch URLs and therefore always cache-cold. See the header note.
   */
  test('an authenticated reader comments and replies, and a reply consumes no root slot', async ({
    page,
    request,
  }) => {
    const admin = await adminBearer(request);
    const commenter = await registerAccount(request, 'c');
    // A second reader authors the seeded reply. Two accounts rather than one because
    // `comment-item.tsx` names its per-comment controls after their author - "Reply to {name}" -
    // so a parent and a nested reply written by the same person would publish the same
    // accessible name twice inside one comment card and no locator could tell them apart. Two
    // authors is also the truer fixture: a thread is a conversation.
    const responder = await registerAccount(request, 'q');
    const post = await publishPost(request, commenter, 'thread');

    // ---- Fixtures, established before anything is rendered -----------------------------
    const seededRootBody = `Seeded root comment ${uniqueToken()}`;
    const seededRoot = await addComment(request, commenter, post.id, seededRootBody);
    // Approved before the reply is written: a caller may only reply to a comment they can see.
    await setCommentStatus(request, admin, seededRoot.id, 'APPROVED');

    const seededReplyBody = `Seeded reply by a second reader ${uniqueToken()}`;
    const seededReply = await addComment(
      request,
      responder,
      post.id,
      seededReplyBody,
      seededRoot.id,
    );
    await setCommentStatus(request, admin, seededReply.id, 'APPROVED');

    // Two comments exist. The public collection reports ONE page member, with the reply
    // carried inside it - which is what "paginated on top-level comments only" means.
    const seeded = await readThread(request, post.id);
    expect(seeded.total, 'total counts root comments, not comment rows').toBe(1);
    expect(seeded.pages, 'and pages follows total').toBe(1);
    expect(seeded.items, 'so the page carries one member').toHaveLength(1);
    const seededRootRow = rootAt(seeded, 0);
    expect(seededRootRow.id, 'the member is the root comment').toBe(seededRoot.id);
    expect(
      seededRootRow.replies.map((reply) => reply.id),
      'and the reply arrives nested inside its parent',
    ).toEqual([seededReply.id]);
    expect(seededRootRow.reply_count, 'the parent reports how many replies are visible').toBe(1);

    // ---- An anonymous visitor: the thread, but no comment form -------------------------
    // The `page` fixture starts from a clean profile and `use.storageState` is unset, so this
    // is a genuinely anonymous visitor rather than a signed-out-looking one.
    await page.goto(postPath(post.slug));
    await expect(
      threadHeading(page, 1),
      'the heading reports one thread even though two comments exist',
    ).toBeVisible();

    const rootCard = commentCard(page, seededRootBody);
    await expect(rootCard, 'the root comment renders').toBeVisible();
    await expect(
      commentCard(rootCard, seededReplyBody),
      'and the reply renders *inside* its parent, which is what nesting means structurally',
    ).toBeVisible();
    await expect(
      thread(page).getByRole('article'),
      'two comments are rendered in a thread the heading counts as one',
    ).toHaveCount(2);

    await expect(
      page.getByLabel(ROOT_COMMENT_LABEL),
      'an anonymous visitor is offered no comment field',
    ).toHaveCount(0);
    await expect(
      thread(page).getByText(ANONYMOUS_FORM_TITLE),
      'they are told why, in place of the form',
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: ANONYMOUS_FORM_LINK }),
      'and are given the way in',
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: SIGN_IN_TO_REPLY }),
      'each rendered comment offers the same route to replying',
    ).toHaveCount(2);

    // ---- Signed in: submit a root comment using nothing but the keyboard ---------------
    await signIn(page, commenter, postPath(post.slug));

    const commentBox = page.getByLabel(ROOT_COMMENT_LABEL);
    await expect(commentBox, 'a signed-in reader is offered the comment field').toBeVisible();

    const keyboardBody = `Keyboard comment ${uniqueToken()}`;
    // `focus()` is the DOM focus method, not a pointer interaction: from here on every event
    // that reaches the page is a real key event, and the Tab below proves the submit control is
    // reachable from the field without a mouse.
    await commentBox.focus();
    await expect(commentBox, 'the field takes focus').toBeFocused();
    await page.keyboard.type(keyboardBody);
    await expect(commentBox, 'typed character by character').toHaveValue(keyboardBody);
    await page.keyboard.press('Tab');
    const postComment = page.getByRole('button', { name: ROOT_COMMENT_SUBMIT, exact: true });
    await expect(postComment, 'the submit control is the next thing Tab reaches').toBeFocused();
    await page.keyboard.press('Enter');

    await expectHeldNotice(page, COMMENT_HELD_DETAIL, COMMENT_HELD_TOAST);
    await expect(commentBox, 'an accepted submission clears the field').toHaveValue('');

    // ---- Reply through the reply affordance --------------------------------------------
    // Named after the comment being answered, which is what makes it unambiguous inside a card
    // that also holds another reader's reply and that reader's own reply affordance.
    await rootCard.getByRole('button', { name: `Reply to ${commenter.displayName}` }).click();
    const replyBox = page.getByLabel(REPLY_LABEL);
    await expect(replyBox, 'opening a reply moves focus into it').toBeFocused();

    const uiReplyBody = `Reply through the affordance ${uniqueToken()}`;
    await replyBox.fill(uiReplyBody);
    await page.getByRole('button', { name: REPLY_SUBMIT, exact: true }).click();
    await expectHeldToast(page, REPLY_HELD_TOAST, replyBox);

    // ---- Both submissions landed, and only one of them is a thread --------------------
    const authorView = await readThread(request, post.id, commenter.bearer);
    expect(
      authorView.total,
      'the author sees their own held comments, so the root they just wrote is a second thread',
    ).toBe(2);
    expect(
      authorView.items.map((item) => item.body),
      'the keyboard-driven submission became a root comment',
    ).toContain(keyboardBody);

    const seededInAuthorView = rootWithId(authorView, seededRoot.id);
    expect(
      bodiesOf(seededInAuthorView.replies),
      'while the reply hangs off the comment it answered',
    ).toContain(uiReplyBody);

    const publicView = await readThread(request, post.id);
    expect(
      publicView.total,
      'and neither submission is public yet, because both are awaiting moderation',
    ).toBe(1);

    // ---- The same arithmetic, read live through two full page loads --------------------
    // Approving the *reply* must not move the public root total, because a reply is not a
    // thread. `?page=2` is a cache-cold comments-fetch URL, so this heading is live.
    const uiReply = commentWithBody(authorView.items, uiReplyBody);
    await setCommentStatus(request, admin, uiReply.id, 'APPROVED');

    await page.goto(`${postPath(post.slug)}?page=2`);
    await expect(
      threadHeading(page, 1),
      'an approved reply changes what the thread contains, never how many threads there are',
    ).toBeVisible();
    await expect(
      thread(page).getByText(EMPTY_THREAD_TITLE),
      'page two of a single-page thread is an empty page, not an error',
    ).toBeVisible();

    // Approving the *root* must move it, for exactly the same reason.
    const keyboardRoot = commentWithBody(authorView.items, keyboardBody);
    await setCommentStatus(request, admin, keyboardRoot.id, 'APPROVED');

    await page.goto(`${postPath(post.slug)}?page=3`);
    await expect(
      threadHeading(page, 2),
      'an approved root comment does consume a page slot',
    ).toBeVisible();
  });

  /**
   * AAP §0.9.4.4, "Comments": *A non-owner cannot edit another's comment.*
   *
   * The client hiding a control is not a security boundary, so the assertion that matters is
   * the server's refusal, taken with Playwright's own `APIRequestContext`. The hidden control
   * is asserted too, because a reader being shown an affordance they cannot use is its own
   * defect.
   */
  test("a non-owner cannot edit another reader's comment, and the owner can", async ({
    browser,
    baseURL,
    page,
    request,
  }) => {
    const admin = await adminBearer(request);
    const owner = await registerAccount(request, 'o');
    const bystander = await registerAccount(request, 'b');
    const post = await publishPost(request, owner, 'ownership');

    const originalBody = `Comment owned by its author ${uniqueToken()}`;
    const comment = await addComment(request, owner, post.id, originalBody);
    await setCommentStatus(request, admin, comment.id, 'APPROVED');

    // ---- The bystander's own browser context ------------------------------------------
    // Separate context, so the two sessions cannot borrow each other's credentials. It takes
    // the first (cache-cold) render of this post, which is why it runs before the owner's.
    const bystanderContext = await browser.newContext({
      ...(baseURL === undefined ? {} : { baseURL }),
      viewport: page.viewportSize(),
    });
    try {
      const bystanderPage = await bystanderContext.newPage();
      await signIn(bystanderPage, bystander, postPath(post.slug));

      const asBystander = commentCard(bystanderPage, originalBody);
      await expect(asBystander, "another reader's comment is readable").toBeVisible();
      await expect(
        asBystander.getByRole('button', { name: `Edit comment by ${owner.displayName}` }),
        'but no edit affordance is offered for it',
      ).toHaveCount(0);
      await expect(
        asBystander.getByRole('button', { name: `Delete comment by ${owner.displayName}` }),
        'and no delete affordance either',
      ).toHaveCount(0);
      await expect(
        asBystander.getByRole('button', { name: `Reply to ${owner.displayName}` }),
        'replying, which needs no ownership, is offered',
      ).toBeVisible();
    } finally {
      await bystanderContext.close();
    }

    // ---- The refusal that is actually the boundary -------------------------------------
    const refused = await request.patch(`${apiBaseUrl()}/comments/${comment.id}`, {
      headers: bearerHeaders(bystander.bearer),
      data: { body: `Text the bystander is not entitled to write ${uniqueToken()}` },
    });
    expect(
      refused.status(),
      'the server refuses an edit by someone who neither wrote the comment nor administers',
    ).toBe(HTTP_FORBIDDEN);

    const problem = await readJson<WireProblem>(refused);
    expect(problem.status, 'the problem document restates the status').toBe(HTTP_FORBIDDEN);
    expect(problem.type, 'and carries a type').not.toBe('');
    expect(problem.title, 'and a title').not.toBe('');
    expect(problem.detail, 'and a human-readable detail').not.toBe('');
    expect(problem.instance, 'and names the resource that refused').toBe(
      `${API_VERSION_PREFIX}/comments/${comment.id}`,
    );
    expect(problem.request_id, 'and correlates to a request').not.toBe('');
    expect(problem.detail, 'without disclosing which role would have sufficed').not.toContain(
      'ADMIN',
    );

    const afterRefusal = await readThread(request, post.id);
    expect(rootAt(afterRefusal, 0).body, 'and the comment is exactly as it was').toBe(originalBody);

    // ---- The owner can edit their own comment ------------------------------------------
    await signIn(page, owner, postPath(post.slug));
    const asOwner = commentCard(page, originalBody);
    await asOwner.getByRole('button', { name: `Edit comment by ${owner.displayName}` }).click();

    const editBox = page.getByLabel(EDIT_LABEL);
    await expect(editBox, 'the editor opens focused').toBeFocused();
    await expect(editBox, 'prefilled with the text being replaced').toHaveValue(originalBody);

    const editedBody = `Comment owned by its author, corrected ${uniqueToken()}`;
    await editBox.fill(editedBody);
    await page.getByRole('button', { name: EDIT_SUBMIT, exact: true }).click();
    await expectHeldToast(page, EDIT_HELD_TOAST, editBox);

    // The edit replaced the body and nothing else that identifies the comment. Its moderation
    // state did move, and deliberately: the API returns an edited comment to the queue, because
    // approval attaches to the text a moderator read rather than to the row that held it.
    const ownerView = await readThread(request, post.id, owner.bearer);
    const edited = rootWithId(ownerView, comment.id);
    expect(edited.body, 'the body is the new text').toBe(editedBody);
    expect(edited.id, 'the identity is untouched').toBe(comment.id);
    expect(edited.post_id, 'the post it belongs to is untouched').toBe(comment.post_id);
    expect(edited.parent_id, 'its place in the thread is untouched').toBeNull();
    expect(edited.author.id, 'its author is untouched').toBe(owner.id);
    expect(edited.created_at, 'and when it was written is untouched').toBe(comment.created_at);
    expect(edited.status, 'while an accepted edit re-opens moderation, by design').toBe('PENDING');

    const publicAfterEdit = await readThread(request, post.id);
    expect(
      publicAfterEdit.total,
      'so the edited comment leaves the public thread until it is approved again',
    ).toBe(0);
  });

  /**
   * AAP §0.9.4.4, "Comments": *Deleting a parent removes its replies.*
   *
   * The cascade lives in the database - `comments.parent_id` declares
   * `ON DELETE CASCADE` against `comments.id` - and nothing in the client removes a reply, so
   * this test is careful to observe the server rather than the page's own state. It proves the
   * cascade three ways: a full page load rendered by the server after a deletion; the server
   * reporting each reply's identifier as addressing nothing; and the collection's own total.
   *
   * Two threads are seeded, each with a reply from a *different* account, so the cascade is
   * demonstrably not scoped to one author. The parent is approved before the second account
   * replies, because a caller may only reply to a comment they can see.
   */
  test('deleting a parent comment removes every reply beneath it', async ({ page, request }) => {
    const admin = await adminBearer(request);
    const owner = await registerAccount(request, 'o');
    // Both replies come from accounts that are not the root's author. Two of them, so the
    // cascade is demonstrably not scoped to one person; neither of them the root's author, so
    // the only comment the signed-in owner may modify inside a thread card is the root itself -
    // `comment-item.tsx` derives its modify controls from ownership, and a nested reply the same
    // person wrote would publish a second "Delete comment by {name}" inside the same card.
    const firstReplier = await registerAccount(request, 'r');
    const secondReplier = await registerAccount(request, 'p');
    const post = await publishPost(request, owner, 'cascade');

    interface SeededThread {
      readonly root: WireComment;
      readonly rootBody: string;
      readonly firstReply: WireComment;
      readonly firstReplyBody: string;
      readonly secondReply: WireComment;
      readonly secondReplyBody: string;
    }

    async function seedThread(label: string): Promise<SeededThread> {
      const rootBody = `Root of the ${label} thread ${uniqueToken()}`;
      const root = await addComment(request, owner, post.id, rootBody);
      // Approved first: neither replier can answer a comment it cannot see.
      await setCommentStatus(request, admin, root.id, 'APPROVED');

      const firstReplyBody = `Reply by one reader on the ${label} thread ${uniqueToken()}`;
      const firstReply = await addComment(request, firstReplier, post.id, firstReplyBody, root.id);
      await setCommentStatus(request, admin, firstReply.id, 'APPROVED');

      const secondReplyBody = `Reply by another reader on the ${label} thread ${uniqueToken()}`;
      const secondReply = await addComment(
        request,
        secondReplier,
        post.id,
        secondReplyBody,
        root.id,
      );
      await setCommentStatus(request, admin, secondReply.id, 'APPROVED');

      return { root, rootBody, firstReply, firstReplyBody, secondReply, secondReplyBody };
    }

    const kept = await seedThread('kept');
    const removed = await seedThread('removed');

    const seeded = await readThread(request, post.id);
    expect(seeded.total, 'two threads, six comments').toBe(2);
    expect(rootWithId(seeded, kept.root.id).reply_count, 'the kept thread has two replies').toBe(2);
    expect(
      rootWithId(seeded, removed.root.id).reply_count,
      'and so does the one about to be removed',
    ).toBe(2);

    // ---- Cascade observed through a full server render ---------------------------------
    // Deleting through the API first means the post's one cache-cold render happens *after*
    // the cascade, so what the server renders is the live post-cascade state rather than a
    // 60-second-old copy of the thread. See the header note on the Data Cache.
    const deletedThroughApi = await request.delete(`${apiBaseUrl()}/comments/${removed.root.id}`, {
      headers: bearerHeaders(owner.bearer),
    });
    expect(deletedThroughApi.status(), 'deleting a comment answers 204').toBe(HTTP_NO_CONTENT);
    expect(
      (await deletedThroughApi.body()).byteLength,
      'and a 204 carries no body at all - no acknowledgement object, no envelope',
    ).toBe(0);

    await expectCommentGone(
      request,
      firstReplier,
      removed.firstReply.id,
      "one reader's reply on the removed thread",
    );
    await expectCommentGone(
      request,
      secondReplier,
      removed.secondReply.id,
      "the other reader's reply on the removed thread",
    );

    await signIn(page, owner, postPath(post.slug));
    await expect(
      threadHeading(page, 1),
      'the server renders one thread where there were two',
    ).toBeVisible();
    await expect(
      commentCard(page, removed.rootBody),
      'the deleted parent is not rendered',
    ).toHaveCount(0);
    await expect(
      thread(page).getByText(removed.firstReplyBody),
      'nor is one reader\u2019s reply to it',
    ).toHaveCount(0);
    await expect(
      thread(page).getByText(removed.secondReplyBody),
      'nor the other reader\u2019s reply to it',
    ).toHaveCount(0);

    const keptCard = commentCard(page, kept.rootBody);
    await expect(keptCard, 'while the untouched thread is intact').toBeVisible();
    await expect(
      commentCard(keptCard, kept.firstReplyBody),
      'with both of its replies still nested inside it',
    ).toBeVisible();
    await expect(commentCard(keptCard, kept.secondReplyBody)).toBeVisible();

    // ---- The same deletion, driven through the confirmation dialog ---------------------
    const deleteTrigger = keptCard.getByRole('button', {
      name: `Delete comment by ${owner.displayName}`,
    });
    await deleteTrigger.click();

    const confirmation = page.getByRole('dialog');
    await expect(
      confirmation.getByText(DELETE_DIALOG_TITLE),
      'the dialog asks first',
    ).toBeVisible();
    await expect(
      confirmation.getByText('2 direct replies'),
      'and says how much goes with it',
    ).toBeVisible();

    // Escape must dismiss it without deleting anything - the accessibility floor for a modal.
    // Exhaustive focus-trap coverage belongs to home-feed.spec.ts and admin.spec.ts.
    await page.keyboard.press('Escape');
    await expect(confirmation, 'Escape dismisses the confirmation').toBeHidden();
    await expect(keptCard, 'and nothing was deleted').toBeVisible();

    await deleteTrigger.click();
    const reopened = page.getByRole('dialog');
    await expect(reopened.getByText(DELETE_DIALOG_TITLE)).toBeVisible();

    const deletion = page.waitForResponse(
      (response) =>
        response.url() === `${apiBaseUrl()}/comments/${kept.root.id}` &&
        response.request().method() === 'DELETE',
    );
    await reopened.getByRole('button', { name: DELETE_CONFIRM, exact: true }).click();
    expect(
      (await deletion).status(),
      'confirming deletes the comment and the server answers 204',
    ).toBe(HTTP_NO_CONTENT);

    await expect(page.getByText(DELETE_SUCCESS_TOAST), 'the reader is told').toBeVisible();
    await expect(
      page.getByText(DELETE_CASCADE_TOAST),
      'and told that the replies went with it',
    ).toBeVisible();
    await expect(reopened, 'and the dialog closes itself').toBeHidden();

    await expectCommentGone(
      request,
      firstReplier,
      kept.firstReply.id,
      "one reader's reply on the kept thread",
    );
    await expectCommentGone(
      request,
      secondReplier,
      kept.secondReply.id,
      "the other reader's reply on the kept thread",
    );

    const emptied = await readThread(request, post.id);
    expect(emptied.total, 'the post has no comments left at all').toBe(0);
    expect(emptied.items, 'and no page members').toHaveLength(0);

    // ---- And once more through a full page load served by the server -------------------
    // `?page=2` is a comments-fetch URL this run has never requested, so this navigation is
    // cache-cold: the heading and the empty state below are the live state of the thread after
    // the cascade, not a client-side removal and not a cached copy.
    await page.goto(`${postPath(post.slug)}?page=2`);
    await expect(
      threadHeading(page, 0),
      'a full page load, rendered by the server, reports no threads remain',
    ).toBeVisible();
    await expect(
      thread(page).getByText(EMPTY_THREAD_TITLE),
      'and says so to the reader',
    ).toBeVisible();
    await expect(
      page.getByText(kept.firstReplyBody),
      'with neither cascaded reply anywhere on the page',
    ).toHaveCount(0);
    await expect(page.getByText(kept.secondReplyBody)).toHaveCount(0);
  });

  /**
   * AAP §0.9.4.4, "Comments": *Only approved comments are visible publicly.*
   *
   * Asserted from a fresh anonymous context - the `page` fixture, which starts from a clean
   * profile and never signs in - because the author may legitimately see their own held
   * comment, and reading the rule from the author's view would prove nothing.
   *
   * The default moderation state was read out of the backend rather than assumed:
   * `models/comment.py` gives `status` a `server_default` of `'PENDING'`, and
   * `routers/comments.py` states that "the new comment is created awaiting moderation". So both
   * directions are exercised here: a held comment never reaches the public thread, an approved
   * one does, and withdrawing an approved one takes it back out again while the row survives.
   */
  test('the public thread shows approved comments only', async ({ page, request }) => {
    const admin = await adminBearer(request);
    const commenter = await registerAccount(request, 'c');
    const post = await publishPost(request, commenter, 'moderation');

    const approvedBody = `Comment a moderator approved ${uniqueToken()}`;
    const heldBody = `Comment still waiting for a moderator ${uniqueToken()}`;
    const approved = await addComment(request, commenter, post.id, approvedBody);
    await addComment(request, commenter, post.id, heldBody);
    await setCommentStatus(request, admin, approved.id, 'APPROVED');

    // The rule at its source, and the fact that it is scoped to the caller.
    const publicView = await readThread(request, post.id);
    expect(publicView.total, 'the public thread counts the approved comment only').toBe(1);
    expect(bodiesOf(publicView.items), 'and carries only that comment').toEqual([approvedBody]);

    const authorView = await readThread(request, post.id, commenter.bearer);
    expect(authorView.total, 'their author still sees both').toBe(2);
    expect(bodiesOf(authorView.items), 'including the one being held').toContain(heldBody);

    // ---- The public page, from a fresh anonymous context -------------------------------
    await page.goto(postPath(post.slug));
    await expect(threadHeading(page, 1), 'one thread is public').toBeVisible();
    await expect(commentCard(page, approvedBody), 'the approved comment renders').toBeVisible();
    await expect(
      commentCard(page, heldBody),
      'the held comment is not rendered as a comment',
    ).toHaveCount(0);
    await expect(
      page.getByText(heldBody),
      'and its text appears nowhere on the page at all',
    ).toHaveCount(0);

    // `comment-item.tsx` renders a moderation badge for any comment whose state is not
    // APPROVED, so the absence of both badge texts is the page stating - in words a reader can
    // see, not in a styling class - that nothing on it is in a non-approved state.
    await expect(
      thread(page).getByText(PENDING_BADGE),
      'nothing on the public page is awaiting approval',
    ).toHaveCount(0);
    await expect(
      thread(page).getByText(REJECTED_BADGE),
      'and nothing on it has been refused',
    ).toHaveCount(0);

    // ---- Withdrawing approval takes it back out of the public view ---------------------
    await setCommentStatus(request, admin, approved.id, 'REJECTED');

    const withdrawn = await readThread(request, post.id);
    expect(withdrawn.total, 'a rejected comment stops being public').toBe(0);
    expect(bodiesOf(withdrawn.items), 'and stops being carried').toEqual([]);

    const authorAfterRejection = await readThread(request, post.id, commenter.bearer);
    expect(
      authorAfterRejection.total,
      'while the row survives - rejection is reversible, deletion is not',
    ).toBe(2);

    // Read live through a full page load: `?page=2` is a cache-cold comments-fetch URL.
    await page.goto(`${postPath(post.slug)}?page=2`);
    await expect(
      threadHeading(page, 0),
      'so a full page load reports no public threads on this post',
    ).toBeVisible();
    await expect(
      page.getByText(approvedBody),
      'and the withdrawn comment is nowhere on it',
    ).toHaveCount(0);
  });

  /**
   * AAP §0.9.4.2 and §0.9.4.4: *Likes are idempotent - two consecutive
   * `PUT /api/v1/posts/{id}/like` calls leave the count at 1.*
   *
   * That is a database-level guarantee surfaced through the UI: `post_likes` has a composite
   * primary key `(post_id, user_id)` and the repository inserts with `ON CONFLICT DO NOTHING`.
   * It is asserted here twice over - at the API, and through the control - and neither
   * assertion is propped up by a retry or a sleep. If it ever needed one, the flake would be
   * telling us the guarantee had gone.
   *
   * The control ends up proving idempotency almost by accident, and the reason is worth
   * stating. Every server render of a post is anonymous, so the summary that seeds the control
   * always reports `liked_by_caller: false`; a reader who has already liked therefore arrives
   * at an unpressed heart, and activating it issues *another* `PUT`. The optimistic update
   * bumps the tally, the server answers with the settled summary, and the tally lands back on
   * one. Two likes, one like recorded, observed exactly where a reader would see it.
   */
  test('two consecutive likes leave the count at one, and unliking reverses it', async ({
    page,
    request,
  }) => {
    const reader = await registerAccount(request, 'l');
    const post = await publishPost(request, reader, 'likes');
    const likePath = `${apiBaseUrl()}/posts/${post.id}/like`;

    // ---- At the API, against a post that provably has no likes -------------------------
    // No bearer is presented here at all, which is the second thing this asserts: the summary
    // is a public read, and an anonymous caller is simply reported as not having liked.
    expectLikeSummary(await readLikes(request, post.id), post.id, 0, false);

    const firstLike = await request.put(likePath, { headers: bearerHeaders(reader.bearer) });
    expect(firstLike.status(), 'liking answers 200').toBe(HTTP_OK);
    expectLikeSummary(await readJson<WireLikeSummary>(firstLike), post.id, 1, true);

    const secondLike = await request.put(likePath, { headers: bearerHeaders(reader.bearer) });
    expect(secondLike.status(), 'liking again answers 200 rather than a conflict').toBe(HTTP_OK);
    expectLikeSummary(
      await readJson<WireLikeSummary>(secondLike),
      post.id,
      // One. Not two. The composite primary key makes the second insert a no-op, so `PUT` is
      // safely retryable and no application-level de-duplication exists or is needed.
      1,
      true,
    );

    expectLikeSummary(await readLikes(request, post.id, reader.bearer), post.id, 1, true);
    expectLikeSummary(await readLikes(request, post.id), post.id, 1, false);

    // ---- Through the control ------------------------------------------------------------
    await signIn(page, reader, postPath(post.slug));
    const control = await waitForLikeControl(page);
    await expect(
      control,
      'the control reports the one like the two calls recorded',
    ).toHaveAccessibleName('Like this post, 1 like');
    await expect(
      control,
      'and reports itself unpressed, because the server render is anonymous',
    ).toHaveAttribute('aria-pressed', 'false');

    // A third like by the same principal, this time through the UI. The settled name is
    // asserted directly - the mutation response carries the summary, so there is no follow-up
    // request to wait for and nothing to poll for but the settled control itself.
    await control.click();
    await expect(control, 'a further like still leaves exactly one').toHaveAccessibleName(
      'Unlike this post, 1 like',
    );
    await expect(control, 'and the control now reflects the caller having liked').toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // ---- Reload: the server, not the optimistic client, holds the single like -----------
    await page.reload();
    const afterReload = await waitForLikeControl(page);
    await expect(
      afterReload,
      'a full reload still reports one like, so the tally is the server’s and not the page’s',
    ).toHaveAccessibleName(/, 1 like$/);
    expectLikeSummary(await readLikes(request, post.id), post.id, 1, false);
    // The pressed state is deliberately not asserted here: the reloaded page is seeded by an
    // anonymous server read, so it cannot know this caller liked until the caller acts again.

    // ---- Unlike decrements and flips the caller state ----------------------------------
    await afterReload.click();
    await expect(afterReload, 'acting again re-likes, and one is still one').toHaveAccessibleName(
      'Unlike this post, 1 like',
    );
    await expect(afterReload).toHaveAttribute('aria-pressed', 'true');

    await afterReload.click();
    await expect(afterReload, 'unliking decrements the tally').toHaveAccessibleName(
      'Like this post, 0 likes',
    );
    await expect(afterReload, 'and flips the caller state back').toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expectLikeSummary(await readLikes(request, post.id), post.id, 0, false);

    // ---- The one DELETE in this API that answers with a body ---------------------------
    const relike = await request.put(likePath, { headers: bearerHeaders(reader.bearer) });
    expect(relike.status()).toBe(HTTP_OK);
    expectLikeSummary(await readJson<WireLikeSummary>(relike), post.id, 1, true);

    const removal = await request.delete(likePath, { headers: bearerHeaders(reader.bearer) });
    expect(removal.status(), 'removing a like answers 200, not 204').toBe(HTTP_OK);
    expect(
      (await removal.body()).byteLength,
      'because unlike every other DELETE in this API it carries a body',
    ).toBeGreaterThan(0);
    expectLikeSummary(await readJson<WireLikeSummary>(removal), post.id, 0, false);

    expectLikeSummary(await readLikes(request, post.id), post.id, 0, false);
  });

  /**
   * AAP §0.4.4 and §0.6.2: sharing "is built entirely client-side from the post's canonical URL,
   * requiring no backend endpoint".
   *
   * The claim is negative, so it is asserted negatively: every request the browser makes to the
   * API origin is recorded, the log is emptied once the page has settled, every share affordance
   * is then activated, and the log has to still be empty. The three outbound hosts are answered
   * from inside the browser context, because activating a share link is part of exercising it and
   * a gate must not depend on reaching a third party.
   *
   * Both feature-detected branches of `share-bar.tsx` are covered rather than skipped: the
   * clipboard is probed for the same capability the component probes for, and the native share
   * sheet is asserted absent when the browser has none and then made present, deterministically,
   * so the affordance itself is exercised too.
   */
  test('share affordances are built from the canonical URL and call no backend endpoint', async ({
    page,
    request,
  }) => {
    const author = await registerAccount(request, 's');
    const post = await publishPost(request, author, 'sharing');
    const canonicalUrl = canonicalPostUrl(post.slug);
    const origin = apiOrigin();

    const apiCalls: string[] = [];
    page.on('request', (candidate) => {
      if (candidate.url().startsWith(origin)) {
        apiCalls.push(`${candidate.method()} ${candidate.url()}`);
      }
    });

    // Routed on the context rather than the page: `target="_blank"` opens a new page, and only a
    // context-level route reaches it.
    await page.context().route(EXTERNAL_SHARE_HOSTS, (route) =>
      route.fulfill({
        status: HTTP_OK,
        contentType: 'text/html',
        body: '<!doctype html><title>share target</title>',
      }),
    );
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: siteOrigin() });

    await page.goto(postPath(post.slug));
    const bar = shareBar(page);
    await expect(bar, 'the share affordances are a labelled landmark').toBeVisible();
    // Settle first. The anonymous comment form only renders once the session restore has
    // resolved, which is the one thing on this page that legitimately talks to the API.
    await expect(thread(page).getByText(ANONYMOUS_FORM_TITLE)).toBeVisible();
    apiCalls.length = 0;

    // ---- The outbound links are real anchors carrying the canonical URL ----------------
    for (const target of SHARE_TARGETS) {
      const link = bar.getByRole('link', { name: target.name });
      await expect(link, `${target.name} is offered`).toBeVisible();

      const href = await link.getAttribute('href');
      if (href === null) {
        throw new Error(`${target.name} is an anchor with no href, so it shares nothing`);
      }
      expect(
        new URL(href).searchParams.get(target.urlParam),
        'it carries the post’s canonical absolute URL, trailing-slash normalised',
      ).toBe(canonicalUrl);
      await expect(link, 'it opens in a new tab').toHaveAttribute('target', '_blank');
      const rel = await link.getAttribute('rel');
      expect(rel, 'without handing the opener over').toContain('noopener');
      expect(rel, 'and without leaking the referrer').toContain('noreferrer');

      // Activate it. The stub above answers, so this is deterministic and offline.
      const opening = page.context().waitForEvent('page');
      await link.click();
      await (await opening).close();
    }

    // ---- The copy affordance, in whichever branch this browser puts it -----------------
    const copyLink = bar.getByRole('button', { name: COPY_LINK, exact: true });
    await expect(copyLink, 'copying the link is offered').toBeVisible();

    // A capability probe, not an assertion guard: it detects exactly the condition
    // `share-bar.tsx` itself detects, so the branch asserted below is the branch that ran.
    const clipboardUsable = await page.evaluate(async () => {
      if (typeof navigator.clipboard?.writeText !== 'function') {
        return false;
      }
      try {
        await navigator.clipboard.writeText('');
        return true;
      } catch {
        return false;
      }
    });

    await copyLink.click();
    if (clipboardUsable) {
      await expect(
        page.getByText(COPY_SUCCEEDED_TOAST),
        'the reader is told it copied',
      ).toBeVisible();
      expect(
        await page.evaluate(() => navigator.clipboard.readText()),
        'and what landed on the clipboard is the canonical URL',
      ).toBe(canonicalUrl);
    } else {
      await expect(
        page.getByText(COPY_UNAVAILABLE_TOAST),
        'a browser without a clipboard says so rather than failing silently',
      ).toBeVisible();
      await expect(
        bar.getByText(MANUAL_COPY_PREAMBLE),
        'and offers the link for manual copying',
      ).toBeVisible();
      await expect(
        bar.getByText(canonicalUrl, { exact: true }),
        'which is the same canonical URL',
      ).toBeVisible();
    }

    // ---- The native share sheet: absent when the browser has none ----------------------
    const nativeShare = bar.getByRole('button', { name: NATIVE_SHARE_NAME });
    const browserShares = await page.evaluate(() => typeof navigator.share === 'function');
    await expect(
      nativeShare,
      'the device share control is offered exactly when the browser can share',
    ).toHaveCount(browserShares ? 1 : 0);

    expect(apiCalls, 'no share affordance reaches the API - sharing needs no endpoint').toEqual([]);

    // ---- ...and present, once the browser can share ------------------------------------
    // Installed before the reload so the component's `useSyncExternalStore` snapshot sees it on
    // first paint. The stub records what was handed over, which is the point of the assertion.
    await page.addInitScript(() => {
      const handovers: string[] = [];
      Object.defineProperty(window, '__sharedPayloads', {
        configurable: true,
        get: () => handovers,
      });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: (data: { title?: string; url?: string }): Promise<void> => {
          handovers.push(JSON.stringify({ title: data.title, url: data.url }));
          return Promise.resolve();
        },
      });
    });
    await page.reload();
    await expect(shareBar(page)).toBeVisible();
    await expect(thread(page).getByText(ANONYMOUS_FORM_TITLE)).toBeVisible();
    apiCalls.length = 0;

    const nativeShareOffered = shareBar(page).getByRole('button', { name: NATIVE_SHARE_NAME });
    await expect(
      nativeShareOffered,
      'a browser that can share is offered the control',
    ).toBeVisible();
    await nativeShareOffered.click();
    expect(
      await page.evaluate(
        () => (window as unknown as { __sharedPayloads: string[] }).__sharedPayloads,
      ),
      'and what it hands over is the post’s title and its canonical URL',
    ).toEqual([JSON.stringify({ title: post.title, url: canonicalUrl })]);

    expect(
      apiCalls,
      'and still nothing reached the API - the whole affordance is client-side',
    ).toEqual([]);
  });
});
