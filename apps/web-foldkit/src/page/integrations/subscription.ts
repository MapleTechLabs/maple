import { Effect, Option, Queue, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../platform/resources"
import type { PageSubscriptionInput } from "../contract"
import { integrationOfSearch } from "./catalog"
import { ConnectAttempt, ConnectProvider, currentReturnPath, PROVIDERS, startConnect } from "./connect"
import { Message } from "./message"
import type { Model } from "./model"

const one = (message: Message): Stream.Stream<Message> => Stream.make(message)

const POPUP_TICK_MS = 500
/** Ticks between polls: 3 s. */
const POLL_EVERY_TICKS = 6

/** The placeholder the popup shows until the authorize URL arrives. */
const interimDocument = (label: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Connecting to ${label}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size:13px;
    background:#fff; color:#3f3f46; }
  @media (prefers-color-scheme: dark) { body { background:#1c1917; color:#d6d3d1; } }
</style></head><body>Connecting to ${label}…</body></html>`

const openPopup = (name: string, features: string, label: string) =>
	Effect.sync(() => {
		const popup = window.open("", name, features)
		if (popup !== null) {
			popup.document.write(interimDocument(label))
			popup.document.close()
		}
		return popup
	})

/** Polls the popup until it closes: `PolledConnect` every 3 s (polling providers), then `Closed`. */

/**
 * The flow's 500 ms interval (legacy's `setInterval` tick): every sixth tick polls (polling
 * providers); `isClosed` ends it with `Closed` once the popup is gone.
 */
const ticker = (attempt: number, polls: boolean, isClosed: () => boolean, graceMs: number | null) =>
	Stream.callback<Message>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const state = { ticks: 0 }
				const interval = setInterval(() => {
					state.ticks += 1
					if (polls && state.ticks % POLL_EVERY_TICKS === 0)
						Queue.offerUnsafe(queue, Message.PolledConnect({ attempt }))
					if (graceMs === null && isClosed()) {
						clearInterval(interval)
						Queue.offerUnsafe(queue, Message.ClosedConnectPopup({ attempt }))
					}
				}, POPUP_TICK_MS)
				const timeout =
					graceMs === null
						? undefined
						: setTimeout(
								() => Queue.offerUnsafe(queue, Message.EndedConnectGrace({ attempt })),
								graceMs,
							)
				return { interval, timeout }
			}),
			({ interval, timeout }) =>
				Effect.sync(() => {
					clearInterval(interval)
					if (timeout !== undefined) clearTimeout(timeout)
				}),
		).pipe(Effect.andThen(Effect.never)),
	)

const watchPopup = (popup: Window, attempt: number, polls: boolean) =>
	ticker(attempt, polls, () => popup.closed, null)

/** After the popup closed, a provider with a grace keeps polling until the grace ends. */
const grace = ({ provider, attempt }: ConnectAttempt) => {
	const spec = PROVIDERS[provider]
	return ticker(attempt, spec.polls, () => true, spec.closeGraceMs)
}

/** `useOAuthPopupFlow`'s `connect`: open in the click, start, then send the popup to the provider. */
const popupFlow = ({ provider, attempt }: ConnectAttempt) =>
	Stream.unwrap(
		Effect.gen(function* () {
			const spec = PROVIDERS[provider]
			const popup = yield* openPopup(spec.windowName, spec.windowFeatures, spec.label)
			const returnTo = yield* currentReturnPath
			const started = yield* Effect.result(startConnect(provider, returnTo))
			if (started._tag === "Failure") {
				yield* Effect.sync(() => popup?.close())
				return one(
					Message.FailedStartConnect({
						attempt,
						title: spec.startErrorTitle,
						description: started.failure.message,
					}),
				)
			}
			const url = started.success.redirectUrl
			const target = yield* Effect.sync(() => {
				if (popup !== null && !popup.closed) {
					popup.location.href = url
					return popup
				}
				return window.open(url, spec.windowName, spec.windowFeatures)
			})
			return target === null
				? one(Message.BlockedConnectPopup({ attempt }))
				: Stream.concat(
						one(Message.SucceededStartConnect({ attempt })),
						watchPopup(target, attempt, spec.polls),
					)
		}),
	)

/** After the popup closed, a provider with a grace keeps polling until it ends. */

/** The provider whose callback messages this page listens for (`useIntegrationMessage`). */
const listeningProvider = (model: Model): ConnectProvider | null => {
	const integration = integrationOfSearch(model.search.integration)
	return Schema.is(ConnectProvider)(integration) ? integration : null
}

/** The callback page's `postMessage` payload; anything else on the channel is ignored. */
const CallbackData = Schema.Struct({
	type: Schema.String,
	status: Schema.optional(Schema.String),
	message: Schema.optional(Schema.String),
})
const decodeCallback = Schema.decodeUnknownOption(CallbackData)

const callbackMessages = (provider: ConnectProvider) =>
	Stream.fromEventListener<MessageEvent>(window, "message").pipe(
		Stream.flatMap((event) =>
			Option.match(decodeCallback(event.data), {
				onNone: () => Stream.empty,
				onSome: (data) =>
					data.type === `maple:integration:${provider}`
						? Stream.make(
								Message.ReceivedConnectMessage({
									provider,
									status: data.status ?? "",
									message: data.message ?? null,
								}),
							)
						: Stream.empty,
			}),
		),
	)

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		connectPopup: entry(
			{ attempt: Schema.NullOr(ConnectAttempt), phase: Schema.Literals(["popup", "grace", "idle"]) },
			{
				modelToDependencies: ({ model }) => ({
					attempt: model.connect.active,
					phase:
						model.connect.active === null ? "idle" : model.connect.isClosed ? "grace" : "popup",
				}),
				dependenciesToStream: ({ attempt, phase }) =>
					attempt === null || phase === "idle"
						? Stream.empty
						: phase === "popup"
							? popupFlow(attempt)
							: grace(attempt),
			},
		),
		connectCallback: entry(
			{ provider: Schema.NullOr(ConnectProvider) },
			{
				modelToDependencies: ({ model }) => ({ provider: listeningProvider(model) }),
				dependenciesToStream: ({ provider }) =>
					provider === null ? Stream.empty : callbackMessages(provider),
			},
		),
	}),
)
