// Client-side validation for the post editor — the create and edit forms behind requirement R2
// ("create, edit, delete, and publish blog posts").
//
// Two schemas, one per request body the editor can send:
//
//   postCreateSchema  ->  POST  /api/v1/posts        (always creates a DRAFT)
//   postUpdateSchema  ->  PATCH /api/v1/posts/{id}   (a genuine partial update)
//
// `frontend/src/components/blog/post-editor.tsx` serves both the create and the edit route, so it
// picks between the two at render time; that is why both are exported and why neither is folded
// into the other. `src/app/(dashboard)/posts/new/page.tsx` and
// `src/app/(dashboard)/posts/[id]/edit/page.tsx` are the routes that mount it.
//
// ---------------------------------------------------------------------------------------------
// THE ONE PROPERTY THIS MODULE EXISTS TO HOLD: IT MUST NOT DISAGREE WITH THE SERVER
//
// `backend/app/schemas/post.py` is the authority for every bound and every accept/reject decision
// below, and it is the reconciliation point for any future change here. Disagreement is a defect
// in one of exactly two directions, and NEITHER is caught by `tsc --noEmit` or by `eslint`:
//
//   * Looser here than there — the form submits, the API answers 422, and the author is shown a
//     failure they were given no chance to prevent.
//   * Stricter here than there — the form refuses input the API would have accepted, which on
//     this particular form means an author is blocked from saving work they have already written.
//
// So the bounds and the folding rules below were not transcribed from the Python source; they were
// reconciled by running it. Every constant and every case in the tables that follow was executed
// against the real `PostCreate` and `PostUpdate` models, and the notes record what came back.
// If a bound moves in `backend/app/schemas/post.py`, it moves here in the same change.
//
// ---------------------------------------------------------------------------------------------
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
//
// It describes a shape. It does not clean, render, measure or decide.
//
//   * It does not sanitise. Authored Markdown is this product's one stored-injection surface and
//     it is cleaned at two boundaries — server-side on write by `backend/app/services/
//     post_service.py`, and again where it is rendered by `src/components/blog/post-content.tsx`.
//     A validator is at neither boundary, and one that silently rewrote an author's body would be
//     both a mutation it is not entitled to make and a false sense of security, since the API is
//     callable without this form.
//   * It does not parse, lint or preview Markdown. That is `react-markdown` at render time.
//   * It does not compute a reading time. That is `src/lib/format.ts`.
//   * It does not derive a slug. Slugs are server-side only; see the note on `slug` below.
//   * It does not call the API. No refinement here checks that a category exists or that a slug is
//     free — `src/lib/api/client.ts` is the only module in this tier that performs HTTP.
//   * It does not format errors. Turning an issue list into inline field errors is the form
//     layer's job, done by `zodResolver` from `@hookform/resolvers`, which is imported by the
//     editor component and deliberately not here.
//
// ---------------------------------------------------------------------------------------------
// FIELD NAMES ARE snake_case, AND THAT IS LOAD-BEARING
//
// There is no camelCase transformation layer anywhere in this product: what a schema here names is
// what goes on the wire. `coverImageUrl` or `categoryIds` would produce a request the API accepts
// while ignoring the member, so the post would save with no cover image and no categories and
// nothing anywhere would report an error. `src/lib/types.ts` mirrors the Pydantic models under
// their snake_case names for the same reason, and the two are checked against each other by the
// `satisfies` clauses below.
//
// The exported identifiers are ordinary JavaScript and follow JavaScript convention: camelCase
// constants, PascalCase types.

import * as z from 'zod';

import type { PostCreate, PostUpdate } from '@/lib/types';
import { IMAGE_HOST_ALLOWLIST, codePointLength, isAllowedImageUrl } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Bounds
 *
 * Mirrored value-for-value from `backend/app/schemas/post.py`, where the same four numbers are
 * declared as `TITLE_MIN_LENGTH`, `TITLE_MAX_LENGTH`, `EXCERPT_MAX_LENGTH`, `CONTENT_MAX_LENGTH`
 * and `MAX_CATEGORIES_PER_POST`. They are named here rather than inlined into the messages and the
 * checks so that a single edit moves the rule and the text an author reads together — a bound
 * raised in a check but not in its message is a form that rejects input while telling the author
 * it accepts it.
 *
 * They are module-private on purpose. The module's public surface is the two schemas and their two
 * inferred types, and a consumer needing to display "N characters remaining" should read
 * `postCreateSchema.shape` rather than depend on a second exported spelling of the same number.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Shortest accepted title, measured after surrounding whitespace is trimmed.
 *
 * One character rather than some prettier minimum, so a single-glyph headline in any script is
 * allowed. Combined with trimming, this is also what rejects a whitespace-only title: `'   '`
 * becomes `''` and then fails this bound, instead of being stored as a value that renders as a
 * blank card, a blank page heading and a blank browser tab.
 */
const TITLE_MIN_LENGTH = 1;

/**
 * Longest accepted title, in characters, measured after trimming.
 *
 * The server chose 120 against its slug bound rather than independently of it: the slug is derived
 * within 80 characters and truncated on a word boundary, so a longer headline still yields a slug
 * made of whole words. Wider than any surface renders in full — a search result shows roughly 60
 * characters and a social card roughly 70 — so the bound rejects abuse rather than constraining
 * authorship.
 */
const TITLE_MAX_LENGTH = 120;

/**
 * Longest accepted excerpt, in characters, measured after trimming.
 *
 * The excerpt is what stands in for the body: the paragraph on a feed card, the page's meta
 * description, and the description on its social card. 500 characters comfortably holds the two or
 * three sentences those surfaces render.
 */
const EXCERPT_MAX_LENGTH = 500;

/**
 * Longest accepted post body, in characters.
 *
 * Generous but finite — roughly sixteen thousand words, several times the longest article anyone
 * writes for a blog, so it never constrains authorship. The ceiling is not arbitrary either: the
 * server re-derives a `tsvector` search index from the title, excerpt and body on every write, and
 * a `tsvector` may not reach one mebibyte. Beyond that the insert fails inside the database. This
 * bound keeps the combined vector an order of magnitude clear of it, and refusing an oversized
 * body here means the author is told which field is too long rather than shown a failed save.
 */
const CONTENT_MAX_LENGTH = 100_000;

/**
 * The schemes a cover image address may use: `http` and `https`, and nothing else.
 *
 * Matched against the URL's protocol with its trailing colon removed, which is what
 * `z.url({ protocol })` compares. Anchored at both ends so `javascript:` cannot satisfy it by
 * containing `http` anywhere, and `s?` rather than two alternatives so the pattern reads as the one
 * rule it is. See {@link optionalCoverImageUrl} for why the scheme is restricted here while the host
 * allow-list is not.
 */
const HTTP_SCHEME_PATTERN = /^https?$/;

/**
 * The longest cover image address the service will store: 2083 code points.
 *
 * Not a number chosen here. `pydantic.HttpUrl` carries this ceiling inherently and publishes it as
 * `maxLength` in the generated schema, so it is the service's constraint restated - which is the whole
 * job of this module. Without it a longer address is a `422` that arrives only after the author has
 * submitted a finished post.
 */
const COVER_IMAGE_URL_MAX_LENGTH = 2083;

/**
 * Most categories one submission may file a post under.
 *
 * A cap rather than a limit anyone reaches: a post genuinely belongs to one to three categories.
 * What it prevents is an unbounded association set, where a single request could name every
 * category in the database and the server would write that many association rows on the strength
 * of one payload.
 */
const MAX_CATEGORIES_PER_POST = 10;

/* -------------------------------------------------------------------------------------------------
 * Field schemas
 *
 * One schema per field, declared once and referenced by both request shapes — the same structure
 * `backend/app/schemas/post.py` uses, where `PostTitle`, `OptionalPostExcerpt`, `PostContent`,
 * `OptionalCoverImageUrl` and `CategoryIdList` are each declared once and then referenced by both
 * `PostCreate` and `PostUpdate`. The reason is the same on both sides of the wire: a bound
 * tightened for a create and forgotten for a patch would let a value in through the second route
 * that the first refuses, and a message improved in one place and not the other would give the same
 * mistake two different explanations.
 *
 * MESSAGE STRINGS HERE ARE USER INTERFACE. Each one is rendered as the inline, label-associated
 * error beneath its field, so each names the field it belongs to and says what is actually
 * required. None is "Invalid input" or a bare "Required", and none dumps a raw constraint. That is
 * a usability requirement and a testability one: the component suite asserts on visible text and
 * accessible names rather than on class names, so a vague message cannot be asserted against.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Why every bound in this file is applied through a refinement rather than through zod's `.max()`.
 *
 * `.min()`/`.max()` on a string read `String.prototype.length`, which counts UTF-16 **code units**.
 * The service's constraints are Python `len()`, which counts **code points**. The two agree for ASCII
 * and disagree for every character above `U+FFFF` - an emoji, a historic script, a rare ideograph -
 * which each count as two units and one code point.
 *
 * That divergence breaks the mirror in the direction that matters most here: a ceiling written in code
 * units rejects text the service would have accepted, at exactly half the length for astral text. An
 * author who writes in one of those scripts is told a perfectly valid title or body is too long, by a
 * check whose only job was to save them a round trip. `@/lib/validation/auth` already measured this
 * way and recorded two observed cases against the running service;
 * `@/lib/utils#codePointLength` is now that measurement, shared by all four validators and by
 * `@/lib/seo`'s truncation, so one notion of length governs the tier.
 *
 * `abort: true` matches the convention in this tier: once a length has failed, later checks on the
 * same field are not run, so one mistake produces one sentence.
 */

/**
 * The post's headline: required, trimmed, and bounded.
 *
 * `.trim()` is applied before the length checks, which is both the server's order and the one that
 * makes the bounds mean what an author expects. Three consequences, all verified against
 * `backend/app/schemas/post.py`:
 *
 * 1. `'  Scaling FastAPI  '` is accepted and submitted as `'Scaling FastAPI'`.
 * 2. `'   '` collapses to `''` and is rejected by {@link TITLE_MIN_LENGTH}, so a whitespace-only
 *    headline cannot be saved.
 * 3. A padded value whose trimmed length is within {@link TITLE_MAX_LENGTH} is accepted, rather
 *    than being rejected for padding the author cannot see.
 *
 * Trimming matters a second time because the title is the **input to slug derivation**. The server
 * derives the post's permanent URL from this value, so leading whitespace would be one more thing
 * that derivation had to defend against — and an empty or whitespace-only title would produce a
 * degenerate canonical URL for a post that can never be renamed out of it.
 *
 * The ceiling is a `.refine()` over `codePointLength` from `@/lib/utils`, not zod's `.max()`, and the
 * three bounded fields in this module share that treatment for one reason: the server's
 * `StringConstraints` count Python code points, while `.max()` reads `String.prototype.length` and
 * scores every character above `U+FFFF` twice. A 120-character headline containing emoji or an
 * astral script measures up to 240 there, so `.max()` would refuse a title the API accepts — and
 * refuse it at roughly half the advertised bound, in a message that names the bound it just
 * contradicted. The floor stays `.min()` because {@link TITLE_MIN_LENGTH} is `1`, where the two units
 * cannot disagree.
 */
const postTitle = z
  .string({ error: 'Enter a title for this post.' })
  .trim()
  .min(TITLE_MIN_LENGTH, { error: 'Enter a title for this post.' })
  .refine((value) => codePointLength(value) <= TITLE_MAX_LENGTH, {
    error: `Title must be ${String(TITLE_MAX_LENGTH)} characters or fewer.`,
    abort: true,
  });

/**
 * The optional short summary: trimmed, bounded, and blank-folded to `null`.
 *
 * "This post has no excerpt" already has one representation — `null` — and an empty string would be
 * a second representation of the same state. Two spellings of one state is a defect waiting to
 * happen: a template writing `excerpt ?? fallback` treats them differently from one writing
 * `excerpt === null`.
 *
 * A form is exactly where that ambiguity comes from, because a browser cannot send an absent field
 * from a populated form: an author who clears the excerpt textarea submits `''`, meaning "remove
 * this". The transform folds that to `null` so the intent survives, reproducing the server's own
 * `_blank_to_none` behaviour rather than diverging from it. Verified equivalent for every case:
 *
 * | Submitted    | Result                                                     |
 * | ------------ | ---------------------------------------------------------- |
 * | omitted      | absent — on a create the post has none; on a patch, unchanged |
 * | `null`       | `null` — on a patch, this is the instruction to clear it    |
 * | `''`         | `null`                                                     |
 * | `'   '`      | `null`                                                     |
 * | `'  hi  '`   | `'hi'`                                                     |
 * | 501 chars    | rejected                                                   |
 *
 * There is no minimum length, and none is needed: any value that survives the fold has at least one
 * non-whitespace character by construction. Adding `.min(1)` would reject the cleared textarea the
 * fold exists to accept — the "stricter than the API" failure, in the one place it is easiest to
 * introduce.
 *
 * `.nullable()` wraps the whole chain rather than sitting inside it, so a submitted `null`
 * short-circuits to `null` instead of being measured as a string.
 *
 * The ceiling is measured in code points for the reason {@link postTitle} sets out, and it sits
 * before the fold so that ordering is unchanged: a whitespace-only value of any length has already
 * become `''` and folds to `null` rather than being reported as too long.
 */
const optionalPostExcerpt = z
  .string({ error: 'Excerpt must be text. Leave it empty if this post does not need one.' })
  .trim()
  .refine((value) => codePointLength(value) <= EXCERPT_MAX_LENGTH, {
    error: `Excerpt must be ${String(EXCERPT_MAX_LENGTH)} characters or fewer.`,
    abort: true,
  })
  .transform((value) => (value === '' ? null : value))
  .nullable();

/**
 * The post body as authored Markdown: required, bounded, and **never altered**.
 *
 * `.trim()` is deliberately absent, and this is the one field in the module whose value is
 * submitted exactly as it was typed. Leading whitespace is significant in Markdown — a four-space
 * indent opens a code block — so trimming the body would silently change the document a reader is
 * shown. The server takes the same position and stores the body byte for byte.
 *
 * That leaves the whitespace-only case to catch without touching the value, which is what the
 * refinement does. It is a single check rather than a minimum length plus a refinement, because
 * `''` would otherwise fail both and report two messages for one mistake; one check covers the
 * empty body and the whitespace-only body with the one message that is actionable for both.
 *
 * Nothing here sanitises, escapes or parses. Markup in the body is expected and is cleaned at the
 * two boundaries named in the module header, so `'<script>alert(1)</script>'` passes this schema
 * unchanged — by design, not by omission.
 *
 * The ceiling is measured in code points for the reason {@link postTitle} sets out, and this is the
 * field where the divergence bites hardest: a hundred thousand code points of Latin prose and a
 * hundred thousand of an astral script are the same length to the service and differ by a factor of
 * two to `String.prototype.length`.
 */
const postContent = z
  .string({ error: 'Enter the post content.' })
  .refine((value) => codePointLength(value) <= CONTENT_MAX_LENGTH, {
    error: `Content must be ${String(CONTENT_MAX_LENGTH)} characters or fewer.`,
    abort: true,
  })
  .refine((value) => value.trim() !== '', {
    error: 'Enter the post content. It cannot be empty or only spaces.',
  });

/**
 * The optional cover image, as an absolute `https` URL on an allow-listed host: blank-folded to
 * `null`.
 *
 * A URL reference and nothing more. This product has no upload pipeline and no object storage, so a
 * cover image is a link an author pastes, and `null` is the ordinary case rather than an
 * exceptional one — a post without one gets the generated default social card.
 *
 * **The scheme allow-list is a security boundary, not a matter of taste.** This value is interpolated
 * into an image source on every card and every post page, so restricting it to `http` and `https` is
 * what keeps an author-supplied field from becoming a script vector: a bare `z.url()` accepts
 * `javascript:alert(1)` and `data:` URLs. The server enforces the same two schemes through
 * `pydantic.HttpUrl`, so anything else here would disagree with it.
 *
 * It is expressed as `z.url({ protocol: /^https?$/ })` rather than as `z.httpUrl()`, and that choice
 * is the correction to a real divergence. `z.httpUrl()` restricts the scheme AND requires a DNS-style
 * domain, which `HttpUrl` does not: verified against the installed zod 4.4.3, `z.httpUrl()` rejects
 * `http://localhost:3000/cover.png`, `http://127.0.0.1/cover.png` and `http://[::1]/cover.png`, all
 * three of which the service accepts. Every one of those is a real address in this project's own
 * development and container environments, so the stricter rule refuses a value the API would have
 * stored - the "stricter than the API" failure this module exists to avoid. Restricting the protocol
 * alone keeps every rejection the security boundary needs while dropping the host restriction that
 * was never part of the contract.
 *
 * **The 2083-code-point ceiling is the server's, restated.** `pydantic.HttpUrl` carries an inherent
 * limit of 2083 characters and publishes it as `maxLength`, so a longer URL is a `422` - and without
 * this check it would be a `422` arriving after a full submission of a post the author had finished
 * writing. Measured in code points for the reason given above the title field, and applied to the
 * trimmed value the way the server applies it to what it receives.
 *
 * Behaviour for every case, including the three the host policy adds:
 *
 * | Submitted                                        | Result                                      |
 * | ------------------------------------------------ | ------------------------------------------- |
 * | omitted / `null` / `''` / `'   '`                | `null` — no cover image                     |
 * | `'https://images.unsplash.com/photo-1.jpg'`      | accepted                                    |
 * | `'  https://picsum.photos/seed/a/1200/630 '`      | accepted, trimmed                           |
 * | `'https://example.com/cover.png'`                | rejected — host not on the allow-list       |
 * | `'http://images.unsplash.com/photo-1.jpg'`       | rejected — not TLS                          |
 * | `'https://u:p@images.unsplash.com/p.jpg'`        | rejected — embedded credentials             |
 * | `'http://localhost:3000/cover.png'`              | rejected — host not on the allow-list       |
 * | `'javascript:alert(1)'`                          | rejected — scheme not allowed               |
 * | `'data:image/png;base64,…'`                      | rejected — scheme not allowed               |
 * | `'ftp://example.com/cover.png'`                  | rejected — scheme not allowed               |
 * | `'/covers/cover.png'`                            | rejected — not absolute                     |
 * | `'http://'`                                      | rejected — no host                          |
 * | 2084 code points                                 | rejected — the server's own ceiling         |
 *
 * **The host allow-list IS checked here, through the one predicate that owns it.** `src/lib/utils.ts`
 * holds that policy - `IMAGE_HOST_ALLOWLIST` and `isAllowedImageUrl`, which together require `https`,
 * no embedded credentials, and a hostname on the list - `frontend/next.config.ts` derives the image
 * optimiser's `remotePatterns` from the same constant, and every renderer (`PostCard`,
 * `PostContent`, `Avatar`) already asks it before emitting an image. Calling it rather than restating
 * it is what keeps this from being a second copy: the hosts are named once, in `@/lib/utils`, and
 * adding one admits it everywhere at once.
 *
 * It is checked because the alternative was measured and is worse. Accepting any absolute `http(s)`
 * URL let an author save a cover the product then refuses to render: the field validated, the request
 * succeeded, and the image silently never appeared on the feed card or the post page, while the
 * OpenGraph and `BlogPosting` metadata - which a crawler fetches directly, without passing through
 * the image optimiser - still advertised it. That is a saved-but-not-rendered state with no message
 * anywhere, and it contradicted the authoring form's own help text, which names the admitted hosts.
 * Refusing at the authoring boundary turns it into an inline field error the author can act on, and
 * makes one policy true of validation, rendering and metadata alike.
 *
 * The check is deliberately narrower than the server's, and that direction is the safe one: every
 * value this schema accepts is a value `pydantic.HttpUrl` accepts, so nothing here can be rejected by
 * the service for a rule this module invented. The reverse - a host an operator is about to add to the
 * allow-list - is a code change to that constant, reviewed like any other, and until it lands the
 * image genuinely cannot be displayed.
 *
 * Reachability is still not checked: that would be an HTTP request this module may not make, and a URL
 * that is briefly unreachable is not an invalid URL.
 *
 * The fold runs before the URL rules so a cleared input becomes `null` rather than failing them, and
 * `.pipe()` carries the folded value into the URL check so the non-null branch is still fully
 * validated. As with the excerpt, the outer `.nullable()` lets a submitted `null` short-circuit.
 */
const optionalCoverImageUrl = z
  .string({
    error: 'Cover image must be a web address. Leave it empty for no cover image.',
  })
  .trim()
  .transform((value) => (value === '' ? null : value))
  .pipe(
    z
      .url({
        protocol: HTTP_SCHEME_PATTERN,
        error:
          'Enter the full web address of the cover image, starting with http:// or https:// — for example https://example.com/cover.png.',
      })
      .refine((value) => codePointLength(value) <= COVER_IMAGE_URL_MAX_LENGTH, {
        error: `Shorten the cover image address to ${String(COVER_IMAGE_URL_MAX_LENGTH)} characters or fewer.`,
        abort: true,
      })
      // The shared safe-image predicate, called rather than re-implemented: `https`, no embedded
      // credentials, and a hostname on `IMAGE_HOST_ALLOWLIST`. Placed after the length check, which
      // aborts, so an over-long address reports its own reason and not this one as well.
      .refine((value) => isAllowedImageUrl(value), {
        error:
          `The cover image must be an https address on one of: ${IMAGE_HOST_ALLOWLIST.join(', ')} — ` +
          `and must carry no username or password. Images on other hosts are not served by this ` +
          `site, so a cover stored from one would save and then never appear.`,
      })
      .nullable(),
  )
  .nullable();

/**
 * The categories to file the post under: a bounded list of category identifiers.
 *
 * Each element is a category's server-generated identifier, taken from `CategorySummary.id` — an
 * author picks categories from a control populated by `GET /api/v1/categories` and never types one,
 * which is why the element check is a plain identifier format check and not a lookup. Whether a
 * category actually **exists** is a foreign-key question over the association table that only the
 * server can answer, and answering it here would require an HTTP call this module is not permitted
 * to make.
 *
 * Order carries no meaning — the association is a set — and a repeated identifier has the same
 * effect as naming it once, because the server collapses duplicates before writing.
 *
 * There is no minimum: an empty list is valid and means "uncategorised" on a create and "remove
 * every category" on a patch. The bound is a maximum only, and it is declared on this shared schema
 * rather than at each field so the create and the patch cannot be capped differently.
 *
 * A bad element reports against the element, so the issue path is `['category_ids', 0]` rather than
 * `['category_ids']`, and the message is written to read correctly in either position. Note that
 * this check accepts the canonical hyphenated form in either case; the server additionally tolerates
 * an unhyphenated identifier, which is a form nothing in this tier can produce because every value
 * originates from the API in canonical form.
 */
const categoryIdList = z
  .array(
    z.uuid({
      error: 'Choose categories from the list — one of the selected categories is not recognised.',
    }),
    { error: 'Choose the post’s categories from the list.' },
  )
  .max(MAX_CATEGORIES_PER_POST, {
    error: `Choose at most ${String(MAX_CATEGORIES_PER_POST)} categories for this post.`,
  });

/* -------------------------------------------------------------------------------------------------
 * The two request shapes
 *
 * MEMBERS NEITHER SCHEMA DECLARES, AND WHY EACH ONE IS REFUSED FOR ITS OWN REASON
 *
 * `id`, `slug`, `status`, `published_at`, `view_count` and `author_id` are absent from both schemas,
 * and so are `created_at` and `updated_at`. "Server-owned" is the summary, but it is not the
 * reasoning, and the reasoning is what stops the wrong one being helpfully added back later:
 *
 *   id             Identity is a UUID generated by PostgreSQL. The service this product replaced
 *                  made the client the sole source of identity, so two records could be stored
 *                  under one identifier and the first permanently shadowed the second on every
 *                  read, update and delete. A server-generated key removes that defect class
 *                  outright, and there is nothing for a form to supply.
 *
 *   slug           Derived from the title, server-side, once — and then never changed. The slug IS
 *                  the canonical URL: `GET /api/v1/posts/{slug}` resolves against it, every
 *                  canonical link tag is built from it, and the generated sitemap enumerates it. An
 *                  editable slug field would let an author silently break every inbound link that
 *                  has already been published or indexed. Retitling a post deliberately does not
 *                  move it, which is why the title field above is not a disguised slug field.
 *
 *   status,        Publication is a first-class state transition, not a flag on this form:
 *   published_at   `POST /api/v1/posts/{id}/publish` and `POST /api/v1/posts/{id}/unpublish` set
 *                  both members together, and a database CHECK constraint forbids a published post
 *                  with no publication instant. The editor's "Publish" button therefore calls that
 *                  endpoint; it does not submit a status through this schema. Adding either member —
 *                  or importing the status union to type it — would advertise a way to reach half of
 *                  a paired change.
 *
 *   view_count     A server-maintained counter. A counter a client could set is not a counter.
 *
 *   author_id      Taken from the principal the API resolved from the bearer token. Reading
 *                  ownership out of a request body would let any authenticated caller publish under
 *                  another account's byline.
 *
 *   created_at,    Stamped from the database clock. An audit column a caller could set is not an
 *   updated_at     audit column.
 *
 * UNKNOWN MEMBERS ARE REJECTED, NOT STRIPPED
 *
 * Both schemas are `z.strictObject`, so a member neither of them declares fails validation and is
 * named in the failure. This matches the service exactly: `PostCreate` and `PostUpdate` both declare
 * `extra='forbid'`, so the two ends agree about what a body may contain *and* about what happens when
 * it contains something else.
 *
 * Stripping was the earlier behaviour, and the argument for it does not survive contact with the
 * failure it permits. A misspelled member - `categoryIds` for `category_ids`, `coverImage` for
 * `cover_image_url` - simply disappeared: the parse succeeded, the request succeeded, and the post
 * saved without the categories or the cover image the author had chosen, with nothing reported
 * anywhere. That is worse than a rejection, because it looks like success. Rejecting turns it into a
 * message naming the key.
 *
 * The cost is real and is paid where it belongs. Editor state legitimately carries members the wire
 * has none of - a preview toggle, an unsaved-changes marker, a slug preview - and strictness applies
 * to whatever is handed in, so the editor must **project the wire fields out of its state before
 * validating**: `postCreateSchema.parse({ title, excerpt, content, cover_image_url, category_ids })`
 * rather than `postCreateSchema.parse(editorState)`. That projection belongs at the submit boundary,
 * which is the one place that already knows which of its fields are the request. It also keeps the
 * escalation guard intact: a server-owned value in the input is now reported rather than quietly
 * discarded, and either way cannot be sent.
 * ---------------------------------------------------------------------------------------------- */

/**
 * What `postCreateSchema` has to be, asserted against the request type rather than assumed.
 *
 * Both halves are checked by the `satisfies` clause on the schema, and `satisfies` is erased by the
 * compiler, so neither costs a byte at runtime. Together they turn four otherwise-silent drift
 * modes into compile errors on this file — verified by deliberately introducing each one:
 *
 * `z.ZodType<PostCreate>`
 *     The schema's **output** — which is exactly {@link PostCreateFormValues} — must be assignable
 *     to the `PostCreate` request type in `src/lib/types.ts`, which mirrors the Pydantic model field
 *     for field. Catches a retyped field and, importantly, a wrongly nullable one: making `title`
 *     nullable here fails this clause, because the server refuses a null title.
 *
 * `{ shape: Record<keyof PostCreate, z.ZodType> }`
 *     The schema must declare a member under **every** name the request type uses. This is the half
 *     that catches the mistake with the worst symptom: renaming `cover_image_url` to
 *     `coverImageUrl`. Output assignability alone does not catch it — the misnamed member is simply
 *     an extra property, and the correctly named one is optional — so without this clause the form
 *     would submit successfully, the API would ignore the member, and the post would save with no
 *     cover image and no error reported anywhere. It equally catches a member dropped by accident.
 *
 * Only `.shape` is constrained rather than the whole `ZodObject` type, deliberately: constraining
 * the object type would drag its computed output in and force every member to be non-optional,
 * which is the opposite of the contract.
 */
type PostCreateBody = z.ZodType<PostCreate> & { shape: Record<keyof PostCreate, z.ZodType> };

/**
 * What `postUpdateSchema` has to be. The same two-part assertion as {@link PostCreateBody}, with
 * one addition that is the most valuable line in this module.
 *
 * `z.ZodOptional<z.ZodType>` as the shape's value type requires **every** member of the update
 * schema to be optional. That is a structural, compile-time proof that the patch body is a genuine
 * partial update and not a whole-object replacement — the exact defect this route was created to
 * remove, where a submitted object was assigned over the stored one and a client holding a stale
 * copy silently reverted every field it had not refreshed.
 *
 * Output assignability cannot make that check on its own: a fully required create body is perfectly
 * assignable to `PostUpdate`, so dropping the `.partial()` call would type-check and then quietly
 * start clearing fields the author never touched. Verified by removing it — this clause is what
 * fails.
 */
type PostUpdateBody = z.ZodType<PostUpdate> & {
  shape: Record<keyof PostUpdate, z.ZodOptional<z.ZodType>>;
};

/**
 * The body of `POST /api/v1/posts` — everything about a new post a human decides.
 *
 * A title and a body are the only required members; the excerpt, the cover image and the categories
 * are all optional, because a post is publishable without any of them. This is a complete, valid
 * submission:
 *
 * ```ts
 * postCreateSchema.parse({ title: 'Scaling FastAPI', content: '## Why one process was never enough' });
 * ```
 *
 * The request always creates a **draft**, with no way to ask otherwise — see the note on `status`
 * above. Everything else about the stored row is the server's to produce, which is why there are
 * five members here and not thirteen.
 *
 * {@link PostCreateBody} records what the `satisfies` clause proves and which mistakes it turns into
 * compile errors. `satisfies` is chosen over an explicit type annotation because an annotation would
 * flatten the precise `ZodObject` type — `.shape` would stop being readable by a consumer, and the
 * `.partial()` call below would stop resolving.
 */
export const postCreateSchema = z.strictObject({
  title: postTitle,
  excerpt: optionalPostExcerpt.optional(),
  content: postContent,
  cover_image_url: optionalCoverImageUrl.optional(),
  category_ids: categoryIdList.optional(),
}) satisfies PostCreateBody;

/**
 * The values the create form produces, and the body it submits.
 *
 * `{ title: string; excerpt?: string | null; content: string; cover_image_url?: string | null;
 * category_ids?: string[] }` — structurally identical to `PostCreate` in `src/lib/types.ts`, which
 * is what the `satisfies` clause above proves rather than assumes.
 *
 * This is the type to hand `useForm` in the editor. The resolver itself comes from
 * `zodResolver(postCreateSchema)` in the component; it is not imported here, because a schema module
 * that reached for the form library would stop being usable from a Server Component.
 */
export type PostCreateFormValues = z.infer<typeof postCreateSchema>;

/**
 * The body of `PATCH /api/v1/posts/{id}` — whichever members are actually changing.
 *
 * A **genuine partial update**, and that is the whole point of the route. Every member is optional,
 * and an omitted member means "leave this as it is" rather than "reset this". The route it serves
 * replaced a whole-object replacement that assigned the submitted object over the stored one, so a
 * client holding a stale copy silently reverted every field it had not refreshed. An empty
 * submission is therefore valid and is a no-op:
 *
 * ```ts
 * postUpdateSchema.parse({});                          // {} — changes nothing
 * postUpdateSchema.parse({ title: 'A better title' }); // touches the title and nothing else
 * ```
 *
 * Derived from {@link postCreateSchema} with `.partial()` rather than written out again, and the
 * derivation is the guarantee: the two shapes cannot drift, and a member added to the create form
 * cannot be forgotten here. It is also the exact structure the server uses, where both models
 * reference one shared alias per field.
 *
 * The derivation **preserves strictness** - verified rather than assumed against the pinned zod
 * version: an unknown member is rejected here exactly as it is on the create schema, while `{}`
 * remains a valid no-op. So an edit form must project the wire members out of its state before
 * validating, for the reason recorded in the section on unknown members above.
 *
 * `.partial()` produces precisely the right optionality because of how the fields above are built —
 * `title` and `content` become optional but stay non-nullable, while `excerpt` and
 * `cover_image_url` were already nullable and keep it. That distinction is not incidental. On a
 * patch, `null` means "clear this", and it is meaningful for the two members a post can legitimately
 * do without and meaningless for the two it cannot: sending `null` for a title or a body describes
 * no state a post can be in, and the server refuses it. `category_ids` stays non-nullable for the
 * same reason — omitting it leaves the categories untouched and sending `[]` removes them all, so a
 * third spelling would only be ambiguous.
 *
 * Note that `.partial()` here is what keeps the omitted-versus-empty distinction intact for
 * `category_ids`: because the create schema attaches no default to it, an omitted value stays
 * omitted instead of arriving at the API as an empty list that would unfile the post.
 *
 * {@link PostUpdateBody} is what stops the derivation being taken away again: it proves structurally
 * that every member here is optional, so removing the `.partial()` call is a compile error rather
 * than a silent return to whole-object replacement.
 */
export const postUpdateSchema = postCreateSchema.partial() satisfies PostUpdateBody;

/**
 * The values the edit form produces, and the body it submits.
 *
 * `{ title?: string; excerpt?: string | null; content?: string; cover_image_url?: string | null;
 * category_ids?: string[] }` — structurally identical to `PostUpdate` in `src/lib/types.ts`, proved
 * by the `satisfies` clause above.
 *
 * Every member being optional is the contract, not a convenience: the editor sends what the author
 * changed, and `JSON.stringify` drops an `undefined` member, so an untouched field never reaches the
 * API and is never overwritten.
 */
export type PostUpdateFormValues = z.infer<typeof postUpdateSchema>;
