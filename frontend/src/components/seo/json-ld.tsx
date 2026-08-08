// Structured data - the `BlogPosting` and `Person` JSON-LD documents a crawler reads.
//
// This is the whole of the tier's structured-data surface. `src/app/blog/[slug]/page.tsx` renders
// `<BlogPostingJsonLd post={post} />` and `src/app/u/[username]/page.tsx` renders
// `<PersonJsonLd user={user} />`; nothing else emits a schema.org document, and no other schema
// type is emitted at all. Two types is a decision, not a starting point - see note 8 below.
//
// The deliberate division of labour with `@/lib/seo` is the first thing to understand about this
// file. That module owns every `Metadata` object the framework consumes: the `<title>`, the meta
// description, `alternates.canonical`, the OpenGraph block and the Twitter card. This module owns
// the JSON-LD graph and nothing else. The overlap is intentional and is *only* in the URL
// builders: both describe the same resource, so both compose their absolute URLs from the same
// three functions, which is what guarantees the canonical link in the document head and the `url`
// in the graph can never disagree. JSON-LD cannot move into `generateMetadata` even if the
// duplication looked tempting - that API returns a metadata object and has no way to emit a
// `<script>` element.
//
// Seven decisions below look like details and are each load-bearing. The notes exist so none of
// them is "tidied up" by a later reader who cannot see why the obvious alternative is wrong.
//
// ---------------------------------------------------------------------------
// 1. NO `'use client'` - AND THAT IS THE ENTIRE POINT OF THE FILE
//
// Structured data only works if a crawler sees it *without executing JavaScript*. Both consumers
// are Server Components, so a directive-free module renders on the server and its `<script>` lands
// in the initial HTML response. Adding `'use client'` would move the graph behind hydration and
// silently defeat the requirement this file exists to satisfy: the page would still look correct in
// a browser, and the structured data would simply be invisible to the consumer that matters.
//
// There is nothing here that would need a client boundary anyway - no state, no effect, no hook, no
// event handler, no browser global, and no `async` or `await`. Both components are pure functions
// of their props. They neither fetch nor derive anything the caller has not already fetched:
// `@/lib/api/client` is the tier's only HTTP module and is deliberately not imported.
//
// ---------------------------------------------------------------------------
// 2. `dangerouslySetInnerHTML` IS MANDATORY HERE, NOT A SHORTCUT
//
// The obvious spelling - `<script>{JSON.stringify(graph)}</script>` - is wrong, and wrong in the
// worst way: it renders without complaint and produces a document no consumer can parse. React
// HTML-escapes text children, so every `"` in the JSON becomes `&quot;` and the block is garbage.
// `dangerouslySetInnerHTML` is the standard - and the only - correct way to emit JSON-LD from
// React. The name is alarming by design; what makes it safe here is that the payload is not
// caller-supplied HTML but the output of `JSON.stringify`, hardened as note 3 describes.
//
// ---------------------------------------------------------------------------
// 3. `JSON.stringify` DOES NOT ESCAPE `<`, SO {@link serialiseGraph} DOES
//
// `title`, `excerpt` and `bio` are author-authored text. If any of them contained the eight
// characters `</script`, the browser's tokeniser would end the script element *inside* the JSON -
// truncating the graph and spilling the remainder into the document as markup. Escaping every `<`
// to `\u003c` closes that hole completely: it is ordinary JSON string escaping, so a parser
// reconstructs the identical string, and no `<` survives into the byte stream for the tokeniser to
// act on.
//
// This defence is not redundant with the two that already exist. The service sanitises content on
// write and `rehype-sanitize` sanitises it again where Markdown is rendered, but neither touches
// this path: a `<script>` body is not HTML being rendered and never passes through either. A
// defence that does not cover the path cannot be relied on for it.
//
// ---------------------------------------------------------------------------
// 4. A MISSING VALUE MUST PRODUCE A MISSING KEY - NEVER `null`, NEVER `""`
//
// This is the single most important correctness rule in the file. `excerpt`, `published_at`,
// `cover_image_url`, `bio` and `avatar_url` are all legitimately `null` on the wire, and a graph
// asserting `"datePublished": null` or `"description": ""` is *invalid* - strictly worse than one
// that never mentioned the property, because a malformed value is a claim about the resource while
// an absent key is merely silence.
//
// So every optional property is `?`-typed and conditionally spread, and every value passes through
// {@link presence} first, which collapses `null`, `undefined`, `""` and whitespace-only alike into
// a single "absent" state. There is exactly one rule to audit: no key is emitted whose value is not
// non-blank text.
//
// ---------------------------------------------------------------------------
// 5. THE DATE FORMATTER'S PLACEHOLDER IS CHECKED FOR TWICE, DELIBERATELY
//
// `formatMachineDate` is total: handed something absent or unparseable it returns the empty-string
// placeholder rather than throwing. That behaviour is right for its main caller - a `<time>`
// element elides itself on a falsy `dateTime` - but a placeholder reaching this graph would be an
// invalid date. Two independent guards prevent it, and both are wanted:
//
//   * The presence check runs *before* the formatter, so the formatter is only ever invoked on a
//     value already proven non-blank; and
//   * its result passes through the presence check *again*, which catches the one case the first
//     guard structurally cannot - an instant that is present but unparseable.
//
// Neither guard alone is sufficient, which is why neither is removable.
//
// ---------------------------------------------------------------------------
// 6. AN IMAGE URL MAY ALREADY BE ABSOLUTE, AND `absoluteUrl` THROWS ON ONE
//
// `cover_image_url` and `avatar_url` hold remote URLs - `next.config.ts` maintains a host allowlist
// precisely because covers and avatars are external references rather than uploads. `absoluteUrl`
// rejects an input that already carries a scheme instead of nesting one origin inside another, so
// handing it a stored cover URL would not merely produce a doubled prefix, it would throw and blank
// the page. {@link resolveImageUrl} therefore classifies before it resolves; see its own note for
// why a non-`http(s)` scheme is dropped rather than passed through.
//
// ---------------------------------------------------------------------------
// 7. NEITHER COMPONENT CAN THROW ON RESOURCE DATA
//
// A thrown error inside a Server Component blanks the whole page, and structured data is
// enrichment: it is never worth a reader losing the article over. Both components therefore
// degrade rather than fail. Every nullable field may be null, every string may be blank, and the
// result is still a valid graph - a smaller one.
//
// The one thing this file does *not* catch is a missing or malformed `NEXT_PUBLIC_SITE_URL`, which
// `@/lib/seo` throws on by design. Swallowing that would substitute a plausible-looking URL for a
// misconfiguration and let a wrong canonical URL reach a crawler, which is the exact failure that
// module chose a loud error to prevent. A configuration fault belongs to configuration.
//
// ---------------------------------------------------------------------------
// 8. WHAT IS DELIBERATELY ABSENT
//
// Do not add:
//
//   * A third graph type. `BlogPosting` and `Person` are the two the plan specifies. A
//     `BreadcrumbList`, `WebSite`, `Organization` or `FAQPage` block would assert structure this
//     product does not have.
//   * A JSON-LD helper library. None is a dependency, and the graphs are small enough that a
//     hand-typed interface documents them better than a generic vocabulary type would.
//   * A `className`, a design token, a `@/components/ui/*` primitive or `cn` from `@/lib/utils`. A
//     `<script>` has no visual surface to style, so there is nothing for any of them to do, and an
//     unused import fails the lint gate outright.
//   * An `aria-*` attribute or a `role`. A `<script>` is not content and must stay invisible to
//     assistive technology; labelling it would expose machine-readable metadata to a screen reader.
//   * A `process.env` read. `@/lib/seo` is the tier's only reader of the two public site variables,
//     and every absolute URL below comes from its builders.
//
// No user-specified rules were provided for this project, so the binding constraints are the
// technical plan's own enterprise standards. Five govern this file: configuration from the
// environment only, no secrets in the repository, pinned dependencies, explicit API contracts -
// every resource shape below is imported from `@/lib/types` rather than restated - and blocking
// quality gates, which this file passes under `tsc --noEmit` with the strict options in
// `frontend/tsconfig.json` and under `eslint --max-warnings=0`.

import type { JSX } from 'react';

import { formatMachineDate } from '@/lib/format';
import { absoluteUrl, postPath, profilePath } from '@/lib/seo';
import type { PostDetail, UserPublic } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The JSON-LD vocabulary identifier every document below declares.
 *
 * This is the one absolute URL literal in the file, and it is not a configuration value in
 * disguise. It is a fixed identifier defined by the JSON-LD and schema.org specifications - the
 * same string in every deployment of every site on the web - so it can no more come from the
 * environment than an HTTP method name could. The literals this file is forbidden to contain are
 * *this site's* origin, host and protocol, and none of those appears anywhere: every URL describing
 * a resource is built by {@link absoluteUrl}.
 *
 * `https`, not `http`. Both resolve, but a consumer comparing the context string is entitled to
 * expect the canonical spelling.
 */
const SCHEMA_ORG_CONTEXT = 'https://schema.org';

/**
 * Site-relative path of the default social card, used as {@link BlogPostingJsonLd}'s image of last
 * resort.
 *
 * A path, not a URL: it is resolved against the configured origin by {@link absoluteUrl} at the
 * point of use, so the origin still appears exactly once in the codebase. The asset is
 * `frontend/public/og-default.png`, served at this path by the framework's static-file convention.
 *
 * Declared here rather than imported because `@/lib/seo` exports no constant for it. If it ever
 * does, delete this and import that one - two spellings of one asset path is precisely the drift
 * this file otherwise avoids.
 */
const DEFAULT_IMAGE_PATH = '/og-default.png';

/**
 * Matches a URL that already carries the `http` or `https` scheme.
 *
 * Only these two are treated as usable absolute image URLs, because only these two are fetchable by
 * a crawler - and they are also the only schemes the service accepts when storing a cover or avatar
 * URL, and the only one `next.config.ts` allowlists.
 */
const HTTP_SCHEME_PATTERN = /^https?:\/\//i;

/**
 * Matches any value that is not root-relative: one carrying *some* scheme, or a protocol-relative
 * `//host/path`.
 *
 * Deliberately the same shape {@link absoluteUrl} rejects on, so {@link resolveImageUrl} can
 * recognise every input that would make it throw *before* calling it. Keeping the two in agreement
 * is what turns a potential exception into a branch.
 */
const NON_RELATIVE_URL_PATTERN = /^(?:[a-z][a-z\d+\-.]*:|\/\/)/i;

/* -------------------------------------------------------------------------------------------------
 * Graph shapes
 *
 * Hand-declared, non-exported, and structural rather than nominal: these describe schema.org output
 * rather than an API contract. A resource type must come from `@/lib/types` because the service
 * owns its shape; these documents have no counterpart there because nothing but this file produces
 * one, so declaring them locally is correct and exporting them would invite a consumer to build a
 * graph somewhere else.
 *
 * Every property that can be absent is `?`-typed. That is not documentation - it is what makes the
 * conditional spreads below type-check, and it is what would make a stray `key: undefined`
 * assignment fail compilation under `exactOptionalPropertyTypes`-style scrutiny.
 * ---------------------------------------------------------------------------------------------- */

/**
 * A person reference nested inside another document: the `author` of a {@link BlogPostingGraph}.
 *
 * Distinct from {@link PersonGraph}, which is a stand-alone document and therefore carries its own
 * `@context`. A nested node inherits the enclosing document's context and must not restate it.
 *
 * Both data members are optional so the reference can degrade instead of asserting a blank name or
 * a malformed URL; see {@link BlogPostingJsonLd} for when each is dropped.
 */
interface JsonLdPersonReference {
  '@type': 'Person';
  name?: string;
  url?: string;
}

/**
 * The `mainEntityOfPage` node: the web page this post is the primary subject of.
 *
 * `@id` is required rather than optional because the node's entire purpose is to carry it - a
 * `WebPage` with no identifier says nothing. The enclosing document omits the whole node instead
 * when it has no URL to put here.
 */
interface JsonLdWebPageReference {
  '@type': 'WebPage';
  '@id': string;
}

/**
 * The `BlogPosting` document emitted on a post's reading page.
 *
 * `@context` is typed as the constant rather than as `string`, so the two cannot drift apart and a
 * typo is a compile error rather than a silently unrecognised vocabulary.
 */
interface BlogPostingGraph {
  '@context': typeof SCHEMA_ORG_CONTEXT;
  '@type': 'BlogPosting';
  headline?: string;
  description?: string;
  datePublished?: string;
  dateModified?: string;
  url?: string;
  mainEntityOfPage?: JsonLdWebPageReference;
  author?: JsonLdPersonReference;
  image?: string;
}

/**
 * The `Person` document emitted on a public author profile.
 *
 * Exactly four data properties, and the restraint is deliberate: `sameAs`, `jobTitle`,
 * `worksFor` and the rest of the vocabulary describe facts this product does not collect, and a
 * graph is only useful while everything in it is true.
 */
interface PersonGraph {
  '@context': typeof SCHEMA_ORG_CONTEXT;
  '@type': 'Person';
  name?: string;
  url?: string;
  image?: string;
  description?: string;
}

/** Either stand-alone document, as {@link JsonLdScript} accepts it. */
type JsonLdGraph = BlogPostingGraph | PersonGraph;

/* -------------------------------------------------------------------------------------------------
 * Value helpers
 *
 * Four small pure functions. Between them they are the reason neither component can emit an invalid
 * property or throw on resource data.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Reduce a nullable wire string to text worth emitting, or to `undefined`.
 *
 * The single guard behind the omission discipline of note 4. Four inputs collapse to one "absent"
 * state - `null`, `undefined`, `''` and a whitespace-only string - so downstream code has two cases
 * to handle rather than five, and a blank value can never be mistaken for a present one. A
 * whitespace-only excerpt is as invalid a `description` as a null one, and treating them
 * differently would leave a hole exactly the size of one careless keystroke by an author.
 *
 * Internal whitespace runs are collapsed as well as trimmed. For `headline` and `description` that
 * is plain hygiene: an author who pasted a hard-wrapped paragraph should not get a ragged
 * structured-data value out of it. For the URL-valued fields the collapse is a no-op on every
 * legitimate input, since a URL contains no whitespace - and it is applied anyway because
 * `@/lib/seo` normalises the very same `cover_image_url` and `avatar_url` fields the same way, so
 * the value in the graph and the value in the OpenGraph block are guaranteed to be the same string.
 *
 * @param value - Any nullable text from the API contract.
 * @returns Trimmed, whitespace-collapsed text, or `undefined` when there is none.
 */
function presence(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Turn a stored image reference into an absolute URL a crawler can fetch, or into `undefined`.
 *
 * Three classes of input, and the branch order matters:
 *
 * 1. **Already `http(s)`** - the normal case, since covers and avatars are remote references rather
 *    than uploads. Emitted exactly as the service stored it. It must *not* go through
 *    {@link absoluteUrl}, which rejects an input that already carries a scheme; see note 6.
 * 2. **Some other scheme, or protocol-relative** - `data:`, `ftp:`, `javascript:`, `//host/path`.
 *    Dropped. Two reasons, either sufficient: none is a URL a crawler will fetch, so emitting it
 *    would put a claim in the graph that cannot be verified; and passing an unfetchable
 *    `javascript:` value into structured data consumed by third parties is not a risk worth taking
 *    for a field that is optional anyway. Dropping is also what keeps {@link absoluteUrl} from
 *    throwing on it.
 * 3. **Root-relative** - resolved against the configured origin. This is the branch
 *    {@link DEFAULT_IMAGE_PATH} always takes.
 *
 * @param value - A stored image URL, or the site-relative path of a bundled asset.
 * @returns An absolute URL, or `undefined` when there is nothing usable.
 * @throws Error only by way of {@link absoluteUrl}, and only when the site origin is misconfigured -
 * never because of the value passed in. See note 7.
 */
function resolveImageUrl(value: string | null | undefined): string | undefined {
  const candidate = presence(value);

  if (candidate === undefined) {
    return undefined;
  }

  if (HTTP_SCHEME_PATTERN.test(candidate)) {
    return candidate;
  }

  if (NON_RELATIVE_URL_PATTERN.test(candidate)) {
    return undefined;
  }

  return absoluteUrl(candidate);
}

/**
 * Produce the machine-readable instant for a `datePublished` or `dateModified`, or `undefined`.
 *
 * Both guards of note 5, in one place so neither call site can implement only one of them. The
 * presence check runs first, so `formatMachineDate` is only ever handed a value already proven
 * non-blank; its result is checked again, which is what catches a present-but-unparseable instant
 * whose placeholder would otherwise be emitted as a date.
 *
 * The formatter is used rather than the wire string passed straight through, because it normalises
 * to UTC. That makes the value byte-identical however it is rendered, and an instant in structured
 * data is exactly the wrong place for a representation that depends on the renderer's timezone.
 *
 * @param value - An ISO-8601 instant from the API, possibly `null`.
 * @returns A UTC ISO-8601 instant, or `undefined` when absent or unparseable.
 */
function machineInstant(value: string | null | undefined): string | undefined {
  const candidate = presence(value);

  if (candidate === undefined) {
    return undefined;
  }

  return presence(formatMachineDate(candidate));
}

/**
 * Serialise a graph into the exact bytes of the script body.
 *
 * Compact - no indent argument. Whitespace in a machine-read document buys nothing and every byte
 * ships on every request to the page.
 *
 * The `<` replacement is the `</script>` hardening of note 3. `\u003c` is an ordinary JSON escape,
 * so a parser reconstructs the identical string and the graph a consumer reads is unchanged; what
 * changes is that no `<` reaches the HTML tokeniser, which makes early termination of the script
 * element impossible regardless of what an author typed.
 *
 * @param graph - The document to emit.
 * @returns JSON with every `<` escaped.
 */
function serialiseGraph(graph: JsonLdGraph): string {
  return JSON.stringify(graph).replace(/</g, '\\u003c');
}

/* -------------------------------------------------------------------------------------------------
 * The script element
 * ---------------------------------------------------------------------------------------------- */

/**
 * Props for {@link JsonLdScript}.
 *
 * The prop is named `graph` rather than `document` on purpose: `document` is a browser global, and
 * shadowing it inside a module that must never touch the DOM would make a genuine mistake read as
 * ordinary code.
 */
interface JsonLdScriptProps {
  /** The document to serialise. Serialisation is this component's job, not the caller's. */
  graph: JsonLdGraph;
}

/**
 * Render one `<script type="application/ld+json">` carrying a serialised graph.
 *
 * Private, and the only place in the tier that constructs such an element. Both public components
 * delegate here, which is what guarantees the media type is spelled correctly and the `<`-escaping
 * of note 3 is applied to every document - a caller cannot forget either, because a caller never
 * sees the string.
 *
 * It takes the graph rather than pre-serialised text for the same reason. Accepting a string would
 * move {@link serialiseGraph} to two call sites and make the hardening opt-in.
 *
 * Exactly one element, with no wrapper and no fragment. A `<script>` is metadata: it renders nothing
 * and must not perturb the layout of whatever the consumer places it beside. It carries no `key`
 * either - neither consumer renders these in a list.
 */
function JsonLdScript({ graph }: JsonLdScriptProps): JSX.Element {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serialiseGraph(graph) }}
    />
  );
}

/* -------------------------------------------------------------------------------------------------
 * Public components
 * ---------------------------------------------------------------------------------------------- */

/** Props for {@link BlogPostingJsonLd}. */
interface BlogPostingJsonLdProps {
  /**
   * The post, as `GET /api/v1/posts/{slug}` returned it.
   *
   * The detail projection specifically, not a summary: `updated_at` is the field `dateModified`
   * needs and only the detail representation carries it. Taking the full resource rather than a
   * handful of loose strings keeps the graph and the rendered article demonstrably about the same
   * record.
   */
  post: PostDetail;
}

/**
 * Emit the `BlogPosting` structured data for a post's reading page.
 *
 * Rendered by `src/app/blog/[slug]/page.tsx`. Nine properties, each mapped from one field of the
 * resource, and every one of them absent from the output rather than blank when the field is:
 *
 * | Property           | Source                  | When it is omitted                              |
 * | ------------------ | ----------------------- | ----------------------------------------------- |
 * | `headline`         | `title`                 | Never, in practice - see below                  |
 * | `description`      | `excerpt`               | The author wrote none                           |
 * | `datePublished`    | `published_at`          | The post has never been published (a draft)     |
 * | `dateModified`     | `updated_at`            | Never, in practice - the column is `NOT NULL`   |
 * | `url`              | `slug`                  | Only if the slug were blank - see below         |
 * | `mainEntityOfPage` | `slug`                  | With `url`, since it restates it                |
 * | `author`           | `author`                | Only if it would carry neither name nor URL     |
 * | `image`            | `cover_image_url`       | Never - falls back to the default social card   |
 *
 * Three of those rows deserve their reasoning stated rather than inferred:
 *
 * - **`datePublished` is genuinely optional.** A database check constraint guarantees
 *   `published_at` is present whenever the status is `PUBLISHED`, so a published post always
 *   carries one - but a draft legitimately has none, and the detail route serves a draft to its own
 *   author or an administrator. Asserting a publication instant for a post that has never been
 *   published would be false; omitting it is the only correct option.
 * - **`headline` and `dateModified` are typed optional but emitted always.** `title` and
 *   `updated_at` are non-nullable on the contract, so neither can actually be absent. They are
 *   still routed through the same guard as everything else, because "no key is ever blank" is worth
 *   far more as a property that holds unconditionally than as one with two documented exceptions a
 *   future contract change could quietly turn into real cases.
 * - **`url` and `mainEntityOfPage['@id']` are the same string, computed once.** They must agree -
 *   a document whose canonical URL disagrees with itself defeats the purpose of publishing one -
 *   and computing it twice is how they would eventually stop agreeing.
 *
 * `image` is the one property with a fallback rather than an omission, and the asymmetry with
 * {@link PersonJsonLd} is deliberate: a post without a cover still has a *representative* image,
 * the site's default social card, whereas a person without an avatar has no photograph and
 * substituting the site's card for one would be a false claim about a human being.
 *
 * @param props - See {@link BlogPostingJsonLdProps}.
 * @returns One `<script>` element carrying the graph.
 */
export function BlogPostingJsonLd({ post }: BlogPostingJsonLdProps): JSX.Element {
  // The canonical URL, built once and reused. `postPath` rejects a blank slug, so the slug is
  // proven non-blank first: that turns the one exception a malformed record could raise into a
  // branch, and a graph missing its `url` is still valid where a blank page is not.
  const slug = presence(post.slug);
  const canonicalUrl = slug === undefined ? undefined : absoluteUrl(postPath(slug));

  // `display_name` is non-nullable on the contract - registration derives it from the username when
  // none was supplied - so the fallback covers a blank value rather than a missing one. `username`
  // is unique and non-null, which makes it the one identifier always safe to show a reader.
  const authorUsername = presence(post.author.username);
  const authorName = presence(post.author.display_name) ?? authorUsername;
  const authorUrl =
    authorUsername === undefined ? undefined : absoluteUrl(profilePath(authorUsername));

  const author: JsonLdPersonReference | undefined =
    authorName === undefined && authorUrl === undefined
      ? undefined
      : {
          '@type': 'Person',
          ...(authorName === undefined ? {} : { name: authorName }),
          ...(authorUrl === undefined ? {} : { url: authorUrl }),
        };

  const headline = presence(post.title);
  const description = presence(post.excerpt);
  const datePublished = machineInstant(post.published_at);
  const dateModified = machineInstant(post.updated_at);

  // A cover when there is one, the default social card otherwise. The fallback is site-relative and
  // therefore always resolved; a stored cover is already absolute and is passed through untouched.
  const image = resolveImageUrl(post.cover_image_url) ?? resolveImageUrl(DEFAULT_IMAGE_PATH);

  const graph: BlogPostingGraph = {
    '@context': SCHEMA_ORG_CONTEXT,
    '@type': 'BlogPosting',
    ...(headline === undefined ? {} : { headline }),
    ...(description === undefined ? {} : { description }),
    ...(datePublished === undefined ? {} : { datePublished }),
    ...(dateModified === undefined ? {} : { dateModified }),
    ...(canonicalUrl === undefined
      ? {}
      : { url: canonicalUrl, mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl } }),
    ...(author === undefined ? {} : { author }),
    ...(image === undefined ? {} : { image }),
  };

  return <JsonLdScript graph={graph} />;
}

/** Props for {@link PersonJsonLd}. */
interface PersonJsonLdProps {
  /**
   * The author, as `GET /api/v1/users/{username}` returned it.
   *
   * The public projection, which is the only user shape that may be published. It withholds the
   * email address, the role and the active flag by construction, so there is no field here that
   * could leak into a document served to anonymous readers and indexed by a crawler.
   */
  user: UserPublic;
}

/**
 * Emit the `Person` structured data for a public author profile.
 *
 * Rendered by `src/app/u/[username]/page.tsx`. Four data properties, and no more - the vocabulary
 * offers dozens, but every one of them would describe a fact this product does not hold:
 *
 * | Property      | Source         | When it is omitted                                    |
 * | ------------- | -------------- | ----------------------------------------------------- |
 * | `name`        | `display_name` | Never, in practice - falls back to `username`          |
 * | `url`         | `username`     | Only if the username were blank                       |
 * | `image`       | `avatar_url`   | The account has no avatar - **no fallback**            |
 * | `description` | `bio`          | The account has written no bio                        |
 *
 * `image` deliberately has no fallback, in contrast to {@link BlogPostingJsonLd}. The default social
 * card is a site-level branding asset; presenting it as a person's photograph would be a false
 * statement about an identifiable individual, and a `Person` with no `image` is perfectly valid.
 * An absent property says "unknown", which is exactly what is true here.
 *
 * @param props - See {@link PersonJsonLdProps}.
 * @returns One `<script>` element carrying the graph.
 */
export function PersonJsonLd({ user }: PersonJsonLdProps): JSX.Element {
  // Same guard as the author reference above, and for the same reason: `profilePath` rejects a
  // blank username, so it is only called on one proven non-blank.
  const username = presence(user.username);
  const canonicalUrl = username === undefined ? undefined : absoluteUrl(profilePath(username));

  const name = presence(user.display_name) ?? username;
  const image = resolveImageUrl(user.avatar_url);
  const description = presence(user.bio);

  const graph: PersonGraph = {
    '@context': SCHEMA_ORG_CONTEXT,
    '@type': 'Person',
    ...(name === undefined ? {} : { name }),
    ...(canonicalUrl === undefined ? {} : { url: canonicalUrl }),
    ...(image === undefined ? {} : { image }),
    ...(description === undefined ? {} : { description }),
  };

  return <JsonLdScript graph={graph} />;
}
