/**
 * `/cli-link` on the ingest listener — the endpoints the SDK's CLI calls.
 *
 * Mounted next to ingest, not under `/api/v1`, because `endpoint` is a single
 * base URL for the agent, the profiler and the CLI alike.
 */
import { Elysia, t } from "elysia";
import type { Config } from "../../plugins/config";
import { configPlugin } from "../../plugins/config";
import type { Db } from "../../plugins/database";
import { databasePlugin } from "../../plugins/database";
import { Link } from "./service";

export const cliLinkModule = (deps: { config: Config; db: Db }) =>
  new Elysia({ name: "cli-link", prefix: "/cli-link" })
    .use(configPlugin(deps.config))
    .use(databasePlugin(deps.db))
    .post(
      "/sessions",
      ({ db, config, body }) =>
        Link.start(db, config, {
          applicationName: body.applicationName,
          hostname: body.hostname ?? null,
        }),
      {
        body: t.Object({
          applicationName: t.String({ minLength: 1, maxLength: 100 }),
          hostname: t.Optional(t.Union([t.String(), t.Null()])),
        }),
        response: {
          200: t.Object({
            deviceCode: t.String(),
            userCode: t.String(),
            verificationUri: t.String(),
            expiresIn: t.Number(),
            interval: t.Number(),
          }),
        },
        detail: {
          summary: "Start a device-code link",
          description:
            "Called by `npx @nestjs/observe link`. Returns the code the operator " +
            "types into the dashboard, plus the poll interval.",
        },
      },
    )
    .post(
      "/token",
      async ({ db, body, set }) => {
        const result = await Link.poll(db, body.deviceCode);
        set.status = result.status;
        return result.body;
      },
      {
        body: t.Object({ deviceCode: t.String() }),
        detail: {
          summary: "Poll a device-code link",
          description:
            "Answers { appKey, appSecret } once, or an RFC 8628 error: " +
            "authorization_pending, slow_down, access_denied, expired_token.",
        },
      },
    );
