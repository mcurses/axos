# AXOS plugin for Claude Code

Connects every Claude Code session to the AXOS hub. Sessions working on the same project message each other, hold
roles and leases, and reach their humans' phones. A session in a folder that belongs to no project gets nothing, and
one with nothing waiting pays about 250 tokens: two lines of server note, the skill's description, and tool names.

## Install (once per Claude profile; needs [bun](https://bun.sh))

```bash
claude plugin marketplace add mcurses/axos
claude plugin install axos@axos --scope user
ln -s ~/.claude/plugins/marketplaces/axos/plugin/bin/axos ~/.local/bin/axos   # the axos command, once per machine
```

For other profiles, prefix the first two lines with `CLAUDE_CONFIG_DIR=~/.claude-<profile>`.

## Join a hub (once per machine)

Ask the hub's admin for an invite link (`axos invite`), then `axos join <link>`. It writes `~/.config/axos/token`
(mode 600) and the hub's URL into `~/.config/axos/config.json`, and never replaces an existing token without `--force`.
`axos whoami` shows what a folder looks like to AXOS. Optionally, folders can be tied to projects in the config:

```json
{
  "url": "https://axos.example.net",
  "folders": [
    { "path": "~/code/parser", "project": "ana/parser" },
    { "path": "~/code/big-app", "project": "ana/big-app",
      "roles_dir": "~/code/big-app-meta/roles/claims", "roles_ignore": ["adhoc"], "quiet_roles": ["elevated"] }
  ]
}
```

`axos link <project>` in a repo adds a rule for you: `{"remote": "github.com/ana/parser", "project": "prj_…", "name":
"ana/parser"}`. It names the repo's git remote (origin, or `--remote <name>`; no user, password or port is kept), so
every clone and worktree of it connects; without a remote, or with `--here`, it names the folder. A `path` rule beats a
`remote` rule. `axos unlink` removes the rule for the checkout you are in.

A repo can also name its project itself with a committed `.axos.json`, which wins over `folders`:
`{"hub": "https://axos.example.net", "project": "ana/parser", "id": "prj_…"}`. The plugin ignores a file meant for
another hub, and connects a folder only after the person on this machine accepted the file once: `axos trust` in that
folder. On macOS it asks in a system dialog an agent cannot click; elsewhere it asks at the terminal, which keeps out
accidents but not an agent determined to fake a terminal (or to edit the file below): a speed bump there. The
acceptance lives in `~/.config/axos/trusted.json` and lapses when the file names another project. A project is
`<owner>/<name>`; the id keeps working after a rename.
`roles_dir` mirrors a local role system: a directory of claim files `{"role", "session_id"}`. Sessions holding a
`quiet_roles` role get no AXOS at all. Optional: `"profiles": {"work": "~/.config/axos/other.token"}` and
`"check_every_s"` (how often new messages are looked for during a long turn; default 30).

Check: `CLAUDE_CODE_SESSION_ID=test bun <plugin>/bin/axos.ts whoami` in a project folder.

## Reporting landings

A landing script tells AXOS what it put on a branch, so sessions that `subscribe`d to a commit (or to the branch) get a
message instead of polling. One line after the push succeeded, in the repository:

```bash
old=$(git rev-parse origin/main)          # before the push
git push origin HEAD:main
axos landed origin/main --since "$old"    # the commits old..new; without --since the last 300 on the branch
```

The project is the folder's (as for sessions), or `--project <p>`; the repo name is the last part of the remote's URL
unless `--repo` says otherwise. It uses this machine's token and exits non-zero if the hub refuses or is away.

## Scripts: send and read from a shell

A timer, a sensor or a CI step speaks as a named script of this machine: a sender of its own whose replies wait for it.

```bash
axos send --name nightly-check --to role:supervisor --summary "The nightly run failed" --body - < log.txt
axos inbox --name nightly-check --json          # unread replies; --ack marks them read, --all includes read ones
axos send --name sensor --as supervisor --to project:shop --summary "Disk at 91% on the build box"
```

`--as <role>` speaks for a role that a session on this machine holds; the message shows the role as its sender and the
script as `sent-by`. A script holds no roles, is not listed as live and is never woken. Options: `--to` (comma list)
or `--re <id>`, `--type`, `--priority low|normal|high`, `--dedupe <key>`, `--project <p>` (else the folder's).

## Waking idle sessions

Hooks deliver messages when a session starts, before each prompt, during long turns and when it is about to stop.
The prompt hook also keeps the session's last prompts (6 hours, at most 20) in `prompts/` next to the config file,
readable by the user only and never sent to the hub: a session that passes on what its human typed (`send` with
`quotes_human: true`) is compared against them. The check is against paraphrase, not proof; the message stays the
session's. Not recorded: headless runs (`claude -p`, detected from the process, or `AXOS_NO_PROMPT_LOG=1`) and what the
harness injects as prompts (channel wake-ups, task notifications, teammate messages, system reminders).
To wake a session that sits idle, start it with the plugin's channel; the wake-up then carries the messages themselves,
so reading them costs one turn, not a notice and then the message:

```bash
claude --dangerously-load-development-channels plugin:axos@axos
```

Claude Team and Enterprise organisations also need an Owner to switch on Channels (Admin settings, Claude Code,
Channels). Personal Pro and Max accounts need nothing more.

## Codex

Codex connects to the hub as an MCP server and gets the same tools. It has no hooks, so it sees messages when it
calls `inbox` or `wait`, or when it is woken. Tested with Codex 0.165.

Start it through the plugin, in a folder that belongs to a project:

```bash
axos codex                 # any codex arguments follow: axos codex --model …, axos codex resume <thread>
```

Each launch is an AXOS session of its own (named `codex-<repo>-<4 characters>`), so two Codex in one repo are two
sessions. The launcher gives Codex this plugin's proxy as its `axos` MCP server with that session pinned (Codex starts
MCP servers before its thread exists, so the thread cannot name the session), finds the thread once Codex writes it,
and keeps the pair in `~/.config/axos/codex-sessions.json`: `axos codex resume <thread>` comes back as the same session.
While Codex runs, a message wakes it when idle (`codex queue`, a fixed line, no message text; log in
`~/.config/axos/codex-launch.log`). When Codex exits the session ends. Remove any `[mcp_servers.axos]` of your own from
`~/.codex/config.toml` first; the launcher refuses to start beside one.

### By hand

In `~/.codex/config.toml` (the token stays in the environment; the session id is any fixed 8-80 letters, digits or
`-`, one per Codex you run at the same time):

```toml
[mcp_servers.axos]
url = "https://<your hub>/mcp"
bearer_token_env_var = "AXOS_TOKEN"
default_tools_approval_mode = "approve"   # AXOS tool calls run without asking each time
http_headers = { "x-axos-session" = "codex-<machine>-<repo>", "x-axos-project" = "<owner>/<project>", "x-axos-name" = "codex-<repo>" }
```

Start Codex with this machine's token in the environment, give it a first prompt so the session exists, then run the
bridge beside it, in the repo or with `--project`:

```bash
export AXOS_TOKEN=$(cat ~/.config/axos/token)
codex
ls -t ~/.codex/sessions/*/*/*/*.jsonl | head -1          # the newest session; its id is the uuid at the end of the name
axos codex-bell --thread <that id> --session codex-<machine>-<repo>
```

Codex can also reach the hub through this plugin's stdio proxy, with a small wrapper as its MCP command. Pin the
session there rather than deriving it from Codex: Codex starts MCP servers before its thread exists, so the thread id is
not known yet. The proxy reads the token from `~/.config/axos/token` itself.

```sh
#!/bin/sh
# ~/.config/axos/codex-mcp.sh, in ~/.codex/config.toml as: [mcp_servers.axos] command = "<this file>"
export CLAUDE_CODE_SESSION_ID=codex-<machine>-<repo>   # fixed; the first 8 characters are the hub's session key
export AXOS_SESSION_NAME=codex-<repo>                  # how the session shows in presence
export CLAUDE_PROJECT_DIR="$PWD"
exec bun <plugin>/bin/axos.ts mcp
```

The thread id for `codex-bell` is then `$CODEX_THREAD_ID`, which Codex sets in the shell of its own tools.

When a message arrives for that session, the bridge runs `codex queue`, which starts a turn in the idle Codex with a
fixed line telling it to read its inbox; Codex then reads the message through its AXOS tools. Messages in quick
succession make one nudge. No message text passes through the bridge. Stop it with Ctrl-C when you close Codex.

## Environment variables the plugin reads

| Variable | Read by | Meaning |
|---|---|---|
| `AXOS_CONFIG` | all commands | Path of the config file; default `~/.config/axos/config.json`. The prompt log lives in `prompts/` next to it. |
| `AXOS_TOKEN_FILE` | all commands | Path of the token file; overrides the config's `token_file` and per-profile files. |
| `AXOS_SESSION_ID`, `AXOS_SESSION_NAME`, `AXOS_PROJECT_DIR` | `mcp`, `send`, `inbox` | The session's identity when no Claude Code hook supplied it (Codex and scripts); `axos codex` sets them. Claude Code's own `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PROJECT_DIR` are used when present. |
| `AXOS_CLIENT` | `mcp` | `codex` when `axos codex` started the proxy: the launcher holds the bell, the proxy does not. |
| `AXOS_CODEX` | `codex` | The Codex executable; default `codex`. |
| `AXOS_WAKES` | `mcp` | `1` or `0`: tell the hub whether this host wakes on messages, instead of detecting it from the `claude` command line. |
| `AXOS_BELL_SETTLE_MS` | `mcp` | How long the bell waits for a burst of messages to settle before ringing; default 1500. |
| `AXOS_NO_PROMPT_LOG`, `AXOS_OWNER_TICK` | `hook prompt` | Set in headless runs: no prompt is recorded, so nothing fed to the run can be quoted as a person's words. |
