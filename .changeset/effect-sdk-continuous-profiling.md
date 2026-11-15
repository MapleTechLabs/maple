---
"@maple-dev/effect-sdk": minor
---

Continuous CPU profiling for Node and Bun. `Maple.layer({ profiling: true })` runs the runtime's
sampling profiler with no native addon and exports OTLP profiles every window. Each sample is
linked to the span that was running, so a span can show its own flame graph. Off by default; a
runtime without a profiler (Cloudflare Workers) logs one warning and runs without it.
