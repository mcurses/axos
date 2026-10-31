import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ago, post, splitLabel, type Ask, type InboxMessage, type SentMessage } from "@/lib/api";
import { CheckIcon, ClockIcon, CornerDownLeftIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

function Sender({ label }: { label: string }) {
  const { name, detail } = splitLabel(label);
  return (
    <span className="font-medium">
      {name}
      {detail && <span className="ml-1 font-normal text-muted-foreground text-xs">{detail}</span>}
    </span>
  );
}

export function AskCard({ ask, now, onDone }: { ask: Ask; now: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const answer = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await post("answer", { ask: ask.id, answer: text });
      toast.success("Answer sent");
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
      throw e; // keeps a typed answer in the box
    } finally {
      setBusy(false);
    }
  };
  return (
    <article id={`m${ask.message_id}`} className="decision-card">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{ask.project}</span><span>{ago(ask.created_at, now)}</span></div>
      <div className="question-text"><MessageResponse>{ask.question}</MessageResponse></div>
      <p className="mt-3 text-xs text-muted-foreground">Asked by <Sender label={ask.from} /></p>
      {ask.deadline && ask.default_answer !== null && <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground"><ClockIcon className="size-3.5 shrink-0" />Defaults to “{ask.default_answer}” at {new Date(ask.deadline).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</p>}
      {ask.images.map((i) => <a key={i.id} href={`/ui/image/${i.id}`} target="_blank" rel="noreferrer"><img src={`/ui/image/${i.id}`} alt={i.name} className="mt-4 max-h-[70vh] max-w-full rounded-md border" /></a>)}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t pt-5">
        <div className="flex flex-wrap gap-2">{ask.options.map((o) => <Button key={o} disabled={busy} variant={o === ask.default_answer ? "default" : "outline"} onClick={() => void answer(o).catch(() => {})}>{o}</Button>)}</div>
        {!writing && ask.options.length > 0 && <Button variant="ghost" onClick={() => setWriting(true)}>Write a reply <CornerDownLeftIcon /></Button>}
      </div>
      {(writing || !ask.options.length) && <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); void answer(text).catch(() => {}); }}><label className="field-label">Your answer<Textarea autoFocus={writing} value={text} onChange={(e) => setText(e.target.value)} placeholder="Answer in your own words…" className="min-h-24 p-3" required /></label><div className="flex justify-end gap-2">{ask.options.length > 0 && <Button variant="ghost" type="button" onClick={() => setWriting(false)}>Cancel</Button>}<Button type="submit" disabled={busy || !text.trim()}>Send answer</Button></div></form>}
    </article>
  );
}

export function InboxItem({ m, now, onDone }: { m: InboxMessage; now: number; onDone: () => void }) {
  const ack = async () => {
    try {
      await post("ack", { id: m.id });
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <article id={`m${m.id}`} className="update-row">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><Sender label={m.from} /><span>·</span><span>{m.project}</span><span className="ml-auto">{ago(m.created_at, now)}</span>{m.priority === "high" && <Badge variant="destructive">High priority</Badge>}</div>
      <h3 className="mt-3 text-base font-medium leading-relaxed">{m.summary}</h3>
      {m.quotes_human && <p className="mt-2 text-xs text-muted-foreground">The sender says this is what {m.quotes_human} typed to it; that is the sender’s word.</p>}
      {m.body && <div className="mt-2 text-sm leading-relaxed text-muted-foreground"><MessageResponse>{m.body}</MessageResponse></div>}
      <div className="mt-3 flex items-center justify-between"><span className="eyebrow">{m.type}</span><Button variant="ghost" onClick={ack}><CheckIcon /> Mark read</Button></div>
    </article>
  );
}

// One quiet line per message; the details open on a click.
export function SentItem({ m, now }: { m: SentMessage; now: number }) {
  const { name } = splitLabel(m.from);
  return (
    <details className="group border-b py-2 text-sm">
      <summary className="flex cursor-pointer list-none items-baseline gap-2 text-muted-foreground">
        <span className="shrink-0 text-xs">{name}</span>
        <span className="min-w-0 flex-1 truncate group-open:whitespace-normal">{m.summary}{m.quotes_human && <span className="ml-1 text-xs">(quotes you)</span>}</span>
        <span className="shrink-0 text-xs">{ago(m.created_at, now)}</span>
      </summary>
      <div className="mt-2 pl-1 text-xs text-muted-foreground">To {m.readers.length ? m.readers.join(", ") : "your own sessions"}{m.quotes_human ? "; this agent says it quoted your words" : ""}.</div>
      {m.body && <div className="mt-2 pl-1 text-sm text-muted-foreground"><MessageResponse>{m.body}</MessageResponse></div>}
    </details>
  );
}
