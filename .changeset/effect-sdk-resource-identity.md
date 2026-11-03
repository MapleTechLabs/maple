---
"@maple-dev/effect-sdk": patch
---

Read `service.name` and `service.version` from `OTEL_RESOURCE_ATTRIBUTES` when no explicit name or version is set, instead of reporting the service as `unknown`. An explicit `attributes` entry beats the environment, and each key is exported once. All-digit versions such as date build numbers are no longer stamped as `vcs.ref.head.revision`.
