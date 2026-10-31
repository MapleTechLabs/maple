---
"@maple-dev/effect-sdk": patch
---

The browser client's uncaught-error capture no longer reports errors thrown by browser extensions (an extension's script, or a rejection whose top frame is one) or the benign `ResizeObserver loop` notices, as `@maple/browser` already does.
