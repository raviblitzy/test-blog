/**
 * Typed wrapper over the **public** category namespace - the taxonomy the home feed filters by.
 *
 * Two reads, both public, and nothing else:
 *
 * | Function               | Request                  | Answer                                    |
 * | ---------------------- | ------------------------ | ----------------------------------------- |
 * | {@link listCategories} | `GET /categories`        | `CategoryPublic[]` - the whole taxonomy    |
 * | {@link getCategory}    | `GET /categories/{slug}` | one `CategoryPublic`                       |
 *
 * ## The collection answers with a bare array, and it is the only one in this API that does
 *
 * `GET /api/v1/categories` returns `list[CategoryPublic]` and takes no window. Every other
 * collection in this API returns the five-member page envelope; this one is the single documented
 * exception, it is exactly one route wide, and it is specified rather than improvised.
 *
 * The reason is what the list is *for*. It **is** the home page's filter control, and a windowed
 * control would offer some terms and silently hide every post filed exclusively under the rest - a
 * wrong answer rather than a partial one, and one no status code reports. A curated taxonomy is also
 * bounded by editorial effort rather than by reader input, so there is nothing here for a window to
 * protect against: the whole set is a row of chips and one request renders it.
 *
 * So there is no page walk here and no second "give me all of them" function: {@link listCategories}
 * returns the complete taxonomy in one round trip. Nor is there a windowed view of this relation
 * anywhere else - the administrative namespace carries the three category mutations and no listing
 * (AAP §0.6.2), so the management table renders this same array and cannot disagree with the filter
 * control about what a category is. A screen that wants to narrow it filters these few rows
 * client-side.
 *
 * The consumers are `src/app/page.tsx` (which resolves the term named by the feed's `category`
 * search parameter so `buildFeedMetadata` can title and describe the filtered view),
 * `src/components/blog/category-filter.tsx` (which renders every term with its published-post
 * tally) and `src/app/sitemap.ts` (which enumerates the category pages). All three run on the
 * server, which shapes two decisions below: there is no `'use client'` directive and no
 * browser-only global is touched, and neither read demands a credential.
 *
 * ## Why `post_count` makes this endpoint the right one
 *
 * `CategoryPublic` carries `description`, `post_count` and `created_at` on top of the slim
 * `id`/`name`/`slug` projection embedded in a post's own category list. `post_count` is the whole
 * reason the filter control reads from here: it lets each option show how many published posts sit
 * behind it without a second request per term. A category with no published posts is still
 * returned, with a tally of `0`, so the control shows an empty term rather than hiding it. Drafts
 * and archived posts are never counted, so each tally agrees exactly with the number of results the
 * feed returns to an anonymous reader for that filter.
 *
 * ## What this module deliberately does not contain
 *
 * - **No transport logic.** `@/lib/api/client` is the only module in this tier permitted to perform
 *   HTTP, and it owns the request primitive, header construction, cancellation, bearer attachment,
 *   rotation-on-unauthorised, status-code branching and error normalisation. This module contributes
 *   two path strings and two response types. A wrapper that reached for any of that, or that
 *   branched on a status, would have taken on work that belongs one layer down - and would have
 *   taken it on seven times over, once per wrapper.
 * - **No third-party HTTP package.** None is declared in the tier's manifest and none is needed.
 * - **No version prefix.** Paths passed from here are namespace-relative, and the client composes
 *   the version segment exactly once. It rejects a path that already carries the prefix rather than
 *   silently repairing it, so a caller cannot introduce a second convention.
 * - **No case folding of the slug.** See {@link getCategory}.
 * - **No mutation, and no import of the administrative request shapes.** See below.
 * - **No import from `providers/`, `hooks/`, `components/` or `app/`.** The dependency arrow points
 *   strictly outward: this module imports `@/lib/api/client` and `@/lib/types`, and nothing else.
 * - **No camel-case translation layer.** Wire field names stay as the service spells them -
 *   `post_count`, `created_at` - exactly as `@/lib/types` mirrors them. Re-spelling a field
 *   produces a type that compiles and a value that is `undefined`.
 * - **No barrel.** This folder has no `index.ts`; consumers import `@/lib/api/categories` directly.
 *
 * ## The whole write lifecycle is administrative, and is not reachable from here
 *
 * Creating, renaming and deleting a category are administrator-only operations, wrapped by
 * `admin.ts` beside this module. That is not a filing preference. The service's public category
 * router is included with no router-level dependency at all, precisely because both of its routes
 * are public reads; a mutating route added to it would inherit no authority gate and would become
 * an unauthenticated write path into the taxonomy every reader's filter is built from. There is no
 * such endpoint to call, so there is no such function here, and the administrative request shapes
 * are deliberately not imported - nothing is in scope for a body this module must never send.
 *
 * ## Governing standards
 *
 * `review_rules` reports that **no user-specified rules were provided** for this project, so nothing
 * here is invented to satisfy one and the absence is not treated as licence to lower the bar. The
 * binding constraints are the technical plan's own enterprise standards, four of which govern this
 * module:
 *
 * | Standard                       | How this module satisfies it                                                                  |
 * | ------------------------------ | --------------------------------------------------------------------------------------------- |
 * | Layered separation of concerns | Two delegating one-liners; no transport primitive, no status branching, no inward import       |
 * | Explicit API contracts         | Every return type is a declared type from `@/lib/types`; snake_case wire names preserved       |
 * | API versioning                 | Namespace-relative paths only; the version segment is composed by the client, never here       |
 * | Blocking quality gates         | Type-checks under `strict`, lints at zero warnings, explicit return type on every export       |
 *
 * @module
 */

import { apiGet, type PublicRequestOptions } from '@/lib/api/client';
import { arrayOf, categoryPublicSchema } from '@/lib/types';
import type { CategoryPublic } from '@/lib/types';
import { encodePathSegment } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Paths
 *
 * Namespace-relative and written once each. The collection path carries NO trailing slash, which is
 * a correctness detail rather than a stylistic one: the service registers the collection on the
 * empty path beneath its `/categories` prefix, so the canonical URL is unslashed. A trailing slash
 * answers a redirect with no body instead - an extra round trip on the endpoint every home-feed
 * render calls, and one a cross-origin caller may decline to replay at all.
 * ---------------------------------------------------------------------------------------------- */

/** The taxonomy collection. */
const CATEGORIES_PATH = '/categories';

/**
 * A single dot segment: `.` or `..` and nothing else.
 *
 * Rejected by {@link assertAddressableSlug}. `encodeURIComponent` leaves a dot untouched, and a URL
 * is normalised when it is parsed, so a slug of `..` would not produce a 404 from the category
 * route - it would silently address the namespace root and answer with something of an entirely
 * different shape than the one this module's signature promises.
 */
const DOT_SEGMENT_PATTERN = /^\.{1,2}$/;

/* -------------------------------------------------------------------------------------------------
 * Options
 * ---------------------------------------------------------------------------------------------- */

/**
 * Per-call controls available to both reads here: `cache`, `next` (framework revalidation),
 * `signal` (cancellation) and `timeoutMs`.
 *
 * **There is deliberately no credential member and no `query` member**, and each absence is part of
 * the contract rather than tidiness.
 *
 * No credential, because the service resolves no principal on either route: a bearer sent here
 * cannot change a byte of the answer, so both calls are dispatched `anonymous` and a held token
 * never travels to be ignored. {@link PublicRequestOptions} is what removes `anonymous`, `bearer`,
 * `allowRefresh` and `anonymousFallback` together - with anonymity forced, not one of them could do
 * anything.
 *
 * No `query`, because neither route accepts one. The collection takes no window at all (see the
 * module header) and the single read is addressed entirely by its path segment, so an arbitrary
 * query bag could only ever carry a parameter the service ignores - and a caller who believed in it
 * would be silently wrong. The searchable listing over this taxonomy is administrator-only and
 * lives in `@/lib/api/admin`.
 *
 * What remains is what a Server Component needs. `src/app/sitemap.ts` and `src/app/page.tsx` both
 * render on the server and both want to say how long the taxonomy may be held and which cache tag it
 * participates in; that is `cache` and `next`, passed straight through to the client untouched.
 */
export type CategoryRequestOptions = Omit<PublicRequestOptions, 'query'>;

/* -------------------------------------------------------------------------------------------------
 * Internal guards
 * ---------------------------------------------------------------------------------------------- */

/**
 * Reject a slug that cannot address a category, before a pointless request is issued.
 *
 * Two values are refused, and neither would fail usefully on its own. A blank or whitespace-only
 * slug composes a path ending in a separator, which addresses the collection rather than a member:
 * the answer would be an array where the caller's signature promises one object, and reading a
 * `name` from it yields `undefined` rather than an error. A single dot segment is refused for the
 * same reason by a different mechanism - see {@link DOT_SEGMENT_PATTERN}.
 *
 * This is a precondition check on an argument, not error mapping: no response is inspected and no
 * status is interpreted. It also does **not** normalise. Blankness is decided from a trimmed copy
 * while the caller's own value is what gets sent, so a slug carrying stray whitespace still reaches
 * the service verbatim and is answered with an honest 404 rather than being quietly repaired into a
 * different slug.
 *
 * The throw is raised from inside an `async` caller on purpose, so a caller observes a **rejected
 * promise** rather than a synchronous exception - see {@link getCategory}.
 *
 * @param slug - The candidate URL segment.
 * @returns The slug exactly as it was supplied.
 * @throws TypeError When the slug is blank, whitespace-only, or a single dot segment.
 */
function assertAddressableSlug(slug: string): string {
  const trimmed = slug.trim();
  if (trimmed === '' || DOT_SEGMENT_PATTERN.test(trimmed)) {
    throw new TypeError(
      'getCategory requires a non-blank category slug; received ' +
        `${JSON.stringify(slug)}. Read the slug from CategoryPublic.slug or from the feed's ` +
        '"category" search parameter.',
    );
  }
  return slug;
}

/* -------------------------------------------------------------------------------------------------
 * GET /categories - the whole taxonomy
 *
 * A bare `CategoryPublic[]`, never the page envelope, and never a page walk to reconstruct one. This
 * is the API's single sanctioned collection exception: the array IS the home page's filter control,
 * so windowing it would let the control hide the posts filed under whatever fell outside the window.
 * The module header records the reasoning in full. There is no windowed view of this relation
 * anywhere in the API: the administrative categories screen consumes this same array.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Fetch the **complete** taxonomy, each term carrying its published-post tally.
 *
 * Ascending by name, and a category with no published posts is present with a `post_count` of `0`
 * rather than omitted - the filter control is expected to show an empty term rather than hide it.
 *
 * **The whole set, in one request, with no window to get wrong.** There is no `page` parameter to
 * pass and no `pages` to follow: the service returns every category, so a filter control built from
 * this is complete by construction rather than by a caller remembering to iterate. That is the whole
 * point of the endpoint's shape - see the module header.
 *
 * Dispatched without a credential even when one is held. The service resolves no principal on this
 * route, so a bearer could not change the answer; withholding it keeps a token off the wire that
 * nothing would have read.
 *
 * @param options - Caching, revalidation and cancellation controls. Omit for the framework default.
 * Neither a `query` nor a credential member can be passed - see {@link CategoryRequestOptions}.
 * @returns Every category, ascending by name, with its published-post tally. An empty array when no
 * category has been created.
 * @throws `ApiError` from `@/lib/api/client` for every failure - a rejection from the service, an
 * unreachable service, a cancelled request, or a body that does not match the declared contract. A
 * partial taxonomy is never returned: either the array is complete or the call rejects.
 *
 * @example Render the filter control from the full taxonomy
 * ```tsx
 * const categories = await listCategories({ next: { revalidate: 300, tags: ['categories'] } });
 * return categories.map((category) => (
 *   <option key={category.id} value={category.slug}>
 *     {category.name} ({category.post_count})
 *   </option>
 * ));
 * ```
 */
export function listCategories(options?: CategoryRequestOptions): Promise<CategoryPublic[]> {
  // `anonymous` last, so it cannot be overridden - and `CategoryRequestOptions` gives a caller no
  // member with which to try. No `anonymousFallback` beside it: a request that never carried a
  // credential has no expiry to fall back from.
  return apiGet(CATEGORIES_PATH, arrayOf(categoryPublicSchema), {
    ...options,
    anonymous: true,
  });
}

/* -------------------------------------------------------------------------------------------------
 * GET /categories/{slug} - one term
 * ---------------------------------------------------------------------------------------------- */

/**
 * Fetch one category by its slug.
 *
 * Keyed on the **slug**, never on the identifier. The slug is what appears in a canonical link and
 * in the feed's `category` search parameter, it is derived once at creation and never re-derived,
 * and it is what makes a filtered feed URL shareable and crawlable. `CategoryPublic.id` exists for
 * a post's category assignment, not for addressing a category over HTTP.
 *
 * The segment is percent-encoded, so a slug carrying a separator or any other reserved character
 * stays inside its own path segment and cannot address a different route.
 *
 * **The slug is not folded to lower case here, and must not be.** The service's slug column is
 * case-insensitive, so `python` and `Python` resolve to the same row through the column's own unique
 * index. Lowering the value in this tier would duplicate a guarantee the database already gives, and
 * would silently diverge from it the moment that collation changed. A link that varies only in case
 * therefore keeps working without this module doing anything at all.
 *
 * **Declared `async` so that every failure - the argument guard included - arrives through one
 * channel.** A function whose signature promises a promise but that can also throw synchronously has
 * two error channels, and a caller who attached a rejection handler is not protected from the second
 * one. `async` collapses them: the guard below rejects rather than throws. That is also the channel
 * the client already uses for a malformed path, so both halves of this tier report an unusable
 * request the same way.
 *
 * @param slug - The category's URL-safe identifier, in whatever case it arrived.
 * @param options - Caching, revalidation and cancellation controls. Omit for the framework default.
 * @returns The category with its published-post tally attached, as a bare representation.
 * @throws TypeError As a rejection, when `slug` is blank, whitespace-only, or a single dot segment.
 * Raised before any request is issued.
 * @throws `ApiError` from `@/lib/api/client` for every transport failure, including a `404` whose
 * problem document reports that no category carries that slug.
 *
 * @example Title a filtered feed from the selected term
 * ```ts
 * const category = await getCategory(searchParams.category);
 * const metadata = buildFeedMetadata({ category: category.slug }, category);
 * ```
 */
export async function getCategory(
  slug: string,
  options?: CategoryRequestOptions,
): Promise<CategoryPublic> {
  // The domain check above answers with a hint the shared encoder cannot produce; the URL rules
  // are the encoder's, so there is one implementation of them for the whole tier.
  const segment = encodePathSegment(assertAddressableSlug(slug), {
    operation: 'getCategory',
    parameterName: 'slug',
    hint: 'Read the slug from CategoryPublic.slug or from the feed\'s "category" search parameter.',
  });
  // Withheld rather than transmitted: this route resolves no principal either, so a held bearer
  // would travel and be ignored. See `listCategories`.
  return await apiGet(`${CATEGORIES_PATH}/${segment}`, categoryPublicSchema, {
    ...options,
    anonymous: true,
  });
}
