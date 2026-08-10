// =============================================================================
// src/app/(auth)/layout.tsx - the CENTRED CREDENTIAL SHELL for the (auth) route
// group.
//
// One of exactly three files in this group: this shell, login/page.tsx (served
// at /login) and signup/page.tsx (served at /signup). It discharges the shell
// half of AAP requirement R1 - "Users can sign up, log in" - and AAP §0.4.5.2
// and §0.7.1.9 both name it the "Centred authentication shell".
//
// Nothing on the source branch preceded it. The repository at commit ee93457
// tracked two files - app.py, a fifty-line in-memory FastAPI demo, and a
// three-line README - so there was no frontend tree, no stylesheet, no
// component and no convention to inherit. Every value below is authored fresh
// against the token layer and the surrounding files' declared interfaces.
//
// ---------------------------------------------------------------------------
// 1. WHERE THIS FILE RENDERS, WHICH DECIDES ALMOST EVERYTHING BELOW
//
// src/app/layout.tsx owns the document. It emits the html and body elements,
// the skip-navigation link, the three client providers, the banner and
// contentinfo landmarks, the one toast host, and a single `main` landmark that
// carries `flex-1 scroll-mt-16` and nothing else - no padding, no measure, no
// grid - because each page owns its own layout.
//
// This shell therefore renders INSIDE that `main` element, and two consequences
// follow directly:
//
//   * It must add no second document structure and no second landmark. A
//     nested html, body, banner, main or contentinfo element is invalid nesting,
//     and a duplicate landmark is a genuine regression for someone navigating
//     by landmark rather than a cosmetic one. So the wrapper below is a plain
//     div - a `section` would need an accessible name to be worth having, and
//     naming a region whose only job is centring would add noise to the
//     accessibility tree, not information.
//   * It must supply the inline padding and the measure itself, because the
//     element it renders into supplies neither. That is what section 4 is.
//
// ---------------------------------------------------------------------------
// 2. WHY THIS IS THE GROUP'S ONLY METADATA SITE
//
// Both child pages are interactive validated credential forms, and both are
// client components by mandate. A client component cannot export `metadata` or
// `generateMetadata` - the build rejects it outright - and the plan's file
// inventory contains no login/layout.tsx and no signup/layout.tsx, so neither
// route can acquire a metadata site of its own.
//
// This file is consequently the single metadata site for the whole group, and
// /login and /signup legitimately share one title. That is a real constraint
// rather than an oversight, and the two workarounds that suggest themselves are
// both worse: a per-route layout is a file the plan does not have, and wrapping
// each form in a server component to host its metadata would move the form's
// state and its resolver out of the component that owns them. The title chosen
// below therefore names BOTH routes instead of favouring one, so that whichever
// screen a visitor is on, the browser tab describes what they are looking at.
//
// ---------------------------------------------------------------------------
// 3. WHAT THIS SHELL RENDERS, AND THE ONE THING IT DELIBERATELY DOES NOT
//
// A wrapper, one link home, and the matched page. That is the whole component.
//
// It renders NO panel of its own, and that is the load-bearing decision in this
// file rather than a minimal-effort one. Each child page composes its own
// complete panel from `@/components/ui/card` - the base variant there is
// `rounded-xl border border-border bg-surface text-foreground shadow-sm`. Two
// failure modes are avoided by leaving it to them:
//
//   * A shell that opened a panel and expected each page to supply its named
//     inner parts would be an implicit contract with nothing to enforce it. The
//     three files in this group are authored independently, so the first page
//     that composed its own panel would nest one panel inside another - visibly
//     doubled border, doubled shadow, doubled padding.
//   * A shell that painted a surface would also have to decide the panel's
//     radius, hairline and elevation, which is exactly the decision the card
//     primitive exists to own once.
//
// A shell that renders only the centring and measure wrapper is correct whether
// a page brings a panel or not, which is why this one does.
//
// It renders NO heading either. The accessibility floor is one h1 per page with
// ordered levels beneath it, and each child page owns that h1 as its panel's
// title. A heading here would either duplicate that one or open a level out of
// order on both routes at once.
//
// ---------------------------------------------------------------------------
// 4. THE MEASURE, THE PADDING AND THE 375px CASE
//
// AAP §0.9.4.5 asserts no horizontal overflow at any width, and the end-to-end
// suite exercises this group at 375, 768 and 1440 pixels - the three viewport
// projects frontend/playwright.config.ts declares. The wrapper satisfies all
// three with four utilities and one breakpoint variant; see {@link AUTH_SHELL}
// for the per-utility reasoning.
//
// The measure is `max-w-md`, the token engine's `--container-md` step (28rem).
// It is a deliberately small step: a credential form is two or three fields, so
// a wider measure would leave the fields stretched across a desktop viewport
// with the label a long way from the input it names. No width is hand-written -
// the container scale is where a measure comes from.
//
// The only breakpoint used is `sm` (40rem), reached through the engine's own
// variant. No media query is authored anywhere in this tier by design, and the
// five catalogued breakpoints are the entire responsive vocabulary.
//
// ---------------------------------------------------------------------------
// 5. DARK MODE COSTS THIS FILE NOTHING, AND THAT IS THE POINT
//
// Every colour below is a semantic token - `text-muted-foreground` and
// `text-foreground` - and each is declared twice in the tier's only stylesheet:
// once at the document root and once under the dark selector. So the shell
// re-themes with no conditional logic, no `dark:` variant and no second source
// of truth. A `dark:` class written against a primitive colour family would be
// the defect, not the feature: it would decide the same thing in a second
// place, and only one of the two would be updated when the palette changes.
//
// ---------------------------------------------------------------------------
// 6. DELIBERATELY ABSENT. EVERY ENTRY LOOKS LIKE AN IMPROVEMENT.
//
//   1. The client directive. This shell holds no state, no event handler and no
//      browser API, and adding the directive would make the `metadata` export
//      in section 2 illegal - which, per that section, would leave the whole
//      group with no metadata site at all.
//   2. A default React import. tsconfig.json sets `"jsx": "react-jsx"`, so the
//      compiler imports the JSX runtime itself; the import would be unused, and
//      `npm run lint` runs with `--max-warnings=0`, which turns an unused
//      import into a failed gate rather than a warning. The React types needed
//      here arrive through a type-only import that is erased at compile time.
//   3. An import of the tier's stylesheet, or any other stylesheet. The root
//      layout is its sole importer and the tokens are already in scope for the
//      whole tree; a second import would duplicate it. There is no second
//      stylesheet in this tier and none may be added.
//   4. A remount of any provider, or a second toast host. The theme, query-cache
//      and session providers are each mounted exactly once by the root layout.
//      Mounting the session one again here would create a second, divergent
//      credential context and silently break the session hook in both child
//      pages - the failure would look like "sign-in succeeded but the header
//      still says signed out", with nothing erroring.
//   5. Any environment read. Site identity is `@/lib/seo`'s, which is the tier's
//      only reader of NEXT_PUBLIC_SITE_URL and NEXT_PUBLIC_SITE_NAME, and the
//      API base URL is `@/lib/api/client`'s. Those three are the only variables
//      this tier has, and they are public by construction - the NEXT_PUBLIC_
//      prefix inlines each into the client bundle. Nothing from the service's
//      side of `.env.example` - the connection string, the token signing key,
//      the seeded administrator's credential - is named anywhere in this tier,
//      and a secret is not something a browser bundle can keep.
//   6. Anything from `@/lib/api/*`, any fetch, and the session hook. A shell
//      renders on both routes, so a request here would be paid twice for
//      something neither screen needs before the visitor submits. Credential
//      logic belongs to the pages.
//   7. Any reference to `searchParams`, and to the `next` parameter in
//      particular. A layout in the App Router is not handed search parameters
//      at all. src/middleware.ts redirects an unauthenticated visitor to
//      /login?next=<encoded path> and login/page.tsx alone honours and
//      validates that value; a shell that tried to read it would be reaching
//      for something it is not given.
//   8. A parenthesised path, anywhere. `(auth)` is a filesystem grouping
//      directory and its name is ERASED from the URL, so the routes served are
//      /login and /signup. A link written from the directory name compiles,
//      type-checks, lints and renders, and fails only at run time as a 404.
//   9. A password-reset link, an email-verification notice, or a "Continue
//      with ..." federation button. AAP §0.9.3 considered password reset,
//      transactional email and third-party identity federation (OAuth, OIDC,
//      SAML, social login) and excluded all of them. An affordance for a
//      capability the product does not have is worse than its absence: it is a
//      dead end a locked-out visitor will try first.
//  10. A raw button, input, textarea, select or table, an inline style, an
//      `!important`, an id selector, or a hand-rolled focus trap or
//      click-outside handler. This shell needs no control of its own beyond one
//      anchor, and there is nothing here to trap focus inside.
//  11. Any literal colour, length, radius, shadow or font size, and any
//      arbitrary-value utility carrying a raw measurement. Every value resolves
//      to a token or to a step on one of the engine's own scales.
//  12. Anything from the retired demo surface. AAP §0.9.4.3 requires the old
//      collection route, its Pydantic model and that model's three-field shape
//      absent from the delivered frontend, and this file names none of the
//      three - not even to say so, which is why they are described rather than
//      spelled here. The one substring a naive grep for that surface would
//      still match below is the token engine's `items-center` alignment
//      utility: a CSS property name, not a reference to anything retired, and
//      the same utility the header's brand mark, the pagination control and the
//      dialog's close control already use.
// =============================================================================

import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { JSX, ReactNode } from 'react';

import { feedPath, resolveSiteName } from '@/lib/seo';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Metadata
 * ---------------------------------------------------------------------------------------------- */

/**
 * Metadata for every route in the `(auth)` group - which is to say for `/login` and `/signup` both.
 *
 * Section 2 of the header records why this is the only place in the group that can declare it, and
 * why one shared title is the correct outcome rather than a compromise.
 *
 * `title` is a plain string, so it flows through the title template the root layout declares and
 * renders as `<segment> | <site name>`. That is the whole reason it is a plain string: writing an
 * absolute title here would brand this group differently from every other route, and restating the
 * site name would render it twice. `metadataBase` is likewise absent - `@/lib/seo` owns it, and a
 * second declaration is a second thing to keep in step for no gain. No absolute URL is built by
 * hand anywhere in this file.
 *
 * `robots` is the substantive half, and it is deliberately `noindex, follow`:
 *
 *   * `index: false` matches a position `src/app/sitemap.ts` already takes, and states the same
 *     thing at the other layer. That file withholds `/login` and `/signup` because they are
 *     "public and perfectly crawlable; they simply are not content" - a credential form has nothing
 *     to rank for, so advertising it spends crawl budget that belongs to the articles. Keeping the
 *     pair out of an index is the consistent counterpart to keeping them out of the sitemap: a page
 *     not worth advertising is not worth ranking either.
 *   * `follow: true`, not `false`. This shell links home and each page links to its sibling, and
 *     those are ordinary internal links to content that IS worth ranking. `nofollow` would ask a
 *     crawler to discard link equity that legitimately flows back to the feed, which is a different
 *     and unintended instruction. This is the one place this group's policy diverges from
 *     `src/app/not-found.tsx`, which uses `follow: false` because its links come from a page that
 *     does not exist.
 *
 * None of this contradicts `src/app/robots.ts`. That file serves `/robots.txt` and answers a
 * different question - which URLs a crawler should not FETCH - and it disallows only the protected
 * `/dashboard`, `/posts` and `/admin` families. A robots policy says what must not be fetched; a
 * meta directive says what must not be indexed; a sitemap says what is worth fetching first. The
 * three are not complements of one another, and `/login` being fetchable, unindexed and unadvertised
 * is one coherent position rather than three inconsistent ones.
 *
 * No `alternates.canonical`: a canonical URL claims that this address is the preferred version of a
 * real resource, and a credential form describes no resource. The root metadata declares none
 * either, for the same reason, so there is nothing here to override.
 */
export const metadata: Metadata = {
  title: 'Sign in or create an account',
  description:
    'Sign in to publish and manage your posts, or create an account to join the conversation.',
  robots: {
    index: false,
    follow: true,
  },
};

/* -------------------------------------------------------------------------------------------------
 * Class tables
 *
 * Declared as module constants so the markup below reads as structure rather than as a wall of
 * utilities, and composed through `cn` so a later class always resolves last-wins within its own
 * Tailwind group instead of being decided by stylesheet source order. Every value is a semantic
 * token from the tier's stylesheet or a step on one of the engine's own scales; there is not one
 * literal length, colour, radius or shadow among them.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The credential shell: a centred, measure-constrained column.
 *
 * Every utility is load-bearing, and the 375px case is what makes most of them so:
 *
 *   * `mx-auto` centres the column inside the `main` element the root layout provides. That element
 *     spans the viewport and supplies no measure of its own, so centring is this file's job.
 *   * `w-full` is what makes the block SHRINK below the cap rather than standing at it. Without it a
 *     `max-width` alone leaves the column at its content width, and the panel would sit narrow and
 *     off-centre on a phone.
 *   * `max-w-md` is the `--container-md` token (28rem). Section 4 records why a small step is right
 *     for a credential form. Paired with `w-full`, a 375px viewport gets the full width minus the
 *     inline inset - no horizontal overflow at any width, which the responsive criteria require.
 *   * `flex flex-col` stacks the home link above the page's own panel, and `gap-6` spaces the two
 *     without a margin on either. Using `gap` rather than a sibling margin matters here because the
 *     child is supplied by whichever page matched: a margin declared on `{children}` is not this
 *     file's to declare, and a margin on the link would collapse differently depending on what the
 *     page rendered first.
 *   * `px-4 sm:px-6` is the inline inset every full-width surface in this tier uses - the two shell
 *     components and both root boundaries share it - so the panel lines up with the header and
 *     footer above and below it instead of ending somewhere of its own.
 *   * `py-12 sm:py-16` is the vertical breathing room. It steps up once at the token layer's `sm`
 *     breakpoint (40rem) because a phone should spend its scarce vertical space on the form, while a
 *     larger viewport otherwise leaves the panel pinned high under the header.
 *
 * Nothing here paints a surface, a hairline or an elevation. Section 3 records why that is the
 * decision rather than an omission.
 */
const AUTH_SHELL = cn('mx-auto flex w-full max-w-md flex-col gap-6', 'px-4 py-12 sm:px-6 sm:py-16');

/**
 * The group's one route back to the reading experience.
 *
 * A real anchor through `next/link`, never a click handler: the browser honours an `href` with no
 * JavaScript executed at all, and a visitor who has landed on a credential screen by accident
 * should not need a working client bundle to leave it.
 *
 *   * `inline-flex ... items-center gap-2` sets the glyph beside the label on one baseline. `gap-2`
 *     rather than a margin on the glyph, for the same reason the shell uses `gap`.
 *   * `w-fit` is load-bearing and easy to omit. A flex column stretches its children by default, so
 *     without it this anchor would be as wide as the whole measure and a click far to the right of
 *     the text - over empty space - would navigate away from a half-filled form. Constraining it to
 *     its content makes the hit area match what a reader can see.
 *   * `min-h-11` gives the anchor a 44px activation height, clearing the WCAG 2.5.5 target-size
 *     floor that a `text-sm` line box alone would miss. No design source specifies a smaller target
 *     for this control, so the floor applies - the same reasoning the header's brand mark records.
 *   * `text-muted-foreground` at rest, promoted to `text-foreground` on hover. This is secondary
 *     navigation on a screen whose primary action is the form, and both tokens clear 4.5:1 in both
 *     themes, so "secondary" is a matter of emphasis rather than of legibility.
 *   * `hover:underline` accompanies the colour change so the affordance is never carried by colour
 *     alone. Tailwind already scopes `hover:` to `@media (hover: hover)`, so neither can stick on a
 *     touch device after a tap.
 *   * The transition is gated on `motion-safe:`, the engine's own
 *     `prefers-reduced-motion: no-preference` query, at the 150ms this tier uses everywhere. A
 *     visitor who has asked for less motion gets the colour change instantly rather than not at all.
 *   * `rounded-md` exists to SHAPE a ring, not to draw one: the tier's stylesheet declares a
 *     document-wide `:focus-visible` outline in `--color-ring`, so this anchor already has a visible
 *     keyboard indicator and restating it here would only create a second place to change it.
 *     `:focus-visible` rather than `:focus` is what keeps the ring for keyboard users without
 *     flashing it on every mouse click.
 */
const HOME_LINK = cn(
  'inline-flex min-h-11 w-fit items-center gap-2 rounded-md',
  'text-sm font-medium text-muted-foreground',
  'hover:text-foreground hover:underline',
  'motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out',
);

/**
 * The glyph inside {@link HOME_LINK}.
 *
 * `size-4` is a step on the spacing scale, matched to the `text-sm` label beside it. `shrink-0`
 * keeps the glyph at that size when a long site name wraps the label, rather than letting the flex
 * algorithm squeeze the icon instead of the text.
 *
 * It is decorative and says so with `aria-hidden` at the call site. The anchor's accessible name is
 * its visible text, which is real content rather than an invented attribute - so a screen reader
 * announces "Back to <site name>, link" and never reads the arrow.
 */
const HOME_LINK_ICON = 'size-4 shrink-0';

/**
 * Leading half of the home link's visible text, completed by the resolved site name.
 *
 * So the anchor reads "Back to Modern Blog" rather than "Back" or, worse, "click here". The
 * accessible name is that same string - the visible text IS the name - and it has to make sense
 * read out of context, which is how a screen reader's list of links presents it.
 *
 * Composed into ONE string in the component body rather than rendered as two adjacent expressions.
 * Two expressions produce two DOM text nodes, and while the accessible-name algorithm concatenates
 * them correctly, a single node is what makes the name unambiguous to read, to query in a test and
 * to select in the browser.
 */
const HOME_LINK_LABEL_PREFIX = 'Back to ';

/* -------------------------------------------------------------------------------------------------
 * Component
 * ---------------------------------------------------------------------------------------------- */

/** Props for {@link AuthLayout}. */
interface AuthLayoutProps {
  /**
   * The matched credential page, supplied by the framework: `login/page.tsx` at `/login` or
   * `signup/page.tsx` at `/signup`.
   *
   * Rendered exactly once and never gated behind a condition. Typed as `ReactNode` through a
   * type-only import rather than reached for as a member of a default React import, because
   * `"jsx": "react-jsx"` makes that import unused and the lint gate rejects an unused import.
   */
  readonly children: ReactNode;
}

/**
 * The shared shell for the `(auth)` route group: a centred, measure-constrained column carrying one
 * route home above whichever credential page matched.
 *
 * A Server Component, deliberately and permanently - see section 6, entry 1. It holds no state,
 * registers no handler, touches no browser API, issues no request, reads no environment variable of
 * its own and reflects nothing from the URL. Its entire output is a wrapper, one anchor and the
 * page beneath it, which is why it can carry the group's metadata at all.
 *
 * Named `AuthLayout` for readability; the framework keys on the file name and the default export,
 * never on the function's name.
 *
 * @param props - See {@link AuthLayoutProps}.
 * @returns The centred column: the route home, then the matched page. The surrounding document,
 * its landmarks and its providers are all the root layout's.
 * @throws {Error} When NEXT_PUBLIC_SITE_NAME is unset or blank, propagated from `resolveSiteName()`.
 * Deliberate rather than defended against: an unbranded link reading "Back to " would ship a
 * placeholder to readers, and the error names the variable and points at the configuration
 * contract. It adds no new failure mode either - the header and footer the root layout mounts on
 * every route already resolve the same value, so nothing could have rendered without it.
 */
export default function AuthLayout({ children }: AuthLayoutProps): JSX.Element {
  // Resolved per render rather than at module scope, matching the two shell components: a value
  // read at module scope is fixed at the first import, and this one belongs to the request.
  const siteName = resolveSiteName();

  /** One text node, for the reason {@link HOME_LINK_LABEL_PREFIX} records. */
  const homeLinkLabel = `${HOME_LINK_LABEL_PREFIX}${siteName}`;

  return (
    <div className={AUTH_SHELL}>
      {/*
       * The group's share of the route back to `/`. Addressed through `feedPath()` rather than a
       * literal, so this shell cannot disagree with the header's brand mark or the footer's home
       * link about what the feed's address is; called with no argument, it omits every default and
       * returns the bare root, and it reads no environment variable so it cannot throw.
       *
       * The login-to-signup cross-link is NOT here. Each page alone knows which sibling it should
       * point at, and login/page.tsx must carry the `next` parameter across when it does - see
       * section 6, entry 7.
       */}
      <Link className={HOME_LINK} href={feedPath()}>
        <ArrowLeft aria-hidden="true" className={HOME_LINK_ICON} />
        {homeLinkLabel}
      </Link>

      {/* The matched credential page, which brings its own panel and its own single heading. */}
      {children}
    </div>
  );
}
