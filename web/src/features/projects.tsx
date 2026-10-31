import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ago, post, splitLabel, type Project } from "@/lib/api";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { BellIcon, LinkIcon, UserIcon } from "lucide-react";

export function Dot({ on }: { on: boolean }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", on ? "bg-emerald-500" : "bg-muted-foreground/40")} />;
}

export function ProjectCard({ p, now, me, people = [], operator = false, onChange }: { p: Project; now: number; me: string; people?: string[]; operator?: boolean; onChange?: () => void }) {
  const mine = p.owner === me;
  const [busy, setBusy] = useState(false);
  const act = async (action: Parameters<typeof post>[0], body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try { await post(action, body); toast.success(done); onChange?.(); } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const others = people.filter((h) => !p.humans.includes(h));
  // An invite that carries this project, for someone not here yet: the link is shown once, here.
  const [invite, setInvite] = useState<{ name: string; link: string } | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast.success("Copied."), () => toast.error("Could not copy; select it by hand."));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{p.id}</CardTitle>
        {p.brief && <CardDescription className="whitespace-pre-wrap">{p.brief}</CardDescription>}
        {/* Where the code is: one git address; the owner edits it, members and an invite's page read it. */}
        {repo === null
          ? <CardDescription className="text-xs">{p.repo ? <>Code: <code>{p.repo}</code></> : mine ? "No code address yet" : null}{mine && <button className="ml-2 underline opacity-60 hover:opacity-100" disabled={busy} onClick={() => setRepo(p.repo)}>{p.repo ? "change" : "set"}</button>}</CardDescription>
          : <form className="flex gap-2 pt-1" onSubmit={(e) => { e.preventDefault(); void act("project/repo", { project: p.id, repo }, repo ? "Code address set." : "Code address cleared.").then(() => setRepo(null)); }}>
              <input className="flex-1 rounded-md border bg-background px-2 py-1 text-xs" placeholder="git address of the code, e.g. git@github.com:you/repo.git" value={repo} onChange={(e) => setRepo(e.target.value)} />
              <Button type="submit" size="sm" variant="outline" disabled={busy}>Save</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setRepo(null)}>Cancel</Button>
            </form>}
        <div className="flex flex-wrap items-center gap-1 pt-1">
          {p.humans.filter((h) => h !== me).map((h) => (
            <Badge key={h} variant="secondary" className="rounded-full"><UserIcon />{h}
              {mine && <button className="ml-1 opacity-60 hover:opacity-100" title={`remove ${h}`} disabled={busy} onClick={() => act("project/remove", { project: p.id, human: h }, `${h} removed.`)}>×</button>}
            </Badge>
          ))}
          {p.links.map((l) => (
            <Badge key={l} variant="outline"><LinkIcon /> {l}
              {mine && <button className="ml-1 opacity-60 hover:opacity-100" title={`unlink ${l}`} disabled={busy} onClick={() => act("project/unlink", { project: p.id, other: l }, `Unlinked from ${l}.`)}>×</button>}
            </Badge>
          ))}
        </div>
        {/* Share with a person you already know (they accept on their page), or with someone new (an invite link that
            carries this project: they are in it when they join). Link with a project of a person you know. Only the owner. */}
        <div className="flex flex-wrap gap-2 pt-2 text-xs">
          {mine && (
            <select className="rounded-md border bg-background px-2 py-1" disabled={busy} value="" onChange={(e) => { const h = e.target.value; if (h === "__new") setNewName(""); else if (h) void act("project/share", { project: p.id, human: h }, `${h} is asked to join; they see it on their page and phone.`); }}>
              <option value="">Share with…</option>
              {others.map((h) => <option key={h} value={h}>{h}</option>)}
              {operator && <option value="__new">someone new…</option>}
            </select>
          )}
          {mine && people.length > 0 && (
            <select className="rounded-md border bg-background px-2 py-1" disabled={busy} value="" onChange={(e) => { const h = e.target.value; if (h) void act("project/link", { project: p.id, human: h }, `${h} is asked to link one of their projects; they pick which.`); }}>
              <option value="">Link with a project of…</option>
              {people.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          )}
          {!mine && <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("project/leave", { project: p.id }, `You left ${p.id}.`)}>Leave</Button>}
        </div>
        {newName !== null && (
          <form className="flex gap-2 pt-2" onSubmit={(e) => { e.preventDefault(); const name = newName.trim().toLowerCase(); if (!name) return;
            void (async () => { setBusy(true); try { const r = await post("invite", { name, project: p.id }) as { link: string }; setInvite({ name, link: r.link }); setNewName(null); onChange?.(); } catch (err) { toast.error(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); } })(); }}>
            <input className="flex-1 rounded-md border bg-background px-3 py-1 text-sm" autoFocus placeholder="name of the person (lowercase)" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <Button type="submit" size="sm" disabled={busy}>Make the invite</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setNewName(null)}>Cancel</Button>
          </form>
        )}
        {invite && (
          <div className="mt-2 rounded-md border p-3 text-sm">
            <p className="mb-1">Send this link to {invite.name} in a chat you already use. It says you invited them to work on {p.id}{p.repo ? " and where the code is" : ""}; it works once, lives a week, and is shown here once.</p>
            <div className="flex items-center gap-2"><code className="break-all">{invite.link}</code><Button size="sm" variant="outline" onClick={() => copy(invite.link)}>Copy</Button></div>
          </div>
        )}
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-3">
        <section>
          <h3 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">Sessions</h3>
          <ul className="flex flex-col gap-1.5 text-sm">
            {p.sessions.map((s) => {
              const { name, detail } = splitLabel(s.label);
              return (
                <li key={s.label} className="flex items-start gap-2">
                  <Dot on={s.online} />
                  <div className="min-w-0 -mt-1">
                    <div className="flex items-center gap-1">
                      <span className="truncate">{name}</span>
                      {s.bell && <BellIcon className="size-3 text-muted-foreground" aria-label="wakes on messages" />}
                      {s.unread > 0 && <Badge variant="secondary" className="h-4 px-1 text-[10px]" title={`${s.unread} to handle, ${s.unseen} not read yet`}>{s.unread}</Badge>}
                    </div>
                    <div className="truncate text-muted-foreground text-xs">
                      {[detail, `seen ${ago(s.last_seen, now)}`, s.roles.join(", ")].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                </li>
              );
            })}
            {!p.sessions.length && <li className="text-muted-foreground">Nobody is live.</li>}
          </ul>
        </section>
        <section>
          <h3 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">Roles</h3>
          <ul className="flex flex-col gap-1.5 text-sm">
            {p.roles.map((r) => (
              <li key={r.role} title={r.description}>
                <span className="font-medium">{r.role}</span>{" "}
                <span className="text-muted-foreground">{r.holder ? splitLabel(r.holder).name : "vacant"}</span>
                {r.unread > 0 && <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">{r.unread} to handle{r.unseen ? `, ${r.unseen} not read` : ""}</Badge>}
              </li>
            ))}
            {!p.roles.length && <li className="text-muted-foreground">None.</li>}
          </ul>
        </section>
        <section>
          <h3 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">Leases</h3>
          <ul className="flex flex-col gap-1.5 text-sm">
            {p.leases.map((l) => (
              <li key={l.resource + l.holder}>
                <span className="font-medium">{l.resource}</span>{" "}
                <span className="text-muted-foreground">{splitLabel(l.holder).name}, until {new Date(l.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{l.note ? ` — ${l.note}` : ""}</span>
              </li>
            ))}
            {!p.leases.length && <li className="text-muted-foreground">None.</li>}
          </ul>
        </section>
      </CardContent>
    </Card>
  );
}

// A project made on the page: the folder is linked afterwards, on the machine, with the one line shown.
export function NewProject({ onChange }: { onChange: () => void }) {
  const [name, setName] = useState("");
  const [made, setMade] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return;
        post("project/new", { name: name.trim() }).then((r) => { setMade((r as { name: string }).name); setName(""); onChange(); }, (err) => toast.error(err instanceof Error ? err.message : String(err))); }}>
        <input className="flex-1 rounded-md border bg-background px-3 py-2 text-sm" placeholder="new project (lowercase, e.g. the repo's name)" value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" size="sm" variant="outline">New project</Button>
      </form>
      {made && <p className="text-muted-foreground text-sm">Made. In the repo's folder, once: <code>axos link {made}</code>, or say to Claude Code there "connect this folder to AXOS as {made}".</p>}
    </div>
  );
}

// Share and link requests from people you know, answered here like a question.
export function PendingRequests({ pending, projects, onChange }: { pending: { id: number; kind: "share" | "link"; from: string; project: string; created_at: number }[]; projects: Project[]; onChange: () => void }) {
  const [pick, setPick] = useState<Record<number, string>>({});
  const own = projects.filter((p) => !p.pair);
  const decide = (id: number, accept: boolean, project?: string) =>
    post("invite/decide", { id, accept, project }).then(onChange, (e) => toast.error(e instanceof Error ? e.message : String(e)));
  if (!pending.length) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">Requests from people you know <span className="text-muted-foreground">({pending.length})</span></h2>
      {pending.map((r) => (
        <Card key={r.id} id={`invite-${r.id}`} className="border-l-4 border-l-primary">
          <CardContent className="flex flex-wrap items-center gap-2 pt-4 text-sm">
            {r.kind === "share"
              ? <><span><b>{r.from}</b> wants to share <b>{r.project}</b> with you.</span>
                  <Button size="sm" onClick={() => decide(r.id, true)}>Join</Button><Button size="sm" variant="ghost" onClick={() => decide(r.id, false)}>Not now</Button></>
              : <><span><b>{r.from}</b> wants to link <b>{r.project}</b> with one of your projects.</span>
                  <select className="rounded-md border bg-background px-2 py-1" value={pick[r.id] ?? ""} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })}>
                    <option value="">pick yours…</option>
                    {own.filter((p) => p.owner !== r.from).map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
                  </select>
                  <Button size="sm" disabled={!pick[r.id]} onClick={() => decide(r.id, true, pick[r.id])}>Link</Button><Button size="sm" variant="ghost" onClick={() => decide(r.id, false)}>No</Button></>}
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
