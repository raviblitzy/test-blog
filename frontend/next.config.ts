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
//
// This module reads no environment variable, because nothing it configures is
// deployment-specific: the API origin belongs to the client module that calls it,
// the canonical site origin belongs to the metadata helpers, and the host
// allow-list below is a security policy rather than a per-environment value.

import type { NextConfig } from 'next';

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
    // content - so the list stays short, literal and justified per entry. No
    // entry uses a wildcard host, and no entry admits plain `http`; every one
    // names a single origin over TLS. `search` is left unset so that a host may
    // append its own query string (`?v=4`) without being rejected, while
    // `pathname` is stated explicitly on every entry so that narrowing one later
    // is a one-word edit.
    //
    // This list is also the contract the seeded demonstration content draws
    // from: cover_image_url and avatar_url may reference only these hosts.
    // Admitting another one is a policy decision, made by adding an entry here
    // with the same one-line justification.
    remotePatterns: [
      // Unsplash delivery CDN - the demonstration cover photography.
      { protocol: 'https', hostname: 'images.unsplash.com', pathname: '/**' },
      // Lorem Picsum - deterministic placeholder covers, /seed/<slug>/<w>/<h>.
      { protocol: 'https', hostname: 'picsum.photos', pathname: '/**' },
      // Cloudinary delivery host - where an author's own cover image is hosted.
      { protocol: 'https', hostname: 'res.cloudinary.com', pathname: '/**' },
      // GitHub avatar host - the default source of user avatar URLs.
      { protocol: 'https', hostname: 'avatars.githubusercontent.com', pathname: '/**' },
    ],
  },
};

export default nextConfig;
