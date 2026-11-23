---
"@maple-dev/effect-sdk": patch
---

The SDK no longer depends on `std-env`: runtime and hosting provider detection for the `cloud.*`, `faas.*`, `process.runtime.*` and `os.type` resource attributes is built in, with the same rules and results. Environment variables are read only as detection needs them, and one that cannot be read (for example denied by Deno's `--deny-env`) counts as unset instead of failing telemetry startup. The package now has no runtime dependencies besides its `effect` peer.
