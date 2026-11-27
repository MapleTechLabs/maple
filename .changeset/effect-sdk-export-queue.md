---
"@maple-dev/effect-sdk": minor
---

`Maple.layer` (server and browser) takes `maxQueueSize` and `onDrop`. Since Effect 4.1.6 the OTLP exporter holds at most 2048 spans and 2048 log records waiting to export (or `maxBatchSize`, if larger) and drops new ones past that, which happens while the ingest endpoint is unreachable or slower than the app. `maxQueueSize` changes the limit, and `onDrop` receives `{ signal, count, total }` for each drop. Without `onDrop` the SDK now warns on `console` when a signal's dropped total reaches 1, 10, 100 and so on, where before the drops were silent. The `ExportDrop` type is exported from `@maple-dev/effect-sdk/server` and `/client`.
