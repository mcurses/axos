import axosIcon from "../../assets/axos-icon-256.png";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AskCard, InboxItem, SentItem } from "@/features/inbox";
import { Composer } from "@/features/composer";
import { Notifications } from "@/features/notifications";
import { People } from "@/features/people";
import { NewProject, PendingRequests, ProjectCard } from "@/features/projects";
import { loadState, NotLoggedIn, type State } from "@/lib/api";
import { syncPush } from "@/lib/push";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";

// The map carries React Flow; it loads when its tab opens.
const LinkMap = lazy(() => import("@/features/map").then((m) => ({ default: m.LinkMap })));

const REFRESH_MS = 10_000;

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const refresh = useCallback(() => {
    loadState().then((s) => { setState(s); setError(null); }, setError);
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", refresh); };
  }, [refresh]);
  // A push opens /ui#m<id>: once the item is on the page, bring it into view.
  useEffect(() => {
    if (state && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "center" });
  }, [state !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  // Each load: the hub hears of this device again, the badge shows what is open, shown notifications are taken off.
  useEffect(() => {
    if (state) void syncPush(state.push.key, state.asks.length + state.inbox.length);
  }, [state]);

  if (error instanceof NotLoggedIn) return <Login />;
  if (!state) return <main className="p-6 text-muted-foreground">{error ? `Could not load: ${error.message}` : "Loading…"}</main>;

  const unread = state.asks.length + state.inbox.length + state.pending.length;
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-5 sm:px-10 sm:py-8">
      <header className="axos-header flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3"><img src={axosIcon} alt="" className="axos-mark size-11 shrink-0" /><div className="min-w-0"><h1 className="font-semibold text-lg tracking-[0.16em]">AXOS</h1><p className="truncate text-xs text-muted-foreground">{state.human}</p></div></div>
        <span className="flex items-center gap-2">
          {error && <Badge variant="destructive">offline: {error.message}</Badge>}
          <Notifications hubKey={state.push.key} devices={state.push.devices.length} />
        </span>
      </header>
      <Tabs defaultValue={["people", "projects", "send", "map", "inbox"].includes(location.hash.slice(1)) ? location.hash.slice(1) : location.hash.startsWith("#m") || unread ? "inbox" : "map"} onValueChange={(tab) => history.replaceState(null, "", `#${tab}`)}>
        <TabsList className="axos-navigation w-full sm:w-auto" onPointerDown={(e) => { e.currentTarget.dataset.pointer = "true"; }} onKeyDown={(e) => { delete e.currentTarget.dataset.pointer; }}>
          <TabsTrigger value="inbox">Inbox{unread > 0 && <Badge className="ml-1 h-5 px-1.5">{unread}</Badge>}</TabsTrigger>
          <TabsTrigger value="map">Map</TabsTrigger>
          <TabsTrigger value="projects">Projects</TabsTrigger>
          <TabsTrigger value="people">Humans</TabsTrigger>
          <TabsTrigger value="send">Send</TabsTrigger>
        </TabsList>
        <TabsContent value="inbox" className="screen-stack">
          <header className="screen-heading"><div><p className="eyebrow">Your attention</p><h2>Inbox</h2><p>Decisions to make, updates to catch up on. This is where your agents reach you.</p></div></header>
          <PendingRequests pending={state.pending} projects={state.projects} onChange={refresh} />
          {/* Two quiet section titles; what matters is the state line under each ("none open", "nothing unread"). */}
          <section className="flex flex-col gap-3">
            <h2 className="eyebrow">Needs a decision{state.asks.length > 0 && <span className="ml-2 font-normal normal-case tracking-normal">{state.asks.length}</span>}</h2>
            {state.asks.map((a) => <AskCard key={a.id} ask={a} now={state.now} onDone={refresh} />)}
            {!state.asks.length && <p className="text-muted-foreground text-sm">None open.</p>}
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="eyebrow">Updates{state.inbox.length > 0 && <span className="ml-2 font-normal normal-case tracking-normal">{state.inbox.length} unread</span>}</h2>
            {state.inbox.map((m) => <InboxItem key={m.id} m={m} now={state.now} onDone={refresh} />)}
            {!state.inbox.length && <p className="text-muted-foreground text-sm">{state.projects.length ? "Nothing unread." : "Nothing yet. A question from one of your sessions, or a message from a person, appears here and on your phone."}</p>}
          </section>
          {/* Bonus information, folded by default: what your agents sent to other people, and what they quoted as your words. */}
          {state.sent.length > 0 && (
            <details className="group">
              <summary className="eyebrow cursor-pointer list-none select-none opacity-70 hover:opacity-100"><span className="mr-1 inline-block transition-transform group-open:rotate-90">›</span>Agent activity<span className="ml-2 font-normal normal-case tracking-normal">last {state.sent.length}</span></summary>
              <div className="mt-2 flex flex-col">{state.sent.map((m) => <SentItem key={m.id} m={m} now={state.now} />)}</div>
            </details>
          )}
        </TabsContent>
        <TabsContent value="map" className="screen-stack">
          <header className="screen-heading"><div><p className="eyebrow">The bigger picture</p><h2>Your network</h2><p>See where your agents are working and how your projects connect.</p></div></header>
          <Suspense fallback={<p className="text-muted-foreground text-sm">Loading the map…</p>}><LinkMap state={state} /></Suspense>
        </TabsContent>
        <TabsContent value="projects" className="screen-stack">
          <NewProject onChange={refresh} />
          {state.projects.filter((p) => !p.pair).map((p) => <ProjectCard key={p.id} p={p} now={state.now} me={state.human} people={state.people.map((x) => x.name)} operator={state.me.operator} onChange={refresh} />)}
          {!state.projects.some((p) => !p.pair) && <p className="text-muted-foreground text-sm">No projects yet. In a repo, tell Claude Code "connect this folder to AXOS".</p>}
        </TabsContent>
        <TabsContent value="people" className="pt-2">
          <People state={state} onChange={refresh} />
        </TabsContent>
        <TabsContent value="send" className="pt-2">
          <Composer state={state} onSent={refresh} />
        </TabsContent>
      </Tabs>
      <Toaster />
    </main>
  );
}

// Not logged in: the key link once, or the key typed here (an installed app has no address bar to open the link in).
function Login() {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const send = async (path: string, body: unknown) => {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) location.replace("/ui");
    else setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `the hub answered ${res.status}`);
  };
  const submit = (e: React.FormEvent) => { e.preventDefault(); void send("/ui/login", { name, password }); };
  return (
    <main className="mx-auto max-w-md px-4 py-12 sm:py-20">
      <header className="mb-8 flex flex-col items-center gap-3 text-center"><img src={axosIcon} alt="" className="axos-mark size-20" /><h1 className="font-semibold text-2xl tracking-[0.18em]">AXOS</h1><p className="text-sm text-muted-foreground">Your people, projects and sessions.</p></header>
      <div className="axos-login rounded-2xl border bg-card p-5 sm:p-6">
      <h2 className="mb-4 text-lg font-medium">Log in</h2>
      <form className="flex flex-col gap-2" onSubmit={submit}>
        <label htmlFor="username" className="text-sm font-medium">Name</label>
        <Input id="username" name="username" autoComplete="username" placeholder="your name" value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="password" className="mt-2 text-sm font-medium">Password</label>
        <Input id="password" type="password" name="password" autoComplete="current-password" placeholder="your password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button className="mt-3" type="submit">Log in</Button>
        {error && <p className="text-destructive text-sm">{error}</p>}
      </form>
      <form className="mt-6 flex flex-col gap-3 border-t pt-5" onSubmit={(e) => { e.preventDefault(); void send("/ui/login/code", { code }); }}>
        <p className="text-muted-foreground text-sm">Or the short code from a device where you are logged in (Humans → "Add device"):</p>
        <label htmlFor="login-code" className="text-sm font-medium">Login code</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input id="login-code" className="min-w-0 flex-1 uppercase tracking-widest" autoComplete="one-time-code" placeholder="ABCD-EFGH" value={code} onChange={(e) => setCode(e.target.value)} />
          <Button variant="outline" type="submit">Use code</Button>
        </div>
      </form>
      <p className="mt-5 border-t pt-4 text-muted-foreground text-sm">No password and no device logged in? Ask the person who runs this hub for a new login link.</p>
      </div>
    </main>
  );
}
