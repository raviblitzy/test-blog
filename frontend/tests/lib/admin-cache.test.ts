/**
 * The administrative mutation-to-query dependency graph.
 *
 * This is the one part of the administrative cache behaviour that a component test cannot pin down,
 * and it is the part that was wrong: what a given accepted mutation staled. The defect was never
 * visible from inside the component that caused it - deleting a user left the POSTS table and the
 * MODERATION QUEUE serving rows PostgreSQL had already cascaded away, and publishing a filed draft
 * left the CATEGORY table's `post_count` one short - because each component reasoned only about the
 * entity it was named after.
 *
 * So the graph is asserted directly, key set by key set, against the server behaviour that justifies
 * each edge. Every expectation below is a statement about the API, and the comment on it says which:
 * a cascading foreign key, an aggregate that is a `COUNT` rather than a column, or a projection that
 * demonstrably does not carry the field in question.
 *
 * Two properties are checked as well as the sets themselves, because both were part of the defect:
 *
 *   1. **Prefix keys.** Each screen registers `['admin', <entity>, params]`, so an invalidation must
 *      name the two-segment prefix in order to reach every cached window and filter combination. An
 *      exact key would refresh only the page the operator happens to be looking at.
 *   2. **The promise is awaited.** `invalidateForAdminMutation` resolves only once every affected key
 *      has settled, which is what holds a mutation `isPending` and therefore holds the row's controls
 *      disabled until the table has caught up. A version that fired and forgot would resolve before
 *      the refetches and re-arm the controls over stale rows.
 *
 * No DOM, no MSW and no network: the subject is a pure decision, and `QueryClient` is driven directly
 * with a spy on `invalidateQueries` so the assertions are about the keys rather than about a rendered
 * table.
 */

import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import {
  ADMIN_CATEGORIES_QUERY_KEY,
  ADMIN_COMMENTS_QUERY_KEY,
  ADMIN_POSTS_QUERY_KEY,
  ADMIN_STATS_QUERY_KEY,
  ADMIN_USERS_QUERY_KEY,
  invalidateForAdminMutation,
} from '@/lib/admin-cache';
import type { AdminMutation } from '@/lib/admin-cache';

/**
 * Run one mutation's invalidation against a fresh client and report the keys it asked for.
 *
 * A real `QueryClient` with `invalidateQueries` spied rather than a hand-built double, so the call
 * signature is checked against the library's own type and a serialised key comes back in the shape the
 * cache actually matches on.
 *
 * @param mutation - Which mutation to resolve the edges of.
 * @returns The invalidated keys, each as a JSON string so set comparison is order-independent.
 */
async function invalidatedKeysFor(mutation: AdminMutation): Promise<string[]> {
  const queryClient = new QueryClient({
    // Retries would make a failed refetch hold this promise open; nothing here is fetching anyway.
    defaultOptions: { queries: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

  await invalidateForAdminMutation(queryClient, mutation);

  return invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
}

/** The five prefixes, as the comparable strings `invalidatedKeysFor` returns. */
const KEY = {
  users: JSON.stringify(ADMIN_USERS_QUERY_KEY),
  posts: JSON.stringify(ADMIN_POSTS_QUERY_KEY),
  comments: JSON.stringify(ADMIN_COMMENTS_QUERY_KEY),
  categories: JSON.stringify(ADMIN_CATEGORIES_QUERY_KEY),
  stats: JSON.stringify(ADMIN_STATS_QUERY_KEY),
} as const;

describe('admin cache dependency graph', () => {
  it('names two-segment prefixes, so every cached window and filter is reached', () => {
    // A listing is registered as `['admin', <entity>, params]`. Invalidating `['admin','users']`
    // matches all of them; invalidating a key that carried params would match one.
    expect(ADMIN_USERS_QUERY_KEY).toEqual(['admin', 'users']);
    expect(ADMIN_POSTS_QUERY_KEY).toEqual(['admin', 'posts']);
    expect(ADMIN_COMMENTS_QUERY_KEY).toEqual(['admin', 'comments']);
    expect(ADMIN_CATEGORIES_QUERY_KEY).toEqual(['admin', 'categories']);
    expect(ADMIN_STATS_QUERY_KEY).toEqual(['admin', 'stats']);
  });

  describe('users', () => {
    it('refreshes the users listing alone for a role or active-state change', async () => {
      // `AdminUser` is the only projection carrying a role or an active flag - `AdminPost.author` is a
      // `UserPublic`, which carries neither - so no other table can be showing either value, and the
      // account still exists so no count moves.
      expect(await invalidatedKeysFor('user.update')).toEqual([KEY.users]);
    });

    it('refreshes four tables and the counts for a deletion, because the cascade reaches them', async () => {
      // The widest cascade in the API. Every foreign key referencing `users.id` carries
      // `ON DELETE CASCADE`, so one statement removes the account's posts, comments, likes and refresh
      // tokens, then cascades again from each removed post to that post's own comments and likes - and
      // the vanished `post_categories` filings move `post_count` on the category table.
      //
      // Refreshing users and the counts alone was the defect: the posts table and the moderation queue
      // went on offering actions on rows that no longer existed, each answered 404.
      expect(new Set(await invalidatedKeysFor('user.delete'))).toEqual(
        new Set([KEY.users, KEY.posts, KEY.comments, KEY.categories, KEY.stats]),
      );
    });
  });

  describe('posts', () => {
    it('refreshes categories as well as posts for a status change, because post_count is a COUNT', async () => {
      // `CategoryService.list_with_post_counts(status=PUBLISHED)` computes `post_count` over published
      // posts, so publishing or withdrawing a filed post changes a tally the category table renders.
      expect(new Set(await invalidatedKeysFor('post.status'))).toEqual(
        new Set([KEY.posts, KEY.categories]),
      );
    });

    it('leaves the overview counts alone for a status change', async () => {
      // `AdminStats.post_count` spans DRAFT, PUBLISHED and ARCHIVED alike, so a transition cannot move
      // it and refetching it could not produce a different digit.
      expect(await invalidatedKeysFor('post.status')).not.toContain(KEY.stats);
    });

    it('refreshes the queue and the counts for a deletion, because comments cascade with the post', async () => {
      expect(new Set(await invalidatedKeysFor('post.delete'))).toEqual(
        new Set([KEY.posts, KEY.comments, KEY.categories, KEY.stats]),
      );
    });
  });

  describe('comments', () => {
    it('refreshes the queue alone for a moderation transition', async () => {
      // `AdminStats.comment_count` spans pending, approved and rejected, so moderating one moves no
      // count.
      expect(await invalidatedKeysFor('comment.status')).toEqual([KEY.comments]);
    });

    it('refreshes the queue and the counts for a deletion, because replies cascade', async () => {
      expect(new Set(await invalidatedKeysFor('comment.delete'))).toEqual(
        new Set([KEY.comments, KEY.stats]),
      );
    });
  });

  describe('categories', () => {
    it('refreshes the table and the counts for a create', async () => {
      expect(new Set(await invalidatedKeysFor('category.create'))).toEqual(
        new Set([KEY.categories, KEY.stats]),
      );
    });

    it('refreshes the table alone for a rename', async () => {
      // The slug is retained, no filing changes, and `AdminPost` carries no category names.
      expect(await invalidatedKeysFor('category.update')).toEqual([KEY.categories]);
    });

    it('does not refresh posts for a delete, because an in-use category cannot be deleted', async () => {
      // The service's in-use guard refuses a category any post is still filed under, so a delete that
      // SUCCEEDED unfiled nothing and no post row changed.
      const keys = await invalidatedKeysFor('category.delete');
      expect(new Set(keys)).toEqual(new Set([KEY.categories, KEY.stats]));
      expect(keys).not.toContain(KEY.posts);
    });
  });

  it('resolves only after every affected invalidation has settled', async () => {
    // The awaited-ness contract, asserted rather than assumed: a mutation's `onSuccess` returns this
    // promise, and React Query keeps the mutation pending - and therefore the row's controls disabled -
    // until it resolves. A fire-and-forget implementation would resolve before its invalidations,
    // re-arming the controls over a table that had not refetched.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let settled = 0;
    vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(async (): Promise<void> => {
      await Promise.resolve();
      settled += 1;
    });

    const pending = invalidateForAdminMutation(queryClient, 'user.delete');
    expect(settled).toBe(0);

    await pending;
    expect(settled).toBe(5);
  });
});
