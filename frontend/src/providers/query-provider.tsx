'use client';

// Query provider - the client cache for the whole presentation tier.
//
// This file owns one thing: the single React Query cache instance and the
// defaults every client island inherits from it. Mounted once, in
// src/app/layout.tsx, alongside the theme provider, the auth provider and the
// toast host.
//
// WHAT USES IT, AND WHAT DELIBERATELY DOES NOT
//
// React Query serves the CLIENT ISLANDS only: search, the category filter, the
// like button, the comment form and the admin tables. It does NOT serve the
// content routes. src/app/page.tsx, src/app/blog/[slug]/page.tsx and
// src/app/u/[username]/page.tsx are Server Components that call `@/lib/api/*`
// directly during render, so the article lands in the initial HTML and a
// crawler never has to execute JavaScript to see it. That split is the reason
// the SEO requirement and the interactivity requirement can both be satisfied,
// and it is why there is NO server-to-client cache handoff to arrange here -
// see the absent list below.
//
// THE ONE DETAIL THAT MATTERS MOST: THE CLIENT IS BUILT PER MOUNT, LAZILY
//
// The client is constructed exactly once below, inside a useState initialiser -
// and a search for the constructor across this file returns that one line, which
// is what makes the invariant checkable rather than merely asserted. Both halves
// of how it is written are load-bearing:
//
//   * NOT at module scope. On the server, module scope is shared across
//     concurrent requests, so a module-level client would be one cache serving
//     every visitor at once - and one reader's cached data would be reachable
//     from the next reader's render. That is a cross-user data leak, not a
//     performance nit. Building the client inside the component makes each
//     render tree's cache private BY CONSTRUCTION rather than by convention:
//     there is no shared binding for a second request to reach.
//   * The initialiser is a FUNCTION, not a value. Constructing the client
//     eagerly and handing the instance to useState would build a fresh one on
//     every single render and throw it away, which silently defeats caching -
//     nothing errors, nothing warns, queries simply never hit a warm cache.
//     `useState(() => ...)` runs the constructor once per mount and keeps that
//     instance for the mount's lifetime.
//
// DIVISION OF LABOUR WITH src/lib/api/client.ts
//
// That module is the tier's only HTTP module and already owns bearer
// attachment, single-flight refresh-on-401, and normalisation of every failure
// into an ApiError carrying a ProblemDetail. This file performs NO HTTP: it
// never calls fetch and never calls an `@/lib/api/*` wrapper. Its only contact
// with the API layer is importing the `isApiError` guard so the retry predicate
// can read a status - a pure, side-effect-free function. `providers -> lib` is
// a permitted dependency direction, and client.ts reads its environment lazily
// inside functions rather than at module scope, so importing from it triggers
// no configuration read, no request and no browser-global access.
//
// DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT HERE.
//
//   1. @tanstack/react-query-devtools. Not declared in frontend/package.json.
//      Importing it breaks `npm ci` reproducibility and fails the build. The
//      usual excuse for adding it is a `process.env.NODE_ENV` branch, which is
//      also why this file reads no environment variable at all.
//   2. HydrationBoundary, dehydrate, or a `getQueryClient()` server helper.
//      There is no server-to-client cache handoff in this architecture; see
//      above. Adding the plumbing would imply the content routes fetch through
//      React Query, which would take the article out of the initial HTML.
//   3. Cache persistence to localStorage or IndexedDB. No persister package is
//      declared, and it would put API responses into durable client storage.
//   4. A global `onError` that raises a toast. The toast host is mounted by
//      src/app/layout.tsx, and mutation feedback belongs to the call site that
//      knows what failed. A handler here would double-report every failure.
//   5. Query keys, query functions, hooks, or a blanket `invalidateQueries`
//      default. Keys and fetchers live with the features that own them. A
//      blanket invalidation default would specifically defeat the like button:
//      PUT and DELETE on /posts/{id}/like both return the full LikeSummary so
//      an optimistic update can settle WITHOUT a follow-up request.
//   6. Markup, className, inline style, or any import from `@/components/*`.
//      This provider renders no element of its own and declares no CSS value.

import { useState } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { isApiError } from '@/lib/api/client';

/* -------------------------------------------------------------------------- */
/* Tuning constants                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How long fetched data is considered fresh, in milliseconds.
 *
 * A minute is chosen so that navigating away from the feed and back - the most
 * common movement on this site - reads the cache instead of re-requesting. A
 * blog's content does not change between two clicks, and `staleTime: 0` (the
 * library default) would refetch on every remount.
 */
const STALE_TIME_MS = 60_000;

/**
 * How long an unused cache entry is retained before collection, in
 * milliseconds.
 *
 * Must be greater than {@link STALE_TIME_MS}: an entry collected while still
 * fresh could never be served from cache, which would make the freshness
 * window above unreachable.
 */
const GC_TIME_MS = 5 * STALE_TIME_MS;

/**
 * Maximum retries for a query whose failure is genuinely transient, so at most
 * three attempts in total.
 *
 * Bounded deliberately. React Query's default of three retries with backoff
 * keeps a reader watching a spinner for several seconds before an error
 * surfaces, and none of the failures this predicate permits a retry for
 * benefits from a fourth attempt.
 */
const MAX_QUERY_RETRIES = 2;

/**
 * The `status` `src/lib/api/client.ts` reports when no response was received at
 * all - offline, DNS failure, refused connection, TLS failure, or a cancelled
 * request. Zero is not a real HTTP status and cannot collide with one.
 */
const NO_RESPONSE_STATUS = 0;

/** Lowest status in the 5xx range, above which a failure is server-side and may be transient. */
const LOWEST_SERVER_ERROR_STATUS = 500;

/**
 * `ProblemDetail.type` marking a request that was cancelled rather than one
 * that failed. Both carry {@link NO_RESPONSE_STATUS}, so this is the only thing
 * that distinguishes them.
 *
 * Restated here because `src/lib/api/client.ts` keeps the constant private;
 * that module documents branching on `type` as the supported way for a consumer
 * to tell a transport failure from a rejection. If the literal ever changes
 * there it must change here too - a mismatch does not fail anywhere, it just
 * silently starts retrying cancelled requests.
 */
const ABORTED_PROBLEM_TYPE = '/errors/request-aborted';

/* -------------------------------------------------------------------------- */
/* Retry policy                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Decide whether a failed query is worth attempting again.
 *
 * Every failure reaching this function came from `src/lib/api/client.ts`, which
 * normalises the tier's complete failure taxonomy into one error type. Each
 * class is decided on its merits rather than by a blanket attempt count:
 *
 * | Failure                        | `status`  | Retry | Why                                                            |
 * | ------------------------------ | --------- | ----- | -------------------------------------------------------------- |
 * | Client error (401/403/404/422) | 400-499   | no    | Terminal. A 401 has already had its rotation attempted and     |
 * |                                |           |       | refused by the client's single-flight refresh, so retrying      |
 * |                                |           |       | fights that path and delays the redirect to sign-in; 403 and    |
 * |                                |           |       | 404 can never succeed; 422 is the request's own shape. A 429    |
 * |                                |           |       | carries `retryAfterSeconds`, and every authentication route is  |
 * |                                |           |       | rate limited, so an immediate retry is simply refused again.    |
 * | Server error                   | >= 500    | yes   | Plausibly transient.                                           |
 * | Unreachable service            | 0         | yes   | Plausibly transient - the connection may come back.            |
 * | Cancelled request              | 0         | no    | Cancellation is deliberate. React Query aborts in-flight       |
 * |                                |           |       | queries on unmount and on refetch, so retrying these would     |
 * |                                |           |       | re-issue work the application just discarded.                  |
 * | Malformed or empty body        | 2xx       | no    | The same body would fail to parse identically.                 |
 * | Anything not an `ApiError`     | n/a       | no    | A defect in a query or transform function, not a transport     |
 * |                                |           |       | failure; it will throw the same way every time.                |
 *
 * @param failureCount - Retries already made for this query, so `0` on the
 * first failure. React Query increments it only after this function answers,
 * which is why the guard below mirrors the library's own `failureCount < retry`
 * comparison rather than being off by one.
 * @param error - The rejection. Typed as `Error` because that is the signature
 * React Query calls this with; {@link isApiError} narrows it.
 * @returns `true` to attempt the query again, `false` to surface the error.
 */
function shouldRetryQuery(failureCount: number, error: Error): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) {
    return false;
  }
  if (!isApiError(error)) {
    return false;
  }
  if (error.status === NO_RESPONSE_STATUS) {
    return error.problem.type !== ABORTED_PROBLEM_TYPE;
  }
  // 4xx is terminal and a 2xx that would not parse is deterministic, so only a
  // server-side failure is left as retryable.
  return error.status >= LOWEST_SERVER_ERROR_STATUS;
}

/* -------------------------------------------------------------------------- */
/* Provider                                                                   */
/* -------------------------------------------------------------------------- */

/** Props of {@link QueryProvider}. */
interface QueryProviderProps {
  /**
   * The tree to render. Rendered unconditionally - this provider never gates
   * its children behind a mounted flag, which would discard the
   * server-rendered markup the SEO requirement depends on.
   */
  readonly children: React.ReactNode;
}

/**
 * Client boundary that owns the React Query cache for the whole application.
 *
 * Mounted once, in `src/app/layout.tsx`, around the entire tree:
 *
 * ```tsx
 * <QueryProvider>{children}</QueryProvider>
 * ```
 *
 * The defaults are configured here and only here, so no `useQuery` or
 * `useMutation` call site has to restate them. A call site that genuinely needs
 * different behaviour - the like button opting into a retry for its idempotent
 * mutation, for instance - overrides the option locally.
 *
 * @param children - The tree to wrap, rendered unconditionally. See
 * {@link QueryProviderProps}.
 * @returns The provided tree, wrapped in the cache context.
 */
export function QueryProvider({ children }: QueryProviderProps): React.JSX.Element {
  // One client per mount, constructed lazily. See the header: neither the
  // per-mount scope nor the function form of the initialiser is optional.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: STALE_TIME_MS,
            gcTime: GC_TIME_MS,
            // The blog carries no live data, so refetching every time a tab
            // regains focus is pure noise on the network and in the UI.
            refetchOnWindowFocus: false,
            retry: shouldRetryQuery,
          },
          mutations: {
            // A mutation is not safe to blindly repeat. The one genuinely
            // idempotent mutation here is the like - `post_likes` carries the
            // composite primary key (post_id, user_id), so a repeated request
            // cannot inflate a count - and its component opts in locally
            // rather than every mutation in the product opting out here.
            retry: 0,
          },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
