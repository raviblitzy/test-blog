'use client';

/* =================================================================================================
 * `/posts/{id}/edit` - the post editor, bound to an existing post.
 *
 * The EDIT half of requirement R2, "create, edit, delete, and publish blog posts". Its sibling
 * `(dashboard)/posts/new/page.tsx` carries the create half, and both mount the same
 * `@/components/blog/post-editor`, which is where every rule about authoring actually lives. The two
 * pages are deliberately near-identical except for one thing, and that one thing is the whole reason
 * this file is longer than its sibling: **this route is keyed on an identifier, and the API's only
 * full read is keyed on a slug.** Everything below section 2 exists to bridge that.
 *
 * -------------------------------------------------------------------------------------------------
 * 1. THE URL IS `/posts/{id}/edit`, NOT `/dashboard/posts/{id}/edit`
 *
 * `(dashboard)` is parenthesised, so Next.js ERASES it from the URL, and `posts` is a SIBLING of
 * `dashboard` inside the group rather than a child of it. Four files already in the tree agree,
 * independently of one another and of this comment:
 *
 *   - `src/middleware.ts` gates '/dashboard/:path*' and '/posts/:path*' as two SEPARATE matcher
 *     entries - it would need only one if the group nested;
 *   - `src/app/robots.ts` keeps '/dashboard', '/posts' and '/admin' out of every index while leaving
 *     '/blog/*' crawlable;
 *   - `src/app/(dashboard)/layout.tsx` links the literal '/dashboard' and '/posts/new';
 *   - `src/lib/routes.ts` composes this very address as `/posts/{id}/edit` and its `postEditRoute`
 *     hint says "Use the `id` of the post as the API reported it, never its slug".
 *
 * That last point fixes the contract on BOTH sides: the upstream linker passes an identifier, so this
 * page must resolve an identifier. AAP §0.7.3.1 writes `/dashboard/posts/[id]/edit`, but that is
 * filesystem shorthand for the directory, not the rendered URL.
 *
 * The two URL families are never crossed. `/posts/*` is the protected AUTHORING family; `/blog/{slug}`
 * is the public POST-DETAIL family. Nothing here builds a `/posts/*` address for a reader, and nothing
 * here points an authoring action at a `/blog` address.
 *
 * -------------------------------------------------------------------------------------------------
 * 2. THE LOAD-BEARING PROBLEM: AN ID-KEYED ROUTE OVER A SLUG-KEYED READ
 *
 * `src/lib/api/posts.ts` splits the two keys apart on purpose, and its own header calls the split
 * "the one thing in this file that is easy to get wrong":
 *
 *     READ   by SLUG  ->  getPost(slug)                        returns PostDetail
 *     MUTATE by ID    ->  updatePost / deletePost / publishPost / unpublishPost
 *
 * There is **no id-keyed read anywhere in the thirty-endpoint API**. The slug is the canonical,
 * stable, crawler-facing key, derived once at creation and deliberately never re-derived; the
 * identifier is the internal UUID every mutation addresses. Both are `string`, so confusing them is
 * not a type error - it is a `404` some distance from its cause.
 *
 * `PostEditor` in edit mode requires a full `PostDetail` - summary fields PLUS `content` and
 * `updated_at` - and `getPost(slug)` is the only thing that returns one. So arriving with an
 * identifier and needing a detail cannot be done in one call, and this page does it in two:
 *
 *   Step A  id -> slug.  Walk the signed-in author's own workspace listing and find the summary whose
 *           `id` matches the route. `PostSummary` carries BOTH `id` and `slug`, which is what makes
 *           the walk sufficient; it deliberately carries no `content`, which is what makes step B
 *           necessary. See {@link resolveSlugForId}.
 *   Step B  slug -> detail.  `getPost(slug)`. A draft is readable there by its author or an
 *           administrator, so this works for unpublished posts - which is the common case, since
 *           editing is mostly editing drafts.
 *
 * An incoming link MAY carry `?slug=` to skip step A. It is an optimisation and never a source of
 * truth: it is verified against the loaded `detail.id` and discarded on mismatch, and a bookmarked
 * `/posts/{id}/edit` with no query string at all must work - which it does, because the upstream
 * linker emits no hint. See {@link SLUG_HINT_PARAM}.
 *
 * ### Why the walk asks for `mine: true` and NOT `author: <username>`
 *
 * This is the single most important line in the file. `listPosts` accepts both, and only one of them
 * can see a draft:
 *
 *   - The **public feed** - which is what `author` filters - is published-only for EVERY caller.
 *     Anonymous, reader, author and administrator alike. `post_service.visible_statuses_for` is
 *     documented as "deliberately *not* consulted by the public feed", precisely so that one URL
 *     cannot mean two different things to two callers.
 *   - **`mine: true`** switches the route into the private author workspace: the caller's own posts
 *     in every lifecycle state. The service's own words: "which is how an author's dashboard lists
 *     its drafts."
 *
 * So `author: user.username` would resolve published posts and silently fail on every draft - the
 * exact posts an author opens this page to finish. `src/app/(dashboard)/dashboard/page.tsx`, the page
 * that LINKS here, records the same finding in the same words and reads with `mine: true` for it.
 * The two may not be combined: `author` inside workspace mode is refused with `422`.
 *
 * ### The one consequence of that scope, stated so it is not mistaken for an oversight
 *
 * `mine: true` is scoped to the AUTHENTICATED account, so the walk finds the caller's own posts and no
 * others - including for an administrator, whom the service would otherwise permit to edit anything.
 * That is correct for this route rather than a gap, on three counts:
 *
 *   1. It is the specified behaviour. A non-owned identifier is required to produce the not-found /
 *      not-permitted panel, which is exactly what an exhausted walk produces.
 *   2. Nothing in the product navigates into the gap. Both call sites of `postEditRoute` reach a post
 *      the signed-in account owns: `dashboard/page.tsx` links rows from its own `mine: true` listing,
 *      and `post-editor.tsx` redirects to a post it has just created. The administrative tables at
 *      `/admin/posts` deliberately offer moderation actions rather than an edit link.
 *   3. The capability still exists where it is genuinely needed. `?slug=` resolves through
 *      `getPost(slug)`, which an administrator may read for any post, and the identifier check below
 *      then passes - so an administrator following a fully-qualified link edits the post normally. The
 *      alternative, reaching for the administrative listing, would import a namespace this route has no
 *      business holding and would put a second definition of "may I edit this" in the client.
 *
 * -------------------------------------------------------------------------------------------------
 * 3. WHAT THIS FILE OWNS - THE COMPLETE LIST
 *
 *   1. The client boundary. `'use client'`, because the resolution above is a pair of `useQuery`
 *      calls and the editor beneath it is an interactive island.
 *   2. The route's single `h1`. Every heading the editor renders is an `h2` or lower, so the document
 *      outline is correct only if this page supplies the `h1` - and supplies exactly one.
 *   3. The id -> slug -> detail resolution, and the four states it can be in: resolving, resolved,
 *      absent, unreachable.
 *   4. The taxonomy read, and its degradation notice.
 *   5. The vertical rhythm of the page, and nothing about its width. See {@link PAGE_STACK}.
 *   6. One way back to the workspace listing.
 *
 * Everything else belongs to a module that already owns it:
 *
 *   - `src/app/layout.tsx` owns the document, the stylesheet, ThemeProvider -> QueryProvider ->
 *     AuthProvider and the single sonner `<Toaster />`. So there is no `<html>`, `<body>`, `<header>`,
 *     `<main>` or `<footer>` here, no stylesheet import, no remounted provider and no second Toaster.
 *   - `src/app/(dashboard)/layout.tsx` owns the workspace chrome, the gutter, the measure AND all
 *     four session states - resolving, resolved, unconfirmed, signed out. So there is no session
 *     placeholder and no signed-out panel here; a second copy would double-render for every visitor
 *     who is not signed in. `useAuth()` IS read, but only for the one thing the layout cannot supply:
 *     see {@link EditPostPage}.
 *   - `src/app/{loading,error,not-found}.tsx` at the App Router root bound this segment already, which
 *     is why there is no `loading.tsx`, `error.tsx` or local error boundary beside this file. Note the
 *     deliberate consequence in section 5: a post that cannot be found must NOT reach any of them.
 *   - `src/components/blog/post-editor.tsx` owns the form, its validation, its Markdown preview and
 *     every mutation - `createPost`, `updatePost`, `deletePost`, `publishPost`, `unpublishPost` -
 *     plus the delete confirmation and the navigation that follows. NONE of that is reproduced here.
 *
 * There is also no `metadata` or `generateMetadata` export. Next.js forbids one from a module carrying
 * `'use client'`, and `src/app/robots.ts` already keeps this route out of every index, so the absence
 * costs nothing: there is no crawler to write metadata for.
 *
 * -------------------------------------------------------------------------------------------------
 * 4. GOVERNING STANDARDS
 *
 * `review_rules` reports NO user-specified rules for this project - a complete answer, not a truncated
 * one - so nothing here is invented to satisfy one, and their absence is not licence to lower the bar.
 * The binding constraints are AAP §0.10.1's own enterprise standards and AAP §0.8.5's design-system
 * rules:
 *
 *   Layered separation       A page delegates. This one owns a heading, a resolution and four states.
 *   Explicit API contracts   `Page<T>`'s five snake_case members are read verbatim - `items`, `total`,
 *       `page`, `page_size`, `pages` - because there is no camel-case layer anywhere in this tier.
 *       `listCategories()` answers with a BARE array, the API's single documented exception to that
 *       envelope, so nothing here reads `.items` off it.
 *   API versioning           No path and no `/api/v1` prefix is written here; every read goes through
 *       `@/lib/api/*`, and `@/lib/api/client` composes the version segment exactly once.
 *   Server-owned identity    No identifier is generated and no slug is derived, re-derived, guessed or
 *       submitted. The route's `id` is READ; the slug is DISCOVERED from what the service returned.
 *   Secure-by-default auth   The `(dashboard)` group and `src/middleware.ts` gate ARRIVAL, which is
 *       user experience. The ownership check that matters is re-decided server-side by
 *       `post_service.py` on every mutation. Nothing here reads, decodes or verifies a token, and the
 *       `mine: true` scope is enforced by the service rather than asserted by this page.
 *   Zero hardcoded values    Every class resolves to a token declared in `src/app/globals.css` or to
 *       a step on the token engine's own scale. No hex value, no literal dimension, no inline
 *       `style`, no arbitrary-value bracket utility, no bespoke media query.
 *   Semantic tokens only     `border`, `foreground` and `muted-foreground` are referenced by name; no
 *       primitive colour family or shade appears. `globals.css` is the only file permitted to map
 *       semantic onto primitive, which is what makes dark mode automatic here: this file carries no
 *       `dark:` utility and no theme conditional at all.
 *   Project primitives       Every control is `Button`, `Alert` or `Skeleton` from
 *       `@/components/ui/*`. No raw `<button>` and no hand-styled `<a>`; the back links are
 *       `<Button asChild>` over `next/link`, so each renders as a real anchor with the button's own
 *       focus ring. This page renders no form control at all - the editor owns every one.
 *   One breakpoint vocabulary  `lg` only, mirroring the editor's own split. No `@media` query, and no
 *       breakpoint invented.
 *   Accessibility as a floor One `h1`, present in all four states; the loading region named once
 *       rather than per placeholder; `AlertTitle as="h2"` so each panel sits at the right outline
 *       depth; and no authored `role` or `aria-live` on `Alert`, whose announcement behaviour is
 *       derived from its variant.
 *   Config from the environment  This file reads no environment variable, not even a `NEXT_PUBLIC_*`
 *       one. `@/lib/api/client` and `@/lib/seo` are the tier's only sanctioned readers.
 *   Legacy retirement        Nothing here references an `/items` path, an `Item` type or the
 *       `id`/`name`/`price` triple that `app.py` defined. A UUID `id` on a blog post is legitimate;
 *       that retired shape is not. Note in particular that the update behind this editor is a genuine
 *       partial `PATCH /api/v1/posts/{id}` and NOT the whole-object `PUT /items/{item_id}` it
 *       supersedes - which is exactly why editing a title cannot disturb a slug.
 *
 * -------------------------------------------------------------------------------------------------
 * 5. DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT HERE.
 *
 *   1. `notFound()` from `next/navigation`, or a thrown error, for a post that cannot be found. The
 *      brief is explicit that an unknown or non-owned identifier must render a clear panel and
 *      "never a crash, never a blank screen, never an escalation to an error boundary". An author who
 *      followed a stale bookmark needs a way back to their workspace, which a 404 boundary above this
 *      route cannot offer in the workspace's own chrome. See {@link ResolutionFailure}.
 *   2. A status select, a "published" checkbox or a publish button. Publishing is a first-class state
 *      TRANSITION - `POST /posts/{id}/publish`, which stamps `published_at` under a database `CHECK`
 *      constraint - never a form field. The editor owns both transitions and is the tier's only
 *      caller of either.
 *   3. A `zodResolver`, `postUpdateSchema` or any import from `@/lib/validation/post`. That module's
 *      own header names this page among its consumers "through `zodResolver`", which OVER-CLAIMS: the
 *      editor owns every resolver in the tier. This page renders no field, so it validates nothing.
 *      An unused import would fail `--max-warnings=0` anyway, so the over-claim and the lint gate
 *      point the same way.
 *   4. A `fetch` call, a hand-written path, or a `react-markdown` import. `@/lib/api/client` is the
 *      tier's only HTTP module and `@/components/blog/post-content` is its only Markdown renderer.
 *   5. A file input. Cover images are URL references; upload, image processing and object storage are
 *      out of scope, and the editor's URL field is the whole affordance.
 *   6. A client-side ownership test on the loaded post. It would be user experience wearing the
 *      costume of a security boundary. The service refuses a non-owner with `403` regardless, and
 *      that refusal is rendered - see {@link ResolutionFailure} - rather than pre-empted.
 *   7. A `Card` around the loading placeholder. The editor is a bare `<form>`, not a card, so card
 *      chrome in the placeholder would appear for one beat and then vanish - the precise flash the
 *      placeholder exists to prevent. See {@link EditorPlaceholder}.
 *   8. Re-use of the dashboard's own `['workspace-posts', account, page]` cache entry. It is tempting
 *      - arriving from the dashboard, page one is usually already warm - and it is wrong: that scope
 *      is a module-private constant over a DIFFERENT window size, so sharing the key would make two
 *      files write different data under one identity. This page reads under its own scope. See
 *      {@link RESOLUTION_QUERY_SCOPE}.
 * ============================================================================================== */

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import type { JSX } from 'react';
import { useEffect } from 'react';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CloudOff, RefreshCw, SearchX, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

import { PostEditor } from '@/components/blog/post-editor';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/use-auth';
import { listCategories } from '@/lib/api/categories';
import { isApiError } from '@/lib/api/client';
import { getPost, listPosts } from '@/lib/api/posts';
import type { CategoryPublic, PostDetail, PostSort } from '@/lib/types';
import { cn, FIRST_PAGE } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Addresses and parameters
 *
 * Literals, spelled beside the note in section 1 that explains why the URLs in this group are not what
 * the directory layout suggests. `src/app/(dashboard)/layout.tsx` - the shell this page renders inside
 * - declares the same address the same way, for the same reason, and `src/lib/routes.ts` names it for
 * call sites that compose addresses dynamically. If this address ever moves, all three change in the
 * same commit.
 * ---------------------------------------------------------------------------------------------- */

/** The workspace listing: the author's own posts, grouped by lifecycle state. */
const DASHBOARD_PATH = '/dashboard';

/**
 * The dynamic segment this file sits under: `[id]`.
 *
 * Lower-case, and it has to be - `useParams()` keys its result by the literal directory name, so
 * `[Id]` or `[postId]` would silently yield `undefined` here and every visit would render the
 * not-found panel. Named rather than inlined so the one place it is read cannot drift from the one
 * place it is declared, which is the directory this file lives in.
 */
const ID_PARAM = 'id';

/**
 * The optional `?slug=` hint.
 *
 * An OPTIMISATION and never a source of truth. A caller that already holds the slug - it comes back on
 * every `PostSummary` - may pass it to skip the workspace walk in {@link resolveSlugForId} and save a
 * request. Two rules make that safe, and both are enforced in {@link EditPostPage}:
 *
 *   1. It is VERIFIED against the loaded post's own `id`. A hint that resolves to a different post is
 *      discarded and the walk runs instead. Editing the wrong post because a URL was hand-assembled
 *      or a stale link was followed is the one outcome this page must never produce.
 *   2. It is never the only path. `src/app/(dashboard)/dashboard/page.tsx` links here through
 *      `postEditRoute(id)`, which emits NO query string, so the walk is the path that actually runs in
 *      production and the hint is a fast path for callers that happen to have one. A bookmarked
 *      `/posts/{id}/edit` therefore works, and that is a stated acceptance criterion rather than an
 *      inference.
 *
 * Deliberately not a `slug` route segment instead: the mutations behind the editor are all id-keyed,
 * so an id-keyed route is the one that needs no second lookup to save, publish or delete.
 */
const SLUG_HINT_PARAM = 'slug';

/* -------------------------------------------------------------------------------------------------
 * Resolution bounds
 *
 * The walk in {@link resolveSlugForId} is a loop over a paginated endpoint, so it needs two numbers:
 * how much to ask for at a time, and when to stop. Both are module constants and neither is in the
 * URL, mirroring `dashboard/page.tsx`'s `WORKSPACE_PAGE_SIZE` and `src/app/page.tsx`'s own window -
 * this is not a window the author chose, it is an implementation detail of a lookup.
 * ---------------------------------------------------------------------------------------------- */

/**
 * How many summaries to ask for per request: the largest window the service accepts.
 *
 * `app/core/dependencies.py` declares `MAX_PAGE_SIZE = 100` and the service **validates rather than
 * clamps** - `page_size=1000` is refused with the uniform problem document rather than trimmed - so
 * 100 is both the ceiling and the right choice. It is the right choice because it collapses the common
 * case to a single request: an author with a hundred posts or fewer resolves in one round trip, and
 * the loop below is then the fallback rather than the norm.
 *
 * Larger would be a `422`. Smaller would be strictly worse: the same rows fetched over more requests.
 */
const RESOLUTION_PAGE_SIZE = 100;

/**
 * How many pages the walk will fetch before giving up.
 *
 * A bound is mandatory, not defensive. Without one, a service that returned a `pages` count it never
 * satisfied - or an identifier that is simply not in this workspace - would spin requests until the
 * tab was closed. With it, the walk costs at most twenty requests and then reports honestly.
 *
 * Twenty pages at {@link RESOLUTION_PAGE_SIZE} covers two thousand posts, which is far beyond any
 * plausible workspace for this product, and the loop almost always exits long before the bound via one
 * of its two natural exits: the identifier matched, or the last page has been seen. Reaching the bound
 * is treated exactly like "not found", because from the author's point of view it is: see
 * {@link ResolutionFailure}.
 */
const MAX_RESOLUTION_PAGES = 20;

/**
 * Ordering for the walk, stated rather than left to the service's default.
 *
 * `recent` IS the default when the parameter is absent, so this changes no result. It is written down
 * because the walk's correctness depends on a STABLE ordering across its requests: a listing that
 * re-ordered between page one and page two could show a row twice and skip another entirely, and the
 * skipped one is the post the author was trying to open. Pinning the ordering makes that dependency
 * visible instead of accidental. `relevance` would be meaningless here - there is no search term.
 */
const RESOLUTION_SORT: PostSort = 'recent';

/* -------------------------------------------------------------------------------------------------
 * Cache identity
 * ---------------------------------------------------------------------------------------------- */

/**
 * Scope of the whole identifier -> post resolution.
 *
 * Its own scope, NOT the dashboard's `'workspace-posts'`. That constant is module-private to
 * `dashboard/page.tsx` and pairs with a window of fifty, while the walk here uses a hundred and answers
 * a different question entirely - one post rather than one page of them. Duplicating the literal would
 * put two files with two different shapes under one cache identity, so whichever rendered second would
 * overwrite the other's entry. The cost of a separate scope is one request on arrival from the
 * dashboard. The cost of sharing it is a class of bug that only appears once an author owns more than
 * fifty posts.
 *
 * One scope covers the whole resolution - walk and read together - because {@link loadPostForId} is one
 * query function. See its documentation for why that is the right seam, and {@link EditPostPage} for
 * what the resulting fixed key guarantees.
 */
const RESOLUTION_QUERY_SCOPE = 'post-edit-resolution';

/**
 * Cache key for the public taxonomy.
 *
 * `['categories']` and nothing else, which is the shape the endpoint dictates rather than a
 * shortening: `GET /api/v1/categories` takes no window, no filter and no sort, so there is no argument
 * to fold in and no second variant of this entry that could exist. It is the SAME key
 * `(dashboard)/posts/new/page.tsx` reads under, and that sharing is intentional and safe - identical
 * endpoint, identical parameters, identical shape - so an author who creates a post and then edits it
 * fetches the category list once. Contrast `RESOLUTION_QUERY_SCOPE` above, where the parameters
 * differ and sharing would therefore be a defect.
 *
 * `as const` so the tuple is readonly and its members are literal types, matching every other key in
 * the tier.
 */
const CATEGORIES_QUERY_KEY = ['categories'] as const;

/**
 * The taxonomy substituted when the real one cannot be read.
 *
 * Module-level rather than an inline `[]`, and that is load-bearing rather than tidy. `PostEditor`
 * derives its preview's category badges inside a `useMemo` whose dependency list contains
 * `categories`; a fresh array literal on every render would be a new reference every time, so the memo
 * would recompute on every keystroke the author types. One frozen-by-convention reference makes the
 * dependency stable.
 *
 * Never mutated - `PostEditor` only reads it. Substituting it in EDIT mode is safe, which is worth
 * stating because it looks dangerous: the editor seeds `category_ids` from `post.categories`, not from
 * this list, and it patches `category_ids` only when the selection differs from that baseline. So an
 * unreadable taxonomy renders an empty picker and leaves the post's existing categories untouched on
 * save. {@link TAXONOMY_NOTICE_DETAIL} tells the author exactly that.
 */
const NO_CATEGORIES: CategoryPublic[] = [];

/* -------------------------------------------------------------------------------------------------
 * Copy
 *
 * Named constants rather than inline strings, so the wording is reviewable in one place and a test or
 * an end-to-end journey can assert on the same value the component renders. The heading and every link
 * label are accessible names, which makes them contracts rather than decoration.
 * ---------------------------------------------------------------------------------------------- */

/** The route's one `h1`. Also what `frontend/tests/e2e/authoring.spec.ts` looks for on arrival. */
const PAGE_HEADING = 'Edit post';

/**
 * The heading's supporting line.
 *
 * States the two things about this screen that surprise authors, and nothing else. Editing a title does
 * not move the post's address, because the slug is derived once at creation and never re-derived - that
 * is what keeps a canonical link, a sitemap entry and an already-shared URL resolving. And saving does
 * not publish: a draft stays invisible to readers until the publish transition runs, which the service
 * guarantees with `CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)` rather than this page.
 */
const PAGE_LEDE =
  'Update your post and save when you are ready. Its web address does not change when you edit the ' +
  'title, and a draft stays invisible to readers until you publish it.';

/** Label of the link back to the workspace listing, in the heading block. */
const BACK_LABEL = 'Your posts';

/**
 * Label of the same destination when it is offered from inside a failure panel.
 *
 * Deliberately NOT the same string as {@link BACK_LABEL}, for two reasons that point the same way.
 *
 * It matches the panel's own copy verbatim - both {@link NOT_FOUND_DETAIL} and
 * {@link UNAVAILABLE_DETAIL} end by telling the author to open their posts - so the instruction and the
 * control that carries it out read as one sentence rather than as advice followed by an unrelated
 * button.
 *
 * And it removes a duplicated accessible name. Two links to `/dashboard` are on screen in the failure
 * states: this one and the heading block's. Sharing one destination makes identical names WCAG 2.4.4
 * compliant, so this is a clarity improvement rather than a fix - but a screen-reader user pulling up a
 * list of links benefits from the two being told apart, and it costs one constant to do it.
 */
const PANEL_BACK_LABEL = 'Open your posts';

/** Announced once, politely, while the post is being resolved. */
const LOADING_LABEL = 'Loading the post';

/** Title of the panel shown when the identifier in the address matches no post the author may edit. */
const NOT_FOUND_TITLE = 'That post could not be found';

/**
 * Body of that panel.
 *
 * Names the three real causes without asking the author to diagnose which one applies, because they
 * cannot tell them apart and the service deliberately does not tell them either: an identifier that
 * never existed, one whose post has since been deleted, and one belonging to somebody else all answer
 * the same way, so that a `404` cannot be used to confirm that a post exists. Then it says what to do.
 */
const NOT_FOUND_DETAIL =
  'The address you followed does not match any post in your workspace. It may have been deleted, or ' +
  'the link may be out of date. Open your posts to pick the one you meant to edit.';

/** Title of the panel shown when the post could not be READ - a transient failure, not an absence. */
const UNAVAILABLE_TITLE = 'This post could not be loaded';

/**
 * Body of that panel.
 *
 * Deliberately different from {@link NOT_FOUND_DETAIL}, because the two situations call for opposite
 * actions. This one means the post very probably exists and the request failed, so retrying is the
 * right move and the author's work is not at risk. Telling them "not found" here would be a lie that
 * costs them a post.
 */
const UNAVAILABLE_DETAIL =
  'Your post is safe - the request to load it did not succeed. This is usually a brief network or ' +
  'service interruption, so try again in a moment.';

/** Label of a retry action, and its accessible name. */
const RETRY_LABEL = 'Try again';

/** Label a retry action shows while a retry is on the wire. */
const RETRY_PENDING_LABEL = 'Retrying';

/** Title of the notice shown when the taxonomy could not be read but the post itself loaded. */
const TAXONOMY_NOTICE_TITLE = 'Categories are unavailable right now';

/**
 * Body of that notice.
 *
 * Says what is missing, what is NOT at risk, and what to do - in that order. The middle clause is the
 * one that matters and is the reason this copy differs from its counterpart on the create page: an
 * author editing a filed post sees an empty category picker and will reasonably fear that saving strips
 * the categories off. It does not. The editor seeds the selection from the post itself and patches
 * `category_ids` only when that selection actually changes, so an untouched picker sends no category
 * field at all.
 */
const TAXONOMY_NOTICE_DETAIL =
  'The category list could not be loaded, so the category picker is empty. Your post keeps the ' +
  'categories it already has - saving will not remove them - and every other field works normally.';

/** Toast headline for a failure to load the post. Short, because a toast is glanced at, not read. */
const LOAD_TOAST_TITLE = 'Could not load this post';

/** Toast headline for a failure to load the taxonomy. */
const TAXONOMY_TOAST_TITLE = 'Could not load categories';

/**
 * Identity of the load toast.
 *
 * A stable id makes sonner REPLACE the existing notification rather than stack another one, so an
 * author who presses "Try again" three times sees one toast update three times instead of collecting
 * three identical toasts.
 */
const LOAD_TOAST_ID = 'edit-post-load';

/** Identity of the taxonomy toast. Distinct from {@link LOAD_TOAST_ID} so the two never replace each
 * other - they report unrelated failures and can be on screen together. */
const TAXONOMY_TOAST_ID = 'edit-post-categories';

/**
 * What a toast says when the failure carries no message a person can act on.
 *
 * Reached for a rejection that is not an `ApiError` - a bug in a query function, say - where the
 * underlying message is a developer artefact rather than something an author should be shown.
 */
const GENERIC_FAILURE_DETAIL = 'Something went wrong while loading. Your post is not affected.';

/* -------------------------------------------------------------------------------------------------
 * Geometry
 *
 * Every value is a step on the token engine's own scale: `--spacing` multiples for the gaps and the
 * inset, `--radius-*` for the corners. There is no measure and no gutter here, and no `max-w-*` of any
 * kind - see {@link PAGE_STACK}.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The page's vertical rhythm, and deliberately nothing else.
 *
 * No `mx-auto`, no `px-*` and no `max-w-*`, because each would be wrong here rather than merely
 * redundant. `src/app/(dashboard)/layout.tsx` already pays the gutter (`px-4 sm:px-6`) and the measure
 * (`max-w-6xl`) around this page and hands it a `min-w-0 flex-1` content region; adding a second inset
 * would double the gutter, and adding a narrower measure would clamp the editor's own two-column split
 * at `lg` - the very layout AAP §0.7.3.2 specifies for the editor row.
 *
 * `min-w-0` is load-bearing rather than defensive. Without it a flex item refuses to shrink below its
 * content's intrinsic width, so one long unbroken word inside the editor - a cover-image URL, a code
 * span in the preview - would widen the whole document and produce exactly the horizontal overflow the
 * responsive criteria forbid at 375, 768 and 1440 pixels.
 *
 * `gap-8` matches the editor's own internal rhythm, so the heading block, any notice and the form read
 * as one column rather than three loosely stacked regions.
 */
const PAGE_STACK = 'flex min-w-0 flex-col gap-8';

/** The heading block: the `h1`, its supporting line and the way back. */
const HEADING_STACK = 'flex min-w-0 flex-col gap-3';

/**
 * The editor's responsive spine, mirrored by the placeholder.
 *
 * VERBATIM from `src/components/blog/post-editor.tsx`: one column with the preview beneath the fields
 * below 64rem, two columns side by side from 64rem. Copying it is the anti-flash guarantee - the
 * placeholder occupies the shape the real form will, so nothing jumps sideways when the post arrives.
 * Nothing changes at 48rem, because that breakpoint belongs to the editor's action bar.
 */
const PLACEHOLDER_COLUMNS = 'grid min-w-0 grid-cols-1 gap-8 lg:grid-cols-2';

/** The fields column, matching the editor's own stack. */
const PLACEHOLDER_FIELDS = 'flex min-w-0 flex-col gap-6';

/** One field: its label line and its control. */
const PLACEHOLDER_FIELD = 'flex min-w-0 flex-col gap-2';

/** The preview column, matching the editor's `<section>`. */
const PLACEHOLDER_PREVIEW = 'flex min-w-0 flex-col gap-3';

/**
 * The action-bar row.
 *
 * `border-border` and `border-t` are the editor's own, so the rule sits exactly where the real one
 * will. The sticky behaviour it gains at `md` is not reproduced: a placeholder that pinned itself to
 * the foot of the viewport would be movement for its own sake.
 */
const PLACEHOLDER_ACTIONS = 'border-border flex flex-wrap items-center gap-3 border-t pt-4';

/* -------------------------------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Narrow one `useParams()` or `useSearchParams()` value to a usable, non-blank string.
 *
 * Three things happen here and all three are necessary.
 *
 * **The array case.** `useParams()` types every value as `string | string[]`, because a catch-all
 * segment produces an array. `[id]` is a single dynamic segment so it yields a string in practice, but
 * the type is the contract and narrowing it with a cast would be trading a compile-time check for a
 * run-time surprise the day the segment changes shape. An array is refused rather than joined or
 * indexed: `/posts/a/b/edit` does not route here, so an array would mean the route no longer matches
 * this file's assumptions, and quietly using its first element would send a request built from half of
 * whatever the visitor typed.
 *
 * **Percent-decoding.** Not done here, deliberately - Next.js has already decoded the segment by the
 * time it reaches `useParams()`, and the API wrapper re-encodes it on the way out through
 * `encodePathSegment`. Decoding again would corrupt any value containing a literal `%`.
 *
 * **Blankness.** Trimmed and measured, because an address ending `/posts/%20/edit` yields a value that
 * is truthy, non-empty, and completely useless as a key. Answering `undefined` for it routes the visit
 * into the not-found panel, which is the honest outcome, instead of spending a request to be told the
 * same thing.
 *
 * @param value - One member of a params or search-params read.
 * @returns The trimmed value, or `undefined` when it is absent, an array, or blank.
 */
function singleParam(value: string | string[] | null | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Reduce a rejection to one sentence an author can act on.
 *
 * `ApiError.message` is {@link https://www.rfc-editor.org/rfc/rfc9457 | problem+json}'s `detail`, which
 * the service writes to be safe to show to a person, and `@/lib/api/client` guarantees the shape for the
 * cases the service cannot speak for - an unreachable host, a gateway that answered with HTML, a signal
 * that fired first. So the normalised message is exactly the right thing to surface.
 *
 * What is deliberately NOT surfaced: `error.stack`, `problem.type`, `problem.instance`, the status code
 * and the correlation identifier. Every one is a diagnostic rather than an instruction, and a notice
 * that reads like a stack trace teaches an author to dismiss notices unread.
 *
 * @param error - The rejection react-query recorded, typed as `Error` because that is the tier's default
 * error type. Narrowed here rather than asserted.
 * @returns A non-empty sentence. Never the empty string, so the notice it fills cannot render blank.
 */
function failureDetail(error: Error): string {
  if (!isApiError(error)) {
    return GENERIC_FAILURE_DETAIL;
  }

  // Trimmed before it is measured: a message of spaces is blank to a reader while being non-empty to
  // `length`. `ApiError` already falls back from an empty `detail` to the document's `title`, so this
  // is the second line of defence rather than the first.
  const detail = error.message.trim();

  return detail.length > 0 ? detail : GENERIC_FAILURE_DETAIL;
}

/**
 * Decide whether a rejection means "this post is not yours to edit" rather than "the request failed".
 *
 * The distinction drives which of the two panels renders, and getting it wrong is expensive in both
 * directions: showing "not found" for a network blip loses an author their post, and showing "try
 * again" for a deleted post invites them to retry something that can never succeed.
 *
 * Two statuses count as an answer rather than a failure:
 *
 *   - `404` - no post has that slug, or the caller is not entitled to see the unpublished one that
 *     does. The service answers these identically on purpose, so that a `404` cannot be used to
 *     confirm that a draft exists.
 *   - `403` - the post exists and is visible, but this account may not act on it. Reachable when an
 *     administrator's link is followed by an ordinary author.
 *
 * Everything else - `401`, `422`, `429`, any `5xx`, a transport failure, an aborted signal - is a
 * failure, and the tier's shared retry predicate in `@/providers/query-provider` already declines to
 * retry the `4xx` members of that set, so no request is wasted on one that cannot recover.
 *
 * Typed `unknown` rather than `Error | null` so that the two callers can share it: one passes the error
 * react-query recorded, the other passes a value caught in a `catch` clause, which TypeScript types as
 * `unknown` under `useUnknownInCatchVariables`. `isApiError` is a type guard over `unknown` and already
 * answers `false` for `null`, `undefined` and any non-error value, so no pre-check is needed.
 *
 * @param error - A rejection from either source, or `null` when nothing has failed.
 * @returns `true` only for a definitive refusal.
 */
function isMissingOrForbidden(error: unknown): boolean {
  if (!isApiError(error)) {
    return false;
  }

  return error.status === 404 || error.status === 403;
}

/**
 * Find the slug of the author's own post with this identifier: the id -> slug half of section 2.
 *
 * ### Why a walk at all
 *
 * Because the API has no id-keyed read. `PostSummary` carries `id` AND `slug` together, so a listing the
 * author is entitled to see is enough to translate one into the other - and the workspace listing is
 * exactly that listing.
 *
 * ### Why `mine: true`
 *
 * Because the public feed is published-only for every caller, so the `author` filter cannot see a draft
 * - and a draft is what an author usually arrives here to finish. `mine: true` is the private workspace
 * mode: this account's own posts in every lifecycle state. The full reasoning, with the service's own
 * wording, is in section 2 of the module header. `author` may not be combined with it (`422`), and no
 * `status` is sent either, because narrowing to one state would hide a post the author asked for by
 * identifier. **Nothing is filtered by status on this side.** The service decided what this caller may
 * see; a second opinion here could only ever be wrong in one of two directions.
 *
 * ### Why it terminates, three ways
 *
 *   1. **The identifier matched.** Returns the slug immediately, without fetching the pages after it -
 *      so the overwhelmingly common case, a recently-touched post on page one, costs one request.
 *   2. **The last page has been seen.** `page >= pages` means there is nothing further to look at, so
 *      the post genuinely is not in this workspace. Answers `null`. This also covers an empty workspace,
 *      where `pages` is `0` and the first comparison is already true.
 *   3. **The bound was reached.** {@link MAX_RESOLUTION_PAGES} pages fetched with no match. Answers
 *      `null`, which the caller renders identically to case 2 - because from the author's point of
 *      view it is identical, and because a page that spun requests forever would be worse than one that
 *      admits it could not find something.
 *
 * The requests are sequential rather than parallel, and that is the point rather than an oversight:
 * case 1 is what makes this cheap, and it can only be taken by a loop that looks at each answer before
 * deciding whether to ask again. Fetching all twenty pages at once to save latency would multiply the
 * cost of the normal case by twenty to speed up a case that does not occur.
 *
 * ### Failure
 *
 * Rejections propagate untouched. A caller cannot distinguish "not in this workspace" from "the listing
 * could not be read" if both answer `null`, and those two need opposite treatment - so absence is a
 * return value and failure is a throw. See {@link isMissingOrForbidden}.
 *
 * @param postId - The identifier from the route segment, already narrowed by {@link singleParam}.
 * @param signal - React Query's abort signal, forwarded so that navigating away mid-walk cancels the
 * request in flight rather than resolving into a cache nobody is reading.
 * @returns The matching post's slug, or `null` when this workspace contains no such post.
 * @throws The client module's normalised error, notably `401` if the credential has gone.
 */
async function resolveSlugForId(postId: string, signal: AbortSignal): Promise<string | null> {
  for (let page = FIRST_PAGE; page < FIRST_PAGE + MAX_RESOLUTION_PAGES; page += 1) {
    // Sequential on purpose - see "Why it terminates, three ways" above. Each answer decides whether
    // there is a next request at all, so the await belongs inside the loop.
    //
    // Named `windowOfPosts`, not `window`: the latter shadows the DOM global inside this scope, and a
    // later edit that reached for `window.location` in the same function would silently read `.items`
    // off a page envelope instead.
    const windowOfPosts = await listPosts(
      {
        mine: true,
        page,
        page_size: RESOLUTION_PAGE_SIZE,
        sort: RESOLUTION_SORT,
      },
      { signal },
    );

    const match = windowOfPosts.items.find((summary) => summary.id === postId);

    if (match !== undefined) {
      return match.slug;
    }

    // The envelope's own `pages`, read verbatim in the service's snake_case. `>=` rather than `===`
    // so a `pages` of `0` on an empty workspace also stops here instead of falling through to the
    // bound and spending nineteen more requests on a workspace with nothing in it.
    if (page >= windowOfPosts.pages) {
      return null;
    }
  }

  return null;
}

/**
 * Read the hinted post, treating a stale hint as an absence rather than as a failure.
 *
 * The `?slug=` hint is supplied by a caller and can be wrong in a way the walk cannot be: a slug that
 * named a post which has since been deleted, or one hand-typed into a shared link. Both answer `404`,
 * and neither should stop the page - the identifier in the address is still good, so the walk can still
 * find the post. So a definitive refusal is converted into `null` and the caller falls through.
 *
 * Everything else is rethrown untouched, which is the half that matters. A `5xx`, a transport failure or
 * an aborted signal must NOT be mistaken for "the hint was stale": swallowing one would send the page
 * off to walk a workspace it also cannot read, turning one honest failure into two.
 *
 * @param slug - The hinted slug.
 * @param signal - React Query's abort signal.
 * @returns The post at that slug, or `null` when no such post is visible to this caller.
 * @throws Any non-definitive failure, unchanged.
 */
async function readHintedPost(slug: string, signal: AbortSignal): Promise<PostDetail | null> {
  try {
    return await getPost(slug, { signal });
  } catch (error) {
    if (isMissingOrForbidden(error)) {
      return null;
    }

    throw error;
  }
}

/**
 * Produce the full post named by the route's identifier: the whole of section 2, in one function.
 *
 * ### Why one query function rather than a chain of dependent `useQuery` calls
 *
 * Because the dependency is an ALGORITHM, not view state, and expressing it as component state was
 * measurably worse in three ways.
 *
 * The obvious shape is two dependent queries - walk, then read, the second gated on the first's answer -
 * with the `?slug=` fast path bolted on. But the fast path has to be REJECTABLE: a hint that resolves to
 * a different post must be discarded in favour of the walk. Rejection is sticky by nature, and a
 * derived `usesHint` oscillates - discarding the hint switches the active query key, so the next render
 * reads the *walk's* outcome, concludes the hint was fine after all, switches back, re-reads the hint's
 * cached error, and switches away again. Making it stick needs `useState` written from an effect, which
 * `react-hooks/set-state-in-effect` correctly rejects as a cascading render.
 *
 * Folding the sequence into one query function removes the cause rather than working around it:
 *
 *   1. **No rejection state.** The fallback is a fall-through in straight-line code. The hint is tried,
 *      verified against the identifier, and abandoned within a single call - there is no intermediate
 *      state for a render to observe, so there is nothing to oscillate.
 *   2. **A key that cannot change.** `[scope, account, postId]` is fixed for the life of the route,
 *      because the slug - the thing that varies - is now an internal detail rather than part of the
 *      cache identity. So `data` can never revert to `undefined`, which is what makes the editor's
 *      no-unmount guarantee structural instead of something a pinned copy has to defend. See
 *      {@link EditPostPage}.
 *   3. **One thing to retry.** A single `refetch()` re-runs the entire resolution, hint included, rather
 *      than the caller having to work out which of two queries failed.
 *
 * Nothing is fired speculatively, which was the point of gating the second query on the first: the reads
 * here are strictly sequential and the detail read cannot begin until a slug exists.
 *
 * ### The three outcomes
 *
 *   - A `PostDetail` whose `id` is `postId`. Verified twice over - once against the hint, and once by
 *     construction on the walk's path, where the slug came from the summary whose `id` matched.
 *   - `null`. The identifier names no post this account may edit. A definitive answer, not a failure.
 *   - A throw. Something could not be read. See {@link isMissingOrForbidden} for the boundary.
 *
 * @param postId - The identifier from the route segment.
 * @param slugHint - The `?slug=` fast path, or `undefined`. See {@link SLUG_HINT_PARAM}.
 * @param signal - React Query's abort signal, forwarded into every request so that navigating away
 * mid-resolution cancels the one in flight.
 * @returns The post, or `null` when there is no such post for this account.
 */
async function loadPostForId(
  postId: string,
  slugHint: string | undefined,
  signal: AbortSignal,
): Promise<PostDetail | null> {
  if (slugHint !== undefined) {
    const hinted = await readHintedPost(slugHint, signal);

    // The verification, and the reason the hint can never open the wrong post: the identifier on what
    // the service actually returned has to be the identifier in the address. A mismatch is discarded
    // silently - it is not the author's mistake to report, and the walk is about to give the right
    // answer anyway.
    if (hinted !== null && hinted.id === postId) {
      return hinted;
    }
  }

  const slug = await resolveSlugForId(postId, signal);

  if (slug === null) {
    return null;
  }

  return getPost(slug, { signal });
}

/* -------------------------------------------------------------------------------------------------
 * Presentation
 * ---------------------------------------------------------------------------------------------- */

/**
 * The heading block.
 *
 * The route's single `h1`, its supporting line, and one way back to the workspace listing. The back link
 * is `<Button asChild>` wrapping `next/link`: `asChild` composes `@radix-ui/react-slot`, so the rendered
 * element is a real anchor - middle-clickable, and carrying the button primitive's own `:focus-visible`
 * ring - rather than a `<button>` that calls `router.push`, and rather than a hand-styled `<a>` that
 * `@next/next/no-html-link-for-pages` would reject.
 *
 * `ghost` and `sm`, because this is a secondary affordance sitting under a heading; the editor's own save
 * and publish actions are the page's primary controls and must stay visually dominant.
 *
 * @returns The heading block. Rendered by ALL FOUR branches of {@link EditPostPage}, which is what keeps
 * the `h1` present from the first paint and the document outline never momentarily headless - including
 * on the two failure screens, where it is also the only route back.
 */
function PageHeading(): JSX.Element {
  return (
    <div className={HEADING_STACK}>
      <h1 className="text-foreground text-3xl font-semibold tracking-tight">{PAGE_HEADING}</h1>

      {/* `max-w-2xl` is `--container-2xl` (42rem), the engine's own step and the measure the rest of
          this tier uses for a paragraph. It constrains only this sentence, never the page, so it
          cannot reach the editor's two-column split. `text-pretty` balances the last line rather than
          leaving one orphaned word; it is a generated utility over the engine's `text-wrap` scale. */}
      <p className="text-muted-foreground max-w-2xl text-pretty">{PAGE_LEDE}</p>

      {/* `self-start` keeps the control the width of its own label instead of stretching across the
          column, which a flex child would otherwise do. */}
      <Button asChild className="self-start" size="sm" variant="ghost">
        <Link href={DASHBOARD_PATH}>
          <ArrowLeft aria-hidden="true" />
          {BACK_LABEL}
        </Link>
      </Button>
    </div>
  );
}

/**
 * What stands where the editor will, while the post is being resolved.
 *
 * ### Why a placeholder rather than the editor with an empty form
 *
 * `PostEditorProps` is a discriminated union whose edit arm types `post` as REQUIRED, so mounting the
 * editor before the post arrives is not merely unwise - it does not compile. That is the contract doing
 * its job: an editor bound to no post would render empty fields over a real post, and an author who
 * started typing into them before the answer landed would be editing nothing, or worse, would save an
 * emptied version of something.
 *
 * ### Why it mirrors the editor's geometry instead of being a single grey block
 *
 * Every class here is the editor's own, copied verbatim from `src/components/blog/post-editor.tsx`: the
 * `lg:grid-cols-2` spine, the `gap-6` field stack, the `gap-2` field, the `h-11` control height that
 * `@/components/ui/input` sets, the textarea heights, and the `border-t` action rule. So the real form
 * lands in the space its placeholder was already occupying and nothing jumps when it does.
 * `src/app/(dashboard)/layout.tsx` reaches for the same technique one level up, sharing its geometry
 * constants between its loading branch and its resolved chrome for exactly this reason.
 *
 * This is also why there is no `Card` here. The editor is a bare `<form>`, so a bordered, padded,
 * shadowed card in the placeholder would be chrome that appears for one beat and then vanishes - the
 * precise flash the mirroring exists to prevent.
 *
 * ### Announcement
 *
 * `role="status"` with the name on the WRAPPER, not on the blocks. `Skeleton` sets its own
 * `aria-hidden="true"`, and announcing a group once is the documented pattern; naming each block would
 * make a screen reader count grey rectangles.
 *
 * @returns The placeholder region.
 */
function EditorPlaceholder(): JSX.Element {
  return (
    <div aria-label={LOADING_LABEL} className={PLACEHOLDER_COLUMNS} role="status">
      <div className={PLACEHOLDER_FIELDS}>
        {/* Title. `h-11` is the input primitive's height - 2.75rem, the WCAG 2.5.5 target floor - so
            only the label line's width needs stating. */}
        <div className={PLACEHOLDER_FIELD}>
          <Skeleton className="w-16" />
          <Skeleton className="h-11 rounded-md" />
        </div>

        {/* Excerpt: the editor renders it as a three-row textarea. */}
        <div className={PLACEHOLDER_FIELD}>
          <Skeleton className="w-20" />
          <Skeleton className="h-20 rounded-md" />
        </div>

        {/* Content: sixteen rows in the editor, and the tallest thing on the page. Capped here at a
            step that holds the fold on a 375px viewport without pushing the action rule off-screen. */}
        <div className={PLACEHOLDER_FIELD}>
          <Skeleton className="w-20" />
          <Skeleton className="h-64 rounded-md" />
        </div>

        {/* Cover image URL. */}
        <div className={PLACEHOLDER_FIELD}>
          <Skeleton className="w-36" />
          <Skeleton className="h-11 rounded-md" />
        </div>

        {/* The category toggles. Three chips at the `sm` button height, `flex-wrap` so they never
            widen the document. */}
        <div className={PLACEHOLDER_FIELD}>
          <Skeleton className="w-24" />
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-8 w-24 rounded-md" />
            <Skeleton className="h-8 w-20 rounded-md" />
            <Skeleton className="h-8 w-28 rounded-md" />
          </div>
        </div>
      </div>

      {/* The preview column. `rounded-lg` matches the editor's preview panel, not the fields. */}
      <div className={PLACEHOLDER_PREVIEW}>
        <Skeleton className="w-20" />
        <Skeleton className="h-64 rounded-lg" />
      </div>

      {/* The action rule, spanning both columns so it reads as the foot of the form rather than the
          foot of the fields. In edit mode the editor offers four actions - save, publish or unpublish,
          delete, cancel - so four blocks stand here rather than the create page's two.
          `lg:col-span-2` is the only class here the editor does not itself carry, because the editor's
          bar is a sibling of the grid while this one lives inside it. */}
      <div className={cn(PLACEHOLDER_ACTIONS, 'lg:col-span-2')}>
        <Skeleton className="h-11 w-32 rounded-md" />
        <Skeleton className="h-11 w-28 rounded-md" />
        <Skeleton className="h-11 w-24 rounded-md" />
        <Skeleton className="h-11 w-20 rounded-md" />
      </div>
    </div>
  );
}

/** Props of {@link ResolutionFailure}. */
interface ResolutionFailureProps {
  /**
   * Whether the post is definitively unavailable to this account, rather than temporarily unreadable.
   *
   * `true` for an exhausted workspace walk and for a `404` or `403` from the read - see
   * {@link isMissingOrForbidden}. Drives the copy, the glyph, the tone AND whether a retry is offered at
   * all, because those four must agree: offering "Try again" for a deleted post invites an author to
   * press a button that can never work.
   */
  readonly isDefinitive: boolean;
  /** Whether a retry is currently on the wire. Drives the label and disables the control. */
  readonly isRetrying: boolean;
  /** Ask again. Supplied by {@link EditPostPage} from react-query's `refetch`. */
  readonly onRetry: () => void;
}

/**
 * The panel shown when the post behind this address could not be produced.
 *
 * ### Why this is a panel and not `notFound()`
 *
 * Because the brief forbids "a crash, a blank screen, or an escalation to an error boundary", and it is
 * right to. The App Router's `not-found.tsx` at the root would render OUTSIDE this group's chrome, so an
 * author who followed a stale bookmark would land on a generic page with no route back into their
 * workspace and no indication that they are still signed in. This panel renders INSIDE the workspace
 * shell, keeps the `h1` and the "Your posts" link that {@link PageHeading} supplies, and adds a second,
 * more prominent way back - which is the whole of what that author needs.
 *
 * It is also the correct behaviour for the ordinary case rather than only for the exceptional one: an
 * author who deleted a post in one tab and then used a stale link in another is not experiencing an
 * error, they are experiencing a stale link.
 *
 * ### Two situations, one component, deliberately opposite treatments
 *
 * | | `isDefinitive` | not definitive |
 * | --- | --- | --- |
 * | Cause | absent, deleted, or another author's | the request failed |
 * | Variant | `empty` - dashed, centred, no announcement | `destructive` - announces assertively |
 * | Retry | none. It cannot succeed | offered, and reports its own progress |
 *
 * `empty` is the accurate variant for the first case and not merely the gentler one. `@/components/ui/alert`
 * derives its live-region role from its variant, and `empty` carries NONE - which is right, because this
 * panel IS the page's content on arrival rather than a response to something the author just did, and a
 * region that announces itself on every page load is noise. `destructive` carries `role="alert"`, which
 * is right for the second case: the author asked for a post and did not get it, and that should
 * interrupt.
 *
 * No `role` and no `aria-live` is authored on either. Both would fight the variant - `role="alert"`
 * already implies `aria-live="assertive"` - and restating one risks a double announcement.
 *
 * ### Why the `empty` variant is left without a live-region role, having been asked about
 *
 * The alert primitive does permit a caller to pass `role="status"` alongside `variant="empty"`, and it
 * says what that override is for: a panel "rendered in response to an action". This panel is not one. It
 * is what this ROUTE renders on arrival, so a role here would announce on every load that reaches it,
 * which is the noise the variant carries no role in order to avoid. The nothing-was-found state stays
 * discoverable without it: the panel's heading is a real `h2` in the outline directly under this route's
 * `h1`, the recovery link is keyboard-reachable with the button primitive's own focus ring, and the App
 * Router's own route announcer already speaks on a client-side transition into this route. Adding the
 * attribute would also contradict the design-system rule against re-authoring ARIA a primitive already
 * derives - so the accessibility floor is met by structure here rather than by a live region.
 *
 * The leading glyph is `aria-hidden`: the title beside it already carries the meaning, so an announced
 * icon would only repeat it. Its size comes from the alert primitive's own rule for a first-child `svg`,
 * so no dimension is written here.
 *
 * @param isDefinitive - See {@link ResolutionFailureProps.isDefinitive}.
 * @param isRetrying - See {@link ResolutionFailureProps.isRetrying}.
 * @param onRetry - See {@link ResolutionFailureProps.onRetry}.
 * @returns The panel, with a way back and - only when retrying could help - a way to retry.
 */
function ResolutionFailure({
  isDefinitive,
  isRetrying,
  onRetry,
}: ResolutionFailureProps): JSX.Element {
  return (
    <Alert variant={isDefinitive ? 'empty' : 'destructive'}>
      {/* Two glyphs for two meanings: a struck-through search for "we looked through your workspace and
          it is not there", a warning triangle for "something went wrong". The `empty` variant centres
          its content, and the primitive's own note records that its leading-icon slot is designed for
          the start-aligned notice variants - so this glyph is rendered inside the description for the
          definitive case, below, and only pinned to the edge for the destructive one. */}
      {isDefinitive ? null : <TriangleAlert aria-hidden="true" />}

      {/* `as="h2"` because this page's `h1` is the route heading and the alert primitive's default is a
          non-heading `div`. An `h2` puts the panel into the document outline directly beneath it. */}
      <AlertTitle as="h2">{isDefinitive ? NOT_FOUND_TITLE : UNAVAILABLE_TITLE}</AlertTitle>

      <AlertDescription>
        {/* The centred glyph for the empty state, inside the description exactly as the primitive
            documents: `justify-self-center` constrains the inline axis, which is what a grid item needs
            - `self-center` would resolve to `align-self` and do nothing to a content-height row.
            `size-8` and `mb-3` are steps on the engine's spacing scale, and the colour is inherited
            from the variant rather than stated. */}
        {isDefinitive ? (
          <SearchX aria-hidden="true" className="mb-3 size-8 justify-self-center" />
        ) : null}
        {isDefinitive ? NOT_FOUND_DETAIL : UNAVAILABLE_DETAIL}
      </AlertDescription>

      {/* `mt-4` is a `--spacing` step. `justify-self-center` on the definitive panel so the actions sit
          under centred copy; `justify-self-start` on the failure panel so they sit under start-aligned
          copy. Both constrain the INLINE axis, which is what a grid item needs - `Alert` is a `grid`
          container, so `self-*` there would resolve to `align-self` and leave the row full-bleed. */}
      <div
        className={cn(
          'mt-4 flex flex-wrap items-center gap-3',
          isDefinitive ? 'justify-self-center' : 'justify-self-start',
        )}
      >
        {/* The primary way out of both states, and `secondary` rather than `primary` on purpose: it is
            the only action on the screen, so it needs no emphasis to be found, and reserving `primary`
            for the editor's Save keeps that meaning consistent across the two things this route can
            render. */}
        <Button asChild size="sm" variant="secondary">
          <Link href={DASHBOARD_PATH}>
            <ArrowLeft aria-hidden="true" />
            {PANEL_BACK_LABEL}
          </Link>
        </Button>

        {/* Offered only where it can succeed. See the table above. */}
        {isDefinitive ? null : (
          <Button disabled={isRetrying} onClick={onRetry} size="sm" type="button" variant="ghost">
            {/* `motion-safe:` so the spin is suppressed for a reader who has asked for reduced motion,
                matching how the editor animates its own pending states. `undefined` rather than `''`
                when at rest, so the icon carries no empty `class` attribute. */}
            <RefreshCw
              aria-hidden="true"
              className={isRetrying ? 'motion-safe:animate-spin' : undefined}
            />
            {isRetrying ? RETRY_PENDING_LABEL : RETRY_LABEL}
          </Button>
        )}
      </div>
    </Alert>
  );
}

/** Props of {@link TaxonomyNotice}. */
interface TaxonomyNoticeProps {
  /** Whether a retry is currently on the wire. Drives the label and disables the control. */
  readonly isRetrying: boolean;
  /** Ask for the taxonomy again. Supplied by {@link EditPostPage} from react-query's `refetch`. */
  readonly onRetry: () => void;
}

/**
 * The notice shown when the taxonomy could not be read but the post itself loaded.
 *
 * ### It explains a degradation, it does not block anything
 *
 * A taxonomy outage must never stop an author editing. The editor renders beneath this notice with an
 * empty category list, every other field works, and saving, publishing and deleting are untouched. What
 * is more, the post keeps the categories it already has: the editor seeds its selection from
 * `post.categories` and patches `category_ids` only when that selection changes, so an untouched empty
 * picker sends no category field at all. {@link TAXONOMY_NOTICE_DETAIL} says so explicitly, because an
 * author looking at an empty picker over a filed post will otherwise assume the worst and avoid saving.
 *
 * ### Why `warning` and not `destructive`
 *
 * `@/components/ui/alert` derives its announcement from its variant: `destructive` carries `role="alert"`,
 * which is assertive and interrupts whatever a screen reader is saying, while `warning` carries
 * `role="status"`, which is polite and announced once the reader is idle. Interrupting an author
 * mid-sentence to report that an optional field is temporarily unavailable is the wrong priority, so
 * `warning` is the accurate tone as well as the kinder one.
 *
 * @param isRetrying - See {@link TaxonomyNoticeProps.isRetrying}.
 * @param onRetry - See {@link TaxonomyNoticeProps.onRetry}.
 * @returns The notice, with its retry action.
 */
function TaxonomyNotice({ isRetrying, onRetry }: TaxonomyNoticeProps): JSX.Element {
  return (
    <Alert variant="warning">
      <CloudOff aria-hidden="true" />

      <AlertTitle as="h2">{TAXONOMY_NOTICE_TITLE}</AlertTitle>

      <AlertDescription>{TAXONOMY_NOTICE_DETAIL}</AlertDescription>

      {/* `justify-self-start`, NOT `self-start`. `Alert` is a `grid` container, so a grid item's
          `self-start` resolves to `align-self` - the BLOCK axis - which does nothing to a row that is
          already content-height, and leaves the button stretched full-bleed across the notice.
          Constraining the INLINE axis in a grid needs `justify-self`. (The back link in
          {@link PageHeading} correctly uses `self-start`, because its parent is a COLUMN flex
          container, where the cross axis is the inline one.) */}
      <Button
        className="mt-3 justify-self-start"
        disabled={isRetrying}
        onClick={onRetry}
        size="sm"
        type="button"
        variant="secondary"
      >
        <RefreshCw
          aria-hidden="true"
          className={isRetrying ? 'motion-safe:animate-spin' : undefined}
        />
        {isRetrying ? RETRY_PENDING_LABEL : RETRY_LABEL}
      </Button>
    </Alert>
  );
}

/* -------------------------------------------------------------------------------------------------
 * The page
 * ---------------------------------------------------------------------------------------------- */

/**
 * The post editor bound to an existing post, at `/posts/{id}/edit`.
 *
 * ### Why `useAuth()` IS called here, when the sibling create page does not
 *
 * `src/app/(dashboard)/layout.tsx` decides the session for this whole group and its `children` contract
 * is explicit that a page is "Rendered ONLY once a principal is known", so nothing here re-derives the
 * session, renders a second signed-out panel or duplicates the layout's placeholder. The principal is
 * read for exactly one thing the layout cannot supply: the workspace walk needs a **cache scope** and a
 * **gate**. `mine: true` with no credential is a `401` rather than a quiet fall back to the public feed,
 * and two accounts must never read each other's resolution from one cache entry - so the username is the
 * key's account member and its presence is the query's `enabled`.
 *
 * `user` is read optionally throughout. No non-null assertion, because a `null` user inside a live
 * provider is an ordinary state and the assertion would be a claim about another module's branching that
 * this file cannot enforce. `useAuth()` throws only when `AuthProvider` is missing, which is a wiring
 * defect and deliberately loud.
 *
 * ### The four states, and the resolution behind them
 *
 *   1. **Resolving.** The walk, or the read, or the taxonomy is still in flight. Placeholder.
 *   2. **Resolved.** A post whose `id` matches the route has been read in full and the taxonomy has
 *      settled. The editor, optionally under {@link TaxonomyNotice}.
 *   3. **Absent.** The walk ran out of pages, or the read answered `404`/`403`, or the route segment was
 *      unusable. {@link ResolutionFailure} with `isDefinitive`.
 *   4. **Unreachable.** Some other failure. {@link ResolutionFailure} without it, so a retry is offered.
 *
 * ### One mount point for the editor, which is what protects the author's edits
 *
 * Once the editor has mounted it must NEVER unmount, because unmounting destroys the work in progress:
 * the form state lives inside `PostEditor`'s own `react-hook-form` instance, so a remount silently
 * discards every edit with no warning and no undo. On the create page that costs a draft; here it costs
 * changes to a post that already exists, which is worse, because the author has no way to tell what they
 * had changed. Three mechanisms guarantee it, and all three are load-bearing:
 *
 * **1. A cache key that cannot change.** `[scope, account, postId]` is fixed for the life of the route,
 * so `data` can never revert to `undefined` once the post has arrived - React Query keeps `data` across
 * a refetch of the same key. This is the whole reason {@link loadPostForId} resolves the slug INSIDE one
 * query function instead of the slug becoming part of a second query's key: with a varying key, any
 * change would blank `data` for one render and take the form with it. The guarantee is structural rather
 * than defended by a pinned copy.
 *
 * **2. `isFetched` for the taxonomy, never `isPending`.** This one was found by driving the create page
 * in a real browser rather than by reading the library:
 *
 * ```js
 * // @tanstack/query-core, fetchState() - applied on every fetch, including a refetch
 * { fetchStatus: 'fetching', ...(data === undefined && { error: null, status: 'pending' }) }
 * ```
 *
 * For a query that has ONLY ever errored, `data` is `undefined`, so a `refetch()` resets `status` back to
 * `'pending'` and `error` back to `null`. An `isPending` guard is therefore re-entered on every retry -
 * it is emphatically NOT "true only before the first settlement". `isFetched` is the monotonic answer the
 * library already exposes: `dataUpdateCount + errorUpdateCount > 0`, over two counters that are only ever
 * incremented and are never reset by a refetch.
 *
 * **3. The resolved branch is tested FIRST, and the failure branch is gated on there being no post.** A
 * background refetch that fails AFTER the post arrived must not replace a form full of unsaved edits
 * with an error panel. Before the post arrives a failure is the most useful thing to show; after it, the
 * toast is the whole report.
 *
 * ### The reads
 *
 * Two queries. Neither restates a tier default: only `queryKey`, `queryFn`, `enabled` and - on the
 * resolution, for the reason given at its call site - `refetchOnMount` are passed. The window
 * (`staleTime`, `gcTime`), the focus behaviour (`refetchOnWindowFocus: false`) and the retry predicate -
 * which refuses to retry a `4xx`, narrowing with `isApiError` - all belong to
 * `src/providers/query-provider.tsx` and are inherited by every call site. Restating any of them here
 * would create a second place for the tier's caching policy to live. React Query's `signal` is forwarded
 * from both so a navigation away mid-read cancels the request rather than resolving into a cache nobody
 * is reading.
 *
 * ### No component state at all
 *
 * Worth stating because it is unusual for a screen this stateful-looking: there is no `useState` here.
 * Every branch below is derived from the two queries, and the form state that a reader might expect to
 * find lives inside `PostEditor` where it belongs. That is not minimalism for its own sake - it is what
 * `react-hooks/set-state-in-effect` is pointing at, and following it is what produced the stable cache
 * key in mechanism 1.
 *
 * @returns The editor, the placeholder that precedes it, or the panel explaining why neither can be
 * shown.
 */
export default function EditPostPage(): JSX.Element {
  // Throws only when `AuthProvider` is missing - a wiring defect, and deliberately loud. A `null` user
  // inside a live provider is an ordinary state, and the one the optional access below is for.
  const { user } = useAuth();

  /*
   * The route's identifier, and the optional hint.
   *
   * `useParams()` rather than the promise-shaped `params` prop, which is the cleaner read from inside a
   * client module: awaiting a promise during render would need `use()` and a Suspense boundary this page
   * does not otherwise want. Both values go through {@link singleParam}, which refuses an array and a
   * blank string rather than casting either into a key.
   */
  const params = useParams();
  const searchParams = useSearchParams();

  const postId = singleParam(params[ID_PARAM]);
  const slugHint = singleParam(searchParams.get(SLUG_HINT_PARAM));

  /** `undefined` for exactly as long as the session is unresolved: the key's account member and the gate. */
  const account = user?.username;

  /* -----------------------------------------------------------------------------------------------
   * The resolution: identifier -> slug -> full post, in one query
   * -------------------------------------------------------------------------------------------- */
  const {
    data: post,
    error: loadError,
    isFetching: isLoadFetching,
    refetch: refetchPost,
  } = useQuery({
    // Two conditions, both necessary. No account means the workspace walk inside `loadPostForId` would
    // be a `401` rather than a quiet fall back to the public feed. No identifier means there is nothing
    // to look for, and the not-found panel is the honest answer without spending a request on it.
    enabled: account !== undefined && postId !== undefined,
    queryFn: ({ signal }): Promise<PostDetail | null> => {
      if (postId === undefined) {
        // Unreachable while `enabled` holds. Thrown rather than asserted away with `!`, so that an edit
        // which later loosens the gate fails loudly here instead of walking a workspace looking for the
        // string "undefined".
        throw new Error('loadPostForId requires the route identifier, which was not present.');
      }

      return loadPostForId(postId, slugHint, signal);
    },
    /*
     * `slugHint` is deliberately NOT in the key, and that is a decision rather than an omission.
     *
     * The key names the QUESTION - "which post does this identifier name, for this account" - and the
     * hint cannot change the answer to it: a hint that resolves to a different post is discarded inside
     * the query function, so `/posts/x/edit` and `/posts/x/edit?slug=y` are guaranteed to produce the
     * same post. Including it would split one answer across two cache entries and re-resolve on a
     * navigation that merely dropped the query string. `account` IS in the key, because it genuinely
     * changes the answer: the walk is scoped to the caller, and two accounts must never read each
     * other's resolution from one entry.
     */
    queryKey: [RESOLUTION_QUERY_SCOPE, account, postId],
    /*
     * The ONE option this call site sets beyond the key, the function and the gate, and it is not a
     * restatement of a tier default: `@/providers/query-provider` leaves `refetchOnMount` unset.
     *
     * It is set because of where an author arrives from and what they do next. The editor saves,
     * publishes, unpublishes and deletes, then navigates away; coming back inside the tier's stale
     * window would seed the form from the pre-edit content and an unwitting save would write it back
     * over the newer version. This renders the cached post immediately, exactly as before, and corrects
     * it in the background - and because the key never changes, that correction cannot unmount the form.
     */
    refetchOnMount: 'always',
  });

  /* -----------------------------------------------------------------------------------------------
   * The taxonomy
   * -------------------------------------------------------------------------------------------- */
  const {
    data: categories,
    error: categoriesError,
    isFetched: isCategoriesFetched,
    isFetching: isCategoriesFetching,
    refetch: refetchCategories,
  } = useQuery({
    // Ungated: the category list is public, needs no principal and no slug, so it travels in parallel
    // with the resolution above rather than behind it. By the time the post arrives it is usually here.
    queryFn: ({ signal }): Promise<CategoryPublic[]> => listCategories({ signal }),
    queryKey: CATEGORIES_QUERY_KEY,
  });

  /**
   * A refusal, not a failure: absent, deleted, another author's, or an unusable address.
   *
   * `post === null` is the resolution's own "there is no such post for you" answer - distinct from
   * `undefined`, which means it has not answered yet. Conflating the two would render the not-found
   * panel for one beat on every single visit.
   */
  const isDefinitivelyUnavailable =
    postId === undefined || post === null || isMissingOrForbidden(loadError);

  /** A failure that retrying could plausibly fix. */
  const hasTransientFailure = loadError !== null && !isMissingOrForbidden(loadError);

  /*
   * The toast half of the load-failure report, raised from an effect rather than from render.
   *
   * React Query 5 removed the per-query `onError` callback, and a `toast()` raised during render would be
   * a side effect in a render pass - which React may run twice in development and may discard entirely
   * under concurrent rendering, producing either a doubled notification or none at all. An effect keyed
   * on the error object runs exactly once per distinct failure.
   *
   * Only genuine failures are announced. A `404` is an ANSWER, and the panel below states it in large
   * type; a toast repeating it would be noise on a screen that is already entirely about it.
   */
  useEffect(() => {
    if (loadError === null || isMissingOrForbidden(loadError)) {
      return;
    }

    toast.error(LOAD_TOAST_TITLE, {
      description: failureDetail(loadError),
      id: LOAD_TOAST_ID,
    });
  }, [loadError]);

  /* The same treatment for the taxonomy, under its own toast identity so the two never replace each
   * other. This one is a companion to {@link TaxonomyNotice} rather than a substitute for it: a toast
   * dismisses itself, so an author who looked away would otherwise have no idea why the category picker
   * is empty. */
  useEffect(() => {
    if (categoriesError === null) {
      return;
    }

    toast.error(TAXONOMY_TOAST_TITLE, {
      description: failureDetail(categoriesError),
      id: TAXONOMY_TOAST_ID,
    });
  }, [categoriesError]);

  /* -----------------------------------------------------------------------------------------------
   * 1. Resolved - the editor, with or without the taxonomy notice above it
   *
   * FIRST, so that once this branch is reachable nothing below can take precedence over it - which is
   * mechanism 3: a background refetch that fails after the post arrived is reported by its toast and
   * must never replace a form holding unsaved edits. From here the editor is mounted and STAYS mounted
   * for the life of the route, because neither half of this condition can regress: the query key is
   * fixed so `post` keeps its value across every refetch, and `isCategoriesFetched` is monotonic.
   *
   * Both `undefined` and `null` are excluded explicitly rather than with a loose `!= null`, so the
   * three-valued read stays visible at the point where it is consumed.
   * -------------------------------------------------------------------------------------------- */
  if (post !== undefined && post !== null && isCategoriesFetched) {
    return (
      <div className={PAGE_STACK}>
        <PageHeading />

        {/* A stable sibling slot: `null` once a taxonomy has been read, the notice until then. Holding
            the position is what keeps the editor below from being remounted - React reconciles children
            by position, so a notice that appeared and disappeared as a sibling rather than as a `null`
            would shift the editor's index and remount it.

            Keyed on `data`, NOT on `error`: a refetch resets `error` to `null` while `data` is
            undefined, so keying on `error` would hide this notice - and the "Try again" button inside it
            - for the whole duration of the retry it exists to report. It also gives the right answer in
            the opposite case: if a later background refetch fails after an earlier success, `data` still
            holds the last good taxonomy, so the picker stays usable and no "unavailable" notice
            contradicts the list on screen. */}
        {categories !== undefined ? null : (
          <TaxonomyNotice
            isRetrying={isCategoriesFetching}
            onRetry={() => {
              void refetchCategories();
            }}
          />
        )}

        {/*
         * `mode="edit"` with the pinned post. `PostEditorProps` is a discriminated union whose edit arm
         * types `post` as REQUIRED, so this call site could not compile without a real `PostDetail` -
         * which is the compiler enforcing "never mount the editor with no post" rather than this comment
         * asking for it.
         *
         * Everything the editor does from here is the editor's: the five-key `PostUpdate` patch
         * (`title`, `excerpt`, `content`, `cover_image_url`, `category_ids` - never `id`, `slug`,
         * `status`, `published_at`, `view_count` or `author_id`), the resolver over `postUpdateSchema`,
         * the Markdown preview through `PostContent`, the delete confirmation, the publish and unpublish
         * transitions, and the navigation that follows each. This page adds nothing to it and races
         * nothing after it.
         */}
        <PostEditor categories={categories ?? NO_CATEGORIES} mode="edit" post={post} />
      </div>
    );
  }

  /* -----------------------------------------------------------------------------------------------
   * 2 and 3. Nothing to edit - absent, or unreachable
   *
   * Reached only when branch 1 did not apply. The `post === undefined || post === null` guard is what
   * keeps a post that HAS arrived - but whose taxonomy has not settled yet - in the placeholder rather
   * than behind an error panel it has already outgrown.
   * -------------------------------------------------------------------------------------------- */
  if ((post === undefined || post === null) && (isDefinitivelyUnavailable || hasTransientFailure)) {
    return (
      <div className={PAGE_STACK}>
        <PageHeading />
        <ResolutionFailure
          isDefinitive={isDefinitivelyUnavailable}
          isRetrying={isLoadFetching}
          onRetry={() => {
            // `void`: `refetch` resolves to a result object this page has no use for, and every state
            // that matters - `isFetching`, then `data` or `error` - arrives through the hook. Awaiting
            // it would add a floating promise for no benefit. One call re-runs the WHOLE resolution,
            // hint included, which is the third benefit of folding it into one query function.
            void refetchPost();
          }}
        />
      </div>
    );
  }

  /* -----------------------------------------------------------------------------------------------
   * 4. Still resolving
   *
   * The walk, the read, or the taxonomy is in flight - or the session has not resolved yet, in which
   * case the layout above is showing its own chrome and this is what sits inside it. The heading renders
   * here too, so the `h1` is present from the first paint and the document outline is never momentarily
   * headless.
   * -------------------------------------------------------------------------------------------- */
  return (
    <div className={PAGE_STACK}>
      <PageHeading />
      <EditorPlaceholder />
    </div>
  );
}
