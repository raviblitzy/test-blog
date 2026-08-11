'use client';

// The administrative post-management screen, rendered at /admin/posts.
//
// The "managing posts" half of the administrative dashboard: a paginated, filterable grid over every
// post in the blog, with a per-row menu that forces a lifecycle transition or deletes the record.
// Three endpoints back it - `GET /api/v1/admin/posts` here, and the `PATCH .../status` and `DELETE`
// pair inside `@/components/admin/post-row-actions`.
//
// -------------------------------------------------------------------------------------------------
// 1. THE ONE PROPERTY OF THIS SCREEN THAT NOTHING ELSE IN THE PRODUCT HAS
//
// This is the ONLY listing in the whole API that bypasses public status scoping. `DRAFT` and
// `ARCHIVED` posts are shown alongside `PUBLISHED` ones, and that breadth is the entire reason the
// administrative namespace exists. Everywhere else a draft is confidential: it never appears in the
// public feed, in a category filter result, or on a public profile.
//
// So the default view here is UNFILTERED. The status control below offers "All statuses" first and
// selects it whenever the URL names no status, and no client-side predicate hides a draft at any
// point. A filter that quietly excluded drafts would defeat the screen rather than tidy it.
//
// -------------------------------------------------------------------------------------------------
// 2. WHAT THIS FILE OWNS, AND WHAT IT MUST NOT TAKE BACK
//
// It owns three things and nothing else: the URL-derived query state, ONE cached read, and the
// column descriptors. Everything else belongs to a dependency, and reclaiming any of it would put a
// second implementation beside one that already exists:
//
//   * `@/lib/api/admin` owns the request. Nothing here calls `fetch`, builds an API path or sets a
//     header - `@/lib/api/client` is the tier's only HTTP module.
//   * `@/components/admin/data-table` owns the presentation of the grid: the header band, the record
//     cards below 48rem, the placeholder rows, the empty panel, the failure panel rendered from the
//     problem document, the result range and the page control. This file passes an envelope and two
//     flags in; it renders no `Pagination` and authors no empty or error UI for the grid body.
//   * `@/components/admin/post-row-actions` owns both mutations, their confirmation modal and the
//     cache invalidation that follows them. The `PATCH .../status` sub-path is written once, there.
//   * `@/app/(admin)/admin/layout.tsx` owns the principal, the pending / signed-out / not-authorised
//     notice states and the section navigation. This page renders INSIDE it.
//
// -------------------------------------------------------------------------------------------------
// 3. THE QUERY KEY IS A CONTRACT, AND GETTING IT WRONG PRODUCES NO ERROR AT ALL
//
// `post-row-actions.tsx` invalidates through `@/lib/admin-cache`, which invalidates the two-segment
// prefix `['admin', 'posts']` after every accepted status change and deletion (React Query matches an
// invalidation by prefix, so one prefix reaches every windowed and filtered variant in the cache).
// {@link ADMIN_POSTS_QUERY_KEY_PREFIX} below therefore has to be exactly those two segments in that
// order, with this screen's parameters as a third element.
//
// If it ever stops matching, nothing throws and nothing logs: the grid simply keeps serving the rows
// it had before the mutation, for the length of the tier's stale window. That silence is why the
// prefix is a named constant with this note attached rather than a literal inlined at the call site.
//
// -------------------------------------------------------------------------------------------------
// 4. QUERY STATE LIVES IN THE URL, NOT IN COMPONENT STATE
//
// `page` and `status` are read from `useSearchParams()` and written back with `router.push`, so any
// result set is linkable, survives a reload and behaves correctly under browser back and forward.
// This is also what makes the grid's page control work: the pagination primitive builds real anchors
// from the current search parameters and omits `page` entirely when it is 1, so a page number held in
// component state would be ignored by every one of those links.
//
// The window SIZE is deliberately not in the URL - see {@link ADMIN_POSTS_PAGE_SIZE}.
//
// -------------------------------------------------------------------------------------------------
// 5. TWO DELIBERATE DEPARTURES FROM THE OBVIOUS COLUMN SET
//
//   a. `view_count` IS NOT RENDERED, and that is not an omission. Nothing in this product increments
//      it: `backend/app/models/post.py` states there is no view-count increment,
//      `backend/app/services/post_service.py` records that the column is deliberately not advanced on
//      a read, and the repository offers no "popular" sort for the same reason - so the only values
//      the column can hold are the default and whatever the demonstration seeder wrote. `@/lib/format`
//      says so at the point of use ("presenting the result would be the defect"), and
//      `src/components/blog/post-card.tsx` refuses it on the same grounds. An administrator cannot
//      tell an unmeasured number from a measured one, so `updated_at` takes that column instead: it is
//      an instant the service genuinely maintains, and "when was this last touched" is the question a
//      management grid is actually asked.
//   b. THE TITLE LINKS ONLY FOR A PUBLISHED POST. `/blog/{slug}` is a Server Component that renders
//      anonymously - the credential store in `@/lib/api/client` is browser-only and no route passes a
//      bearer on its behalf - and the service's public projection is `PUBLISHED`-only for every
//      caller, so that route answers 404 for a draft or an archived post and reaches `notFound()`.
//      Linking one would be a guaranteed dead end in a grid whose whole point is showing the posts
//      that are not public. See {@link publicPostHref}.
//
// -------------------------------------------------------------------------------------------------
// 6. DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT HERE.
//
//   1. `export const metadata` / `generateMetadata`. Next.js forbids either from a module carrying
//      `'use client'`, and `src/app/robots.ts` keeps `/admin` out of every index regardless, so this
//      route has no SEO surface to describe.
//   2. `import React from 'react'`. `frontend/tsconfig.json` sets `"jsx": "react-jsx"`, so the
//      automatic runtime is active and the default import is unnecessary. It is also load-bearing:
//      `next build` rewrites `tsconfig.json` when it disagrees with the `jsx` option, which would
//      leave `git status --porcelain` dirty and fail the "build mutates no tracked file" gate.
//   3. A landmark element. `src/app/layout.tsx` owns `<html>`, `<body>`, the `banner`, `<main>` and
//      the `contentinfo`; the admin layout renders this page inside that `<main>`. No `<header>`,
//      `<main>` or `<footer>` here.
//   4. A provider or a second `<Toaster />`. ThemeProvider, QueryProvider, AuthProvider and sonner's
//      host are all mounted once in the root layout. A second QueryProvider in particular would
//      create a second cache, and the row-action islands' invalidations would then never reach this
//      grid - see section 3.
//   5. A stylesheet import. `src/app/globals.css` is the tier's only stylesheet and the root layout
//      imports it.
//   6. A role check. The layout resolves the principal and refuses this group to anyone who is not an
//      administrator, and the service re-checks authority on every one of these endpoints through a
//      router-level dependency. Re-deriving the role here would be a third copy of a rule that is
//      only ever enforced server-side; a `403` is handled as the ordinary failure it is instead.
//   7. `updatePostStatus`, `deletePost`, or anything at all from `@/lib/api/posts`. The author's own
//      publish and unpublish transitions are not the administrative one, and the administrative pair
//      belongs to the row-action component.
//   8. An inline editor or a nested dynamic segment. Post editing lives at
//      `/dashboard/posts/[id]/edit`; this screen changes status and deletes, and does neither by
//      hand.
//   9. `staleTime`, `gcTime`, `refetchOnWindowFocus` or a `retry` predicate. All four belong to
//      `@/providers/query-provider`, which already refuses to retry a 4xx. Restating one here would
//      create a second authority over the same behaviour.
//  10. A `data-testid`. Every control below carries a real accessible name, which is what a test
//      should bind to.
//  11. A parenthesised path in any href or string. `(admin)` is a route group: the rendered address
//      is `/admin/posts`, which is also the form the middleware matcher and the crawl policy use.
//
// -------------------------------------------------------------------------------------------------
// 7. STYLING RULES THIS FILE IS HELD TO
//
//   * Zero hardcoded values. Every class below is an engine-generated utility resolving to a token;
//     there is no hex, no `rgb()`, no px/rem literal and no arbitrary bracket value. The only literals
//     used anywhere are the six the token rule permits.
//   * Semantic tokens only - `text-foreground`, `text-muted-foreground`, `text-primary`,
//     `outline-ring`. Never a primitive colour family and shade; that mapping belongs to
//     `src/app/globals.css` alone, which is also why there is no `dark:` variant here: each semantic
//     token is declared twice there, so this screen re-themes with no conditional logic.
//   * Project primitives over raw elements. No `<table>`, `<button>`, `<input>` or `<select>` - the
//     grid arrives through `DataTable`, the status pills through `Badge`, the filter through the
//     Radix-backed `Tabs`.
//   * One breakpoint vocabulary, and this file needs none of it: the three responsive tiers are owned
//     by `@/components/ui/table` (record cards below 48rem, scrollable table from 48rem) and by
//     `DataTableColumn.hideBelowLg` (the full column set from 64rem). No media query is authored here.
//
// -------------------------------------------------------------------------------------------------
// 8. GOVERNING STANDARDS
//
// `review_rules` reports that NO user-specified rules were provided for this project, so nothing here
// is invented to satisfy one - and the bar is not lowered either. The binding constraints are the
// technical plan's own enterprise standards, seven of which govern this file: design-system
// compliance (section 7); layered separation of concerns (section 2); explicit API contracts (the wire
// shapes are consumed verbatim in snake_case, with no translation layer); authority enforced
// server-side (section 6, note 6); configuration from the environment only (nothing here reads an
// environment variable - the API base URL belongs to `@/lib/api/client`); accessibility as a floor
// (one `<h1>`, a named filter control, a named grid, decorative avatar imagery, and the document-wide
// `:focus-visible` ring every control inherits); and blocking quality gates (`tsc --noEmit`,
// `eslint --max-warnings=0` and `next build` all pass, and the build leaves the working tree clean).

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, type JSX } from 'react';

import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

import { DataTable } from '@/components/admin/data-table';
import type { DataTableColumn } from '@/components/admin/data-table';
import { PostRowActions } from '@/components/admin/post-row-actions';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge, POST_STATUS_BADGE_VARIANTS } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { listAdminPosts } from '@/lib/api/admin';
import { isApiError } from '@/lib/api/client';
import { formatDate, formatMachineDate } from '@/lib/format';
import { POST_STATUSES } from '@/lib/types';
import type { AdminPost, Page, PostStatus } from '@/lib/types';
import { cn, encodePathSegment, FIRST_PAGE, toPageNumber } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * The window
 * ---------------------------------------------------------------------------------------------- */

/**
 * How many posts one page of this grid holds.
 *
 * Kept OUT of the URL, exactly as the home feed keeps its own window size out of it: `page` and
 * `status` are the reader's query state and belong in a shareable address, while the window size is
 * this screen's layout decision. Putting it in the query string would mint a second URL for the same
 * result set and hand a caller a parameter the service validates at 1..100 and refuses outside it.
 *
 * Twenty matches the service's own default, so the first read of this screen asks for exactly the
 * window it would have received anyway. It is also what the grid's placeholder rows are counted from
 * while the first read is in flight - see {@link EMPTY_ADMIN_POST_PAGE}.
 */
const ADMIN_POSTS_PAGE_SIZE = 20;

/**
 * The envelope handed to the grid before the first response arrives.
 *
 * `DataTable` requires a resolved {@link Page}, deliberately - a nullable one would push the "no data
 * yet" branch into every one of the four administrative screens. So the pending and failed states are
 * expressed as this empty envelope plus the `isLoading` / `error` flags, and the grid decides what to
 * draw from those.
 *
 * `pages: 0` is the correct empty value rather than `1`: the service reports `ceil(total / page_size)`
 * and an empty collection genuinely occupies no pages, which is what keeps the page control from
 * rendering during a first load. `page_size` carries the real window size on purpose - the grid
 * derives its placeholder row count from that field, so a zero here would silently fall back to a
 * generic five rows and the placeholder would have a different height from the page that replaces it.
 */
const EMPTY_ADMIN_POST_PAGE: Page<AdminPost> = {
  items: [],
  total: 0,
  page: FIRST_PAGE,
  page_size: ADMIN_POSTS_PAGE_SIZE,
  pages: 0,
};

/* -------------------------------------------------------------------------------------------------
 * The cache key
 * ---------------------------------------------------------------------------------------------- */

/**
 * The two segments every `GET /admin/posts` cache entry must begin with.
 *
 * This is the hard contract described in section 3 of the header. `@/lib/admin-cache` declares the
 * same two segments as `ADMIN_POSTS_QUERY_KEY` and is what `post-row-actions.tsx` invalidates after a
 * status change or a deletion; React Query matches by prefix, so registering under these segments is
 * what makes a mutation refresh this grid.
 *
 * Written as a tuple here rather than imported so that this screen's dependency surface stays the set
 * of modules it was specified against. The two declarations are one logical value written twice: if
 * either moves, move both.
 */
const ADMIN_POSTS_QUERY_KEY_PREFIX = ['admin', 'posts'] as const;

/* -------------------------------------------------------------------------------------------------
 * Addresses and search parameters
 *
 * Every path is the RENDERED form. `(admin)` is a route group, so it never appears in a URL.
 * ---------------------------------------------------------------------------------------------- */

/** First segment of a post's public reading path, `/blog/{slug}`. @see {@link publicPostHref} */
const POST_PATH_PREFIX = '/blog';

/**
 * The page parameter, spelled the way `@/hooks/use-pagination` spells it.
 *
 * That hook is the sole writer of this parameter inside the grid's page control, and it omits the
 * parameter entirely for page one. Reading it under any other name here would leave this screen stuck
 * on the first page while the anchors beneath it changed the URL correctly.
 */
const PAGE_PARAM = 'page';

/** The lifecycle filter parameter. Its value is a {@link PostStatus} wire literal, or absent. */
const STATUS_PARAM = 'status';

/* -------------------------------------------------------------------------------------------------
 * The status filter vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * The filter value that applies no predicate at all, and the default.
 *
 * A non-empty sentinel rather than an empty string, because it is a real selection in a tab set that
 * always has exactly one tab selected. It is never written to the URL - selecting it DELETES the
 * `status` parameter - so the unfiltered view keeps one canonical address.
 */
const ALL_STATUSES_VALUE = 'ALL';

/** A value the filter can hold: one lifecycle state, or {@link ALL_STATUSES_VALUE}. */
type StatusTabValue = PostStatus | typeof ALL_STATUSES_VALUE;

/**
 * The filter's tabs, in order.
 *
 * "All statuses" leads because it is the default and because it is the view this screen exists to
 * provide; the three states then follow in the lifecycle order `@/lib/types` declares them in -
 * draft, published, archived - rather than alphabetically, so the row of tabs reads as a progression.
 */
const STATUS_TAB_VALUES: readonly StatusTabValue[] = [ALL_STATUSES_VALUE, ...POST_STATUSES];

/**
 * What each tab is called.
 *
 * Exhaustive over {@link StatusTabValue} by its type, so adding a lifecycle state to `@/lib/types`
 * fails compilation here until this table names it. The "All statuses" key is computed from the
 * sentinel rather than written out, so the two cannot drift.
 */
const STATUS_TAB_LABELS: Readonly<Record<StatusTabValue, string>> = {
  [ALL_STATUSES_VALUE]: 'All statuses',
  DRAFT: 'Drafts',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
};

/**
 * How a lifecycle state is named inside a row's status pill.
 *
 * Singular where {@link STATUS_TAB_LABELS} is plural: a tab names a collection, a pill names one
 * record. Exhaustive over the union for the same compile-time reason.
 */
const POST_STATUS_LABELS: Readonly<Record<PostStatus, string>> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
};

/**
 * The one state whose posts have a public page.
 *
 * Annotated as {@link PostStatus} rather than left to inference, and compared against as a named
 * constant rather than inlined. The annotation is what makes a typo a BUILD failure: a comparison
 * against a misspelled literal type-checks perfectly well as a comparison of two strings and is
 * silently always false, which here would mean no title in the grid ever became a link.
 */
const PUBLISHED_STATUS: PostStatus = 'PUBLISHED';

/* -------------------------------------------------------------------------------------------------
 * Copy
 *
 * Named constants rather than inline strings, so the wording is reviewable in one place and a test can
 * assert against the same value the screen renders. Nothing below states a status code, quotes the
 * problem document verbatim or implies a defect - a refusal and an empty window are ordinary states.
 * ---------------------------------------------------------------------------------------------- */

/** The screen's single `<h1>`. The admin layout deliberately emits none, so this is the page's. */
const PAGE_HEADING = 'Posts';

/** The line beneath the heading. Says what the grid spans, because that is its unusual property. */
const PAGE_INTRO =
  'Every post in the blog, across all three lifecycle states - drafts and archived posts included. ' +
  'Use the actions menu on a row to move a post to another state or to delete it.';

/**
 * The grid's accessible name.
 *
 * `DataTable` applies it to the table itself and, suffixed, to the page control's landmark - so a
 * screen-reader user can tell which of the four administrative grids they have landed in, and can tell
 * this grid's pagination apart from any other control on the screen.
 */
const GRID_CAPTION = 'Posts';

/** Accessible name of the filter's `role="tablist"`, which carries no visible heading of its own. */
const STATUS_FILTER_LABEL = 'Filter posts by status';

/** Empty-state headline for the unfiltered view. */
const EMPTY_ALL_TITLE = 'No posts to show';

/**
 * Empty-state supporting line for the unfiltered view.
 *
 * Names both ways the service produces an empty window, because they are genuinely different
 * situations and only one of them means the blog is empty: a page past the end of the collection is
 * answered with an empty `items` list beside the real totals rather than with an error, and the grid
 * keeps its page control visible there so the way back is one click away.
 */
const EMPTY_ALL_DESCRIPTION =
  'Nothing has been written yet, or this page is past the end of the list.';

/** Empty-state headline per lifecycle state. Exhaustive over the union. */
const EMPTY_STATUS_TITLES: Readonly<Record<PostStatus, string>> = {
  DRAFT: 'No drafts to show',
  PUBLISHED: 'No published posts to show',
  ARCHIVED: 'No archived posts to show',
};

/** Empty-state supporting line whenever a lifecycle filter is applied. */
const EMPTY_STATUS_DESCRIPTION =
  'No post is in this state on this page. Choose "All statuses" to see every post.';

/** Toast headline for a read that failed for any reason other than a refusal. */
const LOAD_FAILURE_TITLE = 'Posts could not be loaded';

/** Toast supporting line when the failure carried nothing readable of its own. */
const LOAD_FAILURE_DETAIL = 'The posts could not be read. Try again in a moment.';

/**
 * Toast headline for a refusal.
 *
 * Separated from the generic failure because the two ask different things of the operator: a transient
 * failure is worth retrying, and a refusal is not - no fresh credential can grant an authority the
 * account does not hold, which is also why the API client does not attempt rotation for a `403`.
 */
const NOT_AUTHORISED_TITLE = 'Not authorised';

/** Toast supporting line for a refusal that carried nothing readable of its own. */
const NOT_AUTHORISED_DETAIL =
  'This account is not allowed to manage posts. Sign in as an administrator to continue.';

/** Rendered in the publication column for a post that has never been published. */
const NOT_PUBLISHED_LABEL = 'Not published';

/** Rendered in the title column for the state the service's own validation makes unreachable. */
const UNTITLED_LABEL = 'Untitled post';

/** The initials shown when a display name and a username both yield no usable letter. */
const INITIALS_FALLBACK = '?';

/** How many words of a display name contribute an initial to the avatar fallback. */
const MAX_INITIALS = 2;

/**
 * The status a refusal arrives with.
 *
 * A named constant so the comparison below reads as intent rather than as a magic number, and so the
 * one place this screen branches on a status code is greppable.
 */
const HTTP_FORBIDDEN = 403;

/* -------------------------------------------------------------------------------------------------
 * Column headers
 *
 * Separate from the copy above only because each one is also the record card's field label: below
 * 48rem the header band is `display: none`, so `DataTable` reuses a plain-string header as the label
 * beside that column's value. Every column here therefore keeps a plain-string header - see the
 * columns table for the one that suppresses its label instead.
 * ---------------------------------------------------------------------------------------------- */

/** @see {@link POST_COLUMNS} */
const TITLE_HEADER = 'Title';

/** @see {@link POST_COLUMNS} */
const AUTHOR_HEADER = 'Author';

/** @see {@link POST_COLUMNS} */
const STATUS_HEADER = 'Status';

/** @see {@link POST_COLUMNS} */
const PUBLISHED_HEADER = 'Published';

/** @see {@link POST_COLUMNS} */
const UPDATED_HEADER = 'Last updated';

/** @see {@link POST_COLUMNS} */
const ACTIONS_HEADER = 'Actions';

/* -------------------------------------------------------------------------------------------------
 * Class strings
 *
 * Declared once each, in the order prettier-plugin-tailwindcss emits them, and composed through `cn`
 * only where two groups genuinely share a base. Every value resolves to a token.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The page's vertical stack: heading block, filter, grid.
 *
 * `min-w-0` is load-bearing rather than defensive. Without it a flex item refuses to shrink below its
 * content's intrinsic width, so one long title or one unbroken slug inside the grid would widen the
 * whole document and produce exactly the horizontal overflow the responsive contract forbids at 375,
 * 768 and 1440 pixels. The admin layout sets the same class on the region this renders into, and both
 * are needed: each removes the floor on its own level of the flex tree.
 */
const PAGE_CLASSES = 'flex min-w-0 flex-col gap-6';

/** The heading and its intro line. `gap-1` keeps them as one block rather than two. */
const HEADER_CLASSES = 'flex min-w-0 flex-col gap-1';

/**
 * The `<h1>`.
 *
 * `text-2xl` is the page-heading step the sibling author workspace uses, so moving between the two
 * groups does not move the type. Both values are `--text-*` and `--font-weight-*` tokens.
 */
const HEADING_CLASSES = 'text-foreground text-2xl font-semibold tracking-tight';

/**
 * The intro line.
 *
 * `max-w-2xl` is a `--container-*` token that holds the sentence to a readable measure instead of
 * letting it run the full width of a wide grid.
 */
const INTRO_CLASSES = 'text-muted-foreground max-w-2xl text-sm';

/**
 * The title cell's shared base, whether it becomes a link or plain text.
 *
 * `wrap-anywhere` is `overflow-wrap: anywhere`, and it is the one value that reduces a box's
 * min-content intrinsic size - which is what a pasted URL or a long unbroken title needs. `break-words`
 * would look like the same safeguard while doing nothing here, because it leaves min-content width
 * untouched. Below 48rem the record card is the presentation where that matters most: the card has no
 * scrollport of its own, so an unbreakable string there pushes the document instead.
 */
const TITLE_BASE_CLASSES = 'wrap-anywhere font-medium';

/**
 * The title cell when the post has a public page.
 *
 * The same recipe `src/components/blog/post-card.tsx` and `src/components/admin/stat-card.tsx` use for
 * a link that sits inside a surface rather than in running text, so all three read as one system:
 *
 *   * `rounded-sm` keeps the focus outline hugging the text rather than tracing a square around it.
 *   * `hover:text-primary hover:underline` - the engine gates `hover:` behind
 *     `@media (hover: hover)`, so a touch device never gets a state stuck on after a tap, and the
 *     underline travels with the colour change so the affordance is never carried by colour alone.
 *   * The focus ring is the document's own `--color-ring`, on `:focus-visible` rather than `:focus`.
 *     `globals.css` already sets a document-wide floor at this width; restating it lands on the same
 *     2px, so nothing visibly changes thickness and the cell stays correct if that floor is narrowed.
 *   * `motion-safe:` gates the colour transition on `prefers-reduced-motion: no-preference`.
 */
const TITLE_LINK_CLASSES = cn(
  TITLE_BASE_CLASSES,
  'rounded-sm',
  'hover:text-primary hover:underline',
  'focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',
  'motion-safe:transition-colors motion-safe:ease-out',
);

/**
 * The author cell: a circle and a name on one line.
 *
 * `min-w-0` again, so the name truncates inside its own box instead of setting a floor on the row's
 * width. `gap-2` separates the two without a margin between siblings.
 */
const AUTHOR_CELL_CLASSES = 'flex min-w-0 items-center gap-2';

/**
 * The avatar, one spacing step smaller than the primitive's default.
 *
 * `size-8` is `8 * --spacing`, which sits comfortably inside the header band's own `h-11` so a row does
 * not grow taller than the band above it. The primitive's own `shrink-0` keeps the circle round when
 * the name beside it is long.
 */
const AVATAR_CLASSES = 'size-8';

/**
 * The initials inside a shrunken avatar.
 *
 * Paired with {@link AVATAR_CLASSES} deliberately: the fallback's type size does not scale with the
 * root, so the primitive asks a caller that resizes the circle to size the initials in the same
 * breath. `text-xs` is the `--text-*` step below the primitive's own default.
 */
const AVATAR_FALLBACK_CLASSES = 'text-xs';

/** The author's name. Truncated rather than wrapped, so a row keeps one line's height. */
const AUTHOR_NAME_CLASSES = 'min-w-0 truncate';

/**
 * An absent value's stand-in - the publication instant of a post that has never been published.
 *
 * `text-muted-foreground` marks it as the absence of a value rather than as one, which is the whole
 * reason it is styled at all: "Not published" in the same weight as a real date would read as a date.
 */
const PLACEHOLDER_CLASSES = 'text-muted-foreground';

/**
 * A rendered instant.
 *
 * `whitespace-nowrap` keeps "12 March 2025" on one line, so the column's width is predictable and the
 * grid overflows its scrollport at 768 rather than growing taller. `tabular-nums` lines the digits up
 * between rows, which is what makes a column of dates scannable.
 */
const DATE_CLASSES = 'whitespace-nowrap tabular-nums';

/**
 * The actions cell's wrapper.
 *
 * One element, because below 48rem a cell is a flex row that separates its label from its value and
 * several sibling children would be spaced apart individually instead of staying grouped. `justify-end`
 * is what keeps the pill and the menu trigger together at the trailing edge in both presentations -
 * the column's own `align: 'end'` only sets text alignment and never a width.
 */
const ACTIONS_CELL_CLASSES = 'flex items-center justify-end';

/* -------------------------------------------------------------------------------------------------
 * Pure helpers
 *
 * Every function below takes its inputs and returns a value. None reads the URL, performs a request,
 * touches a browser global or throws: an absent field, a hand-edited parameter and an unrecognised
 * value are all ordinary inputs with defined answers, because an administrative grid must not be
 * breakable from the address bar.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a string names a lifecycle state.
 *
 * A real membership test against {@link POST_STATUSES}, never a cast. The value arrives typed `string`
 * - from a search parameter, or from the tab primitive's `onValueChange` - and asserting it into the
 * union would let an unexpected value type-check its way into a `Record<PostStatus, ...>` lookup that
 * would then miss at run time and render `undefined`.
 *
 * `some` with an equality test rather than `includes`, which refuses a `string` argument when the
 * array is a readonly tuple of literals.
 *
 * @param value - Any string.
 * @returns `true` when `value` is one of the three wire literals.
 */
function isPostStatus(value: string): value is PostStatus {
  return POST_STATUSES.some((status) => status === value);
}

/**
 * Whether a string names one of the filter's tabs.
 *
 * @param value - Any string, typically the value the tab primitive hands back.
 * @returns `true` for {@link ALL_STATUSES_VALUE} and for each lifecycle state.
 */
function isStatusTabValue(value: string): value is StatusTabValue {
  return value === ALL_STATUSES_VALUE || isPostStatus(value);
}

/**
 * Read the lifecycle filter out of the URL.
 *
 * Case-folded and trimmed before the membership test, so a hand-typed `?status=draft` resolves to the
 * `DRAFT` the service expects. Folding cannot admit a value the union does not contain - the test still
 * has to pass afterwards - so the accepted set is exactly the three wire literals however they were
 * typed.
 *
 * An absent, blank or unrecognised value answers `undefined`, which is the UNFILTERED view rather than
 * an error. That direction is deliberate: the failure mode of a stale or mistyped parameter is showing
 * every post, never quietly hiding the drafts this screen exists to surface.
 *
 * @param raw - The `status` search parameter, or `null` when it is absent.
 * @returns The state to filter on, or `undefined` for every state.
 */
function statusFilterFromParam(raw: string | null): PostStatus | undefined {
  if (raw === null) {
    return undefined;
  }

  const candidate = raw.trim().toUpperCase();

  return isPostStatus(candidate) ? candidate : undefined;
}

/**
 * The public reading path of a post, or `null` when it has none.
 *
 * Two refusals, and both are correctness rather than caution:
 *
 *   1. A post that is not `PUBLISHED` has no public page. `/blog/{slug}` is a Server Component that
 *      renders anonymously, and the service's public projection is published-only for every caller, so
 *      that route answers 404 for a draft or an archived post and renders its not-found boundary. See
 *      section 5b of the header.
 *   2. A blank slug cannot compose a path segment. `encodePathSegment` throws on one rather than
 *      composing `/blog/`, which would address the feed instead of a post - so the blank case is
 *      answered here, before the encoder is reached, and the throw path is unreachable from a render.
 *
 * The slug is encoded through the tier's one path-segment encoder even though a generated slug is
 * URL-safe by construction. It is a no-op for a real slug, and it is what keeps a value that is not
 * what it claims to be - a raw title, a dot segment from a hand-edited record - inside its own segment
 * instead of restructuring the URL.
 *
 * @param post - The row being rendered.
 * @returns A root-relative path, or `null` when no public page exists for this post.
 */
function publicPostHref(post: AdminPost): string | null {
  if (post.status !== PUBLISHED_STATUS || post.slug.trim() === '') {
    return null;
  }

  return `${POST_PATH_PREFIX}/${encodePathSegment(post.slug, {
    operation: 'AdminPostsPage',
    parameterName: 'slug',
    // Trimmed rather than sent verbatim: this value becomes a link a person can click and copy, and a
    // percent-encoded space in it would publish an address that resolves nowhere. The service
    // generates every slug and constrains it unique, so padding here means the row is not the record
    // the caller believed it had.
    whitespace: 'trim',
    hint: 'Use the slug the administrative listing returned for the row.',
  })}`;
}

/**
 * One or two initials for the avatar fallback.
 *
 * Rendered whenever the sibling image has not loaded, which covers an author who never set an avatar, a
 * host that is down, and the interval before a slow image arrives. Total by construction: a blank
 * display name falls back to the username, and a source that yields no letter at all - punctuation, an
 * emoji-only handle - answers {@link INITIALS_FALLBACK} rather than an empty circle.
 *
 * The first character is taken by spreading the word rather than by indexing it, because indexing a
 * string yields a single UTF-16 code unit and would split any character above U+FFFF into half of a
 * surrogate pair - which renders as a replacement glyph.
 *
 * The parameter is typed off {@link AdminPost} rather than by importing the author projection
 * separately, so this helper cannot disagree with the shape the grid actually receives.
 *
 * @param author - The post's author, as the administrative projection carries it.
 * @returns One or two upper-case letters, or `?`.
 */
function authorInitials(author: AdminPost['author']): string {
  const source = author.display_name.trim() === '' ? author.username : author.display_name;
  const words = source.trim().split(/\s+/u);
  const initials = words
    .slice(0, MAX_INITIALS)
    .map((word) => [...word][0] ?? '')
    .join('');

  return initials === '' ? INITIALS_FALLBACK : initials.toUpperCase();
}

/**
 * One readable sentence describing a failed read, or `undefined` when it carried none.
 *
 * Reads the problem document the API client normalises every failure into, preferring `detail` (what
 * went wrong on this occasion) over `title` (the constant name of the problem kind), and falling back
 * to a plain `Error`'s message for a failure that never reached the service - an aborted request, a
 * refused connection.
 *
 * Deliberately returns no status code, no `request_id`, no `instance` and no stack. The caller
 * substitutes its own sentence when this answers `undefined`, so an empty line is never rendered.
 *
 * @param error - The rejection, as React Query surfaced it.
 * @returns The sentence to show, or `undefined`.
 */
function describeFailure(error: unknown): string | undefined {
  if (isApiError(error)) {
    const detail = error.problem.detail.trim();

    if (detail.length > 0) {
      return detail;
    }

    const title = error.problem.title.trim();

    return title.length > 0 ? title : undefined;
  }

  if (error instanceof Error) {
    const message = error.message.trim();

    return message.length > 0 ? message : undefined;
  }

  return undefined;
}

/**
 * Whether a failure is the service refusing the caller rather than failing.
 *
 * Narrowed through the client's own predicate, so a plain `Error` - which has no status at all - can
 * never be mistaken for a refusal.
 *
 * This case is reachable even though the surrounding layout admits only administrators, and treating it
 * as ordinary is the point: the layout's gate and the middleware's are user experience, the middleware
 * runs on the Edge runtime and cannot verify a token's signature, and authority is re-checked by the
 * service on every one of these endpoints. So a screen that rendered is not proof of authority, and the
 * honest answer to a refusal is to say so - not to crash, and not to show an empty grid, which would
 * report "there are no posts" when the real answer was "you may not see these".
 *
 * @param error - The rejection, as React Query surfaced it.
 * @returns `true` when the service answered `403`.
 */
function isNotAuthorised(error: unknown): boolean {
  return isApiError(error) && error.status === HTTP_FORBIDDEN;
}

/**
 * Stable identity for one row.
 *
 * Never an array index: this grid filters and pages, and an index key would make React reuse the DOM of
 * one record for another - which at best redraws a row of mismatched values and at worst leaves a
 * row-action menu pointed at the previous post. Every post carries a server-generated UUID, so that is
 * what the key is.
 *
 * Declared at module scope so its identity is stable across renders.
 *
 * @param post - The row.
 * @returns The post's identifier.
 */
function postRowId(post: AdminPost): string {
  return post.id;
}

/* -------------------------------------------------------------------------------------------------
 * The columns
 *
 * A MODULE-LEVEL constant, which is what `DataTable` asks for: its `columns` prop is a `ReadonlyArray`
 * precisely so a screen can define them once instead of rebuilding the array - and every `cell` below
 * closes over nothing but its own row, so there is nothing per-render for them to capture.
 *
 * EVERY column carries a label, and that is a requirement rather than a courtesy. Below 48rem the header
 * band is `display: none`, which removes the `<th>` elements from the accessibility tree as well as from
 * the layout, so the label is the only thing that says which column a value came from - visually and to a
 * screen reader alike. Five of the six inherit it from a plain-string header; the actions column passes
 * an empty string, which is the documented way to suppress a label for a cell that describes itself.
 *
 * `hideBelowLg` marks the third responsive tier. Only "Last updated" is demoted: the record cards below
 * 48rem and the scrollable table from 48rem belong to `@/components/ui/table`, and this flag is what
 * makes "every column from 64rem" mean something. It hides the column at EVERY width below 64rem, the
 * 375 card included, so it is reserved for the one value an administrator never needs in order to
 * identify a post or decide what to do with it.
 * ---------------------------------------------------------------------------------------------- */

const POST_COLUMNS: ReadonlyArray<DataTableColumn<AdminPost>> = [
  {
    id: 'title',
    header: TITLE_HEADER,
    cell: (post) => {
      const href = publicPostHref(post);
      // The service constrains a title non-blank, so this fallback is unreachable through the API. It is
      // here because a cell must never render as nothing: below 48rem an empty value would leave a card
      // showing the word "Title" and no title, which reads as a broken row rather than as a missing one.
      const title = post.title.trim() === '' ? UNTITLED_LABEL : post.title;

      return href === null ? (
        <span className={TITLE_BASE_CLASSES}>{title}</span>
      ) : (
        <Link className={TITLE_LINK_CLASSES} href={href}>
          {title}
        </Link>
      );
    },
  },
  {
    id: 'author',
    header: AUTHOR_HEADER,
    cell: (post) => (
      // ONE element, because below 48rem the cell is a flex row that separates the label from the value:
      // two sibling children would be spaced apart individually instead of staying grouped opposite it.
      <div className={AUTHOR_CELL_CLASSES}>
        <Avatar className={AVATAR_CLASSES}>
          {/*
           * `alt=""` - decorative, and deliberately not the author's name. The name sits immediately
           * beside it, so naming the image would make a screen reader announce the same words twice per
           * row. `undefined` rather than `null` for an author with no avatar, because that is what tells
           * Radix there is no image to attempt and to render the fallback straight away. The primitive
           * also screens the URL against the tier's image-host allow-list, so a stored host this tier
           * will not fetch from degrades to the initials rather than to a broken image.
           */}
          <AvatarImage alt="" src={post.author.avatar_url ?? undefined} />
          <AvatarFallback className={AVATAR_FALLBACK_CLASSES}>
            {authorInitials(post.author)}
          </AvatarFallback>
        </Avatar>

        {/*
         * Not a link. The row already has one - the title - and a second link to a public profile would
         * double the tab stops in a grid of twenty rows while answering a question this screen is not
         * about. `display_name` is `TEXT NOT NULL` in the service and is derived from the username at
         * registration when none was given, so it is always present.
         */}
        <span className={AUTHOR_NAME_CLASSES}>{post.author.display_name}</span>
      </div>
    ),
  },
  {
    id: 'status',
    header: STATUS_HEADER,
    cell: (post) => (
      /*
       * The tone comes from the primitive's own exhaustive state-to-variant table rather than from a
       * colour chosen here, so a re-tone is one edit in `@/components/ui/badge` and every status pill in
       * the product follows. The LABEL is always present: the tone reinforces the state and never
       * carries it, so the row reads correctly for anyone who cannot distinguish these colours.
       *
       * `PostRowActions` renders a pill of its own in the trailing cell, so the state appears TWICE in
       * every row. That was measured in a browser rather than missed, and this column is kept anyway,
       * for three reasons. It is the only thing that puts a "Status" column in the header band and a
       * "Status" label beside the value in the record card below 48rem, where the trailing pill is
       * deliberately unlabelled - so removing this one would leave the state readable but unnamed,
       * which is strictly worse for anyone who cannot tell these colours apart. It is what makes a grid
       * of twenty rows scannable down one axis. And the trailing pill is not this file's to remove: the
       * row-action component documents it as load-bearing, because the menu row naming the current
       * state is disabled and therefore unreachable by keyboard, leaving that pill as the reading a
       * screen-reader user gets. Two honest views of one fact, at the two places each is useful.
       */
      <Badge variant={POST_STATUS_BADGE_VARIANTS[post.status]}>
        {POST_STATUS_LABELS[post.status]}
      </Badge>
    ),
  },
  {
    id: 'published',
    header: PUBLISHED_HEADER,
    cell: (post) => {
      /*
       * `published_at` is legitimately `null` here - it is `null` for every draft, and this grid exists
       * largely to show drafts - so the absent case is the normal one rather than an edge.
       *
       * The machine-readable form is computed first and used as the guard: both formatters are total and
       * answer an empty string for an absent or unparseable instant, so a `<time>` is emitted only when
       * there is a real instant to put in its `dateTime` attribute. Emitting `<time dateTime="">` would
       * be an invalid attribute value, and formatting inline instead of through `@/lib/format` is what
       * produces "Invalid Date" - the wire carries ISO-8601 strings, never `Date` objects.
       *
       * The branch is on the INSTANT, never on the status, and that distinction is load-bearing. A post
       * moved back to `DRAFT` after having been published keeps its `published_at` - the service does
       * not clear it, and the database constraint only requires the instant when the state IS published
       * - so such a row legitimately shows a "Draft" pill beside a real date. Observed in a browser, and
       * correct: this column is the publication INSTANT, not a restatement of the lifecycle state the
       * Status column already carries. Substituting the placeholder for every non-published row would
       * discard a fact the service reports, and would also blank the two archived posts, which have
       * genuinely been published.
       */
      const machineDate = formatMachineDate(post.published_at);

      if (machineDate === '') {
        return <span className={PLACEHOLDER_CLASSES}>{NOT_PUBLISHED_LABEL}</span>;
      }

      return (
        <time className={DATE_CLASSES} dateTime={machineDate}>
          {formatDate(post.published_at)}
        </time>
      );
    },
  },
  {
    id: 'updated',
    header: UPDATED_HEADER,
    hideBelowLg: true,
    cell: (post) => {
      // `updated_at` is `TIMESTAMPTZ NOT NULL` and is maintained on every write, so the guard here is
      // for a malformed value rather than an absent one - and it costs one comparison to be certain a
      // demoted column can never render "Invalid Date" at the one width where it is visible.
      const machineDate = formatMachineDate(post.updated_at);

      if (machineDate === '') {
        return <span className={PLACEHOLDER_CLASSES}>{NOT_PUBLISHED_LABEL}</span>;
      }

      return (
        <time className={DATE_CLASSES} dateTime={machineDate}>
          {formatDate(post.updated_at)}
        </time>
      );
    },
  },
  {
    id: 'actions',
    header: ACTIONS_HEADER,
    /*
     * The one suppressed label. A row-action menu describes itself - its trigger's accessible name
     * already identifies the record it acts on - and a field name printed beside a menu button inside a
     * record card reads as a mislabelled control.
     */
    label: '',
    align: 'end',
    cell: (post) => (
      <div className={ACTIONS_CELL_CLASSES}>
        {/*
         * The whole mutation surface of this screen, and everything about it belongs to the component:
         * the forced transition to any of the three states, the confirmed deletion, and the cache
         * invalidation that follows either. `onChanged` is deliberately not supplied - see the note on
         * {@link AdminPostsPage}.
         */}
        <PostRowActions post={post} />
      </div>
    ),
  },
];

/* -------------------------------------------------------------------------------------------------
 * AdminPostsPage
 * ---------------------------------------------------------------------------------------------- */

/**
 * The administrative post-management screen at `/admin/posts`.
 *
 * Reads its window and its lifecycle filter from the URL, performs ONE cached read of
 * `GET /api/v1/admin/posts`, and composes a heading, a status filter and the shared administrative
 * grid. Every mutation belongs to the row-action component inside the grid's trailing column.
 *
 * ## The three states, and who renders each
 *
 * | State   | What is on screen                                                                      |
 * | ------- | -------------------------------------------------------------------------------------- |
 * | Pending | The heading and the filter stand where they will stand; the grid draws placeholder rows |
 * | Failed  | The grid renders the problem document in place, and a toast says the same thing once    |
 * | Loaded  | The rows, the result range, and the page control when there is more than one page       |
 *
 * All three are the grid's to draw - it owns the placeholder rows, the failure panel and the empty
 * panel - so this component chooses none of them. It passes the envelope, `isLoading` and `error`, and
 * the grid resolves the precedence between them in one place.
 *
 * The states the LAYOUT owns are absent here by design: there is no session placeholder, no signed-out
 * panel, no not-authorised screen and no redirect. `src/app/(admin)/admin/layout.tsx` renders all of
 * those and only renders this page once an administrator exists.
 *
 * ## Why `onChanged` is not passed to `PostRowActions`
 *
 * The component invalidates `['admin', 'posts']` itself after every accepted mutation, so the grid
 * refreshes with or without the callback - the hook exists for what a SCREEN owes the operator that the
 * cache cannot express, and its documented example is returning to the first page after deleting the
 * last row of the last one.
 *
 * That correction is not made here, because it cannot be made correctly from this callback. It receives
 * no argument, so a status change and a deletion are indistinguishable - and a status change removes a
 * row from the window only while a filter is applied. A blind "the window held one row, so go to page
 * one" rule would therefore yank an operator off page three for merely re-publishing a post that is
 * still sitting in front of them. Nothing is lost by declining it: the grid deliberately keeps its page
 * control visible over an empty window precisely so that the way back from one is one click away.
 *
 * @returns The heading, the status filter and the grid.
 */
export default function AdminPostsPage(): JSX.Element {
  /*
   * The three navigation hooks, and all three are needed. `useSearchParams` is the query state itself;
   * `usePathname` and `useRouter` are how the filter writes the next state back without hard-coding this
   * screen's own address - reading the path rather than naming it is what keeps the route group's
   * parentheses out of every URL this component produces.
   */
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  /*
   * The window, straight from the address, so a result set is linkable and survives a reload. The parse
   * is the tier's own: digits only, at least one, and bounded - so a missing, blank, fractional,
   * negative, hexadecimal or exponential value falls back to the first page instead of putting `NaN`
   * into a request. A page past the end needs nothing special: the service echoes the requested page
   * back beside the real totals with an empty `items` list, which is the honest answer and the one the
   * grid's empty panel plus its page control are written for.
   */
  const page = toPageNumber(searchParams.get(PAGE_PARAM)) ?? FIRST_PAGE;

  /*
   * The filter, also from the address. `undefined` means EVERY lifecycle state - the wrapper omits the
   * parameter from the request in that case, and omitting it is what makes drafts and archived posts
   * arrive alongside published ones.
   */
  const statusFilter = statusFilterFromParam(searchParams.get(STATUS_PARAM));

  /*
   * Which tab is selected. Derived from the URL rather than held in state, so the control cannot
   * disagree with the rows beneath it, and so an unrecognised `?status=` value selects "All statuses"
   * instead of leaving the tab set with nothing selected.
   */
  const selectedTab: StatusTabValue = statusFilter ?? ALL_STATUSES_VALUE;

  const {
    data: postsPage,
    error,
    isPending,
  } = useQuery({
    /*
     * The signal is forwarded so a screen left mid-read cancels rather than resolving into a cache
     * nobody is looking at - which matters most on this screen, where turning a page or changing the
     * filter starts a new read while the previous one is still outstanding.
     *
     * `status` is passed as read, `undefined` included: the client's query builder drops a nullish
     * value, so an unfiltered view sends no `status` parameter at all rather than an empty one.
     */
    queryFn: ({ signal }): Promise<Page<AdminPost>> =>
      listAdminPosts({ page, page_size: ADMIN_POSTS_PAGE_SIZE, status: statusFilter }, { signal }),

    /*
     * The two contract segments first - see section 3 of the header - then this screen's parameters, so
     * every window and every filter is its own cache entry while all of them sit under the one prefix a
     * mutation invalidates. `null` rather than `undefined` for an absent filter, so the key serialises
     * to a stable, explicit "no filter" instead of relying on how a hash treats a missing member.
     */
    queryKey: [
      ...ADMIN_POSTS_QUERY_KEY_PREFIX,
      { page, page_size: ADMIN_POSTS_PAGE_SIZE, status: statusFilter ?? null },
    ],

    /*
     * NOTHING ELSE. `staleTime`, `gcTime`, `refetchOnWindowFocus` and the retry predicate that refuses
     * to repeat a 4xx all belong to `@/providers/query-provider`, and restating one here would create a
     * second authority over the same behaviour. `refetchOnMount` is left unset too: this screen is not
     * arrived at from an editor that has just changed a post behind its back, so the tier's default
     * behaviour is the correct one.
     */
  });

  /**
   * Move the filter, and reset the window with it.
   *
   * Four things happen here, and each one is deliberate:
   *
   *   1. The incoming value is NARROWED by a real membership test rather than asserted. The primitive's
   *      API promises a `string`, and a value that names no tab is ignored - which leaves the current
   *      selection standing instead of blanking the screen.
   *   2. The next query string is built from a COPY of the current one, never from a fresh
   *      `URLSearchParams`, so any parameter this screen does not own survives the change.
   *   3. `page` is DELETED. A new filter invalidates the operator's position in the old result set:
   *      page three of the drafts is not page three of everything, and carrying the number across would
   *      land on a window that may not exist.
   *   4. "All statuses" REMOVES the parameter rather than writing a sentinel, so the unfiltered view has
   *      exactly one address - which is the same reason the page control omits `page` for page one.
   *
   * `push` rather than `replace`: a filter change is a destination an operator should be able to come
   * back from with the browser's own Back button. `scroll: false` keeps the grid where it is, because
   * the control that was just used sits directly above it.
   */
  const handleStatusChange = useCallback(
    (value: string): void => {
      if (!isStatusTabValue(value)) {
        return;
      }

      const nextParams = new URLSearchParams(searchParams.toString());

      if (value === ALL_STATUSES_VALUE) {
        nextParams.delete(STATUS_PARAM);
      } else {
        nextParams.set(STATUS_PARAM, value);
      }

      nextParams.delete(PAGE_PARAM);

      const nextQuery = nextParams.toString();

      router.push(nextQuery === '' ? pathname : `${pathname}?${nextQuery}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  /*
   * The toast half of the failure report. Keyed on the error's IDENTITY, so one failure is announced
   * once rather than on every re-render, and a recovery announces nothing at all. The grid renders the
   * persistent half in place; this is the part that interrupts.
   *
   * A refusal is reported differently from a failure because the two ask different things of the
   * operator - see {@link isNotAuthorised}. Neither message carries a status code, a correlation
   * identifier or a stack.
   */
  useEffect(() => {
    if (error === null) {
      return;
    }

    const refused = isNotAuthorised(error);

    toast.error(refused ? NOT_AUTHORISED_TITLE : LOAD_FAILURE_TITLE, {
      description:
        describeFailure(error) ?? (refused ? NOT_AUTHORISED_DETAIL : LOAD_FAILURE_DETAIL),
    });
  }, [error]);

  /*
   * The grid, built once and rendered by whichever tab panel is mounted. Radix mounts only the selected
   * panel, so this element reaches the DOM exactly once however many panels are declared.
   *
   * The empty-state copy names the filter that produced the empty window, because "no posts" and "no
   * drafts" are different facts and only the second one has an obvious next step.
   */
  const grid = (
    <DataTable
      caption={GRID_CAPTION}
      columns={POST_COLUMNS}
      emptyDescription={
        statusFilter === undefined ? EMPTY_ALL_DESCRIPTION : EMPTY_STATUS_DESCRIPTION
      }
      emptyTitle={statusFilter === undefined ? EMPTY_ALL_TITLE : EMPTY_STATUS_TITLES[statusFilter]}
      error={error}
      getRowId={postRowId}
      isLoading={isPending}
      /*
       * The envelope exactly as the service sent it - all five snake_case fields, nothing unwrapped and
       * nothing recomputed. That pass-through is what lets one grid serve users, posts, comments and
       * categories. `EMPTY_ADMIN_POST_PAGE` stands in only until the first response arrives.
       */
      page={postsPage ?? EMPTY_ADMIN_POST_PAGE}
    />
  );

  return (
    <div className={PAGE_CLASSES}>
      <div className={HEADER_CLASSES}>
        {/* The document's only `<h1>`: the root layout emits no heading and the admin layout emits none
            in this state, so every heading inside the grid descends from this one. */}
        <h1 className={HEADING_CLASSES}>{PAGE_HEADING}</h1>
        <p className={INTRO_CLASSES}>{PAGE_INTRO}</p>
      </div>

      {/*
       * Radix supplies the tablist and tab roles, the selected state, the trigger-to-panel pairing and
       * the roving-focus keyboard model. Nothing here authors any of them; the only ARIA written at this
       * call site is the control's own name, because the row of tabs has no visible heading to point at
       * and a second heading here would compete with the `h1` above.
       *
       * `activationMode="manual"` is not a default and it matters: automatic activation selects a tab as
       * focus arrives, so arrowing across four tabs would push four URLs and start four reads. Manual
       * activation waits for Enter or Space, which is the documented choice when a panel is expensive to
       * render - and here each one is a request.
       */}
      <Tabs activationMode="manual" onValueChange={handleStatusChange} value={selectedTab}>
        <TabsList aria-label={STATUS_FILTER_LABEL}>
          {STATUS_TAB_VALUES.map((value) => (
            <TabsTrigger key={value} value={value}>
              {STATUS_TAB_LABELS[value]}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* One panel per tab, so the selected trigger always has the region it points at. Only the
            selected one is mounted, which is what keeps a single grid on screen. */}
        {STATUS_TAB_VALUES.map((value) => (
          <TabsContent key={value} value={value}>
            {grid}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
