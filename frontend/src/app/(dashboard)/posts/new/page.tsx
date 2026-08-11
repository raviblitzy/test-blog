'use client';

/* =================================================================================================
 * `/posts/new` - the empty post editor.
 *
 * The CREATE half of requirement R2, "create, edit, delete, and publish blog posts". Its sibling
 * `(dashboard)/posts/[id]/edit/page.tsx` carries the edit half, and both mount the same
 * `@/components/blog/post-editor`, which is where every rule about authoring actually lives. This
 * file is the ROUTE: it decides what URL the editor answers on, what the reader is told while the
 * taxonomy is still arriving, what happens when the taxonomy never arrives, and what the page's one
 * heading says. It decides nothing else, and that narrowness is the design rather than an omission.
 *
 * -------------------------------------------------------------------------------------------------
 * THE URL IS `/posts/new`, NOT `/dashboard/posts/new`
 *
 * `(dashboard)` is parenthesised, so Next.js ERASES it from the URL. `posts` is a SIBLING of
 * `dashboard` inside the group rather than a child of it, so this segment answers on `/posts/new`.
 * Three files already in the tree agree, independently of one another and of this comment:
 *
 *   - `src/middleware.ts` gates '/dashboard/:path*' and '/posts/:path*' as two SEPARATE matcher
 *     entries, and its own note says "`(dashboard)/posts/new/` serves /posts/new";
 *   - `src/app/robots.ts` keeps '/dashboard', '/posts' and '/admin' out of every index while leaving
 *     '/blog/*' crawlable;
 *   - `src/app/(dashboard)/layout.tsx` links this page as the literal '/posts/new'.
 *
 * A navigation built from the group name - '/dashboard/posts/new' - compiles, type-checks, lints and
 * renders. It fails only at run time, as a 404 the author meets immediately after being told their
 * draft was saved. So: no `dashboard/` directory is nested inside `(dashboard)/posts/`, and this file
 * does not move.
 *
 * The two URL families are never crossed. `/posts/*` is the protected AUTHORING family; `/blog/{slug}`
 * is the public POST-DETAIL family. Nothing here builds a `/posts/*` address for a reader, and nothing
 * here points an authoring action at a `/blog` address - the canonical URL a draft will eventually
 * live at is displayed by the editor itself, read-only, from the slug the service derived.
 *
 * -------------------------------------------------------------------------------------------------
 * WHAT THIS FILE OWNS - THE COMPLETE LIST
 *
 *   1. The client boundary. `'use client'`, because the taxonomy read below is a `useQuery` and the
 *      editor beneath it is an interactive island.
 *   2. The route's single `h1`. Every heading the editor renders is an `h2` or lower, so the document
 *      outline is correct only if this page supplies the `h1` - and supplies exactly one.
 *   3. The taxonomy read, and the three states it can be in: arriving, arrived, unreachable.
 *   4. The vertical rhythm of the page, and nothing about its width. See {@link PAGE_STACK}.
 *   5. One way back to the workspace listing.
 *
 * Everything else belongs to a module that already owns it:
 *
 *   - `src/app/layout.tsx` owns the document, the stylesheet, ThemeProvider -> QueryProvider ->
 *     AuthProvider and the single sonner `<Toaster />`. So there is no `<html>`, `<body>`, `<header>`,
 *     `<main>` or `<footer>` here, no stylesheet import, no remounted provider and no second Toaster.
 *   - `src/app/(dashboard)/layout.tsx` owns the workspace chrome, the gutter, the measure AND all
 *     three session states. Its `children` contract is explicit that a page is "Rendered ONLY once a
 *     principal is known", which is why this file never calls `useAuth()` - see the note on
 *     {@link NewPostPage}.
 *   - `src/app/{loading,error,not-found}.tsx` at the App Router root bound this segment already, which
 *     is why there is no `loading.tsx`, `error.tsx` or local error boundary beside this file.
 *   - `src/components/blog/post-editor.tsx` owns the form, its validation, its preview and every
 *     mutation - `createPost`, `updatePost`, `deletePost`, `publishPost`, `unpublishPost` - plus the
 *     navigation that follows a successful create. NONE of that is reproduced here, and this page
 *     issues no second navigation to race it.
 *
 * There is also no `metadata` or `generateMetadata` export. Next.js forbids one from a module carrying
 * `'use client'`, and `src/app/robots.ts` already keeps this route out of every index, so the absence
 * costs nothing: there is no crawler to write metadata for.
 *
 * -------------------------------------------------------------------------------------------------
 * GOVERNING STANDARDS
 *
 * `review_rules` reports NO user-specified rules for this project - a complete answer, not a truncated
 * one - so nothing here is invented to satisfy one, and their absence is not licence to lower the bar.
 * The binding constraints are AAP §0.10.1's own enterprise standards and AAP §0.8.5's design-system
 * rules:
 *
 *   Layered separation       A page delegates. This one owns a heading, a read and three states.
 *   Explicit API contracts   `listCategories()` answers with a BARE array - the API's single
 *       documented exception to the page envelope. Nothing here reads `.items` off it.
 *   API versioning           No path and no `/api/v1` prefix is written here; the read goes through
 *       `@/lib/api/categories`, and `@/lib/api/client` composes the version segment exactly once.
 *   Server-owned identity    No identifier and no slug is constructed, sent or displayed here.
 *   Secure-by-default auth   The `(dashboard)` group and `src/middleware.ts` gate ARRIVAL, which is
 *       user experience. Authority is re-decided server-side by `post_service.py` on every mutation.
 *       Nothing here reads, decodes or verifies a token.
 *   Zero hardcoded values    Every class resolves to a token declared in `src/app/globals.css` or to
 *       a step on the token engine's own scale. No hex value, no literal dimension, no inline
 *       `style`, no arbitrary-value bracket utility, no bespoke media query.
 *   Semantic tokens only     `border`, `foreground`, `muted-foreground` and `surface-muted` are
 *       referenced by name; no primitive colour family or shade appears. `globals.css` is the only
 *       file permitted to map semantic onto primitive, which is exactly what makes dark mode
 *       automatic here: this file carries no `dark:` utility and no theme conditional at all.
 *   Project primitives       Every control is `Button`, `Alert` or `Skeleton` from
 *       `@/components/ui/*`. No raw `<button>` and no hand-styled `<a>`; the back link is
 *       `<Button asChild>` over `next/link`, so it renders as a real anchor with the button's own
 *       focus ring.
 *   One breakpoint vocabulary  `lg` only - `lg:grid-cols-2` and `lg:col-span-2`, one of the engine's
 *       five. Everything else here is fluid. No `@media` query, and no breakpoint invented.
 *   Accessibility as a floor One `h1`; the loading region named once rather than per placeholder; a
 *       visible `:focus-visible` ring inherited from the button primitive; and no authored `role` or
 *       `aria-live` on `Alert`, whose announcement behaviour is derived from its variant.
 *   Config from the environment  This file reads no environment variable, not even a `NEXT_PUBLIC_*`
 *       one. `@/lib/api/client` and `@/lib/seo` are the tier's only sanctioned readers.
 *   Legacy retirement        Nothing here references an `/items` path, an `Item` type or the
 *       `id`/`name`/`price` triple that `app.py` defined. That surface is superseded, not wrapped.
 *
 * -------------------------------------------------------------------------------------------------
 * DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT HERE.
 *
 *   1. `useAuth()`. See {@link NewPostPage}.
 *   2. A signed-out panel, or a session placeholder. Both already render one level up, and a second
 *      copy would double-render for every visitor who has not signed in.
 *   3. A status select, a "published" checkbox or a publish button. Publishing is a first-class state
 *      TRANSITION - `POST /posts/{id}/publish`, which stamps `published_at` under a database `CHECK`
 *      constraint - never a form field. The editor owns both transitions.
 *   4. A `router.push`, `redirect` or `revalidate` after a create. The editor navigates itself; a
 *      second navigation in flight produces a visible flicker or loses the destination outright.
 *   5. A `zodResolver`, `postCreateSchema` or any import from `@/lib/validation/post`. That module's
 *      own header names this page among its consumers "through `zodResolver`", which OVER-CLAIMS: the
 *      editor owns every resolver in the tier. An unused import here would fail `--max-warnings=0`
 *      anyway, so the over-claim and the lint gate point the same way.
 *   6. A `fetch` call, a hand-written path, or a `react-markdown` import. `@/lib/api/client` is the
 *      tier's only HTTP module and `@/components/blog/post-content` is its only Markdown renderer.
 *   7. A file input. Cover images are URL references; upload, image processing and object storage are
 *      out of scope, and the editor's URL field is the whole affordance.
 *   8. A `Card` around the loading placeholder. The editor is a bare `<form>`, not a card, so card
 *      chrome in the placeholder would appear for one beat and then vanish - the precise flash the
 *      placeholder exists to prevent. See {@link TaxonomyPlaceholder}.
 * ============================================================================================== */

import Link from 'next/link';
import type { JSX } from 'react';
import { useEffect } from 'react';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CloudOff, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { PostEditor } from '@/components/blog/post-editor';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { listCategories } from '@/lib/api/categories';
import { isApiError } from '@/lib/api/client';
import type { CategoryPublic } from '@/lib/types';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Addresses
 *
 * A literal, spelled beside the note at the top of this file that explains why the URLs in this group
 * are not what the directory layout suggests. `src/app/(dashboard)/layout.tsx` - the shell this page
 * renders inside - declares the same address the same way, for the same reason, and
 * `src/lib/routes.ts` names it for call sites that compose addresses dynamically. If this address ever
 * moves, all three change in the same commit.
 * ---------------------------------------------------------------------------------------------- */

/** The workspace listing: the author's own posts, grouped by lifecycle state. */
const DASHBOARD_PATH = '/dashboard';

/* -------------------------------------------------------------------------------------------------
 * Cache identity
 * ---------------------------------------------------------------------------------------------- */

/**
 * Cache key for the public taxonomy.
 *
 * `[scope]` and nothing else, which is the shape the endpoint dictates rather than a shortening:
 * `GET /api/v1/categories` takes no window, no filter and no sort, so there is no argument to fold in
 * and no second variant of this entry that could exist. Compare `@/lib/admin-cache`'s
 * `[ADMIN_SCOPE, 'categories']`, which is deliberately a DIFFERENT key - that one addresses the
 * administrative projection behind an administrator's credential, and sharing one entry between the
 * two would let an authored read populate a cache an anonymous read then serves from.
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
 * Never mutated. `PostEditor` only reads it - `categories.filter(...)` and `categories.length === 0` -
 * and its length-zero branch renders "No categories exist yet, so this post cannot be filed under
 * one", which is exactly the honest thing to say when the taxonomy is unreachable.
 */
const NO_CATEGORIES: CategoryPublic[] = [];

/* -------------------------------------------------------------------------------------------------
 * Copy
 *
 * Named constants rather than inline strings, so the wording is reviewable in one place and a test or
 * an end-to-end journey can assert on the same value the component renders. The heading and the two
 * link labels are accessible names, which makes them contracts rather than decoration.
 * ---------------------------------------------------------------------------------------------- */

/** The route's one `h1`. Also what `frontend/tests/e2e/authoring.spec.ts` looks for on arrival. */
const PAGE_HEADING = 'New post';

/**
 * The heading's supporting line.
 *
 * States the lifecycle plainly, because it is the one thing about this screen that surprises authors:
 * saving does not publish. A post is created as a `DRAFT` and stays invisible to readers until the
 * publish transition runs, which is a property of the service - `CHECK (status <> 'PUBLISHED' OR
 * published_at IS NOT NULL)` - rather than of this page.
 */
const PAGE_LEDE =
  'Write your draft, then publish it when you are ready. Nothing you save here appears on the blog ' +
  'until you publish it.';

/** Label of the link back to the workspace listing. */
const BACK_LABEL = 'Your posts';

/** Announced once, politely, while the taxonomy is still arriving. */
const LOADING_LABEL = 'Loading the editor';

/** Title of the notice shown when the taxonomy could not be read. */
const TAXONOMY_NOTICE_TITLE = 'Categories are unavailable right now';

/**
 * Body of that notice.
 *
 * Says what is missing, what still works, and what to do - in that order. It deliberately does not
 * suggest the draft is at risk, because it is not: only the category list failed, and every other
 * field, the preview, saving and publishing are all unaffected.
 */
const TAXONOMY_NOTICE_DETAIL =
  'The category list could not be loaded, so this post cannot be filed under one yet. Everything ' +
  'else works normally - write and save your draft, then add categories once the list loads.';

/** Label of the notice's retry action, and its accessible name. */
const RETRY_LABEL = 'Try again';

/** Label the retry action shows while a retry is on the wire. */
const RETRY_PENDING_LABEL = 'Retrying';

/** Toast headline for the same failure. Short, because a toast is glanced at rather than read. */
const TAXONOMY_TOAST_TITLE = 'Could not load categories';

/**
 * Identity of that toast.
 *
 * A stable id makes sonner REPLACE the existing notification rather than stack another one, so a
 * reader who presses "Try again" three times sees one toast update three times instead of collecting
 * three identical toasts.
 */
const TAXONOMY_TOAST_ID = 'new-post-categories';

/**
 * What the toast says when the failure carries no message a person can act on.
 *
 * Reached for a rejection that is not an `ApiError` - a bug in the query function, say - where the
 * underlying message is a developer artefact rather than something an author should be shown.
 */
const GENERIC_FAILURE_DETAIL =
  'Something went wrong while loading the category list. Your draft is not affected.';

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
 * `gap-8` matches the editor's own internal rhythm, so the heading block, the notice and the form read
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
 * placeholder occupies the shape the real form will, so nothing jumps sideways when the taxonomy
 * arrives. Nothing changes at 48rem, because that breakpoint belongs to the editor's action bar.
 */
const PLACEHOLDER_COLUMNS = 'grid min-w-0 grid-cols-1 gap-8 lg:grid-cols-2';

/** The fields column, and the preview column, both matching the editor's own stacks. */
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
 * Reduce a rejection to one sentence an author can act on.
 *
 * `ApiError.message` is {@link https://www.rfc-editor.org/rfc/rfc9457 | problem+json}'s `detail`,
 * which the service writes to be safe to show to a person, and `@/lib/api/client` guarantees the shape
 * for the cases the service cannot speak for - an unreachable host, a gateway that answered with HTML,
 * a signal that fired first. So the normalised message is exactly the right thing to surface.
 *
 * What is deliberately NOT surfaced: `error.stack`, `problem.type`, `problem.instance`, the status code
 * and the correlation identifier. Every one is a diagnostic rather than an instruction, and a notice
 * that reads like a stack trace teaches an author to dismiss notices unread.
 *
 * @param error - The rejection react-query recorded, typed as `Error` because that is what the tier's
 * default error type is. Narrowed here rather than asserted.
 * @returns A non-empty sentence. Never returns the empty string, so the notice it fills cannot render
 * blank.
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

/* -------------------------------------------------------------------------------------------------
 * Presentation
 * ---------------------------------------------------------------------------------------------- */

/**
 * The heading block.
 *
 * The route's single `h1`, its supporting line, and one way back to the workspace listing. The back
 * link is `<Button asChild>` wrapping `next/link`: `asChild` composes `@radix-ui/react-slot`, so the
 * rendered element is a real anchor - crawlable, middle-clickable, and carrying the button primitive's
 * own `:focus-visible` ring - rather than a `<button>` that calls `router.push`, and rather than a
 * hand-styled `<a>` that `@next/next/no-html-link-for-pages` would reject.
 *
 * `ghost` and `sm`, because this is a secondary affordance sitting under a heading; the editor's own
 * save and publish actions are the page's primary controls and must stay visually dominant.
 *
 * @returns The heading block. Rendered by both branches of {@link NewPostPage}, which is what keeps
 * the `h1` present while the taxonomy is still arriving.
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
 * What stands where the editor will, while the taxonomy is still arriving.
 *
 * ### Why a placeholder rather than the editor with a half-filled picker
 *
 * `PostEditorProps.categories` is REQUIRED, and its length-zero branch says "No categories exist yet",
 * which is a statement about the blog rather than about the network. Mounting the editor before the
 * answer arrives would therefore tell the author something false and then silently correct itself - and
 * an author who read the false version has already decided not to file the post under anything. A
 * placeholder makes no claim at all, which is the honest thing to render while nothing is known.
 *
 * ### Why it mirrors the editor's geometry instead of being a single grey block
 *
 * Every class here is the editor's own, copied verbatim from
 * `src/components/blog/post-editor.tsx`: the `lg:grid-cols-2` spine, the `gap-6` field stack, the
 * `gap-2` field, the `h-11` control height that `@/components/ui/input` sets, the `min-h-24` textarea
 * floor, and the `border-t` action rule. So the real form lands in the space its placeholder was
 * already occupying and nothing jumps when it does. `src/app/(dashboard)/layout.tsx` reaches for the
 * same technique one level up, sharing its four geometry constants between its loading branch and its
 * resolved chrome for exactly this reason.
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
function TaxonomyPlaceholder(): JSX.Element {
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

        {/* The category toggles - the one field this whole placeholder is waiting on. Three chips at
            the `sm` button height, `flex-wrap` so they never widen the document. */}
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
          foot of the fields. `lg:col-span-2` is the only class here the editor does not itself carry,
          because the editor's bar is a sibling of the grid while this one lives inside it. */}
      <div className={cn(PLACEHOLDER_ACTIONS, 'lg:col-span-2')}>
        <Skeleton className="h-11 w-32 rounded-md" />
        <Skeleton className="h-11 w-28 rounded-md" />
      </div>
    </div>
  );
}

/** Props of {@link TaxonomyNotice}. */
interface TaxonomyNoticeProps {
  /** Whether a retry is currently on the wire. Drives the label and disables the control. */
  readonly isRetrying: boolean;
  /** Ask for the taxonomy again. Supplied by {@link NewPostPage} from react-query's `refetch`. */
  readonly onRetry: () => void;
}

/**
 * The notice shown when the taxonomy could not be read.
 *
 * ### It explains a degradation, it does not block anything
 *
 * A taxonomy outage must never stop an author writing. The editor renders beneath this notice with an
 * empty category list, every other field works, and saving and publishing are untouched - only the
 * ability to FILE the post is lost, and only until the list loads. That is why the copy leads with what
 * still works.
 *
 * ### Why `warning` and not `destructive`
 *
 * `@/components/ui/alert` derives its announcement from its variant: `destructive` carries
 * `role="alert"`, which is assertive and interrupts whatever a screen reader is saying, while `warning`
 * carries `role="status"`, which is polite and announced once the reader is idle. Interrupting an
 * author mid-sentence to report that an optional field is temporarily unavailable is the wrong
 * priority, so `warning` is the accurate tone as well as the kinder one.
 *
 * No `role` and no `aria-live` is authored here. Both would fight the variant - `role="status"` already
 * implies `aria-live="polite"`, and restating it risks a double announcement.
 *
 * The leading glyph is `aria-hidden`: the title beside it already carries the meaning, so an announced
 * icon would only repeat it. Its size comes from the alert primitive's own rule for a first-child
 * `svg`, so no dimension is written here.
 *
 * @param isRetrying - See {@link TaxonomyNoticeProps.isRetrying}.
 * @param onRetry - See {@link TaxonomyNoticeProps.onRetry}.
 * @returns The notice, with its retry action.
 */
function TaxonomyNotice({ isRetrying, onRetry }: TaxonomyNoticeProps): JSX.Element {
  return (
    <Alert variant="warning">
      <CloudOff aria-hidden="true" />

      {/* `as="h2"` because this page's `h1` is the route heading and the alert primitive's default is a
          non-heading `div`. An `h2` puts the notice into the document outline at the right depth, above
          the editor's own `h2` for the preview. */}
      <AlertTitle as="h2">{TAXONOMY_NOTICE_TITLE}</AlertTitle>

      <AlertDescription>{TAXONOMY_NOTICE_DETAIL}</AlertDescription>

      {/* `secondary`, so the retry is clearly actionable without competing with the editor's own save
          and publish controls. `mt-3` is a `--spacing` step.

          `justify-self-start`, NOT `self-start`. `Alert` is a `grid` container, so a grid item's
          `self-start` resolves to `align-self` - the BLOCK axis - which does nothing to a row that is
          already content-height, and leaves the button stretched full-bleed across the notice.
          Constraining the INLINE axis in a grid needs `justify-self`. (The back link in
          {@link PageHeading} correctly uses `self-start`, because its parent is a COLUMN flex
          container, where the cross axis is the inline one.) Measured in a browser at 1440px, not
          reasoned about: `self-start` alone left the control full width. */}
      <Button
        className="mt-3 justify-self-start"
        disabled={isRetrying}
        onClick={onRetry}
        size="sm"
        type="button"
        variant="secondary"
      >
        {/* `motion-safe:` so the spin is suppressed for a reader who has asked for reduced motion,
            matching how the editor animates its own pending states. `undefined` rather than `''` when
            it is at rest, so the icon carries no empty `class` attribute. */}
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
 * The empty post editor, at `/posts/new`.
 *
 * ### Why `useAuth()` is never called here
 *
 * `src/app/(dashboard)/layout.tsx` decides the session for this whole group, and its `children`
 * contract is explicit: a page is "Rendered ONLY once a principal is known, so those pages may assume a
 * session rather than each re-deriving one." Its four branches cover the placeholder, the workspace, an
 * unconfirmed session and a signed-out visitor. So reading the principal here would buy nothing, a
 * second signed-out panel would double-render for every anonymous visitor, and an unused binding would
 * fail `eslint --max-warnings=0` outright.
 *
 * That is not a claim that the middleware guarantees a session. `src/middleware.ts` runs on the Edge
 * runtime and cannot verify a JWT signature - `JWT_SECRET_KEY` is backend-only - so it deliberately
 * admits an expired-but-refreshable token. It is defence in depth, and the layout is what actually
 * handles the outcome.
 *
 * ### One mount point for the editor, which is what protects the draft
 *
 * Once the editor has mounted it must NEVER unmount, because unmounting it destroys the author's
 * in-progress draft: the form state lives inside `PostEditor`'s own `react-hook-form` instance, so a
 * remount silently returns an empty Title and an empty Content with no warning and no undo. Two
 * separate mechanisms are needed to guarantee that, and BOTH are load-bearing.
 *
 * **1. A stable sibling slot.** The editor is rendered from exactly ONE place below, at a fixed
 * position among its siblings. React reconciles children by position, so rendering it once in a failure
 * branch and again in a success branch would put it at two different positions and a retry that finally
 * succeeded would remount it. Writing the notice as `condition ? <TaxonomyNotice/> : null` holds the
 * slot open whether or not there is anything to say, so the editor's index never shifts.
 *
 * **2. A branch condition that cannot regress - `isFetched`, never `isPending`.** This is the subtle
 * one, and it was found by driving the page in a real browser rather than by reading the library:
 *
 * ```js
 * // @tanstack/query-core, fetchState() - applied on every fetch, including a refetch
 * { fetchStatus: 'fetching', ...(data === undefined && { error: null, status: 'pending' }) }
 * ```
 *
 * For a query that has ONLY ever errored, `data` is `undefined`, so a `refetch()` resets `status` back
 * to `'pending'` and `error` back to `null`. An `if (isPending)` guard is therefore re-entered on every
 * retry - it is emphatically NOT "true only before the first settlement" - which unmounted the editor
 * for the ~3s the tier's two backoff attempts take, and threw the draft away. Reproduced in Chrome and
 * proven by node identity: every pre-click field reported `isConnected: false` afterwards.
 *
 * `isFetched` is the monotonic answer the library already exposes:
 * `dataUpdateCount + errorUpdateCount > 0`, over two counters that are only ever incremented and are
 * never reset by a refetch. It flips false to true once, at the first settlement, and stays true.
 *
 * For the same reason the notice is driven by `data === undefined` rather than by `error !== null`.
 * After the first settlement a never-successful read keeps `data` undefined through every retry, so the
 * notice - and its "Try again" button - stay on screen and can report `isFetching` as "Retrying".
 * Keying on `error` would have made both vanish for the duration of the very retry they exist to
 * report. It also gives the right answer in the opposite case: if a later background refetch fails
 * after an earlier success, `data` still holds the last good taxonomy, so the picker stays usable and
 * no "unavailable" notice contradicts the list on screen - the toast alone reports it.
 *
 * ### The read
 *
 * `listCategories()` answers with a BARE `CategoryPublic[]`. It is the single documented exception to
 * the page envelope across the whole API, because that list IS a filter control and a windowed one
 * would silently hide every post filed outside the window. There is no `.items` to unwrap - reading one
 * is both a type error and a contract violation - no `page` to pass and no `pages` to follow.
 *
 * Only `queryKey` and `queryFn` are passed. The window (`staleTime`, `gcTime`), the focus behaviour
 * (`refetchOnWindowFocus: false`) and the retry predicate - which refuses to retry a 4xx, narrowing
 * with `isApiError` - all belong to `src/providers/query-provider.tsx` and are inherited by every call
 * site. Restating any of them here would create a second place for the tier's caching policy to live.
 * React Query's `signal` is forwarded so a navigation away mid-read cancels the request rather than
 * resolving into a cache nobody is reading.
 *
 * @returns The editor, the placeholder that precedes it, or the editor plus the notice explaining why
 * its category picker is empty.
 */
export default function NewPostPage(): JSX.Element {
  const { data, error, isFetched, isFetching, refetch } = useQuery({
    queryFn: ({ signal }): Promise<CategoryPublic[]> => listCategories({ signal }),
    queryKey: CATEGORIES_QUERY_KEY,
  });

  /*
   * Report the failure once, from an effect rather than from render.
   *
   * React Query 5 removed the per-query `onError` callback, and a `toast()` raised during render would
   * be a side effect in a render pass - which React may run twice in development and may discard
   * entirely under concurrent rendering, producing either a doubled notification or none at all. An
   * effect keyed on the error object runs exactly once per distinct failure.
   *
   * The stable `id` is what makes a repeated failure REPLACE its predecessor instead of stacking:
   * three presses of "Try again" against a service that is still down update one toast three times.
   *
   * The toast is a companion to {@link TaxonomyNotice}, never a substitute for it. A toast dismisses
   * itself, so an author who looked away would otherwise have no idea why the category picker is empty;
   * the notice is the durable explanation and the toast is what draws the eye to it.
   */
  useEffect(() => {
    if (error === null) {
      return;
    }

    toast.error(TAXONOMY_TOAST_TITLE, {
      description: failureDetail(error),
      id: TAXONOMY_TOAST_ID,
    });
  }, [error]);

  /* -----------------------------------------------------------------------------------------------
   * 1. The taxonomy has not settled even once
   *
   * `isFetched`, NOT `isPending`. It is `dataUpdateCount + errorUpdateCount > 0` over two counters the
   * library only ever increments, so it flips once and never regresses - which is precisely what makes
   * this branch unreachable after the first settlement, and therefore what keeps a retry from
   * unmounting the editor and destroying the draft. See the "One mount point" note above for the
   * measurement that proved `isPending` regresses.
   *
   * The heading renders here too, so the `h1` is present from the first paint and the document outline
   * is never momentarily headless.
   * -------------------------------------------------------------------------------------------- */
  if (!isFetched) {
    return (
      <div className={PAGE_STACK}>
        <PageHeading />
        <TaxonomyPlaceholder />
      </div>
    );
  }

  /* -----------------------------------------------------------------------------------------------
   * 2. Settled at least once - the editor, with or without the notice above it
   *
   * From here the editor is mounted and STAYS mounted for the life of the route. `data` is the whole of
   * the failure handling it needs: on success the real taxonomy, and while the read has never succeeded
   * one stable empty array whose length-zero branch the editor already renders honestly. Nothing is
   * asserted, nothing is cast, and the author can write either way.
   * -------------------------------------------------------------------------------------------- */
  return (
    <div className={PAGE_STACK}>
      <PageHeading />

      {/* A stable sibling slot: `null` once a taxonomy has been read, the notice until then. Holding
          the position is what keeps the editor below from being remounted - see this component's
          "One mount point" note.

          Keyed on `data`, NOT on `error`: a refetch resets `error` to `null` while `data` is undefined,
          so keying on `error` would hide this notice - and the "Try again" button inside it - for the
          whole duration of the retry it exists to report. */}
      {data !== undefined ? null : (
        <TaxonomyNotice
          isRetrying={isFetching}
          onRetry={() => {
            // `void`: `refetch` resolves to a result object this page has no use for, and the state it
            // matters for - `isFetching`, then `data` or `error` - arrives through the hook. Awaiting
            // it would add a floating promise for no benefit; every outcome is already rendered.
            void refetch();
          }}
        />
      )}

      {/*
       * `mode="create"` and NO `post` prop. `PostEditorProps` is a discriminated union whose create
       * arm types `post` as `never`, so passing one does not compile - the contract is enforced by the
       * compiler rather than by this comment.
       *
       * Everything the editor does from here is the editor's: the five-key `PostCreate` body
       * (`title`, `excerpt`, `content`, `cover_image_url`, `category_ids` - never `id`, `slug`,
       * `status`, `published_at`, `view_count` or `author_id`), the resolver over `postCreateSchema`,
       * the Markdown preview through `PostContent`, the publish and unpublish transitions, and the
       * navigation that follows a successful create. This page adds nothing to it and races nothing
       * after it.
       */}
      <PostEditor categories={data ?? NO_CATEGORIES} mode="create" />
    </div>
  );
}
