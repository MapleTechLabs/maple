---
title: "Notification destinations"
description: "Route Maple alerts to Slack, email, PagerDuty, Discord, Telegram, Hazel or any HTTP endpoint. How to add a destination, send a test, and get the right credentials for each provider."
group: "Alerting"
order: 4
---

A **notification destination** is where Maple delivers an alert when one of your rules fires. You add a destination once and attach it to any number of [alert rules](/docs/alerting/alert-rules). When a rule opens an incident, Maple sends a `trigger`. When the incident resolves, it sends a `resolve`. See [Incidents](/docs/alerting/incidents) for when each is sent.

Destinations live on the **Destinations** tab of the **Alerts** page. Click **Add destination**, pick a provider, and fill in the **Connection** fields. Only organization admins can add, edit or delete destinations. Provider credentials are encrypted at rest and never returned to the browser after they are saved.

## Sending a test

Every destination has a **Send test** button. It delivers a sample alert through the same code path that delivers real alerts, so it confirms your credentials before you attach the destination to a rule.

If a test fails, Maple shows the provider's own rejection reason in the toast and on the destination card. For example, a bad PagerDuty key reports `PagerDuty delivery failed with 400: Invalid routing key`.

## Failed deliveries

A delivery that fails with an error retrying cannot fix, such as a rejected credential, counts against the destination. After 3 such failures in a row, Maple disables the destination and marks it **Disabled** on its card. A successful delivery resets the count. Fix the credential, send a test, and re-enable the destination.

## Slack

Link your Slack workspace to Maple, then choose the channel alerts go to. Maple posts through the linked workspace's bot. Incoming-webhook URLs are not supported.

1. Open **Settings → Integrations → Slack** and connect your workspace. See the [Slack integration](/docs/integrations/slack).
2. On the **Destinations** tab, click **Add destination** and pick the linked workspace.
3. Pick a **Channel** and save.

## Email

Send alerts by email to members of your Maple organization.

1. Click **Add destination** and pick **Email**.
2. Under **Recipients**, select up to 10 members of the organization.
3. Save, then click **Send test**.

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
5. Paste it into Maple's **Integration key** field and click **Send test**.

See PagerDuty's [services and integrations guide](https://support.pagerduty.com/main/docs/services-and-integrations) for screenshots.

| Field               | Notes                                                            |
| ------------------- | ---------------------------------------------------------------- |
| **Integration key** | The 32-character Events API v2 routing key from the steps above. |

Maple sends each `trigger` with a stable `dedup_key` and a matching `resolve` when the incident closes, so PagerDuty groups the lifecycle into one incident.

## Discord

Post alerts to a Discord channel through an incoming webhook.

1. In Discord, open **Channel settings → Integrations → Webhooks → New Webhook**.
2. Copy the webhook URL (`https://discord.com/api/webhooks/...`) into the **Discord webhook URL** field.

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

Alerts arrive as a formatted message with **Open in Maple** and **Ask Maple AI** buttons, and the alert chart as the message preview when one is available.

## Webhook

POST a signed JSON payload to any HTTP endpoint you control. Use it for custom routing, on-call tools without a native integration, or your own automation.

- Maple sends a JSON body describing the rule, the observed value, and links back into Maple.
- Set an optional **signing secret** to receive an `x-maple-signature` HMAC-SHA256 header, so your endpoint can verify the payload came from Maple.
- Your endpoint should respond with a `2xx` status. Any other status is a delivery failure and is shown on the destination.

The payload, headers, signature verification and retry behavior are in the [alert webhooks reference](/docs/reference/webhooks).

## Hazel

Connect [Hazel](https://hazel.sh/docs/integrations/maple) through OAuth and pick a workspace channel to route alerts into. See Hazel's [Maple integration guide](https://hazel.sh/docs/integrations/maple).

## Next steps

- [Alert rules](/docs/alerting/alert-rules): attach destinations to a rule.
- [Incidents](/docs/alerting/incidents): when Maple sends trigger, renotify and resolve.
- [Alert webhooks reference](/docs/reference/webhooks): the webhook payload.
