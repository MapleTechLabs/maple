import { hasBringYourOwnCloudAddOn } from "@maple/web/lib/billing/plan-gating"
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
		return { isAdmin: session.roles.some((role) => role === "root" || role === "org:admin") }
	}).pipe(
		Effect.mapError(toLoadFailure),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchSession({ result })),
	),
})

/** `billingCustomerAtom`: the nav's data-platform gate reads the add-on flag. */
export const FetchSettingsCustomer = Command.define("FetchSettingsCustomer", {
	messages: [Message.CompletedFetchCustomer],
	execute: Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		const customer = yield* client.billing.getCustomer()
		return { hasByoc: hasBringYourOwnCloudAddOn(customer) }
	}).pipe(
		Effect.mapError(toLoadFailure),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchCustomer({ result })),
	),
})
