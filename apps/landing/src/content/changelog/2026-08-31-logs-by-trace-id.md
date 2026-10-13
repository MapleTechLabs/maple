---
title: "Filter logs by trace ID"
description: "Paste a trace ID or a traceparent header into the logs search to see only that trace's logs, and jump from any trace to its logs."
date: 2026-08-31
category: logs
authors: [makisuo]
---

You can now narrow the **Logs** page to a single trace. Paste a 32-character trace ID, or a full W3C `traceparent` header copied from your own logs, into the search box. Maple turns it into a trace filter, shown as a chip you can remove. Before, the pasted ID ran a text search against log messages and returned nothing.

The filter lives in the URL, so `/logs?traceId=<id>` is a link you can share. The log list and the volume chart both scope to the trace.

The trace page also gained a **View Logs** button in its header. It shows how many logs the trace produced, appears only when there are some, and opens the Logs page already filtered to that trace.

See [Logs](/docs/explore/logs) for the search syntax.
