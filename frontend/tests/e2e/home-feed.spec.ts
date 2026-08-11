/**
 * End-to-end gate for the home feed, the responsive layout contract and the SEO surface.
 *
 * One of exactly SIX specs in `frontend/tests/e2e` - auth, authoring, home-feed,
 * comments-likes, admin, theme - and the largest of them, because the §0.9.4.5 criteria that
 * a seventh `seo.spec.ts` would have carried are discharged HERE instead. Three viewport
 * projects (`mobile` 375, `tablet` 768, `desktop` 1440 - frontend/playwright.config.ts) run
 * every test in this file, so each one below is three of the eighteen project-spec
 * combinations AAP §0.9.4.6 requires green.
 *
 * `review_rules` reports that **no user-specified rules exist for this project**, so nothing
 * here is written to satisfy a user rule and none is invented. The work is held to the
 * enterprise standards the AAP sets for itself (§0.10.1) instead, five of which bind this file
 * directly. Each is named where it is discharged, and each is worth stating up front because
 * every one of them is a rule about what this file must NOT do:
 *
 * 1. **Blocking quality gates.** Not one test here is marked exclusive, disabled or
 *    expected-to-fail, nothing is conditionally turned off, no `catch` swallows a failure, and no
 *    soft assertion stands in for a real one. The width-specific tests - feed columns, navigation
 *    collapse, the drawer - BRANCH on the viewport width and assert the correct expectation for
 *    it. Disabling the two widths a test does not target would quietly turn three green
 *    combinations into one and hollow the gate out from the inside, which is worse than not
 *    writing the test at all.
 *
 * 2. **Accessibility as a floor.** §0.9.4.5 requires every interactive control to be
 *    keyboard-reachable with a visible focus indicator and modal focus to be trapped with
 *    Escape closing it. This file owns the `mobile-nav` drawer half of that obligation
 *    (`admin.spec.ts` owns the confirmation-dialog half): focus containment while tabbing,
 *    Escape-to-close, focus returned to the trigger, and an accessible name on the dialog. It
 *    also proves the feed's own three controls - search field, category filter, page links -
 *    are reachable by Tab and draw an outline once they are.
 *
 * 3. **Behaviour over implementation (§0.8.5 / §0.7.2).** THIS IS THE STANDARD MOST AT RISK IN
 *    A RESPONSIVE SPEC, because the shortest route to "the feed is three columns" is to assert
 *    a utility class. There is **not one class-name locator and not one class assertion in this
 *    file**. Every element is found by role, accessible name or visible text; every responsive
 *    claim rests on computed geometry - `getComputedStyle(...).gridTemplateColumns`,
 *    `getBoundingClientRect()`, `scrollWidth` vs `clientWidth` - or on visibility.
 *    `post-list.tsx` is the sole owner of the feed's column geometry and it must stay free to
 *    change utilities without breaking this gate; the day it moves from `lg:grid-cols-3` to a
 *    different expression of the same three tracks, this file still passes, and the day it
 *    renders two tracks at 1440 it still fails. The one folder-wide exception - asserting the
 *    `dark` class on the document element - belongs to `theme.spec.ts` and appears nowhere here.
 *    The attribute selectors that DO appear (`link[rel="canonical"]`, `meta[property^="og:"]`,
 *    `script[type="application/ld+json"]`, `[role="dialog"]`) select semantic metadata
 *    elements and ARIA roles, which is the only way those nodes can be addressed at all.
 *
 * 4. **Pinned, reproducible dependencies.** The only import is `@playwright/test`, pinned at
 *    1.62.1. No `axe-core`, no `@axe-core/playwright` - which is exactly why the accessibility
 *    assertions above are hand-written keyboard and focus checks rather than a scanner - and no
 *    XML or HTML parser: the sitemap and robots policy are asserted from the response text with
 *    the `request` fixture and a regular expression.
 *
 * 5. **No secrets in the repository.** Most of this file is anonymous, which is the correct way
 *    to prove crawlability: the feed, post detail, profile, sitemap and robots policy are all
 *    public and are driven with no credential at all. The one authenticated actor is a
 *    throwaway author whose identity - username, address and passphrase - is DERIVED FROM A
 *    RANDOM PER-RUN SUFFIX, so no credential is written down here, none is reused between runs,
 *    and none belongs to a real account. Nothing is written into the working tree; Playwright's
 *    reports go to `playwright-report/`, `test-results/` and `blob-report/`, all three already
 *    excluded by the root `.gitignore`, which is what keeps `git status --porcelain` empty
 *    after a run.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIXTURE IS PROVISIONED THROUGH THE API AND SCOPED BY A UNIQUE TERM
 *
 * Three projects run concurrently against ONE database, Playwright may shard, and previous runs
 * have left rows behind. Every count-sensitive assertion is therefore scoped to a term that
 * exists only in this worker's own posts, and the fixture creates its own corpus rather than
 * leaning on the seeded one:
 *
 *   - **No absolute total is ever asserted.** `?q=<feed term>` narrows the feed to the fourteen
 *     posts this worker published, so `total`, `pages` and the result range are exact and a
 *     concurrent worker cannot move them.
 *   - **No post is assumed to occupy a position** unless the ordering is one the fixture itself
 *     established. Where position matters the URL carries `sort=recent`, and the service orders
 *     by `published_at DESC` with `posts.id DESC` as a total-order tiebreaker
 *     (backend/app/repositories/post_repository.py), so the window is stable and page two is
 *     provably disjoint from page one rather than probably disjoint.
 *   - **Page-two disjointness is asserted inside the term-scoped feed**, so a post published by
 *     another worker between the two reads cannot shift a row across the page boundary and
 *     manufacture an intersection.
 *
 * Provisioning runs ONCE per worker in a top-level `beforeAll`, and that is a deliberate
 * economy rather than a convenience: `POST /auth/register` and `POST /auth/login` are two of the
 * five throttled routes in the service (`AUTH_RATE_LIMIT`, keyed by client address), and this
 * file spends exactly two of that window per worker no matter how many tests run. Post creation
 * and publication are not throttled, so the seventeen posts cost the credential window nothing.
 *
 * ---------------------------------------------------------------------------
 * THE RETIRED SURFACE IS NOT MENTIONED ANYWHERE IN THIS FILE
 *
 * AAP §0.9.4.3 retires the repository's original single-resource demonstration API - its five
 * unversioned handlers, its one model and the client-supplied numeric identity that model
 * carried. That retirement is asserted by `backend/tests/integration/test_openapi_contract.py`
 * and deliberately NOT here: an end-to-end spec that probed a path the product no longer serves
 * would be testing the absence of something no browser journey can reach. No path, type or field
 * of that contract appears anywhere below - a grep of this file for any of them finds nothing.
 * The blog domain's own `id` (a server-generated UUID) and a category's `name` are, of course,
 * legitimate fields and do appear.
 *
 * ---------------------------------------------------------------------------
 * TWO PLACES WHERE THE CODE CORRECTED THE PLAN, AND WHY THE CODE WON
 *
 * 1. **The empty state carries no ARIA role.** `components/ui/alert.tsx` maps `variant="empty"`
 *    to `undefined` on purpose - an empty result set is not a live-region event - so the empty
 *    state cannot be located by role. It is located by its TITLE, which `post-list.tsx` renders
 *    as a real `<h2>` (or `<h3>` on a profile) through `AlertTitle as=`, and by its visible
 *    text. That is still a role-and-text locator; it is just the heading's role, not the
 *    alert's.
 *
 * 2. **The sitemap is a build-time artifact.** `src/app/sitemap.ts` exports
 *    `revalidate = 3600` and reads the API through cached fetches, so `next build` prerenders
 *    it and `next start` serves that copy for an hour. A post published DURING the run is
 *    therefore not expected to appear in it, and asserting that it does would be asserting
 *    against the route's own declared caching. The "lists published posts" criterion is proven
 *    instead against a post that provably predates the build - the OLDEST published post the
 *    API reports, which is necessarily part of the seeded corpus - and the exclusion criterion
 *    is proven against this worker's unpublished draft, which is correct under either regime.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from '@playwright/test';

/* -------------------------------------------------------------------------------------------------
 * The responsive contract
 *
 * The two breakpoints that decide everything in this file, in pixels, taken from the styling
 * engine's own five (`sm` 40rem, `md` 48rem, `lg` 64rem, `xl` 80rem, `2xl` 96rem) at the
 * engine's 16px root. They are declared here as the single source the expectations are DERIVED
 * from, rather than hard-coding "375 means one column": a project added at another width gets
 * the right expectation for free, and a breakpoint that moves is one edit.
 *
 * Note that 768 is EXACTLY `md`, so `md:`-prefixed utilities are active in the tablet project -
 * which is why the tablet feed is two columns and not one - and the third column arrives at
 * `lg`, which only the desktop project reaches.
 * ---------------------------------------------------------------------------------------------- */

/** `md` - 48rem. At and above this width the inline navigation replaces the drawer. */
const MD_BREAKPOINT_PX = 768;

/** `lg` - 64rem. At and above this width the feed reaches three columns and the banner gains its own search field. */
const LG_BREAKPOINT_PX = 1024;

/**
 * Columns the feed grid must render at *width*.
 *
 * Derived from the breakpoints above rather than enumerated per project, so the assertion states
 * the CONTRACT (`grid-cols-1 md:grid-cols-2 lg:grid-cols-3`, owned by `post-list.tsx`) and not a
 * table of three remembered numbers.
 */
function expectedFeedColumns(width: number): number {
  if (width >= LG_BREAKPOINT_PX) {
    return 3;
  }
  return width >= MD_BREAKPOINT_PX ? 2 : 1;
}

/* -------------------------------------------------------------------------------------------------
 * Copy and accessible names, read out of the components rather than guessed
 *
 * Every string below was taken from the module named beside it. They are constants so that a
 * rename in the product is one edit here and a compile-time-visible diff rather than a scatter of
 * string literals in test bodies.
 * ---------------------------------------------------------------------------------------------- */

/** The feed's single `<h1>` - src/app/page.tsx. */
const FEED_HEADING = 'Latest posts';

/**
 * Accessible name of the FEED's search field - the `label` prop src/app/page.tsx passes to
 * `SearchInput`, overriding that component's own default of "Search posts".
 *
 * The distinction is load-bearing for this file at desktop width: from `lg` the banner renders
 * its own separate search form whose field IS named "Search posts", so two searchboxes are on
 * screen at 1440 and only this name selects the one that filters the feed.
 */
const FEED_SEARCH_LABEL = 'Search all posts';

/** Accessible name of the category picker's trigger - the `aria-label` on `SelectTrigger` in category-filter.tsx. */
const CATEGORY_FILTER_LABEL = 'Filter by category';

/** `aria-label` on the page control's `<nav>` - the `DEFAULT_NAV_LABEL` of ui/pagination.tsx. */
const PAGINATION_LABEL = 'Pagination';

/** `aria-label` on the banner's inline navigation landmark - `PRIMARY_NAV_LABEL` in layout/site-header.tsx. */
const PRIMARY_NAV_LABEL = 'Main';

/** `aria-label` on the banner's own search landmark, which exists only from `lg` - `SEARCH_LANDMARK_LABEL` in layout/site-header.tsx. */
const SITE_SEARCH_LABEL = 'Site';

/** The single entry in the banner's `PRIMARY_NAV`, and the first row of the drawer. */
const HOME_NAV_LINK = 'Home';

/** Accessible name of the drawer's trigger - the screen-reader-only span in layout/mobile-nav.tsx. */
const DRAWER_TRIGGER_LABEL = 'Open navigation menu';

/** The drawer's `DialogTitle`, which Radix wires to `aria-labelledby` - so this is the dialog's accessible name. */
const DRAWER_DIALOG_TITLE = 'Navigation';

/** `aria-label` on the navigation landmark inside the drawer panel. */
const DRAWER_NAV_LABEL = 'Menu';

/** The `<h1>` of src/app/error.tsx. Asserted ABSENT, to prove a rendered page is not a caught error. */
const ERROR_BOUNDARY_HEADING = 'Something went wrong';

/** Separator the root title template composes with - `TITLE_SEPARATOR` in lib/seo.ts. */
const TITLE_SEPARATOR = ' | ';

/** The en dash `formatResultRange` puts between the two bounds of the result range - lib/utils.ts. */
const EN_DASH = '\u2013';

/** Twitter card type every page declares - `TWITTER_CARD` in lib/seo.ts. */
const TWITTER_CARD = 'summary_large_image';

/** The structured-data vocabulary - `SCHEMA_ORG_CONTEXT` in components/seo/json-ld.tsx. */
const SCHEMA_ORG_CONTEXT = 'https://schema.org';

/**
 * The crawl policy, frozen in lib/seo.ts as `CRAWL_DISALLOWED_PATHS` and consumed by BOTH
 * src/app/robots.ts and src/app/sitemap.ts.
 *
 * That shared origin is the whole point of the cross-check below: the two artifacts cannot
 * disagree unless one of them stops reading this array, which is precisely the regression worth
 * catching. Note what is NOT in it - `/blog` - because the authoring family is `/posts` and
 * conflating the two would make every published article uncrawlable.
 */
const CRAWL_DISALLOWED_PATHS = ['/admin', '/dashboard', '/posts'] as const;

/** The credential routes. Excluded from the sitemap and marked `noindex` by the `(auth)` layout. */
const CREDENTIAL_PATHS = ['/login', '/signup'] as const;

/* -------------------------------------------------------------------------------------------------
 * Fixture shape and size
 * ---------------------------------------------------------------------------------------------- */

/**
 * Posts one page of the feed holds - `FEED_PAGE_SIZE` in src/app/page.tsx.
 *
 * Restated here rather than imported because it is deliberately NOT in the URL: the window is
 * the route's own rendering decision, so a spec can only observe it. Every assertion that uses
 * it also re-derives it from the rendered result range, so a change to the constant surfaces as
 * one honest failure here instead of a silently weaker gate.
 */
const FEED_PAGE_SIZE = 12;

/**
 * Posts the fixture files under its primary category: one more than a page, so the term-scoped
 * feed spans exactly two pages and the second page is short. A single page would leave the page
 * control unrendered - `post-list.tsx` renders it only when `pages > 1` - and there would be no
 * pagination to assert.
 */
const PRIMARY_POST_COUNT = FEED_PAGE_SIZE + 1;

/** Every post carrying the feed term: the primary set plus the one filed under the second category. */
const TERMED_POST_COUNT = PRIMARY_POST_COUNT + 1;

/** Pages the term-scoped feed spans. Asserted against the rendered page links rather than assumed. */
const TERMED_PAGE_COUNT = Math.ceil(TERMED_POST_COUNT / FEED_PAGE_SIZE);

/** A page number far past the end of any result set, used to prove an out-of-range page is a 200 and not an error. */
const OUT_OF_RANGE_PAGE = 9999;

/* -------------------------------------------------------------------------------------------------
 * Tolerances and bounds
 * ---------------------------------------------------------------------------------------------- */

/**
 * Vertical slack, in pixels, when deciding whether two cards share a grid row.
 *
 * Sub-pixel layout rounding is normal - a fractional track width propagates into the row
 * origin - so row membership is compared within a few pixels rather than for equality. Four is
 * far below the 24px (`gap-6`) that separates two rows, so the tolerance cannot merge them.
 */
const ROW_TOLERANCE_PX = 4;

/** Slack when comparing `scrollWidth` to `clientWidth`: one pixel of rounding is not an overflow. */
const OVERFLOW_TOLERANCE_PX = 1;

/**
 * Ceiling on Tab presses when proving a control is keyboard reachable.
 *
 * Generous on purpose. Reaching the page control from the category filter crosses every card in
 * the grid, and each card contributes three focusable elements - its title link, its author link
 * and its category badge link - so a full page is around forty stops before the page links are
 * reached. The bound exists to fail with a clear message rather than to hang; it is not a
 * measurement of the expected distance.
 */
const MAX_TAB_PRESSES = 100;

/**
 * Tab presses used to prove the drawer contains focus.
 *
 * The panel holds around five focusable stops (three navigation rows, the theme control, the
 * close control), so eight presses necessarily walk off the end - which is exactly the interesting
 * case, because Radix's focus scope loops back into the panel instead of releasing focus to the
 * page behind the overlay.
 */
const DRAWER_TAB_PRESSES = 8;

/** Budget for the one-off, per-worker fixture provisioning hook: one register, one sign-in, seventeen posts. */
const PROVISION_TIMEOUT_MS = 180_000;

/* -------------------------------------------------------------------------------------------------
 * Wire shapes
 *
 * Declared locally and deliberately NOT imported from `@/lib/types`. A spec that shares the
 * application's own type declarations asserts against the tier's opinion of the contract rather
 * than against the contract, and a rename that broke both would keep this file compiling. These
 * are minimal: only the fields the assertions actually read.
 *
 * The page envelope keeps the service's own `snake_case` - `items`, `total`, `page`, `page_size`,
 * `pages` - because there is no adaptation layer anywhere in this product and a camelCase rewrite
 * would compile and read `undefined`.
 * ---------------------------------------------------------------------------------------------- */

/** The `TokenPair` half of `POST /api/v1/auth/login` that this file uses. */
interface TokenPairPayload {
  readonly access_token: string;
}

/** One entry of the bare array `GET /api/v1/categories` answers - the API's single sanctioned exception to the page envelope. */
interface CategoryPayload {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

/** The fields of `PostDetail` this file needs back from a create or publish call. */
interface PostPayload {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
}

/** The uniform page envelope, as returned by `GET /api/v1/posts`. */
interface PostPagePayload {
  readonly items: readonly PostPayload[];
  readonly total: number;
  readonly page: number;
  readonly page_size: number;
  readonly pages: number;
}

/** A category this worker files its fixture posts under. */
interface FixtureCategory {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

/** A post this worker created, identified by everything the assertions address it with. */
interface FixturePost {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
}

/**
 * Everything one worker provisions for itself, and the only state the tests below share.
 *
 * Immutable by construction: the tests read it and never write to it, so the order they run in
 * cannot change what any later test sees.
 */
interface FeedFixture {
  /** Public handle of the throwaway author, and the `/u/{username}` path segment. */
  readonly authorUsername: string;
  /** The author's display name - the `<h1>` of their profile and the `name` of the `Person` graph. */
  readonly authorDisplayName: string;
  /** Single alphabetic lexeme present in the title of every post in {@link primaryPosts} and {@link outsiderPost}. */
  readonly feedTerm: string;
  /** Single alphabetic lexeme present in {@link titleRankedPost}'s TITLE and only in {@link bodyRankedPost}'s BODY. */
  readonly relevanceTerm: string;
  /** The category {@link primaryPosts} are filed under. */
  readonly primaryCategory: FixtureCategory;
  /** A different category, holding {@link outsiderPost} alone, so a category filter has something to exclude. */
  readonly secondaryCategory: FixtureCategory;
  /** Thirteen published posts under {@link primaryCategory}: one more than a page. */
  readonly primaryPosts: readonly FixturePost[];
  /** The FIRST of {@link primaryPosts} to be published, and therefore the last row of the recency-ordered, category-filtered feed. */
  readonly oldestPrimaryPost: FixturePost;
  /**
   * One published post carrying {@link feedTerm} but filed under {@link secondaryCategory}.
   *
   * Published LAST of the term-scoped set on purpose, so recency puts it in the first card of the
   * unfiltered term feed - which is what makes "the category filter removed it" an assertion about
   * something that was visibly there a moment earlier rather than a vacuous truth.
   */
  readonly outsiderPost: FixturePost;
  /** Published post carrying {@link relevanceTerm} in its title, so the weighted vector scores it 'A'. */
  readonly titleRankedPost: FixturePost;
  /** Published post carrying {@link relevanceTerm} only in its body, so the weighted vector scores it 'C'. */
  readonly bodyRankedPost: FixturePost;
  /** Created and never published: the negative case for the sitemap. */
  readonly draftPost: FixturePost;
  /** The post whose detail page carries the metadata, structured-data and overflow assertions. */
  readonly flagship: FixturePost;
  /** {@link flagship}'s excerpt verbatim, which its `og:description`, `twitter:description` and `BlogPosting.description` must equal. */
  readonly flagshipExcerpt: string;
  /** A sentence that appears only inside {@link flagship}'s body - the string that proves server rendering. */
  readonly flagshipSentence: string;
  /** Slug of the oldest published post the API reports, which necessarily predates the production build and so must be in the sitemap. */
  readonly preExistingPublishedSlug: string;
}

/* -------------------------------------------------------------------------------------------------
 * Provisioning
 * ---------------------------------------------------------------------------------------------- */

/** Character code of `a`, the base of the hex-to-letter mapping in {@link uniqueSuffix}. */
const LOWERCASE_A_CODE = 'a'.charCodeAt(0);

/** Radix of a UUID's hexadecimal digits. */
const HEX_RADIX = 16;

/** Length of the per-run suffix. Twelve hex digits of a v4 UUID is ~48 bits of entropy - collision is not a scenario. */
const SUFFIX_LENGTH = 12;

/**
 * A per-run identifier made of nothing but lowercase letters.
 *
 * PURELY ALPHABETIC ON PURPOSE. The suffix ends up inside a search term, and a search term is
 * parsed by PostgreSQL's `english` text-search configuration: an all-letter token becomes exactly
 * one lexeme, both when the post is indexed and when `websearch_to_tsquery` parses the query, so
 * whatever the stemmer does to it, it does identically to both sides and the match holds. A digit
 * would change the token's type for no benefit.
 *
 * The mapping is the UUID's hex digits shifted into `a`..`p`, which preserves the randomness
 * exactly while spending no dependency: `crypto` is a platform global, not an import.
 */
function uniqueSuffix(): string {
  const hex = crypto.randomUUID().replaceAll('-', '').slice(0, SUFFIX_LENGTH);
  let letters = '';
  for (const character of hex) {
    letters += String.fromCharCode(LOWERCASE_A_CODE + Number.parseInt(character, HEX_RADIX));
  }
  return letters;
}

/** HTTP status the credential routes answer when the configured window is exhausted. */
const TOO_MANY_REQUESTS = 429;

/**
 * Read the API base URL out of the environment, which is where the whole product reads it from.
 *
 * `.env.example` declares `NEXT_PUBLIC_API_BASE_URL` as a base URL *including* the `/api/v1`
 * prefix, and `frontend/playwright.config.ts` loads the project's env files with Next's own
 * loader before this file is evaluated, so the value the pages call is the value provisioning
 * calls. No runner-private variable is invented for it: a configuration source that appears in
 * no contract is a configuration source nobody can audit.
 *
 * Fails closed, because provisioning against a guessed origin would either write into something
 * nobody chose or fail every test on an unreachable request.
 */
function requireApiBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  if (raw === undefined || raw.length === 0) {
    throw new Error(
      'NEXT_PUBLIC_API_BASE_URL is not set, so this spec cannot provision its fixture. It is the ' +
        'same value the pages under test call; see .env.example, for example ' +
        'NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000/api/v1.',
    );
  }
  return raw.replace(/\/+$/u, '');
}

/** Absolute URL of an API route, composed onto the declared base so the `/api/v1` prefix is never dropped or doubled. */
function apiUrl(route: string): string {
  return `${requireApiBaseUrl()}${route}`;
}

/** `Authorization` header for the throwaway author's access token. */
function bearer(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

/**
 * Assert an API call answered the status its contract declares, and say what happened when it did
 * not.
 *
 * This throws rather than returning a flag, so a provisioning failure stops the run with the
 * service's own problem document in the message instead of surfacing later as a puzzling
 * assertion failure three tests away. It is diagnostics, not tolerance: nothing is retried and
 * nothing is swallowed.
 */
async function expectStatus(
  response: APIResponse,
  expected: number,
  action: string,
): Promise<void> {
  const actual = response.status();
  if (actual === expected) {
    return;
  }
  const hint =
    actual === TOO_MANY_REQUESTS
      ? ' The five credential routes are the only throttled routes in the service (AUTH_RATE_LIMIT).' +
        ' This spec spends exactly two of that window per worker, so an exhausted window means' +
        ' another suite is sharing it - widen AUTH_RATE_LIMIT for the gate rather than retrying here.'
      : '';
  const body = (await response.text()).slice(0, 400);
  throw new Error(
    `${action} answered ${String(actual)}, expected ${String(expected)}.${hint} Body: ${body}`,
  );
}

/** Parse a JSON response body into one of the wire shapes above. */
async function readJson<T>(response: APIResponse): Promise<T> {
  return (await response.json()) as T;
}

/** Create a post as the throwaway author. Answers 201 with the server-generated id and slug. */
async function createFixturePost(
  api: APIRequestContext,
  accessToken: string,
  body: { title: string; excerpt: string; content: string; category_ids: readonly string[] },
): Promise<FixturePost> {
  const response = await api.post(apiUrl('/posts'), { data: body, headers: bearer(accessToken) });
  await expectStatus(response, 201, `POST /posts (${body.title})`);
  const payload = await readJson<PostPayload>(response);
  return { id: payload.id, slug: payload.slug, title: payload.title };
}

/** Transition a post to PUBLISHED, which is what puts it in the public feed and in the sitemap. */
async function publishFixturePost(
  api: APIRequestContext,
  accessToken: string,
  post: FixturePost,
): Promise<void> {
  const response = await api.post(apiUrl(`/posts/${post.id}/publish`), {
    headers: bearer(accessToken),
  });
  await expectStatus(response, 200, `POST /posts/${post.id}/publish (${post.title})`);
}

/** Read one window of the public feed anonymously, exactly as the home page reads it. */
async function readFeedWindow(
  api: APIRequestContext,
  params: { page: number; page_size: number },
): Promise<PostPagePayload> {
  const response = await api.get(apiUrl('/posts'), {
    params: { page: params.page, page_size: params.page_size },
  });
  await expectStatus(response, 200, `GET /posts?page=${String(params.page)}`);
  return readJson<PostPagePayload>(response);
}

/**
 * Slug of the oldest published post in the catalogue.
 *
 * Walked to the last page of the recency-ordered feed rather than sorted client-side, and used
 * for one purpose only: the sitemap's "lists published posts" criterion. It has to be a post that
 * provably predates the production build, because `src/app/sitemap.ts` declares
 * `revalidate = 3600` over cached reads and is therefore prerendered by `next build` and served
 * from that copy for an hour. The oldest published post is necessarily part of the corpus
 * `app.db.seed` wrote before the build started - Playwright brings the API up and waits on
 * `/readyz` before it starts the frontend build - whereas anything this worker publishes during
 * the run cannot be in a document that was rendered before the run began.
 */
async function readOldestPublishedSlug(api: APIRequestContext): Promise<string> {
  const window = 100;
  const first = await readFeedWindow(api, { page: 1, page_size: window });
  const last =
    first.pages > 1 ? await readFeedWindow(api, { page: first.pages, page_size: window }) : first;
  const oldest = last.items.at(-1);
  if (oldest === undefined) {
    throw new Error(
      'The published feed is empty, so there is no post that predates the production build. ' +
        'Run the seeder (backend: python -m app.db.seed) before the end-to-end gate; ' +
        'playwright.config.ts does this for a local target.',
    );
  }
  return oldest.slug;
}

/**
 * Build this worker's entire corpus, and read back the one datum it cannot create.
 *
 * Runs once per worker. The seventeen posts are created and published SEQUENTIALLY, and the order
 * is load-bearing rather than incidental: the service orders `sort=recent` by `published_at DESC`
 * with `posts.id DESC` breaking every remaining tie, so publication order fixes exactly which
 * post lands on which page of the term-scoped feed. Two consequences are relied on below - the
 * outsider is published LAST, so it is the first card of the unfiltered term feed and its removal
 * by the category filter is observable; and the first chapter is published FIRST, so it is the
 * single row of the filtered feed's second page.
 */
async function provisionFeedFixture(api: APIRequestContext): Promise<FeedFixture> {
  const suffix = uniqueSuffix();

  // THREE INDEPENDENT IDENTIFIERS, SHARING NO SUBSTRING. Not belt and braces - a measured
  // requirement. The feed's search predicate is `search_vector @@ tsquery OR title % term`, and
  // that second operator is trigram similarity at PostgreSQL's default threshold of 0.3, there to
  // make search typo-tolerant. Two terms that share a long substring therefore match each other's
  // posts. Measured with one shared suffix behind two prefixes differing in four characters:
  // `similarity('Home feed fixture feedgate<s> chapter 3', 'rankgate<s>')` resolved to exactly
  // 0.30, and a search for the relevance term returned eleven posts where two were expected.
  // Independent suffixes behind non-overlapping prefixes put the worst similarity observed over
  // three hundred samples at 0.083 - a 3.6x margin below the threshold.
  const feedTerm = `feedgate${uniqueSuffix()}`;
  const relevanceTerm = `rankmark${uniqueSuffix()}`;
  const runMark = `runid${uniqueSuffix()}`;

  // The throwaway identity. Every part of it is COMPOSED FROM THE RANDOM SUFFIX rather than
  // written down, so there is no credential literal in this file, nothing here names an account
  // that existed before this run, and nothing here will open one after it. The passphrase below is
  // a generated string that satisfies the service's policy - at least twelve characters drawn from
  // at least three character classes - and is a secret of nothing: the account it opens is created
  // by this hook and is only ever reachable by a value no one else can reproduce.
  //
  // `example.com` is the IANA-reserved documentation domain, so the address can receive no mail.
  // It is also the only reserved choice available: the API validates addresses with
  // `email-validator`, whose special-use domain list rejects `.invalid`, `.test`, `.local`,
  // `.localhost`, `.arpa` and `.onion` outright - measured, not assumed.
  const username = `homefeed-${suffix}`;
  const emailAddress = `homefeed-${suffix}@example.com`;
  const authorDisplayName = `Home Feed Author ${suffix}`;
  const passphrase = `Home-Feed-Gate-${suffix}-1`;

  const registration = await api.post(apiUrl('/auth/register'), {
    data: {
      email: emailAddress,
      username,
      password: passphrase,
      display_name: authorDisplayName,
    },
  });
  await expectStatus(registration, 201, 'POST /auth/register');

  // The sign-in route takes the OAuth 2 password grant's form, not JSON, and this API's
  // identifier is an email address - so the address goes in the form's `username` field.
  const signIn = await api.post(apiUrl('/auth/login'), {
    form: { username: emailAddress, password: passphrase },
  });
  await expectStatus(signIn, 200, 'POST /auth/login');
  const accessToken = (await readJson<TokenPairPayload>(signIn)).access_token;

  const categoriesResponse = await api.get(apiUrl('/categories'));
  await expectStatus(categoriesResponse, 200, 'GET /categories');
  // A bare array, not a page envelope. Reaching for `.items` here is the documented mistake.
  const categories = await readJson<readonly CategoryPayload[]>(categoriesResponse);
  const primaryCategory = categories[0];
  const secondaryCategory = categories[1];
  if (primaryCategory === undefined || secondaryCategory === undefined) {
    throw new Error(
      `GET /categories answered ${String(categories.length)} categor(y|ies); this spec needs two ` +
        'distinct ones to prove a category filter both includes and excludes. Migration 0003 ' +
        'seeds eight reference categories - apply migrations before the gate.',
    );
  }

  // Chapter numbers are zero-padded so every primary title is the SAME length. Trigram similarity
  // is a function of a title's length, so uniform titles score uniformly against any term - which
  // removes the class of failure where nine of thirteen otherwise-identical posts crossed a
  // threshold and four did not.
  const chapterLabel = (chapter: number): string => String(chapter).padStart(2, '0');
  const titleFor = (chapter: number): string =>
    `Home feed fixture ${feedTerm} chapter ${chapterLabel(chapter)} of the gate corpus`;
  const excerptFor = (chapter: number): string =>
    `Fixture excerpt for the home feed gate, chapter ${chapterLabel(chapter)}.`;
  const sentenceFor = (chapter: number): string =>
    `Server rendered paragraph ${runMark} of chapter ${chapterLabel(chapter)} reached the crawler.`;
  const bodyFor = (chapter: number): string =>
    `${sentenceFor(chapter)}\n\nThis second paragraph gives chapter ${chapterLabel(chapter)} a ` +
    'body of realistic length, so the reading-time estimate and the rendered prose both have ' +
    'something to measure.';

  /** Chapter number the outsider's body is written for - outside the primary range on purpose. */
  const OUTSIDER_CHAPTER = 98;
  /** Chapter number the unpublished draft's body is written for. */
  const DRAFT_CHAPTER = 99;

  const primaryPosts: FixturePost[] = [];
  for (let chapter = 1; chapter <= PRIMARY_POST_COUNT; chapter += 1) {
    const post = await createFixturePost(api, accessToken, {
      title: titleFor(chapter),
      excerpt: excerptFor(chapter),
      content: bodyFor(chapter),
      category_ids: [primaryCategory.id],
    });
    await publishFixturePost(api, accessToken, post);
    primaryPosts.push(post);
  }

  // The relevance pair. The term is in one title and in the other's body ONLY, so the generated
  // vector weights them 'A' and 'C' respectively and `ts_rank` must order the headline first.
  const titleRankedPost = await createFixturePost(api, accessToken, {
    title: `Ranked headline ${relevanceTerm} carries the term in its title`,
    excerpt: 'Fixture excerpt with no ranked term in it at all.',
    content:
      'This body deliberately omits the ranked term, so every point of this post\u2019s score ' +
      'comes from its headline.',
    category_ids: [primaryCategory.id],
  });
  await publishFixturePost(api, accessToken, titleRankedPost);

  const bodyRankedPost = await createFixturePost(api, accessToken, {
    title: `Ranked body only for gate run ${runMark}`,
    excerpt: 'Fixture excerpt with no ranked term in it at all.',
    content: `This body mentions ${relevanceTerm} once, and the headline above never does, so the weighted vector scores it lowest.`,
    category_ids: [primaryCategory.id],
  });
  await publishFixturePost(api, accessToken, bodyRankedPost);

  // Published LAST of everything that carries the feed term, so recency puts it first in the
  // unfiltered term feed. It is the only such post filed under the second category, which is what
  // the category filter has to remove - and it can only be seen to be removed if it was on screen
  // to begin with.
  const outsiderPost = await createFixturePost(api, accessToken, {
    title: `Home feed fixture ${feedTerm} outside the primary category`,
    excerpt: 'Fixture excerpt for the post the category filter must exclude.',
    content: bodyFor(OUTSIDER_CHAPTER),
    category_ids: [secondaryCategory.id],
  });
  await publishFixturePost(api, accessToken, outsiderPost);

  // Created and never published. The public feed, the profile listing and the sitemap must all
  // behave as though it does not exist.
  const draftPost = await createFixturePost(api, accessToken, {
    title: `Home feed fixture ${feedTerm} unpublished draft`,
    excerpt: 'Fixture excerpt for a post that is never published.',
    content: bodyFor(DRAFT_CHAPTER),
    category_ids: [primaryCategory.id],
  });

  const flagship = primaryPosts.at(-1);
  const oldestPrimaryPost = primaryPosts.at(0);
  if (flagship === undefined || oldestPrimaryPost === undefined) {
    throw new Error('The fixture published no primary posts, so there is no flagship to address.');
  }

  return {
    authorUsername: username,
    authorDisplayName,
    feedTerm,
    relevanceTerm,
    primaryCategory: {
      id: primaryCategory.id,
      name: primaryCategory.name,
      slug: primaryCategory.slug,
    },
    secondaryCategory: {
      id: secondaryCategory.id,
      name: secondaryCategory.name,
      slug: secondaryCategory.slug,
    },
    primaryPosts,
    oldestPrimaryPost,
    outsiderPost,
    titleRankedPost,
    bodyRankedPost,
    draftPost,
    flagship,
    flagshipExcerpt: excerptFor(PRIMARY_POST_COUNT),
    flagshipSentence: sentenceFor(PRIMARY_POST_COUNT),
    preExistingPublishedSlug: await readOldestPublishedSlug(api),
  };
}

/**
 * The provisioned fixture, or `null` until the worker's `beforeAll` has built it.
 *
 * Module scope rather than a Playwright fixture, because it is built exactly once per worker and
 * every test reads the same corpus. {@link feed} is the only accessor, and it throws rather than
 * offering a non-null assertion, so a test can never silently run against a half-built world.
 */
let provisioned: FeedFixture | null = null;

/** The fixture, guaranteed present. */
function feed(): FeedFixture {
  if (provisioned === null) {
    throw new Error(
      'The home-feed fixture was not provisioned. The top-level beforeAll builds it once per ' +
        'worker; if it failed, its own error is the one to read.',
    );
  }
  return provisioned;
}

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(PROVISION_TIMEOUT_MS);
  // A request context of this file's own, because `request` is test-scoped and a worker-scoped
  // hook cannot have one. Disposed unconditionally: `finally` releases the socket without
  // catching - and therefore without hiding - a provisioning failure.
  const api = await playwright.request.newContext();
  try {
    provisioned = await provisionFeedFixture(api);
  } finally {
    await api.dispose();
  }
});

/* -------------------------------------------------------------------------------------------------
 * URLs
 *
 * Every path below is ROOT-RELATIVE, because the origin under test belongs to the configuration
 * (`baseURL`, resolved from `NEXT_PUBLIC_SITE_URL`) and hard-coding one here would aim a green
 * gate at whatever host the literal named. The only place an absolute URL is built is a context
 * this file creates itself, and it is composed onto `baseURL` rather than written out.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The feed's entire public query surface: the four parameters `src/app/page.tsx` reads.
 *
 * `page_size` is deliberately absent, exactly as it is absent from the route - the window is that
 * route's rendering decision, not part of the resource's identity.
 */
interface FeedQuery {
  readonly q?: string;
  readonly category?: string;
  readonly page?: number;
  readonly sort?: 'recent' | 'relevance';
}

/**
 * A root-relative feed URL.
 *
 * The parameter ORDER this produces is deliberately not asserted anywhere: `hrefForPage` in
 * `@/hooks/use-pagination` preserves the order it received and appends `page` last, so the
 * control's URLs and these are equal as URLs but not as strings. Every URL assertion in this file
 * therefore reads `searchParams` through a predicate rather than comparing text.
 */
function feedPath(query: FeedQuery = {}): string {
  const search = new URLSearchParams();
  if (query.q !== undefined) {
    search.set('q', query.q);
  }
  if (query.category !== undefined) {
    search.set('category', query.category);
  }
  if (query.page !== undefined) {
    search.set('page', String(query.page));
  }
  if (query.sort !== undefined) {
    search.set('sort', query.sort);
  }
  const serialised = search.toString();
  return serialised.length > 0 ? `/?${serialised}` : '/';
}

/** A post's reader-facing path. The `/blog` family is public and, crucially, is NOT the disallowed `/posts` family. */
function postPath(slug: string): string {
  return `/blog/${slug}`;
}

/** An author's public profile path. */
function profilePath(username: string): string {
  return `/u/${username}`;
}

/**
 * Parse base for the root-relative `href`s the page control emits.
 *
 * `new URL` needs a base to resolve a relative reference; nothing is ever requested from this
 * one, and the reserved `.invalid` TLD guarantees that stays true even by accident.
 */
const HREF_PARSE_BASE = 'http://parse.invalid';

/** The site origin under test, from the configuration rather than from a literal. */
function requireBaseURL(baseURL: string | undefined): string {
  if (baseURL === undefined || baseURL.length === 0) {
    throw new Error(
      'No baseURL is configured. frontend/playwright.config.ts resolves it from ' +
        'NEXT_PUBLIC_SITE_URL; export that variable (see .env.example) before running the gate.',
    );
  }
  return baseURL.replace(/\/+$/u, '');
}

/** Compose a root-relative path onto the configured origin, for a page this file opens outside the `page` fixture. */
function absoluteUrl(baseURL: string | undefined, path: string): string {
  return `${requireBaseURL(baseURL)}${path}`;
}

/** The width the current project runs at, which is what every responsive expectation branches on. */
function requireWidth(viewport: { readonly width: number } | null): number {
  if (viewport === null) {
    throw new Error(
      'This project declares no viewport, so no responsive expectation can be derived. All three ' +
        'projects in frontend/playwright.config.ts set one (375, 768 and 1440).',
    );
  }
  return viewport.width;
}

/**
 * Navigate and assert the navigation itself succeeded.
 *
 * Used for every navigation in this file, so a route that answers 404 or 500 fails on the
 * response rather than several assertions later on a missing heading. It is also how the
 * out-of-range page proves it is a 200 and not an error.
 */
async function visit(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(response, `GET ${path} must produce a response`).not.toBeNull();
  expect(response?.status(), `GET ${path} must answer 200`).toBe(200);
}

/* -------------------------------------------------------------------------------------------------
 * Reading the rendered feed
 *
 * Locators only: `role=article` for a card (`post-card.tsx` renders `Card as="article"`), the
 * heading inside it for its title, `role=navigation` named "Pagination" for the page control.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a query should reach content the accessibility tree currently excludes.
 *
 * Needed for exactly one situation, and it is a real one rather than a convenience. `next start`
 * streams a dynamic route: because `src/app/loading.tsx` declares a Suspense boundary for the root
 * segment, the framework flushes that skeleton inside `<main>` first and delivers the finished
 * markup later in the SAME response, inside a `<div hidden>` that an inline script swaps into
 * place. With scripting enabled the swap happens before any assertion runs and this option is
 * never needed. With scripting DISABLED - which is the whole point of the server-rendering group -
 * the markup is in the document but still hidden, so a default role query would report the server
 * had rendered nothing when in fact it had rendered everything. Measured directly against the
 * production output: the article's `<h1>` sits at byte 77,744 of an 88KB single-document response,
 * inside `<div hidden id="S:2">`.
 */
interface HiddenContentOptions {
  readonly includeHidden?: boolean;
}

/**
 * The region a content locator searches.
 *
 * The `main` landmark normally, and that scoping is load-bearing rather than tidiness. The same
 * streaming that puts the article in a `<div hidden>` also leaves that container in place for a
 * short window AFTER the inline script has swapped its children into the live tree, so for a
 * moment the document holds two copies of the feed - one live inside `<main>`, one inert outside
 * it. Measured on the production build: immediately after `load`, two paragraphs matched the
 * result-range pattern, one with a `[hidden]` ancestor and one without; a second later only the
 * live one remained. Role queries filter the inert copy out on their own, because it is not in the
 * accessibility tree, but a text query does not - which is exactly how an unscoped result-range
 * locator resolved to two elements and failed strict mode.
 *
 * When hidden content is what is being looked for, the scope widens to the whole document, because
 * in a scripting-disabled context the content never reaches `<main>` at all.
 */
function contentScope(page: Page, options: HiddenContentOptions = {}): Locator {
  return options.includeHidden === true ? page.locator('body') : page.getByRole('main');
}

/** Every card the feed rendered, in document order. */
function feedCards(page: Page, options: HiddenContentOptions = {}): Locator {
  return contentScope(page, options).getByRole('article', { includeHidden: options.includeHidden });
}

/** The titles of those cards, in document order. */
async function cardTitles(page: Page, options: HiddenContentOptions = {}): Promise<string[]> {
  const titles = await feedCards(page, options)
    .getByRole('heading', { includeHidden: options.includeHidden })
    .allInnerTexts();
  return titles.map((title) => title.trim());
}

/** The page control. */
function paginationNav(page: Page, options: HiddenContentOptions = {}): Locator {
  return contentScope(page, options).getByRole('navigation', {
    name: PAGINATION_LABEL,
    includeHidden: options.includeHidden,
  });
}

/**
 * The result-range sentence beneath the grid - `formatResultRange` in `@/lib/utils`.
 *
 * Anchored, so only the sentence itself matches and not the wrapper that also contains the page
 * control. It is the feed's own report of `page_size` and `total`, which is what makes an
 * internal-consistency assertion possible without asserting an absolute number.
 */
const RESULT_RANGE_PATTERN = new RegExp(`^Showing \\d+${EN_DASH}\\d+ of \\d+ results?$`, 'u');

/** Locator for that sentence. */
function resultRange(page: Page, options: HiddenContentOptions = {}): Locator {
  return contentScope(page, options).getByText(RESULT_RANGE_PATTERN);
}

/** The exact sentence the feed must render for a given window, including its plural rule. */
function resultRangeText(first: number, last: number, total: number): string {
  const noun = total === 1 ? 'result' : 'results';
  return `Showing ${String(first)}${EN_DASH}${String(last)} of ${String(total)} ${noun}`;
}

/** The three numbers in that sentence, parsed. */
async function readResultRange(
  page: Page,
): Promise<{ first: number; last: number; total: number }> {
  const sentence = (await resultRange(page).innerText()).trim();
  const parsed = new RegExp(`^Showing (\\d+)${EN_DASH}(\\d+) of (\\d+) results?$`, 'u').exec(
    sentence,
  );
  if (parsed === null) {
    throw new Error(`The feed's result range did not have the expected shape: ${sentence}`);
  }
  const [, first, last, total] = parsed;
  return {
    first: Number.parseInt(first ?? '', 10),
    last: Number.parseInt(last ?? '', 10),
    total: Number.parseInt(total ?? '', 10),
  };
}

/**
 * Every `href` the page control renders, read from the anchors themselves.
 *
 * Read as attributes rather than through `getByRole`, and that is deliberate: below `sm` the
 * control hides the page links outside the current sibling window, so a role query would miss
 * them in the mobile project while a crawler would still follow them. The set of addressable
 * pages is a property of the markup, not of the viewport, and this is what makes the same
 * assertion true at all three widths.
 */
async function paginationHrefs(page: Page, options: HiddenContentOptions = {}): Promise<string[]> {
  const nav = paginationNav(page, options);
  await expect(nav, 'the feed must render exactly one page control').toHaveCount(1);
  return nav
    .locator('a')
    .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? ''));
}

/** The page number an `href` addresses. Page one is addressed by the bare path, so an absent parameter means one. */
function pageNumberOf(href: string): number {
  const requested = new URL(href, HREF_PARSE_BASE).searchParams.get('page');
  return requested === null ? 1 : Number.parseInt(requested, 10);
}

/** Every page number the control links to, deduplicated and ascending. */
async function paginationPageNumbers(
  page: Page,
  options: HiddenContentOptions = {},
): Promise<number[]> {
  const hrefs = await paginationHrefs(page, options);
  return [...new Set(hrefs.map(pageNumberOf))].sort((left, right) => left - right);
}

/* -------------------------------------------------------------------------------------------------
 * Computed geometry
 *
 * The whole responsive contract is proven here, and every function below reads a COMPUTED value
 * out of the live layout. Not one of them looks at a class name, which is what leaves
 * `post-list.tsx` free to express its one/two/three tracks however it likes.
 * ---------------------------------------------------------------------------------------------- */

/**
 * How many column tracks the feed's grid container resolves to.
 *
 * The container is reached from a card rather than selected directly, because it has no role and
 * no accessible name of its own: a card is an `<article>` inside an `<li>`, and the grid is that
 * item's parent. Walking the semantic structure is what keeps this free of a class selector.
 *
 * `grid-template-columns` computes to a list of used track sizes in pixels - "409px 409px 409px"
 * for three - so counting the entries counts the columns.
 */
async function feedGridTrackCount(page: Page): Promise<number> {
  const firstCard = feedCards(page).first();
  await expect(firstCard, 'the feed must render at least one card to measure').toBeVisible();
  return firstCard.evaluate((card) => {
    const item = card.closest('li');
    const grid = item === null ? null : item.parentElement;
    if (grid === null) {
      throw new Error('A feed card was not found inside a list item inside the grid container.');
    }
    const tracks = window.getComputedStyle(grid).gridTemplateColumns.trim();
    if (tracks.length === 0 || tracks === 'none') {
      throw new Error(`The feed container declares no column tracks (resolved to "${tracks}").`);
    }
    return tracks.split(/\s+/u).length;
  });
}

/**
 * How many cards share the topmost row of the grid.
 *
 * The independent check on {@link feedGridTrackCount}: one reads the declared tracks, this one
 * measures where the cards actually landed. Both have to agree for a column count to be believed,
 * and together they catch the case a track count alone would miss - a card that escapes its cell.
 */
async function firstRowCardCount(page: Page): Promise<number> {
  const tops = await feedCards(page).evaluateAll((cards) =>
    cards.map((card) => card.getBoundingClientRect().top),
  );
  if (tops.length === 0) {
    throw new Error('The feed rendered no cards, so no row membership can be measured.');
  }
  const topmost = Math.min(...tops);
  return tops.filter((top) => Math.abs(top - topmost) <= ROW_TOLERANCE_PX).length;
}

/**
 * Assert the document does not scroll sideways.
 *
 * §0.9.4.5 requires no horizontal overflow at any width, and this is the assertion that earns
 * its place: a fixed width, an unbreakable string or an unconstrained image escaping the layout
 * is the most common responsive defect there is, and it is invisible to every locator-based
 * assertion while being obvious to a reader on a phone.
 */
async function expectNoHorizontalOverflow(page: Page, surface: string): Promise<void> {
  const measured = await page.evaluate(() => {
    const root = document.documentElement;
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
  });
  expect(
    measured.scrollWidth,
    `${surface} overflows horizontally: the document scrolls to ${String(measured.scrollWidth)}px ` +
      `inside a ${String(measured.clientWidth)}px viewport.`,
  ).toBeLessThanOrEqual(measured.clientWidth + OVERFLOW_TOLERANCE_PX);
}

/* -------------------------------------------------------------------------------------------------
 * Head metadata and structured data
 *
 * The attribute selectors here address semantic metadata elements - a canonical `<link>`, an
 * OpenGraph `<meta>`, a JSON-LD `<script>`. None of them has a role, a name or visible text, so
 * an attribute selector is the only way to address them at all; none of them is a class selector.
 * ---------------------------------------------------------------------------------------------- */

/** Read a single element's attribute, asserting the element is present exactly once and the attribute is set. */
async function attributeOf(page: Page, selector: string, attribute: string): Promise<string> {
  const element = page.locator(selector);
  await expect(element, `exactly one ${selector} must be present`).toHaveCount(1);
  const value = await element.getAttribute(attribute);
  expect(value, `${selector} must carry a ${attribute}`).not.toBeNull();
  return value ?? '';
}

/** An OpenGraph value, which the framework emits as `<meta property>`. */
async function openGraph(page: Page, property: string): Promise<string> {
  return attributeOf(page, `meta[property="${property}"]`, 'content');
}

/** A Twitter card value, which the framework emits as `<meta name>`. */
async function twitterCard(page: Page, name: string): Promise<string> {
  return attributeOf(page, `meta[name="${name}"]`, 'content');
}

/** Narrow an unknown parsed value to an object, with a message that says which part of the graph failed. */
function asRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, `${label} must not be null`).not.toBeNull();
  expect(typeof value, `${label} must be an object`).toBe('object');
  return value as Record<string, unknown>;
}

/**
 * The page's single structured-data graph, parsed.
 *
 * `components/seo/json-ld.tsx` renders exactly one `<script type="application/ld+json">` per
 * page - `BlogPosting` on an article, `Person` on a profile - so the count assertion is part of
 * the contract rather than defensive. The parse failure is re-thrown with the offending body
 * because an unparseable graph is the classic structured-data defect and the default
 * `SyntaxError` says nothing about which page produced it.
 */
async function readJsonLdGraph(page: Page): Promise<Record<string, unknown>> {
  // Scoped to the main landmark for the reason `contentScope` documents: the graph is emitted by the
  // page component, so the inert streaming copy of that component holds a second `<script>` for a
  // window after load, and a document-wide count would intermittently see two.
  const script = contentScope(page).locator('script[type="application/ld+json"]');
  await expect(script, 'a page must publish exactly one structured-data block').toHaveCount(1);
  const serialised = await script.textContent();
  expect(serialised, 'the structured-data block must not be empty').not.toBeNull();
  const body = serialised ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new Error(
      `The structured-data block is not valid JSON (${String(cause)}). Body: ${body.slice(0, 300)}`,
    );
  }
  return asRecord(parsed, 'the structured-data graph');
}

/** Every path within *value* that holds `null`, as dotted paths for the failure message. */
function collectNullPaths(value: unknown, path: string, found: string[]): void {
  if (value === null) {
    found.push(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectNullPaths(entry, `${path}[${String(index)}]`, found);
    });
    return;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      collectNullPaths(entry, `${path}.${key}`, found);
    }
  }
}

/**
 * Assert a graph omits what it does not have rather than publishing `null`.
 *
 * This is the documented behaviour of `json-ld.tsx`, and it matters because the nullable fields
 * are real: `published_at` is null on a draft, and `excerpt`, `cover_image_url`, `avatar_url` and
 * `bio` are all nullable. A `null` in structured data is not a missing value to a consumer, it is
 * an invalid one.
 */
function expectNoNullProperties(graph: Record<string, unknown>, label: string): void {
  const nulls: string[] = [];
  collectNullPaths(graph, label, nulls);
  expect(nulls, `${label} must omit absent fields rather than emitting null`).toEqual([]);
}

/* -------------------------------------------------------------------------------------------------
 * Discovery artifacts
 *
 * Asserted from the response text with a regular expression, because adding an XML parser to
 * satisfy one assertion would breach the pinned-dependency standard for no gain: `<loc>` is a
 * flat element with no attributes and no nesting.
 * ---------------------------------------------------------------------------------------------- */

/** `<loc>` elements of a sitemap. */
const SITEMAP_LOCATION_PATTERN = /<loc>([^<]*)<\/loc>/gu;

/** Every URL a sitemap advertises, with XML's ampersand escape undone so query strings compare cleanly. */
function sitemapLocations(body: string): string[] {
  return [...body.matchAll(SITEMAP_LOCATION_PATTERN)].map((match) =>
    (match[1] ?? '').replaceAll('&amp;', '&'),
  );
}

/** The directives a robots policy declares, grouped by keyword. */
interface RobotsDirectives {
  readonly userAgents: string[];
  readonly allow: string[];
  readonly disallow: string[];
  readonly sitemap: string[];
  readonly host: string[];
}

/** Parse a `robots.txt` body into its directives, case-insensitively on the keyword. */
function robotsDirectives(body: string): RobotsDirectives {
  const directives: RobotsDirectives = {
    userAgents: [],
    allow: [],
    disallow: [],
    sitemap: [],
    host: [],
  };
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    const separator = trimmed.indexOf(':');
    if (trimmed.length === 0 || trimmed.startsWith('#') || separator < 0) {
      continue;
    }
    const keyword = trimmed.slice(0, separator).trim().toLowerCase();
    const value = trimmed.slice(separator + 1).trim();
    switch (keyword) {
      case 'user-agent':
        directives.userAgents.push(value);
        break;
      case 'allow':
        directives.allow.push(value);
        break;
      case 'disallow':
        directives.disallow.push(value);
        break;
      case 'sitemap':
        directives.sitemap.push(value);
        break;
      case 'host':
        directives.host.push(value);
        break;
      default:
        break;
    }
  }
  return directives;
}

/* -------------------------------------------------------------------------------------------------
 * Keyboard and focus
 *
 * Hand-written, because no accessibility scanner is a declared dependency and adding one would
 * breach the pinned-dependency standard. These three functions are the whole of the §0.9.4.5
 * keyboard floor this file owns.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Drive focus to *target* using nothing but the Tab key, and fail if it cannot be reached.
 *
 * Tabbing rather than calling `focus()` is the entire point: a control reachable only
 * programmatically is not keyboard-accessible, and `element.focus()` would report success for one
 * that a reader could never get to. Focus continues from wherever it currently is, so consecutive
 * calls walk forward through the document in its real tab order.
 */
async function focusByTabbing(page: Page, target: Locator, label: string): Promise<void> {
  for (let press = 1; press <= MAX_TAB_PRESSES; press += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((node) => node === document.activeElement)) {
      return;
    }
  }
  throw new Error(
    `${label} was not reachable within ${String(MAX_TAB_PRESSES)} Tab presses, so it is not ` +
      'keyboard accessible from the top of the document.',
  );
}

/**
 * Assert the focused control draws an outline.
 *
 * `globals.css` sets a `:focus-visible` floor of a 2px solid outline for the whole document and
 * every primitive layers its own `focus-visible:` outline on the same width, so a resolved
 * outline of zero width - or none at all - means a keyboard user cannot see where they are. Read
 * as a computed style rather than as a class, so it holds however the indicator is expressed.
 */
async function expectVisibleFocusRing(target: Locator, label: string): Promise<void> {
  const indicator = await target.evaluate((node) => {
    const computed = window.getComputedStyle(node);
    return { style: computed.outlineStyle, width: computed.outlineWidth };
  });
  expect(indicator.style, `${label} must draw a focus outline while keyboard-focused`).not.toBe(
    'none',
  );
  expect(
    Number.parseFloat(indicator.width),
    `${label} must draw a focus outline of non-zero width`,
  ).toBeGreaterThan(0);
}

/**
 * Whether focus is currently inside the open dialog.
 *
 * `[role="dialog"]` addresses the panel by the ARIA role Radix gives it, which is the only handle
 * a focus-containment check can use: the assertion is about the active element's ancestry, not
 * about any locator.
 */
async function activeElementIsInsideDialog(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const active = document.activeElement;
    return dialog !== null && active !== null && dialog.contains(active);
  });
}

/* =================================================================================================
 * 1. FEED COMPOSITION - AAP §0.9.4.4 "Feed composition"
 *
 * Every test in this group drives the term-scoped feed, which is what makes the numbers exact:
 * `?q=<feed term>` narrows the catalogue to the fourteen posts this worker published, so `total`,
 * `pages` and the result range cannot be moved by a concurrent project, by the seeded corpus or by
 * rows a previous run left behind.
 * ============================================================================================== */

test.describe('feed composition', () => {
  test('reports a result range and page count consistent with the total it declares', async ({
    page,
  }) => {
    const fixture = feed();
    await visit(page, feedPath({ q: fixture.feedTerm, sort: 'recent' }));

    await expect(page.getByRole('heading', { level: 1, name: FEED_HEADING })).toBeVisible();
    await expect(feedCards(page)).toHaveCount(FEED_PAGE_SIZE);
    await expect(resultRange(page)).toHaveText(
      resultRangeText(1, FEED_PAGE_SIZE, TERMED_POST_COUNT),
    );

    // The consistency assertion, which is the one that would survive a change to the feed's page
    // size: the number of cards on screen must equal the window the feed says it served, and the
    // highest page the control links to must equal the arithmetic over the total and that window.
    const range = await readResultRange(page);
    const servedWindow = range.last - range.first + 1;
    expect(await feedCards(page).count()).toBe(servedWindow);

    const linkedPages = await paginationPageNumbers(page);
    expect(linkedPages).toContain(1);
    expect(Math.max(...linkedPages)).toBe(Math.ceil(range.total / servedWindow));
    expect(Math.max(...linkedPages)).toBe(TERMED_PAGE_COUNT);
  });

  test('ranks a title match above a body-only match for a searched term', async ({ page }) => {
    const fixture = feed();
    await visit(page, '/');

    // Typed into the field rather than pushed as a URL, so the debounce, the URL write and the
    // server re-render are all exercised. No sleep: the URL assertion and the card count are both
    // auto-retrying, which is the correct tool for a debounced control.
    const search = page.getByRole('searchbox', { name: FEED_SEARCH_LABEL });
    await expect(search).toBeVisible();
    await search.fill(fixture.relevanceTerm);
    await expect(page).toHaveURL((url) => url.searchParams.get('q') === fixture.relevanceTerm);

    // Exactly two posts carry the term, and the weighted vector scores the headline 'A' against the
    // body's 'C', so `ts_rank` must put the headline first.
    await expect(feedCards(page)).toHaveCount(2);
    expect(await cardTitles(page)).toEqual([
      fixture.titleRankedPost.title,
      fixture.bodyRankedPost.title,
    ]);
  });

  test('restricts the feed to the category chosen in the filter', async ({ page }) => {
    const fixture = feed();
    await visit(page, feedPath({ q: fixture.feedTerm, sort: 'recent' }));

    // The post filed under the other category is the newest of the set, so it is on screen before
    // the filter is applied. That is what makes its later absence meaningful.
    const outsider = page.getByRole('link', { name: fixture.outsiderPost.title, exact: true });
    await expect(outsider).toBeVisible();

    const filter = page.getByRole('combobox', { name: CATEGORY_FILTER_LABEL });
    await expect(filter).toBeVisible();
    await filter.click();
    const option = page.getByRole('option', { name: fixture.primaryCategory.name });
    await expect(option).toHaveCount(1);
    await option.click();

    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get('category') === fixture.primaryCategory.slug &&
        url.searchParams.get('q') === fixture.feedTerm &&
        !url.searchParams.has('page'),
    );
    await expect(resultRange(page)).toHaveText(
      resultRangeText(1, FEED_PAGE_SIZE, PRIMARY_POST_COUNT),
    );

    // Every card on screen carries the chosen category's badge - the badge is a link named for the
    // category, so this is an assertion about what the card says, not about how it is styled.
    const cards = feedCards(page);
    await expect(cards).toHaveCount(FEED_PAGE_SIZE);
    const onScreen = await cards.count();
    for (let index = 0; index < onScreen; index += 1) {
      await expect(
        cards.nth(index).getByRole('link', { name: fixture.primaryCategory.name, exact: true }),
        `card ${String(index + 1)} must be filed under ${fixture.primaryCategory.name}`,
      ).toHaveCount(1);
    }
    await expect(outsider).toHaveCount(0);
  });

  test('serves a second page whose posts do not repeat the first', async ({ page }) => {
    const fixture = feed();
    await visit(page, feedPath({ q: fixture.feedTerm, sort: 'recent' }));

    // Settled with an auto-retrying assertion before the titles are read. A plain read is a single
    // snapshot, and the framework streams this route: `load` fires while `<main>` still holds the
    // Suspense skeleton, so reading straight after a navigation reads the skeleton.
    await expect(feedCards(page)).toHaveCount(FEED_PAGE_SIZE);
    const firstPageTitles = await cardTitles(page);
    expect(firstPageTitles).toHaveLength(FEED_PAGE_SIZE);

    const nav = paginationNav(page);
    await nav.getByRole('link', { name: 'Page 2', exact: true }).click();
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get('page') === '2' && url.searchParams.get('q') === fixture.feedTerm,
    );
    await expect(feedCards(page)).toHaveCount(TERMED_POST_COUNT - FEED_PAGE_SIZE);

    const secondPageTitles = await cardTitles(page);
    expect(secondPageTitles.filter((title) => firstPageTitles.includes(title))).toEqual([]);
    expect(new Set([...firstPageTitles, ...secondPageTitles]).size).toBe(TERMED_POST_COUNT);

    // Back to page one through the control's own anchor, which addresses the first page by the BARE
    // path: `hrefForPage` omits `page` when it equals one, so `?page=1` would be a second URL for
    // byte-identical content and the canonical link would disagree with the sitemap.
    await nav.getByRole('link', { name: 'Page 1', exact: true }).click();
    await expect(page).toHaveURL(
      (url) => !url.searchParams.has('page') && url.searchParams.get('q') === fixture.feedTerm,
    );
    await expect(feedCards(page)).toHaveCount(FEED_PAGE_SIZE);
    expect(await cardTitles(page)).toEqual(firstPageTitles);
  });

  test('renders an empty result state for a page past the end rather than an error', async ({
    page,
  }) => {
    const fixture = feed();
    // `visit` asserts the 200: an out-of-range page is a legitimate request, not a 404 and not a 422.
    await visit(page, feedPath({ q: fixture.feedTerm, sort: 'recent', page: OUT_OF_RANGE_PAGE }));

    await expect(page.getByRole('heading', { level: 1, name: FEED_HEADING })).toBeVisible();
    await expect(feedCards(page)).toHaveCount(0);
    await expect(resultRange(page)).toHaveCount(0);

    // The empty state's title is a real heading - `post-list.tsx` renders it through `AlertTitle
    // as="h2"` - which is how it is addressed by role and text. The alert wrapper itself carries no
    // role, by design: an empty result set is not a live-region event.
    await expect(
      page.getByRole('heading', {
        level: 2,
        name: `Nothing on page ${String(OUT_OF_RANGE_PAGE)}`,
      }),
    ).toBeVisible();

    // Not an error boundary, and the page control is still there to get back with.
    await expect(page.getByRole('heading', { name: ERROR_BOUNDARY_HEADING })).toHaveCount(0);
    await expect(paginationNav(page)).toBeVisible();
  });

  test('preserves the search term and the category filter across pagination and history', async ({
    page,
  }) => {
    const fixture = feed();
    await visit(page, feedPath({ q: fixture.feedTerm, sort: 'recent' }));
    await expect(resultRange(page)).toHaveText(
      resultRangeText(1, FEED_PAGE_SIZE, TERMED_POST_COUNT),
    );

    await page.getByRole('combobox', { name: CATEGORY_FILTER_LABEL }).click();
    await page.getByRole('option', { name: fixture.primaryCategory.name }).click();
    await expect(resultRange(page)).toHaveText(
      resultRangeText(1, FEED_PAGE_SIZE, PRIMARY_POST_COUNT),
    );

    // Every page affordance carries the reader's term, filter and ordering forward. Turning the
    // page must never quietly discard what they were looking at.
    const hrefs = await paginationHrefs(page);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      const parsed = new URL(href, HREF_PARSE_BASE);
      expect(parsed.searchParams.get('q'), `${href} must carry the search term`).toBe(
        fixture.feedTerm,
      );
      expect(parsed.searchParams.get('category'), `${href} must carry the category`).toBe(
        fixture.primaryCategory.slug,
      );
      expect(parsed.searchParams.get('sort'), `${href} must carry the ordering`).toBe('recent');
    }

    await paginationNav(page).getByRole('link', { name: 'Page 2', exact: true }).click();
    await expect(feedCards(page)).toHaveCount(PRIMARY_POST_COUNT - FEED_PAGE_SIZE);
    await expect(resultRange(page)).toHaveText(
      resultRangeText(PRIMARY_POST_COUNT, PRIMARY_POST_COUNT, PRIMARY_POST_COUNT),
    );

    // Back through the history: the filtered first page, then the unfiltered one. Correct at each
    // step is the entire reason the query state lives in the URL instead of in component state.
    await page.goBack();
    await expect(resultRange(page)).toHaveText(
      resultRangeText(1, FEED_PAGE_SIZE, PRIMARY_POST_COUNT),
    );
    await page.goBack();
    await expect(resultRange(page)).toHaveText(
      resultRangeText(1, FEED_PAGE_SIZE, TERMED_POST_COUNT),
    );

    await page.goForward();
    await expect(page).toHaveURL(
      (url) => url.searchParams.get('category') === fixture.primaryCategory.slug,
    );
    await expect(resultRange(page)).toHaveText(
      resultRangeText(1, FEED_PAGE_SIZE, PRIMARY_POST_COUNT),
    );
  });

  test('renders a fully parameterised feed URL opened cold in a fresh context', async ({
    browser,
    baseURL,
    viewport,
  }) => {
    const fixture = feed();
    // A context of its own, with no history, no cache and nothing this run has already clicked:
    // the proof that a shared or crawled URL is self-sufficient.
    const context = await browser.newContext({ viewport });
    try {
      const cold = await context.newPage();
      const target = absoluteUrl(
        baseURL,
        feedPath({
          q: fixture.feedTerm,
          category: fixture.primaryCategory.slug,
          page: 2,
          sort: 'recent',
        }),
      );
      const response = await cold.goto(target);
      expect(response, `GET ${target} must produce a response`).not.toBeNull();
      expect(response?.status(), `GET ${target} must answer 200`).toBe(200);

      // Thirteen posts in that category carry that term, so the second page holds exactly the
      // oldest one - and, with `sort=recent`, exactly which one that is is fixed by the fixture.
      await expect(feedCards(cold)).toHaveCount(PRIMARY_POST_COUNT - FEED_PAGE_SIZE);
      expect(await cardTitles(cold)).toEqual([fixture.oldestPrimaryPost.title]);
      await expect(resultRange(cold)).toHaveText(
        resultRangeText(PRIMARY_POST_COUNT, PRIMARY_POST_COUNT, PRIMARY_POST_COUNT),
      );
    } finally {
      // `finally` without `catch`: the context is released either way and no failure is hidden.
      await context.close();
    }
  });
});

/* =================================================================================================
 * 2. RESPONSIVE BEHAVIOUR - AAP §0.9.4.5 "Responsiveness"
 *
 * Every test in this group BRANCHES on the viewport width and asserts the expectation that width
 * calls for. None of them skips, and that is the point: three projects run this file, so a skip
 * would silently reduce three green combinations to one while still reporting green. Both sides of
 * every branch below carry real assertions.
 *
 * Not one of them looks at a class name either. The column count is read from the resolved grid
 * tracks and cross-checked against where the cards actually landed; the navigation contract is
 * read from visibility; the overflow contract is read from `scrollWidth` against `clientWidth`.
 * ============================================================================================== */

test.describe('responsive behaviour', () => {
  test('lays the feed out in as many columns as the viewport width calls for', async ({
    page,
    viewport,
  }) => {
    const fixture = feed();
    const width = requireWidth(viewport);
    await visit(page, feedPath({ q: fixture.feedTerm, sort: 'recent' }));
    await expect(feedCards(page)).toHaveCount(FEED_PAGE_SIZE);

    const expectedColumns = expectedFeedColumns(width);
    expect(
      await feedGridTrackCount(page),
      `at ${String(width)}px the feed grid must resolve to ${String(expectedColumns)} column track(s)`,
    ).toBe(expectedColumns);
    expect(
      await firstRowCardCount(page),
      `at ${String(width)}px the first row must hold ${String(expectedColumns)} card(s)`,
    ).toBe(expectedColumns);
  });

  test('collapses the primary navigation into the drawer only below the medium breakpoint', async ({
    page,
    viewport,
  }) => {
    const width = requireWidth(viewport);
    await visit(page, '/');

    const inlineHome = page
      .getByRole('navigation', { name: PRIMARY_NAV_LABEL })
      .getByRole('link', { name: HOME_NAV_LINK, exact: true });
    const drawerTrigger = page.getByRole('button', { name: DRAWER_TRIGGER_LABEL });
    const bannerSearch = page.getByRole('search', { name: SITE_SEARCH_LABEL });

    if (width < MD_BREAKPOINT_PX) {
      await expect(drawerTrigger, `at ${String(width)}px the drawer must be offered`).toBeVisible();
      await expect(
        inlineHome,
        `at ${String(width)}px the inline navigation must be collapsed`,
      ).toBeHidden();
    } else {
      await expect(
        inlineHome,
        `at ${String(width)}px the inline navigation must be on screen`,
      ).toBeVisible();
      await expect(
        drawerTrigger,
        `at ${String(width)}px the drawer must be withdrawn`,
      ).toBeHidden();
    }

    // The banner's own search field is the third step of the same contract: it arrives at `lg`, so
    // the desktop project has two searchboxes on screen and the other two projects have one.
    if (width >= LG_BREAKPOINT_PX) {
      await expect(
        bannerSearch,
        `at ${String(width)}px the banner must offer its own search field`,
      ).toBeVisible();
    } else {
      await expect(
        bannerSearch,
        `at ${String(width)}px the banner search field must be withheld`,
      ).toBeHidden();
    }
  });

  test('never overflows horizontally, on the feed or on a post', async ({ page, viewport }) => {
    const fixture = feed();
    const width = requireWidth(viewport);

    await visit(page, feedPath({ q: fixture.feedTerm, sort: 'recent' }));
    await expect(feedCards(page)).toHaveCount(FEED_PAGE_SIZE);
    await expectNoHorizontalOverflow(page, `the home feed at ${String(width)}px`);

    await visit(page, postPath(fixture.flagship.slug));
    await expect(
      page.getByRole('heading', { level: 1, name: fixture.flagship.title }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page, `the post detail page at ${String(width)}px`);
  });

  test('traps focus in the navigation drawer where it is offered, and withdraws it where it is not', async ({
    page,
    viewport,
  }) => {
    const width = requireWidth(viewport);
    await visit(page, '/');

    if (width < MD_BREAKPOINT_PX) {
      const trigger = page.getByRole('button', { name: DRAWER_TRIGGER_LABEL });
      await trigger.click();

      // Radix wires `aria-labelledby` from the panel's `DialogTitle`, so the dialog HAS an
      // accessible name - which is what this locator resolving at all proves.
      const drawer = page.getByRole('dialog', { name: DRAWER_DIALOG_TITLE });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole('navigation', { name: DRAWER_NAV_LABEL })).toBeVisible();
      await expect(drawer.getByRole('link', { name: HOME_NAV_LINK, exact: true })).toBeVisible();

      // Focus containment. Eight presses walk past the panel's last stop on purpose: a scope that
      // is merely "focused first" would release focus to the page behind the overlay here, and a
      // trapped one loops back into the panel.
      for (let press = 1; press <= DRAWER_TAB_PRESSES; press += 1) {
        await page.keyboard.press('Tab');
        await expect
          .poll(async () => activeElementIsInsideDialog(page), {
            message: `focus escaped the drawer after ${String(press)} Tab press(es)`,
          })
          .toBe(true);
      }

      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      // Focus returns to what opened it, so a keyboard reader is not dropped at the top of the page.
      await expect(trigger).toBeFocused();
    } else {
      // At and above `md` the drawer is not merely invisible, it is out of the accessibility tree -
      // so there is no second, hidden copy of the navigation for a screen reader to find. The
      // keyboard floor is then owed by the inline navigation instead, and it is asserted here.
      await expect(page.getByRole('button', { name: DRAWER_TRIGGER_LABEL })).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);

      const inlineHome = page
        .getByRole('navigation', { name: PRIMARY_NAV_LABEL })
        .getByRole('link', { name: HOME_NAV_LINK, exact: true });
      await focusByTabbing(page, inlineHome, 'the inline navigation link');
      await expectVisibleFocusRing(inlineHome, 'the inline navigation link');
    }
  });

  test('keeps the feed controls keyboard reachable with a visible focus indicator', async ({
    page,
  }) => {
    const fixture = feed();
    await visit(page, feedPath({ q: fixture.feedTerm, sort: 'recent' }));
    await expect(feedCards(page)).toHaveCount(FEED_PAGE_SIZE);

    // Tabbed to in document order, so each call continues from where the previous one stopped and
    // the three controls are proven reachable along the real tab path a reader would take.
    const search = page.getByRole('searchbox', { name: FEED_SEARCH_LABEL });
    await focusByTabbing(page, search, "the feed's search field");
    await expectVisibleFocusRing(search, "the feed's search field");

    const filter = page.getByRole('combobox', { name: CATEGORY_FILTER_LABEL });
    await focusByTabbing(page, filter, 'the category filter');
    await expectVisibleFocusRing(filter, 'the category filter');

    const secondPage = paginationNav(page).getByRole('link', { name: 'Page 2', exact: true });
    await focusByTabbing(page, secondPage, 'the second-page link');
    await expectVisibleFocusRing(secondPage, 'the second-page link');
  });
});

/* =================================================================================================
 * 3. SERVER-RENDERED CONTENT - AAP §0.9.4.5 "Server-rendered content"
 *
 * The single most consequential SEO decision in the plan: `src/app/page.tsx` and
 * `src/app/blog/[slug]/page.tsx` carry no `'use client'`, they fetch during render, and the
 * article therefore reaches the crawler in the initial HTML. A page that moved either fetch to the
 * browser would look identical to a human and be empty to a crawler, which is exactly the
 * regression a JavaScript-disabled context catches and nothing else does.
 *
 * WHAT WAS MEASURED, AND WHY THESE ASSERTIONS ARE SHAPED THE WAY THEY ARE. The criterion is that
 * the initial HTML CONTAINS the article text with client scripting disabled, and it does - but not
 * as a naive `toBeVisible()` would have it. `src/app/loading.tsx` declares a Suspense boundary for
 * the root segment, so the framework flushes that skeleton inside `<main>` first and appends the
 * finished markup later in the SAME response, inside a `<div hidden>` an inline script swaps into
 * place. Measured against the production output: one 88KB document, `<main>` opening with
 * `<!--$?--><template id="B:1">` and the skeleton, the article's `<h1>` at byte 77,744 inside
 * `<div hidden id="S:2">`, and the body sentence present twice - once in the flight payload and
 * once as rendered prose. So the bytes carry the article, which is what a crawler parses and what
 * the criterion asks for; the swap is what makes it visible, and that needs the script.
 *
 * These tests therefore assert what is true and what matters: the content is IN THE DOCUMENT the
 * server sent, addressed by role and name with hidden content included, and separately present in
 * the raw response body. Both are impossible to satisfy if the fetch ever moves to the browser -
 * a client-rendered feed in a scripting-disabled context produces an empty document, not a hidden
 * one - which is the regression this group exists to prevent. Asserting visibility instead would
 * assert the framework's streaming strategy rather than the product's rendering decision.
 * ============================================================================================== */

test.describe('server-rendered content', () => {
  test('serves the article body with client scripting disabled', async ({
    browser,
    baseURL,
    viewport,
    request,
  }) => {
    const fixture = feed();
    const context = await browser.newContext({ javaScriptEnabled: false, viewport });
    try {
      const crawler = await context.newPage();
      const target = absoluteUrl(baseURL, postPath(fixture.flagship.slug));
      const response = await crawler.goto(target);
      expect(response?.status(), `GET ${target} must answer 200`).toBe(200);

      // The heading and the prose are both in the document this browser received, and this browser
      // ran no script at all - so the server composed them.
      await expect(
        crawler.getByRole('heading', {
          level: 1,
          name: fixture.flagship.title,
          includeHidden: true,
        }),
      ).toHaveCount(1);
      expect(
        await crawler.content(),
        'the article body must be in the document a scripting-disabled browser received',
      ).toContain(fixture.flagshipSentence);
    } finally {
      await context.close();
    }

    // The most direct expression of "present in the initial HTML": no browser, no rendering, just
    // the bytes the server sent.
    const raw = await request.get(postPath(fixture.flagship.slug));
    expect(raw.status()).toBe(200);
    const body = await raw.text();
    expect(body, 'the response body must carry the article title').toContain(
      fixture.flagship.title,
    );
    expect(body, 'the response body must carry the article prose').toContain(
      fixture.flagshipSentence,
    );
  });

  test('serves the feed cards and real page anchors with client scripting disabled', async ({
    browser,
    baseURL,
    viewport,
  }) => {
    const fixture = feed();
    const context = await browser.newContext({ javaScriptEnabled: false, viewport });
    try {
      const crawler = await context.newPage();
      const target = absoluteUrl(baseURL, feedPath({ q: fixture.feedTerm, sort: 'recent' }));
      const response = await crawler.goto(target);
      expect(response?.status(), `GET ${target} must answer 200`).toBe(200);

      const hidden = { includeHidden: true };
      await expect(feedCards(crawler, hidden)).toHaveCount(FEED_PAGE_SIZE);
      await expect(resultRange(crawler, hidden)).toHaveText(
        resultRangeText(1, FEED_PAGE_SIZE, TERMED_POST_COUNT),
      );
      // Every title on the page is one this worker published, so the server narrowed the feed by
      // the search term before it rendered - the filtering is not happening in the browser.
      for (const title of await cardTitles(crawler, hidden)) {
        expect(title, 'a card the server rendered must belong to the searched term').toContain(
          fixture.feedTerm,
        );
      }

      // Real anchors with real destinations, which is what makes pagination crawlable: a
      // click-handler-only control would leave nothing here to follow.
      const hrefs = await paginationHrefs(crawler, hidden);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        expect(href, 'every page affordance must be an anchor with a destination').not.toBe('');
      }
      expect(await paginationPageNumbers(crawler, hidden)).toContain(TERMED_PAGE_COUNT);
    } finally {
      await context.close();
    }
  });
});

/* =================================================================================================
 * 4. CANONICAL AND SOCIAL METADATA - AAP §0.9.4.5 "Canonical and social metadata"
 *
 * `lib/seo.ts` is the single owner of every value asserted here, and the site name is OBSERVED
 * rather than restated: the root metadata's default title is the site name, so reading the home
 * page's title is how this file learns it without copying a configuration value into a test.
 * ============================================================================================== */

test.describe('canonical and social metadata', () => {
  test('publishes canonical, OpenGraph and Twitter metadata for a post', async ({
    page,
    baseURL,
  }) => {
    const fixture = feed();
    const base = requireBaseURL(baseURL);

    await visit(page, '/');
    const siteName = (await page.title()).trim();
    expect(siteName.length, 'the site must publish a name to brand its cards with').toBeGreaterThan(
      0,
    );

    await visit(page, postPath(fixture.flagship.slug));

    const canonical = await attributeOf(page, 'link[rel="canonical"]', 'href');
    // Absolute, on the canonical origin, and built from the post's own slug: a crawler that
    // reaches this page by any other address is told which one to index.
    expect(canonical).toBe(`${base}${postPath(fixture.flagship.slug)}`);
    expect(canonical.startsWith('http'), 'a canonical URL must be absolute').toBe(true);
    // Trailing-slash normalised - `lib/seo.ts` owns that - so the same article cannot be indexed
    // twice under two spellings of one address.
    expect(canonical.endsWith('/'), 'a canonical URL must not carry a trailing slash').toBe(false);

    expect(await openGraph(page, 'og:type')).toBe('article');
    expect(await openGraph(page, 'og:title')).toBe(fixture.flagship.title);
    expect(await openGraph(page, 'og:description')).toBe(fixture.flagshipExcerpt);
    expect(await openGraph(page, 'og:url')).toBe(canonical);
    expect(await openGraph(page, 'og:site_name')).toBe(siteName);
    // The publication instant travels with the card, so a share renders as an article rather than
    // as an undated page.
    const publishedTime = await openGraph(page, 'article:published_time');
    expect(
      Number.isNaN(Date.parse(publishedTime)),
      `${publishedTime} must be a parseable instant`,
    ).toBe(false);

    expect(await twitterCard(page, 'twitter:card')).toBe(TWITTER_CARD);
    expect(await twitterCard(page, 'twitter:title')).toBe(fixture.flagship.title);
    expect(await twitterCard(page, 'twitter:description')).toBe(fixture.flagshipExcerpt);
  });

  test('composes a post title with the site name through the root title template', async ({
    page,
  }) => {
    const fixture = feed();

    await visit(page, '/');
    const siteName = (await page.title()).trim();

    await visit(page, postPath(fixture.flagship.slug));
    expect(await page.title()).toBe(`${fixture.flagship.title}${TITLE_SEPARATOR}${siteName}`);
  });

  test('publishes canonical and social metadata for an author profile', async ({
    page,
    baseURL,
  }) => {
    const fixture = feed();
    const base = requireBaseURL(baseURL);

    await visit(page, profilePath(fixture.authorUsername));
    await expect(
      page.getByRole('heading', { level: 1, name: fixture.authorDisplayName }),
    ).toBeVisible();

    const canonical = await attributeOf(page, 'link[rel="canonical"]', 'href');
    expect(canonical).toBe(`${base}${profilePath(fixture.authorUsername)}`);
    expect(canonical.endsWith('/'), 'a canonical URL must not carry a trailing slash').toBe(false);

    expect(await openGraph(page, 'og:type')).toBe('profile');
    // `profile:username`, NOT `og:username`. The `profile` object type has its own OpenGraph
    // namespace and the framework emits the handle under it - measured against the rendered head
    // rather than assumed, and the framework's spelling is the one a consumer reads.
    expect(await openGraph(page, 'profile:username')).toBe(fixture.authorUsername);
    expect(await openGraph(page, 'og:title')).toBe(fixture.authorDisplayName);
    expect(await openGraph(page, 'og:url')).toBe(canonical);
    expect(await twitterCard(page, 'twitter:card')).toBe(TWITTER_CARD);
    expect(await twitterCard(page, 'twitter:title')).toBe(fixture.authorDisplayName);
  });

  test('marks the credential routes noindex while leaving their links followable', async ({
    page,
  }) => {
    for (const route of CREDENTIAL_PATHS) {
      await visit(page, route);
      const policy = await attributeOf(page, 'meta[name="robots"]', 'content');
      expect(policy, `${route} must not be indexed`).toContain('noindex');
      // `follow` rather than `nofollow`: the page is not worth indexing, but the links out of it are
      // worth following. This is the same decision the sitemap makes by omitting these two routes.
      expect(policy, `${route} must still be followable`).toContain('follow');
      expect(policy, `${route} must not forbid following`).not.toContain('nofollow');
    }
  });
});

/* =================================================================================================
 * 5. STRUCTURED DATA - AAP §0.9.4.5 "Structured data"
 *
 * `components/seo/json-ld.tsx` renders exactly one graph per page and OMITS any property whose
 * source field is absent rather than emitting `null`. That omission is asserted directly, and it is
 * not a stylistic preference: `published_at` is legitimately null on a draft and `excerpt`,
 * `cover_image_url`, `avatar_url` and `bio` are all nullable, so a graph that emitted `null` would
 * be publishing an invalid value rather than a missing one.
 * ============================================================================================== */

test.describe('structured data', () => {
  test('publishes a BlogPosting graph for a post', async ({ page, baseURL }) => {
    const fixture = feed();
    const base = requireBaseURL(baseURL);
    await visit(page, postPath(fixture.flagship.slug));

    const graph = await readJsonLdGraph(page);
    const canonical = `${base}${postPath(fixture.flagship.slug)}`;

    expect(graph['@context']).toBe(SCHEMA_ORG_CONTEXT);
    expect(graph['@type']).toBe('BlogPosting');
    expect(graph.headline).toBe(fixture.flagship.title);
    expect(graph.description).toBe(fixture.flagshipExcerpt);
    expect(graph.url).toBe(canonical);

    const publishedAt = graph.datePublished;
    expect(typeof publishedAt, 'a published article must carry a publication instant').toBe(
      'string',
    );
    expect(Number.isNaN(Date.parse(String(publishedAt)))).toBe(false);

    const mainEntity = asRecord(graph.mainEntityOfPage, 'mainEntityOfPage');
    expect(mainEntity['@type']).toBe('WebPage');
    expect(mainEntity['@id']).toBe(canonical);

    const author = asRecord(graph.author, 'the author reference');
    expect(author['@type']).toBe('Person');
    expect(author.name).toBe(fixture.authorDisplayName);
    expect(author.url).toBe(`${base}${profilePath(fixture.authorUsername)}`);

    // No cover image was set, so the graph falls back to the site's default social card - resolved
    // to an absolute URL, because a relative one is meaningless to a consumer.
    expect(graph.image).toBe(`${base}/og-default.png`);

    expectNoNullProperties(graph, 'the BlogPosting graph');
  });

  test('publishes a Person graph for an author profile, omitting what the account has not set', async ({
    page,
    baseURL,
  }) => {
    const fixture = feed();
    const base = requireBaseURL(baseURL);
    await visit(page, profilePath(fixture.authorUsername));

    const graph = await readJsonLdGraph(page);
    expect(graph['@context']).toBe(SCHEMA_ORG_CONTEXT);
    expect(graph['@type']).toBe('Person');
    expect(graph.name).toBe(fixture.authorDisplayName);
    expect(graph.url).toBe(`${base}${profilePath(fixture.authorUsername)}`);

    // The throwaway author registered with no biography and no avatar - registration offers no
    // field for either - so those two properties must be ABSENT, not present and null. This is the
    // omission contract observed on the one page where the nullable fields are provably null.
    expect(Object.hasOwn(graph, 'description'), 'an unset biography must be omitted').toBe(false);
    expect(Object.hasOwn(graph, 'image'), 'an unset avatar must be omitted').toBe(false);

    expectNoNullProperties(graph, 'the Person graph');
  });
});

/* =================================================================================================
 * 6. DISCOVERY ARTIFACTS - AAP §0.9.4.5 "Discovery artifacts"
 *
 * Asserted through the `request` fixture, so these are real status codes and real bodies rather
 * than a rendered approximation of them.
 *
 * One caching fact governs what can honestly be asserted about the sitemap: `src/app/sitemap.ts`
 * exports `revalidate = 3600` and reads the API through cached fetches, so `next build` prerenders
 * the document and `next start` serves that copy. A post published during this run is therefore
 * NOT expected in it. The "lists published posts" criterion is proven against the oldest published
 * post instead, which necessarily predates the build - Playwright brings the API up, migrated and
 * seeded, and waits on `/readyz` before it starts the frontend build - while the exclusion
 * criterion is proven against this worker's draft, which is correct under either regime.
 * ============================================================================================== */

test.describe('discovery artifacts', () => {
  test('publishes a sitemap listing published posts, category feeds and author profiles', async ({
    request,
    baseURL,
  }) => {
    const fixture = feed();
    const base = requireBaseURL(baseURL);

    const response = await request.get('/sitemap.xml');
    expect(response.status()).toBe(200);
    const locations = sitemapLocations(await response.text());
    expect(locations.length, 'the sitemap must advertise at least the home feed').toBeGreaterThan(
      0,
    );

    for (const location of locations) {
      expect(
        location.startsWith(`${base}/`),
        `${location} must be an absolute URL on the canonical origin`,
      ).toBe(true);
    }
    const paths = locations.map((location) => location.slice(base.length));

    expect(paths, 'the sitemap must advertise the home feed').toContain('/');
    expect(paths, 'the sitemap must advertise published posts').toContain(
      postPath(fixture.preExistingPublishedSlug),
    );
    // Category pages ARE the feed's query form. There is no separate category route in this
    // product, and advertising one would advertise a 404.
    expect(
      paths.some((path) => path.startsWith('/?category=')),
      'the sitemap must advertise category feeds in their query form',
    ).toBe(true);
    expect(
      paths.some((path) => path.startsWith('/categories')),
      'the sitemap must not advertise a category route that does not exist',
    ).toBe(false);
    expect(
      paths.some((path) => path.startsWith('/u/')),
      'the sitemap must advertise author profiles',
    ).toBe(true);
  });

  test('excludes the protected, credential and unpublished routes from the sitemap', async ({
    request,
    baseURL,
  }) => {
    const fixture = feed();
    const base = requireBaseURL(baseURL);

    const response = await request.get('/sitemap.xml');
    expect(response.status()).toBe(200);
    const body = await response.text();
    const paths = sitemapLocations(body).map((location) => location.slice(base.length));

    for (const prefix of [...CRAWL_DISALLOWED_PATHS, ...CREDENTIAL_PATHS]) {
      expect(
        paths.filter((path) => path === prefix || path.startsWith(`${prefix}/`)),
        `the sitemap must not advertise the ${prefix} family`,
      ).toEqual([]);
    }

    // A post that was never published is not a URL. Its slug must not appear anywhere in the
    // document, in any form.
    expect(paths, 'an unpublished post must not be advertised').not.toContain(
      postPath(fixture.draftPost.slug),
    );
    expect(body, "an unpublished post's slug must not appear in the sitemap at all").not.toContain(
      fixture.draftPost.slug,
    );
  });

  test('publishes a robots policy that disallows the private families and points at the sitemap', async ({
    request,
    baseURL,
  }) => {
    const base = requireBaseURL(baseURL);

    const response = await request.get('/robots.txt');
    expect(response.status()).toBe(200);
    const directives = robotsDirectives(await response.text());

    expect(directives.userAgents, 'the policy must address every crawler').toContain('*');
    expect(directives.allow, 'the public site must be crawlable').toContain('/');
    expect([...directives.disallow].sort()).toEqual([...CRAWL_DISALLOWED_PATHS].sort());
    expect(directives.sitemap, 'the policy must point at the sitemap').toContain(
      `${base}/sitemap.xml`,
    );

    // THE DISTINCTION THAT MATTERS. The authoring family is `/posts` and the reading family is
    // `/blog`; disallowing the first must not touch the second, or every published article on the
    // site would become uncrawlable while every other assertion here still passed.
    for (const disallowed of directives.disallow) {
      expect(
        '/blog'.startsWith(disallowed),
        `Disallow: ${disallowed} would make the public /blog family uncrawlable`,
      ).toBe(false);
      expect(
        postPath('a-published-article').startsWith(disallowed),
        `Disallow: ${disallowed} would make a published article uncrawlable`,
      ).toBe(false);
    }
  });

  test('agrees, path for path, between the robots disallow set and the sitemap', async ({
    request,
    baseURL,
  }) => {
    const base = requireBaseURL(baseURL);

    // Both artifacts read the same frozen array in `lib/seo.ts`, so they cannot disagree unless one
    // of them stops reading it - which is precisely the regression this cross-check exists to
    // catch, and which neither artifact's own test would notice.
    const [robotsResponse, sitemapResponse] = await Promise.all([
      request.get('/robots.txt'),
      request.get('/sitemap.xml'),
    ]);
    expect(robotsResponse.status()).toBe(200);
    expect(sitemapResponse.status()).toBe(200);

    const disallowed = robotsDirectives(await robotsResponse.text()).disallow;
    const paths = sitemapLocations(await sitemapResponse.text()).map((location) =>
      location.slice(base.length),
    );
    expect(
      disallowed.length,
      'the policy must disallow something to be worth cross-checking',
    ).toBeGreaterThan(0);
    expect(
      paths.length,
      'the sitemap must advertise something to be worth cross-checking',
    ).toBeGreaterThan(0);

    for (const path of paths) {
      for (const prefix of disallowed) {
        expect(
          path.startsWith(prefix),
          `the sitemap advertises ${path}, which robots.txt disallows through ${prefix}`,
        ).toBe(false);
      }
    }
  });
});

/* =================================================================================================
 * 7. SEMANTIC STRUCTURE - AAP §0.9.4.5 "Semantic structure"
 *
 * One `h1` per page, the three landmarks, and link text that says where it goes. All three are
 * read by role, which is the same thing a screen reader and a crawler read.
 * ============================================================================================== */

test.describe('semantic structure', () => {
  test('renders exactly one level-one heading on every public route', async ({ page }) => {
    const fixture = feed();
    const routes = [
      feedPath({ q: fixture.feedTerm, sort: 'recent' }),
      postPath(fixture.flagship.slug),
      profilePath(fixture.authorUsername),
    ];

    for (const route of routes) {
      await visit(page, route);
      await expect(
        page.getByRole('heading', { level: 1 }),
        `${route} must have exactly one level-one heading`,
      ).toHaveCount(1);
    }
  });

  test('renders the banner, main and contentinfo landmarks', async ({ page }) => {
    const fixture = feed();

    await visit(page, '/');
    await expect(page.getByRole('banner'), 'the shell must expose one banner').toHaveCount(1);
    await expect(page.getByRole('main'), 'the shell must expose one main region').toHaveCount(1);
    await expect(
      page.getByRole('contentinfo'),
      'the shell must expose one contentinfo',
    ).toHaveCount(1);

    // The main region travels with the shell, so every route a reader can land on has one.
    for (const route of [postPath(fixture.flagship.slug), profilePath(fixture.authorUsername)]) {
      await visit(page, route);
      await expect(page.getByRole('main'), `${route} must expose one main region`).toHaveCount(1);
    }
  });

  test('gives every card and page link a descriptive accessible name', async ({ page }) => {
    const fixture = feed();
    await visit(page, feedPath({ q: fixture.feedTerm, sort: 'recent' }));

    // Each card is addressable by its own title, which is the strongest form of "descriptive": the
    // accessible name of the link IS the thing it leads to. Settled first, for the reason given in
    // the pagination test: a streamed route has not finished rendering when `load` fires.
    await expect(feedCards(page)).toHaveCount(FEED_PAGE_SIZE);
    const titles = await cardTitles(page);
    expect(titles).toHaveLength(FEED_PAGE_SIZE);
    for (const title of titles) {
      await expect(
        page.getByRole('link', { name: title, exact: true }),
        `${title} must be addressable as a link by its own title`,
      ).toHaveCount(1);
    }

    // And nothing on the feed is labelled with a phrase that says nothing.
    await expect(
      page.getByRole('link', { name: /^\s*(read more|click here|here|more|link|this)\s*$/iu }),
      'no link may be labelled with a phrase that carries no context',
    ).toHaveCount(0);

    // Page affordances name the page they lead to, not just a numeral: the numeral is
    // `aria-hidden` and a screen-reader-only phrase carries the meaning.
    const nav = paginationNav(page);
    await expect(nav.getByRole('link', { name: 'Page 1', exact: true })).toHaveCount(1);
    await expect(
      nav.getByRole('link', { name: `Page ${String(TERMED_PAGE_COUNT)}`, exact: true }),
    ).toHaveCount(1);
    await expect(nav.getByRole('link', { name: 'Next page', exact: true })).toHaveCount(1);
  });
});
