/**
 * Session authentication, as Elysia macros.
 *
 * A macro rather than middleware so the requirement is visible on the route and
 * typed: a handler that declares `requireUser: true` gets `user` in its context,
 * and one that does not gets a compile error when it reads it. Middleware would
 * make the requirement invisible at the call site and unenforceable by types.
 *
 * Two levels, matching `docs/SELF-HOSTED.md` §1:
 *   requireUser   any signed-in user (read/write/admin)
 *   requireAdmin  an instance admin
 */
import { Elysia } from "elysia";
import type { Config } from "./config";
import type { Db } from "./database";
import { databasePlugin } from "./database";
import { Auth, AuthError, SESSION_COOKIE, type SessionUser } from "../modules/auth/service";

export type CtxUser = SessionUser;

function readSessionToken(cookie: Record<string, { value?: unknown } | undefined>): string | undefined {
  const value = cookie[SESSION_COOKIE]?.value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const authGuard = (deps: { db: Db; config: Config }) =>
  new Elysia({ name: "auth-guard" })
    .use(databasePlugin(deps.db))
    .onError(({ error, set }) => {
      if (error instanceof AuthError) {
        set.status = error.status;
        return { message: error.message };
      }
    })
    .macro({
      requireUser: {
        async resolve({ cookie, status }) {
          const user = await Auth.fromToken(deps.db, readSessionToken(cookie));
          if (!user) return status(401, "not signed in");
          return { user };
        },
      },
      requireAdmin: {
        async resolve({ cookie, status }) {
          const user = await Auth.fromToken(deps.db, readSessionToken(cookie));
          if (!user) return status(401, "not signed in");
          if (user.role !== "admin") return status(403, "administrator role required");
          return { user };
        },
      },
    });
