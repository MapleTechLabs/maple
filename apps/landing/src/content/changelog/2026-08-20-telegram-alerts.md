---
title: "Send alerts to Telegram"
description: "Telegram is now a built-in alert destination, with buttons to open the alert in Maple or ask Maple AI about it."
date: 2026-08-20
category: alerts
authors: [makisuo]
---

You can now route alerts to a Telegram chat, group or channel. Until now the only option was the generic webhook destination, whose payload Telegram's Bot API can't read, so alerts could not reach Telegram at all.

On the **Alerts** page, open the **Destinations** tab, click **Add destination** and pick **Telegram**. You need a bot token from @BotFather and the ID of the chat the bot posts to. Maple checks both when you save, so a token that is wrong, or a bot that was never added to the chat, is caught then instead of when a real alert fails to arrive. The token is encrypted at rest like every other destination secret.

Each alert message has **Open in Maple** and **Ask Maple AI** buttons, and shows the alert chart as its link preview.

See [Notification destinations](/docs/alerting/notification-destinations) for step-by-step setup.
