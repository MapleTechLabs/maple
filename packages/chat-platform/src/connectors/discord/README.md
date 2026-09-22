# The Discord connector

Everything Maple knows about Discord is in this directory. Two host Workers drive it through
`ChatConnector` and neither learns which platform it is talking to: `apps/api` runs the install
half, `apps/chat-bot` runs the ingress and outbound halves.

## What has to exist before it runs

One Discord application, created at <https://discord.com/developers/applications>. Its secrets are
documented here rather than in the repo's `.env.example`, which is shared ground where no platform
should be named; every name is declared once, in `api.ts`.

| Secret                        | Where it comes from                   | How it reaches the connector                              |
| ----------------------------- | ------------------------------------- | --------------------------------------------------------- |
| `MAPLE_DISCORD_BOT_TOKEN`     | Bot tab → Token                       | `ingress.requiredConfig`, by name; `ConnectorCredentials` |
| `MAPLE_DISCORD_CLIENT_ID`     | OAuth2 tab → Client ID (not a secret) | `install.requiredConfig`, by name                         |
| `MAPLE_DISCORD_CLIENT_SECRET` | OAuth2 tab → Client Secret            | `install.requiredConfig`, by name                         |

A half whose names are unset is skipped rather than fatal: the dashboard reports the connector as
unavailable and offers no connect button, the ingress half logs one line, and the rest of each
Worker runs.

1. **Bot tab → Token.** Reset it once and put the value in the deploy environment as
   `MAPLE_DISCORD_BOT_TOKEN` — declared once, as `BOT_TOKEN_CONFIG` in `api.ts`. The gateway half
   names it in `requiredConfig` so the host resolves it generically, and hands the resolved map to
   the outbound half as `ConnectorCredentials` — one secret, one name, read by both halves, and the
   connector never touches `process.env`.
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

## Trying it end to end

The five steps above buy an application; these four are what turn a message in a server into an
answer from Maple.

1. **Put the three secrets on the deployment.** The bot token reaches `chat-bot`, the client id and
   secret reach `api`; both Workers bind every connector key as optional, so a stage without them
   deploys and skips this connector.
2. **Invite the bot.** Installation tab → Install Link (or the install flow below, which builds the
   same authorization URL). The member completing it needs `MANAGE_GUILD` on that server, and the
   bot needs to be able to see the channel you intend to mention it in.
3. **Link the server to a Maple organization.** In Maple: Settings → Integrations → Discord →
   Connect, which runs the install flow and writes the `chat_workspaces` row. Until that row
   exists, a mention is answered once with a note saying the workspace is not connected — that is
   the resolution failing, not the bot. Then **list the channels it may answer in** (below): a
   linked server with no channels listed stays silent everywhere, which is the commonest reason a
   correctly installed bot says nothing.
4. **Mention it.** `@Maple why is checkout slow?` in a channel. The bot opens a thread on that
   message and edits one message in it as the answer streams. A follow-up mention inside the thread
   continues the same conversation; a mention in another channel starts a different one. A mention
   while an answer is still being written is told so, and is not queued.

Two limits worth knowing before reporting a bug: a write the agent proposes is rendered as an
approval card that **cannot be approved yet** (clicking it answers that approvals are not available
yet), and the bot only ever answers messages it was mentioned in.

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

`allowed_channel_ids` and `approver_role_id`. Both are plain text fields in V1 — a channel or role
picker needs a Discord API call with the bot token, which is a follow-up.

`approver_role_id` is the role whose holders may approve the writes Maple proposes. Left empty,
approval falls back to whoever can manage the server.

`allowed_channel_ids` is the channel allowlist, and it is not Discord's — the key and the rule are
core, because an install is server-wide on every platform worth connecting. **Empty means nowhere**:
a linked server whose list is blank gets no answers at all, so a fresh install is silent until
somebody says where the bot belongs. A mention outside the list is ignored without a reply.

To fill it in: **Discord Settings → Advanced → Developer Mode**, then right-click a channel →
**Copy Channel ID**, and paste the ids separated by commas. A thread counts as the channel it was
started in, so the threads Maple opens for its own answers need no entry.

**Channels only.** A category ID matches nothing and does not cover the channels filed under it —
list each channel. (A channel's `parent_id` is its category, which is why `parentChannel` reads the
channel's `type` and answers only for the three thread types.)

#### A boundary Discord itself enforces

The allowlist is Maple's own rule, and it is one setting away from being changed. An admin who wants
the bot unable to read a channel at all should say so in Discord: **channel → Edit Channel →
Permissions → the Maple bot's role → View Channel: deny**. The gateway then never delivers those
messages, which is a stronger statement than a list Maple checks after the fact — and the two
compose, so use the permission for the channels that must never be read and the list for where the
bot should actually speak.

## What ingress delivers

| Discord                                 | Maple               |
| --------------------------------------- | ------------------- |
| `MESSAGE_CREATE` mentioning the bot     | `message`           |
| `INTERACTION_CREATE`, a component click | `action`            |
| `GUILD_DELETE` without `unavailable`    | `workspace-removed` |

Messages from bots and webhooks are dropped before anything else, so two Maple deployments in one
server cannot talk to each other. Messages outside a guild are dropped too — no DM intent is
requested.

A component click is acknowledged with a deferred update (callback type `6`) within Discord's
3-second window. The connector returns that call as data (`ConnectorRequest`); the host issues it,
because the host owns all I/O.

## Which conversation an answer belongs to

`transport.conversation` answers it, because only this connector can. A mention is answered in a
thread started on the message itself, and a Discord thread IS a channel — so the thread's id is both
the conversation key Maple builds a session from and the id every later call addresses. A follow-up
mention inside that thread arrives with the same id as its `channel_id`, so it lands on the same
session without anything being remembered between events.

Discord refuses to start a thread from a message that is already in one, and answers the same way
in a channel where the bot may not start threads at all. Both mean the same thing here — the
mention's own channel is the conversation — so the refusal is taken as the answer rather than
avoided with a channel lookup before every mention.

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
