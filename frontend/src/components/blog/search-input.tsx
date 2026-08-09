// search-input.tsx - the home feed's free-text search control.
//
// One of the three controls that together satisfy the feed requirement "display
// recent blogs with search, category filters, and pagination". Its siblings are
// category-filter.tsx and src/components/ui/pagination.tsx, and all three share
// one discipline: they own a SLICE of the URL's query string and nothing else.
// This file owns `q`. It also deletes `page`, because a new search invalidates
// the reader's position in the old result set - see DELETING `page` below. It
// never reads or writes `category` or `sort`.
//
// ---------------------------------------------------------------------------
// 1. THE DIVISION OF LABOUR: THE HOOK DEBOUNCES, THIS FILE NAVIGATES
//
// `useDebouncedValue` is generic over its value and knows nothing about search,
// URLs or the API. It returns a value and never navigates. This file takes what
// it returns and performs the URL push. That split is deliberate and load-
// bearing in both directions: the hook stays reusable and unit-testable under
// fake timers, and the navigation policy - which parameter, which router method,
// which no-op guard - lives in the one component that has the context to decide
// it.
//
// So: no `setTimeout` appears in this file, and no `router` call appears in the
// hook. Re-implementing either half collapses the design.
//
// ---------------------------------------------------------------------------
// 2. THE URL IS THE SOURCE OF TRUTH. THIS COMPONENT HOLDS NO RESULTS.
//
// `q`, `category`, `page` and `sort` are search parameters so that every result
// set is linkable, shareable, crawlable and correct under the browser's Back and
// Forward buttons. Nothing here caches a post, a result count or a second copy
// of the effective query.
//
// The one piece of local state is a DRAFT string, and it is not a duplicate of
// the URL - it is the field's uncommitted value, which by definition leads the
// URL by up to one debounce window. Conflating the two is the bug this file is
// most carefully written to avoid, in both directions:
//
//   * Bind one-way from the URL and the field goes dead while typing.
//   * Re-sync the draft whenever it differs from the URL and every keystroke is
//     erased, because the URL legitimately lags the draft mid-window.
//
// The reconciliation therefore keys off neither of those. `syncedQueryRef`
// records the `q` value this component has already accounted for, so a change in
// the URL can be classified as ours (ignore - the draft is already ahead) or
// external (adopt it - the reader pressed Back, or followed a link). See
// RECONCILIATION below.
//
// ---------------------------------------------------------------------------
// 3. NO HTTP. NOT ANYWHERE, NOT EVEN INDIRECTLY.
//
// There is no `fetch`, no `@/lib/api/*` import and no result state. Changing the
// URL IS the mechanism: the server component that owns the feed re-renders for
// the new search parameters and fetches through the API layer, which is the only
// tier permitted to perform HTTP. That is also why searching costs no client
// bundle beyond this control.
//
// Relevance is likewise not this file's business. Ranking is composed in a
// single SQL statement by the backend's post repository - a weighted `tsvector`
// queried with `websearch_to_tsquery` and ordered by `ts_rank`, with a trigram
// fallback on titles. Filtering or re-ordering on the client would silently
// disagree with it and would only ever see one page of rows anyway.
//
// ---------------------------------------------------------------------------
// 4. WHY `'use client'` IS PRESENT HERE AND ABSENT FROM THE PRIMITIVES
//
// The rendering split keeps client islands narrow so that a route does not
// become a client bundle merely because it contains an interactive control. The
// primitives this file uses - Input, Label, Button - are deliberately
// directive-free so Server Components can render them.
//
// This component genuinely cannot be one: it holds state, runs effects, and
// calls `useRouter`, `usePathname` and `useSearchParams`. So the boundary is
// drawn here, at the smallest node that needs it, and nothing heavy is imported
// past it - three primitives, one hook, one class helper and two icons.
//
// CONSUMER REQUIREMENT: `useSearchParams()` forces a client-side read of the
// query string, so a statically prerendered route that renders this component
// must wrap it in a `<Suspense>` boundary. Next.js fails the build otherwise.
// The feed page is the right place for that boundary, not this file - only the
// page knows what to show as a fallback.
//
// ---------------------------------------------------------------------------
// 5. DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT.
//
//   1. `router.push`. Debounced typing would deposit one history entry per
//      pause, so Back would walk the reader backwards through "s", "se", "sea"
//      instead of leaving the feed. `replace` is the only correct method here.
//   2. Omitting `{ scroll: false }`. The default scrolls to the top of the
//      document on navigation, which would yank the viewport away from the
//      results on every keystroke pause.
//   3. A raw `<input>` or `<button>`. Those elements are wrapped exactly once
//      each, in src/components/ui/. Reaching past the primitives here would
//      duplicate the field's focus ring and token palette and let them drift.
//   4. `aria-label` on the field instead of a `<label>`. The accessibility floor
//      is that every form control is ASSOCIATED WITH A LABEL. The label below is
//      visually hidden, not absent, so the accessible name is real text that a
//      `<label>` supplies and a translation layer can reach.
//   5. A hardcoded `id`. Two search controls on one page would collide, and the
//      collision would silently break `htmlFor`. `useId()` cannot collide.
//   6. Restating the field's border, ring, placeholder or surface colours. The
//      Input primitive owns all four, and it already ships `w-full` and
//      `min-w-0`. Everything this file adds is structural: the two paddings that
//      make room for the adornments, and the adornments' own placement.
//   7. A `dark:` variant. Every token used below is dual-valued in
//      src/app/globals.css, so the control re-themes with no branching here.
//   8. A `@media` query or a custom breakpoint. The control is width-agnostic and
//      fills its container; the feed layout owns the widths.
//   9. Any analytics, experiment or feature-flag call. Instrumentation is out of
//      scope for this product, and a search box is exactly where it would creep
//      in first.
//  10. A heading of any level. This is a control inside the feed's own heading
//      outline, and emitting an `h2` here would corrupt that outline.
//  11. Importing this file into src/components/layout/site-header.tsx. It is
//      bound to the FEED's `q` parameter, so in a globally rendered header it
//      would rewrite the query string of every route in the product - and would
//      widen the client boundary onto all of them.
//  12. A literal colour, length, radius or shadow. Every value resolves to a
//      token; the only literals present are `none` and `0`, two of the six the
//      project permits.

'use client';

// No default `React` import: `"jsx": "react-jsx"` means the compiler imports the
// runtime itself, so a default import would be unused - and `npm run lint` runs
// with `--max-warnings=0`, which turns an unused import from a warning into a
// failed gate. `ComponentProps` is likewise absent: it is referenced in prose on
// SearchInputProps but never in a type position, so importing it would fail the
// same gate.
import type { FormEvent, JSX } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Search, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { MAX_SEARCH_TERM_LENGTH } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * The search-term parameter this control owns.
 *
 * Named once as a constant rather than written as a string at each of the five
 * places it appears, because it is a contract with three other modules - the
 * feed page that reads it, the API wrapper that forwards it as `q`, and the
 * backend router that declares it. A typo in any one of them produces a control
 * that silently searches nothing, with no type error to catch it.
 */
const QUERY_PARAM = 'q';

/**
 * The pagination parameter, deleted on every committed search.
 *
 * Owned by the pagination control, not by this one - which is exactly why it is
 * only ever DELETED here and never read or set. See DELETING `page` on
 * {@link SearchInput}.
 */
const PAGE_PARAM = 'page';

/**
 * Fallback accessible name for the field.
 *
 * A default rather than a required prop: every call site wants the same name, and
 * a required prop invites a caller in a hurry to pass something terse. It is
 * overridable because a second search surface - an author's own post list, say -
 * needs a name that distinguishes it.
 */
const DEFAULT_LABEL = 'Search posts';

/**
 * Fallback placeholder.
 *
 * Deliberately not the same string as {@link DEFAULT_LABEL}. A placeholder
 * disappears the moment the field has content and is not exposed reliably as an
 * accessible name, so it is a hint about what to type, while the label states
 * what the control is. Making them identical would waste the hint and tempt a
 * future reader into deleting the label as redundant.
 */
const DEFAULT_PLACEHOLDER = 'Search posts by title or content';

/**
 * Props for {@link SearchInput}.
 *
 * Module-local by design. The public surface of this file is the single
 * `SearchInput` component, matching the convention of the primitives it consumes;
 * a caller that needs the type derives it with
 * `ComponentProps<typeof SearchInput>`, which cannot fall out of step with this
 * declaration.
 */
interface SearchInputProps {
  /**
   * Hint text shown while the field is empty.
   *
   * @defaultValue {@link DEFAULT_PLACEHOLDER}
   */
  placeholder?: string;

  /**
   * The field's visible-to-assistive-technology name.
   *
   * Rendered into a real `<label>` that is visually hidden, so it is the
   * control's accessible name. Keep it a noun phrase describing the control
   * ("Search posts"), not an instruction ("Type to search") - it is announced
   * every time focus enters the field.
   *
   * @defaultValue {@link DEFAULT_LABEL}
   */
  label?: string;

  /**
   * Quiet period, in milliseconds, before a settled search term is pushed into
   * the URL.
   *
   * Exposed rather than fixed so tests can collapse the wait: a component test
   * drives it with fake timers, and an end-to-end journey can pass a small value
   * instead of sleeping. Left at the hook's own 300ms default when omitted,
   * which is the conventional search-as-you-type window.
   *
   * Pressing Enter and clearing the field both bypass this entirely - see
   * {@link SearchInput}.
   *
   * @defaultValue 300 (the default of `useDebouncedValue`)
   */
  delayMs?: number;

  /**
   * Extra classes for the form element that wraps the control.
   *
   * Merged last through `cn`, so a caller's utility reliably wins its Tailwind
   * group. This is the supported way for the feed layout to place the control -
   * a column span, a max width, a margin - without this file knowing anything
   * about the page around it.
   */
  className?: string;
}

/**
 * The home feed's free-text search field.
 *
 * Renders a labelled search box that writes its settled term into the URL's `q`
 * parameter. It performs no request of its own: the feed's Server Component
 * re-renders for the new parameters and fetches the ranked results.
 *
 * @example The feed's own use. The Suspense boundary is required, because
 * `useSearchParams` forces a client-side read of the query string.
 * ```tsx
 * <Suspense fallback={<Skeleton className="h-11 w-full" />}>
 *   <SearchInput />
 * </Suspense>
 * ```
 *
 * ### What a committed search does to the query string
 *
 * Exactly three things, and it is the third that is easiest to get wrong:
 *
 * 1. **Sets `q`** to the trimmed term, or **deletes it outright** when the term
 *    is empty. Never `?q=` - an empty parameter is a second, distinct URL for an
 *    identical result set, which for a crawlable page means duplicate content.
 * 2. **Deletes `page`.** A new term produces a new, shorter result set, so the
 *    reader's old position in it is meaningless - keeping `page=5` while
 *    searching a two-page result would strand them on an empty screen. Deleting
 *    rather than writing `page=1` matches the pagination control, which omits
 *    the parameter for the first page, so the two agree on one canonical shape
 *    for "page one".
 * 3. **Preserves everything else** - `category`, `sort`, and any parameter added
 *    later - by building from a copy of the current parameters instead of a fresh
 *    `URLSearchParams`. This is the most likely cross-component defect in the
 *    feed: clobbering a sibling control's state is invisible in isolation and
 *    only shows up when both controls are used together.
 *
 * ### Three ways a term is committed, two of which skip the debounce
 *
 * | Trigger | Path |
 * | --- | --- |
 * | Typing | Debounced. Commits once the field has been still for `delayMs`. |
 * | Enter | Immediate. The reader has explicitly asked, so waiting is wrong. |
 * | Clear | Immediate, and returns focus to the field. |
 *
 * ### Why navigation cannot loop, and why mounting is silent
 *
 * Two guards, and both are needed. The commit effect acts only when the debounced
 * value has caught up with the live draft, so a stale in-flight value can never
 * be pushed - which is what would otherwise undo a Back-button reconciliation a
 * moment after it landed. And `commit` compares the query string it built against
 * the current one and returns without navigating when they match, so arriving on
 * `?q=react` neither re-pushes that term nor - importantly - strips a
 * deep-linked `page` from a URL the reader was sent.
 *
 * @param props - See {@link SearchInputProps}.
 * @returns A search landmark containing the labelled field and its adornments.
 */
export function SearchInput({
  placeholder = DEFAULT_PLACEHOLDER,
  label = DEFAULT_LABEL,
  delayMs,
  className,
}: SearchInputProps): JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /*
   * The active term according to the URL - the authority this component
   * reconciles against.
   *
   * Derived on every render rather than stored, and normalised from `null` to
   * `''` so that "absent" and "empty" are one state throughout this file. It is a
   * plain string, which is why the effects below depend on IT rather than on
   * `searchParams`: the params object is a new instance whenever ANY parameter
   * changes, so depending on it would re-run this component's effects when the
   * reader changed the category or turned the page. Depending on the string means
   * they re-run only when the search term itself moves.
   */
  const urlQuery = searchParams.get(QUERY_PARAM) ?? '';

  /*
   * A collision-proof id, generated rather than written down, so two search
   * controls can coexist on one page without silently breaking each other's
   * `htmlFor` association.
   */
  const fieldId = useId();

  /*
   * A handle on the field, used for exactly one thing: restoring focus after the
   * clear button removes itself. See `handleClear`.
   */
  const fieldRef = useRef<HTMLInputElement>(null);

  /*
   * The field's uncommitted value.
   *
   * Seeded from the URL so a reader arriving on a shared link sees the term that
   * produced the results in front of them, rather than an empty box. This is the
   * component's only state, and it is not a copy of the URL - it is what the URL
   * has not caught up with yet.
   */
  const [draft, setDraft] = useState(urlQuery);

  /*
   * The `q` value this component has already accounted for.
   *
   * The whole of the reconciliation logic, and the reason it is a ref rather than
   * state: it is bookkeeping that must not itself trigger a render, and it must be
   * readable by an effect without becoming one of its dependencies.
   *
   * It is written in two places - by `commit` when this component moves the URL,
   * and by the reconciliation effect when something else does. Comparing the URL
   * against it is what distinguishes those two cases, and no other comparison can:
   *
   *   * Against `draft`: wrong. Mid-window the draft legitimately leads the URL,
   *     so this would fire on every keystroke and erase what is being typed.
   *   * Against the previous URL value alone: wrong. That cannot tell this
   *     component's own push apart from a Back-button navigation, and adopting our
   *     own push would be harmless only by luck.
   */
  const syncedQueryRef = useRef(urlQuery);

  /*
   * Whether the draft holds an edit the READER made that has not been committed.
   *
   * The primary gate on navigation, and the one guarantee that no comparison of
   * `draft`, `debouncedDraft` and `urlQuery` can provide on its own. Set only by
   * the field's own change handler; cleared the moment the intent is acted on, and
   * cleared by the reconciliation effect because a draft that came from the URL is
   * not something to push back at it.
   *
   * FOUND BY TEST, and worth stating plainly because the failure mode is subtle.
   * When an external navigation lands, the reconciliation effect resets the draft -
   * but effects in that same commit pass still observe the PREVIOUS render's
   * `draft` and `debouncedDraft`. Those two are equal to each other, so a
   * "has it settled" check is satisfied, and they differ from the new `urlQuery`,
   * so a "does it differ from the URL" check is satisfied too. Both guards pass
   * and the stale term is pushed straight back over the reader's Back button.
   * That is the navigation loop this design has to prevent, and it is only
   * preventable by tracking WHERE the draft came from rather than what it holds.
   */
  const hasUncommittedEditRef = useRef(false);

  /*
   * The draft, re-emitted once it has held still. `delayMs` is passed through
   * undefined when the caller omits it, so the hook applies its own 300ms default
   * rather than this file declaring a second one that could drift from it.
   */
  const debouncedDraft = useDebouncedValue(draft, delayMs);

  /**
   * Write a term into the URL, or return without navigating if it is already
   * there.
   *
   * The single place this component mutates the query string. Both immediate
   * paths - Enter and Clear - call it directly, and the debounced path calls it
   * from the commit effect, so the three-step contract documented on
   * {@link SearchInput} is declared exactly once.
   */
  const commit = useCallback(
    (rawValue: string): void => {
      const nextQuery = rawValue.trim();

      // A COPY, never a fresh `URLSearchParams`. This is what preserves
      // `category`, `sort` and anything added to the feed later.
      const nextParams = new URLSearchParams(searchParams.toString());

      if (nextQuery) {
        nextParams.set(QUERY_PARAM, nextQuery);
      } else {
        // Deleted, not set to `''`. A trailing `?q=` would be a distinct
        // crawlable URL for the unfiltered feed.
        nextParams.delete(QUERY_PARAM);
      }

      // Unconditional: any committed term invalidates the reader's page position.
      nextParams.delete(PAGE_PARAM);

      // Recorded BEFORE the guard below, and correct on both branches. If the
      // guard returns, the URL already carries this term, so the ref matches the
      // URL either way - and leaving it stale on the no-op branch would make the
      // reconciliation effect mistake this component's own state for an external
      // navigation on the very next render.
      syncedQueryRef.current = nextQuery;

      const nextSearch = nextParams.toString();

      // The no-op guard. Without it, mounting on a URL that already carries a
      // term would fire a pointless `replace`, and that replace would in turn
      // re-run the effects that produced it.
      if (nextSearch === searchParams.toString()) {
        return;
      }

      // `replace`, not `push`: see DELIBERATELY ABSENT #1 at the top of the file.
      // The conditional keeps the URL clean when no parameter survives, so
      // clearing the only term lands on `/` rather than on `/?`.
      router.replace(nextSearch ? `${pathname}?${nextSearch}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  /*
   * RECONCILIATION: adopt a term that arrived from outside this component.
   *
   * Back, Forward, or a link into the feed carrying a different `q`. Any of those
   * changes the URL without going through `commit`, and the field has to follow or
   * it would keep displaying a term that no longer produced the results below it.
   *
   * The guard is what makes this safe to run on every change of `urlQuery`: when
   * the new value is one this component just pushed, the ref already holds it and
   * the effect does nothing, leaving the draft - which may already have moved on -
   * untouched.
   */
  useEffect(() => {
    if (urlQuery === syncedQueryRef.current) {
      return;
    }

    syncedQueryRef.current = urlQuery;
    setDraft(urlQuery);

    // The draft now mirrors the URL, so there is nothing of the reader's left to
    // push. Clearing this is what stops the commit effect - which in this same
    // pass still sees the pre-reset draft - from pushing the old term back over
    // the navigation that just landed.
    hasUncommittedEditRef.current = false;
  }, [urlQuery]);

  /*
   * COMMIT ON SETTLE: push the term once typing stops.
   *
   * Both guards are load-bearing, and neither is a micro-optimisation.
   *
   * The first is the definition of "settled". `debouncedDraft` trails `draft` by
   * up to one window, so while they differ it holds a PREVIOUS keystroke. Acting
   * on that is not merely premature - it is the navigation loop this design has
   * to avoid: immediately after a Back-button reconciliation the draft has been
   * reset but the debounced value is still the old term, and pushing it would
   * undo the reader's own navigation a fraction of a second after it happened.
   *
   * The second suppresses work that would change nothing: the term the URL
   * already carries, re-entered whitespace, or the initial render of a shared
   * link. `commit` re-checks the same thing against the whole query string, but
   * this check is the semantic one - it is what makes mounting on `?q=x&page=3`
   * silent, and therefore what keeps a deep-linked page from being stripped out
   * from under the reader.
   *
   * The third makes the push IDEMPOTENT, and it guards a different fact from the
   * second. `urlQuery` answers "what does the authority currently say"; the ref
   * answers "what have we already asked for". Those differ for the interval
   * between calling `replace` and the router reporting the new parameters, and
   * any re-render inside that interval - a parent's state change, a sibling
   * control - would re-run this effect while the second guard was still
   * satisfied, re-pushing an href already in flight. Found by test: without this,
   * a re-render before the URL lands produces repeat navigations.
   */
  useEffect(() => {
    // 1. Intent. Only a reader's edit may move the URL.
    if (!hasUncommittedEditRef.current) {
      return;
    }

    // 2. Settled. `debouncedDraft` trails `draft` by up to one window, so while
    //    they differ it still holds a previous keystroke. Keep the intent pending
    //    and wait - this is the debounce doing its job.
    if (debouncedDraft !== draft) {
      return;
    }

    const settled = debouncedDraft.trim();

    // The intent is now being acted on, so consume it either way. Doing this
    // before the two no-op checks matters: an edit that resolves to the term
    // already in the URL is genuinely handled, not still outstanding.
    hasUncommittedEditRef.current = false;

    // 3. Semantic no-op. The URL already says this - typing "reac" back to
    //    "react", or adding trailing whitespace.
    if (settled === urlQuery) {
      return;
    }

    // 4. Idempotency. We already asked for this and the router has not reported
    //    it yet, so asking again would duplicate an href still in flight.
    if (settled === syncedQueryRef.current) {
      return;
    }

    commit(debouncedDraft);
  }, [commit, debouncedDraft, draft, urlQuery]);

  /**
   * Search immediately on Enter.
   *
   * `preventDefault` stops the browser's own GET navigation, which would reload
   * the document and - because only named fields are submitted - would drop the
   * category and sort parameters. Committing here instead keeps the reader on the
   * client-side route with every parameter intact.
   */
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      // Acted on now, so the pending debounce must not act on it again.
      hasUncommittedEditRef.current = false;
      commit(draft);
    },
    [commit, draft],
  );

  /**
   * Empty the field and drop the term at once.
   *
   * Deliberately does not wait out the debounce: clearing is an explicit
   * instruction, and a cleared box sitting above stale filtered results for
   * another 300ms reads as a bug.
   *
   * The focus call is the accessibility half, and it is not decorative. The clear
   * button unmounts the instant the draft empties, and focus on a removed element
   * falls to `<body>` - which drops a keyboard reader out of the control they were
   * operating and back to the top of the document. Moving focus to the field first
   * keeps them exactly where they were, ready to type a new term.
   */
  const handleClear = useCallback((): void => {
    setDraft('');
    // Same reasoning as submit: the term is dropped now, so a debounce still in
    // flight from the reader's last keystroke has nothing left to commit.
    hasUncommittedEditRef.current = false;
    commit('');
    fieldRef.current?.focus();
  }, [commit]);

  return (
    // `role="search"` promotes the form to a search landmark, so assistive
    // technology can jump straight to it. Not redundant with the implicit `form`
    // role, and invisible - it changes nothing about the rendering.
    //
    // `w-full` and nothing else: the control fills whatever the feed gives it.
    // There is no fixed width, no breakpoint variant and no media query here,
    // because a control does not reflow - its container does.
    <form className={cn('w-full', className)} onSubmit={handleSubmit} role="search">
      {/*
       * A real <label>, visually hidden rather than omitted. `sr-only` is the
       * token engine's own built-in utility, so the field's accessible name is
       * genuine label text - reachable by a translation layer and overridable by
       * the caller - instead of an invented `aria-label`.
       */}
      <Label className="sr-only" htmlFor={fieldId}>
        {label}
      </Label>

      {/* The positioning context for the two adornments. `relative` is the only
       * class it needs; the field inside already brings `block w-full`. */}
      <div className="relative">
        {/*
         * Decorative, and named as such. `aria-hidden` is explicit rather than
         * left to the icon library's default, and the glyph carries no title and
         * no accessible name - the label above already names the control, and a
         * second name here would be announced as a separate object.
         *
         * Centred with `inset-y-0 my-auto`, which are the engine's LOGICAL
         * `inset-block` and `margin-block` - no physical `top`, and no transform
         * arithmetic to get wrong. `pointer-events-none` keeps the click target on
         * the field, so tapping the icon focuses the input rather than doing
         * nothing. `size-4` sizes it from the spacing scale and overrides the
         * library's own width/height attributes.
         */}
        <Search
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute inset-y-0 start-3 my-auto size-4"
        />

        <Input
          // `type="search"` for the correct semantics: the field takes the
          // `searchbox` role, and mobile keyboards offer a search key.
          type="search"
          id={fieldId}
          // Matches the URL parameter. It also means that if Enter is pressed in
          // the brief window before hydration attaches `onSubmit`, the browser's
          // own submit still performs the search the reader asked for - degraded,
          // since a native submit carries only named fields and so loses the
          // category and sort parameters, but better than navigating with no term
          // at all.
          name={QUERY_PARAM}
          ref={fieldRef}
          value={draft}
          onChange={(event) => {
            // The ONLY place reader intent is raised. Everything downstream keys
            // off this, which is what keeps a URL-originated draft from being
            // pushed back at the URL.
            hasUncommittedEditRef.current = true;
            setDraft(event.target.value);
          }}
          placeholder={placeholder}
          // The service's own bound, mirrored at the one control that can honour
          // it before a request exists. `MAX_SEARCH_TERM_LENGTH` is the number
          // `backend/app/schemas/common.py` enforces and publishes as `maxLength`
          // on the `q` parameter, and the service refuses a longer term with a
          // 422 rather than truncating it. Capping the field is what keeps that
          // refusal unreachable from this control: the reader simply cannot type
          // past it, so there is no error state to render and no request to spend.
          // It bounds the pasted case too, which is the only realistic way a
          // reader reaches 256 characters.
          maxLength={MAX_SEARCH_TERM_LENGTH}
          // A search box has nothing to autofill from, and a browser dropdown
          // over the results would obscure them.
          autoComplete="off"
          enterKeyHint="search"
          // `invalid` is deliberately not passed. This control validates nothing -
          // any string is a legitimate search, including one that matches no post,
          // which is an empty result and not an error.
          className={cn(
            // Room for the two adornments, in logical properties. Both paddings
            // are constant rather than conditional on the clear button's presence,
            // so the text does not shift sideways the moment the reader types
            // their first character.
            //
            // Measured against the primitives: the icon occupies 12px to 28px, so
            // `ps-9` (36px) clears it; the clear button is a 44px square inset 4px
            // from the trailing edge, so `pe-13` (52px) clears that. These
            // override the field's own `px-3` deterministically - the engine emits
            // `padding-inline` before `padding-inline-start`/`-end`, so the more
            // specific pair wins.
            'ps-9 pe-13',

            // WebKit and Chrome draw their OWN clear affordance inside a search
            // field, and the engine's preflight resets only
            // `::-webkit-search-decoration`, not this one. Left alone it would sit
            // beside the button below as a second, unlabelled, unthemed "x" that
            // no keyboard can reach. `hidden` is `display: none`, and `none` is one
            // of the six literals the token rule permits.
            '[&::-webkit-search-cancel-button]:hidden',
          )}
        />

        {/*
         * Rendered only when there is something to clear, so the field is
         * uncluttered at rest.
         *
         * The control is a 44x44 square - the WCAG 2.5.5 target-size floor, and the
         * size this control has to be: no design source exists for this project
         * (zero attachments, zero Figma frames), so nothing authorises a smaller
         * target and the accessible minimum governs. The 32px `sm` size exists for
         * the dense admin row actions and is explicitly opt-in for them; a search
         * field on a 375px viewport is the opposite case, a primary reader-facing
         * affordance touched with a thumb.
         *
         * The square is composed rather than served by a fourth Button size. The
         * size table is `sm` / `default` / `lg`, and the default variant is
         * `h-11 px-5`, so `w-11 px-0` drops the inline padding and matches the
         * width to the height - the 44x44 box an icon-only control needs, which is
         * the composition that table prescribes. `[&_svg]:size-5` raises the glyph
         * from the primitive's 16px default to the 20px a lone glyph needs inside a
         * 44px box, and `tailwind-merge` resolves both against the variant's own
         * `px-5` and `[&_svg]:size-4` in this file's favour, so the result is one
         * class per property rather than a specificity fight. Every one of them is
         * a token utility; none is a literal.
         *
         * The geometry is what makes a 44px control fit inside a 44px field without
         * swallowing it. `rounded-full` plus `end-1` keeps the field's trailing
         * border and its rounded corner fully visible - the circle is inset one
         * spacing step from that edge and only tangent to the top and bottom
         * borders, so the field still reads as a field rather than as a button with
         * a text area attached. `inset-y-0 my-auto` centres the square in the
         * field's own height, and the input's `pe-13` above reserves 52px so the
         * search term can never run underneath it.
         *
         * The affordance is still not the only way to clear the term - selecting
         * the text and deleting it reaches the same state through the field itself.
         * That is a fallback, not a justification for a small target.
         */}
        {draft.length > 0 ? (
          <Button
            className="absolute inset-y-0 end-1 my-auto w-11 rounded-full px-0 [&_svg]:size-5"
            onClick={handleClear}
            variant="ghost"
          >
            <X aria-hidden="true" />
            {/*
             * The accessible name, as real text rather than an `aria-label`.
             * `sr-only` takes it out of flow, so it contributes nothing to the
             * button's width and no phantom flex gap, while still being the
             * name assistive technology announces and the name the component
             * tests query by.
             */}
            <span className="sr-only">Clear search</span>
          </Button>
        ) : null}
      </div>
    </form>
  );
}
