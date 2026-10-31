// The hub's page API (src/ui.ts): one state document, three actions. The login cookie rides along on its own.

export interface Ask {
  id: number; message_id: number; from: string; project: string; question: string; options: string[];
  default_answer: string | null; deadline: number | null; created_at: number | null; images: { id: number; name: string }[];
}
export interface InboxMessage {
  id: number; from: string; sender_human: string | null; project: string; type: string; priority: string;
  created_at: number; summary: string; body: string; re: number | null; quotes_human: string | null; // quotes_human: the sender says the body is this human's typed words
}
export interface SentMessage { id: number; from: string; readers: string[]; project: string; created_at: number; summary: string; body: string; quotes_human: string | null }
export interface Session {
  label: string; name: string | null; human: string; profile: string | null; online: boolean; bell: boolean;
  unread: number; unseen: number; roles: string[]; last_seen: number | null; // unread: not acked; unseen: not read yet
}
export interface Project {
  // pair: the project of exactly two people, shown under People
  id: string; pair: boolean; brief: string; humans: string[]; links: string[]; sessions: Session[];
  roles: { role: string; description: string; holder: string | null; unread: number; unseen: number }[];
  leases: { resource: string; holder: string; until: number; note: string }[];
}
// push: the hub's key this browser subscribes with (null: the hub cannot push) and the devices registered so far.
export interface Person { name: string; pair: string | null }
export interface Invite { id: number; name: string; created_at: number; expires_at: number; used_at: number | null }
export interface Me { operator: boolean; logins: { id: number; label: string; created_at: number; last_seen: number | null }[] }
export interface State { human: string; me: Me; people: Person[]; invites: Invite[]; push: { key: string | null; devices: { label: string; created_at: number; last_ok: number | null }[] }; now: number; types: string[]; asks: Ask[]; inbox: InboxMessage[]; sent: SentMessage[]; projects: Project[] }

export class NotLoggedIn extends Error {}

export async function loadState(): Promise<State> {
  const res = await fetch("/ui/api/state", { cache: "no-store" });
  if (res.status === 401) throw new NotLoggedIn();
  if (!res.ok) throw new Error(`the hub answered ${res.status}`);
  return res.json();
}

export async function post(action: "answer" | "ack" | "send" | "push/subscribe" | "push/unsubscribe" | "invite" | "invite/withdraw" | "login-link" | "login/remove" | "logout-all", body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`/ui/api/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(out.error ?? `the hub answered ${res.status}`);
  return out;
}

export function ago(ms: number | null, now: number): string {
  if (ms === null) return "never";
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// "shop-c5 (alice/laptop#eb28dfa6, work)" → name "shop-c5", detail "alice/laptop#eb28dfa6, work".
export function splitLabel(label: string): { name: string; detail: string | null } {
  const m = /^(.*?) \((.*)\)$/.exec(label);
  return m ? { name: m[1]!, detail: m[2]! } : { name: label, detail: null };
}
