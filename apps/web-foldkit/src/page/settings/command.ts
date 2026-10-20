import { organizationFeatureFlagsFrom } from "@maple/domain/organization-feature-flags"
import { isClerkAuthEnabled } from "../../lib/services/common/auth-mode"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../data/load-failure"
import { SessionTenant } from "../../data/session-tenant"
import { Message } from "./message"
import { BillingCustomerCache } from "../../data/billing-customer"

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
			hasAiAutoTriage: isClerkAuthEnabled
				? organizationFeatureFlagsFrom(window.Clerk?.organization?.publicMetadata).aiAutoTriage
				: true,
		}
	}).pipe(
		Effect.mapError(toLoadFailure),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchSession({ result })),
	),
})

/** `billingCustomerAtom`: the nav's data-platform gate and the Billing tab. */
export const FetchSettingsCustomer = Command.define("FetchSettingsCustomer", {
	args: { refresh: Schema.Boolean },
	messages: [Message.CompletedFetchCustomer],
	execute: ({ refresh }) =>
		Effect.gen(function* () {
			return yield* (yield* BillingCustomerCache).get({ refresh })
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchCustomer({ result })),
		),
})
