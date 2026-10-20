---
"@maple-dev/effect-sdk": minor
---

New `@maple-dev/effect-sdk/foldkit` entry point for Foldkit apps. `MapleFoldkit.make(config).instrument(appConfig)` wraps a `Runtime.makeApplication` config: Command spans are grouped under the page load or navigation that caused them, Commands that finished without a child span (focus, scroll, hover delays) are dropped, Command args export as `maple.foldkit.arg.<key>`, only ids and flags unless allowed by name, runtime crashes are reported with the recent Message tags, and slow `update`, `view` and DOM patch phases become spans.
