/**
 * The tier's single rule for turning an untrusted value into one path segment.
 *
 * Every wrapper under `@/lib/api` and every canonical-URL builder in `@/lib/seo` interpolates a
 * caller-supplied identifier - a UUID, a slug, a handle - into a request path or a public URL.
 * `@/lib/api/client` interpolates the composed path into the request URL verbatim, and it is right
 * to: encoding a whole path would destroy its separators. Encoding each *segment* is therefore the
 * composing module's job, and before this module existed each composer did it slightly differently.
 * Five of them percent-encoded and stopped there, which contains a stray `/`, `?` or `#` but leaves
 * `.` and `..` intact - and those two are not characters to escape, they are instructions the URL
 * grammar itself acts on. `encodeURIComponent('..')` returns `'..'`.
 *
 * That difference is the whole reason this module exists. A path built as `/posts/../users/me`
 * addresses a different endpoint than the one the call site names, on a route the caller may hold a
 * credential for; the request succeeds, so nothing reports an error, and the call site's own text
 * still reads as though it addressed a post. One helper, one rule, seven call sites.
 *
 * ## What this module is not
 *
 * - **Not a format check.** Whether an identifier names a real record, and whether it is a
 *   well-formed UUID or a legal slug, is decided by the service and reported as `404` or `422`.
 *   A second copy of that rule here would be the copy that has to be found when identity changes.
 * - **Not a normaliser.** Case is never folded: the service's `citext` columns resolve `Alice` and
 *   `alice` through their own unique index, and folding here would duplicate a guarantee it could
 *   then drift from. Whitespace is trimmed only where a caller asks for it - see
 *   {@link SegmentWhitespacePolicy}.
 * - **Not transport.** No request is issued, no status is interpreted, no error is mapped.
 * - **Not dependent on anything.** No import, so the transport wrappers stay free of the styling
 *   packages `@/lib/utils` pulls in, and a Server Component, a client island and the Edge runtime
 *   can all evaluate it.
 */

/* -------------------------------------------------------------------------------------------------
 * The rule
 * ---------------------------------------------------------------------------------------------- */

/**
 * The two relative-path instructions of RFC 3986 §3.3, which percent-encoding does not touch.
 *
 * Matched against the trimmed value so ` .. ` is refused too: surrounding whitespace is discarded
 * by neither the URL grammar nor a server's path normaliser, and a segment that is a dot segment
 * once its padding is ignored is a dot segment.
 */
const DOT_SEGMENT_PATTERN = /^\.{1,2}$/;

/**
 * Whether the value a caller hands in is sent as given or with its padding removed.
 *
 * `'verbatim'` is the default because it never repairs a caller's value: a handle or slug carrying
 * stray whitespace reaches the service intact and is answered with an honest `404`, rather than
 * being quietly turned into a different, existing record. `'trim'` exists for the one place where
 * the value is not a lookup key but published output - a canonical URL must not carry `%20`
 * padding, because that URL is what a crawler records as the address of the page.
 */
export type SegmentWhitespacePolicy = 'verbatim' | 'trim';

/**
 * What the thrown message needs in order to name the mistake precisely.
 *
 * A rejection that says which argument of which call was wrong is the difference between a one-line
 * fix and a search, which matters here because the values reaching this boundary come from route
 * parameters and search parameters - both typed `string` and both legitimately `undefined` in fact.
 */
export interface PathSegmentContext {
  /** The calling export, e.g. `'likePost'`. Named first in the message. */
  readonly operation: string;
  /** The offending parameter, e.g. `'postId'`. */
  readonly parameterName: string;
  /**
   * One sentence telling the caller where a correct value comes from, appended verbatim. Omit it
   * only when no such sentence can be written.
   */
  readonly hint?: string;
  /** Whitespace handling; defaults to `'verbatim'`. */
  readonly whitespace?: SegmentWhitespacePolicy;
}

/**
 * Compose the message once, so all seven call sites report an unusable segment identically.
 */
function segmentMessage(context: PathSegmentContext, value: unknown, problem: string): string {
  const hint = context.hint === undefined ? '' : ` ${context.hint}`;

  return (
    `${context.operation}: ${context.parameterName} ${problem}, received ` +
    `${JSON.stringify(value)}. A request path cannot be composed from it.${hint}`
  );
}

/**
 * Percent-encode one path segment, refusing the values that would address something else.
 *
 * Three outcomes, and only the first is a value:
 *
 * 1. A usable value is returned percent-encoded. For a canonical UUID that is a no-op, and for a
 *    slug or a handle very nearly one, since both are URL-safe by construction. It is applied
 *    regardless, so a value that is not what it claims to be - a raw title passed where a slug was
 *    expected - stays inside its own segment and produces an honest `404` instead of restructuring
 *    the request.
 * 2. An absent, empty or whitespace-only value throws. It would compose `/posts//like` or
 *    `/comments/`, which addresses a collection rather than a member: the answer is a different
 *    shape entirely, and reading a member off it yields `undefined` rather than an error.
 * 3. A dot segment throws. This is the case percent-encoding cannot cover, because `.` and `..`
 *    are already URL-safe: they are resolved by the URL grammar before the server ever sees a
 *    path, so they silently retarget the request at a sibling route.
 *
 * @param value - The candidate segment, as the caller supplied it. Typed `string` but validated at
 * run time, because these values arrive from URLs where the type is an assertion rather than a fact.
 * @param context - How to name the mistake, and whether to trim. See {@link PathSegmentContext}.
 * @returns The percent-encoded segment, ready to interpolate between two slashes.
 * @throws {TypeError} When the value is not a usable string, is blank, or is `.` or `..`. Callers
 * whose exports are `async` surface this as a rejected promise, which is why those exports are
 * declared `async` even when their body is a single expression - one error channel, not two.
 */
export function encodePathSegment(value: string, context: PathSegmentContext): string {
  if (typeof value !== 'string') {
    throw new TypeError(segmentMessage(context, value, 'must be a string'));
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    throw new TypeError(segmentMessage(context, value, 'must be a non-blank identifier'));
  }

  if (DOT_SEGMENT_PATTERN.test(trimmed)) {
    throw new TypeError(
      segmentMessage(
        context,
        value,
        'must not be a relative-path segment ("." or ".."), which the URL grammar resolves ' +
          'against the surrounding path instead of treating as a name',
      ),
    );
  }

  return encodeURIComponent(context.whitespace === 'trim' ? trimmed : value);
}
