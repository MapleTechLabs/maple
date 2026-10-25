---
"@maple-dev/effect-sdk": patch
---

The Foldkit adapter no longer reports slow `update`, `view` or patch phases while the tab is hidden. A background tab is throttled by the browser, so those timings measured the throttling rather than the app.
