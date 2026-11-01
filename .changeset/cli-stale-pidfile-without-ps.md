---
"@maple/cli": patch
---

`maple start` no longer refuses with "already running" in a container image without `ps` when a stale PID file names an unrelated live process (such as the container's init). `maple schema` commands run as PID 1 no longer mistake a dead server's PID file for a live server.
