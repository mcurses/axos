import {
  PromptInput, PromptInputBody, PromptInputProvider, PromptInputFooter, PromptInputHeader, PromptInputSelect, PromptInputSelectContent,
  PromptInputSelectItem, PromptInputSelectTrigger, PromptInputSelectValue, PromptInputSubmit, PromptInputTextarea, PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Input } from "@/components/ui/input";
import { post, type State } from "@/lib/api";
import { useMemo, useState } from "react";
import { toast } from "sonner";

// A message from the human to their agents: project, address, type and priority, a summary line and a body.
export function Composer({ state, onSent }: { state: State; onSent: () => void }) {
  const [project, setProject] = useState(state.projects[0]?.id ?? "");
  const [to, setTo] = useState("");
  const [type, setType] = useState("note");
  const [priority, setPriority] = useState("normal");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const p = state.projects.find((x) => x.id === project);
  // Who can be reached from here: the project, its roles, its live sessions, its linked projects.
  const targets = useMemo(() => !p ? [] : [
    "project",
    ...p.roles.map((r) => `role:${r.role}`),
    ...p.sessions.filter((s) => s.name).map((s) => `session:${s.name}`),
    ...p.links.map((l) => `project:${l}`),
  ], [p]);

  const send = async (body: string) => {
    if (busy) return;
    if (!to.trim() || !summary.trim()) {
      toast.error("To and a summary are needed");
      throw new Error("incomplete"); // keeps the text in the box
    }
    setBusy(true);
    try {
      await post("send", { project, to, type, priority, summary, body });
      toast.success("Sent");
      setSummary("");
      onSent();
    } catch (e) {
      toast.error((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
        <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="To: role:main-coordinator, session:…, project" />
        <Input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={300} placeholder="Summary: one sentence anyone understands" />
      </div>
      {targets.length > 0 && (
        <Suggestions>
          {targets.map((t) => <Suggestion key={t} suggestion={t} onClick={setTo} variant={t === to ? "default" : "outline"} />)}
        </Suggestions>
      )}
      <PromptInputProvider>
      <PromptInput onSubmit={(m) => send(m.text)}>
        <PromptInputHeader>
          <PromptInputSelect value={project} onValueChange={(v) => { setProject(v); setTo(""); }}>
            <PromptInputSelectTrigger><PromptInputSelectValue /></PromptInputSelectTrigger>
            <PromptInputSelectContent>
              {state.projects.map((x) => <PromptInputSelectItem key={x.id} value={x.id}>{x.id}</PromptInputSelectItem>)}
            </PromptInputSelectContent>
          </PromptInputSelect>
          <PromptInputSelect value={type} onValueChange={setType}>
            <PromptInputSelectTrigger><PromptInputSelectValue /></PromptInputSelectTrigger>
            <PromptInputSelectContent>
              {state.types.map((t) => <PromptInputSelectItem key={t} value={t}>{t}</PromptInputSelectItem>)}
            </PromptInputSelectContent>
          </PromptInputSelect>
          <PromptInputSelect value={priority} onValueChange={setPriority}>
            <PromptInputSelectTrigger><PromptInputSelectValue /></PromptInputSelectTrigger>
            <PromptInputSelectContent>
              <PromptInputSelectItem value="low">low: wakes nobody</PromptInputSelectItem>
              <PromptInputSelectItem value="normal">normal</PromptInputSelectItem>
              <PromptInputSelectItem value="high">high</PromptInputSelectItem>
            </PromptInputSelectContent>
          </PromptInputSelect>
        </PromptInputHeader>
        <PromptInputBody>
          <PromptInputTextarea placeholder="Body (optional): the detail" />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools />
          <PromptInputSubmit status={busy ? "submitted" : undefined} disabled={busy} />
        </PromptInputFooter>
      </PromptInput>
      </PromptInputProvider>
    </div>
  );
}
