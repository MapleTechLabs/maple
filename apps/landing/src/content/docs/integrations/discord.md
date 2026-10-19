---
title: "Discord"
description: "Add the Maple bot to a Discord server. Mention it in a channel to ask about your traces, logs, metrics, and errors, and post alerts to the server's channels."
group: "Integrations"
order: 5.5
author: "jeremyfunk"
---

The Discord integration adds the Maple bot to a Discord server and links that server to your Maple organization. Mention the bot in a channel and it answers in a thread, using the same assistant as Maple's chat. Once the server is linked, its channels are also available as [alert destinations](/docs/alerting/notification-destinations).

## Prerequisites

- You are an admin of the Maple organization.
- You have the **Manage Server** permission on the Discord server. Discord requires it to add an app.

## Add the bot to a server

1. Open **Integrations → Discord** in Maple.
2. Click **Add to Discord**. Maple redirects you to Discord.
3. Pick the server and approve the install. Discord returns you to Maple, which shows **Connected** with the server name.

To link more servers to the same organization, click **Add another workspace**. A server can be linked to one Maple organization at a time.

### Permissions

The bot asks for no member, role, channel, or moderation permissions.

| Permission                                      | Used for                                    |
| ----------------------------------------------- | ------------------------------------------- |
| View Channels, Read Message History             | Reading the conversation it is replying in. |
| Send Messages, Embed Links                      | Posting answers, charts, and alerts.        |
| Create Public Threads, Send Messages in Threads | Answering in a thread on your message.      |
| Add Reactions                                   | Marking a request as picked up.             |

## Link your Discord account

Each person who wants to approve changes from Discord links their own account once.

1. Open **Integrations → Discord** in Maple.
2. Under **Your Discord account**, click **Link your account** and approve in Discord.

The link asks Discord for your user ID and nothing else. It adds no permissions on any server. You can only link your own account.

## Ask the bot a question

Mention the bot in any channel it can see, for example `@Maple why is checkout slow?`.

The bot starts a thread on your message and edits its reply there as the answer comes in. It reads the surrounding messages for context, so a follow-up like "and the payments call?" works.

- **Follow-ups**: reply inside the bot's thread. No mention is needed.
- **New conversation**: mention the bot in another channel.
- **One question at a time**: a message sent while an answer is still being written gets a note asking you to wait. It is not queued.

### Approving changes

The bot reads your Maple data the same way the [MCP server](/docs/reference/mcp) does. When a request would change something, such as creating a dashboard or editing an alert rule, it posts a card with **Run** and **Skip** buttons instead of acting.

Only people who have [linked their account](#link-your-discord-account) can press them. The change runs as that person's Maple user with their current roles, so a change that needs an admin fails for a member, the same as in the app. The card then updates with the result.

This is the main difference from [Slack](/docs/integrations/slack), where anyone who can see the card can approve it with organization-level permissions.

Reading data needs no link. Anyone in a channel the bot can see can ask about the linked organization's data, so add the bot only where its members should see that data.

## Discord as an alert destination

After the server is linked, alerts can go through the bot.

1. Open the alert destination settings. See [Notification destinations](/docs/alerting/notification-destinations).
2. Pick the tile named after your Discord server.
3. Choose a text or announcement channel the bot can see.

To post alerts to a server without installing the bot, use the [Discord webhook destination](/docs/alerting/notification-destinations#discord) instead.

## Verify

1. **Integrations → Discord** shows your server with **Connected**.
2. In a channel the bot can see, send `@Maple which services had errors in the last hour?`. A thread opens with the answer.

## Disconnect

On **Integrations → Discord**, click **Disconnect** next to the server and confirm. The server is unlinked immediately. To remove the bot from the server, kick it in Discord. Removing the bot in Discord also unlinks the server in Maple.

To unlink your own account, click **Unlink** under **Your Discord account**.

## Troubleshooting

- **"This workspace isn't connected to a Maple organization yet."** The bot is in the server but the server is not linked. An admin runs **Add to Discord** from Maple.
- **"Only organization admins can connect Discord."** Ask an organization admin to install it.
- **"Link your Discord account to Maple to approve this."** Link your account in Maple, then press **Run** again.
- **The bot does not reply.** Make sure you mentioned it and that it can see the channel. Check the channel's permission overrides for the Maple role.

## Next steps

- [Notification destinations](/docs/alerting/notification-destinations): route alerts to Discord channels.
- [Alert rules](/docs/alerting/alert-rules): decide what gets sent.
- [MCP server](/docs/reference/mcp): the same data in your editor or coding agent.
