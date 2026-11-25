import { Duration, Effect, Queue, Record as Rec, Schema, Stream, Array as Arr } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../platform/resources"
import type { PageSubscriptionInput } from "../contract"
import { integrationOfSearch } from "./catalog"
import { ConnectAttempt, ConnectProvider, currentReturnPath, PROVIDERS, startConnect } from "./connect"
import { Message } from "./message"
import { openerReturns, relayedReturns } from "./connect-returns"
import type { Model } from "./model"
import { type MountedProvider, PROVIDER_MODULES } from "./provider-modules"
import { backoffPollTicks, pollTicks, whenPresent } from "../../data/poll"

/** The popup's document could not be written: it is already on the provider's cross-origin page. */
export class PopupDocumentError extends Schema.TaggedError<PopupDocumentError>()(
	"@maple/web/integrations/PopupDocumentError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/** A Record entry with its key typed as a string. */
const keyed = <A>(key: string, value: A): readonly [string, A] => [key, value]

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

/**
 * A popup still open from an earlier click is reused by name; once it is on the provider's page it
 * is cross-origin and its document throws, so it keeps that page until it is sent to the new URL.
 */
const openPopup = (name: string, features: string, label: string) =>
	Effect.sync(() => window.open("", name, features)).pipe(
		Effect.tap((popup) =>
			popup === null
				? Effect.void
				: Effect.ignore(
						Effect.try({
							try: () => {
								// oxlint-disable-next-line typescript/no-deprecated -- fills a blank popup before it navigates; nothing else writes an about:blank document.
								popup.document.write(interimDocument(label))
								popup.document.close()
							},
							catch: (cause) =>
								new PopupDocumentError({
									message: "could not write the popup's placeholder",
									cause,
								}),
						}),
					),
		),
	)

/**
 * The flow's 500 ms interval: every sixth tick polls (polling providers); `isClosed` ends it with
 * `Closed` once the popup is gone.
 */
const ticker = (attempt: number, polls: boolean, isClosed: () => boolean, graceMs: number | null) =>
	Stream.callback<Message>((queue) =>
		Effect.gen(function* () {
			// One tick; `false` once the popup is gone, which ends the ticking.
			const tick = (ticks: number) =>
				Effect.sync(() => {
					if (polls && ticks % POLL_EVERY_TICKS === 0)
						Queue.offerUnsafe(queue, Message.PolledConnect({ attempt }))
					if (graceMs === null && isClosed()) {
						Queue.offerUnsafe(queue, Message.ClosedConnectPopup({ attempt }))
						return false
					}
					return true
				})
			const ticking = (ticks: number): Effect.Effect<void> =>
				Effect.flatMap(Effect.delay(tick(ticks), POPUP_TICK_MS), (isOpen) =>
					isOpen ? ticking(ticks + 1) : Effect.void,
				)
			yield* Effect.forkScoped(ticking(1))
			if (graceMs !== null)
				yield* Effect.forkScoped(
					Effect.delay(
						Effect.sync(() => Queue.offerUnsafe(queue, Message.EndedConnectGrace({ attempt }))),
						graceMs,
					),
				)
			return yield* Effect.never
		}),
	)

const watchPopup = (popup: Window, attempt: number, polls: boolean) =>
	ticker(attempt, polls, () => popup.closed, null)

/** After the popup closed, a provider with a grace keeps polling until the grace ends. */
const grace = ({ provider, attempt }: ConnectAttempt) => {
	const spec = PROVIDERS[provider]
	return ticker(attempt, spec.polls, () => true, spec.closeGraceMs)
}

/** Opens the popup in the click, starts, then sends the popup to the provider. */
const popupFlow = ({ provider, attempt, githubMode }: ConnectAttempt) =>
	Stream.unwrap(
		Effect.gen(function* () {
			const spec = PROVIDERS[provider]
			const popup = yield* openPopup(spec.windowName, spec.windowFeatures, spec.label)
			const returnTo = yield* currentReturnPath
			const started = yield* Effect.result(startConnect(provider, returnTo, githubMode))
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

/** A status poll: paused while the tab is hidden or offline, one catch-up tick on return. */
const every = (millis: number, message: () => Message) =>
	Stream.map(pollTicks(Duration.millis(millis)), message)

/** A provider module's ticks while it is active: steady, or fast first then steady. */
export const tickerStream = (ticker: MountedProvider["tickers"][number]): Stream.Stream<Message> =>
	ticker.fast === null
		? every(ticker.everyMs, () => ticker.tick)
		: backoffPollTicks(
				Duration.millis(ticker.fast.everyMs),
				ticker.fast.ticks,
				Duration.millis(ticker.everyMs),
			).pipe(Stream.map(() => ticker.tick))

/** A module's one-shot: its messages `afterMs` on, held until the tab is back. */
const delayedStream = (
	delayed: NonNullable<MountedProvider["delayed"]>,
	version: number,
): Stream.Stream<Message> =>
	Stream.fromEffect(Effect.delay(Effect.void, Duration.millis(delayed.afterMs))).pipe(
		Stream.concat(Stream.never),
		Stream.flatMap(() => Stream.flatMap(whenPresent(), () => Stream.fromIterable(delayed.fire(version)))),
	)

/** The provider whose callback messages this page listens for. */
const listeningProvider = (model: Model): ConnectProvider | null => {
	const integration = integrationOfSearch(model.search.integration)
	return Schema.is(ConnectProvider)(integration) ? integration : null
}

const callbackMessages = (provider: ConnectProvider) =>
	Stream.map(openerReturns(provider), (callback) => Message.ReceivedConnectMessage(callback))

/** Every provider's status lives on this page, so every relayed return re-reads one. */
const relayMessages = Stream.map(relayedReturns, ({ provider, status, message, github }) => {
	const relay = { provider, status, message: message ?? "" }
	return Message.ReceivedConnectRelay(github === undefined ? relay : { ...relay, github })
})

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
		/** Each provider module's one-shot (GitHub's force-poll window), fired once the tab is back. */
		...Rec.fromEntries(
			Arr.flatMap(PROVIDER_MODULES, (provider) => {
				const delayed = provider.delayed
				return delayed === null
					? []
					: [
							keyed(
								`${provider.id}Delayed`,
								entry(
									{ version: Schema.NullOr(Schema.Number) },
									{
										modelToDependencies: ({ model }) => ({
											version: delayed.versionOf(model),
										}),
										dependenciesToStream: ({ version }) =>
											version === null ? Stream.empty : delayedStream(delayed, version),
									},
								),
							),
						]
			}),
		),
		/** Each provider module's tick (Railway's first-sync poll, Supabase's card clock). */
		...Rec.fromEntries(
			Arr.flatMap(PROVIDER_MODULES, (provider) =>
				Arr.map(provider.tickers, (ticker, index) =>
					keyed(
						`${provider.id}Tick${index}`,
						entry(
							{ dependency: Schema.NullOr(Schema.String) },
							{
								modelToDependencies: ({ model }) => ({
									dependency: ticker.dependency(model),
								}),
								dependenciesToStream: ({ dependency }) =>
									dependency === null ? Stream.empty : tickerStream(ticker),
							},
						),
					),
				),
			),
		),
		connectCallback: entry(
			{ provider: Schema.NullOr(ConnectProvider) },
			{
				modelToDependencies: ({ model }) => ({ provider: listeningProvider(model) }),
				dependenciesToStream: ({ provider }) =>
					provider === null ? Stream.empty : callbackMessages(provider),
			},
		),
		connectRelay: entry(
			{},
			{
				modelToDependencies: () => ({}),
				dependenciesToStream: () => relayMessages,
			},
		),
	}),
)
