---
title: "Embed any dashboard chart with an iframe"
description: "Put a live chart from a public dashboard into your own admin panel, internal tool or docs page, with theme and time range set in the URL."
date: 2026-09-17
category: dashboards
authors: [jeremyfunk]
---

Every chart on a dashboard now has **Embed chart** in its menu. It gives you a link for that one
chart and a ready-to-paste `<iframe>` snippet, in HTML and React versions. The embed runs the
chart's query each time it loads, so it shows the same live numbers as the dashboard with no
export job.

Embeds need the dashboard to be shared with **Anyone with the link**. If it isn't, the dialog
explains why and offers to make it public for you. A viewer of the embed sees only that chart,
not the rest of the dashboard or the chart's query.

The link accepts URL options: `theme=light` or `dark`, a relative `range` such as `7d`, a fixed
`from` and `to`, `refresh` in seconds, and `var-<name>` for dashboard variables.

Chart links follow their dashboard's sharing. Set the dashboard back to **Not shared** and every
embed on it stops working; share it again and the same links work again. To retire one chart's
link for good, click **Replace** in its Embed chart dialog.

Get started with [Embed charts](/docs/dashboards/embed-charts).
