// A tiny in-process event bus for streaming. The indexer publishes block/proposal/
// attestation/reorg events; the SSE + WS layers subscribe. A block's events are emitted
// once, when it is written, with the status of its depth then (`confirmed` at finalDepth or
// deeper, else `tentative`); none is re-sent as its block deepens. A `reorg` event tells
// subscribers to roll back optimistic state.
import { EventEmitter } from "node:events";

export type IndexEvent =
  | { kind: "block"; height: number; hash: string; tx_count: number; status: "tentative" | "confirmed" }
  | { kind: "proposal"; txid: string; domain: string; height: number; status: "tentative" | "confirmed" }
  | { kind: "attestation"; txid: string; proposal_id: string; attester: string; height: number; status: "tentative" | "confirmed" }
  | { kind: "reorg"; ancestor: number; depth: number };

class Bus extends EventEmitter {
  emitEvent(e: IndexEvent) { this.emit("ev", e); }
  onEvent(fn: (e: IndexEvent) => void): () => void {
    this.on("ev", fn);
    return () => this.off("ev", fn);
  }
}

// Allow many concurrent SSE/WS subscribers without the default 10-listener warning.
export const bus = new Bus();
bus.setMaxListeners(0);
