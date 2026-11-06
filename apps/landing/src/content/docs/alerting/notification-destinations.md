---
title: "Notification destinations"
description: "Route Maple alerts to Slack, email, PagerDuty, incident.io, Discord, Telegram, Google Chat, Microsoft Teams, Hazel, Linear or any HTTP endpoint. How to add a destination, send a test, and get the right credentials for each provider."
group: "Alerting"
order: 4
---

A **notification destination** is where Maple delivers an alert when one of your rules fires. You add a destination once and attach it to any number of [alert rules](/docs/alerting/alert-rules). When a rule opens an incident, Maple sends a `trigger`. When the incident resolves, it sends a `resolve`. See [Incidents](/docs/alerting/incidents) for when each is sent.

Destinations live under **Destinations** on the **Routing** tab of the **Alerts** page. Click **New destination** at the top of the page, pick a provider, and fill in the **Connection** fields. You can also create one from **Add destination** while editing a rule. Only organization admins can add, edit or delete destinations. Provider credentials are encrypted at rest and never returned to the browser after they are saved.

## Sending a test

Every destination on the **Routing** tab has a **Test** button. It delivers a sample alert through the same code path that delivers real alerts, so it confirms your credentials before you attach the destination to a rule.

If a test fails, Maple shows the provider's own rejection reason in the toast and on the destination's row. For example, a bad PagerDuty key reports `PagerDuty delivery failed with 400: Invalid routing key`.

## Failed deliveries

A delivery that fails with an error retrying cannot fix, such as a rejected credential, counts against the destination. After 3 such failures in a row, Maple disables the destination and marks it **auto-disabled** on the **Routing** tab. A successful delivery resets the count. Fix the credential, send a test, and turn the row's switch back on.

## Slack

Link your Slack workspace to Maple, then choose the channel alerts go to. Maple posts through the linked workspace's bot. Incoming-webhook URLs are not supported.

1. Open **Settings → Integrations → Slack** and connect your workspace. See the [Slack integration](/docs/integrations/slack).
2. On the **Routing** tab, click **New destination** and pick the linked workspace.
3. Pick a **Channel** and save.

## Email

Send alerts by email to members of your Maple organization.

1. Click **New destination** and pick **Email**.
2. Under **Recipients**, select up to 10 members of the organization.
3. Save, then click **Test** on the destination's row.

Recipients must be members of the organization. Maple looks up each member's email address when you save, so you cannot enter an arbitrary address. To alert a distribution list or an external address, use a [Webhook](#webhook) destination.

Email always uses Maple's built-in message format. A rule's **Message template** does not apply to it.

## PagerDuty

Maple triggers PagerDuty incidents through the **Events API v2**. It needs an Events API v2 **integration key** (also called a routing key): a 32-character string scoped to one PagerDuty service.

> A PagerDuty **REST API token** (from _User Settings_ or _API Access Keys_) does not work here. It fails the test with `PagerDuty delivery failed with 400: Invalid routing key`. The REST API manages PagerDuty itself. The Events API is what Maple posts alerts to.

To get the right key:

1. In PagerDuty, go to **Services → Service Directory** and open (or create) the service that should receive these alerts.
2. Open the **Integrations** tab.
3. Click **Add integration** and choose **Events API v2**.
4. Copy that integration's **Integration Key** (32 characters).
5. Paste it into Maple's **Integration key** field, save, and click **Test**.

See PagerDuty's [services and integrations guide](https://support.pagerduty.com/main/docs/services-and-integrations) for screenshots.

| Field               | Notes                                                            |
| ------------------- | ---------------------------------------------------------------- |
| **Integration key** | The 32-character Events API v2 routing key from the steps above. |

Maple sends each `trigger` with a stable `dedup_key` and a matching `resolve` when the incident closes, so PagerDuty groups the lifecycle into one incident.

## incident.io

Raise alerts on an incident.io HTTP alert source. Maple sends `firing` on a trigger and `resolved` when the incident clears, under one deduplication key per rule and group, so a resolve closes the alert its trigger opened. Your alert routes decide whether an alert pages someone or opens an incident.

1. In incident.io, add an alert source, pick **HTTP**, and choose the **Default** payload.
2. Copy the ID at the end of the source's URL (`https://api.incident.io/v2/alert_events/http/<ID>`) into **Alert source config ID**, and its secret into **Token**. The token is write-only: it is never returned after saving.

| Field                      | Notes                                                             |
| -------------------------- | ----------------------------------------------------------------- |
| **Alert source config ID** | e.g. `01GW2G3V0S59R238FAHPDS1R66`. Not a secret.                  |
| **Token**                  | The source's secret, sent as `Authorization: Bearer`. Write-only. |

Each event carries the rule, severity, signal, value, threshold, group and links to Maple in `metadata`, so routes and attributes can match on them. A rule with a warning and a critical tier raises critical under its own key, so an escalation pages again even when the warning alert was acknowledged. **Test** opens an alert and resolves it straight away; if the source's route creates incidents automatically, the test can create one too. incident.io accepts 120 events a minute per alert source.

## Discord

Post alerts to a Discord channel through an incoming webhook.

1. In Discord, open **Channel settings → Integrations → Webhooks → New Webhook**.
2. Copy the webhook URL (`https://discord.com/api/webhooks/...`) into the **Discord webhook URL** field.

## Google Chat

Post alerts to a Google Chat space through an incoming webhook. Each alert is a card with the summary, severity, chart and links back to Maple, and a resolve or reminder replies in the thread its trigger started.

1. In Google Chat, open the space, then **Apps & integrations → Webhooks → Add webhook**. Webhooks are available in Google Workspace accounts; an admin may need to allow them.
2. Copy the webhook URL (`https://chat.googleapis.com/v1/spaces/.../messages?key=...&token=...`) into the **Google Chat webhook URL** field. The `key` and `token` in it are the credential, so treat the URL as a secret.

## Microsoft Teams

Post alerts to a Teams channel through a Workflows webhook. Each alert is an Adaptive Card whose header shows whether it triggered or resolved, with the summary, severity, group, chart and **Open in Maple** and **Ask Maple AI** buttons.

1. In Teams, open the channel, then **⋯ → Workflows** and pick **Post to a channel when a webhook request is received**.
2. Leave **Who can trigger the flow** on **Anyone**: Maple sends the URL only, without a Microsoft sign-in.
3. Copy the webhook URL (`https://….environment.api.powerplatform.com/powerautomate/automations/direct/workflows/…&sig=…`) into **Workflows webhook URL**. The `sig` in it is the credential, so treat the URL as a secret.

Office 365 connector URLs (`….webhook.office.com`) were retired in May 2026, and older `logic.azure.com` flow URLs stopped working in November 2025. Maple rejects both and says which one you pasted. Cards post as the Workflows bot; Teams does not let a webhook set its own name or icon.

## Telegram

Send alerts to a Telegram chat, group or channel through a bot you create. Telegram has no per-channel webhook, so a destination needs two values: the bot's token and the id of the chat it posts to.

**1. Create the bot.** In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and follow the prompts. BotFather replies with a token of the form `123456789:AAH…`. That is the **Bot token** field. Copy it without the `bot` prefix.

**2. Add the bot to the chat.** Invite it to the group or channel you want alerts in. For a channel, add it as an administrator with permission to post messages. A bot cannot message a chat it is not a member of.

**3. Pick the chat.** In Maple, paste the bot token and click **Detect chats**. Maple asks Telegram which chats the bot can see and lists them by name. Pick one and the chat ID fills in.

Detection reads the bot's recent updates:

- **Adding the bot is enough.** You do not need to send a message first. Telegram notifies the bot when it is added to a chat, and Maple reads that notification.
- **Telegram keeps about 24 hours of updates.** An empty list usually means the bot was added longer ago than that. Send it a message, or remove and re-add it, and detect again.
- **A bot with a webhook registered cannot be inspected this way.** Telegram allows one reader at a time. If you pointed this bot at your own webhook, enter the chat ID by hand.

To find the ID by hand, post a message in the chat and open `https://api.telegram.org/bot<your-token>/getUpdates`, then read `result[].message.chat.id`. Group and channel IDs are negative (`-1001234567890`). A one-to-one chat is positive. Public channels can use `@channelusername` instead.

| Field         | Notes                                                         |
| ------------- | ------------------------------------------------------------- |
| **Bot token** | From @BotFather. Write-only: never returned after saving.     |
| **Chat ID**   | `-1001234567890`, or `@channelusername` for a public channel. |

When you save, Maple verifies the token and checks that the bot can reach the chat. A valid token pointed at a group the bot was never added to fails at save time, not at the first real alert.

Alerts arrive as a formatted message with an **Open in Maple** button, and the alert chart as the message preview when one is available.

## Webhook

POST a signed JSON payload to any HTTP endpoint you control. Use it for custom routing, on-call tools without a native integration, or your own automation.

- Maple sends a JSON body describing the rule, the observed value, and links back into Maple.
- Set an optional **signing secret** to receive an `x-maple-signature` HMAC-SHA256 header, so your endpoint can verify the payload came from Maple.
- Your endpoint should respond with a `2xx` status. Any other status is a delivery failure and is shown on the destination.

The payload, headers, signature verification and retry behavior are in the [alert webhooks reference](/docs/reference/webhooks).

## Hazel

Add the Maple bot to your Hazel workspace, then choose the channel alerts go to. The same bot answers `@Maple` questions in Hazel threads.

1. Open **Settings → Integrations → Hazel**, click **Add to Hazel** and approve the install for your workspace. You need to be an owner or admin in Hazel.
2. On the **Routing** tab, click **New destination** and pick the linked Hazel workspace.
3. Pick a **Channel** and save. The list shows every public channel and the private channels the bot was added to.

See Hazel's [Maple integration guide](https://hazel.sh/docs/integrations/maple).

## Linear

A Linear destination opens an issue in a Linear team instead of posting a message. Connect your Linear workspace first from **Integrations**: Maple installs as its own app, so the issues and comments it creates show Maple as the author. Then add a destination, pick **Linear**, and choose the team.

Maple keeps one issue per alert rule and group, so a noisy rule does not fill your Triage:

- The first `trigger` opens an issue in the team. It lands in Triage when the team uses it, and links back to the incident in Maple.
- A later `trigger` comments on the same issue: when the rule fires again, or when the incident moves between warning and critical.
- A `resolve` comments on the issue and leaves it open. Your team closes it when they are done.
- If the rule fires again within 24 hours of the issue being closed, Maple reopens it. After that, it opens a new issue.
- `renotify` reminders are not sent to Linear.

To ticket only serious incidents, add the Linear destination to the rule's critical tier only. The **Test** button checks that Maple can reach the team. It does not create an issue.

If Linear stops accepting Maple's access, deliveries fail with a reconnect message. Reconnect from **Integrations**.

## Next steps

- [Alert rules](/docs/alerting/alert-rules): attach destinations to a rule.
- [Incidents](/docs/alerting/incidents): when Maple sends trigger, renotify and resolve.
- [Alert webhooks reference](/docs/reference/webhooks): the webhook payload.
