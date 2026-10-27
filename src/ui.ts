import { AxosError, Hub, iso, MESSAGE_TYPES } from "./hub.ts";
import { ago } from "./render.ts";

// One page for the humans: open questions with answer buttons, their inbox, and per project who holds what.
// Login: open /ui?key=<ui key> once; the key moves into a SameSite=Strict cookie.

const COOKIE = "axos_ui";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

function redirect(to: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: to, ...extra } });
}

export async function handleUi(hub: Hub, req: Request, url: URL): Promise<Response> {
  const key = url.searchParams.get("key");
  if (key) {
    if (!hub.authenticateHuman(key)) return new Response("unknown key\n", { status: 401 });
    const secure = url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https" ? "; Secure" : "";
    return redirect("/ui", { "Set-Cookie": `${COOKIE}=${encodeURIComponent(key)}; Path=/ui; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}` });
  }
  const human = hub.authenticateHuman(cookie(req, COOKIE) ?? "");
  if (!human) return page("AXOS", "<p>Open the link with your key once: <code>/ui?key=…</code> (from <code>axos human add</code>).</p>", 401);

  if (req.method === "POST") {
    // SameSite=Strict already keeps other sites out; the Origin check is a second lock.
    const origin = req.headers.get("origin");
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    if (origin && host && new URL(origin).host !== host) return new Response("bad origin\n", { status: 403 });
    const form = await req.formData();
    const f = (k: string) => String(form.get(k) ?? "");
    try {
      if (url.pathname === "/ui/answer") {
        const answer = f("choice") || f("answer");
        hub.answerAsk(human, Number(f("ask")), answer);
      } else if (url.pathname === "/ui/ack") {
        hub.ack(`human:${human}`, [Number(f("id"))]);
      } else if (url.pathname === "/ui/send") {
        hub.send({ kind: "human", name: human }, {
          project: hub.projectId(f("project"), hub.projectsOfHuman(human)) ?? f("project"), to: f("to").split(",").map((s) => s.trim()).filter(Boolean),
          type: (f("type") || "note") as (typeof MESSAGE_TYPES)[number], summary: f("summary"), body: f("body"),
          re: f("re") ? Number(f("re")) : undefined, priority: f("priority") === "high" ? "high" : "normal",
        });
      } else {
        return new Response("not found\n", { status: 404 });
      }
    } catch (e) {
      if (e instanceof AxosError) return page("AXOS: not done", `<p class="err">${esc(e.message)}</p><p><a href="/ui">Back</a></p>`, 400);
      throw e;
    }
    return redirect("/ui");
  }
  return page(`AXOS · ${human}`, hub.display(render(hub, human), { human }));
}

function render(hub: Hub, human: string): string {
  const now = hub.now();
  const out: string[] = [];
  const open = hub.asks({ human, open: true });
  out.push(`<h2>Questions for you (${open.length})</h2>`);
  if (!open.length) out.push(`<p class="muted">None open.</p>`);
  for (const a of open) {
    const options: string[] = JSON.parse(a.options_json);
    out.push(`<div class="card ask" id="m${a.message_id}">
      <div class="meta">${esc(hub.label(a.asker))} · ${esc(a.project)} · ${ago(hub.getMessage(a.message_id)!.created_at, now)}${a.deadline ? ` · default <b>${esc(a.default_answer ?? "")}</b> applies ${iso(a.deadline)}` : ""}</div>
      <pre>${esc(a.question)}</pre>
      <form method="post" action="/ui/answer"><input type="hidden" name="ask" value="${a.id}">
        ${options.map((o) => `<button name="choice" value="${esc(o)}">${esc(o)}${o === a.default_answer ? " (default)" : ""}</button>`).join(" ")}
        <textarea name="answer" rows="2" placeholder="or answer in your own words"></textarea><button>Send answer</button>
      </form></div>`);
  }

  const inbox = hub.inbox(`human:${human}`, { limit: 50 }).filter((m) => m.type !== "ask");
  out.push(`<h2>Messages to you (${inbox.length} unread)</h2>`);
  if (!inbox.length) out.push(`<p class="muted">Nothing unread.</p>`);
  for (const m of inbox) {
    out.push(`<div class="card" id="m${m.id}"><div class="meta">${esc(m.sender.startsWith("session:") ? hub.label(m.sender) : m.sender)} · ${esc(m.project)} · ${m.type}${m.priority === "high" ? " · <b>high</b>" : ""} · ${ago(m.created_at, now)}</div>
      <div class="summary">${esc(m.summary)}</div>${m.body ? `<pre>${esc(m.body)}</pre>` : ""}
      <form method="post" action="/ui/ack" class="inline"><input type="hidden" name="id" value="${m.id}"><button>Done</button></form></div>`);
  }

  const sent = hub.sentToOthers(human, 50);
  if (sent.length) {
    out.push(`<h2>Sent by your agents to other people (last ${sent.length})</h2>`);
    for (const m of sent) {
      out.push(`<details class="card"><summary><span class="meta">${esc(hub.senderTitle(m.sender))} → ${esc(m.readers.join(", "))} · ${esc(m.project)} · ${ago(m.created_at, now)}</span><br><span class="summary">${esc(m.summary)}</span></summary>${m.body ? `<pre>${esc(m.body)}</pre>` : ""}</details>`);
    }
  }

  for (const p of hub.projectsOfHuman(human)) {
    out.push(`<h2>Project ${esc(p)}</h2><div class="grid">`);
    out.push(`<div><h3>Agents</h3><ul>${hub.presence(p).map((a) => `<li><span class="dot ${a.online ? "on" : ""}"></span>${esc(hub.label(a.address))} <span class="muted">seen ${ago(a.last_seen, now)}${a.unread ? `, ${a.unread} unread` : ""}${a.roles.length ? `, ${esc(a.roles.join(", "))}` : ""}</span></li>`).join("")}</ul></div>`);
    out.push(`<div><h3>Roles</h3><ul>${hub.roles(p).map((r) => { const n = hub.roleUnread(p, r.role); return `<li>${esc(r.role)}: ${r.holder ? esc(hub.label(r.holder)) : `<span class="muted">vacant</span>`}${n ? ` <span class="muted">${n} unread</span>` : ""}</li>`; }).join("") || `<li class="muted">none</li>`}</ul></div>`);
    const ls = hub.leases(p);
    out.push(`<div><h3>Leases</h3><ul>${ls.live.map((l) => `<li>${esc(l.resource)}: ${esc(hub.label(l.holder))} <span class="muted">until ${iso(l.expires_at)}${l.note ? ` — ${esc(l.note)}` : ""}</span></li>`).join("")}${ls.waiting.map((w) => `<li class="muted">waiting for ${esc(w.resource)}: ${esc(w.agent_id)}</li>`).join("")}${ls.live.length + ls.waiting.length ? "" : `<li class="muted">none</li>`}</ul></div>`);
    out.push(`</div>`);
  }

  out.push(`<h2>Send a message</h2><form method="post" action="/ui/send" class="send">
    <label>Project <select name="project">${hub.projectsOfHuman(human).map((p) => `<option>${esc(p)}</option>`).join("")}</select></label>
    <label>To <input name="to" placeholder="role:main-coordinator, agent:alice/laptop, project" required></label>
    <label>Type <select name="type">${MESSAGE_TYPES.map((t) => `<option>${t}</option>`).join("")}</select></label>
    <label>Priority <select name="priority"><option>normal</option><option>high</option></select></label>
    <label class="wide">Summary <input name="summary" required maxlength="300"></label>
    <label class="wide">Body <textarea name="body" rows="4"></textarea></label>
    <button>Send</button></form>`);
  return out.join("\n");
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --card: #f5f5f7; --line: #d2d2d7; --accent: #0a66c2; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6; --card: #1c1c1e; --line: #3a3a3c; --accent: #4ea1ff; } }
  body { font: 15px/1.45 -apple-system, system-ui, sans-serif; color: var(--fg); max-width: 960px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 20px; } h2 { font-size: 17px; margin-top: 28px; border-bottom: 1px solid var(--line); padding-bottom: 4px; } h3 { font-size: 14px; margin: 8px 0; }
  .card { background: var(--card); border-radius: 10px; padding: 10px 12px; margin: 10px 0; }
  .ask { border-left: 4px solid var(--accent); }
  .meta, .muted { color: var(--muted); font-size: 13px; }
  .summary { font-weight: 600; margin: 4px 0; }
  pre { white-space: pre-wrap; font: 13px/1.4 ui-monospace, Menlo, monospace; margin: 6px 0; }
  button { font: inherit; padding: 5px 12px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; margin: 3px 2px; }
  button:hover { border-color: var(--accent); }
  textarea, input, select { font: inherit; width: 100%; box-sizing: border-box; padding: 5px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: var(--fg); margin: 4px 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
  ul { padding-left: 0; list-style: none; margin: 0; } li { margin: 3px 0; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--line); margin-right: 6px; } .dot.on { background: #34c759; }
  .send { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; } .send .wide { grid-column: 1 / -1; }
  .inline { display: inline; } .err { color: #ff3b30; }
</style></head>
<body><h1>${esc(title)}</h1>
${body}
<script>
  // Refresh every 20 s unless you are typing.
  setInterval(() => { const a = document.activeElement; if (!a || !/INPUT|TEXTAREA|SELECT/.test(a.tagName)) location.reload(); }, 20000);
</script>
</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
