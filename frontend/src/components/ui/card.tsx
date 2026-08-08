/* =============================================================================
 * card.tsx - the Card primitive: a raised surface plus header, title, content
 * and footer slots.
 *
 * One of the fifteen primitives under src/components/ui/ that together ARE this
 * project's design system. No component library was specified for this project,
 * so this layer is the library: feature code composes these parts and never
 * reaches past them to a raw element or a literal CSS value.
 *
 * Radix ships no card, so this is authored over semantic HTML using only tokens
 * declared in src/app/globals.css. It serves three documented surfaces - the
 * post card in the feed, a generic panel, and the admin stat tile - which is why
 * the API is COMPOSITIONAL rather than prop-driven. Do not collapse it into a
 * single `<Card title=... body=... />`: consumers put arbitrary children in each
 * slot (a cover image, a byline, a category badge row, a like button), and no
 * fixed prop set survives that.
 *
 * ---------------------------------------------------------------------------
 * TOKEN VOCABULARY - the whole file, and the one table.tsx mirrors
 *
 * Every value below resolves to a token; there is not one literal colour,
 * radius, shadow or length in this file.
 *
 *   surface       bg-surface        --color-surface    raised panel, lighter
 *                                                      than the page canvas in
 *                                                      BOTH themes
 *   hairline      border-border     --color-border     DECORATIVE outline. Note
 *                                                      globals.css composes
 *                                                      border-muted-foreground
 *                                                      for interactive control
 *                                                      boundaries (WCAG 1.4.11)
 *                                                      - a card outline is not
 *                                                      one, so it uses the
 *                                                      decorative token
 *   body text     text-foreground   --color-foreground
 *   corner        rounded-xl        --radius-xl
 *   elevation     shadow-sm         --shadow-sm
 *   spacing       p-6 / gap-*       --spacing scale
 *   type          text-lg,          --text-lg, --font-weight-semibold,
 *                 font-semibold,    --leading-snug, --tracking-tight
 *                 leading-snug,
 *                 tracking-tight
 *
 * There is deliberately NO `dark:` variant anywhere here. The tokens are
 * dual-valued - globals.css declares each one at `:root` and again under
 * `.dark` - so a component written against `--color-surface` re-themes with no
 * conditional logic. A `dark:` class in this file would be a second, competing
 * source of truth and would drift.
 *
 * There is also no breakpoint variant. A card is layout-agnostic; the feed's
 * one/two/three-column grid at 48rem and 64rem belongs to the page that renders
 * the cards, not to the card.
 *
 * ---------------------------------------------------------------------------
 * THREE DESIGN DECISIONS THAT LOOK LIKE OVERSIGHTS AND ARE NOT
 *
 * 1. The root carries NO padding. Padding lives on the slots instead, so a
 *    consumer can make media sit flush to the card's edges - the post card's
 *    cover image is exactly that case. Give the root `p-*` and every flush
 *    treatment in the application becomes impossible to express.
 *
 * 2. The root carries `min-w-0`. This does not impose a minimum width, it
 *    REMOVES one: a flex or grid item's `min-width` defaults to `auto`, i.e. its
 *    content-based minimum, so one long unbroken string (a pasted URL, a slug)
 *    inside a card in the feed grid would widen its track and push the whole
 *    document into horizontal scroll at 375px. `min-w-0` is what makes the card
 *    shrinkable in the track it is placed in. Paired with `wrap-break-word`,
 *    which is inherited by every slot and every child, the string wraps instead
 *    of overflowing. globals.css sets `overflow-wrap` on flow containers only
 *    (body, p, li, dd, blockquote, figcaption) - NOT on headings or bare divs -
 *    so declaring it here is what covers a long title or a bare text node.
 *
 * 3. Nothing here is interactive, and the card must never be MADE interactive by
 *    wrapping it in a link or an onClick. A card contains a title link, a like
 *    button and a share control; nesting those inside an outer anchor or button
 *    is invalid HTML, breaks keyboard navigation and gives screen readers one
 *    enormous unusable accessible name. Consumers link the TITLE.
 * ========================================================================== */

import type { ComponentProps, ElementType } from 'react';

import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/* Card                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The elements `Card` may render as.
 *
 * Constrained on purpose. A fully generic polymorphic component is easy to get
 * subtly wrong under `strict` and pushes the error messages into the caller;
 * this closed union covers every case the application actually has:
 *
 *   `div`     - the default. A panel with no independent meaning.
 *   `article` - a self-contained, independently distributable item. The right
 *               element for a post card in the feed, which is syndicable on its
 *               own.
 *   `section` - a titled region of a larger document. Pair it with a
 *               `CardTitle` so the region has an accessible name.
 *   `li`      - an item in a genuine list. Only valid inside a `ul`/`ol`; the
 *               consumer owns that parent.
 */
type CardElement = 'div' | 'article' | 'section' | 'li';

/**
 * Tag allow-list, indexed by the `as` prop to obtain the JSX element type.
 *
 * This is the INTERNAL half of the polymorphism; the public half is the
 * discriminated `CardProps` union below, and the two solve different problems.
 * The union is what gives a caller the right attributes and the right `ref` per
 * `as` value. This table is what lets the implementation render the resulting
 * union of props onto one JSX tag, and the indirection is load-bearing rather
 * than stylistic - it was settled by compiling, not by taste. Three shorter
 * spellings all fail:
 *
 *   1. `function Card({ as: Component = 'div', ...props })` and rendering
 *      `<Component {...props} />` does not type-check. The JSX tag then has the
 *      literal union type, so React demands props assignable to EVERY member at
 *      once, and `ref` is invariant: `Ref<HTMLDivElement>` is not assignable to
 *      `Ref<HTMLLIElement>`. Dropping `li` does not help; `HTMLDivElement` and
 *      `HTMLElement` collide the same way.
 *   2. `const Component: ElementType = as;` does not help either. The
 *      annotation is discarded by control-flow analysis, which narrows the const
 *      straight back to the literal union, and tsc reports the same error.
 *   3. Widening through a helper - `function toElementType(t: CardElement):
 *      ElementType { return t }` - type-checks but FAILS the lint gate:
 *      `react-hooks/static-components` reports "Cannot create components during
 *      render", because a call expression used as a JSX tag looks like a
 *      component constructed per render. `npm run lint` runs with
 *      `--max-warnings=0`, so that is a build failure, not a nit.
 *
 * A member access on a module-level constant is a STATIC component lookup, which
 * that rule accepts, and it is opaque to control-flow narrowing so the JSX tag
 * really does have type `ElementType`. It costs no cast, no `any` and no
 * suppression comment, the public `as` prop stays strictly checked by the union,
 * and `Record<CardElement, ElementType>` is exhaustive - adding a member to
 * `CardElement` fails to compile until it is added here AND given a branch in
 * `CardProps`.
 */
const CARD_ELEMENTS: Record<CardElement, ElementType> = {
  div: 'div',
  article: 'article',
  section: 'section',
  li: 'li',
};

const CARD_BASE = cn(
  // Vertical flow. `min-w-0` removes the automatic content-based minimum; see
  // decision 2 in the file header.
  'flex min-w-0 flex-col',
  // Surface, hairline, corner and elevation - the four tokens that make this
  // read as a raised panel in both themes.
  'rounded-xl border border-border bg-surface text-foreground shadow-sm',
  // Inherited by every slot and every child, so long unbroken content wraps
  // rather than forcing the document into horizontal scroll.
  'wrap-break-word',
);

/**
 * The public props of {@link Card}: one branch per element it may render as.
 *
 * A discriminated union rather than `ComponentProps<'div'> & { as?: CardElement }`,
 * and the difference is not academic. The intersection form types every branch as
 * a `div`, so `<Card as="li" value={3} />` is REJECTED even though `value` is a
 * real `li` attribute, and `<Card as="li" ref={liRef} />` is rejected too because
 * the prop's `ref` is `Ref<HTMLDivElement>` - while a `ref` that IS accepted
 * arrives typed as a div and hands the caller the wrong element type. The union
 * below discriminates on the `as` literal, so each branch carries exactly that
 * element's attributes and exactly that element's `ref`.
 *
 * `as` is optional only on the `div` branch, which is what makes `<Card />`
 * resolve to that branch and every other branch require the discriminant.
 */
type CardProps =
  | (ComponentProps<'div'> & {
      /** Element to render. Omit for the default `div`. @see {@link CardElement} */
      as?: 'div';
    })
  | (ComponentProps<'article'> & {
      /** Element to render. @see {@link CardElement} */
      as: 'article';
    })
  | (ComponentProps<'section'> & {
      /** Element to render. @see {@link CardElement} */
      as: 'section';
    })
  | (ComponentProps<'li'> & {
      /** Element to render. @see {@link CardElement} */
      as: 'li';
    });

/**
 * A raised surface. The container for the four slots below.
 *
 * Renders a `div` by default and takes no padding of its own, so children
 * decide their own insets and media can sit flush to the edge.
 *
 * @example A feed item - `article`, because a post card is self-contained
 * ```tsx
 * <Card as="article">
 *   <CardHeader>
 *     <CardTitle as="h2">
 *       <Link href={`/blog/${post.slug}`}>{post.title}</Link>
 *     </CardTitle>
 *   </CardHeader>
 *   <CardContent>{post.excerpt}</CardContent>
 *   <CardFooter>
 *     <Badge>{category.name}</Badge>
 *     <LikeButton postId={post.id} />
 *   </CardFooter>
 * </Card>
 * ```
 *
 * @example An admin stat tile - the default `div` is right; it is not an article
 * ```tsx
 * <Card>
 *   <CardHeader>
 *     <CardTitle>Published posts</CardTitle>
 *   </CardHeader>
 *   <CardContent>{stats.post_count}</CardContent>
 * </Card>
 * ```
 *
 * Field names in that example are the WIRE names. The API is snake_case
 * throughout and this tier does no camelCase mapping, so an admin overview reads
 * `stats.post_count` - the field `AdminStats` actually declares - and never an
 * invented `stats.publishedPosts`.
 *
 * Every prop of the ELEMENT SELECTED BY `as` is forwarded, `ref` included - React
 * 19 passes it through the spread, so no `forwardRef` is involved, and the `ref`
 * a caller supplies is typed as that element rather than always as a `div`. To
 * type a wrapper around this component, derive from it with
 * `ComponentProps<typeof Card>` rather than restating the props, so the wrapper
 * cannot drift.
 *
 * `className` is merged last through `cn`, so a caller's utility wins its own
 * property group: `className="rounded-none"` replaces `rounded-xl` and leaves
 * the surface, border and shadow intact.
 */
export function Card({ as = 'div', className, ...props }: CardProps) {
  const Component = CARD_ELEMENTS[as];

  return <Component className={cn(CARD_BASE, className)} {...props} />;
}

/* -------------------------------------------------------------------------- */
/* CardHeader                                                                 */
/* -------------------------------------------------------------------------- */

const CARD_HEADER_BASE = 'flex flex-col gap-1.5 p-6';

/**
 * The card's leading block: a `CardTitle` and whatever identifies it - a byline,
 * a publication date, a reading time, a category row.
 *
 * A column with a token `gap`, never sibling margins, so the spacing survives
 * a slot being conditionally rendered: drop the byline and the gap disappears
 * with it instead of leaving a dangling margin.
 */
export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn(CARD_HEADER_BASE, className)} {...props} />;
}

/* -------------------------------------------------------------------------- */
/* CardTitle                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Heading levels `CardTitle` may render as.
 *
 * The level is a prop with no default beyond `h3` because heading order is a
 * property of the PAGE, not of the card, and only the page knows it: the post
 * detail route spends its single `h1` on the article title, so cards inside it
 * start at `h2` or lower, while a feed of cards under an `h1` page heading wants
 * `h2` on each card. Hard-coding a level here would silently produce skipped
 * levels on one route or duplicate `h1`s on another.
 *
 * `h5` and `h6` are excluded deliberately: a card title nested five levels deep
 * indicates the surrounding document outline has gone wrong, and the constraint
 * surfaces that at compile time.
 */
type CardTitleLevel = 'h1' | 'h2' | 'h3' | 'h4';

const CARD_TITLE_BASE = cn(
  'text-lg font-semibold leading-snug tracking-tight',
  // Distributes a wrapped title evenly instead of leaving one orphaned word on
  // the last line - the common case for post titles in a narrow feed column.
  'text-balance',
  'text-foreground',
);

/**
 * Props of {@link CardTitle}.
 *
 * An intersection here, NOT a discriminated union like {@link CardProps} - and
 * that difference is deliberate rather than an oversight. All four heading levels
 * are `HTMLHeadingElement` in the DOM, so `ComponentProps<'h1'>`,
 * `<'h2'>`, `<'h3'>` and `<'h4'>` are the same type: identical attributes and an
 * identical `Ref<HTMLHeadingElement>`. There is nothing for a discriminant to
 * distinguish, and adding one would cost four branches to express one type.
 * `Card` needs the union precisely because its four tags are four different
 * element interfaces.
 */
interface CardTitleProps extends ComponentProps<'h3'> {
  /** Heading level to render. Defaults to `'h3'`. @see {@link CardTitleLevel} */
  as?: CardTitleLevel;
}

/**
 * The card's heading.
 *
 * Always a real heading element. Never a `div` with `role="heading"` and
 * `aria-level`: the native element gives assistive technology the document
 * outline for free, and the ARIA spelling is three attributes that can drift out
 * of step with each other.
 *
 * Keep the interactive element INSIDE the title rather than wrapping the card in
 * one - `<CardTitle><Link href={href}>{title}</Link></CardTitle>`. That gives
 * the link an accessible name of exactly the title text and leaves the rest of
 * the card free to hold its own controls.
 *
 * @example Inside a page that already spends its `h1` on the route heading
 * ```tsx
 * <CardTitle as="h2">{post.title}</CardTitle>
 * ```
 */
export function CardTitle({ as: Heading = 'h3', className, ...props }: CardTitleProps) {
  return <Heading className={cn(CARD_TITLE_BASE, className)} {...props} />;
}

/* -------------------------------------------------------------------------- */
/* CardContent                                                                */
/* -------------------------------------------------------------------------- */

/*
 * `pt-0` removes the doubled inset where content follows a header, which already
 * pays `p-6` on its underside. A card whose only slot is `CardContent` should
 * add `className="pt-6"` to restore the top inset.
 *
 * On `pt-0` being a physical property rather than a logical one: it is, and it
 * is the correct call here. Tailwind 4.3.3 generates no `padding-block-start`
 * utility, so the logical spelling would need an arbitrary property - which the
 * "layout through generated utilities" rule rules out - and the alternative,
 * `px-6 pb-6`, trades one physical property carrying `0` for a physical property
 * carrying a real length, which is strictly worse. `0` is an explicitly
 * permitted literal, `padding-top: 0` and `padding-block-start: 0` are
 * indistinguishable in every writing mode, and `p-6` and `px-6` are already
 * direction-neutral (`px-*` emits `padding-inline`). Please do not "fix" this.
 */
const CARD_CONTENT_BASE = 'p-6 pt-0';

/**
 * The card's body: an excerpt, a rendered Markdown fragment, a stat figure, a
 * form.
 *
 * Sets no colour of its own, so text inherits `text-foreground` from the root
 * and stays at full contrast by default. Mute the specific parts that should
 * recede - `<span className="text-muted-foreground">{readingTime}</span>` -
 * rather than muting the whole slot and fighting it back per child.
 */
export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn(CARD_CONTENT_BASE, className)} {...props} />;
}

/* -------------------------------------------------------------------------- */
/* CardFooter                                                                 */
/* -------------------------------------------------------------------------- */

// `flex-wrap` so a row of actions or category badges wraps onto a second line at
// narrow widths instead of overflowing the card.
const CARD_FOOTER_BASE = 'flex flex-wrap items-center gap-3 p-6 pt-0';

/**
 * The card's trailing block: actions, category badges, like and share controls.
 *
 * A centred, wrapping row with a token `gap`, so controls of differing heights
 * line up on their centres and a long run of them reflows rather than
 * overflowing. Shares `CardContent`'s `pt-0`, since it follows a slot that has
 * already paid its own bottom inset.
 */
export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn(CARD_FOOTER_BASE, className)} {...props} />;
}
