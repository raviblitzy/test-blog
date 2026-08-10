'use client';

// category-filter.tsx - the home feed's category picker.
//
// One of the three controls that together satisfy the feed requirement "display recent blogs with
// search, category filters, and pagination". Its siblings are search-input.tsx and
// src/components/ui/pagination.tsx, and all three share one discipline: they own a SLICE of the
// URL's query string and nothing else. This file owns `category`. It also deletes `page`, because
// a new filter invalidates the reader's position in the old result set. It never reads or writes
// `q` or `sort`.
//
// ---------------------------------------------------------------------------
// 1. THE TAXONOMY ARRIVES AS A BARE ARRAY, NOT AS A PAGE
//
// `listCategories` in @/lib/api/categories answers `CategoryPublic[]` - the ONE collection in this
// API that is not wrapped in `Page<T>`, and a specified exception rather than an oversight. The
// array *is* this control, so a window could hide the posts filed under whatever fell outside it.
//
// So there is no `.items` anywhere below, no `total`, no `pages`, and no pager. Reaching for the
// envelope here is the single most likely defect in this file, and typing the prop as
// `CategoryPublic[]` is what makes the compiler catch it.
//
// `CategoryPublic` rather than `CategorySummary` is equally deliberate. The slim projection
// embedded in a post carries `id`, `name` and `slug` only; the full one adds `post_count`, and
// @/lib/types records that the public collection is "the one endpoint the plan gives post counts
// to *because it powers this filter control*". Section 6 spends that field.
//
// ---------------------------------------------------------------------------
// 2. THE "ALL CATEGORIES" SENTINEL, AND WHY IT IS NOT `''` AND NOT `'all'`
//
// Radix has no concept of an option that clears the selection. Verified in the installed
// @radix-ui/react-select@2.3.7: `shouldShowPlaceholder(value)` returns `value === "" || value ===
// undefined`, so an item whose `value` is the empty string is INDISTINGUISHABLE from "nothing is
// selected" - the trigger would fall back to its placeholder, the check indicator would never
// appear, and the item would additionally be mistaken for the native mirror's empty option. An
// unfiltered feed is a real, choosable state here, so it needs a real, non-empty value.
//
// `'all'` is the obvious sentinel and it is UNSAFE. Category slugs are derived from names by
// backend/app/core/slug.py, and that module was exercised directly to check: `slugify('All')`,
// `slugify('ALL')` and `slugify('__all__')` all produce exactly `'all'`. A category legitimately
// named "All" would therefore own the slug `all` and be permanently unselectable, silently.
//
// ALL_CATEGORIES_VALUE is `'__all__'` for that reason. The same experiment is what proves it safe:
// slug derivation lower-cases to ASCII alphanumerics joined by single hyphens and strips leading
// and trailing separators, so it CANNOT emit a leading underscore. No slug can ever equal the
// sentinel, in either direction - a stale `?category=__all__` matches no supplied slug and falls
// back to the unfiltered state, which is exactly what that URL means anyway.
//
// The sentinel is a VIEW value and never a URL value. Choosing it DELETES the parameter rather
// than writing `category=__all__` or `category=all`, so the unfiltered feed has exactly one
// canonical URL. Two URLs for one result set is duplicate content on a page built to be crawled.
//
// ---------------------------------------------------------------------------
// 3. THE URL IS THE ONLY STATE. THERE IS NO `useState` IN THIS FILE.
//
// The selection is DERIVED from `useSearchParams()` on every render, never mirrored into local
// state. That is not a stylistic preference; it is what makes the control correct in four
// situations a `useState` mirror gets wrong:
//
//   * Back and Forward. The URL moves without this component being told, and a derived value has
//     already followed it. A mirror would keep displaying the previous category.
//   * A shared or crawled link. `/?category=engineering` arrives with the picker already showing
//     "Engineering", because there is nothing to synchronise.
//   * A sibling control navigating. search-input.tsx pushes `q` while preserving `category`; a
//     mirror would have to reconcile, and reconciliation is where feed controls grow loops.
//   * Server truth. The feed's Server Component reads the same parameters this control writes, so
//     the picker and the posts beneath it cannot disagree.
//
// search-input.tsx DOES hold one piece of state, and the difference is instructive rather than
// inconsistent: a text field has an uncommitted draft that legitimately leads the URL by a
// debounce window. A picker commits on the same tick it is changed, so it has no draft to hold.
//
// STALE SLUGS ARE HANDLED, not assumed away, and handling them properly takes THREE decisions
// rather than one. A category deleted from the admin dashboard leaves live links pointing at its
// slug.
//
//   * The trigger must not go blank. `?category=was-deleted` selects an option that no longer
//     exists, so Radix has no item to take a label from. The label is therefore resolved in this
//     file and passed to `SelectValue` as children.
//   * That label must not claim the feed is UNFILTERED. It used to fall back to "All categories",
//     and that is false: the parameter is still in the URL, `listPosts` still forwards it, and the
//     service still filters on it - `?category=was-deleted` matches no category and so answers an
//     EMPTY page, which the backend documents as its behaviour rather than an error. So the control
//     said "All categories" above a feed showing none, and the one fact the reader needed - that a
//     filter they cannot see is excluding everything - was the fact the control hid. The
//     unresolvable case therefore names itself; see UNRESOLVED_CATEGORY_LABEL_PREFIX.
//   * The junk parameter must remain CLEARABLE. This is the half that is easy to miss and was found
//     by driving the control in a real browser: mapping the unresolvable case onto the same sentinel
//     the clean URL uses makes "All categories" a no-change, Radix then never fires
//     `onValueChange`, and the parameter sticks forever behind an affordance that looks live. The
//     unresolvable case therefore takes a value of its own - see UNRESOLVED_CATEGORY_VALUE.
//
// The label and the value are consequently derived from DIFFERENT questions, which is why they are
// two expressions rather than one. The value answers "is the URL canonical?", so any `category` that
// is present but unresolved - a deleted slug, or the blank `?category=` - keeps the reset affordance
// live. The label answers "what is the feed beneath me actually filtered by?", and the blank case
// parts company with the deleted one there: `backend/app/services/post_service.py` folds a
// whitespace-only filter to `None` before it reaches the query, so `?category=` really is the
// unfiltered feed and really is "All categories", while `?category=was-deleted` is not.
//
// ---------------------------------------------------------------------------
// SLUG MATCHING IS CASE-INSENSITIVE, BECAUSE THE SERVICE'S IS
//
// `categories.slug` is a `citext` column and the feed's filter is documented as "Matched
// case-insensitively", so `?category=Engineering` and `?category=engineering` are ONE URL to the
// API: both return the Engineering posts. A control that compared with `===` therefore resolved only
// one of them, and on the other it displayed "All categories" over a page of Engineering articles -
// the picker contradicting the results underneath it. Comparison here is folded to lower case for
// exactly that reason, and only for comparison: the slug that goes back INTO the URL is always the
// canonical one the API reported, so re-choosing the current category also tidies a mixed-case link.
//
// ---------------------------------------------------------------------------
// 4. THE ARRAY IS A PROP, NOT A FETCH, AND THAT IS AN SEO DECISION
//
// The taxonomy is passed in. This component performs no request, imports no API wrapper and holds
// no query - src/app/page.tsx is a Server Component that already fetches the categories for its
// own render, so asking again from the client would be a second round trip for data the page has
// in hand.
//
// The consequence that matters is in the initial HTML. Because the options are props rather than
// the result of a client effect, they are present in the server-rendered markup of this island -
// crawlable, and correct in the window before hydration attaches. A `useQuery` here would ship an
// empty picker in the HTML and fill it in a frame later.
//
// It also keeps the island narrow. The only reasons this file is a Client Component at all are
// `next/navigation` and Radix's open/closed state; adding data fetching would widen it into a
// cache consumer as well.
//
// ONE HONEST LIMIT, MEASURED IN THE SERVER RESPONSE RATHER THAN ASSUMED. The trigger and its
// selected label ARE in the server-rendered markup, and every category name reaches the initial
// response as part of this island's props. The OPTION ELEMENTS are not, and cannot be: Radix mounts
// the panel only when the picker is opened, so there is no listbox in the document until then.
// That is inherent to using the mandated behavioural primitive rather than a native <select>, and
// it is the right trade - the crawlable route to a filtered feed is the `?category=` URL this
// control writes, which the sitemap and the category pages enumerate, not a popup's DOM. What the
// prop decision buys is real and is what the alternative would lose: fetch the taxonomy from a
// client effect instead and NONE of it - not the names, not even the selected label - would be in
// the initial response.
//
// ---------------------------------------------------------------------------
// 5. ACCESSIBILITY: A REAL LABEL, PLUS AN `aria-label` THAT IS NOT REDUNDANT
//
// The trigger is named twice on purpose, and the second is load-bearing rather than belt-and-
// braces bookkeeping.
//
// A real `<label>` comes first, because the project's accessibility floor is "every form control
// is associated with a label" and because a label is what a translation layer can reach, what a
// caller can override, and what makes clicking the caption focus the control. It is visually
// hidden with the engine's own `sr-only` utility rather than omitted - the same treatment
// search-input.tsx gives its own caption, which is what keeps the two controls the same height in
// the feed's toolbar row.
//
// `aria-label` carries the SAME string, and it pins the accessible name for one specific reason:
// Radix renders the trigger as a `<button>` whose content is the SELECTED VALUE. In any engine
// that computes a button's name from its subtree rather than from an associated label, the
// control's accessible name would therefore be "Technology" - the current value - and it would
// CHANGE every time the reader picked a different category. A control whose name drifts with its
// own value is unusable to a screen-reader user and untestable by accessible name. Naming it
// explicitly makes the name the control's PURPOSE and makes it stable across engines. Because both
// names are the same string, nothing is announced twice.
//
// ---------------------------------------------------------------------------
// 6. THE POST COUNT: A DESCRIPTION, NOT PART OF THE NAME, AND NEVER ITS OWN COLOUR
//
// Two independent traps, both verified in the installed packages rather than reasoned about.
//
// FIRST, WHERE THE COUNT MAY LIVE. Radix's item renders `role="option"` with
// `aria-labelledby={textId}`, where that id belongs to `SelectItemText`. The option's accessible
// name is therefore EXCLUSIVELY the ItemText content - and ItemText's children are also what
// typeahead matches and what gets portalled into the trigger after selection. Putting "12" inside
// it would make the option answer to "1", make the trigger read "Technology 12", and fold the
// tally into the option's name. The count is consequently composed OUTSIDE ItemText, which
// @/components/ui/select supports explicitly: its `SelectItem` detects a direct-child
// `SelectItemText` and then adds no wrapper of its own.
//
// Content outside ItemText is visible but SILENT, though, which would hand a sighted reader
// information a screen-reader user does not get. The count element is therefore referenced by
// `aria-describedby` on the item, so the tally is announced as a DESCRIPTION - "Technology,
// option, 12 posts" - which is where supplementary information belongs and which leaves the name,
// the typeahead target and the trigger's value untouched. Radix spreads a caller's props after its
// own attributes and sets no `aria-describedby` itself, so the reference lands intact. The
// "posts" word is visually hidden for exactly this reason: it turns a bare number into a phrase
// worth announcing, and it is singularised at one so a lone post never reads as "1 posts".
//
// SECOND, ITS COLOUR MUST BE INHERITED. `text-muted-foreground` is the obvious way to de-emphasise
// a tally and it is a serious defect here. ITEM_CLASSES flips the row to
// `data-[highlighted]:text-primary-foreground` over `data-[highlighted]:bg-accent`, and a nested
// element carrying its own colour does NOT flip with it. Computed from the actual token values in
// globals.css: muted-foreground over accent measures 1.07:1 in light and 1.31:1 in dark - text
// that all but disappears the moment the row is highlighted or hovered.
//
// So the count states no colour at all and inherits the row's, exactly as select.tsx's own check
// indicator does, and it is de-emphasised with opacity instead - which composes with whatever
// colour the row currently has and therefore cannot fall out of step. `opacity-75` rather than the
// `opacity-60` the trigger's chevron uses, because this is text and has to clear 4.5:1 rather than
// the 3:1 a graphic needs. The four states measure 7.95:1 and 5.19:1 in light, 9.90:1 and 6.29:1
// in dark, all clear of the floor; `opacity-60` would drop the highlighted light row to 3.85:1,
// which is why it is not used here.
//
// ---------------------------------------------------------------------------
// 7. DELIBERATELY ABSENT - DO NOT ADD
//
//   1. A native `<select>`, an `<option>`, a bespoke dropdown, a click-outside listener, an
//      `onKeyDown` handler or any `aria-expanded`/`aria-controls` of our own. Radix supplies the
//      combobox/listbox model, typeahead, roving focus, Escape dismissal, focus restoration and
//      collision-aware positioning; a second implementation would only drift from it.
//   2. A raw `<button>` or `<input>`. Raw interactive elements belong inside
//      src/components/ui/ and nowhere else.
//   3. A `fetch`, an axios instance, or a `useQuery`. @/lib/api/client.ts is the tier's only HTTP
//      module, and this control needs no request at all - see section 4.
//   4. Any React Query default - `staleTime`, `gcTime`, `refetchOnWindowFocus`, `retry`.
//      @/providers/query-provider.tsx owns them tier-wide and no component may restate them.
//   5. Client-side filtering, sorting or slicing of POSTS. Category membership is composed into
//      one SQL statement by backend/app/repositories/post_repository.py and surfaced through
//      `listPosts`; re-filtering here would desynchronise `total` and `pages` and break the pager.
//   6. Re-ordering or hiding CATEGORIES - including hiding a term whose `post_count` is zero. An
//      empty category is a truthful, useful thing to show, and the server decides the order.
//   7. Any category create, rename or delete affordance, and any import of `CategoryCreate` or
//      `CategoryUpdate`. @/lib/api/categories deliberately exports only reads; the lifecycle lives
//      on the admin namespace behind @/lib/api/admin.ts and is rendered by
//      src/components/admin/category-form.tsx.
//   8. A heading of any level. This is a control in a toolbar, not a section of the document, and
//      the feed page owns its own heading outline.
//   9. `useState` for the selection, and any effect that synchronises it. See section 3.
//  10. A `dark:` conditional, a media query, a stylesheet, a CSS module, a `style` prop or
//      `!important`. The tokens are dual-valued in globals.css, so every class below themes
//      itself; utilities are merged through `cn()` so a caller's class still wins its group.
//  11. A fixed width, and any breakpoint variant. A control does not reflow - its container does.
//  12. Analytics, experiment or consent instrumentation of the selection.

import type { JSX } from 'react';
import { useCallback, useId } from 'react';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCount } from '@/lib/format';
import type { CategoryPublic } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * The taxonomy parameter this control owns.
 *
 * Named once rather than written at each of the four places it appears, because it is a contract
 * with three other modules - the feed page that reads it, `listPosts` in `@/lib/api/posts` that
 * forwards it, and the backend router that declares it. A typo in any one of them produces a
 * filter that silently does nothing, which no type checker can catch.
 */
const CATEGORY_PARAM = 'category';

/**
 * The pagination parameter this control CLEARS but never sets.
 *
 * Owned by `@/components/ui/pagination`; named here only so that changing the filter can drop it.
 * A reader on page five of "Engineering" who switches to "Design" has no meaningful position in
 * the new, differently-sized result set, and keeping `page=5` would strand them on an empty screen.
 */
const PAGE_PARAM = 'page';

/**
 * The value of the "All categories" option.
 *
 * A view-only sentinel: it is what the picker holds while no filter is applied, and it is never
 * written to the URL - selecting it deletes {@link CATEGORY_PARAM} instead.
 *
 * Cannot collide with a real slug, which is the whole reason for the underscores. Slugs are
 * derived by `backend/app/core/slug.py`, which lower-cases to ASCII alphanumerics joined by single
 * hyphens and strips leading and trailing separators - so no slug can begin with `_`. Note that
 * the bare `'all'` WOULD collide: that module maps the title "All" onto exactly that slug.
 */
const ALL_CATEGORIES_VALUE = '__all__';

/**
 * The picker's value while the URL carries a `category` this control cannot resolve.
 *
 * Deliberately matches NO option, which is the point. FOUND BY BROWSER TESTING, and the failure it
 * fixes is not obvious from reading the code.
 *
 * Radix's root holds its value through `useControllableState`, which invokes `onValueChange` only
 * when the incoming value actually DIFFERS from the current one. So if an unresolvable
 * `?category=was-deleted` were mapped straight onto {@link ALL_CATEGORIES_VALUE}, the picker would
 * already be sitting on the sentinel - and choosing "All categories" would be a no-change,
 * `onValueChange` would never fire, and the junk parameter could never be cleared through the
 * control. Verified in a real browser: the affordance looked live and did nothing, and
 * `?category=was-deleted` survived as a second, shareable URL for the unfiltered feed - exactly the
 * duplicate this file's sentinel rule exists to prevent.
 *
 * Mapping the unresolvable case onto a value no item carries makes "All categories" a genuine
 * change, so the handler runs and the parameter is deleted. Radix tolerates a value with no
 * matching item because the trigger's text is supplied here rather than portalled from an item -
 * see {@link CategoryFilter}'s `selectedLabel`. The visible consequence is confined to the
 * anomalous URL: no row shows a tick until the reader picks something, which is truthful, because
 * on that URL no listed category IS active.
 *
 * Distinct from {@link ALL_CATEGORIES_VALUE} so that even a hand-typed `?category=__all__` - which
 * this control never emits - is treated as unresolvable and therefore cleanable.
 */
const UNRESOLVED_CATEGORY_VALUE = '__unresolved__';

/**
 * Visible text of the "All categories" option, and the trigger's placeholder.
 *
 * Used in both places deliberately, so the field reads identically whether the sentinel is
 * selected or - in the moment before Radix resolves its value - nothing is.
 *
 * It is the label for exactly two URLs, and both of them really are the unfiltered feed: one with no
 * `category` parameter, and one whose `category` is blank, which
 * `backend/app/services/post_service.py` folds to `None` before the query is built. It is
 * deliberately NOT the label for a `category` that names something unknown - see
 * {@link UNRESOLVED_CATEGORY_LABEL_PREFIX}.
 */
const ALL_CATEGORIES_LABEL = 'All categories';

/**
 * Opening of the label shown when the URL names a category this taxonomy does not contain.
 *
 * The slug is appended, because the reader is looking at an empty or unexpected feed and the value
 * doing that to them is invisible otherwise - it is in the address bar, which is exactly where
 * somebody following a shared link does not look. Naming it is what turns "there are no posts" into
 * "there are no posts *under this filter*", and it is the difference between the reader clearing the
 * filter and the reader concluding the site is empty.
 *
 * This label is a truth about the REQUEST, not a guess about the category: a slug can be unresolvable
 * because the category was deleted, because it was renamed and re-slugged, or because the link was
 * mistyped, and this control cannot tell those apart. "Unknown" covers all three without claiming
 * which.
 *
 * Rendered as a text node by React, so a hostile `?category=` value is escaped rather than
 * interpreted - there is no markup path here, and none is to be added.
 */
const UNRESOLVED_CATEGORY_LABEL_PREFIX = 'Unknown category: ';

/**
 * How much of an unresolvable slug is shown before it is elided.
 *
 * A real slug is short - `backend/app/core/slug.py` derives it from a category name - but this value
 * comes from a URL, so its length is chosen by whoever wrote the link. Without a bound, one shared
 * link could put a kilobyte of text into the trigger's accessible name, which a screen reader would
 * then read out in full. Forty characters comfortably fits every seeded slug and every plausible one.
 */
const MAX_UNRESOLVED_SLUG_LENGTH = 40;

/** Appended in place of the elided remainder of an over-long slug. */
const ELLIPSIS = '…';

/**
 * The trigger's text when the URL names a category that is not in the supplied taxonomy.
 *
 * @param slug - The requested slug, already trimmed. Never blank: a blank filter is the unfiltered
 * feed and takes {@link ALL_CATEGORIES_LABEL} instead.
 * @returns A label naming the still-active filter, with an over-long value elided.
 */
function unresolvedCategoryLabel(slug: string): string {
  const shown =
    slug.length > MAX_UNRESOLVED_SLUG_LENGTH
      ? `${slug.slice(0, MAX_UNRESOLVED_SLUG_LENGTH)}${ELLIPSIS}`
      : slug;

  return `${UNRESOLVED_CATEGORY_LABEL_PREFIX}${shown}`;
}

/**
 * The control's accessible name when the caller supplies none.
 *
 * A noun phrase describing the control rather than an instruction, because it is announced every
 * time focus enters the trigger. "Filter by category", not "Choose a category to filter by".
 */
const DEFAULT_LABEL = 'Filter by category';

/** Props of {@link CategoryFilter}. */
export interface CategoryFilterProps {
  /**
   * Every category the reader may filter by, in the order the server returned them.
   *
   * A BARE ARRAY, matching what `listCategories` in `@/lib/api/categories` answers - the one
   * collection in this API that is not a {@link Page}. There is no envelope to unwrap and no
   * window to walk, so this is the complete taxonomy.
   *
   * Required, and supplied by the Server Component that renders the feed rather than fetched here,
   * so that the options appear in the initial HTML. `CategoryPublic` rather than `CategorySummary`
   * because the full projection carries `post_count`, which this control displays.
   *
   * An empty array renders nothing at all - see {@link CategoryFilter}.
   */
  categories: CategoryPublic[];

  /**
   * The control's name, as announced to assistive technology.
   *
   * Rendered into a real `<label>` that is visually hidden, and mirrored onto the trigger's
   * `aria-label` so the accessible name stays the control's purpose instead of drifting to
   * whichever category is currently selected.
   *
   * @defaultValue {@link DEFAULT_LABEL}
   */
  label?: string;

  /**
   * Extra classes for the element that wraps the label and the picker.
   *
   * Merged last through `cn`, so a caller's utility reliably wins its Tailwind group. This is the
   * supported way for the feed's toolbar to place the control - a column span, a maximum width, a
   * margin - without this file knowing anything about the layout around it.
   */
  className?: string;
}

/**
 * The home feed's category picker.
 *
 * Renders a labelled select whose choice is written into the URL's `category` parameter. It
 * performs no request of its own: changing the parameter re-renders the feed's Server Component,
 * which calls `listPosts` with the new filter.
 *
 * @example The feed's own use. The Suspense boundary is required, because `useSearchParams` forces
 * a client-side read of the query string.
 * ```tsx
 * const categories = await listCategories();
 *
 * <Suspense fallback={<Skeleton className="h-11 w-full" />}>
 *   <CategoryFilter categories={categories} />
 * </Suspense>
 * ```
 *
 * ### What choosing a category does to the query string
 *
 * Exactly three things, and the first two are the ones easiest to get wrong:
 *
 * 1. **Sets `category`** to the chosen slug, or **deletes it outright** for "All categories".
 *    Never `category=__all__` and never `category=all` - the unfiltered feed must have one
 *    canonical URL, and a sentinel leaking into the address bar would give it a second.
 * 2. **Deletes `page`.** Deleting rather than writing `page=1` matches `hrefForPage` in
 *    `@/hooks/use-pagination`, which omits the parameter for the first page, so the two controls
 *    agree on one canonical shape for "page one".
 * 3. **Preserves everything else** - `q`, `sort`, and any parameter added to the feed later - by
 *    building from a copy of the current parameters rather than a fresh `URLSearchParams`.
 *    Clobbering a sibling control's slice is invisible in isolation and only surfaces when a
 *    reader searches and filters at once.
 *
 * ### Why this pushes where the search field replaces
 *
 * `router.push`, so a filter change becomes a history entry the Back button returns through. That
 * is right here and wrong for search: typing is debounced and would deposit an entry per pause,
 * burying the page the reader arrived from, which is why search-input.tsx uses `replace`. A filter
 * change is a single deliberate act, so it earns its entry. `scroll: false` in both, because the
 * results are already in view and jumping to the top of the document loses the reader's place.
 *
 * @param props - See {@link CategoryFilterProps}.
 * @returns The labelled picker, or `null` when there are no categories to filter by.
 */
export function CategoryFilter({
  categories,
  label = DEFAULT_LABEL,
  className,
}: CategoryFilterProps): JSX.Element | null {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /*
   * A collision-proof id, generated rather than written down, so a second picker on the same page
   * cannot silently steal this one's `htmlFor` association. It also prefixes the per-option
   * description ids below, which keeps those unique for the same reason.
   */
  const fieldId = useId();

  /*
   * The raw parameter, and the filter the SERVICE will actually apply.
   *
   * Two values rather than one, because they answer different questions and the derivations below
   * need both. `urlCategory` says whether the parameter is PRESENT, which is what decides whether
   * the URL is canonical. `requestedSlug` says what it asks for once trimmed, which is what decides
   * whether anything is being filtered at all: `backend/app/services/post_service.py` folds a
   * whitespace-only filter to `None`, so `?category=%20` narrows nothing there and must not be
   * presented as narrowing something here.
   *
   * The empty string stands for "no filter requested" and covers the absent parameter too, so every
   * expression below reads a `string` rather than re-testing for `null`.
   */
  const urlCategory = searchParams.get(CATEGORY_PARAM);
  const requestedSlug = (urlCategory ?? '').trim();

  /*
   * The category the URL names, resolved against what the caller actually supplied.
   *
   * CASE-INSENSITIVELY, because `categories.slug` is a `citext` column and the feed's `category`
   * filter is documented as matched case-insensitively - so `?category=Engineering` returns the
   * Engineering posts whether or not this control recognises the spelling. Comparing with `===`
   * meant it did not, and the picker then read "All categories" over a page that was plainly
   * filtered. Only the COMPARISON is folded: `selectedCategory.slug` - the canonical spelling the
   * API reported - is what goes back into the URL.
   *
   * `find` rather than `some` because the ROW is wanted, not merely the fact of a match: it
   * answers the stale-slug question and yields the trigger's display text in one pass. A linear
   * scan is deliberate rather than a lookup table - the taxonomy is small and curated, and a `Map`
   * rebuilt on every render to answer one question would cost more than it saves.
   *
   * `undefined` means "this control cannot name the filter", which is NOT the same as "there is no
   * filter" - see `selectedLabel` for the two cases it covers and why they read differently.
   */
  const requestedSlugFolded = requestedSlug.toLowerCase();
  const selectedCategory =
    requestedSlug === ''
      ? undefined
      : categories.find((category) => category.slug.toLowerCase() === requestedSlugFolded);

  /*
   * The picker's controlled value, over three cases rather than two.
   *
   * A resolved category is its own slug. A URL with NO `category` at all is the sentinel, and
   * choosing "All categories" there is correctly a no-op because the URL is already canonical.
   * Anything else - a slug that does not resolve, a blank `?category=`, a hand-typed sentinel - takes
   * {@link UNRESOLVED_CATEGORY_VALUE}, which no option carries, so that choosing "All categories"
   * registers as a real change and the junk parameter actually gets deleted. Collapsing that third
   * case into the sentinel is what made the reset affordance inert - see that constant for the
   * browser evidence.
   *
   * Keyed on `urlCategory` rather than on `requestedSlug`, deliberately: a blank `?category=` filters
   * nothing, but it is still a second URL for the unfiltered feed, so the reset must stay live for it
   * even though the label below correctly calls it unfiltered.
   */
  const selectedValue =
    selectedCategory?.slug ??
    (urlCategory === null ? ALL_CATEGORIES_VALUE : UNRESOLVED_CATEGORY_VALUE);

  /**
   * What the trigger displays - resolved here rather than left to Radix, and that is a
   * SERVER-RENDERING fix rather than a preference.
   *
   * FOUND BY RUNTIME INSPECTION of the server response. Radix normally fills the trigger by
   * portalling the selected item's `SelectItemText` children into it, but the panel holding those
   * items is not mounted until the picker is opened - so during server rendering there is nothing
   * to portal, and the trigger arrives as an EMPTY field with a chevron. The `placeholder` does not
   * cover it either: Radix shows a placeholder only while the value is empty, and this control's
   * value is always a real one because the unfiltered state has a sentinel of its own.
   *
   * Passing children to `SelectValue` is the primitive's own supported answer - it tracks
   * `valueNodeHasChildren` and then leaves the value node alone instead of portalling into it. So
   * the selected label is in the server-rendered HTML, correct before hydration, correct with
   * client scripting disabled, and there is no blank-to-populated flash on first paint.
   *
   * THREE CASES, AND THE THIRD IS THE ONE THAT USED TO LIE. A resolved category is its own name. A
   * URL that requests no filter - no parameter, or a blank one the service folds away - is "All
   * categories", which is true of the feed beneath it. A URL requesting a slug this taxonomy does not
   * contain is NEITHER: the parameter is still sent, the service still filters on it, and it matches
   * nothing, so the feed beneath is an empty page. Labelling that "All categories" told the reader
   * the one thing that was not so, and hid the only thing that would have explained what they were
   * looking at. It names the filter instead.
   */
  const selectedLabel =
    selectedCategory?.name ??
    (requestedSlug === '' ? ALL_CATEGORIES_LABEL : unresolvedCategoryLabel(requestedSlug));

  /**
   * Write the chosen category into the URL, or return without navigating if it is already there.
   *
   * The single place this component mutates the query string, so the three-step contract
   * documented on {@link CategoryFilter} is declared exactly once.
   */
  const handleValueChange = useCallback(
    (nextValue: string): void => {
      // A COPY, never a fresh `URLSearchParams`. This is what preserves `q`, `sort` and anything
      // added to the feed later. The object `useSearchParams()` returns is read-only and throws on
      // mutation, so the copy is required as well as correct.
      const nextParams = new URLSearchParams(searchParams.toString());

      if (nextValue === ALL_CATEGORIES_VALUE) {
        // Deleted, not set to the sentinel and not set to `''`. Either would mint a second
        // crawlable URL for the unfiltered feed.
        nextParams.delete(CATEGORY_PARAM);
      } else {
        nextParams.set(CATEGORY_PARAM, nextValue);
      }

      // Unconditional: any change of filter invalidates the reader's page position.
      nextParams.delete(PAGE_PARAM);

      const nextSearch = nextParams.toString();

      // The no-op guard. Radix fires `onValueChange` on a re-selection of the current value, and
      // without this that would push a duplicate history entry - so the Back button would appear
      // to do nothing. It also protects a deep link: arriving on `?category=x&page=3` and
      // re-choosing "x" must not strip the `page` the reader was sent.
      if (nextSearch === searchParams.toString()) {
        return;
      }

      // The conditional keeps the URL clean when no parameter survives, so clearing the only
      // filter lands on `/` rather than on `/?`.
      router.push(nextSearch ? `${pathname}?${nextSearch}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  /*
   * No categories, no control. Placed after every hook, so the hook order is identical on both
   * branches.
   *
   * Rendering a disabled or empty picker would be worse than rendering nothing: a fresh
   * environment is seeded with reference categories by
   * backend/migrations/versions/0003_seed_reference_categories.py, so an empty taxonomy means
   * something upstream is genuinely wrong, and a dead control in the toolbar would present that
   * as a normal state the reader should try to use.
   */
  if (categories.length === 0) {
    return null;
  }

  return (
    // `w-full` so the control fills whatever the toolbar gives it, and `min-w-0` so it can also
    // SHRINK inside a flex row - without it the automatic minimum size would resolve to
    // min-content and a long category name would push the row into horizontal overflow instead of
    // truncating. The truncation itself already lives on the trigger in @/components/ui/select.
    // No fixed width and no breakpoint variant: the container reflows, the control does not.
    <div className={cn('w-full min-w-0', className)}>
      {/*
       * A real <label>, visually hidden rather than omitted, so the accessible name is genuine
       * label text - reachable by a translation layer, overridable by the caller, and clickable to
       * focus the trigger. `sr-only` is the token engine's own built-in utility.
       */}
      <Label className="sr-only" htmlFor={fieldId}>
        {label}
      </Label>

      <Select onValueChange={handleValueChange} value={selectedValue}>
        {/*
         * `aria-label` carries the same string as the <label> above, and is not redundant: Radix
         * renders this as a <button> whose content is the selected value, so an engine that names
         * a button from its subtree would otherwise call this control "Technology" and rename it
         * on every choice. See section 5 of the header.
         */}
        <SelectTrigger aria-label={label} id={fieldId}>
          {/*
           * The resolved label is passed as CHILDREN so the value is server-rendered rather than
           * portalled in on the client - see `selectedLabel` for why the trigger would otherwise be
           * blank until hydration. The `placeholder` is kept as a defensive default for the empty
           * value this control never produces, and matches the sentinel's own label so the field
           * reads identically either way.
           */}
          <SelectValue placeholder={ALL_CATEGORIES_LABEL}>{selectedLabel}</SelectValue>
        </SelectTrigger>

        <SelectContent>
          {/* First, and never `value=""` - an empty value is Radix's "show the placeholder"
              signal, not a choosable option. */}
          <SelectItem value={ALL_CATEGORIES_VALUE}>
            <SelectItemText>{ALL_CATEGORIES_LABEL}</SelectItemText>
          </SelectItem>

          {categories.map((category) => {
            // `formatCount` is total: it answers '' for a value that cannot be a tally - absent,
            // negative or non-finite - so a malformed payload renders no count element and no
            // dangling description rather than the word "posts" with no number in front of it.
            const countLabel = formatCount(category.post_count);
            const countId = `${fieldId}-count-${category.id}`;

            // The announced phrase, assembled HERE as one intact string rather than left to be
            // concatenated out of a visible number and a hidden word.
            //
            // FOUND BY TEST, and the reason the two halves below are split the way they are. The
            // accessible-name algorithm TRIMS each descendant's contribution before appending it,
            // so a leading space inside the hidden word is discarded and the description computes
            // as "12posts". No amount of `{' '}` or `&nbsp;` between the two nodes survives that
            // trimming reliably either. Building the phrase in one string and letting the visible
            // number sit beside it as decoration removes the whitespace question altogether.
            const countDescription = `${countLabel} ${category.post_count === 1 ? 'post' : 'posts'}`;

            return (
              // Keyed on the server-generated UUID, never on the array index: an index key would
              // make React reuse the wrong row's DOM when the taxonomy is reordered or a term is
              // removed. `value` is the slug, because that is what the URL and the API speak.
              <SelectItem
                // Points at the tally so it is announced as a DESCRIPTION rather than folded into
                // the option's name. Omitted entirely when there is no tally to describe, so the
                // attribute never references a node that was not rendered.
                aria-describedby={countLabel ? countId : undefined}
                key={category.id}
                value={category.slug}
              >
                {/* Composed explicitly, not left to SelectItem's convenience wrapper, so that the
                    NAME is the category name alone - and so the tally beside it joins neither the
                    typeahead target nor the value the trigger displays after selection. */}
                <SelectItemText>{category.name}</SelectItemText>

                {countLabel ? (
                  // No colour of its own - it inherits the row's, so it flips with the highlight
                  // instead of becoming near-invisible on it. `opacity-75` de-emphasises it and
                  // still clears 4.5:1 in all four states; see section 6 of the header.
                  // `tabular-nums` lines the digits up into a column down the panel, and
                  // `shrink-0` keeps the tally intact when a long name wraps beside it.
                  <span className="ms-auto shrink-0 text-xs tabular-nums opacity-75" id={countId}>
                    {/* The seen half. Hidden from assistive technology because the phrase beside
                        it already carries the same fact, and announcing both would say the number
                        twice. */}
                    <span aria-hidden="true">{countLabel}</span>
                    {/* The heard half: one intact phrase, visually hidden, singularised at one so
                        a lone post never reads as "1 posts". */}
                    <span className="sr-only">{countDescription}</span>
                  </span>
                ) : null}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
