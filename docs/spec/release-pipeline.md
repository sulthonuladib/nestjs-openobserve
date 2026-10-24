# Release pipeline — versioning, artifacts, CI

Status: **decided** · Applies to `apps/server`, `apps/web`, `packages/shared` ·
Target SDK: `@nestjs/observe@0.3.17` (MIT)

Two artifacts per release, **no npm package ever**:

| Artifact | Coordinates |
|---|---|
| OCI image | `ghcr.io/<org>/nestjs-openobserve:{vX.Y.Z, vX.Y, vX, latest, sha-<short>}` — `linux/amd64`, `linux/arm64` |
| Release tarball | `nestjs-observe-vX.Y.Z-{linux-x64,linux-arm64,darwin-x64,darwin-arm64}.tar.gz` + `SHA256SUMS` + signatures + attestations + SBOMs |

`repos/` (vendored SDK) is present for developers/agents and **absent from every
artifact** (§6).

---

## 1. Versioning

Three versions, bumped independently, all visible at `GET /health`:

| Version | Where it lives | Bumped by | Contract |
|---|---|---|---|
| **App** `X.Y.Z` | `version.txt` (root) — authoritative; mirrored into `package.json#version` by `scripts/sync-version.ts` | release-please PR | SemVer 2.0.0, see §1.1 |
| **Ingest API** `v1` | `/api/v1/ingest/*` path + `x-observe-compat` header | manual, rare | frozen; legacy hosted paths pinned to an SDK range |
| **Schema** integer | `app_meta.schema_version` (written by the Drizzle migrator runner) | drizzle-kit migrations | forward-only, upgrade from N-2 |

### 1.1 What counts as breaking for a *self-hosted server*

A change is **major** if an existing installation cannot be upgraded by pulling
the new image/tarball and restarting. Everything else is minor or patch.

| Change | Bump | Why |
|---|---|---|
| Remove/rename an `OBSERVE_*` env var, or change its meaning/units | **major** | the operator's compose file silently stops doing what it says |
| Add a *required* env var (no default) | **major** | existing installs fail to boot |
| Change default ports (`4319`/`4320`), data dir, volume path, file names, container UID/GID, entrypoint/CLI flags | **major** | breaks compose, bind mounts, firewall rules, backup scripts |
| Migration that cannot run automatically, or that breaks upgrade from N-2 | **major** | upgrade requires manual DB surgery |
| Drop an ingest path, accept fewer contract-valid batches, change the `200` body away from `{"degraded":false}`, change `400` semantics | **major** | breaks the SDK the user runs; silent data loss |
| Non-additive query-API change (rename/remove a field, change a status code), remove a `/dashboard/*` route | **major** | breaks saved links, scripts, the shipped SPA against an old cached asset |
| Remove a feature or a settings surface (SLOs, drop filters, retention config) | **major** | data/UI disappears |
| Change session cookie name / force logout of all users | minor (call it out) | annoying, recoverable |
| Change *default* retention, sampling, or ingest cap | minor (call it out) | silent behaviour change |
| Add env var with a default, add endpoint, add nullable column, add UI page, add index | minor | additive |
| Bug fix, perf fix, dependency bump, docs, CI | patch | — |
| Security fix | patch + GitHub Security Advisory + release-notes callout | operators must know to upgrade now |

Additive DB columns and new tables are always minor: migrations are forward-only
and a **newer schema must still be readable by the previous app version**
(no `NOT NULL` without default, no column renames without a compatibility view).

### 1.2 Pre-1.0 policy (`0.y.z`)

- Public surface is unstable, but the **three invariants in §1.3 are still
  treated as major** from day one: self-hosters cannot be broken silently.
- Config: `bump-minor-pre-major: true` + `bump-patch-for-minor-pre-major: false`
  ⇒ breaking → `0.(y+1).0`, feature → `0.(y+1).0`, fix → `0.y.(z+1)`.
- **Deprecation window**: one minor of runtime warning (`OBSERVE_FOO` →
  `console.warn("[deprecated] …")`, and a `deprecated` badge in the settings
  UI), removal in the next minor while `<1.0`, next major after `1.0`.
- `1.0.0` ships when the feature-parity matrix in `PLAN.md` §3.3 is complete for
  v0.3 **and** one upgrade-from-N-2 drill has passed.

### 1.3 Invariants that outlive SemVer numbers

1. **Ingest**: never `400` a batch the vendored contract accepts; never reply
   `degraded: true`; keep `/applications/telemetry`, `/applications/profiles`,
   `/cli-link/sessions`, `/cli-link/token` at their hosted paths.
2. **Schema**: forward-only; `downgrade` is unsupported; app refuses to start if
   `db.schema_version > app.schema_version` (fail closed, no writes).
3. **Config**: env vars are append-only within a major; removal is a major.

### 1.4 Ingest API version

| Surface | Versioning | Compatibility promise |
|---|---|---|
| `/api/v1/ingest/telemetry`, `/api/v1/ingest/link/*` | path segment `v1` | our own contract; breaking = `v2` alongside `v1` for ≥ 1 minor |
| `/applications/telemetry` etc. (hosted paths) | **unversioned**, exactly as the SDK sends | pinned to SDK range `>=0.3.17 <0.4.0`; a conformance test fails CI when the vendored contract changes |
| `/api/v1/*` (dashboard) | path segment | additive minor; breaking → `/api/v2` |
| `GET /health` | — | returns `{ version, schemaVersion, ingestApiVersion, sdkRange }` |
| Response header | — | `x-observe-compat: @nestjs/observe>=0.3.17 <0.4.0` on ingest replies |

### 1.5 Schema version + upgrade window N-2

- Drizzle's `__drizzle_migrations` table is the applied-migration ledger; the
  runner also writes a monotonic `app_meta.schema_version` integer, and applies
  everything at boot under a session-level `pg_advisory_lock` (one transaction
  per migration).
- App boots → reads `schema_version`:
  - `== app` → start;
  - `< app` → auto-migrate if `db_version >= app-2`, else exit with
    "upgrade through vX.Y first" (documented in `UPGRADING.md`);
  - `> app` → exit 1 (never write to a newer schema).
- **N-2** = the current minor plus the previous two minors (e.g. `0.4.x`
  migrates from `0.2.x`, `0.3.x`, `0.4.x`). Anything older requires stepping
  through an intermediate release; each minor is guaranteed to be a valid
  intermediate for one year.
- Before migrating: `pg_dump -Fc -d "$OBSERVE_DATABASE_URL" -f
  pre-migrate-<version>-<ts>.dump`; `OBSERVE_SKIP_MIGRATION_BACKUP=1` exists but
  is documented as "you have your own backups".

---

## 2. Release tooling: **release-please** (not changesets, not git-cliff)

| Tool | Verdict | Reason |
|---|---|---|
| **release-please** | **chosen** | Release PR with the version bump + `CHANGELOG.md` + SemVer inference from Conventional Commits, driven only by the GitHub API — no npm registry, no workspace publishing, no local hooks. |
| changesets | rejected | Designed around npm workspaces/`npm publish`; every changeset is a hand-written markdown file and it still needs a separate tagger for a non-published monorepo. |
| git-cliff + `bun run release` | rejected | Fastest changelog generator, but you own the bump/tag/publish logic and lose the reviewable "release PR" that makes `skip-github-release` + immutable releases safe. |

### 2.1 Minimal config

```json
// release-please-config.json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "release-type": "simple",
  "bump-minor-pre-major": true,
  "bump-patch-for-minor-pre-major": false,
  "include-component-in-tag": false,
  "changelog-sections": [
    { "type": "feat", "section": "Features" },
    { "type": "fix", "section": "Bug Fixes" },
    { "type": "perf", "section": "Performance" },
    { "type": "refactor", "section": "Refactors" },
    { "type": "deps", "section": "Dependencies" },
    { "type": "revert", "section": "Reverts" },
    { "type": "build", "section": "Build System" },
    { "type": "docs", "hidden": true },
    { "type": "chore", "hidden": true },
    { "type": "ci", "hidden": true },
    { "type": "test", "hidden": true }
  ],
  "packages": {
    ".": { "release-type": "simple", "package-name": "nestjs-openobserve" }
  }
}
```

```json
// .release-please-manifest.json
{ ".": "0.1.0" }
```

```
# version.txt  (committed, the single source of the app version)
0.1.0
```

`release-type: simple` bumps `version.txt` and writes `CHANGELOG.md`; the build
injects it into the binary with `--define BUILD_VERSION`.

### 2.2 Why `skip-github-release: true`

GitHub **immutable releases** forbid adding or changing assets after publish,
and recommend draft → upload → publish
([docs](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository),
[immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)).
release-please would publish immediately. So it only owns the **PR**; our
workflow owns the tag and the release:

```
PR merged (version.txt changes on main)
  → release.yml: read version → build 4 tarballs → build+push image (digest)
  → gh release create --draft vX.Y.Z   (tag created at publish)
  → upload assets → attest → cosign sign → gh release edit --draft=false
  → immutable release, tag + assets locked
```

Do **not** try to trigger a second workflow from the tag: a tag pushed with
`GITHUB_TOKEN` does not start workflows. Docker publish therefore lives in the
same workflow, with `type=semver,value=v$VERSION` instead of a tag ref.

---

## 3. SemVer + git conventions

- `main` is always releasable; every commit is Conventional Commits
  (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`, `deps:`,
  `feat!:`/`BREAKING CHANGE:` footer). `AGENTS.md` already requires this.
- Tags: `vX.Y.Z` only (no `vX.Y.Z-rc.1` on `main`; prereleases use
  `vX.Y.Z-rc.N` on a `release/x.y` branch and are published as GitHub
  prereleases — metadata-action then tags only `:X.Y.Z-rc.N`, never `:latest`).
- Merge strategy: squash. The release PR is the only commit release-please
  writes.

---

## 4. Docker image

### 4.1 Dockerfile (`apps/server/Dockerfile`)

```dockerfile
# syntax=docker/dockerfile:1.7
ARG BUN_VERSION=1.4.4

# ---- deps: install once on the build platform, cacheable ----
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS deps
WORKDIR /src
COPY package.json bun.lock ./
COPY apps/server/package.json      apps/server/
COPY apps/web/package.json         apps/web/
COPY packages/shared/package.json  packages/shared/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- build: bundle SPA, then cross-compile the single binary ----
FROM deps AS build
COPY . .
RUN bun build apps/web/index.html --outdir public --minify --production

ARG TARGETOS TARGETARCH VERSION=0.0.0-dev COMMIT=unknown
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) BUN_ARCH=x64 ;; \
      arm64) BUN_ARCH=arm64 ;; \
      *)     BUN_ARCH="${TARGETARCH}" ;; \
    esac; \
    bun build \
      apps/server/src/index.ts \
      --compile --minify --sourcemap --bytecode \
      --target="bun-${TARGETOS}-${BUN_ARCH}" \
      --asset ./public \
      --asset ./apps/server/migrations \
      --define BUILD_VERSION="\"${VERSION}\"" \
      --define BUILD_COMMIT="\"${COMMIT}\"" \
      --outfile /out/nestjs-observe

# ---- runtime: distroless, non-root, one binary ----
FROM --platform=$TARGETPLATFORM gcr.io/distroless/base-debian12:nonroot AS runtime

ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="nestjs-observe" \
      org.opencontainers.image.description="Self-hosted NestJS telemetry collector and dashboard" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT"

COPY --from=build --chown=65532:65532 /out/nestjs-observe /usr/local/bin/nestjs-observe

# OBSERVE_DATABASE_URL (postgres://…) is REQUIRED at runtime. The container is
# stateless: all data lives in Postgres, so there is no VOLUME.
ENV OBSERVE_API_PORT=4320 \
    OBSERVE_INGEST_PORT=4319 \
    NODE_ENV=production

USER 65532:65532
EXPOSE 4319 4320
ENTRYPOINT ["/usr/local/bin/nestjs-observe"]
```

Why this shape:

- **No QEMU.** The compile stage runs on `$BUILDPLATFORM` and Bun cross-compiles
  (`--target=bun-linux-arm64`) — see the
  [target table](https://bun.com/docs/bundler/executables#supported-targets).
  The runtime stage only `COPY`s, so no emulation is needed at all. Keep
  dependencies pure-JS so `bun install` stays platform-independent (see §4.7).
- **distroless** because the binary needs glibc and nothing else; `base` brings
  CA certs (outbound alert webhooks) and tzdata. No shell ⇒ **no `HEALTHCHECK`**;
  document an HTTP probe on `:4320/health` in compose/K8s.
- **Embedded SPA + migrations**: `--asset ./public` puts the dashboard and
  `--asset ./apps/server/migrations` puts the Drizzle SQL under
  `import.meta.dir` inside the binary; there is no asset directory to mount and
  no "where are my migrations?" question. Both paths are resolved once in the
  entrypoint.
- **Stateless**: Postgres is external. No `/data` volume, no `VOLUME` — a stale
  anonymous volume would silently shadow a bind mount. Backup is `pg_dump`
  against the database (§8), not a file copy out of the container.

### 4.2 `.dockerignore` (exact, repo root)

```gitignore
# ---- never part of any image ----
repos/
.prompts/
docs/
.github/
.git/
.gitignore
.gitattributes
# ---- local state / outputs (the image rebuilds what it needs) ----
node_modules/
**/node_modules/
dist/
**/dist/
public/
out/
coverage/
*.tgz
*.log
*.tsbuildinfo
.env
.env.*
!.env.example
.DS_Store
.idea/
.vscode/
# ---- tests and fixtures are not needed to build ----
**/*.test.ts
**/*.int.test.ts
**/test/
packages/shared/src/fixtures/
```

`public/` and `**/dist/` are intentionally ignored: the `build` stage produces
the SPA from source, so a stale local build can never leak into an image.

### 4.3 `.gitattributes` (exact, repo root)

```
# Vendored SDK and agent-only material never ship from `git archive`.
/repos           export-ignore
/.prompts        export-ignore
/.github         export-ignore
/docs            export-ignore
/test            export-ignore

# Deterministic text handling (byte-identical builds on Windows checkouts).
*                text=auto eol=lf
*.sh             text eol=lf
*.sql            text eol=lf
*.png            binary
*.ico            binary
*.woff2          binary

bun.lock         linguist-generated=true
```

`export-ignore` affects `git archive` only (GitHub source zips and
`git archive`), not the working tree. `README.md`/`LICENSE` stay in the source
archive on purpose; only the vendored tree, agent prompts, internal docs, CI and
tests are stripped. It is defence in depth: the release artifacts are built from
files, not from `git archive`, so §6's allowlist is the real gate.

### 4.4 Tag matrix (`docker/metadata-action`)

```yaml
- name: Image metadata
  id: meta
  uses: docker/metadata-action@<sha> # v6
  with:
    images: ghcr.io/${{ github.repository }}
    flavor: |
      latest=false
    tags: |
      # v1.2.3
      type=semver,pattern={{version}},value=v${{ env.VERSION }}
      # v1.2
      type=semver,pattern={{major}}.{{minor}},value=v${{ env.VERSION }}
      # v1  (never "0" while we are pre-1.0)
      type=semver,pattern={{major}},value=v${{ env.VERSION }},enable=${{ !startsWith(env.VERSION, '0.') }}
      # latest only for non-prerelease
      type=raw,value=latest,enable=${{ !contains(env.VERSION, '-') }}
      # sha-1a2b3c4
      type=sha,format=short,prefix=sha-
    labels: |
      org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}
      org.opencontainers.image.licenses=MIT
      org.opencontainers.image.title=nestjs-observe
      org.opencontainers.image.description=Self-hosted NestJS telemetry collector and dashboard
      org.opencontainers.image.documentation=${{ github.server_url }}/${{ github.repository }}#readme
    annotations: |
      org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}
      org.opencontainers.image.licenses=MIT
    sep-tags: ","
```

`flavor: latest=false` disables metadata-action's automatic `latest` so the
explicit `raw` rule is the only place that can set it (prereleases never get
it). The `{{major}}` tag is guarded because Docker tag `0` "should not be
generated" pre-1.0
([metadata-action docs](https://github.com/docker/metadata-action?tab=readme-ov-file#type-semver)).
Generated defaults also add `created`, `revision`, `url`.

### 4.5 `docker/build-push-action` inputs

```yaml
- name: Build and push
  id: build
  uses: docker/build-push-action@<sha> # v7
  with:
    context: .
    file: apps/server/Dockerfile
    platforms: linux/amd64,linux/arm64
    push: true
    tags: ${{ steps.meta.outputs.tags }}
    labels: ${{ steps.meta.outputs.labels }}
    annotations: ${{ steps.meta.outputs.annotations }}
    build-args: |
      BUN_VERSION=1.4.4
      VERSION=${{ env.VERSION }}
      COMMIT=${{ github.sha }}
    provenance: mode=max
    sbom: true
    pull: true
    cache-from: type=gha,scope=image
    cache-to: type=gha,mode=max,scope=image
```

- `provenance: mode=max` + `sbom: true` attach SLSA provenance and an SPDX SBOM
  to the multi-arch index in the registry
  ([docs](https://docs.docker.com/build/ci/github-actions/attestations/)).
- `cache-from/to: type=gha` gives layer reuse across runs without a registry
  cache image.
- The digest is `${{ steps.build.outputs.digest }}`; it goes into the release
  notes so operators can pin
  (`docker pull ghcr.io/<org>/nestjs-openobserve@sha256:…`).
- No `setup-qemu-action`: nothing executes target-platform instructions.

### 4.6 Edge builds

`docker.yml` on `push: branches: [main]` publishes `:edge` and `:sha-<short>`
only (never `:latest`), so users can track `main` without pretending it is a
release. Same action versions, same cache scope (`scope=edge` to avoid evicting
release cache).

### 4.7 Pipeline risks

| Risk | Impact | Mitigation |
|---|---|---|
| Bun cross-compile needs the target runtime on first use | release job depends on network / Bun CDN | cache `~/.bun` via BuildKit (`target=/root/.bun`); fallback: drop `--target` and let buildx run the arm64 stage under QEMU (`docker/setup-qemu-action`), which is ~3–5× slower but self-contained |
| A native/postinstall dependency appears | `bun install` on `$BUILDPLATFORM` installs the wrong arch | keep dependencies JS-only (enforced by a CI check that greps `bun.lock` for known native packages); otherwise fall back to per-platform build stages |
| Immutable release locks assets after publish | a broken asset cannot be replaced | draft → verify (`sha256sum -c`, smoke test) → publish; a bad release is superseded, never edited |
| macOS binaries are unsigned | Gatekeeper blocks first run | document `xattr -d com.apple.quarantine`; tier-2 support only |
| Action tags drift from pinned SHAs | supply-chain risk | `pinact` verify in CI; Renovate opens SHA-bump PRs |
| release-please needs a PAT in some orgs | release PR never opens | `RELEASE_PLEASE_TOKEN` secret; document the fallback (`GITHUB_TOKEN` + “Allow GitHub Actions to create PRs”) |
| Tag created by `GITHUB_TOKEN` triggers no workflows | image never publishes | docker publish runs in the **same** workflow, not on a tag event |

---

## 5. Release tarballs

### 5.1 Compile-to-binary vs `dist/` + `bun.lock`

| | (a) `bun build --compile` per platform | (b) `dist/` + `package.json` + `bun.lock` | (c) both |
|---|---|---|---|
| Host requirement | none (no Bun, no node_modules) | Bun 1.4.x on the host | mixed |
| SPA assets | embedded via `--asset` (one file) | separate `dist/` dir to keep in sync | two layouts to document |
| Size | ~90–110 MB (runtime included) | ~2 MB + `bun install` on first run | worst of both |
| Startup / RSS | best (`--bytecode`) | good | — |
| Patchability | rebuild required | edit JS in place | — |
| Supply-chain | one hash to verify | lockfile + registry at install time | — |
| Operator UX | `tar xzf && ./nestjs-observe` | `bun install && bun run start` | — |

**Decision: (a) only.** A self-hosted collector must start from a tarball with
no package manager, no network, and no runtime — that is the entire reason to
ship a tarball next to the image. (b) is a worse version of "run from a git
checkout", which we already support.

### 5.2 Naming

```
nestjs-observe-v0.2.0-linux-x64.tar.gz
nestjs-observe-v0.2.0-linux-arm64.tar.gz
nestjs-observe-v0.2.0-darwin-x64.tar.gz
nestjs-observe-v0.2.0-darwin-arm64.tar.gz
nestjs-observe-v0.2.0-linux-x64.tar.gz.sbom.spdx.json     # per artifact
SHA256SUMS
SHA256SUMS.bundle                                          # cosign keyless
```

Rules: `_` never appears in the product name, the version is SemVer with the
leading `v`, the OS/arch suffix uses uname spelling (`linux`/`darwin`,
`x64`/`arm64`) so a shell can build the URL with `uname -s | tr A-Z a-z` and
`uname -m` mapped `x86_64→x64`, `aarch64→arm64`. No Windows (Bun supports it,
but the collector's volume/permissions story does not).

### 5.3 Contents (exact allowlist)

```
nestjs-observe            # compiled binary, mode 0755
LICENSE
NOTICE
THIRD_PARTY.md
README.md
CHANGELOG.md
docker-compose.yml
.env.example
install.sh
```

The CI check in §6 asserts this list **exactly** — a stray file fails the
release. `.env.example` and `docker-compose.yml` are duplicated inside the
tarball so an air-gapped operator has everything in one download.

### 5.4 `install.sh`

```bash
#!/usr/bin/env sh
# nestjs-observe installer.
#   curl -fsSL https://raw.githubusercontent.com/<org>/nestjs-openobserve/main/install.sh | sh
# Review first if you prefer:
#   curl -fsSL .../install.sh -o install.sh && less install.sh && sh install.sh
set -eu

REPO="${OBSERVE_REPO:-<org>/nestjs-openobserve}"
VERSION="${OBSERVE_VERSION:-}"          # pin, e.g. OBSERVE_VERSION=v0.2.0
BIN_DIR="${OBSERVE_BIN_DIR:-/usr/local/bin}"
BASE="https://github.com/${REPO}/releases"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac
case "$os" in linux | darwin) ;; *) echo "unsupported os: $os" >&2; exit 1 ;; esac

if [ -z "$VERSION" ]; then
  VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)
fi
[ -n "$VERSION" ] || { echo "could not resolve version" >&2; exit 1; }

asset="nestjs-observe-${VERSION}-${os}-${arch}.tar.gz"
url="${BASE}/download/${VERSION}/${asset}"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

echo "→ ${VERSION} (${os}/${arch})"
curl -fsSL "$url"        -o "$tmp/$asset"
curl -fsSL "${BASE}/download/${VERSION}/SHA256SUMS" -o "$tmp/SHA256SUMS"

( cd "$tmp" && grep "  ${asset}\$" SHA256SUMS > "$asset.sha256" ) \
  || { echo "${asset} missing from SHA256SUMS" >&2; exit 1; }

if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$tmp" && sha256sum -c "$asset.sha256" )
else
  ( cd "$tmp" && shasum -a 256 -c "$asset.sha256" )
fi || { echo "checksum mismatch — refusing to install" >&2; exit 1; }

# Optional, if cosign is installed and a bundle was published:
#   cosign verify-blob --bundle SHA256SUMS.bundle \
#     --certificate-identity-regexp "https://github.com/${REPO}/" \
#     --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS

tar -xzf "$tmp/$asset" -C "$tmp"
if [ -w "$BIN_DIR" ]; then
  install -m 0755 "$tmp/nestjs-observe" "$BIN_DIR/nestjs-observe"
else
  sudo install -m 0755 "$tmp/nestjs-observe" "$BIN_DIR/nestjs-observe"
fi
echo "installed $BIN_DIR/nestjs-observe"
echo "run: OBSERVE_DATABASE_URL=postgres://… nestjs-observe"
```

This mirrors the pattern that works in practice for single-binary servers:
ntfy's `curl -sSf https://install.ntfy.sh | sudo bash`
([install docs](https://docs.ntfy.sh/install/)), Caddy's
`caddy_<ver>_<os>_<arch>.tar.gz` + signed `checksums.txt`
([release assets](https://github.com/caddyserver/caddy/releases)), and the
general guidance to keep such scripts auditable and checksum-verified
([Better CLI](https://bettercli.org/design/distribution/self-executing-installer/)).
`curl | sh` is offered but never required: the tarballs are the primary
interface.

### 5.5 Checksums, signing, attestations

| Artifact | Integrity | Provenance | SBOM |
|---|---|---|---|
| Tarballs | `SHA256SUMS` | `actions/attest` per tarball (`gh attestation verify <file> -R <org>/<repo>`) | `syft` SPDX JSON per tarball, attested via `sbom-path` |
| `SHA256SUMS` | itself in `SHA256SUMS.bundle` | `cosign sign-blob --yes --bundle SHA256SUMS.bundle SHA256SUMS` (keyless, OIDC) | — |
| Image | registry digest | `provenance: mode=max` + `actions/attest` (`subject-name`+`subject-digest`, `push-to-registry: true`) | `sbom: true` |

Caddy publishes exactly this shape (`.sig` + `.pem` + per-asset `.sbom`), which
is why we keep a cosign bundle alongside the GitHub-native attestation: one
verifies with `cosign`, the other with `gh`.

---

## 6. Keeping `repos/` out of artifacts

Four independent gates; any one of them is enough, all four are cheap.

| Gate | Mechanism | Catches |
|---|---|---|
| 1. Build context | `.dockerignore` `repos/` | SDK source in an image layer |
| 2. Source archive | `.gitattributes` `/repos export-ignore` | `git archive` / GitHub source zip |
| 3. Artifact allowlist | release workflow stages a `dist/release/` dir from explicit `cp` calls; `tar` only that dir | accidental `tar -czf … .` |
| 4. CI assertion | `scripts/check-artifacts.sh` on every release + PR | anything the first three missed |

```bash
#!/usr/bin/env bash
# scripts/check-artifacts.sh — fail the release if the vendored SDK leaks.
set -euo pipefail

expected=$'LICENSE\nNOTICE\nTHIRD_PARTY.md\nREADME.md\nCHANGELOG.md\ndocker-compose.yml\n.env.example\ninstall.sh\nnestjs-observe'

for f in dist/release/*.tar.gz; do
  got=$(tar -tzf "$f" | grep -v '/$' | sed 's|^\./||' | sort)
  if [ "$got" != "$(printf '%s\n' "$expected" | sort)" ]; then
    echo "::error file=$f::unexpected tarball contents"; echo "$got"; exit 1
  fi
  # belt and braces: no SDK source, tests, or internal docs, even compressed
  if tar -tzf "$f" | grep -Eq '(^|/)repos/|\.int-spec\.ts$|^\.prompts/|^docs/'; then
    echo "::error file=$f::vendored or internal files present"; exit 1
  fi
  if tar -xzOf "$f" nestjs-observe | grep -qa 'telemetry-wire-contract'; then
    echo "::error file=$f::compiled binary references the vendored contract path"; exit 1
  fi
done

# git archive must not contain the subtree either
if git archive --format=tar HEAD | tar -t | grep -Eq '^repos/'; then
  echo "::error::repos/ is not export-ignored"; exit 1
fi
```

Plus a Docker-context assertion in `ci.yml` (amd64 only, cheap):

```yaml
- run: docker buildx build --load --target build --platform linux/amd64 -t observe-build-check .
- run: docker run --rm --entrypoint sh observe-build-check -c 'test ! -e /src/repos && test ! -e /src/.prompts && test ! -e /src/docs'
```

---

## 7. GitHub Actions

### 7.1 `ci.yml`

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

env:
  BUN_VERSION: 1.4.4

jobs:
  lint-typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha> # v4
      - uses: oven-sh/setup-bun@<sha> # v2
        with: { bun-version: "${{ env.BUN_VERSION }}" }
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run build

  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: observe_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      OBSERVE_TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/observe_test
    steps:
      - uses: actions/checkout@<sha> # v4
      - uses: oven-sh/setup-bun@<sha> # v2
        with: { bun-version: "${{ env.BUN_VERSION }}" }
      - run: bun install --frozen-lockfile
      - run: bun test --coverage
      - name: Conformance fixtures are current
        run: bun scripts/gen-fixtures.ts --check
      - uses: actions/upload-artifact@<sha> # v4
        if: always()
        with: { name: coverage, path: coverage/, retention-days: 7 }

  docker-context:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha> # v4
      - uses: docker/setup-buildx-action@<sha> # v4
      - run: docker buildx build --load --target build --platform linux/amd64 -t observe-build-check .
      - run: docker run --rm --entrypoint sh observe-build-check -c 'test ! -e /src/repos && test ! -e /src/.prompts && test ! -e /src/docs'
```

### 7.2 `release.yml`

```yaml
name: release
on:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  release-please:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: googleapis/release-please-action@<sha> # v4
        with:
          token: ${{ secrets.RELEASE_PLEASE_TOKEN }}   # GITHUB_TOKEN is not enough to open PRs in some orgs
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json
          skip-github-release: true

  version:
    needs: release-please
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.v.outputs.version }}
      changed: ${{ steps.v.outputs.changed }}
    steps:
      - uses: actions/checkout@<sha> # v4
        with: { fetch-depth: 2 }
      - id: v
        run: |
          version=$(cat version.txt)
          prev=$(git show HEAD^:version.txt 2>/dev/null || echo "")
          echo "version=$version" >> "$GITHUB_OUTPUT"
          [ "$version" != "$prev" ] && echo "changed=true" >> "$GITHUB_OUTPUT" || echo "changed=false" >> "$GITHUB_OUTPUT"

  build:
    needs: version
    if: needs.version.outputs.changed == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write        # attest
      attestations: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: linux,  arch: x64 }
          - { os: linux,  arch: arm64 }
          - { os: darwin, arch: x64 }
          - { os: darwin, arch: arm64 }
    steps:
      - uses: actions/checkout@<sha> # v4
      - uses: oven-sh/setup-bun@<sha> # v2
        with: { bun-version: 1.4.4 }
      - run: bun install --frozen-lockfile

      - name: Build SPA + binary
        env:
          VERSION: v${{ needs.version.outputs.version }}
          OS: ${{ matrix.os }}
          ARCH: ${{ matrix.arch }}
        run: |
          set -euo pipefail
          mkdir -p stage
          bun build apps/web/index.html --outdir public --minify --production
          bun build apps/server/src/index.ts \
            --compile --minify --sourcemap --bytecode \
            --target="bun-${OS}-${ARCH}" \
            --asset ./public \
            --asset ./apps/server/migrations \
            --define "BUILD_VERSION=\"${VERSION}\"" \
            --define "BUILD_COMMIT=\"${GITHUB_SHA}\"" \
            --outfile stage/nestjs-observe

      - name: Stage tarball (allowlist only)
        env:
          VERSION: v${{ needs.version.outputs.version }}
          OS: ${{ matrix.os }}
          ARCH: ${{ matrix.arch }}
        run: |
          set -euo pipefail
          target="${OS}-${ARCH}"
          echo "TARGET=${target}" >> "$GITHUB_ENV"
          d="stage/nestjs-observe-${VERSION}-${target}"
          mkdir -p "$d" dist/release
          cp stage/nestjs-observe "$d/nestjs-observe"
          cp LICENSE NOTICE THIRD_PARTY.md README.md CHANGELOG.md docker-compose.yml .env.example install.sh "$d/"
          chmod 0755 "$d/nestjs-observe" "$d/install.sh"
          tar -C "$d" --sort=name --owner=0 --group=0 --numeric-owner \
              --mtime="@${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}" \
              -czf "dist/release/nestjs-observe-${VERSION}-${target}.tar.gz" .
          ( cd dist/release && sha256sum "nestjs-observe-${VERSION}-${target}.tar.gz" >> SHA256SUMS.${target} )

      - uses: anchore/sbom-action@<sha> # v0
        with:
          path: dist/release/nestjs-observe-v${{ needs.version.outputs.version }}-${{ env.TARGET }}.tar.gz
          format: spdx-json
          output-file: dist/release/nestjs-observe-v${{ needs.version.outputs.version }}-${{ env.TARGET }}.tar.gz.sbom.spdx.json

      - uses: actions/attest@<sha> # v4
        with:
          subject-path: dist/release/nestjs-observe-v${{ needs.version.outputs.version }}-${{ env.TARGET }}.tar.gz
          sbom-path: dist/release/nestjs-observe-v${{ needs.version.outputs.version }}-${{ env.TARGET }}.tar.gz.sbom.spdx.json

      - uses: actions/upload-artifact@<sha> # v4
        with:
          name: release-${{ matrix.os }}-${{ matrix.arch }}
          path: dist/release/
          retention-days: 5

  docker:
    needs: [version]
    if: needs.version.outputs.changed == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write
      attestations: write
    outputs:
      digest: ${{ steps.image.outputs.digest }}
    env:
      VERSION: ${{ needs.version.outputs.version }}
    steps:
      - uses: actions/checkout@<sha> # v4
      - uses: docker/setup-buildx-action@<sha> # v4
      - uses: docker/login-action@<sha> # v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@<sha> # v6
        with:
          images: ghcr.io/${{ github.repository }}
          flavor: |
            latest=false
          tags: |
            type=semver,pattern={{version}},value=v${{ env.VERSION }}
            type=semver,pattern={{major}}.{{minor}},value=v${{ env.VERSION }}
            type=semver,pattern={{major}},value=v${{ env.VERSION }},enable=${{ !startsWith(env.VERSION, '0.') }}
            type=raw,value=latest,enable=${{ !contains(env.VERSION, '-') }}
            type=sha,format=short,prefix=sha-
          labels: |
            org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}
            org.opencontainers.image.licenses=MIT
      - id: image
        uses: docker/build-push-action@<sha> # v7
        with:
          context: .
          file: apps/server/Dockerfile
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          annotations: ${{ steps.meta.outputs.annotations }}
          build-args: |
            BUN_VERSION=1.4.4
            VERSION=${{ env.VERSION }}
            COMMIT=${{ github.sha }}
          provenance: mode=max
          sbom: true
          pull: true
          cache-from: type=gha,scope=image
          cache-to: type=gha,mode=max,scope=image
      - uses: actions/attest@<sha> # v4
        with:
          subject-name: ghcr.io/${{ github.repository }}
          subject-digest: ${{ steps.image.outputs.digest }}
          push-to-registry: true
      - name: Summary
        run: |
          {
            echo "### ghcr.io/${{ github.repository }}"
            echo '```'
            echo "${{ steps.meta.outputs.tags }}"
            echo "digest: ${{ steps.image.outputs.digest }}"
            echo '```'
          } >> "$GITHUB_STEP_SUMMARY"

  publish:
    needs: [version, build, docker]
    if: needs.version.outputs.changed == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
      attestations: write
    env:
      VERSION: v${{ needs.version.outputs.version }}
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    steps:
      - uses: actions/checkout@<sha> # v4
      - uses: actions/download-artifact@<sha> # v4
        with:
          path: dist/release
          pattern: release-*
          merge-multiple: true
      - run: chmod +x scripts/check-artifacts.sh && ./scripts/check-artifacts.sh
      - name: Merge and sign checksums
        run: |
          set -euo pipefail
          cd dist/release
          sort -k2 SHA256SUMS.* | awk '{print $1"  "$2}' > SHA256SUMS
          rm -f SHA256SUMS.*
          sha256sum -c SHA256SUMS
      - uses: sigstore/cosign-installer@<sha> # v3
      - run: |
          cd dist/release
          cosign sign-blob --yes --bundle SHA256SUMS.bundle SHA256SUMS
      - name: Create draft release
        run: |
          set -euo pipefail
          notes=$(mktemp)
          {
            echo "Container: \`ghcr.io/${{ github.repository }}:${VERSION}\`"
            echo "Pinned digest: \`${{ needs.docker.outputs.digest }}\`"
            echo
            awk -v v="${VERSION#v}" '
              $0 ~ "^## \\[" v "\\]" { p=1; next }
              p && /^## \[/ { exit }
              p
            ' CHANGELOG.md
          } > "$notes"
          gh release create "${VERSION}" --draft --target "${GITHUB_SHA}" \
             --title "${VERSION}" --notes-file "$notes"
      - name: Upload assets
        run: gh release upload "${VERSION}" dist/release/* --clobber
      - name: Publish (immutable from here on)
        run: gh release edit "${VERSION}" --draft=false
```

Notes that matter:

- **Draft → upload → publish** is mandatory when immutable releases are enabled;
  `gh release create` with assets creates the draft, uploads, then publishes in
  one shot ([gh manual](https://cli.github.com/manual/gh_release_create)).
  We do it explicitly so the CI check and signatures run before publish.
- `docker` and `build` run in parallel; `publish` waits for both so the digest
  can be in the notes. The `docker` job exposes
  `outputs.digest: ${{ steps.image.outputs.digest }}`.
- The `build` matrix crosses-compiles all four targets on `ubuntu-latest`
  (`--target=bun-darwin-x64` etc.), so there is one toolchain, one `bun install`,
  and GNU `tar` semantics everywhere; no macOS runner and no QEMU. `stage/` and
  `public/` are gitignored build outputs.
- `SOURCE_DATE_EPOCH` + `tar --sort=name --mtime` gives a deterministic tarball
  for the same inputs; the compiled binary is reproducible given the same
  `oven/bun` digest and Bun version (pin both).

### 7.3 Pinning

Actions are referenced as `owner/action@<sha> # vX` in the real files. Resolve:

```bash
gh api repos/docker/build-push-action/commits/v7 --jq .sha
```

Enforce with `pinact` (or `ratchet`) in CI so a tag cannot reappear:

```yaml
- uses: suzuki-shunsuke/pinact-action@<sha> # v2
  with: { verify: true }
```

Also pin the base image digest in `apps/server/Dockerfile`
(`FROM oven/bun:1.4.4@sha256:…`) and let Renovate/Dependabot bump it; the
`BUN_VERSION` build-arg stays as documentation.

### 7.4 Least privilege, SLSA, reproducibility

| Concern | Setting |
|---|---|
| Default permissions | workflow-level `contents: read`; every extra scope is per-job |
| PRs from forks | `pull_request` (not `pull_request_target`), no secrets, no `packages: write` |
| Release jobs | only `workflow_dispatch`/`push: main` after the release PR merges |
| Concurrency | `ci` cancels in progress; `release` never cancels (half-published releases are worse than slow ones) |
| SLSA | `provenance: mode=max` (image) + `attest-build-provenance` (binaries) = SLSA Build L3-shaped provenance, verifiable with `gh attestation verify` |
| Reproducibility | pinned `oven/bun` digest, `--frozen-lockfile`, `SOURCE_DATE_EPOCH`, deterministic tar; documented as "same inputs → same tarball", not as a guarantee |
| Artifact retention | build artifacts 5 days; the published release is the durable copy |

---

## 8. Docs shipped with the product

| File | Contents |
|---|---|
| `README.md` | one-paragraph pitch, 60-second quickstart (image + tarball), port table, link to docs |
| `docker-compose.yml` | collector + `postgres:16-alpine` (§4.8 of `tech-stack.md`), `volumes: [observe-pgdata:/var/lib/postgresql/data]`, `OBSERVE_DATABASE_URL` wired to the `db` service, ports 4319/4320, `pg_isready` healthcheck; env from `.env` |
| `.env.example` | every `OBSERVE_*` var with default + comment; secrets marked `CHANGE_ME` |
| `docs/configuration.md` | env var reference generated from `apps/server/src/env.ts` (single source) |
| `docs/backup-restore.md` | `pg_dump -Fc` nightly (or managed PITR), restore into `observe_restore` with `pg_restore --no-owner`, boot with `OBSERVE_MIGRATE=off`; **restore drill** in the release checklist |
| `UPGRADING.md` | N-2 window, pre-migration backup location, downgrade is unsupported, per-version breaking notes |
| `CHANGELOG.md` | release-please, Keep-a-Changelog headings |
| `SECURITY.md` | private disclosure address, supported versions (current + previous minor), 90-day disclosure, no bug bounty |
| `LICENSE` | MIT (see §9) |
| `NOTICE` | `Contains protocol compatibility with @nestjs/observe, Copyright (c) 2017-present Kamil Mysliwiec, MIT` |
| `THIRD_PARTY.md` | vendored `repos/observe` (MIT, 0.3.17), every runtime dep with license, note that `repos/` is not shipped |
| `CONTRIBUTING.md` | `bun install`, `bun test`, `bun run typecheck`, `bun run lint`, Conventional Commits, "do not edit `repos/`" |
| `SUPPORT.md` | support matrix (§8.1), "single instance only", where to file bugs |

### 8.1 Support matrix

| Platform | Status | Notes |
|---|---|---|
| Docker `linux/amd64` | tier 1 | distroless, uid 65532, stateless (Postgres external) |
| Docker `linux/arm64` | tier 1 | same image index |
| Linux x64/arm64 tarball (glibc) | tier 1 | Debian 12 / Ubuntu 22.04+ validated in CI; Bun 1.4 x64 binaries target Nehalem/SSE4.2 and pick AVX2/AVX-512 at runtime, so there is **no AVX2 requirement** ([Bun targets](https://bun.com/docs/bundler/executables#supported-targets)) |
| macOS 13+ arm64, 13+ x64 tarball | tier 2 (dev/laptop) | unsigned binary: `xattr -d com.apple.quarantine nestjs-observe` documented |
| Alpine/musl | tier 3 | use the container; a `bun-linux-x64-musl` tarball can be added when asked |
| Windows | unsupported | Bun can compile it; we don't test volumes/permissions |
| SQLite | **unsupported** | not a supported store; `OBSERVE_DATABASE_URL` is required |
| Postgres 15/16/17 | tier 1 (**required**) | `OBSERVE_DATABASE_URL`; 16 is the compose default, 15/17 in CI |
| Multiple replicas | **unsupported** | single-process batch writer + cron; `pg_advisory_lock` per job is the future path |
| Reverse proxy | nginx/Caddy/Traefik tested | WebSocket for `/mcp` streaming, body size ≥ 8 MiB for ingest |

### 8.2 README quickstart (target text)

```bash
# easiest: clone, then `docker compose up -d` (collector + postgres)
curl -fsSLO https://raw.githubusercontent.com/<org>/nestjs-openobserve/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/<org>/nestjs-openobserve/main/.env.example
mv .env.example .env   # set OBSERVE_DB_PASSWORD
docker compose up -d

# or point at an existing Postgres:
docker run -d --name observe \
  -p 4319:4319 -p 4320:4320 \
  -e OBSERVE_DATABASE_URL='postgres://user:pass@host:5432/observe?sslmode=require' \
  -e OBSERVE_PUBLIC_URL=http://localhost:4320 \
  ghcr.io/<org>/nestjs-openobserve:latest
# open http://localhost:4320 → create the admin account
# point the agent at the collector:
#   OBSERVE_ENDPOINT=http://localhost:4319
```

---

## 9. Licensing and attribution

`repos/observe/LICENSE` is the **MIT** license (not Apache-2.0), copyright
2017-present Kamil Mysliwiec; `repos/observe/package.json` declares
`"license": "MIT"` and `"version": "0.3.17"`.

| Question | Answer |
|---|---|
| Do we ship SDK code in our artifacts? | **No.** `repos/` is excluded from images, tarballs, and the binary (§6). |
| Do we copy SDK source into `apps/`/`packages/`? | **No.** We re-implement the wire contract from the spec; the only derived material is JSON fixtures. |
| Does MIT force us to open-source our server? | No. MIT is permissive; our own code can be MIT, Apache-2.0, or proprietary. |
| What must we attribute? | If any MIT-licensed material is redistributed (the vendored subtree, the captured fixtures), the copyright notice + permission notice must be included. `NOTICE` + `THIRD_PARTY.md` + the fixtures' provenance comment do that. |
| Recommended license for **our** code | **MIT** — matches the SDK, keeps contribution friction at zero, and we have no metering to protect. Choose AGPL-3.0 only if a hosted competitor is a real threat; that is a business decision, not a technical one. |
| Trademark | Never name the product "NestJS Observe" as if official. Use "nestjs-observe (compatible with `@nestjs/observe`)" and keep the README's non-affiliation sentence; do not use Kamil's or NestJS's logos. |
| Can we relicense the SDK? | No. Keep `repos/observe/LICENSE` in the tree and never modify files under `repos/`. |

---

## 10. Release checklist (manual gate before `:latest` moves)

1. `bun test`, `bun run typecheck`, `bun run lint` green on the release commit.
2. Conformance fixtures regenerated and reviewed (`bun scripts/gen-fixtures.ts --check`).
3. Migration path tested: previous release DB → this release, and N-2 → this
   release, against Postgres 15/16/17.
4. Artifact check (`scripts/check-artifacts.sh`) green; tarball contents match
   the allowlist; no `repos/`.
5. `docker run` smoke test against an empty Postgres: migrations apply,
   `/health` returns the new version, ingest fixture batch accepted, SPA loads,
   `/openapi` renders.
6. `gh attestation verify` on one tarball and the image digest.
7. Release notes contain: breaking changes, env var changes, schema version,
   image digest, upgrade instructions link.
8. Backup/restore drill executed against the previous release's data.
9. After publish: pull `:vX.Y.Z` on a clean host and complete the quickstart.

---

## 11. References

- Docker: metadata-action tags/flavor/semver
  <https://github.com/docker/metadata-action#tags-input>, build-push-action
  inputs <https://github.com/docker/build-push-action#customizing>,
  multi-platform <https://docs.docker.com/build/ci/github-actions/multi-platform/>,
  attestations <https://docs.docker.com/build/ci/github-actions/attestations/>,
  reproducible builds
  <https://docs.docker.com/build/ci/github-actions/reproducible-builds/>
- GitHub: artifact attestations
  <https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations>,
  immutable releases
  <https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases>,
  releases + drafts
  <https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository>,
  `gh release create` <https://cli.github.com/manual/gh_release_create>
- release-please <https://github.com/googleapis/release-please-action#readme>;
  changesets action <https://github.com/changesets/action>; git-cliff
  <https://github.com/orhun/git-cliff>
- Bun: single-file executables (targets, `--asset`, `--define`, `--bytecode`)
  <https://bun.com/docs/bundler/executables>, Docker guide
  <https://bun.com/docs/guides/ecosystem/docker>, lockfile / `--frozen-lockfile`
  <https://bun.com/docs/pm/lockfile>
- Real-world distribution: ntfy `install.ntfy.sh` + per-platform tarballs
  <https://docs.ntfy.sh/install/>, Caddy tarballs + signed `checksums.txt` +
  per-asset SBOM <https://github.com/caddyserver/caddy/releases>, `curl | sh`
  guidance <https://bettercli.org/design/distribution/self-executing-installer/>
- SemVer 2.0.0 <https://semver.org/#semantic-versioning-specification-semver>
- `git archive` export-ignore
  <https://git-scm.com/docs/gitattributes#_creating_an_archive>
