# ==========================================================================================
# Production container image for the Next.js presentation tier.
#
# Three stages. `deps` resolves the dependency tree from the lockfile and does nothing else;
# `builder` compiles the application; `runner` is the image that ships, and it receives only
# build artifacts - never a compiler, never a linter, never a test runner, never a browser
# binary. Agent Action Plan section 0.4.5.1 specifies a "Multi-stage production image" for
# this tier, and section 0.7.1.12 schedules it beside the tier's tooling configuration; both
# are literal here. The shape - pinned base matching the version-pin file, a build stage, a
# slim runtime stage, a dedicated non-root account, one exposed port, nothing confidential
# baked, and a default command that names a target which actually resolves - is the same shape
# backend/Dockerfile establishes for the service tier, deliberately, so that a reader who has
# read one can read the other.
#
# BUILD CONTEXT IS `frontend/`, not the repository root:
#
#     docker build -f frontend/Dockerfile -t blog-frontend \
#       --build-arg NEXT_PUBLIC_API_BASE_URL="$NEXT_PUBLIC_API_BASE_URL" \
#       --build-arg NEXT_PUBLIC_SITE_URL="$NEXT_PUBLIC_SITE_URL" \
#       --build-arg NEXT_PUBLIC_SITE_NAME="$NEXT_PUBLIC_SITE_NAME" \
#       frontend/
#
# so every COPY source below is relative to frontend/. That is a property of this file alone
# and is stated because it is not guessable from the outside: a build launched from the
# repository root fails on the first COPY. The three values are read from the shell rather
# than written out here, which is the whole point of section 0.5.9's configuration contract -
# the repository-root example environment contract (the tracked `*.example` variant) is the
# single place their documented values live, and repeating one here would create a second copy
# that drifts.
#
# RUN IT with the same three values supplied at run time:
#
#     docker run --rm -p 3000:3000 \
#       -e NEXT_PUBLIC_API_BASE_URL="$NEXT_PUBLIC_API_BASE_URL" \
#       -e NEXT_PUBLIC_SITE_URL="$NEXT_PUBLIC_SITE_URL" \
#       -e NEXT_PUBLIC_SITE_NAME="$NEXT_PUBLIC_SITE_NAME" \
#       blog-frontend
#
# WHY THE THREE VALUES APPEAR TWICE, AND WHY THAT IS NOT REDUNDANT
#
# This is the one genuinely subtle thing about this file. Where a component reads
# NEXT_PUBLIC_SITE_URL - or either of the other two names - as a literal member expression on
# the process environment, the framework rewrites that expression into the configured string
# while it compiles, so all three values are INLINED INTO THE COMPILED OUTPUT AT BUILD TIME.
# src/lib/seo.ts documents the same mechanism from the other side: it keeps the variable names
# in separate constants used only for error messages, precisely because a COMPUTED lookup -
# indexing the environment by a variable holding the name - is not a literal, survives
# unrewritten, and reads undefined in a browser.
#
# Two consequences follow, and both are load-bearing:
#
#   1. The BUILD needs them. An image built without NEXT_PUBLIC_API_BASE_URL would ship
#      compiled output that has no address to call, and no amount of run-time injection repairs
#      that afterwards. This is why the ARGs below are correctness, not convenience.
#   2. The RUNTIME STAGE STILL DECLARES THEM, so the shipped image is self-describing: the
#      three values are visible in the image's own configuration, which is what an operator
#      reading it and an orchestrator's own variable set can be compared against, instead of
#      being invisibly sealed inside compiled chunks.
#
# Because both stages take the SAME `--build-arg`, the pair agrees by construction. And the
# reason that matters is stronger than tidiness, because it was MEASURED on this image rather
# than assumed:
#
#   Built with one site name and run with a different one supplied at run time, the server
#   rendered the BUILD-TIME name in the page title and in the social card, and published the
#   BUILD-TIME origin in the crawl policy and the sitemap, while the run-time values sat unused
#   in the process. Grepping the compiled output found the build-time address inside a server
#   chunk and the run-time one nowhere at all.
#
# So a run-time override of any of these three is INERT for what the tier serves - it changes
# only what the process reports about itself. Re-pointing a built image at a different API or a
# different canonical origin is a REBUILD, not a restart, and that is a property of the
# framework's inlining rather than a choice this file makes. The runtime declarations exist so
# that the two can never silently disagree about which values a given image was built with.
#
# NO DEFAULT IS GIVEN TO ANY OF THE THREE, and the absence is enforced rather than merely
# intended. src/lib/seo.ts's `resolveSiteOrigin` and `resolveSiteName` throw when their
# variable is missing or malformed, and src/lib/api/client.ts's `resolveApiBaseUrl` throws
# "deliberately loud" when its own is blank; the root layout's metadata, sitemap.ts, robots.ts
# and opengraph-image.tsx are all evaluated while the framework prerenders, so a build that
# omits an argument FAILS THERE, naming the variable. A placeholder origin would have turned
# that loud failure into a shipped bundle quietly aimed at somebody else's host.
#
# WHAT THIS IMAGE DELIBERATELY DOES NOT DO
#
#   * It does not carry configuration beyond those three public values. No confidential value
#     appears as ENV, as a build argument, or in a comment - and none could usefully: the
#     NEXT_PUBLIC_ prefix publishes a value into compiled client output by design, so this
#     tier has no place to keep one even if it wanted to. No local environment file is ever
#     copied, and two independent things keep it that way: the root ignore file excludes every
#     such file from version control, and no COPY below names one - which matters here more
#     than it looks, because the tier-scoped local override of these three values does exist on
#     a working checkout, sitting in this very build context, and had a broad COPY pulled it in
#     the framework would have loaded it and silently outranked the arguments this build was
#     given.
#   * It does not lint, type-check outside the compile, unit-test or run browser journeys.
#     Those gates belong to the pipeline definition and the root Makefile. Running them here
#     would slow every image build and pull test tooling into a layer that ships. The compile
#     itself is NOT optional, though - see the builder stage.
#   * It does not run as root. See the `nextjs` account below.
#   * It does not use `next start`. See the runtime stage.
#
# WHY EVERY COPY IS NARROW AND EXPLICIT, AND WHY THERE IS NO `COPY . .`
#
# This plan contains no build-context ignore file, by design - section 0.4.5.1's inventory does
# not list one - which moves the whole burden of exclusion onto the COPY lines. A build context
# is read from the filesystem, not from version control, so this tier's ignored-but-present
# directories are all sitting in it and none of them may reach a layer: `node_modules/` (some
# six hundred and sixty packages, host-resolved), `.next/` (a previous build's output, including
# a whole previous standalone tree), `tests/`, the browser cache, `coverage/`, the journey
# reports, the incremental type-check cache, and the local override file named above. On a
# working checkout that directory measures 937 MB, of which all but roughly 3 MB must never ship.
#
# FIVE COPY statements read from that context - one in the resolve stage and four in the compile
# stage - and each names its sources explicitly. (The other four copies in this file take
# `--from`, so they read an earlier stage rather than the context.) The effect is measurable
# rather than theoretical: the builder transferred 2.74 MB of context for this image. That is
# not the tool being clever on its own account - it follows directly from every COPY naming a
# path, because the transfer is filtered to what the instructions ask for. A single `COPY . .`
# would move all 937 MB AND commit it to a layer, which is the failure this discipline exists to
# prevent and the reason no such instruction appears below.
# ==========================================================================================


# ------------------------------------------------------------------------------------------
# Stage 1 - deps: resolve the dependency tree from the lockfile
# ------------------------------------------------------------------------------------------
#
# The tag is the EXACT patch version, matching frontend/.nvmrc (24.19.0) and
# frontend/package.json's `engines.node`. `node:24`, `node:lts` and `node:latest` are all
# forbidden: the pinned-and-reproducible standard exists to replace the unpinned prose install
# that was this repository's only dependency declaration, and a floating tag reintroduces
# exactly that looseness one layer down from the lockfile.
#
# The precision pays off immediately and was verified rather than hoped for: this image ships
# Node v24.19.0 with npm 11.17.0, which is precisely what package.json declares in both
# `engines.npm` and `packageManager`. So the engine range is satisfied by the base image
# itself, and there is no global package upgrade step anywhere in this file - which is
# fortunate, because upgrading a package manager without a pin is the same drift the lockfile
# exists to remove.
#
# DELIBERATELY NOT PINNED BY DIGEST, and this is a considered trade rather than an oversight.
# The digest of this tag at authoring time was
# sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 - an OCI image index
# over linux/amd64 and its siblings, built on debian:bookworm-slim - and it is recorded here
# for audit rather than enforced above. The official images rebuild a fixed three-part Node tag
# whenever their Debian base absorbs a security update: the index inspected while writing this
# file was created long after Node 24.19.0 itself was released, which is that mechanism
# visible in the metadata. Freezing the digest would therefore pin the one thing that SHOULD
# move - the base operating system's patch level - while the thing the standard actually cares
# about, the version of the runtime and of every package, is already exact here and in the
# lockfile.
FROM node:24.19.0-slim AS deps

# Package-manager behaviour only - no application configuration lives in ENV anywhere in this
# file - and the same discipline backend/Dockerfile applies to pip's version check. The update
# notice is silenced rather than acted on, for two reasons. The pinned manager is already the
# one this image ships, so there is nothing to act on; and the notice ends by printing a
# copy-pasteable global upgrade command into every build log, which is precisely the unpinned
# resolving install this file must never contain and must not advertise either.
#
# NOTE WHAT IS DELIBERATELY NOT HERE: NODE_ENV. See the resolve step below - declaring it in
# this stage would silently drop every dependency the compile needs.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# /build, matching backend/Dockerfile's builder, and never /app: with `COPY src ./src` a
# WORKDIR of /app reads as a duplicated name and invites a "corrective" flatten later.
WORKDIR /build

# Both manifests first, alone, so this layer and the resolve below cache on the pin set and
# are not invalidated by an edit to a component.
#
# The lockfile is not optional here even though only the manifest names the scripts. It is
# what `npm ci` reads - the command fails outright without it - and it is also how the
# framework infers its file-tracing root, so copying it keeps the compiled output's traced
# boundary the same one a developer gets on a working checkout.
COPY package.json package-lock.json ./

# `npm ci` and NOTHING that resolves: it installs strictly what the lockfile records and fails
# when the lockfile and the manifest disagree, which makes a drifted lockfile a failed build
# instead of an image full of versions nobody chose. No `--force`, no legacy peer resolution
# and no upgrade flag appears anywhere in this file; the tier's two version ceilings
# (TypeScript at 6.0.3 and ESLint on the 9 line, both required by the framework's lint
# configuration's peer ranges) survive only while the lockfile is obeyed exactly.
#
# DEV DEPENDENCIES ARE INSTALLED HERE, ON PURPOSE, and that is why NODE_ENV is conspicuously
# absent from this stage. npm defaults its `omit` setting to `dev` when NODE_ENV is
# `production`, so declaring it here would silently drop TypeScript, the type packages, the
# Tailwind engine and its PostCSS bridge and typography plugin - every one of which the compile
# in the next stage requires. They are build-time only and never reach the shipped image,
# because the runtime stage copies artifacts rather than this tree.
#
# `--no-audit --no-fund` suppress two registry-facing reports that neither change resolution
# nor belong in a build log. Note the distinction from the prohibited advisory-repair command:
# these flags decline to PRINT a report, and nothing in this file ever rewrites the tree the
# lockfile describes.
RUN npm ci --no-audit --no-fund


# ------------------------------------------------------------------------------------------
# Stage 2 - builder: compile the application into a standalone server bundle
# ------------------------------------------------------------------------------------------
FROM node:24.19.0-slim AS builder

# Three behaviour settings, none of them application configuration - the three public values
# arrive lower down, as arguments.
#
#   NODE_ENV                    production semantics for the compile itself
#   NEXT_TELEMETRY_DISABLED     a container build must not report to a third party, and the
#                               framework's first-run notice is noise in every pipeline log
#   NPM_CONFIG_UPDATE_NOTIFIER  the same reason the resolve stage gives. It is repeated here and
#                               not inherited, because a stage begins from the base image rather
#                               than from its predecessor - and the compile is launched through
#                               the manager's script runner, so the notice reappeared here until
#                               this line existed.
#
# NODE_ENV belongs HERE and in the runtime stage, and not in the resolve stage above. The
# asymmetry is the whole point: this stage runs no install, so the production setting cannot
# prune anything, while the stage that does install would have had its dev dependencies
# omitted by exactly this line.
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /build

# The resolved tree, unchanged, rather than a second resolve. One resolve per image.
COPY --from=deps /build/node_modules ./node_modules

# Then the compile inputs, ordered least-likely-to-change first so an edit to a component does
# not invalidate the configuration layers above it. Each source is named because it is needed:
#
#   package.json          the `build` script this stage runs, and the manifest the framework
#                         copies into its standalone output for the runtime stage to use
#   package-lock.json     the file-tracing root anchor described in the previous stage
#   next.config.ts        `output: 'standalone'` lives here - see the runtime stage for why
#                         that one key is what makes this whole three-artifact design possible
#   tsconfig.json         the compile type-checks against it, including the "jsx": "react-jsx"
#                         value that stops the build from rewriting a tracked file
#   postcss.config.mjs    the stylesheet hand-off to the Tailwind engine; without it the
#                         semantic theme layer in src/app/globals.css compiles to nothing
#   src/                  the application, and also a compile-time dependency of the framework
#                         configuration itself, which imports its remote-image host list from
#                         src/lib/utils.ts rather than restating it
#   public/               the static assets; they are re-copied into the runtime stage from
#                         here rather than from the context, so one lineage feeds both
#
# NOT copied, and each absence is deliberate: the lint configuration, the formatter
# configuration, the component-test and browser-journey configurations, `tests/`, the
# incremental type-check cache, the previous `.next/` output, the host `node_modules/`, and any
# local override of the three public values. None is a compile input, and every one of them
# either bloats the build or changes its result.
COPY package.json package-lock.json ./
COPY next.config.ts tsconfig.json postcss.config.mjs ./
COPY public ./public
COPY src ./src

# The three public values, declared as arguments with NO DEFAULT and promoted to ENV so the
# compile can read them. See this file's header for why a default would be a defect rather
# than a convenience, and why the framework's build-time inlining makes their presence here a
# correctness requirement.
#
# THE BLOCK IS CLOSED AT THREE. The configuration contract declares exactly these names for
# this tier and the service tier's settings model tolerates exactly these three alongside its
# own fields, rejecting any fourth by exact spelling. Adding one here would therefore break
# the other tier's startup, not merely widen this file.
#
# They sit AFTER the COPY instructions on purpose: an ENV instruction invalidates every layer
# below it, so declaring them here means changing one value rebuilds only the compile, while
# declaring them above would rebuild every copy as well.
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_SITE_NAME
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} \
  NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
  NEXT_PUBLIC_SITE_NAME=${NEXT_PUBLIC_SITE_NAME}

# The compile, and it is a BLOCKING GATE. `npm run build` runs the framework's build, which
# type-checks the project as it goes, so a type error fails this image build. There is no
# `|| true`, no `--if-present`, and the framework configuration carries neither of the two escape
# hatches that would let a type or lint error through - its own header records that refusal, and
# this stage is the reason it matters: an image that builds while the type gate would have failed
# is an image that ships a defect the pipeline believed it had caught.
#
# TESTED, not assumed, both ways. A deliberate type error introduced into one module aborted this
# instruction with `error TS2322` and a non-zero exit, and no image was produced. Omitting one of
# the three arguments above aborted it too, with the tier's own message naming the missing
# variable. Either way the failure is loud and the build stops here.
RUN npm run build


# ------------------------------------------------------------------------------------------
# Stage 3 - runner: the image that ships
# ------------------------------------------------------------------------------------------
FROM node:24.19.0-slim AS runner

# Factual metadata only. Deliberately no version label: package.json owns the version, and a
# second copy here is a copy that drifts the first time only one of the two is bumped.
LABEL org.opencontainers.image.title="blog-frontend" \
  org.opencontainers.image.description="Next.js presentation tier of the blog platform" \
  org.opencontainers.image.base.name="docker.io/library/node:24.19.0-slim"

# Runtime behaviour, none of it application configuration.
#
# PORT and HOSTNAME are read by the generated entry point, verified by reading it rather than
# assumed: it parses PORT (falling back to 3000) and takes HOSTNAME (falling back to '0.0.0.0').
# Both are declared anyway, and HOSTNAME especially - a server that binds loopback only is the
# classic container that builds, starts, reports healthy from the inside and is unreachable from
# every `-p` mapping. Declaring the value makes the bind address a property of the image instead
# of a default that a future release could quietly change. Confirmed at run time: the server
# announces `http://0.0.0.0:3000` and answers requests made from outside the container.
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=3000 \
  HOSTNAME=0.0.0.0

# Least privilege: a dedicated group and account with fixed numeric IDs, no login shell and no
# credential, mirroring backend/Dockerfile's `blog` account down to the flags. Fixed IDs rather
# than whatever the next `useradd` happens to allocate, so a mounted volume's ownership means
# the same thing on every host; `--system` keeps the account out of the human ID range. The base
# image already ships a `node` account at 1000, and this deliberately is not it - a tier-owned
# account at a known ID is what makes the ownership split below legible.
#
# ONE WARNING IS EXPECTED HERE AND IS NOT A DEFECT: `useradd` reports that uid 10001 exceeds the
# distribution's system-account ceiling of 999, then honours the request - measured in this
# image, where the resulting identity is exactly uid 10001, gid 10001. Both halves are wanted at
# once: an ID above the packaged ranges cannot collide with an account some future base-image
# update adds, and `--system` still means the account is not a person's. The service tier's image
# takes the same warning for the same reason, so DO NOT "fix" it by lowering the ID or dropping
# the flag - that would silence one line of output at the cost of making the two tiers' accounts
# work differently.
RUN groupadd --system --gid 10001 nodejs \
  && useradd --system --uid 10001 --gid nodejs --create-home --home-dir /home/nextjs \
    --shell /usr/sbin/nologin nextjs

# /srv/frontend, mirroring /srv/backend in the service tier's image.
WORKDIR /srv/frontend

# THE THREE ARTIFACTS, AND NOTHING ELSE. This is the whole payload, and it exists in this shape
# only because next.config.ts sets `output: 'standalone'`:
#
#   .next/standalone   the generated `server.js` plus a PRUNED node_modules containing only what
#                      the traced entry points actually import - measured inside this image:
#                      ELEVEN top-level packages, against the 662 the resolve stage installed.
#                      Scanned for the tooling that must never ship - the type checker, the
#                      linter, the component-test runner, the browser-journey runner, the request
#                      mocker, the styling engine, the formatter, the DOM implementation and any
#                      downloaded browser binary - and found none of them.
#   .next/static       the client assets, which the standalone output does not include
#   public/            the static assets, which it does not include either
#
# If the FIRST of these three copies ever fails, check that key in next.config.ts before
# anything else: without it the compile emits no standalone directory at all, so there is nothing
# for this line to find, and the failure surfaces here rather than where the cause is.
#
# OWNER root, GROUP nodejs. The chown is read for intent rather than for the letter: the
# runtime account reads and traverses this tree through its group and cannot write to it, so a
# compromised request handler cannot rewrite the code that serves the next request. Owning the
# tree with the account that executes it would hand exactly that ability away for nothing.
COPY --from=builder --chown=root:nodejs /build/.next/standalone ./
COPY --from=builder --chown=root:nodejs /build/.next/static ./.next/static
COPY --from=builder --chown=root:nodejs /build/public ./public

# ONE writable directory, carved out of an otherwise read-only tree. The framework's compiled
# configuration keeps disk flushing for regenerated pages enabled and the image optimiser is
# present in the pruned tree (this project serves remote cover images and avatars through it),
# and both write beneath `.next/cache`. Without this the first optimised image or revalidated
# page logs a permission failure at run time for a container that looked perfectly healthy at
# build time. Created explicitly, owned by the runtime account and reachable only by it, so the
# grant is exactly one directory wide rather than a chown of the whole tree.
#
# Both halves of that were exercised in the running container: the runtime account can create a
# file under this directory, and attempting to write anywhere in the code tree - including over
# `server.js` itself - is refused.
RUN install --directory --owner=nextjs --group=nodejs --mode=0700 .next/cache

# The three public values again, from the same arguments the compile received, so the shipped
# image's own variable set matches what was inlined into it. See this file's header for the full
# reasoning; the short version is that the compile bakes them and this keeps the running
# container honest about which values those were.
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_SITE_NAME
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} \
  NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
  NEXT_PUBLIC_SITE_NAME=${NEXT_PUBLIC_SITE_NAME}

# One port, used consistently by this declaration, by the probe below and by the bind address
# above, and it is the port the rest of the project already assumes - the configuration
# contract's canonical site origin and the service tier's permitted browser origins both name
# 3000. Operators remap it at run time rather than by rebuilding.
EXPOSE 3000

# LIVENESS, and the distinction from readiness is the same one backend/Dockerfile draws: a
# container health check drives restart policy, so it must answer "is this process still
# serving HTTP?" and nothing more. Any status below 500 counts as healthy, which is not
# laxness - a 404 from a route that does not exist, or a 401 from one that needs
# authorisation, is a correct answer produced by a working server, and restarting the
# container would not change it. A 5xx, a refused connection or a hang would not be, and each
# fails the probe. Deciding whether to send traffic is the orchestrator's call, made against
# its own criteria.
#
# The home route is the target because it is the tier's one guaranteed public entry point. The
# threshold, not the route, is what makes that safe: a tier whose home route is still being built
# out answers 404 there while every other route it does have works, and a probe that demanded 200
# would report a perfectly live container as unhealthy and have an orchestrator restart it in a
# loop. Measured on this image: the container reports `healthy` while `/` answers 404 and
# `/robots.txt`, `/sitemap.xml` and the generated social card all answer 200.
#
# Probed with the runtime because this base image ships NEITHER curl NOR wget (verified, not
# assumed), and a health check that shells out to a binary which does not exist reports unhealthy
# forever while the service is fine. Exec form, so no shell is involved - which also means no
# variable expansion, hence the literal port. The interval is modest and the start period generous
# enough for the server to bind before the first probe counts against it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const req = require('http').request({host: '127.0.0.1', port: 3000, path: '/', method: 'GET', timeout: 4000}, (res) => {res.resume(); process.exit(res.statusCode < 500 ? 0 : 1);}); req.on('timeout', () => {req.destroy(); process.exit(1);}); req.on('error', () => process.exit(1)); req.end();"]

# Everything above this line runs as root because it must - creating an account, writing into
# /srv. Nothing below it does.
#
# NUMERIC, and this is the one place this file deliberately spells something differently from
# backend/Dockerfile, which names its account here. The reason is a specific deployment failure
# rather than a style preference: an orchestrator asked to guarantee a container is not root has
# to decide that from the image alone, and a NAME is not resolvable to it - Kubernetes'
# `runAsNonRoot` refuses to start a Pod whose image declares a non-numeric user, because it
# cannot verify the claim without reading the image's own account database. `10001:10001` states
# the same identity in the form every such check can evaluate, and `hadolint` flags the name form
# (DL3066) for exactly this reason.
#
# It is the SAME account created above, not an anonymous id: because that account exists in this
# image, the numeric form still resolves, and the container reports `nextjs` with
# uid=10001(nextjs) gid=10001(nodejs) - verified, because an id with no matching account would
# have printed a bare number and broken anything expecting a resolvable home.
USER 10001:10001

# `node server.js`, the entry point the framework generates inside its standalone output, in
# exec form so node is PID 1 and receives SIGTERM directly instead of through a shell that
# would swallow it.
#
# NOT `next start`, and not the `start` script that wraps it. That path needs the full resolved
# tree and the framework's command-line tool present at run time, which would undo both the
# pruning this stage depends on and the no-build-tooling discipline the service tier's image
# follows. The generated entry point needs neither.
#
# And this command was RUN, not merely written. The repository's README documented
# `uvicorn main:app` against a module that has never existed, which the plan classifies as its one
# non-functional feature; shipping a command nobody has executed is how that defect is made, so
# this one was executed against this image first. What that run established: process 1 is the
# server itself rather than a shell wrapping it, it runs as uid 10001, it binds 0.0.0.0:3000 and
# answers from outside the container, it serves the crawl policy and the sitemap built from the
# origin this image was given, it renders markup - title, social card and heading - into the
# initial response with no client scripting involved, it can write its regeneration cache, and it
# cannot write one byte of its own code tree.
CMD ["node", "server.js"]
