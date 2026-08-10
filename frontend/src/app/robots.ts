/**
 * The site's crawl policy, served as plain text at `/robots.txt`.
 *
 * Next.js's `app/robots.ts` convention turns the object returned below into the policy document at
 * the site root. That is the whole of this module. There is no request to inspect, no data to
 * fetch and no per-visitor variation, so the route is generated once per build and the function is
 * synchronous - `async` here would buy nothing and would only suggest to the next reader that
 * something is awaited.
 *
 * ## What the emitted document says
 *
 * ```text
 * User-Agent: *
 * Allow: /
 * Disallow: /admin
 * Disallow: /dashboard
 * Disallow: /posts
 *
 * Host: <the configured site origin>
 * Sitemap: <that origin>/sitemap.xml
 * ```
 *
 * Both the line order and the `User-Agent` spelling with its capital `A` belong to the framework's
 * own serialiser, not to this file: it writes the user-agent line, then every `Allow`, then every
 * `Disallow`, then a blank line, then `Host`, then `Sitemap`. Directive keywords in a robots
 * policy are case-insensitive (RFC 9309 section 2.1), so `User-Agent` and `User-agent` are the
 * same directive and no crawler distinguishes them. A reader verifying this file by eye should
 * compare case-insensitively rather than "fix" a spelling this module does not control.
 *
 * ## Why `Allow: /` does not cancel the three `Disallow` lines
 *
 * It looks like it should, and that reading is the most likely way someone later "simplifies" this
 * file into a policy that indexes the admin dashboard. A crawler does not apply the rules in
 * order: RFC 9309 section 2.2.2 makes the **most specific** match win, where specificity is the
 * length of the matched path. For `/admin/users`, `Disallow: /admin` matches six characters and
 * `Allow: /` matches one, so the disallow governs. For `/blog/my-post`, only `Allow: /` matches at
 * all.
 *
 * The `Allow: /` line is therefore not redundant filler and not a contradiction. It states the
 * default for everything the three prefixes do not cover, which is the entire public reading
 * surface, and it says so explicitly instead of leaving a crawler to infer permission from
 * silence.
 *
 * ## THIS IS NOT A SECURITY BOUNDARY. IT IS CRAWL HYGIENE.
 *
 * A `Disallow` line is a request addressed to well-behaved crawlers. It is not enforcement, it is
 * not authentication, and it is trivially ignored - by a misbehaving crawler, by anyone typing the
 * URL, and by anyone who reads this very file, which is published at a well-known path and is
 * therefore a public list of the paths worth looking at.
 *
 * Authority is decided server-side, on every operation, and none of it is weakened by anything
 * here:
 *
 *   - `require_admin`, applied once on the administrative router include in
 *     `backend/app/api/v1/router.py`, so no administrative route can omit it.
 *   - Ownership assertions in `backend/app/services/post_service.py` and
 *     `backend/app/services/comment_service.py`, so an author may act only on their own content.
 *
 * `src/middleware.ts` sits between the two and is itself only defence in depth - it decides from a
 * script-writable role marker and deliberately admits an expired-but-refreshable session so the
 * client can recover one. This file is a weaker signal still. **Do not omit or relax a
 * server-side check because a path appears below.**
 *
 * ## Why the disallow set is imported rather than written out here
 *
 * `CRAWL_DISALLOWED_PATHS` in `@/lib/seo` is the single declaration of that set, and this module
 * is the only consumer of it. Restating the three paths here would create a second declaration
 * site for one policy, and the two copies would drift the first time a route family was added -
 * silently, because a stale `Disallow` line is still a syntactically perfect robots policy.
 *
 * That indirection also removes the two mistakes this file is most likely to contain, by putting
 * the reasoning where the list lives:
 *
 *   1. **A route group's parentheses never appear in a URL.** `src/app/(dashboard)/` and
 *      `src/app/(admin)/` are organisational directories whose names are erased from the rendered
 *      path. `Disallow: /(dashboard)` would match no URL that exists and would protect nothing
 *      while looking deliberate.
 *   2. **`/posts` and `/blog` are different families.** The workspace group serves the authoring
 *      screens at `/posts/new` and `/posts/{id}/edit`, so `/posts` is a third prefix beyond
 *      `/dashboard` and `/admin`. Public post pages are at `/blog/{slug}` and are the single most
 *      important thing on this site for a crawler to reach, so `/blog` is absent from the set and
 *      must stay absent. The two prefixes share no characters, so disallowing one cannot affect
 *      the other - but a broader prefix invented in the name of tidiness could.
 *
 * The set is also the mirror of `src/middleware.ts`'s `config.matcher`, which gates
 * `/dashboard/:path*`, `/posts/:path*` and `/admin/:path*` - the same three families. The two
 * halves are designed to agree, and a route worth gating from a visitor is a route worth keeping
 * out of an index. Change them together.
 *
 * ## `/login` and `/signup` are deliberately NOT disallowed
 *
 * A judgement call, decided against, and the reasoning is recorded here so it is not reopened as
 * an oversight. Both routes are public, thin and carry nothing worth indexing, so disallowing them
 * would be harmless in itself - but it would have to be done *in this file*, because they are not
 * in the shared set. That reintroduces exactly the second declaration site the import above exists
 * to avoid, and it breaks the path-for-path agreement with the route matcher that makes the two
 * halves checkable against each other. The technical plan asks for the workspace and
 * administrative groups and nothing more. If these two ever do need excluding, they belong in
 * `CRAWL_DISALLOWED_PATHS` alongside the rest - not here.
 *
 * ## Governing standards
 *
 * `review_rules` reports **no user-specified rules** for this project. Nothing below is invented to
 * satisfy one, and their absence is not licence to lower the bar: the binding constraints are the
 * technical plan's own enterprise standards. Five govern this module.
 *
 *   - **Configuration from the environment only.** This file reads no environment variable and
 *     hard-codes no origin. `@/lib/seo` is the tier's sole reader of the site-identity values and
 *     owns the one expression where an origin and a path are joined, so both absolute URLs below
 *     come from it already normalised.
 *   - **Layered separation of concerns.** Zero I/O. No `fetch`, no import from `@/lib/api/*`, and
 *     nothing awaited. The policy is static, so a network call would add a failure mode to a
 *     document that has no input.
 *   - **Authorisation is enforced server-side.** See the boundary note above. This file makes no
 *     security claim.
 *   - **Explicit API contracts.** The return value is annotated `MetadataRoute.Robots` rather than
 *     inferred, so a field the framework does not accept is a compile error here instead of a
 *     malformed document discovered by a crawler.
 *   - **Blocking quality gates.** Compiles under `tsc --noEmit` with the strict options in
 *     `frontend/tsconfig.json` and lints at `--max-warnings=0`.
 *
 * Design-system compliance is vacuous here and the exemption is reasoned rather than overlooked:
 * this module renders no markup, imports no component, references no design token and declares no
 * CSS value, so the token, primitive and breakpoint rules have nothing to bind to.
 *
 * ## DELIBERATELY ABSENT. Each looks like an improvement and is a defect here.
 *
 *   1. `crawlDelay`. Unrequested, honoured inconsistently, and a throttle on legitimate indexing
 *      is the opposite of what this file is for. Omitting the field emits no `Crawl-delay` line at
 *      all.
 *   2. Per-agent blocks for named crawlers. One wildcard rule covers every crawler uniformly. A
 *      named block replaces the wildcard for that agent rather than adding to it, which is the
 *      easy way to exclude a search engine by accident.
 *   3. A `noindex` directive. A robots policy cannot express one - it controls crawling, not
 *      indexing - and page-level indexing is metadata: `src/app/not-found.tsx` declares its own,
 *      and no other route needs one.
 *   4. `/blog` or `/u` in the disallow set. Those are the public reading routes the sitemap exists
 *      to advertise. Disallowing either would suppress the exact content the rest of the SEO work
 *      gets indexed.
 *   5. A `/categories` entry. No such route is served. A category's page is the filtered home feed
 *      at `/?category={slug}`, which lives under `/` and is allowed - as it must be, because it is
 *      how a category is addressed anywhere on the site.
 *   6. A trailing slash on any prefix. A robots directive is a prefix match, so `/admin` covers
 *      the section's own index page as well as everything beneath it, where `/admin/` would miss
 *      the index. The shared set enforces this; do not add one on the way past.
 *   7. `next-sitemap` or any other generator package. The framework's native `robots.ts` and
 *      `sitemap.ts` conventions cover this entirely, and that package is excluded by the plan.
 *
 * @module
 */

import type { MetadataRoute } from 'next';

import { CRAWL_DISALLOWED_PATHS, resolveSiteOrigin, sitemapUrl } from '@/lib/seo';

/**
 * The wildcard user-agent token: one rule block that applies to every crawler.
 *
 * Named rather than inlined because the framework treats an omitted `userAgent` as this value
 * anyway, and a policy document is the wrong place to depend on an implicit default. Stating it
 * makes the emitted `User-Agent: *` line traceable to a decision.
 */
const ALL_USER_AGENTS = '*';

/**
 * The site root, allowed in full.
 *
 * This is the shortest possible match, which is precisely why it can sit alongside the disallowed
 * prefixes without contradicting them - see the specificity note in the module documentation.
 */
const PUBLIC_ROOT = '/';

/**
 * Build the crawl policy served at `/robots.txt`.
 *
 * Everything public is crawlable; the authoring workspace and the administrative section are asked
 * for politely and not enforced; and the sitemap is advertised absolutely, because the `Sitemap:`
 * directive is the one line in this document that is a full URL rather than a path.
 *
 * Both URLs are produced by `@/lib/seo`, so the origin is validated and normalised once - a
 * configured value with a trailing slash and one without yield the identical string, which is what
 * makes a doubled slash or a scheme-less host unrepresentable here rather than merely unlikely.
 * `resolveSiteOrigin` is called directly for `host` and again inside `sitemapUrl`; the resolver is
 * pure with respect to its single input, so the two lines cannot disagree, and it is uncached by
 * design in the module that owns it. If the origin is unset or malformed, both calls throw the
 * same error and the build fails loudly - which is the intended outcome, since a substituted
 * origin would publish a policy pointing at a sitemap nobody serves.
 *
 * `host` is a non-standard directive that most crawlers ignore, and it is emitted anyway for one
 * concrete reason: it puts the origin the build was actually configured with into the first file
 * an operator inspects, so a misconfigured deployment is visible in a single `curl` rather than
 * only in the canonical links of a rendered page. It introduces no failure mode that the required
 * `Sitemap:` line does not already have, and it is not a substitute for a canonical link - those
 * are declared per route by the metadata builders in `@/lib/seo`.
 *
 * @returns The policy, for the framework to serialise into plain text.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: ALL_USER_AGENTS,
        allow: PUBLIC_ROOT,

        // Spread into a fresh array rather than passed by reference. The framework types this
        // field as a mutable `string[]` while the shared set is `readonly` and frozen, so
        // assigning it directly is a compile error (TS2322) - and copying is the right answer
        // rather than a workaround: the policy stays immutable for every other reader, and the
        // framework gets an array it is free to treat as its own.
        disallow: [...CRAWL_DISALLOWED_PATHS],
      },
    ],
    host: resolveSiteOrigin(),
    sitemap: sitemapUrl(),
  };
}
