---
title: "Replays"
description: "Find a browser session on the Session Replays page, play it back next to its events and backend traces, and move between a trace and the replay that produced it."
group: "Session Replay"
order: 2
---

The **Replays** page (**Session Replays** in its header) lists the browser sessions recorded by the [Browser SDK](/docs/session-replay/browser-sdk). Open a session to watch what the user saw, with the clicks, console messages, network requests, errors and backend traces from that session beside the player.

## Prerequisites

The [Browser SDK](/docs/session-replay/browser-sdk) initialized with replay enabled (the default). Sessions sampled out by `replay.sampleRate` are not recorded.

## Find a session

The toolbar shows how many sessions match and how many are **live** (still recording). Use the time range picker to change the window, and **Search by URL…** to find sessions that visited a page. The **Analytics** button opens [Web Analytics](/docs/product-events/web-analytics) for the same window.

The sidebar narrows the list:

| Filter           | What it matches                                                                  |
| ---------------- | -------------------------------------------------------------------------------- |
| Session length   | Duration. **Bounced** is under 10 seconds. The other presets come from your own p50 and p95. |
| Active time      | Time the user was active. **Idle** is under 5 seconds, **Engaged** over 30 seconds. |
| Page visited     | Sessions that visited a page.                                                    |
| Service          | The `serviceName` the SDK was initialized with.                                  |
| Browser, Device, Country | The visitor's environment.                                                |
| Group            | The company or team passed to `identify()`. Shown once any session has one.      |
| Identity         | **Name or email…** and **User ID…**, from `identify()`.                          |

Sessions with errors are marked in the list.

## Watch a session

Click a session to open it. The player rebuilds the page as the user saw it.

- **Space** plays and pauses. The left and right arrow keys seek 5 seconds.
- Playback speed is 0.5×, 1×, 2×, 4× or 8×.
- **Skip idle** jumps over periods with no activity.

The rail on the right has three tabs:

- **Events.** Every recorded event in order. Filter it to **Product events**, **Console messages**, **Network requests** or **Errors**. Click an event to seek the player to that moment. A network request that carried a trace has an **Open trace** link.
- **Traces.** The backend traces observed during the session. Click one to seek the player to it, or open it in the trace view.
- **Session.** The session's metadata: identity (name, email, user id, group, traits), visitor id, entry and exit page, referrer and UTM source and campaign, browser, operating system, device, country, service, and session id.

From the **Session** tab, the links next to **User ID**, **Group** and **Visitor ID** list every session from that user, group or visitor.

## Replay and trace links

The SDK tags every span and replay event with the same `session.id`, so Maple links the two both ways:

- **From a replay to a trace.** Use the **Traces** tab, or **Open trace** on a network event.
- **From a trace to a replay.** When a browser session observed a trace, the trace page shows **View Session Replay**. It opens the replay at that session.

For a backend span to appear in the same trace as the browser request, the request must carry the `traceparent` header. Same-origin requests always do. For a cross-origin API, see [Connect browser and backend traces](/docs/session-replay/browser-sdk#connect-browser-and-backend-traces).

## Privacy

Masking happens in the browser, before anything is sent. A replay never contains what the SDK masked.

- Every `<input>` value is masked by default (`privacy.maskAllInputs`).
- `privacy.maskAllText: true` masks all rendered text.
- Elements with the `rr-block` class or `data-rr-block` attribute are recorded as placeholders.
- URLs are redacted: the values of credential-shaped parameters such as `token` or `password` are replaced, and `privacy.sanitizeUrl` can rewrite the rest.

See [Privacy and masking](/docs/session-replay/browser-sdk#privacy-and-masking) and [Consent](/docs/session-replay/browser-sdk#consent) for the options.

## Verify

Load a page with the SDK installed, click around, then close the tab. Open **Replays**. The session is listed within about a minute, and it plays back when you open it.

## Troubleshooting

- **"No sessions recorded yet".** Check that the SDK initializes on the page, that `replay.enabled` is not `false`, and that consent was granted if `privacy.requireConsent` is on.
- **Some sessions are missing.** `replay.sampleRate` below `1` records only that fraction of sessions.
- **The Traces tab is empty.** The session made no traced requests, or the backend traces are in a different trace because the request did not carry `traceparent`.
- **A replay stops partway.** A session records at most 1 GiB of replay data. See [Session size limit](/docs/session-replay/browser-sdk#session-size-limit).

## Next steps

- [Browser SDK](/docs/session-replay/browser-sdk)
- [Web Analytics](/docs/product-events/web-analytics)
- [Traces](/docs/explore/traces)
