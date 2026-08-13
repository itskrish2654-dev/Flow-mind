import { readdir, readFile } from "node:fs/promises";

const directory = new URL("../supabase/migrations/", import.meta.url);
const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
if (files.length === 0) throw new Error("No database migrations found.");
const names = new Set();
let previous = "";
for (const file of files) {
  if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(file)) throw new Error(`Invalid migration name: ${file}`);
  const timestamp = file.slice(0, 14);
  if (names.has(timestamp)) throw new Error(`Duplicate migration timestamp: ${timestamp}`);
  if (timestamp <= previous) throw new Error(`Migration ordering is not strictly increasing: ${file}`);
  names.add(timestamp);
  previous = timestamp;
  const sql = (await readFile(new URL(file, directory), "utf8")).trim().toLowerCase();
  if (!sql.startsWith("begin;") || !sql.endsWith("commit;")) {
    throw new Error(`Migration must be transaction-bounded: ${file}`);
  }
}
console.log(`Validated ${files.length} ordered transaction-bounded migrations.`);

