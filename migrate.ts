// One-shot schema migration: applies db/schema.sql (idempotent) and exits. Run before the server starts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "db", "schema.sql"), "utf8");
const client = new pg.Client({ connectionString: url });
await client.connect();
try { await client.query(sql); console.log("schema applied"); }
catch (e) { console.error("schema failed:", (e as Error).message); process.exitCode = 1; }
finally { await client.end(); }
