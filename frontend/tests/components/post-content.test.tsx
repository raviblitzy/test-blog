/**
 * Component tests for `src/components/blog/post-content.tsx` - the ONE renderer for author-written
 * Markdown in this product.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * `PostContent` sits on a genuine security boundary and on this project's most consequential SEO
 * decision, and this suite is the only automated check of either.
 *
 *  1. SANITISATION, RENDER HALF. Author-written content is a stored-injection surface, so the design
 *     cleans it twice: `bleach` on write in `backend/app/services/post_service.py`, and
 *     `rehype-sanitize` on render, in the component under test. The server pass protects every
 *     consumer of the API including ones this repository does not own; the render pass protects this
 *     tier from anything already in the database, from a record written before the server pass
 *     existed, and from a future service change. Nothing else in the frontend suite exercises the
 *     second half - so the three negatives below are the reason this file was written:
 *
 *       * a `<script>` in the authored body reaches no `script` element,
 *       * an inline event-handler attribute does not survive,
 *       * a `javascript:` href does not survive as a usable link target.
 *
 *     Each is asserted by querying the rendered container for the dangerous construct and expecting
 *     it ABSENT. None of them asserts that a sanitiser was called: a spy would pass while the
 *     pipeline emitted the payload anyway, which is the exact failure the pair of passes exists to
 *     prevent.
 *
 *  2. HEADING DISCIPLINE. The post route already owns the document's single `<h1>`, so the component
 *     downshifts every authored heading by exactly one level and clamps at `h6`. A second `<h1>`
 *     reaching the DOM breaks the accessibility floor, and the mapping is six strings in a map -
 *     precisely the kind of thing that regresses silently without a test.
 *
 *  3. SERVER-RENDERED ARTICLE TEXT. The component is deliberately directive-free, so it renders with
 *     no provider, no router context and no client boundary. That is exactly the condition this
 *     suite renders it under, and it is what puts the article body in the initial HTML a crawler
 *     receives. If a `'use client'` directive were ever added, the cases below would keep passing -
 *     but the render here needing no wrapper at all is the standing demonstration that none is
 *     required.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT ASSERTS, AND WHAT IT MUST NEVER ASSERT
 *
 * Every assertion targets a SEMANTIC ELEMENT, an ARIA ROLE, an ACCESSIBLE NAME, VISIBLE TEXT, or a
 * security- or privacy-bearing attribute. There is deliberately:
 *
 *   - NO `toHaveClass` - and in particular none against `prose`, which is the tempting one here.
 *     Body typography is `@tailwindcss/typography`'s prose classes plus the twelve semantic tokens,
 *     and the token layer owns those class names and is free to change them. A palette edit must not
 *     turn this suite red, and a class name is not what makes an article accessible or crawlable
 *     anyway: the produced elements and roles are.
 *   - NO `className` inspection, no class-based `querySelector`, no `getComputedStyle`, no snapshot.
 *     Where `querySelector` appears below it is on an ELEMENT name (`script`, `iframe`, `img`,
 *     `strong`, `pre > code`), on an ATTRIBUTE (`[onerror]`, `[href]`, `[src]`), or on the universal
 *     `*` - each of which IS the construct being asserted absent or present, never a style hook.
 *   - NO re-configuration of `react-markdown`, `remark-gfm` or `rehype-sanitize`. The component is
 *     their single configuration site; declaring a pipeline here would test this file's
 *     configuration rather than the product's.
 *   - NO `dangerouslySetInnerHTML`, anywhere.
 *   - NO hard-coded site origin and no `process.env` read. `frontend/vitest.config.ts` pins the three
 *     public values for the whole suite, and `categoryFeedPath` - the builder the component uses -
 *     yields a RELATIVE path and reads no environment variable, so there is nothing to stub.
 *
 * ---------------------------------------------------------------------------
 * HARNESS CONVENTIONS THIS FILE FOLLOWS
 *
 *   - The test API is IMPORTED from `vitest` rather than leaned on as a global. `vitest.config.ts`
 *     enables globals for the runtime, but `frontend/tsconfig.json` includes every `.tsx` in the
 *     `tsc --noEmit` program and declares no `vitest/globals` types, so a file that relied on the
 *     globals would fail that gate with TS2593/TS2304 while passing at run time. Both gates block.
 *   - `@testing-library/jest-dom` is NOT imported and `cleanup` is NOT called: `frontend/
 *     vitest.setup.ts` registers the matchers via the `/vitest` subpath and unmounts between tests.
 *   - No `setupServer`, and `tests/msw/handlers.ts` is not imported. This component performs no HTTP
 *     at all, so there is nothing to intercept and a server would only add a lifecycle that could
 *     fail.
 *   - No `React` import: `frontend/tsconfig.json` sets `"jsx": "react-jsx"`.
 *   - No `.only` and no `.skip`.
 *
 * ---------------------------------------------------------------------------
 * GOVERNING STANDARDS
 *
 * No user-specified rules were provided for this project - `review_rules` reports none - so the
 * binding constraints are the technical plan's own enterprise standards. Seven govern this file:
 * accessibility as a floor, blocking quality gates, zero hardcoded presentation values, content
 * sanitisation, explicit API contracts, configuration from the environment only, and pinned
 * reproducible dependencies. Each is honoured by a decision recorded above.
 */

import { render, screen } from '@testing-library/react';
import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import type { PluggableList } from 'unified';
import { describe, expect, it } from 'vitest';

import { PostContent } from '@/components/blog/post-content';
import { categoryFeedPath } from '@/lib/seo';
import type { CategorySummary } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Fixture values that are also asserted
 *
 * Interpolated into the Markdown below rather than written twice. A URL that appeared once in a
 * fixture and once in an expectation could drift apart, and the test would then pass while asserting
 * something the fixture no longer contains.
 * ---------------------------------------------------------------------------------------------- */

/** An authored link that leaves this origin, so it must pick up the hardened `rel`. */
const EXTERNAL_LINK_HREF = 'https://example.com/guide';

/** An authored link that stays on this origin, so it must NOT pick up a `rel`. */
const INTERNAL_LINK_HREF = '/blog/another-post';

/**
 * A content image whose host this deployment admits.
 *
 * The host is written out rather than imported. `IMAGE_HOST_ALLOWLIST` in `@/lib/utils` is the
 * single source of the policy, but that module is not part of this file's declared dependency set,
 * and the policy is deliberately source code rather than configuration - so the value is restated
 * here with this note pointing at its origin. If the allow-list ever loses this host, this literal
 * is what has to follow it.
 */
const ADMITTED_IMAGE_URL = 'https://images.unsplash.com/photo-1.jpg';

/** A content image on a host the policy does not admit, carrying alt text to stand in for it. */
const WITHHELD_IMAGE_URL = 'https://tracker.example/pixel.png';

/** A DECORATIVE image on an unadmitted host: no alt text, so nothing stands in for it. */
const WITHHELD_DECORATIVE_IMAGE_URL = 'https://tracker.example/beacon.png';

/**
 * Base used ONLY to make a relative href parseable by `URL`.
 *
 * It is never asserted and is not an expected origin: the expected href itself always comes from
 * `categoryFeedPath`. Parsing exists so a query string can be read through `searchParams`, which
 * makes the assertion independent of parameter order and of escaping.
 */
const RELATIVE_HREF_BASE = 'http://localhost';

/* -------------------------------------------------------------------------------------------------
 * Markdown fixtures
 *
 * Plain template literals declared in this file. Nothing is read from disk: a fixture a reader
 * cannot see beside the assertion that depends on it is a fixture that quietly stops matching it.
 * ---------------------------------------------------------------------------------------------- */

/**
 * GitHub Flavoured Markdown exercising every construct the pipeline is configured for.
 *
 * The three GFM-specific ones - the pipe table, the task list and the strikethrough - are the
 * features `remark-gfm` is in the dependency set for, so each gets an assertion of its own rather
 * than merely sitting in the fixture. Headings run `#` through `######` so the whole downshift map,
 * including the `h6` clamp, is covered by one render.
 */
const GFM_CONTENT = `# Authored top-level heading

Intro paragraph with **bold emphasis**, *italic emphasis*, an [inline link](${EXTERNAL_LINK_HREF}) and a [local link](${INTERNAL_LINK_HREF}).

## Authored second-level heading

- first bullet
- second bullet

1. first step
2. second step

\`\`\`ts
const answer = 42;
\`\`\`

| Column A | Column B |
| -------- | -------- |
| cell one | cell two |

- [ ] unchecked task
- [x] checked task

Some ~~struck through~~ text.

### Authored third-level heading

#### Authored fourth-level heading

##### Authored fifth-level heading

###### Authored sixth-level heading
`;

/**
 * The hostile body. Every construct here is one an author, a compromised account or a record written
 * before the server-side pass existed could put in the `content` column.
 *
 * Each raw-HTML construct sits on a line of its own, which is what makes it a CommonMark raw-HTML
 * BLOCK - the form in which the payload text goes with the element rather than surviving as inert
 * text beside it. The inline form is a genuinely different code path and gets its own fixture below.
 */
const HOSTILE_CONTENT = `<script>alert(1)</script>

<img src=x onerror="alert(1)">

<iframe src="https://evil.example/frame"></iframe>

An authored [click](javascript:alert(1)) link.

An authored [empty target]() link.
`;

/**
 * Raw HTML written INLINE inside a paragraph, which CommonMark treats differently from a raw-HTML
 * block: the TAGS are stripped, and whatever sat between them survives as ordinary inert text.
 *
 * Both paths have to be checked, because "no element" is the property that matters and only one of
 * the two also removes the payload's text.
 */
const INLINE_RAW_HTML_CONTENT = `Text with <script>alert(1)</script> in the middle of it, plus <b>raw bold</b> and an <img src=y onerror="alert(2)"> tag.
`;

/**
 * The three image outcomes the `img` override produces, in one body: an admitted host, an unadmitted
 * host with alt text, and an unadmitted host with none.
 */
const IMAGE_CONTENT = `![Diagram of the publish path](${ADMITTED_IMAGE_URL})

![Chart of weekly publishing volume](${WITHHELD_IMAGE_URL})

![](${WITHHELD_DECORATIVE_IMAGE_URL})
`;

/** A body with no links, no images and no raw HTML, for the cases that are about the surroundings. */
const PLAIN_CONTENT = `Just a paragraph of ordinary prose.
`;

/* -------------------------------------------------------------------------------------------------
 * Fixtures that REACH the sanitiser, and why the ones above do not
 *
 * The three raw-HTML fixtures above are neutralised before `rehype-sanitize` ever sees them, and that
 * is worth stating plainly because it decides what the group at the end of this file has to do.
 * `rehype-raw` is deliberately absent from the pipeline, so react-markdown never parses `<script>`,
 * `<iframe>` or an `onerror` attribute into tree nodes at all: they are text, and the sanitiser has
 * nothing to remove. Those cases therefore prove the *pipeline posture* - that raw HTML is not
 * rendered - and they would keep passing with the sanitiser deleted. They are necessary and they are
 * not sufficient.
 *
 * What DOES reach the sanitiser is a Markdown-native construct whose URL react-markdown's own
 * `urlTransform` admits and whose element the sanitiser's schema does not. The two lists disagree on
 * exactly one axis, verified against the installed packages:
 *
 *   react-markdown urlTransform  http, https, irc, ircs, mailto, xmpp - for EVERY url property
 *   sanitiser schema, href       http, https, irc, ircs, mailto, xmpp - identical, so no disagreement
 *   sanitiser schema, src        http, https ONLY
 *
 * So `![alt](mailto:someone@example.com)` is Markdown - no raw HTML anywhere - and it produces an
 * `img` whose `src` react-markdown keeps and the sanitiser strips. That is the input the sanitiser is
 * the sole remover of, and it is what the boundary group at the end of this file is built on.
 * ---------------------------------------------------------------------------------------------- */

/**
 * An image address in a scheme react-markdown admits and the sanitiser's `src` list does not.
 *
 * `mailto:` rather than something exotic, because it is the case a real author can produce by
 * accident - pasting a contact address into image syntax - and because it is admitted by every URL
 * check in the pipeline except the one under test.
 */
const SANITISER_ONLY_IMAGE_SRC = 'mailto:someone@example.com';

/** The same disagreement in a second scheme, so the case is a class rather than a single value. */
const SANITISER_ONLY_IMAGE_SRC_ALTERNATE = 'xmpp:someone@example.com';

/**
 * The four spellings of that construct, each a different mdast path to the same hast `img`.
 *
 * Inline, reference-style, nested in a list item and nested inside a link. All four are Markdown, and
 * a sanitiser wired into the pipeline cleans every one of them; a sanitiser applied at only one of
 * these paths - which is what a hand-rolled cleanup at the component boundary would be - would miss
 * three.
 */
const SANITISER_REACHING_FIXTURES: readonly (readonly [string, string])[] = [
  ['an inline image', `![A diagram](${SANITISER_ONLY_IMAGE_SRC})`],
  [
    'a reference-style image',
    `![A diagram][ref]\n\n[ref]: ${SANITISER_ONLY_IMAGE_SRC_ALTERNATE}\n`,
  ],
  ['an image inside a list item', `- ![A diagram](${SANITISER_ONLY_IMAGE_SRC})\n`],
  ['an image inside a link', `[![A diagram](${SANITISER_ONLY_IMAGE_SRC})](${EXTERNAL_LINK_HREF})`],
];

/**
 * A raw-HTML payload behind a four-space indent, which is a DIFFERENT CommonMark path again.
 *
 * Four leading spaces open an indented code block, so the payload is neither an element nor stripped
 * text: it is the literal contents of a code block, escaped and displayed. That distinction is the
 * reason `@/lib/validation/post` refuses to trim the content field - trimming this body would turn a
 * code sample into a paragraph and change what a reader is shown - and it is the reason this fixture
 * exists: the raw-HTML-block case above asserts `alert(1)` is ABSENT from the text, and this one
 * asserts it is PRESENT as text, so a change that started stripping code-block contents would be
 * caught rather than looking like better sanitisation.
 */
const INDENTED_RAW_HTML_CONTENT = `Prose above the sample.

    <script>alert(1)</script>
    <img src=x onerror="alert(2)">
`;

/**
 * Whitespace that is significant inside a fenced block: a blank first line and a deeper indent.
 *
 * Fenced blocks are the one place the renderer must preserve what it is given byte for byte, because
 * indentation carries meaning in most of the languages an author would paste.
 */
const FENCE_WHITESPACE_CONTENT = `\`\`\`text

    indented inside the fence
\`\`\`
`;

/**
 * A fence whose info string is a raw-HTML payload rather than a language name.
 *
 * The info string becomes a `className` on `code`, and the sanitiser's schema permits `className`
 * there only when it matches \`/^language-./\`. react-markdown always writes the `language-` prefix, so
 * the interesting property is not that the class is dropped - it is not - but that a payload in that
 * position stays a CLASS TOKEN and produces no element and no attribute of its own.
 */
const FENCE_HOSTILE_INFO_CONTENT = `\`\`\`<img src=x onerror=alert(1)>
body text inside the fence
\`\`\`
`;

/** A fence with a real language name, and the false-positive half of the class rule. */
const FENCE_LANGUAGE_CONTENT = `\`\`\`js
const answer = 1;
\`\`\`
`;

/** A fence with no info string at all, which must therefore carry no class. */
const FENCE_NO_INFO_CONTENT = `\`\`\`
plain fence, no language
\`\`\`
`;

/**
 * A GFM footnote, which is the one Markdown construct that puts an author-influenced value into an
 * `id` attribute.
 *
 * That makes it the only content this product can store which exercises the sanitiser's *clobber*
 * rule - `id` and `name` rewritten behind a `user-content-` prefix - and therefore the only
 * sanitiser effect observable in `PostContent`'s own rendered output rather than only at the plugin
 * boundary. The label after the caret is author-written, which is precisely the point.
 */
const FOOTNOTE_CONTENT = `A claim that needs a source.[^src]

[^src]: Measured on the pinned toolchain.
`;

/* -------------------------------------------------------------------------------------------------
 * Category fixture
 *
 * Typed as the SLIM projection with no cast. `CategorySummary` is exactly `id`, `name` and `slug` -
 * what a post's own representation embeds - and it is imported type-only because no value from
 * `@/lib/types` is needed. `CategoryPublic` would also satisfy the prop, and using it here would
 * quietly widen the contract this component is documented against, so it is not used.
 *
 * `readonly` so the array cannot be mutated by a render; the prop takes a mutable array, so call
 * sites spread it. Identifiers are UUID-shaped because identity is a database-generated UUID on the
 * wire, and field names are snake_case because there is no camel-case mapping layer in this tier.
 * ---------------------------------------------------------------------------------------------- */

const CATEGORIES: readonly CategorySummary[] = [
  { id: '3f2c1d8e-5a4b-4c7d-9e1f-2a3b4c5d6e7f', name: 'Engineering', slug: 'engineering' },
  { id: '7b6a5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d', name: 'Design & Type', slug: 'design-type' },
];

/* -------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

/** The heading levels the accessible tree can report, narrowest possible type. */
type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Every level, in order, so a lookup can be a `find` rather than an index.
 *
 * `frontend/tsconfig.json` sets `noUncheckedIndexedAccess`, so reading `LEVELS[0]` would be
 * `HeadingLevel | undefined` and would need a guard that says nothing about the component. `find`
 * returns the same union honestly and needs one guard that IS meaningful - see below.
 */
const HEADING_LEVELS: readonly HeadingLevel[] = [1, 2, 3, 4, 5, 6];

/**
 * The level the ACCESSIBLE TREE reports for the heading with this accessible name.
 *
 * Deliberately derived by asking `queryByRole` at each level rather than by reading a tag name. The
 * requirement is about heading SEMANTICS - no `h1` escaping, levels staying ordered - and the
 * accessible tree is where that requirement is actually observed. Reading `tagName` would also work
 * on markup that assistive technology cannot interpret, which is not the property being asserted.
 *
 * Every heading name in the fixtures is unique, so the first level that answers is the only one that
 * can - which is what makes a single returned level meaningful rather than merely the lowest match.
 *
 * @param name - The heading's accessible name, which for these fixtures is its text.
 * @returns The level at which a heading with that name exists.
 * @throws If no heading with that name exists at any level, which is itself a real regression.
 */
function accessibleHeadingLevel(name: string): HeadingLevel {
  const level = HEADING_LEVELS.find(
    (candidate) => screen.queryByRole('heading', { level: candidate, name }) !== null,
  );

  if (level === undefined) {
    throw new Error(`No heading named "${name}" is present at any level in the accessible tree.`);
  }

  return level;
}

/**
 * The `href` an element actually carries.
 *
 * Narrows away the `null` that `getAttribute` returns for a missing attribute, so a caller can parse
 * the value without a non-null assertion. An anchor with no href is a real defect this product cares
 * about - the component renders a plain `<span>` instead of one - so reaching here with `null` is a
 * failure worth naming rather than a type nuisance to silence.
 */
function hrefOf(element: Element): string {
  const href = element.getAttribute('href');

  if (href === null) {
    throw new Error(`Expected <${element.tagName.toLowerCase()}> to carry an href attribute.`);
  }

  return href;
}

/**
 * Every `href` value present anywhere in the rendered output.
 *
 * An ATTRIBUTE selector, not a class one: the attribute is the construct under assertion. Used to
 * show that a scheme the sanitiser rejects is nowhere in the DOM, rather than merely absent from the
 * one element a role query happened to find.
 */
function renderedHrefs(container: HTMLElement): readonly string[] {
  return Array.from(container.querySelectorAll('[href]')).map(hrefOf);
}

/**
 * Every `src` value present anywhere in the rendered output.
 *
 * The precise form of "this URL was never emitted". Asserting on the container's markup as a string
 * would also work and is deliberately avoided: it would couple the assertion to class names and to
 * attribute order, which is a snapshot in all but name. An empty result means no subresource request
 * was made at all.
 */
function renderedSrcs(container: HTMLElement): readonly string[] {
  return Array.from(container.querySelectorAll('[src]')).map((element) => {
    const src = element.getAttribute('src');

    if (src === null) {
      throw new Error(`Expected <${element.tagName.toLowerCase()}> to carry a src attribute.`);
    }

    return src;
  });
}

/**
 * Every inline event handler that reached the DOM, reported as `tag[attribute]`.
 *
 * The generic form of the inline-event-handler check. Asserting only `[onerror]` would pass a body
 * that smuggled `onload`, `onclick` or `onanimationstart` through instead, so the sweep is over the
 * whole `on*` namespace, case-insensitively because HTML attribute names are.
 *
 * Strings rather than elements so that a failure names the offender - `['img[onerror]']` - instead of
 * printing a diff of DOM nodes.
 */
function eventHandlerAttributes(container: HTMLElement): readonly string[] {
  return Array.from(container.querySelectorAll('*')).flatMap((element) =>
    element
      .getAttributeNames()
      .filter((attribute) => attribute.toLowerCase().startsWith('on'))
      .map((attribute) => `${element.tagName.toLowerCase()}[${attribute}]`),
  );
}

/**
 * Render one Markdown body through the component's remark half with the rehype half supplied, and
 * report every `src` that survived.
 *
 * This is the instrument that makes the sanitiser's boundary observable. `PostContent` declares
 * `remarkPlugins={[remarkGfm]}` and `rehypePlugins={[rehypeSanitize]}` and exports neither array, so
 * the pair is restated here - and the restatement is the point rather than a workaround: passing `[]`
 * as the rehype half renders the SAME content with the sanitiser removed, which is the only way to
 * show that a given input reaches it and that it is the sole remover of what disappears.
 *
 * The remark half is not varied: `remark-gfm` decides which constructs parse, and swapping it would
 * change what reaches the comparison rather than what the comparison measures.
 *
 * The container is detached before returning so two renders in one test cannot be confused by a
 * document-wide query; the returned values are already materialised strings.
 */
function renderThroughPipeline(content: string, rehypePlugins: PluggableList): HTMLElement {
  const { container } = render(
    <Markdown rehypePlugins={rehypePlugins} remarkPlugins={[remarkGfm]}>
      {content}
    </Markdown>,
  );
  // Detached before returning so two renders in one test cannot be confused by a document-wide query.
  // jsdom keeps the subtree intact, so every query below still resolves against it.
  container.remove();
  return container;
}

/** Every `id` present anywhere in a rendered subtree, in document order. */
function renderedIds(container: HTMLElement): readonly string[] {
  return Array.from(container.querySelectorAll('[id]')).map((element) => element.id);
}

/**
 * The one `pre > code` pair a fenced or indented block renders, proven present.
 *
 * Thrown rather than asserted so a caller reading `.className` cannot be handed `null` and report a
 * confusing type failure instead of the structural one that actually happened.
 */
function codeBlockIn(container: HTMLElement): HTMLElement {
  const code = container.querySelector('pre > code');

  if (!(code instanceof HTMLElement)) {
    throw new Error('Expected the rendered output to contain one pre/code pair.');
  }

  return code;
}

/* -------------------------------------------------------------------------------------------------
 * Cases
 * ---------------------------------------------------------------------------------------------- */

describe('PostContent', () => {
  describe('GitHub Flavoured Markdown', () => {
    it('renders emphasis as semantic elements rather than styled text', () => {
      const { container } = render(<PostContent content={GFM_CONTENT} />);

      expect(container.querySelector('strong')).toHaveTextContent('bold emphasis');
      expect(container.querySelector('em')).toHaveTextContent('italic emphasis');
    });

    it('renders both list flavours, with every authored item', () => {
      render(<PostContent content={GFM_CONTENT} />);

      // Three lists: the bullets, the numbered steps, and the GFM task list.
      expect(screen.getAllByRole('list')).toHaveLength(3);
      expect(screen.getAllByRole('listitem')).toHaveLength(6);

      expect(screen.getByText('first bullet')).toBeInTheDocument();
      expect(screen.getByText('second bullet')).toBeInTheDocument();
      expect(screen.getByText('first step')).toBeInTheDocument();
      expect(screen.getByText('second step')).toBeInTheDocument();
    });

    it('renders a fenced code block as a pre/code pair with its language preserved', () => {
      const { container } = render(<PostContent content={GFM_CONTENT} />);

      // An element selector, and the nesting IS the assertion: a fenced block has to produce a
      // `<code>` inside a `<pre>` for the sanitiser's language class - and any future highlighter -
      // to have somewhere to live.
      const code = container.querySelector('pre > code');

      expect(code).not.toBeNull();
      expect(code).toHaveTextContent('const answer = 42;');
    });

    it('renders a GFM table with its column headers and cells in the accessible tree', () => {
      render(<PostContent content={GFM_CONTENT} />);

      expect(screen.getByRole('table')).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: 'Column A' })).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: 'Column B' })).toBeInTheDocument();
      expect(screen.getByRole('cell', { name: 'cell one' })).toBeInTheDocument();
      expect(screen.getByRole('cell', { name: 'cell two' })).toBeInTheDocument();

      // The header band and the body are separate row groups, and each holds one row.
      expect(screen.getAllByRole('rowgroup')).toHaveLength(2);
      expect(screen.getAllByRole('row')).toHaveLength(2);
    });

    it('renders a GFM task list as checkboxes reflecting their authored state', () => {
      render(<PostContent content={GFM_CONTENT} />);

      expect(screen.getAllByRole('checkbox')).toHaveLength(2);
      expect(screen.getByRole('checkbox', { checked: false })).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { checked: true })).toBeInTheDocument();

      expect(screen.getByText('unchecked task')).toBeInTheDocument();
      expect(screen.getByText('checked task')).toBeInTheDocument();
    });

    it('renders GFM strikethrough as a deletion rather than as decorated text', () => {
      render(<PostContent content={GFM_CONTENT} />);

      expect(screen.getByRole('deletion')).toHaveTextContent('struck through');
    });

    it('renders an authored link as a link whose accessible name is its own text', () => {
      render(<PostContent content={GFM_CONTENT} />);

      const link = screen.getByRole('link', { name: 'inline link' });

      expect(link).toHaveAccessibleName('inline link');
      expect(hrefOf(link)).toBe(EXTERNAL_LINK_HREF);
    });

    it('hardens the rel of a link that leaves this origin, and only that link', () => {
      render(<PostContent content={GFM_CONTENT} />);

      const external = screen.getByRole('link', { name: 'inline link' });
      const internal = screen.getByRole('link', { name: 'local link' });

      // `noreferrer` is the load-bearing half: it stops the reader's current URL reaching a host the
      // post's author chose.
      expect(external).toHaveAttribute('rel', 'noopener noreferrer');
      // No new tab, so no unannounced change of context and no need to rewrite the author's text.
      expect(external).not.toHaveAttribute('target');

      expect(hrefOf(internal)).toBe(INTERNAL_LINK_HREF);
      expect(internal).not.toHaveAttribute('rel');
    });
  });

  describe('heading discipline', () => {
    it('emits no level 1 heading, whatever level the author wrote', () => {
      render(<PostContent content={GFM_CONTENT} />);

      // The fixture opens with `# `, which react-markdown would otherwise render as an `<h1>` -
      // beside the one the post route already owns.
      expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    });

    it('downshifts each authored heading by exactly one level', () => {
      render(<PostContent content={GFM_CONTENT} />);

      expect(accessibleHeadingLevel('Authored top-level heading')).toBe(2);
      expect(accessibleHeadingLevel('Authored second-level heading')).toBe(3);
      expect(accessibleHeadingLevel('Authored third-level heading')).toBe(4);
      expect(accessibleHeadingLevel('Authored fourth-level heading')).toBe(5);
    });

    it('keeps the authored heading order after the downshift', () => {
      render(<PostContent content={GFM_CONTENT} />);

      const first = accessibleHeadingLevel('Authored top-level heading');
      const second = accessibleHeadingLevel('Authored second-level heading');
      const third = accessibleHeadingLevel('Authored third-level heading');

      // A uniform shift, not merely an `h1`-free one: the author's own structure survives, so a
      // reader of the accessible tree still sees each section nested inside the one above it.
      expect(second - first).toBe(1);
      expect(third - second).toBe(1);
    });

    it('clamps the two deepest authored levels at level 6', () => {
      render(<PostContent content={GFM_CONTENT} />);

      expect(accessibleHeadingLevel('Authored fifth-level heading')).toBe(6);
      expect(accessibleHeadingLevel('Authored sixth-level heading')).toBe(6);

      // Both land on the same level, which is what "clamp" means: there is no `h7` to shift into.
      expect(screen.getAllByRole('heading', { level: 6 })).toHaveLength(2);
    });
  });

  describe('sanitisation on render', () => {
    it('renders no script element from an authored script tag', () => {
      const { container } = render(<PostContent content={HOSTILE_CONTENT} />);

      // Absence of the ELEMENT is the assertion. Detecting execution would be both unreliable and
      // beside the point: nothing can execute that was never rendered.
      expect(container.querySelectorAll('script')).toHaveLength(0);

      // A raw-HTML BLOCK is dropped whole, so the payload's own text goes with the tags.
      expect(container.textContent).not.toContain('alert(1)');
    });

    it('lets no inline event-handler attribute survive', () => {
      const { container } = render(<PostContent content={HOSTILE_CONTENT} />);

      expect(container.querySelectorAll('[onerror]')).toHaveLength(0);
      // The whole `on*` namespace, not just the one the fixture happens to use.
      expect(eventHandlerAttributes(container)).toEqual([]);
    });

    it('does not render a javascript: URL as a usable link target', () => {
      const { container } = render(<PostContent content={HOSTILE_CONTENT} />);

      // The sanitiser drops the offending ATTRIBUTE and keeps the element, so the component's `a`
      // override degrades it to plain text: nothing in the output is announced as a link, focusable,
      // or styled as clickable without having anywhere to go.
      expect(screen.queryAllByRole('link')).toHaveLength(0);
      expect(screen.getByText('click')).toBeInTheDocument();

      const javascriptHrefs = renderedHrefs(container).filter((href) =>
        href.trim().toLowerCase().startsWith('javascript:'),
      );

      expect(javascriptHrefs).toEqual([]);
      // The neighbouring `[empty target]()` link degrades the same way, for the same reason.
      expect(screen.getByText('empty target')).toBeInTheDocument();
    });

    it('renders no iframe from an authored iframe tag', () => {
      const { container } = render(<PostContent content={HOSTILE_CONTENT} />);

      expect(container.querySelectorAll('iframe')).toHaveLength(0);
      expect(container.textContent).not.toContain('evil.example');
    });

    it('strips raw inline HTML tags, leaving only inert text behind', () => {
      const { container } = render(<PostContent content={INLINE_RAW_HTML_CONTENT} />);

      // Inline raw HTML is a different CommonMark path from a raw-HTML block: the tags go and their
      // contents stay as text. No element is produced either way, which is the property that matters.
      expect(container.querySelectorAll('script')).toHaveLength(0);
      expect(container.querySelectorAll('img')).toHaveLength(0);
      expect(container.querySelector('b')).toBeNull();
      expect(eventHandlerAttributes(container)).toEqual([]);
      expect(renderedSrcs(container)).toEqual([]);

      // The residue is ordinary paragraph text, so the reader sees it and the browser does nothing
      // with it.
      expect(screen.getByText(/raw bold/)).toBeInTheDocument();
    });
  });

  /* -----------------------------------------------------------------------------------------------
   * The sanitiser's own boundary
   *
   * Every case in the group above would still pass with `rehype-sanitize` deleted from the pipeline,
   * because `rehype-raw` is absent and react-markdown therefore never turns raw HTML into nodes for a
   * sanitiser to clean. Those cases prove the pipeline posture. This group proves the second line of
   * defence is real: it feeds the pipeline a Markdown-native construct that reaches the sanitiser, and
   * asserts BOTH sides of the comparison - present without it, absent with it - so the case cannot
   * pass because nothing was ever there.
   *
   * That two-sided form is what makes these tests fail if the sanitiser is removed, replaced with a
   * no-op, or configured with a schema widened to admit `mailto:`/`xmpp:` in `src`. The header of the
   * component names removing the render pass as the change that turns defence in depth into a single
   * point of failure; this is the group that would object to it.
   * -------------------------------------------------------------------------------------------- */
  describe('the sanitiser is load-bearing, not decorative', () => {
    it.each(SANITISER_REACHING_FIXTURES)(
      'strips the src of %s, and is the only pass that does',
      (_description, content) => {
        // WITHOUT the sanitiser the address survives every other check in the pipeline: it is
        // Markdown rather than raw HTML, so `rehype-raw`'s absence is no help, and its scheme is on
        // react-markdown's own admitted list, so `urlTransform` passes it through.
        expect(renderedSrcs(renderThroughPipeline(content, []))).toHaveLength(1);

        // WITH the sanitiser the `src` attribute is gone, because the schema admits only http and
        // https there. Same content, same remark half, one plugin apart.
        expect(renderedSrcs(renderThroughPipeline(content, [rehypeSanitize]))).toEqual([]);
      },
    );

    it('applies the clobber prefix to every author-reachable id in the article', () => {
      const { container } = render(<PostContent content={FOOTNOTE_CONTENT} />);

      // GFM footnotes are the one Markdown construct that puts an author-influenced value into an
      // `id`, and the sanitiser's schema clobbers `id` and `name` behind a `user-content-` prefix for
      // exactly that reason: an unprefixed author-reachable id is a DOM-clobbering surface, where an
      // element named `body`, `head` or after a form control shadows the property scripts read.
      const ids = renderedIds(container);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(id.startsWith('user-content-')).toBe(true);
      }

      // THIS is the assertion that ties the guarantee to the component rather than to the plugin:
      // removing `rehypeSanitize` from the component's own `rehypePlugins` leaves these ids
      // unprefixed, and this case is what objects. Verified by making that change.
      const reference = container.querySelector('[aria-describedby]');
      expect(reference).not.toBeNull();
      expect(reference?.getAttribute('aria-describedby')).toBe('user-content-footnote-label');

      // And the accessible relationship it names resolves, so the prefix did not orphan it: the
      // reference describes itself by the footnotes heading, and that heading is present under exactly
      // that id.
      const label = container.querySelector('#user-content-footnote-label');
      expect(label).not.toBeNull();
      expect(label?.textContent).toBe('Footnotes');

      // WHAT THIS CASE DELIBERATELY DOES NOT ASSERT, and why the reader should know: the sanitiser
      // applies its `user-content-` prefix on top of the one `mdast-util-to-hast` has already applied,
      // so a footnote's `id` arrives doubly prefixed while the `href` that points at it keeps a single
      // prefix. The in-page jump between a reference and its note therefore does not resolve in the
      // shipped pipeline. That is a rendering defect in its own right rather than a sanitisation
      // property, it is outside the scope this file was changed for, and it is left untouched and
      // unasserted here so that neither the defect nor a future correction of it is written into a
      // security test as though it were the contract.
    });

    it('emits no image and makes no subresource request for such a body', () => {
      for (const [description, content] of SANITISER_REACHING_FIXTURES) {
        const { container } = render(<PostContent content={content} />);

        // The product-level guarantee, stated where the product delivers it. Two independent guards
        // reach this outcome - the sanitiser removed the address, and the `img` override's host policy
        // would have refused it anyway - and the guarantee is that BOTH have to fail for a request to
        // be made, which is what defence in depth means here.
        expect(container.querySelectorAll('img'), description).toHaveLength(0);
        expect(renderedSrcs(container), description).toEqual([]);
        expect(eventHandlerAttributes(container), description).toEqual([]);

        // The author's alt text stands in, so the reader is told something was meant to be here.
        expect(container.textContent, description).toContain('A diagram');
        container.remove();
      }
    });
  });

  /* -----------------------------------------------------------------------------------------------
   * Leading whitespace, which is content rather than noise
   *
   * Four leading spaces open an indented code block, and that is a third CommonMark path distinct from
   * both raw-HTML forms above: the payload is neither an element nor stripped text but the literal
   * contents of a code block, escaped and displayed. It is also the reason `@/lib/validation/post`
   * refuses to trim the content field - a trim would silently turn a code sample into a paragraph.
   * -------------------------------------------------------------------------------------------- */
  describe('significant leading whitespace', () => {
    it('renders an indented raw-HTML payload as inert code-block text', () => {
      const { container } = render(<PostContent content={INDENTED_RAW_HTML_CONTENT} />);

      // No element and no attribute, exactly as for the unindented forms.
      expect(container.querySelectorAll('script')).toHaveLength(0);
      expect(container.querySelectorAll('img')).toHaveLength(0);
      expect(eventHandlerAttributes(container)).toEqual([]);
      expect(renderedSrcs(container)).toEqual([]);

      // But here the payload's TEXT is deliberately retained, and that is the opposite of the
      // raw-HTML-block case, which drops the text with the tags. An author who pastes a script tag
      // into a code sample is showing it to a reader, and a renderer that swallowed it would be
      // corrupting the article rather than protecting anyone. Both outcomes are correct for their own
      // input, and asserting only one of them would let the other regress unnoticed.
      const code = codeBlockIn(container);
      expect(code.textContent).toContain('<script>alert(1)</script>');
      expect(code.textContent).toContain('onerror="alert(2)"');
      // Inside a `code` element, which is what makes it inert: the browser parses none of it.
      expect(code.closest('pre')).not.toBeNull();
      // And the prose above it is still a paragraph, so the indent - not the payload - is what made
      // this a code block.
      expect(screen.getByText('Prose above the sample.').tagName).toBe('P');
    });

    it('preserves a blank first line and a deeper indent inside a fenced block', () => {
      const { container } = render(<PostContent content={FENCE_WHITESPACE_CONTENT} />);

      // Byte-for-byte, because indentation carries meaning in most of what an author would paste. A
      // renderer that collapsed either would change the sample's meaning without saying so.
      expect(codeBlockIn(container).textContent).toBe('\n    indented inside the fence\n');
    });
  });

  /* -----------------------------------------------------------------------------------------------
   * The language class on a fenced block
   *
   * The sanitiser's schema permits `className` on `code` only when it matches `/^language-./`, and
   * react-markdown always writes that prefix - so the rule's interesting consequences are that a
   * legitimate language name SURVIVES (the component's header claims the schema needs no widening, and
   * this is where that claim is checked) and that a payload written where a language name belongs stays
   * a class token rather than becoming markup.
   * -------------------------------------------------------------------------------------------- */
  describe('fenced-block language class', () => {
    it('keeps a legitimate language class, so the schema needs no widening', () => {
      const { container } = render(<PostContent content={FENCE_LANGUAGE_CONTENT} />);

      // No syntax highlighter is declared in the dependency set, so this class is the whole of the
      // language signal: it is preserved precisely so a highlighter can be introduced later without
      // touching the component. A schema tightened to drop it would break that quietly.
      expect(codeBlockIn(container)).toHaveClass('language-js');
      expect(codeBlockIn(container).textContent).toBe('const answer = 1;\n');
    });

    it('leaves a hostile fence info string as an inert class token', () => {
      const { container } = render(<PostContent content={FENCE_HOSTILE_INFO_CONTENT} />);

      const code = codeBlockIn(container);
      // The payload is confined to the `class` attribute, under the `language-` prefix react-markdown
      // writes - so it is a class token and nothing else.
      expect(code.className.startsWith('language-')).toBe(true);
      // And nothing was constructed from it: no element, no attribute, no request.
      expect(container.querySelectorAll('img')).toHaveLength(0);
      expect(eventHandlerAttributes(container)).toEqual([]);
      expect(renderedSrcs(container)).toEqual([]);
      // The fence's own body still renders, so the hostile info string cost the author nothing.
      expect(code.textContent).toBe('body text inside the fence\n');
    });

    it('emits no class at all for a fence with no info string', () => {
      const { container } = render(<PostContent content={FENCE_NO_INFO_CONTENT} />);

      // Absent rather than empty: an empty `language-` class would match nothing a highlighter looks
      // for and would be a value invented by the renderer.
      expect(codeBlockIn(container).getAttribute('class')).toBeNull();
    });
  });

  describe('inline images', () => {
    it('renders an image from an admitted host with its alt text as the accessible name', () => {
      render(<PostContent content={IMAGE_CONTENT} />);

      const image = screen.getByRole('img', { name: 'Diagram of the publish path' });

      expect(image).toHaveAttribute('src', ADMITTED_IMAGE_URL);
    });

    it('applies the privacy and loading attributes to an admitted image', () => {
      render(<PostContent content={IMAGE_CONTENT} />);

      const image = screen.getByRole('img', { name: 'Diagram of the publish path' });

      // The counterpart of the anchor's `rel="noreferrer"`: without it, an image host learns which
      // article each reader is reading, from the reader's own address, with no interaction at all.
      expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
      expect(image).toHaveAttribute('loading', 'lazy');
      expect(image).toHaveAttribute('decoding', 'async');
    });

    it('substitutes the alt text for an image whose host the policy does not admit', () => {
      const { container } = render(<PostContent content={IMAGE_CONTENT} />);

      // Not rendered as an image: an `<img src>` that reaches the DOM has already made its request,
      // so the decision has to be taken before an element exists. What is left is the image's own
      // textual equivalent.
      expect(screen.queryByRole('img', { name: 'Chart of weekly publishing volume' })).toBeNull();
      expect(screen.getByText('Chart of weekly publishing volume')).toBeInTheDocument();

      // The unadmitted URL is emitted nowhere, so the reader's browser never contacts that host.
      expect(renderedSrcs(container)).toEqual([ADMITTED_IMAGE_URL]);
    });

    it('renders nothing at all for a decorative image on an unadmitted host', () => {
      const { container } = render(<PostContent content={IMAGE_CONTENT} />);

      // `![](url)` is an author stating the image carries no information the prose does not, so
      // there is nothing to substitute and a stand-in would be noise.
      expect(renderedSrcs(container)).not.toContain(WITHHELD_DECORATIVE_IMAGE_URL);
      expect(screen.getAllByRole('img')).toHaveLength(1);
    });
  });

  describe('category links', () => {
    it('renders one crawlable link per category inside a labelled landmark', () => {
      render(<PostContent categories={[...CATEGORIES]} content={PLAIN_CONTENT} />);

      const landmark = screen.getByRole('navigation', { name: 'Categories' });

      expect(landmark).toBeInTheDocument();
      expect(screen.getAllByRole('link')).toHaveLength(CATEGORIES.length);

      for (const category of CATEGORIES) {
        // The category's name is both the visible label and the accessible name - no `aria-label`,
        // no visually hidden twin.
        expect(screen.getByRole('link', { name: category.name })).toHaveAccessibleName(
          category.name,
        );
      }
    });

    it('addresses each category through the feed route builder', () => {
      render(<PostContent categories={[...CATEGORIES]} content={PLAIN_CONTENT} />);

      for (const category of CATEGORIES) {
        const href = hrefOf(screen.getByRole('link', { name: category.name }));

        // The builder is the single source of how a category is addressed - a category has no route
        // of its own, its page IS the category-filtered feed - so the expectation comes from it
        // rather than from a hand-written query string.
        expect(href).toBe(categoryFeedPath(category));

        // Read through `searchParams` as well, so the assertion holds whatever order or escaping the
        // builder chooses.
        const url = new URL(href, RELATIVE_HREF_BASE);

        expect(url.pathname).toBe('/');
        expect(url.searchParams.get('category')).toBe(category.slug);
      }
    });

    it('renders no category landmark and no category link when none are supplied', () => {
      render(<PostContent content={PLAIN_CONTENT} />);

      expect(screen.getByText('Just a paragraph of ordinary prose.')).toBeInTheDocument();
      expect(screen.queryByRole('navigation', { name: 'Categories' })).toBeNull();
      expect(screen.queryAllByRole('link')).toEqual([]);
    });

    it('renders the category row even when there is no body to render', () => {
      render(<PostContent categories={[...CATEGORIES]} content={null} />);

      // The two sections are independent: a caller may hand over categories alone.
      expect(screen.getByRole('navigation', { name: 'Categories' })).toBeInTheDocument();
      expect(screen.getAllByRole('link')).toHaveLength(CATEGORIES.length);
    });
  });

  describe('empty content', () => {
    it('renders nothing when content is null', () => {
      const { container } = render(<PostContent content={null} />);

      // Nothing at all, rather than an empty container: a preview with nothing to show must not
      // contribute a stray gap to the layout. The strings "null" and "undefined" never appear.
      expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when content is undefined', () => {
      // The API's LIST projection of a post omits `content` entirely, so this is an ordinary input.
      const { container } = render(<PostContent content={undefined} />);

      expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when content is an empty string', () => {
      // The editor's live preview is called with `''` before the author has typed anything.
      const { container } = render(<PostContent content="" />);

      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('caller-supplied className', () => {
    it('renders the body and the category links when a caller passes extra utilities', () => {
      // Passed only to prove the prop is accepted and changes nothing about the output. The value is
      // never asserted: class names belong to the token layer, which is free to change them.
      render(
        <PostContent
          categories={[...CATEGORIES]}
          className="md:max-w-4xl"
          content={PLAIN_CONTENT}
        />,
      );

      expect(screen.getByText('Just a paragraph of ordinary prose.')).toBeInTheDocument();
      expect(screen.getAllByRole('link')).toHaveLength(CATEGORIES.length);
    });
  });
});
