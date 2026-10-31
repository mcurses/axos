import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ago, post, type State } from "@/lib/api";
import { UserIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

// People: who this person shares a project with, the invites they made (a link shown once), and their own devices.
export function People({ state, onChange }: { state: State; onChange: () => void }) {
  const [name, setName] = useState("");
  const [shown, setShown] = useState<{ id: number; link: string } | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try { await f(); onChange(); } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast.success("Copied."), () => toast.error("Could not copy; select it by hand."));

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>People</CardTitle>
          <CardDescription>Those you share a project with. Your sessions reach them from any folder: "tell {state.people[0]?.name ?? "them"} …".</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {state.people.length === 0 && <p className="text-muted-foreground text-sm">Nobody yet.</p>}
          <ul className="flex flex-wrap gap-2">
            {state.people.map((p) => <li key={p.name}><Badge variant="secondary" className="rounded-full"><UserIcon />{p.name}</Badge></li>)}
          </ul>
          {state.me.operator && (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return;
              void run(async () => { const r = await post("invite", { name: name.trim() }) as { id: number; link: string }; setShown(r); setName(""); }); }}>
              <input className="flex-1 rounded-md border bg-background px-3 py-2 text-sm" placeholder="name of the person to invite (lowercase)" value={name} onChange={(e) => setName(e.target.value)} />
              <Button type="submit" size="sm" disabled={busy}>Invite someone</Button>
            </form>
          )}
          {shown && (
            <div className="rounded-md border p-3 text-sm">
              <p className="mb-1">Send this link to them in a chat you already use. It works once and lives a week; it is shown here once.</p>
              <div className="flex items-center gap-2"><code className="break-all">{shown.link}</code><Button size="sm" variant="outline" onClick={() => copy(shown.link)}>Copy</Button></div>
            </div>
          )}
          {state.invites.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm">
              {state.invites.map((i) => (
                <li key={i.id} className="flex items-center gap-2">
                  <span>{i.name}: {i.used_at ? `joined ${ago(i.used_at, state.now)}` : i.expires_at <= state.now ? "link expired" : `invited ${ago(i.created_at, state.now)}, not joined yet`}</span>
                  {!i.used_at && i.expires_at > state.now && <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => { await post("invite/withdraw", { id: i.id }); })}>Withdraw</Button>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Your devices</CardTitle>
          <CardDescription>Each device logs in once with a link made here, and can be signed out here. No key to copy.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => { const r = await post("login-link", {}) as { link: string }; setDevice(r.link); })}>Log in another device</Button>
            {device && <span className="text-muted-foreground">Open this on the other device within ten minutes; it works once.</span>}
          </div>
          {device && <div className="flex items-center gap-2"><code className="break-all">{device}</code><Button size="sm" variant="outline" onClick={() => copy(device)}>Copy</Button></div>}
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (password.length < 10) { toast.error("At least 10 characters."); return; }
            void run(async () => { await post("password", { password, current }); setPassword(""); setCurrent(""); toast.success("Password set. Keep it in your password manager."); }); }}>
            {state.me.password && <input className="flex-1 rounded-md border bg-background px-3 py-2 text-sm" type="password" autoComplete="current-password" placeholder="current password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
            <input className="flex-1 rounded-md border bg-background px-3 py-2 text-sm" type="password" name="new-password" autoComplete="new-password" placeholder={state.me.password ? "new password" : "set a password (for logging in with no link at hand)"} value={password} onChange={(e) => setPassword(e.target.value)} />
            <Button type="submit" size="sm" variant="outline" disabled={busy}>{state.me.password ? "Change" : "Set password"}</Button>
          </form>
          <p className="text-muted-foreground">{state.me.password ? "A password is set: name and password log any device in. Changing it needs the current one; \"sign out every device\" clears it." : "No password yet; links are the only way in."}</p>
          {state.me.logins.length > 0 && (
            <ul className="flex flex-col gap-1">
              {state.me.logins.map((l) => (
                <li key={l.id} className="flex items-center gap-2">
                  <span>{l.label || "a device"} · logged in {ago(l.created_at, state.now)}{l.last_seen ? `, seen ${ago(l.last_seen, state.now)}` : ""}</span>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => { await post("login/remove", { id: l.id }); })}>{l.id === 0 ? "End the page key" : "Sign out"}</Button>
                </li>
              ))}
            </ul>
          )}
          {state.push.devices.length > 0 && <p className="text-muted-foreground">Pushes go to: {state.push.devices.map((d) => d.label || "a device").join(", ")}. Signing a device out ends its pushes.</p>}
          {state.me.logins.length > 0 && (
            <div><Button size="sm" variant="destructive" disabled={busy} onClick={() => run(async () => { await post("logout-all", {}); location.reload(); })}>Sign out every device</Button>
              <span className="ml-2 text-muted-foreground">Lost a phone or a laptop: everything out, pushes off; this device logs in again through a link.</span></div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
