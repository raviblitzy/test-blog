'use client';

// The administrative overview, rendered at /admin: four aggregate counts and nothing else.
//
// AAP §0.7.3.1 describes this screen in one line - "Admin overview | /admin | Client | Aggregate
// counts for users, posts, comments, and categories" - and it serves R11, "an admin dashboard for
// managing users, posts, comments, and categories". It is backed by exactly ONE endpoint,
// `GET /api/v1/admin/stats`, which answers a bare object of four totals rather than a page envelope.
// This file is therefore a pure consumer: it reads that object through a typed wrapper, hands each
// number to a tile, and renders the three states the read can be in.
//
// -------------------------------------------------------------------------------------------------
// THE URL CONTRACT
//
// `(admin)` is parenthesised, so Next.js ERASES it from every address beneath it, while `admin` is a
// real directory inside the group. This module is therefore `/admin` and the four screens it links to
// are `/admin/users`, `/admin/posts`, `/admin/comments` and `/admin/categories`. A path that keeps the
// parenthesised group name is not an address, it is a 404: `src/middleware.ts` gates `/admin/:path*`
// and `src/app/robots.ts` disallows `/admin`, both in the rendered form. No parenthesised path appears
// anywhere below - and none can, because every destination is read from `ADMIN_STAT_CARDS` in
// `src/components/admin/stat-card.tsx`, which is the single place those four addresses are declared.
//
// -------------------------------------------------------------------------------------------------
// THE CACHE KEY IS THE HIGHEST-RISK DETAIL IN THIS FILE
//
// `['admin', 'stats']` is not a local convention, it is an INVALIDATION TARGET. Every administrative
// deletion invalidates it in addition to its own entity prefix - a user, a post, a comment or a
// category removed on one of the four management screens has to move the total on this one -
// and `src/lib/admin-cache.ts` declares the same tuple as `ADMIN_STATS_QUERY_KEY` for those call
// sites to invalidate through. React Query hashes a key structurally rather than comparing it by
// reference, so the literal below and that constant are ONE cache entry.
//
// Get it wrong and there is no error to observe anywhere: the screen still renders, the request still
// succeeds, and the counts simply stop refreshing after a deletion. That is why {@link
// ADMIN_STATS_QUERY_KEY} is a named constant with this note attached rather than a tuple written
// inline at the call site.
//
// -------------------------------------------------------------------------------------------------
// WHAT THIS FILE MUST NOT EMIT, BECAUSE SOMETHING ABOVE IT ALREADY DOES
//
//   `<html>`, `<body>`, `<header>`, `<main>`, `<footer>`   `src/app/layout.tsx` owns the document and
//       every landmark. Only plain containers appear below.
//   A stylesheet import                                    `src/app/globals.css` is the tier's only
//       stylesheet and the root layout imports it once.
//   ThemeProvider, QueryProvider, AuthProvider             All three are mounted once in the root
//       layout. A second QueryProvider would create a second cache, and the row-action islands'
//       invalidations would then never reach this screen - the silent-stale-counts failure again.
//   A `<Toaster />`                                        The root layout hosts the only one. A
//       second would double every notification. This file calls `toast` and mounts nothing.
//   The section navigation                                 `(admin)/admin/layout.tsx` owns the
//       `<nav>`, the shell gutter, the measure and the vertical rhythm this page renders inside. The
//       tile links are the only navigation this file contributes.
//   The role gate                                          That layout resolves the real principal
//       and renders `{children}` only for an administrator. It is NOT re-implemented here - but the
//       service's own 403 IS still handled, because a client-side role read is user experience and
//       the server is the authority. See {@link describeFailure}.
//   A `metadata` object, or an export that generates one    Next.js forbids either from a module
//       carrying `'use client'`, and `src/app/robots.ts` keeps this group out of every index anyway,
//       so there is no discovery surface to serve.
//   `loading.tsx`, `error.tsx`, `not-found.tsx`, `template.tsx`   AAP §0.4.5.2 places those at
//       `src/app/` root and §0.7.1.9 places the only other missing-resource boundary at
//       `blog/[slug]/`. The pending and failed affordances are render states inside this file.
//
// -------------------------------------------------------------------------------------------------
// GOVERNING STANDARDS
//
// `review_rules` reports NO user-specified rules for this project - a complete response, not a
// truncated one - so nothing here is invented to satisfy one, and their absence is not licence to
// lower the bar. The binding constraints are AAP §0.10.1's own enterprise standards and AAP §0.8.5's
// design-system rules, which §0.8.5 makes binding on every file under `frontend/src/`:
//
//   Layered separation      A pure consumer. No transport, no address construction, no query string,
//       no authority decision and no arithmetic over the counts - the service's `admin_service.py`
//       composes all four in one query. This is the discipline that replaces the retired single
//       module, whose handlers mutated the datastore in the request handler itself.
//   Explicit API contracts  `AdminStats` and the problem document are consumed exactly as
//       `@/lib/types` declares them, in the service's own snake_case. There is no camel-case mapping
//       layer anywhere in this tier and none is added here: re-spelling a field yields a type that
//       compiles and a value that is absent.
//   Secure by default       Authority is `require_admin`, mounted once on the service's
//       administrative router. This file checks no privilege, decodes no token and reads no
//       credential; it renders the refusal.
//   Zero hardcoded values   Every class string below is a utility generated from the token engine's
//       own scales or a semantic token declared in `globals.css`. No literal colour, length, radius,
//       shadow or font size; no inline `style`; no bespoke media query; no primitive colour family -
//       only `globals.css` maps semantic tokens onto primitives. The failure panel's danger treatment
//       arrives through the alert primitive's own `destructive` variant.
//   Project primitives      `StatCard`, `Alert` and `Button`. No raw `<button>` and no hand-rolled
//       tile. Structural elements are plain, which is what the standard permits.
//   One breakpoint vocabulary   `md` and `lg`, two of the engine's catalogued five. Nothing else.
//   Accessibility as a floor    One `<h1>`, tile headings one level below it, the alert's
//       live-region role DERIVED from its variant rather than authored, decorative glyphs hidden, and
//       the global focus ring left intact - `outline-none` appears nowhere.
//   Config from the environment  This file reads no environment variable, not even a `NEXT_PUBLIC_`
//       one. The API's base address is resolved lazily inside `@/lib/api/client.ts`, this tier's only
//       HTTP module.
//   No secrets              No token, no credential and no signing material appears in this file, and
//       nothing here decodes or inspects one.
//
// The retired single-entity API this product replaced is absent in full: no `/items` address, no
// client-supplied numeric identity and none of that shape's three fields appear anywhere below. The
// service's own contract test asserts the same thing about the generated API description.

import { useEffect, type JSX } from 'react';

import { useQuery } from '@tanstack/react-query';
import { ShieldAlert, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

import { ADMIN_STAT_CARDS, StatCard } from '@/components/admin/stat-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { getAdminStats } from '@/lib/api/admin';
import { isApiError } from '@/lib/api/client';
import type { AdminStats } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Cache identity
 * ---------------------------------------------------------------------------------------------- */

/**
 * Cache key of the overview read: exactly `['admin', 'stats']`, two elements, no parameter object.
 *
 * `getAdminStats` takes no arguments, so there is nothing to key on beyond the endpoint itself, and
 * the plain two-element tuple is the declared contract every administrative deletion invalidates -
 * see the note at the head of this file for why a longer or differently-spelled key would fail
 * silently rather than loudly.
 *
 * `as const` keeps the members literal, which is what lets React Query infer the key's type rather
 * than widening it to `string[]`.
 */
const ADMIN_STATS_QUERY_KEY = ['admin', 'stats'] as const;

/* -------------------------------------------------------------------------------------------------
 * Authority
 * ---------------------------------------------------------------------------------------------- */

/**
 * The status the service answers a caller who is authenticated but not privileged.
 *
 * A named constant because the distinction it draws is the whole of {@link describeFailure}: 403 is
 * an authority decision, so no fresh credential and no repeated attempt can change it, and the panel
 * must therefore offer no retry. Every other failure is worth trying again.
 *
 * `@/lib/api/client` exports no status constants, so this is declared locally rather than imported
 * from a module that does not offer it.
 */
const FORBIDDEN_STATUS = 403;

/* -------------------------------------------------------------------------------------------------
 * Copy
 *
 * Named constants rather than inline strings, so the wording is reviewable in one place and a test
 * can assert against the same value the component renders. Every sentence states what happened and
 * then what to do about it; none of them shows a status code, a stack or a correlation identifier,
 * which belong in a log rather than in front of a person.
 * ---------------------------------------------------------------------------------------------- */

/** The page's single `<h1>`. */
const PAGE_HEADING = 'Admin overview';

/**
 * The orienting line beneath the heading.
 *
 * It says that the totals span every state, because that is the one thing about them that is not
 * self-evident: the service counts posts in every lifecycle state and comments in every moderation
 * state deliberately, so that an overview cannot understate the very backlog the dashboard exists to
 * surface.
 */
const PAGE_TAGLINE =
  'Totals across the whole blog. Every count spans every state, so drafts and comments still awaiting moderation are included.';

/** Headline of the refusal panel, and of the toast that accompanies it. */
const NOT_AUTHORISED_TITLE = 'You are not authorised to read these totals';

/**
 * What a refused caller is told.
 *
 * Deliberately this tier's own sentence rather than the service's, which is a single general line
 * covering all thirteen administrative operations. Someone refused HERE needs the one fact that
 * general line omits: that the refusal is about authority, so neither trying again nor signing in
 * again can lift it.
 */
const NOT_AUTHORISED_DETAIL =
  'Reading the overview requires an administrator account. Trying again or signing in again will not grant it - ask an administrator to review your role.';

/** Headline of the failure panel for every failure that is not a refusal. */
const LOAD_FAILURE_TITLE = 'The overview totals could not be loaded';

/**
 * Substituted when a failure carried no sentence worth showing - a connection that never opened, a
 * deadline that fired first, a rejection that was not an error at all.
 */
const LOAD_FAILURE_DETAIL =
  'The service did not say why. Nothing has been changed, so trying again is safe.';

/** The failure panel's action, while it is idle. */
const RETRY_LABEL = 'Try again';

/** The same action while the retry it started is still in flight. */
const RETRYING_LABEL = 'Retrying…';

/**
 * Stable identifier for the failure toast.
 *
 * What makes a repeated failure REPLACE its predecessor instead of stacking: three presses of the
 * retry action against a service that is still unavailable update one notification three times.
 */
const FAILURE_TOAST_ID = 'admin-overview-failure';

/* -------------------------------------------------------------------------------------------------
 * Presentation
 *
 * Every string here is a utility generated from the token engine's scales. There is no literal
 * colour, length, radius or shadow in this file, and no `dark:` variant either - the semantic tokens
 * are dual-valued in `globals.css`, so this screen re-themes with no conditional of its own.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The page's vertical rhythm.
 *
 * No inline gutter and no measure: `(admin)/admin/layout.tsx` already supplies both, and restating
 * either here would double the padding. `min-w-0` lets this column shrink below its content's
 * intrinsic minimum, which is what keeps a long total from widening the shell at the narrowest
 * viewport.
 */
const PAGE_CLASSES = 'flex min-w-0 flex-col gap-6';

/** The heading and its orienting line: a heading and a sentence need no landmark of their own. */
const INTRO_CLASSES = 'flex flex-col gap-2';

/**
 * The route-heading step.
 *
 * `text-3xl` is what the shell's own pending band is drawn against - it reserves the line box of this
 * exact step - so the heading lands where the placeholder stood and nothing shifts when the session
 * resolves. `text-balance` distributes a wrapped heading evenly instead of orphaning a word, and
 * degrades to ordinary wrapping where unsupported, so it costs nothing.
 */
const HEADING_CLASSES = 'text-3xl font-semibold tracking-tight text-balance';

/**
 * The orienting line: recessed, and capped at a readable measure.
 *
 * `text-muted-foreground` is what marks it as orientation rather than content, and `max-w-2xl` holds
 * the sentence to the `--container-2xl` measure instead of letting it run the full width of the
 * shell.
 */
const TAGLINE_CLASSES = 'max-w-2xl text-muted-foreground';

/**
 * The band of tiles: one column, two from the medium breakpoint, four from the large one.
 *
 * Authored mobile-first and expressed only through generated grid utilities - `md` and `lg` are two
 * of the engine's catalogued five breakpoints, and no bespoke media query appears anywhere in this
 * tier. Each track is `minmax(0, 1fr)` rather than `1fr`, which is what stops a long total from
 * pushing the band wider than its container at any width.
 *
 * The tiles are direct grid children, with no list wrapper, which is the composition
 * `src/components/admin/stat-card.tsx` documents for this band. Two consequences are the reason: a
 * tile is then the grid item itself, so a row of them stretches to a common height with nothing to
 * plumb, and each tile already renders its label as a real heading, so the outline - not a list role -
 * is what a screen-reader user navigates the band by.
 */
const BAND_CLASSES = 'grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4';

/**
 * The failure panel's action.
 *
 * The alert primitive lays its children out as a single-column grid, so a control placed directly
 * inside it would stretch the full width of the panel. `justify-self-start` sizes it to its content
 * instead - a grid-item utility, carrying no length of its own - and `mbs-2` opens the logical block
 * gap the panel's own tighter rhythm does not leave.
 */
const RETRY_CLASSES = 'mbs-2 justify-self-start';

/**
 * Heading level of each tile's label.
 *
 * `2`, because this page's `<h1>` is the only heading above the band: the shell emits none in its
 * resolved chrome and this file renders no section heading, so the outline is one `<h1>` followed by
 * four `<h2>` elements with no level skipped. The tile primitive exposes this precisely so the
 * consuming page - which owns the `<h1>` - decides the depth, and it refuses `h1` outright so a tile
 * can never compete with one.
 */
const TILE_HEADING_LEVEL = 2;

/**
 * The figure passed to a tile whose count has not arrived.
 *
 * `NaN`, and the choice is about honesty rather than convenience. The tile ignores `value` entirely
 * while `isLoading` is set, so this is normally never rendered; if it ever were, the tile's formatter
 * treats a non-finite input as absent and reports "Not available" rather than displaying it. A `0`
 * here would do the opposite - it is a claim, and an administrator who reads "0 comments" when the
 * truth is "not known yet" will act on it.
 */
const UNKNOWN_COUNT = Number.NaN;

/* -------------------------------------------------------------------------------------------------
 * Reading a failure
 * ---------------------------------------------------------------------------------------------- */

/**
 * One failure, resolved into everything both surfaces need to report it.
 *
 * Produced once by {@link describeFailure} and consumed by BOTH the persistent panel and the toast,
 * which is what guarantees the two cannot say different things about the same failure.
 */
interface FailureReport {
  /** Headline: what happened. */
  readonly title: string;
  /** Supporting sentence: what it means, or what to do next. Never empty. */
  readonly detail: string;
  /**
   * Whether the service refused on authority rather than failing.
   *
   * Drives the two things that differ: the glyph, and whether a retry is offered at all. A refusal
   * cannot be retried into a success, so offering the action would invite a person to press it
   * repeatedly for nothing.
   */
  readonly isRefusal: boolean;
}

/**
 * Extract one sentence that is safe to show a person from whatever was thrown.
 *
 * The service renders one problem document for every failure path and writes its `detail` member to
 * be read by a person, so a well-behaved rejection needs unwrapping rather than interpretation.
 * `title` is the fallback for the rare document whose `detail` is blank, and `Error.message` covers a
 * failure the service never described at all - a connection that never opened, or a deadline that
 * fired first.
 *
 * What it never returns is the document itself, a status code, a stack or a correlation identifier.
 * Rendering an object would put "[object Object]" on screen; the rest belong in a log.
 *
 * @param error - The rejection, as React Query surfaced it.
 * @returns One sentence, or `undefined` when nothing usable was carried - in which case the caller
 * substitutes {@link LOAD_FAILURE_DETAIL} rather than showing an empty line.
 */
function failureSentence(error: unknown): string | undefined {
  // `isApiError` is the narrowing `@/lib/api/client` documents for call sites, and it is exactly an
  // `instanceof ApiError` test - never a match on the message text, which is prose and may be
  // reworded without notice.
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
 * Turn a failure into the report both surfaces render.
 *
 * ### The refusal is the branch that matters
 *
 * A 403 on this endpoint means the caller is authenticated and simply does not hold the authority:
 * `require_admin` is mounted once on the service's administrative router, so the decision was already
 * taken before the handler ran, and no rotation, retry or re-authentication can reverse it. It is
 * surfaced as a clear, specific not-authorised message with no retry attached.
 *
 * The shell above this page has its own role check, but it reads the session the client holds, which
 * is user experience rather than a security boundary - a role changed server-side, or a session marker
 * edited by hand, reaches the API and is refused there. So this branch is genuinely reachable and is
 * not defensive decoration.
 *
 * The status is what is branched on rather than the document's `type` member, because on this endpoint
 * the two are equivalent - the administrative namespace has exactly one refusal - and the status is
 * the member guaranteed to equal the status of the response that carried it.
 *
 * ### Why `null` is accepted rather than rejected
 *
 * React Query resets `error` to `null` at the START of a retry, while a query that has never succeeded
 * keeps `data` undefined throughout. The panel therefore persists across a retry it is reporting, and
 * asks for a report while there is momentarily no error object to describe - which correctly yields
 * the generic wording for exactly as long as the attempt is in flight.
 *
 * @param error - The rejection, or `null` while a retry of a never-successful read is in flight.
 * @returns The headline, the sentence and whether a retry is worth offering.
 */
function describeFailure(error: unknown): FailureReport {
  if (isApiError(error) && error.status === FORBIDDEN_STATUS) {
    return { title: NOT_AUTHORISED_TITLE, detail: NOT_AUTHORISED_DETAIL, isRefusal: true };
  }

  return {
    title: LOAD_FAILURE_TITLE,
    detail: failureSentence(error) ?? LOAD_FAILURE_DETAIL,
    isRefusal: false,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Pieces
 * ---------------------------------------------------------------------------------------------- */

/**
 * The page heading and the line that orients a reader beneath it.
 *
 * Rendered in EVERY state, including the failed one, so the document is never momentarily headless and
 * the outline does not change shape depending on whether a request succeeded. A plain container rather
 * than a landmark: `src/app/layout.tsx` owns `banner`, `main` and `contentinfo`, and a heading with a
 * sentence under it needs no region of its own.
 */
function OverviewHeading(): JSX.Element {
  return (
    <div className={INTRO_CLASSES}>
      <h1 className={HEADING_CLASSES}>{PAGE_HEADING}</h1>
      <p className={TAGLINE_CLASSES}>{PAGE_TAGLINE}</p>
    </div>
  );
}

/** Props of {@link OverviewFailure}. */
interface OverviewFailureProps {
  /** The resolved failure, from {@link describeFailure}. */
  readonly report: FailureReport;
  /**
   * Whether a retry started from this panel is still in flight.
   *
   * Reported on the action itself rather than by replacing the panel, so the control a person just
   * pressed stays where they pressed it.
   */
  readonly isRetrying: boolean;
  /** Ask for the totals again. Ignored when the failure was a refusal, which offers no retry. */
  readonly onRetry: () => void;
}

/**
 * The panel that replaces the band when the totals could not be read.
 *
 * `destructive` is the one alert variant the primitive gives `role="alert"`, which is correct here:
 * this stands in place of content the administrator asked for, so it is announced assertively. No
 * `role`, `aria-live` or `aria-atomic` is authored - the primitive derives all of it from the variant,
 * and restating any of them risks a contradiction or a double announcement.
 *
 * The glyph is the primitive's leading slot: a direct `svg` child, positioned and sized by the
 * primitive, hidden from assistive technology because the title beside it already says the same thing.
 * A shield for a refusal and a warning triangle for a failure, so the two are distinguishable by shape
 * as well as by wording - the tone alone never carries the meaning.
 *
 * @param props - See {@link OverviewFailureProps}.
 * @returns The panel, with a retry action unless the failure was a refusal.
 */
function OverviewFailure({ report, isRetrying, onRetry }: OverviewFailureProps): JSX.Element {
  return (
    <Alert variant="destructive">
      {report.isRefusal ? <ShieldAlert aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}

      {/* `h2`, one level below this page's `<h1>`, so the failed state has the same ordered outline
          the loaded one does. The primitive defaults this to a non-heading element precisely because
          only the page knows where in the outline it sits. */}
      <AlertTitle as="h2">{report.title}</AlertTitle>

      <AlertDescription>{report.detail}</AlertDescription>

      {/* Absent for a refusal: authority cannot be retried into existence, and a control that could
          only ever fail is worse than no control. Present for every other failure, at the primitive's
          default size so the target clears the accessibility floor, and `secondary` so it does not
          compete with an already-assertive panel. */}
      {report.isRefusal ? null : (
        <Button
          className={RETRY_CLASSES}
          disabled={isRetrying}
          onClick={onRetry}
          variant="secondary"
        >
          {isRetrying ? RETRYING_LABEL : RETRY_LABEL}
        </Button>
      )}
    </Alert>
  );
}

/* -------------------------------------------------------------------------------------------------
 * The screen
 * ---------------------------------------------------------------------------------------------- */

/**
 * The administrative overview at `/admin`: the four aggregate counts, and the states the read can be
 * in.
 *
 * ### The read
 *
 * One call to `getAdminStats`, the typed wrapper over `GET /api/v1/admin/stats`. Only `queryKey` and
 * `queryFn` are passed. The caching window, the focus behaviour and the retry predicate - which
 * refuses to repeat a client error, so a refusal is one deterministic attempt rather than three -
 * all belong to `src/providers/query-provider.tsx` and are inherited by every call site in the tier;
 * restating any of them here would fork the tier's policy from a single screen. React Query's
 * cancellation signal IS forwarded, so an administrator who navigates away mid-read cancels the
 * request instead of resolving into a cache nobody is reading.
 *
 * The response is a BARE object of four totals, not a page envelope. There is no `items` to unwrap, no
 * `total` to read, no window to follow and therefore no page control, no data table and no pagination
 * hook on this screen - those belong to the four management screens this one links to.
 *
 * ### Three states, and why the branches are guarded the way they are
 *
 * 1. **In flight.** The band renders at full size with each tile showing a placeholder in place of its
 *    figure, rather than one spinner standing in for the whole band. The tiles keep their geometry and
 *    their labels, so nothing moves when the totals arrive and the outline is complete from the first
 *    paint.
 * 2. **Failed.** The band is replaced by {@link OverviewFailure}. A refusal gets a specific
 *    not-authorised message and no retry; every other failure gets the service's own sentence and a
 *    retry.
 * 3. **Loaded.** The four totals, each linking to the management screen for that entity.
 *
 * The failed branch is guarded on `stats === undefined` AFTER the read has settled once, NOT on
 * `error !== null`, and that is a correctness matter rather than a preference. React Query resets both
 * `status` and `error` at the start of every fetch of a query that holds no data, so a query which has
 * only ever failed reports itself as pending again - and reports no error - for the whole duration of a
 * retry. Guarding on the error would make the panel and the very button that started the retry vanish
 * until it settled; guarding on `isFetched` and the absence of data keeps both in place and lets the
 * button report progress. The same guard gives the right answer in the opposite case too: if a
 * background refetch fails after an earlier success, `stats` still holds the last good totals, so the
 * band stays on screen with real numbers and the toast alone reports the failure - which is honest,
 * where an "unavailable" panel contradicting four visible figures would not be.
 *
 * @returns The heading, and either the band of totals or the failure panel.
 */
export default function AdminOverviewPage(): JSX.Element {
  const {
    data: stats,
    error,
    isFetched,
    isFetching,
    refetch,
  } = useQuery({
    queryFn: ({ signal }): Promise<AdminStats> => getAdminStats({ signal }),
    queryKey: ADMIN_STATS_QUERY_KEY,
  });

  /*
   * The interrupting half of the failure report, raised from an effect rather than during render.
   *
   * React Query 5 removed the per-query error callback, and a toast raised in a render pass would be a
   * side effect in one: React may run that pass twice in development and may discard it entirely under
   * concurrent rendering, so the notification would either double or never appear. An effect keyed on
   * the error's identity fires exactly once per distinct failure, and not at all on a recovery.
   *
   * The toast is a companion to the panel, never a substitute for it: a toast dismisses itself, so an
   * administrator who looked away would otherwise have no idea why the band is missing. The panel is
   * the durable explanation and this is what draws the eye to it. Both are worded by the same
   * {@link describeFailure} call, so they cannot disagree.
   */
  useEffect(() => {
    if (error === null) {
      return;
    }

    const report = describeFailure(error);

    toast.error(report.title, { description: report.detail, id: FAILURE_TOAST_ID });
  }, [error]);

  /* -----------------------------------------------------------------------------------------------
   * 2. Settled at least once, and still without totals
   * -------------------------------------------------------------------------------------------- */

  if (isFetched && stats === undefined) {
    return (
      <div className={PAGE_CLASSES}>
        <OverviewHeading />

        <OverviewFailure
          isRetrying={isFetching}
          onRetry={() => {
            // `void`: the result object this resolves to has no use here, and every state that
            // matters - `isFetching`, then the totals or the failure - arrives back through the hook.
            // Awaiting it would leave a floating promise for no benefit.
            void refetch();
          }}
          report={describeFailure(error)}
        />
      </div>
    );
  }

  /* -----------------------------------------------------------------------------------------------
   * 1 and 3. In flight, then loaded - one band, one code path
   *
   * Deliberately not two branches. The pending and loaded states differ by exactly two props per
   * tile, so rendering them from one expression is what guarantees the geometry is identical and the
   * arrival of the totals shifts nothing on the page. Reaching this point with no totals means the
   * read has not settled even once, because the branch above has already returned for every settled
   * read that produced none.
   * -------------------------------------------------------------------------------------------- */

  const isAwaitingCounts = stats === undefined;

  return (
    <div className={PAGE_CLASSES}>
      <OverviewHeading />

      <div className={BAND_CLASSES}>
        {/*
         * Mapped over the descriptor the tile primitive exports rather than four tiles written out by
         * hand, and that is the difference between covering every total by convention and covering it
         * by proof. Each descriptor's `key` is typed as a field of `AdminStats`, so a misspelling or a
         * camel-case slip is a compile error rather than an undefined figure at run time, and the
         * primitive carries a type-level assertion that a descriptor exists for every field - add a
         * fifth total to the contract and the build fails until a fifth tile is declared.
         *
         * `stats[card.key]` reads the field in the service's own snake_case. There is no camel-case
         * mapping layer anywhere in this tier, so the other spelling would compile against nothing.
         *
         * The value is passed as a NUMBER, never pre-formatted: the tile abbreviates large totals for
         * the eye and announces the exact figure to assistive technology, and formatting here would
         * both fail the prop's type and lose the announced form.
         */}
        {ADMIN_STAT_CARDS.map((card) => (
          <StatCard
            headingLevel={TILE_HEADING_LEVEL}
            href={card.href}
            icon={card.icon}
            isLoading={isAwaitingCounts}
            key={card.key}
            label={card.label}
            value={stats?.[card.key] ?? UNKNOWN_COUNT}
          />
        ))}
      </div>
    </div>
  );
}
