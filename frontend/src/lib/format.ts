/**
 * Pure date-and-count formatting for the presentation tier.
 *
 * Every function exported here is a *total* function over wire primitives: it accepts the raw
 * JSON shapes the REST API actually produces, never throws, and returns a value for every input
 * in its domain. There is no I/O, no module state beyond two cached `Intl` formatters, and no
 * dependency on the domain contract types.
 *
 * ## Why primitives rather than domain resources
 *
 * Signatures take `string | Date | null | undefined` (see {@link DateInput}) rather than
 * `PostSummary`, `Comment` or `AdminUser`. That is a deliberate design decision, not an
 * oversight. Keeping the surface primitive means this module is trivially unit-testable, has no
 * import edge to the contract-type mirror, and is reusable verbatim by admin tables, blog cards,
 * comment threads and author bylines alike — all of which carry the same timestamps under
 * different resource shapes.
 *
 * ## Wire conventions this module is built around
 *
 * - Timestamps arrive as ISO-8601 **strings**, never `Date` objects: the API serialises
 *   PostgreSQL `timestamptz` columns to JSON, and `JSON.parse` has no date type. Strings are
 *   therefore parsed with `parseISO`, never `new Date(...)`, whose handling of non-standard
 *   input is implementation-defined.
 * - Field names stay snake_case throughout this tier — `published_at`, `created_at`,
 *   `updated_at`, `view_count`, `like_count`, `post_count`. There is no camelCase mapping layer.
 * - `published_at` is legitimately `null` for a `DRAFT` post: the database `CHECK` constraint
 *   only requires it to be present once `status = 'PUBLISHED'`, and the author dashboard renders
 *   drafts. Null-tolerance here is a correctness requirement, not defensive padding — a formatter
 *   that threw on `null` would crash the dashboard.
 *
 * ## The placeholder convention
 *
 * Every function returns {@link EMPTY_VALUE} — the empty string — for absent or unparseable
 * input. The empty string is chosen over a visible dash for one structural reason: consumers
 * render `<time dateTime={machine}>{human}</time>`, and an empty string is falsy, so the
 * idiomatic guard `{machine && <time dateTime={machine}>…</time>}` elides the element entirely
 * rather than emitting `dateTime="—"`, which would be a malformed attribute. A caller that wants
 * a visible dash in a table cell writes `formatDate(value) || '—'`; that is a presentation
 * decision and belongs to the component, because this module returns strings and never owns
 * presentation.
 *
 * ## Server/client determinism
 *
 * These helpers run in both React Server Components and client islands, so identical input must
 * produce identical output in both places or React reports a hydration mismatch — and the mismatch
 * is not theoretical: a server in UTC and a browser in New York disagree about the calendar day of
 * every instant between midnight and 04:00 UTC, which is a real fraction of every day's
 * publications. Every function here is therefore a *pure function of its arguments alone*: none
 * reads the host timezone, and none reads the clock. Three choices implement that, and all three
 * are load-bearing:
 *
 * 1. {@link formatDate} resolves its calendar fields in **UTC**, through an `Intl.DateTimeFormat`
 *    pinned to `timeZone: 'UTC'`. date-fns' `format` uses the host's local calendar day instead,
 *    so `2025-03-12T02:00:00Z` renders as `12 March 2025` on a UTC server and `11 March 2025` in
 *    a New York browser — one instant, two labels, and a hydration mismatch on the boundary.
 *    UTC is also the timezone the end-to-end suite pins (`timezoneId: 'UTC'` in
 *    playwright.config.ts) and the timezone the API's `timestamptz` values are serialised in, so
 *    the rendered day always matches the instant the service reported.
 * 2. {@link formatMachineDate} normalises to UTC via `Date.prototype.toISOString`. date-fns'
 *    `formatISO` emits the *local* offset, so the same instant serialises as
 *    `2025-03-12T02:00:00.000Z` on a UTC server but `2025-03-11T22:00:00-04:00` in a New York
 *    browser — two different `dateTime` attributes for one instant.
 * 3. {@link formatRelativeTime} takes its reference instant as a **required** argument. A
 *    relative label derived from `Date.now()` is computed against a different clock on the server
 *    and in the browser — milliseconds apart at best, and across a distance boundary
 *    ("about 1 hour ago" against "about 2 hours ago") at worst — so the caller supplies the
 *    instant to measure against and owns where it came from.
 *
 * The `Intl` formatters below also pin an explicit locale. Left unpinned, `1234` renders as
 * `1.2K` on an en-US server and `1,2 k` in a fr-FR browser. Pinning a single locale is the
 * opposite of localising; internationalisation is explicitly out of scope for this project.
 *
 * This module is intentionally free of any client-boundary directive: these are pure functions
 * that must remain callable from Server Components, which is what keeps rendered content in the
 * initial HTML response for search-engine crawlers.
 */

import { formatDistance, isValid, parseISO } from 'date-fns';

/**
 * Every timestamp shape this module accepts.
 *
 * `string` is the real wire case (an ISO-8601 instant from the API). `Date` is tolerated so a
 * caller that has already parsed an instant — a test pinning a reference time, for example — does
 * not have to serialise it back to a string first. `null` and `undefined` model an absent
 * timestamp such as the `published_at` of an unpublished draft.
 */
export type DateInput = string | Date | null | undefined;

/**
 * The single placeholder returned for absent or unparseable input.
 *
 * Deliberately the empty string so that `{value && <time dateTime={value}>…</time>}` elides the
 * element rather than emitting a malformed attribute. See the module documentation for the full
 * rationale.
 */
export const EMPTY_VALUE = '';

/**
 * Assumed silent reading speed, in words per minute, used by {@link estimateReadingTime}.
 *
 * This is the module's only reading-speed figure; the value is never repeated inline. 200 wpm is
 * a conventional mid-range estimate for prose read on screen.
 */
export const WORDS_PER_MINUTE = 200;

/**
 * The value at which {@link formatCount} switches from exact digits to compact notation.
 *
 * Below this bound the exact count is more informative than an abbreviation ("999" beats "1K"),
 * and it is also the point at which the two notations begin to disagree at all.
 */
export const COMPACT_COUNT_THRESHOLD = 1000;

/**
 * Pinned formatting locale. See the module documentation — this exists to make server and client
 * output byte-identical, not to support localisation.
 */
const FORMAT_LOCALE = 'en-US';

/**
 * The timezone every human-readable date is resolved in.
 *
 * Fixed rather than configurable, and fixed to UTC specifically. The API serialises PostgreSQL
 * `timestamptz` columns as UTC instants, `playwright.config.ts` pins `timezoneId: 'UTC'` so the
 * end-to-end assertions read the same calendar day, and — decisively — a timezone that came from
 * the host would differ between the server render and the browser render of the same instant,
 * which is the hydration mismatch this module exists to make impossible.
 */
const FORMAT_TIME_ZONE = 'UTC';

/**
 * Suffix appended by {@link formatReadingTime}. Named so the label is declared exactly once.
 */
const READING_TIME_SUFFIX = 'min read';

/**
 * `Intl` formatters are comparatively expensive to construct, so both are built once at module
 * scope and reused. `Intl` is a standard ECMAScript global present in Node and in browsers, so
 * touching it here does not make the module client-only.
 */
const compactCountFormatter = new Intl.NumberFormat(FORMAT_LOCALE, {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
});

const exactCountFormatter = new Intl.NumberFormat(FORMAT_LOCALE, {
  maximumFractionDigits: 0,
});

/**
 * Resolves an instant's day, month name and year in {@link FORMAT_TIME_ZONE}.
 *
 * `Intl.DateTimeFormat` is what makes the timezone explicit — it is the only formatting API in the
 * platform that accepts one, which is why the human-readable date is built here rather than with
 * date-fns' `format`. The parts are reassembled by {@link formatDate} rather than taken from
 * `format()`'s single string, because the assembled order is then *ours*: a locale's own
 * day/month/year order and its separators can change with an ICU update, and this label must not.
 */
const dateFieldFormatter = new Intl.DateTimeFormat(FORMAT_LOCALE, {
  timeZone: FORMAT_TIME_ZONE,
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/**
 * Normalises any accepted timestamp shape to a valid `Date`, or `null` when there is nothing
 * usable to format.
 *
 * This is the single place in the module where absence and invalidity collapse into one
 * representation, which is what lets every exported function stay total with a one-line guard.
 * Strings go through `parseISO` rather than the `Date` constructor because `parseISO` implements
 * ISO-8601 strictly, whereas `new Date(...)` falls back to implementation-defined parsing for
 * anything non-standard and can yield a plausible-looking but wrong instant.
 *
 * @param value - An ISO-8601 string, a `Date`, `null` or `undefined`.
 * @returns A `Date` that is guaranteed to be valid, or `null`.
 */
function toValidDate(value: DateInput): Date | null {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = typeof value === 'string' ? parseISO(value) : value;

  // `isValid` covers both an unparseable string (`parseISO` yields an Invalid Date whose time is
  // NaN) and a `Date` the caller had already broken. Returning `null` here is what prevents the
  // literal string "Invalid Date" from ever reaching the DOM.
  return isValid(parsed) ? parsed : null;
}

/**
 * Formats an instant as an absolute, human-readable date, resolved in UTC.
 *
 * This is the byline and post-card form — the label a reader sees next to an author's name and in
 * an admin table's "published" column. The month name comes from the pinned locale and the
 * calendar fields from {@link FORMAT_TIME_ZONE}, so the output depends only on the argument: the
 * same instant produces the same string on the server, in every visitor's browser and in every
 * test, whatever timezone the host is configured for. The assembled order is `day month year`,
 * fixed here rather than taken from the locale's own pattern.
 *
 * The consequence worth stating plainly: the day shown is the UTC calendar day, so an instant at
 * `2025-03-12T02:00:00Z` reads `12 March 2025` for every reader, including one in New York for
 * whom it was still the evening of the 11th locally. That is the deliberate trade — one instant
 * with one label everywhere, over a locally-correct label that changes across hydration.
 *
 * @param value - The instant to format; typically a `published_at`, `created_at` or `updated_at`
 * value straight off the wire.
 * @returns A date such as `'12 March 2025'`, or {@link EMPTY_VALUE} when `value` is absent or
 * unparseable.
 *
 * @example
 * ```ts
 * formatDate('2025-03-12T09:30:00Z'); // '12 March 2025'
 * formatDate('2025-03-12T02:00:00Z'); // '12 March 2025' — UTC day, in every timezone
 * formatDate(null);                   // '' — an unpublished draft
 * formatDate('not-a-date');           // '' — never 'Invalid Date'
 * ```
 */
export function formatDate(value: DateInput): string {
  const date = toValidDate(value);

  if (date === null) {
    return EMPTY_VALUE;
  }

  // `formatToParts` rather than `format`, so the three fields are recombined in an order this
  // module fixes. The literal parts a locale would insert - a comma between month and year in
  // en-US, for instance - are discarded along with everything that is not one of the three
  // fields requested, which is what keeps the output stable across ICU versions.
  const parts = dateFieldFormatter.formatToParts(date);
  const day = parts.find((part) => part.type === 'day')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const year = parts.find((part) => part.type === 'year')?.value ?? '';

  return `${day} ${month} ${year}`;
}

/**
 * Formats an instant as elapsed time in words.
 *
 * Used where recency matters more than the exact instant — chiefly comment timestamps, where
 * "3 days ago" is more useful at a glance than "12 March 2025". The suffix is always applied, so
 * the result reads as a direction in time ("3 days ago", "in 3 days") rather than a bare
 * duration.
 *
 * ### `referenceDate` is required, and that is the whole design
 *
 * A relative label is a function of two instants, and reading the second one from the clock would
 * make this function impure — which breaks it in the one place it is most used. The same comment
 * is rendered twice for one visitor: once on the server, once again when React hydrates. Two
 * different clocks produce two different strings, and where the elapsed time sits near one of
 * date-fns' distance boundaries the two are visibly different words, not merely different
 * milliseconds: "about 1 hour ago" against "about 2 hours ago". React reports that as a hydration
 * mismatch and replaces the markup.
 *
 * Requiring the argument moves that decision to the caller, who is the only one able to make it
 * correctly — a Server Component captures one instant and passes it to the client island that
 * re-renders the same list, or a client island that genuinely wants a live label captures
 * `Date.now()` in an effect and re-renders on a timer, after hydration, where a changing value is
 * intended rather than accidental. A test simply passes the instant it wants.
 *
 * A `referenceDate` that is absent or unparseable yields {@link EMPTY_VALUE}, exactly as an absent
 * subject does: with no instant to measure against there is no true statement to make, and
 * silently substituting the clock is the defect this signature removes.
 *
 * @param value - The instant to describe.
 * @param referenceDate - The instant to measure against. Required.
 * @returns A phrase such as `'3 days ago'`, or {@link EMPTY_VALUE} when either instant is absent
 * or unparseable.
 *
 * @example
 * ```ts
 * // Deterministic by construction: both instants are arguments.
 * formatRelativeTime('2025-03-12T09:30:00Z', '2025-03-15T09:30:00Z'); // '3 days ago'
 * formatRelativeTime('2025-03-18T09:30:00Z', '2025-03-15T09:30:00Z'); // 'in 3 days'
 * formatRelativeTime('2025-03-12T09:30:00Z', undefined);              // ''
 * formatRelativeTime(undefined, '2025-03-15T09:30:00Z');              // ''
 * ```
 */
export function formatRelativeTime(value: DateInput, referenceDate: DateInput): string {
  const date = toValidDate(value);
  const reference = toValidDate(referenceDate);

  if (date === null || reference === null) {
    return EMPTY_VALUE;
  }

  // Subject first, reference second: that argument order is what makes a past instant read
  // "3 days ago" rather than "in 3 days". `formatDistance` measures the interval between two
  // instants, so unlike a calendar-field format it carries no timezone dependency of its own.
  return formatDistance(date, reference, { addSuffix: true });
}

/**
 * Produces the machine-readable ISO-8601 form of an instant.
 *
 * This is the value that belongs in the `dateTime` attribute of a `<time>` element and in the
 * `datePublished` / `dateModified` properties of `BlogPosting` structured data. Emitting it
 * alongside every human-readable label is what lets assistive technology and crawlers read an
 * unambiguous instant instead of a formatted phrase they have to guess at.
 *
 * The result is normalised to UTC, which makes it byte-identical on the server and in the
 * browser — see the module documentation for why that matters.
 *
 * @param value - The instant to normalise.
 * @returns An ISO-8601 instant such as `'2025-03-12T09:30:00.000Z'`, always accepted by
 * `Date.parse`; or {@link EMPTY_VALUE} when `value` is absent or unparseable, so a `<time>`
 * element is never emitted with a malformed attribute.
 *
 * @example
 * ```tsx
 * const machine = formatMachineDate(post.published_at);
 * const human = formatDate(post.published_at);
 * // The guard is what keeps a draft from rendering <time dateTime="">.
 * {machine && <time dateTime={machine}>{human}</time>}
 * ```
 */
export function formatMachineDate(value: DateInput): string {
  const date = toValidDate(value);

  if (date === null) {
    return EMPTY_VALUE;
  }

  return date.toISOString();
}

/**
 * Formats a non-negative tally for display, abbreviating large values.
 *
 * Applies to every count the API exposes: `view_count` on a post, `like_count` on a like summary
 * and `post_count` on a category. Values below {@link COMPACT_COUNT_THRESHOLD} are rendered
 * exactly; at or above it they are abbreviated, so a popular post reads `'1.2K'` rather than
 * `'1,234'`. Rounding is delegated to `Intl.NumberFormat`, which is consistent across
 * magnitudes and needs no dependency.
 *
 * Zero is a real, meaningful tally — a post with no views yet — and renders as `'0'`, not as the
 * placeholder. Only genuinely absent input yields the placeholder. A negative or non-finite value
 * cannot be a tally, so it is treated as absent rather than displayed.
 *
 * @param value - The count to format.
 * @returns A display string such as `'0'`, `'999'`, `'1.2K'` or `'3.4M'`; or {@link EMPTY_VALUE}
 * when `value` is absent, negative or non-finite.
 *
 * @example
 * ```ts
 * formatCount(0);       // '0'
 * formatCount(999);     // '999'
 * formatCount(1234);    // '1.2K'
 * formatCount(3400000); // '3.4M'
 * formatCount(null);    // ''
 * ```
 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
    return EMPTY_VALUE;
  }

  // Counts are integral on the wire; flooring makes a stray fractional value render sensibly
  // instead of as '1.5' in a place that only ever means "how many".
  const count = Math.floor(value);

  return count < COMPACT_COUNT_THRESHOLD
    ? exactCountFormatter.format(count)
    : compactCountFormatter.format(count);
}

/**
 * Estimates how many whole minutes a body of text takes to read.
 *
 * Words are counted by collapsing runs of whitespace, and the quotient is rounded up, so any
 * non-empty text costs at least one minute. That floor is what stops a two-word post from
 * advertising "0 min read". The reading speed is {@link WORDS_PER_MINUTE}.
 *
 * **Note the payload asymmetry.** `content` is present on the detail representation of a post but
 * is deliberately omitted from the list representation, so that feed responses stay small. A
 * card-level caller therefore has no `content` to pass: it should either pass the `excerpt` it
 * does have — accepting that the estimate is then derived from the summary — or omit the reading
 * time affordance entirely. Only a post-detail view can produce a faithful figure.
 *
 * Genuinely empty input returns `0` rather than `1`: the one-minute floor exists so that text
 * which *rounds* to zero still reads as a minute, not so that the absence of text implies
 * reading effort. Callers rendering a label should use {@link formatReadingTime}, which maps that
 * `0` onto the placeholder.
 *
 * @param content - The body text to measure.
 * @returns A whole number of minutes: at least `1` for any non-empty text, `0` when there is no
 * text at all.
 *
 * @example
 * ```ts
 * estimateReadingTime('Hi there');        // 1 — the floor
 * estimateReadingTime(longArticleBody);   // e.g. 7
 * estimateReadingTime('');                // 0
 * estimateReadingTime(null);              // 0
 * ```
 */
export function estimateReadingTime(content: string | null | undefined): number {
  if (content === null || content === undefined) {
    return 0;
  }

  const words = content
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;

  if (words === 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

/**
 * Renders the reading-time label shown beside a post's byline.
 *
 * A thin presentation-free wrapper over {@link estimateReadingTime}, so the wording of the label
 * is declared in exactly one place rather than reassembled at each call site. Because the
 * estimate is floored at one minute for any real text, this never produces "0 min read"; when
 * there is no text to measure it produces the placeholder so the affordance disappears instead of
 * rendering an empty count.
 *
 * The same payload asymmetry documented on {@link estimateReadingTime} applies here.
 *
 * @param content - The body text to measure.
 * @returns A label such as `'7 min read'`, or {@link EMPTY_VALUE} when there is no text.
 *
 * @example
 * ```ts
 * formatReadingTime('Hi there'); // '1 min read'
 * formatReadingTime(null);       // ''
 * ```
 */
export function formatReadingTime(content: string | null | undefined): string {
  const minutes = estimateReadingTime(content);

  if (minutes === 0) {
    return EMPTY_VALUE;
  }

  return `${String(minutes)} ${READING_TIME_SUFFIX}`;
}
