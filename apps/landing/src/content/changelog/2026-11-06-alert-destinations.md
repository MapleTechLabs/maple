---
title: "Send alerts to Microsoft Teams, Google Chat, incident.io and Linear"
description: "Four new alert destinations, plus Discord for every organization and the Maple bot in Hazel."
date: 2026-11-06
category: alerts
authors: [makisuo]
---

Alert rules can now notify more of the tools your team already works in:

- **Microsoft Teams.** Alerts post to a channel through a Workflows webhook, as a card with the
  state, severity, group, chart and **Open in Maple** and **Ask Maple AI** buttons.
- **Google Chat.** Alerts post to a space as a card with the chart. A resolve or reminder replies
  in the thread its trigger started.
- **incident.io.** Maple raises an alert on an HTTP alert source and resolves it when the incident
  clears. The rule, severity, value and group come along as metadata your routes can match on.
- **Linear.** Instead of a message, Maple keeps one issue per rule and group in the team you pick.
  A repeat fire comments on it, a resolve comments and leaves it open for your team to close, and
  a fire within 24 hours of closing reopens it. Add Linear to a rule's critical tier only to
  ticket just the serious incidents.

The **Discord** integration is now open to every organization, and the Maple bot is available in
**Hazel**. In both, alerts post to a channel and you can ask Maple questions in a thread.

Every destination has a **Send test** button. Set them up from the **Routing** tab in Alerts, and
see [Notification destinations](/docs/alerting/notification-destinations) for each one.
