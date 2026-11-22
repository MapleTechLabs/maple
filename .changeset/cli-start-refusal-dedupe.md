---
"@maple/cli": patch
---

`maple start` under a supervisor (Docker, systemd, launchd) no longer reports the same refusal on every restart. A flag or environment variable it cannot use (a short `MAPLE_LOCAL_ACCESS_TOKEN`, a bad `--host`) now exits 78 like a dirty or stale store, so a supervisor that honours it stops retrying. A refusal is reported once a day while it repeats, even when the restarts are far apart; the backoff still applies only to tight loops.
