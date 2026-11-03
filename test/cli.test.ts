import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Hub } from "../src/hub.ts";

const cli = (db: string, ...a: string[]) => {
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...a], { env: { ...process.env, AXOS_DB: db } });
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode };
};

test("project link with several projects links the first with each; a wrong name links nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "axos-cli-"));
  const db = join(dir, "axos.db");
  try {
    const hub = new Hub(openDb(db), { sweep: false });
    hub.addHuman("ana");
    for (const p of ["a", "b", "c", "d"]) hub.addProject(`ana/${p}`);
    const bad = cli(db, "project", "link", "ana/a", "ana/b", "ana/nope");
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain("no project 'ana/nope'");
    expect(hub.linkedProjects(hub.projectId("ana/a")!)).toEqual([]);
    const ok = cli(db, "project", "link", "ana/a", "ana/b", "ana/c", "ana/d");
    expect(ok.code).toBe(0);
    expect(ok.out).toBe("linked ana/a and ana/b\nlinked ana/a and ana/c\nlinked ana/a and ana/d\n");
    expect(hub.linkedProjects(hub.projectId("ana/a")!).map((p) => hub.projectName(p)).sort()).toEqual(["ana/b", "ana/c", "ana/d"]);
    expect(hub.linkedProjects(hub.projectId("ana/b")!).map((p) => hub.projectName(p))).toEqual(["ana/a"]);
    expect(cli(db, "project", "unlink", "ana/a", "ana/b", "ana/c").out).toBe("unlinked ana/a and ana/b\nunlinked ana/a and ana/c\n");
    expect(hub.linkedProjects(hub.projectId("ana/a")!).map((p) => hub.projectName(p))).toEqual(["ana/d"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("role open: the owner's sessions reach it from any project; --off closes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "axos-cli-"));
  const db = join(dir, "axos.db");
  try {
    const hub = new Hub(openDb(db), { sweep: false });
    hub.addHuman("ana");
    const p = hub.addProject("ana/hq");
    hub.defineRole(p, "owner", "feedback");
    expect(cli(db, "role", "open", "ana/hq", "owner").out).toContain("opened role owner in ana/hq");
    expect(hub.openRolesOf("ana").map((r) => r.role)).toEqual(["owner"]);
    expect(cli(db, "role", "open", "ana/hq", "owner", "--off").out).toContain("closed role owner");
    expect(hub.openRolesOf("ana")).toEqual([]);
    expect(cli(db, "role", "open", "ana/hq", "nope").err).toContain("no role 'nope'");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
