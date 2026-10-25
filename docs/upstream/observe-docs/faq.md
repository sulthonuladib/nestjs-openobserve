# FAQ

Source: https://www.observe.nestjs.com/documentation/faq

## What is NestJS Observe?

An auto-instrumented observability platform built specifically for NestJS. Install the [SDK](https://www.observe.nestjs.com/llms/sdk.md), add a project API key, and your application starts streaming requests, jobs, errors, logs, and traces to a dashboard - no collector to run, no schema to design, no dashboards to build by hand. See [Overview](https://www.observe.nestjs.com/llms/overview.md) for how accounts, teams, projects, and applications fit together.

## Can I see it before I install anything?

Yes - the [live demo](https://www.observe-demo.nestjs.com/dashboard) is the whole dashboard running over a generated dataset from a busy service: real request volumes, traces with waterfalls, errors, jobs and alerts. No signup, no credit card, nothing to install. It runs entirely in your browser, so nothing you do there touches an account.

## What makes it different?

Auto-instrumentation is built around Nest's own request lifecycle - controllers, interceptors, guards, queue consumers - rather than a generic Node.js agent bolted onto the framework. That's also why the [Services](https://www.observe.nestjs.com/llms/telemetry.md#services) view can show you time spent per NestJS class and method, in the vocabulary you wrote the code in, instead of only per HTTP route.

## How does the SDK work?

`ObserveModule.forRoot()` wires up automatic instrumentation for HTTP, RPC, gRPC, and job/queue consumers the moment your app boots - requests, errors, and traces show up in the dashboard within moments of your app receiving traffic, with no manual span wiring. `TracerService` is there for the rest: adding your own spans, capturing errors you handled yourself, and reporting custom metrics. See [SDK](https://www.observe.nestjs.com/llms/sdk.md) for the full setup.

## Can I use it with an existing app?

Yes. Run `npx @nestjs/observe link` in the app's directory: it installs the [SDK](https://www.observe.nestjs.com/llms/sdk.md), wires it into your root module and `main.ts`, and fetches an [API key](https://www.observe.nestjs.com/llms/applications.md#api-keys) into `.env` - and NestJS Observe starts collecting traces, logs, and errors from your existing application without any other changes. To do it by hand instead, install the SDK, make the three edits in [SDK → Quick start](https://www.observe.nestjs.com/llms/sdk.md#quick-start), and add your project's API key. It requires `@nestjs/core` v11.1.4 or later, and - if your application uses GraphQL - `@nestjs/graphql` v13.4.4 or later, since earlier versions of either package lack the hooks the SDK needs for proper instrumentation.

Instrumentation isn't limited to REST: `http`, `rpc`, and `grpc` are each covered and configured the same way in `ObserveModule.forRoot()`, and queue consumers and cron jobs are covered by the SDK's job instrumentation - they get their own [Jobs](https://www.observe.nestjs.com/llms/telemetry.md#jobs) view, with queue wait time and retry attempts alongside the usual duration and failure rate. A request that fans out from your API into another HTTP or RPC service still resolves to one [distributed trace](https://www.observe.nestjs.com/llms/traces.md), once that downstream service is set up to pick up the propagated trace id - see [SDK → Propagating trace ids between services](https://www.observe.nestjs.com/llms/sdk.md#propagating-trace-ids-between-services). Queue jobs need nothing extra: one added from inside a traced request carries that request's trace id to the worker that runs it (SDK 0.3.0 or later on both sides), while repeatable jobs, `@nestjs/schedule` handlers and jobs added outside any request start their own trace.

## What's an Observability Event?

Usage is metered in **Observability Events (OEs)** - one per request, background job run, error, log entry, or trace span your applications report. Each plan includes a monthly allowance of OEs, and what happens beyond it depends on the plan: **Free** keeps recording requests, jobs and errors past its 300k events, with most traces arriving without their spans, and refuses new telemetry at twice the allowance until the next billing period; **Pro** and **Scale** allow overage instead of a hard stop, billed per extra million events, so a busy month doesn't mean lost data; [spike protection](https://www.observe.nestjs.com/llms/billing.md#spike-protection) pauses overage when usage surges, server errors still collected, and an optional [monthly overage budget](https://www.observe.nestjs.com/llms/billing.md#monthly-overage-budget) caps what it can cost. Free also pauses most waterfalls for the rest of any UTC day that passes 30k events, so one noisy day can't spend the month - see [Free plan limits](https://www.observe.nestjs.com/llms/billing.md#free-plan-limits). Set **quota notifications** on the [Usage](https://www.observe.nestjs.com/llms/billing.md#usage) page (up to five thresholds, e.g. 50%/80%/100%) to get an email before you find out from the invoice. See [Billing & usage](https://www.observe.nestjs.com/llms/billing.md) for the full pricing table.

## Can I reduce telemetry volume?

Yes - [spend controls](https://www.observe.nestjs.com/llms/billing.md#spend-controls), configured per project on **Billing → Spend controls**: sample spans on a noisy project, cap ingestion with a rate limit, or drop known-noisy traffic like health checks, all with no redeploy. Sampling and drop filters never remove errors, since they're low-volume and exactly what you want when something breaks. A rate cap is a circuit breaker rather than a filter - once it engages, everything above it is refused, errors included - so set it well above your normal peak. [Cost attribution](https://www.observe.nestjs.com/llms/billing.md#cost-attribution) tells you which routes and jobs are worth targeting before you set one up.

## Why is my Spans page empty when Usage shows spans?

Because they count different things. Every request your application serves records a whole tree of **auto-instrumented** spans - the controller, each service and repository call - and each one is a separate [Observability Event](#whats-an-observability-event) under **Spans** on the Usage page. Database queries and outbound HTTP calls show up in the same tree but [aren't billed](https://www.observe.nestjs.com/llms/sdk.md#database-queries-and-outbound-http). That's normally the largest slice of a project's volume. The [Spans](https://www.observe.nestjs.com/llms/telemetry.md#spans) analytics page lists only the **custom** spans you named yourself with [`TracerService.createSpan()`](https://www.observe.nestjs.com/llms/sdk.md#creating-spans), so an application that never calls it has a busy Spans figure in Usage and an empty Spans page. The auto-instrumented ones are read per trace, in the [waterfall](https://www.observe.nestjs.com/llms/traces.md#reading-the-waterfall) on any request's detail page. To reduce the volume, turn on [span sampling](https://www.observe.nestjs.com/llms/billing.md#spend-controls) - it's trace-coherent, so sampled traces keep complete waterfalls.

## How long is my telemetry retained?

Retention is set by plan: 3 days on Free, 30 days on Pro, 90 days on Scale, and a negotiated period on Enterprise. Data older than your plan's window is deleted automatically. This is also the ceiling for other time-based features - an [SLO](https://www.observe.nestjs.com/llms/slos.md#retention-is-the-ceiling)'s compliance window, for instance, can't exceed how long your plan keeps the underlying data.

One exception, in the other direction: **trace spans are kept for 7 days rather than the full window when the execution was both fast and successful** - under 1 second, no 5xx, no failed job. Slow and failing executions keep their spans for the full window, and every execution keeps its own record either way. See [Traces → How long waterfalls are kept](https://www.observe.nestjs.com/llms/traces.md#how-long-waterfalls-are-kept).

## What if I cancel or downgrade?

If you cancel, your applications keep running and sending telemetry as normal, but you lose access to the dashboard once the subscription ends. If you downgrade to a plan with shorter retention, older data may expire sooner than it otherwise would - downgrading doesn't delete anything immediately, it just shortens how long new and existing data is kept going forward.

## Is my data redacted or identifiable?

Only what you choose to send, in both cases. When log forwarding (`forwardLogs`) is on, redaction is on by default the same moment it is - built-in patterns catch bearer tokens, JWTs, AWS key ids, PEM private keys, `key=value` secrets, and Luhn-valid card numbers, and you can add your own patterns or attribute-key names on top. Log forwarding itself is a Pro-and-above feature; see [SDK → Logs](https://www.observe.nestjs.com/llms/sdk.md#logs).

For users, `getUserId` reports whatever identifier your app already uses for a person - a user id, an account id, a tenant-scoped id - and the dashboard treats it as an opaque string; it's never resolved into a name, email, or anything else. Reporting a user identifier at all is optional, and it's recommended you use an internal id rather than anything personally identifying. See [Users](https://www.observe.nestjs.com/llms/users.md#reporting-a-user).

## Alerts vs. SLOs vs. Issues?

**Alerts** watch a metric and notify you the moment it crosses a threshold or deviates from its own baseline. **SLOs** are a longer-horizon view on top of the same telemetry - "99.9% of requests under 300ms over 28 days" - with an error budget and burn rate instead of a single reading; a burn-rate alert is just a regular alert rule pointed at an SLO. **Issues** are where the resulting work gets tracked - create one by hand, or have a firing alert open one automatically, pre-filled with severity and a link back to the telemetry that triggered it. See [Alerts](https://www.observe.nestjs.com/llms/alerts.md), [SLOs](https://www.observe.nestjs.com/llms/slos.md), and [Issues](https://www.observe.nestjs.com/llms/issues.md).

## Can I get notified if my app goes silent?

Yes, that's **absence detection**: a **Telemetry silence** rule fires once an application has gone quiet longer than a tolerance you set (2 minutes to 7 days), using the same runtime heartbeat the Profiler samples. A **Job silence** rule does the same for one named job, or for any job in the project if left unscoped. Neither fires on a scope that has never reported anything - "not yet integrated" isn't treated as "down." See [Alerts → Absence detection](https://www.observe.nestjs.com/llms/alerts.md#absence-detection).

## Does it support SSO and access roles?

SSO is available on Scale and Enterprise - configure a connection under **Teams → SSO**, verify the domains that should route through it, and enforcement only takes effect once you explicitly switch it on. Independently of SSO, every project member has one of three access levels - Read, Write, or Admin - controlling whether they can view telemetry, make changes, or manage members, settings, and billing. See [Applications → Single sign-on](https://www.observe.nestjs.com/llms/applications.md#single-sign-on) and [Overview → Access control](https://www.observe.nestjs.com/llms/overview.md#access-control).

## Why not self-host OpenTelemetry?

Auto-instrumentation, tracing, error monitoring, logs, and alerting come out of the box, so you don't need to stand up and operate your own collectors, storage, and dashboards to get the same visibility - and the instrumentation itself is written around Nest's request lifecycle rather than a generic setup you'd have to configure by hand.
