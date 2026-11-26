/**
 * The `/cli-link` device-code flow — the half that makes
 * `npx @nestjs/observe link` work against a self-hosted collector.
 *
 * Two surfaces, deliberately on different listeners:
 *   - `/cli-link/sessions` and `/cli-link/token` live on the **ingest** app,
 *     because that is where the SDK's CLI points (`endpoint` is one base URL).
 *   - `/api/v1/link/*` lives on the **dashboard** API, because approving a link
 *     is an authenticated human action.
 *
 * The credential is minted at the first poll after approval, never at approval:
 * that way no plaintext secret is ever stored, and the single response that
 * carries it is the only place it exists — which is exactly the "shown once,
 * not retrievable afterwards" behaviour the SDK documents.
 */
import { and, eq } from "drizzle-orm";
import type { Config } from "../../plugins/config";
import type { Db } from "../../plugins/database";
import {
  application,
  appCredential,
  cliLinkSession,
  project,
} from "../../db/schema";
import { Ingest, keyPrefix } from "../ingest/service";

const EXPIRES_IN_SECONDS = 600;
const POLL_INTERVAL_SECONDS = 5;

/** Ambiguous characters are dropped: this code gets read aloud and retyped. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function userCode(): string {
  const pick = () =>
    Array.from(
      { length: 4 },
      () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)],
    ).join("");
  return `${pick()}-${pick()}`;
}

function randomToken(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

export interface StartedLink {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type LinkError =
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token";

/**
 * What the CLI reads off a successful poll.
 *
 * `projectName` and `applicationName` are not decoration: the CLI prints them
 * and, more importantly, derives the `serviceId` it wires into `app.module.ts`
 * from `applicationName` (`repos/observe/src/cli/link.ts:147,198`,
 * `serviceIdFor` at `project-setup.ts:307-320`). Omitting them does not fail
 * the link — it wires `serviceId: undefined` and the agent's telemetry then
 * creates a second application row. The ids are extra, for the dashboard.
 */
export interface IssuedCredentials {
  appKey: string;
  appSecret: string;
  projectId: string;
  projectName: string;
  applicationId: string;
  applicationName: string;
}

export interface PollResult {
  status: number;
  body: IssuedCredentials | { error: LinkError };
}

/**
 * The SDK's `serviceIdFor`, ported — deliberately, not imported.
 *
 * `repos/` is read-only reference material and must not become a runtime
 * dependency (`AGENTS.md`). Keeping the algorithm identical matters: the CLI
 * slugs the `applicationName` we return and writes the result as the SDK's
 * `serviceId`, so if we stored a different string on the `application` row the
 * first batch would create a duplicate application instead of updating this one.
 * `"@acme/Cats API"` → `"cats-api"`; no usable characters → `"app"`.
 */
export function serviceIdFor(...names: Array<string | undefined>): string {
  for (const name of names) {
    const id = (name ?? "")
      .replace(/^@[^/]+\//, "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/[^a-z0-9-]/g, "");
    if (id) return id;
  }
  return "app";
}

export abstract class Link {
  static async start(
    db: Db,
    config: Config,
    input: { applicationName: string; hostname: string | null },
  ): Promise<StartedLink> {
    const now = Date.now();
    const projectId = await Ingest.ensureDefaultProject(db);

    const row = {
      id: Bun.randomUUIDv7(),
      deviceCode: randomToken(24),
      userCode: userCode(),
      applicationName: input.applicationName.slice(0, 100),
      hostname: input.hostname?.slice(0, 255) ?? null,
      projectId,
      status: "pending" as const,
      intervalS: POLL_INTERVAL_SECONDS,
      expiresAt: now + EXPIRES_IN_SECONDS * 1000,
      createdAt: now,
    };
    await db.insert(cliLinkSession).values(row);

    return {
      deviceCode: row.deviceCode,
      userCode: row.userCode,
      // The page the operator opens. It deliberately does not carry the code: a
      // link that approves itself is not a confirmation.
      //
      // **Path, not fragment.** The dashboard is a `BrowserRouter` app whose
      // `/link` route is served by the SPA fallback in `app.ts`; a `/#/link`
      // URI boots the shell at `/` and the operator lands on the overview with
      // no way to type the code. The CLI prints this string verbatim, so it has
      // to be the address a person can retype.
      verificationUri: `${config.publicUrl.replace(/\/$/, "")}/link`,
      expiresIn: EXPIRES_IN_SECONDS,
      interval: POLL_INTERVAL_SECONDS,
    };
  }

  static async poll(db: Db, deviceCode: string): Promise<PollResult> {
    const session = (
      await db
        .select()
        .from(cliLinkSession)
        .where(eq(cliLinkSession.deviceCode, deviceCode))
        .limit(1)
    )[0];

    if (!session) return { status: 404, body: { error: "expired_token" } };
    if (Date.now() > session.expiresAt) {
      return { status: 400, body: { error: "expired_token" } };
    }
    if (session.status === "denied") {
      return { status: 400, body: { error: "access_denied" } };
    }
    if (session.status === "pending") {
      return { status: 400, body: { error: "authorization_pending" } };
    }
    if (session.status === "claimed") {
      // Single use: the secret was handed out once and cannot be recovered.
      return { status: 400, body: { error: "expired_token" } };
    }
    if (!session.applicationId) {
      return { status: 400, body: { error: "expired_token" } };
    }

    const linked = (
      await db
        .select({
          applicationId: application.id,
          applicationName: application.name,
          serviceId: application.serviceId,
          projectId: project.id,
          projectName: project.name,
        })
        .from(application)
        .innerJoin(project, eq(project.id, application.projectId))
        .where(eq(application.id, session.applicationId))
        .limit(1)
    )[0];
    if (!linked) return { status: 400, body: { error: "expired_token" } };

    const appKey = `obs_${randomToken(16)}`;
    const appSecret = randomToken(32);

    await db.insert(appCredential).values({
      id: Bun.randomUUIDv7(),
      // Keys belong to the project; the application is implied by the key the
      // CLI writes into the app's `.env`, and resolved per batch from serviceId.
      projectId: session.projectId ?? (await Ingest.ensureDefaultProject(db)),
      keyPrefix: keyPrefix(appKey),
      keyHash: await sha256(appKey),
      secretHash: await Ingest.hashSecret(appSecret),
      // The upstream docs: a linked key is listed as "CLI" plus when it was
      // issued. The hostname is what the approval page showed, so keep it as
      // the label's second half rather than inventing a date format here.
      label: `CLI · ${session.hostname ?? "unknown host"}`,
      createdAt: Date.now(),
    });

    await db
      .update(cliLinkSession)
      .set({ status: "claimed" })
      .where(eq(cliLinkSession.id, session.id));

    return {
      status: 200,
      body: {
        appKey,
        appSecret,
        projectId: linked.projectId,
        projectName: linked.projectName,
        applicationId: linked.applicationId,
        // The CLI slugs this string to get the `serviceId` it wires. Return the
        // display name when it slugs back to the stored `serviceId` (the normal
        // case); otherwise return the id itself, which is already canonical.
        applicationName:
          serviceIdFor(linked.applicationName ?? linked.serviceId) === linked.serviceId
            ? (linked.applicationName ?? linked.serviceId)
            : linked.serviceId,
      },
    };
  }

  /**
   * Approves a pending link. The dashboard shows the code the CLI printed and
   * the operator types it in — that is the whole security property of the flow.
   */
  static async approve(
    db: Db,
    input: { userCode: string; serviceId?: string },
  ): Promise<{ applicationId: string; userCode: string } | null> {
    const now = Date.now();
    const session = (
      await db
        .select()
        .from(cliLinkSession)
        .where(
          and(
            eq(cliLinkSession.userCode, input.userCode.trim().toUpperCase()),
            eq(cliLinkSession.status, "pending"),
          ),
        )
        .limit(1)
    )[0];

    if (!session || now > session.expiresAt) return null;

    // The identifier the agent will send is the SDK's slug of the application
    // name, never the raw package name: `@acme/orders` reports `orders`. Store
    // that exact string, or the first batch after the link creates a second
    // application row (`ensureApplication` looks up by `serviceId`).
    const serviceId = serviceIdFor(input.serviceId, session.applicationName).slice(0, 100);
    const projectId = session.projectId ?? (await Ingest.ensureDefaultProject(db));

    const existing = await findApplication(db, projectId, serviceId, session.applicationName);

    const applicationId =
      existing?.id ??
      (await (async () => {
        const id = Bun.randomUUIDv7();
        await db.insert(application).values({
          id,
          projectId,
          serviceId,
          name: session.applicationName,
          firstSeen: now,
          lastSeen: now,
        });
        return id;
      })());

    if (existing && existing.name === null) {
      await db
        .update(application)
        .set({ name: session.applicationName, lastSeen: now })
        .where(eq(application.id, existing.id));
    }

    await db
      .update(cliLinkSession)
      .set({ status: "approved", approvedAt: now, applicationId })
      .where(eq(cliLinkSession.id, session.id));

    return { applicationId, userCode: session.userCode };
  }

  static async deny(db: Db, userCode: string): Promise<boolean> {
    const rows = await db
      .update(cliLinkSession)
      .set({ status: "denied" })
      .where(
        and(
          eq(cliLinkSession.userCode, userCode.trim().toUpperCase()),
          eq(cliLinkSession.status, "pending"),
        ),
      )
      .returning({ id: cliLinkSession.id });
    return rows.length > 0;
  }

  /**
   * Live links for the dashboard. `deviceCode` is deliberately not selected:
   * it is the polling secret, and only the machine that started the flow has
   * any use for it.
   */
  static async pending(db: Db) {
    return db
      .select({
        userCode: cliLinkSession.userCode,
        applicationName: cliLinkSession.applicationName,
        hostname: cliLinkSession.hostname,
        expiresAt: cliLinkSession.expiresAt,
        createdAt: cliLinkSession.createdAt,
      })
      .from(cliLinkSession)
      .where(eq(cliLinkSession.status, "pending"))
      .orderBy(cliLinkSession.createdAt)
      .limit(50);
  }
}

/**
 * The application a link targets: the one with the canonical `serviceId`, or a
 * row an earlier version of this flow created with the raw package name (so an
 * upgrade does not split one app in two). The legacy row is renamed in place.
 */
async function findApplication(
  db: Db,
  projectId: string,
  serviceId: string,
  applicationName: string,
): Promise<{ id: string; name: string | null } | undefined> {
  const rows = await db
    .select({ id: application.id, name: application.name })
    .from(application)
    .where(and(eq(application.projectId, projectId), eq(application.serviceId, serviceId)))
    .limit(1);
  if (rows[0]) return rows[0];

  const raw = applicationName.slice(0, 100);
  if (raw === serviceId || serviceIdFor(raw) !== serviceId) return undefined;

  const legacy = (
    await db
      .select({ id: application.id, name: application.name })
      .from(application)
      .where(and(eq(application.projectId, projectId), eq(application.serviceId, raw)))
      .limit(1)
  )[0];
  if (!legacy) return undefined;

  await db
    .update(application)
    .set({ serviceId })
    .where(eq(application.id, legacy.id));
  return legacy;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}
