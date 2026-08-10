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
 *
 * This is the COMPLETE inventory `@/lib/validation/post` refuses, not a sample of it, and each entry
 * is refused for its own reason - which is what stops the wrong one being helpfully added back later:
 *
 * | Member         | Why a request body may not carry it                                            |
 * | -------------- | ------------------------------------------------------------------------------ |
 * | `id`           | A UUID generated by PostgreSQL. Client-supplied identity is the defect class    |
 * |                | this product removed: two rows under one identifier, the first shadowing the    |
 * |                | second on every read, update and delete.                                        |
 * | `slug`         | Derived from the title once, server-side, and then never moved. The slug IS the |
 * |                | canonical URL, so an editable one would break every published and crawled link. |
 * | `status`       | Half of a paired change. `POST /posts/{id}/publish` sets both members together, |
 * | `published_at` | and a database CHECK constraint forbids a published post with no instant.       |
 * | `view_count`   | A server-maintained counter. A counter a client could set is not a counter.     |
 * | `author_id`    | Taken from the principal the API resolved from the bearer. Reading ownership out |
 * |                | of a body would let any caller publish under another account's byline.          |
 * | `created_at`   | Stamped from the database clock. An audit column a caller could set is not an   |
 * | `updated_at`   | audit column.                                                                  |
 *
 * The last two were absent from an earlier version of this tuple, and their absence was the gap worth
 * closing: both arrive on every `PostDetail` the editor adopts, so a change that echoed the whole
 * response back into a patch body would have been caught for six members and waved through for two.
 */
const SERVER_OWNED_FIELDS = [
  'id',
  'slug',
  'status',
  'published_at',
  'view_count',
  'author_id',
  'created_at',
  'updated_at',
] as const;

/** The visible label of each text control, which is also its accessible name. */
const LABEL_TITLE = 'Title';
const LABEL_EXCERPT = 'Excerpt';
const LABEL_CONTENT = 'Content';
const LABEL_COVER_IMAGE = 'Cover image URL';

/* -------------------------------------------------------------------------------------------------
 * The bounds `@/lib/validation/post` enforces, restated as an independent oracle
 *
 * Every one of these is measured in CODE POINTS rather than in UTF-16 units, which is the whole reason
 * they are worth testing on both sides. `String.prototype.length` counts units, so a hundred code
 * points of an astral script measure two hundred to it and one hundred to the service - and a schema
 * written with `.max()` instead of a `codePointLength` refinement would silently halve an author's
 * allowance for every script outside the Basic Multilingual Plane while passing every ASCII test.
 *
 * Restated as literals rather than imported, deliberately: the module keeps them private, and a test
 * that imported the same constant it is checking would agree with any value the module happened to
 * hold. A literal here disagrees, which is what makes a changed bound a failing test rather than a
 * silently relaxed one.
 * ---------------------------------------------------------------------------------------------- */

/** The `title` ceiling, in code points. */
const TITLE_MAX_LENGTH = 120;

/** The `excerpt` ceiling, in code points. Optional field, bounded when supplied. */
const EXCERPT_MAX_LENGTH = 500;

/** The `content` ceiling, in code points - the field where the unit-versus-point divergence bites. */
const CONTENT_MAX_LENGTH = 100_000;

/**
 * The `cover_image_url` ceiling, in code points.
 *
 * This is the SERVER's own bound restated: `pydantic.HttpUrl` carries an inherent 2083-character limit
 * and publishes it as `maxLength`, so a longer address is a `422` - and without a matching check here
 * it would be a `422` arriving after a full submission of a post the author had finished writing.
 */
const COVER_IMAGE_URL_MAX_LENGTH = 2083;

/** How many categories one post may be filed under. Declared on the shared schema, so both forms cap. */
const MAX_CATEGORIES_PER_POST = 10;

/**
 * One code point outside the Basic Multilingual Plane: U+1F600, which is two UTF-16 units.
 *
 * Written as the escape rather than as the glyph so the file's own encoding cannot be what a boundary
 * case is really measuring.
 */
const ASTRAL_CODE_POINT = '\u{1F600}';

/**
 * Cover addresses the form must refuse, each for its own reason.
 *
 * The first two are the reason this field is validated at all: a `javascript:` or `data:` URL that
 * survived validation would be stored and later placed in an `img` src. The next three are malformed
 * rather than hostile, and each is a distinct failure mode - a scheme the service does not accept, an
 * address that is not absolute, and an absolute address with no host at all.
 *
 * THE LAST THREE ARE THE HOST POLICY, and they are refusals rather than acceptances deliberately. The
 * service accepts any absolute `http(s)` URL, but this tier renders a cover only through
 * `isAllowedImageUrl` - `https`, no embedded credentials, and a hostname on `IMAGE_HOST_ALLOWLIST` -
 * and `next.config.ts` derives the image optimiser's `remotePatterns` from that same constant. A cover
 * on any other host therefore validated, saved, and then silently never appeared, while the OpenGraph
 * and `BlogPosting` metadata still advertised it. Refusing at the authoring boundary turns a
 * saved-but-never-rendered state with no message anywhere into an inline error the author can act on,
 * which is why `plain http` and the two loopback addresses belong here: neither is fetchable by the
 * optimiser, so accepting them would be the form promising something the product cannot do.
 *
 * Every entry is taken from the verified table in `@/lib/validation/post`, so this list and the schema
 * describe the same policy rather than two overlapping guesses at it.
 */
const REJECTED_COVER_URLS = [
  ['javascript:alert(1)'],
  ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='],
  ['ftp://example.com/cover.png'],
  ['/covers/cover.png'],
  ['http://'],
  ['not-a-web-address'],
  ['https://example.com/cover.png'],
  ['http://localhost:3000/cover.png'],
  ['http://127.0.0.1/cover.png'],
] as const;

/**
 * Cover addresses the form must ACCEPT, and the half of the contract that is easiest to get wrong.
 *
 * A rule stricter than the policy is a defect in its own right: it refuses a value the product would
 * have rendered, with a message the author cannot act on. So the acceptances are drawn from
 * `IMAGE_HOST_ALLOWLIST` itself - one host per entry, over TLS and without embedded credentials - and a
 * host removed from that constant fails here rather than in production.
 */
const ACCEPTED_COVER_URLS = [
  ['https://images.unsplash.com/photo-1.png'],
  ['https://picsum.photos/1200/630'],
  ['https://res.cloudinary.com/demo/image/upload/cover.png'],
] as const;

/**
 * An `https` address of exactly `length` code points, padded in the path.
 *
 * The padding goes in the path rather than the host so the value stays a well-formed URL at every
 * length: only the ceiling is under test, and a 2084-code-point value that also failed the URL rules
 * would prove nothing about the ceiling.
 */
function coverUrlOfLength(length: number): string {
  // An ALLOW-LISTED host, so the only rule the value can fail is the ceiling. On any other host the
  // schema's host refinement would refuse it and a passing assertion would prove nothing about length.
  const prefix = 'https://picsum.photos/';
  if (length < prefix.length) {
    throw new Error(`Cannot build a cover address shorter than ${String(prefix.length)}.`);
  }
  return `${prefix}${'a'.repeat(length - prefix.length)}`;
}

/**
 * A taxonomy of `count` distinct, UUID-shaped categories.
 *
 * Generated rather than authored because the case that needs it needs eleven of them - one past the
 * bound - and eleven hand-written fixtures would be eleven chances to typo an identifier. Each name is
 * unique so `getByRole('button', { name })` resolves to exactly one control.
 */
function manyCategories(count: number): readonly CategoryPublic[] {
  return Array.from({ length: count }, (_unused, index) => {
    const ordinal = String(index + 1).padStart(2, '0');
    return {
      id: `c0a80101-0000-4000-8000-0000000001${ordinal}`,
      name: `Topic ${ordinal}`,
      slug: `topic-${ordinal}`,
      description: null,
      post_count: 0,
      created_at: '2024-01-05T09:00:00Z',
    };
  });
}

/**
 * The canonical hyphenated form of a version-4 UUID.
 *
 * Applied to what actually travelled on the wire, not merely to the fixtures it matched: identity is
 * the service's to generate, so a category reference must be an identifier of this shape and never a
 * name, a slug or an integer.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/* -------------------------------------------------------------------------------------------------
 * The authentication contract, restated here because it is asserted here
 *
 * Every mutation this component issues is authenticated: `POST /posts` carries the principal that
 * becomes `author_id`, and the four routes keyed on an identifier re-check ownership against it. The
 * header, the scheme, the media type of a refusal and the challenge it carries are therefore part of
 * what this file tests, so each is named once and used both by the gate on the capture handlers and by
 * the cases that assert on a refusal.
 * ---------------------------------------------------------------------------------------------- */

/** The header the client attaches the access token to, in the casing the service reads. */
const AUTHORIZATION_HEADER = 'Authorization';

/** The scheme prefix, trailing space included - `Bearer ` is one token, not two. */
const BEARER_SCHEME = 'Bearer ';

/** The media type of every failure this API renders, problem documents included. */
const PROBLEM_JSON_MEDIA_TYPE = 'application/problem+json';

/**
 * The challenge a `401` carries, and the member of the answer that says *why* a route refused.
 *
 * Present on an authentication refusal and absent from an authorisation one, which is the distinction
 * that decides whether a fresh credential could help. A `403` never carries it.
 */
const WWW_AUTHENTICATE_BEARER = 'Bearer';

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

/** One intercepted request, reduced to the four things a contract assertion needs. */
interface CapturedRequest {
  readonly method: string;
  readonly pathname: string;
  /** The parsed JSON body, or `null` for a request that carries none - both transitions do not. */
  readonly body: Record<string, unknown> | null;
  /**
   * The verbatim `Authorization` header, or `null` when the request carried none.
   *
   * Captured rather than merely gated on, so that "the credential travelled" is an assertion a case
   * can make about what it provoked, and so the one case that deliberately writes without a
   * credential can prove the header's *absence* rather than inferring it from a refusal.
   */
  readonly authorization: string | null;
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
    authorization: request.headers.get(AUTHORIZATION_HEADER),
  });
}

/**
 * The one credential these overrides accept, built from the token `beforeEach` actually installs.
 *
 * Derived from {@link fixtureTokenPair} rather than restated, so the gate below cannot drift from the
 * value the client is handed: a changed fixture moves both ends together or neither.
 */
const EXPECTED_AUTHORIZATION = `${BEARER_SCHEME}${fixtureTokenPair.access_token}`;

/**
 * Refuse a mutation that does not carry the exact expected bearer.
 *
 * This is the gate that makes bearer attachment LOAD-BEARING for the whole file. Without it every
 * override answered success unconditionally, so removing the `Authorization` header from
 * `src/lib/api/client.ts` - the single most consequential line in the tier's request path - would
 * leave all twenty-odd mutation cases green while every authenticated write in the product started
 * failing with `401`. Verified by deletion: with the header suppressed, the create, update, publish,
 * unpublish and delete cases all fail here.
 *
 * The comparison is exact equality against the whole header value, not a `startsWith` or a presence
 * check. A presence check would accept a stale or forged token, which is precisely the class of
 * credential the service's own `get_current_user` rejects; matching the full string is what makes
 * "the client attached the credential it holds" the thing being proved.
 *
 * Answers the service's own refusal, faithfully: `application/problem+json` (the one media type every
 * failure path uses), the `WWW-Authenticate: Bearer` challenge that distinguishes an authentication
 * refusal from an authorisation one, and a correlation identifier - all three of which
 * `src/lib/api/client.ts` reads off the response and places on the `ApiError` it throws.
 *
 * Returns the response to answer with, or `null` when the credential is the one it should be. Typed as
 * the platform `Response` rather than as `HttpResponse<T>`: the body is a serialised document, so the
 * generic parameter - which describes the PARSED body type - would have to claim `string` to compile
 * and would then be describing the wrong thing. `HttpResponse` is a `Response` subclass, so a resolver
 * accepts it either way.
 */
function refuseUnlessAuthorised(request: Request): Response | null {
  if (request.headers.get(AUTHORIZATION_HEADER) === EXPECTED_AUTHORIZATION) {
    return null;
  }
  const instance = new URL(request.url).pathname;
  const document = problem(
    401,
    'Unauthorized',
    'Authentication credentials are missing or invalid.',
    instance,
  );
  // Built through the low-level constructor rather than `HttpResponse.json`, which would stamp
  // `application/json` over the problem media type this API actually sends.
  return new HttpResponse(JSON.stringify(document), {
    status: 401,
    headers: {
      'Content-Type': PROBLEM_JSON_MEDIA_TYPE,
      'WWW-Authenticate': WWW_AUTHENTICATE_BEARER,
      'X-Request-ID': document.request_id,
    },
  });
}

/**
 * The capturing overrides for all five post mutations, keyed on this file's own fixtures.
 *
 * Registered for every test so that a case asserting "no request was issued" is checking an empty
 * capture log rather than the absence of a handler, and so a case asserting on a body never depends on
 * which fixture the shared handler array happens to hold.
 *
 * EVERY resolver records first and then consults {@link refuseUnlessAuthorised}, in that order. The
 * order is deliberate: recording an unauthorised attempt is what lets a case assert both that the
 * request was issued and that it carried no credential, which is a stronger statement than "nothing
 * happened". These are overrides layered on the shared handler array, and that array enforces the same
 * gate on the same routes, so the enforcement is uniform whichever resolver answers.
 */
function captureHandlers(): RequestHandler[] {
  return [
    http.post('*/api/v1/posts', async ({ request }) => {
      await record(request);
      const refusal = refuseUnlessAuthorised(request);
      if (refusal !== null) {
        return refusal;
      }
      return HttpResponse.json(createdDraft, { status: 201 });
    }),
    http.post('*/api/v1/posts/:postId/publish', async ({ request, params }) => {
      await record(request);
      const refusal = refuseUnlessAuthorised(request);
      if (refusal !== null) {
        return refusal;
      }
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
      const refusal = refuseUnlessAuthorised(request);
      if (refusal !== null) {
        return refusal;
      }
      // `published_at` is RETAINED: the check constraint requires it only while the status is
      // PUBLISHED, so withdrawing a post does not forget the date it first went out.
      return HttpResponse.json(
        { ...publishedPost, id: pathId(params.postId), status: 'DRAFT' },
        { status: 200 },
      );
    }),
    http.patch('*/api/v1/posts/:postId', async ({ request, params }) => {
      await record(request);
      const refusal = refuseUnlessAuthorised(request);
      if (refusal !== null) {
        return refusal;
      }
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
      const refusal = refuseUnlessAuthorised(request);
      if (refusal !== null) {
        return refusal;
      }
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

/** Where the editor sends an author who leaves it, by either route. */
const DASHBOARD_PATH = '/dashboard';

/**
 * Ask the browser to unload the page, and report whether the editor objected.
 *
 * `beforeunload` is cancelable, and calling `preventDefault` on it is the whole of the modern contract
 * for "ask the user to confirm" - the browser substitutes its own wording either way, and assigning
 * `returnValue` is the deprecated spelling of the same request. So `defaultPrevented` after a dispatch
 * is exactly the observable the component controls, and it is observable in both directions: a listener
 * that is not installed cannot prevent anything.
 *
 * A plain `Event` rather than a constructed `BeforeUnloadEvent`: jsdom does not implement that
 * interface, the component's handler reads nothing off its argument, and the dispatch is what the
 * listener is registered for.
 */
function requestBrowserUnload(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * Type into a control the way a keystroke does, then leave it so `onBlur` validation runs.
 *
 * Both events, and the second one is not decoration. The form is built with `mode: 'onBlur'`, so
 * leaving a field is what runs the resolver against it and what puts a message beside the control
 * before anything is submitted. Firing only `change` - as this helper once did - meant every
 * validation case in the file was really testing SUBMIT-time validation: switching the form to
 * `mode: 'onSubmit'` would have changed nothing here while silently withdrawing every inline message
 * an author relies on to fix a field as they go.
 *
 * `fireEvent` rather than `userEvent`: react-hook-form registers `onChange` and `onBlur` on the
 * control itself, so the two synthetic events reach exactly the handlers a real interaction would, and
 * nothing in this file depends on the pointer, focus-ring or keyboard sequencing `userEvent` adds.
 */
function type(field: HTMLElement, value: string): void {
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
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
 * Assert that none of the eight server-owned members appears anywhere in the request.
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

/** Assert every request this test provoked is free of the eight server-owned members. */
function expectNoServerOwnedFieldsAnywhere(): void {
  for (const entry of captured) {
    expectNoServerOwnedFields(entry);
  }
}

/**
 * Assert every request this test provoked carried the exact bearer the client holds.
 *
 * The positive half of {@link refuseUnlessAuthorised}. The gate alone proves attachment by refusing
 * without it; this states it as a fact about the wire, so the guarantee is visible in the case that
 * depends on it rather than only in the handler that enforces it.
 *
 * Requires at least one request, so it cannot pass vacuously on a case that issued none.
 */
function expectBearerOnEveryRequest(): void {
  expect(captured.length).toBeGreaterThan(0);
  for (const entry of captured) {
    expect(entry.authorization).toBe(EXPECTED_AUTHORIZATION);
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

    it('reports a field failure on blur alone, before anything has been submitted', async () => {
      renderPostEditor();

      // One keystroke and one departure. Nothing is pressed in this test at all - no Save, no
      // Publish - so a message can only arrive from the `mode: 'onBlur'` validation the form declares.
      fireEvent.change(titleField(), { target: { value: 'x'.repeat(TITLE_MAX_LENGTH + 1) } });
      fireEvent.blur(titleField());

      await waitFor(() => {
        expect(titleField()).toHaveAttribute('aria-invalid', 'true');
      });
      expect(
        screen.getByText(`Title must be ${String(TITLE_MAX_LENGTH)} characters or fewer.`),
      ).toBeInTheDocument();
      expect(titleField()).toHaveAccessibleDescription(/characters or fewer/);
      // The distinction this case exists to hold: on-blur validation, not submit-time validation.
      // Switching the form to `mode: 'onSubmit'` leaves every other validation case in this file green
      // and fails this one - verified by making that change.
      expect(captured).toHaveLength(0);

      // And the message retracts on the next departure, so it reports the field's CURRENT state
      // rather than accumulating a history of what it once was.
      fireEvent.change(titleField(), { target: { value: 'A title within the bound' } });
      fireEvent.blur(titleField());

      await waitFor(() => {
        expect(titleField()).not.toHaveAttribute('aria-invalid');
      });
      expect(
        screen.queryByText(`Title must be ${String(TITLE_MAX_LENGTH)} characters or fewer.`),
      ).toBeNull();
      expect(captured).toHaveLength(0);
    });

    it.each(REJECTED_COVER_URLS)(
      'refuses the cover address %s and issues no request',
      async (candidate) => {
        renderPostEditor();
        type(titleField(), 'A post whose cover address is hostile or malformed');
        type(contentField(), 'The body is fine; the cover address is not.');
        type(coverImageField(), candidate);

        fireEvent.click(action('Save draft'));

        await waitFor(() => {
          expect(coverImageField()).toHaveAttribute('aria-invalid', 'true');
        });
        // Nothing reaches the wire, which is the point: a `javascript:` or `data:` cover address that
        // survived validation would be stored and later rendered into an `img` src.
        expect(captured).toHaveLength(0);
      },
    );

    it.each(ACCEPTED_COVER_URLS)(
      'stores the cover address %s verbatim, because the policy admits its host',
      async (candidate) => {
        renderPostEditor();
        type(titleField(), 'A post with a cover address the service accepts');
        type(contentField(), 'A host on the allow-list is stored exactly as the author wrote it.');
        type(coverImageField(), candidate);

        fireEvent.click(action('Save draft'));

        await waitFor(() => {
          expect(captured).toHaveLength(1);
        });
        expect(bodyOf(onlyRequest())['cover_image_url']).toBe(candidate);
        expect(coverImageField()).not.toHaveAttribute('aria-invalid');
      },
    );

    it('applies the cover address ceiling at the server’s own bound, not one short of it', async () => {
      renderPostEditor();
      type(titleField(), 'A post with a very long cover address');
      type(contentField(), 'The ceiling is the server’s, restated so the failure arrives early.');
      type(coverImageField(), coverUrlOfLength(COVER_IMAGE_URL_MAX_LENGTH + 1));

      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(coverImageField()).toHaveAttribute('aria-invalid', 'true');
      });
      expect(captured).toHaveLength(0);

      const atBound = coverUrlOfLength(COVER_IMAGE_URL_MAX_LENGTH);
      type(coverImageField(), atBound);
      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });
      expect(bodyOf(onlyRequest())['cover_image_url']).toBe(atBound);
    });

    it('measures the title bound in code points, so an astral title at the bound is accepted', async () => {
      renderPostEditor();
      type(contentField(), 'Counting UTF-16 units would halve this author’s allowance.');

      // `'😀'.repeat(120)` is 120 CODE POINTS and 240 UTF-16 units. A `.max(120)` on string length
      // would reject it, so this case is what proves the ceiling counts what a person counts.
      type(titleField(), ASTRAL_CODE_POINT.repeat(TITLE_MAX_LENGTH));
      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });
      expect(bodyOf(onlyRequest())['title']).toBe(ASTRAL_CODE_POINT.repeat(TITLE_MAX_LENGTH));
      expect(titleField()).not.toHaveAttribute('aria-invalid');
    });

    it('rejects an astral title one code point past the bound', async () => {
      renderPostEditor();
      type(contentField(), 'One code point past the bound is past the bound.');
      type(titleField(), ASTRAL_CODE_POINT.repeat(TITLE_MAX_LENGTH + 1));

      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(titleField()).toHaveAttribute('aria-invalid', 'true');
      });
      expect(
        screen.getByText(`Title must be ${String(TITLE_MAX_LENGTH)} characters or fewer.`),
      ).toBeInTheDocument();
      expect(captured).toHaveLength(0);
    });

    it('applies the excerpt bound in code points on both sides of it', async () => {
      renderPostEditor();
      type(titleField(), 'A post with a very long summary');
      type(contentField(), 'The excerpt is optional, and bounded when supplied.');
      type(excerptField(), ASTRAL_CODE_POINT.repeat(EXCERPT_MAX_LENGTH + 1));

      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(excerptField()).toHaveAttribute('aria-invalid', 'true');
      });
      expect(
        screen.getByText(`Excerpt must be ${String(EXCERPT_MAX_LENGTH)} characters or fewer.`),
      ).toBeInTheDocument();
      expect(captured).toHaveLength(0);

      const atBound = ASTRAL_CODE_POINT.repeat(EXCERPT_MAX_LENGTH);
      type(excerptField(), atBound);
      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });
      expect(bodyOf(onlyRequest())['excerpt']).toBe(atBound);
    });

    it('applies the content bound in code points on both sides of it', async () => {
      renderPostEditor();
      type(titleField(), 'A post at the content ceiling');
      type(contentField(), 'x'.repeat(CONTENT_MAX_LENGTH + 1));

      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(contentField()).toHaveAttribute('aria-invalid', 'true');
      });
      expect(
        screen.getByText(`Content must be ${String(CONTENT_MAX_LENGTH)} characters or fewer.`),
      ).toBeInTheDocument();
      expect(captured).toHaveLength(0);

      const atBound = 'y'.repeat(CONTENT_MAX_LENGTH);
      type(contentField(), atBound);
      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });
      expect(bodyOf(onlyRequest())['content']).toBe(atBound);
    });

    it('refuses more categories than a post may carry, and accepts exactly that many', async () => {
      const taxonomy = manyCategories(MAX_CATEGORIES_PER_POST + 1);
      renderPostEditor({ categories: taxonomy });
      type(titleField(), 'A post filed under too many categories');
      type(contentField(), 'The bound lives on the shared schema, so both forms inherit it.');
      for (const category of taxonomy) {
        toggleCategory(category);
      }

      fireEvent.click(action('Save draft'));

      // The message is reported against the group rather than against a single pill, because no one
      // selection is the offending one.
      expect(
        await screen.findByText(
          `Choose at most ${String(MAX_CATEGORIES_PER_POST)} categories for this post.`,
        ),
      ).toBeInTheDocument();
      expect(captured).toHaveLength(0);

      // Releasing one selection brings the list back inside the bound.
      const surplus = taxonomy[taxonomy.length - 1];
      if (surplus === undefined) {
        throw new Error('Expected the generated taxonomy to be non-empty.');
      }
      toggleCategory(surplus);
      fireEvent.click(action('Save draft'));

      await waitFor(() => {
        expect(captured).toHaveLength(1);
      });
      expect(toStringArray(bodyOf(onlyRequest())['category_ids'])).toHaveLength(
        MAX_CATEGORIES_PER_POST,
      );
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
      // `/posts/{id}/edit`, NOT `/dashboard/posts/{id}/edit`. `(dashboard)` is a route GROUP, so its
      // name is erased from the URL: `src/app/(dashboard)/posts/[id]/edit/page.tsx` serves the former,
      // and `src/middleware.ts` gates `/posts/:path*` for exactly that reason. The address comes from
      // the one shared helper in `@/lib/routes` rather than a literal in this component.
      expect(routerStub.replace).toHaveBeenCalledWith(`/posts/${CREATED_POST_ID}/edit`);

      // A second press now diffs against the created post, finds nothing changed, and writes nothing.
      fireEvent.click(action('Save'));
      await waitFor(() => {
        expect(toastStub.info).toHaveBeenCalledWith('Nothing has changed since the last save.');
      });
      expect(requestsTo('POST', '/api/v1/posts')).toHaveLength(1);
      expectBearerOnEveryRequest();
    });

    it('repeats none of the server-owned members on the write that follows a create', async () => {
      renderPostEditor();
      type(titleField(), 'A post created by a test');
      type(contentField(), 'The response hands the editor every member it must not send back.');

      fireEvent.click(action('Save draft'));
      expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument();

      // The representation the editor has just adopted carries seven of the eight members outright,
      // and the eighth - `author_id` - as the nested `author` object it is the identifier of. All eight
      // are therefore in the editor's hands at this moment, which is precisely when an echo would
      // happen: the naive next write is `PATCH` with the whole adopted object in its body.
      for (const field of SERVER_OWNED_FIELDS.filter((name) => name !== 'author_id')) {
        expect(createdDraft).toHaveProperty(field);
      }
      expect(createdDraft.author.id).toBe(AUTHOR_ID);

      type(titleField(), 'A title revised immediately after creation');
      fireEvent.click(action('Save'));

      await waitFor(() => {
        expect(requestsTo('PATCH', `/api/v1/posts/${CREATED_POST_ID}`)).toHaveLength(1);
      });

      // Only the member that changed travels, and none of the eight - `created_at` and `updated_at`
      // included, which are the two the earlier six-member inventory would have waved through.
      const [patch] = requestsTo('PATCH', `/api/v1/posts/${CREATED_POST_ID}`);
      if (patch === undefined) {
        throw new Error('Expected the follow-up patch to have been captured.');
      }
      expect(Object.keys(bodyOf(patch))).toEqual(['title']);
      expectNoServerOwnedFieldsAnywhere();
      expectBearerOnEveryRequest();
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

    it('rebinds the address to the created draft even when the publish that follows fails', async () => {
      // The one partial-success path in this component: the create is accepted, the transition is
      // refused, and a real draft now exists that the author has not been shown a URL for.
      server.use(
        http.post('*/api/v1/posts/:postId/publish', () =>
          HttpResponse.json(
            problem(
              409,
              'Conflict',
              'This post could not be published.',
              `/api/v1/posts/${CREATED_POST_ID}/publish`,
            ),
            { status: 409 },
          ),
        ),
      );

      renderPostEditor();
      type(titleField(), 'A post created by a test');
      type(contentField(), 'The create lands; the publish does not.');

      fireEvent.click(action('Publish'));

      // The failure is reported and the author is kept here to retry, as before.
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'This post could not be published.',
      );
      expect(toastStub.error).toHaveBeenCalledWith(
        'Draft saved, but publishing failed. The draft is safe - try publishing again.',
      );

      // AND the address names the persisted draft, which is what makes "the draft is safe" true of
      // the BROWSER rather than only of this component's state. Without it a reload would return an
      // empty create form holding the same text, and the next save would write a second draft - the
      // in-memory guard asserted in the test above cannot see across documents.
      expect(routerStub.replace).toHaveBeenCalledWith(`/posts/${CREATED_POST_ID}/edit`);

      // The draft is still DRAFT, because only the transition publishes, and the form is bound to it:
      // the retry re-enters with an empty patch and repeats only the publish.
      expect(screen.getByText('DRAFT')).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument();
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
      expectBearerOnEveryRequest();
    });

    it('leaves unsaved edits on screen when a published post is withdrawn', async () => {
      renderPostEditor({ post: publishedPost });
      const revised = 'A retitling that has not been saved yet';
      type(titleField(), revised);

      fireEvent.click(action('Unpublish'));

      await waitFor(() => {
        expect(toastStub.success).toHaveBeenCalledWith(
          'Post moved back to draft. It is no longer publicly visible.',
        );
      });

      // Withdrawing is a transition and nothing else: no save, and deliberately no re-baseline. The
      // asymmetry with publish is the point - publishing a stale body would make the wrong text
      // public, whereas withdrawing content cannot be stale, so unsaved work survives it.
      expect(titleField()).toHaveValue(revised);
      expect(requestsTo('PATCH', `/api/v1/posts/${PUBLISHED_POST_ID}`)).toHaveLength(0);
      expect(captured).toHaveLength(1);
      expect(screen.getByText('DRAFT')).toBeInTheDocument();
    });

    it('keeps the created draft and repeats only the publish when the transition fails', async () => {
      let publishAttempts = 0;
      server.use(
        http.post('*/api/v1/posts/:postId/publish', async ({ request, params }) => {
          await record(request);
          const refusal = refuseUnlessAuthorised(request);
          if (refusal !== null) {
            return refusal;
          }
          publishAttempts += 1;
          if (publishAttempts === 1) {
            return HttpResponse.json(
              problem(
                503,
                'Service Unavailable',
                'The publication service is briefly unavailable.',
                `/api/v1/posts/${CREATED_POST_ID}/publish`,
              ),
              { status: 503 },
            );
          }
          return HttpResponse.json(
            {
              ...createdDraft,
              id: pathId(params.postId),
              status: 'PUBLISHED',
              published_at: PUBLICATION_INSTANT,
            },
            { status: 200 },
          );
        }),
      );

      renderPostEditor();
      type(titleField(), 'A post created by a test');
      type(contentField(), 'The create half succeeds and the transition half does not.');

      fireEvent.click(action('Publish'));

      // The create succeeded and the transition did not. This is the sequence that needs care,
      // because the draft now EXISTS: losing it or creating a second one are both real failures.
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The publication service is briefly unavailable.');
      expect(toastStub.error).toHaveBeenCalledWith(
        'Draft saved, but publishing failed. The draft is safe - try publishing again.',
      );
      // ONE attempt per press: `mutations: { retry: 0 }` on the shared client, so a 503 is not
      // silently retried behind the author's back.
      expect(publishAttempts).toBe(1);
      expect(captured).toHaveLength(2);
      // THE ADDRESS NOW NAMES THE CREATED DRAFT, and that rebinding is the fix rather than a detail.
      // The retry is the author's to make and they stay in the editor to make it, but the URL cannot
      // stay at `/posts/new`: the component holds the new identifier in state, and state does not
      // survive a reload, a Back-then-Forward, or reopening the tab. Any of those re-entered CREATE
      // mode holding the same text and wrote a SECOND draft. `replace` rather than `push`, so Back
      // does not return to an empty editor that would create yet another one.
      expect(routerStub.replace).toHaveBeenCalledTimes(1);
      expect(routerStub.replace).toHaveBeenCalledWith(`/posts/${CREATED_POST_ID}/edit`);
      expect(routerStub.push).not.toHaveBeenCalled();

      // The affordance now names what it does, which is how the author knows the draft survived.
      const retry = await screen.findByRole('button', { name: 'Retry publish' });
      expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
      // And the save control has switched from create to update, because the post is now persisted.
      expect(action('Save')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();

      fireEvent.click(retry);

      await waitFor(() => {
        expect(toastStub.success).toHaveBeenCalledWith('Post published.');
      });

      // THE COUNTS ARE THE ASSERTION. Exactly one create for the whole episode - a second one would
      // leave a duplicate draft behind - and exactly two publish attempts, keyed on the identifier
      // the server generated. No PATCH at all: the editor re-baselined after the create, so the
      // retry re-enters with an empty patch and skips the write entirely.
      expect(requestsTo('POST', '/api/v1/posts')).toHaveLength(1);
      expect(requestsTo('POST', `/api/v1/posts/${CREATED_POST_ID}/publish`)).toHaveLength(2);
      expect(requestsTo('PATCH', `/api/v1/posts/${CREATED_POST_ID}`)).toHaveLength(0);
      expect(publishAttempts).toBe(2);
      expect(captured).toHaveLength(3);
      expectNoServerOwnedFieldsAnywhere();
      expectBearerOnEveryRequest();
      expect(await screen.findByText('PUBLISHED')).toBeInTheDocument();
    });

    it('repeats only the publish after a failed transition on an existing draft', async () => {
      let publishAttempts = 0;
      server.use(
        http.post('*/api/v1/posts/:postId/publish', async ({ request, params }) => {
          await record(request);
          const refusal = refuseUnlessAuthorised(request);
          if (refusal !== null) {
            return refusal;
          }
          publishAttempts += 1;
          if (publishAttempts === 1) {
            return HttpResponse.json(
              problem(
                500,
                'Internal Server Error',
                'An unexpected error occurred.',
                `/api/v1/posts/${DRAFT_POST_ID}/publish`,
              ),
              { status: 500 },
            );
          }
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
      );

      const revised = 'Notes towards cache invalidation, revised once';
      renderPostEditor({ post: draftPost });
      type(titleField(), revised);

      fireEvent.click(action('Publish'));

      await waitFor(() => {
        expect(toastStub.error).toHaveBeenCalledWith(
          'Changes saved, but publishing failed. The changes are safe - try publishing again.',
        );
      });
      expect(await screen.findByRole('alert')).toHaveTextContent('An unexpected error occurred.');
      expect(captured).toHaveLength(2);

      fireEvent.click(action('Retry publish'));

      await waitFor(() => {
        expect(toastStub.success).toHaveBeenCalledWith('Post published.');
      });

      // Exactly ONE save for the whole episode. The wording of the failure - "the changes are safe" -
      // is only true because the editor re-baselined against what the PATCH returned, and this count
      // is what holds that promise: a second PATCH here would mean the first had been forgotten.
      expect(requestsTo('PATCH', `/api/v1/posts/${DRAFT_POST_ID}`)).toHaveLength(1);
      expect(requestsTo('POST', `/api/v1/posts/${DRAFT_POST_ID}/publish`)).toHaveLength(2);
      expect(requestsTo('POST', '/api/v1/posts')).toHaveLength(0);
      expect(captured).toHaveLength(3);
      // The one save carried only the member that changed - still a genuine partial update.
      const [save] = captured;
      if (save === undefined) {
        throw new Error('Expected the save to have been captured.');
      }
      expect(Object.keys(bodyOf(save))).toEqual(['title']);
      expectNoServerOwnedFieldsAnywhere();
      expectBearerOnEveryRequest();
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

  describe('leaving the editor with unsaved work', () => {
    it('leaves at once when nothing has been edited, asking nothing', () => {
      renderPostEditor({ post: draftPost });

      fireEvent.click(action('Cancel'));

      // A pristine form has nothing to lose, so a confirmation here would be a dialog that always
      // says yes - the kind users learn to dismiss without reading.
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(routerStub.push).toHaveBeenCalledWith(DASHBOARD_PATH);
      expect(captured).toHaveLength(0);
    });

    it('confirms before discarding unsaved edits, and keeps them when the author declines', async () => {
      const revised = 'A revision the author has not finished';
      renderPostEditor({ post: draftPost });
      type(titleField(), revised);

      fireEvent.click(action('Cancel'));

      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveAccessibleName('Discard unsaved changes?');
      // The copy distinguishes what is at risk from what is not, which is the only useful thing a
      // confirmation can say here.
      expect(dialog).toHaveTextContent(/nothing already saved is affected/);
      // Nothing has happened merely by asking.
      expect(routerStub.push).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      // Declining is a genuine retraction: still here, still dirty, and the work still on screen.
      expect(routerStub.push).not.toHaveBeenCalled();
      expect(titleField()).toHaveValue(revised);
      expect(captured).toHaveLength(0);
    });

    it('discards and leaves when confirmed, resetting the form to what was loaded', async () => {
      renderPostEditor({ post: draftPost });
      type(titleField(), 'A revision that is about to be thrown away');
      type(excerptField(), 'And a summary that goes with it.');

      fireEvent.click(action('Cancel'));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Discard and leave' }));

      await waitFor(() => {
        expect(routerStub.push).toHaveBeenCalledWith(DASHBOARD_PATH);
      });

      // Discarding is a client-side reset and NOTHING else. No request is issued: the author asked to
      // abandon their edits, not to store them, and certainly not to have the stored post rewritten.
      expect(captured).toHaveLength(0);
      // The form is back to what was loaded, so a re-mount of this route shows the stored post.
      expect(titleField()).toHaveValue(draftPost.title);
      expect(excerptField()).toHaveValue(draftPost.excerpt);
    });

    it('asks the browser to confirm a reload only while there are unsaved edits', async () => {
      renderPostEditor({ post: draftPost });

      // Pristine: the listener is not installed, so a reload proceeds unimpeded. Asserting this leg
      // is what stops the component from simply always warning, which would be indistinguishable
      // from a correct implementation if only the dirty case were checked.
      expect(requestBrowserUnload()).toBe(false);

      type(titleField(), 'An edit that a reload would destroy');

      await waitFor(() => {
        expect(requestBrowserUnload()).toBe(true);
      });

      // Saving re-baselines the form, and the warning must go with the dirtiness that justified it -
      // otherwise every author who saves is warned about work that is already stored.
      fireEvent.click(action('Save'));

      await waitFor(() => {
        expect(toastStub.success).toHaveBeenCalledWith('Changes saved.');
      });
      expect(requestBrowserUnload()).toBe(false);
      // And the in-app path agrees with the browser-level one: Cancel now leaves without asking.
      fireEvent.click(action('Cancel'));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(routerStub.push).toHaveBeenCalledWith(DASHBOARD_PATH);
    });

    it('does not warn about edits that were only typed and then undone', async () => {
      renderPostEditor({ post: draftPost });

      type(titleField(), 'A title typed by mistake');
      await waitFor(() => {
        expect(requestBrowserUnload()).toBe(true);
      });

      // Restoring the loaded value by hand is not a change, and react-hook-form's `isDirty` compares
      // against the default values rather than counting keystrokes. So the warning retracts.
      type(titleField(), draftPost.title);

      await waitFor(() => {
        expect(requestBrowserUnload()).toBe(false);
      });
      fireEvent.click(action('Cancel'));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(routerStub.push).toHaveBeenCalledWith(DASHBOARD_PATH);
      expect(captured).toHaveLength(0);
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

    it('cannot write at all when no credential is attached, and does not rotate one', async () => {
      // The credential `beforeEach` installed is removed for this case ONLY, so the request goes out
      // exactly as it would from a signed-out tab whose token was dropped between render and submit.
      clearCredentials();
      let refreshAttempts = 0;
      server.use(
        http.post('*/api/v1/auth/refresh', () => {
          refreshAttempts += 1;
          return HttpResponse.json(
            problem(
              401,
              'Unauthorized',
              'That refresh token is not valid.',
              '/api/v1/auth/refresh',
            ),
            { status: 401 },
          );
        }),
      );

      const revised = 'A revision no credential can carry';
      renderPostEditor({ post: draftPost });
      type(titleField(), revised);

      fireEvent.click(action('Save'));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Authentication credentials are missing or invalid.');
      expect(toastStub.error).toHaveBeenCalledWith('Could not save this post.');

      // THE REQUEST WAS ISSUED AND CARRIED NOTHING. Asserting the header's absence rather than
      // inferring it from the refusal is what makes this the positive control for the gate every other
      // case in this file passes through: with `Authorization` suppressed in `@/lib/api/client`, this
      // case still passes and fourteen others fail, which is exactly the right way round.
      expect(requestsTo('PATCH', `/api/v1/posts/${DRAFT_POST_ID}`)).toHaveLength(1);
      expect(onlyRequest().authorization).toBeNull();

      // And no rotation was attempted. A `401` answering a request that carried no credential is the
      // service's own answer rather than evidence of a stale token, so rotating would spend - and
      // revoke - a perfectly good refresh token to learn nothing.
      expect(refreshAttempts).toBe(0);

      // The author's work is still on screen, as it is for every other refusal.
      expect(titleField()).toHaveValue(revised);
    });

    it('attempts a refused write exactly once, because no mutation in this tier is retried', async () => {
      let attempts = 0;
      server.use(
        http.patch('*/api/v1/posts/:postId', async ({ request }) => {
          await record(request);
          const refusal = refuseUnlessAuthorised(request);
          if (refusal !== null) {
            return refusal;
          }
          attempts += 1;
          return HttpResponse.json(
            problem(
              500,
              'Internal Server Error',
              'An unexpected error occurred.',
              `/api/v1/posts/${DRAFT_POST_ID}`,
            ),
            { status: 500 },
          );
        }),
      );

      renderPostEditor({ post: draftPost });
      type(titleField(), 'A revision the service cannot store');

      fireEvent.click(action('Save'));

      await waitFor(() => {
        expect(toastStub.error).toHaveBeenCalledWith('Could not save this post.');
      });

      // A `500` is retryable in principle, and the query tier does retry idempotent READS. A write is
      // different: repeating it without the author asking risks a second effect for one intent, so the
      // shared client sets `mutations: { retry: 0 }` and the retry is the author's to make. Exactly one
      // attempt is the observable form of that decision.
      expect(attempts).toBe(1);
      expect(captured).toHaveLength(1);
      expect(requestsTo('PATCH', `/api/v1/posts/${DRAFT_POST_ID}`)).toHaveLength(1);
      // The control is usable again, so the author CAN retry - the tier declining to is not the same
      // as the editor being stuck.
      expect(action('Save')).toBeEnabled();
    });

    it('attaches an indexed field failure to the group that owns the value', async () => {
      // The service reports a rejected member of the category list at the path it failed on, so an
      // index is part of the name: `category_ids.0`, and through a body prefix `body.category_ids.2`.
      // Both belong to the ONE error region the category group renders. Resolving the path by its last
      // segment yields `0` and `2` - names no control has - and quietly sent both messages to the
      // summary banner while the group the author had to change showed nothing.
      server.use(
        http.patch('*/api/v1/posts/:postId', () =>
          HttpResponse.json(
            problem(
              422,
              'Unprocessable Entity',
              'The submitted post could not be stored.',
              `/api/v1/posts/${DRAFT_POST_ID}`,
              [
                {
                  field: 'category_ids.0',
                  message: 'That category no longer exists.',
                  type: 'value_error',
                },
              ],
            ),
            { status: 422 },
          ),
        ),
      );
      renderPostEditor({ post: draftPost });
      // A real change, so the patch is non-empty and the request is actually issued.
      type(titleField(), 'A revision filed under a category that has since gone');

      fireEvent.click(action('Save'));

      expect(await screen.findByText('That category no longer exists.')).toBeInTheDocument();
      // Beside the group, through the fieldset's own description relationship - not only in the banner.
      const message = screen.getByText('That category no longer exists.');
      const group = screen.getByRole('group', { name: 'Categories' });
      expect(group).toContainElement(message);
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
