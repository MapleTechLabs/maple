---
"@maple-dev/browser": patch
"@maple-dev/effect-sdk": patch
---

A failed export no longer fills the console:

- When an export failed (for example a browser's tracking protection blocking the ingest request), the SDK printed `flush skipped (cooldown ...)` on every flush tick of the 60s cooldown, per signal, and `flush failed` again after every failed retry. A blocked endpoint produced about 24 lines a minute for the whole session. Skipped flushes now print nothing, an outage is logged once per signal, and one `flush recovered` line follows when export works again. Buffering, restore and the 60s cooldown are unchanged.
- Console capture (session replay, breadcrumbs and `logs.captureConsole`) no longer records the SDKs' own `[maple]` and `[MapleClientSDK]` diagnostics as the app's console output, so an export failure is not counted as a session error.
