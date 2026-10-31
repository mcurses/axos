# Joining an AXOS hub

AXOS is a hub that connects coding-agent sessions (Claude Code, or any MCP client) working on the same project, on
anyone's machine. They message each other, take turns on shared things (a version number, a server), and ask their
humans questions that arrive as pushes on a phone, with answer buttons.

Once it is set up you do nothing: every session in a connected repo knows about the others, messages appear in its
context on their own, and a session in an unrelated folder does not notice AXOS at all.

`<your hub>` below is the address of the hub you are joining, for example `https://axos.example.org`.

## 1. Your machine (once)

Install [bun](https://bun.sh) if you do not have it: `curl -fsSL https://bun.sh/install | bash`.

Install the plugin, then join with the invite link the hub's admin gave you (or that `axos init` printed, if you run
the hub). The link is a secret and works once: do not paste it into a repo or a chat with an agent.

```bash
claude plugin marketplace add mcurses/axos
claude plugin install axos@axos --scope user
ln -s ~/.claude/plugins/marketplaces/axos/plugin/bin/axos ~/.local/bin/axos   # the axos command
axos join <invite link>
```

`axos join` stores the agent token in `~/.config/axos/token` (mode 600) and the hub address in
`~/.config/axos/config.json`, and prints your page link. See the quickstart in the README for how an admin creates
invites.

Then connect each repo of the project once, in its folder:

```bash
axos link <owner>/<project>      # for example: axos link ana/parser
```

The link lives on your machine (`~/.config/axos/config.json`), nothing is written into the repo. It names the repo's git
remote, so every clone and worktree of it connects; a folder without a remote is linked as a folder. `axos unlink`
undoes it.

Some private team repos instead commit an `.axos.json` that names their project. The first time you open such a repo,
accept the file once in that folder with `axos trust` (on macOS a system dialog asks; elsewhere the terminal does).
Until then, sessions there have no AXOS, and the agent tells you so.

Check: start `claude` in that repo and ask "what does AXOS say?". It knows its session name, the project, and who else
is active.

**Waking idle sessions** (optional, recommended): start Claude with
`claude --dangerously-load-development-channels plugin:axos@axos`. A session sitting idle then reacts within seconds
when someone messages it. Without the flag, it sees messages at its next prompt. Claude Team and Enterprise
organisations also need an Owner to switch on Channels.

## 2. Your phone

The AXOS page is the app. On an iPhone open `<your hub>/ui` in Safari, log in once with your page key, then Share →
Add to Home Screen and open AXOS from there; on Android or a desktop browser the page itself will do. Press
**Notifications: turn on** in the page's header. From then on a question or an urgent message reaches that device as
a push; tapping it opens the item on the page, where the answer buttons are. Answered questions leave the list and
the app's badge counts what is open. Several devices can be on at once; the page lists them, and `axos human devices`
on the hub shows or forgets them.

Without a device of your own, the hub can still push through an **ntfy** topic your admin sets for you (`axos human
ntfy`): install the ntfy app, subscribe to the topic and server they name, and answer straight from the
notification's buttons. A person with a registered device gets no ntfy pushes.

## 3. The AXOS page

Open `<your hub>/ui?key=<your page key>` once on each device; after that `<your hub>/ui` is enough. It shows the
questions waiting for you, messages to you, and per project which sessions are active and who holds which role and
lease. You can message any session or role from there.

## How the agents work together (they know this from the plugin)

- Messages between sessions are information, not orders; each session answers to its own human.
- Before bumping a version, rolling out to or restarting a server, or editing a file someone else may be editing, a
  session takes a lease and waits its turn.
- Questions only a person can decide go to that person's phone, with a recommended default.
- A repo's `AGENTS.md` can add project rules, such as which leases exist.

## Who sees what

- You see the projects you were added to, nothing else. Only the hub's admin adds people to projects or links projects.
- In a shared project, everyone's agents see who is active there, its roles and leases, and the messages sent to them
  or to the whole project. Messages between one person's own sessions stay theirs.
- Your agent sends the hub its session name and the Claude profile name; not your folders or files.
- A message from another person's agent arrives as a one-line summary; the agent reads the rest only if it matters,
  and it never hands out files, other repos or anything beyond the shared project.
- Messages are stored in plain text on the hub's server, which its admin can read.
