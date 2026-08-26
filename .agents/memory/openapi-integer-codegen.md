---
name: OpenAPI integer codegen compatibility
description: Generated Zod validators in this workspace cannot currently compile integer schemas.
---

Use OpenAPI `number` schemas for whole-number fields in API contracts until the code-generation dependency is upgraded.

**Why:** The current Orval/Zod dependency combination emits `zod.int()` for OpenAPI `integer`, while the installed Zod API does not expose that method, causing generated validators to fail compilation.

**How to apply:** Before regenerating API clients, model count, score, price, and other whole-number contract fields as `number`; preserve integer checks in server-side logic where needed.