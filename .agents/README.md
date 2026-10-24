# Skills

Vendored agent skills, committed so every agent and every contributor gets the
same reference material.

| Skill | Source | Applies to |
|---|---|---|
| `elysiajs/` | https://github.com/elysiajs/skills (`elysia/`) | Elysia **2.0.0-rc** |

## Note on the Elysia skill

`elysiajs/SKILL.md` documents Elysia v2 (rc). This repo is on **Elysia 1.4.x**
until 2.0 is GA (see `docs/spec/tech-stack.md` §0), so read it as:

- **applicable now:** composition rules, plugin `name`/`seed` deduplication,
  `decorate` vs `state` vs `derive`, hook ordering, schema inference, the
  testing approach in `references/testing.md`;
- **not applicable yet:** anything tagged v2-only. Use
  `references/migration.md` to *recognise* differences, not as permission to
  upgrade.

For Elysia 1 the authoritative reference is https://elysiajs.com/llms.txt.

## Updating

```bash
git clone --depth=1 https://github.com/elysiajs/skills /tmp/elysia-skills
rm -rf .agents/skills/elysiajs && cp -r /tmp/elysia-skills/elysia .agents/skills/elysiajs
```

`bunx skills add elysiajs/skills` is interactive and needs a TTY; the copy above
is the same content.
