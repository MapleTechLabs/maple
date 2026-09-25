---
title: "Slack"
description: "Add the Maple bot to a Slack workspace. Mention it in a channel to ask about your traces, logs, metrics, and errors, and use the same workspace as an alert destination."
group: "Integrations"
order: 4
---

The Slack integration adds the Maple bot to a Slack workspace and links that workspace to your Maple organization. Mention the bot in a channel and it answers in a thread, using the same assistant as Maple's chat, with access to your organization's traces, logs, metrics, and errors. Once the workspace is linked, its channels are also available as [alert destinations](/docs/alerting/notification-destinations).

## Prerequisites

- You are an admin of the Maple organization. Only organization admins can connect, change, or disconnect Slack workspaces.
- You can install apps in the Slack workspace.

## Install the bot

1. Open **Integrations → Slack** in Maple.
2. Click **Add to Slack**. Maple redirects you to Slack.
3. Choose the workspace and approve the install. Slack returns you to Maple, which shows **Connected** with the workspace name.

To link more workspaces to the same organization, click **Add another workspace**.

A Slack workspace can be linked to one Maple organization at a time. Enterprise Grid org-wide installs are not supported. Install the app into a single workspace instead.

### Permissions

The bot requests these Slack scopes. It requests no user token.

| Scope                                                                | Used for                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| `app_mentions:read`                                                  | Seeing when someone mentions the bot.                        |
| `channels:history`, `groups:history`, `im:history`, `mpim:history`   | Reading the thread it is replying in, for context.           |
| `chat:write`                                                         | Posting and updating its replies.                            |
| `chat:write.public`, `channels:read`, `groups:read`                  | Listing channels and posting alerts to them.                 |

## Ask the bot a question

1. Invite the bot to a channel: `/invite @Maple`.
2. Mention it with a question, for example `@Maple why is checkout slow?`.

The bot replies in a thread on your message and updates that reply as the answer comes in. It can post charts.

- **Follow-ups**: reply in the bot's thread within 24 hours to continue without mentioning it again.
- **Context**: the bot reads up to 20 earlier messages in the thread.
- **One question at a time**: while an answer is in progress, new messages in the same conversation get a note asking you to wait.
- Messages that do not mention the bot and are not in one of its threads are ignored.

The bot has no slash commands.

### What the bot can do

The bot reads your Maple data the same way the [MCP server](/docs/reference/mcp) does: traces, logs, metrics, services, errors, dashboards, and alerts. When a request would change something, such as creating a dashboard, editing an alert rule, or updating an error issue, the bot does not make the change on its own. It posts an **Approve** prompt naming the change, and the change runs only after someone approves it.

### Identity

The workspace is linked to the organization, not to individual people. No Slack account is tied to a Maple user. As a result:

- Anyone in a channel with the bot can ask about the linked organization's data.
- Anyone who can see a proposed change can approve it, and the approved change runs with organization-level permissions.

Invite the bot only to channels whose members should see your data and be able to make these changes.

## Slack as an alert destination

After the workspace is linked, Slack alerts go through the same bot. There is no separate webhook setup.

1. Open the alert destination settings. See [Notification destinations](/docs/alerting/notification-destinations).
2. Pick the tile named after your Slack workspace.
3. Choose a channel. Private channels are marked **(private)**.

The bot can post to public channels it has not been invited to. To post to a private channel, invite the bot first.

The two features are independent. You can link a workspace only for alerts and never mention the bot, or use the bot without routing any alerts to Slack.

## Verify

1. **Integrations → Slack** shows your workspace with **Connected**.
2. In a channel with the bot, mention it with a question such as `@Maple which services had errors in the last hour?`. A threaded reply appears.

## Disconnect

On **Integrations → Slack**, click **Disconnect** next to the workspace and confirm. The workspace is unlinked from your organization immediately. To remove the bot from the workspace itself, uninstall the app in Slack. Uninstalling the app in Slack also unlinks the workspace in Maple.

## Troubleshooting

- **"The install link expired."** Start the install again from **Add to Slack**.
- **"That workspace is already linked to a different Maple organization."** Disconnect it from the other organization first.
- **"Only organization admins can connect Slack."** Ask an organization admin to install it.
- **The bot does not reply.** Make sure you mentioned it, that it is in the channel (`/invite @Maple`), and that the workspace shows **Connected** in Maple.
- **"Maple's agent can't be reached from here right now."** The assistant is temporarily unavailable. Try again later.
- **The channel list for alerts is empty or asks you to reinstall.** The workspace was linked before the alert scopes were added. Click **Open Slack integration** and reinstall with **Add to Slack**.

## Next steps

- [Notification destinations](/docs/alerting/notification-destinations): route alerts to Slack channels.
- [Alert rules](/docs/alerting/alert-rules): decide what gets sent.
- [MCP server](/docs/reference/mcp): the same data in your editor or coding agent.
