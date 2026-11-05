import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { post, type State } from "@/lib/api";
import { ArrowUpRightIcon, SendIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

export function Composer({ state, onSent }: { state: State; onSent: () => void }) {
  const [project, setProject] = useState(state.projects[0]?.id ?? "");
  const [to, setTo] = useState("");
  const [type, setType] = useState("note");
  const [priority, setPriority] = useState("normal");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const p = state.projects.find((x) => x.id === project);
  const targets = useMemo(() => !p ? [] : [
    { value: "project", label: "Everyone in this project" },
    ...p.roles.map((r) => ({ value: `role:${r.role}`, label: `${r.role} · role` })),
    ...p.sessions.filter((s) => s.name).map((s) => ({ value: `session:${s.name}`, label: `${s.name} · session` })),
    ...p.links.map((l) => ({ value: `project:${l}`, label: `${l} · linked project` })),
  ], [p]);
  const send = async () => {
    if (busy || !to.trim() || !summary.trim()) return;
    setBusy(true);
    try {
      await post("send", { project, to, type, priority, summary, body });
      toast.success("Message sent"); setSummary(""); setBody(""); onSent();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="screen-stack">
      <header className="screen-heading"><div><p className="eyebrow">Start a conversation</p><h2>Send a message</h2><p>Give your agents direction, ask a question or share an update.</p></div></header>
      {!state.projects.length ? <div className="empty-state"><SendIcon /><h4>A project comes first</h4><p>Create or join a project to start a conversation with its agents.</p></div> :
      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,2.25fr)_minmax(0,1fr)]">
        <form className="compose-surface space-y-6" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="field-label">Project<select className="field-select" value={project} onChange={(e) => { setProject(e.target.value); setTo(""); }}>{state.projects.map((x) => <option key={x.id} value={x.id}>{x.id}</option>)}</select></label>
            <label className="field-label">To<Input list="message-recipients" value={to} onChange={(e) => setTo(e.target.value)} placeholder="Choose or type a recipient" required /></label><datalist id="message-recipients">{targets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</datalist>
          </div>
          <label className="field-label">What’s the message?<Input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={300} placeholder="The main point, in one sentence" required /></label>
          <label className="field-label">More detail <span className="field-hint -mt-1">Optional — context, a question, or next steps.</span><Textarea className="min-h-44 resize-y bg-transparent p-3 text-sm" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your message…" /></label>
          <details className="message-options"><summary className="cursor-pointer text-xs text-muted-foreground">Delivery options <span className="ml-2 opacity-70">{type} · {priority} priority</span></summary><div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="field-label">Message type<select className="field-select" value={type} onChange={(e) => setType(e.target.value)}>{state.types.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
            <label className="field-label">Priority<select className="field-select" value={priority} onChange={(e) => setPriority(e.target.value)}><option value="low">Low · no wake-up</option><option value="normal">Normal</option><option value="high">High</option></select></label>
          </div></details>
          <div className="flex items-center justify-between gap-4 border-t pt-5"><p className="text-xs text-muted-foreground">Sent as <span className="font-medium text-foreground">{state.human}</span></p><Button type="submit" disabled={busy || !to.trim() || !summary.trim()}><SendIcon />{busy ? "Sending…" : "Send message"}</Button></div>
        </form>
        <aside className="pt-1"><h3 className="eyebrow mb-4">Who’s here</h3><p className="supporting-text mb-4">Choose a recipient in {project}. Roles stay reachable even when their agent is away.</p><div className="flex flex-col">{targets.map((t) => <button type="button" key={t.value} onClick={() => setTo(t.value)} className="flex items-center justify-between gap-3 border-b py-3 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"><span>{t.label}</span><ArrowUpRightIcon className="size-3.5 shrink-0" /></button>)}</div>
          {state.open_roles?.length ? <><h3 className="eyebrow mb-4 mt-8">Open to everyone on this hub</h3><p className="supporting-text mb-4">These roles take messages from anyone on this hub, from any of your projects.</p><div className="flex flex-col">{state.open_roles.map((r) => <button type="button" key={r.address} onClick={() => setTo(r.address)} title={`Send to ${r.address}`} className="flex items-center justify-between gap-3 border-b py-3 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"><span className="min-w-0"><span className="block text-foreground">{r.address.slice(5)} · {r.owner}</span><span className="block">{r.description}</span></span><ArrowUpRightIcon className="size-3.5 shrink-0" /></button>)}</div></> : null}
        </aside>
      </div>}
    </div>
  );
}
