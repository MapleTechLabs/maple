# The Hazel connector

Everything Maple knows about Hazel is in this directory. Two host Workers drive it through
`ChatConnector` and neither learns which platform it is talking to: `apps/api` runs the install
half, `apps/chat-bot` runs the ingress and outbound halves.

## What has to exist before it runs

One Hazel bot, owned by the Maple team, created in Hazel under Settings → Integrations → Your apps
→ Create. Its secrets are documented here rather than in the repo's `.env.example`; every name is
declared once, in `api.ts`.

| Config                  | Where it comes from                          | Read by                         |
| ----------------------- | -------------------------------------------- | ------------------------------- |
| `MAPLE_HAZEL_BOT_TOKEN` | The token shown once when the bot is created | ingress, outbound and install   |
| `MAPLE_HAZEL_BOT_ID`    | The bot's id (not a secret)                  | install, as the link's `bot_id` |

A half whose names are unset is skipped rather than fatal, as for every connector.

1. **Create the bot** with the scopes `messages:read`, `messages:write` and `channels:write` (the
   last one opens threads), mark it **public**, and make it **mentionable**.
2. **Register the install redirect URIs** on the bot (Edit Application → Install redirect URIs):
   `https://api.maple.dev/oauth/chat/hazel/callback`, plus the equivalent origin of any other
   stage that shares this bot. Hazel compares them exactly.
3. **Put the two values on the deployment.** The token reaches `chat-bot` and `api`, the id reaches
   `api`.

**One bot per instance.** Hazel allows one gateway session per bot token, so the EU instance runs
its own bot, with its own redirect URI.

## Trying it end to end

1. **Link a Hazel workspace.** In Maple: Settings → Integrations → Hazel → Connect. That sends an org
   admin to Hazel's consent page (`https://app.hazel.sh/oauth/bot-install`), where they pick a Hazel
   workspace they own or administer and approve. Hazel installs the bot there and sends the browser
   back with a one-time code; the install half redeems it with the bot's token
   (`POST /api/v1/bot-installs/token`) for the workspace it was issued against. The code is bound to
   this bot, the redirect URI and that workspace, is single-use and lives ten minutes, so the
   workspace comes from Hazel's answer and never from the callback's query.
2. **Mention it.** `@Maple why is checkout slow?` in any channel. The bot opens a thread on the
   message (`POST /api/v1/channels/{id}/threads`) and edits one message in it as the answer streams.
   A follow-up inside that thread needs no mention.
3. **Decide what it proposes.** A write the agent wants to make is an embed with two buttons. A
   press reaches the bot as an `interaction.create` gateway event, and the card is then edited with
   what came of it, without the buttons.

## Who may ask and approve

There is no `identity` half yet: Hazel has no way for a person to prove to Maple which Hazel account
is theirs. So anyone in a linked workspace may ask, and anyone who can see a proposal may approve
it, and the change runs as the org-level connector identity — the policy `ChatConnector.identity`
writes down for a connector without one. Linking the workspace is an admin's decision on both
sides, which is what this rests on.

## The gateway

`wss://bot-gateway.hazel.sh/bot-gateway/ws`, `gateway.ts`:

- HELLO carries the heartbeat interval; the connector IDENTIFYs with the token, or RESUMEs the
  session it holds, from the last acknowledged offset. A first connection starts at `now`: `-1`
  would replay a week of retained events, and every one would be answered.
- READY names the session and the bot's own user, which is what makes `@[userId:…]` a mention of
  this bot. A gateway that predates `botUserId` delivers nothing until it names it.
- Events arrive in DISPATCH batches, one in flight at a time; each is acknowledged in the same step
  that hands its events to the host.
- One session per token: a second IDENTIFY is refused while one is live, and a RESUME of the live
  session replaces it. So the session is kept across every reconnect and deploy, and only a refused
  token (`Invalid bot token`) stops the loop.

Hazel delivers every message in a workspace to an installed bot. The connector drops its own
messages, any other bot's (each message event names its author), and empty ones before the host
pays for them; the host decides whether an unaddressed message is still a turn.

## What Hazel cannot do (yet)

- **No private replies.** A whisper is a message in the conversation that mentions the person.
- **No typing indicator** for a bot; the placeholder message says it is working.
- **No alert destinations** through this connector: alerts reach Hazel through Maple's separate
  Hazel webhook integration.
- **No uninstall event.** Removing the bot in Hazel does not unlink the workspace in Maple; answers
  fail with `auth` until it is unlinked there.
