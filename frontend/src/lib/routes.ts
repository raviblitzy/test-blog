/**
 * The tier's canonical in-app route addresses, declared once.
 *
 * Every URL in this application is either a PUBLIC address (`/`, `/blog/{slug}`, `/u/{handle}`),
 * which `@/lib/seo` already owns because those URLs are also canonical links in the crawled HTML,
 * or a PROTECTED address inside one of the two route groups. This module owns the second set. It
 * exists because a protected address has three independent consumers that must agree on it
 * character for character, and nothing in the type system relates them:
 *
 *   1. `src/middleware.ts`, whose matcher decides which requests are gated at all;
 *   2. `@/lib/seo`'s crawl-policy disallow list, because a route worth gating is a route worth
 *      keeping out of an index;
 *   3. every component that navigates - `router.push`, `router.replace`, a `<Link href>`.
 *
 * ## THE MISTAKE THIS MODULE EXISTS TO PREVENT
 *
 * A Next.js route GROUP - a directory whose name is parenthesised - is organisational only, and its
 * name is ERASED from the URL. `src/app/(dashboard)/posts/[id]/edit/page.tsx` therefore serves
 * `/posts/{id}/edit`, **not** `/dashboard/posts/{id}/edit`. The group directory and the URL segment
 * are unrelated, and the directory layout reads as though they were.
 *
 * That is not a theoretical trap. A navigation built from the group name compiles, type-checks,
 * lints and renders; it fails only at run time, as a 404 the author reaches immediately after being
 * told their draft was saved - and the draft IS saved, so the failure looks like data loss to the
 * only person who can see it. `src/middleware.ts` gates `/posts/:path*` precisely because that is
 * the real family, which is the corroborating evidence: the two files disagreed, and the matcher was
 * the one that was right.
 *
 * So the rule is: **a protected URL is never written as a literal at a call site.** It is named
 * here, next to the note explaining what its directory looks like and why the two differ.
 *
 * ## WHAT BELONGS HERE, AND WHAT DOES NOT
 *
 * Only addresses inside `src/app/(dashboard)/` and `src/app/(admin)/` - the two groups whose names
 * are erased, and therefore the only two that can be got wrong in this particular way.
 *
 * Public canonical URLs are deliberately absent. Those are ABSOLUTE URLs built on
 * `NEXT_PUBLIC_SITE_URL` because they are emitted into `<link rel="canonical">`, OpenGraph tags, the
 * sitemap and JSON-LD, and `@/lib/seo` owns that composition. Re-declaring their paths here would
 * create a second place a public address could be spelled, which is the very failure mode this
 * module removes.
 *
 * ## DEPENDENCIES
 *
 * One: `encodePathSegment` from `@/lib/utils`, which carries no `'use client'` directive and reads no
 * environment. So this module is safe to import from a Server Component, a client island, a Route
 * Handler and the Edge runtime alike, and it drags no validator and no transport code into any of
 * their bundles. `@/lib/utils` does reference `clsx` and `tailwind-merge`, but only from `cn()`, which
 * nothing here calls.
 */

import { encodePathSegment } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * The `(dashboard)` group - the author's own workspace and the authoring screens
 *
 * Directory: `src/app/(dashboard)/`. `(dashboard)` is erased, so this group serves TWO unrelated
 * URL families rather than one: `/dashboard` from `(dashboard)/dashboard/`, and `/posts/*` from
 * `(dashboard)/posts/`. Both are matched by `src/middleware.ts` for that reason, and the second is
 * the one the group name misdescribes.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The author workspace: their own posts, grouped by lifecycle state.
 *
 * Served by `src/app/(dashboard)/dashboard/page.tsx`, so this is the ONE address in the group where
 * the URL segment and the group name coincide - and the coincidence is why the wrong path for
 * {@link postEditRoute} looked plausible. Any signed-in role may open it; which posts they may
 * actually change is per-post ownership, decided by `backend/app/services/post_service.py`.
 */
export const DASHBOARD_ROUTE = '/dashboard';

/**
 * The empty editor.
 *
 * Served by `src/app/(dashboard)/posts/new/page.tsx`. Note the absent `/dashboard` prefix: the group
 * name is erased, so the URL is `/posts/new`.
 */
export const NEW_POST_ROUTE = '/posts/new';

/**
 * First segment of the authoring family, shared by {@link NEW_POST_ROUTE} and
 * {@link postEditRoute}.
 *
 * Private, because a consumer wanting "the prefix `src/middleware.ts` gates" wants the matcher's own
 * entry rather than this constant, and exporting it would invite a call site to compose an address
 * by hand - which is the thing this module is for.
 */
const POSTS_SEGMENT = '/posts';

/** Final segment of the edit address. */
const EDIT_SEGMENT = 'edit';

/**
 * The editor for one existing post, addressed by its **server-generated identifier**.
 *
 * `/posts/{id}/edit`, served by `src/app/(dashboard)/posts/[id]/edit/page.tsx`.
 *
 * Keyed on the UUID rather than the slug, matching every mutation on the API: the slug is derived
 * once at creation and is the canonical public URL, so an authoring address built on it would change
 * meaning if the taxonomy of slugs ever did. The identifier never changes.
 *
 * The segment is encoded through `encodePathSegment` even though the API only ever emits UUIDs. The
 * cost is nothing, and it refuses the two values that percent-encoding alone would let through - a
 * blank identifier, which would compose `/posts//edit` and address a different route, and `.` or
 * `..`, which the URL grammar resolves against the surrounding path before any router sees it.
 *
 * @param id - The post's `id` as the API reported it.
 * @returns The absolute in-app path, ready for `router.replace`, `router.push` or `<Link href>`.
 * @throws {TypeError} When `id` is absent, blank or a relative-path segment - a programming error,
 * surfaced immediately rather than as a 404 the author has to interpret.
 */
export function postEditRoute(id: string): string {
  const segment = encodePathSegment(id, {
    operation: 'postEditRoute',
    parameterName: 'id',
    hint: "Use the `id` of the post as the API reported it, never its slug and never the author's input.",
  });

  return `${POSTS_SEGMENT}/${segment}/${EDIT_SEGMENT}`;
}
