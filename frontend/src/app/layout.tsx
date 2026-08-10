// =============================================================================
// src/app/layout.tsx - the App Router ROOT LAYOUT.
//
// Every route in this tier renders inside the document this file returns, which
// makes it the only place five decisions can be made once for the whole product:
// the language and hydration contract of the root element, the typefaces the
// token layer resolves against, the document-level metadata, the client
// boundaries the tree needs, and the landmark structure a screen-reader user
// navigates by. Before this change `GET /` returned 404 and the repository had
// no markup at all - this is the first document shell the project has ever had.
//
// -----------------------------------------------------------------------------
// 1. WHY THIS IS A SERVER COMPONENT, AND MUST STAY ONE
//
// There is no `'use client'` directive below and adding one would break two
// things at once. A Client Component cannot export `metadata` - TypeScript and
// the build both reject it - so the document title template, the description and
// the icons would have nowhere to live. And because this shell wraps every
// route, marking it client-only would pull the entire tree into the client
// bundle and discard the server-rendered article HTML that AAP §0.6.5 calls "the
// single most consequential SEO decision in the plan": a crawler must see the
// content without executing JavaScript.
//
// The three providers and sonner's toast host ARE `'use client'` modules. A
// Server Component rendering a Client Component is exactly the intended
// composition - the boundary is drawn at those four imports and nowhere wider.
// src/components/layout/site-header.tsx and site-footer.tsx are Server
// Components for the same reason, and each isolates its own interactive parts.
//
// -----------------------------------------------------------------------------
// 2. THE PROVIDER ORDER, WHICH IS NOT ARBITRARY
//
//   ThemeProvider -> QueryProvider -> AuthProvider -> the page
//
//   * ThemeProvider is outermost because theming must be settled before anything
//     paints. next-themes injects a blocking pre-hydration script that writes the
//     stored choice onto the document element, so the first frame is already in
//     the right theme.
//   * QueryProvider sits above AuthProvider because the cache has to exist before
//     any consumer of it mounts.
//   * AuthProvider is innermost of the three because it performs network work
//     through @/lib/api/auth during restoration, so it belongs INSIDE the cache
//     it may populate - and because everything that reads a session is beneath it.
//
// The two shell components are inside all three deliberately: SiteHeader
// composes UserMenu (which calls `useAuth`) and ThemeToggle (which calls
// `useTheme`), so a header mounted outside these providers would throw the
// "must be rendered inside AuthProvider" error `@/hooks/use-auth` raises - an
// error whose message names this file precisely because this is where the
// mistake would be made.
//
// -----------------------------------------------------------------------------
// 3. LANDMARKS, HEADINGS AND THE SKIP LINK
//
// This file owns the document's landmark skeleton, and it is the only file that
// can: `<header>` maps to `banner` and `<footer>` to `contentinfo` ONLY while
// they are siblings of `<main>`, so the three have to be composed together, here.
//
//   * SiteHeader renders the one `<header>`; SiteFooter renders the one
//     `<footer>`. This file adds neither, and renders `<main>` exactly once.
//   * NO `<h1>`. Neither shell component emits a heading of any level, so the
//     page beneath owns the document's single `<h1>` (AAP §0.7.3.5). A heading
//     here would either duplicate that one or open an out-of-order level.
//   * The SKIP-NAVIGATION LINK lives here, and it has to. site-header.tsx
//     documents why it does not carry one: the target is an `id` on the `<main>`
//     element this file owns, and "a dangling fragment is worse than none". It is
//     the first focusable element in the body so a keyboard user meets it before
//     the header's own controls, it is `sr-only` until focused, and it reveals
//     itself `fixed` above the sticky header rather than in flow - so revealing
//     it cannot shift the page.
//   * `<main>` carries `scroll-mt-16`, which matches the header's `h-16` row, so
//     following the skip link does not park the top of the content underneath the
//     sticky banner.
//
// -----------------------------------------------------------------------------
// 4. THE TYPEFACE CONTRACT WITH globals.css
//
// globals.css binds the engine's `--font-sans` and `--font-mono` tokens to
// `--font-app-sans` and `--font-app-mono`, and this file is the other half of
// that contract: `next/font` generates those two custom properties and the
// classes below put them on the root element. The names are character-for-
// character - rename one side and the font silently falls back to the system
// stack with nothing failing loudly.
//
// Geist is the sans face because src/app/opengraph-image.tsx renders its social
// card on `ImageResponse`'s built-in Geist Regular, so the card and the site it
// advertises share one typeface. Both faces are variable fonts, which is why no
// `weight` is requested: the whole axis arrives in one file, so every weight the
// prose plugin and the primitives use is covered without a second download.
//
// `next/font` is also what keeps `output: 'standalone'` self-contained: it
// downloads and self-hosts the files at build time and traces them into the
// standalone output. A hand-rolled `@font-face` pointing at an arbitrary path
// would not be traced, and there is no font binary in the repository to point at.
//
// -----------------------------------------------------------------------------
// 5. METADATA - WHAT @/lib/seo OWNS, AND WHAT ONLY THIS FILE CAN ADD
//
// `buildRootMetadata()` owns `metadataBase` (as a `URL`, so a child route's
// relative OpenGraph image resolves absolutely), the title template, the default
// description and the default cards. None of that is restated here; it is spread.
// That function is also the tier's only reader of NEXT_PUBLIC_SITE_URL and
// NEXT_PUBLIC_SITE_NAME - this file reads no environment variable itself, and
// hard-codes no origin.
//
// The one field this file adds is `icons`, and the reason is precise:
// public/icon.svg and public/apple-icon.png live under `public/`, NOT under
// `src/app/`, so the framework's metadata FILE convention does not detect them.
// Without the declaration below they would be served but never referenced.
// public/favicon.ico is deliberately NOT declared - it is fetched from the root
// path by browser convention and needs no wiring, and declaring it would add a
// second, weaker icon that could win over the SVG.
//
// No OpenGraph or Twitter image is declared either. src/app/opengraph-image.tsx
// is a generated `ImageResponse` route the framework picks up by file convention
// and merges into this metadata; public/og-default.png is the static card
// referenced by src/components/seo/json-ld.tsx. Naming either here would publish
// the same picture twice.
//
// -----------------------------------------------------------------------------
// 6. THE ONLY LITERAL VALUES IN THIS FILE
//
// The two hexadecimal colours in `viewport.themeColor` are the single justified
// exception to the zero-hardcoded-values rule, and they are flagged as such where
// they appear. `theme-color` is a browser-CHROME hint - it paints the address bar
// and the task-switcher card, outside the page cascade - so it cannot resolve a
// CSS custom property. This is the same last-rung resolution public/icon.svg,
// favicon.ico, apple-icon.png, og-default.png and opengraph-image.tsx already
// apply, and globals.css keeps the canonical figures in its palette-parity block
// specifically so consumers like this one stay in step by VALUE. Both values are
// the measured `--color-background` of their theme.
//
// Everything else resolves to a token: `bg-background`, `text-foreground`,
// `bg-surface` and `border-border` are four of the fourteen semantic colours,
// and every dimension is a step on the engine's own scales. No `dark:` variant
// appears anywhere, because each token is declared twice in globals.css and
// re-themes on its own; no `@media` is authored, because the engine's five
// breakpoints are the whole responsive vocabulary and this shell needs none of
// them - a single column that stretches is correct at every width.
//
// -----------------------------------------------------------------------------
// 7. WHAT THIS FILE DELIBERATELY DOES NOT DO. Each looks like an improvement.
//
//   1. `'use client'`, or `import React from 'react'`. See section 1; the second
//      is unnecessary because tsconfig.json sets `"jsx": "react-jsx"`.
//   2. Any `process.env` read, any `fetch`, any `@/lib/api/*` import. The shell
//      renders on every route, so one request here would tax every page - the
//      same reason both shell components are declared to perform no HTTP.
//   3. A `generateMetadata` export. The document's own metadata is static; the
//      per-resource ones belong to the routes that describe a resource.
//   4. An `alternates.canonical` or a `robots` field. Metadata is inherited field
//      by field, so a canonical declared here would be adopted by every route
//      that declares none and each would claim to be the home page. The crawl
//      policy is src/app/robots.ts.
//   5. `maximumScale` or `userScalable: false` in the viewport. Capping zoom
//      fails WCAG 1.4.4, and no design intent asks for it.
//   6. A `<Suspense>` boundary around `{children}`. loading.tsx and the route
//      groups own their own boundaries.
//   7. A second `<Toaster />`, a second `<header>`, a second `<footer>` or an
//      `<h1>`. Each of those is owned elsewhere; see sections 2 and 3.
//   8. A sibling global-error.tsx. src/app/error.tsx records the trade: it cannot
//      catch a throw from this layout, which is acceptable precisely because this
//      file performs no data access and reads no environment variable of its own.
//   9. A raw `<button>`, `<input>`, `<textarea>`, `<select>` or `<table>`, an
//      inline `style`, an `!important`, an ID selector or a second stylesheet.
//      The shell needs no control of its own: the header owns every one it needs.
//  10. Anything from the retired surface - no `/items` path, no `Item` type, no
//      `id`/`name`/`price` triple. AAP §0.9.4.3 requires that surface absent.
// =============================================================================

// The only stylesheet in the tier, imported in the only place it may be. It
// carries `@import 'tailwindcss'`, the typography plugin, the dark variant and
// the fourteen semantic tokens every class below resolves against.
import './globals.css';

import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import type { JSX, ReactNode } from 'react';

import { Toaster } from 'sonner';

import { SiteFooter } from '@/components/layout/site-footer';
import { SiteHeader } from '@/components/layout/site-header';
import { buildRootMetadata } from '@/lib/seo';
import { AuthProvider } from '@/providers/auth-provider';
import { QueryProvider } from '@/providers/query-provider';
import { ThemeProvider } from '@/providers/theme-provider';

/* -------------------------------------------------------------------------------------------------
 * Typefaces
 *
 * Loaded at module scope, which is what `next/font` requires: the loader runs at build time, so it
 * cannot be called inside a render. Each call returns a generated class that declares one custom
 * property, and section 4 of the header records why those two property names are a contract with
 * src/app/globals.css rather than a preference.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The body face, exposed as `--font-app-sans` for globals.css to bind `--font-sans` to.
 *
 * `latin` is the only subset requested because the product ships one locale (AAP §0.9.3 excludes
 * internationalisation), and every additional subset is another file on the wire. No `weight` is
 * given: Geist is a variable font, so the full 100-900 axis arrives in a single file and the
 * primitives and the prose plugin can reach any weight without a second request. `display: 'swap'`
 * renders the metric-adjusted fallback immediately and swaps the webfont in when it lands, so text
 * is never invisible while a font downloads.
 */
const geistSans = Geist({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-app-sans',
});

/**
 * The monospace face, exposed as `--font-app-mono` for globals.css to bind `--font-mono` to.
 *
 * `preload: false` is the one departure from the sans face's configuration, and it is deliberate:
 * monospace appears only inside rendered code in an article body, so preloading it on every route
 * would spend critical-path bandwidth on a file most pages never use. The `@font-face` and the
 * custom property are still emitted, so a code block gets the real face - it simply arrives on
 * demand, behind the same `swap` fallback.
 */
const geistMono = Geist_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-app-mono',
  preload: false,
});

/* -------------------------------------------------------------------------------------------------
 * Document metadata
 * ---------------------------------------------------------------------------------------------- */

/**
 * Document metadata for every route in the application.
 *
 * Almost all of it is `buildRootMetadata()`'s - `metadataBase`, the title template, the default
 * description and the default OpenGraph and Twitter cards - spread rather than restated so the site
 * identity is declared in exactly one module. Section 5 of the header records why `icons` is the
 * one field added here, why `favicon.ico` is absent from it, and why no social image is named.
 *
 * Built at module evaluation because a static `metadata` export must be an object: there is no
 * later moment at which it could be resolved. That means a missing NEXT_PUBLIC_SITE_URL or
 * NEXT_PUBLIC_SITE_NAME fails here, while `next build` is running, which is the behaviour
 * `buildRootMetadata()` documents and intends - a placeholder origin would publish wrong canonical
 * URLs to a crawler, and a placeholder site name would brand every page and social card with it.
 */
export const metadata: Metadata = {
  ...buildRootMetadata(),

  icons: {
    // Served from public/, so the framework's metadata FILE convention cannot find it and the
    // declaration is what puts <link rel="icon"> in the document. The type hint lets a browser skip
    // the request when it cannot render SVG, at which point it falls back to /favicon.ico.
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
    // The home-screen icon on iOS, which ignores `rel="icon"` entirely. 180x180 and opaque, which
    // is what that platform requires - it applies no transparency handling of its own.
    apple: [{ url: '/apple-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

/**
 * Viewport and browser-chrome hints for every route.
 *
 * `colorScheme: 'light dark'` announces both themes before any stylesheet has parsed, so native
 * chrome - scrollbars, form controls, the caret - is rendered in the right one from the first frame
 * rather than flashing light. globals.css then narrows it per theme with `color-scheme` on `:root`
 * and `.dark`.
 *
 * No `maximumScale` and no `userScalable: false`: pinch-zoom stays available, because capping it
 * fails WCAG 1.4.4 and nothing in the design asks for it.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
  /* BLITZY [COLOR]: the two literals below are the only ones in this file. `theme-color` paints
   * browser chrome outside the page cascade and cannot read a CSS custom property, so the value has
   * to be carried by parity: each is the measured hex of `--color-background` in its theme, taken
   * from the palette-parity block in src/app/globals.css (light slate-50 #f8fafc, dark slate-950
   * #020618). Keep them in step with that block - it is the canonical record. */
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
    { media: '(prefers-color-scheme: dark)', color: '#020618' },
  ],
};

/* -------------------------------------------------------------------------------------------------
 * Class tables and identifiers
 *
 * Declared as module constants so the markup below reads as structure. Every value resolves to a
 * semantic token from src/app/globals.css or to a step on one of the engine's own scales; the only
 * literals are the two flagged in `viewport` above.
 * ---------------------------------------------------------------------------------------------- */

/**
 * DOM `id` of the `<main>` landmark, and the skip link's target.
 *
 * A module constant rather than `useId()` for two reasons: `useId` is a hook and this file must stay
 * a Server Component, and the value has to be a STABLE, knowable string because it is also a URL
 * fragment. Declared once and read twice - by the link's `href` and by the element's `id` - so the
 * two cannot drift into a dangling fragment.
 */
const MAIN_ELEMENT_ID = 'main-content';

/**
 * The `<body>` element.
 *
 * `flex min-h-dvh flex-col` is the shell both site-header.tsx and site-footer.tsx document
 * themselves against: a column at least one viewport tall, so `flex-1` on `<main>` pushes the footer
 * to the bottom on a short page instead of leaving it floating mid-screen. `dvh` rather than `vh` so
 * a mobile browser's collapsing toolbar does not leave a strip of unpainted canvas.
 *
 * `bg-background`, `text-foreground`, `font-sans` and `antialiased` restate the floor globals.css
 * already sets on `body` in its base layer. That restatement is intentional rather than redundant:
 * the values are identical - `bg-background` and the base rule both resolve `--app-background` - so
 * there is no conflict to arbitrate, and the shell says out loud which canvas and which face it
 * renders on instead of leaving a reader to infer it from another file.
 */
const BODY_SHELL = 'flex min-h-dvh flex-col bg-background font-sans text-foreground antialiased';

/**
 * The `<main>` landmark.
 *
 * `flex-1` takes the free space in the body column, which is what pins the footer. `scroll-mt-16`
 * matches the header's own `h-16` row, so a jump to this element's fragment - from the skip link, or
 * from any in-page anchor - clears the sticky banner instead of scrolling the first line underneath
 * it. No padding, no measure and no grid: each page owns its own layout, and the two shell
 * components already establish the shared `max-w-6xl` measure for the content between them.
 *
 * It carries NO `tabIndex={-1}`, and that is a considered decision rather than an omission.
 * Following the skip link was verified in a browser: the fragment moves the sequential focus
 * navigation starting point, and the next Tab lands on the first control INSIDE this element,
 * past every header control - which is the entire job of a skip link. Making the region itself
 * programmatically focusable would instead draw the document-wide `:focus-visible` outline
 * globals.css declares around the whole content area on every use, and the alternative - pairing
 * the `tabIndex` with an outline suppression - is the exact anti-pattern
 * src/components/ui/table.tsx rejects when it records that "a `tabIndex` with no visible ring"
 * is a defect. A landmark a keyboard and a screen reader can already reach gains nothing from a
 * focus stop of its own.
 */
const MAIN_REGION = 'flex-1 scroll-mt-16';

/**
 * The skip-navigation link.
 *
 * Hidden with `sr-only` - which keeps it in the accessibility tree and in the tab order while taking
 * it out of flow and out of sight - and revealed on keyboard focus only. Three details are
 * load-bearing:
 *
 *   * `focus-visible:`, never `focus:`. A mouse click on nothing near it cannot flash the link into
 *     view, matching the `:focus-visible` floor globals.css sets for the whole document.
 *   * `focus-visible:fixed` rather than letting `not-sr-only` return the link to flow. Revealed in
 *     flow it would become a flex item of the body column and push the header down; pinned it
 *     overlays instead, so revealing it shifts nothing. The two utilities both set `position`, and
 *     the engine emits `not-sr-only` first at equal specificity, so `fixed` is what applies -
 *     verified against the compiled stylesheet rather than assumed.
 *   * `focus-visible:z-50` puts it above the header's `sticky ... z-40`, which is the one thing that
 *     could otherwise cover it. That is the same tier every portal surface in this project uses.
 *
 * The inline offset is `start-4`, the LOGICAL `inset-inline-start`, not `left-4` - the same choice
 * `@/components/ui/alert` and `@/components/blog/search-input` make, so the link would appear at the
 * inline start of a right-to-left document with no extra rule. It pairs with `top-4` because the
 * engine offers no block-axis logical inset utility, and `px-4`/`py-2` are already logical
 * (`padding-inline` / `padding-block`) in this version.
 *
 * `bg-surface` gives it the raised canvas the rest of the system uses for a panel, and the global
 * `:focus-visible` outline supplies the ring, so no ring is declared here.
 */
const SKIP_LINK = [
  'sr-only',
  'focus-visible:not-sr-only focus-visible:fixed focus-visible:top-4 focus-visible:start-4',
  'focus-visible:z-50 focus-visible:rounded-md focus-visible:border focus-visible:border-border',
  'focus-visible:bg-surface focus-visible:px-4 focus-visible:py-2',
  'focus-visible:text-sm focus-visible:font-medium focus-visible:text-foreground',
  'focus-visible:shadow-md',
].join(' ');

/** The skip link's accessible name, which is also its visible text once revealed. */
const SKIP_LINK_LABEL = 'Skip to main content';

/* -------------------------------------------------------------------------------------------------
 * Component
 * ---------------------------------------------------------------------------------------------- */

/** Props for {@link RootLayout}. */
interface RootLayoutProps {
  /**
   * The matched route's tree, supplied by the framework.
   *
   * Rendered unconditionally and never gated behind a flag - none of the three providers gates
   * either, for the same reason: anything that withholds this subtree on the server discards the
   * HTML a crawler has to be able to read.
   */
  readonly children: ReactNode;
}

/**
 * The application's root layout: the `<html>` document every route renders inside.
 *
 * Responsibilities, in the order they appear below: declare the document language and absorb the
 * theme's first-paint difference, carry the two font variables, establish the page shell, mount the
 * skip link, mount the three client providers in their required order, compose the three landmarks,
 * and mount the single toast host.
 *
 * `suppressHydrationWarning` on `<html>` is MANDATORY and is not a workaround for a defect. The
 * server cannot know a returning visitor's stored theme, so next-themes' blocking pre-hydration
 * script writes the class onto the root element before React hydrates - which means the root
 * element's attributes legitimately differ between the server's HTML and the client's first render.
 * The attribute confines React's tolerance to that one element. src/providers/theme-provider.tsx
 * names this file as where it belongs, having deliberately refused the alternative - a `mounted`
 * gate that renders nothing on the server. Without it the console carries a hydration warning on
 * every load, which AAP §0.9.4.5 treats as a blocking failure.
 *
 * @param props - See {@link RootLayoutProps}.
 * @returns The complete document: `<html>`, `<body>`, the skip link, the provider stack, the
 * `banner` / `main` / `contentinfo` landmarks and the toast host.
 * @throws {Error} When NEXT_PUBLIC_SITE_NAME is unset or blank, propagated from the two shell
 * components' `resolveSiteName()` call. Deliberate: an unbranded shell would ship a placeholder to
 * readers, and the message names the variable and points at `.env.example`.
 */
export default function RootLayout({ children }: RootLayoutProps): JSX.Element {
  return (
    <html
      className={`${geistSans.variable} ${geistMono.variable}`}
      lang="en"
      suppressHydrationWarning
    >
      <body className={BODY_SHELL}>
        {/*
         * First focusable element in the document, and outside the providers because it needs
         * nothing from any of them - it is a plain in-page anchor, and being first is the whole
         * point. See {@link SKIP_LINK}.
         */}
        <a className={SKIP_LINK} href={`#${MAIN_ELEMENT_ID}`}>
          {SKIP_LINK_LABEL}
        </a>

        <ThemeProvider>
          <QueryProvider>
            <AuthProvider>
              {/* The `banner` landmark. Mounted once, as a sibling of <main>. */}
              <SiteHeader />

              <main className={MAIN_REGION} id={MAIN_ELEMENT_ID}>
                {children}
              </main>

              {/* The `contentinfo` landmark. Sibling of <main>, never nested inside it. */}
              <SiteFooter />

              {/*
               * The one toast host in the application. Every mutation surface in the tier - the like
               * control, the comment form, the post editor, the four admin row actions, the category
               * form and the share bar - calls `toast(...)` from `sonner`, and each of them documents
               * that it mounts no host of its own; a second host here would render every
               * notification twice.
               *
               * Three props, and no styling of any kind. `richColors` gives a success, error or
               * warning notification its own semantic ground - paired with sonner's own icon, so
               * colour is never the sole carrier of meaning. `bottom-right` keeps notifications clear
               * of the sticky header and of the drawer trigger at narrow widths. `theme="system"`
               * matches the `defaultTheme="system"` that src/providers/theme-provider.tsx configures,
               * and is the closest a Server Component can come to the document's theme: sonner reads
               * this prop and the OS preference, never our `.dark` class, and its styles are injected
               * UNLAYERED - so they beat any utility we could pass, which is exactly why this host is
               * configured through its own props rather than restyled with tokens. The honest cost is
               * narrow: a visitor who overrides the OS preference with the header's control gets
               * toast chrome in the OS theme until they change that preference too.
               */}
              <Toaster position="bottom-right" richColors theme="system" />
            </AuthProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
