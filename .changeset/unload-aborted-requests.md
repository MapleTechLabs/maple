---
"@maple-dev/effect-sdk": patch
---

Browser: requests cut off by a page unload are exported as `Unset` with `maple.connection_lost`, including the spans that passed the error up, instead of `Error`.
