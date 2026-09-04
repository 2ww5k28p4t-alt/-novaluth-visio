---
name: Chromium CDP validation exit
description: Why standalone browser validations explicitly terminate after Chromium cleanup
---

Standalone Chromium/CDP validation executables should explicitly terminate with
the scenario result after closing pages, stopping the browser process group, and
removing temporary files.

**Why:** Some Chromium versions can retain internal CDP handles even after the
browser process exits. The scenario can print every success assertion yet remain
alive until the validation runner kills it and reports a false failure.

**How to apply:** For one-shot browser validation CLIs (not reusable test
libraries), preserve normal cleanup and then explicitly exit 0 on success or 1
after reporting an error.