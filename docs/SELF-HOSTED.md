# Self-hosted operational model

The hosted product's account model exists to sell seats and plans: sign-up,
email verification, teams as billing entities, SSO upsells. A self-hosted install
has one operator (often one person), a VPS, and no mail server. Modelling it as
"the SaaS, minus the invoice" is how you ship a product that cannot be installed.

This document replaces the account/team section of `PLAN.md` §3.1 (F18/F21).
Precedent for every decision below: Coolify, Gitea, Vaultwarden, Plausible,
Umami, Grafana — the products people actually self-host.

---

## 1. Identity: one instance, one admin, invites

| Hosted (removed) | Self-hosted (ours) |
|---|---|
| Public sign-up + email verification | **No public registration.** Closed after setup; access only by invite |
| Teams as billing/ownership entities | **No teams.** Projects own telemetry; admins own the instance. A team in the SaaS is what a *tenant* is in a hosted product — self-hosted has exactly one |
| Account plans gate features | Everything is on. No feature flags, no entitlements |
| Seats, per-user pricing | Unlimited members |
| SSO as an upsell | OIDC/SAML is an *optional instance setting*, off by default |
| Password reset by email | Reset by email **if SMTP is configured**; otherwise a CLI command. Nobody should be locked out of their own server because they have no mail relay |
| 2FA per account | Optional, off by default; not required for anything |

### Roles

Two layers, matching the upstream project-access matrix exactly (Read / Write /
Admin) plus one instance-level role:

| Layer | Roles | Assigned by |
|---|---|---|
| **Instance** | `admin` (everything, incl. settings, users, invites, retention) | first-run setup; later by another instance admin |
| **Project** | `read` (view), `write` (+ create apps/keys/rules/SLOs, resolve errors), `admin` (+ rename/delete project, manage members) | project admins |

"Creator only" is a rule, not a role: whoever filed an issue may edit or delete
it regardless of their project role.

### Setup flows

**A. First run (the normal case).** `/setup` is served only while `app_user` is
empty. It asks for instance name, admin email, admin password (with a strength
meter), and public URL, then:

1. creates the admin (argon2id),
2. creates the default project **and** a default application placeholder, so the
   first dashboard visit has somewhere to land,
3. issues a session cookie and redirects to the dashboard,
4. **locks itself**: any later request to `/setup` → 404. Not a redirect, a 404 —
   a page that admits it exists is a target.

**B. Non-interactive (automation / IaC).** If `OBSERVE_ADMIN_EMAIL` and
`OBSERVE_ADMIN_PASSWORD` are set at boot, the admin is created (or the password
rotated) and `/setup` never appears. This is what a Helm chart or a Terraform
module does, and it makes the container boot deterministic.

**C. Invite.** An instance admin issues an invite for an email + instance role.
The invite is a URL (`/invite/<token>`) valid for 7 days, single use. The
intended role is bound server-side; the link carries no privilege in the URL
itself. No SMTP required: the admin copies the link. If SMTP *is* configured the
same invite is emailed, with the link as the fallback.

**D. Reopen registration.** Possible deliberately from Settings
(`registration: closed | invite | open`), defaulting to `invite`. `open` exists
for a trusted internal network and says so in the UI.

---

## 2. Setup checklist on the dashboard

First boot shows a dismissible **Getting started** panel, the way Coolify and
Plausible do. Steps are derived from real state, not stored flags:

- [ ] Point an application at the collector — shows the exact two env vars and
      the `OBSERVE_ENDPOINT` to use, with a copy button
- [ ] Send the first batch — ticks itself when `stats.batches > 0`
- [ ] Configure the public URL — needed for invite and CLI-link links to be right
- [ ] (optional) Configure SMTP for invites and alerts
- [ ] (optional) Set retention days per data class
- [ ] (optional) Turn off anonymous ingest once every app has a key

Every step links to the page that performs it. Nothing is a modal wall.

---

## 3. The CLI

The same binary, different argv. `nestjs-observe admin …` — because the
alternative is "SSH into the container and run SQL", and that is how self-hosted
products acquire a reputation.

```
nestjs-observe admin create-user --email --role --password-stdin
nestjs-observe admin reset-password --email [--password-stdin]
nestjs-observe admin invite --email --role
nestjs-observe admin list-users
nestjs-observe admin disable-registration
nestjs-observe admin set-setting <key> <json>
nestjs-observe admin migrate [--dry-run]      # apply migrations, print the plan
nestjs-observe admin prune [--dry-run]        # enforce retention now
nestjs-observe admin info                     # versions, counts, DB size, retention
nestjs-observe admin export > backup.json     # settings + users, not telemetry
```

Rule: **every operation the UI can perform on identity has a CLI equivalent.**
The reverse is not required.

---

## 4. Settings that only exist in a self-hosted product

| Setting | Default | Why it matters |
|---|---|---|
| `registration` | `invite` | `closed` \| `invite` \| `open` — the one switch every self-hoster looks for first |
| `publicUrl` | `http://localhost:4320` | invite links, CLI-link verification URI, webhook self-references |
| `trustProxy` | `false` | whether `X-Forwarded-*` is believed; getting this wrong breaks cookies or spoofs IPs |
| `secureCookies` | `auto` | `auto` = on when `publicUrl` is https |
| `anonymousIngest` | `true` | mirrors `OBSERVE_ALLOW_ANONYMOUS_INGEST`; the UI warns when it is on **and** the ingest port is public |
| `retention.{traces,logs,metrics,errors,runtime}` | keep forever | operator owns the disk, so the operator decides |
| `smtp` | unset | optional; enables email invites, new-error digest, alert email channel |
| `oidc` | unset | optional; issuer, client id/secret, allowed domains, auto-provision role |
| `telemetryOptOut` | `false` | we send **nothing**; documented so nobody has to wonder |

Settings live in one `instance_setting` table (key → jsonb) so a new option is a
row, not a migration. Environment variables win over the table for the four
bootstrap values (`publicUrl`, `anonymousIngest`, db URL, ports): env is what the
compose file sets, and it must not be silently overridden by a stale row.

---

## 5. Operations a self-hoster will actually perform

| Task | How |
|---|---|
| **Backup** | `pg_dump` of the one database. `admin export` covers settings/users for a machine-readable copy. Documented as a cron line, not a feature |
| **Restore** | restore the dump, boot, migrations are idempotent |
| **Upgrade** | pull the image/tarball, restart. Migrations run at boot unless `OBSERVE_RUN_MIGRATIONS=0`; supported from the previous two minor versions (`release-pipeline.md` §1) |
| **Downgrade** | refused, not attempted: the server checks the schema version and will not start on a schema newer than it understands |
| **Reset a password** | `admin reset-password` (or email, if SMTP is set) |
| **Add a colleague** | invite link; no mail relay needed |
| **Rotate an API key** | project → API keys → revoke; the agent's backoff means the app recovers within an hour, or immediately on restart |
| **Cap disk** | retention days per data class; `admin prune --dry-run` shows what would go |
| **Audit a change** | append-only `audit_log`: actor, action, target, before/after, IP |

---

## 6. What we deliberately do not build

- **No teams.** A tenant layer for a product with one tenant.
- **No public sign-up page.** The SaaS needs acquisition; a server needs access
  control.
- **No email as a requirement.** Nothing in the product may *require* SMTP; it
  only upgrades the experience.
- **No "account" concept.** There is an instance; you are a user in it.
- **No plans, seats, trials, invoices, usage meters, upgrade prompts** — already
  removed, and the schema has no place for them.
- **No telemetry phoning home.** Not even an anonymous ping.

---

## 7. Implementation order

| Step | Content |
|---|---|
| **1** | `instance_setting`, `invite`, `audit_log` tables; `app_credential` → project-scoped; job failures stop creating error groups; access levels become read/write/admin |
| **2** | `auth` module: `status`, `setup` (self-locking), `login`, `logout`, `me`, invites (issue/accept), session cookie with sha256-hashed token |
| **3** | `requireUser` / `requireRole` macros; guard every `/api/v1/*` route except `auth/status`, `auth/setup`, `auth/login`, `auth/invite/:token*` and `health` |
| **4** | CLI: `admin` subcommands (§3) |
| **5** | Web: `/setup`, `/login`, `/invite/:token`, getting-started panel, settings → access |
| **6** | Optional SMTP + OIDC; audit log surface |
