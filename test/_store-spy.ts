// Not a suite (the runner globs test/*.test.ts). Wraps the store's calls wherever they run: the default store, the
// writer's (its own Postgres pool) and the store a transaction or a snapshot hands its callback, which on Postgres
// is another object over one client. `wrap` gets each call's method name and arguments, the real call and the store
// it runs on.
import type { Store } from "../src/db.js";

type Call = "run" | "get" | "all";
export type Wrap = (method: Call, args: unknown[], real: (...a: unknown[]) => Promise<unknown>, on: Store) => Promise<unknown>;

const patched = new WeakSet<Store>();   // stores whose own methods are already wrapped (SQLite hands `this` on)
function wrapped(s: Store, wrap: Wrap): Store {
  if (patched.has(s)) return s;
  return new Proxy(s, {
    get: (target, prop) => {
      const v: unknown = Reflect.get(target, prop, target);
      if (prop === "run" || prop === "get" || prop === "all") {
        const real = (v as (...a: unknown[]) => Promise<unknown>).bind(target);
        return (...a: unknown[]) => wrap(prop, a, real, target);
      }
      if (prop === "tx" || prop === "snapshot") {
        const real = (v as (fn: (d: Store) => Promise<unknown>) => Promise<unknown>).bind(target);
        return (fn: (d: Store) => Promise<unknown>) => real((d) => fn(wrapped(d, wrap)));
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** Patches `s` (the store() of the test file) and its writer's store in place; returns the undo. */
export function spyStore(s: Store, wrap: Wrap): () => void {
  const targets = [s, (s as { writer?: () => Store }).writer?.()].filter((t, i, a): t is Store => t != null && a.indexOf(t) === i);
  const undo: (() => void)[] = [];
  for (const t of targets) {
    const view = wrapped(t, wrap);
    const rec = t as unknown as Record<string, unknown>;
    for (const m of ["run", "get", "all", "tx", "snapshot"] as const) {
      const own = Object.hasOwn(rec, m), prev = rec[m];
      rec[m] = Reflect.get(view, m);
      undo.push(() => { if (own) rec[m] = prev; else delete rec[m]; });
    }
    patched.add(t);
    undo.push(() => { patched.delete(t); });
  }
  return () => { for (const u of undo.reverse()) u(); };
}
