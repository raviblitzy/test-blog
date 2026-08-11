'use client';

// The author workspace - the page served at /dashboard.
//
// AAP §0.7.3.1 lists this screen as "Author workspace", route `/dashboard`, rendering `Client`, key
// content "Own posts grouped by lifecycle status with per-row actions". It is the reading half of
// R2 ("create, edit, delete, and publish blog posts"): the author arrives here to SEE where each of
// their posts stands, and leaves through a link to the editor, which owns every transition.
//
// The URL is `/dashboard`, not `/(dashboard)/dashboard`. A parenthesised directory is a route GROUP
// and its name is erased from the address, which is also why the two sibling authoring screens in
// this group serve `/posts/new` and `/posts/{id}/edit` with no `/dashboard` prefix at all. Nothing
// in this file spells either address: both come from `@/lib/routes`, which exists precisely so that
// the group's misleading directory shape cannot leak into a navigation - see section 3.
//
// -------------------------------------------------------------------------------------------------
// 1. WHAT THIS FILE OWNS, AND WHAT IT DELIBERATELY DOES NOT
//
// It owns exactly three things: the document's single `<h1>` for this route, one read of the
// author's own posts, and the partitioning of that read into three lifecycle panels. Everything
// else on screen belongs to a file that already exists.
//
//   The session states.   `src/app/(dashboard)/layout.tsx` renders the in-flight placeholder, the
//       signed-out panel and the "session could not be confirmed" panel, and only renders
//       `{children}` once a principal is resolved. Repeating any of them here would double the
//       chrome; so this file renders none of them - while still being null-safe about `user`,
//       without a non-null assertion. See section 4.
//   The shell.            The same layout owns the page's max width, gutters and the workspace
//       rail, so the root element below contributes only a vertical rhythm and `min-w-0`.
//   Every lifecycle write. `src/components/blog/post-editor.tsx` is the single owner of create,
//       update, delete, publish and unpublish, and it is reached through the two links this page
//       renders. Nothing here mutates anything: there is no `useMutation`, no confirmation dialog
//       and no call to `publishPost`, `unpublishPost`, `updatePost` or `deletePost`.
//   The card.             `src/components/blog/post-card.tsx` renders each post, including its
//       status pill, its category pills and its own title link. This file adds an action group
//       BESIDE the card rather than a prop TO it: neither `PostCard` nor `PostList` declares an
//       actions slot, and widening another module's contract to hold this screen's controls is the
//       coupling that layered separation exists to prevent.
//   The page links.       `src/components/ui/pagination.tsx` owns the window arithmetic and builds
//       real crawlable anchors from the current URL, so `usePagination` and `hrefForPage` are NOT
//       imported here - the envelope's own numbers are passed down instead.
//
// -------------------------------------------------------------------------------------------------
// 2. WHY THE READ IS `mine: true`, AND WHY THE GROUPING IS DONE IN THE BROWSER
//
// `GET /api/v1/posts` has two modes, and the difference is the whole reason this page can exist.
// The PUBLIC feed answers published posts only - for every caller without exception, including an
// author filtering by their own username, which `backend/app/services/post_service.py` states
// outright because it is what keeps `total` and the page boundaries identical for everybody. So
// `author: user.username` would return this author's PUBLISHED posts and nothing else, and the
// Drafts panel below would be permanently empty however many drafts existed.
//
// `mine: true` is the private author-workspace mode: the caller's own posts in every lifecycle
// state, scoped to the resolved principal by the service. It requires a credential (401 without
// one), and it cannot be combined with `author` (422) precisely because it is self-scoped. That is
// the parameter this page sends, and it is what `@/lib/api/posts` documents for this exact screen.
//
// The wrapper also accepts `status`, which narrows the workspace to ONE state. This page
// deliberately does not send it. One request returning all three states, partitioned in the
// browser, is what makes switching panels instant and refetch-free, and it is what lets ONE page
// control below the panels page ONE window - which is the honest arrangement, because the window
// really does span all three states. Sending `status` would mean three cache entries, a refetch on
// every panel change, and three separate page windows that a single control could not describe.
//
// The visible consequence, stated rather than hidden: a panel's count describes the rows on THIS
// page, not the author's whole collection. The introduction says so in as many words, because a
// number that looks like a total and is not is worse than no number at all.
//
// -------------------------------------------------------------------------------------------------
// 3. THE URL HOLDS THE WINDOW, AND COMPONENT STATE HOLDS THE PANEL
//
// `page` lives in the query string, so a window is linkable, survives a reload and stays correct
// under Back and Forward. It is parsed through `toPageNumber` from `@/lib/utils` - the same
// digits-only, lower-bounded parse the rest of the tier uses - and falls back to the first page for
// anything missing, blank, negative, fractional or simply not a number, so no request can ever
// carry `page=NaN`.
//
// `page_size` is a module constant and is deliberately NOT in the URL, matching
// `src/app/page.tsx`, which keeps the home feed's window size out of the address for the same
// reason: the public query surface stays small, and a size nobody can name is a size nobody can
// push out of the service's accepted 1..100 range.
//
// The ACTIVE PANEL is `useState`, and that is a decision rather than an oversight. The panel is not
// part of the request - it selects among rows that have already arrived - so putting it in the
// address would publish a parameter the service does not accept, add a second thing the page has to
// reconcile on navigation, and buy nothing: the rows are the same rows either way. Component state
// is also what makes the "switching panels does not refetch" property true by construction.
//
// -------------------------------------------------------------------------------------------------
// 4. DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT HERE.
//
//   1. `export const metadata` or `generateMetadata`. A `'use client'` module may export neither.
//      This route is private and `src/app/robots.ts` disallows it, so there is no metadata to want.
//   2. `import React from 'react'`. `"jsx": "react-jsx"` is set in frontend/tsconfig.json, so the
//      compiler imports the runtime itself and a default import would be an unused binding - which
//      `npm run lint` at `--max-warnings=0` turns from a warning into a failed gate.
//   3. A bare `fetch`, or any import from `@/lib/api/client` other than the error narrowing.
//      `src/lib/api/client.ts` is the tier's only HTTP module and `@/lib/api/posts` is the typed
//      wrapper over it; a request issued here would bypass credential attachment, the single
//      rotation-on-401 path and the normalised problem document.
//   4. `staleTime`, `gcTime`, `refetchOnWindowFocus` or `retry` on the query below.
//      `src/providers/query-provider.tsx` owns all four for the whole tier, including the predicate
//      that refuses to retry a 4xx. Restating one here is how the two copies drift apart.
//   5. A second `<Toaster />`. The host is mounted once in `src/app/layout.tsx`.
//   6. `PostList`. It renders `Pagination` internally and declares no actions slot, so using it
//      here would produce two page controls and no row actions.
//   7. A `status` query parameter, or one request per panel. See section 2.
//   8. A new `ui` primitive or a new design token. Every element on this screen already has one:
//      tabs, pagination, alert, badge and button as primitives, the card and its placeholder from
//      `post-card.tsx`. AAP §0.8.5's degradation ladder stops at the first step.
//   9. Any authored `role`, `aria-selected`, `aria-controls` or arrow-key handler. `@/components/ui/tabs`
//      is a wrapper over `@radix-ui/react-tabs`, which supplies the roles, the selection state and
//      the roving-focus model; `@/components/ui/alert` derives its own live-region role from its
//      variant. Adding either by hand would duplicate and risk contradicting them.
//  10. `process.env`, in any form, including a `NEXT_PUBLIC_` key. The public post address comes
//      from `@/lib/seo`, which is the tier's only reader of the site keys.
//  11. A literal colour, dimension, radius, shadow or font size, a Tailwind colour family/shade, a
//      `dark:` variant or an `@media` query. Every value below resolves to a semantic token or a
//      `--spacing`/`--container-*` multiple through a generated utility, the tokens are dual-valued
//      in `src/app/globals.css` so the screen re-themes with no conditional here, and the only
//      breakpoint used is the catalogued `md`.
//  12. Anything from the retired `/items` surface. There is no `Item` type, no `id`/`name`/`price`
//      triple and no `/items` path anywhere in this file. A post's `id` IS used - it is the
//      server-generated UUID every mutation route and the editor address are keyed on.

import { useEffect, useMemo, useState, type ComponentProps, type JSX } from 'react';

import { useQuery } from '@tanstack/react-query';
import { Eye, Pencil, SquarePen, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import { PostCard, PostCardSkeleton } from '@/components/blog/post-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge, POST_STATUS_BADGE_VARIANTS } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/use-auth';
import { isApiError } from '@/lib/api/client';
import { listPosts } from '@/lib/api/posts';
import { formatCount, formatDate, formatMachineDate } from '@/lib/format';
import { NEW_POST_ROUTE, postEditRoute } from '@/lib/routes';
import { DEFAULT_FEED_SORT, postPath } from '@/lib/seo';
import { POST_STATUSES } from '@/lib/types';
import type { Page, PostStatus, PostSummary } from '@/lib/types';
import { cn, FIRST_PAGE, toPageNumber } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Request shape
 * ---------------------------------------------------------------------------------------------- */

/**
 * How many posts one workspace page holds.
 *
 * Fifty, which is the value `@/lib/api/posts` itself uses in the author-workspace example on
 * `listPosts`, and it is a correctness requirement rather than a comfort setting. THE WORKSPACE
 * LISTING ORDERS BY `published_at DESC NULLS LAST`, so an unpublished post sorts BEHIND every
 * published one - and an unpublished post is exactly what this screen exists to surface.
 *
 * Measured against the seeded corpus, which is what settled the number: an author with 28 published
 * posts, one draft and one archived post read at ten rows a page puts the draft and the archived post
 * on page THREE, so the Drafts panel is empty on arrival and a post the author has only just written
 * is three clicks away from the screen built to show it. At fifty the same collection arrives in one
 * page - `pages` is 1, every panel is complete, and each count is a true total rather than a
 * page-local one.
 *
 * Fifty is comfortable to send and cheap to render: {@link PostSummary} carries no body content by
 * design, so a workspace page is titles, excerpts and metadata rather than fifty articles. It is
 * inside the service's accepted 1..100 range, which is *validated* rather than clamped - a value
 * outside it is a 422, not a trim - and the page control below still handles the author who has more.
 *
 * Module-local and deliberately absent from the URL, exactly as `src/app/page.tsx` keeps the home
 * feed's window size out of the address. See section 3 of the module header.
 */
const WORKSPACE_PAGE_SIZE = 50;

/** The search parameter the window is read from. The only URL state this page reads or writes. */
const PAGE_PARAM = 'page';

/**
 * How many placeholder cards stand in for the list while the first read is on the wire.
 *
 * Three is enough to hold the fold without pretending to know how many posts will arrive - and the
 * placeholders are `PostCardSkeleton`, so they occupy the geometry of the real card rather than an
 * approximation of it that would shift the layout on arrival.
 */
const IN_FLIGHT_CARD_COUNT = 3;

/** Key prefix for the placeholder cards, which have no identity of their own to key on. */
const IN_FLIGHT_CARD_KEY_PREFIX = 'workspace-placeholder-';

/* -------------------------------------------------------------------------------------------------
 * Cache identity
 * ---------------------------------------------------------------------------------------------- */

/**
 * Cache scope for this screen's read.
 *
 * Distinct from any public feed entry on purpose: the same page number requested publicly and
 * privately answers different rows, so the two must never collide in one cache slot.
 */
const WORKSPACE_QUERY_SCOPE = 'workspace-posts';

/**
 * The cache key shape: the scope, whose posts, and which window.
 *
 * The account is part of the key because the answer is scoped to the credential the request
 * carried. Without it, signing out and signing in as somebody else would show the previous
 * author's rows from cache until the entry went stale.
 *
 * The account member is `undefined` for exactly as long as the session is unresolved, during which
 * the query is disabled and therefore never fetches under this key. It is not a sentinel standing
 * for a real account.
 */
type WorkspaceQueryKey = readonly [typeof WORKSPACE_QUERY_SCOPE, string | undefined, number];

/**
 * Build the cache key for one author's window.
 *
 * @param account - The signed-in account's username, or `undefined` while the session is unresolved.
 * @param page - The 1-based window being read.
 */
function workspacePostsQueryKey(account: string | undefined, page: number): WorkspaceQueryKey {
  return [WORKSPACE_QUERY_SCOPE, account, page];
}

/* -------------------------------------------------------------------------------------------------
 * Lifecycle panels
 * ---------------------------------------------------------------------------------------------- */

/**
 * The panels, in the order they are offered.
 *
 * Taken from the contract module's own tuple rather than re-listed here, which buys three things.
 * The three wire literals appear nowhere in this file, so none of them can be mistyped into a panel
 * that silently never matches a row. The order is the service's declared lifecycle order - draft,
 * published, archived - which is also the order an author wants: the posts needing attention first.
 * And should the service's `post_status` type ever gain a member, this list grows with it while
 * every `Record<PostStatus, …>` below becomes a compile error until it is given a label, which is
 * the failure mode worth having.
 *
 * Left unannotated deliberately: `POST_STATUSES` is a readonly tuple, so indexing it at a literal
 * position yields an exact member rather than `PostStatus | undefined` under
 * `noUncheckedIndexedAccess`. Annotating it as `readonly PostStatus[]` would discard that.
 */
const STATUS_TAB_ORDER = POST_STATUSES;

/** The panel a visit opens on: the first in lifecycle order, which is where unfinished work is. */
const DEFAULT_STATUS_TAB = STATUS_TAB_ORDER[0];

/**
 * The one state that has a public address.
 *
 * A draft and an archived post are readable only by their author or an administrator, and a Server
 * Component fetches without a credential, so `/blog/{slug}` answers 404 for either - offering the
 * link would be offering a broken one. Declared as a named, `PostStatus`-typed constant so the
 * comparison below is checked against the union rather than spelled as a bare string, which is the
 * same shape `post-card.tsx` uses for its own status comparison.
 */
const PUBLIC_STATUS: PostStatus = 'PUBLISHED';

/** Visible panel labels, plural because each names a collection rather than one post's state. */
const STATUS_TAB_LABELS: Readonly<Record<PostStatus, string>> = {
  DRAFT: 'Drafts',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
};

/** What one panel says when it has nothing on this page. */
interface WorkspaceEmptyState {
  /** Headline. Says "on this page" wherever that is the honest reading - see section 2. */
  readonly title: string;
  /** What the state means and what to do about it. */
  readonly description: string;
  /**
   * Whether this panel offers the editor.
   *
   * Carried as data rather than decided by comparing the status at the render site, so the one
   * panel where "there is nothing here" is genuinely an invitation to write - drafts - is declared
   * beside its copy. Offering it from an empty Archived panel would be a non-sequitur.
   */
  readonly offersAuthoring: boolean;
}

/**
 * The empty copy for each panel, exhaustive over the union.
 *
 * Each string is written for the state it describes rather than shared: "nothing published yet" and
 * "nothing archived" call for different next steps, and a single generic line would be true of both
 * and useful for neither.
 */
const STATUS_EMPTY_STATES: Readonly<Record<PostStatus, WorkspaceEmptyState>> = {
  DRAFT: {
    title: 'No drafts on this page',
    description:
      'A new post starts life as a draft, visible only to you until you publish it. Start one and ' +
      'it will appear here.',
    offersAuthoring: true,
  },
  PUBLISHED: {
    title: 'Nothing published on this page',
    description:
      'Publishing a draft puts it on the blog, gives it a permanent address and lists it in the ' +
      'feed. Open a draft and publish it from the editor.',
    offersAuthoring: false,
  },
  ARCHIVED: {
    title: 'Nothing archived on this page',
    description:
      'Archiving withdraws a published post from the blog without deleting it, so it stays here ' +
      'and can be published again later.',
    offersAuthoring: false,
  },
};

/* -------------------------------------------------------------------------------------------------
 * Copy
 *
 * Every visible string is named here rather than inlined, so the screen reads as one voice and a
 * component test can assert on the same constant the page renders.
 * ---------------------------------------------------------------------------------------------- */

/** The document's single `<h1>` for this route. Matches the layout's own navigation label. */
const WORKSPACE_HEADING = 'Your posts';

/** The line under the heading. */
const WORKSPACE_INTRO =
  'Everything you have written, grouped by where it sits in the publishing lifecycle.';

/**
 * Appended to the introduction only when the collection does not fit in one window.
 *
 * A panel count describes the rows the page is holding, because one request returns all three states
 * and the page control windows that one envelope. On a single page the count therefore IS the total
 * and this caveat would be misleading noise; past one page it is the difference between an honest
 * number and a number that looks like a total and is not. So it is said exactly when it applies.
 */
const WORKSPACE_WINDOW_NOTE = 'Each count describes the posts on this page.';

/** Accessible name of the panel switcher, so a landmark or rotor list can tell what it selects. */
const PANEL_LIST_LABEL = 'Lifecycle state';

/** Label of the authoring entry point, matching the workspace rail's own wording. */
const NEW_POST_LABEL = 'New post';

/** Row action leading to the editor for that post. */
const EDIT_LABEL = 'Edit';

/** Row action leading to the post's public page. Rendered only where that page exists. */
const VIEW_LABEL = 'View';

/** Prefix of the row's date line. "Started", because the instant shown is the creation one. */
const CREATED_PREFIX = 'Started';

/** Announced while the first read is on the wire, since the placeholders themselves are hidden. */
const IN_FLIGHT_LABEL = 'Loading your posts';

/** Headline of the failure panel, and of the toast that accompanies it. */
const LOAD_FAILURE_TITLE = 'Your posts could not be loaded';

/**
 * Fallback explanation when the failure carried no usable message of its own.
 *
 * Written to be true of every failure that reaches it - a refused request, a service that could not
 * be reached, a deadline that fired - and to say the one thing an author most needs to hear, which
 * is that nothing they wrote has been lost.
 */
const LOAD_FAILURE_DETAIL =
  'Nothing you have written has been lost. This is usually a brief network or service problem, and ' +
  'reloading the page is normally all it takes.';

/* -------------------------------------------------------------------------------------------------
 * Presentation
 *
 * Utility strings only, and every value in them resolves to a token: the semantic colours declared
 * in src/app/globals.css, `--spacing` multiples for rhythm and sizing, `--container-*` for a
 * readable measure, and `--radius-*` through the engine's own `rounded-*` scale. No literal colour,
 * dimension, radius, shadow or font size appears anywhere in this file, and the only breakpoint is
 * the catalogued `md` (48rem) - the hinge the rest of the tier uses.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The page's own root.
 *
 * Contributes vertical rhythm and nothing else: the layout owns the workspace's max width, gutters
 * and rail, so restating a container here would produce two nested measures. `min-w-0` is what lets
 * a long post title inside a card shrink instead of pushing the flex column - and therefore the
 * document - wider than the viewport.
 */
const PAGE_CLASSES = 'flex min-w-0 flex-col gap-6';

/** Heading block and authoring entry point: stacked on a phone, shoulder to shoulder from `md`. */
const HEADER_CLASSES = 'flex flex-col gap-4 md:flex-row md:items-end md:justify-between';

/** The heading and its supporting line. `min-w-0` again, so the intro wraps rather than pushes. */
const HEADER_TEXT_CLASSES = 'flex min-w-0 flex-col gap-1';

/** The `<h1>`. */
const HEADING_CLASSES = 'text-foreground text-2xl font-semibold tracking-tight';

/** The supporting line, held to a readable measure by a `--container-*` step. */
const INTRO_CLASSES = 'text-muted-foreground max-w-2xl text-sm';

/** The count pill inside a panel trigger. Fixed-width digits so the triggers stop shifting. */
const TAB_COUNT_CLASSES = 'tabular-nums';

/**
 * The management stack: one row per post, one column at every width.
 *
 * Deliberately NOT the feed's one/two/three-column grid. A management list is read top to bottom,
 * each row pairing a post with the controls that act on it, and a grid would put those controls in
 * three places on one screen.
 */
const ROW_LIST_CLASSES = 'flex min-w-0 flex-col gap-4';

/** One row: card above its actions on a phone, card beside them from `md`. */
const ROW_CLASSES = 'flex min-w-0 flex-col gap-3 md:flex-row md:items-start md:gap-4';

/** The card's share of the row. `flex-1` with `min-w-0` is what makes a long title wrap. */
const ROW_CARD_CLASSES = 'min-w-0 flex-1';

/** The action group: full width under the card, then a fixed rail beside it from `md`. */
const ROW_ACTIONS_CLASSES = 'flex min-w-0 shrink-0 flex-col gap-2 md:w-44';

/** The controls themselves: a wrapping row on a phone, a stacked column from `md`. */
const ROW_ACTION_ROW_CLASSES = 'flex min-w-0 flex-wrap gap-2 md:flex-col';

/** Each control shares the row's width on a phone and takes the rail's width from `md`. */
const ROW_ACTION_CLASSES = 'grow md:grow-0';

/** The row's date line. */
const ROW_META_CLASSES = 'text-muted-foreground text-xs';

/** An empty panel: the primitive's `empty` variant already centres its own content. */
const EMPTY_PANEL_CLASSES = 'gap-2';

/** The same panel when it also offers the editor, which needs room to read as an action. */
const EMPTY_PANEL_WITH_ACTION_CLASSES = 'gap-4';

/**
 * Placeholder for the panel switcher.
 *
 * `h-11` is the trigger row's own height, from the button primitive's `default` size, so the real
 * switcher lands exactly where this block stood. Constrained by a `--container-*` step rather than
 * a measured width, because three labels and three counts are what set the real width.
 */
const IN_FLIGHT_TABS_CLASSES = 'h-11 w-full max-w-sm rounded-lg';

/** Spacing between the panels and the page control. */
const PAGINATION_CLASSES = 'mbs-2';

/** Accessible name of the page control, so it is distinguishable in a landmark list. */
const PAGINATION_LABEL = 'Your posts pagination';

/**
 * Heading level of each card's title.
 *
 * `2` because this page's `<h1>` is the only heading above it: the layout emits none, and no panel
 * renders a heading of its own, so the outline is one `<h1>` followed by one `<h2>` per post with no
 * level skipped. The panels themselves are named by their triggers, which is how a tab set is
 * labelled - a visible heading per panel would only repeat the trigger's text.
 */
const CARD_HEADING_LEVEL = 2;

/* -------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Turn a caught value into one sentence that is safe to show an author.
 *
 * The service renders one problem document for every failure path and writes `detail` to be read by
 * a person, so a well-behaved rejection needs no interpretation - only unwrapping. `title` is the
 * fallback for the rare document whose `detail` is blank, and `Error.message` covers a failure the
 * service never described at all: a connection that never opened, a deadline that fired first.
 *
 * What it never returns is the document itself, a status code, a stack or a correlation identifier.
 * Those belong in a log, not in front of an author, and no credential appears on an `ApiError` in
 * any field by construction.
 *
 * @param error - The rejection, as React Query surfaced it.
 * @returns One sentence, or `undefined` when nothing usable was carried - in which case the caller
 * substitutes {@link LOAD_FAILURE_DETAIL} rather than showing an empty line.
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
 * Narrow the string Radix hands back from a panel change to the contract's own union.
 *
 * A real membership test against {@link STATUS_TAB_ORDER} rather than a cast: the value arrives as a
 * `string` because that is what the primitive's API promises, and asserting it into the union would
 * make an unexpected value type-check its way into state where every `Record<PostStatus, …>` lookup
 * below would then miss. `some` with an equality test is used in preference to `includes`, which
 * would refuse a `string` argument against a readonly tuple of literals.
 *
 * @param value - The value the switcher reported.
 * @returns Whether it names a lifecycle state this page renders a panel for.
 */
function isPostStatus(value: string): value is PostStatus {
  return STATUS_TAB_ORDER.some((status) => status === value);
}

/**
 * Split one window of posts into one bucket per lifecycle state.
 *
 * This is the whole of the grouping, and it happens here rather than server-side for the reason
 * section 2 of the module header gives: one request answers every state, so the browser already
 * holds everything the three panels need and switching between them costs nothing.
 *
 * The initialiser names all three states explicitly, which is the point - `Record<PostStatus, …>`
 * makes a missing state a compile error, so a state added to the contract cannot silently lose its
 * rows. Indexing with `post.status` needs no fallback for the same reason: the key is the union, and
 * the record is total over it.
 *
 * @param posts - The window's rows, in the order the service returned them - newest first, which is
 * the order each bucket preserves.
 * @returns One readonly bucket per state. Every bucket is present; an empty one is an empty array,
 * never `undefined`, so a panel never has to test for absence.
 */
function partitionByStatus(
  posts: readonly PostSummary[],
): Readonly<Record<PostStatus, readonly PostSummary[]>> {
  const grouped: Record<PostStatus, PostSummary[]> = {
    DRAFT: [],
    PUBLISHED: [],
    ARCHIVED: [],
  };

  for (const post of posts) {
    grouped[post.status].push(post);
  }

  return grouped;
}

/**
 * The window's rows before the first read resolves.
 *
 * A frozen module constant rather than a fresh `[]` at the call site, so the memo below keeps one
 * stable dependency identity while the query is pending and does not re-partition on every render.
 */
const NO_POSTS: readonly PostSummary[] = Object.freeze([]);

/* -------------------------------------------------------------------------------------------------
 * Module-local components
 *
 * Declared here rather than in `src/components/**` because none of them is reusable: each is a piece
 * of this one screen's composition, and this folder holds exactly one file by design.
 * ---------------------------------------------------------------------------------------------- */

/** Props of {@link NewPostButton}. */
interface NewPostButtonProps {
  /**
   * Which button variant to render.
   *
   * Typed from the primitive's own prop rather than re-declaring its union, so the two cannot drift:
   * the heading uses the emphatic variant, the empty Drafts panel a quieter one, and both are the
   * same control leading to the same address.
   */
  readonly variant: ComponentProps<typeof Button>['variant'];
}

/**
 * The entry point to authoring: a link to the empty editor, rendered as a button.
 *
 * `asChild` composes `@radix-ui/react-slot`, so the primitive's classes land on a real anchor - the
 * control is a navigation, and a navigation must be an anchor a reader can open in a new tab, copy
 * or middle-click. The address comes from `@/lib/routes`, never from a literal: the `(dashboard)`
 * group's name is erased from the URL, so the editor is at `/posts/new` and NOT
 * `/dashboard/posts/new`, and that module is where the distinction is recorded once.
 *
 * The glyph is decorative and hidden from assistive technology, because the visible text beside it
 * already carries the meaning and is the control's accessible name.
 */
function NewPostButton({ variant }: NewPostButtonProps): JSX.Element {
  return (
    <Button asChild variant={variant}>
      <Link href={NEW_POST_ROUTE}>
        <SquarePen aria-hidden="true" />
        {NEW_POST_LABEL}
      </Link>
    </Button>
  );
}

/** Props of {@link WorkspaceRowActions}. */
interface WorkspaceRowActionsProps {
  /** The post this group acts on. Read for its identifier, its slug, its title and its state. */
  readonly post: PostSummary;
}

/**
 * The controls beside one card. Every one of them is a navigation.
 *
 * There is no publish, unpublish, archive or delete control here, and their absence is deliberate:
 * `src/components/blog/post-editor.tsx` is the single owner of every lifecycle transition, reached
 * through the Edit link below. A second call site for those routes would mean two places where the
 * publish rule lives, and the first divergence between them would be invisible until an author hit
 * it.
 *
 * ### Why an explicit Edit control, when the card's title is already a link
 *
 * `PostCard` links its own title to `/blog/{slug}` unconditionally - a *public view* link, and the
 * right one for the feed it was built for. Suppressing or repointing it would mean widening its
 * contract, so the row carries a visibly labelled Edit control of its own instead. Two links with
 * two destinations, each saying which it is.
 *
 * ### Why View is conditional
 *
 * A draft and an archived post have no public page: the service answers 404 to any caller who is not
 * their author, and a Server Component renders `/blog/{slug}` without a credential. So the link is
 * offered only where it resolves, compared against {@link PUBLIC_STATUS} rather than a bare literal.
 * Hiding it is a courtesy to the author, not a security measure - confidentiality is the service's,
 * enforced on every request.
 *
 * Each control's visible text is short and its accessible name carries the post's title, so ten rows
 * do not present ten identically named links to a screen reader. The visible label is the first word
 * of the accessible name, which is what keeps a voice-control user's "click Edit" working.
 */
function WorkspaceRowActions({ post }: WorkspaceRowActionsProps): JSX.Element {
  // Both derived through the total helpers in `@/lib/format`, which answer the empty string rather
  // than throwing or rendering "Invalid Date" for an absent or unparseable instant. Guarding on the
  // machine value is the documented pattern and is what keeps `<time dateTime="">` - an invalid
  // element - off the page. `created_at` is always present; `published_at` is the nullable one, and
  // it is the card's byline that renders it.
  const createdMachine = formatMachineDate(post.created_at);
  const createdHuman = formatDate(post.created_at);

  return (
    <div className={ROW_ACTIONS_CLASSES}>
      <div className={ROW_ACTION_ROW_CLASSES}>
        <Button asChild className={ROW_ACTION_CLASSES} variant="secondary">
          <Link href={postEditRoute(post.id)}>
            <Pencil aria-hidden="true" />
            {EDIT_LABEL}
            <span className="sr-only">{`: ${post.title}`}</span>
          </Link>
        </Button>

        {post.status === PUBLIC_STATUS ? (
          <Button asChild className={ROW_ACTION_CLASSES} variant="ghost">
            <Link href={postPath(post.slug)}>
              <Eye aria-hidden="true" />
              {VIEW_LABEL}
              <span className="sr-only">{`: ${post.title}`}</span>
            </Link>
          </Button>
        ) : null}
      </div>

      {createdMachine.length > 0 ? (
        <p className={ROW_META_CLASSES}>
          {`${CREATED_PREFIX} `}
          <time dateTime={createdMachine}>{createdHuman}</time>
        </p>
      ) : null}
    </div>
  );
}

/** Props of {@link WorkspacePanel}. */
interface WorkspacePanelProps {
  /** The rows in this state, already partitioned. Empty is an ordinary state, not an error. */
  readonly posts: readonly PostSummary[];
  /** Which state this panel shows, used to select its empty copy. */
  readonly status: PostStatus;
}

/**
 * One lifecycle panel: either its rows, or why it has none.
 *
 * The rows are a real `<ul>`, because that is what a list of posts is; the card inside each item is
 * an `<article>` of its own, which the primitive supplies. `post.id` is the key - a server-generated
 * UUID, stable across reordering and repaging, which an array index is not.
 *
 * The empty state is the alert primitive's `empty` variant, which carries no live-region role by
 * design: an empty panel that announced itself would interrupt a reader for something that is merely
 * true. No `role` is authored here in either direction.
 */
function WorkspacePanel({ posts, status }: WorkspacePanelProps): JSX.Element {
  if (posts.length === 0) {
    const empty = STATUS_EMPTY_STATES[status];

    return (
      <Alert
        className={cn(
          EMPTY_PANEL_CLASSES,
          // Resolved by `cn`, so the wider gap replaces the narrower one rather than joining a
          // losing race with it.
          empty.offersAuthoring && EMPTY_PANEL_WITH_ACTION_CLASSES,
        )}
        variant="empty"
      >
        <AlertTitle>{empty.title}</AlertTitle>
        <AlertDescription>{empty.description}</AlertDescription>
        {empty.offersAuthoring ? <NewPostButton variant="secondary" /> : null}
      </Alert>
    );
  }

  return (
    <ul className={ROW_LIST_CLASSES}>
      {posts.map((post) => (
        <li className={ROW_CLASSES} key={post.id}>
          <PostCard className={ROW_CARD_CLASSES} headingLevel={CARD_HEADING_LEVEL} post={post} />
          <WorkspaceRowActions post={post} />
        </li>
      ))}
    </ul>
  );
}

/** Props of {@link WorkspaceHeader}. */
interface WorkspaceHeaderProps {
  /**
   * Whether the collection spans more than one page, in which case the counts are page-local and
   * {@link WORKSPACE_WINDOW_NOTE} says so.
   *
   * `false` in every state that shows no counts at all - in flight and failed - because a caveat
   * about numbers that are not on screen explains nothing.
   */
  readonly isWindowed: boolean;
}

/**
 * The heading block, rendered in every state of the page.
 *
 * Extracted so the in-flight, failure and loaded states cannot drift into three different headings -
 * and so the `<h1>` is emitted exactly once from exactly one place, whichever state the page is in.
 */
function WorkspaceHeader({ isWindowed }: WorkspaceHeaderProps): JSX.Element {
  return (
    <div className={HEADER_CLASSES}>
      <div className={HEADER_TEXT_CLASSES}>
        <h1 className={HEADING_CLASSES}>{WORKSPACE_HEADING}</h1>
        <p className={INTRO_CLASSES}>
          {isWindowed ? `${WORKSPACE_INTRO} ${WORKSPACE_WINDOW_NOTE}` : WORKSPACE_INTRO}
        </p>
      </div>

      <NewPostButton variant="primary" />
    </div>
  );
}

/* -------------------------------------------------------------------------------------------------
 * The route
 * ---------------------------------------------------------------------------------------------- */

/**
 * The author workspace at `/dashboard`.
 *
 * Reads the signed-in account, reads one window of that account's own posts in every lifecycle
 * state, and renders three panels over it with a navigation group beside each row.
 *
 * ### The three states it renders
 *
 * 1. **In flight** - the session is not resolved yet, or the first read is on the wire. The heading
 *    stands where it will stand, with a placeholder switcher and placeholder cards beneath it, so
 *    nothing moves when the rows arrive.
 * 2. **Failed** - the read was refused or could not be made. A destructive panel explains it in
 *    place, and a toast says the same thing once. Neither shows a status code, a stack or the
 *    problem document itself.
 * 3. **Loaded** - the three panels, their counts, and the page control beneath them.
 *
 * The states the layout owns are absent by design: no placeholder for the session itself, no
 * signed-out panel, no redirect. `src/app/(dashboard)/layout.tsx` renders all three and only renders
 * this page once a principal exists. This component is still null-safe about `user` - through
 * optional access and a query that stays disabled until an account is known, never through a
 * non-null assertion, which would type-check the very case it fails to handle.
 *
 * @returns The workspace for whichever of the three states applies.
 */
export default function DashboardPage(): JSX.Element {
  // Throws only when `AuthProvider` is missing - a wiring defect, and deliberately loud. A `null`
  // user inside a live provider is an ordinary state, and the one the optional access below is for.
  const { user } = useAuth();

  // The window, straight from the address, so a result is linkable and survives a reload. The parse
  // is the tier's own: digits only, at least one, and bounded, so a missing, blank, fractional,
  // negative or non-numeric value falls back to the first page instead of putting `NaN` in a request.
  const searchParams = useSearchParams();
  const page = toPageNumber(searchParams.get(PAGE_PARAM)) ?? FIRST_PAGE;

  // The active panel is view state over rows that have already arrived, so it lives here and not in
  // the address - see section 3 of the module header. Controlled, so what this component holds is
  // exactly what the switcher renders.
  const [activeStatus, setActiveStatus] = useState<PostStatus>(DEFAULT_STATUS_TAB);

  // `undefined` for exactly as long as the session is unresolved. It is the cache key's account
  // member and the query's gate, which is what stops a request going out with no scope at all.
  const account = user?.username;

  const {
    data: workspacePage,
    error,
    isPending,
  } = useQuery({
    // No request until there is an account to scope it to: `mine` with no credential is a 401, not a
    // quiet fall back to the public feed.
    enabled: account !== undefined,
    queryFn: ({ signal }): Promise<Page<PostSummary>> =>
      listPosts(
        {
          // The private author-workspace mode: this account's own posts in EVERY lifecycle state.
          // The public feed is published-only for every caller, so `author` here would answer only
          // published posts and leave the Drafts panel permanently empty. See section 2.
          mine: true,
          page,
          page_size: WORKSPACE_PAGE_SIZE,
          // Newest first. Stated rather than left to the service's default so the ordering does not
          // change meaning if a search term is ever added to this screen; relevance ranking without
          // a term is meaningless, and this screen has no search control.
          sort: DEFAULT_FEED_SORT,
        },
        // Forwarded so a workspace left mid-read cancels rather than resolving into a cache nobody
        // is looking at.
        { signal },
      ),
    queryKey: workspacePostsQueryKey(account, page),
    // The ONE option this call site sets beyond the key and the function, and it is not a
    // restatement of a tier default: `@/providers/query-provider` leaves `refetchOnMount` unset, and
    // owns `staleTime`, `gcTime`, `refetchOnWindowFocus` and the retry predicate, none of which is
    // repeated here.
    //
    // It is set because of where an author arrives from. The editor publishes, unpublishes and
    // deletes, then returns here with `router.replace` - which refreshes Server Components and
    // leaves this client cache untouched. Inside the tier's stale window that would show an author
    // the post they just published still sitting in Drafts, which reads as a failed publish. This
    // renders the cached rows immediately, exactly as before, and corrects them in the background.
    refetchOnMount: 'always',
  });

  // Read before the early returns below, because a hook cannot be called conditionally. `NO_POSTS`
  // is a stable identity, so a pending render does not re-partition on every pass.
  const rows = workspacePage?.items;
  const postsByStatus = useMemo(() => partitionByStatus(rows ?? NO_POSTS), [rows]);

  // The toast half of the failure report. Keyed on the error's identity, so one failure is announced
  // once rather than on every re-render, and a recovery announces nothing at all. The inline panel
  // below is the part that persists; this is the part that interrupts.
  useEffect(() => {
    if (error === null) {
      return;
    }

    toast.error(LOAD_FAILURE_TITLE, {
      description: describeFailure(error) ?? LOAD_FAILURE_DETAIL,
    });
  }, [error]);

  /* -----------------------------------------------------------------------------------------------
   * 2. Failed. Checked before the pending state, because React Query reports a retrying read as
   *    pending too, and a settled failure must not be redrawn as a placeholder.
   * -------------------------------------------------------------------------------------------- */

  if (error !== null) {
    return (
      <div className={PAGE_CLASSES}>
        {/* No caveat about page-local counts in a state that shows no counts. */}
        <WorkspaceHeader isWindowed={false} />

        {/* `destructive` is the one variant the primitive gives `role="alert"`, which is correct
            here: this replaces content the author asked for. The glyph is the primitive's leading
            slot and is hidden, since the title says the same thing. */}
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{LOAD_FAILURE_TITLE}</AlertTitle>
          <AlertDescription>{describeFailure(error) ?? LOAD_FAILURE_DETAIL}</AlertDescription>
        </Alert>
      </div>
    );
  }

  /* -----------------------------------------------------------------------------------------------
   * 1. In flight. Also the state while the session is resolving, because the query is disabled
   *    until an account exists and a disabled query reports itself as pending - which is exactly
   *    the right thing to show for it.
   * -------------------------------------------------------------------------------------------- */

  if (isPending || workspacePage === undefined) {
    return (
      <div className={PAGE_CLASSES}>
        <WorkspaceHeader isWindowed={false} />

        <Skeleton className={IN_FLIGHT_TABS_CLASSES} />

        {/* Not a `<ul>`: these are placeholders, and announcing "list, 3 items" for content that is
            hidden from assistive technology would describe furniture rather than posts. The cards
            carry their own `aria-hidden`, so the sentence below is what a screen reader is left
            with. */}
        <div className={ROW_LIST_CLASSES}>
          <p className="sr-only">{IN_FLIGHT_LABEL}</p>

          {Array.from({ length: IN_FLIGHT_CARD_COUNT }, (_, index) => (
            <PostCardSkeleton key={`${IN_FLIGHT_CARD_KEY_PREFIX}${index}`} />
          ))}
        </div>
      </div>
    );
  }

  /* -----------------------------------------------------------------------------------------------
   * 3. Loaded.
   * -------------------------------------------------------------------------------------------- */

  return (
    <div className={PAGE_CLASSES}>
      {/* The counts below describe the whole collection when it fits in one window, and only the
          current page when it does not - which is the one case the caveat is added for. */}
      <WorkspaceHeader isWindowed={workspacePage.pages > FIRST_PAGE} />

      {/* Radix supplies the tablist and tab roles, the selected state, the panel association and
          the roving-focus keyboard model. Nothing here authors any of them; the only ARIA written at
          this call site is the switcher's own name. */}
      <Tabs
        onValueChange={(value: string): void => {
          // Narrowed by a real membership test, never asserted - see `isPostStatus`. A value that
          // does not name a panel is ignored, which leaves the current selection standing rather
          // than blanking the screen.
          if (isPostStatus(value)) {
            setActiveStatus(value);
          }
        }}
        value={activeStatus}
      >
        <TabsList aria-label={PANEL_LIST_LABEL}>
          {STATUS_TAB_ORDER.map((status) => (
            <TabsTrigger key={status} value={status}>
              {STATUS_TAB_LABELS[status]}

              {/* The one non-duplicative use of a badge on this screen. The card already carries the
                  post's own status pill, so a second one beside it would say the same thing twice;
                  a count inside the trigger says something the card cannot. The variant comes from
                  the contract's own status-to-variant map, so the colour of a count matches the
                  colour of the pills it counts. */}
              <Badge className={TAB_COUNT_CLASSES} variant={POST_STATUS_BADGE_VARIANTS[status]}>
                {formatCount(postsByStatus[status].length)}
              </Badge>
            </TabsTrigger>
          ))}
        </TabsList>

        {STATUS_TAB_ORDER.map((status) => (
          <TabsContent key={status} value={status}>
            <WorkspacePanel posts={postsByStatus[status]} status={status} />
          </TabsContent>
        ))}
      </Tabs>

      {/* Beneath the panels rather than inside one, because the window it pages spans all three
          states - it is one envelope, and the panels are a view of it. Driven by the envelope's own
          `page` and `pages`, in the service's snake_case, with nothing recomputed. `hrefForPage` is
          not supplied: the primitive builds crawlable anchors from the current URL, preserving the
          rest of the query string and dropping `page` for the first page. It also renders nothing at
          all for a single page, so the guard here is what keeps the intent legible at the call site
          rather than what makes it true.

          An out-of-range `?page=` needs nothing special: the service echoes the requested page back
          beside the real totals and an empty list, so every panel renders its empty state and this
          control still offers the way back. */}
      {workspacePage.pages > FIRST_PAGE ? (
        <Pagination
          ariaLabel={PAGINATION_LABEL}
          className={PAGINATION_CLASSES}
          page={workspacePage.page}
          page_size={workspacePage.page_size}
          pages={workspacePage.pages}
          total={workspacePage.total}
        />
      ) : null}
    </div>
  );
}
