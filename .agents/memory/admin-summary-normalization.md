---
name: Admin summary normalization
description: Compatibility rule for administrator responses built from persisted profile payloads
---

Administrator summaries must pass persisted profile payloads through the canonical normalizer before validating or returning them.

**Why:** Existing database rows can predate derived response fields, so returning raw JSON can turn an otherwise healthy admin page into a schema-validation error.

**How to apply:** When adding or changing derived profile fields, reuse the same normalization path used by the public directory and keep the response contract strict.