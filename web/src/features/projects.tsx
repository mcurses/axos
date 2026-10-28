import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ago, splitLabel, type Project } from "@/lib/api";
import { cn } from "@/lib/utils";
import { BellIcon, LinkIcon, UserIcon } from "lucide-react";

export function Dot({ on }: { on: boolean }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", on ? "bg-emerald-500" : "bg-muted-foreground/40")} />;
}

export function ProjectCard({ p, now, me }: { p: Project; now: number; me: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{p.id}</CardTitle>
        {p.brief && <CardDescription className="whitespace-pre-wrap">{p.brief}</CardDescription>}
        <div className="flex flex-wrap gap-1 pt-1">
          {p.humans.filter((h) => h !== me).map((h) => <Badge key={h} variant="secondary" className="rounded-full"><UserIcon />{h}</Badge>)}
          {p.links.map((l) => <Badge key={l} variant="outline"><LinkIcon /> {l}</Badge>)}
        </div>
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
                      {s.unread > 0 && <Badge variant="secondary" className="h-4 px-1 text-[10px]">{s.unread}</Badge>}
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
                {r.unread > 0 && <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">{r.unread} unread</Badge>}
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
