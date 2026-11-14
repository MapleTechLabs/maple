import * as Policy from "@maple/domain/policy"
import { type AwsStreamState, awsStreamState } from "@maple/domain/aws"
import type { V2AwsConnection } from "@maple/domain/http/v2"
import { countLabel } from "@maple/ui/lib/format"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import {
	GCP_CONNECTION_LABEL,
	gcpConnectionState,
	gcpScopeLabel,
	gcpWorstState,
} from "../infra-integrations/gcp/connector-state"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { IntegrationId } from "./catalog"
import { hasBringYourOwnCloudAddOn } from "../kit/billing/plan-gating"
import type { Visibility } from "../settings/nav"
import type { Model, Statuses } from "./model"
import { scrapeOverview, scrapeStatus } from "./scrape-overview"
import { providerModuleOf } from "./provider-modules"
import {
	attentionOr,
	type CardStatus,
	CONNECT,
	fold,
	type IntegrationOverview,
	isoMs,
	type LastSync,
	lastSyncOf,
	maxMs,
	NOT_CONNECTED,
	SET_UP,
	unavailableOverview,
	unavailableStatus,
} from "./overview"

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

/** Worst first: a connection's own condition and the integration's worst follow this order. */
const AWS_CONDITION_RANK: ReadonlyArray<AwsConnectionCondition> = [
	"failing",
	"not-receiving",
	"stopped",
	"setup",
	"outdated",
	"metrics-off",
	"waiting",
	"receiving",
]

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

const githubStatus = (statuses: Statuses) =>
	fold(
		statuses.github,
		(status): CardStatus => {
			if (status.state === "disconnected") return { label: "Deactivated", variant: "warn" }
			if (status.state === "suspended") return { label: "Suspended", variant: "warn" }
			if (!status.connected) return NOT_CONNECTED
			const count = Arr.filter(status.repositories, (repo) => repo.status === "active").length
			return { label: count > 0 ? countLabel(count, "repo") : "Connected", variant: "ok" }
		},
		unavailableStatus,
	)

/** The header badge per integration; `null` while loading. */
export const cardStatusOf = (statuses: Statuses, id: IntegrationId, nowMs: number): CardStatus | null => {
	const provider = providerModuleOf(id)
	if (provider !== undefined) return provider.cardStatus(statuses, { id, nowMs })
	switch (id) {
		case "gcp":
			return fold(
				statuses.gcp,
				(status): CardStatus =>
					status.connectors.length === 0
						? NOT_CONNECTED
						: { label: countLabel(status.connectors.length, "connection"), variant: "ok" },
				unavailableStatus,
			)
		case "aws":
			return fold(
				statuses.aws,
				(status): CardStatus => {
					if (status.connections.length === 0) return NOT_CONNECTED
					const worst = worstAwsCondition(status.connections, nowMs)
					return worst === "receiving"
						? { label: countLabel(status.connections.length, "account"), variant: "ok" }
						: {
								label: AWS_CONDITION_LABEL[worst],
								variant: worst === "failing" || worst === "not-receiving" ? "crit" : "warn",
							}
				},
				unavailableStatus,
			)
		case "prometheus":
			return scrapeStatus(statuses, "prometheus")
		case "warpstream":
			return { label: "Via Prometheus", variant: "outline" }
		case "github":
			return githubStatus(statuses)
		default:
			return null
	}
}

const gcpOverview = (statuses: Statuses, nowMs: number) =>
	fold(
		statuses.gcp,
		(status): IntegrationOverview => {
			const connectors = status.connectors
			if (connectors.length === 0) return SET_UP
			const states = Arr.map(connectors, (connector) => gcpConnectionState(connector, nowMs))
			const count = (state: (typeof states)[number]) =>
				Arr.filter(states, (entry) => entry === state).length
			const worst = gcpWorstState(states)
			const lastData = maxMs(
				Arr.map(
					Arr.flatMap(connectors, (connector) => [
						connector.logs_enabled ? connector.last_log_received_at : null,
						connector.metrics_enabled ? connector.last_metrics_received_at : null,
					]),
					isoMs,
				),
			)
			return {
				kind: "connected",
				health: worst === "attention" || worst === "healthy" ? worst : "pending",
				stateLabel: GCP_CONNECTION_LABEL[worst],
				context:
					connectors.length === 1 && connectors[0] !== undefined
						? gcpScopeLabel(connectors[0])
						: countLabel(connectors.length, "connection"),
				stat: Arr.join(
					Arr.filter(
						[
							Arr.some(connectors, (connector) => connector.logs_enabled) ? "Logs" : null,
							Arr.some(connectors, (connector) => connector.metrics_enabled)
								? "Metrics and resources"
								: null,
						],
						(part) => part !== null,
					),
					" · ",
				),
				lastSync: worst === "waiting" ? null : lastSyncOf(lastData, "last data"),
				issue:
					worst === "attention"
						? `${countLabel(count("attention"), "connection")} failing`
						: worst === "setup-pending" || worst === "changes-pending"
							? "Finish setup"
							: null,
			}
		},
		unavailableOverview,
	)

const worstAwsCondition = (connections: ReadonlyArray<V2AwsConnection>, nowMs: number) => {
	const conditions = Arr.map(connections, (connection) => awsConditionOf(connection, nowMs))
	return Option.getOrElse(
		Arr.findFirst(AWS_CONDITION_RANK, (condition) => conditions.includes(condition)),
		(): AwsConnectionCondition => "receiving",
	)
}

const awsOverview = (statuses: Statuses, nowMs: number) =>
	fold(
		statuses.aws,
		(status): IntegrationOverview => {
			if (status.connections.length === 0) return CONNECT
			const conditions = Arr.map(status.connections, (connection) => awsConditionOf(connection, nowMs))
			const failing = Arr.filter(conditions, (condition) => condition === "failing").length
			const worst = worstAwsCondition(status.connections, nowMs)
			const issue =
				worst === "failing"
					? `${countLabel(failing, "account")} failing`
					: worst === "receiving"
						? null
						: AWS_CONDITION_LABEL[worst]
			// A stack not deployed yet, or a first delivery on its way, is setup in progress, not a failure.
			const health: Pick<IntegrationOverview & { kind: "connected" }, "health" | "stateLabel"> =
				worst === "setup" || worst === "waiting"
					? { health: "pending", stateLabel: AWS_CONDITION_LABEL[worst] }
					: attentionOr(issue)
			const receiving = Arr.filter(conditions, (condition) => condition === "receiving").length
			const accounts = countLabel(status.connections.length, "account")
			return {
				kind: "connected",
				...health,
				context: status.connections.length === 1 ? (status.connections[0]?.account_id ?? null) : null,
				stat: conditions.includes("setup") ? accounts : `${receiving} of ${accounts} sending metrics`,
				lastSync: lastSyncOf(
					maxMs(
						Arr.map(status.connections, (connection) =>
							isoMs(connection.metrics_last_received_at),
						),
					),
					"last data",
				),
				issue,
			}
		},
		unavailableOverview,
	)

const githubOverview = (statuses: Statuses) =>
	fold(
		statuses.github,
		(status): IntegrationOverview => {
			const context =
				status.accountLogin !== null ? `@${status.accountLogin} · GitHub App` : "GitHub App"
			const halted = (stateLabel: string, issue: string): IntegrationOverview => ({
				kind: "connected",
				health: "attention",
				stateLabel,
				context,
				stat: null,
				lastSync: null,
				issue,
			})
			if (status.state === "disconnected") return halted("Deactivated", "Reinstall the app")
			if (status.state === "suspended") return halted("Suspended", "Suspended on GitHub")
			if (!status.connected) return CONNECT
			const active = Arr.filter(status.repositories, (repo) => repo.status === "active")
			const removed = status.repositories.length - active.length
			const failing = Arr.filter(active, (repo) => repo.lastSyncError != null).length
			const issue =
				failing > 0
					? `${countLabel(failing, "repo")} failing`
					: removed > 0
						? `${countLabel(removed, "repo")} removed`
						: null
			return {
				kind: "connected",
				...attentionOr(issue),
				context,
				stat: active.length > 0 ? `${countLabel(active.length, "repo")} synced` : null,
				lastSync: lastSyncOf(maxMs(Arr.map(active, (repo) => repo.lastSyncedAt))),
				issue,
			}
		},
		unavailableOverview,
	)

/** One integration's overview; `null` while its status loads. */
export const overviewOf = (statuses: Statuses, nowMs: number, id: IntegrationId): IntegrationOverview => {
	const provider = providerModuleOf(id)
	if (provider !== undefined) return provider.overview(statuses, { id, nowMs })
	switch (id) {
		case "gcp":
			return gcpOverview(statuses, nowMs)
		case "aws":
			return awsOverview(statuses, nowMs)
		case "prometheus":
			return scrapeOverview(statuses, "prometheus")
		case "warpstream":
			return SET_UP
		case "github":
			return githubOverview(statuses)
		default:
			return null
	}
}

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
		canAccessDataPlatform: Policy.has(model.grants, "warehouse:manage") && hasByoc,
		hasDataSources: model.hasDataSources,
	}
}
