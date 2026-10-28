import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AskCard, InboxItem, SentItem } from "@/features/inbox";
import { Composer } from "@/features/composer";
import { ProjectCard } from "@/features/projects";
import { loadState, NotLoggedIn, type State } from "@/lib/api";
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

  if (error instanceof NotLoggedIn) {
    return (
      <main className="mx-auto max-w-xl p-6">
        <h1 className="mb-2 font-semibold text-xl">AXOS</h1>
        <p className="text-muted-foreground">Open the link with your key once: <code>/ui?key=…</code> (from <code>axos human key</code>). It is remembered after that.</p>
      </main>
    );
  }
  if (!state) return <main className="p-6 text-muted-foreground">{error ? `Could not load: ${error.message}` : "Loading…"}</main>;

  const unread = state.asks.length + state.inbox.length;
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex items-center justify-between gap-2">
        <h1 className="font-semibold text-xl">AXOS <span className="font-normal text-muted-foreground">· {state.human}</span></h1>
        {error && <Badge variant="destructive">offline: {error.message}</Badge>}
      </header>
      <Tabs defaultValue={location.hash.startsWith("#m") || unread ? "inbox" : "map"}>
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="inbox">Inbox{unread > 0 && <Badge className="ml-1 h-5 px-1.5">{unread}</Badge>}</TabsTrigger>
          <TabsTrigger value="map">Map</TabsTrigger>
          <TabsTrigger value="projects">Projects</TabsTrigger>
          <TabsTrigger value="send">Send</TabsTrigger>
        </TabsList>
        <TabsContent value="inbox" className="flex flex-col gap-6 pt-2">
          <section className="flex flex-col gap-3">
            <h2 className="font-medium">Questions for you <span className="text-muted-foreground">({state.asks.length})</span></h2>
            {state.asks.map((a) => <AskCard key={a.id} ask={a} now={state.now} onDone={refresh} />)}
            {!state.asks.length && <p className="text-muted-foreground text-sm">None open.</p>}
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="font-medium">Messages to you <span className="text-muted-foreground">({state.inbox.length} unread)</span></h2>
            {state.inbox.map((m) => <InboxItem key={m.id} m={m} now={state.now} onDone={refresh} />)}
            {!state.inbox.length && <p className="text-muted-foreground text-sm">Nothing unread.</p>}
          </section>
          {state.sent.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="font-medium">Sent by your agents to other people <span className="text-muted-foreground">(last {state.sent.length})</span></h2>
              {state.sent.map((m) => <SentItem key={m.id} m={m} now={state.now} />)}
            </section>
          )}
        </TabsContent>
        <TabsContent value="map" className="pt-2">
          <Suspense fallback={<p className="text-muted-foreground text-sm">Loading the map…</p>}><LinkMap state={state} /></Suspense>
        </TabsContent>
        <TabsContent value="projects" className="flex flex-col gap-4 pt-2">
          {state.projects.map((p) => <ProjectCard key={p.id} p={p} now={state.now} me={state.human} />)}
        </TabsContent>
        <TabsContent value="send" className="pt-2">
          <Composer state={state} onSent={refresh} />
        </TabsContent>
      </Tabs>
      <Toaster />
    </main>
  );
}
