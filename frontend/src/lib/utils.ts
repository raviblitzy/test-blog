// Class-name composition for the design system layer.
//
// This module has one job. Every primitive under `src/components/ui/` routes its variant classes
// and its caller-supplied `className` through `cn()` — the nine authored over raw elements
// (button, input, textarea, card, badge, table, pagination, alert, skeleton) and the six wrapping
// Radix behavioural primitives (select, label, dialog, dropdown-menu, tabs, avatar) alike.
//
// It sits at the base of the frontend dependency graph: it imports only `clsx` and
// `tailwind-merge`, reads no environment variable, and carries no `'use client'` directive so
// Server and Client Components can both call it without pulling anything into the client bundle.

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
