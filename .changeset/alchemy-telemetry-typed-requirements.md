---
"@maple-dev/alchemy": patch
---

`Telemetry` is generic over the requirements of the resource declarations it is given (`ResourceInput<T, Req>`, `TelemetryProps<Req>`), so they are no longer typed as `unknown`. Calls are unchanged: `Req` is inferred.
