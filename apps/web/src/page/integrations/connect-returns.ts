import { GithubInstallationSelection } from "@maple/domain/http"
import { Effect, Option, Queue, Schema, Stream } from "effect"
import { apiOrigins } from "../../lib/services/common/api-base-url"
import { type ConnectProvider, IntegrationCallbackEvents } from "./connect"
import { RELAY_CHANNEL, relayOf } from "./oauth-return"

// A connect popup's outcome, from the popup itself (`postMessage` to its opener) or, when a
// provider page's COOP severed the opener, relayed by the tab it finished in.

export interface ConnectReturn {
	readonly provider: ConnectProvider
	readonly status: string
	readonly message: string | null
	/** GitHub only: the accounts its authorization found, for the picker. */
	readonly github?: GithubInstallationSelection
}

/** The callback page's `postMessage` payload; anything else on the channel is ignored. */
const CallbackData = Schema.Struct({
	type: Schema.String,
	status: Schema.optional(Schema.String),
	message: Schema.optional(Schema.String),
	github: Schema.optionalKey(GithubInstallationSelection),
})
const decodeCallback = Schema.decodeUnknownOption(CallbackData)

/** The callback page is the API's: served from its origin, or this one through the proxy. */
export const isCallbackOrigin = (origin: string, ownOrigin: string): boolean =>
	origin === ownOrigin || apiOrigins.includes(origin)

/** The popup's own report to this tab, its opener. */
export const openerReturns = (provider: ConnectProvider): Stream.Stream<ConnectReturn> =>
	Stream.unwrap(
		Effect.map(IntegrationCallbackEvents, ({ ownOrigin, messages }) =>
			messages.pipe(
				Stream.filter((event) => isCallbackOrigin(event.origin, ownOrigin)),
				Stream.flatMap((event) =>
					Option.match(decodeCallback(event.data), {
						onNone: () => Stream.empty,
						onSome: (data): Stream.Stream<ConnectReturn> => {
							if (data.type !== `maple:integration:${provider}`) return Stream.empty
							const callback = {
								provider,
								status: data.status ?? "",
								message: data.message ?? null,
							}
							return Stream.make(
								data.github === undefined ? callback : { ...callback, github: data.github },
							)
						},
					}),
				),
			),
		),
	)

/** Every provider's return finished in another tab whose popup lost its opener. */
export const relayedReturns: Stream.Stream<ConnectReturn> = Stream.callback<ConnectReturn>((queue) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const channel = new BroadcastChannel(RELAY_CHANNEL)
			channel.onmessage = (event: MessageEvent) =>
				Option.match(relayOf(event.data), {
					onNone: () => undefined,
					onSome: ({ provider, status, message, github }) => {
						Queue.offerUnsafe(
							queue,
							github === undefined ? { provider, status, message } : { provider, status, message, github },
						)
					},
				})
			return channel
		}),
		(channel) => Effect.sync(() => channel.close()),
	).pipe(Effect.andThen(Effect.never)),
)

/** One provider's return, however it arrives. */
export const connectReturns = (provider: ConnectProvider): Stream.Stream<ConnectReturn> =>
	Stream.merge(
		openerReturns(provider),
		Stream.filter(relayedReturns, (relay) => relay.provider === provider),
	)
