---
name: Drizzle orphan cleanup prompts
description: Non-interactive Drizzle pushes can remain blocked on table-name conflict prompts even with the force flag.
---

Do not assume `drizzle-kit push --force` can remove an approved orphaned table in a non-interactive environment; table-name conflict resolution may still require a TTY.

**Why:** Drizzle Kit 0.31.10 stopped both normal and forced pushes before applying changes because its table-name conflict prompt could not render without a TTY.

**How to apply:** First complete and preserve the explicit orphan review. If removal is approved and the push remains prompt-blocked, apply only the reviewed development DDL directly, then rerun both orphan and schema synchronization checks. Production changes remain publish-managed.