---
name: Gateway page-reading boundary
description: Security rationale that must remain intact when extending NovaLuth discovery or third-party provider calls.
---

Any NovaLuth feature that retrieves public pages must connect to the exact public IP address it validated, while preserving the original HTTP Host and TLS SNI. Every redirect repeats DNS, robots.txt, TDM, and pacing checks. Policy uncertainty defers the read rather than allowing it.

**Why:** Separate DNS validation followed by a hostname-based fetch leaves a DNS-rebinding window. Simplified or fail-open robots/TDM handling can also bypass a site's explicit restrictions.

**How to apply:** Keep replay protection, daily quotas, and domain pacing atomic in shared storage. Strip sensitive URL parts and gate/redact all provider-bound text. Legal refusals must never trigger an external fallback.