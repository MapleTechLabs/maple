---
"@maple-dev/effect-sdk": patch
---

The server SDK now reports the `process.runtime.version` resource attribute next to `process.runtime.name`: the Node.js version on Node, `process.versions.bun` on Bun and `Deno.version.deno` on Deno. Cloudflare Workers and other edge runtimes have no meaningful runtime version and leave it unset.
