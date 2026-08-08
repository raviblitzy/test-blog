// Reading-time label - the "N min read" affordance in the post-detail byline.
//
// This component is deliberately trivial, and keeping it trivial is the point. Three decisions
// below look like omissions and are each load-bearing; the notes exist so none of them gets
// "improved" away.
//
// ---------------------------------------------------------------------------
// 1. THE PROP IS A RAW STRING, NOT A POST
//
// `content: string | null | undefined` - never `PostSummary`, never `PostDetail`, never a `post`
// object. That is a type-level guard against a real payload asymmetry: the API's list
// representation of a post OMITS `content` so feed responses stay small, and only the detail
// representation carries it. A component typed against the resource would therefore compile
// happily at a call site that has no body text to measure and silently render an estimate of
// nothing. Taking the string forces the caller to produce the field, which only the post-detail
// route can.
//
// The same asymmetry is why nothing under src/components/blog/post-card.tsx imports this file:
// a feed card has no `content`, so it has no faithful estimate to show and shows none.
//
// ---------------------------------------------------------------------------
// 2. NO `'use client'` DIRECTIVE - THIS IS A SHARED MODULE
//
// There is no state, no effect, no hook and no browser API here, so the file needs no client
// boundary and must not declare one. src/app/blog/[slug]/page.tsx is a Server Component, so a
// directive-free child renders on the server and its text lands in the INITIAL HTML response -
// which is precisely what the SEO requirement depends on, since a crawler must see the byline
// without executing client JavaScript. Adding `'use client'` here would pull the post page's
// metadata strip behind hydration for no benefit whatsoever.
//
// The `Clock` icon is the one nuance. lucide-react ships its icon factory with its own
// `'use client'`, so the `<svg>` is a client reference rather than server output. That is
// harmless and does not change the paragraph above: a Server Component may render a Client
// Component, Next.js server-renders it into the same initial HTML, and the estimate itself - the
// part that carries meaning - is text emitted by THIS module on the server.
//
// ---------------------------------------------------------------------------
// 3. THE ARITHMETIC LIVES IN src/lib/format.ts, NOT HERE
//
// No word counting, no division, no rounding and no reading-speed constant appears in this file.
// `formatReadingTime` owns all of it, which keeps the calculation unit-testable without a DOM and
// keeps the wording of the label declared exactly once. This module's entire job is to put the
// string that function returns into accessible markup.

import { Clock } from 'lucide-react';

import { EMPTY_VALUE, formatReadingTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Props for {@link ReadingTime}.
 *
 * Kept local rather than exported: the only consumer renders `<ReadingTime content={...} />` and
 * needs no reference to the type, so exporting it would widen the module's public surface with
 * nothing to gain. Export it the day a wrapper genuinely needs to re-declare the shape.
 */
interface ReadingTimeProps {
  /**
   * The post body to measure - the `content` field of a post's DETAIL representation.
   *
   * `null` and `undefined` are legitimate inputs rather than error cases: a caller may hold a post
   * whose body has not loaded, and the list representation carries no `content` at all. Both are
   * handled by rendering nothing; see {@link ReadingTime}.
   */
  content: string | null | undefined;

  /**
   * Optional classes merged over the component's own.
   *
   * Composed through `cn`, so a caller-supplied utility wins its Tailwind property group - a
   * byline that runs at a different type scale can pass `text-xs` and have it take effect rather
   * than collide. Intended for spacing and type adjustments only; a colour override would step
   * outside the semantic token this component is built on.
   */
  className?: string;
}

/**
 * Renders the estimated reading time for a post body as muted inline metadata.
 *
 * Sits in the post-detail byline strip beside the author and the publication date. The estimate is
 * real text in the DOM, so a screen reader announces it; the clock is decorative and hidden from
 * assistive technology, so the meaning never depends on the icon.
 *
 * ### Absent content renders nothing
 *
 * `formatReadingTime` is a total function - it returns {@link EMPTY_VALUE} rather than throwing
 * when there is no text to measure, which covers `null`, `undefined`, `''` and whitespace-only
 * input alike. This component maps that one case onto `null`, so the affordance disappears
 * cleanly instead of leaving a stray clock icon with no label sitting in the byline. It
 * deliberately does NOT invent a second placeholder: a dash or a "0 min read" would both be
 * claims the data does not support.
 *
 * ### Every value resolves to a design token
 *
 * `text-muted-foreground` is the semantic token for secondary text - timestamps, reading time,
 * bylines - and carries the light/dark pair, so this component themes with no conditional logic.
 * The type size comes from the `--text-*` scale, the gap and the icon size from the `--spacing`
 * scale. Nothing here is a literal, and the icon inherits its colour through `currentColor`.
 *
 * The root is an inline-level `<span>`: this is metadata inside a line of other metadata, so it
 * introduces no block box and sets no margin of its own, leaving spacing to the byline that owns
 * the layout. It sets no width and no breakpoint variant either - it is width-agnostic by design.
 *
 * @param props - See {@link ReadingTimeProps}.
 * @returns The label element, or `null` when there is no text to measure.
 *
 * @example Post-detail byline
 * ```tsx
 * <ReadingTime content={post.content} />
 * // Renders a hidden clock glyph followed by the visible text "7 min read".
 * ```
 *
 * @example Absent body - renders nothing at all
 * ```tsx
 * <ReadingTime content={null} />
 * // null
 * ```
 */
export function ReadingTime({ content, className }: ReadingTimeProps): React.JSX.Element | null {
  const label = formatReadingTime(content);

  // Compared against the exported constant rather than a bare `''` so this guard is pinned to the
  // format module's documented placeholder convention: if that convention ever changes, the guard
  // follows it instead of silently letting a placeholder through into the byline.
  if (label === EMPTY_VALUE) {
    return null;
  }

  return (
    <span
      className={cn(
        'text-muted-foreground inline-flex items-center gap-1.5 text-sm whitespace-nowrap',
        className,
      )}
    >
      {/*
       * Purely decorative. `aria-hidden` is explicit rather than left to lucide-react's own
       * default, because the requirement is on this markup, not on a library internal - and the
       * icon must never contribute an accessible name that duplicates the text beside it.
       *
       * Sized with a utility, never lucide's `size` prop: that prop takes a NUMBER OF PIXELS,
       * which would be exactly the hardcoded presentation value the token discipline forbids.
       * `size-3.5` resolves through the `--spacing` scale and, being CSS, overrides the width and
       * height attributes the icon renders by default. `shrink-0` keeps it from being squeezed
       * when the byline it sits in runs short of room.
       */}
      <Clock aria-hidden="true" className="size-3.5 shrink-0" />
      {label}
    </span>
  );
}
