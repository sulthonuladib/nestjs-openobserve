/**
 * `nestjs-openobserve admin …` — the operations an operator needs when the UI is not
 * reachable, or when there is no UI yet.
 *
 * The rule from `docs/SELF-HOSTED.md` §3: every identity operation the dashboard
 * can perform has a CLI equivalent, because the alternative is "SSH into the
 * container and run SQL", and that is how a self-hosted product acquires a
 * reputation.
 *
 * The same binary, a different argv: no second artifact, no extra image.
 */
import { SQL } from "bun";
import { loadConfig } from "./plugins/config";
import { connectDatabase, type Db } from "./plugins/database";
import { Auth, assertPasswordStrength } from "./modules/auth/service";
import { instanceSetting, user } from "./db/schema";
import { sql } from "drizzle-orm";
import {
  appCredential,
  application,
  errorGroup,
  execution,
  logEntry,
  metricPoint,
  span,
} from "./db/schema";

const USAGE = `nestjs-openobserve admin — instance administration

  admin info                     versions, row counts, database size
  admin create-user  --email E [--role read|write|admin] [--password-stdin]
  admin reset-password --email E [--password-stdin]
  admin list-users
  admin invite       --email E [--role read|write|admin]
  admin set-setting  <key> <json>
  admin migrate                  apply pending migrations
  admin prune [--dry-run]        enforce retention now

Passwords are read from stdin when --password-stdin is given, so they never
appear in the process list or in shell history. OBSERVE_DATABASE_URL is
required and read the same way the server reads it.
`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

/** Reads a password from stdin, one line. Never echoed, never in argv. */
async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write("password: ");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const value = Buffer.concat(chunks).toString("utf8").split("\n")[0] ?? "";
  if (!value) throw new Error("no password on stdin");
  return value;
}

async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const config = loadConfig();
  const connection = await connectDatabase({
    url: config.databaseUrl,
    runMigrations: false,
  });
  try {
    return await fn(connection.db);
  } finally {
    await connection.close();
  }
}

function pgSize(url: string): Promise<number | null> {
  return (async () => {
    const client = new SQL({ url });
    try {
      const rows = await client`SELECT pg_database_size(current_database()) AS size`;
      const size = (rows[0] as { size?: number | string } | undefined)?.size;
      return size === undefined ? null : Number(size);
    } catch {
      return null;
    } finally {
      await client.close();
    }
  })();
}

export async function runAdminCli(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const config = loadConfig();

  switch (command) {
    case undefined:
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;

    case "info": {
      const counts = await withDb(async (db) => {
        const one = async (table: Parameters<Db["select"]>[0] extends never ? never : never) => 0;
        void one;
        const [users] = await db.select({ n: sql<number>`count(*)::int` }).from(user);
        const [apps] = await db.select({ n: sql<number>`count(*)::int` }).from(application);
        const [execs] = await db.select({ n: sql<number>`count(*)::int` }).from(execution);
        const [spans] = await db.select({ n: sql<number>`count(*)::int` }).from(span);
        const [logs] = await db.select({ n: sql<number>`count(*)::int` }).from(logEntry);
        const [errors] = await db.select({ n: sql<number>`count(*)::int` }).from(errorGroup);
        const [keys] = await db.select({ n: sql<number>`count(*)::int` }).from(appCredential);
        return {
          users: users?.n ?? 0,
          applications: apps?.n ?? 0,
          executions: execs?.n ?? 0,
          spans: spans?.n ?? 0,
          logs: logs?.n ?? 0,
          errorGroups: errors?.n ?? 0,
          apiKeys: keys?.n ?? 0,
          setupRequired: await Auth.setupRequired(db),
          registration: await Auth.registrationMode(db),
        };
      });
      const size = await pgSize(config.databaseUrl);
      console.log(
        [
          `version        ${config.version}`,
          `ingest api     v1 (@nestjs/observe >=0.3.17 <0.4.0)`,
          `database       ${size === null ? "unknown" : `${(size / 1024 / 1024).toFixed(1)} MiB`}`,
          `setup required ${counts.setupRequired ? "yes — open /setup" : "no"}`,
          `registration   ${counts.registration}`,
          `users          ${counts.users}`,
          `applications   ${counts.applications}`,
          `api keys       ${counts.apiKeys}`,
          `executions     ${counts.executions}`,
          `spans          ${counts.spans}`,
          `logs           ${counts.logs}`,
          `error groups   ${counts.errorGroups}`,
        ].join("\n"),
      );
      return 0;
    }

    case "list-users": {
      const rows = await withDb((db) => Auth.listUsers(db));
      if (rows.length === 0) {
        console.log("no users — open /setup, or set OBSERVE_ADMIN_EMAIL/PASSWORD");
        return 0;
      }
      for (const row of rows) {
        console.log(
          `${row.email.padEnd(40)} ${row.role.padEnd(6)} ${row.lastLoginAt ? new Date(row.lastLoginAt).toISOString() : "never signed in"}`,
        );
      }
      return 0;
    }

    case "create-user": {
      const email = flag(args, "--email")?.trim().toLowerCase();
      if (!email) throw new Error("--email is required");
      const role = (flag(args, "--role") ?? "write") as "read" | "write" | "admin";
      const password = has(args, "--password-stdin")
        ? await readPassword()
        : randomPassword();
      assertPasswordStrength(password);

      await withDb(async (db) => {
        const existing = await db.select().from(user);
        if (existing.some((row) => row.email === email)) {
          throw new Error(`${email} already exists`);
        }
        await db.insert(user).values({
          id: Bun.randomUUIDv7(),
          email,
          passwordHash: await Bun.password.hash(password, {
            algorithm: "argon2id",
            memoryCost: 19_456,
            timeCost: 2,
          }),
          role,
          createdAt: Date.now(),
        });
        await Auth.audit(db, { action: "cli.create-user", target: email, detail: { role } });
      });

      console.log(`created ${email} (${role})`);
      if (!has(args, "--password-stdin")) console.log(`password: ${password}`);
      return 0;
    }

    case "reset-password": {
      const email = flag(args, "--email")?.trim().toLowerCase();
      if (!email) throw new Error("--email is required");
      const password = has(args, "--password-stdin")
        ? await readPassword()
        : randomPassword();
      assertPasswordStrength(password);

      await withDb(async (db) => {
        const row = (await db.select().from(user)).find((entry) => entry.email === email);
        if (!row) throw new Error(`no user ${email}`);
        await db
          .update(user)
          .set({
            passwordHash: await Bun.password.hash(password, {
              algorithm: "argon2id",
              memoryCost: 19_456,
              timeCost: 2,
            }),
          })
          .where(sql`${user.id} = ${row.id}`);
        // Every existing session dies with the password: that is the point of
        // resetting it.
        await Auth.logoutEverywhere(db, row.id);
        await Auth.audit(db, { action: "cli.reset-password", target: email });
      });

      console.log(`password reset for ${email}; all sessions revoked`);
      if (!has(args, "--password-stdin")) console.log(`password: ${password}`);
      return 0;
    }

    case "invite": {
      const email = flag(args, "--email")?.trim().toLowerCase();
      if (!email) throw new Error("--email is required");
      const role = (flag(args, "--role") ?? "write") as "read" | "write" | "admin";

      const { token, expiresAt } = await withDb((db) =>
        Auth.issueInvite(db, { email, role, invitedBy: "" }),
      );
      console.log(`${config.publicUrl}/invite/${token}`);
      console.log(`valid until ${new Date(expiresAt).toISOString()}, single use, role ${role}`);
      return 0;
    }

    case "set-setting": {
      const [key, raw] = args;
      if (!key || raw === undefined) throw new Error("usage: set-setting <key> <json>");
      const value = JSON.parse(raw) as unknown;
      await withDb(async (db) => {
        await db
          .insert(instanceSetting)
          .values({ key, value, updatedAt: Date.now() })
          .onConflictDoUpdate({
            target: instanceSetting.key,
            set: { value, updatedAt: Date.now() },
          });
      });
      console.log(`${key} = ${JSON.stringify(value)}`);
      return 0;
    }

    case "migrate": {
      const connection = await connectDatabase({
        url: config.databaseUrl,
        runMigrations: true,
      });
      await connection.close();
      console.log("migrations applied");
      return 0;
    }

    case "prune": {
      const dryRun = has(args, "--dry-run");
      const removed = await withDb(async (db) => {
        const days = await Auth.getSetting(db, "retention.traces", 0);
        const keepDays = typeof days === "number" ? days : 0;
        if (keepDays <= 0) return { skipped: true, execution: 0, span: 0, log: 0, metric: 0 };
        const cutoff = Date.now() - keepDays * 86_400_000;
        if (dryRun) {
          const [execs] = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(execution)
            .where(sql`${execution.startedAt} < ${cutoff}`);
          const [logs] = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(logEntry)
            .where(sql`${logEntry.occurredAt} < ${cutoff}`);
          return { skipped: false, execution: execs?.n ?? 0, span: 0, log: logs?.n ?? 0, metric: 0 };
        }
        const spans = await db
          .delete(span)
          .where(sql`${span.executionId} IN (SELECT id FROM execution WHERE started_at < ${cutoff})`)
          .returning({ id: span.id });
        const execs = await db
          .delete(execution)
          .where(sql`${execution.startedAt} < ${cutoff}`)
          .returning({ id: execution.id });
        const logs = await db
          .delete(logEntry)
          .where(sql`${logEntry.occurredAt} < ${cutoff}`)
          .returning({ id: logEntry.id });
        const metrics = await db
          .delete(metricPoint)
          .where(sql`${metricPoint.at} < ${cutoff}`)
          .returning({ seriesId: metricPoint.seriesId });
        return {
          skipped: false,
          execution: execs.length,
          span: spans.length,
          log: logs.length,
          metric: metrics.length,
        };
      });

      if ("skipped" in removed && removed.skipped) {
        console.log("retention.traces is 0 (keep forever) — nothing pruned");
        return 0;
      }
      console.log(
        `${dryRun ? "would delete" : "deleted"}: ${removed.execution} executions, ` +
          `${removed.span} spans, ${removed.log} logs, ${removed.metric} metric points`,
      );
      return 0;
    }

    default:
      console.error(`unknown command: ${command}\n`);
      console.error(USAGE);
      return 1;
  }
}

/** A high-entropy password, for when the operator did not bring one. */
function randomPassword(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
}
