# Discord connector

Everything Maple knows about Discord lives in this directory. The rest of the codebase reaches it
through the `ChatConnector` contract in `../../connector.ts`.

## Configuration

The host supplies these by name (they are declared in `install.ts` as `requiredConfig`; nothing
outside this directory spells them out). They are documented here rather than in the repo's
`.env.example`, which is shared ground where no platform should be named.

| Name                    | Where it comes from                                              |
| ----------------------- | ---------------------------------------------------------------- |
| `DISCORD_CLIENT_ID`     | Discord developer portal → your application → OAuth2 → Client ID |
| `DISCORD_CLIENT_SECRET` | Same page → Client Secret                                        |

Both unset is a supported state: the connector is reported as unavailable and the dashboard offers
no connect button. Nothing fails to boot.

Application setup, once per Discord application:

- add `https://api.maple.dev/oauth/chat/discord/callback` (and the equivalent origin for any other
  stage) to **OAuth2 → Redirects**;
- enable **Bot → Requires OAuth2 Code Grant**, so an install can only complete through the code
  exchange this connector performs.

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

## Requested permissions

`permissions=309237730368` — `VIEW_CHANNEL`, `SEND_MESSAGES`, `SEND_MESSAGES_IN_THREADS`,
`CREATE_PUBLIC_THREADS`, `EMBED_LINKS`, `READ_MESSAGE_HISTORY`, `ADD_REACTIONS`. `install.ts` says
what each one is for. None of them is an elevated permission, and the set holds no member, role,
channel or moderation power.

## Settings

`approver_role_id` only: the role whose holders may approve the writes Maple proposes. It is a plain
text field in V1 — a role picker needs a Discord API call with the bot token, which is a follow-up.
Left empty, approval falls back to whoever can manage the server.
