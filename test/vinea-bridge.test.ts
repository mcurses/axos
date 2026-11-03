import { expect, test } from "bun:test";
import { itemsFor, sessionRows, type AxosState } from "../contrib/vinea-bridge.ts";

const now = Date.parse("2026-11-03T15:00:00Z");
const state: AxosState = {
  human: "ana", now,
  asks: [{ id: 7, message_id: 70, from: "agent:ana/mac", project: "ana/shop", question: "Ship 1.4 tonight?", options: ["ship", "wait"], default_answer: "wait", deadline: null, created_at: "2026-11-03T12:00:00Z" }],
  inbox: [
    { id: 71, from: "ci", project: "ana/shop", type: "note", priority: "normal", created_at: "2026-11-03T12:01:00Z", summary: "main is green", body: null },
    { id: 90, from: "y", project: "ana/other", type: "request", priority: "high", created_at: "2026-11-03T12:03:00Z", summary: "elsewhere", body: null },
  ],
  projects: [
    { id: "ana/shop", sessions: [
      { label: "shop-1 (ana/mac#1)", name: "shop-1", human: "ana", online: true, bell: true, unread: 2, roles: ["main"], last_seen: now },
      { label: "x", name: "old", human: "ana", online: false, bell: false, unread: 0, roles: [], last_seen: now - 3 * 86_400_000 },
      { label: "ana/mac", name: null, human: "ana", online: true, bell: false, unread: 4, roles: [], last_seen: now },
    ] },
    { id: "ana/game", sessions: [{ label: "g (ben/box#2)", name: "g", human: "ben", online: false, bell: false, unread: 0, roles: [], last_seen: now - 3_600_000 }] },
  ],
};

test("the axos list: a project's questions first, then its own unread mail, every link to the AXOS page", () => {
  const p = itemsFor("ana/shop", state, "https://axos.example.com/");
  expect(p.items.map((i) => [i.title, i.link])).toEqual([["Ship 1.4 tonight?", "https://axos.example.com/ui#m70"], ["main is green", "https://axos.example.com/ui#m71"]]);
  expect(p.items[0]!.meta![0]).toEqual({ label: "from", value: "ana/mac" });
  expect(JSON.stringify(p)).not.toContain("elsewhere");
});

test("the session map: sessions of the last day, grouped by project, another person's named", () => {
  const t = sessionRows(state, "https://axos.example.com");
  expect(t.group).toBe("project");
  expect(t.rows.map((r) => [r.project, r.session, r.state.text, r.who])).toEqual([["ana/shop", "shop-1", "online", ""], ["ana/game", "g", "away", "ben"]]);
});
