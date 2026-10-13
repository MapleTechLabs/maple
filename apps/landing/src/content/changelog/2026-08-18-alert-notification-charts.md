---
title: "Alert notifications now include a chart of the metric"
description: "Slack, Discord and email alerts show the metric over the incident so far, with the threshold drawn in, so you can tell recovering from worsening."
date: 2026-08-18
category: alerts
authors: [makisuo]
---

A repeat notification used to say `4.2% > 2%` every thirty minutes, and you couldn't tell a
recovering incident from a worsening one without opening Maple.

Alert notifications in Slack, Discord and email now include a chart of the metric over the
incident so far, with the threshold drawn in. Each one also carries a text sparkline, so the trend
still shows on a lock screen, in a push preview, or in a client that doesn't load images.

The chart is drawn from the same checks the alert evaluated, so it always agrees with the value
printed above it. It also shows the rule as it was when the alert fired: renaming the rule or
changing its threshold later doesn't change a chart you already received.

Get started with [notification destinations](/docs/alerting/notification-destinations).
