---
name: Database schema reconciliation
description: Development databases can lag schema changes that are already present in the Drizzle source.
---

When a feature depends on a newly added database constraint or table, verify both the generated TypeScript declarations and the actual development database schema before treating integration-test failures as application regressions.

**Why:** A merged schema source can compile successfully while the development database still enforces an older constraint, causing misleading runtime failures.

**How to apply:** Run the library typecheck first, then compare the failing SQL constraint with the current schema/migration state; do not alter a concurrent schema task opportunistically.