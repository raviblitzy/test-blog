'use client';

// The account management screen. The rendered address is `/admin/users`.
//
// R11 asks for "an admin dashboard for managing users, posts, comments, and categories", and this
// file is the accounts quarter of it: one window of accounts, two filters over that window, and a
// row-action group per account. It is one of five pages that render inside the administrative
// shell, and it owns strictly less than its size suggests it should - which is the design of this
// segment rather than an omission, and the reason this header is long.
//
// -------------------------------------------------------------------------------------------------
// THE URL, WHICH THE DIRECTORY NAME MISDESCRIBES
//
// The parent directory of the `admin` segment is parenthesised, so Next.js ERASES it from every
// address beneath it. This file therefore serves `/admin/users` and NOT a parenthesised path. A
// parenthesised path is not an address, it is a 404, so no href, string or selector below spells
// one. Two other files already commit to the rendered form and must agree with this one character
// for character: `src/middleware.ts` gates `/admin/:path*`, and `src/app/robots.ts` disallows
// `/admin`. The sibling shell spells the same five section addresses in its own navigation table.
//
// -------------------------------------------------------------------------------------------------
// WHAT THIS FILE OWNS
//
//   1. The single `<h1>` for this route, and the sentence under it.
//   2. ONE read of the account listing, keyed so every row action's invalidation reaches it.
//   3. The two filters, mirrored into the address bar rather than held in local state.
//   4. The column descriptors - what each column is called, and how one account renders in it.
//
// That is the whole of it. Everything else on screen belongs to a file that already exists:
//
//   The session states.   `layout.tsx` beside this file resolves the principal and renders the
//       in-flight placeholder, the signed-out panel and the not-authorised panel itself. It only
//       renders `{children}` once an administrator is resolved, so this page renders none of those
//       four states and gates on nothing. `useAuth()` is read here for exactly one cosmetic
//       purpose - marking which row is the reader's own - and never as a permission check.
//   The section navigation and every landmark. The same shell renders the navigation band; the
//       root layout owns the document, the banner, the content region, the footer, the three
//       providers and the single toast host. So there is no landmark element below, no provider,
//       no second toast host and no stylesheet import - and no `metadata` export either, which a
//       module carrying `'use client'` may not have.
//   The grid itself.     `@/components/admin/data-table` owns the table, its collapse into record
//       cards, the placeholder rows, the empty panel, the failure panel, the result range and the
//       page control. This page hands it an envelope and a column list; it renders none of those.
//   Every mutation.      `@/components/admin/user-row-actions` owns the role change, the
//       activate/deactivate transition and the deletion, together with their confirmation dialog,
//       their toasts and their cache invalidation. This page imports neither write operation, so
//       the authority rule behind them exists in exactly one place.
//   Every request.       `@/lib/api/client` is the only module in this tier that performs HTTP.
//       This page calls one typed wrapper and constructs no request URL, no query string and no
//       header. It reads no environment variable, not even a public one.
//
// -------------------------------------------------------------------------------------------------
// THE QUERY KEY IS A SILENT CONTRACT, SO IT IS IMPORTED RATHER THAN SPELLED
//
// Nine administrative mutations invalidate five cached reads, and `@/lib/admin-cache` declares that
// graph once. Every row-action component calls `invalidateForAdminMutation`, which for a role
// change or a deactivation invalidates `ADMIN_USERS_QUERY_KEY` and for a deletion invalidates that
// plus four more keys. React Query matches an invalidation BY PREFIX, so this page's key has to
// BEGIN with that tuple.
//
// A prefix that differs by one character produces no error at all: the mutation succeeds, its toast
// appears, and the grid silently keeps showing the old row until the stale window expires. So the
// tuple is imported from the module that owns it rather than written out here. Restating it as a
// literal would put the same contract in two files and let them drift - which is precisely the
// defect `@/lib/admin-cache` was extracted to remove.
//
// -------------------------------------------------------------------------------------------------
// THREE PLACES WHERE THE GENERATED CONTRACTS DIFFER FROM THE BRIEF FOR THIS FILE
//
// The brief was written before the modules it describes existed. Where the two disagree the file
// wins, and each divergence is recorded at its use site as well as here:
//
//   1. The listing function is `listAdminUsers`, not `listUsers`, and it takes a typed parameter
//      object rather than loose arguments.
//   2. `AdminUser` carries NO avatar and NO biography - `@/lib/types` records that it is
//      deliberately not an extension of the public projection for that reason. So the identity
//      column renders an initials monogram with no image part at all.
//   3. `@/lib/types` is not declaration-only: it also exports the wire literal tuples and the
//      response validators. Only its types are needed here, so only its types are imported.
//
// -------------------------------------------------------------------------------------------------
// DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT AND IS A DEFECT HERE.
//
//   1. A free-text search box. The listing does accept a `q` term, and it is deliberately not
//      offered - see the note "WHY NO FREE-TEXT SEARCH" further down for the whole reasoning.
//   2. Client-side narrowing of the returned window. Filtering rows after they arrive would
//      misreport `total` and `pages`, because both count the SERVER's result set - so the page
//      control would offer windows that do not exist and the range line would contradict the rows
//      beneath it. Both filters are query parameters for that reason.
//   3. A page-size control. Nothing asks for one, and the window size is a single constant.
//   4. `staleTime`, `gcTime`, `refetchOnWindowFocus` or `retry` on the read. All four belong to
//      `@/providers/query-provider`, whose retry predicate refuses to retry any 4xx - which is
//      exactly why a refusal here fails fast instead of being hammered at.
//   5. An `onError` callback on the read. React Query 5 removed it from `useQuery`; it survives
//      only on `useMutation`. The announcement is therefore an effect keyed on the failure.
//   6. A `<Suspense>` boundary around the reader of the address bar. Measured on the installed
//      framework version by the sibling shell, which reads the same hook: it neither fails the
//      build nor moves this segment off prerendering, and the sibling workspace page reads it
//      directly with no boundary either.
//   7. A default React import. This tier compiles with the automatic runtime, and a build that
//      rewrote the tracked compiler configuration would fail the clean-worktree gate.

import { useCallback, useEffect, useId, useMemo } from 'react';
import type { JSX } from 'react';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

import { DataTable } from '@/components/admin/data-table';
import type { DataTableColumn } from '@/components/admin/data-table';
import { UserRowActions } from '@/components/admin/user-row-actions';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/hooks/use-auth';
import { ADMIN_USERS_QUERY_KEY } from '@/lib/admin-cache';
import { listAdminUsers } from '@/lib/api/admin';
import type { AdminUserListParams } from '@/lib/api/admin';
import { isApiError } from '@/lib/api/client';
import { EMPTY_VALUE, formatDate, formatMachineDate } from '@/lib/format';
import { profilePath } from '@/lib/seo';
import { USER_ROLES } from '@/lib/types';
import type { AdminUser, Page, UserRole } from '@/lib/types';
import { FIRST_PAGE, toPageNumber } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * The window
 * ---------------------------------------------------------------------------------------------- */

/**
 * How many accounts one window holds.
 *
 * Declared once rather than repeated, and it is the value sent to the service AND the value the
 * placeholder envelope reports - the grid derives its placeholder row count from `page_size`, so a
 * mismatch would make the loading state a different height from the loaded one and the page would
 * jump when the rows arrive.
 *
 * The service validates this member rather than adjusting it: anything outside 1..100 is answered
 * with the uniform problem document naming the parameter, never quietly clamped. Twenty is the
 * service's own default and comfortably inside that range.
 */
const PAGE_SIZE = 20;

/**
 * The address-bar parameter carrying the window.
 *
 * The name is fixed by the page control rather than chosen here: the pagination primitive builds
 * every page href itself, writing this parameter and preserving every other one, and it OMITS the
 * parameter entirely for page one so that the first window has a single canonical address. So page
 * one arrives with nothing to read, which is what {@link FIRST_PAGE} is the fallback for.
 *
 * It is also the parameter both filter handlers delete: a new predicate changes which accounts are
 * in the result set at all, so the reader's position in the previous set means nothing.
 */
const PAGE_PARAM = 'page';

/* -------------------------------------------------------------------------------------------------
 * The two filters
 *
 * WHY THE SELECTION LIVES IN THE ADDRESS AND NOT IN STATE
 *
 * A filtered view is a view worth linking to, coming back to and reloading into. Holding the
 * selection in component state would make the address describe something other than what is on
 * screen, which breaks the Back button in the specific way that is hard to notice: the URL changes,
 * the grid does not. Deriving it from the address on every render means the browser's own history is
 * the state machine, and there is no second copy to disagree with it.
 *
 * Both parameters survive pagination for free. The page control preserves every sibling parameter
 * when it builds a page href, so turning the page cannot drop a filter.
 *
 * WHY NO FREE-TEXT SEARCH
 *
 * The listing accepts a `q` term as well, and it is deliberately not offered here. A correct search
 * control is not a text field: it needs debouncing before it writes the address (or it mints one
 * history entry and one request per keystroke) and it needs a hard cap at the term length the
 * service accepts, because the listing wrapper REFUSES an over-long term synchronously rather than
 * sending it. That is a component of its own - the home feed has exactly such an island for its own
 * search - and a half-built version of it in a management toolbar would be worse than none:
 * un-debounced typing would issue a request per character against an administrative endpoint, and
 * an over-long paste would throw where the reader expected results. The two exact-match filters
 * below are the ones this screen's row actions actually mutate, which is what makes the effect of a
 * mutation observable, and they are complete.
 * ---------------------------------------------------------------------------------------------- */

/** The address-bar parameter carrying the authority filter. Its values are the wire literals. */
const ROLE_PARAM = 'role';

/** The address-bar parameter carrying the activity filter. @see {@link ACTIVE_TRUE} */
const ACTIVE_PARAM = 'active';

/**
 * The address-bar value meaning "only accounts that may authenticate".
 *
 * Spelled `true`/`false` rather than something bespoke because the underlying predicate is a
 * boolean column and the address should read as the question it asks. The pair is exhaustive: any
 * other value - a typo, a stale link, a hand-edited URL - resolves to no filter rather than to a
 * guess, so a malformed address shows every account instead of the wrong subset.
 */
const ACTIVE_TRUE = 'true';

/** The address-bar value meaning "only deactivated accounts". @see {@link ACTIVE_TRUE} */
const ACTIVE_FALSE = 'false';

/**
 * The picker value standing for "no filter on this axis".
 *
 * It cannot be the empty string. The picker primitive treats `value=""` as "nothing is selected", so
 * an option carrying it would be indistinguishable from the placeholder: the trigger would fall back
 * to placeholder text, the check indicator would never appear, and the reader could not tell that
 * "every role" was a choice they had made. An unfiltered listing is a real, choosable state here, so
 * it needs a real, non-empty value.
 *
 * The double-underscore form is safe against collision by construction: the only other values these
 * two pickers carry are the three role literals, which are upper-case words, and the two boolean
 * spellings above. It is never written to the address - both handlers map it to a DELETED parameter -
 * so it cannot leak into a link either.
 */
const NO_FILTER_VALUE = '__all__';

/* -------------------------------------------------------------------------------------------------
 * Copy
 *
 * Every string a reader can see is declared here rather than inline, so the whole vocabulary of the
 * screen can be read in one place - and so the grid's accessible name and the heading cannot drift
 * apart, which they would if each were written where it is used.
 * ---------------------------------------------------------------------------------------------- */

/** The document's single `<h1>` for this route, and the grid's accessible name. */
const HEADING = 'Users';

/** The line under the heading. */
const INTRO =
  'Every account on the site, including deactivated ones. Change an account’s role, suspend its ' +
  'sign-in, or remove it entirely.';

/**
 * Human-readable name for each authority level.
 *
 * A `Record` over the role union rather than a conditional, so the compiler is the thing that
 * guarantees completeness: if the service ever adds a fourth level the union widens and this object
 * fails to type-check until the new level has been given a name. A conditional would instead fall
 * through to whichever branch it happened to end on and render the wrong word, silently, in the
 * table and in the filter at once.
 *
 * The wire literals are upper-case; these are the sentence-case forms a person reads. Nothing
 * transforms one into the other at run time - there is no casing layer anywhere in this tier - so
 * the mapping is written out.
 */
const ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  READER: 'Reader',
  AUTHOR: 'Author',
  ADMIN: 'Administrator',
};

/** The unfiltered option of the authority picker, and its placeholder. */
const ALL_ROLES_LABEL = 'All roles';

/** The authority picker's visible caption. */
const ROLE_FILTER_LABEL = 'Role';

/** The unfiltered option of the activity picker, and its placeholder. */
const ALL_ACTIVITY_LABEL = 'Any access';

/** The activity picker's visible caption. */
const ACTIVITY_FILTER_LABEL = 'Access';

/** The activity picker's option, and the row pill, for an account that may authenticate. */
const ACTIVE_LABEL = 'Active';

/** The activity picker's option, and the row pill, for an account whose sign-in is suspended. */
const INACTIVE_LABEL = 'Deactivated';

/** The control that drops both filters at once. Rendered only while at least one is applied. */
const CLEAR_FILTERS_LABEL = 'Clear filters';

/** Marks whichever row is the signed-in administrator's own account. */
const SELF_LABEL = 'You';

/** Column heading, and the caption the same field carries inside a record card. */
const ACCOUNT_COLUMN_LABEL = 'Account';

/** @see {@link ACCOUNT_COLUMN_LABEL} */
const EMAIL_COLUMN_LABEL = 'Email';

/** @see {@link ACCOUNT_COLUMN_LABEL} */
const JOINED_COLUMN_LABEL = 'Joined';

/**
 * Heading of the row-action column.
 *
 * Its per-card caption is suppressed rather than set to this: a menu button describes itself, and
 * the grid documents the empty string as the way to say so. A field name beside a lone menu reads as
 * a mislabelled control.
 */
const ACTIONS_COLUMN_LABEL = 'Actions';

/* -------------------------------------------------------------------------------------------------
 * The three emptinesses
 *
 * An empty grid is not one state, it is three, and they call for three different sentences. Saying
 * the wrong one is worse than saying nothing: telling an administrator "no accounts yet" while
 * thirty-one accounts exist is a false statement about their own site, and it points them at a
 * remedy - wait for a sign-up - that cannot help with the thing that actually happened.
 *
 *   * The collection really is empty. Nothing to do but wait for a sign-up.
 *   * A filter matched nothing. The remedy is to widen or clear it.
 *   * The window ran off the end of a collection that DOES have rows - a stale link, a bookmark, a
 *     hand-edited address, or a page that emptied while it was open. The remedy is to go back, and
 *     the page control is still on screen for exactly that reason.
 *
 * The third is distinguishable from the envelope alone: `total` counts the whole matching set and is
 * reported independently of the window, so a positive total beside an empty row list can only mean
 * the requested page is past the last one.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Which emptiness the grid is showing.
 *
 * A closed union rather than a pair of booleans, so {@link EMPTY_COPY} is exhaustive by construction
 * and a fourth case cannot be added without being given words.
 */
type Emptiness = 'past-end' | 'filtered' | 'unpopulated';

/** Headline of the empty panel when the collection itself holds nothing. */
const EMPTY_TITLE = 'No accounts yet';

/** Supporting line for {@link EMPTY_TITLE}. */
const EMPTY_DETAIL = 'Accounts appear here as soon as somebody signs up.';

/** Headline of the empty panel when a filter is applied and nothing matched it. */
const NO_MATCH_TITLE = 'No accounts match these filters';

/** Supporting line for {@link NO_MATCH_TITLE}. */
const NO_MATCH_DETAIL = 'Widen the role or the access filter, or clear both to see every account.';

/** Headline of the empty panel when the requested window is past the end of the collection. */
const PAST_END_TITLE = 'That page is past the last one';

/**
 * Supporting line for {@link PAST_END_TITLE}.
 *
 * Deliberately names NO control, and that is a correction rather than vagueness. An earlier wording
 * said "use the page links below", which is a promise the screen cannot always keep: the grid renders
 * the page control only when the result set spans more than one page, so a filter matching eleven
 * accounts viewed at page nine is out of range with no page links on screen at all - and copy
 * pointing at an absent control is worse than copy pointing at nothing.
 *
 * It also stops short of claiming the whole set is on the first page, because it is not when the
 * collection spans several. "Go back to the first page" is the one instruction that is true in every
 * out-of-range case, whatever the reader gets there with - a page link when one is rendered, or the
 * clear-filters control, which resets the window as well as the predicate.
 */
const PAST_END_DETAIL =
  'There are fewer accounts than this page number needs. Go back to the first page to see the ones ' +
  'that match.';

/** The sentence pair for each emptiness. Exhaustive over {@link Emptiness} at compile time. */
const EMPTY_COPY: Readonly<Record<Emptiness, { readonly title: string; readonly detail: string }>> =
  {
    'past-end': { title: PAST_END_TITLE, detail: PAST_END_DETAIL },
    filtered: { title: NO_MATCH_TITLE, detail: NO_MATCH_DETAIL },
    unpopulated: { title: EMPTY_TITLE, detail: EMPTY_DETAIL },
  };

/** Headline of the failure announcement for a refusal, which is the one worth naming precisely. */
const FORBIDDEN_TITLE = 'You are not allowed to manage accounts';

/** Supporting line for {@link FORBIDDEN_TITLE} when the refusal carried no explanation of its own. */
const FORBIDDEN_DETAIL =
  'This screen needs an administrator account. Sign in as one, or ask an administrator to make the ' +
  'change for you.';

/** Headline of the failure announcement for every other failure. */
const LOAD_FAILURE_TITLE = 'Accounts could not be loaded';

/** Supporting line for {@link LOAD_FAILURE_TITLE} when nothing usable was carried. */
const LOAD_FAILURE_DETAIL = 'The request did not complete. Check the connection and try again.';

/**
 * Stands in for a field the service reported as blank.
 *
 * An em dash written as an escape rather than as a literal, because an em dash, an en dash and a
 * hyphen are near-identical in a diff and in most terminals. It exists because the grid documents
 * that a cell must never render a nullish value as visible text: an absent field is shown as an
 * explicit mark the reader can see, not as a cell that looks like a rendering bug.
 */
const ABSENT_FIELD = '\u2014';

/**
 * The status code of a refusal.
 *
 * Authority is re-checked on the service for every protected operation - the administrative router
 * applies its guard once, at the mount - so this screen can be reached and still be refused. That is
 * not a bug to hide: hiding a control is user experience, never a security boundary, and the
 * refusal is the boundary doing its job. It is narrowed here only so the announcement can name the
 * cause instead of reporting a generic failure.
 */
const FORBIDDEN_STATUS = 403;

/**
 * How many words of a name contribute a letter to the monogram.
 *
 * Two, so `'Alice Chen'` yields `AC` and `'Ada B. Lovelace'` yields `AB`. Three or more letters stop
 * fitting the circle at its resting diameter.
 */
const INITIALS_WORD_LIMIT = 2;

/**
 * The first grapheme of a word, tolerant of combining marks and of characters outside the basic
 * plane.
 *
 * The alternative - indexing a string - can split a surrogate pair and emit half a character.
 */
const FIRST_GRAPHEME_PATTERN = /^\P{M}\p{M}*/u;

/**
 * The empty row list used while no envelope has arrived.
 *
 * A module-level constant so the placeholder envelope is built from a stable identity rather than a
 * fresh array on every render. Typed as the envelope's own member type rather than as a readonly
 * array, because that is the shape the grid's `page` prop declares; nothing here mutates it.
 */
const NO_ACCOUNTS: AdminUser[] = [];

/* -------------------------------------------------------------------------------------------------
 * Presentation
 *
 * Every value below is a utility generated from this design system's own token scales - spacing from
 * the `--spacing` multiplier, type steps from `--text-*`, colours from the twelve semantic tokens in
 * `src/app/globals.css`. There is no literal colour, dimension, radius or shadow anywhere in this
 * file, no `dark:` conditional - the tokens are dual-valued, so the screen themes itself - and no
 * media query: the grid's collapse into record cards is owned entirely by `@/components/ui/table`,
 * and the only responsive lever this file holds is the per-column demotion flag.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The page's vertical stack.
 *
 * `min-w-0` is load-bearing rather than defensive, and matches the shell above it: without it a flex
 * item refuses to shrink below its content's intrinsic width, so one wide table or one unbroken
 * address would widen the document and produce the horizontal overflow the responsive criteria
 * forbid at every tested width.
 */
const PAGE_CLASSES = 'flex min-w-0 flex-col gap-6';

/** The heading block: the `<h1>` and the sentence beneath it. */
const HEADER_CLASSES = 'flex flex-col gap-2';

/** The `<h1>`. Matches the sibling workspace page's heading step so the two segments align. */
const HEADING_CLASSES = 'text-foreground text-2xl font-semibold tracking-tight';

/** The supporting line, held to a readable measure by a `--container-*` step. */
const INTRO_CLASSES = 'text-muted-foreground max-w-2xl text-sm';

/**
 * The filter row.
 *
 * `flex-wrap` is what keeps the narrowest viewport free of horizontal scroll and is this tier's
 * backstop wherever a row of controls can outgrow its container: the two pickers and the clear
 * control settle onto one line from roughly the small breakpoint upward and stack below it, with no
 * breakpoint variant and therefore no width at which the row is neither wrapped nor complete.
 * `items-end` aligns the controls along their baselines even though one column carries a caption of a
 * different length.
 */
const FILTER_ROW_CLASSES = 'flex flex-wrap items-end gap-4';

/** One captioned control: its `<label>` above its trigger. */
const FILTER_FIELD_CLASSES = 'flex min-w-0 flex-col gap-1.5';

/**
 * The picker trigger's width.
 *
 * A spacing-scale step rather than a measurement, and a floor rather than a fixed size: `min-w-` lets
 * a long option label widen the trigger instead of truncating inside it, while stopping the two
 * pickers from collapsing to the width of their shortest option and jumping about as the selection
 * changes. `w-full` below the small breakpoint is what makes the stacked arrangement read as two full
 * rows rather than two ragged half-width controls.
 */
const FILTER_TRIGGER_CLASSES = 'w-full min-w-44 sm:w-auto';

/** The identity cell: the monogram beside the name and handle. */
const IDENTITY_CLASSES = 'flex min-w-0 items-center gap-3';

/** The name and handle, stacked. */
const IDENTITY_TEXT_CLASSES = 'flex min-w-0 flex-col';

/**
 * The account's display name.
 *
 * `wrap-anywhere` rather than the inherited word-breaking: a display name is unbounded text this
 * screen does not control, and it is the one value here that can be arbitrarily long. The break
 * opportunities that ordinary word-breaking introduces are excluded from min-content sizing, so an
 * unbreakable word still sets the floor for its inline-flex ancestors and the row grows past its
 * container. `wrap-anywhere` is the value whose break opportunities do count toward min-content, so
 * it collapses that floor and the word finally breaks.
 */
const IDENTITY_NAME_CLASSES = 'text-foreground flex items-center gap-2 font-medium wrap-anywhere';

/**
 * The handle, rendered as a link to the account's public profile.
 *
 * `hover:text-primary` is the only interactive treatment added here; the focus ring comes from the
 * ring token so it matches every other focusable element on the screen, and it is `focus-visible`
 * rather than `focus` so a pointer click does not leave a ring behind.
 */
const HANDLE_LINK_CLASSES =
  'text-muted-foreground hover:text-primary focus-visible:outline-ring w-fit rounded-sm text-sm ' +
  'wrap-anywhere focus-visible:outline-2 focus-visible:outline-offset-2 motion-safe:transition-colors';

/** The email address. Unbounded text, so it breaks for the same reason a name does. */
const EMAIL_CLASSES = 'wrap-anywhere';

/** The join date. `tabular-nums` keeps the column from shifting as the digits change. */
const JOINED_CLASSES = 'text-muted-foreground text-sm tabular-nums';

/* -------------------------------------------------------------------------------------------------
 * Helpers
 *
 * Every function here is TOTAL: none throws, and each one has a defined answer for a blank field, an
 * unparseable instant and a value the service is not supposed to be able to send. That is not
 * defensive decoration in a management table - it is what stops one malformed row from blanking a
 * screen an administrator needs in order to fix that very row.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Narrow an address-bar value to an authority level.
 *
 * `find` over the wire tuple rather than a cast or a set membership test, so the returned value is
 * the union member itself and an unrecognised string becomes "no filter" rather than a predicate the
 * service would refuse. It is used in both directions - reading the address, and validating what a
 * picker asks to write into it - so a stale or hand-edited link can never put an unknown authority on
 * the query string.
 *
 * @param value - A raw parameter value, or `null` when the parameter is absent.
 * @returns The authority to filter on, or `undefined` for no filter.
 */
function toRoleFilter(value: string | null): UserRole | undefined {
  if (value === null) {
    return undefined;
  }

  return USER_ROLES.find((role) => role === value);
}

/**
 * Narrow an address-bar value to an activity predicate.
 *
 * A `false` here is a REAL filter rather than merely a falsy value - listing the deactivated accounts
 * is the reason this filter exists - so the three states are distinguished explicitly and the
 * listing wrapper sends `false` rather than dropping it. Anything unrecognised is no filter at all.
 *
 * @param value - A raw parameter value, or `null` when the parameter is absent.
 * @returns `true` for active only, `false` for deactivated only, `undefined` for both.
 */
function toActivityFilter(value: string | null): boolean | undefined {
  if (value === ACTIVE_TRUE) {
    return true;
  }

  if (value === ACTIVE_FALSE) {
    return false;
  }

  return undefined;
}

/**
 * The picker value that represents an activity predicate.
 *
 * The inverse of {@link toActivityFilter}, kept beside it so the two spellings cannot drift.
 *
 * @param value - The predicate currently in force, or `undefined` for no filter.
 * @returns The non-empty value the picker's selection is compared against.
 */
function toActivityValue(value: boolean | undefined): string {
  if (value === undefined) {
    return NO_FILTER_VALUE;
  }

  return value ? ACTIVE_TRUE : ACTIVE_FALSE;
}

/**
 * The first grapheme of a word, or the empty string for an empty word.
 *
 * @param word - A single whitespace-free word.
 * @returns One grapheme, or `''` only when `word` itself is empty.
 */
function firstGrapheme(word: string): string {
  return FIRST_GRAPHEME_PATTERN.exec(word)?.[0] ?? [...word][0] ?? '';
}

/**
 * The monogram shown in place of an avatar image.
 *
 * There is no image part in the identity cell at all, and that is a contract rather than a
 * simplification: the administrative account projection deliberately carries neither an avatar nor a
 * biography, because a management table does not render them. So the monogram is the whole avatar,
 * not a fallback waiting for a picture that cannot arrive.
 *
 * @param name - The already-resolved visible name, never a raw nullable field.
 * @returns One or two upper-cased graphemes, or `''` only for an entirely blank name.
 */
function initialsFrom(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, INITIALS_WORD_LIMIT)
    .map(firstGrapheme)
    .join('')
    .toUpperCase();
}

/**
 * The name to show for an account.
 *
 * `display_name` is typed non-nullable and the service guarantees a value - the column is `NOT NULL`
 * and registration derives one from the handle when the caller supplies none - so this is a blankness
 * guard rather than a null guard: `string` still admits `''` and `'   '`, and either would render a
 * row whose only identifying text was an email address. The handle is the right substitute because it
 * is unique, non-null, and the very segment the profile link is built from, so the visible name and
 * the destination agree.
 *
 * @param account - The account being described.
 * @returns The display name when it carries any non-whitespace text, otherwise the handle.
 */
function accountName(account: AdminUser): string {
  return account.display_name.trim().length > 0 ? account.display_name : account.username;
}

/**
 * Turn a value the service reported as possibly blank into something a reader can see.
 *
 * @param value - The field as it arrived.
 * @returns The value verbatim when it carries text, otherwise {@link ABSENT_FIELD}.
 */
function orAbsent(value: string): string {
  return value.trim().length > 0 ? value : ABSENT_FIELD;
}

/**
 * Turn a caught value into one sentence that is safe to show an administrator.
 *
 * The service renders one problem document for every failure path and writes its detail line to be
 * read by a person, so a well-behaved refusal needs unwrapping rather than interpretation. The
 * document's title is the fallback for the rare one whose detail is blank, and a plain error message
 * covers a failure the service never described at all - a connection that never opened, a deadline
 * that fired first.
 *
 * What it never returns is the document itself, a status code, a stack or the correlation identifier.
 * Those belong in a log rather than in front of a reader.
 *
 * @param error - The rejection, as the query surfaced it.
 * @returns One sentence, or `undefined` when nothing usable was carried - in which case the caller
 * substitutes its own supporting line rather than announcing an empty one.
 */
function describeFailure(error: unknown): string | undefined {
  if (isApiError(error)) {
    const detail = error.problem.detail.trim();

    if (detail.length > 0) {
      return detail;
    }

    const title = error.problem.title.trim();

    return title.length > 0 ? title : undefined;
  }

  if (error instanceof Error) {
    const message = error.message.trim();

    return message.length > 0 ? message : undefined;
  }

  return undefined;
}

/**
 * Decide which of the three emptinesses applies.
 *
 * The out-of-range case is tested FIRST and wins over the filtered one, because when both are true
 * the useful advice is "go back a page", not "widen the filter": a filtered set of ten accounts
 * viewed at page five has matches, just not on that page, so widening the filter would answer a
 * question the reader did not ask.
 *
 * `undefined` means no envelope has arrived, which cannot be out of range: nothing has been reported
 * yet. The grid's own precedence keeps the placeholder rows in front of this panel while a read is in
 * flight, so that case never reaches a reader.
 *
 * @param envelope - The resolved page, or `undefined` while the first read is on the wire.
 * @param hasFilter - Whether either filter is currently applied.
 * @returns The emptiness whose words to show.
 */
function emptinessOf(envelope: Page<AdminUser> | undefined, hasFilter: boolean): Emptiness {
  if (envelope !== undefined && envelope.total > 0 && envelope.items.length === 0) {
    return 'past-end';
  }

  return hasFilter ? 'filtered' : 'unpopulated';
}

/**
 * Whether a failure is the service refusing an insufficiently privileged caller.
 *
 * @param error - The rejection, or `null` when the read succeeded.
 * @returns `true` only for a refusal carrying the forbidden status.
 */
function isForbidden(error: Error | null): boolean {
  return error !== null && isApiError(error) && error.status === FORBIDDEN_STATUS;
}

/**
 * Stable identity for one row.
 *
 * Declared at module scope so the grid receives the same function on every render. The value is the
 * service-generated identifier - identity is owned by the service, and nothing in this tier mints
 * one - and never an array index, which would make React reuse one account's row for another as the
 * grid filters and pages.
 *
 * @param account - The row being keyed.
 * @returns The account's identifier.
 */
function accountRowId(account: AdminUser): string {
  return account.id;
}

/* -------------------------------------------------------------------------------------------------
 * The filter row
 * ---------------------------------------------------------------------------------------------- */

/** Props of {@link AccountFilters}. */
interface AccountFiltersProps {
  /** The authority currently filtered on, or `undefined` for every authority. */
  readonly role: UserRole | undefined;
  /** The activity predicate currently in force, or `undefined` for both states. */
  readonly isActive: boolean | undefined;
  /**
   * Called with the picker's raw value when the authority selection changes.
   *
   * Raw rather than narrowed, because that is what the picker emits; the page narrows it before it
   * reaches the address, so an unrecognised value can never be written to a link.
   */
  readonly onRoleChange: (value: string) => void;
  /** Called with the picker's raw value when the activity selection changes. */
  readonly onActivityChange: (value: string) => void;
  /** Called when the reader drops both filters at once. */
  readonly onClear: () => void;
}

/**
 * The two pickers, and the control that clears them.
 *
 * Rendered into the grid's own filter slot rather than above it, so the spacing between the filters
 * and the table is decided in one place. The grid lays the slot out and reads nothing from it - a
 * filter is entity-specific and the state behind it lives in the address, so both belong to the
 * screen.
 *
 * ### Why the selection is passed in rather than read here
 *
 * This component holds no state and reads no navigation hook. The page above it already subscribes to
 * the address bar, and a second subscription in a child would rebuild the same values from the same
 * source - the pattern the grid itself removed when it stopped calling the pagination hook a second
 * time. So the resolved selection arrives as props and the change handlers go back up.
 *
 * ### Accessibility
 *
 *   * Each picker is named by a real, visible `<label>` bound with `htmlFor`. The trigger primitive
 *     deliberately does not name itself, because a name invented on the control is one no sighted
 *     reader can see and no label can override.
 *   * The identifiers are derived from one generated root, so two instances of this row could not
 *     steal each other's association, and neither can collide with an identifier elsewhere in the
 *     document.
 *   * The unfiltered option is a real, choosable option with a visible check when it is selected -
 *     not the absence of a selection - so "every role" reads as a decision rather than as an empty
 *     control.
 *   * Everything else - the listbox roles, roving focus, typeahead, dismissal and focus restoration -
 *     belongs to the primitive underneath and is deliberately not reimplemented.
 *
 * @param props - See {@link AccountFiltersProps}.
 * @returns The filter row.
 */
function AccountFilters({
  role,
  isActive,
  onRoleChange,
  onActivityChange,
  onClear,
}: AccountFiltersProps): JSX.Element {
  const fieldId = useId();
  const roleFieldId = `${fieldId}role`;
  const activityFieldId = `${fieldId}activity`;

  // The clear control appears only when there is something to clear. Rendering it permanently would
  // put a dead control in the row on the screen's most common state, which is unfiltered.
  const hasFilter = role !== undefined || isActive !== undefined;

  return (
    <div className={FILTER_ROW_CLASSES}>
      <div className={FILTER_FIELD_CLASSES}>
        <Label htmlFor={roleFieldId}>{ROLE_FILTER_LABEL}</Label>
        <Select onValueChange={onRoleChange} value={role ?? NO_FILTER_VALUE}>
          <SelectTrigger className={FILTER_TRIGGER_CLASSES} id={roleFieldId}>
            <SelectValue placeholder={ALL_ROLES_LABEL} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_FILTER_VALUE}>{ALL_ROLES_LABEL}</SelectItem>
            {/* The wire tuple is declared least-privilege first, so the options read in that order
                without this file choosing one. */}
            {USER_ROLES.map((value) => (
              <SelectItem key={value} value={value}>
                {ROLE_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className={FILTER_FIELD_CLASSES}>
        <Label htmlFor={activityFieldId}>{ACTIVITY_FILTER_LABEL}</Label>
        <Select onValueChange={onActivityChange} value={toActivityValue(isActive)}>
          <SelectTrigger className={FILTER_TRIGGER_CLASSES} id={activityFieldId}>
            <SelectValue placeholder={ALL_ACTIVITY_LABEL} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_FILTER_VALUE}>{ALL_ACTIVITY_LABEL}</SelectItem>
            <SelectItem value={ACTIVE_TRUE}>{ACTIVE_LABEL}</SelectItem>
            <SelectItem value={ACTIVE_FALSE}>{INACTIVE_LABEL}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {hasFilter ? (
        <Button onClick={onClear} type="button" variant="secondary">
          {CLEAR_FILTERS_LABEL}
        </Button>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------------------------------
 * The route
 * ---------------------------------------------------------------------------------------------- */

/**
 * The account management screen at `/admin/users`.
 *
 * Reads one window of accounts, narrowed by whichever of the two filters the address carries, and
 * renders it as the shared administrative grid with a row-action group per account.
 *
 * ### The three states it renders
 *
 * 1. **In flight** - the heading stands where it will stand and the grid draws placeholder rows in
 *    the real table, one per row the window will hold, so nothing moves when the accounts arrive.
 * 2. **Failed** - the grid reports the problem document in place, and one toast says the same thing
 *    once. A refusal is named for what it is; every other failure is reported generically. Neither
 *    shows a status code, a stack or a correlation identifier.
 * 3. **Loaded** - the rows, the result range and the page control.
 *
 * The states the shell owns are absent by design: no placeholder for the session, no signed-out
 * panel, no not-authorised panel and no redirect. The shell renders all four and only renders this
 * page once an administrator is resolved.
 *
 * ### Why a refetch does not flash placeholders
 *
 * A row action invalidates this key and the grid keeps its rows while the refetch is in flight,
 * because a query that already holds data is refetching rather than pending. Turning the page is the
 * other case: the address changes, the key changes with it, and a key with nothing cached IS pending -
 * so a page turn draws placeholders and a mutation does not. That is the honest split, and it is why
 * no placeholder-retention option is set: retaining the previous page's rows across a filter change
 * would briefly show accounts that do not match the filter the reader just chose.
 *
 * @returns The management screen for whichever of the three states applies.
 */
export default function AdminUsersPage(): JSX.Element {
  /*
   * Throws only when the session provider is missing, which is a wiring defect and deliberately
   * loud. A `null` user inside a live provider is an ordinary state, and the optional access below is
   * what handles it - this is not a gate, and the shell has already resolved an administrator by the
   * time this page renders.
   */
  const { user } = useAuth();

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /*
   * The window and the two predicates, straight from the address, so a result is linkable, survives a
   * reload and is correct under Back and Forward. The page parse is the tier's own: digits only, at
   * least one, and bounded, so a missing, blank, fractional, negative or non-numeric value falls back
   * to the first page instead of putting a nonsense number into a request. Page one is the case that
   * matters most - the page control omits the parameter entirely there, so the first window always
   * arrives with nothing to read.
   */
  const page = toPageNumber(searchParams.get(PAGE_PARAM)) ?? FIRST_PAGE;
  const role = toRoleFilter(searchParams.get(ROLE_PARAM));
  const isActive = toActivityFilter(searchParams.get(ACTIVE_PARAM));

  /*
   * Exactly the members the listing declares, and no others. `role` and `is_active` are left
   * `undefined` when unfiltered rather than being pruned here: the request layer already drops a
   * nullish or blank value from the query string and keeps a meaningful `false`, and pruning here
   * would be a second implementation of a rule it owns.
   *
   * Memoised on the three primitives so the object handed to the request is stable for as long as the
   * address is, which keeps the request function out of a fresh closure on every render.
   */
  const params = useMemo<AdminUserListParams>(
    () => ({ page, page_size: PAGE_SIZE, role, is_active: isActive }),
    [page, role, isActive],
  );

  const { data, error, isPending } = useQuery({
    /*
     * The prefix is the imported tuple, so this key cannot fall out of step with what the row
     * actions invalidate; the parameters follow it, so every cached window and every filtered
     * variant is reached by one prefix invalidation. See the note in the module header for what a
     * mismatch here would look like - which is nothing at all, until a role change fails to appear.
     */
    queryKey: [...ADMIN_USERS_QUERY_KEY, params],
    /*
     * The signal is forwarded so an abandoned window's request is cancelled rather than left to
     * resolve into a cache nothing is reading. Nothing else about the request is set here: the base
     * address, the credential and the failure normalisation all belong to the client module.
     */
    queryFn: ({ signal }): Promise<Page<AdminUser>> => listAdminUsers(params, { signal }),
  });

  /*
   * The announcement half of the failure report, fired from an effect rather than from the render
   * body: a toast is a side effect, and the read hook carries no failure callback of its own in this
   * major version. Keyed on the failure's identity, so one failure is announced once rather than on
   * every re-render, and a recovery announces nothing. The panel the grid renders is the part that
   * persists; this is the part that interrupts.
   */
  useEffect(() => {
    if (error === null) {
      return;
    }

    const forbidden = isForbidden(error);

    toast.error(forbidden ? FORBIDDEN_TITLE : LOAD_FAILURE_TITLE, {
      description: describeFailure(error) ?? (forbidden ? FORBIDDEN_DETAIL : LOAD_FAILURE_DETAIL),
    });
  }, [error]);

  /*
   * Which row is the reader's own. A cosmetic marker so an administrator can see at a glance which
   * account they are acting through - it changes no behaviour, gates nothing, and is deliberately not
   * passed into the row-action group, whose declared props carry no such flag.
   */
  const ownAccountId = user?.id;

  const columns = useMemo<ReadonlyArray<DataTableColumn<AdminUser>>>(
    () => [
      {
        id: 'account',
        header: ACCOUNT_COLUMN_LABEL,
        label: ACCOUNT_COLUMN_LABEL,
        cell: (account): JSX.Element => {
          const name = accountName(account);
          const handle = account.username.trim();

          return (
            <div className={IDENTITY_CLASSES}>
              {/*
               * Hidden from assistive technology in its entirety, because the fallback renders the
               * monogram as TEXT and the name is right beside it - announcing both would read the
               * account's initials and then its name. The root is a non-focusable element, so hiding
               * it cannot strand anything focusable outside the accessibility tree.
               *
               * There is no image part: the administrative projection carries no avatar, so the
               * monogram is the whole avatar rather than a fallback. That also means no remote image
               * host has to be permitted for this screen, and no raw image element appears anywhere
               * in it.
               */}
              <Avatar aria-hidden="true">
                <AvatarFallback>{initialsFrom(name)}</AvatarFallback>
              </Avatar>

              <div className={IDENTITY_TEXT_CLASSES}>
                <span className={IDENTITY_NAME_CLASSES}>
                  {name}
                  {/*
                   * The neutral tone, which is the one this design system designates for a value
                   * with no state semantics. The word carries the meaning; the pill is not the only
                   * thing saying it.
                   */}
                  {account.id === ownAccountId ? <Badge>{SELF_LABEL}</Badge> : null}
                </span>

                {/*
                 * The handle links to the account's public profile, built by the module that owns
                 * every public address rather than assembled here - a hand-built path is the one
                 * mistake that compiles, type-checks, lints and then 404s at run time.
                 *
                 * The blankness guard is why the link is conditional. The builder THROWS on an empty
                 * segment, which is the right behaviour for a byline rendering one account and the
                 * wrong behaviour for a table rendering twenty: a single malformed row would take the
                 * whole management screen down, and this is the screen an administrator would need in
                 * order to fix that row. The handle is unique and non-null on the service, so this
                 * path is unreachable in practice and cheap to keep.
                 */}
                {handle.length > 0 ? (
                  <Link className={HANDLE_LINK_CLASSES} href={profilePath(account.username)}>
                    {`@${account.username}`}
                  </Link>
                ) : null}
              </div>
            </div>
          );
        },
      },
      {
        id: 'email',
        header: EMAIL_COLUMN_LABEL,
        label: EMAIL_COLUMN_LABEL,
        cell: (account): JSX.Element => (
          <span className={EMAIL_CLASSES}>{orAbsent(account.email)}</span>
        ),
      },
      {
        id: 'role',
        header: ROLE_FILTER_LABEL,
        label: ROLE_FILTER_LABEL,
        /*
         * The default neutral tone, for all three levels. This design system's pill catalogue holds
         * no authority-specific tone and names the neutral one for exactly this case - "a value that
         * has no state semantics: a user's role, a tag, a count" - so the WORD is what distinguishes
         * an administrator from a reader. Spending a status tone here would assert a lifecycle state
         * an account does not have, and inventing a colour would leave the token layer altogether.
         */
        cell: (account): JSX.Element => <Badge>{ROLE_LABELS[account.role]}</Badge>,
      },
      {
        id: 'activity',
        header: ACTIVITY_FILTER_LABEL,
        label: ACTIVITY_FILTER_LABEL,
        /*
         * Two states, so a conditional is exhaustive by construction. The affirmative tone for an
         * account that may authenticate; the one tone in the catalogue built on the danger token for
         * one that may not, which is the correct reading of a deactivation - a decision taken against
         * the account, still reversible, and the reversible alternative to deleting it. The pill is
         * toned rather than filled for that reason, and the word says the same thing as the colour.
         */
        cell: (account): JSX.Element =>
          account.is_active ? (
            <Badge variant="approved">{ACTIVE_LABEL}</Badge>
          ) : (
            <Badge variant="rejected">{INACTIVE_LABEL}</Badge>
          ),
      },
      {
        id: 'joined',
        header: JOINED_COLUMN_LABEL,
        label: JOINED_COLUMN_LABEL,
        /*
         * The one secondary column, demoted below the widest tier so the middle tier carries the
         * primary columns only. A join date is context rather than something an administrator acts
         * on, which is what makes it the right candidate; the identity and the row actions are
         * never demoted, because both have to stay reachable at the narrowest width.
         */
        hideBelowLg: true,
        cell: (account): JSX.Element => {
          /*
           * The machine-readable instant and the human label come from the same pair of total
           * formatters, and both answer with the empty marker rather than throwing on an
           * unparseable value - so the guard is what keeps a time element from being emitted with a
           * malformed attribute.
           */
          const machine = formatMachineDate(account.created_at);

          if (machine === EMPTY_VALUE) {
            return <span className={JOINED_CLASSES}>{ABSENT_FIELD}</span>;
          }

          return (
            <time className={JOINED_CLASSES} dateTime={machine}>
              {formatDate(account.created_at)}
            </time>
          );
        },
      },
      {
        id: 'actions',
        header: ACTIONS_COLUMN_LABEL,
        /*
         * The per-card caption is suppressed rather than set: a menu button describes itself, and a
         * field name beside a lone menu reads as a mislabelled control. `end` puts it at the trailing
         * edge from the middle tier upward, where the cell is a real table cell; in the record card
         * the menu is the cell's only child and needs no alignment of its own.
         */
        label: '',
        align: 'end',
        /*
         * The whole reason this screen is a client module: a render function cannot cross the
         * server-to-client boundary, so a server component could not describe a column at all. Every
         * write this screen performs happens inside here - the role change, the activate and
         * deactivate transitions, the deletion, their confirmation dialog and their cache
         * invalidation - and none of it is duplicated above.
         */
        cell: (account): JSX.Element => <UserRowActions user={account} />,
      },
    ],
    [ownAccountId],
  );

  /*
   * One place where a filter change becomes a navigation.
   *
   * A COPY of the current parameters, never a fresh set: that is what preserves anything else the
   * address carries, now and after a later parameter is added. The object the hook returns is
   * read-only and throws on a write, so the copy is required rather than stylistic.
   *
   * The window is dropped on every filter change, always. A new predicate changes which accounts are
   * in the result set at all, so page three of the previous set names nothing - and because the page
   * parameter is absent for page one, dropping it is also how the reader is returned to the first
   * window.
   *
   * Pushed rather than replaced, so a filter change is a destination the Back button returns through,
   * and without scrolling, because the grid is already the thing being looked at.
   */
  const commit = useCallback(
    (mutate: (next: URLSearchParams) => void): void => {
      const next = new URLSearchParams(searchParams.toString());

      mutate(next);
      next.delete(PAGE_PARAM);

      const query = next.toString();

      router.push(query.length > 0 ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const changeRole = useCallback(
    (value: string): void => {
      // Narrowed before it is written, so only a wire literal can ever reach the address. The picker
      // emits nothing else, and this is what keeps that true if it ever could.
      const next = toRoleFilter(value);

      commit((search) => {
        if (next === undefined) {
          search.delete(ROLE_PARAM);
        } else {
          search.set(ROLE_PARAM, next);
        }
      });
    },
    [commit],
  );

  const changeActivity = useCallback(
    (value: string): void => {
      const next = toActivityFilter(value);

      commit((search) => {
        if (next === undefined) {
          search.delete(ACTIVE_PARAM);
        } else {
          search.set(ACTIVE_PARAM, next ? ACTIVE_TRUE : ACTIVE_FALSE);
        }
      });
    },
    [commit],
  );

  const clearFilters = useCallback((): void => {
    commit((search) => {
      search.delete(ROLE_PARAM);
      search.delete(ACTIVE_PARAM);
    });
  }, [commit]);

  /*
   * The grid's `page` prop is required, so an envelope always exists. Before one has arrived this
   * stands in with the window that was ASKED for - the requested page and the real window size, which
   * is what the grid derives its placeholder row count from, so the loading state is the same height
   * as the loaded one. Zero rows, zero total and zero pages are the honest values for a window that
   * has not been served; the grid's own precedence puts the placeholder or the failure panel in front
   * of them, so no reader ever sees a "0 of 0" line stand in for a page that is still on the wire.
   */
  const accounts: Page<AdminUser> = data ?? {
    items: NO_ACCOUNTS,
    total: 0,
    page,
    page_size: PAGE_SIZE,
    pages: 0,
  };

  const hasFilter = role !== undefined || isActive !== undefined;

  /*
   * Which emptiness to name, decided from the envelope rather than from the filter state alone. A
   * window past the end of a populated collection is the case the filter state cannot see, and
   * getting it wrong tells an administrator their site has no accounts when it has plenty.
   */
  const empty = EMPTY_COPY[emptinessOf(data, hasFilter)];

  return (
    <div className={PAGE_CLASSES}>
      {/* The document's single heading for this route. The shell above emits none, and the grid emits
          none, so the outline for this address is exactly this one element. */}
      <div className={HEADER_CLASSES}>
        <h1 className={HEADING_CLASSES}>{HEADING}</h1>
        <p className={INTRO_CLASSES}>{INTRO}</p>
      </div>

      <DataTable
        caption={HEADING}
        columns={columns}
        /* Which emptiness this is, said accurately. Three states, three sentences - see the note on
           {@link Emptiness} for why conflating any two of them misinforms the reader. */
        emptyDescription={empty.detail}
        emptyTitle={empty.title}
        /* Handed over rather than interpreted. The grid narrows the problem document itself and
           renders it in the one shape every administrative screen uses, so no screen writes a
           mapping step and none can write a different one. */
        error={error}
        getRowId={accountRowId}
        isLoading={isPending}
        page={accounts}
        toolbar={
          <AccountFilters
            isActive={isActive}
            onActivityChange={changeActivity}
            onClear={clearFilters}
            onRoleChange={changeRole}
            role={role}
          />
        }
      />
    </div>
  );
}
