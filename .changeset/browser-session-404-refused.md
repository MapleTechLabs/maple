---
"@maple/browser-session": patch
"@maple-dev/browser": patch
"@maple-dev/effect-sdk": patch
---

Session replay and session events stop sending to an endpoint that answers 404 (one without those routes, such as an older Maple Local) instead of retrying on every flush for the rest of the page.
