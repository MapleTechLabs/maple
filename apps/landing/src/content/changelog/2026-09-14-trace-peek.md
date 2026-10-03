---
title: "Peek at a trace without leaving the list"
description: "Click a row on the traces list to open the trace in a side sheet, then step through the list with the arrow keys."
date: 2026-09-14
category: traces
authors: [makisuo]
---

Clicking a row on the **Traces** list now opens the trace in a **peek sheet** beside the list
instead of navigating away. Triage usually means walking down a sorted list, and a full page load
per row used to cost you the sort, the scroll position and the filters each time.

The sheet shows what the trace page shows: the waterfall, timeline and flow views, and the span
detail pane.

- `↑` `↓` or `J` `K` step to the neighboring trace.
- `Enter` or **Open trace** opens the full page, keeping the span you selected.
- `Esc` closes the sheet.
- Cmd-click, Ctrl-click or middle-click a row, or click its trace ID, to open the full page
  directly.

The open trace is part of the URL, so reloading or sharing the link reopens the same view. On
narrow screens, a click still opens the full page.
