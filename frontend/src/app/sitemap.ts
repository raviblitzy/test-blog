/**
 * The site's machine-readable discovery document, served as XML at `/sitemap.xml`.
 *
 * Next.js's `app/sitemap.ts` convention turns the array returned below into a `urlset` document at
 * the site root. That convention *is* the mechanism - there is no generator package, no build step
 * and nothing to configure - which is why `next-sitemap` is excluded from the dependency set rather
 * than merely unused. Its sibling `src/app/robots.ts` advertises this exact URL through
 * `sitemapUrl()`, so the two halves of the discovery story are declared once each and point at each
 * other.
 *
 * ## What it publishes: four URL families, and no fifth
 *
 * | Family          | URL                 | Source                                            |
 * | --------------- | ------------------- | ------------------------------------------------- |
 * | Home feed       | `/`                 | `feedPath()`                                      |
 * | Published posts | `/blog/{slug}`      | `listPosts`, walked to the end                    |
 * | Category feeds  | `/?category={slug}` | `listCategories`, terms with published posts      |
 * | Author profiles | `/u/{username}`     | the distinct authors of the posts already fetched |
 *
 * **A category has no route of its own, and inventing one is the single most likely defect in this
 * file.** There is no `/categories/{slug}` page anywhere in the application: a category's page is
 * the category-filtered home feed, which is why {@link categoryFeedPath} is what composes these
 * entries and why the feed's query state lives in the URL at all - so that a filtered result set is
 * linkable, shareable and, here, crawlable. A `/categories/{slug}` entry would advertise a URL that
 * answers `404`, and `src/app/robots.ts` records the same rule from the other side.
 *
 * **Author profiles are derived, not fetched.** The API publishes no listing of users at all - the
 * public profile route resolves one username at a time and the administrative listing is
 * administrator-only - so the author set is collected from the `author.username` of the posts
 * already in hand. That needs no extra request and yields precisely the right set: every author
 * with at least one published post, and nobody else.
 *
 * ## What it deliberately withholds
 *
 * `/dashboard`, `/posts/new`, `/posts/{id}/edit` and every `/admin/**` path are the two protected
 * route groups. They are guarded by `src/middleware.ts`, disallowed by `src/app/robots.ts` through
 * the shared {@link CRAWL_DISALLOWED_PATHS} set, and absent here - listing one would advertise a
 * URL the same deployment asks crawlers not to follow. That agreement is *enforced* rather than
 * trusted: every entry is filtered against the same shared set on the way out, so the two files
 * cannot drift into contradiction. See {@link isCrawlable}.
 *
 * `/login` and `/signup` are withheld for a different reason and it is worth stating, because their
 * absence from the disallow set makes it look like an oversight. They are public and perfectly
 * crawlable; they simply are not content. A credential form has nothing to rank for, so advertising
 * it spends crawl budget that belongs to the articles. Not disallowing them and not advertising
 * them are consistent positions: a robots policy says what must not be fetched, a sitemap says what
 * is worth fetching first, and neither is the complement of the other.
 *
 * ## Governing standards
 *
 * `review_rules` reports **no user-specified rules** for this project. Nothing below is invented to
 * satisfy one, and their absence is not licence to lower the bar: the binding constraints are the
 * technical plan's own enterprise standards. Six govern this module.
 *
 *   - **Layered separation of concerns.** No `fetch`. Every byte of network I/O goes through
 *     `@/lib/api/*`, whose client module is the one place in the tier permitted to issue a request,
 *     so there is no URL assembly, no header, no status-code branch and no retry policy here. This
 *     module asks two wrappers for records and turns them into URLs.
 *   - **Configuration from the environment only.** This file reads **no** environment variable -
 *     not even `NEXT_PUBLIC_SITE_URL`. `@/lib/seo` is the tier's sole reader of the site-identity
 *     keys and owns the one expression where an origin and a path are joined, so every URL below
 *     arrives already normalised and no origin is hard-coded or concatenated here.
 *   - **Uniform pagination contract.** The feed's page envelope is read by its five documented
 *     snake_case members. The walk is driven by the `pages` the service returns rather than by an
 *     assumption that one request suffices, because the service validates the window it was asked
 *     for and answers with the window it applied.
 *   - **Explicit API contracts.** The taxonomy endpoint answers with a bare `CategoryPublic[]` -
 *     the API's one sanctioned exception to the page envelope - and is consumed as an array. The
 *     return value is annotated `MetadataRoute.Sitemap` rather than inferred, so a field the
 *     framework does not accept is a compile error here instead of a malformed document a crawler
 *     discovers.
 *   - **Day-one observability.** A failed read is reported once to the server console with enough
 *     context to act on, and never retried in a loop.
 *   - **Blocking quality gates.** Compiles under `tsc --noEmit` with the strict options in
 *     `frontend/tsconfig.json` and lints at `--max-warnings=0`.
 *
 * Design-system compliance is vacuous here and the exemption is reasoned rather than overlooked:
 * this module renders no markup, imports no component, references no design token and declares no
 * CSS value, so the token, primitive and breakpoint rules have nothing to bind to. There is no JSX
 * in this file and consequently no React import - the project compiles with the automatic runtime.
 *
 * ## Why this route revalidates instead of being frozen at build time
 *
 * {@link revalidate} makes the document regenerate at most once an hour. Two concrete reasons, and
 * neither is a preference:
 *
 *   1. **The frontend image is built without a guaranteed backend.** `docker-compose.yml` builds
 *      this tier as its own service, so a read issued during that build can legitimately fail. A
 *      frozen document would bake that failure in permanently.
 *   2. **A blog's published set changes after deployment.** Every publish, unpublish and new
 *      category would otherwise be invisible to a crawler until the next release.
 *
 * The same window is passed to each read, so the data cache and the route agree rather than
 * expiring against each other. One consequence is worth knowing before it is mistaken for a bug: a
 * **rebuild** inside that window replays the cached reads rather than re-issuing them, because the
 * framework's fetch cache lives in `.next/cache` and survives a build. Observed directly - posts
 * added to the database between two builds did not appear until `.next/cache/fetch-cache` was
 * cleared. That is correct behaviour rather than staleness to engineer around: the route
 * revalidates on its own hour, so a deployment self-corrects, and a container image built from a
 * clean tree has no cache to replay in the first place. Clearing that directory is the way to force
 * a fresh document while developing.
 *
 * ## Failure is soft, except where it must not be
 *
 * A sitemap route that answers `500` teaches a crawler to stop asking. So a failed or partial read
 * degrades: whatever was gathered is published and the home feed is always published, which is the
 * floor. The two reads are gathered independently, so a taxonomy outage costs the category entries
 * and nothing else, and a failure part-way through the page walk keeps the pages already walked.
 *
 * A missing or malformed `NEXT_PUBLIC_SITE_URL` is the deliberate exception. It is not an outage,
 * it is a misconfiguration, and there is no correct document to emit without an origin - a
 * substituted one would publish a sitemap of URLs for a host nobody chose, silently, because the
 * result is still well-formed XML. `@/lib/seo` throws, this module lets it, and the failure is loud
 * while someone can still fix it. `src/app/robots.ts` takes the same position for the same reason.
 *
 * @module
 */

import type { MetadataRoute } from 'next';

import { listCategories } from '@/lib/api/categories';
import { listPosts } from '@/lib/api/posts';
import {
  absoluteUrl,
  categoryFeedPath,
  CRAWL_DISALLOWED_PATHS,
  feedPath,
  FIRST_FEED_PAGE,
  type PostMetadataSource,
  postPath,
  profilePath,
} from '@/lib/seo';
import type { CategoryPublic } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Route segment configuration
 * ---------------------------------------------------------------------------------------------- */

/**
 * Seconds before the generated document is regenerated: one hour.
 *
 * Exported as the framework's route-segment option, so it governs the route itself rather than only
 * the reads inside it. An hour is chosen against two failure modes at once - short enough that a
 * newly published post is discoverable the same working session, long enough that a crawler
 * refetching the document cannot turn it into load on the feed endpoint. See the module header for
 * why a build-time-frozen document is the wrong default here.
 */
export const revalidate = 3600;

/* -------------------------------------------------------------------------------------------------
 * Read parameters
 *
 * The numbers that bound the page walk. All three are named because each encodes a decision about a
 * service contract rather than a taste, and a bare literal in the loop would hide which.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Window size requested from the feed: the largest the service accepts.
 *
 * `page_size` is **validated, not clamped** - the service refuses anything outside 1..100 with its
 * uniform problem document naming the parameter - so this is a contract value and not an
 * optimisation to raise later. Asking for the maximum is what keeps a sitemap of a few hundred
 * posts to a handful of round trips.
 */
const FEED_WINDOW = 100;

/**
 * Hard ceiling on how many feed requests one generation may issue.
 *
 * At {@link FEED_WINDOW} this admits 20 000 posts, which is far beyond what this product will hold
 * and still a bounded amount of work. The bound exists because the alternative is an unbounded loop
 * inside a route handler: a service that echoed a constant `pages`, or a paging bug on either side,
 * would turn one crawler request into an indefinite run of requests against this deployment's own
 * API. A cap converts that from an outage into a truncated document.
 */
const MAX_FEED_REQUESTS = 200;

/**
 * Framework revalidation controls handed to both reads.
 *
 * The same window as {@link revalidate}, so the data cache and the route expire together instead of
 * one holding a stale answer the other has already discarded. No cache tag accompanies it: nothing
 * in this tier calls `revalidateTag`, and a tag no code invalidates is configuration that only
 * looks like a mechanism.
 */
const READ_REVALIDATION = { revalidate } as const;

/* -------------------------------------------------------------------------------------------------
 * Crawl hints
 *
 * `changeFrequency` and `priority` are advisory - a crawler is free to ignore both - but they are
 * deliberately NOT uniform across the four families, because a document that claims every URL is
 * equally important and equally volatile has said nothing at all.
 * ---------------------------------------------------------------------------------------------- */

/** One entry of the document the framework serialises, named so its members can be indexed. */
type SitemapEntry = MetadataRoute.Sitemap[number];

/**
 * The framework's closed set of `changeFrequency` values, derived from its own type rather than
 * restated. A restated union would be a second declaration of a vocabulary this module does not
 * own, and would silently stop matching if the framework ever changed it. `NonNullable` strips the
 * `undefined` that comes with the member being optional, so the four constants below are typed as
 * the union itself and a misspelling is a compile error at its declaration rather than at its use.
 */
type ChangeFrequency = NonNullable<SitemapEntry['changeFrequency']>;

/** The feed: the most volatile URL on the site, since every publication changes it. */
const HOME_PRIORITY = 1;

/** An article: the reason the site exists, and stable once published. */
const POST_PRIORITY = 0.8;

/** A filtered feed: useful for discovery, subordinate to the articles it lists. */
const CATEGORY_PRIORITY = 0.5;

/** A profile: a listing of work published elsewhere on the site, so lowest of the four. */
const PROFILE_PRIORITY = 0.4;

/** The feed changes whenever anything is published - the most often anything here changes. */
const HOME_CHANGE_FREQUENCY: ChangeFrequency = 'daily';

/**
 * An article is edited rarely once it is published - the slug never changes and the body usually
 * does not either - so claiming anything more frequent would be a claim a crawler can measure
 * against `lastModified` and discount.
 */
const POST_CHANGE_FREQUENCY: ChangeFrequency = 'monthly';

/** A filtered feed changes when a post is filed under its term. */
const CATEGORY_CHANGE_FREQUENCY: ChangeFrequency = 'weekly';

/** A profile changes when its author publishes. */
const PROFILE_CHANGE_FREQUENCY: ChangeFrequency = 'weekly';

/* -------------------------------------------------------------------------------------------------
 * Instants
 *
 * Every timestamp on the wire is an ISO-8601 **string** - `JSON.parse` produces no `Date`, and the
 * contract types declare them as strings for exactly that reason - while `lastModified` wants a
 * `Date` or a string. This module converts, and converts consistently: every entry below carries a
 * `Date` or carries nothing.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Turn a nullable wire instant into a `Date`, or into nothing.
 *
 * Three states collapse to `undefined`, and the conversion is deliberate rather than incidental:
 *
 *   - **`null`.** `published_at` is legitimately null on a post that has never been published, so
 *     this is a contract state and not a defensive guard. `new Date(null)` would silently yield the
 *     Unix epoch, publishing 1970 as a post's last modification.
 *   - **Blank.** Same failure by a different route: `new Date('')` is an invalid date, and so is
 *     `new Date(' ')`, but neither announces itself.
 *   - **Unparseable.** An invalid `Date` handed to the framework serialises to nothing useful and
 *     would corrupt the `<lastmod>` element it lands in. Omitting the element entirely is valid
 *     sitemap XML; a malformed one is not.
 *
 * @param value - An ISO-8601 instant from the API, or `null`/`undefined` when the field is absent.
 * @returns The instant, or `undefined` when there is no usable one.
 */
function toInstant(value: string | null | undefined): Date | undefined {
  if (value === null || value === undefined || value.trim() === '') {
    return undefined;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * The later of two optional instants.
 *
 * Used to fold a set of posts down to one "most recently touched" instant per author, per category
 * and for the feed as a whole. Either side may be absent, and absence loses to any real instant.
 */
function laterOf(left: Date | undefined, right: Date | undefined): Date | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return right.getTime() > left.getTime() ? right : left;
}

/**
 * The instant a post was last meaningfully changed.
 *
 * The preference order is `updated_at`, then `published_at`, then `created_at`, and each step is
 * load-bearing:
 *
 *   - **`updated_at` is the correct answer and is not on the wire here.** It is declared on the
 *     detail projection only, and the summary decoder in `@/lib/types` strips what it was not told
 *     about, so a post read from the feed carries no modification instant at runtime *or* in its
 *     type. {@link PostMetadataSource} - the same intersection `@/lib/seo` uses to accept either
 *     projection - is what lets this express the preference without asserting the field exists. If
 *     the feed's projection ever widens to include it, this begins using it with no edit.
 *   - **`published_at` is the honest substitute.** A database check constraint guarantees it is
 *     present whenever the status is `PUBLISHED`, and the feed answers published posts only, so
 *     this is the branch that actually fires today.
 *   - **`created_at` is the floor.** Non-nullable on the contract, so the chain always has an
 *     answer for a well-formed record, which is why a post entry practically always carries a
 *     `<lastmod>`.
 */
function postInstant(post: PostMetadataSource): Date | undefined {
  return toInstant(post.updated_at) ?? toInstant(post.published_at) ?? toInstant(post.created_at);
}

/* -------------------------------------------------------------------------------------------------
 * Reporting
 *
 * Every message below is emitted at most once per generation. That is the whole policy: a crawler
 * may request this document repeatedly, so a per-record or per-retry line would turn one backend
 * outage into a log flood that buries the one line an operator needed.
 * ---------------------------------------------------------------------------------------------- */

/** Prefix on every line, so a log search finds this route's output and only this route's. */
const LOG_PREFIX = '[sitemap]';

/**
 * Describe a caught value without assuming it is an `Error`.
 *
 * `catch` binds `unknown`, and while `@/lib/api/*` rejects exclusively with its own normalised
 * error type, that type is declared by the client module - which is not a dependency of this file
 * and must not become one, since importing it would put a transport type in a document generator.
 * Narrowing on `Error` covers it structurally: the normalised error extends `Error`, so its name
 * and message are reached without naming the class.
 *
 * A non-`Error` throw is reported as such rather than coerced. Stringifying an arbitrary value is
 * how a log line becomes `[object Object]`, which is strictly less informative than saying so.
 */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  return typeof cause === 'string' ? cause : 'a value that is not an Error was thrown';
}

/**
 * Report a read that failed, once, with what it cost and when it will be retried.
 *
 * Deliberately `console.error` rather than a thrown rejection: the document is still published, so
 * this is the only signal that it was published incomplete. Equally deliberately, nothing here
 * retries - the route's own revalidation window is the retry, and a loop inside a document a
 * crawler is fetching would amplify an outage rather than ride it out.
 */
function reportReadFailure(subject: string, cause: unknown): void {
  console.error(
    `${LOG_PREFIX} Could not read ${subject}, so the sitemap is published without those entries. ` +
      `It is rebuilt on the next revalidation, at most ${String(revalidate)} seconds from now. ` +
      `Cause: ${describeCause(cause)}`,
  );
}

/* -------------------------------------------------------------------------------------------------
 * Reads
 *
 * Two, gathered independently. Neither helper can reject: each catches its own failure, reports it
 * once and answers with whatever it has. That is what makes the exported function below free of
 * transport error handling, and it is why a taxonomy outage costs the category entries alone rather
 * than the whole document.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every published post, by walking the feed to its end.
 *
 * **The walk is driven by the envelope, not by an assumption.** One request is not enough and
 * cannot be made enough: {@link FEED_WINDOW} is the largest window the service accepts, so any
 * deployment with more posts than that has more pages, and the only reliable statement of how many
 * is the `pages` the service itself returns. Four independent conditions end the walk, in the order
 * the loop tests them, and each guards a different way it could fail to:
 *
 *   1. **The page came back empty.** `pages` is `ceil(total / page_size)` and is `0` for an empty
 *      collection, so a site with no published posts exits here on the first request - and so does
 *      a request that ran off the end, which the service answers with an empty list rather than an
 *      error.
 *   2. **The served page did not advance.** The service echoes `page` back verbatim and never
 *      clamps it, so this cannot happen against a correct service - which is exactly why it is
 *      worth checking. A service that clamped, or an arithmetic slip on either side, would
 *      otherwise re-request one page for ever.
 *   3. **`pages` is not a sane integer.** A `NaN`, a fraction or an unsafely large count is not a
 *      page count to trust, so the walk stops with what it has instead of following it.
 *   4. **The last page was served** - the served `page` has reached `pages`. The ordinary exit.
 *
 * {@link MAX_FEED_REQUESTS} bounds the loop underneath all four, so no combination of them can
 * leave it running.
 *
 * Two things this function pointedly does **not** do. It sends no lifecycle parameter: the public
 * feed is published-only for every caller and that scoping is enforced server-side, so a draft
 * cannot reach this list. And it filters nothing on the way back, because a second definition of
 * draft confidentiality in the presentation tier is how one eventually disagrees with the service.
 *
 * `anonymous: true` is set for the same reason from the other direction: this document describes
 * what an unauthenticated crawler can see, so it is generated from an unauthenticated read. On a
 * server there is no credential store to draw from in any case - the client module's is
 * browser-only by construction - so this states the intent rather than changing today's behaviour.
 *
 * @returns Every published post the walk reached. Complete on success; a prefix of the feed when a
 * request failed part-way through, which is strictly better than nothing.
 */
async function collectPublishedPosts(): Promise<PostMetadataSource[]> {
  const collected: PostMetadataSource[] = [];

  // The page about to be asked for, and the highest page the service has actually served. The
  // second starts one below the first so that the first response's `page` counts as an advance.
  let requestedPage = FIRST_FEED_PAGE;
  let servedPage = FIRST_FEED_PAGE - 1;

  try {
    for (let request = 0; request < MAX_FEED_REQUESTS; request += 1) {
      // Sequential by necessity, not by oversight: which page to ask for next is knowable only from
      // the answer to this one, so there is nothing here to parallelise.
      const envelope = await listPosts(
        { page: requestedPage, page_size: FEED_WINDOW },
        { anonymous: true, next: READ_REVALIDATION },
      );

      collected.push(...envelope.items);

      if (envelope.items.length === 0) {
        return collected;
      }

      if (!Number.isSafeInteger(envelope.page) || envelope.page <= servedPage) {
        return collected;
      }
      servedPage = envelope.page;

      if (!Number.isSafeInteger(envelope.pages) || servedPage >= envelope.pages) {
        return collected;
      }

      requestedPage = servedPage + 1;
    }

    // Falling out of the loop means the request cap was reached with pages still unread. The
    // document is valid but truncated, which is worth saying out loud - a sitemap that quietly
    // stops listing articles past a certain point is a hard defect to notice from the outside.
    console.error(
      `${LOG_PREFIX} Stopped walking the feed after ${String(MAX_FEED_REQUESTS)} requests with ` +
        `${String(collected.length)} posts collected and more pages remaining. The sitemap is ` +
        `truncated. Raise MAX_FEED_REQUESTS in src/app/sitemap.ts if the catalogue is genuinely ` +
        `this large, or investigate the feed's pagination if it is not.`,
    );
  } catch (error) {
    reportReadFailure(`the published-post feed at page ${String(requestedPage)}`, error);
  }

  return collected;
}

/**
 * The complete category taxonomy.
 *
 * One request and no walk: this endpoint is the API's single sanctioned exception to the page
 * envelope and answers with a bare array, deliberately, because the same array is the home page's
 * filter control and a window there could hide the posts filed under whatever fell outside it. So
 * there is no `items` member to read and no `pages` to follow, and reaching for either would be a
 * type error rather than a subtle bug.
 *
 * @returns Every category, or an empty array when the taxonomy could not be read.
 */
async function collectCategories(): Promise<CategoryPublic[]> {
  try {
    return await listCategories({ next: READ_REVALIDATION });
  } catch (error) {
    reportReadFailure('the category taxonomy', error);
    return [];
  }
}

/* -------------------------------------------------------------------------------------------------
 * Deriving the profile and category facets from the posts already in hand
 *
 * No second request is issued for either. The API publishes no listing of users at all - the public
 * profile route resolves one username and the administrative listing is administrator-only - so the
 * author set has to come from the posts, and it happens to be the exactly-right set when it does:
 * authors with at least one published post. Category recency comes from the same pass because a
 * filtered feed's last modification simply *is* the newest post in it.
 * ---------------------------------------------------------------------------------------------- */

/** One author with at least one published post, and the instant of their most recent one. */
interface AuthorFacet {
  /**
   * The handle exactly as the API spelled it.
   *
   * Usernames are `citext` UNIQUE in PostgreSQL, so `/u/Alice` and `/u/alice` address one account
   * and the service's own projection is the canonical spelling. Re-casing it here would publish a
   * canonical URL that disagrees with every internal link pointing at the same profile.
   */
  readonly username: string;
  /**
   * Most recent {@link postInstant} across this author's posts, or `undefined` if none is usable.
   *
   * The one mutable member on either accumulator: the fold widens it as further posts by the same
   * author are met, and it is cheaper and clearer than replacing the whole entry in the map.
   */
  lastModified: Date | undefined;
}

/** Everything the entry builders need from one pass over the collected posts. */
interface FeedFacets {
  /** Most recent instant across every post, which is what the feed's own `lastModified` is. */
  readonly newest: Date | undefined;
  /** Distinct authors, ordered by first appearance in the feed - so newest-publishing first. */
  readonly authors: readonly AuthorFacet[];
  /** Most recent post instant per category, keyed by case-folded slug. */
  readonly newestByCategory: ReadonlyMap<string, Date>;
}

/**
 * Fold the collected posts into the three facets the document needs.
 *
 * One pass rather than three, because each facet is a fold over the same list and the feed can hold
 * thousands of records.
 *
 * Both accumulators are keyed on a case-folded value, and the author's own spelling is carried in
 * the entry rather than reconstructed from the key. Slugs and usernames are `citext` in the
 * database, so two spellings can never denote two resources; folding the key is what guarantees
 * this cannot publish two URLs for one of them even if a projection ever varied its casing, and
 * keeping the spelling in the value is what stops the published URL being a lower-cased
 * approximation of the canonical one.
 */
function indexFeed(posts: readonly PostMetadataSource[]): FeedFacets {
  let newest: Date | undefined;
  const authors = new Map<string, AuthorFacet>();
  const newestByCategory = new Map<string, Date>();

  for (const post of posts) {
    const instant = postInstant(post);
    newest = laterOf(newest, instant);

    const authorKey = post.author.username.toLowerCase();
    const knownAuthor = authors.get(authorKey);
    if (knownAuthor === undefined) {
      authors.set(authorKey, { username: post.author.username, lastModified: instant });
    } else {
      knownAuthor.lastModified = laterOf(knownAuthor.lastModified, instant);
    }

    // A post carries its own categories, so this needs no join and no second read. Only a usable
    // instant is recorded: a category whose posts all carry unusable ones falls back to its own
    // creation instant at the call site rather than being given a fabricated one here.
    if (instant !== undefined) {
      for (const category of post.categories) {
        const categoryKey = category.slug.toLowerCase();
        const known = newestByCategory.get(categoryKey);
        if (known === undefined || instant.getTime() > known.getTime()) {
          newestByCategory.set(categoryKey, instant);
        }
      }
    }
  }

  return { newest, authors: [...authors.values()], newestByCategory };
}

/* -------------------------------------------------------------------------------------------------
 * Entry assembly
 *
 * Entries are drafted as ROOT-RELATIVE paths and only turned into absolute URLs at the very end.
 * That ordering is what keeps the two whole-document rules - the crawl-policy agreement and
 * de-duplication - to plain string work, and it means `absoluteUrl` is called exactly once per
 * published URL rather than once per candidate.
 * ---------------------------------------------------------------------------------------------- */

/** A candidate entry, still expressed as a path. */
interface DraftEntry {
  /** Root-relative path, always produced by a builder in `@/lib/seo` and never by concatenation. */
  readonly path: string;
  readonly lastModified: Date | undefined;
  readonly changeFrequency: ChangeFrequency;
  readonly priority: number;
}

/**
 * Build a path, or answer `undefined` when the record cannot be addressed.
 *
 * {@link postPath} and {@link profilePath} throw on a segment that cannot form a URL - blank,
 * whitespace-only, or a `.`/`..` that the URL grammar would resolve away - and that refusal is
 * correct: `/blog/` is a different route from a post's page, and `/blog/..` normalises to `/`, so a
 * crawler told either would record the wrong address for the record. The database constrains both
 * slugs and usernames so neither can occur, but the wire contract types them as plain strings, and
 * one malformed record must not cost the whole site its discovery document. So the throw is
 * contained per record and the record is dropped.
 *
 * Silent per record on purpose - the caller counts the drops and reports one line for all of them.
 */
function optionalPath(build: () => string): string | undefined {
  try {
    return build();
  } catch {
    return undefined;
  }
}

/**
 * Whether a path may be published, judged against the crawl policy this deployment actually serves.
 *
 * {@link CRAWL_DISALLOWED_PATHS} is the single declaration of the disallowed prefixes and
 * `src/app/robots.ts` renders that same set into `/robots.txt`, so importing it here makes the
 * agreement between the two documents mechanical instead of a comment two files apart. Advertising
 * a URL that the same deployment asks crawlers not to fetch is a self-contradicting pair, and the
 * failure is invisible from either file alone.
 *
 * A plain prefix test, matching how a crawler evaluates the directive: RFC 9309 makes a
 * `Disallow: /posts` line a prefix match, so it covers `/posts/new` and `/posts-archive` alike, and
 * a stricter segment-aware test here would call a URL publishable that a crawler would refuse to
 * fetch.
 *
 * No path this module builds can fail the test today - the four families are `/`, `/?category=...`,
 * `/blog/...` and `/u/...`, and none of them shares a prefix with `/admin`, `/dashboard` or
 * `/posts`. That is the point: the guard costs one comparison per entry and makes the property hold
 * for the next family somebody adds, rather than relying on them re-reading two files first.
 */
function isCrawlable(path: string): boolean {
  return !CRAWL_DISALLOWED_PATHS.some((prefix) => path.startsWith(prefix));
}

/**
 * Draft the four URL families in publication order: feed, articles, category feeds, profiles.
 *
 * The order is the document's order and is meaningful in one respect only - de-duplication keeps
 * the first occurrence of a path, so the feed's own entry, with the highest priority of the four,
 * wins against any later entry that resolved to bare `/`. In practice none can, since a category
 * entry always carries a query string; the ordering makes that independent of the fact.
 *
 * @param posts - Every published post the walk reached.
 * @param categories - The taxonomy, or an empty array when it could not be read.
 * @returns The drafts, and how many records were dropped as unaddressable.
 */
function draftEntries(
  posts: readonly PostMetadataSource[],
  categories: readonly CategoryPublic[],
): { readonly drafts: readonly DraftEntry[]; readonly dropped: number } {
  const facets = indexFeed(posts);
  const drafts: DraftEntry[] = [];
  let dropped = 0;

  // 1. The home feed. Drafted unconditionally and first: it is the one URL that exists whatever the
  //    API answered, which is what makes an outage produce a thin document rather than an empty
  //    one. Its instant is the newest post's, because that is when the feed last changed; with no
  //    posts to date from - an empty catalogue, or a failed read - the generation instant is the
  //    honest answer.
  drafts.push({
    path: feedPath(),
    lastModified: facets.newest ?? new Date(),
    changeFrequency: HOME_CHANGE_FREQUENCY,
    priority: HOME_PRIORITY,
  });

  // 2. Every published post, at `/blog/{slug}`. The slug is the canonical key - fixed at creation
  //    and constrained UNIQUE - which is exactly why it, and never the identifier the mutation
  //    routes use, is what a sitemap entry is built from.
  for (const post of posts) {
    const path = optionalPath(() => postPath(post.slug));
    if (path === undefined) {
      dropped += 1;
      continue;
    }

    drafts.push({
      path,
      lastModified: postInstant(post),
      changeFrequency: POST_CHANGE_FREQUENCY,
      priority: POST_PRIORITY,
    });
  }

  // 3. Category feeds, at `/?category={slug}`. Not `/categories/{slug}` - no such route is served.
  //    A term with no published posts is skipped: the API returns it with a count of zero so the
  //    filter control can show it, but its feed is an empty result set, and asking a crawler to
  //    spend a fetch on a page with nothing to index is what a priority hint exists to avoid.
  for (const category of categories) {
    if (category.post_count <= 0) {
      continue;
    }

    drafts.push({
      path: categoryFeedPath(category),
      lastModified:
        facets.newestByCategory.get(category.slug.toLowerCase()) ?? toInstant(category.created_at),
      changeFrequency: CATEGORY_CHANGE_FREQUENCY,
      priority: CATEGORY_PRIORITY,
    });
  }

  // 4. Author profiles, at `/u/{username}`, derived from the posts rather than fetched.
  for (const author of facets.authors) {
    const path = optionalPath(() => profilePath(author.username));
    if (path === undefined) {
      dropped += 1;
      continue;
    }

    drafts.push({
      path,
      lastModified: author.lastModified,
      changeFrequency: PROFILE_CHANGE_FREQUENCY,
      priority: PROFILE_PRIORITY,
    });
  }

  return { drafts, dropped };
}

/**
 * Generate the sitemap served at `/sitemap.xml`.
 *
 * Reads the feed and the taxonomy, drafts the four public URL families from them, then applies the
 * two whole-document rules - the crawl-policy agreement and de-duplication - before joining each
 * surviving path onto the configured origin.
 *
 * The two reads are issued together because they are independent, and each contains its own
 * failure, so this function has no transport error handling of its own and cannot answer `500`
 * because of one. The single failure it does propagate is a missing or malformed site origin, which
 * is a misconfiguration rather than an outage: see the module header for why that one must be loud.
 *
 * @returns The document, for the framework to serialise. Never empty - the home feed is always
 * present.
 * @throws Error when `NEXT_PUBLIC_SITE_URL` is unset or is not a bare absolute origin, raised by
 * `@/lib/seo` and deliberately not caught.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [posts, categories] = await Promise.all([collectPublishedPosts(), collectCategories()]);
  const { drafts, dropped } = draftEntries(posts, categories);

  if (dropped > 0) {
    console.error(
      `${LOG_PREFIX} Skipped ${String(dropped)} record(s) whose slug or username could not ` +
        `form a URL. Every other entry was published. A blank or relative value in either field ` +
        `means the record is not addressable, so the service's own data is where to look.`,
    );
  }

  const published = new Set<string>();
  const entries: MetadataRoute.Sitemap = [];

  for (const draft of drafts) {
    // Two rules, both whole-document rather than per-family, which is why they are applied here
    // rather than inside the builders above. Agreement with the crawl policy first, then
    // de-duplication: a repeated `<loc>` is not invalid XML, so nothing downstream would report it,
    // and a crawler reading one URL twice with two sets of hints has been told to distrust both.
    // Paths are compared, not URLs, and they are equivalent to compare because a single origin is
    // joined onto every one of them at the line below.
    if (!isCrawlable(draft.path) || published.has(draft.path)) {
      continue;
    }
    published.add(draft.path);

    entries.push({
      url: absoluteUrl(draft.path),
      lastModified: draft.lastModified,
      changeFrequency: draft.changeFrequency,
      priority: draft.priority,
    });
  }

  return entries;
}
