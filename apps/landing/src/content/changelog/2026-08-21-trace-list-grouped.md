---
title: "The trace list shows one row per trace"
description: "Each row is now a whole trace with its span count and every service it touched, and single-span noise is hidden by default."
date: 2026-08-21
category: traces
authors: [makisuo]
---

The **Traces** page used to list entry-point spans, so a request that crossed four services appeared as four rows. It now shows **one row per trace**, with the real span count in a new **Spans** column, the full wall-clock duration, and every service the trace touched.

Single-span traces that aren't entry points, such as mobile screen breadcrumbs and orphaned client spans, are now hidden by default because they crowded out real requests. Nothing is hidden silently: the table footer says how many traces were hidden and has a link to show them, and the **Hide Single-Span Noise** toggle in the sidebar turns the filter off.

Mobile screen traces also show their screen name, so they no longer read as a column of identical `ui.screen` rows.

See [Traces](/docs/explore/traces) for all list filters.
