/**
 * Playwright configuration - the end-to-end quality gate for the Next.js tier.
 *
 * AAP §0.9.4.6 states the gate this file governs: "All six specs pass across the three
 * viewport projects". Six specs live in ./tests/e2e - auth, authoring, home-feed,
 * comments-likes, admin, theme - and every one of them runs three times, once per
 * viewport, for eighteen project-spec combinations.
 *
 * `review_rules` reports that NO user-specified rules exist for this project, so the work
 * is held to the enterprise standards the AAP sets for itself (§0.10.1) instead. Three of
 * them bind this file directly:
 *
 *   - "Blocking quality gates" - `forbidOnly` in CI so a committed `test.only` fails the
 *     run instead of silently shrinking the suite, bounded retries, and a non-zero exit on
 *     any failure. Blocking, never advisory.
 *   - "Accessibility as a floor" - §0.9.4.5 verifies keyboard reachability, a visible focus
 *     indicator, modal focus-trapping and escape-to-close end to end. Nothing here disables
 *     an input path or renders focus behaviour unobservable.
 *   - "One breakpoint vocabulary" (§0.8.5) - the three widths in `projects` are
 *     load-bearing, not illustrative. See the comment on that block.
 *
 * Two further standards apply: "Configuration from the environment only" (the origin under
 * test is resolved from the environment, never a hard-coded domain) and "No secrets in the
 * repository" (this file contains no credential, and the report directories it writes to
 * are the ones the root .gitignore already excludes).
 */
import { defineConfig, devices, type ReporterDescription } from '@playwright/test';

/**
 * `next start`'s own default port. Nothing in package.json, next.config.ts or the Makefile
 * overrides it, and .env.example pins NEXT_PUBLIC_SITE_URL=http://localhost:3000 to agree.
 */
const DEFAULT_PORT = 3000;

/** Loopback origin used when the environment supplies no site origin of its own. */
const DEFAULT_BASE_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

/**
 * Report and artifact directories. These exact names are already excluded by the root
 * .gitignore (alongside blob-report/), which is what keeps `git status --porcelain` empty
 * after a full run. Renaming either one would leave untracked files behind.
 */
const HTML_REPORT_DIR = 'playwright-report';
const ARTIFACT_DIR = 'test-results';

const isCI = !!process.env.CI;

/**
 * Resolve the origin the suite drives.
 *
 * Precedence, highest first:
 *   1. `PLAYWRIGHT_BASE_URL` - an explicit, run-scoped override. It exists so a run can be
 *      aimed at an already-deployed origin, or at a per-clone port, without editing a
 *      tracked file.
 *   2. `NEXT_PUBLIC_SITE_URL` - the only site-origin key the project declares
 *      (.env.example). Reusing it keeps the suite and the canonical URLs the SEO artifacts
 *      emit pointed at the same origin instead of drifting apart.
 *   3. `DEFAULT_BASE_URL` - the loopback origin `next start` listens on.
 *
 * A malformed value fails fast with a message naming the offending variable. Silently
 * falling back would drive the entire suite against the wrong origin and then report a
 * green gate for an application nothing had actually exercised.
 */
function resolveBaseURL(): string {
  const candidates: ReadonlyArray<readonly [string, string | undefined]> = [
    ['PLAYWRIGHT_BASE_URL', process.env.PLAYWRIGHT_BASE_URL],
    ['NEXT_PUBLIC_SITE_URL', process.env.NEXT_PUBLIC_SITE_URL],
  ];

  for (const [name, rawValue] of candidates) {
    const value = rawValue?.trim();
    if (!value) {
      continue;
    }

    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(
        `${name}="${value}" is not a valid absolute URL. ` +
          `Expected an origin such as "${DEFAULT_BASE_URL}".`,
      );
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`${name}="${value}" must use the http: or https: scheme.`);
    }

    // A trailing slash would survive into every `new URL(path, baseURL)` join a spec
    // performs and into the webServer readiness probe; .env.example forbids one on
    // NEXT_PUBLIC_SITE_URL for the same reason, so normalise rather than trust.
    return value.replace(/\/+$/, '');
  }

  return DEFAULT_BASE_URL;
}

const baseURL = resolveBaseURL();

/**
 * The port `next start` is told to listen on, derived from the resolved origin so the two
 * can never disagree: aim a run at :4100 and the server comes up on :4100, rather than
 * Playwright waiting out its timeout probing a port nothing is bound to. An origin with no
 * explicit port (a deployed https host, say) falls back to the default.
 */
const port = Number(new URL(baseURL).port) || DEFAULT_PORT;

/**
 * HTML report. `open: 'never'` is required, not cosmetic: the default ('on-failure') starts
 * a report web server and blocks, which would hang a non-interactive gate after the first
 * failure instead of exiting non-zero.
 */
const htmlReporter: ReporterDescription = [
  'html',
  { outputFolder: HTML_REPORT_DIR, open: 'never' },
];

/**
 * `list` gives readable, line-per-test output in CI logs; `html` produces the artifact a
 * failure is diagnosed from. CI additionally gets `github`, which annotates the failing
 * lines on the pull request itself.
 */
const reporter: ReporterDescription[] = isCI
  ? [['github'], ['list'], htmlReporter]
  : [['list'], htmlReporter];

export default defineConfig({
  testDir: './tests/e2e',

  // Restricted to *.spec.ts so this runner can never collect the Vitest component tests
  // (tests/components/*.test.tsx). vitest.config.mts excludes tests/e2e/** from the other
  // direction, so the two runners stay strictly disjoint. Playwright's default testMatch
  // would also match *.test.ts, which is precisely the overlap being prevented here.
  testMatch: '**/*.spec.ts',

  outputDir: ARTIFACT_DIR,

  // Deliberately NOT fullyParallel. Each spec is an ordered journey - authoring runs
  // create draft -> edit -> publish -> unpublish, and auth needs cookie and storage
  // continuity within the spec (§0.7.1.11). fullyParallel would scatter same-file tests
  // across workers, each with its own browser context, destroying both the ordering and
  // the continuity those journeys depend on. Files still run in parallel across workers,
  // so this costs throughput only between tests of one spec.
  fullyParallel: false,

  // A committed `test.only` must fail CI rather than quietly reduce the gate to one test.
  forbidOnly: isCI,

  // Bounded retries in CI absorb genuine infrastructure flake; none locally, so a flake
  // stays visible to whoever introduced it.
  retries: isCI ? 2 : 0,

  // One worker in CI keeps the suite deterministic while it mutates shared server state
  // (accounts, posts, comments, categories all live in one database). Locally Playwright's
  // own heuristic applies.
  workers: isCI ? 1 : undefined,

  // Set explicitly rather than inherited: these journeys wait on server-rendered
  // navigations, where the 30s default per test is tight once a cold route is compiled.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter,

  use: {
    // Lets every spec navigate with a relative path - page.goto('/').
    baseURL,

    // Bounded so a hung action reports the locator that hung instead of consuming the
    // whole test budget and reporting only "test timeout".
    actionTimeout: 15_000,
    navigationTimeout: 30_000,

    // Diagnostics for the failure case only, so a green run stays cheap.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',

    // Determinism for assertions on rendered dates and counts. Pinning the timezone to UTC
    // also matches how the server renders, which keeps date output identical on both sides
    // of hydration - directly relevant to the theme spec's "no hydration warning" check.
    locale: 'en-US',
    timezoneId: 'UTC',

    // The system colour preference the theme spec starts from before it toggles. A spec
    // that needs the opposite default overrides this with test.use({ colorScheme: 'dark' }).
    colorScheme: 'light',

    // Deliberately unset: `storageState`, so no spec inherits a pre-authenticated session
    // and the auth journey genuinely signs up and logs in; and every console/stdout
    // suppression option, because the theme spec asserts the browser console reports no
    // hydration warning (§0.9.4.5) - suppressing output would make that unverifiable.
  },

  /**
   * The three viewports §0.9.4.5 names as the proof that the responsive requirement (R7)
   * is met: "End-to-end runs at 375, 768 and 1440 pixels show the collapsed navigation, the
   * two-column feed and the three-column feed respectively, with no horizontal overflow at
   * any width."
   *
   * The widths straddle the styling engine's own breakpoints (§0.8.5 fixes the responsive
   * vocabulary to sm 40rem, md 48rem, lg 64rem, xl 80rem, 2xl 96rem and forbids any custom
   * media query): 375 sits below md, 768 sits exactly at md, and 1440 sits above lg. Change
   * a width and home-feed.spec.ts and admin.spec.ts stop testing what the AAP says they
   * test.
   *
   * Every project spreads the same Desktop Chrome descriptor and overrides only the
   * viewport, so viewport width is the single independent variable across the three - which
   * is what makes the 1 -> 2 -> 3 column result attributable to the breakpoints rather than
   * to device emulation. The viewport is pinned explicitly in each block because the
   * descriptor carries its own 1280x720 that would otherwise leak in. A mobile descriptor is
   * deliberately not used for the 375 project: `isMobile` changes Chromium's metrics and
   * scroll measurement (which the no-horizontal-overflow assertion reads) and drops
   * hardware keyboard semantics that the keyboard-operability criterion depends on.
   */
  projects: [
    {
      // Below md: one-column feed, navigation collapsed into a modal drawer, admin tables
      // as stacked cards, editor stacked above preview.
      name: 'mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } },
    },
    {
      // At md: two-column feed, inline horizontal navigation, scrollable admin table,
      // stacked editor with a sticky action bar.
      name: 'tablet',
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } },
    },
    {
      // Above lg: three-column feed, inline navigation with the search affordance, full
      // admin table, editor side by side with preview.
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],

  /**
   * `npm run e2e` is a bare `playwright test`, so the suite has to bring its own server up.
   *
   * The command is build-then-start, composed only from scripts that exist in
   * package.json ("build": "next build", "start": "next start"). `next start` alone would
   * fail on a clean checkout after `npm ci` - there is no .next production build to serve -
   * and rebuilding every time also rules out serving a stale bundle, which would quietly
   * test yesterday's code. `--port` is passed through npm and `PORT` is set as well so the
   * server honours the derived port whichever mechanism it reads. Both were executed before
   * being written here: README.md:L3 documents `uvicorn main:app --reload` against a module
   * that has never existed (AAP §0.2.2.3), and that defect class is not repeated.
   *
   * `npm run dev` is deliberately not used. §0.9.4.5 requires the SEO criteria to hold in
   * the initial HTML with client scripting disabled, and it is the production output that
   * has to satisfy them.
   *
   * Only `url` is set: Playwright rejects a webServer that specifies both `url` and `port`.
   */
  webServer: {
    command: `npm run build && npm run start -- --port ${port}`,
    url: baseURL,

    // Reuse a server already listening locally so an iteration costs no rebuild; in CI
    // always start a clean one so the gate never depends on ambient state.
    reuseExistingServer: !isCI,

    // Generous enough for a cold `next build` followed by server boot on a shared runner.
    timeout: 300_000,

    // Surfaced rather than swallowed (the default is 'ignore'): a build that fails here
    // must print its reason instead of presenting as an opaque webServer timeout.
    stdout: 'pipe',
    stderr: 'pipe',

    // Merged over process.env by Playwright, never replacing it, so PATH and the NEXT_PUBLIC
    // values stay intact.
    env: {
      PORT: String(port),
      NEXT_TELEMETRY_DISABLED: '1',
    },

    // Without this Playwright SIGKILLs the process group, which can leave the port bound
    // and make the next run fail to bind. SIGTERM first, SIGKILL only if it overstays.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
