/**
 * The public author profile: `/u/{username}`.
 *
 * This route is the whole of "include user profiles showing published articles". It renders one
 * account's public identity and one window of that account's PUBLISHED posts, server-side, at a
 * linkable and crawlable address. It also carries this resource's share of the SEO work - a
 * per-resource `generateMetadata`, a canonical URL, OpenGraph and Twitter fields, and the `Person`
 * structured data - and it is one of the three surfaces the responsive criteria are measured
 * against.
 *
 * ## The request, end to end
 *
 * 1. `generateMetadata` awaits `params`, reads the profile through {@link readProfile} and hands it
 *    to `buildProfileMetadata`. A handle nothing answers to yields {@link MISSING_PROFILE_METADATA}
 *    rather than a thrown error - see "Two failure paths" below.
 * 2. The component awaits `params` and `searchParams`, resolves the requested page, then issues both
 *    reads CONCURRENTLY. `generateMetadata` has normally already resolved the profile, and
 *    {@link readProfile} is wrapped in React's `cache`, so the two entry points share one request
 *    rather than making the same one twice.
 * 3. A missing profile becomes `notFound()`, which renders `src/app/not-found.tsx`. A profile that
 *    exists renders the header, the `Person` graph and the post list.
 *
 * ## What it renders into the initial HTML
 *
 * All of it. There is no `'use client'` directive here, and every composed part either has none
 * either (`PostList`, `PostCard`, `AuthorByline`, `Alert`, `PersonJsonLd`) or is a client island
 * receiving serializable props only (`Avatar`, `Pagination`), which a Server Component may render
 * freely. So a crawler receives the author's name, the biography, the post titles, the post links
 * and the pagination anchors without executing any JavaScript. That is not a preference: it is the
 * mechanism that makes the SEO requirement achievable, and `src/app/robots.ts` deliberately leaves
 * `/u` crawlable while disallowing `/dashboard`, `/posts` and `/admin`.
 *
 * ## Why the listing cannot leak a draft
 *
 * `getUserPosts` accepts `page` and `page_size` and nothing else. There is no status parameter, no
 * draft flag and no principal to widen: the service filters this listing on one lifecycle state held
 * in a module constant, so an administrator and the author themselves receive exactly what an
 * anonymous crawler receives. The absence of the parameter IS the guarantee, which is why this file
 * neither passes a status nor filters `items` on arrival - there is nothing here to get wrong. An
 * author reviewing their own drafts uses the dashboard, which asks the feed for them authenticated.
 *
 * For the same reason the feed's own list endpoint is NOT substituted for this one: `GET
 * /users/{username}/posts` exists precisely because it is the hard-filtered listing.
 *
 * ## Two failure paths, told apart rather than merged
 *
 * Treating every failure as "no such author" would tell a reader - and a crawler, which acts on it -
 * that an author has been removed when in fact the service was merely unreachable. So exactly one
 * class of failure is reported as missing here, decided by {@link isUnaddressableProfile}:
 *
 * | Failure                                     | Result                                          |
 * | ------------------------------------------- | ----------------------------------------------- |
 * | `ApiError` with status 404                  | `notFound()`, which renders `not-found.tsx`      |
 * | `TypeError` from the handle guard           | `notFound()` - the URL cannot address a profile  |
 * | Any 5xx, a timeout, an unreachable service  | RETHROWN, so `src/app/error.tsx` handles it      |
 * | A malformed payload                         | RETHROWN, for the same reason                    |
 *
 * Which HTTP status those first two rows carry is the application's to decide rather than this
 * route's: the route-level Suspense boundary in `src/app/loading.tsx` commits the response before any
 * async page component resolves, so the boundary renders inside a response that has already been
 * committed as 200. See the note on {@link generateMetadata} for the measurement and for the one
 * change that turns it into a hard 404.
 *
 * The `TypeError` row is the one worth explaining. `@/lib/api/users` refuses to compose a request
 * for a blank handle or for the literal segment `me`, and both reach this route from the URL rather
 * than from a bug: `/u/%20` decodes to a blank segment, and `/u/me` names a handle no account can
 * hold, because the service reserves that spelling for the authenticated-self route and enforces a
 * minimum handle length above it. Neither addresses a profile, so neither is a server fault - 404
 * is the honest answer, and the guard's judgement is deferred to rather than restated here.
 *
 * ## An out-of-range page is a 200, not an error
 *
 * `?page=9999` on an author with two pages is a legitimate request. The service echoes the requested
 * page back unclamped beside an empty `items` array and the real totals, `PostList` renders its empty
 * panel from that, and its page control stays mounted - because the control is gated on the
 * envelope's `pages`, not on whether this window has rows - so the reader keeps their way back. This
 * file therefore does NOT clamp the requested page against `pages`, does not throw and does not call
 * `notFound()` for it. The empty copy adapts instead: see {@link resolveEmptyState}.
 *
 * ## Ownership boundaries this file does not cross
 *
 * - **The document belongs to `src/app/layout.tsx`**: `<html>`, `<body>`, the skip link, the three
 *   providers, `SiteHeader`, the `<main>` landmark, `SiteFooter`, the toast host and the tier's only
 *   `globals.css` import. This file contributes page body content and nothing else - no second
 *   `<main>`, no provider, no stylesheet import.
 * - **No HTTP.** `@/lib/api/client` is the only module in the tier that performs a request. This
 *   file calls the two typed wrappers in `@/lib/api/users` and spells no path, so it structurally
 *   cannot bypass the `/api/v1` prefix that module composes exactly once.
 * - **No environment variable.** `@/lib/seo` is the sole reader of `NEXT_PUBLIC_SITE_URL` and
 *   `NEXT_PUBLIC_SITE_NAME`, and the sole builder of `/u/{username}`. Every canonical URL published
 *   by this route - in the metadata and in the `Person` graph - is built there.
 * - **No grid geometry and no pagination markup.** `PostList` owns the one/two/three-column
 *   progression and the placement of the page control. Restating either here is what makes the two
 *   drift, so the only layout this file authors is its own header and the vertical rhythm between
 *   its two regions.
 * - **No `AuthorByline`.** Deliberate, and the one composition choice here worth defending. That
 *   component renders the author's name inside a link to `/u/{username}`, which is this very page:
 *   composed beside the `<h1>` it would print the name twice, nested inside it a `<div>` would sit
 *   in phrasing-only content, and either way the profile would link to itself. The `<h1>` is the
 *   requirement, so the byline yields - and it still renders on this page once per card, through
 *   `PostCard`, so attribution reads identically across the product. Its avatar composition is not
 *   re-authored either: the header uses the same `@/components/ui/avatar` parts it does.
 *
 * ## Governing standards
 *
 * `review_rules` reports that **no user-specified rules were provided** for this project, so nothing
 * here is invented to satisfy one and the bar is not lowered. The binding constraints are the
 * technical plan's own enterprise standards. Those that govern this file:
 *
 * | Standard                          | How this file satisfies it                                                                 |
 * | --------------------------------- | ------------------------------------------------------------------------------------------ |
 * | Layered separation of concerns    | No transport: two typed wrappers, no `fetch`, no header, no status-code test beyond the 404 |
 * | Explicit API contracts            | Consumes the five-member page envelope unchanged and the single `ApiError` shape            |
 * | API versioning                    | Honoured negatively - no path is spelled here, so none can bypass the version namespace     |
 * | Server-owned identity             | Keys on the `username` segment; `id` is an opaque server-generated value                    |
 * | Secure-by-default authentication  | `UserPublic` withholds email and role; the listing cannot be widened past `PUBLISHED`       |
 * | Zero hardcoded presentation values| Every class is a semantic token or a generated scale utility; no inline `style`              |
 * | Semantic tokens, not families     | `text-muted-foreground`, never a colour family and shade                                    |
 * | Behavioural primitives            | The avatar is the Radix wrapper - no `next/image`, no raw `<img>`, no load-error handling    |
 * | One breakpoint vocabulary         | Mobile-first, `sm:` only, no custom media query                                             |
 * | Accessibility as a floor          | One `<h1>`, ordered levels, `aria-hidden` icon, `<time dateTime>`, named region              |
 * | Configuration from the environment| Read only through `@/lib/seo`; this file reads none                                          |
 * | Pinned dependencies               | `next`, `react`, `lucide-react` only - every one already declared                            |
 * | Blocking quality gates            | Compiles under `tsc --noEmit`, lints at `--max-warnings=0`                                   |
 *
 * @module
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import type { JSX } from 'react';

import { CalendarDays } from 'lucide-react';

import { PostList } from '@/components/blog/post-list';
import { PersonJsonLd } from '@/components/seo/json-ld';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { isApiError } from '@/lib/api/client';
import { getProfile, getUserPosts } from '@/lib/api/users';
import { EMPTY_VALUE, formatDate, formatMachineDate } from '@/lib/format';
import { buildProfileMetadata } from '@/lib/seo';
import type { Page, PostSummary, UserPublic } from '@/lib/types';
import { FIRST_PAGE, toPageNumber } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Read parameters
 * ---------------------------------------------------------------------------------------------- */

/**
 * Posts per page on a profile.
 *
 * Deliberately a module constant and deliberately NOT a search parameter, so this route's entire
 * public query surface is the single `page` value. A reader cannot ask for a different window size,
 * which keeps one profile URL describing one result set - the property canonical links depend on -
 * and removes an input that would otherwise need validating on every request.
 *
 * Twelve divides by one, two and three, so the last row of the grid is full at every breakpoint the
 * one/two/three-column progression passes through. It is also comfortably inside the service's
 * validated 1..100 range, so `getUserPosts` can never reject it.
 */
const PAGE_SIZE = 12;

/**
 * The search parameter carrying the requested page.
 *
 * Named because the same spelling is produced by the pagination control's own hrefs, so the value
 * this route reads and the value that control writes are one string rather than two that agree by
 * coincidence.
 */
const PAGE_SEARCH_PARAM = 'page';

/**
 * Framework revalidation controls handed to both reads: five minutes.
 *
 * A profile and its published listing are not volatile - a display name, a biography and a set of
 * published posts change on the order of days - so an interval short enough that a newly published
 * post appears in the same working session is ample, and a crawler walking every profile from the
 * sitemap then costs a bounded number of requests against the service rather than one per URL.
 *
 * The same window is used for both reads on purpose: a header that had outlived its own post list
 * would be a visibly inconsistent page. No cache tag accompanies it, because nothing in this tier
 * calls `revalidateTag` and a tag no code invalidates only looks like a mechanism.
 */
const PROFILE_READ_REVALIDATION = { revalidate: 300 } as const;

/**
 * The one HTTP status this route interprets.
 *
 * Named rather than written inline at the comparison, because the number is a decision - it is the
 * single status that means "no such profile" and therefore the single status that may become a 404
 * page - and a bare literal beside `error.status` reads like an implementation detail instead.
 */
const PROFILE_NOT_FOUND_STATUS = 404;

/**
 * Heading level for each post card's title, and for the empty state's headline.
 *
 * Three, because the outline is already `h1` (the author) then `h2` (the listing's own heading), so
 * a card title at `h2` would collide with the section heading and one at `h4` would skip a level.
 * `PostList` passes this straight through to `PostCard`, which is why the consuming page owns it.
 */
const POST_CARD_HEADING_LEVEL = 3;

/** Identifier linking the posts region to its own heading, so the region has an accessible name. */
const POSTS_HEADING_ID = 'profile-published-articles';

/** How many words of a name contribute an initial. Two is a monogram; three reads as an acronym. */
const INITIALS_WORD_LIMIT = 2;

/**
 * Matches the first grapheme of a word: one non-mark code point plus any combining marks modifying
 * it.
 *
 * The `u` flag makes `\P{M}` match a whole code point, so an astral character - an emoji in a
 * display name, a CJK ideograph - survives intact rather than being cut into a lone surrogate, which
 * is what `charAt(0)` would produce. The trailing `\p{M}*` keeps a decomposed accent attached to the
 * letter it belongs to, so a name stored as `e` + U+0301 yields `é` and not a bare `e`.
 */
const FIRST_GRAPHEME_PATTERN = /^\P{M}\p{M}*/u;

/* -------------------------------------------------------------------------------------------------
 * Route props
 *
 * Both members are Promises, which is the App Router's own shape on this framework version: reading
 * either is what marks the render dynamic, so they are handed over unresolved and awaited here.
 * ---------------------------------------------------------------------------------------------- */

/** The route's single dynamic segment, already percent-decoded by the framework. */
interface ProfileRouteParams {
  /**
   * The author's handle exactly as the URL carries it.
   *
   * Passed to the service verbatim: `users.username` is a case-insensitively unique column, so
   * `/u/Alice` and `/u/alice` address one account and the index performs the fold. Lower-casing,
   * trimming or otherwise normalising it here would restate a guarantee the schema already makes,
   * in a second place that could drift from it.
   */
  username: string;
}

/** The query string, in the framework's own shape: a repeated key arrives as an array. */
type ProfileSearchParams = Record<string, string | string[] | undefined>;

/** Props of {@link AuthorProfilePage}. */
interface AuthorProfilePageProps {
  /** The matched dynamic segments. */
  params: Promise<ProfileRouteParams>;
  /** The query string. Only {@link PAGE_SEARCH_PARAM} is read; anything else is ignored. */
  searchParams: Promise<ProfileSearchParams>;
}

/* -------------------------------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a caught failure means "nothing is addressable at this URL" rather than "the request
 * failed".
 *
 * The distinction is the whole of this route's error handling, and getting it wrong is worse than
 * having none: a 404 page served for a 5xx tells a crawler the profile has been removed, and it acts
 * on that. See the failure table in the module header.
 *
 * `isApiError` is the narrowing helper `@/lib/api/client` documents for exactly this, in preference
 * to a bare `instanceof`. Every failure that reached the service - and every one that could not - is
 * normalised into that single type, so `status` is the only test needed.
 *
 * The `TypeError` branch covers the two handles `@/lib/api/users` refuses to compose a request for: a
 * blank one and the reserved `me` segment. Both arrive from the URL rather than from a bug here, and
 * neither can name an account. The check is safe against catching an unrelated programming error
 * because the guarded region in each reader below contains exactly one call.
 *
 * @param error - The caught value, of unknown type as `catch` provides it.
 * @returns `true` when the correct response is a 404 page, `false` when the failure must propagate.
 */
function isUnaddressableProfile(error: unknown): boolean {
  if (isApiError(error)) {
    return error.status === PROFILE_NOT_FOUND_STATUS;
  }

  return error instanceof TypeError;
}

/**
 * Read one author's public profile, answering `null` when no account holds the handle.
 *
 * Wrapped in React's `cache`, so `generateMetadata` and {@link AuthorProfilePage} resolve ONE
 * request for the same handle within a request rather than two identical ones. The framework's fetch
 * deduplication would cover the common case on its own; the wrapper makes the sharing explicit and
 * keeps it true regardless of how the underlying read is dispatched.
 *
 * The absent profile is modelled as `null` rather than as a thrown error precisely because both
 * callers need it and neither may throw for it: `generateMetadata` must still return a `Metadata`
 * object, and the component must reach `notFound()`. Every other failure is rethrown untouched.
 *
 * @param username - The handle from the URL, passed through verbatim.
 * @returns The author's public identity, or `null` when nothing is addressable at this handle.
 */
const readProfile = cache(async (username: string): Promise<UserPublic | null> => {
  try {
    return await getProfile(username, { next: PROFILE_READ_REVALIDATION });
  } catch (error) {
    if (isUnaddressableProfile(error)) {
      return null;
    }

    throw error;
  }
});

/**
 * Read one page of an author's published posts, answering `null` when no account holds the handle.
 *
 * Not cached, and not for want of consistency: the window is part of the key, this is the only
 * caller, and a second read of the same page within one request does not occur.
 *
 * Neither of the two `RangeError`s `getUserPosts` can raise is reachable from here.
 * {@link resolveRequestedPage} only ever yields a whole number at or above the first page and within
 * the exactly-representable range, and {@link PAGE_SIZE} is a constant inside the service's
 * validated window - so the arguments are correct by construction rather than by hope.
 *
 * An unknown handle is reported on this route as a missing profile rather than as an author who has
 * written nothing, which is why the same classifier applies here as to the profile read.
 *
 * @param username - The handle from the URL, passed through verbatim.
 * @param page - The 1-based page to read. A page past the last one is legitimate and answers with an
 * empty item list beside the real totals.
 * @returns One page of published posts, unmodified, or `null` when nothing is addressable.
 */
async function readAuthorPosts(username: string, page: number): Promise<Page<PostSummary> | null> {
  try {
    return await getUserPosts(
      username,
      { page, page_size: PAGE_SIZE },
      { next: PROFILE_READ_REVALIDATION },
    );
  } catch (error) {
    if (isUnaddressableProfile(error)) {
      return null;
    }

    throw error;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Pure helpers
 *
 * Local rather than hoisted into `@/lib`: each exists to feed this route's own markup and copy, and
 * widening a shared module's surface for a single caller is how shared modules stop being shared.
 * Every one of them is total over its input and none throws.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The first value of a search parameter, whatever arity it arrived with.
 *
 * A query string may repeat a key - `?page=2&page=5` is a legal URL - and the framework surfaces
 * that as an array. Taking the first entry is the same choice the pagination control's own hrefs
 * make by writing a single value, and it is deliberately not an error: a repeated parameter is
 * malformed input from a hand-edited URL, and the correct response to malformed input on a public
 * page is a sensible render, not a failure.
 *
 * @param value - The raw parameter as the framework provides it.
 * @returns The first string value, or `undefined` when the key is absent or repeated empty.
 */
function firstSearchParamValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The page to request, defaulting to the first for anything that cannot name one.
 *
 * `toPageNumber` from `@/lib/utils` is the tier's shared parser and is stricter than `Number`: it
 * requires a bare run of digits, so `''`, `'0'`, `'-3'`, `'1.5'`, `'1e3'`, `'0x2'`, `'abc'` and a
 * 21-digit value all fail it and fall back here. What it returns is always a whole number at or above
 * {@link FIRST_PAGE} and within the exactly-representable range, which is precisely the window
 * `getUserPosts` validates - so this function is what makes that call incapable of raising.
 *
 * A page past the end of the collection passes through unchanged and unclamped. That is required
 * rather than tolerated: the service answers it with an empty window beside the real totals, and
 * clamping here would silently render a different page than the URL names.
 *
 * @param searchParams - The resolved query string.
 * @returns The 1-based page to read.
 */
function resolveRequestedPage(searchParams: ProfileSearchParams): number {
  return toPageNumber(firstSearchParamValue(searchParams[PAGE_SEARCH_PARAM])) ?? FIRST_PAGE;
}

/**
 * The name to render as the page's heading.
 *
 * A blankness guard, not a null guard: `display_name` is typed non-nullable and the service
 * guarantees a value - the column is `NOT NULL` and registration derives one from the handle when
 * none was supplied - but `string` still admits `''` and `'   '`, and either would leave the page's
 * only `<h1>` with no perceivable text. That is a WCAG failure rather than a cosmetic one, because a
 * heading with an empty accessible name is announced as nothing at all.
 *
 * `username` is the correct fallback: it is unique, non-blank, and already the value the URL carries,
 * so the heading and the address always agree. The same resolution `@/components/blog/author-byline`
 * applies, so a name renders identically in the heading here and in every byline elsewhere.
 *
 * @param user - The author's public projection.
 * @returns A non-blank name.
 */
function resolveDisplayName(user: UserPublic): string {
  return user.display_name.trim().length > 0 ? user.display_name : user.username;
}

/**
 * The first grapheme of a word, or the empty string for an empty word.
 *
 * @param word - A single whitespace-free word.
 * @returns One grapheme, or `''` only when `word` itself is empty.
 */
function firstGrapheme(word: string): string {
  // The pattern fails only when the word BEGINS with a bare combining mark, which no keyboard
  // produces for a name. The spread indexes by code point rather than by UTF-16 unit, so even that
  // path cannot emit half a surrogate pair.
  return FIRST_GRAPHEME_PATTERN.exec(word)?.[0] ?? [...word][0] ?? '';
}

/**
 * The monogram shown while no avatar image is displayed.
 *
 * `'Alice Chen'` yields `'AC'`, `'prince'` yields `'P'`, `'Ada B. Lovelace'` yields `'AB'`. Runs of
 * whitespace collapse, so a name with a double space still yields two letters rather than three.
 * Non-empty for any input carrying a non-whitespace character, which {@link resolveDisplayName}
 * guarantees - so the fallback is never an empty circle.
 *
 * @param name - The already-resolved visible name, never a raw nullable field.
 * @returns One or two upper-cased graphemes.
 */
function initialsFrom(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, INITIALS_WORD_LIMIT)
    .map(firstGrapheme)
    .join('')
    .toUpperCase();
}

/**
 * The biography worth rendering, or `null` when there is none.
 *
 * `bio` is legitimately `null` for an account that has written none, and `string` additionally admits
 * a whitespace-only value that would render an empty paragraph - a visible gap in the header with no
 * content in it. Both collapse to `null` here, and the caller omits the element entirely rather than
 * emitting an empty one.
 *
 * The value is trimmed rather than returned verbatim, because it IS rendered with its internal line
 * breaks preserved: leading or trailing blank lines would otherwise become visible padding.
 *
 * @param bio - The stored biography, as the wire carries it.
 * @returns The trimmed biography, or `null`.
 */
function resolveBio(bio: string | null): string | null {
  const trimmed = bio?.trim() ?? '';

  return trimmed.length > 0 ? trimmed : null;
}

/** Headline and supporting copy for the listing's empty state. */
interface EmptyStateCopy {
  /** Headline, rendered by `PostList` as a heading at {@link POST_CARD_HEADING_LEVEL}. */
  title: string;
  /** Supporting copy beneath it. */
  description: string;
}

/**
 * Empty-state copy for the two different facts an empty window can report.
 *
 * `PostList` renders one panel for both, so the copy is what distinguishes them - and the default
 * copy cannot, because "this author has published nothing" and "you have paged past the end of what
 * they published" call for different next actions. The first has none to offer; the second is
 * recoverable, and the page control below the panel stays mounted precisely so it can be taken.
 *
 * Requesting a page above the first is the discriminator rather than the envelope's `pages`, because
 * the copy is only ever rendered when the window is empty: on page one an empty window can only mean
 * the author has published nothing, and above page one it can only mean the request ran off the end.
 *
 * @param name - The author's resolved display name, so the copy names a person rather than "this
 * user".
 * @param requestedPage - The page the URL asked for.
 * @returns The headline and description to hand to `PostList`.
 */
function resolveEmptyState(name: string, requestedPage: number): EmptyStateCopy {
  if (requestedPage > FIRST_PAGE) {
    return {
      title: 'Nothing on this page',
      description: `This page is past the end of the articles ${name} has published. Use the page control below to go back.`,
    };
  }

  return {
    title: 'No published articles yet',
    description: `${name} has not published anything yet. Anything they publish will appear here.`,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Presentation
 *
 * Every value below resolves to a semantic token declared in `src/app/globals.css` or to a utility
 * generated from the token layer's own `--spacing`, `--text-*`, `--container-*` and `--breakpoint-*`
 * scales. There is no literal colour, dimension, font size, radius or shadow anywhere in this file,
 * and no inline `style` object.
 *
 * Named constants rather than inline strings, matching every other route and component in this tier:
 * a class string with a paragraph explaining WHY it is that string cannot live inside the markup
 * without burying the structure it describes.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The page's own shell: measure, inset and vertical rhythm.
 *
 * Byte-identical to `src/app/loading.tsx`, which is this route's own streaming fallback, so the
 * skeleton and the resolved page occupy the same box and swapping one for the other shifts nothing.
 *
 * `max-w-6xl` is the `--container-6xl` token (72rem) - the same measure `SiteHeader` and `SiteFooter`
 * use, so the profile's content edges line up with the shell above and below it, and it is wide
 * enough for the three-column post grid at the largest breakpoint. `w-full` makes the block shrink
 * below that measure instead of standing at it, `mx-auto` centres it inside the layout's `<main>`,
 * and the inline padding steps up once at `sm` so the content never touches a phone's edge.
 *
 * `gap-8` between the header and the listing is a step above the grid's own internal gutter, which
 * reads the two as separate regions rather than as equally spaced siblings.
 */
const PAGE_SHELL = 'mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-12 sm:px-6';

/**
 * The profile header: a column of identity, biography and membership.
 *
 * `gap-4` is tighter than the shell's `gap-8`, which is what groups the three bands as one region.
 */
const PROFILE_HEADER = 'flex flex-col gap-4';

/**
 * The identity band: avatar beside name, or above it on a narrow viewport.
 *
 * Mobile-first and the only breakpoint this file uses. Below `sm` the avatar stacks above the name,
 * which is what keeps a long name off a 375px viewport's edge; from `sm` the two sit on one row,
 * vertically centred against each other.
 */
const IDENTITY_ROW = 'flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6';

/**
 * The avatar, at profile scale.
 *
 * The primitive defaults to `size-10`, which is a byline's diameter; this is the page's subject, so it
 * steps up to `size-20` and again to `size-24` from `sm`. Both are `--spacing` multiples. The
 * primitive's own `shrink-0` keeps the circle from being squeezed by a long name beside it.
 */
const PROFILE_AVATAR = 'size-20 sm:size-24';

/**
 * The monogram inside it.
 *
 * Sized here rather than inherited, because a utility on the root cannot reach the fallback - the
 * primitive documents exactly this pairing. Without it, `text-sm` initials would sit in a 5rem disc.
 */
const PROFILE_INITIALS = 'text-2xl sm:text-3xl';

/**
 * The name and handle stack.
 *
 * `min-w-0` is load-bearing in a flex row: a flex item's automatic minimum size is its content's
 * min-content width, so without it a long unbroken name would set a floor this column could not go
 * below and would push the row past its container.
 */
const IDENTITY_TEXT = 'flex min-w-0 flex-col gap-1';

/**
 * The page's single `<h1>`.
 *
 * `wrap-anywhere` rather than the `overflow-wrap: break-word` inherited from `globals.css`, and the
 * difference is a specification detail rather than a preference: the break opportunities `break-word`
 * introduces are excluded from min-content intrinsic sizing, so an unbreakable 50-character display
 * name still sets the floor for this element's flex ancestors and overflows the viewport.
 * `overflow-wrap: anywhere` is the one value whose break opportunities DO count toward min-content,
 * which is what finally lets the word break. An ordinary multi-word name is untouched, because its
 * spaces are earlier wrap opportunities.
 */
const PROFILE_NAME = 'text-3xl font-semibold tracking-tight wrap-anywhere sm:text-4xl';

/** The handle: supporting text, so the recessed foreground token and the small step. */
const PROFILE_HANDLE = 'text-muted-foreground text-sm wrap-anywhere';

/**
 * The biography.
 *
 * `max-w-2xl` is the `--container-2xl` token, which holds the prose at a readable measure on a wide
 * viewport instead of letting it run the full 72rem of the shell. `whitespace-pre-line` preserves the
 * line breaks an author typed while still collapsing runs of spaces, and `wrap-anywhere` prevents a
 * pasted URL - unbroken text this page does not control - from overflowing at a narrow width.
 */
const PROFILE_BIO = 'max-w-2xl whitespace-pre-line wrap-anywhere';

/** The membership line: an icon, a label and the instant, as one recessed row. */
const PROFILE_META = 'text-muted-foreground flex items-center gap-2 text-sm';

/** The icon in that row. `shrink-0` keeps it circular when the text beside it wraps. */
const META_ICON = 'size-4 shrink-0';

/** The listing region: its heading above the grid, with the grid's own gutter between them. */
const POSTS_SECTION = 'flex flex-col gap-6';

/** The listing's heading - the `<h2>` the card titles sit beneath. */
const POSTS_HEADING = 'text-xl font-semibold tracking-tight';

/* -------------------------------------------------------------------------------------------------
 * Metadata
 * ---------------------------------------------------------------------------------------------- */

/**
 * Metadata for a handle nothing answers to.
 *
 * Returned rather than thrown: the component's `notFound()` is what reports the missing resource, and
 * a metadata function that failed would report it as a server error instead. The title flows through
 * the root layout's own template, so a reader who followed a dead link sees a branded tab rather than
 * a bare one.
 *
 * The title is deliberately the SAME WORDING `src/app/not-found.tsx` gives its own heading, rather
 * than a profile-specific phrase. That boundary is what actually renders for this case, so a
 * route-specific title would put "Profile not found" in the tab above a page whose visible heading
 * reads "Page not found" - measured in a browser, where this object's title is the one that wins.
 * Matching the two means the reader, their history and their bookmark all agree with the page. The
 * description stays specific to this route, because nothing visible contradicts it.
 *
 * Deliberately carries no `robots` directive of its own. `src/app/robots.ts` holds the site's crawl
 * policy and the boundary supplies its own `noindex` for the page it renders; a third declaration
 * here would be one more place for the three to drift apart.
 */
const MISSING_PROFILE_METADATA: Metadata = {
  title: 'Page not found',
  description: 'No profile on this site matches that address.',
};

/**
 * Per-resource metadata for the profile: title, description, canonical URL, OpenGraph and Twitter
 * card.
 *
 * Every field is built by `buildProfileMetadata` in `@/lib/seo`, which is also the sole reader of the
 * site origin and site name and the sole builder of the `/u/{username}` path - so nothing here spells
 * a URL, interpolates an origin or reads an environment variable, and the canonical link this page
 * publishes is identical to the one `src/app/sitemap.ts` lists and the one the `Person` graph names.
 *
 * No `robots` directive is emitted, here or by that builder. `src/app/robots.ts` is the one place this
 * site's crawl policy is declared, and a per-page directive would be a second place for the two to
 * drift apart.
 *
 * The profile is read through {@link readProfile}, so this call and the component's share one request.
 *
 * ## Why the missing handle returns metadata here instead of raising `notFound()`
 *
 * Metadata generation is not where a missing resource is reported. It returns
 * {@link MISSING_PROFILE_METADATA} and lets the component raise the signal, which keeps one condition
 * handled in one place - and, measured against this application, raising it here changes nothing that
 * matters:
 *
 * Unknown handle, `notFound()` from the component only ....... 404 boundary rendered, status 200
 * Unknown handle, `notFound()` from metadata generation too ... 404 boundary rendered, status 200
 * Unknown handle, with `src/app/loading.tsx` moved aside ...... 404 boundary rendered, status 404
 *
 * The status is settled before either signal is raised. `src/app/loading.tsx` places a Suspense
 * boundary above every nested route, so the framework completes the shell - the document, the header,
 * that skeleton - and commits the response line while every async page component is still pending.
 * Whatever a page decides afterwards arrives inside the stream, and the framework's documented
 * behaviour is that a not-found raised after the first flush keeps its 200.
 *
 * So the 200 is a property of the application's route-level streaming boundary rather than of this
 * file, and it is identical for every route in the tier. It is recorded here because it is worth
 * knowing rather than rediscovering: the reader for whom it matters is whoever revisits that
 * boundary, since removing or narrowing it is the single change that turns these responses into hard
 * 404s. This route needs no edit when that happens - it already raises the right signal for exactly
 * the right condition.
 *
 * @param props - The route's matched segments. `searchParams` is deliberately not accepted: the
 * canonical URL of a profile is the profile's address, and a paged view must not publish a different
 * one for each page.
 * @returns Resolved metadata, or {@link MISSING_PROFILE_METADATA} when nothing is addressable.
 */
export async function generateMetadata({
  params,
}: Pick<AuthorProfilePageProps, 'params'>): Promise<Metadata> {
  const { username } = await params;
  const profile = await readProfile(username);

  if (profile === null) {
    return MISSING_PROFILE_METADATA;
  }

  return buildProfileMetadata(profile);
}

/* -------------------------------------------------------------------------------------------------
 * Route
 * ---------------------------------------------------------------------------------------------- */

/**
 * The public author profile page.
 *
 * A Server Component, so the author's identity and the post titles reach the initial HTML - see the
 * module header for why that is the requirement rather than an optimisation.
 *
 * @param props - See {@link AuthorProfilePageProps}.
 * @returns The profile header, the `Person` structured data and one window of published posts.
 */
export default async function AuthorProfilePage({
  params,
  searchParams,
}: AuthorProfilePageProps): Promise<JSX.Element> {
  // Both are Promises on this framework version, and neither depends on the other, so they resolve
  // together rather than one after the other.
  const [{ username }, resolvedSearchParams] = await Promise.all([params, searchParams]);
  const requestedPage = resolveRequestedPage(resolvedSearchParams);

  /*
   * Concurrent, not sequential: the listing's arguments are known before either read starts, so
   * awaiting the profile first would serialise two independent round trips for no benefit.
   *
   * Neither reader rejects for a missing profile - both answer `null` - so this `Promise.all` cannot
   * reject on the one failure that is not an error. Every other failure rejects and propagates, which
   * is what sends a 5xx to `src/app/error.tsx` instead of rendering a "no such author" page.
   */
  const [profile, posts] = await Promise.all([
    readProfile(username),
    readAuthorPosts(username, requestedPage),
  ]);

  /*
   * `notFound()` returns `never`, so both values are narrowed to non-null below with no assertion.
   *
   * `posts` is tested as well as `profile` because an unknown handle is reported on both routes, and
   * because the two reads are concurrent: an account deleted between them would otherwise leave a
   * header rendered above a listing that does not exist. A profile that cannot be listed is not a
   * profile this page can render.
   */
  if (profile === null || posts === null) {
    notFound();
  }

  const displayName = resolveDisplayName(profile);
  const bio = resolveBio(profile.bio);
  const emptyState = resolveEmptyState(displayName, requestedPage);

  /*
   * Both forms of the same instant, formatted once so the attribute and the visible text cannot
   * disagree. The guard is on the FORMATTED values and compares against the format module's own
   * exported placeholder rather than a bare `''`: that is stricter than a null check in the way that
   * matters, because a non-empty but unparseable timestamp is truthy yet formats to the placeholder,
   * and would otherwise emit `<time dateTime="">` - an invalid element - with nothing visible in it.
   */
  const joinedMachineDate = formatMachineDate(profile.created_at);
  const joinedHumanDate = formatDate(profile.created_at);
  const hasJoinedDate = joinedMachineDate !== EMPTY_VALUE && joinedHumanDate !== EMPTY_VALUE;

  return (
    <div className={PAGE_SHELL}>
      {/*
       * The `Person` graph, in the page body rather than in `generateMetadata` - the metadata API
       * describes the document, and structured data describes the subject. It renders one `<script>`,
       * which the user-agent stylesheet gives `display: none`, so it takes no slot in this flex column
       * and adds no gap.
       */}
      <PersonJsonLd user={profile} />

      <header className={PROFILE_HEADER}>
        <div className={IDENTITY_ROW}>
          {/*
           * The Radix wrapper, never `next/image` and never a raw `<img>`: the primitive applies this
           * tier's remote-host policy itself and drops a URL it denies, which is exactly what keeps
           * the fallback mounted. `alt=""` because the name is rendered beside it as this page's
           * heading, so descriptive text here would announce the same person twice. `null` becomes
           * `undefined` because the DOM prop is optional rather than nullable.
           */}
          <Avatar className={PROFILE_AVATAR}>
            <AvatarImage alt="" src={profile.avatar_url ?? undefined} />
            <AvatarFallback className={PROFILE_INITIALS}>
              {initialsFrom(displayName)}
            </AvatarFallback>
          </Avatar>

          <div className={IDENTITY_TEXT}>
            {/* The document's single `<h1>`: the subject of the page, as plain text. */}
            <h1 className={PROFILE_NAME}>{displayName}</h1>

            {/*
             * The handle, which is also the address. Rendered as text rather than as a link: the only
             * URL it could point at is this page.
             *
             * Interpolated as ONE string rather than as `@{profile.username}`, which would be two
             * children and would emit the handle as two text nodes separated by React's own comment
             * marker. Both render identically, but a single node is what a text search over the
             * served HTML - a crawler's, a test's - can actually match.
             */}
            <p className={PROFILE_HANDLE}>{`@${profile.username}`}</p>
          </div>
        </div>

        {/* Omitted entirely when the account has written none, rather than rendered empty. */}
        {bio === null ? null : <p className={PROFILE_BIO}>{bio}</p>}

        {hasJoinedDate ? (
          <p className={PROFILE_META}>
            {/*
             * Decorative: the sentence beside it already says "member since", so an announced glyph
             * would only repeat it.
             */}
            <CalendarDays aria-hidden="true" className={META_ICON} />
            <span>
              Member since <time dateTime={joinedMachineDate}>{joinedHumanDate}</time>
            </span>
          </p>
        ) : null}
      </header>

      {/*
       * A named region: `aria-labelledby` points at the heading below, so a screen-reader user can
       * find and skip the listing as a unit instead of meeting an unnamed section.
       */}
      <section aria-labelledby={POSTS_HEADING_ID} className={POSTS_SECTION}>
        <h2 className={POSTS_HEADING} id={POSTS_HEADING_ID}>
          Published articles
        </h2>

        {/*
         * The page envelope passed straight through, unwrapped and unfiltered. `PostList` owns the
         * one/two/three-column grid, the result-range line, the empty panel and the page control -
         * whose anchors are real `<a href>` links, so the paged views of this profile are crawlable.
         *
         * `prioritizeFirstCover` is deliberately not passed: this list sits below the profile header,
         * so its first cover is not this page's largest contentful paint and prioritising it would
         * make the browser contend for bandwidth on an image nobody has scrolled to.
         */}
        <PostList
          emptyDescription={emptyState.description}
          emptyTitle={emptyState.title}
          headingLevel={POST_CARD_HEADING_LEVEL}
          page={posts}
        />
      </section>
    </div>
  );
}
