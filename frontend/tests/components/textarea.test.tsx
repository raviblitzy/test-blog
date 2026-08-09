/**
 * `Textarea` - component tests for the design system's multi-line text field.
 *
 * ---------------------------------------------------------------------------
 * UNIT UNDER TEST
 *
 * `@/components/ui/textarea`, whose sole export is `Textarea`. It is one of the
 * fifteen primitives under src/components/ui/ that ARE this project's design
 * system, and - because the behavioural-primitive library ships no textarea at
 * all - it is the single place a raw `<textarea>` is wrapped for the whole
 * product. Everything an author or a reader ever writes reaches the DOM through
 * it: a post's excerpt and its Markdown body (src/components/blog/
 * post-editor.tsx), a comment body (src/components/blog/comment-form.tsx) and a
 * category description (src/components/admin/category-form.tsx).
 *
 * That makes its pass-through contract, not its appearance, the thing worth
 * covering. `register()` from react-hook-form returns `{ name, onChange, onBlur,
 * ref }` and every one of those four callers spreads that object onto this
 * component; if any of the four were intercepted, renamed or defaulted, every
 * form in the product would stop validating with no type error to catch it. Four
 * of the cases below exist for exactly that: `name` reflection, `onChange`,
 * `onBlur` and `ref` forwarding.
 *
 * ---------------------------------------------------------------------------
 * NO CLASS-NAME OR STYLE ASSERTIONS. THIS IS DELIBERATE - PLEASE KEEP IT SO.
 *
 * The primitive's whole visual contribution is a token-derived class string: it
 * imports `FIELD_CONTROL_CLASSES` and `FIELD_INVALID_CLASSES` from
 * `./input` so the field family cannot drift, then adds a `block` display mode,
 * a `min-h-24` floor, `py-2.5` of vertical padding, `resize-y` and a
 * `placeholder:` colour. Every one of those is a value the token layer owns and
 * is free to change - a palette edit, a spacing-scale change or a rename of a
 * semantic token must not turn this file red.
 *
 * So there is no `toHaveClass` anywhere below, no read of `className`, no
 * class-based `querySelector`, no `getComputedStyle` and no snapshot. The
 * minimum height and the single-axis resize affordance are NOT asserted either,
 * on two independent grounds: they are token values, and jsdom performs no
 * layout, so any assertion about them would be measuring the test environment
 * rather than the component. Their correctness is a visual concern, verified at
 * the three viewports by tests/e2e/, not here.
 *
 * What is asserted instead is behaviour and accessible semantics: the role the
 * field exposes, the name a real `<label>` gives it, the attributes that reach
 * the element, the handlers that fire, and the `aria-invalid` state that carries
 * a validation failure to assistive technology rather than leaving it implied by
 * a red border.
 *
 * ---------------------------------------------------------------------------
 * TEST-ENVIRONMENT CONTRACT
 *
 *  - The jest-dom matchers and the between-test `cleanup()` are registered ONCE,
 *    by frontend/vitest.setup.ts. Neither is re-imported or re-registered here;
 *    a second registration is at best redundant and at worst masks a broken
 *    bootstrap.
 *  - The Vitest API is IMPORTED rather than taken from the globals
 *    `vitest.config.ts` enables. frontend/tsconfig.json includes `**\/*.tsx`, so
 *    this file is part of the `tsc --noEmit` program, and leaning on the globals
 *    would fail that gate with TS2593/TS2304 even while passing at runtime.
 *  - `@testing-library/user-event` is NOT a declared dependency of this tier, so
 *    interaction is driven with `fireEvent`. Where that distinction changes what
 *    can honestly be asserted - the disabled case - the reasoning is recorded at
 *    the case itself.
 *  - No HTTP. `Textarea` performs none, so this file starts no Mock Service
 *    Worker server and imports no handler; tests/msw/handlers.ts is context for
 *    the specs that do.
 */

import { useEffect, useRef, type ChangeEvent } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Textarea } from '@/components/ui/textarea';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * Blog-domain field names throughout - `body`, `excerpt`, `content`,
 * `description`. The demonstration resource this repository used to expose was
 * retired rather than migrated, and the API contract requires it to be provably
 * gone from every tier, so none of its paths, types or field names appears
 * anywhere in this file - not even in a fixture, where a stray reference would
 * survive a search meant to prove the retirement.
 *
 * Each string is bound to a constant rather than repeated at the render and the
 * assertion, so a typo cannot make a case pass for the wrong reason.
 */

/** The `id` a comment field carries, and the `htmlFor` its label points at. */
const BODY_FIELD_ID = 'body';

/** The visible label text, and therefore the field's accessible name. */
const BODY_FIELD_LABEL = 'Comment';

/** A controlled post body, as `post-editor.tsx` holds it in form state. */
const ORIGINAL_CONTENT = 'The original Markdown body of the post.';

/** What that controlled body becomes after one edit. */
const EDITED_CONTENT = 'The edited Markdown body of the post.';

/** An uncontrolled starting value, as the edit route seeds an excerpt. */
const DRAFT_EXCERPT = 'A short standfirst that introduces the draft.';

/** The hint a category description field shows while empty. */
const DESCRIPTION_PLACEHOLDER = 'Describe what belongs in this category';

/* -------------------------------------------------------------------------- */
/* Ref-forwarding probe                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A minimal consumer that holds a `useRef` and reports what the ref points at
 * once the tree has mounted.
 *
 * Declared at module scope, not inside the `it` that renders it, and it reads
 * `ref.current` from an effect rather than from the render body. Both are
 * required rather than stylistic: the lint gate runs the React Compiler rule set
 * with `react-hooks/static-components`, `react-hooks/refs`, `react-hooks/purity`
 * and `react-hooks/globals` all at error level, so a component defined inside
 * another function, a ref read during render, or a write to an outer binding
 * during render would each fail `npm run lint`.
 *
 * The effect is also the honest place to look. `ref.current` is `null` while the
 * render body runs and is only populated when React commits, which is measurably
 * true here - so an assertion made any earlier would read `null` and say nothing
 * about the component. Reading after commit is exactly what `react-hook-form`
 * does when it focuses the first invalid field.
 */
function RefProbe({ onMounted }: { onMounted: (node: HTMLTextAreaElement | null) => void }) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    onMounted(fieldRef.current);
  }, [onMounted]);

  return <Textarea ref={fieldRef} />;
}

/* -------------------------------------------------------------------------- */
/* Cases                                                                      */
/* -------------------------------------------------------------------------- */

describe('Textarea', () => {
  it('renders a textbox that a real label can name', () => {
    render(
      <>
        <label htmlFor={BODY_FIELD_ID}>{BODY_FIELD_LABEL}</label>
        <Textarea id={BODY_FIELD_ID} />
      </>,
    );

    // The role is what assistive technology and `getByRole` both navigate by. A
    // <textarea> earns `textbox` from the platform, which is the point of
    // wrapping the native element instead of building a field out of a div.
    const byRole = screen.getByRole('textbox');
    expect(byRole).toBeInTheDocument();

    // `getByLabelText` resolves through the accessibility tree, so it succeeds
    // ONLY when the htmlFor/id association is real. It is therefore the
    // assertion, not a convenience query - the primitive deliberately invents no
    // `aria-label` of its own, precisely so that a visible label is the single
    // source of a field's name.
    expect(screen.getByLabelText(BODY_FIELD_LABEL)).toBe(byRole);

    // And the name is readable as such, which is what a screen reader announces.
    expect(byRole).toHaveAccessibleName(BODY_FIELD_LABEL);
  });

  it('passes rows through to the element', () => {
    // A long-form body field asks for room; the primitive holds no `rows`
    // default of its own, so whatever the caller passes must survive the spread.
    render(<Textarea rows={8} />);

    expect(screen.getByRole('textbox')).toHaveAttribute('rows', '8');
  });

  it('is discoverable by its placeholder', () => {
    render(<Textarea placeholder={DESCRIPTION_PLACEHOLDER} />);

    expect(screen.getByPlaceholderText(DESCRIPTION_PLACEHOLDER)).toBe(screen.getByRole('textbox'));
  });

  it('reports each edit to onChange with the new value, and stays controlled', () => {
    /*
     * The value is captured INSIDE the handler, which is not incidental. A
     * controlled field whose parent does not update state has its DOM value
     * restored by React once the event has been dispatched - measured here: the
     * handler observes the edited text while the element afterwards reads back
     * the original. Reaching into `onChange.mock.calls` after the fact would
     * therefore read the restored value and the case would flake for a reason
     * having nothing to do with `Textarea`.
     *
     * An array, compared whole, rather than an indexed read: `tsconfig.json`
     * sets `noUncheckedIndexedAccess`, so `observed[0]` is `string | undefined`
     * and asserting on it would need a non-null assertion to typecheck.
     */
    const observed: string[] = [];
    const onChange = vi.fn((event: ChangeEvent<HTMLTextAreaElement>) => {
      observed.push(event.target.value);
    });

    render(<Textarea value={ORIGINAL_CONTENT} onChange={onChange} />);
    const field = screen.getByRole('textbox');
    expect(field).toHaveValue(ORIGINAL_CONTENT);

    fireEvent.change(field, { target: { value: EDITED_CONTENT } });

    // The handler ran exactly once and carried the edit. This is the half of
    // `register()` that feeds every keystroke into form state.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([EDITED_CONTENT]);

    // And the element still shows the prop, because the parent never updated it.
    // That is the definition of a controlled field, and it proves the primitive
    // keeps no value state of its own behind the caller's back.
    expect(field).toHaveValue(ORIGINAL_CONTENT);
  });

  it('renders an uncontrolled defaultValue', () => {
    // The edit route seeds a saved excerpt this way, letting the browser own the
    // value until the form reads it back on submit.
    render(<Textarea defaultValue={DRAFT_EXCERPT} />);

    expect(screen.getByRole('textbox')).toHaveValue(DRAFT_EXCERPT);
  });

  it('forwards onBlur', () => {
    /*
     * Not padding. `react-hook-form`'s default validation mode is `onTouched`,
     * and every mode other than `onChange` decides when to validate from the
     * blur event, so a swallowed `onBlur` would silently disable validation on
     * the comment form and the post editor alike - with the field still looking
     * and behaving correctly.
     */
    const onBlur = vi.fn();

    render(<Textarea onBlur={onBlur} />);
    fireEvent.blur(screen.getByRole('textbox'));

    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it('marks itself disabled and stops answering pointer interaction', () => {
    /*
     * WHY THIS CASE DOES NOT DRIVE `fireEvent.change`, THOUGH THAT LOOKS LIKE
     * THE OBVIOUS SHAPE FOR IT.
     *
     * Measured, not assumed: `fireEvent.change` on a DISABLED textarea DOES
     * reach `onChange`. `fireEvent` constructs an event and calls
     * `dispatchEvent`, and neither jsdom's dispatch nor React's synthetic
     * delivery gates that on `disabled` - React suppresses only the mouse family
     * (`onClick`, `onMouseDown`, `onMouseUp`, `onDoubleClick`) on a disabled form
     * control. So asserting that a disabled field never reports a change would
     * record something about the browser platform that is simply untrue, and it
     * would fail. `@testing-library/user-event`, which models a real user's
     * blocked keystroke, is not a declared dependency of this tier, so no
     * keyboard-level equivalent is available.
     *
     * What IS asserted is the pair of guarantees the platform genuinely makes
     * and that a user actually experiences: the field reports itself disabled to
     * the accessibility tree, and it answers no pointer interaction. The
     * enabled counterpart is asserted alongside so the case cannot pass merely
     * because the handlers were never wired up.
     */
    const onClick = vi.fn();
    const onMouseDown = vi.fn();

    const { unmount } = render(<Textarea disabled onClick={onClick} onMouseDown={onMouseDown} />);
    const disabledField = screen.getByRole('textbox');

    expect(disabledField).toBeDisabled();
    expect(disabledField).toHaveAttribute('disabled');

    fireEvent.click(disabledField);
    fireEvent.mouseDown(disabledField);

    expect(onClick).not.toHaveBeenCalled();
    expect(onMouseDown).not.toHaveBeenCalled();

    // The control case. Same component, same handlers, `disabled` removed - so a
    // silent regression that dropped every pointer handler could not hide behind
    // the two negative assertions above.
    unmount();
    render(<Textarea onClick={onClick} onMouseDown={onMouseDown} />);
    const enabledField = screen.getByRole('textbox');

    expect(enabledField).toBeEnabled();

    fireEvent.click(enabledField);
    fireEvent.mouseDown(enabledField);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onMouseDown).toHaveBeenCalledTimes(1);
  });

  it('reflects readOnly, required, maxLength and name on the element', () => {
    /*
     * The four native attributes the product's forms actually rely on. `name` is
     * the one that matters most: it is part of what `register()` spreads, so a
     * primitive that dropped it would post a form with no field name and break
     * every submission while looking entirely correct on screen.
     */
    render(<Textarea readOnly required maxLength={500} name={BODY_FIELD_ID} />);
    const field = screen.getByRole('textbox');

    // A read-only field is still focusable and still in the accessibility tree -
    // it is not the same state as `disabled` - so the attribute itself is the
    // assertion.
    expect(field).toHaveAttribute('readonly');

    // `toBeRequired` reads the accessibility tree rather than the raw attribute,
    // which is the level a screen reader announces the constraint at.
    expect(field).toBeRequired();

    // The comment length bound the API also enforces on write.
    expect(field).toHaveAttribute('maxlength', '500');

    expect(field).toHaveAttribute('name', BODY_FIELD_ID);
  });

  it('mirrors invalid into aria-invalid', () => {
    /*
     * The critical case, and the reason `invalid` is a prop at all rather than a
     * class the caller applies. A field styled red by hand announces nothing:
     * colour cannot be the only signal a validation failure is carried by, so
     * the same boolean that reaches the danger token must also reach the
     * accessibility tree. Nothing about the border is asserted here - only the
     * attribute, which is the half a screen-reader user perceives.
     */
    render(<Textarea invalid />);

    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
  });

  it('leaves aria-invalid off a field that is not invalid', () => {
    /*
     * The other direction, and it has to be asserted separately: a component
     * that hardcoded `aria-invalid="true"` would pass the case above and be
     * badly wrong, permanently announcing every field in the product as
     * erroneous.
     *
     * The attribute is expected ABSENT rather than `"false"`. That is the
     * primitive's documented and measured behaviour, and it is the better of the
     * two: a literal `aria-invalid="false"` on every field would add noise to
     * the accessibility tree that says nothing the default state does not
     * already say.
     */
    render(<Textarea />);

    expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-invalid');
  });

  it('lets an explicitly supplied aria-invalid win over invalid', () => {
    /*
     * `invalid` is a convenience over the ARIA attribute, not a lock on it. A
     * form that computes `aria-invalid` itself - or that needs `"grammar"` or
     * `"spelling"` rather than a boolean - keeps control, which is why the
     * primitive resolves the two with `??` and not `||`: a deliberate
     * `aria-invalid={false}` survives instead of being treated as absent.
     *
     * Asserted with the two props in conflict, because that is the only
     * arrangement in which the precedence is observable.
     */
    render(<Textarea invalid aria-invalid={false} />);

    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'false');
  });

  it('forwards ref to the underlying textarea element', () => {
    /*
     * The concrete proof that `react-hook-form` registration works. `register()`
     * returns a `ref` among its four properties and callers spread it onto this
     * component; the primitive uses no `forwardRef` wrapper, relying instead on
     * React 19 treating `ref` as an ordinary prop that rides the rest spread
     * into the DOM node. That is a real behavioural dependency rather than a
     * detail, so it is asserted rather than assumed.
     *
     * A holder object is mutated instead of a bare `let`. Control-flow analysis
     * narrows a `let` initialised to `null` and only ever assigned inside a
     * callback back down to `null` at the assertion, which makes a property read
     * on it a type error; a property of an object keeps its declared type.
     */
    const mounted: { node: HTMLTextAreaElement | null } = { node: null };
    const onMounted = vi.fn((node: HTMLTextAreaElement | null) => {
      mounted.node = node;
    });

    render(<RefProbe onMounted={onMounted} />);

    expect(onMounted).toHaveBeenCalledTimes(1);

    // It is an element, and specifically the native one - not a wrapper object
    // and not null.
    expect(mounted.node).not.toBeNull();
    expect(mounted.node?.tagName).toBe('TEXTAREA');

    // And it is THE element in the document, so the ref a form holds is the node
    // that form would focus, select or read a value from.
    expect(mounted.node).toBe(screen.getByRole('textbox'));
  });
});
