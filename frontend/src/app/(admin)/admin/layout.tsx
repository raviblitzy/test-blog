'use client';

// The `(admin)` group's shell: the administrative chrome, and the one place this segment decides
// who may see it at all.
//
// AAP §0.4.5.2 and §0.7.1.9 (Group 9) list this file as the `layout.tsx` of the `(admin)` route
// group, serving R11 - "an admin dashboard for managing users, posts, comments, and categories".
// Five pages render inside it, each owned by another file: the overview band of aggregate counts,
// and the four management screens the requirement names one by one.
//
// -------------------------------------------------------------------------------------------------
// THE URL CONTRACT, WHICH THE DIRECTORY NAME ACTIVELY MISLEADS ABOUT
//
// `(admin)` is parenthesised, so Next.js ERASES it from every URL beneath it. `admin` is a REAL
// directory inside the group, which is why the rendered addresses keep exactly one `/admin`:
//
//   (admin)/admin/layout.tsx             -> the shell for every address below
//   (admin)/admin/page.tsx               -> /admin
//   (admin)/admin/users/page.tsx         -> /admin/users
//   (admin)/admin/posts/page.tsx         -> /admin/posts
//   (admin)/admin/comments/page.tsx      -> /admin/comments
//   (admin)/admin/categories/page.tsx    -> /admin/categories
//
// A path that keeps the parenthesised group name is not an address, it is a 404, and no `href`,
// string or selector in this file spells one. Two other files already commit to the rendered form and
// must agree with this one character for character: `src/middleware.ts` gates `/admin/:path*`, and
// `src/app/robots.ts` disallows `/admin`. `src/components/admin/stat-card.tsx` spells the same four
// management addresses in `ADMIN_STAT_CARDS`, and `src/components/layout/user-menu.tsx` and
// `src/components/layout/mobile-nav.tsx` both spell `/admin` for the entry that leads here.
//
// `src/lib/routes.ts` is the module that owns protected addresses which have to be COMPOSED at a
// call site. These five are static, so per the file's own rule they are declared once - in the table
// below, which this component maps over. A sixth section is added to that table and to the
// middleware's matcher family in the same commit, never to one of them alone.
//
// -------------------------------------------------------------------------------------------------
// WHAT THIS FILE MUST NOT EMIT, BECAUSE THE ROOT LAYOUT ALREADY DOES
//
// `src/app/layout.tsx` owns the document: `<html>` and `<body>`, the stylesheet import, the skip
// link, ThemeProvider -> QueryProvider -> AuthProvider, the `banner` and `contentinfo` landmarks,
// the `<main>` this file renders INSIDE, and the single sonner `<Toaster />`. So there is no
// `<html>`, `<body>`, `<header>`, `<main>` or `<footer>` here, no provider is remounted - a second
// QueryProvider would create a second cache, and the row-action islands' invalidations would then
// stop reaching the grids their pages render - no second Toaster, which would double every
// notification, and no stylesheet import, because `src/app/globals.css` is the only stylesheet in
// the tier. `<main>` supplies neither an inline gutter nor a measure, which is why the shell class
// below supplies both.
//
// No `<h1>` is emitted by the resolved chrome either: each of the five pages owns the single `<h1>`
// for its route. The three notice states are the one exception, and only because they render no
// page at all - see the note on {@link NOTICE_SHELL}.
//
// There is also no `metadata` or `generateMetadata` export: Next.js forbids one from a module
// carrying `'use client'`, and `src/app/robots.ts` keeps this whole group out of every index
// regardless.
//
// -------------------------------------------------------------------------------------------------
// WHY THIS FILE GATES AT ALL, GIVEN THAT src/middleware.ts ALREADY DOES
//
// The middleware runs on the Edge runtime and CANNOT verify the token's signature: the signing key
// is a backend-only value that must never reach this tier. It base64url-decodes the session marker
// unverified, purely to read a role literal, and therefore deliberately admits a marker whose token
// has expired but is still refreshable - and, being unverified, one that has been edited. AAP §0.6.5
// designates it defence in depth ONLY. So this shell resolves the REAL principal through
// `useAuth()`, whose account came from `GET /api/v1/auth/me` behind the bearer credential, and
// answers every state itself.
//
// Neither half is a security boundary. Hiding a control is not authorisation: the authority is
// `require_admin`, applied once at router level on the service's administrative namespace, plus the
// ownership assertions in its post and comment services. A non-administrator who reaches the API
// receives 403 no matter what this shell renders, and narrowing that 403 into a message belongs to
// the five pages - which is why this file performs NO HTTP and imports no `@/lib/api/*` module.
//
// -------------------------------------------------------------------------------------------------
// GOVERNING STANDARDS
//
// `review_rules` reports NO user-specified rules for this project - a complete response, not a
// truncated one - so nothing here is invented to satisfy one, and their absence is not licence to
// lower the bar. The binding constraints are AAP §0.10.1's own enterprise standards and AAP §0.8.5's
// design-system rules, which §0.8.5 makes binding on every file under `frontend/src/`:
//
//   Zero hardcoded values          Every class below resolves to a semantic token declared in
//       `src/app/globals.css` or to a step on the token engine's own scale. No hex value, no `rgb()`,
//       no pixel length, no inline `style`, no bespoke media query, and no primitive colour family -
//       only `globals.css` maps semantic tokens onto primitives.
//   Project primitives             Every control and panel is `Button`, `buttonVariants`, `Card`,
//       `Alert` or `Skeleton` from `@/components/ui/*`. No raw `<button>`, and no `<a>` carrying
//       hand-copied utility classes. Structural elements are plain, which is what the standard
//       permits.
//   One breakpoint vocabulary      `sm` only, from the engine's five. The navigation needs none: it
//       wraps, which is this tier's no-overflow backstop everywhere else too.
//   Accessibility as a floor       One named `<nav>` landmark, `aria-current="page"` carrying the
//       active state rather than colour alone, the live-region role DERIVED from each `Alert`'s
//       variant rather than hand-written, a 2.75rem navigation target from the button primitive's
//       `default` size, and the global `:focus-visible` ring left intact - `outline-none` appears
//       nowhere.
//   Layered separation             No HTTP, no `fetch`, no `@/lib/api/*`, no query state. The only
//       data this file reads is the session, through `useAuth()`.
//   Secure-by-default auth         See the section above: gate for experience, never for security.
//       No token is decoded, parsed, logged or verified here.
//   Config from the environment    This file reads no environment variable, not even a
//       `NEXT_PUBLIC_*` one. `NEXT_PUBLIC_API_BASE_URL` is read lazily by `@/lib/api/client.ts`,
//       this tier's only HTTP module.
//
// -------------------------------------------------------------------------------------------------
// DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT HERE.
//
//   1. `router.replace('/login')` or `router.replace('/')`. `src/middleware.ts` already refuses this
//      group to a visitor with no session marker and to one claiming a non-administrative role, so a
//      redirect here would only fire for the cases the middleware deliberately admits - and firing
//      it from a layout races hydration and destroys the back button. An in-place panel is calmer,
//      linkable and testable.
//   2. Radix `Tabs` for the section navigation. The five sections are five real URLs, each gated by
//      the middleware and each deep-linkable; a tab set would replace them with client-side panel
//      switching, which would defeat both. `@/components/ui/tabs` stays available to the pages for
//      in-page status grouping, which is what it is for.
//   3. An icon beside each entry. `lucide-react` is in the manifest and the sibling workspace shell
//      uses it, but this file's declared package surface is `next` and `react` alone; the five
//      labels are short nouns that carry their own meaning, so a glyph would decorate rather than
//      inform.
//   4. A try/catch around `useAuth()`. It throws only when `AuthProvider` is missing, which is a
//      wiring defect rather than a visitor state; softening it would hide the cause and leave every
//      administrator looking anonymous.
//   5. Anything the five pages own. The aggregate tiles are `@/components/admin/stat-card`, the
//      grids with their own loading, empty and error presentation are `@/components/admin/data-table`,
//      and every mutation, dialog and dropdown belongs to the row-action islands. This file owns the
//      chrome and the gate, and nothing else.
//   6. A `loading.tsx`, `error.tsx`, `not-found.tsx` or `template.tsx` anywhere in this subtree. AAP
//      §0.4.5.2 places those at `src/app/` root, and §0.7.1.9 places the only other `not-found.tsx`
//      at `blog/[slug]/`. The pending and failed-session affordances are the states below.
//   7. `UserMenu`, `ThemeToggle` or a second site header. All three already render above this file,
//      in the root layout's `banner`.

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import type { JSX, ReactNode } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/use-auth';
import type { UserMe, UserRole } from '@/lib/types';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Authority
 * ---------------------------------------------------------------------------------------------- */

/**
 * The one role this group admits.
 *
 * Annotated as `UserRole` rather than left to inference, and compared against as a named constant
 * rather than inlined at the comparison site. The annotation is what makes a typo a BUILD failure:
 * `user.role === 'ADMNI'` type-checks perfectly well as a comparison of two strings and is silently
 * always false, which would lock every administrator out of the dashboard while every gate still
 * "worked". Renaming or removing a role in `@/lib/types` now breaks compilation here instead.
 *
 * `src/middleware.ts` and `src/components/layout/user-menu.tsx` declare the same constant the same
 * way, for the same reason. `UserRole` is a union of string literals rather than an enum precisely
 * so all three can reach it through a type-only import.
 */
const ADMIN_ROLE: UserRole = 'ADMIN';

/* -------------------------------------------------------------------------------------------------
 * Addresses
 *
 * Every one is the RENDERED path - the form the browser, the middleware and the crawl policy all
 * use. See the note at the top of this file on why the directory layout suggests otherwise.
 * ---------------------------------------------------------------------------------------------- */

/** The administrative overview, and the first segment of every address in this group. */
const ADMIN_ROOT_PATH = '/admin';

/** The user management screen. */
const ADMIN_USERS_PATH = '/admin/users';

/** The post management screen, which lists every status rather than only published posts. */
const ADMIN_POSTS_PATH = '/admin/posts';

/** The comment moderation queue. */
const ADMIN_COMMENTS_PATH = '/admin/comments';

/** The category management screen. */
const ADMIN_CATEGORIES_PATH = '/admin/categories';

/** The author workspace: where a signed-in non-administrator is pointed instead. */
const DASHBOARD_PATH = '/dashboard';

/** The public home feed: the escape route every notice state offers. */
const SITE_HOME_PATH = '/';

/** First segment of the sign-in route. Matches `LOGIN_PATH` in `src/middleware.ts`. */
const LOGIN_PATH = '/login';

/**
 * Query parameter carrying the route to come back to.
 *
 * Matches `RETURN_TO_PARAM` in `src/middleware.ts`, which writes the same parameter when it refuses
 * a request outright, and which `src/app/(auth)/login/page.tsx` reads to bounce back. Using a
 * different name here would silently drop the destination for every visitor the middleware let
 * through.
 */
const RETURN_TO_PARAM = 'next';

/* -------------------------------------------------------------------------------------------------
 * Copy
 *
 * Named constants rather than inline strings, so the wording is reviewable in one place and a test
 * can assert on the same value the component renders. Every sentence states a fact and then what to
 * do about it; none of them implies a defect, because none of these states is one.
 * ---------------------------------------------------------------------------------------------- */

/** Accessible name of the `<nav>` landmark, which carries no visible heading of its own. */
const NAV_LABEL = 'Admin sections';

/** Label of the overview entry. */
const OVERVIEW_LABEL = 'Overview';

/** Label of the user management entry. Matches the caption of the matching overview tile. */
const USERS_LABEL = 'Users';

/** Label of the post management entry. Matches the caption of the matching overview tile. */
const POSTS_LABEL = 'Posts';

/** Label of the moderation queue entry. Matches the caption of the matching overview tile. */
const COMMENTS_LABEL = 'Comments';

/** Label of the category management entry. Matches the caption of the matching overview tile. */
const CATEGORIES_LABEL = 'Categories';

/** The escape route offered by all three notice states. */
const HOME_LABEL = 'Back to the blog';

/** Where a signed-in non-administrator is sent instead of here. */
const WORKSPACE_LABEL = 'Go to your workspace';

/** The signed-out state's primary action. */
const SIGN_IN_LABEL = 'Sign in';

/** The unconfirmed-session state's primary action. */
const RETRY_LABEL = 'Try again';

/** Announced once, politely, while the session is still resolving. */
const LOADING_LABEL = 'Loading the admin dashboard';

/**
 * Last-resort identity text.
 *
 * `display_name` is a non-null column and `username` is uniquely constrained, so neither is expected
 * to be blank - but a blank one would leave the sentence it completes reading "You are signed in as
 * ,", and a dangling clause is worse than a generic noun.
 */
const ACCOUNT_FALLBACK_LABEL = 'this account';

/** Heading of the signed-out panel. */
const SIGNED_OUT_HEADING = 'Sign in to reach the admin dashboard';

/** Title of the signed-out panel's notice. */
const SIGNED_OUT_NOTICE_TITLE = 'The admin dashboard is for signed-in administrators';

/** Body of the signed-out panel's notice. */
const SIGNED_OUT_NOTICE_DETAIL =
  'Managing users, posts, comments and categories is limited to administrator accounts, so there ' +
  'is nothing here to show until you sign in. Signing in brings you straight back to this page.';

/** Heading of the not-authorised panel. */
const NOT_AUTHORISED_HEADING = 'This account cannot open the admin dashboard';

/** Title of the not-authorised panel's notice. */
const NOT_AUTHORISED_NOTICE_TITLE = 'Administrative access has not been granted to this account';

/**
 * Body of the not-authorised panel's notice.
 *
 * Deliberately says nothing about a fault. This is a settled answer rather than a failure: the
 * account is signed in, everything it may do it may still do, and the one thing it may not do is
 * named plainly so the reader does not go looking for a bug. The closing sentence exists because a
 * role change does not reach a session already in flight - the account's authority travels in the
 * access token, so a newly promoted administrator has to sign in again to pick it up.
 */
const NOT_AUTHORISED_NOTICE_DETAIL =
  'Managing users, posts, comments and categories is limited to administrator accounts. Nothing is ' +
  'wrong with your account, and your own posts, drafts and comments are unaffected. If you need ' +
  'administrative access, ask an administrator to grant it - then sign out and back in, because the ' +
  'new role reaches this browser with your next sign-in.';

/** Prefix of the identity line in the not-authorised panel. */
const IDENTITY_PREFIX = 'You are signed in as';

/** Heading of the unconfirmed-session panel. */
const SESSION_UNKNOWN_HEADING = 'We could not confirm your session';

/** Title of the unconfirmed-session panel's notice. */
const SESSION_UNKNOWN_NOTICE_TITLE = 'Your sign-in has not been lost';

/**
 * Body of the unconfirmed-session panel's notice.
 *
 * Deliberately does NOT say "signed out" and deliberately does NOT say "not permitted".
 * `src/providers/auth-provider.tsx` is explicit that a null account with a populated `restoreError`
 * means the service could not be ASKED - the credential is intact - so this state knows neither who
 * the reader is nor what they may do. Presenting it as a lost session is what turns a dropped
 * connection into a sign-out nobody asked for; presenting it as a refusal would accuse an
 * administrator of not being one.
 */
const SESSION_UNKNOWN_NOTICE_DETAIL =
  'The service could not be reached just now, so we cannot tell whether this account has ' +
  'administrative access. Nothing has been signed out and nothing has been lost - this is usually ' +
  'a brief network or service problem, and trying again is normally all it takes.';

/* -------------------------------------------------------------------------------------------------
 * Geometry
 *
 * Every value is a step on the token engine's own scale: `--container-*` for the two measures,
 * `--spacing` multiples for the insets, the gaps and the navigation band. The pending branch and the
 * resolved chrome share these constants VERBATIM, and that sharing is the anti-flash guarantee -
 * the placeholder band is exactly as tall as the real one, so nothing shifts when the session
 * resolves. Each string is ordered as prettier-plugin-tailwindcss orders it, so none churns on
 * format.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The dashboard measure and its inset.
 *
 * `max-w-6xl` is the `--container-6xl` token (72rem), the shell cap
 * `src/components/layout/site-header.tsx` and `site-footer.tsx` establish, so the chrome inside
 * lines up with the header above it rather than sitting at its own width. `px-4 sm:px-6` is the
 * shared shell padding and `sm` is the only breakpoint this file uses. `py-8` matches the sibling
 * workspace shell, so moving between the two groups does not move the fold.
 */
const ADMIN_SHELL = 'mx-auto w-full max-w-6xl px-4 py-8 sm:px-6';

/**
 * The vertical stack: the navigation band, then the page.
 *
 * A band above the content rather than a rail beside it, because the four management screens render
 * wide tables and every column a rail took would come out of them. `min-w-0` removes the automatic
 * content-based minimum from this flex container's children; see {@link ADMIN_CONTENT} for what that
 * prevents.
 */
const ADMIN_STACK = 'flex min-w-0 flex-col gap-6';

/**
 * The navigation band.
 *
 * `border-b border-border` is the same decorative hairline `site-header.tsx` draws under the banner
 * and `table.tsx` draws under a header row, which reads the band as chrome rather than as content.
 * `pb-4` sets the space between the links and the rule; the stack's own `gap-6` sets the space
 * between the rule and the page, so the rule sits nearer the thing it belongs to.
 */
const ADMIN_NAV_BAND = 'border-b border-border pb-4';

/**
 * The navigation row.
 *
 * `flex-wrap` is what keeps a 375px viewport free of horizontal scroll, and it is this tier's
 * backstop everywhere the same problem occurs - the footer link list, the pagination row, the tab
 * list and the sibling workspace navigation all use it. Five entries wrap onto two or three rows at
 * 375px and settle onto one from roughly 48rem upward, with no breakpoint variant and therefore no
 * width at which the row is neither wrapped nor complete. `gap-2` spaces them without a margin
 * between siblings.
 */
const ADMIN_NAV_LIST = 'flex flex-wrap gap-2';

/**
 * One navigation entry's list item.
 *
 * `min-w-0` again, so a long label truncates or wraps inside its own box instead of setting a floor
 * on the row's width.
 */
const ADMIN_NAV_ITEM = 'min-w-0';

/**
 * The content region.
 *
 * `min-w-0` is load-bearing rather than defensive: without it a flex item refuses to shrink below
 * its content's intrinsic width, so one wide table, one long slug or one unbroken URL inside a
 * management screen would widen the whole document and produce exactly the horizontal overflow AAP
 * §0.9.4.5 forbids at 375, 768 and 1440 pixels.
 */
const ADMIN_CONTENT = 'min-w-0';

/**
 * The measure the three notice states use, matching `src/app/error.tsx`, `src/app/not-found.tsx` and
 * the sibling workspace shell's own notices.
 *
 * Narrower than the dashboard and with more vertical room, because a notice is a paragraph to read
 * rather than a table to scan. Each of these states renders NO page - `{children}` is withheld - so
 * the panel's heading is the document's only heading, and it is an `h1` for that reason. `<Card>` is
 * left as its default `div` rather than `as="section"`: a titled region is the right element when a
 * page has other regions to distinguish it from, and here it is the entire page.
 */
const NOTICE_SHELL = 'mx-auto w-full max-w-2xl px-4 py-12 sm:px-6';

/**
 * The heading step both the notice panels and the pending placeholder use.
 *
 * `text-2xl` overrides the card primitive's own card-heading step because these are page headings
 * rather than headings inside a feed; both values are `--text-*` tokens.
 */
const NOTICE_HEADING = 'text-2xl';

/* -------------------------------------------------------------------------------------------------
 * The section set
 * ---------------------------------------------------------------------------------------------- */

/** One entry in the administrative navigation. */
interface AdminSectionEntry {
  /**
   * The RENDERED in-app address. Never carries the parenthesised group name - see the note at the
   * top of this file.
   */
  readonly href: string;
  /** Visible text, and therefore also the link's accessible name. */
  readonly label: string;
  /**
   * Width of this entry's placeholder while the session resolves.
   *
   * Carried on the entry rather than written beside the placeholders so the pending band cannot
   * drift from the real one: the pending branch maps the SAME table, so it always draws exactly five
   * boxes and each is about as wide as the link it stands in for. Every value is a `--spacing` step.
   */
  readonly pendingWidth: string;
}

/**
 * The five administrative sections, in the order an administrator moves through them: the overview
 * first, then the four entities AAP R11 names.
 *
 * Module-level and frozen by its type, so the array is created once rather than on every render, and
 * so a test can assert the set without rendering the component. This is the single source of truth
 * for the labels and the addresses; neither is spelled anywhere else in this file.
 */
const ADMIN_SECTIONS: readonly AdminSectionEntry[] = [
  { href: ADMIN_ROOT_PATH, label: OVERVIEW_LABEL, pendingWidth: 'w-28' },
  { href: ADMIN_USERS_PATH, label: USERS_LABEL, pendingWidth: 'w-20' },
  { href: ADMIN_POSTS_PATH, label: POSTS_LABEL, pendingWidth: 'w-20' },
  { href: ADMIN_COMMENTS_PATH, label: COMMENTS_LABEL, pendingWidth: 'w-28' },
  { href: ADMIN_CATEGORIES_PATH, label: CATEGORIES_LABEL, pendingWidth: 'w-32' },
];

/**
 * The navigation target's own height, and therefore its placeholder's.
 *
 * `h-11` is 2.75rem on the `--spacing` scale, which is what the button primitive's `default` size
 * measures - the size the entries below get by naming no size at all, and the size that clears the
 * WCAG 2.5.5 target-size floor. Stated once here so the pending band and the resolved band cannot
 * disagree.
 */
const NAV_TARGET_HEIGHT = 'h-11';

/* -------------------------------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Where a visitor with no session is sent, and how they get back.
 *
 * The `next` parameter is the same contract `src/middleware.ts` writes when it refuses a request
 * outright, so a visitor arrives at the sign-in form with their destination intact whether they were
 * stopped at the edge or here - and the middleware folds the query string into that value, which is
 * why the query is folded in here too. It matters on this group in a way it does not on the sibling
 * workspace: the four management screens hold their page, filter and status selections in the URL,
 * so dropping the query would return a returning administrator to page one of an unfiltered table.
 *
 * `encodeURIComponent` is applied exactly ONCE, over the whole path-and-query string, which is what
 * makes it a single opaque parameter value: without it a `?` or `&` from the returning route would be
 * read as part of the sign-in URL's own query, and applying it twice would deliver `%252F` to a form
 * that decodes once.
 *
 * @param pathname - The route currently on screen, from `usePathname()`.
 * @param query - The serialised query string INCLUDING its leading `?`, or an empty string when the
 * route carries none. See {@link SignedOutNotice} for where that value comes from.
 * @returns A relative sign-in address carrying the return trip. Falls back to the overview when the
 * pathname is empty, so the parameter is never written blank.
 */
function loginHref(pathname: string, query: string): string {
  const returnTo = pathname.length > 0 ? `${pathname}${query}` : ADMIN_ROOT_PATH;

  return `${LOGIN_PATH}?${RETURN_TO_PARAM}=${encodeURIComponent(returnTo)}`;
}

/**
 * Whether a navigation entry addresses the page on screen.
 *
 * The overview and the four management screens are matched by DIFFERENT rules, and the difference is
 * the whole point of this function. `/admin` is the ancestor of every other address in the group, so
 * a shared prefix test would mark the overview current on all five screens - and a
 * `pathname.startsWith('/admin')` test would announce two current pages to a screen reader on every
 * management screen. The overview therefore matches on exact equality alone.
 *
 * Each management screen matches on equality OR on a `/`-delimited prefix, so a future detail route
 * beneath one of them - say `/admin/users/{id}` - still marks its own section rather than none. The
 * separator is part of the test, which is what keeps a hypothetical `/admin/postscript` from being
 * read as a child of `/admin/posts`.
 *
 * @param pathname - The route currently on screen.
 * @param href - The entry's address.
 * @returns `true` when the entry is the current page or, for a management screen, an ancestor of it.
 */
function isSectionActive(pathname: string, href: string): boolean {
  if (href === ADMIN_ROOT_PATH) {
    return pathname === href;
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * What to call the signed-in account in the not-authorised panel.
 *
 * Naming the account is what turns a bare refusal into an explanation: an administrator who is
 * signed into a second, ordinary account sees immediately which one they are using, rather than
 * concluding their own privileges have been revoked. The precedence is the display name, then the
 * handle - the same order `src/components/layout/user-menu.tsx` applies to its initials, so the two
 * never disagree about who is signed in. Both are trimmed before being measured, because a name of
 * spaces reads as blank while being non-empty to `length`.
 *
 * @param user - The signed-in account, narrowed to the two members this needs.
 * @returns A non-empty label, so the sentence it completes cannot be left hanging.
 */
function adminIdentity(user: Pick<UserMe, 'display_name' | 'username'>): string {
  const preferred = user.display_name.trim();

  if (preferred.length > 0) {
    return preferred;
  }

  const handle = user.username.trim();

  return handle.length > 0 ? handle : ACCOUNT_FALLBACK_LABEL;
}

/**
 * Retry the one-time session restoration.
 *
 * A full document load, and it has to be: the restoration runs once, in an effect inside
 * `AuthProvider`, so re-running it means mounting the provider again. A soft navigation to the same
 * path would not remount it, and `refresh()` from the session context is the wrong instrument here -
 * its own contract ends the session locally when no refresh token is held, which is precisely the
 * state a page load leaves behind, so calling it would sign the reader out to fix a network blip.
 *
 * Safe to reference during server rendering: this runs only from a click, by which point the document
 * exists.
 */
function reloadDashboard(): void {
  window.location.reload();
}

/* -------------------------------------------------------------------------------------------------
 * The signed-out state, in its own component
 *
 * WHY THIS IS A SEPARATE COMPONENT AND NOT A BRANCH IN THE LAYOUT BELOW
 *
 * It is the only state that reads the query string, and `useSearchParams()` is the one navigation hook
 * with a consumer requirement attached: `@/components/blog/search-input` and
 * `@/components/blog/category-filter` both record that a STATICALLY prerendered route rendering them
 * must supply a `<Suspense>` boundary, and both hand that requirement to the PAGE, because only a page
 * knows what to show as a fallback. A layout cannot hand it anywhere - it sits above every page that
 * would have to answer it - so a requirement created here would be one the five pages beneath this
 * file could not discharge.
 *
 * Measured on the installed 16.3.0 rather than assumed: a probe page was added at this segment's
 * `/admin` address and built twice. With the hook read at the top of the layout the build succeeded and
 * reported `/admin` as `○` - prerendered as static content - so the version installed here does NOT
 * bail the prerender out, and the requirement those two components record does not in fact arise from a
 * layout on this version. Isolating the hook is therefore a design choice with nothing to gain from
 * reversing it, and not a workaround for a broken build.
 *
 * Two things are gained. First, the hook runs only where its value is CORRECT: a prerender resolves it
 * to an empty set, and `AuthProvider` starts with `isLoading` true - it restores the session in an
 * effect, which cannot have run during a prerender - so the pending branch is the only branch a
 * prerender reaches and this component renders after hydration or not at all. A `next` parameter built
 * here can never carry a query string that was merely unavailable. Second, if a later version of the
 * framework reinstates the strict bail-out, the narrow scope is already in place and no page beneath
 * this layout has to change.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The panel an anonymous visitor sees instead of the dashboard.
 *
 * An ordinary state rather than an error, which is why the notice is `info`: that variant selects a
 * neutral tone AND silence - no live-region role - so the notice is read in document order after the
 * heading instead of being announced over it. This is a call to action a visitor arrives at, not an
 * alert that interrupts them, and it is emphatically not a "not permitted" screen - nobody has been
 * refused anything, because nobody has been identified yet.
 *
 * @returns The signed-out panel, carrying a sign-in link that returns to the current route with its
 * query string intact.
 */
function SignedOutNotice(): JSX.Element {
  const pathname = usePathname();

  // `toString()` serialises WITHOUT the leading '?', so it is prepended here when there is anything
  // to prepend - which is what keeps the value identical in shape to the `${pathname}${search}` the
  // middleware writes, and what keeps `?` out of the value when the route carries no query at all.
  const searchParams = useSearchParams();
  const serialised = searchParams.toString();
  const query = serialised.length > 0 ? `?${serialised}` : '';

  return (
    <div className={NOTICE_SHELL}>
      <Card>
        <CardHeader>
          {/* The document's only heading in this state: `{children}` is withheld, so no page below
              is rendering an `h1` for this route. See {@link NOTICE_SHELL}. */}
          <CardTitle as="h1" className={NOTICE_HEADING}>
            {SIGNED_OUT_HEADING}
          </CardTitle>
        </CardHeader>

        <CardContent>
          <Alert variant="info">
            <AlertTitle>{SIGNED_OUT_NOTICE_TITLE}</AlertTitle>
            <AlertDescription>{SIGNED_OUT_NOTICE_DETAIL}</AlertDescription>
          </Alert>
        </CardContent>

        {/* Already a wrapping row with a token gap, so the two controls stack at narrow widths
            instead of overflowing the card. */}
        <CardFooter>
          {/*
           * The primary action, carrying the return trip so signing in comes back to this screen -
           * with its table page and filters - rather than dropping the visitor on the home feed.
           * `asChild` keeps the element a real anchor: it opens in a new tab, copies as a URL and
           * navigates with no working client bundle.
           */}
          <Button asChild>
            <Link href={loginHref(pathname, query)}>{SIGN_IN_LABEL}</Link>
          </Button>

          <Button asChild variant="secondary">
            <Link href={SITE_HOME_PATH}>{HOME_LABEL}</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Props
 * ---------------------------------------------------------------------------------------------- */

interface AdminLayoutProps {
  /**
   * The page for the matched route: the overview, or one of the four management screens. Rendered
   * ONLY once the principal is known to be an administrator, so those pages may assume an
   * administrative session rather than each re-deriving one - while still relying on the service to
   * be the authority, because this gate is experience and not security.
   */
  readonly children: ReactNode;
}

/* -------------------------------------------------------------------------------------------------
 * The layout
 * ---------------------------------------------------------------------------------------------- */

/**
 * The administrative shell.
 *
 * Renders one of five things, and the order of the tests is the contract:
 *
 * 1. **The session is still resolving** (`isLoading`) - placeholder chrome in the resolved chrome's
 *    exact geometry. Rendering any of the three notices here is the flash this branch exists to
 *    prevent: for one pass on every load it would tell an administrator to sign in, or tell them they
 *    are not an administrator, before anything had been read.
 * 2. **The identity is unknown** (`restoreError`, with no account) - the credential is intact and the
 *    service could not be asked, so this offers a retry rather than a sign-in prompt or a refusal, per
 *    the contract on `AuthContextValue.restoreError`. Tested before the signed-out branch precisely
 *    because both have a `null` account and only this one means "we could not ask".
 * 3. **Nobody is signed in** - an ordinary anonymous state, not an error. See {@link SignedOutNotice}.
 * 4. **Signed in without administrative authority** - a settled answer, stated plainly, with the two
 *    places the account can actually go.
 * 5. **An administrator** - the chrome, and the page inside it.
 *
 * @param children - See {@link AdminLayoutProps.children}.
 * @returns The dashboard, or the state that explains why it is not there.
 * @throws {Error} When rendered outside an `AuthProvider`, propagated from `useAuth()`. That reports a
 * missing provider - a wiring defect - and never a signed-out visitor, which is state 3 above.
 */
export default function AdminLayout({ children }: AdminLayoutProps): JSX.Element {
  // Not wrapped in a try/catch: see @throws above. `AuthProvider` is mounted once for the whole
  // application in src/app/layout.tsx, so every route in this group already has one.
  const { user, isLoading, restoreError } = useAuth();

  // The route on screen, for the active-entry test. Read unconditionally, before any branch returns,
  // because a hook may not be called conditionally - and read HERE because the resolved chrome's
  // active-entry test is what wants it, while the query string is wanted by exactly one notice state
  // and is read there instead; see {@link SignedOutNotice} for the measurement behind that split.
  const pathname = usePathname();

  /* -----------------------------------------------------------------------------------------------
   * 1. The session is still resolving
   *
   * `role="status"` with a name on the WRAPPER, not on the placeholders: `Skeleton` sets its own
   * `aria-hidden`, and its documented pattern is to announce a group once rather than let a screen
   * reader count blocks. Every class here is the resolved chrome's own, and the band is drawn by
   * mapping the SAME section table, so it always holds five entries at their real height and nothing
   * moves when the answer arrives.
   * -------------------------------------------------------------------------------------------- */
  if (isLoading) {
    return (
      <div aria-label={LOADING_LABEL} className={ADMIN_SHELL} role="status">
        <div className={ADMIN_STACK}>
          <div className={ADMIN_NAV_BAND}>
            <div className={ADMIN_NAV_LIST}>
              {ADMIN_SECTIONS.map((section: AdminSectionEntry) => (
                <Skeleton
                  className={cn(NAV_TARGET_HEIGHT, section.pendingWidth)}
                  key={section.href}
                />
              ))}
            </div>
          </div>

          <div className={cn(ADMIN_CONTENT, 'flex flex-col gap-4')}>
            {/* The page heading's band. `h-9` is the line box of the `text-3xl` route-heading step
                the pages use, `w-64` is a phrase rather than a paragraph, and `max-w-full` caps it at
                the narrowest viewport. Not a heading element: the page owns the `h1`. */}
            <Skeleton className="h-9 w-64 max-w-full" />

            {/* One panel: enough to hold the fold without pretending to know whether the page below
                will render a band of tiles or a table. */}
            <Skeleton className="h-40 rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  /* -----------------------------------------------------------------------------------------------
   * 2. The identity is unknown - the service could not be asked
   *
   * `warning` selects both the tone and, inside the primitive, `role="status"` - which is why no ARIA
   * is written here. Polite rather than assertive is the right register: nothing is broken for the
   * reader to fix, and nothing has been lost.
   * -------------------------------------------------------------------------------------------- */
  if (user === null && restoreError !== null) {
    return (
      <div className={NOTICE_SHELL}>
        <Card>
          <CardHeader>
            <CardTitle as="h1" className={NOTICE_HEADING}>
              {SESSION_UNKNOWN_HEADING}
            </CardTitle>
          </CardHeader>

          <CardContent>
            <Alert variant="warning">
              <AlertTitle>{SESSION_UNKNOWN_NOTICE_TITLE}</AlertTitle>
              <AlertDescription>{SESSION_UNKNOWN_NOTICE_DETAIL}</AlertDescription>
            </Alert>
          </CardContent>

          <CardFooter>
            {/* The recovery, and the one control in this file that is a button rather than a link:
                see {@link reloadDashboard} for why a soft navigation would retry nothing. */}
            <Button onClick={reloadDashboard}>{RETRY_LABEL}</Button>

            {/* The escape route. A real anchor, so it survives a broken client bundle. */}
            <Button asChild variant="secondary">
              <Link href={SITE_HOME_PATH}>{HOME_LABEL}</Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  /* -----------------------------------------------------------------------------------------------
   * 3. Nobody is signed in
   * -------------------------------------------------------------------------------------------- */
  if (user === null) {
    return <SignedOutNotice />;
  }

  /* -----------------------------------------------------------------------------------------------
   * 4. Signed in, without administrative authority
   *
   * `destructive` selects both the tone - `--color-danger` on the recessed surface token, never a
   * literal red and never a colour family - and, inside the primitive, `role="alert"`, which is why
   * no ARIA is written here. This is the one state a reader needs told rather than left to notice:
   * they asked for a screen and are being given a different one.
   *
   * Reachable even though `src/middleware.ts` sends a non-administrative marker to the feed, because
   * the marker is unverified and can be stale: an account demoted since its last sign-in still
   * carries `ADMIN` in the cookie the edge reads, while `GET /api/v1/auth/me` - which is what
   * `useAuth()` reflects - reports the truth. This branch is where that difference surfaces.
   * -------------------------------------------------------------------------------------------- */
  if (user.role !== ADMIN_ROLE) {
    return (
      <div className={NOTICE_SHELL}>
        <Card>
          <CardHeader>
            <CardTitle as="h1" className={NOTICE_HEADING}>
              {NOT_AUTHORISED_HEADING}
            </CardTitle>

            {/*
             * Which account is being refused. An administrator signed into a second, ordinary account
             * reads this and switches, instead of concluding their privileges were revoked. The name
             * is the only part in the foreground colour, so the line reads as a label rather than a
             * heading, and the token layer's own `overflow-wrap` floor on `p` wraps a long name
             * instead of widening the card.
             */}
            <p className="text-muted-foreground text-sm">
              {IDENTITY_PREFIX}{' '}
              <span className="text-foreground font-medium">{adminIdentity(user)}</span>
            </p>
          </CardHeader>

          <CardContent>
            <Alert variant="destructive">
              <AlertTitle>{NOT_AUTHORISED_NOTICE_TITLE}</AlertTitle>
              <AlertDescription>{NOT_AUTHORISED_NOTICE_DETAIL}</AlertDescription>
            </Alert>
          </CardContent>

          <CardFooter>
            {/*
             * The workspace first, because it is the one place a signed-in reader of any role can act:
             * `src/middleware.ts` gates `/dashboard` on a session alone, and per-post ownership - not
             * role - decides what can be changed there.
             */}
            <Button asChild>
              <Link href={DASHBOARD_PATH}>{WORKSPACE_LABEL}</Link>
            </Button>

            <Button asChild variant="secondary">
              <Link href={SITE_HOME_PATH}>{HOME_LABEL}</Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  /* -----------------------------------------------------------------------------------------------
   * 5. An administrator - the dashboard itself
   * -------------------------------------------------------------------------------------------- */
  return (
    <div className={ADMIN_SHELL}>
      <div className={ADMIN_STACK}>
        {/*
         * The group's section navigation. `aria-label` gives the landmark its name because there is
         * no visible heading to point at - and there is none deliberately: a heading here would
         * compete with the `h1` each page below owns. A plain `<nav>`, never a tab set: these are
         * five real, gated, deep-linkable URLs.
         */}
        <nav aria-label={NAV_LABEL} className={ADMIN_NAV_BAND}>
          <ul className={ADMIN_NAV_LIST}>
            {ADMIN_SECTIONS.map((section: AdminSectionEntry) => {
              const isCurrent = isSectionActive(pathname, section.href);

              return (
                <li className={ADMIN_NAV_ITEM} key={section.href}>
                  {/*
                   * `buttonVariants` rather than `<Button asChild>`: the primitive exports this table
                   * for precisely this case - a link that looks like a button - and `@/components/ui/
                   * pagination.tsx` styles its page anchors the same way, so the two navigations in an
                   * administrative screen share one class source.
                   *
                   * The current entry differs by BORDER AND GROUND, not by colour alone: `secondary`
                   * draws a border on the raised surface where `ghost` draws nothing. `aria-current`
                   * carries the same fact non-visually, and sits on the anchor because that is the
                   * element in the set of pages. `border border-transparent` on the entries that are
                   * not current - `transparent` being one of the six literals the token rule permits -
                   * gives every box the same border width, so moving between sections re-tints the row
                   * without re-flowing it.
                   */}
                  <Link
                    aria-current={isCurrent ? 'page' : undefined}
                    className={cn(
                      buttonVariants({ variant: isCurrent ? 'secondary' : 'ghost' }),
                      !isCurrent && 'border border-transparent',
                    )}
                    href={section.href}
                  >
                    {section.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className={ADMIN_CONTENT}>{children}</div>
      </div>
    </div>
  );
}
