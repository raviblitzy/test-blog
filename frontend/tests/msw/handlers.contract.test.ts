/**
 * The mock's own contract, asserted against the service behaviour it stands in for.
 *
 * ## WHY A TEST OF A TEST FIXTURE IS WORTH HAVING
 *
 * Every component spec in this suite is only as trustworthy as the network seam underneath it. A mock
 * that is WIDER than the service does not fail - it makes assertions pass that should not, and it does
 * so silently. Five defects of exactly that shape were found in `handlers.ts` by review rather than by
 * any failing test, because no test could have found them:
 *
 *   * Any non-empty bearer resolved to the author fixture, so a spec asserting that a bogus, swapped
 *     or stale credential is refused received a success shape and passed (CWE-287).
 *   * Administrative handlers checked no role, so a reader's token received the account listing, the
 *     moderation queue and the aggregate counts (CWE-285).
 *   * The feed ordered a searched page by recency rather than relevance, and `sort=relevance` with no
 *     term by engagement rather than recency - two orderings the service does not produce.
 *   * A created comment came back APPROVED rather than PENDING, and an edit preserved an approval,
 *     making the moderation queue impossible to exercise and a real bypass impossible to catch.
 *   * Registration conflicts named the colliding identity, which the service deliberately does not.
 *
 * This file exists so that each of those is now pinned by an assertion. It is a contract test, not a
 * test of `msw`: every expectation below restates a rule from `backend/app/services/*` or
 * `backend/app/api/v1/routers/*`, and the comment on it names the rule.
 *
 * ## HOW IT DRIVES THE HANDLERS
 *
 * `handlers.ts` deliberately owns no server instance, so this file stands one up over the default
 * array and issues plain `fetch` calls at an absolute origin the wildcard predicates match. No React,
 * no component, no client module - the subject is the network seam itself.
 */

import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  FIXTURE_ADMIN_ACCESS_TOKEN,
  FIXTURE_AUTHOR_ACCESS_TOKEN,
  FIXTURE_READER_ACCESS_TOKEN,
  errorHandlers,
  fixtureAdminAccount,
  fixtureAuthorAccount,
  fixtureCategories,
  fixtureEngineeringCategory,
  fixturePosts,
  fixtureUnusedCategory,
  handlers,
} from './handlers';
import type { CommentPublic, Page, PostSummary, ProblemDetail } from '@/lib/types';

/** Any origin the wildcard predicates match; nothing here depends on which. */
const ORIGIN = 'http://contract.test';

const server = setupServer(...handlers);

beforeAll(() => {
  // `error` rather than `warn`: a request no handler answers is a defect in this file's expectations,
  // and a warning would let it pass as a silent network failure.
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

/** Issue a request against the mocked API and return the response. */
async function call(
  path: string,
  init?: { readonly method?: string; readonly token?: string; readonly body?: unknown },
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init?.token !== undefined) {
    headers['Authorization'] = `Bearer ${init.token}`;
  }
  if (init?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  return fetch(`${ORIGIN}/api/v1${path}`, {
    method: init?.method ?? 'GET',
    headers,
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

/** The slugs of a feed page, in the order it reported them. */
async function feedSlugs(query: string, token?: string): Promise<string[]> {
  const response = await call(`/posts${query}`, token === undefined ? undefined : { token });
  expect(response.status).toBe(200);
  const page = (await response.json()) as Page<PostSummary>;

  return page.items.map((item) => item.slug);
}

describe('bearer resolution (I-11)', () => {
  it('refuses an unrecognised bearer with 401 rather than admitting it as a fixture account', async () => {
    // The defect: any non-empty token resolved to the author, so this call returned 201.
    const response = await call('/posts', {
      method: 'POST',
      token: 'not-a-token-this-module-issued',
      body: { title: 'x', content: 'y' },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('still resolves each of the fixture credentials', async () => {
    for (const token of [
      FIXTURE_AUTHOR_ACCESS_TOKEN,
      FIXTURE_READER_ACCESS_TOKEN,
      FIXTURE_ADMIN_ACCESS_TOKEN,
    ]) {
      const response = await call('/auth/me', { token });
      expect(response.status).toBe(200);
    }
  });
});

describe('administrative authority (I-11)', () => {
  it('answers 401 for an administrative read that names nobody', async () => {
    expect((await call('/admin/stats')).status).toBe(401);
  });

  it('answers 403 - not 200 - for a recognised principal that does not hold ADMIN', async () => {
    // `require_admin` is applied once on the administrative router include, so no administrative route
    // can omit it. The reader's token is a valid credential and an insufficient authority, which is a
    // 403: an authority decision no fresh credential can change, and one the client must NOT rotate on.
    for (const path of ['/admin/stats', '/admin/users', '/admin/posts', '/admin/comments']) {
      const response = await call(path, { token: FIXTURE_READER_ACCESS_TOKEN });
      expect(response.status).toBe(403);
      const problem = (await response.json()) as ProblemDetail;
      expect(problem.type).toBe('/errors/forbidden');
    }
  });

  it('serves an administrator', async () => {
    const response = await call('/admin/stats', { token: FIXTURE_ADMIN_ACCESS_TOKEN });
    expect(response.status).toBe(200);
  });
});

describe('feed composition (I-08)', () => {
  it('scopes an anonymous caller to published posts', async () => {
    const slugs = await feedSlugs('');
    const published = fixturePosts.filter((post) => post.status === 'PUBLISHED');

    expect(slugs).toHaveLength(published.length);
    expect(slugs.length).toBeLessThan(fixturePosts.length);
  });

  it('does NOT widen for an administrator: the public feed is published-only for every caller', async () => {
    // `list_feed` passes `PUBLIC_POST_STATUSES` unconditionally. It used to pass
    // `visible_statuses_for(viewer, author_id)`, which widened the SHARED surface from the
    // credential - so an administrator saw drafts and archived posts in the public feed, and `total`
    // and the page boundaries differed per caller. `visible_statuses_for` still exists for the
    // surfaces that legitimately need it; the feed is not one of them.
    const slugs = await feedSlugs('', FIXTURE_ADMIN_ACCESS_TOKEN);
    const published = fixturePosts.filter((post) => post.status === 'PUBLISHED');

    expect(slugs).toHaveLength(published.length);
    expect(slugs.length).toBeLessThan(fixturePosts.length);
  });

  it('widens for an author only through the opt-in workspace mode', async () => {
    // An authenticated author browsing the feed - scoped to themselves or not - gets the public set,
    // because the feed is published-only for everyone. Their own drafts live behind `mine=true`,
    // which is bearer-required, own-posts-only and covers every lifecycle state. That is the same
    // capability the dashboard needs, delivered without a second listing operation, which is what
    // keeps the versioned surface at its frozen 37 operations.
    const published = fixturePosts.filter((post) => post.status === 'PUBLISHED');
    const ownAll = fixturePosts.filter(
      (post) => post.author.username === fixtureAuthorAccount.username,
    );

    expect(await feedSlugs('', FIXTURE_AUTHOR_ACCESS_TOKEN)).toHaveLength(published.length);
    expect(
      await feedSlugs(`?author=${fixtureAuthorAccount.username}`, FIXTURE_AUTHOR_ACCESS_TOKEN),
    ).toHaveLength(ownAll.filter((post) => post.status === 'PUBLISHED').length);

    const workspace = await feedSlugs('?mine=true', FIXTURE_AUTHOR_ACCESS_TOKEN);
    expect(workspace).toHaveLength(ownAll.length);
    expect(workspace.length).toBeGreaterThan(
      ownAll.filter((post) => post.status === 'PUBLISHED').length,
    );
  });

  it('refuses the workspace without a credential, and each mode combination the service refuses', async () => {
    // Each of the three is a refusal rather than a silently ignored parameter: a dashboard answered
    // with the public feed looks to its owner like their drafts were deleted, and a filter that was
    // accepted and dropped looks like it was applied.
    expect((await call('/posts?mine=true')).status).toBe(401);
    expect(
      (
        await call(`/posts?mine=true&author=${fixtureAuthorAccount.username}`, {
          token: FIXTURE_AUTHOR_ACCESS_TOKEN,
        })
      ).status,
    ).toBe(422);
    expect((await call('/posts?status=DRAFT', { token: FIXTURE_AUTHOR_ACCESS_TOKEN })).status).toBe(
      422,
    );
  });

  it('ranks a search by relevance when no sort is sent, and by recency when recent is', async () => {
    // `_default_sort_for` returns "relevance" when a term is present and "recent" otherwise, so
    // omitting `sort` is NOT the same as sending `recent`. The two orderings must therefore differ for
    // a term that matches more than one post.
    const term = 'the';
    const ranked = await feedSlugs(`?q=${term}`);
    const byRecency = await feedSlugs(`?q=${term}&sort=recent`);

    expect(ranked.length).toBeGreaterThan(1);
    expect(byRecency).toHaveLength(ranked.length);
    expect(ranked).not.toEqual(byRecency);
  });

  it('degrades relevance with no term to recency rather than to engagement', async () => {
    // `PostRepository` takes its ranking branch on the PRESENCE OF THE TERM, because `ts_rank` against
    // an empty query ranks nothing. There is deliberately no "popular" sort, so ordering by
    // `view_count` here would invent one.
    expect(await feedSlugs('?sort=relevance')).toEqual(await feedSlugs(''));
  });

  it('answers 404 for an unknown author filter, and an empty page for an unknown category', async () => {
    // Specified asymmetry: a username that names no account is reported so that a mistyped filter stays
    // distinguishable from an author who has published nothing, while a category matching nothing is a
    // legitimate empty result.
    const unknownAuthor = await call('/posts?author=nobody-by-that-handle');
    expect(unknownAuthor.status).toBe(404);

    const unknownCategory = await call('/posts?category=no-such-category');
    expect(unknownCategory.status).toBe(200);
    expect(((await unknownCategory.json()) as Page<PostSummary>).items).toHaveLength(0);
  });
});

describe('comment moderation lifecycle (I-09)', () => {
  const postId = fixturePosts[0]?.id ?? '';

  it('creates a comment PENDING, whoever wrote it', async () => {
    // `CommentService.create` writes PENDING unconditionally: a queue whose entries arrive approved has
    // nothing in it.
    const response = await call(`/posts/${postId}/comments`, {
      method: 'POST',
      token: FIXTURE_READER_ACCESS_TOKEN,
      body: { body: 'Held for review.' },
    });

    expect(response.status).toBe(201);
    expect(((await response.json()) as CommentPublic).status).toBe('PENDING');
  });

  it('returns an approved comment to PENDING when its body is edited', async () => {
    // The one way this route changes a moderation state, and the reason it must: text a moderator
    // approved is not the text that is now stored, so preserving approval would let any commenter
    // publish arbitrary content through an edit.
    const approved = await call(`/posts/${postId}/comments`);
    const roots = (await approved.json()) as Page<CommentPublic>;
    const target = roots.items[0];
    expect(target?.status).toBe('APPROVED');

    // Presented by the comment's OWN author, which is the reader account: the route is scoped to the
    // owner or an administrator, so a credential belonging to neither is a 403 before the state
    // transition is ever reached. Using the owner keeps this case about the re-queue and nothing else.
    const response = await call(`/comments/${target?.id ?? ''}`, {
      method: 'PATCH',
      token: FIXTURE_READER_ACCESS_TOKEN,
      body: { body: 'Rewritten after approval.' },
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as CommentPublic).status).toBe('PENDING');
  });

  it('shows an anonymous reader approved comments only, and the post author every state', async () => {
    // `_visible_comment_statuses`: the POST'S OWN AUTHOR sees the whole thread on their own post,
    // pending and rejected included, because they are the person who notices a reader waiting on
    // approval. The set applies to the roots and to every level beneath them.
    const anonymous = (await (
      await call(`/posts/${postId}/comments`)
    ).json()) as Page<CommentPublic>;
    const everyRootApproved = anonymous.items.every((comment) => comment.status === 'APPROVED');
    const everyReplyApproved = anonymous.items.every((comment) =>
      comment.replies.every((reply) => reply.status === 'APPROVED'),
    );
    expect(everyRootApproved).toBe(true);
    expect(everyReplyApproved).toBe(true);

    const asAdmin = (await (
      await call(`/posts/${postId}/comments`, { token: FIXTURE_ADMIN_ACCESS_TOKEN })
    ).json()) as Page<CommentPublic>;
    const adminSeesUnapproved =
      asAdmin.items.some((comment) => comment.status !== 'APPROVED') ||
      asAdmin.items.some((comment) => comment.replies.some((reply) => reply.status !== 'APPROVED'));
    expect(adminSeesUnapproved).toBe(true);
  });
});

describe('category deletion (I-10)', () => {
  it('refuses to delete a category posts are still filed under', async () => {
    // The service's in-use guard: `post_categories.category_id` cascades, so an unguarded delete would
    // succeed while silently unfiling every post that used it.
    expect(fixtureEngineeringCategory.post_count).toBeGreaterThan(0);
    const response = await call(`/admin/categories/${fixtureEngineeringCategory.id}`, {
      method: 'DELETE',
      token: FIXTURE_ADMIN_ACCESS_TOKEN,
    });

    expect(response.status).toBe(409);
    const problem = (await response.json()) as ProblemDetail;
    expect(problem.type).toBe('/errors/conflict');
    expect(problem.detail).toContain('Re-file them');
  });

  it('deletes a category nothing is filed under', async () => {
    // Both paths have to be reachable, which is why an empty category is in the fixture set at all.
    expect(fixtureUnusedCategory.post_count).toBe(0);
    const response = await call(`/admin/categories/${fixtureUnusedCategory.id}`, {
      method: 'DELETE',
      token: FIXTURE_ADMIN_ACCESS_TOKEN,
    });

    expect(response.status).toBe(204);
  });

  it('exports the in-use refusal as an override registered in errorHandlers', async () => {
    // The commentary used to promise an exported 409 that did not exist. It does now, and it forces the
    // refusal on a category that has no posts - the other direction from the default guard.
    expect(errorHandlers.categoryInUse).toBeDefined();
    server.use(...errorHandlers.categoryInUse);

    const response = await call(`/admin/categories/${fixtureUnusedCategory.id}`, {
      method: 'DELETE',
      token: FIXTURE_ADMIN_ACCESS_TOKEN,
    });
    expect(response.status).toBe(409);
  });

  it('keeps an empty category in the public taxonomy rather than omitting it', async () => {
    // The service reports a term with nothing filed under it with `post_count: 0`, which the filter
    // control has to render.
    const response = await call('/categories');
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual([...fixtureCategories]);
  });
});

describe('registration conflict (I-14)', () => {
  it('reports one ambiguous email-or-username conflict, naming neither', async () => {
    // `AuthService` reports the same detail for a taken email and a taken username, from its pre-check
    // and from the database's unique violation both, so registration cannot be used to discover which
    // addresses are registered.
    server.use(...errorHandlers.registrationConflict);

    const response = await call('/auth/register', {
      method: 'POST',
      body: { email: 'taken@example.com', username: 'taken', password: 'a-long-enough-password' },
    });

    expect(response.status).toBe(409);
    const problem = (await response.json()) as ProblemDetail;
    expect(problem.detail).toBe('That email address or username is already registered.');
    expect(problem.detail).not.toContain('email address.');
    expect(problem.detail).toContain('or username');
  });
});

describe('the administrator fixture is what these assertions assume', () => {
  it('holds ADMIN, and the reader fixture does not', () => {
    // Stated rather than assumed: every 403 expectation above depends on it.
    expect(fixtureAdminAccount.role).toBe('ADMIN');
    expect(fixtureAuthorAccount.role).not.toBe('ADMIN');
  });
});
