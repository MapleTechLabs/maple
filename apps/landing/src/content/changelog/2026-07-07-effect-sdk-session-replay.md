---
title: "Session replay built into the Effect SDK"
description: "The Effect SDK records session replays on its own, so browser apps no longer need the separate @maple-dev/browser package."
date: 2026-07-07
category: sdk
authors: [makisuo]
---

If you instrument a browser app with `@maple-dev/effect-sdk`, it now records session replays
itself. You no longer need to add `@maple-dev/browser` alongside it to see what a user did before
an error or a slow request.

Replay is on by default in the browser presets (`Maple.layer` and `MapleFlush.make`). Configure it
with the `replay` option: `enabled`, `sampleRate`, `maskAllInputs` (on by default) and
`maskAllText`. The recorder loads in a separate chunk only when a session is sampled, so apps that
turn replay off never download it. Sessions that aren't recorded still show up in Maple with their
linked traces.

Upgrade to `@maple-dev/effect-sdk` 0.6.0. If you use `@maple-dev/browser` directly, upgrade it to
0.2.0. If both are on a page, the browser package owns the session and the Effect SDK stands down.

Get started with [session replay in the Effect SDK](/docs/sdks/effect-client).
