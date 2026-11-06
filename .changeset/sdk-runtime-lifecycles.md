---
"@maple-dev/browser": patch
"@maple-dev/effect-sdk": patch
---

Lifecycle fixes for session replay and the flushable presets:

- Session replay uploads one chunk at a time. A chunk is cut only after the previous one is answered, so a lost chunk can no longer leave a later stored chunk that depends on a snapshot ingest never received. A page going away still sends its last chunk at once.
- Effect client: flushes on a hidden tab and on `pagehide` join the queue every other flush uses. They still start at once, alongside a flush already in flight, and any flush called after them now waits for them instead of running over them.
- Effect client and server `MapleFlush`: `dispose()` now ends the preset. `flush()` calls from the moment `dispose()` starts send nothing, and what is recorded through `layer` during or after the final flush, or what that flush failed to send, is dropped. A second `dispose()` returns the first one's promise instead of flushing and stopping the session again.
