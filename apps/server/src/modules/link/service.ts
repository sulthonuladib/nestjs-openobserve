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

export interface PollResult {
  status: number;
  body: { appKey: string; appSecret: string } | { error: LinkError };
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
      verificationUri: `${config.publicUrl}/dashboard/link`,
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

    const appKey = `obs_${randomToken(16)}`;
    const appSecret = randomToken(32);

    await db.insert(appCredential).values({
      id: Bun.randomUUIDv7(),
      applicationId: session.applicationId,
      keyPrefix: keyPrefix(appKey),
      keyHash: await sha256(appKey),
      secretHash: await Ingest.hashSecret(appSecret),
      label: session.hostname ?? "cli",
      createdAt: Date.now(),
    });

    await db
      .update(cliLinkSession)
      .set({ status: "claimed" })
      .where(eq(cliLinkSession.id, session.id));

    return { status: 200, body: { appKey, appSecret } };
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

    const serviceId = (input.serviceId ?? session.applicationName).slice(0, 100);
    const projectId = session.projectId ?? (await Ingest.ensureDefaultProject(db));

    const existing = (
      await db
        .select({ id: application.id })
        .from(application)
        .where(
          and(eq(application.projectId, projectId), eq(application.serviceId, serviceId)),
        )
        .limit(1)
    )[0];

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

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}
