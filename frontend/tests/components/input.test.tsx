// =============================================================================
// input.test.tsx - the component suite's contract for `@/components/ui/input`.
//
// WHAT THIS FILE GUARDS
//
// `Input` is one of the fifteen primitives under src/components/ui/ that ARE
// this project's design system, and it is the single place a raw <input> is
// wrapped. Its whole job is to be transparent: it contributes token styling,
// one `invalid` boolean, and nothing else. Every native attribute, every event
// handler and `ref` must ride straight through to the DOM node. Four surfaces
// depend on that being literally true - the login and signup forms, the post
// editor, the home feed's search field and the admin category form - and three
// of them reach the element through `react-hook-form`'s `register()`, which
// hands the component a `{ name, onChange, onBlur, ref }` object and expects all
// four to land. Intercepting any one of them would break every form in the
// product silently, with no type error to catch it. That is what the cases below
// exist to catch instead.
//
// WHY THERE IS NOT ONE CLASS-NAME ASSERTION IN THIS FILE
//
// This absence is deliberate and load-bearing, not an oversight. The component's
// entire visual contract is expressed in semantic design tokens -
// `--color-border`, `--color-ring`, `--color-danger`, `--color-muted-foreground`,
// `--color-surface` - which src/app/globals.css owns and which textarea.tsx and
// select.tsx deliberately reuse so all three controls read as one family. Those
// class strings are free to change on any palette or spacing edit, and a test
// that asserted on one would fail on a change that broke nothing. So every
// assertion here targets an accessible name, an accessible description, an ARIA
// or HTML attribute, a DOM property, a value, focus, or a handler call.
//
// DO NOT ADD, in this file or any sibling component test:
//
//   * `toHaveClass`, or any read of `className` / `classList`.
//   * A class-based `querySelector`, or `container.firstChild` reaching for a
//     styled wrapper.
//   * `getComputedStyle`, or `toHaveStyle` on a token-derived property. jsdom
//     does not resolve Tailwind utilities to declarations anyway, so such an
//     assertion would be vacuous as well as wrong.
//   * `toMatchSnapshot` / `toMatchInlineSnapshot`. A snapshot of this component
//     is a snapshot of its class list.
//
// The consequence worth stating plainly: `invalid` drives BOTH the danger border
// and `aria-invalid`, and only the second half is assertable here. That makes
// `aria-invalid` the one place a regression in that prop can be caught at all,
// which is why it gets three cases below rather than one - set, unset, and
// overridden.
//
// THE INSTRUMENTS, AND WHY EACH IS THE ONE USED
//
//   * `fireEvent`, not `userEvent`. `@testing-library/user-event` is not in the
//     pinned dependency set (frontend/package.json), and the tier's dependency
//     story is exact pins, so text entry is driven with
//     `fireEvent.change(field, { target: { value: '...' } })`.
//   * `getByLabelText`, not `getByTestId` or a tag query. It resolves through
//     the accessibility tree, so it matches only if `htmlFor` and `id` really
//     bound the label to the control. That makes the query itself the assertion
//     that the association is real, which is exactly the property the
//     accessibility floor requires and the reason a bare native <label> is the
//     right harness here. (The `@/components/ui/label` pairing is
//     label.test.tsx's subject, not this file's, so it is not imported.)
//   * `describe`, `it`, `expect` and `vi` are IMPORTED even though
//     vitest.config.ts sets `globals: true`. tsconfig.json includes every .tsx
//     in the `tsc --noEmit` program and declares no `vitest/globals` types, so a
//     file leaning on the globals passes at runtime and fails the type gate with
//     TS2593. Both gates block, so both have to be satisfied.
//
// ONE MEASURED DEVIATION, RECORDED SO IT IS NOT "FIXED" BACK
//
// The `disabled` case does NOT assert that `fireEvent.change` fails to reach
// `onChange`, because on this stack it DOES reach it. Measured on react-dom
// 19.2.8: `fireEvent.change` writes `.value` through the native setter and
// dispatches a synthetic change, and React's change plugin decides to fire from
// the value having moved - it never consults `disabled`. Writing that assertion
// would encode a false claim about the component and turn a blocking gate red.
// The two things a disabled control genuinely guarantees are asserted instead: a
// pointer gesture never reaches its handler, and it cannot take focus, so
// neither a mouse nor a keyboard user can reach it. Both were measured to hold.
//
// ALSO DELIBERATELY ABSENT
//
//   * `import '@testing-library/jest-dom'`. frontend/vitest.setup.ts already
//     registers the matchers through the `/vitest` subpath; a second import here
//     would be redundant at best.
//   * A `cleanup()` call. That same setup file registers it in an explicit
//     `afterEach`, so unmounting between cases is already guaranteed.
//   * `setupServer` and any msw handler import. Nothing in this file performs
//     HTTP - `Input` has no network reach at all - so a request-interception
//     lifecycle here would be scaffolding for a request that never happens.
//   * `.only` and `.skip`. Either one silently shrinks a blocking gate.
// =============================================================================

import { fireEvent, render, screen } from '@testing-library/react';
import {
  useEffect,
  useRef,
  type ChangeEventHandler,
  type FocusEventHandler,
  type MouseEventHandler,
} from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Input } from '@/components/ui/input';

/**
 * Harness for the `ref` case, declared at module scope on purpose.
 *
 * `useRef` may only be called from a component, and a component defined inside
 * another component - or re-created on every call of the test body - is what the
 * React lint rules reject. Declaring it here keeps its identity stable and keeps
 * the hook call legal.
 *
 * The ref is read in an effect and never during render: the DOM node does not
 * exist until the commit, so a render-time read would see `null` even on a
 * component that forwards correctly, and reading a ref while rendering is itself
 * a defect the lint gate refuses.
 */
function RefProbe({ onMounted }: { onMounted: (element: HTMLInputElement | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onMounted(ref.current);
  }, [onMounted]);

  return (
    <>
      <label htmlFor="post-title">Title</label>
      <Input id="post-title" ref={ref} />
    </>
  );
}

describe('Input', () => {
  it('renders a field that a visible label can name', () => {
    render(
      <>
        <label htmlFor="email">Email</label>
        <Input id="email" />
      </>,
    );

    const field = screen.getByLabelText('Email');

    expect(field).toBeInTheDocument();
    // The component deliberately names nothing itself - no invented
    // `aria-label` - so the accessible name can only have come from the
    // <label>. This is the assertion that the `id`/`htmlFor` binding is real.
    expect(field).toHaveAccessibleName('Email');
  });

  it('defaults `type` to text so a field is never left implicit', () => {
    render(
      <>
        <label htmlFor="title">Title</label>
        <Input id="title" />
      </>,
    );

    expect(screen.getByLabelText('Title')).toHaveAttribute('type', 'text');
  });

  it('forwards `type="email"`, which is still a textbox', () => {
    render(
      <>
        <label htmlFor="email">Email</label>
        <Input id="email" type="email" />
      </>,
    );

    const field = screen.getByLabelText('Email');

    expect(field).toHaveAttribute('type', 'email');
    // Both handles have to resolve to the same node, which also proves the
    // attribute landed on the control rather than on a wrapper around it.
    expect(screen.getByRole('textbox', { name: 'Email' })).toBe(field);
  });

  it('forwards `type="password"`, which has no textbox role', () => {
    render(
      <>
        <label htmlFor="password">Password</label>
        <Input id="password" type="password" />
      </>,
    );

    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    // A password field is excluded from the textbox role by design, so a
    // role-based query cannot reach it and the label is the only handle. The
    // login and signup forms both depend on this field existing.
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('forwards `placeholder` to the control itself', () => {
    render(
      <>
        <label htmlFor="q">Search posts</label>
        <Input id="q" type="search" placeholder="Search posts by title" />
      </>,
    );

    expect(screen.getByPlaceholderText('Search posts by title')).toBe(
      screen.getByLabelText('Search posts'),
    );
  });

  it('reports a controlled edit to `onChange` with the new value', () => {
    const received: string[] = [];
    const handleChange = vi.fn<ChangeEventHandler<HTMLInputElement>>((event) => {
      received.push(event.target.value);
    });

    render(
      <>
        <label htmlFor="email">Email</label>
        <Input id="email" type="email" value="" onChange={handleChange} />
      </>,
    );

    const field = screen.getByLabelText('Email');

    fireEvent.change(field, { target: { value: 'ada@example.com' } });

    expect(handleChange).toHaveBeenCalledTimes(1);
    // The value is captured inside the handler rather than read back off the
    // mock afterwards, so the assertion is about what the handler was actually
    // given at call time.
    expect(received).toEqual(['ada@example.com']);
  });

  it('reports leaving the field to `onBlur`, which is what runs form validation', () => {
    const handleBlur = vi.fn<FocusEventHandler<HTMLInputElement>>();
    const handleChange = vi.fn<ChangeEventHandler<HTMLInputElement>>();

    render(
      <>
        <label htmlFor="title">Title</label>
        <Input id="title" onBlur={handleBlur} onChange={handleChange} value="" />
      </>,
    );

    const field = screen.getByLabelText('Title');

    fireEvent.blur(field);

    // `register()` returns `{ name, onChange, onBlur, ref }` and all four halves have to arrive. This
    // is the one that decides WHEN a message appears: the post editor's form is built with
    // `mode: 'onBlur'`, so leaving a field is what runs the resolver against it and puts an error
    // beside the control before anything is submitted. A primitive that swallowed this handler would
    // leave every inline validation message in the product silently waiting for a submit - and every
    // other case in this file would still pass, which is why it is asserted on its own.
    expect(handleBlur).toHaveBeenCalledTimes(1);

    // The event carries the element the label names, so a handler that reads `event.target.value`
    // - which is how a validating form reads the field it is leaving - gets the right node.
    expect(handleBlur.mock.calls[0]?.[0].target).toBe(field);

    // And the two handlers are independent: leaving a field is not editing it, so a blur must not be
    // reported as a change. Firing both from one gesture would double every validation pass.
    expect(handleChange).not.toHaveBeenCalled();
  });

  it('reports entering the field to `onFocus`, independently of leaving it', () => {
    const handleFocus = vi.fn<FocusEventHandler<HTMLInputElement>>();
    const handleBlur = vi.fn<FocusEventHandler<HTMLInputElement>>();

    render(
      <>
        <label htmlFor="excerpt">Excerpt</label>
        <Input id="excerpt" onBlur={handleBlur} onFocus={handleFocus} />
      </>,
    );

    const field = screen.getByLabelText('Excerpt');

    fireEvent.focus(field);

    // The other half of the focus pair, and the reason both are asserted: a primitive that forwarded
    // one of the two would look correct in any test that only ever checked the one it forwarded.
    expect(handleFocus).toHaveBeenCalledTimes(1);
    expect(handleBlur).not.toHaveBeenCalled();
  });

  it('accepts an uncontrolled `defaultValue` and lets the DOM own it afterwards', () => {
    render(
      <>
        <label htmlFor="username">Username</label>
        <Input id="username" defaultValue="ada-lovelace" />
      </>,
    );

    const field = screen.getByLabelText('Username');

    expect(field).toHaveValue('ada-lovelace');

    // Uncontrolled means the element keeps whatever it is given next, with no
    // owner to restore a prop over the top of it.
    fireEvent.change(field, { target: { value: 'grace-hopper' } });

    expect(field).toHaveValue('grace-hopper');
  });

  it('reflects `disabled`, and a disabled field refuses both pointer and focus', () => {
    const handleClick = vi.fn<MouseEventHandler<HTMLInputElement>>();

    render(
      <>
        <label htmlFor="email">Email</label>
        <Input id="email" type="email" disabled onClick={handleClick} />
      </>,
    );

    const field = screen.getByLabelText('Email');

    expect(field).toBeDisabled();

    // A pointer gesture never reaches the handler: React suppresses mouse
    // events on a disabled form control. This is the guarantee a disabled
    // field actually makes, and it is asserted here in place of a change
    // event - see the note in the file header for why that instrument is the
    // wrong one for this prop.
    fireEvent.click(field);

    expect(handleClick).not.toHaveBeenCalled();

    // Nor can it be reached from the keyboard, because it cannot take focus.
    field.focus();

    expect(field).not.toHaveFocus();
  });

  it('reflects `readOnly` as attribute and property while staying focusable', () => {
    render(
      <>
        <label htmlFor="username">Username</label>
        <Input id="username" readOnly defaultValue="ada-lovelace" />
      </>,
    );

    const field = screen.getByLabelText<HTMLInputElement>('Username');

    expect(field).toHaveAttribute('readonly');
    expect(field.readOnly).toBe(true);
    expect(field).toHaveValue('ada-lovelace');

    // Read-only is not disabled: the value still submits and the control is
    // still reachable, so a keyboard user can land on it and read it. Asserting
    // the difference is what stops the two props being conflated.
    expect(field).not.toBeDisabled();

    field.focus();

    expect(field).toHaveFocus();
  });

  it('reflects `required`', () => {
    render(
      <>
        <label htmlFor="title">Title</label>
        <Input id="title" required />
      </>,
    );

    const field = screen.getByLabelText<HTMLInputElement>('Title');

    expect(field).toBeRequired();
    expect(field).toHaveAttribute('required');
    expect(field.required).toBe(true);
  });

  it('mirrors `invalid` into aria-invalid, so the failure is never colour-only', () => {
    render(
      <>
        <label htmlFor="email">Email</label>
        <Input id="email" type="email" invalid aria-describedby="email-error" />
        <p id="email-error">Enter a valid email address.</p>
      </>,
    );

    const field = screen.getByLabelText('Email');

    // THE ASSERTION THIS FILE EXISTS FOR. `invalid` drives a danger border and
    // this attribute; the border is a token concern and unassertable here, so
    // this is the only place a regression in the prop can surface.
    expect(field).toHaveAttribute('aria-invalid', 'true');

    // And the readable half of the same contract: the owning form supplies the
    // message and points `aria-describedby` at it, which the component forwards
    // untouched like every other native attribute.
    expect(field).toHaveAccessibleDescription('Enter a valid email address.');
  });

  it('omits aria-invalid entirely on a field that has not failed validation', () => {
    render(
      <>
        <label htmlFor="email">Email</label>
        <Input id="email" type="email" />
        <label htmlFor="username">Username</label>
        <Input id="username" invalid={false} />
      </>,
    );

    // Absent, not `aria-invalid="false"`. Emitting a literal false on every
    // field in the product would add noise to the accessibility tree that says
    // nothing the default state does not already say, so both the omitted prop
    // and an explicit `false` have to leave the attribute off.
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Username')).not.toHaveAttribute('aria-invalid');
  });

  it('lets an explicitly supplied aria-invalid win over `invalid`', () => {
    render(
      <>
        <label htmlFor="body">Body</label>
        <Input id="body" invalid aria-invalid={false} />
      </>,
    );

    // The component resolves the two with `??` rather than `||`, so a form that
    // computes the attribute itself keeps control - including the deliberate
    // `false` that a truthy `invalid` would otherwise override.
    expect(screen.getByLabelText('Body')).toHaveAttribute('aria-invalid', 'false');
  });

  it('forwards `ref` to the DOM node, which is what react-hook-form registers', () => {
    const onMounted = vi.fn<(element: HTMLInputElement | null) => void>();

    render(<RefProbe onMounted={onMounted} />);

    expect(onMounted).toHaveBeenCalledTimes(1);

    const node = onMounted.mock.calls[0]?.[0] ?? null;

    expect(node).not.toBeNull();
    expect(node?.tagName).toBe('INPUT');
    // Identity, not merely shape: the ref points at the very element the label
    // names. `register()` returns a `ref` alongside `name`, `onChange` and
    // `onBlur`, and the post editor, the search field and the category form all
    // spread that object onto this component.
    expect(node).toBe(screen.getByLabelText('Title'));
  });

  it('passes `name` and `autoComplete` through to the DOM', () => {
    render(
      <>
        <label htmlFor="email">Email</label>
        <Input id="email" type="email" name="email" autoComplete="email" />
      </>,
    );

    const field = screen.getByLabelText<HTMLInputElement>('Email');

    // `name` is the half of `register()` that decides which form key a value is
    // submitted under, so it has to reach the element verbatim.
    expect(field).toHaveAttribute('name', 'email');
    expect(field.name).toBe('email');

    // React lowercases the camel-cased prop into the real HTML attribute, which
    // is what a password manager and the browser autofill both look for.
    expect(field).toHaveAttribute('autocomplete', 'email');
  });
});
