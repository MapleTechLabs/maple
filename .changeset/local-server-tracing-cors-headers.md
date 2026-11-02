---
"@maple/cli": patch
---

The local server now allows the `traceparent`, `tracestate`, `baggage` and `b3` request headers from the local dashboard, so an instrumented dashboard's queries and status probes no longer fail CORS preflight.
