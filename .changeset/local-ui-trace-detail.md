---
"@maple/cli": patch
---

The local trace page has a real header: the root span as the title, then total duration, span and service counts, status, HTTP code, environment, a copyable trace ID and the per-service time share. The span panel shows where the span sits in the trace, Escape closes it, and loading shows the page's shape instead of a spinner. The traces list gains a Status column. Fixes HTTP status codes going missing for apps on the current HTTP semantic conventions (`http.response.status_code`).
