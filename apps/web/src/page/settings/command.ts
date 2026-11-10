import { readClock } from "@maple/views/data/timing"
import {
	ENABLED_ORGANIZATION_FEATURE_FLAGS,
	organizationFeatureFlagsFrom,
} from "@maple/domain/organization-feature-flags"
import * as Policy from "@maple/domain/policy"
import { isClerkAuthEnabled } from "../../lib/services/common/auth-mode"
import { NetworkErrorBody } from "@maple/web-data/lib/error-messages"
import { Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure, settleTo } from "@maple/views/data/load-failure"
import { SessionTenant } from "../../data/session-tenant"
import { Message } from "./message"
import { BillingCustomerCache } from "../../data/billing-customer"

export const ReadSettingsClock = readClock("ReadSettingsClock", Message.ReadClock)

/** `retainedQuery("auth", "session", {})`, shared with the shell through `SessionTenant`. */
export const FetchSettingsSession = Command.define("FetchSettingsSession", {
	messages: [Message.CompletedFetchSession],
	execute: Effect.gen(function* () {
		const session = yield* (yield* SessionTenant).get
		const flags = isClerkAuthEnabled
			? organizationFeatureFlagsFrom(window.Clerk?.organization?.publicMetadata)
			: ENABLED_ORGANIZATION_FEATURE_FLAGS
		return {
			grants: Policy.grantsOf(session.roles),
			userId: session.userId,
			hasAiAutoTriage: flags.aiAutoTriage,
			hasDataSources: flags.dataSources,
		}
	}).pipe(settleTo((result) => Message.CompletedFetchSession({ result }))),
})

/** A customer read still pending after this reads as unreachable, so Billing shows Retry, not shimmer. */
const CUSTOMER_TIMEOUT = Duration.seconds(10)

/** `billingCustomerAtom`: the nav's data-platform gate and the Billing tab. */
export const FetchSettingsCustomer = Command.define("FetchSettingsCustomer", {
	// `orgId` on entry; a refresh passes null and reads under the org the entry named.
	args: { orgId: Schema.NullOr(Schema.String), refresh: Schema.Boolean },
	messages: [Message.CompletedFetchCustomer],
	execute: ({ orgId, refresh }) =>
		Effect.gen(function* () {
			return yield* (yield* BillingCustomerCache).get(orgId === null ? { refresh } : { refresh, orgId })
		}).pipe(
			Effect.timeoutOrElse({ duration: CUSTOMER_TIMEOUT, orElse: () => Effect.fail(NetworkErrorBody) }),
			Effect.mapError(toLoadFailure),
			Effect.catchDefect((defect) => Effect.fail(toLoadFailure(defect))),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchCustomer({ result })),
		),
})
