import { Clock, Effect } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../data/load-failure"
import { SessionTenant } from "../../data/session-tenant"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { Message } from "./message"

export const ReadSettingsClock = Command.define("ReadSettingsClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

/** `retainedQuery("auth", "session", {})`, shared with the shell through `SessionTenant`. */
export const FetchSettingsSession = Command.define("FetchSettingsSession", {
	messages: [Message.CompletedFetchSession],
	execute: Effect.gen(function* () {
		const session = yield* (yield* SessionTenant).get
		return {
			isAdmin: session.roles.some((role) => role === "root" || role === "org:admin"),
			userId: session.userId,
		}
	}).pipe(
		Effect.mapError(toLoadFailure),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchSession({ result })),
	),
})

/** `billingCustomerAtom`: the nav's data-platform gate and the Billing tab. */
export const FetchSettingsCustomer = Command.define("FetchSettingsCustomer", {
	messages: [Message.CompletedFetchCustomer],
	execute: Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		return yield* client.billing.getCustomer()
	}).pipe(
		Effect.mapError(toLoadFailure),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchCustomer({ result })),
	),
})
