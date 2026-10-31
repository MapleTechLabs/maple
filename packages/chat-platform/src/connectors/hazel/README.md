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

1. **Create the bot** with the scopes `messages:read`, `messages:write`, `channels:write` (opens
   threads) and `channels:read` (lists the channels an alert can go to), mark it **public**, and
   make it **mentionable**.
   A bot created before alerts came through it lacks `channels:read`: add it on each instance's
   bot (US and EU), or its channel list answers `auth` and no Hazel channel can be picked.
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
   message (`POST /api/v1/channels/{id}/threads`) and posts one live message in it: the answer
   streams into the message's live state as it is written, and the finished answer is written into
   the message at the end. A follow-up inside that thread needs no mention.
3. **Send it alerts.** A Hazel channel is an alert destination like any other chat channel. The
   picker lists what `GET /api/v1/organizations/{id}/bot-channels` answers: every public channel and the
   private ones the bot was added to. Delivery posts as the bot.
4. **Decide what it proposes.** A write the agent wants to make is an embed with two buttons. A
   press reaches the bot as an `interaction.create` gateway event, and the card is then edited with
   what came of it, without the buttons.

## How an answer streams

A turn's message is created with a `liveState` embed, which makes Hazel render the message's live
state (`MessageLiveObject`) in place of its content. The driver hands the transport the whole turn
on every write and says whether the turn is still `streaming` or `final`; the transport turns that
into live-state writes (`POST /api/v1/messages/{id}/live`):

| The driver calls            | Hazel receives                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `post(…, "streaming")`      | `POST /messages` with `embeds: [{ liveState: { enabled, loading } }]`, then `Start`           |
| `edit(…, "streaming")`      | `AppendText` with what the render added, or `SetText` when it took words back                 |
| …and the embeds changed     | `PATCH /messages/{id}` first: a card, chart or button is a message embed, not live state      |
| `edit(…, "final")`          | `AppendText`/`SetText`, `Complete` (or `Fail`, on the error a turn closes on), then the PATCH |
| `post`/`edit` with no phase | a plain message: a notice, a whisper, a tail posted at the end, a settled approval            |

The final PATCH writes the answer as the message's `content`, for search, notifications and
history (Maple's own included), and the same state as the embed's `cached` snapshot, for a client
without the live socket. `Complete` and `Fail` go out with `persist: false`: Hazel's own snapshot
write would replace the message's embeds, and an approval's buttons with them.

Live writes are not message writes: Hazel's 120 a minute per bot does not count them. So the
driver writes every 250 ms, and a turn costs the message budget one create, one write per change of
its embeds, and one at the end. A settled approval is a plain edit, which leaves the message plain:
its content then says everything.

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
- **No typing indicator** for a bot; the live message's loading indicator says it is working.
- **No agent steps.** Hazel's live state can show tool calls as steps, but its web client does not
  render them yet, and the driver hands a connector rendered blocks rather than tool-call events:
  what a tool is doing is a line of the streamed text.
- **No uninstall event.** Removing the bot in Hazel does not unlink the workspace in Maple; answers
  fail with `auth` until it is unlinked there.
