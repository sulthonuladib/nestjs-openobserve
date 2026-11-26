/**
 * API keys — the credential lifecycle for the ingest endpoint.
 *
 * A key pair is minted in two places: the CLI device-code flow (`npx
 * @nestjs/observe link`), and here, by an admin who wants a key for a container
 * or a CI job without a terminal session. Both write the same `app_credential`
 * row, and ingest resolves it the same way (`Ingest.authenticate`): the key's
 * first 8 characters are the lookup index, the secret is compared against an
 * argon2id hash, and a revoked row stops working immediately.
 *
 * Three rules the shape of this module follows:
 *
 *   * **The secret is shown once.** It is hashed at issue time; there is no
 *     "reveal" and no way to recover it. The create response is the only
 *     response that carries it.
 *   * **Revoke, don't delete.** `revoked_at` is what ingest checks. A deleted
 *     row would silently succeed as "no credentials", which reads to the agent
 *     as anonymous ingest rather than as a rejected key.
 *   * **Keys belong to the project, not the application.** Upstream is explicit
 *     about this: any application whose telemetry should land in this project's
 *     dashboard uses the same key, and the application is resolved per batch
 *     from the `serviceId` the agent sends.
 */
import { Elysia, t } from "elysia";
import { desc, eq } from "drizzle-orm";
import type { Config } from "../../plugins/config";
import { configPlugin } from "../../plugins/config";
import type { Db } from "../../plugins/database";
import { databasePlugin } from "../../plugins/database";
import { authGuard } from "../../plugins/auth";
import { appCredential } from "../../db/schema";
import { Ingest, keyPrefix, sha256 } from "../ingest/service";
import { Auth } from "../auth/service";

const admin = { requireAdmin: true } as const;

/** 16 bytes of base64url is ~22 characters; 32 for the secret. */
function randomToken(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

/** Never returns a hash, a secret, or the full key — only what a list can show. */
function publicKey(row: typeof appCredential.$inferSelect) {
  return {
    id: row.id,
    keyPrefix: row.keyPrefix,
    label: row.label,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

export const credentialsModule = (deps: { config: Config; db: Db }) =>
  new Elysia({ name: "credentials", prefix: "/admin/credentials" })
    .use(configPlugin(deps.config))
    .use(databasePlugin(deps.db))
    .use(authGuard(deps))

    .get(
      "/",
      async ({ db }) => {
        const rows = await db
          .select()
          .from(appCredential)
          .orderBy(desc(appCredential.createdAt))
          .limit(200);
        return {
          items: rows.map(publicKey),
          // Why the same key links several applications: it is project-scoped,
          // and the app is resolved from the batch's `serviceId`. The page says
          // it once instead of explaining it per row.
          scope: "project" as const,
        };
      },
      {
        ...admin,
        detail: {
          summary: "Ingest credentials (never the secret)",
          description:
            "Prefixes only. The secret is hashed at issue time and cannot be " +
            "recovered — rotate by creating a new key and revoking the old one.",
        },
      },
    )

    .post(
      "/",
      async ({ db, body, user }) => {
        const appKey = `obs_${randomToken(16)}`;
        const appSecret = randomToken(32);
        const id = Bun.randomUUIDv7();
        await db.insert(appCredential).values({
          id,
          projectId: await Ingest.ensureDefaultProject(db),
          keyPrefix: keyPrefix(appKey),
          keyHash: await sha256(appKey),
          secretHash: await Ingest.hashSecret(appSecret),
          label: body.label?.trim() || "Dashboard",
          createdAt: Date.now(),
        });
        await Auth.audit(db, {
          actorId: user.id,
          actorEmail: user.email,
          action: "credentials.create",
          target: id,
          detail: { label: body.label ?? null },
        });
        // The one time the pair is visible. `Ingest.authenticate` hashes the key
        // the same way, so this exact pair is what an agent must be given.
        return { id, appKey, appSecret, keyPrefix: keyPrefix(appKey) };
      },
      {
        ...admin,
        body: t.Object({ label: t.Optional(t.String({ maxLength: 120 })) }),
        detail: {
          summary: "Mint an ingest key pair (the secret is returned once)",
        },
      },
    )

    .delete(
      "/:id",
      async ({ db, params, user, status }) => {
        const rows = await db
          .select({ id: appCredential.id, revokedAt: appCredential.revokedAt })
          .from(appCredential)
          .where(eq(appCredential.id, params.id))
          .limit(1);
        const row = rows[0];
        if (!row) return status(404, "no such credential");
        // Revoked, not deleted: an agent that keeps sending a revoked key gets a
        // 401 it can report, instead of silently falling back to anonymous ingest.
        if (row.revokedAt === null) {
          await db
            .update(appCredential)
            .set({ revokedAt: Date.now() })
            .where(eq(appCredential.id, params.id));
          await Auth.audit(db, {
            actorId: user.id,
            actorEmail: user.email,
            action: "credentials.revoke",
            target: params.id,
          });
        }
        return { revoked: true };
      },
      {
        ...admin,
        params: t.Object({ id: t.String() }),
        detail: { summary: "Revoke an ingest key (kept, not deleted, so a replay is rejected)" },
      },
    );
