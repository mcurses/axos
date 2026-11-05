#!/usr/bin/env bun
// AXOS → vinea: a project's vinea board shows what AXOS holds for its person. Two widgets, each filled only on boards
// whose definition declares it (vinea/board.json):
//   axos           (List)  that project's open questions, then its unread messages, each linking to the AXOS page
//   axos-sessions  (Table) the session map: every live session of the person's projects, grouped by project
// It is a program of the person's, outside both products: it reads AXOS as one of their devices (the page's
// /ui/api/state?peek=1, which marks nothing as shown) and writes vinea widgets with a vinea agent token. Answers stay
// on the AXOS page and phone (vinea holds none); every link goes to the AXOS page (https).
//
//   bun contrib/vinea-bridge.ts login <link>   once: a link from `axos login-link` (it can then only read)
//   bun contrib/vinea-bridge.ts [--once]       fill the widgets every 20 s (or once)
// While running it also feeds the hub's health board when one is connected (axos board connect), on its schedule.
// vinea servers: VINEA_URL and VINEA_TOKEN, else the vinea CLI's ~/.config/vinea/config.json ("servers").

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { boardFeed, boardSettings } from "../plugin/bin/axos.ts";

const LOGIN_PATH = () => process.env.AXOS_VINEA_LOGIN ?? `${homedir()}/.config/axos/vinea-bridge.json`;
const POLL_MS = 20_000;
const REFRESH_MS = 120_000; // written again at least this often, so a definition's ttl_s (600) fires only when it stops

export interface AxosState {
  human: string;
  now: number;
  asks: { id: number; message_id: number; from: string; project: string; question: string; options: string[]; default_answer: string | null; deadline: string | null; created_at: string | null }[];
  inbox: { id: number; from: string; project: string; type: string; priority: string; created_at: string; summary: string; body: string | null }[];
  projects: { id: string; sessions: { label: string; name: string | null; human: string; online: boolean; bell: boolean; unread: number; roles: string[]; last_seen: number | null }[] }[];
}

type Item = { title: string; state?: string; detail?: string; meta?: { label: string; value: string }[]; tags?: string[]; link?: string };

const who = (s: string) => s.replace(/^(agent|human|session|script):/, "");
const cut = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// A detail keeps its lines (vinea's List detail takes short Markdown): a body's numbered points stay one per line.
// A line written as "1. … 2. … 3. …" is split before each next number in turn.
const points = (l: string) => {
  if (!/^\s*1\. /.test(l)) return l;
  let out = l, k = 2;
  for (let i; (i = out.search(new RegExp(`(?<=[.;:!?)]) ${k}\\. `))) > 0; k++) out = `${out.slice(0, i)}\n${out.slice(i + 1)}`;
  return out;
};
const block = (s: string, n: number) => {
  const t = s.split(/\r?\n/).map((l) => points(l.replace(/[ \t]+/g, " ").trimEnd())).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-GB", { timeZone: process.env.TZ || "Europe/Berlin", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** The `axos` List for one project: its open questions, then its unread messages, newest first. */
export function itemsFor(project: string, s: AxosState, base: string): { items: Item[]; empty: string } {
  const page = `${base.replace(/\/$/, "")}/ui`;
  const asks = s.asks.filter((a) => a.project === project).map((a): Item => {
    const meta = [{ label: "from", value: cut(who(a.from), 120) }];
    if (a.created_at) meta.push({ label: "asked", value: when(a.created_at) });
    if (a.deadline) meta.push({ label: "default", value: cut(`${a.default_answer ?? "none"} at ${when(a.deadline)}`, 120) });
    const options = a.options.length ? `Options:\n${a.options.map((o) => `- ${cut(o, 80)}`).join("\n")}` : "Free answer.";
    return { title: cut(a.question, 200), state: "waiting", detail: `${options}\n\nAnswer on the AXOS page or your phone.`, meta, tags: ["question"], link: `${page}#m${a.message_id}` };
  });
  const mail = s.inbox.filter((m) => m.project === project).sort((x, y) => y.id - x.id).map((m): Item => ({
    title: cut(m.summary || "(no summary)", 200),
    state: m.priority === "high" ? "warn" : ["request", "handoff", "review"].includes(m.type) ? "info" : "muted",
    detail: m.body ? block(m.body, 600) : undefined,
    meta: [{ label: "from", value: cut(who(m.from), 120) }, { label: "sent", value: when(m.created_at) }],
    tags: m.type === "note" ? undefined : [m.type],
    link: `${page}#m${m.id}`,
  }));
  return { items: [...asks, ...mail].slice(0, 40), empty: "Nothing from AXOS waiting for you here." };
}

/** The `axos-sessions` Table: sessions seen in the last day, across the person's projects, grouped by project. */
export function sessionRows(s: AxosState, base: string) {
  const day = 86_400_000;
  // Sessions only: a machine's own mailbox (an agent without a session, labelled like "ana/mac") is not a session.
  const isSession = (x: { name: string | null; label: string }) => x.name !== null || x.label.includes("#");
  const rows = s.projects.flatMap((p) => p.sessions.filter((x) => isSession(x) && (x.online || (x.last_seen !== null && s.now - x.last_seen < day))).map((x) => ({
    project: p.id,
    session: cut(x.name ?? who(x.label), 60),
    state: x.online ? { state: "ok", text: x.bell ? "online" : "online, no wake-up" } : { state: "muted", text: "away" },
    roles: x.roles.join(", "),
    unread: x.unread,
    seen: x.last_seen ? new Date(x.last_seen).toISOString() : "",
    who: x.human === s.human ? "" : x.human,
  })));
  return {
    columns: [
      { key: "session", label: "Session" }, { key: "state", label: "State", kind: "state" }, { key: "roles", label: "Roles" },
      { key: "unread", label: "Unread", kind: "number" }, { key: "seen", label: "Seen", kind: "ago" }, { key: "who", label: "Person" },
    ],
    rows: rows.slice(0, 500),
    group: "project",
    empty: `No session in the last day. The AXOS page: ${base.replace(/\/$/, "")}/ui`,
  };
}

interface Login { url: string; key: string }
interface Server { name: string; url: string; token: string }

function readLogin(): Login | null {
  const p = LOGIN_PATH();
  if (!existsSync(p)) return null;
  const c = JSON.parse(readFileSync(p, "utf8"));
  return c.url && c.key ? { url: String(c.url).replace(/\/$/, ""), key: String(c.key) } : null;
}

/** Redeems a one-time AXOS login link: this program becomes one of the person's devices ("program: axos vinea-bridge"). */
async function login(link: string): Promise<string> {
  const m = /^(https?:\/\/[^/]+)\/ui\/login\/(axoslogin_[A-Za-z0-9_-]+)$/.exec(link.trim());
  if (!m) throw new Error("not an AXOS login link (https://<hub>/ui/login/axoslogin_…): make one with axos login-link");
  const res = await fetch(link.trim(), { method: "POST", redirect: "manual", headers: { origin: m[1]!, "user-agent": "axos vinea-bridge" }, signal: AbortSignal.timeout(15_000) });
  const cookie = /axos_ui=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  if (!cookie) throw new Error(`the hub did not log this program in (${res.status}): ${(await res.text()).trim()}`);
  const p = LOGIN_PATH();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify({ url: m[1], key: decodeURIComponent(cookie[1]!) }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

function servers(): Server[] {
  if (process.env.VINEA_URL && process.env.VINEA_TOKEN) return [{ name: "env", url: process.env.VINEA_URL, token: process.env.VINEA_TOKEN }];
  const p = process.env.VINEA_CONFIG ?? `${homedir()}/.config/vinea/config.json`;
  if (!existsSync(p)) return [];
  return ((JSON.parse(readFileSync(p, "utf8")).servers ?? []) as Server[]).map((s) => ({ ...s, url: s.url.replace(/\/$/, "") }));
}

async function vinea(s: Server, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${s.url}${path}`, { ...init, headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${s.name} ${path}: ${res.status} ${(await res.text()).trim()}`);
  return res.json();
}

const written = new Map<string, { json: string; at: number }>();

/** One pass over every board of every server: each declared widget gets its data. Returns the widgets written. */
export async function pass(log = (s: string) => console.log(s)): Promise<number> {
  const l = readLogin();
  if (!l) throw new Error("no AXOS login: run `bun contrib/vinea-bridge.ts login <link>` with a link from `axos login-link`");
  const res = await fetch(`${l.url}/ui/api/state?peek=1`, { headers: { cookie: `axos_ui=${encodeURIComponent(l.key)}` }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401) throw new Error("AXOS no longer knows this login (signed out on the page?): log in again with a new link");
  if (!res.ok) throw new Error(`AXOS answered ${res.status}`);
  const state = (await res.json()) as AxosState;
  let n = 0;
  for (const s of servers()) {
    let boards: { id: string; project: string }[];
    try { boards = await vinea(s, "/api/boards"); } catch (e) { log(`skip ${s.name}: ${(e as Error).message}`); continue; }
    for (const b of boards) {
      const full = await vinea(s, `/api/board?id=${encodeURIComponent(b.id)}`);
      for (const w of full.widgets as { key: string; type: string }[]) {
        const want = w.key === "axos" ? "List" : w.key === "axos-sessions" ? "Table" : null;
        if (!want) continue;
        if (w.type !== want) { log(`${s.name} ${b.id}: widget '${w.key}' is a ${w.type}; the bridge fills a ${want}`); continue; }
        const props = w.key === "axos" ? itemsFor(b.project, state, l.url) : sessionRows(state, l.url);
        const json = JSON.stringify(props);
        const id = `${s.name} ${b.id} ${w.key}`;
        const last = written.get(id);
        if (last && last.json === json && Date.now() - last.at < REFRESH_MS) continue;
        await vinea(s, `/api/widget?board=${encodeURIComponent(b.id)}&key=${w.key}`, { method: "PUT", body: JSON.stringify({ type: want, props }) });
        if (!last || last.json !== json) log(`${id}: written`);
        written.set(id, { json, at: Date.now() });
        n++;
      }
    }
  }
  return n;
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === "login") {
      if (!arg) throw new Error("usage: bun contrib/vinea-bridge.ts login <AXOS login link>");
      console.log(`logged in; kept in ${await login(arg)}`);
    } else if (cmd === "--once") {
      const n = await pass();
      console.log(`${n} widget${n === 1 ? "" : "s"} written`);
    } else if (cmd === undefined) {
      let boardAt = 0;
      for (;;) {
        try { await pass(); } catch (e) { console.error(`${new Date().toISOString()} ${(e as Error).message}`); }
        // The hub's health board (axos board connect), fed from this loop: the bridge is the process that runs anyway.
        const board = boardSettings();
        if (board && Date.now() - boardAt >= board.every_s * 1000) {
          boardAt = Date.now();
          try { await boardFeed(); } catch (e) { console.error(`${new Date().toISOString()} board ${board.id}: ${(e as Error).message}`); }
        }
        await Bun.sleep(POLL_MS);
      }
    } else throw new Error("usage: bun contrib/vinea-bridge.ts [login <link> | --once]");
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
