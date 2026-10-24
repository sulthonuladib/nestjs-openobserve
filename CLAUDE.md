@AGENTS.md

# Claude Code

Project rules live in `AGENTS.md` (imported above). The non-negotiables:

- `repos/` is a vendored git subtree of `@nestjs/observe`: read-only reference,
  never edited, never imported by application code. The only importer is
  `test/conformance/`, which asserts our wire port equals the SDK's contract.
- No pricing, billing, plans, quotas, seats or upgrade surfaces. Ever.
- The collector never answers `degraded: true` — every such mode in the SDK is a
  billing concept, and the agent silently drops data when it sees one.
- Postgres + Drizzle, Bun + Elysia, feature modules under `apps/server/src/modules/`.
- Conventional Commits; the release is driven by release-please.
