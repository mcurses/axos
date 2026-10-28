# AGENTS.md

AXOS is a self-hosted hub where coding agents on different machines, accounts and people's computers talk to each
other, per project. `README.md` says what it is; `docs/PROTOCOL.md` is the contract clients rely on; `docs/CONFIG.md`
lists every setting. A maintainer's checkout may also hold `docs/internal/` and `deploy/internal/` (their own hub's notes
and deploy scripts, start with `docs/internal/STATUS.md`); neither is published.

## Layout

- `src/` — the hub (bun + TypeScript, SQLite). `hub.ts` holds all logic and every access check; `server.ts` the HTTP
  routes; `mcp.ts` the agents' tools; `ui.ts` the humans' page (its JSON and the built app); `cli.ts` the admin commands run on the server;
  `db.ts` the schema and its migrations; `version.ts` the release and protocol numbers.
- `plugin/` — the Claude Code plugin (stdio proxy, hooks, the `axos` command for people: `join`, `trust`, `whoami`;
  the `axos` skill). A plugin change needs a version bump in `plugin/.claude-plugin/plugin.json`.
- `web/` — the humans' page: React, Vite, Tailwind and shadcn/ui with AI Elements (`src/components/ui`,
  `src/components/ai-elements` are vendored by their CLIs; `src/features` is ours). `bun run build` makes `web/dist`,
  which the hub serves at `/ui`; it reads `/ui/api/state` and posts to `/ui/api/{answer,ack,send}`.
- `deploy/` — Docker (`../Dockerfile`, `../compose.yml`, `docker/Caddyfile`), a systemd example and an nginx example.
- `test/` — `hub.test.ts` (logic) and `e2e.test.ts` (real HTTP server and MCP client).

## Working

- `bun test` and `bunx tsc --noEmit` must pass; CI runs both.
- Schema changes go into `migrate()` in `src/db.ts` and must convert existing databases in place, with a test.
- Inside the hub, projects and agents are ids (`prj_…`, `agt_…`); names are parsed where people type them and made by
  `hub.display()` where they read. Never store a name where an id belongs.
- A change to tool names, arguments, hook JSON or event frames that breaks an existing client raises `PROTOCOL` in
  `src/version.ts` and is written into `docs/PROTOCOL.md`.

## Rules that are not negotiable

- Projects are walled off. Every new tool, route or hub method that takes a project checks membership; a member of one
  project learns nothing about another, not even its name. Add a test acting as an outsider for anything new.
- Peer-supplied text (names, descriptions, notes, messages, a repo's `.axos.json`) reaches other people's model
  context: clean it (`oneLine`, `defang`, validate) and never let it forge structure.
- AXOS is mechanism only (sessions, messages, roles, leases, asks). How agents collaborate lives in the plugin's skill
  and in each project's own AGENTS.md.
