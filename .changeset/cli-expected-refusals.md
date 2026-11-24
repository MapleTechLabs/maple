---
"@maple/cli": patch
---

Refusals that are yours to fix no longer count as CLI failures in telemetry: `maple checkpoint` while another checkpoint or restore holds the store, a `maple start` flag or environment variable it cannot use, and a login that was denied, expired, used a spent handoff code or a token the API refused. `maple get|post|...` still records a 4xx answer, but its request span no longer closes as an error. Messages and exit codes are unchanged.
