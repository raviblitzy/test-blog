// Home feed loading fallback - the root segment's Suspense boundary.
//
// Next.js wires this file up by convention: exporting a component from `src/app/loading.tsx` makes
// the framework wrap the sibling `src/app/page.tsx` in a `<Suspense>` whose fallback is this.
// Nothing imports it and nothing should - the only caller is the router.
//
// It is the first paint a visitor gets on a cold load of the product's most important route, which
// is what makes it worth more explanation than its twenty lines of markup suggest. Its whole job is
// to hold the fold still: occupy the same measure, the same insets and the same tracks the loaded
// feed will occupy, so that when the server's data arrives nothing moves.
//
// ---------------------------------------------------------------------------
// 1. NO `'use client'`. A FALLBACK HAS NOTHING TO HYDRATE.
//
// There is no state, no effect, no hook, no event handler and no browser API below, so the module
// stays shared and renders on the server - which `src/app/error.tsx` records as the rule for this
// file ("loading.tsx and not-found.tsx render on the server"), and which
// `src/components/ui/skeleton.tsx` names this file specifically to support. The directive would
// ship a client bundle to animate boxes that do nothing on the client.
//
// It follows that this file performs no data access either. A fallback that awaited anything would
// suspend inside the very boundary it exists to fill.
//
// ---------------------------------------------------------------------------
// 2. THE GRID IS NOT RESTATED HERE. THIS IS THE FILE'S CENTRAL DECISION.
//
// `src/components/blog/post-list.tsx` is the single declared owner of the feed's one/two/three
// column geometry - one column below 48rem, two from 48rem, three from 64rem. Writing those column
// utilities again here would create a SECOND authority for the same layout, and the two would drift
// silently the first time the feed's tracks changed. That failure is invisible until someone loads
// the page slowly enough to watch the placeholder disagree with the content replacing it.
//
// So the placeholder feed IS `PostList`, rendered with `isLoading`. That component is deliberately
// directive-free, so a Server Component may render it; its loading branch draws its own placeholder
// run inside the same grid string its loaded branch uses, which makes the two states geometrically
// identical by construction rather than by coincidence.
//
// Its `page` prop is required but documented as not read at all while `isLoading` is set, which is
// why {@link PENDING_FEED} is allowed to be an empty envelope rather than something fetched.
//
// ---------------------------------------------------------------------------
// 3. LOADING IS ANNOUNCED EXACTLY ONCE, AND NOT BY THIS FILE.
//
// `PostList`'s loading branch is itself the one live region: a single container carrying
// `role="status"` and an accessible name, with every placeholder inside it hidden from assistive
// technology. This file therefore adds no second `role="status"`, no `aria-live` and no `aria-busy`.
//
//   * A second live region would announce the same wait twice.
//   * `aria-busy` would be worse than redundant. Set on a live region - or on any ancestor of one -
//     it instructs assistive technology to DEFER announcing until it turns false, which would
//     suppress the very notice `PostList` exists to make. The two mechanisms defeat each other, and
//     that component has already picked the one that speaks.
//
// The three `<Skeleton>` elements below are silent for the same reason: the primitive defaults to
// `aria-hidden="true"`, so a run of them contributes no text at all. A screen reader hears one
// notice for this screen, which is the correct number.
//
// ---------------------------------------------------------------------------
// 4. NO HEADING. NOT EVEN A HIDDEN ONE.
//
// `page.tsx` owns the route's single `<h1>`. Emitting one here would put two `<h1>` elements into
// the document across the transition and break the ordered-heading floor, so the heading is stood
// in for by a `<Skeleton>`: a box of the right height, with no heading semantics and no text.
//
// This file emits no `<main>`, `<header>` or `<footer>` either. `src/app/layout.tsx` owns the
// shell, and this content renders inside it.
//
// ---------------------------------------------------------------------------
// 5. WHAT THIS FILE DELIBERATELY DOES NOT DO. Please do not add.
//
//   1. A `'use client'` directive. See note 1.
//   2. Any data access - no `fetch`, no `@/lib/api/*`, no `await`. See note 1.
//   3. Any read of the environment. `src/lib/api/client.ts` is the only module in this tier that
//      reads one, and a placeholder needs nothing from it.
//   4. A grid or column utility of any kind. See note 2.
//   5. A second live region, an `aria-live` or an `aria-busy`. See note 3.
//   6. An `<h1>`, an `sr-only` heading, or any real text. See note 4.
//   7. A pagination placeholder. `PostList` draws no page control while loading, and the real one
//      is anchor-based and appears only for a collection of more than one page - which is not
//      knowable before the data arrives. A fake one would introduce the shift this file prevents.
//   8. A spinner, a progress bar or a percentage. There is no measurable progress to report, and a
//      placeholder mirroring the layout says more about what is coming than a rotating glyph does.
//   9. `@keyframes`, a `duration-*` utility or any arbitrary animation value. The pulse belongs to
//      `Skeleton`, which takes it from the engine's `--animate-pulse` token and already stills
//      itself under `prefers-reduced-motion`.
//  10. A `dark:` variant. Every fill below resolves to `--color-surface-muted`, which
//      `src/app/globals.css` declares twice - once at the document root and once under `.dark` - so
//      the placeholders re-theme with no conditional here.
//  11. A literal colour, length, radius, shadow or font size, a `style` prop, a stylesheet, a CSS
//      module or a media query. Every value below is a token-backed utility, and the engine's five
//      breakpoints (`sm` 40rem, `md` 48rem, `lg` 64rem, `xl` 80rem, `2xl` 96rem) are the entire
//      responsive vocabulary - of which this file uses `sm` and `md`.
//  12. A raw pulsing `<div>`. `Skeleton` is the design system's placeholder primitive, and this
//      file consumes it rather than reimplementing it.
//  13. Props. The router renders this with none, so accepting any would be dead surface.

import type { JSX } from 'react';

import { PostList } from '@/components/blog/post-list';
import { Skeleton } from '@/components/ui/skeleton';
import type { Page, PostSummary } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * The pending envelope
 * ---------------------------------------------------------------------------------------------- */

/**
 * The window size the feed route requests, and therefore the one this fallback reports.
 *
 * Twelve, because it divides evenly into the feed's one, two and three column layouts, so no page
 * ends in a ragged final row. Stated here to keep {@link PENDING_FEED} an honest description of the
 * request actually in flight.
 *
 * It does NOT decide how many placeholders appear. `PostList` draws a fixed run sized to fill its
 * widest layout and reads no field of the envelope while loading, which is the right behaviour: a
 * window may legitimately be as large as 100, and a hundred throwaway cards would cost far more
 * than the layout stability they buy. Changing this number therefore changes nothing on screen, and
 * it should stay in step with the route's window rather than with any placeholder count.
 */
const FEED_PAGE_SIZE = 12;

/** The first page, 1-based, matching the service's own numbering. */
const FIRST_PAGE = 1;

/**
 * A zeroed page envelope, standing in for the request that has not answered yet.
 *
 * `PostList` requires an envelope but documents that it reads none of it while `isLoading` is set,
 * so this describes the type rather than any data. It is annotated `Page<PostSummary>` explicitly
 * rather than left to inference, so the compiler checks that all five of the contract's snake_case
 * fields are present and correctly typed - and so that a field renamed or dropped in `@/lib/types`
 * fails the build here instead of rendering something wrong. The annotation is also what types the
 * empty `items` array as `PostSummary[]` rather than `never[]`.
 *
 * `pages: 0` is what the contract specifies for an empty collection - zero, not one - and it is
 * load-bearing rather than cosmetic: `PostList` gates its page control on `pages > 1`, so a zero
 * guarantees no pagination is drawn even if that component's loading branch were ever changed to
 * render its footer.
 */
const PENDING_FEED: Page<PostSummary> = {
  items: [],
  total: 0,
  page: FIRST_PAGE,
  page_size: FEED_PAGE_SIZE,
  pages: 0,
};

/* -------------------------------------------------------------------------------------------------
 * Class recipes
 *
 * Module-scope constants rather than inline strings, so each can carry the note explaining the
 * geometry it stands in for while the JSX below reads as structure. Every value is a token-backed
 * utility; there is not one literal colour, length, radius, shadow or font size in this file. Each
 * string is ordered as prettier-plugin-tailwindcss orders it, so none churns on format.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The page shell, and a deliberate copy of the measure the loaded feed uses.
 *
 * `max-w-6xl` is the `--container-6xl` token (72rem), which `src/components/layout/site-footer.tsx`
 * documents as this tier's shell cap precisely because it is wide enough for the three-column feed
 * the home page reaches at `lg`. `px-4 sm:px-6` is the shell padding shared by `src/app/error.tsx`
 * and `src/app/not-found.tsx`, and `py-12` is their vertical rhythm. Matching all three is what
 * keeps the swap from placeholder to content free of movement: a different cap or inset here would
 * slide every card sideways the moment the data arrived.
 *
 * `mx-auto` centres the shell and `w-full` keeps it filling the space below the cap rather than
 * shrinking to its contents. `flex flex-col gap-8` lets this ONE element serve as both the measure
 * and the vertical stack - a separate wrapper would add a DOM level carrying no visual behaviour of
 * its own. `gap-8` is a step above the grid's internal `gap-6`, which reads the cards as one region
 * beneath the controls instead of a third equally spaced sibling.
 */
const SHELL_CLASSES = 'mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-12 sm:px-6';

/**
 * The page heading's stand-in.
 *
 * `h-9` is 2.25rem on the spacing scale, the line box of the `text-3xl` step a route heading
 * occupies, so the band is the height the real heading will be. `w-64` is a partial width because a
 * heading is a short phrase and a full-width bar would read as a paragraph; `max-w-full` caps it so
 * it cannot exceed the measure at the narrowest viewport.
 *
 * There is deliberately no second line beneath it. A subtitle placeholder would be a guess at a
 * band the route may not have, and drawing one would CAUSE the shift this file exists to absorb.
 */
const HEADING_CLASSES = 'h-9 w-64 max-w-full';

/**
 * The controls row: the search field beside the category picker.
 *
 * Stacked below `md`, one row from `md` up - the same breakpoint at which the feed's grid takes its
 * second column, so the controls and the cards change shape together rather than at two different
 * widths. `items-center` puts the two fields on one axis once they share a row, and `gap-4` is a
 * tighter step than the shell's, which reads the pair as a single region.
 */
const CONTROLS_CLASSES = 'flex flex-col gap-4 md:flex-row md:items-center';

/**
 * The search field's stand-in.
 *
 * `h-11` is 2.75rem - 44px, the WCAG 2.5.5 target-size floor that `src/components/ui/input.tsx`
 * pins every field in this tier to - and it is the exact fallback
 * `src/components/blog/search-input.tsx` documents for itself, that component reading the query
 * string on the client and so needing a Suspense boundary of its own.
 *
 * `md:flex-1` rather than a second `w-full`: once the row exists the search field takes the
 * leftover space, and `flex: 1 1 0` is what expresses that without fighting the picker's fixed
 * width beside it.
 */
const SEARCH_FIELD_CLASSES = 'h-11 w-full md:flex-1';

/**
 * The category picker's stand-in.
 *
 * `h-11` again, because `src/components/ui/select.tsx` pins its trigger to the same field height as
 * the text input - the two are one vocabulary, so a picker and a search box sharing a row cannot
 * drift apart. `w-full` while stacked, then a fixed `md:w-56` in the row, which is the shape a
 * short list of category names takes beside a flexing search field.
 */
const CATEGORY_FIELD_CLASSES = 'h-11 w-full md:w-56';

/* -------------------------------------------------------------------------------------------------
 * HomeFeedLoading
 * ---------------------------------------------------------------------------------------------- */

/**
 * The home feed's Suspense fallback.
 *
 * Renders the SHAPE of the feed rather than a spinner: a heading band, the controls row, and the
 * card grid itself in its loading state. Every region occupies the measure and the tracks its real
 * counterpart will occupy, so the swap to server-rendered content moves nothing.
 *
 * Rendered by the router only, as the fallback for `src/app/page.tsx`. It takes no props, performs
 * no data access, and announces the wait exactly once - through `PostList`'s own live region rather
 * than one of its own.
 *
 * @returns The placeholder screen. Never `null`: an empty fallback would collapse the fold and
 *   produce the very layout shift this component exists to absorb.
 */
export default function HomeFeedLoading(): JSX.Element {
  return (
    <div className={SHELL_CLASSES}>
      {/*
       * The page heading's band. A `Skeleton`, not a heading element and not `sr-only` text: the
       * route owns the document's single `<h1>` and this must not become a second one. See note 4.
       */}
      <Skeleton className={HEADING_CLASSES} />

      {/*
       * The search field and the category picker. Both are client islands on the real page - one
       * reads the query string, the other writes it - so both are absent from this server-rendered
       * fallback and stood in for by boxes of the same field height.
       */}
      <div className={CONTROLS_CLASSES}>
        <Skeleton className={SEARCH_FIELD_CLASSES} />
        <Skeleton className={CATEGORY_FIELD_CLASSES} />
      </div>

      {/*
       * The feed itself, in its own loading state. This is the whole of note 2: the grid, the
       * placeholder run and the single loading announcement all belong to `PostList`, so not one of
       * the three is written here. `isLoading` takes precedence over every other state inside that
       * component, so the zeroed envelope beside it is never read.
       */}
      <PostList isLoading page={PENDING_FEED} />
    </div>
  );
}
