import type { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { newId } from "./db.ts";
import { findSecret } from "./secrets.ts";
import { nullNotifier, type Notifier, type PushAction } from "./notify.ts";
import { ago } from "./render.ts";
import { VERSION } from "./version.ts";

// The hub's domain logic. Transport-free: the MCP layer, the HTTP UI and the CLI all call into this.
// Time is milliseconds since epoch, injectable for tests.

export class AxosError extends Error {}

export const MESSAGE_TYPES = ["note", "ask", "answer", "handoff", "status", "request", "review"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];
export const PRIORITIES = ["low", "normal", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

// Projects and agents are known by ids ('prj_…', 'agt_…') everywhere inside the hub; their names ('alice/shop',
// 'alice/mac') are labels, made at the edges by display() and parsed back by projectId() and agentId().
// An agent token is a machine or account; a session is one Claude Code conversation on it (its key '<agent id>#<id8>').
// Roles are held by sessions. A session that holds a role in a project speaks as that role: it reads the role's mailbox,
// replies come back to the role, and its leases and questions belong to the role, so the next holder inherits them.
// Clients without sessions act as the agent, or as a role it holds with `as`.
// human_words: the client checked that a send with quotes_human carries words the human typed (the plugin's header).
export type Actor = { kind: "agent"; id: string; human: string; as?: string; session?: string; human_words?: boolean } | { kind: "human"; name: string };

export interface SessionRow {
  key: string;
  agent_id: string;
  client_session: string;
  project: string | null;
  name: string | null;
  profile: string | null;
  cwd: string | null;
  started_at: number;
  last_seen: number;
  ended_at: number | null;
  framed_at: number | null;
  former_names: string;
  kind: "session" | "script";
}

export interface AgentRow {
  id: string;
  human: string;
  name: string;
  revoked: number;
  created_at: number;
  last_seen: number | null;
}

export const ACK_OUTCOMES = ["done", "declined", "forwarded", "noted"] as const;
export type AckOutcome = (typeof ACK_OUTCOMES)[number];

export interface MessageRow {
  id: number;
  project: string;
  sender: string;
  sender_human: string | null;
  to_json: string;
  type: MessageType;
  summary: string;
  body: string;
  thread: number | null;
  re: number | null;
  as_of: string | null;
  priority: Priority;
  created_at: number;
  sent_by: string | null;
  quotes_human: string | null; // the human whose typed words the body holds (checked by the sender's plugin); the message stays the sender's
}

export interface InboxItem extends MessageRow {
  via: string;
  recipient: string;
  acked_at: number | null;
  shown_at: number | null;
}

export interface LeaseRow {
  id: number;
  project: string;
  resource: string;
  holder: string;
  mode: "exclusive" | "shared";
  note: string;
  ttl_s: number | null;
  granted_at: number;
  expires_at: number;
}

export interface AskRow {
  id: number;
  project: string;
  asker: string;
  human: string;
  question: string;
  options_json: string;
  default_answer: string | null;
  deadline: number | null;
  message_id: number;
  answer: string | null;
  answered_by: string | null;
  answered_at: number | null;
  phone_cleared_at: number | null;
  pushed_at: number | null;
  seen_at: number | null;
  remind_at: number | null;
  reminded_at: number | null;
  stale_at: number | null;
}

export interface SubscriptionRow {
  id: number;
  project: string;
  subscriber: string;
  repo: string | null;
  remote: string | null;
  branch: string;
  sha: string | null;
  note: string;
  subject_filter: string | null;
  created_at: number;
  expires_at: number;
  ended_at: number | null;
  end_reason: string | null;
}

export interface LandingRow {
  id: number;
  project: string;
  repo: string;
  remote: string | null;
  branch: string;
  head: string;
  subject: string;
  reporter: string;
  at: number;
}

export interface HubEvent {
  kind: "message" | "lease" | "role" | "answer";
  recipient?: string;
  message_id?: number;
  from?: string;
  summary?: string;
  type?: string;
  priority?: string;
}

export interface HubOptions {
  now?: () => number;
  notifier?: Notifier;
  publicUrl?: string;
  linkSecret?: string; // signs answer links; kept out of the database (and its backups) when given
  sendsPerMinute?: number;
  onlineWindowS?: number;
  sweep?: boolean; // false: a reader beside the hub process (the admin CLI); it never sweeps, since it has no notifier
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const MAX_SUMMARY = 300;
const MAX_BODY = 64_000;
const MAX_BRIEF = 2_000;
const MAX_NOTE = 1_000; // a subscription's note
const MAX_ACK_NOTE = 200;
export const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_IMAGES = 4; // per question
const MAX_UNCLAIMED = 8; // uploads per agent not yet on a question
const IMAGES_KEPT_MS = 30 * 86_400_000;
const UNCLAIMED_KEPT_MS = 3_600_000;
const ANSWERED_ON_PHONE_MS = 86_400_000;
const SCRIPT_KEPT_MS = 30 * 86_400_000;
const SCRIPT_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const ASK_STALE_MS = 3 * 86_400_000; // an open question without a deadline
const MAX_WAIT_S = 240;
const MAX_LEASE_TTL_S = 86_400;
const MAX_SUBSCRIPTION_TTL_S = 30 * 86_400;
const MAX_OPEN_SUBSCRIPTIONS = 200; // per mailbox
const MAX_LANDING_COMMITS = 1000;
const LANDINGS_KEPT_MS = 30 * 86_400_000; // a subscription for a commit that landed within this answers at once
// Repo, remote and branch names as git allows them, minus anything that could read as structure (spaces, '<').
const REF_RE = /^[A-Za-z0-9._@+-][A-Za-z0-9._@+\/-]{0,199}$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;

export const SYSTEM_SENDER = "axos";

// A holder key is an agent id ('agt_…'), a session key ('agt_…#7b9f51e0') or a role address
// ('role:prj_…/main-coordinator'); this is its mailbox.
export function addr(holder: string): string {
  if (holder.startsWith("role:") || holder.startsWith("session:") || holder.startsWith("agent:")) return holder;
  return holder.includes("#") ? `session:${holder}` : `agent:${holder}`;
}

// The other way round: the holder key a mailbox address belongs to.
export function holderOf(address: string): string {
  return address.replace(/^(agent|session):/, "");
}

// A session that is not heard from (a laptop asleep, a project left for the weekend) stays live, with its roles, this
// long; then it ends. A connected session is heard from every heartbeat.
const SESSION_LIVE_MS = 7 * 86_400_000;

export function hashSecret(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

// Peer-supplied short text (session names, role descriptions, lease notes) ends up in other people's model context:
// one line, no markup, bounded.
export function oneLine(s: string, max: number): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/[<>]/g, "").trim().slice(0, max);
}

const PROJECT_ID = /\bprj_[0-9a-z]{10}\b/g;
const AGENT_ID = /\bagt_[0-9a-z]{10}\b/g;

function checkName(kind: string, s: string): void {
  if (!NAME_RE.test(s)) throw new AxosError(`${kind} '${s}' must be lowercase letters, digits, '.', '_' or '-'`);
  if (/^(prj|agt)_/.test(s)) throw new AxosError(`${kind} '${s}' looks like an id; pick a name that does not start with prj_ or agt_`);
}

export class Hub {
  readonly now: () => number;
  private notifier: Notifier;
  readonly publicUrl: string;
  private sendsPerMinute: number;
  private onlineWindowMs: number;
  private listeners = new Map<string, Set<(e: HubEvent) => void>>();
  private streams = new Map<string, number>();
  // Of those streams, how many said that the host behind them wakes on a message (?wakes=1), and how many said not.
  private wakers = new Map<string, number>();
  private sleepers = new Map<string, number>();
  private readonly sweeps: boolean;
  private sendLog = new Map<string, number[]>();
  private linkSecret: string;

  constructor(readonly db: Database, opts: HubOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.notifier = opts.notifier ?? nullNotifier;
    this.publicUrl = (opts.publicUrl ?? "").replace(/\/$/, "");
    this.sendsPerMinute = opts.sendsPerMinute ?? 60;
    this.onlineWindowMs = (opts.onlineWindowS ?? 600) * 1000;
    this.sweeps = opts.sweep ?? true;
    const row = opts.linkSecret ? null : this.db.query("SELECT v FROM kv WHERE k = 'link_secret'").get() as { v: string } | null;
    this.linkSecret = opts.linkSecret ?? row?.v ?? randomBytes(32).toString("base64url");
    if (!opts.linkSecret && !row) this.db.query("INSERT INTO kv (k, v) VALUES ('link_secret', ?)").run(this.linkSecret);
  }

  // A link that answers one ask without a login: the phone's answer buttons POST to it.
  askSignature(askId: number): string {
    return createHmac("sha256", this.linkSecret).update(`ask:${askId}`).digest("base64url").slice(0, 32);
  }

  answerByLink(askId: number, sig: string, answer: string): { message_id: number } {
    const want = Buffer.from(this.askSignature(askId));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new AxosError("this answer link is not valid");
    const ask = this.db.query("SELECT human, options_json FROM asks WHERE id = ?").get(askId) as { human: string; options_json: string } | null;
    if (!ask) throw new AxosError(`no ask ${askId}`);
    // A link is a bearer capability (it sits in notification history): it can pick an offered option, nothing else.
    // Free text is for the logged-in page.
    const options = JSON.parse(ask.options_json) as string[];
    if (!options.includes(answer)) throw new AxosError("this link answers with one of the offered options only; answer in your own words on the AXOS page");
    // The phone gives no sign that a tap went through, so people tap again: the same answer once more is no error.
    const done = this.db.query("SELECT answer, message_id FROM asks WHERE id = ?").get(askId) as { answer: string | null; message_id: number };
    if (done.answer === answer) {
      const sent = this.db.query("SELECT id FROM messages WHERE re = ? AND type = 'answer' ORDER BY id LIMIT 1").get(done.message_id) as { id: number } | null;
      return { message_id: sent?.id ?? done.message_id };
    }
    return this.answerAsk(ask.human, askId, answer);
  }

  // ---------------------------------------------------------------- admin

  addHuman(name: string, ntfyTopic?: string): { uiKey: string } {
    checkName("human", name);
    const uiKey = newSecret("axosui");
    this.db.query("INSERT INTO humans (name, ntfy_topic, ui_key_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(name, ntfyTopic ?? null, hashSecret(uiKey), this.now());
    this.event(`human:${name}`, "human.added", null, {});
    return { uiKey };
  }

  rotateHumanKey(name: string): { uiKey: string } {
    const uiKey = newSecret("axosui");
    const r = this.db.query("UPDATE humans SET ui_key_hash = ? WHERE name = ?").run(hashSecret(uiKey), name);
    if (r.changes === 0) throw new AxosError(`no human '${name}'`);
    this.event("admin", "human.key_rotated", null, { human: name });
    return { uiKey };
  }

  // ---------------------------------------------------------------- invites

  // A one-time code that sets up one machine. The person it names is created when it is redeemed if they are new (and
  // put into the project); an existing person is put into the project now. The code is shown once and kept as a hash.
  createInvite(human: string, project: string | null, ttlS = 86_400): { code: string; expires_at: number } {
    checkName("human", human);
    const exists = !!this.db.query("SELECT 1 FROM humans WHERE name = ?").get(human);
    if (project && !this.db.query("SELECT 1 FROM projects WHERE id = ?").get(project)) throw new AxosError(`no project '${project}'`);
    if (!exists && !project && this.db.query("SELECT 1 FROM humans").get()) {
      throw new AxosError(`'${human}' is new here: say which project they join (axos invite <project> --human ${human})`);
    }
    if (exists && project) this.addHumanToProject(human, project);
    const code = newSecret("axosinv");
    const t = this.now();
    this.db.query("INSERT INTO invites (code_hash, human, project, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(hashSecret(code), human, project, t, t + ttlS * 1000);
    this.event("admin", "invite.created", project, { human, new_human: !exists });
    return { code, expires_at: t + ttlS * 1000 };
  }

  // Whether a code is good, without using it (for the page a browser opens).
  inviteStatus(code: string): "open" | "used" | "expired" | "unknown" {
    const i = this.db.query("SELECT used_at, expires_at FROM invites WHERE code_hash = ?").get(hashSecret(code)) as { used_at: number | null; expires_at: number } | null;
    if (!i) return "unknown";
    if (i.used_at) return "used";
    return i.expires_at < this.now() ? "expired" : "open";
  }

  // Sets up the machine: its agent (named after the machine, made unique), its token, and the person if new.
  redeemInvite(code: string, machine: string): { human: string; agent: string; token: string; uiKey?: string; projects: string[] } {
    const status = this.inviteStatus(code);
    if (status !== "open") throw new AxosError(status === "unknown" ? "this invite link is not valid" : `this invite link was already ${status === "used" ? "used" : "expired"}; ask for a new one`);
    const inv = this.db.query("SELECT * FROM invites WHERE code_hash = ?").get(hashSecret(code)) as { id: number; human: string; project: string | null };
    const base = machine.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 40) || "machine";
    return this.db.transaction(() => {
      let uiKey: string | undefined;
      if (!this.db.query("SELECT 1 FROM humans WHERE name = ?").get(inv.human)) {
        uiKey = this.addHuman(inv.human).uiKey;
        if (inv.project) this.addHumanToProject(inv.human, inv.project);
      }
      let name = base;
      for (let n = 2; this.agentId(`${inv.human}/${name}`); n++) name = `${base}-${n}`;
      const { id, token } = this.addAgent(inv.human, name, []);
      this.db.query("UPDATE invites SET used_at = ?, agent_id = ? WHERE id = ?").run(this.now(), id, inv.id);
      this.event(`agent:${id}`, "invite.redeemed", inv.project, { human: inv.human });
      return { human: inv.human, agent: id, token, uiKey, projects: this.projectsOf(id) };
    })();
  }

  setNtfyTopic(name: string, topic: string | null): void {
    const r = this.db.query("UPDATE humans SET ntfy_topic = ? WHERE name = ?").run(topic, name);
    if (r.changes === 0) throw new AxosError(`no human '${name}'`);
  }

  // name: '<owner>/<slug>', or a bare slug when the hub has exactly one human. Returns the new project's id.
  addProject(name: string, brief = ""): string {
    if (name.split("/").length > 2) throw new AxosError(`a project name is <owner>/<name>, not '${name}'`);
    let [owner, slug] = name.includes("/") ? name.split("/", 2) as [string, string] : [undefined, name];
    if (!owner) {
      const all = this.db.query("SELECT name FROM humans").all() as { name: string }[];
      if (all.length !== 1) throw new AxosError(`say whose project it is: <owner>/${slug}`);
      owner = all[0]!.name;
    }
    checkName("project", slug);
    if (!this.db.query("SELECT 1 FROM humans WHERE name = ?").get(owner)) throw new AxosError(`no human '${owner}'`);
    if (this.findProjects(`${owner}/${slug}`).length) throw new AxosError(`${owner} already has a project '${slug}'`);
    const id = newId("prj");
    this.db.query("INSERT INTO projects (id, owner, slug, brief, created_at) VALUES (?, ?, ?, ?, ?)").run(id, owner, slug, brief, this.now());
    this.event("admin", "project.added", id, { name: `${owner}/${slug}` });
    return id;
  }

  // The old name keeps resolving, so .axos.json files and habits do not break.
  renameProject(project: string, slug: string): void {
    checkName("project", slug);
    const p = this.db.query("SELECT owner, slug FROM projects WHERE id = ?").get(project) as { owner: string; slug: string } | null;
    if (!p) throw new AxosError(`no project '${project}'`);
    const taken = this.findProjects(`${p.owner}/${slug}`);
    if (taken.length && taken[0] !== project) throw new AxosError(`${p.owner} already has a project '${slug}'`);
    this.db.transaction(() => {
      this.db.query("DELETE FROM project_aliases WHERE owner = ? AND slug = ?").run(p.owner, slug);
      this.db.query("INSERT OR REPLACE INTO project_aliases (owner, slug, project) VALUES (?, ?, ?)").run(p.owner, p.slug, project);
      this.db.query("UPDATE projects SET slug = ? WHERE id = ?").run(slug, project);
    })();
    this.event("admin", "project.renamed", project, { from: `${p.owner}/${p.slug}`, to: `${p.owner}/${slug}` });
  }

  setProjectBrief(project: string, brief: string): void {
    const r = this.db.query("UPDATE projects SET brief = ? WHERE id = ?").run(brief, project);
    if (r.changes === 0) throw new AxosError(`no project '${project}'`);
  }

  // A brief written by an agent: only the owner's agents, as it reaches everyone in the project.
  setBriefAsAgent(agentId: string, project: string, brief: string): void {
    const p = this.db.query("SELECT owner FROM projects WHERE id = ?").get(project) as { owner: string } | null;
    if (!p || !this.isMember(agentId, project)) throw new AxosError(`you are not in project '${project}'`);
    if (this.humanOf(agentId) !== p.owner) throw new AxosError(`only ${p.owner}'s agents may write the brief of '${project}'; ask them`);
    const text = brief.trim();
    if (text.length > MAX_BRIEF) throw new AxosError(`brief is ${text.length} characters, ${text.length - MAX_BRIEF} over the limit of ${MAX_BRIEF}; link to a file in the repo instead`);
    const secret = findSecret(text);
    if (secret) throw new AxosError(`brief rejected: it looks like it contains a ${secret}`);
    this.setProjectBrief(project, text);
    this.event(`agent:${agentId}`, "project.brief", project, { length: text.length });
  }

  // ---------------------------------------------------------------- names and ids

  projectName(id: string): string | null {
    const p = this.db.query("SELECT owner, slug FROM projects WHERE id = ?").get(id) as { owner: string; slug: string } | null;
    return p ? `${p.owner}/${p.slug}` : null;
  }

  agentLabel(id: string): string | null {
    const a = this.db.query("SELECT human, name, revoked FROM agents WHERE id = ?").get(id) as { human: string; name: string; revoked: number } | null;
    return a ? `${a.human}/${a.name}${a.revoked ? "(revoked)" : ""}` : null;
  }

  // Every project a reference can mean: an id, '<owner>/<slug>' or a bare slug, current names and former ones.
  findProjects(ref: string): string[] {
    const r = ref.trim();
    if (/^prj_[0-9a-z]{10}$/.test(r)) return this.db.query("SELECT id FROM projects WHERE id = ?").get(r) ? [r] : [];
    const [owner, slug] = r.includes("/") ? r.split("/", 2) as [string, string] : [null, r];
    const rows = owner === null
      ? this.db.query("SELECT id FROM projects WHERE slug = ?1 UNION SELECT project FROM project_aliases WHERE slug = ?1").all(slug)
      : this.db.query("SELECT id FROM projects WHERE owner = ?1 AND slug = ?2 UNION SELECT project FROM project_aliases WHERE owner = ?1 AND slug = ?2").all(owner, slug);
    return [...new Set((rows as { id: string }[]).map((x) => x.id))];
  }

  // A reference among the projects someone may name (null: all, for the admin). Several matches: the error lists them.
  projectId(ref: string, among: string[] | null = null): string | null {
    const hits = this.findProjects(ref).filter((id) => among === null || among.includes(id));
    if (hits.length > 1) throw new AxosError(`'${ref}' could be ${hits.map((id) => this.projectName(id)).join(" or ")}; say which`);
    return hits[0] ?? null;
  }

  // '<human>/<name>' (the agent that is not revoked) or an id.
  agentId(ref: string): string | null {
    const r = ref.trim().replace(/^agent:/, "");
    if (/^agt_[0-9a-z]{10}$/.test(r)) return this.db.query("SELECT id FROM agents WHERE id = ?").get(r) ? r : null;
    const [human, name] = r.split("/", 2);
    if (!human || !name) return null;
    return (this.db.query("SELECT id FROM agents WHERE human = ? AND name = ? AND revoked = 0").get(human, name) as { id: string } | null)?.id ?? null;
  }

  // Ids become names on the way out. Only the viewer's own projects and those linked to them are named, so text quoting
  // another project's id reveals nothing; no viewer means the admin, who sees all.
  display(text: string, viewer?: { agent: string } | { human: string }): string {
    let visible: Set<string> | null = null;
    if (viewer) {
      const own = "agent" in viewer ? this.projectsOf(viewer.agent) : this.projectsOfHuman(viewer.human);
      visible = new Set([...own, ...own.flatMap((p) => this.linkedProjects(p))]);
    }
    // An agent is named to someone who shares a project (or a link) with it, and to its own human.
    const knows = (agent: string) => !visible || ("agent" in viewer! && viewer.agent === agent) ||
      this.humanOfHolder(agent) === ("human" in viewer! ? viewer.human : this.humanOfHolder(viewer!.agent)) ||
      this.projectsOf(agent).some((p) => visible!.has(p));
    return text
      .replace(PROJECT_ID, (id) => (visible && !visible.has(id) ? id : this.projectName(id) ?? id))
      .replace(AGENT_ID, (id) => (knows(id) ? this.agentLabel(id) ?? id : id));
  }

  // Linked projects message each other's roles, sessions and agents; nothing else crosses (briefs, leases, presence).
  linkProjects(p: string, q: string): void {
    if (p === q) throw new AxosError("a project cannot be linked to itself");
    for (const x of [p, q]) if (!this.db.query("SELECT 1 FROM projects WHERE id = ?").get(x)) throw new AxosError(`no project '${x}'`);
    const [a, b] = [p, q].sort();
    this.db.query("INSERT OR IGNORE INTO project_links (a, b, created_at) VALUES (?, ?, ?)").run(a!, b!, this.now());
    this.event("admin", "project.linked", a!, { with: b });
  }

  unlinkProjects(p: string, q: string): void {
    const [a, b] = [p, q].sort();
    const r = this.db.query("DELETE FROM project_links WHERE a = ? AND b = ?").run(a!, b!);
    if (r.changes === 0) throw new AxosError(`'${p}' and '${q}' are not linked`);
    this.event("admin", "project.unlinked", a!, { with: b });
  }

  linkedProjects(project: string): string[] {
    return (this.db.query(`SELECT p.id FROM projects p JOIN project_links l ON (l.a = ?1 AND l.b = p.id) OR (l.b = ?1 AND l.a = p.id)
      ORDER BY p.owner, p.slug`).all(project) as { id: string }[]).map((r) => r.id);
  }

  projectLinks(): { a: string; b: string; created_at: number }[] {
    return this.db.query("SELECT * FROM project_links ORDER BY a, b").all() as { a: string; b: string; created_at: number }[];
  }

  // The project an address points into: the message's own, or one linked to it. Anything else is refused alike.
  private reach(project: string, target: string, address: string): string {
    const hit = this.projectId(target, [project, ...this.linkedProjects(project)]);
    if (hit) return hit;
    throw new AxosError(`cannot address another project ('${address}') from '${project}'; only linked projects: ${this.linkedProjects(project).join(", ") || "none"}`);
  }

  addHumanToProject(human: string, project: string): void {
    if (!this.db.query("SELECT 1 FROM humans WHERE name = ?").get(human)) throw new AxosError(`no human '${human}'`);
    if (!this.db.query("SELECT 1 FROM projects WHERE id = ?").get(project)) throw new AxosError(`no project '${project}'`);
    this.db.query("INSERT OR IGNORE INTO human_projects (human, project) VALUES (?, ?)").run(human, project);
    this.event("admin", "project.human_added", project, { human });
  }

  // Takes a human and all their agents out of a project: their sessions there end, their roles and leases there are freed.
  removeHumanFromProject(human: string, project: string): void {
    const r = this.db.query("DELETE FROM human_projects WHERE human = ? AND project = ?").run(human, project);
    const agents = (this.db.query("SELECT id FROM agents WHERE human = ?").all(human) as { id: string }[]).map((a) => a.id);
    let m = 0;
    for (const id of agents) m += this.db.query("DELETE FROM memberships WHERE agent_id = ? AND project = ?").run(id, project).changes;
    if (!r.changes && !m) throw new AxosError(`human '${human}' is not in project '${project}'`);
    for (const id of agents) {
      for (const s of this.db.query("SELECT key FROM sessions WHERE agent_id = ? AND project = ? AND ended_at IS NULL").all(id, project) as { key: string }[]) {
        this.endSession(s.key, `${human} was removed from ${project}`);
      }
      // Roles and leases held in this project by the agent itself or by its sessions tied to other projects.
      for (const h of this.db.query("SELECT key AS h FROM sessions WHERE agent_id = ? UNION SELECT ?").all(id, id) as { h: string }[]) {
        this.db.query("UPDATE roles SET holder = NULL, since = NULL WHERE project = ? AND holder = ?").run(project, h.h);
        for (const l of this.db.query("SELECT * FROM leases WHERE project = ? AND holder = ? AND ended_at IS NULL").all(project, h.h) as LeaseRow[]) this.endLease(l, "revoked");
        this.db.query("UPDATE lease_waiters SET done_at = ? WHERE project = ? AND agent_id = ? AND done_at IS NULL").run(this.now(), project, h.h);
      }
    }
    this.event("admin", "project.human_removed", project, { human });
  }

  addAgent(human: string, name: string, projects: string[]): { id: string; token: string } {
    checkName("agent", name);
    if (!this.db.query("SELECT 1 FROM humans WHERE name = ?").get(human)) throw new AxosError(`no human '${human}'`);
    if (this.agentId(`${human}/${name}`)) throw new AxosError(`agent '${human}/${name}' exists; revoke it first or pick another name`);
    const id = newId("agt");
    const token = newSecret("axos");
    this.db.transaction(() => {
      this.db.query("INSERT INTO agents (id, human, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, human, name, hashSecret(token), this.now());
      for (const p of projects) this.addMembership(id, p);
    })();
    this.event(`human:${human}`, "agent.added", null, { agent: id, label: `${human}/${name}`, projects });
    return { id, token };
  }

  addMembership(agentId: string, project: string): void {
    if (!this.db.query("SELECT 1 FROM projects WHERE id = ?").get(project)) throw new AxosError(`no project '${project}'`);
    if (!this.db.query("SELECT 1 FROM agents WHERE id = ?").get(agentId)) throw new AxosError(`no agent '${agentId}'`);
    this.db.query("INSERT OR IGNORE INTO memberships (agent_id, project) VALUES (?, ?)").run(agentId, project);
  }

  // A revoked agent stays revoked: its mailbox and history belong to the machine that was lost. Add a new agent instead.
  rotateToken(agentId: string): string {
    const a = this.db.query("SELECT revoked FROM agents WHERE id = ?").get(agentId) as { revoked: number } | null;
    if (!a) throw new AxosError(`no agent '${agentId}'`);
    if (a.revoked) throw new AxosError(`agent '${agentId}' was revoked; add a new agent (the name is free again)`);
    const token = newSecret("axos");
    this.db.query("UPDATE agents SET token_hash = ? WHERE id = ?").run(hashSecret(token), agentId);
    this.event("admin", "agent.token_rotated", null, { agent: agentId });
    return token;
  }

  // The kill switch: the token stops working at once, roles and leases are freed.
  revokeAgent(agentId: string): void {
    const r = this.db.query("UPDATE agents SET revoked = 1 WHERE id = ?").run(agentId);
    if (r.changes === 0) throw new AxosError(`no agent '${agentId}'`);
    for (const s of this.db.query("SELECT key FROM sessions WHERE agent_id = ? AND ended_at IS NULL").all(agentId) as { key: string }[]) this.endSession(s.key, "revoked");
    for (const role of this.db.query("SELECT project, role FROM roles WHERE holder = ?").all(agentId) as { project: string; role: string }[]) {
      this.db.query("UPDATE roles SET holder = NULL, since = NULL WHERE project = ? AND role = ?").run(role.project, role.role);
    }
    for (const l of this.db.query("SELECT * FROM leases WHERE holder = ? AND ended_at IS NULL").all(agentId) as LeaseRow[]) {
      this.endLease(l, "revoked");
    }
    // Its places in lease queues go too (its sessions' went with the sessions above), so it is never granted one later.
    for (const w of this.db.query("SELECT id, project, resource FROM lease_waiters WHERE agent_id = ? AND done_at IS NULL").all(agentId) as { id: number; project: string; resource: string }[]) {
      this.db.query("UPDATE lease_waiters SET done_at = ? WHERE id = ?").run(this.now(), w.id);
      this.grantWaiters(w.project, w.resource);
    }
    this.event("admin", "agent.revoked", null, { agent: agentId });
  }

  listAgents(): (AgentRow & { projects: string })[] {
    return this.db.query(
      `SELECT a.id, a.human, a.name, a.revoked, a.created_at, a.last_seen,
              COALESCE(GROUP_CONCAT(m.project, ','), '') AS projects
         FROM agents a LEFT JOIN memberships m ON m.agent_id = a.id
        GROUP BY a.id ORDER BY a.revoked, a.human, a.name`,
    ).all() as (AgentRow & { projects: string })[];
  }

  // ---------------------------------------------------------------- auth & presence

  authenticateAgent(token: string): AgentRow | null {
    const a = this.db.query("SELECT id, human, name, revoked, created_at, last_seen FROM agents WHERE token_hash = ?")
      .get(hashSecret(token)) as AgentRow | null;
    if (!a || a.revoked) return null;
    this.touch(a.id);
    return a;
  }

  authenticateHuman(uiKey: string): string | null {
    const h = this.db.query("SELECT name FROM humans WHERE ui_key_hash = ?").get(hashSecret(uiKey)) as { name: string } | null;
    return h?.name ?? null;
  }

  touch(agentId: string): void {
    this.db.query("UPDATE agents SET last_seen = ? WHERE id = ?").run(this.now(), agentId);
  }

  // Whether a holder (a session key or an agent id) can take a message now: an open event stream, or a request in the
  // last minutes. A holder that is not is away: its laptop sleeps, its connection dropped, or it is gone.
  isOnline(holder: string): boolean {
    if (this.streams.has(holder)) return true;
    const seen = this.lastSeen(holder);
    return seen !== null && this.now() - seen < this.onlineWindowMs;
  }

  // An agent without a session counts as reachable while it has connected within the liveness window.
  agentReachable(agentId: string): boolean {
    const seen = this.lastSeen(agentId);
    return seen !== null && this.now() - seen < SESSION_LIVE_MS;
  }

  private lastSeen(holder: string): number | null {
    const row = holder.includes("#")
      ? this.db.query("SELECT last_seen FROM sessions WHERE key = ? AND ended_at IS NULL").get(holder) as { last_seen: number } | null
      : this.db.query("SELECT last_seen FROM agents WHERE id = ?").get(holder) as { last_seen: number | null } | null;
    return row?.last_seen ?? null;
  }

  // A holder's reach in words: "connected", "seen 3m ago" or "away, seen 2h ago".
  whereabouts(holder: string): string {
    if (this.streams.has(holder)) return "connected";
    const seen = `seen ${ago(this.lastSeen(holder), this.now())}`;
    return this.isOnline(holder) ? seen : `away, ${seen}`;
  }

  // ---------------------------------------------------------------- sessions

  // Called on every request that carries a session: creates it on first sight, revives it after an end, keeps its roles.
  openSession(agentId: string, s: { client_session: string; project?: string | null; name?: string | null; profile?: string | null; cwd?: string | null }): string {
    const cs = s.client_session.trim();
    if (!/^[A-Za-z0-9-]{8,80}$/.test(cs)) throw new AxosError("session id must be 8-80 letters, digits or '-'");
    const key = `${agentId}#${cs.replace(/-/g, "").slice(0, 8).toLowerCase()}`;
    const project = s.project && this.isMember(agentId, s.project) ? s.project : null;
    const name = s.name ? oneLine(s.name, 48) || null : null;
    const profile = s.profile ? oneLine(s.profile, 32) || null : null;
    const t = this.now();
    const prev = this.db.query("SELECT key, ended_at, name, former_names FROM sessions WHERE key = ?").get(key) as
      { key: string; ended_at: number | null; name: string | null; former_names: string } | null;
    // A renamed session keeps answering to its last few names, so an address handed out before a restart still works.
    if (prev?.name && name && prev.name !== name) {
      const former = [...prev.former_names.split("\n").filter((n) => n && n !== name && n !== prev.name), prev.name].slice(-5).join("\n");
      this.db.query("UPDATE sessions SET former_names = ? WHERE key = ?").run(former, key);
    }
    this.db.query(
      `INSERT INTO sessions (key, agent_id, client_session, project, name, profile, cwd, started_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET last_seen = excluded.last_seen, ended_at = NULL,
         project = COALESCE(excluded.project, sessions.project), name = COALESCE(excluded.name, sessions.name),
         profile = COALESCE(excluded.profile, sessions.profile), cwd = COALESCE(excluded.cwd, sessions.cwd)`,
    ).run(key, agentId, cs, project, name, profile, null, t, t);
    // A session revived after its human left the project does not keep the project.
    const kept = this.session(key)!.project;
    if (kept && !this.isMember(agentId, kept)) this.db.query("UPDATE sessions SET project = NULL WHERE key = ?").run(key);
    if (!prev || prev.ended_at !== null) this.event(`session:${key}`, "session.started", project, { name, profile });
    if (!prev) this.claimNext(key);
    return key;
  }

  // A new session hands itself the notes its human left for the next session in its project (not its own notes).
  claimNext(key: string): number {
    const s = this.session(key);
    if (!s?.project) return 0;
    return this.db.query(
      `UPDATE deliveries SET recipient = ? WHERE recipient = ? AND acked_at IS NULL
         AND (SELECT sender FROM messages WHERE id = message_id) <> ?`,
    ).run(`session:${key}`, `next:${s.project}/${this.humanOf(s.agent_id)}`, `session:${key}`).changes;
  }

  session(key: string): SessionRow | null {
    return this.db.query("SELECT * FROM sessions WHERE key = ?").get(key) as SessionRow | null;
  }

  // A named script of an agent (a timer, a sensor, a CI step): a sender of its own with a mailbox for replies, kept
  // across runs. It holds no roles, takes no notes left for the next session, is not counted live and wakes nobody.
  openScript(agentId: string, project: string, name: string): string {
    if (!SCRIPT_RE.test(name)) throw new AxosError(`script name '${oneLine(name, 40)}' must be 1-32 lowercase letters, digits, '.', '_' or '-'`);
    if (!this.isMember(agentId, project)) throw new AxosError(`you are not in a project '${project}'`);
    const key = `${agentId}#${hashSecret(`script:${name}`).slice(0, 8)}`;
    const prev = this.session(key);
    if (prev && prev.kind !== "script") throw new AxosError(`'${name}' collides with a session of this agent; pick another name`);
    const t = this.now();
    this.db.query(
      `INSERT INTO sessions (key, agent_id, client_session, project, name, profile, started_at, last_seen, kind) VALUES (?, ?, ?, ?, ?, 'script', ?, ?, 'script')
       ON CONFLICT (key) DO UPDATE SET last_seen = excluded.last_seen, ended_at = NULL, project = excluded.project`,
    ).run(key, agentId, `script-${name}`, project, name, t, t);
    if (!prev || prev.ended_at !== null) this.event(`session:${key}`, "script.started", project, { name });
    return key;
  }

  // A session that ends gives up its roles and leases; the role's mailbox stays with the role.
  endSession(key: string, reason = "ended"): void {
    const r = this.db.query("UPDATE sessions SET ended_at = ? WHERE key = ? AND ended_at IS NULL").run(this.now(), key);
    if (!r.changes) return;
    for (const role of this.db.query("SELECT project, role FROM roles WHERE holder = ?").all(key) as { project: string; role: string }[]) {
      this.db.query("UPDATE roles SET holder = NULL, since = NULL WHERE project = ? AND role = ?").run(role.project, role.role);
      this.event(`session:${key}`, "role.released", role.project, { role: role.role, reason });
    }
    for (const l of this.db.query("SELECT * FROM leases WHERE holder = ? AND ended_at IS NULL").all(key) as LeaseRow[]) this.endLease(l, "released");
    // Its places in lease queues go too, so a dead session is never granted a lease that live ones wait for.
    for (const w of this.db.query("SELECT id, project, resource FROM lease_waiters WHERE agent_id = ? AND done_at IS NULL").all(key) as { id: number; project: string; resource: string }[]) {
      this.db.query("UPDATE lease_waiters SET done_at = ? WHERE id = ?").run(this.now(), w.id);
      this.grantWaiters(w.project, w.resource);
    }
    this.event(`session:${key}`, "session.ended", null, { reason });
  }

  // scripts: also the agents' named scripts (they can be addressed, but are no one's live session).
  liveSessions(project: string, scripts = false): SessionRow[] {
    return this.db.query(`SELECT * FROM sessions WHERE project = ? AND ended_at IS NULL AND (last_seen > ? OR kind = 'script')
      ${scripts ? "" : "AND kind = 'session'"} ORDER BY last_seen DESC`).all(project, this.now() - SESSION_LIVE_MS) as SessionRow[];
  }

  // Who a session or agent is, for humans and models: 'shop-5c (alice/mac#35dabd9e, work)'.
  label(holder: string): string {
    const key = holderOf(holder);
    if (!key.includes("#")) return key;
    const s = this.session(key);
    return s?.name ? `${s.name} (${key}${s.profile ? `, ${s.profile}` : ""})` : key;
  }

  // wakes: whether the client says its host wakes on a ring (a Claude Code session with the channel, a Codex bridge);
  // null when it does not say (older plugins).
  streamOpened(agentId: string, wakes: boolean | null = null): void {
    const add = (m: Map<string, number>) => m.set(agentId, (m.get(agentId) ?? 0) + 1);
    add(this.streams);
    if (wakes === true) add(this.wakers);
    if (wakes === false) add(this.sleepers);
    // Remembered on the session, so a reader outside this process (the admin CLI's health) can tell a session that
    // cannot be woken from one whose hooks are not reaching it.
    if (wakes !== null && agentId.includes("#")) this.db.query("UPDATE sessions SET wakes = ? WHERE key = ?").run(wakes ? 1 : 0, agentId);
    this.touch(agentId);
  }

  streamClosed(agentId: string, wakes: boolean | null = null): void {
    const drop = (m: Map<string, number>) => {
      const n = (m.get(agentId) ?? 1) - 1;
      if (n <= 0) m.delete(agentId);
      else m.set(agentId, n);
    };
    drop(this.streams);
    if (wakes === true) drop(this.wakers);
    if (wakes === false) drop(this.sleepers);
  }

  // 'wakes': a stream whose host wakes on a ring; 'no': streams open, but each said its host does not wake;
  // 'unknown': a stream that did not say; null: no stream.
  private wake(id: string): "wakes" | "no" | "unknown" | null {
    if (!this.streams.has(id)) return null;
    if (this.wakers.has(id)) return "wakes";
    return (this.sleepers.get(id) ?? 0) >= (this.streams.get(id) ?? 0) ? "no" : "unknown";
  }

  // Live sessions in the project, then agents that connect without sessions (plain MCP clients).
  presence(project: string) {
    const t = this.now();
    const rolesOf = (holder: string) =>
      (this.db.query("SELECT role FROM roles WHERE project = ? AND holder = ?").all(project, holder) as { role: string }[]).map((x) => x.role);
    const sessions = this.liveSessions(project).map((s) => {
      const agent = this.db.query("SELECT human FROM agents WHERE id = ?").get(s.agent_id) as { human: string };
      return {
        id: s.key, address: `session:${s.key}`, name: s.name, profile: s.profile, human: agent.human, last_seen: s.last_seen as number | null,
        bell: this.streams.has(s.key), wake: this.wake(s.key), online: this.streams.has(s.key) || t - s.last_seen < this.onlineWindowMs,
        unread: this.unreadCount(`session:${s.key}`), unseen: this.unshownCount([`session:${s.key}`]), roles: rolesOf(s.key),
      };
    });
    const withSessions = new Set(this.liveSessions(project).map((s) => s.agent_id));
    const agents = (this.db.query(
      `SELECT DISTINCT a.id, a.human, a.last_seen FROM agents a
         LEFT JOIN memberships m ON m.agent_id = a.id LEFT JOIN human_projects h ON h.human = a.human
        WHERE a.revoked = 0 AND (m.project = ? OR h.project = ?) ORDER BY a.id`,
    ).all(project, project) as { id: string; human: string; last_seen: number | null }[])
      .filter((a) => !withSessions.has(a.id) && a.last_seen !== null && t - a.last_seen < SESSION_LIVE_MS)
      .map((r) => ({
        id: r.id, address: `agent:${r.id}`, name: null as string | null, profile: null as string | null, human: r.human, last_seen: r.last_seen,
        bell: this.streams.has(r.id), wake: this.wake(r.id), online: this.streams.has(r.id) || (r.last_seen !== null && t - r.last_seen < this.onlineWindowMs),
        unread: this.unreadCount(`agent:${r.id}`), unseen: this.unshownCount([`agent:${r.id}`]), roles: rolesOf(r.id),
      }));
    return [...sessions, ...agents];
  }

  // ---------------------------------------------------------------- projects

  // An agent works in its own memberships and in every project its human is in.
  isMember(agentId: string, project: string): boolean {
    return !!this.db.query(
      `SELECT 1 FROM memberships WHERE agent_id = ?1 AND project = ?2
       UNION SELECT 1 FROM human_projects h JOIN agents a ON a.human = h.human WHERE a.id = ?1 AND h.project = ?2`,
    ).get(agentId, project);
  }

  humanInProject(human: string, project: string): boolean {
    return !!this.db.query("SELECT 1 FROM human_projects WHERE human = ? AND project = ?").get(human, project);
  }

  projectsOf(agentId: string): string[] {
    return (this.db.query(
      `SELECT p.id FROM projects p WHERE p.id IN (SELECT project FROM memberships WHERE agent_id = ?1
         UNION SELECT h.project FROM human_projects h JOIN agents a ON a.human = h.human WHERE a.id = ?1) ORDER BY p.owner, p.slug`,
    ).all(agentId) as { id: string }[]).map((r) => r.id);
  }

  projectAgents(project: string): string[] {
    return (this.db.query(
      `SELECT a.id FROM agents a WHERE a.revoked = 0 AND (
         EXISTS (SELECT 1 FROM memberships m WHERE m.agent_id = a.id AND m.project = ?1)
         OR EXISTS (SELECT 1 FROM human_projects h WHERE h.human = a.human AND h.project = ?1)) ORDER BY a.id`,
    ).all(project) as { id: string }[]).map((r) => r.id);
  }

  // Agents may open a project for their human, named '<human>/<slug>'; another person's project of the same slug is
  // no obstacle. Other humans are added by the admin.
  createProject(agentId: string, slug: string, brief = ""): string {
    const a = this.db.query("SELECT human FROM agents WHERE id = ?").get(agentId) as { human: string } | null;
    if (!a) throw new AxosError(`no agent '${agentId}'`);
    const own = slug.startsWith(`${a.human}/`) ? slug.slice(a.human.length + 1) : slug;
    if (own.includes("/")) throw new AxosError(`a project you create is ${a.human}/<name>; '${slug}' names someone else's`);
    const id = this.addProject(`${a.human}/${own}`, brief);
    this.addHumanToProject(a.human, id);
    this.event(`agent:${agentId}`, "project.created", id, {});
    return id;
  }

  projectHumans(project: string): string[] {
    return (this.db.query("SELECT human FROM human_projects WHERE project = ? ORDER BY human").all(project) as { human: string }[]).map((r) => r.human);
  }

  projectsOfHuman(human: string): string[] {
    return (this.db.query("SELECT p.id FROM projects p JOIN human_projects h ON h.project = p.id WHERE h.human = ? ORDER BY p.owner, p.slug")
      .all(human) as { id: string }[]).map((r) => r.id);
  }

  // Whose a holder is: the human behind an agent id or a session key.
  private humanOfHolder(holder: string): string {
    const agent = holderOf(holder).split("#")[0]!;
    return (this.db.query("SELECT human FROM agents WHERE id = ?").get(agent) as { human: string } | null)?.human ?? "";
  }

  private requireMember(agentId: string, project: string): void {
    if (!this.isMember(agentId, project)) {
      throw new AxosError(`you are not a member of project '${project}'; your projects: ${this.projectsOf(agentId).join(", ") || "none"}`);
    }
  }

  // A session works only in its folder's project; it reaches linked projects through messages alone. Agents without
  // sessions (plain MCP clients) work in every project they are members of.
  requireScope(agentId: string, project: string, session?: string): void {
    this.requireMember(agentId, project);
    if (!session) return;
    const own = this.session(session)?.project;
    if (own === project) return;
    if (!own) throw new AxosError(`this session's folder belongs to no project, so it cannot act in '${project}'; see the axos skill, 'connect'`);
    const linked = this.linkedProjects(own);
    throw new AxosError(`this session works in '${own}' (its folder's project), not in '${project}'` +
      (linked.includes(project) ? `; to reach '${project}', send from '${own}' to role:${project}/<role>, session:<name> or project:${project}` : ""));
  }

  private requireActorInProject(actor: Actor, project: string): void {
    if (actor.kind === "agent") this.requireMember(actor.id, project);
    else if (!this.humanInProject(actor.name, project)) throw new AxosError(`human '${actor.name}' is not in project '${project}'`);
  }

  brief(project: string): string {
    const p = this.db.query("SELECT brief FROM projects WHERE id = ?").get(project) as { brief: string } | null;
    if (!p) throw new AxosError(`no project '${project}'`);
    return p.brief;
  }

  // ---------------------------------------------------------------- roles

  defineRole(project: string, role: string, description?: string): void {
    checkName("role", role);
    if (!this.db.query("SELECT 1 FROM projects WHERE id = ?").get(project)) throw new AxosError(`no project '${project}'`);
    this.db.query("INSERT OR IGNORE INTO roles (project, role) VALUES (?, ?)").run(project, role);
    if (description !== undefined) this.db.query("UPDATE roles SET description = ? WHERE project = ? AND role = ?").run(oneLine(description, 300), project, role);
  }

  roles(project: string) {
    this.sweep();
    return this.db.query("SELECT role, description, holder, since FROM roles WHERE project = ? ORDER BY role").all(project) as {
      role: string; description: string; holder: string | null; since: number | null;
    }[];
  }

  // A role stays with its holder until it releases it, its session ends, or another session takes it over. Taking it
  // from one's own holder that is away (a sleeping laptop, a dropped connection) needs nothing; from one that is online
  // it needs force: the human's words, logged verbatim. The displaced holder is told either way.
  claimRole(agentId: string, project: string, role: string, force?: string, session?: string): { took_over_from: string | null } {
    this.requireScope(agentId, project, session);
    checkName("role", role);
    this.sweep();
    if (!this.db.query("SELECT 1 FROM roles WHERE project = ? AND role = ?").get(project, role)) {
      const known = this.roles(project).map((r) => r.role).join(", ") || "none";
      throw new AxosError(`no role '${role}' in '${project}' (known: ${known}); define_role creates one`);
    }
    if (session && this.session(session)?.kind === "script") {
      throw new AxosError("a script holds no roles; it speaks for one its agent's session holds with --as");
    }
    const me = session ?? agentId;
    const row = this.db.query("SELECT holder, since FROM roles WHERE project = ? AND role = ?").get(project, role) as
      { holder: string | null; since: number | null } | null;
    const prev = row?.holder ?? null;
    if (prev && prev !== me && this.humanOfHolder(prev) !== this.humanOfHolder(me)) {
      throw new AxosError(`role '${role}' is held by a session of ${this.humanOfHolder(prev)}; only they can release it (or it frees itself when that session ends)`);
    }
    const reason = force?.trim() || null;
    const away = !!prev && prev !== me && !this.isOnline(prev);
    if (prev && prev !== me && !away && !reason) {
      throw new AxosError(`role '${role}' is held by ${this.label(prev)} (${this.whereabouts(prev)}); a takeover needs force set to the human's words authorising it`);
    }
    const t = this.now();
    // A claim is a request from the claimer: it counts as being seen, like every call does on the way in.
    if (session) this.db.query("UPDATE sessions SET last_seen = ? WHERE key = ?").run(t, session);
    else this.touch(agentId);
    this.db.query(
      `INSERT INTO roles (project, role, holder, since) VALUES (?, ?, ?, ?)
       ON CONFLICT (project, role) DO UPDATE SET holder = excluded.holder, since = excluded.since`,
    ).run(project, role, me, prev === me ? row!.since : t);
    if (prev && prev !== me) {
      this.event(addr(me), "role.taken_over", project, { role, from: prev, force: reason, away });
      this.systemMessage(project, addr(prev), "status",
        `You no longer hold the role '${role}': ${away && !reason ? `while you were away, ${this.label(me)} took it` : `${this.label(me)} took it over`}.`,
        `${reason ? `Reason given: ${reason}\n` : ""}The role's mailbox, leases and open questions stay with the role.`, "high");
    } else if (prev !== me) {
      this.event(addr(me), "role.claimed", project, { role });
    }
    this.emit(addr(me), { kind: "role" });
    return { took_over_from: prev && prev !== me ? prev : null };
  }

  // The holder key an agent acts under: itself, or a role it holds in the project.
  // With a session and no `as`: the one role the session holds in the project, else the session itself.
  seat(agentId: string, project: string, as?: string, session?: string): string {
    this.requireScope(agentId, project, session);
    const me = session ?? agentId;
    if (as === "human") throw new AxosError('there is no "human" seat: to pass on what your human typed, send with quotes_human: true and their words as the body');
    if (!as) {
      if (!session) return agentId;
      const held = this.rolesHeldBy(`session:${session}`, project);
      return held.length === 1 ? `role:${project}/${held[0]}` : session;
    }
    const parts = as.replace(/^role:/, "").split("/");
    const role = parts.pop()!;
    if (parts.length && this.projectId(parts.join("/"), [project]) !== project) throw new AxosError(`role '${as}' is not in '${project}'`);
    this.sweep();
    const row = this.db.query("SELECT holder FROM roles WHERE project = ? AND role = ?").get(project, role) as { holder: string | null } | null;
    if (!row) throw new AxosError(`no role '${role}' in '${project}'`);
    // A script, or a client without a session, may speak for a role a session of the same agent holds: that token
    // could act as that session anyway. The message records who wrote it (sent_by).
    const deputy = (!session || this.session(session)?.kind === "script") && !!row.holder && row.holder.startsWith(`${agentId}#`);
    if (row.holder !== me && !deputy) {
      throw new AxosError(`you do not hold the role '${role}' in '${project}'${row.holder ? ` (${this.label(`session:${row.holder}`)} does)` : ""}; claim_role it first ` +
        "(a role taken in a repo's own role system or by a hook is not an AXOS claim unless the hook reports it)");
    }
    return `role:${project}/${role}`;
  }

  roleUnread(project: string, role: string): number {
    return this.unreadCount(`role:${project}/${role}`);
  }

  // Every seat a caller may be known by in a project: the seat it speaks as now, its own key, and every role it holds.
  // A lease (or a place in a queue) taken under any of them is its own, whatever roles it holds since.
  seatsOf(agentId: string, project: string, as?: string, session?: string): string[] {
    const me = session ?? agentId;
    const seats = new Set([this.seat(agentId, project, as, session), me]);
    if (session) for (const r of this.rolesHeldBy(`session:${session}`, project)) seats.add(`role:${project}/${r}`);
    return [...seats];
  }

  rolesHeldBy(sender: string, project: string): string[] {
    if (!sender.startsWith("agent:") && !sender.startsWith("session:")) return [];
    return (this.db.query("SELECT role FROM roles WHERE project = ? AND holder = ? ORDER BY role").all(project, holderOf(sender)) as { role: string }[]).map((r) => r.role);
  }

  // Every mailbox an actor reads: its session, the roles the session holds (in projects it is still in), and the agent's shared one.
  // A session reads the agent's shared mailbox only for its own project and the projects linked to it: an agent that is in
  // several projects must not carry one project's messages into a session working in another. The scope rides on the
  // address (agent:<id>@<project>+<project>); boxSql(), boxKey() and boxSees() read it.
  mailboxes(actor: { id: string; session?: string }, project?: string, as?: string): string[] {
    const boxes: string[] = [];
    if (actor.session) {
      boxes.push(`session:${actor.session}`);
      for (const r of this.db.query("SELECT project, role FROM roles WHERE holder = ? ORDER BY project, role").all(actor.session) as { project: string; role: string }[]) {
        if (this.isMember(actor.id, r.project)) boxes.push(`role:${r.project}/${r.role}`);
      }
    }
    if (as && project) {
      const box = addr(this.seat(actor.id, project, as, actor.session));
      if (!boxes.includes(box)) boxes.push(box);
    }
    if (actor.session) {
      const s = this.session(actor.session);
      // A script reads its own mail (and a role's it speaks for), not what waits for its agent's sessions.
      if (s?.kind === "script") return boxes;
      boxes.push(`agent:${actor.id}@${s?.project ? [s.project, ...this.linkedProjects(s.project)].join("+") : ""}`);
    } else boxes.push(`agent:${actor.id}`);
    return boxes;
  }

  // A mailbox's address without its project scope, as deliveries and events name it.
  boxKey(box: string): string {
    const at = box.indexOf("@");
    return at < 0 ? box : box.slice(0, at);
  }

  // SQL matching deliveries to these mailboxes; a scoped one only for messages of its projects.
  private boxSql(boxes: string[], recipient = "d.recipient", project = "m.project"): { sql: string; args: string[] } {
    const plain = boxes.filter((b) => !b.includes("@"));
    const parts = plain.length ? [`${recipient} IN (${plain.map(() => "?").join(", ")})`] : [];
    const args = [...plain];
    for (const b of boxes.filter((x) => x.includes("@"))) {
      const scope = b.slice(b.indexOf("@") + 1).split("+").filter(Boolean);
      if (!scope.length) continue;
      parts.push(`(${recipient} = ? AND ${project} IN (${scope.map(() => "?").join(", ")}))`);
      args.push(this.boxKey(b), ...scope);
    }
    return { sql: parts.length ? `(${parts.join(" OR ")})` : "0", args };
  }

  // Whether an event belongs to one of these mailboxes (a message to a scoped one only if it is of its projects).
  boxSees(boxes: string[], e: HubEvent): boolean {
    return boxes.some((b) => {
      if (!e.recipient || this.boxKey(b) !== e.recipient) return false;
      if (!b.includes("@") || e.message_id === undefined) return true;
      const m = this.db.query("SELECT project FROM messages WHERE id = ?").get(e.message_id) as { project: string } | null;
      return !!m && b.slice(b.indexOf("@") + 1).split("+").includes(m.project);
    });
  }

  releaseRole(agentId: string, project: string, role: string, session?: string): void {
    const me = session ?? agentId;
    const r = this.db.query("UPDATE roles SET holder = NULL, since = NULL WHERE project = ? AND role = ? AND holder = ?").run(project, role, me);
    if (r.changes === 0) throw new AxosError(`you do not hold role '${role}' in '${project}'`);
    this.event(addr(me), "role.released", project, { role });
  }

  // ---------------------------------------------------------------- addressing

  // Addresses: 'agent:<human>/<name>' (or bare '<human>/<name>'), 'human:<name>', 'role:<role>', 'role:<project>/<role>'
  // (the project as '<slug>' or '<owner>/<slug>'), 'session:<name or key>', 'project' or 'project:<project>' (every live
  // session and member agent except the sender). Roles, sessions, agents and 'project:<p>' of a linked project resolve
  // too; humans only in the message's own project.
  resolve(project: string, address: string, sender: string, senderHuman?: string): { recipient: string; via: string }[] {
    const a = address.trim();
    // Every live session, and every member agent that has none but has connected within the liveness window (it reads
    // its own mailbox when it next connects). A mailbox nobody has read for a week, or ever, is not in the room.
    if (a === "project" || a.startsWith("project:")) {
      const p = a === "project" ? project : this.reach(project, a.slice(8), a);
      const live = this.liveSessions(p);
      const withSessions = new Set(live.map((x) => x.agent_id));
      return [
        ...live.map((x) => `session:${x.key}`),
        ...this.projectAgents(p).filter((id) => !withSessions.has(id) && this.agentReachable(id)).map((id) => `agent:${id}`),
      ].map((recipient) => ({ recipient, via: `project:${p}` })).filter((r) => r.recipient !== sender);
    }
    if (a.startsWith("session:")) {
      // A key as people see it ('alice/mac#1e03fd48') or as stored ('agt_…#1e03fd48'); otherwise a session's name.
      let ref = a.slice(8);
      const k = /^(.+)#([0-9a-z]{8})$/.exec(ref);
      if (k) ref = `${this.agentId(k[1]!) ?? k[1]}#${k[2]}`;
      // The message's own project first; a linked project's session only when none here matches.
      let live = this.liveSessions(project, true);
      if (!live.some((x) => x.key === ref || x.name === ref)) {
        const there = this.linkedProjects(project).flatMap((p) => this.liveSessions(p, true)).filter((x) => x.key === ref || x.name === ref);
        if (there.length) live = there;
      }
      let hit = live.filter((x) => x.key === ref || x.name === ref);
      if (!hit.length) {
        // A name it had before a restart renamed it.
        const before = [project, ...this.linkedProjects(project)].flatMap((p) => this.liveSessions(p))
          .filter((x) => x.former_names.split("\n").includes(ref));
        if (before.length) hit = live = before;
      }
      if (senderHuman && !hit.some((x) => x.key === ref)) {
        const own = hit.filter((x) => this.humanOfHolder(x.key) === senderHuman);
        const ownEver = this.db.query("SELECT 1 FROM sessions s JOIN agents g ON g.id = s.agent_id WHERE s.project = ? AND s.name = ? AND g.human = ?")
          .get(project, ref, senderHuman);
        if (own.length) hit = own;
        else if (ownEver) throw new AxosError(`your session '${ref}' is not live in '${project}'`);
      }
      if (hit.length === 1) return [{ recipient: `session:${hit[0]!.key}`, via: `session:${hit[0]!.key}` }];
      if (hit.length > 1) throw new AxosError(`'${ref}' names ${hit.length} sessions; use the key: ${hit.map((x) => x.key).join(", ")}`);
      const any = this.session(ref);
      if (any?.project && (any.project === project || this.linkedProjects(project).includes(any.project))) {
        return [{ recipient: `session:${any.key}`, via: `session:${any.key}` }];
      }
      throw new AxosError(`no live session '${ref}' in '${project}'; live: ${live.map((x) => x.name ?? x.key).join(", ") || "none"}`);
    }
    if (a === "next") {
      // A note for whoever picks the work up: held for the next session of the sender's human that starts in this project.
      if (!senderHuman) throw new AxosError("only a session or agent of a person can leave a note for their next session");
      const box = `next:${project}/${senderHuman}`;
      return [{ recipient: box, via: box }];
    }
    if (a.startsWith("human:")) {
      const h = a.slice(6);
      if (!this.humanInProject(h, project)) throw new AxosError(`human '${h}' is not in project '${project}'`);
      return [{ recipient: a, via: a }];
    }
    if (a.startsWith("role:")) {
      // role:<role>, role:<slug>/<role> or role:<owner>/<slug>/<role>; role names hold no '/'.
      const parts = a.slice(5).split("/");
      const rest = parts.pop()!;
      const p = parts.length ? this.reach(project, parts.join("/"), a) : project;
      const row = this.db.query("SELECT holder FROM roles WHERE project = ? AND role = ?").get(p, rest) as { holder: string | null } | null;
      if (!row) {
        const known = this.roles(p).map((r) => r.role).join(", ") || "none";
        throw new AxosError(`no role '${rest}' in '${p}'; known roles: ${known}`);
      }
      const via = `role:${p}/${rest}`;
      return [{ recipient: via, via }];
    }
    const ref = a.startsWith("agent:") ? a.slice(6) : a;
    if (!/^[^/]+\/[^/#]+$/.test(ref) && !/^agt_[0-9a-z]{10}$/.test(ref)) {
      throw new AxosError(`cannot read address '${a}'; use role:<role>, session:<name or key>, human:<name>, agent:<human>/<name> or project`);
    }
    const id = this.agentId(ref);
    const live = id && !(this.db.query("SELECT revoked FROM agents WHERE id = ?").get(id) as { revoked: number }).revoked;
    if (!live || ![project, ...this.linkedProjects(project)].some((p) => this.isMember(id, p))) throw new AxosError(`agent '${ref}' is not in project '${project}'`);
    return [{ recipient: `agent:${id}`, via: `agent:${id}` }];
  }

  // ---------------------------------------------------------------- messages

  send(actor: Actor, input: {
    project: string;
    to?: string[]; // may be left out with re: the reply goes to whoever sent that message
    type: MessageType;
    summary: string;
    body?: string;
    thread?: number;
    re?: number;
    as_of?: string;
    priority?: Priority;
    dedupe_key?: string;
    no_push?: boolean;
    quotes_human?: boolean; // the body is what the sender's human typed, as the plugin checked (actor.human_words)
    queue?: boolean; // accepted and ignored since 0.18.0: mail to a role always waits
  }): { id: number; duplicate: boolean; delivered_to: string[]; waiting_for_role: string[]; not_sent: { to: string; reason: string }[]; unattended: string[] } {
    this.requireActorInProject(actor, input.project);
    const sender = actor.kind === "agent" ? addr(this.seat(actor.id, input.project, actor.as, actor.session)) : `human:${actor.name}`;
    // A session may quote its human: the body is what the human typed, checked by the plugin on the human's machine.
    // The message stays the session's (its trust, its walls, its caps); quotes_human only says whose words the body
    // holds. Only the human's own page speaks as human:<name>. (Security review of 2026-10-30.)
    let quotes: string | null = null;
    if (input.quotes_human) {
      if (actor.kind !== "agent" || !actor.session || !actor.human_words) {
        throw new AxosError("quotes_human needs the plugin's check of the words against what your human typed to this session; " +
          "this client has no such check (a script, Codex, or an older plugin): send their words as a quote in your own message instead");
      }
      quotes = this.humanOf(actor.id);
    }
    if (!MESSAGE_TYPES.includes(input.type)) throw new AxosError(`type must be one of ${MESSAGE_TYPES.join(", ")}`);
    const summary = input.summary.trim();
    const body = input.body ?? "";
    if (!summary) throw new AxosError("summary is required: one sentence saying what this means, readable without knowing any ids");
    if (summary.length > MAX_SUMMARY) throw new AxosError(`summary is ${summary.length} characters, ${summary.length - MAX_SUMMARY} over the limit of ${MAX_SUMMARY}; shorten it and put detail in body`);
    if (body.length > MAX_BODY) throw new AxosError(`body is ${body.length} characters; the limit is ${MAX_BODY}, link to a git file instead`);
    const secret = findSecret(`${summary}\n${body}`);
    if (secret) throw new AxosError(`message rejected: it looks like it contains a ${secret}. Never send secrets through AXOS.`);

    if (input.dedupe_key) {
      const dup = this.db.query("SELECT id FROM messages WHERE sender = ? AND dedupe_key = ?").get(sender, input.dedupe_key) as { id: number } | null;
      if (dup) return { id: dup.id, duplicate: true, delivered_to: [], waiting_for_role: [], not_sent: [], unattended: [] };
    }
    if (actor.kind === "agent") this.rateLimit(actor.id);

    // A conversation may run across a link: a reply goes into the parent's thread, if the sender saw the parent.
    const inScope = (id: number): boolean => {
      const m = this.db.query("SELECT project FROM messages WHERE id = ?").get(id) as { project: string } | null;
      if (!m) return false;
      if (m.project === input.project) return true;
      if (!this.linkedProjects(input.project).includes(m.project)) return false;
      const boxes = actor.kind === "agent" ? [sender, ...this.mailboxes(actor)] : [sender];
      const senders = boxes.map((b) => this.boxKey(b));
      const inList = senders.map(() => "?").join(", ");
      const box = this.boxSql(boxes);
      return !!this.db.query(
        `SELECT 1 FROM messages m WHERE (m.id = ? OR m.thread = ?) AND (m.sender IN (${inList})
           OR EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND ${box.sql})) LIMIT 1`,
      ).get(id, id, ...senders, ...box.args);
    };
    let thread = input.thread ?? null;
    // A thread named without re or to continues that conversation: a reply to its first message.
    const re = input.re ?? (thread !== null && !input.to?.length ? thread : undefined);
    const recipients = new Map<string, string>();
    if (re !== undefined) {
      if (!inScope(re)) throw new AxosError(`no message ${re} in '${input.project}'`);
      const parent = this.db.query("SELECT id, thread, sender FROM messages WHERE id = ?").get(re) as { id: number; thread: number | null; sender: string };
      thread ??= parent.thread ?? parent.id;
      // A reply always finds its way back: to the sender's mailbox, even in another project, and to the agent's shared
      // mailbox when the sending session has ended since.
      if (!input.to?.length) {
        if (parent.sender === SYSTEM_SENDER) throw new AxosError("messages from the hub take no reply; say who it is for with to");
        const back = this.liveBox(parent.sender);
        if (back !== sender) recipients.set(back, back);
        // A follow-up to one's own message goes to whoever that message went to.
        else for (const d of this.db.query("SELECT recipient, via FROM deliveries WHERE message_id = ?").all(parent.id) as { recipient: string; via: string }[]) {
          const box = this.liveBox(d.recipient);
          if (box !== sender && !recipients.has(box)) recipients.set(box, d.via);
        }
      }
    }
    if (thread !== null && !inScope(thread)) throw new AxosError(`no thread ${thread} in '${input.project}'`);
    if (!input.to?.length && !recipients.size) throw new AxosError(re === undefined ? "to is empty" : "nobody to reply to (that message was yours)");

    // Each address on its own: the ones that resolve get the message, the others come back with their reason.
    const notSent: { to: string; reason: string }[] = [];
    const human = actor.kind === "agent" ? this.humanOf(actor.id) : actor.name;
    for (const a of input.to ?? []) {
      let found: { recipient: string; via: string }[];
      try {
        found = this.resolve(input.project, a, sender, human);
      } catch (e) {
        if (!(e instanceof AxosError)) throw e;
        notSent.push({ to: a, reason: e.message });
        continue;
      }
      for (const r of found) {
        // One's own role is a mailbox the next holder reads too, so mail to it is kept (a note for a successor); oneself
        // as a session or agent is dropped.
        const self = (r.recipient === sender && !r.recipient.startsWith("role:")) || (actor.kind === "agent" && r.via.startsWith("project:") &&
          (r.recipient === `agent:${actor.id}` || r.recipient === `session:${actor.session}`));
        if (!self && !recipients.has(r.recipient)) recipients.set(r.recipient, r.via);
      }
    }
    if (!recipients.size) {
      if (notSent.length === 1) throw new AxosError(notSent[0]!.reason);
      throw new AxosError(notSent.length ? notSent.map((x) => `${x.to}: ${x.reason}`).join("\n") : "nobody to deliver to (the only recipient was yourself)");
    }

    // A note or status to a whole project is news, not a call: it waits for each session's next step.
    // Written by someone other than the sender: a script, or a client without a session, speaking for a role.
    const holder = sender.startsWith("role:") ? (this.db.query("SELECT holder FROM roles WHERE project || '/' || role = ?").get(sender.slice(5)) as { holder: string | null } | null)?.holder : null;
    const sentBy = actor.kind === "agent" && sender.startsWith("role:") && holder !== (actor.session ?? actor.id) ? addr(actor.session ?? actor.id) : null;
    const priority = input.priority ?? ((input.type === "note" || input.type === "status") && (input.to ?? []).some((a) => a === "project" || a.startsWith("project:")) ? "low" : "normal");
    const id = this.db.transaction(() => {
      const res = this.db.query(
        `INSERT INTO messages (project, sender, sender_human, to_json, type, summary, body, thread, re, as_of, priority, dedupe_key, created_at, sent_by, quotes_human)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.project, sender, human, JSON.stringify(input.to?.filter((a) => !notSent.some((x) => x.to === a)) ?? [...recipients.keys()]), input.type, summary, body, thread, re ?? null,
        input.as_of ?? null, priority, input.dedupe_key ?? null, this.now(), sentBy, quotes);
      const mid = Number(res.lastInsertRowid);
      for (const [recipient, via] of recipients) {
        this.db.query("INSERT INTO deliveries (message_id, recipient, via) VALUES (?, ?, ?)").run(mid, recipient, via);
      }
      return mid;
    })();
    this.event(actor.kind === "agent" ? (actor.session ? `session:${actor.session}` : `agent:${actor.id}`) : sender, "message.sent", input.project,
      { id, type: input.type, to: [...recipients.keys()], ...(sender.startsWith("role:") ? { as: sender } : {}) });

    const ev: HubEvent = { kind: "message", message_id: id, from: sender, summary, type: input.type, priority };
    for (const recipient of recipients.keys()) {
      this.emit(recipient, ev);
      if (recipient.startsWith("human:") && !input.no_push && (input.priority === "high" || input.type === "ask")) {
        void this.pushToHuman(recipient.slice(6), `${this.senderTitle(sender)} (${this.projectName(input.project)})`, summary, `#m${id}`);
      }
    }
    const vacant = (r: string) => (r.startsWith("role:") && !this.roleHolder(r)) || r.startsWith("next:");
    const holderText = (r: string) => {
      const h = this.roleHolder(r)!;
      return `${this.labelFor(h, human, r.slice(5).split("/")[0] !== input.project)}, ${this.whereabouts(h)}`;
    };
    // A role nobody is reading right now (vacant, or its holder away): the mail waits, and the sender is told so, with
    // who else is in the room, so it can also turn to someone who is there.
    const unattended = [...recipients.keys()].filter((r) => r.startsWith("role:") && !(this.roleHolder(r) && this.isOnline(this.roleHolder(r)!)))
      .map((r) => this.room(input.project, r, human, actor.kind === "agent" ? actor.session ?? actor.id : ""));
    // An agent's mailbox nobody has opened lately: the mail waits, and the sender knows it may wait for good.
    const stale = [...recipients.keys()].filter((r) => r.startsWith("agent:") && !this.agentReachable(r.slice(6))).map((r) => {
      const seen = this.lastSeen(r.slice(6));
      return `${this.label(r)} has not connected ${seen === null ? "yet" : `since ${when(seen)}`}: the message waits in its mailbox and expires unread after 7 days.`;
    });
    return {
      id,
      duplicate: false,
      delivered_to: [...recipients.keys()].filter((r) => !vacant(r)).map((r) => r.startsWith("role:") ? `${r} (held by ${holderText(r)})` : r),
      waiting_for_role: [...recipients.keys()].filter(vacant),
      not_sent: notSent,
      unattended: [...unattended, ...stale],
    };
  }

  // A holder in words for a viewer: its label in the viewer's own project or for its own human; across a link another
  // person's session is only "a session of <human>", as presence does not cross a link.
  labelFor(holder: string, viewerHuman: string, acrossLink: boolean): string {
    const h = this.humanOfHolder(holder);
    return !acrossLink || h === viewerHuman ? this.label(holder) : `a session of ${h}`;
  }

  // The state of a role nobody is reading now and who else is in the room: in the sender's own project every other
  // live session with its roles and reach; in a linked project only the roles held there, as nothing else crosses.
  private room(from: string, roleAddr: string, viewerHuman: string, me: string): string {
    const [p, role] = roleAddr.slice(5).split("/", 2) as [string, string];
    const own = p === from;
    const holder = this.roleHolder(roleAddr);
    const state = holder ? `held by ${this.labelFor(holder, viewerHuman, !own)} (${this.whereabouts(holder)})` : "held by nobody";
    const room = own
      ? this.liveSessions(p).filter((x) => x.key !== me && x.key !== holder)
        .map((x) => `${this.label(x.key)} (${this.rolesHeldBy(`session:${x.key}`, p).join(", ") || "no role"}; ${this.whereabouts(x.key)})`)
      : this.roles(p).filter((r) => r.holder && r.role !== role).map((r) => `role:${p}/${r.role} (${this.labelFor(r.holder!, viewerHuman, true)}; ${this.whereabouts(r.holder!)})`);
    return `${roleAddr} is ${state}: the message waits there. ${own ? "In the room" : `Roles held in ${p}`}: ${room.join("; ") || (own ? "nobody else" : "none")}.`;
  }

  // Where mail for a mailbox goes now: a session that has ended since hands it to its agent's shared mailbox.
  private liveBox(box: string): string {
    if (!box.startsWith("session:")) return box;
    const s = this.session(box.slice(8));
    return s && s.ended_at === null ? box : `agent:${s?.agent_id ?? box.slice(8).split("#")[0]}`;
  }

  private humanOf(agentId: string): string {
    return (this.db.query("SELECT human FROM agents WHERE id = ?").get(agentId) as { human: string }).human;
  }

  // How a sender reads in a push title: the role, or the session's name.
  senderTitle(sender: string): string {
    if (sender.startsWith("role:")) return sender.slice(5).split("/")[1]!;
    if (sender.startsWith("session:")) return this.session(holderOf(sender))?.name ?? holderOf(sender);
    if (sender.startsWith("agent:")) return this.agentLabel(sender.slice(6)) ?? sender.slice(6);
    return sender.replace(/^human:/, "");
  }

  private roleHolder(roleAddr: string): string | null {
    const [project, role] = roleAddr.slice(5).split("/", 2);
    return (this.db.query("SELECT holder FROM roles WHERE project = ? AND role = ?").get(project!, role!) as { holder: string | null } | null)?.holder ?? null;
  }

  private systemMessage(project: string, recipient: string, type: MessageType, summary: string, body = "", priority: Priority = "normal", re?: number): number {
    const res = this.db.query(
      `INSERT INTO messages (project, sender, to_json, type, summary, body, re, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(project, SYSTEM_SENDER, JSON.stringify([recipient]), type, summary, body, re ?? null, priority, this.now());
    const id = Number(res.lastInsertRowid);
    this.db.query("INSERT INTO deliveries (message_id, recipient, via) VALUES (?, ?, ?)").run(id, recipient, recipient);
    this.emit(recipient, { kind: "message", message_id: id, from: SYSTEM_SENDER, summary, type, priority });
    return id;
  }

  private rateLimit(agentId: string): void {
    const t = this.now();
    const log = (this.sendLog.get(agentId) ?? []).filter((x) => t - x < 60_000);
    if (log.length >= this.sendsPerMinute) {
      throw new AxosError(`rate limit: ${this.sendsPerMinute} messages per minute. Batch your updates into one message.`);
    }
    log.push(t);
    this.sendLog.set(agentId, log);
  }

  inbox(recipient: string | string[], opts: { unreadOnly?: boolean; unshownOnly?: boolean; limit?: number; project?: string } = {}): InboxItem[] {
    this.sweep();
    const boxes = Array.isArray(recipient) ? recipient : [recipient];
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const box = this.boxSql(boxes);
    const where = [box.sql];
    const args: (string | number)[] = [...box.args];
    if (opts.unreadOnly ?? true) where.push("d.acked_at IS NULL");
    if (opts.unshownOnly) where.push("d.shown_at IS NULL");
    if (opts.project) { where.push("m.project = ?"); args.push(opts.project); }
    // Unread: oldest first, so nothing is skipped. History: newest first.
    const order = (opts.unreadOnly ?? true) ? "m.id ASC" : "m.id DESC";
    return this.db.query(
      `SELECT m.*, d.via, d.recipient, d.acked_at, d.shown_at FROM deliveries d JOIN messages m ON m.id = d.message_id
        WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${limit}`,
    ).all(...args) as InboxItem[];
  }

  unreadCount(recipient: string | string[], project?: string): number {
    const box = this.boxSql(Array.isArray(recipient) ? recipient : [recipient]);
    return (this.db.query(`SELECT COUNT(*) AS n FROM deliveries d JOIN messages m ON m.id = d.message_id
      WHERE ${box.sql} AND d.acked_at IS NULL${project ? " AND m.project = ?" : ""}`).get(...box.args, ...(project ? [project] : [])) as { n: number }).n;
  }

  // In words for a reader: 'open' is not acked (still to handle); 'unseen' is not yet put into any context.
  mailText(recipient: string | string[], project?: string): string {
    const boxes = Array.isArray(recipient) ? recipient : [recipient];
    const open = this.unreadCount(boxes, project);
    if (!open) return "nothing to handle";
    const unseen = this.unshownCount(boxes, false, project);
    const how = unseen === 0 ? "all read, not acked yet" : unseen === open ? "none read yet" : `${open - unseen} read, ${unseen} not read yet`;
    return `${open} to handle (${how})`;
  }

  unreadByProject(recipient: string | string[]): { project: string; n: number }[] {
    const box = this.boxSql(Array.isArray(recipient) ? recipient : [recipient]);
    return this.db.query(`SELECT m.project, COUNT(DISTINCT m.id) AS n FROM deliveries d JOIN messages m ON m.id = d.message_id
      WHERE ${box.sql} AND d.acked_at IS NULL GROUP BY m.project ORDER BY n DESC`).all(...box.args) as { project: string; n: number }[];
  }

  unreadBySender(recipient: string | string[]): { sender: string; n: number }[] {
    const box = this.boxSql(Array.isArray(recipient) ? recipient : [recipient]);
    return this.db.query(`SELECT m.sender, COUNT(DISTINCT m.id) AS n FROM deliveries d JOIN messages m ON m.id = d.message_id
      WHERE ${box.sql} AND d.acked_at IS NULL GROUP BY m.sender ORDER BY n DESC, MAX(m.id) DESC`).all(...box.args) as { sender: string; n: number }[];
  }

  // Messages not yet put into this reader's context (by a hook, inbox or wait); marks them shown. They stay unread until acked.
  takeUnshown(boxes: string[], limit = 10): InboxItem[] {
    const items = this.inbox(boxes, { unshownOnly: true, limit });
    this.markShown(boxes, items.map((m) => m.id));
    return items;
  }

  // Of these messages, the ones whose thread has a later message from the reader (its session or a role it holds): it
  // has spoken in that conversation since, so they need not stop it from ending a turn.
  superseded(sessionKey: string, items: InboxItem[]): Set<number> {
    const senders = [`session:${sessionKey}`, ...(this.db.query("SELECT project, role FROM roles WHERE holder = ?").all(sessionKey) as { project: string; role: string }[])
      .map((r) => `role:${r.project}/${r.role}`)];
    const out = new Set<number>();
    for (const m of items) {
      const root = m.thread ?? m.id;
      const later = this.db.query(`SELECT 1 FROM messages WHERE (id = ? OR thread = ?) AND id > ? AND sender IN (${senders.map(() => "?").join(", ")}) LIMIT 1`)
        .get(root, root, m.id, ...senders);
      if (later) out.add(m.id);
    }
    return out;
  }

  markShown(boxes: string[], ids: number[]): void {
    const t = this.now();
    const box = this.boxSql(boxes, "recipient", "(SELECT project FROM messages WHERE id = message_id)");
    for (const id of ids) this.db.query(`UPDATE deliveries SET shown_at = ? WHERE message_id = ? AND ${box.sql} AND shown_at IS NULL`).run(t, id, ...box.args);
  }

  // waking: only messages worth waking an idle session for (low priority ones wait for its next step).
  unshownCount(boxes: string[], waking = false, project?: string): number {
    const box = this.boxSql(boxes);
    return (this.db.query(`SELECT COUNT(*) AS n FROM deliveries d JOIN messages m ON m.id = d.message_id
      WHERE ${box.sql} AND d.acked_at IS NULL AND d.shown_at IS NULL${waking ? " AND m.priority <> 'low'" : ""}${project ? " AND m.project = ?" : ""}`)
      .get(...box.args, ...(project ? [project] : [])) as { n: number }).n;
  }

  ack(recipient: string | string[], ids: number[], outcome?: AckOutcome, note?: string): number {
    return this.ackReport(recipient, ids, outcome, note).acked.length;
  }

  // Which ids were acked now, which were acked before, and which are not in these mailboxes (a message of someone
  // else answers exactly like one that does not exist).
  // note: one line for the sender's view of the thread ("forwarded to lane 3"); peer text, kept to one line.
  ackReport(recipient: string | string[], ids: number[], outcome?: AckOutcome, note?: string): { acked: number[]; earlier: number[]; missing: number[] } {
    if (outcome !== undefined && !ACK_OUTCOMES.includes(outcome)) throw new AxosError(`outcome must be one of ${ACK_OUTCOMES.join(", ")}`);
    if (note !== undefined && note.length > MAX_ACK_NOTE) throw new AxosError(`the note is ${note.length} characters; at most ${MAX_ACK_NOTE}: say more in a reply`);
    const line = note?.trim() ? oneLine(note, MAX_ACK_NOTE) : null;
    const boxes = Array.isArray(recipient) ? recipient : [recipient];
    const box = this.boxSql(boxes, "recipient", "(SELECT project FROM messages WHERE id = message_id)");
    const r = { acked: [] as number[], earlier: [] as number[], missing: [] as number[] };
    const t = this.now();
    for (const id of [...new Set(ids)]) {
      if (this.db.query(`UPDATE deliveries SET acked_at = ?, outcome = ?, note = ? WHERE ${box.sql} AND message_id = ? AND acked_at IS NULL`)
        .run(t, outcome ?? null, line, ...box.args, id).changes) r.acked.push(id);
      else if (this.db.query(`SELECT 1 FROM deliveries WHERE ${box.sql} AND message_id = ?`).get(...box.args, id)) r.earlier.push(id);
      else r.missing.push(id);
    }
    if (r.acked.length) this.event(this.boxKey(boxes[0]!), "message.acked", null, { ids: r.acked });
    return r;
  }

  // Who a message went to and how far each got: unread, read (shown), acked, with the outcome they gave.
  receipts(messageId: number): { recipient: string; shown_at: number | null; acked_at: number | null; outcome: string | null; note: string | null }[] {
    return this.db.query("SELECT recipient, shown_at, acked_at, outcome, note FROM deliveries WHERE message_id = ? ORDER BY rowid")
      .all(messageId) as { recipient: string; shown_at: number | null; acked_at: number | null; outcome: string | null; note: string | null }[];
  }

  // The whole thread a message belongs to, if the reader may see that project.
  // The messages of a thread the reader sent or received. A message of another project, or of someone else's
  // conversation, answers exactly like one that does not exist.
  thread(reader: Actor, messageId: number): MessageRow[] {
    const none = new AxosError(`no message ${messageId} for you`);
    const m = this.db.query("SELECT id, project, thread FROM messages WHERE id = ?").get(messageId) as { id: number; project: string; thread: number | null } | null;
    if (!m) throw none;
    // A session sees threads of its own project and the linked ones only, as with its agent's mailbox.
    const own = reader.kind === "agent" && reader.session ? this.session(reader.session)?.project ?? null : undefined;
    const member = own !== undefined
      ? own !== null && [own, ...this.linkedProjects(own)].includes(m.project)
      : [m.project, ...this.linkedProjects(m.project)]
        .some((p) => reader.kind === "agent" ? this.isMember(reader.id, p) : this.humanInProject(reader.name, p));
    if (!member) throw none;
    const boxes = reader.kind === "agent" ? this.mailboxes(reader) : [`human:${reader.name}`];
    const senders = boxes.map((b) => this.boxKey(b));
    const box = this.boxSql(boxes, "d.recipient", "m.project");
    const root = m.thread ?? m.id;
    const rows = this.db.query(
      `SELECT m.* FROM messages m WHERE (m.id = ? OR m.thread = ?)
         AND (m.sender IN (${senders.map(() => "?").join(", ")}) OR EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND ${box.sql}))
       ORDER BY m.id`,
    ).all(root, root, ...senders, ...box.args) as MessageRow[];
    if (!rows.some((r) => r.id === messageId)) throw none;
    return rows;
  }

  // What a human's agents sent that other people can read: to another person, their sessions or agents, or a role
  // mailbox in a project shared with others (whoever holds the role later reads it). Newest first.
  sentToOthers(human: string, limit = 50): (MessageRow & { readers: string[] })[] {
    const others = (project: string) => (this.db.query("SELECT human FROM human_projects WHERE project = ? AND human != ?").all(project, human) as { human: string }[]).map((r) => r.human);
    const out: (MessageRow & { readers: string[] })[] = [];
    for (const m of this.db.query("SELECT * FROM messages WHERE sender_human = ? AND sender NOT LIKE 'human:%' ORDER BY id DESC LIMIT 500").all(human) as MessageRow[]) {
      const readers = new Set<string>();
      for (const d of this.db.query("SELECT recipient FROM deliveries WHERE message_id = ?").all(m.id) as { recipient: string }[]) {
        const r = d.recipient;
        if (r.startsWith("human:")) { if (r.slice(6) !== human) readers.add(r.slice(6)); }
        else if (r.startsWith("role:")) others(r.slice(5).split("/")[0]!).forEach((h) => readers.add(h));
        else if (this.humanOfHolder(r) !== human) readers.add(this.humanOfHolder(r));
      }
      // A message that quotes the human is listed whoever read it: they must be able to see what was said in their words.
      if (readers.size || m.quotes_human) out.push({ ...m, readers: [...readers].sort() });
      if (out.length >= limit) break;
    }
    return out;
  }

  getMessage(id: number): MessageRow | null {
    return this.db.query("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | null;
  }

  // Long-poll: resolves as soon as a message this reader has not seen yet is waiting (with how many), or after the
  // timeout with 0. Unread messages already shown do not count, so an agent that has not acked does not spin.
  wait(recipient: string | string[], timeoutS: number, signal?: AbortSignal): Promise<number> {
    const boxes = Array.isArray(recipient) ? recipient : [recipient];
    const n = this.unshownCount(boxes);
    if (n > 0) return Promise.resolve(n);
    const ms = Math.min(Math.max(timeoutS, 1), MAX_WAIT_S) * 1000;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", done);
        resolve(this.unshownCount(boxes));
      };
      const offs = boxes.map((b) => this.subscribe(this.boxKey(b), (e) => { if (e.kind === "message" && this.boxSees([b], e)) done(); }));
      const unsubscribe = () => offs.forEach((off) => off());
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done);
    });
  }

  subscribe(recipient: string, fn: (e: HubEvent) => void): () => void {
    let set = this.listeners.get(recipient);
    if (!set) this.listeners.set(recipient, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.listeners.delete(recipient);
    };
  }

  // Listeners on "*" hear every event with its recipient (the bell filters by the session's current mailboxes).
  private emit(recipient: string, e: HubEvent): void {
    for (const fn of [...(this.listeners.get(recipient) ?? []), ...(this.listeners.get("*") ?? [])]) {
      try { fn({ ...e, recipient }); } catch { /* a broken listener must not break delivery */ }
    }
  }

  // ---------------------------------------------------------------- leases

  // Leases on any named resource: 'file:<path>', 'version:<mod>', 'server:<name>', 'slot:<box>'.
  // Exact-name matching (no globs); strict FIFO for waiters, so nobody starves.
  lease(agentId: string, input: { project: string; resource: string; mode?: "exclusive" | "shared"; ttl_s?: number; note?: string; wait?: boolean; as?: string; session?: string }):
    { granted: boolean; lease_id?: number; expires_at?: number; renewed?: boolean; position?: number; holders: { holder: string; mode: string; note: string; expires_at: number }[] } {
    const holder = this.seat(agentId, input.project, input.as, input.session);
    const mine = this.seatsOf(agentId, input.project, input.as, input.session);
    this.sweep();
    const mode = input.mode ?? "exclusive";
    const ttl = Math.min(Math.max(input.ttl_s ?? 1800, 30), MAX_LEASE_TTL_S);
    const resource = oneLine(input.resource, 120);
    if (!resource) throw new AxosError("resource is required");
    input = { ...input, note: input.note === undefined ? undefined : oneLine(input.note, 200) };
    const t = this.now();
    const live = this.liveLeases(input.project, resource);
    const holders = live.map((l) => ({ holder: l.holder, mode: l.mode, note: l.note, expires_at: l.expires_at }));

    const own = live.find((l) => mine.includes(l.holder));
    if (own) {
      // A renewal extends; it does not change the mode, and without ttl_s it runs as long as the lease was granted for.
      if (input.mode && input.mode !== own.mode) {
        throw new AxosError(`you hold '${resource}' ${own.mode}; release it and lease again to change to ${input.mode}`);
      }
      const span = input.ttl_s === undefined ? (own.ttl_s ?? Math.round((own.expires_at - own.granted_at) / 1000)) : ttl;
      this.db.query("UPDATE leases SET expires_at = ?, note = ? WHERE id = ?").run(t + span * 1000, input.note ?? own.note, own.id);
      return { granted: true, lease_id: own.id, expires_at: t + span * 1000, renewed: true, holders };
    }
    const queue = this.waiters(input.project, resource);
    if (!queue.length && compatible(live, mode)) {
      const id = this.grant(input.project, resource, holder, mode, input.note ?? "", ttl);
      return { granted: true, lease_id: id, expires_at: t + ttl * 1000, holders };
    }
    if (input.wait ?? true) {
      let w = queue.find((q) => mine.includes(q.agent_id));
      if (!w) {
        this.db.query("INSERT INTO lease_waiters (project, resource, agent_id, mode, note, ttl_s, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(input.project, resource, holder, mode, input.note ?? "", ttl, t);
        this.event(addr(holder), "lease.queued", input.project, { resource, mode });
      }
      const position = this.waiters(input.project, resource).findIndex((q) => mine.includes(q.agent_id)) + 1;
      return { granted: false, position, holders };
    }
    return { granted: false, holders };
  }

  releaseLease(agentId: string, project: string, resource: string, as?: string, session?: string): { released: boolean; left_queue: boolean } {
    const mine = this.seatsOf(agentId, project, as, session);
    const own = this.liveLeases(project, resource).find((l) => mine.includes(l.holder));
    if (own) this.endLease(own, "released");
    const left = this.db.query(`UPDATE lease_waiters SET done_at = ? WHERE project = ? AND resource = ? AND agent_id IN (${mine.map(() => "?").join(", ")}) AND done_at IS NULL`)
      .run(this.now(), project, resource, ...mine).changes > 0;
    if (!own && !left) throw new AxosError(`you hold no lease on '${resource}' and are not waiting for it`);
    if (left && !own) this.grantWaiters(project, resource);
    return { released: !!own, left_queue: left };
  }

  leases(project: string): { live: LeaseRow[]; waiting: { resource: string; agent_id: string; mode: string; note: string; queued_at: number }[] } {
    this.sweep();
    return {
      live: this.db.query("SELECT * FROM leases WHERE project = ? AND ended_at IS NULL ORDER BY resource, id").all(project) as LeaseRow[],
      waiting: this.db.query("SELECT resource, agent_id, mode, note, queued_at FROM lease_waiters WHERE project = ? AND done_at IS NULL ORDER BY id").all(project) as
        { resource: string; agent_id: string; mode: string; note: string; queued_at: number }[],
    };
  }

  private liveLeases(project: string, resource: string): LeaseRow[] {
    return this.db.query("SELECT * FROM leases WHERE project = ? AND resource = ? AND ended_at IS NULL ORDER BY id").all(project, resource) as LeaseRow[];
  }

  private waiters(project: string, resource: string) {
    return this.db.query("SELECT * FROM lease_waiters WHERE project = ? AND resource = ? AND done_at IS NULL ORDER BY id").all(project, resource) as
      { id: number; agent_id: string; mode: "exclusive" | "shared"; note: string; ttl_s: number }[];
  }

  private grant(project: string, resource: string, holder: string, mode: string, note: string, ttlS: number): number {
    const t = this.now();
    const res = this.db.query("INSERT INTO leases (project, resource, holder, mode, note, ttl_s, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(project, resource, holder, mode, note, ttlS, t, t + ttlS * 1000);
    this.event(addr(holder), "lease.granted", project, { resource, mode, ttl_s: ttlS });
    return Number(res.lastInsertRowid);
  }

  private endLease(l: LeaseRow, reason: "released" | "expired" | "revoked"): void {
    this.db.query("UPDATE leases SET ended_at = ?, end_reason = ? WHERE id = ?").run(this.now(), reason, l.id);
    this.event(addr(l.holder), `lease.${reason}`, l.project, { resource: l.resource });
    if (reason === "expired") {
      this.systemMessage(l.project, addr(l.holder), "status", `Your lease on '${l.resource}' expired; others may now take it.`,
        "Renew a lease by calling lease again before it runs out.", "high");
    }
    this.grantWaiters(l.project, l.resource);
  }

  private grantWaiters(project: string, resource: string): void {
    for (const w of this.waiters(project, resource)) {
      if (!compatible(this.liveLeases(project, resource), w.mode)) break;
      this.db.query("UPDATE lease_waiters SET done_at = ? WHERE id = ?").run(this.now(), w.id);
      this.grant(project, resource, w.agent_id, w.mode, w.note, w.ttl_s);
      this.systemMessage(project, addr(w.agent_id), "status", `Lease granted: you now hold '${resource}' (${w.mode}).`,
        `It runs for ${Math.round(w.ttl_s / 60)} minutes; renew by calling lease again, release when done.`, "high");
    }
  }

  // ---------------------------------------------------------------- landings and subscriptions

  // "Tell me when <sha> is on <branch>": one message when it lands, or (without sha) one per landing until it expires.
  // A subscription belongs to the seat that made it: the session, or the role it speaks as, so a new holder inherits it.
  // branch may be a pattern: * stands for any characters, slashes too (slice/*, refs/evidence/*/verdict-*).
  // subject: only landings whose subject contains it. replace: one's own open subscription this one takes over from.
  subscribeLanding(agentId: string, input: { project: string; branch: string; sha?: string; remote?: string; repo?: string; note?: string; ttl_s?: number; as?: string; session?: string;
    subject?: string; replace?: number }):
    { id: number; expires_at: number; replaced?: number } | { landed: LandingRow; sha: string } {
    const subscriber = addr(this.seat(agentId, input.project, input.as, input.session));
    // Refused rather than cut: the note is an instruction to the subscriber's later self.
    if (input.note !== undefined && input.note.length > MAX_NOTE) {
      throw new AxosError(`the note is ${input.note.length} characters; at most ${MAX_NOTE}. Keep the instruction, or point to a file that holds it`);
    }
    const w = landingTarget(input, true);
    const subject = input.subject?.trim() ? oneLine(input.subject, 200) : null;
    if (subject && w.sha) throw new AxosError("subject picks among the landings on a branch; with sha you wait for one commit already: leave one out");
    if (input.replace !== undefined) this.ownSubscription(agentId, input.project, input.replace, input.as, input.session);
    if (w.sha) {
      const l = this.findLanding(input.project, w);
      if (l) return { landed: l, sha: l.matched };
    }
    const open = (this.db.query("SELECT COUNT(*) AS n FROM subscriptions WHERE subscriber = ? AND ended_at IS NULL").get(subscriber) as { n: number }).n;
    if (open >= MAX_OPEN_SUBSCRIPTIONS) throw new AxosError(`${open} subscriptions are open for this mailbox; unsubscribe from some first`);
    const ttl = Math.min(Math.max(input.ttl_s ?? 86_400, 60), MAX_SUBSCRIPTION_TTL_S);
    const t = this.now();
    const note = input.note === undefined ? "" : oneLine(input.note, MAX_NOTE);
    const id = this.db.transaction(() => {
      const res = this.db.query(
        "INSERT INTO subscriptions (project, subscriber, repo, remote, branch, sha, note, subject_filter, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(input.project, subscriber, w.repo, w.remote, w.branch, w.sha, note, subject, t, t + ttl * 1000);
      if (input.replace !== undefined) this.db.query("UPDATE subscriptions SET ended_at = ?, end_reason = 'replaced' WHERE id = ?").run(t, input.replace);
      return Number(res.lastInsertRowid);
    })();
    this.event(subscriber, "subscription.opened", input.project, { id, branch: w.branch, sha: w.sha, ...(input.replace !== undefined ? { replaced: input.replace } : {}) });
    return { id, expires_at: t + ttl * 1000, ...(input.replace !== undefined ? { replaced: input.replace } : {}) };
  }

  // Its subscriber may end it: the session or the agent behind it (also from a later session), or the role's holder.
  private ownSubscription(agentId: string, project: string, id: number, as?: string, session?: string): SubscriptionRow {
    this.requireScope(agentId, project, session);
    const s = this.db.query("SELECT * FROM subscriptions WHERE id = ? AND project = ? AND ended_at IS NULL").get(id, project) as SubscriptionRow | null;
    const mine = s && (this.mailboxes({ id: agentId, session }, project, as).map((b) => this.boxKey(b)).includes(s.subscriber) ||
      (!s.subscriber.startsWith("role:") && holderOf(s.subscriber).split("#")[0] === agentId));
    if (!mine) throw new AxosError(`you have no open subscription ${id} in '${project}'`);
    return s;
  }

  cancelSubscription(agentId: string, project: string, id: number, as?: string, session?: string): void {
    this.ownSubscription(agentId, project, id, as, session);
    this.db.query("UPDATE subscriptions SET ended_at = ?, end_reason = 'cancelled' WHERE id = ?").run(this.now(), id);
    this.event(session ? `session:${session}` : `agent:${agentId}`, "subscription.cancelled", project, { id });
  }

  subscriptions(project: string): SubscriptionRow[] {
    this.sweep();
    return this.db.query("SELECT * FROM subscriptions WHERE project = ? AND ended_at IS NULL ORDER BY id").all(project) as SubscriptionRow[];
  }

  // The landing script (or the admin, for a hook on the git server) reports what it put on a branch: the new head and
  // the commits it brought. Every open subscription that matches is told; one for a commit ends with that.
  reportLanding(reporter: { agentId: string; session?: string } | "admin", input: { project: string; repo: string; remote?: string; branch: string; head: string; commits?: string[]; subject?: string }):
    { id: number; told: number; commits: number } {
    if (reporter !== "admin") this.requireScope(reporter.agentId, input.project, reporter.session);
    const w = landingTarget({ ...input, sha: undefined });
    if (!w.repo) throw new AxosError("repo is required: the repository's name, e.g. the last part of its remote URL");
    const head = input.head.toLowerCase();
    if (!SHA_RE.test(head)) throw new AxosError("head must be a commit sha (7 to 64 hex characters)");
    const commits = [...new Set([head, ...(input.commits ?? []).map((c) => c.toLowerCase())])];
    if (commits.length > MAX_LANDING_COMMITS) throw new AxosError(`at most ${MAX_LANDING_COMMITS} commits per landing`);
    const bad = commits.find((c) => !SHA_RE.test(c));
    if (bad !== undefined) throw new AxosError(`'${oneLine(bad, 70)}' is not a commit sha (7 to 64 hex characters)`);
    const subject = input.subject === undefined ? "" : oneLine(input.subject, 200);
    const by = reporter === "admin" ? "admin" : reporter.session ? `session:${reporter.session}` : `agent:${reporter.agentId}`;
    const t = this.now();
    this.sweep();
    const landing = this.db.transaction(() => {
      const res = this.db.query("INSERT INTO landings (project, repo, remote, branch, head, subject, reporter, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(input.project, w.repo, w.remote, w.branch, head, subject, by, t);
      const lid = Number(res.lastInsertRowid);
      const add = this.db.query("INSERT INTO landing_commits (landing, sha) VALUES (?, ?)");
      for (const c of commits) add.run(lid, c);
      return this.db.query("SELECT * FROM landings WHERE id = ?").get(lid) as LandingRow;
    })();
    let told = 0;
    const due = new Map<string, { s: SubscriptionRow; matched: string | null }[]>();
    const subs = this.db.query(
      `SELECT * FROM subscriptions WHERE project = ? AND ? GLOB branch AND ended_at IS NULL
         AND (remote IS NULL OR ? IS NULL OR remote = ?) AND (repo IS NULL OR repo = ?) ORDER BY id`,
    ).all(input.project, w.branch, w.remote, w.remote, w.repo) as SubscriptionRow[];
    for (const s of subs) {
      const matched = s.sha === null ? null : commits.find((c) => c.startsWith(s.sha!) || s.sha!.startsWith(c));
      if (matched === undefined) continue;
      if (s.subject_filter && !subject.toLowerCase().includes(s.subject_filter.toLowerCase())) continue;
      // A branch watched on any remote hears of a head once, not once per remote it is pushed to.
      if (matched === null && s.remote === null && this.db.query(
        "SELECT 1 FROM landings WHERE project = ? AND repo = ? AND branch = ? AND head = ? AND id <> ? AND at >= ? LIMIT 1",
      ).get(input.project, w.repo, w.branch, head, landing.id, s.created_at)) continue;
      if (matched !== null) this.db.query("UPDATE subscriptions SET ended_at = ?, end_reason = 'landed' WHERE id = ?").run(t, s.id);
      due.set(s.subscriber, [...(due.get(s.subscriber) ?? []), { s, matched }]);
    }
    // One message per mailbox and landing, however many of its subscriptions it met.
    for (const hits of due.values()) {
      this.tellLanded(hits, landing);
      told++;
    }
    this.event(by, "landing.reported", input.project, { id: landing.id, repo: w.repo, branch: w.branch, head, commits: commits.length, told });
    return { id: landing.id, told, commits: commits.length };
  }

  // The most recent landing (kept 30 days) that put the commit on the branch.
  private findLanding(project: string, w: { repo: string | null; remote: string | null; branch: string; sha: string | null }): (LandingRow & { matched: string }) | null {
    return this.db.query(
      `SELECT l.*, c.sha AS matched FROM landings l JOIN landing_commits c ON c.landing = l.id
       WHERE l.project = ? AND l.branch GLOB ? AND (? IS NULL OR l.remote IS NULL OR l.remote = ?) AND (? IS NULL OR l.repo = ?)
         AND (c.sha LIKE ? || '%' OR ? LIKE c.sha || '%')
       ORDER BY l.id DESC LIMIT 1`,
    ).get(project, w.branch, w.remote, w.remote, w.repo, w.repo, w.sha, w.sha) as (LandingRow & { matched: string }) | null;
  }

  private tellLanded(hits: { s: SubscriptionRow; matched: string | null }[], l: LandingRow): void {
    const s = hits[0]!.s;
    const matched = hits.find((h) => h.matched)?.matched ?? null;
    const what = matched ? `${matched.slice(0, 10)} is on ${where(l)}` : `${where(l)} moved to ${l.head.slice(0, 10)}`;
    const notes = hits.filter((h) => h.s.note);
    // The subject is the reporter's text, possibly another person's agent's: quoted, never the hub's own words.
    const summary = oneLine(`Landed: ${what}${l.subject ? `: "${l.subject}"` : ""}`, MAX_SUMMARY);
    const body = [
      hits.length === 1 && s.note ? `Your note: ${s.note}` : notes.map((h) => `Your note (subscription ${h.s.id}): ${h.s.note}`).join("\n"),
      `repo ${l.repo}, branch ${l.remote ? `${l.remote}/` : ""}${l.branch}`,
      ...hits.filter((h) => h.matched).map((h) => `commit ${h.matched}`).filter((c, i, all) => all.indexOf(c) === i),
      `head ${l.head}${l.subject ? ` "${l.subject}"` : ""}`,
      `reported by ${l.reporter === "admin" ? "the hub's admin" : this.label(l.reporter)} at ${when(l.at)}`,
      ...hits.map((h) => `subscription ${h.s.id}: ${h.s.sha ? "done" : `open until ${when(h.s.expires_at)}`}`),
    ].filter(Boolean).join("\n");
    this.systemMessage(s.project, this.liveBox(s.subscriber), "note", summary, body);
  }

  // ---------------------------------------------------------------- asks to humans

  askHuman(agentId: string, input: { project: string; human: string; question: string; options?: string[]; default_answer?: string; deadline_s?: number; remind_s?: number; summary?: string; as?: string; session?: string; images?: string[] }):
    { ask_id: number; message_id: number; pushed: boolean } {
    const asker = this.seat(agentId, input.project, input.as, input.session);
    if (!this.humanInProject(input.human, input.project)) throw new AxosError(`human '${input.human}' is not in project '${input.project}'`);
    const images = this.unclaimedImages(agentId, input.images ?? []);
    const options = input.options ?? [];
    if (input.default_answer !== undefined && options.length && !options.includes(input.default_answer)) {
      throw new AxosError("default_answer must be one of options");
    }
    if (input.deadline_s && input.default_answer === undefined) {
      throw new AxosError("a deadline needs a default_answer: it is what applies when nobody answers in time");
    }
    const summary = (input.summary ?? input.question).trim().slice(0, MAX_SUMMARY);
    const body = [input.question, options.length ? `\nOptions:\n${options.map((o) => `- ${o}`).join("\n")}` : "",
      input.default_answer !== undefined ? `\nDefault if unanswered: ${input.default_answer}` : "",
      images.length ? `\nImages on the page: ${images.map((i) => `${i.name} (${kb(i.size)})`).join(", ")}` : ""].join("");
    const deadline = input.deadline_s ? this.now() + input.deadline_s * 1000 : null;
    const remind = input.remind_s ? this.now() + input.remind_s * 1000 : null;
    if (remind && deadline && remind >= deadline) throw new AxosError("the reminder would come after the deadline; leave it out or make it sooner");
    const sent = this.send({ kind: "agent", id: agentId, human: "", as: input.as, session: input.session }, {
      project: input.project, to: [`human:${input.human}`], type: "ask", summary, body, priority: "high", no_push: true,
    });
    const res = this.db.query(
      `INSERT INTO asks (project, asker, human, question, options_json, default_answer, deadline, remind_at, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.project, asker, input.human, input.question, JSON.stringify(options), input.default_answer ?? null, deadline, remind, sent.id);
    const askId = Number(res.lastInsertRowid);
    for (const i of images) this.db.query("UPDATE attachments SET ask_id = ? WHERE id = ?").run(askId, i.id);
    const topic = this.ntfyTopic(input.human);
    this.pushAsk(askId, false);
    return { ask_id: askId, message_id: sent.id, pushed: !!topic };
  }

  // The question on the phone, with up to three options as buttons; a reminder is the same push again, replacing it.
  private pushAsk(askId: number, reminder: boolean): void {
    const a = this.db.query("SELECT * FROM asks WHERE id = ?").get(askId) as AskRow;
    const options = JSON.parse(a.options_json) as string[];
    const images = this.askImages(askId).length;
    const summary = this.getMessage(a.message_id)?.summary ?? a.question;
    const link = this.publicUrl ? `${this.publicUrl}/a/${askId}/${this.askSignature(askId)}` : "";
    const actions: PushAction[] = link ? options.slice(0, 3).map((o) => ({ label: o.slice(0, 40), url: link, body: o })) : [];
    const tail = (options.length > 3 ? `\n(${options.length - 3} more options on the page)` : "") +
      (images ? `\n(${images === 1 ? "an image" : `${images} images`} on the page)` : "") +
      (a.default_answer !== null && a.deadline ? `\n(default "${a.default_answer}", chosen by the agent, at ${when(a.deadline)})` : "");
    const title = `${reminder ? "Reminder: " : ""}${this.senderTitle(addr(a.asker))} (${this.projectName(a.project)})`;
    void this.pushToHuman(a.human, title, `${summary}${tail}`, `#m${a.message_id}`, actions, { sequence: askSequence(askId) }).then((ok) => {
      if (ok && !reminder) this.db.query("UPDATE asks SET pushed_at = ? WHERE id = ? AND pushed_at IS NULL").run(this.now(), askId);
    });
  }

  // The asked human's page showed the question: the asker can tell it was seen.
  asksSeen(human: string, ids: number[]): void {
    const t = this.now();
    for (const id of ids) this.db.query("UPDATE asks SET seen_at = ? WHERE id = ? AND human = ? AND seen_at IS NULL").run(t, id, human);
  }

  // An asker's own questions, newest first, with how far each got.
  asksOf(askers: string[], limit = 20): (AskRow & { created_at: number })[] {
    if (!askers.length) return [];
    this.sweep();
    return this.db.query(`SELECT a.*, m.created_at FROM asks a JOIN messages m ON m.id = a.message_id
      WHERE a.asker IN (${askers.map(() => "?").join(", ")}) ORDER BY a.answer IS NOT NULL, a.id DESC LIMIT ?`).all(...askers, limit) as (AskRow & { created_at: number })[];
  }

  // Stored verbatim. Only the asked human answers.
  answerAsk(human: string, askId: number, answer: string): { message_id: number } {
    const ask = this.db.query("SELECT * FROM asks WHERE id = ?").get(askId) as AskRow | null;
    if (!ask) throw new AxosError(`no ask ${askId}`);
    if (ask.human !== human) throw new AxosError(`ask ${askId} was put to ${ask.human}, not ${human}`);
    if (ask.answer !== null) throw new AxosError(`ask ${askId} was already answered by ${ask.answered_by}`);
    if (!answer.trim()) throw new AxosError("answer is empty");
    const t = this.now();
    this.db.query("UPDATE asks SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?").run(answer, `human:${human}`, t, askId);
    this.ack(`human:${human}`, [ask.message_id]);
    const sent = this.send({ kind: "human", name: human }, {
      project: ask.project, to: [this.liveBox(addr(ask.asker))], type: "answer",
      summary: `${human} answered: ${answer.trim().split("\n")[0]!.slice(0, 200)}`, body: answer, re: ask.message_id, priority: "high",
    });
    this.event(`human:${human}`, "ask.answered", ask.project, { ask: askId });
    this.settledOnPhone(ask, `Answered: ${answer.trim().split("\n")[0]!.slice(0, 80)}`, `Sent to ${this.senderTitle(addr(ask.asker))}.`, sent.id);
    return { message_id: sent.id };
  }

  asks(filter: { human?: string; asker?: string; open?: boolean }): AskRow[] {
    this.sweep();
    const where: string[] = [];
    const args: string[] = [];
    if (filter.human) { where.push("human = ?"); args.push(filter.human); }
    if (filter.asker) { where.push("asker = ?"); args.push(filter.asker); }
    if (filter.open) where.push("answer IS NULL");
    return this.db.query(`SELECT * FROM asks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT 100`).all(...args) as AskRow[];
  }

  // An image for a question, uploaded before the question is put. Only raster formats a browser shows without running
  // anything; the type is read from the bytes, never from the name.
  attach(agentId: string, name: string, data: Uint8Array): { id: number; name: string; mime: string; size: number } {
    const mime = imageType(data);
    if (!mime) throw new AxosError("only PNG, JPEG, GIF and WebP images can be attached");
    if (data.length > MAX_IMAGE) throw new AxosError(`the image is ${kb(data.length)}; the limit is ${kb(MAX_IMAGE)}`);
    const t = this.now();
    const waiting = (this.db.query("SELECT COUNT(*) AS n FROM attachments WHERE agent_id = ? AND ask_id IS NULL AND created_at >= ?")
      .get(agentId, t - UNCLAIMED_KEPT_MS) as { n: number }).n;
    if (waiting >= MAX_UNCLAIMED) throw new AxosError(`${waiting} uploaded images wait for a question already; put them on one or wait an hour`);
    const clean = (name.split(/[\\/]/).pop() ?? "").replace(/[^\w.\- ]/g, "_").slice(0, 80) || "image";
    const res = this.db.query("INSERT INTO attachments (agent_id, name, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(agentId, clean, mime, data.length, data, t);
    this.event(agentId, "attachment.uploaded", null, { id: Number(res.lastInsertRowid), size: data.length });
    return { id: Number(res.lastInsertRowid), name: clean, mime, size: data.length };
  }

  private unclaimedImages(agentId: string, refs: string[]): { id: number; name: string; size: number }[] {
    if (refs.length > MAX_IMAGES) throw new AxosError(`at most ${MAX_IMAGES} images per question`);
    return refs.map((ref) => {
      const m = /^att:(\d+)$/.exec(ref.trim());
      if (!m) throw new AxosError(`images takes uploaded images (att:<id>), not '${ref}': the AXOS plugin uploads files named by path; other clients POST them to /api/attach`);
      const row = this.db.query("SELECT id, name, size FROM attachments WHERE id = ? AND agent_id = ? AND ask_id IS NULL")
        .get(Number(m[1]), agentId) as { id: number; name: string; size: number } | null;
      if (!row) throw new AxosError(`no image ${ref} of yours waits for a question (each goes on one question, within an hour of its upload)`);
      return row;
    });
  }

  askImages(askId: number): { id: number; name: string; mime: string; size: number }[] {
    return this.db.query("SELECT id, name, mime, size FROM attachments WHERE ask_id = ? ORDER BY id").all(askId) as { id: number; name: string; mime: string; size: number }[];
  }

  // An image for the page of the human the question was put to; nobody else.
  imageForHuman(human: string, id: number): { mime: string; data: Uint8Array } | null {
    return this.db.query(`SELECT a.mime, a.data FROM attachments a JOIN asks q ON q.id = a.ask_id WHERE a.id = ? AND q.human = ?`)
      .get(id, human) as { mime: string; data: Uint8Array } | null;
  }

  private ntfyTopic(human: string): string | null {
    return (this.db.query("SELECT ntfy_topic FROM humans WHERE name = ?").get(human) as { ntfy_topic: string | null } | null)?.ntfy_topic ?? null;
  }

  private async pushToHuman(human: string, title: string, body: string, anchor: string, actions?: PushAction[],
    opts: { sequence?: string; priority?: "low" | "high" } = {}): Promise<boolean> {
    const topic = this.ntfyTopic(human);
    if (!topic) return false;
    try {
      await this.notifier.push(topic, {
        title, body, clickUrl: this.publicUrl ? `${this.publicUrl}/ui${anchor}` : undefined, priority: opts.priority ?? "high", actions, sequence: opts.sequence,
      });
      this.event("axos", "push.sent", null, { human });
      return true;
    } catch (e) {
      this.event("axos", "push.failed", null, { human, error: String(e) });
      return false;
    }
  }

  // A settled question replaces its notification on the phone: the buttons go, and the person sees that it went through.
  private settledOnPhone(ask: AskRow, title: string, body: string, messageId: number): void {
    const question = this.getMessage(ask.message_id)?.summary ?? ask.question;
    void this.pushToHuman(ask.human, title, `${body}\n${question}`, `#m${messageId}`, [], { sequence: askSequence(ask.id), priority: "low" });
  }

  // ---------------------------------------------------------------- housekeeping

  sweep(): void {
    if (!this.sweeps) return;
    const t = this.now();
    for (const x of this.db.query("SELECT key FROM sessions WHERE ended_at IS NULL AND kind = 'session' AND last_seen < ?").all(t - SESSION_LIVE_MS) as { key: string }[]) {
      this.endSession(x.key, "silent for 7 days");
    }
    for (const x of this.db.query("SELECT key FROM sessions WHERE ended_at IS NULL AND kind = 'script' AND last_seen < ?").all(t - SCRIPT_KEPT_MS) as { key: string }[]) {
      this.endSession(x.key, "unused for 30 days");
    }
    // A role held by a session goes with the session. One held by a session-less client is freed when that client has
    // been gone as long as a session may be silent.
    for (const r of this.db.query("SELECT r.project, r.role, r.holder FROM roles r JOIN agents a ON a.id = r.holder WHERE a.last_seen < ?")
      .all(t - SESSION_LIVE_MS) as { project: string; role: string; holder: string }[]) {
      this.db.query("UPDATE roles SET holder = NULL, since = NULL WHERE project = ? AND role = ?").run(r.project, r.role);
      this.event("axos", "role.released", r.project, { role: r.role, holder: r.holder, reason: "holder gone for 7 days" });
    }
    for (const l of this.db.query("SELECT * FROM leases WHERE ended_at IS NULL AND expires_at < ?").all(t) as LeaseRow[]) {
      this.endLease(l, "expired");
    }
    // Mail nobody will read: a session that ended a week ago, or an agent that has not connected for a week (or ever)
    // while the message aged that long. The delivery closes with the outcome 'expired', which the sender sees in the
    // thread's receipts; nothing is deleted, and presence stops counting it as "to handle".
    const gone = t - SESSION_LIVE_MS;
    const expired = this.db.query(
      `UPDATE deliveries SET acked_at = ?1, outcome = 'expired', note = 'no reader for 7 days: the session ended'
        WHERE acked_at IS NULL AND recipient IN (SELECT 'session:' || key FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?2)`,
    ).run(t, gone).changes + this.db.query(
      `UPDATE deliveries SET acked_at = ?1, outcome = 'expired', note = 'no reader for 7 days: the agent has not connected'
        WHERE acked_at IS NULL AND message_id IN (SELECT id FROM messages WHERE created_at < ?2)
          AND recipient IN (SELECT 'agent:' || id FROM agents WHERE last_seen IS NULL OR last_seen < ?2)`,
    ).run(t, gone).changes;
    if (expired) this.event("axos", "delivery.expired", null, { n: expired });
    for (const x of this.db.query("SELECT * FROM subscriptions WHERE ended_at IS NULL AND expires_at < ?").all(t) as SubscriptionRow[]) {
      this.db.query("UPDATE subscriptions SET ended_at = ?, end_reason = 'expired' WHERE id = ?").run(t, x.id);
      const span = x.expires_at - x.created_at;
      const after = span >= 3_600_000 ? `${Math.round(span / 3_600_000)} h` : `${Math.round(span / 60_000)} min`;
      this.systemMessage(x.project, this.liveBox(x.subscriber), "status",
        x.sha ? `Not landed: ${x.sha.slice(0, 10)} did not reach ${where(x)} within ${after}; subscription ${x.id} has ended`
          : `Subscription ${x.id} to every landing on ${where(x)} has ended after ${after}; subscribe again to keep watching`,
        x.note ? `Your note: ${x.note}` : "");
    }
    this.db.query("DELETE FROM landings WHERE at < ?").run(t - LANDINGS_KEPT_MS);
    this.db.query("DELETE FROM attachments WHERE created_at < ? OR (ask_id IS NULL AND created_at < ?)").run(t - IMAGES_KEPT_MS, t - UNCLAIMED_KEPT_MS);
    for (const a of this.db.query("SELECT * FROM asks WHERE answer IS NULL AND deadline IS NOT NULL AND deadline < ? AND default_answer IS NOT NULL").all(t) as AskRow[]) {
      this.db.query("UPDATE asks SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?").run(a.default_answer, "default (deadline passed)", t, a.id);
      this.ack(`human:${a.human}`, [a.message_id]);
      this.systemMessage(a.project, this.liveBox(addr(a.asker)), "answer", `No answer from ${a.human} by the deadline; the default applies: ${a.default_answer}`,
        `Question: ${a.question}`, "high", a.message_id);
      this.event("axos", "ask.defaulted", a.project, { ask: a.id });
      this.settledOnPhone(a, `Not answered in time: ${a.default_answer}`, `The default went to ${this.senderTitle(addr(a.asker))}.`, a.message_id);
    }
    for (const a of this.db.query("SELECT id FROM asks WHERE answer IS NULL AND remind_at < ? AND reminded_at IS NULL").all(t) as { id: number }[]) {
      this.db.query("UPDATE asks SET reminded_at = ? WHERE id = ?").run(t, a.id);
      this.pushAsk(a.id, true);
      this.event("axos", "ask.reminded", null, { ask: a.id });
    }
    // A question without a deadline never settles by itself: after a few days its asker hears that it is still open.
    for (const a of this.db.query(`SELECT a.* FROM asks a JOIN messages m ON m.id = a.message_id
      WHERE a.answer IS NULL AND a.deadline IS NULL AND a.stale_at IS NULL AND m.created_at < ?`).all(t - ASK_STALE_MS) as AskRow[]) {
      this.db.query("UPDATE asks SET stale_at = ? WHERE id = ?").run(t, a.id);
      this.systemMessage(a.project, this.liveBox(addr(a.asker)), "note",
        `Ask ${a.id} to ${a.human} has had no answer for ${Math.round(ASK_STALE_MS / 86_400_000)} days; it stays open`,
        `Question: ${a.question}\n${a.seen_at ? `${a.human} saw it on their page at ${when(a.seen_at)}.` : `${a.human} has not opened it on their page.`} ` +
        "Ask again in other words, decide without it if you can, or tell your human.", "low", a.message_id);
      this.event("axos", "ask.stale", a.project, { ask: a.id });
    }
    // A settled question's "Answered" notice stays on the phone for a day, then goes.
    for (const a of this.db.query("SELECT id, human FROM asks WHERE answered_at < ? AND phone_cleared_at IS NULL").all(t - ANSWERED_ON_PHONE_MS) as { id: number; human: string }[]) {
      this.db.query("UPDATE asks SET phone_cleared_at = ? WHERE id = ?").run(t, a.id);
      const topic = this.ntfyTopic(a.human);
      if (topic) {
        this.notifier.remove(topic, askSequence(a.id)).catch((e) => this.event("axos", "push.remove_failed", null, { human: a.human, error: String(e) }));
      }
    }
  }

  // ---------------------------------------------------------------- health

  // The product's own measure: did messages reach a reader, and where does mail wait with nobody to read it. The owner
  // reads it (`axos health`), every brief cites it, and the owner's tick wakes a session on it. Window: since `since`.
  health(since: number) {
    // A read: no sweep here. The admin CLI has no phone notifier, and a sweep there would mark a reminder as sent
    // without pushing it (architecture review 2026-10-30-b, finding 4).
    const t = this.now();
    const all = <T>(sql: string, ...args: (string | number)[]) => this.db.query(sql).all(...args) as T[];
    const one = <T>(sql: string, ...args: (string | number)[]) => this.db.query(sql).get(...args) as T;
    const kinds = ["session", "agent", "role", "human"] as const;
    type Reach = { n: number; within_10m: number; within_1h: number; shown: number; handled: number; expired: number };
    const delivered = kinds.map((kind) => ({ kind, ...one<Reach>(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(d.shown_at IS NOT NULL AND d.shown_at - m.created_at <= 600000), 0) AS within_10m,
              COALESCE(SUM(d.shown_at IS NOT NULL AND d.shown_at - m.created_at <= 3600000), 0) AS within_1h,
              COALESCE(SUM(d.shown_at IS NOT NULL), 0) AS shown,
              COALESCE(SUM(d.acked_at IS NOT NULL AND COALESCE(d.outcome, '') <> 'expired'), 0) AS handled,
              COALESCE(SUM(COALESCE(d.outcome, '') = 'expired'), 0) AS expired
         FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE m.created_at >= ? AND d.recipient LIKE ?`, since, `${kind}:%`) }));
    const open = kinds.map((kind) => ({ kind, ...one<{ n: number; oldest: number | null }>(
      `SELECT COUNT(*) AS n, MIN(m.created_at) AS oldest FROM deliveries d JOIN messages m ON m.id = d.message_id
        WHERE d.acked_at IS NULL AND d.recipient LIKE ?`, `${kind}:%`) }));
    // Live sessions that have had mail they were not shown for over an hour: the hooks or the channel are not reaching them.
    const stuck_sessions = all<{ key: string; name: string | null; project: string; wakes: number | null; n: number; oldest: number }>(
      `SELECT s.key, s.name, s.project, s.wakes, COUNT(*) AS n, MIN(m.created_at) AS oldest FROM deliveries d
         JOIN messages m ON m.id = d.message_id JOIN sessions s ON 'session:' || s.key = d.recipient
        WHERE d.acked_at IS NULL AND d.shown_at IS NULL AND s.ended_at IS NULL AND m.created_at < ? GROUP BY s.key ORDER BY oldest`, t - 3_600_000)
      .map((s) => ({ ...s, label: this.label(`session:${s.key}`) }));
    // Agents' mailboxes with mail and no reader lately (the mail expires after a week).
    const unread_agents = all<{ id: string; human: string; name: string; last_seen: number | null; n: number; oldest: number }>(
      `SELECT a.id, a.human, a.name, a.last_seen, COUNT(*) AS n, MIN(m.created_at) AS oldest FROM deliveries d
         JOIN messages m ON m.id = d.message_id JOIN agents a ON 'agent:' || a.id = d.recipient
        WHERE d.acked_at IS NULL AND (a.last_seen IS NULL OR a.last_seen < ?) GROUP BY a.id ORDER BY n DESC`, t - SESSION_LIVE_MS);
    // Roles with mail whose holder is nobody or away.
    const unread_roles = all<{ project: string; role: string; holder: string | null; n: number; oldest: number }>(
      `SELECT r.project, r.role, r.holder, COUNT(*) AS n, MIN(m.created_at) AS oldest FROM roles r
         JOIN deliveries d ON d.recipient = 'role:' || r.project || '/' || r.role JOIN messages m ON m.id = d.message_id
        WHERE d.acked_at IS NULL GROUP BY r.project, r.role ORDER BY oldest`)
      .filter((r) => !r.holder || !this.isOnline(r.holder))
      .map((r) => ({ ...r, state: r.holder ? `held by ${this.label(r.holder)}, ${this.whereabouts(r.holder)}` : "held by nobody" }));
    // Humans with high-priority mail unhandled on their page for over a day.
    const unread_humans = all<{ human: string; n: number; oldest: number }>(
      `SELECT substr(d.recipient, 7) AS human, COUNT(*) AS n, MIN(m.created_at) AS oldest FROM deliveries d JOIN messages m ON m.id = d.message_id
        WHERE d.recipient LIKE 'human:%' AND d.acked_at IS NULL AND m.priority = 'high' AND m.created_at < ? GROUP BY 1`, t - 86_400_000);
    const count = (kind: string) => one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE kind = ? AND at >= ?", kind, since).n;
    const names = (kind: string, field: string) => all<{ data_json: string }>("SELECT data_json FROM events WHERE kind = ? AND at >= ?", kind, since)
      .map((e) => String((JSON.parse(e.data_json) as Record<string, unknown>)[field] ?? "")).filter(Boolean);
    return {
      version: VERSION, now: t, since,
      messages: one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?", since).n,
      delivered, open, stuck_sessions, unread_agents, unread_roles, unread_humans,
      pushes: { sent: count("push.sent"), failed: count("push.failed") },
      expired_since: count("delivery.expired") ? one<{ n: number }>("SELECT COALESCE(SUM(json_extract(data_json, '$.n')), 0) AS n FROM events WHERE kind = 'delivery.expired' AND at >= ?", since).n : 0,
      new: { humans: names("human.added", "name").length ? names("human.added", "name") : all<{ actor: string }>("SELECT actor FROM events WHERE kind = 'human.added' AND at >= ?", since).map((e) => e.actor.replace(/^human:/, "")),
             projects: [...names("project.added", "project"), ...names("project.created", "project")], agents: names("agent.added", "label") },
      live_sessions: one<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL AND kind = 'session' AND last_seen > ?", t - SESSION_LIVE_MS).n,
      // Every held seat and whether its holder is reachable now: the owner's tick does not start when the owner's seat is held by a live session.
      seats: all<{ project: string; role: string; holder: string }>("SELECT project, role, holder FROM roles WHERE holder IS NOT NULL ORDER BY project, role")
        .map((r) => ({ ...r, label: this.label(r.holder), online: this.isOnline(r.holder) })),
    };
  }

  // ---------------------------------------------------------------- audit

  event(actor: string, kind: string, project: string | null, data: Record<string, unknown>): void {
    this.db.query("INSERT INTO events (at, actor, kind, project, data_json) VALUES (?, ?, ?, ?, ?)").run(this.now(), actor, kind, project, JSON.stringify(data));
  }

  events(sinceId = 0, limit = 1000) {
    return this.db.query("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?").all(sinceId, limit) as
      { id: number; at: number; actor: string; kind: string; project: string | null; data_json: string }[];
  }
}

// A subscription's or landing's place, validated: names as git allows them, a sha as hex.
// pattern: the branch may hold * (a subscription's); a reported landing names one branch.
function landingTarget(input: { repo?: string; remote?: string; branch: string; sha?: string }, pattern = false): { repo: string | null; remote: string | null; branch: string; sha: string | null } {
  const name = (what: string, v: string | undefined, star = false): string | null => {
    if (v === undefined || v === "") return null;
    if (!REF_RE.test(star ? v.replaceAll("*", "x") : v)) {
      throw new AxosError(`${what} '${oneLine(v, 60)}' is not a name git would allow (letters, digits, . _ - / @ +${star ? ", and * for any characters" : ""})`);
    }
    return v;
  };
  const branch = name("branch", input.branch, pattern);
  if (!branch) throw new AxosError("branch is required");
  const sha = input.sha === undefined || input.sha === "" ? null : input.sha.toLowerCase();
  if (sha !== null && !SHA_RE.test(sha)) throw new AxosError("sha must be a commit sha, at least its first 7 hex characters");
  return { repo: name("repo", input.repo), remote: name("remote", input.remote), branch, sha };
}

// 'gitlab/staging (shop)'
function where(x: { repo: string | null; remote: string | null; branch: string }): string {
  return `${x.remote ? `${x.remote}/` : ""}${x.branch}${x.repo ? ` (${x.repo})` : ""}`;
}

function compatible(live: { mode: string }[], mode: string): boolean {
  return live.length === 0 || (mode === "shared" && live.every((l) => l.mode === "shared"));
}

// One question's notification on the phone; later pushes with this id replace it.
function askSequence(askId: number): string {
  return `axos-ask-${askId}`;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// A time in text for people and models: the hub's zone (AXOS_TZ, else the system's), to the minute, zone named.
const ZONE = process.env.AXOS_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
export function when(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" })
    .formatToParts(new Date(ms));
  const g = (k: string) => parts.find((x) => x.type === k)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")} ${g("timeZoneName")}`;
}

function kb(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

// The image formats a page shows, by their magic bytes.
export function imageType(b: Uint8Array): string | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}
