---
name: Inline TypeScript command resolution
description: Import-resolution behavior to account for when running one-off tsx evaluations in the monorepo.
---

Inline `tsx -e` commands inherit module resolution from the package that invokes them; changing `process.cwd()` afterward does not reliably make workspace aliases or package dependencies resolvable.

**Why:** A one-off local collection verification initially failed on package-alias and dependency resolution even though the application itself loaded correctly.

**How to apply:** Prefer the package's normal test runner for one-off checks, or use explicit file URLs for source imports and keep dependency imports within the invoking package's resolution context.