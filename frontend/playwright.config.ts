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
 * The one environment key this file reads, and the only site origin the project declares.
 *
 * `.env.example` documents it; the SEO artifacts build every canonical URL, sitemap entry
 * and structured-data reference from it. Driving the suite from the same key is what keeps
 * the pages under test and the URLs they advertise pointed at one origin. No second,
 * runner-private variable is invented for this: a configuration source that appears in no
 * contract is a configuration source nobody can audit.
 */
const SITE_URL_KEY = 'NEXT_PUBLIC_SITE_URL';

/**
 * Hostnames whose origins this configuration will bring a server up for.
 *
 * A run aimed at any other host is a run against something this checkout did not build, so
 * no `webServer` is attached to it - see the `webServer` block at the end of this file.
 */
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Report and artifact directories. These exact names are already excluded by the root
 * .gitignore (alongside blob-report/), which is what keeps `git status --porcelain` empty
 * after a full run. Renaming either one would leave untracked files behind.
 */
const HTML_REPORT_DIR = 'playwright-report';
const ARTIFACT_DIR = 'test-results';

/**
 * Whether this run is an unattended one.
 *
 * `CI` is the runner's own convention rather than a key in this project's configuration
 * contract, and it is read for exactly that: it selects the reporter set, forbids a
 * committed `test.only`, and bounds retries and workers. It never selects what is under
 * test, which origin is driven, or whether a server is started - those follow from
 * {@link SITE_URL_KEY} alone, so an unset or spuriously set `CI` cannot change the meaning
 * of a result. `.env.example` therefore does not, and should not, declare it.
 */
const isCI = !!process.env.CI;

/**
 * Resolve the origin the suite drives, from {@link SITE_URL_KEY} and nothing else.
 *
 * Fails closed in every direction. An absent, empty or malformed value stops the run here
 * rather than substituting a guess: a suite silently pointed at the wrong origin reports a
 * green gate for an application nothing actually exercised, which is worse than no gate.
 * The value must be a bare origin - scheme, host, optional port - because every spec joins
 * relative paths onto it and the readiness probe below requests it verbatim:
 *
 *   - only `http:` and `https:` are accepted, so a `file:`, `ws:` or `javascript:` value
 *     cannot reach a browser navigation;
 *   - userinfo is rejected outright. A credential embedded in a URL would be sent on every
 *     navigation, printed by Playwright's trace and HTML report, and captured in CI logs;
 *   - a path, query or fragment is rejected, because it would be silently dropped from some
 *     joins and duplicated into others, and `.env.example` already forbids one on this key.
 *
 * No message quotes the value. The variable name and the reason are enough to fix the
 * misconfiguration, whereas echoing the value would copy whatever it holds - a credential
 * included - into the terminal, the report and the CI log.
 */
function resolveBaseURL(): string {
  const raw = process.env[SITE_URL_KEY]?.trim();
  if (!raw) {
    throw new Error(
      `${SITE_URL_KEY} is not set. The end-to-end suite drives the origin that variable ` +
        `names; there is no default, because a run against a guessed origin proves nothing. ` +
        `Export it (see .env.example) before running playwright, for example ` +
        `${SITE_URL_KEY}=http://127.0.0.1:3000 npm run e2e.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `${SITE_URL_KEY} is not a valid absolute URL. Expected a bare origin: ` +
        `scheme://host[:port], with no path, query or fragment.`,
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${SITE_URL_KEY} must use the http: or https: scheme.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      `${SITE_URL_KEY} must not embed credentials. Userinfo in a URL is sent on every ` +
        `navigation and is reproduced in Playwright's trace, HTML report and CI log.`,
    );
  }
  if (!parsed.hostname) {
    throw new Error(`${SITE_URL_KEY} names no host. Expected scheme://host[:port].`);
  }
  if ((parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error(
      `${SITE_URL_KEY} must be a bare origin with no path, query or fragment: every spec ` +
        `joins relative paths onto it, so anything after the host corrupts those joins.`,
    );
  }

  // `URL.origin` is the normalised form - lower-cased scheme and host, default port
  // dropped, no trailing slash - which is exactly what a `new URL(path, baseURL)` join and
  // the readiness probe both want.
  return parsed.origin;
}

const baseURL = resolveBaseURL();

/** The parsed target, reused below for the port and the local/external decision. */
const target = new URL(baseURL);

/**
 * Whether this run drives a server this configuration is allowed to start.
 *
 * A loopback target means the suite owns the server and builds it from the checkout. Any
 * other host is an origin somebody else deployed, and starting a local `next start` for it
 * would test a process the run never navigates to - see the `webServer` block below.
 */
const isLocalTarget = LOCAL_HOSTNAMES.has(target.hostname);

/**
 * The port `next start` is told to listen on, taken from the target origin so the two can
 * never disagree: aim a run at :4100 and the server comes up on :4100, rather than
 * Playwright waiting out its timeout probing a port nothing is bound to. An origin that
 * states no port is using its scheme's default, and that default - not an invented 3000 -
 * is what the server must bind, or the readiness probe would poll a different port than the
 * one being served.
 */
const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);

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
  // (tests/components/*.test.tsx). vitest.config.ts excludes tests/e2e/** from the other
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
   * A server this run owns - attached ONLY when the target is a loopback origin.
   *
   * The two modes are decided by {@link SITE_URL_KEY} alone, and each is honest about what
   * it proves:
   *
   *   - a loopback target is the gating mode. `npm run e2e` is a bare `playwright test`, so
   *     the suite brings its own server up, builds it from this checkout, and shuts it down
   *     afterwards. Whatever the run reports is a statement about the code in the working
   *     tree.
   *   - any other host is an explicitly external target - a deployed origin, a review
   *     environment - and no `webServer` is attached to it at all. Starting a local
   *     `next start` for a run that navigates to somebody else's origin would build and
   *     serve a process the suite never contacts, burning several minutes to prove nothing
   *     while presenting as part of the gate.
   *
   * `reuseExistingServer` is `false` unconditionally, in CI and locally alike, and that is
   * the whole point rather than a strictness setting. Reuse hands the gate to whatever
   * process happens to be bound to the port: a `next dev` server, a build from an hour ago,
   * a different branch. The suite would pass or fail on code nobody could identify. An
   * operator who wants to iterate against something already running says so explicitly, by
   * pointing {@link SITE_URL_KEY} at it - which is the external mode above, and which is
   * plainly not a gate over this checkout.
   *
   * The command is build-then-start, composed only from scripts that exist in package.json
   * ("build": "next build", "start": "next start"). `next start` alone would fail on a clean
   * checkout after `npm ci` - there is no .next production build to serve - and rebuilding
   * every time also rules out serving a stale bundle. `--port` is passed through npm and
   * `PORT` is set as well, so the server honours the target's port whichever mechanism it
   * reads.
   *
   * `npm run dev` is deliberately not used. §0.9.4.5 requires the SEO criteria to hold in
   * the initial HTML with client scripting disabled, and it is the production output that
   * has to satisfy them.
   *
   * Only `url` is set: Playwright rejects a webServer that specifies both `url` and `port`.
   */
  ...(isLocalTarget
    ? {
        webServer: {
          command: `npm run build && npm run start -- --port ${port}`,
          url: baseURL,

          reuseExistingServer: false,

          // Generous enough for a cold `next build` followed by server boot on a shared
          // runner.
          timeout: 300_000,

          // Surfaced rather than swallowed (the default is 'ignore'): a build that fails
          // here must print its reason instead of presenting as an opaque webServer
          // timeout.
          stdout: 'pipe' as const,
          stderr: 'pipe' as const,

          // Merged over process.env by Playwright, never replacing it, so PATH and the
          // NEXT_PUBLIC values stay intact.
          env: {
            PORT: String(port),
            NEXT_TELEMETRY_DISABLED: '1',
          },

          // Without this Playwright SIGKILLs the process group, which can leave the port
          // bound and make the next run fail to bind. SIGTERM first, SIGKILL only if it
          // overstays.
          gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10_000 },
        },
      }
    : {}),
});
