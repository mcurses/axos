#!/usr/bin/env bun
import { openDb } from "./db.ts";
import { AxosError, Hub, iso } from "./hub.ts";
import { ago } from "./render.ts";

// Admin CLI. Runs on the hub host against the same database file (AXOS_DB); installed as /usr/local/bin/axos (deploy/systemd/axos).
// Tokens and UI keys are printed once and stored only as hashes.

const USAGE = `axos — hub admin

  axos init <your name>                          first run: you, your page link and a join link for your first machine
  axos invite [<project>] --human <name>         a one-time join link (7 days) for a machine of <name>; a new person
                                                 joins <project> with it; --by <person>: as from that person's page
  axos backup <file>                             a consistent copy of the database, safe while the hub runs
  axos human add <name> [--ntfy <topic>]         add a human; prints a one-time login link for their page
  axos human key <name>                          new UI key
  axos human ntfy <name> <topic|->               set or clear the ntfy topic
  axos human devices <name> [--clear]            the devices the page registered for pushes; --clear forgets them all
  axos human operator <name> [--off]             let <name> invite new people from their page (the first person is one)
  axos human remove <name>                       remove a person: machines, logins, devices, invites, memberships; not the operator, not an owner
  axos human password <name>                     set <name>'s page password from stdin (when no device of theirs is logged in)
  axos project add <owner>/<name> [--brief <file|->] [--repo <git address>]
                                                 add a project (- reads the brief from stdin); prints its id
  axos project list                              every project with its id, people and links
  axos project brief <project> <file|->          set the brief agents get on join
  axos project rename <project> <new name>       the old name keeps working
  axos project remove <project>                  remove a project that carried no message (an empty leftover); one with mail stays
  axos project human <project> <human>           let a human (and all their agents) into a project
  axos project unhuman <project> <human>         take them out again: their sessions there end, roles and leases freed
  axos project link <project> <project> [<project>…]
                                                 let the sessions of the first project and each other one message each
                                                 other (nothing else crosses); project unlink takes the same
  axos project unlink <project> <project>
  axos project links
  axos role add <project> <role>                 define a role so it can be addressed before anyone holds it
  axos role open <project> <role> [--off]        open a role to every session of the owner's person, from any project
  axos agent add <human> <name> <project,...>    add an agent; prints its token
  axos agent join <human>/<name> <project>       add an agent to a project
  axos agent token <human>/<name>                new token (old one stops working)
  axos agent revoke <human>/<name>               kill switch for good: token dead, roles and leases freed
  axos agent list
  axos landed <project> <repo> <branch> <head> [<commit>...] [--remote <r>] [--subject <s>]
                                                 report a landing (from a git server's post-receive hook): every
                                                 subscription waiting for these commits on <branch> is told
  axos events [--since <id>]                     audit log as JSON lines
  axos health [--since <date>] [--json]          did messages reach a reader, and where mail waits with nobody to
                                                 read it (default: the last 7 days)

A project is '<owner>/<name>', its bare name when that is unambiguous, or its id (prj_…).
Environment: AXOS_DB (default axos.db), AXOS_PUBLIC_URL (for the links it prints)`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

const readText = (file: string) => file === "-" ? Bun.stdin.text() : Bun.file(file).text();

async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  // The CLI runs beside the hub process, without its notifier: it must not sweep (a reminder would count as pushed
  // and never reach the phone). Reads here are reads; the hub's own sweep runs in the service.
  const hub = new Hub(openDb(process.env.AXOS_DB ?? "axos.db"), { sweep: false });
  const out = (s: string) => console.log(hub.display(s));
  const [noun, verb, ...rest] = args;
  const need = (n: number) => { if (rest.length < n) throw new AxosError(USAGE); };
  const project = (ref: string) => {
    const id = hub.projectId(ref);
    if (!id) throw new AxosError(`no project '${ref}'`);
    return id;
  };
  const agent = (ref: string) => {
    const id = hub.agentId(ref);
    if (!id) throw new AxosError(`no agent '${ref}'`);
    return id;
  };

  const base = (process.env.AXOS_PUBLIC_URL ?? "<hub url>").replace(/\/$/, "");
  const joinLink = (code: string) => `${base}/join/${code}`;

  if (noun === "init") {
    const name = verb;
    if (!name) throw new AxosError("usage: axos init <your name>");
    if (hub.db.query("SELECT 1 FROM humans").get()) throw new AxosError("this hub is set up already; axos invite brings more machines and people");
    hub.addHuman(name, undefined, false); // no page key: devices log in one by one through one-time links
    hub.setOperator(name, true);
    const { code } = hub.createInvite(name, null);
    const login = hub.createLoginLink(name, 24 * 3600).token;
    console.log(`Welcome, ${name}. Two links, each shown once:

  Your page (open it in your browser within a day; it logs that browser in; other devices log in from it under Humans → Add device):
    ${base}/ui/login/${login}

  Your first machine (open it in a browser for the steps, or run there):
    axos join ${joinLink(code)}

The join link works once and expires in 7 days; axos invite --human ${name} makes another. You invite other people from your page.
Next: a project for a repo: axos project add ${name}/<name> --repo <git address>, or in Claude Code in that repo: connect this folder to AXOS.`);
    return;
  }
  if (noun === "invite") {
    const args = [verb, ...rest].filter((x): x is string => x !== undefined);
    const human = flag(args, "--human");
    const by = flag(args, "--by"); // as if made on that person's page: the two are paired on redemption, the project carried
    if (!human) throw new AxosError("usage: axos invite [<project>] --human <name> [--by <person>]");
    const { code, expires_at } = hub.createInvite(human, args[0] ? project(args[0]) : null, undefined, by);
    console.log(`Join link for a machine of ${human}${by ? `, as from ${by}'s page` : ""} (works once, until ${iso(expires_at)}):\n  ${joinLink(code)}\nSend it over a private channel.`);
    return;
  }
  if (noun === "backup") {
    if (!verb) throw new AxosError("usage: axos backup <file>");
    hub.db.query("VACUUM INTO ?").run(verb);
    console.log(`backed up to ${verb}`);
    return;
  }

  if (noun === "health") {
    const args = [verb, ...rest].filter((x): x is string => x !== undefined);
    const json = args.includes("--json");
    const sinceArg = flag(args, "--since");
    const since = sinceArg ? Date.parse(sinceArg) : Date.now() - 7 * 86_400_000;
    if (Number.isNaN(since)) throw new AxosError("usage: axos health [--since <YYYY-MM-DD>] [--json]");
    const h = hub.health(since);
    if (json) { console.log(hub.display(JSON.stringify(h, null, 2))); return; }
    const pct = (a: number, b: number) => b ? `${Math.round((a / b) * 100)} %` : "–";
    const age = (ms: number | null) => ms === null ? "" : `, oldest ${ago(ms, h.now).replace(/ ago$/, "")}`;
    const lines = [
      `AXOS health, hub ${h.version}, since ${iso(h.since)}: ${h.messages} message(s) sent, ${h.live_sessions} live session(s).`,
      "Reached a reader (shown) / handled, by mailbox kind:",
      ...h.delivered.map((d) => `  ${d.kind.padEnd(8)} ${String(d.n).padStart(4)} delivered; shown ${d.shown} (${pct(d.shown, d.n)}), within 10 min ${d.within_10m}, within 1 h ${d.within_1h}; handled ${d.handled}; expired ${d.expired}`),
      `Waiting now: ${h.open.map((o) => `${o.kind} ${o.n}${age(o.oldest)}`).join("; ")}.`,
    ];
    const nobody = [
      ...h.stuck_sessions.map((s) => `live session ${s.label} has ${s.n} message(s) not shown for over an hour${age(s.oldest)}${s.wakes === 0 ? " (its host does not wake on messages: they wait for its next prompt)" : s.wakes === 1 ? " (its host wakes on messages, so the hooks are not reaching it)" : ""}`),
      ...h.unread_agents.map((a) => `agent ${a.human}/${a.name} has ${a.n} unread and has ${a.last_seen === null ? "never connected" : `not connected since ${iso(a.last_seen)}`}`),
      ...h.unread_roles.map((r) => `role ${r.project}/${r.role} has ${r.n} unread, ${r.state}${age(r.oldest)}`),
      ...h.unread_humans.map((u) => `${u.human} has ${u.n} high-priority message(s) unhandled on the page for over a day`),
    ];
    lines.push(nobody.length ? `Nobody reading (${nobody.length}):` : "Nobody reading: nothing.", ...nobody.map((x) => `  - ${x}`));
    if (h.unused_machines.length) {
      lines.push(`Machines nobody has used for 14 days or ever (${h.unused_machines.length}; their owner revokes them on the page, or the admin with axos agent revoke <human>/<name>): ` +
        h.unused_machines.map((m) => `${m.human}/${m.name} (${m.last_seen === null ? "never used" : `last ${iso(m.last_seen)}`}${m.unread ? `, ${m.unread} unread` : ""})`).join("; ") + ".");
    }
    lines.push(`Phone: ${h.pushes.sent} push(es) sent, ${h.pushes.failed} failed. Expired unread in the window: ${h.expired_since}.`);
    lines.push(`New in the window: humans ${h.new.humans.join(", ") || "none"}; projects ${h.new.projects.join(", ") || "none"}; agents ${h.new.agents.join(", ") || "none"}.`);
    out(lines.join("\n"));
    return;
  }

  if (noun === "landed") {
    const args = [verb, ...rest].filter((x): x is string => x !== undefined);
    const remote = flag(args, "--remote");
    const subject = flag(args, "--subject");
    const [p, repo, branch, head, ...commits] = args;
    if (!p || !repo || !branch || !head) throw new AxosError("usage: axos landed <project> <repo> <branch> <head> [<commit>...] [--remote <r>] [--subject <s>]");
    const r = hub.reportLanding("admin", { project: project(p), repo, remote, branch, head, commits, subject });
    out(`landing ${r.id}: ${r.commits} commit(s) on ${branch}; ${r.told} subscription(s) told`);
    return;
  }

  switch (`${noun} ${verb}`) {
    case "human add": {
      const ntfy = flag(rest, "--ntfy");
      need(1);
      hub.addHuman(rest[0]!, ntfy, false);
      const login = hub.createLoginLink(rest[0]!, 24 * 3600).token;
      out(`human ${rest[0]} added. Their page, once, within a day (it logs that browser in; other devices from it under Humans → Add device):\n  ${base}/ui/login/${login}`);
      return;
    }
    case "human key": {
      need(1);
      out(`new UI key for ${rest[0]} (shown once): ${hub.rotateHumanKey(rest[0]!).uiKey}`);
      return;
    }
    case "human ntfy": {
      need(2);
      hub.setNtfyTopic(rest[0]!, rest[1] === "-" ? null : rest[1]!);
      out("ok");
      return;
    }
    case "human password": {
      need(1);
      // At a terminal: typed twice with echo off; piped: one line (`read -rs pw; printf '%s' "$pw" | axos human password <name>`).
      const pw = process.stdin.isTTY ? await secretTwice() : (await readText("/dev/stdin")).replace(/\r?\n$/, "");
      hub.setPassword(rest[0]!, pw, { admin: true });
      out(`password set for ${rest[0]}; they log in with their name and it on any device.`);
      return;
    }
    case "human remove": {
      need(1);
      const r = hub.removeHuman(rest[0]!);
      out(`${rest[0]} removed: ${r.agents_removed} machine(s) revoked, every login and device gone, open invites expired${r.projects_removed.length ? `, ${r.projects_removed.join(", ")} removed (it carried no message)` : ""}. Their name is free again; history stays.`);
      return;
    }
    case "human operator": {
      need(1);
      hub.setOperator(rest[0]!, !rest.includes("--off"));
      out(rest.includes("--off") ? `${rest[0]} no longer invites people from their page.` : `${rest[0]} may invite new people from their page.`);
      return;
    }
    case "human devices": {
      const clear = rest.includes("--clear");
      need(1);
      const devices = hub.pushDevices(rest[0]!);
      if (clear) {
        for (const d of devices) hub.pushUnsubscribe(rest[0]!, d.endpoint);
        out(`${devices.length} device(s) forgotten; ${rest[0]} turns pushes on again on the page.`);
        return;
      }
      if (!devices.length) { out(`${rest[0]} has no device registered: on the page, "Notifications" turns them on (iPhone: add the page to the home screen first).`); return; }
      out(devices.map((d) => `${d.label || "a device"}: registered ${ago(d.created_at, hub.now())}, last push ${d.last_ok ? ago(d.last_ok, hub.now()) : "none yet"}`).join("\n"));
      return;
    }
    case "project add": {
      const briefFile = flag(rest, "--brief");
      const repo = flag(rest, "--repo") ?? ""; // where the code is, so an invited person's clone connects by itself
      need(1);
      const id = hub.addProject(rest[0]!, briefFile ? await readText(briefFile) : "", repo);
      console.log(`project ${hub.projectName(id)} added (id ${id})`);
      return;
    }
    case "project list": {
      for (const p of hub.db.query("SELECT id FROM projects ORDER BY owner, slug").all() as { id: string }[]) {
        const people = (hub.db.query("SELECT human FROM human_projects WHERE project = ? ORDER BY human").all(p.id) as { human: string }[]).map((h) => h.human);
        const links = hub.linkedProjects(p.id);
        // Printed as is: the id column must stay an id.
        console.log(`${p.id}  ${hub.projectName(p.id)!.padEnd(28)} people=${people.join(",") || "-"}` +
          (links.length ? ` linked=${links.map((l) => hub.projectName(l)).join(",")}` : ""));
      }
      return;
    }
    case "project brief": {
      need(2);
      hub.setProjectBrief(project(rest[0]!), await readText(rest[1]!));
      out("ok");
      return;
    }
    case "project rename": {
      need(2);
      const id = project(rest[0]!);
      hub.renameProject(id, rest[1]!);
      out(`renamed to ${hub.projectName(id)}; the old name keeps working`);
      return;
    }
    case "project remove": {
      need(1);
      const r = hub.removeProject(project(rest[0]!));
      out(`removed ${r.name}: its people, roles, links and open invites let go; the name is free`);
      return;
    }
    case "project human": {
      need(2);
      hub.addHumanToProject(rest[1]!, project(rest[0]!));
      out("ok");
      return;
    }
    case "project unhuman": {
      need(2);
      hub.removeHumanFromProject(rest[1]!, project(rest[0]!));
      out("ok");
      return;
    }
    // The first project with each of the others (Max, 2026-11-03: `project link max/enseble max/axos max/vlow max/vinea`
    // linked only the first two and said nothing of the rest). Every name is checked before anything is linked.
    case "project link": {
      need(2);
      const [first, ...others] = rest.map((r) => project(r));
      for (const o of others) {
        hub.linkProjects(first!, o);
        out(`linked ${hub.projectName(first!)} and ${hub.projectName(o)}`);
      }
      return;
    }
    case "project unlink": {
      need(2);
      const [first, ...others] = rest.map((r) => project(r));
      for (const o of others) {
        hub.unlinkProjects(first!, o);
        out(`unlinked ${hub.projectName(first!)} and ${hub.projectName(o)}`);
      }
      return;
    }
    case "project links": {
      for (const l of hub.projectLinks()) out(`${l.a} <-> ${l.b}  since ${iso(l.created_at)}`);
      return;
    }
    case "role add": {
      need(2);
      hub.defineRole(project(rest[0]!), rest[1]!);
      out("ok");
      return;
    }
    // Opens a role to every session of the project owner's person (a feedback address), or closes it with --off.
    case "role open": {
      need(2);
      const p = project(rest[0]!);
      hub.setRoleOpen(hub.projectOwner(p)!, p, rest[1]!, !rest.includes("--off"));
      out(`${rest.includes("--off") ? "closed" : "opened"} role ${rest[1]} in ${hub.projectName(p)}${rest.includes("--off") ? "" : ": every session of its owner reaches it from any of their projects"}`);
      return;
    }
    case "agent add": {
      need(3);
      const { id, token } = hub.addAgent(rest[0]!, rest[1]!, rest[2]!.split(",").filter(Boolean).map(project));
      console.log(`agent ${hub.agentLabel(id)} added (id ${id}).\nToken (shown once): ${token}`);
      return;
    }
    case "agent join": {
      need(2);
      hub.addMembership(agent(rest[0]!), project(rest[1]!));
      out("ok");
      return;
    }
    case "agent token": {
      need(1);
      out(`new token for ${rest[0]} (shown once): ${hub.rotateToken(agent(rest[0]!))}`);
      return;
    }
    case "agent revoke": {
      need(1);
      hub.revokeAgent(agent(rest[0]!));
      out(`revoked ${rest[0]}`);
      return;
    }
    case "agent list": {
      for (const a of hub.listAgents()) {
        const projects = a.projects ? a.projects.split(",").map((p) => hub.projectName(p)).join(",") : "";
        console.log(`${`${a.human}/${a.name}`.padEnd(28)} ${a.id}  ${a.revoked ? "REVOKED " : ""}projects=${projects} last_seen=${a.last_seen ? iso(a.last_seen) : "never"}`);
      }
      return;
    }
    case "events undefined":
    case "events --since": {
      const since = noun === "events" && verb === "--since" ? Number(rest[0]) : 0;
      // Ids as stored: the audit trail must not change when something is renamed.
      for (const e of hub.events(since, 100_000)) console.log(JSON.stringify({ ...e, at: iso(e.at), data: JSON.parse(e.data_json), data_json: undefined }));
      return;
    }
    default:
      console.log(USAGE);
      if (noun && noun !== "help") process.exitCode = 2;
  }
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof AxosError || (e instanceof Error && /constraint/i.test(e.message))) {
    console.error(new Hub(openDb(process.env.AXOS_DB ?? "axos.db")).display(e.message));
    process.exit(1);
  }
  throw e;
}

// A secret typed at the terminal, echo off, twice. One buffered reader (two lines pasted at once are two answers);
// echo comes back whatever happens, an interrupt included.
async function secretTwice(): Promise<string> {
  const echo = (on: boolean) => { Bun.spawnSync(["stty", on ? "echo" : "-echo"], { stdin: "inherit" }); };
  const restore = () => { echo(true); process.stdout.write("\n"); process.exit(130); };
  process.on("SIGINT", restore);
  let buffer = "";
  process.stdin.setEncoding("utf8");
  const nextLine = () => new Promise<string>((res) => {
    const take = () => { const i = buffer.indexOf("\n"); if (i < 0) return false; const line = buffer.slice(0, i).replace(/\r$/, ""); buffer = buffer.slice(i + 1); res(line); return true; };
    if (take()) return;
    const on = (d: string) => { buffer += d; if (take()) process.stdin.off("data", on); };
    process.stdin.on("data", on);
  });
  try {
    echo(false);
    process.stdout.write("Password (not shown): ");
    const a = await nextLine();
    process.stdout.write("\nAgain: ");
    const b = await nextLine();
    process.stdout.write("\n");
    if (a !== b) throw new AxosError("the two did not match");
    return a;
  } finally {
    echo(true);
    process.off("SIGINT", restore);
  }
}
