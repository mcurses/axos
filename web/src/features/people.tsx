import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ago, post, type State } from "@/lib/api";
import { ArrowUpRightIcon, BellIcon, CheckIcon, CopyIcon, KeyRoundIcon, LaptopIcon, PlusIcon, ShieldCheckIcon, SmartphoneIcon, UserPlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { toast } from "sonner";

export function People({ state, onChange }: { state: State; onChange: () => void }) {
  const [name, setName] = useState("");
  const [work, setWork] = useState("");
  const [shown, setShown] = useState<{ id: number; link: string } | null>(null);
  const ownProjects = state.projects.filter((p) => !p.pair && p.owner === state.human);
  const [device, setDevice] = useState<{ link: string; code: string } | null>(null);
  const [dialog, setDialog] = useState<"invite" | "device" | "password" | "logout" | null>(null);
  const qr = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => { if (device && qr.current) void QRCode.toCanvas(qr.current, device.link, { width: 192, margin: 1 }); }, [device, dialog]);
  const [password, setPassword] = useState("");
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try { await f(); onChange(); } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast.success("Copied."), () => toast.error("Could not copy; select it by hand."));
  const close = () => { setDialog(null); setPassword(""); setCurrent(""); };
  return (
    <div className="screen-stack">
      <header className="screen-heading">
        <div><p className="eyebrow">Your circle</p><h2>Humans & access</h2><p>The humans you work with. The devices you work from.</p></div>
        {state.me.operator && <Button onClick={() => { setShown(null); setDialog("invite"); }}><UserPlusIcon /> Invite someone</Button>}
      </header>

      <section className="settings-section">
        <div className="section-intro"><h3>Humans</h3><p>Shared projects bring you together. Your agents can reach these humans from any folder.</p></div>
        <div>
          <div className="divide-y divide-border">
            {state.people.map((person) => {
              const shared = state.projects.filter((p) => !p.pair && p.humans.includes(person.name));
              return <div key={person.name} className="entity-row">
                <span className="person-avatar">{person.name.slice(0, 2).toUpperCase()}</span>
                <div className="min-w-0 flex-1"><h4 className="font-medium">{person.name}</h4><p className="supporting-text">{shared.length ? shared.map((p) => p.id).join(" · ") : "Connected through a shared space"}</p></div>
                <span className="text-xs text-muted-foreground">Connected</span>
              </div>;
            })}
            {!state.people.length && <div className="empty-state"><UserPlusIcon /><h4>Work is better together</h4><p>Invite someone to connect your agents and share a project.</p></div>}
          </div>
          {state.invites.length > 0 && <div className="mt-6"><h4 className="eyebrow mb-2">Invitations</h4><ul className="divide-y divide-border">{state.invites.map((i) => <li key={i.id} className="entity-row">
            <div className="min-w-0 flex-1"><p className="font-medium">{i.name}</p><p className="supporting-text">{i.project ?? "Hub invitation"} · {i.used_at ? `Joined ${ago(i.used_at, state.now)}` : i.expires_at <= state.now ? "Expired" : `Sent ${ago(i.created_at, state.now)}`}</p></div>
            {!i.used_at && i.expires_at > state.now ? <Button variant="ghost" disabled={busy} onClick={() => run(async () => { await post("invite/withdraw", { id: i.id }); })}>Withdraw</Button> : <span className="text-xs text-muted-foreground">{i.used_at ? "Accepted" : "Expired"}</span>}
          </li>)}</ul></div>}
        </div>
      </section>

      <section className="settings-section">
        <div className="section-intro"><h3>Your devices</h3><p>Manage where you’re signed in. Sign out a device when you no longer use it.</p></div>
        <div>
          <div className="mb-3 flex items-center justify-between gap-4"><span className="eyebrow">{state.me.logins.length} signed in</span><Button variant="outline" disabled={busy} onClick={() => { setDevice(null); setDialog("device"); }}><PlusIcon /> Add device</Button></div>
          <ul className="divide-y divide-border">{state.me.logins.map((l) => <li key={l.id} className="entity-row">
            <span className="entity-icon">{/phone|ios|android/i.test(l.label) ? <SmartphoneIcon /> : <LaptopIcon />}</span>
            <div className="min-w-0 flex-1"><h4 className="font-medium">{l.label || "Unnamed device"}</h4><p className="supporting-text">{l.last_seen ? `Active ${ago(l.last_seen, state.now)}` : "No recent activity"}<span className="mx-2 opacity-50">·</span>Added {ago(l.created_at, state.now)}</p></div>
            <Button variant="ghost" disabled={busy} onClick={() => run(async () => { await post("login/remove", { id: l.id }); })}>{l.id === 0 ? "End page key" : "Sign out"}</Button>
          </li>)}</ul>
          {!state.me.logins.length && <p className="py-5 text-muted-foreground">No device sessions to manage.</p>}
          {state.push.devices.length > 0 && <div className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><BellIcon className="mt-0.5 size-3.5 shrink-0" /><p>Notifications enabled on {state.push.devices.map((d) => d.label || "a device").join(", ")}. They stop when that device signs out.</p></div>}
        </div>
      </section>

      <section className="settings-section">
        <div className="section-intro"><h3>Account security</h3><p>Keep a way back in, and stay in control if a device goes missing.</p></div>
        <div>
          <div className="entity-row pt-0!">
            <span className="entity-icon"><KeyRoundIcon /></span>
            <div className="min-w-0 flex-1"><h4 className="font-medium">Password</h4><p className="supporting-text">{state.me.password ? "Sign in with your name and password." : "Add a password to sign in without an invite link."}</p><span className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">{state.me.password && <CheckIcon className="size-3" />}{state.me.password ? "Password is set" : "Not set"}</span></div>
            <Button variant="outline" onClick={() => setDialog("password")}>{state.me.password ? "Change" : "Set password"}</Button>
          </div>
          {state.me.logins.length > 0 && <div className="mt-6 border-t border-border pt-6"><div className="flex items-start gap-3"><ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div><h4 className="font-medium">Lost a device?</h4><p className="supporting-text mt-1 max-w-md">Sign out everywhere and clear your password. You’ll need a new login link to return, including on this device.</p><Button className="mt-3" variant="destructive" onClick={() => setDialog("logout")}>Sign out everywhere <ArrowUpRightIcon /></Button></div></div></div>}
        </div>
      </section>

      <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent className="sm:max-w-md">
          {dialog === "invite" && <>
            <DialogHeader><DialogTitle>Invite someone</DialogTitle><DialogDescription>Give them a place to start working with you.</DialogDescription></DialogHeader>
            {shown ? <div className="space-y-4"><p className="supporting-text">Send this link in a chat you already use. It works once, expires in a week, and is only shown here now.</p><code className="block break-all rounded-lg bg-muted p-3 text-xs">{shown.link}</code><Button onClick={() => copy(shown.link)}><CopyIcon /> Copy invite link</Button></div> : <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; void run(async () => { const r = await post("invite", { name: name.trim(), ...(work ? { project: work } : {}) }) as { id: number; link: string }; setShown(r); setName(""); setWork(""); }); }}>
              <label className="field-label">Their name<Input autoFocus placeholder="e.g. anna" value={name} onChange={(e) => setName(e.target.value)} /><span className="field-hint">Use lowercase letters.</span></label>
              {ownProjects.length > 0 && <label className="field-label">Start with<select className="field-select" value={work} onChange={(e) => setWork(e.target.value)}><option value="">Just connect on AXOS</option>{ownProjects.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}</select></label>}
              <DialogFooter><Button type="button" variant="ghost" onClick={close}>Cancel</Button><Button type="submit" disabled={busy || !name.trim()}>Create invitation</Button></DialogFooter>
            </form>}
          </>}
          {dialog === "device" && <>
            <DialogHeader><DialogTitle>Add a device</DialogTitle><DialogDescription>Open AXOS on your phone or another computer.</DialogDescription></DialogHeader>
            {!device ? <><p className="supporting-text">Create a short-lived login code. Scan it with your phone, or enter it on the other device’s login screen.</p><DialogFooter><Button disabled={busy} onClick={() => run(async () => { setDevice(await post("login-link", {}) as { link: string; code: string }); })}>Create login code</Button></DialogFooter></> : <div className="space-y-5 text-center"><canvas ref={qr} className="mx-auto rounded-lg bg-white p-2" width={192} height={192} /><div><p className="eyebrow mb-2">Or enter this code</p><code className="text-2xl tracking-[.2em]">{device.code}</code></div><p className="supporting-text">Valid for ten minutes. The link and code each work once.</p><Button variant="outline" onClick={() => copy(device.link)}><CopyIcon /> Copy login link</Button><p className="text-left text-xs leading-relaxed text-muted-foreground">On iPhone: scan in Safari, then Share → Add to Home Screen. Open the installed app and enter the short code there.</p></div>}
          </>}
          {dialog === "password" && <>
            <DialogHeader><DialogTitle>{state.me.password ? "Change password" : "Set a password"}</DialogTitle><DialogDescription>Use at least 10 characters. Keep it in your password manager.</DialogDescription></DialogHeader>
            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post("password", { password, current }); close(); toast.success("Password saved."); }); }}>
              {state.me.password && <label className="field-label">Current password<Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></label>}
              <label className="field-label">New password<Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required /></label>
              <DialogFooter><Button type="button" variant="ghost" onClick={close}>Cancel</Button><Button type="submit" disabled={busy}>Save password</Button></DialogFooter>
            </form>
          </>}
          {dialog === "logout" && <>
            <DialogHeader><DialogTitle>Sign out everywhere?</DialogTitle><DialogDescription>This signs out every device, stops their notifications and clears your password. You’ll need a new login link to return.</DialogDescription></DialogHeader>
            <DialogFooter><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => run(async () => { await post("logout-all", {}); location.reload(); })}>Sign out every device</Button></DialogFooter>
          </>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
