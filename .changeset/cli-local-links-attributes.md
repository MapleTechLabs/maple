---
"@maple/cli": patch
---

Query output names its timezone: JSON timestamps are ISO-8601 UTC (`2026-10-13T16:09:29.577Z`) and table times end in `Z`. In local mode, `maple traces`, `maple slow-traces`, `maple trace` and `maple logs` include links into the local UI. `maple logs --attributes` returns every log attribute, e.g. `requestId`.
