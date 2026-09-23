# The Slack connector

Everything Maple knows about Slack is in this directory. Two host Workers drive it through
`ChatConnector` and neither learns which platform it is talking to: `apps/api` runs the install
half, `apps/chat-bot` runs the ingress and outbound halves.

This is a **new Slack app**, separate from the one that delivers alerts to channels
(`slack_workspaces`, `SlackIntegrationService`) and separate from the Railway agent in
`apps/slack-agent`. It shares no table, no secret and no code with either. See
[`docs/chat-connector-cutover.md`](../../../../../docs/chat-connector-cutover.md) for running it
alongside the old agent and retiring that one.

## What has to exist before it runs

One Slack app, created at <https://api.slack.com/apps> (from the manifest below). Its secrets are
documented here rather than in the repo's `.env.example`, which is shared ground where no platform
should be named; every name is declared once, in `api.ts`.

| Secret                       | Where it comes from                        | How it reaches the connector      |
| ---------------------------- | ------------------------------------------ | --------------------------------- |
| `MAPLE_SLACK_CLIENT_ID`      | Basic Information → Client ID (not secret) | `install.requiredConfig`, by name |
| `MAPLE_SLACK_CLIENT_SECRET`  | Basic Information → Client Secret          | `install.requiredConfig`, by name |
| `MAPLE_SLACK_SIGNING_SECRET` | Basic Information → Signing Secret         | `ingress.requiredConfig`, by name |

The client id and secret go on **api**; the signing secret goes on **chat-bot**. A half whose names
are unset is skipped rather than fatal: the dashboard reports the connector as unavailable and
offers no connect button, the webhook route answers 503 and logs one line, and the rest of each
Worker runs.

One more secret is needed on chat-bot, and it is not this connector's:
`MAPLE_INGEST_KEY_ENCRYPTION_KEY`, the key the per-workspace credential envelope is sealed with. It
is already bound on api. Without it on chat-bot, a Slack workspace resolves as a failed lookup and
its mentions go unanswered — see "The bot token" below.

### The app manifest

```yaml
display_information:
    name: Maple
    description: Ask Maple about your traces, errors and services, in a thread.
settings:
    event_subscriptions:
        request_url: https://chat.maple.dev/connectors/slack/webhook
        bot_events:
            - app_mention
            - message.channels
            - message.groups
            - message.im
            - message.mpim
            - app_uninstalled
            - tokens_revoked
    interactivity:
        is_enabled: true
        request_url: https://chat.maple.dev/connectors/slack/webhook
    org_deploy_enabled: false
    socket_mode_enabled: false
features:
    bot_user:
        display_name: Maple
oauth_config:
    redirect_urls:
        - https://api.maple.dev/oauth/chat/slack/callback
    scopes:
        bot:
            - app_mentions:read
            - chat:write
            - channels:history
            - groups:history
            - im:history
            - mpim:history
```

**One application per production instance.** Slack allows a single Events request URL per app, and
the US and EU instances are different Workers on different hostnames — so the EU instance needs its
own Slack app with `chat.eu.maple.dev` and `api.eu.maple.dev` substituted throughout the manifest
above. They are separate applications with separate credentials, which is also what keeps an EU
workspace's events off a US Worker. A dev stage has no public hostname at all; point a scratch app
at the portless URL, or use a tunnel.

Three things in there are load-bearing:

- **one request URL for both surfaces.** Slack takes an Events URL and an Interactivity URL
  separately; both point at the same route, and `webhook.ts` tells the two apart by content type
  (interactivity arrives form-encoded, events arrive as JSON).
- **`org_deploy_enabled: false`.** An enterprise-wide install issues a token that spans every
  workspace in the org and answers with `team: null`, so the row the install writes could not be
  resolved from any event's `team_id`. `install.ts` refuses one by name rather than failing later.
- **the four `message.*` events.** A mention arrives as `app_mention`; a follow-up in the thread it
  opened arrives only as a `message`, and only if the matching history scope is granted.

The scopes deliberately **do not** include `users:read` — see "Who may approve" below — or
`reactions:write`: nothing reacts, the answer in the thread is the acknowledgement.

## Trying it end to end

1. **Put the secrets on the deployments.** Client id and secret on api, signing secret and the
   encryption key on chat-bot. Both Workers bind every connector key as optional, so a stage without
   them deploys and skips this connector.
2. **Save the request URL.** Slack POSTs a `url_verification` challenge the moment you save it;
   `webhook.ts` answers it with the challenge, verifying the signature first like any other request.
   A red "Your URL didn't respond" is almost always the signing secret, not the route.
3. **Link the workspace to a Maple organization.** In Maple: Settings → Integrations → Slack →
   Connect, which runs the install flow and writes the `chat_workspaces` row (Slack's own consent
   screen adds the bot at the same time). The card is behind the org's `slack_bot` rollout flag.
4. **Invite the bot to a channel** (`/invite @Maple`) and **mention it**: `@Maple why is checkout
slow?`. It answers in a thread on that message and edits one message there as the answer streams.
   A reply in that thread continues the same conversation; a mention in another channel starts a
   different one.

5. **Reply in that thread without mentioning the bot.** The thread is one the bot opened, so it
   answers anyway — and it reads the messages above the reply for context. In a channel it was
   merely invited to, an un-addressed message is not a turn.

One limit worth knowing before reporting a bug: a write the agent proposes renders as an approval
card that **cannot be approved yet**.

## The bot token

Slack mints one bot token per installed workspace, so unlike the other connector there is no
deployment-wide credential the outbound half could use. The token is what the install returns as
`ChatInstallResult.credentials` — a small JSON blob (`credentials.ts`), opaque to everything above
this directory. It is JSON rather than the bare token so a second value later is one more key here
rather than a migration and a re-install of every workspace.

The token's **format is deliberately not validated**: the shapes it can take are Slack's to change,
and a wrong token fails the first post with Slack's own error, which reports better than a pattern
could.

**Token rotation must stay OFF on the app.** With it on, Slack issues a short-lived `xoxe.xoxb-…`
access token plus a refresh token, and expects the app to exchange the one for the other before it
expires. This connector stores only the access token and implements no refresh, so a rotation-enabled
install would work until the first expiry and then stop posting — with nothing in the failure saying
why beyond Slack's `token_expired`. Supporting it is a real feature (a second stored value, a
refresh ahead of every use, and a write back to the row from the bot Worker, which today only reads
it), not a missing branch. Nothing validates the format, so nothing here will catch the mistake:
leaving rotation off is the operator's to get right.

The host seals it with AES-256-GCM into `chat_workspaces.credentials_{ciphertext,iv,tag}`, with the
AAD bound to `(org_id, connector, external_workspace_id)`, and hands it back to the outbound half in
`ConnectorCredentials` under the reserved `WORKSPACE_CREDENTIALS` key. Two consequences:

- a conversation in a workspace nobody linked has **no token**, so the transport answers "this
  workspace is not connected" instead of posting as somebody else. The generic "link me first"
  notice the host posts for an unlinked workspace therefore cannot be delivered on Slack — the bot
  is silent until the workspace is linked, which is also what a bot with no credential can be;
- a deployment with no encryption key cannot open a stored envelope, so the lookup fails and the
  mention goes unanswered with one logged error, rather than resolving to a workspace whose bot
  then cannot post.

## Install flow

`authorizeUrl` sends the browser to `https://slack.com/oauth/v2/authorize` with the bot scopes and
the callback URL; `complete` exchanges the code at `POST https://slack.com/api/oauth.v2.access`.

Two things are load-bearing:

- **the team comes from the token response**, which Slack binds to the authorization code. A
  callback query parameter belongs to whoever opens the callback URL;
- **Slack reports a refused exchange as HTTP 200 with `ok: false`**, so the status code is not the
  answer. The whole Web API works this way, which is why `outbound.ts` reads `ok` on every call too.

The user token is not requested at all (`user_scope` is absent): the bot is an org-level actor, and
Maple has no use for an installer identity it never links to a Maple user.

### Settings

None. The other connector's one setting names an approver role, and Slack's interaction payload
reports no roles — a field here would ask an admin to configure something nothing can check.

## What ingress delivers

| Slack                                   | Maple                            |
| --------------------------------------- | -------------------------------- |
| `app_mention`                           | `message` (`mentionsBot: true`)  |
| `message.*` with a `thread_ts`          | `message` (`mentionsBot: false`) |
| `block_actions` carrying a button value | `action`                         |
| `app_uninstalled`, `tokens_revoked`     | `workspace-removed`              |

`workspaceId` is always the envelope's `team_id` — and for a button press, the interaction's own
`team.id`, never the clicker's `user.team_id`: in a Slack Connect shared channel the clicker can
belong to a different workspace, and a different Maple org. Bot-authored messages and every `subtype` are
dropped before anything else, so two Maple deployments in one workspace cannot talk to each other.
A mention inside a subscribed channel arrives as BOTH an `app_mention` and a `message`; the
`message` copy is dropped, or one question would start a turn and then be fed into it.

**The bot's own user id comes from the event's `authorizations` entry**, not from storage. It is per
event and per workspace, which is what lets ingress stay a pure function of the request and the
deployment's configuration. Without it the mention text is passed through with the mention still in
it, rather than a follow-up being dropped on a guess.

### Request verification

`X-Slack-Signature` is `v0=` plus HMAC-SHA256 over `v0:{X-Slack-Request-Timestamp}:{raw body}`,
keyed with the signing secret. `signature.ts` checks the timestamp first (five minutes either way,
Slack's documented window — a captured body stays correctly signed forever, and only its age says
otherwise), then compares in constant time.

Every rejection answers with the **same constant message**, which the host returns as the 400 body:
naming the check that refused the request tells an attacker which one to fix. The reason goes on
the span instead (`maple.chat.reject_reason`), where it is a six-value enum an operator can break
rejections down by. Drops are annotated the same way (`maple.chat.dropped`) — an acknowledged
redelivery and a handled mention are otherwise the same 200 on the same span.

Within the five-minute window there is **no replay protection**. A captured signed body can be
delivered again, and today that costs at most a duplicate turn. Before button presses actually
apply anything, an approval needs to be deduplicated against durable storage — the ingress cannot
do it, being a pure function the host may run in any isolate.

**Retries are acknowledged and dropped.** Slack redelivers an event it believes was not
acknowledged, marking it with `X-Slack-Retry-Num`. This handler answers inside its own request, so a
retry means Slack did not hear the 200 — not that the event went unhandled. Deduplicating by
`event_id` instead would need storage that ingress, a pure function the host may run in any isolate,
does not have.

### Who may approve

**This connector declares no `identity`**, which is a policy rather than a gap: anyone who can see
the conversation may approve, and the change runs as the org-level connector identity. See
`ChatConnector.identity` for the three cases.

Slack _can_ answer who clicked — "Sign in with Slack", its OpenID Connect flow — and implementing
it is mechanically small: the same OAuth application, the same client credentials, the same
redirect-URL list, an authorize URL at `https://slack.com/openid/connect/authorize` and two calls
(`openid.connect.token`, then `openid.connect.userInfo`).

It is not implemented because one fact it rests on **cannot be confirmed from Slack's
documentation**: that the `sub` / `https://slack.com/user_id` claim returned by `userInfo` is the
same `U…` id that arrives as `user.id` on a `block_actions` payload. Everything about this is
plausible — Slack user ids are one namespace — but the link is keyed on that id, and the failure if
it is wrong is silent and total: `identity` present with nothing linked means every approval is
**refused**, which is worse than the weaker rule this connector ships with. Two other things are
also undocumented: whether the `openid` scopes must be declared in the app manifest, and whether
adding them forces workspaces that already installed the bot to re-authorize.

What makes it cheap is one empirical check against a real workspace: log `sub` and the
`block_actions` `user.id` for the same person and compare them. That check belongs with the smoke
checklist in the cutover doc, and the flow can land the moment it passes.

## Reading the conversation back

`transport.history` is `conversations.replies` for a thread — addressed by its parent's `ts`, which
is the thread's own id — and `conversations.history` for a channel. Both take `latest` with
`inclusive: false`, which is "everything before this message", and both need the matching history
scope; without it Slack answers `not_in_channel` and the turn goes on without the context.

The page is **sorted here rather than trusted**: `conversations.history` answers newest first and
`conversations.replies` answers oldest first, and the contract wants one order. The sort is over the
`ts` and not over the epoch-ms the contract carries — a `ts` has microsecond precision, so two
messages sent in the same second round to the same millisecond, and ordering by the rounded value
would put them in whatever order the page happened to arrive in.

One message that will not decode is dropped on its own rather than failing the read: a page is
context, and losing the conversation around one unreadable line is the worse trade.

## Which conversation an answer belongs to

`transport.conversation` answers it, and performs no I/O. A Slack thread is not an object — it is
every message carrying the anchor's `ts` as its `thread_ts` — so a top-level mention's own `ts`
becomes the thread, and a mention already in one keeps that thread. The conversation key is
`channel:thread_ts`, which fits `ChatConversationKey`'s charset. `openThread` returns the anchor's
id and calls nothing.

`opened` is **true for a top-level mention** and false everywhere else. A Slack thread begins with
the reply that first carries the parent's `ts`, so answering a top-level mention is what creates the
thread — it is a space that exists because somebody asked Maple something, which is what lets the
host treat a later un-addressed message in it as still addressed to the bot. A mention already
inside a thread, and every un-addressed follow-up, opens nothing. Neither costs a request.

## Protocol notes worth keeping

- **Acknowledge within three seconds.** The handler returns 200 and hands its events to the host,
  which relays them afterwards. An agent turn is not a three-second operation.
- **Most failures are a 200.** `ok: false` with an `error` code. A transport reading only the status
  would file every revoked token as a success.
- **A rate limit is a 429 with `Retry-After` in seconds**, and Slack spells the body code both
  `ratelimited` and `rate_limited`. `chat.postMessage` is roughly one call per second per channel,
  which is also why `minEditInterval` is a second — a streamed turn spends its budget on the turn
  rather than on 429s.
- **There is no typing indicator for a bot token.** The method that had one belongs to the
  deprecated RTM API. `typing` is a no-op rather than a wasted call.
- **mrkdwn is not markdown.** `*x*` is bold there and italic here, there are no headings and no
  tables, and `&`, `<`, `>` are control characters. `mrkdwn.ts` is the whole conversion, and the
  escape is also what stops an agent quoting `<!channel>` out of a log from paging a company.

`webhook.test.ts` drives the ingress from signed HTTP requests and `events.test.ts` from recorded
payload shapes. No test reaches the network.

## What is unverified without a real Slack app

Every fact above was checked against Slack's current documentation. These need one live install to
confirm, and the cutover doc's smoke checklist is where they get confirmed:

- whether `app_mention` carries `thread_ts` when the bot is mentioned inside a thread (the mapping
  handles both, so the consequence is only which value names the conversation);
- that `authorizations[]` names the bot user on every delivery this connector reads;
- that an un-mentioned thread reply arrives with the history scopes above and no others, and that
  `conversations.replies` / `conversations.history` answer for the channel types the bot is in;
- the display name shown for an author: Slack's message events carry only a user id, so V1 uses the
  id. A readable name needs `users:read`, on the same terms as the approval facts.
