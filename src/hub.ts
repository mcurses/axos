import type { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { newId } from "./db.ts";
import { findSecret } from "./secrets.ts";
import { nullNotifier, type Notifier, type PushAction } from "./notify.ts";

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
export type Actor = { kind: "agent"; id: string; human: string; as?: string; session?: string } | { kind: "human"; name: string };

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
}

export interface AgentRow {
  id: string;
  human: string;
  name: string;
  revoked: number;
  created_at: number;
  last_seen: number | null;
}

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
  roleTtlS?: number;
  linkSecret?: string; // signs answer links; kept out of the database (and its backups) when given
  sendsPerMinute?: number;
  onlineWindowS?: number;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const MAX_SUMMARY = 300;
const MAX_BODY = 64_000;
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

const SESSION_LIVE_MS = 24 * 3600_000;

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
  private roleTtlMs: number;
  private sendsPerMinute: number;
  private onlineWindowMs: number;
  private listeners = new Map<string, Set<(e: HubEvent) => void>>();
  private streams = new Map<string, number>();
  private sendLog = new Map<string, number[]>();
  private linkSecret: string;

  constructor(readonly db: Database, opts: HubOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.notifier = opts.notifier ?? nullNotifier;
    this.publicUrl = (opts.publicUrl ?? "").replace(/\/$/, "");
    this.roleTtlMs = (opts.roleTtlS ?? 7200) * 1000;
    this.sendsPerMinute = opts.sendsPerMinute ?? 60;
    this.onlineWindowMs = (opts.onlineWindowS ?? 600) * 1000;
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
        this.db.query("UPDATE roles SET holder = NULL, since = NULL, expires_at = NULL WHERE project = ? AND holder = ?").run(project, h.h);
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
      this.db.query("UPDATE roles SET holder = NULL, since = NULL, expires_at = NULL WHERE project = ? AND role = ?").run(role.project, role.role);
    }
    for (const l of this.db.query("SELECT * FROM leases WHERE holder = ? AND ended_at IS NULL").all(agentId) as LeaseRow[]) {
      this.endLease(l, "revoked");
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

  // Any activity keeps the agent's roles alive.
  touch(agentId: string): void {
    const t = this.now();
    this.db.query("UPDATE agents SET last_seen = ? WHERE id = ?").run(t, agentId);
    this.db.query("UPDATE roles SET expires_at = ? WHERE holder = ?").run(t + this.roleTtlMs, agentId);
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
    const prev = this.db.query("SELECT key, ended_at FROM sessions WHERE key = ?").get(key) as { key: string; ended_at: number | null } | null;
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
    this.db.query("UPDATE roles SET expires_at = ? WHERE holder = ?").run(t + this.roleTtlMs, key);
    return key;
  }

  session(key: string): SessionRow | null {
    return this.db.query("SELECT * FROM sessions WHERE key = ?").get(key) as SessionRow | null;
  }

  // A session that ends gives up its roles and leases; the role's mailbox stays with the role.
  endSession(key: string, reason = "ended"): void {
    const r = this.db.query("UPDATE sessions SET ended_at = ? WHERE key = ? AND ended_at IS NULL").run(this.now(), key);
    if (!r.changes) return;
    for (const role of this.db.query("SELECT project, role FROM roles WHERE holder = ?").all(key) as { project: string; role: string }[]) {
      this.db.query("UPDATE roles SET holder = NULL, since = NULL, expires_at = NULL WHERE project = ? AND role = ?").run(role.project, role.role);
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

  liveSessions(project: string): SessionRow[] {
    return this.db.query("SELECT * FROM sessions WHERE project = ? AND ended_at IS NULL AND last_seen > ? ORDER BY last_seen DESC")
      .all(project, this.now() - SESSION_LIVE_MS) as SessionRow[];
  }

  // Who a session or agent is, for humans and models: 'shop-5c (alice/mac#35dabd9e, work)'.
  label(holder: string): string {
    const key = holderOf(holder);
    if (!key.includes("#")) return key;
    const s = this.session(key);
    return s?.name ? `${s.name} (${key}${s.profile ? `, ${s.profile}` : ""})` : key;
  }

  streamOpened(agentId: string): void {
    this.streams.set(agentId, (this.streams.get(agentId) ?? 0) + 1);
    this.touch(agentId);
  }

  streamClosed(agentId: string): void {
    const n = (this.streams.get(agentId) ?? 1) - 1;
    if (n <= 0) this.streams.delete(agentId);
    else this.streams.set(agentId, n);
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
        bell: this.streams.has(s.key), online: this.streams.has(s.key) || t - s.last_seen < this.onlineWindowMs,
        unread: this.unreadCount(`session:${s.key}`), roles: rolesOf(s.key),
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
        bell: this.streams.has(r.id), online: this.streams.has(r.id) || (r.last_seen !== null && t - r.last_seen < this.onlineWindowMs),
        unread: this.unreadCount(`agent:${r.id}`), roles: rolesOf(r.id),
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
    return this.db.query("SELECT role, description, holder, since, expires_at FROM roles WHERE project = ? ORDER BY role").all(project) as {
      role: string; description: string; holder: string | null; since: number | null; expires_at: number | null;
    }[];
  }

  // A role is held until released, until its holder is silent for the role TTL, or until a forced takeover.
  // A forced takeover needs a reason (the human's words); it is logged verbatim and the displaced holder is told.
  claimRole(agentId: string, project: string, role: string, force?: string, session?: string): { took_over_from: string | null } {
    this.requireScope(agentId, project, session);
    checkName("role", role);
    this.sweep();
    if (!this.db.query("SELECT 1 FROM roles WHERE project = ? AND role = ?").get(project, role)) {
      const known = this.roles(project).map((r) => r.role).join(", ") || "none";
      throw new AxosError(`no role '${role}' in '${project}' (known: ${known}); define_role creates one`);
    }
    const me = session ?? agentId;
    const row = this.db.query("SELECT holder, since, expires_at FROM roles WHERE project = ? AND role = ?").get(project, role) as
      { holder: string | null; since: number | null; expires_at: number | null } | null;
    const prev = row?.holder ?? null;
    if (prev && prev !== me && this.humanOfHolder(prev) !== this.humanOfHolder(me)) {
      throw new AxosError(`role '${role}' is held by a session of ${this.humanOfHolder(prev)}; only they can release it (or it frees itself when that session ends)`);
    }
    if (prev && prev !== me && !force?.trim()) {
      throw new AxosError(
        `role '${role}' is held by ${prev} (live until ${iso(row!.expires_at!)} unless it stays active); ` +
          `a takeover needs force set to the human's words authorising it`,
      );
    }
    const t = this.now();
    this.db.transaction(() => {
      this.db.query(
        `INSERT INTO roles (project, role, holder, since, expires_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project, role) DO UPDATE SET holder = excluded.holder, since = excluded.since, expires_at = excluded.expires_at`,
      ).run(project, role, me, prev === me ? row!.since : t, t + this.roleTtlMs);
    })();
    if (prev && prev !== me) {
      this.event(addr(me), "role.taken_over", project, { role, from: prev, force });
      this.systemMessage(project, addr(prev), "status", `You no longer hold the role '${role}': ${this.label(me)} took it over.`,
        `Reason given: ${force}\nThe role's mailbox, leases and open questions stay with the role.`, "high");
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
    if (row.holder !== me) {
      throw new AxosError(`you do not hold the role '${role}' in '${project}'${row.holder ? ` (${row.holder} does)` : ""}; claim_role it first`);
    }
    return `role:${project}/${role}`;
  }

  roleUnread(project: string, role: string): number {
    return this.unreadCount(`role:${project}/${role}`);
  }

  rolesHeldBy(sender: string, project: string): string[] {
    if (!sender.startsWith("agent:") && !sender.startsWith("session:")) return [];
    return (this.db.query("SELECT role FROM roles WHERE project = ? AND holder = ? ORDER BY role").all(project, holderOf(sender)) as { role: string }[]).map((r) => r.role);
  }

  // Every mailbox an actor reads: its session, the roles the session holds (in projects it is still in), and the agent's shared one.
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
    boxes.push(`agent:${actor.id}`);
    return boxes;
  }

  releaseRole(agentId: string, project: string, role: string, session?: string): void {
    const me = session ?? agentId;
    const r = this.db.query("UPDATE roles SET holder = NULL, since = NULL, expires_at = NULL WHERE project = ? AND role = ? AND holder = ?")
      .run(project, role, me);
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
    // Every live session, and every member agent that has none (it reads its own mailbox when it next connects).
    if (a === "project" || a.startsWith("project:")) {
      const p = a === "project" ? project : this.reach(project, a.slice(8), a);
      const live = this.liveSessions(p);
      const withSessions = new Set(live.map((x) => x.agent_id));
      return [
        ...live.map((x) => `session:${x.key}`),
        ...this.projectAgents(p).filter((id) => !withSessions.has(id)).map((id) => `agent:${id}`),
      ].map((recipient) => ({ recipient, via: `project:${p}` })).filter((r) => r.recipient !== sender);
    }
    if (a.startsWith("session:")) {
      // A key as people see it ('alice/mac#1e03fd48') or as stored ('agt_…#1e03fd48'); otherwise a session's name.
      let ref = a.slice(8);
      const k = /^(.+)#([0-9a-z]{8})$/.exec(ref);
      if (k) ref = `${this.agentId(k[1]!) ?? k[1]}#${k[2]}`;
      // The message's own project first; a linked project's session only when none here matches.
      let live = this.liveSessions(project);
      if (!live.some((x) => x.key === ref || x.name === ref)) {
        const there = this.linkedProjects(project).flatMap((p) => this.liveSessions(p)).filter((x) => x.key === ref || x.name === ref);
        if (there.length) live = there;
      }
      let hit = live.filter((x) => x.key === ref || x.name === ref);
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
  }): { id: number; duplicate: boolean; delivered_to: string[]; waiting_for_role: string[] } {
    this.requireActorInProject(actor, input.project);
    const sender = actor.kind === "agent" ? addr(this.seat(actor.id, input.project, actor.as, actor.session)) : `human:${actor.name}`;
    if (!MESSAGE_TYPES.includes(input.type)) throw new AxosError(`type must be one of ${MESSAGE_TYPES.join(", ")}`);
    const summary = input.summary.trim();
    const body = input.body ?? "";
    if (!summary) throw new AxosError("summary is required: one sentence saying what this means, readable without knowing any ids");
    if (summary.length > MAX_SUMMARY) throw new AxosError(`summary is ${summary.length} characters; keep it under ${MAX_SUMMARY} and put detail in body`);
    if (body.length > MAX_BODY) throw new AxosError(`body is ${body.length} characters; the limit is ${MAX_BODY}, link to a git file instead`);
    const secret = findSecret(`${summary}\n${body}`);
    if (secret) throw new AxosError(`message rejected: it looks like it contains a ${secret}. Never send secrets through AXOS.`);

    if (input.dedupe_key) {
      const dup = this.db.query("SELECT id FROM messages WHERE sender = ? AND dedupe_key = ?").get(sender, input.dedupe_key) as { id: number } | null;
      if (dup) return { id: dup.id, duplicate: true, delivered_to: [], waiting_for_role: [] };
    }
    if (actor.kind === "agent") this.rateLimit(actor.id);

    // A conversation may run across a link: a reply goes into the parent's thread, if the sender saw the parent.
    const inScope = (id: number): boolean => {
      const m = this.db.query("SELECT project FROM messages WHERE id = ?").get(id) as { project: string } | null;
      if (!m) return false;
      if (m.project === input.project) return true;
      if (!this.linkedProjects(input.project).includes(m.project)) return false;
      const boxes = actor.kind === "agent" ? [sender, ...this.mailboxes(actor)] : [sender];
      const inList = boxes.map(() => "?").join(", ");
      return !!this.db.query(
        `SELECT 1 FROM messages m WHERE (m.id = ? OR m.thread = ?) AND (m.sender IN (${inList})
           OR EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.recipient IN (${inList}))) LIMIT 1`,
      ).get(id, id, ...boxes, ...boxes);
    };
    let thread = input.thread ?? null;
    const recipients = new Map<string, string>();
    if (input.re !== undefined) {
      if (!inScope(input.re)) throw new AxosError(`no message ${input.re} in '${input.project}'`);
      const parent = this.db.query("SELECT id, thread, sender FROM messages WHERE id = ?").get(input.re) as { id: number; thread: number | null; sender: string };
      thread ??= parent.thread ?? parent.id;
      // A reply always finds its way back: to the sender's mailbox, even in another project, and to the agent's shared
      // mailbox when the sending session has ended since.
      if (!input.to?.length) {
        if (parent.sender === SYSTEM_SENDER) throw new AxosError("messages from the hub take no reply; say who it is for with to");
        const back = this.liveBox(parent.sender);
        if (back !== sender) recipients.set(back, back);
      }
    }
    if (thread !== null && !inScope(thread)) throw new AxosError(`no thread ${thread} in '${input.project}'`);
    if (!input.to?.length && !recipients.size) throw new AxosError(input.re === undefined ? "to is empty" : "nobody to reply to (that message was yours)");

    for (const addr of input.to ?? []) {
      for (const r of this.resolve(input.project, addr, sender, actor.kind === "agent" ? this.humanOf(actor.id) : actor.name)) {
        const self = r.recipient === sender || (actor.kind === "agent" && r.via.startsWith("project:") &&
          (r.recipient === `agent:${actor.id}` || r.recipient === `session:${actor.session}`));
        if (!self && !recipients.has(r.recipient)) recipients.set(r.recipient, r.via);
      }
    }
    if (!recipients.size) throw new AxosError("nobody to deliver to (the only recipient was yourself)");

    const id = this.db.transaction(() => {
      const res = this.db.query(
        `INSERT INTO messages (project, sender, sender_human, to_json, type, summary, body, thread, re, as_of, priority, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.project, sender, actor.kind === "agent" ? this.humanOf(actor.id) : actor.name, JSON.stringify(input.to ?? [...recipients.keys()]), input.type, summary, body, thread, input.re ?? null,
        input.as_of ?? null, input.priority ?? "normal", input.dedupe_key ?? null, this.now());
      const mid = Number(res.lastInsertRowid);
      for (const [recipient, via] of recipients) {
        this.db.query("INSERT INTO deliveries (message_id, recipient, via) VALUES (?, ?, ?)").run(mid, recipient, via);
      }
      return mid;
    })();
    this.event(actor.kind === "agent" ? (actor.session ? `session:${actor.session}` : `agent:${actor.id}`) : sender, "message.sent", input.project,
      { id, type: input.type, to: [...recipients.keys()], ...(sender.startsWith("role:") ? { as: sender } : {}) });

    const ev: HubEvent = { kind: "message", message_id: id, from: sender, summary, type: input.type, priority: input.priority ?? "normal" };
    for (const recipient of recipients.keys()) {
      this.emit(recipient, ev);
      if (recipient.startsWith("human:") && !input.no_push && (input.priority === "high" || input.type === "ask")) {
        void this.pushToHuman(recipient.slice(6), `${this.senderTitle(sender)} (${this.projectName(input.project)})`, summary, `#m${id}`);
      }
    }
    const vacant = (r: string) => r.startsWith("role:") && !this.roleHolder(r);
    return {
      id,
      duplicate: false,
      delivered_to: [...recipients.keys()].filter((r) => !vacant(r)).map((r) => r.startsWith("role:") ? `${r} (held by ${this.label(this.roleHolder(r)!)})` : r),
      waiting_for_role: [...recipients.keys()].filter(vacant),
    };
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
    const where = [`d.recipient IN (${boxes.map(() => "?").join(", ")})`];
    const args: (string | number)[] = [...boxes];
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
    const boxes = Array.isArray(recipient) ? recipient : [recipient];
    const inList = boxes.map(() => "?").join(", ");
    if (project) {
      return (this.db.query(`SELECT COUNT(*) AS n FROM deliveries d JOIN messages m ON m.id = d.message_id
        WHERE d.recipient IN (${inList}) AND d.acked_at IS NULL AND m.project = ?`).get(...boxes, project) as { n: number }).n;
    }
    return (this.db.query(`SELECT COUNT(*) AS n FROM deliveries WHERE recipient IN (${inList}) AND acked_at IS NULL`).get(...boxes) as { n: number }).n;
  }

  // Messages not yet put into this reader's context (by a hook, inbox or wait); marks them shown. They stay unread until acked.
  takeUnshown(boxes: string[], limit = 10): InboxItem[] {
    const items = this.inbox(boxes, { unshownOnly: true, limit });
    this.markShown(boxes, items.map((m) => m.id));
    return items;
  }

  markShown(boxes: string[], ids: number[]): void {
    const t = this.now();
    const inList = boxes.map(() => "?").join(", ");
    for (const id of ids) this.db.query(`UPDATE deliveries SET shown_at = ? WHERE message_id = ? AND recipient IN (${inList}) AND shown_at IS NULL`).run(t, id, ...boxes);
  }

  unshownCount(boxes: string[]): number {
    const inList = boxes.map(() => "?").join(", ");
    return (this.db.query(`SELECT COUNT(*) AS n FROM deliveries WHERE recipient IN (${inList}) AND acked_at IS NULL AND shown_at IS NULL`).get(...boxes) as { n: number }).n;
  }

  ack(recipient: string | string[], ids: number[]): number {
    const boxes = Array.isArray(recipient) ? recipient : [recipient];
    const inList = boxes.map(() => "?").join(", ");
    let n = 0;
    const t = this.now();
    for (const id of ids) {
      n += this.db.query(`UPDATE deliveries SET acked_at = ? WHERE recipient IN (${inList}) AND message_id = ? AND acked_at IS NULL`).run(t, ...boxes, id).changes;
    }
    if (n) this.event(boxes[0]!, "message.acked", null, { ids });
    return n;
  }

  // The whole thread a message belongs to, if the reader may see that project.
  // The messages of a thread the reader sent or received. A message of another project, or of someone else's
  // conversation, answers exactly like one that does not exist.
  thread(reader: Actor, messageId: number): MessageRow[] {
    const none = new AxosError(`no message ${messageId} for you`);
    const m = this.db.query("SELECT id, project, thread FROM messages WHERE id = ?").get(messageId) as { id: number; project: string; thread: number | null } | null;
    if (!m) throw none;
    const member = [m.project, ...this.linkedProjects(m.project)]
      .some((p) => reader.kind === "agent" ? this.isMember(reader.id, p) : this.humanInProject(reader.name, p));
    if (!member) throw none;
    const boxes = reader.kind === "agent" ? this.mailboxes(reader) : [`human:${reader.name}`];
    const inList = boxes.map(() => "?").join(", ");
    const root = m.thread ?? m.id;
    const rows = this.db.query(
      `SELECT m.* FROM messages m WHERE (m.id = ? OR m.thread = ?)
         AND (m.sender IN (${inList}) OR EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.recipient IN (${inList})))
       ORDER BY m.id`,
    ).all(root, root, ...boxes, ...boxes) as MessageRow[];
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
      if (readers.size) out.push({ ...m, readers: [...readers].sort() });
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
      const offs = boxes.map((b) => this.subscribe(b, (e) => { if (e.kind === "message") done(); }));
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
    this.sweep();
    const mode = input.mode ?? "exclusive";
    const ttl = Math.min(Math.max(input.ttl_s ?? 1800, 30), MAX_LEASE_TTL_S);
    const resource = oneLine(input.resource, 120);
    if (!resource) throw new AxosError("resource is required");
    input = { ...input, note: input.note === undefined ? undefined : oneLine(input.note, 200) };
    const t = this.now();
    const live = this.liveLeases(input.project, resource);
    const holders = live.map((l) => ({ holder: l.holder, mode: l.mode, note: l.note, expires_at: l.expires_at }));

    const own = live.find((l) => l.holder === holder);
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
      let w = queue.find((q) => q.agent_id === holder);
      if (!w) {
        this.db.query("INSERT INTO lease_waiters (project, resource, agent_id, mode, note, ttl_s, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(input.project, resource, holder, mode, input.note ?? "", ttl, t);
        this.event(addr(holder), "lease.queued", input.project, { resource, mode });
      }
      const position = this.waiters(input.project, resource).findIndex((q) => q.agent_id === holder) + 1;
      return { granted: false, position, holders };
    }
    return { granted: false, holders };
  }

  releaseLease(agentId: string, project: string, resource: string, as?: string, session?: string): { released: boolean; left_queue: boolean } {
    const holder = this.seat(agentId, project, as, session);
    const own = this.liveLeases(project, resource).find((l) => l.holder === holder);
    if (own) this.endLease(own, "released");
    const left = this.db.query("UPDATE lease_waiters SET done_at = ? WHERE project = ? AND resource = ? AND agent_id = ? AND done_at IS NULL")
      .run(this.now(), project, resource, holder).changes > 0;
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
  subscribeLanding(agentId: string, input: { project: string; branch: string; sha?: string; remote?: string; repo?: string; note?: string; ttl_s?: number; as?: string; session?: string }):
    { id: number; expires_at: number } | { landed: LandingRow; sha: string } {
    const subscriber = addr(this.seat(agentId, input.project, input.as, input.session));
    const w = landingTarget(input);
    if (w.sha) {
      const l = this.findLanding(input.project, w);
      if (l) return { landed: l, sha: l.matched };
    }
    const open = (this.db.query("SELECT COUNT(*) AS n FROM subscriptions WHERE subscriber = ? AND ended_at IS NULL").get(subscriber) as { n: number }).n;
    if (open >= MAX_OPEN_SUBSCRIPTIONS) throw new AxosError(`${open} subscriptions are open for this mailbox; unsubscribe from some first`);
    const ttl = Math.min(Math.max(input.ttl_s ?? 86_400, 60), MAX_SUBSCRIPTION_TTL_S);
    const t = this.now();
    const note = input.note === undefined ? "" : oneLine(input.note, 300);
    const res = this.db.query(
      "INSERT INTO subscriptions (project, subscriber, repo, remote, branch, sha, note, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(input.project, subscriber, w.repo, w.remote, w.branch, w.sha, note, t, t + ttl * 1000);
    const id = Number(res.lastInsertRowid);
    this.event(subscriber, "subscription.opened", input.project, { id, branch: w.branch, sha: w.sha });
    return { id, expires_at: t + ttl * 1000 };
  }

  cancelSubscription(agentId: string, project: string, id: number, as?: string, session?: string): void {
    this.requireScope(agentId, project, session);
    const s = this.db.query("SELECT * FROM subscriptions WHERE id = ? AND project = ? AND ended_at IS NULL").get(id, project) as SubscriptionRow | null;
    // Its subscriber may cancel it: the session or the agent behind it (also from a later session), or the role's holder.
    const mine = s && (this.mailboxes({ id: agentId, session }, project, as).includes(s.subscriber) ||
      (!s.subscriber.startsWith("role:") && holderOf(s.subscriber).split("#")[0] === agentId));
    if (!mine) throw new AxosError(`you have no open subscription ${id} in '${project}'`);
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
    const subs = this.db.query(
      `SELECT * FROM subscriptions WHERE project = ? AND branch = ? AND ended_at IS NULL
         AND (remote IS NULL OR ? IS NULL OR remote = ?) AND (repo IS NULL OR repo = ?) ORDER BY id`,
    ).all(input.project, w.branch, w.remote, w.remote, w.repo) as SubscriptionRow[];
    for (const s of subs) {
      const matched = s.sha === null ? null : commits.find((c) => c.startsWith(s.sha!) || s.sha!.startsWith(c));
      if (matched === undefined) continue;
      // A branch watched on any remote hears of a head once, not once per remote it is pushed to.
      if (matched === null && s.remote === null && this.db.query(
        "SELECT 1 FROM landings WHERE project = ? AND repo = ? AND branch = ? AND head = ? AND id <> ? AND at >= ? LIMIT 1",
      ).get(input.project, w.repo, w.branch, head, landing.id, s.created_at)) continue;
      if (matched !== null) this.db.query("UPDATE subscriptions SET ended_at = ?, end_reason = 'landed' WHERE id = ?").run(t, s.id);
      this.tellLanded(s, landing, matched);
      told++;
    }
    this.event(by, "landing.reported", input.project, { id: landing.id, repo: w.repo, branch: w.branch, head, commits: commits.length, told });
    return { id: landing.id, told, commits: commits.length };
  }

  // The most recent landing (kept 30 days) that put the commit on the branch.
  private findLanding(project: string, w: { repo: string | null; remote: string | null; branch: string; sha: string | null }): (LandingRow & { matched: string }) | null {
    return this.db.query(
      `SELECT l.*, c.sha AS matched FROM landings l JOIN landing_commits c ON c.landing = l.id
       WHERE l.project = ? AND l.branch = ? AND (? IS NULL OR l.remote IS NULL OR l.remote = ?) AND (? IS NULL OR l.repo = ?)
         AND (c.sha LIKE ? || '%' OR ? LIKE c.sha || '%')
       ORDER BY l.id DESC LIMIT 1`,
    ).get(project, w.branch, w.remote, w.remote, w.repo, w.repo, w.sha, w.sha) as (LandingRow & { matched: string }) | null;
  }

  private tellLanded(s: SubscriptionRow, l: LandingRow, matched: string | null): void {
    const what = matched ? `${matched.slice(0, 10)} is on ${where(l)}` : `${where(l)} moved to ${l.head.slice(0, 10)}`;
    // The subject is the reporter's text, possibly another person's agent's: quoted, never the hub's own words.
    const summary = oneLine(`Landed: ${what}${l.subject ? `: "${l.subject}"` : ""}`, MAX_SUMMARY);
    const body = [
      s.note ? `Your note: ${s.note}` : "",
      `repo ${l.repo}, branch ${l.remote ? `${l.remote}/` : ""}${l.branch}`,
      matched ? `commit ${matched}` : "",
      `head ${l.head}${l.subject ? ` "${l.subject}"` : ""}`,
      `reported by ${l.reporter === "admin" ? "the hub's admin" : this.label(l.reporter)} at ${iso(l.at)}`,
      `subscription ${s.id}: ${s.sha ? "done" : `open until ${iso(s.expires_at)}`}`,
    ].filter(Boolean).join("\n");
    this.systemMessage(s.project, this.liveBox(s.subscriber), "note", summary, body);
  }

  // ---------------------------------------------------------------- asks to humans

  askHuman(agentId: string, input: { project: string; human: string; question: string; options?: string[]; default_answer?: string; deadline_s?: number; summary?: string; as?: string; session?: string }):
    { ask_id: number; message_id: number; pushed: boolean } {
    const asker = this.seat(agentId, input.project, input.as, input.session);
    if (!this.humanInProject(input.human, input.project)) throw new AxosError(`human '${input.human}' is not in project '${input.project}'`);
    const options = input.options ?? [];
    if (input.default_answer !== undefined && options.length && !options.includes(input.default_answer)) {
      throw new AxosError("default_answer must be one of options");
    }
    if (input.deadline_s && input.default_answer === undefined) {
      throw new AxosError("a deadline needs a default_answer: it is what applies when nobody answers in time");
    }
    const summary = (input.summary ?? input.question).trim().slice(0, MAX_SUMMARY);
    const body = [input.question, options.length ? `\nOptions:\n${options.map((o) => `- ${o}`).join("\n")}` : "",
      input.default_answer !== undefined ? `\nDefault if unanswered: ${input.default_answer}` : ""].join("");
    const sent = this.send({ kind: "agent", id: agentId, human: "", as: input.as, session: input.session }, {
      project: input.project, to: [`human:${input.human}`], type: "ask", summary, body, priority: "high", no_push: true,
    });
    const deadline = input.deadline_s ? this.now() + input.deadline_s * 1000 : null;
    const res = this.db.query(
      `INSERT INTO asks (project, asker, human, question, options_json, default_answer, deadline, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.project, asker, input.human, input.question, JSON.stringify(options), input.default_answer ?? null, deadline, sent.id);
    const askId = Number(res.lastInsertRowid);
    const topic = this.ntfyTopic(input.human);
    const link = this.publicUrl ? `${this.publicUrl}/a/${askId}/${this.askSignature(askId)}` : "";
    const actions: PushAction[] = link ? options.slice(0, 3).map((o) => ({ label: o.slice(0, 40), url: link, body: o })) : [];
    const sender = addr(asker);
    const tail = (options.length > 3 ? `\n(${options.length - 3} more options on the page)` : "") +
      (input.default_answer !== undefined && deadline ? `\n(default "${input.default_answer}", chosen by the agent, at ${iso(deadline)})` : "");
    void this.pushToHuman(input.human, `${this.senderTitle(sender)} (${this.projectName(input.project)})`, `${summary}${tail}`, `#m${sent.id}`, actions);
    return { ask_id: askId, message_id: sent.id, pushed: !!topic };
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
      project: ask.project, to: [addr(ask.asker)], type: "answer",
      summary: `${human} answered: ${answer.trim().split("\n")[0]!.slice(0, 200)}`, body: answer, re: ask.message_id, priority: "high",
    });
    this.event(`human:${human}`, "ask.answered", ask.project, { ask: askId });
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

  private ntfyTopic(human: string): string | null {
    return (this.db.query("SELECT ntfy_topic FROM humans WHERE name = ?").get(human) as { ntfy_topic: string | null } | null)?.ntfy_topic ?? null;
  }

  private async pushToHuman(human: string, title: string, body: string, anchor: string, actions?: PushAction[]): Promise<void> {
    const topic = this.ntfyTopic(human);
    if (!topic) return;
    try {
      await this.notifier.push(topic, { title, body, clickUrl: this.publicUrl ? `${this.publicUrl}/ui${anchor}` : undefined, priority: "high", actions });
      this.event("axos", "push.sent", null, { human });
    } catch (e) {
      this.event("axos", "push.failed", null, { human, error: String(e) });
    }
  }

  // ---------------------------------------------------------------- housekeeping

  sweep(): void {
    const t = this.now();
    for (const x of this.db.query("SELECT key FROM sessions WHERE ended_at IS NULL AND last_seen < ?").all(t - SESSION_LIVE_MS) as { key: string }[]) {
      this.endSession(x.key, "silent for a day");
    }
    for (const r of this.db.query("SELECT project, role, holder FROM roles WHERE holder IS NOT NULL AND expires_at < ?").all(t) as { project: string; role: string; holder: string }[]) {
      this.db.query("UPDATE roles SET holder = NULL, since = NULL, expires_at = NULL WHERE project = ? AND role = ?").run(r.project, r.role);
      this.event("axos", "role.expired", r.project, { role: r.role, holder: r.holder });
      this.systemMessage(r.project, addr(r.holder), "status", `You no longer hold the role '${r.role}': it was silent for ${Math.round(this.roleTtlMs / 60_000)} minutes and freed itself.`,
        "Its mailbox, leases and open questions stay with the role. claim_role takes it again if it is still vacant.", "high");
    }
    for (const l of this.db.query("SELECT * FROM leases WHERE ended_at IS NULL AND expires_at < ?").all(t) as LeaseRow[]) {
      this.endLease(l, "expired");
    }
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
    for (const a of this.db.query("SELECT * FROM asks WHERE answer IS NULL AND deadline IS NOT NULL AND deadline < ? AND default_answer IS NOT NULL").all(t) as AskRow[]) {
      this.db.query("UPDATE asks SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?").run(a.default_answer, "default (deadline passed)", t, a.id);
      this.ack(`human:${a.human}`, [a.message_id]);
      this.systemMessage(a.project, addr(a.asker), "answer", `No answer from ${a.human} by the deadline; the default applies: ${a.default_answer}`,
        `Question: ${a.question}`, "high", a.message_id);
      this.event("axos", "ask.defaulted", a.project, { ask: a.id });
    }
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
function landingTarget(input: { repo?: string; remote?: string; branch: string; sha?: string }): { repo: string | null; remote: string | null; branch: string; sha: string | null } {
  const name = (what: string, v: string | undefined): string | null => {
    if (v === undefined || v === "") return null;
    if (!REF_RE.test(v)) throw new AxosError(`${what} '${oneLine(v, 60)}' is not a name git would allow (letters, digits, . _ - / @ +)`);
    return v;
  };
  const branch = name("branch", input.branch);
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

export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
