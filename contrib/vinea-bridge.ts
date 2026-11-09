#!/usr/bin/env bun
// The vinea bridge: the process that keeps the hub's health board in vinea fed (axos board connect), on its schedule.
// It is a program of the person's, outside both products. The board's widgets are pushed with the vinea command
// (AXOS_VINEA, default `vinea`), whose address and token stay in vinea's config; the numbers come from the hub with
// this machine's own token (the operator's).
//
//   bun contrib/vinea-bridge.ts          feed the health board while it runs (nothing to do without one connected)
//   bun contrib/vinea-bridge.ts --once   one feed

import { boardFeed, boardSettings } from "../plugin/bin/axos.ts";

const POLL_MS = 20_000;

if (import.meta.main) {
  const [cmd] = process.argv.slice(2);
  try {
    if (cmd === "--once") {
      const board = boardSettings();
      console.log(board ? `${(await boardFeed()).length} widget(s) written to ${board.id}` : "no board connected: axos board connect");
    } else if (cmd === undefined) {
      let boardAt = 0;
      for (;;) {
        const board = boardSettings();
        if (board && Date.now() - boardAt >= board.every_s * 1000) {
          boardAt = Date.now();
          try { await boardFeed(); } catch (e) { console.error(`${new Date().toISOString()} board ${board.id}: ${(e as Error).message}`); }
        }
        await Bun.sleep(POLL_MS);
      }
    } else throw new Error("usage: bun contrib/vinea-bridge.ts [--once]");
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
