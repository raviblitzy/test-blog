/**
 * Component tests for `src/components/blog/post-card.tsx` - the unit the whole feed is made of.
 *
 * The home page, every author profile and every dashboard listing render this one component, so the
 * assertions below are the guard on four surfaces rather than one.
 *
 * ---------------------------------------------------------------------------
 * 1. THE MOST VALUABLE LINE IN THIS FILE IS A TYPE ANNOTATION
 *
 * Every fixture is declared `const … : PostSummary`, imported type-only from `@/lib/types`, with no
 * cast and no `as` anywhere. That annotation is the primary guard this file contributes:
 *
 *   * `PostSummary` deliberately carries NO `content` field, because a feed page returns up to a
 *     hundred of these and shipping the Markdown body would multiply every home-feed, profile and
 *     dashboard response by the size of the articles in it. `@/lib/types` says so at the interface
 *     and asks in as many words that no content field be added.
 *   * Because the fixtures below are annotated rather than cast, a later "just add the body to the
 *     summary" change fails `tsc --noEmit` HERE - `TS2353: Object literal may only specify known
 *     properties` - before it can inflate every feed response in production. Adding `content:` to
 *     any literal in this file is a compile error today, and that is the point of writing them this
 *     way.
 *
 * A cast would silently disable all of that, which is why there is not one in the file.
 *
 * The runtime half of the same guard is
 * `renders none of a detail payload's body when handed one`. `PostDetail extends PostSummary`, so a
 * detail payload is structurally acceptable where a summary is expected - the component's own
 * documentation says such a payload "is accepted unchanged and its extra fields are simply unused".
 * That test hands the card a real `PostDetail` whose `content` is present at runtime and asserts the
 * body never reaches the DOM, which is the assertion the type system cannot make.
 *
 * ---------------------------------------------------------------------------
 * 2. WHAT IS ASSERTED, AND WHAT IS DELIBERATELY NOT
 *
 * ASSERTED - accessible names, roles, visible text and semantic attributes:
 *
 *   * the card is an `<article>`, because one post is an independently distributable item;
 *   * the title is a real heading at the level the caller asked for, and NEVER an `<h1>` - the page
 *     owns its single top-level heading and a card in a list can never be it;
 *   * the title link's accessible name is exactly the post title, so a screen-reader user hearing a
 *     list of links hears titles rather than a row of "Read more";
 *   * every `href` equals what the route builder in `@/lib/seo` yields, never a hand-written string;
 *   * the lifecycle state is carried by a WORD, not by a colour.
 *
 * NOT ASSERTED - and each omission is a rule rather than an oversight:
 *
 *   * No class name. No `toHaveClass`, no `className` read, no class-based `querySelector`, no
 *     `getComputedStyle`, no snapshot. The token layer owns class names and is free to re-map them;
 *     a test that pinned one would fail on a palette edit while the component still worked. The
 *     element selectors that do appear (`img`, `time`) name HTML elements, and the one attribute
 *     selector names `aria-hidden` - all three are semantics, not presentation.
 *   * No grid, column count, width or breakpoint. The card is width-agnostic by design:
 *     `post-list.tsx` owns the one/two/three-column grid, and the 375/768/1440 verification lives in
 *     `tests/e2e/home-feed.spec.ts` where a real browser applies real media queries. jsdom applies
 *     none, so any responsive assertion here would pass without meaning anything.
 *   * No `srcset` and no `/_next/image` URL. Those are the image optimiser's output, not this
 *     component's contract; `alt` is what the accessibility tree reads and `alt` is what is checked.
 *   * No site origin and no `process.env` read. Both route builders return ROOT-RELATIVE paths, so
 *     the expected values come from calling the builders themselves. `vitest.config.ts` already pins
 *     the three `NEXT_PUBLIC_*` values for the whole suite, so there is nothing here to stub.
 *   * No reading time. `reading-time.tsx` is not composed by the card, because a summary has no body
 *     to measure and an estimate derived from an excerpt would be a wrong number rather than a
 *     missing one.
 *
 * ---------------------------------------------------------------------------
 * 3. NO MOCKS, NO REQUEST INTERCEPTION, NO PROVIDERS
 *
 * Measured rather than assumed: `next/image`, `next/link` and the Radix-backed avatar inside
 * `AuthorByline` all render real DOM under jsdom with the four browser stubs `vitest.setup.ts`
 * installs, so nothing here is mocked. A `next/image` stub would have meant a raw `<img>`, which the
 * active `@next/next/no-img-element` rule makes fatal under `--max-warnings=0` - the honest fix was
 * to check first and mock nothing.
 *
 * There is no Mock Service Worker server either. `tests/msw/handlers.ts` owns handlers and fixtures
 * but deliberately no lifecycle, leaving `setupServer`/`listen`/`close` to the specs that need them,
 * and this component needs none: it performs no HTTP at all. The route that renders a list fetches
 * through `@/lib/api/posts.ts` and hands the data down as a prop, so a request from this suite would
 * be a defect rather than a fixture to serve.
 *
 * `@testing-library/jest-dom` is registered globally by `vitest.setup.ts` and `cleanup()` already
 * runs in its `afterEach`, so neither is repeated here. The Vitest API is imported explicitly even
 * though `globals: true` is set, because `tsconfig.json` includes this file in the `tsc --noEmit`
 * program without `vitest/globals` types - leaning on the globals would pass at runtime and fail the
 * type gate.
 *
 * ---------------------------------------------------------------------------
 * 4. THE RETIRED SURFACE IS ABSENT BY CONSTRUCTION
 *
 * Every identifier below is a UUID-shaped string, because identity in this product is generated by
 * the database. There is no client-chosen integer key, no `name`/`price` pair and no `/items` path
 * anywhere in this file - that legacy demonstration shape is retired, and a "post fixture" built
 * from it would quietly resurrect the defect class the restructure removed.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PostCard, PostCardSkeleton } from '@/components/blog/post-card';
import { formatCount, formatDate } from '@/lib/format';
import { categoryFeedPath, postPath } from '@/lib/seo';
import type { CategorySummary, PostDetail, PostSummary, UserPublic } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 *
 * Hand-written here rather than imported from `tests/msw/handlers.ts`, and the reason is the type
 * annotation described in the header: that module's post fixtures are `PostDetail` values, and a
 * `PostDetail` satisfies `PostSummary` structurally - so building on one would forfeit the compile
 * error that catches a `content` field being added to the list projection. These are declared as
 * `PostSummary` precisely so that guard is live in this file.
 *
 * Field names are snake_case because that is what the API emits; there is no camelCase translation
 * layer anywhere in this tier, so a camelCase fixture would describe a payload that never ships.
 * ---------------------------------------------------------------------------------------------- */

/** Every timestamp is a fixed ISO-8601 string - never `new Date()`, which would make a run depend on
 * the day it happened to execute. `formatDate` pins both locale and time zone, so the rendered form
 * of these instants is identical on every machine. */
const INSTANT_ACCOUNT_CREATED = '2023-11-02T08:15:00Z';
const INSTANT_POST_CREATED = '2024-05-01T09:30:00Z';
const INSTANT_POST_PUBLISHED = '2024-05-10T12:00:00Z';
const INSTANT_POST_UPDATED = '2024-05-12T16:45:00Z';

/**
 * The author, as the public projection embedded in every post.
 *
 * `avatar_url` is `null` on purpose. The avatar is a Radix `Avatar`, whose image part resolves its
 * load state asynchronously; with no URL the initials fallback renders synchronously instead, so
 * every assertion in this file is deterministic on the first tick and no test needs `waitFor`. The
 * whole avatar composition is `aria-hidden` either way, so nothing observable is given up.
 */
const author: UserPublic = {
  id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
  username: 'alice',
  display_name: 'Alice Rivera',
  bio: 'Backend engineer. Writes about databases, latency and the unglamorous parts of shipping.',
  avatar_url: null,
  created_at: INSTANT_ACCOUNT_CREATED,
};

/** Two taxonomy terms, bound to names rather than read back out of an array: `noUncheckedIndexedAccess`
 * is on, so indexing a fixture array would yield `CategorySummary | undefined` and force a guard that
 * says nothing about the component. */
const engineeringCategory: CategorySummary = {
  id: '1b4e28ba-2fa1-11d2-883f-0016d3cca427',
  name: 'Engineering',
  slug: 'engineering',
};

const designCategory: CategorySummary = {
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  name: 'Design Systems',
  slug: 'design-systems',
};

/**
 * The ordinary case: a published post with a cover, an excerpt and one category.
 *
 * `cover_image_url` names `images.unsplash.com`, which is a host on the allow-list `@/lib/utils`
 * declares and `next.config.ts` derives its `remotePatterns` from. That matters: the card asks that
 * predicate before rendering an image, so a fixture pointing at an unlisted host would render no
 * image and an `alt` assertion would silently be testing nothing.
 *
 * `view_count` is deliberately large. The card must render no readership figure at all, and a value
 * whose compact form is distinctive makes that a real assertion rather than a vacuous one.
 */
const publishedPost: PostSummary = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  title: 'Scaling FastAPI in production',
  slug: 'scaling-fastapi-in-production',
  excerpt: 'Connection pools, worker counts, and the two settings that actually move latency.',
  cover_image_url: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa',
  status: 'PUBLISHED',
  published_at: INSTANT_POST_PUBLISHED,
  view_count: 12_400,
  created_at: INSTANT_POST_CREATED,
  author,
  categories: [engineeringCategory],
};

/**
 * A draft: `status: 'DRAFT'` with `published_at: null`.
 *
 * The legitimate pairing rather than an invented one - PostgreSQL enforces
 * `CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)`, so a published post always has an
 * instant and an unpublished one may have none. This is the shape the author dashboard renders.
 */
const draftPost: PostSummary = {
  ...publishedPost,
  id: 'b7f8c1d2-3e4a-4b5c-8d9e-0a1b2c3d4e5f',
  title: 'Sharding by tenant, and when not to',
  slug: 'sharding-by-tenant',
  status: 'DRAFT',
  published_at: null,
};

/** An archived post, so the lifecycle pill is exercised on both states the card actually labels. */
const archivedPost: PostSummary = {
  ...publishedPost,
  id: 'c8a9b0c1-4f5e-4a6b-9c7d-1e2f3a4b5c6d',
  title: 'The old deployment runbook',
  slug: 'the-old-deployment-runbook',
  status: 'ARCHIVED',
};

/**
 * The sparse case: no cover, no excerpt, no categories.
 *
 * Every one of those is a legitimate, expected state rather than an error - the author wrote no
 * summary, uploaded no cover and filed the post under nothing - and each must degrade to an omitted
 * affordance rather than to an empty box, a broken image or a blank footer band.
 */
const sparsePost: PostSummary = {
  ...publishedPost,
  id: 'd9b0c1d2-5a6f-4b7c-8d9e-2f3a4b5c6d7e',
  title: 'A short note on indexes',
  slug: 'a-short-note-on-indexes',
  excerpt: null,
  cover_image_url: null,
  categories: [],
};

/** A post filed under two categories, so the chip row is proved to render every term rather than the
 * first one. */
const multiCategoryPost: PostSummary = {
  ...publishedPost,
  id: 'e0c1d2e3-6b7a-4c8d-9e0f-3a4b5c6d7e8f',
  title: 'Designing with semantic tokens',
  slug: 'designing-with-semantic-tokens',
  categories: [engineeringCategory, designCategory],
};

/**
 * A cover URL whose host is NOT on the allow-list.
 *
 * The service accepts any absolute `https` URL for a cover, so a stored record can legitimately name
 * a host this tier will not fetch from. The card must then render no image element and no reserved
 * frame, degrading to a text-only card rather than to a card with a hole in it.
 */
const unlistedCoverHostPost: PostSummary = {
  ...publishedPost,
  id: 'f1d2e3f4-7c8b-4d9e-8f01-4b5c6d7e8f90',
  cover_image_url: 'https://tracker.invalid/pixel.png',
};

/**
 * A sentence that appears in NO field of any summary fixture above.
 *
 * It is the body of {@link detailPayload}, and the "no body content" tests assert its absence. Kept
 * as a named constant so the two halves of that assertion - what is supplied and what is checked -
 * cannot drift apart.
 */
const BODY_ONLY_SENTENCE =
  'A worker count tuned against a pool size that cannot serve it buys queueing.';

/**
 * A full detail payload, `content` and all.
 *
 * `PostDetail extends PostSummary`, so this is accepted by `PostCard` unchanged - which is exactly
 * what happens when a caller already holds a detail response and reuses the card to render it. The
 * card must ignore the two extra fields completely.
 */
const detailPayload: PostDetail = {
  ...publishedPost,
  content: `## Pools before workers\n\n${BODY_ONLY_SENTENCE}\n`,
  updated_at: INSTANT_POST_UPDATED,
};

/* -------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Characters the byline contributes that no summary field accounts for.
 *
 * The avatar fallback renders the author's initials as text and a dot separates the name from the
 * date. Both are `aria-hidden`, so neither reaches the accessibility tree, but both are present in
 * `textContent` - and the text-budget assertion below counts `textContent`. Eight characters is
 * ample for two initials plus a separator while remaining an order of magnitude below the shortest
 * body a leak could introduce, which is what keeps the budget a real bound rather than a formality.
 */
const BYLINE_DECORATION_BUDGET = 8;

/**
 * The largest amount of text a card may legitimately render for a given summary.
 *
 * Derived from the fields `PostSummary` actually carries - title, excerpt, author display name, the
 * rendered publication date and the category names - plus {@link BYLINE_DECORATION_BUDGET}. The date
 * comes from `@/lib/format`'s own formatter rather than from a hand-written string, so the budget
 * follows the formatter instead of having to be re-tuned whenever it changes.
 *
 * A rendered card that exceeds this is rendering something the list projection does not carry, which
 * is precisely the regression this file exists to catch.
 */
function summaryTextBudget(post: PostSummary): number {
  const categoryNames = post.categories.reduce(
    (total, category) => total + category.name.length,
    0,
  );

  return (
    post.title.length +
    (post.excerpt?.length ?? 0) +
    post.author.display_name.length +
    formatDate(post.published_at).length +
    categoryNames +
    BYLINE_DECORATION_BUDGET
  );
}

/**
 * A parsing base for a root-relative `href`, and nothing more.
 *
 * `URL` refuses a relative input without one. This is never asserted against and is never treated as
 * the site's origin - the canonical origin belongs to `@/lib/seo`, which both route builders used
 * here already own end to end.
 */
const HREF_PARSE_BASE = 'http://parse.invalid';

/* -------------------------------------------------------------------------------------------------
 * PostCard
 * ---------------------------------------------------------------------------------------------- */

describe('PostCard', () => {
  describe('semantic structure', () => {
    it('renders the post as an article containing its title', () => {
      render(<PostCard post={publishedPost} />);

      // `article` is the role the element carries natively, and it is the right one: a post card is
      // a self-contained, independently distributable item. The card is deliberately NOT wrapped in
      // an anchor - it holds three separate links, and nesting them inside a fourth would be
      // invalid HTML and would hand a screen reader one unusable accessible name.
      const article = screen.getByRole('article');

      expect(article).toBeInTheDocument();
      expect(article).toContainElement(screen.getByRole('heading', { name: publishedPost.title }));
    });

    it('renders exactly one card per post', () => {
      render(<PostCard post={publishedPost} />);

      expect(screen.getAllByRole('article')).toHaveLength(1);
    });
  });

  describe('heading level', () => {
    it('renders the title at level 2 by default', () => {
      render(<PostCard post={publishedPost} />);

      // The default the source declares, read rather than guessed: the surfaces that render a feed -
      // home page, author profile, dashboard - all spend their `h1` on the page heading, so a card
      // beneath one is the second level.
      expect(screen.getByRole('heading', { level: 2, name: publishedPost.title })).toBeVisible();
    });

    it('renders the title at level 3 when asked', () => {
      render(<PostCard headingLevel={3} post={publishedPost} />);

      expect(screen.getByRole('heading', { level: 3, name: publishedPost.title })).toBeVisible();
      expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    });

    it('renders the title at level 4 when asked', () => {
      render(<PostCard headingLevel={4} post={publishedPost} />);

      expect(screen.getByRole('heading', { level: 4, name: publishedPost.title })).toBeVisible();
    });

    it('never renders a level 1 heading, at any level it accepts', () => {
      // The page owns its single top-level heading. A card in a list can never be it, so this holds
      // for the default and for every level the prop admits - the type excludes `1` outright, and
      // this is the runtime half of that guarantee.
      const byDefault = render(<PostCard post={publishedPost} />);
      expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
      byDefault.unmount();

      const atThree = render(<PostCard headingLevel={3} post={draftPost} />);
      expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
      atThree.unmount();

      render(<PostCard headingLevel={4} post={sparsePost} />);
      expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    });
  });

  describe('links', () => {
    it('names the title link by the post title and points it at the built post path', () => {
      render(<PostCard post={publishedPost} />);

      // The accessible name is the title itself, not "Read more": a screen-reader user scanning a
      // list of links has to hear which post each one leads to.
      const titleLink = screen.getByRole('link', { name: publishedPost.title });

      // Compared against the builder's own output. Hand-writing `/blog/${slug}` here would let this
      // test keep passing after a prefix change that broke every real link on the site.
      expect(titleLink).toHaveAttribute('href', postPath(publishedPost.slug));
    });

    it('renders the title link as a crawlable root-relative anchor', () => {
      render(<PostCard post={publishedPost} />);

      const href = screen.getByRole('link', { name: publishedPost.title }).getAttribute('href');

      // THE RAW STRING FIRST, because that is the only thing that can prove "root-relative". Parsing
      // against a base cannot: `new URL('https://evil.example/blog/x', base)` yields the same pathname
      // as `/blog/x` while being an absolute, cross-origin destination - so a base-URL parse alone
      // would have accepted the exact value this assertion exists to refuse. Root-relative is what
      // `next/link` needs to keep client routing, prefetch and scroll restoration; an absolute URL is
      // treated as an external destination and loses all three.
      expect(href).not.toBeNull();
      expect(href?.startsWith('/')).toBe(true);
      // And not protocol-relative, which also begins with a slash and is also cross-origin.
      expect(href?.startsWith('//')).toBe(false);
      expect(href).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);

      // Then the parse, for the parts a string comparison reads badly: the path is exactly the post's,
      // and no query string or fragment has been appended to it.
      const parsed = new URL(href ?? '', HREF_PARSE_BASE);
      expect(parsed.origin).toBe(HREF_PARSE_BASE);
      expect(parsed.pathname).toBe(`/blog/${publishedPost.slug}`);
      expect(parsed.search).toBe('');
      expect(parsed.hash).toBe('');
    });

    it('composes the author byline rather than reimplementing it', () => {
      render(<PostCard post={publishedPost} />);

      // Proof of composition: the display name and the profile link both come from `AuthorByline`.
      // Its accessible name is the display name alone - the avatar beside it renders the author's
      // initials as text but the whole avatar is `aria-hidden`, so those initials are correctly kept
      // out of the accessibility tree and out of this name.
      const profileLink = screen.getByRole('link', { name: author.display_name });

      expect(profileLink).toHaveAttribute('href', `/u/${author.username}`);
      expect(screen.getByRole('article')).toContainElement(profileLink);
    });

    it('renders no link other than the title, the byline and the category chips', () => {
      render(<PostCard post={publishedPost} />);

      // There is deliberately no second link to the post - no "Read more", and the cover image is
      // not an anchor either - because a duplicate destination is announced twice per card.
      expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toStrictEqual([
        postPath(publishedPost.slug),
        `/u/${author.username}`,
        categoryFeedPath(engineeringCategory),
      ]);
    });
  });

  describe('summary text', () => {
    it('renders the excerpt', () => {
      render(<PostCard post={publishedPost} />);

      expect(screen.getByText(publishedPost.excerpt ?? '')).toBeVisible();
    });

    it('omits the excerpt slot when the author wrote none', () => {
      const withExcerpt = render(<PostCard post={publishedPost} />);
      const paragraphsWithExcerpt = withExcerpt.container.querySelectorAll('p').length;
      withExcerpt.unmount();

      render(<PostCard post={sparsePost} />);

      // STRUCTURAL, not a text-absence proxy. Checking that another post's excerpt string is missing
      // proves almost nothing - it was never in this card - and it would pass just as happily against
      // a card rendering an empty `<p>`, which is the actual defect: an empty paragraph carries the
      // excerpt slot's line-height and padding, so the card would close with a band of blank space and
      // look broken rather than compact. Counting the paragraphs is what distinguishes "no slot" from
      // "an empty slot".
      const paragraphsWithoutExcerpt = screen.getByRole('article').querySelectorAll('p').length;
      expect(paragraphsWithoutExcerpt).toBe(paragraphsWithExcerpt - 1);

      // The fixture's premise, so the count above cannot be satisfied by a card that renders no
      // paragraph in either case.
      expect(sparsePost.excerpt).toBeNull();
      expect(publishedPost.excerpt).not.toBeNull();
      expect(paragraphsWithExcerpt).toBeGreaterThan(0);

      // Still a complete card: the title and the byline are there, the excerpt simply is not.
      expect(screen.getByRole('heading', { name: sparsePost.title })).toBeVisible();
      expect(screen.getByRole('link', { name: sparsePost.author.display_name })).toBeVisible();
    });

    it('omits the excerpt slot for an excerpt that is only whitespace', () => {
      // A blankness guard rather than a null guard, which `post-card.tsx` records: `excerpt` is typed
      // `string | null` and `string` still admits `'   '`. The service stores what it is given, so a
      // whitespace excerpt is a value this card can genuinely receive - and it must produce no slot,
      // for the same reason a null one must not.
      render(<PostCard post={{ ...publishedPost, excerpt: '   \n  ' }} />);

      const paragraphs = screen.getByRole('article').querySelectorAll('p');
      for (const paragraph of paragraphs) {
        expect(paragraph.textContent?.trim()).not.toBe('');
      }
      expect(screen.getByRole('heading', { name: publishedPost.title })).toBeVisible();
    });

    it('renders the publication date for a published post and none for a draft', () => {
      const published = render(<PostCard post={publishedPost} />);

      // A machine-readable `<time dateTime>` is what a crawler and an assistive technology read; the
      // element belongs to the byline, and its presence here proves the card passed `published_at`
      // through rather than substituting the authoring instant.
      const time = published.container.querySelector('time');
      expect(time).not.toBeNull();
      expect(time?.textContent).toBe(formatDate(publishedPost.published_at));

      published.unmount();

      // A draft has never been published, so there is no instant to state and no element to emit.
      const draft = render(<PostCard post={draftPost} />);
      expect(draft.container.querySelector('time')).toBeNull();
    });
  });

  /* ---------------------------------------------------------------------------------------------
   * The signature group: the list projection carries no body, and the card renders none.
   *
   * `PostSummary` omitting `content` is a deliberate payload-size decision that pays for the entire
   * feed. The compile-time guard is every fixture above being annotated `PostSummary` with no cast,
   * so adding `content:` to one is a type error. These are the runtime half.
   * ------------------------------------------------------------------------------------------- */
  describe('body content', () => {
    it('renders none of the body carried by a detail payload', () => {
      // The non-vacuous form of this assertion. `detailPayload` genuinely carries `content` at
      // runtime - it is a real `PostDetail`, which the card accepts unchanged - so the body is
      // available to be rendered and is not rendered. A card that ever reached for `post.content`
      // would fail here even though it would still compile against `PostDetail`.
      render(<PostCard post={detailPayload} />);

      const article = screen.getByRole('article');

      expect(article.textContent).not.toContain(BODY_ONLY_SENTENCE);
      expect(article.textContent).not.toContain('Pools before workers');
      expect(screen.queryByText(BODY_ONLY_SENTENCE)).toBeNull();

      // The excerpt IS rendered, which is what makes the absence above meaningful: the card renders
      // the summary's own prose and stops there, rather than rendering no prose at all.
      expect(screen.getByText(detailPayload.excerpt ?? '')).toBeVisible();
    });

    it('renders no more text than the summary projection can account for', () => {
      render(<PostCard post={detailPayload} />);

      const article = screen.getByRole('article');
      const rendered = article.textContent ?? '';

      // A bound, not an exact match: every character the card renders is accounted for by a field
      // `PostSummary` carries, plus the byline's two hidden decorations. The body supplied above is
      // an order of magnitude larger than the slack, so a leak cannot hide inside it.
      expect(rendered.length).toBeLessThanOrEqual(summaryTextBudget(detailPayload));

      // And the fields that ARE carried all appear, so the bound was not met by rendering nothing.
      expect(rendered).toContain(detailPayload.title);
      expect(rendered).toContain(detailPayload.excerpt ?? 'unreachable');
      expect(rendered).toContain(author.display_name);
      expect(rendered).toContain(engineeringCategory.name);
    });

    it('presents no readership figure, in either its raw or its compact form', () => {
      render(<PostCard post={publishedPost} />);

      const rendered = screen.getByRole('article').textContent ?? '';

      // Deliberate, and documented at both the render site and on the field itself: no endpoint in
      // this product increments `view_count`, so the only values it can hold are the column default
      // and whatever the seeder wrote. Printing either beside a title would state an audience figure
      // no read produced, and a reader cannot tell an unmeasured number from a measured one.
      //
      // Both spellings are checked, and the compact one is obtained by CALLING `@/lib/format` rather
      // than by hand-writing the string it currently produces. That keeps this test correct if the
      // compact threshold, the locale or the rounding ever changes - what the formatter emits is
      // `format.ts`'s own business and is asserted in its own unit tests, not pinned here.
      const compact = formatCount(publishedPost.view_count);

      // Non-vacuity guard: the fixture's count is large enough that the formatter really did
      // abbreviate it, so the absence assertion below is checking the compact form and not merely a
      // run of digits that happens to be missing.
      expect(compact).not.toBe(String(publishedPost.view_count));

      expect(rendered).not.toContain(compact);
      expect(rendered).not.toContain(String(publishedPost.view_count));
    });
  });

  describe('categories', () => {
    it('renders every category as a link to its filtered feed', () => {
      render(<PostCard post={multiCategoryPost} />);

      // A category has no route of its own in this product - its page IS the category-filtered feed -
      // so each chip is a crawlable link built by the same `@/lib/seo` builder the filter control and
      // the sitemap use.
      for (const category of [engineeringCategory, designCategory]) {
        const chip = screen.getByRole('link', { name: category.name });

        expect(chip).toBeVisible();
        expect(chip).toHaveAttribute('href', categoryFeedPath(category));
      }
    });

    it('carries the category slug as the feed category parameter', () => {
      render(<PostCard post={publishedPost} />);

      const href = screen
        .getByRole('link', { name: engineeringCategory.name })
        .getAttribute('href');

      // Parsed rather than compared as a string, so this asserts the CONTRACT - the feed filters on
      // the slug, not on the display name or the identifier - independently of parameter order or of
      // which defaults the canonicaliser omits.
      expect(href).not.toBeNull();
      const parsed = new URL(href ?? '', HREF_PARSE_BASE);
      expect(parsed.pathname).toBe('/');
      expect(parsed.searchParams.get('category')).toBe(engineeringCategory.slug);
      expect(parsed.searchParams.get('page')).toBeNull();
      expect(parsed.searchParams.get('sort')).toBeNull();
    });

    it('renders no chip row for an uncategorised post', () => {
      render(<PostCard post={sparsePost} />);

      // The footer is omitted entirely rather than rendered as a blank band, so the only links left
      // are the title and the byline.
      expect(screen.getAllByRole('link')).toHaveLength(2);
      expect(screen.queryByRole('link', { name: engineeringCategory.name })).toBeNull();
    });
  });

  describe('lifecycle state', () => {
    it('labels a draft with a word rather than a colour', () => {
      render(<PostCard post={draftPost} />);

      // The pill's meaning has to survive a visitor who cannot distinguish its tone, so the
      // assertion is on visible TEXT. Nothing here inspects the variant, the class or the colour -
      // the tone is the design system's decision and is free to change.
      expect(screen.getByText('Draft')).toBeVisible();
    });

    it('labels an archived post with a word rather than a colour', () => {
      render(<PostCard post={archivedPost} />);

      expect(screen.getByText('Archived')).toBeVisible();
    });

    it('labels a published post with no pill at all', () => {
      render(<PostCard post={publishedPost} />);

      // Every post in a public listing is published, so a "Published" pill would be noise on every
      // card while distinguishing none of them. Gated on the value rather than on a `showStatus`
      // prop, so a feed cannot switch it on by mistake and a dashboard cannot forget to.
      expect(screen.queryByText('Published')).toBeNull();
      expect(screen.queryByText('Draft')).toBeNull();
      expect(screen.queryByText('Archived')).toBeNull();
    });
  });

  describe('cover image', () => {
    it('renders the cover as decorative, contributing no accessible name', () => {
      const { container } = render(<PostCard post={publishedPost} />);

      // `alt=""` is deliberate, not an omission: the title sits immediately below inside the same
      // card, as the heading and as the link's accessible name, so a non-empty `alt` would make a
      // screen reader announce the same words twice per card. An empty `alt` removes the image from
      // the accessibility tree, which is why there is no `img` role to find.
      expect(screen.queryByRole('img')).toBeNull();
      expect(screen.queryByRole('img', { name: publishedPost.title })).toBeNull();

      const cover = container.querySelectorAll('img');
      expect(cover).toHaveLength(1);
      expect(cover.item(0).getAttribute('alt')).toBe('');
    });

    it('renders no image element for a post with no cover', () => {
      const { container } = render(<PostCard post={sparsePost} />);

      // No broken image and no reserved empty frame - the card degrades to a text-only card.
      expect(container.querySelectorAll('img')).toHaveLength(0);
      expect(screen.getByRole('article')).toBeVisible();
      expect(screen.getByRole('heading', { name: sparsePost.title })).toBeVisible();
    });

    it('renders no image element when the stored host is not on the allow-list', () => {
      const { container } = render(<PostCard post={unlistedCoverHostPost} />);

      // The service accepts any absolute https URL, so this is a payload the product can really
      // store. The card asks the shared host policy first and omits the affordance rather than
      // handing the optimiser a host it will refuse, so the card still renders in full.
      expect(container.querySelectorAll('img')).toHaveLength(0);
      expect(screen.getByRole('heading', { name: unlistedCoverHostPost.title })).toBeVisible();
      expect(screen.getByRole('link', { name: unlistedCoverHostPost.title })).toBeInTheDocument();
    });
  });

  describe('priority', () => {
    it('defers the cover by default', () => {
      const { container } = render(<PostCard post={publishedPost} />);
      const covers = container.querySelectorAll('img');

      // The default is the correct one for every card but the first: a card below the fold must not
      // contend for bandwidth with one above it.
      expect(covers).toHaveLength(1);
      expect(covers.item(0).getAttribute('loading')).toBe('lazy');
    });

    it('accepts priority and stops deferring the cover', () => {
      const { container } = render(<PostCard post={publishedPost} priority />);
      const covers = container.querySelectorAll('img');

      // Opted into for the first card of the first page only, where the cover is the page's Largest
      // Contentful Paint candidate. The observable consequence in jsdom is that the image is no
      // longer lazily deferred - the fetch-priority hint itself is the browser's business, and no
      // generated `srcset` or optimiser URL is asserted here.
      expect(covers).toHaveLength(1);
      expect(covers.item(0).getAttribute('loading')).not.toBe('lazy');
      expect(screen.getByRole('article')).toBeVisible();
      expect(screen.getByRole('heading', { name: publishedPost.title })).toBeVisible();
    });
  });

  describe('invalid identifiers', () => {
    it('refuses to publish a wrong destination when the slug is blank', () => {
      // The route builder refuses a blank segment instead of yielding `/blog/`, which would be a
      // wrong link that looks right - and a canonical URL is the worst possible place to discover
      // that. The service generates every slug and constrains it UNIQUE, so a blank one means the
      // payload was not the record the caller believed it had, and the route error boundary is the
      // correct place for it. The expected React error log is silenced so the gate's output stays
      // readable.
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        expect(() => render(<PostCard post={{ ...publishedPost, slug: '   ' }} />)).toThrow(
          /non-blank/,
        );

        // WHAT WAS SILENCED IS ASSERTED, inside the same `try` so the spy is still installed. A bare
        // `mockImplementation(() => undefined)` is a blanket suppression: it would equally swallow a
        // React warning about a key, an invalid prop or a hydration mismatch arising from this render,
        // and the gate would stay green while hiding a second, unrelated defect. Every message that
        // WAS logged therefore has to be one this render explains.
        //
        // MEASURED on the pinned stack (react-dom 19.2.8, @testing-library/react 16.3.2): the count is
        // ZERO. The throw propagates straight out of `render` and React logs nothing, so the spy
        // currently silences nothing at all - it is a guard against a React that reports differently
        // rather than a suppression of output seen today. The assertion is written as a constraint on
        // whatever is logged rather than as an expected count, so it stays correct either way: an empty
        // set passes, React's own report of this throw passes, and an unrelated warning fails.
        for (const call of consoleError.mock.calls) {
          const message = call.map((argument) => String(argument)).join(' ');
          expect(message).toMatch(/non-blank|PostCard/);
        }
      } finally {
        // Restored in `finally`, so a failed assertion above cannot leave `console.error` stubbed for
        // every case that follows in this file - which would silence real warnings suite-wide and turn
        // one failure into an unexplained set of passes.
        consoleError.mockRestore();
      }
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * PostCardSkeleton
 * ---------------------------------------------------------------------------------------------- */

describe('PostCardSkeleton', () => {
  it('renders standalone, with no post to render', () => {
    // Geometry is its entire contract, so it takes no `post` and no shape props at all: a caller
    // must not be able to produce a placeholder that does not match the card it stands in for.
    const { container } = render(<PostCardSkeleton />);

    expect(container.firstElementChild).not.toBeNull();
  });

  it('is hidden from assistive technology and announces nothing itself', () => {
    const { container } = render(<PostCardSkeleton />);
    const placeholder = container.firstElementChild;

    // `post-list.tsx` renders a run of these, so a live region per placeholder would announce
    // "loading" once per card. The announcement belongs to the wrapper around the run; the
    // placeholder itself is `aria-hidden` and deliberately carries no `role="status"`.
    expect(placeholder?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('renders pulsing placeholder blocks and no text', () => {
    const { container } = render(<PostCardSkeleton />);
    const placeholder = container.firstElementChild;

    // No text at all - a skeleton that spelled out "Loading…" would be read by a screen reader from
    // a subtree that is meant to be silent. The blocks are counted by their `aria-hidden` attribute
    // rather than by a class, because the pulse and the sizing are the token layer's business.
    expect(placeholder?.textContent).toBe('');
    expect(placeholder?.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
  });

  it('reserves the cover frame without rendering an image', () => {
    const { container } = render(<PostCardSkeleton />);

    // The placeholder commits to one geometry - a post with a cover, the common case - so the space
    // is reserved by a block rather than by an image element that has nothing to load.
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });
});
