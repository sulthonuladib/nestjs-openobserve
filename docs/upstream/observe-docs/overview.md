# Overview

Source: https://www.observe.nestjs.com/documentation/overview

NestJS Observe is auto-instrumented observability for NestJS applications. Install the SDK, add an API key, and your application starts streaming requests, jobs, errors, logs, and traces to your dashboard - no manual span wiring, no collector to run, no schema to design.

Every plan includes error monitoring, distributed tracing, and auto-instrumentation out of the box. Paid plans add logs streaming, alerting, team management, and - on Scale and above - SSO and SLOs.

> [!INFO] Prefer to look before you install? The [live demo](https://www.observe-demo.nestjs.com/dashboard) is this dashboard over a busy service's data - real traces, real waterfalls, no signup.

This page covers the concepts every other doc builds on: accounts, teams, projects, applications, and access control. For instrumenting an application, see [SDK](https://www.observe.nestjs.com/llms/sdk.md). For everything a project's dashboard shows about your telemetry, see [Telemetry](https://www.observe.nestjs.com/llms/telemetry.md).

## Where things are documented

| Page                                                  | Covers                                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [Applications](https://www.observe.nestjs.com/llms/applications.md) | Applications, API keys, teams, members, SSO, tags                                                                                          |
| [SDK](https://www.observe.nestjs.com/llms/sdk.md)                   | Instrumenting a NestJS application                                                                                                         |
| [Telemetry](https://www.observe.nestjs.com/llms/telemetry.md)       | Requests, class-level attribution, errors, jobs, spans, custom metrics, releases, logs, and how to drill from a chart to one execution     |
| [Traces & spans](https://www.observe.nestjs.com/llms/traces.md)     | The waterfall, self time, error source frames, trace correlation across services, log correlation, and handing a failure to a coding agent |
| [MCP server](https://www.observe.nestjs.com/llms/mcp.md)            | Querying your telemetry from an MCP-compatible agent: tokens, client setup, and the available tools                                        |
| [Users](https://www.observe.nestjs.com/llms/users.md)               | Per-user activity, grouped actions, replays, and endpoint paths                                                                            |
| [Profiler](https://www.observe.nestjs.com/llms/profiler.md)         | CPU, memory, event loop, garbage collection, and per-instance comparison                                                                   |
| [Alerts](https://www.observe.nestjs.com/llms/alerts.md)             | Rules, thresholds, anomaly detection, channels, history                                                                                    |
| [SLOs](https://www.observe.nestjs.com/llms/slos.md)                 | Objectives, error budgets, burn-rate alerts                                                                                                |
| [Issues](https://www.observe.nestjs.com/llms/issues.md)             | Tracking the work that comes out of your telemetry                                                                                         |
| [Billing & usage](https://www.observe.nestjs.com/llms/billing.md)   | Plans, Observability Events, retention, cost attribution, spend controls                                                                   |

![Projects overview](https://www.observe.nestjs.com/docs/overview/projects.webp)

## Teams, projects, and applications

NestJS Observe organizes your telemetry in three layers:

- A **team** is a collection of users. Every project belongs to exactly one team, and team membership is how you grant someone access to more than one project at a time. See [Teams](https://www.observe.nestjs.com/llms/applications.md#teams).
- A **project** is a collection of applications that ship together, typically one per product or environment (e.g. `storefront-production`, `storefront-staging`). Projects are what alerts, issues, SLOs, and API keys are scoped to.
- An **application** is a single NestJS service - a REST API, a worker, a microservice - instrumented with the SDK and reporting into a project. A project usually has more than one application: a web API and the queue workers behind it, for example, so you can see them as one system while still filtering down to either.

## First project

The quickest start is from your NestJS project's directory: run `npx @nestjs/observe link` and type the code it prints at [observe.nestjs.com/link](https://www.observe.nestjs.com/link) - signing up first if you're new. Approving creates the project and the application on the spot if you don't have them yet, and the command writes the new key pair into the project's `.env`. If the app doesn't use the [SDK](https://www.observe.nestjs.com/llms/sdk.md) yet, the command installs it and wires it in as well - see [SDK → Linking from the terminal](https://www.observe.nestjs.com/llms/sdk.md#linking-from-the-terminal).

Starting from the dashboard instead, a new account is met by a short **setup guide**: accept the invitation and it walks you through the real pages - it highlights _Create Project_, then takes you to the new project to add an application and an API key, and finishes on the banner that waits for your first event. Turn it down and it stays away for good in that browser; the empty projects table still offers "Walk me through it" whenever you want it back.

Setting up with a coding agent instead? The dialog that shows a new API key's secret has a **Copy setup prompt** button: the install command, the three code edits and the new credentials as one prompt to paste into Claude Code, Cursor or similar. An agent connected to the [MCP server](https://www.observe.nestjs.com/llms/mcp.md#setting-up-a-service) can go one further and create the application and the key itself.

Doing it by hand: create a project and give it a name. Once the project exists, add your first application to it and generate an API key for that project - see [Applications](https://www.observe.nestjs.com/llms/applications.md) for the walkthrough. With the API key in hand, follow the [SDK](https://www.observe.nestjs.com/llms/sdk.md) guide to instrument your NestJS app; telemetry starts appearing in the dashboard within moments of your app receiving traffic.

![Create project](https://www.observe.nestjs.com/docs/overview/create-project.webp)

## Getting telemetry to an agent

Two ways, and they're for different moments:

- **[Copy agent prompt](https://www.observe.nestjs.com/llms/traces.md#hand-it-to-a-coding-agent)** turns one page - a failed request, a slow job, a failing trace - into a self-contained markdown prompt. One click, one paste, one question. Best when you already know which execution is the problem and want a coding agent to go fix it.
- **[The MCP server](https://www.observe.nestjs.com/llms/mcp.md)** connects an MCP-compatible client (Claude Code, Claude Desktop, your own agent) straight to the API, so the agent can keep asking: investigate a regression, follow a trace into its logs, check whether an error is still happening - without you relaying each answer back. Scoped to exactly what you can see in the dashboard, and read-only apart from setting up a service and resolving an issue once its fix ships.

## Observability Events

Usage is metered in **Observability Events (OEs)** - one per request, background job run, error, log entry, or trace span your applications report, and these compound: a request with its spans, logs, and any error it raised is several events, not one. The one kind of span that does not count is the agent's own database-query and outbound-HTTP spans - they are detail about a method span already counted. This is the number your plan's monthly allowance and retention window are measured against. See [Billing & usage](https://www.observe.nestjs.com/llms/billing.md) for the full pricing model, and [Spend controls](https://www.observe.nestjs.com/llms/billing.md#spend-controls) for ways to reduce what you send without touching your code.

## Access control

Every project member has one of three access levels. Manage members from a project's **Members** page.

| Capability                                        |    Read     | Write |    Admin     |
| ------------------------------------------------- | :---------: | :---: | :----------: |
| **Project**                                       |             |       |              |
| View the project and its telemetry                |      ✓      |   ✓   |      ✓       |
| Rename the project / change its avatar            |      ✗      |   ✗   |      ✓       |
| Delete (archive) the project                      |      ✗      |   ✗   | creator only |
| **Members**                                       |             |       |              |
| See the member list                               |      ✓      |   ✓   |      ✓       |
| Invite, change roles, remove members              |      ✗      |   ✗   |      ✓       |
| **Issues**                                        |             |       |              |
| View issues                                       |      ✓      |   ✓   |      ✓       |
| Comment on an issue                               |      ✓      |   ✓   |      ✓       |
| Delete your own comment                           |      ✓      |   ✓   |      ✓       |
| Delete someone else's comment                     |      ✗      |   ✗   |      ✓       |
| File an issue                                     |      ✗      |   ✓   |      ✓       |
| Edit an issue (status, severity, title, assignee) | author only |   ✓   |      ✓       |
| Add or remove attachments                         | author only |   ✓   |      ✓       |
| Delete an issue                                   | author only |   ✓   |      ✓       |
| **Alerts**                                        |             |       |              |
| View alert rules and alert events                 |      ✓      |   ✓   |      ✓       |
| Create, edit, delete alert rules                  |      ✗      |   ✓   |      ✓       |
| **SLOs**                                          |             |       |              |
| View SLOs and error budgets                       |      ✓      |   ✓   |      ✓       |
| Create, edit, delete SLOs                         |      ✗      |   ✓   |      ✓       |
| **Applications**                                  |             |       |              |
| View applications                                 |      ✓      |   ✓   |      ✓       |
| Create, edit, delete applications                 |      ✗      |   ✓   |      ✓       |
| **API keys**                                      |             |       |              |
| List keys (name, application, last used)          |      ✓      |   ✓   |      ✓       |
| Create and revoke keys                            |      ✗      |   ✓   |      ✓       |
| **Billing**                                       |             |       |              |
| View spend caps, budgets, and current spend       |      ✗      |   ✗   |      ✓       |
| Change caps, sampling, and drop filters           |      ✗      |   ✗   |      ✓       |

The author of an issue keeps control of it regardless of role, so someone who filed
an issue before losing write access can still correct or withdraw it.

API key **secrets** are shown once, at creation, and are never retrievable afterwards
by any role.

### Rules that apply on top of roles

- **An active subscription is required for most changes.** Creating applications, API
  keys, or issues, and editing issues, all require the project host's subscription to
  be active. Renaming a project also requires the caller's own subscription to be active.
- **Removing members requires the Enterprise plan.** An Admin on a lower plan can invite
  members and change roles, but cannot remove them.
- **The project creator is protected:** their role cannot be downgraded and they cannot
  be removed, even by another Admin.
- **Admins cannot change their own role,** and nobody can remove themselves from a project.
- **Non-members cannot tell a private project from a nonexistent one** — requests fail
  identically either way.

### Not governed by project roles

- **Subscriptions and payment** (invoices, billing portal, plan changes) belong to the
  account holding the subscription, not to any project role. The project-scoped part of
  billing is spend controls, which is Admin-only.
- **Tags are team-scoped** — creating and editing them depends on team membership.

## Billing

Subscriptions are managed per team, from **Billing → Manage subscription**. See [Billing & usage](https://www.observe.nestjs.com/llms/billing.md) for plan details, how usage is tracked, and how to control ingestion spend before it hits your bill.
