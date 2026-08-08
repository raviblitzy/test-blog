// Alert - the inline-notice and empty-state primitive.
//
// One of the nine primitives in this folder authored over semantic HTML instead
// of wrapped around a Radix behavioural primitive. Radix ships no alert, so the
// live-region contract below is this file's own responsibility rather than
// something inherited from a package.
//
// ---------------------------------------------------------------------------
// WHY ONE COMPONENT SERVES TWO JOBS - THE POINT OF THIS FILE
//
// This primitive is mapped to "inline notice / empty state", and that pairing is
// deliberate rather than a convenience. A failed sign-in has to be ANNOUNCED the
// moment it appears; an empty-feed panel is ordinary page content and must
// announce nothing at all. Those are opposite behaviours, and what reconciles
// them is that the live-region role is DERIVED FROM THE VARIANT instead of being
// fixed:
//
//     variant="destructive"      ->  role="alert"   assertive: interrupts
//                                                   whatever the screen reader
//                                                   is saying
//     variant="success"|"warning" ->  role="status"  polite: announced once the
//                                                   user is idle
//     variant="info"|"empty"     ->  NO ROLE        ordinary page content that
//                                                   announces nothing at all
//
// WHY `info` AND `empty` GET NO LIVE REGION, WHICH IS THE SUBTLE PART
//
// A live region is a promise that the element's content will CHANGE and that the
// change is worth interrupting the reader's own navigation to hear. `success` and
// `warning` keep it because they are outcomes - they appear in response to
// something the visitor just did, which is exactly the case `role="status"`
// exists for. `info` and `empty` are the opposite: they are rendered as part of
// the page, present in the very first HTML the server sends, and giving them a
// live region makes every page load announce "no posts match this filter"
// unprompted, out of document order, ahead of the heading and the search field
// that would let the visitor act on it. An empty state is CONTENT. It is read
// when the reader arrives at it, like any other paragraph.
//
// So the default is silence, and speech is the exception - which is also the
// right way round for the failure case: a role that is applied everywhere gets
// tuned out, and a `status` on a submission error is easy to miss entirely.
//
// A consumer that renders `info` or `empty` INTO an already-loaded page, where
// the panel really does appear in response to an action, opts in explicitly:
// `<Alert variant="empty" role="status">`. The variant-derived role is applied
// BEFORE the props spread, so that opt-in wins - and so does the opposite
// direction, where a caller that has already wrapped a destructive alert in its
// own live region passes `role="none"` to stop the announcement being made twice.
//
// ---------------------------------------------------------------------------
// TOKEN DISCIPLINE
//
// Every colour, radius, spacing step, icon size and text size below resolves to
// a token declared in src/app/globals.css - there is no literal colour or
// dimension anywhere in this file. The variants reference the SEMANTIC layer
// (`danger`, `success`, `warning`, `surface-muted`, `border`, `foreground`,
// `muted-foreground`) and never a primitive family and shade, which is what
// makes dark mode automatic: globals.css declares each token twice and this file
// needs no `dark:` conditional and carries none.
//
// Bracket expressions here are all VARIANTS - `[&>svg]:`, `[&_p+p]:`,
// `has-[>svg]:` - which are CSS selectors, not values. No bracket carries a
// colour or a dimension; the compiled output resolves every one of them through
// `var(--spacing)` or `var(--color-*)`.
//
// WHY EVERY VARIANT SHARES THE `surface-muted` GROUND INSTEAD OF A TINT
//
// A translucent tint per variant - a background utility carrying a ten-percent
// opacity modifier on the danger, success or warning token - is a supported
// pattern in this token layer and it looks richer, so the omission is
// deliberate. (Those utility names are spelled out in prose rather than written
// literally anywhere in this file, because the engine's scanner reads comments
// too and would emit dead rules for any candidate it finds here.)
//
// globals.css states the contrast ratio it has COMPUTED for each
// pair it expects to be used, and the three it computed for this component are
// `danger/surface-muted`, `success/surface-muted` and `warning/surface-muted` -
// coloured text on the recessed neutral ground. Tinting the ground moves the
// measurement off those pairs, and because every token in this theme is a dark
// value in light mode, a tint DARKENS the ground and narrows the gap rather than
// widening it.
//
// That is not hypothetical. Measured in a browser: `text-success` over a
// ten-percent success tint composited on the page canvas gives 4.11:1, under
// the 4.5:1 WCAG AA floor for body text, where the same token over
// `bg-surface-muted` gives the 4.51:1 globals.css documents. That quietly broke
// a guarantee the
// token layer had already computed and published - and worse, it made that
// guarantee depend on arithmetic performed HERE, so any future palette edit in
// globals.css would need re-measuring against this file to stay valid.
//
// Sitting every variant on the ground the token layer measured keeps its
// published figures true by construction, and the variants stay clearly
// distinct: a full-strength token border, matching token text, plus a dashed
// border and centred content for the empty state. No opacity modifier is used
// anywhere in this file.
//
// ---------------------------------------------------------------------------
// DELIBERATELY ABSENT. PLEASE DO NOT ADD.
//
//   1. `'use client'`. This module has to stay shared. src/app/error.tsx,
//      src/app/not-found.tsx and the server-rendered empty feed all render it,
//      and it uses no hook, no state and no browser API. Adding the directive
//      would drag every one of those trees across the client boundary and, on
//      the post and profile pages, discard exactly the server-rendered HTML the
//      SEO requirement depends on.
//   2. A dismiss button, and the `useState` it would need. That would force item
//      1. A consumer who wants a dismissible notice composes
//      `@/components/ui/button` and owns the state in its own client component -
//      where the boundary belongs.
//   3. Toast behaviour of any kind: no portal, no timer, no stacking, no
//      auto-dismiss, no imperative `alert()` helper. Toast is a separate concern
//      owned by `sonner`, and @radix-ui/react-toast is not a dependency of this
//      project. An Alert renders where it is written and stays there.
//   4. `aria-live`, `aria-atomic` or `aria-relevant`. `role="alert"` already
//      implies `aria-live="assertive"` and `role="status"` implies
//      `aria-live="polite"`; restating them adds nothing and risks a
//      double announcement.
//   5. A built-in icon, and therefore any `lucide-react` import. The icon is
//      caller-supplied so this component never has to choose a glyph it cannot
//      caption. Pass it as the FIRST child and mark it `aria-hidden="true"`: the
//      title and description already carry the meaning, so an announced icon
//      would only repeat them. The base styles position and size whatever `svg`
//      arrives.
//   6. `forwardRef`. React 19 passes `ref` through as an ordinary prop, so the
//      spread already forwards it.
//   7. Any `@media` query or `dark:` utility. The five breakpoints in the token
//      layer are the whole responsive vocabulary, and this primitive is fluid at
//      every one of them - it needs neither.
//   8. Exported prop interfaces. They are declared locally, matching
//      src/providers/theme-provider.tsx; a consumer that needs them writes
//      `ComponentProps<typeof Alert>` and so cannot drift from the real surface.

import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ElementType, JSX } from 'react';

import { cn } from '@/lib/utils';

/**
 * Container styles for {@link Alert}, exported so a consumer can reuse the exact
 * treatment on an element this component does not render - a `<form>` wrapping
 * its own error summary, for instance.
 *
 * Compose it through `cn()` rather than using the returned string directly, so
 * that a caller's `className` reliably wins its property group:
 *
 * ```tsx
 * <form className={cn(alertVariants({ variant: 'destructive' }), 'mt-6')} />
 * ```
 */
const alertVariants = cva(
  [
    // `grid` stacks the title and description in one column separated by a token
    // gap, rather than by margins between siblings.
    //
    // `wrap-anywhere`, which compiles to `overflow-wrap: anywhere`. Choosing it
    // over the utility that emits `overflow-wrap: break-word` is not cosmetic.
    // The base layer in globals.css applies `overflow-wrap` to `p`, `li` and
    // friends but never to a bare `div`, and both parts below are divs, so a
    // pasted URL or a long slug needs a wrap rule from here. The break-word
    // value looks like the right one and silently is not: CSS Text 3 excludes
    // the soft-wrap opportunities it introduces from MIN-CONTENT intrinsic
    // sizing, while `anywhere` includes them. Because this element is
    // a grid container, each part is a grid item whose automatic minimum size
    // resolves to its own min-content - so under `break-word` one unbreakable
    // token pins the track to the token's full width, the alert grows past its
    // parent, and every sibling sharing that parent's column is dragged wide
    // with it. Measured: at a 375px viewport `break-word` left the document
    // 542px wider than the viewport with the URL still on one line, and
    // switching this single utility to `anywhere` collapsed it to exactly the
    // viewport width with the URL wrapped over three lines. Rendering of text
    // that already fits is identical between the two, so this costs nothing.
    'relative grid w-full gap-1 rounded-lg border p-4 text-sm wrap-anywhere',

    // The optional leading icon. Taking it out of flow is what lets it sit
    // beside the text without becoming a grid row of its own, and without this
    // component having to render a wrapper element around children it does not
    // control. `start-4` is the logical inline-start inset, so the icon moves to
    // the correct side under a right-to-left document with no extra rules. The
    // half-step nudge optically centres a 4-step glyph against the first line of
    // a `text-sm` title.
    '[&>svg]:absolute [&>svg]:top-4 [&>svg]:start-4 [&>svg]:size-4',
    '[&>svg]:translate-y-0.5',

    // Room for that icon is reserved ONLY when one is actually present, so an
    // alert without an icon has no dead inline-start gutter. 11 steps clears the
    // 4-step inset plus the 4-step glyph plus a 3-step gap.
    'has-[>svg]:ps-11',
  ],
  {
    variants: {
      /**
       * Selects both the tone and - through {@link Alert} - the live-region
       * role. Tone is never the only carrier of meaning: the title and
       * description text always says what has happened, so the component
       * remains unambiguous to a visitor who cannot distinguish these colours.
       */
      variant: {
        /**
         * Neutral informational notice, and the default. A recessed panel with
         * full-strength body text - the treatment for "here is something you
         * should know" that carries no success or failure connotation.
         */
        info: 'border-border bg-surface-muted text-foreground',

        /**
         * Affirmative outcome: a post published, a comment approved, a profile
         * saved. `success` is the token globals.css designates for exactly these
         * states, and this is the tightest contrast pair in the set at the
         * 4.51:1 the token layer computed for it - which is why the ground here
         * must stay `surface-muted` rather than becoming a tint.
         */
        success: 'border-success bg-surface-muted text-success',

        /**
         * Cautionary notice - a destructive action about to be confirmed, or a
         * draft that has not been published yet.
         *
         * `warning` is the token globals.css declares for exactly this state, and
         * using it is what keeps the five variants distinguishable: the brand
         * `accent` would make "caution" and "emphasis" the same colour, and
         * `danger` would make `warning` and `destructive` identical and so make
         * the choice between them meaningless. The token layer measures it at
         * 4.61:1 on this ground in light and 8.54:1 in dark, so the tone is
         * legible in both themes - and, as with every variant here, the title and
         * description text says what has happened, so the tone is never the only
         * carrier of the meaning.
         */
        warning: 'border-warning bg-surface-muted text-warning',

        /**
         * Error or failure, and the only variant that announces assertively. Use
         * it for a rejected submission, a failed request, or the message in an
         * error boundary.
         */
        destructive: 'border-danger bg-surface-muted text-danger',

        /**
         * Empty state: "no posts match this filter", "no comments yet". A quiet,
         * centred panel with a dashed hairline, so it reads as an absence of
         * content rather than as a notice demanding attention - and so that it
         * is distinguishable from `info` by shape and alignment, not by colour
         * alone. It carries NO live-region role, which is what keeps a
         * server-rendered empty feed from announcing itself on load; a caller that
         * renders one in response to an action passes `role="status"` itself.
         *
         * The leading-icon slot is designed for the notice variants: an `svg`
         * first child is pinned to the inline-start edge, which reads correctly
         * beside start-aligned text but not above centred text. An empty state
         * that wants a centred glyph should render it inside the description
         * instead of as a direct child.
         */
        empty: [
          'border-border border-dashed bg-surface-muted text-muted-foreground',
          'justify-items-center text-center',
        ],
      },
    },
    defaultVariants: {
      variant: 'info',
    },
  },
);

/** Props of {@link Alert}: every `div` attribute, plus the `variant` selector. */
type AlertProps = ComponentProps<'div'> & VariantProps<typeof alertVariants>;

/**
 * The live-region role each variant announces through, or `undefined` for the two
 * that are ordinary page content and must announce nothing.
 *
 * Declared as an exhaustive table rather than written inline as a conditional, for
 * the same reason the variant classes are a table: adding a sixth variant then
 * fails to compile until its announcement behaviour has been decided, instead of
 * silently inheriting whichever branch a ternary happened to end on. The header's
 * "WHY `info` AND `empty` GET NO LIVE REGION" section is the reasoning behind the
 * two `undefined` entries.
 */
const ALERT_ROLES: Readonly<
  Record<NonNullable<VariantProps<typeof alertVariants>['variant']>, 'alert' | 'status' | undefined>
> = {
  // Ordinary page content, present in the server's first HTML. Read in document
  // order like any paragraph; a caller that renders one in response to an action
  // passes `role="status"` itself.
  info: undefined,
  empty: undefined,
  // Outcomes of something the visitor just did: announced politely, once idle.
  success: 'status',
  warning: 'status',
  // A failure the visitor has to act on: announced assertively.
  destructive: 'alert',
};

/**
 * An inline notice or empty-state panel.
 *
 * Announcement behaviour is derived from `variant`: `destructive` announces
 * assertively as `role="alert"`, `success` and `warning` announce politely as
 * `role="status"`, and `info` and `empty` are ordinary page content with no
 * live-region role at all - see the header for why silence is the default. Pass
 * `role` explicitly to override in either direction.
 *
 * Compose it from {@link AlertTitle} and {@link AlertDescription}, optionally
 * preceded by an icon as the first child:
 *
 * ```tsx
 * <Alert variant="destructive">
 *   <TriangleAlert aria-hidden="true" />
 *   <AlertTitle>We could not sign you in</AlertTitle>
 *   <AlertDescription>Check your email and password, then try again.</AlertDescription>
 * </Alert>
 * ```
 *
 * This is not a toast. It renders where it is written and does not disappear on
 * its own; reach for `sonner` when you want transient feedback.
 *
 * @param variant - Tone and announcement behaviour. Defaults to `info`, which is
 *   silent.
 * @param className - Merged through `cn()`, so it overrides the variant's own
 *   classes within each property group.
 * @param props - Every other `div` prop, including `ref`, spread onto the root.
 *   A `role` passed here replaces the variant-derived default.
 */
function Alert({ variant, className, ...props }: AlertProps): JSX.Element {
  return (
    <div
      // Placed before the spread so an explicit caller `role` wins. `variant` is
      // `null | undefined` when omitted, and both fall through to the `info`
      // branch - which is correct, because `info` is the default variant, and
      // `undefined` here means the attribute is not rendered at all rather than
      // rendered empty.
      role={ALERT_ROLES[variant ?? 'info']}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

/**
 * The elements {@link AlertTitle} is allowed to render as.
 *
 * A heading is offered but never the default. Heading order is a page-level
 * concern - one `h1` per page, no skipped levels - and a primitive cannot know
 * where in an outline it has been placed, so hardcoding `h2` here would let an
 * alert silently corrupt the document outline of any page that renders one
 * inside a section. The consumer picks the level that fits, or leaves it a
 * non-heading element.
 */
type AlertTitleElement = 'div' | 'p' | 'span' | 'strong' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

/**
 * Tag allow-list, indexed by `as` to obtain the JSX element type.
 *
 * The internal counterpart of the discriminated `AlertTitleProps` union below,
 * and required for the same reason `@/components/ui/card` needs its own: with the
 * tag typed as the literal union, React demands props assignable to EVERY member
 * at once and `ref` is invariant, so `Ref<HTMLSpanElement>` is rejected against
 * `Ref<HTMLDivElement>`. A member access on a module-level constant is opaque to
 * control-flow narrowing, so the tag really does have type `ElementType`; it is
 * also a STATIC component lookup, which is what keeps
 * `react-hooks/static-components` quiet under `--max-warnings=0` where a helper
 * call in the same position would fail. `Record<AlertTitleElement, ElementType>`
 * is exhaustive, so widening the union fails to compile until this table and the
 * props union are both extended.
 */
const ALERT_TITLE_ELEMENTS: Record<AlertTitleElement, ElementType> = {
  div: 'div',
  p: 'p',
  span: 'span',
  strong: 'strong',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  h6: 'h6',
};

/**
 * The public props of {@link AlertTitle}: one branch per element it may render as.
 *
 * A discriminated union rather than `ComponentProps<'div'> & { as?: ... }`,
 * because these tags are genuinely different element interfaces -
 * `HTMLDivElement`, `HTMLParagraphElement`, `HTMLSpanElement`, `HTMLElement` and
 * `HTMLHeadingElement`. The intersection form types every branch as a `div`, so a
 * caller passing `ref` on `<AlertTitle as="h2">` either gets a rejection or, worse,
 * a `RefObject<HTMLDivElement>` pointing at a heading. Discriminating on the `as`
 * literal gives each branch that element's own attributes and its own `ref`.
 *
 * The five heading levels share one branch because they share one DOM interface;
 * `div`, `p`, `span` and `strong` each need their own. `as` is optional only on
 * the `div` branch, which is what makes `<AlertTitle>` resolve to it.
 */
type AlertTitleProps =
  | (ComponentProps<'div'> & {
      /** Element to render. Omit for the default `div`, which assumes no heading level. */
      as?: 'div';
    })
  | (ComponentProps<'p'> & {
      /** Element to render. @see {@link AlertTitleElement} */
      as: 'p';
    })
  | (ComponentProps<'span'> & {
      /** Element to render. @see {@link AlertTitleElement} */
      as: 'span';
    })
  | (ComponentProps<'strong'> & {
      /** Element to render. @see {@link AlertTitleElement} */
      as: 'strong';
    })
  | (ComponentProps<'h2'> & {
      /** Heading level to render. All five levels share one branch - one DOM interface. */
      as: 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
    });

/**
 * The alert's headline - one short line saying what happened.
 *
 * Takes its colour from the surrounding {@link Alert}, so it carries the
 * variant's tone without needing to know which variant is in play. Weight, not
 * colour, is what distinguishes it from the description.
 *
 * @param as - Element to render. `div` by default; pass a heading level only
 *   where it genuinely fits the page's outline.
 * @param className - Merged through `cn()`.
 * @param props - Every other prop, including `ref`, spread onto the element.
 */
function AlertTitle({ as = 'div', className, ...props }: AlertTitleProps): JSX.Element {
  const Component = ALERT_TITLE_ELEMENTS[as];

  return <Component className={cn('font-medium tracking-tight', className)} {...props} />;
}

/** Props of {@link AlertDescription}: every `div` attribute. */
type AlertDescriptionProps = ComponentProps<'div'>;

/**
 * The alert's supporting copy - what it means, or what to do next.
 *
 * Accepts inline content and element children alike, so a bare string, a
 * sentence containing a link, or several `<p>` elements all render correctly;
 * consecutive paragraphs are separated by a token step.
 *
 * Its colour is INHERITED from the surrounding {@link Alert} rather than fixed
 * here, and that is the design rather than an omission. The tone that is correct
 * for this text differs per variant - `danger` inside a destructive alert,
 * `muted-foreground` inside an empty state - and a part cannot read its parent's
 * variant without React context, which would make this module a client
 * component and cost every server-rendered consumer its server rendering.
 * Inheritance gets the right token in all five cases for free. Pass a token
 * colour through `className` if a particular alert needs to differ.
 *
 * @param className - Merged through `cn()`.
 * @param props - Every other `div` prop, including `ref`, spread onto the root.
 */
function AlertDescription({ className, ...props }: AlertDescriptionProps): JSX.Element {
  return <div className={cn('text-sm leading-relaxed [&_p+p]:mt-2', className)} {...props} />;
}

export { Alert, AlertDescription, AlertTitle, alertVariants };
