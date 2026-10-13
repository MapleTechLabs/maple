---
"@maple/cli": patch
---

`maple start` no longer spins when a supervisor restarts it after a failure that retrying cannot fix. It exits with status 78 (tell systemd `RestartPreventExitStatus=78`), waits before exiting when the same failure repeats, and reports it to telemetry at most once an hour. A libchdb the system refuses to load now says so and names the reinstall command.
