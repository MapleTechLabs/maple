---
"@maple-dev/alchemy": patch
"@maple/cli": patch
---

Maple Local now closes its store when the host process exits before scope teardown (another handler calling `process.exit()`, or a write to a closed stdout), so the next start no longer fails with a dirty-store error. A session sharing another session's server that finds a dirty store during takeover now logs the refusal and recovery steps once instead of retrying forever.
