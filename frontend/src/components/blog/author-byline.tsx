// Author byline - the attribution line that names who wrote a post and when it was published.
//
// This is the presentation half of the author-profile requirement: it is the only component that
// turns a `UserPublic` projection into a link to `/u/{username}`, and it is reused verbatim by the
// feed card, the post-detail header and the profile header. Everything below that looks like an
// omission is load-bearing, and the notes exist so none of it gets "improved" away.
//
// ---------------------------------------------------------------------------
// 1. NO `'use client'` DIRECTIVE - THIS IS A SHARED MODULE
//
// There is no state, no effect, no hook and no browser API here, so the file needs no client
// boundary and must not declare one. The post page, the feed and the profile page are Server
// Components, so a directive-free child renders on the server and its markup lands in the INITIAL
// HTML response - which is exactly what the SEO requirement depends on, because a crawler has to
// see the author link and the publication date without executing client JavaScript. Adding
// `'use client'` here would pull the byline of every card in the feed behind hydration for no
// benefit whatsoever.
//
// `Avatar` is the one nuance: `src/components/ui/avatar.tsx` carries its own `'use client'`,
// because Radix tracks image-loading status in React state. That is harmless and changes nothing
// above - a Server Component may render a Client Component, Next.js server-renders it into the
// same initial HTML, and every prop passed across the boundary here is a string. The parts that
// carry meaning - the link, the name and the `<time>` - are emitted by THIS module on the server.
//
// ---------------------------------------------------------------------------
// 2. THE AVATAR IS `aria-hidden`, AND THAT IS THE MOST IMPORTANT LINE IN THE FILE
//
// `AvatarFallback` renders the initials as TEXT, and the fallback is mounted whenever the image has
// not loaded - which includes the entirely ordinary case of an author with no `avatar_url` at all.
// Left visible to assistive technology, that text joins the accessible name of the link it sits
// inside, and the link announces as "AC Alice Chen": the name twice, once spelled out as letters.
//
// So the whole composition is marked `aria-hidden="true"`. The avatar primitive documents this as
// the caller's decision precisely because only the caller knows whether a visible name sits beside
// it, and here one always does. `alt=""` on the image says the same thing one layer in, for the
// case where the image HAS loaded and the fallback is gone.
//
// This is not a test accommodation. It is a real defect in a real browser for every author who has
// not set an avatar, which - on a fresh install - is all of them.
//
// ---------------------------------------------------------------------------
// 3. THE HREF IS THE RELATIVE ROUTE PATH, NEVER THE ABSOLUTE CANONICAL URL
//
// `profilePath()` from `@/lib/seo`, not `absoluteUrl(profilePath())`, and never a hand-built
// `` `/u/${username}` ``. Two separate reasons, both decisive:
//
//   * An absolute `https://…` href on a `next/link` defeats client-side navigation. The framework
//     treats it as an external destination, so the router is bypassed and the browser performs a
//     full document load - losing the prefetch, the shared layout and the scroll position.
//   * The path shape has exactly one definition. `@/lib/seo` owns `/u`, applies
//     `encodeURIComponent` to the segment, and is the module the sitemap and the canonical tags
//     read from too. A second spelling here is how an internal link and a canonical URL start
//     disagreeing about the same account.
//
// The absolute builder is not a worse choice for this file, it is a different tool: it exists for
// canonical tags, sitemap entries, JSON-LD and share URLs, where a bare path would be meaningless.
//
// A blank username makes `profilePath` THROW, and that is deliberately not caught here.
// `username` is `NOT NULL UNIQUE` in the service's schema and generated for every account, so a
// blank one means the payload is not the record the caller believed it had. Swallowing it would
// render a link to `/u/` - a wrong destination that looks right - whereas the throw surfaces at
// `src/app/error.tsx`, which is the boundary that exists for exactly this.
//
// ---------------------------------------------------------------------------
// 4. NO DATE ARITHMETIC AND NO STRING BUILDING LIVES HERE
//
// `@/lib/format` owns every calendar decision: the pinned locale, the UTC resolution that keeps
// server and client output byte-identical, and the ISO normalisation for the `dateTime` attribute.
// This module's whole job with a date is to put two strings that module returned into markup, and
// to decide whether the element appears at all. `date-fns` is deliberately not imported - it
// reaches this tier only through `@/lib/format`, so the formatting rules cannot fork.
//
// The publication date is genuinely optional. `published_at` is `null` for a draft - the service's
// own `CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)` constraint makes that pair
// exact - and the author dashboard renders drafts. A draft byline therefore carries no date. It
// does NOT silently substitute `created_at`, which would present a private authoring instant as a
// publication date, and it does NOT invent an "Unpublished" label: what to say about a draft is the
// consuming screen's editorial decision, not the byline's.
//
// ---------------------------------------------------------------------------
// 5. WHY A SIZE VARIANT HERE, WHEN `ui/avatar` DELIBERATELY HAS NONE
//
// The avatar primitive rejects a variant table because its size is ONE utility a caller can pass
// through `className`. A byline's scale is not one utility: it is the avatar diameter, the initials'
// type size, the text size and two gaps, which have to move together, and three of those live on
// elements a `className` on this component's root cannot reach. Without a variant the feed card,
// the post header and the profile header would each re-derive the same four coordinated utilities
// and drift apart the first time one of them was adjusted.
//
// So `size` is a `class-variance-authority` table - four of them, one per part, sharing one set of
// keys - and `className` remains the escape hatch for anything the table does not cover. Every
// value in every table resolves to a token from the engine's `--spacing` and `--text-*` scales.
//
// ---------------------------------------------------------------------------
// 6. DELIBERATELY ABSENT. Please do not add.
//
//   1. A heading element. A byline is metadata, and the page owns its heading hierarchy - one
//      `<h1>` per page, no skipped levels. An `<h3>` here "because it looks right" would inject a
//      phantom level into the outline of every feed card on the page.
//   2. A width, a max-width, a margin or a breakpoint variant. Three different containers render
//      this, and each owns its own layout. The root is width-agnostic and reflows by wrapping.
//   3. A `dark:` variant. Every token below is declared twice in `src/app/globals.css` - once at
//      the document root and again under `.dark` - so the byline re-themes with no conditional
//      here. A `dark:` class would be a second source of truth for the same decision.
//   4. Any literal colour, dimension, radius or font size. Every value resolves to a token.
//   5. An email address or a role badge. `UserPublic` withholds `email`, `role` and `is_active` on
//      purpose - that projection IS the confidentiality boundary - so this component cannot leak
//      them, and it must not grow a prop that lets a caller pass them in around the back.
//   6. `showAvatar` / `showDate` / `showBio` props. No named consumer needs them, and each would
//      be a second way to express something `className` or omitting `publishedAt` already covers.
//   7. A relative "2 days ago" label. `formatRelativeTime` requires an explicit reference instant
//      precisely so it stays pure; supplying one from the clock in a Server Component produces a
//      different string on the server than on the client and React reports it as a hydration
//      mismatch. A byline shows an absolute date for that reason.
//   8. A reading-time or category affordance. `ReadingTime` and the category badges are separate
//      components that the consuming screen composes BESIDE this one, which is what lets the feed
//      card show a byline with no reading time - it has no `content` field to measure.
//   9. `delayMs` on the fallback. Radix renders the fallback immediately without it, so an author
//      with no avatar never shows an empty hole; the trade is a brief flash of initials before a
//      fast image lands, and no layout shift either way because the root reserves its size.
//  10. A `try`/`catch` around `profilePath`. See note 3.

import Link from 'next/link';
import type { JSX } from 'react';

import { cva, type VariantProps } from 'class-variance-authority';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { EMPTY_VALUE, formatDate, formatMachineDate } from '@/lib/format';
import { profilePath } from '@/lib/seo';
import type { UserPublic } from '@/lib/types';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Variant tables
 *
 * Four tables rather than one, because the size decision has to reach four different elements and
 * a single class string can only reach one. They share the same variant keys and the same default,
 * so `size` stays one concept with one spelling; splitting them is a mechanical consequence of the
 * DOM, not a second vocabulary.
 *
 * The three steps are chosen against the three surfaces that render a byline, and the avatar
 * diameter is paired with an initials type size in every row - the fallback's text does not scale
 * with the circle, so leaving it at the primitive's default would put 14px initials in a 24px disc
 * at `sm` and lose them in a 48px disc at `lg`.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The root: an inline, wrapping metadata row.
 *
 * `inline-flex` rather than `flex`, because a byline is a run of metadata inside a line of other
 * metadata and must introduce no block box of its own. `flex-wrap` with a row gap is what keeps a
 * long display name and a date from forcing horizontal overflow in a narrow feed card - the date
 * drops to a second line instead, at every viewport width and with no media query.
 *
 * The type size is set here once and inherited by the name, the separator and the date, so a
 * caller that changes `size` moves the whole row coherently.
 */
const bylineVariants = cva('inline-flex flex-wrap items-center', {
  variants: {
    size: {
      sm: 'gap-x-1.5 gap-y-1 text-xs',
      md: 'gap-x-2 gap-y-1 text-sm',
      lg: 'gap-x-2.5 gap-y-1 text-base',
    },
  },
  defaultVariants: {
    size: 'md',
  },
});

/**
 * The profile link that wraps the avatar and the visible name.
 *
 * The class recipe is the one this repository already uses for a text link, restated here rather
 * than imported so the byline carries its own note for each group:
 *
 *   * `text-foreground font-medium` - the author's name is primary text, not secondary. It is the
 *     one part of the byline that is not muted, which is what makes the attribution read as the
 *     subject of the line and the date as its qualifier.
 *   * `rounded-sm` - keeps the focus outline hugging the text instead of tracing a hard square
 *     around it.
 *   * `hover:text-primary hover:underline` - the engine gates `hover:` behind
 *     `@media (hover: hover)`, so a touch device never gets a state stuck on after a tap. The
 *     underline travels with the colour change, so the affordance is never carried by colour alone.
 *   * `focus-visible:*` - `:focus-visible`, not `:focus`, so the ring appears for keyboard and
 *     assistive-technology users and not on every mouse click. `globals.css` already sets a
 *     document-wide floor at this width and colour; restating it keeps the byline correct if that
 *     floor is ever narrowed, and lands on the same values so nothing changes thickness today.
 *     The outline is never suppressed first - there is no state here with no visible indicator.
 *   * `motion-safe:*` - the colour transition runs only for visitors who have not asked for less
 *     motion.
 */
const identityLinkVariants = cva(
  [
    'text-foreground inline-flex items-center font-medium',
    'rounded-sm',
    'hover:text-primary hover:underline',
    'focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',
    'motion-safe:transition-colors motion-safe:ease-out',
  ],
  {
    variants: {
      size: {
        sm: 'gap-1.5',
        md: 'gap-2',
        lg: 'gap-2.5',
      },
    },
    defaultVariants: {
      size: 'md',
    },
  },
);

/**
 * The avatar diameter, overriding the primitive's own default through its `className` seam.
 *
 * Sizes come from the `--spacing` scale, so they stay on the same rhythm as the gaps beside them.
 * The primitive keeps `shrink-0`, so the circle holds its size when a long name squeezes the row.
 */
const avatarVariants = cva('', {
  variants: {
    size: {
      sm: 'size-6',
      md: 'size-8',
      lg: 'size-12',
    },
  },
  defaultVariants: {
    size: 'md',
  },
});

/**
 * The initials' type size, paired row-for-row with {@link avatarVariants}.
 *
 * Separate from the avatar table because the two classes land on different elements: a utility on
 * the root cannot reach the fallback inside it. The primitive's documentation is explicit that
 * these two must be set in the same breath, and this pairing is that instruction encoded once.
 *
 * Each step is a real member of the engine's `--text-*` scale, whose smallest step is `xs`. There
 * is no `text-2xs`: an invented step would generate no CSS at all and fail silently, leaving the
 * primitive's default in place with nothing to indicate the row had been ignored.
 */
const initialsVariants = cva('', {
  variants: {
    size: {
      sm: 'text-xs',
      md: 'text-sm',
      lg: 'text-lg',
    },
  },
  defaultVariants: {
    size: 'md',
  },
});

/* -------------------------------------------------------------------------------------------------
 * Props
 * ---------------------------------------------------------------------------------------------- */

/**
 * The three scales a byline renders at, derived from the variant table rather than restated, so a
 * step cannot be added to one and missed by the other. `NonNullable` strips the `null` that
 * `VariantProps` admits for "reset to the default": omitting the prop already expresses that, and
 * two spellings for one intent is one too many.
 */
type AuthorBylineSize = NonNullable<VariantProps<typeof bylineVariants>['size']>;

/**
 * Props for {@link AuthorByline}.
 *
 * Kept local rather than exported, matching the other components in this folder: every consumer
 * writes `<AuthorByline author={post.author} publishedAt={post.published_at} />` and needs no
 * reference to the type. Export it the day a wrapper genuinely has to re-declare the shape.
 */
interface AuthorBylineProps {
  /**
   * The account that wrote the post, as the API's PUBLIC projection.
   *
   * `UserPublic` and nothing wider. That projection carries `username`, `display_name`,
   * `avatar_url`, `bio`, `id` and `created_at`, and deliberately withholds `email`, `role` and
   * `is_active` - so a byline structurally cannot leak a private field, whatever screen renders it.
   * Both `PostSummary.author` and `PostDetail.author` are already this shape, so a feed card and a
   * post page pass their post's author through unchanged.
   */
  author: UserPublic;
  /**
   * The post's publication instant as an ISO-8601 string, or `null`/omitted when it has none.
   *
   * Pass `post.published_at` straight through. `null` is a real, expected value - a draft has never
   * been published - and it simply means no date is rendered. Do not substitute `created_at` to
   * fill the gap: that is the authoring instant, not a publication instant, and presenting one as
   * the other misstates when the post became public.
   */
  publishedAt?: string | null;
  /**
   * Scale of the whole row - the avatar diameter, the initials, the type size and the gaps, moved
   * together.
   *
   * `'sm'` for a byline inside a dense surface such as a feed card or a comment header, `'md'`
   * (the default) for a post-detail header, `'lg'` for a profile header where the author IS the
   * subject of the page.
   */
  size?: AuthorBylineSize;
  /**
   * Extra utilities for the root, merged last so they win their Tailwind group.
   *
   * This is the seam for anything the size table does not cover - the consuming layout's own
   * spacing, for instance. It reaches the root only; the avatar and the date are sized through
   * `size`, because a class on the root cannot reach inside them.
   */
  className?: string;
}

/* -------------------------------------------------------------------------------------------------
 * Pure helpers
 *
 * Local rather than in `@/lib/format`, because neither is a formatting rule the rest of the tier
 * shares: both exist only to feed this component's own markup, and hoisting them would widen a
 * shared module's surface for a single caller.
 * ---------------------------------------------------------------------------------------------- */

/** How many words contribute an initial. Two is a monogram; three starts to look like an acronym. */
const INITIALS_WORD_LIMIT = 2;

/**
 * Matches the first grapheme of a string: one non-mark code point plus any combining marks that
 * modify it.
 *
 * The `u` flag makes `\P{M}` match a whole code point, so an astral character - an emoji in a
 * display name, a CJK ideograph - survives intact instead of being cut in half into a lone
 * surrogate, which is what `charAt(0)` or `[0]` would produce. The trailing `\p{M}*` keeps a
 * decomposed accent attached to the letter it belongs to, so a name stored as `e` + U+0301 yields
 * `é` rather than a bare `e`.
 */
const FIRST_GRAPHEME_PATTERN = /^\P{M}\p{M}*/u;

/**
 * The first grapheme of a word, or the empty string for an empty word.
 *
 * Total over its input and never throws.
 *
 * @param word - A single whitespace-free word.
 * @returns One grapheme, or `''` only when `word` itself is empty.
 */
function firstGrapheme(word: string): string {
  // The pattern fails to match only when the word BEGINS with a bare combining mark, which no
  // keyboard produces for a name. The spread indexes by code point rather than by UTF-16 unit, so
  // even that path cannot emit half a surrogate pair.
  return FIRST_GRAPHEME_PATTERN.exec(word)?.[0] ?? [...word][0] ?? '';
}

/**
 * Derives the monogram shown while no avatar image is displayed.
 *
 * The first grapheme of each of the first {@link INITIALS_WORD_LIMIT} words, upper-cased: `'Alice
 * Chen'` yields `'AC'`, `'prince'` yields `'P'`, `'Ada B. Lovelace'` yields `'AB'`. Runs of
 * whitespace collapse, so a name with a double space still yields two letters rather than three.
 *
 * Non-empty for any input carrying a non-whitespace character, which {@link resolveDisplayName}
 * guarantees - so the fallback is never an empty circle.
 *
 * @param name - The already-resolved visible name, never a raw nullable field.
 * @returns One or two upper-cased graphemes.
 */
function initialsFrom(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, INITIALS_WORD_LIMIT)
    .map(firstGrapheme)
    .join('')
    .toUpperCase();
}

/**
 * The name to show, and to announce as the link's accessible name.
 *
 * `display_name` is typed non-nullable and the service guarantees a value - the column is
 * `NOT NULL` and registration derives one from the username when the caller supplies none - so
 * this is a blankness guard, not a null guard: `string` still admits `''` and `'   '`, and either
 * would render a link with no perceivable text. That is a WCAG failure rather than a cosmetic one,
 * because a link whose accessible name is empty is announced as its URL or as nothing at all.
 * `username` is the correct fallback because it is `NOT NULL UNIQUE` and is the very segment the
 * href is built from, so the visible text and the destination always agree.
 *
 * The non-blank value is returned verbatim rather than trimmed: HTML collapses surrounding
 * whitespace and the accessible-name computation trims it, so trimming here would alter stored
 * data for no rendered difference.
 *
 * @param author - The public projection of the account being attributed.
 * @returns A non-blank name, on the invariant that `username` is non-blank - which `profilePath`
 * enforces by throwing before this value is ever rendered.
 */
function resolveDisplayName(author: UserPublic): string {
  return author.display_name.trim().length > 0 ? author.display_name : author.username;
}

/* -------------------------------------------------------------------------------------------------
 * Component
 * ---------------------------------------------------------------------------------------------- */

/**
 * Attribution for a post: who wrote it, linked to their profile, and when it was published.
 *
 * Renders an avatar and the author's name inside a single link to `/u/{username}`, optionally
 * followed by the publication date. One component serves all three surfaces that attribute a post -
 * the feed card, the post-detail header and the profile header - so the attribution reads
 * identically wherever it appears, and a change to it is one edit rather than three.
 *
 * ### What a screen reader hears
 *
 * Exactly `"{name}, link"` followed by the date, if any. The avatar contributes nothing: the whole
 * composition is `aria-hidden`, because its fallback renders the initials as text and would
 * otherwise spell the name out a second time in front of itself. The separator is hidden for the
 * same reason - it is a typographic mark, not a word.
 *
 * ### What it renders in the initial HTML
 *
 * All of it. This module declares no client directive, so on a Server Component page the link, the
 * name and the `<time>` are in the HTML a crawler receives without running any JavaScript - and the
 * `<time dateTime>` pair gives that crawler, and any assistive technology, an unambiguous instant
 * rather than a formatted phrase it has to guess at. It is the same instant the page's `BlogPosting`
 * structured data publishes, because both read it from `@/lib/format`.
 *
 * ### Layout is the caller's
 *
 * The root is `inline-flex` and wrapping, and sets no width, no max-width, no margin and no
 * breakpoint variant. Drop it into a card, a header or a table cell unchanged; if the row runs out
 * of room the date wraps beneath the name rather than overflowing, at every viewport width.
 *
 * @param props - See {@link AuthorBylineProps}.
 * @returns The byline row. Never `null` - there is always an author to attribute.
 * @throws If `author.username` is blank. `@/lib/seo` refuses to build a path from an empty segment,
 * because a blank username cannot occur in the service's schema and therefore means the payload is
 * not the record the caller believed it had. The route error boundary is the right place for that,
 * not a link pointing at `/u/`.
 *
 * @example Post-detail header, with the reading time composed beside it
 * ```tsx
 * <div className="flex flex-wrap items-center gap-3">
 *   <AuthorByline author={post.author} publishedAt={post.published_at} />
 *   <ReadingTime content={post.content} />
 * </div>
 * ```
 *
 * @example Feed card - the dense scale
 * ```tsx
 * <AuthorByline author={post.author} publishedAt={post.published_at} size="sm" />
 * ```
 *
 * @example An author's draft - no date is rendered at all
 * ```tsx
 * <AuthorByline author={draft.author} publishedAt={draft.published_at} />
 * // published_at is null, so no <time> element is emitted and no separator appears.
 * ```
 *
 * @example Profile header, where the author is the subject of the page
 * ```tsx
 * <AuthorByline author={profile} size="lg" />
 * ```
 */
export function AuthorByline({
  author,
  publishedAt,
  size = 'md',
  className,
}: AuthorBylineProps): JSX.Element {
  const name = resolveDisplayName(author);

  // Both forms of the same instant: the machine-readable one for the attribute, the human-readable
  // one for the text. Formatted once here rather than twice in the JSX so the guard below and the
  // rendered output cannot disagree about what the date is.
  const machineDate = formatMachineDate(publishedAt);
  const humanDate = formatDate(publishedAt);

  // Guarded on the FORMATTED values, not on `publishedAt` itself, and compared against the format
  // module's exported placeholder rather than a bare `''` so the guard is pinned to that module's
  // documented convention. This is stricter than a null check in the way that matters: a non-empty
  // but unparseable timestamp is truthy, yet formats to the placeholder, and would otherwise emit
  // `<time dateTime="">` - an invalid element - with "Invalid Date" nowhere to be seen.
  const hasPublicationDate = machineDate !== EMPTY_VALUE && humanDate !== EMPTY_VALUE;

  return (
    <div className={cn(bylineVariants({ size }), className)}>
      <Link className={identityLinkVariants({ size })} href={profilePath(author.username)}>
        {/*
         * Hidden from assistive technology in its entirety - see note 2 in the module header. The
         * root is a non-focusable <span>, so hiding it cannot strand a focusable element outside
         * the accessibility tree, and the link keeps its accessible name from the text below.
         */}
        <Avatar aria-hidden="true" className={avatarVariants({ size })}>
          {/*
           * `alt=""` explicitly: decorative, because the name is right there inside the same link.
           * `src` is passed through as-is - the primitive applies this tier's remote-host policy
           * itself and drops a denied URL, which is precisely what keeps the fallback mounted. Any
           * check here would be a second copy of that policy. `null` becomes `undefined` because
           * the DOM prop is optional rather than nullable.
           */}
          <AvatarImage alt="" src={author.avatar_url ?? undefined} />
          <AvatarFallback className={initialsVariants({ size })}>
            {initialsFrom(name)}
          </AvatarFallback>
        </Avatar>
        {/*
         * A display name is unbounded text this component does not control, and it is the only
         * value here that can be arbitrarily long - so it is the one place horizontal overflow can
         * originate, and `wrap-anywhere` is what prevents it.
         *
         * The `overflow-wrap: break-word` this element already inherits from `globals.css` is NOT
         * sufficient, and that is a specification detail rather than an oversight: the break
         * opportunities `break-word` introduces are excluded from min-content intrinsic sizing.
         * Because a flex item's automatic minimum size is its min-content width, an unbreakable
         * word still set the floor for this span's inline-flex ancestors, and the row grew past its
         * container. `overflow-wrap: anywhere` is the one value whose break opportunities DO count
         * toward min-content, so it collapses that floor and the word finally breaks.
         *
         * Measured, not assumed. A 53-character single-word name produced 75px of horizontal
         * document overflow at a 375px viewport with this class absent, and exactly 0 with it
         * present; the name now lays out across two line boxes inside its container. `min-w-0` was
         * tried here first and is deliberately NOT kept: with `wrap-anywhere` in place it was
         * measured inert in both directions - present or absent, the page rendered
         * byte-for-byte identically - so it would have been a class that looked load-bearing while
         * doing nothing.
         *
         * An ordinary multi-word name is untouched: the space in `'Alice Chen'` is an earlier wrap
         * opportunity, so it still breaks between words and never mid-word.
         */}
        <span className="wrap-anywhere">{name}</span>
      </Link>
      {hasPublicationDate && (
        <>
          {/*
           * A typographic separator, hidden from assistive technology: a screen reader announcing
           * "middle dot" between a name and a date adds noise and no meaning. It renders only
           * alongside a date, so a draft's byline never trails a dangling mark.
           */}
          <span aria-hidden="true" className="text-muted-foreground">
            ·
          </span>
          {/*
           * The machine-readable instant in the attribute, the human-readable date as the text.
           * `whitespace-nowrap` keeps "12 March 2025" from breaking mid-phrase; the name beside it
           * is deliberately left wrappable, because a long name is the part that needs to give.
           */}
          <time className="text-muted-foreground whitespace-nowrap" dateTime={machineDate}>
            {humanDate}
          </time>
        </>
      )}
    </div>
  );
}
