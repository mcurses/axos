import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addr, AxosError, Hub, iso, MESSAGE_TYPES, PRIORITIES, type Actor, type AgentRow } from "./hub.ts";
import { ago, renderMessages } from "./render.ts";
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

const projectArg = z.string().optional().describe("Project as '<slug>' or '<owner>/<slug>'; defaults to this session's project");
const asArg = z.string().optional().describe("Only for clients without sessions: the role you act as");

export interface Connection {
  session?: string; // session key, when the client sent one
  project?: string; // the project the client's working directory belongs to
}

export function buildMcpServer(hub: Hub, agent: AgentRow, conn: Connection = {}, signal?: AbortSignal): McpServer {
  const server = new McpServer({ name: "axos", version: VERSION }, { instructions: INSTRUCTIONS });
  const actor: Actor & { kind: "agent" } = { kind: "agent", id: agent.id, human: agent.human, session: conn.session };
  const me = conn.session ? `session:${conn.session}` : `agent:${agent.id}`;

  const rolesOf = (sender: string, p: string) => hub.rolesHeldBy(sender, p);
  const nameOf = (sender: string) => sender.startsWith("session:") ? hub.session(sender.slice(8))?.name ?? null : null;

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
    if (!pr) throw new AxosError(`say which project: this session is not tied to one; your projects: ${mine.join(", ") || "none"}`);
    if (conn.session) hub.requireScope(agent.id, pr, conn.session);
    return pr;
  };
  const boxes = (p?: string, as?: string) => hub.mailboxes(actor, as ? project(p) : p && ref(p), as);
  const render = (items: Parameters<typeof renderMessages>[0], header: string) => renderMessages(items, header, rolesOf, nameOf);

  server.registerTool("join", {
    description: "Who you are on AXOS, the project brief, its roles and who holds them, live sessions, leases, and what is waiting for you.",
    inputSchema: { project: projectArg },
  }, tool(({ project: p }) => {
    const pr = project(p);
    const now = hub.now();
    const lines: string[] = [];
    const held = conn.session ? hub.rolesHeldBy(me, pr) : [];
    lines.push(`You are ${hub.label(me)} (human: ${agent.human})${held.length ? `, holding ${held.join(", ")}` : ""}. Your projects: ${hub.projectsOf(agent.id).join(", ")}.`);
    if (held.length === 1) lines.push(`You speak as role:${held[0]}: replies, leases and questions you start belong to the role.`);
    lines.push("", `## Project ${pr}`, hub.brief(pr) || "(no brief set)");
    lines.push("", "## Roles");
    const roles = hub.roles(pr);
    lines.push(...(roles.length ? roles.map((r) => {
      const unread = hub.roleUnread(pr, r.role);
      const who = r.holder ? `${hub.label(r.holder)}${r.holder === conn.session || r.holder === agent.id ? " (you)" : ""}, since ${ago(r.since, now)}` : "vacant";
      return `- ${r.role}: ${who}${unread ? `, ${unread} unread` : ""}${r.description ? ` — ${r.description}` : ""}`;
    }) : ["(none defined; define_role creates one)"]));
    const linked = hub.linkedProjects(pr);
    if (linked.length) {
      lines.push("", "## Linked projects (message them: role:<project>/<role>, session:<name>, project:<project>)");
      lines.push(...linked.map((q) => {
        const rs = hub.roles(q).map((r) => `${r.role} (${r.holder ? hub.label(r.holder) : "vacant"})`);
        return `- ${q}: ${rs.length ? `roles ${rs.join(", ")}` : "no roles"}`;
      }));
    }
    lines.push("", "## Live sessions");
    lines.push(...hub.presence(pr).map((a) => `- ${hub.label(a.address)}${a.address === me ? " (you)" : ""}: ${a.online ? "online" : "idle"}, seen ${ago(a.last_seen, now)}${a.roles.length ? `, ${a.roles.join(", ")}` : ""}`));
    const ls = hub.leases(pr);
    lines.push("", "## Leases");
    lines.push(...(ls.live.length ? ls.live.map((l) => `- ${l.resource}: ${hub.label(l.holder)} (${l.mode}) until ${iso(l.expires_at)}${l.note ? ` — ${l.note}` : ""}`) : ["(none)"]));
    if (ls.waiting.length) lines.push(...ls.waiting.map((w) => `- waiting for ${w.resource}: ${hub.label(w.agent_id)} (${w.mode})`));
    const askers = [conn.session ?? agent.id, ...held.map((r) => `role:${pr}/${r}`)];
    const open = askers.flatMap((k) => hub.asks({ asker: k, open: true }));
    if (open.length) lines.push("", "## Your open questions to humans", ...open.map((a) => `- ask ${a.id} to ${a.human}: ${a.question.split("\n")[0]}`));
    lines.push("", `## Inbox: ${hub.unreadCount(boxes(), pr)} unread. Call inbox to read.`);
    return lines.join("\n");
  }));

  server.registerTool("projects", {
    description: "The projects you can work in, and the one this session belongs to.",
    inputSchema: {},
  }, tool(() => {
    const mine = hub.projectsOf(agent.id);
    const links = (p: string) => hub.linkedProjects(p);
    return `${mine.length ? mine.map((p) => `- ${p}${p === conn.project ? " (this session)" : ""}${links(p).length ? `, linked with ${links(p).join(", ")}` : ""}`).join("\n") : "No projects yet; create_project opens one."}` +
      (conn.project ? "" : "\nThis session is not tied to a project: its folder is not linked (axos link) and has no trusted .axos.json. See the axos skill, 'connect'.");
  }));

  server.registerTool("create_project", {
    description: "Open a new AXOS project for your human (e.g. for the repo you are in). Other humans are added by a human on the AXOS page.",
    inputSchema: {
      name: z.string().describe("lowercase, e.g. the repo name; the project is called '<your human>/<name>'"),
      brief: z.string().optional().describe("What the project is and where its rules live, in two or three sentences"),
    },
  }, tool(({ name, brief }) => {
    const id = hub.createProject(agent.id, name, brief ?? "");
    const file = JSON.stringify({ hub: hub.publicUrl || undefined, project: hub.projectName(id), id });
    return [`Project ${id} created; ${agent.human} is in it. To connect the repo, run \`axos link ${hub.projectName(id)}\` in it ` +
      "(nothing is written into the repo; each person links once per machine). For a private team repo whose every clone " +
      "should connect, you may instead commit this as .axos.json at the repo root; each person then runs `axos trust` once " +
      "in their own terminal there. Do not commit it to a public repo:\n", file];
  }));

  server.registerTool("send", {
    description: "Send a message. Addresses: role:<role>, session:<session name>, human:<name>, or project (every live session in the project). " +
      "A linked project (see join) is reached with role:<project>/<role>, session:<name> or project:<project>. " +
      "A vacant role keeps the message until someone takes it.",
    inputSchema: {
      project: projectArg,
      to: z.union([z.string(), z.array(z.string()).min(1)]).optional().describe("One address or a list; leave out when replying with re: the reply goes to whoever sent that message"),
      type: z.enum(MESSAGE_TYPES).describe("note | ask | answer | handoff | status | request | review"),
      summary: z.string().describe("One sentence a human understands without knowing any ids: what this is and what it means"),
      body: z.string().optional().describe("Detail. Link to git files rather than pasting large content."),
      re: z.number().int().optional().describe("The message id this replies to"),
      thread: z.number().int().optional(),
      as_of: z.string().optional().describe("The state this is based on, e.g. a commit sha, so a reader can tell if it is stale"),
      priority: z.enum(PRIORITIES).optional().describe("high: a message to a human is pushed to their phone; use it rarely"),
      dedupe_key: z.string().optional().describe("Sending twice with the same key delivers once"),
      as: asArg,
    },
  }, tool(({ as, ...a }) => {
    const r = hub.send({ ...actor, as }, { ...a, project: project(a.project), to: a.to === undefined ? undefined : Array.isArray(a.to) ? a.to : [a.to] });
    if (r.duplicate) return `Already sent as message ${r.id}; not sent again.`;
    const parts = [`Sent message ${r.id}.`];
    if (r.delivered_to.length) parts.push(`Delivered to ${r.delivered_to.map((d) => d.startsWith("session:") ? hub.label(d) : d).join(", ")}.`);
    if (r.waiting_for_role.length) parts.push(`Held for ${r.waiting_for_role.join(", ")} until someone takes the role.`);
    return parts.join(" ");
  }));

  server.registerTool("inbox", {
    description: "Read your messages: to this session, to roles it holds, and to your agent. Unread first, oldest first. Ack the ones you have handled.",
    inputSchema: {
      project: z.string().optional().describe("Only this project"),
      unread_only: z.boolean().optional().describe("Default true; false shows recent history, newest first"),
      limit: z.number().int().min(1).max(100).optional(),
      as: asArg,
    },
  }, tool(({ project: name, unread_only, limit, as }) => {
    const mb = boxes(name, as);
    const p = name ? ref(name) : undefined;
    const items = hub.inbox(mb, { project: p, unreadOnly: unread_only, limit });
    if (unread_only ?? true) hub.markShown(mb, items.map((m) => m.id)); // read here, so the next hook does not repeat them
    const unread = hub.unreadCount(mb, p);
    const elsewhere = p ? hub.unreadCount(mb) - unread : 0;
    const header = (unread_only ?? true)
      ? `${unread} unread${p ? ` in ${p}` : ""}${items.length < unread ? `, showing the oldest ${items.length}` : ""}.` +
        `${elsewhere ? ` ${elsewhere} more in other projects.` : ""}${items.length ? " Ack ids when handled." : ""}`
      : `Last ${items.length} messages.`;
    return render(items, header);
  }));

  server.registerTool("ack", {
    description: "Mark messages as handled so they leave your inbox. Acking is silent; do not send a reply just to confirm receipt.",
    inputSchema: { ids: z.array(z.number().int()).min(1), project: projectArg, as: asArg },
  }, tool(({ ids, project: p, as }) => {
    const mb = boxes(p, as);
    return `Acked ${hub.ack(mb, ids)} of ${ids.length}. ${hub.unreadCount(mb)} unread left.`;
  }));

  server.registerTool("wait", {
    description: "Block until a message you have not seen yet arrives (or the timeout passes), then return those messages. Only when you have nothing else to do; never to wait for a human.",
    inputSchema: { timeout_s: z.number().int().min(1).max(240).optional().describe("Default 120, at most 240"), project: projectArg, as: asArg },
  }, tool(async ({ timeout_s, project: p, as }) => {
    const mb = boxes(p, as);
    const n = await hub.wait(mb, timeout_s ?? 120, signal);
    if (!n) return `Nothing new arrived within ${timeout_s ?? 120} s.`;
    const items = hub.takeUnshown(mb, 20);
    return render(items, `${items.length} new${n > items.length ? ` (${n - items.length} more: wait again)` : ""}. Ack ids when handled.`);
  }));

  server.registerTool("thread", {
    description: "Show the whole conversation a message belongs to.",
    inputSchema: { message_id: z.number().int().optional(), id: z.number().int().optional().describe("Same as message_id") },
  }, tool(({ message_id, id }) => {
    const m = message_id ?? id;
    if (m === undefined) throw new AxosError("say which message: message_id");
    return render(hub.thread(actor, m), `Thread of message ${m}:`);
  }));

  server.registerTool("define_role", {
    description: "Create a role in the project (or update its description): a job one session does at a time, e.g. reviewer, deployer, coordinator.",
    inputSchema: { project: projectArg, role: z.string(), description: z.string().describe("One sentence: what the holder does") },
  }, tool(({ project: p, role, description }) => {
    const pr = project(p);
    if (!hub.isMember(agent.id, pr)) throw new AxosError(`you are not in project '${pr}'`);
    hub.defineRole(pr, role, description);
    return `Role ${role} in ${pr}: ${description}`;
  }));

  server.registerTool("claim_role", {
    description: "Take a role. While you hold it you read its mailbox and speak as it. A role held by another live session needs force with the human's words.",
    inputSchema: {
      project: projectArg,
      role: z.string(),
      force: z.string().optional().describe("Only for taking over from a live holder: the human's words authorising it, quoted"),
    },
  }, tool(({ project: p, role, force }) => {
    const pr = project(p);
    const r = hub.claimRole(agent.id, pr, role, force, conn.session);
    const tail = conn.session ? "Its mail now reaches you and you speak as the role." : `Pass as="${role}" to act as the role.`;
    return `You hold ${role} in ${pr}${r.took_over_from ? `, taken over from ${hub.label(r.took_over_from)}` : ""}. ${tail} ` +
      `Its mailbox has ${hub.roleUnread(pr, role)} unread. It stays yours while this session is active.`;
  }));

  server.registerTool("release_role", {
    description: "Give up a role; its mailbox, leases and open questions stay with the role for the next holder.",
    inputSchema: { project: projectArg, role: z.string() },
  }, tool(({ project: p, role }) => { hub.releaseRole(agent.id, project(p), role, conn.session); return `Released ${role}.`; }));

  server.registerTool("lease", {
    description: "Take (or renew) a lease on a shared thing before using it: file:<path>, version:<package>, server:<name>, slot:<box>. " +
      "If someone holds it you join a FIFO queue and get a message when it is yours.",
    inputSchema: {
      project: projectArg,
      resource: z.string().describe("An exact name; no globs"),
      mode: z.enum(["exclusive", "shared"]).optional(),
      ttl_s: z.number().int().min(30).max(86400).optional().describe("Default 1800; a renewal without it extends by what the lease was granted for"),
      note: z.string().optional().describe("What you are doing with it, readable by humans"),
      wait: z.boolean().optional().describe("Default true: queue if taken"),
      as: asArg,
    },
  }, tool((a) => {
    const r = hub.lease(agent.id, { ...a, project: project(a.project), session: conn.session });
    if (r.granted) return `${r.renewed ? "Renewed" : "Granted"}: you hold ${a.resource} until ${iso(r.expires_at!)}.`;
    const who = r.holders.map((h) => `${hub.label(h.holder)} (${h.mode}${h.note ? `: ${h.note}` : ""}, until ${iso(h.expires_at)})`).join("; ");
    return r.position ? `Taken by ${who || "someone ahead in the queue"}. You are number ${r.position} in the queue; a message will tell you when it is yours.`
      : `Taken by ${who}. Not queued.`;
  }));

  server.registerTool("release_lease", {
    description: "Release a lease (or leave its queue).",
    inputSchema: { project: projectArg, resource: z.string(), as: asArg },
  }, tool(({ project: p, resource, as }) => {
    const r = hub.releaseLease(agent.id, project(p), resource, as, conn.session);
    return r.released ? `Released ${resource}.` : `Left the queue for ${resource}.`;
  }));

  server.registerTool("leases", {
    description: "Who holds which lease, and who is waiting.",
    inputSchema: { project: projectArg },
  }, tool(({ project: p }) => {
    const ls = hub.leases(project(p));
    const lines = ls.live.map((l) => `- ${l.resource}: ${hub.label(l.holder)} (${l.mode}) until ${iso(l.expires_at)}${l.note ? ` — ${l.note}` : ""}`);
    lines.push(...ls.waiting.map((w) => `- waiting for ${w.resource}: ${hub.label(w.agent_id)} (${w.mode})`));
    return lines.join("\n") || "No leases.";
  }));

  server.registerTool("subscribe", {
    description: "Get a message when a commit lands on a branch, instead of polling or waiting for someone to say so. " +
      "Without sha: a message for every landing on the branch until it expires. Landings are reported by the script that " +
      "lands (`axos landed`), not by agents. A commit that already landed is answered at once.",
    inputSchema: {
      project: projectArg,
      branch: z.string().describe("e.g. staging, main"),
      sha: z.string().optional().describe("The commit to wait for, at least 7 characters; leave out for every landing"),
      remote: z.string().optional().describe("e.g. gitlab; leave out for any remote"),
      repo: z.string().optional().describe("The repository's name (last part of its remote URL); leave out for any"),
      note: z.string().optional().describe("Handed back with the message: what to do then, e.g. 'remove worktree review-3'"),
      hours: z.number().min(0.1).max(720).optional().describe("Default 24; you get a message if it expires first"),
      as: asArg,
    },
  }, tool((a) => {
    const pr = project(a.project);
    const r = hub.subscribeLanding(agent.id, {
      project: pr, branch: a.branch, sha: a.sha, remote: a.remote, repo: a.repo, note: a.note,
      ttl_s: a.hours === undefined ? undefined : Math.round(a.hours * 3600), as: a.as, session: conn.session,
    });
    const at = `${a.remote ? `${a.remote}/` : ""}${a.branch}`;
    if ("landed" in r) {
      const l = r.landed;
      return `Already landed: ${r.sha.slice(0, 10)} is on ${l.remote ? `${l.remote}/` : ""}${l.branch} (${l.repo}) since ${iso(l.at)}` +
        `${l.subject ? `: ${l.subject}` : ""}. No subscription needed.`;
    }
    return `Subscription ${r.id}: ${a.sha ? `one message when ${a.sha.slice(0, 10)} lands on ${at}` : `a message for every landing on ${at}`}` +
      `, until ${iso(r.expires_at)}.`;
  }));

  server.registerTool("unsubscribe", {
    description: "End a subscription before it fires or expires.",
    inputSchema: { project: projectArg, id: z.number().int(), as: asArg },
  }, tool(({ project: p, id, as }) => { hub.cancelSubscription(agent.id, project(p), id, as, conn.session); return `Subscription ${id} ended.`; }));

  server.registerTool("subscriptions", {
    description: "Open subscriptions in the project: who waits for which commit or branch.",
    inputSchema: { project: projectArg },
  }, tool(({ project: p }) => {
    return hub.subscriptions(project(p)).map((s) =>
      `- ${s.id}: ${hub.label(s.subscriber)} waits for ${s.sha ? s.sha.slice(0, 10) : "every landing"} on ${s.remote ? `${s.remote}/` : ""}${s.branch}` +
      `${s.repo ? ` (${s.repo})` : ""} until ${iso(s.expires_at)}${s.note ? ` — ${s.note}` : ""}`,
    ).join("\n") || "No open subscriptions.";
  }));

  server.registerTool("ask_human", {
    description: "Ask a human a question only they can decide. It is pushed to their phone with the options as buttons; the answer comes back as a message, verbatim. " +
      "Give options and your recommended default; with a deadline the default applies if nobody answers. " +
      "Humans may take hours: do not block on the answer, carry on and read it from the inbox later.",
    inputSchema: {
      project: projectArg,
      human: z.string(),
      question: z.string().describe("Self-contained: what is being decided, why it matters, what you recommend"),
      options: z.array(z.string()).optional().describe("Short answers; the first three become buttons on the phone, all show on the page"),
      default_answer: z.string().optional().describe("Your recommendation; with a deadline, what applies if nobody answers"),
      deadline_minutes: z.number().int().min(1).optional().describe("Needs default_answer"),
      as: asArg,
    },
  }, tool((a) => {
    const pr = project(a.project);
    const r = hub.askHuman(agent.id, {
      project: pr, human: a.human, question: a.question, options: a.options,
      default_answer: a.default_answer, deadline_s: a.deadline_minutes ? a.deadline_minutes * 60 : undefined, as: a.as, session: conn.session,
    });
    const to = addr(hub.seat(agent.id, pr, a.as, conn.session));
    return `Asked ${a.human} (ask ${r.ask_id})${r.pushed ? ", pushed to their phone" : ""}. ` +
      `The answer arrives in ${to.startsWith("role:") ? `the ${to.slice(5)} mailbox` : "your inbox"}. Do not wait for it: carry on.`;
  }));

  server.registerTool("presence", {
    description: "Live sessions in a project, with their roles and unread counts.",
    inputSchema: { project: projectArg },
  }, tool(({ project: p }) => {
    const now = hub.now();
    return hub.presence(project(p)).map((a) =>
      `- ${hub.label(a.address)}${a.address === me ? " (you)" : ""}: ${a.online ? "online" : "idle"}${a.bell ? " (wakes on messages)" : ""}, seen ${ago(a.last_seen, now)}, ${a.unread} unread${a.roles.length ? `, ${a.roles.join(", ")}` : ""}`,
    ).join("\n") || "Nobody is live.";
  }));

  return server;
}
