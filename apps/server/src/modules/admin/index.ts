/**
 * Instance administration: users, invites, settings, audit.
 *
 * Every route here requires an instance admin. The CLI (`nestjs-openobserve admin …`)
 * performs the same operations for the day the UI is unreachable — see
 * `docs/SELF-HOSTED.md` §3. Neither is a superset of the other by accident.
 *
 * Route shape is `.method(path, handler, options)` — Elysia 1.4's signature.
 */
import { Elysia, t } from "elysia";
import { desc, eq } from "drizzle-orm";
import type { Config } from "../../plugins/config";
import { configPlugin } from "../../plugins/config";
import type { Db } from "../../plugins/database";
import { databasePlugin } from "../../plugins/database";
import { authGuard } from "../../plugins/auth";
import { auditLog, instanceSetting, invite } from "../../db/schema";
import { Auth, type Role } from "../auth/service";

const RoleSchema = t.Union([t.Literal("read"), t.Literal("write"), t.Literal("admin")]);

/** Declared on every route so `user` is typed; the parent guard enforces it too. */
const admin = { requireAdmin: true } as const;

export const adminModule = (deps: { config: Config; db: Db }) =>
  new Elysia({ name: "admin", prefix: "/admin" })
    .use(configPlugin(deps.config))
    .use(databasePlugin(deps.db))
    .use(authGuard(deps))

    // --- settings --------------------------------------------------------
    .get(
      "/settings",
      async ({ db }) => {
        const rows = await db.select().from(instanceSetting).orderBy(instanceSetting.key);
        return {
          settings: Object.fromEntries(rows.map((row) => [row.key, row.value])),
          // Effective values, so the UI does not have to know every default.
          effective: {
            registration: await Auth.registrationMode(db),
            instanceName: await Auth.getSetting(db, "instanceName", "Observe"),
            publicUrl: deps.config.publicUrl,
            anonymousIngest: deps.config.allowAnonymousIngest,
            trustProxy: process.env.OBSERVE_TRUST_PROXY === "1",
          },
        };
      },
      admin,
    )

    .patch(
      "/settings",
      async ({ db, body, user }) => {
        for (const [key, value] of Object.entries(body)) {
          await Auth.setSetting(db, key, value as unknown, user.id);
        }
        await Auth.audit(db, {
          actorId: user.id,
          actorEmail: user.email,
          action: "settings.update",
          detail: body,
        });
        return { ok: true };
      },
      {
        ...admin,
        body: t.Record(t.String(), t.Unknown()),
        detail: {
          summary: "Update instance settings",
          description:
            "Keys are free-form rows in `instance_setting`, so a new option is " +
            "not a migration. Bootstrap values (database URL, ports, public URL) " +
            "come from the environment and cannot be overridden here.",
        },
      },
    )

    // --- users -----------------------------------------------------------
    .get("/users", ({ db }) => Auth.listUsers(db).then((items) => ({ items })), admin)

    .patch(
      "/users/:id",
      async ({ db, params, body, user }) => {
        if (body.role !== "admin") await Auth.assertNotLastAdmin(db, params.id);
        await Auth.setRole(db, params.id, body.role);
        await Auth.audit(db, {
          actorId: user.id,
          actorEmail: user.email,
          action: "user.set-role",
          target: params.id,
          detail: { role: body.role },
        });
        return { ok: true };
      },
      {
        ...admin,
        params: t.Object({ id: t.String() }),
        body: t.Object({ role: RoleSchema }),
        detail: { summary: "Change a user's instance role" },
      },
    )

    // --- invites ---------------------------------------------------------
    .post(
      "/invites",
      async ({ db, body, user }) => {
        const { token, expiresAt } = await Auth.issueInvite(db, {
          email: body.email,
          role: body.role,
          invitedBy: user.id,
        });
        return {
          token,
          // The link is the payload: no SMTP is needed to add a colleague. If
          // SMTP is configured it is also emailed, with this as the fallback.
          url: `${deps.config.publicUrl}/invite/${token}`,
          expiresAt,
        };
      },
      {
        ...admin,
        body: t.Object({
          email: t.String({ format: "email", maxLength: 254 }),
          role: RoleSchema,
        }),
        detail: {
          summary: "Issue an invite",
          description:
            "Single use, seven days. The role is bound on the server; the URL " +
            "carries no privilege of its own.",
        },
      },
    )

    .get(
      "/invites",
      ({ db }) =>
        db
          .select()
          .from(invite)
          .orderBy(desc(invite.createdAt))
          .limit(100)
          .then((items) => ({ items })),
      admin,
    )

    .delete(
      "/invites/:id",
      async ({ db, params }) => {
        await db.delete(invite).where(eq(invite.id, params.id));
        return { ok: true };
      },
      { ...admin, params: t.Object({ id: t.String() }), detail: { summary: "Revoke an invite" } },
    )

    // --- audit -----------------------------------------------------------
    .get(
      "/audit",
      ({ db, query }) =>
        db
          .select()
          .from(auditLog)
          .orderBy(desc(auditLog.at))
          .limit(Math.min(query.limit ?? 100, 500))
          .then((items) => ({ items })),
      { ...admin, query: t.Object({ limit: t.Optional(t.Numeric()) }) },
    );

export type { Role };
