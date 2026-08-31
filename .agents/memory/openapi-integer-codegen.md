---
name: OpenAPI codegen compatibility
description: Generated Zod validators in this workspace cannot currently compile integer or email-format schemas.
---

Use OpenAPI `number` schemas for whole-number fields and plain `string` schemas for email fields in API contracts until the code-generation dependency is upgraded.

**Why:** The current Orval/Zod dependency combination emits `zod.int()` for OpenAPI `integer` and `zod.email()` for `format: email`, while the installed Zod API does not expose either method, causing generated validators to fail compilation.

**How to apply:** Before regenerating API clients, model count, score, price, and other whole-number contract fields as `number`; validate email presence and shape in server-side logic where needed.

When adding a new operational state to an API response, update the OpenAPI enum first, regenerate both Orval outputs, and add the corresponding UI handling before the final typecheck.

**Why:** Generated response validation rejects newly emitted enum values until the contract is regenerated, and typed client consumers can otherwise fail to build even when the server behavior is correct.

**How to apply:** Treat the OpenAPI spec, generated Zod/client files, server state union, and visible status mapping as one change set.