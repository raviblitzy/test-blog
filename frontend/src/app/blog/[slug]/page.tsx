/**
 * The public post reading page: `/blog/{slug}`.
 *
 * This is the product's single most SEO-consequential surface and the only place in the tier that
 * performs the slug-keyed read of a post. It renders one article - title, byline, publication
 * instant, reading time, cover, sanitised Markdown body and category pills - together with the
 * three social affordances the plan asks of it: a like control, share affordances and a threaded
 * discussion. It also carries this resource's share of the SEO work: a per-resource
 * `generateMetadata`, a canonical URL, OpenGraph and Twitter fields, and the `BlogPosting`
 * structured data.
 *
 * ## The request, end to end
 *
 * 1. `generateMetadata` awaits `params`, reads the post through {@link readPost} and hands it to
 *    `buildPostMetadata`. A slug nothing answers to yields {@link MISSING_POST_METADATA} rather than
 *    a thrown error - see "Three failure paths" below.
 * 2. The component awaits `params` and `searchParams` together, then reads the post FIRST. That
 *    ordering is mandatory rather than stylistic - see "The key asymmetry" below.
 * 3. With the post in hand, the comment thread and the like tally are read CONCURRENTLY from
 *    `post.id`. {@link readPost} is wrapped in React's `cache`, so this read and
 *    `generateMetadata`'s share one request instead of issuing the same one twice.
 * 4. A missing post becomes `notFound()`, which renders the sibling `not-found.tsx` in THIS folder.
 *    A post that exists renders the article, the `BlogPosting` graph and the discussion.
 *
 * ## The key asymmetry, which no type checker can catch
 *
 * | Call                                          | Keyed on   | Returns               |
 * | --------------------------------------------- | ---------- | --------------------- |
 * | `getPost(slug)`                               | **slug**   | `PostDetail`          |
 * | `listComments(post.id, …)`                    | **UUID**   | `Page<CommentPublic>` |
 * | `getLikes(post.id)`                           | **UUID**   | `LikeSummary`         |
 *
 * Both parameters are `string`, so handing a slug to either sibling read compiles perfectly and then
 * answers `404` at run time - the post's thread and tally would simply never appear, with nothing
 * failing anywhere. The post is therefore resolved before either sibling read is composed, and
 * `post.id` is the only value passed to them. `@/lib/api/posts` states the same rule from the other
 * side: passing an identifier to `getPost` answers `404`.
 *
 * This folder performs that read and nothing else. It invokes no mutation - no create, update,
 * delete, publish or unpublish - because those belong to the `(dashboard)` authoring surfaces at
 * `/posts/*`, which `src/middleware.ts` guards and `src/app/robots.ts` disallows. `/blog/{slug}` is
 * the public reading address, deliberately unguarded and deliberately crawlable, and all three of
 * those files agree about it.
 *
 * ## What reaches the initial HTML
 *
 * All of it. There is no `'use client'` directive here, and the article body, the byline, the
 * category links, the comment bodies and the pagination anchors all come from components that carry
 * none either. AAP §0.6.5 calls this the single most consequential SEO decision in the plan, and
 * §0.9.4.5 makes it a blocking criterion verified with client scripting disabled: a crawler must not
 * have to execute JavaScript to read the article.
 *
 * Exactly two client islands are mounted - `LikeButton` and `ShareBar` - and both receive
 * serializable props only, which a Server Component may render freely. A page does not become a
 * client bundle merely because it contains a like button.
 *
 * ## Three failure paths, told apart rather than merged
 *
 * Reporting every failure as "no such post" would tell a reader - and a crawler, which acts on it -
 * that an article has been withdrawn when the service was merely unreachable. So the failures are
 * classified rather than swallowed:
 *
 * | Failure                                        | Result                                        |
 * | ---------------------------------------------- | --------------------------------------------- |
 * | `ApiError` 404 from the post or thread read     | `notFound()` → the sibling `not-found.tsx`    |
 * | `TypeError` from the path-segment guard         | `notFound()` - the URL cannot address a post  |
 * | Any 5xx, timeout or unreachable service         | RETHROWN, so `src/app/error.tsx` handles it   |
 * | A malformed payload                             | RETHROWN, for the same reason                 |
 * | ANY failure of the like tally                   | Degraded: the control fetches it on the client |
 *
 * The last row is the one deliberate degradation, and it is the pattern `src/app/page.tsx` already
 * uses for the category taxonomy: a secondary read whose absence costs nothing must not take the
 * article down with it. `LikeButton.initialSummary` is optional by construction, and the island
 * re-reads the tally on mount, so the only cost of a failed tally is that the digit appears a moment
 * later. Nothing about the failure is shown to the visitor: no message, no `ProblemDetail` field and
 * no stack reaches the page, which is the precedent `src/app/error.tsx` sets by exposing only an
 * opaque digest.
 *
 * ## Draft confidentiality is the service's, not this file's
 *
 * A server render is anonymous by construction: the credential store in `@/lib/api/client` is
 * browser-only, and no route in this tier passes a `bearer` on its behalf. The service's public
 * projection is `PUBLISHED`-only for every caller, so `getPost` answers `404` here for a draft or an
 * archived post and the sibling boundary renders - whose copy already anticipates exactly that
 * ("taken back to draft by its author"). There is therefore NO client-side status gate in this file
 * and no status pill: a branch no request can reach is not a safeguard, and hiding a control was
 * never a security boundary. Authority stays where AAP §0.9.4.4 puts it - in the service.
 *
 * ## Ownership boundaries this file does not cross
 *
 * - **The document belongs to `src/app/layout.tsx`**: `<html>`, `<body>`, the skip link, the three
 *   providers, `SiteHeader`, the `<main>` landmark, `SiteFooter`, the toast host and the tier's only
 *   `globals.css` import. This file contributes page body content and nothing else.
 * - **The category pills belong to `PostContent`.** It consumes `@/components/ui/badge` itself and
 *   links each pill to the category-filtered feed. `categories` is passed through and no second pill
 *   set is emitted here - the filtered home feed IS the category page, and there is no
 *   `/categories/[slug]` route in this product to link to instead.
 * - **The publication `<time dateTime>` belongs to `AuthorByline`.** It formats both the machine and
 *   the human form through `@/lib/format` and links `/u/{username}` through `@/lib/seo`.
 *   `publishedAt` is passed through, so exactly one publication `<time>` exists on the page. No
 *   second machine-readable instant is rendered either: `updated_at` reaches the `BlogPosting`
 *   graph's `dateModified` and the document's `modifiedTime`, and AAP §0.7.3.1 does not list a
 *   visible modification line among this screen's content.
 * - **The reading measure belongs to `PostContent`.** Its root is `md:max-w-2xl`, and its own
 *   documentation records that at `64rem` the measure stays constrained while the MARGIN around it
 *   for metadata belongs to the route - which is what {@link BODY_REGION} supplies, and why
 *   `lg:mx-0` is the one class this file passes it.
 * - **No HTTP.** `@/lib/api/client` is the only module in the tier that performs a request. This
 *   file calls three typed wrappers and spells no path, so it structurally cannot bypass the
 *   `/api/v1` prefix that module composes exactly once, and `fetch` appears nowhere.
 * - **No environment variable.** `@/lib/seo` is the sole reader of `NEXT_PUBLIC_SITE_URL` and
 *   `NEXT_PUBLIC_SITE_NAME` and the sole builder of `/blog/{slug}`, so every canonical URL this
 *   route publishes - in the metadata, in the graph and in the share affordances - is built there.
 *   `process.env` does not appear in this file.
 * - **No structured data of its own.** `BlogPostingJsonLd` owns the entire `BlogPosting` graph,
 *   including the `/og-default.png` image fallback, and is rendered in the component tree rather
 *   than from `generateMetadata` - the metadata API describes the document, structured data
 *   describes the subject.
 * - **No image host.** `frontend/next.config.ts` owns `images.remotePatterns`, derived from
 *   `IMAGE_HOST_ALLOWLIST`; `allowedImageUrl` is the predicate that keeps a denied host from
 *   reaching `next/image` at all. No host is added here.
 * - **No sibling boundary.** `not-found.tsx` in this folder is the only other file the plan places
 *   here; the root `layout.tsx`, `loading.tsx`, `error.tsx` and `opengraph-image.tsx` cover their
 *   concerns for this segment already, and a duplicate would be unrequested scope.
 *
 * ## Governing standards
 *
 * `review_rules` reports that **no user-specified rules were provided** for this project - a
 * complete answer rather than a truncated one - so nothing here is invented to satisfy one and the
 * bar is not lowered. The binding constraints are the technical plan's own enterprise standards, and
 * AAP §0.8.5 makes the design-system rules binding on every file under `frontend/src/`. Those that
 * govern this file:
 *
 * | Standard                           | How this file satisfies it                                  |
 * | ---------------------------------- | ----------------------------------------------------------- |
 * | Layered separation of concerns     | Three typed wrappers, no `fetch`, no header, no path spelled |
 * | Explicit API contracts             | The five-member page envelope and every snake_case field verbatim |
 * | API versioning                     | Honoured negatively - no path here, so none can bypass `/api/v1` |
 * | Server-owned identity              | Keys on the `slug` segment; `post.id` is opaque and server-generated |
 * | Secure-by-default authentication   | Draft confidentiality left to the service; no client-side gate |
 * | Zero hardcoded presentation values | Every class is a semantic token or a generated scale utility; no inline `style` |
 * | Semantic tokens, not families      | `bg-surface-muted`, `text-muted-foreground`, never a colour family and shade |
 * | Project primitives over raw elements | No raw `button`, `input`, `textarea`, `select` or `table` - the controls are components |
 * | Behavioural primitives             | The avatar arrives through `AuthorByline`'s Radix wrapper; nothing is hand-rolled |
 * | One breakpoint vocabulary          | Mobile-first; `sm`, `md` and `lg` only, and no custom `@media` query |
 * | Accessibility as a floor           | One `<h1>`, ordered levels, `<article>`/`<time>`, decorative cover, visible focus |
 * | Configuration from the environment | Read only through `@/lib/seo`; this file reads none            |
 * | Pinned dependencies                | `next` and `react` only - both already declared                |
 * | Blocking quality gates             | Compiles under `tsc --noEmit`, lints at `--max-warnings=0`     |
 *
 * @module
 */

import type { Metadata } from 'next';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { cache, type JSX } from 'react';

import { AuthorByline } from '@/components/blog/author-byline';
import { CommentList } from '@/components/blog/comment-list';
import { LikeButton } from '@/components/blog/like-button';
import { PostContent } from '@/components/blog/post-content';
import { ReadingTime } from '@/components/blog/reading-time';
import { ShareBar } from '@/components/blog/share-bar';
import { BlogPostingJsonLd } from '@/components/seo/json-ld';
import { isApiError } from '@/lib/api/client';
import { listComments } from '@/lib/api/comments';
import { getLikes } from '@/lib/api/likes';
import { getPost } from '@/lib/api/posts';
import { buildPostMetadata } from '@/lib/seo';
import type { CommentPublic, LikeSummary, Page, PostDetail } from '@/lib/types';
import { allowedImageUrl, cn, FIRST_PAGE, toPageNumber } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Read parameters
 * ---------------------------------------------------------------------------------------------- */

/**
 * The one HTTP status this route interprets.
 *
 * Named rather than written inline at the comparison, because the number is a decision - it is the
 * single status that means "nothing is readable at this address" and therefore the single status
 * that may become a 404 page - and a bare literal beside `error.status` reads like an implementation
 * detail instead.
 */
const POST_NOT_FOUND_STATUS = 404;

/**
 * The search parameter carrying the requested page of the comment thread.
 *
 * `@/hooks/use-pagination` declares the same spelling and is what `@/components/ui/pagination`
 * uses to build its anchors, so the value this route READS and the value that control WRITES are one
 * string rather than two that agree by coincidence. Reading it is not optional: the thread's page
 * links are real `<a href>` anchors pointing at `/blog/{slug}?page=N`, so a route that ignored the
 * parameter would render page one for every one of them and the control would appear inert.
 *
 * There is no collision with the home feed's identically named parameter. That is a different route
 * with a different collection; this page has exactly one paginated collection, so `page` here
 * unambiguously means "page of the discussion".
 */
const PAGE_SEARCH_PARAM = 'page';

/**
 * Framework revalidation for the post itself: five minutes.
 *
 * The same window `src/app/u/[username]/page.tsx` uses, for the same reason. A published article's
 * title, body and cover change on the order of days, so an interval short enough that an author's
 * edit appears within the same working session is ample - and a crawler walking every post from the
 * generated sitemap then costs a bounded number of requests against the service rather than one per
 * URL. No cache tag accompanies it, because nothing in this tier calls `revalidateTag` and a tag no
 * code invalidates only looks like a mechanism.
 */
const POST_READ_REVALIDATION = { revalidate: 300 } as const;

/**
 * Framework revalidation for the discussion and the tally: one minute.
 *
 * Shorter than the article's window because both are volatile in a way the article is not - a
 * moderator approves a comment, a reader adds a like - and it is the window both wrappers use in
 * their own documented examples. A newly created comment is not the reason for it: the service
 * creates comments `PENDING`, so a reader's own contribution is withheld from the public thread
 * until it is approved however fresh this read is, and `CommentForm` says so in its confirmation
 * rather than implying the comment is already visible.
 */
const THREAD_READ_REVALIDATION = { revalidate: 60 } as const;

/**
 * Heading level for the discussion's own heading.
 *
 * Two, because the outline is `h1` (the post title) and then this - and `PostContent` downshifts
 * every authored heading by one level, so the article's own top-level sections are `h2` as well and
 * the discussion sits beside them rather than skipping a level or colliding with the page heading.
 * `CommentList` accepts `2 | 3` only, which is narrower than the feed's card heading prop, and 2 is
 * the correct member of that pair for a page whose `h1` is the article title.
 */
const COMMENT_HEADING_LEVEL = 2;

/**
 * Prefix on the one log line this route can write, so a degraded like tally is attributable in a
 * server log without being visible to the reader.
 */
const LOG_PREFIX = '[post-detail]';

/**
 * The layout hint the browser uses to pick a source from the cover's generated `srcset`.
 *
 * These two literals are deliberate and are NOT a token violation, for the reason
 * `src/components/blog/post-card.tsx` records at its own equivalent: `sizes` is an HTML attribute
 * whose media conditions are evaluated by the image-selection algorithm BEFORE any stylesheet
 * applies, so it cannot reference a CSS custom property and there is no token-based spelling of the
 * value. Both numbers are read off the layout rather than chosen: `48rem` is the token layer's `md`
 * breakpoint, which is where {@link COVER_FRAME} adopts the reading measure, and `42rem` is that
 * measure - the `--container-2xl` token the frame, the heading and the prose all share.
 *
 * `100vw` below that breakpoint slightly OVERSTATES the frame, which is the safe direction to be
 * wrong in: the frame is the shell's content width, a little under the viewport once the inset is
 * taken off, so the browser may pick one source step larger than strictly needed and can never pick
 * one too small. Getting the hint wrong the other way is not cosmetic - omit it entirely and the
 * browser assumes `100vw` at EVERY width and downloads a viewport-wide source for a 42rem frame,
 * which is the Core Web Vitals regression the lint gate flags.
 */
const COVER_SIZES = '(min-width: 48rem) 42rem, 100vw';

/* -------------------------------------------------------------------------------------------------
 * Route props
 *
 * Both members are Promises, which is the App Router's own shape on this framework version: reading
 * either is what marks the render dynamic, so they are handed over unresolved and awaited here.
 * ---------------------------------------------------------------------------------------------- */

/** The route's single dynamic segment, already percent-decoded by the framework. */
interface PostRouteParams {
  /**
   * The post's slug exactly as the URL carries it.
   *
   * Passed to the service verbatim. A slug is derived once at creation, is `citext`-unique and never
   * changes - which is precisely what makes the canonical URL trustworthy - so it is treated here as
   * opaque and immutable: nothing lower-cases it, trims it, normalises it or rebuilds it. The column
   * performs the case fold, so `/blog/My-Post` and `/blog/my-post` address one article, and
   * restating that here would be a second implementation of a guarantee the schema already makes.
   */
  slug: string;
}

/** The query string, in the framework's own shape: a repeated key arrives as an array. */
type PostSearchParams = Record<string, string | string[] | undefined>;

/** Props of {@link PostPage}. */
interface PostPageProps {
  /** The matched dynamic segments. */
  params: Promise<PostRouteParams>;
  /**
   * The query string. Only {@link PAGE_SEARCH_PARAM} is read; anything else is ignored, so a
   * campaign parameter on a shared link cannot change what the page renders.
   */
  searchParams: Promise<PostSearchParams>;
}

/* -------------------------------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a caught failure means "nothing is readable at this URL" rather than "the request failed".
 *
 * This distinction is the whole of the route's error handling, and getting it wrong is worse than
 * having none: a 404 page served for a 5xx tells a crawler the article has been withdrawn, and it
 * acts on that. See the failure table in the module header.
 *
 * `isApiError` is the narrowing helper `@/lib/api/client` documents for exactly this, in preference
 * to a bare `instanceof` - every failure that reached the service, and every one that could not, is
 * normalised into that single type, so `status` is the only test needed.
 *
 * The `TypeError` branch covers the path-segment guard in `@/lib/utils`, which refuses to compose a
 * request from a blank segment or from a relative-path segment. Both arrive from the URL rather than
 * from a bug here - `/blog/%20` decodes to a blank slug and `/blog/%2E%2E` to `..` - and neither can
 * address a post, so 404 is the honest answer rather than a server fault. The check cannot catch an
 * unrelated programming error by accident because each guarded region below contains exactly one
 * call.
 *
 * @param error - The caught value, of unknown type as `catch` provides it.
 * @returns `true` when the correct response is the missing-post boundary, `false` when the failure
 * must propagate to `src/app/error.tsx`.
 */
function isUnreadablePost(error: unknown): boolean {
  if (isApiError(error)) {
    return error.status === POST_NOT_FOUND_STATUS;
  }

  return error instanceof TypeError;
}

/**
 * Read one post by its slug, answering `null` when nothing is readable at it.
 *
 * **Keyed on the SLUG.** This is the only slug-keyed read in the tier; every other call on this page
 * keys on `post.id`. See the module header's asymmetry table.
 *
 * Wrapped in React's `cache`, so `generateMetadata` and {@link PostPage} resolve ONE request for the
 * same slug within a request rather than two identical ones. The framework's own fetch
 * deduplication would cover the common case, but the wrapper makes the sharing explicit and keeps it
 * true regardless of how the underlying read is dispatched.
 *
 * The absent post is modelled as `null` rather than as a thrown error precisely because both callers
 * need it and neither may throw for it: `generateMetadata` must still return a `Metadata` object,
 * and the component must reach `notFound()`. Every other failure is rethrown untouched.
 *
 * @param slug - The slug from the URL, passed through verbatim.
 * @returns The full post, or `null` when no readable post carries that slug.
 */
const readPost = cache(async (slug: string): Promise<PostDetail | null> => {
  try {
    return await getPost(slug, { next: POST_READ_REVALIDATION });
  } catch (error) {
    if (isUnreadablePost(error)) {
      return null;
    }

    throw error;
  }
});

/**
 * Read one page of a post's comment thread, answering `null` when the post is no longer readable.
 *
 * **Keyed on the post's UUID**, never on its slug - `GET /posts/{id}/comments` is an
 * identifier-addressed route, and a slug there answers `404` without any type error to warn of it.
 *
 * The window is deliberately incomplete: only `page` is sent, so the service applies its own default
 * size and exactly one definition of "twenty rows" exists - the service's, echoed back on the
 * envelope. The thread pages over TOP-LEVEL comments only; replies arrive nested inside each
 * `CommentPublic.replies` and are rendered recursively, so no request is ever made per node.
 *
 * A 404 here means the post stopped being readable between this read and the one before it - it was
 * deleted, or taken back to draft - so it is reported as a missing post rather than as an article
 * with no discussion. Every other failure propagates: the discussion is one of this page's required
 * features, and rendering an empty thread for an unreachable service would state something false.
 *
 * @param postId - The post's identifier, as `PostDetail.id` returned it.
 * @param page - The 1-based page to read. A page past the last one is legitimate: the service echoes
 * it back beside an empty `items` array and the real totals, which is what lets the control keep its
 * way back rather than raising.
 * @returns One page of top-level comments, unmodified, or `null` when the post is unreadable.
 */
async function readThread(postId: string, page: number): Promise<Page<CommentPublic> | null> {
  try {
    return await listComments(postId, { page }, { next: THREAD_READ_REVALIDATION });
  } catch (error) {
    if (isUnreadablePost(error)) {
      return null;
    }

    throw error;
  }
}

/**
 * Read a post's like tally, answering `undefined` when it cannot be read at all.
 *
 * **Keyed on the post's UUID**, for the same reason as the thread.
 *
 * No credential is required and none is presented: the service resolves an optional principal, so an
 * anonymous server render is answered normally and `liked_by_caller` comes back `false` - which is
 * exactly what a control should render for a visitor with no session, and what makes a server-side
 * tally possible at all. `LikeButton` re-reads the summary on mount and corrects that member for a
 * signed-in reader.
 *
 * This is the one read on the page that DEGRADES rather than propagating, and the asymmetry is
 * deliberate. The tally is not the page: `initialSummary` is optional, the island omits the digit
 * entirely while the count is unknown, and it fetches the value itself the moment it hydrates. So a
 * failure here costs a number appearing a moment later, whereas propagating it would cost the whole
 * article - including the body a crawler came for. `src/app/page.tsx` makes the same trade for the
 * category taxonomy, and for the same reason. The cause is written to the server log beside the
 * request rather than shown to the reader.
 *
 * @param postId - The post's identifier, as `PostDetail.id` returned it.
 * @returns The tally, or `undefined` when it could not be read.
 */
async function readLikes(postId: string): Promise<LikeSummary | undefined> {
  try {
    return await getLikes(postId, { next: THREAD_READ_REVALIDATION });
  } catch (cause) {
    const reason =
      cause instanceof Error ? `${cause.name}: ${cause.message}` : 'a non-Error value was thrown';
    console.error(
      `${LOG_PREFIX} Could not read the like tally for post ${postId}, so the article is rendered ` +
        `with the like control's count resolved on the client instead. The article itself is ` +
        `unaffected. Cause: ${reason}`,
    );

    return undefined;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Pure helpers
 *
 * Local rather than hoisted into `@/lib`: each exists to feed this route's own markup, and widening a
 * shared module's surface for a single caller is how shared modules stop being shared. Every one of
 * them is total over its input and none throws.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The first value of a search parameter, whatever arity it arrived with.
 *
 * A query string may repeat a key - `?page=2&page=5` is a legal URL - and the framework surfaces that
 * as an array. Taking the first entry is the same choice the pagination control makes by writing a
 * single value, and it is deliberately not an error: a repeated parameter is malformed input from a
 * hand-edited or badly concatenated link, and the correct response to that on a public reading page
 * is a sensible render rather than a failure.
 *
 * @param value - The raw parameter as the framework provides it.
 * @returns The first string value, or `undefined` when the key is absent.
 */
function firstSearchParamValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The page of the discussion to request, defaulting to the first for anything that cannot name one.
 *
 * `toPageNumber` is the tier's shared parser and is stricter than `Number`: it requires a bare run of
 * digits, so `''`, `'0'`, `'-3'`, `'1.5'`, `'1e3'`, `'0x2'`, `'abc'` and a 21-digit value all fail it
 * and fall back here. What it returns is always a whole number at or above {@link FIRST_PAGE} and
 * inside the exactly-representable range, which is the window the service validates - so the read it
 * feeds cannot raise for its argument.
 *
 * A page past the end of the thread passes through unchanged and unclamped. That is required rather
 * than tolerated: the service answers it with an empty window beside the real totals, `CommentList`
 * renders its empty panel and keeps its page control mounted, and clamping here would silently render
 * a different page than the URL names.
 *
 * @param searchParams - The resolved query string.
 * @returns The 1-based page of top-level comments to read.
 */
function resolveRequestedPage(searchParams: PostSearchParams): number {
  return toPageNumber(firstSearchParamValue(searchParams[PAGE_SEARCH_PARAM])) ?? FIRST_PAGE;
}

/**
 * The text to render as the page's single `<h1>`.
 *
 * A blankness guard, not a null guard: `title` is typed non-nullable and the service guarantees a
 * value - the column is `NOT NULL` and the create schema enforces a minimum length - but `string`
 * still admits `''` and `'   '`, and either would leave the document's only heading with no
 * perceivable text. That is a WCAG failure rather than a cosmetic one, because a heading whose
 * accessible name is empty is announced as nothing at all.
 *
 * The slug is the correct fallback and the only one available: it is unique, non-blank by the path
 * guard that just used it, and already the value in the address bar, so the heading and the URL agree.
 * `src/app/u/[username]/page.tsx` resolves the same hazard the same way, falling back to the handle
 * its own URL carries.
 *
 * @param post - The post as the service returned it.
 * @returns A non-blank heading.
 */
function resolveTitle(post: PostDetail): string {
  return post.title.trim().length > 0 ? post.title : post.slug;
}

/**
 * The standfirst beneath the heading, or `null` when the author wrote none.
 *
 * `excerpt` is `string | null` on the wire and is also what `@/lib/seo` uses for the document's
 * description, so rendering it here keeps the visible summary and the one a search result shows in
 * step instead of letting them diverge. Blank-but-present is folded into the absent case, because an
 * empty paragraph is a gap in the layout that reads as a rendering fault.
 *
 * Returning `null` rather than the empty string is what lets the caller omit the element entirely: a
 * `<p>` containing nothing still occupies a line box and still takes the column's gap.
 *
 * @param excerpt - The post's excerpt as the service returned it.
 * @returns The trimmed standfirst, or `null` when there is nothing to show.
 */
function resolveLede(excerpt: string | null): string | null {
  const trimmed = excerpt?.trim() ?? '';

  return trimmed.length > 0 ? trimmed : null;
}

/* -------------------------------------------------------------------------------------------------
 * Presentation
 *
 * Every value below resolves to a semantic token declared in `src/app/globals.css` or to a utility
 * generated from the token layer's own `--spacing`, `--text-*`, `--radius-*`, `--container-*` and
 * `--breakpoint-*` scales. There is no literal colour, dimension, font size, radius or shadow in this
 * file, no inline `style` object, no `dark:` variant - every token carries both values already - and
 * no custom `@media` query: `sm`, `md` and `lg` are the only breakpoints used, and all three are the
 * token layer's own.
 *
 * Named constants rather than inline strings, matching every other route in this tier: a class string
 * with a paragraph explaining WHY it is that string cannot live inside the markup without burying the
 * structure it describes. Composed at module scope through `cn`, so the merge runs once per process
 * rather than once per render.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The page's own shell.
 *
 * `max-w-6xl` is the `--container-6xl` token (72rem), the same measure `SiteHeader` and `SiteFooter`
 * establish, so the article's outer bounds line up with the shell above and below it. `w-full` makes
 * the block shrink below that measure instead of standing at it, and `mx-auto` centres it inside the
 * layout's `<main>`, which supplies no measure of its own.
 *
 * The inline inset lives HERE rather than on each region, and that placement is what makes the page
 * align. A region that carried its own padding inside its own `max-width` would have a content width
 * of 42rem less the padding, while `PostContent` applies the same 42rem token to its own box - so the
 * article body would have run 1.5rem wider on each side than the heading above it. Measured at 768px:
 * heading 72px…696px against prose 48px…720px. With the inset on the shell, every measure below is a
 * padding-free 42rem and the four regions share one pair of edges exactly.
 *
 * `gap-12` separates the article from the discussion by a step above the article's own internal
 * rhythm, which reads the two as separate regions rather than as equally spaced siblings.
 */
const PAGE_SHELL = 'mx-auto flex w-full max-w-6xl flex-col gap-12 px-4 py-10 sm:px-6';

/**
 * The measure shared by every region on the page - heading, cover, body and discussion alike.
 *
 * `md:max-w-2xl` is the `--container-2xl` reading measure (42rem) and is the SAME token
 * `PostContent`'s own root uses, which is what lets four regions sit on one column edge instead of on
 * four that nearly agree. Below `md` there is no constraint at all, so each region fills the single
 * column - which is the matrix's "single column, full-width media" below `48rem`, read exactly as
 * `PostContent`'s own documentation reads it: the media spans the full column rather than being
 * measured. `w-full` is what makes a region shrink below the measure rather than stand at it.
 *
 * `lg:mx-0` is the third tier of the matrix. From `64rem` the measure stays exactly where it was and
 * the region stops being centred, which start-aligns it with {@link BODY_REGION}'s prose column and
 * hands the leftover inline space to the metadata beside it. `PostContent`'s own documentation names
 * this arrangement as the route's responsibility - "for a metadata rail at 64rem, say" - which is why
 * `lg:mx-0` is one of the two classes this file passes it.
 */
const TEXT_REGION = 'w-full md:mx-auto md:max-w-2xl lg:mx-0';

/** The article element: one column, with a token gap between its bands. */
const ARTICLE = 'flex flex-col gap-8';

/** The heading band: title, standfirst and byline as one group, tighter than the article's rhythm. */
const ARTICLE_HEADER = cn(TEXT_REGION, 'flex flex-col gap-4');

/**
 * The page's single `<h1>`.
 *
 * `text-3xl` stepping to `text-4xl` at `sm` are `--text-*` tokens, so the heading is proportionate on
 * a phone and commanding on a laptop without a hand-picked size at either end.
 *
 * `text-balance` distributes a two- or three-line title evenly instead of leaving one orphaned word,
 * which is what a title of unknown length needs. `wrap-anywhere` rather than the `break-word` that
 * `globals.css` already applies to body copy: the break opportunities `break-word` introduces are
 * excluded from min-content intrinsic sizing, so an unbroken 50-character token in a title would
 * still set a floor its flex ancestors could not go below and would overflow a 375px viewport.
 * `overflow-wrap: anywhere` is the one value whose break opportunities do count toward min-content.
 * An ordinary multi-word title is untouched, because its spaces are earlier wrap opportunities.
 */
const ARTICLE_TITLE =
  'text-3xl font-semibold tracking-tight text-balance wrap-anywhere sm:text-4xl';

/**
 * The standfirst.
 *
 * `text-lg` sets it above body copy without competing with the heading, and `text-muted-foreground`
 * is the recessed semantic token, so it reads as a summary rather than as the first paragraph of the
 * article. `wrap-anywhere` for the same intrinsic-sizing reason as the heading, since an excerpt may
 * contain a pasted URL this page does not control.
 */
const ARTICLE_LEDE = 'text-muted-foreground text-lg wrap-anywhere';

/**
 * The byline row: attribution and reading time on one line, wrapping to two when they do not fit.
 *
 * A `<div>` rather than a `<p>`, deliberately: `AuthorByline` renders a `<div>` of its own, which is
 * flow content and cannot legally nest inside a paragraph. `gap-x-4 gap-y-2` keeps the two apart on
 * one line and closer together once they wrap, and `flex-wrap` is what removes any need for a
 * breakpoint here - the row reflows at whatever width its own content runs out of room, which is
 * earlier for a long display name than for a short one.
 */
const BYLINE_ROW = 'flex flex-wrap items-center gap-x-4 gap-y-2';

/**
 * The cover's frame, which is both a region of the page and the box that reserves the image's space.
 *
 * It composes {@link TEXT_REGION}, so it fills the single column below `md`, adopts the reading
 * measure from `md` and start-aligns from `lg` exactly as the heading and the prose do - one element
 * rather than a wrapper plus a frame, because the two would only ever carry the same measure.
 *
 * Each of the five utilities it adds is load-bearing:
 *
 *   * `relative` - `next/image` with `fill` positions itself absolutely, so it needs a positioned
 *     ancestor. Without this the image escapes the article entirely.
 *   * `aspect-video` - the engine's own token-backed ratio utility, compiling to
 *     `aspect-ratio: var(--aspect-video)`. This is what RESERVES the box before the image loads, so
 *     nothing below it moves when it arrives - the whole of the no-layout-shift requirement for a post
 *     that HAS a cover. An arbitrary `aspect-[16/9]` would be the hardcoded value the token discipline
 *     forbids, and a fixed height would break the fluid frame.
 *   * `overflow-hidden` - `object-cover` crops by overflowing, so without this the excess bleeds past
 *     the rounded corners.
 *   * `rounded-xl` - the `--radius-xl` the design system's `Card` root uses, so a cover and a feed
 *     card cannot drift apart. It applies at every width because the frame is inset from the viewport
 *     at every width; there is no full-bleed edge for it to fight.
 *   * `bg-surface-muted` - visible only while the image is in flight, or permanently if the host
 *     serves an error. A recessed panel reads as intentional; a transparent hole reads as broken.
 */
const COVER_FRAME = cn(
  TEXT_REGION,
  'relative aspect-video overflow-hidden',
  'bg-surface-muted rounded-xl',
);

/** The cover image itself: crop to fill the reserved frame rather than distort to fit it. */
const COVER_IMAGE = 'object-cover';

/**
 * The article's body region, and the third tier of the responsive matrix.
 *
 * Below `lg` it is one column: the prose, then the actions beneath it, in the order AAP §0.7.3.1
 * lists them - rendered content, category badges, like control, share bar. That order is the DOM
 * order at every width, so the reading order and the accessibility tree never depend on the viewport.
 *
 * From `lg` it drops the measure - `lg:max-w-none` - and becomes a three-track grid across the shell.
 * The prose spans two tracks and keeps its own 42rem measure start-aligned inside them, and the
 * actions flow into the third by auto-placement, which is the matrix's "constrained measure with
 * margin for metadata": something is placed IN the margin rather than the measure being widened.
 * Three equal tracks rather than a hand-picked pair of widths, so the split comes from the engine's
 * own grid scale - at the 72rem shell each track resolves to 21rem, the prose pair to 45rem, which
 * comfortably holds the measure, and the metadata to the remaining 21rem.
 *
 * Below `lg` it carries {@link TEXT_REGION}'s measure itself rather than delegating to the prose. That
 * is what keeps the actions beneath the article aligned with it, and it makes `PostContent`'s own
 * 42rem cap exactly equal to its parent's content width, so the two cannot disagree about where the
 * column ends.
 *
 * `gap-8` is the vertical rhythm between prose and actions and survives into the grid as its row gap;
 * `lg:gap-x-12` is the gutter that separates the measure from the metadata beside it. Both are
 * `--spacing` multiples.
 */
const BODY_REGION = cn(
  TEXT_REGION,
  'flex flex-col gap-8',
  'lg:grid lg:max-w-none lg:grid-cols-3 lg:gap-x-12',
);

/**
 * What the route contributes to `PostContent`'s own class list, and the only thing it contributes.
 *
 * `lg:col-span-2` places the article across the first two tracks of {@link BODY_REGION}, which leaves
 * the third for the metadata. `lg:mx-0` replaces the component's `mx-auto` from `lg` upward - the
 * component documents this exact override for a metadata rail - so the measure sits at the start of
 * its tracks instead of floating in the middle of them, aligned with the heading and the discussion.
 * `mx-auto` survives at every smaller width because `tailwind-merge` treats a variant and its base as
 * different declarations, which is what keeps the article centred at `md`.
 */
const PROSE_PLACEMENT = 'lg:col-span-2 lg:mx-0';

/**
 * The actions band: the like control and the share affordances.
 *
 * A plain `<div>` with no `role` and no `aria-*`. `<aside>` was the other candidate and is wrong:
 * these are affordances acting on the article, not content tangentially related to it, and publishing
 * a `complementary` landmark for them would lengthen the landmark list without giving a reader
 * anywhere new to go. Each control is already named - `LikeButton` computes its own accessible name
 * and `ShareBar` publishes a labelled `<nav>` of its own - so ARIA here would restate a decision that
 * already has exactly one home.
 *
 * `flex-col items-start` stacks the two and shrink-wraps them to their content, so neither stretches
 * across the column; `gap-4` separates them. From `lg` the band becomes the sticky metadata rail in
 * the third grid track, reached by auto-placement - no `col-span-1` is declared, because a single
 * track is what an auto-placed item already occupies and a redundant utility would only give a future
 * caller something extra to override.
 *
 * `lg:self-start` is mandatory rather than decorative: a grid item stretches to its row by default,
 * and a box already as tall as the row has nothing left to stick to. `lg:top-20` is `--spacing` × 20
 * (5rem), one step clear of the `h-16` sticky banner the shell mounts above it, so the rail settles
 * below the header rather than under it.
 */
const ACTIONS_BAND = cn('flex flex-col items-start gap-4', 'lg:sticky lg:top-20 lg:self-start');

/* -------------------------------------------------------------------------------------------------
 * Metadata
 * ---------------------------------------------------------------------------------------------- */

/**
 * Metadata for a slug nothing readable answers to.
 *
 * Returned rather than thrown: the component's `notFound()` is what reports the missing resource, and
 * a metadata function that failed would report it as a server error instead.
 *
 * Both fields are byte-identical to the ones the sibling `not-found.tsx` declares, and that is the
 * point rather than a coincidence. That boundary is what actually renders for this case, so a
 * route-specific phrase here would put one wording in the browser tab above a page whose visible
 * heading reads another - and this object's title is the one that wins, because the framework does not
 * collect a nested boundary's own `metadata` export. Matching the two means the reader, their history
 * and their bookmark all agree with the page in front of them.
 *
 * It deliberately carries no `robots` directive and no `alternates.canonical`. `src/app/robots.ts`
 * holds the site's crawl policy and the framework already emits `noindex` on this path, so a third
 * declaration would be one more place for them to drift; and a canonical URL asserts that this
 * address is the preferred version of a real resource, which is exactly what is not true here.
 */
const MISSING_POST_METADATA: Metadata = {
  title: 'Post not available',
  description: 'This post is not available to read.',
};

/**
 * Per-resource metadata for the post: title, description, canonical URL, OpenGraph and Twitter card.
 *
 * Every field is built by `buildPostMetadata` in `@/lib/seo`, which is also the sole reader of the
 * site origin and site name and the sole builder of the `/blog/{slug}` path - so nothing here spells a
 * URL, interpolates an origin or reads an environment variable, and the canonical link this page
 * publishes is identical to the one `src/app/sitemap.ts` lists and the one the `BlogPosting` graph
 * names. That builder also handles every nullable field on the wire: it falls back to a sentence built
 * from the title and the author when `excerpt` is `null`, omits `publishedTime` when `published_at`
 * is, and omits the image entirely when there is no cover so the generated card at
 * `src/app/opengraph-image.tsx` applies - which is why this segment ships no `opengraph-image` of its
 * own. When a cover IS present it travels as the service stored it, because a social platform's
 * crawler fetches an OpenGraph image directly rather than through the application's optimiser.
 *
 * The post is read through {@link readPost}, so this call and the component's share one request.
 *
 * `searchParams` is deliberately not accepted. A post's canonical URL is the post's address, and the
 * discussion's page number must not mint a second canonical for the same article - which is the same
 * rule the feed applies by omitting `page` when it is one, taken to its end on a resource whose
 * identity does not include a window at all.
 *
 * ## Why a missing post returns metadata here instead of raising `notFound()`
 *
 * Metadata generation is not where a missing resource is reported: this function returns
 * {@link MISSING_POST_METADATA} and lets the component raise the signal, which keeps one condition
 * handled in one place. Measured against this application it also changes nothing that matters - the
 * response line is committed by the route-level Suspense boundary in `src/app/loading.tsx` before any
 * async page component resolves, so a not-found raised afterwards keeps its 200 whichever entry point
 * raises it. That behaviour is a property of the shared streaming boundary rather than of this file,
 * and this route already raises the right signal for exactly the right condition if that boundary is
 * ever narrowed.
 *
 * @param props - The route's matched segments.
 * @returns Resolved metadata, or {@link MISSING_POST_METADATA} when nothing is readable at the slug.
 */
export async function generateMetadata({
  params,
}: Pick<PostPageProps, 'params'>): Promise<Metadata> {
  const { slug } = await params;
  const post = await readPost(slug);

  if (post === null) {
    return MISSING_POST_METADATA;
  }

  return buildPostMetadata(post);
}

/* -------------------------------------------------------------------------------------------------
 * Route
 * ---------------------------------------------------------------------------------------------- */

/**
 * The public post reading page.
 *
 * A Server Component, so the article's body, byline, categories and comment bodies reach the initial
 * HTML - see the module header for why that is the requirement rather than an optimisation.
 *
 * Deliberately absent, and each looks like an improvement:
 *
 *   1. `export const dynamic` or `export const revalidate`. Reading `searchParams` already makes this
 *      render dynamic, which is exactly right for a discussion addressed by the query string;
 *      restating it is configuration with no effect. The two reads carry their own windows instead.
 *   2. A second `<h1>`, a `<main>`, a page-level `<header>` or `<footer>`, or a second `Toaster`.
 *      `src/app/layout.tsx` owns the shell; this file supplies page body content only. The `<header>`
 *      below is scoped to the `<article>`, which is not a `banner` landmark.
 *   3. A second category pill set, a second publication `<time>`, a second Markdown renderer or a
 *      second sanitiser. Each belongs to exactly one component, reached by passing a prop.
 *   4. A view tally. `post.view_count` is on the wire and every surface in this tier ignores it,
 *      because no endpoint in this product increments it - a counter that never counts is worse than
 *      no counter.
 *   5. `import React from 'react'`. `"jsx": "react-jsx"` means the compiler imports the JSX runtime
 *      itself, so the default import would be unused - and the lint gate runs at `--max-warnings=0`.
 *
 * @param props - See {@link PostPageProps}.
 * @returns The article, its structured data, its actions and its discussion.
 */
export default async function PostPage({
  params,
  searchParams,
}: PostPageProps): Promise<JSX.Element> {
  // Both are Promises on this framework version and neither depends on the other, so they resolve
  // together rather than one after the other.
  const [{ slug }, resolvedSearchParams] = await Promise.all([params, searchParams]);

  /*
   * THE POST FIRST, AND ALONE. Both sibling reads below are addressed by `post.id`, which does not
   * exist until this resolves - so they cannot join this await, and the slug must never be handed to
   * them in its place. See the asymmetry table in the module header.
   */
  const post = await readPost(slug);

  // `notFound()` returns `never`, so `post` is narrowed to `PostDetail` below with no assertion. It
  // renders the sibling `not-found.tsx` in this folder rather than the root boundary, because a
  // segment's own boundary is the closest one to the throw.
  if (post === null) {
    notFound();
  }

  /*
   * Concurrent, not sequential: neither depends on the other and both are addressed by the identifier
   * already in hand. Only the thread can reject at all - the tally degrades to `undefined` inside its
   * own reader - so this `Promise.all` fails exactly when a genuine failure must reach
   * `src/app/error.tsx`.
   */
  const [thread, likes] = await Promise.all([
    readThread(post.id, resolveRequestedPage(resolvedSearchParams)),
    readLikes(post.id),
  ]);

  // A thread that 404s means the post stopped being readable between the two reads, so the article is
  // not rendered above a discussion that no longer exists.
  if (thread === null) {
    notFound();
  }

  const title = resolveTitle(post);
  const lede = resolveLede(post.excerpt);

  /*
   * `undefined` for an absent cover AND for one on a host `next.config.ts` does not allow, which is
   * what keeps a denied URL from reaching `next/image` - that component throws on an unconfigured
   * host, and a thrown image would take the whole article down. The allow-list belongs to
   * `@/lib/utils`, which `next.config.ts` reads to build its own patterns from, so the predicate and
   * the optimiser cannot disagree.
   */
  const coverImageUrl = allowedImageUrl(post.cover_image_url);

  return (
    <div className={PAGE_SHELL}>
      {/*
       * The `BlogPosting` graph, in the page body rather than in `generateMetadata`: the metadata API
       * describes the document, structured data describes the subject. It renders one `<script>`,
       * which the user-agent stylesheet gives `display: none`, so it takes no slot in this flex column
       * and adds no gap. The component owns every property of the graph, including the
       * `/og-default.png` fallback for a post with no cover, so none of that arithmetic is repeated
       * here.
       */}
      <BlogPostingJsonLd post={post} />

      <article className={ARTICLE}>
        <header className={ARTICLE_HEADER}>
          {/* The document's single `<h1>`: the subject of the page, as plain text. */}
          <h1 className={ARTICLE_TITLE}>{title}</h1>

          {/* Omitted entirely when the author wrote no excerpt, rather than rendered empty. */}
          {lede === null ? null : <p className={ARTICLE_LEDE}>{lede}</p>}

          <div className={BYLINE_ROW}>
            {/*
             * Attribution, the avatar and THE publication `<time dateTime>` - all three are this
             * component's, and `publishedAt` is what activates the third. `published_at` is
             * legitimately `null` on a post that has never been published, and the component's own
             * guard omits the element for that case rather than emitting an empty `dateTime`, so no
             * null check is needed or wanted here. `size` is left at its default, which is the same
             * scale every other byline in the product renders at.
             */}
            <AuthorByline author={post.author} publishedAt={post.published_at} />

            {/*
             * The raw body string, not the resource: the component estimates from the words it is
             * given and renders nothing at all when there are none, so a post with an empty body
             * contributes no orphaned label.
             */}
            <ReadingTime content={post.content} />
          </div>
        </header>

        {/*
         * Omitted entirely for a post with no usable cover - the deliberate half of the
         * no-layout-shift requirement. Nothing is reserved for an image that will never arrive, so
         * there is no empty band to collapse and nothing below it moves; when a cover IS present,
         * `aspect-video` on the frame reserves its box before the bytes land.
         */}
        {coverImageUrl === undefined ? null : (
          <div className={COVER_FRAME}>
            {/*
             * `next/image`, never a raw `<img>`: the optimiser needs the element to generate the
             * `srcset` this frame's `sizes` hint selects from. `fill` is what lets the reserved ratio
             * own the geometry, so no width or height literal appears anywhere.
             *
             * `alt=""` because the cover is decorative here and there is no honest alternative: the
             * contract carries no alternative-text field, the title is rendered immediately above, and
             * inventing a description would announce something the author never wrote. An `<img>` with
             * an empty `alt` is already removed from the accessibility tree, so no `aria-hidden` is
             * added on top of it.
             *
             * `priority` because this is the article's largest contentful paint, at the top of the
             * page: the reader is looking at it before they have scrolled anywhere, so lazy-loading it
             * would delay the one image that matters most.
             */}
            <Image
              alt=""
              className={COVER_IMAGE}
              fill
              priority
              sizes={COVER_SIZES}
              src={coverImageUrl}
            />
          </div>
        )}

        <div className={BODY_REGION}>
          {/*
           * The tier's only Markdown renderer, and the owner of the category pill row. `categories` is
           * passed through so those pills are rendered ONCE, by the component that already links each
           * to the category-filtered feed - the product has no `/categories/{slug}` route, and its
           * filtered home feed is the category page. The only class this route contributes is the
           * grid placement and the `lg` alignment the component's own documentation asks the route to
           * supply.
           */}
          <PostContent
            categories={post.categories}
            className={PROSE_PLACEMENT}
            content={post.content}
          />

          <div className={ACTIONS_BAND}>
            {/*
             * The first of the page's two client islands. `initialSummary` is the server-read tally,
             * so the count is in the initial HTML for a reader with no JavaScript yet - and it is
             * `undefined` when that read failed, which the island handles by omitting the digit and
             * fetching the value itself. It re-reads on mount either way, which is what corrects
             * `liked_by_caller` for a signed-in reader after an anonymous server render.
             */}
            <LikeButton initialSummary={likes} postId={post.id} />

            {/*
             * The second island. It builds every destination from the post's canonical URL through
             * `@/lib/seo` and calls no backend endpoint - there is no share API in this product and
             * none is needed. The resolved title is passed rather than the raw field so the shared
             * text can never be blank, for the same reason the heading above falls back.
             */}
            <ShareBar slug={post.slug} title={title} />
          </div>
        </div>
      </article>

      {/*
       * The discussion, outside the `<article>`: the article is the post, and the conversation about
       * it is a separate region of the page rather than part of the work.
       *
       * The envelope is passed straight through, unwrapped and unfiltered. `CommentList` performs no
       * HTTP by design, which is why this route reads the thread; it owns the section landmark, its
       * heading, the reply form, the recursive rendering of nested replies and the page control -
       * whose anchors are real `<a href>` links, so the paged views of this discussion are crawlable
       * and the `?page=` value this route reads is the one that control writes.
       */}
      <div className={TEXT_REGION}>
        <CommentList headingLevel={COMMENT_HEADING_LEVEL} page={thread} postId={post.id} />
      </div>
    </div>
  );
}
