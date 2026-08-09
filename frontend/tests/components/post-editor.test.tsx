/* =================================================================================================
 * Component tests for `@/components/blog/post-editor` - the authoring surface for requirement R2,
 * "create, edit, delete, and publish blog posts".
 *
 * WHAT THIS FILE EXISTS TO PROTECT
 *
 * Two of the three contracts asserted below are invisible in the rendered UI, which is exactly why
 * they need a test rather than a review note:
 *
 *  1. **The slug is written once, at creation, and never changes.** It IS the canonical URL the whole
 *     SEO deliverable rests on, so the editor must never offer a slug control and must never send a
 *     `slug` member. Asserting its absence from both the form and the request body is the only guard
 *     there is - a slug field would look harmless on screen and would invalidate every inbound link
 *     and every crawl the first time an author corrected a typo in a title.
 *  2. **Publishing is a state TRANSITION, not a boolean field.** `POST /api/v1/posts/{id}/publish`
 *     stamps `published_at` under the database's own
 *     `CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)`. A `status` member slipping into a
 *     `PATCH` body would let application code produce a published post with no publication date -
 *     precisely the class of defect that constraint exists to make impossible. So every case here
 *     that reaches the wire asserts on the ABSENCE of `status` as well as on the presence of the
 *     transition request.
 *  3. **The update is genuinely partial.** The editor's `PATCH` replaced a whole-object update that
 *     assigned a complete submitted object over the stored row, so omitting a member erased it and a
 *     client holding a stale copy silently reverted every field it had not refreshed. Changing one
 *     field here must put one key on the wire.
 *
 * THE SIX SERVER-OWNED MEMBERS
 *
 * `id`, `slug`, `status`, `published_at`, `view_count` and `author_id` are produced by the service and
 * are not this client's to author. {@link SERVER_OWNED_FIELDS} enumerates them and every wire
 * assertion below checks all six, so adding a seventh field to the form cannot quietly start shipping
 * one of them.
 *
 * HOW THIS FILE IS WIRED, AND THE THREE DECISIONS BEHIND IT
 *
 * 1. **This spec owns the Mock Service Worker lifecycle.** `frontend/vitest.setup.ts` deliberately
 *    owns no server instance - its header assigns `setupServer`, `listen`, `resetHandlers` and
 *    `close` to "the specs that need them" and it imports nothing from `tests/` - and
 *    `tests/msw/handlers.ts` repeats the same division, describing its export as "one flat array,
 *    spread into `setupServer` by whichever spec owns the server lifecycle". There is therefore no
 *    singleton to import and nothing here is a second server. Interception stays at the NETWORK
 *    boundary, which is the point: the real `src/lib/api/client.ts` runs on every request this file
 *    provokes, so its base-URL composition, its bearer attachment, its problem-document
 *    normalisation and its per-endpoint decoding are exercised rather than retired. Mocking
 *    `@/lib/api/posts` instead would have proved the same field-presence contracts while removing
 *    the layer most worth covering.
 * 2. **The bearer credential is seeded through the client's own public API.** Every post mutation
 *    handler answers 401 without an `Authorization` header, and the client reads its bearer from the
 *    in-memory store that `setCredentials` fills. Calling that exported function is using the client
 *    as designed - it is not a mock of it, and no token is built, decoded or asserted on anywhere in
 *    this file. The fixture token is an obvious placeholder string, never a credential.
 * 3. **Only `sonner` and `next/navigation` are mocked, and only because they are hosts this file does
 *    not mount.** There is no `<Toaster />` here, so `toast` would write into nothing; and the App
 *    Router's `useRouter` has no provider outside a Next.js render, so the component's
 *    `router.replace`/`refresh`/`push` calls need a stub to land on.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT ASSERT
 *
 * - **No class, no computed style, no snapshot.** Appearance belongs to the token layer and is free
 *   to change without a test noticing. Every query below resolves an element by its ROLE or its
 *   LABEL, and every state assertion reads an ARIA attribute or visible text.
 * - **No responsive behaviour.** The stacked-versus-side-by-side editor/preview spine is verified at
 *   375, 768 and 1440 pixels in `frontend/tests/e2e/authoring.spec.ts`; jsdom applies no media query,
 *   so an assertion here could only ever be a false negative.
 * - **No sanitisation.** `bleach` sanitises on write in `backend/app/services/post_service.py` and
 *   `rehype-sanitize` sanitises at render. The editor's job is to submit what the author typed, and
 *   one case below asserts precisely that it does.
 * - **No re-test of the Markdown renderer.** `post-content.test.tsx` owns the pipeline. The preview
 *   case here asserts only that the pane reflects what was typed.
 * - **No server-side failure.** The tier's mutation policy is `retry: 0` and its query predicate
 *   refuses to retry 4xx, so every failure case below is a 4xx: deterministic, single-attempt, and
 *   representative of the refusals an author actually meets.
 * ============================================================================================== */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { RequestHandler } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactElement } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PostEditor } from '@/components/blog/post-editor';
import { clearCredentials, setCredentials } from '@/lib/api/client';
import type {
  CategoryPublic,
  PostDetail,
  ProblemDetail,
  UserMe,
  UserPublic,
  ValidationErrorItem,
} from '@/lib/types';
import { AuthContext } from '@/providers/auth-provider';
import type { AuthContextValue } from '@/providers/auth-provider';
import { QueryProvider } from '@/providers/query-provider';

import { fixtureTokenPair, handlers } from '../msw/handlers';

/* -------------------------------------------------------------------------------------------------
 * Module mocks
 *
 * `vi.hoisted` rather than a bare `const`, because `vi.mock` is lifted above every import in the
 * file: a factory closing over an ordinary module-level binding throws
 * "Cannot access '...' before initialization" at collection time, before a single test runs.
 * ---------------------------------------------------------------------------------------------- */

const { routerStub, toastStub } = vi.hoisted(() => ({
  /** The App Router surface this component touches: two navigations and a refresh. */
  routerStub: { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() },
  /** The three `toast` channels the component uses - success, failure and the no-op notice. */
  toastStub: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('next/navigation', () => ({ useRouter: () => routerStub }));
vi.mock('sonner', () => ({ toast: toastStub }));

/* -------------------------------------------------------------------------------------------------
 * Contract vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * The complete set of members the create body may carry, in render order.
 *
 * `postCreateSchema` is a `z.strictObject` over exactly these five keys and `postUpdateSchema` is its
 * `.partial()`, so this tuple is the whole form contract rather than a sample of it.
 */
const FORM_FIELDS = ['title', 'excerpt', 'content', 'cover_image_url', 'category_ids'] as const;

/**
 * The members the service owns, which no request body from this client may carry.
 *
 * Enumerated once and checked by {@link expectNoServerOwnedFields} on every captured body, so the
 * guarantee is uniform across create, update, publish, unpublish and delete instead of being restated
 * per case and forgotten in one of them.
 */
const SERVER_OWNED_FIELDS = [
  'id',
  'slug',
  'status',
  'published_at',
  'view_count',
  'author_id',
] as const;

/** The visible label of each text control, which is also its accessible name. */
const LABEL_TITLE = 'Title';
const LABEL_EXCERPT = 'Excerpt';
const LABEL_CONTENT = 'Content';
const LABEL_COVER_IMAGE = 'Cover image URL';

/** The `title` ceiling `@/lib/validation/post` enforces, in code points. */
const TITLE_MAX_LENGTH = 120;

/**
 * The canonical hyphenated form of a version-4 UUID.
 *
 * Applied to what actually travelled on the wire, not merely to the fixtures it matched: identity is
 * the service's to generate, so a category reference must be an identifier of this shape and never a
 * name, a slug or an integer.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 *
 * Authored here rather than borrowed from the handler module's own fixtures, so that each assertion
 * below reads against a value declared in the same file it is asserted in. Every identifier is a
 * UUID-shaped string because identity is server-generated and never an integer; every timestamp is a
 * fixed ISO-8601 string because JSON carries no date type and a `Date` here would be silently
 * stringified, letting a component that mishandles the string form pass anyway.
 * ---------------------------------------------------------------------------------------------- */

const CATEGORY_ID_ENGINEERING = 'c0a80101-0000-4000-8000-000000000001';
const CATEGORY_ID_DESIGN = 'c0a80101-0000-4000-8000-000000000002';
const CATEGORY_ID_OPERATIONS = 'c0a80101-0000-4000-8000-000000000003';

const engineering: CategoryPublic = {
  id: CATEGORY_ID_ENGINEERING,
  name: 'Engineering',
  slug: 'engineering',
  description: 'Databases, latency, and the unglamorous parts of shipping.',
  post_count: 12,
  created_at: '2024-01-05T09:00:00Z',
};

const design: CategoryPublic = {
  id: CATEGORY_ID_DESIGN,
  name: 'Design',
  slug: 'design',
  description: 'Interface craft, type, and colour that survives a dark theme.',
  post_count: 7,
  created_at: '2024-01-06T09:00:00Z',
};

const operations: CategoryPublic = {
  id: CATEGORY_ID_OPERATIONS,
  name: 'Operations',
  slug: 'operations',
  description: null,
  post_count: 3,
  created_at: '2024-01-07T09:00:00Z',
};

/**
 * The taxonomy as the editor receives it: a BARE array.
 *
 * `GET /api/v1/categories` is the single documented exception to the page envelope across the whole
 * API, so there is no `Page<CategoryPublic>` to unwrap and none is constructed here.
 */
const categories: readonly CategoryPublic[] = [engineering, design, operations];

const AUTHOR_ID = 'a0000000-0000-4000-8000-00000000000a';
const ADMIN_ID = 'a0000000-0000-4000-8000-00000000000b';

const authorPublic: UserPublic = {
  id: AUTHOR_ID,
  username: 'rivera',
  display_name: 'Alex Rivera',
  bio: 'Writes about storage engines and the cost of a cache miss.',
  avatar_url: 'https://avatars.githubusercontent.com/u/4040404?v=4',
  created_at: '2023-11-02T08:00:00Z',
};

const authorAccount: UserMe = {
  ...authorPublic,
  email: 'alex.rivera@example.com',
  role: 'AUTHOR',
  is_active: true,
  updated_at: '2024-04-01T08:00:00Z',
};

const adminAccount: UserMe = {
  id: ADMIN_ID,
  username: 'osei',
  display_name: 'Dana Osei',
  bio: null,
  avatar_url: null,
  created_at: '2023-10-01T08:00:00Z',
  email: 'dana.osei@example.com',
  role: 'ADMIN',
  is_active: true,
  updated_at: '2024-04-02T08:00:00Z',
};

const DRAFT_POST_ID = 'd0000000-0000-4000-8000-00000000000d';
const PUBLISHED_POST_ID = 'e0000000-0000-4000-8000-00000000000e';
const CREATED_POST_ID = 'f0000000-0000-4000-8000-00000000000f';

/**
 * A legitimate draft: `status: 'DRAFT'` with `published_at: null`.
 *
 * The pairing is not incidental. The service's own
 * `CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)` admits exactly this combination and
 * refuses a published row with no instant, so a fixture that carried a date on a draft would describe
 * a state the database tolerates but the product never produces.
 */
const draftPost: PostDetail = {
  id: DRAFT_POST_ID,
  title: 'Notes towards cache invalidation',
  slug: 'notes-towards-cache-invalidation',
  excerpt: 'An outline of the argument, not the argument itself.',
  cover_image_url: 'https://images.unsplash.com/photo-1461749280684-dccba630e2f6',
  status: 'DRAFT',
  published_at: null,
  view_count: 0,
  created_at: '2024-05-05T12:00:00Z',
  author: authorPublic,
  categories: [{ id: engineering.id, name: engineering.name, slug: engineering.slug }],
  content: '## Still an outline\n\nInvalidation is the hard half.\n',
  updated_at: '2024-05-06T09:30:00Z',
};

/** The same post after its publish transition: a status AND an instant, together. */
const publishedPost: PostDetail = {
  ...draftPost,
  id: PUBLISHED_POST_ID,
  title: 'What a cache miss actually costs',
  slug: 'what-a-cache-miss-actually-costs',
  status: 'PUBLISHED',
  published_at: '2024-05-10T12:00:00Z',
  view_count: 431,
  content: '## The measurement\n\nEvery figure below came from the same run.\n',
  updated_at: '2024-05-10T12:00:00Z',
};

/** A post someone else wrote, used to show that no control is hidden from an administrator. */
const otherAuthorsPost: PostDetail = {
  ...draftPost,
  id: 'd0000000-0000-4000-8000-00000000000c',
  title: 'A draft by another author',
  slug: 'a-draft-by-another-author',
  author: {
    id: 'a0000000-0000-4000-8000-00000000000c',
    username: 'nakamura',
    display_name: 'Bo Nakamura',
    bio: null,
    avatar_url: null,
    created_at: '2023-12-01T08:00:00Z',
  },
};

/**
 * A fresh, fully-typed auth context value.
 *
 * A factory rather than two shared constants so no test can observe a call another test made. The
 * component takes no authorisation decision of its own - hiding a control is not a security boundary,
 * and `post_service.py` re-checks ownership on every mutation - so this context is supplied for
 * harness fidelity and to make the administrator case expressible, not because the editor reads it.
 */
function session(user: UserMe): AuthContextValue {
  return {
    user,
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
 * One uniform problem document - the only error shape the API emits, replacing the ad-hoc raises the
 * legacy service repeated at three separate call sites.
 *
 * `request_id` is always populated because the client synthesises a replacement document for any
 * problem body that omits it, which would mask the very `detail` a failure case is asserting on.
 *
 * `errors` is typed as the non-empty tuple `ProblemDetail` declares, so the compiler - not a failing
 * assertion - is what insists each item carries all three of `field`, `message` and `type`. The client
 * drops an item missing any one of them, so an under-specified fixture would silently stop reaching
 * the form.
 */
function problem(
  status: number,
  title: string,
  detail: string,
  instance: string,
  errors?: readonly [ValidationErrorItem, ...ValidationErrorItem[]],
): ProblemDetail {
  const document: ProblemDetail = {
    type: `/errors/${String(status)}`,
    title,
    status,
    detail,
    instance,
    request_id: 'req-00000000-0000-4000-8000-0000000000ff',
  };
  return errors === undefined ? document : { ...document, errors: [...errors] };
}

/* -------------------------------------------------------------------------------------------------
 * Request interception and capture
 *
 * The server is seeded with the shared happy-path handler array and then has this file's capturing
 * overrides layered on top in `beforeEach`. Layering rather than replacing matters: a request this
 * file did not anticipate still reaches a real handler instead of escaping, and `onUnhandledRequest`
 * is `'error'` so anything genuinely unmodelled fails the test loudly rather than silently hitting the
 * network.
 * ---------------------------------------------------------------------------------------------- */

const server = setupServer(...handlers);

/** One intercepted request, reduced to the three things a contract assertion needs. */
interface CapturedRequest {
  readonly method: string;
  readonly pathname: string;
  /** The parsed JSON body, or `null` for a request that carries none - both transitions do not. */
  readonly body: Record<string, unknown> | null;
}

let captured: CapturedRequest[] = [];

/** Narrow parsed JSON to a keyed object without asserting past the compiler. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrow an unknown captured member to the list of strings it should be.
 *
 * The widening through `unknown[]` is deliberate: `Array.isArray` on an `unknown` narrows to `any[]`,
 * and binding that to a typed local is what keeps `any` from leaking into the assertion. It is the
 * same shape `src/lib/api/client.ts` uses when it reads a problem document's `errors` array.
 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: unknown[] = value;
  return items.filter((item): item is string => typeof item === 'string');
}

/**
 * Read a request body without assuming there is one.
 *
 * `request.json()` throws on an empty payload, and the publish, unpublish and delete routes all send
 * nothing at all, so the text is read first and an empty string becomes `null`. That distinction is
 * itself part of the contract being tested: a transition carries no body, which is why no `status`
 * member can hide in one.
 */
async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length === 0) {
    return null;
  }
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : null;
}

async function record(request: Request): Promise<void> {
  captured.push({
    method: request.method,
    pathname: new URL(request.url).pathname,
    body: await readBody(request),
  });
}

/**
 * The capturing overrides for all five post mutations, keyed on this file's own fixtures.
 *
 * Registered for every test so that a case asserting "no request was issued" is checking an empty
 * capture log rather than the absence of a handler, and so a case asserting on a body never depends on
 * which fixture the shared handler array happens to hold.
 */
function captureHandlers(): RequestHandler[] {
  return [
    http.post('*/api/v1/posts', async ({ request }) => {
      await record(request);
      return HttpResponse.json(createdDraft, { status: 201 });
    }),
    http.post('*/api/v1/posts/:postId/publish', async ({ request, params }) => {
      await record(request);
      // Status and instant are set TOGETHER, and only by this route. That pairing is the whole
      // reason publishing is not a form field.
      return HttpResponse.json(
        {
          ...draftPost,
          id: pathId(params.postId),
          status: 'PUBLISHED',
          published_at: PUBLICATION_INSTANT,
        },
        { status: 200 },
      );
    }),
    http.post('*/api/v1/posts/:postId/unpublish', async ({ request, params }) => {
      await record(request);
      // `published_at` is RETAINED: the check constraint requires it only while the status is
      // PUBLISHED, so withdrawing a post does not forget the date it first went out.
      return HttpResponse.json(
        { ...publishedPost, id: pathId(params.postId), status: 'DRAFT' },
        { status: 200 },
      );
    }),
    http.patch('*/api/v1/posts/:postId', async ({ request, params }) => {
      await record(request);
      const submitted = captured[captured.length - 1]?.body ?? {};
      const title = submitted['title'];
      return HttpResponse.json(
        {
          ...draftPost,
          id: pathId(params.postId),
          // The slug is deliberately NOT re-derived from a changed title. A canonical URL is written
          // once at creation; moving it would invalidate every link to and every crawl of the post.
          slug: draftPost.slug,
          title: typeof title === 'string' ? title : draftPost.title,
        },
        { status: 200 },
      );
    }),
    http.delete('*/api/v1/posts/:postId', async ({ request }) => {
      await record(request);
      // 204 with no body at all - resolution is the confirmation, there is nothing to decode.
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}

/** The instant the publish transition stamps, fixed so the transition is assertable on equality. */
const PUBLICATION_INSTANT = '2024-05-10T12:00:00Z';

/** Read a path parameter that msw types as `string | readonly string[]`. */
function pathId(value: string | readonly string[] | undefined): string {
  return typeof value === 'string' ? value : draftPost.id;
}

/**
 * The draft the create route answers with.
 *
 * Its `id` and `slug` are the SERVER's - a generated identifier and a slug derived from the title at
 * creation. Neither was submitted, and the editor adopting them is what proves the round trip.
 */
const createdDraft: PostDetail = {
  ...draftPost,
  id: CREATED_POST_ID,
  title: 'A post created by a test',
  slug: 'a-post-created-by-a-test',
  status: 'DRAFT',
  published_at: null,
};

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

beforeEach(() => {
  captured = [];
  routerStub.push.mockClear();
  routerStub.refresh.mockClear();
  routerStub.replace.mockClear();
  toastStub.error.mockClear();
  toastStub.info.mockClear();
  toastStub.success.mockClear();
  // The real client's in-memory credential store, filled through its own exported API so that the
  // genuine bearer-attachment path runs and the handlers' 401 gate is satisfied honestly. The value
  // is an obvious placeholder string; nothing here builds, decodes or asserts on a token.
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
  /** Defaults to the post's own author; pass {@link adminAccount} for the administrator case. */
  readonly account?: UserMe;
  readonly categories?: readonly CategoryPublic[];
  readonly post?: PostDetail;
}

/**
 * Mount the editor inside the providers a `(dashboard)` route would give it.
 *
 * The REAL {@link QueryProvider} is used rather than a bespoke client, so the tier's own
 * `defaultOptions` apply - notably `mutations: { retry: 0 }`, which is what makes every failure case
 * below a single deterministic attempt. `AuthContext.Provider` is used directly rather than
 * `AuthProvider`, because the real provider performs a session restore over HTTP that has nothing to
 * do with this component and `useAuth` throws outside a provider.
 */
function renderPostEditor(options: RenderOptions = {}): void {
  const account = options.account ?? authorAccount;
  const taxonomy = [...(options.categories ?? categories)];
  const post = options.post;

  const tree: ReactElement =
    post === undefined ? (
      <PostEditor categories={taxonomy} mode="create" />
    ) : (
      <PostEditor categories={taxonomy} mode="edit" post={post} />
    );

  render(
    <QueryProvider>
      <AuthContext.Provider value={session(account)}>{tree}</AuthContext.Provider>
    </QueryProvider>,
  );
}

/* -------------------------------------------------------------------------------------------------
 * Query and assertion helpers
 * ---------------------------------------------------------------------------------------------- */

const titleField = (): HTMLElement => screen.getByLabelText(LABEL_TITLE);
const excerptField = (): HTMLElement => screen.getByLabelText(LABEL_EXCERPT);
const contentField = (): HTMLElement => screen.getByLabelText(LABEL_CONTENT);
const coverImageField = (): HTMLElement => screen.getByLabelText(LABEL_COVER_IMAGE);
const action = (name: string | RegExp): HTMLElement => screen.getByRole('button', { name });
const previewPane = (): HTMLElement => screen.getByRole('region', { name: 'Preview' });

/** Type into a control the way a keystroke does, then leave it so `onBlur` validation runs. */
function type(field: HTMLElement, value: string): void {
  fireEvent.change(field, { target: { value } });
}

/** Press the toggle whose accessible name is the category's own name. */
function toggleCategory(category: CategoryPublic): void {
  fireEvent.click(
    within(screen.getByRole('group', { name: 'Categories' })).getByRole('button', {
      name: category.name,
    }),
  );
}

function requestsTo(method: string, pathname: string): CapturedRequest[] {
  return captured.filter((entry) => entry.method === method && entry.pathname === pathname);
}

function onlyRequest(): CapturedRequest {
  expect(captured).toHaveLength(1);
  const [first] = captured;
  if (first === undefined) {
    throw new Error('Expected exactly one intercepted request.');
  }
  return first;
}

/** The body of a captured request, proven present so the caller can assert on its members. */
function bodyOf(entry: CapturedRequest): Record<string, unknown> {
  const { body } = entry;
  if (body === null) {
    throw new Error(`Expected ${entry.method} ${entry.pathname} to carry a JSON body.`);
  }
  return body;
}

/**
 * Assert that none of the six server-owned members appears anywhere in the request.
 *
 * Applied to a body AND to a bodiless transition, because "there is no body" is the strongest possible
 * form of the same guarantee.
 */
function expectNoServerOwnedFields(entry: CapturedRequest): void {
  const { body } = entry;
  if (body === null) {
    return;
  }
  for (const field of SERVER_OWNED_FIELDS) {
    expect(body).not.toHaveProperty(field);
  }
}

/** Assert every request this test provoked is free of the six server-owned members. */
function expectNoServerOwnedFieldsAnywhere(): void {
  for (const entry of captured) {
    expectNoServerOwnedFields(entry);
  }
}

/* =================================================================================================
 * Cases
 * ============================================================================================== */

describe('PostEditor', () => {
  describe('create mode - the form surface', () => {
    it('renders exactly the five declared fields, each reachable by its label', () => {
      renderPostEditor();

      // The four text controls, resolved by their visible label - which is also their accessible
      // name, because `Label`'s `htmlFor` reaches the DOM untouched.
      expect(titleField()).toBeInTheDocument();
      expect(excerptField()).toBeInTheDocument();
      expect(contentField()).toBeInTheDocument();
      expect(coverImageField()).toBeInTheDocument();

      // The fifth field is `category_ids`, an ARRAY, so it is a group of toggles rather than a
      // single-value picker. The group takes its accessible name from a real `legend`.
      const group = screen.getByRole('group', { name: 'Categories' });
      for (const category of categories) {
        expect(within(group).getByRole('button', { name: category.name })).toHaveAttribute(
          'aria-pressed',
          'false',
        );
      }

      // Exactly four text controls exist, and they are exactly the four labelled above. This is the
      // upper bound on the form: a fifth text control could not hide behind an unfamiliar label.
      const textboxes = screen.getAllByRole('textbox');
      expect(textboxes).toHaveLength(FORM_FIELDS.length - 1);
      expect(textboxes).toEqual([titleField(), excerptField(), contentField(), coverImageField()]);
    });

    it('offers no control for any server-owned field', () => {
      renderPostEditor();

      // The positive statement that the slug is derived server-side and immutable, that identity is
      // the service's to generate, and that publishing is not a form toggle. `queryAllBy` rather
      // than `queryBy` so a hypothetical duplicate reports as a length rather than as a throw.
      for (const pattern of [/slug/i, /status/i, /published/i, /view count/i, /author/i, /^id$/i]) {
        expect(screen.queryAllByLabelText(pattern)).toHaveLength(0);
      }

      // Nor is the lifecycle expressible through any other control shape.
      expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
      expect(screen.queryAllByRole('switch')).toHaveLength(0);
      expect(screen.queryAllByRole('radio')).toHaveLength(0);
      expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    });

    it('offers Save draft, Publish and Cancel, and no Delete until a post exists', () => {
      renderPostEditor();

      expect(action('Save draft')).toBeEnabled();
      // Publish IS available before a draft exists: it creates and then publishes, which is two
      // requests rather than one field.
      expect(action('Publish')).toBeEnabled();
      expect(action('Cancel')).toBeEnabled();

      // Nothing to delete and nothing to withdraw until something has been persisted.
      expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Unpublish' })).toBeNull();
      // No status badge either, because there is no stored status to report.
      expect(screen.queryByText('DRAFT')).toBeNull();
      expect(screen.queryByText('PUBLISHED')).toBeNull();
    });

    it('shows a placeholder in the preview pane until something is written', () => {
      renderPostEditor();

      expect(previewPane()).toHaveTextContent(/Nothing to preview yet/);
    });
  });

  describe('validation', () => {
    it('rejects an empty title and issues no request', async () => {
      renderPostEditor();
      type(contentField(), 'A body that is perfectly acceptable on its own.');

      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(titleField()).toHaveAttribute('aria-invalid', 'true');
      });
      // The message is TEXT wired to the control through `aria-describedby`, so it is reachable by
      // assistive technology rather than conveyed by colour alone.
      expect(screen.getByText('Enter a title for this post.')).toBeInTheDocument();
      expect(titleField()).toHaveAccessibleDescription(/Enter a title for this post\./);
      expect(captured).toHaveLength(0);
    });

    it('rejects content that is only whitespace and issues no request', async () => {
      renderPostEditor();
      type(titleField(), 'A title with no body behind it');
      type(contentField(), '   \n  ');

      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(contentField()).toHaveAttribute('aria-invalid', 'true');
      });
      expect(
        screen.getByText('Enter the post content. It cannot be empty or only spaces.'),
      ).toBeInTheDocument();
      expect(captured).toHaveLength(0);
    });

    it('rejects a title beyond the declared bound and accepts one exactly at it', async () => {
      renderPostEditor();
      type(titleField(), 'x'.repeat(TITLE_MAX_LENGTH + 1));
      type(contentField(), 'A body long enough to be a post.');

      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(titleField()).toHaveAttribute('aria-invalid', 'true');
      });
      expect(
        screen.getByText(`Title must be ${String(TITLE_MAX_LENGTH)} characters or fewer.`),
      ).toBeInTheDocument();
      expect(captured).toHaveLength(0);

      // The bound is a ceiling, not an off-by-one: the longest permitted title is accepted.
      type(titleField(), 'y'.repeat(TITLE_MAX_LENGTH));
      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });
      expect(bodyOf(onlyRequest())['title']).toBe('y'.repeat(TITLE_MAX_LENGTH));
    });

    it('rejects a cover image address that is not an absolute http(s) URL', async () => {
      renderPostEditor();
      type(titleField(), 'A post with a broken cover reference');
      type(contentField(), 'The body is fine; the cover address is not.');
      type(coverImageField(), 'not-a-web-address');

      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(coverImageField()).toHaveAttribute('aria-invalid', 'true');
      });
      expect(captured).toHaveLength(0);
    });

    it('accepts a well-formed cover image address', async () => {
      const cover = 'https://images.unsplash.com/photo-1461749280684-dccba630e2f6';
      renderPostEditor();
      type(titleField(), 'A post with a valid cover reference');
      type(contentField(), 'Cover images are URL references; there is no upload.');
      type(coverImageField(), cover);

      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });
      expect(bodyOf(onlyRequest())['cover_image_url']).toBe(cover);
      expect(coverImageField()).not.toHaveAttribute('aria-invalid');
    });
  });

  describe('create - POST /api/v1/posts', () => {
    it('submits exactly the five declared members and none the service owns', async () => {
      renderPostEditor();
      type(titleField(), 'A post created by a test');
      type(excerptField(), 'A one-line summary for the feed card.');
      type(contentField(), '## A heading\n\nAnd a paragraph beneath it.\n');
      type(coverImageField(), 'https://picsum.photos/seed/editor/1200/630');
      toggleCategory(design);

      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });

      const request = onlyRequest();
      expect(request.method).toBe('POST');
      // Versioned, and keyed on nothing: a create has no identifier to address.
      expect(request.pathname).toBe('/api/v1/posts');

      const body = bodyOf(request);
      // The whole contract, both halves at once: exactly these keys, and no others.
      expect(Object.keys(body).sort()).toEqual([...FORM_FIELDS].sort());
      expect(body['title']).toBe('A post created by a test');
      expect(body['excerpt']).toBe('A one-line summary for the feed card.');
      expect(body['content']).toBe('## A heading\n\nAnd a paragraph beneath it.\n');
      expect(body['cover_image_url']).toBe('https://picsum.photos/seed/editor/1200/630');
      expectNoServerOwnedFields(request);
    });

    it('sends the chosen category as its UUID identifier, never its name or its slug', async () => {
      renderPostEditor();
      type(titleField(), 'A post filed under two categories');
      type(contentField(), 'Category membership is a set, so order carries no meaning.');
      toggleCategory(engineering);
      toggleCategory(operations);

      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });

      const ids = bodyOf(onlyRequest())['category_ids'];
      expect(ids).toEqual([engineering.id, operations.id]);
      // Identity is a server-generated UUID. A name or a slug on the wire here would mean the client
      // had invented an identifier the association table cannot resolve.
      expect(ids).not.toContain(engineering.name);
      expect(ids).not.toContain(engineering.slug);
      expect(ids).not.toContain(operations.name);
      expect(ids).not.toContain(operations.slug);

      // And the shape of what actually travelled, rather than of the fixtures it happened to match.
      const wireIds = toStringArray(ids);
      expect(wireIds).toHaveLength(2);
      for (const id of wireIds) {
        expect(id).toMatch(UUID_PATTERN);
      }
    });

    it('normalises the untouched optional members to null and an empty list', async () => {
      renderPostEditor();
      type(titleField(), 'A post with only the two required members');
      type(contentField(), 'No excerpt, no cover image, no categories.');

      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });

      const body = bodyOf(onlyRequest());
      // The create body enumerates all five keys, folding a cleared control to the single
      // representation the service uses - `null` for the two nullable members - so "absent" and
      // "empty" never become two spellings of one state.
      expect(Object.keys(body).sort()).toEqual([...FORM_FIELDS].sort());
      expect(body['excerpt']).toBeNull();
      expect(body['cover_image_url']).toBeNull();
      expect(body['category_ids']).toEqual([]);
      expectNoServerOwnedFields(onlyRequest());
    });

    it('adopts the created draft, so a second press cannot create a second post', async () => {
      renderPostEditor();
      type(titleField(), 'A post created by a test');
      type(contentField(), 'The editor rebinds itself the instant the create succeeds.');

      fireEvent.click(action('Save draft'));

      // The action relabels once a post exists behind the form.
      expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
      // And the two affordances that need a stored post appear.
      expect(action('Delete')).toBeInTheDocument();
      expect(screen.getByText('DRAFT')).toBeInTheDocument();
      // The canonical URL is the SERVER's, derived from the title at creation and only displayed.
      expect(screen.getByText(`/blog/${createdDraft.slug}`)).toBeInTheDocument();
      expect(routerStub.replace).toHaveBeenCalledWith(`/dashboard/posts/${CREATED_POST_ID}/edit`);

      // A second press now diffs against the created post, finds nothing changed, and writes nothing.
      fireEvent.click(action('Save'));
      await waitFor(() => {
        expect(toastStub.info).toHaveBeenCalledWith('Nothing has changed since the last save.');
      });
      expect(requestsTo('POST', '/api/v1/posts')).toHaveLength(1);
    });
  });

  describe('edit - PATCH /api/v1/posts/{id}', () => {
    it('pre-fills every field from the post and reflects its categories as pressed', () => {
      renderPostEditor({ post: draftPost });

      expect(titleField()).toHaveValue(draftPost.title);
      expect(excerptField()).toHaveValue(draftPost.excerpt);
      expect(contentField()).toHaveValue(draftPost.content);
      expect(coverImageField()).toHaveValue(draftPost.cover_image_url);

      const group = screen.getByRole('group', { name: 'Categories' });
      // The post is filed under Engineering only, and membership is carried by `aria-pressed`.
      expect(within(group).getByRole('button', { name: engineering.name })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(within(group).getByRole('button', { name: design.name })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      expect(within(group).getByRole('button', { name: operations.name })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    it('displays the derived canonical URL as text rather than as an editable field', () => {
      renderPostEditor({ post: draftPost });

      // Visible so an author knows the address their post lives at - and only visible, because the
      // slug is written once by the service at creation and is the canonical URL SEO depends on.
      expect(screen.getByText(`/blog/${draftPost.slug}`)).toBeInTheDocument();
      expect(screen.queryAllByLabelText(/slug/i)).toHaveLength(0);
      expect(screen.getAllByRole('textbox')).toHaveLength(FORM_FIELDS.length - 1);
      for (const textbox of screen.getAllByRole('textbox')) {
        expect(textbox).not.toHaveValue(draftPost.slug);
      }
    });

    it('patches only the member that changed, keyed on the UUID identifier', async () => {
      renderPostEditor({ post: draftPost });
      type(titleField(), 'Notes towards cache invalidation, revised');

      fireEvent.click(action('Save'));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });

      const request = onlyRequest();
      expect(request.method).toBe('PATCH');
      // Mutations key on the UUID; only the detail read keys on the slug.
      expect(request.pathname).toBe(`/api/v1/posts/${DRAFT_POST_ID}`);
      expect(request.pathname).not.toContain(draftPost.slug);

      // A GENUINE partial update. This is what replaces the whole-object handler at
      // `app.py:L34-L40`, which assigned a complete submitted object over the stored row - so
      // omitting a member erased it, and a stale client silently reverted every field it held.
      // One edited field, one key on the wire.
      const body = bodyOf(request);
      expect(Object.keys(body)).toEqual(['title']);
      expect(body['title']).toBe('Notes towards cache invalidation, revised');
      expectNoServerOwnedFields(request);
    });

    it('reports an unchanged save without issuing a request', async () => {
      renderPostEditor({ post: draftPost });

      fireEvent.click(action('Save'));

      await waitFor(() => {
        expect(toastStub.info).toHaveBeenCalledWith('Nothing has changed since the last save.');
      });
      // An empty patch is a no-op, so the editor declines to send one at all.
      expect(captured).toHaveLength(0);
    });

    it('clears a nullable member with an explicit null when the author empties it', async () => {
      renderPostEditor({ post: draftPost });
      type(excerptField(), '');

      fireEvent.click(action('Save'));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });

      // `undefined` would mean "leave it alone"; an emptied control means "clear it", and the two
      // intents are distinct on a partial update.
      const body = bodyOf(onlyRequest());
      expect(Object.keys(body)).toEqual(['excerpt']);
      expect(body['excerpt']).toBeNull();
      expectNoServerOwnedFields(onlyRequest());
    });
  });

  /* -----------------------------------------------------------------------------------------------
   * The signature contract of requirement R2.
   *
   * Publishing sets a status AND a publication instant, together, under the database's own
   * `CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)`. Expressing it as a form field would
   * let a `PATCH` produce a published post with no date - the exact state that constraint exists to
   * forbid - so it is a route of its own, and these cases assert both halves: the transition request
   * was made, and no request body anywhere carried `status`.
   * -------------------------------------------------------------------------------------------- */
  describe('publish lifecycle', () => {
    it('publishes through its own route, with no status member in any body', async () => {
      renderPostEditor({ post: draftPost });

      fireEvent.click(action('Publish'));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });

      // An unmodified draft needs no write before publication, so the transition is the ONLY request.
      const request = onlyRequest();
      expect(request.method).toBe('POST');
      expect(request.pathname).toBe(`/api/v1/posts/${DRAFT_POST_ID}/publish`);
      // No body at all - the strongest possible form of "no status member".
      expect(request.body).toBeNull();
      expectNoServerOwnedFieldsAnywhere();

      // The UI adopts the returned representation: a published status and a real instant.
      expect(await screen.findByText('PUBLISHED')).toBeInTheDocument();
      expect(screen.queryByText('DRAFT')).toBeNull();
      // And the affordance flips, because a published post can only be withdrawn.
      expect(action('Unpublish')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
      expect(toastStub.success).toHaveBeenCalledWith('Post published.');
    });

    it('saves the body first when publishing an edited draft, and still sends no status', async () => {
      renderPostEditor({ post: draftPost });
      type(titleField(), 'Notes towards cache invalidation, final');

      fireEvent.click(action('Publish'));

      await waitFor(() => {
        expect(captured).toHaveLength(2);
      });

      // Publishing always saves first: making content public with a stale body would expose the
      // wrong text. Two requests, and the lifecycle still travels only in the second one's PATH.
      const [save, transition] = captured;
      if (save === undefined || transition === undefined) {
        throw new Error('Expected a save followed by a publish transition.');
      }
      expect(save.method).toBe('PATCH');
      expect(save.pathname).toBe(`/api/v1/posts/${DRAFT_POST_ID}`);
      expect(Object.keys(bodyOf(save))).toEqual(['title']);
      expect(transition.pathname).toBe(`/api/v1/posts/${DRAFT_POST_ID}/publish`);
      expect(transition.body).toBeNull();
      expectNoServerOwnedFieldsAnywhere();
    });

    it('publishes a brand-new post as a create followed by a transition', async () => {
      renderPostEditor();
      type(titleField(), 'A post created by a test');
      type(contentField(), 'Created and published in two requests, never in one field.');

      fireEvent.click(action('Publish'));

      await waitFor(() => {
        expect(captured).toHaveLength(2);
      });

      const [create, transition] = captured;
      if (create === undefined || transition === undefined) {
        throw new Error('Expected a create followed by a publish transition.');
      }
      expect(create.method).toBe('POST');
      expect(create.pathname).toBe('/api/v1/posts');
      // The create body is still exactly the five form members - creation never publishes.
      expect(Object.keys(bodyOf(create)).sort()).toEqual([...FORM_FIELDS].sort());

      // The transition is keyed on the identifier the SERVER generated for the new draft.
      expect(transition.method).toBe('POST');
      expect(transition.pathname).toBe(`/api/v1/posts/${CREATED_POST_ID}/publish`);
      expect(transition.body).toBeNull();
      expectNoServerOwnedFieldsAnywhere();
    });

    it('withdraws a published post through its own route', async () => {
      renderPostEditor({ post: publishedPost });

      // A published post offers withdrawal rather than publication.
      expect(action('Unpublish')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
      expect(screen.getByText('PUBLISHED')).toBeInTheDocument();

      fireEvent.click(action('Unpublish'));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });

      const request = onlyRequest();
      expect(request.method).toBe('POST');
      expect(request.pathname).toBe(`/api/v1/posts/${PUBLISHED_POST_ID}/unpublish`);
      expect(request.body).toBeNull();
      expectNoServerOwnedFieldsAnywhere();

      // The UI adopts the returned draft state.
      expect(await screen.findByText('DRAFT')).toBeInTheDocument();
      expect(screen.queryByText('PUBLISHED')).toBeNull();
      expect(action('Publish')).toBeInTheDocument();
    });
  });

  describe('delete', () => {
    it('confirms before issuing any request, and issues none when dismissed', async () => {
      renderPostEditor({ post: draftPost });

      fireEvent.click(action('Delete'));

      // Radix portals the panel, so it is reached through `screen` rather than through the form.
      const dialog = await screen.findByRole('dialog');
      // The accessible name comes from `DialogTitle`, which is why that element always renders.
      expect(dialog).toHaveAccessibleName('Delete this post?');
      // The confirmation names the cascade before anything irreversible happens.
      expect(dialog).toHaveTextContent(/comments and likes are deleted with it/);
      // Nothing has been sent merely by asking.
      expect(captured).toHaveLength(0);

      fireEvent.click(within(dialog).getByRole('button', { name: 'Keep the post' }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(captured).toHaveLength(0);
      // The post is still there to edit.
      expect(action('Delete')).toBeInTheDocument();
    });

    it('issues the delete once confirmed and accepts a bodiless 204', async () => {
      renderPostEditor({ post: draftPost });

      fireEvent.click(action('Delete'));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });

      const request = onlyRequest();
      expect(request.method).toBe('DELETE');
      expect(request.pathname).toBe(`/api/v1/posts/${DRAFT_POST_ID}`);
      // 204 No Content: there is nothing to decode, and resolution is the confirmation.
      expect(request.body).toBeNull();
      expect(toastStub.success).toHaveBeenCalledWith(
        'Post deleted, along with its comments and likes.',
      );
      expect(routerStub.replace).toHaveBeenCalledWith('/dashboard');
    });
  });

  describe('preview', () => {
    it('reflects the typed Markdown through the shared reader-facing renderer', async () => {
      renderPostEditor();

      type(contentField(), '## How this renders\n\n- first point\n- second point\n');

      // `PostContent` downshifts authored headings so no `h1` can escape a draft into the page: an
      // authored `##` therefore arrives as a level-3 heading. The pipeline itself belongs to
      // `post-content.test.tsx`; all that matters here is that the pane reflects what was typed.
      expect(
        await screen.findByRole('heading', { level: 3, name: 'How this renders' }),
      ).toBeInTheDocument();

      const pane = previewPane();
      expect(within(pane).getAllByRole('listitem')).toHaveLength(2);
      expect(pane).toHaveTextContent('first point');
      expect(pane).not.toHaveTextContent(/Nothing to preview yet/);
    });

    it('lists the selected categories in the preview as the reader will see them', async () => {
      renderPostEditor();

      toggleCategory(design);

      const pills = await within(previewPane()).findByRole('navigation', { name: 'Categories' });
      expect(within(pills).getByRole('link', { name: design.name })).toBeInTheDocument();
    });

    it('submits the authored content verbatim, leaving sanitisation to its two owners', async () => {
      const authored = 'A paragraph with <b>bold</b> markup left exactly as typed.';
      renderPostEditor();
      type(titleField(), 'A post whose body is passed through untouched');
      type(contentField(), authored);

      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });

      // The editor is not a sanitiser and must not become one: `bleach` sanitises on write in
      // `backend/app/services/post_service.py`, and `rehype-sanitize` sanitises at render. A form
      // that silently rewrote an author's markup would disagree with both.
      expect(bodyOf(onlyRequest())['content']).toBe(authored);
    });
  });

  describe('authority and failure', () => {
    it('offers every mutation control to an administrator on a post by another author', () => {
      renderPostEditor({ account: adminAccount, post: otherAuthorsPost });

      // A user-experience assertion, not a security one. Hiding a control is not a boundary: the
      // route group and the middleware gate arrival, and `post_service.py` re-checks ownership -
      // owner or ADMIN - on every mutation it serves.
      expect(action('Save')).toBeEnabled();
      expect(action('Publish')).toBeEnabled();
      expect(action('Delete')).toBeEnabled();
      expect(titleField()).toHaveValue(otherAuthorsPost.title);
    });

    it('keeps the typed values in the form when the update is refused with 403', async () => {
      server.use(
        http.patch('*/api/v1/posts/:postId', () =>
          HttpResponse.json(
            problem(
              403,
              'Forbidden',
              'You may only edit posts you wrote.',
              `/api/v1/posts/${DRAFT_POST_ID}`,
            ),
            { status: 403 },
          ),
        ),
      );
      const revised = 'A revision the service refuses to store';
      renderPostEditor({ post: draftPost });
      type(titleField(), revised);

      fireEvent.click(action('Save'));

      // `destructive` derives `role="alert"` from its variant, so the failure is announced without
      // this file - or the component - authoring a role or an `aria-live`.
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('You may only edit posts you wrote.');
      expect(toastStub.error).toHaveBeenCalledWith('Could not save this post.');

      // A refused submission must never cost an author their work.
      expect(titleField()).toHaveValue(revised);
      expect(contentField()).toHaveValue(draftPost.content);
    });

    it('surfaces a 409 conflict through the one normalised error contract', async () => {
      server.use(
        http.patch('*/api/v1/posts/:postId', () =>
          HttpResponse.json(
            problem(
              409,
              'Conflict',
              'Another post already uses that title.',
              `/api/v1/posts/${DRAFT_POST_ID}`,
            ),
            { status: 409 },
          ),
        ),
      );
      const revised = 'A title that collides with another post';
      renderPostEditor({ post: draftPost });
      type(titleField(), revised);

      fireEvent.click(action('Save'));

      const alert = await screen.findByRole('alert');
      // `detail` is the sentence about THIS request, and it is preferred over the generic `title`.
      expect(alert).toHaveTextContent('Another post already uses that title.');
      // The legacy `{"message": ..., "data": ...}` envelope has no reader: there is one error shape.
      expect(alert).not.toHaveTextContent('message');
      expect(titleField()).toHaveValue(revised);
    });

    it('pins a 422 field failure onto its own control and summarises the rest', async () => {
      server.use(
        http.patch('*/api/v1/posts/:postId', () =>
          HttpResponse.json(
            problem(
              422,
              'Unprocessable Entity',
              'The submitted post could not be stored.',
              `/api/v1/posts/${DRAFT_POST_ID}`,
              [{ field: 'body.title', message: 'That title is reserved.', type: 'value_error' }],
            ),
            { status: 422 },
          ),
        ),
      );
      const revised = 'A reserved title';
      renderPostEditor({ post: draftPost });
      type(titleField(), revised);

      fireEvent.click(action('Save'));

      // The qualified path `body.title` resolves onto the control the author can actually see, so the
      // message lands beside it instead of only in the banner.
      await waitFor(() => {
        expect(titleField()).toHaveAttribute('aria-invalid', 'true');
      });
      expect(screen.getByText('That title is reserved.')).toBeInTheDocument();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        /Check the highlighted fields for details\./,
      );
      expect(titleField()).toHaveValue(revised);
    });

    it('guards submission while a request is in flight, so a double press writes once', async () => {
      // A gate rather than a timer: the request is held open until this test releases it, so the
      // in-flight window is deterministic and nothing here waits on the clock.
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      server.use(
        http.post('*/api/v1/posts', async ({ request }) => {
          await record(request);
          await gate;
          return HttpResponse.json(createdDraft, { status: 201 });
        }),
      );

      renderPostEditor();
      type(titleField(), 'A post created by a test');
      type(contentField(), 'One press, one post.');

      fireEvent.click(action('Save draft'));

      // Every control is disabled for the duration, and the pressed one reports its own progress.
      const pending = await screen.findByRole('button', { name: 'Saving draft…' });
      expect(pending).toBeDisabled();
      expect(action('Publish')).toBeDisabled();
      expect(action('Cancel')).toBeDisabled();

      // An impatient second and third press cannot enqueue a second create.
      fireEvent.click(pending);
      fireEvent.click(action('Publish'));

      release();

      await waitFor(() => {
        expect(toastStub.success).toHaveBeenCalledWith('Draft saved.');
      });
      expect(requestsTo('POST', '/api/v1/posts')).toHaveLength(1);
      expect(captured).toHaveLength(1);
    });
  });
});
