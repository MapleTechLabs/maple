import type { CloudflareIntegrationStatus, CloudflareUsageResponse } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import type { CloudflareIngestPhase } from "../../components/infra/cloudflare/ingest-phase"
import { ingestPhaseOf } from "../infra-integrations/cloudflare/ingest"
import { accountErrorOf, connectedAccountsOf } from "./cloudflare-derive"
import { fold } from "./derive"
import type { FlowSpec, LiveHealth } from "./flow"
import type { Model } from "./model"

// Cloudflare's place in the connect flow: one consent screen, then Go live. Accounts are picked on
// Cloudflare's consent screen and zones are not selectable yet, so there is no Choose data step.

export const cloudflareStatusOf = (model: Model): CloudflareIntegrationStatus | null =>
	fold(
		model.statuses.cloudflare,
		(data): CloudflareIntegrationStatus | null => data,
		() => null,
	)

/** The warehouse usage read, or null while it loads or failed (the phase then reads the poller). */
export const cloudflareUsageOf = (model: Model): CloudflareUsageResponse | null => {
	const data = model.cloudflareCard.usage.data
	return AsyncData.isSuccess(data) || AsyncData.isRefreshing(data) ? data.data : null
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

export const cloudflareFlow = (model: Model): FlowSpec => {
	const status = cloudflareStatusOf(model)
	const isConnected = status !== null && status.connected
	const connected = isConnected ? cloudflareReach(status) : null
	const accounts = isConnected ? Math.max(connectedAccountsOf(status).length, 1) : 0
	const live = liveOf(status, cloudflarePhaseOf(model))
	return {
		stages: ["connect", "live"],
		connected,
		chosen: null,
		live,
		hint: {
			connect:
				connected !== null
					? `${countLabel(accounts, "account")} found`
					: model.connect.active !== null
						? "Waiting for you to approve in Cloudflare."
						: "Authorize to continue.",
			choose: "",
			live:
				live === "healthy"
					? "Cloudflare is live."
					: isConnected && !status.analyticsCapable
						? "Saved. Collection starts once access is updated."
						: "Saved. Checks keep running if you leave.",
		},
	}
}
