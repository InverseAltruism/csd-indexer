// CLI driver. `index` runs one sync pass and exits (good for cron / CI gates).
// `run` runs the continuous indexer loop AND serves the API in one process.
import { syncOnce, indexedHeight } from "./indexer.js";
import { checkpoint } from "./db.js";
import { CFG, host, port } from "./config.js";

async function indexLoop(forever: boolean): Promise<void> {
  for (;;) {
    try {
      const r = await syncOnce();
      const msg = `[index] tip=${r.tip} indexed=${r.to} (+${r.blocks} blocks${r.reorgs ? `, ${r.reorgs} reorg(s) depth≤${r.reorgDepth}` : ""})`;
      if (r.blocks || r.reorgs || !forever) console.log(msg);
      checkpoint();
    } catch (e) {
      console.error(`[index] ${(e as Error).message}`);
    }
    if (!forever) return;
    await new Promise((r) => setTimeout(r, CFG.pollSecs * 1000));
  }
}

const cmd = process.argv[2] ?? "index";

if (cmd === "index") {
  await indexLoop(false);
  console.log(`[index] done at height ${indexedHeight()}`);
  process.exit(0);
} else if (cmd === "run") {
  // continuous indexer + API server (REST + SSE + WS) in one process
  const { serve } = await import("./server.js");
  serve(port(), host());
  await indexLoop(true);
} else {
  console.error("usage: tsx src/cli.ts [index|run]");
  process.exit(2);
}
