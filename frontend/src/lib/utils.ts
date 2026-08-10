// Shared, dependency-free utilities for the presentation tier.
//
// Five concerns live here, and all five are here for the same reason: more than one layer of the
// frontend needs them, and each must have exactly ONE definition or the layers silently disagree.
// AAP §0.4.5.3 names four modules under `src/lib/` - `types`, `utils`, `seo`, `format` - so this is
// the only home a cross-cutting helper has, and the sections below are the concerns that earned one.
//
// 1. CLASS-NAME COMPOSITION — `cn()`. Every primitive under `src/components/ui/` routes its
//    variant classes and its caller-supplied `className` through it: the nine authored over raw
//    elements (button, input, textarea, card, badge, table, pagination, alert, skeleton) and the
//    six wrapping Radix behavioural primitives (select, label, dialog, dropdown-menu, tabs,
//    avatar) alike.
//
// 2. THE REMOTE-IMAGE HOST POLICY — `IMAGE_HOST_ALLOWLIST` and `isAllowedImageUrl()`. This
//    product stores every cover image and avatar as a URL and has no upload, image-processing or
//    object-storage pipeline, so a remote host is named by data rather than by us. Two
//    independent places have to agree about which hosts are admissible: `next.config.ts`, which
//    configures the image optimiser, and every component that renders one of those URLs. When
//    those two disagree the failure is not cosmetic — either the optimiser refuses a URL the
//    service happily stored, or a component renders a URL the policy was supposed to exclude and
//    the reader's browser contacts a host chosen by whoever authored the record. Both halves
//    therefore read this module's policy, and `next.config.ts` derives its `remotePatterns` from
//    it, so there is one list and not two.
//
// 3. HOW LONG A STRING IS, AND WHERE TO CUT IT - `codePointLength()` and `sliceByCodePoints()`.
//    Every length bound this tier enforces mirrors one the service enforces, and the two count in
//    different units unless something makes them agree: JavaScript's `String.prototype.length`
//    counts UTF-16 code units, Python's `len` counts code points, so one emoji is 2 to the browser
//    and 1 to the API. All four modules under `src/lib/validation/` measure through
//    `codePointLength` for that reason, and none of them may reach for `.length` or for zod's own
//    `.min`/`.max` on a bound the service also declares. Four copies of a one-line function would
//    be four chances for one of them to drift.
//
//    The same arithmetic governs truncation, which is why the cut belongs beside the count. Cutting
//    at a UTF-16 index can land BETWEEN the two halves of a surrogate pair, and the result is a
//    string ending in an unpaired surrogate: not valid UTF-8 when serialised, rendered as a
//    replacement character, and published in a meta description or a social card that a reader and
//    a crawler both see. `@/lib/seo` is the one caller that cuts, and it cuts through
//    `sliceByCodePoints` so that cannot happen. The two API wrappers that guard a search term -
//    `@/lib/api/posts` and `@/lib/api/admin` - only measure, so they call `codePointLength` alone.
//
// 4. ONE PATH SEGMENT AT A TIME - `encodePathSegment()`. Every wrapper under `@/lib/api` and every
//    canonical-URL builder in `@/lib/seo` interpolates a caller-supplied identifier - a UUID, a
//    slug, a handle - into a request path or a public URL. `@/lib/api/client` interpolates the
//    composed path verbatim, and it is right to: encoding a whole path would destroy its
//    separators. Encoding each SEGMENT is therefore the composing module's job, and each composer
//    used to do it slightly differently. Five percent-encoded and stopped there, which contains a
//    stray `/`, `?` or `#` but leaves `.` and `..` intact - and those two are not characters to
//    escape, they are instructions the URL grammar itself acts on. `encodeURIComponent('..')`
//    returns `'..'`, so a path built as `/posts/../users/me` addresses a different endpoint than
//    the one the call site names, on a route the caller may hold a credential for; the request
//    succeeds, nothing reports an error, and the call site's own text still reads as though it
//    addressed a post. One rule, seven call sites.
//
// 5. PAGE ARITHMETIC - `toPageNumber()`, `derivePagination()` and `formatResultRange()`. Three
//    surfaces window results - the home feed, an author's profile, and all four administrative
//    tables - and AAP §0.1.3 lists "a uniform pagination contract" as a prerequisite precisely so
//    they cannot disagree. `@/hooks/use-pagination` was that single implementation and very nearly
//    worked: being a hook, it is reachable only from a client component, so
//    `components/blog/post-list.tsx` - a Server Component, deliberately, because the feed's rows
//    must be in the initial HTML for the SEO requirement - could not call it and grew its own
//    private range calculation, while `components/admin/data-table.tsx` grew a second copy of the
//    range sentence. Two copies of one rule is how "Showing 37-47 of 47 results" and
//    "Showing 37-48 of 47 results" end up on two pages of the same product.
//
// THE DIRECTIVE IS THE CONSTRAINT THAT TIES ALL FIVE TOGETHER. This module carries no
// `'use client'`, and that is load-bearing rather than tidy. Concern 5 in particular is called
// DURING SERVER RENDER by `components/blog/post-list.tsx`; a directive here would turn every export
// below into a client-reference proxy, and calling one of those from a Server Component fails at
// run time rather than at build time. Concern 4 is called by the API wrappers, which both tiers of
// component reach. So nothing here may ever import React, `next/navigation`, or anything that
// carries the directive transitively, and nothing here may become a hook. These functions take
// numbers and strings and return numbers and strings.
//
// Its only VALUE imports are `clsx` and `tailwind-merge`, both of which concern 1 alone uses;
// `Page` is a TYPE-only import from `@/lib/types`, erased at compile time, so the page arithmetic
// adds no runtime edge to the module graph and no cycle (`types.ts` imports only `zod`). The module
// READS NO ENVIRONMENT VARIABLE: the host policy below is source code, for the reasons set out
// above its declaration.

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import type { Page } from '@/lib/types';

/**
 * Composes Tailwind class names, then resolves conflicts between them deterministically.
 *
 * Exactly two responsibilities, applied in this order:
 *
 * 1. **Conditional composition** (`clsx`) — flattens variadic arguments, nested arrays and
 *    `{ className: boolean }` dictionaries into one space-separated string, discarding every
 *    falsy entry (`undefined`, `null`, `false`, `''`).
 * 2. **Deterministic conflict resolution** (`twMerge`) — parses that string and applies
 *    last-wins resolution *within each Tailwind property group*, so `'px-2 px-4'` collapses to
 *    `'px-4'` while `'px-4 py-2'` survives intact because those are different groups.
 *
 * ### Do not "simplify" this to `clsx` alone
 *
 * The second step is load-bearing, not cosmetic. It is what lets a `class-variance-authority`
 * variant table emit a base class set that a caller's `className` prop can predictably override:
 * the caller's class appears later in the argument list, so it wins its group. Drop `twMerge` and
 * both classes survive, the winner is decided by stylesheet source order instead of call order,
 * and authors start reaching for inline styles and arbitrary values to win specificity fights.
 * That is precisely how the token-only discipline this design system depends on collapses — the
 * rule that every CSS value resolve to a token declared in `src/app/globals.css` is enforceable
 * only because overrides behave predictably here.
 *
 * The order is equally fixed: `clsx` must run first. `twMerge` consumes class *strings*, not the
 * object and array shapes callers pass, so it cannot flatten conditional input on its own.
 *
 * `twMerge` is deliberately used with its default configuration, which already understands the
 * Tailwind CSS 4.x class grammar this project targets. That includes the project's semantic
 * colour tokens — `bg-surface` and `bg-primary` are correctly treated as one mutually exclusive
 * group — so a hand-maintained `extendTailwindMerge` config would add drift risk for no gain.
 *
 * @param inputs - Any mix of strings, numbers, nested arrays, `{ className: boolean }`
 *   dictionaries and falsy values. Falsy entries are dropped rather than rendered.
 * @returns A single space-separated class string with intra-group conflicts resolved. Yields an
 *   empty string when no truthy class survives; never returns `undefined` and never throws.
 *
 * @example Conditional composition
 * ```ts
 * cn('rounded-md border', isActive && 'ring-2', { 'opacity-50': isDisabled });
 * ```
 *
 * @example Letting a caller override a variant default
 * ```ts
 * // Resolves to `px-6`: the caller's class comes last, so it wins the padding group.
 * cn(buttonVariants({ size: 'sm' }), 'px-6');
 * ```
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/* -------------------------------------------------------------------------------------------------
 * Remote-image host policy
 *
 * One list, read by two consumers that must never diverge:
 *
 *   - `next.config.ts` maps {@link IMAGE_HOST_ALLOWLIST} into `images.remotePatterns`, which is
 *     what the image optimiser will fetch from.
 *   - Every component that renders a stored image URL asks {@link isAllowedImageUrl} first, and
 *     falls back to something it owns when the answer is no.
 *
 * The service accepts any absolute `http(s)` URL for `cover_image_url` and `avatar_url`
 * (`pydantic.HttpUrl`), so a stored record can legitimately name a host this tier will not fetch
 * from. That is precisely why the predicate exists: the presentation tier decides in ONE place,
 * before a URL reaches the DOM, and degrades deliberately - a cover placeholder, an avatar's
 * initials - instead of emitting a request the optimiser rejects or a request to a host chosen by
 * whoever authored the record.
 *
 * SOURCE CODE, NOT CONFIGURATION - and deliberately so.
 *
 * `.env.example` is this repository's enforced configuration contract and it declares fourteen
 * variables: eleven backend fields and three public `NEXT_PUBLIC_` values. Admitting a remote
 * image host is not one of them, and making it one would be worse than verbose. `next.config.ts`
 * is evaluated once, when the application is built, so a host list supplied through the
 * environment could not be changed by the deployment that runs the image optimiser anyway - it
 * would read as run-time configuration while behaving as a build-time constant, and the backend
 * settings model would have to be widened to tolerate a fourth client key it has no use for.
 * More importantly, an environment-supplied list is an environment-supplied ATTACK SURFACE: this
 * list decides which third parties a reader's browser is asked to contact and what the optimiser
 * will fetch on the server's behalf, so a single mistyped or hostile value is the difference
 * between a closed allow-list and an open proxy. Declaring it here makes widening it a reviewed
 * code change, which is the right shape for that decision, and lets the grammar below be enforced
 * once, at the only place the list can be written.
 * ---------------------------------------------------------------------------------------------- */

/** RFC 1035 ceiling on a whole name, so an absurd entry is rejected rather than matched. */
const HOSTNAME_MAX_LENGTH = 253;

/** RFC 1035 ceiling on one dot-separated label. */
const HOSTNAME_LABEL_MAX_LENGTH = 63;

/** The one character that separates labels; every other punctuation mark is a rejection. */
const HOSTNAME_LABEL_SEPARATOR = '.';

/**
 * One label: lower-case alphanumerics, with interior hyphens only.
 *
 * Lower case is required rather than folded, because {@link isAllowedImageUrl} compares against a
 * lower-cased URL hostname - an upper-case entry would be a rule that silently never matches. The
 * character class is what excludes every non-hostname syntax in one stroke: `*` and `**`, a
 * `scheme://`, a `:port`, a `/path`, a `?query`, a `#fragment`, `user@`, and any whitespace.
 */
const HOSTNAME_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Whether *value* is a bare hostname, and therefore admissible in {@link IMAGE_HOST_ALLOWLIST}.
 *
 * A bare hostname is the ONLY form either consumer of the list can honour, and the two honour it
 * differently - `next.config.ts` hands each entry to the framework's own `remotePatterns` matcher
 * while {@link isAllowedImageUrl} compares it for equality - so anything richer than a hostname
 * means one of them is interpreting a value the other cannot. Wildcards are the case that matters:
 * the framework reads `*` and `**` as host-matching syntax, so an entry of `**` configures the
 * image optimiser to fetch from ANY host over `https` - an open proxy - while the exact comparison
 * in this module would still refuse every URL, so nothing in the rendered product would look wrong.
 * Rejecting the syntax outright is what makes that state unreachable.
 *
 * @param value - A candidate entry, exactly as written.
 * @returns `true` only for a lower-case, dot-separated hostname of non-empty labels within the
 *   RFC 1035 length limits. Total over its input and never throws.
 *
 * @example
 * ```ts
 * isBareHostname('images.unsplash.com');   // true
 * isBareHostname('**');                    // false - wildcard host syntax
 * isBareHostname('*.unsplash.com');        // false - wildcard subdomain syntax
 * isBareHostname('https://x.example');     // false - carries a scheme
 * isBareHostname('x.example:443');         // false - carries a port
 * isBareHostname('x.example/photos');      // false - carries a path
 * ```
 */
export function isBareHostname(value: string): boolean {
  if (value.length === 0 || value.length > HOSTNAME_MAX_LENGTH) {
    return false;
  }
  return value
    .split(HOSTNAME_LABEL_SEPARATOR)
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= HOSTNAME_LABEL_MAX_LENGTH &&
        HOSTNAME_LABEL_PATTERN.test(label),
    );
}

/**
 * Freeze the declared host list after proving every entry is a bare hostname.
 *
 * Called once, on the literal below, so a bad edit fails at module evaluation - which is during
 * `next build` for the optimiser's list and during the first import for the render predicates -
 * rather than becoming a rule that never matches or a pattern that matches everything. There is no
 * second way to reach {@link IMAGE_HOST_ALLOWLIST}, so passing through here is not a convention:
 * it is the only path the value has.
 *
 * @param hosts - The declared hostnames.
 * @returns The same hostnames, frozen so no consumer can append to the shared policy.
 * @throws Error naming every rejected entry and the grammar it failed.
 */
function validatedImageHosts(hosts: readonly string[]): readonly string[] {
  const rejected = hosts.filter((host) => !isBareHostname(host));
  if (rejected.length > 0) {
    throw new Error(
      `IMAGE_HOST_ALLOWLIST rejects ${rejected.length} entr${rejected.length === 1 ? 'y' : 'ies'}: ` +
        `${rejected.map((host) => JSON.stringify(host)).join(', ')}. Each entry must be a bare ` +
        `lower-case hostname - no scheme, no userinfo, no port, no path, no query, no fragment ` +
        `and no wildcard - because next.config.ts hands it to the image optimiser's host matcher ` +
        `and isAllowedImageUrl compares it exactly.`,
    );
  }
  return Object.freeze([...hosts]);
}

/**
 * The hosts this tier will fetch a remote cover image or avatar from.
 *
 * Four delivery hosts, each reached over TLS, each here for a named reason:
 *
 *   - `images.unsplash.com` and `picsum.photos` serve the demonstration cover photography the
 *     seeded content references, so the home feed and post detail render real images on a fresh
 *     checkout rather than four placeholders;
 *   - `res.cloudinary.com` is where an author's own uploaded cover is hosted, this product having
 *     no upload pipeline of its own;
 *   - `avatars.githubusercontent.com` is the default source of a user's avatar.
 *
 * Adding a fifth is a code change to this line, reviewed like any other, and it must also be a
 * hostname {@link isBareHostname} accepts - {@link validatedImageHosts} enforces that here rather
 * than trusting the next editor to remember it. Frozen, so a consumer cannot widen the shared
 * policy by mutating the array it was handed.
 */
export const IMAGE_HOST_ALLOWLIST: readonly string[] = validatedImageHosts([
  'images.unsplash.com',
  'picsum.photos',
  'res.cloudinary.com',
  'avatars.githubusercontent.com',
]);

/**
 * Decides whether a stored image URL may be fetched by this tier.
 *
 * Four conditions, all required. The URL must parse; it must use `https:`, because a plain-`http`
 * subresource on an `https` page is blocked as mixed content anyway and would leak the request in
 * clear text; it must carry no embedded credentials, which would otherwise travel to the host in
 * an `Authorization`-equivalent position; and its hostname must appear in
 * {@link IMAGE_HOST_ALLOWLIST}.
 *
 * Total over its input and never throws: `null`, `undefined`, an empty string, a relative path and
 * an unparseable string all answer `false`, so a caller needs no guard of its own.
 *
 * @param value - The stored URL, exactly as it arrived on the wire.
 * @param allowlist - The hosts to check against. Defaults to {@link IMAGE_HOST_ALLOWLIST}; passing
 *   a list explicitly is for tests, which must not depend on ambient configuration.
 * @returns `true` when the URL may be rendered, `false` when the caller must fall back.
 *
 * @example
 * ```ts
 * isAllowedImageUrl('https://images.unsplash.com/photo-1.jpg'); // true
 * isAllowedImageUrl('https://tracker.example/pixel.png');       // false - host not admitted
 * isAllowedImageUrl('http://images.unsplash.com/photo-1.jpg');  // false - not TLS
 * isAllowedImageUrl(null);                                      // false - nothing to render
 * ```
 */
export function isAllowedImageUrl(
  value: string | null | undefined,
  allowlist: readonly string[] = IMAGE_HOST_ALLOWLIST,
): boolean {
  if (value === null || value === undefined || value.trim().length === 0) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // A relative path or a malformed string. Not something to fetch.
    return false;
  }

  if (parsed.protocol !== 'https:') {
    return false;
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return false;
  }

  return allowlist.includes(parsed.hostname.toLowerCase());
}

/**
 * The URL to render, or `undefined` when the policy denies it.
 *
 * The shape most call sites actually want: image props are optional, so `undefined` is exactly
 * what "render your fallback instead" looks like to `next/image` and to
 * `@/components/ui/avatar`'s image part, and it needs no conditional at the call site.
 *
 * @param value - The stored URL, exactly as it arrived on the wire.
 * @param allowlist - The hosts to check against. Defaults to {@link IMAGE_HOST_ALLOWLIST}.
 * @returns The URL unchanged when {@link isAllowedImageUrl} admits it, otherwise `undefined`.
 *
 * @example
 * ```tsx
 * <AvatarImage src={allowedImageUrl(author.avatar_url)} alt="" />
 * ```
 */
export function allowedImageUrl(
  value: string | null | undefined,
  allowlist: readonly string[] = IMAGE_HOST_ALLOWLIST,
): string | undefined {
  return isAllowedImageUrl(value, allowlist) ? (value ?? undefined) : undefined;
}

/* -------------------------------------------------------------------------------------------------
 * String length, counted the way the service counts - and truncation on the same unit
 *
 * The two belong together because they are the same arithmetic used twice: a count that disagrees
 * with the service rejects text it would have accepted, and a cut taken on the wrong unit publishes
 * a broken character. Both functions count and cut CODE POINTS, because that is the unit every
 * `StringConstraints` bound in `backend/app/schemas/` is expressed in, and matching the service is
 * the entire point.
 *
 * A code point is not always a user-perceived character: a flag, a skin-toned emoji or a combining
 * sequence spans several, and {@link sliceByCodePoints} may divide one such cluster. What it will
 * never do is leave an unpaired surrogate. Grapheme segmentation (`Intl.Segmenter`) is deliberately
 * not used - it would introduce a THIRD notion of length, disagreeing with the service, and having
 * exactly one unit is the whole reason these two are declared here rather than at each call site.
 * ---------------------------------------------------------------------------------------------- */

/**
 * How long a string is *in characters*, counted the way the service counts.
 *
 * This is not the same number as `String.prototype.length`, and the difference is a real defect
 * rather than a technicality. JavaScript's `length` counts UTF-16 code units, so a character above
 * `U+FFFF` — an emoji, a historic script, a rarely-used ideograph — counts as **two**. Python's
 * `len`, which is the unit every `StringConstraints` bound in `backend/app/schemas/` is expressed
 * in, counts code points, so the same character counts as **one**.
 *
 * Left unhandled, that divergence breaks a mirrored bound in both directions at once, and both
 * directions were observed against the running service. A 127-character passphrase written in an
 * astral script measures 254 to `length`, so a ceiling of 128 refused a password the service
 * accepted. An 11-character one measures 22, so a floor of 12 waved through a password the service
 * refused. Neither failure is visible to a test written in Latin text, which is why the measurement
 * is centralised here rather than left to each schema.
 *
 * So every length bound in `src/lib/validation/` is applied through this function inside a
 * `.refine()`, never through zod's `.min()` and `.max()`, whose string checks read `length`. The one
 * exception is a bound of exactly `1` — "is there anything here at all" — where the two units cannot
 * disagree: a string has at least one code point precisely when it has at least one code unit.
 *
 * Spreading the string iterates it by code point, which is the unit the service uses. Note that
 * neither unit is a *grapheme*: a flag or a family emoji is several code points and counts as
 * several here, exactly as it does to the service, which is what keeps the two ends in agreement.
 *
 * @param value - Any string.
 * @returns The number of code points in it. `0` for the empty string; never negative.
 *
 * @example
 * ```ts
 * 'ab'.length; //            2
 * codePointLength('ab'); //  2
 * '👍'.length; //             2 - one character, two UTF-16 code units
 * codePointLength('👍'); //   1 - which is what the service counts
 * ```
 */
export function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * The first `limit` code points of a string, never splitting a surrogate pair.
 *
 * Iterating by code point and accumulating each one's UTF-16 width gives a cut index that is always
 * on a code-point boundary, so the returned string is always well-formed. Text already within the
 * limit is returned unchanged, and the function performs no whitespace handling and appends nothing
 * - a caller that wants an ellipsis or a word boundary layers that on top, which is what
 * `@/lib/seo` does.
 *
 * @param value - The text to shorten.
 * @param limit - The maximum number of code points to keep. Zero or negative yields `''`.
 * @returns A prefix of `value` at most `limit` code points long.
 */
export function sliceByCodePoints(value: string, limit: number): string {
  if (limit <= 0) {
    return '';
  }

  let kept = 0;
  let index = 0;

  for (const codePoint of value) {
    if (kept >= limit) {
      break;
    }

    // `codePoint.length` is 2 for an astral character and 1 otherwise, so the running index only
    // ever lands on a boundary between whole code points.
    index += codePoint.length;
    kept += 1;
  }

  return index >= value.length ? value : value.slice(0, index);
}

/* -------------------------------------------------------------------------------------------------
 * One path segment at a time
 *
 * What this section is NOT, stated plainly because each line is a rule someone will otherwise be
 * tempted to add:
 *
 *   - Not a format check. Whether an identifier names a real record, and whether it is a well-formed
 *     UUID or a legal slug, is decided by the service and reported as `404` or `422`. A second copy
 *     of that rule here would be the copy that has to be found when identity changes.
 *   - Not a normaliser. Case is never folded: the service's `citext` columns resolve `Alice` and
 *     `alice` through their own unique index, and folding here would duplicate a guarantee it could
 *     then drift from. Whitespace is trimmed only where a caller asks for it - see
 *     {@link SegmentWhitespacePolicy}.
 *   - Not transport. No request is issued, no status is interpreted, no error is mapped.
 *
 * This rule was authored as a module of its own precisely so the transport wrappers would not have
 * to import anything, and that independence is preserved in substance rather than in file layout:
 * the three exports below reach nothing outside this file, and `clsx` and `tailwind-merge` are
 * referenced by `cn()` alone. What changed is only which module the seven call sites name. The cost
 * of naming this one is bounded rather than assumed: `tailwind-merge` publishes `sideEffects: false`
 * so a bundle that never calls `cn()` can drop it, and `clsx` is a few hundred bytes. Any module
 * that renders a UI primitive already has this file in its graph regardless, because every one of
 * the fifteen primitives routes its classes through `cn()`.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The two relative-path instructions of RFC 3986 §3.3, which percent-encoding does not touch.
 *
 * Matched against the trimmed value so ` .. ` is refused too: surrounding whitespace is discarded
 * by neither the URL grammar nor a server's path normaliser, and a segment that is a dot segment
 * once its padding is ignored is a dot segment.
 */
const DOT_SEGMENT_PATTERN = /^\.{1,2}$/;

/**
 * Whether the value a caller hands in is sent as given or with its padding removed.
 *
 * `'verbatim'` is the default because it never repairs a caller's value: a handle or slug carrying
 * stray whitespace reaches the service intact and is answered with an honest `404`, rather than
 * being quietly turned into a different, existing record. `'trim'` exists for the one place where
 * the value is not a lookup key but published output - a canonical URL must not carry `%20`
 * padding, because that URL is what a crawler records as the address of the page.
 */
export type SegmentWhitespacePolicy = 'verbatim' | 'trim';

/**
 * What the thrown message needs in order to name the mistake precisely.
 *
 * A rejection that says which argument of which call was wrong is the difference between a one-line
 * fix and a search, which matters here because the values reaching this boundary come from route
 * parameters and search parameters - both typed `string` and both legitimately `undefined` in fact.
 */
export interface PathSegmentContext {
  /** The calling export, e.g. `'likePost'`. Named first in the message. */
  readonly operation: string;
  /** The offending parameter, e.g. `'postId'`. */
  readonly parameterName: string;
  /**
   * One sentence telling the caller where a correct value comes from, appended verbatim. Omit it
   * only when no such sentence can be written.
   */
  readonly hint?: string;
  /** Whitespace handling; defaults to `'verbatim'`. */
  readonly whitespace?: SegmentWhitespacePolicy;
}

/**
 * Compose the message once, so all seven call sites report an unusable segment identically.
 */
function segmentMessage(context: PathSegmentContext, value: unknown, problem: string): string {
  const hint = context.hint === undefined ? '' : ` ${context.hint}`;

  return (
    `${context.operation}: ${context.parameterName} ${problem}, received ` +
    `${JSON.stringify(value)}. A request path cannot be composed from it.${hint}`
  );
}

/**
 * Percent-encode one path segment, refusing the values that would address something else.
 *
 * Three outcomes, and only the first is a value:
 *
 * 1. A usable value is returned percent-encoded. For a canonical UUID that is a no-op, and for a
 *    slug or a handle very nearly one, since both are URL-safe by construction. It is applied
 *    regardless, so a value that is not what it claims to be - a raw title passed where a slug was
 *    expected - stays inside its own segment and produces an honest `404` instead of restructuring
 *    the request.
 * 2. An absent, empty or whitespace-only value throws. It would compose `/posts//like` or
 *    `/comments/`, which addresses a collection rather than a member: the answer is a different
 *    shape entirely, and reading a member off it yields `undefined` rather than an error.
 * 3. A dot segment throws. This is the case percent-encoding cannot cover, because `.` and `..`
 *    are already URL-safe: they are resolved by the URL grammar before the server ever sees a
 *    path, so they silently retarget the request at a sibling route.
 *
 * @param value - The candidate segment, as the caller supplied it. Typed `string` but validated at
 * run time, because these values arrive from URLs where the type is an assertion rather than a fact.
 * @param context - How to name the mistake, and whether to trim. See {@link PathSegmentContext}.
 * @returns The percent-encoded segment, ready to interpolate between two slashes.
 * @throws {TypeError} When the value is not a usable string, is blank, or is `.` or `..`. Callers
 * whose exports are `async` surface this as a rejected promise, which is why those exports are
 * declared `async` even when their body is a single expression - one error channel, not two.
 */
export function encodePathSegment(value: string, context: PathSegmentContext): string {
  if (typeof value !== 'string') {
    throw new TypeError(segmentMessage(context, value, 'must be a string'));
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    throw new TypeError(segmentMessage(context, value, 'must be a non-blank identifier'));
  }

  if (DOT_SEGMENT_PATTERN.test(trimmed)) {
    throw new TypeError(
      segmentMessage(
        context,
        value,
        'must not be a relative-path segment ("." or ".."), which the URL grammar resolves ' +
          'against the surrounding path instead of treating as a name',
      ),
    );
  }

  return encodeURIComponent(context.whitespace === 'trim' ? trimmed : value);
}

/* -------------------------------------------------------------------------------------------------
 * Page arithmetic
 *
 * Pure, URL-free, and reachable from either kind of component - which is the property the whole
 * section exists for:
 *
 *   - `@/hooks/use-pagination` derives from these and adds the concerns that genuinely need a client
 *     boundary: reading the current query, building each page's href, and imperative navigation.
 *   - A Server Component calls {@link derivePagination} and {@link formatResultRange} directly,
 *     during server render, so the feed's rows and its range label are in the initial HTML.
 *
 * What this section will never contain: a hook, a React import, a `next/navigation` import, a fetch,
 * a class name. It takes numbers and returns numbers.
 * ---------------------------------------------------------------------------------------------- */

/** The first page of any collection, 1-based. Named so the arithmetic reads as intent. */
export const FIRST_PAGE = 1;

/**
 * How many pages are rendered either side of the current one in the bounded window.
 *
 * Exported because `@/components/ui/pagination` reasons about the window's width when it narrows the
 * control on a small viewport, and restating the number there would let the two drift.
 */
export const PAGE_WINDOW_SIBLING_COUNT = 1;

/**
 * Matches a bare run of ASCII digits, and nothing else.
 *
 * A `page` read from a URL is untrusted input, so it is tested against this before `Number` is allowed
 * near it. `Number` is far more permissive than a page number ought to be - it accepts `'0x2'` as 2,
 * `'1e3'` as 1000, `'+2'`, `'2.0'` and `''` (as `0`) - and none of those is a form any link in this
 * application produces. Surrounding whitespace is trimmed before the test rather than rejected by it,
 * so a hand-typed `?page=%202` still resolves to page 2: trimming cannot admit an invalid value,
 * because the pattern still has to match afterwards.
 */
const DIGITS_ONLY = /^\d+$/;

/**
 * An en dash for a numeric range, written as an escape rather than as a literal.
 *
 * The escape is deliberate: an en dash and a hyphen-minus are visually near-identical in a diff, a
 * code review and most terminals, so spelling it `\u2013` is what makes it unmistakable that the
 * range separator is the typographic dash the copy calls for and not a minus sign someone typed.
 */
const EN_DASH = '\u2013';

/* -------------------------------------------------------------------------------------------------
 * Untrusted-input guards
 *
 * Every number reaching this section is untrusted, and from two different directions: an envelope
 * field is typed `number` but a fixture or a partially-populated first render can carry `0`, a
 * negative, a fraction, `NaN` or an infinity; and a page read from a URL is a caller-typed string.
 * AAP §0.9.4.4 requires an out-of-range page to answer an empty window rather than an error, so every
 * guard here clamps or falls back and none throws.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Coerce a reported count into a non-negative integer that is safe to do arithmetic with.
 *
 * Applied to `total`, `page_size` and `pages` on the way in. Nothing this returns can be `NaN`,
 * `Infinity`, negative, fractional, or negative zero: `Math.max(0, ...)` resolves `-0` to `+0`, which
 * matters because `-0` stringifies as `"0"` but is not `0` under `Object.is` and would leak a phantom
 * difference into a memo comparison upstream.
 *
 * The upper bound is not decoration either. JavaScript switches to exponent notation when stringifying
 * at `1e21` and above, so a page count that large would put a literal `page=1e+21` into an href - a
 * parameter the service answers with `422`. Capping at the largest exactly representable integer keeps
 * every number derived here a plain run of digits.
 */
function toCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(0, Math.trunc(value)), Number.MAX_SAFE_INTEGER);
}

/**
 * Whether a number is a page position worth working with.
 *
 * `Number.isInteger` is the finite-and-integer test in one call: it is `false` for `NaN` and for both
 * infinities, so no comparison is ever performed against a value whose comparisons are all false. The
 * upper bound matters for the same reason as in {@link toCount}: a 21-digit path segment parses to a
 * finite, integral `1e21` that would sail past a naive `> 0` check and then poison every offset
 * derived from it.
 */
function isUsablePageNumber(value: number): boolean {
  return Number.isInteger(value) && value >= FIRST_PAGE && value <= Number.MAX_SAFE_INTEGER;
}

/**
 * Read a page number from a value that may be a number, a URL string, or neither.
 *
 * `Number('abc')` is `NaN` and every `NaN` comparison is false, so the check is explicit rather than
 * relational. A string is required to be digits only, which rejects `'1.5'`, `'1e3'`, `'-5'` and
 * `' 1 '`-with-padding-plus-junk in one rule.
 *
 * @param value - A candidate page: an envelope field, a search parameter, or `null`/`undefined`.
 * @returns The page, or `null` when the value cannot name one.
 */
export function toPageNumber(value: number | string | null | undefined): number | null {
  if (typeof value === 'number') {
    return isUsablePageNumber(value) ? value : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!DIGITS_ONLY.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);

  return isUsablePageNumber(parsed) ? parsed : null;
}

/**
 * Resolve how many pages the collection actually occupies.
 *
 * The service's own `pages` is preferred over recomputing it, deliberately:
 * `backend/app/core/pagination.py` owns that arithmetic, and a client that re-derived it could round
 * differently and offer a page the service will not serve. A reported `0` is *accepted* rather than
 * repaired when the collection is genuinely empty, because that is the documented answer for
 * `total: 0`.
 *
 * The recomputation is a repair path for two situations the service cannot produce but a caller can: a
 * `pages` that did not survive as a usable number, and a `pages` of `0` alongside a non-zero `total`.
 * It sits behind the `windowSize > 0` guard, which is the only reason no division by zero is
 * reachable in this section.
 */
function resolvePageCount(reportedPages: number, total: number, windowSize: number): number {
  const reported = toCount(reportedPages);
  if (reported > 0) {
    return reported;
  }

  if (total === 0 || windowSize <= 0) {
    return 0;
  }

  return Math.ceil(total / windowSize);
}

/* -------------------------------------------------------------------------------------------------
 * Input and output shapes
 * ---------------------------------------------------------------------------------------------- */

/**
 * The facts about a result window that the arithmetic needs.
 *
 * Deliberately **derived from {@link Page}** with `Pick` rather than restated. The five wire names are
 * snake_case because there is no camelCase mapping layer anywhere in this tier, and a hand-typed copy
 * of `page_size` could be misspelled as `pageSize` in a way that compiles perfectly and reads
 * `undefined` at run time. Deriving the type makes that impossible: if the envelope's contract ever
 * moves, this stops compiling instead of quietly returning the wrong numbers.
 *
 * Every `Page<T>` is accepted with no cast - `Page<PostSummary>` from the feed, `Page<AdminUser>` and
 * `Page<AdminComment>` from the administrative tables, `Page<CommentPublic>` from a post's thread - and
 * so is a bare object of just the four numeric fields, which is what makes the arithmetic exercisable
 * without inventing rows to go with it.
 *
 * `items` is read for its **length only**, never for its contents, and only as a cross-check on
 * emptiness. Typing it as `readonly unknown[]` rather than generically keeps this free of a type
 * parameter it would otherwise have to thread through purely to ignore.
 */
export type PaginationSource = Pick<Page<unknown>, 'total' | 'page' | 'page_size' | 'pages'> & {
  readonly items?: readonly unknown[];
};

/** One page in the rendered window: a real destination, without the href a client adds. */
export interface PageWindowPageSlot {
  /** Discriminant. Switch on this rather than probing for the presence of a field. */
  readonly kind: 'page';
  /** The 1-based page this slot navigates to. Also the label a control should render. */
  readonly page: number;
  /** Whether this is the page currently on screen - render `aria-current="page"` when it is. */
  readonly isCurrent: boolean;
}

/**
 * A collapsed run of pages that the window omits.
 *
 * A typed sentinel rather than a magic string: a consumer switches on `kind` and never parses a label.
 * `side` distinguishes the two possible gaps - the run between the first page and the window
 * (`'start'`) and the run between the window and the last page (`'end'`) - which gives each slot a
 * stable, unique React key without anything having to mint one. A gap conveys no destination, so a
 * control renders it as inert, decorative text hidden from assistive technology.
 */
export interface PageWindowGapSlot {
  /** Discriminant. Switch on this rather than probing for the presence of a field. */
  readonly kind: 'gap';
  /** Which side of the current page the omitted run falls on. */
  readonly side: 'start' | 'end';
}

/** One entry in the bounded page window: a page, or a gap standing in for a run of omitted pages. */
export type PageWindowSlot = PageWindowPageSlot | PageWindowGapSlot;

/**
 * Everything derivable about a result window from the window alone - no URL, no navigation.
 *
 * `@/hooks/use-pagination` returns this plus the href and navigation members; a Server Component uses
 * it directly.
 */
export interface PaginationDerivation {
  /**
   * The page currently on screen, 1-based and always within `1 .. pages`.
   *
   * Taken from the envelope in preference to any other source, because the envelope is the page the
   * rows on screen actually belong to: mid-transition a URL may already name the next page while the
   * previous page's rows are still rendered, and describing the rows the reader can see is the honest
   * answer. A page beyond the end is clamped rather than rejected.
   */
  readonly page: number;
  /**
   * How many pages a control should offer, floored at `1`.
   *
   * The service reports `pages: 0` for an empty collection; this reads `1` there instead, so no
   * consumer has to reason about a zero-length page range. Guard on `isEmpty` (or on `pages <= 1`) to
   * render nothing - do not treat a `0` here as the empty signal, because it never appears.
   */
  readonly pages: number;
  /** The true page count, which IS `0` for an empty collection. Rarely needed; `pages` usually is. */
  readonly pageCount: number;
  /** Total matching rows, ignoring the window - the "of N" in a results label. `0` when empty. */
  readonly total: number;
  /**
   * Whether this window has no rows to render.
   *
   * True in both of the ways the service produces an empty window: the collection is empty, or the
   * requested page ran off the end of it. Taken from `items.length` when `items` was supplied, and
   * inferred from `total` and `isOutOfRange` when only the numeric facts were.
   */
  readonly isEmpty: boolean;
  /**
   * Whether the requested page was past the last one - a hand-edited or stale URL.
   *
   * `page` has already been clamped, so this is the only way to tell that the reader asked for
   * somewhere that does not exist. `false` for an empty collection, which is not an out-of-range
   * request but simply nothing to page through.
   */
  readonly isOutOfRange: boolean;
  /** Whether a previous page exists. `false` on page one and on an empty collection. */
  readonly hasPrevious: boolean;
  /** Whether a following page exists. `false` on the last page and on an empty collection. */
  readonly hasNext: boolean;
  /** 1-based index of the first row in this window, for a range label. `0` when empty. */
  readonly firstItem: number;
  /**
   * 1-based index of the last row in this window. On a partial final page this is `total`, never
   * `page * page_size`. `0` when empty.
   */
  readonly lastItem: number;
  /**
   * The bounded window to render: first page, current page and its siblings, last page, with a
   * {@link PageWindowGapSlot} standing in for each omitted run. Never longer than
   * `2 * PAGE_WINDOW_SIBLING_COUNT + 5` entries.
   */
  readonly pageWindow: readonly PageWindowSlot[];
}

/* -------------------------------------------------------------------------------------------------
 * The derivation
 * ---------------------------------------------------------------------------------------------- */

/**
 * Build the bounded window of pages to render.
 *
 * First page, the current page with its siblings, last page - and a sentinel for each run left out.
 * A run of exactly one page is rendered rather than elided: an ellipsis promises a run of hidden
 * pages, and standing in for a single one costs the same width while telling the reader less.
 */
function buildPageWindow(page: number, pages: number): readonly PageWindowSlot[] {
  const windowStart = Math.max(FIRST_PAGE, page - PAGE_WINDOW_SIBLING_COUNT);
  const windowEnd = Math.min(pages, page + PAGE_WINDOW_SIBLING_COUNT);

  // A Set drops the duplicates that arise when the window touches either end, and preserves insertion
  // order - which is already ascending here, because `FIRST_PAGE <= windowStart` and
  // `windowEnd <= pages` both hold by construction. No sort is therefore needed, and none is done.
  const numbers = new Set<number>([FIRST_PAGE]);
  for (let candidate = windowStart; candidate <= windowEnd; candidate += 1) {
    numbers.add(candidate);
  }
  numbers.add(pages);

  const pageSlot = (candidate: number): PageWindowPageSlot => ({
    kind: 'page',
    page: candidate,
    isCurrent: candidate === page,
  });

  const built: PageWindowSlot[] = [];
  let previous: number | null = null;

  for (const candidate of numbers) {
    if (previous !== null) {
      const omitted = candidate - previous - 1;

      if (omitted === 1) {
        built.push(pageSlot(previous + 1));
      } else if (omitted > 1) {
        // At most two runs are ever omitted - one below the window and one above it - which is why
        // the two sides are always distinct and each one makes a unique React key.
        built.push({ kind: 'gap', side: previous < page ? 'start' : 'end' });
      }
    }

    built.push(pageSlot(candidate));
    previous = candidate;
  }

  return built;
}

/**
 * Derive every page fact from one result window.
 *
 * Never throws. An empty collection, a zero window size, a fractional total and a page past the end
 * are all ordinary inputs with defined answers (AAP §0.9.4.4), and no returned field is ever `NaN`,
 * `Infinity` or `-0`.
 *
 * @param source - The result window: a whole `Page<T>`, or just its four numeric fields.
 * @param fallbackPage - The page to use when the envelope's own `page` did not survive as a usable
 *   number. `@/hooks/use-pagination` passes the page it read from the URL here; a Server Component
 *   usually omits it and gets page one.
 * @returns The derived facts, all clamped and coherent with one another.
 */
export function derivePagination(
  source: PaginationSource,
  fallbackPage?: number | string | null,
): PaginationDerivation {
  const total = toCount(source.total);
  const windowSize = toCount(source.page_size);

  // The true page count, which may legitimately be 0 for an empty collection...
  const pageCount = resolvePageCount(source.pages, total, windowSize);
  // ...and the count a control renders against, floored at one so no consumer has to handle a
  // zero-length range. `isEmpty` carries the "render nothing" signal instead.
  const pages = Math.max(pageCount, FIRST_PAGE);

  // The envelope's page wins: it is the page the rendered rows belong to, and it is already correct on
  // the first paint because it arrives with them. The fallback covers only the case where that value
  // did not survive as a usable number.
  const requestedPage = toPageNumber(source.page) ?? toPageNumber(fallbackPage) ?? FIRST_PAGE;

  // Clamped for display. The service echoes an out-of-range page back verbatim; a control that
  // highlighted page 99 of 3 would be describing a window that does not exist.
  const page = Math.min(requestedPage, pages);

  // An empty collection is not an out-of-range request - there is simply nothing to page through - so
  // this stays false when there are no pages at all.
  const isOutOfRange = pageCount > 0 && requestedPage > pageCount;

  // The observed row count is authoritative when the caller supplied rows, because it is what is on
  // screen; the two numeric paths agree on every real envelope, since the service returns an empty
  // `items` array in exactly those cases.
  const rowCount = source.items === undefined ? null : source.items.length;
  const isEmpty = rowCount === null ? total === 0 || isOutOfRange : rowCount === 0;

  // Rows before this window. `page` is at least 1 and `windowSize` at least 0, so this is a
  // non-negative finite integer for every input.
  const rowsBefore = (page - FIRST_PAGE) * windowSize;
  const firstItem = isEmpty ? 0 : Math.min(rowsBefore + 1, Math.max(total, 1));

  // The last index is capped at `total` rather than at `page * page_size`, which is what makes a range
  // label correct on a partial final page. When the caller supplied rows, their count is preferred:
  // it is the only source that stays right if a zeroed `page_size` is paired with real rows, which a
  // fixture can do even though the service cannot.
  const observedLast = rowCount === null ? 0 : rowsBefore + rowCount;
  const windowLast = rowCount === null ? rowsBefore + windowSize : observedLast;
  const lastItem = isEmpty
    ? 0
    : Math.max(firstItem, Math.min(windowLast, Math.max(total, firstItem)));

  return {
    page,
    pages,
    pageCount,
    total,
    isEmpty,
    isOutOfRange,
    hasPrevious: page > FIRST_PAGE,
    hasNext: page < pages,
    firstItem,
    lastItem,
    pageWindow: buildPageWindow(page, pages),
  };
}

/**
 * The one "Showing X-Y of N results" sentence in the product.
 *
 * Every windowed surface phrases its range identically because every windowed surface calls this: the
 * feed through `components/blog/post-list.tsx`, an author's profile through the same component, and
 * the four administrative tables through `components/admin/data-table.tsx`. It used to be written out
 * twice, once in each of those files, with a note in each acknowledging the duplication.
 *
 * `null` for an empty window, where a range would say nothing the empty panel beside it has not
 * already said - which is also why the caller does not have to guard before calling.
 *
 * @param derivation - The result of {@link derivePagination} for the window being labelled.
 * @returns The sentence, or `null` when there is nothing to summarise.
 */
export function formatResultRange(derivation: PaginationDerivation): string | null {
  if (derivation.isEmpty) {
    return null;
  }

  const { firstItem, lastItem, total } = derivation;

  return `Showing ${String(firstItem)}${EN_DASH}${String(lastItem)} of ${String(total)} ${
    total === 1 ? 'result' : 'results'
  }`;
}
