// Not a suite (the runner globs test/*.test.ts). The sqlite path a test file gives CSD_INDEX_DB: a leftover of the
// same name is removed first, and the database with its -wal and -shm files is removed when the process exits.
import { rmSync } from "node:fs";

export function tmpDb(name: string): string {
  const db = `/tmp/csd-idx-${name}-${process.pid}.db`;
  const remove = () => { for (const s of ["", "-wal", "-shm"]) rmSync(db + s, { force: true }); };
  remove();
  process.once("exit", remove);
  return db;
}
