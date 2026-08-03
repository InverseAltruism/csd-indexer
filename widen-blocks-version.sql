-- csd-indexer 0.2.11, IDX-VERSION. Widen blocks.version int4 -> bigint on the production Postgres.
--
-- WHY THIS IS NEEDED AND A RESTART IS NOT ENOUGH: the DDL in src/db.ts uses CREATE TABLE IF NOT EXISTS,
-- which cannot alter an existing table. So the 0.2.11 widen only takes effect on a freshly created
-- schema; the live table keeps version as int4 until this runs. Meanwhile safeValue() clamps to int64,
-- so a header carrying a version above int4 max binds out of range, throws inside writeBlock's dbTx,
-- rolls back, the tip never advances, and the same block re-poisons every poll: a permanent wedge.
--
-- WHY BIGINT RATHER THAN CLAMPING version INTO int32: csd-codec encodes header version as u32, so a
-- clamp would store a value the node never signed for the top half of the legal domain (accept-DIFFERENT,
-- the GRX-WIRE-CLAMP-1 shape) and would newly diverge from sqlite, which stores those exactly today. The
-- live chain already carries u32 values above int4 max in the neighbouring slot (height 29960's nonce is
-- 3795422404), which is why nonce was already BIGINT.
--
-- WHY THE SCHEMA IS NAMED LITERALLY: an earlier form predicated on table_schema = current_schema(), which
-- resolves against the OPERATOR's psql search_path, not the schema the service uses
-- (CSD_INDEX_PG_SCHEMA, default public). Run from a session with any other search_path, the IF EXISTS was
-- simply false: the block completed, psql printed DO and exited 0, and the column was never widened. A
-- silent no-op that looks like a successful migration is the worst outcome available here, so a match of
-- NOTHING now raises instead.
--
-- Substitute this deployment's CSD_INDEX_PG_SCHEMA for 'public' below if it is set. The live deployment
-- does not set it, so 'public' is correct there.
--
-- Idempotent: safe to re-run. Measured 275 ms against a table at the live row count with both indexes
-- present; a second run is a 2.6 ms no-op. It rewrites blocks under an ACCESS EXCLUSIVE lock, so readers
-- block for the duration. Run it in the same window as the restart.
--
-- Run with:
--   sudo -u csdsvc psql "postgresql://csdsvc@/csd_index?host=/var/run/postgresql&port=5439" \
--     -v ON_ERROR_STOP=1 -f widen-blocks-version.sql; echo "exit=$?"
-- Wrong schema named -> raises, psql exits 3. Correct schema -> widens with a NOTICE, exits 0.

SET lock_timeout = '5s';

DO $$
DECLARE v_schema text := 'public';   -- CSD_INDEX_PG_SCHEMA
        v_type   text;
BEGIN
  SELECT data_type INTO v_type FROM information_schema.columns
    WHERE table_schema = v_schema AND table_name = 'blocks' AND column_name = 'version';

  IF v_type IS NULL THEN
    RAISE EXCEPTION 'csd-indexer migration matched NOTHING: no blocks.version column in schema %. Name this deployment''s CSD_INDEX_PG_SCHEMA and re-run.', v_schema;
  ELSIF v_type = 'integer' THEN
    EXECUTE format('ALTER TABLE %I.blocks ALTER COLUMN version TYPE BIGINT', v_schema);
    RAISE NOTICE 'csd-indexer: %.blocks.version widened integer -> bigint', v_schema;
  ELSE
    RAISE NOTICE 'csd-indexer: %.blocks.version is already %; no-op', v_schema, v_type;
  END IF;
END $$;

-- Verify by this query, never by a document. Must return exactly one row reading: public | bigint
SELECT table_schema, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'blocks' AND column_name = 'version';
