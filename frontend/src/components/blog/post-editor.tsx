'use client';

/* =================================================================================================
 * The authoring surface: create, edit, publish, unpublish and delete one post.
 *
 * This is requirement R2 of the technical specification - "create, edit, delete, and publish blog
 * posts" - and it is the component that finally retires the legacy `PUT /items/{item_id}` handler at
 * `app.py:L34-L40`. That handler replaced the WHOLE object on every write: it took a complete `Item`
 * and assigned it over the stored one, so omitting a field erased it and there was no way to change
 * a title without resending the price. Every save from this editor is a genuine PARTIAL update - a
 * `PATCH` carrying only the fields the author actually changed, computed by diffing against the post
 * as the server last reported it. The legacy `{"message": ..., "data": ...}` envelope that handler
 * returned is gone too; every response here is a bare resource representation or, for the delete,
 * `204 No Content` with no body at all.
 *
 * ### Four decisions that shape everything below
 *
 * 1. **Publishing is a state TRANSITION, not a form field.** §0.1.2's restatement of R2 requires
 *    "publish/unpublish as first-class state transitions rather than a boolean flag toggled through
 *    a general update", and the database backs that with
 *    `CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)` - the published state and its
 *    publication instant are inseparable, and only `POST /posts/{id}/publish` sets both. So `status`
 *    is not a control on this form, not a checkbox, and not a select option. It is not even
 *    REPRESENTABLE: `postCreateSchema` is a `z.strictObject` over exactly five keys, so the compiler
 *    rejects a body carrying `status` before any test can. Publishing a brand-new post is therefore
 *    two sequential calls - create, then publish - and the interesting case is the one where the
 *    second fails; see {@link PostEditor}'s `persist` handler.
 *
 * 2. **Mutations key on the UUID `id`; only the detail read keys on the `slug`.** `getPost(slug)`
 *    but `updatePost(id)`, `deletePost(id)`, `publishPost(id)`, `unpublishPost(id)`. The slug is
 *    derived once by `backend/app/core/slug.py` at creation and never changes afterwards, because it
 *    is the canonical URL that SEO depends on. Nothing here generates, edits or submits a slug; the
 *    slug is shown read-only so an author can see the URL their post will live at.
 *
 * 3. **The five-key allow-list is built explicitly, never spread.** Both request bodies are
 *    assembled key by key in {@link buildCreateBody} and {@link buildPatchBody}. A spread of the
 *    form values would compile today and silently start shipping whatever a future field adds, so
 *    the enumeration is the structural guarantee that `id`, `slug`, `status`, `published_at`,
 *    `view_count` and `author_id` cannot reach the wire - they are server-owned, and this client is
 *    not their author.
 *
 * 4. **Multi-category selection is a documented graceful degradation.** See the comment on
 *    {@link CATEGORY_TOGGLE_RATIONALE}.
 *
 * ### What this component deliberately does NOT do
 *
 * - No Markdown parsing and no sanitisation. The live preview renders through
 *   `@/components/blog/post-content`, the tier's ONLY Markdown renderer, which is why that component
 *   is deliberately directive-free. Reuse is not a shortcut here: it is the only way authoring and
 *   reading can be guaranteed to render and sanitise identically. `bleach` sanitises on write in
 *   `backend/app/services/post_service.py`; `rehype-sanitize` sanitises at render. Neither job
 *   belongs to a form.
 * - No optimistic updates. §0.6.5 confines those to the like button and the comment form, where
 *   latency is visible and the operation is trivially retryable. Every mutation here is awaited and
 *   the returned `PostDetail` becomes the new baseline.
 * - No upload control of any kind. §0.9.3 excludes file upload, image processing and object storage,
 *   so a cover image is a URL reference to an allow-listed host.
 * - No authorisation decision. Hiding a control is not a security boundary: the `(dashboard)` route
 *   group and `frontend/src/middleware.ts` gate arrival, and `post_service.py` re-checks ownership
 *   (owner or `ADMIN`) on every mutation. Nothing here reads, decodes or verifies a token.
 * ============================================================================================== */

import type { JSX, ReactNode } from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { EyeOff, LoaderCircle, Save, Send, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';

import { PostContent } from '@/components/blog/post-content';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge, POST_STATUS_BADGE_VARIANTS } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { isApiError } from '@/lib/api/client';
import { createPost, deletePost, publishPost, unpublishPost, updatePost } from '@/lib/api/posts';
import { DASHBOARD_ROUTE, postEditRoute } from '@/lib/routes';
import type {
  CategoryPublic,
  CategorySummary,
  PostCreate,
  PostDetail,
  PostUpdate,
} from '@/lib/types';
import { IMAGE_HOST_ALLOWLIST, cn } from '@/lib/utils';
import { postCreateSchema, postUpdateSchema } from '@/lib/validation/post';
import type { PostUpdateFormValues } from '@/lib/validation/post';

/* -------------------------------------------------------------------------------------------------
 * Form values and validation
 * ---------------------------------------------------------------------------------------------- */

/**
 * The shape react-hook-form holds while the author types.
 *
 * This is `PostUpdateFormValues` - every member optional - and that choice is load-bearing rather
 * than lazy. `Resolver<T>` from react-hook-form is INVARIANT in `T`, because `T` appears both as a
 * parameter (the values handed to the resolver) and inside the result (the values handed back). So
 * `mode === 'create' ? zodResolver(postCreateSchema) : zodResolver(postUpdateSchema)` does not
 * typecheck in either direction: neither resolver is assignable to the other's type, and forcing it
 * needs a cast that asserts something the compiler has correctly refused to believe.
 *
 * Typing the FIELD values as the all-optional superset dissolves the problem instead of asserting
 * past it. `postUpdateSchema` is `postCreateSchema.partial()`, so both schemas satisfy
 * `z.ZodType<PostEditorFormValues, PostEditorFormValues>` - see {@link PostEditor}'s `schema`
 * binding - and `zodResolver` yields a single `Resolver<PostEditorFormValues>` with no assertion
 * anywhere in this file.
 *
 * The cost is that a validated create body must narrow `title` and `content` from
 * `string | undefined` to `string`. {@link buildCreateBody} does exactly that, and the narrowing is
 * not ceremony: it is the compiler forcing the five-key allow-list to be written out by hand, which
 * is precisely the guarantee decision 3 in this file's header depends on.
 */
type PostEditorFormValues = PostUpdateFormValues;

/**
 * The five keys this form owns - the complete set, in the order they are rendered.
 *
 * Used to decide whether a server-reported validation error names a field the author can actually
 * see and fix. Anything outside this set belongs in the summary banner, because pinning a message to
 * a control that is not on screen is worse than not pinning it at all.
 */
const FORM_FIELD_NAMES = [
  'title',
  'excerpt',
  'content',
  'cover_image_url',
  'category_ids',
] as const;

type FormFieldName = (typeof FORM_FIELD_NAMES)[number];

/**
 * Resolve a server-reported field name onto one of this form's controls, or `null`.
 *
 * The API reports `field` as the path the failure occurred at, and the path has a variable prefix and
 * a variable suffix. It may be qualified (`body.title`) or bare (`title`) depending on where in the
 * request the value sat, and it may descend INTO a value: a rejected member of the category list
 * arrives as `category_ids.0`, and through a body prefix as `body.category_ids.2`.
 *
 * So the match is on the FIRST segment that names a control, scanning left to right. Every one of
 * those four shapes then lands on the right control:
 *
 * | Reported path          | Resolves to     |
 * | ---------------------- | --------------- |
 * | `title`                | `title`         |
 * | `body.title`           | `title`         |
 * | `category_ids.0`       | `category_ids`  |
 * | `body.category_ids.2`  | `category_ids`  |
 *
 * Matching the LAST segment instead - which reads as the obvious normalisation, because it handles
 * the prefix without knowing what the prefix is - silently drops exactly the indexed cases: the leaf
 * of `category_ids.0` is `0`, which names no control, so the message went to the summary banner while
 * the category group it was about showed nothing. The author was told a category was wrong and given
 * no indication which control to look at.
 *
 * An index is deliberately NOT carried through to the control. The group renders one error region for
 * the whole selection rather than one per option, because a category is chosen by toggling a badge
 * and there is no per-option control for a message to sit beside; the service's prose already names
 * the offending identifier when it matters.
 *
 * `Array.prototype.find` over the literal tuple returns the narrowed member, so no assertion is
 * needed to get from `string` to {@link FormFieldName}.
 */
function toFormFieldName(field: string): FormFieldName | null {
  for (const segment of field.split('.')) {
    const match = FORM_FIELD_NAMES.find((name) => name === segment);
    if (match !== undefined) {
      return match;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------------------------------
 * Baselines and request bodies
 * ---------------------------------------------------------------------------------------------- */

/** Empty-form defaults: the controls are all present, so every text value starts as a string. */
const EMPTY_FORM_VALUES: PostEditorFormValues = {
  title: '',
  excerpt: '',
  content: '',
  cover_image_url: '',
  category_ids: [],
};

/**
 * Project a post onto the FORM's shape.
 *
 * `null` becomes `''` for the two nullable text fields, because a text control's value is a string
 * and binding `null` to one is how React starts warning about uncontrolled inputs. The empty string
 * folds back to `null` on submit - `postCreateSchema` transforms `'' -> null` for both fields - so
 * the round trip is lossless and an author clearing a field genuinely clears it server-side.
 */
function toFormValues(post: PostDetail | null): PostEditorFormValues {
  if (post === null) {
    return EMPTY_FORM_VALUES;
  }
  return {
    title: post.title,
    excerpt: post.excerpt ?? '',
    content: post.content,
    cover_image_url: post.cover_image_url ?? '',
    category_ids: post.categories.map((category) => category.id),
  };
}

/**
 * Project a post onto the WIRE's shape - the baseline a partial update is diffed against.
 *
 * Deliberately distinct from {@link toFormValues}: the diff has to compare like with like, and on
 * the wire an absent excerpt is `null`, not `''`. Comparing a validated `null` against a display
 * `''` would mark an untouched field dirty and resend it on every save, which is how a "partial"
 * update quietly becomes a total one.
 *
 * `category_ids` comes from `post.categories`, which is a `CategorySummary[]`; there is no
 * `category_ids` member on `PostDetail` to read instead.
 */
function toWireBaseline(post: PostDetail | null): PostUpdate {
  if (post === null) {
    return {};
  }
  return {
    title: post.title,
    excerpt: post.excerpt,
    content: post.content,
    cover_image_url: post.cover_image_url,
    category_ids: post.categories.map((category) => category.id),
  };
}

/**
 * Compare two category selections as SETS.
 *
 * Order is not meaning here - a post in "Engineering" and "Design" is the same post whichever chip
 * the author pressed first - so an order-sensitive comparison would report a change after a toggle
 * off and back on and ship a pointless `category_ids` in the patch.
 */
function sameCategorySelection(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

/**
 * Build the `POST /posts` body, or `null` when the two required fields are absent.
 *
 * The five keys are enumerated rather than spread. That is what makes it impossible for `id`,
 * `slug`, `status`, `published_at`, `view_count` or `author_id` to reach the wire - not a test, not a
 * review note, but the shape of this function.
 *
 * `null` is returned rather than thrown for the impossible case. Under `postCreateSchema` the
 * resolver has already rejected a missing title or body, so the caller treats `null` as "validation
 * should have caught this" and surfaces a message instead of creating a half-formed post.
 */
function buildCreateBody(values: PostEditorFormValues): PostCreate | null {
  const { title, content } = values;
  if (title === undefined || content === undefined) {
    return null;
  }
  return {
    title,
    excerpt: values.excerpt ?? null,
    content,
    cover_image_url: values.cover_image_url ?? null,
    category_ids: values.category_ids ?? [],
  };
}

/**
 * Build the `PATCH /posts/{id}` body: only the members that actually differ from `baseline`.
 *
 * This is the genuine partial update that replaces `app.py:L34-L40`. An absent member means "leave
 * this alone", which is why a field is omitted rather than resent - and why correcting a typo in a
 * title sends a body with one key in it.
 *
 * Note the asymmetry between `undefined` and `null` for the two nullable fields: `undefined` omits
 * the member and changes nothing, `null` explicitly clears the stored value. An author who empties
 * the excerpt box means the latter, so `values.excerpt ?? null` folds the form's `''` (already
 * transformed to `null` by the schema) into an explicit clear.
 */
function buildPatchBody(baseline: PostUpdate, values: PostEditorFormValues): PostUpdate {
  const patch: PostUpdate = {};

  if (values.title !== undefined && values.title !== baseline.title) {
    patch.title = values.title;
  }
  if (values.content !== undefined && values.content !== baseline.content) {
    patch.content = values.content;
  }

  const excerpt = values.excerpt ?? null;
  if (excerpt !== (baseline.excerpt ?? null)) {
    patch.excerpt = excerpt;
  }

  const coverImageUrl = values.cover_image_url ?? null;
  if (coverImageUrl !== (baseline.cover_image_url ?? null)) {
    patch.cover_image_url = coverImageUrl;
  }

  const categoryIds = values.category_ids ?? [];
  if (!sameCategorySelection(categoryIds, baseline.category_ids ?? [])) {
    patch.category_ids = categoryIds;
  }

  return patch;
}

/**
 * Join the ids that are actually present into an `aria-describedby` value.
 *
 * Returns `undefined` rather than `''` when nothing applies, because an empty `aria-describedby`
 * points at nothing and is worse than an absent one. The type predicate keeps the filter honest so
 * no assertion is needed to get from `(string | false | null | undefined)[]` to `string[]`.
 */
function describedBy(...ids: readonly (string | false | null | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return present.length > 0 ? present.join(' ') : undefined;
}

/**
 * The human-readable sentence to show for a failed request.
 *
 * Every failure from the API layer arrives as one normalised problem document, so this reads
 * `detail` first - the specific sentence about THIS request - and falls back to the generic `title`,
 * then to the caller's own wording for anything that never reached the API at all (an aborted
 * request, an offline browser). The legacy `{"message": ...}` envelope that `app.py:L18,L39` returned
 * has no reader here; there is exactly one error contract.
 */
function problemMessage(error: unknown, fallback: string): string {
  if (!isApiError(error)) {
    return fallback;
  }
  const { detail, title } = error.problem;
  if (detail.length > 0) {
    return detail;
  }
  return title.length > 0 ? title : fallback;
}

/* -------------------------------------------------------------------------------------------------
 * Field scaffolding
 * ---------------------------------------------------------------------------------------------- */

interface FieldShellProps {
  /** The control itself. Always a project primitive - never a bare `input` or `textarea`. */
  children: ReactNode;
  /** The control's id, from `useId()`. `Label`'s `htmlFor` and this must agree. */
  controlId: string;
  /** The validation message, when there is one. Rendered as TEXT, not as colour. */
  error?: string;
  /** Stable id for the error paragraph, referenced from the control's `aria-describedby`. */
  errorId: string;
  /** Always-present guidance. Explains the field's effect, not its syntax. */
  helper: ReactNode;
  /** Stable id for the helper paragraph, referenced from the control's `aria-describedby`. */
  helperId: string;
  label: string;
  /** Renders an "Optional" hint next to the label. Absent means the field is required. */
  optional?: boolean;
}

/**
 * One labelled field: label, control, permanent guidance, conditional error.
 *
 * Local and unexported - `PostEditor` is this module's entire public API. It exists because the
 * accessibility contract is identical for all four text fields and repeating it four times is how
 * one of the four ends up missing its `aria-describedby` wiring.
 *
 * `aria-invalid` is conspicuously absent here. `Input` and `Textarea` both compute it from their own
 * `invalid` prop (`aria-invalid={ariaInvalid ?? (invalid || undefined)}`), so authoring it a second
 * time at the call site would be a duplicate source of truth for the same fact.
 */
function FieldShell({
  children,
  controlId,
  error,
  errorId,
  helper,
  helperId,
  label,
  optional = false,
}: FieldShellProps): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Label htmlFor={controlId}>{label}</Label>
        {optional ? <span className="text-muted-foreground text-xs">Optional</span> : null}
      </div>
      {children}
      <p className="text-muted-foreground text-xs" id={helperId}>
        {helper}
      </p>
      {/* The message is text, and the control is marked `aria-invalid`, so the failure is conveyed
          two ways that do not depend on perceiving the colour. */}
      {error === undefined ? null : (
        <p className="text-danger text-xs font-medium" id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Operations
 * ---------------------------------------------------------------------------------------------- */

/**
 * The one operation currently in flight, or `null`.
 *
 * A single value rather than five booleans, because the states are mutually exclusive by
 * construction - every control is disabled while any operation runs - and one value makes that
 * impossible to get wrong. It also lets each button show its OWN pending label while the others
 * merely disable, which five independent `isPending` flags cannot express: creating-then-publishing
 * runs `createPost` under the `publish` operation, so the Publish button is the one that reports
 * progress even though the first request is a create.
 */
type EditorOperation = 'save' | 'publish' | 'unpublish' | 'delete';

/** Which confirmation is on screen. One value, so two dialogs can never open at once. */
type ActiveDialog = 'none' | 'delete' | 'discard';

/**
 * Why multi-category selection is a group of toggle buttons rather than a multi-select.
 *
 * `category_ids` is an ARRAY. `@/components/ui/select` wraps `@radix-ui/react-select`, which is
 * single-value, and the `ui/` layer has no checkbox and no toggle-group primitive - adding one is
 * another folder's scope, and adding a dependency would break the pinned-dependency standard. So
 * §0.8.5's graceful-degradation ladder is walked and stopped at the first viable rung: no exact
 * component match exists, but a CLOSE one does, so `ui/button` is used with a prop adjustment and the
 * adjustment is recorded here. Membership is conveyed by `aria-pressed` on each toggle, and the group
 * is named by a real `fieldset`/`legend` pair, which gives it an accessible name with no ARIA at all.
 *
 * The consequence for the rest of the form: nothing on it is single-valued, so `ui/select` is not
 * imported. A forced fit would have been worse than the omission.
 */
const CATEGORY_TOGGLE_RATIONALE =
  'Selected categories are toggled on and off; the pressed state of each button carries membership.';

/* -------------------------------------------------------------------------------------------------
 * Props
 * ---------------------------------------------------------------------------------------------- */

/**
 * A discriminated union rather than `post?: PostDetail`, so "required when editing" is a fact the
 * compiler enforces instead of a sentence in a doc comment. `post?: never` on the create arm also
 * makes `<PostEditor mode="create" post={somePost} />` a compile error, which is the mistake that
 * would otherwise silently produce a create form pre-filled with someone else's post.
 */
export type PostEditorProps =
  | {
      mode: 'create';
      post?: never;
      /**
       * Every category an author may file this post under, as the **bare array**
       * `listCategories()` returns. It is the one documented exception to the page envelope across
       * the whole API, so there is no `.items` to unwrap - and passing it in from the server
       * component keeps this island narrow enough that the editor issues no read at all.
       */
      categories: CategoryPublic[];
      className?: string;
    }
  | {
      mode: 'edit';
      post: PostDetail;
      categories: CategoryPublic[];
      className?: string;
    };

/* -------------------------------------------------------------------------------------------------
 * Component
 * ---------------------------------------------------------------------------------------------- */

/**
 * The post editor.
 *
 * @example Create
 * ```tsx
 * <PostEditor mode="create" categories={await listCategories()} />
 * ```
 *
 * @example Edit
 * ```tsx
 * <PostEditor mode="edit" post={post} categories={categories} />
 * ```
 */
export function PostEditor({ mode, post, categories, className }: PostEditorProps): JSX.Element {
  const router = useRouter();

  /**
   * The post this editor is currently bound to, or `null` when nothing has been created yet.
   *
   * Every branch below keys on THIS rather than on `mode`, and that is the defence against the worst
   * bug this component could have. Consider "Publish" on a new post: it creates, and then the publish
   * call fails. The post now exists. If the save path still consulted `mode`, the author's next press
   * would create a SECOND post - two drafts, two slugs, one of them orphaned. Recording the created
   * post here switches the editor onto the update path the instant the create succeeds, so a retry
   * after a partial failure retries only the part that failed.
   */
  const [persisted, setPersisted] = useState<PostDetail | null>(post ?? null);
  const [operation, setOperation] = useState<EditorOperation | null>(null);
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>('none');
  /**
   * The controls that OPEN each confirmation, held so focus can be handed back when it closes.
   *
   * Radix restores focus to a `DialogTrigger` automatically, but both dialogs here are fully
   * CONTROLLED - `open` is driven by {@link activeDialog} - because the delete confirmation has to
   * stay open across an in-flight request and the discard confirmation is opened conditionally, only
   * when the form is dirty. Neither is expressible with a trigger. Without a trigger Radix has no node
   * to return to, so dismissing a dialog drops focus onto `<body>` and a keyboard user is dumped at
   * the top of the document and has to traverse the whole form again - a WCAG 2.4.3 focus-order
   * failure. `onCloseAutoFocus` on each `DialogContent` restores it explicitly instead.
   */
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const cancelTriggerRef = useRef<HTMLButtonElement>(null);
  /**
   * The first field a server refusal named, held until the form is interactive enough to focus it.
   *
   * State rather than a ref, and deliberately: it is written from `persist`, which the two submit
   * handlers close over, and those handlers are built during render. A ref written along that path
   * trips `react-hooks/refs` - "passing a ref to a function may read its value during render" - which
   * is a blocking lint error under `--max-warnings=0`. A setter carries no such hazard.
   */
  const [pinnedField, setPinnedField] = useState<FormFieldName | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  /** Set when a draft saved but its publish transition did not. Drives the retry affordance. */
  const [publishFailed, setPublishFailed] = useState(false);

  const titleId = useId();
  const excerptId = useId();
  const contentId = useId();
  const coverImageId = useId();
  const categoriesId = useId();
  const previewHeadingId = useId();
  const helperSuffix = 'helper';
  const errorSuffix = 'error';

  /**
   * The mode's schema, annotated as a schema over the form's own value shape.
   *
   * This one annotation is what makes the whole file assertion-free; see
   * {@link PostEditorFormValues}. `postCreateSchema` requires a title and a body,
   * `postUpdateSchema` - its `.partial()` - requires nothing, and both are valid
   * `z.ZodType<PostEditorFormValues, PostEditorFormValues>`.
   */
  const schema: z.ZodType<PostEditorFormValues, PostEditorFormValues> =
    mode === 'create' ? postCreateSchema : postUpdateSchema;

  const defaultValues = useMemo(() => toFormValues(post ?? null), [post]);

  const {
    control,
    formState: { errors, isDirty },
    handleSubmit,
    register,
    reset,
    setError,
    setFocus,
  } = useForm<PostEditorFormValues>({
    defaultValues,
    mode: 'onBlur',
    resolver: zodResolver(schema),
  });

  /**
   * The two values the preview pane reads, subscribed through `useWatch` rather than through the
   * `watch()` function `useForm` also returns.
   *
   * That is not a stylistic preference. `watch()` is a function whose identity cannot be memoized, so
   * the React Compiler refuses to memoize any component that calls it and reports
   * `react-hooks/incompatible-library` - the whole component silently opts out of compilation. It also
   * hands back a fresh array for `category_ids` on every render, which destabilises the memo below.
   * `useWatch` subscribes through `control` and returns a stable value, so both problems disappear at
   * once and the lint gate passes with zero warnings.
   */
  const watchedContent = useWatch({ control, name: 'content' });
  const watchedCategoryIds = useWatch({ control, name: 'category_ids' });
  const previewContent = watchedContent ?? '';

  const isBusy = operation !== null;
  const status = persisted?.status ?? 'DRAFT';
  const isPublished = status === 'PUBLISHED';

  /**
   * The selected categories, projected onto the slim shape the reader-facing renderer takes.
   *
   * Filtered from `categories` rather than mapped from the selection, so the preview lists them in
   * the same order as the toggle group instead of in click order. Ids with no matching category -
   * possible only if the taxonomy changed under an open editor - drop out silently rather than
   * rendering a pill with no name.
   */
  const selectedCategories = useMemo<CategorySummary[]>(() => {
    // The nullish default lives INSIDE the callback on purpose: written as
    // `useWatch(...) ?? []` at the call site it would be a fresh array every
    // render and this memo would never hit.
    const selected = watchedCategoryIds ?? [];
    return categories
      .filter((category) => selected.includes(category.id))
      .map(({ id, name, slug }) => ({ id, name, slug }));
  }, [categories, watchedCategoryIds]);

  /**
   * Warn before a browser-level navigation would discard unsaved edits.
   *
   * Guarded on `typeof window` because this module is imported by a server-rendered route even though
   * it only ever executes in the browser, and torn down on every dependency change so the listener
   * cannot outlive the dirty state that justified it. Calling `preventDefault` is the whole contract
   * in the current specification; assigning `returnValue` is the deprecated spelling of the same
   * request and browsers substitute their own wording either way.
   *
   * This covers reloads and address-bar navigations only. In-app navigation is covered by the discard
   * confirmation on Cancel, which is the case an author actually hits.
   */
  useEffect(() => {
    if (!isDirty || typeof window === 'undefined') {
      return undefined;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return (): void => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isDirty]);

  /* -----------------------------------------------------------------------------------------------
   * Mutations
   *
   * One per operation, each carrying nothing but its `mutationFn`. `retry`, `staleTime`, `gcTime` and
   * `refetchOnWindowFocus` are all owned by `@/providers/query-provider` - which already sets
   * `mutations: { retry: 0 }`, so a rejected save is reported once rather than replayed - and
   * restating any of them here would fork the tier's policy per component.
   *
   * Success and failure are handled at the call site with `mutateAsync` rather than through
   * `onSuccess`/`onError` callbacks, because the publish path is genuinely SEQUENTIAL: the second
   * request's input is the first request's output, and a failure of the second has to be reported
   * differently from a failure of the first. Callback hooks cannot express that ordering; `await`
   * inside one handler can, and it keeps the whole two-call story readable in one place.
   * -------------------------------------------------------------------------------------------- */

  const createMutation = useMutation({
    mutationFn: (body: PostCreate) => createPost(body),
  });
  const updateMutation = useMutation({
    mutationFn: (variables: { changes: PostUpdate; id: string }) =>
      updatePost(variables.id, variables.changes),
  });
  const publishMutation = useMutation({
    mutationFn: (id: string) => publishPost(id),
  });
  const unpublishMutation = useMutation({
    mutationFn: (id: string) => unpublishPost(id),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deletePost(id),
  });

  /**
   * Pin every field-level failure the server reported onto its control, and return the message the
   * summary banner should carry.
   *
   * A `422` arrives as a problem document whose `errors` array names the offending fields, and putting
   * those messages only in a banner would make the author hunt for which control is wrong.
   * `setError` attaches each one to its field, where `FieldShell` renders it as text wired through
   * `aria-describedby` and the primitive marks the control `aria-invalid`. Anything naming a field
   * this form does not render stays in the banner, because pinning a message to a control that is not
   * on screen hides it completely.
   *
   * The first field pinned is also recorded, so focus can be taken to it once the form is
   * interactive again - see the effect below. `setError`'s own `shouldFocus` cannot do that job here:
   * it focuses synchronously, and at the moment this runs every control is still `disabled` by the
   * operation that just failed, so the focus call would land on a disabled element and be discarded.
   */
  const applyFailure = useCallback(
    (error: unknown, fallback: string): string => {
      let pinned = 0;
      if (isApiError(error)) {
        for (const item of error.errors ?? []) {
          const name = toFormFieldName(item.field);
          if (name !== null) {
            setError(name, { message: item.message, type: 'server' });
            if (pinned === 0) {
              setPinnedField(name);
            }
            pinned += 1;
          }
        }
      }
      const message = problemMessage(error, fallback);
      return pinned > 0 ? `${message} Check the highlighted fields for details.` : message;
    },
    [setError],
  );

  /**
   * Take focus to the first field a server refusal named, once the operation has settled.
   *
   * Submitting disables every control, and a disabled element cannot hold focus - so pressing Save
   * drops focus onto `<body>`, and a `422` that pins a message beside the excerpt or the category
   * group would otherwise leave the author reading it with the keyboard parked at the top of the
   * document. This puts them on the control they have to change.
   *
   * It matters most for `category_ids`, which is the one field here with no `Input` or `Textarea` of
   * its own: `setFocus` reaches it through the `Controller` ref attached to the group's first toggle,
   * which is why that ref exists.
   *
   * Three guards, each removing a way this could misbehave: it acts only once, because focusing the
   * target means `activeElement` is no longer `<body>` on any re-run; only when a server failure
   * actually named a field, and every operation clears that record before it starts, so a successful
   * save cannot inherit the previous refusal's target; and only while focus is still on `<body>`, so
   * it never steals focus from an author who moved on, nor from the field the resolver's own
   * `shouldFocusError` has just focused after a client-side validation failure. It waits for the
   * operation to finish for the reason given above - the target is disabled until then.
   *
   * The record is cleared at each operation's start rather than here on purpose: clearing it in this
   * effect would be a `setState` inside an effect, which the React Compiler's lint rules reject.
   */
  useEffect(() => {
    if (isBusy || pinnedField === null || document.activeElement !== document.body) {
      return;
    }

    setFocus(pinnedField);
  }, [isBusy, pinnedField, setFocus]);

  /**
   * Save, and - when that is what the author asked for - publish.
   *
   * The whole of decision 1 in this file's header lands here. Four paths run through it:
   *
   * | Bound post | Intent  | Requests issued                                    |
   * | ---------- | ------- | -------------------------------------------------- |
   * | none       | save    | `POST /posts`                                      |
   * | none       | publish | `POST /posts` then `POST /posts/{createdId}/publish`|
   * | existing   | save    | `PATCH /posts/{id}` with only the changed fields   |
   * | existing   | publish | that `PATCH` (when anything changed) then publish  |
   *
   * The second row is the one that needs care. Those are two requests, and the first can succeed while
   * the second fails - the draft then EXISTS and must not be lost or duplicated. When that happens the
   * editor stays put, rebinds itself to the created post, and says so; the retry then re-enters this
   * same handler with an empty patch and goes straight to the publish call, so only the part that
   * failed is repeated.
   *
   * Rebinding is TWO things, and only the second of them survives the document: this component's
   * `persisted` state, and the browser's address. Both are set as soon as the create resolves, before
   * the publish is attempted - see the `router.replace` below. State alone left `/posts/new` in the
   * address bar over a draft that really existed, so a reload re-entered create mode and the next save
   * wrote a SECOND draft; a guard held in memory cannot see across documents.
   *
   * Publishing always saves first, and that asymmetry with unpublish is deliberate: publishing makes
   * content public, so publishing a stale body would expose the wrong text, whereas unpublishing only
   * withdraws content and cannot be stale.
   */
  const persist = async (
    values: PostEditorFormValues,
    intent: 'save' | 'publish',
  ): Promise<void> => {
    setSummaryError(null);
    setPublishFailed(false);
    // Any field a previous refusal named stops being the focus effect's target here: this attempt
    // gets its own answer, and inheriting the last one would move focus after a save that succeeded.
    setPinnedField(null);
    setOperation(intent === 'publish' ? 'publish' : 'save');

    const target = persisted;
    const wasCreate = target === null;

    try {
      let saved: PostDetail;

      if (target === null) {
        const body = buildCreateBody(values);
        if (body === null) {
          // Unreachable under `postCreateSchema`, which rejects both cases before this runs. Reported
          // rather than thrown so a schema regression surfaces as a message instead of a half-post.
          setSummaryError('Add a title and some content before saving this post.');
          return;
        }
        saved = await createMutation.mutateAsync(body);
      } else {
        const patch = buildPatchBody(toWireBaseline(target), values);
        if (Object.keys(patch).length === 0) {
          if (intent === 'save') {
            toast.info('Nothing has changed since the last save.');
            return;
          }
          // Publishing an unmodified post needs no write. Skipping it is what makes a retry after a
          // failed publish repeat only the publish.
          saved = target;
        } else {
          saved = await updateMutation.mutateAsync({ changes: patch, id: target.id });
        }
      }

      setPersisted(saved);
      // Re-baselining here is what clears `isDirty`, and it must happen only after a write to the
      // body - never after a status transition, which would silently discard edits still on screen.
      reset(toFormValues(saved));

      if (wasCreate) {
        // THE URL IS REBOUND HERE - immediately after the create resolved, and BEFORE the publish
        // attempt below - and the position of this call is the whole point rather than a detail.
        //
        // `setPersisted` above rebinds the COMPONENT to the new post, and that is enough for as long
        // as this JavaScript context survives. It does not survive a reload, a Back-then-Forward, or
        // the author opening the same tab again later; the URL does. Leaving the address at
        // `/posts/new` while a real, persisted draft existed meant a reload re-entered CREATE mode
        // holding the same text, and the next save wrote a SECOND draft - the in-memory guard cannot
        // see across documents, and the author had just been told their draft was safe.
        //
        // The publish path is where that mattered most: it is the one path that can fail AFTER the
        // create succeeded, and it deliberately keeps the author on this screen to retry. So the
        // address has to be correct before the failure can happen, not after the success.
        //
        // `replace` rather than `push`, so Back does not return to an empty editor that would create
        // yet another draft. It changes only the address - the component is already bound, and no
        // remount or refetch follows.
        router.replace(postEditRoute(saved.id));
      }

      if (intent === 'save') {
        toast.success(wasCreate ? 'Draft saved.' : 'Changes saved.');
        if (!wasCreate) {
          // An existing post's Server Components hold the old body; a created one has no rendered
          // route to refresh, and the `replace` above is what puts it on the right address.
          router.refresh();
        }
        return;
      }

      try {
        const published = await publishMutation.mutateAsync(saved.id);
        setPersisted(published);
        toast.success('Post published.');
        if (!wasCreate) {
          router.refresh();
        }
      } catch (error) {
        // The body is saved AND the address now names it, so "the draft is safe" is true of the
        // browser and not merely of this component's state: a reload lands in the editor for the
        // created post rather than in an empty one. Say precisely that, keep the author here, and
        // leave the retry to them.
        setPublishFailed(true);
        setSummaryError(applyFailure(error, 'Could not publish this post.'));
        toast.error(
          wasCreate
            ? 'Draft saved, but publishing failed. The draft is safe - try publishing again.'
            : 'Changes saved, but publishing failed. The changes are safe - try publishing again.',
        );
      }
    } catch (error) {
      setSummaryError(applyFailure(error, 'Could not save this post.'));
      toast.error('Could not save this post.');
    } finally {
      setOperation(null);
    }
  };

  /**
   * The two submitters, each with its intent baked into the closure.
   *
   * There is deliberately no `intentRef` here. A ref read inside a callback that is HANDED to
   * `handleSubmit` during render is exactly what `react-hooks/refs` forbids - the compiler cannot
   * prove the callback is not invoked while rendering, and the rule is an error rather than a warning.
   * Binding the intent at the point the submitter is built removes the shared mutable cell entirely,
   * so there is nothing to read at the wrong time.
   *
   * `Save` stays a real `type="submit"` button and owns the form's default submission, which is what
   * makes pressing Enter in a text field save rather than do nothing - and it is the non-destructive
   * of the two, so it is the right default for a keystroke. `Publish` is a `type="button"` that runs
   * the same validated pipeline explicitly; it is fully keyboard operable and carries its own
   * accessible name, so nothing is lost by not making it a second submitter.
   */
  const onSubmitSave = handleSubmit((values) => persist(values, 'save'));
  const onSubmitPublish = handleSubmit((values) => persist(values, 'publish'));

  /**
   * Withdraw a published post: `POST /posts/{id}/unpublish`.
   *
   * A transition and nothing else - no save, no `reset`. Unsaved edits on screen survive it, because
   * the status is not a form value and withdrawing content cannot expose the wrong text.
   */
  const handleUnpublish = useCallback(async (): Promise<void> => {
    if (persisted === null) {
      return;
    }
    setSummaryError(null);
    setPublishFailed(false);
    setPinnedField(null);
    setOperation('unpublish');
    try {
      const updated = await unpublishMutation.mutateAsync(persisted.id);
      setPersisted(updated);
      toast.success('Post moved back to draft. It is no longer publicly visible.');
      router.refresh();
    } catch (error) {
      setSummaryError(applyFailure(error, 'Could not unpublish this post.'));
      toast.error('Could not unpublish this post.');
    } finally {
      setOperation(null);
    }
  }, [applyFailure, persisted, router, unpublishMutation]);

  /**
   * Delete the post: `DELETE /posts/{id}`, answering `204 No Content`.
   *
   * There is no body to read, so nothing is parsed - resolution is the confirmation. The post's
   * comments and likes go with it through cascading foreign keys, which is why the confirmation copy
   * says so before this ever runs.
   */
  const handleDelete = useCallback(async (): Promise<void> => {
    if (persisted === null) {
      return;
    }
    setSummaryError(null);
    setPinnedField(null);
    setOperation('delete');
    try {
      await deleteMutation.mutateAsync(persisted.id);
      setActiveDialog('none');
      toast.success('Post deleted, along with its comments and likes.');
      router.replace(DASHBOARD_ROUTE);
      router.refresh();
    } catch (error) {
      // Closed so the summary banner behind it is readable; the failure is not the dialog's to show.
      setActiveDialog('none');
      setSummaryError(applyFailure(error, 'Could not delete this post.'));
      toast.error('Could not delete this post.');
    } finally {
      setOperation(null);
    }
  }, [applyFailure, deleteMutation, persisted, router]);

  /**
   * Hand focus back to the control that opened a dialog.
   *
   * `preventDefault` suppresses Radix's own restore attempt - which has nowhere to aim without a
   * trigger - and the optional call covers the case where the dialog closed because the post was
   * deleted and the button is unmounting with the rest of the editor.
   */
  const restoreFocusTo = useCallback(
    (target: 'delete' | 'cancel') =>
      (event: Event): void => {
        event.preventDefault();
        const node = target === 'delete' ? deleteTriggerRef.current : cancelTriggerRef.current;
        node?.focus();
      },
    [],
  );

  /** Leave the editor. Confirms first when there is unsaved work to lose. */
  const handleCancel = useCallback((): void => {
    if (isDirty) {
      setActiveDialog('discard');
      return;
    }
    router.push(DASHBOARD_ROUTE);
  }, [isDirty, router]);

  const discardAndLeave = useCallback((): void => {
    setActiveDialog('none');
    reset(defaultValues);
    router.push(DASHBOARD_ROUTE);
  }, [defaultValues, reset, router]);

  const saveLabel = persisted === null ? 'Save draft' : 'Save';
  const savePendingLabel = persisted === null ? 'Saving draft…' : 'Saving…';
  const publishLabel = publishFailed ? 'Retry publish' : 'Publish';
  /* Mirrors `PostContent`'s own emptiness rule - it renders `null` only when there is neither a body
     NOR a category - so the placeholder appears in exactly the cases the renderer would show nothing,
     and choosing a category lights the preview up with its pills before a word has been written. */
  const hasPreview = previewContent.trim().length > 0 || selectedCategories.length > 0;

  return (
    /* `noValidate` hands validation entirely to the resolver. Without it the browser's own bubble
       fires first on the `type="url"` field and on `required`-looking controls, pre-empting the
       messages this form pins beside each control - two validators, one of which is unstyled,
       untranslated and invisible to the tests. */
    <form className={cn('flex flex-col gap-8', className)} noValidate onSubmit={onSubmitSave}>
      {/* Status and canonical URL. Both are DISPLAYED and neither is submitted: `status` is owned by
          the publish transition and the slug is derived once, server-side, at creation - it is the
          canonical URL the whole SEO story rests on, so nothing here may change it. */}
      {persisted === null ? null : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Badge variant={POST_STATUS_BADGE_VARIANTS[status]}>{status}</Badge>
          <p className="text-muted-foreground min-w-0 text-xs break-words">
            Canonical URL: <span className="font-mono">{`/blog/${persisted.slug}`}</span> — derived
            from the title when the post was created and fixed from then on.
          </p>
        </div>
      )}

      {/* A body saved but not published. `warning` rather than `destructive` because nothing was
          lost - the accurate report is "partially succeeded", and the variant supplies
          `role="status"` so it is announced without interrupting. */}
      {publishFailed ? (
        <Alert variant="warning">
          <AlertTitle as="h2">Saved, but not published</AlertTitle>
          <AlertDescription>
            The post is stored as a draft and nothing was lost. Publishing is a separate step, so
            press “{publishLabel}” to try just that part again.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Hard failures. `destructive` supplies `role="alert"`; nothing here authors a role or an
          `aria-live`, because the variant already determines both. */}
      {summaryError === null ? null : (
        <Alert variant="destructive">
          <AlertTitle as="h2">
            {publishFailed ? 'Why publishing failed' : 'Something went wrong'}
          </AlertTitle>
          <AlertDescription>{summaryError}</AlertDescription>
        </Alert>
      )}

      {/* The responsive spine, exactly as §0.7.3.2 specifies for the editor row: one column with the
          preview BENEATH the fields below 64rem, two columns side by side from 64rem. Nothing changes
          at 48rem here - that breakpoint belongs to the action bar - so at 768px the layout is still
          genuinely stacked. Both panes carry `min-w-0` so a long word, a wide table or a code block in
          the preview shrinks the pane instead of pushing the grid past the viewport. */}
      <div className="grid min-w-0 grid-cols-1 gap-8 pb-0 md:pb-16 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          <FieldShell
            controlId={titleId}
            error={errors.title?.message}
            errorId={`${titleId}-${errorSuffix}`}
            helper="Shown in the feed, on the post page, and in search results. The URL is derived from it once, at creation."
            helperId={`${titleId}-${helperSuffix}`}
            label="Title"
          >
            <Input
              aria-describedby={describedBy(
                `${titleId}-${helperSuffix}`,
                errors.title !== undefined && `${titleId}-${errorSuffix}`,
              )}
              autoComplete="off"
              disabled={isBusy}
              id={titleId}
              invalid={errors.title !== undefined}
              type="text"
              {...register('title')}
            />
          </FieldShell>

          <FieldShell
            controlId={excerptId}
            error={errors.excerpt?.message}
            errorId={`${excerptId}-${errorSuffix}`}
            helper="The summary on the feed card, and the meta description search engines and social cards show. Leave it empty and the post page falls back to its own defaults."
            helperId={`${excerptId}-${helperSuffix}`}
            label="Excerpt"
            optional
          >
            <Textarea
              aria-describedby={describedBy(
                `${excerptId}-${helperSuffix}`,
                errors.excerpt !== undefined && `${excerptId}-${errorSuffix}`,
              )}
              disabled={isBusy}
              id={excerptId}
              invalid={errors.excerpt !== undefined}
              rows={3}
              {...register('excerpt')}
            />
          </FieldShell>

          <FieldShell
            controlId={contentId}
            error={errors.content?.message}
            errorId={`${contentId}-${errorSuffix}`}
            helper="Markdown, with GitHub tables, task lists and strikethrough. The preview renders it through exactly the same pipeline as the published page, so what you see is what a reader gets."
            helperId={`${contentId}-${helperSuffix}`}
            label="Content"
          >
            <Textarea
              aria-describedby={describedBy(
                `${contentId}-${helperSuffix}`,
                errors.content !== undefined && `${contentId}-${errorSuffix}`,
              )}
              className="font-mono"
              disabled={isBusy}
              id={contentId}
              invalid={errors.content !== undefined}
              rows={16}
              spellCheck
              {...register('content')}
            />
          </FieldShell>

          <FieldShell
            controlId={coverImageId}
            error={errors.cover_image_url?.message}
            errorId={`${coverImageId}-${errorSuffix}`}
            /* No upload control anywhere in this form: §0.9.3 excludes file upload, image processing
               and object storage, so a cover image is a reference to an image somebody else already
               hosts. The allow-list is read from `IMAGE_HOST_ALLOWLIST`, which is the same constant
               `next.config.ts` builds `images.remotePatterns` from - naming the hosts twice is how the
               two lists drift and a valid URL starts rendering as a broken image.

               The sentence is now a promise the form keeps rather than advice it hoped for:
               `postCreateSchema` calls `isAllowedImageUrl` on this field, so an address on another
               host - or over plain http, or carrying credentials - is refused here with a message
               beside the control. Before that check existed, such an address saved successfully and
               then rendered nowhere, while the OpenGraph and JSON-LD metadata still advertised it. */
            helper={`A link to an image that is already online — there is no upload. It must be an https URL on one of: ${IMAGE_HOST_ALLOWLIST.join(', ')}, because the image is served through Next.js and only these hosts are allow-listed. Another host is refused here rather than saved and then not shown.`}
            helperId={`${coverImageId}-${helperSuffix}`}
            label="Cover image URL"
            optional
          >
            <Input
              aria-describedby={describedBy(
                `${coverImageId}-${helperSuffix}`,
                errors.cover_image_url !== undefined && `${coverImageId}-${errorSuffix}`,
              )}
              autoComplete="off"
              disabled={isBusy}
              id={coverImageId}
              inputMode="url"
              invalid={errors.cover_image_url !== undefined}
              placeholder="https://images.unsplash.com/photo-…"
              type="url"
              {...register('cover_image_url')}
            />
          </FieldShell>

          {/* Categories. See CATEGORY_TOGGLE_RATIONALE for why this is a toggle group rather than a
              select or a checkbox list. `fieldset` + `legend` gives the group its accessible name with
              no ARIA at all, which is why it is preferred over a label plus `aria-labelledby`.
              `min-w-0` is on the fieldset because a fieldset's default `min-width: min-content` is not
              reset by preflight and would otherwise let a long category name widen the whole grid. */}
          <Controller
            control={control}
            name="category_ids"
            render={({ field }) => {
              const selected = field.value ?? [];
              const errorMessage = errors.category_ids?.message;
              return (
                /* The help and error references and the invalid state belong on the FIELDSET, not on
                   the flex wrapper inside it. The fieldset is the element with the accessible name
                   and the `group` role - it is the control, as far as assistive technology is
                   concerned - so a description hung on an anonymous inner `div` was announced for
                   nothing: entering the group read out its legend and neither the help text nor the
                   failure. `aria-invalid` is authored here for the same reason and is the one place
                   in this form where it is: `Input` and `Textarea` derive their own from their
                   `invalid` prop, but a fieldset is not a primitive and has nothing to derive it
                   from. Both attributes are supported on `group`. */
                <fieldset
                  aria-describedby={describedBy(
                    `${categoriesId}-${helperSuffix}`,
                    errorMessage !== undefined && `${categoriesId}-${errorSuffix}`,
                  )}
                  aria-invalid={errorMessage !== undefined || undefined}
                  className="flex min-w-0 flex-col gap-2"
                  disabled={isBusy}
                >
                  <legend className="text-foreground text-sm leading-none font-medium">
                    Categories
                  </legend>
                  {categories.length === 0 ? (
                    <Alert variant="empty">
                      <AlertDescription>
                        No categories exist yet, so this post cannot be filed under one. An
                        administrator creates them from the admin dashboard.
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {categories.map((category, index) => {
                        const isSelected = selected.includes(category.id);
                        return (
                          <Button
                            aria-pressed={isSelected}
                            key={category.id}
                            onBlur={field.onBlur}
                            onClick={() => {
                              field.onChange(
                                isSelected
                                  ? selected.filter((id) => id !== category.id)
                                  : [...selected, category.id],
                              );
                            }}
                            /* The controller's ref, on the FIRST toggle only. A `Controller` hands
                               out one ref for a whole group, and react-hook-form uses it for exactly
                               one thing: moving focus to the field that failed, both through
                               `shouldFocusError` on submit and through
                               `setError(..., { shouldFocus: true })`. Left unattached - as it was -
                               the group had no focus target at all, so a root `category_ids` failure
                               was visible and unreachable: the author read "choose at most N
                               categories" with the keyboard still parked wherever it happened to be.
                               The first toggle is the stable choice because it is the group's entry
                               point and it exists whenever any toggle does; it is still the project
                               `Button` primitive, which forwards `ref` to its own element, so nothing
                               is bypassed to get it. */
                            ref={index === 0 ? field.ref : undefined}
                            size="sm"
                            variant={isSelected ? 'primary' : 'secondary'}
                          >
                            {category.name}
                          </Button>
                        );
                      })}
                    </div>
                  )}
                  <p
                    className="text-muted-foreground text-xs"
                    id={`${categoriesId}-${helperSuffix}`}
                  >
                    {`${CATEGORY_TOGGLE_RATIONALE} ${selected.length === 0 ? 'None selected — the post will not appear under any category filter.' : `${String(selected.length)} selected.`}`}
                  </p>
                  {errorMessage === undefined ? null : (
                    <p
                      className="text-danger text-xs font-medium"
                      id={`${categoriesId}-${errorSuffix}`}
                    >
                      {errorMessage}
                    </p>
                  )}
                </fieldset>
              );
            }}
          />
        </div>

        {/* The preview. `PostContent` is the tier's only Markdown renderer, so `rehype-sanitize` runs
            over the author's draft exactly as it will over the published article - the preview cannot
            disagree with the reading view, and a `<script>` typed into the body is stripped here for
            the same reason it is stripped there. Authored headings are downshifted by that component,
            so no `h1` can escape from a draft into this page. */}
        <section
          aria-labelledby={previewHeadingId}
          className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-4 lg:self-start"
        >
          <h2 className="text-foreground text-sm leading-none font-medium" id={previewHeadingId}>
            Preview
          </h2>
          <div className="border-border bg-surface min-w-0 rounded-lg border p-4">
            {hasPreview ? (
              <PostContent categories={selectedCategories} content={previewContent} />
            ) : (
              <p className="text-muted-foreground text-sm">
                Nothing to preview yet. Start writing in Content and it will render here.
              </p>
            )}
          </div>
        </section>
      </div>

      {/* The action bar. §0.7.3.2 makes it sticky from 48rem upward, and `bottom-0` is the only anchor
          that does anything for a bar sitting at the END of a form: it pins the actions to the foot of
          the viewport while the form is taller than the screen and releases them at the form's end. A
          `top` offset would only engage after the entire form had scrolled past, which is too late to
          be useful. It carries the surface and border tokens so the fields do not show through it, and
          the form's own bottom padding at the same breakpoint is what stops it covering the last
          field. Below 48rem it is an ordinary in-flow row. */}
      <div
        className={cn(
          'border-border bg-surface flex flex-wrap items-center gap-3 border-t pt-4',
          'md:sticky md:bottom-0 md:z-10 md:pb-4',
        )}
      >
        <Button disabled={isBusy} type="submit">
          {operation === 'save' ? (
            <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
          ) : (
            <Save aria-hidden="true" />
          )}
          {operation === 'save' ? savePendingLabel : saveLabel}
        </Button>

        {isPublished ? (
          <Button
            disabled={isBusy}
            onClick={() => {
              void handleUnpublish();
            }}
            variant="secondary"
          >
            {operation === 'unpublish' ? (
              <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
            ) : (
              <EyeOff aria-hidden="true" />
            )}
            {operation === 'unpublish' ? 'Unpublishing…' : 'Unpublish'}
          </Button>
        ) : (
          <Button
            disabled={isBusy}
            onClick={() => {
              void onSubmitPublish();
            }}
            type="button"
            variant="secondary"
          >
            {operation === 'publish' ? (
              <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
            ) : (
              <Send aria-hidden="true" />
            )}
            {operation === 'publish' ? 'Publishing…' : publishLabel}
          </Button>
        )}

        {/* `ms-auto` pushes the two low-frequency actions away from the two primary ones, so Delete is
            never adjacent to Save at any width. */}
        <Button
          className="ms-auto"
          disabled={isBusy}
          onClick={handleCancel}
          ref={cancelTriggerRef}
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>

        {persisted === null ? null : (
          <Button
            disabled={isBusy}
            onClick={() => {
              setActiveDialog('delete');
            }}
            ref={deleteTriggerRef}
            type="button"
            variant="destructive"
          >
            {operation === 'delete' ? (
              <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
            ) : (
              <Trash2 aria-hidden="true" />
            )}
            {operation === 'delete' ? 'Deleting…' : 'Delete'}
          </Button>
        )}
      </div>

      {/* Confirmations. Both are the Radix-backed `Dialog`, which supplies the focus trap, the escape
          handler, the scroll lock and the `aria-labelledby`/`aria-describedby` wiring - which is
          exactly why `DialogTitle` and `DialogDescription` are always rendered: without them that
          wiring points at nothing. `DialogContent` already renders its own portal, overlay and close
          control, so neither is repeated here. Nothing in this file uses `window.confirm`. */}
      <Dialog
        onOpenChange={(open) => {
          if (!open && !isBusy) {
            setActiveDialog('none');
          }
        }}
        open={activeDialog === 'delete'}
      >
        <DialogContent onCloseAutoFocus={restoreFocusTo('delete')}>
          <DialogTitle>Delete this post?</DialogTitle>
          <DialogDescription>
            {`“${persisted?.title ?? 'This post'}” will be removed permanently, and its comments and likes are deleted with it by the database. This cannot be undone.`}
          </DialogDescription>
          <div className="flex flex-wrap justify-end gap-3">
            <DialogClose asChild>
              <Button disabled={isBusy} type="button" variant="ghost">
                Keep the post
              </Button>
            </DialogClose>
            <Button
              disabled={isBusy}
              onClick={() => {
                void handleDelete();
              }}
              type="button"
              variant="destructive"
            >
              {operation === 'delete' ? (
                <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
              ) : (
                <Trash2 aria-hidden="true" />
              )}
              {operation === 'delete' ? 'Deleting…' : 'Delete permanently'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setActiveDialog('none');
          }
        }}
        open={activeDialog === 'discard'}
      >
        <DialogContent onCloseAutoFocus={restoreFocusTo('cancel')}>
          <DialogTitle>Discard unsaved changes?</DialogTitle>
          <DialogDescription>
            This post has edits that have not been saved. Leaving now discards them; nothing already
            saved is affected.
          </DialogDescription>
          <div className="flex flex-wrap justify-end gap-3">
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Keep editing
              </Button>
            </DialogClose>
            <Button onClick={discardAndLeave} type="button" variant="destructive">
              Discard and leave
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </form>
  );
}
