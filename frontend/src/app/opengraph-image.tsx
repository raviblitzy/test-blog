// Default social card - the OpenGraph and Twitter image for `/` and for every route that does not
// generate one of its own.
//
// Next.js picks this file up by convention because of where it sits: an `opengraph-image` module at
// the root of the App Router tree becomes the inherited `og:image` and `twitter:image` for the
// whole tree. Nothing imports it and nothing may: the four exports below are read by the framework,
// which mounts the generated raster as a route and writes the corresponding meta tags. A post that
// has its own cover image overrides it in `src/app/blog/[slug]/page.tsx`'s `generateMetadata`; this
// is the fallback beneath all of that.
//
// Seven decisions below look unusual for a file under src/, and each one is load-bearing. The notes
// exist so that none of them is "corrected" by a later reader into something that breaks.
//
// ---------------------------------------------------------------------------------------------
// 1. WHY THIS FILE CARRIES LITERAL COLOURS WHEN NO OTHER COMPONENT MAY
//
// The project rule is zero hardcoded presentation values: a component names a semantic token and
// never a literal. `ImageResponse` renders through Satori, which converts JSX to SVG and then to a
// PNG entirely outside any browser and outside the page's CSS cascade. It does not run the PostCSS
// pipeline, so a Tailwind utility class means nothing to it, and it cannot resolve
// `var(--color-primary)` because no cascade exists in which that property is declared. There is
// therefore no token-based way to express a colour here, and the graceful-degradation ladder ends
// at its last rung: the need cannot be met with tokens at all.
//
// src/app/globals.css already anticipated this file by name. Its PALETTE PARITY block lists the
// five artifacts that must hold the palette BY VALUE rather than by reference - public/icon.svg,
// public/favicon.ico, public/apple-icon.png, public/og-default.png and this module - and publishes
// the measured hex for each token so that all five can be kept in step. {@link PALETTE} below is
// copied from that table and from nowhere else. The exception covers COLOUR, and only inside this
// file: no literal colour appears in the JSX, only references to those three named entries.
//
// ---------------------------------------------------------------------------------------------
// 2. WHY NOTHING FROM src/components IS IMPORTED - SATORI JSX IS NOT DOM
//
// The fifteen primitives in src/components/ui are React DOM components that style themselves with
// Tailwind classes, and six of them wrap Radix behavioural primitives that need a browser and a
// client runtime. None can render here: Satori accepts a small subset of flexbox layout, has no
// DOM, no event loop and no hydration. So this card is built from plain `div` elements with inline
// style objects, which in this one context is the correct construction rather than a bypass of the
// design system. Nothing here is interactive, so none of the primitives' behaviour is lost.
//
// The same reasoning rules out the rest of the CSS vocabulary Satori does not implement: no grid,
// no float, no pseudo-element, no box-shadow, no custom property, no media query. A fixed 1200x630
// raster has no viewport to respond to, so the five breakpoints are irrelevant here too.
//
// ---------------------------------------------------------------------------------------------
// 3. WHY THIS CARD SHOWS THE SITE NAME AND public/og-default.png DOES NOT
//
// The two artifacts are deliberately not the same thing, and the asymmetry is the whole reason both
// exist. public/og-default.png is a static file served from a fixed path; it cannot know the site
// name, so its own contract requires it to carry no product name, wordmark, domain or URL, and it
// draws abstract bars where text would go. This module is generated per request, so it can render
// the configured name - and does. Neither reads the other: this file never imports, re-encodes or
// redirects to that PNG, and that PNG is not regenerated from this file.
//
// What they DO share is the brand: the same three palette values, the same 10% inset panel, the
// same mark at the same place and the same type sizes, so a reader who receives one has no way to
// tell it from the other. The geometry constants below were measured out of that PNG for exactly
// that reason.
//
// ---------------------------------------------------------------------------------------------
// 4. WHY THE MARK IS ARITHMETIC AND NOT AN INLINE COPY OF public/icon.svg
//
// public/icon.svg is the vector master for the whole icon family: a rounded square field carrying
// three bars, the last one short so the mark reads as written text rather than as a menu glyph.
// Every dimension of the mark drawn below is that file's own coordinate multiplied by
// {@link MARK_SCALE}, so the relationship is visible in the source and a change to the master is a
// one-constant change here. Copying its markup instead would have been worse in two ways: Satori's
// SVG support is narrower than a browser's, and a duplicated path would drift silently.
//
// ---------------------------------------------------------------------------------------------
// 5. FONTS - THE SHIPPED FACE, DELIBERATELY
//
// No font is loaded. `ImageResponse` ships one face, Geist Regular, and uses it when the `fonts`
// option is absent; that is what this module relies on. The alternatives are both defects here.
// Fetching a font over the network would make a decorative fallback card depend on a third-party
// host at render time, and reading one from a filesystem path would break under
// `output: 'standalone'` in frontend/next.config.ts, whose trace only carries files the build can
// see being imported - a failure that appears in the container image and never in `next dev`.
//
// The shipped face has ONE weight. `fontWeight: 700` would find no bold face and resolve back to
// 400 with no warning, so the site name is made dominant by size and letter-spacing instead, which
// is why no `fontWeight` appears below at all. `fontFamily` is likewise absent: naming a family
// Satori has not been given would fall back to the same face by a longer route.
//
// ---------------------------------------------------------------------------------------------
// 6. NO DATA, NO NETWORK, NO ENVIRONMENT READ
//
// This module performs no `fetch` and imports nothing from @/lib/api. It is the DEFAULT card: a
// per-post card comes from the post route's own metadata, so fetching here would buy nothing and
// would make the fallback fail in precisely the situation a fallback exists for. The card renders
// with the service stopped.
//
// It also reads no `process.env` key. `resolveSiteName` in @/lib/seo is the tier's single declared
// reader of NEXT_PUBLIC_SITE_NAME, and going through it is what keeps the name on this card, in the
// document title template and in every other social card the same string.
//
// ---------------------------------------------------------------------------------------------
// 7. GOVERNING STANDARDS
//
// No user-specified rules were provided for this project, so the binding constraints are the
// technical plan's own enterprise standards. Five govern this module: zero hardcoded presentation
// values (see 1, the one sanctioned exception, scoped to colour); accessibility as a floor (the
// {@link alt} export, because a card with no alternative text is inaccessible everywhere it is
// embedded); configuration from the environment only (see 6); layered separation (see 6); and the
// blocking quality gates - this file compiles under `tsc --noEmit` with the strict options in
// frontend/tsconfig.json, lints at `--max-warnings=0`, and leaves no tracked file rewritten by
// `next build`.

import { ImageResponse } from 'next/og';

import { resolveSiteName } from '@/lib/seo';

/* -------------------------------------------------------------------------------------------------
 * Palette
 * ---------------------------------------------------------------------------------------------- */

/**
 * The three light-theme token values this card paints with, held by value rather than by reference.
 *
 * Satori resolves no custom property and processes no utility class (see note 1 at the top of the
 * file), so `var(--color-primary)` would render as nothing at all. These literals mirror the PALETTE
 * PARITY table in src/app/globals.css, which publishes them for exactly this purpose and names this
 * module as one of its five consumers. They are the hex column of that table, not the oklch column:
 * Satori's colour support is narrower than a browser's, and the table records the measured sRGB
 * equivalent so that an asset outside the cascade has something faithful to copy.
 *
 * KEEPING THEM IN STEP IS A MANUAL OBLIGATION. Change a value in that table and this object, the
 * three rasters and the vector master all have to follow, or the family diverges. Nothing here
 * derives from the stylesheet at build time, so nothing warns.
 *
 * Only the LIGHT theme appears, because a social card cannot switch with a reader's preference: the
 * PNG is fetched by a scraper, cached, and shown identically to everyone. The card therefore paints
 * its own light canvas and holds its contrast internally - `#4f39f6` on `#f8fafc` measures 6.18:1
 * and `#ffffff` on `#4f39f6` measures 6.46:1, both comfortably past the WCAG AA floor for text.
 *
 * The muted grey that public/og-default.png uses for its lowest bar is deliberately absent. It is
 * `--color-muted-foreground`, a token the parity table does not record, and inventing a literal for
 * it here would be exactly the defect this object avoids - so the secondary line below is set in
 * `primary` and separated from the name by size instead of by hue.
 */
const PALETTE = {
  /** `--color-primary`, light theme, indigo-600. The canvas, the mark's field and all text. */
  primary: '#4f39f6',
  /** `--color-primary-foreground`, light theme, white. The three bars inside the mark. */
  primaryForeground: '#ffffff',
  /** `--color-background`, light theme, slate-50. The inset panel the mark and text sit on. */
  background: '#f8fafc',
} as const;

/* -------------------------------------------------------------------------------------------------
 * The four exports Next.js reads
 * ---------------------------------------------------------------------------------------------- */

/**
 * The site name, resolved once and used by both {@link alt} and the rendered card.
 *
 * Resolved at module scope rather than inside the render, which is the opposite of what @/lib/seo
 * does with the same value and is a considered departure: {@link alt} must be a plain string export
 * for the framework to read, so there is no later moment at which it could be resolved. Sharing one
 * constant between the alternative text and the pixels is what guarantees the two agree.
 *
 * Absence of NEXT_PUBLIC_SITE_NAME therefore fails when this module is evaluated, with the message
 * `resolveSiteName` raises - naming the variable and pointing at .env.example. That is the tier's
 * designed behaviour rather than a regression: the name has no default because a placeholder would
 * be published to readers, and `src/app/layout.tsx` already requires the same variable for the
 * document title template, so no working build reaches this line without it.
 */
const SITE_NAME = resolveSiteName();

/**
 * The card's secondary line.
 *
 * A compression of the opening clause of the default site description in @/lib/seo, kept to one
 * line inside the {@link TEXT_COLUMN_WIDTH}px column so the text block stays vertically centred
 * against the mark. That description is module-private there and interpolates the site name, so it
 * is echoed rather than imported: the name is already this card's dominant element, and repeating it
 * in the same preview is the duplication @/lib/seo's own metadata conventions warn against.
 *
 * It is prose, not configuration - no environment key describes the site in words, and inventing
 * one to hold a decorative line would add a variable to the documented contract for no operational
 * benefit.
 */
const TAGLINE = 'Articles and tutorials';

/**
 * Alternative text for the card, published as `og:image:alt` and `twitter:image:alt`.
 *
 * A screen-reader user meeting this card in a timeline hears this string and nothing else, so it is
 * the card's text content rather than a description of its decoration: for an image whose meaning
 * IS its text, the text is the correct alternative. The mark carries no information the words do not
 * already carry, and "image of" style prefixes are noise a screen reader adds for itself.
 */
export const alt = `${SITE_NAME}: ${TAGLINE}`;

/**
 * The raster's dimensions, spread into the `ImageResponse` options by {@link Image}.
 *
 * 1200x630 is the 1.91:1 frame every major scraper crops to, and it is the size
 * public/og-default.png is authored at, so the static fallback and this generated card are
 * interchangeable. Exported because the framework reads it to emit `og:image:width` and
 * `og:image:height`, which lets a client reserve the space before the bytes arrive.
 */
export const size = { width: 1200, height: 630 };

/** The response's media type. PNG, matching the encoder `ImageResponse` uses. */
export const contentType = 'image/png';

/* -------------------------------------------------------------------------------------------------
 * Geometry
 *
 * Every number below is either a coordinate from public/icon.svg multiplied by MARK_SCALE, or a
 * value measured out of public/og-default.png so that the generated card and the static one are
 * indistinguishable. None of them is a free choice, which is why each carries its derivation.
 * ---------------------------------------------------------------------------------------------- */

/** Side of public/icon.svg's `viewBox`. Every mark coordinate below is a fraction of this. */
const ICON_VIEWBOX = 32;

/** Factor taking the master's 32-unit grid to this card. 32 x 8 = 256px, as measured. */
const MARK_SCALE = 8;

/** The mark's field: `<rect width="32" height="32">` at scale. */
const MARK_SIZE = ICON_VIEWBOX * MARK_SCALE;

/** The field's corner: the master's `rx="7"` at scale. Also the panel's radius - one curve family. */
const CORNER_RADIUS = 7 * MARK_SCALE;

/** Inset of the bars inside the field: the master's `x="6"`/`y="6"` at scale. */
const BAR_INSET = 6 * MARK_SCALE;

/** Bar thickness: the master's `height="4"` at scale. */
const BAR_HEIGHT = 4 * MARK_SCALE;

/** Bar corner: the master's `rx="2"` at scale, which is half the thickness, so the ends are round. */
const BAR_RADIUS = 2 * MARK_SCALE;

/** Vertical gap between bars: the master's rows sit at y=6/14/22, so 4 units of air at scale. */
const BAR_GAP = 4 * MARK_SCALE;

/** The two full-length bars: the master's `width="20"` at scale. */
const BAR_WIDTH_FULL = 20 * MARK_SCALE;

/** The short last bar: the master's `width="12"` at scale - the ragged paragraph edge. */
const BAR_WIDTH_SHORT = 12 * MARK_SCALE;

/**
 * Fraction of each edge left as canvas around the panel.
 *
 * Measured: public/og-default.png's panel is 960x504 on a 1200x630 field, which is 80% of each axis
 * and so a uniform tenth of every edge. Expressed as a ratio rather than as two pixel insets
 * because that is the rule the reference actually follows.
 */
const PANEL_INSET_RATIO = 0.1;

/** Panel width: 1200 - 2 x 120 = 960px. */
const PANEL_WIDTH = size.width - 2 * Math.round(size.width * PANEL_INSET_RATIO);

/** Panel height: 630 - 2 x 63 = 504px. */
const PANEL_HEIGHT = size.height - 2 * Math.round(size.height * PANEL_INSET_RATIO);

/** Air inside the panel's left and right edges, and between the mark and the text. Measured 72px. */
const PANEL_PADDING = 72;

/**
 * Width left for the text once the panel's padding, the mark and the column gap are taken.
 *
 * 960 - 72 - 256 - 72 - 72 = 488px, which is exactly the width of the widest placeholder bar in
 * public/og-default.png. Declared rather than left to `flexGrow` so the wrap point is a stated
 * number: a long configured name wraps at the same place the reference reserved for it.
 */
const TEXT_COLUMN_WIDTH = PANEL_WIDTH - 3 * PANEL_PADDING - MARK_SIZE;

/** Site-name type size. 64px x 1.15 line height reproduces the reference's 74px baseline pitch. */
const NAME_FONT_SIZE = 64;

/** Line height for the site name, as a unitless multiple. */
const NAME_LINE_HEIGHT = 1.15;

/**
 * Most lines the site name may occupy before it is ellipsised.
 *
 * The name is configuration, so its length is not ours to assume, and this is the value that keeps
 * an unreasonable one from wrecking the card. Three lines of 73.6px plus the gap and the secondary
 * line come to 299px inside a 504px panel, which leaves the block comfortably centred; six lines
 * would exceed the panel, and because the panel centres its child the excess would spill equally
 * above and below - the first line landing outside the panel, on the canvas. Measured, not assumed:
 * a 76-character name did exactly that before this cap existed.
 *
 * Truncation costs nothing in meaning, because {@link alt} carries the full untruncated name to
 * assistive technology regardless of what the raster shows.
 */
const NAME_MAX_LINES = 3;

/** Slight negative tracking, which is what gives the name its weight with a single 400 face. */
const NAME_LETTER_SPACING = -1.5;

/** Secondary-line type size. Measured 32px in the reference - large text for contrast purposes. */
const TAGLINE_FONT_SIZE = 32;

/** Air between the name block and the secondary line. Measured 40px. */
const TAGLINE_MARGIN_TOP = 40;

/* -------------------------------------------------------------------------------------------------
 * Render
 * ---------------------------------------------------------------------------------------------- */

/**
 * Render the default social card.
 *
 * Async because the framework awaits the handler and because `ImageResponse` streams its body; the
 * function itself awaits nothing, since there is nothing to wait for.
 *
 * Every element that holds more than one child declares `display: 'flex'` explicitly. That is not
 * defensive style: Satori has no CSS defaults to fall back on, and an undeclared container lays its
 * children out silently wrongly rather than failing - the single most common authoring mistake with
 * this API. The tree is four levels deep and holds six elements, which keeps it inside the subset
 * Satori implements well.
 */
export default async function Image(): Promise<ImageResponse> {
  return new ImageResponse(
    <div
      style={{
        // The full-bleed canvas. Width and height are percentages of the frame the options below
        // establish, so the card cannot disagree with the exported `size`.
        display: 'flex',
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: PALETTE.primary,
      }}
    >
      <div
        style={{
          // The inset panel: a tenth of every edge left as canvas, which is what frames the card
          // and what makes the mark's indigo field read as part of a family rather than as a
          // shape floating on nothing.
          //
          // `overflow: 'hidden'` is the outermost of the three guards against a runaway site name,
          // and the only unconditional one: this is the last fixed-size box in the tree, so
          // clipping here means nothing can reach the canvas whatever the configuration says. It
          // clips to the rounded rect rather than to a bounding box, so a clipped glyph cannot
          // appear outside the corner curve.
          display: 'flex',
          overflow: 'hidden',
          width: PANEL_WIDTH,
          height: PANEL_HEIGHT,
          alignItems: 'center',
          paddingLeft: PANEL_PADDING,
          paddingRight: PANEL_PADDING,
          borderRadius: CORNER_RADIUS,
          backgroundColor: PALETTE.background,
        }}
      >
        <div
          style={{
            // The mark: public/icon.svg's field, drawn as a box rather than as SVG. Padding and
            // gap add to exactly MARK_SIZE (48 + 32 + 32 + 32 + 32 + 32 + 48 = 256), so the bars
            // land on the master's rows without the column having to centre anything.
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
            justifyContent: 'center',
            gap: BAR_GAP,
            width: MARK_SIZE,
            height: MARK_SIZE,
            paddingLeft: BAR_INSET,
            borderRadius: CORNER_RADIUS,
            backgroundColor: PALETTE.primary,
          }}
        >
          <div
            style={{
              width: BAR_WIDTH_FULL,
              height: BAR_HEIGHT,
              flexShrink: 0,
              borderRadius: BAR_RADIUS,
              backgroundColor: PALETTE.primaryForeground,
            }}
          />
          <div
            style={{
              width: BAR_WIDTH_FULL,
              height: BAR_HEIGHT,
              flexShrink: 0,
              borderRadius: BAR_RADIUS,
              backgroundColor: PALETTE.primaryForeground,
            }}
          />
          <div
            style={{
              // Short, so the mark reads as a paragraph of written text.
              width: BAR_WIDTH_SHORT,
              height: BAR_HEIGHT,
              flexShrink: 0,
              borderRadius: BAR_RADIUS,
              backgroundColor: PALETTE.primaryForeground,
            }}
          />
        </div>

        <div
          style={{
            // The text column, at the width the reference reserved for it, and the second of the
            // three guards. Its height is pinned to the panel's so that the block it centres can
            // never be taller than the box centring it, and `overflow: 'hidden'` clips a single
            // unbreakable token - a name written as one long word has no space to wrap at, so
            // wrapping cannot save it and only clipping can.
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            width: TEXT_COLUMN_WIDTH,
            height: PANEL_HEIGHT,
            marginLeft: PANEL_PADDING,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              // The dominant element, and the first of the three guards: `lineClamp` bounds how far
              // a long name may grow before it is ellipsised, which keeps the block shorter than the
              // panel in the first place rather than leaving the clip to hide a mistake. A name of
              // ordinary length is untouched and renders on one or two lines, exactly as the
              // reference reserves room for.
              //
              // `display: 'block'` IS WHAT MAKES THE CLAMP WORK, and it is the reason this one
              // element is not the flex box everything else here is. Satori honours `lineClamp` only
              // for block-displayed text - its own condition is `display === 'block' && lineClamp` -
              // and silently ignores it otherwise, appending the U+2026 ellipsis itself once the
              // limit is hit. Verified the hard way: with `display: 'flex'` a 76-character name
              // still laid out seven lines. Block display is safe because this element has exactly
              // one child, a text run, so it needs no flex context of its own.
              //
              // `wordBreak: 'break-word'` is the third guard, and it is what makes the other two
              // reach the case they cannot otherwise see. Wrapping needs somewhere to break, and a
              // name written as one long token offers nowhere, so it stays a single line that the
              // column's clip cuts through - measured: a 38-character token rendered one line
              // sliced mid-glyph at the column's edge, which reads as a rendering fault rather than
              // as truncation. Breaking inside the word turns that into three wrapped lines the
              // clamp can end with an ellipsis, and every line lands inside the column: the same
              // token now stops 25px clear of the padding instead of at it. Satori spells this
              // `wordBreak`; it does not implement `overflowWrap`.
              display: 'block',
              fontSize: NAME_FONT_SIZE,
              lineHeight: NAME_LINE_HEIGHT,
              letterSpacing: NAME_LETTER_SPACING,
              lineClamp: NAME_MAX_LINES,
              wordBreak: 'break-word',
              color: PALETTE.primary,
            }}
          >
            {SITE_NAME}
          </div>
          <div
            style={{
              // The secondary line: same colour as the name, distinguished by size alone, for the
              // reason given on {@link PALETTE}. Block-displayed to match the name, and
              // `flexShrink: 0` keeps it at its natural height so a clamped multi-line name cannot
              // squeeze it away - the shrink applies because its PARENT is the flex box, whatever
              // this element's own display says.
              display: 'block',
              flexShrink: 0,
              fontSize: TAGLINE_FONT_SIZE,
              marginTop: TAGLINE_MARGIN_TOP,
              color: PALETTE.primary,
            }}
          >
            {TAGLINE}
          </div>
        </div>
      </div>
    </div>,
    { ...size },
  );
}
