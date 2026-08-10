'use client';

// The `(dashboard)` group's shell: the author's workspace chrome, and the one place this group
// decides what to render when nobody is signed in.
//
// AAP §0.4.5.2 and §0.7.1.9 (Group 9) list this file as the `layout.tsx` of the `(dashboard)`
// route group, serving R2 - "create, edit, delete, and publish blog posts". Three pages render
// inside it, each owned by another file: the workspace listing, the empty editor and the editor
// for one existing post.
//
// -------------------------------------------------------------------------------------------------
// THE URL CONTRACT, WHICH THE DIRECTORY NAME ACTIVELY MISLEADS ABOUT
//
// `(dashboard)` is parenthesised, so Next.js ERASES it from every URL beneath it. The group
// therefore serves two unrelated URL families rather than one:
//
//   (dashboard)/dashboard/page.tsx        -> /dashboard
//   (dashboard)/posts/new/page.tsx        -> /posts/new          NOT /dashboard/posts/new
//   (dashboard)/posts/[id]/edit/page.tsx  -> /posts/{id}/edit    NOT /dashboard/posts/{id}/edit
//
// `posts` is a SIBLING of `dashboard` inside the group, not a child of it, and `src/middleware.ts`
// is the corroborating evidence: it gates '/dashboard/:path*' and '/posts/:path*' as two separate
// matcher entries. A navigation built from the group name compiles, type-checks, lints and renders;
// it fails only at run time, as a 404 the author reaches immediately after being told their draft
// was saved. The two addresses below are written as literals for that reason - spelled once, next
// to this note. `src/lib/routes.ts` names the same two addresses for call sites that compose them
// dynamically; if either address ever moves, both places change in the same commit.
//
// -------------------------------------------------------------------------------------------------
// WHAT THIS FILE MUST NOT EMIT, BECAUSE THE ROOT LAYOUT ALREADY DOES
//
// `src/app/layout.tsx` owns the document: `<html>` and `<body>`, the stylesheet import, the skip
// link, ThemeProvider -> QueryProvider -> AuthProvider, the `banner` and `contentinfo` landmarks,
// the `<main>` this file renders INSIDE, and the single sonner `<Toaster />`. So there is no
// `<html>`, `<body>`, `<header>`, `<main>` or `<footer>` here, no provider is remounted - a second
// QueryProvider would create a second cache, a second Toaster would double every notification -
// no stylesheet is imported, and no `h1` is emitted, because each page below owns the one `h1` for
// its route. `<main>` supplies neither an inline gutter nor a measure, which is why the shell class
// below supplies both.
//
// There is also no `metadata` or `generateMetadata` export: Next.js forbids one from a module
// carrying `'use client'`, and this group is kept out of every index by `src/app/robots.ts`
// regardless.
//
// -------------------------------------------------------------------------------------------------
// GOVERNING STANDARDS
//
// `review_rules` reports NO user-specified rules for this project, so nothing here is invented to
// satisfy one - and their absence is not licence to lower the bar. The binding constraints are
// AAP §0.10.1's own enterprise standards and AAP §0.8.5's design-system rules:
//
//   Zero hardcoded values          Every class below resolves to a semantic token declared in
//       `src/app/globals.css` or to a step on the token engine's own scale. No hex value, no inline
//       `style`, no bespoke media query, and no primitive colour family - only `globals.css` maps
//       semantic tokens onto primitives.
//   Project primitives             Every control is `Button`, `Card`, `Alert` or `Skeleton` from
//       `@/components/ui/*`. No raw `<button>`. Structural elements are plain, which is what the
//       standard permits.
//   One breakpoint vocabulary      `sm` and `lg` only, both from the engine's five.
//   Accessibility as a floor       One named `<nav>` landmark, `aria-current` carrying the active
//       state rather than colour alone, every decorative glyph `aria-hidden`, and a 2.75rem
//       (44px) navigation target from the button primitive's `default` size.
//   Layered separation             No HTTP. No `fetch`, no `@/lib/api/*`. The only data this file
//       reads is the session, through `useAuth()`.
//   Secure-by-default auth         The gate below is USER EXPERIENCE, never a security boundary.
//       No token is decoded, parsed or verified here; authority is re-decided server-side by the
//       ownership assertions in `backend/app/services/post_service.py`.
//   Config from the environment    This file reads no environment variable, not even a
//       `NEXT_PUBLIC_*` one.
//
// -------------------------------------------------------------------------------------------------
// DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT HERE.
//
//   1. `router.replace('/login')`. `src/middleware.ts` already refuses this group to a visitor with
//      no session marker, so a redirect here would only fire for the cases the middleware
//      deliberately admits - and firing it from a layout races hydration and destroys the back
//      button. An in-place panel is calmer, linkable and testable.
//   2. `useSearchParams()`. The `next` value below carries the PATH alone, which is lossless here:
//      the three routes in this group own no query state, and `src/components/blog/comment-form.tsx`
//      builds its own return trip the same way for the same reason. Leaving the hook out is also
//      deliberate caution - it is the one navigation hook Next.js asks to be wrapped in a Suspense
//      boundary before it is read during prerendering, and a LAYOUT cannot be wrapped by the pages
//      beneath it. Measured on the installed 16.3.0 rather than assumed: adding it neither failed
//      `next build` nor moved /dashboard and /posts/new off static prerendering, so this is a design
//      choice with nothing to gain from reversing it and not a workaround for a broken build.
//   3. A role check. Any signed-in account may author - `AUTHOR` is the role registration grants -
//      and which posts it may actually change is per-post OWNERSHIP, decided by the service. Gating
//      this shell on `user.role` would lock authors out of their own drafts.
//   4. A try/catch around `useAuth()`. It throws only when `AuthProvider` is missing, which is a
//      wiring defect rather than a visitor state; softening it would hide the cause and leave every
//      reader looking anonymous.
//   5. `UserMenu`, `ThemeToggle` or a second site header. All three already render above this file
//      in the root layout's `banner`.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { JSX, ReactNode } from 'react';

import { CloudOff, LayoutDashboard, LockKeyhole, LogIn, RefreshCw, SquarePen } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/use-auth';
import type { UserMe } from '@/lib/types';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Addresses
 *
 * Literals, spelled beside the note at the top of this file that explains why they are NOT what the
 * directory layout suggests. See `src/lib/routes.ts`, which names the same two protected addresses.
 * ---------------------------------------------------------------------------------------------- */

/** The workspace listing: the author's own posts, grouped by lifecycle state. */
const DASHBOARD_PATH = '/dashboard';

/** The empty editor. Note the absent `/dashboard` prefix - the group name is erased. */
const NEW_POST_PATH = '/posts/new';

/** The public home feed: where a visitor who cannot use this group is sent instead. */
const SITE_HOME_PATH = '/';

/** First segment of the sign-in route. Matches `LOGIN_PATH` in `src/middleware.ts`. */
const LOGIN_PATH = '/login';

/**
 * Query parameter carrying the route to come back to.
 *
 * Matches `RETURN_TO_PARAM` in `src/middleware.ts`, which writes the same parameter when it refuses
 * a request outright. `src/app/(auth)/login/page.tsx` reads it and bounces back. Using a different
 * name here would silently drop the destination for every visitor the middleware let through.
 */
const RETURN_TO_PARAM = 'next';

/* -------------------------------------------------------------------------------------------------
 * Copy
 *
 * Named constants rather than inline strings, so the wording is reviewable in one place and a test
 * can assert on the same value the component renders.
 * ---------------------------------------------------------------------------------------------- */

/** Accessible name of the `<nav>` landmark, which carries no visible heading of its own. */
const NAV_LABEL = 'Workspace';

/** Label of the workspace listing entry. */
const DASHBOARD_LABEL = 'Your posts';

/** Label of the new-post entry. */
const NEW_POST_LABEL = 'New post';

/** The escape route offered by both notice states. */
const HOME_LABEL = 'Back to the blog';

/** The signed-out state's primary action. */
const SIGN_IN_LABEL = 'Sign in';

/** The unconfirmed-session state's primary action. */
const RETRY_LABEL = 'Try again';

/** Announced once, politely, while the session is still resolving. */
const LOADING_LABEL = 'Loading your workspace';

/** Prefix of the unobtrusive identity line above the navigation. */
const IDENTITY_PREFIX = 'Signed in as';

/**
 * Last-resort identity text.
 *
 * `display_name` is a non-null string and `username` is uniquely constrained, so neither is
 * expected to be blank - but a blank one would leave "Signed in as" hanging mid-sentence, and a
 * dangling label is worse than a generic one.
 */
const ACCOUNT_FALLBACK_LABEL = 'this account';

/** Heading of the signed-out panel. An `h2`: the pages below own their route's `h1`. */
const SIGNED_OUT_HEADING = 'Sign in to reach your workspace';

/** Title of the signed-out panel's notice. */
const SIGNED_OUT_NOTICE_TITLE = 'This workspace belongs to a signed-in author';

/** Body of the signed-out panel's notice. States the fact, then what to do about it. */
const SIGNED_OUT_NOTICE_DETAIL =
  'Drafts, published posts and the editor are all tied to an account, so there is nothing here to ' +
  'show until you sign in. Signing in brings you straight back to this page, and anything you had ' +
  'already published is still on the blog.';

/** Heading of the unconfirmed-session panel. */
const SESSION_UNKNOWN_HEADING = 'We could not confirm your session';

/** Title of the unconfirmed-session panel's notice. */
const SESSION_UNKNOWN_NOTICE_TITLE = 'Your sign-in has not been lost';

/**
 * Body of the unconfirmed-session panel's notice.
 *
 * Deliberately does NOT say "signed out". `src/providers/auth-provider.tsx` is explicit that a null
 * account with a populated `restoreError` means the service could not be ASKED - the credential is
 * intact - so presenting it as a lost session is what turns a dropped connection into a sign-out
 * the reader never asked for.
 */
const SESSION_UNKNOWN_NOTICE_DETAIL =
  'Your workspace could not be reached just now, so we cannot tell which posts are yours. Nothing ' +
  'has been signed out and nothing has been lost - this is usually a brief network or service ' +
  'problem, and trying again is normally all it takes.';

/* -------------------------------------------------------------------------------------------------
 * Geometry
 *
 * Every value is a step on the token engine's own scale: `--container-*` for the two measures,
 * `--spacing` multiples for the inset, the gaps and the rail. The loading branch and the resolved
 * chrome share these four constants VERBATIM, and that sharing is the anti-flash guarantee: the
 * placeholder rail is exactly as wide as the real one, so nothing shifts when the session resolves.
 * ---------------------------------------------------------------------------------------------- */

/** The workspace measure and its inset, stepping up once at `sm`, matching the site header. */
const WORKSPACE_SHELL = 'mx-auto w-full max-w-6xl px-4 py-8 sm:px-6';

/** Stacked below `lg`, rail-beside-content from `lg`. The only two breakpoints this file uses. */
const WORKSPACE_COLUMNS = 'flex min-w-0 flex-col gap-8 lg:flex-row lg:gap-10';

/** The rail: full width while stacked, a fixed 14rem column once it sits beside the content. */
const WORKSPACE_RAIL = 'flex min-w-0 flex-col gap-4 lg:w-56 lg:shrink-0';

/**
 * The navigation row, which becomes a column at `lg`.
 *
 * `flex-wrap` is what keeps a 375px viewport free of horizontal scroll: two entries fit side by
 * side, and if either label ever grows the second one wraps instead of pushing the document wider.
 */
const WORKSPACE_NAV_LIST = 'flex flex-wrap gap-2 lg:flex-col';

/**
 * The content region.
 *
 * `min-w-0` is load-bearing rather than defensive: without it a flex item refuses to shrink below
 * its content's intrinsic width, so one long unbroken word inside a page - a slug, a URL, a code
 * span in a preview - would widen the whole document and produce exactly the horizontal overflow
 * the responsive criteria forbid at 375, 768 and 1440 pixels.
 */
const WORKSPACE_CONTENT = 'min-w-0 flex-1';

/** The measure both notice states use, matching `src/app/error.tsx` and `src/app/not-found.tsx`. */
const NOTICE_SHELL = 'mx-auto w-full max-w-2xl px-4 py-12 sm:px-6';

/* -------------------------------------------------------------------------------------------------
 * The navigation set
 * ---------------------------------------------------------------------------------------------- */

/** One entry in the workspace navigation. */
interface WorkspaceNavEntry {
  /** In-app address. A literal from the block above, never composed from the group name. */
  readonly href: string;
  /** Visible text, and therefore also the link's accessible name. */
  readonly label: string;
  /**
   * The leading glyph, hidden from assistive technology.
   *
   * Decorative in the strict sense: the label beside it already carries the meaning, so an
   * announced icon would only repeat it. Sizing comes from the button primitive's own
   * `[&_svg]:size-4` rule, so no dimension is written here.
   */
  readonly icon: ReactNode;
}

/**
 * The two sections of the workspace, in the order an author moves through them.
 *
 * Module-level and frozen by its type, so the elements are created once rather than on every
 * render, and so a test can assert the set without rendering the component.
 */
const WORKSPACE_NAV_ENTRIES: readonly WorkspaceNavEntry[] = [
  {
    href: DASHBOARD_PATH,
    label: DASHBOARD_LABEL,
    icon: <LayoutDashboard aria-hidden="true" />,
  },
  {
    href: NEW_POST_PATH,
    label: NEW_POST_LABEL,
    icon: <SquarePen aria-hidden="true" />,
  },
];

/* -------------------------------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Where a visitor with no session is sent, and how they get back.
 *
 * The `next` parameter is the same contract `src/middleware.ts` writes when it refuses a request
 * outright, so a visitor arrives at the sign-in form with their destination intact whether they were
 * stopped at the edge or here. `encodeURIComponent` is what makes the path a single opaque parameter
 * value: without it a path's own separators would be read as part of the sign-in URL's query.
 *
 * @param pathname - The route currently on screen, from `usePathname()`.
 * @returns A relative sign-in address carrying the return trip. Falls back to the home feed when the
 * pathname is empty, so the parameter is never written blank.
 */
function loginHref(pathname: string): string {
  const returnTo = pathname.length > 0 ? pathname : SITE_HOME_PATH;

  return `${LOGIN_PATH}?${RETURN_TO_PARAM}=${encodeURIComponent(returnTo)}`;
}

/**
 * Whether a navigation entry addresses the page on screen.
 *
 * Exact match, plus a descendant test. The descendant test is not speculative padding: it is what
 * keeps the indicator correct if a sub-route is ever added beneath either address, and it is written
 * with the separator appended so `/posts/newsletter` cannot be mistaken for a child of `/posts/new`.
 * The editor for an existing post - `/posts/{id}/edit` - deliberately matches NEITHER entry, because
 * it is a third page rather than one of these two, and claiming otherwise would announce the wrong
 * link as current.
 *
 * @param pathname - The route currently on screen.
 * @param href - The entry's address.
 * @returns `true` when the entry is the current page or an ancestor of it.
 */
function isCurrentSection(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * What to call the signed-in author.
 *
 * Prefers the display name and falls back to the handle, the same precedence
 * `src/components/layout/user-menu.tsx` applies to its initials, so the two never disagree about who
 * is signed in. Both are trimmed before being measured, because a name of spaces is blank to a
 * reader while being non-empty to `length`.
 *
 * @param user - The signed-in account, narrowed to the two members this needs.
 * @returns A non-empty label. Never returns an empty string, so the sentence it completes cannot be
 * left hanging.
 */
function workspaceIdentity(user: Pick<UserMe, 'display_name' | 'username'>): string {
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
 * Safe to reference during server rendering: this runs only from a click, by which point the
 * document exists.
 */
function reloadWorkspace(): void {
  window.location.reload();
}

/* -------------------------------------------------------------------------------------------------
 * Props
 * ---------------------------------------------------------------------------------------------- */

interface DashboardLayoutProps {
  /**
   * The page for the matched route: the workspace listing, the new-post editor, or the editor for
   * one existing post. Rendered ONLY once a principal is known, so those pages may assume a session
   * rather than each re-deriving one.
   */
  readonly children: ReactNode;
}

/* -------------------------------------------------------------------------------------------------
 * The layout
 * ---------------------------------------------------------------------------------------------- */

/**
 * The author workspace shell.
 *
 * Renders one of four things, and the order of the tests is the contract:
 *
 * 1. **The session is still resolving** (`isLoading`) - placeholder chrome in the resolved chrome's
 *    exact geometry. Rendering the signed-out panel here is the flash this branch exists to prevent:
 *    it would offer "Sign in" to a reader who is in fact signed in, for one pass on every load.
 * 2. **A principal is known** - the chrome, and the page inside it. Tested before either failure
 *    branch so a usable session is never hidden behind an explanation.
 * 3. **The identity is unknown** (`restoreError`) - the credential is intact and the service could
 *    not be asked, so this offers a retry rather than a sign-in prompt, per the contract on
 *    `AuthContextValue.restoreError`.
 * 4. **Nobody is signed in** - an ordinary anonymous state, not an error, answered with a panel and
 *    a return trip.
 *
 * @param children - See {@link DashboardLayoutProps.children}.
 * @returns The workspace, or the state that explains why it is not there.
 * @throws {Error} When rendered outside an `AuthProvider`, propagated from `useAuth()`. That reports
 * a missing provider - a wiring defect - and never a signed-out visitor, which is state 4 above.
 */
export default function DashboardLayout({ children }: DashboardLayoutProps): JSX.Element {
  // Not wrapped in a try/catch: see @throws above. `AuthProvider` is mounted once for the whole
  // application in src/app/layout.tsx, so every route in this group already has one.
  const { user, isLoading, restoreError } = useAuth();

  // The route on screen. Read unconditionally, before any branch returns, because a hook may not be
  // called conditionally - and it is used by two of the four branches.
  const pathname = usePathname();

  /* -----------------------------------------------------------------------------------------------
   * 1. The session is still resolving
   *
   * `role="status"` with a name on the WRAPPER, not on the placeholders: `Skeleton` sets its own
   * `aria-hidden`, and its documented pattern is to announce a group once rather than let a screen
   * reader count blocks. The four class constants are the resolved chrome's own, so the rail is
   * already its final width and nothing moves when the answer arrives.
   * -------------------------------------------------------------------------------------------- */
  if (isLoading) {
    return (
      <div aria-label={LOADING_LABEL} className={WORKSPACE_SHELL} role="status">
        <div className={WORKSPACE_COLUMNS}>
          <div className={WORKSPACE_RAIL}>
            {/* The identity line. `h-4` is the primitive's default, so only the width is stated. */}
            <Skeleton className="w-40" />

            <div className={WORKSPACE_NAV_LIST}>
              {/* `h-11` is the navigation target's own height, from the button primitive's
                  `default` size, so these two blocks stand exactly where the links will. */}
              <Skeleton className="h-11 w-36 lg:w-full" />
              <Skeleton className="h-11 w-32 lg:w-full" />
            </div>
          </div>

          <div className={cn(WORKSPACE_CONTENT, 'flex flex-col gap-4')}>
            {/* A heading line and one panel: enough to hold the fold without pretending to know
                what the page below will render. */}
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-40 rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  /* -----------------------------------------------------------------------------------------------
   * 2. A principal is known - the workspace itself
   * -------------------------------------------------------------------------------------------- */
  if (user !== null) {
    return (
      <div className={WORKSPACE_SHELL}>
        <div className={WORKSPACE_COLUMNS}>
          {/*
           * A plain `div` rather than `<aside>`: the navigation inside is already a named landmark,
           * and a complementary landmark with no accessible name would add a second, unnamed entry
           * to a screen reader's landmark list for no gain.
           */}
          <div className={WORKSPACE_RAIL}>
            {/*
             * Who is signed in, stated once and quietly. `truncate` needs the rail's `min-w-0` to
             * have something to truncate against, which it has; the name is the only part rendered
             * in the foreground colour, so the sentence reads as a label rather than a heading.
             */}
            <p className="text-muted-foreground truncate text-sm">
              {IDENTITY_PREFIX}{' '}
              <span className="text-foreground font-medium">{workspaceIdentity(user)}</span>
            </p>

            {/*
             * The group's section navigation. `aria-label` gives the landmark its name because there
             * is no visible heading to point at - and there is none deliberately: a heading here
             * would compete with the `h1` each page below owns.
             */}
            <nav aria-label={NAV_LABEL}>
              <ul className={WORKSPACE_NAV_LIST}>
                {WORKSPACE_NAV_ENTRIES.map((entry: WorkspaceNavEntry) => {
                  const isCurrent = isCurrentSection(pathname, entry.href);

                  return (
                    <li className="min-w-0" key={entry.href}>
                      {/*
                       * `asChild` so the one button implementation is reused while the element stays
                       * a real anchor - it opens in a new tab, copies as a URL and navigates with no
                       * working client bundle.
                       *
                       * The active entry differs by BORDER AND GROUND, not by colour alone:
                       * `secondary` draws a border on the raised surface where `ghost` draws
                       * nothing. `aria-current` carries the same fact non-visually, and sits on the
                       * anchor because that is the element in the set of pages.
                       */}
                      <Button
                        asChild
                        className="lg:w-full lg:justify-start"
                        variant={isCurrent ? 'secondary' : 'ghost'}
                      >
                        <Link aria-current={isCurrent ? 'page' : undefined} href={entry.href}>
                          {entry.icon}
                          {entry.label}
                        </Link>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </div>

          <div className={WORKSPACE_CONTENT}>{children}</div>
        </div>
      </div>
    );
  }

  /* -----------------------------------------------------------------------------------------------
   * 3. The identity is unknown - the service could not be asked
   *
   * `warning` selects both the tone and, inside the primitive, `role="status"` - which is why no
   * ARIA is written here. Polite rather than assertive is the right register: nothing is broken for
   * the reader to fix, and nothing has been lost.
   * -------------------------------------------------------------------------------------------- */
  if (restoreError !== null) {
    return (
      <div className={NOTICE_SHELL}>
        <Card as="section">
          <CardHeader>
            {/* `h2`, never `h1`: the pages in this group own their route's single `h1`, and this
                panel stands in for one of them rather than replacing the page it belongs to.
                `text-2xl` overrides the primitive's card-heading step; both are --text-* tokens. */}
            <CardTitle as="h2" className="text-2xl">
              {SESSION_UNKNOWN_HEADING}
            </CardTitle>
          </CardHeader>

          <CardContent>
            <Alert variant="warning">
              {/* First child, as the primitive's leading-icon slot requires, and hidden because the
                  title and description already carry the meaning. */}
              <CloudOff aria-hidden="true" />
              <AlertTitle>{SESSION_UNKNOWN_NOTICE_TITLE}</AlertTitle>
              <AlertDescription>{SESSION_UNKNOWN_NOTICE_DETAIL}</AlertDescription>
            </Alert>
          </CardContent>

          {/* Already a wrapping row with a token gap, so the two controls stack at narrow widths
              instead of overflowing the card. */}
          <CardFooter>
            {/* The recovery, and the reason this branch needs a button rather than a link: see
                {@link reloadWorkspace} for why a soft navigation would not retry anything. */}
            <Button onClick={reloadWorkspace}>
              <RefreshCw aria-hidden="true" />
              {RETRY_LABEL}
            </Button>

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
   * 4. Nobody is signed in
   *
   * An ordinary anonymous state rather than an error, so `info` is the variant: it selects a neutral
   * tone AND silence - no live-region role - and the notice is read in document order after the
   * heading instead of being announced over it. This is a call to action a visitor arrives at, not
   * an alert that interrupts them, and it is emphatically not a "not permitted" screen: authority
   * lives on the service, and this panel only explains why there is nothing to show.
   * -------------------------------------------------------------------------------------------- */
  return (
    <div className={NOTICE_SHELL}>
      <Card as="section">
        <CardHeader>
          <CardTitle as="h2" className="text-2xl">
            {SIGNED_OUT_HEADING}
          </CardTitle>
        </CardHeader>

        <CardContent>
          <Alert variant="info">
            <LockKeyhole aria-hidden="true" />
            <AlertTitle>{SIGNED_OUT_NOTICE_TITLE}</AlertTitle>
            <AlertDescription>{SIGNED_OUT_NOTICE_DETAIL}</AlertDescription>
          </Alert>
        </CardContent>

        <CardFooter>
          {/* The primary action, carrying the return trip so signing in comes back here rather than
              dropping the visitor on the home feed. */}
          <Button asChild>
            <Link href={loginHref(pathname)}>
              <LogIn aria-hidden="true" />
              {SIGN_IN_LABEL}
            </Link>
          </Button>

          <Button asChild variant="secondary">
            <Link href={SITE_HOME_PATH}>{HOME_LABEL}</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
