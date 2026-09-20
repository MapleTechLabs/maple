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
  `post`, `edit`, `typing`, `openThread`. Every call addresses a target
  (`{ workspaceId, channelId, threadId? }`), so a connector with per-install credentials resolves
  its token from `workspaceId` inside its own transport — the contract carries the address, never
  the secret.
- `src/driver.ts` — one turn, named by the message id `beginTurn` answered with: placeholder,
  throttled edits, retraction, splitting, approvals, and a short notice for a turn that did not
  simply finish. A stream from seq 0 replays whole earlier turns, which is why the turn is named
  rather than discovered.
- `src/connectors/<id>/` — one platform each.

## The rule

Everything that differs between one chat vendor and the next lives under
`src/connectors/<id>/`. Nothing above a connector directory names a vendor — not an identifier, a
literal, a comment, a file name, a route, a column or a test fixture. The one exception is
`src/connectors/index.ts`, which imports what it registers.

Adding a platform is a directory and one line in that registry. `src/vendor-isolation.test.ts`
checks it by reading the sources, so the rule cannot erode quietly; `GUARDED_ROOTS` in that file is
where a new surface that drives connectors is added.
