/**
 * The administrative screens' query keys, and the one map from a mutation to everything it staled.
 *
 * ## WHY THIS MODULE EXISTS
 *
 * The administrative surface is five cached reads - four management tables and the overview's
 * aggregate counts - and nine mutations spread across four row-action components and one form. Every
 * one of those mutations invalidates a SUBSET of the five, and the subset is not the entity the
 * component is named after. That is the whole difficulty: the API's foreign keys carry
 * `ON DELETE CASCADE`, and `post_count` is a `COUNT` rather than a column, so a single accepted
 * request routinely changes rows the calling component never mentions.
 *
 * Before this module each component declared its own key literals and reasoned about its own
 * invalidations locally, and the reasoning was wrong in exactly the way local reasoning is wrong:
 *
 *   * Deleting a user refreshed the users table and the counts. It did not refresh posts or
 *     comments, both of which the service had just cascaded away - so the posts table went on
 *     offering a status change and a delete on rows that no longer existed, for the whole 60-second
 *     stale window, and each of those actions came back `404` with nothing on screen to explain it.
 *   * Changing a post's status refreshed the posts table. It did not refresh categories, whose
 *     `post_count` counts PUBLISHED posts only - so publishing a draft filed under Engineering left
 *     the category table reporting a tally that was demonstrably one short.
 *   * Deleting a post refreshed posts and the counts, and not comments - which had just gone with it.
 *
 * None of those is visible from inside the component that caused it. So the dependency graph is
 * declared once, here, next to the server behaviour that justifies each edge, and every component
 * calls the same function. Adding a table, or a cascade, is then one edit in one place instead of a
 * search through five files for the ones that should have known.
 *
 * ## THE KEYS ARE PREFIXES, AND THAT IS DELIBERATE
 *
 * Each screen registers its list as `['admin', <entity>, params]`, where `params` carries its page,
 * its filters and its search term. React Query matches an invalidation by prefix, so invalidating the
 * two-segment key reaches every windowed and filtered variant that is currently cached. That is
 * required rather than convenient: an operator who changes a role on page three of a role-filtered
 * listing has just changed whether that row belongs in the result set at all, and refreshing only the
 * exact key they are looking at would leave every other cached window wrong.
 *
 * ## INVALIDATION IS AWAITED, ALWAYS
 *
 * {@link invalidateForAdminMutation} returns a promise, and every caller returns it from its
 * `onSuccess` handler. React Query keeps a mutation `isPending` until that handler's promise settles,
 * which is what holds the row's controls disabled until the table in front of the operator actually
 * reflects the change. Firing an invalidation and dropping the promise ends the pending state at the
 * moment the WRITE returned, which is one refetch too early: the row repaints its old status, stays
 * actionable, and a second press sends a second `PATCH` - or a `DELETE` for a row the server has
 * already removed, answered `404` for a reason the operator cannot see.
 *
 * This is the opposite of an optimistic update and deliberately so. Nothing here writes to the cache
 * by hand and nothing paints a state the service has not confirmed; the controls simply stay closed
 * for the extra moment it takes to be sure.
 *
 * ## WHAT IS NOT HERE
 *
 * * **The public category list.** The home feed's filter is drawn from a Server Component's own
 *   `listCategories()` call, not from this cache, so there is no client key to invalidate. It
 *   re-reads on the next server render.
 * * **Any mutation function.** This module performs no HTTP and imports no wrapper; it decides only
 *   what has gone stale. The requests live in `@/lib/api/admin`.
 * * **Optimistic writes.** No `setQueryData`, no `cancelQueries`, no rollback.
 */

import type { QueryClient } from '@tanstack/react-query';

/* -------------------------------------------------------------------------------------------------
 * The five keys
 * ---------------------------------------------------------------------------------------------- */

/** First segment of every administrative key, so the whole namespace can be named in one place. */
const ADMIN_SCOPE = 'admin';

/** Prefix of every `GET /admin/users` listing key. */
export const ADMIN_USERS_QUERY_KEY = [ADMIN_SCOPE, 'users'] as const;

/** Prefix of every `GET /admin/posts` listing key, across all three lifecycle states. */
export const ADMIN_POSTS_QUERY_KEY = [ADMIN_SCOPE, 'posts'] as const;

/** Prefix of every `GET /admin/comments` listing key - the moderation queue, all three states. */
export const ADMIN_COMMENTS_QUERY_KEY = [ADMIN_SCOPE, 'comments'] as const;

/** Prefix of every `GET /admin/categories` listing key. Items carry `post_count`. */
export const ADMIN_CATEGORIES_QUERY_KEY = [ADMIN_SCOPE, 'categories'] as const;

/** Key of `GET /admin/stats` - the overview's four aggregate counts. */
export const ADMIN_STATS_QUERY_KEY = [ADMIN_SCOPE, 'stats'] as const;

/**
 * Any of the five prefixes above.
 *
 * `readonly string[]` rather than the union of the five tuple types: the graph below stores them
 * together, and a union of tuples would make each entry's element type depend on which key it held.
 */
type AdminQueryKey = readonly string[];

/* -------------------------------------------------------------------------------------------------
 * The graph
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every administrative mutation, named by the entity it addresses and the thing it does.
 *
 * A closed union rather than a string, so `AFFECTED_QUERY_KEYS` below is exhaustive by construction:
 * a tenth mutation added to this union does not compile until its edges are declared.
 *
 * The two `*.status` members are separate from the resource-level updates because their routes are -
 * `PATCH /admin/posts/{id}/status` and `PATCH /admin/comments/{id}/status` address a sub-path, while
 * `PATCH /admin/users/{id}` and `PATCH /admin/categories/{id}` address the resource itself.
 */
export type AdminMutation =
  | 'user.update'
  | 'user.delete'
  | 'post.status'
  | 'post.delete'
  | 'comment.status'
  | 'comment.delete'
  | 'category.create'
  | 'category.update'
  | 'category.delete';

/**
 * What each mutation staled, and why.
 *
 * Every edge below is a statement about the SERVICE, and the justification is recorded next to it
 * because that is the part a call site cannot see. The absences are as deliberate as the entries: a
 * key that cannot have changed is not invalidated, because an unnecessary refetch of a filtered table
 * costs the operator a repaint and buys nothing.
 *
 * Two projection facts bound the whole graph, and both were read off the contract rather than
 * assumed. `AdminPost` embeds its author as `UserPublic` - which carries no role and no active flag -
 * and embeds no categories at all. `AdminComment` embeds `post_id` and its author, and neither the
 * post's title nor its status. So a role change cannot stale the posts table, a category rename
 * cannot stale it either, and a post's status change cannot stale the moderation queue.
 */
const AFFECTED_QUERY_KEYS: Readonly<Record<AdminMutation, readonly AdminQueryKey[]>> = {
  /*
   * Role or active state. `AdminUser` is the only projection carrying either, so the users table is
   * the only reader. No count moves: the account still exists.
   */
  'user.update': [ADMIN_USERS_QUERY_KEY],

  /*
   * THE WIDEST CASCADE IN THE API, and the one that was most wrong when each component reasoned
   * locally. `admin_service.delete_user` issues one statement; every foreign key referencing
   * `users.id` carries `ON DELETE CASCADE`, so PostgreSQL removes the account's posts, comments,
   * likes and refresh tokens - and then cascades again from each removed post to that post's own
   * comments and likes. The vanished `post_categories` rows move `post_count` too.
   *
   * So four tables and the counts, and only `refresh_tokens` has no reader on any screen.
   */
  'user.delete': [
    ADMIN_USERS_QUERY_KEY,
    ADMIN_POSTS_QUERY_KEY,
    ADMIN_COMMENTS_QUERY_KEY,
    ADMIN_CATEGORIES_QUERY_KEY,
    ADMIN_STATS_QUERY_KEY,
  ],

  /*
   * A forced lifecycle transition. The posts table obviously, and CATEGORIES because `post_count` is
   * a `COUNT` over PUBLISHED posts - `CategoryService.list_with_post_counts(status=PUBLISHED)` - so
   * publishing or withdrawing a filed post changes a tally the category table renders.
   *
   * Not the counts: `AdminStats.post_count` spans every lifecycle state, so a transition cannot move
   * it. Not the moderation queue: `AdminComment` does not carry its post's status.
   */
  'post.status': [ADMIN_POSTS_QUERY_KEY, ADMIN_CATEGORIES_QUERY_KEY],

  /*
   * Removal, with the cascade the confirmation copy promises: the post's comments and likes go with
   * it, so the moderation queue and `comment_count` both move, `post_count` drops, and the filings
   * that fed `post_count` on the category table are gone.
   */
  'post.delete': [
    ADMIN_POSTS_QUERY_KEY,
    ADMIN_COMMENTS_QUERY_KEY,
    ADMIN_CATEGORIES_QUERY_KEY,
    ADMIN_STATS_QUERY_KEY,
  ],

  /*
   * Approve or reject. The queue only: `AdminStats.comment_count` spans pending, approved and
   * rejected alike, so moderating one moves no count. The post's own row carries no comment tally.
   */
  'comment.status': [ADMIN_COMMENTS_QUERY_KEY],

  /*
   * Removal, and every reply beneath it by cascade - which is why the count moves by more than one
   * and why the queue must be refetched rather than have one row spliced out.
   */
  'comment.delete': [ADMIN_COMMENTS_QUERY_KEY, ADMIN_STATS_QUERY_KEY],

  /*
   * A new term, with `post_count: 0`. The taxonomy grew, so `category_count` moved.
   */
  'category.create': [ADMIN_CATEGORIES_QUERY_KEY, ADMIN_STATS_QUERY_KEY],

  /*
   * A rename or a new description. The slug is retained deliberately, no post's filing changes, and
   * `AdminPost` carries no category names - so the category table is the only reader, and no count
   * moves.
   */
  'category.update': [ADMIN_CATEGORIES_QUERY_KEY],

  /*
   * Removal. `category_count` moves, and the posts table does NOT need refreshing: the service
   * refuses to delete a category any post is still filed under - the in-use guard, which exists
   * because `post_categories.category_id` cascades and an unguarded delete would silently unfile
   * every post that used it - so a delete that SUCCEEDED had no filings to remove.
   */
  'category.delete': [ADMIN_CATEGORIES_QUERY_KEY, ADMIN_STATS_QUERY_KEY],
};

/* -------------------------------------------------------------------------------------------------
 * The one entry point
 * ---------------------------------------------------------------------------------------------- */

/**
 * Refresh every administrative view the given mutation has just made stale, and resolve once they
 * have all settled.
 *
 * Call it from a mutation's `onSuccess` and RETURN the promise, so React Query holds the mutation
 * pending until the affected tables have caught up:
 *
 * ```ts
 * const deletion = useMutation({
 *   mutationFn: () => deleteAdminPost(post.id),
 *   onSuccess: async (): Promise<void> => {
 *     await invalidateForAdminMutation(queryClient, 'post.delete');
 *     toast.success('Deleted.');
 *   },
 * });
 * ```
 *
 * The refetches are issued together rather than in sequence: they are independent reads, and
 * serialising four of them would hold the operator's controls disabled for the sum of their latencies
 * instead of the longest.
 *
 * @param queryClient - The client from the provider that owns the tier's default options. Never a
 * locally constructed one, which would invalidate a cache nothing is reading.
 * @param mutation - Which mutation succeeded. See {@link AdminMutation}.
 * @returns A promise resolving when every affected key has been invalidated and its active queries
 * have refetched.
 */
export async function invalidateForAdminMutation(
  queryClient: QueryClient,
  mutation: AdminMutation,
): Promise<void> {
  await Promise.all(
    AFFECTED_QUERY_KEYS[mutation].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}
