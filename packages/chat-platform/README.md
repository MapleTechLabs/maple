# @maple/chat-platform

Maple's agent turns, shown on a chat platform.

The `ChatSession` Durable Object streams `ChatEvent`s. This package turns that stream into messages
a bot posts and keeps editing, and defines the contract a platform has to satisfy to be one of the
platforms it can be shown on.

```
ChatEvent stream ──▶ makeChatTranscript ──▶ renderChatMessage ──▶ splitBlocks ──▶ connector transport
       (@maple/domain)                        blocks              one message's worth   post / edit
```

- `src/render/` — `ChatMessage` → platform-neutral blocks: prose, chart, entity reference, tool
  activity, approval request, notice. Chart fences and `<<maple:…>>` annotations come out of the
  prose here, through `@maple/domain`'s parsers, so this surface and the web transcript cannot
  disagree about what counts as one.
- `src/outbound.ts` — what a connector has to implement: its id, a budget, an edit interval,
  `post`, `edit`, `typing`, `openThread`, `history` (what was said in a conversation before a
  message, newest first, which is what the model is given as context) and `conversation` — which
  conversation an inbound message belongs to and where its answer goes, since only the platform
  knows whether that is a thread, a channel, or a thread it has to open first. Every call addresses a target
  (`{ workspaceId, channelId, threadId? }`), so a connector with per-install credentials resolves
  its token from `workspaceId` inside its own transport — the contract carries the address, never
  the secret. The credential itself arrives as `ConnectorCredentials`, the configuration the host
  resolved from the names the connector declared, so a host can drive any connector's outbound half
  with two services it knows: that one and an HTTP client.
- `src/driver.ts` — one turn, named by the assistant message id `beginTurn` answered with: placeholder,
  throttled edits, retraction, splitting, approvals, and a short notice for a turn that did not
  simply finish. A stream from seq 0 replays whole earlier turns, which is why the turn is named
  rather than discovered. `onPosted` reports the messages it has posted and `posted` hands them back,
  so a host that lost the fiber mid-turn can replay the events and go on editing the same messages.
- `src/connectors/<id>/` — one platform each.

## When the bot speaks

A mention is always a turn. A message that mentioned nobody is one only in a conversation the bot
**opened itself** — and then only while its session has held a turn, the last one was inside a day,
a human wrote the message, and the message has text. `apps/chat-bot/src/relay/conversation.ts` is
the whole rule, and the relay object remembers which conversations those are (`ChatConversation.opened`,
answered by the connector when it opens one).

So a channel the bot was invited to, and a thread somebody else started and mentioned it in once,
both stay mention-only however recently it spoke there. There is deliberately no model call
deciding whether a message is relevant: it would let the bot speak in more places, and it is the
next thing to add if this proves too narrow.

A connector that cannot see message content — several platforms gate it behind a privileged
permission — simply never reports unaddressed messages, and the feature is off for it with nothing
else to configure.

## The rule

Everything that differs between one chat vendor and the next lives under
`src/connectors/<id>/`. Nothing above a connector directory names a vendor — not an identifier, a
literal, a comment, a file name, a route, a column or a test fixture. The one exception is
`src/connectors/index.ts`, which imports what it registers.

Adding a platform is a directory and one line in that registry. `src/vendor-isolation.test.ts`
checks it by reading the sources, so the rule cannot erode quietly; `GUARDED_ROOTS` in that file is
where a new surface that drives connectors is added.
