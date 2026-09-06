---
name: Development check constraints
description: A development database constraint can lag behind the TypeScript Drizzle schema.
---

When a Drizzle schema changes the allowed values of a PostgreSQL `CHECK`, verify the active constraint in the development database instead of assuming `drizzle-kit push` updated it.

**Why:** Schema introspection can report no pending change while an existing named check constraint still has its previous expression, causing valid application writes to fail.

**How to apply:** If a write fails a named check despite matching the source schema, inspect `pg_get_constraintdef` in development and apply the safe constraint update before rerunning integration tests. Production changes remain publish-managed.

For a new table family with many named checks, derive the expected constraint
names and source definitions from the Drizzle table metadata instead of
maintaining a second handwritten list.

**Why:** A duplicated list immediately becomes incomplete as checks are added,
while PostgreSQL can still normalize the generated expression differently.

**How to apply:** Keep source derivation automatic, but always compare those
derived definitions with `pg_get_constraintdef` on isolated PostgreSQL; source
derivation does not replace active-database verification.