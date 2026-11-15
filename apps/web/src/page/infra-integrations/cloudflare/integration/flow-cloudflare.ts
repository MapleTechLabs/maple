import type { CloudflareIntegrationStatus, CloudflareUsageResponse } from "@maple/domain/http"
import { INTEGRATION_FEATURES } from "@maple/domain/integration-features"
import { countLabel } from "@maple/ui/lib/format"
import { Array as Arr } from "effect"
import { shownSwitches } from "../../../integrations/feature-switches"
import { savedCloudflareFeatures } from "./update-cloudflare"
import type { CloudflareIngestPhase } from "../ingest-phase"
import { ingestPhaseOf } from "../ingest"
import { accountErrorOf, connectedAccountsOf } from "./cloudflare-derive"
import { fold } from "../../../integrations/derive"
import type { FlowSpec, LiveHealth } from "../../../integrations/flow"
import type { Model } from "../../../integrations/model"
import { successOf } from "../../kit/success-of"

// Cloudflare's place in the connect flow: one consent screen, then what to collect, then Go live.
// Accounts are picked on Cloudflare's consent screen; Choose data is the feature switches.

export const cloudflareStatusOf = (model: Model): CloudflareIntegrationStatus | null =>
	fold(
		model.statuses.cloudflare,
		(data): CloudflareIntegrationStatus | null => data,
		() => null,
	)

/** The warehouse usage read, or null while it loads or failed (the phase then reads the poller). */
export const cloudflareUsageOf = (model: Model): CloudflareUsageResponse | null => {
	const data = model.cloudflareCard.usage.data
	return successOf(data)
}

/** The accounts the grant reached: the one name, or how many. */
export const cloudflareReach = (status: CloudflareIntegrationStatus): string => {
	const accounts = connectedAccountsOf(status)
	const only = accounts.length === 1 ? accounts[0] : undefined
	return only !== undefined
		? (only.accountName ?? only.accountId)
		: accounts.length === 0
			? (status.accountName ?? "Cloudflare account")
			: countLabel(accounts.length, "account")
}

export const cloudflarePhaseOf = (model: Model): CloudflareIngestPhase | null =>
	ingestPhaseOf(cloudflareStatusOf(model), cloudflareUsageOf(model), model.nowMs)

const liveOf = (
	status: CloudflareIntegrationStatus | null,
	phase: CloudflareIngestPhase | null,
): LiveHealth =>
	status === null || !status.connected
		? "pending"
		: !status.analyticsCapable || accountErrorOf(status) !== null || phase?.kind === "stalled"
			? "attention"
			: phase?.kind === "live"
				? "healthy"
				: "pending"

/** How many of the grant's features are switched on, as the card shows them. */
export const cloudflareFeaturesOn = (model: Model, status: CloudflareIntegrationStatus): number => {
	const shown = shownSwitches(model.cloudflareCard.features, savedCloudflareFeatures(status))
	return Arr.filter(INTEGRATION_FEATURES.cloudflare, (spec) => shown[`${spec.id}Enabled`]).length
}

export const cloudflareFlow = (model: Model): FlowSpec => {
	const status = cloudflareStatusOf(model)
	const isConnected = status !== null && status.connected
	const connected = isConnected ? cloudflareReach(status) : null
	const accounts = isConnected ? Math.max(connectedAccountsOf(status).length, 1) : 0
	const live = liveOf(status, cloudflarePhaseOf(model))
	const featuresOn = isConnected ? cloudflareFeaturesOn(model, status) : 0
	const total = INTEGRATION_FEATURES.cloudflare.length
	return {
		stages: ["connect", "choose", "live"],
		connected,
		chosen: featuresOn > 0 ? `${featuresOn} of ${total} features` : null,
		live,
		hint: {
			connect:
				connected !== null
					? `${countLabel(accounts, "account")} found`
					: model.connect.active !== null
						? "Waiting for you to approve in Cloudflare."
						: "Authorize to continue.",
			choose: featuresOn > 0 ? "Saved as you switch. Next, go live." : "Turn on at least one feature.",
			live:
				live === "healthy"
					? "Cloudflare is live."
					: isConnected && !status.analyticsCapable
						? "Saved. Collection starts once access is updated."
						: "Saved. Checks keep running if you leave.",
		},
	}
}
