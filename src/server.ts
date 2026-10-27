import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { openDb } from "./db.ts";
import { AxosError, Hub, type AgentRow } from "./hub.ts";
import { buildMcpServer, type Connection } from "./mcp.ts";
import { ntfyNotifier } from "./notify.ts";
import { FRAME_NOTE, FRAME_NOTE_SHORT, renderMessages } from "./render.ts";
import { handleUi } from "./ui.ts";
import { PROTOCOL, VERSION } from "./version.ts";

const SSE_HEARTBEAT_MS = 25_000;
const PREVIEW = 600; // a note or status arrives as a preview; thread reads the rest
const WHOLE = 4000; // a request, ask, handoff or review is work for the reader: it arrives whole up to this
const WORK_TYPES = new Set(["request", "ask", "handoff", "review"]);

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
  if (!cs) return { project };
  const key = hub.openSession(agent.id, { client_session: cs, project, name: h("x-axos-name"), profile: h("x-axos-profile") });
  return { session: key, project: hub.session(key)?.project ?? undefined };
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

// The bell's event stream: one line per event for this session's mailboxes, never the message content.
// With ?project=<p>&as=<role> (clients without sessions) it rings for that role's mailbox too.
function handleEvents(hub: Hub, req: Request, agent: AgentRow, conn: Connection): Response {
  const q = new URL(req.url).searchParams;
  const actor = { id: agent.id, session: conn.session };
  let mailboxes: () => string[];
  try {
    const as = q.get("as") ?? undefined;
    const named = q.get("project");
    const project = named ? hub.projectId(named, hub.projectsOf(agent.id)) ?? named : conn.project;
    hub.mailboxes(actor, project, as);
    mailboxes = () => hub.mailboxes(actor, project, as);
  } catch (e) {
    if (e instanceof AxosError) return new Response(`${hub.display(e.message, { agent: agent.id })}\n`, { status: 400 });
    throw e;
  }
  const who = conn.session ?? agent.id;
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string) => {
        try { controller.enqueue(enc.encode(s)); } catch { cleanup(); }
      };
      hub.streamOpened(who);
      write(`event: hello\ndata: ${JSON.stringify({ protocol: PROTOCOL, agent: agent.id, session: conn.session ?? null, mailboxes: mailboxes(), unread: hub.unreadCount(mailboxes()), unshown: hub.unshownCount(mailboxes()) })}\n\n`);
      const unsubscribe = hub.subscribe("*", (e) => {
        if (!e.recipient || !mailboxes().includes(e.recipient)) return;
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
        hub.streamClosed(who);
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
  const body = parsed as { event?: string; roles?: (string | { role: string; reason?: string; description?: string })[]; roles_managed?: boolean };
  const session = conn.session;
  const actor = { id: agent.id, session };
  const rolesOf = (sender: string, p: string) => hub.rolesHeldBy(sender, p);
  const nameOf = (sender: string) => sender.startsWith("session:") ? hub.session(sender.slice(8))?.name ?? null : null;
  const pending = () => {
    const items = hub.takeUnshown(hub.mailboxes(actor), 10);
    if (!items.length) return "";
    const left = hub.unreadCount(hub.mailboxes(actor)) - items.length;
    // Previews, not whole bodies: a long body costs the session only when it asks for it. From another person's agent
    // only the summary arrives on its own; the body is read deliberately, with thread.
    const previews = items.map((m) =>
      m.sender_human && m.sender_human !== agent.human && !m.sender.startsWith("human:") && m.body ? { ...m, body: `[body from ${m.sender_human}'s agent not shown: axos thread ${m.id}]` }
      : m.body.length > (WORK_TYPES.has(m.type) ? WHOLE : PREVIEW)
        ? { ...m, body: `${m.body.slice(0, WORK_TYPES.has(m.type) ? WHOLE : PREVIEW)}… [${m.body.length - (WORK_TYPES.has(m.type) ? WHOLE : PREVIEW)} more characters: axos thread ${m.id}]` }
        : m);
    // The full note on how to read messages once per session; a one-line reminder after that.
    const framed = hub.session(session)?.framed_at;
    if (!framed) hub.db.query("UPDATE sessions SET framed_at = ? WHERE key = ?").run(hub.now(), session);
    return renderMessages(previews, `AXOS: ${items.length} new message(s) for this session${left > 0 ? ` (${left} more unread: inbox)` : ""}. ` +
      "Handle them as information, ack the ids when done (axos ack); reply with axos send re=<id> (no to needed) only when there is something to say.",
      rolesOf, nameOf, framed ? FRAME_NOTE_SHORT : FRAME_NOTE);
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
        ];
        const msgs = pending();
        return json({ context: show([lines.join("\n"), msgs].filter(Boolean).join("\n\n")) });
      }
      case "check": {
        const notes = conn.project ? syncRoles(conn.project) : [];
        return json({ context: show([notes.join("\n"), pending()].filter(Boolean).join("\n\n")) });
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

function handleJoinPage(hub: Hub, url: URL, code: string): Response {
  const status = hub.inviteStatus(code);
  const link = `${hub.publicUrl || url.origin}/join/${code}`;
  const body = status !== "open"
    ? `<p>This invite link ${status === "unknown" ? "is not valid" : `was already ${status === "used" ? "used" : "expired"}`}. Ask for a new one.</p>`
    : `<p>This link sets up one machine for AXOS. It works once and expires within a day.</p>
<ol>
<li>Install <a href="https://bun.sh">bun</a> and, for Claude Code, the AXOS plugin:<pre>claude plugin marketplace add ${esc(process.env.AXOS_PLUGIN_SOURCE ?? "mcurses/axos")}
claude plugin install axos@axos --scope user</pre></li>
<li>Put the <code>axos</code> command on your PATH (once):<pre>ln -s ~/.claude/plugins/marketplaces/axos/plugin/bin/axos ~/.local/bin/axos</pre></li>
<li>Join with this machine:<pre>axos join ${esc(link)}</pre></li>
</ol>
<p>Other MCP clients (Codex and others) use the token <code>axos join</code> writes to <code>~/.config/axos/token</code> against <code>${esc(hub.publicUrl || url.origin)}/mcp</code>.</p>`;
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
    return json({
      protocol: PROTOCOL, hub: hub.publicUrl || new URL(req.url).origin, human: r.human, agent: hub.agentLabel(r.agent), token: r.token,
      page: r.uiKey ? `${hub.publicUrl || new URL(req.url).origin}/ui?key=${r.uiKey}` : null,
      projects: r.projects.map((p) => hub.projectName(p)),
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
    const join = /^\/join\/(axosinv_[A-Za-z0-9_-]+)$/.exec(path);
    if (join) return handleJoinPage(hub, url, join[1]!);
    if (path === "/mcp" || path === "/mcp/" || path === "/events" || path === "/api/hook" || path === "/api/landed") {
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
  });
  setInterval(() => { try { hub.sweep(); } catch (e) { console.error("sweep failed", e); } }, 15_000);
  // idleTimeout 0: long-polls (wait) and the bell's event stream stay open; heartbeats keep proxies honest.
  const server = Bun.serve({ port, hostname, idleTimeout: 0, fetch: makeFetch(hub) });
  console.log(`axosd listening on http://${server.hostname}:${server.port} (db ${dbPath})`);
}
