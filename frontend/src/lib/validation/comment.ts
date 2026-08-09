/**
 * Form validation for the comment box and the threaded reply form.
 *
 * Two schemas, one per write route, and nothing else. {@link commentCreateSchema} validates the
 * request body of `POST /api/v1/posts/{id}/comments` and {@link commentUpdateSchema} that of
 * `PATCH /api/v1/comments/{id}`. `@/components/blog/comment-form.tsx` hands whichever one applies
 * to the resolver bridge from `@hookform/resolvers`; that import belongs to the component, which
 * is why neither `react-hook-form` nor its resolver package appears below. One component serves
 * both the root-comment and the reply case, and the only difference between them is whether
 * `parent_id` is supplied.
 *
 * ## The contract this mirrors, and where a disagreement is settled
 *
 * `backend/app/schemas/comment.py` is the authority for every bound and every optionality in this
 * file, and it is **the reconciliation point for any future change**: a client schema that is
 * looser than the service's produces a `422` the reader cannot act on, and one that is stricter
 * blocks text the service would have accepted. Neither failure is visible to `tsc --noEmit` or to
 * the linter, so both are prevented by copying the numbers rather than by choosing them:
 *
 * - **Body length 1 to 5000** mirrors that module's two length constants.
 * - **Surrounding whitespace is trimmed** mirrors its string constraints.
 * - **Trimming happens before the length is measured** mirrors the same ordering, and it is what
 *   turns a whitespace-only submission into a "too short" rejection rather than a stored blank.
 * - **`parent_id` is optional and accepts null** mirrors a nullable identifier defaulting to none:
 *   omitting it and sending null are equally valid ways to say "top-level".
 * - **`parent_id` is absent from the update schema** mirrors an update model with one member.
 *
 * Drift in the *shape*, as opposed to drift in a number, is caught by the compiler instead of by
 * copying: each schema's members are pinned to its contract counterpart in `@/lib/types` by
 * {@link MembersOf} and each inferred output by {@link WireCompatible}. Between them a renamed
 * member, a member the contract does not have, a changed type and a changed nullability all fail
 * the build. What no type can express - the order of the checks inside the body rule - is recorded
 * on {@link commentBodySchema}.
 *
 * ## Both schemas mirror the wire exactly, including the update's optionality
 *
 * On the wire the update body is *optional*: the service's model declares it optional and applies
 * `model_dump(exclude_unset=True)`, so an omitted member means "leave this as it is" and `{}` is a
 * valid no-op patch. `commentUpdateSchema` therefore marks it optional too, and `{}` parses.
 *
 * It used to require it, on the argument that the editor is a text area whose state always carries
 * the member, so the only thing a reader could actually do was submit it blank - which requiring it
 * reports inline. The argument is a good one about the *editor* and a wrong one about this schema:
 * these exports are the request mirror, they are what pins the client to the service's contract, and
 * a mirror that is stricter than the thing it mirrors is simply an inaccurate mirror. It also made
 * `{}` - a request the API accepts - unrepresentable through the module that exists to describe what
 * the API accepts.
 *
 * **An editor that genuinely requires text composes that rule itself**, on top of the mirror, at the
 * boundary that owns the interaction: `commentUpdateSchema.required()` re-imposes the member for a
 * form whose submit button must refuse an empty text area, and the blank-text message below is
 * already worded for exactly that case. That keeps two different rules in the two places they belong
 * - what the API accepts here, what the form insists on there - instead of collapsing them into one
 * that is wrong about the first.
 *
 * Null is accepted by neither schema, matching the service, which refuses an explicit null on both
 * routes because the column has no state such a value could describe.
 *
 * ## What a form may not send
 *
 * The post identifier is not here: it arrives in the route path, and a second copy in the body
 * would be a second, contradictable answer to "which post is this about" - one the service's
 * authority checks would not have covered. Authorship is not here either: it is the principal the
 * bearer token resolves to. Neither is the moderation state, and that omission is the moderation
 * guard - a form able to set it would let a commenter approve their own comment. Nor is the
 * server-generated identifier, nor either of the two instants, all three of which belong to the
 * database.
 *
 * None of those keys is *spelled* anywhere in this module, deliberately: a search for one of them
 * across `src/lib/validation/` returning nothing is then a cheap, mechanical proof that no form in
 * this tier can set it, and prose quoting the key would defeat that check. Both schemas are also
 * **strict**, so a payload carrying an unrecognised key is rejected with that key named rather than
 * silently shortened - which is exactly what the service does with `extra='forbid'`, so the two ends
 * agree about the rule *and* about its consequence. Strictness applies to whatever is handed in, so a
 * form whose state carries UI-only members (a reply-open flag, a draft marker) must project the wire
 * members out before validating: `commentCreateSchema.parse({ body, parent_id })` rather than
 * `.parse(formState)`.
 *
 * ## What this module deliberately does not do
 *
 * - **No sanitising.** Reader-authored text is a stored-injection surface, and it is cleaned in
 *   exactly two places: server-side on write, and again by the sanitising render pipeline. A
 *   validator that quietly rewrote a reader's text would change what they wrote *and* offer false
 *   assurance, since the API is callable without this form. Length and shape are checked here;
 *   markup is not stripped, escaped or refused.
 * - **No request of any kind, and no asynchronous refinement.** Whether `parent_id` names a real
 *   comment - and whether that comment hangs off the same post - is not a property of the
 *   submitted value, and is checked server-side. `@/lib/api/client` is the tier's only module that
 *   performs network access.
 * - **No environment access.** Nothing here reads configuration; the two modules in `@/lib` that
 *   do are the HTTP client and the metadata builders.
 * - **No error formatting.** Turning issues into rendered messages is the form layer's work, so no
 *   flattening, tree-shaping or field-error helper is exported.
 * - **No barrel.** There is no `@/lib/validation/index`; consumers import `@/lib/validation/comment`
 *   directly, exactly as they import `@/lib/types`.
 * - **No client-boundary directive.** This is a plain schema module and is importable from a server
 *   component and a client island alike.
 * - **No schema for the response shape.** The thread projection is an output type, and its nested
 *   replies array is a tree; a form submits one comment.
 *
 * ## Message strings are user interface
 *
 * Every message below is rendered as the inline, label-associated error for its field, so each one
 * names what is wrong and what to do about it, and none is a bare restatement of a constraint.
 * Component tests assert on visible text rather than on class names, which makes a vague message a
 * testability defect as much as a usability one. The `parent_id` message is worded as a problem
 * with the reply target rather than as reader error, because it is not a field anybody types: it
 * is supplied by the component from the comment being answered, and if it ever surfaces the reader
 * has done nothing wrong.
 *
 * ## Governing standards
 *
 * No user-specified rules were provided for this project, so the binding constraints are the
 * technical plan's own enterprise standards. Five govern this module: **server-owned identity**
 * (no schema here accepts an identifier, an author reference or a moderation state); **explicit
 * API contracts** (both schemas mirror the service models member for member, and both inferred
 * outputs are pinned to the shared contract types); **layered separation of concerns** (a leaf of
 * `@/lib` - the only imports are the validator package and one type-only edge); **pinned,
 * reproducible dependencies** (one runtime dependency, at the version the manifest pins); and
 * **accessibility as a floor** (every message is written to be read by the person who tripped it).
 *
 * @module
 */

import { z } from 'zod';

import { codePointLength } from '@/lib/text';

import type { CommentCreate, CommentUpdate } from '@/lib/types';

/* -------------------------------------------------------------------------------------------------
 * Bounds
 *
 * Mirrored from the two module-level constants in backend/app/schemas/comment.py, which is where a
 * change to either has to be made first. They are NOT exported: this module's surface is the two
 * schemas and their two inferred types, and a bound re-exported from here would invite a component
 * to render a character counter against a copy that can drift from the service's own.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Shortest accepted comment body, applied *after* trimming.
 *
 * One character combined with the trim is what makes a whitespace-only submission a rejection
 * rather than a comment that renders as an empty bubble in a thread. The floor is not raised above
 * one because a single glyph is a legitimate comment in any script: the rule is "a comment must say
 * something", not "a comment must be long".
 */
const BODY_MIN_LENGTH = 1;

/**
 * Longest accepted comment body, in characters.
 *
 * Several paragraphs - far more than a reader writes in a discussion, and comfortably short of an
 * article. The ceiling matters on the read path rather than the write: a thread page carries a page
 * of top-level comments with their replies nested inside them, so one response can hold dozens of
 * bodies, and an unbounded one would add weight to every later view of that thread.
 */
const BODY_MAX_LENGTH = 5000;

/* -------------------------------------------------------------------------------------------------
 * Messages
 *
 * Declared once, at module scope, rather than inline at each check: these are the strings a reader
 * actually sees, and collecting them makes the wording reviewable as copy instead of buried in a
 * schema chain.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Locale pinned for the one number that appears in a message.
 *
 * Explicit rather than ambient, for the same reason `@/lib/format` pins its own: these schemas
 * evaluate during a server render and again in the browser, and a grouping separator chosen from
 * whichever locale the host happens to advertise would differ between the two, producing a
 * hydration mismatch over a comma.
 */
const MESSAGE_LOCALE = 'en-US';

/**
 * The character ceiling as it is written into {@link BODY_TOO_LONG_MESSAGE}.
 *
 * Derived from {@link BODY_MAX_LENGTH} rather than typed out beside it, so the number a reader is
 * told cannot drift from the number that is enforced.
 */
const BODY_MAX_LENGTH_LABEL = BODY_MAX_LENGTH.toLocaleString(MESSAGE_LOCALE);

/**
 * Shown when the submitted body is not a string at all - including an explicit null, which the
 * service refuses on both routes.
 *
 * Unreachable from a text area, so its audience is whoever is looking at a payload that a component
 * assembled wrongly. It still names the field's requirement rather than reporting a type.
 */
const BODY_NOT_TEXT_MESSAGE = 'Your comment must be text.';

/** Shown when the body exceeds the ceiling, naming the limit so the reader knows how far to cut. */
const BODY_TOO_LONG_MESSAGE = `Your comment is too long. Shorten it to ${BODY_MAX_LENGTH_LABEL} characters or fewer.`;

/**
 * Shown on the comment box when nothing - or only whitespace - was written.
 *
 * This is the single most likely bad submission on the form, so the wording is the plainest in the
 * module: it names the action the reader was attempting.
 */
const CREATE_BODY_EMPTY_MESSAGE = 'Write your comment before posting it.';

/**
 * Shown on the editor when an existing comment's text was cleared.
 *
 * Worded differently from the create case on purpose. Clearing the text of a published comment
 * looks like an attempt to withdraw it, so the message names the two things the reader can actually
 * do - restore some text, or delete the comment - rather than only refusing.
 */
const UPDATE_BODY_EMPTY_MESSAGE =
  'A comment cannot be empty. Enter the corrected text, or delete the comment instead.';

/**
 * Shown when `parent_id` is present but is not a well-formed identifier.
 *
 * Not reader error: the value is supplied by the reply form from the comment being answered, never
 * typed. So the message describes a broken reply target and offers the recovery that actually
 * works, rather than blaming the reader for a field they never saw. Letting a malformed value
 * through instead would produce a `422` from the service that no reader could interpret.
 */
const PARENT_ID_MESSAGE =
  'This reply could not be matched to the comment it answers. Reload the page and try again.';

/* -------------------------------------------------------------------------------------------------
 * The shared body rule
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the body member both schemas use, with one message varied per form.
 *
 * Declared once and called twice, mirroring the shared alias the service declares for the same
 * reason: an edit is held to exactly the rule creation was held to, so a body cannot be lengthened
 * past the ceiling by patching it, and the two contracts cannot drift apart.
 *
 * **The order of the chain is load-bearing, and nothing in the toolchain will tell you if you break
 * it.** Each string check runs where it is written, so trimming must come first: it is what makes a
 * whitespace-only body fail the floor rather than pass as a stored blank, and what stops a padded
 * submission being measured against the ceiling with its padding included - a body of five thousand
 * characters pasted with a trailing newline is rejected as too long if the trim runs last. Verified
 * by measurement on the pinned validator version, and re-measured after moving the trim: reordering
 * these links compiles clean and lints clean, and shows up only as wrongly accepted or wrongly
 * refused text. Neither contract pin below can express it, so treat the order as part of the
 * contract: anyone who changes it has to re-check, by parsing directly, that a padded body of
 * exactly the ceiling length is still accepted and a whitespace-only one is still refused.
 *
 * **The ceiling is measured in code points, not in UTF-16 code units.** `codePointLength` from
 * `@/lib/utils` is the tier's single measurement and the reason is arithmetic: the service's
 * `max_length=5000` counts Python code points, while zod's `.max()` reads
 * `String.prototype.length`, which counts UTF-16 code units and therefore scores every character
 * above `U+FFFF` twice. A five-thousand-character comment written in emoji measures ten thousand to
 * `.max()`, so the ceiling would refuse, in the reader's own words, a comment the API would have
 * stored. The floor stays `.min()` because {@link BODY_MIN_LENGTH} is `1`, and at one the two units
 * cannot disagree - a string has a code point exactly when it has a code unit - so a refinement
 * there would add a second spelling of the same check.
 *
 * The trim is the only transformation applied. It is string-to-string, so it does not disturb the
 * inferred output type, and it is the sole difference between what a reader typed and what is
 * submitted: nothing here strips, escapes or rewrites markup.
 *
 * @param emptyMessage - Rendered when the body is missing, or is empty once trimmed. Both arrive at
 *   the same field and describe the same situation to the reader, so one string covers them.
 * @returns The bounded, trimmed body rule, ready to be placed on a schema.
 */
function commentBodySchema(emptyMessage: string): z.ZodString {
  return z
    .string({
      // A single parameter covers every "this is not a string" outcome - a missing member, a
      // null, a number. The callback distinguishes the missing case, which is the one a reader
      // can cause, from the others, which indicate a component assembled the payload wrongly.
      error: (issue) => (issue.input === undefined ? emptyMessage : BODY_NOT_TEXT_MESSAGE),
    })
    .trim()
    .min(BODY_MIN_LENGTH, { error: emptyMessage })
    .refine((value) => codePointLength(value) <= BODY_MAX_LENGTH, {
      error: BODY_TOO_LONG_MESSAGE,
    });
}

/* -------------------------------------------------------------------------------------------------
 * The two compile-time contract pins
 *
 * Neither declares a value, so neither is emitted and the pair costs the bundle nothing. They catch
 * different mistakes, and both are needed - which was established by breaking this module on purpose
 * and watching which guard fired:
 *
 *   - Renaming `parent_id` to its camelCase spelling is caught by MembersOf and NOT by
 *     WireCompatible, because an object that merely omits an optional member stays assignable. That
 *     is the single most dangerous edit available here: it compiles, it lints, and its only symptom
 *     is every reply silently becoming a root comment.
 *   - Changing a member's TYPE - an identifier declared as a number, say - is caught by
 *     WireCompatible.
 *   - Adding a member the contract does not have, including a server-owned one, is caught by
 *     MembersOf.
 *   - Reordering the links of the body rule is caught by NEITHER, because it changes behaviour
 *     without changing a type. No type can express it, so the only guard is the ordering note on
 *     `commentBodySchema` and the re-check it asks for.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The exact set of schema members a request contract requires: every member name it declares, and
 * no others.
 *
 * Applied to each schema's shape with `satisfies`, which is what makes the constraint bite in both
 * directions - the mapped type demands every contract member be present, and `satisfies` subjects
 * the shape literal to excess-property checking, so a member the contract does not have is a
 * compile error rather than a field quietly submitted into the void. It deliberately says nothing
 * about the *rules* attached to each member; the value types are pinned by {@link WireCompatible}
 * instead, and keeping the two concerns apart is what lets this one read as "these members, exactly".
 *
 * The keys are required here even where the contract marks them optional. That is intentional: a
 * member being optional *on the wire* says a request may leave it out, not that this form may fail
 * to offer it.
 *
 * @typeParam Wire - The request contract type from `@/lib/types` whose member names must be matched.
 */
type MembersOf<Wire> = Record<keyof Wire, z.ZodType>;

/**
 * Resolves to `Form`, and fails to compile unless `Form` is assignable to `Wire`.
 *
 * Each exported form-values type below is declared *through* this alias, so it remains exactly the
 * schema's inferred output while also being checked, at every compile, against the contract type the
 * HTTP wrappers accept. Change a member's type or its nullability and the error lands here rather
 * than three modules away at the call site - or, worse, at run time as a `422`.
 *
 * @typeParam Wire - The contract type from `@/lib/types` that the request body must satisfy.
 * @typeParam Form - The schema's inferred output.
 */
type WireCompatible<Wire, Form extends Wire> = Form;

/* -------------------------------------------------------------------------------------------------
 * Public schemas
 * ---------------------------------------------------------------------------------------------- */

/**
 * Validates the comment box and the reply form: the request body of
 * `POST /api/v1/posts/{id}/comments`.
 *
 * Two members, and both are the writer's to decide. A top-level comment sends the text alone; a
 * reply names the comment it answers, and supplying `parent_id` is the *entire* difference between
 * the two. Everything else about the stored row is produced by the service, so there is nothing
 * else for this form to carry.
 *
 * `parent_id` is optional and accepts null, matching the contract type exactly: omitting it and
 * sending null both mean "top-level". When it *is* present it must be a well-formed identifier -
 * an empty string is a failure, deliberately not treated as absent. Silently coercing one would
 * turn a reply whose target went missing into a root comment with no error reported anywhere,
 * which is precisely the class of defect the check exists to catch.
 *
 * Parsing **rejects** anything not declared here rather than removing it, matching the service's own
 * `extra='forbid'`, so a misspelled member is named in a field error instead of vanishing from a
 * request that then appears to succeed. The value handed to the API can only ever hold these two
 * members.
 *
 * @example
 * ```ts
 * // A top-level comment.
 * commentCreateSchema.parse({ body: '  Clear write-up.  ' });
 * // => { body: 'Clear write-up.' }
 *
 * // A reply, and the only difference.
 * commentCreateSchema.parse({
 *   body: 'Agreed, though the second half surprised me.',
 *   parent_id: '9c2f1b84-0a5e-4d31-8b77-6e4c2a91d503',
 * });
 * ```
 */
export const commentCreateSchema = z.strictObject({
  body: commentBodySchema(CREATE_BODY_EMPTY_MESSAGE),
  // Optional AND null-accepting, because the service accepts both spellings of "top-level". The
  // top-level format function is the current form; the equivalent method on a string schema is
  // deprecated in the pinned major version. Accepted values are canonical hyphenated identifiers,
  // which is the only form the API ever emits, so the strictness is never reachable by a value
  // that came from a real comment.
  parent_id: z.uuid({ error: PARENT_ID_MESSAGE }).nullish(),
} satisfies MembersOf<CommentCreate>);

/**
 * The values {@link commentCreateSchema} produces: what the comment form submits.
 *
 * Pinned to the request contract by {@link WireCompatible}, so a member's type cannot drift from the
 * shape the API wrapper accepts, while {@link MembersOf} pins the member *names* on the schema
 * above. Those names are snake_case because that is what goes on the wire and there is no mapping
 * layer anywhere in this tier: spelling `parent_id` in the other convention would submit a payload
 * the service ignores, and the only symptom would be every reply quietly becoming a root comment -
 * which is precisely why it is a compile error here rather than a convention.
 */
export type CommentCreateFormValues = WireCompatible<
  CommentCreate,
  z.infer<typeof commentCreateSchema>
>;

/**
 * Validates the comment editor: the request body of `PATCH /api/v1/comments/{id}`.
 *
 * One member, and that is the whole schema - the route edits a comment's text and does nothing
 * else. `parent_id` is absent, and {@link MembersOf} makes adding it a compile error rather than a
 * matter of discipline: re-parenting would silently restructure a discussion other readers have
 * already read and replied within, taking a reply's own subtree with it, and moving a comment is not
 * an operation this API has. A thread's shape is fixed when its rows are written.
 *
 * The body rule is the one creation uses, so an edit cannot exceed a limit a new comment could not.
 * It is **optional**, exactly as the wire contract is: the service accepts a patch that sets nothing,
 * so `{}` parses here too. A form that must refuse an empty text area re-imposes the member with
 * `commentUpdateSchema.required()` - see the module header on why that rule belongs to the editor
 * rather than to the request mirror. Note that optional is not nullable: `{ body: null }` is still a
 * failure, matching the service, because the column has no state such a value could describe.
 *
 * @example
 * ```ts
 * commentUpdateSchema.parse({ body: 'Corrected: the cascade is recursive, not one level.' });
 * // => { body: 'Corrected: the cascade is recursive, not one level.' }
 *
 * commentUpdateSchema.parse({}); // => {} - a no-op patch, which the service accepts
 *
 * // A supplied parent is REJECTED, not dropped: this route cannot move a comment, and a caller who
 * // tried is told so rather than left believing the reply was re-parented.
 * commentUpdateSchema.safeParse({ body: 'Fixed a typo.', parent_id: 'anything' }).success; // false
 *
 * // What an editor that insists on text uses instead:
 * commentUpdateSchema.required().safeParse({}).success; // false
 * ```
 */
export const commentUpdateSchema = z.strictObject({
  body: commentBodySchema(UPDATE_BODY_EMPTY_MESSAGE).optional(),
} satisfies MembersOf<CommentUpdate>);

/**
 * The values {@link commentUpdateSchema} produces: what the comment editor submits.
 *
 * Pinned to the request contract by {@link WireCompatible}, and now optional on both sides: the
 * service accepts a patch that sets nothing, so the mirror admits `{}` as well. An editor that
 * refuses a cleared text area does so with `commentUpdateSchema.required()`, whose inferred type
 * narrows the member back to required for that form alone - the interaction rule lives with the
 * interaction, and the request contract stays a faithful description of the request.
 */
export type CommentUpdateFormValues = WireCompatible<
  CommentUpdate,
  z.infer<typeof commentUpdateSchema>
>;
