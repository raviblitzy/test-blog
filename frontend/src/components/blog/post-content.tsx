// Post content - the ONE renderer for author-written Markdown.
//
// Two surfaces render article bodies in this product and they must agree
// character for character, because a preview that disagrees with the published
// page is worse than no preview at all:
//
//   * src/app/blog/[slug]/page.tsx - the published article, a Server Component.
//   * src/components/blog/post-editor.tsx - the authoring live preview, a
//     `'use client'` island.
//
// Both import THIS module, so the Markdown pipeline, the sanitiser, the heading
// levels and the token styling are declared once and cannot drift between
// reading and writing.
//
// ---------------------------------------------------------------------------
// 1. THE ABSENCE OF `'use client'` IS THE ARCHITECTURE, NOT AN OVERSIGHT
//
// Do not add the directive. A module with no directive is a SHARED module:
// Next.js renders it on the server for the post page and bundles it into the
// client for the editor island. Adding `'use client'` would pull the article
// body behind hydration and out of the initial HTML response - and
// server-rendered article text is the single most consequential SEO decision in
// this project's plan, asserted as a validation criterion in its own right
// (the post page's initial HTML must contain the article text with client
// scripting disabled). One directive would break that gate.
//
// The corollary is a hard constraint on everything below: NO hook, NO state, NO
// effect, NO ref, NO event handler and NO browser API in this file. Nothing here
// needs one, and anything that did would belong in a client island that wraps
// this component rather than inside it. The constraint extends to what this file
// IMPORTS: `@/components/ui/badge` carries no directive of its own for exactly
// this reason, and the `next/link` its `BadgeLink` renders is the one hook-bearing
// element in the tree - Link's own, which is fine, because a Server Component may
// render a Client Component and Next.js server-renders it into the same initial
// HTML.
//
// ---------------------------------------------------------------------------
// 2. SANITISATION HAPPENS TWICE, ON PURPOSE
//
// Author-written content is a stored-injection surface, so it is cleaned on the
// way in AND on the way out:
//
//   write   backend/app/services/post_service.py, with bleach
//   render  HERE, with rehype-sanitize
//
// Both are required and neither substitutes for the other. The server pass
// protects every consumer of the API including ones this repository does not
// own; the render pass protects THIS tier from anything already in the database,
// from a record written before the server pass existed, and from a future
// service change. Do not remove or weaken the rehype pass on the grounds that
// the server already sanitised - that argument is exactly the one that turns
// defence in depth into a single point of failure.
//
// Three things make the render side safe, and all three must stay:
//
//   a. `rehype-raw` is NOT used and must never be. react-markdown v10 does not
//      render raw HTML embedded in Markdown by default, so `<script>`,
//      `<iframe>` and an `onerror` attribute never reach the tree at all.
//   b. `rehypeSanitize` runs with the GitHub-derived default schema, which
//      strips `script`, drops every tag outside its 53-name allow-list, drops
//      every attribute outside its allow-list (so no `on*` handler survives) and
//      restricts `href` to http/https/irc/ircs/mailto/xmpp and `src` to
//      http/https - which is what makes a `javascript:` link arrive as an anchor
//      with no href.
//
// What sanitisation does NOT do is decide whether a request should be made at
// all. A surviving `https:` image URL is safe to EMIT and is still a request the
// reader's browser makes, unasked, to a host the post's author chose - which
// hands that host the reader's IP address, user agent and referring URL whether
// or not anything is rendered from it. That is a privacy decision rather than an
// injection one, so it is taken separately. See note 5.
//   c. `dangerouslySetInnerHTML` appears nowhere in this file.
//
// The default schema needs NO widening. It already permits `className` on `code`
// when it matches `/^language-./`, which is exactly what a fenced code block
// emits, and `task-list-item` on `li`, which is what remark-gfm emits for a task
// list. Widening it would be the only way to make this file less safe, so it is
// not done.
//
// ---------------------------------------------------------------------------
// 3. NO SYNTAX HIGHLIGHTER
//
// None is declared in frontend/package.json, and the pinned-dependency standard
// makes adding one a dependency decision rather than a component decision. A
// fenced block therefore renders as `<pre><code class="language-x">`, styled by
// the typography plugin, with the language class preserved so a highlighter can
// be introduced later without touching this file.
//
// ---------------------------------------------------------------------------
// 4. WHERE THE STYLING COMES FROM
//
// Body typography is the `prose` classes generated by @tailwindcss/typography,
// which src/app/globals.css registers with `@plugin`. That file records a
// contract this module has to honour and which is invisible from here: the
// plugin declares its own `--tw-prose-*` palette INSIDE the `.prose` rule, so it
// is not token-bound and cannot be re-pointed from `:root`. The only correct
// answer is to pair `prose` with `dark:prose-invert`, and without it article
// text stays dark grey on the dark canvas. That pairing is therefore mandatory,
// not decorative.
//
// Everything this file adds on top resolves to a semantic token from that same
// file - `text-primary`, `text-accent` and `outline-ring` - and the category
// pill's entire appearance and interaction comes from the design system's
// `BadgeLink` rather than from a class list assembled here. There is no literal
// colour, no pixel dimension, no radius value and no `style` prop anywhere below,
// and no stylesheet or CSS module is introduced: globals.css is this tier's only
// stylesheet.
//
// ---------------------------------------------------------------------------
// 5. AN INLINE IMAGE IS FETCHED ONLY FROM AN ADMITTED HOST
//
// `@/lib/utils` owns this deployment's remote-image host policy: one list, read
// by `next.config.ts` for the optimiser and by `isAllowedImageUrl` for every
// component that renders a stored URL. The `img` override below asks that
// predicate BEFORE it emits an element, because an `<img src>` that reaches the
// DOM has already made its request - there is no later moment at which the
// decision can be taken.
//
// A body image is exactly the case the policy exists for. Its host is chosen by
// whoever wrote the post, so an unadmitted URL may be an ordinary photograph on
// an unlisted CDN or a one-pixel beacon whose only purpose is to collect the
// data note 2 describes, and nothing about the URL distinguishes the two. So an
// unadmitted image is not rendered: its `alt` text is rendered in its place,
// which is what alt text IS - the image's textual equivalent - and a decorative
// image with no alt text leaves nothing behind at all.
//
// Admitting a host is a reviewed CODE change and deliberately not a deployment
// setting: one entry in `IMAGE_HOST_ALLOWLIST` in `@/lib/utils`, which is where
// `next.config.ts` also derives `images.remotePatterns` from, so the optimiser and
// every render site read one list. It is source code rather than an environment
// variable for two reasons - `next.config.ts` is evaluated once at build time, so
// an environment-supplied list would read as run-time configuration while behaving
// as a build-time constant; and this list decides which third parties a reader's
// browser is asked to contact, which warrants review rather than a redeploy. There
// is no per-component list here, and adding one would be the second source of truth
// that policy exists to prevent.

import type { JSX } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

import { BadgeLink } from '@/components/ui/badge';
import { Table } from '@/components/ui/table';
import { categoryFeedPath } from '@/lib/seo';
import type { CategorySummary } from '@/lib/types';
import { cn, isAllowedImageUrl } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Pipeline
 *
 * Both lists are module-level constants rather than inline array literals so that the pipeline is
 * declared in one obvious place and cannot be assembled differently by a future call site. Their
 * types are derived from react-markdown's own `Options` rather than imported from `unified`:
 * `unified` is a transitive dependency and is not pinned in frontend/package.json, so naming it
 * directly would reach outside the declared dependency set for a type that is already re-exported
 * through one that is inside it.
 * ---------------------------------------------------------------------------------------------- */

/**
 * GitHub Flavoured Markdown, and nothing else.
 *
 * This is what turns tables, task lists, strikethrough, footnotes and bare URLs into real elements
 * instead of literal text. It is the only remark plugin: anything that changes what an author's
 * Markdown MEANS is a product decision, not a rendering detail.
 */
const REMARK_PLUGINS: NonNullable<Options['remarkPlugins']> = [remarkGfm];

/**
 * The client-boundary sanitiser, running with its unmodified default schema.
 *
 * Deliberately the whole rehype list. `rehype-raw` is absent by design - see note 2 in the header -
 * and adding any plugin that runs AFTER this one could reintroduce markup the sanitiser has just
 * removed, so a future addition belongs BEFORE `rehypeSanitize` in this array or not at all.
 */
const REHYPE_PLUGINS: NonNullable<Options['rehypePlugins']> = [rehypeSanitize];

/* -------------------------------------------------------------------------------------------------
 * Class sets
 *
 * Hoisted to module scope and composed through `cn` so each group can carry its own note, following
 * the convention src/components/admin/stat-card.tsx established. Composing at module scope also
 * means `cn` runs once per process rather than once per render.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The component's own frame: a single column, the reading measure, and overflow safety.
 *
 * `flex flex-col gap-6` separates the article from the category row with a `--spacing` multiple
 * rather than a margin on either sibling, so neither child has to know what sits next to it.
 *
 * `md:max-w-2xl` is the reading measure, and `--container-2xl` (42rem) is where it comes from - a
 * token from the engine's own container scale, not a hand-picked width. The responsive shape the
 * plan asks for on post detail is "single column with full-width media below 48rem, constrained
 * measure at 48rem and above", and this expresses exactly that in ONE class: below `md` there is no
 * constraint at all, so an image spans the full column; from `md` upward - inclusive, so the
 * treatment is live AT 768px and not merely beyond it - the measure binds. There is deliberately no
 * base `max-w-none`: a block element with no `max-width` is already full width, and a redundant
 * utility would only give a caller's `className` something extra to have to override.
 *
 * There is no `lg:` step either, and that is the plan's shape rather than an omission: at 64rem the
 * measure stays constrained and what changes is the MARGIN around it for metadata, which belongs to
 * the route's layout and not to the article.
 *
 * `mx-auto` is what distributes the leftover space, and it earns its place by measurement rather than
 * by convention: rendered at 1440px WITHOUT it, the article sat hard against the leading edge with
 * 736px of empty gutter trailing it, which reads as a broken layout rather than as a deliberate
 * measure. It is a no-op whenever the surrounding container is already at or below 42rem, so it
 * cannot disturb a page that owns the measure itself, and a layout that genuinely wants the column
 * offset - for a metadata rail at 64rem, say - overrides it with `mx-0` through `className`. It
 * compiles to the logical `margin-inline`, not to a physical pair.
 *
 * `break-words` is `overflow-wrap: break-word`, and it is on the ROOT precisely because that
 * property inherits: one class then protects headings, table cells, inline code and a long
 * autolinked URL alike, at every viewport, with no per-element override. It is inert inside `pre`,
 * where `white-space: pre` means lines break only at newlines - which is why the code block gets a
 * scroll container instead, below. globals.css already applies the same property to `p`, `li`,
 * `dd`, `blockquote` and `figcaption` document-wide; restating it here covers the elements that
 * list does not name and keeps this component correct on its own.
 */
const ROOT_CLASSES = 'mx-auto flex flex-col gap-6 break-words md:max-w-2xl';

/**
 * The typography scope.
 *
 * `prose` supplies the whole body treatment - measure, rhythm, heading sizes, list markers, table
 * rules, blockquote and code-block styling - and `dark:prose-invert` is MANDATORY rather than
 * optional, for the reason globals.css records and note 4 in the header repeats.
 *
 * `max-w-none` retires the plugin's own `65ch` measure so that exactly one element owns the
 * measure: {@link ROOT_CLASSES}. Two competing constraints would silently resolve to whichever
 * happened to be narrower, which is the kind of layout that is impossible to reason about from
 * either call site.
 *
 * ### `empty:hidden` closes the one gap the blank-content guard cannot see
 *
 * {@link PostContent} decides whether to render this block from the raw string, which is the only
 * thing it can do without a hook: nothing here may render, measure and then re-render. Almost always
 * the two agree - non-blank text produces elements. There is one case where they do not, and it was
 * found by rendering rather than by reading: content consisting ENTIRELY of raw HTML. CommonMark
 * takes `<script>…</script>` and everything on its line as one raw-HTML block, react-markdown does
 * not render raw HTML, and the sanitiser drops it - so a non-blank string legitimately produces zero
 * elements and this container renders with no children at all. Measured, it was a `0`-height box that
 * still took a `gap-6` share from the flex column, i.e. exactly the stray 24px this component
 * promises never to contribute.
 *
 * `empty:hidden` is the engine's `:empty` variant and answers it exactly: an element with no child
 * nodes whatsoever is taken out of the flex flow, so it claims no gap. It cannot misfire, because any
 * rendered output is a child node. One built-in variant, no measurement, no hook, no state.
 *
 * ### The `h5`/`h6` group is a plugin gap this component has to close
 *
 * The typography plugin styles `h1` through `h4` and stops. Read out of the compiled stylesheet:
 * four `:where(hN)` rules exist and there are ZERO for `h5` and `h6`. Combined with the engine's
 * preflight - which resets every heading to `font-size: inherit; font-weight: inherit; margin: 0` -
 * an `h5` or `h6` inside the prose scope would otherwise render as an unstyled paragraph with no
 * space above or below it, indistinguishable from the text around it.
 *
 * That gap matters more here than it would elsewhere, because the heading downshift moves the
 * boundary: an authored `####` - an ordinary depth in a long technical post - becomes an `h5` and
 * lands in it. So the two levels are given the plugin's OWN terminal treatment rather than a new
 * one: its `h4` rule is `font-weight: 600; line-height: 1.5; margin-top: 1.5em; margin-bottom:
 * .5em`, and `font-semibold`, `leading-normal`, `mt-6` and `mb-2` are the token spellings of exactly
 * those four values at the 16px base. Continuing the plugin's last step is deliberately not the same
 * as inventing a step.
 *
 * `:is(h5, h6)` addresses both in one variant instead of duplicating five utilities per level.
 *
 * Colour is `text-foreground` - the project's semantic token - rather than the plugin's internal
 * `--tw-prose-headings`, because globals.css is explicit that the plugin palette is not token-bound
 * and is not ours to reach into. The two are near-identical in both themes by measurement
 * (`#101828` against `#0f172b` in light, `#ffffff` against `#f8fafc` in dark), so consistency with
 * the styled levels is preserved without borrowing a variable that belongs to the plugin.
 *
 * ### BLITZY [A11Y]: the blockquote rule is the plugin's, and it is left as the plugin draws it
 *
 * Measured in the rendered document: the plugin's `--tw-prose-quote-borders` paints the blockquote's
 * leading rule at `#364153`, which is 1.96:1 against the dark canvas - below the 3:1 in WCAG 1.4.11.
 * It is implemented as the plugin draws it and flagged here for review rather than silently
 * corrected, for three reasons. The rule is decorative: 1.4.11 governs the visual information
 * required to identify a user interface component, and a quotation is not a control - the same
 * reasoning globals.css records for its own `--color-border` hairline at 1.23:1. The quotation is
 * signalled redundantly anyway, by italics, typographic quote marks and indentation, so no meaning
 * rests on the rule alone. And re-pointing it is not this file's to do: globals.css states that the
 * plugin's palette is declared inside its own `.prose` rule, that binding those variables at `:root`
 * achieves nothing, and that adding a `.prose` rule there would be the component style that file
 * forbids. The body text this rule sits beside measures 13.69:1, so nothing legible is affected.
 */
const PROSE_CLASSES = cn(
  'prose dark:prose-invert max-w-none empty:hidden',
  '[&_:is(h5,h6)]:text-foreground [&_:is(h5,h6)]:mt-6 [&_:is(h5,h6)]:mb-2',
  '[&_:is(h5,h6)]:leading-normal [&_:is(h5,h6)]:font-semibold',
);

/**
 * An anchor inside the article body.
 *
 * `text-primary` beats the plugin's own link colour without a `!important` and without an
 * `@layer` fight: the plugin's selectors sit in the `components` layer and a utility sits in
 * `utilities`, which the engine emits afterwards, so equal specificity resolves in the utility's
 * favour. The underline is kept - and is not the only signal, since the colour changes too - so the
 * affordance is never carried by colour alone.
 *
 * `rounded-sm` keeps the focus outline hugging the text instead of tracing a rectangle around a
 * link that wraps across two lines. The `focus-visible:` triple restates the document-wide floor
 * globals.css sets at the same 2px width and offset: nothing changes visually today, and the link
 * stays correct if that floor is ever narrowed. `:focus-visible` rather than `:focus`, so the ring
 * appears for keyboard and assistive-technology users and not on a mouse click.
 *
 * `hover:` is the engine's own variant, which compiles behind `@media (hover: hover)`, so a tap on
 * a touch device cannot leave the state stuck on. The colour transition is gated on `motion-safe:`
 * - the engine's `prefers-reduced-motion: no-preference` variant - and inherits the engine's
 * 150ms default duration, inside the 150-300ms band this project holds hover transitions to.
 */
const CONTENT_LINK_CLASSES = cn(
  'text-primary rounded-sm underline underline-offset-2',
  'hover:text-accent',
  'focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',
  'motion-safe:transition-colors motion-safe:ease-out',
);

/**
 * An image inside the article body.
 *
 * `max-w-full` is what keeps a 4000px-wide photograph from forcing the page to scroll sideways at
 * 375px, and `h-auto` preserves its aspect ratio while it does. `rounded-md` is `--radius-md`.
 *
 * No `width`/`height` attributes are set, and that is a considered exception to the usual
 * layout-shift advice rather than an oversight. Markdown's image syntax carries no dimensions - only
 * a URL and alt text - so there is nothing truthful to declare, and inventing a pair would both
 * introduce the pixel literal the token discipline forbids and distort every image whose real aspect
 * ratio differs from the guess. `max-w-full` with `h-auto` is the treatment the plan specifies for
 * exactly this case, and it is also what keeps an arbitrary author-supplied asset inside the column.
 */
const CONTENT_IMAGE_CLASSES = 'h-auto max-w-full rounded-md';

/**
 * The text an image from an unadmitted host degrades to - see note 5 in the header.
 *
 * `italic` and `text-muted-foreground` are what stop the substituted alt text reading as though the
 * author had written it as prose: it is set apart the way a caption is, which is the closest thing
 * the type scale has to "this stands in for something". Both resolve past the typography plugin for
 * the reason {@link CONTENT_LINK_CLASSES} records - the plugin's selectors sit in the `components`
 * layer and a utility sits in `utilities`, which the engine emits afterwards.
 *
 * No border, no box and no reserved space: an image that is not rendered leaves a line of text
 * rather than a frame with a hole in it, which is the same degradation `post-card.tsx` applies when
 * the policy refuses a cover image.
 */
const WITHHELD_IMAGE_CLASSES = 'text-muted-foreground italic';

/**
 * A fenced code block.
 *
 * The typography plugin already sets `overflow-x: auto` on `pre`; this restates it so that the
 * no-horizontal-overflow guarantee at 375px belongs to this component rather than to a plugin
 * default that a future version could change. `max-w-full` stops a long unbroken line widening the
 * element itself instead of scrolling inside it.
 */
const PRE_CLASSES = 'max-w-full overflow-x-auto';

/**
 * The pill row itself. The engine's preflight already removes list markers, margin and padding from
 * `ul`, and this row sits OUTSIDE {@link PROSE_CLASSES} so the plugin's list styling never reaches
 * it either - which is why no `list-none` is needed here. `flex-wrap` is what keeps a post with
 * eight categories from overflowing at 375px.
 */
const CATEGORY_LIST_CLASSES = 'flex flex-wrap items-center gap-2';

/* -------------------------------------------------------------------------------------------------
 * Link classification
 * ---------------------------------------------------------------------------------------------- */

/**
 * Matches an href that leaves this origin: either it carries a scheme (`https:`, `mailto:`) or it is
 * protocol-relative (`//host/path`).
 *
 * The protocol-relative branch is not theoretical. The sanitiser's protocol allow-list is applied
 * only to values that HAVE a scheme, so `//host/path` passes it untouched and then resolves against
 * whatever scheme the page was served over - an external request in every practical sense. Matching
 * it here is what stops such a link being treated as internal.
 *
 * Declared locally rather than imported. `@/lib/seo` owns canonical URL construction and holds a
 * similar pattern for that purpose, but does not export it, and the decision being made here is a
 * presentational one - which `rel` this anchor gets - not a canonicalisation one.
 */
const EXTERNAL_HREF_PATTERN = /^(?:[a-z][a-z\d+\-.]*:|\/\/)/i;

/**
 * Whether an authored link points off this site, and therefore needs a hardened `rel`.
 *
 * Total over its input: an absent href - which is exactly what a `javascript:` link becomes once the
 * sanitiser has dropped it - answers `false` and needs no `rel`, because there is nothing left to
 * navigate to.
 *
 * @param href - The href as it survived sanitisation, or `undefined` when it did not survive.
 * @returns `true` for an absolute or protocol-relative href, `false` for a relative one or none.
 */
function isExternalHref(href: string | undefined): boolean {
  return href !== undefined && EXTERNAL_HREF_PATTERN.test(href);
}

/**
 * Whether an authored link still has somewhere to go once the sanitiser has finished with it.
 *
 * Two ways an anchor arrives here with no destination, and both are ordinary rather than exotic:
 *
 *   * The sanitiser DROPPED the href. Its protocol allow-list rejects `javascript:`, `data:` and
 *     every other scheme outside http/https/irc/ircs/mailto/xmpp - and it drops the offending
 *     ATTRIBUTE while keeping the element, so `[click me](javascript:alert(1))` reaches this override
 *     as an `<a>` with `href === undefined`.
 *   * The author wrote no target at all. `[text]()` is valid Markdown and yields `href === ''`,
 *     which the sanitiser has no reason to touch: an empty value carries no scheme, so it is treated
 *     as relative and passes through untouched.
 *
 * Both answer `false`, and both must, for the same reason: an element with no destination is not a
 * link, and an `<a href="">` is worse than one - it is focusable, it looks clickable, and activating
 * it reloads the current page. Rendering either as a styled anchor would advertise a navigation that
 * cannot happen, which is precisely the affordance a sanitiser removing a `javascript:` URL was
 * trying to take away.
 *
 * Whitespace counts as empty. `[text](   )` is the same non-destination as `[text]()` with extra
 * characters in it.
 *
 * @param href - The href as it survived sanitisation, or `undefined` when it did not survive.
 * @returns `true` when the value can actually be navigated to, `false` for absent, empty or blank.
 */
function hasNavigableHref(href: string | undefined): href is string {
  return typeof href === 'string' && href.trim().length > 0;
}

/* -------------------------------------------------------------------------------------------------
 * Prop plumbing
 * ---------------------------------------------------------------------------------------------- */

/**
 * A props object with react-markdown's hast `node` removed, ready to spread onto a DOM element.
 *
 * ### Why this exists rather than a destructured discard
 *
 * react-markdown hands every FUNCTION override the hast node it is rendering, as a `node` prop
 * alongside the element's real attributes. It is not a DOM attribute, and spreading it onto an
 * element emits a literal `node="[object Object]"` into the HTML - measured, not theorised.
 *
 * The obvious removal - `({ node: _node, ...rest }) =>` - is not available here: this project's lint
 * gate runs `@typescript-eslint/no-unused-vars` with its default options, where `ignoreRestSiblings`
 * is off, so the discarded binding is reported as an unused variable and `--max-warnings=0` turns
 * that into a failed build. Suppressing the rule for it would spend a lint exemption on plumbing;
 * removing the key from a shallow copy costs nothing and needs no exemption.
 *
 * The return type stays `P` deliberately. `Omit<P, 'node'>` would be more precise and would buy
 * nothing: a JSX spread does not excess-property-check, so the extra key in the type is invisible at
 * every call site, and the imprecision is confined to this one function.
 *
 * @typeParam P - The override's own props type, as react-markdown supplies it.
 * @param props - The props exactly as received, left unmutated.
 * @returns A shallow copy carrying every real attribute and no `node`.
 */
function withoutHastNode<P extends { node?: unknown }>(props: P): P {
  const attributes = { ...props };
  delete attributes.node;
  return attributes;
}

/* -------------------------------------------------------------------------------------------------
 * Element overrides
 * ---------------------------------------------------------------------------------------------- */

/**
 * The tag-name and component map react-markdown renders the sanitised tree through.
 *
 * Only five element kinds are overridden, and each override exists to satisfy a stated requirement
 * rather than to restyle something the `prose` scope already handles.
 *
 * ### Headings: a one-level downshift, expressed as tag names
 *
 * Authored Markdown legitimately begins `# Title`, which react-markdown would render as an `<h1>` -
 * and the post page already renders the post title as the page's single `<h1>`. Two `<h1>` elements
 * on one document breaks the accessibility floor, which requires ordered heading levels within
 * content and no `h1` from a component.
 *
 * So every authored heading drops exactly one level and `h6` clamps onto itself. A uniform +1 shift
 * preserves the author's own structure exactly, which is what keeps levels ORDERED rather than
 * merely `h1`-free: `# A` then `## B` becomes `h2` then `h3`, never `h2` then `h4`. The `h6: 'h6'`
 * entry is the clamp, written out rather than omitted so the ceiling is visible at a glance instead
 * of being implied by the absence of a line.
 *
 * These six are plain STRINGS, which react-markdown's `Components` type admits alongside components
 * (`ComponentType<...> | keyof JSX.IntrinsicElements`), and that spelling is chosen for a concrete
 * reason beyond brevity: react-markdown passes the hast `node` to every override it renders as a
 * FUNCTION, and a function that forgets to strip it emits a literal `node="[object Object]"`
 * attribute into the DOM. A tag name cannot make that mistake. Every function override below spreads
 * {@link withoutHastNode} rather than its raw props for exactly that reason.
 *
 * ### Everything else
 *
 * `a`, `img`, `pre` and `table` each carry a note of their own at the call site.
 *
 * Declared once at module scope, so the map is not rebuilt per render and the pipeline a reader has
 * to understand is in one place.
 */
const MARKDOWN_COMPONENTS: Components = {
  h1: 'h2',
  h2: 'h3',
  h3: 'h4',
  h4: 'h5',
  h5: 'h6',
  h6: 'h6',

  /*
   * An authored link.
   *
   * `children` is passed through untouched - the author's link text is the accessible name, and
   * replacing or supplementing it would both mislead a reader and risk producing an anchor with no
   * content at all. It is destructured and placed explicitly rather than left to ride in on the
   * spread so that the markup states plainly that this anchor has content.
   *
   * `rel="noopener noreferrer"` is applied to external links only. `noreferrer` is the load-bearing
   * half here: it stops the reader's current URL being handed to a host the post's author chose.
   *
   * `target="_blank"` is deliberately NOT set. Nothing in the design calls for a new tab, and
   * opening one silently is a change of context a visitor cannot predict - it would oblige the
   * accessible name to announce it, which would mean rewriting the author's link text. Links stay
   * in-tab.
   *
   * `next/link` is deliberately not used here either. The sanitiser hands this override a plain
   * string href which may be external, a `mailto:`, or nothing at all, and routing those through a
   * client-side navigator would be fragile for no benefit. Internal links in authored prose are
   * ordinary anchors and are followed with a full navigation. The category pills further down are a
   * different case and DO navigate through the router, because their hrefs are ones this component
   * builds itself - which is why they are `BadgeLink`s rather than anchors.
   *
   * The sanitiser's schema permits one `className` on an anchor - `data-footnote-backref`, on the
   * return arrow of a GFM footnote - so the authored value is merged rather than discarded.
   *
   * ### An anchor with no destination is not rendered as an anchor
   *
   * When {@link hasNavigableHref} says no - the sanitiser dropped a `javascript:` href, or the author
   * wrote `[text]()` - the author's text is emitted inside a plain `<span>` and the anchor is not
   * built at all. The alternative, which this file did do and which the styling made worse, is an
   * `<a>` with the link colour, the hover step and the focus ring but nothing to navigate to: a
   * visitor reads it as a link, a keyboard user lands on it, a screen reader announces it as a link,
   * and activating it either does nothing or reloads the page. Removing an unsafe scheme and then
   * still advertising the click is the sanitiser's work undone at the last step.
   *
   * The span deliberately carries NO `CONTENT_LINK_CLASSES`: the text should read as the surrounding
   * prose, because that is what it now is. It is also NOT spread with the anchor's props - there is no
   * attribute on a dropped link worth keeping, and spreading would put `href`, `title` and the hast
   * `node` on an element that has no use for any of them. The authored `className` is the one
   * exception, forwarded so the GFM footnote hook survives the degradation.
   */
  a: (props) => {
    const { children, className: authoredClassName, href } = props;

    if (!hasNavigableHref(href)) {
      return <span className={authoredClassName}>{children}</span>;
    }

    return (
      <a
        {...withoutHastNode(props)}
        className={cn(CONTENT_LINK_CLASSES, authoredClassName)}
        rel={isExternalHref(href) ? 'noopener noreferrer' : undefined}
      >
        {children}
      </a>
    );
  },

  /*
   * An inline content image, rendered only when this deployment admits its host.
   *
   * THE GUARD IS THE POINT AND IT HAS TO COME FIRST. `isAllowedImageUrl` is `@/lib/utils`'s
   * single remote-image host policy - the same list next.config.ts derives `images.remotePatterns`
   * from - and it is asked before any element is produced, because an `<img src>` that reaches the
   * DOM has already made its request. The sanitiser is no help here: it restricts the `src`
   * PROTOCOL, which makes a URL safe to emit and says nothing about whether a request to the host
   * behind it should be made at all. See note 5 in the header for what that request discloses.
   *
   * The predicate is total - a missing `src`, a relative path, an unparseable string, plain `http`,
   * an embedded credential and an unlisted host all answer "no" without throwing - so there is no
   * `try`/`catch` and no null check of our own here.
   *
   * When the answer is no the image degrades to its own alt text, and when there is no alt text it
   * degrades to nothing: `![](url)` is an author stating that the image carries no information the
   * surrounding prose does not, so there is nothing to substitute and a stand-in would be noise.
   * The authored `className` is deliberately NOT carried onto the substitute - a class written for
   * an image is not a class for a line of text - and it is still merged on the branch that renders
   * a real image.
   *
   * When the answer is yes, a plain `<img>` is emitted rather than `next/image`, and that remains a
   * constraint rather than a preference: Markdown's image syntax carries only a URL and alt text, so
   * there is no width and height to declare, and `next/image` requires either both or `fill` inside
   * a positioned ancestor whose aspect ratio has been reserved. Neither is available for an image
   * that appears mid-paragraph, and inventing a pair would introduce the pixel literals the token
   * discipline forbids while distorting every image whose real ratio differs from the guess.
   *
   * `alt` still falls back to the empty string on that branch, which is the CORRECT decorative
   * treatment rather than a shrug - an empty `alt` is how "this image carries no information" is
   * communicated to assistive technology, and inventing text would be worse than saying nothing.
   *
   * `loading="lazy"` and `decoding="async"` keep a long article's images off the critical path.
   * `loading="lazy"` has a second, less obvious effect worth knowing: React stops emitting a
   * `<link rel="preload" as="image">` for the element during server rendering, so a lazy image does
   * not get preloaded and lazy-loaded at the same time.
   *
   * `referrerPolicy="no-referrer"` is the one privacy control this element needs, and it is the exact
   * counterpart of the `rel="noreferrer"` the anchor override applies. The host is chosen by whoever
   * wrote the post, so every content image is an automatic, unattended request to a third party the
   * READER never chose - and without this attribute the browser sends the full URL of the page being
   * read as the `Referer` header. On this product that URL is the post's canonical address, so an
   * image host learns which article each visitor is reading, from the visitor's own IP, with no
   * interaction at all. `no-referrer` rather than `origin` or `strict-origin` because the site's
   * origin is public information the image host already has from the request itself, so sending it
   * again buys the reader nothing; and because the image still loads either way - a host that varies
   * its response on the referrer is hotlink protection, which is a reason to host the image properly
   * rather than a reason to leak the path.
   */
  img: (props) => {
    const { alt, className: authoredClassName, src } = props;

    if (!isAllowedImageUrl(typeof src === 'string' ? src : null)) {
      const description = typeof alt === 'string' ? alt.trim() : '';

      return description.length === 0 ? null : (
        <span className={WITHHELD_IMAGE_CLASSES}>{description}</span>
      );
    }

    return (
      // eslint-disable-next-line @next/next/no-img-element -- Markdown carries no image dimensions, so next/image cannot be used without inventing a width and height (it requires both, or `fill` inside a ratio-reserved ancestor); the host policy this rule protects is enforced above by isAllowedImageUrl.
      <img
        {...withoutHastNode(props)}
        alt={alt ?? ''}
        className={cn(CONTENT_IMAGE_CLASSES, authoredClassName)}
        decoding="async"
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  },

  /*
   * A fenced code block. See {@link PRE_CLASSES} for why the scroll behaviour is restated here
   * rather than inherited from the typography plugin.
   */
  pre: (props) => {
    const { children, className: authoredClassName } = props;

    return (
      <pre {...withoutHastNode(props)} className={cn(PRE_CLASSES, authoredClassName)}>
        {children}
      </pre>
    );
  },

  /*
   * A GFM table, rendered through the shared `Table` primitive in its `prose` variant.
   *
   * NOT a raw `<table>`, and that is a design-system rule rather than a preference: raw table
   * elements are wrapped exactly once, in `@/components/ui/table`, and feature code composes that
   * primitive instead of reaching past it. This module used to emit the element and its scroll
   * wrapper itself, which put a second copy of both the markup and the horizontal-overflow
   * guarantee in the codebase - and left the primitive able to change without this one following.
   *
   * `variant="prose"` is what makes the primitive usable here. It contributes no class to the
   * `<table>`, so the typography plugin's own table rules keep sole possession of the presentation,
   * and it swaps in a scrollport that exists at every width rather than the admin grid's sub-md
   * card collapse - which would destroy an article table instead of adapting it, since its cells
   * carry no column labels. The primitive's own documentation records both decisions.
   *
   * The header, rows and cells beneath are left to react-markdown and the plugin. Mapping them onto
   * `TableHeader`/`TableRow`/`TableCell` would import exactly the card presentation the variant
   * exists to avoid.
   *
   * No `scrollRegionLabel` is passed, and that was verified rather than assumed. Driving the
   * rendered page from the keyboard, Chrome makes an `overflow-x: auto` container a tab stop of its
   * own accord and it picks up the document-wide `:focus-visible` outline, so a keyboard reader can
   * already reach and scroll it. Naming the region would add a second, redundant stop mid-article
   * and oblige us to invent ARIA the markup does not need.
   */
  table: (props) => {
    const { children } = props;

    return (
      <Table variant="prose" {...withoutHastNode(props)}>
        {children}
      </Table>
    );
  },
};

/* -------------------------------------------------------------------------------------------------
 * Component
 * ---------------------------------------------------------------------------------------------- */

/**
 * Props for {@link PostContent}.
 *
 * Kept local rather than exported, following the convention of the sibling primitives: the module's
 * documented surface is the component alone. A consumer that genuinely needs the shape derives it,
 * which also keeps it correct if a prop is ever added:
 *
 * ```ts
 * type Props = ComponentProps<typeof PostContent>;
 * ```
 */
interface PostContentProps {
  /**
   * The author's Markdown, exactly as the service stored it - the `content` field of a post's
   * DETAIL representation, or the editor's in-progress draft text.
   *
   * Nullable and optional-valued on purpose, and the three empty forms are not hypothetical. The
   * API's LIST representation of a post omits `content` entirely so that feed responses stay small,
   * a draft can legitimately be created with an empty body, and the editor's live preview is called
   * with `''` before the author has typed anything. All three are handled rather than guarded
   * against at every call site.
   */
  content: string | null | undefined;
  /**
   * The categories to render as pills beneath the article, if the caller wants them rendered here.
   *
   * The slim `CategorySummary` projection - `id`, `name`, `slug` - which is what a post's own
   * representation embeds. It deliberately carries no post count and no description; those belong to
   * `CategoryPublic`, which the taxonomy endpoint returns and which this component has no use for.
   *
   * Optional because the post page may choose to render the category row itself as part of its own
   * metadata strip. Absent and empty are treated identically: neither renders a container.
   */
  categories?: CategorySummary[];
  /**
   * Merged through `cn`, so a caller's utility wins its own property group.
   *
   * The practical case is the reading measure. `className="md:max-w-4xl"` widens it, because that is
   * the same group and the same variant as the component's own `md:max-w-2xl`. Overriding it at
   * every width takes both halves - `className="max-w-none md:max-w-none"` - because a bare
   * `max-w-*` and an `md:max-w-*` are separate groups to the class merger and the unprefixed one
   * cannot displace the prefixed one.
   */
  className?: string;
}

/**
 * Renders a post's Markdown body, sanitised, plus an optional row of category links.
 *
 * The single renderer for author-written content in this product, used by both the published article
 * and the authoring preview so the two cannot disagree. See the notes at the top of this file for
 * why it carries no `'use client'` directive, why sanitisation happens twice, and why the heading
 * levels are shifted down by one.
 *
 * ### What it renders, and when it renders nothing
 *
 * The two sections are independent. A blank, `null` or `undefined` `content` produces no article
 * block, and absent or empty `categories` produces no pill row - and when BOTH are empty the whole
 * component returns `null` rather than an empty container, so a preview with nothing to show
 * contributes no stray gap to the layout. The string `"null"` and the string `"undefined"` are never
 * rendered, and nothing here throws on any input.
 *
 * `content` is tested with a trimmed copy but passed to the renderer UNTRIMMED, which matters more
 * than it looks: four leading spaces on the first line are an indented code block in Markdown, and
 * trimming them would silently turn an author's code sample into a paragraph.
 *
 * ### Accessibility
 *
 * No `<h1>` can reach the DOM from here. Every interactive element - each content link and each
 * category pill - is a real anchor with real text content and a visible `:focus-visible` indicator,
 * and the pills carry the design system's own 24px minimum target. The converse holds too: an
 * authored link whose href the sanitiser dropped is rendered as plain text rather than as an anchor,
 * so nothing in the output is announced as a link, focusable or styled as clickable without having
 * somewhere to go. The pill row is a labelled `<nav>` landmark, so it is reachable as "Categories"
 * and is distinguishable from the site's own navigation.
 *
 * @param content - The author's Markdown, or any of its empty forms.
 * @param categories - Categories to render as links to the filtered feed. Omit to render none.
 * @param className - Extra utilities for the outer element, merged through `cn`.
 * @returns The rendered article and category row, or `null` when there is nothing to render.
 *
 * @example The published article, in a Server Component
 * ```tsx
 * <PostContent categories={post.categories} content={post.content} />
 * ```
 *
 * @example The editor's live preview, inside a client island
 * ```tsx
 * <PostContent content={draft.content} />
 * ```
 */
export function PostContent({
  content,
  categories,
  className,
}: PostContentProps): JSX.Element | null {
  // Trimmed only to decide whether there is anything to render; `content` itself is passed through
  // verbatim below so that significant leading whitespace survives.
  const hasBody = typeof content === 'string' && content.trim().length > 0;

  // `?? []` collapses absent and empty into one case, so the render below asks one question instead
  // of two and cannot answer them inconsistently.
  const pills = categories ?? [];
  const hasCategories = pills.length > 0;

  if (!hasBody && !hasCategories) {
    return null;
  }

  return (
    <div className={cn(ROOT_CLASSES, className)}>
      {hasBody ? (
        <div className={PROSE_CLASSES}>
          <ReactMarkdown
            components={MARKDOWN_COMPONENTS}
            rehypePlugins={REHYPE_PLUGINS}
            remarkPlugins={REMARK_PLUGINS}
          >
            {content}
          </ReactMarkdown>
        </div>
      ) : null}

      {hasCategories ? (
        /*
         * A labelled landmark rather than a bare list, so the row announces what it is and is told
         * apart from the site header's navigation. The label is the only ARIA in this file: the list,
         * the items and the anchors all carry their own semantics already.
         *
         * Each pill is `BadgeLink`, the design system's own pill-shaped link, and NOT a class list
         * assembled here: the appearance, the wrapping behaviour for a long category name, the 24px
         * minimum target, the hover step and the focus ring are all declared once in
         * src/components/ui/badge.tsx, so this row and the feed card's footer cannot drift apart
         * the way two hand-rolled copies did. It renders one real crawlable anchor, which is the point
         * of rendering the row server-side at all - a category is discoverable from a post without
         * executing any client JavaScript. The href comes from `categoryFeedPath`, never from a
         * hand-built query string: a category has no route of its own in this product, its page IS the
         * category-filtered feed, and that one function is what keeps this component, the feed's own
         * filter control and the generated sitemap from disagreeing about how a category is addressed.
         *
         * The link text is the category's `name`, which is both the visible label and the accessible
         * name, and it satisfies the descriptive-link-text floor without any additional markup.
         */
        <nav aria-label="Categories">
          <ul className={CATEGORY_LIST_CLASSES}>
            {pills.map((category) => (
              <li key={category.id}>
                <BadgeLink href={categoryFeedPath(category)}>{category.name}</BadgeLink>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
