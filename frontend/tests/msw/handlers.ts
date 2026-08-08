/**
 * Request-interception handlers shared by the component test suite.
 *
 * `frontend/vitest.setup.ts` imports `handlers` from this module and spreads it into
 * the single `setupServer(...)` instance every component test runs against, so this
 * module is the one place a default mock for an API endpoint belongs. The setup file
 * starts that server with `onUnhandledRequest: 'error'`, which is what makes an
 * unmocked request a test failure instead of a socket attempt - and it is why the
 * default list below is deliberately empty rather than permissive: a handler earns its
 * place here only when a test needs it, and until then any unexpected call is loud.
 *
 * Two conventions apply to anything added here, both forced by decisions made
 * elsewhere in the tree:
 *
 *   1. Match against the documented API base URL, `http://localhost:8000/api/v1`.
 *      `vitest.setup.ts` pins `NEXT_PUBLIC_API_BASE_URL` to that value so no
 *      developer's `.env.local` can change the outcome of a gate. ES module imports
 *      are hoisted, so this module is evaluated *before* those assignments run: read
 *      the value with the same documented default here rather than relying on the
 *      environment already being set.
 *
 *   2. Mock at the network boundary, never the API client. `src/lib/api/client.ts` is
 *      the only module in the frontend permitted to perform HTTP, and it owns token
 *      attachment, refresh-on-401 and error normalisation. Intercepting HTTP one layer
 *      below it keeps that logic under test instead of stubbing it out.
 *
 * A single test that needs to narrow behaviour - an error status, a delay, a specific
 * payload - does so with `server.use(...)` from `vitest.setup.ts`; those overrides are
 * discarded after each test, so a per-test tweak never has to be added to this list.
 */

import type { RequestHandler } from 'msw';

/**
 * The default handler list applied to every component test.
 *
 * Empty by design: with no endpoint mocked by default, every request a component
 * makes has to be accounted for by the test that triggers it.
 */
export const handlers: RequestHandler[] = [];
