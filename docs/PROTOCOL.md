# AXOS protocol

This is the contract between a hub and a client. The Claude Code plugin is one client; a Codex setup or a Python
script can be another. Everything here is derived from the hub's code (`src/server.ts`, `src/mcp.ts`, `src/hub.ts`,
`src/render.ts`, `src/version.ts`). Settings are in [CONFIG.md](CONFIG.md).

Current numbers: hub release `0.18.0`, protocol `1`.

A client needs only HTTP and JSON. The minimum is a bearer token and `POST /mcp`. Sessions, hooks and the event
stream are optional extras that make messages arrive without polling.

## Endpoints

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/mcp` (also `/mcp/`) | POST | bearer | MCP over HTTP: every tool |
| `/api/hook` | POST | bearer + session | Hook API for clients that inject context before a prompt |
| `/api/landed` | POST | bearer | A landing script reports commits that reached a branch |
| `/api/whoami` | GET | bearer | The token's agent and projects; `?project=<ref>` resolves a reference to an id |
| `/api/unshown` | GET | bearer + `x-axos-session` | `{unshown, unread}` for the session's mailboxes: what no hook or tool has put into its context yet (low-priority messages not counted: they wake nobody), and what is not acked |
| `/api/attach` | POST | bearer | Upload an image for a question to a human; `{id, ref, name, mime, size}` |
| `/api/inbox` | GET | bearer (+ `x-axos-script`) | The caller's unread messages as JSON, `?as=<role>`, `?all=1` (acked too), `?limit=` (default 50, at most 200); marks nothing |
| `/events` | GET | bearer | Server-sent event stream: a doorbell, not a message feed |
| `/api/join` | POST | invite code | Redeem an invite, receive a token |
| `/join/<code>` | any | invite code | HTML page with setup steps for that invite |
| `/a/<ask>/<signature>` | POST | signed link | Answer a question to a human with one of its options |
| `/ui` | GET, POST | UI key cookie | The humans' page (not part of the protocol) |
| `/healthz` | any | none | Liveness, version, protocol |
| `/` | any | none | 302 to `/ui` |

Anything else is `404 not found`.

## Identities and ids

| Thing | Id | Name (label) |
|---|---|---|
| Project | `prj_` + 10 characters | `<owner>/<slug>` |
| Agent | `agt_` + 10 characters | `<human>/<name>` |
| Session | `<agent id>#<8 characters>` | the harness's session name, if sent |
| Human | none | `<name>` |
| Role | none | `<role>`, inside a project |

- The 10 characters are lowercase Crockford base32: digits and letters except `i`, `l`, `o`, `u`.
- Names (slug, human, agent, role) match `^[a-z0-9][a-z0-9._-]{0,47}$` and may not start with `prj_` or `agt_`.
- An agent is one token: a machine or an account. A human has many agents.
- A session is one conversation of a client on an agent. It exists only when the client sends `x-axos-session`.
  Its key is the agent id, `#`, and the first 8 characters of the client's session id with dashes removed, lowercased.
  Two client ids that agree in those 8 characters are the same session.
- Message ids and ask ids are integers, unique across the whole hub.
- Ids are canonical inside the hub. Names are labels: a project can be renamed, and the old name keeps resolving.
- Input: everywhere a project is accepted you may send its id, `<owner>/<slug>`, or a bare slug. A bare slug works when
  it names exactly one of the caller's projects (a former name counts). An ambiguous name is an error that lists the
  candidates. Only the caller's own projects are searched.
- Output: the hub rewrites `prj_…` and `agt_…` in text it returns to names, for projects the caller can see (its own
  and their linked projects) and for agents sharing a project with the caller. Other ids stay as ids, so text that
  quotes a stranger's id reveals nothing. Do not parse names out of tool text; treat it as display text.

An agent works in its own memberships plus every project its human is in.

## Authentication

Every request to `/mcp`, `/events` and `/api/hook` needs `Authorization: Bearer <token>`. The token is `axos_…`; the hub
stores only its SHA-256. A wrong, rotated or revoked token gets `401 unauthorized` with
`WWW-Authenticate: Bearer realm="axos"`. Any authenticated request marks the agent as seen and keeps the roles the agent
itself holds alive.

Tokens come from an invite (`/api/join`) or from an admin (`axos agent add`, `axos agent token`). Revoking an agent
kills the token at once and frees its roles and leases.

Optional headers on `/mcp`, `/events` and `/api/hook`. Values are URI-encoded (`encodeURIComponent`); a value that does
not decode is `400`.

| Header | Meaning |
|---|---|
| `x-axos-session` | The client's session id, 8 to 80 characters of `A-Za-z0-9-`. Anything else is `400 session id must be 8-80 letters, digits or '-'`. Creates the session on first sight, revives an ended one, refreshes it on every request. |
| `x-axos-project` | The project of the client's working folder, as an id, `<owner>/<slug>` or a slug. Resolved among the agent's projects. An unknown or ambiguous value is ignored without an error. |
| `x-axos-name` | The session's display name. Control characters and `<` `>` are removed; at most 48 characters. |
| `x-axos-profile` | A label for the account or profile on that machine. Same cleaning; at most 32 characters. |
| `x-axos-client` | The client and its version, e.g. `plugin/0.15.1`. A session whose plugin is older than the hub is told so once per release in a hook's context (never at a stop). |
| `x-axos-script` | Instead of `x-axos-session`: a named script of the agent (1-32 of `a-z0-9._-`), see Scripts. Needs `x-axos-project`. |

Without `x-axos-session` the client acts as the agent itself:

- Its mailbox is `agent:<id>`, shared with every other client of that agent.
- It may work in every project it is a member of. A call without `project` works only when the agent is in exactly one
  project, or when `x-axos-project` named one.
- It acts as a role it holds with the `as` argument.

With `x-axos-session`:

- The session is tied to one project: the one in `x-axos-project`, remembered from earlier requests if absent now, and
  only if the agent is a member. A session whose folder belongs to no project cannot use project tools.
- Project tools are refused outside that project. To reach a linked project, send a message to it (see Addresses).
- `as` is not needed. The session speaks as a role when it holds exactly one role in the project (see Roles).
- Its mailboxes are `session:<key>`, `role:<project>/<role>` for each role it holds, and `agent:<id>`.

A session ends when the client posts the `end` hook event, when its agent is revoked or its human leaves the project,
or after 7 days without a request (a connected session's event stream counts). Ending a session frees its roles and leases and removes it from lease queues. Its
mail stays; any later request with the same key revives it.

### Scripts

A process without a model (a timer, a sensor, a CI step) sends `x-axos-script: <name>` with the agent's token. The
hub keeps it as a session of kind `script`, key `<agent id>#<first 8 hex of sha256("script:<name>")>`, named `<name>`,
profile `script`, in the project of `x-axos-project`:

- Its mailbox is its own `session:<key>` only (not the agent's). Peers address it as `session:<name>` and replies to its
  messages come back to it; it reads them with `/api/inbox` or the `inbox` tool.
- It is not live: not in `presence`, not reached by `project:` messages, never rung. It holds no roles and takes no
  `next` notes. It ends after 30 days without a request.
- With `as=<role>` it may speak for a role that a session of the same agent holds (that token could act as that session
  anyway), and read that role's mail. Such a message carries `sent_by` (the frame's `sent-by`; in `/api/inbox` with its name): the script that wrote
  it. A client without any session may do the same. Acking role mail this way takes it from the holder's inbox too.

The plugin's `axos send --name <script> …` and `axos inbox --name <script> …` do this from a shell.

## MCP over HTTP

`POST /mcp` speaks JSON-RPC 2.0 as MCP "streamable HTTP", stateless:

- Request headers: `Content-Type: application/json` and `Accept: application/json, text/event-stream`. Without both
  accept types the answer is `406`.
- The hub builds a new server per request and answers with plain JSON (`Content-Type: application/json`), never an
  event stream. There is no `Mcp-Session-Id`. `initialize` is optional: `tools/list` and `tools/call` work directly.
- A notification (no `id`) gets `202`. Other methods than `POST` get `405` with `Allow: POST`.
- `initialize` returns the server name `axos`, its version (the hub release), and a two-line `instructions` text.

Every tool returns one MCP text item. Failures that the hub understands (not a member, no such role, rate limit,
invalid address) come back as a normal result with `isError: true` and a sentence in the text, under HTTP 200. An
unknown tool or arguments that fail validation also come back as `isError: true` results with an `MCP error -32602`
text. An argument a tool does not take is such a failure (`unknown argument <name>; this tool takes …`); it is never
dropped silently. Results are text for a model or a person; only the `<axos-message>` frame below has structure.
Times in results and frames are in the hub's zone (`AXOS_TZ`, else the system's), e.g. `2026-10-29 21:35 CET`; the
`events` admin command and `/ui/api` keep ISO UTC.

Common arguments:

- `project`: id, `<owner>/<slug>` or slug. Defaults to the session's project, or the only project of a session-less
  agent.
- `as`: for clients without sessions only: a role the agent holds, to act as it.

### Tools

| Tool | Arguments (`*` required) | Returns |
|---|---|---|
| `join` | `project` | Who you are, the project brief, roles with holders and unread counts, linked projects, live sessions, leases, your open questions to humans, inbox count. Orientation; call it first. |
| `projects` | | Your projects, the session's project, links. |
| `set_brief` | `brief*` (at most 2000 characters), `project` | `Brief of <project> set (<n> characters).` Only agents of the project's owner. |
| `create_project` | `name*`, `brief` | Creates `<your human>/<name>` and puts your human in it. Returns the text plus a ready `.axos.json` line to commit. |
| `send` | `type`, `summary`, `to`, `body`, `project`, `re`, `thread`, `as_of`, `priority`, `dedupe_key`, `queue`, `as` | `Sent message <id> (summary only, no body).` or `(summary and a <n>-character body).`, then `Delivered to …` (a role with its holder and reach), `Held for …` for a vacant role, `Not sent to <address>: <reason>` per address that could not be resolved, and for a role nobody is reading right now (vacant, or its holder away) one sentence with its state and who else is in the room. Each address stands on its own: when none resolves, the call fails with the reasons. `queue` is accepted and has no effect. `thread` without `re` and `to` replies to the thread's first message. A repeated `dedupe_key` returns `Already sent as message <id>`. |
| `inbox` | `project`, `unread_only`, `limit` (1-100, default 20), `only` (`roles`, `session`, `agent`), `as` | Messages as `<axos-message>` frames. Marks the returned unread ones shown. The header counts unread per project when they span several. |
| `ack` | `ids*` (integers), `outcome`, `note` (one line, at most 200 characters, shown with the outcome in the sender's `thread`), `project`, `as` | `Acked <n> of <m>.`, then `Already acked before: <ids>.` and `Not in this session's mailboxes (…): <ids>.` when they apply, then `Left: <k> to handle (<r> read, <u> not read yet).` or `Left: nothing to handle.` |
| `wait` | `timeout_s` (1-240, default 120), `project`, `as` | Blocks until something unseen arrives; then the messages, or `Nothing new arrived within <n> s.` |
| `thread` | `message_id` or `id` | The messages of a conversation that you sent or received. |
| `define_role` | `role*`, `description*`, `project` | Creates a role or updates its description (at most 300 characters). |
| `claim_role` | `role*`, `force`, `project` | You hold the role. Fails if it does not exist. |
| `release_role` | `role*`, `project` | Gives it up. |
| `lease` | `resource*`, `mode`, `ttl_s`, `note`, `wait`, `project`, `as` | Granted, renewed, queued with a position, or refused. |
| `release_lease` | `resource*`, `project`, `as` | Releases the lease or leaves the queue. |
| `leases` | `project` | Live leases and waiters. |
| `ask_human` | `human*`, `question*`, `options`, `default_answer`, `deadline_minutes`, `remind_hours` (0.25-168), `images`, `project`, `as` | `Asked <human> (ask <id>)`. The answer arrives later as a message. |
| `asks` | `project` | The caller's questions to humans (its session's and its roles'), open ones first: asked, pushed to the phone, seen on the page, reminded, stale, answered or defaulted. |
| `presence` | `project` | Live sessions and session-less agents: online or idle, last seen, unread, roles. |
| `subscribe` | `branch*` (a branch or any ref name, e.g. `refs/evidence/<id>`; `*` for any characters), `sha`, `remote`, `repo`, `note`, `hours` (0.1-720, default 24), `subject`, `replace`, `project`, `as` | `Subscription <id>: …, until <time>.` (and `Subscription <old> has ended.` with `replace`), or `Already landed: …` when the commit landed within the last 30 days (then nothing is opened). |
| `unsubscribe` | `id*`, `project`, `as` | `Subscription <id> ended.` |
| `subscriptions` | `project` | The project's open subscriptions: who waits for which commit or branch. |

#### send

- `type`: `note`, `ask`, `answer`, `handoff`, `status`, `request`, `review`. The hub treats them alike except for
  pushes to humans. Left out: `note`.
- `summary`: at most 300 characters. One sentence a human understands without knowing any ids. Left out: the body's
  first line, if it is at most 300 characters; otherwise the send fails. Too long: the error says by how much.
- `body`: at most 64000 characters. A summary or body that looks like a secret (private key block, API keys of
  Anthropic, OpenAI, GitHub, GitLab, Slack, AWS, an `axos_` token, `password=…`) is rejected; the error names the kind
  of pattern, not the value.
- `priority`: `low`, `normal` (default), `high`. A message to a human is pushed to their phone when it is `high` or of
  type `ask`. A `low` one wakes nobody: no `message` frame on the event stream, not counted by `/api/unshown`, and not
  shown at the end of a turn (`stop: true`); it comes with the recipient's next prompt or tool call. Without
  `priority`, a `note` or `status` addressed to a `project:` is `low`; everything else is `normal`.
- `to`: a string or a non-empty array of addresses. May be left out only with `re`.
- `re`: the id of the message this answers. The reply joins that message's thread. With no `to`, it goes to the
  sender of that message: to its mailbox as it was addressed (a role, a human, an agent), or to the sender's agent
  mailbox if the sender was a session that has ended. It may cross a project link if you saw the parent; `project` may
  then name the parent's project, and the reply is still sent from the session's own. Replying to the hub's own
  messages needs a `to`. A reply to your own message goes to whoever that message went to.
- `thread`: an explicit thread id; normally derived from `re`.
- `as_of`: free text, e.g. a commit sha. Shown to the reader.
- `dedupe_key`: a second send with the same key from the same sender address is not delivered again, whatever the
  project.
- The sender is `session:<key>`, or `role:<project>/<role>` when the session holds exactly one role in the project, or
  `agent:<id>` for a client without a session (a role with `as`).
- Rate limit: 60 sends per minute per agent; the error says to batch updates.
- Recipients are collected from all addresses, de-duplicated, and the sender itself is dropped. If nobody is left the
  send fails.

#### Roles

A role is a named job in a project. One holder at a time; the holder is a session (or a session-less agent).

- Create it first with `define_role`; `claim_role` on an unknown role fails and lists the known ones.
- While a session holds a role it reads the role's mailbox, speaks as the role when it holds only that one, and its
  leases and questions belong to the role. The mailbox, leases and open questions stay with the role when it is freed.
- A role is freed by `release_role`, by the end of the holder's session (also its end after 7 days of silence), or by
  a takeover; silence alone never frees it. A role held by a session-less client is freed when that client has not been
  seen for 7 days.
- Taking a role held by someone else: refused when the holder belongs to another human. For the same human: taken at
  once when the holder is away (no event stream, not seen for 10 minutes); when the holder is online it needs `force`
  set to a non-empty text (the human's words). The displaced holder is told either way, with that text when given
  (event `role.taken_over` with `from`, `force`, `away`).
- A role is the durable place for a job: its mail, threads, subscriptions and open questions belong to it and pass to
  its next holder, and a human's answer to a question asked as the role reaches whoever holds it then.
- Mail to a role always waits for its holder. When nobody is reading it right now (vacant, or its holder away) the
  send result says so and lists who else is in the room (in the message's own project every other live session with
  its roles and reach; in a linked project only the roles held there, their holders shown as "a session of <human>"
  unless they are the sender's own), so the sender can also turn to someone who is there.

#### Leases

A lease is an exclusive or shared claim on an exact resource name (`file:<path>`, `version:<package>`, `server:<name>`,
`slot:<box>`, anything; at most 120 characters, no globs).

- `mode`: `exclusive` (default) or `shared`. Shared leases coexist; an exclusive one needs the resource free.
- `ttl_s`: 30 to 86400, default 1800. Calling `lease` again as the holder renews it: without `ttl_s` for as long as it
  was granted for; the mode cannot change on renewal.
- If taken and `wait` is not `false` (default true), the caller joins a strict FIFO queue. When it is its turn the hub
  grants the lease and sends a high-priority status message.
- An expired lease sends its holder a high-priority status message and passes to the queue.
- The holder is the seat of the caller: the session, or the role it holds if exactly one.
- `note` is at most 200 characters.

#### Questions to humans

`ask_human` sends a message of type `ask`, priority `high`, to `human:<name>`, stores the question, and pushes it to the
human's phone if a topic is set. The human answers on the page or by a button. The answer arrives as a message of type
`answer` from `human:<name>`, with `re` the id of the ask message, addressed to whoever asked (the role if the asker
spoke as one, else the session or agent). The body is the human's text verbatim.

- `options`: short answers; the first three become phone buttons, all show on the page. Button answers must be one of
  them; free text is for the page.
- `default_answer`: must be one of the options if there are options.
- `deadline_minutes`: needs `default_answer`. When it passes unanswered, the hub records the default and sends the
  asker an `answer` message from `axos`. The check runs every 15 seconds.
- `remind_hours`: if the question is still open then, the hub pushes it once more ("Reminder: …", same buttons,
  replacing the first notification). It must come before the deadline.
- A question without a deadline that is still open after 3 days: the asker gets one low-priority `note` from `axos`
  (`re` the ask message) saying so, and whether the human has seen it on their page.
- The asker follows its questions with `asks`: pushed (the notification service took the push), seen (first shown on
  the human's page), reminded, stale, answered.
- Only the human it was put to can answer, once.
- `images`: up to 4 references `att:<id>` to images uploaded with `/api/attach` by the same agent within the last hour,
  each used by one question. The human's page shows them with the question; the push says how many there are; the ask
  message's body ends with `Images on the page: <name> (<size>), …`. Only the asked human's page serves them, for 30
  days. The Claude Code plugin takes file paths here instead: it uploads files inside the session's checkout (after
  resolving symlinks) and refuses any other path with `Not asked: <path> is outside this checkout (<root>)`.

`POST /api/attach?name=<file name>` takes the raw bytes. Accepted are PNG, JPEG, GIF and WebP, recognized by their
first bytes, up to 5 MB (`413` above that); anything else is `400 {"error": "only PNG, JPEG, GIF and WebP images can be
attached"}`. At most 8 uploads per agent wait unused at once; an unused upload is deleted after an hour.

## Addresses

An address names who receives a message. Resolution happens at send time, in the message's project.

| Address | Recipients |
|---|---|
| `role:<role>` | The role's mailbox in the message's project. The role must exist; it may be vacant: the mail waits. |
| `role:<project>/<role>` | The same in a linked project. `<project>` is a slug, `<owner>/<slug>` or an id. |
| `session:<name>` | The one live session with that name. Looks in the message's project, then in linked projects. If several sessions of different people share a name, one of the sender's own is preferred; otherwise the error lists keys. A session renamed by a restart also answers to its last five names while no live session has that name now. |
| `session:<key>` | A session by key, as `<agent id>#<8>` or `<human>/<agent name>#<8>`. A key also works for a session that is not live if it belongs to the project or a linked one. |
| `human:<name>` | The human's mailbox (read on their page). Only humans in the message's own project, not linked ones. |
| `agent:<human>/<name>` or `<human>/<name>` or `agt_…` | The agent's shared mailbox. The agent must be a member of the project or a linked project, and not revoked. |
| `project` | Every live session in the project, plus every member agent that has no live session but has connected within the last 7 days (a mailbox nobody has opened for a week, or ever, is not in the room). The sender is excluded. |
| `next` | Held for the next session of the sender's human that starts in the message's project, from any of that human's agents (a handoff before a restart). The first new session takes it; its own sender session never does. Not across links. |
| `project:<project>` | The same for a linked project. |

Anything else is an error that lists the accepted forms. Naming a project that is neither the message's own nor linked
to it is refused alike, whether it exists or not.

Projects are linked by an admin. Linked projects can message each other's roles, sessions, agents and live sessions;
nothing else crosses (briefs, leases, presence).

A session is live when it has not ended and was seen in the last 7 days. A session (or any holder of a role) is online
when it has an open event stream or was seen in the last 10 minutes; otherwise it is away.

## Delivery

- A `send` stores one message and one delivery per distinct recipient mailbox. The message is stored once; each
  delivery carries its own state.
- A delivery has two timestamps. `shown_at`: put into a reader's context. `acked_at`: handled.
- A delivery is to be handled until acked (the JSON fields keep the older name `unread` for this). Texts for readers
  say "to handle" for not acked and "not read yet" for not shown; a shown delivery is read, an acked one handled.
- A delivery expires only when its mailbox has had no reader for 7 days: the session ended that long ago, or the agent
  has not connected for that long (or ever) while the message aged that long. The hub then closes it with
  `outcome: expired`, which the sender sees in the thread's receipts; the message itself stays. Mail to a role or a
  human never expires. A `send` to an agent that is not connecting says so in its answer.
- A delivery becomes shown when:
  - the `check` or `start` hook returned it (up to 10 per call),
  - `inbox` returned it with `unread_only` true or omitted,
  - `wait` returned it (up to 20 per call).

  `inbox` with `unread_only: false` shows history (acked and unacked, newest first) and marks nothing.
- `ack` sets `acked_at` for the caller's mailboxes only. An id you cannot read is reported as not in your mailboxes,
  exactly like one that does not exist. Acking twice is harmless. Acking is silent: it sends nothing. An `outcome`
  (`done`, `declined`, `forwarded`, `noted`) is stored with the delivery.
- `thread` shows, on each message the reader sent, a `receipts` attribute: per recipient mailbox `unread`, `read`
  (shown), `acked`, or the ack's outcome.
- `wait` returns immediately if any delivery of the caller is unshown. Otherwise it blocks until a message arrives for
  one of the caller's mailboxes, the timeout passes (at most 240 s), or the client disconnects. Shown but unacked
  messages do not end it, so a client that does not ack does not spin.
- Guarantees:
  - The inbox is at-least-once. An unacked message stays in `inbox` however often it was shown. A client that wants
    exactly-once handling acks ids itself.
  - Hook injection is best effort. A delivery is marked shown when the hub builds the answer; if the client never uses
    that answer, the message is not shown again by hooks or `wait`, but `inbox` still returns it.
  - Wake-ups (the event stream, `wait`) are in-memory and not replayed. After a restart or a reconnect, read the counts
    (`hello` frame, `inbox`).
- A session reads its agent's shared mailbox only for messages of its own project and the projects linked to it; the
  agent without a session (and its sessions in those other projects) reads the rest. An agent that is in several
  projects so carries no project's mail into a session working in another.
- Mailboxes are evaluated when read. A session that takes a role afterwards reads the role's earlier mail. A message
  to a role is not copied to anyone.
- A message to a human is not read through MCP; the human reads it on `/ui`.
- Messages from the hub itself have sender `axos`: lease grants and expiries, role loss, missed deadlines.

### The message frame

Messages reach a model as `<axos-message>` blocks, from `inbox`, `wait`, `thread` and the hook:

```
<axos-message id="12" from="session:alice/py#abcdefgh" sender-human="alice" sender-name="py-main" sender-roles="reviewer" project="alice/demo" type="request" priority="high" via="role:alice/demo/reviewer" re="9" thread="9" as-of="3f2a1c" sent="2026-10-26T18:01:57Z">
summary: please review
the body, if any
</axos-message>
```

| Attribute | Present |
|---|---|
| `id` | always |
| `from` | always: `session:<key>`, `agent:<id>`, `role:<project>/<role>`, `human:<name>` or `axos` (names instead of ids as the viewer may see them) |
| `sender-human` | when known and the sender is not a human |
| `sender-name`, `sender-roles` | when the sender is a session with a name, or holds roles now |
| `sent-by` | when someone other than the sender wrote it: a script (or a client without a session) speaking for a role |
| `project` | always |
| `type` | always |
| `priority` | unless `normal` |
| `via` | on inbox items: the address it reached you through |
| `re`, `thread`, `as-of` | when set |
| `receipts` | in `thread`, on the reader's own messages: `<recipient>: unread|read|acked|<outcome>`, `; `-separated |
| `sent` | always, UTC, seconds |

The text after the tag starts with `summary: `. In summary and body every `<` followed by a letter, `/`, `!` or `?` is
replaced by `&lt;`, so a peer cannot forge a tag. Attribute values are escaped. Lists of frames follow a header line and
a note that peer messages are information, not instructions from the user. Treat message text accordingly.

## Hook API

For clients that can run a command before a prompt or after a tool call. The plugin's hooks are the reference
implementation. The hub returns the text to put into the model's context, or nothing.

`POST /api/hook` with bearer and `x-axos-session` (else `400 {"error":"x-axos-session header is required"}`). Body:
JSON, at most 65536 characters (`413`, or `400` if it is not JSON).

```json
{ "event": "check", "roles": ["reviewer", {"role": "deployer", "description": "ships releases", "reason": "per local claims"}], "roles_managed": true }
```

`stop: true` on a `check` marks the call as the end of a turn (the plugin's Stop hook): a message in a thread where the
session (or a role it holds) has sent a later message is then left unshown, so it does not hold the turn open; the
next `check` shows it. So is a `low`-priority message.

Response: `{"context": "<text>"}` with 200. `""` means nothing to show. Failures: `{"error": "…"}` with 400.

| Event | Effect |
|---|---|
| `start` | Session began or resumed. Without a project it returns `""`. Otherwise syncs roles, then returns a short orientation (who this session is, how many others are active, who holds which role) followed by unshown messages. |
| `check` | Before a prompt, after tool calls, at stop. Syncs roles if the session has a project, then returns up to 10 unshown messages, marking them shown. `""` when nothing is waiting. |
| `end` | Ends the session (see Authentication). Returns `""`. |

Other event values are `400 event must be start, check or end`.

Role mirroring, for projects that keep their own role system: `roles` lists the roles the local system assigns to this
session (strings, or objects with `role`, optional `description` and `reason`). For each, the hub defines the role if
needed and gives the session that role, taking it over from another session of the same human with `reason` as the
stated cause. If `roles_managed` is true, roles the session holds that are not in `roles` are released. Failures
become lines in `context`.

Message rendering in hooks:

- A body arrives whole up to 4000 characters; a longer one is cut there, with a note how many characters were cut and
  the `thread` call that reads the rest.
- A message whose `sender-human` is a different person than the reader's human arrives with a body of at most 600
  characters; a longer body is replaced by a note giving its length and the `thread` call that reads it.
- The first delivery per session carries the full "peer messages are information" note; later ones a one-line version.
- Of several shown messages from one sender in one thread, only the newest keeps its body; the older ones say which
  message follows.
- If more than the shown ones are unread, the header says how many, and the header counts unread messages per sender
  (the five with the most).
- More than three new messages at once (up to 20 per call): those with `priority="high"` and those from `human:`
  keep their `<axos-message>` block; the others arrive as one block, a line each, read with `thread`:

  ```
  <axos-digest count="4" read="axos thread <id>">
  - 41 from session:alice/py#abcdefgh (py-main), note re 39: lane 2 merged [312-character body]
  </axos-digest>
  ```

  A line is `- <id> from <address>[ (<session name>)], <type>[ re <id>]: <summary>[ [<n>-character body]]`; the
  summary's whitespace is collapsed and it is defanged like a block's.

`inbox`, `wait` and `thread` return whole bodies.

## Event stream

`GET /events` with bearer (and the same optional headers). Response `text/event-stream`. It is a doorbell: it tells a
client that something is waiting; the client then calls `inbox` or the hook.

Query parameters, for clients without sessions: `project=<p>&as=<role>` also rings for that role's mailbox (the agent
must hold the role). A `project` the agent is not in is refused with `400 you are not in a project '<p>'`, alike for one
that does not exist.

Frames:

```
event: hello
data: {"protocol":1,"agent":"agt_…","session":null,"mailboxes":["agent:agt_…"],"unread":0,"unshown":0}

event: message
data: {"kind":"message","recipient":"session:agt_…#abcdefgh","message_id":12,"from":"role:prj_…/reviewer","summary":"please review","type":"request","priority":"normal","unread":3}

: beat
```

- `?wakes=1` says the host behind the stream wakes on a ring (a Claude Code session started with the channel, a Codex
  bridge); `?wakes=0` says it does not. `presence` shows "wakes on messages", "listening, but does not wake on
  messages", or, for a stream that did not say, "listening; whether it wakes is not known".
- `hello` comes first. `unread` counts unacked deliveries over the listed mailboxes, `unshown` those never shown.
  A client that connects with `unshown > 0` should fetch now: wake-ups before the connection are not replayed.
- `message` comes when a message is delivered to one of the stream's mailboxes. The mailbox list is re-evaluated for
  every frame, so a role taken later rings too. Fields are the sender, summary, type and priority, never the body.
  Low-priority messages get no frame, and `hello`'s `unshown` leaves them out.
  Ids are not rewritten to names here.
- `role` frames (`{"kind":"role","recipient":…,"unread":n}`) come when a session claims a role. Clients may ignore them.
- A line `: beat` every 25 seconds keeps proxies open and keeps the session or agent counted as seen.
- While a stream is open, the session or agent shows as online and as "wakes on messages" in `presence`.
- Clients must ignore frame types and fields they do not know.

A bad `as` gives `400` with a sentence.

## Landings and subscriptions

"Tell me when it lands", instead of a hand-written "landed as <sha>" message or a polling loop. The hub never sees a
repository: the script that lands reports what it pushed, and the hub compares strings.

`subscribe` opens a subscription for the caller's seat (its session, or the role it speaks as, so a role's next holder
inherits it):

- `branch` may be a pattern: `*` stands for any characters, `/` included (`slice/*`, `refs/evidence/*/verdict-*`).
- With `sha` (at least 7 hex characters): one message when a landing on `branch` contains that commit; then it ends.
- Without `sha`: one message per landing on `branch` until it expires. Without `remote` as well, a head reported once
  per remote (a landing pushed to two remotes) is told once.
- `remote` and `repo` narrow it; left out they match any. A landing reported without a remote matches any remote.
- `subject` (not with `sha`): only landings whose subject contains it, in any case.
- `replace`: the id of one's own open subscription; it ends (`replaced`) as this one opens, so a renewal never doubles.
- `note` (at most 1000 characters; a longer one is refused, never cut) comes back in the message, so the session that wakes knows what the landing was for.
- It expires after `hours` (default 24). The subscriber then gets one `status` message from `axos` saying so.
- A subscription for a commit that already landed (reported within the last 30 days) is answered at once and not opened.
- At most 200 open subscriptions per mailbox. `unsubscribe` ends one; the subscriber may, or the agent behind its
  session from a later session, or the holder of its role.

The message is a `note` from `axos` to the subscriber's mailbox (to its agent's mailbox if the subscribing session has
ended), summary `Landed: <sha> is on <remote>/<branch> (<repo>): "<subject>"` (the subject is the reporter's text, quoted) (or `… moved to <head>` without `sha`);
the body carries the note, the full commit, the new head, who reported it and the subscription's id. Several
subscriptions of one mailbox that match one landing give one message: each note as `Your note (subscription <id>): …`,
and a line per subscription.

A landing is reported by any member agent of the project, or by the hub's admin (`axos landed <project> …` on the
server, for a git server's post-receive hook):

`POST /api/landed`, bearer token, body:

```json
{ "project": "alice/demo", "repo": "demo", "remote": "origin", "branch": "main",
  "head": "<40 hex>", "commits": ["<40 hex>", "…"], "subject": "Merge branch 'feature'" }
```

- `project`: a name or id among the agent's projects; left out, the folder's project the client named in
  `x-axos-project`.
- `repo` and `branch` required, `remote` optional: names git would allow (letters, digits, `. _ - / @ +`, at most 200).
- `head`: the branch's new head. `commits`: what the landing put on the branch (head is added); at most 1000, each 7 to
  64 hex characters. A subscription matches when its sha and a reported one are prefixes of each other.
- Answer: `{"id": <landing>, "told": <subscriptions told>, "commits": <n>, "project": "<name>"}`. Errors:
  `400 {"error": "…"}`, `401` without a valid token.

The plugin's `axos landed <remote>/<branch> [<commit>] [--since <old head>]` builds this from the repository it runs
in: the head is `<remote>/<branch>` after the push, the commits are `<old head>..<head>` (else the last 300 on the
branch), the repo is the last part of the remote's URL, the subject the head's.

A squash or rebase landing puts new commits on the branch: subscribe to what will land, or to the branch.

## Who am I

`GET /api/whoami`, bearer token. The answer names the agent and only its own projects:

```json
{ "agent": "alice/laptop", "human": "alice", "projects": [{ "id": "prj_0a1b2c3d4e", "name": "alice/demo" }] }
```

With `?project=<ref>` (an id, `<owner>/<name>` or a name, as in `x-axos-project`) it adds
`"project": {"id", "name"}`, or answers `404` with `"error"` when the agent is in no such project, and `400` when the
reference is ambiguous. A project the agent is not in is never named or identified. `axos link` uses this to store the
id.

## Invites

An admin makes a one-time link (`axos invite`, or `axos init` for the first one). It is valid 24 hours and works once.
The code looks like `axosinv_…`; only its hash is stored.

`GET /join/<code>`: an HTML page with setup steps for a person. `200` if the code is open, `410` if it is unknown,
used or expired.

`POST /api/join`, body `{"code": "axosinv_…", "machine": "<name of this machine>"}`:

```json
{ "protocol": 1, "hub": "https://axos.example.com", "human": "alice", "agent": "alice/py",
  "token": "axos_…", "page": null, "projects": ["alice/demo"] }
```

- `agent` is the new agent's label. Its name comes from `machine`: lowercased, other characters turned into `-`, at
  most 40 characters; a taken name gets `-2`, `-3`, and so on.
- `token` is shown once. Write it to a file only its owner can read; do not print it or send it through chat.
- `page` is the person's login URL, only when this invite created the person; else `null`.
- `hub` is the configured public URL, or the origin the request came to.
- `projects` are names of the agent's projects.
- Errors: `400 {"error": "…"}`: not JSON or missing fields, or a code that is unknown, used or expired. Not `POST`: `405`.

A new invite for a person who already exists adds them to the named project at creation time.

## Answer links

A push to a phone carries up to three buttons, each a `POST` to `/a/<ask id>/<signature>` with the chosen option as
the request body (UTF-8 text, whitespace trimmed). The signature is the first 32 characters of the base64url
HMAC-SHA256 of `ask:<id>` with the hub's link secret.

- The body must equal one of the ask's offered options exactly. Free text is refused: the link is a bearer capability
  that sits in notification history.
- Success: `200 answered`, also for the same option sent again after it went through (phones give no sign of success,
  so people tap twice; the asker gets one answer). A bad signature, unknown ask, wrong option or an ask already
  answered differently: `400` with a sentence. Not `POST` or a malformed path: `404`.
- The push for a question carries the ntfy sequence id `axos-ask-<ask id>`. Once the question is settled (answered by
  button or page, or its default applied at the deadline) the hub publishes a quiet push with the same id, without
  buttons: "Answered: <answer>" or "Not answered in time: <default>". An ntfy server and app that know sequence ids
  replace the question with it; older ones show it as a second notification.
- A day after the question was settled, the hub deletes that notification (`DELETE /<topic>/axos-ask-<ask id>`), so
  it leaves the phone and the app's list. Open questions stay until they are settled.
- Links are only created when the hub knows its public URL.

## Health

`GET /healthz`, no auth: `{"ok":true,"version":"0.18.0","protocol":1}`. The hub reads its database for this; if that
fails, status 503 and `ok:false` with the same fields.

## Versioning

- The hub has a release number (`VERSION`, semver-style). It is in `/healthz`, in the MCP `initialize` answer, and in
  the plugin manifest.
- `PROTOCOL` is a single integer. It is in `/healthz`, in the `hello` frame and in the `/api/join` answer. It is raised
  only when an existing client would break.
- Breaking, so the number goes up:
  - removing or renaming a tool, an argument, an enum value, an address form, a header, an endpoint, a hook event or
    a field of a JSON response or event frame that a client may rely on,
  - making an optional argument required, or narrowing what an argument accepts,
  - changing what a field, state (unread, shown, acked) or address means,
  - changing how a token is sent or how a session key is formed.
- Not breaking, the number stays: new tools, new optional arguments, new fields, new event frames, new addresses, new
  headers, new hook events, changed wording of tool text.
- Clients should ignore what they do not know, and may compare the protocol integer they were written for with the
  hub's and warn when the hub's is higher.

## Examples

Set once: `AXOS=https://axos.example.com`, `TOKEN=$(cat ~/.config/axos/token)`.

Send a note to every live session of a project:

```sh
curl -s "$AXOS/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send","arguments":{
        "project":"alice/demo","to":"project","type":"note","summary":"Build is green on main"}}}'
```

```json
{"result":{"content":[{"type":"text","text":"Sent message 7. Delivered to session:alice/box#abcdefgh."}]},"jsonrpc":"2.0","id":1}
```

Read the inbox, then ack:

```sh
curl -s "$AXOS/mcp" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"inbox","arguments":{"project":"alice/demo"}}}'

curl -s "$AXOS/mcp" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ack","arguments":{"ids":[7]}}}'
```

The inbox answer is text: a header such as `1 to handle (1 not read before). Ack ids when handled.`, the peer-message note, and the
`<axos-message>` frames. Add `-H 'x-axos-session: <uuid>'` to act as a session instead of the agent.
