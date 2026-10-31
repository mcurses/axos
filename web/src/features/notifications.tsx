import { Button } from "@/components/ui/button";
import { disablePush, enablePush, pushState, type PushState } from "@/lib/push";
import { useEffect, useState } from "react";
import { toast } from "sonner";

// The "Notifications" control in the header: this device's pushes from the page itself.
export function Notifications({ hubKey, devices }: { hubKey: string | null; devices: number }) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { pushState(hubKey).then(setState, () => setState({ kind: "unsupported" })); }, [hubKey]);
  if (!state || state.kind === "unsupported") return null;

  const run = async (f: () => Promise<void>, done: string) => {
    setBusy(true);
    try { await f(); setState(await pushState(hubKey)); toast.success(done); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const others = devices - (state.kind === "on" ? 1 : 0);
  const note = others > 0 ? ` · ${others} other device${others === 1 ? "" : "s"}` : "";

  if (state.kind === "needs-install") {
    return <span className="text-muted-foreground text-xs">For notifications: Share → Add to Home Screen, then open AXOS from there.</span>;
  }
  if (state.kind === "denied") {
    return <span className="text-muted-foreground text-xs">Notifications are blocked in this browser's settings for this site.</span>;
  }
  return (
    <span className="flex items-center gap-2 text-xs">
      {state.kind === "on"
        ? <><span className="text-muted-foreground">Notifications on{note}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => run(disablePush, "This device gets no more pushes.")}>Turn off</Button></>
        : <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => enablePush(hubKey!), "Questions now reach this device.")}>Notifications: turn on</Button>}
    </span>
  );
}
