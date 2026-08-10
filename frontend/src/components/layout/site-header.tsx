// =============================================================================
// site-header.tsx - the application's `banner` landmark, and the composing
// parent of src/components/layout/.
//
// AAP §0.7.1.8 (Group 8) names this path and describes the folder as
// "Application shell, theme control, session menu, and the navigation that
// collapses into a modal below the medium breakpoint". This file is the shell:
// the brand mark, the primary navigation in its inline presentation, the search
// entry point, and the composition of the folder's three client islands
// (src/components/layout/theme-toggle.tsx, user-menu.tsx and mobile-nav.tsx).
//
// It is mounted ONCE by src/app/layout.tsx, as a sibling of <main> and
// src/components/layout/site-footer.tsx, so it renders on EVERY route. That one
// fact governs almost every decision below - the absent directive, the absent
// fetch, the absent hook, and the search control being built here rather than
// borrowed from the feed.
//
// -----------------------------------------------------------------------------
// 1. NO 'use client' - THE STRUCTURAL DECISION THIS FILE EXISTS TO GET RIGHT
//
// This is a Server Component that COMPOSES Client Components, which is the
// intended App Router pattern rather than a compromise: `'use client'` marks a
// boundary in the IMPORT GRAPH, and everything reachable past it becomes client
// code. Because this header renders on every route, a directive here would widen
// the client boundary application-wide and defeat the narrow-island split that
// AAP §0.6.5 and the server-rendered-content SEO requirement (R9) depend on.
//
// The boundary therefore starts at each island, not here. ThemeToggle, UserMenu
// and MobileNav carry their own `'use client'`; this file imports and renders
// them, which is always legal in that direction. Everything else it imports -
// @/components/ui/{button,input,label}, @/lib/seo, @/lib/utils - is deliberately
// directive-free, so nothing is dragged across a boundary by accident.
//
// The consequences are accepted deliberately, not overlooked:
//
//   * NO HOOK OF ANY KIND. No `useState`, `useEffect`, `usePathname`,
//     `useSearchParams`, `useId`, `useAuth` or `useTheme`. Each would force the
//     directive.
//   * NO ACTIVE-LINK HIGHLIGHTING. It needs `usePathname()`. The AAP does not
//     ask for it, and it is not worth converting the whole shell into a client
//     island for. If it is ever wanted, the correct move is a small dedicated
//     island - never a directive on this file.
//   * NO SESSION- OR ROLE-DEPENDENT MARKUP. Whether a visitor is signed in, and
//     whether they are an administrator, is answered by UserMenu and by
//     MobileNav's own account section, both of which already own `useAuth()`.
//     Note what that is and is not: hiding a control is a user-experience
//     nicety, NEVER a security boundary. `require_admin` on the backend's admin
//     router is the boundary.
//   * NO FETCH, and no import from @/lib/api/*. A request here would be a
//     request on every page render. In particular the category list is NOT
//     fetched to build a header filter: the category filter belongs to the feed
//     (@/components/blog/category-filter.tsx).
//
// -----------------------------------------------------------------------------
// 2. THE SEARCH CONTROL IS BUILT HERE, NOT BORROWED FROM THE FEED
//
// AAP §0.7.3.2 gives the navigation "a search affordance" from `lg` up, which
// tempts the obvious reuse of @/components/blog/search-input.tsx. That import is
// forbidden, and the reason is a boundary rather than a preference:
//
//   * search-input.tsx is a CLIENT island bound to the home feed's `q` URL state
//     through @/hooks/use-debounced-value. Rendering it in a header that appears
//     on every route would push that island - and its debounce timer - onto every
//     page, which is exactly the widening section 1 exists to prevent.
//   * It would couple `layout/` to `blog/`. The two folders are independent, and
//     the layered-separation standard keeps them that way.
//
// So the affordance here is a self-contained NATIVE HTML GET FORM: an
// @/components/ui/input named `q` and an @/components/ui/button of
// `type="submit"`, inside `<form method="get" role="search">`. A native GET form
// serialises its own fields into the query string and navigates, which buys three
// things at once - no `'use client'`, no JavaScript at all, and a control that
// still works with scripting disabled, reinforcing the R9 crawlability posture.
// The two controls are still the PROJECT PRIMITIVES: `<form>` is not on the
// forbidden raw-element list (that list is exactly <button>, <input>, <textarea>,
// <select>, <table>), but the field and the submit must be, and are.
//
// The two search surfaces are complementary rather than duplicated: this one is
// the site-wide entry point that navigates TO the feed, and the feed's own
// debounced control refines a search once the reader is there.
//
// -----------------------------------------------------------------------------
// 3. THE 48rem BOUNDARY, AND WHY IT IS EXACTLY 768px
//
// AAP §0.7.3.2's navigation row is this file's specification, and it has three
// steps: collapsed into a modal drawer below 48rem, inline horizontal navigation
// at 48rem and above, inline with a search affordance at 64rem and above.
//
// Tailwind's `md:` variant is `min-width: 48rem`, and 48rem is exactly 768px at
// the default 16px root font size - so the inline navigation is active AT 768,
// not merely above it. AAP §0.9.4.5 runs a Playwright project at exactly 768px
// and asserts the inline navigation is present and the drawer trigger absent, so
// an implementation that switched only BEYOND 768 would fail the gate. The two
// classes are exact complements: `hidden md:flex` on the inline navigation,
// `md:hidden` on the drawer slot. MobileNav's own trigger also carries
// `md:hidden`, which is idempotent with the slot and lets that file satisfy the
// criterion on its own terms.
//
// The five catalogued breakpoints (`sm` 40rem, `md` 48rem, `lg` 64rem, `xl`
// 80rem, `2xl` 96rem) are the whole responsive vocabulary. There is no custom
// `@media` block here, no `matchMedia`, no resize listener, no width measurement
// and no arbitrary-value variant such as `min-[768px]:` - and a width check would
// force the client directive besides.
//
// -----------------------------------------------------------------------------
// 4. HOW THIS FILE AVOIDS HORIZONTAL OVERFLOW AT EVERY WIDTH
//
// AAP §0.9.4.5 forbids horizontal overflow at 375px, 768px and 1440px. Nothing
// here can produce it, by construction rather than by measurement:
//
//   * The brand mark is the ONLY flexible item. It carries `min-w-0` and wraps
//     its text in a `min-w-0 truncate` span, so an arbitrarily long site name
//     ellipsises instead of widening the row. Both classes are load-bearing: a
//     flex item's default `min-width: auto` floors it at its content width, and
//     `text-overflow` needs the blockified span rather than the flex container.
//   * Every other item is `shrink-0`, so the row's free space is taken from the
//     brand mark and from nowhere else.
//   * No element has a fixed width. The one width declared - on the search field
//     - is a scale utility on a control that is hidden below `lg`, and the field
//     already brings `min-w-0` of its own.
//   * At 375px only the brand mark, the appearance control, the session menu and
//     the drawer trigger are rendered at all.
//
// -----------------------------------------------------------------------------
// 5. WHAT THIS FILE MUST NOT RENDER, AND WHY
//
//   1. AN <h1>. AAP §0.7.3.5 puts exactly one on a page and gives it to the
//      page. The brand mark is therefore a LINK, not a heading - and there is no
//      heading of any level in this file.
//   2. A SKIP-NAVIGATION LINK. It would have to target an `id` on the <main>
//      element owned by src/app/layout.tsx, which this file does not own. A
//      dangling fragment is worse than none, and the three landmark elements
//      (banner here, main and contentinfo elsewhere) already satisfy the §0.7.3.5
//      floor.
//   3. A `dark:` COLOUR OVERRIDE. All fourteen semantic tokens in
//      src/app/globals.css are dual-valued - declared at the document root and
//      again under `.dark` - so this header re-themes with no conditional of its
//      own. A `dark:` class would be a second source of truth for one decision.
//   4. A FOCUS-RING DECLARATION. globals.css sets
//      `:focus-visible { outline: 2px solid var(--app-ring); outline-offset: 2px }`
//      in `@layer base`, so every interactive element in this header already has
//      a visible indicator resolving to `--color-ring`. The button primitive adds
//      its own matching `focus-visible:outline-*` on top. Restating it here would
//      duplicate a decision made once.
//   5. ANY LITERAL COLOUR, DIMENSION, RADIUS, FONT SIZE OR SHADOW. Every value
//      below resolves to a token; the only literals are the permitted ones. There
//      is no `style` attribute and no bracketed arbitrary VALUE.
//   6. ANYTHING FROM THE RETIRED SURFACE. No `/items` path, no `Item` type and no
//      `id`/`name`/`price` triple: AAP §0.9.4.3 retires them and
//      backend/tests/integration/test_openapi_contract.py asserts their absence.
//      Worth recording that before this change `GET /` returned 404 and there was
//      no landing page to arrive at - this is the first landmark structure the
//      project has ever had.
//   7. ANYTHING AAP §0.9.3 excludes: no locale or language switcher, no analytics,
//      no A/B testing, no feature flags, no consent banner and no notification
//      bell.
//
// -----------------------------------------------------------------------------
// 6. WHERE THE SITE NAME COMES FROM
//
// `resolveSiteName()` from @/lib/seo, and nowhere else. That module is one of only
// two in this tier permitted to read the environment and it owns
// NEXT_PUBLIC_SITE_NAME outright, so reading `process.env` here would be a second
// reader of one value and hard-coding the name would brand every page with a
// string that silently disagrees with the <title> template and every social card.
//
// It is called in the RENDER BODY, not at module scope, and that placement is
// deliberate: the resolver THROWS when the variable is absent rather than
// substituting a placeholder, and a module-scope call would move that throw into
// module evaluation, surfacing a misconfiguration as an unrelated import failure
// in whatever imported the header first. Called here it fails where it is used,
// with the resolver's own message naming the variable and pointing at
// .env.example. There is no try/catch and no fallback string, for the same
// reason - and this introduces no new failure mode, since layout.tsx's
// `buildRootMetadata()` and site-footer.tsx already call the same resolver.
// =============================================================================

import Link from 'next/link';
import type { JSX } from 'react';

import { Search } from 'lucide-react';

import { MobileNav, type NavItem } from '@/components/layout/mobile-nav';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { UserMenu } from '@/components/layout/user-menu';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { feedPath, resolveSiteName } from '@/lib/seo';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Navigation inventory
 *
 * The canonical list of the site's primary destinations, declared ONCE and rendered
 * TWICE - inline by this file from `md` up, and inside the drawer by MobileNav, which
 * receives it as its `items` prop. Two lists would drift.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The site's primary destinations, in the order they appear.
 *
 * {@link NavItem} is TYPE-IMPORTED from src/components/layout/mobile-nav.tsx, which
 * declares it. The direction is deliberate and asymmetric: a server module may always
 * import from a client module, while a client module may not import a VALUE from a
 * server module - so owning the shape in the island removes the hazard entirely
 * instead of leaving a rule for someone to remember. No second `NavItem` is declared
 * here, and none is re-exported.
 *
 * Every entry is `{ href, label }` and nothing more, because this array crosses the
 * server-to-client boundary as a prop and must be serializable: no React node, no
 * function, no class instance, no `Date`. Frozen because an inventory a consumer could
 * mutate at run time is not an inventory - the same choice mobile-nav.tsx and
 * site-footer.tsx make for their own lists.
 *
 * WHY THIS LIST HAS EXACTLY ONE ENTRY. Every candidate was checked against the route
 * inventory in AAP §0.4.5.2, and a link to a route the application does not serve would
 * compile, type-check, lint and render, failing only at run time as a 404 - so the list
 * is deliberately short and provably real rather than plausible:
 *
 *   * `/` is the home feed, served by `src/app/page.tsx`. Addressed through
 *     `feedPath()` rather than written as `'/'`, so the header, the footer, the
 *     category badges and `src/app/sitemap.ts` cannot disagree about the feed's
 *     canonical address. `feedPath()` with no argument omits every default and returns
 *     bare `/`.
 *   * `/blog/{slug}` and `/u/{username}` are DYNAMIC. Neither has an index page -
 *     §0.4.5.2 lists `blog/[slug]/page.tsx` and `u/[username]/page.tsx` and no
 *     `blog/page.tsx` - so `/blog` would 404, and linking a specific one would need
 *     data this file must not fetch (section 1).
 *   * `/login` and `/signup` are SESSION-DEPENDENT, and are already surfaced twice
 *     over: by UserMenu in the header cluster, and by MobileNav's own anonymous
 *     account entries inside the drawer. Adding them here would render them a second
 *     time in the very same drawer.
 *   * `/dashboard`, `/posts/new` and `/admin` are ROLE- or session-dependent, gated by
 *     src/middleware.ts (`/dashboard/:path*`, `/posts/:path*`, `/admin/:path*`, which
 *     redirect to `/login?next=<encoded path>`), and are likewise owned by UserMenu and
 *     MobileNav's account group.
 *   * A SECOND FEED VIEW carrying a query parameter was considered and rejected on
 *     evidence. `sort` admits exactly two values - `recent`, which is the default and
 *     is therefore omitted from a canonical URL, and `relevance`, which is meaningless
 *     without a `q` - so there is no third ordering to offer. A hard-coded
 *     `?category=<slug>` would become a dead filter the moment an administrator deletes
 *     that category through `DELETE /api/v1/admin/categories/{id}`, and discovering a
 *     live slug would require the fetch section 1 forbids.
 *
 * A one-entry list is handled correctly on both sides: `<ul>` is valid with a single
 * `<li>`, and MobileNavProps documents that it appends its account entries to whatever
 * arrives and omits the group entirely when nothing does.
 */
const PRIMARY_NAV: readonly NavItem[] = Object.freeze([{ href: feedPath(), label: 'Home' }]);

/* -------------------------------------------------------------------------------------------------
 * Copy and identifiers
 *
 * Every string a reader or a screen reader can perceive, named so the markup below stays
 * about structure.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Accessible name of the inline `<nav>` landmark.
 *
 * A page carries three navigation landmarks - this one from `md` up, the drawer's (which
 * names itself "Menu") and the footer's (which names itself "Footer") - so each is named,
 * because an unnamed landmark is announced as an anonymous "navigation" that a
 * screen-reader user has to enter in order to identify. The word "navigation" is
 * deliberately absent from the string: the role already supplies it.
 */
const PRIMARY_NAV_LABEL = 'Main';

/**
 * Accessible name of the `role="search"` landmark.
 *
 * The home feed renders a second search landmark of its own
 * (@/components/blog/search-input.tsx), so naming this one is what lets assistive
 * technology tell the site-wide entry point from the in-page refinement. Announced as
 * "Site search", since the role supplies the noun - the same reason the navigation label
 * above omits "navigation".
 */
const SEARCH_LANDMARK_LABEL = 'Site';

/**
 * The search field's accessible name, rendered as a visually hidden `<label>`.
 *
 * A real `<label>` bound by `htmlFor`, not an invented `aria-label`: label text is
 * genuine content, reachable by a translation layer and by text-based tooling. The
 * wording matches the feed's own control so one action is named one way across the tier.
 */
const SEARCH_FIELD_LABEL = 'Search posts';

/**
 * The field's placeholder - a visual cue only, never the accessible name.
 *
 * Deliberately NOT the same string as {@link SEARCH_FIELD_LABEL}: a placeholder vanishes
 * the moment a reader types, so it cannot carry the name, and this control's label is
 * visually hidden. Kept short because the field is narrow; the feed's wider control
 * affords the longer prompt.
 */
const SEARCH_FIELD_PLACEHOLDER = 'Search\u2026';

/** The submit control's accessible name, rendered as visually hidden text beside its glyph. */
const SEARCH_SUBMIT_LABEL = 'Search';

/**
 * The query-string parameter the feed reads its search term from.
 *
 * Exactly `q`, which is what `src/app/page.tsx` reads and what `feedPath()` writes. A
 * native GET form serialises a field under its `name`, so this string IS the contract
 * between this control and the feed: rename it and the search silently stops narrowing
 * anything.
 */
const SEARCH_PARAM = 'q';

/**
 * DOM `id` bound to {@link SEARCH_FIELD_LABEL} through the field's `htmlFor` pairing.
 *
 * A module constant rather than `useId()`, and that is safe HERE for a reason that does
 * not generalise: `useId` is a hook, hooks require `'use client'` (section 1), and this
 * header is mounted exactly once per document by src/app/layout.tsx - so one fixed
 * identifier cannot collide with a second instance of itself. @/components/blog/
 * search-input.tsx reaches for `useId()` precisely because it can be instantiated many
 * times on one page; this shell cannot.
 */
const SEARCH_FIELD_ID = 'site-header-search';

/* -------------------------------------------------------------------------------------------------
 * Class tables
 *
 * Declared as module constants so the markup below reads as structure. Every value
 * resolves to a token from src/app/globals.css or to a utility generated from the
 * engine's own scales; the only literals are `0` (in `top-0`, `px-0`) and `transparent`
 * (inherited from the ghost variant). No bracketed arbitrary VALUE appears anywhere -
 * `[&_svg]` in the icon recipe is an arbitrary SELECTOR whose value, `size-5`, is a
 * spacing-scale utility, which is the composition @/components/ui/button.tsx documents
 * for an icon-only control and the one theme-toggle.tsx and mobile-nav.tsx already use.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `<header>` element itself.
 *
 * `sticky top-0` keeps the shell reachable while a long post scrolls - `0` is one of the
 * six permitted literals. `z-40` is a step from the engine's own scale, chosen rather
 * than guessed: every Radix portal surface in this project sits at `z-50` (the dialog
 * scrim and frame, the dropdown-menu content, the select content) and the post editor's
 * sticky action bar sits at `md:z-10`, so 40 is above all page content and below every
 * overlay. A sticky header needs an opaque ground or scrolled text shows through, and
 * `bg-background` is the token the body itself uses, so the header cannot disagree with
 * the page behind it. `border-b border-border` mirrors site-footer.tsx's `border-t
 * border-border`: `--color-border` is the decorative hairline globals.css designates for
 * exactly this, as opposed to the control boundary the secondary button and the fields
 * compose.
 */
const HEADER_BASE = 'sticky top-0 z-40 border-b border-border bg-background';

/**
 * The content measure.
 *
 * Identical to site-footer.tsx's shell minus its vertical padding, because the header,
 * the page content and the footer must share one measure or the brand mark will not line
 * up with the text beneath it. `max-w-6xl` is `--container-6xl`; `mx-auto` centres it;
 * `px-4 sm:px-6` is the gutter, stepping once at the only breakpoint that needs it.
 */
const HEADER_SHELL = 'mx-auto w-full max-w-6xl px-4 sm:px-6';

/**
 * The single row every child sits in.
 *
 * `h-16` fixes the shell's height from the spacing scale, which is what lets a sticky
 * header have a predictable offset; it comfortably contains the 44px controls inside it.
 * The gap steps up once at `sm` so the row is tight where space is scarce and relaxed
 * where it is not.
 */
const HEADER_ROW = 'flex h-16 items-center gap-2 sm:gap-4';

/**
 * The brand mark.
 *
 * Not an `<h1>` and not styled with `buttonVariants` - a wordmark is neither a heading
 * (section 5) nor an action. `min-w-0` makes it the row's one flexible item, so it is
 * where free space is taken from; see section 4. `min-h-11` gives it a 44px activation
 * height, clearing the WCAG 2.5.5 target-size floor that a 1.75rem line box alone would
 * miss - and there is no design source specifying anything smaller, so the floor
 * applies. `rounded-md` shapes the focus outline globals.css draws around it. The hover
 * step is a token, and Tailwind v4 already scopes `hover:` to
 * `@media (hover: hover)`, so it cannot stick on a touch device.
 */
const BRAND_LINK = cn(
  'flex min-h-11 min-w-0 items-center rounded-md',
  'text-lg font-semibold text-foreground',
  'hover:text-accent motion-safe:transition-colors motion-safe:ease-out',
);

/**
 * The site name inside the brand mark.
 *
 * All three classes are load-bearing, and the obvious one-liner does not work: `truncate`
 * needs a block container, so the name lives in a `<span>` that flex blockifies;
 * `min-w-0` is required because a flex item's default `min-width: auto` floors it at its
 * content width and it would never shrink enough to overflow; and the parent's own
 * `min-w-0` is what bounds the pair. Together they mean an arbitrarily long site name
 * ellipsises rather than widening the header.
 */
const BRAND_NAME = 'min-w-0 truncate';

/**
 * The inline navigation landmark: absent below 48rem, a flex row at 48rem and above.
 *
 * The exact complement of {@link DRAWER_SLOT}. `shrink-0` keeps the brand mark as the
 * only item that gives up space. See section 3 for why the boundary is `md` and not a
 * measured width.
 */
const PRIMARY_NAV_LANDMARK = 'hidden shrink-0 md:flex';

/** The list inside the navigation landmark. A real `<ul>`, so its length is announced. */
const PRIMARY_NAV_LIST = 'flex items-center gap-1';

/**
 * One navigation anchor.
 *
 * The class table from @/components/ui/button.tsx rather than hand-restated classes,
 * which is what that module exports `buttonVariants` for - its JSDoc names the `layout`
 * folder as a consumer and shows this exact use. `ghost` is the variant it designates
 * for "header navigation". The DEFAULT size is taken deliberately: it is 44px, so the
 * anchor clears the target-size floor with no override, where `sm` would be 32px and
 * would need one.
 *
 * `<Button asChild>` is the alternative and is equally compliant; the class table is used
 * here because these anchors need no prop merging, and because mobile-nav.tsx styles its
 * own rows the same way - so the two presentations of one list stay visibly related.
 */
const PRIMARY_NAV_LINK = buttonVariants({ variant: 'ghost' });

/**
 * The trailing group: search, appearance, session, drawer trigger.
 *
 * `ms-auto` is the logical `margin-inline-start: auto`, so the group is pushed to the
 * inline END and follows the writing direction instead of assuming left-to-right - and it
 * absorbs the row's free space, which is what leaves the brand mark and the navigation
 * at the start. `shrink-0` on the group, so its controls never compress.
 */
const TRAILING_GROUP = 'ms-auto flex shrink-0 items-center gap-1 sm:gap-2';

/**
 * The search form: absent below 64rem, a flex row at 64rem and above.
 *
 * `hidden ... lg:flex` is AAP §0.7.3.2's third step. `items-center` and `gap-2` are inert
 * while the element is `display: none`, so declaring them unconditionally costs nothing
 * and keeps the class list readable.
 */
const SEARCH_FORM = 'hidden items-center gap-2 lg:flex';

/**
 * The search field's width.
 *
 * The field already brings `w-full min-w-0 h-11` of its own, so only the measure is set
 * here - two steps from the spacing scale, widening once at `xl` where there is room.
 * `cn` resolves this against the field's `w-full` in the caller's favour, since both are
 * the same Tailwind group.
 */
const SEARCH_FIELD = 'w-40 xl:w-56';

/**
 * The submit control, squared into an icon button.
 *
 * `w-11 px-0` is the composition @/components/ui/button.tsx documents for an icon-only
 * control - the default size is `h-11 px-5`, so removing the horizontal padding and
 * fixing the width to the same 11 steps produces a 44px square - and `[&_svg]:size-5`
 * matches the glyph scale theme-toggle.tsx and mobile-nav.tsx use for their triggers, so
 * the three icons in this row are the same size. `secondary` rather than `ghost` is
 * deliberate: its boundary composes from `--color-muted-foreground`, which is the same
 * edge colour the field beside it uses, so the button and the field read as one control
 * group.
 */
const SEARCH_SUBMIT = 'w-11 shrink-0 px-0 [&_svg]:size-5';

/**
 * The drawer trigger's slot: present below 48rem, absent at 48rem and above.
 *
 * The exact complement of {@link PRIMARY_NAV_LANDMARK}. MobileNav's trigger carries
 * `md:hidden` itself as well; the two are idempotent, and the duplication is what lets
 * that file satisfy the breakpoint criterion without depending on a container it does not
 * own.
 */
const DRAWER_SLOT = 'md:hidden';

/* -------------------------------------------------------------------------------------------------
 * Component
 * ---------------------------------------------------------------------------------------------- */

/** Props for {@link SiteHeader}. */
export interface SiteHeaderProps {
  /**
   * Extra classes for the `<header>` element, merged last so they win their Tailwind
   * group.
   *
   * Exists so src/app/layout.tsx can POSITION the header within the page shell without
   * this file knowing the shell's structure and without the caller reaching for an inline
   * style. It is not an invitation to re-skin the header: a colour passed through here
   * would be a value chosen outside the token layer. Optional, and the header is complete
   * without it - `<SiteHeader />` is the expected call.
   */
  className?: string;
}

/**
 * The application's `banner` landmark.
 *
 * A Server Component by design - it must never acquire a `'use client'` directive, a hook
 * or a fetch, because it renders on every route in the product. See section 1 for the
 * full reasoning. The three interactive surfaces it composes are Client Components that
 * own their own boundaries.
 *
 * @param props - See {@link SiteHeaderProps}.
 * @returns The banner landmark: brand mark, inline navigation, search entry point,
 * appearance control, session menu and drawer trigger.
 * @throws {Error} When `NEXT_PUBLIC_SITE_NAME` is unset or blank, propagated from
 * `resolveSiteName()`. Deliberate: an unbranded header would ship a placeholder to
 * readers, and the message names the variable and points at `.env.example`. See section 6.
 *
 * @example Mounted once, as a sibling of `<main>`, so it maps to `banner`
 * ```tsx
 * <body className="flex min-h-dvh flex-col">
 *   <SiteHeader />
 *   <main className="flex-1">{children}</main>
 *   <SiteFooter />
 * </body>
 * ```
 */
export function SiteHeader({ className }: SiteHeaderProps): JSX.Element {
  // Resolved per render rather than at module scope; section 6 records why the placement
  // is load-bearing rather than incidental.
  const siteName = resolveSiteName();

  return (
    <header className={cn(HEADER_BASE, className)}>
      <div className={HEADER_SHELL}>
        <div className={HEADER_ROW}>
          {/*
           * The brand mark. A link to the feed, never an <h1> (section 5), and addressed
           * through `feedPath()` so it cannot disagree with the footer's own home link.
           */}
          <Link className={BRAND_LINK} href={feedPath()}>
            <span className={BRAND_NAME}>{siteName}</span>
          </Link>

          {/* Named, so this landmark is distinguishable from the drawer's and the footer's. */}
          <nav aria-label={PRIMARY_NAV_LABEL} className={PRIMARY_NAV_LANDMARK}>
            <ul className={PRIMARY_NAV_LIST}>
              {PRIMARY_NAV.map((item) => (
                <li key={item.href}>
                  <Link className={PRIMARY_NAV_LINK} href={item.href}>
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className={TRAILING_GROUP}>
            {/*
             * The site-wide search entry point (section 2). A native GET form: the browser
             * serialises the field named `q` into the query string and navigates to
             * `/?q=<term>` with no JavaScript, so this control works with scripting
             * disabled and needs no client boundary.
             *
             * `role="search"` promotes the form to a search landmark. Not redundant with
             * the implicit `form` role, and invisible - it changes nothing about the
             * rendering.
             *
             * Submitting an empty field produces `/?q=` rather than bare `/`, which a
             * native form cannot avoid without the JavaScript this control exists to do
             * without. It is harmless: the feed treats a blank term as absent, exactly as
             * `feedPath()` does when it canonicalises, so the result set is the unfiltered
             * feed either way.
             *
             * No `maxLength`. The service's ceiling lives in @/lib/types, which this file
             * does not depend on, and restating the number here would be a second source
             * of truth for one bound; the feed page owns normalising its own `q`.
             */}
            <form
              action={feedPath()}
              aria-label={SEARCH_LANDMARK_LABEL}
              className={SEARCH_FORM}
              method="get"
              role="search"
            >
              {/*
               * A real <label>, visually hidden rather than omitted, bound by `htmlFor` to
               * the field's `id`. `sr-only` is the engine's own built-in utility, so the
               * accessible name is genuine label text instead of an invented attribute.
               */}
              <Label className="sr-only" htmlFor={SEARCH_FIELD_ID}>
                {SEARCH_FIELD_LABEL}
              </Label>

              {/*
               * `type="search"` rather than the primitive's `text` default, so the platform
               * contributes its own affordances - a clear control, and the search keyboard
               * on a touch device.
               */}
              <Input
                className={SEARCH_FIELD}
                id={SEARCH_FIELD_ID}
                name={SEARCH_PARAM}
                placeholder={SEARCH_FIELD_PLACEHOLDER}
                type="search"
              />

              {/*
               * `type="submit"` is explicit and wins over the primitive's `button` default,
               * which exists so that a button inside a form cannot submit it by accident.
               * The glyph is decorative and says so; the control's name is the visually
               * hidden text beside it, which is real content rather than an `aria-label`.
               */}
              <Button className={SEARCH_SUBMIT} type="submit" variant="secondary">
                <Search aria-hidden="true" />
                <span className="sr-only">{SEARCH_SUBMIT_LABEL}</span>
              </Button>
            </form>

            {/* Both islands own their own client boundary, their own state and their own labels. */}
            <ThemeToggle />
            <UserMenu />

            {/*
             * The sub-48rem half of the navigation requirement, handed the same canonical
             * list the inline presentation above renders. See section 3 for the boundary.
             */}
            <div className={DRAWER_SLOT}>
              <MobileNav items={PRIMARY_NAV} />
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
