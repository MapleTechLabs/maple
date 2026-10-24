---
"@maple-dev/effect-sdk": patch
---

Foldkit slow-phase spans (`foldkit.update`, `foldkit.view`) carry `maple.foldkit.visible`, so a phase stretched by a hidden, throttled tab can be told apart from real main-thread cost.
