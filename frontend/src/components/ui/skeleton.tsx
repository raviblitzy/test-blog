// Skeleton - the design system's loading placeholder.
//
// One of the fifteen primitives under src/components/ui/ that together ARE this
// project's design system: feature code consumes this layer and never reaches
// past it. Radix publishes no skeleton, so this is one of the nine primitives
// authored directly over a plain element rather than wrapping a behavioural one
// - and being purely decorative, it needs no behaviour at all. There is no
// state, no effect and no event handler below, which is why the whole component
// is a single element beneath a much longer explanation of why it is only one.
//
// FIVE THINGS THIS FILE DELIBERATELY OMITS. Each one looks like an improvement.
//
//   1. `'use client'`. Nothing here touches a hook, a browser API or an event,
//      so the module stays shared - and that is load-bearing rather than tidy.
//      The surfaces that need a placeholder most are Server Components
//      (app/loading.tsx, the server-rendered feed and post lists); the directive
//      would pull this module and its callers into the client bundle to animate
//      a div that does nothing on the client.
//   2. `forwardRef`. React 19 hands `ref` to a function component as an ordinary
//      prop, so the wrapper would buy an extra layer and a display-name
//      obligation while changing nothing observable. `ref` still works - it
//      arrives inside `...props` and lands on the div like any other attribute.
//   3. `@keyframes`, `duration-*`, or any arbitrary animation value. The pulse IS
//      the engine's own `animate-pulse` utility, which compiles to
//      `animation: var(--animate-pulse)`. src/app/globals.css declines to
//      declare an animation token for this file precisely because that one is
//      already installed.
//   4. A `dark:` variant. `bg-surface-muted` resolves to `--color-surface-muted`,
//      which globals.css declares twice - once at the document root and once
//      under `.dark`. The fill therefore themes itself, and a conditional here
//      would be a second, competing source of truth for it. Note that the two
//      values are named there and deliberately not transcribed here: repeating
//      them would create a copy free to drift from the token layer.
//   5. A stylesheet, a `<style>` tag, a `style` prop and a media query of our
//      own. globals.css is the only stylesheet in this tier, and the engine's
//      five breakpoints are the entire responsive vocabulary. A placeholder
//      needs none of them: size variation is the caller's job, passed as
//      `className`.

import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * The base appearance, composed entirely from tokens - there is no literal value
 * here that could drift from the token layer.
 *
 * - `bg-surface-muted` -> `var(--color-surface-muted)`, the recessed fill
 *   globals.css defines for exactly this purpose, dual-valued across themes.
 * - `h-4 w-full` -> `calc(var(--spacing) * 4)` and `100%`. A default size rather
 *   than none, because a div with no content and no height collapses to nothing
 *   and renders invisibly: `<Skeleton />` on its own has to show *something*,
 *   and a full-width text line is the shape callers reach for most.
 * - `animate-pulse` -> `animation: var(--animate-pulse)`, the engine's token.
 * - `rounded-md` -> `border-radius: var(--radius-md)`.
 * - `motion-reduce:animate-none` -> `animation: none` inside the engine's own
 *   `@media (prefers-reduced-motion: reduce)` block. A visitor who has asked for
 *   less motion gets a still placeholder, which loses nothing: the shape and
 *   position already carry the "loading" meaning, and the pulse was only ever
 *   decoration. This is a built-in variant, not a hand-written media query.
 *
 * ### Why the pulse is NOT written as `motion-safe:animate-pulse`
 *
 * That inverted form would be the more obvious way to gate the animation, and it
 * is wrong here. `cn()` resolves conflicts *within* a Tailwind group, and a
 * variant-prefixed class sits in a different group from a bare one - so
 * `motion-safe:animate-pulse` would survive a caller's `animate-none` instead of
 * being replaced by it, and would then win the cascade because variant rules are
 * emitted after unprefixed ones. Keeping `animate-pulse` bare is what preserves
 * the override determinism src/lib/utils.ts exists to guarantee; the
 * `motion-reduce` companion adds the accessibility floor without spending it.
 *
 * Ordered as prettier-plugin-tailwindcss would order it, so the string never
 * churns if `cn` is later added to the plugin's `tailwindFunctions`.
 */
const SKELETON_BASE_CLASSES =
  'bg-surface-muted h-4 w-full animate-pulse rounded-md motion-reduce:animate-none';

/**
 * A pulsing block that stands in for content while it loads.
 *
 * Renders a single `<div>`. Its pulse comes from the token animation scale
 * (`--animate-pulse`) and its fill from the semantic `--color-surface-muted`
 * token, so it themes with the document and carries no hardcoded value.
 *
 * **Callers own the geometry.** The default is one full-width text line; pass
 * `className` to say otherwise. Overrides are reliable rather than best-effort,
 * because `cn()` resolves each Tailwind group last-wins: `className="size-10
 * rounded-full"` replaces the default height, width *and* radius in one go, and
 * `className="animate-none"` stops the pulse outright.
 *
 * Compose several to outline a shape - there is no `count` or `lines` prop,
 * because a list of `<Skeleton />` elements in the consumer's own layout says it
 * more clearly and stays in step with whatever it is standing in for.
 *
 * Hidden from assistive technology by default (`aria-hidden="true"`): it is
 * decoration, and a screen reader announcing a row of empty boxes is noise. Any
 * attribute may be overridden, since `...props` is spread last - so a region
 * that should be announced puts `role="status"` and an accessible name on the
 * *wrapper* around these, which is where the meaning actually lives, rather than
 * on any one placeholder.
 *
 * Accepts every `<div>` attribute; derive the prop type with
 * `ComponentProps<typeof Skeleton>` if a wrapper needs to forward it.
 *
 * @example One full-width line, no configuration
 * ```tsx
 * <Skeleton />
 * ```
 *
 * @example An avatar and two lines of byline, announced as one region
 * ```tsx
 * <div role="status" aria-label="Loading author" className="flex items-center gap-3">
 *   <Skeleton className="size-10 rounded-full" />
 *   <div className="flex flex-col gap-2">
 *     <Skeleton className="w-32" />
 *     <Skeleton className="h-3 w-20" />
 *   </div>
 * </div>
 * ```
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    // `aria-hidden` before the spread so a caller can opt back in; `className`
    // before it too, though only `cn` can override that - it is destructured out
    // of `props` above, so the composed string is never clobbered by the spread.
    <div aria-hidden="true" className={cn(SKELETON_BASE_CLASSES, className)} {...props} />
  );
}
