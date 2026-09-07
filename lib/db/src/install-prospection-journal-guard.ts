import { readFile } from "node:fs/promises";
import pg from "pg";

const { Pool } = pg;

/** Apply non-Drizzle PostgreSQL objects required by the prospection schema. */
export async function installProspectionJournalGuard() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL est requis pour installer la garde du journal.");
  }
  const sql = await readFile(
    new URL("../migrations/0001_prospection_journal_immutable.sql", import.meta.url),
    "utf8",
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("/install-prospection-journal-guard.ts")) {
  void installProspectionJournalGuard();
}