'use client';

// MobileNav - the navigation drawer, and the sub-48rem half of the responsive
// navigation requirement (R7).
//
// AAP §0.3.2's R7 row asks for this file by name, "so navigation collapses below
// the medium breakpoint"; §0.7.1.8 calls it "the navigation that collapses into a
// modal below the medium breakpoint"; and §0.7.3.2 fixes what that means -
// navigation is "collapsed into a modal drawer" below 48rem and becomes "inline
// horizontal navigation" at 48rem and above.
//
// This file owns ONLY the first of those. The header shell, the inline
// presentation, the search affordance that appears from `lg` up, and the
// canonical link list all belong to src/components/layout/site-header.tsx, which
// renders this component inside a `md:hidden` container and its own inline
// navigation inside a `hidden md:flex` one. Nothing here imports that file: the
// dependency runs one way, and the shape both sides agree on ({@link NavItem}) is
// declared HERE precisely so it can.
//
// ---------------------------------------------------------------------------
// 1. WHY THE CONTRACT IS DECLARED IN THE CLIENT MODULE
//
// site-header.tsx renders both presentations, so it owns the list. It is also a
// Server Component, and the App Router's boundary rule is asymmetric: a server
// module may always import from a client module, while a client module may not
// import a VALUE from a server module. Declaring {@link NavItem} here and letting
// the server parent type-import it removes the hazard entirely rather than
// documenting a rule someone has to remember.
//
// The type is deliberately two string members and nothing else, because the array
// crosses the server-to-client boundary as a prop and therefore has to be
// serializable. No React node, no function, no class instance, no `Date`.
//
// ---------------------------------------------------------------------------
// 2. THE 48rem BOUNDARY, AND WHY IT IS EXACTLY 768px
//
// Tailwind's `md:` variant is `min-width: 48rem`, and 48rem is exactly 768px at
// the default 16px root font size - so at EXACTLY 768px the inline navigation is
// active and this trigger is gone. That is not a detail: the Playwright suite
// runs a project at 768px and asserts the trigger is absent there, so an
// implementation that collapsed only BELOW 768 would fail the gate.
//
// The trigger therefore carries `md:hidden` itself, in addition to the parent's
// wrapper. Two reasons, and neither is redundancy for its own sake: this file
// then satisfies the breakpoint criterion on its own terms rather than depending
// on a container it does not own, and `md:hidden` is idempotent, so the pairing
// cannot conflict. src/components/ui/table.tsx reasons about the same boundary
// from the other side with the built-in `max-md:` variant.
//
// What is NOT here, and must never be: a `matchMedia` call, a resize listener, a
// width measurement, a custom `@media` block, or an arbitrary-value variant such
// as `min-[768px]:`. The five catalogued breakpoints are the whole responsive
// vocabulary (AAP §0.8.5), and conditioning the render on a measured width would
// break server rendering and reintroduce a flash of the wrong navigation.
//
// One consequence is accepted rather than papered over: a viewport resized from
// 375px to 1440px WHILE the drawer is open leaves it open, because closing it
// would need exactly the width listener the rule forbids. Every dismissal still
// works - Escape, the corner close, an outside press, or following a link - and a
// page loaded at any width gets the correct presentation from the first paint.
//
// ---------------------------------------------------------------------------
// 3. THE DRAWER IS A RADIX DIALOG, REACHED THROUGH THE PROJECT PRIMITIVE
//
// AAP §0.8.3 maps this element to `Dialog` and its parts, and §0.8.5 makes
// behavioural primitives over hand-rolled interaction binding. So the focus trap,
// focus restoration to the trigger, Escape dismissal, outside-press dismissal,
// scroll locking and the `role="dialog"` / `aria-labelledby` / `aria-describedby`
// wiring are all @radix-ui/react-dialog's, reached through
// @/components/ui/dialog. A `useState` boolean plus an absolutely positioned
// panel would violate that rule outright, and this file contains no keydown
// handler, no outside-click listener, no `document.body` write and no `tabIndex`
// arithmetic. If any modal behaviour appears to be missing, the fix is to compose
// the primitive correctly - never to re-implement it here.
//
// `@radix-ui/react-dialog` is NOT imported directly. The design system's
// dependency rule is that Radix is reached THROUGH the project layer, so the
// scrim, panel, radius, elevation and named close affordance are decided once.
//
// WHY `DialogPortal` AND `DialogOverlay` ARE ABSENT FROM THE COMPOSITION. Both
// are exported by @/components/ui/dialog, and both are already rendered INSIDE
// `DialogContent` - which wraps its panel in `DialogPrimitive.Portal`, emits one
// `DialogOverlay`, and seats the panel in a centring frame. That file's own
// documentation records the consequence of adding a second: "Rendering both
// yields two stacked scrims and a visibly doubled wash." Hand-composing a panel
// from `DialogPortal` + `DialogOverlay` would additionally need
// `DialogPrimitive.Content`, i.e. the direct Radix import this file must not
// make. So `DialogContent` is the whole of the correct composition here, and the
// portal and the scrim arrive with it.
//
// ---------------------------------------------------------------------------
// 4. HOW A CENTRED MODAL PRIMITIVE BECOMES A START-EDGE DRAWER
//
// @/components/ui/dialog seats its panel as a centred FLEX ITEM inside a
// `fixed inset-0 p-4 flex items-center justify-center` frame, and its docs record
// that both `fixed inset-*` alternatives were measured and are wrong - the inline
// one over-constrains and "the document gains real horizontal overflow at every
// width". This file therefore does NOT make the panel fixed and adds no inset.
// It re-aligns the existing flex item with three utilities:
//
//   * `me-auto` - a `margin-inline-end: auto` absorbs all free space on the main
//     axis, which places the item at the inline START and beats the frame's
//     `justify-center`. A logical property, so the drawer follows the writing
//     direction instead of assuming left-to-right.
//   * `self-stretch` - overrides the frame's `items-center`, so the panel fills
//     the frame's cross axis and reads as a full-height sheet rather than a card.
//     The panel's own `max-h-full` and `overflow-y-auto` still apply, so a long
//     list scrolls inside the panel.
//   * `max-w-xs` - `--container-xs`, 20rem. At the narrowest viewport the suite
//     tests, the frame's content box is 375 - 32 = 343px, so the panel resolves to
//     320px and cannot reach the edge, let alone exceed it. AAP §0.9.4.5 forbids
//     horizontal overflow at every width, and nothing here can produce it: no
//     element is wider than its container, and the one class that could -
//     `whitespace-nowrap`, inherited from the Button variant - is overridden on
//     every row (see {@link NAV_LINK}).
//
// `content-between` is the fourth, and it is why the panel does not look padded
// out: the panel is a grid, a full-height grid distributes its free space, and
// `align-content: space-between` spends it in one place instead - navigation at
// the top, the appearance row at the bottom. With a single row it degrades to
// start alignment, which is also correct.
//
// ---------------------------------------------------------------------------
// 5. ACCESSIBILITY, AND THE ONE THING THIS FILE MUST NOT RENDER
//
// AAP §0.7.3.5 puts one `<h1>` on a page and gives it to the page - so there is
// NO heading of any level in this file. That collides with Radix's requirement
// that every `DialogContent` carry a `DialogTitle`, which is a real heading and
// is what `aria-labelledby` points at; omit it and the panel is announced with no
// name while Radix logs a warning. Both are satisfied at once by keeping the
// element and hiding it visually with the engine's `sr-only` utility, which is
// exactly what @/components/ui/dialog prescribes. A `DialogDescription` is
// present on the same terms, because Radix points `aria-describedby` at one and
// warns when the target is missing.
//
// The rest of the floor: a real `<nav>` landmark, named so it is distinguishable
// from the header's and the footer's; a `<ul>`/`<li>` list, because a set of
// links is a list; descriptive text as each link's accessible name, never a
// generic "here"; the menu glyph `aria-hidden` with the trigger named by hidden
// text rather than by `aria-label`, so the control has real text content; and a
// visible focus indicator on every row, which globals.css already guarantees
// globally in `--color-ring` and the Button variant restates for its own group.
//
// Radix supplies `aria-haspopup`, `aria-expanded` and `aria-controls` on the
// trigger, so none of them is written here - a hand-added copy would be a second
// source of truth for state this file does not own.
//
// ---------------------------------------------------------------------------
// 6. DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT HERE.
//
//   1. `open` / `onOpenChange` state. `Dialog` + `DialogTrigger` + `DialogClose
//      asChild` closes on navigation declaratively, so the uncontrolled form is
//      the smallest correct implementation. Controlled state would only earn its
//      keep alongside a `usePathname()` effect, and there is no behaviour left
//      for that effect to add.
//   2. A `logout()` action. The enumerated drawer entries are destinations;
//      sign-out is an ACTION and belongs to src/components/layout/user-menu.tsx,
//      which owns the session menu. Adding it here would put a second mutation
//      path beside the provider's for no gain.
//   3. Any `fetch`, any import from `@/lib/api/*`, any `process.env` read. This
//      component renders on every route, so it stays a leaf: it reads the session
//      from context and renders links. The component suite intercepts requests
//      with `onUnhandledRequest: 'error'`, so a stray fetch would fail the gate.
//   4. `import React from 'react'`. `"jsx": "react-jsx"` means the compiler
//      imports the runtime; an unused default import is a lint finding, and the
//      lint gate runs with `--max-warnings=0`.
//   5. A `dark:` variant, a literal colour, dimension, radius or shadow, or any
//      square-bracket arbitrary VALUE. Every token in globals.css is dual-valued,
//      so the drawer re-themes with no conditional here.
//   6. A raw `<button>` or a raw `<a>` for an in-app route. The trigger is
//      @/components/ui/button; every destination is `next/link`, so each row stays
//      a real crawlable, middle-clickable anchor.
//   7. A second theming mechanism. The appearance row renders
//      @/components/layout/theme-toggle, which its own documentation describes as
//      "rendered once in the site header, and optionally again inside the mobile
//      navigation drawer".
//   8. An `/items` path, an `Item` type or the `id`/`name`/`price` triple. That
//      surface is retired by AAP §0.9.4.3 and asserted gone by
//      backend/tests/integration/test_openapi_contract.py.

import Link from 'next/link';
import { useRef, type JSX } from 'react';

import { Menu } from 'lucide-react';

import { ThemeToggle } from '@/components/layout/theme-toggle';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useAuth } from '@/hooks/use-auth';
import type { UserMe } from '@/lib/types';
import { cn, encodePathSegment } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Public contract
 * ---------------------------------------------------------------------------------------------- */

/**
 * One destination in the drawer: where it goes, and what it is called.
 *
 * Declared here rather than in src/components/layout/site-header.tsx for the
 * boundary reason in section 1 of the header, and kept to two string members
 * because the array is a prop that crosses the server-to-client boundary and must
 * be serializable.
 *
 * Both members are `readonly`, which costs nothing - TypeScript ignores the
 * modifier when checking assignability between object types, so a caller's own
 * mutable literal still satisfies this shape - and it states that the drawer
 * treats an entry as a value rather than as something to edit.
 */
export type NavItem = {
  /**
   * Rendered, root-relative path, e.g. `/` or `/blog/some-slug`. It must be the
   * URL the application actually serves: a Next.js route GROUP's parentheses are
   * erased from the address, so `/(dashboard)/dashboard` is not a route and would
   * 404. See {@link NEW_POST_PATH} for the case where that trap bites.
   */
  readonly href: string;
  /**
   * Visible text, which is also the link's accessible name. Descriptive standing
   * alone, because assistive technology enumerates a page's links with none of
   * the surrounding prose. Any length is safe - rows wrap rather than overflow.
   */
  readonly label: string;
};

/** Props accepted by {@link MobileNav}. */
export interface MobileNavProps {
  /**
   * The site's primary destinations, in the order they should appear.
   *
   * Supplied by the caller and never declared here: site-header.tsx renders the
   * same list inline from `md` up, and a second copy in this file would drift
   * from it. The account entries below are appended to whatever arrives.
   *
   * Typed `readonly NavItem[]` rather than `NavItem[]` so a caller may hand over a
   * frozen inventory - the pattern src/components/layout/site-footer.tsx already
   * uses for its own links - while an ordinary mutable array still assigns.
   * Zero entries is handled: the group is then omitted rather than rendered as an
   * empty list.
   */
  items: readonly NavItem[];
  /**
   * Utility classes for the TRIGGER, merged last so they win their own Tailwind
   * group.
   *
   * Exists so site-header.tsx can POSITION the control - order it in a flex row,
   * pin it to the trailing edge - without reaching for a literal value. It is not
   * an appearance hook, and it reaches the trigger only: the drawer's own
   * presentation belongs to @/components/ui/dialog and to this file.
   */
  className?: string;
}

/* -------------------------------------------------------------------------------------------------
 * Route inventory
 *
 * Rendered addresses, declared once each with the file that serves them, because
 * a Next.js route GROUP's name is ERASED from the URL and the directory layout
 * therefore reads as though it were part of the path. A wrong address here would
 * compile, type-check, lint and render, and fail only at run time as a 404.
 *
 * src/lib/routes.ts is the canonical home for the two addresses inside the
 * `(dashboard)` group and is the file to change first if either ever moves;
 * src/middleware.ts gates the same families and is the corroborating evidence
 * that these are the real ones. They are restated as constants here rather than
 * imported so that this module's dependencies stay the ones its contract needs -
 * the same choice src/components/layout/site-footer.tsx made for `/login` and
 * `/signup`, and for the same reason it records there: a route path is not what
 * the zero-hardcoded-values rule governs, which closes the set of PRESENTATION
 * values - colour, dimension, radius, font size, shadow - each of which must
 * resolve to a token.
 * ---------------------------------------------------------------------------------------------- */

/** The sign-in screen, served by `src/app/(auth)/login/page.tsx`, i.e. `/login`. */
const LOGIN_PATH = '/login';

/** The registration screen, served by `src/app/(auth)/signup/page.tsx`. */
const SIGNUP_PATH = '/signup';

/**
 * The author workspace, served by `src/app/(dashboard)/dashboard/page.tsx`.
 *
 * The one address in that group where the URL segment and the group name coincide
 * - which is exactly why the wrong path for {@link NEW_POST_PATH} looks plausible.
 * `src/middleware.ts` gates `/dashboard/:path*`, so an unauthenticated visitor who
 * follows this link is redirected to `/login?next=%2Fdashboard`.
 */
const DASHBOARD_PATH = '/dashboard';

/**
 * The empty editor, served by `src/app/(dashboard)/posts/new/page.tsx`.
 *
 * NOTE THE ABSENT `/dashboard` PREFIX. `(dashboard)` is a route group, so its
 * name never appears in the URL and this address is `/posts/new`. `src/lib/routes.ts`
 * publishes the same value as `NEW_POST_ROUTE`, and `src/middleware.ts` gates
 * `/posts/:path*` - a second, independent confirmation that the authoring family
 * is `/posts/*` rather than something beneath `/dashboard`.
 */
const NEW_POST_PATH = '/posts/new';

/**
 * The administrative overview, served by `src/app/(admin)/admin/page.tsx`.
 *
 * `src/middleware.ts` gates `/admin/:path*` and sends a signed-in
 * non-administrator to `/`, so this link is never a way in - see the note on
 * {@link accountEntries} about what the role check below is and is not.
 */
const ADMIN_PATH = '/admin';

/**
 * First segment of the public profile family: `/u/{username}`.
 *
 * The segment itself is percent-encoded through `encodePathSegment` rather than
 * interpolated raw; {@link accountEntries} explains why that matters even for a
 * value the API guarantees.
 */
const PROFILE_PATH_PREFIX = '/u';

/* -------------------------------------------------------------------------------------------------
 * Copy
 *
 * Every string a reader or a screen reader can perceive, named so that the markup
 * below stays about structure.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The trigger's accessible name.
 *
 * Rendered as visually hidden TEXT inside the control rather than as an
 * `aria-label`, so the button has real text content, is reachable by text-based
 * tooling, and needs no attribute to stay correct. It names the ACTION rather
 * than the state, because Radix already exposes the state through
 * `aria-expanded` - a name that flipped between "Open" and "Close" would be a
 * second, competing report of the same thing.
 */
const TRIGGER_LABEL = 'Open navigation menu';

/**
 * The dialog's accessible name, and the value Radix points `aria-labelledby` at.
 *
 * Rendered by a `DialogTitle`, which is a real heading element - so it is hidden
 * visually rather than omitted, because AAP §0.7.3.5 gives the page's single
 * heading of record to the page. See section 5 of the header.
 */
const DIALOG_TITLE = 'Navigation';

/**
 * The dialog's description, the target of Radix's `aria-describedby`.
 *
 * Announced once when the drawer opens, so it says what the panel contains rather
 * than repeating its name.
 */
const DIALOG_DESCRIPTION = 'Links to the sections of this site and to your account.';

/**
 * Name of the `<nav>` landmark inside the panel.
 *
 * A page carries more than one navigation landmark - the header's inline
 * navigation from `md` up, and the footer's, which names itself "Footer" - so this
 * one is named too, and an unnamed landmark would be announced as an anonymous
 * "navigation" a screen-reader user has to enter to identify. The word
 * "navigation" is deliberately not in the string: the role already supplies it.
 */
const NAV_LABEL = 'Menu';

/**
 * Visible caption of the appearance row.
 *
 * It duplicates the theme control's OWN accessible name ("Colour theme", declared
 * in src/components/layout/theme-toggle.tsx) on purpose, so the row reads as a
 * labelled setting rather than as a bare glyph - and it is therefore
 * `aria-hidden`, because announcing the same words immediately before the button
 * that carries them would double every announcement. Nothing is withheld from
 * assistive technology: the control's hidden label is the authoritative name. If
 * that label is ever reworded, reword this to match.
 */
const THEME_ROW_LABEL = 'Colour theme';

/* -------------------------------------------------------------------------------------------------
 * Presentation
 *
 * Class sets live in named constants so each can carry the reason it exists, and
 * so the markup below reads as structure. Every value resolves to a token or to
 * one of the engine's own scales; there is no literal colour, dimension, radius,
 * font size or shadow anywhere in this file, and no square-bracket arbitrary
 * value. `transparent` and the like are not needed here at all.
 *
 * Only TWO colours appear at all - `border-border` and `text-muted-foreground` -
 * and both are semantic tokens rather than a primitive family and shade. There is
 * no `dark:` variant anywhere: globals.css declares every token twice, once at the
 * document root and once under `.dark`, so the drawer re-themes with nothing
 * conditional here. Verified in a browser - switching to dark moved the panel from
 * `rgb(255,255,255)` to `rgb(15,23,43)` and the row text the other way, with this
 * file unchanged.
 *
 * ON LOGICAL PROPERTIES. The INLINE axis is the one that flips with writing
 * direction, and every inline-axis value below is logical: `me-auto`, `px-0`,
 * `text-start`, plus the `pe-9` the dialog primitive applies to its own title.
 * The BLOCK axis uses the engine's `pt-*`, `py-*` and `border-t`, because
 * Tailwind v4 ships no logical block-axis utility and expressing one would take an
 * arbitrary property - a literal, and therefore the very thing the rule forbids.
 * @/components/ui/dialog makes the same split (`end-4` beside `top-4`), so the two
 * files agree.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The trigger: an icon-only control that exists only below `md`.
 *
 * `md:hidden` is this file's own guarantee of the breakpoint criterion; see
 * section 2 of the header for why it is stated here as well as on the parent's
 * wrapper.
 *
 * `w-11 shrink-0 px-0 [&_svg]:size-5` is the icon-only composition the Button size
 * table prescribes in place of a fourth size: the `default` size is `h-11 px-5`,
 * so dropping the inline padding and matching the width to the height produces the
 * 44x44 target WCAG 2.5.5 asks for, and the glyph is raised from the primitive's
 * 16px default to the 20px a lone icon needs inside that box. `shrink-0` keeps the
 * square from collapsing toward the glyph when it is a flex item in a tight header
 * row at 375px. Each is a scale utility, and `[&_svg]:` is a selector variant
 * rather than an arbitrary value - the same composition
 * src/components/layout/theme-toggle.tsx uses.
 */
const TRIGGER = ['md:hidden', 'w-11 shrink-0 px-0 [&_svg]:size-5'].join(' ');

/**
 * What turns the centred modal panel into a start-edge, full-height drawer.
 *
 * Four utilities, no `fixed` and no inset - see section 4 of the header for the
 * measured reason those two are absent, and for what each of these does. Merged
 * by `cn` inside `DialogContent`, so `max-w-xs` replaces the primitive's own
 * `max-w-lg` rather than fighting it.
 */
const PANEL = ['me-auto self-stretch max-w-xs', 'content-between'].join(' ');

/**
 * The one piece of arithmetic in this file, applied to whichever row comes first.
 *
 * `pt-9` reserves the corner close affordance's vertical footprint. That control
 * is `absolute end-4 top-4 size-11` inside a panel padded `p-6`, so it spans 16px
 * to 60px from the panel's edge and intrudes 36px - nine spacing steps - into the
 * padding box. Without the reservation the first row's hit area would run beneath
 * it. It is the same overlap `DialogTitle` compensates for horizontally with
 * `pe-9`, measured on the other axis.
 */
const CLOSE_AFFORDANCE_RESERVATION = 'pt-9';

/** The `<nav>` landmark: two link groups, one spacing step of separation apiece. */
const NAV = 'grid gap-2';

/** A group of rows: a vertical stack at one spacing step. */
const NAV_LIST = 'grid gap-1';

/**
 * The hairline that separates the account group from the site's own destinations.
 *
 * Applied to the account list only when a site list precedes it, so a leading rule
 * can never appear under an empty group. `border-border` is the decorative
 * hairline token, which is what a separator between related groups is - not the
 * stronger `muted-foreground` composition globals.css reserves for the boundary of
 * an interactive control.
 */
const NAV_LIST_DIVIDER = 'border-border border-t pt-2';

/**
 * One row: a full-width, left-aligned, quiet action that grows with its label.
 *
 * Composed from `buttonVariants` rather than from hand-written utilities, because
 * the primitive owns the focus ring, the hover step, the radius, the type scale
 * and the press feedback - and its own documentation blesses exactly this use for
 * a `next/link` in the layout folder. `Button asChild` is not used instead: a
 * `DialogClose asChild` already wraps the anchor, and one Slot doing one job is
 * clearer than two nested ones.
 *
 * Four overrides, and every one of them is load-bearing:
 *
 *   * `w-full justify-start text-start` - a navigation row is a full-width target
 *     read from the leading edge, not a centred label.
 *   * `whitespace-normal` - the variant sets `whitespace-nowrap`, which is right
 *     for a short action label and wrong for a navigation entry of unknown
 *     length: an unwrappable row wider than a 320px panel would make the panel
 *     scroll horizontally. Wrapping is preferred over truncation here because a
 *     destination the reader cannot read in full is not a destination. Long
 *     unbroken strings are covered too - globals.css sets `overflow-wrap:
 *     break-word` on `li`, and the property inherits into the anchor.
 *   * `h-auto min-h-11 py-2` - the variant's `h-11` is a FIXED height, so a
 *     wrapped label would spill out of it. `h-auto` lets the row grow, `min-h-11`
 *     keeps the 44px touch target as a floor, and the padding keeps a two-line
 *     label off the row's edges.
 */
const NAV_LINK = cn(
  buttonVariants({ variant: 'ghost' }),
  'h-auto min-h-11 w-full py-2',
  'justify-start text-start whitespace-normal',
);

/**
 * The appearance row, pinned to the foot of the drawer by the panel's
 * `content-between`.
 *
 * `border-t` above it marks it as a setting rather than a destination -
 * conditionally, because with no navigation above it there would be nothing to
 * separate from.
 */
const THEME_ROW = 'flex items-center justify-between gap-4';

/** The `border-t` half of {@link THEME_ROW}, applied only when rows precede it. */
const THEME_ROW_DIVIDER = 'border-border border-t pt-4';

/** The row's caption: secondary text, still above the 4.5:1 body-text threshold. */
const THEME_ROW_CAPTION = 'text-muted-foreground text-sm';

/* -------------------------------------------------------------------------------------------------
 * Session-dependent destinations
 * ---------------------------------------------------------------------------------------------- */

/**
 * What an anonymous visitor is offered. Frozen, because a shared inventory a
 * consumer could mutate at run time is not an inventory.
 */
const ANONYMOUS_ENTRIES: readonly NavItem[] = Object.freeze([
  { href: LOGIN_PATH, label: 'Log in' },
  { href: SIGNUP_PATH, label: 'Sign up' },
]);

/**
 * The account group when the identity is not known yet, or cannot be established.
 *
 * A single frozen empty array rather than a fresh `[]` per render, so the group's
 * emptiness is a value rather than an allocation.
 */
const NO_ENTRIES: readonly NavItem[] = Object.freeze([]);

/**
 * The public profile address of one account.
 *
 * The handle is percent-encoded through `encodePathSegment` rather than
 * interpolated raw, which is what src/lib/seo.ts's `profilePath` does for the same
 * family and what src/components/blog/author-byline.tsx documents as mandatory:
 * a blank handle would compose `/u/` - a different, wrong route that looks right -
 * and `.` or `..` would be resolved against the surrounding path by the URL
 * grammar before any router saw it. Both throw instead.
 *
 * The throw is deliberately NOT caught. `UserMe.username` is non-blank by the
 * API's own invariant, so reaching it means the session context is holding
 * something the service cannot have produced - a defect that belongs in
 * src/app/error.tsx, immediately, rather than as a 404 the reader has to interpret.
 *
 * @param username - {@link UserMe.username}, exactly as the API reported it. Not
 *   re-cased: the service matches it case-insensitively, so `/u/Alice` and
 *   `/u/alice` are one account, and re-casing would only publish an internal link
 *   that disagrees with the canonical one.
 * @returns The rendered, root-relative profile path.
 * @throws {TypeError} When the handle is blank or a relative-path segment.
 */
function profileHref(username: string): string {
  const segment = encodePathSegment(username, {
    operation: 'MobileNav',
    parameterName: 'user.username',
    hint: 'Use the username exactly as the API reported it for the signed-in account.',
  });

  return `${PROFILE_PATH_PREFIX}/${segment}`;
}

/**
 * The account destinations for an identity that is KNOWN - either a principal, or
 * definitely nobody.
 *
 * Called only once {@link MobileNav} has established that; see the note there for
 * the third state and why it renders neither set.
 *
 * THE ROLE CHECK IS PRESENTATION, NOT AUTHORISATION. Withholding the
 * administrative entry from a reader keeps a control they cannot use out of their
 * way; it is not a security boundary, and it is not relied on as one. Authority
 * lives server-side, in `require_admin` on the service's admin router and in the
 * ownership assertions its post and comment services make on every mutation, with
 * src/middleware.ts turning away a signed-in non-administrator at the edge as
 * defence in depth. Typing `/admin` into the address bar therefore fails for a
 * reader whether or not this function emitted a link.
 *
 * The comparison is against the `'ADMIN'` string literal because `UserRole` in
 * src/lib/types.ts is a string-literal union rather than a TypeScript `enum` -
 * deliberately, so a type-only import elides at compile time and the value never
 * reaches a bundle. The literal is checked by the compiler all the same: a typo
 * would not be assignable to the union and `tsc --noEmit` would reject it.
 *
 * @param user - The signed-in account, or `null` for a visitor known to be
 *   anonymous.
 * @returns The entries to append after the caller's own, in display order.
 */
function accountEntries(user: UserMe | null): readonly NavItem[] {
  if (user === null) {
    return ANONYMOUS_ENTRIES;
  }

  const entries: NavItem[] = [
    { href: DASHBOARD_PATH, label: 'Dashboard' },
    { href: NEW_POST_PATH, label: 'New post' },
    // Labelled by its purpose rather than by the account's own name. A handle or a
    // display name is reader-supplied text of unbounded length, and the drawer
    // already wraps - but "Your profile" is unambiguous standing alone, which is
    // what a link's accessible name has to be, and it cannot be mistaken for
    // somebody else's profile. The identity itself belongs to the header's user
    // menu, which shows the avatar and the name.
    { href: profileHref(user.username), label: 'Your profile' },
  ];

  if (user.role === 'ADMIN') {
    entries.push({ href: ADMIN_PATH, label: 'Admin' });
  }

  return entries;
}

/* -------------------------------------------------------------------------------------------------
 * Component
 * ---------------------------------------------------------------------------------------------- */

/** Props of the private row renderer. */
interface NavRowProps {
  /** The destination this row addresses. */
  readonly entry: NavItem;
}

/**
 * One row of the drawer: a list item wrapping one real anchor.
 *
 * `DialogClose asChild` is what closes the drawer on navigation, and it is the
 * whole mechanism - no state, no handler, no effect. Radix merges the close
 * behaviour onto the anchor, so a press both dismisses the panel and follows the
 * link, and the row stays a genuine `<a href>`: crawlable, middle-clickable,
 * openable in a new tab, and shown in the browser's status bar on hover.
 *
 * `next/link` rather than a raw `<a>`, so the transition is client-side and the
 * `@next/next/no-html-link-for-pages` lint rule stays satisfied.
 *
 * `type={undefined}` is not noise. Radix's close primitive renders a
 * `<Primitive.button type="button">`, and `asChild` hands that `type` straight to
 * whatever element replaces it - which on an anchor is a bogus MIME-type hint
 * (`type` on `<a>` advises the linked resource's media type) that a validator
 * reports as a bad attribute value. The child's own props win in Radix's prop
 * merge, so declaring it `undefined` drops the attribute entirely and the row
 * renders as a plain `<a href>`. Verified in the rendered output.
 *
 * Private on purpose. It is an implementation detail of {@link MobileNav}'s markup,
 * not a second component for the layout folder to reach for.
 */
function NavRow({ entry }: NavRowProps): JSX.Element {
  return (
    <li>
      <DialogClose asChild>
        <Link className={NAV_LINK} href={entry.href} type={undefined}>
          {entry.label}
        </Link>
      </DialogClose>
    </li>
  );
}

/**
 * The navigation drawer for viewports below `md` (48rem / 768px).
 *
 * Renders a single icon-only trigger; the panel exists in the DOM only while the
 * drawer is open, because Radix mounts dialog content through
 * @radix-ui/react-presence. Inside the panel: the caller's own destinations, then
 * the account destinations for the current session, then the appearance control.
 *
 * @example Mounted by the header, which owns the list and both presentations
 * ```tsx
 * const PRIMARY_NAV: readonly NavItem[] = Object.freeze([
 *   { href: '/', label: 'Home' },
 *   { href: '/blog', label: 'Blog' },
 * ]);
 *
 * <div className="md:hidden">
 *   <MobileNav items={PRIMARY_NAV} />
 * </div>
 * <nav aria-label="Main" className="hidden md:flex">
 *   {PRIMARY_NAV.map((item) => ( ... ))}
 * </nav>
 * ```
 *
 * @param items - See {@link MobileNavProps.items}. Zero entries is valid.
 * @param className - See {@link MobileNavProps.className}. Reaches the trigger.
 * @returns The trigger, and the drawer it discloses.
 * @throws {Error} When rendered outside an `AuthProvider`, propagated from
 * `useAuth()`. That reports a missing provider - a wiring defect - and never a
 * signed-out visitor, which is an ordinary state this component handles.
 */
export function MobileNav({ items, className }: MobileNavProps): JSX.Element {
  // Not wrapped in a try/catch: see @throws above. `AuthProvider` is mounted once
  // for the whole application in src/app/layout.tsx, so every route this drawer
  // appears on already has one.
  const { user, isLoading, restoreError } = useAuth();

  // THREE SESSION STATES REACH HERE, AND ONLY TWO OF THEM HAVE AN ANSWER.
  //
  // `user === null` means two different things, and src/providers/auth-provider.tsx
  // is explicit about which is which. Once `isLoading` is false and `restoreError`
  // is null, a null account means ANONYMOUS - an ordinary state, and the one the
  // sign-in entries exist for. While `isLoading` is true the restoration is still
  // in flight; and when `restoreError` is populated the credential is INTACT and
  // the service simply could not be asked, so the reader may well be signed in.
  //
  // Rendering the sign-in pair in either of those two cases is the defect the
  // provider warns about: offering "Log in" to a reader who is already signed in.
  // Rendering the principal entries would be the mirror defect - claiming a
  // dashboard, and possibly an administrative one, for an identity nobody has
  // established. So the account group is simply absent until the answer is known,
  // which is also honest for the `restoreError` case: with the service
  // unreachable, `/login` would not work either, so a link there would promise a
  // recovery it cannot deliver. The state is brief - one pass on mount - and the
  // rest of the drawer stays fully usable throughout.
  const identityKnown = !isLoading && restoreError === null;
  const account = identityKnown ? accountEntries(user) : NO_ENTRIES;

  // Both groups are conditional so the markup holds at 0, 1 and N entries: an
  // empty `<ul>` would be announced as "list, 0 items", and a separator with
  // nothing above it would be a rule floating under the panel's edge.
  const hasSiteLinks = items.length > 0;
  const hasAccountLinks = account.length > 0;
  const hasLinks = hasSiteLinks || hasAccountLinks;

  // WHERE FOCUS LANDS WHEN THE DRAWER OPENS, AND WHY IT HAS TO BE SAID.
  //
  // Radix moves focus into the panel by itself, and this is NOT a second
  // implementation of that - `onOpenAutoFocus` is the primitive's own documented
  // seam for choosing the landing spot, so redirecting through it composes the
  // behaviour rather than replacing it. Nothing here traps focus, restores it, or
  // handles a key; all of that remains Radix's.
  //
  // The redirect is needed because Radix's mount auto-focus runs its candidate
  // list through `removeLinks`, which DELIBERATELY skips every `<a>` - sensible
  // for a confirmation dialog whose actions are buttons, and wrong for a drawer
  // whose entire content is links. Measured in Chrome: without this, opening the
  // menu focused the appearance control at the BOTTOM of the panel, because it
  // was the first tabbable that was not an anchor. A keyboard or screen-reader
  // user therefore arrived at a colour-theme setting when they asked for the
  // navigation.
  //
  // Focusing the panel itself is the fix rather than focusing the first link:
  // the panel carries `tabIndex={-1}` from Radix, so it is programmatically
  // focusable; landing on it announces the dialog's role, name and description
  // before any one entry; and the first `Tab` then reaches the first row in DOM
  // order, which is what a menu is expected to do. It also stays correct when
  // there are no rows at all.
  const panelRef = useRef<HTMLDivElement>(null);

  function focusPanelOnOpen(event: Event): void {
    const panel = panelRef.current;

    // Guard BEFORE `preventDefault`, so a missing node cannot leave focus
    // outside the panel: with nothing to focus we let Radix's own default run.
    if (panel === null) {
      return;
    }

    event.preventDefault();
    panel.focus();
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        {/* `asChild` so the project's Button IS the trigger rather than sitting
            inside one, which would nest two controls. Radix adds `aria-haspopup`,
            `aria-expanded` and `aria-controls` here itself; none is written by
            hand. The caller's `className` is merged last so the header can
            position the control without overriding what it looks like. */}
        <Button className={cn(TRIGGER, className)} variant="ghost">
          <Menu aria-hidden="true" />
          <span className="sr-only">{TRIGGER_LABEL}</span>
        </Button>
      </DialogTrigger>

      {/* No DialogPortal and no DialogOverlay: DialogContent renders both. See
          section 3 of the header - adding them would stack a second scrim. */}
      <DialogContent className={PANEL} onOpenAutoFocus={focusPanelOnOpen} ref={panelRef}>
        {/* Required by Radix, hidden by AAP §0.7.3.5. Both are `sr-only` rather
            than absent, so the panel keeps its accessible name and its
            description while the page's single heading of record stays the
            page's. */}
        <DialogTitle className="sr-only">{DIALOG_TITLE}</DialogTitle>
        <DialogDescription className="sr-only">{DIALOG_DESCRIPTION}</DialogDescription>

        {hasLinks ? (
          <nav aria-label={NAV_LABEL} className={cn(NAV, CLOSE_AFFORDANCE_RESERVATION)}>
            {hasSiteLinks ? (
              <ul className={NAV_LIST}>
                {items.map((item) => (
                  <NavRow entry={item} key={item.href} />
                ))}
              </ul>
            ) : null}

            {hasAccountLinks ? (
              <ul className={cn(NAV_LIST, hasSiteLinks && NAV_LIST_DIVIDER)}>
                {account.map((entry) => (
                  <NavRow entry={entry} key={entry.href} />
                ))}
              </ul>
            ) : null}
          </nav>
        ) : null}

        {/* The appearance control, composed rather than reimplemented: theming is
            next-themes' and @/components/layout/theme-toggle's, and this file knows
            no class name, no storage key and no colour. When no rows precede it the
            row inherits the close-affordance reservation instead of the separator,
            so it can never sit under the corner control. */}
        <div className={cn(THEME_ROW, hasLinks ? THEME_ROW_DIVIDER : CLOSE_AFFORDANCE_RESERVATION)}>
          <span aria-hidden="true" className={THEME_ROW_CAPTION}>
            {THEME_ROW_LABEL}
          </span>
          <ThemeToggle />
        </div>
      </DialogContent>
    </Dialog>
  );
}
