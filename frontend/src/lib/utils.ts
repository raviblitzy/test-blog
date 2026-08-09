// Shared, dependency-free utilities for the presentation tier.
//
// Three concerns live here, and all three are here for the same reason: more than one layer of the
// frontend needs them, and each must have exactly ONE definition or the layers silently disagree.
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
// 3. HOW LONG A STRING IS - `codePointLength()`. Every length bound this tier enforces mirrors one
//    the service enforces, and the two count in different units unless something makes them agree:
//    JavaScript's `String.prototype.length` counts UTF-16 code units, Python's `len` counts code
//    points, so one emoji is 2 to the browser and 1 to the API. All four modules under
//    `src/lib/validation/` measure through this function for that reason, and none of them may
//    reach for `.length` or for zod's own `.min`/`.max` on a bound the service also declares.
//    Four copies of a one-line function would be four chances for one of them to drift.
//
// The module carries no `'use client'` directive, so Server and Client Components can both call
// into it. Its only package imports are `clsx` and `tailwind-merge`, and it READS NO ENVIRONMENT
// VARIABLE: the host policy below is source code, for the reasons set out above its declaration.

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

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
 * String length, counted the way the service counts
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
