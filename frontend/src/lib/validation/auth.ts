/**
 * The credential-form contract: what the sign-up and log-in forms accept before anything is sent.
 *
 * Two schemas and two inferred types, backing `(auth)/signup/page.tsx` and `(auth)/login/page.tsx`
 * through `zodResolver`. The schemas are consumed by the form components; the resolver itself is
 * imported *there*, not here, so this module stays a plain declaration that either environment can
 * import.
 *
 * ## The one rule this module exists to obey
 *
 * **Reject exactly what the service rejects, and accept exactly what it accepts.** Every constraint
 * below mirrors `backend/app/schemas/auth.py` — which is the authority, and which names this file as
 * its client mirror in as many words. The two failure modes are asymmetric and both are invisible to
 * `tsc` and to `eslint`, so neither is caught by any gate short of a person using the form:
 *
 * - A **looser** client submits what the API refuses. The user waits for a round trip and then
 *   receives a `422` for a rule the form never mentioned.
 * - A **stricter** client refuses what the API would have accepted. The user cannot submit a valid
 *   credential at all, and no server message exists to explain why, because the request was never
 *   made.
 *
 * Of the two, stricter is the worse: it has no recovery path. Where exact agreement is provably
 * unattainable — and there is exactly one such place, the Unicode character-group rule described
 * under {@link hasSufficientCharacterVariety} — this module deliberately errs loose and lets the
 * authoritative validator answer.
 *
 * ## Provenance of every number in this file
 *
 * Nothing here is chosen. Each constant was read out of the service and is reproduced with the
 * backend name it mirrors, so a reviewer can diff the two by grepping for the name:
 *
 * | Here                             | Mirrored from                                          |
 * | -------------------------------- | ------------------------------------------------------ |
 * | `USERNAME_MIN_LENGTH` (3)        | `app.schemas.auth.USERNAME_MIN_LENGTH`                 |
 * | `USERNAME_MAX_LENGTH` (30)       | `app.schemas.auth.USERNAME_MAX_LENGTH`                 |
 * | `USERNAME_PATTERN`               | `app.schemas.auth.USERNAME_PATTERN`                    |
 * | `PASSWORD_MIN_LENGTH` (12)       | `app.schemas.auth.PASSWORD_MIN_LENGTH`         |
 * | `PASSWORD_MAX_LENGTH` (128)      | `app.schemas.auth.PASSWORD_MAX_LENGTH`         |
 * | `PASSWORD_MIN_CHARACTER_GROUPS`  | `app.schemas.auth.PASSWORD_MIN_CHARACTER_CLASSES` |
 * | `PASSWORD_CHARACTER_GROUPS`      | `app.schemas.auth.PASSWORD_CHARACTER_GROUPS`   |
 * | `DISPLAY_NAME_MAX_LENGTH` (80)   | `app.schemas.auth.DISPLAY_NAME_MAX_LENGTH`             |
 *
 * When the service changes one of them, read it and change this file to match. Do not soften a rule
 * here to make a form easier to fill in: that converts a field error into a `422`.
 *
 * ## What is deliberately absent, and why
 *
 * `role`
 *     Neither schema declares it, and that is the privilege-escalation guard rather than an
 *     omission. Authority is an attribute of the stored account, granted by the service's own
 *     `'READER'` default and changed only through the administrative API. Both schemas below are
 *     **strict**, so a caller who puts `role` into a payload gets a validation failure naming the
 *     key rather than a silently shortened payload — the field cannot reach the wire through this
 *     module at all, and the attempt is reported rather than absorbed. The service answers `422`
 *     for the same key through `extra='forbid'`, so the two ends agree on both the rule and the
 *     consequence.
 * `id`, `is_active`, `created_at`, `updated_at`, and every other server-owned field
 *     Identity is a UUID the database generates; the timestamps and the active flag are the
 *     service's to set. No input shape accepts any of them.
 * `confirm_password`, `terms_accepted`, `remember_me`
 *     No wire counterpart, so no schema field. There is no transformation layer between a parsed
 *     form value and a request body — what these schemas produce is what is sent — so a
 *     client-only field would be a key the API is documented to reject.
 * A response schema, and a schema for the token pair or the refresh body
 *     Those are transport shapes, not form input. Registration answers with the public account
 *     projection and log-in answers with a token pair; both are typed in `@/lib/types` and neither
 *     is parsed here.
 * An error formatter
 *     Turning a failure into rendered text is the form layer's job. This module produces messages;
 *     it does not arrange them.
 *
 * ## Two conventions that break silently if you get them wrong
 *
 * 1. **Field names are snake_case**, because they are the literal JSON keys the service reads.
 *    There is no camel-case mapping layer anywhere in this tier, so a camelCased field would
 *    type-check, submit, and be ignored by the API. The *export* names are ordinary TypeScript
 *    identifiers and stay camelCase and PascalCase.
 * 2. **`loginSchema` validates `email`, not `username`.** The log-in route additionally accepts the
 *    OAuth 2 password-grant form, whose field the grant names `username` while carrying an email
 *    value. That encoding lives in `@/lib/api/auth`; this module declares the documented JSON
 *    contract and nothing else.
 *
 * ## Governing standards
 *
 * No user-specified rules were provided for this project, so the binding constraints are the
 * technical plan's own enterprise standards. Six govern this module: *secure-by-default
 * authentication* (the password floor is mirrored, never weakened, and no token, secret, hash or
 * signing key is touched here); *server-owned identity* (no server-owned field is accepted);
 * *explicit API contracts* (both schemas mirror the service field for field, and both inferred
 * outputs are constrained at compile time to remain assignable to their `@/lib/types` counterparts);
 * *layered separation of concerns* (a leaf of `@/lib` — the only imports are `zod` and one
 * type-only contract import); *pinned dependencies* (`zod` is the sole runtime dependency, at the
 * version the manifest pins); and *accessibility as a floor* (every message is a complete sentence
 * naming the field and the requirement, because each one is rendered as the inline error beside the
 * control that produced it).
 *
 * @module
 */

import { z } from 'zod';

import type { LoginRequest, RegisterRequest } from '@/lib/types';
import { codePointLength } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Username policy — mirrors `app.schemas.auth`
 *
 * A username is a URL path segment before it is a label: it addresses
 * `GET /api/v1/users/{username}` and the site's `/u/[username]` profile route, and it appears in
 * that route's canonical link and sitemap entry. Every constraint here exists to keep those URLs
 * well-formed, so relaxing one here would produce a link the service cannot resolve.
 * ---------------------------------------------------------------------------------------------- */

/** Shortest accepted username. Mirrors `app.schemas.auth.USERNAME_MIN_LENGTH`. */
const USERNAME_MIN_LENGTH = 3;

/** Longest accepted username. Mirrors `app.schemas.auth.USERNAME_MAX_LENGTH`. */
const USERNAME_MAX_LENGTH = 30;

/**
 * Accepted username shape: letters, digits, underscores and hyphens, with no separator at either
 * end. Mirrors `app.schemas.auth.USERNAME_PATTERN` character for character.
 *
 * Anchored at both ends deliberately. The service's regular-expression engine matches by searching
 * rather than by matching the whole string, so its pattern carries the anchors and this one has to
 * as well — without them `bad name/alice` would pass on the strength of the substring `alice`.
 * The expression uses no look-around, matching the service's non-backtracking engine, so the two
 * cannot diverge on a pathological input.
 */
const USERNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;

/* -------------------------------------------------------------------------------------------------
 * Password policy — mirrors `app.schemas.auth`
 *
 * Three independent rules, and it is worth being clear about which does what. The minimum length
 * and the character-group rule bound how weak a *new* password may be. The maximum length is a
 * resource control rather than a strength rule: the service hashes with argon2id, which is
 * memory-hard by design, so an unbounded password on an unauthenticated route is an amplification
 * primitive. That is why the maximum applies on log-in too while the other two do not.
 * ---------------------------------------------------------------------------------------------- */

/** Shortest accepted new password. Mirrors `app.schemas.auth.PASSWORD_MIN_LENGTH`. */
const PASSWORD_MIN_LENGTH = 12;

/**
 * Longest accepted password, on sign-up and on log-in alike. Mirrors
 * `app.schemas.auth.PASSWORD_MAX_LENGTH`.
 */
const PASSWORD_MAX_LENGTH = 128;

/**
 * How many of {@link PASSWORD_CHARACTER_GROUPS} a new password must draw on. Mirrors
 * `app.schemas.auth.PASSWORD_MIN_CHARACTER_CLASSES`.
 */
const PASSWORD_MIN_CHARACTER_GROUPS = 3;

/**
 * The five character groups {@link PASSWORD_MIN_CHARACTER_GROUPS} counts, in the service's order.
 * Mirrors `app.schemas.auth.PASSWORD_CHARACTER_GROUPS` phrase for phrase, because
 * {@link PASSWORD_VARIETY_MESSAGE} is built from this list exactly as the service builds its own —
 * so the sentence a user reads here and the sentence a `422` would carry are the same sentence
 * rather than two paraphrases of it.
 *
 * The fifth group is a catch-all, which is what makes the classification total: every character
 * lands in exactly one group. The fourth exists so the rule is satisfiable in a script that draws
 * no case distinction — a Japanese or Hebrew passphrase can otherwise reach two groups and no
 * further however long it is — and dropping it would quietly exclude most of the world's readers.
 */
const PASSWORD_CHARACTER_GROUPS = [
  'a lowercase letter',
  'an uppercase letter',
  'a digit',
  'a letter from a script that has no letter case, such as CJK, Hebrew or Arabic',
  'any other character, such as a symbol, a punctuation mark or a space',
] as const;

/**
 * The rejection sentence for a password that clears the length floor but not the group floor.
 *
 * Assembled from {@link PASSWORD_CHARACTER_GROUPS} rather than written out, using the same
 * separator the service uses, so this string is byte-identical to the one
 * `app.schemas.auth.PASSWORD_VARIETY_MESSAGE` produces. It names the rule and never quotes
 * what was typed — a rejected password must not reach a message, a log line or a stack trace.
 */
const PASSWORD_VARIETY_MESSAGE =
  `Password must contain characters from at least ${PASSWORD_MIN_CHARACTER_GROUPS} of these ` +
  `${PASSWORD_CHARACTER_GROUPS.length} groups: ${PASSWORD_CHARACTER_GROUPS.join('; ')}.`;

/* -------------------------------------------------------------------------------------------------
 * Display-name policy — mirrors `app.schemas.auth`
 * ---------------------------------------------------------------------------------------------- */

/** Longest accepted display name. Mirrors `app.schemas.auth.DISPLAY_NAME_MAX_LENGTH`. */
const DISPLAY_NAME_MAX_LENGTH = 80;

/* -------------------------------------------------------------------------------------------------
 * Character-group classification
 *
 * The one place in this file where exact agreement with the service is provably unattainable, and
 * therefore the one place that deliberately errs loose. Read the note on
 * {@link hasSufficientCharacterVariety} before changing anything here.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The ordered tests that place a character in exactly one of {@link PASSWORD_CHARACTER_GROUPS}.
 *
 * Order is load-bearing and mirrors the service's cascade exactly: lowercase, then uppercase, then
 * decimal digit, then any remaining letter, then everything else. `\p{L}` is tried only after both
 * case tests have failed, so it captures a letter from a caseless script rather than shadowing the
 * two groups above it — which is precisely how the service reaches its fourth group.
 *
 * Index into this array is the index into {@link PASSWORD_CHARACTER_GROUPS}; a character matching
 * none of the four falls through to the final catch-all group.
 */
const CHARACTER_GROUP_TESTS = [/\p{Lowercase}/u, /\p{Uppercase}/u, /\p{Nd}/u, /\p{L}/u] as const;

/** Index of the catch-all group — the one a character reaches by matching no test above. */
const OTHER_CHARACTER_GROUP = CHARACTER_GROUP_TESTS.length;

/**
 * Matches a password containing any character outside ASCII.
 *
 * Used only by {@link hasSufficientCharacterVariety} to decide when to defer to the service rather
 * than to reject. See that function for why the boundary is drawn at ASCII specifically.
 */
const CONTAINS_NON_ASCII = /[^\u0000-\u007F]/u;

/**
 * Which of {@link PASSWORD_CHARACTER_GROUPS} the password draws on.
 *
 * Iterates by code point rather than by UTF-16 unit, matching the service, so an astral character
 * is classified once as itself instead of twice as a surrogate half.
 *
 * @param password - The candidate password, exactly as it was typed.
 * @returns The set of group indices present. Empty only for an empty string.
 */
function passwordCharacterGroups(password: string): ReadonlySet<number> {
  const groups = new Set<number>();

  for (const character of password) {
    const index = CHARACTER_GROUP_TESTS.findIndex((test) => test.test(character));
    groups.add(index === -1 ? OTHER_CHARACTER_GROUP : index);
  }

  return groups;
}

/**
 * Whether the password draws on enough character groups to be accepted as a new one.
 *
 * ## Why this is not a straight port
 *
 * The service classifies with Python's `str.islower`, `str.isupper`, `str.isdigit` and
 * `str.isalpha`; this function classifies with the equivalent Unicode property escapes. For **every
 * ASCII code point the two are identical** — verified exhaustively, code point by code point, over
 * the whole of `U+0000`–`U+007F` — so for any password composed of ASCII this check and the
 * service's reach the same verdict by construction.
 *
 * Outside ASCII they cannot be made identical, and the reason is not a defect in either: the two
 * runtimes ship **different Unicode databases**, so a code point assigned in one and unassigned in
 * the other is a letter to one and an unclassified character to the other. That skew moves with
 * every runtime upgrade, and a handful of numeric characters — superscript digits among them —
 * differ for the separate reason that Python counts more of them as digits than the decimal-digit
 * property does. Both differences can push the group count across the threshold in *either*
 * direction, so no adjustment to the tests above closes the gap; it only moves it.
 *
 * ## So this check errs loose, on purpose
 *
 * When the count falls short *and* the password contains a non-ASCII character, this function
 * returns `true` and lets the service decide. The reasoning:
 *
 * - Being **stricter** than the service is the unrecoverable failure. It would refuse a valid
 *   passphrase with no way for the user to learn why, and it would fall hardest on exactly the
 *   users the service's fourth character group exists to include.
 * - Being **looser** costs one round trip and nothing else. The service answers with a problem
 *   document whose per-field message is the same sentence as {@link PASSWORD_VARIETY_MESSAGE}, and
 *   the form renders it against the password control like any other field error. The user sees the
 *   identical text either way.
 *
 * An all-ASCII password — the overwhelmingly common case — is still held to the full rule locally,
 * so the pre-submit check keeps its value where it can be exact.
 *
 * @param password - The candidate password, already within the length bounds.
 * @returns `true` when the password may be submitted; `false` only when it is certainly refusable.
 */
function hasSufficientCharacterVariety(password: string): boolean {
  if (passwordCharacterGroups(password).size >= PASSWORD_MIN_CHARACTER_GROUPS) {
    return true;
  }

  return CONTAINS_NON_ASCII.test(password);
}

/* -------------------------------------------------------------------------------------------------
 * Field schemas
 *
 * Declared once and shared, so the two forms cannot drift from one another on a field they have in
 * common. Three details recur and each mirrors a decision in the service:
 *
 * - **`.trim()` comes before every length and format check**, matching the service's
 *   `strip_whitespace`, which it also applies first. That ordering is what makes `'  ab  '` a
 *   too-short username rather than a padded two-character one.
 * - **`abort: true` on the length checks** stops later checks from running once a length fails, so a
 *   submission produces exactly one sentence per field. The service reaches the same outcome from
 *   the other direction: its length constraints reject before its validators run, so the variety
 *   message is never reported alongside a length message there either.
 * - **Neither password field is trimmed.** Whitespace is significant in a credential, and the
 *   service says so explicitly: trimming would silently change the password a user typed, and they
 *   would then be unable to log in with what they thought they had chosen.
 * - **Every length bound is measured in code points** through `codePointLength` from `@/lib/utils`,
 *   not in UTF-16 code units. That function is the tier's single measurement and its documentation
 *   carries the two observed failures this prevents; `validation/category.ts`, `validation/post.ts`
 *   and `validation/comment.ts` measure through the same one. It is why the bounds below are
 *   expressed as explicit checks rather than as zod's `.min()` and `.max()`, which read
 *   `String.prototype.length`. The one exception is the `.min(1)` "is anything here at all" check on
 *   the submitted password, where the two units cannot disagree.
 * ---------------------------------------------------------------------------------------------- */

/**
 * An email address, trimmed and checked for deliverable syntax.
 *
 * Trimming is required rather than cosmetic. The service validates through `email-validator`, which
 * strips surrounding whitespace before parsing, so an address pasted with a trailing space is
 * accepted there — a client that did not trim would refuse it and be stricter than the API for no
 * reason.
 *
 * Case is deliberately left alone. The stored column is case-insensitive, so folding here would buy
 * nothing, and silently rewriting what someone typed into a field they can see is its own defect.
 * The service normalises the domain on its side; the local part is preserved on both.
 *
 * The `.min(1)` check exists so an untouched field reports that it is required rather than that it
 * is malformed, which is the more useful of the two sentences for an empty control.
 */
const emailField = z
  .string({ error: 'Email address is required.' })
  .trim()
  .min(1, { error: 'Email address is required.', abort: true })
  // The pattern is explicit, and choosing it is the whole substance of this field.
  //
  // zod's DEFAULT email pattern is ASCII-only, so it rejects every internationalized address:
  // `ünïcödé@exämple.com`, and any address with a non-ASCII local part or an IDN domain in its
  // Unicode form. The service accepts them - Pydantic's `EmailStr` follows the SMTPUTF8/IDNA rules -
  // so the default would make this form STRICTER than the API it mirrors, which is the one direction
  // a client-side check must never be wrong in. The failure is also invisible to everyone who tests
  // with an ASCII address: a reader whose own name is not spellable in ASCII simply cannot register,
  // and the message tells them their address is invalid when it is not.
  //
  // `z.regexes.unicodeEmail` is zod's own Unicode-aware pattern, verified in the installed 4.4.3 to
  // accept `ünïcödé@exämple.com` while still requiring an `@`, a non-empty local part of at most 64
  // characters and a host of at most 255 - the RFC bounds. Anything it lets through that the service
  // would refuse comes back as a `422` against this field, which is the correct division: the client
  // saves the obvious round trip, the service remains the authority on deliverability.
  .pipe(
    z.email({
      pattern: z.regexes.unicodeEmail,
      error: 'Enter a valid email address, such as you@example.com.',
    }),
  );

/**
 * A public handle, trimmed and held to the service's length bounds and character pattern.
 *
 * The pattern message spells the rule out rather than showing the expression, because the expression
 * is not something a person can act on. It is reported only once a length is known to be acceptable,
 * so a two-character handle beginning with a hyphen is reported as too short first — one correction
 * at a time.
 */
const usernameField = z
  .string({ error: 'Username is required.' })
  .trim()
  .refine((value) => codePointLength(value) >= USERNAME_MIN_LENGTH, {
    error: `Username must be at least ${USERNAME_MIN_LENGTH} characters.`,
    abort: true,
  })
  .refine((value) => codePointLength(value) <= USERNAME_MAX_LENGTH, {
    error: `Username must be at most ${USERNAME_MAX_LENGTH} characters.`,
    abort: true,
  })
  .regex(USERNAME_PATTERN, {
    error:
      'Username may contain only letters, digits, hyphens and underscores, and must begin and ' +
      'end with a letter or a digit.',
  });

/**
 * A **new** password, held to the full registration policy: length bounds and character variety.
 *
 * This is the one field where a client that mirrors the service badly is actively harmful, so all
 * three rules are present and none is embellished. No composition rule beyond the service's own
 * group count is added — requiring, say, a symbol specifically would refuse passwords the API
 * accepts.
 */
const newPasswordField = z
  .string({ error: 'Password is required.' })
  .refine((value) => codePointLength(value) >= PASSWORD_MIN_LENGTH, {
    error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    abort: true,
  })
  .refine((value) => codePointLength(value) <= PASSWORD_MAX_LENGTH, {
    error: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
    abort: true,
  })
  .refine(hasSufficientCharacterVariety, { error: PASSWORD_VARIETY_MESSAGE });

/**
 * A **submitted** password, bounded in size and judged no further.
 *
 * The registration policy is pointedly not applied here, mirroring the service, and for the reasons
 * the service gives: enforcing a minimum length or a group rule on a credential someone is
 * presenting would publish the policy to anyone who can reach the form, and would lock out any
 * account whose password predates a later tightening of it. An existing credential does not become
 * weak because the rule changed.
 *
 * The maximum *is* applied, because it is a bound on the work one request can cause rather than a
 * judgement about the credential, and the service applies it on this route too.
 *
 * The `.min(1)` check is not a policy rule and is not stricter than the API in any way that matters:
 * the service's own floor is {@link PASSWORD_MIN_LENGTH}, so no account can exist whose password is
 * the empty string. It turns a guaranteed failed round trip into an immediate field error.
 */
const submittedPasswordField = z
  .string({ error: 'Password is required.' })
  .min(1, { error: 'Password is required.', abort: true })
  .refine((value) => codePointLength(value) <= PASSWORD_MAX_LENGTH, {
    error: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
  });

/**
 * An optional human-readable name, trimmed, bounded, and normalised away when it is blank.
 *
 * The service treats an omitted display name as an instruction to use the username instead, and a
 * form control that a user simply left alone should mean exactly that. So an empty string, a
 * whitespace-only string and an explicit `null` all normalise to `undefined`, which
 * `JSON.stringify` drops — the request body then carries no `display_name` key at all, which is the
 * form the service documents.
 *
 * That normalisation is also what keeps this field from being stricter than the API. The service
 * requires a *sent* display name to be at least one character after stripping, so submitting a
 * blank one would earn a `422`; converting blank to omitted is what makes an optional field behave
 * optionally instead of becoming a trap. `null` is accepted on input because the wire contract
 * permits it, even though no form control produces one.
 */
const displayNameField = z
  .string({ error: 'Display name must be text.' })
  .trim()
  .refine((value) => codePointLength(value) <= DISPLAY_NAME_MAX_LENGTH, {
    error: `Display name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters.`,
  })
  .nullable()
  .transform((value) => (value === null || value.length === 0 ? undefined : value))
  .optional();

/* -------------------------------------------------------------------------------------------------
 * Compile-time drift guard
 * ---------------------------------------------------------------------------------------------- */

/**
 * Resolves to `Source`, but only compiles when `Source` is assignable to `Target`.
 *
 * The cheapest guard available against the failure this module is written to prevent. `satisfies`
 * cannot express a constraint on a type, so the constraint rides on the generic parameter instead:
 * the alias evaluates to `Source` unchanged, which means the exported types below are exactly their
 * inferred types, while a schema edit that stops matching the wire contract fails the build at the
 * export rather than at a call site — or worse, at run time in front of a user.
 *
 * @typeParam Target - The wire shape from `@/lib/types` that must be satisfied.
 * @typeParam Source - The schema's inferred output, which must be assignable to `Target`.
 */
type AssertAssignableTo<Target, Source extends Target> = Source;

/* -------------------------------------------------------------------------------------------------
 * Form schemas
 * ---------------------------------------------------------------------------------------------- */

/**
 * Validates the sign-up form, mirroring the body of `POST /api/v1/auth/register`.
 *
 * Four fields, three required, matching the service exactly.
 *
 * **Strict: an unknown key is rejected, not stripped.** `z.strictObject` mirrors the
 * `extra='forbid'` the service's own request models declare, so the two ends agree about what a
 * payload may contain *and* about what happens when it contains something else. Stripping was the
 * earlier behaviour and it was the wrong trade at this boundary: a misspelled member simply
 * vanished, the request succeeded, and the value the author meant to send was silently absent -
 * which is a defect that reaches production looking like success. Rejecting turns the same mistake
 * into a field error naming the key.
 *
 * It is also what makes this schema the client-side escalation guard: a `role` - or an `id`, or an
 * `is_active` - present in the input is now reported rather than quietly discarded, and either way
 * cannot be sent.
 *
 * A form that carries state the wire does not have - a confirm-password box, a terms checkbox, a
 * dirty marker - must **project it away before validating**, because strictness applies to whatever
 * is handed in: `signupSchema.parse({ email, username, password, display_name })` rather than
 * `signupSchema.parse(formState)`. That projection is the form's own job and belongs at its submit
 * boundary, where the fields are named anyway.
 *
 * @example
 * ```ts
 * const form = useForm<SignupFormValues>({ resolver: zodResolver(signupSchema) });
 * ```
 */
export const signupSchema = z.strictObject({
  email: emailField,
  username: usernameField,
  password: newPasswordField,
  display_name: displayNameField,
});

/**
 * The parsed sign-up payload — precisely what should be sent as the registration body.
 *
 * Constrained at compile time to remain assignable to `RegisterRequest`, so a schema that drifts
 * from the wire contract cannot reach the branch. The type itself is the schema's inferred output
 * and nothing more.
 */
export type SignupFormValues = AssertAssignableTo<RegisterRequest, z.infer<typeof signupSchema>>;

/**
 * Validates the log-in form, mirroring the `LoginRequest` domain shape of `POST /api/v1/auth/login`.
 *
 * Note what it does **not** mirror: the wire body. That route consumes the OAuth 2 password grant, so
 * what is actually sent is `application/x-www-form-urlencoded` with the grant's own field names -
 * unlike `register`, `refresh` and `logout`, which take JSON. This schema deliberately validates the
 * form the *reader* fills in, whose identifier field is `email` and stays `email`; mapping it onto the
 * field the grant calls `username` belongs to `@/lib/api/auth` and happens in exactly one place.
 *
 * **Strict, like every request schema here**: an unknown key is reported rather than removed, so a
 * `remember_me` checkbox or a `next` redirect target has to be projected away at the submit boundary
 * instead of riding along invisibly. See {@link signupSchema}.
 *
 * @example
 * ```ts
 * const form = useForm<LoginFormValues>({ resolver: zodResolver(loginSchema) });
 * ```
 */
export const loginSchema = z.strictObject({
  email: emailField,
  password: submittedPasswordField,
});

/**
 * The parsed log-in payload — precisely what should be sent as the log-in body.
 *
 * Constrained at compile time to remain assignable to `LoginRequest`, on the same reasoning as
 * {@link SignupFormValues}.
 */
export type LoginFormValues = AssertAssignableTo<LoginRequest, z.infer<typeof loginSchema>>;
