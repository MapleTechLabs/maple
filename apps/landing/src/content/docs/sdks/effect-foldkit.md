---
title: "Effect SDK for Foldkit"
description: "Instrument a Foldkit app: Command spans grouped under page loads and navigations, scrubbed Command args, crash reports and slow-phase spans."
group: "Instrumentation"
order: 5
navLabel: "Foldkit"
sdk: "effect"
---

The `/foldkit` entry point of `@maple-dev/effect-sdk` instruments a [Foldkit](https://foldkit.dev) app. It ships in `@maple-dev/effect-sdk` 0.12.0 and later; [install the SDK](/docs/sdks/effect#install) first, and see Foldkit's [getting started guide](https://foldkit.dev/get-started) if you are new to it. Foldkit already runs every Command inside an Effect span named after it. On their own those spans are disconnected root traces, one per focus move or scroll. `MapleFoldkit` turns them into one trace per page load or navigation, drops the Commands that did no real work, and adds crash reports and slow-phase spans.

## Quick start

Create the telemetry once, then wrap the config you pass to `Runtime.makeApplication` with `instrument`:

```typescript
import { MapleFoldkit } from "@maple-dev/effect-sdk/foldkit"
import { Runtime } from "foldkit"
import type { UrlRequest } from "foldkit/navigation"
import type { Url } from "foldkit/url"

const maple = MapleFoldkit.make({
	serviceName: "acme-web",
	ingestKey: "maple_pk_...",
	region: "eu", // omit for the US region
})

Runtime.run(
	Runtime.makeApplication(
		maple.instrument({
			Model,
			init,
			update,
			view,
			resources: ResourcesLive,
			container,
			routing: {
				onUrlRequest: (request: UrlRequest) => Message.ClickedLink({ request }),
				onUrlChange: (url: Url) => Message.ChangedUrl({ url }),
			},
		}),
	),
)
```

Annotate the `routing` callback parameters. TypeScript cannot infer them through `instrument`.

`instrument` merges the telemetry layer into `resources` and wraps `init`, `update`, `routing.onUrlChange`, `crash` and `slow`. Every other field passes through unchanged, and it works the same on a `makeElement` config. Your own `crash.report` and `slow.onSlow` callbacks still run after Maple's.

`MapleFoldkit.make` builds on [`MapleFlush.make`](/docs/sdks/effect-client#mapleflushmake), so flush on unload, sessions, session replay, privacy and global error capture all work as they do in the browser entry point, and it accepts every one of its options.

## What it records

### Page loads and navigations

The first `init` opens a `pageload <route>` span that starts at the browser's navigation start, not when your JavaScript got there. Every `routing.onUrlChange` opens a `navigate <route>` span. Both carry `url.path`.

The Commands that `init` or the URL change return are parented under that span, and so are the Commands started by their result Messages, and by those Messages' results in turn. `HttpClient` and RPC spans nest inside the Commands and send `traceparent`, so one trace runs from the click in the browser to your backend.

A navigation ends:

- 150ms after its last Command finished, when no other Command started in the meantime.
- 1 second after it started, if no Command started at all.
- After 30 seconds at the latest, or when the page goes away. Both set `maple.navigation.interrupted: true`.

A Command that runs outside any navigation (a Subscription tick, a button click that does not change the URL) is its own root trace.

### Commands that did work

A Command that finished without starting a child span is UI work: a focus move, a scroll, a hover delay. It is dropped. A Command that called an API, an RPC or a traced Effect exports. Failed Commands always export. List a Command in `keepCommands` to export it regardless.

Each exported Command carries `maple.foldkit.message`, the tag of the Message whose `update` returned it. A Submodel Message wrapped by its parent shows as `GotChat > SubmittedComposer`. Only `_tag`s are recorded, never Message fields.

### Scrubbed Command args

Foldkit puts a Command's args on its span. Apps pass message text, invite tokens and API keys through them, so the SDK exports them as `maple.foldkit.arg.<key>` under a default-deny policy:

| `commandArgs`             | Exports                                                                     |
| ------------------------- | --------------------------------------------------------------------------- |
| `"ids"` (default)         | Keys named `id` or ending in `Id`, `Ids`, `_id`, `_ids`; booleans and nulls |
| `{ allow: ["provider"] }` | The `"ids"` set plus the named keys                                         |
| `"all"`                   | Every arg                                                                   |
| `"none"`                  | No args                                                                     |

Any other arg is still present, with the value `[redacted]`, so you can see which args a Command took. Strings are capped at 256 characters and arrays at 20 items. Objects and arrays of objects are left out.

### Crashes

When the Foldkit runtime crashes, the SDK reports an exception named `foldkit.crash` and flushes right away, because nothing else will trigger a flush once the runtime has stopped. It carries:

| Attribute                       | Value                                                  |
| ------------------------------- | ------------------------------------------------------ |
| `maple.exception.source`        | `foldkit.crash`                                        |
| `maple.foldkit.message`         | Tag of the Message that crashed the runtime, or `init` |
| `maple.foldkit.recent_messages` | The last 20 Message tags, oldest first                 |

### Slow phases

An `update` over 16ms, or a `view` or DOM patch over 50ms, becomes a `foldkit.update`, `foldkit.view` or `foldkit.patch` span under the open navigation. Each carries `maple.foldkit.phase`, `maple.foldkit.duration_ms`, `maple.foldkit.threshold_ms` and, where known, `maple.foldkit.message`. Slow phases are not recorded while the tab is hidden, because the browser throttles background tabs.

Change the budgets with `slowPhases: { Update: 8 }` (`0` records every run), or turn the spans off with `slowPhases: false`. A `slow.thresholdOverrides` in your Foldkit config wins over `slowPhases`.

## Name navigations by route

Without `routeName`, a navigation span is named after the path: `navigate /services/checkout-api`. That gives every service, trace and dashboard id its own span name. Map the path to your route instead, so the span is `navigate ServiceDetail`:

```typescript
import { Option } from "effect"
import { fromString } from "foldkit/url"

const routeName = (pathname: string): string =>
	Option.match(fromString(`https://app.invalid${pathname}`), {
		onNone: () => pathname,
		onSome: (url) => urlToAppRoute(url)._tag,
	})

const maple = MapleFoldkit.make({ serviceName: "acme-web", ingestKey: "maple_pk_...", routeName })
```

The full path stays on the span as `url.path`.

## Sampling

- `navigationSampleRate` traces a share of navigations, `1` by default. The decision is made once per navigation, and every Command and slow phase under it follows it.
- `sampleCommands` sets rates for chatty Commands outside a navigation, such as `{ SendTypingHeartbeat: 0.01 }`. Under a navigation, a Command always follows the navigation's decision.

## Configuration

`MapleFoldkit.make()` accepts every [`MapleFlush.make` option](/docs/sdks/effect-client#mapleflushmake) (`serviceName`, `ingestKey`, `region`, `endpoint`, `replay`, `privacy`, the span options, `autoFlushInterval`, ...) plus these:

| Option                 | Type                                    | Default                               | Description                                                                    |
| ---------------------- | --------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| `commandArgs`          | `"ids" \| "all" \| "none" \| { allow }` | `"ids"`                               | Which Command args export. See [Scrubbed Command args](#scrubbed-command-args) |
| `keepCommands`         | `string[]`                              | `[]`                                  | Commands exported even without a child span                                    |
| `sampleCommands`       | `Record<string, number>`                | `{}`                                  | Per-Command sample rates outside a navigation                                  |
| `navigationSampleRate` | `number`                                | `1`                                   | Share of navigations traced                                                    |
| `routeName`            | `(pathname: string) => string`          | the path                              | Navigation span name suffix, e.g. a route name or template                     |
| `slowPhases`           | `false \| { Update?, View?, Patch? }`   | `{ Update: 16, View: 50, Patch: 50 }` | Slow-phase budgets in ms, or `false` to turn them off                          |

The returned object has `instrument`, plus the `layer`, `flush()` and `dispose()` of [`MapleFlush.make`](/docs/sdks/effect-client#mapleflushmake). `dispose()` also ends any open navigation so it goes out with the final flush.

## Verify

1. Load a page of your app and click through to another route.
2. In Maple, open **Explore → Traces** and filter on your service name. You should see a `pageload <route>` trace and a `navigate <route>` trace, with the Commands that fetched data nested inside them and your backend's spans below those.
3. Look for Commands such as focus or scroll moves. They should not be there.

## Troubleshooting

- **Commands show up as separate root traces.** Only Commands caused by a page load or a URL change join a navigation. Check that URL changes go through `routing.onUrlChange`. Commands started by Subscriptions or by clicks that keep the URL are root traces by design.
- **A Command you need is missing.** It finished without starting a child span, so it was treated as UI work. Add it to `keepCommands`.
- **An arg shows `[redacted]`.** Its key is not an id. Add it to `commandArgs: { allow: [...] }` once you are sure it holds no user content.
- **A span name per id, like `navigate /traces/4bf92f...`.** Set `routeName`.
- **TypeScript errors on the `routing` callbacks.** Annotate their parameters, as in the quick start.

For key, region and CORS problems, see the [browser troubleshooting](/docs/sdks/effect-client#troubleshooting).

## Next steps

- [Effect SDK in the browser](/docs/sdks/effect-client)
- [Foldkit documentation](https://foldkit.dev)
- [Session replays](/docs/session-replay/replays)
- [Explore traces](/docs/explore/traces)
- [OpenTelemetry conventions](/docs/concepts/otel-conventions)
