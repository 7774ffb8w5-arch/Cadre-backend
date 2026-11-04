import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
const db = new PGlite();
const sql = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8").replace(/create extension if not exists pgcrypto;/, "");
try { await db.exec(sql); console.log("schema OK"); } catch (e) { console.log("SCHEMA ERROR:", e.message); }
const r = await db.query("select count(*)::int as n from information_schema.tables where table_schema='public'"); console.log("tables:", r.rows[0].n);
const u = await db.query("select gen_random_uuid()::text as u"); console.log("uuid ok:", u.rows[0].u.length === 36);
await db.close();
