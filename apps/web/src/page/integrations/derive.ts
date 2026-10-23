import { countLabel } from "@maple/ui/lib/format"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import {
	GCP_CONNECTION_LABEL,
	gcpConnectionState,
	gcpScopeLabel,
	gcpWorstState,
} from "../../components/integrations/gcp-connector-state"
import { Array, DateTime, Option } from "effect"
import { AsyncData } from "foldkit"
import type { Keyed } from "../../data/keyed"
import { chatIntegrationId, HUB_CATALOG, type IntegrationId } from "./catalog"
import { hasBringYourOwnCloudAddOn } from "../../lib/billing/plan-gating"
import type { Visibility } from "../settings/nav"
import type { Model, Statuses } from "./model"

// `useIntegrationStatuses` and `useIntegrationOverviews`, as pure folds.

/** `Result.builder`: success (also while revalidating), initial (`null`), else the failure value. */
export const fold = <A, E, R>(slot: Keyed<A, E>, onSuccess: (data: A) => R, onFailure: () => R): R | null =>
	AsyncData.match(slot.data, {
		onIdle: () => null,
		onLoading: () => null,
		onRefreshing: onSuccess,
		onSuccess,
		onFailure: () => onFailure(),
		onStale: () => onFailure(),
	})

/** `Date.parse` of an ISO timestamp (lint-banned), `null` when absent or unparseable. */
export const isoMs = (iso: string | null | undefined): number | null =>
	iso === null || iso === undefined
		? null
		: Option.getOrNull(Option.map(DateTime.make(iso), DateTime.toEpochMillis))

export interface CardStatus {
	readonly label: string
	readonly variant: "ok" | "warn" | "crit" | "outline"
}

const NOT_CONNECTED: CardStatus = { label: "Not connected", variant: "outline" }
const NOT_CONFIGURED: CardStatus = { label: "Not configured", variant: "outline" }
const STATUS_UNAVAILABLE: CardStatus = { label: "Status unavailable", variant: "outline" }

export interface ConnectedOverview {
	readonly kind: "connected"
	readonly health: "healthy" | "attention" | "pending"
	readonly stateLabel: string
	readonly context: string | null
	readonly stat: string | null
	readonly lastSyncLabel: string | null
	readonly issue: string | null
}
export interface AvailableOverview {
	readonly kind: "available"
	readonly cta: "Connect" | "Set up"
}
export interface UnavailableOverview {
	readonly kind: "unavailable"
}
export type IntegrationOverview = ConnectedOverview | AvailableOverview | UnavailableOverview | null

const CONNECT: AvailableOverview = { kind: "available", cta: "Connect" }
const SET_UP: AvailableOverview = { kind: "available", cta: "Set up" }
const UNAVAILABLE: UnavailableOverview = { kind: "unavailable" }

export const HEALTH_TONE = {
	healthy: "ok",
	attention: "warn",
	pending: "neutral",
	unavailable: "neutral",
} as const

const syncedLabel = (ms: number | null, nowMs: number, verb = "synced"): string | null =>
	ms === null ? null : `${verb} ${formatRelativeTime(ms, nowMs)}`

const maxMs = (values: ReadonlyArray<number | null | undefined>): number | null =>
	values.reduce<number | null>(
		(acc, v) => (v !== null && v !== undefined && (acc === null || v > acc) ? v : acc),
		null,
	)

const unavailableStatus = () => STATUS_UNAVAILABLE

const scrapeStatus = (statuses: Statuses, targetType: "prometheus" | "planetscale") =>
	fold(
		statuses.scrapeTargets,
		(data): CardStatus => {
			const targets = data.filter((target) => target.target_type === targetType)
			if (targets.length === 0) return NOT_CONNECTED
			const failing = targets.some((target) => target.enabled && target.last_scrape_error !== null)
			const enabled = targets.filter((target) => target.enabled).length
			const noun = targetType === "planetscale" ? "org" : "target"
			return {
				label: `${countLabel(targets.length, noun)} · ${enabled} enabled`,
				variant: failing ? "warn" : "ok",
			}
		},
		unavailableStatus,
	)

const chatStatus = (statuses: Statuses, id: IntegrationId) =>
	fold(
		statuses.chat,
		(response): CardStatus => {
			const connector = response.data.find((entry) => chatIntegrationId(entry.id) === id)
			const workspaces = connector?.workspaces ?? []
			if (workspaces.length === 0)
				return connector?.available === false ? NOT_CONFIGURED : NOT_CONNECTED
			return {
				label:
					workspaces.length === 1
						? (workspaces[0]?.name ?? "Connected")
						: `${workspaces.length} workspaces`,
				variant: "ok",
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
			const count = status.repositories.filter((repo) => repo.status === "active").length
			return { label: count > 0 ? countLabel(count, "repo") : "Connected", variant: "ok" }
		},
		unavailableStatus,
	)

const connectedOrNot = (connected: boolean): CardStatus =>
	connected ? { label: "Connected", variant: "ok" } : NOT_CONNECTED

/** The header badge per integration (`useIntegrationStatuses`); `null` while loading. */
export const cardStatusOf = (statuses: Statuses, id: IntegrationId): CardStatus | null => {
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
				(status): CardStatus =>
					status.connections.length === 0
						? NOT_CONNECTED
						: status.connections.some((connection) => connection.verified_at === null)
							? { label: "Finish setup", variant: "warn" }
							: { label: countLabel(status.connections.length, "account"), variant: "ok" },
				unavailableStatus,
			)
		case "railway":
			return fold(
				statuses.railway,
				(status): CardStatus =>
					!status.connected
						? NOT_CONNECTED
						: status.authFailed
							? { label: "Token rejected", variant: "crit" }
							: { label: countLabel(status.environments.length, "environment"), variant: "ok" },
				unavailableStatus,
			)
		case "supabase":
			return fold(
				statuses.supabase,
				(status): CardStatus =>
					!status.configured
						? NOT_CONFIGURED
						: !status.connected
							? NOT_CONNECTED
							: status.revoked
								? { label: "Access revoked", variant: "crit" }
								: { label: status.organization?.name ?? "Connected", variant: "ok" },
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
								variant: status.scrape_target?.last_scrape_error != null ? "warn" : "ok",
							}
						: scrapeStatus(statuses, "planetscale"),
				unavailableStatus,
			)
		case "warpstream":
			return { label: "Via Prometheus", variant: "outline" }
		case "hazel":
			return fold(statuses.hazel, (status) => connectedOrNot(status.connected), unavailableStatus)
		case "github":
			return githubStatus(statuses)
		default:
			return chatStatus(statuses, id)
	}
}

// OVERVIEWS

const unavailableOverview = (): IntegrationOverview => UNAVAILABLE

const attentionOr = (issue: string | null) =>
	({
		health: issue !== null ? "attention" : "healthy",
		stateLabel: issue !== null ? "Needs attention" : "Healthy",
	}) as const

const gcpOverview = (statuses: Statuses, nowMs: number) =>
	fold(
		statuses.gcp,
		(status): IntegrationOverview => {
			const connectors = status.connectors
			if (connectors.length === 0) return SET_UP
			const states = connectors.map((connector) => gcpConnectionState(connector, nowMs))
			const count = (state: (typeof states)[number]) => states.filter((entry) => entry === state).length
			const worst = gcpWorstState(states)
			const lastData = maxMs(
				connectors
					.flatMap((connector) => [
						connector.logs_enabled ? connector.last_log_received_at : null,
						connector.metrics_enabled ? connector.last_metrics_received_at : null,
					])
					.map(isoMs),
			)
			return {
				kind: "connected",
				health: worst === "attention" || worst === "healthy" ? worst : "pending",
				stateLabel: GCP_CONNECTION_LABEL[worst],
				context:
					connectors.length === 1 && connectors[0] !== undefined
						? gcpScopeLabel(connectors[0])
						: countLabel(connectors.length, "connection"),
				stat: [
					connectors.some((connector) => connector.logs_enabled) ? "Logs" : null,
					connectors.some((connector) => connector.metrics_enabled)
						? "Metrics and resources"
						: null,
				]
					.filter((part) => part !== null)
					.join(" · "),
				lastSyncLabel: worst === "waiting" ? null : syncedLabel(lastData, nowMs, "last data"),
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

const awsOverview = (statuses: Statuses, nowMs: number) =>
	fold(
		statuses.aws,
		(status): IntegrationOverview => {
			if (status.connections.length === 0) return CONNECT
			const failing = status.connections.filter(
				(connection) => connection.verified_at !== null && connection.last_check_error !== null,
			).length
			const pending = status.connections.some((connection) => connection.verified_at === null)
			// A verified stack older than the connection's modules needs redeploying, as its row says.
			const outdated = status.connections.some(
				(connection) => connection.verified_at !== null && connection.setup_outdated,
			)
			// Without a metric stream a connected account sends Maple nothing.
			const metricsOff = status.connections.some(
				(connection) => connection.verified_at !== null && connection.metric_stream === null,
			)
			const issue =
				failing > 0
					? `${countLabel(failing, "account")} failing`
					: pending
						? "Finish setup"
						: outdated
							? "Update the stack"
							: metricsOff
								? "Metrics off"
								: null
			// A stack not deployed yet is setup in progress, not a failure.
			const health: Pick<IntegrationOverview & { kind: "connected" }, "health" | "stateLabel"> =
				failing === 0 && pending
					? { health: "pending", stateLabel: "Finish setup" }
					: attentionOr(issue)
			return {
				kind: "connected",
				...health,
				context: status.connections.length === 1 ? (status.connections[0]?.account_id ?? null) : null,
				stat: countLabel(status.connections.length, "account"),
				lastSyncLabel: syncedLabel(
					maxMs(status.connections.map((connection) => isoMs(connection.last_checked_at))),
					nowMs,
					"checked",
				),
				issue,
			}
		},
		unavailableOverview,
	)

const railwayOverview = (statuses: Statuses, nowMs: number) =>
	fold(
		statuses.railway,
		(status): IntegrationOverview => {
			if (!status.connected) return CONNECT
			const failing = status.environments.filter((environment) => environment.lastError != null).length
			const issue = status.authFailed
				? "Token rejected"
				: failing > 0
					? `${countLabel(failing, "environment")} failing`
					: null
			return {
				kind: "connected",
				...attentionOr(issue),
				context: status.workspaceNames,
				stat: `${countLabel(status.environments.length, "environment")} polled`,
				lastSyncLabel: syncedLabel(status.lastSyncedAt ?? null, nowMs),
				issue,
			}
		},
		unavailableOverview,
	)

const supabaseOverview = (statuses: Statuses, nowMs: number) =>
	fold(
		statuses.supabase,
		(status): IntegrationOverview => {
			if (!status.configured) return UNAVAILABLE
			if (!status.connected) return CONNECT
			const issue = status.revoked
				? "Reconnect to resume"
				: status.lastDiscoveryError !== null
					? "Project discovery failing"
					: null
			const collecting = status.projects.filter((project) => project.metricsEnabled).length
			return {
				kind: "connected",
				...attentionOr(issue),
				context: status.organization?.name ?? null,
				stat: `${countLabel(status.projects.length, "project")} · ${collecting} collecting metrics`,
				lastSyncLabel: syncedLabel(status.lastDiscoveryAt, nowMs),
				issue,
			}
		},
		unavailableOverview,
	)

const cloudflareOverview = (statuses: Statuses, nowMs: number) =>
	fold(
		statuses.cloudflare,
		(status): IntegrationOverview => {
			if (!status.connected) return CONNECT
			const zones = status.zones
			const enabledZones = zones.filter((zone) => zone.enabled).length
			const erroringZones = zones.filter((zone) => zone.enabled && zone.lastError != null).length
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
				stat: statParts.length > 0 ? statParts.join(" · ") : null,
				lastSyncLabel: syncedLabel(
					maxMs([...zones.map((zone) => zone.lastSyncedAt), status.workers?.lastSyncedAt]),
					nowMs,
				),
				issue,
			}
		},
		unavailableOverview,
	)

const scrapeOverview = (statuses: Statuses, nowMs: number, targetType: "prometheus" | "planetscale") =>
	fold(
		statuses.scrapeTargets,
		(data): IntegrationOverview => {
			const targets = data.filter((target) => target.target_type === targetType)
			if (targets.length === 0) return targetType === "prometheus" ? SET_UP : CONNECT
			const enabled = targets.filter((target) => target.enabled).length
			const failing = targets.filter(
				(target) => target.enabled && target.last_scrape_error !== null,
			).length
			const noun = targetType === "planetscale" ? "org" : "target"
			return {
				kind: "connected",
				health: failing > 0 ? "attention" : "healthy",
				stateLabel: failing > 0 ? "Needs attention" : "Healthy",
				context: countLabel(targets.length, `scrape ${noun}`),
				stat: `${enabled} of ${targets.length} enabled`,
				lastSyncLabel: syncedLabel(
					maxMs(targets.map((t) => isoMs(t.last_scrape_at))),
					nowMs,
					"scraped",
				),
				issue: failing > 0 ? `${countLabel(failing, noun)} failing` : null,
			}
		},
		unavailableOverview,
	)

const planetscaleOverview = (statuses: Statuses, nowMs: number) => {
	const dbCount = fold(
		statuses.planetscaleDatabases,
		(response): number | null => response.databases.length,
		() => null,
	)
	return fold(
		statuses.planetscale,
		(status): IntegrationOverview => {
			if (!status.connected) return scrapeOverview(statuses, nowMs, "planetscale")
			const issue = status.pending_org_selection
				? "Finish org selection"
				: status.metrics_auth === "missing"
					? "Metrics setup pending"
					: status.scrape_target?.last_scrape_error != null
						? "Scrape failing"
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
						: status.scrape_target?.enabled === true
							? "Metrics scraping on"
							: null,
				lastSyncLabel: syncedLabel(
					maxMs([status.scrape_target?.last_scrape_at, status.last_inventory_at].map(isoMs)),
					nowMs,
				),
				issue,
			}
		},
		unavailableOverview,
	)
}

const hazelOverview = (statuses: Statuses) =>
	fold(
		statuses.hazel,
		(status): IntegrationOverview =>
			status.connected
				? {
						kind: "connected",
						health: "healthy",
						stateLabel: "Healthy",
						context: status.externalUserEmail,
						stat: "Alert delivery ready",
						lastSyncLabel: null,
						issue: null,
					}
				: CONNECT,
		unavailableOverview,
	)

const githubOverview = (statuses: Statuses, nowMs: number) =>
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
				lastSyncLabel: null,
				issue,
			})
			if (status.state === "disconnected") return halted("Deactivated", "Reinstall the app")
			if (status.state === "suspended") return halted("Suspended", "Suspended on GitHub")
			if (!status.connected) return CONNECT
			const active = status.repositories.filter((repo) => repo.status === "active")
			const removed = status.repositories.length - active.length
			const failing = active.filter((repo) => repo.lastSyncError != null).length
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
				lastSyncLabel: syncedLabel(maxMs(active.map((repo) => repo.lastSyncedAt)), nowMs),
				issue,
			}
		},
		unavailableOverview,
	)

const chatOverview = (statuses: Statuses, id: IntegrationId) =>
	fold(
		statuses.chat,
		(response): IntegrationOverview => {
			const workspaces =
				response.data.find((entry) => chatIntegrationId(entry.id) === id)?.workspaces ?? []
			if (workspaces.length === 0) return CONNECT
			return {
				kind: "connected",
				health: "healthy",
				stateLabel: "Healthy",
				context:
					workspaces.length === 1
						? (workspaces[0]?.name ?? null)
						: countLabel(workspaces.length, "workspace"),
				stat: "Alerts & agent ready",
				lastSyncLabel: null,
				issue: null,
			}
		},
		unavailableOverview,
	)

/** One integration's overview (`useIntegrationOverviews()[id]`); `null` while its status loads. */
export const overviewOf = (statuses: Statuses, nowMs: number, id: IntegrationId): IntegrationOverview => {
	switch (id) {
		case "gcp":
			return gcpOverview(statuses, nowMs)
		case "aws":
			return awsOverview(statuses, nowMs)
		case "railway":
			return railwayOverview(statuses, nowMs)
		case "supabase":
			return supabaseOverview(statuses, nowMs)
		case "cloudflare":
			return cloudflareOverview(statuses, nowMs)
		case "prometheus":
			return scrapeOverview(statuses, nowMs, "prometheus")
		case "planetscale":
			return planetscaleOverview(statuses, nowMs)
		case "warpstream":
			return SET_UP
		case "hazel":
			return hazelOverview(statuses)
		case "github":
			return githubOverview(statuses, nowMs)
		default:
			return chatOverview(statuses, id)
	}
}

/** `IntegrationsSummary`: quiet until every overview resolved, and while nothing is connected. */
export const summaryOf = (
	statuses: Statuses,
	nowMs: number,
): { readonly connected: number; readonly attention: number } | null => {
	const values = HUB_CATALOG.map((entry) => overviewOf(statuses, nowMs, entry.id))
	if (values.some((value) => value === null)) return null
	const connected = Array.filter(values, (value): value is ConnectedOverview => value?.kind === "connected")
	if (connected.length === 0) return null
	return {
		connected: connected.length,
		attention: connected.filter((value) => value.health === "attention").length,
	}
}

/** `useVisibleSettingsSections()` on `/integrations`: the session's admin flag and the BYOC add-on. */
export const settingsNavVisibility = (
	model: Pick<Model, "isAdmin" | "customer">,
	isClerk: boolean,
): Visibility => {
	if (!isClerk) return { isClerk, isAdmin: true, canAccessDataPlatform: true }
	const hasByoc = AsyncData.getOrElse(
		AsyncData.map(model.customer.data, hasBringYourOwnCloudAddOn),
		() => false,
	)
	return { isClerk, isAdmin: model.isAdmin, canAccessDataPlatform: model.isAdmin && hasByoc }
}
