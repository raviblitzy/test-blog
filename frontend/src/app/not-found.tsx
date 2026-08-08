// not-found.tsx - the root missing-resource boundary, served with HTTP 404.
//
// Next.js renders this file for two distinct things, and they are worth
// separating because only one of them is a typo:
//
//   1. Any URL that matches no route at all - a mistyped address, a stale
//      bookmark, an external link to a path this application never served.
//   2. Any `notFound()` raised while rendering a segment that has no closer
//      boundary of its own. `/u/{username}` for an author who does not exist
//      and `/posts/{id}/edit` for a post the caller does not own both land
//      here; `/blog/{slug}` does NOT, because that segment ships its own
//      not-found.tsx and the nearest boundary always wins.
//
// In both cases the framework sends status 404 rather than 200, which is the
// half that matters to a crawler: a soft 404 - "page not found" prose returned
// with a success status - gets the missing URL indexed as though it were real
// content. The status comes from the file convention itself, so nothing here
// needs to set it, and nothing here may do anything that would prevent it.
//
// It is a small file. It is also a real page on a public site: a crawler will
// fetch it, and a lost visitor needs a way out that works.
//
// ---------------------------------------------------------------------------
// 1. A SERVER COMPONENT, WITH NO 'use client' - AND WHY THAT DIFFERS FROM
//    ITS SIBLING error.tsx
//
// src/app/error.tsx carries the directive because an error boundary is a
// client-side React mechanism: it receives a `reset` function it has to be able
// to invoke. This file receives nothing and invokes nothing. It renders the same
// markup for every visitor, so it belongs on the server, where it costs the
// client bundle nothing and where its content is present in the first HTML the
// browser receives - including for a crawler that executes no JavaScript.
//
// It also takes NO PROPS. Next.js passes none to this convention file - not the
// requested path, not the params, not the search params - so declaring a
// parameter would be declaring something that never arrives.
//
// ---------------------------------------------------------------------------
// 2. THE REQUESTED PATH IS NEVER PRINTED BACK. NOT AN OVERSIGHT.
//
// "We could not find /the/path/you/asked/for" is the conventional 404 copy and
// it is deliberately absent. The path is attacker-controlled input, and echoing
// it into the page is a reflected-injection surface for no benefit: the visitor
// already knows which address they used, it is still in the address bar, and the
// only thing the page can usefully tell them is what to do next. Fixed copy
// cannot carry a payload no matter what was requested.
//
// The same reasoning rules out reading the path in order to guess at it - a
// "did you mean" suggestion, a nearest-slug lookup, a list of recent posts.
// Every one of those turns a boundary into a data-dependent page that can itself
// fail, and a 404 that 500s has nowhere left to fall. So this file performs no
// `fetch`, imports no `@/lib/api/*` wrapper, and reads no `process.env` key.
// The one path it needs comes from `@/lib/seo`'s route builder, which is a pure
// function over no configuration at all.
//
// ---------------------------------------------------------------------------
// 3. WHY THE HEADING COMES FROM CardTitle AND NOT FROM AlertTitle
//
// This page owns its single `h1`. `SiteHeader` and `SiteFooter` contain none -
// the shell frames content, it does not head it - so the boundary has to supply
// one, and there is exactly one element in the design system that can: only
// `CardTitle` accepts `as="h1"`. `AlertTitle`'s `as` union deliberately excludes
// `h1`, because an alert is a notice that may appear anywhere in a document and
// letting it be the top-level heading would corrupt the outline of any page that
// rendered one inside a section. Hence the composition below - the Card supplies
// the page heading and a comfortable measure, the Alert supplies the notice -
// which is the same shape src/app/error.tsx uses, so the two boundaries read as
// one family rather than two designs.
//
// ---------------------------------------------------------------------------
// 4. THE ALERT IS `info`, NOT `destructive`. THE SUBTLE DECISION HERE.
//
// `destructive` is the obvious pick - a 404 is an error, after all - and it is
// the wrong one, because in this design system the variant chooses the
// LIVE-REGION ROLE as well as the tone: `destructive` renders `role="alert"`,
// which announces assertively and interrupts whatever a screen reader is
// currently saying.
//
// That is correct for something that happens IN RESPONSE to an action, which is
// why error.tsx uses it. It is wrong here. This alert is not an event that
// occurred while the visitor was reading - it IS the page, present in the very
// first HTML the server sends. An assertive live region on page load speaks out
// of document order, ahead of the heading that names the problem and ahead of
// the links that solve it, and it announces the notice twice: once as the live
// region fires and again when the reader reaches it in the flow. `info` is
// silent, so the panel is read where it sits, like any other paragraph, after
// the `h1` it belongs to.
//
// Nothing is lost by being silent, because the status code already carried the
// failure and the heading carries the meaning. Tone is never the sole indicator
// here either: "Page not found" and "We could not find that page" say what
// happened in words.
//
// `empty` was the other candidate and is also wrong: its centred, dashed
// treatment is for an absence WITHIN a working view ("no posts match this
// filter"), and its centred text would fight the start-aligned heading above it
// and the start-aligned controls below it. It also cannot take the leading icon.
//
// No `role` and no `aria-live` attribute is authored anywhere in this file, and
// that is a positive decision rather than an omission: the variant already
// carries the announcement behaviour, so restating it here would duplicate a
// decision that has one home and risk a double announcement.
//
// ---------------------------------------------------------------------------
// 5. TWO RECOVERY LINKS, AND WHY THERE IS NO THIRD
//
// Both are real anchors - `Button asChild` composes `@radix-ui/react-slot` onto
// `next/link` - and that is load-bearing on this page above all others. An
// `onClick` handler needs a working client bundle; an `<a href>` is honoured by
// the browser with no JavaScript at all. The escape route from a 404 must not
// itself depend on script execution.
//
//   * The home feed is the canonical recovery and the primary action. Its href
//     comes from `feedPath()` rather than a literal `'/'`, so this page cannot
//     disagree with the module that decides what the feed's address is.
//   * Signing in is the secondary action. The root boundary is what a visitor
//     sees after following a stale link into an area that needs an account: the
//     authoring screens under `/posts/{id}/edit` answer `notFound()` for a post
//     the caller may not see, deliberately, so that a draft's existence is not
//     disclosed - and that answer is indistinguishable from a deleted one. For
//     someone who is not signed in, signing in is the step that resolves it.
//
// There is no third, and the two obvious candidates are both refused. A blog
// index is not linked because there is no such route: the reading index IS the
// home feed, so a second button to the same address would be a duplicate
// pretending to be a choice. And nothing category-, author- or post-specific is
// linked because every one of those needs a request - see section 2.
//
// ---------------------------------------------------------------------------
// 6. DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT.
//
//   1. `'use client'`. See section 1. It would also make the `metadata` export
//      below illegal, since a Client Component cannot declare one.
//   2. `import React from 'react'`. `"jsx": "react-jsx"` means the compiler
//      imports the JSX runtime, so the default import would be unused - and
//      `npm run lint` runs with `--max-warnings=0`, which turns an unused import
//      into a failed gate rather than a warning.
//   3. A sibling global-error.tsx. It is absent from the plan's file inventory
//      on purpose, and it is not this file's business either way: a missing
//      resource is not a crashed root layout.
//   4. A second `<header>`, `<main>` or `<footer>`. src/app/layout.tsx owns the
//      shell and this file supplies only the page body, so the site header and
//      footer frame it exactly as they frame every other route.
//   5. Any `dark:` variant. Every token reached below is dual-valued - declared
//      once at the document root and again under `.dark` in src/app/globals.css
//      - so every surface here flips with no conditional. A `dark:` class would
//      be a second source of truth for the same decision and would drift.
//   6. Any literal colour, length, radius, shadow or font size, and any custom
//      `@media` query. Every value resolves to a token, and the only breakpoint
//      used is the token layer's own `sm`.
//   7. A behavioural primitive - a dialog, a menu, a tab set. Nothing here needs
//      focus trapping or roving focus: two links in the normal tab order, each
//      with the focus ring the token layer already guarantees.
//   8. A `<meta http-equiv="refresh">` or any other automatic redirect to the
//      home page. It destroys the browser's back button, gives the visitor no
//      chance to read what happened, and turns a clean 404 into a hop that
//      search engines treat as a soft 404.

import { FileQuestionMark } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { JSX } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { feedPath } from '@/lib/seo';

/**
 * The sign-in route, as `src/app/(auth)/login/page.tsx` serves it.
 *
 * Written as a constant here rather than taken from `@/lib/seo` because that
 * module publishes builders only for the addresses that need CANONICALISING -
 * the feed, a post, a profile, a category view and the sitemap - and this is not
 * one of them. An authentication screen describes no resource, has no canonical
 * URL and takes no parameters, so there is nothing for a builder to decide and a
 * builder that only ever returns a constant would be indirection without a
 * purpose. The route group's parentheses are not part of the URL, which is why
 * this is `/login` and not `/(auth)/login`.
 */
const LOGIN_PATH = '/login';

/**
 * Metadata for the 404 response.
 *
 * Verified against the installed framework rather than assumed: Next.js 16.3.0
 * collects metadata for the `not-found` convention and places it LAST, after the
 * root layout's, so this really does take effect here. `title` is a plain string
 * and therefore flows through the title template the root layout declares, which
 * is what keeps this page's document title branded like every other route's
 * instead of standing alone.
 *
 * `robots` is the substantive half. Nothing on a 404 body is worth indexing, and
 * the status code alone is not quite enough insurance - a stale inbound link, a
 * mirrored page or a crawler that treats the body as content can all get this
 * text into an index. `index: false` closes that, and `follow: false` stops the
 * two recovery links being read as endorsements from a page that does not exist.
 * The root metadata sets no `robots` field of its own - the crawl policy lives
 * in `src/app/robots.ts` - so this declares rather than contradicts.
 *
 * THE RENDERED HEAD THEREFORE CARRIES TWO ROBOTS TAGS, and that is expected
 * rather than a duplicate to be chased down. Measured in a browser against the
 * production build: Next.js emits its own `<meta name="robots" content="noindex">`
 * for the unmatched-URL route, and this export adds
 * `<meta name="robots" content="noindex, nofollow">`. Both agree on `noindex` and
 * the second is strictly stronger, so a crawler combining them lands on exactly
 * the intended policy. Deleting this field to remove the duplicate would be the
 * wrong trade twice over: it would drop `nofollow` entirely, and it would make
 * the page's crawl policy depend on a framework-supplied tag that is present for
 * one of the two ways this boundary is reached and absent for the other. A
 * self-sufficient declaration is worth one redundant tag.
 *
 * No `alternates.canonical`: a canonical URL is a claim that this address is the
 * preferred version of a real resource, and there is no resource here.
 */
export const metadata: Metadata = {
  title: 'Page not found',
  description: 'The page you asked for could not be found.',
  robots: {
    index: false,
    follow: false,
  },
};

/**
 * The root segment's missing-resource boundary.
 *
 * Renders inside the site shell, so the header and footer frame it as they frame
 * every other route, and supplies the page body only. Takes no props, holds no
 * state, issues no request, reads no environment variable and reflects nothing
 * from the URL - the whole page is fixed copy plus two static links.
 *
 * Named `NotFound` for readability; the framework keys on the file name and the
 * default export, never on the function's name.
 *
 * @returns The page body. The surrounding shell is the root layout's.
 */
export default function NotFound(): JSX.Element {
  return (
    // The page's measure. `max-w-2xl` is the --container-2xl token, which holds
    // the copy at a readable line length on a wide viewport, and `mx-auto`
    // centres it in whatever main element the layout provides. `w-full` is what
    // makes the block shrink below that measure instead of standing at it, so a
    // 375px viewport gets the full width minus the inset. The inline padding
    // steps up once at the token layer's `sm` breakpoint - the only breakpoint
    // this file uses - so the card never touches the viewport edge on a phone.
    // Identical to src/app/error.tsx, deliberately: the two boundaries should
    // occupy the same place on the page rather than shifting between failures.
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
      {/*
       * `section` rather than the default `div`: this is a titled region of the
       * document, and the `CardTitle` below gives it its accessible name.
       */}
      <Card as="section">
        <CardHeader>
          {/* The single h1 of this page. `text-2xl` overrides the primitive's
              default type step, because this is a page heading rather than a
              card heading inside a feed - both values are --text-* tokens. */}
          <CardTitle as="h1" className="text-2xl">
            Page not found
          </CardTitle>
        </CardHeader>

        <CardContent>
          {/*
           * `info` selects a neutral tone AND silence - no live-region role - so
           * the notice is read in document order after the heading rather than
           * announced over it on load. Section 4 of the file header records why
           * `destructive` would be wrong here even though this is a 404.
           *
           * The icon is the first child, as the primitive's leading-icon slot
           * requires, and is hidden from assistive technology because the title
           * and description already carry the meaning; an announced glyph would
           * only repeat them.
           */}
          <Alert variant="info">
            <FileQuestionMark aria-hidden="true" />
            <AlertTitle>We could not find that page</AlertTitle>
            <AlertDescription>
              This address does not match anything on the site. The page may have been moved or
              deleted, or the link that brought you here may be incomplete. Nothing needs retrying,
              so the two links below go somewhere that exists.
            </AlertDescription>
          </Alert>
        </CardContent>

        {/* Already a wrapping row with a token gap, so at narrow widths the two
            links stack instead of overflowing the card. */}
        <CardFooter>
          {/*
           * The primary recovery. `asChild` renders a real anchor, so it
           * navigates with no working client bundle, and `feedPath()` keeps the
           * address in step with the module that owns it.
           */}
          <Button asChild>
            <Link href={feedPath()}>Go to the home feed</Link>
          </Button>

          {/*
           * The secondary recovery, for the visitor who followed a link into an
           * area that needs an account. `secondary` keeps the feed the visually
           * primary choice. The label names the destination rather than the
           * gesture - never "click here".
           */}
          <Button asChild variant="secondary">
            <Link href={LOGIN_PATH}>Sign in to your account</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
