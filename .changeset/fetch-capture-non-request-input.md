---
"@maple-dev/browser": patch
"@maple-dev/effect-sdk": patch
---

Network capture no longer rejects a `fetch` call that succeeded:

- `fetch` accepts anything it can stringify, such as `fetch(window.location)` or a `URL` from another frame. Capture read a `url` property those values do not have, threw after the response had arrived, and the app's `await fetch(...)` rejected with a `TypeError`. The URL is now read the way `fetch` reads it.
- A request that does not ask for `keepalive` no longer has its body encoded just to measure it.
