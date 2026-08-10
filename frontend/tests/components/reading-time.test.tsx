// Component test - src/components/blog/reading-time.tsx
//
// ---------------------------------------------------------------------------
// WHAT IS UNDER TEST, AND WHAT DELIBERATELY IS NOT
//
// `ReadingTime` is display-only: it puts the string `formatReadingTime` returns into accessible
// markup, and does nothing else. The words-per-minute arithmetic - the word count, the division,
// the rounding up, and the reading-speed constant itself - lives in src/lib/format.ts. None of it
// is re-derived here, and that single decision shapes every assertion below:
//
//   * Every positive expectation is `formatReadingTime(content)` CALLED ON THE SAME INPUT the
//     component was given. Never a literal such as '4 min read', and never a word count divided by
//     an assumed speed. A test that hard-coded either would freeze a constant this component does
//     not own, and would then have to be edited the day the estimate is retuned - which is exactly
//     the coupling the layer split exists to prevent. Comparing the component against the library
//     leaves both free to move together, and it still fails loudly if the component ever starts
//     computing an estimate of its own instead of displaying the one it is handed.
//   * The absent-content expectations are pinned to `EMPTY_VALUE`, the format module's documented
//     placeholder, for the same reason. The component's guard reads that exported constant, so this
//     file reads it too rather than guessing at what "no estimate" looks like.
//
// ---------------------------------------------------------------------------
// NO CLASS NAMES, NO COMPUTED STYLES, NO SNAPSHOTS
//
// The component's visuals are the `text-muted-foreground` semantic token and the `--text-*` scale.
// Nothing here asserts on any of that. The token layer owns those values and is free to change
// them, so a palette edit or a type-scale change must not be able to fail this suite. This file
// therefore contains no class-name matcher, no read of a rendered class attribute, no class-based
// selector query, no computed-style read and no snapshot - assertions target visible text and the
// accessible tree instead. The one place a class string appears at all is as INPUT, in the case
// that checks the optional styling prop is accepted, and even there the merged result goes
// unasserted.
//
// ---------------------------------------------------------------------------
// WHY TEXT CONTENT RATHER THAN AN ACCESSIBLE NAME
//
// The component's root is a plain inline `<span>`: it carries no role and no label, so there is no
// accessible name to assert - name-from-content does not apply to a generic element. The
// reader-perceivable property is the text, and it is checked two complementary ways. `getByText`
// proves the estimate is discoverable as visible text at all, because Testing Library matches on an
// element's own text children. An exact comparison of the rendered subtree's `textContent` then
// proves nothing else is in there, which is the observable consequence of the decorative `Clock`
// carrying `aria-hidden`: an icon that leaked a `<title>` or a glyph would widen that string and
// fail the comparison.
//
// ---------------------------------------------------------------------------
// NO REQUEST INTERCEPTION, AND NOTHING RE-REGISTERED FROM THE BOOTSTRAP
//
// This component performs no HTTP and imports no `@/lib/api/*` module, so there is nothing here to
// intercept: no interception server, no handler list, no lifecycle hooks, and no import of
// tests/msw/handlers.ts, which owns none of those anyway. A request escaping from this suite would
// fail against the unbound loopback URL frontend/vitest.config.ts pins, and that failure is the
// signal that the component has grown a dependency it must not have.
//
// The DOM assertion matchers and the between-test unmount both arrive from
// frontend/vitest.setup.ts, so neither is registered again here. The Vitest API, by contrast, IS
// imported explicitly rather than taken from `globals: true`, because frontend/tsconfig.json
// declares no Vitest global types and `tsc --noEmit` is a blocking gate that would otherwise report
// `Cannot find name 'describe'` on a file that runs perfectly well.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ReadingTime } from '@/components/blog/reading-time';
import { EMPTY_VALUE, formatReadingTime } from '@/lib/format';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 *
 * Generated, never pasted. Prose written out by hand invites a reader to count its words and then
 * to "check" an expectation against that count, which is the arithmetic this file must not contain.
 * Building bodies by repetition keeps the fixtures obviously uninteresting: their SHAPE matters
 * (Markdown, multi-paragraph, newline-separated), their LENGTH does not, because every expectation
 * is derived by calling the estimator on the very same string that was rendered.
 * ---------------------------------------------------------------------------------------------- */

/** One sentence of body copy, repeated to build bodies of different lengths. */
const SENTENCE = 'A boundary that is cheap to cross is a boundary that has stopped being one.';

/** A Markdown heading, so a generated body has the structure a real post body arrives with. */
const HEADING = '## A section heading';

/** Sentences per generated paragraph. Chosen for readable output, not for any target estimate. */
const SENTENCES_PER_PARAGRAPH = 6;

/**
 * Builds a Markdown body of `paragraphCount` paragraphs.
 *
 * Multi-paragraph and Markdown on purpose: a real `content` field carries a heading and blank
 * lines, and those newlines exercise the whitespace collapsing the estimator performs on its way to
 * a word count. Six paragraphs is comfortably a several-hundred-word article; two is a short one.
 * Neither number is load-bearing, because no assertion below depends on the estimate that results.
 */
function buildMarkdownBody(paragraphCount: number): string {
  const paragraph = Array.from({ length: SENTENCES_PER_PARAGRAPH }, () => SENTENCE).join(' ');
  const paragraphs = Array.from({ length: paragraphCount }, () => paragraph);

  return [HEADING, ...paragraphs].join('\n\n');
}

/**
 * A body of exactly `wordCount` single-token words.
 *
 * One space between one-word tokens, so the estimator's whitespace collapsing counts exactly what was
 * asked for and the boundary cases below are about ROUNDING rather than about parsing.
 */
function buildBodyOfWordCount(wordCount: number): string {
  return Array.from({ length: wordCount }, (_unused, index) => `word${String(index)}`).join(' ');
}

/**
 * Literal labels at the four boundaries where the documented arithmetic decides the answer.
 *
 * Worked out by hand from the contract in `@/lib/format`: 200 words a minute, `Math.ceil`, floored at
 * one whole minute so a very short post never advertises "0 min read". Nothing here calls the
 * estimator, which is the entire point - see the case that consumes this table.
 */
const INDEPENDENT_BOUNDARIES: readonly (readonly [string, number])[] = [
  ['1 min read', 1],
  ['1 min read', 200],
  ['2 min read', 201],
  ['2 min read', 400],
];

describe('ReadingTime', () => {
  it('renders the label the format module produces for a full-length body', () => {
    const content = buildMarkdownBody(6);
    const expected = formatReadingTime(content);

    // The premise, asserted rather than assumed: this fixture is real body text, so the estimator
    // produced a real label instead of its placeholder. Without this line a regression that made
    // every estimate empty would leave the assertions below trivially satisfiable.
    expect(expected).not.toBe(EMPTY_VALUE);

    render(<ReadingTime content={content} />);

    const label = screen.getByText(expected);

    expect(label).toBeVisible();
    expect(label.textContent).toBe(expected);
  });

  it('renders the label the format module produces for a single short sentence', () => {
    const expected = formatReadingTime(SENTENCE);

    // Short text still earns an estimate - the estimator floors any non-empty body at a whole
    // minute - so this label is non-empty for the same reason the one above is, and the component
    // must display it rather than suppress it as though there were nothing to measure.
    expect(expected).not.toBe(EMPTY_VALUE);

    render(<ReadingTime content={SENTENCE} />);

    const label = screen.getByText(expected);

    expect(label).toBeVisible();
    expect(label.textContent).toBe(expected);
  });

  it('renders nothing when content is null', () => {
    // `formatReadingTime` is total over absent input: it answers with its documented placeholder
    // rather than throwing. That is the premise the component's guard reads, and pinning it here
    // means a change to the placeholder convention fails on THIS line - naming the cause - instead
    // of surfacing as an unexplained "expected the container to be empty" below. `undefined` and
    // the empty string collapse onto the same placeholder, which is why the two tests that follow
    // expect the same outcome.
    expect(formatReadingTime(null)).toBe(EMPTY_VALUE);

    const { container } = render(<ReadingTime content={null} />);

    // Nothing at all - the component maps the placeholder onto `null` rather than inventing a dash
    // or a "0 min read", and rather than leaving an orphaned clock icon with no label beside it.
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when content is undefined', () => {
    // Asserted separately from the `null` case because the prop type admits both, and a guard
    // written as a truthiness check, an `!= null`, or a `?? ''` default would treat them
    // differently. Both arrive in practice: a body that has not loaded, and a list representation
    // that carries no `content` field at all.
    const { container } = render(<ReadingTime content={undefined} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when content is an empty string', () => {
    // The third absent form, and the one a `content == null` guard alone would let through: an
    // empty body is present but has nothing to measure, so the affordance must disappear exactly as
    // it does for the two nullish cases.
    const { container } = render(<ReadingTime content="" />);

    expect(container).toBeEmptyDOMElement();
  });

  it.each(INDEPENDENT_BOUNDARIES)(
    'renders the literal label %s for a body of the stated length',
    (expectedLabel, wordCount) => {
      // AN INDEPENDENT ORACLE, and the one group of cases in this file that does not call
      // `formatReadingTime` to decide what it expects. The label is a literal a person worked out from
      // the documented contract - 200 words a minute, rounded UP, floored at one whole minute - so
      // these cases disagree with the estimator if the estimator changes, which is precisely what the
      // derived cases above cannot do.
      //
      // The tension with the header's rule is deliberate and worth stating: comparing against the
      // library keeps the two layers free to move together, and that is right for the DISPLAY contract
      // this file mostly tests. But it also means a silent change to the reading speed - a retune from
      // 200 to 250 - would pass every case here while every published article's estimate moved. These
      // four literals are the tripwire for that, sited at the boundaries where rounding decides the
      // answer: one word and exactly 200 both round to a single minute, 201 crosses into two, and 400
      // lands exactly on two rather than tipping into three.
      const content = buildBodyOfWordCount(wordCount);

      render(<ReadingTime content={content} />);

      expect(screen.getByText(expectedLabel)).toBeVisible();
    },
  );

  it('renders nothing for a body that is only whitespace', () => {
    // Newlines, spaces and tabs, which is what an author leaves behind after clearing a draft body -
    // and a case the empty-string test does not reach, because the estimator's guard is a word count
    // taken AFTER collapsing whitespace rather than a length check on the raw string. Zero words means
    // no estimate, and no estimate must mean no markup rather than "0 min read" or a bare clock.
    const { container } = render(<ReadingTime content={'  \n\t \r\n  '} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/min read/)).toBeNull();
  });

  it('hides the decorative clock from assistive technology directly', () => {
    const content = buildMarkdownBody(2);
    const { container } = render(<ReadingTime content={content} />);

    // The neighbouring case asserts the CONSEQUENCE - that the icon contributes no text. This one
    // asserts the MECHANISM, because the consequence holds for a reason that would survive the
    // mechanism being lost: an `<svg>` contributes no characters either way, so a clock that started
    // announcing itself through a `role` or a `<title>` would still leave `textContent` unchanged and
    // would still be announced to a screen reader as an unlabelled graphic beside the estimate.
    const glyphs = container.querySelectorAll('svg');
    expect(glyphs).toHaveLength(1);
    for (const glyph of glyphs) {
      expect(glyph).toHaveAttribute('aria-hidden', 'true');
      // No accessible name of its own, from any source: `role`, `aria-label` and an inner `<title>`
      // are the three ways one would arrive, and a decorative glyph must have none of them.
      expect(glyph).not.toHaveAttribute('role');
      expect(glyph).not.toHaveAttribute('aria-label');
      expect(glyph.querySelector('title')).toBeNull();
    }
  });

  it('keeps the decorative clock out of the rendered text', () => {
    const content = buildMarkdownBody(3);
    const expected = formatReadingTime(content);

    expect(expected).not.toBe(EMPTY_VALUE);

    const { container } = render(<ReadingTime content={content} />);

    // The estimate is the WHOLE of the rendered text. The clock is marked `aria-hidden` and an
    // `<svg>` contributes no characters of its own, so anything else that turned up here - a
    // `<title>` element, a glyph, a stray separator - would widen this string and fail. This is the
    // observable consequence of hiding the icon, asserted without reaching into the markup or the
    // class names that produce it.
    expect(container.textContent).toBe(expected);
    expect(screen.getByText(expected)).toBeVisible();
  });

  it('accepts a caller-supplied className and still renders the estimate', () => {
    const content = buildMarkdownBody(2);
    const expected = formatReadingTime(content);

    expect(expected).not.toBe(EMPTY_VALUE);

    // `text-xs` is the adjustment the component's own contract names: a byline running at a
    // different type scale passes a utility from the `--text-*` scale and expects it to win. What
    // the class merge actually produces is deliberately NOT asserted - that string belongs to the
    // token layer, and this test has to survive every future change to it. All that matters to the
    // component's contract is that supplying the optional prop does not cost the reader the label.
    render(<ReadingTime content={content} className="text-xs" />);

    expect(screen.getByText(expected)).toBeVisible();
  });
});
