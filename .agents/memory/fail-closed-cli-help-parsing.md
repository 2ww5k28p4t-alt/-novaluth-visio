---
name: Fail-closed CLI help parsing
description: Safe shell patterns for inventories derived from external command help output
---

When a shell safety check builds an inventory from an external CLI, capture the
CLI output with a status-checked command substitution before parsing it. Validate
the expected section structure and reject empty or malformed output; do not rely
on a process substitution to propagate the producer's failure.

**Why:** A failed CLI or parser can otherwise look like an empty inventory and
silently remove the safety check instead of stopping it.

**How to apply:** Use this pattern for future command, alias, option, or similar
inventories derived from Drizzle Kit or another external executable.