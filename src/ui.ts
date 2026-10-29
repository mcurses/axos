import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { AxosError, Hub, MESSAGE_TYPES } from "./hub.ts";

// The humans' page: a React app (web/, built into web/dist) and the JSON it reads and posts under /ui/api.
// Login: open /ui?key=<ui key> once; the key moves into a SameSite=Strict cookie scoped to /ui.

const COOKIE = "axos_ui";
// AXOS_WEB_DIST points elsewhere (tests, a separately built page).
const dist = () => resolve(process.env.AXOS_WEB_DIST ?? resolve(import.meta.dir, "..", "web", "dist"));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};

// Scripts and styles from the hub only; images from the hub and inline data (charts, icons). Peer text is rendered as
// text by React, so a message cannot bring script, a remote image or a frame along.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function handleUi(hub: Hub, req: Request, url: URL): Promise<Response> {
  const key = url.searchParams.get("key");
  if (key && url.pathname === "/ui") {
    if (!hub.authenticateHuman(key)) return new Response("unknown key\n", { status: 401 });
    const secure = url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https" ? "; Secure" : "";
    return new Response(null, { status: 303, headers: {
      Location: "/ui", "Set-Cookie": `${COOKIE}=${encodeURIComponent(key)}; Path=/ui; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`,
    } });
  }
  const human = hub.authenticateHuman(cookie(req, COOKIE) ?? "");

  if (url.pathname.startsWith("/ui/api/")) {
    if (!human) return json({ error: "not logged in: open the page link with your key once (/ui?key=…, from axos human key)" }, 401);
    if (req.method === "GET" && url.pathname === "/ui/api/state") return json(hub.display(JSON.stringify(state(hub, human)), { human }));
    if (req.method !== "POST") return json({ error: "not found" }, 404);
    // SameSite=Strict already keeps other sites out; JSON only and the Origin check are further locks.
    const origin = req.headers.get("origin");
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    if (origin && host && new URL(origin).host !== host) return json({ error: "bad origin" }, 403);
    if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return json({ error: "send JSON" }, 415);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
    try {
      if (url.pathname === "/ui/api/answer") {
        return json(hub.answerAsk(human, Number(b.ask), str("answer")));
      } else if (url.pathname === "/ui/api/ack") {
        hub.ack(`human:${human}`, [Number(b.id)]);
        return json({ ok: true });
      } else if (url.pathname === "/ui/api/send") {
        const sent = hub.send({ kind: "human", name: human }, {
          project: hub.projectId(str("project"), hub.projectsOfHuman(human)) ?? str("project"),
          to: str("to").split(",").map((s) => s.trim()).filter(Boolean),
          type: (str("type") || "note") as (typeof MESSAGE_TYPES)[number], summary: str("summary"), body: str("body"),
          re: b.re ? Number(b.re) : undefined, priority: str("priority") === "high" ? "high" : str("priority") === "low" ? "low" : "normal",
        });
        return json({ id: sent.id });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      if (e instanceof AxosError) return json({ error: hub.display(e.message, { human }) }, 400);
      throw e;
    }
  }

  const image = /^\/ui\/image\/(\d+)$/.exec(url.pathname);
  if (image && req.method === "GET") {
    if (!human) return new Response("not logged in\n", { status: 401 });
    const img = hub.imageForHuman(human, Number(image[1]));
    if (!img) return new Response("not found\n", { status: 404 });
    // Raster images only (checked on upload by their bytes); nothing on this response may run.
    return new Response(new Uint8Array(img.data), { headers: {
      "Content-Type": img.mime, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, max-age=86400", "Content-Disposition": "inline",
    } });
  }

  if (req.method !== "GET") return new Response("method not allowed\n", { status: 405 });
  return asset(url.pathname);
}

// The built app. Hashed files under assets/ are cached for good; everything else is the app's index.
function asset(path: string): Response {
  const DIST = dist();
  const rel = path.replace(/^\/ui\/?/, "");
  const file = resolve(DIST, rel);
  const inside = file.startsWith(DIST + sep);
  if (rel && inside && existsSync(file) && statSync(file).isFile()) {
    return new Response(readFileSync(file), { headers: {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff",
      "Cache-Control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    } });
  }
  if (rel.startsWith("assets/")) return new Response("not found\n", { status: 404 });
  const index = join(DIST, "index.html");
  if (!existsSync(index)) {
    return new Response("The page is not built: run `bun install && bun run build` in web/.\n", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return new Response(readFileSync(index), { headers: {
    "Content-Type": TYPES[".html"]!, "Cache-Control": "no-cache", "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin",
  } });
}

// Everything the page shows, as one document. Ids stay ids here; the caller turns them into names the human may see.
function state(hub: Hub, human: string) {
  const mine = hub.projectsOfHuman(human);
  const asks = hub.asks({ human, open: true }).map((a) => ({
    id: a.id, message_id: a.message_id, from: hub.label(a.asker), project: a.project, question: a.question,
    options: JSON.parse(a.options_json) as string[], default_answer: a.default_answer, deadline: a.deadline,
    created_at: hub.getMessage(a.message_id)?.created_at ?? null, images: hub.askImages(a.id).map((i) => ({ id: i.id, name: i.name })),
  }));
  hub.asksSeen(human, asks.map((a) => a.id));
  const inbox = hub.inbox(`human:${human}`, { limit: 50 }).filter((m) => m.type !== "ask").map((m) => ({
    id: m.id, from: m.sender.startsWith("session:") ? hub.label(m.sender) : m.sender, sender_human: m.sender_human, project: m.project,
    type: m.type, priority: m.priority, created_at: m.created_at, summary: m.summary, body: m.body, re: m.re,
  }));
  const sent = hub.sentToOthers(human, 50).map((m) => ({
    id: m.id, from: hub.senderTitle(m.sender), readers: m.readers, project: m.project, created_at: m.created_at, summary: m.summary, body: m.body,
  }));
  const projects = mine.map((p) => {
    const leases = hub.leases(p);
    return {
      id: p, brief: hub.brief(p), humans: hub.projectHumans(p), links: hub.linkedProjects(p),
      sessions: hub.presence(p).map((x) => ({
        label: hub.label(x.address), name: x.name, human: x.human, profile: x.profile, online: x.online, bell: x.wake === "wakes",
        unread: x.unread, unseen: x.unseen, roles: x.roles, last_seen: x.last_seen,
      })),
      roles: hub.roles(p).map((r) => ({ role: r.role, description: r.description, holder: r.holder ? hub.label(r.holder) : null,
        unread: hub.roleUnread(p, r.role), unseen: hub.unshownCount([`role:${p}/${r.role}`]) })),
      leases: leases.live.map((l) => ({ resource: l.resource, holder: hub.label(l.holder), until: l.expires_at, note: l.note })),
    };
  });
  return { human, now: hub.now(), types: MESSAGE_TYPES, asks, inbox, sent, projects };
}
