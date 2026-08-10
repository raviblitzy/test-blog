'use client';

// UserMenu - the session affordance of the application shell.
//
// One of the five members of src/components/layout/ (AAP §0.4.5.3), and the one the folder's
// purpose statement calls the "session menu" (AAP §0.7.1.8, Group 8). It is rendered by
// src/components/layout/site-header.tsx, which the root layout mounts once - so this component is
// on EVERY route, in the header, at every viewport. Everything below follows from that one fact.
//
// ---------------------------------------------------------------------------------------------
// 1. IT RENDERS THREE STATES, AND EXACTLY ONE OF THEM IS AN ERROR-FREE DEFAULT
//
// `useAuth()` reports the session, and its three renderable answers are not variations on a
// theme - they are different controls:
//
//   isLoading            -> the one-time restoration has not settled. A PLACEHOLDER, sized to the
//                           resolved trigger so the header does not jump when the answer arrives.
//   user === null        -> ANONYMOUS, which is an ordinary state and never an error. Sign-in and
//                           sign-up affordances.
//   user !== null        -> the session menu.
//
// The order matters. Reading `user` before `isLoading` would offer "Log in" for one frame to a
// reader who is in fact signed in - the exact flicker the provider added `isLoading` to prevent -
// and it is visible on every navigation because this component is in the header.
//
// Narrowing is done on `user` rather than on `isAuthenticated`. The two agree by construction
// (`isAuthenticated` IS `user !== null`, derived once in the provider), but only the former teaches
// TypeScript that the account is non-null, so the authenticated branch needs no assertion.
//
// `restoreError` is DELIBERATELY NOT READ. When it is set with a null user the identity is unknown
// rather than anonymous, and the provider suggests a surface that renders a sign-in PROMPT should
// offer a retry instead. This is not that surface: it is the header's account control, the reader
// can still sign in from it, the credential is intact so any later request carries it, and
// `@/lib/api/client` retries once by itself. Turning the header into an error reporter would put a
// failure banner on every route for a condition the next request resolves.
//
// ---------------------------------------------------------------------------------------------
// 2. WHAT RADIX OWNS. NONE OF IT IS REIMPLEMENTED HERE.
//
// The menu is `@/components/ui/dropdown-menu`, which wraps @radix-ui/react-dropdown-menu. So this
// file contains NO onKeyDown, NO click-outside listener, NO portal, NO positioning arithmetic and
// NO hand-written `role` or `aria-haspopup`/`aria-expanded`/`aria-controls`. Roving focus,
// typeahead, Escape dismissal, focus restoration to the trigger and collision-aware placement all
// arrive with the primitive. Adding any of them here would be a second implementation of correct
// behaviour, and the two would drift.
//
// The one piece of ARIA this file DOES own is the trigger's accessible NAME - see the note on
// `aria-label` at the trigger, and note that the primitive explicitly forbids giving the trigger an
// `id`, because Radix derives both ids from one `useId()` and names the panel from the trigger.
//
// ---------------------------------------------------------------------------------------------
// 3. THE ADMIN ENTRY IS USER EXPERIENCE. IT IS NOT A SECURITY BOUNDARY.
//
// The `/admin` row is rendered only for an `ADMIN` principal, and that is a convenience: it keeps a
// reader from being shown a section they cannot use. HIDING A CONTROL PROTECTS NOTHING. Anyone can
// type the URL, edit this bundle, or call the API directly. Real authority is:
//
//   * `require_admin`, applied once on the /admin router include in backend/app/api/v1/router.py,
//     so no administrative endpoint can omit it; and
//   * the ownership assertions in backend/app/services/post_service.py and comment_service.py.
//
// `src/middleware.ts` also gates the route group before render, and that is defence in depth for
// the same reason - also not a boundary. Nothing in this file is relied upon by anything.
//
// ---------------------------------------------------------------------------------------------
// 4. DELIBERATELY ABSENT. EACH LOOKS LIKE AN IMPROVEMENT.
//
//   1. Any `fetch`, and any import from `@/lib/api/*`. `logout()` comes from the provider, which is
//      the tier's single owner of the session lifecycle; a second path to the same endpoint would
//      bypass its credential-store and presence-cookie writes. The component tests run MSW with
//      `onUnhandledRequest: 'error'`, so a stray request would fail the suite outright.
//   2. Any environment read, including a `NEXT_PUBLIC_*` key, and any token handling. This file
//      never sees, decodes, logs or renders a credential. `user.role` arrives from the provider's
//      authoritative account read, never from a token claim.
//   3. An identity block naming the signed-in address. `role="menu"` admits menuitem, group and
//      separator children; a bare `<div>` of text inside it is an ARIA structure violation, and the
//      trigger's own accessible name already identifies the account.
//   4. A heading of any level. Exactly one `<h1>` per page and the page owns it.
//   5. `next/image`. `@/components/ui/avatar` renders Radix's own image part, which is why avatars
//      need no `images.remotePatterns` entry and why `@next/next/no-img-element` never fires.
//   6. Focus management after sign-out. The trigger unmounts when the session ends, so focus falls
//      to the document - the platform default for a control that completes and disappears. Tracking
//      it by hand is exactly the interaction logic this layer refuses to write.
//   7. A bespoke notification. A failed revocation is reported with `sonner`, whose `<Toaster />`
//      the root layout already mounts.
//
// ---------------------------------------------------------------------------------------------
// 5. EVERY VALUE IS A TOKEN
//
// No literal colour, dimension, font size, radius or shadow appears below, and there is no
// arbitrary-value class (`w-[220px]`, `text-[#1a1a1a]`) and no `style` prop. Colour comes only from
// the semantic layer in src/app/globals.css, reached through the primitives' own variants; spacing,
// sizing and type come from the engine's generated scales; and the only responsive vocabulary is
// the engine's own breakpoints - `sm` and `md` are the two this component needs.

import Link from 'next/link';
import type { JSX } from 'react';

import { ChevronDown, LayoutDashboard, LogOut, Shield, SquarePen, User } from 'lucide-react';
import { toast } from 'sonner';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/use-auth';
import { DASHBOARD_ROUTE, NEW_POST_ROUTE } from '@/lib/routes';
import type { UserMe, UserRole } from '@/lib/types';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------------------------------
 * Addresses
 *
 * Two of the four come from `@/lib/routes`, and that is not a stylistic preference. A Next.js route
 * GROUP - a parenthesised directory - is erased from the URL, so `app/(dashboard)/posts/new/page.tsx`
 * serves `/posts/new` and NOT `/dashboard/posts/new`. A link built from the group name compiles,
 * type-checks, lints and renders; it fails only at run time, as a 404. `@/lib/routes` exists to hold
 * those two addresses once, `src/middleware.ts` gates `/posts/:path*` for the same reason, and
 * `@/lib/seo` keeps `/posts` out of the crawl policy - three files that have to agree, and do.
 *
 * The two declared here are the two that module does not carry. Both are single fixed segments whose
 * directory name and URL segment coincide, which is the only case a literal cannot get wrong, and
 * both follow the pattern src/components/layout/site-footer.tsx and src/app/not-found.tsx already
 * set for the auth addresses.
 * ---------------------------------------------------------------------------------------------- */

/** Sign-in page: `app/(auth)/login/page.tsx`, with `(auth)` erased. */
const LOGIN_PATH = '/login';

/** Registration page: `app/(auth)/signup/page.tsx`, with `(auth)` erased. */
const SIGNUP_PATH = '/signup';

/**
 * Administrative overview: `app/(admin)/admin/page.tsx`.
 *
 * `(admin)` is erased and the segment beneath it is also `admin`, so the URL is `/admin` - the one
 * address in that group where the group name and the segment coincide. It matches `src/middleware.ts`'s
 * `/admin/:path*` matcher and `@/lib/seo`'s `CRAWL_DISALLOWED_PATHS` entry character for character.
 */
const ADMIN_ROUTE = '/admin';

/** First segment of a public profile URL: `app/u/[username]/page.tsx` serves `/u/{username}`. */
const PROFILE_PATH_PREFIX = '/u';

/**
 * The role that reveals the administrative entry.
 *
 * ANNOTATED rather than inferred, and that is the whole point of the line. `UserRole` is a union of
 * string literals rather than a TypeScript `enum`, so there is no enum object to reference and the
 * comparison must be against a string - but an unannotated string is not checked against the union.
 * With the annotation, renaming or removing a role in `@/lib/types` breaks the BUILD here instead of
 * silently turning the administrative entry off for everybody, which is the failure mode a bare
 * `user.role === 'ADMIN'` has and which no test would notice.
 */
const ADMIN_ROLE: UserRole = 'ADMIN';

/* -------------------------------------------------------------------------------------------------
 * Text
 *
 * Every string a reader or a screen reader can encounter, named once. Menu labels are full phrases
 * because a `role="menuitem"` takes its accessible name from its own content, and an icon beside it
 * is `aria-hidden` and contributes nothing - so the text is the entire name.
 * ---------------------------------------------------------------------------------------------- */

/** Menu entry labels, in the order they are rendered. */
const PROFILE_LABEL = 'Your profile';
const DASHBOARD_LABEL = 'Dashboard';
const NEW_POST_LABEL = 'New post';
const ADMIN_LABEL = 'Admin';
const LOGOUT_LABEL = 'Log out';

/** Anonymous-state labels. */
const LOGIN_LABEL = 'Log in';
const SIGNUP_LABEL = 'Sign up';

/**
 * Accessible name of the trigger, completed with the account's display name.
 *
 * A control whose only visible content at the narrow viewport is an avatar and a chevron has no
 * name at all from content, and an avatar image is not a name: `AvatarImage` is given `alt=""`
 * because the account is already identified here, so duplicating it would announce the same person
 * twice. Naming the account as well as the control is what tells a screen-reader user WHOSE menu
 * this is, which matters on a shared machine.
 */
function triggerLabel(displayName: string): string {
  return `Account menu for ${displayName}`;
}

/**
 * What a failed sign-out says, and why it is worded as an outcome rather than an error.
 *
 * The provider's `logout()` always completes the LOCAL half - the credential is forgotten and the
 * presence marker cleared - even when revoking the session at the service fails. So the reader IS
 * signed out here; what could not be done is telling the service, which means a session elsewhere
 * may outlive this one. "Sign-out failed" would be false, and would invite a retry that has nothing
 * left to revoke.
 */
const LOGOUT_FAILURE_MESSAGE = 'Signed out on this device.';
const LOGOUT_FAILURE_DESCRIPTION =
  'The session could not be revoked on the server, so it may still be active elsewhere. Sign in ' +
  'again and sign out to end it.';

/* -------------------------------------------------------------------------------------------------
 * Initials
 * ---------------------------------------------------------------------------------------------- */

/** What the fallback shows when neither name yields a single usable character. */
const INITIALS_PLACEHOLDER = '?';

/** Splits on any run of whitespace, so tabs and double spaces behave like one separator. */
const WHITESPACE_RUN = /\s+/;

/**
 * The first CODE POINT of a word, or an empty string for an empty word.
 *
 * `Array.from` iterates code points, so an astral character - an emoji, or a character outside the
 * Basic Multilingual Plane - survives whole. `word[0]` would return one half of a surrogate pair
 * and render as a replacement glyph inside the avatar circle. `noUncheckedIndexedAccess` is on, so
 * the `?? ''` is required as well as correct.
 */
function firstCodePoint(word: string): string {
  return Array.from(word)[0] ?? '';
}

/**
 * One or two initials for the avatar fallback: `"Ada Lovelace"` -> `"AL"`, `"ada"` -> `"A"`.
 *
 * TOTAL over its input, which is the property that matters - this runs on every authenticated
 * render of the header, and there is no branch that can produce an empty circle:
 *
 *   * `display_name` is preferred and `username` is the fallback. The service derives the display
 *     name from the username at registration and the column is `TEXT NOT NULL`, so an absent name
 *     is not a state the API can report - but a name of spaces alone is, and `.trim()` treats it as
 *     absent rather than yielding an initial made of whitespace.
 *   * A single-word name yields ONE initial, not a duplicated pair.
 *   * First and last word, never the middle ones, so "Ada King Lovelace" reads "AL" rather than
 *     overflowing the circle. The root clips, so a third character would be silently cut.
 *   * Everything empty yields {@link INITIALS_PLACEHOLDER}, so the circle still reads as an avatar.
 *
 * `toLocaleUpperCase` rather than `toUpperCase`: it is the correct casing operation for a human
 * name, and it leaves a script without case (CJK, Arabic, Hebrew) untouched.
 *
 * @param user - Just the two name fields, so the helper states exactly what it reads.
 * @returns One or two upper-case characters, or `'?'`. Never empty, never throws.
 */
function accountInitials(user: Pick<UserMe, 'display_name' | 'username'>): string {
  const preferred = user.display_name.trim();
  const source = preferred.length > 0 ? preferred : user.username.trim();
  const words = source.split(WHITESPACE_RUN).filter((word) => word.length > 0);

  if (words.length === 0) {
    return INITIALS_PLACEHOLDER;
  }

  const first = firstCodePoint(words[0] ?? '');
  const last = words.length > 1 ? firstCodePoint(words[words.length - 1] ?? '') : '';
  const initials = `${first}${last}`;

  return initials.length > 0 ? initials.toLocaleUpperCase() : INITIALS_PLACEHOLDER;
}

/* -------------------------------------------------------------------------------------------------
 * Shared presentation
 *
 * Three classes referenced from more than one branch, named so the three states cannot drift apart.
 * The footprint agreement between them is the reason the header does not move when the session
 * resolves, and it is not something a reader would infer from three separate class strings.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The row every state renders into: a flex line, centred, with one gap step between children.
 *
 * `h-11` is the fixed part. It is the height of a `default`-size {@link Button} (2.75rem, the 44px
 * target-size floor), so the placeholder, the pair of anonymous buttons and the resolved trigger all
 * occupy a line of exactly the same height. Without it the placeholder would be as tall as its
 * tallest child and the header would visibly settle on first paint, on every route.
 */
const ROW_CLASSES = 'flex h-11 items-center gap-2';

/**
 * Avatar diameter, used by the trigger and mirrored by the placeholder.
 *
 * `size-8` (2rem) rather than the primitive's default `size-10`: a 2.5rem circle inside a 2.75rem
 * control leaves no perceptible padding and reads as a circle in a box rather than as a control.
 */
const AVATAR_CLASSES = 'size-8';

/**
 * Where the display name appears - and where it does not.
 *
 * Hidden below `md` (48rem), which is the breakpoint at which the header stops collapsing its
 * navigation into a drawer and has room for text; the avatar and chevron carry the control on their
 * own below it. `md` is the engine's own breakpoint, not an invented one.
 *
 * `min-w-0 truncate` is what keeps a long name from widening the header. A flex item's automatic
 * minimum size is its content, so without `min-w-0` the name cannot shrink and pushes the row past
 * the viewport - horizontal overflow, which the responsive criteria forbid at every width. With it,
 * the name is clipped with an ellipsis inside the trigger's bounded width instead.
 */
const NAME_CLASSES = 'hidden min-w-0 truncate md:block';

/* -------------------------------------------------------------------------------------------------
 * Component
 * ---------------------------------------------------------------------------------------------- */

/**
 * Props for {@link UserMenu}.
 *
 * Kept local and unexported, matching the rest of this tier: consumers render `<UserMenu />` or
 * `<UserMenu className="..." />` and need no reference to the type.
 */
interface UserMenuProps {
  /**
   * Utility classes for the outermost element of whichever state is rendered, merged last by `cn`
   * so they win their own property group.
   *
   * This exists so that src/components/layout/site-header.tsx and
   * src/components/layout/mobile-nav.tsx can POSITION the control - order it in a flex row, push it
   * to the trailing edge, hide it at a breakpoint - without either file writing a literal value. It
   * is not an appearance hook: how the trigger, the buttons and the panel LOOK is decided by the
   * primitives' own variants and by the token layer, and re-deciding it here would put a second
   * source of truth beside the design system.
   */
  className?: string | undefined;
}

/**
 * The header's account control: a placeholder, a sign-in pair, or the session menu.
 *
 * ```tsx
 * // src/components/layout/site-header.tsx
 * <UserMenu className="ms-auto" />
 * ```
 *
 * Renders one of three states, chosen in this order - see note 1 in the file header for why the
 * order is load-bearing:
 *
 * 1. **Restoring** (`isLoading`) - a placeholder the exact height of the resolved trigger, hidden
 *    from assistive technology so a one-pass wait is not announced on every page load.
 * 2. **Anonymous** (`user === null`) - "Log in" at every width, plus "Sign up" from `sm` up. This is
 *    an ordinary state, never an error: the login and signup pages themselves render this component.
 * 3. **Signed in** - the Radix dropdown, with the administrative entry added for an `ADMIN`
 *    principal. That entry is presentation only; authority is enforced server-side. See note 3.
 *
 * Must be rendered inside `AuthProvider`, which src/app/layout.tsx mounts around the whole tree.
 * Outside it `useAuth()` throws, deliberately and unguarded - that is a missing provider, a
 * developer error with a located fix, and never an anonymous visitor.
 *
 * @param className - Positioning classes for the rendered state's outermost element. Optional.
 * @returns The account control for the current session state.
 * @throws {Error} When rendered outside `AuthProvider`. Not caught here by design.
 */
export function UserMenu({ className }: UserMenuProps): JSX.Element {
  const { user, isLoading, logout } = useAuth();

  /**
   * Ends the session, and reports the one failure the reader needs to know about.
   *
   * `logout()` completes the local half of the sign-out whether or not the service could be told, so
   * a rejection here does NOT mean the reader is still signed in - see
   * {@link LOGOUT_FAILURE_MESSAGE}. The rejection is caught rather than propagated because an
   * unhandled one in a menu handler would reach src/app/error.tsx and replace the whole page over a
   * revocation that has no bearing on this document's state.
   *
   * Declared unconditionally, above the branches, so it is not re-created inside a conditional and
   * so the anonymous and restoring branches read as pure renders.
   */
  async function signOut(): Promise<void> {
    try {
      await logout();
    } catch {
      toast.error(LOGOUT_FAILURE_MESSAGE, { description: LOGOUT_FAILURE_DESCRIPTION });
    }
  }

  // 1. RESTORING. `aria-hidden` rather than a live region: `isLoading` is true for one pass on
  //    mount, and announcing "loading account" from the header of every page would be noise for the
  //    reader who least needs it. `Skeleton` is already `aria-hidden`, so this only makes the row
  //    itself consistent with its children. Nothing here is focusable, so there is no
  //    interactive-looking element left unnamed.
  if (isLoading) {
    return (
      <div aria-hidden="true" className={cn(ROW_CLASSES, className)}>
        <Skeleton className={cn(AVATAR_CLASSES, 'rounded-full')} />
        {/* Mirrors NAME_CLASSES' breakpoint so the placeholder is as wide as the resolved trigger
            at the widths where the trigger shows a name, and as narrow as it at the widths where it
            does not. `h-4 w-24` are scale steps standing in for a line of text. */}
        <Skeleton className="hidden h-4 w-24 md:block" />
      </div>
    );
  }

  // 2. ANONYMOUS. Two real anchors, styled as buttons through `asChild` - never a `<button>` with an
  //    onClick router push, which would break middle-click, "open in new tab" and crawling.
  //
  //    "Sign up" is revealed from `sm` up rather than always rendered, because two 44px-tall buttons
  //    plus the theme control and the navigation trigger do not fit beside the site title at 375px,
  //    and horizontal overflow is forbidden at every width. Nothing becomes unreachable: "Log in" is
  //    always here, it is the address src/middleware.ts redirects to, and
  //    src/components/layout/site-footer.tsx renders both links on every page at every width.
  if (user === null) {
    return (
      <div className={cn(ROW_CLASSES, className)}>
        <Button asChild variant="ghost">
          <Link href={LOGIN_PATH}>{LOGIN_LABEL}</Link>
        </Button>
        <Button asChild variant="primary" className="hidden sm:inline-flex">
          <Link href={SIGNUP_PATH}>{SIGNUP_LABEL}</Link>
        </Button>
      </div>
    );
  }

  // 3. SIGNED IN. `user` is narrowed to `UserMe` by the check above, so nothing below asserts.
  //
  // The username needs no percent-encoding: the service constrains it to
  // /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/ (mirrored in src/lib/validation/auth.ts), every
  // character of which is safe in a path segment, and it is the value the profile page's own
  // canonical URL is built from.
  const profileHref = `${PROFILE_PATH_PREFIX}/${user.username}`;

  // Presentation only. The service decides authority: `require_admin` on the /admin router include,
  // plus per-resource ownership checks in the post and comment services. See note 3 in the header.
  const isAdmin = user.role === ADMIN_ROLE;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* `asChild` so the one Button implementation is reused and Radix merges its own
            `aria-haspopup`, `aria-expanded`, `data-state` and keyboard handlers onto it. No `id` is
            set here: Radix derives the trigger and panel ids from one `useId()` and names the panel
            with `aria-labelledby={triggerId}`, so an `id` of ours would leave the panel unnamed.

            `aria-label` rather than an `sr-only` span, and it is the deliberate choice. The visible
            content varies by breakpoint - avatar and chevron below `md`, plus the name above it - so
            a name built from content would be empty at the narrow viewport and "Ada Lovelace
            Account menu" at the wide one. The label is the same sentence at every width, and because
            it CONTAINS the visible name, a voice-control user can still say what they see (WCAG
            2.5.3, Label in Name).

            `max-w-48` bounds the control so NAME_CLASSES' `truncate` has something to truncate
            against; `px-2` narrows the `default` size's roomy inline padding for a control whose
            content is a circle and a glyph, and `md:px-3` restores a little of it once the name is
            visible. All three are scale steps, and `cn` resolves them against the variant's own
            `px-5` in this call site's favour. `className` comes last so a consumer can still
            position or override. */}
        <Button
          variant="ghost"
          aria-label={triggerLabel(user.display_name)}
          className={cn('max-w-48 gap-2 px-2 md:px-3', className)}
        >
          <Avatar className={AVATAR_CLASSES}>
            {/* `?? undefined`, not the raw `null`: the field is legitimately null for an account
                with no avatar, and Radix keeps the fallback mounted only when `src` is absent.
                `alt=""` because the trigger's own name already identifies the account - a
                descriptive alt here would announce the same person twice. */}
            <AvatarImage src={user.avatar_url ?? undefined} alt="" />
            {/* `text-xs` pairs with the smaller circle: the fallback's own type size does not scale
                with the root, so shrinking one without the other leaves 14px initials in a 32px
                disc. */}
            <AvatarFallback className="text-xs">{accountInitials(user)}</AvatarFallback>
          </Avatar>
          <span className={NAME_CLASSES}>{user.display_name}</span>
          {/* Decorative: it signals that the control opens a menu, which `aria-expanded` already
              tells assistive technology. Sized by the Button's own `[&_svg]:size-4`. */}
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>

      {/* `align="end"` because this control sits at the trailing edge of the header: an end-aligned
          panel opens inward, so it cannot push the document's scroll width at 375px. Nothing else is
          positioned here - the panel sits flush against its trigger, which is the primitive's
          documented default and the same distance `@/components/ui/select` keeps. A `sideOffset`
          would have to be a raw NUMBER, which is a dimension literal no token lookup can launder. */}
      <DropdownMenuContent align="end">
        {/* Navigation. Every entry is a real anchor through `asChild`, so it is crawlable,
            middle-clickable and prefetched, while Radix still applies `role="menuitem"`, roving
            focus and typeahead to it. Each icon is `aria-hidden` because the label beside it already
            carries the meaning - which is also what makes the label the item's whole accessible
            name. */}
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link href={profileHref}>
              <User aria-hidden="true" />
              {PROFILE_LABEL}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={DASHBOARD_ROUTE}>
              <LayoutDashboard aria-hidden="true" />
              {DASHBOARD_LABEL}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={NEW_POST_ROUTE}>
              <SquarePen aria-hidden="true" />
              {NEW_POST_LABEL}
            </Link>
          </DropdownMenuItem>
          {isAdmin ? (
            <DropdownMenuItem asChild>
              <Link href={ADMIN_ROUTE}>
                <Shield aria-hidden="true" />
                {ADMIN_LABEL}
              </Link>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>

        {/* The session action, in a group of its own so assistive technology announces it as
            separate from the navigation and so the hairline below reads as a boundary rather than as
            decoration. `border-border` and the two spacing steps are the group's only styling; the
            row's own appearance belongs to the primitive. */}
        <DropdownMenuGroup className="border-border mt-1 border-t pt-1">
          {/* `onSelect`, not `onClick`: Radix fires it for pointer activation and for Enter and
              Space alike, and it is the hook that closes the menu. The promise is deliberately
              floated - `signOut` handles its own rejection, and awaiting here would keep the menu
              open until the network answered. */}
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => {
              void signOut();
            }}
          >
            <LogOut aria-hidden="true" />
            {LOGOUT_LABEL}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
