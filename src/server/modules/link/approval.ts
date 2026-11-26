/**
 * Link approval, on the dashboard API.
 *
 * The operator types the code the CLI printed. This is the only place a device
 * code becomes a credential, and it is authenticated.
 */
import { Elysia, t } from "elysia";
import type { Config } from "../../plugins/config";
import { configPlugin } from "../../plugins/config";
import type { Db } from "../../plugins/database";
import { databasePlugin } from "../../plugins/database";
import { Link } from "../link/service";

export const linkApprovalModule = (deps: { config: Config; db: Db }) =>
  new Elysia({ name: "link-approval", prefix: "/link" })
    .use(configPlugin(deps.config))
    .use(databasePlugin(deps.db))
    .get("/pending", async ({ db }) => ({ items: await Link.pending(db) }), {
      response: {
        200: t.Object({
          items: t.Array(
            t.Object({
              userCode: t.String(),
              applicationName: t.String(),
              hostname: t.Union([t.String(), t.Null()]),
              expiresAt: t.Number(),
              createdAt: t.Number(),
            }),
          ),
        }),
      },
      detail: { summary: "Links waiting for approval" },
    })
    .post(
      "/approve",
      async ({ db, body, status }) => {
        const approved = await Link.approve(db, {
          userCode: body.userCode,
          serviceId: body.serviceId,
        });
        if (!approved) {
          return status(404, "no pending link with that code");
        }
        return approved;
      },
      {
        body: t.Object({
          userCode: t.String({ minLength: 8, maxLength: 9 }),
          serviceId: t.Optional(t.String({ maxLength: 100 })),
        }),
        response: {
          200: t.Object({ applicationId: t.String(), userCode: t.String() }),
          404: t.String(),
        },
        detail: {
          summary: "Approve a device-code link",
          description:
            "Marks the link approved; the CLI's next poll mints the key pair. " +
            "The secret is generated then, so it is never stored in clear.",
        },
      },
    )
    .post(
      "/deny",
      async ({ db, body }) => ({ ok: await Link.deny(db, body.userCode) }),
      {
        body: t.Object({ userCode: t.String() }),
        detail: { summary: "Deny a device-code link" },
      },
    );
