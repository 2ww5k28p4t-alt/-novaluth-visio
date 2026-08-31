---
name: Development check constraints
description: A development database constraint can lag behind the TypeScript Drizzle schema.
---

When a Drizzle schema changes the allowed values of a PostgreSQL `CHECK`, verify the active constraint in the development database instead of assuming `drizzle-kit push` updated it.

**Why:** Schema introspection can report no pending change while an existing named check constraint still has its previous expression, causing valid application writes to fail.

**How to apply:** If a write fails a named check despite matching the source schema, inspect `pg_get_constraintdef` in development and apply the safe constraint update before rerunning integration tests. Production changes remain publish-managed.