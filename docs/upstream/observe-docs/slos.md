# SLOs

Source: https://www.observe.nestjs.com/documentation/slos

SLOs turn "error rate above 5%" into "we promised 99.9% and we're spending the budget too fast." They're objectives over telemetry you're already collecting - no new instrumentation required. SLOs are available on Scale and Enterprise, with up to 50 per project.

![SLO list](https://www.observe.nestjs.com/docs/slos/slos.webp)

## The model

An SLO is built from three layered ideas:

- **SLI (service level indicator)** - a ratio of good events to total events, over a window. Not a raw reading: "fraction of requests under 300ms" is an SLI, "p95 latency" is not.
- **Objective** - the SLI plus a target percentage (90–99.999%) over a rolling compliance window (7, 14, 28, or 30 days).
- **Error budget** - how much room you have to miss the target, derived as `1 − target`. **Burn rate** is how fast that budget is being spent: a burn rate of 1.0 means spending it exactly on schedule to run out right at the end of the window; 14.4 means the whole 28-day budget would be gone in about two days at the current rate.

## SLI kinds

| Kind         | A "good" event is...                               |
| ------------ | -------------------------------------------------- |
| Availability | A request that didn't produce an unhandled error   |
| Latency      | A request that completed under a threshold you set |
| Job success  | A job run that completed rather than failed        |

By default, a handled error still counts as good - it produced a response the caller could use. You can flip that per SLO if a handled-error-as-4xx genuinely means broken for your service.

An SLO can watch a whole project, one application, or narrow further to a single route or job, exactly like an alert rule's scope.

## Declared in code

An SLO can also be declared next to the route it covers, with the SDK's `@Objective()` decorator - see [Declaring objectives in code](https://www.observe.nestjs.com/llms/sdk.md#declaring-objectives-in-code). Each promise the decorator makes becomes an SLO like any other, except that the code owns it: the list marks it **in code**, its page names the handler and the release that last declared it, and its objective changes when the decorator does - on the next deploy - rather than in the dashboard.

## No traffic isn't failure

If a window has no events at all, the SLI reads as "no traffic" rather than 100% (which would hide a dead service behind a green SLO) or 0% (which would page you every quiet night). No budget is burned during a window with nothing to measure.

## Reading the detail page

An SLO's detail page shows its objective as a plain sentence ("99.9% of requests under 300ms, rolling 28 days"), its current SLI, a budget bar (rendered as explicitly over-budget when it's gone negative, never clamped to empty), and burn rate over the last 1, 6, and 24 hours. Below that: a chart of the SLI against its target line, a budget staircase over time, and any burn-rate alert rules watching this SLO along with their recent firings.

![SLO detail](https://www.observe.nestjs.com/docs/slos/slo-detail.webp)

## Burn-rate alerts

Create an alert straight from an SLO's detail page - see [Alerts → SLO burn-rate alerts](https://www.observe.nestjs.com/llms/alerts.md#slo-burn-rate-alerts) for how the threshold and window work. A few starting points:

| Policy    | Window  | Threshold | Catches                                 |
| --------- | ------- | --------- | --------------------------------------- |
| Fast burn | 1 hour  | 14.4×     | 2% of a 28-day budget gone in one hour  |
| Slow burn | 6 hours | 6×        | 5% of a 28-day budget gone in six hours |
| Trickle   | 3 days  | 1×        | Steadily on track to miss the objective |

Deleting an SLO deletes any burn-rate alert rules built on it - they have nothing left to watch.

While the account that pays for the project has its overage [paused or stopped](https://www.observe.nestjs.com/llms/billing.md#while-overage-is-paused), those minutes are left out of the SLO: they don't count toward its compliance or spend its error budget, and they show as a gap on its chart. A pause keeps only server errors, so counting them would read as an outage the service never had. Burn-rate rules are skipped meanwhile, like every rule that reads requests or jobs - see [Alerts → While overage is paused](https://www.observe.nestjs.com/llms/alerts.md#while-overage-is-paused).

## Retention is the ceiling

A compliance window can't exceed how long your plan retains telemetry: on Scale (90 days), every window option is available; a 90-day plan can measure a 28-day objective, but a plan retaining less than 28 days can't offer that window.
