'use client';

import { useEffect, useState } from 'react';

/**
 * Default quiet period, in milliseconds, before a changing value is treated as settled.
 *
 * 300ms is the conventional search-as-you-type window: long enough to swallow the gaps between a
 * fast typist's keystrokes, short enough that the result still feels immediate.
 */
const DEFAULT_DEBOUNCE_DELAY_MS = 300;

/**
 * Debounce a rapidly changing value, re-emitting it only once it has held steady for `delayMs`.
 *
 * Signature: `useDebouncedValue<T>(value: T, delayMs?: number): T`
 *
 * Serves AAP §0.6.5 — *"the search input debounces before pushing a new URL so typing does not
 * generate a request per keystroke."* Note the ordering: the debounce **precedes** the push and
 * does not perform it. This hook returns a value and never navigates; the caller owns any
 * navigation. That boundary is what keeps the hook generic over any value rather than tied to a
 * search term, and testable under fake timers. The home feed's search control takes what this
 * returns and pushes `q` into the URL itself.
 *
 * Returns `T`, never `T | undefined` — the first render emits `value` synchronously, so a
 * consumer never handles an empty first frame. Intended for UI values (strings, numbers, plain
 * objects); a function-typed `T` is outside the supported domain, because React reserves a
 * function argument to `useState` and to its setter for lazy-initialiser and updater semantics.
 *
 * @typeParam T - Type of the debounced value. Unconstrained, and preserved exactly on the way out.
 * @param value - The value to debounce, typically a controlled input's current value.
 * @param delayMs - Quiet period to wait before emitting. Defaults to
 *   {@link DEFAULT_DEBOUNCE_DELAY_MS} (300ms).
 * @returns The most recent `value` that has stayed unchanged for a full `delayMs`.
 *
 * @example
 * ```tsx
 * const [query, setQuery] = useState('');
 * const debouncedQuery = useDebouncedValue(query);
 * // …then react to `debouncedQuery` — e.g. push it into the URL — never to `query`.
 * ```
 */
export function useDebouncedValue<T>(value: T, delayMs: number = DEFAULT_DEBOUNCE_DELAY_MS): T {
  // Seeded with `value` rather than left empty, so first render returns the current value
  // synchronously and the return type stays `T` instead of widening to `T | undefined`.
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);

    // The cleanup IS the debounce. React runs it before every re-run of this effect and once
    // more on unmount, so a value that changes inside the window cancels its predecessor's
    // pending timer instead of queueing a second one — that is what makes this a debounce
    // rather than a throttle. It also means a component unmounting mid-window emits nothing,
    // so no stale value can surface after the user has already navigated away.
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debouncedValue;
}
