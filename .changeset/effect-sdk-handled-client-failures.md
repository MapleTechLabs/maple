---
"@maple-dev/effect-sdk": patch
---

Raw HTTP client spans no longer open error issues for failures the caller already handled. A 4xx client span keeps its `Error` status but no longer carries an `exception` event, so error tracking leaves the issue to the caller's span: one that does not handle the 4xx still fails and reports it. In the browser preset, a request that fails in transport while the page was hidden, unloading or offline exports as `Unset` with the reason in `maple.connection_lost`.
