/* =============================================================================
 * blog/[slug]/not-found.tsx - the missing-post boundary.
 *
 * The segment-scoped `not-found` convention for `/blog/{slug}`. Next.js resolves
 * this convention to the NEAREST boundary above the segment that raised it, so
 * this file - not src/app/not-found.tsx - answers a request for a post that
 * cannot be shown. The root boundary records the same relationship from its own
 * side: its header states that `/blog/{slug}` does not land there "because that
 * segment ships its own not-found.tsx and the nearest boundary always wins".
 * The two files are a matched pair and neither is redundant.
 *
 * ---------------------------------------------------------------------------
 * 0. WHAT THIS FILE DOES NOT CONTROL - MEASURED, SO NOBODY RE-DISCOVERS IT
 *
 * A `not-found` boundary is a component. It has no API for the response status
 * and no way to influence one, and on this route the framework does not give it
 * a 404: measured against the production build of Next.js 16.3.0, a `notFound()`
 * raised inside the dynamic `/blog/[slug]` segment answers HTTP **200**, both
 * when the path is rendered on demand and when it is prerendered through
 * `generateStaticParams`. The unmatched-URL path behaves differently and does
 * answer 404, which is why the root boundary can be described as a 404 page and
 * this one cannot.
 *
 * That is a property of the route, not of this file, and it belongs to whoever
 * owns `page.tsx`: the status is committed when the response headers flush,
 * which on a streamed dynamic segment happens before the `notFound()` inside it
 * resolves. Nothing can be added below to change it. It is recorded here because
 * the mitigation that IS available - a `noindex` crawl directive - is the reason
 * the `metadata` export exists, and because a reader who assumes this file
 * carries a 404 will misread everything else about it.
 *
 * ---------------------------------------------------------------------------
 * 1. THE TWO WAYS A READER ARRIVES HERE, AND WHY THE COPY CANNOT NAME EITHER
 *
 * src/app/blog/[slug]/page.tsx calls `notFound()` in exactly two cases, and they
 * are indistinguishable to this file BY DESIGN:
 *
 *   1. No post has that slug - it never existed, or it was deleted.
 *   2. A post has that slug, but it is a DRAFT the caller may not read.
 *
 * The service answers both with 404 rather than distinguishing them, because a
 * distinguishable answer is a disclosure: a 403 on case 2 would confirm that a
 * particular unpublished title exists at a particular address, which is exactly
 * the fact draft confidentiality protects (AAP §0.9.4.4 - "a draft never appears
 * in the public feed, in a category filter result, or on a public profile, and
 * is readable only by its author or an administrator").
 *
 * That constraint reaches into the PROSE, not just the status code. Copy naming
 * one cause would re-open the side channel the shared 404 closes, and it would
 * be wrong half the time. So the copy below is deliberately cause-agnostic: it
 * describes the state the reader is in - there is nothing published here to read
 * - and lists the possible reasons as a set, without claiming which applies.
 * Rendering identical bytes for both cases is what makes the page carry no
 * information the API withheld.
 *
 * ---------------------------------------------------------------------------
 * 2. A SERVER COMPONENT THAT TAKES NO PROPS. BOTH HALVES ARE LOAD-BEARING.
 *
 * Next.js passes NOTHING to this convention file - not the params, not the
 * requested path, not the search params - so the default export declares no
 * parameter. Declaring `{ params }` here would type-check and then be
 * permanently `undefined` at run time, which is worse than not having it.
 *
 * There is deliberately no `'use client'`. The page renders the same markup for
 * every visitor and holds no state, so it belongs on the server, where it costs
 * the client bundle nothing and its content is in the first HTML the browser
 * receives - including for a crawler that executes no JavaScript. The directive
 * would also make the `metadata` export below illegal: a Client Component cannot
 * declare one.
 *
 * ---------------------------------------------------------------------------
 * 3. THE REQUESTED SLUG IS NEVER RECOVERED AND NEVER PRINTED
 *
 * "We could not find the post 'my-slug'" is the conventional copy for this
 * screen and it is absent on purpose, for two independent reasons.
 *
 * The slug is attacker-controlled input. Echoing it into the page is a reflected
 * -injection surface bought for no benefit: the visitor already knows the
 * address they used, it is still in the address bar, and the only thing this
 * page can usefully tell them is what to do next. Fixed copy cannot carry a
 * payload whatever was requested.
 *
 * And obtaining it would take a client hook (`useParams`) or a header read,
 * either of which turns a boundary into a page with a dependency that can itself
 * fail. A 404 that throws has nowhere left to fall. The same reasoning rules out
 * the tempting "did you mean…" - a nearest-slug lookup, a list of recent posts,
 * the author's other work - because every one of those needs a request. So this
 * file performs no `fetch`, imports nothing from `@/lib/api/*`, and reads no
 * `process.env` key. Its one address comes from `feedPath()`, a pure function
 * over no configuration at all.
 *
 * ---------------------------------------------------------------------------
 * 4. WHY THE h1 COMES FROM CardTitle AND NOT FROM AlertTitle
 *
 * This page owns the single `h1` of the document it renders into. SiteHeader and
 * SiteFooter contain none - the shell frames content rather than heading it - so
 * the boundary has to supply one, and only one component in the design system
 * can: `CardTitle` accepts `as="h1"`, while `AlertTitle`'s `as` union stops at
 * `h2`. That exclusion is deliberate in the primitive, because an alert is a
 * notice that may appear anywhere in a document and letting it be the top-level
 * heading would corrupt the outline of any page that rendered one inside a
 * section. Hence the shape below - the Card supplies the heading and the
 * measure, the Alert supplies the notice - which is the shape both sibling
 * boundaries use, so the three read as one product rather than three designs.
 *
 * ---------------------------------------------------------------------------
 * 5. THE ALERT IS `info`. NOT `destructive`, THOUGH A 404 IS A FAILURE.
 *
 * In this design system the `variant` chooses the LIVE-REGION ROLE as well as
 * the tone: `destructive` renders `role="alert"`, which announces assertively
 * and interrupts whatever a screen reader is currently saying.
 *
 * That is right for something that happens IN RESPONSE to an action - which is
 * why src/app/error.tsx uses it - and wrong here. This notice is not an event
 * that occurred while the visitor was reading. It IS the page, present in the
 * very first HTML the server sends. An assertive live region on load speaks out
 * of document order, ahead of the heading that names the problem and ahead of
 * the link that solves it, and it announces twice: once as the region fires and
 * again when the reader reaches it in the flow. `info` is silent, so the panel is
 * read where it sits, after the `h1` it belongs to.
 *
 * Nothing is lost by being silent, because the heading carries the meaning and
 * is read first. Note that the status code cannot be leaned on for this the way
 * the root boundary leans on it - see section 0, this route answers 200 - which
 * makes the WORDS the whole of the message and is a further reason to let them be
 * read in order rather than announced over the heading. Tone is never the sole
 * indicator either: the heading and the notice say what happened in words.
 *
 * `empty` was the other candidate and is also wrong. Its centred, dashed
 * treatment is for an absence WITHIN a working view ("no posts match this
 * filter"); its centred text would fight the start-aligned heading above it and
 * the start-aligned action below it, and it takes no leading icon.
 *
 * No `role`, no `aria-live` and no `aria-*` attribute is authored anywhere in
 * this file. That is a positive decision, not an omission: the variant already
 * carries the announcement behaviour, so restating it here would duplicate a
 * decision that has exactly one home and risk a double announcement.
 *
 * ---------------------------------------------------------------------------
 * 6. ONE RECOVERY LINK, AND WHY THERE IS NO SECOND
 *
 * It is a real anchor - `Button asChild` composes @radix-ui/react-slot onto
 * `next/link`, so the rendered element IS the `<a href>` - and that matters more
 * on this page than on most. An `onClick` handler needs a working client bundle;
 * an anchor is honoured by the browser with no JavaScript at all, keyboard
 * activation, middle-click and open-in-new-tab included. The escape route from a
 * 404 must not itself depend on script execution.
 *
 * The feed is the whole of the recovery, because it is the one place a reader who
 * wanted THIS post can find posts that do exist. Its href comes from
 * `feedPath()` rather than a literal `'/'`, so this page cannot disagree with the
 * module that decides what the feed's address is.
 *
 * The root boundary offers a second, sign-in link and this one does not, which
 * is a difference worth defending. That link is there for a visitor who followed
 * a stale link into the authoring area - `/posts/{id}/edit` answers `notFound()`
 * for a post the caller may not see - where signing in genuinely resolves the
 * failure. `/blog/{slug}` is a public reading address: the overwhelming majority
 * of arrivals are readers with no account, for whom a sign-in button is a dead
 * end that dilutes the one action that helps. A second button to the same feed
 * would be a duplicate pretending to be a choice, and anything post-, author- or
 * category-specific needs a request - see section 3.
 *
 * ---------------------------------------------------------------------------
 * 7. WHY THE CLASS STRINGS BELOW ARE PLAIN, AND NOT WRAPPED IN cn()
 *
 * Every class list this file passes IS composed through `cn()` - inside the
 * primitive that receives it. `Card` renders `cn(CARD_BASE, className)` and
 * `CardTitle` renders `cn(CARD_TITLE_BASE, className)`, which is what makes
 * `text-2xl` below replace the primitive's own type step instead of fighting it.
 * `cn()` earns its keep on conditional input and on caller-versus-variant
 * conflicts; wrapping a static literal in it returns that literal unchanged, so
 * an outer call here would be indirection with no effect. Both sibling
 * boundaries - src/app/not-found.tsx and src/app/error.tsx - pass plain strings
 * for the same reason, and matching them keeps the family consistent.
 *
 * ---------------------------------------------------------------------------
 * 8. DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT.
 *
 *   1. A second `<header>`, `<main>` or `<footer>`, or a second `Toaster`.
 *      src/app/layout.tsx owns the shell - html, body, the skip link, the three
 *      providers, SiteHeader, the `<main>` landmark, SiteFooter and the one toast
 *      host - and this file supplies the page body only.
 *   2. `import React from 'react'`. `"jsx": "react-jsx"` means the compiler
 *      imports the JSX runtime itself, so the default import would be unused -
 *      and `npm run lint` runs with `--max-warnings=0`, which makes an unused
 *      import a failed gate rather than a warning.
 *   3. Any `dark:` variant. Every token reached below is dual-valued - declared
 *      at `:root` and again under `.dark` in src/app/globals.css - so each
 *      surface flips with no conditional. A `dark:` class would be a second
 *      source of truth for one decision and would drift.
 *   4. Any literal colour, length, radius, shadow or font size, and any custom
 *      `@media` query. Every value resolves to a token and the only breakpoint
 *      used is the token layer's own `sm`.
 *   5. A sibling `layout.tsx`, `loading.tsx`, `error.tsx` or `opengraph-image.tsx`
 *      in this folder. The root equivalents already cover every one of those
 *      concerns for this segment; a duplicate would be unrequested scope.
 *   6. A `<meta http-equiv="refresh">` or any other automatic redirect to the
 *      feed. It destroys the back button, gives the reader no chance to see what
 *      happened, and turns a clean 404 into a hop search engines read as a soft
 *      404.
 * ========================================================================== */

import { FileX2 } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { JSX } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { feedPath } from '@/lib/seo';

/**
 * The crawl policy this boundary declares for a post that cannot be shown.
 *
 * READ THIS BEFORE CHANGING IT, because the measured behaviour is not the
 * behaviour the convention suggests. Next.js 16.3.0 does NOT collect the
 * `metadata` export of a NESTED `not-found.tsx`. Verified in a browser against
 * the production build, on both the on-demand and the `generateStaticParams`
 * prerendered path: the document title stays the root layout's default rather
 * than becoming `'Post not available'`, and the head carries the framework's own
 * `<meta name="robots" content="noindex">` rather than this export's
 * `noindex, nofollow`. The root `src/app/not-found.tsx`'s identically shaped
 * export DOES take effect, because the unmatched-URL path is a real route
 * (`/_not-found`) and a nested boundary is not.
 *
 * So this export is currently INERT ON THIS ROUTE, and it is kept deliberately
 * rather than deleted, for three reasons:
 *
 *   1. It costs nothing and contradicts nothing. The framework already emits
 *      `noindex` on this path, so the outcome that matters - a missing post is
 *      never indexed - holds either way. This export agrees with it and only
 *      adds `nofollow`.
 *   2. Deleting it would make the file SILENT about crawl policy, and silence is
 *      not neutral: if a later version of the framework starts collecting nested
 *      not-found metadata, or if `page.tsx` ever renders this boundary by a path
 *      that does, the page would inherit the root layout's indexable policy by
 *      default. Declaring the intent is the safe direction to be wrong in.
 *   3. Section 0 of the file header records that this route answers 200 rather
 *      than 404. A `noindex` directive is the only mitigation available from
 *      inside a boundary component, which makes stating it the correct thing for
 *      this file to do even while the framework overrides how it is delivered.
 *
 * The individual fields, on their own terms. `title` is a plain string, so it
 * flows through the title template src/app/layout.tsx declares and stays branded
 * like every other route rather than standing alone. `index: false` keeps the
 * body out of an index. `follow: false` stops the recovery link being read as an
 * endorsement from a page that does not exist - which matters more here than on
 * the root boundary, because a deleted post's URL is exactly the kind of address
 * that keeps being crawled long after it stops resolving.
 *
 * There is deliberately no `alternates.canonical`. A canonical URL is a claim
 * that this address is the preferred version of a real resource, and the whole
 * point of this boundary is that no resource is there. Emitting one would invite
 * a crawler to keep the dead slug in its index as a legitimate page.
 *
 * The description is fixed and cause-agnostic for the reason section 1 of the
 * file header sets out: it is the same for a post that never existed and for a
 * draft the caller may not read, so nothing here distinguishes the two.
 */
export const metadata: Metadata = {
  title: 'Post not available',
  description: 'This post is not available to read.',
  robots: {
    index: false,
    follow: false,
  },
};

/**
 * The `/blog/{slug}` segment's missing-post boundary.
 *
 * Renders inside the site shell, so the header and footer frame it exactly as
 * they frame a post that does exist, and supplies the page body only. Takes no
 * props, holds no state, issues no request, reads no environment variable and
 * reflects nothing from the URL - the page is fixed copy plus one static link.
 *
 * Named `NotFound` for readability. The framework keys on the file name and the
 * default export, never on the function's name.
 *
 * @returns The page body. The surrounding shell is the root layout's.
 */
export default function NotFound(): JSX.Element {
  return (
    // The page's measure, identical to both sibling boundaries on purpose: a
    // reader who follows a dead link should find the panel where the other two
    // put it rather than watch the page shift between failures. `max-w-2xl` is
    // the --container-2xl token, which holds the copy at a readable line length
    // on a wide viewport, and `mx-auto` centres it in the layout's `<main>`,
    // which supplies no measure of its own. `w-full` is what makes the block
    // shrink below that measure instead of standing at it, so a 375px viewport
    // gets the full width minus the inset. The inline padding steps up once at
    // the token layer's `sm` breakpoint - the only breakpoint this file uses - so
    // the card never touches the viewport edge on a phone.
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
      {/*
       * `section` rather than the default `div`: the boundary's copy is a single
       * thematic grouping, headed by the `h1` immediately below it.
       *
       * What this deliberately does NOT do is publish a landmark, and the
       * distinction is worth stating because it is easy to assume otherwise. A
       * `section` is exposed as a `region` landmark ONLY when it carries an
       * accessible name, and a heading inside it does not supply one - the
       * accessible-name algorithm reads `aria-label`, `aria-labelledby` or
       * `title`, never a descendant heading. Measured rather than assumed: an
       * unnamed `section` and an `aria-label`led one were rendered side by side
       * and only the second was queryable as a `region`.
       *
       * So this element is a thematic grouping in the markup and a generic
       * container in the accessibility tree, which is the right outcome here.
       * The shell already publishes `banner`, `main` and `contentinfo`; wrapping
       * the only content of a 404 in a fourth landmark would lengthen the
       * landmark list without giving a reader anywhere new to go. No
       * `aria-labelledby` is authored, per the rule that ARIA appears only where
       * native semantics fall short.
       */}
      <Card as="section">
        <CardHeader>
          {/* The single h1 of this page, and the only component in the system
              that can be one - see section 4 of the file header. `text-2xl`
              overrides the primitive's default type step because this is a page
              heading rather than a card heading inside a feed; both values are
              --text-* tokens. */}
          <CardTitle as="h1" className="text-2xl">
            Post not available
          </CardTitle>
        </CardHeader>

        <CardContent>
          {/*
           * `info` selects a neutral tone AND silence - no live-region role - so
           * the notice is read in document order after the heading rather than
           * announced over it on load. Section 5 of the file header records why
           * `destructive` would be wrong here even though this is a 404.
           *
           * The icon is the first child, as the primitive's leading-icon slot
           * requires, and carries no size class because the primitive positions
           * and sizes whatever `svg` it finds there. It is hidden from assistive
           * technology because the heading and the notice already carry the
           * meaning; an announced glyph would only repeat them.
           */}
          <Alert variant="info">
            <FileX2 aria-hidden="true" />
            <AlertTitle>Nothing is published at this address</AlertTitle>
            <AlertDescription>
              A post keeps the address it was published at, so a link that once worked goes on
              working. This one no longer resolves to anything you can read: the post may have been
              deleted, or taken back to draft by its author, or the address may have lost characters
              on its way to you. Reloading will not change the answer.
            </AlertDescription>
          </Alert>
        </CardContent>

        {/* Already a wrapping row with a token gap, so the action sits clear of
            the notice above it without a margin between siblings. */}
        <CardFooter>
          {/*
           * The whole of the recovery. `asChild` renders a real anchor, so it
           * navigates with no working client bundle, and `feedPath()` keeps the
           * address in step with the module that owns it. The label names the
           * destination and what is there rather than the gesture - never "click
           * here", and never a bare "Home", which would not tell a reader who
           * came for an article that they will find others.
           */}
          <Button asChild>
            <Link href={feedPath()}>Browse published posts</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
