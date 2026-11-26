# Changelog

## 1.0.0 (2026-11-26)


### Features

* **analytics:** timeseries, jobs, metrics, runtime, releases, users, operation detail ([57fb5b0](https://github.com/sulthonuladib/nestjs-openobserve/commit/57fb5b073306fabf8b765bbf2efce0b0f74de2b6))
* **auth:** self-hosted identity — first-run setup, invites, RBAC, admin CLI ([a6f81d2](https://github.com/sulthonuladib/nestjs-openobserve/commit/a6f81d271dc2f84d3dc9dbc7b22171ab6927b330))
* **link:** device-code flow so `npx @nestjs/observe link` works against us ([972d36b](https://github.com/sulthonuladib/nestjs-openobserve/commit/972d36b5cc99cdee33a8408d1b55e6d948e880c0))
* **server:** Bun + ElysiaJS collector on Postgres/Drizzle ([ce56864](https://github.com/sulthonuladib/nestjs-openobserve/commit/ce56864846838eb8355c0bc551a1ddf1dc31f570))
* **web:** clone the reference dashboard — MUI shell, metric cards, Nivo charts, feature pages ([2ed4cd8](https://github.com/sulthonuladib/nestjs-openobserve/commit/2ed4cd89657c6d122cb72cd7fdc556036082caf2))
* **web:** dashboard SPA — overview, operations, executions, waterfall, errors, logs, link ([dbba651](https://github.com/sulthonuladib/nestjs-openobserve/commit/dbba651a618668741b83b6f1b8fa040e6b734601))
* **web:** setup, login and invite screens behind an auth gate ([ce407d7](https://github.com/sulthonuladib/nestjs-openobserve/commit/ce407d7da27baab20a37c3ec2d10c59583961116))
* **web:** wire the six feature pages into the router and the sidebar ([b59220e](https://github.com/sulthonuladib/nestjs-openobserve/commit/b59220ea0b3cab72a01e07250d82b3fb4b432b8a))


### Bug Fixes

* **cli:** the usage banner used the old binary name ([c66eb6b](https://github.com/sulthonuladib/nestjs-openobserve/commit/c66eb6b35eb11d975d5e018f32073e4c0b48416a))
* usable admin CLI locally, and isolate the test database ([51faeb5](https://github.com/sulthonuladib/nestjs-openobserve/commit/51faeb51ff5cf679c9fe5a89016ce53599183a80))
* **web:** serve the SPA for deep links and point the link URI at the hash route ([6147538](https://github.com/sulthonuladib/nestjs-openobserve/commit/6147538110301c49cdd173baf7548c3987d999cc))
