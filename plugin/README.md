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

## Waking idle sessions

Hooks deliver messages when a session starts, before each prompt, during long turns and when it is about to stop.
To wake a session that sits idle, start it with the plugin's channel:

```bash
claude --dangerously-load-development-channels plugin:axos@axos
```

Claude Team and Enterprise organisations also need an Owner to switch on Channels (Admin settings, Claude Code,
Channels). Personal Pro and Max accounts need nothing more.
