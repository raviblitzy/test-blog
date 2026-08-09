/**
 * The tier's single unit of string length, and the one truncation primitive built on it.
 *
 * Every length the client tier enforces or respects is a length the service defined, and the service
 * is written in Python. `len()` counts **code points**; JavaScript's `String.prototype.length`
 * counts **UTF-16 code units**. For all-ASCII text the two agree, which is exactly why the
 * divergence survives review: it is invisible until a reader types a character above `U+FFFF`.
 *
 * Two failure modes follow, and both were observed against the running service:
 *
 * - **A ceiling refuses text the service accepts.** A 127-code-point passphrase in an astral script
 *   measures 254 to `length`, so a `max(128)` check written against `length` rejects a password the
 *   service would have taken.
 * - **A floor admits text the service refuses.** An 11-code-point one measures 22, so a `min(12)`
 *   check written against `length` waves through a password the service then rejects - the round
 *   trip the client-side check existed to avoid.
 *
 * The same arithmetic governs truncation. Cutting a string at a UTF-16 index can land *between* the
 * two halves of a surrogate pair, and the result is a string ending in an unpaired surrogate: it is
 * not valid UTF-8 when serialised, renders as a replacement character, and appears in a meta
 * description or a social card - published output a reader and a crawler both see.
 *
 * ## Scope of the guarantee, stated plainly
 *
 * These functions count and cut **code points**, because that is the unit the service's constraints
 * are expressed in, and matching the service is the entire point. A code point is not always a
 * user-perceived character: a flag, a skin-toned emoji or a combining sequence spans several, and
 * {@link sliceByCodePoints} may divide one such cluster. What it will never do is leave an unpaired
 * surrogate. Grapheme segmentation (`Intl.Segmenter`) is deliberately not used - it would introduce
 * a *third* notion of length, disagreeing with the service, and this module exists to have one.
 *
 * No import: the validators, `@/lib/seo` and any Server Component can all use it.
 */

/**
 * How long a string is *in characters*, counted the way the service counts.
 *
 * Spreading a string iterates it by code point, which is the unit `len()` uses. Every bound the
 * validators under `@/lib/validation` enforce is applied through this function rather than through
 * zod's `.min()`/`.max()`, whose string checks read `length`.
 *
 * @param value - Any string.
 * @returns The number of code points in it.
 */
export function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * The first `limit` code points of a string, never splitting a surrogate pair.
 *
 * Iterating by code point and accumulating each one's UTF-16 width gives a cut index that is always
 * on a code-point boundary, so the returned string is always well-formed. Text already within the
 * limit is returned unchanged, and the function performs no whitespace handling and appends nothing
 * - a caller that wants an ellipsis or a word boundary layers that on top, which is what
 * `@/lib/seo` does.
 *
 * @param value - The text to shorten.
 * @param limit - The maximum number of code points to keep. Zero or negative yields `''`.
 * @returns A prefix of `value` at most `limit` code points long.
 */
export function sliceByCodePoints(value: string, limit: number): string {
  if (limit <= 0) {
    return '';
  }

  let kept = 0;
  let index = 0;

  for (const codePoint of value) {
    if (kept >= limit) {
      break;
    }

    // `codePoint.length` is 2 for an astral character and 1 otherwise, so the running index only
    // ever lands on a boundary between whole code points.
    index += codePoint.length;
    kept += 1;
  }

  return index >= value.length ? value : value.slice(0, index);
}
