---
name: Demo seed reconciliation
description: Demo profiles can predate current seed statuses in the development database.
---

The demo seed must reconcile status for rows explicitly marked as demonstrations instead of relying only on conflict-ignore inserts.

**Why:** Existing development rows may have been inserted earlier as candidates, which makes the public directory and demo atelier session appear empty even though the current seed declares them published.

**How to apply:** Reconcile only rows identified as demo data; never overwrite statuses or content for non-demo profiles during startup seeding.