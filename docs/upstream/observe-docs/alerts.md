# Alerts

Source: https://www.observe.nestjs.com/documentation/alerts

Alerts get you told when your telemetry crosses a threshold you care about, instead of you finding out from a customer. Alert rules are available on Pro, Scale, and Enterprise.

![Alert rules](https://www.observe.nestjs.com/docs/alerts/rules.webp)

## What a rule watches

A rule watches one **metric**, drawn from one of a few families:

| Family  | Metrics                                          | Scoped to                                           |
| ------- | ------------------------------------------------ | --------------------------------------------------- |
| Request | Error rate, p95 latency, avg latency, throughput | An application, and optionally one route + method   |
| Job     | Job failure rate, job throughput, p95 queue wait | An application, and optionally one job name + queue |
| Absence | Telemetry silence, job silence                   | An application, or one job name + queue             |
| Logs    | Matching log lines                               | A pattern, and optionally levels + logger context   |
| Errors  | New error groups                                 | An application, or the whole project                |
| Runtime | Event loop delay, CPU usage, memory usage        | An application (sampled per process)                |
| Custom  | Any custom metric your application reports       | A metric name, and optionally one label             |
| SLO     | SLO burn rate                                    | The SLO itself - see below                          |

Leaving the operation unset watches the whole application rather than a single route or job.

## Absence detection

Every metric above fires on data that arrived and crossed a line. **Telemetry silence** and **Job silence** fire on data that stopped arriving at all - your app went quiet, or a cron didn't run.

- **Telemetry silence** watches an application's runtime heartbeat - the same profiler samples that flow even when the app is otherwise idle - and fires once it's been silent longer than the tolerance you set (2 minutes to 7 days). There's no threshold number to reason about here beyond that duration: the rule fires the moment silence exceeds it, and resolves the moment data resumes.
- **Job silence** does the same for one job, identified by name and optionally narrowed to a queue. Leave both blank to watch whether _any_ job in the project has run recently.

Both read "silent for over 15 min" rather than a metric crossing a threshold, because that's the honest description of what happened - nothing was read at all. A scope that has never reported _anything_ doesn't fire: "not yet integrated" isn't "down," and the rule simply waits for its first reading before it starts the clock. When a silence rule does fire, its firing history shows how long the gap ran and exactly when data was last seen.

This is both lightweight uptime monitoring (no external probe needed - your own runtime metrics are the heartbeat) and Sentry-Crons-style job monitoring, from the same mechanism. The same "last seen" signal also drives the badge on each application's card in [Applications](https://www.observe.nestjs.com/llms/applications.md), so a silence you'd notice from an alert is visible ambiently too.

## New errors

A **new error groups** rule fires when an error Observe has never seen before appears - a new fingerprint, not a recurrence of a known one. "Above 0" over a short window is the canonical rule.

It counts **unhandled failures only**: a group whose first occurrence answered 5xx, or that failed on an entry point with no HTTP status at all (an RPC handler, a gateway message). A failed job doesn't open an error group - watch jobs with a [job failure rate](#what-a-rule-watches) rule. An error your code threw on purpose - a `NotFoundException`, a failed validation, a wrong password - still appears in the [Errors](https://www.observe.nestjs.com/llms/telemetry.md#errors) list, but it is not a new bug, and a rule that fires the first time a crawler requests a page that doesn't exist teaches its owner to ignore it. Groups you marked _ignored_, and groups your error filters mark _expected_, are never counted.

### The built-in new-error email

Every plan, Free included, gets this without creating a rule: when a project reports an unhandled error it has never seen before, its members get one email listing the new errors (up to five, then "+N more"), at most six emails per project per day. Turn it off for yourself under **Settings → New error emails**; every email's footer links there. A project that already has its own _new error groups_ rule with an email channel is skipped, so nobody is told twice.

## Log-pattern alerts

**Matching log lines** counts how many log lines contain a substring within the evaluation window, and fires when that count crosses a threshold - "alert me when `payment declined` appears more than 10 times in 15 minutes." The pattern is a plain substring match, case-insensitive, never a regular expression; it needs at least 3 characters, since anything shorter can't use the search index that makes the check cheap. Optionally narrow by log level or logger context (Nest's `[PaymentsService]` label).

The rule builder shows a live preview - "would have matched 37 lines in the last hour" - against the same filters the rule will evaluate, so you're not guessing whether a pattern is too broad or too narrow before saving it. When the rule fires, the event carries up to five of the matching lines (message, context, timestamp, trace) so you can see what tripped it without leaving the alert.

Log-pattern alerts require a plan with logs streaming - see [Billing & usage](https://www.observe.nestjs.com/llms/billing.md).

## Queue wait alerts

Job failure-rate alerts tell you after a backlog has already burned through; **p95 queue wait** tells you while it's growing. It watches how long jobs sit enqueued before a worker picks them up, at the 95th percentile, and can be scoped to one job, one queue, or both. It behaves like any other windowed metric - normal comparisons, normal evaluation windows - and points at the same queue-wait chart shown on a job's detail page in [Telemetry](https://www.observe.nestjs.com/llms/telemetry.md#jobs).

## Threshold vs. anomaly detection

Every rule runs in one of two modes:

- **Fixed threshold** - fires when the metric goes **above** or **below** a number you set (e.g. "error rate above 5%").
- **Anomaly detection** - fires when the metric deviates from its own recent baseline by more than a **sensitivity**, expressed in sigma-equivalents (default 3.5, valid from 1 upward). Here "above" means a spike over the baseline and "below" means a collapse under it - there's no fixed number to reason about, just how unusual the behavior is relative to normal for that metric.

Silence, log-pattern, and queue-wait rules are threshold-only - a duration or a count has no baseline to deviate from, so anomaly mode isn't offered for them.

## Evaluation window

A rule evaluates over a rolling window - 5, 10, 15, 30, 60, or 180 minutes. Shorter than 5 minutes isn't offered: below that, a single slow call can move a p95 reading enough to fire on nothing. (SLO burn-rate rules get longer windows too - see [SLOs](https://www.observe.nestjs.com/llms/slos.md#burn-rate-alerts).) Silence rules don't use a window at all - each check is "how old is the newest data," not "what happened over the last N minutes" - so the builder replaces it with the tolerance described [above](#absence-detection).

## Severity and channels

Every rule has a **severity** - Low, Medium, High, or Critical - carried onto anything the rule triggers downstream, including an issue if you route it to one. A rule can notify through any combination of:

- **Email**
- **Slack**, via an incoming webhook URL from your Slack workspace
- **Webhook**, a generic HTTP callback to any endpoint you control
- **Create issue**, opening an [issue](https://www.observe.nestjs.com/llms/issues.md) automatically, pre-filled with the rule's severity and scope
- **In-app**, showing up in your notifications feed

![Create alert](https://www.observe.nestjs.com/docs/alerts/create-alert.webp)

## Quiet hours

Any rule can carry a recurring mute schedule - a staging project that goes quiet overnight, a batch window that's expected to be noisy, a maintenance slot you don't want paging anyone. Turn on **Mute on a schedule** and add one or more windows: the days it starts on, a from/to time, and the timezone the times are read in.

A window's days are the days it _starts_ on, not every day it covers. An overnight window - 22:00 to 06:00 - ticked for Monday runs quiet until Tuesday morning; ticking Tuesday as well would additionally silence Tuesday evening, which is a different schedule. The builder reads each window back as a sentence ("Mon, Tue, Wed, Thu, Fri 22:00 → 06:00 next day") so this is never left to be inferred from two time fields. **Weeknights** and **Weekends** presets cover the common cases in one click.

Times are wall-clock in the timezone you pick, not a fixed offset - daylight saving is handled from the zone name, so a schedule set once doesn't drift or need re-editing twice a year. The picker defaults to your browser's own timezone.

**Muted is its own state, not "OK."** While a window is open, the rule keeps evaluating but notifies nobody; a rule that was already firing when the window opened stays firing rather than being marked healthy, and resumes notifying the moment the window closes. The rule's status chip reads **Muted** (or **Firing · muted** if it's mid-incident) so a quiet rule is never mistaken for a healthy one.

## While overage is paused

When [spike protection or a monthly overage budget](https://www.observe.nestjs.com/llms/billing.md#while-overage-is-paused) pauses the overage of the account that pays for a project, the project keeps only its server errors past the account's included events - and a $0 budget's stop keeps nothing. Read against that, an error rate looks like 100%, throughput collapses and jobs seem to stop, so the rules that read requests, jobs or logs are skipped until the pause lifts: error rate, p95 and avg latency, throughput, job failure rate, job throughput, p95 queue wait, telemetry silence, job silence, matching log lines and SLO burn rate.

Skipped is stricter than muted: nothing is compared at all, and each rule keeps the state it had when the pause began. **New error groups**, runtime metric and custom metric rules keep running, though during a $0 budget's stop nothing new arrives for them to read.

## History

A firing rule moves through states - **OK → Firing → Resolved** - and every transition is recorded, quiet hours included: a rule's detail page shows its mute schedule alongside its condition, so "why didn't this page anyone" is answered on the same screen as "what does this watch." **Alert history** shows every firing across every project, with the delivery status (delivered, pending, failed) of each channel it notified.

![Alert history](https://www.observe.nestjs.com/docs/alerts/history.webp)

## SLO burn-rate alerts

A burn-rate alert is a regular alert rule pointed at an [SLO](https://www.observe.nestjs.com/llms/slos.md) instead of a raw metric - its threshold is a multiple of the SLO's sustainable burn rate rather than a reading, so "above 14.4×" means "burning the error budget fast enough to exhaust a 28-day objective in about two days." Create one from an SLO's detail page; scope, comparison, and detection mode are fixed by the SLO itself, so the form only asks for the multiple and the window.
