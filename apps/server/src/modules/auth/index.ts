/**
 * Auth controller.
 *
 * The only routes reachable without a session, and each for a reason:
 *   GET  /auth/status          the SPA must know whether to show /setup or /login
 *   POST /auth/setup           works only while no user exists; then 409s forever
 *   POST /auth/login
 *   GET  /auth/invite/:token   what the invite page shows before you accept
 *   POST /auth/invite/:token   accepts it
 *
 * Everything else in `/api/v1` goes through the `requireUser` macro (see
 * `plugins/auth.ts`), which the module's parent applies with `.guard()`.
 */
import { Elysia, t } from "elysia";
import type { Config } from "../../plugins/config";
import { configPlugin } from "../../plugins/config";
import type { Db } from "../../plugins/database";
import { databasePlugin } from "../../plugins/database";
import { Auth, AuthError, SESSION_COOKIE } from "./service";

const Credentials = t.Object({
  email: t.String({ format: "email", maxLength: 254 }),
  password: t.String({ minLength: 1, maxLength: 256 }),
});

function cookieOptions(config: Config) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // `auto`: secure whenever the public URL is https. A reverse proxy that
    // terminates TLS makes the browser's view https while the server's is not,
    // so this is derived from configuration rather than the request.
    secure: config.publicUrl.startsWith("https://"),
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  };
}

export const authModule = (deps: { config: Config; db: Db }) =>
  new Elysia({ name: "auth", prefix: "/auth" })
    .use(configPlugin(deps.config))
    .use(databasePlugin(deps.db))
    .onError(({ error, set }) => {
      if (error instanceof AuthError) {
        set.status = error.status;
        return { message: error.message };
      }
    })

    /** Drives the SPA's first screen: setup wizard, login, or the app. */
    .get(
      "/status",
      async ({ db }) => ({
        setupRequired: await Auth.setupRequired(db),
        registration: await Auth.registrationMode(db),
        instanceName: await Auth.getSetting(db, "instanceName", "Observe"),
      }),
      {
        // An explicit response schema, so the SPA's inferred client knows the
        // 200 shape and does not have to union it with the error body.
        response: {
          200: t.Object({
            setupRequired: t.Boolean(),
            registration: t.Union([
              t.Literal("closed"),
              t.Literal("invite"),
              t.Literal("open"),
            ]),
            instanceName: t.String(),
          }),
        },
        detail: { summary: "Whether the instance is set up, and how people join" },
      },
    )

    .post(
      "/setup",
      async ({ db, body, cookie, request, set }) => {
        const { token, user } = await Auth.setup(
          db,
          {
            email: body.email,
            password: body.password,
            name: body.name,
            instanceName: body.instanceName,
          },
          {
            ip: clientIp(request),
            userAgent: request.headers.get("user-agent") ?? undefined,
          },
        );
        cookie[SESSION_COOKIE]!.set({ value: token, ...cookieOptions(deps.config) });
        set.status = 201;
        return { user };
      },
      {
        body: t.Object({
          email: t.String({ format: "email", maxLength: 254 }),
          password: t.String({ minLength: 10, maxLength: 256 }),
          name: t.Optional(t.String({ maxLength: 120 })),
          instanceName: t.Optional(t.String({ maxLength: 120 })),
        }),
        detail: {
          summary: "First-run setup",
          description:
            "Creates the instance admin. Works only while no user exists; " +
            "afterwards it answers 409 forever, and /setup is not even served.",
        },
      },
    )

    .post(
      "/login",
      async ({ db, body, cookie, request }) => {
        const { token, user } = await Auth.login(db, body, {
          ip: clientIp(request),
          userAgent: request.headers.get("user-agent") ?? undefined,
        });
        cookie[SESSION_COOKIE]!.set({ value: token, ...cookieOptions(deps.config) });
        return { user };
      },
      { body: Credentials, detail: { summary: "Sign in" } },
    )

    .post(
      "/logout",
      async ({ db, cookie }) => {
        // The cookie is untyped here (no schema), so its value is `unknown`.
        const current = cookie[SESSION_COOKIE]?.value;
        await Auth.logout(db, typeof current === "string" ? current : undefined);
        cookie[SESSION_COOKIE]!.remove();
        return { ok: true };
      },
      { detail: { summary: "Sign out of this browser" } },
    )

    .get(
      "/invite/:token",
      async ({ db, params, status }) => {
        const inviteInfo = await Auth.describeInvite(db, params.token);
        if (!inviteInfo) return status(404, "this invite is no longer valid");
        return inviteInfo;
      },
      {
        params: t.Object({ token: t.String() }),
        response: {
          200: t.Object({
            email: t.String(),
            role: t.Union([t.Literal("read"), t.Literal("write"), t.Literal("admin")]),
            expiresAt: t.Number(),
          }),
          404: t.String(),
        },
        detail: { summary: "Describe an invite before accepting it" },
      },
    )

    .post(
      "/invite/:token",
      async ({ db, params, body, cookie, request, set }) => {
        const { token, user } = await Auth.acceptInvite(
          db,
          params.token,
          { password: body.password, name: body.name },
          { userAgent: request.headers.get("user-agent") ?? undefined },
        );
        cookie[SESSION_COOKIE]!.set({ value: token, ...cookieOptions(deps.config) });
        set.status = 201;
        return { user };
      },
      {
        params: t.Object({ token: t.String() }),
        body: t.Object({
          password: t.String({ minLength: 10, maxLength: 256 }),
          name: t.Optional(t.String({ maxLength: 120 })),
        }),
        detail: {
          summary: "Accept an invite",
          description:
            "Creates the account with the role bound to the invite on the " +
            "server — the URL carries no privilege of its own.",
        },
      },
    );

/**
 * Client IP, honouring `X-Forwarded-For` only when the deployment says to.
 * Believing it unconditionally lets any caller forge the address in the audit
 * log, which is worse than writing "unknown".
 */
export function clientIp(request: Request): string | undefined {
  if (process.env.OBSERVE_TRUST_PROXY === "1") {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0]?.trim();
  }
  return undefined;
}
