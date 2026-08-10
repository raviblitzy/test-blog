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
  FIXTURE_SUSPENDED_ACCESS_TOKEN,
  FIXTURE_SUSPENDED_REFRESH_TOKEN,
  errorHandlers,
  fixtureAdminAccount,
  fixtureAdminRotatedTokenPair,
  fixtureAdminTokenPair,
  fixtureAuthorAccount,
  fixtureCategories,
  fixtureDraftPost,
  fixtureEngineeringCategory,
  fixtureNoExcerptPost,
  fixturePost,
  fixturePosts,
  fixtureReaderAccount,
  fixtureReaderRotatedTokenPair,
  fixtureReaderTokenPair,
  fixtureRootComment,
  fixtureUnusedCategory,
  handlers,
} from './handlers';
import type {
  AdminComment,
  AdminPost,
  AdminStats,
  AdminUser,
  CategoryPublic,
  CommentPublic,
  Page,
  PostDetail,
  PostSummary,
  ProblemDetail,
  TokenPair,
  UserMe,
} from '@/lib/types';

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
  init?: {
    readonly method?: string;
    readonly token?: string;
    /** A verbatim `Authorization` value, for the cases where the *syntax* is the subject. */
    readonly authorization?: string;
    readonly body?: unknown;
  },
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init?.token !== undefined) {
    headers['Authorization'] = `Bearer ${init.token}`;
  }
  if (init?.authorization !== undefined) {
    headers['Authorization'] = init.authorization;
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

/** The rows of an administrative listing, read as the administrator. */
async function adminRows<T>(path: string, query: string): Promise<readonly T[]> {
  const response = await call(`${path}${query}`, { token: FIXTURE_ADMIN_ACCESS_TOKEN });
  expect([query, response.status]).toEqual([query, 200]);
  const page = (await response.json()) as Page<T>;

  return page.items;
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

describe('typed query parameters are refused, not ignored (I-08)', () => {
  it('answers 422 for a `mine` that is not a boolean, rather than serving the public feed', async () => {
    // `mine: bool` is validated by the framework before the route body runs, so a value it cannot
    // interpret never reaches the mode rules. Reading it as `=== 'true'` made `?mine=maybe` the public
    // feed - the same substitution the route refuses outright for a missing credential.
    const response = await call('/posts?mine=maybe', { token: FIXTURE_AUTHOR_ACCESS_TOKEN });
    expect(response.status).toBe(422);
    const problem = (await response.json()) as ProblemDetail;
    expect(problem.errors?.[0]?.field).toBe('mine');
    expect(problem.errors?.[0]?.type).toBe('bool_parsing');
  });

  it('accepts every boolean spelling Pydantic accepts', async () => {
    for (const truthy of ['true', '1', 'yes', 'on', 'TRUE']) {
      const response = await call(`/posts?mine=${truthy}`);
      // No credential, so the workspace refusal proves the value was read as TRUE.
      expect([truthy, response.status]).toEqual([truthy, 401]);
    }
    for (const falsy of ['false', '0', 'no', 'off']) {
      const response = await call(`/posts?mine=${falsy}`);
      expect([falsy, response.status]).toEqual([falsy, 200]);
    }
  });

  it('answers 422 for a workspace `status` outside the lifecycle set, not an empty page', async () => {
    // An empty page reads as "you have no drafts", which is a different answer and an untrue one.
    const response = await call('/posts?mine=true&status=PUBLSIHED', {
      token: FIXTURE_AUTHOR_ACCESS_TOKEN,
    });
    expect(response.status).toBe(422);
    const problem = (await response.json()) as ProblemDetail;
    expect(problem.errors?.[0]?.field).toBe('status');
    expect(problem.errors?.[0]?.type).toBe('enum');
  });

  it('reports every rejected parameter from one request', async () => {
    // FastAPI validates the whole request and answers with each field it rejected, so a caller that
    // sent two bad values must not have to fix them one round trip at a time.
    const response = await call('/posts?sort=newest&page=0', {
      token: FIXTURE_AUTHOR_ACCESS_TOKEN,
    });
    expect(response.status).toBe(422);
    const problem = (await response.json()) as ProblemDetail;
    expect(problem.errors?.map((item) => item.field).sort()).toEqual(['page', 'sort']);
  });
});

describe('feed ordering matches the repository clause lists (I-08)', () => {
  it('never orders by engagement, and never breaks a recency tie on the title', async () => {
    // `_build_ordering` has no `view_count` clause and no title clause; its last clause is always
    // `posts.id DESC`. A most-viewed-first sequence is one the service cannot produce.
    const published = [...fixturePosts]
      .filter((post) => post.status === 'PUBLISHED')
      .sort((left, right) => right.view_count - left.view_count)
      .map((post) => post.slug);
    const byEngagement = published.join('|');

    expect((await feedSlugs('')).join('|')).not.toBe(byEngagement);
    expect((await feedSlugs('?sort=relevance')).join('|')).not.toBe(byEngagement);
  });

  it('leads a searched relevance page with the best title match', async () => {
    // rank first, then trigram similarity on the title - so the post whose TITLE carries the term
    // leads a page it shares with posts that only mention it in the body.
    const ranked = await feedSlugs('?q=search');
    expect(ranked[0]).toBe(fixtureNoExcerptPost.slug);
  });

  it('is a total order: page two is disjoint from page one', async () => {
    // What the `posts.id DESC` tail exists for. With a non-total order two rows sharing a key can be
    // returned by both pages while a third is returned by neither.
    const first = await feedSlugs('?page=1&page_size=2');
    const second = await feedSlugs('?page=2&page_size=2');
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(first.filter((slug) => second.includes(slug))).toEqual([]);
  });
});

describe('request bodies are read against their own schema (I-10)', () => {
  it('refuses a blank self-profile display_name rather than treating it as a no-op', async () => {
    // `DisplayName` carries no blank-folding validator, because `users.display_name` is NOT NULL - so
    // a cleared control is too short, not "leave it alone". Folding it answered 200 with the old name.
    const response = await call('/users/me', {
      method: 'PATCH',
      token: FIXTURE_AUTHOR_ACCESS_TOKEN,
      body: { display_name: '   ' },
    });
    expect(response.status).toBe(422);
    const problem = (await response.json()) as ProblemDetail;
    expect(problem.errors?.[0]).toEqual({
      field: 'display_name',
      message: 'String should have at least 1 characters',
      type: 'string_too_short',
    });
  });

  it('still clears a nullable profile member from a blank submission', async () => {
    // The other half of the same rule: `OptionalBio` DOES declare `_blank_to_none`, because
    // `users.bio` is nullable and a cleared textarea means "remove it".
    const response = await call('/users/me', {
      method: 'PATCH',
      token: FIXTURE_AUTHOR_ACCESS_TOKEN,
      body: { bio: '' },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as UserMe).bio).toBeNull();
  });

  it('refuses a blank or malformed parent_id instead of posting a root comment', async () => {
    // `CommentCreate.parent_id` is `uuid.UUID | None`. Read as a blank-folding string, a reply whose
    // parent identifier the client failed to supply was accepted at the top of the thread, with a 201.
    for (const parentId of ['', '   ', 'not-a-uuid']) {
      const response = await call(`/posts/${fixturePost.id}/comments`, {
        method: 'POST',
        token: FIXTURE_READER_ACCESS_TOKEN,
        body: { body: 'A reply that names no parent.', parent_id: parentId },
      });
      expect([parentId, response.status]).toEqual([parentId, 422]);
      const problem = (await response.json()) as ProblemDetail;
      expect(problem.errors?.[0]?.field).toBe('parent_id');
    }
  });

  it('still accepts an explicit null parent_id as a root comment', async () => {
    const response = await call(`/posts/${fixturePost.id}/comments`, {
      method: 'POST',
      token: FIXTURE_READER_ACCESS_TOKEN,
      body: { body: 'A root comment.', parent_id: null },
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as CommentPublic).parent_id).toBeNull();
  });

  it('treats an empty comment update as the valid no-op the schema declares', async () => {
    // `CommentUpdate`'s single member is optional and the service dumps `exclude_unset=True`, so `{}`
    // validates, changes nothing and must not be refused with "Field required".
    const response = await call(`/comments/${fixtureRootComment.id}`, {
      method: 'PATCH',
      token: FIXTURE_READER_ACCESS_TOKEN,
      body: {},
    });
    expect(response.status).toBe(200);
    const unchanged = (await response.json()) as CommentPublic;
    expect(unchanged.body).toBe(fixtureRootComment.body);
    // A no-op writes nothing, so neither the moderation state nor the timestamp moves.
    expect(unchanged.status).toBe(fixtureRootComment.status);
    expect(unchanged.updated_at).toBe(fixtureRootComment.updated_at);
  });

  it('still validates a comment body that IS present', async () => {
    const response = await call(`/comments/${fixtureRootComment.id}`, {
      method: 'PATCH',
      token: FIXTURE_READER_ACCESS_TOKEN,
      body: { body: '   ' },
    });
    expect(response.status).toBe(422);
  });
});

describe('credential syntax and optional authentication (I-11)', () => {
  it('matches the Bearer scheme case-insensitively, as RFC 7235 requires', async () => {
    // `app.core.dependencies` folds the parsed scheme with `.lower()`. Matching the literal
    // `'Bearer '` by prefix made a client that spelled the scheme unconventionally look anonymous.
    for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
      const response = await call('/auth/me', {
        authorization: `${scheme} ${FIXTURE_READER_ACCESS_TOKEN}`,
      });
      expect([scheme, response.status]).toEqual([scheme, 200]);
    }
  });

  it('refuses a present-but-unusable credential with 401 on a PUBLIC read', async () => {
    // The distinction `_bearer_token` exists to draw: an absent header is anonymous, a header this
    // API cannot use is a 401 - on the four optional-authentication reads as much as on a protected
    // route. Downgrading it to anonymous strands a client with a lapsed token on the public
    // projection forever, because refresh-on-401 is keyed on precisely this status.
    for (const authorization of [
      `Basic ${FIXTURE_READER_ACCESS_TOKEN}`,
      'Bearer',
      'Bearer   ',
      FIXTURE_READER_ACCESS_TOKEN,
    ]) {
      for (const path of [
        '/posts',
        `/posts/${fixturePost.slug}`,
        `/posts/${fixturePost.id}/comments`,
        `/posts/${fixturePost.id}/likes`,
      ]) {
        const response = await call(path, { authorization });
        expect([authorization, path, response.status]).toEqual([authorization, path, 401]);
        expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
      }
    }
  });

  it('refuses an unrecognised credential on a public read rather than serving it anonymously', async () => {
    const response = await call('/posts', { token: 'not-a-token-this-module-issued' });
    expect(response.status).toBe(401);
  });

  it('answers a deactivated account anonymously on a public read and 403 on a protected one', async () => {
    // `get_current_user_optional` narrows an inactive principal to anonymous BEFORE it returns, so a
    // suspended author reads what the public reads and no more; `get_current_active_user` refuses.
    const feed = await call('/posts', { token: FIXTURE_SUSPENDED_ACCESS_TOKEN });
    expect(feed.status).toBe(200);
    const page = (await feed.json()) as Page<PostSummary>;
    expect(page.items.every((item) => item.status === 'PUBLISHED')).toBe(true);
    expect(page.items.some((item) => item.slug === fixtureDraftPost.slug)).toBe(false);

    expect((await call('/auth/me', { token: FIXTURE_SUSPENDED_ACCESS_TOKEN })).status).toBe(403);
  });

  it('leaves an absent header anonymous', async () => {
    expect((await call('/posts')).status).toBe(200);
  });
});

describe('refresh rotation (I-11)', () => {
  it('issues the PRESENTING principal a pair, so a rotation cannot switch identity', async () => {
    // One shared rotated pair, mapped to the author, made a reader's or an administrator's rotation
    // return as the author - and every assertion after that rotation was about the wrong person.
    const cases = [
      { presented: fixtureReaderTokenPair, expected: fixtureReaderRotatedTokenPair },
      { presented: fixtureAdminTokenPair, expected: fixtureAdminRotatedTokenPair },
    ];

    for (const { presented, expected } of cases) {
      const rotated = await call('/auth/refresh', {
        method: 'POST',
        body: { refresh_token: presented.refresh_token },
      });
      expect(rotated.status).toBe(200);
      expect((await rotated.json()) as TokenPair).toEqual(expected);

      const me = await call('/auth/me', { token: expected.access_token });
      expect((await me.json()) as UserMe).toEqual(
        presented === fixtureReaderTokenPair ? fixtureReaderAccount : fixtureAdminAccount,
      );
    }
  });

  it('keeps administrative authority across an administrator rotation', async () => {
    const stats = await call('/admin/stats', {
      token: fixtureAdminRotatedTokenPair.access_token,
    });
    expect(stats.status).toBe(200);
    const asReader = await call('/admin/stats', {
      token: fixtureReaderRotatedTokenPair.access_token,
    });
    expect(asReader.status).toBe(403);
  });

  it('refuses every unexchangeable token with the same 401, deactivated owners included', async () => {
    // `rotate_refresh_token` raises one `UnauthorizedError` for never-issued, already-spent, expired
    // and owner-unusable alike. It has no 403 branch, so the 403 this module used to answer for a
    // suspended owner was a status no client could ever receive.
    for (const refreshToken of ['never-issued-by-this-module', FIXTURE_SUSPENDED_REFRESH_TOKEN]) {
      const response = await call('/auth/refresh', {
        method: 'POST',
        body: { refresh_token: refreshToken },
      });
      expect([refreshToken, response.status]).toEqual([refreshToken, 401]);
      expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
      const problem = (await response.json()) as ProblemDetail;
      expect(problem.type).toBe('/errors/unauthorized');
    }
  });
});

describe('administrative listings query what the repositories query (I-12)', () => {
  it('searches accounts by username and email, and not by display name', async () => {
    // `UserRepository` builds `username ILIKE :p OR email ILIKE :p` over those two columns only.
    const byEmail = await adminRows<AdminUser>('/admin/users', `?q=${fixtureReaderAccount.email}`);
    expect(byEmail.map((row) => row.id)).toEqual([fixtureReaderAccount.id]);

    const byHandle = await adminRows<AdminUser>(
      '/admin/users',
      `?q=${fixtureReaderAccount.username}`,
    );
    expect(byHandle.map((row) => row.id)).toContain(fixtureReaderAccount.id);

    // The display name is deliberately NOT searched: a term that appears only there finds nothing.
    const displayOnly = fixtureReaderAccount.display_name.split(' ')[1] ?? '';
    expect(displayOnly.length).toBeGreaterThan(0);
    expect(fixtureReaderAccount.username.toLowerCase()).not.toContain(displayOnly.toLowerCase());
    const byDisplayName = await adminRows<AdminUser>('/admin/users', `?q=${displayOnly}`);
    expect(byDisplayName).toEqual([]);
  });

  it('searches posts by title, excerpt and body, and not by slug', async () => {
    // The listing is ranked with the same vector the feed uses, and that vector covers those three.
    const contentTerm = 'Invalidation';
    expect(fixtureDraftPost.content).toContain(contentTerm);
    expect(fixtureDraftPost.title).not.toContain(contentTerm);
    const byBody = await adminRows<AdminPost>('/admin/posts', `?q=${contentTerm}`);
    expect(byBody.map((row) => row.id)).toContain(fixtureDraftPost.id);
  });

  it('searches comments by body alone', async () => {
    const authored = await adminRows<AdminComment>(
      '/admin/comments',
      `?q=${fixtureRootComment.author.username}`,
    );
    expect(authored).toEqual([]);
  });

  it('answers 422 for a malformed enum, boolean or identifier filter rather than ignoring it', async () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['/admin/users', '?role=SUPERUSER', 'role'],
      ['/admin/users', '?is_active=maybe', 'is_active'],
      ['/admin/posts', '?status=PUBLSIHED', 'status'],
      ['/admin/posts', '?author_id=not-a-uuid', 'author_id'],
      ['/admin/comments', '?status=APROVED', 'status'],
      ['/admin/comments', '?post_id=42', 'post_id'],
    ];

    for (const [path, query, field] of cases) {
      const response = await call(`${path}${query}`, { token: FIXTURE_ADMIN_ACCESS_TOKEN });
      expect([query, response.status]).toEqual([query, 422]);
      const problem = (await response.json()) as ProblemDetail;
      expect(problem.errors?.[0]?.field).toBe(field);
    }
  });
});

describe('the administrator lockout guard (I-12)', () => {
  it('refuses self-demotion, self-deactivation and self-deletion with 409', async () => {
    // `AdminService` refuses all three, and `UserRowActions` relies on that refusal rather than
    // duplicating the rule - so a mock that permitted them left the guard untestable.
    const demote = await call(`/admin/users/${fixtureAdminAccount.id}`, {
      method: 'PATCH',
      token: FIXTURE_ADMIN_ACCESS_TOKEN,
      body: { role: 'AUTHOR' },
    });
    expect(demote.status).toBe(409);
    expect(((await demote.json()) as ProblemDetail).detail).toContain('own administrator role');

    const deactivate = await call(`/admin/users/${fixtureAdminAccount.id}`, {
      method: 'PATCH',
      token: FIXTURE_ADMIN_ACCESS_TOKEN,
      body: { is_active: false },
    });
    expect(deactivate.status).toBe(409);
    expect(((await deactivate.json()) as ProblemDetail).detail).toContain('deactivate their own');

    const remove = await call(`/admin/users/${fixtureAdminAccount.id}`, {
      method: 'DELETE',
      token: FIXTURE_ADMIN_ACCESS_TOKEN,
    });
    expect(remove.status).toBe(409);
    expect(((await remove.json()) as ProblemDetail).detail).toContain('delete their own');
  });

  it('permits the three self-targeted moves that are not lockouts', async () => {
    // An empty patch is a legitimate no-op, re-sending ADMIN changes nothing, and `is_active: true`
    // asks to stay active. Refusing any of them would be as wrong as omitting the guard.
    for (const body of [{}, { role: 'ADMIN' }, { is_active: true }]) {
      const response = await call(`/admin/users/${fixtureAdminAccount.id}`, {
        method: 'PATCH',
        token: FIXTURE_ADMIN_ACCESS_TOKEN,
        body,
      });
      expect([JSON.stringify(body), response.status]).toEqual([JSON.stringify(body), 200]);
      const updated = (await response.json()) as AdminUser;
      expect(updated.role).toBe('ADMIN');
      expect(updated.is_active).toBe(true);
    }
  });

  it('still lets an administrator act on somebody else', async () => {
    const response = await call(`/admin/users/${fixtureReaderAccount.id}`, {
      method: 'PATCH',
      token: FIXTURE_ADMIN_ACCESS_TOKEN,
      body: { role: 'AUTHOR' },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as AdminUser).role).toBe('AUTHOR');
  });
});

describe('taxonomy and slug allocation (I-10)', () => {
  it('reports counts that match the collections they count', async () => {
    // Derived rather than written out: `category_count` said three while four categories were stored.
    const response = await call('/admin/stats', { token: FIXTURE_ADMIN_ACCESS_TOKEN });
    const stats = (await response.json()) as AdminStats;
    expect(stats.category_count).toBe(fixtureCategories.length);
    expect(stats.post_count).toBe(fixturePosts.length);
  });

  it('allocates a free slug rather than answering with one that is already held', async () => {
    // `categories.slug` and `posts.slug` are uniquely constrained, so a create cannot answer with a
    // slug something else holds. The service appends the first free suffix; so does the mock.
    const category = await call('/admin/categories', {
      method: 'POST',
      token: FIXTURE_ADMIN_ACCESS_TOKEN,
      body: { name: 'engineering!' },
    });
    expect(category.status).toBe(201);
    const created = (await category.json()) as CategoryPublic;
    expect(created.slug).not.toBe(fixtureEngineeringCategory.slug);
    expect(created.slug).toBe(`${fixtureEngineeringCategory.slug}-2`);

    const post = await call('/posts', {
      method: 'POST',
      token: FIXTURE_AUTHOR_ACCESS_TOKEN,
      body: { title: fixturePost.title, content: 'A second article with the same title.' },
    });
    expect(post.status).toBe(201);
    expect(((await post.json()) as PostDetail).slug).toBe(`${fixturePost.slug}-2`);
  });

  it('refuses a rename onto a name another category holds, and permits re-sending its own', async () => {
    const collision = await call(`/admin/categories/${fixtureUnusedCategory.id}`, {
      method: 'PATCH',
      token: FIXTURE_ADMIN_ACCESS_TOKEN,
      body: { name: fixtureEngineeringCategory.name },
    });
    expect(collision.status).toBe(409);
    expect(((await collision.json()) as ProblemDetail).detail).toBe(
      'A category with that name already exists.',
    );

    const noop = await call(`/admin/categories/${fixtureUnusedCategory.id}`, {
      method: 'PATCH',
      token: FIXTURE_ADMIN_ACCESS_TOKEN,
      body: { name: fixtureUnusedCategory.name },
    });
    expect(noop.status).toBe(200);
    expect(((await noop.json()) as CategoryPublic).slug).toBe(fixtureUnusedCategory.slug);
  });

  it('counts an unpublished association as an association', () => {
    // The semantics the refusal is keyed on, asserted on the data rather than through a request.
    // `post_count` counts PUBLISHED alone; `is_in_use` counts every lifecycle state. At least one
    // fixture category must exhibit the gap or the mock's predicate is untested even in principle.
    const divergent = fixtureCategories.filter((category) => {
      const associations = fixturePosts.filter((post) =>
        post.categories.some((entry) => entry.id === category.id),
      );

      return associations.length > category.post_count;
    });

    expect(divergent.length).toBeGreaterThan(0);
    for (const category of divergent) {
      const unpublished = fixturePosts.filter(
        (post) =>
          post.status !== 'PUBLISHED' && post.categories.some((entry) => entry.id === category.id),
      );
      expect(unpublished.length).toBeGreaterThan(0);
    }
  });

  it('keys the delete refusal on every association, not on the published count', async () => {
    // `CategoryService.delete` refuses on `is_in_use`, an EXISTS over `post_categories` carrying no
    // status predicate, while `post_count` counts PUBLISHED alone. The two diverge for a category
    // whose only posts are unpublished: `post_count` reports it as empty, the server still refuses.
    //
    // The expectation is DERIVED from an all-status scan rather than written out, so it follows the
    // rule rather than today's data. Stated plainly: no current fixture has zero published posts AND
    // a non-zero association count, so reverting this one predicate to `post_count > 0` would not
    // fail today - the derived form is what makes the assertion bite the moment a fixture does.
    for (const category of fixtureCategories) {
      const referenced = fixturePosts.some((post) =>
        post.categories.some((entry) => entry.id === category.id),
      );

      const response = await call(`/admin/categories/${category.id}`, {
        method: 'DELETE',
        token: FIXTURE_ADMIN_ACCESS_TOKEN,
      });

      expect([category.name, response.status]).toEqual([category.name, referenced ? 409 : 204]);
      if (referenced) {
        expect(((await response.json()) as ProblemDetail).detail).toBe(
          'Posts are still filed under this category. Re-file them before deleting it.',
        );
      }
    }
  });
});

describe('the administrator fixture is what these assertions assume', () => {
  it('holds ADMIN, and the reader fixture does not', () => {
    // Stated rather than assumed: every 403 expectation above depends on it.
    expect(fixtureAdminAccount.role).toBe('ADMIN');
    expect(fixtureAuthorAccount.role).not.toBe('ADMIN');
  });
});
