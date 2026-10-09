// Google Cloud connector rules shared by the card, the hub and the Infrastructure page: what
// each capability is doing, what a connection asks of its owner, the switch rules, and the add
// form's validation. Pure (no React, no atoms), like planetscale-setup-steps.ts.

import { Option, Schema } from "effect"
import { V2GcpCreateConnectorRequest, type V2GcpConnector } from "@maple/domain/http/v2"
import {
	GcpProjectId,
	GcpResourceNumber,
	type GcpLogFilter,
	type GcpScopeType,
} from "@maple/domain/primitives"
import type { Tone } from "@maple/ui/lib/tone"

const MINUTE_MS = 60_000
/** A log or read this recent proves the setup is in place, whatever the script reported. */
const FRESH_MS = 15 * MINUTE_MS
/** Past this without a log, the detail turns to "no logs in 24 hours". */
const IDLE_LOG_MS = 24 * 60 * MINUTE_MS
/** A confirmed sink that stays silent this long gets a test command. */
const OVERDUE_LOG_MS = 20 * MINUTE_MS
/** Confirmed access that stays unread this long stops promising the first read. */
const OVERDUE_READ_MS = 15 * MINUTE_MS
/** Two missed reads: an error with nothing read since means the reads fail. */
const FAILED_READ_MS = 10 * MINUTE_MS
/** Six missed reads: the numbers on screen are no longer current. */
const STALE_READ_MS = 30 * MINUTE_MS
/** A new grant needs up to two minutes to work and the first read follows about five minutes later. */
const GRANT_GRACE_MS = 10 * MINUTE_MS
/** A run's sections report seconds apart. A report this recent is a run that may still be going. */
const RUNNING_MS = 2 * MINUTE_MS
/** A script run takes about a minute. Past this the setup panel says what to check. */
const SCRIPT_OVERDUE_MS = 5 * MINUTE_MS

const ageMs = (iso: string | null, nowMs: number) =>
	iso === null ? Number.POSITIVE_INFINITY : nowMs - Date.parse(iso)

/**
 * Whether the script still has to set a switched-on capability up: a run reported it removed, or
 * no run reported and nothing recent arrived. Recent data stands in for a report that never
 * reached Maple, but not against one that did.
 */
const needsSetup = (applied: boolean | null, lastDataAgeMs: number) =>
	applied === false || (applied === null && lastDataAgeMs > FRESH_MS)

/**
 * What a capability that needs setup says. A run's sections report one after the other, so no
 * report on this one right after a report on the other means the script is still working.
 */
const setupKind = (
	applied: boolean | null,
	reportedAt: string | null,
	nowMs: number,
): "setup-pending" | "setup-running" =>
	applied === null && ageMs(reportedAt, nowMs) < RUNNING_MS ? "setup-running" : "setup-pending"

type GcpLogState =
	/** `stillSetUp`: the sink still forwards, because the script has not run since the switch. */
	| { readonly kind: "off"; readonly stillSetUp: boolean }
	/** Maple rejected the most recent push. Earlier pushes may have been accepted. */
	| { readonly kind: "failing"; readonly error: string; readonly lastLogReceivedAt: string | null }
	/** The setup script has not set log forwarding up, as far as Maple knows, or is doing so now. */
	| { readonly kind: "setup-pending" | "setup-running" }
	/** The script reported, and no entry has arrived yet. `overdue` after 20 minutes. */
	| { readonly kind: "waiting"; readonly reportedAt: string | null; readonly overdue: boolean }
	| { readonly kind: "idle"; readonly lastLogReceivedAt: string }
	| { readonly kind: "receiving"; readonly lastLogReceivedAt: string }

type LogFields = Pick<
	V2GcpConnector,
	"logs_enabled" | "last_log_received_at" | "last_log_error" | "applied_logs_enabled" | "setup_reported_at"
>

export function gcpLogState(connector: LogFields, nowMs: number): GcpLogState {
	const applied = connector.applied_logs_enabled === true
	if (!connector.logs_enabled) return { kind: "off", stillSetUp: applied }
	const lastLogReceivedAt = connector.last_log_received_at
	if (connector.last_log_error !== null) {
		return { kind: "failing", error: connector.last_log_error, lastLogReceivedAt }
	}
	const age = ageMs(lastLogReceivedAt, nowMs)
	if (needsSetup(connector.applied_logs_enabled, age)) {
		return { kind: setupKind(connector.applied_logs_enabled, connector.setup_reported_at, nowMs) }
	}
	if (lastLogReceivedAt === null) {
		const reportedAt = connector.setup_reported_at
		return { kind: "waiting", reportedAt, overdue: ageMs(reportedAt, nowMs) > OVERDUE_LOG_MS }
	}
	return { kind: age > IDLE_LOG_MS ? "idle" : "receiving", lastLogReceivedAt }
}

type GcpMetricsState =
	/** `stillSetUp`: the read-only service account still exists in Google Cloud. */
	| { readonly kind: "off"; readonly stillSetUp: boolean }
	| { readonly kind: "setup-pending" | "setup-running" }
	/** The script reported, and the first read after it has not landed. `overdue` after 15 minutes. */
	| { readonly kind: "waiting"; readonly reportedAt: string | null; readonly overdue: boolean }
	/** Reads fail: nothing was read in the last two polls. */
	| { readonly kind: "failing"; readonly error: string; readonly lastMetricsReceivedAt: string | null }
	/** A read arrived within the last two polls, but part of the metrics is missing. */
	| { readonly kind: "incomplete"; readonly error: string; readonly lastMetricsReceivedAt: string }
	/** No error, and no read for half an hour. */
	| { readonly kind: "stalled"; readonly lastMetricsReceivedAt: string }
	| {
			readonly kind: "receiving"
			readonly lastMetricsReceivedAt: string
			/** Projects found under a folder or organization; null for a project or before the first sync. */
			readonly projectCount: number | null
			/** Why the resource list is incomplete. Metrics are unaffected, so this is not a failure. */
			readonly resourcesError: string | null
	  }

type MetricsFields = Pick<
	V2GcpConnector,
	| "scope_type"
	| "metrics_enabled"
	| "last_metrics_received_at"
	| "last_metrics_error"
	| "discovered_project_count"
	| "last_resources_error"
	| "applied_metrics_enabled"
	| "setup_reported_at"
>

export function gcpMetricsState(connector: MetricsFields, nowMs: number): GcpMetricsState {
	const applied = connector.applied_metrics_enabled === true
	if (!connector.metrics_enabled) return { kind: "off", stillSetUp: applied }
	const lastMetricsReceivedAt = connector.last_metrics_received_at
	const error = connector.last_metrics_error
	const age = ageMs(lastMetricsReceivedAt, nowMs)
	// Before the script has run the poller says it can't sign in. That is the expected start.
	const reportedAt = connector.setup_reported_at
	if (needsSetup(connector.applied_metrics_enabled, age)) {
		return { kind: setupKind(connector.applied_metrics_enabled, reportedAt, nowMs) }
	}
	const reportedAge = ageMs(reportedAt, nowMs)
	const waiting = { kind: "waiting", reportedAt, overdue: reportedAge > OVERDUE_READ_MS } as const
	// A run just reported: what the poller said before its grant works counts for nothing yet.
	if (age > FAILED_READ_MS && reportedAge < GRANT_GRACE_MS) return waiting
	if (lastMetricsReceivedAt === null) {
		return error === null ? waiting : { kind: "failing", error, lastMetricsReceivedAt }
	}
	if (error !== null) {
		return { kind: age > FAILED_READ_MS ? "failing" : "incomplete", error, lastMetricsReceivedAt }
	}
	if (age > STALE_READ_MS) return { kind: "stalled", lastMetricsReceivedAt }
	return {
		kind: "receiving",
		lastMetricsReceivedAt,
		projectCount:
			connector.scope_type !== "project" && connector.discovered_project_count > 0
				? connector.discovered_project_count
				: null,
		resourcesError: connector.last_resources_error,
	}
}

/** The card's dot and label for each state a switched-on capability can be in. */
export const GCP_LOG_STATUS = {
	failing: { tone: "crit", label: "Rejecting logs" },
	"setup-pending": { tone: "neutral", label: "Setup pending" },
	"setup-running": { tone: "neutral", label: "Setup running" },
	waiting: { tone: "neutral", label: "Waiting for first logs" },
	idle: { tone: "neutral", label: "No logs in 24 hours" },
	receiving: { tone: "ok", label: "Receiving logs" },
} as const satisfies Record<Exclude<GcpLogState["kind"], "off">, { tone: Tone; label: string }>

export const GCP_METRICS_STATUS = {
	"setup-pending": { tone: "neutral", label: "Setup pending" },
	"setup-running": { tone: "neutral", label: "Setup running" },
	waiting: { tone: "neutral", label: "Waiting for first metrics" },
	failing: { tone: "crit", label: "Can't read metrics" },
	incomplete: { tone: "warn", label: "Receiving metrics, incomplete" },
	stalled: { tone: "warn", label: "Metrics stalled" },
	receiving: { tone: "ok", label: "Receiving metrics" },
} as const satisfies Record<Exclude<GcpMetricsState["kind"], "off">, { tone: Tone; label: string }>

type ConnectorFields = LogFields & MetricsFields

/**
 * What a re-run of the setup script would change, for a connection whose switches disagree with
 * what a run reported. A capability no run has reported on is not in the list: that is setup,
 * and while a first run is under way its sections report one after the other.
 */
export const gcpPendingChanges = (connector: ConnectorFields, nowMs: number): ReadonlyArray<string> => {
	const log = gcpLogState(connector, nowMs)
	const metrics = gcpMetricsState(connector, nowMs)
	return [
		log.kind === "setup-pending" && connector.applied_logs_enabled === false
			? "create the log sink, topic and subscription"
			: null,
		log.kind === "off" && log.stillSetUp ? "remove the log sink, topic and subscription" : null,
		metrics.kind === "setup-pending" && connector.applied_metrics_enabled === false
			? "create the read-only service account and grant its roles"
			: null,
		metrics.kind === "off" && metrics.stillSetUp
			? "remove the read-only service account and its roles"
			: null,
	].filter((line) => line !== null)
}

/** A connection's worst capability, worst first. */
type GcpConnectionState = "attention" | "changes-pending" | "setup-pending" | "waiting" | "healthy"

/**
 * Whether Google Cloud waits on the setup script, and for what: a change to what a run set up, or
 * the setup itself. Null when the switches match what the runs reported.
 */
export function gcpScriptNeeded(
	connector: ConnectorFields,
	nowMs: number,
): "changes-pending" | "setup-pending" | null {
	if (gcpPendingChanges(connector, nowMs).length > 0) return "changes-pending"
	const pending =
		gcpLogState(connector, nowMs).kind === "setup-pending" ||
		gcpMetricsState(connector, nowMs).kind === "setup-pending"
	return pending ? "setup-pending" : null
}

/** A run reported on one capability and not yet on the other: the script is still working. */
export const gcpSetupRunning = (connector: ConnectorFields, nowMs: number): boolean =>
	gcpLogState(connector, nowMs).kind === "setup-running" ||
	gcpMetricsState(connector, nowMs).kind === "setup-running"

export function gcpConnectionState(connector: ConnectorFields, nowMs: number): GcpConnectionState {
	const log = gcpLogState(connector, nowMs).kind
	const metrics = gcpMetricsState(connector, nowMs).kind
	if (log === "failing" || metrics === "failing" || metrics === "incomplete" || metrics === "stalled") {
		return "attention"
	}
	return (
		gcpScriptNeeded(connector, nowMs) ??
		(log === "waiting" || metrics === "waiting" || gcpSetupRunning(connector, nowMs)
			? "waiting"
			: "healthy")
	)
}

/**
 * Whether the setup panel's confirm step has waited long enough to say what to check. A connection
 * no run has reported on counts from its creation, so a reload does not start the wait over. After
 * a report the API has no time for the switch change, and the panel's opening stands in.
 */
export const gcpScriptOverdue = (
	connector: Pick<V2GcpConnector, "created_at" | "setup_reported_at">,
	openedAtMs: number,
	nowMs: number,
): boolean =>
	nowMs - (connector.setup_reported_at === null ? Date.parse(connector.created_at) : openedAtMs) >
	SCRIPT_OVERDUE_MS

/** The page header, the hub row and the row badge name a connection's state in these words. */
export const GCP_CONNECTION_LABEL = {
	attention: "Needs attention",
	"changes-pending": "Changes pending",
	"setup-pending": "Setup pending",
	waiting: "Waiting for data",
	healthy: "Healthy",
} as const satisfies Record<GcpConnectionState, string>

/** The worst state among several connections; healthy when there are none. */
export const gcpWorstState = (states: ReadonlyArray<GcpConnectionState>): GcpConnectionState =>
	(["attention", "setup-pending", "changes-pending", "waiting"] as const).find((state) =>
		states.includes(state),
	) ?? "healthy"

export type GcpFlags = Pick<V2GcpConnector, "logs_enabled" | "metrics_enabled">

/** Why a switch cannot be flipped: it is the last one on, or the deployment cannot read metrics. */
export type GcpSwitchLock = "last-on" | "metrics-unavailable"

/** The API refuses both of these, so the card disables the switch and says why. */
export function gcpSwitchLock(
	flags: GcpFlags,
	capability: "logs" | "metrics",
	metricsAvailable: boolean,
): GcpSwitchLock | null {
	const on = capability === "logs" ? flags.logs_enabled : flags.metrics_enabled
	const otherOn = capability === "logs" ? flags.metrics_enabled : flags.logs_enabled
	if (on) return otherOn ? null : "last-on"
	return capability === "metrics" && !metricsAvailable ? "metrics-unavailable" : null
}

export const GCP_SCOPE_NAMES = {
	project: "Project",
	folder: "Folder",
	organization: "Organization",
} as const

/** "Organization 123456789012", "Project acme-prod". */
export const gcpScopeLabel = (connector: Pick<V2GcpConnector, "scope_type" | "scope_id">): string =>
	`${GCP_SCOPE_NAMES[connector.scope_type]} ${connector.scope_id}`

/**
 * The roles the person running the script needs on a folder or organization, next to Owner on
 * the host project. A project needs Owner alone. Mirrors the script's own permission check.
 */
export const gcpScopeRoles = (scopeType: GcpScopeType, flags: GcpFlags): ReadonlyArray<string> =>
	scopeType === "project"
		? []
		: [
				flags.logs_enabled ? "Logs Configuration Writer" : null,
				flags.metrics_enabled
					? scopeType === "folder"
						? "Folder IAM Admin"
						: "Organization Administrator"
					: null,
			].filter((role) => role !== null)

/** Why adding this scope next to the existing connections may collect a project twice, or null. */
export function gcpOverlapNote(
	scopeType: GcpScopeType,
	existing: ReadonlyArray<Pick<V2GcpConnector, "scope_type" | "scope_id">>,
): string | null {
	if (scopeType === "project") {
		return existing.some((connector) => connector.scope_type !== "project")
			? "If this project sits inside an organization or folder you already connected, it is collected twice."
			: null
	}
	const projects = existing.filter((connector) => connector.scope_type === "project")
	return projects.length === 0
		? null
		: `Projects you already connected (${projects.map((project) => project.scope_id).join(", ")}) are collected twice if they sit inside this ${scopeType}. Disconnect them once this connection receives data.`
}

/** What the add form holds. */
export interface GcpConnectorDraft {
	readonly scopeType: GcpScopeType
	/** A project ID, or the numeric ID of a folder or organization. */
	readonly scopeId: string
	/** Read only for a folder or organization; a project is its own host project. */
	readonly hostProjectId: string
	readonly logsEnabled: boolean
	readonly metricsEnabled: boolean
}

const decodeCreateRequest = Schema.decodeUnknownOption(V2GcpCreateConnectorRequest)

/**
 * The create request for a draft, decoded with the API's own schema; none while a field is wrong.
 * The schema allows both opt-ins off and the API then refuses, so that case is none here too.
 */
export const gcpCreateRequest = (draft: GcpConnectorDraft): Option.Option<V2GcpCreateConnectorRequest> => {
	if (!draft.logsEnabled && !draft.metricsEnabled) return Option.none()
	const optIns = { logs_enabled: draft.logsEnabled, metrics_enabled: draft.metricsEnabled }
	return decodeCreateRequest(
		draft.scopeType === "project"
			? { scope_type: "project", scope_id: draft.scopeId.trim(), ...optIns }
			: {
					scope_type: draft.scopeType,
					scope_id: draft.scopeId.trim(),
					project_id: draft.hostProjectId.trim(),
					...optIns,
				},
	)
}

export const isGcpProjectId = Schema.is(GcpProjectId)
export const isGcpResourceNumber = Schema.is(GcpResourceNumber)

const LOG_FILTERS = [
	{ value: "default", label: "Recommended: no GKE container logs" },
	{ value: "include_gke_container_logs", label: "Include GKE container logs" },
	{ value: "keep", label: "Keep the sink's current filter" },
] as const satisfies ReadonlyArray<{ value: GcpLogFilter; label: string }>

/** The setup panel's log filters in display order. Keeping a filter needs a sink that has one. */
export const gcpLogFilters = (sinkExists: boolean) =>
	LOG_FILTERS.filter((filter) => filter.value !== "keep" || sinkExists)

/**
 * What the setup panel's log filter stands on. Nothing chosen: an existing sink keeps its filter,
 * so copying the script again for a switch change never resets it, and a new sink gets the
 * recommended one. Including GKE container logs counts once it is acknowledged: until then the
 * script stays on the filter the panel started with, which is also where backing out returns to.
 */
export const gcpLogFilterChoice = (
	chosen: GcpLogFilter | null,
	acknowledged: boolean,
	sinkExists: boolean,
) => {
	const initial: GcpLogFilter = sinkExists ? "keep" : "default"
	const selected = chosen ?? initial
	const unacknowledged = selected === "include_gke_container_logs" && !acknowledged
	return { selected, unacknowledged, scriptFilter: unacknowledged ? initial : selected }
}

const LOG_ROUTER_SCOPE = { project: "project", folder: "folder", organization: "organizationId" } as const

/** The console's Log Router for the scope that holds the connection's sink. */
export const logRouterUrl = (connector: Pick<V2GcpConnector, "scope_type" | "scope_id">): string =>
	`https://console.cloud.google.com/logs/router?${LOG_ROUTER_SCOPE[connector.scope_type]}=${encodeURIComponent(connector.scope_id)}`

/**
 * Opens the Google Cloud console on the host project with a Cloud Shell terminal attached. Cloud
 * Shell starts with the console's active project, and the scripts name the project on every
 * command, so a console that ignores the hint still runs them against the right one.
 */
export const cloudShellUrl = (projectId: string): string =>
	`https://console.cloud.google.com/?cloudshell=true&project=${encodeURIComponent(projectId)}`
