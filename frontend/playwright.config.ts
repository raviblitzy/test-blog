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
import { loadEnvConfig } from '@next/env';
import { defineConfig, devices, type ReporterDescription } from '@playwright/test';

/**
 * Load the project's own environment files before anything reads a variable out of them.
 *
 * WHY THIS LINE EXISTS. Every `NEXT_PUBLIC_*` value this project declares lives in an env file -
 * `.env.local` locally, `.env` and the `.env.production` pair in a deployment - and Next loads them
 * itself for `next build`, `next start` and `next dev`. Playwright does not: it is a separate runner,
 * it evaluates this file in a plain Node process, and `process.env` there holds only what the shell
 * exported. So `resolveBaseURL` below read a variable nothing had loaded, and a `playwright test
 * --list` in a clean shell failed at config load with "NEXT_PUBLIC_SITE_URL is not set" - measured
 * directly, before this line was added - even though the value was sitting in `frontend/.env.local`
 * the whole time. The suite was unrunnable without the operator re-exporting, by hand, a variable the
 * project already documents.
 *
 * `@next/env` is the loader Next itself uses, is installed with it - never as a separate dependency
 * to keep in step - and is version-matched by construction. Using it rather than a second dotenv
 * reader is what keeps the runner and the server under test reading one set of files in one
 * precedence order.
 *
 * THREE PROPERTIES OF THIS CALL, each verified in this environment rather than assumed:
 *
 *  - **An exported value still wins.** `loadEnvConfig` does not overwrite a key already present in
 *    `process.env`, so `NEXT_PUBLIC_SITE_URL=http://127.0.0.1:4100 npm run e2e` continues to aim the
 *    run wherever it says. Verified: with that variable exported, the loaded file did not replace it.
 *  - **`dev` is `false`.** The gate serves a production build (`next build && next start` below), so
 *    the production file set is the correct one: `.env`, `.env.production`, `.env.local`,
 *    `.env.production.local`. Passing `true` would load the development pair, which is not what is
 *    under test.
 *  - **`NODE_ENV=test` deliberately loads nothing.** Next excludes `.env.local` from a test
 *    environment by design, so a run launched with `NODE_ENV=test` in a clean shell finds no value
 *    and falls through to the explicit, named error below. Verified: `loadedEnvFiles` is empty under
 *    `NODE_ENV=test` and holds `.env.local` when it is unset, which is Playwright's own default. That
 *    is a fail-closed outcome rather than a gap - it says which variable to export and why.
 *
 * The logger is silenced because the loaded-file list is not this file's output to produce: a
 * misconfiguration is reported by the error `resolveBaseURL` throws, which names the key and the fix,
 * while a successful load has nothing to say and should not interleave with the reporter.
 */
loadEnvConfig(__dirname, false, { info: () => undefined, error: () => undefined });

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
 * The key naming the API the pages under test call, and therefore the second half of the stack.
 *
 * `.env.example` documents it as a base URL *including* the `/api/v1` prefix - that is the value
 * `src/lib/api/client.ts` composes request paths onto - so only its origin is used here, for the
 * readiness probe and for the port the service binds. Read for the reason the site key is read: the
 * gate has to start and wait on the service the application talks to, and inventing a runner-private
 * variable for it would be a configuration source appearing in no contract.
 */
const API_BASE_URL_KEY = 'NEXT_PUBLIC_API_BASE_URL';

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
 * A local run may not be aimed at an `https:` origin, because the server this file starts is plaintext.
 *
 * `next start` serves HTTP and has no TLS mode - there is no certificate, no key and no flag to give
 * it either. So `NEXT_PUBLIC_SITE_URL=https://127.0.0.1:3000` used to be accepted, a plaintext server
 * was started on the port, and Playwright then polled `https://127.0.0.1:3000` until the five-minute
 * `webServer` timeout expired. The failure surfaced as "Timed out waiting 300000ms from config.
 * webServer" - a message that names the timeout and not the cause, and that an operator reasonably
 * reads as a slow build. Failing here instead costs one second and names the actual mistake.
 *
 * The refusal is scoped to a local target on purpose. An `https:` origin somebody else deployed is
 * the ordinary external case and is fine: this file starts nothing for it, so nothing has to speak
 * TLS. What is impossible is *this checkout* serving TLS, and that is what is refused.
 */
if (isLocalTarget && target.protocol === 'https:') {
  throw new Error(
    `${SITE_URL_KEY} names a local https origin, which this configuration cannot serve. ` +
      `The gate starts the application with \`next start\`, which serves plaintext HTTP and has no ` +
      `TLS mode, so the readiness probe would poll an https port nothing is listening on and the run ` +
      `would fail as a webServer timeout rather than as a misconfiguration. Use http for a local ` +
      `target, or point ${SITE_URL_KEY} at an already-deployed https origin - this file starts no ` +
      `server for a non-local target, so TLS there is the deployment's concern and not this one.`,
  );
}

/**
 * Resolve the origin of the API the pages call, from {@link API_BASE_URL_KEY}.
 *
 * Validated to the same standard as the site origin, and for the same reasons - only `http:` and
 * `https:`, no embedded userinfo, a host present - because this value decides which service the gate
 * starts and probes. The declared value carries the `/api/v1` prefix, which is kept out of the origin
 * deliberately: the readiness probe addresses `/readyz`, which is one of the two **unversioned** paths
 * in the service, so composing it onto the prefixed base would produce `/api/v1/readyz` and a 404.
 */
function resolveApiOrigin(): string {
  const raw = process.env[API_BASE_URL_KEY]?.trim();
  if (!raw) {
    throw new Error(
      `${API_BASE_URL_KEY} is not set. The end-to-end gate starts and waits on the API the pages ` +
        `under test call, so it has to know where that API is; there is no default. Export it (see ` +
        `.env.example), for example ${API_BASE_URL_KEY}=http://127.0.0.1:8000/api/v1.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `${API_BASE_URL_KEY} is not a valid absolute URL. Expected scheme://host[:port]/api/v1.`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${API_BASE_URL_KEY} must use the http: or https: scheme.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      `${API_BASE_URL_KEY} must not embed credentials. Userinfo in a URL is sent on every request ` +
        `and is reproduced in Playwright's trace, HTML report and CI log.`,
    );
  }
  if (!parsed.hostname) {
    throw new Error(`${API_BASE_URL_KEY} names no host. Expected scheme://host[:port]/api/v1.`);
  }
  return parsed.origin;
}

const apiOrigin = resolveApiOrigin();

/** The parsed API target, reused for the port the service binds and the local/external decision. */
const apiTarget = new URL(apiOrigin);

/** Whether the API is one this configuration may start, on the same rule the site target follows. */
const isLocalApi = LOCAL_HOSTNAMES.has(apiTarget.hostname);

/** The port the API binds, taken from its own origin so the probe and the process cannot disagree. */
const apiPort = Number(apiTarget.port) || (apiTarget.protocol === 'https:' ? 443 : 80);

/**
 * A local run must call a local API, and the reverse.
 *
 * Mixing them is always a mistake and never a useful configuration. A local site pointed at a
 * deployed API would have the gate write posts, comments and role changes into somebody else's
 * database - these journeys mutate shared state, which is why `workers` is 1 in CI. A deployed site
 * pointed at a local API would have every page call an origin the browser cannot reach from where the
 * pages are served, and eighteen specs would fail on network errors that look like application
 * defects. Neither is worth diagnosing twice, so both are refused here by name.
 */
if (isLocalTarget !== isLocalApi) {
  throw new Error(
    `${SITE_URL_KEY} and ${API_BASE_URL_KEY} disagree about whether this run is local. ` +
      `A local site must call a local API and a deployed site must call a deployed one: the ` +
      `journeys mutate shared server state, so a local gate pointed at a deployed API would write ` +
      `into it, and a deployed site pointed at a loopback API would fail every spec on unreachable ` +
      `requests. Set both keys to the same side.`,
  );
}

/**
 * The same TLS impossibility as above, for the service half of the stack.
 *
 * The API is started with `uvicorn`, without `--ssl-keyfile`/`--ssl-certfile`, so it serves plaintext
 * exactly as `next start` does.
 */
if (isLocalApi && apiTarget.protocol === 'https:') {
  throw new Error(
    `${API_BASE_URL_KEY} names a local https origin, which this configuration cannot serve. ` +
      `The gate starts the API with uvicorn over plaintext HTTP, so the readiness probe would poll ` +
      `an https port nothing is listening on. Use http for a local API.`,
  );
}

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

  // Deliberately NOT fullyParallel, and the reason is ORDERING - not session continuity.
  //
  // What this setting buys: the tests in one file run in declaration order, on one worker.
  // Each spec is an ordered journey (§0.7.1.11) - authoring runs create draft -> edit ->
  // publish -> unpublish - and fullyParallel would scatter those steps across workers, so
  // a later step could run before the earlier one that creates the row it acts on. Files
  // still run in parallel across workers, so this costs throughput only within one spec.
  //
  // WHAT IT DOES NOT BUY, and what this comment used to claim it did: cookie and
  // localStorage continuity between tests. Playwright builds a FRESH BROWSER CONTEXT for
  // every test whatever the parallelism setting, so a session established in one test is
  // gone by the next - and `storageState` is deliberately unset below, so nothing restores
  // it. A journey written as several tests that expects to still be signed in after the
  // first is therefore relying on something this runner has never provided, and the
  // failure would present as an authorisation defect in the application rather than as a
  // harness assumption. Nor does this setting stop a file after a failing test; only
  // `test.describe.serial` does that.
  //
  // So a journey spec must establish its continuity itself, one of two ways:
  //
  //   1. ONE TEST PER JOURNEY. The whole flow - sign in, act, assert - in a single `test`,
  //      which shares one context by construction and needs nothing from this file. This is
  //      the default choice and the one the six specs should take unless a step genuinely
  //      needs to be reportable on its own.
  //   2. `test.describe.serial` PLUS AN EXPLICIT SHARED STATE. Serial mode makes the file
  //      stop at the first failure instead of running later steps against a broken state,
  //      and the session is carried across the boundary by a state file the first test
  //      writes with `context.storageState({ path })` and later tests load with
  //      `test.use({ storageState: path })`. The path belongs under ARTIFACT_DIR, which is
  //      already gitignored, so a run leaves no untracked file behind. Playwright throws
  //      ENOENT for a `storageState` path that does not exist yet, which is why this file
  //      declares none globally - a project-wide default would break every spec that has
  //      not written one, including the auth journey, whose whole point is signing in from
  //      nothing.
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
    //
    // Unset here means each test starts from a clean profile, which is the correct default and
    // is also why a multi-test journey has to carry its own session forward - see the note on
    // `fullyParallel` above for the two patterns that do so.
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
   * THE STACK THIS RUN OWNS - attached ONLY when the target is a loopback origin.
   *
   * There are TWO servers here, and the second one is the correction. This block used to start
   * `next start` alone, which is half a stack: every page under test fetches from the API, the API
   * reads PostgreSQL, and the seeded administrator is the credential the admin journey signs in with.
   * With only the web tier running, all eighteen project-spec combinations would have failed on
   * unreachable requests and empty pages - eighteen application-looking failures whose single cause
   * was that nothing had been started to answer them. A gate that fails that way is worse than no
   * gate, because the failure has to be diagnosed before it can be disbelieved.
   *
   * WHAT EACH ENTRY DOES
   *
   *  1. THE API, from `../backend`, as `migrate -> seed -> serve` chained with `&&` so the order is
   *     part of one command rather than a hope about scheduling. `alembic upgrade head` brings the
   *     schema to head, so an unmigrated database is corrected rather than merely detected;
   *     `python -m app.db.seed` is idempotent by design and supplies the reference categories, the
   *     administrator and the demonstration posts the feed, filter and admin journeys read; then
   *     `uvicorn app.main:app` serves. All three run through `.venv/bin/`, which is where the
   *     project's pinned interpreter and dependencies live.
   *
   *     Its readiness `url` is `/readyz`, NOT `/healthz`, and that choice is the whole of how
   *     PostgreSQL is validated. `/healthz` answers 200 without touching a database and would
   *     therefore report a healthy API sitting in front of nothing; `/readyz` answers 200 only while
   *     a trivial query succeeds. So waiting on it proves, before the first spec runs, that the
   *     database is reachable, that migrations applied and that the service can query it - and if any
   *     of those is untrue the run stops here, at a named readiness failure, instead of proceeding.
   *
   *  2. THE WEB TIER, build-then-start, exactly as before.
   *
   * THE ONE PREREQUISITE THIS FILE CANNOT SATISFY, stated rather than assumed: **PostgreSQL must
   * already be running.** It is a service with its own lifecycle - a container in this project's
   * development setup - not a process this checkout owns, and a `webServer` entry that tried to start
   * one would either duplicate an already-running instance or fail on a machine that manages it
   * differently. What this file does instead is make its absence immediate and legible: the `/readyz`
   * wait converts "no database" into a failure that names readiness, in seconds, rather than into
   * eighteen UI failures several minutes later. Bring it up first (the project's development setup
   * documents how) and give the API the same `DATABASE_URL` it uses elsewhere.
   *
   * ORDERING BETWEEN THE TWO. Playwright starts the entries in an array concurrently rather than in
   * sequence, so the API is listed first for legibility and not for sequencing. That is sound here
   * because neither command needs the other to have finished: the API's own prerequisites are chained
   * inside its command, and Playwright does not run a single test until EVERY `url` in the array has
   * answered. A route that fetched from the API during `next build` would be the exception worth
   * knowing about, and its own error handling - not this file - is what has to tolerate a service
   * that is still starting.
   *
   * WHY BOTH ARE SCOPED TO A LOOPBACK TARGET
   *
   *   - a loopback target is the gating mode. `npm run e2e` is a bare `playwright test`, so the suite
   *     brings its own stack up, builds the web tier from this checkout, and shuts both down
   *     afterwards. Whatever the run reports is a statement about the code in the working tree.
   *   - any other host is an explicitly external target - a deployed origin, a review environment -
   *     and nothing is started for it. Starting a local build for a run that navigates to somebody
   *     else's origin would burn several minutes serving a process the suite never contacts, while
   *     presenting as part of the gate. The two keys are required to agree about which mode this is,
   *     which is checked far above.
   *
   * `reuseExistingServer` is `false` unconditionally, in CI and locally alike, and that is the whole
   * point rather than a strictness setting. Reuse hands the gate to whatever process happens to be
   * bound to the port: a `next dev` server, a build from an hour ago, a different branch. The suite
   * would pass or fail on code nobody could identify. An operator who wants to iterate against
   * something already running says so explicitly, by pointing the two keys at it - which is the
   * external mode above, and which is plainly not a gate over this checkout.
   *
   * The web command is build-then-start, composed only from scripts that exist in package.json
   * ("build": "next build", "start": "next start"). `next start` alone would fail on a clean checkout
   * after `npm ci` - there is no .next production build to serve - and rebuilding every time also
   * rules out serving a stale bundle. `--port` is passed through npm and `PORT` is set as well, so
   * the server honours the target's port whichever mechanism it reads.
   *
   * `npm run dev` is deliberately not used. §0.9.4.5 requires the SEO criteria to hold in the initial
   * HTML with client scripting disabled, and it is the production output that has to satisfy them.
   *
   * Only `url` is set on each entry: Playwright rejects a webServer that specifies both `url` and
   * `port`.
   */
  ...(isLocalTarget
    ? {
        webServer: [
          {
            // Schema to head, reference data in place, then serve - one command, so the order is
            // guaranteed rather than scheduled. Run through the project's own virtual environment,
            // which is where the pinned interpreter and dependencies are.
            command:
              '.venv/bin/alembic upgrade head && ' +
              '.venv/bin/python -m app.db.seed && ' +
              `.venv/bin/python -m uvicorn app.main:app --host ${apiTarget.hostname} --port ${apiPort}`,

            // Resolved by Playwright against this config file's directory, so the gate does not
            // depend on where it was launched from.
            cwd: '../backend',

            // Readiness, not liveness: 200 here means the database answered. See the note above.
            url: `${apiOrigin}/readyz`,

            reuseExistingServer: false,

            // Migrations and seeding run before the first byte is served, so the window is wider
            // than a bare process start but far narrower than a web build.
            timeout: 120_000,

            // Surfaced rather than swallowed (the default is 'ignore'): a failed migration must
            // print its reason instead of presenting as an opaque webServer timeout.
            stdout: 'pipe' as const,
            stderr: 'pipe' as const,

            // Merged over process.env by Playwright, never replacing it, so PATH, DATABASE_URL and
            // JWT_SECRET_KEY stay intact - none of which is set here, because a secret does not
            // belong in a tracked file.
            env: {
              // Human-readable logs from a gate whose output a person reads, and the environment
              // the service's own configuration expects for a non-production run.
              ENVIRONMENT: 'development',
              PYTHONUNBUFFERED: '1',
            },

            gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10_000 },
          },
          {
            command: `npm run build && npm run start -- --port ${port}`,
            url: baseURL,

            reuseExistingServer: false,

            // Generous enough for a cold `next build` followed by server boot on a shared runner.
            timeout: 300_000,

            stdout: 'pipe' as const,
            stderr: 'pipe' as const,

            env: {
              PORT: String(port),
              NEXT_TELEMETRY_DISABLED: '1',
            },

            // Without this Playwright SIGKILLs the process group, which can leave the port bound
            // and make the next run fail to bind. SIGTERM first, SIGKILL only if it overstays.
            gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10_000 },
          },
        ],
      }
    : {}),
});
