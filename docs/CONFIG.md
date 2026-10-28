# AXOS configuration

Every setting of the hub and of the client, taken from the code (`src/server.ts`, `src/cli.ts`, `plugin/bin/axos.ts`,
`compose.yml`, `Dockerfile`, `deploy/`). The wire contract is in [PROTOCOL.md](PROTOCOL.md).

## Server environment

Read by `src/server.ts` (the hub). The admin command (`src/cli.ts`) reads `AXOS_DB` and `AXOS_PUBLIC_URL` only.

| Variable | Default | What it does | Without it |
|---|---|---|---|
| `AXOS_DB` | `axos.db` in the working directory | Path of the SQLite file (WAL mode). The schema is created and migrated when the hub or the admin command opens it. | A database appears in whatever directory the process started in. The hub and the admin command must point at the same file, or the admin changes a different hub. |
| `AXOS_PORT` | `18900` | TCP port. | Port 18900. |
| `AXOS_HOST` | `127.0.0.1` | Interface to bind. The Docker image sets `0.0.0.0`. | Reachable only from the same machine, so a reverse proxy on that machine is needed. |
| `AXOS_PUBLIC_URL` | empty | The URL people and clients reach the hub at, e.g. `https://axos.example.com`. A trailing `/` is dropped. | See below. |
| `AXOS_NTFY_URL` | unset | Base URL of an ntfy server, e.g. `https://ntfy.sh`. The hub POSTs JSON to it for each push. | No phone pushes. |
| `AXOS_NTFY_TOKEN` | unset | Bearer token sent to ntfy. Ignored when `AXOS_NTFY_URL` is not set. | Pushes go out without authentication, which fails on a protected ntfy. |
| `AXOS_LINK_SECRET` | unset or empty | Key that signs the answer links on push notifications. | A random secret is created on first start and kept in the database (`kv` table, key `link_secret`). Database backups then contain it. |
| `AXOS_PLUGIN_SOURCE` | `mcurses/axos` | Where the plugin is installed from, shown in the plugin install command on `/join/<code>` pages: a GitHub `owner/repo` or a git URL (set it for a fork). | The page names `mcurses/axos`. |
| `AXOS_DOMAIN` | none | Docker Compose only. The public host name. | `docker compose` stops with "set AXOS_DOMAIN in .env". |

`AXOS_PUBLIC_URL` unset means:

- `/api/join` answers with the origin the request came to as `hub`, and the invite page shows that origin. Behind a
  proxy this may be an internal address, and the client then stores it as its `url`.
- The admin command prints join links and page links as `<hub url>/…`. Replace the placeholder by hand.
- `create_project` leaves `hub` out of the `.axos.json` it proposes.
- Pushes carry no click-through URL and no answer buttons (the buttons are links to the hub).

Set it whenever the hub is reached under a name.

### What works without ntfy

Everything except the phone. With no `AXOS_NTFY_URL`, or for a human without a topic:

- `ask_human` still stores the question and delivers it to the human's mailbox; its answer text says whether it was
  pushed.
- The human's page (`/ui`) lists open questions with the options as buttons and a free-text field, plus their inbox
  and who holds what per project. Answering there works as usual.
- Messages of priority `high` to a human appear only on the page.
- Deadlines and their defaults still apply; a deadline needs nobody to be reachable.

The topic per human is set with `axos human ntfy <name> <topic>` (or `-` to clear it), or `axos human add <name> --ntfy
<topic>`. Pushes are best effort: a failed push is logged as an event and nothing else happens.

### Fixed values

These are constants in the code, not settings:

| Value | Where |
|---|---|
| A session is live for 24 hours after its last request | hub |
| A session or agent is online for 10 minutes after its last request, or while an event stream is open | hub |
| A role is freed after 2 hours (7200 s) without a request from its holder | hub |
| 60 sends per minute per agent | hub |
| Summary 300 characters, body 64000 characters | hub |
| `wait` at most 240 seconds | hub |
| Lease time 30 s to 24 h, default 30 min | hub |
| Event stream heartbeat 25 s; housekeeping every 15 s | server |
| Hook body at most 65536 characters | server |
| No idle timeout on connections (`idleTimeout: 0`) | server |
| Invite code valid 24 hours | CLI default |

## Deployment files

### Docker Compose

`compose.yml` runs two services, the hub and Caddy.

```
cp .env.example .env     # set AXOS_DOMAIN
docker compose up -d
docker compose exec axos axos init <your name>
```

- `.env` is optional as a file, but `AXOS_DOMAIN` must be set in it or in the shell. Compose also uses `.env` to fill
  `${AXOS_DOMAIN}`.
- The hub container gets the whole `.env` (so `AXOS_NTFY_URL` and `AXOS_NTFY_TOKEN` reach it), and
  `AXOS_PUBLIC_URL=https://$AXOS_DOMAIN`.
- The `Dockerfile` sets `AXOS_DB=/data/axos.db`, `AXOS_HOST=0.0.0.0`, `AXOS_PORT=18900`. `/data` is the volume
  `axos-data`; the process runs as user `bun`. A health check calls `/healthz` every 30 seconds.
- `axos` inside the container is the admin command.
- Caddy (`deploy/docker/Caddyfile`) serves `$AXOS_DOMAIN`, gets and renews its certificate, gzips, and proxies to
  `axos:18900`. DNS for the domain must point at the machine, and ports 80 and 443 must be open. Volumes
  `caddy-data` and `caddy-config` keep certificates.
- `.env.example` documents `AXOS_DOMAIN`, `AXOS_NTFY_URL`, `AXOS_NTFY_TOKEN`.

### systemd and nginx (`deploy/`)

Examples for a host without Docker: the hub checked out in `/opt/axos`, run by a user `axos`, bun in `/usr/local/bin`,
the database in `/var/lib/axos`. Adapt the paths.

- `deploy/systemd/axos.service`: runs `bun run src/server.ts`, with `AXOS_DB`, `AXOS_PORT`, `AXOS_HOST` in the unit and
  an optional `EnvironmentFile=-/etc/axos/env` (the leading `-` makes it optional) for the rest: `AXOS_PUBLIC_URL`,
  `AXOS_NTFY_*`, `AXOS_LINK_SECRET`, `AXOS_PLUGIN_SOURCE`. `Restart=always`, `MemoryMax=512M`.
- `deploy/systemd/axos` is installed as `/usr/local/bin/axos`: it loads that environment file, sets `AXOS_DB`, and runs
  `src/cli.ts`.
- `deploy/nginx/axos.conf`: a reverse proxy. Whatever sits in front of the hub must not buffer responses and must allow
  long requests: `/events` is a stream, and `wait` holds a request for up to 240 seconds. The sample uses
  `proxy_buffering off`, `proxy_read_timeout 86400s`, `client_max_body_size 256k`.
- Pushes go to any ntfy server (`AXOS_NTFY_URL`); the public `https://ntfy.sh` works, a self-hosted one keeps them private.

## Client files

The Claude Code plugin reads these; another client can ignore them or reuse the same layout.

| File | Written by | Purpose |
|---|---|---|
| `~/.config/axos/config.json` | `axos join`, `axos link`, or by hand | Hub URL, token locations, folder rules |
| `~/.config/axos/token` | `axos join` | The default token file, mode 0600 |
| `~/.config/axos/trusted.json` | `axos trust` | Which `.axos.json` files this machine trusts, mode 0600 |
| `<repo>/.axos.json` | committed by a team that wants it (optional) | Names the repo's project for every clone |

`trusted.json` sits next to the config file, so setting `AXOS_CONFIG` moves it too.

### `config.json`

```json
{
  "url": "https://axos.example.com",
  "token_file": "~/.config/axos/token",
  "profiles": { "main": "~/.config/axos/token", "work": "~/.config/axos/token-work" },
  "folders": [
    { "path": "~/code/shop", "project": "alice/shop",
      "roles_dir": "~/code/shop/roles/claims", "roles_ignore": ["adhoc"], "quiet_roles": ["elevated"] },
    { "remote": "github.com/alice/parser", "project": "prj_0a1b2c3d4e", "name": "alice/parser" }
  ],
  "check_every_s": 30
}
```

| Key | Type | Meaning |
|---|---|---|
| `url` | string, required | The hub's base URL. Without it the file counts as absent and AXOS is off. A trailing `/` is dropped. |
| `token_file` | string | Token file for profiles without an entry of their own. Default `~/.config/axos/token`. |
| `profiles` | object | Profile name to token file, for several Claude accounts on one machine (see below). |
| `folders` | array | Folder rules: which folders or repositories belong to which project. `axos link` writes them. |
| `check_every_s` | number | Minimum seconds between hub checks in the after-tool-call hook. Default 30. Prompt, start and stop hooks always check. |

`folders` entries:

| Key | Meaning |
|---|---|
| `path` | Folder (`~` allowed). The rule covers it and everything below it. With several matches the longest path wins. |
| `remote` | Instead of `path`: a repository, as `<host>/<path>` in lowercase without `.git`, user, password or port (`git@github.com:Ana/Parser.git` and `https://github.com/ana/parser` are both `github.com/ana/parser`; a local remote is `file:<absolute path>`). The rule covers every checkout that has it among its remotes. |
| `project` | Project as an id, `<owner>/<slug>` or a slug. |
| `name` | Optional. The project's name, for people reading the file; `axos link` writes it next to the id. |
| `roles_dir` | Optional. A directory of `*.json` claim files `{"role": "...", "session_id": "..."}`. The session gets the roles whose `session_id` is its Claude session id, and they are mirrored to the hub on each check. Roles held on the hub that the directory does not name are released. If the directory cannot be read, nothing is mirrored and nothing released. |
| `roles_ignore` | Roles in `roles_dir` that are not mirrored, e.g. one that many sessions hold at once. |
| `quiet_roles` | A session holding one of these roles gets no AXOS at all: no hooks, no tools, no event stream. |

`axos join` writes `url` and keeps every other key; `axos link` and `axos unlink` change only `folders`.

### Token

A text file with the token on one line. Which file is read, first match wins:

1. environment variable `AXOS_TOKEN_FILE`
2. `profiles[<profile>]`
3. `token_file`
4. `~/.config/axos/token`

`~` is expanded. Without a readable, non-empty token, AXOS is off and the MCP server answers "AXOS is not configured".
`axos join` writes the token to the same place, with mode 0600, and never prints it. A hub that refuses the token (revoked
or wrong) is reported to the session once, at start.

### Profiles

A profile is the Claude Code config directory of an account, named from `CLAUDE_CONFIG_DIR` (default `~/.claude`):

| Config directory | Profile |
|---|---|
| `~/.claude` | `main` |
| `~/.claude-work` | `work` |
| `~/.claude-` | `main` |
| any other name, e.g. `~/accounts/client` | its basename, `client` |

The profile selects the token file through `profiles`, and is sent to the hub as a label (`x-axos-profile`) that appears
in session names like `shop-5c (alice/mac#35dabd9e, work)`. The plugin also reads Claude Code's own session
records in `<config dir>/sessions/*.json` for the session's name and folder.

### How a folder gets its project

For the folder of a session, in this order:

1. A `.axos.json` at or above the folder that this machine trusts.
2. The longest `path` rule in `folders` that contains the folder.
3. A `remote` rule in `folders` naming one of the remotes of the git checkout around the folder (read from its
   `.git/config`; a worktree's from the main repository).
4. None: the hooks stay silent and the session's AXOS tools refuse project work (the `projects` tool says how to
   connect the folder).

A trusted `.axos.json` beats a `folders` rule. An untrusted one does not count; if there is no `folders` rule either,
the session is told once at start that the repo asks to join a project, and that a person must run `axos trust`.

### `.axos.json`

```json
{ "hub": "https://axos.example.com", "project": "alice/demo", "id": "prj_0a1b2c3d4e" }
```

| Key | Meaning |
|---|---|
| `hub` | Optional. Used only to skip the file when it names another hub: the host (and port) must equal the host of `url`. |
| `project` | `<owner>/<slug>` or a slug, matching `^([a-z0-9][a-z0-9._-]{0,47}/)?[a-z0-9][a-z0-9._-]{0,47}$`. |
| `id` | `prj_` plus 10 lowercase letters or digits. Wins over `project` when both are present, and survives renames. |

At least one of `project` and `id` must be valid, or the file is ignored. The search starts in the session's folder and
walks up to the first directory that has an `.axos.json` or to the home directory (which is checked too). Only the
nearest file is considered: if it is unusable, the search does not go on.

### Trust

A cloned repo must not steer your sessions into someone's project. So `.axos.json` takes effect only after a person on
this machine runs `axos trust` in the folder. It records `{"<directory of the file>": "<id, or project if there is no
id>"}` in `trusted.json`.

- The entry must match the file's reference exactly. If the repo later changes `id` or `project`, trust has to be given
  again.
- Confirmation: on macOS a system dialog (it gives up after 120 seconds), elsewhere a `y/N` question in a terminal. With
  no terminal and no dialog, `axos trust` refuses. This keeps out accidents and careless agents; it is not a barrier
  against a program that writes `trusted.json` itself.
- Agents are told not to run `axos trust` for the user.

## Client environment variables

| Variable | Default | Meaning |
|---|---|---|
| `AXOS_CONFIG` | `~/.config/axos/config.json` | Path of the config file. `trusted.json` lives next to it. |
| `AXOS_TOKEN_FILE` | unset | Token file; beats `profiles` and `token_file`. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's config directory. Its basename gives the profile; `sessions/` inside it is read for session names. |
| `CLAUDE_PLUGIN_DATA` | `<tmp>/axos-plugin` | Where hooks keep per-session state (time of last check, whether the hub was unreachable). |
| `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR` | set by Claude Code | Session id and folder when the session record is not found. |

## The plugin's behavior

- Hooks (`plugin/hooks/hooks.json`): `SessionStart` runs `hook start` (10 s limit), `UserPromptSubmit` runs `hook prompt`
  (10 s), `PostToolUse` runs `hook tool` (10 s, throttled by `check_every_s`), `Stop` runs `hook stop` (10 s),
  `SessionEnd` runs `hook end` (5 s). Calls to the hub time out after 4 seconds.
- `start` and `end` map to the hub's events of the same name; every other hook sends `check`.
- At `Stop`, if messages arrived during the turn, the hook asks Claude Code to continue so the session reads them.
- If the hub is unreachable, the session hears it once and again when it is back. Hooks never fail the session.
- Folder without a project, no config, no token, or a quiet role: hooks print nothing and cost nothing.
- Each request carries `Authorization`, `x-axos-session`, `x-axos-profile`, `x-axos-project` (the id if the file has
  one, else its name; or the rule's project) and `x-axos-name`, URI-encoded.
- The channel doorbell: the plugin's stdio MCP server forwards every call to `<url>/mcp` and offers the capability
  `claude/channel`. Claude Code uses it only for sessions started with channels on. After initialization the server holds
  `GET <url>/events` open and, on a `message` frame or on a `hello` with `unshown > 0`, sends a fixed
  `notifications/claude/channel` ("a new message is waiting for this session…"). The notification carries no message and
  marks nothing shown; the next hook or `inbox` call delivers it. It reconnects with a delay that doubles from 2 to 60
  seconds, and checks again every 60 seconds while the folder has no project.

## Commands

| Command | For | What it does |
|---|---|---|
| `axos join <link> [--name <machine>] [--force]` | a person | Redeems an invite. Writes `url` into the config and the token into the token file. Refuses without `--force` when the machine is set up for another hub, or already has a token file. `--name` replaces the host name as the machine name. |
| `axos link [<project>] [--remote <name>] [--here]` | a person, or an agent asked to | Connects the checkout here on this machine: a `remote` rule for its `origin` (or the named remote), a `path` rule for its top folder when it has no remote or with `--here`. The hub resolves the project (`/api/whoami`) and the rule stores its id. Without a project it takes the repo's `.axos.json` and asks a person to confirm, like `axos trust`. |
| `axos unlink` | anyone | Removes the rules that connect the checkout here (its remotes, or its top folder). |
| `axos trust` | a person at a terminal | Trusts the `.axos.json` at or above the current folder. |
| `axos whoami` | anyone | Prints hub, the current folder's project (and `via`: the trusted file, linked remote or folder rule), profile, session, roles; says if an `.axos.json` is untrusted. Run inside a session (from its Bash) in another folder, it adds `session_folder` and `session_project`: the folder the session started in and the project it works in, which a link or unlink changes only at its next prompt. |

The hub's admin commands (`axos init`, `invite`, `agent …`, `project …`, `human …`, `role add`, `backup`, `events`) are
listed by running `axos` with no arguments on the hub host. Tokens and page keys they print are shown once; pipe them
into a file.
