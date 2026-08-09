/**
 * The typed wrapper over the `posts` namespace of the versioned REST surface.
 *
 * Seven functions, one per route the service declares, and nothing else. This is the transport
 * half of two product requirements: authoring - create, edit, delete, publish and unpublish - and
 * the home feed, whose free-text search, category filter, author filter, ordering and page window
 * are all parameters of the single list route below.
 *
 * ## What this module is, precisely
 *
 * A **path-and-type layer**. Each function names a route, states the shape that comes back, and
 * hands the call to `@/lib/api/client`. That module is the only place in this tier that performs
 * HTTP, so everything transport-shaped lives there and none of it is restated here: no `fetch`, no
 * header construction, no cancellation plumbing, no retry, no rotation, no status-code branch and
 * no error mapping. A wrapper that reaches for any of those has taken on work that belongs one
 * layer down, and the reason to care is concrete - a credential attached in two places is a
 * credential that can leak from either.
 *
 * The consequence worth stating plainly: **this module never inspects a failure.** Every rejection
 * arrives from the client module as a single normalised error type carrying the service's problem
 * document. A `403` from an ownership check and a `404` from a slug that does not exist both
 * propagate to the caller untouched. Swallowing either, or pre-empting it with a client-side
 * permission test, would move an authority decision out of the service that owns it.
 *
 * ## Layering
 *
 * The dependency arrow points strictly outward. This module imports the client and the contract
 * mirror, and imports nothing else: no package, no validator, no provider, no hook, no component
 * and no route segment. Caching, invalidation, mutation state and optimistic updates belong to the
 * hooks and providers layers, which sit *above* this one; a cache library imported here would
 * invert that and make a Server Component pull a client runtime it has no use for.
 *
 * There is no client directive on this module, deliberately. Four Server Components read through
 * it - the home feed, the post page, the author profile and the sitemap route - and each renders
 * its content into the initial HTML, which is what lets a crawler read an article without
 * executing any JavaScript. Nothing here touches a browser-only global, at module scope or inside
 * a function, so evaluating this module on the server is not a special case.
 *
 * ## Path convention
 *
 * Every path below is **namespace-relative**: `/posts`, not the version-prefixed form. The version
 * prefix is composed by the client module exactly once, and a path that arrives already carrying it
 * is rejected there loudly rather than repaired silently. So the literal `/posts` in this file is
 * the whole of this module's contribution to the URL.
 *
 * ## Wire names
 *
 * Field and parameter names are the service's own snake_case, exactly as the contract mirror
 * declares them - `page_size`, `cover_image_url`, `published_at`, `view_count`, `category_ids`.
 * There is no camel-case translation layer anywhere in this tier and none is introduced here.
 * Re-spelling a wire name produces a type that compiles and a value that is `undefined` at run
 * time, which is the most expensive mistake available in a module like this one.
 *
 * ## Relationship to what this replaces
 *
 * The repository this project grew from exposed five unversioned handlers over a process-local
 * list, keyed on a client-supplied integer, wrapping mutations in an ad-hoc `message`/`data`
 * envelope and repeating a bare not-found string at three call sites. None of that survives here
 * and none of it is shimmed: identity is server-generated, collections arrive in the one page
 * envelope, single resources arrive as bare representations, and every failure arrives as the one
 * problem document. The old surface had no consumer to keep working - its data never survived a
 * restart - so there is nothing to stay compatible with.
 *
 * ## Governing standards
 *
 * `review_rules` reports that **no user-specified rules were provided** for this project, so
 * nothing here is invented to satisfy one and the bar is not lowered in their absence. The binding
 * constraints are the technical plan's own enterprise standards, five of which govern this module:
 *
 * | Standard                         | How this module satisfies it                                                                                  |
 * | -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
 * | Layered separation of concerns   | Paths, parameters and return types only; no transport reasoning; imports the client and the mirror, nothing else |
 * | Explicit API contracts           | Every return type is a declared contract type; the page envelope is returned unmodified; wire names stay snake_case |
 * | API versioning                   | Namespace-relative paths; the version prefix is composed once, by the client module                            |
 * | Secure-by-default authentication | No client-side permission test; ownership and role are decided by the service and its refusal propagates intact |
 * | Blocking quality gates           | Compiles under `tsc --noEmit`, lints at `--max-warnings=0`, explicit return type on every exported function     |
 *
 * @module
 */

import {
  apiDeleteNoContent,
  apiGet,
  apiPatch,
  apiPost,
  type OptionalAuthRequestOptions,
  type ProtectedRequestOptions,
} from '@/lib/api/client';
import { encodePathSegment } from '@/lib/paths';
import { codePointLength } from '@/lib/text';
import { pageOf, postDetailSchema, postSummarySchema } from '@/lib/types';
import type { Page, PostCreate, PostDetail, PostSort, PostSummary, PostUpdate } from '@/lib/types';
import { MAX_SEARCH_TERM_LENGTH } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Paths
 * ---------------------------------------------------------------------------------------------- */

/**
 * The collection path, with no trailing slash.
 *
 * The service declares its collection at the empty relative path rather than at `/`, so the
 * composed address carries no trailing slash and this literal has to match that exactly. A trailing
 * slash here would address a route that does not exist.
 */
const POSTS_PATH = '/posts';

/* -------------------------------------------------------------------------------------------------
 * The path-key asymmetry - the one thing in this file that is easy to get wrong
 *
 * A post is addressed by TWO different keys depending on the operation, and they are not
 * interchangeable:
 *
 *   READ  by SLUG  ->  GET /posts/{slug}
 *   MUTATE by ID   ->  PATCH /posts/{id}, DELETE /posts/{id},
 *                      POST /posts/{id}/publish, POST /posts/{id}/unpublish
 *
 * The split is architectural rather than arbitrary. The slug is the canonical, stable, reader- and
 * crawler-facing key: it is derived from the title once at creation, de-duplicated on collision,
 * constrained unique, and deliberately NOT re-derived when the title is later edited - because a
 * canonical link, a sitemap entry and an already-shared URL all have to keep resolving. The
 * identifier is the internal server-generated UUID, and it is what every mutation, like and comment
 * route addresses.
 *
 * Both keys are `string`, so swapping them is not a type error. It is a `404` or a `422` at run
 * time, some distance from the call site that caused it. The two defences below are the whole of
 * the mitigation, and they are why the parameter names in this file are load-bearing:
 *
 *   1. Exactly one function takes a `slug`, and it is the read. Five take an `id`. No function
 *      accepts both, and none accepts an ambiguously named key.
 *   2. There is deliberately NO convenience function that mutates by slug. The service declares no
 *      such route, so adding one here would have to resolve the slug to an identifier first, which
 *      is a second request and a second source of truth for something the caller already holds -
 *      every post shape the service returns carries `id` and `slug` together.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Compose the path of a single post from the key that addresses it.
 *
 * The path *shape* is identical for the read and for every mutation; only the meaning of the key
 * differs, which is what the calling function's parameter name records. See the commentary above.
 *
 * The key is percent-encoded because it is interpolated into a path segment. For a UUID that is a
 * no-op, and for a slug it is very nearly one, since a slug is URL-safe by construction. It is done
 * regardless so that a value which is *not* what it claims to be - a caller that passes a raw
 * title, say - produces an honest `404` from the service rather than escaping its segment and
 * addressing some other route.
 *
 * @param pathKey - The post's slug for the read, or its server-generated identifier for a mutation.
 * @returns The namespace-relative path of that one post.
 */
function postResourcePath(pathKey: string, operation: string): string {
  // Through the tier's ONE encoder. `encodeURIComponent` alone leaves `.` and `..` intact, so
  // `getPost('..')` composed `/posts/../admin/users` - a SUCCESSFUL request against a route this
  // wrapper never named, rather than the 404 a caller would expect.
  return `${POSTS_PATH}/${encodePathSegment(pathKey, {
    operation,
    parameterName: operation === 'getPost' ? 'slug' : 'id',
    hint:
      operation === 'getPost'
        ? 'Read the slug from PostSummary.slug or from the blog route path segment.'
        : 'Pass the UUID the API emitted for the post.',
  })}`;
}

/* -------------------------------------------------------------------------------------------------
 * Per-call options
 * ---------------------------------------------------------------------------------------------- */

/**
 * The per-call transport controls the two **reads** in this module accept: the feed and one post.
 *
 * Both routes resolve an **optional** principal, which is why this is the caller-aware mode. A held
 * credential is attached by default and changes the answer - an author or an administrator
 * additionally sees drafts - and `anonymous` remains available for the genuine case of wanting the
 * public projection on purpose, such as previewing what a signed-out reader would see. `bearer`
 * remains too, because that is how a Server Component reads on behalf of one request: the credential
 * store is browser-only by construction, so a server render passes the token it resolved itself.
 *
 * `query` is removed, and the omission is the point. This namespace has exactly one route that takes
 * query parameters - the feed - and its six parameters are declared individually on
 * {@link ListPostsParams}. Withholding `query` makes "supplied the same filter twice, two different
 * ways" unrepresentable instead of merely discouraged, and it means no caller can smuggle a parameter
 * the service does not declare past the type system.
 *
 * `anonymousFallback` is absent because it is the wrapper's to set: a public read must not break for
 * a reader whose held credential expired in a background tab, and a caller has no information with
 * which to make that decision better.
 */
export type PostReadOptions = Omit<OptionalAuthRequestOptions, 'query'>;

/**
 * The per-call transport controls the five **mutations** in this module accept: create, update,
 * delete, publish and unpublish.
 *
 * Every one of them requires a credential and every one is ownership-scoped by the service, so
 * anonymity is not a mode they have - `anonymous` and `anonymousFallback` are therefore absent
 * rather than documented as mistakes. A request without a credential cannot succeed, and a request
 * replayed without one certainly cannot.
 *
 * `bearer` is retained for a server-side caller acting on behalf of one request, `allowRefresh` for
 * completeness, and `query` is removed for the reason given on {@link PostReadOptions} - none of
 * these five routes accepts a query parameter at all.
 */
export type PostMutationOptions = Omit<ProtectedRequestOptions, 'query'>;

/* -------------------------------------------------------------------------------------------------
 * Feed parameters
 * ---------------------------------------------------------------------------------------------- */

/**
 * The query parameters of the feed route - all six, each declared individually.
 *
 * Every member is optional and the whole object is optional, so `listPosts()` requests the default
 * feed: published posts, newest first. Each parameter narrows the result independently of the
 * others.
 *
 * **`undefined` and `null` both mean "not filtering by this".** The client module's query builder
 * treats `undefined`, `null` and the empty string alike as absent, which is what lets a caller hand
 * its entire filter state over - a blank search box, an unselected category, an unset page - and
 * still produce a clean `/posts` rather than a URL full of empty parameters. So nothing needs
 * pruning before it is passed, and nothing here defaults a parameter to `''` in order to send it.
 *
 * These four of the six are the feed's URL state on the home page, which is where they are held so
 * that any result set is linkable, shareable, crawlable and correct under browser back and forward
 * navigation: the search term, the category, the ordering and the page number. That is the caller's
 * concern rather than this module's - but it is why the six are separate named members instead of
 * one opaque bag, and why nothing here memoises or otherwise remembers a previous call.
 */
export interface ListPostsParams {
  /**
   * Free-text search term, matched against title, excerpt and body through the service's generated
   * search vector.
   *
   * **Passed through verbatim - deliberately untouched.** No trimming, lower-casing, tokenising or
   * quoting happens here, because the service parses the term with a full-text query parser that
   * understands its own operator syntax, and normalising it first would quietly strip an operator a
   * reader typed on purpose. A whitespace-only term is treated as absent server-side, so there is
   * nothing to pre-empt.
   */
  q?: string | null;
  /**
   * Category **slug** to filter by - the URL-safe key from the category list, not the display name
   * and not the identifier. Matched case-insensitively by the service.
   *
   * Passed through unchanged: resolving a slug to a category is the service's job, and doing it
   * here would mean a second request and a second place that decides what a category is. A slug
   * that matches no posts is not an error - it answers an empty page.
   */
  category?: string | null;
  /**
   * Author **username** to filter by, matched case-insensitively.
   *
   * A username that names no account answers `404`, which is deliberate: it makes a mistyped filter
   * distinguishable from an author who has genuinely published nothing.
   */
  author?: string | null;
  /**
   * Ordering. Typed as the closed two-member union rather than a bare string type, so a
   * misremembered ordering is a compile error here instead of a `422` from the service.
   *
   * `recent` is the service's default when the parameter is absent. `relevance` ranks against the
   * search term and is meaningful only alongside `q`; with no term it degrades to recency rather
   * than failing.
   */
  sort?: PostSort | null;
  /**
   * The 1-based page to return. Defaults to the first page server-side when absent.
   *
   * A page past the last one is **not** an error: the service echoes the requested page back beside
   * the real totals and an empty list, which is how a caller detects it has run off the end rather
   * than being silently redirected to a page it never asked for.
   */
  page?: number | null;
  /**
   * Window size, defaulting to 20 server-side when absent.
   *
   * The service **validates** rather than clamps: a value outside 1 to 100 is refused with the
   * uniform problem document naming the parameter. A page-size control should therefore keep its
   * options inside that range rather than relying on the service to trim them.
   */
  page_size?: number | null;
}

/* -------------------------------------------------------------------------------------------------
 * Reads - anonymous-capable
 *
 * Neither read requires a credential, and neither is merely tolerant of anonymity: an anonymous
 * caller is a first-class case that sees published posts. A credential, when one is held, is
 * attached by the client module and widens what the service returns - an author additionally sees
 * their own drafts, an administrator sees everything. That widening is entirely the service's
 * decision. Nothing here sends a lifecycle parameter and nothing here filters a result, because a
 * second definition of draft confidentiality is exactly how a draft eventually leaks.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Refuse a search term longer than the service accepts, before a request is spent on it.
 *
 * Mirrors the service's own bound rather than restating its policy: the number is
 * {@link MAX_SEARCH_TERM_LENGTH}, imported from the contract types, and the service publishes it as
 * `maxLength` on every `q` parameter. Absence and a blank term are left alone - the client module's
 * query builder drops them and the service treats a whitespace-only term as no filter - so this
 * checks exactly one thing.
 *
 * Thrown rather than truncated, and thrown rather than sent, because the service refuses an
 * over-long term with the uniform problem document: shortening it would answer a question the
 * caller did not ask, and sending it would spend a round trip to be told so.
 *
 * @param term - The caller's `q`, or `undefined`/`null` when no term was supplied.
 * @param caller - The exported function's name, so the message names the call the author wrote.
 * @throws {RangeError} When the term is longer than {@link MAX_SEARCH_TERM_LENGTH} characters.
 */
function assertSearchTermLength(term: string | null | undefined, caller: string): void {
  if (term === undefined || term === null) {
    return;
  }
  // Measured in CODE POINTS, through the tier's one length primitive, because that is the unit the
  // service counts: Pydantic's `max_length` is applied to Python's `len()`. JavaScript's
  // `String.length` counts UTF-16 code units, so a term containing any character above U+FFFF
  // measures nearly double there - and this guard would reject, before issuing a request, a query
  // the API would have accepted. All-ASCII text cannot show the difference, which is exactly why
  // the measurement is centralised rather than left to each call site.
  const length = codePointLength(term);
  if (length > MAX_SEARCH_TERM_LENGTH) {
    throw new RangeError(
      `${caller}: q must be at most ${String(MAX_SEARCH_TERM_LENGTH)} characters, received ` +
        `${String(length)}. The service refuses a longer term with 422 rather than ` +
        `truncating it, so cap the search input at that length instead of sending it.`,
    );
  }
}

/**
 * Read a page of the feed: `GET /posts`.
 *
 * The most requested route in the product, and the one place where search, category filtering,
 * author filtering, ordering and windowing compose. All five compose *server-side*, in a single
 * ranked query; this function's entire job is to forward the six parameters faithfully.
 *
 * The page envelope is returned **exactly as it arrives** - the same five members, unrenamed,
 * unwrapped and with nothing computed onto it. That uniformity is what lets one pagination
 * component drive the home feed, an author's profile listing and every administrative table, so
 * reshaping it here would break three consumers to save one line in a fourth.
 *
 * The elements are the summary projection, which carries **no body content**, deliberately: a feed
 * page returns up to a hundred posts and including the Markdown of each would multiply the payload
 * of the busiest endpoint in the product by the weight of an average article, for a card that shows
 * a title and an excerpt. Call {@link getPost} when the body will actually be rendered; a summary
 * cannot be turned into a detail without that request.
 *
 * @param params - The six feed parameters. Omit the argument entirely for the default feed.
 * @param options - Per-call transport controls. See {@link PostReadOptions}.
 * @returns The page of summaries, unmodified.
 * @throws The client module's normalised error - notably `404` when `author` names no account, and
 * `422` when `page` or `page_size` is out of range.
 *
 * @example The home feed, reading its state from the URL in a Server Component
 * ```tsx
 * const feed = await listPosts({ q, category, sort, page });
 * return (
 *   <>
 *     <PostList page={feed} />
 *     <Pagination {...feed} />
 *   </>
 * );
 * ```
 *
 * @example An author's own workspace, listing their drafts - authenticated, filtered to themselves
 * ```ts
 * const mine = await listPosts({ author: viewer.username, page_size: 50 });
 * ```
 */
export function listPosts(
  params: ListPostsParams = {},
  options?: PostReadOptions,
): Promise<Page<PostSummary>> {
  assertSearchTermLength(params.q, 'listPosts');

  return apiGet(POSTS_PATH, pageOf(postSummarySchema), {
    ...options,
    anonymousFallback: true,
    // Each of the six is forwarded raw. Blank members are dropped by the client module's query
    // builder, so an unfiltered request produces `/posts` rather than a string of empty parameters.
    query: {
      q: params.q,
      category: params.category,
      author: params.author,
      sort: params.sort,
      page: params.page,
      page_size: params.page_size,
    },
  });
}

/**
 * Read one post in full, addressed **by slug**: `GET /posts/{slug}`.
 *
 * This is the only function in this module keyed on the slug rather than on the identifier - see
 * the commentary on the path-key asymmetry above for why the read and the mutations disagree.
 *
 * Returns the detail projection: everything a summary carries, plus the Markdown body and the
 * last-modified instant.
 *
 * A post that is not published is readable here **only** by its author or an administrator; to any
 * other caller the slug simply does not exist and the service answers `404`. That is what keeps a
 * draft from leaking through a guessed URL, it is enforced server-side, and it is deliberately not
 * mirrored by a check in this tier.
 *
 * @param slug - The post's URL-safe slug - the key that appears in the canonical URL. **Not** its
 * identifier: passing one here answers `404`.
 * @param options - Per-call transport controls. See {@link PostReadOptions}.
 * @returns The full post.
 * @throws The client module's normalised error - `404` when no published post has that slug and the
 * caller is not entitled to see an unpublished one.
 *
 * @example A post route, rendering the article into the initial HTML
 * ```tsx
 * const post = await getPost(slug);
 * return <PostContent markdown={post.content} />;
 * ```
 */
export function getPost(slug: string, options?: PostReadOptions): Promise<PostDetail> {
  return apiGet(postResourcePath(slug, 'getPost'), postDetailSchema, {
    ...options,
    anonymousFallback: true,
  });
}

/* -------------------------------------------------------------------------------------------------
 * Mutations - bearer-authenticated, ownership-scoped by the service
 *
 * All five require a credential, which the client module attaches. Four of the five are additionally
 * ownership-scoped: an author may act on their own post, an administrator may act on any, and anyone
 * else is refused with a `403`.
 *
 * That refusal is the service's to make. There is no permission test in this module, and adding one
 * would be worse than redundant - it would create a second, divergable definition of an authority
 * rule that the service enforces regardless, and the two would eventually disagree. Hiding a control
 * in the interface is a courtesy to the reader; it is not a security boundary. So a `403` propagates
 * from here untouched, as a normalised error the caller can render.
 *
 * Each of the four keys on the post's server-generated identifier, never on its slug.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Create a post: `POST /posts`, answering `201` with the created resource.
 *
 * **The created post is always a draft.** There is no way to create a published post in one request,
 * and that is deliberate rather than an omission: publication is the transition that stamps the
 * publication instant the database requires, so it stays a distinct step - see {@link publishPost}.
 * Until then the post is absent from every public surface.
 *
 * The request shape carries `title`, `content` and, optionally, an excerpt, a cover image URL and the
 * identifiers of the categories to file the post under. It carries **no** identifier, slug,
 * lifecycle state, publication instant, view count or author reference, because every one of those
 * is owned by the service: identity and timestamps by the database, the slug by the deriver that
 * runs at creation, the author by the principal resolved from the credential, and the lifecycle by
 * the two transitions. The service rejects any property outside that set rather than ignoring it,
 * and sanitises the authored content on write.
 *
 * @param input - The new post. See the contract mirror's create shape for each field's meaning.
 * @param options - Per-call transport controls. See {@link PostMutationOptions}.
 * @returns The created post in full, including the identifier and slug the service generated - which
 * are what every subsequent call about this post needs, so neither has to be looked up afterwards.
 * @throws The client module's normalised error - `401` without a credential, `422` with per-field
 * detail when the body is rejected.
 *
 * @example Save a draft, then publish it as a separate, deliberate step
 * ```ts
 * const draft = await createPost({ title, content, category_ids: selected });
 * const live = await publishPost(draft.id);
 * ```
 */
export function createPost(input: PostCreate, options?: PostMutationOptions): Promise<PostDetail> {
  return apiPost(POSTS_PATH, postDetailSchema, input, options);
}

/**
 * Apply a partial update: `PATCH /posts/{id}`.
 *
 * **A genuine partial update, and the distinction is the reason this route exists.** The body is
 * forwarded exactly as the caller composed it, so a member the caller left out is left out on the
 * wire and the service leaves that field unchanged. Nothing here materialises an absent field as
 * `null` in order to "complete" the object - doing so would blank an excerpt or a cover image the
 * author never touched, which is precisely the failure mode of the whole-object replacement this
 * route supersedes, where every unspecified field was silently overwritten.
 *
 * Two consequences of that contract are worth stating because they are asymmetric:
 *
 * - For the excerpt and the cover image, an explicit `null` is meaningful and means *clear it*.
 *   Omission and `null` are therefore genuinely different instructions for those two fields, and the
 *   difference is preserved because this function does not rewrite the body.
 * - `category_ids` **replaces** the post's whole category set rather than adding to it, so send
 *   every category the post should end up with, or an empty array to file it under none.
 *
 * Editing the title does **not** re-derive the slug: the canonical URL is fixed at creation so that
 * an already-published link and an already-crawled page keep resolving.
 *
 * The lifecycle cannot be changed through this route. There is no state field on the update shape,
 * so publishing by patching is not merely discouraged - it is unrepresentable. Use
 * {@link publishPost} and {@link unpublishPost}.
 *
 * @param id - The post's **server-generated identifier**, not its slug.
 * @param changes - Only the fields that change. Forwarded unmodified.
 * @param options - Per-call transport controls. See {@link PostMutationOptions}.
 * @returns The updated post in full.
 * @throws The client module's normalised error - `401` without a credential, `403` when the caller
 * neither owns the post nor administers the site, `404` when no post has that identifier.
 *
 * @example Correct the title and clear the cover, leaving the body and categories untouched
 * ```ts
 * const updated = await updatePost(post.id, { title: 'A better title', cover_image_url: null });
 * ```
 */
export function updatePost(
  id: string,
  changes: PostUpdate,
  options?: PostMutationOptions,
): Promise<PostDetail> {
  // `changes` is handed over as it was received. Serialisation omits absent members, which is what
  // makes the update partial; rebuilding the object here is what would make it total.
  return apiPatch(postResourcePath(id, 'updatePost'), postDetailSchema, changes, options);
}

/**
 * Delete a post: `DELETE /posts/{id}`, answering `204 No Content`.
 *
 * Routed through the client module's no-content path, which never reads a body. That is not a
 * stylistic preference: parsing an empty response as JSON throws a syntax error whose message says
 * nothing about the request that produced it, and this is one of the routes where that trap is live.
 * Hence the `void` result - there is genuinely nothing to return, and inventing something to return
 * would require reading a body that is not there.
 *
 * The post's comments and likes are removed with it by cascading foreign keys in the database, so
 * there is no companion cleanup call to make and no client-side reconciliation to perform. Anything
 * a caller is still holding about this post - a cached feed page, a comment count - is stale
 * afterwards, and invalidating it belongs to the layer that owns the cache.
 *
 * @param id - The post's **server-generated identifier**, not its slug.
 * @param options - Per-call transport controls. See {@link PostMutationOptions}.
 * @returns Nothing. Resolution is the confirmation.
 * @throws The client module's normalised error - `401` without a credential, `403` when the caller
 * neither owns the post nor administers the site, `404` when no post has that identifier.
 *
 * @example
 * ```ts
 * await deletePost(post.id);
 * ```
 */
export function deletePost(id: string, options?: PostMutationOptions): Promise<void> {
  return apiDeleteNoContent(postResourcePath(id, 'deletePost'), options);
}

/**
 * Publish a post: `POST /posts/{id}/publish`.
 *
 * A **first-class state transition**, which is why it is its own route rather than a flag set
 * through {@link updatePost}. Publishing moves the post into the published state *and* stamps the
 * publication instant, and the two are inseparable: the database enforces a check constraint that a
 * published row must carry a publication instant, so the invariant holds no matter what any client
 * sends. Expressing publication as a transition is what makes that pairing impossible to break, and
 * it keeps the moment auditable rather than losing it inside a general edit.
 *
 * The request carries **no body at all** - not an empty object. Omitting the body means the client
 * module sends no content and no content type, which is what this route expects; an empty JSON
 * object would be a document the route does not declare.
 *
 * Publishing is effectively idempotent from a caller's point of view: publishing an
 * already-published post leaves it published. The post becomes visible in the feed, on its author's
 * public profile and in the sitemap.
 *
 * @param id - The post's **server-generated identifier**, not its slug.
 * @param options - Per-call transport controls. See {@link PostMutationOptions}.
 * @returns The post in full, now published, with its publication instant set.
 * @throws The client module's normalised error - `401` without a credential, `403` when the caller
 * neither owns the post nor administers the site, `404` when no post has that identifier.
 *
 * @example
 * ```ts
 * const live = await publishPost(post.id);
 * ```
 */
export function publishPost(id: string, options?: PostMutationOptions): Promise<PostDetail> {
  // `undefined` for the body is the explicit no-body form; it is not a placeholder for one.
  return apiPost(
    `${postResourcePath(id, 'publishPost')}/publish`,
    postDetailSchema,
    undefined,
    options,
  );
}

/**
 * Return a post to draft: `POST /posts/{id}/unpublish`.
 *
 * The inverse transition of {@link publishPost}, and its counterpart in every respect: its own
 * route rather than a flag, no request body, and the full post in reply. The post leaves the public
 * feed, the author's public profile and the sitemap, and becomes visible again only to its author
 * and to an administrator.
 *
 * The slug does **not** change, here or ever after creation. That matters for exactly the reason the
 * slug is fixed in the first place: a post that is unpublished and later published again resolves at
 * the same canonical URL it always had, so an external link that was shared in between is not
 * broken by the round trip.
 *
 * @param id - The post's **server-generated identifier**, not its slug.
 * @param options - Per-call transport controls. See {@link PostMutationOptions}.
 * @returns The post in full, now a draft.
 * @throws The client module's normalised error - `401` without a credential, `403` when the caller
 * neither owns the post nor administers the site, `404` when no post has that identifier.
 *
 * @example
 * ```ts
 * const draft = await unpublishPost(post.id);
 * ```
 */
export function unpublishPost(id: string, options?: PostMutationOptions): Promise<PostDetail> {
  return apiPost(
    `${postResourcePath(id, 'unpublishPost')}/unpublish`,
    postDetailSchema,
    undefined,
    options,
  );
}
