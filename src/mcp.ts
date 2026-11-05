import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ACK_OUTCOMES, addr, AxosError, decisionOf, Hub, when, MESSAGE_TYPES, PRIORITIES, type Actor, type AgentRow } from "./hub.ts";
import { ago, defang, FRAME_NOTE, FRAME_NOTE_SHORT, renderMessages } from "./render.ts";
import { VERSION } from "./version.ts";

// Always in every session's context, so it stays at two lines; the axos skill carries the manual.
export const INSTRUCTIONS =
  "AXOS connects the agent sessions working on the same project, across machines, accounts and people, and reaches their humans' phones. " +
  "Before your first AXOS call, load the axos skill (or call join) for how it works.";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

// show: ids to names, as this agent may see them. A tool may return [text, verbatim]: the verbatim part (a file to write)
// keeps its ids.
function wrap<A>(show: (s: string) => string, fn: (args: A) => Promise<string | [string, string]> | string | [string, string]): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      const r = await fn(args);
      return ok(Array.isArray(r) ? `${show(r[0])}${r[1]}` : show(r));
    } catch (e) {
      if (e instanceof AxosError) return { content: [{ type: "text", text: show(e.message) }], isError: true };
      throw e;
    }
  };
}

// An argument the tool does not take is refused, not dropped: a body sent as 'message' was once stored empty.
function strict<S extends z.ZodRawShape>(shape: S) {
  const known = Object.keys(shape);
  return z.strictObject(shape, {
    error: (iss) => iss.code === "unrecognized_keys"
      ? `unknown argument${iss.keys.length > 1 ? "s" : ""} ${iss.keys.join(", ")}; this tool takes ${known.join(", ") || "no arguments"}` +
        (iss.keys.some((k) => ["message", "text", "content"].includes(k)) && known.includes("body") ? ". The text goes in body" : "")
      : undefined,
  });
}

const projectArg =z.string().optional().describe("Project as '<slug>' or '<owner>/<slug>'; defaults to this session's project");
const asArg = z.string().optional().describe("Only for scripts and clients without sessions: the role you speak for");

export interface Connection {
  session?: string; // session key, when the client sent one
  project?: string; // the project the client's working directory belongs to
  human_words?: boolean; // the client compared a send with quotes_human against what the human typed (the plugin does)
}

export function buildMcpServer(hub: Hub, agent: AgentRow, conn: Connection = {}, signal?: AbortSignal): McpServer {
  const server = new McpServer({ name: "axos", version: VERSION }, { instructions: INSTRUCTIONS });
  const actor: Actor & { kind: "agent" } = { kind: "agent", id: agent.id, human: agent.human, session: conn.session, human_words: conn.human_words };
  const me = conn.session ? `session:${conn.session}` : `agent:${agent.id}`;
  // A session's folder is shown to its own person only (folder names say what someone works on).
  const mine = (a: { human: string }) => a.human === agent.human;

  const rolesOf = (sender: string, p: string) => hub.senderShownTo(agent.human, sender) ? hub.rolesHeldBy(sender, p) : [];
  const nameOf = (sender: string) => sender.startsWith("session:") && hub.senderShownTo(agent.human, sender) ? hub.session(sender.slice(8))?.name ?? null : null;

  const show = (s: string) => hub.display(s, { agent: agent.id });
  const tool = <A>(fn: (args: A) => Promise<string | [string, string]> | string | [string, string]) => wrap(show, fn);

  // A project name as the agent wrote it, among its own projects only, so nothing is learnt about anyone else's.
  const ref = (p: string): string => {
    const mine = hub.projectsOf(agent.id);
    const id = hub.projectId(p, mine);
    if (!id) throw new AxosError(`you are not a member of project '${p}'; your projects: ${mine.join(", ") || "none"}`);
    return id;
  };
  // Every tool goes through here, so a project the agent is not in is refused before anything about it is read,
  // and a session stays in its folder's project (linked projects it reaches by send alone).
  const project = (p?: string): string => {
    const mine = hub.projectsOf(agent.id);
    const pr = p ? ref(p) : conn.project || (mine.length === 1 ? mine[0] : undefined);
    if (!pr) throw new AxosError(`say which project: this session is not tied to one; your projects: ${mine.join(", ") || "none"}. ` +
      "To tie this folder to a project, your human runs `axos use <owner>/<project>` in it; the next session started there belongs to it.");
    if (conn.session) hub.requireScope(agent.id, pr, conn.session);
    return pr;
  };
  const boxes = (p?: string, as?: string) => hub.mailboxes(actor, as ? project(p) : p && ref(p), as);
  const scriptOf = (sender: string) => sender.startsWith("session:") && hub.session(sender.slice(8))?.kind === "script";
  // The full note on how to read messages once per session, as the hooks do; a one-line reminder after that (UX review
  // 2026-11-05: about 250 tokens on every inbox, thread and wait call).
  const render = (items: Parameters<typeof renderMessages>[0], header: string) => {
    let note = FRAME_NOTE;
    if (conn.session && items.length) {
      if (hub.session(conn.session)?.framed_at) note = FRAME_NOTE_SHORT;
      else hub.db.query("UPDATE sessions SET framed_at = ? WHERE key = ?").run(hub.now(), conn.session);
    }
    return renderMessages(items, header, rolesOf, nameOf, note, scriptOf);
  };
  // A session named in a reply or a receipt: its label, unless it is another person's session in a linked project,
  // which is "a session of <human>" (its name, machine and profile stay on their side of the link).
  const peer = (address: string, messageProject: string): string => {
    if (!address.startsWith("session:")) return address;
    const s = hub.session(address.slice(8));
    return hub.labelFor(address, agent.human, !!s?.project && s.project !== messageProject);
  };

  server.registerTool("join", {
    description: "Who you are on AXOS, the project brief, its roles and who holds them, live sessions, leases, and what is waiting for you.",
    inputSchema: strict({ project: projectArg }),
  }, tool(({ project: p }) => {
    const pr = project(p);
    const now = hub.now();
    const lines: string[] = [];
    const held = conn.session ? hub.rolesHeldBy(me, pr) : [];
    lines.push(`You are ${hub.label(me)} (human: ${agent.human})${held.length ? `, holding ${held.join(", ")}` : ""}. Your projects: ${hub.projectsOf(agent.id).join(", ")}.`);
    if (held.length === 1) lines.push(`You speak as role:${held[0]}: replies, leases and questions you start belong to the role.`);
    lines.push("", `## Project ${pr}`, defang(hub.brief(pr)) || "(no brief set; the owner's agents can write one with set_brief)");
    lines.push("", "## Roles");
    const roles = hub.roles(pr);
    lines.push(...(roles.length ? roles.map((r) => {
      const open = hub.roleUnread(pr, r.role);
      const who = r.holder ? `${hub.label(r.holder)}${r.holder === conn.session || r.holder === agent.id ? " (you)" : ""}, since ${ago(r.since, now)}` : "vacant";
      return `- ${r.role}: ${who}${open ? `, ${hub.mailText(`role:${pr}/${r.role}`)}` : ""}${r.description ? ` — ${r.description}` : ""}`;
    }) : ["(none defined; define_role creates one)"]));
    const linked = hub.linkedProjects(pr);
    if (linked.length) {
      lines.push("", "## Linked projects (message them: role:<project>/<role>, session:<name>, project:<project>)");
      lines.push(...linked.map((q) => {
        const rs = hub.roles(q).map((r) => `${r.role} (${r.holder ? hub.labelFor(r.holder, agent.human, true) : "vacant"})`);
        return `- ${q}: ${rs.length ? `roles ${rs.join(", ")}` : "no roles"}`;
      }));
    }
    lines.push("", "## Live sessions");
    lines.push(...hub.presence(pr).map((a) => `- ${hub.label(a.address)}${a.address === me ? " (you)" : ""}: ${a.online ? "online" : "away"}, seen ${ago(a.last_seen, now)}${a.roles.length ? `, ${a.roles.join(", ")}` : ""}`));
    const ls = hub.leases(pr);
    lines.push("", "## Leases");
    lines.push(...(ls.live.length ? ls.live.map((l) => `- ${l.resource}: ${hub.label(l.holder)} (${l.mode}) until ${when(l.expires_at)}${l.note ? ` — ${l.note}` : ""}`) : ["(none)"]));
    if (ls.waiting.length) lines.push(...ls.waiting.map((w) => `- waiting for ${w.resource}: ${hub.label(w.agent_id)} (${w.mode})`));
    const askers = [conn.session ?? agent.id, ...held.map((r) => `role:${pr}/${r}`)];
    const open = askers.flatMap((k) => hub.asks({ asker: k, open: true }));
    if (open.length) lines.push("", "## Your open questions to humans", ...open.map((a) => `- ask ${a.id} to ${a.human}: ${a.question.split("\n")[0]}`));
    lines.push("", `## Inbox: ${hub.mailText(boxes(), pr)}. Call inbox to read.`);
    return lines.join("\n");
  }));

  server.registerTool("projects", {
    description: "The projects you can work in, and the one this session belongs to.",
    inputSchema: strict({}),
  }, tool(() => {
    const mine = hub.projectsOf(agent.id);
    const links = (p: string) => hub.linkedProjects(p);
    return `${mine.length ? mine.map((p) => `- ${p}${p === conn.project ? " (this session)" : ""}${hub.isPair(p) ? ` (direct messages with ${hub.projectHumans(p).filter((h) => h !== agent.human).join(", ") || "nobody: the other person has left"}; no folder)` : ""}${hub.repo(p) ? ` (code: \`${hub.repo(p)}\`)` : ""}${links(p).length ? `, linked with ${links(p).join(", ")}` : ""}`).join("\n") : "No projects yet; create_project opens one."}` +
      (conn.project ? "" : "\nThis session is not tied to a project: its folder is not connected (axos use) and has no trusted .axos.json. See the axos skill, 'connect'.");
  }));

  server.registerTool("create_project", {
    description: "Open a new AXOS project for your human (e.g. for the repo you are in). Another person joins it when your human shares it with them on the AXOS page (Projects → Share with…, or an invite that carries the project for someone new); they accept on theirs.",
    inputSchema: strict({
      name: z.string().describe("lowercase, e.g. the repo name; the project is called '<your human>/<name>'"),
      brief: z.string().optional().describe("What the project is and where its rules live, in two or three sentences"),
      repo: z.string().optional().describe("Where the code is: the repo's git address (the origin remote, without credentials), so an invited person knows what to clone"),
    }),
  }, tool(({ name, brief, repo }) => {
    const id = hub.createProject(agent.id, name, brief ?? "", repo ?? "");
    const file = JSON.stringify({ hub: hub.publicUrl || undefined, project: hub.projectName(id), id });
    return [`Project ${id} created; ${agent.human} is in it. To connect the repo, run \`axos use ${hub.projectName(id)}\` in it ` +
      "(nothing is written into the repo; each person links once per machine). For a private team repo whose every clone " +
      "should connect, you may instead commit this as .axos.json at the repo root; each person then runs `axos trust` once " +
      "in their own terminal there. Do not commit it to a public repo:\n", file];
  }));

  server.registerTool("set_brief", {
    description: "Write the project's brief, which every session gets on join: what the project is and where its rules live. Only agents of the project's owner may.",
    inputSchema: strict({ project: projectArg, brief: z.string().describe("Two to ten lines; link to the repo's AGENTS.md rather than repeating it") }),
  }, tool(({ project: p, brief }) => {
    const pr = project(p);
    hub.setBriefAsAgent(agent.id, pr, brief);
    return `Brief of ${pr} set (${brief.trim().length} characters).`;
  }));

  server.registerTool("send", {
    description: "Send a message. Addresses: role:<role>, session:<session name>, human:<name>, project (every live session in the project), " +
      "or next (held for the next session of your human that starts in this project: a handoff before a restart). " +
      "A linked project (see join) is reached with role:<project>/<role>, session:<name> or project:<project>; any role of a project your human owns with role:<project>/<role>, linked or not. " +
      "Mail to a role waits for whoever holds it; if nobody is reading it right now (vacant, or its holder away) the result says so and who else is in the room. " +
      "To pass on what your human typed, send with quotes_human: true and their words as the body: the message stays yours, marked quotes-human=<name>.",
    inputSchema: strict({
      project: projectArg,
      to: z.union([z.string(), z.array(z.string()).min(1)]).optional().describe("One address or a list; leave out when replying with re: the reply goes to whoever sent that message"),
      type: z.enum(MESSAGE_TYPES).optional().describe("note (default) | ask | answer | handoff | status | request | review"),
      summary: z.string().optional().describe("One sentence a human understands without knowing any ids: what this is and what it means. Left out: the body's first line, if short enough"),
      body: z.string().optional().describe("Detail. Link to git files rather than pasting large content."),
      re: z.number().int().optional().describe("The message id this replies to"),
      thread: z.number().int().optional(),
      as_of: z.string().optional().describe("The state this is based on, e.g. a commit sha, so a reader can tell if it is stale"),
      priority: z.enum(PRIORITIES).optional().describe("low: wakes nobody, so it can sit for days with an idle reader; only for news nobody waits on (the default for a note to a whole project). high: pushes a human's phone; rarely"),
      dedupe_key: z.string().optional().describe("Sending twice with the same key delivers once"),
      deliver_at: z.string().optional().describe("Send later: an ISO 8601 time with its offset (2026-11-04T18:00+01:00), at most 30 days ahead. The hub holds it and sends it then to the addresses as they resolve then (a role to whoever holds it then), so it reaches its reader with this machine closed. cancel_send cancels it"),
      quotes_human: z.boolean().optional().describe("The body is what your human typed to this session, verbatim, as whole lines of one prompt (the summary, if given, one of those lines); the plugin compares it with their recent prompts. Readers see quotes-human=<name> and weigh it as your word; the message stays yours"),
      queue: z.union([z.boolean(), z.string()]).optional().describe("No effect (kept for older sessions): mail to a role always waits for its holder"),
      as: asArg,
    }),
  }, tool(({ as, queue: _queue, ...a }) => {
    // A reply may name the project of the message it answers; across a link it is still sent from this session's own.
    const across = a.re !== undefined && a.project && conn.project && hub.projectId(a.project, hub.linkedProjects(conn.project));
    const body = a.body ?? "";
    const summary = a.summary ?? (body.trim().split("\n")[0]!.trim().length <= 300 ? body.trim().split("\n")[0]!.trim() : "");
    const to = a.to === undefined ? undefined : Array.isArray(a.to) ? a.to : [a.to];
    // From a folder that belongs to no project, a person can still be reached: through the project the two share
    // (the pair project an invite made, else any). Nothing else works from such a folder.
    const person = !a.project && !conn.project && !as && to?.length && to.every((x) => x.startsWith("human:")) && new Set(to).size === 1 ? to[0]!.slice(6) : null;
    const viaPerson = person ? hub.projectWithHuman(agent.id, person) : null;
    if (person && !viaPerson) throw new AxosError(`you share no project with ${person}, so there is no way to reach them from here`);
    const sentIn = across ? conn.project! : viaPerson ?? project(a.project);
    if (viaPerson && conn.session) hub.requireMember(agent.id, viaPerson);
    let deliverAt: number | undefined;
    if (a.deliver_at !== undefined) {
      if (!/(Z|[+-]\d{2}:?\d{2})$/.test(a.deliver_at.trim())) throw new AxosError("deliver_at needs its offset (Z or +01:00), so the time is unambiguous");
      deliverAt = Date.parse(a.deliver_at);
      if (Number.isNaN(deliverAt)) throw new AxosError("deliver_at is not a time (ISO 8601, e.g. 2026-11-04T18:00+01:00)");
    }
    const r = hub.send({ ...actor, as }, { ...a, deliver_at: deliverAt, type: a.type ?? "note", summary, project: sentIn, to, to_person: !!viaPerson });
    if (r.duplicate) return `Already sent as message ${r.id}; not sent again.`;
    if (deliverAt !== undefined && !r.delivered_to.length && !r.waiting_for_role.length && r.unattended[0]?.startsWith("Scheduled")) return `Held as message ${r.id}. ${r.unattended[0]}`;
    const parts = [`Sent message ${r.id} (${body ? `summary and a ${body.length}-character body` : "summary only, no body"}).`];
    if (viaPerson) parts.push(`Sent through the project you share with ${person}; their reply reaches this session's own mailbox (check it with inbox).`);
    if (r.delivered_to.length) parts.push(`Delivered to ${r.delivered_to.map((d) => peer(d, sentIn)).join(", ")}.`);
    const roles = r.waiting_for_role.filter((w) => w.startsWith("role:"));
    if (roles.length) parts.push(`Held for ${roles.join(", ")} until someone takes the role.`);
    if (r.waiting_for_role.some((w) => w.startsWith("next:"))) parts.push(`Held in ${hub.projectName(project(a.project))} for the next session of ${agent.human} that starts there (one of theirs started in the last 30 minutes would have got it now).`);
    for (const x of r.not_sent) parts.push(`Not sent to ${x.to}: ${x.reason}`);
    // The first message from a new person's side (no project of their own yet): what else there is, once, for the agent to pass on.
    const invitedInto = hub.projectsOf(agent.id).filter((p) => !hub.isPair(p) && hub.projectOwner(p) !== agent.human);
    if (hub.messagesFrom(agent.human) === 1 && hub.projectsOf(agent.id).every((p) => hub.isPair(p) || hub.projectOwner(p) !== agent.human)) {
      parts.push(`\nThat was the first message from ${agent.human}'s side.` +
        (invitedInto.length ? ` They were invited into ${invitedInto.map((p) => `${p}${hub.repo(p) ? ` (code: \`${hub.repo(p)}\`)` : ""}`).join(", ")}: in the folder of that code, \`axos use\` connects it (it picks that project), and sessions there work with the other members'. ` : " ") +
        "What AXOS is for, so you can tell them: (1) their own sessions " +
        "on any machine find each other per project, hand work over before a restart (send to next) and take turns on shared things (lease); " +
        `(2) a question only ${agent.human} can decide reaches their phone (ask_human) and the answer comes back here; ` +
        "(3) another person joins a project when it is shared with them, and their sessions then reach it too. " +
        "To start with a repo of theirs: in that folder, say \"connect this folder to AXOS\" (create_project, then they run axos use once). " +
        `Their page${hub.publicUrl ? ` (${hub.publicUrl}/ui)` : ""} shows people, projects and questions; added to a phone's home screen it is the app.`);
    }
    parts.push(...r.unattended);
    return parts.join(" ");
  }));

  server.registerTool("cancel_send", {
    description: "Your messages held for later (send with deliver_at): with no id, lists them; with an id, cancels that one before it goes out.",
    inputSchema: strict({ id: z.number().int().optional() }),
  }, tool(({ id }) => {
    if (id !== undefined) { hub.cancelScheduled(actor, id); return `Cancelled scheduled message ${id}; it will not be sent.`; }
    const list = hub.scheduledBy(actor);
    return list.length ? list.map((m) => `${m.id}: ${when(m.deliver_at)} to ${m.to.join(", ")} in ${m.project}: ${m.summary}`).join("\n") : "No messages held for later.";
  }));

  server.registerTool("inbox", {
    description: "Read your messages: to this session, to roles it holds, and to your machine (a mailbox the sessions on this machine share, called agent in addresses). Unread first, oldest first. Ack the ones you have handled.",
    inputSchema: strict({
      project: z.string().optional().describe("Only this project"),
      unread_only: z.boolean().optional().describe("Default true; false shows recent history, newest first"),
      limit: z.number().int().min(1).max(100).optional(),
      only: z.enum(["roles", "session", "agent"]).optional().describe("Only one kind of mailbox: the roles you hold, this session's own, or your machine's shared one ('agent')"),
      as: asArg,
    }),
  }, tool(({ project: name, unread_only, limit, only, as }) => {
    const all = boxes(name, as);
    const mb = only ? all.filter((b) => b.startsWith(only === "roles" ? "role:" : `${only}:`)) : all;
    if (!mb.length) return only === "roles" ? "This session holds no role, so it has no role mail." : `No ${only} mailbox here.`;
    const p = name ? ref(name) : undefined;
    const items = hub.inbox(mb, { project: p, unreadOnly: unread_only, limit });
    const unseen = hub.unshownCount(mb, false, p);
    if (unread_only ?? true) hub.markShown(mb, items.map((m) => m.id)); // read here, so the next hook does not repeat them
    const unread = hub.unreadCount(mb, p);
    const elsewhere = p ? hub.unreadCount(mb) - unread : 0;
    // Where the unread mail is, when it spans projects.
    const spread = !p && unread ? hub.unreadByProject(mb) : [];
    const header = (unread_only ?? true)
      ? `${unread} to handle${p ? ` in ${p}` : ""}${unread ? ` (${unseen} not read before)` : ""}${spread.length > 1 ? `; by project: ${spread.map((x) => `${x.project} ${x.n}`).join(", ")}` : ""}` +
        `${items.length < unread ? `, showing the oldest ${items.length}` : ""}.` +
        `${elsewhere ? ` ${elsewhere} more in other projects.` : ""}${items.length ? " Ack ids when handled." : ""}`
      : `Last ${items.length} messages.`;
    return render(items, header);
  }));

  server.registerTool("ack", {
    description: "Mark messages as handled so they leave your inbox. Acking is silent; do not send a reply just to confirm receipt.",
    inputSchema: strict({
      ids: z.array(z.number().int()).min(1),
      outcome: z.enum(ACK_OUTCOMES).optional().describe("What became of it, shown to the sender in thread: done | declined | forwarded | noted"),
      note: z.string().optional().describe("One line for the sender's thread view, e.g. 'forwarded to lane 3' (at most 200 characters); saves a reply"),
      project: projectArg, as: asArg,
    }),
  }, tool(({ ids, outcome, note, project: p, as }) => {
    const mb = boxes(p, as);
    const r = hub.ackReport(mb, ids, outcome, note);
    const n = r.acked.length + r.earlier.length + r.missing.length;
    return [
      `Acked ${r.acked.length} of ${n}.`,
      r.earlier.length ? `Already acked before: ${r.earlier.join(", ")}.` : "",
      r.missing.length ? `Not in this session's mailboxes (wrong id, another session's or role's mail, or a project this session does not read): ${r.missing.join(", ")}.` : "",
      `Left: ${hub.mailText(mb)}.`,
    ].filter(Boolean).join(" ");
  }));

  server.registerTool("wait", {
    description: "Block until a message you have not seen yet arrives (or the timeout passes), then return those messages. Only when you have nothing else to do; never to wait for a human.",
    inputSchema: strict({ timeout_s: z.number().int().min(1).max(240).optional().describe("Default 120, at most 240"), project: projectArg, as: asArg }),
  }, tool(async ({ timeout_s, project: p, as }) => {
    const mb = boxes(p, as);
    const n = await hub.wait(mb, timeout_s ?? 120, signal);
    if (!n) return `Nothing new arrived within ${timeout_s ?? 120} s.`;
    const items = hub.takeUnshown(mb, 20);
    return render(items, `${items.length} new${n > items.length ? ` (${n - items.length} more: wait again)` : ""}. Ack ids when handled.`);
  }));

  server.registerTool("thread", {
    description: "Show the whole conversation a message belongs to.",
    inputSchema: strict({ message_id: z.number().int().optional(), id: z.number().int().optional().describe("Same as message_id") }),
  }, tool(({ message_id, id }) => {
    const m = message_id ?? id;
    if (m === undefined) throw new AxosError("say which message: message_id");
    // On the reader's own messages: how far each recipient got.
    const mine = new Set([me, ...boxes().map((b) => hub.boxKey(b)), ...hub.projectsOf(agent.id).flatMap((p) => conn.session ? hub.rolesHeldBy(me, p).map((r) => `role:${p}/${r}`) : [])]);
    const rows = hub.thread(actor, m).map((row) => mine.has(row.sender) ? { ...row, receipts: hub.receipts(row.id).map((d) =>
      `${peer(d.recipient, row.project)}: ${d.acked_at ? `${d.outcome ?? "acked"}${d.note ? ` (${d.note})` : ""}` : d.shown_at ? "read" : "unread"}`).join("; ") } : row);
    return render(rows, `Thread of message ${m}:`);
  }));

  server.registerTool("define_role", {
    description: "Create a role in the project (or update its description): a job one session does at a time, e.g. reviewer, deployer, coordinator.",
    inputSchema: strict({ project: projectArg, role: z.string(), description: z.string().describe("One sentence: what the holder does"),
      quiet: z.boolean().optional().describe("true: while vacant, this role's mail is never shown to the project's main session (a role whose work must not reach a chat session)"),
      open: z.union([z.boolean(), z.literal("hub")]).optional().describe("Only the project's owner: true names this role, with its description, at the start of every session of theirs (a feedback address; their sessions reach any role of their own projects anyway); \"hub\" (the hub's operator only) lets every person's sessions on the hub do so, and nothing else of the project; the description is shown to those sessions at start. false closes it.") }),
  }, tool(({ project: p, role, description, open, quiet }) => {
    const pr = project(p);
    if (!hub.isMember(agent.id, pr)) throw new AxosError(`you are not in project '${pr}'`);
    hub.defineRole(pr, role, description, false, agent.human);
    if (open !== undefined) hub.setRoleOpen(agent.human, pr, role, open);
    if (quiet !== undefined) hub.setRoleQuiet(pr, role, quiet);
    return `Role ${role} in ${pr}: ${description}${open === true ? ". Open: every session of yours reaches it from any project." : open === false ? ". Closed to sessions outside the project." : ""}`;
  }));

  server.registerTool("claim_role", {
    description: "Take a role. While you hold it you read its mailbox and speak as it, until you release it or your session ends. A role held by another session of your human that is away (not connected) is simply taken over. One held by an online session on this machine needs force (your reason, shown to the holder); one held by an online session on another machine becomes a question to your human (page and phone), and moves on their yes.",
    inputSchema: strict({
      project: projectArg,
      role: z.string(),
      force: z.string().optional().describe("Only for taking over from an online holder: the reason, recorded and shown to the holder (on another machine your human decides)"),
    }),
  }, tool(({ project: p, role, force }) => {
    const pr = project(p);
    const r = hub.claimRole(agent.id, pr, role, force, conn.session);
    if (r.asked) return `Not yours yet: ${role} in ${pr} is held by an online session on another machine, so ${r.asked.human} decides: asked on their page and phone (question ${r.asked.ask_id}, ten minutes, default no). You hold it once they say "let it"; the answer arrives here.`;
    const tail = conn.session ? "Its mail now reaches you and you speak as the role." : `Pass as="${role}" to act as the role.`;
    return `You hold ${role} in ${pr}${r.took_over_from ? `, taken over from ${hub.label(r.took_over_from)}` : ""}. ${tail} ` +
      `Its mailbox: ${hub.mailText(`role:${pr}/${role}`)}. It stays yours until you release it or this session ends.`;
  }));

  server.registerTool("release_role", {
    description: "Give up a role; its mailbox, leases and open questions stay with the role for the next holder.",
    inputSchema: strict({ project: projectArg, role: z.string() }),
  }, tool(({ project: p, role }) => { hub.releaseRole(agent.id, project(p), role, conn.session); return `Released ${role}.`; }));

  server.registerTool("lease", {
    description: "Take (or renew) a lease on a shared thing before using it: file:<path>, version:<package>, server:<name>, slot:<box>. " +
      "If someone holds it you join a FIFO queue and get a message when it is yours.",
    inputSchema: strict({
      project: projectArg,
      resource: z.string().describe("An exact name; no globs"),
      mode: z.enum(["exclusive", "shared"]).optional(),
      ttl_s: z.number().int().min(30).max(86400).optional().describe("Default 1800; a renewal without it extends by what the lease was granted for"),
      note: z.string().optional().describe("What you are doing with it, readable by humans"),
      wait: z.boolean().optional().describe("Default true: queue if taken"),
      as: asArg,
    }),
  }, tool((a) => {
    const r = hub.lease(agent.id, { ...a, project: project(a.project), session: conn.session });
    if (r.granted) return `${r.renewed ? "Renewed" : "Granted"}: you hold ${a.resource} until ${when(r.expires_at!)}.`;
    const who = r.holders.map((h) => `${hub.label(h.holder)} (${h.mode}${h.note ? `: ${h.note}` : ""}, until ${when(h.expires_at)})`).join("; ");
    return r.position ? `Taken by ${who || "someone ahead in the queue"}. You are number ${r.position} in the queue; a message will tell you when it is yours.`
      : `Taken by ${who}. Not queued.`;
  }));

  server.registerTool("release_lease", {
    description: "Release a lease (or leave its queue).",
    inputSchema: strict({ project: projectArg, resource: z.string(), as: asArg }),
  }, tool(({ project: p, resource, as }) => {
    const r = hub.releaseLease(agent.id, project(p), resource, as, conn.session);
    return r.released ? `Released ${resource}.` : `Left the queue for ${resource}.`;
  }));

  server.registerTool("leases", {
    description: "Who holds which lease, and who is waiting.",
    inputSchema: strict({ project: projectArg }),
  }, tool(({ project: p }) => {
    const ls = hub.leases(project(p));
    const lines = ls.live.map((l) => `- ${l.resource}: ${hub.label(l.holder)} (${l.mode}) until ${when(l.expires_at)}${l.note ? ` — ${l.note}` : ""}`);
    lines.push(...ls.waiting.map((w) => `- waiting for ${w.resource}: ${hub.label(w.agent_id)} (${w.mode})`));
    return lines.join("\n") || "No leases. A lease marks a shared thing (a version number, a deploy, a file) as yours for a while, so others wait instead of colliding (the lease tool, e.g. resource version:parser).";
  }));

  server.registerTool("subscribe", {
    description: "Get a message when a commit lands on a branch, instead of polling or waiting for someone to say so. " +
      "Without sha: a message for every landing on the branch until it expires. Landings are reported by the script that " +
      "lands (`axos landed`), not by agents. A commit that already landed is answered at once.",
    inputSchema: strict({
      project: projectArg,
      branch: z.string().describe("e.g. staging, main; any ref name works too, e.g. refs/evidence/<id>; * stands for any characters, e.g. slice/* or refs/evidence/*/verdict-*"),
      sha: z.string().optional().describe("The commit to wait for, at least 7 characters; leave out for every landing"),
      remote: z.string().optional().describe("e.g. gitlab; leave out for any remote"),
      repo: z.string().optional().describe("The repository's name (last part of its remote URL); leave out for any"),
      note: z.string().optional().describe("Handed back with the message: what to do then, e.g. 'remove worktree review-3'"),
      hours: z.number().min(0.1).max(720).optional().describe("Default 24; you get a message if it expires first"),
      subject: z.string().optional().describe("Only landings whose commit subject contains this (any case), e.g. 'slice/0600'; not with sha"),
      replace: z.number().int().optional().describe("The id of your open subscription this one takes over from (renewing it); that one ends"),
      as: asArg,
    }),
  }, tool((a) => {
    const pr = project(a.project);
    const r = hub.subscribeLanding(agent.id, {
      project: pr, branch: a.branch, sha: a.sha, remote: a.remote, repo: a.repo, note: a.note, subject: a.subject, replace: a.replace,
      ttl_s: a.hours === undefined ? undefined : Math.round(a.hours * 3600), as: a.as, session: conn.session,
    });
    const at = `${a.remote ? `${a.remote}/` : ""}${a.branch}`;
    if ("landed" in r) {
      const l = r.landed;
      return `Already landed: ${r.sha.slice(0, 10)} is on ${l.remote ? `${l.remote}/` : ""}${l.branch} (${l.repo}) since ${when(l.at)}` +
        `${l.subject ? `: ${l.subject}` : ""}. No subscription needed.`;
    }
    return `Subscription ${r.id}: ${a.sha ? `one message when ${a.sha.slice(0, 10)} lands on ${at}` : `a message for every landing on ${at}`}` +
      `${a.subject?.trim() ? ` whose subject contains "${a.subject.trim()}"` : ""}, until ${when(r.expires_at)}.` +
      `${r.replaced !== undefined ? ` Subscription ${r.replaced} has ended.` : ""}`;
  }));

  server.registerTool("unsubscribe", {
    description: "End a subscription before it fires or expires.",
    inputSchema: strict({ project: projectArg, id: z.number().int(), as: asArg }),
  }, tool(({ project: p, id, as }) => { hub.cancelSubscription(agent.id, project(p), id, as, conn.session); return `Subscription ${id} ended.`; }));

  server.registerTool("subscriptions", {
    description: "Open subscriptions in the project: who waits for which commit or branch.",
    inputSchema: strict({ project: projectArg }),
  }, tool(({ project: p }) => {
    return hub.subscriptions(project(p)).map((s) =>
      `- ${s.id}: ${hub.label(s.subscriber)} waits for ${s.sha ? s.sha.slice(0, 10) : "every landing"} on ${s.remote ? `${s.remote}/` : ""}${s.branch}` +
      `${s.repo ? ` (${s.repo})` : ""}${s.subject_filter ? ` with "${s.subject_filter}" in the subject` : ""} until ${when(s.expires_at)}${s.note ? ` — ${s.note}` : ""}`,
    ).join("\n") || "No open subscriptions. subscribe tells you when a commit or branch lands (a landing script reports it with axos landed), instead of polling.";
  }));

  server.registerTool("ask_human", {
    description: "Ask a human a question only they can decide. It is pushed to their phone, with the options as buttons on the notification or the page; the answer comes back as a message, verbatim. " +
      "Give options and your recommended default; with a deadline the default applies if nobody answers. " +
      "Humans may take hours: do not block on the answer, carry on and read it from the inbox later.",
    inputSchema: strict({
      project: projectArg,
      human: z.string(),
      question: z.string().describe("Self-contained: what is being decided, why it matters, what you recommend"),
      options: z.array(z.string()).optional().describe("Short answers; the first three become buttons on the phone, all show on the page"),
      default_answer: z.string().optional().describe("What applies at the deadline if nobody answers (your proposed answer goes in recommend)"),
      deadline_minutes: z.number().int().min(1).optional().describe("With default_answer, the default applies then; without one the ask holds: nothing proceeds, you hear it and they are asked once more"),
      remind_hours: z.number().min(0.25).max(168).optional().describe("Push the question once more after this many hours if it is still open"),
      kind: z.enum(["decide", "hands", "taste"]).optional().describe("decide: a choice only they may make; hands: an act only they can do (a login, a tap, a command on their machine); taste: their preference"),
      recommend: z.string().optional().describe("Your proposed answer, one line; shown first on the page and phone"),
      on_silence: z.enum(["hold", "proceed"]).optional().describe("Retired (0.25.5): a deadline with default_answer proceeds, one without holds. Accepted and ignored for one release"),
      waiting_cost: z.string().optional().describe("One line: what waiting costs (what stays blocked, for whom)"),
      hands: z.string().optional().describe("For kind hands: the exact command or act, and where (which machine, which page)"),
      check: z.string().optional().describe("Retired (0.25.5): keep your own check; settle with withdraw_ask. Accepted and ignored for one release"),
      images: z.array(z.string()).max(4).optional().describe(
        "Up to 4 images shown with the question on their page (a screenshot, a diagram): paths of PNG, JPEG, GIF or WebP files " +
        "inside your repo, up to 5 MB each; the AXOS plugin uploads them. Kept 30 days."),
      as: asArg,
    }),
  }, tool((a) => {
    const pr = project(a.project);
    const r = hub.askHuman(agent.id, {
      project: pr, human: a.human, question: a.question, options: a.options, images: a.images,
      default_answer: a.default_answer, deadline_s: a.deadline_minutes ? a.deadline_minutes * 60 : undefined,
      remind_s: a.remind_hours ? Math.round(a.remind_hours * 3600) : undefined, as: a.as, session: conn.session,
      decision: { kind: a.kind, recommend: a.recommend, waiting_cost: a.waiting_cost, hands: a.hands },
    });
    const to = addr(hub.seat(agent.id, pr, a.as, conn.session));
    return `Asked ${a.human} (ask ${r.ask_id})${r.pushed ? ", pushed to their phone" : ""}. ` +
      `The answer arrives in ${to.startsWith("role:") ? `the ${to.slice(5)} mailbox` : "your inbox"}. Do not wait for it: carry on.`;
  }));

  server.registerTool("asks", {
    description: "Your questions to humans and how far each got: pushed to the phone, seen on their page, reminded, answered. Open ones first.",
    inputSchema: strict({ project: projectArg }),
  }, tool(({ project: p }) => {
    const pr = project(p);
    const askers = [conn.session ?? agent.id, ...(conn.session ? hub.rolesHeldBy(me, pr).map((r) => `role:${pr}/${r}`) : [])];
    const rows = hub.asksOf(askers);
    if (!rows.length) return "You have asked no questions here.";
    return rows.map((a) => {
      const steps = [
        `asked ${when(a.created_at)}`,
        a.pushed_at ? "pushed to the phone" : "no push on record (no phone set up, or the push failed)",
        a.seen_at ? `seen on the page ${when(a.seen_at)}` : "",
        a.reminded_at ? `reminded ${when(a.reminded_at)}` : a.remind_at && a.answer === null ? `reminder at ${when(a.remind_at)}` : "",
      ].filter(Boolean);
      const d = decisionOf(a);
      const state = a.answer !== null
        ? a.answered_by?.startsWith("check") ? `${a.answer} (${when(a.answered_at!)})`
        : a.answered_by?.startsWith("default") ? `the default applied ${when(a.answered_at!)}: ${a.answer}`
          : a.answered_by?.startsWith("withdrawn") ? `withdrawn ${when(a.answered_at!)}: ${a.answer}` : `answered ${when(a.answered_at!)}: ${a.answer.split("\n")[0]}`
        : a.deadline && a.default_answer === null ? `open, holds if unanswered by ${when(a.deadline)}${a.stale_at ? " (date passed)" : ""}`
        : a.stale_at ? "open, stale (no answer for days)" : a.deadline ? `open, default "${a.default_answer}" at ${when(a.deadline)}` : "open";
      const check = "";
      return `- ask ${a.id} to ${a.human}${d.kind ? ` (${d.kind})` : ""}: ${a.question.split("\n")[0]!.slice(0, 120)}\n  ${state}; ${steps.join(", ")}${check}`;
    }).join("\n");
  }));

  server.registerTool("withdraw_ask", {
    description: "Settle your own open question without an answer because it was decided elsewhere (in a chat, a file, by events): it leaves the human's page and phone, the reminder stops, and asks shows it as withdrawn with your reason. Only the asker (its session, agent or role) can.",
    inputSchema: strict({ ask_id: z.number().int(), reason: z.string().describe("One line: where it was settled, e.g. 'answered in chat at 10:09'"),
      resolved_by_check: z.boolean().optional().describe("Retired (0.25.5): accepted and ignored for one release") }),
  }, tool(({ ask_id, reason }) => {
    hub.withdrawAsk(agent.id, ask_id, reason, conn.session);
    return `Ask ${ask_id} withdrawn: ${reason}. It is off the human's page and phone.`;
  }));

  server.registerTool("presence", {
    description: "Live sessions in a project, with their roles and what they have to handle (not acked) and not read yet.",
    inputSchema: strict({ project: projectArg }),
  }, tool(({ project: p }) => {
    const now = hub.now();
    return hub.presence(project(p)).map((a) =>
      `- ${a.address.startsWith("agent:") ? "machine " : ""}${hub.label(a.address)}${a.address === me ? " (you)" : ""}${mine(a) && a.folder ? ` in ${a.folder}` : ""}: ${a.online ? "online" : "away"}${a.wake === "wakes" ? " (wakes on messages)" : a.wake === "no" ? " (listening, but does not wake on messages)" : a.wake === "unknown" ? " (listening; whether it wakes is not known)" : ""}, seen ${ago(a.last_seen, now)}, ${a.unread ? `${a.unread} to handle (${a.unseen} not read yet)` : "nothing to handle"}${a.roles.length ? `, ${a.roles.join(", ")}` : ""}${mine(a) && a.same_tree.length ? `; shares one working tree with ${a.same_tree.join(", ")}: edits may collide` : ""}`,
    ).join("\n") || "Nobody is live.";
  }));

  return server;
}
