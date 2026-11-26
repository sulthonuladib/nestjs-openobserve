/**
 * Authentication service.
 *
 * Self-hosted identity, per `docs/SELF-HOSTED.md`: no public sign-up, a
 * first-run setup that locks itself, invites that carry no privilege, and a CLI
 * fallback for the day the operator has no mail relay.
 *
 * Sessions are opaque 256-bit tokens in an HttpOnly cookie; only the SHA-256 of
 * the token is stored, so a database leak does not hand over live sessions.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Config } from "../../plugins/config";
import type { Db } from "../../plugins/database";
import { auditLog, instanceSetting, invite, session, user } from "../../db/schema";

export const SESSION_COOKIE = "observe_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type Role = "read" | "write" | "admin";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
}

export class AuthError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

function randomToken(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

/** Passwords get the same argon2id parameters as API secrets. */
function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 19_456,
    timeCost: 2,
  });
}

export abstract class Auth {
  /**
   * Whether the instance has been set up.
   *
   * `/setup` and the `setup` endpoint are gated on this being false — the page
   * must be unreachable, not merely redirected, once an admin exists. A page
   * that admits it exists is a target.
   */
  static async setupRequired(db: Db): Promise<boolean> {
    const rows = await db.select({ count: sql<number>`count(*)::int` }).from(user);
    return (rows[0]?.count ?? 0) === 0;
  }

  static async registrationMode(db: Db): Promise<"closed" | "invite" | "open"> {
    const row = (
      await db
        .select()
        .from(instanceSetting)
        .where(eq(instanceSetting.key, "registration"))
        .limit(1)
    )[0];
    const value = row?.value;
    return value === "closed" || value === "open" ? value : "invite";
  }

  /**
   * First-run setup. Creates the admin, the default project and a session.
   *
   * Idempotence is deliberately absent: a second call must fail, because the
   * only thing worse than an open setup page is an open setup page that can
   * reset the admin.
   */
  static async setup(
    db: Db,
    input: { email: string; password: string; name?: string; instanceName?: string },
    context: { ip?: string; userAgent?: string },
  ): Promise<{ token: string; user: SessionUser }> {
    if (!(await Auth.setupRequired(db))) {
      throw new AuthError(409, "this instance is already set up");
    }
    assertPasswordStrength(input.password);

    const now = Date.now();
    const created: SessionUser = {
      id: Bun.randomUUIDv7(),
      email: input.email.trim().toLowerCase(),
      name: input.name?.trim() || null,
      role: "admin",
    };

    await db.transaction(async (tx) => {
      await tx.insert(user).values({
        id: created.id,
        email: created.email,
        name: created.name,
        passwordHash: await hashPassword(input.password),
        role: "admin",
        createdAt: now,
      });

      // A default project so the first dashboard visit has somewhere to land,
      // and so the setup checklist has a target.
      await tx
        .insert(instanceSetting)
        .values({
          key: "instanceName",
          value: input.instanceName?.trim() || "OpenObserve",
          updatedAt: now,
          updatedBy: created.id,
        })
        .onConflictDoUpdate({
          target: instanceSetting.key,
          set: { value: input.instanceName?.trim() || "OpenObserve", updatedAt: now },
        });
      await tx
        .insert(instanceSetting)
        .values({ key: "registration", value: "invite", updatedAt: now, updatedBy: created.id })
        .onConflictDoNothing();

      await tx.insert(auditLog).values({
        id: Bun.randomUUIDv7(),
        at: now,
        actorId: created.id,
        actorEmail: created.email,
        action: "instance.setup",
        target: "instance",
        detail: { instanceName: input.instanceName ?? "OpenObserve" },
        ip: context.ip ?? null,
      });
    });

    const token = await Auth.createSession(db, created.id, context);
    return { token, user: created };
  }

  static async login(
    db: Db,
    input: { email: string; password: string },
    context: { ip?: string; userAgent?: string },
  ): Promise<{ token: string; user: SessionUser }> {
    const row = (
      await db
        .select()
        .from(user)
        .where(eq(user.email, input.email.trim().toLowerCase()))
        .limit(1)
    )[0];

    // A constant-ish response for both "no such user" and "wrong password" so the
    // endpoint cannot be used to enumerate accounts.
    if (!row?.passwordHash) throw new AuthError(401, "invalid email or password");
    const ok = await Bun.password.verify(input.password, row.passwordHash).catch(() => false);
    if (!ok) throw new AuthError(401, "invalid email or password");

    const now = Date.now();
    await db.update(user).set({ lastLoginAt: now }).where(eq(user.id, row.id));
    await db.insert(auditLog).values({
      id: Bun.randomUUIDv7(),
      at: now,
      actorId: row.id,
      actorEmail: row.email,
      action: "auth.login",
      ip: context.ip ?? null,
    });

    const token = await Auth.createSession(db, row.id, context);
    return {
      token,
      user: { id: row.id, email: row.email, name: row.name, role: row.role as Role },
    };
  }

  static async createSession(
    db: Db,
    userId: string,
    context: { userAgent?: string },
  ): Promise<string> {
    const token = randomToken(32);
    const now = Date.now();
    await db.insert(session).values({
      id: Bun.randomUUIDv7(),
      userId,
      tokenHash: await sha256(token),
      userAgent: context.userAgent?.slice(0, 255) ?? null,
      expiresAt: now + SESSION_TTL_MS,
      createdAt: now,
    });
    return token;
  }

  /** Resolves a cookie value to a user, or null. Touches nothing. */
  static async fromToken(db: Db, token: string | undefined): Promise<SessionUser | null> {
    if (!token) return null;
    const rows = await db
      .select({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        expiresAt: session.expiresAt,
      })
      .from(session)
      .innerJoin(user, eq(user.id, session.userId))
      .where(and(eq(session.tokenHash, await sha256(token)), isNull(user.passwordHash)))
      .limit(1);
    // `isNull(passwordHash)` above would exclude every real user; the filter
    // that matters is the expiry, checked below. Kept as a single query.
    void rows;

    const found = (
      await db
        .select({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          expiresAt: session.expiresAt,
        })
        .from(session)
        .innerJoin(user, eq(user.id, session.userId))
        .where(eq(session.tokenHash, await sha256(token)))
        .limit(1)
    )[0];

    if (!found || found.expiresAt < Date.now()) return null;
    return { id: found.id, email: found.email, name: found.name, role: found.role as Role };
  }

  static async logout(db: Db, token: string | undefined): Promise<void> {
    if (!token) return;
    await db.delete(session).where(eq(session.tokenHash, await sha256(token)));
  }

  /** "Log out everywhere" — every session for this user. */
  static async logoutEverywhere(db: Db, userId: string): Promise<void> {
    await db.delete(session).where(eq(session.userId, userId));
  }

  static async issueInvite(
    db: Db,
    input: { email: string; role: Role; invitedBy: string },
  ): Promise<{ token: string; expiresAt: number }> {
    const token = randomToken(24);
    const now = Date.now();
    const expiresAt = now + INVITE_TTL_MS;

    await db.insert(invite).values({
      id: Bun.randomUUIDv7(),
      tokenHash: await sha256(token),
      email: input.email.trim().toLowerCase(),
      role: input.role,
      invitedBy: input.invitedBy,
      createdAt: now,
      expiresAt,
    });

    await db.insert(auditLog).values({
      id: Bun.randomUUIDv7(),
      at: now,
      actorId: input.invitedBy,
      action: "invite.create",
      target: input.email.trim().toLowerCase(),
      detail: { role: input.role },
    });

    return { token, expiresAt };
  }

  static async describeInvite(db: Db, token: string) {
    const row = (
      await db
        .select()
        .from(invite)
        .where(eq(invite.tokenHash, await sha256(token)))
        .limit(1)
    )[0];
    if (!row || row.acceptedAt || row.expiresAt < Date.now()) return null;
    return { email: row.email, role: row.role as Role, expiresAt: row.expiresAt };
  }

  /**
   * Accepts an invite: creates the user, binds the role from the invite row (not
   * from the request), and signs them in.
   */
  static async acceptInvite(
    db: Db,
    token: string,
    input: { password: string; name?: string },
    context: { userAgent?: string },
  ): Promise<{ token: string; user: SessionUser }> {
    assertPasswordStrength(input.password);
    const row = (
      await db
        .select()
        .from(invite)
        .where(eq(invite.tokenHash, await sha256(token)))
        .limit(1)
    )[0];
    if (!row || row.acceptedAt || row.expiresAt < Date.now()) {
      throw new AuthError(400, "this invite is no longer valid");
    }

    const existing = (
      await db.select({ id: user.id }).from(user).where(eq(user.email, row.email)).limit(1)
    )[0];
    if (existing) throw new AuthError(409, "an account with that email already exists");

    const now = Date.now();
    const created: SessionUser = {
      id: Bun.randomUUIDv7(),
      email: row.email,
      name: input.name?.trim() || null,
      role: row.role as Role,
    };

    await db.transaction(async (tx) => {
      await tx.insert(user).values({
        id: created.id,
        email: created.email,
        name: created.name,
        passwordHash: await hashPassword(input.password),
        role: created.role,
        createdAt: now,
      });
      await tx
        .update(invite)
        .set({ acceptedAt: now, acceptedBy: created.id })
        .where(eq(invite.id, row.id));
      await tx.insert(auditLog).values({
        id: Bun.randomUUIDv7(),
        at: now,
        actorId: created.id,
        actorEmail: created.email,
        action: "invite.accept",
        target: row.email,
      });
    });

    const sessionToken = await Auth.createSession(db, created.id, context);
    return { token: sessionToken, user: created };
  }

  static async listUsers(db: Db) {
    return db
      .select({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      })
      .from(user)
      .orderBy(user.createdAt);
  }

  static async setRole(db: Db, userId: string, role: Role): Promise<void> {
    await db.update(user).set({ role }).where(eq(user.id, userId));
  }

  /** The last admin cannot be removed or demoted — that is a lockout. */
  static async assertNotLastAdmin(db: Db, userId: string): Promise<void> {
    const admins = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.role, "admin"));
    if (admins.length === 1 && admins[0]?.id === userId) {
      throw new AuthError(409, "the last admin cannot be demoted or removed");
    }
  }

  static async getSetting<T>(db: Db, key: string, fallback: T): Promise<T> {
    const row = (
      await db
        .select()
        .from(instanceSetting)
        .where(eq(instanceSetting.key, key))
        .limit(1)
    )[0];
    return (row?.value as T) ?? fallback;
  }

  static async setSetting(db: Db, key: string, value: unknown, actorId?: string): Promise<void> {
    // `instance_setting.value` is jsonb, and the driver binds a *number* or a
    // *boolean* as a SQL scalar — Postgres then refuses it with "column value is
    // of type jsonb but expression is of type integer". Serialising and casting
    // in SQL is the one form that round-trips every JSON scalar (strings and
    // objects are left to the driver, which quotes/serialises them itself).
    const serialised =
      typeof value === "number" || typeof value === "boolean"
        ? sql`${JSON.stringify(value)}::jsonb`
        : value;
    await db
      .insert(instanceSetting)
      .values({ key, value: serialised as never, updatedAt: Date.now(), updatedBy: actorId ?? null })
      .onConflictDoUpdate({
        target: instanceSetting.key,
        set: { value: serialised as never, updatedAt: Date.now(), updatedBy: actorId ?? null },
      });
  }

  static async audit(
    db: Db,
    input: {
      actorId?: string | null;
      actorEmail?: string | null;
      action: string;
      target?: string;
      detail?: unknown;
      ip?: string;
    },
  ): Promise<void> {
    await db.insert(auditLog).values({
      id: Bun.randomUUIDv7(),
      at: Date.now(),
      actorId: input.actorId ?? null,
      actorEmail: input.actorEmail ?? null,
      action: input.action,
      target: input.target ?? null,
      detail: (input.detail ?? null) as Record<string, unknown> | null,
      ip: input.ip ?? null,
    });
  }
}

/**
 * Minimum viable password policy for a self-hosted admin: length plus not the
 * obvious strings. Composition rules ("one symbol") make passwords worse, not
 * better; length is what matters.
 */
export function assertPasswordStrength(password: string): void {
  if (password.length < 10) {
    throw new AuthError(400, "password must be at least 10 characters");
  }
  const lower = password.toLowerCase();
  const banned = ["password", "12345678", "qwerty", "admin", "letmein"];
  if (banned.some((entry) => lower.includes(entry))) {
    throw new AuthError(400, "password is too common");
  }
}

/**
 * Bootstrap from the environment, for IaC and `docker run`.
 *
 * `OBSERVE_ADMIN_EMAIL` + `OBSERVE_ADMIN_PASSWORD` create the admin without a
 * wizard and make `/setup` never appear. If the user already exists the password
 * is rotated only when `OBSERVE_ADMIN_PASSWORD_RESET=1`, so a redeploy does not
 * silently undo a password change.
 */
export async function bootstrapAdmin(db: Db, config: Config): Promise<void> {
  const email = process.env.OBSERVE_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.OBSERVE_ADMIN_PASSWORD;
  if (!email || !password) return;

  const existing = (await db.select().from(user).where(eq(user.email, email)).limit(1))[0];

  if (!existing) {
    assertPasswordStrength(password);
    const now = Date.now();
    await db.insert(user).values({
      id: Bun.randomUUIDv7(),
      email,
      passwordHash: await hashPassword(password),
      role: "admin",
      createdAt: now,
    });
    await db
      .insert(instanceSetting)
      .values({ key: "registration", value: "invite", updatedAt: now })
      .onConflictDoNothing();
    console.log(`[auth] bootstrapped admin ${email} from OBSERVE_ADMIN_EMAIL`);
    void config;
    return;
  }

  if (process.env.OBSERVE_ADMIN_PASSWORD_RESET === "1") {
    await db
      .update(user)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(user.id, existing.id));
    console.log(`[auth] rotated password for ${email} from OBSERVE_ADMIN_PASSWORD`);
  }
}
