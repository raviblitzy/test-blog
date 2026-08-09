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
