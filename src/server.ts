import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { openDb } from "./db.ts";
import { AxosError, Hub, iso, MAX_IMAGE, type AgentRow, type InboxItem } from "./hub.ts";
import { buildMcpServer, type Connection } from "./mcp.ts";
import { ntfyNotifier } from "./notify.ts";
import { webPushSender } from "./webpush.ts";
import { FRAME_NOTE, FRAME_NOTE_SHORT, renderDigest, renderMessages } from "./render.ts";
import { handleUi } from "./ui.ts";
import { PLUGIN, PROTOCOL, VERSION } from "./version.ts";

const SSE_HEARTBEAT_MS = 25_000;
const WHOLE = 4000; // a body arrives whole up to this; thread reads the rest
const FOREIGN = 600; // from another person's agent, up to this
const DIGEST_AT = 3; // more new messages than this at once: the ordinary ones arrive as a digest

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
}

function unauthorized(): Response {
  return new Response("unauthorized\n", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="axos"' } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// The plugin names the Claude Code session and its project in headers; plain MCP clients send none and act as the agent.
function connection(hub: Hub, req: Request, agent: AgentRow): Connection {
  const h = (n: string) => {
    const v = req.headers.get(n);
    if (!v) return null;
    try { return decodeURIComponent(v); } catch { throw new AxosError(`header ${n} is not valid URI encoding`); }
  };
  const cs = h("x-axos-session");
  // The folder's project as the plugin names it (an id, '<owner>/<slug>' or a slug), among the agent's own projects.
  const ref = h("x-axos-project");
  let project: string | undefined;
  try { project = ref ? hub.projectId(ref, hub.projectsOf(agent.id)) ?? undefined : undefined; } catch { project = undefined; }
  // A named script of this agent (axos send --name): its own sender and mailbox in one project.
  const script = h("x-axos-script");
  if (script) {
    if (cs) throw new AxosError("send x-axos-script or x-axos-session, not both");
    if (!project) throw new AxosError(ref ? `you are not in a project '${ref}'` : "a script needs x-axos-project");
    return { session: hub.openScript(agent.id, project, script), project };
  }
  if (!cs) return { project };
  const key = hub.openSession(agent.id, { client_session: cs, project, name: h("x-axos-name"), profile: h("x-axos-profile") });
  // The plugin says so when it checked a send with quotes_human against the human's own prompts.
  return { session: key, project: hub.session(key)?.project ?? undefined, human_words: h("x-axos-human-words") === "checked" };
}

// Stateless MCP: a fresh server and transport per request, bound to the authenticated agent and session.
async function handleMcp(hub: Hub, req: Request, agent: AgentRow, conn: Connection): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed\n", { status: 405, headers: { Allow: "POST" } });
  const server = buildMcpServer(hub, agent, conn, req.signal);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close();
  }
}

// A script's inbox as JSON (axos inbox): its own mailbox, with ?as=<role> also that role's. Nothing is marked shown or
// acked here; ack with the ack tool. ?all=1 includes acked messages.
function handleInbox(hub: Hub, url: URL, agent: AgentRow, conn: Connection): Response {
  const q = url.searchParams;
  try {
    if (!conn.project) throw new AxosError("say which project: x-axos-project");
    const boxes = hub.mailboxes({ id: agent.id, session: conn.session }, conn.project, q.get("as") ?? undefined);
    const items = hub.inbox(boxes, { unreadOnly: q.get("all") !== "1", limit: Math.min(Number(q.get("limit") ?? 50) || 50, 200) });
    const doc = {
      project: conn.project, mailboxes: boxes.map((b) => hub.boxKey(b)), unread: hub.unreadCount(boxes),
      messages: items.map((m) => ({
        id: m.id, from: m.sender, from_name: m.sender.startsWith("session:") ? hub.session(m.sender.slice(8))?.name ?? null : null,
        sender_human: m.sender_human, sent_by: m.sent_by ? hub.label(m.sent_by) : null, project: m.project, type: m.type, priority: m.priority,
        summary: m.summary, body: m.body, re: m.re, thread: m.thread, via: m.via, sent: iso(m.created_at), acked: m.acked_at !== null,
      })),
    };
    return json(JSON.parse(hub.display(JSON.stringify(doc), { agent: agent.id })));
  } catch (e) {
    if (e instanceof AxosError) return json({ error: hub.display(e.message, { agent: agent.id }) }, 400);
    throw e;
  }
}

// The bell's event stream: one line per event for this session's mailboxes, never the message content.
// With ?project=<p>&as=<role> (clients without sessions) it rings for that role's mailbox too.
function handleEvents(hub: Hub, req: Request, agent: AgentRow, conn: Connection): Response {
  const q = new URL(req.url).searchParams;
  const actor = { id: agent.id, session: conn.session };
  let mailboxes: () => string[];
  try {
    const as = q.get("as") ?? undefined;
    const named = q.get("project");
    const project = (named ? hub.projectId(named, hub.projectsOf(agent.id)) : conn.project) ?? undefined;
    if (named && !project) throw new AxosError(`you are not in a project '${named}'`);
    hub.mailboxes(actor, project, as);
    mailboxes = () => hub.mailboxes(actor, project, as);
  } catch (e) {
    if (e instanceof AxosError) return new Response(`${hub.display(e.message, { agent: agent.id })}\n`, { status: 400 });
    throw e;
  }
  const who = conn.session ?? agent.id;
  const wakes = q.get("wakes") === "1" ? true : q.get("wakes") === "0" ? false : null;
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string) => {
        try { controller.enqueue(enc.encode(s)); } catch { cleanup(); }
      };
      hub.streamOpened(who, wakes);
      write(`event: hello\ndata: ${JSON.stringify({ protocol: PROTOCOL, agent: agent.id, session: conn.session ?? null, mailboxes: mailboxes().map((b) => hub.boxKey(b)), unread: hub.unreadCount(mailboxes()), unshown: hub.unshownCount(mailboxes(), true) })}\n\n`);
      const unsubscribe = hub.subscribe("*", (e) => {
        if (!hub.boxSees(mailboxes(), e)) return;
        // A low-priority message rings no bell: the session reads it at its next step.
        if (e.kind === "message" && e.priority === "low") return;
        write(`event: ${e.kind}\ndata: ${JSON.stringify({ ...e, unread: hub.unreadCount(mailboxes()) })}\n\n`);
      });
      const beat = setInterval(() => {
        if (conn.session) hub.openSession(agent.id, { client_session: hub.session(conn.session)!.client_session });
        else hub.touch(agent.id);
        write(": beat\n\n");
      }, SSE_HEARTBEAT_MS);
      let closed = false;
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(beat);
        unsubscribe();
        hub.streamClosed(who, wakes);
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener("abort", () => cleanup());
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
  });
}

// The plugin's hooks. Each returns the text to put into the session's context ("" = nothing), so a session that
// has nothing waiting pays nothing.
//   start  — session began (or resumed/cleared): a three-line orientation, roles mirrored from a local role system
//   check  — before a prompt, after tool calls, at stop: messages not yet shown to this session
//   end    — session closed: roles and leases are given up, role mail stays with the role
async function handleHook(hub: Hub, req: Request, agent: AgentRow, conn: Connection): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed\n", { status: 405 });
  if (!conn.session) return json({ error: "x-axos-session header is required" }, 400);
  const raw = await req.text();
  if (raw.length > 65_536) return json({ error: "hook body too large" }, 413);
  let parsed: unknown = {};
  try { parsed = JSON.parse(raw || "{}") ?? {}; } catch { return json({ error: "hook body is not JSON" }, 400); }
  const body = parsed as { event?: string; stop?: boolean; roles?: (string | { role: string; reason?: string; description?: string })[]; roles_managed?: boolean };
  const session = conn.session;
  const actor = { id: agent.id, session };
  const rolesOf = (sender: string, p: string) => hub.rolesHeldBy(sender, p);
  const nameOf = (sender: string) => sender.startsWith("session:") ? hub.session(sender.slice(8))?.name ?? null : null;
  const pending = () => {
    let items = hub.inbox(hub.mailboxes(actor), { unshownOnly: true, limit: 20 });
    // At the end of a turn, a message in a conversation the session has answered since does not hold it back; it is
    // shown with the next prompt instead.
    // Nor does a low-priority message: it waits for the next prompt or tool call, it never costs a turn of its own.
    if (body.stop) {
      const old = hub.superseded(session, items);
      items = items.filter((m) => !old.has(m.id) && m.priority !== "low");
    }
    hub.markShown(hub.mailboxes(actor), items.map((m) => m.id));
    if (!items.length) return "";
    const left = hub.unreadCount(hub.mailboxes(actor)) - items.length;
    // Whole bodies up to a few KB, so a message is actionable without a second call. A long body from another
    // person's agent is not put into the session's context unasked; the session reads it deliberately, with thread.
    // Repeats: of several messages from one sender in one thread, only the newest keeps its body.
    const newest = new Map<string, number>();
    for (const m of items) newest.set(`${m.sender}|${m.thread ?? m.id}`, m.id);
    const previews = items.map((m) => {
      const last = newest.get(`${m.sender}|${m.thread ?? m.id}`)!;
      if (last !== m.id && m.body) return { ...m, body: `[body left out: message ${last} from the same sender in this thread follows]` };
      const foreign = !!m.sender_human && m.sender_human !== agent.human && !m.sender.startsWith("human:");
      if (foreign && m.body.length > FOREIGN) {
        return { ...m, body: `[${m.body.length}-character body from ${m.sender_human}'s agent; another person's long text is read on request: thread ${m.id}]` };
      }
      return m.body.length > WHOLE ? { ...m, body: `${m.body.slice(0, WHOLE)}… [${m.body.length - WHOLE} more characters: thread ${m.id}]` } : m;
    });
    // The full note on how to read messages once per session; a one-line reminder after that.
    const framed = hub.session(session)?.framed_at;
    if (!framed) hub.db.query("UPDATE sessions SET framed_at = ? WHERE key = ?").run(hub.now(), session);
    // More than a few at once: a high-priority message and anything a human wrote keep their block, the rest become one
    // digest line each, read with thread.
    const urgent = (m: InboxItem) => m.priority === "high" || m.sender.startsWith("human:");
    const digest = previews.length > DIGEST_AT ? previews.filter((m) => !urgent(m)) : [];
    const whole = previews.filter((m) => !digest.includes(m));
    const senders = left > 0 || digest.length
      ? hub.unreadBySender(hub.mailboxes(actor)).slice(0, 5).map((x) => `${nameOf(x.sender) ?? x.sender} ${x.n}`)
      : [];
    const header = `AXOS: ${items.length} new message(s) for this session${left > 0 ? ` (${left} more to handle, read or not: inbox)` : ""}` +
      `${senders.length ? `; to handle by sender: ${senders.join(", ")}` : ""}. ` +
      `${digest.length ? `${digest.length} of them are listed in a digest: read one with thread <id>. ` : ""}` +
      "Handle them as information, ack the ids when done; reply with send re=<id> (no to needed) only when there is something to say.";
    const blocks = renderMessages(whole, header, rolesOf, nameOf, framed ? FRAME_NOTE_SHORT : FRAME_NOTE);
    if (!digest.length) return blocks;
    return `${whole.length ? blocks : `${header}\n${framed ? FRAME_NOTE_SHORT : FRAME_NOTE}`}\n\n${renderDigest(digest, nameOf)}`;
  };
  // Mirror a local role system (for example a repo's roles/claims): take the roles it names for this session, give up the others.
  const syncRoles = (p: string): string[] => {
    const notes: string[] = [];
    const named = (body.roles ?? []).map((r) => typeof r === "string" ? { role: r } : r);
    for (const r of named) {
      try {
        hub.defineRole(p, r.role, r.description);
        const held = hub.roles(p).find((x) => x.role === r.role)?.holder;
        if (held !== session) hub.claimRole(agent.id, p, r.role, r.reason ?? "the project's local role system names this session", session);
      } catch (e) {
        notes.push(`could not take role ${r.role}: ${(e as Error).message}`);
      }
    }
    if (body.roles_managed) {
      for (const role of hub.rolesHeldBy(`session:${session}`, p)) {
        if (!named.some((r) => r.role === role)) hub.releaseRole(agent.id, p, role, session);
      }
    }
    return notes;
  };
  // A session started on a plugin older than the one this hub ships with keeps that plugin's skill until it restarts:
  // say so once per session and plugin release (not at a stop, where any text would hold the turn open).
  const outdated = (): string => {
    const v = /^plugin\/(\d+(?:\.\d+)*)$/.exec(req.headers.get("x-axos-client") ?? "")?.[1];
    if (!v || body.stop || !older(v, PLUGIN) || told.has(`${session}|${PLUGIN}`)) return "";
    told.add(`${session}|${PLUGIN}`);
    return `AXOS: this session runs plugin ${v}; the current plugin is ${PLUGIN}. Its axos skill is from ${v} until the session restarts; ` +
      "the hub's behaviour is already the new one.";
  };
  try {
    const show = (s: string) => hub.display(s, { agent: agent.id });
    switch (body.event) {
      case "start": {
        const p = conn.project;
        if (!p) return json({ context: "" });
        const notes = syncRoles(p);
        const held = hub.rolesHeldBy(`session:${session}`, p);
        const others = hub.presence(p).filter((x) => x.address !== `session:${session}` && x.online);
        const holders = hub.roles(p).filter((r) => r.holder && r.holder !== session).map((r) => `${r.role}: ${hub.session(r.holder!)?.name ?? r.holder}`);
        const lines = [
          `AXOS hub: this session is ${hub.label(`session:${session}`)} in project ${p}${held.length ? `, holding the role ${held.join(", ")}` : ""}. ` +
            `${others.length} other session(s) are active${holders.length ? ` (${holders.join("; ")})` : ""}.`,
          "Messages from them and from your human appear in your context as <axos-message> blocks. " +
            `Messaging another session or role, leasing a shared resource, or asking ${agent.human} on their phone is described in the axos skill.`,
          ...notes,
          outdated(),
        ].filter(Boolean);
        const msgs = pending();
        return json({ context: show([lines.join("\n"), msgs].filter(Boolean).join("\n\n")) });
      }
      case "check": {
        const notes = conn.project ? syncRoles(conn.project) : [];
        return json({ context: show([outdated(), notes.join("\n"), pending()].filter(Boolean).join("\n\n")) });
      }
      case "end":
        hub.endSession(session, "the session closed");
        return json({ context: "" });
      default:
        return json({ error: "event must be start, check or end" }, 400);
    }
  } catch (e) {
    if (e instanceof AxosError) return json({ error: hub.display(e.message, { agent: agent.id }) }, 400);
    throw e;
  }
}

// Sessions told that their plugin is older than the hub, as '<session>|<hub version>'.
const told = new Set<string>();

function older(a: string, b: string): boolean {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

// An image for a question: the raw bytes, ?name=<file name>. The answer's id goes into ask_human's images as att:<id>.
async function handleAttach(hub: Hub, req: Request, url: URL, agent: AgentRow): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed\n", { status: 405 });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_IMAGE) return json({ error: `the limit is ${MAX_IMAGE} bytes` }, 413);
  const data = new Uint8Array(await req.arrayBuffer());
  try {
    const a = hub.attach(agent.id, url.searchParams.get("name") ?? "image", data);
    return json({ ...a, ref: `att:${a.id}` });
  } catch (e) {
    if (e instanceof AxosError) return json({ error: e.message }, 400);
    throw e;
  }
}

// Who this token is and which projects it is in; with ?project=<ref>, which project that reference means for it (as an
// id and a name), so a client can store the id. Only the caller's own projects are ever named.
function handleWhoami(hub: Hub, req: Request, url: URL, agent: AgentRow): Response {
  if (req.method !== "GET") return new Response("method not allowed\n", { status: 405 });
  const mine = hub.projectsOf(agent.id);
  const projects = mine.map((id) => ({ id, name: hub.projectName(id) }));
  const out = { agent: `${agent.human}/${agent.name}`, human: agent.human, projects };
  const ref = url.searchParams.get("project");
  if (ref === null) return json(out);
  try {
    const id = hub.projectId(ref, mine);
    if (!id || !mine.includes(id)) return json({ ...out, error: `you are not a member of a project '${ref}'` }, 404);
    return json({ ...out, project: { id, name: hub.projectName(id) } });
  } catch (e) {
    if (e instanceof AxosError) return json({ ...out, error: hub.display(e.message, { agent: agent.id }) }, 400);
    throw e;
  }
}

// A landing script reports what it pushed: {project?, repo, remote?, branch, head, commits?, subject?}. The project is
// the body's, or the folder's the client named in x-axos-project.
async function handleLanded(hub: Hub, req: Request, agent: AgentRow, conn: Connection): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed\n", { status: 405 });
  let b: Record<string, unknown>;
  try { b = (await req.json()) as Record<string, unknown>; } catch { return json({ error: "body must be JSON" }, 400); }
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
  const commits = Array.isArray(b.commits) ? b.commits.filter((c): c is string => typeof c === "string") : undefined;
  try {
    const named = str("project");
    const mine = hub.projectsOf(agent.id);
    const project = named ? hub.projectId(named, mine) : conn.project;
    if (!project) {
      return json({ error: named ? `you are not a member of project '${named}'` : "say which project: project in the body, or run it in a connected folder" }, 400);
    }
    const r = hub.reportLanding({ agentId: agent.id, session: conn.session }, {
      project, repo: str("repo") ?? "", remote: str("remote"), branch: str("branch") ?? "", head: str("head") ?? "", commits, subject: str("subject"),
    });
    return json({ ...r, project: hub.projectName(project) });
  } catch (e) {
    if (e instanceof AxosError) return json({ error: hub.display(e.message, { agent: agent.id }) }, 400);
    throw e;
  }
}

// Invites. A browser opening the link gets what to do; `axos join <link>` posts the code and the machine's name and gets
// the token back, so the token never travels through chat or mail.
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The setup for one machine, as a shell script the invite page offers: bun, the plugin, the command, the join, the
// page. Every step says what failed; the code inside dies with the join, so the script is worthless afterwards.
// The plugin's source as it may appear in a shell script or on the page: a GitHub owner/repo or a git URL, nothing else.
function pluginSource(): string {
  const s = process.env.AXOS_PLUGIN_SOURCE ?? "mcurses/axos";
  return /^[A-Za-z0-9._\/:@-]+$/.test(s) ? s : "mcurses/axos";
}

function setupScript(hub: Hub, origin: string, code: string, inviter: string | null): string {
  const base = hub.publicUrl || origin;
  return `#!/bin/sh
# AXOS setup for this machine, served by ${base}. It installs bun and the Claude Code plugin, joins with your invite
# (once), and opens your page. Safe to read first; it changes only ~/.bun, ~/.claude/plugins, ~/.local/bin and ~/.config/axos.
set -eu
LINK="${base}/join/${code}"
say() { printf '%s\n' "$*"; }
if ! command -v claude >/dev/null 2>&1; then
  say "Claude Code (the claude command) is not installed. Install it first (https://claude.com/claude-code), then run this again."; exit 1
fi
if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/bun" ]; then
  say "Installing bun (the AXOS plugin runs on it)..."
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || { say "bun did not install; see https://bun.sh/docs/installation, then run this again."; exit 1; }
fi
export PATH="$HOME/.bun/bin:$PATH"
say "Installing the AXOS plugin for Claude Code..."
claude plugin marketplace add '${pluginSource()}' >/dev/null 2>&1 || true
claude plugin install axos@axos --scope user >/dev/null 2>&1 || claude plugin update axos@axos >/dev/null 2>&1 || { say "The plugin did not install; run: claude plugin install axos@axos --scope user"; exit 1; }
AXOS="$HOME/.claude/plugins/marketplaces/axos/plugin/bin/axos"
[ -x "$AXOS" ] || { say "The plugin is installed but $AXOS is missing; tell ${inviter ?? "the hub's operator"}."; exit 1; }
mkdir -p "$HOME/.local/bin" && ln -sf "$AXOS" "$HOME/.local/bin/axos"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) say "Note: ~/.local/bin is not on your PATH, so 'axos' works inside Claude Code but not in this shell until you add it." ;; esac
"$AXOS" join "$LINK"
say ""
say "Done. Restart Claude Code (every open window), then say in any of them: tell ${inviter ?? "<a person here>"} hello"
say ""
say "After that, when you like: in a repo you work in, say to Claude Code: connect this folder to AXOS."
say "Your page is the app on a phone too: People, Log in another device, open the link on the phone, Add to Home Screen, Notifications on."
`;
}

function handleJoinPage(hub: Hub, url: URL, code: string): Response {
  const status = hub.inviteStatus(code);
  const base = hub.publicUrl || url.origin;
  const link = `${base}/join/${code}`;
  const inv = hub.inviteOf(code);
  const invited = inv?.invited_by && inv.invited_by !== inv.human ? inv.invited_by : null;
  const body = status !== "open"
    ? `<p>This invite link ${status === "unknown" ? "is not valid" : `was already ${status === "used" ? "used" : "expired"}`}. Ask for a new one.</p>`
    : `<p>${invited ? `<b>${esc(invited)}</b> invited you to their AXOS hub. You will be <b>${esc(inv!.human)}</b> here.` : `This link sets up one machine for <b>${esc(inv!.human)}</b> on this AXOS hub.`}
It works once and expires ${esc(new Date(inv!.expires_at).toUTCString().replace(/:\d\d GMT$/, " UTC"))}.</p>
${base.startsWith("https:") ? `<p>On the machine you use Claude Code on, paste this into a terminal. It installs what is needed, joins, and opens your page:</p>
<pre>curl -fsSL ${esc(link)}/setup | sh</pre>
<p>Or say this to Claude Code, which shows the script before running it:</p>
<pre>Set up AXOS from ${esc(link)}</pre>` : `<p>Say this to Claude Code on the machine you use it on; it shows the setup script before running it:</p>
<pre>Set up AXOS from ${esc(link)}</pre>`}
<p>Then restart Claude Code and say in any window: <b>tell ${esc(invited ?? "<a person here>")} hello</b>. Their reply reaches that window.</p>
<p>After that, when you like: in a repo you work in, say to Claude Code <b>connect this folder to AXOS</b>, and your sessions there find each other, hand work over, and reach your phone with questions. Your page is the app on a phone too.</p>
<details><summary>By hand instead</summary>
<ol>
<li>Install <a href="https://bun.sh">bun</a> and the AXOS plugin for Claude Code:<pre>claude plugin marketplace add ${esc(pluginSource())}
claude plugin install axos@axos --scope user</pre></li>
<li>Put the <code>axos</code> command on your PATH:<pre>mkdir -p ~/.local/bin &amp;&amp; ln -sf ~/.claude/plugins/marketplaces/axos/plugin/bin/axos ~/.local/bin/axos</pre></li>
<li>Join with this machine (it opens your page):<pre>axos join ${esc(link)}</pre></li>
<li>Restart Claude Code.</li>
</ol>
<p>Other MCP clients (Codex and others) use the token <code>axos join</code> writes to <code>~/.config/axos/token</code> against <code>${esc(base)}/mcp</code>.</p>
</details>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join AXOS</title><style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:720px;margin:2em auto;padding:0 16px}
pre{background:#f5f5f7;padding:8px;border-radius:6px;white-space:pre-wrap}@media(prefers-color-scheme:dark){body{background:#000;color:#f5f5f7}pre{background:#1c1c1e}}</style>
</head><body><h1>Join AXOS</h1>${body}</body></html>`;
  return new Response(html, { status: status === "open" ? 200 : 410, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

async function handleJoin(hub: Hub, req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed\n", { status: 405 });
  let body: { code?: unknown; machine?: unknown };
  try { body = (await req.json()) as typeof body; } catch { return json({ error: "body must be JSON: {code, machine}" }, 400); }
  if (typeof body.code !== "string" || typeof body.machine !== "string") return json({ error: "body must be JSON: {code, machine}" }, 400);
  try {
    const r = hub.redeemInvite(body.code, body.machine);
    const base = hub.publicUrl || new URL(req.url).origin;
    return json({
      protocol: PROTOCOL, hub: base, human: r.human, agent: hub.agentLabel(r.agent), token: r.token,
      page: `${base}/ui/login/${r.login}`, // one-time, ten minutes: logs this machine's browser in
      invited_by: r.invited_by, projects: r.projects.map((p) => hub.projectName(p)),
    });
  } catch (e) {
    if (e instanceof AxosError) return json({ error: e.message }, 400);
    throw e;
  }
}

// An answer button on the phone: POST /a/<ask>/<signature> with the option as the body.
async function handleAnswerLink(hub: Hub, req: Request, path: string): Promise<Response> {
  const m = /^\/a\/(\d+)\/([A-Za-z0-9_-]+)$/.exec(path);
  if (!m || req.method !== "POST") return new Response("not found\n", { status: 404 });
  try {
    hub.answerByLink(Number(m[1]), m[2]!, (await req.text()).trim());
    return new Response("answered\n");
  } catch (e) {
    if (e instanceof AxosError) return new Response(`${e.message}\n`, { status: 400 });
    throw e;
  }
}

export function makeFetch(hub: Hub) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/healthz") {
      // Touches the database, so a hub that cannot read it is not reported healthy.
      try { hub.db.query("SELECT 1").get(); } catch { return json({ ok: false, version: VERSION, protocol: PROTOCOL }, 503); }
      return json({ ok: true, version: VERSION, protocol: PROTOCOL });
    }
    if (path === "/api/join") return handleJoin(hub, req);
    const setup = /^\/join\/(axosinv_[A-Za-z0-9_-]+)\/setup$/.exec(path);
    if (setup && req.method === "GET") {
      if (hub.inviteStatus(setup[1]!) !== "open") return new Response("echo 'This invite link is not open any more; ask for a new one.'; exit 1\n", { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
      const inv = hub.inviteOf(setup[1]!);
      return new Response(setupScript(hub, url.origin, setup[1]!, inv?.invited_by && inv.invited_by !== inv.human ? inv.invited_by : null),
        { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    }
    const join = /^\/join\/(axosinv_[A-Za-z0-9_-]+)$/.exec(path);
    if (join) return handleJoinPage(hub, url, join[1]!);
    if (path === "/mcp" || path === "/mcp/" || path === "/events" || path === "/api/hook" || path === "/api/landed" || path === "/api/whoami" || path === "/api/unshown" || path === "/api/attach" || path === "/api/inbox") {
      const token = bearer(req);
      const agent = token ? hub.authenticateAgent(token) : null;
      if (!agent) return unauthorized();
      let conn: Connection;
      try {
        conn = connection(hub, req, agent);
      } catch (e) {
        if (e instanceof AxosError) return new Response(`${e.message}\n`, { status: 400 });
        throw e;
      }
      if (path === "/events") return handleEvents(hub, req, agent, conn);
      if (path === "/api/hook") return handleHook(hub, req, agent, conn);
      if (path === "/api/landed") return handleLanded(hub, req, agent, conn);
      if (path === "/api/whoami") return handleWhoami(hub, req, url, agent);
      if (path === "/api/attach") return handleAttach(hub, req, url, agent);
      if (path === "/api/inbox") return handleInbox(hub, url, agent, conn);
      if (path === "/api/unshown") {
        // For a doorbell deciding whether a ring is still news: what waits that no hook has shown yet.
        if (!conn.session) return json({ error: "x-axos-session header is required" }, 400);
        const boxes = hub.mailboxes({ id: agent.id, session: conn.session });
        return json({ unshown: hub.unshownCount(boxes, true), unread: hub.unreadCount(boxes) });
      }
      return handleMcp(hub, req, agent, conn);
    }
    if (path.startsWith("/a/")) return handleAnswerLink(hub, req, path);
    if (path === "/ui" || path.startsWith("/ui/")) return handleUi(hub, req, url);
    if (path === "/") return Response.redirect(new URL("/ui", url).toString(), 302);
    return new Response("not found\n", { status: 404 });
  };
}

if (import.meta.main) {
  const dbPath = process.env.AXOS_DB ?? "axos.db";
  const port = Number(process.env.AXOS_PORT ?? 18900);
  const hostname = process.env.AXOS_HOST ?? "127.0.0.1";
  const hub = new Hub(openDb(dbPath), {
    publicUrl: process.env.AXOS_PUBLIC_URL,
    linkSecret: process.env.AXOS_LINK_SECRET || undefined,
    notifier: process.env.AXOS_NTFY_URL ? ntfyNotifier(process.env.AXOS_NTFY_URL, process.env.AXOS_NTFY_TOKEN) : undefined,
    // The page's own pushes need a VAPID subject the push services accept: the hub's https URL.
    webPush: /^https:/.test(process.env.AXOS_PUBLIC_URL ?? "") ? (keys) => webPushSender(process.env.AXOS_PUBLIC_URL!.replace(/\/$/, ""), keys) : undefined,
  });
  setInterval(() => { try { hub.sweep(); } catch (e) { console.error("sweep failed", e); } }, 15_000);
  // idleTimeout 0: long-polls (wait) and the bell's event stream stay open; heartbeats keep proxies honest.
  // development: false, so an unexpected error answers 500 without Bun's page of source code (seen live 2026-10-31).
  const server = Bun.serve({ port, hostname, idleTimeout: 0, development: process.env.AXOS_DEV === "1", fetch: makeFetch(hub) });
  console.log(`axosd listening on http://${server.hostname}:${server.port} (db ${dbPath})`);
}
