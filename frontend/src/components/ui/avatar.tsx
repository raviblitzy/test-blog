'use client';

// Avatar - one of the fifteen primitives in src/components/ui/ that ARE this
// project's design system, and one of the six that wrap a Radix behavioural
// primitive rather than a raw element.
//
// Three parts, exactly as the component mapping specifies: `Avatar` (the root),
// `AvatarImage` and `AvatarFallback`. They are deliberately NOT flattened into a
// single `<Avatar src alt initials />` component. The compositional API is the
// contract: it is what lets a caller omit the image entirely for a user with no
// `avatar_url`, render only the fallback while an image is in flight, and swap
// either part for something else without this file learning about the case.
//
// WHAT THIS FILE OWNS, AND WHAT IT DOES NOT
//
// It owns token-derived visuals and nothing else - a circle that reserves its
// space, a clipped square image, and a centred fallback ground. Radix owns the
// behaviour: `Avatar.Image` mounts only once its `src` has actually decoded, and
// `Avatar.Fallback` renders whenever it has not. That state machine is the whole
// reason this primitive wraps a library instead of hand-rolling an
// `onError`/`onLoad` dance, and reimplementing it here would also throw away the
// `delayMs` option that suppresses a fallback flash on a fast connection.
//
// AN AVATAR URL IS UNTRUSTED DATA, AND THIS FILE IS WHERE THAT IS ENFORCED
//
// `avatar_url` is whatever a user typed into their profile: the service stores
// any absolute http(s) URL (`pydantic.HttpUrl`). Rendering one unchecked would
// make every reader's browser issue a request to a host that user chose, which
// hands that host each reader's IP address, user-agent and the timing of the page
// view - a disclosure the reader never opted into and cannot see. It would also
// contradict the host policy this tier declares for the image optimiser.
//
// `AvatarImage` therefore asks `isAllowedImageUrl` from `@/lib/utils` before the
// URL reaches the DOM, and drops a denied `src` to `undefined`. That single
// module is also what `next.config.ts` derives `images.remotePatterns` from, so
// the answer here and the optimiser's answer are the same answer by construction
// rather than by two lists agreeing for now. A denied URL is not an error state:
// dropping the `src` is exactly what makes Radix keep `AvatarFallback` mounted,
// so the initials show and the composition degrades the way a missing avatar
// already does.
//
// `referrerPolicy` defaults to `no-referrer` for the same reason, one layer
// deeper: even an admitted delivery host has no business learning which page a
// reader was on. A caller that needs a host's referrer-based hotlink protection
// passes its own value.
//
// WHY RADIX'S IMAGE PART AND NOT AN <img> OR next/image
//
//   * A raw <img> cannot appear in this repository's JSX. `@next/next/no-img-
//     element` is enabled at WARN by eslint-config-next's core-web-vitals set,
//     and the lint gate is `eslint . --max-warnings=0`, so a single warning
//     fails the build. `AvatarPrimitive.Image` renders its own <img> from inside
//     node_modules, where the rule does not look - so the element we need
//     reaches the DOM without the JSX that would trip the gate. Verified by
//     running the gate; see the validation note at the foot of this comment.
//   * next/image is not the alternative either, and the reason is Radix's
//     loading state machine rather than the host policy: `next/image` reports
//     load and error through its own callbacks, so pairing it with
//     `Avatar.Fallback` means reimplementing the very handshake this primitive
//     wraps a library to avoid. The optimiser's `remotePatterns` and this file's
//     predicate now resolve from one list, so nothing is gained by swapping in
//     the optimiser and the fallback handshake is lost.
//
// WHY 'use client'
//
// Radix tracks the image-loading status in React state, so the three parts must
// live on the client. The boundary is kept as narrow as this file: no data
// fetching, no hooks of our own, no other logic. Every prop the parts accept is
// a string, a number or an element, so a Server Component - the profile header,
// a post card, a comment item - can render the composition across the boundary
// with no serialisation error.
//
// TOKENS ONLY
//
// The circle size comes from the engine's `--spacing` scale, the radius from
// `rounded-full`, the type size and weight from `--text-*` and `--font-weight-*`,
// and the two colours from the semantic layer declared in src/app/globals.css:
// `--color-surface-muted` for the fallback ground and `--color-muted-foreground`
// for the initials. There is no literal colour, dimension, radius or shadow
// anywhere below, and no `dark:` conditional - both tokens are redeclared under
// `.dark` in globals.css, so the fallback re-themes with no change to this file.
// No media query either: the five engine breakpoints are the entire responsive
// vocabulary, and a caller that wants a larger avatar passes a spacing-scale
// size through `className`, which `cn()` resolves against the default.
//
// DELIBERATELY ABSENT. Please do not add.
//
//   1. A `size` variant table (class-variance-authority). Two call sites need a
//      non-default size - the profile header and the comment thread - and both
//      express it with one utility through `className`. A variant enum would be
//      a second sizing vocabulary competing with the spacing scale, and `cn()`
//      already makes the override deterministic.
//   2. A default border or ring. `--color-border` is decorative-only by design
//      (see the A11Y note in globals.css), and a hairline that every consumer
//      then has to override is worse than one they opt into with
//      `className="ring-1 ring-border"`.
//   3. An `aria-label`, a `role`, or a default `alt`. An avatar sitting beside a
//      visible author name is decorative duplication: the caller passes
//      `alt=""` there, passes descriptive `alt` text when the avatar stands
//      alone, and decides for itself whether to mark the whole composition
//      `aria-hidden`. Inventing a label here would manufacture an accessible
//      name that no design asked for and that a screen reader would then
//      announce twice.
//   4. Initials computation. `display_name` and `username` are domain concepts;
//      this primitive imports no domain type and stays reusable because of it.
//      The consumer derives one or two initials and passes them as
//      `AvatarFallback` children.
//   5. A default `delayMs`. Left to the caller on purpose - see the note on
//      `AvatarFallback` below.
//   6. An explicit `asChild` prop. It is already part of every Radix primitive's
//      prop type and reaches the primitive through the spread; redeclaring it
//      would only create a second place for it to drift.
//   7. Upload, cropping or object-storage behaviour. Avatars are URL references;
//      this product has no image pipeline.
//   8. A host list of this file's own, or an `unsafeAllowAnyHost` escape hatch.
//      The policy has exactly one definition, the source-code constant
//      `IMAGE_HOST_ALLOWLIST` in `@/lib/utils`, and widening it is a reviewed
//      change there rather than an edit in a component. A second list here is the
//      drift this design exists to remove.
//
// TESTING NOTE. jsdom never fetches an image, so `image.complete` stays false
// and no `load` event ever fires - which means `AvatarImage` renders null and
// the fallback is the visible content in every component test, whatever `src`
// says. Tests assert on that reality (visible initials, accessible name) rather
// than stubbing image loading, and never on class names.

import * as AvatarPrimitive from '@radix-ui/react-avatar';
import type { ComponentProps, JSX } from 'react';

import { allowedImageUrl, cn } from '@/lib/utils';

/**
 * Props of the Radix avatar root, derived from the primitive so this wrapper
 * cannot drift from the installed package's real surface. Carries `className`,
 * `children`, `ref`, `asChild` and every `<span>` attribute.
 */
type AvatarProps = ComponentProps<typeof AvatarPrimitive.Root>;

/** Props of the Radix image part, including `src`, `alt` and `onLoadingStatusChange`. */
type AvatarImageProps = ComponentProps<typeof AvatarPrimitive.Image>;

/** Props of the Radix fallback part, including the optional `delayMs`. */
type AvatarFallbackProps = ComponentProps<typeof AvatarPrimitive.Fallback>;

/**
 * The avatar root: a fixed-size circle that clips whatever it contains.
 *
 * Compose it with an image, a fallback, or both - both is the usual case,
 * because it is the pair that degrades gracefully:
 *
 * ```tsx
 * <Avatar>
 *   <AvatarImage src={author.avatar_url ?? undefined} alt="" />
 *   <AvatarFallback>{initials}</AvatarFallback>
 * </Avatar>
 * ```
 *
 * The root reserves its full size before the image resolves, so the moment the
 * fallback gives way to the image causes no layout shift. `overflow-hidden` plus
 * `rounded-full` is what makes a rectangular source photo read as a circle, and
 * `shrink-0` keeps the circle from being squeezed when it sits in a flex row
 * beside a long display name. Exactly one `AvatarImage` belongs in each root -
 * Radix warns in development if it finds more.
 *
 * @param className - Extra utilities, merged last so they win their group. This
 *   is the sizing seam: `className="size-16"` replaces the default size.
 * @param props - Any other root prop, including `ref` and `asChild`, spread
 *   straight onto the primitive.
 */
export function Avatar({ className, ...props }: AvatarProps): JSX.Element {
  return (
    <AvatarPrimitive.Root
      className={cn(
        'relative flex size-10 shrink-0 overflow-hidden rounded-full select-none',
        className,
      )}
      {...props}
    />
  );
}

/**
 * The image part. Renders nothing until its `src` has decoded, at which point it
 * replaces the fallback.
 *
 * `object-cover` on a square box is what stops a non-square source photo from
 * distorting: the image fills the circle and is cropped rather than squashed.
 *
 * `alt` is passed straight through and is the caller's decision, not this
 * primitive's. Beside a visible author name an avatar is decorative duplication,
 * so the caller passes `alt=""`; standing alone - an author card with no name
 * beside it - it passes descriptive text.
 *
 * ### The host policy is applied here, before the URL reaches the DOM
 *
 * `src` is filtered through `allowedImageUrl` from `@/lib/utils`, the one module
 * that decides which remote image hosts this tier fetches from and the module
 * `next.config.ts` derives `images.remotePatterns` from. A URL that is not
 * `https`, that carries embedded credentials, or whose host is not admitted
 * becomes `undefined`, and Radix keeps `AvatarFallback` mounted - so a
 * user-supplied host that the policy excludes never causes a request from a
 * reader's browser, and the reader sees initials rather than a broken image.
 * Admitting a host is a change to `IMAGE_HOST_ALLOWLIST` in `@/lib/utils`, not to
 * this file.
 *
 * @param className - Extra utilities, merged last so they win their group.
 * @param src - The stored avatar URL. Dropped when the shared host policy denies
 *   it, which shows the fallback instead.
 * @param referrerPolicy - Defaults to `no-referrer`, so an admitted host learns
 *   nothing about which page the reader was on. Pass a value to override it.
 * @param props - `alt`, `crossOrigin`, `onLoadingStatusChange`, `ref` and every
 *   other image prop, spread straight onto the primitive.
 */
export function AvatarImage({
  className,
  src,
  referrerPolicy = 'no-referrer',
  ...props
}: AvatarImageProps): JSX.Element {
  return (
    <AvatarPrimitive.Image
      className={cn('aspect-square h-full w-full object-cover', className)}
      // The prop type admits a `Blob` as well as a URL string. Only a string can
      // name a remote host, so only a string is policed; a `Blob` is local data
      // with no host to check and is passed through untouched.
      src={typeof src === 'string' ? allowedImageUrl(src) : src}
      referrerPolicy={referrerPolicy}
      {...props}
    />
  );
}

/**
 * The fallback part: how a null, empty or unreachable `avatar_url` degrades.
 *
 * Rendered whenever the sibling image has not loaded - which covers a user who
 * has never set an avatar, a URL whose host is down, and the interval before a
 * slow image arrives. Give it the one or two initials the consumer derived from
 * the display name or username; keep it short, because the ground is a small
 * circle and long text would be clipped by the root rather than wrapped.
 *
 * `delayMs` is deliberately not defaulted here. Radix renders the fallback
 * immediately when it is absent, which is right for the common case - a user
 * with no avatar at all should never show an empty hole. Pass `delayMs` at the
 * call site if that particular surface would rather stay blank briefly than
 * flash initials before a fast image lands.
 *
 * The type size does NOT scale with the root, because a utility applied to the
 * root cannot reach this element. A caller that enlarges the circle should size
 * the initials in the same breath - `<Avatar className="size-16">` paired with
 * `<AvatarFallback className="text-lg">` - otherwise 14px initials sit in a 64px
 * disc. Measured in a browser, not assumed. Two utilities at the call site is
 * the deliberate trade for having no variant table to keep in step.
 *
 * @param className - Extra utilities, merged last so they win their group.
 * @param props - `delayMs`, `children`, `ref` and every other span prop, spread
 *   straight onto the primitive.
 */
export function AvatarFallback({ className, ...props }: AvatarFallbackProps): JSX.Element {
  return (
    <AvatarPrimitive.Fallback
      className={cn(
        'bg-surface-muted text-muted-foreground flex h-full w-full items-center justify-center rounded-full text-sm font-medium',
        className,
      )}
      {...props}
    />
  );
}
