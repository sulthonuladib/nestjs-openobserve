# Using the MCP server

Source: https://www.observe.nestjs.com/documentation/mcp

The API exposes an [MCP](https://modelcontextprotocol.io/) server, so an MCP-compatible client - Claude Code, Claude Desktop, your IDE, an agent you wrote yourself - can ask questions about your projects directly instead of you copying dashboard data into a prompt. Regressions, slow operations, error groups, traces, jobs, alerts: the same data the dashboard shows, scoped to exactly what you can see.

The endpoint speaks Streamable HTTP at `POST https://observe-api.nestjs.com/mcp`. It's stateless - there's no session to open, nothing to keep alive, and no setup beyond the request itself.

> [!INFO] MCP is one of two ways to get telemetry to an agent. [Copy agent prompt](https://www.observe.nestjs.com/llms/traces.md#hand-it-to-a-coding-agent) packages one page as text for a single paste; MCP is for an agent that needs to keep asking - follow a trace, check whether the error is still firing - without you relaying each answer.

## An example investigation

The tools are shaped around investigations rather than endpoints, so each answer carries the key the next question needs. A deploy went out and something feels wrong:

1. **"What regressed after the last deploy?"** - `find_regressions` compares error rate and latency either side of each release boundary and names the release that made things worse, along with the operations it degraded. `diff_release` then says what that release changed in the code - an N+1, a new outbound call, a slower method.
2. **"Show me that operation."** - `get_operation_details` returns the route's latency and error summary plus recent individual requests, each with a `traceId`.
3. **"What did that request actually do?"** - `get_trace` resolves the trace id into the waterfall: every execution under it, across services, with span trees.
4. **"What did the code say while it happened?"** - `get_trace_logs` returns every log line emitted under the same trace id, in order.

Errors and background jobs follow the same shape: `list_error_groups` → `get_error_details` → `get_trace`, and `list_jobs` → `get_job_details` → `get_trace`. Start with `list_projects` in any case - almost every diagnostic tool takes a `projectId`.

## Getting a token

Personal MCP tokens are minted in the dashboard under [MCP tokens](https://www.observe.nestjs.com/dashboard/mcp-tokens).

- Click **Create token**, give it a name, and optionally set an expiry. A token with no expiry never expires - MCP clients have no refresh flow.
- The secret (`omcp_...`) is shown **once**, in the response to creating it. Copy it immediately; only its hash is stored, so it cannot be retrieved again. Lost it? Revoke the token and mint another.
- Tokens act **as the user who created them**, with their exact project permissions. If you can't see something in the dashboard, neither can the token.
- MCP follows the plan that pays for each project. If your own plan includes MCP, the token reaches every project you can see. If it doesn't - say you're on Free, invited into a team on a paid plan - the token reaches only the projects whose plan includes MCP, and the others refuse with a 403.

Revoking a token from the same page cuts it off immediately. The list shows each token's name, expiry, and when it was last used, which is how you tell a token still in use from one to retire.

> [!INFO] Token management itself is dashboard-only, on purpose: an MCP token cannot mint or revoke MCP tokens, so a leaked credential can't extend its own life.

## Connecting a client

Any client that speaks Streamable HTTP can connect: there's one URL and one header, and no OAuth dance to sit through. What differs between clients is only where the config file lives and what its keys are called.

### Claude Code

```bash
claude mcp add observe --transport http https://observe-api.nestjs.com/mcp --header "Authorization: Bearer <token>"
```

### Claude Desktop, and other `mcpServers` clients

The block most clients read - Claude Desktop, and anything that copied its shape. Claude Desktop's config is at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "observe": {
      "url": "https://observe-api.nestjs.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### Cursor

The same `mcpServers` shape, in `~/.cursor/mcp.json` for every project or `.cursor/mcp.json` for one. Cursor expands `${env:...}` inside `url` and `headers`, which is how you keep the token out of a file you might commit:

```json
{
  "mcpServers": {
    "observe": {
      "url": "https://observe-api.nestjs.com/mcp",
      "headers": { "Authorization": "Bearer ${env:OBSERVE_MCP_TOKEN}" }
    }
  }
}
```

### VS Code (Copilot agent mode)

VS Code uses `servers` rather than `mcpServers`, wants an explicit `type`, and can prompt for the token once and store it encrypted instead of keeping it in the file. In `.vscode/mcp.json` for one workspace, or your user `mcp.json` for all of them:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "observe-token",
      "description": "NestJS Observe MCP token",
      "password": true
    }
  ],
  "servers": {
    "observe": {
      "type": "http",
      "url": "https://observe-api.nestjs.com/mcp",
      "headers": { "Authorization": "Bearer ${input:observe-token}" }
    }
  }
}
```

### Your own agent

With the official TypeScript SDK, the endpoint is a `StreamableHTTPClientTransport` and the token rides in `requestInit.headers`:

```ts
const client = new Client({ name: "my-agent", version: "1.0.0" });

await client.connect(
  new StreamableHTTPClientTransport(
    new URL("https://observe-api.nestjs.com/mcp"),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${process.env.OBSERVE_MCP_TOKEN}` },
      },
    }
  )
);

const { tools } = await client.listTools();
```

Python and the other official SDKs expose the same two knobs - a URL and request headers - under their own names.

### Checking the connection

Before debugging a client's config, confirm the endpoint and token work at all. This lists the tools the server would advertise:

```bash
curl -s https://observe-api.nestjs.com/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A tool list back means the credential is good and anything still broken is client-side. A 401 means the token is - see [When something fails](#when-something-fails).

> [!INFO] Clients disagree about key names (`mcpServers` vs. `servers`), and some want a `type` (`"http"` or `"streamable-http"`) that others infer from the URL. If yours isn't listed, look for its remote-server syntax and fill in the same two values: the URL and an `Authorization: Bearer` header.

A dashboard session JWT also works as a bearer credential, which is handy if your client already holds one - the server can't tell the two apart once they resolve to a user. Personal MCP tokens are still the intended long-lived credential: they outlive a session, they're revocable one at a time, and they carry a name so you know which client to cut off.

## Available tools

Almost every tool only reads; the ones that write are listed under [Setting up a service](#setting-up-a-service) and [Resolving an issue](#resolving-an-issue). Descriptions below are the ones the server advertises to your client.

Every answer ends with the dashboard pages it came from, in a text block after the JSON: the page itself, and for pages that exist per row - a trace, an error class, a job - a template such as `.../traces/{traceId}` the agent fills from the row. When an agent tells you something, the chart it read that from is one click away. Links are built from the API's configured dashboard address, and the JSON before them is exactly what it was without them.

Most diagnostic tools share a scope: a required `projectId`, an optional `applicationId` to narrow to one service, and an optional `timeInterval` look-back window (`1h`, `3h`, `12h`, `1d`, `3d`, `7d`, `30d`), defaulting to `1d`.

### Navigation

| Tool                  | What it answers                                                                                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_projects`       | Every project you're a member of, with team and application counts. Start here to resolve project ids.                                                                                                                                                               |
| `get_project`         | One project by id, including your access level (read/write/admin) and subscription state.                                                                                                                                                                            |
| `list_issues`         | [Issues](https://www.observe.nestjs.com/llms/issues.md) across your projects, newest first; filterable by project, status, or limit.                                                                                                                                                         |
| `get_issue`           | One issue by id, including its comments and activity.                                                                                                                                                                                                                |
| `get_incident_record` | An issue's [incident record](https://www.observe.nestjs.com/llms/issues.md#incident-record): what it was about, when it started and ended, the release it came in with, the users and customers it reached, the fix and its verification, and a timeline of those moments.                   |
| `list_slos`           | A project's [SLOs](https://www.observe.nestjs.com/llms/slos.md) with current status and error-budget burn. A burning SLO names the operation to investigate next; one [declared in code](https://www.observe.nestjs.com/llms/sdk.md#declaring-objectives-in-code) names the handler that declares it (`declaredIn`). |
| `list_alert_rules`    | The [alert rules](https://www.observe.nestjs.com/llms/alerts.md) across every project you can see.                                                                                                                                                                                           |
| `list_alert_events`   | The firing history, newest first. Filter by rule, project, state, severity, or a `since`/`until` window on when events started; page older history by passing the oldest `startedAt` you've seen as `until`.                                                         |
| `search`              | Full-text search over your projects, applications, alert rules, SLOs, and issues.                                                                                                                                                                                    |

### Diagnostics - regressions

| Tool               | What it answers                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `find_regressions` | Releases (service versions) that made things worse: error rate and latency before vs. after each release boundary, classified better/worse/stable, with the specific operations each bad release degraded. Takes an optional `windowMinutes` for the comparison window either side of a boundary.                                                                        |
| `diff_release`     | What one release changed in the code: the queries, outbound calls and NestJS methods whose calls per request or own time per call moved across its boundary by more than noise - a new N+1, a call it started making, a method grown slow - ranked by the time each adds to an average request. Pass the `version` and `applicationId` you used with `find_regressions`. |

### Diagnostics - requests

| Tool                    | What it answers                                                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_slow_operations`  | The slowest HTTP operations in the window, p95-ranked, with volume alongside - so effort goes to what's slow _and_ hot.                                                                                                                   |
| `get_operation_details` | One route (`operationId`, optionally `method`): latency and error summary plus recent individual requests, each with duration, status, and `traceId`.                                                                                     |
| `get_trace`             | A `traceId` resolved to every execution that ran under it - across services, requests, and jobs - each with its span tree (name, duration, start offset, errors). The [waterfall](https://www.observe.nestjs.com/llms/traces.md#reading-the-waterfall). |
| `get_trace_logs`        | Every log line emitted under a `traceId`, in order: what the code said while that waterfall was happening.                                                                                                                                |

### Diagnostics - errors

| Tool                 | What it answers                                                                                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_error_groups`  | Errors [grouped by fingerprint](https://www.observe.nestjs.com/llms/telemetry.md#grouping-errors-into-defects), ranked by occurrence count. Each group carries its class, a verbatim sample message and stack trace, first/last seen, and the release that introduced it. |
| `get_error_details`  | Recent occurrences of one error class: per-occurrence message, status, user, and `traceId`, plus a summary.                                                                                                                                                 |
| `get_error_trend`    | Whether errors are growing or decaying over the window, already classified as a direction. Scope it to one class to ask whether a specific bug is getting worse.                                                                                            |
| `get_affected_users` | The blast radius of one error class: which end users hit it and how often. Turns "an error exists" into "this many people are affected".                                                                                                                    |

### Diagnostics - jobs

| Tool              | What it answers                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `list_jobs`       | Background job (queue worker) performance in the window, per job name and queue: volume, duration, and failure counts.         |
| `get_job_details` | One job name on one queue: duration and wait-time summaries plus recent individual executions, each with status and `traceId`. |

### Diagnostics - code and dependencies

| Tool                | What it answers                                                                                                                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_classes`      | Where the time goes per NestJS class - controllers, providers, repositories - as on the [Services](https://www.observe.nestjs.com/llms/telemetry.md#services) page: own time, total time, calls, errors, and each class's share of all own time. Sorted by own time unless you ask for `totalDuration` or `callCount`. |
| `get_class_methods` | The methods of one class, with the same own/total split, calls, and errors: which method of a hot class is the hot one.                                                                                                                                                                        |
| `get_service_map`   | Who calls whom across the project, as on the [Map](https://www.observe.nestjs.com/llms/telemetry.md#map): applications, queues, databases, and external hosts, with calls, errors, and the heaviest statements or endpoints behind each link. Always the whole project; `timeInterval` only.                           |

### Setting up a service

The path from "not instrumented" to "reporting". `list_applications` reads; the other three write, and each goes through the same service as the matching dashboard button, so your role on the project and your plan's limits apply exactly as they do there, and a refusal comes back as the tool's answer.

| Tool                 | What it does                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_applications`  | The applications of one project. Check it before creating a duplicate.                                                                                                    |
| `create_project`     | Creates a project, in an existing team (pass its id) or a new one named after the project.                                                                                |
| `create_application` | Registers one NestJS service in a project. The name sticks, and should match the `serviceId` you give the SDK.                                                            |
| `create_api_key`     | Issues the key pair the SDK authenticates with. The secret is returned once; a well-behaved client writes it to your git-ignored environment file and does not repeat it. |

With these an agent can take a repository from "not instrumented" to "reporting" in one request: _"Set up NestJS Observe for this service"_ becomes `list_projects` -> `create_application` -> `create_api_key`, then the install and the three code edits from the [SDK guide](https://www.observe.nestjs.com/llms/sdk.md).

### Resolving an issue

The one write outside setup, because the agent that just shipped the fix is the one thing that knows which release carries it. Left for someone to tick later, the version is guesswork and verification starts watching in the wrong place.

| Tool            | What it does                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resolve_issue` | Marks an issue resolved after a fix ships, which starts [fix verification](https://www.observe.nestjs.com/llms/issues.md#fix-verification) against the pre-incident baseline. Pass `fixedInVersion` to hold the watch until the release carrying the fix appears in telemetry. |

### What MCP cannot do

Nothing can be deleted, renamed or revoked over MCP. Issues can be resolved but not otherwise edited, and alert rules, SLOs and error-group status can't be changed at all - those stay in the dashboard. Whether more writes arrive is not yet decided.

Two smaller shapes worth knowing: tool results drop the time-bucketed chart series the dashboard endpoints return, because hundreds of bucket values cost context and say less than the summary derived from them. And `GET` and `DELETE` on `/mcp` answer 405 - both concern sessions, and this endpoint has none.

## When something fails

- **401** - the token is missing, expired, revoked, or the `Authorization` header is malformed. It must read `Authorization: Bearer <token>`, with a personal token (`omcp_...`) or a dashboard JWT. Check the token is still listed under [MCP tokens](https://www.observe.nestjs.com/dashboard/mcp-tokens).
- **405** - the client sent `GET` or `DELETE`. Every MCP request to this endpoint is a `POST`.
- **A tool result with `isError: true`** - the transport worked and the request was answered; the underlying read simply failed for an ordinary reason, such as "project not found" or no access to it. The message says which. A guessed project id coming back 404 is an answer for the agent, not a broken connection.

## Where to go next

- [Traces & spans](https://www.observe.nestjs.com/llms/traces.md) - what `get_trace` returns, and the one-paste alternative for handing a single failure to a coding agent.
- [Telemetry](https://www.observe.nestjs.com/llms/telemetry.md) - the dashboard views these tools read from.
- [Overview → Access control](https://www.observe.nestjs.com/llms/overview.md#access-control) - the permissions a token inherits from you.
