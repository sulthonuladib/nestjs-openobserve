/**
 * Ingest service — the business logic, decoupled from Elysia.
 *
 * One batch is one Postgres transaction. That is the unit of consistency the
 * agent retries, so a half-written batch is a batch the dashboard can never
 * explain, and the agent has no way to ask for it again.
 *
 * Rows are written in bulk (`values([...])`) rather than one statement per span:
 * a single auto-instrumented request routinely carries 80+ spans, and 80 round
 * trips per request is how an ingest endpoint becomes the bottleneck.
 */
import { and, eq, sql } from "drizzle-orm";
import type {
  EncodedJobSnapshot,
  EncodedRequestSnapshot,
  EncodedSpan,
  TelemetryBatch,
} from "@observe/shared";
import type { Db, Executor } from "../../plugins/database";
import {
  appCredential,
  application,
  errorGroup,
  errorOccurrence,
  execution,
  logEntry,
  metricPoint,
  metricSeries,
  operation,
  project,
  release,
  rollupMinute,
  runtimeSample,
  slo,
  span as spanTable,
} from "../../db/schema";
import { fingerprint, trimStack } from "./fingerprint";

export interface Credentials {
  readonly appKey: string;
  readonly appSecret: string;
}

export interface AuthedApplication {
  readonly applicationId: string;
  readonly projectId: string;
  readonly serviceId: string;
  readonly credentialId: string;
}

export interface WriteTarget {
  /** `null` in anonymous mode: the service id creates or claims the application. */
  readonly applicationId: string | null;
  readonly projectId: string;
  readonly serviceId: string;
}

export interface WriteResult {
  readonly applicationId: string;
  readonly executions: number;
  readonly spans: number;
  readonly errors: number;
  readonly logs: number;
  readonly metrics: number;
  readonly objectives: number;
}

export const DEFAULT_PROJECT_ID = "00000000-0000-7000-8000-000000000000";

/** 25 log-scale buckets, 1 ms → ~8 s. */
const HISTOGRAM_BOUNDARIES_MS = Array.from({ length: 24 }, (_, i) => 2 ** (i / 3));
const HISTOGRAM_BUCKETS = HISTOGRAM_BOUNDARIES_MS.length + 1;

const ROW_CHUNK = 500;

function chunk<T>(items: T[], size = ROW_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The first 8 characters, in clear, are the lookup index. */
export function keyPrefix(appKey: string): string {
  return appKey.slice(0, 8);
}

export abstract class Ingest {
  static async ensureDefaultProject(db: Executor, now = Date.now()): Promise<string> {
    await db
      .insert(project)
      .values({ id: DEFAULT_PROJECT_ID, name: "Default", slug: "default", createdAt: now })
      .onConflictDoNothing({ target: project.slug });
    return DEFAULT_PROJECT_ID;
  }

  static hashSecret(secret: string): Promise<string> {
    // argon2id. A 32-byte random API secret does not need a slow KDF for
    // strength, but it costs ~40 ms once at issue time and makes a stolen
    // database useless, which is worth it.
    return Bun.password.hash(secret, {
      algorithm: "argon2id",
      memoryCost: 19_456,
      timeCost: 2,
    });
  }

  static async verifySecret(secret: string, hash: string): Promise<boolean> {
    try {
      return await Bun.password.verify(secret, hash);
    } catch {
      return false;
    }
  }

  /**
   * Resolves the application a batch belongs to.
   *
   * `null` means the credentials are wrong (the caller answers 401).
   * `"anonymous"` means none were sent and the deployment allows that — the
   * SDK omits the headers entirely when unconfigured, which is the local
   * development path and must read as "no credentials", not "bad credentials".
   */
  static async authenticate(
    db: Db,
    credentials: Credentials | null,
    allowAnonymous: boolean,
  ): Promise<AuthedApplication | "anonymous" | null> {
    if (!credentials) return allowAnonymous ? "anonymous" : null;

    const rows = await db
      .select({
        credentialId: appCredential.id,
        applicationId: application.id,
        projectId: application.projectId,
        serviceId: application.serviceId,
        secretHash: appCredential.secretHash,
      })
      .from(appCredential)
      .innerJoin(application, eq(application.id, appCredential.applicationId))
      .where(
        and(
          eq(appCredential.keyPrefix, keyPrefix(credentials.appKey)),
          eq(appCredential.keyHash, await sha256(credentials.appKey)),
          sql`${appCredential.revokedAt} IS NULL`,
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    if (!(await Ingest.verifySecret(credentials.appSecret, row.secretHash))) return null;

    // Fire-and-forget: a `last_used_at` write must never be in the hot path's
    // critical section, and losing one costs nothing.
    void db
      .update(appCredential)
      .set({ lastUsedAt: Date.now() })
      .where(eq(appCredential.id, row.credentialId))
      .catch(() => undefined);

    return {
      credentialId: row.credentialId,
      applicationId: row.applicationId,
      projectId: row.projectId,
      serviceId: row.serviceId,
    };
  }

  static async writeBatch(
    db: Db,
    target: WriteTarget,
    batch: TelemetryBatch,
    now = Date.now(),
  ): Promise<WriteResult> {
    return db.transaction(async (tx) => {
      const exec = tx as unknown as Executor;
      const applicationId =
        target.applicationId ??
        (await ensureApplication(exec, target.projectId, target.serviceId, now));

      const releaseId = batch.serviceVersion
        ? await ensureRelease(exec, applicationId, batch.serviceVersion, now)
        : null;

      let executions = 0;
      let spans = 0;
      let errors = 0;
      let logs = 0;
      let metrics = 0;
      let objectives = 0;

      for (const snapshot of batch.snapshots ?? []) {
        const result = await writeRequest(exec, applicationId, releaseId, snapshot, now);
        executions += 1;
        spans += result.spans;
        if (result.failed) errors += 1;
      }

      for (const job of batch.jobs ?? []) {
        const result = await writeJob(exec, applicationId, releaseId, job, now);
        executions += 1;
        spans += result.spans;
        if (result.failed) errors += 1;
      }

      if (batch.logs?.length) {
        const rows = batch.logs.map((entry) => ({
          id: Bun.randomUUIDv7(),
          applicationId,
          occurredAt: Math.round(entry.timestamp),
          level: entry.level ?? null,
          context: entry.context ?? null,
          text: entry.text.slice(0, 16_384),
          traceId: entry.traceId ?? null,
          spanId: entry.spanId ?? null,
          attributes: entry.attributes ?? {},
        }));
        for (const group of chunk(rows)) await exec.insert(logEntry).values(group);
        logs += rows.length;
      }

      if (batch.runtime) {
        await exec.insert(runtimeSample).values({
          id: Bun.randomUUIDv7(),
          applicationId,
          receivedAt: now,
          cpu: (batch.runtime.c ?? {}) as Record<string, number>,
          memory: (batch.runtime.m ?? {}) as Record<string, number>,
          gc: (batch.runtime.g ?? {}) as Record<string, unknown>,
          eventLoop: (batch.runtime.e ?? {}) as Record<string, number>,
        });
      }

      for (const metric of batch.custom ?? []) {
        metrics += await writeMetric(exec, applicationId, metric, now);
      }

      for (const declaration of batch.objectives ?? []) {
        objectives += await writeObjectives(exec, applicationId, releaseId, declaration, now);
      }

      return { applicationId, executions, spans, errors, logs, metrics, objectives };
    });
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

async function ensureApplication(
  db: Executor,
  projectId: string,
  serviceId: string,
  now: number,
): Promise<string> {
  const existing = await db
    .select({ id: application.id })
    .from(application)
    .where(and(eq(application.projectId, projectId), eq(application.serviceId, serviceId)))
    .limit(1);

  if (existing[0]) {
    await db
      .update(application)
      .set({ lastSeen: now })
      .where(eq(application.id, existing[0].id));
    return existing[0].id;
  }

  const row = {
    id: Bun.randomUUIDv7(),
    projectId,
    serviceId,
    firstSeen: now,
    lastSeen: now,
  };
  await db.insert(application).values(row);
  return row.id;
}

async function ensureRelease(
  db: Executor,
  applicationId: string,
  version: string,
  now: number,
): Promise<string> {
  const existing = await db
    .select({ id: release.id })
    .from(release)
    .where(and(eq(release.applicationId, applicationId), eq(release.version, version)))
    .limit(1);

  if (existing[0]) {
    await db.update(release).set({ lastSeen: now }).where(eq(release.id, existing[0].id));
    return existing[0].id;
  }

  const row = { id: Bun.randomUUIDv7(), applicationId, version, firstSeen: now, lastSeen: now };
  await db.insert(release).values(row);
  return row.id;
}

async function ensureOperation(
  db: Executor,
  applicationId: string,
  protocol: string,
  operationId: string,
  method: string | undefined,
  customName: string | undefined,
  now: number,
): Promise<string> {
  const existing = await db
    .select({ id: operation.id })
    .from(operation)
    .where(
      and(
        eq(operation.applicationId, applicationId),
        eq(operation.protocol, protocol),
        eq(operation.operationId, operationId),
      ),
    )
    .limit(1);

  if (existing[0]) {
    await db
      .update(operation)
      .set({
        lastSeen: now,
        ...(method ? { method } : {}),
        ...(customName ? { customName } : {}),
      })
      .where(eq(operation.id, existing[0].id));
    return existing[0].id;
  }

  const row = {
    id: Bun.randomUUIDv7(),
    applicationId,
    protocol,
    operationId,
    method: method ?? null,
    customName: customName ?? null,
    firstSeen: now,
    lastSeen: now,
  };
  await db.insert(operation).values(row);
  return row.id;
}

/**
 * Flattens the nested `ch` tree into rows.
 *
 * The wire nests spans to arbitrary depth, but every dashboard query is "this
 * execution's spans, in order" — so a flat table with `parentId` and a sibling
 * `seq` is the shape that reads well, and the tree is rebuilt in memory where a
 * human is waiting for it.
 */
async function writeSpans(
  db: Executor,
  executionId: string,
  spans: EncodedSpan[],
): Promise<number> {
  const rows: Array<typeof spanTable.$inferInsert> = [];

  const emit = (nodes: EncodedSpan[], parentRowId: string | null, depth: number): void => {
    nodes.forEach((node, seq) => {
      const rowId = Bun.randomUUIDv7();
      const collapsed = node.t?.["observe.collapsed"];
      rows.push({
        id: rowId,
        executionId,
        parentId: parentRowId,
        spanId: node.s ?? null,
        name: node.n ?? null,
        origin: node.o,
        className: node.c,
        method: node.m,
        durationMs: node.d ?? null,
        startOffsetMs: node.so ?? null,
        error: node.e !== undefined,
        tags: (node.t ?? {}) as Record<string, unknown>,
        collapsedCount: typeof collapsed === "number" ? collapsed : null,
        depth,
        seq,
      });
      if (node.ch?.length) emit(node.ch, rowId, depth + 1);
    });
  };

  emit(spans, null, 0);
  if (rows.length === 0) return 0;

  for (const group of chunk(rows)) await db.insert(spanTable).values(group);
  return rows.length;
}

function countSpans(spans: EncodedSpan[] | undefined): number {
  if (!spans?.length) return 0;
  let count = 0;
  for (const node of spans) count += 1 + countSpans(node.ch);
  return count;
}

/**
 * Mirrors the SDK's `isServerErrorSnapshot`: where a status code exists it
 * decides alone, because an expected 401 carries an error exactly like a 500
 * does — and a 4xx flood is the traffic an error-rate chart should not call an
 * outage.
 */
function isServerError(statusCode: number | undefined, hasError: boolean): number {
  if (typeof statusCode === "number") return statusCode >= 500 ? 1 : 0;
  return hasError ? 1 : 0;
}

function isClientError(statusCode: number | undefined): number {
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 ? 1 : 0;
}

function minuteBucket(at: number): number {
  return Math.floor(at / 60_000) * 60_000;
}

function histogramIndex(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  for (let i = 0; i < HISTOGRAM_BOUNDARIES_MS.length; i += 1) {
    if (durationMs <= HISTOGRAM_BOUNDARIES_MS[i]!) return i;
  }
  return HISTOGRAM_BUCKETS - 1;
}

function newHistogram(): number[] {
  return new Array<number>(HISTOGRAM_BUCKETS).fill(0);
}

/**
 * Merges one execution into its minute bucket.
 *
 * The histogram is merged slot by slot rather than replaced: p95 over an hour
 * cannot be derived from per-minute p95s, and a dashboard that pretends
 * otherwise is lying about the one number people look at.
 */
async function writeRollup(
  db: Executor,
  input: {
    applicationId: string;
    operationRowId: string;
    kind: "request" | "job";
    at: number;
    serverError: number;
    clientError: number;
    durationMs: number;
  },
): Promise<void> {
  const at = minuteBucket(input.at);
  const histogram = newHistogram();
  const index = histogramIndex(input.durationMs);
  histogram[index] = (histogram[index] ?? 0) + 1;

  await db
    .insert(rollupMinute)
    .values({
      applicationId: input.applicationId,
      at,
      operationRowId: input.operationRowId,
      kind: input.kind,
      count: 1,
      errorCount: input.serverError,
      clientErrorCount: input.clientError,
      durationSum: input.durationMs,
      durationHist: histogram,
    })
    .onConflictDoUpdate({
      target: [
        rollupMinute.applicationId,
        rollupMinute.at,
        rollupMinute.operationRowId,
        rollupMinute.kind,
      ],
      set: {
        count: sql`${rollupMinute.count} + 1`,
        errorCount: sql`${rollupMinute.errorCount} + ${input.serverError}`,
        clientErrorCount: sql`${rollupMinute.clientErrorCount} + ${input.clientError}`,
        durationSum: sql`${rollupMinute.durationSum} + ${input.durationMs}`,
        // Element-wise add of the two 25-slot histograms, in one statement:
        // `unnest(existing, incoming)` keeps them index-aligned, so the merge
        // needs no read-modify-write and no row lock beyond the upsert's own.
        durationHist: sql`(
          SELECT array_agg(a + b ORDER BY ord)
          FROM unnest(${rollupMinute.durationHist}, excluded.duration_hist)
            WITH ORDINALITY AS t(a, b, ord)
        )`,
      },
    });
}

interface WireError {
  readonly cls?: string;
  readonly message?: string;
  readonly stack?: string;
  readonly tags?: Record<string, string | number | boolean>;
}

async function writeError(
  db: Executor,
  applicationId: string,
  executionId: string,
  releaseId: string | null,
  error: WireError | boolean,
  at: number,
): Promise<string | null> {
  if (typeof error === "boolean") return null; // "failed, details not captured"

  const print = fingerprint({
    message: error.message ?? "(no message)",
    class: error.cls,
    stack: error.stack,
  });

  const existing = await db
    .select({ id: errorGroup.id })
    .from(errorGroup)
    .where(
      and(
        eq(errorGroup.applicationId, applicationId),
        eq(errorGroup.fingerprint, print.fingerprint),
      ),
    )
    .limit(1);

  let groupId: string;
  if (existing[0]) {
    groupId = existing[0].id;
    await db
      .update(errorGroup)
      .set({
        lastSeen: at,
        occurrences: sql`${errorGroup.occurrences} + 1`,
        // A resolved error that happens again is open again. Silently keeping
        // it resolved is how a real regression hides.
        status: sql`CASE WHEN ${errorGroup.status} = 'resolved' THEN 'open' ELSE ${errorGroup.status} END`,
      })
      .where(eq(errorGroup.id, groupId));
  } else {
    groupId = Bun.randomUUIDv7();
    await db.insert(errorGroup).values({
      id: groupId,
      applicationId,
      fingerprint: print.fingerprint,
      class: print.class ?? null,
      message: print.message,
      topFrameFile: print.topFrame?.file ?? null,
      topFrameLine: print.topFrame?.line ?? null,
      status: "open",
      firstSeen: at,
      lastSeen: at,
      occurrences: 1,
    });
  }

  await db.insert(errorOccurrence).values({
    id: Bun.randomUUIDv7(),
    errorGroupId: groupId,
    executionId,
    releaseId,
    occurredAt: at,
    stack: trimStack(error.stack) ?? null,
  });

  return groupId;
}

async function writeRequest(
  db: Executor,
  applicationId: string,
  releaseId: string | null,
  snapshot: EncodedRequestSnapshot,
  now: number,
): Promise<{ spans: number; failed: boolean }> {
  const operationRowId = await ensureOperation(
    db,
    applicationId,
    snapshot.p ?? "http",
    snapshot.op,
    snapshot.a?.m,
    snapshot.a?.dop,
    now,
  );

  const executionId = Bun.randomUUIDv7();

  await db.insert(execution).values({
    id: executionId,
    applicationId,
    releaseId,
    operationRowId,
    kind: "request",
    protocol: snapshot.p ?? null,
    traceId: snapshot.ti,
    startedAt: now,
    calledAt: snapshot.ct ?? null,
    durationMs: snapshot.d ?? null,
    statusCode: snapshot.a?.sc ?? null,
    userId: snapshot.u ?? null,
    tags: snapshot.tg ?? {},
    request: snapshot.rq ?? null,
    spanCount: countSpans(snapshot.t),
  });

  // The error is written after the execution because an occurrence references
  // it: inserting first and linking after is one extra UPDATE on the failure
  // path only, and it keeps the foreign keys honest.
  const errorGroupId = snapshot.e
    ? await writeError(db, applicationId, executionId, releaseId, snapshot.e as WireError, now)
    : null;
  if (errorGroupId) {
    await db.update(execution).set({ errorGroupId }).where(eq(execution.id, executionId));
  }

  const spans = await writeSpans(db, executionId, snapshot.t);

  await writeRollup(db, {
    applicationId,
    operationRowId,
    kind: "request",
    at: now,
    serverError: isServerError(snapshot.a?.sc, snapshot.e !== undefined),
    clientError: isClientError(snapshot.a?.sc),
    durationMs: snapshot.d ?? 0,
  });

  return { spans, failed: snapshot.e !== undefined };
}

async function writeJob(
  db: Executor,
  applicationId: string,
  releaseId: string | null,
  job: EncodedJobSnapshot,
  now: number,
): Promise<{ spans: number; failed: boolean }> {
  const operationRowId = await ensureOperation(
    db,
    applicationId,
    "job",
    job.q ? `${job.q}/${job.n ?? job.i}` : (job.n ?? job.i),
    undefined,
    undefined,
    now,
  );

  const executionId = Bun.randomUUIDv7();

  await db.insert(execution).values({
    id: executionId,
    applicationId,
    releaseId,
    operationRowId,
    kind: "job",
    protocol: "job",
    traceId: job.ti,
    startedAt: now,
    calledAt: job.c ?? null,
    durationMs: job.d ?? null,
    queue: job.q ?? null,
    jobName: job.n ?? null,
    jobStatus: job.s ?? null,
    waitMs: job.wd ?? null,
    attemptsMade: job.am ?? null,
    maxAttempts: job.ma ?? null,
    enqueuedAt: job.ea ?? null,
    tags: job.tg ?? {},
    spanCount: countSpans(job.t),
  });

  const errorGroupId = job.e
    ? await writeError(db, applicationId, executionId, releaseId, job.e as WireError, now)
    : null;
  if (errorGroupId) {
    await db.update(execution).set({ errorGroupId }).where(eq(execution.id, executionId));
  }

  const spans = await writeSpans(db, executionId, job.t);

  await writeRollup(db, {
    applicationId,
    operationRowId,
    kind: "job",
    at: now,
    serverError: isServerError(undefined, job.e !== undefined),
    clientError: 0,
    durationMs: job.d ?? 0,
  });

  return { spans, failed: job.e !== undefined };
}

function labelHash(labels: Record<string, unknown>): string {
  return Bun.hash(
    Object.keys(labels)
      .sort()
      .map((key) => `${key}=${String(labels[key])}`)
      .join("\u0001"),
  ).toString(36);
}

async function writeMetric(
  db: Executor,
  applicationId: string,
  metric: NonNullable<TelemetryBatch["custom"]>[number],
  now: number,
): Promise<number> {
  let written = 0;
  const baseLabels = (metric.tg ?? {}) as Record<string, unknown>;

  for (const [labelValue, value] of Object.entries(metric.v ?? {})) {
    // `v` maps a label value to a reading. With `l` naming a single label
    // dimension the map key is that label's value; otherwise it is an opaque
    // series discriminator.
    const labels: Record<string, string> = {};
    for (const [key, raw] of Object.entries(baseLabels)) labels[key] = String(raw);
    if (metric.l?.length === 1) labels[metric.l[0]!] = labelValue;
    else if (labelValue) labels.series = labelValue;

    const hash = labelHash(labels);
    const existing = await db
      .select({ id: metricSeries.id })
      .from(metricSeries)
      .where(
        and(
          eq(metricSeries.applicationId, applicationId),
          eq(metricSeries.name, metric.n),
          eq(metricSeries.labelsHash, hash),
        ),
      )
      .limit(1);

    let seriesId: string;
    if (existing[0]) {
      seriesId = existing[0].id;
    } else {
      seriesId = Bun.randomUUIDv7();
      await db
        .insert(metricSeries)
        .values({
          id: seriesId,
          applicationId,
          name: metric.n,
          type: metric.t,
          kind: metric.k ?? null,
          labelsHash: hash,
          labels,
          description: metric.d ?? null,
        })
        .onConflictDoNothing();
    }

    await db
      .insert(metricPoint)
      .values({
        seriesId,
        at: now,
        value: metric.t === "summary" ? null : value,
        count: metric.ct?.[labelValue] ?? null,
        sum: metric.sm?.[labelValue] ?? null,
        min: metric.iv?.[labelValue] ?? null,
        max: metric.mx?.[labelValue] ?? null,
        q50: metric.q50?.[labelValue] ?? null,
        q95: metric.q95?.[labelValue] ?? null,
        q99: metric.q99?.[labelValue] ?? null,
      })
      .onConflictDoUpdate({
        target: [metricPoint.seriesId, metricPoint.at],
        set: { value: metric.t === "summary" ? null : value },
      });
    written += 1;
  }
  return written;
}

type ObjectiveDeclaration = NonNullable<TelemetryBatch["objectives"]>[number];

async function writeObjectives(
  db: Executor,
  applicationId: string,
  releaseId: string | null,
  declaration: ObjectiveDeclaration,
  now: number,
): Promise<number> {
  let written = 0;
  for (const objective of declaration.objectives) {
    const common = {
      applicationId,
      operationId: declaration.operationId,
      method: declaration.method ?? null,
      name: objective.name ?? null,
      windowDays: objective.windowDays ?? 28,
      source: "code" as const,
      handler: declaration.handler,
      releaseId,
      updatedAt: now,
    };

    if (typeof objective.availability === "number") {
      await db
        .insert(slo)
        .values({
          ...common,
          id: Bun.randomUUIDv7(),
          kind: "availability",
          target: objective.availability,
          underMs: null,
        })
        .onConflictDoUpdate({
          target: [slo.applicationId, slo.operationId, slo.kind, slo.underMs],
          set: {
            target: objective.availability,
            windowDays: common.windowDays,
            name: common.name,
            handler: common.handler,
            releaseId,
            updatedAt: now,
          },
        });
      written += 1;
    }

    if (objective.latency) {
      await db
        .insert(slo)
        .values({
          ...common,
          id: Bun.randomUUIDv7(),
          kind: "latency",
          target: objective.latency.target,
          underMs: objective.latency.underMs,
        })
        .onConflictDoUpdate({
          target: [slo.applicationId, slo.operationId, slo.kind, slo.underMs],
          set: {
            target: objective.latency.target,
            windowDays: common.windowDays,
            name: common.name,
            handler: common.handler,
            releaseId,
            updatedAt: now,
          },
        });
      written += 1;
    }
  }
  return written;
}
