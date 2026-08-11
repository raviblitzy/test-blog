// Dark mode / theming - the sixth and last of the six end-to-end specs, and the
// one that discharges AAP §0.9.4.5's "Dark mode" criterion in full:
//
//     "Toggling adds and removes the dark class on the document element, the
//      choice survives a reload, and the browser console reports no hydration
//      warning."
//
// Those are three assertions, not one, and each tests a DIFFERENT mechanism.
// §0.7.3.3 explains why they are separable, and the separation is the shape of
// this file:
//
//   * next-themes' own blocking pre-hydration inline script prevents the FLASH.
//   * `suppressHydrationWarning` on the root <html> prevents the WARNING.
//   * next-themes' localStorage write provides the PERSISTENCE.
//
// Break any one and the other two keep working, so a spec that asserted only the
// class change would ship two silent regressions.
//
// `review_rules` reports that NO user-specified rules exist for this project.
// That response is complete rather than truncated, so no user rule governs this
// file and none is invented here; the work is held to the enterprise standards
// the AAP sets for itself (§0.10.1) instead. FIVE of them bind this spec, and
// each is answered at the point it applies:
//
//   * "Blocking quality gates" - every test below passes in all THREE viewport
//     projects (375 / 768 / 1440), which are the final 3 of the 18 project-spec
//     combinations §0.9.4.6 requires green. There is no `.only`, no `.skip`, no
//     `.fixme`, no `expect.soft` standing in for a real assertion and no
//     `try`/`catch` that could swallow one. Where the viewport genuinely changes
//     something, the branch is over HOW A CONTROL IS REACHED and BOTH sides
//     assert - see `describe('the application shell')`.
//   * "Accessibility as a floor" - the control's accessible name, its
//     keyboard reachability, its keyboard operability and its visible focus
//     indicator are all asserted, as is the fact that the current selection is
//     exposed programmatically rather than by colour alone.
//   * §0.8.5 / §0.7.2, behaviour over implementation - every element is found by
//     ROLE and ACCESSIBLE NAME. See the note on THE ONE CLASS ASSERTION below.
//   * "Pinned, reproducible dependencies" - the only import in this file is
//     `@playwright/test`, pinned at 1.62.1. No accessibility engine, no colour
//     parser, no page-object framework, and no import from `@/...` either: a
//     spec that imported the component's own `ThemeSelection` union would assert
//     the implementation against itself, and the three option labels are part of
//     the user-visible contract, so they are restated here as literals on
//     purpose.
//   * "No secrets in the repository" - theming is entirely anonymous. Nothing
//     below signs in, so no credential appears in this file and none is needed.
//     Nothing is written into the working tree either; Playwright's own report
//     directories are already gitignored.
//
// ---------------------------------------------------------------------------
// THE ONE CLASS ASSERTION PERMITTED IN tests/e2e, AND ITS EXACT BOUNDARY
//
// §0.8.5 forbids locating or asserting by class name. This file holds the single
// exception in the folder, and it is narrow: the presence and absence of the
// theme class on `document.documentElement`.
//
// It is permitted because that class IS the documented contract rather than a
// component's styling choice. `src/providers/theme-provider.tsx` configures
// next-themes with `attribute="class"`, next-themes writes the RESOLVED
// appearance onto the document element as a class, and
// `src/app/globals.css` compiles its dark variant from
// `@custom-variant dark (&:where(.dark, .dark *))` - so that one class is the
// hinge the entire twelve-token dark palette turns on. Asserting it is asserting
// the mechanism the AAP specifies.
//
// The boundary, which must not be widened:
//   PERMITTED      the theme class on the document element, and nothing else.
//   NOT PERMITTED  `toHaveClass` on any component; any assertion about a
//                  `bg-*`, `text-*` or `dark:*` utility; any locator that
//                  matches on a class.
//   INSTEAD        where the point is that the theme took visual EFFECT, this
//                  file reads COMPUTED STYLE - the resolved value of a semantic
//                  token, the computed `color-scheme`, the computed background
//                  colour of <body> - and asserts those values DIFFER between
//                  light and dark. Never that they equal a particular colour:
//                  §0.8.2's palette is allowed to be retuned without this gate
//                  turning red.
//
// ---------------------------------------------------------------------------
// WHY THE CONSOLE IS COLLECTED AND NEVER SUPPRESSED
//
// "The browser console reports no hydration warning" is only a real assertion
// while console output is intact, so nothing in this file filters, drops or
// quietens it. `describe('the browser console')` attaches a `console` collector
// and a `pageerror` collector BEFORE the first navigation - which is mandatory,
// because a hydration warning is emitted during initial client-side hydration,
// so a listener added after `goto` resolves can see an empty transcript and
// report a false pass. Collecting is the opposite of suppressing: the
// transcript is recorded whole, asserted against, and printed in full on
// failure. `playwright.config.ts` leaves every output-suppressing option unset
// for the same reason, and the five sibling specs are each instructed not to
// suppress console output either, so the precondition holds folder-wide.
//
// ---------------------------------------------------------------------------
// WHAT THE CONTROL ACTUALLY IS - READ FROM THE CODE, NOT ASSUMED
//
// `src/components/layout/theme-toggle.tsx` is a Radix MENU BUTTON over a RADIO
// GROUP. It is emphatically NOT a button that cycles through the three values,
// and that file's section 1 records why the cycling design was rejected:
// `aria-pressed` is binary and misreports two of three values, and a name that
// states the next value ("Switch to dark mode") differs between the server
// render and the hydrated render, so it both misleads and mismatches.
//
// The consequences for this spec are concrete:
//
//   * The trigger is a `button` whose accessible name is the CONSTANT
//     "Colour theme" - the name of the SETTING. It never names the current or
//     next theme, so this file must not expect it to change, and it asserts the
//     constancy instead, because interpolating a theme into it would
//     reintroduce the mismatch `describe('the browser console')` guards.
//   * The current selection is exposed by `aria-checked` on the checked
//     `menuitemradio` row - not by `aria-pressed`, and not by the trigger's
//     name. That is what this file asserts, per the standing instruction to
//     assert whatever the component actually implements.
//   * The three rows are named "System", "Light" and "Dark", presented in that
//     order, and "System" is checked on a first visit because it is the
//     provider's `defaultTheme`.
//   * Radix hides the rest of the page from assistive technology while any
//     overlay is open - the `<header>` gains `aria-hidden="true"`, so
//     `getByRole('banner')` matches nothing and the trigger becomes unfindable
//     by role. Measured, not assumed. So no helper below reaches for the
//     trigger while the menu is open, and it is also why the mobile drawer can
//     hold a SECOND copy of this control without ever colliding with the
//     header's under strict mode.
//
// ---------------------------------------------------------------------------
// WHY `system` NEEDS AN EMULATED OPERATING-SYSTEM PREFERENCE
//
// `system` is a real selection rather than the absence of one, and the class it
// resolves to depends on the host's `prefers-color-scheme`. A spec that assumed
// "system means light" is the classic locally-green, CI-red theme test. So every
// test below that has `system` in play calls
// `page.emulateMedia({ colorScheme })` explicitly, as its first action and
// before any navigation, and the two contexts built by hand pass `colorScheme`
// explicitly too. The emulation is stated at the point of use rather than in a
// distant `test.use`, so no assertion's expected outcome has to be traced to
// another block to be understood - and `playwright.config.ts`'s project-wide
// default is never what decides a result here.
//
// That explicitness also does real work in the persistence tests, where the
// emulated preference is deliberately set OPPOSITE to the stored selection. A
// reload that lost the selection would fall back to `system` and therefore to
// the OTHER appearance, so the class assertion alone becomes discriminating.
// Emulate the same side and "still dark" would pass even with persistence
// completely broken.
import { expect, test, type ConsoleMessage, type Locator, type Page } from '@playwright/test';

/* -------------------------------------------------------------------------------------------------
 * The theme contract, as named strings and patterns
 * ---------------------------------------------------------------------------------------------- */

/**
 * The accessible name of the theme control, in the header and in the mobile
 * drawer alike.
 *
 * A character-for-character contract with `TRIGGER_LABEL` in
 * `src/components/layout/theme-toggle.tsx`, where it is rendered as visually
 * hidden TEXT inside the button rather than as an `aria-label` - which is why
 * the control has real text content and why Radix can name the menu panel from
 * it. It is a noun ("Colour theme"), not an instruction, and it is constant
 * across all three selections by design.
 */
const THEME_TRIGGER_NAME = 'Colour theme';

/**
 * The accessible name of the control that opens the mobile navigation drawer.
 *
 * Contract with `TRIGGER_LABEL` in `src/components/layout/mobile-nav.tsx`. That
 * button carries `md:hidden`, so it is present only below the `md` breakpoint -
 * which is the one width-dependent fact this spec has to account for.
 */
const DRAWER_TRIGGER_NAME = 'Open navigation menu';

/**
 * The three selections the control offers, in the order it presents them.
 *
 * Contract with `THEME_SELECTIONS` and `SELECTION_LABELS` in
 * `src/components/layout/theme-toggle.tsx`. `System` leads because it is the
 * provider's `defaultTheme` and therefore the row checked on a first visit.
 *
 * Restated here as literals rather than imported from the component on purpose:
 * these labels are the user-visible contract, and importing the component's own
 * union would let a rename pass this gate silently while breaking every reader.
 */
const THEME_OPTIONS = ['System', 'Light', 'Dark'] as const;

/** One of the labels in {@link THEME_OPTIONS}. */
type ThemeOption = (typeof THEME_OPTIONS)[number];

/**
 * Whole-token patterns for the two classes next-themes writes to the document
 * element.
 *
 * A regular expression rather than a plain string is REQUIRED, not stylistic:
 * `src/app/layout.tsx` renders
 * `<html className={`${geistSans.variable} ${geistMono.variable}`}>`, so the
 * class attribute always carries the two font-module classes as well. A string
 * comparison would therefore never match. `(^|\s)` and `(\s|$)` anchor each
 * pattern to a whole class token so no substring of another class can satisfy
 * it.
 *
 * These two constants are the ENTIRETY of this file's permitted class
 * assertions, and they are only ever applied to the document element - see the
 * boundary set out in the header.
 */
const DARK_THEME_CLASS = /(^|\s)dark(\s|$)/;

/** @see {@link DARK_THEME_CLASS} */
const LIGHT_THEME_CLASS = /(^|\s)light(\s|$)/;

/**
 * The `md` breakpoint, in CSS pixels.
 *
 * §0.8.5 fixes the responsive vocabulary to the styling engine's own five
 * breakpoints and forbids a custom media query; `md` is `48rem`, which is
 * exactly 768px at the default root font size. Both `md:hidden` on the drawer
 * trigger and `hidden md:flex` on the inline navigation are evaluated against
 * it, so `min-width: 48rem` matches AT 768 and above - the tablet and desktop
 * projects - and not at 375.
 */
const MD_BREAKPOINT_PX = 768;

/**
 * The key this file stores its first-paint measurement under on `window`.
 *
 * Namespaced rather than a bare `__probe` so it cannot collide with anything the
 * application or a dependency puts on the global object. It is passed into the
 * init script as an ARGUMENT rather than closed over, because an init script is
 * serialised and evaluated in the browser, where this module's bindings do not
 * exist.
 */
const FIRST_PAINT_KEY = '__blogThemeFirstPaint';

/**
 * What a hydration complaint looks like, whatever wording the framework uses
 * this release.
 *
 * Matching on the SUBSTANCE rather than on one exact sentence is deliberate:
 * React and Next.js have reworded this diagnostic repeatedly, and a gate pinned
 * to a single string stops catching the defect the moment the wording moves,
 * failing open and silently. Each pattern is nevertheless specific enough that
 * ordinary output cannot trip it - `/hydrat/i` has no innocent occurrence in a
 * browser console, and the numeric codes are the hydration family specifically.
 *
 *   * `hydrat`         - "Hydration failed...", "...while hydrating", "hydration-mismatch".
 *   * `did not match`  - the older "Text content did not match" phrasing.
 *   * server HTML      - "...does not match the server-rendered HTML".
 *   * React codes      - 418, 419, 422, 423 and 425 are the minified hydration
 *                        errors, reported either as "Minified React error #418"
 *                        or as a react.dev/errors/418 link.
 *
 * Every message the browser emits is collected; these patterns decide which of
 * them FAIL the test. Nothing is ever removed from the transcript, and the whole
 * transcript is printed when an assertion fails.
 */
const HYDRATION_SIGNATURES: readonly RegExp[] = [
  /hydrat/i,
  /did not match/i,
  /does not match the server[- ]rendered html/i,
  /server[- ]rendered html/i,
  /minified react error #(?:418|419|422|423|425)\b/i,
  /react\.dev\/errors\/(?:418|419|422|423|425)\b/i,
];

/* -------------------------------------------------------------------------------------------------
 * Collected browser output
 * ---------------------------------------------------------------------------------------------- */

/**
 * Everything the browser said, in the order it said it.
 *
 * Both arrays are mutable by design - the listeners registered by
 * {@link collectBrowserOutput} append to them for the lifetime of the page - and
 * the properties are `readonly` so a caller cannot swap an array out and detach
 * itself from the collectors without noticing.
 */
interface BrowserOutput {
  /** Every console message, prefixed with its type. Never filtered. */
  readonly messages: string[];
  /** Every uncaught page error. Never filtered. */
  readonly pageErrors: string[];
}

/**
 * When the theme class landed relative to the parse of the document, measured at
 * three moments that all precede hydration.
 *
 * `null` means the moment never arrived while the record was being kept, which is
 * a measurement fault rather than an application one - so the assertions treat
 * `null` as a failure and say so, instead of quietly reading it as "not dark".
 *
 * WHY NOT `requestAnimationFrame`. The obvious reading - "was the class set in
 * the first animation frame" - was tried and REMOVED, because it is racy rather
 * than wrong-answer-giving, and the race was measured here: a frame callback
 * registered at document-start can be served WHILE THE DOCUMENT IS STILL BEING
 * PARSED, before the parser has even reached next-themes' script, which
 * `src/app/layout.tsx` places inside `<body>`. Under the load of three viewport
 * projects running at once that happened on two of three projects, and it says
 * nothing about a flash: at that instant the body is empty or partial, so there
 * is no themed content on screen to have been painted in the wrong palette. The
 * three readings below replace it with facts about DOCUMENT ORDER, which are
 * deterministic because a blocking inline script always runs at a fixed point in
 * the parse.
 */
interface FirstPaintRecord {
  /**
   * `document.readyState` at the instant the dark class first appeared on the
   * document element.
   *
   * `'loading'` is the proof: it means the class was applied by a blocking script
   * DURING the parse. Anything later - an effect, a `useEffect`, a deferred
   * script - could only run once parsing had finished, which is precisely the
   * flash of the wrong theme this asserts against.
   */
  readyStateWhenApplied: string | null;
  /**
   * Whether the dark class was already set at the moment the `banner` landmark
   * first appeared in the document.
   *
   * The header is the first themed markup the browser has to paint, so this is
   * the flash-relevant reading: the class must precede the content it themes.
   */
  appliedBeforeBanner: boolean | null;
  /** Whether the dark class was present when `DOMContentLoaded` fired. */
  atDomContentLoaded: boolean | null;
}

/** The computed values that prove a theme change reached the token layer. */
interface ThemeComputedStyle {
  /** Resolved value of the `--color-background` semantic token. */
  readonly background: string;
  /** Resolved value of the `--color-foreground` semantic token. */
  readonly foreground: string;
  /** Computed `color-scheme` of the document element. */
  readonly colorScheme: string;
  /** Computed background colour actually painted on `<body>`. */
  readonly bodyBackgroundColor: string;
}

/**
 * Starts recording everything the browser says on this page.
 *
 * MUST be called before the page's first navigation. A hydration warning is
 * emitted during initial client-side hydration, which begins as soon as the
 * document has loaded, so a collector attached after `goto` resolves can observe
 * an empty transcript and report a false pass.
 *
 * This RECORDS; it does not suppress. No predicate is applied here, no message
 * is dropped, and no error is swallowed - which is precisely what makes the
 * assertions in `describe('the browser console')` mean anything. Returning the
 * arrays rather than a snapshot keeps them live, so a caller reads the
 * transcript after the navigation it cares about.
 *
 * @param page - The page to listen to, before it has navigated anywhere.
 * @returns Live arrays that grow as the browser speaks.
 */
function collectBrowserOutput(page: Page): BrowserOutput {
  const messages: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (message: ConsoleMessage) => {
    messages.push(`${message.type()}: ${message.text()}`);
  });

  page.on('pageerror', (error: Error) => {
    pageErrors.push(`${error.name}: ${error.message}`);
  });

  return { messages, pageErrors };
}

/**
 * The document element, as the one locator this file is allowed to assert a
 * class on.
 *
 * `html` is an element selector rather than a class selector, so reaching for it
 * does not widen the exception documented in the header.
 *
 * @param page - The page under test.
 * @returns A locator for `<html>`.
 */
function documentElement(page: Page): Locator {
  return page.locator('html');
}

/**
 * The theme control in the site header - the copy that exists at every viewport
 * width.
 *
 * Scoped through the `banner` landmark rather than taken from the whole page,
 * because `src/components/layout/mobile-nav.tsx` renders a SECOND copy of this
 * control inside the drawer. Scoping keeps the two distinguishable by role and
 * name alone, with no class involved.
 *
 * Only valid while no overlay is open: Radix marks the header `aria-hidden`
 * whenever a menu or dialog is open, at which point neither the `banner`
 * landmark nor this button is in the accessibility tree at all.
 *
 * @param page - The page under test.
 * @returns A locator for the header's theme trigger.
 */
function headerThemeTrigger(page: Page): Locator {
  return page.getByRole('banner').getByRole('button', { name: THEME_TRIGGER_NAME, exact: true });
}

/**
 * The theme control inside the mobile navigation drawer.
 *
 * Scoped through the open `dialog`, for the same reason the header copy is
 * scoped through `banner`.
 *
 * @param page - The page under test, with the drawer open.
 * @returns A locator for the drawer's theme trigger.
 */
function drawerThemeTrigger(page: Page): Locator {
  return page.getByRole('dialog').getByRole('button', { name: THEME_TRIGGER_NAME, exact: true });
}

/**
 * One option row inside the open menu.
 *
 * @param page - The page under test, with the theme menu open.
 * @param option - The row's visible label, which is also its accessible name.
 * @returns A locator for that `menuitemradio` row.
 */
function themeOption(page: Page, option: ThemeOption): Locator {
  return page.getByRole('menuitemradio', { name: option, exact: true });
}

/* -------------------------------------------------------------------------------------------------
 * Driving and observing the control
 * ---------------------------------------------------------------------------------------------- */

/**
 * Opens the menu from a given trigger and waits until it is genuinely open.
 *
 * The `menu` role appearing is the web-first signal that Radix has mounted the
 * panel - it renders content through its presence layer only while open - so no
 * sleep is involved and none would help. `disableTransitionOnChange` on the
 * provider means there is no animation to wait out either.
 *
 * @param page - The page under test.
 * @param trigger - The trigger to activate, which must not be inside an already
 * open overlay.
 */
async function openThemeMenu(page: Page, trigger: Locator): Promise<void> {
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(page.getByRole('menu')).toHaveCount(1);
}

/**
 * Closes the menu with Escape and waits until it is gone.
 *
 * Escape rather than a click elsewhere, because dismissal by keyboard is part of
 * the accessibility floor and returns focus to the trigger, which the keyboard
 * test then depends on.
 *
 * @param page - The page under test, with the theme menu open.
 */
async function closeThemeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
}

/**
 * Records a theme selection through the user interface, exactly as a visitor
 * would.
 *
 * Nothing here writes to `localStorage`, sets a class, or calls into
 * next-themes. Persisting the choice and moving the class are the library's
 * work, and reaching past the interface to "help" would test this file's own
 * assumptions instead of the integration - which is the whole point of asserting
 * persistence at all, since
 * `src/components/layout/theme-toggle.tsx` stores nothing itself.
 *
 * @param page - The page under test.
 * @param trigger - The trigger to open the menu from.
 * @param option - The option to select.
 */
async function selectTheme(page: Page, trigger: Locator, option: ThemeOption): Promise<void> {
  await openThemeMenu(page, trigger);
  const row = themeOption(page, option);
  await expect(row).toBeVisible();
  await row.click();
  // Radix closes the menu on selection; waiting for that keeps the next
  // interaction from racing a panel that still owns focus and still has the
  // header marked `aria-hidden`.
  await expect(page.getByRole('menu')).toHaveCount(0);
}

/**
 * Asserts which option the control reports as chosen, and that the other two
 * report as not chosen.
 *
 * This is the accessibility half of the "dark mode" criterion: the selection has
 * to be available to assistive technology, not merely visible as a different
 * palette. The component exposes it as `aria-checked` on `menuitemradio` rows -
 * so that is what is asserted, rather than an `aria-pressed` or a changing
 * accessible name that this control deliberately does not implement.
 *
 * Asserting the negatives matters as much as the positive: a radio group that
 * marked every row checked would satisfy a positive-only assertion.
 *
 * The menu is opened to read the rows and closed again afterwards, leaving the
 * page as it was found.
 *
 * @param page - The page under test.
 * @param trigger - The trigger to open the menu from.
 * @param expected - The option that must be checked.
 */
async function expectSelection(page: Page, trigger: Locator, expected: ThemeOption): Promise<void> {
  await openThemeMenu(page, trigger);
  await expect(page.getByRole('menuitemradio')).toHaveCount(THEME_OPTIONS.length);

  for (const option of THEME_OPTIONS) {
    await expect(themeOption(page, option)).toHaveAttribute(
      'aria-checked',
      option === expected ? 'true' : 'false',
    );
  }

  await closeThemeMenu(page);
}

/**
 * Asserts the resolved appearance currently written to the document element.
 *
 * THE ONE PERMITTED CLASS ASSERTION, and it is applied to the document element
 * only. Both directions are asserted every time - the class that must be present
 * and the class that must be absent - because next-themes replaces one with the
 * other, and checking only the presence would pass an implementation that added
 * `dark` without ever removing `light`, leaving both palettes in the cascade at
 * once.
 *
 * `toHaveClass` auto-retries, so this observes the class settling without a
 * sleep.
 *
 * @param page - The page under test.
 * @param appearance - The appearance the document element must be showing.
 */
async function expectAppearance(page: Page, appearance: 'light' | 'dark'): Promise<void> {
  const root = documentElement(page);

  if (appearance === 'dark') {
    await expect(root).toHaveClass(DARK_THEME_CLASS);
    await expect(root).not.toHaveClass(LIGHT_THEME_CLASS);
    return;
  }

  await expect(root).toHaveClass(LIGHT_THEME_CLASS);
  await expect(root).not.toHaveClass(DARK_THEME_CLASS);
}

/**
 * Reads the computed values that prove a theme change reached the token layer.
 *
 * COMPUTED STYLE, not classes - see the boundary in the header. Four independent
 * readings, because each can break on its own:
 *
 *   * `--color-background` and `--color-foreground` are two of the twelve
 *     semantic tokens §0.8.2 names. `globals.css` declares them in a
 *     `@theme static inline` block, and both keywords are load-bearing for this
 *     reading: `static` is what emits all of them as real custom properties at
 *     `:root` so `getComputedStyle` can see them at all, and `inline` is what
 *     stops the alias chain being frozen at `:root` against the light values.
 *     Without `inline` the dark theme is entirely inert while nothing fails
 *     loudly, and these two readings would come back identical - which is
 *     exactly the regression this assertion catches.
 *   * `color-scheme` is set by the `:root` and `.dark` blocks and again by
 *     next-themes inline, and it is what themes native form controls,
 *     scrollbars and the caret.
 *   * `<body>`'s computed background colour is the end of the chain: a utility
 *     class actually repainting. Tokens can resolve correctly while no rule
 *     consumes them.
 *
 * @param page - The page under test.
 * @returns The four computed values.
 */
async function readThemeComputedStyle(page: Page): Promise<ThemeComputedStyle> {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      background: root.getPropertyValue('--color-background').trim(),
      foreground: root.getPropertyValue('--color-foreground').trim(),
      colorScheme: root.colorScheme,
      bodyBackgroundColor: getComputedStyle(document.body).backgroundColor,
    };
  });
}

/**
 * Every hydration complaint in a transcript, in order.
 *
 * A pure selection over the collected output rather than a filter applied to
 * collection: the transcript itself is never reduced, and this function is what
 * decides which of its entries constitute a failure.
 *
 * @param output - The collected browser output.
 * @returns The subset of messages and errors that match a hydration signature.
 */
function hydrationComplaints(output: BrowserOutput): string[] {
  return [...output.messages, ...output.pageErrors].filter((entry) =>
    HYDRATION_SIGNATURES.some((signature) => signature.test(entry)),
  );
}

/**
 * The console messages the browser reported as errors.
 *
 * Surfaced rather than tolerated. A 500 on a script chunk, a failed request or a
 * thrown listener all arrive here, and each is a real defect on a production
 * build even when it is not a hydration problem - this exact assertion caught a
 * stale server answering 500 for a chunk that no longer existed, which had
 * silently prevented the theme menu from opening at all.
 *
 * @param output - The collected browser output.
 * @returns The subset of messages whose console type was `error`.
 */
function consoleErrors(output: BrowserOutput): string[] {
  return output.messages.filter((entry) => entry.startsWith('error: '));
}

/**
 * Renders a transcript for a failure message.
 *
 * Printed WHOLE, including the entries that did not match anything, so a failure
 * shows the surrounding output rather than only the line that tripped the
 * assertion.
 *
 * @param output - The collected browser output.
 * @returns A readable transcript, or an explicit note that nothing was said.
 */
function describeTranscript(output: BrowserOutput): string {
  const entries = [
    ...output.messages.map((message) => `  console  ${message}`),
    ...output.pageErrors.map((error) => `  pageerror  ${error}`),
  ];
  return entries.length === 0 ? '  (the browser said nothing)' : entries.join('\n');
}

/* -------------------------------------------------------------------------------------------------
 * Measuring first paint
 * ---------------------------------------------------------------------------------------------- */

/**
 * Arranges to record WHEN the theme class landed relative to the parse of the
 * document.
 *
 * WHY THREE READINGS, and why each is deterministic where a frame-based one was
 * not (see {@link FirstPaintRecord}):
 *
 *   * `readyStateWhenApplied` is the strongest. A blocking inline script runs at
 *     a fixed point in the parse, so if next-themes' script is what applies the
 *     class then `document.readyState` is still `'loading'` when it does. An
 *     implementation that applied it from a React effect instead - the mistake
 *     `theme-provider.tsx` note 2 forbids - could not run until parsing had
 *     finished, so this would read `'interactive'` or `'complete'`. That is the
 *     difference between "correct" and "flashes the wrong theme", measured rather
 *     than inferred from a screenshot.
 *   * `appliedBeforeBanner` is the flash-relevant one: the class must be in place
 *     before the first themed markup exists to be painted in the wrong palette.
 *   * `atDomContentLoaded` confirms nothing undid it by the end of the parse.
 *
 * One observer serves all three. It is attached to `document` rather than to the
 * document element, which is what makes it safe here: at document-start -
 * when an init script runs - `document.documentElement` is NULL, and touching it
 * throws, which silently kills the rest of the init script and leaves the record
 * reading `null` for reasons that look like the application's fault. `document`
 * itself always exists, and observing it with `subtree` reports both the addition
 * of the document element and the later change to its class attribute.
 *
 * Every read of the document element therefore happens inside a callback, by
 * which time it certainly exists - the first `childList` mutation `document` can
 * report IS its addition - and even then it is reached through `querySelector`,
 * which is null-safe.
 *
 * The record must be read after the navigation has reached `load`, which is
 * Playwright's default for `goto`. Reading after `waitUntil: 'commit'` resolves
 * BEFORE `DOMContentLoaded` and yields `null` for every field.
 *
 * The key is passed as an argument because an init script is evaluated in the
 * browser, where this module's bindings do not exist.
 *
 * @param page - The page to instrument, before it has navigated anywhere.
 */
async function installFirstPaintProbe(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    const record: FirstPaintRecord = {
      readyStateWhenApplied: null,
      appliedBeforeBanner: null,
      atDomContentLoaded: null,
    };

    // Published before anything else, so the record is always readable even if a
    // later line were to throw.
    (window as unknown as Record<string, FirstPaintRecord>)[key] = record;

    // `querySelector` rather than `document.documentElement`, so this is null-safe
    // at every moment it could possibly be called.
    const hasDarkClass = (): boolean =>
      document.querySelector('html')?.classList.contains('dark') === true;

    const sample = (): void => {
      if (record.readyStateWhenApplied === null && hasDarkClass()) {
        record.readyStateWhenApplied = document.readyState;
      }
      if (record.appliedBeforeBanner === null && document.querySelector('header') !== null) {
        record.appliedBeforeBanner = hasDarkClass();
      }
    };

    new MutationObserver(sample).observe(document, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      subtree: true,
    });

    document.addEventListener(
      'DOMContentLoaded',
      () => {
        sample();
        record.atDomContentLoaded = hasDarkClass();
      },
      { once: true },
    );
  }, FIRST_PAINT_KEY);
}

/**
 * Reads back what {@link installFirstPaintProbe} recorded for the current
 * document.
 *
 * A missing record yields two `null`s rather than throwing, so the assertion -
 * which treats `null` as a failure - reports the measurement gap in the language
 * of the test instead of as an evaluation error.
 *
 * @param page - The instrumented page, after its navigation has loaded.
 * @returns The two readings.
 */
async function readFirstPaintRecord(page: Page): Promise<FirstPaintRecord> {
  return page.evaluate((key: string) => {
    const record = (window as unknown as Record<string, FirstPaintRecord | undefined>)[key];
    return (
      record ?? {
        readyStateWhenApplied: null,
        appliedBeforeBanner: null,
        atDomContentLoaded: null,
      }
    );
  }, FIRST_PAINT_KEY);
}

/* -------------------------------------------------------------------------------------------------
 * Routes
 * ---------------------------------------------------------------------------------------------- */

/**
 * The home feed. Every navigation below is a ROOT-RELATIVE path resolved against
 * `baseURL` from `playwright.config.ts`, which itself comes from
 * `NEXT_PUBLIC_SITE_URL`, so no origin is hard-coded anywhere in this file.
 */
const FEED_PATH = '/';

/** The sign-in page, which belongs to the `(auth)` route group. */
const LOGIN_PATH = '/login';

/**
 * Follows the first post on the feed, by role alone, and waits for the post page.
 *
 * `src/components/blog/post-card.tsx` renders each title as a link inside a
 * heading, and `src/app/page.tsx` places those headings at level 2 beneath its
 * single `<h1>`. So "the first level-2 heading's link" addresses the first post
 * without a class selector, without an `href` pattern, and without this file
 * knowing a single seeded slug.
 *
 * The feed having posts to follow is asserted rather than assumed: the seed
 * supplies demonstration posts, and an empty feed here is a real failure of
 * §0.9.4.4's "Feed composition" criterion, not a reason to step around this
 * assertion.
 *
 * The explicit URL wait is required. `click()` resolves once the click is
 * dispatched, but this is an App Router client-side transition, so the URL and
 * the rendered route change afterwards - reading either without waiting observes
 * the feed and reports a false result.
 *
 * @param page - The page under test, showing the feed.
 */
async function followFirstPost(page: Page): Promise<void> {
  const firstPostTitle = page.getByRole('heading', { level: 2 }).first();
  await expect(firstPostTitle).toBeVisible();

  const firstPostLink = firstPostTitle.getByRole('link');
  await expect(firstPostLink).toHaveCount(1);

  await firstPostLink.click();
  await page.waitForURL(/\/blog\/[^/?#]+$/);
}

/**
 * The viewport width the browser is actually laying out at.
 *
 * Read from the browser rather than from `page.viewportSize()` because this is
 * the value the `md` media query is evaluated against, and because it is always a
 * number - `viewportSize()` is nullable, which would need handling that says
 * nothing about the application.
 *
 * @param page - The page under test.
 * @returns The layout viewport width in CSS pixels.
 */
async function layoutWidth(page: Page): Promise<number> {
  return page.evaluate(() => window.innerWidth);
}

/* -------------------------------------------------------------------------------------------------
 * 1. The selection moves the theme class on the document element
 * ---------------------------------------------------------------------------------------------- */

test.describe('the theme selection', () => {
  test('moves the theme class on the document element and carries the token layer with it', async ({
    page,
  }) => {
    // The operating-system preference is emulated BEFORE the first navigation and
    // stated here rather than inherited, because `System` is one of the three
    // selections under test and its resolved appearance is decided by this value.
    // Pinning it light makes the round trip observable: `System` must resolve to
    // light at both ends of the cycle.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(FEED_PATH);

    const trigger = headerThemeTrigger(page);

    // -- The starting point, read from the control rather than assumed. `System`
    //    is checked because it is the provider's `defaultTheme`, and with a light
    //    operating-system preference it resolves to the light appearance.
    await expectSelection(page, trigger, 'System');
    await expectAppearance(page, 'light');
    const systemAtStart = await readThemeComputedStyle(page);

    // -- Light. An explicit selection that happens to resolve to the same
    //    appearance the system preference did, which is why the assertion that
    //    distinguishes it from `System` is the checked ROW and not the class.
    await selectTheme(page, trigger, 'Light');
    await expectAppearance(page, 'light');
    await expectSelection(page, trigger, 'Light');
    const light = await readThemeComputedStyle(page);

    // -- Dark. The class flips, and so must every reading of the token layer.
    await selectTheme(page, trigger, 'Dark');
    await expectAppearance(page, 'dark');
    await expectSelection(page, trigger, 'Dark');
    const dark = await readThemeComputedStyle(page);

    // The theme reached the token layer. Asserted as a DIFFERENCE in each of the
    // four readings, never as a particular colour, so retuning §0.8.2's palette
    // cannot turn this gate red while the mechanism still works.
    expect(
      dark.background,
      'the --color-background semantic token must resolve differently in dark than in light; ' +
        'identical values mean the .dark override never reached the cascade',
    ).not.toBe(light.background);
    expect(
      dark.foreground,
      'the --color-foreground semantic token must resolve differently in dark than in light',
    ).not.toBe(light.foreground);
    expect(
      dark.colorScheme,
      "the document element's computed color-scheme must change with the theme, so native " +
        'form controls, scrollbars and the caret follow the page',
    ).not.toBe(light.colorScheme);
    expect(
      dark.bodyBackgroundColor,
      'the canvas actually painted on <body> must change with the theme; equal values mean the ' +
        'tokens resolved but no rule consumed them',
    ).not.toBe(light.bodyBackgroundColor);

    // Each reading is also non-empty, which rules out the degenerate pass where
    // two tokens "differ" only because one of them failed to resolve at all.
    for (const [label, value] of [
      ['--color-background (light)', light.background],
      ['--color-background (dark)', dark.background],
      ['--color-foreground (light)', light.foreground],
      ['--color-foreground (dark)', dark.foreground],
    ] as const) {
      expect(value, `${label} must resolve to a value`).not.toBe('');
    }

    // -- Back to System, closing the cycle. The selection returns to where it
    //    started and the appearance returns with it, so the third activation is
    //    a real transition rather than a dead end.
    await selectTheme(page, trigger, 'System');
    await expectAppearance(page, 'light');
    await expectSelection(page, trigger, 'System');

    const systemAtEnd = await readThemeComputedStyle(page);
    expect(
      systemAtEnd,
      'returning to System must restore the appearance the page started in',
    ).toEqual(systemAtStart);
  });

  test('names the setting rather than the state, and hides its glyphs from assistive technology', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(FEED_PATH);

    const trigger = headerThemeTrigger(page);

    // A meaningful accessible name is the accessibility floor for any interactive
    // control, and this one comes from visually hidden TEXT inside the button
    // rather than from an attribute.
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAccessibleName(THEME_TRIGGER_NAME);

    // The glyphs carry no name, deliberately: a sun and a moon say nothing a
    // screen-reader user can act on, so the BUTTON carries the name and every
    // glyph inside it is hidden. A control whose only label were an unhidden icon
    // would be the defect this asserts against.
    const glyphs = trigger.locator('svg');
    const glyphCount = await glyphs.count();
    expect(glyphCount, 'the trigger renders at least one glyph').toBeGreaterThan(0);
    for (let index = 0; index < glyphCount; index += 1) {
      await expect(glyphs.nth(index)).toHaveAttribute('aria-hidden', 'true');
    }

    // The name is a CONSTANT across selections. Interpolating the current or next
    // theme into it would differ between the server render and the hydrated
    // render - both misleading before hydration and a mismatch after it - so this
    // asserts the name does NOT track the theme, which is the opposite of what a
    // cycling button would need and is exactly what this control implements.
    await selectTheme(page, trigger, 'Dark');
    await expectAppearance(page, 'dark');
    await expect(headerThemeTrigger(page)).toHaveAccessibleName(THEME_TRIGGER_NAME);

    await selectTheme(page, headerThemeTrigger(page), 'Light');
    await expectAppearance(page, 'light');
    await expect(headerThemeTrigger(page)).toHaveAccessibleName(THEME_TRIGGER_NAME);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 2. The System selection follows the operating system, in both directions
 * ---------------------------------------------------------------------------------------------- */

test.describe('the System selection', () => {
  test('resolves to the dark appearance when the operating system prefers dark', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(FEED_PATH);

    const trigger = headerThemeTrigger(page);

    // The default selection under a dark operating-system preference. Asserting
    // this is the reason the preference is emulated at all: read against an
    // ambient default, "System" could resolve either way and this test would pass
    // on one machine and fail on another.
    await expectSelection(page, trigger, 'System');
    await expectAppearance(page, 'dark');

    // Choosing Light overrides the operating system, which proves the preference
    // is a default rather than a floor.
    await selectTheme(page, trigger, 'Light');
    await expectAppearance(page, 'light');

    // Returning to System hands control back to the operating system.
    await selectTheme(page, headerThemeTrigger(page), 'System');
    await expectAppearance(page, 'dark');
    await expectSelection(page, headerThemeTrigger(page), 'System');
  });

  test('resolves to the light appearance when the operating system prefers light', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(FEED_PATH);

    const trigger = headerThemeTrigger(page);

    await expectSelection(page, trigger, 'System');
    await expectAppearance(page, 'light');

    await selectTheme(page, trigger, 'Dark');
    await expectAppearance(page, 'dark');

    await selectTheme(page, headerThemeTrigger(page), 'System');
    await expectAppearance(page, 'light');
    await expectSelection(page, headerThemeTrigger(page), 'System');
  });
});

/* -------------------------------------------------------------------------------------------------
 * 3. The choice survives
 *
 * These tests are really about the next-themes INTEGRATION, because
 * `src/components/layout/theme-toggle.tsx` stores nothing itself - it calls
 * `setTheme` and the library owns the write. So the choice is made through the
 * interface and then the page is reloaded, which is what a visitor does; nothing
 * below reads or writes `localStorage` to help it along, since that would assert
 * this file's assumption about the storage key instead of the behaviour.
 *
 * Each test emulates the operating-system preference OPPOSITE to the selection it
 * stores. That is what makes the class assertion discriminating: a reload that
 * lost the selection falls back to `System`, and `System` under the opposite
 * preference resolves to the OTHER appearance, so the failure is visible. Match
 * the two and "still dark" would pass with persistence completely broken.
 * ---------------------------------------------------------------------------------------------- */

test.describe('the chosen theme', () => {
  test('survives a reload when Dark is chosen', async ({ page }) => {
    // Opposite to the stored selection, so a lost preference would resolve light.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(FEED_PATH);

    await selectTheme(page, headerThemeTrigger(page), 'Dark');
    await expectAppearance(page, 'dark');

    await page.reload();

    await expectAppearance(page, 'dark');
    await expectSelection(page, headerThemeTrigger(page), 'Dark');
  });

  test('survives a reload when Light is chosen', async ({ page }) => {
    // The light case is not symmetry for its own sake. An implementation that
    // stored only a truthy value - or that treated "light" as "no preference" -
    // would pass a dark-only test and fail here, because the operating-system
    // preference is dark and a lost selection would resolve dark.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(FEED_PATH);

    await selectTheme(page, headerThemeTrigger(page), 'Light');
    await expectAppearance(page, 'light');

    await page.reload();

    await expectAppearance(page, 'light');
    await expectSelection(page, headerThemeTrigger(page), 'Light');
  });

  test('survives a client-side navigation from the feed to a post', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(FEED_PATH);

    await selectTheme(page, headerThemeTrigger(page), 'Dark');
    await expectAppearance(page, 'dark');

    // The provider is mounted once, in the root layout, so it must not be
    // remounted - and the selection must not be re-derived - by a route change.
    // This is a client-side App Router transition rather than a fresh document
    // load, which is the case a reload does not cover.
    await followFirstPost(page);

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAppearance(page, 'dark');
    await expectSelection(page, headerThemeTrigger(page), 'Dark');

    // And it holds through a full document load of the post route too, which is
    // how a visitor arrives at a shared link.
    await page.reload();
    await expectAppearance(page, 'dark');
  });

  test('is already applied at first paint, so a cold load shows no flash of the other theme', async ({
    browser,
  }) => {
    // TWO CONTEXTS, and the split is the whole point. The first authors a stored
    // preference through the interface; the second is a genuinely COLD load that
    // has never run this application before and only knows the stored value. A
    // single context would be measuring a page that had already hydrated once.
    const authoring = await browser.newContext({ colorScheme: 'light' });
    const authoringPage = await authoring.newPage();
    await authoringPage.goto(FEED_PATH);
    await selectTheme(authoringPage, headerThemeTrigger(authoringPage), 'Dark');
    await expectAppearance(authoringPage, 'dark');

    // Captured in memory, never written to disk, so the run leaves no untracked
    // file behind and `git status --porcelain` stays empty.
    const storedPreference = await authoring.storageState();
    await authoring.close();

    // The cold context emulates a LIGHT operating-system preference while carrying
    // a stored DARK selection. That opposition is what makes the measurement
    // meaningful: if the pre-hydration script never ran, the document element
    // would be light at both moments below, so neither reading can pass by
    // accident.
    const cold = await browser.newContext({
      colorScheme: 'light',
      storageState: storedPreference,
    });
    const coldPage = await cold.newPage();
    await installFirstPaintProbe(coldPage);

    // Default `waitUntil: 'load'`, deliberately: the record is only complete once
    // the parse has finished and DOMContentLoaded has fired. There is no sleep here
    // and none would be honest - `disableTransitionOnChange` means the switch is
    // immediate, so waiting a fixed period would only hide a late application of
    // the class rather than detect it.
    await coldPage.goto(FEED_PATH);

    const firstPaint = await readFirstPaintRecord(coldPage);

    expect(
      firstPaint.readyStateWhenApplied,
      'the dark class must be applied while the document is still being parsed, which is what a ' +
        "blocking pre-hydration script does. 'interactive' or 'complete' would mean it landed " +
        'after parsing - from an effect, say - and that is a visible flash of the wrong theme. ' +
        'A null means the class never appeared at all, so the stored preference was ignored.',
    ).toBe('loading');

    expect(
      firstPaint.appliedBeforeBanner,
      'the dark class must already be set at the moment the banner landmark enters the document: ' +
        'the header is the first themed markup on screen, so the class has to precede the content ' +
        'it themes or that content is painted in the wrong palette first',
    ).toBe(true);

    expect(
      firstPaint.atDomContentLoaded,
      'the dark class must still be on the document element when DOMContentLoaded fires, so ' +
        'nothing undid it during the rest of the parse',
    ).toBe(true);

    // And the settled state agrees with the pre-paint readings, so the class was
    // not applied early and then undone by hydration.
    await expectAppearance(coldPage, 'dark');
    await expectSelection(coldPage, headerThemeTrigger(coldPage), 'Dark');

    await cold.close();
  });
});

/* -------------------------------------------------------------------------------------------------
 * 4. The browser console reports no hydration warning
 *
 * The third of §0.9.4.5's three "dark mode" assertions, and the one that verifies
 * `suppressHydrationWarning` on the root <html> is doing its job. That attribute
 * exists because the server CANNOT know the client's stored preference, so the
 * document element the server renders and the one the client hydrates against
 * legitimately differ. Remove the attribute and this is where it surfaces.
 *
 * The gate is only honest on a PRODUCTION build, which is what
 * `playwright.config.ts` serves: development builds emit their own diagnostics
 * and treat hydration differently, so a green run against `next dev` would prove
 * nothing. A failure here is therefore never to be dismissed as a dev-only
 * artefact.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Drives the theme across two server-rendered routes and both appearances.
 *
 * Shared by the two tests below, which differ only in the emulated
 * operating-system preference. Each navigation is a fresh document load, so each
 * one hydrates - which is what gives the collectors something to catch.
 *
 * @param page - An instrumented page that has not navigated yet.
 */
async function exerciseThemeAcrossRoutes(page: Page): Promise<void> {
  await page.goto(FEED_PATH);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // Both explicit appearances, so a mismatch that only shows in one of them
  // cannot slip through.
  await selectTheme(page, headerThemeTrigger(page), 'Dark');
  await expectAppearance(page, 'dark');
  await selectTheme(page, headerThemeTrigger(page), 'Light');
  await expectAppearance(page, 'light');
  await selectTheme(page, headerThemeTrigger(page), 'Dark');
  await expectAppearance(page, 'dark');

  // A post page, which is the most content-heavy server render in the product and
  // the one whose article body must be in the initial HTML.
  await followFirstPost(page);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // Reloaded with a stored preference in place, which is the exact condition
  // `suppressHydrationWarning` covers: the server renders a document element with
  // no theme class, the pre-hydration script adds one, and React then hydrates
  // against an element that no longer matches the HTML it was sent.
  await page.reload();
  await expectAppearance(page, 'dark');

  await page.goto(LOGIN_PATH);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectAppearance(page, 'dark');
}

/**
 * Asserts a transcript contains no hydration complaint and no uncaught error.
 *
 * Nothing is filtered out of the transcript on the way in; the whole of it is
 * printed on failure, including entries that matched nothing, so an unrelated
 * warning is SURFACED next to the failure rather than hidden from it.
 *
 * @param output - The collected browser output.
 */
function expectNoHydrationNoise(output: BrowserOutput): void {
  expect(
    hydrationComplaints(output),
    'the browser reported a hydration problem. suppressHydrationWarning on the root <html> in ' +
      'src/app/layout.tsx is what absorbs the legitimate difference between the server-rendered ' +
      'document element and the hydrated one; check it is still there, and that no component ' +
      'renders a theme VALUE during the initial pass.\nFull transcript:\n' +
      describeTranscript(output),
  ).toEqual([]);

  expect(
    output.pageErrors,
    'no uncaught page error may occur while the theme is exercised.\nFull transcript:\n' +
      describeTranscript(output),
  ).toEqual([]);

  // Stronger than the criterion requires, and kept because it earns its place: a
  // console error on a production build is a real defect even when it is not a
  // hydration problem, and surfacing it is what the no-filtering rule is for.
  expect(
    consoleErrors(output),
    'the browser logged a console error while the theme was exercised.\nFull transcript:\n' +
      describeTranscript(output),
  ).toEqual([]);
}

test.describe('the browser console', () => {
  test('reports no hydration warning when the operating system prefers light', async ({ page }) => {
    // COLLECTORS FIRST, NAVIGATION SECOND. Hydration runs immediately after the
    // document loads, so a listener attached after `goto` resolves can see an
    // empty transcript and report a false pass. Nothing here filters or silences
    // anything - both collectors record everything the browser says.
    const output = collectBrowserOutput(page);
    await page.emulateMedia({ colorScheme: 'light' });

    await exerciseThemeAcrossRoutes(page);

    expectNoHydrationNoise(output);
  });

  test('reports no hydration warning when the operating system prefers dark', async ({ page }) => {
    const output = collectBrowserOutput(page);

    // The dark preference is the case most likely to surface a mismatch: the
    // server renders a document element with no theme class whatever the client
    // prefers, so under a dark preference the very first paint already differs
    // from the HTML that was sent. If `suppressHydrationWarning` were ever removed
    // from the root element, this is the test that would catch it.
    await page.emulateMedia({ colorScheme: 'dark' });

    await exerciseThemeAcrossRoutes(page);

    expectNoHydrationNoise(output);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 5. The mechanism holds across the whole shell
 *
 * Theming itself is width-independent - it is a token-layer concern, and the class
 * on the document element means the same thing at 375 as at 1440 - so none of the
 * ASSERTIONS below branch on width. What does differ is HOW the control is
 * reached: `src/components/layout/mobile-nav.tsx` renders a second copy inside
 * the drawer, and that drawer's trigger carries `md:hidden`.
 *
 * So the one branch in this file is over the reach path, and BOTH sides assert.
 * Nothing is skipped, no test is disabled at a width, and the branch is derived
 * from the documented breakpoint rather than from whether a control happens to be
 * visible - deriving it from visibility would let a control that wrongly vanished
 * at 375 quietly take the other path.
 * ---------------------------------------------------------------------------------------------- */

test.describe('the application shell', () => {
  test('offers a working theme control at this viewport width', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(FEED_PATH);

    // The header copy has no responsive hiding at all, so it is present and usable
    // at every one of the three project widths. This assertion is what pins that:
    // move a `md:hidden` onto it and all three projects fail here.
    const trigger = headerThemeTrigger(page);
    await expect(trigger).toBeVisible();
    await selectTheme(page, trigger, 'Dark');
    await expectAppearance(page, 'dark');

    const width = await layoutWidth(page);
    const drawerTrigger = page.getByRole('button', { name: DRAWER_TRIGGER_NAME, exact: true });

    if (width < MD_BREAKPOINT_PX) {
      // Below `md` the primary navigation is collapsed into a drawer, which holds
      // its own copy of the control. Both must work, so the drawer's copy is
      // exercised here rather than merely found.
      await expect(drawerTrigger).toBeVisible();
      await drawerTrigger.click();
      await expect(page.getByRole('dialog')).toHaveCount(1);

      // While the dialog is open Radix marks the header `aria-hidden`, so the
      // header's copy leaves the accessibility tree and exactly one control with
      // this name remains. Asserting the count is what proves the two copies never
      // collide under strict mode.
      await expect(page.getByRole('button', { name: THEME_TRIGGER_NAME, exact: true })).toHaveCount(
        1,
      );

      const inDrawer = drawerThemeTrigger(page);
      await expect(inDrawer).toBeVisible();
      await selectTheme(page, inDrawer, 'Light');
      await expectAppearance(page, 'light');

      // The drawer stays open across the selection, so it is dismissed explicitly
      // and the header returns to the accessibility tree.
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(headerThemeTrigger(page)).toBeVisible();
    } else {
      // At and above `md` the navigation is inline and the drawer does not exist,
      // so its trigger must be absent. This is the complement of the branch above
      // and is a real assertion, not a fallback.
      await expect(drawerTrigger).toBeHidden();

      // With no drawer there is exactly one theme control in the document.
      await expect(page.getByRole('button', { name: THEME_TRIGGER_NAME, exact: true })).toHaveCount(
        1,
      );

      await selectTheme(page, headerThemeTrigger(page), 'Light');
      await expectAppearance(page, 'light');
    }
  });

  test('exposes the theme control to the keyboard with a visible focus indicator', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(FEED_PATH);
    await expect(headerThemeTrigger(page)).toBeVisible();

    // REACHABLE. Tabbed to from the top of the document rather than focused
    // programmatically, because a control removed from the tab order would still
    // accept `focus()` and this is the assertion that would miss it.
    const focused = page.locator(':focus');
    let reached = false;
    for (let press = 0; press < 25 && !reached; press += 1) {
      await page.keyboard.press('Tab');
      reached =
        (await focused.count()) === 1 &&
        (await focused.getAttribute('aria-haspopup')) === 'menu' &&
        (await focused.textContent())?.trim() === THEME_TRIGGER_NAME;
    }
    expect(
      reached,
      'the theme control must be reachable by Tab from the start of the document',
    ).toBe(true);

    // A VISIBLE FOCUS INDICATOR. Read as computed style, which is the geometry the
    // outline is actually drawn with - not a class. The primitive draws a 2px
    // outline from the ring token at a 2px offset; this asserts that an outline is
    // drawn at all and that it has width, which is what `outline: none` would
    // remove.
    const indicator = await page.evaluate(() => {
      const active = document.activeElement;
      if (active === null) {
        return null;
      }
      const style = getComputedStyle(active);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor,
      };
    });
    expect(indicator, 'the focused control must be readable from the document').not.toBeNull();
    expect(
      indicator?.outlineStyle,
      'the focused theme control must draw an outline; `outline: none` is the defect this catches',
    ).not.toBe('none');
    expect(
      Number.parseFloat(indicator?.outlineWidth ?? '0'),
      'the focus outline must have a non-zero width',
    ).toBeGreaterThan(0);
    expect(indicator?.outlineColor, 'the focus outline must have a colour').not.toBe('');

    // OPERABLE BY ENTER. The menu opens with focus on the checked row, which is
    // Radix's behaviour and is what makes the selection audible on open.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toHaveCount(1);
    await expect(themeOption(page, 'System')).toBeFocused();

    // Traversed and selected by keyboard alone: System -> Light -> Dark, then
    // Enter. No pointer is involved anywhere in this sequence.
    await page.keyboard.press('ArrowDown');
    await expect(themeOption(page, 'Light')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(themeOption(page, 'Dark')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expectAppearance(page, 'dark');

    // Focus returns to the trigger after the menu closes, so the keyboard user is
    // not dropped at the top of the document.
    await expect(headerThemeTrigger(page)).toBeFocused();

    // OPERABLE BY SPACE as well, which is the other activation key a button must
    // honour.
    await page.keyboard.press(' ');
    await expect(page.getByRole('menu')).toHaveCount(1);
    await themeOption(page, 'Light').press('Enter');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expectAppearance(page, 'light');
  });

  test('themes a page served by a different route group', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });

    // The sign-in page belongs to the `(auth)` route group and renders inside its
    // own layout. The provider is mounted once in the ROOT layout, so if it were
    // ever moved into a page or a group layout, the theme would work on the feed
    // and silently stop working here.
    await page.goto(LOGIN_PATH);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const trigger = headerThemeTrigger(page);
    await expect(trigger).toBeVisible();
    await expectSelection(page, trigger, 'System');
    await expectAppearance(page, 'light');

    const light = await readThemeComputedStyle(page);

    await selectTheme(page, headerThemeTrigger(page), 'Dark');
    await expectAppearance(page, 'dark');

    const dark = await readThemeComputedStyle(page);
    expect(
      dark.bodyBackgroundColor,
      'the canvas of a page in the (auth) route group must repaint with the theme, which is what ' +
        'proves the provider wraps the whole tree from the root layout',
    ).not.toBe(light.bodyBackgroundColor);

    // And it persists out of this route group and into the feed.
    await page.goto(FEED_PATH);
    await expectAppearance(page, 'dark');
    await expectSelection(page, headerThemeTrigger(page), 'Dark');
  });
});
