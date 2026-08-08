// SiteFooter - the footer landmark of the application shell.
//
// src/app/layout.tsx mounts this ONCE, as a sibling of <main>, so it renders on every route in the
// product: the home feed, every post, every author profile, both authentication screens, the author
// workspace and all five administrative screens. That single fact drives almost every decision
// below, and most of them are decisions to leave something OUT - a cost paid here is paid on every
// page a reader will ever load.
//
// Its responsibility is precisely two things: the `contentinfo` landmark, and attribution. Secondary
// navigation is the whole of the rest.
//
// -----------------------------------------------------------------------------------------------
// 1. WHY THERE IS NO `'use client'` DIRECTIVE - THE LOAD-BEARING DECISION IN THIS FILE
//
// The footer holds no state, runs no effect, binds no event handler and touches no browser API, so
// it is a Server Component and must stay one. The directive would not merely be redundant, it would
// be actively harmful: a client boundary is inherited by every component beneath it, so marking the
// footer would ship its markup, its class strings and React's client runtime into the bundle of
// EVERY route - to paint one line of text and three links that never change after first paint. The
// plan's rule is that a page must not become a client bundle merely because something on it is
// interactive; a component mounted on all of them is the last place to break that rule.
//
// Every temptation toward the directive has been resolved by putting the feature somewhere else:
//
//   * A session-aware link - "Dashboard" when signed in, "Log out" instead of "Log in" - would need
//     useAuth(), hence the directive. Session and role affordances belong to
//     src/components/layout/user-menu.tsx and mobile-nav.tsx, which are client islands because they
//     genuinely have to be. Rendering them here would also be a correctness bug, not just a
//     performance one: the footer is server-rendered into a cacheable shell, so a signed-in link
//     baked into it could be served to a different visitor.
//   * A ticking copyright year would need an effect. It does not need one; see section 4.
//   * A newsletter form, a social-follow row, an analytics beacon, a cookie-consent notice and a
//     language switcher would each need client code. All five are explicitly out of scope, so none
//     of them can drag a directive in through the side door. Do not add them.
//
// The observable proof is the build report: adding this file must not raise the First Load JS of any
// route. If it does, something in it became a client island.
//
// -----------------------------------------------------------------------------------------------
// 2. WHY THERE ARE THREE LINKS, AND WHY NOT THE OBVIOUS OTHERS
//
// A footer is where invented routes accumulate, and the failure is silent in a way that matters
// here: Next.js resolves <Link href> at run time, so a link to a page that does not exist compiles,
// type-checks, lints and renders perfectly - and then 404s for a reader, on every page of the site,
// while the sitemap keeps advertising the site as healthy. There is no build error to catch it.
//
// So the inventory below is closed against the routes this application actually serves: `/`,
// `/blog/{slug}`, `/u/{username}`, `/login`, `/signup`, the protected `/dashboard`, `/posts` and
// `/admin` families, and the generated `/sitemap.xml` and `/robots.txt`. Of those, only three are
// both public and addressable without a slug - and they are exactly the three below.
//
// Deliberately absent, and none of them is an oversight:
//
//   * `/about`, `/contact`, `/privacy`, `/terms` - no such page exists anywhere in the product.
//     These are the four a footer acquires by habit, and every one would be a dead link.
//   * `/categories`, `/tags` - a category has no route of its own. Its page IS the
//     category-filtered feed, which is why @/lib/seo exposes `categoryFeedPath` (a `/?category=`
//     URL) and no `/categories/{slug}` builder. Filtering belongs to the feed's own controls, not
//     to a link that would need a slug this component has no way to obtain.
//   * `/dashboard`, `/admin` - real routes, but protected by src/middleware.ts and by a
//     server-side role check. Advertising them to every anonymous visitor invites a redirect, and
//     hiding them conditionally would need the session, hence the directive. src/app/robots.ts
//     disallows both for the same reason.
//   * `/sitemap.xml`, `/robots.txt` - real, but they are crawler artefacts rather than pages. A
//     reader who follows one lands on raw XML.
//
// -----------------------------------------------------------------------------------------------
// 3. WHERE THE SITE NAME COMES FROM
//
// `resolveSiteName()` from @/lib/seo, and nowhere else. That module is one of only two in this tier
// permitted to read the environment, and it owns NEXT_PUBLIC_SITE_NAME outright. Writing
// `process.env.NEXT_PUBLIC_SITE_NAME` here would be a second reader of one value, and the two would
// disagree the moment either grew a rule - the resolver already normalises whitespace and rejects a
// blank. Hard-coding the name as a string literal would be worse still: the footer would brand every
// page with a value that silently disagrees with the <title> template and every social card.
//
// It is called in the render body, NOT at module scope, and that placement is deliberate. The
// resolver THROWS when the variable is absent rather than substituting a placeholder, because a
// placeholder would be published to readers. A module-scope call would move that throw into module
// evaluation, so a missing variable would surface as an unrelated import failure in whatever
// imported the footer first. Called here, it fails where it is used, with the resolver's own message
// naming the variable and pointing at .env.example. There is no try/catch and no fallback string for
// the same reason: a misconfigured deployment must fail loudly, and it already does - layout.tsx's
// `buildRootMetadata()` calls the same resolver, so this component introduces no new failure mode.
//
// -----------------------------------------------------------------------------------------------
// 4. THE COPYRIGHT YEAR, AND WHY IT IS NOT A BUG
//
// `new Date().getFullYear()` evaluates on the server. A Server Component's output is not re-rendered
// on the client, so there is no second evaluation to disagree with the first and no hydration
// mismatch - the trap that makes the same expression a real defect inside a Client Component.
//
// Under static prerendering the value is captured at build time, so a site built in December and
// still running in January shows the previous year until it is rebuilt. That is accepted, not
// overlooked. The alternatives are all worse: an effect or `useState` would make the footer a client
// island on every route (section 1) to correct a single digit; `export const dynamic = 'force-
// dynamic'` would opt every page out of static rendering; and a `revalidate` hint would add a
// re-render schedule to the whole shell. A yearly redeploy is the proportionate answer.
//
// -----------------------------------------------------------------------------------------------
// 5. TOKENS, RESPONSIVENESS AND ACCESSIBILITY
//
// Every colour resolves to a semantic token declared in src/app/globals.css, and two of them name
// this component in their own documentation: `--color-border` is the hairline used for "footer
// dividers" and `--color-muted-foreground` is the secondary text used for "footer copy", already
// verified to clear the 4.5:1 body-text threshold. Because each token is declared once at the
// document root and again under `.dark`, this file carries NO `dark:` class - a `dark:` colour here
// would be a second source of truth for a decision globals.css has already made.
//
// There is no literal colour, dimension, radius, font size or shadow, and no square-bracket
// arbitrary value: `max-w-6xl` is the `--container-6xl` token, the paddings and the gap come from
// the `--spacing` scale, and `sm:` is one of the engine's five catalogued breakpoints. No custom
// media query is authored - `motion-safe:` is the engine's own
// `prefers-reduced-motion: no-preference` gate and Tailwind 4 already compiles `hover:` behind
// `@media (hover: hover)`, so the hover affordance cannot stick on a touch device.
//
// Accessibility, in the order it is expressed below:
//
//   * A real <footer>. Mounted as a sibling of <main> it maps to the `contentinfo` landmark, which
//     is what lets a screen-reader user jump to it directly. That mapping is lost if it is nested
//     inside <main>, <article>, <aside>, <nav> or <section>, so layout.tsx must keep it a sibling.
//   * <nav aria-label="Footer">, so this navigation landmark is distinguishable from the header's in
//     a landmark list. A page with two unnamed <nav> elements gives a screen-reader user two
//     identical entries and no way to tell which is which.
//   * A <ul>, because three links are a list; the count is announced, and no divider is drawn
//     between items so there is no `:last-child` case to get wrong.
//   * Descriptive text as each link's accessible name. "Home", "Log in" and "Sign up" each make
//     sense read out of context, which is how assistive technology enumerates links.
//   * No heading of any level. The single <h1> belongs to the page, and a footer heading would
//     either duplicate it or open an out-of-order level in the document outline.
//   * The keyboard focus indicator is NOT restated here. globals.css declares the global floor
//     `:focus-visible { outline: 2px solid var(--app-ring); outline-offset: 2px }`, which is
//     byte-identical to what `focus-visible:outline-2 focus-visible:outline-offset-2
//     focus-visible:outline-ring` would emit. The UI primitives restate it because each must be
//     self-sufficient wherever it is composed; this is a leaf component on a known canvas, so
//     repeating it would only create a second place to change the ring. `rounded-sm` is here so the
//     offset outline traces a tidy shape rather than a bare text box.
//
// -----------------------------------------------------------------------------------------------
// 6. DELIBERATELY ABSENT. DO NOT ADD.
//
//   * Any data fetch, and any import from an `@/lib/api` module. This component renders on every
//     route, so one request here is one request added to every page render, for content it does not
//     need - and its own client (`@/lib/api/client`) is the tier's only permitted HTTP module anyway.
//     The component suite additionally runs request interception with `onUnhandledRequest: 'error'`,
//     so a stray fetch fails the gate outright.
//   * Any React hook. A hook forces the directive; see section 1.
//   * `import React from 'react'`. tsconfig.json sets `"jsx": "react-jsx"`, so the automatic runtime
//     applies and the import would be an unused binding that `--max-warnings=0` turns into a failure.
//   * A raw <a> for an internal route. `@next/next/no-html-link-for-pages` fails the lint gate on
//     one, and it would trigger a full document navigation instead of a client transition.
//   * A raw <button>, <input>, <select>, <textarea> or <table>. A footer needs none; if an
//     interactive control is ever wanted here the answer is @/components/ui/button.
//   * A social-media row, newsletter form, analytics beacon, consent notice or language switcher.
//   * A default export. Every sibling in this folder exports by name.
import Link from 'next/link';
import type { JSX } from 'react';

import { feedPath, resolveSiteName } from '@/lib/seo';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Route inventory
 * ---------------------------------------------------------------------------------------------- */

/**
 * The sign-in screen, served by `src/app/(auth)/login/page.tsx`.
 *
 * A route group's parentheses never appear in a URL, so the rendered path is `/login` - never
 * `/(auth)/login` - and `src/middleware.ts` matches the rendered form.
 *
 * This is a path constant rather than a call into `@/lib/seo` because that module deliberately
 * publishes no builder for the authentication screens: it owns the public CONTENT url families
 * (post, profile, feed, category), and neither credential screen belongs in a sitemap or a canonical
 * link. A route path is also not what the zero-hardcoded-values rule governs - that rule closes the
 * set of PRESENTATION values (colour, dimension, radius, font size, shadow), each of which must
 * resolve to a token.
 */
const LOGIN_PATH = '/login';

/** The registration screen, served by `src/app/(auth)/signup/page.tsx`. See {@link LOGIN_PATH}. */
const SIGNUP_PATH = '/signup';

/** One entry in the footer's navigation list. */
interface FooterLink {
  /** Rendered, root-relative href. Must name a route this application actually serves. */
  readonly href: string;
  /**
   * Visible text, which is also the link's accessible name. Descriptive standing alone, because
   * assistive technology enumerates a page's links with none of the surrounding prose.
   */
  readonly label: string;
}

/**
 * The footer's entire link inventory. Three entries, and the smallness is the point - see section 2
 * of the header for what is excluded and why.
 *
 * `feedPath()` rather than a bare `'/'`: @/lib/seo owns how the feed is addressed, and calling it
 * keeps this component from becoming a second place that decides. With no arguments it returns the
 * canonical unfiltered first page, and it is safe at module scope precisely because it reads no
 * environment variable and therefore cannot throw - unlike `resolveSiteName()`, which is called in
 * the render body for exactly that reason (header section 3).
 *
 * Frozen, because a shared inventory a consumer could mutate at run time is not an inventory.
 */
const FOOTER_LINKS: readonly FooterLink[] = Object.freeze([
  { href: feedPath(), label: 'Home' },
  { href: LOGIN_PATH, label: 'Log in' },
  { href: SIGNUP_PATH, label: 'Sign up' },
]);

/* -------------------------------------------------------------------------------------------------
 * Presentation
 *
 * Class strings live in named constants so each can carry the reason it exists, and so the root's
 * set can be handed to `cn()` for the caller to override predictably.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The footer's own chrome: the hairline above it and the canvas it paints.
 *
 * `border-t border-border` is the decorative rule `--color-border` documents itself for. The token
 * is named explicitly even though globals.css already defaults `border-color` on every element, so
 * the intent is legible at the call site and survives a change to that default.
 *
 * `bg-background` rather than `bg-surface`: the footer is page chrome, not a raised panel, and
 * `--color-surface` is reserved for genuinely raised things (cards, dialog panels, dropdown content)
 * so that "raised" keeps meaning something. It repeats the canvas `body` already paints, which makes
 * the component self-sufficient if layout.tsx ever seats it on a different ground.
 */
const FOOTER_BASE = 'border-t border-border bg-background';

/**
 * The shell measure, and a contract with `site-header.tsx`.
 *
 * `max-w-6xl` is the `--container-6xl` token (72rem). It is wide enough for the three-column feed
 * the home page reaches at the `lg` breakpoint, which is what makes the footer's content line up
 * with the content above it instead of ending somewhere arbitrary. `mx-auto` centres the shell while
 * the <footer> itself spans the viewport, so the hairline and the canvas run the full width at every
 * size - and `w-full` keeps the shell filling that space below the cap rather than shrinking to its
 * text.
 *
 * `px-4 sm:px-6` is the shell padding used by src/app/error.tsx, so every full-width surface in the
 * tier insets its content identically. The header must adopt the same cap and the same padding; two
 * different measures would misalign visibly at any width above the cap.
 */
const FOOTER_SHELL = 'mx-auto w-full max-w-6xl px-4 py-8 sm:px-6';

/**
 * Mobile-first arrangement: stacked below `sm` (40rem), one spread row from `sm` up.
 *
 * `sm` rather than `md` because there are only two children and both are short - a row fits well
 * before 48rem, and holding the stack longer would leave an obviously empty band on a small tablet.
 * DOM order and visual order agree at every width; nothing reorders, so what a keyboard or screen
 * reader traverses is what a sighted reader sees.
 */
const FOOTER_ROW = 'flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between';

/**
 * The attribution line. `text-muted-foreground` is the secondary-text token whose own documentation
 * names "footer copy", and it clears 4.5:1 in both themes, so this is genuinely secondary rather
 * than merely faint.
 *
 * `min-w-0` is load-bearing at narrow widths: a flex child defaults to `min-width: auto`, which
 * refuses to shrink below its content and is the usual cause of horizontal overflow. With this,
 * plus the `overflow-wrap: break-word` globals.css applies to every <p>, a long site name wraps
 * instead of widening the page - and no width at any viewport may overflow.
 */
const FOOTER_ATTRIBUTION = 'min-w-0 text-sm text-muted-foreground';

/**
 * The link list. `flex-wrap` with a two-axis gap lets the links fall onto a second line on a narrow
 * phone rather than pushing the layout wider; the row gap keeps them legible when they do.
 */
const FOOTER_LINK_LIST = 'flex flex-wrap items-center gap-x-4 gap-y-2 text-sm';

/**
 * A footer link at rest and on hover.
 *
 * Secondary at rest and promoted to full foreground on hover, so the affordance is a change in
 * emphasis rather than a change in hue. `hover:underline` accompanies it so the affordance is not
 * carried by colour alone.
 *
 * The transition is gated on `motion-safe:`, the engine's own
 * `prefers-reduced-motion: no-preference` query, at the 150ms the rest of the tier uses. A visitor
 * who has asked for less motion gets the colour change instantly instead of not at all.
 *
 * No focus utility: globals.css declares the global `:focus-visible` outline in `--color-ring` and
 * restating it here would only create a second place to change it. `rounded-sm` shapes that inherited
 * outline; see header section 5.
 */
const FOOTER_LINK = [
  'rounded-sm text-muted-foreground',
  'hover:text-foreground hover:underline',
  'motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out',
].join(' ');

/* -------------------------------------------------------------------------------------------------
 * Component
 * ---------------------------------------------------------------------------------------------- */

/** Props for {@link SiteFooter}. */
export interface SiteFooterProps {
  /**
   * Extra classes for the <footer> element, merged last so they win their Tailwind group.
   *
   * Exists so src/app/layout.tsx can POSITION the footer within the page shell - pinning it to the
   * bottom of a flex column, for instance - without this file having to know the shell's structure
   * and without the caller reaching for an inline style. It is not an invitation to re-skin the
   * footer: a colour passed through here would be a value chosen outside the token layer.
   */
  className?: string;
}

/**
 * The application's `contentinfo` landmark: attribution, plus three links to the public routes that
 * are reachable without a slug.
 *
 * A Server Component by design - it must never acquire a `'use client'` directive, a hook or a
 * fetch, because it renders on every route in the product. See the header for the full reasoning.
 *
 * @param props - See {@link SiteFooterProps}.
 * @returns The footer landmark.
 * @throws Error when `NEXT_PUBLIC_SITE_NAME` is unset or blank, propagated from
 * `resolveSiteName()`. Deliberate: an unbranded footer would ship a placeholder to readers, and the
 * message names the variable and points at `.env.example`.
 *
 * @example Mounted once, as a sibling of `<main>`, so it maps to `contentinfo`
 * ```tsx
 * <body className="flex min-h-dvh flex-col">
 *   <SiteHeader />
 *   <main className="flex-1">{children}</main>
 *   <SiteFooter />
 * </body>
 * ```
 */
export function SiteFooter({ className }: SiteFooterProps): JSX.Element {
  // Resolved per render rather than at module scope; see header section 3 for why the placement
  // matters, and section 4 for why the year needs no client-side correction.
  const siteName = resolveSiteName();
  const currentYear = new Date().getFullYear();

  return (
    <footer className={cn(FOOTER_BASE, className)}>
      <div className={FOOTER_SHELL}>
        <div className={FOOTER_ROW}>
          <p className={FOOTER_ATTRIBUTION}>
            © {currentYear} {siteName}. All rights reserved.
          </p>

          {/* Named, so this landmark is distinguishable from the header's navigation. */}
          <nav aria-label="Footer">
            <ul className={FOOTER_LINK_LIST}>
              {FOOTER_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className={FOOTER_LINK}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
    </footer>
  );
}
