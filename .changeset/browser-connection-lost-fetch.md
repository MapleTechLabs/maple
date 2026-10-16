---
"@maple-dev/browser": patch
---

A fetch that rejects because the page was hidden, unloading or offline while it was in flight is no longer marked as an error. Its span stays `Unset` and carries the reason in `maple.connection_lost`. A fetch that fails on a visible, online page is still an error.
