import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, lowercase

export function newId(prefix: "prj" | "agt"): string {
  return `${prefix}_${[...randomBytes(10)].map((b) => ID_ALPHABET[b & 31]).join("")}`;
}

// One file, WAL. Every table that matters for audit is append-only or carries timestamps;
// the events table is the log that gets exported back into git.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS humans (
  name          TEXT PRIMARY KEY,
  ntfy_topic    TEXT,
  ui_key_hash   TEXT UNIQUE,
  created_at    INTEGER NOT NULL,
  operator      INTEGER NOT NULL DEFAULT 0,    -- may invite new people onto the hub from the page
  password_hash TEXT                           -- argon2id; the third way in, for a device with no login and no link
);
-- A device's login to the page, made from a one-time login link; the key lives in that device's cookie only.
CREATE TABLE IF NOT EXISTS logins (
  id            INTEGER PRIMARY KEY,
  human         TEXT NOT NULL REFERENCES humans(name),
  key_hash      TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER
);
CREATE TABLE IF NOT EXISTS login_links (     -- one-time, short-lived: opening one logs that device in
  token_hash    TEXT PRIMARY KEY,
  human         TEXT NOT NULL REFERENCES humans(name),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER
);
-- Projects and agents are known by ids that never change; names are labels. A project's name is '<owner>/<slug>',
-- unique per owner, so two people can each have an 'axos'. Stored addresses ('role:<project id>/<role>',
-- 'agent:<agent id>') carry ids, so a rename touches one row.
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,              -- 'prj_' + 10 characters
  owner         TEXT NOT NULL REFERENCES humans(name),
  slug          TEXT NOT NULL,
  brief         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  pair          INTEGER NOT NULL DEFAULT 0,    -- the project of exactly two people, made when one invited the other
  UNIQUE (owner, slug)
);
CREATE TABLE IF NOT EXISTS project_aliases (  -- names a project had before a rename; they keep resolving
  owner         TEXT NOT NULL,
  slug          TEXT NOT NULL,
  project       TEXT NOT NULL REFERENCES projects(id),
  PRIMARY KEY (owner, slug)
);
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,              -- 'agt_' + 10 characters; a revoked agent's id is never reused
  human         TEXT NOT NULL REFERENCES humans(name),
  name          TEXT NOT NULL,                 -- the label is '<human>/<name>', unique among agents not revoked
  token_hash    TEXT NOT NULL UNIQUE,
  revoked       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS agents_label ON agents(human, name) WHERE revoked = 0;
CREATE TABLE IF NOT EXISTS memberships (
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  project       TEXT NOT NULL REFERENCES projects(id),
  PRIMARY KEY (agent_id, project)
);
CREATE TABLE IF NOT EXISTS human_projects (
  human         TEXT NOT NULL REFERENCES humans(name),
  project       TEXT NOT NULL REFERENCES projects(id),
  PRIMARY KEY (human, project)
);
CREATE TABLE IF NOT EXISTS roles (
  project       TEXT NOT NULL REFERENCES projects(id),
  role          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  holder        TEXT,                          -- a session key '<agent id>#<session>' or, from clients without sessions, an agent id
  since         INTEGER,
  expires_at    INTEGER,                       -- unused since 0.17.0 (roles no longer lapse); kept for old rows
  PRIMARY KEY (project, role)
);
CREATE TABLE IF NOT EXISTS sessions (
  key           TEXT PRIMARY KEY,              -- '<agent id>#<first 8 of the Claude Code session id>'
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  client_session TEXT NOT NULL,                -- the full session id the harness gave (CLAUDE_CODE_SESSION_ID)
  project       TEXT,
  name          TEXT,                          -- the harness's session name, e.g. shop-e9
  profile       TEXT,
  cwd           TEXT,
  started_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  ended_at      INTEGER,
  framed_at     INTEGER,                       -- when the full note on how to read messages was first put into its context
  former_names  TEXT NOT NULL DEFAULT '',      -- names it had before (a restart may rename it), one per line, newest last
  kind          TEXT NOT NULL DEFAULT 'session', -- 'script': a named script of the agent (axos send --name), no model behind it
  wakes         INTEGER                        -- what its last event stream said: 1 the host wakes on a ring, 0 it does not, NULL unknown
);
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY,
  project       TEXT NOT NULL REFERENCES projects(id),
  sender        TEXT NOT NULL,                 -- 'session:<key>', 'agent:<id>', 'role:<project id>/<r>', 'human:<name>' or 'axos'
  sender_human  TEXT,                          -- whose agent (or which human) sent it; null for the hub itself
  to_json       TEXT NOT NULL,                 -- the addresses as the sender wrote them
  type          TEXT NOT NULL,
  summary       TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  thread        INTEGER,
  re            INTEGER,
  as_of         TEXT,
  priority      TEXT NOT NULL DEFAULT 'normal',
  dedupe_key    TEXT,
  created_at    INTEGER NOT NULL,
  sent_by       TEXT,                          -- who wrote it when that is not the sender: a script speaking for a role
  quotes_human  TEXT,                          -- the human whose typed words the body holds, as the sender's plugin checked; the message stays the sender's
  UNIQUE (sender, dedupe_key)
);
CREATE TABLE IF NOT EXISTS deliveries (
  message_id    INTEGER NOT NULL REFERENCES messages(id),
  recipient     TEXT NOT NULL,                 -- 'session:<key>', 'agent:<id>', 'human:<name>' or 'role:<project id>/<role>'
  via           TEXT NOT NULL,                 -- the address that matched
  acked_at      INTEGER,
  shown_at      INTEGER,                       -- put into a session's context by a hook
  outcome       TEXT,                          -- what the reader said when acking: done | declined | forwarded | noted; or 'expired', set by the hub
  note          TEXT,                          -- and its one line about it, e.g. 'forwarded to lane 3'
  PRIMARY KEY (message_id, recipient)
);
CREATE INDEX IF NOT EXISTS deliveries_unread ON deliveries(recipient, acked_at);
CREATE TABLE IF NOT EXISTS leases (
  id            INTEGER PRIMARY KEY,
  project       TEXT NOT NULL,
  resource      TEXT NOT NULL,
  holder        TEXT NOT NULL,
  mode          TEXT NOT NULL,                 -- 'exclusive' | 'shared'
  note          TEXT NOT NULL DEFAULT '',
  ttl_s         INTEGER,                       -- what it was granted for; a renewal without ttl_s extends by this
  granted_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  end_reason    TEXT
);
CREATE INDEX IF NOT EXISTS leases_live ON leases(project, resource, ended_at);
CREATE TABLE IF NOT EXISTS lease_waiters (
  id            INTEGER PRIMARY KEY,
  project       TEXT NOT NULL,
  resource      TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  mode          TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  ttl_s         INTEGER NOT NULL,
  queued_at     INTEGER NOT NULL,
  done_at       INTEGER
);
CREATE TABLE IF NOT EXISTS asks (
  id            INTEGER PRIMARY KEY,
  project       TEXT NOT NULL,
  asker         TEXT NOT NULL,                 -- agent id
  human         TEXT NOT NULL,
  question      TEXT NOT NULL,
  options_json  TEXT NOT NULL DEFAULT '[]',
  default_answer TEXT,
  deadline      INTEGER,
  message_id    INTEGER NOT NULL,
  answer        TEXT,
  answered_by   TEXT,
  answered_at   INTEGER,
  phone_cleared_at INTEGER,                    -- its notification deleted from the phone, a day after it was settled
  pushed_at     INTEGER,                       -- the push reached the notification service
  seen_at       INTEGER,                       -- first shown on the asked human's page
  remind_at     INTEGER,                       -- when to push it once more if still open
  reminded_at   INTEGER,
  stale_at      INTEGER                        -- no deadline and no answer for days: the asker was told
);
CREATE TABLE IF NOT EXISTS attachments (     -- images shown with a question on the human's page; kept 30 days
  id            INTEGER PRIMARY KEY,
  agent_id      TEXT NOT NULL,                 -- who uploaded it; only they can put it on an ask
  ask_id        INTEGER,                       -- NULL until an ask takes it; unclaimed ones go after an hour
  name          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  data          BLOB NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_ask ON attachments(ask_id);
CREATE TABLE IF NOT EXISTS project_links (  -- two projects whose sessions may message each other; a < b
  a             TEXT NOT NULL REFERENCES projects(id),
  b             TEXT NOT NULL REFERENCES projects(id),
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE TABLE IF NOT EXISTS invites (     -- one-time links that set up a machine: its agent and token, and a new person
  id            INTEGER PRIMARY KEY,
  code_hash     TEXT NOT NULL UNIQUE,
  human         TEXT NOT NULL,                 -- who the machine belongs to; created on redemption if new
  project       TEXT REFERENCES projects(id),  -- a new person joins it on redemption
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER,
  agent_id      TEXT,                          -- the agent the redemption created
  invited_by    TEXT,                          -- the person who made it on their page; for another person, redemption pairs the two
  new_human     INTEGER                        -- made for a name nobody had: refused if someone has it by redemption
);
-- "Tell me when it lands": a mailbox waiting for a commit to reach a branch, or for every landing there. The hub never
-- sees a repository; the script that lands reports what it pushed, and the hub compares strings.
CREATE TABLE IF NOT EXISTS subscriptions (
  id            INTEGER PRIMARY KEY,
  project       TEXT NOT NULL REFERENCES projects(id),
  subscriber    TEXT NOT NULL,                 -- the mailbox told: 'session:<key>', 'role:<project id>/<role>' or 'agent:<id>'
  repo          TEXT,                          -- null: any repo
  remote        TEXT,                          -- null: any remote
  branch        TEXT NOT NULL,
  sha           TEXT,                          -- a commit (or its first 7+ characters); null: every landing, until it expires
  note          TEXT NOT NULL DEFAULT '',      -- the subscriber's own words, handed back with the message
  subject_filter TEXT,                         -- only landings whose subject contains this (any case); null: all
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  end_reason    TEXT                           -- 'landed' | 'expired' | 'cancelled' | 'replaced'
);
CREATE INDEX IF NOT EXISTS subscriptions_open ON subscriptions(project, branch, ended_at);
CREATE TABLE IF NOT EXISTS landings (
  id            INTEGER PRIMARY KEY,
  project       TEXT NOT NULL REFERENCES projects(id),
  repo          TEXT NOT NULL,
  remote        TEXT,
  branch        TEXT NOT NULL,
  head          TEXT NOT NULL,                 -- the branch's new head
  subject       TEXT NOT NULL DEFAULT '',
  reporter      TEXT NOT NULL,                 -- 'session:<key>', 'agent:<id>' or 'admin'
  at            INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS landing_commits (   -- every commit a landing put on the branch, head included
  landing       INTEGER NOT NULL REFERENCES landings(id) ON DELETE CASCADE,
  sha           TEXT NOT NULL,
  PRIMARY KEY (landing, sha)
);
CREATE INDEX IF NOT EXISTS landing_commits_sha ON landing_commits(sha);
-- A human's devices for the page's own pushes (Web Push subscriptions); the keys are the device's, the endpoint the
-- push service's. A device that answers 404/410 is dropped.
CREATE TABLE IF NOT EXISTS push_devices (
  endpoint      TEXT PRIMARY KEY,
  human         TEXT NOT NULL REFERENCES humans(name),
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  label         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  last_ok       INTEGER,
  login_id      INTEGER                        -- the device's login (logins.id); signing it out ends its pushes too
);
CREATE TABLE IF NOT EXISTS kv (
  k             TEXT PRIMARY KEY,
  v             TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY,
  at            INTEGER NOT NULL,
  actor         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  project       TEXT,
  data_json     TEXT NOT NULL DEFAULT '{}'
);
`;

export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  db.exec(SCHEMA);
  return db;
}

// Databases created before sessions existed: roles.holder lost its agents FK (it now holds session keys),
// roles gained a description, deliveries gained shown_at, messages gained sender_human.
function migrate(db: Database): void {
  const roles = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'roles'").get() as { sql: string } | null;
  if (roles && roles.sql.includes("REFERENCES agents")) {
    db.exec(`PRAGMA foreign_keys = OFF;
      CREATE TABLE roles_new (project TEXT NOT NULL REFERENCES projects(id), role TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        holder TEXT, since INTEGER, expires_at INTEGER, PRIMARY KEY (project, role));
      INSERT INTO roles_new (project, role, holder, since, expires_at) SELECT project, role, holder, since, expires_at FROM roles;
      DROP TABLE roles; ALTER TABLE roles_new RENAME TO roles;
      PRAGMA foreign_keys = ON;`);
  }
  const rolesNow = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'roles'").get() as { sql: string } | null;
  // 0.16.1 remembered the holder a role's silence had freed; roles no longer lapse, so the columns go again.
  if (rolesNow && rolesNow.sql.includes("lapsed_holder")) db.exec("ALTER TABLE roles DROP COLUMN lapsed_holder; ALTER TABLE roles DROP COLUMN lapsed_at;");
  const deliveries = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'").get() as { sql: string } | null;
  if (deliveries && !deliveries.sql.includes("shown_at")) db.exec("ALTER TABLE deliveries ADD COLUMN shown_at INTEGER");
  if (deliveries && !deliveries.sql.includes("outcome")) db.exec("ALTER TABLE deliveries ADD COLUMN outcome TEXT");
  if (deliveries && !/\bnote\b/.test(deliveries.sql)) db.exec("ALTER TABLE deliveries ADD COLUMN note TEXT");
  const messages = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get() as { sql: string } | null;
  if (messages && !messages.sql.includes("sender_human")) db.exec("ALTER TABLE messages ADD COLUMN sender_human TEXT");
  const leases = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'leases'").get() as { sql: string } | null;
  if (leases && !leases.sql.includes("ttl_s")) db.exec("ALTER TABLE leases ADD COLUMN ttl_s INTEGER");
  const sessions = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get() as { sql: string } | null;
  if (sessions && !sessions.sql.includes("framed_at")) db.exec("ALTER TABLE sessions ADD COLUMN framed_at INTEGER");
  if (sessions && !sessions.sql.includes("former_names")) db.exec("ALTER TABLE sessions ADD COLUMN former_names TEXT NOT NULL DEFAULT ''");
  if (sessions && !/\bkind\b/.test(sessions.sql)) db.exec("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'session'");
  if (messages && !messages.sql.includes("sent_by")) db.exec("ALTER TABLE messages ADD COLUMN sent_by TEXT");
  if (messages && !messages.sql.includes("quotes_human")) db.exec("ALTER TABLE messages ADD COLUMN quotes_human TEXT");
  if (sessions && !/\bwakes\b/.test(sessions.sql)) db.exec("ALTER TABLE sessions ADD COLUMN wakes INTEGER");
  const subscriptions = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'subscriptions'").get() as { sql: string } | null;
  if (subscriptions && !subscriptions.sql.includes("subject_filter")) db.exec("ALTER TABLE subscriptions ADD COLUMN subject_filter TEXT");
  const asks = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'asks'").get() as { sql: string } | null;
  for (const col of ["phone_cleared_at", "pushed_at", "seen_at", "remind_at", "reminded_at", "stale_at"]) {
    if (asks && !asks.sql.includes(col)) db.exec(`ALTER TABLE asks ADD COLUMN ${col} INTEGER`);
  }
  migrateToIds(db);
  // After the rebuild above (it copies tables by position): columns added since, on databases that kept their shape.
  const column = (table: string, col: string, ddl: string) => {
    const t = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | null;
    if (t && !t.sql.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  };
  column("humans", "operator", "INTEGER NOT NULL DEFAULT 0");
  column("projects", "pair", "INTEGER NOT NULL DEFAULT 0");
  column("invites", "invited_by", "TEXT");
  column("invites", "new_human", "INTEGER");
  column("push_devices", "login_id", "INTEGER");
  column("humans", "password_hash", "TEXT");
}

// Databases from before ids (2026-10-26) keyed projects and agents by their names, and stored addresses carried the
// names. Every table that refers to either is rebuilt from the current schema, and every stored address is rewritten.
// A project's owner is the first human added to it.
function migrateToIds(db: Database): void {
  const cols = db.query("PRAGMA table_info(projects)").all() as { name: string }[];
  if (!cols.length || cols.some((c) => c.name === "id")) return;
  const projectId = new Map<string, string>();
  const agentId = new Map<string, string>();
  for (const p of db.query("SELECT name FROM projects").all() as { name: string }[]) projectId.set(p.name, newId("prj"));
  for (const a of db.query("SELECT id FROM agents").all() as { id: string }[]) agentId.set(a.id, newId("agt"));
  const P = (p: unknown) => (typeof p === "string" ? projectId.get(p) ?? p : p);
  // A holder key: an agent id, or a session key '<agent>#<id8>'.
  const holder = (h: string) => {
    const i = h.indexOf("#");
    const a = i < 0 ? h : h.slice(0, i);
    return (agentId.get(a) ?? a) + (i < 0 ? "" : h.slice(i));
  };
  const A = (s: unknown): unknown => {
    if (typeof s !== "string") return s;
    if (s.startsWith("role:")) {
      const i = s.indexOf("/");
      return i < 0 ? s : `role:${P(s.slice(5, i))}${s.slice(i)}`;
    }
    if (s.startsWith("project:")) return `project:${P(s.slice(8))}`;
    if (s.startsWith("session:")) return `session:${holder(s.slice(8))}`;
    if (s.startsWith("agent:")) return `agent:${holder(s.slice(6))}`;
    if (s.startsWith("human:") || s === "axos" || s === "admin") return s;
    return holder(s);
  };

  const humans = (db.query("SELECT name FROM humans ORDER BY created_at, name").all() as { name: string }[]).map((h) => h.name);
  const owner = new Map<string, string>();
  for (const e of db.query("SELECT project, data_json FROM events WHERE kind = 'project.human_added' ORDER BY id").all() as { project: string; data_json: string }[]) {
    const h = (JSON.parse(e.data_json) as { human?: string }).human;
    if (h && humans.includes(h) && !owner.has(e.project)) owner.set(e.project, h);
  }
  const ownerOf = (p: string): string => {
    const o = owner.get(p)
      ?? (db.query("SELECT human FROM human_projects WHERE project = ? ORDER BY human LIMIT 1").get(p) as { human: string } | null)?.human
      ?? (db.query("SELECT a.human FROM memberships m JOIN agents a ON a.id = m.agent_id WHERE m.project = ? ORDER BY a.created_at LIMIT 1").get(p) as { human: string } | null)?.human
      ?? humans[0];
    if (!o) throw new Error(`migration: project '${p}' has nobody to own it; add a human first (axos human add) on the old version`);
    return o;
  };

  const tables: Record<string, (r: Record<string, unknown>) => Record<string, unknown>> = {
    projects: (r) => ({ id: P(r.name), owner: ownerOf(r.name as string), slug: r.name, brief: r.brief, created_at: r.created_at, pair: 0 }),
    agents: (r) => ({ ...r, id: holder(r.id as string) }),
    memberships: (r) => ({ agent_id: holder(r.agent_id as string), project: P(r.project) }),
    human_projects: (r) => ({ ...r, project: P(r.project) }),
    roles: (r) => ({ ...r, project: P(r.project), holder: r.holder === null ? null : A(r.holder) }),
    sessions: (r) => ({ ...r, key: holder(r.key as string), agent_id: holder(r.agent_id as string), project: P(r.project) }),
    messages: (r) => ({ ...r, project: P(r.project), sender: A(r.sender) }),
    deliveries: (r) => ({ ...r, recipient: A(r.recipient), via: A(r.via) }),
    leases: (r) => ({ ...r, project: P(r.project), holder: A(r.holder) }),
    lease_waiters: (r) => ({ ...r, project: P(r.project), agent_id: A(r.agent_id) }),
    asks: (r) => ({ ...r, project: P(r.project), asker: A(r.asker) }),
    project_links: (r) => {
      const [a, b] = [P(r.a) as string, P(r.b) as string].sort();
      return { a, b, created_at: r.created_at };
    },
    events: (r) => ({ ...r, project: P(r.project), actor: A(r.actor) }),
  };

  db.exec("PRAGMA foreign_keys = OFF;");
  // Under the write lock, checked again: another process (the hub starting, an admin command) may have converted it.
  db.transaction(() => {
    if ((db.query("PRAGMA table_info(projects)").all() as { name: string }[]).some((c) => c.name === "id")) return;
    for (const [t, fn] of Object.entries(tables)) {
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) continue;
      const ddl = new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(([\\s\\S]*?)\\n\\);`).exec(SCHEMA);
      if (!ddl) throw new Error(`migration: no schema for ${t}`);
      db.exec(`CREATE TABLE ${t}_new (${ddl[1]}\n);`);
      const newCols = (db.query(`PRAGMA table_info(${t}_new)`).all() as { name: string }[]).map((c) => c.name);
      const insert = db.query(`INSERT INTO ${t}_new (${newCols.join(", ")}) VALUES (${newCols.map(() => "?").join(", ")})`);
      for (const row of db.query(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]) {
        const out = fn(row);
        insert.run(...newCols.map((c) => (out[c] ?? null) as string | number | null));
      }
      db.exec(`DROP TABLE ${t}; ALTER TABLE ${t}_new RENAME TO ${t};`);
    }
    const bad = db.query("PRAGMA foreign_key_check").all();
    if (bad.length) throw new Error(`migration: ${bad.length} rows break foreign keys: ${JSON.stringify(bad.slice(0, 3))}`);
  }).immediate();
  db.exec("PRAGMA foreign_keys = ON;");
}
