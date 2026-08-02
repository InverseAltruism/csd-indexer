// Not a suite (the runner globs test/*.test.ts). A one-shot probe: resolve CFG under whatever env the
// caller sets and print the knobs as JSON, so a test can assert config PARSING across several env values
// without the module cache pinning the first one.
import { CFG } from "../src/config.js";

process.stdout.write(JSON.stringify({
  checkpointFloor: CFG.checkpointFloor,
  scanFrom: CFG.scanFrom,
  finalDepth: CFG.finalDepth,
  pollSecs: CFG.pollSecs,
  maxAheadBlocks: CFG.maxAheadBlocks,
}));
