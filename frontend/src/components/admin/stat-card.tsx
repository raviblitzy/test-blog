// StatCard - the administrative overview tile.
//
// One tile per aggregate count on /admin: users, posts, comments, categories. Four instances of
// this component are the whole of that screen's summary band, which is why the component is
// parameterised by `label`/`value` rather than existing four times over with different copy.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE IS NOT ALLOWED TO DO, AND WHY EACH ABSENCE IS DELIBERATE
//
//   1. It never performs HTTP. `GET /api/v1/admin/stats` is called by
//      src/app/(admin)/admin/page.tsx through src/lib/api/admin.ts, and the four counts arrive
//      here as props. src/lib/api/client.ts is the only module in this tier permitted to make a
//      request; a fetch here would put transport in a presentational leaf, and it would also
//      fail the component suite outright, because the request interceptor is configured to error
//      on any request no handler claims.
//   2. It reads no environment variable. Nothing here is configurable per deployment.
//   3. It performs no mutation and holds no optimistic state. Optimism is confined to the like
//      and comment surfaces, where a retry is safe; an overview count has nothing to be
//      optimistic about.
//   4. It imports no sibling in this folder. The tile stands alone, so it can be rendered by the
//      overview page, by a test, or by any future screen without dragging a table or a row-action
//      menu along with it.
//   5. It renders no sparkline, trend arrow, percentage delta or time-range selector. The
//      endpoint returns four scalar counts and nothing else - there is no previous period, no
//      series and no baseline behind them - so a trend indicator would be decoration inventing
//      data it does not have. See the note on `value` in {@link StatCardProps}.
//
// ---------------------------------------------------------------------------
// NO `'use client'` DIRECTIVE - THIS IS A SHARED MODULE
//
// There is no state, no effect, no hook, no event handler and no browser API below: the component
// is a pure function of serialisable props. Leaving the directive off keeps the module renderable
// from a Server Component *and* from a client page alike, and keeps the client island as narrow as
// the interactivity actually requires. The overview page is itself a client component - that is
// its concern, not this file's, and it is not a reason to mark this one.
//
// The optional icon is the single nuance: lucide-react ships its icon factory with its own
// client directive, so the `<svg>` is a client reference rather than server output. That is
// harmless - a Server Component may render a Client Component and Next.js server-renders it into
// the same initial HTML - and the label and the figure, which carry all the meaning, are text
// emitted by this module.
//
// ---------------------------------------------------------------------------
// TOKEN VOCABULARY - the whole file
//
// Every value resolves to a token declared in src/app/globals.css or to a utility generated from
// the engine's own scales. There is not one literal colour, length, radius or shadow here.
//
//   panel surface    Card's own `bg-surface` / `border-border` / `rounded-xl` / `shadow-sm`
//   label            text-muted-foreground   --color-muted-foreground  secondary text
//   figure           inherited               --color-foreground        via Card's root; see below
//   link hover       hover:text-primary      --color-primary
//   focus ring       focus-visible:outline-ring  --color-ring
//   type             text-sm / text-3xl      --text-sm / --text-3xl
//   spacing, sizing  gap-3 / size-5 / h-9 / w-24   the scale generated from --spacing
//
// The figure sets no colour of its own on purpose. Card's root declares `text-foreground` and
// CardContent declares none, so the figure inherits full-contrast body colour; restating it here
// would be a second place to change when the token changes. The label, by contrast, must override
// CardTitle's `text-lg font-semibold text-foreground` down to a small muted caption - that is the
// stat-tile convention, big figure under a quiet label - and it does so through `className`, which
// Card merges last through `cn` so each utility wins its own property group.
//
// There is no `dark:` variant and no `@media` query. The tokens are dual-valued, declared once at
// the document root and again under the dark selector, so the tile re-themes with no conditional
// logic. And the tile is fluid at every width: the four-column grid that lays these out at the
// medium and large breakpoints belongs to the page that renders them, not to the tile.

import Link from 'next/link';
import type { ComponentProps } from 'react';

import { FileText, MessageSquare, Tags, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EMPTY_VALUE, formatCount } from '@/lib/format';
import type { AdminStats } from '@/lib/types';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/* Heading level                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Heading levels a tile may render its label at.
 *
 * Numeric rather than `'h2' | 'h3' | 'h4'` because a caller reasons about document *depth*
 * (`headingLevel={3}`), not about tag names; the mapping to a tag is this module's business.
 */
type StatCardHeadingLevel = 2 | 3 | 4;

/**
 * The heading tags this tile may ask `CardTitle` for.
 *
 * Derived from `CardTitle`'s own prop rather than restated, which is the composition guidance
 * card.tsx documents for wrappers: if that primitive ever narrows the levels it accepts, this file
 * fails to compile instead of quietly passing a tag the primitive no longer supports.
 *
 * `h1` is excluded, and the exclusion is the point. A page has exactly one `h1` and the overview
 * screen spends it on the page heading, so a tile can never be one.
 */
type StatCardHeadingTag = Exclude<NonNullable<ComponentProps<typeof CardTitle>['as']>, 'h1'>;

/**
 * Level-to-tag lookup.
 *
 * A `Record` over the closed union, so adding a level to {@link StatCardHeadingLevel} fails to
 * compile until it is given a tag here. Indexing it with a `StatCardHeadingLevel` yields a tag
 * rather than `tag | undefined` - these are declared properties, not an index signature, so
 * `noUncheckedIndexedAccess` has nothing to widen.
 */
const HEADING_TAG_BY_LEVEL: Record<StatCardHeadingLevel, StatCardHeadingTag> = {
  2: 'h2',
  3: 'h3',
  4: 'h4',
};

/**
 * The level a tile uses when the caller does not choose one.
 *
 * `2`, not `3`, and this is a correctness default rather than a taste one. The overview page's
 * minimal structure is a single `h1` with the tiles directly beneath it; defaulting to `3` would
 * skip from `h1` straight to `h3` on that page, which is precisely the broken outline the
 * ordered-heading requirement forbids. A page that introduces a section heading of its own passes
 * `headingLevel={3}` and stays correct.
 */
const DEFAULT_HEADING_LEVEL: StatCardHeadingLevel = 2;

/* -------------------------------------------------------------------------- */
/* Presentation constants                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Shown in place of a figure that cannot be displayed. An em dash - the conventional "no value
 * here" glyph, and the one src/lib/format.ts names when it explains that turning its empty
 * placeholder into something visible is the component's decision, not the formatter's.
 *
 * It is never announced: a screen reader reading "em dash" tells an operator nothing, so
 * {@link UNAVAILABLE_ANNOUNCEMENT} is substituted for assistive technology.
 */
const UNAVAILABLE_GLYPH = '—';

/** What assistive technology hears in place of {@link UNAVAILABLE_GLYPH}. */
const UNAVAILABLE_ANNOUNCEMENT = 'Not available';

/**
 * Turns `CardHeader`'s column into a row so the label and the icon sit on one line with the icon
 * pinned to the inline end.
 *
 * `flex-row` overrides the primitive's `flex-col` deterministically, because both are
 * `flex-direction` utilities and `cn` resolves a group last-wins. This is the sanctioned way to
 * adjust a primitive - the alternative, nesting another flex row inside the header, would add a
 * DOM level and duplicate the gap.
 */
const HEADER_CLASSES = 'flex-row items-center justify-between gap-3';

/**
 * The label: a small, quiet caption rather than `CardTitle`'s default prominent heading.
 *
 * `min-w-0` is load-bearing rather than cosmetic. As a flex item the heading's `min-width` defaults
 * to its content-based minimum, so a long label would refuse to shrink, push the icon out and put
 * the whole document into horizontal scroll at the narrowest viewport. `min-w-0` lets it shrink and
 * wrap instead - Card's root contributes the word-breaking that makes the wrap possible.
 */
const LABEL_CLASSES = 'min-w-0 text-sm font-medium text-muted-foreground';

/**
 * The decorative icon: quiet, fixed and never squeezed.
 *
 * Sized with `size-5` from the spacing scale, never with lucide's `size` prop - that prop takes a
 * NUMBER OF PIXELS, which would be exactly the hardcoded presentation value the token discipline
 * forbids. `shrink-0` keeps it at full size when a long label competes for the row, and the glyph
 * inherits its colour through `currentColor`.
 */
const ICON_CLASSES = 'size-5 shrink-0 text-muted-foreground';

/**
 * The figure. Large, tight and monospaced-by-digit.
 *
 * `tabular-nums` fixes every digit to the same advance width, so the four tiles' figures line up
 * with each other and a figure does not jitter horizontally when a count ticks over. It is a
 * `font-variant-numeric` utility - no length, no literal.
 */
const VALUE_CLASSES = 'text-3xl font-semibold tracking-tight tabular-nums';

/**
 * The loading placeholder's geometry.
 *
 * `h-9` is `2.25rem`, which is exactly the line box of `text-3xl` - so the placeholder occupies the
 * same height the figure will, and the tile does not resize and shove the rest of the band around
 * when the counts arrive. `w-24` is an indicative figure width; the placeholder is decoration and
 * does not need to predict the real digit count.
 */
const SKELETON_CLASSES = 'h-9 w-24';

/**
 * The optional link wrapping the label.
 *
 * Ordered as prettier-plugin-tailwindcss orders it, and composed through `cn` only so each group
 * can carry its own note.
 */
const LINK_CLASSES = cn(
  // Keeps the focus outline hugging the text rather than tracing a square around it.
  'rounded-sm',
  // Hover affordance. The engine gates `hover:` behind `@media (hover: hover)`, so a touch device
  // never gets a state stuck on after a tap. The underline travels with the colour change so the
  // affordance is not carried by colour alone.
  'hover:text-primary hover:underline',
  // Focus ring, in the document's own ring colour. `:focus-visible` rather than `:focus`, so the
  // ring appears for keyboard and assistive-technology users and not on a mouse click. globals.css
  // already sets a document-wide floor at this width; restating it here keeps the tile correct if
  // that floor is ever narrowed, and lands on the same 2px so nothing visibly changes thickness.
  'focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',
  // Colour transition only for visitors who have not asked for less motion.
  'motion-safe:transition-colors motion-safe:ease-out',
);

/* -------------------------------------------------------------------------- */
/* Figure resolution                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What the eye reads and what a screen reader hears, which are not always the same string.
 */
interface DisplayedCount {
  /** The glyph rendered on screen - abbreviated for large counts. */
  readonly visible: string;
  /** The precise, unabbreviated equivalent for assistive technology. */
  readonly announced: string;
}

/**
 * Resolves a count into its visible and announced forms.
 *
 * ### Why two forms rather than one
 *
 * `formatCount` abbreviates at a thousand, so `1234` reads `'1.2K'`. That is right for the eye and
 * wrong for an ear: an administrator listening to a moderation queue needs the number, not its
 * order of magnitude, and "one point two K" is not a number they can act on. So the compact form is
 * shown and the exact form is announced.
 *
 * The two are reconciled by COMPARISON, never by re-deriving the threshold. This function does not
 * know, and must not know, that abbreviation begins at a thousand: it formats, then asks whether the
 * result still spells the number out. That is what keeps the rule in one place - if the formatter's
 * threshold or notation ever changes, this stays correct with no edit.
 *
 * ### The whole domain of `number`, not just the plausible part
 *
 * `formatCount` is total and returns its empty placeholder for anything that cannot be a tally -
 * absent, negative, `NaN`, `Infinity`. Those reach the placeholder branch and are reported as
 * unavailable. They are emphatically NOT reported as `0`: a zero is a claim, and an operator who
 * reads "0 comments" when the truth is "we do not know" will act on it.
 *
 * `Math.floor` is only reached once the formatter has already accepted the value, which is what
 * guarantees it is finite and non-negative there; it mirrors the normalisation `formatCount`
 * documents so the announced figure can never disagree with the rendered one.
 *
 * @param value - The count to display.
 * @returns The pair of strings the tile renders. Equal strings mean no precision was lost.
 */
function resolveDisplayedCount(value: number): DisplayedCount {
  const compact = formatCount(value);

  // Compared against the exported constant rather than a bare '' so this guard is pinned to the
  // format module's documented placeholder convention instead of re-stating it.
  if (compact === EMPTY_VALUE) {
    return { visible: UNAVAILABLE_GLYPH, announced: UNAVAILABLE_ANNOUNCEMENT };
  }

  return { visible: compact, announced: String(Math.floor(value)) };
}

/* -------------------------------------------------------------------------- */
/* StatCard                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Props of {@link StatCard}.
 *
 * Exported so the overview page can type a helper around the tile without restating the shape.
 */
export interface StatCardProps {
  /**
   * The caption naming what is being counted - `'Users'`, `'Posts'`, `'Comments'`, `'Categories'`.
   *
   * Rendered as a real heading, so it also names the tile for assistive technology and appears in
   * the document outline. Keep it short: it shares a row with the icon.
   */
  label: string;

  /**
   * The figure to display - one of the four counts on `AdminStats`.
   *
   * A plain `number`, not the `AdminStats` object, and that is a deliberate constraint rather than
   * a simplification. A tile typed against the resource would have to choose which field to read,
   * which is the one decision that makes it four components instead of one. The caller reads the
   * field - `stats.user_count`, in the wire's own snake_case - and passes the number.
   *
   * Every `number` is handled, not merely the plausible ones: see {@link resolveDisplayedCount}.
   * While `isLoading` is set this prop is ignored entirely, so a caller with nothing yet may pass
   * any placeholder without it ever being rendered as though it were real.
   */
  value: number;

  /**
   * An optional decorative glyph for the label row.
   *
   * A lucide icon COMPONENT (`Users`), not rendered markup (`<Users />`), so this module owns the
   * two things that must not be left to a call site: the token-derived size, and hiding the glyph
   * from assistive technology. The icon only ever restates the label, so announcing it would make
   * every tile say its name twice.
   */
  icon?: LucideIcon;

  /**
   * Optional path to the management screen for this entity - `'/admin/users'` and friends.
   *
   * When present, the label becomes a link and the tile gains exactly one interactive element. The
   * card itself is never the link: a card wrapped in an anchor is invalid the moment it contains
   * any other control, traps the keyboard and collapses the whole tile into one unusable accessible
   * name. The link's name is the label, which reads correctly on its own in a list of links.
   */
  href?: string;

  /**
   * Whether the count is still in flight.
   *
   * The label stays put and the figure is replaced by a placeholder of the same height, so the tile
   * neither jumps nor claims a number it does not have.
   */
  isLoading?: boolean;

  /**
   * Heading level for the label. Defaults to `2`.
   *
   * Forwarded to `CardTitle`. Pass the level that follows the heading the tile actually sits under,
   * so the page's outline has no skipped level. `h1` is not offered - see
   * {@link StatCardHeadingTag}.
   */
  headingLevel?: StatCardHeadingLevel;

  /**
   * Optional classes merged over the tile's own, for layout only.
   *
   * Intended for a caller placing the tile in a grid track. Merged through `cn`, so a utility wins
   * its own property group. Restyling the surface or the type through this prop steps outside the
   * tokens the tile is built on; adjust the token layer instead.
   */
  className?: string;
}

/**
 * A single aggregate count from the administrative overview, presented as a labelled tile.
 *
 * Renders a `Card` whose header carries the label - as a heading, optionally linking to the
 * matching management screen - beside an optional decorative icon, above the figure itself.
 *
 * ### Accessibility
 *
 * - The label is a real heading, so it names the tile in the document outline and a screen-reader
 *   user can navigate the band heading by heading. The figure sits inside the same card, so the
 *   relationship is structural rather than a matter of visual proximity.
 * - Large figures are abbreviated on screen and announced in full. The precise figure is exposed as
 *   TEXT, hidden visually, rather than through `aria-label`: ARIA prohibits a name on the generic
 *   and paragraph roles that this markup uses, so an `aria-label` here would be legal-looking and
 *   free to be ignored - and `title` is unreliable for assistive technology besides. When no
 *   precision is lost the figure is a single node, so nothing is announced twice.
 * - While loading, the card is marked `aria-busy` and the label stays rendered, so the tile never
 *   presents an empty accessible name. (`aria-busy` is a global state and is permitted here; it is
 *   the naming attributes that the roles in this markup prohibit.)
 * - The icon is hidden from assistive technology, and any link carries a visible focus ring.
 *
 * @param props - See {@link StatCardProps}.
 * @returns The tile.
 *
 * @example The overview band, covering every count the endpoint returns
 * ```tsx
 * <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
 *   {ADMIN_STAT_CARDS.map((card) => (
 *     <StatCard
 *       key={card.key}
 *       href={card.href}
 *       icon={card.icon}
 *       isLoading={isPending}
 *       label={card.label}
 *       value={stats[card.key]}
 *     />
 *   ))}
 * </div>
 * ```
 *
 * `stats[card.key]` reads the WIRE field name. The API is snake_case throughout and this tier does
 * no camel-case mapping, so the count is `stats.user_count` - never an invented `stats.userCount`,
 * which would compile against nothing and evaluate to `undefined`.
 *
 * @example One tile on its own, nested under a section heading
 * ```tsx
 * <StatCard headingLevel={3} label="Pending comments" value={42} />
 * ```
 */
export function StatCard({
  label,
  value,
  icon: Icon,
  href,
  isLoading = false,
  headingLevel = DEFAULT_HEADING_LEVEL,
  className,
}: StatCardProps): React.JSX.Element {
  const { visible, announced } = resolveDisplayedCount(value);

  return (
    // The default `div`: a stat tile is a panel, not an independently distributable article.
    // `aria-busy` is omitted rather than set to "false" when idle, since that is the default state.
    <Card aria-busy={isLoading ? true : undefined} className={className}>
      <CardHeader className={HEADER_CLASSES}>
        <CardTitle as={HEADING_TAG_BY_LEVEL[headingLevel]} className={LABEL_CLASSES}>
          {href === undefined ? (
            label
          ) : (
            // The interactive element lives INSIDE the heading, so its accessible name is exactly
            // the label and the rest of the tile stays free of it.
            <Link className={LINK_CLASSES} href={href}>
              {label}
            </Link>
          )}
        </CardTitle>

        {/*
         * Purely decorative, and hidden explicitly rather than relying on any library default:
         * the requirement is on this markup. It duplicates the label, so announcing it would only
         * repeat what the heading already said.
         */}
        {Icon === undefined ? null : <Icon aria-hidden="true" className={ICON_CLASSES} />}
      </CardHeader>

      <CardContent>
        {isLoading ? (
          <Skeleton className={SKELETON_CLASSES} />
        ) : (
          <p className={VALUE_CLASSES}>
            {/*
             * One node when the visible glyph already spells the number out, so a test's text query
             * stays unambiguous and no reader hears the figure twice. Two only when the visible
             * form has lost precision, or when there is no figure to show at all.
             */}
            {visible === announced ? (
              visible
            ) : (
              <>
                <span aria-hidden="true">{visible}</span>
                <span className="sr-only">{announced}</span>
              </>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* The overview band's descriptors                                            */
/* -------------------------------------------------------------------------- */

/**
 * Everything the overview page needs to render one tile, minus the count itself.
 *
 * Generic in the field it reads so {@link ADMIN_STAT_CARDS} keeps each entry's `key` as a literal
 * type; a caller can then index `AdminStats` with it and get a `number` back.
 */
export interface AdminStatCardDescriptor<K extends keyof AdminStats = keyof AdminStats> {
  /**
   * The `AdminStats` field this tile displays, spelled exactly as the service emits it.
   *
   * Typed as `keyof AdminStats` rather than `string`, which is the single most valuable constraint
   * in this file: a misspelling or a camel-case slip is a compile error here instead of an
   * `undefined` figure at run time.
   */
  readonly key: K;
  /** The tile's caption. */
  readonly label: string;
  /** Path to the management screen for this entity. */
  readonly href: string;
  /** The tile's decorative glyph. */
  readonly icon: LucideIcon;
}

/**
 * One descriptor per aggregate count, in the order the overview band displays them.
 *
 * A plain constant with no logic and no I/O - it exists so the four counts, their captions, their
 * destinations and their glyphs are declared exactly once, and so the page can render the band by
 * mapping rather than by four hand-written tiles that can drift apart.
 *
 * `as const` keeps each `key` a literal, which is what lets a caller write `stats[card.key]`.
 * {@link AdminStatCardsCoverEveryCount} is what makes the coverage a guarantee rather than a
 * convention.
 */
export const ADMIN_STAT_CARDS = [
  { key: 'user_count', label: 'Users', href: '/admin/users', icon: Users },
  { key: 'post_count', label: 'Posts', href: '/admin/posts', icon: FileText },
  { key: 'comment_count', label: 'Comments', href: '/admin/comments', icon: MessageSquare },
  { key: 'category_count', label: 'Categories', href: '/admin/categories', icon: Tags },
] as const satisfies readonly AdminStatCardDescriptor[];

/**
 * Passes `T` through, and fails to compile when it is anything but `true`.
 *
 * The indirection is what turns a type-level question into a build error. A bare type alias can
 * hold a wrong answer indefinitely - nothing checks it - whereas a constraint violation is
 * reported where it is written.
 */
type AssertTrue<T extends true> = T;

/**
 * Compile-time proof that {@link ADMIN_STAT_CARDS} has a tile for every count on `AdminStats`.
 *
 * Resolves to `true` today. Add a count to `AdminStats` without adding a descriptor and this line
 * fails with "Type 'false' does not satisfy the constraint 'true'", which is the whole point of
 * keying the descriptors on `keyof AdminStats`: the overview screen cannot silently omit a count.
 *
 * Exported deliberately. The assertion has to be *declared* somewhere to be checked, and an
 * unreferenced local declaration is the sort of thing a lint rule removes; exported, it is also
 * available to a caller that wants to state the same guarantee about its own rendering.
 *
 * The single-element tuples are not decoration: they stop `never` from short-circuiting the
 * conditional, which is what would happen if the union were tested bare.
 */
export type AdminStatCardsCoverEveryCount = AssertTrue<
  [Exclude<keyof AdminStats, (typeof ADMIN_STAT_CARDS)[number]['key']>] extends [never]
    ? true
    : false
>;
