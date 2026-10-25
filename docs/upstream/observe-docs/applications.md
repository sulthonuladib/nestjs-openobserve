# Applications

Source: https://www.observe.nestjs.com/documentation/applications

An application represents a single NestJS service instrumented with the SDK - a REST API, a GraphQL server, a worker processing a queue, a microservice. Applications live inside a project, and a project's dashboard shows telemetry either per application or aggregated across all of them.

![Applications](https://www.observe.nestjs.com/docs/applications/applications.webp)

## Creating an application

From a project, open **Applications** and add a new one by name. Applications can also carry tags (see [Tags](#tags)) so you can group and filter them - by service type, by team, by whatever grouping makes sense for your project.

An application doesn't need any configuration beyond a name: everything else - the routes it serves, the jobs it processes, the metrics it reports - is discovered from the telemetry the SDK sends once it starts running.

Each row on the Applications list shows a **Last seen** column - when its runtime last reported in, from the same heartbeat signal a [telemetry silence alert](https://www.observe.nestjs.com/llms/alerts.md#absence-detection) watches. A silence long enough to matter is highlighted the same way an elevated error rate is, so an application going quiet is visible just by looking at the list, not only when an alert fires.

## API keys

To send telemetry, an application authenticates with a **project API key**. Generate one from the project's **API Keys** page.

![API keys](https://www.observe.nestjs.com/docs/applications/api-keys.webp)

Each key has a name (to identify it - one for local development, one for CI, one for production) and an optional expiration date. Give the key to the SDK via configuration or an environment variable when you instrument your application - see [SDK](https://www.observe.nestjs.com/llms/sdk.md). API keys are scoped to a project: any application whose telemetry should land in that project's dashboard uses the same key.

A key can also come from the terminal: approve the code `npx @nestjs/observe link` prints at [observe.nestjs.com/link](https://www.observe.nestjs.com/link), pick the application, and the command writes the new key into the project's `.env` - see [SDK → Linking from the terminal](https://www.observe.nestjs.com/llms/sdk.md#linking-from-the-terminal). Those keys are listed here like any other, named `CLI` and the time they were issued, and expire after a year.

Remove a key at any time from the same page; any application still using it will stop being able to send telemetry.

## Teams

A team is a collection of users. Every project belongs to exactly one team, so adding someone to a team gives them access to every project that team owns (subject to the [access level](https://www.observe.nestjs.com/llms/overview.md#access-control) they're given on each project). Manage your teams from the account-level **Teams** page.

![Teams](https://www.observe.nestjs.com/docs/applications/teams.webp)

Removing a user from a team removes their access to every project owned by that team.

## Members and access control

Within a project, invite members and set their [access level](https://www.observe.nestjs.com/llms/overview.md#access-control) - Read, Write, or Admin - from the project's **Members** page. An invited member who hasn't yet accepted shows as pending until they do.

![Members](https://www.observe.nestjs.com/docs/applications/project-members.webp)

## Single sign-on

Scale and Enterprise teams can require members to authenticate through an SSO connection instead of a password. Configure this from **Teams → SSO**: add the connection details, verify the domains you want routed through it, and switch on enforcement once at least one domain is verified. Enforcement is a deliberate, separate step from saving the connection - nothing is required of your team until you turn it on.

## Tags

Tags are labels, owned by a team, that you can attach to applications to organize them - for example by service type or by the part of the system they belong to. Manage the set of available tags from the account-level **Tags** page, then apply them to individual applications from an application's settings.
