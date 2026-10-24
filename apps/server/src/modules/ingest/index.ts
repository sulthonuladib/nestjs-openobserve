/**
 * Ingest controller.
 *
 * The only routes that face the internet, so this is a separate Elysia instance
 * with no session middleware, no cookie parsing and no CORS work: the whole job
 * is "accept bytes fast". Paths are the hosted collector's, verbatim, so
 * `OBSERVE_ENDPOINT` is the only thing an existing agent has to change:
 *
 *   POST /applications/telemetry   gzip JSON batch
 *   POST /applications/profiles    shelved in SDK 0.3.17; accepted and dropped
 *
 * Body handling is by hand rather than through `content-encoding` inference: the
 * agent always gzips, and an explicit `Bun.gunzipSync` makes that the fast path
 * and a proxy's re-encoding a clear 415 instead of a parse failure.
 */
import { Elysia } from "elysia";
import { validateBatch, type TelemetryBatch } from "@observe/shared";
import type { Config } from "../../plugins/config";
import { configPlugin } from "../../plugins/config";
import type { Db } from "../../plugins/database";
import { databasePlugin } from "../../plugins/database";
import { telemetryState } from "../../plugins/telemetry-state";
import { ACCEPTED, IngestModel } from "./model";
import { Ingest } from "./service";

class UnsupportedEncoding extends Error {
  constructor(readonly encoding: string) {
    super(`unsupported content-encoding: ${encoding}`);
  }
}

async function readBody(request: Request): Promise<string> {
  const encoding = (request.headers.get("content-encoding") ?? "").toLowerCase();
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!encoding || encoding === "identity") return new TextDecoder().decode(bytes);
  if (encoding === "gzip" || encoding === "x-gzip") {
    return new TextDecoder().decode(Bun.gunzipSync(bytes));
  }
  if (encoding === "deflate") return new TextDecoder().decode(Bun.inflateSync(bytes));
  throw new UnsupportedEncoding(encoding);
}

function readCredentials(
  request: Request,
): { appKey: string; appSecret: string } | null {
  const appKey = request.headers.get("x-api-key");
  const appSecret = request.headers.get("x-api-secret");
  // The SDK omits both headers entirely when unconfigured rather than sending
  // blanks — a blank pair must read as "no credentials", not as a bad one.
  if (!appKey || !appSecret) return null;
  return { appKey, appSecret };
}

export const ingestModule = (deps: { config: Config; db: Db }) => new Elysia({ name: "ingest" })
  .use(configPlugin(deps.config))
  .use(telemetryState)
  .use(databasePlugin(deps.db))
  .onError(({ code, error, set }) => {
    if (error instanceof UnsupportedEncoding) {
      set.status = 415;
      return { message: error.message };
    }
    if (code === "PARSE") {
      set.status = 400;
      return { message: "malformed JSON body" };
    }
    // A batch we cannot store is our bug, not the agent's: say 500 so the agent
    // reports it rather than repairing and silently dropping an entry.
    console.error("[ingest] unhandled", error);
    set.status = 500;
    return { message: "internal error" };
  })
  .post(
    "/applications/telemetry",
    async ({ request, db, config, store, set }) => {
      let payload: unknown;
      try {
        payload = JSON.parse(await readBody(request));
      } catch (error) {
        if (error instanceof UnsupportedEncoding) throw error;
        store.stats.rejected += 1;
        // A body we cannot parse is unrepairable, and the SDK's repair path
        // only re-serializes what it sent — so this must be a 400, not a 500.
        set.status = 400;
        return { message: "malformed JSON body" };
      }

      // `forbidUnknown` mirrors the hosted API's `forbidNonWhitelisted`: it is
      // what catches an encoder that drifted, and it is what the agent's 400
      // repair path is written against.
      const problems = validateBatch(payload, { forbidUnknown: true });
      if (problems.length > 0) {
        store.stats.rejected += 1;
        set.status = 400;
        return {
          message: "batch does not match the ingest contract",
          problems: problems.slice(0, 25),
        };
      }

      const batch = payload as TelemetryBatch;
      const credentials = readCredentials(request);
      const authed = await Ingest.authenticate(
        db,
        credentials,
        config.allowAnonymousIngest,
      );

      if (authed === null) {
        store.stats.refused += 1;
        set.status = 401;
        return { message: "invalid appKey/appSecret" };
      }

      const projectId =
        authed === "anonymous"
          ? await Ingest.ensureDefaultProject(db)
          : authed.projectId;

      const result = await Ingest.writeBatch(
        db,
        {
          applicationId: authed === "anonymous" ? null : authed.applicationId,
          projectId,
          serviceId: batch.serviceId,
        },
        batch,
      );

      store.stats.batches += 1;
      store.stats.executions += result.executions;
      store.stats.spans += result.spans;
      store.stats.lastBatchAt = Date.now();
      store.stats.bytes += Number(request.headers.get("content-length") ?? 0);

      if (config.logLevel === "debug") {
        console.log(
          `[ingest] ${batch.serviceId} exec=+${result.executions} spans=+${result.spans} ` +
            `errors=+${result.errors} logs=+${result.logs} metrics=+${result.metrics}`,
        );
      }

      return ACCEPTED;
    },
    {
      response: { 200: IngestModel.reply, 400: IngestModel.error, 401: IngestModel.error },
      detail: {
        summary: "Ingest a telemetry batch",
        description:
          "Accepts the @nestjs/observe detached worker's gzip JSON batch. " +
          "Always answers { degraded: false }: there are no plans, allowances " +
          "or overage pauses in a self-hosted install.",
      },
    },
  )
  .post("/applications/profiles", () => ACCEPTED, {
    detail: {
      summary: "Upload a CPU profile (reserved)",
      description:
        "Profiling is shelved in @nestjs/observe 0.3.17 — the SDK never calls " +
        "this and the hosted collector's profile endpoints are unregistered. " +
        "Accepted and dropped so a re-enabled agent sees a healthy collector.",
    },
  });
