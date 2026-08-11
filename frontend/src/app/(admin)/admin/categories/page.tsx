'use client';

// /admin/categories - the administrative taxonomy screen.
//
// The "managing ... categories" half of the administrative dashboard, and the one screen where the
// taxonomy the home feed filters by is actually curated. The taxonomy is an implicit prerequisite of
// the product rather than a named feature: the requirement asks for "category filters" and for an
// admin screen "managing ... categories" without ever naming the entity being filtered or managed,
// so this screen and `@/components/admin/category-form` are together what make that entity real.
//
// This file is a PURE CONSUMER. It performs one read, reshapes the answer, describes six columns and
// hands all of it to components that already exist. It contains no HTTP call, no URL for a request,
// no header, no status-code branch, no validation schema, no business rule and no environment read.
//
// ---------------------------------------------------------------------------------------------
// 1. THE READ IS THE *PUBLIC* ENDPOINT, AND IT ANSWERS WITH A BARE ARRAY
//
// Every instinct says "admin screen -> admin list endpoint -> page envelope". All three instincts
// are wrong here, and each one is wrong for a stated reason:
//
//   * THERE IS NO ADMIN CATEGORY LISTING. `@/lib/api/admin` wraps the three category WRITES and no
//     read. The service's public category router carries no authority gate precisely because both
//     of its routes are public reads, so the taxonomy is read from `@/lib/api/categories` - the
//     same call that powers the home page's filter control. That is deliberate rather than
//     incidental: the management table and the reader-facing filter cannot then disagree about what
//     a category is.
//   * `listCategories` RESOLVES TO `CategoryPublic[]`, NOT `Page<CategoryPublic>`. Its own module
//     header calls this the single documented exception to the page-envelope contract across the
//     whole API, because a windowed filter control would offer some terms and silently hide every
//     post filed exclusively under the rest - a wrong answer rather than a partial one, and one no
//     status code reports. So `.items` is never read off what that call resolves to; there is no
//     such property, and reading it would yield `undefined` rather than an error.
//   * THE QUERY KEY STILL CARRIES THE `admin` SCOPE. See section 2.
//
// `DataTable` consumes an envelope, so one is synthesized from the array by {@link toSinglePage}.
//
// ---------------------------------------------------------------------------------------------
// 2. THE QUERY KEY IS SCOPED `admin` EVEN THOUGH THE ENDPOINT IS PUBLIC
//
// `@/components/admin/category-form` invalidates the two-segment prefix `['admin', 'categories']`
// after every create, rename and delete. React Query matches an invalidation by PREFIX, so a key
// beginning `['categories', ...]` would never be reached by those mutations - and nothing would
// report it. There is no error to observe, no failed request and no console warning: a create would
// succeed, its toast would appear, and the grid in front of the operator would silently keep showing
// the taxonomy as it was. That failure mode is why the key is stated here rather than left to
// convention, and why {@link ADMIN_CATEGORIES_QUERY_KEY} carries the reasoning next to the literal.
//
// ---------------------------------------------------------------------------------------------
// 3. THE WHOLE WRITE LIFECYCLE BELONGS TO ONE COMPONENT, WHICH IS WHY THIS FOLDER HOLDS ONE FILE
//
// Create, rename AND delete all live in `@/components/admin/category-form`, discriminated by a
// single optional `category` prop: absent creates, present renames and additionally reveals the
// delete affordance behind its own Radix confirmation dialog. So this screen mounts that component
// twice over - once in create mode as a panel, and once per row in rename mode inside the row-action
// cell - and that is the entire lifecycle. Nothing here imports a mutation, wraps one, or builds a
// second confirmation dialog; a second mutation path would be a second place for the invalidation
// graph to be got wrong.
//
// ---------------------------------------------------------------------------------------------
// 4. WHAT THIS SCREEN DELIBERATELY DOES NOT DO
//
//   * NO PAGINATION CONTROL, AND NOT BY OMISSION. The synthesized envelope reports one page, and
//     `@/components/ui/pagination` renders nothing at a single page - so the un-windowed contract
//     renders as the absence of a control rather than as a control with one disabled option. The
//     grid is still the only presentation layer: this file authors no empty state, no error panel,
//     no loading state and no responsive behaviour, because `DataTable` owns all four.
//   * NO CLIENT-SIDE FILTER OR SORT. `GET /categories` accepts no query parameter and returns the
//     complete taxonomy, so narrowing it here would be a presentation-tier business rule with no
//     server counterpart - two definitions of "the categories" instead of one.
//   * NO SLUG EDITING. A slug is derived server-side from the name with collision suffixing, and it
//     backs a canonical URL that must never change. It is shown, and only shown. The form's own
//     schemas accept no slug at all, so this is enforced a layer down as well as respected here.
//   * NO CLIENT-SIDE DELETE GUARD. See {@link CategoryRowActions}, which explains why the count in
//     the table cannot predict whether a delete will succeed.
//   * NO ROLE CHECK, NO SESSION GATE, NO SECTION NAVIGATION AND NO LANDMARK. The route group's
//     layout resolves the principal and withholds this page entirely while the session is pending,
//     signed out, unknown or not an administrator, and it owns the navigation between the five
//     administrative screens. The root layout owns the document shell, the `<main>` landmark, the
//     three providers and the toast host. This file contributes the one `<h1>` the layout
//     deliberately leaves to it, and calls `toast` without mounting a second host.
//
// ---------------------------------------------------------------------------------------------
// 5. EVERY VALUE IS A TOKEN
//
// There is no literal colour, length, radius, shadow or font size below, no `style` prop, no media
// query and no primitive colour family name. Every class resolves to a token declared in
// `src/app/globals.css`, and every colour to one of that file's semantic tokens, so the screen
// themes light and dark with no conditional logic anywhere in this file.

import { useEffect, useMemo, useState, type JSX } from 'react';

import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import { CategoryForm } from '@/components/admin/category-form';
import { DataTable, type DataTableColumn } from '@/components/admin/data-table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { listCategories } from '@/lib/api/categories';
import { isApiError } from '@/lib/api/client';
import { formatCount, formatDate, formatMachineDate } from '@/lib/format';
import type { CategoryPublic, Page } from '@/lib/types';
import { cn, FIRST_PAGE, toPageNumber } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Addresses and query state
 * ---------------------------------------------------------------------------------------------- */

/**
 * This screen's own address, used by the notice in {@link UnwindowedPageNotice} to offer the way
 * back to the canonical URL.
 *
 * The RENDERED path, never the source path. A route group's parentheses organise the filesystem and
 * never appear in a URL, so `/admin/categories` is what the middleware matches, what the crawl
 * policy disallows and what the section navigation links to. A parenthesised literal here would be a
 * link to a route that does not exist.
 */
const ADMIN_CATEGORIES_PATH = '/admin/categories';

/** The public feed's path. A category's page IS the category-filtered feed - see {@link categoryFeedHref}. */
const FEED_PATH = '/';

/** The feed's category filter parameter, as {@link categoryFeedHref} spells it. */
const CATEGORY_PARAM = 'category';

/** The page parameter every windowed surface in this product reads. */
const PAGE_PARAM = 'page';

/**
 * The cache key for the taxonomy, and the single most consequential literal in this file.
 *
 * It MUST begin `['admin', 'categories']`, because that is the exact prefix
 * `@/components/admin/category-form` invalidates after a create, a rename and a delete. See section
 * 2 of the module header for what silently breaks if the `admin` segment is dropped.
 *
 * The prefix is written here as a literal rather than imported from the cache module that also
 * declares it, because that module is outside this file's declared dependency boundary. What the two
 * have to agree on is the prefix and nothing else - React Query's invalidation matches by prefix, so
 * an identical two-segment key is not merely equivalent to the shared constant, it is the same key.
 *
 * No third segment: there are no request parameters to key on. `GET /categories` takes no window and
 * no filter, so every render of this screen wants the same single cache entry, and appending a page
 * number read from the URL would fragment one taxonomy into several identical copies.
 */
const ADMIN_CATEGORIES_QUERY_KEY = ['admin', 'categories'] as const;

/**
 * Identifier of the toast raised when the taxonomy read is REFUSED rather than merely failing.
 *
 * A fixed identifier makes the notification idempotent: sonner replaces a toast that already carries
 * the id instead of stacking a second one. That is what keeps a re-render, a retry or a development
 * double-invoked effect from queueing the same sentence twice, without this file holding a
 * "have I already said this" flag of its own.
 */
const AUTHORISATION_TOAST_ID = 'admin-categories-authorisation';

/* -------------------------------------------------------------------------------------------------
 * The synthesized page envelope
 *
 * `DataTable` reads the five wire fields of `Page<T>` - `items`, `total`, `page`, `page_size` and
 * `pages` - under exactly those snake_case names, because there is no camelCase mapping layer
 * anywhere in this tier. The taxonomy arrives as a bare array, so the envelope is built here.
 * ---------------------------------------------------------------------------------------------- */

/**
 * How many pages an un-windowed collection occupies.
 *
 * One, always - and it is a page COUNT rather than a page index, which is why it is named separately
 * from `FIRST_PAGE` even though both are `1`. Reporting one page is what makes the grid render no
 * pagination control at all, which is the correct rendering of a contract that has no window: a
 * control offering a single page would imply there could be a second.
 */
const UNWINDOWED_PAGE_COUNT = 1;

/**
 * Wraps the whole taxonomy in the envelope shape the grid consumes.
 *
 * `total` and `page_size` are both the array's length, which is the honest description of a
 * collection returned in one un-windowed piece: every row the service has is on this page, so the
 * window is exactly as large as the result. `page` is the first page and `pages` is one.
 *
 * The return type is declared rather than inferred, so the five field names are checked by the
 * compiler at the point they are written. A misspelling - `pageSize` for `page_size` - would
 * otherwise produce an object that type-checks against a widened inference and reads `undefined` at
 * run time. No cast appears here and none is needed; if this stops compiling, the envelope is wrong.
 *
 * @param items - The taxonomy exactly as `listCategories` resolved it.
 * @returns A single-page envelope over those rows.
 */
function toSinglePage(items: CategoryPublic[]): Page<CategoryPublic> {
  return {
    items,
    total: items.length,
    page: FIRST_PAGE,
    page_size: items.length,
    pages: UNWINDOWED_PAGE_COUNT,
  };
}

/**
 * The envelope shown before the first response arrives, and after a failure.
 *
 * A real envelope rather than a nullable prop, so the grid's own state precedence - loading, then
 * error, then empty, then populated - decides what appears, and this file never has to. Its
 * `page_size` of zero is read by the grid only to size its placeholder rows, which fall back to a
 * default when the window is not yet known.
 */
const EMPTY_TAXONOMY: Page<CategoryPublic> = toSinglePage([]);

/* -------------------------------------------------------------------------------------------------
 * Copy
 *
 * Hoisted so the markup below reads as structure rather than as prose, and so a wording change is
 * one edit in one place.
 * ---------------------------------------------------------------------------------------------- */

/** The document's single `<h1>` for this route. Matches the layout's own navigation label. */
const PAGE_HEADING = 'Categories';

/** Sets out what the screen is for, including the two facts an operator most needs to know. */
const PAGE_INTRO =
  'Curate the taxonomy readers filter the feed by. A category’s address is derived from its name ' +
  'when it is created and never changes afterwards, and its tally counts published posts only.';

/** Names the create panel. Rendered as the page's only `<h2>`. */
const CREATE_PANEL_TITLE = 'New category';

/** Explains what happens on submit, so the derived address is not a surprise. */
const CREATE_PANEL_HINT =
  'Name it, describe it if that helps, and its permanent address is derived for you.';

/** The grid's accessible name. Distinguishes this table from the other administrative grids. */
const TABLE_CAPTION = 'Categories';

/** Column headings, and - through the grid - the field names shown inside a record card below 48rem. */
const COLUMN_HEADINGS = {
  name: 'Name',
  slug: 'Address',
  description: 'Description',
  postCount: 'Published posts',
  createdAt: 'Created',
  actions: 'Actions',
} as const;

/** Stands in for a category that carries no description, so the cell is never blank. */
const NO_DESCRIPTION_PLACEHOLDER = 'No description';

/**
 * Stands in for a value the wire supplied but that could not be rendered.
 *
 * Shared by the two cells whose formatter is total and therefore answers an unusable input with an
 * empty string rather than by throwing: an instant that did not parse, and a tally that is not a
 * usable count. In both cases the honest rendering is a word saying so, because an empty cell reads
 * as a rendering fault while a receded label reads as missing information.
 */
const UNKNOWN_VALUE_PLACEHOLDER = 'Unknown';

/** Row-action labels. Each is completed by the category's name for assistive technology. */
const VIEW_LABEL = 'View';
const EDIT_LABEL = 'Edit';

/** Names the rename dialog. Completed with the category's name at render time. */
const EDIT_DIALOG_TITLE_PREFIX = 'Edit';

/** Sets out what the rename dialog can do, including the delete it also carries. */
const EDIT_DIALOG_DESCRIPTION =
  'Rename this category or change its description. Its address stays as it is. Deleting it is also ' +
  'available here, and asks for confirmation first.';

/** The grid's empty state. Named for the entity rather than left generic. */
const EMPTY_TITLE = 'No categories yet';
const EMPTY_DESCRIPTION =
  'Create the first one above. Until at least one exists, readers have nothing to filter the feed by.';

/** The notice shown when the address asks for a page this collection does not have. */
const UNWINDOWED_NOTICE_TITLE = 'Every category is already on this page';
const UNWINDOWED_NOTICE_DETAIL =
  'The taxonomy is returned complete rather than a page at a time, so the page number in this ' +
  'address does not narrow it. The whole list is below.';
const UNWINDOWED_NOTICE_ACTION = 'Tidy the address';

/** The refusal message. Deliberately actionable, which is what the grid's own panel cannot be. */
const AUTHORISATION_TOAST_MESSAGE =
  'The taxonomy could not be read because the request was refused. Sign in again as an ' +
  'administrator, then reload this screen.';

/* -------------------------------------------------------------------------------------------------
 * Token-derived class constants
 *
 * Every value below resolves to a token declared in `src/app/globals.css`: the spacing steps to the
 * `--spacing` multiplier, the type sizes to the `--text-*` scale, the measures to `--container-*`,
 * and the two colours to the semantic layer (`--color-foreground`, `--color-muted-foreground`)
 * rather than to any primitive colour family. There is no literal length, colour, radius or font
 * size here, and no breakpoint outside the engine's own five.
 * ---------------------------------------------------------------------------------------------- */

/** The page's vertical rhythm. The route group's layout supplies the horizontal frame. */
const PAGE_CLASSES = 'flex min-w-0 flex-col gap-6';

/** The heading band. `min-w-0` so a long line wraps rather than widening the grid beside it. */
const HEADER_CLASSES = 'flex min-w-0 flex-col gap-2';

/** The `<h1>`. */
const HEADING_CLASSES = 'text-foreground text-2xl font-semibold tracking-tight';

/**
 * The secondary-text treatment five surfaces on this screen share.
 *
 * Declared once so the introduction, the create panel's hint, a row's date, an absent description and
 * a permanent address cannot drift apart. The constants that extend it below compose through `cn`
 * rather than by string concatenation, which is what makes the extension deterministic: `cn` runs
 * tailwind-merge's conflict resolver, so a later utility in the SAME property group wins - and
 * {@link SLUG_CLASSES} depends on exactly that, since `text-xs` and the `text-sm` here are one group
 * and their relative order in a class attribute would otherwise decide nothing at all.
 */
const SECONDARY_TEXT_CLASSES = 'text-muted-foreground text-sm';

/** The introduction, held to a readable measure. */
const INTRO_CLASSES = cn(SECONDARY_TEXT_CLASSES, 'max-w-2xl');

/** The create panel's supporting line, inside the card header. */
const PANEL_HINT_CLASSES = SECONDARY_TEXT_CLASSES;

/**
 * Available to assistive technology, absent from the layout, and still in the accessibility tree.
 *
 * Used to complete a repeated row-action label with the record it acts on. Hoisted because it appears
 * on every row's two controls and because every other class on this screen is named here too.
 */
const VISUALLY_HIDDEN_CLASSES = 'sr-only';

/**
 * Stacks the notice's body text above its own action.
 *
 * A flex column with a `gap`, applied to the description part, rather than a top margin on the
 * action beneath it. That distinction matters here rather than being pedantry: the alert primitive's
 * root is already a `grid` with its own token gap, so a margin on a child would be a sibling margin
 * layered on an existing gap - two spacing mechanisms competing over the same edge, which is exactly
 * what the design rules forbid. Owning a container of my own means the separation is expressed once,
 * as a gap, inside something this file controls.
 *
 * `items-start` keeps the control at its intrinsic width instead of stretching it across the panel,
 * which a column flex container would otherwise do.
 */
const NOTICE_BODY_CLASSES = 'flex flex-col items-start gap-3';

/** The action row itself. Wraps rather than overflowing if the label ever grows. */
const NOTICE_ACTION_CLASSES = 'flex flex-wrap gap-2';

/**
 * The rename dialog's panel.
 *
 * Widened from the primitive's default measure at the small breakpoint and up, because the form
 * inside carries two controls, a read-only fact list and two actions. Below that width the
 * primitive's own padding governs, so the panel still fits a narrow viewport.
 */
const EDIT_DIALOG_CLASSES = 'sm:max-w-2xl';

/** The row-action group. One element, as a cell with several parts has to be. */
const ROW_ACTIONS_CLASSES = 'flex min-w-0 flex-wrap items-center gap-2';

/**
 * A category's permanent address, monospaced from the `--font-mono` token so it reads as an
 * identifier rather than as prose.
 *
 * `text-xs` is composed over the shared base's `text-sm` deliberately: an address is supporting
 * detail beside the name it was derived from. Both are the same property group, so this is the
 * composition that would be ambiguous without `cn`.
 */
const SLUG_CLASSES = cn(SECONDARY_TEXT_CLASSES, 'font-mono text-xs');

/** A description, clamped to two lines so one long entry cannot set the height of every row. */
const DESCRIPTION_CLASSES = 'text-foreground line-clamp-2 max-w-prose text-sm';

/** The placeholder that stands in for an absent value. Receded, never blank. */
const PLACEHOLDER_CLASSES = cn(SECONDARY_TEXT_CLASSES, 'italic');

/** A tally. `tabular-nums` keeps a column of counts aligned on its digits. */
const COUNT_CLASSES = 'tabular-nums';

/** An instant. */
const DATE_CLASSES = SECONDARY_TEXT_CLASSES;

/* -------------------------------------------------------------------------------------------------
 * Row helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * The public address of a category's page.
 *
 * A category has no route of its own: its page IS the category-filtered feed, which is why this
 * produces `/?category={slug}` rather than a `/categories/{slug}` URL the application does not
 * serve. The generated sitemap enumerates category pages in exactly that form.
 *
 * `URLSearchParams` does the escaping, which is not merely defensive - it is what makes this string
 * byte-identical to the canonical builder the reader-facing surfaces use, since that builder is
 * `URLSearchParams`-based too and encodes a space as `+` where `encodeURIComponent` would emit
 * `%20`. Two spellings of one address would be two URLs for one result set.
 *
 * @param slug - {@link CategoryPublic.slug}, the server-derived permanent address segment.
 * @returns A root-relative feed address filtered to that category.
 */
function categoryFeedHref(slug: string): string {
  const query = new URLSearchParams({ [CATEGORY_PARAM]: slug });

  return `${FEED_PATH}?${query.toString()}`;
}

/**
 * Stable identity for one row.
 *
 * Never an array index: the grid re-renders this table after every mutation, and an index key would
 * let React reuse one record's DOM - and one row's open rename dialog - for another. Every category
 * carries a server-generated identifier, so there is a real key to use.
 *
 * @param category - The row.
 * @returns Its identifier.
 */
function getCategoryRowId(category: CategoryPublic): string {
  return category.id;
}

/* -------------------------------------------------------------------------------------------------
 * Row actions
 * ---------------------------------------------------------------------------------------------- */

/**
 * One row's two affordances: a link to the category's public page, and the rename dialog that also
 * carries its deletion.
 *
 * ## Why this is a component rather than an inline cell
 *
 * The rename form needs somewhere to be, and a full form cannot live in a table cell at table width.
 * A dialog is the natural container, and a dialog needs open state - which, held here, is HELD PER
 * ROW. That is what lets {@link CATEGORY_COLUMNS} be a module-level constant rather than something
 * rebuilt on every render: the column definitions close over nothing, because the only state on this
 * screen that varies by row lives inside this component. The grid's props type is a `ReadonlyArray`
 * specifically to make that arrangement expressible.
 *
 * ## The delete confirmation is NOT here, and must not be added
 *
 * `CategoryForm` in rename mode already carries it, as a Radix dialog with focus trapping,
 * escape-to-close and the title/description wiring the primitive supplies. This component nests its
 * own dialog around that one, which Radix supports as a layer stack - escape dismisses the topmost
 * only. Authoring a second confirmation here would duplicate that behaviour and, worse, would create
 * a delete path that does not run the same cache invalidation.
 *
 * ## The delete affordance is never disabled from the count in the table
 *
 * It would be wrong twice over. First, authority is a server concern: hiding or disabling a control
 * is a user-experience decision, never a security boundary, and the service re-checks on every
 * protected operation. Second - and this is the part the count makes tempting - the service refuses
 * to delete a category while AT LEAST ONE post of ANY lifecycle state is filed under it, whereas
 * `post_count` counts PUBLISHED posts only. A tally of zero therefore does not mean the category is
 * deletable: a single unpublished draft filed under it still blocks the delete. The client cannot
 * predict the outcome at all, so it does not try. The form asks the service and shows the refusal it
 * gets back, which names the actual remedy.
 *
 * @param props.category - The row this group acts on.
 * @returns The row's action group, as a single element.
 */
function CategoryRowActions({ category }: { readonly category: CategoryPublic }): JSX.Element {
  const [editing, setEditing] = useState(false);

  /**
   * Closes the dialog after a save or a delete.
   *
   * The form awaits its cache invalidation before calling back, so by the time this runs the grid
   * behind the dialog has already been refetched - the operator is returned to a table that reflects
   * what they just did, rather than to one that is about to change under them.
   */
  function closeEditor(): void {
    setEditing(false);
  }

  return (
    <div className={ROW_ACTIONS_CLASSES}>
      {/* A real anchor, so the public page opens with a middle click, a modifier click or a
          right-click exactly as any other link does. `asChild` merges the button's appearance onto
          the link rather than wrapping it, so no extra element is added and no click handler is
          needed to navigate. */}
      <Button asChild size="sm" variant="ghost">
        <Link href={categoryFeedHref(category.slug)}>
          <ExternalLink aria-hidden="true" />
          {VIEW_LABEL}
          {/* Every row repeats the same two visible labels, so on their own they announce as a list
              of identical controls. The suffix is available to assistive technology and absent from
              the layout, which is what makes each control's accessible name unambiguous without
              widening the column. */}
          <span className={VISUALLY_HIDDEN_CLASSES}>{`: ${category.name}`}</span>
        </Link>
      </Button>

      <Dialog onOpenChange={setEditing} open={editing}>
        <DialogTrigger asChild>
          <Button size="sm" type="button" variant="secondary">
            <Pencil aria-hidden="true" />
            {EDIT_LABEL}
            <span className={VISUALLY_HIDDEN_CLASSES}>{`: ${category.name}`}</span>
          </Button>
        </DialogTrigger>
        <DialogContent className={EDIT_DIALOG_CLASSES}>
          <DialogTitle>{`${EDIT_DIALOG_TITLE_PREFIX} “${category.name}”`}</DialogTitle>
          <DialogDescription>{EDIT_DIALOG_DESCRIPTION}</DialogDescription>
          {/*
           * Rename mode, selected by the presence of `category` and nothing else. The form shows the
           * permanent address and the published tally as read-only facts, so this dialog does not
           * restate them, and it re-seeds itself from whatever the service actually stored.
           */}
          <CategoryForm category={category} onDeleted={closeEditor} onSuccess={closeEditor} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Columns
 *
 * A module-level constant, which the grid's `ReadonlyArray` prop type exists to allow: nothing here
 * closes over component state, so the array is identical on every render and the grid re-resolves no
 * column presentation it does not have to.
 *
 * EVERY column carries a `label`. Below 48rem the grid's own primitive hides the header band with
 * `display: none`, which removes the `<th>` elements from the accessibility tree as well as from the
 * layout - so at that width the label is the only thing that says which field a value came from,
 * visually and to a screen reader alike. The action column is the one documented exception: an empty
 * string suppresses the label for a cell that describes itself, and a field name printed beside two
 * buttons reads as a mislabelled control.
 * ---------------------------------------------------------------------------------------------- */

const CATEGORY_COLUMNS: ReadonlyArray<DataTableColumn<CategoryPublic>> = [
  {
    id: 'name',
    header: COLUMN_HEADINGS.name,
    label: COLUMN_HEADINGS.name,
    cell: (category) => category.name,
  },
  {
    id: 'slug',
    header: COLUMN_HEADINGS.slug,
    label: COLUMN_HEADINGS.slug,
    /*
     * Read-only, and this is the only place the slug appears on this screen. It is derived from the
     * name by the service, de-duplicated on collision, and constrained unique, because it is the
     * canonical URL a published category page is indexed under. Editing it would change that URL and
     * break every link and every crawled entry pointing at it, which is why no control here offers
     * to - and why the form's schemas accept no slug either.
     */
    cell: (category) => <code className={SLUG_CLASSES}>{category.slug}</code>,
  },
  {
    id: 'description',
    header: COLUMN_HEADINGS.description,
    label: COLUMN_HEADINGS.description,
    /*
     * The ONE column demoted below 64rem, which is what makes the widest tier "the full table with
     * every column" rather than merely the same table with more room.
     *
     * It is the right one to demote on both counts the flag is meant to weigh. It is the least
     * actionable field on the screen - an operator scanning the taxonomy is reading names, tallies and
     * addresses, and reaches for a description only once they have picked a row, at which point the
     * rename dialog shows it in full. And it is by far the longest: a description runs to several
     * hundred characters, so on the record card at 375 it would occupy more height than the other five
     * fields together while the flag's own documentation notes that card is already a record's tallest
     * presentation. The date beside it is a single short line and stays, because a value that cheap to
     * show should not be hidden from two of the three viewports.
     */
    hideBelowLg: true,
    /*
     * Nullable on the wire. React renders neither `null` nor `undefined` as text, so an absent
     * description would leave a silently blank cell - which reads as a rendering fault rather than as
     * "there is nothing here". A receded placeholder says which of the two it is.
     */
    cell: (category) =>
      category.description === null ? (
        <span className={PLACEHOLDER_CLASSES}>{NO_DESCRIPTION_PLACEHOLDER}</span>
      ) : (
        <p className={DESCRIPTION_CLASSES}>{category.description}</p>
      ),
  },
  {
    id: 'post_count',
    header: COLUMN_HEADINGS.postCount,
    label: COLUMN_HEADINGS.postCount,
    align: 'end',
    /*
     * `neutral` is the variant for a value with no state semantics - the primitive's own
     * documentation names a count as the example - so the pill carries no lifecycle tone it was never
     * given. The count is abbreviated past a thousand by the shared formatter, and ZERO is a real,
     * meaningful tally that renders as `0` rather than as a placeholder: a category nothing is filed
     * under yet is exactly what an operator is looking for when they consider deleting one.
     *
     * The guard covers the rest of the value domain rather than assuming the seeded data describes
     * it. `post_count` is a plain `number` on the wire and its decoder is a bare number check - not
     * the integer-and-non-negative check some sibling counts use - so a negative or non-finite tally
     * is admissible by the contract even though a `COUNT` aggregate should never produce one. The
     * shared formatter answers exactly those with an empty string, and an EMPTY PILL is worse than no
     * pill: a bordered chip with nothing inside reads as a broken render, where a receded word reads
     * as a value that could not be shown. Zero never reaches this branch, which is the distinction
     * that matters - "none filed" and "not a usable number" are different facts and look different.
     */
    cell: (category) => {
      const tally = formatCount(category.post_count);

      if (tally === '') {
        return <span className={PLACEHOLDER_CLASSES}>{UNKNOWN_VALUE_PLACEHOLDER}</span>;
      }

      return (
        <Badge className={COUNT_CLASSES} variant="neutral">
          {tally}
        </Badge>
      );
    },
  },
  {
    id: 'created_at',
    header: COLUMN_HEADINGS.createdAt,
    label: COLUMN_HEADINGS.createdAt,
    /*
     * An ISO-8601 string on the wire, rendered as both forms at once: the human label inside the
     * element and the machine-readable instant in its attribute, so assistive technology receives an
     * unambiguous date rather than a phrase it has to parse. Both formatters resolve in UTC, so the
     * same instant produces the same string on the server and in every browser.
     *
     * The guard is what stops a `<time>` element being emitted with an empty attribute: the
     * formatters are total and answer an unparseable or absent value with an empty string rather than
     * throwing, so the placeholder branch is reachable and is a legible word rather than a blank.
     */
    cell: (category) => {
      const machineDate = formatMachineDate(category.created_at);

      if (machineDate === '') {
        return <span className={PLACEHOLDER_CLASSES}>{UNKNOWN_VALUE_PLACEHOLDER}</span>;
      }

      return (
        <time className={DATE_CLASSES} dateTime={machineDate}>
          {formatDate(category.created_at)}
        </time>
      );
    },
  },
  {
    id: 'actions',
    header: COLUMN_HEADINGS.actions,
    /* Suppressed deliberately - see the note above this array. */
    label: '',
    align: 'end',
    cell: (category) => <CategoryRowActions category={category} />,
  },
];

/* -------------------------------------------------------------------------------------------------
 * The un-windowed-address notice
 * ---------------------------------------------------------------------------------------------- */

/**
 * Reconciles an address that asks for a page with a collection that has only one.
 *
 * Every other windowed surface in this product keeps its page in the URL, so `?page=3` is a perfectly
 * ordinary thing to arrive here carrying - from a bookmark, a shared link, or a hand-edited address.
 * This screen honours it in the only way it can: the taxonomy is returned complete, so the whole list
 * is shown. Saying so is what keeps the address and the screen from disagreeing silently, which is
 * the failure this notice exists to prevent - a reader who asked for page three and was given
 * everything has no way to tell whether they were served or ignored.
 *
 * No `role` is passed. The `info` variant derives no live-region role, which is that primitive's
 * documented default for ordinary page content, and this notice is present on first paint rather than
 * appearing in response to something the operator just did - so it is read in document order like any
 * other content instead of interrupting.
 *
 * @returns The notice, carrying the way back to the canonical address.
 */
function UnwindowedPageNotice(): JSX.Element {
  return (
    <Alert variant="info">
      <AlertTitle>{UNWINDOWED_NOTICE_TITLE}</AlertTitle>
      {/*
       * The body and the action share ONE grid item, laid out by this file's own flex column. The
       * alert's root supplies the gap between its title and this block; everything inside this block
       * is spaced by the gap declared on it. See {@link NOTICE_BODY_CLASSES}.
       */}
      <AlertDescription className={NOTICE_BODY_CLASSES}>
        <p>{UNWINDOWED_NOTICE_DETAIL}</p>
        <div className={NOTICE_ACTION_CLASSES}>
          {/* An anchor rather than a handler: the canonical address is a real destination, so it is
              shareable, and it works before this island has hydrated. */}
          <Button asChild size="sm" variant="secondary">
            <Link href={ADMIN_CATEGORIES_PATH}>{UNWINDOWED_NOTICE_ACTION}</Link>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/* -------------------------------------------------------------------------------------------------
 * The page
 * ---------------------------------------------------------------------------------------------- */

/**
 * The administrative taxonomy screen at `/admin/categories`.
 *
 * Reads the taxonomy once, reshapes it into the envelope the shared grid consumes, and mounts
 * `CategoryForm` twice - once as a create panel, once per row in rename mode - which is the whole
 * create/rename/delete lifecycle without a second file or a second mutation path.
 *
 * A client component, because the column definitions carry render functions and a function cannot
 * cross the server-to-client boundary, and because the read is a cached client query the write
 * components invalidate. It exports no metadata: a client component cannot, and the root layout owns
 * the document's title template.
 *
 * @returns The screen.
 */
export default function AdminCategoriesPage(): JSX.Element {
  /*
   * Query state lives in the address, never in component state - read the same way every windowed
   * surface in this product reads it, so a page number means the same thing on all of them. The
   * shared parser answers `null` for anything that is not a usable page number, which collapses a
   * blank, a negative, a fraction and a hand-typed word onto the first page rather than onto a
   * notice about a page that was never requested.
   */
  const searchParams = useSearchParams();
  const requestedPage = toPageNumber(searchParams.get(PAGE_PARAM)) ?? FIRST_PAGE;

  /*
   * The one read. Every option is inherited from the tier's provider - the freshness window, the
   * refusal to refetch on window focus, and the retry predicate that declines to retry a 4xx - so
   * nothing is restated here that could then drift away from the other administrative screens.
   *
   * The abort signal React Query supplies is forwarded, so a refetch triggered by an invalidation
   * cancels the request it supersedes instead of racing it.
   */
  const { data, error, isPending } = useQuery({
    queryKey: ADMIN_CATEGORIES_QUERY_KEY,
    queryFn: ({ signal }): Promise<CategoryPublic[]> => listCategories({ signal }),
  });

  /*
   * The bare array becomes the five-field envelope the grid consumes. `data` is the array itself -
   * there is no `.items` on it to read - so the reshape is explicit, and typed, at exactly one place.
   */
  const taxonomy = useMemo(
    (): Page<CategoryPublic> => (data === undefined ? EMPTY_TAXONOMY : toSinglePage(data)),
    [data],
  );

  /*
   * The read is a PUBLIC endpoint, so it does not normally refuse anyone - which is precisely why a
   * refusal here is worth calling out rather than leaving inside a generic failure panel. It means the
   * credential attached to the request was rejected, not that the operator lacks a privilege this
   * screen needed, so the actionable remedy is to sign in again rather than to ask for access.
   *
   * The grid still renders the failure itself, from the same `error`, including the problem document
   * the service sent. This adds the one sentence that document cannot contain, on a channel that does
   * not duplicate the panel; the fixed toast identifier keeps it to one sentence however many times
   * this effect runs.
   */
  useEffect((): void => {
    if (isApiError(error) && (error.status === 401 || error.status === 403)) {
      toast.error(AUTHORISATION_TOAST_MESSAGE, { id: AUTHORISATION_TOAST_ID });
    }
  }, [error]);

  return (
    <div className={PAGE_CLASSES}>
      <div className={HEADER_CLASSES}>
        {/* The route group's layout deliberately emits no heading in its authorised state, so this is
            the document's only `<h1>` on this screen. */}
        <h1 className={HEADING_CLASSES}>{PAGE_HEADING}</h1>
        <p className={INTRO_CLASSES}>{PAGE_INTRO}</p>
      </div>

      {requestedPage === FIRST_PAGE ? null : <UnwindowedPageNotice />}

      <Card>
        <CardHeader>
          <CardTitle as="h2">{CREATE_PANEL_TITLE}</CardTitle>
          <p className={PANEL_HINT_CLASSES}>{CREATE_PANEL_HINT}</p>
        </CardHeader>
        <CardContent>
          {/*
           * Create mode, selected by the absence of a `category` prop. Presented inline rather than
           * behind a dialog: it is the panel an operator arrives here to use, it clears itself and
           * announces its own success, and an always-visible form needs no affordance to reach it.
           */}
          <CategoryForm />
        </CardContent>
      </Card>

      {/*
       * The grid owns its loading, error, empty and populated states, its result range, its page
       * control and the collapse to one card per record below 48rem. This screen hands it data and
       * flags and takes none of that on: four administrative tables share this one implementation
       * precisely because none of them re-implements any of it.
       */}
      <DataTable
        caption={TABLE_CAPTION}
        columns={CATEGORY_COLUMNS}
        emptyDescription={EMPTY_DESCRIPTION}
        emptyTitle={EMPTY_TITLE}
        error={error}
        getRowId={getCategoryRowId}
        isLoading={isPending}
        page={taxonomy}
      />
    </div>
  );
}
