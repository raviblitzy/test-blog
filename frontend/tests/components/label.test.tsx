// =============================================================================
// label.test.tsx - the blocking gate on this project's accessibility floor.
//
// UNIT UNDER TEST: `@/components/ui/label`, which exports exactly one symbol,
// `Label`. It is a thin wrapper over `@radix-ui/react-label`'s `Root` that adds
// token typography and forwards every prop - including `htmlFor` - untouched.
//
// WHAT IS ACTUALLY BEING TESTED HERE, AND WHY IT IS NOT THE STYLING
//
// This is the thinnest primitive in the design system. Its entire addition over
// the primitive underneath is class output, and its entire *behavioural*
// contribution is that one attribute reaches the DOM unchanged. That attribute
// is what gives five separate forms their accessible names - the login and
// signup credential forms, the post editor, the comment form and the admin
// category form - so it is the only thing worth a test, and it is what every
// assertion below targets.
//
// The assertions are therefore ASSOCIATION assertions rather than markup ones.
// Each pairing is reached with `getByLabelText(<caption>)`, a query that
// resolves a control ONLY when the label-to-control wiring genuinely exists, and
// the resolved element is then asserted to carry that caption as its accessible
// name. Break the pass-through and the query stops finding anything: the test
// fails on the mechanism, not on a proxy for it. That is exactly what the
// project's "accessibility as a floor" standard asks for when it says
// accessibility regressions must surface as test failures rather than as review
// comments.
//
// NO CLASS-NAME ASSERTION APPEARS IN THIS FILE, DELIBERATELY.
//
// There is no `toHaveClass`, no `className` read, no class-based
// `querySelector`, no `getComputedStyle` and no snapshot - and in particular no
// attempt to pin the label's typography, which is the wrapper's only visual
// addition. The token layer owns class names and is free to change them: a
// palette or scale edit in `src/app/globals.css` must not be able to fail this
// suite. Asserting the typography would also be the emptiest possible test of
// this component, because it would restate the implementation rather than the
// contract. The vitest configuration makes the same point from its side by
// registering no snapshot or class-name serialiser.
//
// WHAT THE ENVIRONMENT ALREADY PROVIDES - DO NOT RE-ADD IT HERE
//
// `frontend/vitest.setup.ts` registers the jest-dom matchers (through the
// `/vitest` subpath, so they extend Vitest's `expect`), unmounts every rendered
// tree in an `afterEach`, and stubs the browser APIs jsdom omits - `matchMedia`,
// `ResizeObserver`, `IntersectionObserver`, `scrollIntoView` and pointer
// capture. That last group is what lets the Radix-backed picker in this file
// mount at all. So this file imports no matcher package, calls no `cleanup()`
// and stubs nothing.
//
// It also performs NO HTTP. `Label`, `Input`, `Textarea` and the picker are all
// presentational primitives with no data dependency, so no request can be
// provoked and no request-interception lifecycle is set up. `tests/msw/
// handlers.ts` deliberately owns no server instance, and this file has no reason
// to become the spec that starts one.
//
// The test API is IMPORTED rather than taken from the globals. Vitest runs with
// `globals: true`, so leaning on them would work at runtime - but
// `frontend/tsconfig.json` includes every `**/*.tsx` in the `tsc --noEmit`
// program and deliberately declares no `vitest/globals` types entry, so a file
// that relied on them would fail the type gate with TS2593/TS2304 while passing
// the test gate. Both gates are blocking, so the import is not optional.
//
// `@testing-library/user-event` is NOT in the pinned dependency set, so every
// interaction below goes through `fireEvent`. Nothing here reaches for an
// undeclared package, and nothing imports `@radix-ui/react-label` directly: the
// project wrapper is the unit under test, because the wrapper is what feature
// code consumes.
//
// ONE HONEST LIMITATION, RECORDED RATHER THAN PAPERED OVER
//
// A native `<label for="x">` does two things in a real browser when clicked: it
// ACTIVATES the control with `id="x"`, and it FOCUSES it. jsdom 30 implements
// only the first. Measured in this environment: after `fireEvent.click` on a
// label, `document.activeElement` is still `<body>`, so an assertion that the
// paired field `toHaveFocus()` would fail for a reason that has nothing to do
// with this component. The two cases below therefore assert the half jsdom does
// implement - a checkbox flipping, and a click landing on a text field - which
// is the same fact about the same wiring and is genuinely observable here. The
// focus half is covered where it can be: by the Playwright journeys, in a real
// browser. Asserting a mechanism the environment cannot deliver would produce a
// red gate that says nothing about the code.
// =============================================================================

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

describe('Label', () => {
  it('renders the caption text the caller wrote, unchanged', () => {
    render(<Label htmlFor="email">Email address</Label>);

    // The visible text IS the accessible name of every control this label
    // names, so it has to survive verbatim. The component transforms `children`
    // in no way - no required-field asterisk, no wrapping span, no
    // `String(children)` - and this is the assertion that holds it to that.
    expect(screen.getByText('Email address')).toBeInTheDocument();
  });

  it('serialises `htmlFor` to the DOM `for` attribute', () => {
    render(<Label htmlFor="email">Email address</Label>);

    // React spells the attribute `htmlFor` and the DOM spells it `for`. This is
    // the single hop the whole component exists to make: the prop is accepted at
    // the JSX boundary, passes through the wrapper's rest spread into the
    // primitive, and lands on a real `<label>` as `for`. Everything else in this
    // file is a consequence of this line holding.
    expect(screen.getByText('Email address')).toHaveAttribute('for', 'email');
  });

  it('names an Input, so a credential field is reachable by its visible caption', () => {
    render(
      <>
        <Label htmlFor="email">Email address</Label>
        <Input id="email" type="email" />
      </>,
    );

    // `getByLabelText` walks from the caption to the control it labels, so it
    // throws outright if the association is missing. Reaching the field this way
    // - rather than by role or by test id - is what makes the query itself the
    // assertion.
    const field = screen.getByLabelText('Email address');

    // The same fact from the accessibility tree's side. `Input` deliberately
    // never names itself: it injects no `aria-label`, so this name can only have
    // come from the paired label. A regression that dropped `htmlFor` would
    // leave the field anonymous here even if it still rendered perfectly.
    expect(field).toHaveAccessibleName('Email address');
  });

  it('names a Textarea, so the comment body and post excerpt are reachable', () => {
    render(
      <>
        <Label htmlFor="body">Comment</Label>
        <Textarea id="body" />
      </>,
    );

    // The comment form and the post editor are the consumers of this pairing;
    // both depend on it for their fields to have names at all.
    const field = screen.getByLabelText('Comment');

    expect(field).toHaveAccessibleName('Comment');
  });

  it('names the Select trigger through the id the picker accepts', () => {
    render(
      <>
        <Label htmlFor="category">Category</Label>
        <Select>
          <SelectTrigger id="category">
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="engineering">Engineering</SelectItem>
          </SelectContent>
        </Select>
      </>,
    );

    // The trigger IS id-addressable, and that is a property of this particular
    // primitive rather than an assumption. `@/components/ui/select` documents the
    // exact pairing written above and records that `id`, `aria-labelledby` and
    // `aria-describedby` all reach the element untouched, because Radix Select
    // generates no id for its trigger and nothing reads one. The sibling
    // dropdown-menu primitive documents the OPPOSITE prohibition for its own
    // trigger, so the mechanism asserted here is the one the source implements -
    // not one carried over from another component.
    //
    // Radix renders the trigger as a `<button role="combobox">`. A combobox
    // takes no name from its own content, so the caption below cannot be leaking
    // in from the placeholder text the trigger displays - it can only be the
    // label.
    const trigger = screen.getByLabelText('Category');

    expect(trigger).toHaveAccessibleName('Category');
  });

  it('names a control nested inside it, with no `htmlFor` at all', () => {
    render(
      <Label>
        Comment
        <Textarea />
      </Label>,
    );

    // The second supported arrangement, and it is supported rather than
    // incidental: the component's own documentation records that wrapping the
    // control instead of pairing by `id` works, and that a mouse press starting
    // inside the nested control is left entirely alone. Asserting it here keeps
    // that promise honest, and proves the wrapper renders exactly one `<label>`
    // node - an extra wrapper element between the label and its child would
    // break this implicit association while leaving the `htmlFor` cases above
    // perfectly green.
    const field = screen.getByLabelText('Comment');

    expect(field).toHaveAccessibleName('Comment');
  });

  it('activates its control when the caption is clicked, toggling a checkbox field', () => {
    render(
      <div>
        <Input id="notify" type="checkbox" />
        <Label htmlFor="notify">Email me about replies</Label>
      </div>,
    );

    const checkbox = screen.getByLabelText('Email me about replies');

    // Unchecked to begin with, so the change below is unambiguous rather than a
    // pre-existing state read twice.
    expect(checkbox).not.toBeChecked();

    fireEvent.click(screen.getByText('Email me about replies'));

    // The caption is not the control, yet clicking it changed the control. That
    // can only happen through the native `for`/`id` relationship, so this is the
    // association asserted as behaviour rather than as an attribute - and it is
    // the browser-supplied half of the click affordance that jsdom does
    // implement (see the note in the file header about the focus half).
    expect(checkbox).toBeChecked();
  });

  it('delivers a caption click to a text field as a real click event', () => {
    const handleFieldClick = vi.fn();

    render(
      <div>
        <Label htmlFor="title">Title</Label>
        <Input id="title" onClick={handleFieldClick} />
      </div>,
    );

    fireEvent.click(screen.getByText('Title'));

    // A text field has no checked state to observe, so the forwarded activation
    // is observed directly instead. Exactly one click arrives: the label
    // forwards the press to its control once, and does not also let the original
    // event reach the field on its own for a duplicate.
    expect(handleFieldClick).toHaveBeenCalledTimes(1);
  });

  it('keeps the primitive double-click guard, preventing text selection on a second press', () => {
    render(<Label htmlFor="excerpt">Excerpt</Label>);

    const caption = screen.getByText('Excerpt');

    // A single press must stay untouched, or a consumer could never begin a
    // selection or a drag that starts on a caption.
    const singlePress = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    fireEvent(caption, singlePress);

    expect(singlePress.defaultPrevented).toBe(false);

    // The second press of a double-click is prevented, so double-clicking a
    // caption focuses the field instead of selecting the caption's words. This
    // behaviour lives in the Radix `Root`'s own `onMouseDown` and nowhere in the
    // wrapper, which is precisely why it is worth asserting: it is the cheapest
    // possible proof that the wrapper still renders the primitive rather than
    // having quietly become a plain `<label>` that merely looks the same. Both
    // presses are dispatched at the caption, so the guard is observed through the
    // component's real event path rather than by calling into the primitive.
    const doublePress = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      detail: 2,
    });
    fireEvent(caption, doublePress);

    expect(doublePress.defaultPrevented).toBe(true);
  });

  it("runs a caller's own onMouseDown, so a consumer's handler is never swallowed", () => {
    const handleMouseDown = vi.fn();

    render(
      <Label htmlFor="username" onMouseDown={handleMouseDown}>
        Username
      </Label>,
    );

    // `detail: 2` is the case where the primitive takes an action of its own, so
    // it is the one where a naive implementation would be most tempted to skip
    // the caller. The primitive invokes the consumer's handler BEFORE deciding,
    // which is what lets a consumer opt out of the guard entirely by calling
    // `preventDefault()` itself.
    fireEvent.mouseDown(screen.getByText('Username'), { detail: 2 });

    expect(handleMouseDown).toHaveBeenCalledTimes(1);
  });

  it('passes `id` and `data-*` attributes through, and invents no ARIA name', () => {
    render(
      <>
        <Label
          data-testid="excerpt-caption"
          data-field="excerpt"
          htmlFor="excerpt"
          id="excerpt-label"
        >
          Excerpt
        </Label>
        <Input id="excerpt" />
      </>,
    );

    const caption = screen.getByTestId('excerpt-caption');

    // `id` matters beyond tidiness: it is what lets a form point
    // `aria-labelledby` at this caption when a control cannot be labelled by
    // `for` alone, so it must not be consumed or rewritten by the wrapper.
    expect(caption).toHaveAttribute('id', 'excerpt-label');

    // `data-*` stands in for the whole open set of attributes a `<label>`
    // accepts. The props type is derived from the primitive itself, so nothing is
    // filtered - and the two attributes reaching the DOM here are the evidence.
    expect(caption).toHaveAttribute('data-field', 'excerpt');

    // The component injects no `aria-label`, and this is a guard rather than
    // trivia. An `aria-label` here would override the caption's own text as the
    // accessible name, silently renaming every control in the product and making
    // the name assertions above describe something no sighted user can see.
    expect(caption).not.toHaveAttribute('aria-label');

    // The consequence, stated where a regression would show: the field's name is
    // still the caption a reader can actually see.
    expect(screen.getByLabelText('Excerpt')).toHaveAccessibleName('Excerpt');
  });
});
