import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { PromptInput, PromptInputProvider, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools } from "@/components/ai-elements/prompt-input";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ago, post, splitLabel, type Ask, type InboxMessage, type SentMessage } from "@/lib/api";
import { CheckIcon, ClockIcon } from "lucide-react";
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
    <Card id={`m${ask.message_id}`} className="border-l-4 border-l-primary">
      <CardHeader>
        <CardTitle className="text-sm"><Sender label={ask.from} /></CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2">
          {ask.project} · {ago(ask.created_at, now)}
          {ask.deadline && ask.default_answer !== null && (
            <Badge variant="outline"><ClockIcon /> default “{ask.default_answer}” at {new Date(ask.deadline).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</Badge>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <MessageResponse>{ask.question}</MessageResponse>
        {ask.images.map((i) => (
          <a key={i.id} href={`/ui/image/${i.id}`} target="_blank" rel="noreferrer">
            <img src={`/ui/image/${i.id}`} alt={i.name} className="max-h-[70vh] max-w-full rounded-md border" />
          </a>
        ))}
        {ask.options.length > 0 && (
          <Suggestions>
            {ask.options.map((o) => (
              <Suggestion key={o} suggestion={o} onClick={(x) => void answer(x).catch(() => {})} disabled={busy} variant={o === ask.default_answer ? "default" : "outline"} />
            ))}
          </Suggestions>
        )}
        <PromptInputProvider>
        <PromptInput onSubmit={(m) => answer(m.text)}>
          <PromptInputBody>
            <PromptInputTextarea placeholder="Or answer in your own words" />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools />
            <PromptInputSubmit status={busy ? "submitted" : undefined} disabled={busy} />
          </PromptInputFooter>
        </PromptInput>
        </PromptInputProvider>
      </CardContent>
    </Card>
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
    <Message from="assistant" id={`m${m.id}`} className="max-w-full rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Sender label={m.from} />
        <Badge variant="secondary">{m.type}</Badge>
        {m.priority === "high" && <Badge variant="destructive">high</Badge>}
        <span className="text-muted-foreground text-xs">{m.project} · {ago(m.created_at, now)}</span>
      </div>
      <MessageContent className="w-full">
        <p className="font-semibold">{m.summary}</p>
        {m.body && <MessageResponse>{m.body}</MessageResponse>}
      </MessageContent>
      <MessageActions>
        <MessageAction tooltip="Mark read: the sender sees it acked" label="Done" size="sm" variant="outline" onClick={ack}><CheckIcon /> Done</MessageAction>
      </MessageActions>
    </Message>
  );
}

export function SentItem({ m, now }: { m: SentMessage; now: number }) {
  return (
    <Message from="user" className="max-w-full">
      <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Sender label={m.from} /> → {m.readers.join(", ")} · {m.project} · {ago(m.created_at, now)}
      </div>
      <MessageContent>
        <details>
          <summary className="cursor-pointer font-semibold">{m.summary}</summary>
          {m.body && <div className="mt-2"><MessageResponse>{m.body}</MessageResponse></div>}
        </details>
      </MessageContent>
    </Message>
  );
}
