'use client';

// Pagination - the page control every list surface in this product shares, and
// the one design-system primitive whose MARKUP is load-bearing rather than
// merely decorative.
//
// ---------------------------------------------------------------------------
// 1. EVERY PAGE IS AN ANCHOR. THAT IS THE WHOLE POINT OF THIS FILE.
//
// A page control can be built two ways. `<button onClick={() => setPage(n)}>`
// is the shorter one and it is wrong here, because it produces a destination
// that exists only while JavaScript is running: nothing to crawl, nothing to
// middle-click, nothing to copy, nothing in the browser's history. This product
// asks for the opposite - the plan requires this primitive be "authored over
// <nav> with anchor-based page links so pagination remains crawlable", and it
// counts that as satisfying the basic-SEO requirement as well as the
// interaction one.
//
// So the `href` is not optional and is never derived from a click handler. Each
// link is a real `<a href>` rendered through `next/link`, carrying a URL that
// `@/hooks/use-pagination` builds. Three properties of those URLs matter to
// callers of this component:
//
//   * `q`, `category`, `sort` and every other parameter on the current URL
//     survive, so turning the page never silently discards the reader's search
//     or their category filter.
//   * Page one carries NO `page` parameter. Its address is the bare path, which
//     is what keeps one canonical URL per result set - `/?page=1` would be a
//     second URL for byte-identical content, and the sitemap and the canonical
//     link would then disagree with each other.
//   * The target is clamped, so no href here can address a page past the end.
//
// `onPageChange` exists and is genuinely useful, but it is PROGRESSIVE
// ENHANCEMENT layered on top of a working link - a place to close a drawer, fire
// an analytics event or scroll a list back to its top. It never replaces the
// href, and the click handler never calls `preventDefault()`. Intercepting the
// click would take back everything the anchor was chosen for.
//
// ---------------------------------------------------------------------------
// 2. THREE SURFACES, ONE CONTROL - WHICH IS WHY THE PROPS ARE PLAIN NUMBERS
//
// The home feed, an author's public profile and all four administrative tables
// window their results identically, because the plan requires a uniform
// pagination contract precisely "so all three can share this one component".
// Two of those three surfaces are Server Components, and a function cannot cross
// the server-to-client boundary - so every REQUIRED prop here is a serializable
// primitive. A Server Component renders this directly:
//
//     <Pagination page={feed.page} pages={feed.pages} />
//
// and, because the four numeric fields of the page envelope are exactly the
// props this component reads, either of the two shapes the tier already has
// spreads straight in with no adapter:
//
//     <Pagination {...feed} />        // a Page<PostSummary> from the API
//     <Pagination {...pagination} />  // a PaginationView from usePagination
//
// The envelope's `items` and the view's extra members are simply not read. That
// is also why this component does NOT spread rest props onto its `<nav>`: doing
// so would empty `slots`, `isEmpty` and `goToPage` onto the DOM as invalid
// attributes the moment somebody used the second form. The prop list is closed
// on purpose, and `className` is the one escape hatch it needs.
//
// ---------------------------------------------------------------------------
// 3. NONE OF THE ARITHMETIC LIVES HERE
//
// `@/hooks/use-pagination` is the tier's single implementation of page
// arithmetic, and a second one would be a defect rather than a convenience -
// two implementations can disagree, and the symptom is a control that offers a
// page the service will not serve. This file therefore computes no page count,
// no window, no bounds and no URL. It consumes the hook's `slots`, its
// `previousHref`/`nextHref` boundary signals and its `hrefForPage`, and it
// reuses the hook's exported `PAGE_WINDOW_SIBLING_COUNT` rather than restating
// the number 1. The only number this file produces is a rendered label.
//
// ---------------------------------------------------------------------------
// 4. THE CAVEAT THAT CRAWLABILITY ACTUALLY DEPENDS ON
//
// This is a Client Component - it must be, because the hook reads the URL - but
// a Client Component is still SERVER-RENDERED in the App Router, so the anchors
// below appear in the initial HTML and the crawlability contract in section 1
// holds. That is true on a DYNAMIC route. It is not automatically true on a
// statically rendered one, where `useSearchParams()` reads empty until
// hydration and Next.js requires a `<Suspense>` boundary above any component
// that calls it.
//
// The consuming route closes that gap, and every route that renders a list here
// already does: a page that reads `searchParams` from its own props is dynamic
// by definition, which is exactly how the feed and the profile obtain the
// envelope they pass in. No `<Suspense>` is placed INSIDE this component on
// purpose - it would put a fallback rather than the links into the prerendered
// HTML, which is the one outcome this file exists to prevent.
//
// ---------------------------------------------------------------------------
// 5. HOW IT STAYS INSIDE 375px
//
// The hook's window is bounded at seven slots - first page, a gap, the current
// page with a sibling either side, a second gap, last page - plus the two edge
// controls, so nine boxes at a 44px minimum target is more than a 375px viewport
// holds. Below the `sm` breakpoint the control therefore reveals only the
// sibling window, which is at most five boxes and measures about 267px inside
// the ~343px a 375px viewport leaves after page gutters. Choosing WHICH of the
// hook's slots to reveal at which width is presentation, not arithmetic; the
// slots themselves still come from the hook, and the threshold is the hook's own
// exported sibling count so the two cannot drift apart.
//
// `flex-wrap` on the list is the backstop. Page labels grow with the collection
// - a five-digit page number is wider than a one-digit page number - so rather
// than assume a worst case, the row is allowed to wrap onto a second line. The
// document's scroll width never exceeds its client width at any viewport, which
// is what the responsive gate measures at 375, 768 and 1440px.
//
// ---------------------------------------------------------------------------
// 6. DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT.
//
//   1. An `<a>` without an `href` for a disabled edge control. Such an anchor is
//      neither focusable nor activatable while still LOOKING like a control - a
//      real accessibility defect, not a shortcut. The boundary renders a
//      non-anchor element carrying `aria-disabled="true"` instead, which is
//      announced as unavailable, is inert to the pointer through the primitive's
//      own `aria-disabled:` classes, and is not focusable because a `<span>`
//      never was.
//   2. `preventDefault()` in the click handler. See section 1.
//   3. A rest-prop spread onto the `<nav>`. See section 2.
//   4. A `dark:` variant. Every token this file names is dual-valued - declared
//      once at the document root and again under `.dark` in
//      src/app/globals.css - so the control re-themes with no conditional here.
//      A `dark:` class would be a SECOND source of truth for one decision.
//   5. Any literal colour, dimension, radius or font size. Every value resolves
//      to a token, and the link styling comes from `buttonVariants` rather than
//      a second variant table that could drift from the first.
//   6. A page-size picker, cursor pagination and infinite scroll. The contract
//      is `page` and `pages`; the first is a different control, and the other
//      two are different contracts that the service does not offer.
//   7. `forwardRef`. React 19 passes `ref` as an ordinary prop; there is no ref
//      to forward here anyway, because the `<nav>` is not a control.
//   8. `import React from 'react'`. `"jsx": "react-jsx"` means the compiler
//      imports the runtime, so a default import would be unused - and
//      `npm run lint` runs at `--max-warnings=0`, which turns that from a
//      warning into a failed gate.
//   9. A `size="sm"` variant for the boxes. That size is 32px and is flagged in
//      button.tsx as below the 44x44 target-size floor; a pagination control is
//      exactly the kind of dense row of small targets that floor exists for.

import type { JSX } from 'react';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';
import type { PaginationSource } from '@/hooks/use-pagination';
import { PAGE_WINDOW_SIBLING_COUNT, usePagination } from '@/hooks/use-pagination';
import { cn } from '@/lib/utils';

/**
 * Accessible name of the landmark when the caller does not supply one.
 *
 * A `<nav>` is a landmark, and an unnamed landmark is announced as an anonymous
 * "navigation" that a screen-reader user has to enter to identify. Naming it is
 * the difference between "navigation" and "Pagination navigation" in a landmark
 * list, and it is what lets two controls on one screen - an administrative
 * screen can page a table above and a queue below - be told apart through the
 * `ariaLabel` prop.
 */
const DEFAULT_NAV_LABEL = 'Pagination';

/**
 * Builds the accessible name of a page-number link.
 *
 * "4" is a poor name for a link; "Page 4" is unambiguous. The label is rendered
 * COMPLETE in one visually hidden text node, with the visible digit hidden from
 * assistive technology beside it, rather than as a hidden "Page " prefix sitting
 * next to a visible digit. That is not stylistic: accessible-name computation
 * concatenates each child's text alternative after trimming it, so the prefix
 * form loses the separating space. Measured with `computeAccessibleName` against
 * a rendered control, the prefix form produced `"Page1"`, `"Page2"`, `"Page3"` -
 * names a screen reader would read as one word. Emitting the whole label in a
 * single node removes the dependency on inter-node whitespace entirely, and it
 * is deterministic in every implementation.
 *
 * Text rather than an `aria-label`, for the same reason `EdgeControl` uses text:
 * an attribute is invisible to the translation layer that rewrites text nodes,
 * so a localised page would announce an English name.
 *
 * @param page - The page the link addresses.
 * @returns The link's accessible name, for example `'Page 4'`.
 */
function pageLabel(page: number): string {
  return `Page ${page}`;
}

/** Accessible name of the control that steps one page toward the first page. */
const PREVIOUS_LABEL = 'Previous page';

/** Accessible name of the control that steps one page toward the last page. */
const NEXT_LABEL = 'Next page';

/**
 * The landmark's own classes.
 *
 * `w-full` rather than nothing: a `<nav>` is block-level and would already fill
 * a block container, but as a flex or grid item it would shrink to its content
 * and the centring below would then centre inside a box no wider than the row.
 * Deliberately no vertical spacing - the distance between a list and its page
 * control belongs to the surface that composes them, and arrives through
 * `className`.
 */
const NAV_BASE = 'w-full';

/**
 * The row of controls.
 *
 * `flex-wrap` is the no-overflow backstop described in section 5 of the file
 * header; `justify-center` keeps a wrapped final line centred rather than
 * ragged; `gap-2` is the --spacing token scale and is the only separation
 * between boxes, so no control carries a margin that could collapse or double.
 */
const LIST_BASE = 'flex flex-wrap items-center justify-center gap-2';

/**
 * The two edge controls, which are icon-only.
 *
 * This is the icon-only recipe that button.tsx documents for its default size -
 * squaring the 44px box by removing the horizontal padding and stepping the
 * glyph up to 20px - rather than a fourth size added to that primitive's table.
 * `shrink-0` matters because these sit in a flex row: a flex item's automatic
 * minimum size is content-based, and an icon-only control has almost no content
 * to floor it at, so under pressure the square would collapse toward the glyph.
 */
const EDGE_CONTROL_BASE = 'w-11 shrink-0 px-0 [&_svg]:size-5';

/**
 * A page-number link.
 *
 * `tabular-nums` fixes the advance width of every digit, so the boxes in a run
 * like 9 / 10 / 11 do not jitter as the reader pages through them. `shrink-0`
 * makes the row wrap rather than squash - a squashed number box drops below the
 * target-size floor, whereas a wrapped row does not.
 */
const PAGE_LINK_BASE = 'shrink-0 tabular-nums';

/**
 * The stand-in for a run of pages the window left out.
 *
 * Not styled with `buttonVariants`, because it is not a control: it has no
 * destination, takes no hover and cannot be focused. It matches the height and
 * width of the boxes either side so the row keeps one baseline, and
 * `select-none` keeps a decorative glyph out of a copied selection.
 */
const GAP_BASE = cn(
  'inline-flex h-11 w-11 shrink-0 items-center justify-center',
  'text-muted-foreground select-none',
);

/**
 * Whether a slot falls inside the run of pages that stays visible at every
 * viewport.
 *
 * The threshold is the hook's own exported sibling count rather than a literal,
 * so widening the window there widens what a narrow viewport shows here, and the
 * two can never disagree about what "the current page and its siblings" means.
 *
 * @param slotPage - The page a slot addresses.
 * @param currentPage - The page currently on screen.
 * @returns `true` when the slot is the current page or one of its siblings.
 */
function isInSiblingWindow(slotPage: number, currentPage: number): boolean {
  return Math.abs(slotPage - currentPage) <= PAGE_WINDOW_SIBLING_COUNT;
}

/** Props of the internal edge control. Not part of this module's public surface. */
interface EdgeControlProps {
  /** Which end of the result set this control steps toward. */
  readonly direction: 'previous' | 'next';
  /**
   * Destination, or `null` when the reader is already at that end.
   *
   * `null` is the hook's own boundary signal, passed straight through rather
   * than re-derived from a page comparison here.
   */
  readonly href: string | null;
  /** Optional enhancement fired alongside navigation; never instead of it. */
  readonly onNavigate?: (() => void) | undefined;
}

/**
 * One end of the control: a link when there is somewhere to go, and an inert,
 * announced-as-disabled box when there is not.
 *
 * Extracted so the two ends cannot drift apart - they are the same control
 * mirrored, and writing the enabled and disabled branches out twice each would
 * be four near-identical blocks of JSX to keep in step.
 *
 * The disabled branch is a `<span>`, not an `<a>` without an `href`. That is the
 * whole reason this branch exists rather than simply omitting the control: the
 * box stays in place, so the row does not shift by 44px as the reader crosses the
 * first or last page, and it is still announced - `aria-disabled` describes it,
 * the primitive's `aria-disabled:opacity-50` dims it, its
 * `aria-disabled:pointer-events-none` makes it inert to the pointer, and a
 * `<span>` is not in the tab order to begin with, so there is nothing to land on
 * and press Enter against.
 *
 * @param direction - `'previous'` or `'next'`; selects the glyph, the accessible
 *   name and the link relation.
 * @param href - Destination, or `null` at the boundary.
 * @param onNavigate - Optional callback fired on click, in addition to
 *   navigating.
 * @returns The rendered control.
 */
function EdgeControl({ direction, href, onNavigate }: EdgeControlProps): JSX.Element {
  const isPrevious = direction === 'previous';

  // Capitalised because it is used as a component, and chosen here rather than
  // taken as a prop so the glyph, the name and the relation cannot be paired up
  // inconsistently by a caller.
  const Glyph = isPrevious ? ChevronLeft : ChevronRight;
  const label = isPrevious ? PREVIOUS_LABEL : NEXT_LABEL;
  const className = cn(buttonVariants({ variant: 'ghost' }), EDGE_CONTROL_BASE);

  // Identical in both branches, so it is built once. The glyph is hidden from
  // assistive technology and the name comes from real text: an `aria-label`
  // would work equally well for a screen reader and would leave a speech-input
  // user with no visible name to say, and it would be invisible to the
  // translation layer that rewrites text nodes.
  const content = (
    <>
      <Glyph aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </>
  );

  if (href === null) {
    return (
      <span aria-disabled="true" className={className}>
        {content}
      </span>
    );
  }

  return (
    // `rel` is declarative sequence information rather than an indexing promise -
    // search engines stopped treating it as a ranking signal years ago - but it
    // is still what the HTML link-type registry defines for "the previous and
    // next parts of a sequence", and user agents and reading-mode extensions do
    // read it.
    <Link className={className} href={href} onClick={onNavigate} rel={isPrevious ? 'prev' : 'next'}>
      {content}
    </Link>
  );
}

/**
 * Props of {@link Pagination}.
 *
 * `page`, `pages`, `total` and `page_size` are derived from `PaginationSource`
 * rather than restated, so the four snake_case wire names cannot drift: there is
 * no camelCase mapping layer anywhere in this tier, and a hand-typed `pageSize`
 * would compile perfectly and read `undefined` at run time. Deriving them means
 * the envelope's contract and this component's contract move together or not at
 * all.
 *
 * Not exported, to keep this module's public surface to the single control the
 * design system documents. A caller that needs the type derives it:
 *
 * ```ts
 * type MyProps = ComponentProps<typeof Pagination>;
 * ```
 */
type PaginationProps = Pick<PaginationSource, 'page' | 'pages'> &
  Partial<Pick<PaginationSource, 'total' | 'page_size'>> & {
    /**
     * Appended to the landmark's classes and resolved by `cn`, so a caller's
     * utility reliably wins its property group. This is where the spacing
     * between a list and its page control belongs.
     */
    className?: string;
    /**
     * Accessible name of the landmark. Defaults to `'Pagination'`.
     *
     * Give each control its own name when a screen renders more than one, so a
     * landmark list distinguishes them - "Comment queue pagination" reads very
     * differently from a second anonymous "Pagination".
     */
    ariaLabel?: string;
    /**
     * Optional callback fired when a page link is clicked, **in addition to**
     * navigating.
     *
     * For side effects that belong to the click rather than to the destination:
     * closing a drawer, recording an event, scrolling a long list back to its
     * top. It receives the target page. It is never awaited, its result is
     * discarded, and it cannot cancel navigation - the anchor is the navigation
     * and this is enhancement on top of it.
     *
     * A function is not serializable, so a Server Component cannot pass this.
     * That is by design: it is optional precisely so the server-rendered feed
     * and profile can render the control without one. `usePagination`'s
     * `goToPage` is the ready-made value for a client caller that wants it.
     */
    onPageChange?: (page: number) => void;
    /**
     * Overrides where each `href` comes from.
     *
     * Omit it and the URLs come from `usePagination`, which is correct for every
     * surface whose page lives in the query string - which is all of them today.
     * Supply it when a client caller pages something that is not addressed by the
     * current URL at all, so the links still point somewhere real. It applies to
     * the page numbers and to both edge controls alike, so one call cannot end up
     * with two different URL schemes.
     */
    hrefForPage?: (page: number) => string;
  };

/**
 * The page control for every windowed collection in the product.
 *
 * Renders a named `<nav>` landmark around a list of real, crawlable `<a href>`
 * links - one per page in the bounded window, plus an edge control at each end.
 * Every URL comes from `hrefForPage`, which preserves the `q`, `category` and
 * `sort` parameters already on the URL and omits `page` entirely for page one so
 * that page one keeps a single canonical address. `onPageChange` is optional
 * enhancement fired alongside navigation and never in place of it. All page
 * arithmetic - the window, the bounds, the clamping - belongs to
 * `@/hooks/use-pagination` and is not duplicated here.
 *
 * Renders `null` when there is at most one page: a single-page result has nothing
 * to navigate, and an empty landmark is noise in a screen reader's landmark
 * list.
 *
 * This is a Client Component because the URL has to be read, but it is still
 * server-rendered, so the links are in the initial HTML. On a statically
 * rendered route it must sit inside a `<Suspense>` boundary - see section 4 of
 * this file's header for why that boundary belongs to the route and not here.
 *
 * @example A Server Component, passing the envelope straight through
 * ```tsx
 * const feed = await listPosts({ page, q, category });
 * return (
 *   <>
 *     <PostList posts={feed.items} />
 *     <Pagination {...feed} className="mt-10" />
 *   </>
 * );
 * ```
 *
 * @example A client island that also wants the callback
 * ```tsx
 * 'use client';
 * const pagination = usePagination(page);
 * return <Pagination {...pagination} onPageChange={pagination.goToPage} />;
 * ```
 *
 * @example Two controls on one screen, told apart in the landmark list
 * ```tsx
 * <Pagination {...users} ariaLabel="User pagination" />
 * <Pagination {...queue} ariaLabel="Comment queue pagination" />
 * ```
 *
 * @param page - The page currently on screen, 1-based.
 * @param pages - How many pages the collection occupies. `0` and `1` both render
 *   nothing.
 * @param total - Optional total row count; lets the hook recover a page count
 *   that did not arrive.
 * @param page_size - Optional window size, used for the same recovery.
 * @param className - Appended to the landmark's classes.
 * @param ariaLabel - Accessible name of the landmark; defaults to
 *   `'Pagination'`.
 * @param onPageChange - Optional callback fired with the target page on click.
 * @param hrefForPage - Optional override for URL construction.
 * @returns The rendered control, or `null` when there is at most one page.
 */
export function Pagination({
  page,
  pages,
  total,
  page_size,
  className,
  ariaLabel = DEFAULT_NAV_LABEL,
  onPageChange,
  hrefForPage,
}: PaginationProps): JSX.Element | null {
  // Called unconditionally and before any early return, because hook order has
  // to be stable across renders. `total` and `page_size` are optional on this
  // component and required by the hook, so they are defaulted rather than
  // omitted: the hook treats a zero window size as an ordinary input with a
  // defined answer, and neither field affects anything rendered below.
  const view = usePagination({
    page,
    pages,
    total: total ?? 0,
    page_size: page_size ?? 0,
  });

  // Gated on the DERIVED count rather than on the `pages` prop. They agree for
  // every envelope the service produces, and where they do not - a `pages` that
  // arrived as `NaN`, or a `0` alongside a real `total` - the hook has already
  // recovered a usable count, so gating here honours the recovery instead of
  // discarding it.
  if (view.pages <= 1) {
    return null;
  }

  // One resolver for every link in the control, so an override cannot apply to
  // the page numbers and miss the edge controls.
  const resolveHref = hrefForPage ?? view.hrefForPage;

  // `previousHref === null` is the hook's documented boundary signal and is what
  // decides whether an edge control is a link at all; the URL itself is then
  // produced by the resolver above so an override reaches these two as well.
  // With no override this is byte-identical to the hook's own `previousHref`,
  // because that is exactly how the hook defines it.
  const previousHref = view.previousHref === null ? null : resolveHref(view.page - 1);
  const nextHref = view.nextHref === null ? null : resolveHref(view.page + 1);

  return (
    <nav aria-label={ariaLabel} className={cn(NAV_BASE, className)}>
      {/* A list, because the set of pages IS a list: assistive technology
          announces how many there are and where the reader is within them,
          which a row of loose links cannot convey. Tailwind's preflight has
          already removed the marker and the indent. */}
      <ul className={LIST_BASE}>
        <li>
          <EdgeControl
            direction="previous"
            href={previousHref}
            onNavigate={
              onPageChange === undefined || previousHref === null
                ? undefined
                : () => {
                    onPageChange(view.page - 1);
                  }
            }
          />
        </li>

        {view.slots.map((slot) =>
          slot.kind === 'gap' ? (
            /* `aria-hidden` on the ITEM, not just on the glyph inside it: a gap
               addresses nothing, so removing the whole item keeps the announced
               item count equal to the number of pages actually offered. Nothing
               within is focusable, so hiding it strands no keyboard user.
               `side` is unique across the window - there is at most one omitted
               run below the current page and one above it - so it makes a
               stable key without this file inventing one. */
            <li aria-hidden="true" className="max-sm:hidden" key={`gap-${slot.side}`}>
              <span className={GAP_BASE}>&hellip;</span>
            </li>
          ) : (
            <li
              className={isInSiblingWindow(slot.page, view.page) ? undefined : 'max-sm:hidden'}
              key={slot.page}
            >
              <Link
                // The current page stays a link, and `aria-current` is what
                // marks it. Removing the href would cost the page its own
                // canonical self-reference, and colour alone cannot carry the
                // distinction - `aria-current` is the non-visual half of it.
                aria-current={slot.isCurrent ? 'page' : undefined}
                className={cn(
                  buttonVariants({ variant: slot.isCurrent ? 'primary' : 'ghost' }),
                  PAGE_LINK_BASE,
                )}
                href={resolveHref(slot.page)}
                onClick={
                  onPageChange === undefined
                    ? undefined
                    : () => {
                        onPageChange(slot.page);
                      }
                }
              >
                {/* The name and the visible label are two nodes with one
                    source: the hidden node carries the complete phrase so the
                    computed name cannot depend on whitespace between siblings,
                    and the visible digit is hidden from assistive technology so
                    the same number is not announced twice. `sr-only` takes the
                    first out of flow, so the box still centres on the digit. */}
                <span className="sr-only">{pageLabel(slot.page)}</span>
                <span aria-hidden="true">{slot.page}</span>
              </Link>
            </li>
          ),
        )}

        <li>
          <EdgeControl
            direction="next"
            href={nextHref}
            onNavigate={
              onPageChange === undefined || nextHref === null
                ? undefined
                : () => {
                    onPageChange(view.page + 1);
                  }
            }
          />
        </li>
      </ul>
    </nav>
  );
}
