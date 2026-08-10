// Next.js configuration for the frontend tier.
//
// Three settings, each forced by a specific requirement, and nothing else:
//
//   output                 a container image needs a self-contained server bundle
//   reactStrictMode        the interactive client islands must not hide double-render bugs
//   images.remotePatterns  cover images and avatars are remote URLs, never uploads
//
// The brevity is deliberate. Every other concern that looks like it belongs here
// already has an owner elsewhere in the tree, and configuring it a second time
// here would create two sources of truth that drift apart silently.
//
// DELIBERATELY ABSENT. Do not add:
//
//   1. Either of the two escape hatches that suppress type errors or lint errors
//      during `next build`. Both make the build succeed while `tsc --noEmit` and
//      `eslint . --max-warnings=0` would still fail, which demotes two blocking
//      quality gates to decoration. A build that reports a type or lint error is
//      reporting a defect in the offending file; it gets fixed there.
//   2. `rewrites` or `redirects` proxying to the API. The REST contract is the
//      only coupling between the two tiers: the browser calls
//      NEXT_PUBLIC_API_BASE_URL directly through src/lib/api/client.ts, and the
//      service admits that origin through its own CORS_ALLOW_ORIGINS setting. A
//      proxy declared here would become a second, undocumented integration seam
//      with its own caching, header and error-translation behaviour.
//   3. A `headers` function declaring security headers. The API owns response
//      headers in backend/app/middleware/security_headers.py. Declaring them in
//      both places guarantees the two copies diverge.
//   4. An `env` block. Every NEXT_PUBLIC_ variable is already inlined by the
//      framework, so a manual block only duplicates that mechanism - and it is
//      the easiest way to promote a non-public value into the client bundle by
//      accident.
//   5. PostCSS, Tailwind or any CSS pipeline setting. postcss.config.mjs owns the
//      stylesheet hand-off to the Tailwind engine and src/app/globals.css owns the
//      token layer.
//   6. `compiler` or TypeScript compiler options. tsconfig.json owns those,
//      including the "jsx": "react-jsx" value that stops `next build` from
//      rewriting a tracked file.
//   7. `i18n` or `basePath`. Localisation is out of scope and the site is served
//      at the origin root.
//   8. `experimental.*`. Nothing in the delivered feature set needs a flag whose
//      shape can change between patch releases.
//   9. A SECOND copy of the remote-image host list. `src/lib/utils.ts` owns it -
//      see the `images` block below for why that has to be the only copy.
//
// THIS MODULE READS NO ENVIRONMENT VARIABLE, and there is no fourth NEXT_PUBLIC_
// key behind the host list. `.env.example` declares fifteen variables - twelve
// backend fields and the three public values NEXT_PUBLIC_API_BASE_URL,
// NEXT_PUBLIC_SITE_URL and NEXT_PUBLIC_SITE_NAME - and the host allow-list is
// deliberately not among them: it is declared in source, in src/lib/utils.ts,
// which is the module every rendering component asks as well. The API origin
// belongs to the client module that calls it and the canonical site origin
// belongs to the metadata helpers, so neither appears here either.

import type { NextConfig } from 'next';

import { IMAGE_HOST_ALLOWLIST } from './src/lib/utils';

const nextConfig: NextConfig = {
  // Emit .next/standalone: server.js plus only the node_modules that the traced
  // entry points actually import. The production image's runtime stage copies
  // that directory together with .next/static and runs `node server.js`, so
  // without this key there is nothing for it to copy. The setting is additive -
  // `next start` still serves the ordinary .next output, logging an advisory that
  // names the standalone entry point as the preferred one.
  output: 'standalone',

  // Double-invoke renders and effects in development so that an impure client
  // island - the search input, category filter, like button, comment form, theme
  // toggle or an admin table - fails loudly here instead of intermittently in
  // production.
  reactStrictMode: true,

  images: {
    // A post's cover image and a user's avatar are stored as URLs: this product
    // has no upload, image-processing or object-storage pipeline at all, so every
    // image the optimiser fetches is third-party hosted and must be named here.
    // next/image rejects any origin missing from this list, which is exactly what
    // keeps the optimiser from acting as an open proxy for arbitrary remote
    // content - so no entry uses a wildcard host, and no entry admits plain
    // `http`; every one names a single hostname over TLS. `search` is left unset
    // so that a host may append its own query string (`?v=4`) without being
    // rejected, while `pathname` is `/**` because these are delivery CDNs whose
    // path shape is theirs, not ours.
    //
    // THE LIST IS DERIVED HERE AND DECLARED THERE, AND THAT IS THE POINT.
    //
    // `IMAGE_HOST_ALLOWLIST` is a source-code constant in src/lib/utils.ts - four
    // named delivery hosts, each with its reason written beside it. The same
    // module exports the `isAllowedImageUrl` predicate that every component asks
    // before handing a stored URL to next/image or to an avatar, so the
    // optimiser's list and the components' list are the same list by
    // construction.
    //
    // Writing the hosts out again here would recreate exactly the defect this
    // derivation removes. The service accepts any absolute http(s) URL for
    // cover_image_url and avatar_url (pydantic.HttpUrl), so the two tiers already
    // disagree about what is storable; the presentation tier's answer must at
    // least be single-valued, or a stored cover renders through the optimiser on
    // one surface and as a broken request on another.
    //
    // EVERY ENTRY ARRIVES GRAMMAR-CHECKED. src/lib/utils.ts validates the list
    // against `isBareHostname` at the point of declaration and throws otherwise,
    // so no scheme, userinfo, port, path, query, fragment or wildcard can reach
    // the map below - and `**`, which this framework reads as "any host" and
    // which would turn the optimiser into an open proxy for arbitrary remote
    // content, is unrepresentable rather than merely discouraged. Because that
    // module is the only way to reach the list, the check cannot be bypassed by
    // adding a second caller here.
    remotePatterns: IMAGE_HOST_ALLOWLIST.map((hostname) => ({
      protocol: 'https' as const,
      hostname,
      pathname: '/**',
    })),
  },
};

export default nextConfig;
