# The Discord connector

Everything Maple knows about Discord is in this directory. Two host Workers drive it through
`ChatConnector` and neither learns which platform it is talking to: `apps/api` runs the install
half, `apps/chat-bot` runs the ingress and outbound halves.

## What has to exist before it runs

One Discord application, created at <https://discord.com/developers/applications>. Its secrets are
documented here rather than in the repo's `.env.example`, which is shared ground where no platform
should be named; every name is declared once, in `api.ts`.

| Secret                         | Where it comes from                                  | How it reaches the connector      |
| ------------------------------ | ---------------------------------------------------- | --------------------------------- |
| `MAPLE_DISCORD_BOT_TOKEN`      | Bot tab → Token                                      | `ingress.requiredConfig`, by name; `DiscordBotToken` service |
| `MAPLE_DISCORD_CLIENT_ID`      | OAuth2 tab → Client ID (not a secret)                | `install.requiredConfig`, by name |
| `MAPLE_DISCORD_CLIENT_SECRET`  | OAuth2 tab → Client Secret                           | `install.requiredConfig`, by name |

A half whose names are unset is skipped rather than fatal: the dashboard reports the connector as
unavailable and offers no connect button, the ingress half logs one line, and the rest of each
Worker runs.

1. **Bot tab → Token.** Reset it once and put the value in the deploy environment as
   `MAPLE_DISCORD_BOT_TOKEN` — declared once, as `BOT_TOKEN_CONFIG` in `api.ts`. The gateway half
   names it in `requiredConfig` so the host resolves it generically; the outbound half receives the
   same secret as the `DiscordBotToken` service, because an Effect transport can take a service
   where a pure state machine cannot. Two mechanisms, one secret, one name — and the connector
   never touches `process.env`.
2. **Bot tab → Privileged Gateway Intents: leave all three OFF.** This connector identifies with
   `GUILDS | GUILD_MESSAGES` only. Discord delivers message content without the privileged
   `MESSAGE_CONTENT` intent for messages in which the app is mentioned, which is exactly — and only
   — what V1 answers. Enabling `MESSAGE_CONTENT` would change nothing about what this code does, so
   do not enable it to make something work; change the intents in `gateway-payloads.ts`
   deliberately instead.
3. **Bot tab → Requires OAuth2 Code Grant: ON.** An install can then only complete through the code
   exchange the install half performs.
4. **OAuth2 tab → Redirects.** Add `https://api.maple.dev/oauth/chat/discord/callback`, and the
   equivalent origin for any other stage.
5. **Installation tab → Scopes `bot` + `applications.commands`, permissions "Send Messages", "Read
   Message History", "Create Public Threads".**

Nothing else is needed: the Gateway connection is outbound, so there is no public URL to register
and no request signature to verify.

## Install flow

`authorizeUrl` sends the browser to Discord's `bot` authorization with `response_type=code` and the
callback URL, and `complete` exchanges the code at `POST /api/v10/oauth2/token`.

Two things are load-bearing:

- **the guild comes from the token response**, which Discord binds to the authorization code. The
  callback's `guild_id` query parameter is documented as a hint, is enumerable, and belongs to
  whoever opens the callback URL — reading it would let an install be pointed at a server the
  authorization never covered;
- **Discord requires the authorizing member to hold `MANAGE_GUILD`** ("Apps installed in a server
  context must be authorized by a server member with the `MANAGE_GUILD` permission"), so a completed
  code is proof that a manager of that server approved this install.

The user's access and refresh tokens are discarded: the bot acts with its own token, and Maple has
no use for an installer identity it never links to a Maple user.

### Requested permissions

`permissions=309237730368` — `VIEW_CHANNEL`, `SEND_MESSAGES`, `SEND_MESSAGES_IN_THREADS`,
`CREATE_PUBLIC_THREADS`, `EMBED_LINKS`, `READ_MESSAGE_HISTORY`, `ADD_REACTIONS`. `install.ts` says
what each one is for. None of them is an elevated permission, and the set holds no member, role,
channel or moderation power.

### Settings

`approver_role_id` only: the role whose holders may approve the writes Maple proposes. It is a plain
text field in V1 — a role picker needs a Discord API call with the bot token, which is a follow-up.
Left empty, approval falls back to whoever can manage the server.

## What ingress delivers

| Discord                                    | Maple                |
| ------------------------------------------ | -------------------- |
| `MESSAGE_CREATE` mentioning the bot         | `message`            |
| `INTERACTION_CREATE`, a component click     | `action`             |
| `GUILD_DELETE` without `unavailable`        | `workspace-removed`  |

Messages from bots and webhooks are dropped before anything else, so two Maple deployments in one
server cannot talk to each other. Messages outside a guild are dropped too — no DM intent is
requested.

A component click is acknowledged with a deferred update (callback type `6`) within Discord's
3-second window. The connector returns that call as data (`ConnectorRequest`); the host issues it,
because the host owns all I/O.

## Protocol notes worth keeping

- **Single shard.** Discord requires sharding above 2500 guilds. Below it a shard count is one more
  thing the handshake can get wrong.
- **Resume before identify.** `READY` carries `resume_gateway_url` and `session_id`; both are
  persisted by the host, so a Worker redeploy resumes the session and replays what it missed rather
  than re-handshaking.
- **A zombie connection is one whose heartbeat was never acknowledged.** Discord's instruction is to
  close with a code other than `1000`/`1001` and resume, which is what the reconnect directive
  carries (`4000`).
- **Fatal close codes stop the loop.** Exactly the six Discord marks non-reconnectable — `4004` (bad
  token), `4010`/`4011` (sharding), `4012` (API version), `4013`/`4014` (intents) — are reported
  once instead of retried. Everything else reconnects with the host's backoff, the client-error
  codes `4001`/`4002`/`4003`/`4005` included: Discord marks those reconnectable, and treating them
  as fatal would take the bot down over something the next connection fixes.

`gateway.test.ts` drives all of it from recorded frames. There is no live connection in any test.
