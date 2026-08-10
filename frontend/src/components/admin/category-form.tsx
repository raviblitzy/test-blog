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

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { JSX, RefObject } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { invalidateForAdminMutation } from '@/lib/admin-cache';
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
 * Cache invalidation lives in `@/lib/admin-cache`, not here.
 *
 * This file's three mutations name their edge in that module's dependency graph rather than composing
 * a key list of their own. That is where the
 * cascades that justify each edge are recorded, and it is why the four admin components can no longer
 * disagree about what a given write staled.
 *
 * The three edges this file uses are unchanged in effect: a create and a delete refresh the category
 * table and the overview counts, because both change how many categories exist; a rename refreshes the
 * table alone, because it moves no count. A successful delete needs no posts refresh either - the
 * service refuses to delete a category any post is still filed under.
 *
 * The public category list - the one the home feed's filter is drawn from - is a Server Component's
 * own read rather than an entry in this cache, so there is nothing here to invalidate for it.
 *
 * Every call is awaited, which keeps the mutation pending until the refetch settles: the submit
 * control stays disabled until the table the operator is looking at actually reflects the change,
 * which is what stops a doubled create.
 */

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
 * but the operation can, and does. Reading `CategoryService`'s raise sites:
 *
 *   * **On submit, the conflict is a taken NAME.** `categories.name` is uniquely constrained, and
 *     both `create` and `update` pre-check it and raise "A category with that name already exists."
 *     The remedy is to change the name, so the message belongs on the name field.
 *   * **A slug collision is NOT a submit conflict**, and this is the correction worth stating,
 *     because the opposite reads plausibly. The slug is not submitted at all: the service derives it
 *     from the name and then hands it to `unique_slug`, which appends a deterministic suffix until it
 *     does not collide. So filing a second "Machine Learning" after a `machine-learning` already
 *     exists SUCCEEDS, with a suffixed slug, and the resolved value comes back in the response - it
 *     is not something the operator is asked to resolve. `update` does not re-derive the slug at all:
 *     a rename retains the address the taxonomy is linked and crawled under.
 *
 *     One residual case does name both columns - `_DETAIL_NAME_OR_SLUG_TAKEN` - and it is a RACE
 *     rather than a rule: two concurrent writers that both passed the pre-check, reported by the
 *     database instead of by the service. The remedy is identical (choose another name), which is why
 *     it lands on the same field and needs no branch of its own here.
 *   * **On delete, the only conflict is the in-use guard**: "Posts are still filed under this
 *     category. Re-file them before deleting it." That is not a field error at all - no control on
 *     this form caused it and none can fix it.
 *
 * Hence {@link applySubmitFailureToFields} is used on the submit path only, and the delete flow
 * renders its refusal in place instead.
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
 * Put focus back somewhere useful once a request settles.
 *
 * Disabling the submit control while a request is in flight is what stops a doubled submission, but
 * a disabled element cannot hold focus - so the moment it is disabled the browser drops focus to
 * `<body>`, and a keyboard reader who pressed Enter loses their place. This puts them back once the
 * form is interactive again.
 *
 * Where "back" is depends on how the request ended, which is why the destination is the caller's to
 * decide rather than a single ref: after a refusal that named a field it is that field, so the reader
 * lands on the control they have to change; after a successful rename it cannot be the submit button,
 * because re-seeding the form clears the dirty state and the button correctly goes inert. That second
 * case is the one this hook used to give up on, leaving focus on `<body>` after a save that worked.
 *
 * The restoration is deliberately conservative, and each guard removes a way it could misbehave:
 *
 *   - it runs in an effect keyed on the pending flag, so the DOM has already been repainted and the
 *     controls are genuinely re-enabled by the time anything is focused - no timer, no polling;
 *   - it acts only on the true-to-false edge, so a re-render for any other reason cannot move focus;
 *   - it acts only while focus is still on `<body>`, so it never steals focus from a reader who
 *     moved on, nor from the field that `shouldFocusError` just focused after a failed validation.
 *
 * Because the focus is programmatic, Chrome matches `:focus-visible` only when the reader was
 * already navigating by keyboard - so a ring reappears for them and not for someone who clicked.
 *
 * @param pending - Whether the mutation is in flight.
 * @param restore - Called on the settling edge, with focus still on `<body>`. Must be stable, so
 * wrap it in `useCallback`: it is an effect dependency.
 */
function useFocusRestoredAfterPending(pending: boolean, restore: () => void): void {
  const wasPending = useRef(pending);

  useEffect(() => {
    const settled = wasPending.current && !pending;
    wasPending.current = pending;

    if (!settled || document.activeElement !== document.body) {
      return;
    }

    restore();
  }, [pending, restore]);
}

/**
 * Build the restoration a settled request should perform, for either mode.
 *
 * The order is a preference list, and each step exists for a case that actually happens:
 *
 *   1. **The first field the service objected to**, when it named one. `setError` alone leaves the
 *      message beside a control nobody is looking at; `setFocus` puts the reader on it. It is not
 *      done at `setError` time - `shouldFocus` would fire while every control is still `disabled` by
 *      the in-flight request, and focusing a disabled element is a no-op.
 *   2. **The submit control**, when it is still enabled. That is the create form after any outcome,
 *      and the rename form after a refusal, where the values are still dirty. It is where the reader
 *      pressed Enter, so it is the least surprising place to be.
 *   3. **The name field**, which is always enabled once the request has settled. This is the
 *      successful-rename case: the submit button is inert by design, and landing on the first
 *      control of the form is both stable and useful, rather than being dumped at the top of the
 *      document.
 *
 * @param setFocus - `useForm().setFocus`, which reaches a field through its registered ref.
 * @param submit - The submit control, which may be disabled by the time this runs.
 * @param invalidField - The first field a refusal named, or `null`.
 * @returns The restoration to hand to {@link useFocusRestoredAfterPending}.
 */
function focusRestorer(
  setFocus: (name: CategoryFieldName) => void,
  submit: RefObject<HTMLButtonElement | null>,
  invalidField: CategoryFieldName | null,
): () => void {
  return (): void => {
    if (invalidField !== null) {
      setFocus(invalidField);

      return;
    }

    const control = submit.current;

    if (control !== null && !control.disabled) {
      control.focus();

      return;
    }

    setFocus('name');
  };
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
      // A delete changes how many categories exist, so the overview counts move with the list. No
      // posts refresh is needed: the service refuses to delete a category any post is still filed
      // under, so a delete that succeeded unfiled nothing.
      await invalidateForAdminMutation(queryClient, 'category.delete');
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
  /**
   * The first field the service objected to, held until the form is interactive enough to focus it.
   *
   * Cleared as each submission starts, so a message from the previous attempt cannot pull focus after
   * a later one succeeded.
   */
  const [invalidField, setInvalidField] = useState<CategoryFieldName | null>(null);

  const form = useForm<CategoryCreateFormValues>({
    resolver: zodResolver(categoryCreateSchema),
    defaultValues: CREATE_DEFAULT_VALUES,
  });

  const creation = useMutation({
    mutationFn: (values: CategoryCreateFormValues): Promise<CategoryPublic> =>
      createAdminCategory({ name: values.name, description: values.description }),
    onSuccess: async (created: CategoryPublic): Promise<void> => {
      // A create changes how many categories exist, so the overview counts move with the list.
      await invalidateForAdminMutation(queryClient, 'category.create');
      toast.success(`Category “${created.name}” created.`);
      form.reset(CREATE_DEFAULT_VALUES);
      onSuccess?.(created);
    },
    onError: (error: Error): void => {
      let first: CategoryFieldName | null = null;
      const attached = applySubmitFailureToFields(error, (field, message) => {
        first ??= field;
        form.setError(field, { type: SERVER_ERROR_TYPE, message });
      });

      setInvalidField(first);
      setFailure(attached ? null : error);
    },
  });

  const pending = creation.isPending;
  const submitRef = useRef<HTMLButtonElement>(null);
  const { setFocus } = form;

  useFocusRestoredAfterPending(
    pending,
    useCallback(() => focusRestorer(setFocus, submitRef, invalidField)(), [invalidField, setFocus]),
  );

  return (
    <form
      aria-label={CREATE_FORM_LABEL}
      className={cn(FORM_CLASSES, className)}
      noValidate
      onSubmit={(event): void => {
        void form.handleSubmit((values) => {
          setFailure(null);
          setInvalidField(null);
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
  /** See {@link CreateCategoryForm}'s copy of this: the first field the service objected to. */
  const [invalidField, setInvalidField] = useState<CategoryFieldName | null>(null);
  /**
   * The stored category this form is editing - the single authority for everything OUTSIDE the
   * controls.
   *
   * Seeded from the prop and replaced by every successful response, because the response is what was
   * actually stored: the service trims the name, and it is the only thing that knows the filed-post
   * count after a concurrent change. The form's editable values are re-seeded from the same object in
   * the same commit, so the input, the form's accessible name, the read-only facts, the delete
   * confirmation and the delete toast can never disagree about which category is on screen.
   *
   * Before this existed they could, and did: the values came from the response while every surrounding
   * label still read the original prop. `onSuccess` is optional, so a consumer that renders this form
   * inline - rather than closing a panel over it - showed the new name in the field while the heading
   * and the delete dialog still named the old one.
   *
   * Prop changes for the SAME row are deliberately not adopted here. The public entry point keys this
   * component by identifier, so pointing it at a different category remounts it and re-seeds
   * everything; adopting a refetch of the same row instead would discard an edit in progress, which is
   * the trade this file already documents at its `key`.
   */
  const [persisted, setPersisted] = useState<CategoryPublic>(category);

  const form = useForm<CategoryUpdateFormValues>({
    resolver: zodResolver(categoryUpdateSchema),
    defaultValues: toRenameDefaultValues(category),
  });

  const update = useMutation({
    mutationFn: (payload: CategoryUpdate): Promise<CategoryPublic> =>
      updateAdminCategory(persisted.id, payload),
    onSuccess: async (updated: CategoryPublic): Promise<void> => {
      // A rename moves no count, so the overview stats are deliberately left alone.
      await invalidateForAdminMutation(queryClient, 'category.update');
      toast.success(`Category “${updated.name}” saved.`);
      // Both authorities move together, from the same object: what the form holds, and what every
      // label around it reads.
      setPersisted(updated);
      form.reset(toRenameDefaultValues(updated));
      onSuccess?.(updated);
    },
    onError: (error: Error): void => {
      let first: CategoryFieldName | null = null;
      const attached = applySubmitFailureToFields(error, (field, message) => {
        first ??= field;
        form.setError(field, { type: SERVER_ERROR_TYPE, message });
      });

      setInvalidField(first);
      setFailure(attached ? null : error);
    },
  });

  const pending = update.isPending;
  const submitHintId = `${idBase}-submit-hint`;
  const submitRef = useRef<HTMLButtonElement>(null);
  const { setFocus } = form;

  useFocusRestoredAfterPending(
    pending,
    useCallback(() => focusRestorer(setFocus, submitRef, invalidField)(), [invalidField, setFocus]),
  );

  return (
    <form
      aria-label={`Edit the category ${persisted.name}`}
      className={cn(FORM_CLASSES, className)}
      noValidate
      onSubmit={(event): void => {
        void form.handleSubmit((values) => {
          setFailure(null);
          setInvalidField(null);
          update.mutate(toChangedFields(values, form.formState.dirtyFields));
        })(event);
      }}
    >
      {failure === null ? null : <FailureAlert failure={failure} />}
      <CategoryFacts category={persisted} />
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
        {/* The same authority the labels and facts read, so the confirmation names the category as it
            is stored now rather than as it was when this form mounted. */}
        <DeleteCategoryDialog category={persisted} disabled={pending} onDeleted={onDeleted} />
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
