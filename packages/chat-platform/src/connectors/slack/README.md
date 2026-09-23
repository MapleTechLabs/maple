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

Two limits worth knowing before reporting a bug: an un-mentioned thread reply is delivered but
currently dropped by the host (it is what the thread-context work turns on), and a write the agent
proposes renders as an approval card that **cannot be approved yet**.

## The bot token

Slack mints one bot token per installed workspace, so unlike the other connector there is no
deployment-wide credential the outbound half could use. The token is what the install returns as
`ChatInstallResult.credentials` — a small JSON blob (`credentials.ts`), opaque to everything above
this directory. It is JSON rather than the bare token so a second value later is one more key here
rather than a migration and a re-install of every workspace.

The token's **format is deliberately not validated**: an app with token rotation enabled answers
`xoxe.xoxb-…` rather than `xoxb-…`, and the shapes it can take are Slack's to change. A wrong token
fails the first post with Slack's own error, which reports better than a pattern could.

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

Slack's `block_actions` payload carries the user's id and name and **nothing about membership**: no
roles, no `is_admin`, no `is_owner`. So `InboundActor` reports `roleIds: []` and
`isWorkspaceAdmin: false`, and Maple's approval policy decides what a factless actor may do.

The only way to learn otherwise is a `users.info` call, which needs the `users:read` scope — a scope
change every installed workspace has to re-approve, and one extra API call on every button press.
That is a trade worth making when there is a policy to enforce, and not before.

## Which conversation an answer belongs to

`transport.conversation` answers it, and performs no I/O. A Slack thread is not an object — it is
every message carrying the anchor's `ts` as its `thread_ts` — so a top-level mention's own `ts`
becomes the thread, and a mention already in one keeps that thread. The conversation key is
`channel:thread_ts`, which fits `ChatConversationKey`'s charset. `openThread` returns the anchor's
id and calls nothing.

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
- that an un-mentioned thread reply arrives with the history scopes above and no others;
- the display name shown for an author: Slack's message events carry only a user id, so V1 uses the
  id. A readable name needs `users:read`, on the same terms as the approval facts.
