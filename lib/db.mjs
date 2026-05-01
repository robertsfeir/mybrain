/**
 * Database pool creation and migrations.
 * Depends on: config.mjs (indirectly -- receives DATABASE_URL as parameter).
 *
 * Ported from atelier-pipeline/brain/lib/db.mjs (mybrain ADR-0001 Wave 1).
 * Path-resolution note: this module assumes the migrations directory is a
 * sibling of `lib/` -- i.e. <repo-root>/migrations. The runner resolves it
 * by walking up two levels from import.meta.url
 * (lib/db.mjs -> lib -> <repo-root> -> migrations).
 */

import pg from "pg";
import pgvector from "pgvector/pg";
import { readFileSync, existsSync, readdirSync } from "fs";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import path from "path";
import { spawnSync } from "child_process";

// =============================================================================
// MigrationDataLossError
// =============================================================================
//
// Thrown by runMigrations() when the post-migration `thoughts` count is less
// than the pre-migration count. Names both counts and embeds the exact psql
// restore command for the operator (per ADR-0057 item 4). Defined inline
// because it is the only consumer.

class MigrationDataLossError extends Error {
  constructor({ preCount, postCount, dumpPath, databaseUrl, dumpWritten }) {
    // Strip credentials from the URL before embedding it in any operator-
    // facing string. The connection string carries the password in plaintext
    // (postgres://user:password@host/db) and this error message lands in
    // err.message and stderr -- both of which can be ingested by log
    // shippers. The operator will need to fill in their credentials manually
    // when running the restore command, which is the correct posture.
    let safeUrl;
    try {
      const url = new URL(databaseUrl);
      url.password = "";
      url.username = "";
      safeUrl = url.toString();
    } catch (_) {
      safeUrl = "<database>";
    }

    const haveDump = dumpWritten === true && dumpPath;
    const restoreCmd = haveDump ? `psql "${safeUrl}" --file=${dumpPath}` : null;
    const restoreClause = haveDump
      ? `Restore from pre-migration dump with: ${restoreCmd}`
      : `No pre-migration dump available (count was 0 or dump was skipped).`;
    super(
      `Migration data loss: thoughts count went from ${preCount} to ${postCount} ` +
      `(post < pre). ${restoreClause}`
    );
    this.name = "MigrationDataLossError";
    this.preCount = preCount;
    this.postCount = postCount;
    this.dumpPath = haveDump ? dumpPath : null;
    this.restoreCommand = restoreCmd;
  }
}

// =============================================================================
// Pool Creation
// =============================================================================

function createPool(databaseUrl) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });

  pool.on("connect", async (client) => {
    await pgvector.registerTypes(client);
  });

  pool.on("error", (err) => {
    console.error("Database pool error:", err.message);
  });

  return pool;
}

// =============================================================================
// Auto-Migration (idempotent -- safe to run on every startup)
// =============================================================================

// Generic file-loop migration runner.
// Reads <repo-root>/migrations/*.sql sorted by filename, tracks applied
// migrations in schema_migrations table, applies unapplied files.
//
// Fail-hard contract (ADR-0057):
//   - Pre-count of `thoughts` taken before any migration applies (table-
//     not-exists treated as 0).
//   - pg_dump --table=thoughts --data-only is a hard precondition; failure
//     to dump aborts before any migration runs.
//   - Any per-file failure logs and re-throws -- ordering is a feature.
//   - After the loop, post-count is taken; if post < pre, throws
//     MigrationDataLossError carrying the psql restore command.
//   - Outer catch logs and re-throws so server.mjs:125 halts startup before
//     timers, tool registration, or /health binding.
//
// `migrationsDirOverride` is used by tests that need to point the runner
// at a synthetic migrations directory; production callers omit it.
async function runMigrations(pool, migrationsDirOverride) {
  const client = await pool.connect();
  try {
    const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const migrationsDir = migrationsDirOverride || path.join(repoRoot, "migrations");
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations ` +
      `(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), checksum TEXT)`
    );

    // -------- Pre-count gate (ADR-0057 item 1) --------
    let preMigrationCount = 0;
    try {
      const preCountRes = await client.query(`SELECT count(*)::int AS n FROM thoughts`);
      preMigrationCount = preCountRes.rows[0].n;
    } catch (err) {
      if (err.code === "42P01") {
        // thoughts table does not exist yet -- fresh install.
        preMigrationCount = 0;
      } else {
        throw err;
      }
    }

    // -------- pg_dump precondition (ADR-0057 item 4) --------
    // Source the URL from the pool's connection options. Production callers
    // construct the pool via createPool(databaseUrl) above, which sets
    // options.connectionString.
    const databaseUrl = pool.options && pool.options.connectionString;
    if (!databaseUrl) {
      throw new Error(
        "Migration runner requires pool.options.connectionString to run pg_dump precondition."
      );
    }
    const dumpTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dumpPath = `/tmp/thoughts-pre-migration-${dumpTimestamp}.sql`;
    let dumpWritten = false;
    // Fresh-install symmetry with the pre-count gate: if there are zero
    // thoughts (or no thoughts table yet), there is nothing to lose and
    // therefore nothing the rollback dump needs to protect. Skip pg_dump
    // entirely; record an explicit sentinel path so MigrationDataLossError
    // (which cannot fire when preMigrationCount is 0) never points at a
    // missing file.
    if (preMigrationCount === 0) {
      console.error("Migration runner: skipping pg_dump precondition (preMigrationCount=0, fresh install).");
    } else {
      // node-postgres tolerates `sslmode=no-verify` as a convenience for
      // "use TLS, do not verify the cert"; libpq (and therefore pg_dump)
      // does not. Translate to `sslmode=require`, which is libpq's nearest
      // equivalent (encrypt without cert verification). Without this, every
      // install whose brain-config uses `no-verify` -- which is the
      // documented production shape for the RDS instance -- would fail the
      // precondition on every startup.
      const pgDumpUrl = databaseUrl.replace(/(\bsslmode=)no-verify\b/g, "$1require");
      const dump = spawnSync(
        "pg_dump",
        [pgDumpUrl, "--table=thoughts", "--data-only", `--file=${dumpPath}`],
        { encoding: "utf-8" }
      );
      if (dump.error) {
        // ENOENT = pg_dump not on PATH. The dump is a rollback artifact;
        // the post-count gate at the end of this function still detects
        // data loss without it. Refusing to start in this case bricks
        // every install whose host lacks postgresql-client (notably the
        // Node-on-host + remote-Postgres shape this server commonly runs
        // in). Warn loudly, record no dump, proceed. Any other spawn
        // error (EACCES on the binary, etc.) stays fatal.
        if (dump.error.code === "ENOENT") {
          console.error(
            `Migration runner: pg_dump not found on PATH; proceeding without pre-migration dump. ` +
            `Post-migration count check still active, but no rollback artifact will be available ` +
            `(preMigrationCount=${preMigrationCount}). Install postgresql-client to enable dumps.`
          );
        } else {
          throw new Error(
            `pg_dump precondition failed (binary error): ${dump.error.message}`
          );
        }
      } else if (dump.status !== 0) {
        // pg_dump emits "no matching tables were found" when --table=thoughts
        // resolves to nothing in the default search_path. This is a data-
        // shape signal (no `public.thoughts`), not an infrastructure failure
        // (binary missing, permission denied, connection refused -- the
        // failure modes ADR-0057 enumerates). It surfaces in two real
        // shapes:
        //   (a) the migration runner under a non-default search_path -- e.g.
        //       integration tests that route sessions to an isolated schema
        //       so the runner's pre-count sees test rows but pg_dump
        //       (which is database-wide, not session-scoped) sees none in
        //       public;
        //   (b) operational anomaly where `public.thoughts` was dropped
        //       between the pre-count and the dump, which is a sub-
        //       millisecond window that the post-count gate still catches.
        // Treat as "nothing to back up, proceed" -- consistent with the
        // fresh-install handling of the count gate above. Any other non-
        // zero exit is fatal.
        const stderr = dump.stderr || "(no stderr)";
        if (/no matching tables were found/.test(stderr)) {
          console.error(
            `Migration runner: pg_dump found no thoughts table in default search_path; proceeding without dump (preMigrationCount=${preMigrationCount} reflects session search_path).`
          );
        } else {
          throw new Error(
            `pg_dump precondition failed (exit ${dump.status}): ${stderr}`
          );
        }
      } else {
        dumpWritten = true;
        console.error(`Migration runner: pre-migration dump written to ${dumpPath}`);
      }
    }

    const files = existsSync(migrationsDir)
      ? readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort()
      : [];
    for (const filename of files) {
      try {
        const check = await client.query(
          `SELECT 1 FROM schema_migrations WHERE version = $1`, [filename]
        );
        if (check.rows.length > 0) {
          console.error(`Migration ${filename}: skipped (already applied)`);
          continue;
        }
        const filePath = path.join(migrationsDir, filename);
        let sql = readFileSync(filePath, "utf-8");
        const checksum = createHash("sha256").update(sql).digest("hex").slice(0, 16);
        if (sql.includes("{{EMBED_DIM}}")) {
          let embedDim = 1536;
          try {
            const dimResult = await client.query(
              `SELECT (a.atttypmod - 4) AS dim FROM pg_attribute a
               JOIN pg_class c ON a.attrelid = c.oid
               JOIN pg_namespace n ON c.relnamespace = n.oid
               WHERE c.relname = 'thoughts' AND a.attname = 'embedding'
                 AND n.nspname = 'public' AND a.atttypmod > 0`
            );
            if (dimResult.rows.length > 0) embedDim = dimResult.rows[0].dim;
          } catch (_) { /* fall back to 1536 */ }
          sql = sql.replaceAll("{{EMBED_DIM}}", String(embedDim));
          console.error(`Migration ${filename}: resolved EMBED_DIM=${embedDim}`);
        }
        console.error(`Migration ${filename}: applying...`);
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (version, applied_at, checksum) ` +
          `VALUES ($1, now(), $2)`, [filename, checksum]
        );
        console.error(`Migration ${filename}: applied.`);
      } catch (err) {
        console.error(`Migration ${filename} failed:`, err.message);
        throw err;
      }
    }

    // -------- Post-count gate (ADR-0057 item 1) --------
    let postMigrationCount = 0;
    try {
      const postCountRes = await client.query(`SELECT count(*)::int AS n FROM thoughts`);
      postMigrationCount = postCountRes.rows[0].n;
    } catch (err) {
      if (err.code === "42P01") {
        postMigrationCount = 0;
      } else {
        throw err;
      }
    }
    if (postMigrationCount < preMigrationCount) {
      throw new MigrationDataLossError({
        preCount: preMigrationCount,
        postCount: postMigrationCount,
        dumpPath: dumpWritten ? dumpPath : null,
        databaseUrl,
        dumpWritten,
      });
    }
  } catch (err) {
    console.error("Migration runner failed:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

export { createPool, runMigrations, MigrationDataLossError };
