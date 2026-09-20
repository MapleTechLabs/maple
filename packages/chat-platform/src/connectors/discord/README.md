# The Discord connector

Everything Maple knows about Discord is in this directory. The host Worker
(`apps/chat-bot`) drives it through `ChatConnector` and never learns which
platform it is talking to.

## What has to exist before it runs

One Discord application, created at <https://discord.com/developers/applications>.

1. **Bot tab → Token.** Reset it once and put the value in the deploy
   environment as `MAPLE_DISCORD_BOT_TOKEN`. That name is declared by
   `gateway.ts` (`requiredConfig`) and read back generically by the host — the
   connector never touches `process.env`. Without it the connector is skipped
   with one log line and the rest of the Worker runs.
2. **Bot tab → Privileged Gateway Intents: leave all three OFF.** This connector
   identifies with `GUILDS | GUILD_MESSAGES` only. Discord delivers message
   content without the privileged `MESSAGE_CONTENT` intent for messages in which
   the app is mentioned, which is exactly — and only — what V1 answers. Enabling
   `MESSAGE_CONTENT` would change nothing about what this code does, so do not
   enable it to make something work; change the intents in `gateway-payloads.ts`
   deliberately instead.
3. **Installation tab → Scopes `bot` + `applications.commands`, permissions
   "Send Messages", "Read Message History", "Create Public Threads".** The
   install URL that produces is what an administrator opens to add the bot to a
   server. (Posting is the outbound driver's business, not this directory's; the
   permissions are listed here because they are granted at install time.)

Nothing else is needed: the Gateway connection is outbound, so there is no
public URL to register and no request signature to verify.

## What it delivers

| Discord                                    | Maple                |
| ------------------------------------------ | -------------------- |
| `MESSAGE_CREATE` mentioning the bot         | `message`            |
| `INTERACTION_CREATE`, a component click     | `action`             |
| `GUILD_DELETE` without `unavailable`        | `workspace-removed`  |

Messages from bots and webhooks are dropped before anything else, so two Maple
deployments in one server cannot talk to each other. Messages outside a guild are
dropped too — no DM intent is requested.

A component click is acknowledged with a deferred update (callback type `6`)
within Discord's 3-second window. The connector returns that call as data
(`ConnectorRequest`); the host issues it, because the host owns all I/O.

## Protocol notes worth keeping

- **Single shard.** Discord requires sharding above 2500 guilds. Below it a shard
  count is one more thing the handshake can get wrong.
- **Resume before identify.** `READY` carries `resume_gateway_url` and
  `session_id`; both are persisted by the host, so a Worker redeploy resumes the
  session and replays what it missed rather than re-handshaking.
- **A zombie connection is one whose heartbeat was never acknowledged.** Discord's
  instruction is to close with a code other than `1000`/`1001` and resume, which
  is what the reconnect directive carries (`4000`).
- **Fatal close codes stop the loop.** `4004` (bad token), `4013`/`4014`
  (intents), `4010`–`4012`, and the `4001`–`4005` client-error codes are reported
  once instead of retried; every other code reconnects with the host's backoff.

`gateway.test.ts` drives all of it from recorded frames. There is no live
connection in any test.
