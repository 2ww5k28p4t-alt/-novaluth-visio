---
name: OpenAPI codegen compatibility
description: Generated Zod validators in this workspace cannot currently compile integer or email-format schemas.
---

Use OpenAPI `number` schemas for whole-number fields and plain `string` schemas for email fields in API contracts until the code-generation dependency is upgraded.

**Why:** The current Orval/Zod dependency combination emits `zod.int()` for OpenAPI `integer` and `zod.email()` for `format: email`, while the installed Zod API does not expose either method, causing generated validators to fail compilation.

**How to apply:** Before regenerating API clients, model count, score, price, and other whole-number contract fields as `number`; validate email presence and shape in server-side logic where needed.