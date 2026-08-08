/* =============================================================================
 * table.tsx - the Table primitive: real, semantic table markup that presents as
 * one card per record below the medium breakpoint.
 *
 * Six exports, and they are the whole API:
 *
 *   Table         the scroll container plus the <table> itself
 *   TableHeader   <thead>   - the column-header band, hidden below md
 *   TableBody     <tbody>   - the record region
 *   TableRow      <tr>      - a table row at md and above, a CARD below it
 *   TableHead     <th>      - a column header, scope="col" by default
 *   TableCell     <td>      - a value, with an optional sub-md column label
 *
 * One of the fifteen primitives under src/components/ui/ that together ARE this
 * project's design system. No component library was specified, so this layer is
 * the library. Radix publishes no table, so this is one of the nine primitives
 * authored directly over semantic HTML using only tokens declared in
 * src/app/globals.css.
 *
 * THIS FILE IS THE ONLY PLACE IN src/ WHERE A RAW TABLE ELEMENT MAY APPEAR.
 * <table>, <thead>, <tbody>, <tr>, <th> and <td> are wrapped here exactly once;
 * feature code - the four admin management screens and anything else that grows
 * a grid - composes these six parts and never reaches past them. Adding a
 * seventh element type is a change to this file, not a licence to hand-roll one
 * at a call site.
 *
 * ---------------------------------------------------------------------------
 * THE THREE-TIER RESPONSIVE CONTRACT
 *
 *   below 48rem   one card per record. Column headers are hidden and each cell
 *                 carries its own inline label instead.
 *   48rem and up  a real table. Excess width scrolls INSIDE the container.
 *   64rem and up  the same table, wide enough that nothing needs to scroll.
 *
 * The third tier needs NO declaration of its own, and that is the design rather
 * than an omission. `overflow-x: auto` shows a scrollbar only when the content
 * genuinely exceeds the box, so one markup tree reads as "scrollable" at 768 and
 * as "full, all columns, no scrollbar" at 1440 with nothing switching between
 * them. Do not add an `lg:` rule looking for the third tier - there is nothing
 * for it to change, and a hard `lg:` switch would break every width in between.
 *
 * Consumers MAY demote a secondary column below lg with `max-lg:hidden`, which
 * stays inside the sanctioned breakpoint vocabulary - but it must be applied to
 * the TableHead AND to that column's TableCell in every row, or the header and
 * body fall out of step. This primitive deliberately does not do it for them: it
 * cannot know which column is secondary.
 *
 * ---------------------------------------------------------------------------
 * THE COLLAPSE IS A DISPLAY CHANGE, NEVER ALTERNATE MARKUP
 *
 * There is exactly ONE DOM here at every width. The card presentation is
 * produced by switching `display` on the real elements through `max-md:`
 * utilities - the table becomes a block, the body a column flex container, each
 * row a flex card, each cell a flex row - and nothing is unmounted, duplicated
 * or re-rendered at a breakpoint.
 *
 * Two things this rules out, both of which look reasonable and are not:
 *
 *   1. `<div role="table">` with `role="row"` / `role="cell"` children. ARIA
 *      table roles are a re-implementation of semantics the native elements
 *      already carry, they drop the header-to-cell association that a real <th>
 *      provides for free, and support for the ARIA spelling is materially worse
 *      than for the element it imitates.
 *   2. Rendering a <table> above md and a list of cards below it - whether by
 *      media query in JS, by a resize listener or by duplicating the markup and
 *      hiding one copy. That needs the viewport width during render, which a
 *      Server Component does not have; it either doubles the DOM and reads every
 *      record's text twice to a screen reader, or it makes this module a client
 *      island. A `display` switch costs neither.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HORIZONTAL OVERFLOW LIVES IN THE CONTAINER
 *
 * The responsive criteria forbid horizontal DOCUMENT overflow at 375, 768 and
 * 1440. A wide admin grid is the likeliest thing in the whole application to
 * cause it, so `Table` always renders the <table> inside a wrapper that owns the
 * overflow: past md the wrapper is a scroll container, so a table wider than the
 * viewport scrolls within its own box and the document never gains a scrollbar.
 * Below md the question does not arise - the rows are cards, so there is nothing
 * to scroll, and the wrapper stays `overflow: visible` so a focus ring or a
 * non-portalled popover inside a card cannot be clipped by a scrollport that is
 * serving no purpose at that width.
 *
 * The wrapper carries no `tabIndex`. A keyboard user reaches the grid's contents
 * (a title link, a row-action trigger) directly and the browser scrolls the
 * container to reveal whichever cell receives focus, so the scrollport needs no
 * tab stop of its own - and adding one would trip
 * `jsx-a11y/no-noninteractive-tabindex`, which `npm run lint` treats as fatal.
 *
 * ---------------------------------------------------------------------------
 * TOKEN VOCABULARY - the whole file
 *
 * Every value below resolves to a token. There is not one literal colour,
 * length, radius or shadow anywhere in this module.
 *
 *   hairline        border-border       --color-border         rules between
 *                                                              rows, under the
 *                                                              header, and the
 *                                                              sub-md card
 *                                                              outline
 *   header ground   bg-surface-muted    --color-surface-muted  and the row
 *                                                              hover fill
 *   card surface    bg-surface          --color-surface        the sub-md record
 *                                                              panel
 *   body text       text-foreground     --color-foreground
 *   header + label  text-muted-foreground
 *                                       --color-muted-foreground
 *   corner          rounded-xl          --radius-xl
 *   elevation       shadow-sm           --shadow-sm
 *   spacing         h-11, p-4, px-4,    --spacing scale
 *                   py-3, gap-2, gap-4
 *   type            text-sm,            --text-sm,
 *                   font-medium         --font-weight-medium
 *
 * `border-border` and `bg-surface-muted`/`bg-surface` are the exact tokens
 * card.tsx uses, which is what makes the sub-md card and a real Card read as one
 * system. card.tsx is deliberately NOT imported to achieve that - a <div> inside
 * a <tr> is invalid markup that the parser would hoist straight out of the
 * table - so the token choices are shared and the elements are not.
 *
 * `--color-border` measures below 3:1 by design. globals.css records the flagged
 * A11Y decision in full: 1.4.11 exempts decorative boundaries, and it names
 * table rules as an example. `--color-border-strong` exists for the boundary of
 * an interactive control; a table rule is not one, so it is not used here.
 *
 * The row hover fill is `--color-surface-muted` and NOT `--color-accent`.
 * `accent` is the saturated brand hue - the emphasis companion to `primary` -
 * and globals.css says outright that a NEUTRAL subtle fill should reach for
 * `surface-muted`. A saturated indigo wash under every hovered row would be a
 * visual-quality regression, not emphasis.
 *
 * No `dark:` variant appears anywhere below. Every token is dual-valued -
 * globals.css declares each at the document root and again under `.dark` - so
 * every rule, ground, hover and card surface re-themes with no conditional here.
 * A `dark:` class would be a second, competing source of truth.
 *
 * No focus styling either. globals.css sets a `:focus-visible` outline floor for
 * the whole document, so an interactive control inside a cell is already ringed.
 *
 * ---------------------------------------------------------------------------
 * WHY border-collapse, NOT border-separate
 *
 * Not a preference. In the SEPARATE border model, borders set on rows and row
 * groups are ignored outright - so `border-b` on a <tr> or a <thead> would emit
 * nothing and every hairline at md and above would silently vanish, leaving the
 * grid unruled with no error anywhere. The collapsing model honours them, and it
 * merges a row's bottom border with the next row's top edge into one hairline
 * rather than stacking two.
 *
 * The usual objection to collapsing - that it discards `border-radius` - does
 * not apply to the rounded sub-md card, because at that width the table is
 * `display: block` and `border-collapse` is inert on a non-table box. The radius
 * renders exactly as it would on any other block. The two decisions are
 * compatible precisely because they never apply at the same width.
 *
 * ---------------------------------------------------------------------------
 * FOUR THINGS THIS FILE DELIBERATELY OMITS
 *
 *   1. `'use client'`. Nothing here uses a hook, a browser API or an event
 *      handler, so the module stays shared - and that is load-bearing. The admin
 *      screens compose these parts with client islands (row actions, moderation
 *      controls) INSIDE the cells; the directive would pull the whole grid and
 *      its callers into the client bundle to render static markup.
 *   2. Sorting, selection, virtualisation, column resizing and pagination.
 *      Pagination is `@/components/ui/pagination`; sorting and row actions
 *      belong to `@/components/admin/data-table` and the row-action components,
 *      which are client islands and own that state. A primitive that grew them
 *      would force this module client-side and duplicate the admin layer.
 *   3. `data-[state=selected]` row styling. The admin screens specify row
 *      ACTIONS - role change, status change, moderation, deletion - and no
 *      multi-select, so there is no selected state to style. Styling one now
 *      would be dead CSS documenting a feature that does not exist.
 *   4. `forwardRef`. React 19 passes `ref` to a function component as an
 *      ordinary prop, so it arrives inside `...props` and lands on the element
 *      like any other attribute. To type a wrapper around one of these parts,
 *      derive from it - `ComponentProps<typeof TableCell>` - rather than
 *      restating its props, so the wrapper cannot drift.
 * ========================================================================== */

import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/* Table                                                                      */
/* -------------------------------------------------------------------------- */

/*
 * The wrapper. `w-full` fills the available inline size and `min-w-0` removes
 * the automatic content-based minimum, so a grid placed in a flex or grid track
 * shrinks with its track instead of widening it and pushing the DOCUMENT into
 * horizontal scroll - the failure this component is most likely to cause.
 * (Past md the scrollport resolves its own automatic minimum to zero, so
 * `min-w-0` is what covers the card width, where overflow is visible.)
 *
 * The overflow pair is scoped rather than unconditional so the two widths never
 * compete: `max-md:` is `width < 48rem` and `md:` is `width >= 48rem`, which are
 * disjoint by construction. That boundary is also why 768 exactly gets the wide
 * layout - it is not below 48rem - which is what the tablet viewport verifies.
 */
const TABLE_CONTAINER_BASE = cn('w-full min-w-0', 'max-md:overflow-visible md:overflow-x-auto');

/*
 * `caption-bottom` places a <caption> after the grid rather than above it. It is
 * kept on the base so the element is styled correctly if a caption is ever
 * needed for the accessible name; until then, name a grid with `aria-label`,
 * which rides the spread (see the example on `Table`).
 */
const TABLE_BASE = cn(
  'w-full caption-bottom border-collapse text-sm text-foreground',
  // First link in the display chain: drop table layout below md so the body,
  // rows and cells beneath can lay themselves out as cards.
  'max-md:block',
);

interface TableProps extends ComponentProps<'table'> {
  /**
   * Classes for the scroll CONTAINER rather than the table.
   *
   * Needed because the two elements have genuinely different jobs and only the
   * wrapper can express some of them: clipping the grid's corners to a card it
   * sits inside (`rounded-xl overflow-hidden` past md), or bounding its height
   * (`max-h-*`). `className` reaches the <table> instead.
   */
  containerClassName?: string;
}

/**
 * A data grid. Renders the scroll container and the `<table>` inside it.
 *
 * Give the grid an accessible name. A table with none is announced only as
 * "table" with a row and column count, which tells a screen-reader user nothing
 * about which of the four admin grids they have landed in. `aria-label` is
 * forwarded through the spread, as is every other table attribute.
 *
 * @example An admin users grid. Every cell passes `label`, so the sub-md card
 * still says what each value is.
 * ```tsx
 * <Table aria-label="Users">
 *   <TableHeader>
 *     <TableRow>
 *       <TableHead>User</TableHead>
 *       <TableHead>Role</TableHead>
 *       <TableHead>Joined</TableHead>
 *     </TableRow>
 *   </TableHeader>
 *   <TableBody>
 *     {users.map((user) => (
 *       <TableRow key={user.username}>
 *         <TableCell label="User">{user.displayName}</TableCell>
 *         <TableCell label="Role">
 *           <Badge>{user.role}</Badge>
 *         </TableCell>
 *         <TableCell label="Joined">{formatDate(user.createdAt)}</TableCell>
 *       </TableRow>
 *     ))}
 *   </TableBody>
 * </Table>
 * ```
 *
 * @example Clipping the grid to the card it sits in, past md
 * ```tsx
 * <Table aria-label="Comment moderation queue" containerClassName="md:rounded-xl md:border">
 * ```
 */
export function Table({ className, containerClassName, ...props }: TableProps) {
  return (
    <div className={cn(TABLE_CONTAINER_BASE, containerClassName)}>
      <table className={cn(TABLE_BASE, className)} {...props} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* TableHeader                                                                */
/* -------------------------------------------------------------------------- */

/*
 * `max-md:hidden` is the pivot the whole sub-md presentation turns on: with the
 * header band gone, each cell's own `label` becomes the only thing naming its
 * value - visually AND to a screen reader, since `display: none` removes the
 * <th> elements from the accessibility tree along with the pixels. That is
 * exactly what makes the pair non-duplicating; see `TableCell`.
 *
 * The ground and the rule carry no `md:` prefix because they cannot apply below
 * md anyway - the element is not rendered there - and prefixing them would
 * suggest a distinction that does not exist.
 */
const TABLE_HEADER_BASE = 'border-b border-border bg-surface-muted max-md:hidden';

/**
 * The column-header band. Wraps one `TableRow` of `TableHead` cells.
 *
 * Hidden below md, where `TableCell`'s `label` takes over. Present and ruled off
 * from the body at md and above.
 *
 * A second header row is valid here - the first will keep its own bottom hairline
 * from `TableRow`, and only the last loses it to this element's rule.
 */
export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return <thead className={cn(TABLE_HEADER_BASE, className)} {...props} />;
}

/* -------------------------------------------------------------------------- */
/* TableBody                                                                  */
/* -------------------------------------------------------------------------- */

/*
 * Below md this is a column flex container so the record cards are separated by a
 * token `gap`. Flex, not `space-y-*`: gap is a property of the container, so it
 * vanishes with a conditionally rendered row instead of leaving a dangling
 * sibling margin behind - and the layout rules forbid margins between siblings
 * to simulate a gap.
 *
 * At md and above nothing is declared. The default `table-row-group` behaviour is
 * exactly right, and the rules between records belong to `TableRow`, which is
 * where a caller looks for them.
 */
const TABLE_BODY_BASE = 'max-md:flex max-md:flex-col max-md:gap-4';

/**
 * The record region. Wraps the `TableRow` elements that carry data.
 *
 * A stack of cards with a token gap below md; an ordinary row group at md and
 * above.
 */
export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={cn(TABLE_BODY_BASE, className)} {...props} />;
}

/* -------------------------------------------------------------------------- */
/* TableRow                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * The two presentations are written as two DISJOINT variant sets - everything
 * structural is behind `max-md:` or `md:` and nothing is unconditional - so the
 * card rules and the row rules can never both apply, and neither depends on
 * stylesheet source order to win. That matters here more than anywhere else in
 * the file, because the same element is a rounded panel at one width and a
 * hairline-separated row at another.
 *
 * `md:last:border-b-0` drops the rule under the final record: the grid is closed
 * by the surface it sits on, and a trailing hairline would double up with the
 * bottom edge of a Card wrapping it. Inside a `TableHeader` the same rule leaves
 * the header row unruled, which is correct - `TableHeader` owns that hairline.
 *
 * The hover fill is scoped to md and above on purpose. Below md a record is a
 * card, not a row, and a whole-card wash on pointer-over would suggest the card
 * itself is clickable when the interactive things are the controls inside it.
 * Tailwind's `hover:` already compiles to `@media (hover: hover)`, so a touch
 * device never gets a hover state stuck on after a tap.
 *
 * `motion-safe:` gates the transition on `prefers-reduced-motion: no-preference`
 * rather than shipping it unconditionally, so the colour change is instant for
 * anyone who has asked for reduced motion. Paired with the `--ease-out` token at
 * the engine's default duration, which matches button.tsx.
 */
const TABLE_ROW_BASE = cn(
  // md and above: a table row.
  'md:border-b md:border-border md:last:border-b-0 md:hover:bg-surface-muted',
  'motion-safe:transition-colors motion-safe:ease-out',
  // Below md: one card per record. Same surface, hairline, radius and elevation
  // tokens as card.tsx, so the two presentations read as one system.
  'max-md:flex max-md:flex-col max-md:gap-2',
  'max-md:rounded-xl max-md:border max-md:border-border max-md:bg-surface max-md:p-4',
  'max-md:shadow-sm',
);

/**
 * One record. A table row at md and above; a bordered card below it.
 *
 * Also the correct wrapper for the header cells inside `TableHeader`.
 *
 * @example
 * ```tsx
 * <TableRow>
 *   <TableCell label="Title">{post.title}</TableCell>
 *   <TableCell label="Status">
 *     <Badge>{post.status}</Badge>
 *   </TableCell>
 * </TableRow>
 * ```
 */
export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return <tr className={cn(TABLE_ROW_BASE, className)} {...props} />;
}

/* -------------------------------------------------------------------------- */
/* TableHead                                                                  */
/* -------------------------------------------------------------------------- */

/*
 * `h-11` is `11 * --spacing`, so the header band's height comes from the spacing
 * scale like every other length here rather than from a literal - and it lands on
 * the 44-unit minimum target size, which matters once a consumer puts a sort
 * control in a header cell.
 *
 * `whitespace-nowrap` is what produces the md tier. A header that wrapped would
 * absorb a narrow viewport by growing taller and the grid would never overflow;
 * keeping headers on one line is what makes a wide grid genuinely wider than the
 * container at 768, so the container's scrollport - not the document - takes it.
 *
 * `align-middle` restates the table default explicitly, so a header still centres
 * against a taller sibling cell if an ancestor has set `vertical-align`
 * elsewhere. Scoped to md and above because vertical alignment has no meaning on
 * the flex boxes this becomes below md.
 */
const TABLE_HEAD_BASE = cn(
  'h-11 px-4 md:align-middle',
  'text-left font-medium whitespace-nowrap text-muted-foreground',
);

/**
 * A column header. A real `<th>`, never a styled `<td>` or `<div>`.
 *
 * `scope` defaults to `"col"`, which is what makes the header-to-cell association
 * programmatic: a screen reader announces "Role, Author" when the user moves into
 * that cell without the cell repeating the column name itself. Override it with
 * `scope="row"` for a `<th>` used as a row header inside `TableBody` - in that
 * case also pass the cell layout through `className`, since these classes are
 * tuned for the header band that is hidden below md.
 *
 * Sorting is not implemented here. A sortable header puts a `Button` inside this
 * element from the admin layer, which owns the sort state.
 *
 * @example
 * ```tsx
 * <TableHead>Role</TableHead>
 * ```
 */
export function TableHead({ className, scope = 'col', ...props }: ComponentProps<'th'>) {
  // `scope` is destructured, so it cannot be clobbered by the spread and the
  // default holds while a caller can still override it explicitly.
  return <th className={cn(TABLE_HEAD_BASE, className)} scope={scope} {...props} />;
}

/* -------------------------------------------------------------------------- */
/* TableCell                                                                  */
/* -------------------------------------------------------------------------- */

/*
 * Below md the cell is a flex row holding two things: its label at the inline
 * start and its value at the inline end. `items-start` keeps a one-line label
 * aligned with the FIRST line of a value that wraps, rather than drifting to the
 * middle of a tall cell.
 *
 * Padding is `md:`-scoped and there is deliberately none below md - the card's
 * own `p-4` provides the inset and the row's `gap-2` separates the fields, so a
 * cell paying its own padding as well would double every gap inside the card.
 *
 * `wrap-anywhere` is what keeps a long unbroken value - a slug, a pasted URL in a
 * comment awaiting moderation - from forcing the card, and with it the DOCUMENT,
 * into horizontal scroll. globals.css sets `overflow-wrap` on flow containers
 * only (body, p, li, dd, blockquote, figcaption), so a bare text node in a cell
 * needs it declared here.
 *
 * IT MUST BE `wrap-anywhere` AND NOT `wrap-break-word`. This one differs from
 * card.tsx deliberately; the difference was measured, not guessed, and reverting
 * it to match its sibling reintroduces a real layout failure.
 *
 * `overflow-wrap: break-word` breaks an over-long word during LINE LAYOUT but
 * does not reduce the element's min-content INTRINSIC SIZE. Below md the cell is
 * a flex container whose value is usually a bare text node, and a bare text node
 * becomes an ANONYMOUS flex item - a box no class can reach, which therefore
 * keeps `min-width: auto` and resolves it to that unreduced min-content width.
 * For a token with no break opportunity the line box is then made wide enough
 * that no break is ever attempted, the run escapes the card, and because the
 * wrapper is `overflow-visible` at this width it propagates all the way to a
 * horizontally scrollable document. Measured with a 95-character hyphen-free
 * token at 375: the cell reported scrollWidth 706 against clientWidth 309, the
 * token rendered as ONE 662px line box ending at x=739, and the document went to
 * scrollWidth 755 against clientWidth 375 - 380px of page scroll, at every
 * viewport below about 755px.
 *
 * `overflow-wrap: anywhere` breaks in exactly the same circumstances - only when
 * a word cannot fit on a line of its own, so ordinary prose still wraps at its
 * spaces - but it DOES affect min-content sizing, which is the property the flex
 * and table algorithms need in order to shrink the cell. Same measurement after
 * the change: document 375/375, cell scrollWidth == clientWidth, the token
 * wrapped onto three lines inside the card.
 *
 * `word-break: break-all` also fixes the sizing but breaks ordinary words
 * mid-character whenever a line fills, which is a typography regression on every
 * normal cell. `overflow-x: hidden` merely hides the symptom and leaves the
 * value clipped and unreadable. Neither is used.
 *
 * AND IT IS SCOPED TO `max-md:`, WITH `break-word` RESTORED AT md AND ABOVE.
 * That asymmetry is the point, and it too was settled by measuring rather than
 * by taste. The min-content reduction that rescues the card layout is harmful in
 * a table: because `table-layout` is `auto`, shrinking every cell's min-content
 * contribution to one character lets the algorithm squeeze each column down to
 * its `TableHead` `whitespace-nowrap` floor, and any value wider than its own
 * header then breaks mid-word. Measured at 768 with `anywhere` applied
 * unconditionally: the Slug column fell to 59.77px, the token spread over 27
 * line boxes, that one row grew to 565px tall, the page grew from 1290px to
 * 2530px, and ordinary content rendered as "Scal/ing/Fast/API/with/Pos/tgres"
 * and "Publis/hed". That is a visible regression on every table with NORMAL
 * content, traded for a pathological case the tier already handles.
 *
 * It handles it because the two tiers have different safety nets. Below md the
 * wrapper is `overflow-visible` - there is deliberately no scroll container, so
 * an escaping run reaches the document and horizontal page scroll is a hard
 * failure; `anywhere` is the only thing standing in its way. At md and above the
 * wrapper IS a scroll container, so an over-wide column is absorbed by design -
 * a scrollable table at this tier is the specified behaviour, not a fallback.
 * Measured with `break-word` at md and above: 48 elements extend past the
 * viewport at 768 and all 48 are clipped by that wrapper, leaving zero unclipped
 * offenders and the document at 768/768.
 *
 * So each width gets the rule that is correct for it: break the intrinsic size
 * where nothing else can contain the overflow, and preserve natural column widths
 * and word boundaries where the scrollport already does. The two variants are
 * disjoint, so neither depends on stylesheet source order, and `md:wrap-break-word`
 * is stated explicitly rather than left to inherit from the `body` rule in
 * globals.css - that rule is scoped to flow containers by intent, and relying on
 * inheritance from it would make this cell's behaviour depend on a decision made
 * elsewhere for another reason.
 */
const TABLE_CELL_BASE = cn(
  'md:px-4 md:py-3 md:align-middle',
  'max-md:flex max-md:min-w-0 max-md:items-start max-md:justify-between max-md:gap-4',
  'max-md:wrap-anywhere md:wrap-break-word',
);

/*
 * `md:hidden` is the entire duplication guard, and it works because it is the
 * exact complement of `TableHeader`'s `max-md:hidden`. Below md the <th>
 * elements are display:none and only this label is rendered; at md and above
 * this label is display:none and only the <th> is rendered. Neither width has
 * both, so a screen reader can never announce the column name twice.
 *
 * Which is also why there is NO `aria-hidden` here, and that is measured rather
 * than assumed. Because the collapse sets `display: block`/`flex` on real table
 * elements, Chrome drops the implicit `table`/`row`/`cell` roles from the
 * accessibility tree below md - an accessibility-tree snapshot at 375 shows
 * label/value text pairs and no table node at all. So below md these labels are
 * not a supplement to the column headers, they are the ONLY thing carrying
 * column meaning to a screen reader. Marking them `aria-hidden` would turn a
 * duplication guard into outright information loss. Above md the same snapshot
 * shows the full table, and the first cell's accessible name is exactly its
 * value with no column name in it, because this element is `display: none`
 * there. Verified at both widths; please do not "tidy" it.
 *
 * `shrink-0` keeps the label intact so a long value wraps instead of squeezing
 * the field name to one character per line.
 */
const TABLE_CELL_LABEL_BASE = 'shrink-0 font-medium text-muted-foreground md:hidden';

interface TableCellProps extends ComponentProps<'td'> {
  /**
   * The column name shown INSIDE this cell below md, where the header band is
   * hidden.
   *
   * Pass it on EVERY cell. It is optional only because a cell can legitimately
   * hold something self-describing - a row-actions menu, a lone avatar - and
   * forcing a label onto those would put a stray field name in the card. Omit it
   * anywhere else and that field silently loses its meaning at 375: the value is
   * still there, with nothing to say which column it came from.
   *
   * A `ReactNode` rather than a `string` so a label can carry an icon or a
   * `Badge`; a plain string is the normal case.
   */
  label?: ReactNode;
}

/**
 * One value. A real `<td>`.
 *
 * At md and above it is an ordinary cell whose column name comes from the `<th>`
 * above it. Below md it becomes a labelled field inside the record card: `label`
 * on the left, the value on the right.
 *
 * Below md the label and the children are the two flex items `justify-between`
 * separates. A cell with SEVERAL children should wrap them in one element, or all
 * of them are spaced apart individually rather than staying grouped opposite the
 * label:
 *
 * ```tsx
 * <TableCell label="Actions">
 *   <div className="flex items-center gap-2">
 *     <PostRowActions postId={post.id} />
 *   </div>
 * </TableCell>
 * ```
 *
 * @example A value with its column label
 * ```tsx
 * <TableCell label="Status">
 *   <Badge>{comment.status}</Badge>
 * </TableCell>
 * ```
 *
 * @example Self-describing content, so no label
 * ```tsx
 * <TableCell>
 *   <CommentModerationActions commentId={comment.id} />
 * </TableCell>
 * ```
 */
export function TableCell({ className, label, children, ...props }: TableCellProps) {
  // `null` and `undefined` both mean "no label"; every other ReactNode - a
  // string, an element, `0` - is a label the caller meant to render.
  const hasLabel = label !== undefined && label !== null;

  return (
    <td className={cn(TABLE_CELL_BASE, className)} {...props}>
      {hasLabel ? <span className={TABLE_CELL_LABEL_BASE}>{label}</span> : null}
      {children}
    </td>
  );
}
