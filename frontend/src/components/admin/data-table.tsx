'use client';

// DataTable - the one grid all four administrative management screens render.
//
// /admin/users, /admin/posts, /admin/comments and /admin/categories are described identically:
// "paginated, filterable tables with row actions for role change, status change, moderation, and
// deletion". Four bespoke tables would be four places for the page envelope to be read slightly
// differently, four pagination controls to keep in step and four responsive contracts to get
// right. This component is the single implementation, and it is generic in the row type so that
// each screen contributes only the two things that genuinely differ: its column definitions and
// its already-fetched page of rows.
//
// It is also what makes the plan's uniform-pagination prerequisite pay off. The home feed, an
// author's public profile and these four grids all window results with the same five-field
// envelope, so the envelope handling lives here once rather than four times over.
//
// ---------------------------------------------------------------------------
// 1. IT NEVER FETCHES. THAT IS WHAT LETS ONE GRID SERVE FOUR ENTITIES.
//
// The rows arrive as a resolved `Page<T>` prop. The consuming (admin) page owns the request and
// makes it through src/lib/api/admin.ts, which goes through src/lib/api/client.ts - the only
// module in this tier permitted to perform HTTP, and the owner of token attachment,
// refresh-on-401 and error normalisation.
//
// This is not merely layering for its own sake. A grid that fetched would have to know WHICH
// endpoint to call, which means knowing which entity it was showing, which is exactly the
// knowledge that would stop it being shared. Because it takes an envelope instead, the users
// screen and the comment moderation queue are the same component with different columns.
//
// It also keeps the component suite honest: the request interceptor is configured to error on any
// request no handler claims, so a stray fetch here would fail the whole suite rather than
// silently pass with mock data.
//
// Two related absences, for the same reason:
//
//   * No React Query call, and no query key. The four pages and the four mutating components in
//     this folder share one key convention - lists are ['admin', <entity>, params] and the
//     overview counts are ['admin', 'stats'] - and it is owned by the callers. A key invented
//     here would be a second convention that could drift out of step with theirs.
//   * No optimistic state. Optimism is confined to the like button and the comment surface, where
//     a failed attempt is safe to retry. This grid settles on whatever its caller hands it.
//
// ---------------------------------------------------------------------------
// 2. THE RESPONSIVE CONTRACT IS THREE TIERS AND ONLY THE THIRD IS THIS FILE'S
//
//   below 48rem   one card per record, every value preceded by its column name
//   48rem and up  a real table whose excess width scrolls INSIDE its own container
//   64rem and up  the same table, wide enough to show every column
//
// THE FIRST TWO TIERS ARE ALREADY IMPLEMENTED, IN @/components/ui/table. That primitive switches
// `display` on the real table elements through `max-md:` utilities: the header band is hidden, the
// body becomes a column flex container, each row becomes a bordered card and each cell becomes a
// label/value pair fed by its `label` prop. One DOM at every width, nothing unmounted at a
// breakpoint, and the horizontal overflow owned by a scroll container past md so the DOCUMENT
// never gains a scrollbar.
//
// So this file adds no media query, no width listener, no second markup tree and no wrapper of its
// own around the scrollport. Two competing responsive layers would fight each other, and the one
// that lost would be the primitive's - which is the one the 768px viewport project measures.
// What this file does instead is FEED `label` on every cell, which is the whole integration: below
// md those labels are the only thing carrying column meaning, because `display: none` removes the
// `<th>` elements from the accessibility tree along with the pixels.
//
// The third tier is genuinely this file's, and it is the `hideBelowLg` flag on a column. See its
// documentation for why the class has to land on the header cell and the body cell together, and
// why they are computed once per column rather than once per cell.
//
// ---------------------------------------------------------------------------
// 3. FOUR STATES, IN ONE FIXED PRECEDENCE
//
//     loading  >  error  >  empty  >  populated
//
// which is the state precedence the design rules set out. Loading outranks error because a
// refetch in flight after a failure is a recovery in progress, not a failure to keep reporting.
//
// Each state is rendered by a design-system part rather than by ad-hoc markup, and two of them are
// easy to get subtly wrong:
//
//   * The ERROR state is a real, legible panel - never a swallowed exception and never an empty
//     table. A 403 reaches it, because hiding a control is not a security boundary: the API
//     re-checks authority on every protected operation, so a screen that hid an action can still
//     receive a refusal, and the administrator has to be able to read it.
//   * The EMPTY state is calm. An empty `items` array alongside a non-zero `total` is what the
//     service returns for a page past the end of the collection - an ordinary answer to a stale or
//     hand-edited URL, not an error - so the page control stays on screen there to navigate back
//     with.
//
// ---------------------------------------------------------------------------
// 4. `'use client'` IS LOAD-BEARING HERE, UNLIKE MOST OF THIS FOLDER
//
// Two independent reasons, either of which alone would be sufficient:
//
//   1. Every column carries a `cell` RENDER FUNCTION, and a function is not serializable across
//      the server-to-client boundary. A Server Component could not pass one, so a shared module
//      would be unusable by its actual callers.
//   2. It calls `usePagination`, which reads the URL. All four administrative screens are client
//      screens in the plan's own screen inventory, so nothing is lost.
//
// The island still stays narrow: nothing entity-specific is pushed in here. There is not one
// reference below to a user, a post, a comment or a category - no `role`, no `status`, no
// moderation state. All of that lives in the caller's column definitions, which is why this file
// can be read once and reused four times.
//
// ---------------------------------------------------------------------------
// 5. DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS NOT.
//
//   1. `@/components/ui/card`. Below md every `TableRow` ALREADY is a rounded, bordered
//      `--color-surface` panel carrying the same tokens `card.tsx` uses - that is how the
//      collapse works - so wrapping the grid in a `Card` would nest a panel inside a panel and
//      double the border and the shadow at exactly the width where the record cards need to read
//      cleanly. The panel treatment the grid does want applies from md up only, and it rides on
//      the primitive's own `containerClassName` hook, which is the recipe that primitive
//      documents. `overflow-hidden` is deliberately NOT part of it: the container IS the
//      scrollport, and clipping it would destroy the second tier. A border radius clips the
//      corners on its own.
//   2. `@/components/ui/button`. The only button-shaped affordances on an administrative grid are
//      the page links, which belong to `@/components/ui/pagination` and are anchors rather than
//      buttons on purpose, and the row actions, which arrive through a column's `cell`. A retry
//      control would need a handler prop that is not part of this component's contract, and
//      sorting, row selection and export are out of scope. An import with no use would also fail
//      the lint gate, which runs at `--max-warnings=0`.
//   3. The primitive's `scrollRegionLabel`. It exists for a grid with NO focusable descendant,
//      which cannot be scrolled by keyboard at all. Every administrative row carries a row-action
//      trigger or a link, so focus already enters the container and the browser scrolls it to
//      reveal whichever cell takes focus; the primitive says outright not to pass it for these
//      grids, and surfacing it as a prop would invite exactly that mistake.
//   4. A `<Suspense>` boundary. `usePagination` reads search parameters, and on a statically
//      rendered route Next.js requires a boundary above any component that does. That boundary
//      belongs to the route - a fallback placed here would put a placeholder rather than the real
//      page links into the prerendered HTML, which is the one outcome the anchor-based pagination
//      exists to prevent.
//   5. Column sorting, row selection, CSV export, sticky columns, virtualisation, column
//      resizing. None is named in the plan, and there is no data-grid library in the pinned
//      dependency set to supply them; every one of them would be a feature invented here.
//   6. A `dark:` variant, and any literal colour, length, radius, shadow or font size. Every token
//      referenced below is dual-valued - declared once at the document root and again under
//      `.dark` in src/app/globals.css - so the grid re-themes with no conditional here. Column
//      widths in particular are left to the table layout algorithm rather than pinned: an
//      arbitrary width value would be a hardcoded dimension, and a fixed one would fight the
//      second tier's scrollport.
//   7. Any focus styling. globals.css sets a `:focus-visible` outline floor for the whole
//      document, so a row action, a page link or a filter control inside this grid is already
//      ringed. Restating it here would be a second source of truth for one decision.
//   8. Any environment variable. Nothing here is configurable per deployment.
//   9. An import of any sibling in this folder. Row actions reach the grid through a column's
//      `cell`, so `user-row-actions`, `post-row-actions`, `comment-moderation-actions` and
//      `category-form` are the caller's business. The grid stays renderable by a test, or by any
//      future screen, without dragging four entity-specific components along with it.

import type { JSX, ReactNode } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Pagination } from '@/components/ui/pagination';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { usePagination } from '@/hooks/use-pagination';
import type { Page, ProblemDetail } from '@/lib/types';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/* Token-derived class constants                                              */
/* -------------------------------------------------------------------------- */

/*
 * Every value in this section resolves to a token declared in src/app/globals.css. The spacing
 * steps come from the `--spacing` multiplier, the radius from `--radius-xl`, the type size from
 * `--text-sm`, and the two colours from the semantic layer (`--color-muted-foreground`,
 * `--color-border`) rather than from any primitive colour family. There is no literal length,
 * colour, radius or font size anywhere below.
 */

/**
 * The grid's outer stack: the toolbar, the table and the footer, separated by one token step.
 *
 * A column flex container rather than margins between the three regions, because a `gap` is a
 * property of the container and therefore disappears with a region that is not rendered - where a
 * margin on a conditional child leaves a dangling space behind it.
 */
const ROOT_CLASSES = 'flex flex-col gap-6';

/**
 * The filter region.
 *
 * `flex-wrap` is the part that matters: a screen's filters wrap onto a second line at 375 instead
 * of pushing the document into horizontal scroll, which the responsive criteria forbid at every
 * width. Laying the slot out here rather than in each of the four screens is the point of having
 * a slot at all.
 */
const TOOLBAR_CLASSES = 'flex flex-wrap items-center gap-3';

/**
 * The footer: the result range and the page control.
 *
 * Stacked below md, where neither has room to share a line, and a single row from md up with the
 * range at the inline start and the control at the inline end. DOM order is range then control at
 * both widths, so the reading order a screen reader follows matches the visual order.
 */
const FOOTER_CLASSES = 'flex flex-col gap-4 md:flex-row md:items-center md:justify-between';

/** The result range: supporting copy, so the recessed foreground token and the small step. */
const RANGE_CLASSES = 'text-sm text-muted-foreground';

/**
 * Applied to the primitive's scroll CONTAINER, not to the table.
 *
 * From md up the grid reads as one panel, which is what keeps it visually continuous with the
 * record cards below md - those are rounded, bordered surfaces, so the table tier gets the same
 * treatment at the container level. It is `md:`-scoped because below md the rows carry the border
 * themselves and a second one around the stack would box a set of already-boxed cards.
 *
 * `overflow-hidden` is deliberately absent: this container is the horizontal scrollport that keeps
 * a wide grid from overflowing the document, and hiding its overflow would silently retire the
 * whole second tier. A border radius clips the corners without it.
 */
const TABLE_CONTAINER_CLASSES = 'md:rounded-xl md:border md:border-border';

/* -------------------------------------------------------------------------- */
/* Default copy                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Shown when a grid has nothing to list and its caller named no copy of its own.
 *
 * Deliberately generic, because this component cannot know which entity is missing - a caller
 * that can say "No comments are awaiting moderation" should, through `emptyTitle` and
 * `emptyDescription`.
 */
const DEFAULT_EMPTY_TITLE = 'Nothing to show';

/** @see {@link DEFAULT_EMPTY_TITLE} */
const DEFAULT_EMPTY_DESCRIPTION = 'No records match the current filters.';

/**
 * Last-resort headline for the error panel.
 *
 * The error contract guarantees both a `title` and a `detail`, so this is unreachable through the
 * API. It exists because an alert whose only content is an empty string is an alert that says
 * nothing, and a transport failure normalised into the problem shape is the one path that could
 * carry blank prose.
 */
const FALLBACK_ERROR_HEADLINE = 'These records could not be loaded';

/* -------------------------------------------------------------------------- */
/* Loading placeholder geometry                                               */
/* -------------------------------------------------------------------------- */

/**
 * How many placeholder rows to draw when the window size is not yet known.
 *
 * A caller that is loading its first page often has no envelope to hand yet and passes zeroed
 * numbers, so `page_size` cannot be relied on to be meaningful.
 */
const SKELETON_ROW_COUNT_FALLBACK = 5;

/**
 * Ceiling on placeholder rows.
 *
 * The service accepts a window size up to 100, and drawing a hundred throwaway rows would cost
 * more than the layout stability it buys - a screenful is enough to hold the page's height steady,
 * which is the entire purpose of drawing them.
 */
const SKELETON_ROW_COUNT_MAX = 10;

/** Prefix for placeholder row keys. See {@link resolveSkeletonRowCount} for why an index is right. */
const SKELETON_ROW_KEY_PREFIX = 'placeholder-row-';

/**
 * Decide how many placeholder rows to draw for a given window size.
 *
 * Placeholder rows are the one place in this component where a positional key is correct. A real
 * row is keyed by `getRowId`, because a record has an identity that survives reordering; a
 * placeholder has none - it is a position and nothing else - so its index IS its identity.
 *
 * @param pageSize - The envelope's `page_size`. Zero, negative, fractional and non-finite values
 *   are all treated as "not yet known" rather than as errors, because a caller loading its first
 *   page legitimately has no window size to report.
 * @returns A row count between 1 and {@link SKELETON_ROW_COUNT_MAX}.
 */
function resolveSkeletonRowCount(pageSize: number): number {
  if (!Number.isFinite(pageSize) || pageSize < 1) {
    return SKELETON_ROW_COUNT_FALLBACK;
  }

  return Math.min(Math.trunc(pageSize), SKELETON_ROW_COUNT_MAX);
}

/* -------------------------------------------------------------------------- */
/* Column alignment                                                           */
/* -------------------------------------------------------------------------- */

/** Where a column's content sits on its inline axis. @see {@link DataTableColumn.align} */
export type DataTableColumnAlign = 'start' | 'end';

/*
 * Alignment is a lookup rather than a conditional expression, so adding a third alignment is a new
 * entry here and a compile error at every site that has to handle it, instead of a silent fall
 * through to the default.
 *
 * `start` maps to NOTHING on purpose. The primitive already starts its header text and a cell
 * inherits the document's direction, so emitting a utility for the default case would override one
 * declaration with an equivalent one and add a class to every header cell in the product for no
 * change in rendering.
 *
 * The two `end` entries differ in their variant, and that asymmetry is deliberate:
 *
 *   * On the HEADER the utility is unprefixed, so `cn` resolves it against the primitive's own
 *     `text-left` and one alignment survives. The header band only exists from md up anyway, so
 *     scoping it would change nothing but would make the merge depend on stylesheet order rather
 *     than on the property group.
 *   * On the CELL it is `md:`-scoped, because below md that cell is a flex row whose value is
 *     already pushed to the inline end by the primitive's `justify-between`. An unscoped
 *     `text-end` there would additionally right-align the individual lines of a value that wraps
 *     onto several, which is a typography change nobody asked for.
 */
const ALIGN_HEAD_CLASSES: Record<DataTableColumnAlign, string | undefined> = {
  start: undefined,
  end: 'text-end',
};

/** @see {@link ALIGN_HEAD_CLASSES} */
const ALIGN_CELL_CLASSES: Record<DataTableColumnAlign, string | undefined> = {
  start: undefined,
  end: 'md:text-end',
};

/**
 * Demotes a column below the large breakpoint - hidden under 64rem, restored at 64rem and above.
 *
 * Both variants are Tailwind's own, so this stays inside the sanctioned five-breakpoint vocabulary
 * and introduces no custom media query.
 *
 * `max-lg:hidden` ALONE IS NOT ENOUGH, AND THAT WAS MEASURED RATHER THAN GUESSED. It is the recipe
 * `@/components/ui/table` documents, and it works perfectly on a `<th>` - but on a `<td>` it loses
 * silently, because that primitive's own cell base carries `max-md:flex` to build the record card.
 * Both utilities are single-class selectors of equal specificity in the same cascade layer, so
 * source order decides, and Tailwind always emits the `max-lg` (64rem) block BEFORE the `max-md`
 * (48rem) block. Below 48rem `display: flex` therefore beat `display: none`.
 *
 * Measured in a real browser at 375px on the shipped markup: the demoted `<th>` computed
 * `display: none` while the `<td>` for the same column computed `display: flex` with a 309x40 box,
 * in every one of the five record cards. The hidden header band concealed the disagreement from
 * the eye, and the user-visible result was a card carrying a 70-character slug the contract says is
 * not shown under 64rem - a header and a body disagreeing about which columns exist, which is the
 * one thing a demotion must never cause. A probe confirmed the cause was the cascade rather than a
 * missing class: `max-lg:hidden` alone resolved to `none`, and `max-md:flex max-lg:hidden` - what
 * the element actually carried - resolved to `flex`. Swapping the order of the classes in the
 * attribute changed nothing, because HTML class order is not CSS source order.
 *
 * Adding `max-md:hidden` fixes it WITHOUT depending on source order at all, which is why it is the
 * chosen remedy. `cn` resolves conflicts by property group, and both utilities carry the same
 * `max-md` variant, so the composed cell class list comes out with `max-md:flex` REMOVED and
 * `max-md:hidden` in its place: the two declarations never both reach the stylesheet, so nothing is
 * left for the cascade to arbitrate. Verified on the exact base strings - the demoted cell loses
 * `max-md:flex` and keeps both hidden utilities, and a column that is NOT demoted keeps its
 * `max-md:flex` untouched.
 *
 * On a `<th>` the `max-md:hidden` is redundant, since `TableHeader` already hides the whole band
 * below 48rem. It is applied to both anyway: one class string for the header and the body is what
 * makes the two provably incapable of disagreeing, and a redundant utility on an element that is
 * already `display: none` costs nothing.
 */
const HIDE_BELOW_LG_CLASSES = 'max-md:hidden max-lg:hidden';

/* -------------------------------------------------------------------------- */
/* The column contract                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One column of a {@link DataTable}.
 *
 * This is the contract the four administrative screens and the row-action components are written
 * against, so it is exported and it is stable. A screen describes its grid as an array of these
 * and hands over its page of rows; everything else - the header band, the record cards, the
 * placeholder rows, the page control - follows from that.
 *
 * @typeParam T - The row type. Inferred from the `columns`/`page` pair at the call site, so a
 *   column's `cell` receives a fully typed row with no cast anywhere.
 *
 * @example A users grid. The first column takes its label from its header, the actions column
 * suppresses the label because a row-action menu describes itself, and the joined date is demoted
 * to the widest tier.
 * ```tsx
 * const columns: ReadonlyArray<DataTableColumn<AdminUser>> = [
 *   { id: 'user', header: 'User', cell: (user) => user.display_name },
 *   { id: 'role', header: 'Role', cell: (user) => <Badge>{user.role}</Badge> },
 *   { id: 'joined', header: 'Joined', hideBelowLg: true, cell: (user) => formatDate(user.created_at) },
 *   {
 *     id: 'actions',
 *     header: 'Actions',
 *     label: '',
 *     align: 'end',
 *     cell: (user) => <UserRowActions user={user} />,
 *   },
 * ];
 * ```
 */
export interface DataTableColumn<T> {
  /**
   * Stable identifier, unique within one `columns` array.
   *
   * Used as the React key for this column's header cell and for its cell in every row. A field
   * name is the natural choice; anything stable across renders will do. It is never rendered.
   */
  id: string;

  /**
   * The column heading, rendered inside a real `<th scope="col">`.
   *
   * A `ReactNode` so a heading can carry an icon or a badge, though a plain string is the normal
   * case and is also what lets {@link DataTableColumn.label} default to it.
   */
  header: ReactNode;

  /**
   * The column name shown beside this column's value inside the record card below 48rem.
   *
   * Below that width the header band is `display: none`, which removes the `<th>` elements from
   * the accessibility tree as well as from the layout, so this label is the ONLY thing that says
   * which column a value came from - visually and to a screen reader alike. Omit it on a column
   * whose header is not a plain string and that field silently loses its meaning at 375.
   *
   * Three behaviours, in order:
   *
   *   * Supplied and non-blank - used verbatim.
   *   * Omitted - defaults to {@link DataTableColumn.header} when that header is a plain string.
   *     This is the case for almost every column, which is why it is the default rather than
   *     something each screen has to restate.
   *   * Supplied as an empty string - NO label is rendered. This is the documented way to suppress
   *     it for a cell that describes itself: a row-action menu, a lone avatar. `@/components/ui/table`
   *     recommends omitting the label for exactly those, and a stray field name beside a menu
   *     button reads as a mislabelled control.
   *
   * A column whose header is not a plain string and that is not self-describing should therefore
   * pass this explicitly - an icon-only header is the usual example.
   */
  label?: string;

  /**
   * Renders this column's value for one row.
   *
   * This is the slot a screen fills with its row actions - `<UserRowActions user={row} />`,
   * `<PostRowActions post={row} />`, `<CommentModerationActions comment={row} />` - and it is why
   * this component has to be a client component: a function cannot cross the server-to-client
   * boundary, so a Server Component could not supply one.
   *
   * Return ONE element when the value has several parts. Below 48rem the cell is a flex row that
   * separates the label from the value, so several sibling children are spaced apart individually
   * instead of staying grouped opposite the label. Wrap them:
   *
   * ```tsx
   * cell: (post) => (
   *   <div className="flex items-center gap-2">
   *     <PostRowActions post={post} />
   *   </div>
   * )
   * ```
   *
   * Never returns `null` or `undefined` as visible text: React renders neither, so an absent value
   * should be an explicit fallback string chosen by the caller rather than a nullish value.
   */
  cell: (row: T) => ReactNode;

  /**
   * Which end of the column its content sits at. Defaults to `'start'`.
   *
   * `'end'` is for a column whose content reads as trailing - a row-actions menu, a right-aligned
   * count. It resolves to a token-derived text-alignment utility and nothing else; it never sets a
   * width.
   */
  align?: DataTableColumnAlign;

  /**
   * Hides this column below 64rem, leaving the widest tier to show the full set.
   *
   * This is the third responsive tier and the only one this component implements - the record
   * cards below 48rem and the scrollable table from 48rem up belong to
   * `@/components/ui/table`. Mark a column secondary and the grid at 768 carries the primary
   * columns only, which is what "full table with all columns" from 64rem up is measured against.
   *
   * The flag means what its name says: hidden at EVERY width below 64rem, which includes the
   * record card at 375. That is deliberate rather than an oversight - a secondary column is
   * secondary at every narrow width, and the card is already the tallest presentation of a record.
   * A column whose value must always be reachable is simply not a `hideBelowLg` column.
   *
   * Whichever columns are marked, the header cell and the body cells can never fall out of step.
   * Both class strings are derived once, from this one flag, by {@link resolveColumns} - and the
   * string itself is built to survive the primitive's own card-layout utilities, which the
   * documented one-utility recipe does not. See {@link HIDE_BELOW_LG_CLASSES} for the measurement
   * behind that.
   */
  hideBelowLg?: boolean;
}

/**
 * A column with its presentation resolved: labels defaulted, alignment and demotion turned into
 * the exact class strings the two elements need.
 *
 * Internal, and computed ONCE PER COLUMN per render rather than once per cell. Two reasons, and
 * the first is correctness rather than cost: deriving the header class and the body class from one
 * object at one moment is what guarantees a demoted column disappears from the header and the body
 * together. The second is that `cn` runs a conflict resolver over every class list it is given, so
 * hoisting turns work proportional to rows times columns into work proportional to columns.
 */
interface ResolvedColumn<T> {
  readonly id: string;
  readonly header: ReactNode;
  /** `undefined` when this column renders no label - see {@link DataTableColumn.label}. */
  readonly label: string | undefined;
  readonly cell: (row: T) => ReactNode;
  /** `undefined` rather than an empty string, so no empty `class` attribute is emitted. */
  readonly headClassName: string | undefined;
  /** @see {@link ResolvedColumn.headClassName} */
  readonly cellClassName: string | undefined;
}

/**
 * Work out the label a column's cells carry below the medium breakpoint.
 *
 * @param column - The caller's column definition.
 * @returns The label text, or `undefined` when this column renders none.
 */
function resolveColumnLabel<T>(column: DataTableColumn<T>): string | undefined {
  if (column.label !== undefined) {
    // A blank label is an explicit suppression, and it is also the defensive answer for a caller
    // that computed a label and got an empty string: the primitive treats every non-nullish node
    // as a label the caller meant, so passing '' straight through would render an empty label
    // element and its inline gap inside the record card.
    const trimmed = column.label.trim();

    return trimmed.length > 0 ? trimmed : undefined;
  }

  // The overwhelmingly common case: the heading is already the field name, so requiring every
  // screen to write it twice would guarantee the two eventually disagree.
  return typeof column.header === 'string' && column.header.trim().length > 0
    ? column.header.trim()
    : undefined;
}

/**
 * Resolve every column's label and class strings once for this render.
 *
 * @param columns - The caller's column definitions.
 * @returns One {@link ResolvedColumn} per input column, in the same order.
 */
function resolveColumns<T>(
  columns: ReadonlyArray<DataTableColumn<T>>,
): ReadonlyArray<ResolvedColumn<T>> {
  return columns.map((column) => {
    const align = column.align ?? 'start';
    const demotion = column.hideBelowLg === true ? HIDE_BELOW_LG_CLASSES : undefined;

    return {
      id: column.id,
      header: column.header,
      label: resolveColumnLabel(column),
      cell: column.cell,
      // `|| undefined` rather than the composed string, because `cn` returns '' when every input
      // is absent and an empty `className` would reach the DOM as `class=""`.
      headClassName: cn(ALIGN_HEAD_CLASSES[align], demotion) || undefined,
      cellClassName: cn(ALIGN_CELL_CLASSES[align], demotion) || undefined,
    };
  });
}

/**
 * Compose the "showing X to Y of N" line beneath a grid.
 *
 * The three numbers come from `usePagination` and are never recomputed here: that hook is this
 * tier's single implementation of page arithmetic, and a second one could disagree with it - the
 * symptom being a grid that reports a range the service would not serve. It already handles the
 * cases that make this line wrong when it is written by hand, notably a partial final page, where
 * the last index is the total rather than page times window size.
 *
 * @param firstItem - 1-based index of the first row on screen.
 * @param lastItem - 1-based index of the last row on screen.
 * @param total - Total matching rows, ignoring the window.
 * @returns The rendered sentence.
 */
function formatResultRange(firstItem: number, lastItem: number, total: number): string {
  return `Showing ${firstItem}\u2013${lastItem} of ${total} ${total === 1 ? 'result' : 'results'}`;
}

/**
 * Pick the headline and the supporting line for the error panel out of one problem document.
 *
 * The error contract gives `title` a constant meaning per problem kind - "Forbidden" - and `detail`
 * an explanation of the particular occurrence, so the two land in the panel's title and its
 * description respectively rather than one being discarded. Both are guarded for blankness, and the
 * description is dropped when it merely repeats the headline.
 *
 * @param error - The normalised problem document from the API client.
 * @returns The headline, and the supporting line or `null` when there is nothing more to add.
 */
function resolveErrorCopy(error: ProblemDetail): {
  readonly headline: string;
  readonly explanation: string | null;
} {
  const title = error.title.trim();
  const detail = error.detail.trim();

  if (title.length > 0) {
    return { headline: title, explanation: detail.length > 0 && detail !== title ? detail : null };
  }

  if (detail.length > 0) {
    return { headline: detail, explanation: null };
  }

  return { headline: FALLBACK_ERROR_HEADLINE, explanation: null };
}

/* -------------------------------------------------------------------------- */
/* DataTable                                                                  */
/* -------------------------------------------------------------------------- */

/** Props of {@link DataTable}. */
export interface DataTableProps<T> {
  /**
   * The columns to render, in order.
   *
   * `ReadonlyArray` because this component never mutates it, which lets a caller define its
   * columns as a module-level constant - the cheapest way to keep them stable across renders -
   * without widening the type.
   *
   * An empty array is handled rather than rejected: it renders the empty state instead of a table
   * of cell-less rows, which is valid markup that renders as invisible rows and announces as a
   * table with no columns.
   */
  columns: ReadonlyArray<DataTableColumn<T>>;

  /**
   * The resolved page of rows, exactly as the API returned it.
   *
   * The five fields of the envelope are read and nothing else: `items` for the rows, and `total`,
   * `page`, `page_size` and `pages` for the range line and the page control. They are read under
   * their wire names - there is no camelCase mapping layer anywhere in this tier, so `page_size` is
   * spelled the way it arrives.
   *
   * This component does not fetch it. The consuming (admin) page does, through
   * `@/lib/api/admin.ts`.
   */
  page: Page<T>;

  /**
   * Stable identity for one row, used as its React key.
   *
   * Never an array index: an administrative grid re-sorts, filters and pages, and an index key
   * would make React reuse the DOM of one record for another - which at best redraws a row of
   * mismatched values and at worst leaves a row-action menu pointed at the previous record. Every
   * entity the four screens administer carries a server-generated identifier, so this is normally
   * `(row) => row.id`.
   */
  getRowId: (row: T) => string;

  /**
   * Human-readable name of this grid - "Users", "Comment moderation queue".
   *
   * Required, and required for a reason: a table with no accessible name is announced as nothing
   * more than "table" with a row and column count, which tells a screen-reader user nothing about
   * which of the four administrative grids they have landed in.
   *
   * It becomes the table's accessible name, and - suffixed - the name of the pagination landmark
   * below it, so a landmark list distinguishes this grid's page control from any other on the
   * screen. See the implementation note on `aria-label` for why it is applied that way rather than
   * as a `<caption>` element.
   */
  caption: string;

  /**
   * Whether the caller's request is in flight. Defaults to `false`.
   *
   * Renders placeholder rows inside the real table rather than replacing the grid, so the page does
   * not jump when the rows arrive, and marks the table busy for assistive technology. It outranks
   * every other state, so a refetch after a failure shows progress rather than continuing to
   * report the failure.
   */
  isLoading?: boolean;

  /**
   * The failure to report, or `null` when there is none. Defaults to `null`.
   *
   * The single error shape of the whole API, already normalised by `@/lib/api/client.ts`. A `403`
   * belongs here like any other status: authority is re-checked server-side on every protected
   * operation, so a screen that hid an action can still be refused, and the refusal has to be
   * readable rather than swallowed.
   */
  error?: ProblemDetail | null;

  /** Headline for the empty state. Defaults to a generic line; name the entity if you can. */
  emptyTitle?: string;

  /** Supporting copy for the empty state. @see {@link DataTableProps.emptyTitle} */
  emptyDescription?: string;

  /**
   * The filter region, rendered above the grid.
   *
   * This is how one generic grid is "filterable" without authoring a single filter control: a
   * filter is entity-specific - a role, a post status, a moderation state - and the query state
   * behind it lives in the URL, so both belong to the screen. The grid lays the slot out and reads
   * nothing from it.
   */
  toolbar?: ReactNode;

  /**
   * Optional side effect fired when a page link is clicked, in ADDITION to navigating.
   *
   * Progressive enhancement only. Every page is a real anchor whose href the pagination primitive
   * builds, so turning the page works with this prop absent and with JavaScript disabled; this is
   * the place for something that belongs to the click rather than to the destination, such as
   * scrolling a long grid back to its top.
   */
  onPageChange?: (page: number) => void;

  /**
   * Appended to the outer stack's classes and resolved by `cn`, so a caller's utility reliably wins
   * its property group. This is where the spacing between a screen's heading and its grid belongs.
   */
  className?: string;
}

/**
 * The shared administrative grid: a filter slot, a paginated table that becomes one card per record
 * below 48rem, a result range and a page control.
 *
 * Generic in the row type. Give it columns and a resolved page envelope; it owns the presentation
 * and none of the transport.
 *
 * @typeParam T - The row type, inferred from `columns` and `page` together.
 *
 * @example The comment moderation queue. The screen fetches, this component renders.
 * ```tsx
 * 'use client';
 *
 * export default function AdminCommentsPage() {
 *   const { data, isPending, error } = useQuery({
 *     queryKey: ['admin', 'comments', params],
 *     queryFn: () => listAdminComments(params),
 *   });
 *
 *   return (
 *     <DataTable
 *       caption="Comment moderation queue"
 *       columns={commentColumns}
 *       emptyTitle="Nothing to moderate"
 *       emptyDescription="No comments are awaiting review."
 *       error={error}
 *       getRowId={(comment) => comment.id}
 *       isLoading={isPending}
 *       page={data ?? EMPTY_PAGE}
 *       toolbar={<CommentStatusFilter />}
 *     />
 *   );
 * }
 * ```
 *
 * @param props - See {@link DataTableProps}.
 * @returns The rendered grid.
 */
export function DataTable<T>({
  columns,
  page,
  getRowId,
  caption,
  isLoading = false,
  error = null,
  emptyTitle = DEFAULT_EMPTY_TITLE,
  emptyDescription = DEFAULT_EMPTY_DESCRIPTION,
  toolbar,
  onPageChange,
  className,
}: DataTableProps<T>): JSX.Element {
  /*
   * The tier's single implementation of page arithmetic. It is called for the range line's three
   * numbers and for the two counts this component gates on, and it holds no state and runs no
   * effect, so calling it here as well as inside the page control costs nothing and cannot
   * disagree with it - both derive from the same envelope.
   */
  const view = usePagination(page);

  const resolvedColumns = resolveColumns(columns);

  /*
   * State precedence, evaluated in one place so no two branches can both believe they are showing.
   * loading > error > empty > populated.
   */
  const hasColumns = resolvedColumns.length > 0;
  const showsPlaceholders = isLoading && hasColumns;
  const showsError = !isLoading && error !== null;
  const showsRows = !isLoading && !showsError && hasColumns && !view.isEmpty;
  const showsTable = showsPlaceholders || showsRows;
  const showsEmptyState = !showsTable && !showsError;

  /*
   * The footer is suppressed entirely on failure - a range and a page count derived from an
   * envelope that never arrived would be fiction - and kept in every other state.
   *
   * It is deliberately NOT suppressed for an empty window, because the emptiest window the service
   * produces is a page past the end of a collection that does have rows. The control is the way
   * back from a stale URL, so removing it would strand the reader on a blank page. The range line
   * is dropped there instead, since "0 of 47" beneath a panel already saying there is nothing here
   * adds noise rather than information.
   */
  const showsRange = !showsError && !view.isEmpty;
  const showsPagination = !showsError && view.pages > 1;

  return (
    <div className={cn(ROOT_CLASSES, className)}>
      {toolbar === undefined ? null : <div className={TOOLBAR_CLASSES}>{toolbar}</div>}

      {showsTable ? (
        <Table
          /*
           * `aria-busy` is set only while loading rather than written as "false" when idle: idle is
           * the default state, and an attribute asserting it adds nothing.
           */
          aria-busy={isLoading ? true : undefined}
          /*
           * `caption` reaches the table as its ACCESSIBLE NAME rather than as a `<caption>`
           * element, which is what `@/components/ui/table` documents and demonstrates - that
           * primitive exposes no caption prop, and its `<table>` is styled `caption-bottom`, so a
           * caption element would render as visible text underneath the grid, duplicating the
           * screen's own heading. It would also lose the naming contest: an `aria-label` overrides
           * a `<caption>` in the accessible-name computation, leaving a visible label that no
           * screen reader announces. One naming mechanism, and this is it.
           */
          aria-label={caption}
          containerClassName={TABLE_CONTAINER_CLASSES}
        >
          <TableHeader>
            {/* Exactly one header row. The primitive rules it off from the body itself. */}
            <TableRow>
              {resolvedColumns.map((column) => (
                <TableHead key={column.id} className={column.headClassName}>
                  {column.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>

          <TableBody>
            {showsPlaceholders
              ? Array.from({ length: resolveSkeletonRowCount(page.page_size) }, (_, index) => (
                  <TableRow key={`${SKELETON_ROW_KEY_PREFIX}${index}`}>
                    {resolvedColumns.map((column) => (
                      <TableCell
                        key={column.id}
                        className={column.cellClassName}
                        /*
                         * The labels are drawn while loading too. Below md a cell's layout IS
                         * label plus value, so omitting them would give the placeholder card a
                         * different geometry from the loaded one - and holding the geometry steady
                         * is the entire reason for drawing placeholders instead of a spinner. The
                         * placeholder itself is hidden from assistive technology by the primitive,
                         * and the table is marked busy, so nothing here is announced as data.
                         */
                        label={column.label}
                      >
                        <Skeleton />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : page.items.map((row) => (
                  <TableRow key={getRowId(row)}>
                    {resolvedColumns.map((column) => (
                      <TableCell
                        key={column.id}
                        className={column.cellClassName}
                        label={column.label}
                      >
                        {column.cell(row)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      ) : null}

      {/*
       * The second test is a TYPE NARROWING, not a redundant guard: `showsError` already implies a
       * non-null error, but a boolean cannot carry that fact, so removing the `error !== null` here
       * fails the build. Please do not tidy it away.
       */}
      {showsError && error !== null ? <DataTableError error={error} /> : null}

      {showsEmptyState ? (
        /*
         * `role="status"` is an explicit opt-in on top of the `empty` variant, which carries no
         * live-region role of its own. That default is right for an empty panel the server renders
         * into a page, which should be read in document order like any other content. This grid is
         * the other case the primitive names: it is a client island whose panel appears IN an
         * already-loaded screen, in response to a filter change, a page turn or a deletion, so the
         * change is worth announcing once the reader is idle.
         *
         * It is also the only live region this component renders. The range line beside it is
         * plain text on purpose - a second polite region carrying the same news would have the
         * outcome announced twice.
         */
        <Alert role="status" variant="empty">
          <AlertTitle>{emptyTitle}</AlertTitle>
          <AlertDescription>{emptyDescription}</AlertDescription>
        </Alert>
      ) : null}

      {showsRange || showsPagination ? (
        <div className={FOOTER_CLASSES}>
          {showsRange ? (
            <p className={RANGE_CLASSES}>
              {formatResultRange(view.firstItem, view.lastItem, view.total)}
            </p>
          ) : null}

          {showsPagination ? (
            <Pagination
              /*
               * Named from the grid's own caption so a landmark list can tell this control apart
               * from any other page control on the screen, which is what the primitive asks for
               * when a screen renders more than one.
               */
              ariaLabel={`${caption} pagination`}
              onPageChange={onPageChange}
              page={page.page}
              page_size={page.page_size}
              pages={page.pages}
              total={page.total}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The grid's failure panel.
 *
 * Split out so the branch above stays readable, and kept private because it is meaningless outside
 * this component - a screen that wants to render a problem document on its own uses
 * `@/components/ui/alert` directly.
 *
 * The `destructive` variant is what makes this announce assertively: the primitive derives
 * `role="alert"` from it, so choosing the tone and choosing the announcement are one decision and
 * cannot be set inconsistently.
 *
 * @param error - The normalised problem document to report.
 * @returns The rendered panel.
 */
function DataTableError({ error }: { readonly error: ProblemDetail }): JSX.Element {
  const { headline, explanation } = resolveErrorCopy(error);

  return (
    <Alert variant="destructive">
      <AlertTitle>{headline}</AlertTitle>
      {explanation === null ? null : <AlertDescription>{explanation}</AlertDescription>}
    </Alert>
  );
}
