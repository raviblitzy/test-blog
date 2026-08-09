/**
 * Component specification for `src/components/blog/author-byline.tsx`.
 *
 * This is a BEHAVIOUR specification, not a rendering snapshot. Every assertion below targets one of
 * three things - an accessible name, visible text, or an attribute a crawler or an assistive
 * technology reads - and nothing below targets a class name, a computed style or a DOM shape. That
 * division is the whole design of the file, and the reason is structural rather than stylistic: the
 * token layer in `src/app/globals.css` owns every class the byline emits and is free to change any
 * of them, so a test that asserted on one would fail on a palette edit while the product stayed
 * correct. What the byline PROMISES is that the author is named, that the name links to that
 * author's profile, and that the publication instant is machine-readable. Those three promises are
 * what is pinned here.
 *
 * ---------------------------------------------------------------------------
 * GOVERNING STANDARDS
 *
 * `review_rules` reports that NO user-specified rules were provided for this project. The binding
 * constraints are therefore the thirteen enterprise standards the plan self-imposes, and five of
 * them reach this file directly:
 *
 *   * **Accessibility as a floor.** The profile link is located by ROLE and by ACCESSIBLE NAME, and
 *     the name it is located by is the author's own - a descriptive name, never "click here" or a
 *     bare URL. `toHaveAccessibleName` is asserted explicitly as well as used as a query, because
 *     the two are not the same check: a query proves *an* element matches, the matcher proves the
 *     name is EXACTLY that and carries nothing else. That distinction is load-bearing here - the
 *     avatar's fallback renders the author's initials as text inside the same link, and if the
 *     composition were not `aria-hidden` the link would announce as "AL Ada Lovelace", the name
 *     twice, once spelled out as letters. This file is what keeps that regression from shipping.
 *   * **Explicit API contracts.** Every fixture is annotated `UserPublic` and built with no cast,
 *     so `tsc --noEmit` is what proves the shape. That projection carries exactly `id`, `username`,
 *     `display_name`, `bio`, `avatar_url` and `created_at`, and deliberately withholds `email`,
 *     `role` and `is_active`; the annotation makes it impossible to write a fixture carrying one of
 *     the withheld fields, and it fails this gate the day the projection is widened. Field names
 *     are the literal JSON keys the service emits - snake_case - because there is no camelCase
 *     mapping layer anywhere in this tier.
 *   * **Layered separation of concerns.** `@/lib/format` owns every calendar decision and
 *     `@/lib/seo` owns the shape of every public URL. The expectations below are therefore built
 *     from those modules rather than from a hand-written locale string or a hand-written path, and
 *     each is paired with an independent check so the assertion cannot pass vacuously: the href is
 *     compared to the builder's output AND parsed to confirm it is the root-relative `/u/{username}`
 *     route; the `dateTime` attribute is compared to the format module's output AND to the literal
 *     ISO instant the fixture declares.
 *   * **Zero hardcoded presentation values.** No `toHaveClass`, no `className` read, no
 *     class-based selector, no `getComputedStyle`, no snapshot. The `size` prop is proven ACCEPTED
 *     - the name, the link and the date all still render at every step - and never proven to look
 *     different, because how it looks is the token layer's business and asserting it here would be
 *     a second, contradictory source of truth for the same decision.
 *   * **Pinned, reproducible dependencies.** Only declared packages are imported. `describe`, `it`
 *     and `expect` are imported explicitly even though `vitest.config.ts` sets `globals: true`,
 *     because `tsconfig.json` includes this file in the `tsc --noEmit` program and the globals
 *     option buys nothing there - leaning on them passes the runner and fails the type gate with
 *     `TS2593`, and both gates are blocking.
 *
 * ---------------------------------------------------------------------------
 * FOUR ENVIRONMENT FACTS THAT SHAPE THIS FILE, ALL MEASURED RATHER THAN ASSUMED
 *
 *   1. **`next/link` needs no mock.** Measured in this configuration: `<Link>` renders a plain
 *      `<a href="/u/ada">` under jsdom with no App Router context present, so there is no
 *      `vi.mock('next/link')` here. A mock would be worse than unnecessary - it would replace the
 *      one thing worth testing about the link, which is the `href` the real component produces.
 *   2. **jsdom never loads an image, so Radix never reports one loaded.** `@radix-ui/react-avatar`
 *      resolves loading status by constructing `new window.Image()` and reading `complete` and
 *      `naturalWidth`; jsdom fetches no subresources, so the status settles on `loading` and
 *      `Avatar.Image` renders NOTHING while `Avatar.Fallback` stays mounted. Every test that does
 *      not deliberately stub that away therefore renders the initials, and none of them asserts on
 *      the avatar - the two that do assert on it say so in their names and install a stub whose
 *      behaviour is entirely under this file's control, which is what makes them deterministic on a
 *      repeat run rather than merely green once.
 *   3. **No environment stubbing is required, and none is present.** `profilePath` returns the
 *      ROOT-RELATIVE `/u/{username}`, not an absolute canonical URL, so no expectation here can
 *      contain a site origin - and `vitest.config.ts` pins `NEXT_PUBLIC_SITE_URL`,
 *      `NEXT_PUBLIC_SITE_NAME` and `NEXT_PUBLIC_API_BASE_URL` in its `env` block anyway, before any
 *      module evaluates. `vi.stubEnv` would add a second place those values are decided. The one
 *      absolute URL in the file is {@link HREF_PARSE_BASE}, which is a `new URL` PARSING BASE and
 *      never an expectation: it exists only so a relative href can be resolved into a `pathname`,
 *      and no assertion ever reads its origin.
 *   4. **No request may be issued.** The byline performs no HTTP, reads no environment variable and
 *      holds no state, so `tests/msw/handlers.ts` is deliberately NOT imported: that module owns
 *      fixtures and no server lifecycle, and pulling it in would add a dependency this unit cannot
 *      exercise. If a future edit gives the byline a fetch, the correct response is to reject the
 *      edit - the component is rendered by three Server Components and is what puts the author link
 *      into the initial HTML.
 *
 * ---------------------------------------------------------------------------
 * DELIBERATELY ABSENT. Please do not add.
 *
 *   1. A snapshot, a `toHaveClass`, a `className` read, a class-based `querySelector` or a
 *      `getComputedStyle`. See the standards above. The two `querySelector` calls in this file are
 *      TAG-name queries for `<time>` and `<img>`, elements that carry no ARIA role and therefore no
 *      role- or name-based query that could reach them; both are wrapped in named helpers that say
 *      so, and both exist chiefly for the ABSENCE assertions, where there is no text to query for.
 *   2. Any `next/image` expectation - no `/_next/image` URL, no `srcset`, no `loader`. The avatar
 *      renders Radix's own `Image` part precisely so the optimiser is not involved, which is also
 *      why no `images.remotePatterns` entry exists for a fixture host.
 *   3. `.only` or `.skip`. A focused test silently narrows a blocking gate; a skipped one silently
 *      removes a promise from it.
 *   4. `userEvent`, `setupServer`, a jest-dom re-import or a manual `cleanup()`. The byline has no
 *      interactive behaviour of its own to drive, issues no request, and `vitest.setup.ts` already
 *      registers the matchers and unmounts every tree between tests.
 *   5. A coverage threshold. The eighty-percent floor is a BACKEND requirement enforced by
 *      `pytest --cov-fail-under=80`; no frontend coverage percentage is required anywhere, and
 *      `vitest.config.ts` records the same prohibition from its side.
 *   6. Anything named after the retired `/items` surface. The demonstration `Item` resource and its
 *      `{ id, name, price }` shape are superseded by the blog domain and must not reappear, even as
 *      a fixture name.
 *   7. A non-deterministic instant. Every date in this file is a literal ISO string; there is no
 *      `Date.now()` and no bare `new Date()`, because a byline whose expected output depends on the
 *      clock is a test that fails on one day of the year.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthorByline } from '@/components/blog/author-byline';
import { formatDate, formatMachineDate } from '@/lib/format';
import { profilePath } from '@/lib/seo';
import { USER_ROLES, type UserPublic } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 *
 * Declared here rather than imported from `tests/msw/handlers.ts` on purpose. That module's
 * fixtures exist to answer HTTP requests, and this component issues none; a byline test that
 * depended on the request-mocking fixture set would couple a pure presentational unit to the shape
 * of the API mock layer. Every value below is a literal, so the expectations are readable at the
 * point they are asserted.
 * ---------------------------------------------------------------------------------------------- */

/**
 * A UUID-shaped identifier, because identity in this product is generated by PostgreSQL through
 * `gen_random_uuid()` and serialised as its canonical text form - never an integer, and never
 * supplied by a client. It is asserted ABSENT from the rendered output further down: an internal
 * key is not something a byline publishes.
 */
const AUTHOR_ID = '3f1a9c62-2b4d-4a58-9f0e-7c5d8e1b6a40';

/** The public handle, and the very path segment `/u/{username}` is built from. */
const AUTHOR_USERNAME = 'ada';

/** The human-readable name. Two words, so the derived monogram is two letters rather than one. */
const AUTHOR_DISPLAY_NAME = 'Ada Lovelace';

/**
 * The monogram the avatar's fallback renders while no image is displayed: the first grapheme of
 * each of the first two words of {@link AUTHOR_DISPLAY_NAME}, upper-cased.
 *
 * Written out rather than derived, so this file states the expected output instead of restating the
 * component's own algorithm - a derivation here would agree with a broken implementation.
 */
const AUTHOR_INITIALS = 'AL';

/**
 * A bio, present so the fixture exercises the non-null branch of a nullable field - and asserted
 * ABSENT from the output, because the byline attributes a post and the bio belongs to the profile
 * header. Deliberately free of an `@` and of any role literal so the confidentiality assertions
 * below cannot be satisfied by accident.
 */
const AUTHOR_BIO = 'Notes on the analytical engine, written slowly.';

/** The account's creation instant. Never rendered by a byline; a publication date is not this. */
const AUTHOR_CREATED_AT = '2024-01-05T08:00:00.000Z';

/**
 * An avatar URL on a host this tier's policy admits, with an obviously synthetic path.
 *
 * The hostname is not a free choice: `src/lib/utils.ts` declares the remote-image allow-list in
 * SOURCE (not configuration), and `AvatarImage` passes every `src` through it, dropping a URL from
 * any other host. So a fixture that named an invented hostname could not reach the DOM at all, and
 * the assertion about the rendered `src` would be unwritable. Nothing is ever requested: jsdom
 * fetches no subresources, and the one test that renders an `<img>` at all fabricates the load
 * status locally rather than performing any I/O. `9000001` is a fixture account number, mirroring
 * the convention `tests/msw/handlers.ts` already uses.
 */
const ALLOWED_AVATAR_URL = 'https://avatars.githubusercontent.com/u/9000001?v=4';

/**
 * An avatar URL on a host the policy does NOT admit - `.invalid` is the reserved top-level domain
 * that can never resolve, so this names nothing real by construction.
 *
 * This is a legitimate stored value rather than a malformed one: the service accepts any absolute
 * `http(s)` URL for `avatar_url`, so a record can perfectly well name a host this tier will not
 * fetch from. The product decision is to degrade to the initials, and that is what is asserted.
 */
const DENIED_AVATAR_URL = 'https://avatars.example.invalid/u/9000001.png';

/**
 * The publication instant, fixed and already normalised to UTC with milliseconds.
 *
 * Fully normalised on purpose: `formatMachineDate` answers with `Date.prototype.toISOString`, so
 * for this input its output is byte-identical to the literal - which lets the `dateTime` assertion
 * be made twice, once against the format module and once against this constant, and the second of
 * those is an independent check rather than a restatement of the first.
 */
const PUBLISHED_AT = '2025-03-12T09:30:00.000Z';

/**
 * A non-empty string that is not an instant.
 *
 * The interesting case for the byline's guard: it is TRUTHY, so a naive `publishedAt && …` check
 * would emit `<time dateTime="">` - an element with a malformed attribute - with "Invalid Date"
 * nowhere in sight. The component instead guards on the FORMATTED values, and this fixture is what
 * holds it to that.
 */
const UNPARSEABLE_INSTANT = 'not-an-instant';

/**
 * The pathname the profile link must resolve to.
 *
 * A route path, not a site origin: `/u/[username]` is the public profile route, and the byline
 * links to it relatively so the client router keeps the prefetch, the shared layout and the scroll
 * position. An absolute `https://…` href would defeat all three.
 */
const PROFILE_PATHNAME = '/u/ada';

/**
 * A base for `new URL`, and nothing else.
 *
 * `new URL` refuses a relative input without one, and resolving the href is how this file proves
 * the value is a root-relative path rather than merely equal to the builder's output. No assertion
 * reads the origin of the resolved URL, so this constant can never leak into an expectation.
 */
const HREF_PARSE_BASE = 'http://localhost';

/**
 * Every step of the byline's `size` scale.
 *
 * A literal tuple, and its type is checked against the component's own prop by the render calls
 * below - so if a step is ever removed from the variant table, `tsc --noEmit` fails HERE rather
 * than the suite silently exercising two of three scales. These are variant KEYS, part of the
 * component's API; they are not presentation values, and nothing below asserts that any of them
 * changes how the byline looks.
 */
const BYLINE_SIZES = ['sm', 'md', 'lg'] as const;

/** Anything shaped like an email address. Used only to prove the rendered output contains none. */
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/u;

/**
 * The author every test starts from: all six members of the public projection, present and
 * snake_case, with no cast anywhere.
 *
 * `avatar_url` is populated here so the fixture exercises the non-null branch of the field. Under
 * jsdom that still renders the initials fallback rather than an image - see environment fact 2 in
 * the header - and no assertion outside the avatar section depends on which of the two is mounted.
 */
const author: UserPublic = {
  id: AUTHOR_ID,
  username: AUTHOR_USERNAME,
  display_name: AUTHOR_DISPLAY_NAME,
  bio: AUTHOR_BIO,
  avatar_url: ALLOWED_AVATAR_URL,
  created_at: AUTHOR_CREATED_AT,
};

/**
 * An author with no avatar - the ordinary case, not an edge one.
 *
 * `avatar_url` is nullable on the contract and nothing in this product uploads an image, so on a
 * fresh install every account is in this state. It is the shape that must never render an empty
 * circle.
 */
const authorWithoutAvatar: UserPublic = { ...author, avatar_url: null };

/**
 * An author whose stored avatar names a host outside the tier's policy. See
 * {@link DENIED_AVATAR_URL}.
 */
const authorWithDeniedAvatar: UserPublic = { ...author, avatar_url: DENIED_AVATAR_URL };

/**
 * An author whose display name is blank rather than absent.
 *
 * `display_name` is typed NON-NULLABLE on the contract - the column is `TEXT NOT NULL` and
 * registration derives a value from the username when none is supplied - so `null` is not
 * expressible here and this fixture does not attempt it. `string` still admits `'   '` though, and
 * a link whose accessible name is whitespace is announced as its URL or as nothing at all, which
 * is a WCAG failure rather than a cosmetic one. The username is the correct fallback because it is
 * the segment the href is built from, so the visible text and the destination always agree.
 */
const authorWithBlankDisplayName: UserPublic = { ...authorWithoutAvatar, display_name: '   ' };

/* -------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `<time>` element in a rendered byline, or `null` when the component elided it.
 *
 * A TAG-name query, and the only kind of query that can reach this element: `<time>` maps to no ARIA
 * role, so there is no `getByRole` for it, and on the branches that matter most there is no text to
 * reach it by either - the whole point of those cases is that nothing was rendered. The visible date
 * is asserted separately through `getByText`, which is what proves the human-readable half; this
 * helper is for the attribute and for the absences. It reads no class and no style.
 *
 * @param container - The `container` from a `render` call.
 * @returns The single `<time>` element, or `null`.
 */
function queryTimeElement(container: HTMLElement): HTMLTimeElement | null {
  return container.querySelector('time');
}

/**
 * The avatar's `<img>` element, or `null` when the fallback is showing instead.
 *
 * A tag-name query for the same reason as {@link queryTimeElement}, with one addition specific to
 * this element: the byline renders it with `alt=""` because the author's name sits beside it inside
 * the same link, and an image with an empty `alt` has the `presentation` role and NO accessible
 * name - so `getByRole('img')` and `getByAltText` both refuse it by design. That refusal is the
 * accessibility contract working, not an obstacle to route around, and it is asserted directly in
 * the avatar section below.
 *
 * @param container - The `container` from a `render` call.
 * @returns The single avatar image, or `null`.
 */
function queryAvatarImage(container: HTMLElement): HTMLImageElement | null {
  return container.querySelector('img');
}

/**
 * Makes `window.Image` report every image as already loaded, for the duration of one test.
 *
 * Radix decides whether to render `Avatar.Image` or `Avatar.Fallback` by constructing
 * `new window.Image()`, assigning the `src`, and reading `complete` and `naturalWidth`. jsdom
 * fetches nothing, so those settle on `false`/`0` and the real answer under test is always
 * "still loading" - which would leave the `src` and `alt` of a successfully loaded avatar
 * permanently unassertable.
 *
 * Substituting a constructor that answers `complete: true` with a non-zero width moves the decision
 * into this file, where it is deterministic on every run rather than dependent on a network. It
 * fabricates only the LOAD STATUS; the `src` that reaches the DOM is still whatever the component
 * and the tier's remote-host policy produce, which is the value the assertions read. The
 * `afterEach` below restores the real constructor, so the substitution cannot outlive the test that
 * asked for it even if that test fails part-way.
 */
function stubLoadedImages(): void {
  class LoadedImageStub {
    /** Radix reads this first: a completed request. */
    readonly complete = true;

    /** And this second: a non-zero width is what distinguishes "loaded" from "broken". */
    readonly naturalWidth = 1;

    /** Assigned by Radix. Never read back by it, and never read by this file. */
    src = '';

    /** Assigned by Radix from the `referrerPolicy` the avatar primitive defaults. */
    referrerPolicy = '';

    /** Assigned by Radix, `null` when the component sets no `crossOrigin`. */
    crossOrigin: string | null = null;

    /*
     * Radix registers `load` and `error` listeners and removes them on cleanup. Neither ever fires
     * here - the status is already final by the time they are attached - so both are inert. The
     * parameters are omitted rather than declared-and-unused, because the lint gate runs with
     * `--max-warnings=0` and grants no underscore exemption.
     */
    addEventListener(): void {}

    removeEventListener(): void {}
  }

  vi.stubGlobal('Image', LoadedImageStub);
}

/*
 * Restores anything {@link stubLoadedImages} replaced. Idempotent and harmless for the majority of
 * tests, which stub nothing at all. `vitest.setup.ts` already unmounts every rendered tree, so no
 * `cleanup()` belongs here.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------------------------------
 * Specification
 * ---------------------------------------------------------------------------------------------- */

describe('AuthorByline', () => {
  describe('author identity', () => {
    it('renders the display name as visible text', () => {
      render(<AuthorByline author={author} publishedAt={PUBLISHED_AT} />);

      expect(screen.getByText(AUTHOR_DISPLAY_NAME)).toBeVisible();
    });

    it('links to the profile route with a descriptive accessible name', () => {
      render(<AuthorByline author={author} publishedAt={PUBLISHED_AT} />);

      // Located by ROLE and by NAME, which is the assertion: a crawler and a screen reader both
      // reach this link through its accessible name, and that name is the author's own rather than
      // a positional phrase.
      const link = screen.getByRole('link', { name: AUTHOR_DISPLAY_NAME });

      // The name is EXACTLY the display name and carries nothing else - in particular not the
      // initials the avatar's fallback renders as text inside this very link. That composition is
      // `aria-hidden`, and this matcher is what holds it that way.
      expect(link).toHaveAccessibleName(AUTHOR_DISPLAY_NAME);

      // One definition of the path shape, in `@/lib/seo`. Comparing against the builder is what
      // proves the component delegates rather than spelling `/u/…` a second time - and it is also
      // what would catch a switch to the ABSOLUTE canonical builder, whose output is a different
      // string entirely.
      expect(link).toHaveAttribute('href', profilePath(AUTHOR_USERNAME));

      // ...and an independent check of the resolved value, so the assertion above cannot pass
      // vacuously. `HREF_PARSE_BASE` is a parsing base only; nothing here reads its origin.
      const href = link.getAttribute('href') ?? '';

      expect(new URL(href, HREF_PARSE_BASE).pathname).toBe(PROFILE_PATHNAME);

      // Root-relative, which is what keeps client-side navigation, prefetching and scroll
      // restoration working. An absolute URL on a `next/link` is treated as external.
      expect(href.startsWith('/')).toBe(true);
    });

    it('percent-encodes the username segment of the profile href', () => {
      // The service constrains usernames, but the byline does not assume that: it hands the value
      // to `@/lib/seo`, which encodes it. This case is what distinguishes real delegation from a
      // hand-built template literal, because for a plain handle the two produce identical strings
      // and only a value needing an escape tells them apart.
      const authorNeedingEncoding: UserPublic = { ...author, username: 'ada lovelace' };

      render(<AuthorByline author={authorNeedingEncoding} publishedAt={PUBLISHED_AT} />);

      const link = screen.getByRole('link', { name: AUTHOR_DISPLAY_NAME });
      const href = link.getAttribute('href') ?? '';

      expect(href).toBe(profilePath(authorNeedingEncoding.username));
      expect(new URL(href, HREF_PARSE_BASE).pathname).toBe('/u/ada%20lovelace');
    });

    it('falls back to the username when the display name is blank', () => {
      render(<AuthorByline author={authorWithBlankDisplayName} publishedAt={PUBLISHED_AT} />);

      // The visible text, the accessible name and the href all agree on the username, so there is
      // no state in which the link announces as whitespace.
      expect(screen.getByText(AUTHOR_USERNAME)).toBeVisible();

      const link = screen.getByRole('link', { name: AUTHOR_USERNAME });

      expect(link).toHaveAccessibleName(AUTHOR_USERNAME);
      expect(link).toHaveAttribute('href', profilePath(AUTHOR_USERNAME));
    });

    it('refuses to render a link when the username is blank', () => {
      // A blank username cannot occur in the service's schema - the column is NOT NULL UNIQUE and a
      // value is generated for every account - so encountering one means the payload is not the
      // record the caller believed it had. Throwing surfaces that at the route error boundary;
      // swallowing it would render a link to `/u/`, a wrong destination that looks right.
      const authorWithoutUsername: UserPublic = { ...author, username: '  ' };

      expect(() => render(<AuthorByline author={authorWithoutUsername} />)).toThrow(
        /non-blank identifier/u,
      );
    });
  });

  describe('publication date', () => {
    it('carries the machine-readable instant in the time element', () => {
      const { container } = render(<AuthorByline author={author} publishedAt={PUBLISHED_AT} />);

      const time = queryTimeElement(container);

      // Stated before anything is read off it, so a missing element fails here with that as the
      // message rather than further down where the symptom would be a confusing `NaN` comparison.
      expect(time).not.toBeNull();

      // The `dateTime` attribute is how the instant reaches assistive technology unambiguously, and
      // it is the same value the page's `BlogPosting` structured data publishes - both read it from
      // `@/lib/format`, which is what keeps the two from disagreeing.
      expect(time).toHaveAttribute('dateTime', formatMachineDate(PUBLISHED_AT));

      // Asserted a second time against the literal the fixture declares. This is the independent
      // half: it proves the wire value survives the round trip unaltered rather than merely that the
      // component and the format module agree with each other.
      expect(time).toHaveAttribute('dateTime', PUBLISHED_AT);

      // ...and that the attribute really is machine-readable, not just a matching string.
      expect(Date.parse(time?.getAttribute('dateTime') ?? '')).toBe(Date.parse(PUBLISHED_AT));
    });

    it('shows the human-readable date the format module produces for that instant', () => {
      render(<AuthorByline author={author} publishedAt={PUBLISHED_AT} />);

      const humanDate = formatDate(PUBLISHED_AT);

      // Guard first: `@/lib/format` answers with the empty string for an instant it cannot parse, so
      // without this line a formatter regression would make the expectation below trivially true.
      expect(humanDate).not.toBe('');

      // Compared against the formatter rather than against a hand-written locale string. The pinned
      // locale, the fixed field order and the UTC resolution all belong to `@/lib/format`; restating
      // its output here would fork that decision, and this file would then have to be edited every
      // time the calendar layer changed correctly.
      const dateElement = screen.getByText(humanDate);

      expect(dateElement).toBeVisible();

      // The visible text and the machine-readable attribute describe the same instant, on the same
      // element - a `<time>` - which is what makes the pair meaningful rather than two coincidences.
      expect(dateElement.tagName).toBe('TIME');
      expect(dateElement).toHaveAttribute('dateTime', PUBLISHED_AT);
    });

    it('renders no time element when the post has never been published', () => {
      // The DRAFT case, and the ORDINARY path on every authoring surface: `published_at` is `null`
      // until a post is published, which the service's own
      // `CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)` constraint makes exact. A byline
      // in this state renders no date at all - it does not substitute `created_at`, which is a
      // private authoring instant rather than a publication one, and it does not invent a label,
      // because what to say about a draft is the consuming screen's editorial decision.
      const { container } = render(<AuthorByline author={author} publishedAt={null} />);

      expect(queryTimeElement(container)).toBeNull();
      expect(screen.queryByText(formatDate(PUBLISHED_AT))).not.toBeInTheDocument();

      // Attribution survives intact: a draft still names its author and still links to the profile.
      expect(screen.getByRole('link', { name: AUTHOR_DISPLAY_NAME })).toHaveAttribute(
        'href',
        profilePath(AUTHOR_USERNAME),
      );
    });

    it('renders no time element when the publication date is omitted entirely', () => {
      // Asserted separately from the `null` case because the prop is OPTIONAL as well as nullable,
      // and a profile header renders the byline with no date argument at all. `undefined` and `null`
      // must behave identically; only a test that omits the prop can prove they do.
      const { container } = render(<AuthorByline author={author} />);

      expect(queryTimeElement(container)).toBeNull();
      expect(screen.getByRole('link', { name: AUTHOR_DISPLAY_NAME })).toBeVisible();
    });

    it('renders no time element for a value that is not an instant', () => {
      // The case a truthiness check would get wrong. A non-empty unparseable string is truthy, so
      // `{publishedAt && <time dateTime={…}>}` would emit `<time dateTime="">` - an element with a
      // malformed attribute and no visible date. Guarding on the FORMATTED values instead is what
      // makes this render clean, and this test is what keeps that guard from being simplified away.
      const { container } = render(
        <AuthorByline author={author} publishedAt={UNPARSEABLE_INSTANT} />,
      );

      expect(queryTimeElement(container)).toBeNull();
      expect(screen.queryByText(UNPARSEABLE_INSTANT)).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: AUTHOR_DISPLAY_NAME })).toBeVisible();
    });
  });

  describe('avatar', () => {
    it('shows the initials fallback when the author has no avatar', () => {
      const { container } = render(
        <AuthorByline author={authorWithoutAvatar} publishedAt={PUBLISHED_AT} />,
      );

      // Perceivable: the monogram is rendered as text, immediately, with no delay - so an account
      // with no avatar shows a filled circle rather than an empty hole. On a fresh install that is
      // every account, which is why this is the ordinary case and not an edge one.
      expect(screen.getByText(AUTHOR_INITIALS)).toBeVisible();
      expect(queryAvatarImage(container)).toBeNull();

      // And the letters stay out of the accessibility tree. Without this the link would announce
      // as "AL Ada Lovelace" - the name twice, once spelled out - for exactly the authors most
      // likely to be in this state.
      expect(screen.getByRole('link', { name: AUTHOR_DISPLAY_NAME })).toHaveAccessibleName(
        AUTHOR_DISPLAY_NAME,
      );
    });

    it('renders the stored avatar as a decorative image once it reports loaded', async () => {
      stubLoadedImages();

      const { container } = render(<AuthorByline author={author} publishedAt={PUBLISHED_AT} />);

      // Radix flips from fallback to image through React state, so the element is awaited rather
      // than asserted synchronously.
      await waitFor(() => {
        expect(queryAvatarImage(container)).not.toBeNull();
      });

      const image = queryAvatarImage(container);

      // The stored URL reaches the DOM unaltered - no optimiser, no `/_next/image` indirection and
      // no `srcset`, because the avatar renders Radix's own image part rather than `next/image`.
      expect(image).toHaveAttribute('src', ALLOWED_AVATAR_URL);

      // Empty `alt`, deliberately: the author's name is right there inside the same link, so the
      // image is decorative and describing it again would be a duplicate announcement. An image with
      // an empty `alt` also has no accessible name, which is why nothing here queries it by role.
      expect(image).toHaveAttribute('alt', '');
      expect(screen.queryByRole('img')).not.toBeInTheDocument();

      // The fallback has yielded to the image rather than stacking behind it...
      expect(screen.queryByText(AUTHOR_INITIALS)).not.toBeInTheDocument();

      // ...and the link still announces as exactly the author's name.
      expect(screen.getByRole('link', { name: AUTHOR_DISPLAY_NAME })).toHaveAccessibleName(
        AUTHOR_DISPLAY_NAME,
      );
    });

    it('keeps the initials when the stored avatar names a host outside the policy', async () => {
      stubLoadedImages();

      const { container } = render(
        <AuthorByline author={authorWithDeniedAvatar} publishedAt={PUBLISHED_AT} />,
      );

      // The load status is fabricated as "loaded" for every image here, so the previous test's image
      // appeared. This one still does not - which isolates the cause to the tier's remote-host
      // policy dropping the URL before it can reach the DOM, exactly as intended. The reader's
      // browser is never asked to contact a host chosen by whoever authored the record.
      await waitFor(() => {
        expect(screen.getByText(AUTHOR_INITIALS)).toBeVisible();
      });

      expect(queryAvatarImage(container)).toBeNull();
      expect(screen.getByRole('link', { name: AUTHOR_DISPLAY_NAME })).toHaveAttribute(
        'href',
        profilePath(AUTHOR_USERNAME),
      );
    });
  });

  describe('accepted props', () => {
    /*
     * The `size` scale is proven ACCEPTED, never proven to look different.
     *
     * What the prop moves - the avatar diameter, the initials' type size, the row's type size and
     * two gaps - is expressed entirely in tokens the design system owns, and asserting on any of it
     * would put a second source of truth for the palette in the test suite. What matters at this
     * boundary is that no step drops a promise: the name, the link and the date survive all three.
     * The compile-time half is just as load-bearing as the runtime half, because `BYLINE_SIZES` is
     * checked against the component's own prop type by these very render calls.
     */
    for (const size of BYLINE_SIZES) {
      it(`keeps the name, link and date at size "${size}"`, () => {
        const { container } = render(
          <AuthorByline author={author} publishedAt={PUBLISHED_AT} size={size} />,
        );

        expect(screen.getByText(AUTHOR_DISPLAY_NAME)).toBeVisible();
        expect(screen.getByRole('link', { name: AUTHOR_DISPLAY_NAME })).toHaveAttribute(
          'href',
          profilePath(AUTHOR_USERNAME),
        );
        expect(queryTimeElement(container)).toHaveAttribute('dateTime', PUBLISHED_AT);
        expect(screen.getByText(formatDate(PUBLISHED_AT))).toBeVisible();
      });
    }

    it('accepts a className without disturbing the name, link or date', () => {
      // The escape hatch a consuming layout uses for its own spacing. Whether the class arrives is a
      // question about `tailwind-merge`, not about this component, so it is not asked here - what is
      // asked is that supplying one changes none of the three promises.
      const { container } = render(
        <AuthorByline author={author} className="mt-4" publishedAt={PUBLISHED_AT} />,
      );

      expect(screen.getByText(AUTHOR_DISPLAY_NAME)).toBeVisible();
      expect(screen.getByRole('link', { name: AUTHOR_DISPLAY_NAME })).toHaveAttribute(
        'href',
        profilePath(AUTHOR_USERNAME),
      );
      expect(queryTimeElement(container)).toHaveAttribute('dateTime', PUBLISHED_AT);
    });
  });

  describe('confidentiality of the public projection', () => {
    it('publishes no email address, no role and no internal identifier', () => {
      const { container } = render(<AuthorByline author={author} publishedAt={PUBLISHED_AT} />);

      const rendered = container.textContent ?? '';

      // `UserPublic` carries no `email` and no `role`, so today these cannot leak - which is exactly
      // why stating them costs nothing and is worth stating. The value is in the day someone widens
      // the projection or reaches for `UserMe` to "save a request": this test fails then, at the
      // byline, which is the component embedded in the feed, in every comment header and in every
      // administrative table, and therefore the one with the widest blast radius.
      expect(rendered).not.toMatch(EMAIL_PATTERN);

      for (const role of USER_ROLES) {
        expect(rendered).not.toContain(role);
      }

      // Nor the surrogate key: an internal identifier is for React keys and comparisons, not for
      // publication. The username is the public handle, and it is what the href already carries.
      expect(rendered).not.toContain(AUTHOR_ID);

      // The bio is public, but it is not the byline's to render - a profile header owns it. Asserting
      // it absent is what keeps this component to attribution and a date.
      expect(rendered).not.toContain(AUTHOR_BIO);

      // The account's creation instant is not a publication instant, and presenting one as the other
      // would misstate when the post became public. Only `publishedAt` reaches the markup. The
      // guard keeps the absence assertion meaningful: every string contains the empty one, so a
      // formatter answering with its placeholder would otherwise turn the next line into a failure
      // with no explanation attached.
      const formattedAccountCreation = formatDate(AUTHOR_CREATED_AT);

      expect(formattedAccountCreation).not.toBe('');
      expect(rendered).not.toContain(formattedAccountCreation);
    });
  });
});
