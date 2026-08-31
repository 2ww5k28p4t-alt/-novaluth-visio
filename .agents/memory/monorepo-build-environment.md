---
name: Monorepo build environment
description: Environment variables needed when validating every artifact in the workspace
---
The full workspace build must provide both `PORT` and `BASE_PATH`; Vite configuration loading for the mockup artifact fails before compilation when either variable is absent.

**Why:** The managed artifact workflows inject these values, but a manually launched root build does not.

**How to apply:** Run full build validation with an appropriate `PORT` and the mockup artifact base path (currently `/__mockup`); targeted API typechecks and builds do not need the mockup values.