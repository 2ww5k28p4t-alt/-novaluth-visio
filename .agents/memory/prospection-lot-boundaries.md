---
name: Prospection lot boundaries
description: Scope decisions for concurrency protection and draft-send safety in the prospection workflow.
---

Treat duplicate-contact prevention as part of the transactional prospection
service, implemented with advisory locks rather than as a separate feature.

**Why:** The guarantee must cover the same transaction that validates and
changes a dossier; a detached implementation would leave race windows.

**How to apply:** Acquire the workshop-scoped advisory lock before checking or
changing contact eligibility in the lot 1B service.

Treat accidental draft delivery as a schema-and-architecture invariant, not a
separate sending feature.

**Why:** `delivery_allowed = false` and the absence of any delivery worker
already define the lot boundary.

**How to apply:** Keep proposal review inside lot 1B, but do not add or plan a
sender until a later lot explicitly changes both safeguards.

Treat the prospection journal as a PostgreSQL-enforced immutable audit boundary,
and make every business mutation depend atomically on its journal event.

**Why:** The creator explicitly confirmed that append-only convention is
insufficient and that a mutation reported as successful must never survive if
its journal insertion fails.

**How to apply:** Reject journal updates and deletions at the database layer,
and keep each state change plus its event in one transaction so either both
commit or both roll back.