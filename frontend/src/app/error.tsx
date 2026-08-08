'use client';

// error.tsx - the root error boundary, and the last thing standing between a
// visitor and a blank page.
//
// Next.js wraps every route segment beneath src/app/layout.tsx in this
// component. Anything that throws while that subtree renders - a Server
// Component's data fetch, a Client Component's event handler, a render-time
// type error - lands here instead of tearing the document down. The most
// concrete case in this application is the home feed: src/app/page.tsx lets a
// failed posts request PROPAGATE rather than swallowing it (it degrades
// gracefully only on the categories request, which is decoration), so a backend
// or network outage renders this file.
//
// ---------------------------------------------------------------------------
// 1. 'use client' IS MANDATORY, AND MUST BE THE FIRST LINE
//
// Not a style choice and not optional. An error boundary is a client-side React
// mechanism: `reset` is a function the framework passes in so the segment can be
// re-rendered in place, and a Server Component cannot receive or invoke one.
// Next.js therefore requires the directive on this convention file and the build
// fails without it. It must also come before every import and every comment that
// is not a comment - a directive prologue stops being a directive the moment a
// statement precedes it. Of the root segment's three boundary files this is the
// only one that carries it: loading.tsx and not-found.tsx render on the server.
//
// ---------------------------------------------------------------------------
// 2. THIS FILE LEAKS NOTHING. THE MOST IMPORTANT RULE HERE.
//
// `error.message` and `error.stack` are NEVER rendered, and neither is any field
// of the API's problem document. A server-side exception message routinely
// carries a database connection string, an internal hostname, a SQL fragment or
// an absolute path from the container filesystem, and this boundary catches
// server-render failures - so displaying the message would publish those to
// whoever triggered the error. In production Next.js already redacts the message
// it hands a client boundary, but relying on that is relying on a framework
// default to be a security control; the copy below is fixed text that cannot
// contain a secret no matter what threw.
//
// What IS surfaced is `error.digest` - an opaque hash Next.js computes from the
// original error and writes to the SERVER log alongside the real stack. It is
// the correlation key between what the visitor saw and what the operator can
// read, which is this file's whole contribution to the day-one observability
// standard: the backend owns structured logging with request correlation, and a
// digest a visitor can quote is what joins a report to a log line. It is
// rendered ONLY when present, because an empty "Support reference:" line is
// worse than no line at all.
//
// A single console.error in an effect gives a developer the real object in
// devtools without putting one character of it on the screen. It is in an effect
// rather than in the render body deliberately: the body re-runs on every
// re-render, an effect keyed on `error` runs once per distinct error. No
// telemetry SDK, no error-tracking backend and no analytics call belongs here -
// all three are explicitly out of scope for this project, and an error boundary
// that reaches for the network can itself fail.
//
// ---------------------------------------------------------------------------
// 3. WHY THE HEADING COMES FROM CardTitle AND NOT FROM AlertTitle
//
// This page owns its single h1, and there is exactly one element in the design
// system that can render it: `CardTitle` takes `as="h1"` because heading level
// is a property of the PAGE, which only the page knows. `AlertTitle`'s `as`
// union deliberately EXCLUDES h1 - an alert is a notice that may appear anywhere
// in a document, so letting it be the top-level heading would corrupt the
// outline of any page that rendered one. Hence the composition below: the Card
// supplies the page heading and a comfortable measure, the Alert supplies the
// notice.
//
// No `role` and no `aria-live` attribute is authored anywhere in this file, and
// that is a positive decision rather than an omission. `Alert` derives its
// live-region role from its variant - `destructive` becomes role="alert", every
// other variant becomes role="status" - so choosing the destructive variant IS
// choosing the assertive announcement. Restating it here would risk a double
// announcement and would duplicate a decision that already has one home.
//
// ---------------------------------------------------------------------------
// 4. THE TWO CONTROLS, AND WHY RETRY IS `refresh()` THEN `reset()`
//
// Retry is a real <button> (rendered by `Button`, the one file permitted to
// write that element) and it is the entire reason this file is a client
// component. What it must NOT be is a bare `reset()` call, and that is worth
// spelling out because `reset()` on its own is the obvious spelling and it does
// not work for the failure this boundary exists to catch.
//
// Measured against the installed framework rather than assumed. In Next.js
// 16.3.0, node_modules/next/dist/client/components/error-boundary.js declares:
//
//     this.reset = () => { this.setState({ error: null }); };
//     this.retry = () => {
//       startTransition(() => { this.context?.refresh(); this.reset(); });
//     };
//
// `reset()` clears the boundary's own state and nothing else. It then re-renders
// `this.props.children` - and for a SERVER-COMPONENT render failure those
// children are the already-errored RSC payload the client is still holding, so
// they throw again on the spot. Verified in a browser against a one-shot fault
// that had already cleared itself and a server that was demonstrably healthy
// (a direct request returned the real page): three clicks of a bare-`reset()`
// button produced three boundary remounts, ZERO server round-trips, and the
// error still on screen. The boundary replaces itself with itself, for ever.
//
// The missing half is the refetch. Wrapping `router.refresh()` and `reset()` in
// one `startTransition` reproduces the framework's own `retry` exactly: the
// refresh re-requests the segment from the server, the transition keeps both in
// a single update so the error is not cleared before the fresh payload lands,
// and the re-render then has something new to render. Verified in the same
// session: `refresh()` alone correctly leaves the boundary up (only `reset()`
// clears the error), and `refresh()` followed by `reset()` recovered the page on
// the first attempt - in place, with the JavaScript context intact and no
// document navigation.
//
// `router.refresh()` is the framework's segment refetch, not an application
// request: this file still performs no `fetch`, imports no API client and reads
// no response. It also cannot loop, because it runs only from a click.
//
// ONE COST, STATED SO IT IS NOT A SURPRISE. `useRouter()` throws "invariant
// expected app router to be mounted" when there is no App Router context, which a
// real application always has - the framework's own error boundary reads that same
// context - but a component test does not. So a test for this file must wrap it:
//
//     import { AppRouterContext } from
//       'next/dist/shared/lib/app-router-context.shared-runtime';
//     render(
//       <AppRouterContext.Provider value={mockRouter}>
//         <RootError error={error} reset={reset} />
//       </AppRouterContext.Provider>,
//     );
//
// That is worth the price: a mocked `refresh` is also how a test asserts the
// refetch happens at all, which is the half a bare `reset()` silently omits.
//
// The escape route is `Button asChild` over `next/link`, which renders a real
// anchor. That matters precisely here: if the thing that is broken is the client
// bundle itself, an onClick handler may never run, but an <a href> is honoured
// by the browser with no JavaScript at all. Semantics follow behaviour - the
// control navigates, so it is a link that looks like a button rather than a
// button that navigates.
//
// ---------------------------------------------------------------------------
// 5. DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT.
//
//   1. A `metadata` export. A Client Component cannot export one; TypeScript and
//      the build both reject it. The document title while this renders is the
//      one the root layout's template already supplies.
//   2. A sibling global-error.tsx. It is absent from the plan's file inventory on
//      purpose, and the consequence is worth stating honestly rather than
//      discovering later: this boundary does NOT catch an exception thrown by the
//      root layout itself, because it renders INSIDE that layout. That is an
//      acceptable trade here - src/app/layout.tsx fetches no data and reads no
//      environment variable, so it has essentially no failure surface - and
//      adding global-error.tsx would mean maintaining a second, standalone
//      <html> document that duplicates the shell and the token layer.
//   3. Any `fetch`, any `@/lib/api/*` wrapper, any `process.env` read, and any
//      data-driven recovery attempt. A boundary that fetches can itself throw,
//      and then there is nothing left to catch it. Asking the router to re-render
//      the segment is the recovery mechanism; issuing the request, and deciding
//      what its failure means, remain the segment's job, not the boundary's.
//   3a. The framework's third prop, `retry`. It is passed alongside `error` and
//      `reset` and does precisely what section 4 does by hand, so taking it would
//      be shorter - but the prop contract for this file is fixed at `error` and
//      `reset`, and widening it to depend on a prop the framework added recently
//      would couple this file to a newer surface for no behavioural gain. The
//      local spelling is explicit about what a retry actually costs, and it is
//      the documented recipe for any App Router version that has `useRouter`.
//   4. `ApiError` from the API client or the problem-document type from the
//      contract types, imported to "improve" the message. The normalised problem
//      document exists for programmatic handling at the CALL SITE, where the code
//      knows which request failed and what a 409 would mean. Here, the thrown
//      value could be anything at all, so a switch on its shape would be a guess
//      dressed as precision - and every branch of it would risk rendering server
//      detail. Fixed copy is both safer and more honest.
//   5. `import React from 'react'`. `"jsx": "react-jsx"` means the compiler
//      imports the JSX runtime, so the default import would be unused - and
//      `npm run lint` runs with --max-warnings=0, which turns an unused import
//      into a failed gate rather than a warning.
//   6. Any `dark:` variant. Every token below is dual-valued - declared once at
//      the document root and again under `.dark` in src/app/globals.css - so
//      every surface here flips with no conditional. A `dark:` class would be a
//      second source of truth for the same decision and would drift.
//   7. Any literal colour, length, radius or font size, and any `@media` query.
//      Every value resolves to a token; the destructive treatment comes from
//      `--color-danger` through the Alert's variant, never from a literal red.
//      The only breakpoint used is the token layer's own `sm`.
//   8. A second <header>, <main> or <footer>. The root layout owns the shell and
//      this file supplies only the page body, so the site header and footer frame
//      it exactly as they frame every other route.
//   9. A modal, a menu, a tab set or any other behavioural primitive. Nothing
//      here needs focus trapping or roving focus: two controls in the normal tab
//      order, each with the focus ring the token layer already guarantees.
//  10. A retry counter, a countdown or an automatic re-render. An error boundary
//      that retries itself on a timer turns one failed request into a loop
//      against an already-struggling service. The visitor decides.

import { startTransition, useEffect, type JSX } from 'react';

import { TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Props Next.js passes to a route segment's error boundary.
 *
 * Fixed by the framework, so this shape is a contract rather than a choice: it
 * is stated exactly as the App Router declares it and is deliberately not
 * widened, renamed or extended. Declared locally and not exported, matching the
 * convention across `src/components/ui/` - a consumer that needs the type writes
 * `ComponentProps<typeof RootError>` and so cannot drift from the real surface.
 */
interface RootErrorProps {
  /**
   * The value that was thrown, normalised to an `Error` by React.
   *
   * `digest` is the only member this component reads. It is an opaque hash that
   * Next.js derives from the original error and records in the server log next
   * to the real message and stack; it is present for an error thrown during a
   * server render and absent for one thrown in the browser, which is why every
   * use of it below is guarded.
   *
   * `message` and `stack` are never read. See section 2 of the file header.
   */
  error: Error & { digest?: string };

  /**
   * Clears this boundary's error state, so the segment it wrapped renders again
   * in place and without a full page load. Supplied by the framework.
   *
   * On its own it does NOT refetch, so for a server-render failure it re-renders
   * the payload that already threw. The primary control below therefore pairs it
   * with a router refresh inside one transition - see section 4 of the file
   * header for the measurement that settled this.
   */
  reset: () => void;
}

/**
 * The root segment's error boundary.
 *
 * Rendered by Next.js in place of any route beneath `src/app/layout.tsx` that
 * throws while rendering, so it appears inside the site shell with the header and
 * footer still framing it. Named `RootError` rather than `Error` so that the
 * global `Error` type referenced by {@link RootErrorProps} is not shadowed by a
 * declaration in this module; the framework keys on the file name and the default
 * export, never on the function's name.
 *
 * What the visitor gets: one page heading, a destructive notice saying what
 * happened in fixed terms, an opaque support reference when one exists, a control
 * that genuinely re-requests and re-renders the segment, and a link back to the
 * home feed that works even with no working client bundle. What the visitor never
 * gets is one character of the thrown value.
 *
 * This component holds no state, reads no environment variable, issues no request
 * of its own and makes no decision based on the shape of the error - the only
 * thing it inspects is whether `digest` exists.
 *
 * @param error - The thrown value; only `digest` is read. @see {@link RootErrorProps}
 * @param reset - Framework callback that clears this boundary's error state.
 * @returns The page body. The surrounding shell is the root layout's.
 */
export default function RootError({ error, reset }: RootErrorProps): JSX.Element {
  const router = useRouter();

  // Put the real object in the developer console once per distinct error, so it
  // is inspectable in devtools while none of it reaches the screen. Keyed on
  // `error` rather than left dependency-free so that a second, different failure
  // after a retry is logged too; in an effect rather than in the render body so
  // that a re-render does not repeat the entry.
  useEffect(() => {
    console.error(error);
  }, [error]);

  /**
   * Re-requests the failed segment, then clears the error so the fresh result
   * renders. Both halves are required and the order matters: `reset()` alone
   * re-renders the payload that already threw, and `router.refresh()` alone
   * leaves the boundary up because only `reset()` clears the error state.
   *
   * `startTransition` keeps them a single update, so the boundary is never torn
   * down for the instant before the new payload arrives. This is exactly what the
   * framework's own `retry` does; section 4 of the file header records the
   * measurement behind it.
   */
  const retry = () => {
    startTransition(() => {
      router.refresh();
      reset();
    });
  };

  return (
    // The page's measure. `max-w-2xl` is the --container-2xl token, which keeps
    // the copy at a readable line length on a wide viewport, and `mx-auto`
    // centres it in whatever main element the layout provides. The inline padding
    // steps up once at the token layer's `sm` breakpoint - the only breakpoint
    // this file uses - so the card never touches the viewport edge on a phone.
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
      <Card>
        <CardHeader>
          {/* The single h1 of this page. `text-2xl` overrides the primitive's
              default type step, because this is a page heading rather than a card
              heading inside a feed - both values are --text-* tokens. */}
          <CardTitle as="h1" className="text-2xl">
            Something went wrong
          </CardTitle>
        </CardHeader>

        {/* A column with a token gap, so the reference line spaces itself off the
            notice without a margin between siblings - and so that the gap
            disappears with it when no digest is present. */}
        <CardContent className="flex flex-col gap-4">
          {/*
           * `destructive` selects both the tone (--color-danger on the recessed
           * surface token) and, inside the primitive, role="alert" - which is why
           * no ARIA is written here. The icon is the first child, as the
           * primitive's leading-icon slot requires, and is hidden from assistive
           * technology because the title and description already carry the
           * meaning; an announced glyph would only repeat them.
           */}
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>We could not load this page</AlertTitle>
            <AlertDescription>
              The content for this page did not finish loading. That is usually temporary, so trying
              again often works. If it keeps happening, the home feed is one click away.
            </AlertDescription>
          </Alert>

          {/*
           * Rendered only when the framework actually supplied a digest. The
           * ternary yields null rather than an empty fragment so nothing at all
           * reaches the DOM in the common client-side case, and the label says
           * plainly what the string is for. `code` is the right element for an
           * opaque machine identifier, and the paragraph inherits the token
           * layer's overflow-wrap floor, so a long hash wraps instead of forcing
           * the document into horizontal scroll.
           */}
          {error.digest ? (
            <p className="text-muted-foreground text-xs">
              Support reference: <code className="font-mono">{error.digest}</code>. Quote it if you
              report this problem.
            </p>
          ) : null}
        </CardContent>

        {/* Already a wrapping row with a token gap, so at narrow widths the two
            controls stack instead of overflowing the card. */}
        <CardFooter>
          {/*
           * The primary action, and the reason this file is a Client Component.
           * `retry` is a local zero-argument callback, so the click event is not
           * forwarded into anything whose contract does not take one.
           */}
          <Button onClick={retry}>Try again</Button>

          {/*
           * The escape route. `asChild` makes this a real anchor, so navigation
           * survives a broken client bundle; `secondary` keeps the retry control
           * the visually primary one.
           */}
          <Button asChild variant="secondary">
            <Link href="/">Back to the home feed</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
