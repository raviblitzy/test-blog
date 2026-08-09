/**
 * Site identity, canonical URLs and page metadata for the presentation tier.
 *
 * This module is what makes "basic SEO" achievable: every canonical link, every OpenGraph and
 * Twitter card, the `metadataBase` the framework resolves relative URLs against, the sitemap's
 * absolute entries and the crawl policy all originate here and nowhere else. A route that
 * hand-writes `/blog/${slug}` or interpolates the site origin itself has stepped outside the one
 * place those values are correct, and the failure mode is silent: a canonical link pointing at the
 * wrong host or carrying a doubled slash is still a valid string, still renders, and is discovered
 * only when a crawler has already indexed the wrong URL.
 *
 * ## What it owns
 *
 * | Concern                      | Exported as                                                |
 * | ---------------------------- | ---------------------------------------------------------- |
 * | The two configuration values | resolveSiteOrigin, resolveSiteName                         |
 * | Origin joining, once         | absoluteUrl                                                |
 * | The public URL families      | postPath, profilePath, feedPath, categoryFeedPath          |
 * | Root document metadata       | buildRootMetadata                                          |
 * | Per-resource metadata        | buildFeedMetadata, buildPostMetadata, buildProfileMetadata |
 * | Discovery artifacts          | sitemapUrl, CRAWL_DISALLOWED_PATHS                         |
 *
 * Consumers, in the order a request touches them: `src/app/layout.tsx` (root metadata),
 * `src/app/page.tsx` (feed canonical), `src/app/blog/[slug]/page.tsx` and
 * `src/app/u/[username]/page.tsx` (their `generateMetadata` exports), `src/app/sitemap.ts`,
 * `src/app/robots.ts`, and `src/components/seo/json-ld.tsx` - which uses the URL builders below but
 * owns its own `BlogPosting` and `Person` documents.
 *
 * ## What it deliberately does not do
 *
 * - **No HTTP.** Nothing here fetches. `src/app/sitemap.ts` gets its posts, categories and authors
 *   through `@/lib/api/*`, and `@/lib/api/client` is the only module in the tier permitted to
 *   perform a request. This module turns records it is handed into URLs and metadata.
 * - **No structured data.** `BlogPosting` and `Person` belong to `src/components/seo/json-ld.tsx`.
 * - **No date formatting.** `@/lib/format` owns that. Instants are ISO-8601 strings on the wire and
 *   `publishedTime` / `modifiedTime` want exactly that, so they are passed through untouched.
 * - **No markup, no styles, no JSX, and no client-component directive.** It emits plain `Metadata`
 *   objects, and metadata is resolved on the server: marking this module client-only would break
 *   the `generateMetadata` exports that depend on it.
 * - **No second crawl policy.** {@link CRAWL_DISALLOWED_PATHS} is the whole of it. No builder
 *   emits a `robots` field, because a per-page directive would be a second place the policy is
 *   declared and the two would drift.
 * - **No default export and no barrel.** Consumers import named symbols from `@/lib/seo`.
 *
 * Its only intra-repository import is a type-only one from `@/lib/types`, so `@/lib/seo` sits one
 * level above the bottom of `@/lib`'s dependency graph and its arrow points only outward. No value
 * is imported at all, which means importing this module performs no work and has no side effect.
 *
 * ## Why nothing here is memoised, and why resolution is lazy
 *
 * `@/lib/utils` resolves its own public value eagerly into a module-level constant, because that
 * key has a documented default and reading it can never fail. Neither key below has a default:
 * both throw when absent. Resolving them at module scope would therefore throw during evaluation
 * of every module that transitively imports this one - including a client component that only
 * wanted {@link postPath} - and would turn one missing variable into an unrelated import error.
 * Resolution is a function call instead, so it fails at the point metadata is actually built.
 *
 * Nor is the resolved value cached. `new URL()` costs microseconds, a sitemap of any realistic size
 * pays it once per entry, and a cache would introduce an invalidation question with no upside while
 * making the module's behaviour depend on which call happened first.
 *
 * ## The stability guarantee these URLs rest on
 *
 * A canonical URL is only worth publishing if it never changes, and that property is owned by the
 * service, not by this file:
 *
 * - **Post and category slugs** are derived from the title or name by `backend/app/core/slug.py`
 *   at creation, de-duplicated on collision and constrained `citext` UNIQUE. They are fixed at
 *   creation and are not re-derived by a later edit - renaming a category deliberately keeps its
 *   slug - so a link already crawled keeps resolving.
 * - **Usernames** are `citext` UNIQUE too, so `/u/Alice` and `/u/alice` address one account. Emit
 *   the spelling the API returned rather than re-casing it: the service's own projection is the
 *   canonical form, and lower-casing it here would publish a canonical link whose case differs
 *   from every internal link pointing at it.
 *
 * ## Governing standards
 *
 * No user-specified rules were provided for this project, so the binding constraints are the
 * technical plan's own enterprise standards. Four govern this module:
 *
 * 1. **Configuration from the environment only.** Exactly two keys are read - the two documented
 *    in `.env.example` - and each is read in exactly one place. There is no hard-coded origin, no
 *    hostname literal, no placeholder fallback and no branch on the deployment stage.
 * 2. **No secrets in the repository.** Nothing here touches a backend variable. The `NEXT_PUBLIC_`
 *    prefix inlines a value into the client bundle, so reading a secret here would publish it.
 * 3. **Explicit API contracts.** Every resource this module describes arrives as a shape declared
 *    in `@/lib/types`. No inline structural type stands in for one.
 * 4. **Blocking quality gates.** This file compiles under `tsc --noEmit` with the strict options in
 *    `frontend/tsconfig.json` and lints at `--max-warnings=0`.
 *
 * @module
 */

import type { Metadata } from 'next';

import { encodePathSegment } from '@/lib/paths';
import { codePointLength, sliceByCodePoints } from '@/lib/text';
import type {
  CategoryPublic,
  CategorySummary,
  PostDetail,
  PostSort,
  PostSummary,
  UserPublic,
} from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Site configuration
 *
 * Two values, both public, both without a default. The pure normalisers are exported so the rules
 * they enforce can be exercised without touching the process environment; the two resolvers are the
 * only readers of the environment in this module.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Name of the environment variable carrying the canonical site origin.
 *
 * Used to build error messages only. It is never used to *index* `process.env`, and that
 * restriction is load-bearing rather than stylistic: the framework replaces the literal text
 * `process.env.NEXT_PUBLIC_SITE_URL` with the configured value at build time, and a dynamic
 * `process.env[key]` lookup is not a literal, so it survives into the client bundle unreplaced and
 * reads `undefined` in a browser. The static member expression in {@link resolveSiteOrigin} is
 * therefore the only permissible spelling.
 */
const SITE_ORIGIN_KEY = 'NEXT_PUBLIC_SITE_URL';

/** Name of the environment variable carrying the site name. See {@link SITE_ORIGIN_KEY}. */
const SITE_NAME_KEY = 'NEXT_PUBLIC_SITE_NAME';

/** Where an operator is pointed when either variable is missing or malformed. */
const CONFIG_CONTRACT = '.env.example';

/**
 * Collapse every run of whitespace to a single space and trim the ends.
 *
 * Applied to any text that reaches a `<title>` or a `<meta>` content attribute. A newline inside a
 * meta description is legal but pointless, and an author who pasted a hard-wrapped paragraph into
 * an excerpt should not get a ragged social card out of it.
 */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Reduce a nullable wire string to text worth emitting, or to `undefined`.
 *
 * This is the single guard behind the module's null-safety property. `excerpt`,
 * `cover_image_url`, `bio`, `avatar_url` and `published_at` are all legitimately `null` on the
 * wire, and template interpolation turns `null` into the four characters `null` - a meta
 * description reading "null" is worse than no meta description at all. Everything nullable is
 * funnelled through here, so the only two states downstream code sees are "usable text" and
 * "absent", and a whitespace-only value counts as absent.
 */
function nonEmptyText(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const text = collapseWhitespace(value);
  return text.length > 0 ? text : undefined;
}

/**
 * Validate and normalise the configured site origin, or throw explaining what to fix.
 *
 * Returns a bare origin with **no trailing slash**, which is the single normalisation point every
 * URL in this module is built from. The normalisation is not string surgery: a parsed `URL`'s
 * `origin` is defined by specification as scheme, host and non-default port only, so a configured
 * value that ends in a slash and the same value without one normalise to the identical string, and
 * the doubled-slash defect that a naive template interpolation produces cannot occur. It also
 * lower-cases the host and drops a default port, so two spellings of the same origin cannot yield
 * two canonical URLs.
 *
 * Four shapes are rejected, each because it would corrupt every derived URL rather than merely look
 * untidy:
 *
 * - **Absent or blank.** There is no fallback. A substituted origin publishes canonical links,
 *   sitemap entries and social cards pointing at a host nobody chose, and because the resulting
 *   strings are well-formed the mistake is invisible until a crawler has acted on it. A loud
 *   failure while the build is still running is strictly cheaper.
 * - **Not an absolute URL** - `example.com`, `not-a-url`, `/`. `metadataBase` requires an absolute
 *   base, and a relative one produces a broken base rather than an error.
 * - **Not `http:` or `https:`.** No other scheme is addressable by a crawler.
 * - **Carrying credentials, a path, a query or a fragment.** This is an origin, not a URL. A
 *   deployment mounted under a sub-path configures the framework's own `basePath` option, which
 *   leaves this value the origin it is documented to be; putting the prefix here instead would
 *   double it into every path built below. A lone trailing slash is not a path and is accepted.
 *
 * Exported as a pure function - it reads nothing - so the rules above are directly testable.
 *
 * @param raw - The configured value, exactly as read from the environment.
 * @returns The origin, without a trailing slash.
 * @throws Error naming {@link SITE_ORIGIN_KEY} and the contract file, for every rejected shape.
 */
export function normaliseSiteOrigin(raw: string | undefined): string {
  const candidate = (raw ?? '').trim();

  if (candidate.length === 0) {
    throw new Error(
      `${SITE_ORIGIN_KEY} is not set. The canonical site origin has no default and cannot be ` +
        `inferred: every canonical link, sitemap entry and social card is built by joining a ` +
        `path onto it, so a substituted origin would publish URLs for a host nobody chose. Set ` +
        `it to an absolute origin; ${CONFIG_CONTRACT} documents the value.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(
      `${SITE_ORIGIN_KEY} is not an absolute URL (received ` +
        `${JSON.stringify(candidate)}). It must carry a scheme: a value without one cannot ` +
        `serve as the metadata base. See ${CONFIG_CONTRACT}.`,
    );
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(
      `${SITE_ORIGIN_KEY} must use the http or https scheme (received ` +
        `${JSON.stringify(parsed.protocol)}). No other scheme is reachable by a crawler. See ` +
        `${CONFIG_CONTRACT}.`,
    );
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error(
      `${SITE_ORIGIN_KEY} must not embed credentials. It is published in every canonical link ` +
        `and social card on the site. See ${CONFIG_CONTRACT}.`,
    );
  }

  if (parsed.pathname !== '/' || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error(
      `${SITE_ORIGIN_KEY} must be a bare origin - scheme, host and optional port only - but ` +
        `${JSON.stringify(candidate)} carries a path, query or fragment. A trailing slash alone ` +
        `is fine and is removed. A deployment served from a sub-path sets the framework's ` +
        `basePath option and leaves this value the origin. See ${CONFIG_CONTRACT}.`,
    );
  }

  return parsed.origin;
}

/**
 * Validate and normalise the configured site name, or throw explaining what to fix.
 *
 * Absence is an error for the same reason the origin's is: the name brands the title template and
 * every social card, and a placeholder would ship to readers. Quoting is not handled here because
 * it is already handled - the value is quoted in {@link CONFIG_CONTRACT} only because it contains a
 * space, and every loader that reads that file strips the quotes.
 *
 * @param raw - The configured value, exactly as read from the environment.
 * @returns The name, with surrounding and internal whitespace normalised.
 * @throws Error naming {@link SITE_NAME_KEY} when the value is absent or blank.
 */
export function normaliseSiteName(raw: string | undefined): string {
  const name = nonEmptyText(raw);

  if (name === undefined) {
    throw new Error(
      `${SITE_NAME_KEY} is not set. The site name has no default: it brands the document title ` +
        `template and every social card, so a placeholder would be published to readers. See ` +
        `${CONFIG_CONTRACT}.`,
    );
  }

  return name;
}

/**
 * The canonical site origin, without a trailing slash.
 *
 * The only reader of `NEXT_PUBLIC_SITE_URL` in this module, and the only place the value is
 * normalised. See {@link SITE_ORIGIN_KEY} for why the static member expression below cannot be
 * replaced by a dynamic lookup, and {@link normaliseSiteOrigin} for what is rejected.
 *
 * @throws Error when the variable is absent or is not a bare absolute origin.
 */
export function resolveSiteOrigin(): string {
  return normaliseSiteOrigin(process.env.NEXT_PUBLIC_SITE_URL);
}

/**
 * The site name, as the title template and the social cards render it.
 *
 * The only reader of `NEXT_PUBLIC_SITE_NAME` in this module.
 *
 * @throws Error when the variable is absent or blank.
 */
export function resolveSiteName(): string {
  return normaliseSiteName(process.env.NEXT_PUBLIC_SITE_NAME);
}

/* -------------------------------------------------------------------------------------------------
 * URL construction
 *
 * One joiner and four path builders. Every URL the tier publishes is one of these composed with
 * `absoluteUrl`, so there is exactly one expression in the codebase where the origin and a path
 * meet.
 * ---------------------------------------------------------------------------------------------- */

/** The home feed's path. Also the site root, which is why it has no segment of its own. */
const FEED_PATH = '/';

/** Path segment prefix for a post's reading page: `/blog/{slug}`. */
const POST_PATH_PREFIX = '/blog';

/** Path segment prefix for a public author profile: `/u/{username}`. */
const PROFILE_PATH_PREFIX = '/u';

/**
 * The framework's file-convention sitemap route. `src/app/sitemap.ts` is served here, and nothing
 * configures it - the convention is the mechanism, which is why no sitemap package is a dependency.
 */
const SITEMAP_PATH = '/sitemap.xml';

/** Matches a value that already carries a scheme, for example `https:` or `mailto:`. */
const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+\-.]*:/i;

/**
 * Give an already-trimmed path exactly one leading slash.
 *
 * Idempotent across the leading slash: `'/blog/x'` and `'blog/x'` both yield `'/blog/x'`, so two
 * consumers cannot produce two canonical URLs for one resource by disagreeing about it. An empty
 * path is the site root.
 *
 * It does not need to collapse a repeated leading slash, because {@link absoluteUrl} - its only
 * caller - rejects a protocol-relative input outright rather than reinterpreting it. That is the
 * deliberate division: a value beginning `//` is ambiguous enough to be a caller mistake worth
 * reporting, not a spelling to silently repair.
 */
function toRootRelative(path: string): string {
  if (path.length === 0) {
    return FEED_PATH;
  }

  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Encode a single path segment, rejecting the values that cannot be one.
 *
 * Slugs and usernames are URL-safe by construction - the service derives slugs through its slug
 * deriver and constrains usernames on registration - so encoding is a no-op for every legitimate
 * value. It is applied anyway because the cost is nothing and the failure it prevents is severe: a
 * segment containing a slash or a question mark would silently restructure the canonical URL into a
 * different route, and a canonical link is precisely the wrong place to discover that.
 *
 * Three refusals, applied by `@/lib/paths` so this module and the seven request-path composers under
 * `@/lib/api` share one rule rather than seven approximations of it:
 *
 * - An empty segment is a caller defect rather than a value to encode - `/blog/` is a different route
 *   from `/blog/{slug}` and would be published as the canonical URL of a post that has none.
 * - `.` and `..` are refused even though they need no escaping, which is exactly the problem:
 *   `encodeURIComponent` returns them unchanged and the URL grammar then resolves them, so a slug of
 *   `..` publishes `/blog/..` - normalising to `/` - as a post's canonical URL. A crawler would take
 *   that at its word and record the home page as the address of every such post.
 * - The padding on a value is discarded here rather than sent, which is the one place in the tier
 *   where `'trim'` is the right policy. A request path is a lookup, so `@/lib/api/*` sends a padded
 *   value verbatim and lets the service answer 404; a canonical URL is *published output*, and
 *   `/blog/%20my-post` is a URL a reader could copy and a crawler will index.
 */
function encodeSegment(value: string, label: string): string {
  return encodePathSegment(value, {
    operation: 'buildCanonicalPath',
    parameterName: label,
    whitespace: 'trim',
    hint:
      'The service generates one for every record and constrains it UNIQUE, so a blank or ' +
      'relative value means the record was not the one the caller believed it had.',
  });
}

/**
 * Join a root-relative path onto the canonical site origin.
 *
 * **The only place in the tier where the origin is concatenated with anything.** Sitemap entries,
 * `alternates.canonical`, `openGraph.url` and the absolute URLs `src/components/seo/json-ld.tsx`
 * needs all come through here, so the trailing-slash rule is enforced once rather than per call
 * site.
 *
 * @param path - A root-relative path, with or without its leading slash. Both spellings yield the
 * same URL; see {@link toRootRelative}.
 * @returns The absolute URL.
 * @throws Error when the site origin is unset or malformed, or when `path` already carries a scheme
 * or is protocol-relative. Handing an already-absolute URL to this function is a programming error,
 * and silently nesting one inside the origin would produce a plausible-looking URL that resolves
 * nowhere.
 */
export function absoluteUrl(path: string): string {
  const trimmed = path.trim();

  if (ABSOLUTE_URL_PATTERN.test(trimmed) || trimmed.startsWith('//')) {
    throw new Error(
      `absoluteUrl expects a root-relative path such as /blog/my-post, but received ` +
        `${JSON.stringify(path)}. The site origin comes from ${SITE_ORIGIN_KEY} and must not be ` +
        `repeated by the caller.`,
    );
  }

  return `${resolveSiteOrigin()}${toRootRelative(trimmed)}`;
}

/**
 * The reading path of a post: `/blog/{slug}`.
 *
 * Slug, not identifier. The mutation routes address a post by its UUID, but the public page and its
 * canonical URL are addressed by the slug, and the slug is the value that never changes.
 *
 * @param slug - {@link PostSummary.slug}, exactly as the API returned it.
 */
export function postPath(slug: string): string {
  return `${POST_PATH_PREFIX}/${encodeSegment(slug, 'post slug')}`;
}

/**
 * The public profile path of an author: `/u/{username}`.
 *
 * @param username - {@link UserPublic.username}, exactly as the API returned it. The service
 * matches it case-insensitively, so re-casing it here would only publish a canonical link that
 * disagrees with every internal link pointing at the same account.
 */
export function profilePath(username: string): string {
  return `${PROFILE_PATH_PREFIX}/${encodeSegment(username, 'author username')}`;
}

/**
 * The first page of the feed. A `page` parameter equal to this is omitted from a canonical URL.
 *
 * Pagination is 1-based across the whole API: `Page.page` is echoed back 1-based and is never
 * clamped.
 */
export const FIRST_FEED_PAGE = 1;

/**
 * The ordering the service applies when the `sort` parameter is absent. A `sort` equal to this is
 * omitted from a canonical URL, because `/` and `/?sort=recent` are the same result set and
 * publishing both would split one page's ranking signal across two URLs.
 */
export const DEFAULT_FEED_SORT: PostSort = 'recent';

/**
 * The feed's query state, as it appears in the URL.
 *
 * Every member is optional and nullable, because a caller is normally forwarding values it read
 * from `searchParams` - where an absent parameter is `undefined` - or from state where "no filter"
 * is naturally `null`. The two are treated identically: both mean the filter is not applied.
 */
export interface FeedCanonicalParams {
  /** Free-text search term. Whitespace-only counts as absent. */
  q?: string | null;
  /** {@link CategorySummary.slug} of the category filter, not its display name or identifier. */
  category?: string | null;
  /**
   * 1-based page number. {@link FIRST_FEED_PAGE}, and any value that is not a larger positive
   * integer, is omitted.
   */
  page?: number | null;
  /** Ordering. {@link DEFAULT_FEED_SORT} is omitted. */
  sort?: PostSort | null;
}

/**
 * The canonical path of a feed view: `/`, or `/` with only the parameters that actually narrow it.
 *
 * Two properties make this the canonicalisation of the feed rather than merely a URL formatter, and
 * both exist to stop one result set being published under several addresses:
 *
 * 1. **Defaults are omitted.** An unfiltered first page in the default ordering is bare `/` - never
 *    `/?page=1&sort=recent`. A blank search term, a blank category, {@link FIRST_FEED_PAGE} and
 *    {@link DEFAULT_FEED_SORT} each contribute nothing. A `page` that is not a positive integer
 *    beyond the first - `0`, `-3`, `1.5`, `NaN` - is not a distinct resource either, and collapses
 *    to the first page rather than being echoed into a canonical URL.
 * 2. **Parameter order is fixed** at `q`, `category`, `page`, `sort`, independent of the order the
 *    caller's object happens to enumerate. Two callers describing the same view therefore produce
 *    byte-identical canonical URLs, which is the whole point of the exercise.
 *
 * Values are escaped by `URLSearchParams`, so a search term containing an ampersand, a space or a
 * non-ASCII character produces one parameter rather than two.
 */
export function feedPath(params: FeedCanonicalParams = {}): string {
  const search = new URLSearchParams();

  const q = nonEmptyText(params.q);
  if (q !== undefined) {
    search.set('q', q);
  }

  const category = nonEmptyText(params.category);
  if (category !== undefined) {
    search.set('category', category);
  }

  const page = params.page ?? FIRST_FEED_PAGE;
  if (Number.isSafeInteger(page) && page > FIRST_FEED_PAGE) {
    search.set('page', String(page));
  }

  const sort = params.sort ?? DEFAULT_FEED_SORT;
  if (sort !== DEFAULT_FEED_SORT) {
    search.set('sort', sort);
  }

  const query = search.toString();
  return query.length > 0 ? `${FEED_PATH}?${query}` : FEED_PATH;
}

/**
 * The canonical path of a category's page.
 *
 * A category does not have a route of its own: its page *is* the category-filtered feed, which is
 * why this delegates to {@link feedPath} rather than inventing a `/categories/{slug}` URL the
 * application does not serve. It exists so that a category badge, the filter control and
 * `src/app/sitemap.ts` cannot disagree about how a category is addressed.
 *
 * Accepts the slim projection, so it works equally with a category read from
 * {@link PostSummary.categories} and with a full {@link CategoryPublic} from the taxonomy endpoint.
 */
export function categoryFeedPath(category: CategorySummary): string {
  return feedPath({ category: category.slug });
}

/**
 * The absolute URL of the generated sitemap, as `src/app/robots.ts` must advertise it.
 *
 * A `Sitemap:` directive in a robots policy has to be absolute - it is the one line in that file
 * that is not a path - which is why this is a URL rather than a path constant.
 */
export function sitemapUrl(): string {
  return absoluteUrl(SITEMAP_PATH);
}

/**
 * The URL prefixes no crawler should follow, consumed by `src/app/robots.ts`.
 *
 * **Three families, not two, and the count is the whole reason this list is declared here rather
 * than written out in the robots route.** The authenticated areas are two route *groups* in the
 * application - one for the author workspace and one for administration - but a route group's
 * parentheses never appear in a rendered URL, so the group boundary and the URL boundary are not
 * the same thing. The workspace group serves both `/dashboard` and the authoring screens at
 * `/posts/new` and `/posts/{id}/edit`, which makes `/posts` a third prefix. A policy that disallows
 * only `/dashboard` and `/admin` leaves every authoring screen crawlable while looking complete.
 *
 * This list is the mirror of `src/middleware.ts`'s matcher, which protects `/dashboard/:path*`,
 * `/posts/:path*` and `/admin/:path*`. The two are designed to agree; change them together.
 *
 * Equally deliberate is what is **absent**. `/blog` and `/u` are the public reading routes the
 * sitemap exists to advertise, and disallowing either would suppress exactly the content this
 * module's other half works to get indexed. The public post route is `/blog/{slug}`, which is why
 * disallowing `/posts` costs nothing a reader can see.
 *
 * No entry carries a trailing slash: a robots directive is a prefix match, and `/admin` covers the
 * section's own index page as well as everything beneath it, where `/admin/` would miss the index.
 * Frozen, because a shared policy that a consumer can mutate at run time is not a policy.
 */
export const CRAWL_DISALLOWED_PATHS: readonly string[] = Object.freeze([
  '/admin',
  '/dashboard',
  '/posts',
]);

/* -------------------------------------------------------------------------------------------------
 * Descriptions
 *
 * One length limit and one truncation rule, shared by every builder below, so no two surfaces
 * disagree about how long a description may be or what happens when it is longer.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The single documented limit on a `<meta name="description">` and its OpenGraph and Twitter
 * counterparts.
 *
 * 160 characters is the width beyond which a search result snippet is truncated for the reader
 * anyway, so text past it is invisible where it matters and merely inflates the document. The limit
 * is one number applied everywhere rather than a per-surface judgement, which is what stops a
 * post's card and a profile's card disagreeing.
 */
export const META_DESCRIPTION_MAX_LENGTH = 160;

/** Appended when text is clipped. One code point, so it costs one against the limit. */
const ELLIPSIS = '\u2026';

/**
 * Clip text to a character limit, at a word boundary.
 *
 * The one truncation rule in this module. Clipping prefers the last space before the limit so a
 * word is not cut in half, and trailing punctuation left dangling by the cut is removed so the
 * result does not read `... ,…`. Text already within the limit is returned with its whitespace
 * collapsed and nothing else changed, so no ellipsis is ever appended to text that was not
 * shortened.
 *
 * **The word boundary is used only when it keeps most of the available room**, and that condition
 * is the whole reason this is not a one-line slice. Text dominated by a single long token - a URL,
 * or a search term a reader pasted - puts the last space near the very start, and honouring it
 * there would throw away almost everything: a `Search: ` prefix followed by four hundred
 * characters would clip to the word `Search` and lose the term entirely. Such text is cut hard
 * instead, which keeps a truncated but informative string rather than a tidy but empty one.
 *
 * The returned string is always at most `limit` characters, ellipsis included.
 *
 * **Every measurement and every cut here is in code points, never in UTF-16 code units**, which is
 * what `String.prototype.length` and `String.prototype.slice` work in. The difference is invisible
 * for ASCII and produces broken published output the moment it is not: an emoji or a historic script
 * character occupies two code units, so a code-unit cut can land *between* its halves and leave the
 * string ending in an unpaired surrogate. That string is not well-formed UTF-8 when serialised, and
 * this is metadata - it goes into a `<meta name="description">`, an OpenGraph tag and a social card,
 * where a reader and a crawler both see the replacement character. Code points are also the unit the
 * service counts in, so a limit expressed here means the same thing it means there.
 */
function clip(value: string, limit: number): string {
  const text = collapseWhitespace(value);

  if (codePointLength(text) <= limit) {
    return text;
  }

  // `ELLIPSIS` is one code point (U+2026), measured rather than assumed so the arithmetic stays
  // right if the character ever changes.
  const room = limit - codePointLength(ELLIPSIS);
  const clipped = sliceByCodePoints(text, room);

  // A space is a BMP character, so an index found in `clipped` is already on a code-point boundary
  // and slicing there cannot split a pair. The "keeps most of the room" test measures the candidate
  // in code points too, so both sides of the comparison are in the same unit as `room` - a UTF-16
  // index would overstate the length of any text containing an astral character and would honour a
  // word boundary the rule is meant to reject.
  const lastSpace = clipped.lastIndexOf(' ');
  const atWordBoundary = clipped.slice(0, Math.max(lastSpace, 0));
  const body =
    lastSpace > 0 && codePointLength(atWordBoundary) >= Math.floor(room / 2)
      ? atWordBoundary
      : clipped;

  return `${body.replace(/[\s.,;:!?-]+$/, '')}${ELLIPSIS}`;
}

/**
 * Clip a description to {@link META_DESCRIPTION_MAX_LENGTH}.
 *
 * A post body or a long biography must never be emitted whole into a meta description: the crawler
 * discards the tail, and the bytes are paid on every page load.
 */
function truncateDescription(value: string): string {
  return clip(value, META_DESCRIPTION_MAX_LENGTH);
}

/**
 * The description the site presents when no resource supplies one of its own.
 *
 * Derived from the configured site name so that a deployment which renames itself does not have to
 * edit prose here, and run through {@link truncateDescription} because the name is configuration
 * and a long one would otherwise push the sentence past the limit.
 */
function defaultSiteDescription(siteName: string): string {
  return truncateDescription(
    `Articles, tutorials and commentary from the writers at ${siteName}. Search the archive, ` +
      `filter by category and follow the authors you read most.`,
  );
}

/* -------------------------------------------------------------------------------------------------
 * Metadata builders
 *
 * Four builders, one per surface that needs metadata of its own. Each returns a plain `Metadata`
 * object for the framework to resolve; none of them renders anything.
 *
 * Two conventions hold across all four, and both are deliberate:
 *
 * - **`alternates.canonical` is absolute.** The framework would resolve a relative one against
 *   `metadataBase`, but an absolute canonical is self-describing: it is correct when read in
 *   isolation, in a test, or in a page whose ancestor chain a reviewer has not traced.
 * - **`openGraph.title` is the resource's own title, unbranded**, while the document title goes
 *   through the root template and gains the site name. The card is not missing the brand - it
 *   carries `openGraph.siteName` - and repeating it inside the title would render the site name
 *   twice in the same preview.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The tier's one Twitter card type.
 *
 * A single card vocabulary is a decision, not an oversight. The fallback social image is the wide
 * card generated by `src/app/opengraph-image.tsx`, and mixing card types would leave that image
 * cropped on whichever surface declared the small one. An author's square avatar is centred by the
 * platform when it stands in for the wide card, which is the accepted cost of the consistency.
 */
const TWITTER_CARD = 'summary_large_image';

/** What separates a page's own heading from the site name in a document title. */
const TITLE_SEPARATOR = ' | ';

/**
 * Compose the branded document title a route should render.
 *
 * Declared once and used twice: the root metadata passes the framework's `%s` placeholder through
 * it to produce the title template, and {@link buildFeedMetadata} calls it directly. That is not
 * duplication avoided for tidiness - it is what guarantees the home feed's branded title is spelled
 * identically to the one the template produces for every other route, so the site's titles cannot
 * drift into two shapes.
 */
function brandedTitle(heading: string, siteName: string): string {
  return `${heading}${TITLE_SEPARATOR}${siteName}`;
}

/**
 * Root document metadata, for `src/app/layout.tsx` to export as its `metadata`.
 *
 * Three of its four responsibilities are inherited by every route in the application, which is what
 * makes this the only place they should be stated:
 *
 * - **`metadataBase` is a `URL` instance**, not a string. The framework requires an instance there,
 *   and it is what lets a child route hand it a relative OpenGraph image path and get an absolute
 *   URL in the rendered tag.
 * - **The title is a template**, so a route that supplies only its own title still renders a
 *   branded document title, and the site name is written once rather than in every route.
 * - **The default description and card** cover the routes that describe no resource - the
 *   authentication screens, the error and not-found boundaries - so none of them ships without a
 *   description.
 *
 * **It deliberately sets no `alternates.canonical`.** Metadata is inherited field by field, so a
 * canonical URL declared here would be adopted by every route that does not declare its own, and
 * each of them would then claim to be the home page - the exact duplicate-signal defect
 * canonicalisation exists to prevent. Every route that should be indexed declares its own canonical
 * through one of the builders below; a route that declares none simply has no canonical link, which
 * is the safe outcome rather than a wrong one.
 *
 * It also sets no `robots` field: the crawl policy is {@link CRAWL_DISALLOWED_PATHS}, served by
 * `src/app/robots.ts`, and declaring it in two places would let the two drift apart.
 *
 * @throws Error when either public configuration value is missing or malformed. This is intentional
 * and it happens while `next build` is running, before a single wrong canonical URL is published.
 */
export function buildRootMetadata(): Metadata {
  const origin = resolveSiteOrigin();
  const siteName = resolveSiteName();
  const description = defaultSiteDescription(siteName);

  return {
    metadataBase: new URL(origin),
    title: {
      default: siteName,
      // `%s` is the framework's placeholder for the child route's own title. Composed through the
      // same helper the feed uses, so both spellings of a branded title are one declaration.
      template: brandedTitle('%s', siteName),
    },
    description,
    openGraph: {
      type: 'website',
      title: siteName,
      description,
      siteName,
      url: origin,
    },
    twitter: {
      card: TWITTER_CARD,
      title: siteName,
      description,
    },
  };
}

/**
 * Metadata for a feed view, for `src/app/page.tsx` to return from its `generateMetadata`.
 *
 * Its substantive contribution is the canonical URL: the feed is the one route whose address varies
 * with its own query state, so it is the one route where a hand-written canonical would most easily
 * be wrong. {@link feedPath} decides which parameters are part of the resource's identity, and this
 * builder publishes exactly that.
 *
 * The optional second argument is the category the `category` slug refers to, when the caller has
 * already loaded the taxonomy for its filter control. Supplying it upgrades the page from the
 * site's default title and description to the category's own - a category's `description` field
 * exists precisely to be the description of its page. Omitting it is not a defect: the page keeps
 * the root title and the site description, which is correct, merely less specific. The slug alone
 * is deliberately not turned into a heading, because a slug is a URL token and reads like one.
 *
 * **It brands its own title, and has to.** A title template does not apply to the page in the same
 * route segment that declares it, and the home feed *is* that page - it sits beside the root layout
 * rather than beneath it. A bare heading here would therefore render unbranded while every other
 * route gained the site name, so the heading is composed through {@link brandedTitle} and handed
 * over in the framework's absolute form. Absolute rather than plain also keeps it correct if this
 * metadata is ever returned from a route that *does* sit under a template: it cannot be branded
 * twice. An unfiltered feed still supplies no title at all and inherits the root default, which is
 * already the site name.
 *
 * @param params - The query state, normally forwarded from the route's `searchParams`.
 * @param category - The category named by `params.category`, when it is to hand.
 * @throws Error when either public configuration value is missing or malformed.
 */
export function buildFeedMetadata(
  params: FeedCanonicalParams = {},
  category?: CategoryPublic | null,
): Metadata {
  const siteName = resolveSiteName();
  const canonical = absoluteUrl(feedPath(params));

  const searchTerm = nonEmptyText(params.q);
  const categoryName = nonEmptyText(category?.name);

  let heading: string | undefined;
  let description: string;

  if (searchTerm !== undefined) {
    // A search term is reader input of unbounded length, so the heading it produces is bounded by
    // the same single limit every other emitted string is, rather than by a second number.
    heading = clip(`Search: ${searchTerm}`, META_DESCRIPTION_MAX_LENGTH);
    description = truncateDescription(`Posts matching ${searchTerm} on ${siteName}.`);
  } else if (categoryName !== undefined) {
    heading = categoryName;
    description = truncateDescription(
      nonEmptyText(category?.description) ?? `Posts filed under ${categoryName} on ${siteName}.`,
    );
  } else {
    description = defaultSiteDescription(siteName);
  }

  return {
    ...(heading === undefined ? {} : { title: { absolute: brandedTitle(heading, siteName) } }),
    description,
    alternates: { canonical },
    openGraph: {
      type: 'website',
      title: heading ?? siteName,
      description,
      siteName,
      url: canonical,
    },
    twitter: {
      card: TWITTER_CARD,
      title: heading ?? siteName,
      description,
    },
  };
}

/**
 * A post as this module needs to see it: any post projection, plus its modification instant when
 * the caller happens to have one.
 *
 * `updated_at` is declared on {@link PostDetail} and not on {@link PostSummary}, so a builder typed
 * against the detail projection could not be handed a summary and one typed against the summary
 * could not read the field. Intersecting the summary with the optional half of the detail resolves
 * both without widening anything: a {@link PostDetail} satisfies it because `updated_at: string`
 * satisfies `updated_at?: string`, a {@link PostSummary} satisfies it because the member is
 * optional, and inside the builder the field reads as `string | undefined` and is emitted only when
 * it is genuinely present.
 */
export type PostMetadataSource = PostSummary & Partial<Pick<PostDetail, 'updated_at'>>;

/**
 * Metadata for a post's reading page, for `src/app/blog/[slug]/page.tsx` to return from its
 * `generateMetadata`.
 *
 * Every nullable field on the wire is handled rather than assumed:
 *
 * - **`excerpt` is `null`** whenever the author wrote none, so the description falls back to a
 *   sentence built from the title and the author's display name - both non-nullable on the
 * contract. The body is deliberately *not* mined for a substitute: it is Markdown, stripping it is
 * a rendering concern that belongs to the component that renders it, and a description cut out of a
 * first paragraph usually reads worse than one built from the title. Writing an excerpt is the
 * authoring fix.
 * - **`cover_image_url` is `null`** for a post with no cover, and the `images` field is then
 *   omitted *entirely* rather than set to an empty list or a hard-coded asset path. That omission
 *   is the mechanism: the framework only falls back to the card generated by
 *   `src/app/opengraph-image.tsx` when no image is declared, so declaring one - even a placeholder
 *   - would suppress the fallback this tier ships. When a cover is present it is emitted as the
 *   service stored it, since a social platform's crawler fetches an OpenGraph image directly and
 *   never through the application's image optimiser.
 * - **`published_at` is `null`** for a post that has never been published - a draft, which the
 *   author workspace does render - so `publishedTime` is omitted rather than emitted as `null`. The
 *   database's check constraint guarantees the instant is present whenever the status is
 *   `PUBLISHED`, so a published post always carries one.
 * - **`updated_at` is absent** on a summary projection, so `modifiedTime` is omitted rather than
 *   substituted from the creation or publication instant, which would assert a modification that
 *   never happened.
 *
 * `authors` carries the author's name together with the absolute URL of their profile, composed
 * from the same builders the page's own links use, so the document's author reference and its
 * visible byline cannot point at different places.
 *
 * @param post - The post, as {@link PostDetail} from the detail route or {@link PostSummary} from a
 * listing.
 * @throws Error when either public configuration value is missing or malformed, or when the post's
 * slug is blank.
 */
export function buildPostMetadata(post: PostMetadataSource): Metadata {
  const siteName = resolveSiteName();
  const canonical = absoluteUrl(postPath(post.slug));
  const title = collapseWhitespace(post.title);
  const authorName = collapseWhitespace(post.author.display_name);

  const description = truncateDescription(
    nonEmptyText(post.excerpt) ?? `${title} - an article by ${authorName} on ${siteName}.`,
  );

  const coverImageUrl = nonEmptyText(post.cover_image_url);
  const publishedTime = nonEmptyText(post.published_at);
  const modifiedTime = nonEmptyText(post.updated_at);

  return {
    title,
    description,
    authors: [{ name: authorName, url: absoluteUrl(profilePath(post.author.username)) }],
    alternates: { canonical },
    openGraph: {
      type: 'article',
      title,
      description,
      siteName,
      url: canonical,
      authors: [authorName],
      ...(publishedTime === undefined ? {} : { publishedTime }),
      ...(modifiedTime === undefined ? {} : { modifiedTime }),
      ...(coverImageUrl === undefined ? {} : { images: [{ url: coverImageUrl, alt: title }] }),
    },
    twitter: {
      card: TWITTER_CARD,
      title,
      description,
      ...(coverImageUrl === undefined ? {} : { images: [coverImageUrl] }),
    },
  };
}

/**
 * Metadata for a public author profile, for `src/app/u/[username]/page.tsx` to return from its
 * `generateMetadata`.
 *
 * `display_name` is non-nullable on the contract - the column is not nullable and registration
 * derives a name from the username when none was supplied - so the title never needs a fallback.
 * The two fields that are nullable do:
 *
 * - **`bio` is `null`** for an account that has written none, so the description falls back to a
 *   sentence naming the author and the site.
 * - **`avatar_url` is `null`** for an account with no avatar, and `images` is then omitted so the
 *   generated fallback card applies, exactly as on a post with no cover.
 *
 * `openGraph.type` is `profile`, and `username` is carried as the OpenGraph profile field it maps
 * to, which is the closest the vocabulary comes to describing a person's page. The richer `Person`
 * description belongs to `src/components/seo/json-ld.tsx`.
 *
 * @param user - The public projection of the account, as the profile route returned it.
 * @throws Error when either public configuration value is missing or malformed, or when the
 * username is blank.
 */
export function buildProfileMetadata(user: UserPublic): Metadata {
  const siteName = resolveSiteName();
  const canonical = absoluteUrl(profilePath(user.username));
  const displayName = collapseWhitespace(user.display_name);

  const description = truncateDescription(
    nonEmptyText(user.bio) ?? `${displayName} writes on ${siteName}.`,
  );

  const avatarUrl = nonEmptyText(user.avatar_url);

  return {
    title: displayName,
    description,
    alternates: { canonical },
    openGraph: {
      type: 'profile',
      username: user.username,
      title: displayName,
      description,
      siteName,
      url: canonical,
      ...(avatarUrl === undefined ? {} : { images: [{ url: avatarUrl, alt: displayName }] }),
    },
    twitter: {
      card: TWITTER_CARD,
      title: displayName,
      description,
      ...(avatarUrl === undefined ? {} : { images: [avatarUrl] }),
    },
  };
}
