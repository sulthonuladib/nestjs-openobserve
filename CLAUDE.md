@AGENTS.md

# Claude Code

Project rules live in `AGENTS.md` (imported above). The non-negotiables:

- `repos/` is a vendored git subtree of `@nestjs/observe`: read-only reference,
  never edited, never imported by application code. The only importer is
  `test/conformance/`, which asserts our wire port equals the SDK's contract.
- No pricing, billing, plans, quotas, seats or upgrade surfaces. Ever.
- The collector never answers `degraded: true` — every such mode in the SDK is a
  billing concept, and the agent silently drops data when it sees one.
- Postgres + Drizzle, Bun + Elysia, feature modules under `src/server/modules/`.
- One Bun app: `src/server` + `public/`, no Vite and no workspaces. The dashboard
  source lives under `public/` because Bun bundles it from the release artifact.
- Conventional Commits; the release is driven by release-please.
