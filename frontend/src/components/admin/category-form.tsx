'use client';

/**
 * The administrative taxonomy form: create a category, rename or re-describe one, and delete one.
 *
 * `POST /api/v1/admin/categories`, `PATCH /api/v1/admin/categories/{id}` and
 * `DELETE /api/v1/admin/categories/{id}` are the three operations behind this component, and
 * together they are the whole category lifecycle - the public `@/lib/api/categories` wrapper
 * deliberately offers no mutation at all, because a taxonomy is administered rather than authored.
 *
 * WHY THIS COMPONENT EXISTS AT ALL
 *
 * The product brief asked for "category filters" on the home feed and for an admin screen for
 * "managing ... categories" without ever naming the entity being filtered or managed. A taxonomy
 * relation with a name, a URL-safe slug and a description had to exist before either could, and
 * this form is that entity's client face: the categories it creates are what the home feed's filter
 * chips are drawn from. Nothing was migrated to build it - the repository this product grew out of
 * had no category type and no many-to-many relationship anywhere, so every row this form writes is
 * the first of its kind.
 *
 * TWO MODES, TWO SCHEMAS, TWO SEPARATE FORMS
 *
 * `category` discriminates the mode. Absent, this is a create form validated by
 * `categoryCreateSchema`, whose inferred values are `{ name: string; description?: ... }`. Present,
 * it is a rename form validated by `categoryUpdateSchema`, whose inferred values make **every**
 * member optional. Those two types are genuinely different, so rather than reconcile them behind a
 * cast this module renders one of two sibling components - {@link CreateCategoryForm} and
 * {@link RenameCategoryForm} - each owning a single `useForm` bound to a single schema. Each
 * branch's field paths, submit payload and `setError` calls then type-check against exactly one
 * contract, with no `any`, no assertion and no suppression anywhere in the file.
 *
 * The presentation the two branches share is factored into components that take plain props and
 * `react-hook-form`'s **non-generic** `UseFormRegisterReturn`, so the shared markup never has to be
 * generic over a schema.
 *
 * WHAT THIS FORM DELIBERATELY CANNOT DO
 *
 * There is no slug control, and that omission is the single most consequential decision here. A
 * slug is derived from the name once, at creation, by the service - it is the canonical URL that
 * `GET /api/v1/categories/{slug}` resolves against, that the sitemap enumerates and that every
 * canonical link tag is built from. Offering a control to change it would hand an administrator the
 * ability to break every indexed link to a category page, so renaming a category changes the label
 * a reader sees while the address they bookmarked keeps resolving. The slug is *shown* in rename
 * mode, as read-only context with that guarantee spelled out, and it is never a field and never a
 * member of a request body. `id`, `post_count`, `created_at` and `updated_at` are absent for the
 * same family of reasons: each is the server's to produce, so none is the client's to submit.
 *
 * The data model has a name, a slug, a description and timestamps. There is consequently no colour
 * picker, no icon picker, no parent category, no ordering control and no bulk import here - there
 * would be nothing for any of them to write.
 *
 * LAYERING
 *
 * This module performs no transport. It calls three functions from `@/lib/api/admin`, which
 * delegate to `@/lib/api/client` - the tier's only HTTP module - so no URL, header, status-code
 * branch or retry policy appears below. It authors no validation rule either: both schemas live in
 * `@/lib/validation/category`, which mirrors the service's Pydantic models, and which is the single
 * client-side definition site for both the create and the update body because
 * `app.schemas.admin` reuses `CategoryCreate`/`CategoryUpdate` rather than declaring administrative
 * variants. A second schema here would be a second definition of one contract, and the two would
 * drift. It reads no environment variable, and it mounts no toast host: `<Toaster />` belongs to the
 * root layout.
 *
 * Any authority this component appears to carry is presentational. The real boundary is
 * `require_admin` on the service's admin router; hiding a control is not a security boundary, so a
 * `403` that arrives here is rendered as a legible failure rather than swallowed.
 *
 * PRESENTATION BOUNDARY
 *
 * This renders a form and nothing more. Whether it appears inline, in a panel or inside a dialog is
 * `admin/categories/page.tsx`'s decision, and {@link CategoryFormProps.onSuccess} is how that page
 * learns it may close whatever it opened. The one dialog this module owns is the delete
 * confirmation, because that dialog belongs to the destructive action rather than to the form's
 * placement.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { JSX, RefObject } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { CircleAlert, LoaderCircle, Plus, Save, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { createAdminCategory, deleteAdminCategory, updateAdminCategory } from '@/lib/api/admin';
import { isApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { categoryCreateSchema, categoryUpdateSchema } from '@/lib/validation/category';

import type { CategoryPublic, CategoryUpdate } from '@/lib/types';
import type { CategoryCreateFormValues, CategoryUpdateFormValues } from '@/lib/validation/category';

/* -------------------------------------------------------------------------------------------------
 * Cache invalidation
 * ---------------------------------------------------------------------------------------------- */

/**
 * The key every administrative category listing is registered under.
 *
 * The `(admin)` screens register their lists as `['admin', <entity>, params]` and their counts as
 * `['admin', 'stats']`. Invalidating the two-segment prefix therefore reaches every page and filter
 * combination of the category table at once, which is the point: an administrator who creates a
 * category from a filtered page still expects the row to appear.
 */
const ADMIN_CATEGORIES_QUERY_KEY = ['admin', 'categories'] as const;

/**
 * The key the administrative overview's aggregate counts are registered under.
 *
 * Invalidated after a create and after a delete - the two mutations that change how many categories
 * exist - and deliberately **not** after a rename, which moves no count.
 */
const ADMIN_STATS_QUERY_KEY = ['admin', 'stats'] as const;

/**
 * Refresh the administrative views a category mutation has just invalidated.
 *
 * The public category list - the one the home feed's filter is drawn from - is a separate query
 * owned by another surface and is deliberately not reached into from here.
 *
 * Awaited by each mutation's success handler, which keeps the mutation in its pending state until
 * the refetch settles. That is intentional: the submit control stays disabled until the table the
 * operator is looking at actually reflects the change, which is what stops a doubled create.
 *
 * @param queryClient - The client resolved from the provider that owns the tier's default options.
 * @param options - `includeStats` adds the overview counts, for the two mutations that move them.
 */
async function invalidateAdminCategoryQueries(
  queryClient: QueryClient,
  options: { readonly includeStats: boolean },
): Promise<void> {
  const pending = [queryClient.invalidateQueries({ queryKey: ADMIN_CATEGORIES_QUERY_KEY })];

  if (options.includeStats) {
    pending.push(queryClient.invalidateQueries({ queryKey: ADMIN_STATS_QUERY_KEY }));
  }

  await Promise.all(pending);
}

/* -------------------------------------------------------------------------------------------------
 * Failure interpretation
 * ---------------------------------------------------------------------------------------------- */

/**
 * The two members either request body carries, and therefore the only two a field error can name.
 */
const CATEGORY_FIELD_NAMES = ['name', 'description'] as const;

/** A field path valid in *both* the create and the update form. */
type CategoryFieldName = (typeof CATEGORY_FIELD_NAMES)[number];

/**
 * Attaches one server-supplied message to one field.
 *
 * Each branch supplies its own implementation closing over its own `setError`, which is what lets
 * the shared interpretation below stay free of the schema types: `CategoryFieldName` is a valid path
 * in both forms, so both implementations type-check without a cast.
 */
type CategoryFieldErrorSetter = (field: CategoryFieldName, message: string) => void;

/**
 * `ProblemDetail.type` for every conflict the service raises.
 *
 * The service uses one URI for all of them, so `type` alone cannot say *which* conflict occurred -
 * but the operation can, and does. Reading the service's raise sites: every conflict from creating
 * or updating a category reports a taken name or a taken derived slug, and the only conflict from
 * deleting one is the in-use guard. So a conflict on submit is attributable to the name field, and a
 * conflict on delete is not a field error at all. That is why {@link applySubmitFailureToFields} is
 * used on the submit path only, and why the delete flow renders its refusal in place instead.
 */
const CONFLICT_PROBLEM_TYPE = '/errors/conflict';

/** `type` recorded on errors this component attaches, distinguishing them from resolver errors. */
const SERVER_ERROR_TYPE = 'server';

/** Shown against the name when a conflict arrives carrying no prose of its own. */
const CONFLICT_FALLBACK_MESSAGE = 'That category name is already taken. Choose another.';

/** Headline for a failure that is not one of the service's problem documents. */
const UNEXPECTED_FAILURE_HEADLINE = 'Something went wrong.';

/**
 * Reduce a `field` from a validation error to a form field, or `null` if it names neither.
 *
 * The service reports a dotted path in the syntax of the submitted body - `name`, or `parent.0` for
 * a nested value - so the first segment is the member being complained about. A path this form has
 * no control for, and the documented blank case where a failure cannot be attributed to any named
 * field, both return `null` so the caller falls back to a non-field-specific presentation rather
 * than silently dropping the message.
 *
 * @param field - The reported path, as carried in `ValidationErrorItem.field`.
 * @returns The matching field name, or `null` when this form cannot show it.
 */
function toCategoryFieldName(field: string): CategoryFieldName | null {
  const [head] = field.split('.');

  if (head === undefined) {
    return null;
  }

  return CATEGORY_FIELD_NAMES.find((candidate) => candidate === head) ?? null;
}

/**
 * Attach a submit failure to the fields that caused it, reporting whether anything was attached.
 *
 * Two failures are attributable, and both put the message beside the control the operator has to
 * change rather than in a banner away from it:
 *
 *   - a request-validation failure, which carries one entry per rejected field; and
 *   - a conflict, which on this path always concerns the name or the slug derived from it, and whose
 *     remedy - choose another name - is the same either way.
 *
 * Everything else is not a field's fault. A `403` from an account that is not an administrator, a
 * `404` for a category deleted in another tab, a rate-limit refusal, a gateway that never answered:
 * each returns `false` so the caller renders it as a form-level alert instead. Nothing is ever
 * swallowed.
 *
 * @param failure - The rejection, still unnarrowed.
 * @param setFieldError - Attaches one message to one field.
 * @returns `true` when at least one message was attached to a field.
 */
function applySubmitFailureToFields(
  failure: unknown,
  setFieldError: CategoryFieldErrorSetter,
): boolean {
  if (!isApiError(failure)) {
    return false;
  }

  // The client lifts `errors` off the document and omits it entirely when there is no field detail,
  // so its presence is a complete test and a length check would add nothing.
  if (failure.errors !== undefined) {
    let attached = false;

    for (const item of failure.errors) {
      const field = toCategoryFieldName(item.field);
      const message = item.message.trim();

      if (field !== null && message.length > 0) {
        setFieldError(field, message);
        attached = true;
      }
    }

    return attached;
  }

  if (failure.problem.type === CONFLICT_PROBLEM_TYPE) {
    const detail = failure.problem.detail.trim();
    setFieldError('name', detail.length > 0 ? detail : CONFLICT_FALLBACK_MESSAGE);
    return true;
  }

  return false;
}

/** A failure rendered as a headline and, when there is more to say, an explanation beneath it. */
interface FailureCopy {
  readonly headline: string;
  readonly explanation: string | null;
}

/**
 * Describe how long the caller must wait, when a refusal said so.
 *
 * Worth surfacing rather than dropping: a form that retries inside this interval is refused again,
 * so an operator who is not told the interval reads a working form as a broken one.
 *
 * @param seconds - `ApiError.retryAfterSeconds`, or `null` when the response carried no interval.
 * @returns A sentence, or `null` when there is no interval to report.
 */
function describeRetryInterval(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  const whole = Math.ceil(seconds);

  return `Try again in ${String(whole)} ${whole === 1 ? 'second' : 'seconds'}.`;
}

/**
 * Turn any rejection into copy that is safe and useful to show to the person who caused it.
 *
 * Mirrors how `@/components/admin/data-table` reports a failed load, so every administrative
 * surface reports the one error contract the same way: the document's `title` is the headline and
 * its `detail` the explanation beneath, unless `detail` merely repeats the title or is blank. A
 * rejection that is not one of the service's documents - a thrown `TypeError`, an aborted signal -
 * keeps its own message as the explanation under a generic headline, so it is still legible.
 *
 * @param failure - The rejection, still unnarrowed.
 * @returns The headline, and an explanation when there is one.
 */
function resolveFailureCopy(failure: unknown): FailureCopy {
  if (!isApiError(failure)) {
    const message = failure instanceof Error ? failure.message.trim() : '';

    return {
      headline: UNEXPECTED_FAILURE_HEADLINE,
      explanation: message.length > 0 ? message : null,
    };
  }

  const title = failure.problem.title.trim();
  const detail = failure.problem.detail.trim();
  const retry = describeRetryInterval(failure.retryAfterSeconds);

  if (title.length > 0) {
    const explanation = detail.length > 0 && detail !== title ? detail : null;

    return { headline: title, explanation: joinSentences(explanation, retry) };
  }

  if (detail.length > 0) {
    return { headline: detail, explanation: retry };
  }

  return { headline: UNEXPECTED_FAILURE_HEADLINE, explanation: retry };
}

/**
 * Join the sentences that are actually present into one paragraph, or `null` if none are.
 *
 * @param parts - Sentences, any of which may be absent.
 * @returns The joined paragraph, or `null`.
 */
function joinSentences(...parts: ReadonlyArray<string | null>): string | null {
  const present = parts.filter((part): part is string => part !== null && part.length > 0);

  return present.length > 0 ? present.join(' ') : null;
}

/**
 * Join the identifier references that are present into an `aria-describedby` value.
 *
 * Deliberately not `cn`: that composes *class* names and resolves conflicts between them, and
 * running an identifier list through a class-conflict resolver is a category error waiting to
 * misbehave. `undefined` rather than an empty string, so the attribute is omitted entirely when
 * there is nothing to reference.
 *
 * @param tokens - Identifiers, any of which may be absent or conditionally `false`.
 * @returns The space-separated list, or `undefined`.
 */
function joinIdentifiers(
  ...tokens: ReadonlyArray<string | false | null | undefined>
): string | undefined {
  const present = tokens.filter(
    (token): token is string => typeof token === 'string' && token.length > 0,
  );

  return present.length > 0 ? present.join(' ') : undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Copy
 * ---------------------------------------------------------------------------------------------- */

const NAME_LABEL = 'Name';
const NAME_PLACEHOLDER = 'Engineering';
const NAME_HINT = 'Shown on filter chips and on the category page.';

const DESCRIPTION_LABEL = 'Description';
const DESCRIPTION_PLACEHOLDER = 'A sentence or two orienting readers to what belongs here.';
const DESCRIPTION_HINT = 'Optional. Clearing it removes the description.';

const CREATE_FORM_LABEL = 'Create a category';
const CREATE_SUBMIT_LABEL = 'Create category';
const CREATE_SUBMIT_PENDING_LABEL = 'Creating…';

const RENAME_SUBMIT_LABEL = 'Save changes';
const RENAME_SUBMIT_PENDING_LABEL = 'Saving…';
const RENAME_SUBMIT_HINT = 'Only the fields you change are sent.';

const SLUG_TERM = 'Address';
const SLUG_NOTE =
  'Permanent. Renaming the category does not change it, so existing links keep working.';
const POST_COUNT_TERM = 'Posts filed';

const DELETE_TRIGGER_LABEL = 'Delete category';
const DELETE_CONFIRM_LABEL = 'Delete';
const DELETE_CONFIRM_PENDING_LABEL = 'Deleting…';
const DELETE_CANCEL_LABEL = 'Cancel';

/* -------------------------------------------------------------------------------------------------
 * Class names
 *
 * Hoisted so the markup below reads as structure rather than as styling, matching the convention in
 * this folder. Every value resolves to a semantic token declared in `globals.css` or to a utility
 * generated from the token scale, and every breakpoint is one of the five catalogued ones. There is
 * no literal colour, length, radius or shadow anywhere in this file.
 * ---------------------------------------------------------------------------------------------- */

/** Single column throughout; constrained to a token measure once there is room for one. */
const FORM_CLASSES = 'flex w-full flex-col gap-6 md:max-w-2xl';

const FIELD_STACK_CLASSES = 'flex flex-col gap-5';
const FIELD_GROUP_CLASSES = 'flex flex-col gap-2';
const FIELD_HINT_CLASSES = 'text-muted-foreground text-sm';
/** Errors are `--color-danger`, but the invalid state also reaches assistive technology through the
 *  primitives' `aria-invalid`, so meaning never rests on colour alone. */
const FIELD_ERROR_CLASSES = 'text-danger text-sm font-medium';

const META_LIST_CLASSES =
  'border-border bg-surface-muted flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:gap-6';
const META_ITEM_CLASSES = 'flex min-w-0 flex-col gap-1';
const META_TERM_CLASSES = 'text-muted-foreground text-xs font-medium uppercase tracking-wide';
const META_VALUE_CLASSES = 'text-foreground truncate font-mono text-sm';
const META_COUNT_VALUE_CLASSES = 'text-foreground text-sm tabular-nums';
const META_NOTE_CLASSES = 'text-muted-foreground text-xs';

/**
 * Stacked while narrow, a row once there is width for one.
 *
 * Document order is primary-then-destructive and the visual order follows it in both directions -
 * no `flex-col-reverse` anywhere - so the delete control is never the first thing a thumb reaches or
 * a keyboard lands on. Widened, `justify-between` puts real distance between saving and deleting.
 */
const ACTIONS_CLASSES = 'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between';
const ACTIONS_PRIMARY_GROUP_CLASSES = 'flex flex-col items-start gap-2';
/** Cancel first, confirm last, in document and visual order alike. */
const DIALOG_ACTIONS_CLASSES = 'flex flex-col gap-3 sm:flex-row sm:justify-end';
const SPINNER_CLASSES = 'motion-safe:animate-spin';
/**
 * Applied where a category's own name is rendered.
 *
 * A name is operator-supplied and bounded only in length, so it may be one unbroken eighty-character
 * token. Without this it would push the dialog panel wider than the viewport at the narrowest
 * verified width instead of wrapping inside it.
 */
const USER_TEXT_CLASSES = 'wrap-anywhere';

/* -------------------------------------------------------------------------------------------------
 * Shared presentation
 * ---------------------------------------------------------------------------------------------- */

/**
 * Render a rejection as an assertive panel.
 *
 * The `destructive` variant is what makes it announce: the alert primitive derives `role="alert"`
 * from the variant, so choosing the tone and choosing the announcement are one decision and cannot
 * be set inconsistently. The icon is a direct child because the primitive positions it there, and it
 * is hidden from assistive technology because the text says everything it says.
 *
 * @param props.failure - The rejection to report.
 */
function FailureAlert({ failure }: { readonly failure: unknown }): JSX.Element {
  const { headline, explanation } = resolveFailureCopy(failure);

  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{headline}</AlertTitle>
      {explanation === null ? null : <AlertDescription>{explanation}</AlertDescription>}
    </Alert>
  );
}

/** Everything {@link CategoryFields} needs, and nothing that would tie it to a schema. */
interface CategoryFieldsProps {
  /** Unique per form instance, so two forms on one screen cannot collide on an identifier. */
  readonly idBase: string;
  /** `register('name')` from whichever form owns this instance. */
  readonly nameRegistration: UseFormRegisterReturn;
  /** `register('description')` from whichever form owns this instance. */
  readonly descriptionRegistration: UseFormRegisterReturn;
  /** The name field's current message, from the resolver or from the service. */
  readonly nameError: string | undefined;
  /** The description field's current message. */
  readonly descriptionError: string | undefined;
  /** `true` while a mutation is in flight, which makes both controls inert. */
  readonly pending: boolean;
}

/**
 * The two controls both modes share: a name, and an optional description.
 *
 * Kept free of the form types by taking `react-hook-form`'s registration objects, which are not
 * generic over the field values. Each branch calls `register` against its own schema - so the field
 * paths are checked there, where the schema is known - and hands the result down. That is the whole
 * reason this markup is written once rather than twice.
 *
 * The accessibility floor is met here rather than by the lint gate, which polices only a subset of
 * it: each control is associated with a `Label` through `htmlFor`, its hint and, when present, its
 * message are referenced by `aria-describedby`, and its invalid state is carried by the primitives'
 * `aria-invalid` as well as by colour. A placeholder is an example, never a label.
 *
 * The registration is spread first so that the identity and state set afterwards cannot be
 * overwritten by it.
 */
function CategoryFields({
  idBase,
  nameRegistration,
  descriptionRegistration,
  nameError,
  descriptionError,
  pending,
}: CategoryFieldsProps): JSX.Element {
  const nameId = `${idBase}-name`;
  const nameHintId = `${idBase}-name-hint`;
  const nameErrorId = `${idBase}-name-error`;
  const descriptionId = `${idBase}-description`;
  const descriptionHintId = `${idBase}-description-hint`;
  const descriptionErrorId = `${idBase}-description-error`;

  const nameInvalid = nameError !== undefined;
  const descriptionInvalid = descriptionError !== undefined;

  return (
    <div className={FIELD_STACK_CLASSES}>
      <div className={FIELD_GROUP_CLASSES}>
        <Label htmlFor={nameId}>{NAME_LABEL}</Label>
        <Input
          {...nameRegistration}
          aria-describedby={joinIdentifiers(nameHintId, nameInvalid && nameErrorId)}
          autoComplete="off"
          disabled={pending}
          id={nameId}
          invalid={nameInvalid}
          placeholder={NAME_PLACEHOLDER}
        />
        <p className={FIELD_HINT_CLASSES} id={nameHintId}>
          {NAME_HINT}
        </p>
        {nameInvalid ? (
          <p className={FIELD_ERROR_CLASSES} id={nameErrorId}>
            {nameError}
          </p>
        ) : null}
      </div>

      <div className={FIELD_GROUP_CLASSES}>
        <Label htmlFor={descriptionId}>{DESCRIPTION_LABEL}</Label>
        <Textarea
          {...descriptionRegistration}
          aria-describedby={joinIdentifiers(
            descriptionHintId,
            descriptionInvalid && descriptionErrorId,
          )}
          disabled={pending}
          id={descriptionId}
          invalid={descriptionInvalid}
          placeholder={DESCRIPTION_PLACEHOLDER}
          rows={4}
        />
        <p className={FIELD_HINT_CLASSES} id={descriptionHintId}>
          {DESCRIPTION_HINT}
        </p>
        {descriptionInvalid ? (
          <p className={FIELD_ERROR_CLASSES} id={descriptionErrorId}>
            {descriptionError}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The read-only facts about an existing category, shown above the controls in rename mode.
 *
 * Both values are here for a reason beyond completeness. The address is shown *with* its guarantee,
 * so an administrator renaming a category can see that the link they published still resolves. The
 * filed-post count is shown because it is exactly what decides whether a delete will be permitted,
 * and seeing it beforehand turns a refusal from a confusing failure into an expected one.
 *
 * Neither is a control, so neither is labelled by a `Label` or associated with a field: a description
 * list is what a set of read-only term-and-value pairs actually is.
 */
function CategoryFacts({ category }: { readonly category: CategoryPublic }): JSX.Element {
  return (
    <div className={FIELD_GROUP_CLASSES}>
      <dl className={META_LIST_CLASSES}>
        <div className={META_ITEM_CLASSES}>
          <dt className={META_TERM_CLASSES}>{SLUG_TERM}</dt>
          <dd className={META_VALUE_CLASSES}>{category.slug}</dd>
        </div>
        <div className={META_ITEM_CLASSES}>
          <dt className={META_TERM_CLASSES}>{POST_COUNT_TERM}</dt>
          <dd className={META_COUNT_VALUE_CLASSES}>{String(category.post_count)}</dd>
        </div>
      </dl>
      <p className={META_NOTE_CLASSES}>{SLUG_NOTE}</p>
    </div>
  );
}

/**
 * Return focus to a control that the pending state disabled out from under the reader.
 *
 * Disabling the submit control while a request is in flight is what stops a doubled submission, but
 * a disabled element cannot hold focus - so the moment it is disabled the browser drops focus to
 * `<body>`, and a keyboard reader who pressed Enter loses their place. This puts them back once the
 * control is interactive again.
 *
 * The restoration is deliberately conservative, and each guard removes a way it could misbehave:
 *
 *   - it runs in an effect keyed on the pending flag, so the DOM has already been repainted and the
 *     control is genuinely re-enabled by the time `focus()` is called - no timer, no polling;
 *   - it acts only on the true-to-false edge, so a re-render for any other reason cannot move focus;
 *   - it acts only while focus is still on `<body>`, so it never steals focus from a reader who
 *     moved on, nor from the field that `shouldFocusError` just focused after a failed validation;
 *   - it skips a control that is still disabled, which is the successful-rename case: saving clears
 *     the dirty state and the button correctly goes inert, so there is nothing to focus and a toast
 *     reports the outcome instead.
 *
 * Because the focus is programmatic, Chrome matches `:focus-visible` only when the reader was
 * already navigating by keyboard - so a ring reappears for them and not for someone who clicked.
 *
 * @param pending - Whether the mutation is in flight.
 * @param target - The control to restore focus to.
 */
function useFocusRestoredAfterPending(
  pending: boolean,
  target: RefObject<HTMLButtonElement | null>,
): void {
  const wasPending = useRef(pending);

  useEffect(() => {
    const settled = wasPending.current && !pending;
    wasPending.current = pending;

    if (!settled || document.activeElement !== document.body) {
      return;
    }

    const control = target.current;

    if (control !== null && !control.disabled) {
      control.focus();
    }
  }, [pending, target]);
}

/**
 * The label inside a submit or confirm control, which states the pending condition in words.
 *
 * Pending state is never conveyed by the spinner alone: the text changes too, so the condition
 * reaches a screen reader and anyone who has asked for reduced motion. The spinner only spins when
 * motion is welcome, and it is hidden from assistive technology because the text already says it.
 */
function ActionLabel({
  pending,
  icon: Icon,
  label,
  pendingLabel,
}: {
  readonly pending: boolean;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly pendingLabel: string;
}): JSX.Element {
  return pending ? (
    <>
      <LoaderCircle aria-hidden="true" className={SPINNER_CLASSES} />
      {pendingLabel}
    </>
  ) : (
    <>
      <Icon aria-hidden="true" />
      {label}
    </>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Deletion
 * ---------------------------------------------------------------------------------------------- */

/**
 * Describe what deleting this category would do, in terms of what is filed under it.
 *
 * The count is quoted because it is the condition the service actually checks: a category with posts
 * still filed under it is refused, and it is refused for a reason worth stating - the association
 * cascades, so an unguarded delete would succeed while quietly stripping the category from every post
 * that used it. Saying so before the operator confirms means the refusal, when it comes, is the
 * outcome they were told to expect.
 *
 * @param category - The category the confirmation is about.
 * @returns One or two sentences naming the category and its filed-post count.
 */
function describeDeletion(category: CategoryPublic): string {
  const { name, post_count: postCount } = category;

  if (postCount === 0) {
    return `No posts are filed under “${name}”, so it can be removed. This cannot be undone.`;
  }

  const posts = postCount === 1 ? '1 post is' : `${String(postCount)} posts are`;

  return `${posts} still filed under “${name}”. Deleting a category that is still in use is refused, so re-file or remove those posts first.`;
}

/**
 * The destructive affordance, behind a confirmation the operator has to answer.
 *
 * Radix supplies the modal behaviour - focus is trapped inside the panel, `Escape` dismisses it,
 * the page behind it does not scroll, and the panel is named by its title and described by its
 * description. Hand-rolling any of that would be a worse copy of it, and a native `window.confirm`
 * would be worse still: it cannot be named, cannot be styled from the token layer, and cannot show
 * the refusal below.
 *
 * A refusal is a normal outcome here, not an exception to hide. The service refuses to delete a
 * category that still classifies posts, and that refusal carries prose written to be shown to the
 * person who attempted it - so it is rendered *inside* the open dialog, next to the count that
 * predicted it, rather than as a toast that disappears.
 *
 * While the request is in flight the dialog deliberately refuses to close. The alternative is worse:
 * dismissing it mid-flight would leave the operator with no way to see a refusal that has not
 * arrived yet, which is the one message they most need.
 */
function DeleteCategoryDialog({
  category,
  onDeleted,
  disabled,
}: {
  readonly category: CategoryPublic;
  readonly onDeleted: (() => void) | undefined;
  readonly disabled: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const deletion = useMutation({
    mutationFn: (): Promise<void> => deleteAdminCategory(category.id),
    onSuccess: async (): Promise<void> => {
      // A delete changes how many categories exist, so the overview counts move with the list.
      await invalidateAdminCategoryQueries(queryClient, { includeStats: true });
      toast.success(`Category “${category.name}” deleted.`);
      setFailure(null);
      setOpen(false);
      onDeleted?.();
    },
    onError: (error: Error): void => {
      setFailure(error);
    },
  });

  const pending = deletion.isPending;

  /**
   * Open and close the dialog, discarding a stale refusal on the way out.
   *
   * Closing is ignored while the request is in flight, which covers `Escape`, an outside press and
   * the panel's own dismiss control alike, since Radix routes all three through here.
   */
  function handleOpenChange(nextOpen: boolean): void {
    if (pending) {
      return;
    }

    setOpen(nextOpen);

    if (!nextOpen) {
      setFailure(null);
    }
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger asChild>
        <Button disabled={disabled} type="button" variant="destructive">
          <Trash2 aria-hidden="true" />
          {DELETE_TRIGGER_LABEL}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle className={USER_TEXT_CLASSES}>Delete “{category.name}”?</DialogTitle>
        <DialogDescription className={USER_TEXT_CLASSES}>
          {describeDeletion(category)}
        </DialogDescription>
        {failure === null ? null : <FailureAlert failure={failure} />}
        <div className={DIALOG_ACTIONS_CLASSES}>
          <DialogClose asChild>
            <Button disabled={pending} type="button" variant="secondary">
              {DELETE_CANCEL_LABEL}
            </Button>
          </DialogClose>
          <Button
            disabled={pending}
            onClick={(): void => {
              deletion.mutate();
            }}
            type="button"
            variant="destructive"
          >
            <ActionLabel
              icon={Trash2}
              label={DELETE_CONFIRM_LABEL}
              pending={pending}
              pendingLabel={DELETE_CONFIRM_PENDING_LABEL}
            />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Create mode
 * ---------------------------------------------------------------------------------------------- */

/**
 * The values a create form starts and returns to.
 *
 * `description` starts as `''` rather than absent because a textarea cannot hold "absent"; the schema
 * folds a blank one to `null` on submit, so an untouched description posts the same value an omitted
 * field would have.
 */
const CREATE_DEFAULT_VALUES: CategoryCreateFormValues = { name: '', description: '' };

/**
 * Create a category.
 *
 * Bound to `categoryCreateSchema`, so `name` is required here and the submitted body is exactly the
 * two members the service accepts - projected explicitly rather than forwarded wholesale, so that
 * anything a future revision adds to this form's state cannot silently reach the wire. The schema is
 * strict on both sides of that contract: an unrecognised member is reported rather than dropped.
 *
 * On success the form empties itself, because an administrator seeding a taxonomy enters several
 * categories in a row and the next one should not have to be cleared by hand first.
 */
function CreateCategoryForm({
  onSuccess,
  className,
}: {
  readonly onSuccess: ((category: CategoryPublic) => void) | undefined;
  readonly className: string | undefined;
}): JSX.Element {
  const queryClient = useQueryClient();
  const idBase = useId();
  const [failure, setFailure] = useState<unknown>(null);

  const form = useForm<CategoryCreateFormValues>({
    resolver: zodResolver(categoryCreateSchema),
    defaultValues: CREATE_DEFAULT_VALUES,
  });

  const creation = useMutation({
    mutationFn: (values: CategoryCreateFormValues): Promise<CategoryPublic> =>
      createAdminCategory({ name: values.name, description: values.description }),
    onSuccess: async (created: CategoryPublic): Promise<void> => {
      // A create changes how many categories exist, so the overview counts move with the list.
      await invalidateAdminCategoryQueries(queryClient, { includeStats: true });
      toast.success(`Category “${created.name}” created.`);
      form.reset(CREATE_DEFAULT_VALUES);
      onSuccess?.(created);
    },
    onError: (error: Error): void => {
      const attached = applySubmitFailureToFields(error, (field, message) => {
        form.setError(field, { type: SERVER_ERROR_TYPE, message });
      });

      setFailure(attached ? null : error);
    },
  });

  const pending = creation.isPending;
  const submitRef = useRef<HTMLButtonElement>(null);

  useFocusRestoredAfterPending(pending, submitRef);

  return (
    <form
      aria-label={CREATE_FORM_LABEL}
      className={cn(FORM_CLASSES, className)}
      noValidate
      onSubmit={(event): void => {
        void form.handleSubmit((values) => {
          setFailure(null);
          creation.mutate(values);
        })(event);
      }}
    >
      {failure === null ? null : <FailureAlert failure={failure} />}
      <CategoryFields
        descriptionError={form.formState.errors.description?.message}
        descriptionRegistration={form.register('description')}
        idBase={idBase}
        nameError={form.formState.errors.name?.message}
        nameRegistration={form.register('name')}
        pending={pending}
      />
      <div className={ACTIONS_CLASSES}>
        <Button disabled={pending} ref={submitRef} type="submit">
          <ActionLabel
            icon={Plus}
            label={CREATE_SUBMIT_LABEL}
            pending={pending}
            pendingLabel={CREATE_SUBMIT_PENDING_LABEL}
          />
        </Button>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Rename mode
 * ---------------------------------------------------------------------------------------------- */

/**
 * Seed a rename form from the category it is editing.
 *
 * `description` is coalesced to `''` because a nullable column and a textarea disagree about how to
 * spell "nothing": the column says `null`, the control can only hold a string. The schema folds the
 * blank back to `null` on submit, so the round trip preserves the distinction.
 *
 * The slug and the filed-post count are read from `category` for display only and are deliberately
 * absent here - a value that is not in the form's state cannot be submitted by accident.
 */
function toRenameDefaultValues(category: CategoryPublic): CategoryUpdateFormValues {
  return { name: category.name, description: category.description ?? '' };
}

/**
 * Reduce a rename form's values to the members that actually changed.
 *
 * This is what makes the request a genuine partial update rather than a whole-object replacement.
 * Resending an untouched field would let a stale copy of this form silently revert an edit made
 * elsewhere between load and save - the exact defect the service's partial `PATCH` was designed to
 * remove - so a member the operator did not touch is omitted, and the service leaves it alone.
 *
 * @param values - The validated form values.
 * @param dirty - `formState.dirtyFields`, which marks a member only while it differs from the value
 * the form loaded with; typing an edit and then undoing it leaves nothing marked.
 * @returns The request body, carrying only what changed.
 */
function toChangedFields(
  values: CategoryUpdateFormValues,
  dirty: { readonly name?: boolean; readonly description?: boolean },
): CategoryUpdate {
  return {
    ...(dirty.name === true ? { name: values.name } : {}),
    ...(dirty.description === true ? { description: values.description } : {}),
  };
}

/**
 * Rename or re-describe an existing category, and delete it.
 *
 * Bound to `categoryUpdateSchema`, in which every member is optional - which is why this is a
 * separate component from the create form rather than the same one with a flag. The two inferred
 * value types differ, and giving each its own `useForm` is what lets both type-check exactly instead
 * of meeting in the middle behind an assertion.
 *
 * Saving is inert until something differs from what loaded, so a submit always carries a change;
 * the hint beneath the control says so, rather than leaving a dead button unexplained. On success the
 * form re-seeds itself from the category the service returned - which is the authority on what was
 * stored, since it trims the name - so the values shown are the values saved and nothing reads as
 * unsaved afterwards.
 */
function RenameCategoryForm({
  category,
  onSuccess,
  onDeleted,
  className,
}: {
  readonly category: CategoryPublic;
  readonly onSuccess: ((category: CategoryPublic) => void) | undefined;
  readonly onDeleted: (() => void) | undefined;
  readonly className: string | undefined;
}): JSX.Element {
  const queryClient = useQueryClient();
  const idBase = useId();
  const [failure, setFailure] = useState<unknown>(null);

  const form = useForm<CategoryUpdateFormValues>({
    resolver: zodResolver(categoryUpdateSchema),
    defaultValues: toRenameDefaultValues(category),
  });

  const update = useMutation({
    mutationFn: (payload: CategoryUpdate): Promise<CategoryPublic> =>
      updateAdminCategory(category.id, payload),
    onSuccess: async (updated: CategoryPublic): Promise<void> => {
      // A rename moves no count, so the overview stats are deliberately left alone.
      await invalidateAdminCategoryQueries(queryClient, { includeStats: false });
      toast.success(`Category “${updated.name}” saved.`);
      form.reset(toRenameDefaultValues(updated));
      onSuccess?.(updated);
    },
    onError: (error: Error): void => {
      const attached = applySubmitFailureToFields(error, (field, message) => {
        form.setError(field, { type: SERVER_ERROR_TYPE, message });
      });

      setFailure(attached ? null : error);
    },
  });

  const pending = update.isPending;
  const submitHintId = `${idBase}-submit-hint`;
  const submitRef = useRef<HTMLButtonElement>(null);

  useFocusRestoredAfterPending(pending, submitRef);

  return (
    <form
      aria-label={`Edit the category ${category.name}`}
      className={cn(FORM_CLASSES, className)}
      noValidate
      onSubmit={(event): void => {
        void form.handleSubmit((values) => {
          setFailure(null);
          update.mutate(toChangedFields(values, form.formState.dirtyFields));
        })(event);
      }}
    >
      {failure === null ? null : <FailureAlert failure={failure} />}
      <CategoryFacts category={category} />
      <CategoryFields
        descriptionError={form.formState.errors.description?.message}
        descriptionRegistration={form.register('description')}
        idBase={idBase}
        nameError={form.formState.errors.name?.message}
        nameRegistration={form.register('name')}
        pending={pending}
      />
      <div className={ACTIONS_CLASSES}>
        <div className={ACTIONS_PRIMARY_GROUP_CLASSES}>
          <Button
            aria-describedby={submitHintId}
            disabled={pending || !form.formState.isDirty}
            ref={submitRef}
            type="submit"
          >
            <ActionLabel
              icon={Save}
              label={RENAME_SUBMIT_LABEL}
              pending={pending}
              pendingLabel={RENAME_SUBMIT_PENDING_LABEL}
            />
          </Button>
          <p className={FIELD_HINT_CLASSES} id={submitHintId}>
            {RENAME_SUBMIT_HINT}
          </p>
        </div>
        <DeleteCategoryDialog category={category} disabled={pending} onDeleted={onDeleted} />
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Public entry point
 * ---------------------------------------------------------------------------------------------- */

/** The props `admin/categories/page.tsx` renders this form with. */
export interface CategoryFormProps {
  /**
   * The category being edited, or absent to create a new one.
   *
   * This single member selects the mode. Passing it switches the form to a partial update against
   * that category's identifier, shows its permanent address and filed-post count as read-only
   * context, and reveals the delete affordance.
   */
  category?: CategoryPublic;
  /**
   * Called with the stored category after a create or a save succeeds.
   *
   * The category is the service's own representation of the row, not the submitted values, so it
   * carries the identifier and the derived slug the client never sends. A page that opened this form
   * in a panel or a dialog closes it from here.
   */
  onSuccess?: (category: CategoryPublic) => void;
  /** Called after a category is deleted. Reachable in rename mode only. */
  onDeleted?: () => void;
  /** Additional classes for the form element, so the page can adjust it to where it placed it. */
  className?: string;
}

/**
 * Create, rename or delete a category.
 *
 * @example Creating, with the page closing its own panel afterwards
 * ```tsx
 * <CategoryForm onSuccess={() => { setPanelOpen(false); }} />
 * ```
 *
 * @example Editing an existing row
 * ```tsx
 * <CategoryForm category={selected} onDeleted={clearSelection} onSuccess={clearSelection} />
 * ```
 *
 * @param props - See {@link CategoryFormProps}.
 * @returns Either the create form or the rename form, never both.
 */
export function CategoryForm({
  category,
  onSuccess,
  onDeleted,
  className,
}: CategoryFormProps): JSX.Element {
  if (category === undefined) {
    return <CreateCategoryForm className={className} onSuccess={onSuccess} />;
  }

  // Keyed by identifier so that pointing this form at a different row remounts it, which re-seeds
  // the values from that row. Re-seeding through an effect instead would fight the operator: a
  // refetch of the same row would discard an edit in progress, whereas a remount happens only when
  // the row itself changes.
  return (
    <RenameCategoryForm
      category={category}
      className={className}
      key={category.id}
      onDeleted={onDeleted}
      onSuccess={onSuccess}
    />
  );
}
