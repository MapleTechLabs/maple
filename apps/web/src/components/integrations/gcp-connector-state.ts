// Google Cloud connector rules shared by the card, the hub and the Infrastructure page: what
// each capability is doing, what a connection asks of its owner, the switch rules, and the add
// form's validation. Pure (no React, no atoms), like planetscale-setup-steps.ts.

import { Option, Schema } from "effect"
import { V2GcpCreateConnectorRequest, type V2GcpConnector } from "@maple/domain/http/v2"
import { GcpProjectId, GcpResourceNumber, type GcpScopeType } from "@maple/domain/primitives"

const MINUTE_MS = 60_000
/** A log or read this recent proves the setup is in place, whatever the script reported. */
const FRESH_MS = 15 * MINUTE_MS
/** Past this without a log, the detail turns to "no logs in 24 hours". */
const IDLE_LOG_MS = 24 * 60 * MINUTE_MS
/** A confirmed sink that stays silent this long gets a test command. */
const OVERDUE_LOG_MS = 20 * MINUTE_MS
/** Six missed reads: the numbers on screen are no longer current. */
const STALE_READ_MS = 30 * MINUTE_MS
/** A new grant needs up to two minutes to work and the first read follows about five minutes later. */
const GRANT_GRACE_MS = 10 * MINUTE_MS

const ageMs = (iso: string | null, nowMs: number) =>
	iso === null ? Number.POSITIVE_INFINITY : nowMs - Date.parse(iso)

export type GcpLogState =
	/** `stillSetUp`: the sink still forwards, because the script has not run since the switch. */
	| { readonly kind: "off"; readonly stillSetUp: boolean }
	/** Maple rejected the most recent push. Earlier pushes may have been accepted. */
	| { readonly kind: "failing"; readonly error: string; readonly lastLogReceivedAt: string | null }
	/** The setup script has not set log forwarding up, as far as Maple knows. */
	| { readonly kind: "setup-pending" }
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
	if (!applied && age > FRESH_MS) return { kind: "setup-pending" }
	if (lastLogReceivedAt === null) {
		const reportedAt = connector.setup_reported_at
		return { kind: "waiting", reportedAt, overdue: ageMs(reportedAt, nowMs) > OVERDUE_LOG_MS }
	}
	return { kind: age > IDLE_LOG_MS ? "idle" : "receiving", lastLogReceivedAt }
}

export type GcpMetricsState =
	/** `stillSetUp`: the read-only service account still exists in Google Cloud. */
	| { readonly kind: "off"; readonly stillSetUp: boolean }
	| { readonly kind: "setup-pending" }
	/** The script reported, and the first read after it has not landed. */
	| { readonly kind: "waiting"; readonly reportedAt: string | null }
	/** Reads fail, and nothing recent is on screen. */
	| { readonly kind: "failing"; readonly error: string; readonly lastMetricsReceivedAt: string | null }
	/** Recent reads arrive, but part of the metrics or the resource list is missing. */
	| { readonly kind: "incomplete"; readonly error: string; readonly lastMetricsReceivedAt: string }
	/** No error, and no read for half an hour. */
	| { readonly kind: "stalled"; readonly lastMetricsReceivedAt: string }
	| {
			readonly kind: "receiving"
			readonly lastMetricsReceivedAt: string
			/** Projects found under a folder or organization; null for a project or before the first sync. */
			readonly projectCount: number | null
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
	if (!applied && age > FRESH_MS) return { kind: "setup-pending" }
	const waiting = { kind: "waiting", reportedAt: connector.setup_reported_at } as const
	// A run just reported: what the poller said before its grant works counts for nothing yet.
	if (age > STALE_READ_MS && ageMs(connector.setup_reported_at, nowMs) < GRANT_GRACE_MS) return waiting
	if (lastMetricsReceivedAt === null) {
		return error === null ? waiting : { kind: "failing", error, lastMetricsReceivedAt }
	}
	if (error !== null) {
		return { kind: age > STALE_READ_MS ? "failing" : "incomplete", error, lastMetricsReceivedAt }
	}
	if (age > STALE_READ_MS) return { kind: "stalled", lastMetricsReceivedAt }
	if (connector.last_resources_error !== null) {
		return { kind: "incomplete", error: connector.last_resources_error, lastMetricsReceivedAt }
	}
	return {
		kind: "receiving",
		lastMetricsReceivedAt,
		projectCount:
			connector.scope_type !== "project" && connector.discovered_project_count > 0
				? connector.discovered_project_count
				: null,
	}
}

type Tone = "ok" | "warn" | "crit" | "neutral"

/** Each state's dot and label, the same on the card, the hub and the Infrastructure page. */
export const GCP_LOG_STATUS = {
	off: { tone: null, label: "Off" },
	failing: { tone: "crit", label: "Rejecting logs" },
	"setup-pending": { tone: "neutral", label: "Setup pending" },
	waiting: { tone: "neutral", label: "Waiting for first logs" },
	idle: { tone: "neutral", label: "No logs in 24 hours" },
	receiving: { tone: "ok", label: "Receiving logs" },
} as const satisfies Record<GcpLogState["kind"], { tone: Tone | null; label: string }>

export const GCP_METRICS_STATUS = {
	off: { tone: null, label: "Off" },
	"setup-pending": { tone: "neutral", label: "Setup pending" },
	waiting: { tone: "neutral", label: "Waiting for first metrics" },
	failing: { tone: "crit", label: "Can't read metrics" },
	incomplete: { tone: "warn", label: "Receiving metrics, incomplete" },
	stalled: { tone: "warn", label: "Metrics stalled" },
	receiving: { tone: "ok", label: "Receiving metrics" },
} as const satisfies Record<GcpMetricsState["kind"], { tone: Tone | null; label: string }>

type ConnectorFields = LogFields & MetricsFields

/** What the setup script would change in Google Cloud if it ran now, as the notice lists it. */
const unappliedChanges = (connector: ConnectorFields, nowMs: number): ReadonlyArray<string> => {
	const log = gcpLogState(connector, nowMs)
	const metrics = gcpMetricsState(connector, nowMs)
	return [
		log.kind === "setup-pending" ? "create the log sink, topic and subscription" : null,
		log.kind === "off" && log.stillSetUp ? "remove the log sink, topic and subscription" : null,
		metrics.kind === "setup-pending" ? "create the read-only service account and grant its roles" : null,
		metrics.kind === "off" && metrics.stillSetUp
			? "remove the read-only service account and its roles"
			: null,
	].filter((line) => line !== null)
}

const neverReported = (connector: ConnectorFields) =>
	connector.applied_logs_enabled === null && connector.applied_metrics_enabled === null

/**
 * What a re-run of the setup script would do, for a connection whose switches no longer match
 * what a run reported. Empty when they match, and before the first run: that is setup, not a change.
 */
export const gcpPendingChanges = (connector: ConnectorFields, nowMs: number): ReadonlyArray<string> =>
	neverReported(connector) ? [] : unappliedChanges(connector, nowMs)

/** A connection's worst capability, worst first. */
export type GcpConnectionState = "attention" | "setup-pending" | "changes-pending" | "waiting" | "healthy"

export function gcpConnectionState(connector: ConnectorFields, nowMs: number): GcpConnectionState {
	const log = gcpLogState(connector, nowMs).kind
	const metrics = gcpMetricsState(connector, nowMs).kind
	if (log === "failing" || metrics === "failing" || metrics === "incomplete" || metrics === "stalled") {
		return "attention"
	}
	if (unappliedChanges(connector, nowMs).length > 0) {
		return neverReported(connector) ? "setup-pending" : "changes-pending"
	}
	return log === "waiting" || metrics === "waiting" ? "waiting" : "healthy"
}

/** The page header and the hub row read a connection, or the worst of several, in these words. */
export const GCP_CONNECTION_STATUS = {
	attention: { tone: "warn", label: "Needs attention" },
	"setup-pending": { tone: "neutral", label: "Setup pending" },
	"changes-pending": { tone: "neutral", label: "Changes pending" },
	waiting: { tone: "neutral", label: "Waiting for data" },
	healthy: { tone: "ok", label: "Healthy" },
} as const satisfies Record<GcpConnectionState, { tone: Tone; label: string }>

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

/**
 * Opens the Google Cloud console on the host project with a Cloud Shell terminal attached. Cloud
 * Shell starts with the console's active project, and the scripts name the project on every
 * command, so a console that ignores the hint still runs them against the right one.
 */
export const cloudShellUrl = (projectId: string): string =>
	`https://console.cloud.google.com/?cloudshell=true&project=${encodeURIComponent(projectId)}`
