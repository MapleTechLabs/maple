---
"@maple-dev/browser": patch
"@maple-dev/effect-sdk": patch
---

Lifecycle fixes for session replay and the flushable presets:

- Session replay uploads one chunk at a time. A chunk is cut only after the previous one is answered, so a lost chunk can no longer leave a later stored chunk that depends on a snapshot ingest never received. A page going away still sends its last chunk at once.
- Effect client: flushes on a hidden tab and on `pagehide` share the queue with every other flush. They still start immediately, but a flush after them waits for them, so two drains no longer race over the same buffers and cooldowns.
- Effect client and server `MapleFlush`: `dispose()` now ends the preset. Later `flush()` calls send nothing, spans and logs recorded through `layer` afterwards are dropped, and a second `dispose()` returns the first one's promise instead of flushing and stopping the session again.
