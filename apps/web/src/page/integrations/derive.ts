import * as Policy from "@maple/domain/policy"
import { type AwsStreamState, awsStreamState } from "@maple/domain/aws"
import type { V2AwsConnection } from "@maple/domain/http/v2"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { AsyncData } from "foldkit"
import type { IntegrationId } from "./catalog"
import { hasBringYourOwnCloudAddOn } from "../kit/billing/plan-gating"
import type { Visibility } from "../settings/nav"
import type { Model, Statuses } from "./model"
import { providerModuleOf } from "./provider-modules"
import { type CardStatus, type IntegrationOverview, isoMs, type LastSync } from "./overview"

export {
	type AvailableOverview,
	type CardStatus,
	type ConnectedOverview,
	fold,
	type IntegrationOverview,
	isoMs,
	type LastSync,
	type UnavailableOverview,
} from "./overview"

/** Where a connection's metric stream stands, as the source's health reads it. */
export const awsStreamOf = (connection: V2AwsConnection, nowMs: number): AwsStreamState =>
	awsStreamState(
		{
			verifiedAt: isoMs(connection.verified_at),
			metricStream: connection.metric_stream,
			metricStreamChangedAt: isoMs(connection.metric_stream_changed_at),
			metricsLastReceivedAt: isoMs(connection.metrics_last_received_at),
			metricsLastError: connection.metrics_last_error,
		},
		nowMs,
	)

/** The one thing a connection needs next, or that it receives metrics; worst first. */
export type AwsConnectionCondition =
	| "setup"
	| "failing"
	| "not-receiving"
	| "outdated"
	| "metrics-off"
	| "stopped"
	| "waiting"
	| "receiving"

export const awsConditionOf = (connection: V2AwsConnection, nowMs: number): AwsConnectionCondition => {
	if (connection.verified_at === null) return "setup"
	if (connection.last_check_error !== null) return "failing"
	const stream = awsStreamOf(connection, nowMs)
	if (stream._tag === "refused" || stream._tag === "undelivered") return "not-receiving"
	if (stream._tag === "silent") return "stopped"
	if (connection.setup_outdated) return "outdated"
	switch (stream._tag) {
		case "off":
			return "metrics-off"
		case "waiting":
			return "waiting"
		case "delivering":
			return "receiving"
	}
}

export const AWS_CONDITION_LABEL = {
	setup: "Finish setup",
	failing: "Needs attention",
	"not-receiving": "No metrics arriving",
	outdated: "Update the stack",
	"metrics-off": "Metrics off",
	stopped: "Metrics stopped",
	waiting: "Waiting for metrics",
	receiving: "Receiving metrics",
} satisfies Record<AwsConnectionCondition, string>

export const HEALTH_TONE = {
	healthy: "ok",
	attention: "warn",
	pending: "neutral",
	unavailable: "warn",
} as const

/** `synced 3m ago`: a last sync as plain text, for places that cannot hold a timestamp. */
export const lastSyncText = (lastSync: LastSync, nowMs: number): string =>
	`${lastSync.verb} ${formatRelativeTime(lastSync.at, nowMs)}`

/** The header badge per integration; `null` while loading. */
export const cardStatusOf = (statuses: Statuses, id: IntegrationId, nowMs: number): CardStatus | null =>
	providerModuleOf(id).cardStatus(statuses, { id, nowMs })

/** One integration's overview; `null` while its status loads. */
export const overviewOf = (statuses: Statuses, nowMs: number, id: IntegrationId): IntegrationOverview =>
	providerModuleOf(id).overview(statuses, { id, nowMs })

/** `useVisibleSettingsSections()` on `/integrations`: the session's admin flag and the BYOC add-on. */
export const settingsNavVisibility = (
	model: Pick<Model, "grants" | "customer" | "hasDataSources">,
	isClerk: boolean,
): Visibility => {
	if (!isClerk)
		return { isClerk, grants: Policy.allPermissions, canAccessDataPlatform: true, hasDataSources: true }
	const hasByoc = AsyncData.getOrElse(
		AsyncData.map(model.customer.data, hasBringYourOwnCloudAddOn),
		() => false,
	)
	return {
		isClerk,
		grants: model.grants,
		canAccessDataPlatform: Policy.can(model.grants, "warehouse:manage") && hasByoc,
		hasDataSources: model.hasDataSources,
	}
}
