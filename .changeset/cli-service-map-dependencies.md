---
"@maple/cli": patch
---

`maple service-map` now lists the databases services call (from `db.system.name` and `db.namespace`), and with `-s <service>` that service's external HTTP, messaging and RPC calls, so dependencies that run no OpenTelemetry SDK show up in the terminal too. The JSON output is now an object: `edges`, `databases`, and `external` when `-s` is set. `-s` now keeps only the edges touching that service, and an unknown service name lists the known ones. Remote mode prints service edges only.
