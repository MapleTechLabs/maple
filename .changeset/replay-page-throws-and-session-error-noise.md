---
"@maple-dev/browser": patch
"@maple-dev/effect-sdk": patch
---

Session replay no longer changes how a page's own stylesheet calls fail, and benign browser notices no longer count as session errors:

- A page whose code calls `insertRule` (or `deleteRule`, `replace`, `replaceSync`, `setProperty`, `removeProperty`) with something the browser rejects gets the browser's exception again. While a recording ran, the call returned `undefined` instead of throwing and the console showed `[maple] session replay recording failed`. CSS-in-JS libraries that insert vendor-prefixed rules and rely on catching the error hit this on every page load. The recording itself was not interrupted.
- The `ResizeObserver loop` notices and errors thrown by browser extensions are no longer recorded as session errors, so they stop counting toward a session's error total and its "has errors" filter. These are the default error filters that already keep them out of issues; `errors: { defaultFilters: false }` in `@maple-dev/browser` keeps them in both.
