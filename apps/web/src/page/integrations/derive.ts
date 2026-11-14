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
import {
	metricsAuthOf,
	metricsLastCollectedAt,
	metricsLastError,
} from "../infra-integrations/planetscale/setup-steps"
import type { IntegrationId } from "./catalog"
import { hasBringYourOwnCloudAddOn } from "../kit/billing/plan-gating"
import {
	scopeLabel,
	signalsLabel,
	vercelHealth,
	vercelIssues,
} from "../infra-integrations/vercel/integration/vercel-model"
import type { Visibility } from "../settings/nav"
import type { Model, Statuses } from "./model"
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

const scrapeStatus = (statuses: Statuses, targetType: "prometheus" | "planetscale") =>
	fold(
		statuses.scrapeTargets,
		(data): CardStatus => {
			const targets = Arr.filter(data, (target) => target.target_type === targetType)
			if (targets.length === 0) return NOT_CONNECTED
			const failing = Arr.some(targets, (target) => target.enabled && target.last_scrape_error !== null)
			const enabled = Arr.filter(targets, (target) => target.enabled).length
			const noun = targetType === "planetscale" ? "org" : "target"
			return {
				label: `${countLabel(targets.length, noun)} · ${enabled} enabled`,
				variant: failing ? "warn" : "ok",
			}
		},
		unavailableStatus,
	)

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

const connectedOrNot = (connected: boolean): CardStatus =>
	connected ? { label: "Connected", variant: "ok" } : NOT_CONNECTED

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
		case "vercel":
			return fold(
				statuses.vercel,
				(status): CardStatus =>
					!status.connected
						? NOT_CONNECTED
						: status.authFailed
							? { label: "Token rejected", variant: "crit" }
							: vercelIssues(status).length > 0
								? { label: "Needs attention", variant: "warn" }
								: { label: status.team?.name ?? "Connected", variant: "ok" },
				unavailableStatus,
			)
		case "cloudflare":
			return fold(statuses.cloudflare, (status) => connectedOrNot(status.connected), unavailableStatus)
		case "prometheus":
			return scrapeStatus(statuses, "prometheus")
		case "planetscale":
			return fold(
				statuses.planetscale,
				(status): CardStatus | null =>
					status.connected
						? {
								label: status.organization ?? "Connected",
								variant: metricsLastError(status) !== null ? "warn" : "ok",
							}
						: scrapeStatus(statuses, "planetscale"),
				unavailableStatus,
			)
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

const VERCEL_STATE_LABEL = { attention: "Needs attention", pending: "Syncing", healthy: "Healthy" } as const

const vercelOverview = (statuses: Statuses) =>
	fold(
		statuses.vercel,
		(status): IntegrationOverview => {
			if (!status.connected) return CONNECT
			const issues = vercelIssues(status)
			const health = vercelHealth(status)
			return {
				kind: "connected",
				health,
				stateLabel: VERCEL_STATE_LABEL[health],
				context: status.team?.name ?? null,
				stat: `${signalsLabel(status)} · ${scopeLabel(status)}`,
				lastSync: lastSyncOf(status.lastSuccessAt, "checked"),
				issue: status.authFailed
					? "Token rejected"
					: issues.length > 0
						? `${countLabel(issues.length, "drain")} failing`
						: null,
			}
		},
		unavailableOverview,
	)

const cloudflareOverview = (statuses: Statuses) =>
	fold(
		statuses.cloudflare,
		(status): IntegrationOverview => {
			if (!status.connected) return CONNECT
			const zones = status.zones
			const enabledZones = Arr.filter(zones, (zone) => zone.enabled).length
			const erroringZones = Arr.filter(zones, (zone) => zone.enabled && zone.lastError != null).length
			const workersFailing = status.workers?.enabled === true && status.workers.lastError != null
			const issue = !status.analyticsCapable
				? "Update access"
				: erroringZones > 0
					? `${countLabel(erroringZones, "zone")} erroring`
					: workersFailing
						? "Workers sync failing"
						: null
			const statParts = [
				...(zones.length > 0
					? [`${enabledZones} of ${countLabel(zones.length, "zone")} streaming`]
					: []),
				...(status.workers?.enabled === true ? ["Workers"] : []),
			]
			return {
				kind: "connected",
				...attentionOr(issue),
				context: status.accountName,
				stat: statParts.length > 0 ? Arr.join(statParts, " · ") : null,
				lastSync: lastSyncOf(
					maxMs([...Arr.map(zones, (zone) => zone.lastSyncedAt), status.workers?.lastSyncedAt]),
				),
				issue,
			}
		},
		unavailableOverview,
	)

const scrapeOverview = (statuses: Statuses, targetType: "prometheus" | "planetscale") =>
	fold(
		statuses.scrapeTargets,
		(data): IntegrationOverview => {
			const targets = Arr.filter(data, (target) => target.target_type === targetType)
			if (targets.length === 0) return targetType === "prometheus" ? SET_UP : CONNECT
			const enabled = Arr.filter(targets, (target) => target.enabled).length
			const failing = Arr.filter(
				targets,
				(target) => target.enabled && target.last_scrape_error !== null,
			).length
			const noun = targetType === "planetscale" ? "org" : "target"
			return {
				kind: "connected",
				health: failing > 0 ? "attention" : "healthy",
				stateLabel: failing > 0 ? "Needs attention" : "Healthy",
				context: countLabel(targets.length, `scrape ${noun}`),
				stat: `${enabled} of ${targets.length} enabled`,
				lastSync: lastSyncOf(maxMs(Arr.map(targets, (t) => isoMs(t.last_scrape_at))), "scraped"),
				issue: failing > 0 ? `${countLabel(failing, noun)} failing` : null,
			}
		},
		unavailableOverview,
	)

const planetscaleOverview = (statuses: Statuses) => {
	const dbCount = fold(
		statuses.planetscaleDatabases,
		(response): number | null => response.databases.length,
		() => null,
	)
	return fold(
		statuses.planetscale,
		(status): IntegrationOverview => {
			if (!status.connected) return scrapeOverview(statuses, "planetscale")
			const issue = status.pending_org_selection
				? "Finish org selection"
				: metricsLastError(status) !== null
					? metricsAuthOf(status) === "api"
						? "Metrics polling failing"
						: "Scrape failing"
					: status.last_inventory_error != null
						? "Inventory failing"
						: null
			return {
				kind: "connected",
				...attentionOr(issue),
				context: status.organization,
				stat:
					dbCount !== null && dbCount > 0
						? `${countLabel(dbCount, "database")} tracked`
						: metricsAuthOf(status) === "api" || status.scrape_target?.enabled === true
							? "Branch metrics on"
							: null,
				lastSync: lastSyncOf(
					maxMs(Arr.map([metricsLastCollectedAt(status), status.last_inventory_at], isoMs)),
				),
				issue,
			}
		},
		unavailableOverview,
	)
}

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
		case "vercel":
			return vercelOverview(statuses)
		case "cloudflare":
			return cloudflareOverview(statuses)
		case "prometheus":
			return scrapeOverview(statuses, "prometheus")
		case "planetscale":
			return planetscaleOverview(statuses)
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
