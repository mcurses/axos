#!/usr/bin/env bun
// The AXOS plugin's one local program, no dependencies.
//   axos.ts mcp          stdio MCP server for Claude Code: forwards to the hub with this session's identity, and pushes new
//                        messages into the session as channel events (when the session was started with channels on)
//   axos.ts hook <event> Claude Code hooks: start (SessionStart), prompt (UserPromptSubmit), tool (PostToolUse),
//                        stop (Stop), end (SessionEnd). Prints nothing when nothing is waiting, so a session pays nothing.
//   axos join <link>     for a person: set this machine up with an invite link (writes the config and the token)
//   axos link [<project>] connect this repo to a project on this machine only (matched by its git remote, so every clone
//                        and worktree of it); nothing is written into the repo
//   axos unlink          undo that
//   axos trust           for a person at a terminal: accept the .axos.json of this folder, once per machine
//   axos whoami          what this folder and this machine look like to AXOS
//   axos landed <remote>/<branch> [<commit>] [--since <old head>]
//                        for a landing script, after a successful push: tells AXOS what is now on the branch, so every
//                        session subscribed to one of those commits (or to the branch) gets a message
//   axos codex-bell --thread <codex session> [--session <id>]
//                        keep running beside an interactive Codex: when an AXOS message arrives, `codex queue` wakes it
//
// Configuration: ~/.config/axos/config.json (see plugin README). A folder belongs to a project through a "folders" entry
// in the config (a folder path, or a git remote that `axos link` wrote), or through a committed .axos.json ({"hub": "<url>", "project": "<owner>/<name>", "id": "prj_…"}) at or
// above it, once the person on this machine has trusted that file: a cloned repo must not steer sessions into a project.

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

interface FolderRule {
  path?: string; // this folder and everything below it
  remote?: string; // or: every checkout whose git remotes include this one (as remoteKey() writes it)
  project: string; // an id (prj_…) or a name
  name?: string; // the project's name when project is an id, for people reading the file
  // A local role system to mirror into AXOS: a directory of JSON claim files {"role", "session_id"} (for example a repo's roles/claims).
  roles_dir?: string;
  roles_ignore?: string[]; // roles not mirrored (e.g. adhoc, which many sessions hold at once)
  quiet_roles?: string[]; // sessions holding one of these get no AXOS at all (e.g. elevated, which runs without permission checks)
}

interface Config {
  url: string;
  token_file?: string;
  profiles?: Record<string, string>; // profile name -> token file
  folders?: FolderRule[];
  check_every_s?: number; // how often PostToolUse looks for new messages during a long turn
}

const HOME = homedir();
const CONFIG_PATH = process.env.AXOS_CONFIG ?? join(HOME, ".config", "axos", "config.json");
const TRUST_PATH = join(dirname(CONFIG_PATH), "trusted.json"); // { "<folder of an .axos.json>": "<its id or project>" }
const TIMEOUT_MS = 4000;
const PLUGIN_VERSION = readJson<{ version?: string }>(join(dirname(import.meta.dir), ".claude-plugin", "plugin.json"))?.version ?? "unknown";

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function config(): Config | null {
  const c = readJson<Config>(CONFIG_PATH);
  return c?.url ? c : null;
}

const expand = (p: string) => p.replace(/^~(?=\/|$)/, HOME);

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude");
}

// ~/.claude -> main, ~/.claude-work -> work
function profile(): string {
  const b = basename(configDir());
  return b === ".claude" ? "main" : b.replace(/^\.claude-?/, "") || "main";
}

// The one place that decides which file holds this profile's token: reading it and `axos join` writing it.
function tokenPath(c: Partial<Config>): string {
  return expand(process.env.AXOS_TOKEN_FILE ?? c.profiles?.[profile()] ?? c.token_file ?? join(HOME, ".config", "axos", "token"));
}

function token(c: Config): string | null {
  const file = tokenPath(c);
  try {
    return readFileSync(expand(file), "utf8").trim() || null;
  } catch {
    return null;
  }
}

// The harness's own record of a running session: name ("shop-e9"), current session id, cwd.
interface SessionFile { pid: number; sessionId: string; cwd?: string; name?: string }

function sessionFiles(): SessionFile[] {
  const dir = join(configDir(), "sessions");
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readJson<SessionFile>(join(dir, f))).filter((x): x is SessionFile => !!x?.sessionId);
  } catch {
    return [];
  }
}

function sessionById(id: string): SessionFile | null {
  return sessionFiles().find((s) => s.sessionId === id) ?? null;
}

// The MCP server is a child of the Claude Code process; its session file follows /clear and resume.
function sessionOfParent(): SessionFile | null {
  return readJson<SessionFile>(join(configDir(), "sessions", `${process.ppid}.json`));
}

// A path rule wins (the longest); otherwise a remote rule naming one of the checkout's remotes.
function folderRule(c: Config, cwd: string): FolderRule | null {
  const byPath = (c.folders ?? []).filter((r) => r.path).map((r) => ({ ...r, path: resolve(expand(r.path!)) }))
    .filter((r) => cwd === r.path || cwd.startsWith(`${r.path}/`))
    .sort((a, b) => b.path.length - a.path.length);
  if (byPath[0]) return byPath[0];
  const byRemote = (c.folders ?? []).filter((r) => r.remote);
  if (!byRemote.length) return null;
  const keys = new Set(gitRemotes(cwd)?.remotes.map((r) => r.key));
  return byRemote.find((r) => keys.has(r.remote!)) ?? null;
}

// ---------------------------------------------------------------- git, read from files (hooks run on every prompt)

// The checkout around cwd: its top folder and its remotes. A worktree's .git is a file pointing into the main
// repository, whose config holds the remotes.
function gitRemotes(cwd: string): { root: string; remotes: { name: string; url: string; key: string }[] } | null {
  for (let d = resolve(cwd); ; d = dirname(d)) {
    const dotgit = join(d, ".git");
    let gitdir: string | null = null;
    try {
      const text = readFileSync(dotgit, "utf8");
      const m = /^gitdir:\s*(.+)$/m.exec(text);
      if (m) gitdir = resolve(d, m[1]!.trim());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EISDIR") gitdir = dotgit;
    }
    if (gitdir) {
      let common = gitdir;
      try { common = resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim()); } catch { /* not a worktree */ }
      let config = "";
      try { config = readFileSync(join(common, "config"), "utf8"); } catch { /* no config */ }
      const remotes: { name: string; url: string; key: string }[] = [];
      let section: string | null = null;
      for (const line of config.split("\n")) {
        const head = /^\s*\[remote\s+"([^"]+)"\]/.exec(line);
        if (head) { section = head[1]!; continue; }
        if (/^\s*\[/.test(line)) { section = null; continue; }
        const url = section ? /^\s*url\s*=\s*(.+?)\s*$/.exec(line) : null;
        if (url && section) remotes.push({ name: section, url: url[1]!, key: remoteKey(url[1]!, d) });
      }
      return { root: d, remotes };
    }
    if (d === dirname(d)) return null;
  }
}

// One spelling per repository: 'git@github.com:a/b.git', 'https://user@github.com/a/b' and 'ssh://git@github.com:22/a/b'
// all become 'github.com/a/b'. No user, password or port is kept, so a token in a URL never reaches the config.
function remoteKey(url: string, base: string): string {
  let host = "", path = "";
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(url);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      if (u.protocol === "file:") return `file:${resolve(decodeURIComponent(u.pathname)).replace(/\.git$/, "")}`;
      host = u.hostname; path = decodeURIComponent(u.pathname);
    } catch { return url; }
  } else if (scp && !url.startsWith("/") && !url.startsWith(".")) {
    host = scp[1]!; path = scp[2]!;
  } else {
    return `file:${resolve(base, url).replace(/\/+$/, "").replace(/\.git$/, "")}`;
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return `${host}/${path}`.toLowerCase();
}

interface RepoFile { hub?: string; project?: string; id?: string }

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, "").replace(/\/.*$/, ""); } };

// The repo's file is someone else's text: only a well-formed id and name are taken from it, and only they are ever
// quoted to a model or a person.
const PROJECT_ID_RE = /^prj_[0-9a-z]{10}$/;
const PROJECT_NAME_RE = /^([a-z0-9][a-z0-9._-]{0,47}\/)?[a-z0-9][a-z0-9._-]{0,47}$/;

// The nearest .axos.json at or above the folder, if it is meant for this machine's hub and well formed.
function repoFile(c: Config, cwd: string): { dir: string; file: RepoFile; ref: string } | null {
  for (let d = resolve(cwd); ; d = dirname(d)) {
    const raw = readJson<RepoFile>(join(d, ".axos.json"));
    if (raw) {
      const file: RepoFile = {
        hub: typeof raw.hub === "string" ? raw.hub : undefined,
        project: typeof raw.project === "string" && PROJECT_NAME_RE.test(raw.project) ? raw.project : undefined,
        id: typeof raw.id === "string" && PROJECT_ID_RE.test(raw.id) ? raw.id : undefined,
      };
      if (!file.project && !file.id) return null; // nothing usable in it
      if (file.hub && hostOf(file.hub) !== hostOf(c.url)) return null; // another hub's project
      return { dir: d, file, ref: file.id ?? file.project! };
    }
    if (d === dirname(d) || d === HOME) return null;
  }
}

function trusted(dir: string, ref: string): boolean {
  return readJson<Record<string, string>>(TRUST_PATH)?.[dir] === ref;
}

// A committed .axos.json the person on this machine trusted wins over the personal config, so a repo shared with
// teammates names its project once. One nobody trusted yet gives no project, and says so (untrusted).
function projectOf(c: Config, cwd: string): { project: string | null; rule: FolderRule | null; untrusted?: { dir: string; file: RepoFile } } {
  const rule = folderRule(c, cwd);
  const repo = repoFile(c, cwd);
  if (repo && trusted(repo.dir, repo.ref)) return { project: repo.ref, rule };
  return { project: rule?.project ?? null, rule, ...(repo ? { untrusted: { dir: repo.dir, file: repo.file } } : {}) };
}

// Roles a local role system gives this session. null = no local role system for this folder.
function localRoles(rule: FolderRule | null, sessionId: string): string[] | null {
  if (!rule?.roles_dir) return null;
  const dir = expand(rule.roles_dir);
  const roles: string[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const claim = readJson<{ role?: string; session_id?: string }>(join(dir, f));
      if (claim?.role && claim.session_id === sessionId) roles.push(claim.role);
    }
  } catch {
    return null;
  }
  return roles;
}

interface Identity {
  c: Config;
  token: string;
  sessionId: string;
  name: string | null;
  cwd: string;
  project: string | null;
  untrusted?: { dir: string; file: RepoFile };
  rule: FolderRule | null;
  quiet: boolean;
  roles: string[] | null; // mirrored from the local role system
}

function identity(sessionId: string | undefined, cwd: string | undefined, name?: string | null): Identity | null {
  const c = config();
  if (!c || !sessionId) return null;
  const t = token(c);
  if (!t) return null;
  const sf = sessionById(sessionId);
  const dir = cwd ?? sf?.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const { project, rule, untrusted } = projectOf(c, dir);
  const roles = localRoles(rule, sessionId);
  const quiet = !!roles?.some((r) => rule?.quiet_roles?.includes(r));
  const mirrored = roles?.filter((r) => !rule?.roles_ignore?.includes(r) && !rule?.quiet_roles?.includes(r)) ?? null;
  return { c, token: t, sessionId, name: name ?? sf?.name ?? null, cwd: dir, project, untrusted, rule, quiet, roles: mirrored };
}

function headers(id: Identity): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${id.token}`,
    "x-axos-session": id.sessionId,
    "x-axos-profile": encodeURIComponent(profile()),
  };
  if (id.project) h["x-axos-project"] = encodeURIComponent(id.project);
  if (id.name) h["x-axos-name"] = encodeURIComponent(id.name);
  return h;
}

async function hookCall(id: Identity, event: string, stop = false): Promise<{ context?: string; error?: string }> {
  const res = await fetch(`${id.c.url.replace(/\/$/, "")}/api/hook`, {
    method: "POST",
    headers: { ...headers(id), "Content-Type": "application/json" },
    body: JSON.stringify({ event, stop: stop || undefined, roles: id.roles ?? undefined, roles_managed: id.roles !== null }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) return { error: "token" };
  return (await res.json()) as { context?: string; error?: string };
}

// ---------------------------------------------------------------- hooks

const HOOK_EVENT: Record<string, string> = { start: "SessionStart", prompt: "UserPromptSubmit", tool: "PostToolUse" };

function stateFile(sessionId: string): string {
  const dir = join(process.env.CLAUDE_PLUGIN_DATA ?? join(tmpdir(), "axos-plugin"), "state");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId}.json`);
}

// Whether the Claude Code process this hook runs under was started without the AXOS channel, so an idle session is
// not woken by a message. null: no Claude Code process found among the ancestors (another client, or ps failed).
function wakeupOff(argsOf = (pid: number) => Bun.spawnSync(["ps", "-o", "ppid=,args=", "-p", String(pid)], { stderr: "ignore" }).stdout.toString()): boolean | null {
  let pid = process.ppid;
  for (let i = 0; i < 6 && pid > 1; i++) {
    const m = /^\s*(\d+)\s+(.*)$/s.exec(argsOf(pid).trim());
    if (!m) return null;
    const args = m[2]!;
    // The executable is claude, or an interpreter running it (node, a wrapper script).
    const [a0 = "", a1 = ""] = args.split(/\s+/);
    if (basename(a0) === "claude" || (/^(node|bun|bash|sh|zsh)$/.test(basename(a0)) && (basename(a1) === "claude" || a1.includes("@anthropic-ai/claude-code")))) {
      return !/--(dangerously-load-development-channels|channels)[ =]\S*plugin:axos@/.test(args);
    }
    pid = Number(m[1]);
  }
  return null;
}

const WAKEUP_OFF = "Idle wake-up is off for this session: Claude Code was started without " +
  "`--dangerously-load-development-channels plugin:axos@axos`, so a message reaches it only with the next prompt or tool call. " +
  "Tell your user if they expect messages while you are idle.";

async function hook(kind: string): Promise<void> {
  const input = (await Bun.stdin.json().catch(() => ({}))) as { session_id?: string; cwd?: string; stop_hook_active?: boolean; session_title?: string };
  const id = identity(input.session_id, input.cwd, input.session_title);
  if (id && !id.quiet && !id.project && id.untrusted && kind === "start") {
    // Said once per session, and only in a folder whose repo asks to join a project.
    const f = id.untrusted.file; // validated: only a project name or id
    const context = `This repo's .axos.json names the AXOS project ${f.project ?? f.id}. This machine has not trusted that file, ` +
      "so AXOS is off in this session. Tell your user; if they want it, they run `axos trust` themselves. Do not run it for them.";
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
    return;
  }
  if (!id || id.quiet || !id.project) return; // not configured, a quiet role, or a folder outside every project: no cost
  const state = readJson<{ last_check?: number; unreachable?: boolean }>(stateFile(id.sessionId)) ?? {};
  if (kind === "tool") {
    const every = (id.c.check_every_s ?? 30) * 1000;
    if (state.last_check && Date.now() - state.last_check < every) return;
  }
  if (kind === "stop" && input.stop_hook_active) return;
  let context = "";
  try {
    const r = await hookCall(id, kind === "end" ? "end" : kind === "start" ? "start" : "check", kind === "stop");
    // A refused token is not an outage: say it at session start, where a person can act on it.
    if (r.error === "token") context = kind === "start" ? `The AXOS hub (${id.c.url}) refused this machine's token: it was revoked or is wrong. AXOS is off until a person fixes it.` : "";
    else context = r.context ?? "";
    if (state.unreachable && kind !== "end") context = ["AXOS hub is reachable again.", context].filter(Boolean).join("\n\n");
    state.unreachable = false;
  } catch {
    // Say it once, not on every prompt.
    if (!state.unreachable && kind !== "end") context = `AXOS hub (${id.c.url}) is unreachable; messages from other sessions will not arrive until it is back.`;
    state.unreachable = true;
  }
  if (kind === "start" && context && !state.unreachable && wakeupOff() === true) context = `${context}\n${WAKEUP_OFF}`;
  state.last_check = Date.now();
  writeFileSync(stateFile(id.sessionId), JSON.stringify(state));
  if (!context || kind === "end") return;
  if (kind === "stop") {
    // New messages arrived during the turn: let the session look at them before it stops.
    process.stdout.write(JSON.stringify({ decision: "block", reason: context }));
    return;
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: HOOK_EVENT[kind], additionalContext: context } }));
}

// ---------------------------------------------------------------- stdio MCP server

function write(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function currentIdentity(): Identity | null {
  const sf = sessionOfParent();
  // Clients other than Claude Code (a Codex wrapper) name their session with AXOS_SESSION_NAME.
  return identity(sf?.sessionId ?? process.env.CLAUDE_CODE_SESSION_ID, sf?.cwd ?? process.env.CLAUDE_PROJECT_DIR, sf?.name ?? process.env.AXOS_SESSION_NAME);
}

// ask_human's images name files; the hub cannot read this disk, so they are uploaded here and replaced by the hub's
// att:<id>. Only files inside the session's own checkout: a message talked into attaching ~/.ssh or another repo's
// file finds it refused.
const MAX_IMAGE = 5 * 1024 * 1024;

async function uploadImages(id: Identity, paths: unknown[]): Promise<string[]> {
  const root = realpathSync(gitRemotes(id.cwd)?.root ?? id.cwd);
  const refs: string[] = [];
  for (const p of paths) {
    if (typeof p !== "string") throw new Error("images takes file paths");
    if (/^att:\d+$/.test(p)) { refs.push(p); continue; }
    let file: string;
    try { file = realpathSync(resolve(id.cwd, p)); } catch { throw new Error(`no file ${p}`); }
    const rel = relative(root, file);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${p} is outside this checkout (${root}); only files inside it can be attached`);
    const size = statSync(file).size;
    if (size > MAX_IMAGE) throw new Error(`${p} is ${Math.round(size / 1024)} KB; the limit is 5 MB`);
    const res = await fetch(`${id.c.url.replace(/\/$/, "")}/api/attach?name=${encodeURIComponent(basename(file))}`, {
      method: "POST", headers: { ...headers(id), "Content-Type": "application/octet-stream" }, body: readFileSync(file),
    });
    const out = (await res.json().catch(() => ({}))) as { ref?: string; error?: string };
    if (!out.ref) throw new Error(`${p}: ${out.error ?? `upload failed (${res.status})`}`);
    refs.push(out.ref);
  }
  return refs;
}

async function forward(id: Identity, msg: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }): Promise<void> {
  const args = msg.method === "tools/call" && msg.params?.name === "ask_human" ? msg.params.arguments : undefined;
  if (args && Array.isArray(args.images)) {
    try {
      args.images = await uploadImages(id, args.images);
    } catch (e) {
      write({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `Not asked: ${(e as Error).message}` }], isError: true } });
      return;
    }
  }
  try {
    const res = await fetch(`${id.c.url.replace(/\/$/, "")}/mcp`, {
      method: "POST",
      headers: { ...headers(id), "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(msg),
    });
    if (res.status === 202 || msg.id === undefined) return;
    const body = (await res.json()) as { result?: { capabilities?: Record<string, unknown>; instructions?: string } };
    if (msg.method === "initialize" && body.result) {
      // Offer the channel; Claude Code only uses it when the session was started with channels on.
      const caps = (body.result.capabilities ??= {}) as { experimental?: Record<string, unknown> };
      caps.experimental = { ...(caps.experimental ?? {}), "claude/channel": {} };
    }
    write(body);
  } catch (e) {
    write({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `AXOS hub unreachable: ${(e as Error).message}` } });
  }
}

// Hold the hub's event stream and call ring() when a message arrives (or, after a reconnect, when one is waiting).
// A ring carries no message: the client reads its inbox. Reconnects with backoff; without an identity it waits.
const BELL_SETTLE_MS = Number(process.env.AXOS_BELL_SETTLE_MS ?? 1500);

async function doorbell(connect: () => { url: string; headers: Record<string, string> } | null, ring: () => void): Promise<void> {
  let backoff = 2000;
  for (;;) {
    const to = connect();
    if (!to) {
      await Bun.sleep(60_000);
      continue;
    }
    try {
      const res = await fetch(`${to.url.replace(/\/$/, "")}/events`, { headers: to.headers });
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
      backoff = 2000;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const hello = /^event: hello$/m.test(frame) && Number(/"unshown":(\d+)/.exec(frame)?.[1] ?? 0) > 0;
          if (hello || /^event: message$/m.test(frame)) ring();
        }
      }
    } catch {
      /* hub away or stream dropped */
    }
    await Bun.sleep(backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }
}

// Channel push: a ring marks nothing shown, so a session started without channels drops it and the hooks still deliver;
// one with channels wakes, and its hooks deliver at once. A ring waits a moment and asks the hub whether the message is
// still unshown: a hook in a running turn may have delivered it already. A burst within the wait is one notice.
function bell(): Promise<void> {
  const to = () => {
    const id = currentIdentity();
    return !id || id.quiet || !id.project ? null : { url: id.c.url, headers: headers(id) };
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unshown = async (): Promise<number | null> => {
    const t = to();
    if (!t) return 0;
    try {
      const res = await fetch(`${t.url.replace(/\/$/, "")}/api/unshown`, { headers: t.headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return res.ok ? ((await res.json()) as { unshown: number }).unshown : null; // an older hub: always ring
    } catch {
      return null;
    }
  };
  const notify = async () => {
    timer = null;
    if ((await unshown()) === 0) return;
    write({ jsonrpc: "2.0", method: "notifications/claude/channel", params: {
      content: "AXOS: a new message is waiting for this session. It is shown at your next step; or call inbox now.", meta: { source: "axos" },
    } });
  };
  return doorbell(to, () => {
    if (!timer) timer = setTimeout(() => void notify(), BELL_SETTLE_MS);
  });
}

async function mcp(): Promise<void> {
  let bellStarted = false;
  const quietTools = (msg: { id?: unknown; method?: string }) => {
    if (msg.method === "tools/list") write({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
    else if (msg.method === "initialize") {
      write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "axos", version: PLUGIN_VERSION } } });
    } else if (msg.id !== undefined) write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "AXOS is off in this session" } });
  };
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: { id?: unknown; method?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const id = currentIdentity();
      if (!id) {
        if (msg.id !== undefined) write({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `AXOS is not configured: ${CONFIG_PATH} or the token is missing` } });
        continue;
      }
      if (id.quiet) {
        quietTools(msg);
        continue;
      }
      void forward(id, msg); // concurrently: wait may block for minutes
      if (msg.method === "notifications/initialized" && !bellStarted) {
        bellStarted = true;
        void bell();
      }
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------- for people at a terminal

// The yes must come from a person. On macOS it is a system dialog an agent cannot click; elsewhere a terminal prompt,
// which keeps out accidents and careless agents but not one determined to fake a terminal (it could also write
// trusted.json itself): a speed bump, not a wall.
async function confirm(question: string): Promise<boolean> {
  if (process.platform === "darwin") {
    const script = `display dialog ${JSON.stringify(question)} with title "AXOS" buttons {"Not now", "Trust"} default button "Not now" with icon caution giving up after 120`;
    const r = Bun.spawnSync(["osascript", "-e", script], { stderr: "ignore" });
    return r.exitCode === 0 && r.stdout.toString().includes("Trust");
  }
  if (!process.stdin.isTTY) throw new Error("this asks a person to confirm: run it in your own terminal, not through an agent.");
  process.stdout.write(`${question} [y/N] `);
  for await (const line of console) return /^y(es)?$/i.test(line.trim());
  return false;
}

async function trust(): Promise<void> {
  const c = config();
  if (!c) throw new Error(`AXOS is not configured: no ${CONFIG_PATH}`);
  const repo = repoFile(c, process.cwd());
  if (!repo) return console.log(`No usable .axos.json for ${hostOf(c.url)} at or above this folder.`);
  if (trusted(repo.dir, repo.ref)) return console.log(`${repo.dir}/.axos.json is already trusted.`);
  const f = repo.file;
  const question = `Connect Claude Code sessions in ${repo.dir} to the AXOS project ${f.project ?? f.id}${f.id && f.project ? ` (${f.id})` : ""} ` +
    `on ${hostOf(c.url)}? Their messages, roles and leases are then shared with that project's members.`;
  if (!(await confirm(question))) return console.log("Not trusted.");
  const all = readJson<Record<string, string>>(TRUST_PATH) ?? {};
  all[repo.dir] = repo.ref;
  mkdirSync(dirname(TRUST_PATH), { recursive: true });
  writeFileSync(TRUST_PATH, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  console.log("Trusted. New sessions in this folder connect; running ones at their next prompt.");
}

// The invite link's hub answers with this machine's token; it is written to a file only this user can read, and never
// printed. A machine set up for another hub is not changed without --force.
async function joinHub(args: string[]): Promise<void> {
  const force = args.includes("--force");
  const ni = args.indexOf("--name");
  const name = ni >= 0 ? args[ni + 1] : undefined;
  const link = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--name");
  const m = link ? /^(https?:\/\/[^/]+)\/join\/(axosinv_[A-Za-z0-9_-]+)\/?$/.exec(link) : null;
  if (!m) throw new Error("usage: axos join <invite link> [--name <this machine>] [--force]");
  const [, hubUrl, code] = m;
  const existing = readJson<Config>(CONFIG_PATH);
  if (existing?.url && hostOf(existing.url) !== hostOf(hubUrl!) && !force) {
    throw new Error(`this machine is set up for ${existing.url}; axos join --force switches it to ${hubUrl}`);
  }
  const tokenFile = tokenPath(existing ?? {});
  // A token already here belongs to a working setup: replacing it needs a deliberate --force.
  if (existsSync(tokenFile) && !force) throw new Error(`this machine already has an AXOS token in ${tokenFile}; axos join --force replaces it`);
  const machine = name ?? hostname().split(".")[0]!;
  const res = await fetch(`${hubUrl}/api/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, machine }) });
  const r = (await res.json().catch(() => ({ error: `the hub answered ${res.status}` }))) as { error?: string; hub?: string; agent?: string; token?: string; page?: string | null; projects?: string[] };
  if (r.error || !r.token) throw new Error(r.error ?? "the hub sent no token");
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify({ ...(existing ?? {}), url: r.hub ?? hubUrl }, null, 2)}\n`, { mode: 0o600 });
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, `${r.token}\n`, { mode: 0o600 });
  console.log(`This machine is ${r.agent} on ${r.hub ?? hubUrl}${r.projects?.length ? `, in ${r.projects.join(", ")}` : ""}.`);
  if (r.page) console.log(`Your page, shown once (open it on each device; it remembers you):\n  ${r.page}`);
  console.log("Connect a repo once, in its folder: axos link <project> (or axos trust, if it commits an .axos.json).");
}

// For a landing script, run in the repository after the push succeeded. The hub never sees the repository: this reads
// the new head and the commits it brought (since --since, else the last 300 on the branch) and sends their shas.
async function landed(args: string[]): Promise<void> {
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const since = opt("--since"), repoName = opt("--repo"), subjectArg = opt("--subject"), projectArg = opt("--project");
  const [where, commitArg] = args;
  if (!where || args.length > 2 || args.some((a) => a.startsWith("--"))) {
    throw new Error("usage: axos landed <remote>/<branch> [<commit>] [--since <old head>] [--repo <name>] [--subject <s>] [--project <p>]");
  }
  const git = (...a: string[]): string => {
    const r = Bun.spawnSync(["git", ...a], { stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString().trim()}`);
    return r.stdout.toString().trim();
  };
  const remotes = git("remote").split("\n").filter(Boolean);
  const slash = where.indexOf("/");
  const remote = slash > 0 && remotes.includes(where.slice(0, slash)) ? where.slice(0, slash) : undefined;
  const branch = remote ? where.slice(slash + 1) : where;
  const head = git("rev-parse", "--verify", `${commitArg ?? where}^{commit}`);
  const commits = since
    ? git("rev-list", "--max-count=1000", `${git("rev-parse", "--verify", `${since}^{commit}`)}..${head}`).split("\n").filter(Boolean)
    : git("rev-list", "--max-count=300", head).split("\n").filter(Boolean);
  const url = remote ? git("remote", "get-url", remote) : git("rev-parse", "--show-toplevel");
  const repo = repoName ?? basename(url.replace(/\/+$/, "")).replace(/\.git$/, "");
  const subject = subjectArg ?? git("log", "-1", "--format=%s", head);

  const c = config();
  const t = c && token(c);
  if (!c || !t) throw new Error(`AXOS is not configured: ${CONFIG_PATH} or the token is missing`);
  const project = projectArg ?? projectOf(c, process.cwd()).project;
  if (!project) throw new Error("this folder belongs to no AXOS project (or its .axos.json is not trusted yet); say --project <p>");
  const res = await fetch(`${c.url.replace(/\/$/, "")}/api/landed`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({ project, repo, remote, branch, head, commits, subject }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) throw new Error("the hub refused this machine's token");
  const r = (await res.json().catch(() => ({ error: `the hub answered ${res.status}` }))) as { error?: string; project?: string; commits?: number; told?: number };
  if (r.error) throw new Error(r.error);
  console.log(`Reported to ${r.project}: ${head.slice(0, 10)} on ${where} (${repo}), ${r.commits} commit(s); ${r.told} subscription(s) told.`);
}

// Wake an idle Codex: listen to the mailbox Codex reads (same token, same x-axos-session) and, when a message arrives,
// queue a fixed line into the Codex session. Codex then reads the message itself through its AXOS tools; no message
// text passes through here.
const CODEX_NUDGE = "AXOS: a new message is waiting for you. Read it with the axos inbox tool, handle what concerns your work, " +
  "reply with the axos send tool (re=<its id>) when there is something to say, and ack it.";

async function codexBell(args: string[]): Promise<void> {
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const thread = opt("--thread"), session = opt("--session"), projectArg = opt("--project"), codex = opt("--codex") ?? "codex";
  if (!thread || args.length) {
    throw new Error("usage: axos codex-bell --thread <codex session id or name> [--session <the x-axos-session Codex sends>] [--project <p>] [--codex <path>]");
  }
  if (session !== undefined && !/^[A-Za-z0-9-]{8,80}$/.test(session)) throw new Error("--session must be 8-80 letters, digits or '-', as Codex sends it");
  const c = config();
  const t = c && token(c);
  if (!c || !t) throw new Error(`AXOS is not configured: ${CONFIG_PATH} or the token is missing`);
  const project = projectArg ?? projectOf(c, process.cwd()).project;
  if (!project) throw new Error("this folder belongs to no AXOS project; run it in the repo Codex works in, or say --project <p>");
  const h: Record<string, string> = { Authorization: `Bearer ${t}`, "x-axos-profile": encodeURIComponent(profile()), "x-axos-project": encodeURIComponent(project) };
  if (session) h["x-axos-session"] = session;

  // Rings within a few seconds become one nudge; a ring while a nudge is being queued is kept for after it.
  let state: "idle" | "waiting" | "queueing" = "idle", again = false;
  const nudge = async () => {
    const r = Bun.spawn([codex, "queue", "--thread", thread, "--message", CODEX_NUDGE], { stdout: "pipe", stderr: "pipe" });
    const code = await r.exited;
    const out = (code === 0 ? await new Response(r.stdout).text() : await new Response(r.stderr).text()).trim().split("\n").at(-1);
    console.error(`${new Date().toISOString()} ${code === 0 ? "nudged" : `codex queue failed (${code})`}: ${out}`);
  };
  const ring = () => {
    if (state === "queueing") again = true;
    if (state !== "idle") return;
    state = "waiting";
    setTimeout(async () => {
      state = "queueing";
      await nudge().catch((e: Error) => console.error(`${new Date().toISOString()} codex queue failed: ${e.message}`));
      state = "idle";
      if (again) {
        again = false;
        ring();
      }
    }, 2000);
  };
  console.error(`Listening for AXOS messages of ${session ? `session ${session}` : "this machine's agent"} in ${project}; nudging Codex session ${thread}.`);
  await doorbell(() => ({ url: c.url, headers: h }), ring);
}

// The hub says which project a reference means for this machine's agent; the link stores its id, so a rename or a second
// project of the same name elsewhere changes nothing. A hub without /api/whoami (before 0.8) gets the reference as typed.
async function resolveProject(c: Config, t: string, ref: string): Promise<{ id: string; name?: string }> {
  const res = await fetch(`${c.url.replace(/\/$/, "")}/api/whoami?project=${encodeURIComponent(ref)}`, {
    headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) throw new Error("the hub refused this machine's token");
  const r = (await res.json().catch(() => null)) as { error?: string; project?: { id: string; name: string }; projects?: { name: string }[] } | null;
  if (!r) return { id: ref }; // an older hub
  if (r.error || !r.project) {
    const yours = r.projects?.map((p) => p.name).join(", ");
    throw new Error(`${r.error ?? "the hub named no project"}${yours ? `; yours: ${yours}` : ""}`);
  }
  return { id: r.project.id, name: r.project.name };
}

function writeConfig(c: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
}

// Connects a checkout on this machine only. In a git checkout with a remote the rule names the remote (origin, or
// --remote <name>), so every clone and worktree of that repository connects; --here, or no remote, names the folder.
async function link(args: string[]): Promise<void> {
  const c = config();
  const t = c && token(c);
  if (!c || !t) throw new Error(`AXOS is not set up on this machine: axos join <invite link> first`);
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const here = args.includes("--here");
  const remoteName = opt("--remote");
  const rest = args.filter((a) => a !== "--here");
  if (rest.length > 1 || rest.some((a) => a.startsWith("--"))) throw new Error("usage: axos link [<project>] [--remote <name>] [--here]");
  const cwd = process.cwd();
  const file = repoFile(c, cwd);
  const ref = rest[0] ?? file?.ref;
  if (!ref) throw new Error("say which project: axos link <owner>/<name>");
  const project = await resolveProject(c, t, ref);
  // Taking the project from the repo's own file is trusting that file: a person confirms it, as with axos trust.
  if (!rest[0]) {
    const question = `Connect Claude Code sessions in this repo to the AXOS project ${project.name ?? project.id}, as its .axos.json asks, ` +
      `on ${hostOf(c.url)}? Their messages, roles and leases are then shared with that project's members.`;
    if (!(await confirm(question))) return console.log("Not linked.");
  }

  const git = gitRemotes(cwd);
  let rule: FolderRule;
  if (!here && git?.remotes.length) {
    const pick = remoteName ? git.remotes.find((r) => r.name === remoteName)
      : git.remotes.find((r) => r.name === "origin") ?? (git.remotes.length === 1 ? git.remotes[0] : undefined);
    if (!pick) throw new Error(remoteName ? `no remote '${remoteName}' here` : `say which remote: --remote ${git.remotes.map((r) => r.name).join(" or --remote ")}`);
    rule = { remote: pick.key, project: project.id, ...(project.name ? { name: project.name } : {}) };
  } else {
    if (remoteName) throw new Error("--remote needs a git checkout with that remote");
    rule = { path: git?.root ?? cwd, project: project.id, ...(project.name ? { name: project.name } : {}) };
  }
  const same = (r: FolderRule) => rule.remote ? r.remote === rule.remote : !!r.path && resolve(expand(r.path)) === rule.path;
  const folders = c.folders ?? [];
  const old = folders.find(same);
  if (old) Object.assign(old, { project: rule.project, name: rule.name }); // keeps roles_dir and the like
  else folders.push(rule);
  writeConfig({ ...c, folders });

  const label = project.name ?? project.id;
  console.log(rule.remote
    ? `Linked on this machine: every checkout of ${rule.remote} -> ${label}.`
    : `Linked on this machine: ${rule.path} and everything below it -> ${label}.`);
  const now = projectOf({ ...c, folders }, cwd).project;
  if (now !== project.id) console.log(`Note: here ${now} still wins (a folder rule or a trusted .axos.json); axos whoami shows which.`);
  else console.log("Nothing was written into the repo. New sessions here connect; running ones at their next prompt.");
}

function unlink(): void {
  const c = config();
  if (!c) throw new Error(`AXOS is not configured: no ${CONFIG_PATH}`);
  const cwd = process.cwd();
  const git = gitRemotes(cwd);
  const keys = new Set(git?.remotes.map((r) => r.key));
  const root = git?.root ?? cwd;
  const gone = (c.folders ?? []).filter((r) => (r.remote && keys.has(r.remote)) || (r.path && resolve(expand(r.path)) === root));
  if (!gone.length) return console.log("No link for this checkout.");
  writeConfig({ ...c, folders: (c.folders ?? []).filter((r) => !gone.includes(r)) });
  for (const r of gone) console.log(`Unlinked ${r.remote ?? r.path} (was ${r.name ?? r.project}).`);
}

function whoami(): void {
  const c = config();
  if (!c || !token(c)) return console.log(`not configured (${c ? "token missing" : `no ${CONFIG_PATH}`})`);
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  const id = identity(sid ?? "terminal", sid ? undefined : process.cwd());
  const repo = id ? repoFile(c, id.cwd) : null;
  const via = !id?.project ? undefined
    : repo && trusted(repo.dir, repo.ref) ? `${repo.dir}/.axos.json`
    : id.rule?.remote ? `linked remote ${id.rule.remote}` : id.rule?.path ? `folder rule ${id.rule.path}` : undefined;
  console.log(JSON.stringify({
    hub: c.url, project: id?.project ?? null, project_name: id?.rule?.project === id?.project ? id?.rule?.name : undefined, via,
    untrusted: id?.untrusted && !id.project ? `${id.untrusted.dir}/.axos.json (run axos trust there, or axos link)` : undefined,
    profile: profile(), session: sid ?? null, name: id?.name ?? null, quiet: id?.quiet, roles: id?.roles,
  }, null, 2));
}

// ---------------------------------------------------------------- main

const [cmd, arg] = process.argv.slice(2);
if (cmd === "mcp") await mcp();
else if (cmd === "hook" && arg) await hook(arg).catch(() => {});
else if (cmd === "whoami") whoami();
else if (cmd === "join") {
  await joinHub(process.argv.slice(3)).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
else if (cmd === "codex-bell") {
  await codexBell(process.argv.slice(3)).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
else if (cmd === "landed") {
  await landed(process.argv.slice(3)).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
else if (cmd === "link" || cmd === "unlink") {
  await (cmd === "link" ? link(process.argv.slice(3)) : Promise.resolve(unlink())).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
else if (cmd === "trust") {
  await trust().catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
} else {
  console.error("usage: axos join <invite link> | link [<project>] | unlink | trust | whoami | landed <remote>/<branch> | codex-bell --thread <id>   (and for Claude Code: axos.ts mcp | hook <start|prompt|tool|stop|end>)");
  process.exit(2);
}
