// Comment list - the discussion thread's container, and the ONE module in the comments feature that
// is NOT a client island.
//
// AAP R4 ("Each blog page should support comments, likes, and social sharing") names this file under
// comments in §0.3.2 and §0.9.2. It renders four things and nothing else: the thread's heading, the
// root comment form, the top-level comments of one page, and the page control. Every piece of
// interaction below it belongs to a child that already carries `'use client'`.
//
// -------------------------------------------------------------------------------------------------
// 1. WHY THERE IS NO `'use client'` HERE, AND WHAT ADDING ONE WOULD COST
//
// This module needs no hook, no state and no browser API, so it stays a Server Component and
// `src/app/blog/[slug]/page.tsx` renders the whole thread - heading, comment bodies and, critically,
// the page control's `<a href>` links - straight into the initial HTML.
//
// `src/components/blog/comment-item.tsx` states the same split from the other side: "The list is
// content and stays directive-free. This node is content PLUS three affordances". The division is
// deliberate, and two temptations are what would break it:
//
//   * `usePagination`/`useSearchParams`, to build the page links here. `@/components/ui/pagination`
//     already consumes that hook inside its own island and derives every `href` from the current URL,
//     preserving the sibling query parameters and dropping `page` for page one. Reaching for the hook
//     here would move the entire thread into the client bundle to recompute a URL that already
//     exists.
//   * `useAuth`, to decide whether to offer the form or the per-comment controls. `CommentForm`
//     resolves the principal itself and answers a signed-out reader with a sign-in prompt;
//     `CommentItem` does the same for Reply, Edit and Delete, and reads the principal from the hook
//     rather than from a prop precisely so that recursion cannot hand two levels different answers.
//     Neither needs help, and gating either from here would be a second authority check that could
//     only ever disagree with the service's.
//
// The same rule governs the props this file passes down: they must be SERIALIZABLE, because a
// function cannot cross the server-to-client boundary. `CommentForm`'s `onCancel` and `onSuccess`
// exist for its client-side callers - a reply box that has to close itself - and the always-on-screen
// root form this file renders wants neither, so both are simply omitted. `Pagination`'s
// `onPageChange` and `hrefForPage` are omitted for the same reason, which its own documentation calls
// out as the point of their being optional.
//
// -------------------------------------------------------------------------------------------------
// 2. `page.total` COUNTS THREADS, NOT COMMENTS. THE HEADING SAYS SO HONESTLY.
//
// `GET /api/v1/posts/{id}/comments` windows TOP-LEVEL comments only: each root arrives with its
// replies already nested inside `CommentPublic.replies`, so one request carries a whole page of the
// discussion however deep it goes, and consecutive pages stay disjoint. `@/lib/api/comments` is
// explicit that `total` and `pages` therefore count threads and that the count must not be "fixed".
//
// So the heading renders `page.total` as the number of comments in the thread sense a reader
// understands - the messages the page offers - and never claims to be a total that includes replies,
// which it is not. Deriving such a total here is not merely unnecessary, it is impossible: `replies`
// may be a PREFIX of a comment's answers (that is what `has_more_replies` reports) and only ONE page
// of roots is in hand, so a walk over the payload would produce a third number that is neither
// `total` nor the real size of the conversation. `CommentPublic.reply_count` is the authoritative
// per-comment figure and `comment-item.tsx` renders it where it belongs.
//
// `page.items` is likewise passed through untouched. Ordering and the moderation filter are composed
// once, server-side, in `backend/app/repositories/comment_repository.py` and applied at every level
// of the tree; re-sorting or re-filtering here would desynchronise the rows from `total` and `pages`
// and could only ever disagree with the query that produced them.
//
// -------------------------------------------------------------------------------------------------
// 3. THE SECTION IS A NAMED LANDMARK, AND ITS HEADING ID IS DERIVED FROM `postId`
//
// A `<section>` maps to the `region` landmark role ONLY when it has an accessible name; unnamed, it
// is an ordinary generic container and a screen reader's landmark list never mentions it. Putting a
// heading inside does not name it, so `aria-labelledby` points at the heading's own `id` - the same
// pattern `src/components/blog/post-editor.tsx` uses for its preview panel.
//
// That id cannot come from `useId()`, which is a hook and would force `'use client'` (section 1). It
// is built from `postId` instead, which makes it deterministic across the server render and hydration
// - no mismatch is possible - and unique per thread rather than merely unique per page, so the id
// stays correct even if a surface some day renders two discussions at once.
//
// -------------------------------------------------------------------------------------------------
// 4. THE EMPTY STATE ANNOUNCES NOTHING, AND ITS COPY IS TRUE FOR AN ANONYMOUS READER
//
// `<Alert variant="empty">` carries no live-region role by design: `@/components/ui/alert` maps that
// variant to `undefined` in its role table, which is what keeps a server-rendered empty panel from
// interrupting a reader on page load. So no `role`, `aria-live` or `aria-atomic` is authored at this
// call site, in either direction.
//
// The wording matters as much as the markup. A public caller receives APPROVED comments only, so a
// post can have comments in the moderation queue and still answer an anonymous reader with an empty
// page. Copy asserting that nobody has commented would state something the reader cannot verify and
// this tier cannot know, so the panel says there are no comments YET and invites the first one -
// which is true whether the thread is genuinely empty or merely empty for this reader.
//
// Its `AlertTitle` deliberately stays the primitive's default `div` rather than becoming a heading.
// `src/components/blog/post-list.tsx` makes the opposite choice because it owns no heading of its own
// and its empty state has to occupy the place in the outline the results would have; this section
// already has its heading, and a second one would put two headings in a region that describes one
// thing.
//
// -------------------------------------------------------------------------------------------------
// 5. THE PAGE CONTROL IS GATED HERE, AND CARRIES NO `<Suspense>`
//
// `Pagination` already returns `null` at or below one page, and this file still gates on
// `pages > FIRST_PAGE` rather than leaning on that. The reason is not defensiveness: the gate is what
// keeps a client island out of the tree entirely for the overwhelmingly common single-page thread,
// instead of shipping one that renders nothing.
//
// No `<Suspense>` boundary is placed around it. That primitive reads the URL through
// `usePagination`, and Next.js requires a boundary above `useSearchParams()` only on a STATICALLY
// rendered route; the consuming post page reads `searchParams` to obtain the thread's page number,
// which makes it dynamic by definition. A boundary here would put a fallback rather than the anchors
// into the prerendered HTML - the one outcome the primitive's crawlability contract exists to
// prevent. Section 4 of its header states the same conclusion from its side.
//
// -------------------------------------------------------------------------------------------------
// 6. HOW IT STAYS INSIDE 375px
//
// One column at every width, because a discussion has no second column to reflow into - so there is
// no breakpoint utility in this file at all, and none of the five in the token layer is needed. The
// thread's indentation, the only horizontal cost the tree pays, belongs to `CommentItem`, which caps
// it at four levels for exactly this reason and steps flush beyond that.
//
// What this file does contribute is `min-w-0` on the section and on every list item. Both are
// flex-container children whose automatic minimum size would otherwise resolve to their content's
// min-content width, so one unbreakable token - a pasted URL in a comment - would pin the track wide
// and drag the page's scroll width past its client width. Vertical rhythm is a single `gap` step from
// the `--spacing` scale rather than margins between siblings.
//
// -------------------------------------------------------------------------------------------------
// 7. WHAT THIS FILE MUST NOT RENDER OR DO, AND WHY. EACH LOOKS REASONABLE AND IS A DEFECT.
//
//   1. `'use client'`, `useId`, `@/hooks/use-pagination` or `@/hooks/use-auth`. See section 1.
//   2. ANY HTTP. No `fetch`, and no call into `@/lib/api/comments` - the envelope arrives as a prop
//      from the Server Component that fetched it. `src/lib/api/client.ts` is the only module in this
//      tier permitted to perform HTTP, and the component suite runs Mock Service Worker with
//      `onUnhandledRequest: 'error'`, so a stray request here fails the gate rather than escaping it.
//   3. A per-node fetch of replies. They travel nested inside their parent and `CommentItem` recurses
//      over them; fetching per node would break the disjointness of the top-level pages (section 2).
//   4. Any filter, sort or re-order of `page.items`, and any re-derivation of `total` or `pages`.
//   5. An authority check - `canModify`, a role comparison, a token read. `CommentItem` owns the
//      presentation of the affordances and the service re-checks every request regardless.
//   6. A moderation control or any write to `status`. `PATCH /api/v1/admin/comments/{id}/status` is
//      the only route that changes it, and `src/components/admin/comment-moderation-actions.tsx` is
//      the only surface that calls it.
//   7. An `<h1>`. AAP §0.7.3.5 puts exactly one on a page and gives it to the route.
//   8. An array-index `key`. Every row is keyed by its server-generated identifier, so turning the
//      page cannot make React reuse the wrong comment's DOM - which, with a mounted reply box inside
//      it, would show one reader's draft under another reader's comment.
//   9. A raw `<button>`, `<input>`, `<textarea>`, `<select>` or `<table>`. The project primitives in
//      `src/components/ui/` are the only permitted route to those elements (AAP §0.8.5).
//  10. A `dark:` variant. Every token named below is dual-valued - declared at the document root and
//      again under `.dark` in `src/app/globals.css` - so the thread re-themes with no conditional
//      here, and a `dark:` class would be a second source of truth for one decision.
//  11. A focus-ring declaration. `globals.css` sets `:focus-visible { outline: 2px solid
//      var(--app-ring); outline-offset: 2px }` in `@layer base`, so every control inside this section
//      already has a visible indicator.
//  12. Any literal colour, dimension, radius, font size or shadow, any `style` attribute, any
//      bracketed arbitrary value and any `!important`. The only literals are the permitted ones.
//  13. A second stylesheet, a CSS module or a `tailwind.config.ts`. Tailwind 4 is CSS-first and
//      `globals.css` is this tier's only stylesheet.
//  14. Any package outside `frontend/package.json` - no virtualiser, no infinite-scroll library, no
//      animation library. Pagination here is page-based and crawlable on purpose.
//  15. A subscription, WebSocket or poll for new comments, and any analytics, experiment or consent
//      instrumentation. AAP §0.9.3 excludes all of it.
//  16. Anything from the retired surface: no `/items` path, no `Item` type, no `id`/`name`/`price`
//      triple (AAP §0.9.4.3), and no `message`/`data` envelope. `Page<T>.items` below is the AAP's
//      own uniform collection field and is unrelated to the retired route.
//  17. `import React from 'react'`. `"jsx": "react-jsx"` means the compiler imports the runtime, so a
//      default import would be unused - and `npm run lint` runs at `--max-warnings=0`, which turns
//      that from a warning into a failed gate.
//  18. `forwardRef`. React 19 passes `ref` through as an ordinary prop, and there is no ref to
//      forward: the `<section>` is not a control.

import type { JSX } from 'react';

import { CommentForm } from '@/components/blog/comment-form';
import { CommentItem } from '@/components/blog/comment-item';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Pagination } from '@/components/ui/pagination';
import { EMPTY_VALUE, formatCount } from '@/lib/format';
import type { CommentPublic, Page } from '@/lib/types';
import { cn, FIRST_PAGE } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Heading level
 * ---------------------------------------------------------------------------------------------- */

/**
 * Heading levels the thread's heading may render at.
 *
 * `1` is excluded because a page spends its single `<h1>` on the route heading (AAP §0.7.3.5), and
 * `4` and below are excluded because a discussion nested that deep in an outline means the
 * surrounding page has already gone wrong - the constraint surfaces that at compile time rather than
 * in an audit.
 */
type CommentListHeadingLevel = 2 | 3;

/**
 * `h2`, which is what the post page needs.
 *
 * The article's title is that route's `<h1>`, so the discussion beneath it is the second level. A
 * consumer that has already introduced an `<h2>` of its own passes `3` so no level is skipped.
 */
const DEFAULT_HEADING_LEVEL: CommentListHeadingLevel = 2;

/**
 * The heading tag each level maps to.
 *
 * A `Record` over the closed union rather than a ternary, so widening
 * {@link CommentListHeadingLevel} fails to compile until the new level has been given a tag. Indexing
 * it with a `CommentListHeadingLevel` yields a tag rather than `tag | undefined` - these are declared
 * properties, not an index signature, so `noUncheckedIndexedAccess` has nothing to widen.
 *
 * A member access on a module-level constant is also what makes the result usable as a JSX tag:
 * `react-hooks/static-components` treats it as a STATIC component lookup, where a helper CALL in the
 * same position reports "Cannot create components during render" and fails the `--max-warnings=0`
 * gate. `@/components/ui/card` records the three shorter spellings that all fail.
 */
const HEADING_TAG_BY_LEVEL: Readonly<Record<CommentListHeadingLevel, 'h2' | 'h3'>> = {
  2: 'h2',
  3: 'h3',
};

/* -------------------------------------------------------------------------------------------------
 * Copy
 *
 * Declared here rather than inline so the strings a test asserts on and the strings this component
 * renders are the same objects, and so the whole of this file's visible language can be reviewed in
 * one place.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The heading's label, which the count is appended to.
 *
 * "Comments" rather than "Discussion" or "Responses" because it is the word the rest of the product
 * uses - the form's own labels, the administrative moderation queue and the API's resource name all
 * say comment - and a section named differently from the thing it contains is a small, permanent
 * source of confusion.
 */
const HEADING_LABEL = 'Comments';

/**
 * The label and the single space before the count, as ONE text node. The trailing space is
 * load-bearing rather than incidental, and it was settled in a real browser rather than by reasoning.
 *
 * Written as `{HEADING_LABEL}{' '}<span>` this heading produced two ADJACENT text children, which
 * React separates in the server-rendered HTML with its `<!-- -->` delimiter:
 * `Comments<!-- --> <span>(3)</span>`. Chrome's accessible-name computation drops a whitespace-only
 * text node that sits beside a comment node, so the landmark's name came back as `Comments(3)` while
 * the DOM text and the visible text were both correctly `Comments (3)`. Measured with six controlled
 * probes: the variant with the comment node was the only one that lost the space, and folding the
 * label and the space into a single text node - which is what this constant is - restored it.
 *
 * The space therefore has to live INSIDE this string. A caller reading only the JSX would reasonably
 * try to move it back out; this note is why it must not be moved.
 */
const HEADING_LABEL_WITH_SEPARATOR = `${HEADING_LABEL} `;

/** Headline of the empty panel. See section 4 for why it says "yet" rather than "nobody has". */
const EMPTY_TITLE = 'No comments yet';

/**
 * Supporting copy of the empty panel.
 *
 * Points at the form directly above it, which is on screen in every state - signed in as the field,
 * signed out as a sign-in prompt - so the invitation always has somewhere to lead.
 */
const EMPTY_DESCRIPTION = 'Be the first to share your thoughts on this post.';

/**
 * Accessible name of the page control's landmark.
 *
 * `Pagination` defaults to the bare word "Pagination" and asks each surface to name its own control,
 * so that a landmark list distinguishes them. A post page can carry only this one today, but naming
 * it costs nothing and stays correct if a second ever appears beside it.
 */
const PAGINATION_LABEL = 'Comments pagination';

/**
 * Prefix of the heading's `id`, completed with the post's identifier.
 *
 * See section 3: derived rather than generated, because `useId()` is a hook.
 */
const HEADING_ID_PREFIX = 'comment-thread-heading-';

/* -------------------------------------------------------------------------------------------------
 * Presentation
 *
 * Every value resolves to a token declared in src/app/globals.css. No literal colour, dimension,
 * radius, font size or shadow appears anywhere below.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The section itself: one column, with a single token step between its four blocks.
 *
 * `gap` rather than margins between siblings, so a block that does not render - the page control on a
 * single-page thread - leaves no orphaned space behind it. `min-w-0` is the overflow guard described
 * in section 6. The step matches `post-list.tsx`'s own root, so a feed and a thread breathe the same.
 */
const ROOT_CLASSES = 'flex min-w-0 flex-col gap-6';

/**
 * The heading: the section's most prominent line without competing with the article's title.
 *
 * `text-xl` sits one step above the `text-lg` the card primitive gives a post title and well below
 * the `text-2xl` a route heading takes, which is what places the discussion correctly in the page's
 * visual hierarchy as well as its outline. `tracking-tight` matches every other heading in the tier.
 */
const HEADING_CLASSES = 'text-foreground text-xl leading-snug font-semibold tracking-tight';

/**
 * The count inside the heading.
 *
 * Recessed and unbolded so the word carries the emphasis and the number reads as metadata, which is
 * also what keeps a five-digit count from dominating the line. `tabular-nums` fixes every digit to
 * the same advance width, so the heading does not reflow as the thread grows.
 */
const HEADING_COUNT_CLASSES = 'text-muted-foreground font-normal tabular-nums';

/**
 * The list of top-level comments.
 *
 * `list-none` removes the marker through the token engine's own utility rather than a bespoke rule;
 * the element stays a `<ul>` so assistive technology announces how many comments the page holds. The
 * step is the same one the section uses, so a root comment is separated from the next by exactly the
 * distance the heading is separated from the form. This is the markup `CommentItem`'s own
 * documentation prescribes for its callers.
 */
const LIST_CLASSES = 'flex list-none flex-col gap-6';

/** Each row. `min-w-0` is the overflow guard described in section 6. */
const LIST_ITEM_CLASSES = 'min-w-0';

/* -------------------------------------------------------------------------------------------------
 * Props
 * ---------------------------------------------------------------------------------------------- */

/**
 * Props of {@link CommentList}.
 *
 * Deliberately four members. There is no filter, sort, page-size or page prop, because the thread's
 * window lives in the URL and the consuming route reads it: adding one here would create a second
 * source of truth for the page a reader is on, and the two would disagree the moment somebody shared
 * a link.
 */
interface CommentListProps {
  /**
   * The post the discussion belongs to, as the API's UUID.
   *
   * Forwarded unchanged to the root form and to every top-level comment, and used to build the
   * heading's `id`. Never a member of any request body - `CommentCreate` has no `post_id` and the
   * service reads it from the path.
   *
   * Taken as a prop rather than read off `page.items[0].post_id`, and the difference is not
   * cosmetic: an empty thread has no row to read it from, and the whole point of the form on an empty
   * thread is that it works.
   */
  readonly postId: string;

  /**
   * One page of the thread, as the API's uniform page envelope.
   *
   * Exactly the five fields `Page<T>` declares - `items`, `total`, `page`, `page_size`, `pages` - in
   * the service's own snake_case, because there is no camelCase adaptation layer anywhere in this
   * tier. Pass the response through unchanged; nothing here is renamed, recomputed or re-ordered.
   *
   * `items` holds TOP-LEVEL comments only, each carrying its own replies; `total` and `pages` count
   * those threads rather than every node. See section 2.
   *
   * An empty `items` is an ordinary input in two different ways - a thread nobody has commented on,
   * and a page past the end of one that has comments - and both render the empty panel rather than
   * throwing, which is what AAP §0.9.4.4 requires of an out-of-range page.
   */
  readonly page: Page<CommentPublic>;

  /**
   * Level of the thread's heading. Defaults to `2`.
   *
   * The consuming route owns its outline: a discussion directly under the article's `<h1>` leaves
   * this alone, while a page that has already introduced an `<h2>` above the thread passes `3` so no
   * level is skipped. There is no level `1` - see {@link CommentListHeadingLevel}.
   */
  readonly headingLevel?: CommentListHeadingLevel;

  /**
   * Extra utilities for the section, merged last through `cn()` so a caller's utility reliably wins
   * its property group.
   *
   * The seam for the consuming layout's concerns - the space between the article and the discussion,
   * or a rule drawn above it. The INTERNAL rhythm is not addressable from here, because a thread that
   * spaced its rows differently from every other list in the product would read as a defect.
   */
  readonly className?: string;
}

/* -------------------------------------------------------------------------------------------------
 * Component
 * ---------------------------------------------------------------------------------------------- */

/**
 * A post's discussion: its heading, the form that adds to it, one page of top-level comments and the
 * control that pages them.
 *
 * See this module's header for why it is not a client island, why the heading's count describes
 * threads, and why the empty panel announces nothing.
 *
 * ### What is rendered, in order
 *
 * | Element | Condition |
 * | --- | --- |
 * | Heading at `headingLevel`, naming the section, carrying the thread count | Always |
 * | Root `CommentForm` - the field for a signed-in reader, a sign-in prompt otherwise | Always |
 * | `<ul>` of `CommentItem`, one `<li>` per top-level comment | `page.items` is non-empty |
 * | Empty panel inviting the first comment | `page.items` is empty |
 * | `Pagination` | `page.pages` exceeds one |
 *
 * The form comes BEFORE the list on purpose. The primary action on a discussion is joining it, and
 * putting it first means a keyboard or screen-reader user reaches it without traversing however many
 * comments precede it - which on page one of a busy thread is twenty subtrees.
 *
 * ### Accessibility contract
 *
 * - The section is a named `region` landmark: `aria-labelledby` points at the heading's own `id`, so
 *   the name and the visible text cannot drift apart.
 * - Exactly one heading, at `headingLevel`. Neither the empty panel nor `CommentItem` adds another,
 *   and no `<h1>` can originate here.
 * - The comments are a real `<ul>`/`<li>` list, so the row count is announced.
 * - No `role`, `aria-live` or `aria-atomic` is authored anywhere in this file. The empty panel's
 *   silence is its variant's contract, and the page control brings its own landmark and labels.
 *
 * @param props - See {@link CommentListProps}.
 * @returns The discussion section.
 *
 * @example A Server Component rendering the thread into the initial HTML
 * ```tsx
 * const thread = await listComments(post.id, { page }, { next: { revalidate: 60 } });
 * return <CommentList page={thread} postId={post.id} />;
 * ```
 *
 * @example A page that has already spent an `h2` above the discussion
 * ```tsx
 * <CommentList className="mt-12" headingLevel={3} page={thread} postId={post.id} />
 * ```
 */
export function CommentList({
  postId,
  page,
  headingLevel = DEFAULT_HEADING_LEVEL,
  className,
}: CommentListProps): JSX.Element {
  /* A static lookup, not a call - see {@link HEADING_TAG_BY_LEVEL}. */
  const Heading = HEADING_TAG_BY_LEVEL[headingLevel];

  /* Deterministic and unique per thread, so the landmark's name survives hydration - see section 3. */
  const headingId = `${HEADING_ID_PREFIX}${postId}`;

  /*
   * The number of TOP-LEVEL comments the service reports for this thread, never a total that includes
   * replies - section 2 records why that number is not derivable here and would be wrong if it were.
   *
   * `formatCount` answers with the empty string for an absent, negative or non-finite tally, which
   * cannot come from the service but can come from a fixture. Reading that branch rather than
   * ignoring it is what keeps a malformed envelope from rendering the heading as "Comments ()".
   */
  const countLabel = formatCount(page.total);

  const hasComments = page.items.length > 0;

  /*
   * Gated here as well as inside the primitive, so a single-page thread - which is most of them -
   * puts no client island into the tree at all. See section 5.
   */
  const hasMorePages = page.pages > FIRST_PAGE;

  return (
    <section aria-labelledby={headingId} className={cn(ROOT_CLASSES, className)}>
      {/*
       * Each branch renders the label as a SINGLE text node, and the parenthesised count as a single
       * text node inside its span, so no React `<!-- -->` delimiter lands beside whitespace and the
       * landmark's accessible name is exactly the visible text. See {@link
       * HEADING_LABEL_WITH_SEPARATOR} for the measurement behind that.
       */}
      <Heading className={HEADING_CLASSES} id={headingId}>
        {countLabel === EMPTY_VALUE ? (
          HEADING_LABEL
        ) : (
          <>
            {HEADING_LABEL_WITH_SEPARATOR}
            <span className={HEADING_COUNT_CLASSES}>{`(${countLabel})`}</span>
          </>
        )}
      </Heading>

      {/*
       * Root mode: `postId` and nothing else. No `parentId`, so the created comment carries no
       * `parent_id` at all and is top-level; no `onCancel`, which is what suppresses a Cancel button
       * on a form that is always on screen; no `onSuccess` or `autoFocus`, neither of which a form
       * nobody opened has any use for. Two of those are functions, which a Server Component could not
       * pass in any case - see section 1.
       */}
      <CommentForm postId={postId} />

      {hasComments ? (
        <ul className={LIST_CLASSES}>
          {page.items.map((comment) => (
            /*
             * Keyed by the comment's server-generated identifier - never by index, which would make
             * React reuse the wrong subtree's DOM when the reader turns the page, carrying a mounted
             * reply box or edit field with it.
             *
             * `depth` and `maxDepth` are left to their defaults: these are the roots, and one
             * indentation cap governs the whole tree from there down.
             */
            <li className={LIST_ITEM_CLASSES} key={comment.id}>
              <CommentItem comment={comment} postId={postId} />
            </li>
          ))}
        </ul>
      ) : (
        /*
         * No `role`, `aria-live` or `aria-atomic`, and no heading inside - see section 4. No
         * `className` either, so this panel is byte-identical to the feed's and the administrative
         * grid's empty states.
         */
        <Alert variant="empty">
          <AlertTitle>{EMPTY_TITLE}</AlertTitle>
          <AlertDescription>{EMPTY_DESCRIPTION}</AlertDescription>
        </Alert>
      )}

      {hasMorePages ? (
        /*
         * Serializable numbers only. `total` and `page_size` accompany the two required members
         * because they are the primitive's documented recovery path for an envelope whose `pages` did
         * not survive as a usable number; they come from the same envelope, so the four cannot
         * disagree. No `onPageChange` and no `hrefForPage`: the default source of every URL is
         * `@/hooks/use-pagination`, reached from inside that island, which is correct for a window
         * addressed by the query string - and a function could not cross the boundary regardless.
         */
        <Pagination
          ariaLabel={PAGINATION_LABEL}
          page={page.page}
          page_size={page.page_size}
          pages={page.pages}
          total={page.total}
        />
      ) : null}
    </section>
  );
}
