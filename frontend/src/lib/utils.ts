// Shared, dependency-free utilities for the presentation tier.
//
// Two concerns live here, and both are here for the same reason: every layer of the frontend
// needs them, and each must have exactly ONE definition or the layers silently disagree.
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
// The module carries no `'use client'` directive, so Server and Client Components can both call
// into it. Its only package imports are `clsx` and `tailwind-merge`. It reads exactly one
// environment variable, `NEXT_PUBLIC_IMAGE_HOST_ALLOWLIST`, documented in `.env.example`;
// `NEXT_PUBLIC_` values are inlined by the framework at build time, so the read costs nothing at
// runtime and behaves identically on both sides of the network boundary.

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
 * ---------------------------------------------------------------------------------------------- */

/**
 * Hosts admitted when the environment names none.
 *
 * Four delivery hosts, each over TLS, each justified: `images.unsplash.com` and `picsum.photos`
 * serve the demonstration cover photography the seed data references, `res.cloudinary.com` is
 * where an author's own cover image is hosted, and `avatars.githubusercontent.com` is the default
 * source of user avatars.
 *
 * Exported so a test can assert the shipped default rather than restating four hostnames that
 * could drift from it.
 */
export const DEFAULT_IMAGE_HOST_ALLOWLIST: readonly string[] = [
  'images.unsplash.com',
  'picsum.photos',
  'res.cloudinary.com',
  'avatars.githubusercontent.com',
];

/**
 * Parses the comma-separated host list an operator supplies through
 * `NEXT_PUBLIC_IMAGE_HOST_ALLOWLIST`.
 *
 * Entries are trimmed, lower-cased and de-duplicated, and empty entries are dropped, so a value
 * with stray spaces or a trailing comma still yields a clean list. An absent, blank or
 * entirely-empty value falls back to {@link DEFAULT_IMAGE_HOST_ALLOWLIST} rather than to an empty
 * list: an empty list would render every stored image as a fallback with nothing to say why, which
 * looks like a product defect rather than a configuration mistake.
 *
 * Each entry is a bare HOSTNAME - no scheme, no port, no path, no wildcard. Exact matching is
 * deliberate: `next.config.ts` turns each entry into one `remotePatterns` entry, and only an exact
 * hostname is guaranteed to mean the same thing to both this predicate and the optimiser's own
 * matcher. Admitting a wildcard here would mean reimplementing the framework's subdomain matching
 * and hoping the two implementations stayed in step.
 *
 * Exported for the same reason as the default list: so the parsing rules can be asserted directly
 * rather than inferred from a rendered result.
 *
 * @param raw - The environment value, or `undefined` when it is unset.
 * @returns A non-empty, lower-cased, de-duplicated list of hostnames.
 */
export function parseImageHostAllowlist(raw: string | undefined): readonly string[] {
  const parsed = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  return parsed.length > 0 ? Array.from(new Set(parsed)) : DEFAULT_IMAGE_HOST_ALLOWLIST;
}

/**
 * The hosts this deployment will fetch remote images from.
 *
 * Resolved once, at module scope, from `NEXT_PUBLIC_IMAGE_HOST_ALLOWLIST`. Admitting another host
 * is therefore a configuration change rather than a code change - which is what lets an operator
 * keep this tier in step with whatever `cover_image_url` and `avatar_url` values the service has
 * been allowed to store.
 */
export const IMAGE_HOST_ALLOWLIST: readonly string[] = parseImageHostAllowlist(
  process.env.NEXT_PUBLIC_IMAGE_HOST_ALLOWLIST,
);

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
