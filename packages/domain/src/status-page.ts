import { Schema } from "effect"
import {
	StatusPageComponentId,
	StatusPageComponentStatus,
	StatusPageId,
	StatusPageIncidentImpact,
	StatusPageIncidentKind,
	StatusPageIncidentStatus,
	StatusPageUpdateSource,
	type UptimeMonitorStatus,
} from "./primitives"

// Status pages: the snapshot the publisher writes to edge storage and `apps/status` serves
// without touching Maple, plus the pure rules both sides share (component status, bars,
// freshness, the break-glass overlay).

export const STATUS_PAGE_SNAPSHOT_VERSION = 1
/** Days of uptime bars on a page. */
export const STATUS_PAGE_HISTORY_DAYS = 90
/** Resolved incidents stay listed this long. */
export const STATUS_PAGE_INCIDENT_HISTORY_DAYS = 14
/** Past this, the page says live checks are delayed instead of implying all is well. */
export const STATUS_PAGE_STALE_AFTER_MS = 5 * 60_000

/** Lowercase letters, digits and inner hyphens: the `<slug>` in `<slug>.<status domain>`. */
export const StatusPageSlug = Schema.String.check(
	Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/u),
).annotate({ identifier: "@maple/StatusPageSlug", title: "Status Page Slug" })
export type StatusPageSlug = Schema.Schema.Type<typeof StatusPageSlug>

/** `YYYY-MM-DD`, UTC. */
export const StatusPageDay = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u))

export const StatusPageDayState = Schema.Literals(["none", "ok", "degraded", "down"])
export type StatusPageDayState = Schema.Schema.Type<typeof StatusPageDayState>

export const StatusPageDayBar = Schema.Struct({
	day: StatusPageDay,
	checks: Schema.Number,
	failures: Schema.Number,
	/** Checks taken while the monitor was down: the downtime share of the day. */
	downChecks: Schema.Number,
})
export type StatusPageDayBar = Schema.Schema.Type<typeof StatusPageDayBar>

export const StatusPageSnapshotComponent = Schema.Struct({
	id: StatusPageComponentId,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	group: Schema.NullOr(Schema.String),
	status: StatusPageComponentStatus,
	showUptime: Schema.Boolean,
	/** Backed by an uptime monitor, so its status goes stale when the probes stop. */
	monitored: Schema.Boolean,
	/** Oldest first; empty when the component has no monitor or hides uptime. */
	days: Schema.Array(StatusPageDayBar),
})
export type StatusPageSnapshotComponent = Schema.Schema.Type<typeof StatusPageSnapshotComponent>

export const StatusPageSnapshotUpdate = Schema.Struct({
	id: Schema.String,
	status: StatusPageIncidentStatus,
	body: Schema.String,
	at: Schema.Number,
	source: StatusPageUpdateSource,
	/** The break-glass entry this update was imported from, so the edge stops overlaying it. */
	overlayEntryId: Schema.NullOr(Schema.String),
})
export type StatusPageSnapshotUpdate = Schema.Schema.Type<typeof StatusPageSnapshotUpdate>

export const StatusPageSnapshotIncident = Schema.Struct({
	id: Schema.String,
	kind: StatusPageIncidentKind,
	title: Schema.String,
	impact: StatusPageIncidentImpact,
	status: StatusPageIncidentStatus,
	startedAt: Schema.Number,
	resolvedAt: Schema.NullOr(Schema.Number),
	scheduledStart: Schema.NullOr(Schema.Number),
	scheduledEnd: Schema.NullOr(Schema.Number),
	componentIds: Schema.Array(Schema.String),
	/** The break-glass entry that opened it, so follow-ups posted against `bg-<entry>` still land. */
	openedByOverlayEntryId: Schema.NullOr(Schema.String),
	/** Newest first. */
	updates: Schema.Array(StatusPageSnapshotUpdate),
})
export type StatusPageSnapshotIncident = Schema.Schema.Type<typeof StatusPageSnapshotIncident>

export const StatusPageSnapshotPage = Schema.Struct({
	name: Schema.String,
	slug: StatusPageSlug,
	description: Schema.NullOr(Schema.String),
	websiteUrl: Schema.NullOr(Schema.String),
	logoUrl: Schema.NullOr(Schema.String),
	brandColor: Schema.NullOr(Schema.String),
	showPoweredBy: Schema.Boolean,
})
export type StatusPageSnapshotPage = Schema.Schema.Type<typeof StatusPageSnapshotPage>

/** Everything a status page shows, self-contained: serving it needs no other read. */
export const StatusPageSnapshot = Schema.Struct({
	schemaVersion: Schema.Literal(STATUS_PAGE_SNAPSHOT_VERSION),
	pageId: StatusPageId,
	revision: Schema.Number,
	generatedAt: Schema.Number,
	page: StatusPageSnapshotPage,
	/** SHA-256 (base64url) of the break-glass token; null when none is issued. */
	breakGlassTokenSha256: Schema.NullOr(Schema.String),
	components: Schema.Array(StatusPageSnapshotComponent),
	/** Open incidents, upcoming and active maintenance, and recently resolved ones; newest first. */
	incidents: Schema.Array(StatusPageSnapshotIncident),
})
export type StatusPageSnapshot = Schema.Schema.Type<typeof StatusPageSnapshot>

/**
 * Written after each successful publish sweep. `probesSeenAt` is the newest scheduled check result
 * across all monitors: when the prober stops, every monitored page goes delayed together.
 */
export const StatusPagePublisherHeartbeat = Schema.Struct({
	at: Schema.Number,
	probesSeenAt: Schema.NullOr(Schema.Number),
})
export type StatusPagePublisherHeartbeat = Schema.Schema.Type<typeof StatusPagePublisherHeartbeat>

// --- Break-glass overlay ---

/** An update posted straight to the status Worker while Maple is down; imported into Postgres later. */
export const StatusPageOverlayEntry = Schema.Struct({
	/** Random UUID; the import is idempotent on it. */
	id: Schema.String,
	at: Schema.Number,
	/** The incident to update; null opens a new one titled `title`. */
	incidentId: Schema.NullOr(Schema.String),
	title: Schema.NullOr(Schema.String),
	/** Null keeps the incident's current status (a new incident starts `investigating`). */
	status: Schema.NullOr(StatusPageIncidentStatus),
	/** Null keeps the incident's current impact (a new incident starts `major`). */
	impact: Schema.NullOr(StatusPageIncidentImpact),
	body: Schema.String,
	componentIds: Schema.Array(Schema.String),
})
export type StatusPageOverlayEntry = Schema.Schema.Type<typeof StatusPageOverlayEntry>

export const StatusPageOverlay = Schema.Struct({ entries: Schema.Array(StatusPageOverlayEntry) })
export type StatusPageOverlay = Schema.Schema.Type<typeof StatusPageOverlay>

const INCIDENT_STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const
const MAINTENANCE_STATUSES = ["scheduled", "in_progress", "completed"] as const

/** Whether a status belongs to the kind: incidents and maintenance have separate lifecycles. */
export const statusFitsKind = (kind: StatusPageIncidentKind, status: StatusPageIncidentStatus): boolean =>
	kind === "incident"
		? INCIDENT_STATUSES.some((allowed) => allowed === status)
		: MAINTENANCE_STATUSES.some((allowed) => allowed === status)

export const STATUS_PAGE_OVERLAY_MAX_ENTRIES = 50

/** The incident an overlay entry opens: keyed by the entry id so a later entry can update it. */
export const overlayIncidentId = (entryId: string): string => `bg-${entryId}`

const isResolvedStatus = (status: StatusPageIncidentStatus): boolean =>
	status === "resolved" || status === "completed"

/** Break-glass entries already imported into the snapshot; the edge skips them. */
const importedEntryIds = (snapshot: StatusPageSnapshot): ReadonlySet<string> =>
	new Set(
		snapshot.incidents.flatMap((incident) =>
			incident.updates.flatMap((update) =>
				update.overlayEntryId === null ? [] : [update.overlayEntryId],
			),
		),
	)

/** Which incident an entry targets: `bg-<entry>` also matches the imported incident it opened. */
const matchesTarget = (incident: StatusPageSnapshotIncident, targetId: string): boolean =>
	incident.id === targetId ||
	(incident.openedByOverlayEntryId !== null &&
		overlayIncidentId(incident.openedByOverlayEntryId) === targetId)

/** The snapshot as visitors should see it, with break-glass updates not yet imported applied in order. */
export const applyOverlay = (
	snapshot: StatusPageSnapshot,
	overlay: StatusPageOverlay,
): StatusPageSnapshot => {
	const imported = importedEntryIds(snapshot)
	const entries = overlay.entries.filter((entry) => !imported.has(entry.id)).sort((a, b) => a.at - b.at)
	if (entries.length === 0) return snapshot
	const incidents = entries.reduce<ReadonlyArray<StatusPageSnapshotIncident>>((list, entry) => {
		const targetId = entry.incidentId ?? overlayIncidentId(entry.id)
		const existing = list.find((incident) => matchesTarget(incident, targetId))
		if (existing === undefined) {
			const status =
				entry.status !== null && statusFitsKind("incident", entry.status)
					? entry.status
					: "investigating"
			const opened: StatusPageSnapshotIncident = {
				id: targetId,
				kind: "incident",
				title: entry.title ?? "Service disruption",
				impact: entry.impact ?? "major",
				status,
				startedAt: entry.at,
				resolvedAt: isResolvedStatus(status) ? entry.at : null,
				scheduledStart: null,
				scheduledEnd: null,
				componentIds: entry.componentIds,
				openedByOverlayEntryId: entry.id,
				updates: [
					{
						id: entry.id,
						status,
						body: entry.body,
						at: entry.at,
						source: "break_glass",
						overlayEntryId: entry.id,
					},
				],
			}
			return [opened, ...list]
		}
		// A status from the other lifecycle (an incident status on maintenance) is ignored, not applied.
		const status =
			entry.status !== null && statusFitsKind(existing.kind, entry.status)
				? entry.status
				: existing.status
		const update: StatusPageSnapshotUpdate = {
			id: entry.id,
			status,
			body: entry.body,
			at: entry.at,
			source: "break_glass",
			overlayEntryId: entry.id,
		}
		return list.map((incident) =>
			incident === existing
				? {
						...incident,
						title: entry.title ?? incident.title,
						impact: entry.impact ?? incident.impact,
						status,
						resolvedAt: isResolvedStatus(status) ? (incident.resolvedAt ?? entry.at) : null,
						componentIds:
							entry.componentIds.length > 0 ? entry.componentIds : incident.componentIds,
						updates: [update, ...incident.updates],
					}
				: incident,
		)
	}, snapshot.incidents)
	return { ...snapshot, incidents, components: withIncidentImpact(snapshot.components, incidents) }
}

// --- Component status ---

const STATUS_RANK = {
	operational: 0,
	maintenance: 1,
	degraded: 2,
	partial_outage: 3,
	major_outage: 4,
} as const satisfies Record<StatusPageComponentStatus, number>

export const worstStatus = (statuses: ReadonlyArray<StatusPageComponentStatus>): StatusPageComponentStatus =>
	statuses.reduce<StatusPageComponentStatus>(
		(worst, status) => (STATUS_RANK[status] > STATUS_RANK[worst] ? status : worst),
		"operational",
	)

const IMPACT_STATUS = {
	none: "operational",
	minor: "degraded",
	major: "partial_outage",
	critical: "major_outage",
} as const satisfies Record<StatusPageIncidentImpact, StatusPageComponentStatus>

export const isActiveIncident = (incident: {
	readonly kind: StatusPageIncidentKind
	readonly status: StatusPageIncidentStatus
}): boolean =>
	incident.kind === "incident" ? incident.status !== "resolved" : incident.status === "in_progress"

/** What an active incident or maintenance does to the components it names. */
export const incidentComponentStatus = (incident: {
	readonly kind: StatusPageIncidentKind
	readonly impact: StatusPageIncidentImpact
}): StatusPageComponentStatus =>
	incident.kind === "maintenance" ? "maintenance" : IMPACT_STATUS[incident.impact]

/**
 * A component's status: the worst of its monitor (down is a major outage), a manual
 * override, and the active incidents or maintenance naming it.
 */
export const deriveComponentStatus = (input: {
	readonly monitorStatus: UptimeMonitorStatus | null
	readonly manualStatus: StatusPageComponentStatus | null
	readonly incidentStatuses: ReadonlyArray<StatusPageComponentStatus>
}): StatusPageComponentStatus =>
	worstStatus([
		input.monitorStatus === "down" ? "major_outage" : "operational",
		input.manualStatus ?? "operational",
		...input.incidentStatuses,
	])

const withIncidentImpact = (
	components: ReadonlyArray<StatusPageSnapshotComponent>,
	incidents: ReadonlyArray<StatusPageSnapshotIncident>,
): ReadonlyArray<StatusPageSnapshotComponent> => {
	const active = incidents.filter(isActiveIncident)
	return components.map((component) => ({
		...component,
		status: worstStatus([
			component.status,
			...active
				.filter((incident) => incident.componentIds.includes(component.id))
				.map(incidentComponentStatus),
		]),
	}))
}

/** The banner status: the worst component, or `operational` for an empty page. */
export const overallStatus = (snapshot: StatusPageSnapshot): StatusPageComponentStatus =>
	worstStatus(snapshot.components.map((component) => component.status))

// --- Bars ---

export const dayState = (bar: StatusPageDayBar): StatusPageDayState =>
	bar.checks === 0 ? "none" : bar.downChecks > 0 ? "down" : bar.failures > 0 ? "degraded" : "ok"

/** Share of checks not taken while down, as a percentage; null when nothing was checked. */
export const uptimePercent = (days: ReadonlyArray<StatusPageDayBar>): number | null => {
	const checks = days.reduce((sum, day) => sum + day.checks, 0)
	if (checks === 0) return null
	const down = days.reduce((sum, day) => sum + day.downChecks, 0)
	return ((checks - down) / checks) * 100
}

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** The last `count` UTC days ending today, oldest first. */
export const lastDays = (nowMs: number, count: number): ReadonlyArray<string> =>
	Array.from({ length: count }, (_, index) => utcDay(nowMs - (count - 1 - index) * 86_400_000))

/** One bar per day of the window, empty where no row exists. */
export const fillDays = (
	days: ReadonlyArray<string>,
	rows: ReadonlyArray<StatusPageDayBar>,
): ReadonlyArray<StatusPageDayBar> => {
	const byDay = new Map(rows.map((row) => [row.day, row]))
	return days.map((day) => byDay.get(day) ?? { day, checks: 0, failures: 0, downChecks: 0 })
}

// --- Freshness ---

export type StatusPageFreshness =
	| { readonly _tag: "live"; readonly updatedAt: number }
	| { readonly _tag: "delayed"; readonly updatedAt: number }

/**
 * Whether the page reflects live checks. `updatedAt` is when its state was last confirmed:
 * the publisher's last good sweep, and for a page with monitors also the newest probe result.
 * Either going quiet (Maple down, or the probes stopped) makes the page say so rather than look green.
 */
export const pageFreshness = (input: {
	readonly snapshot: StatusPageSnapshot
	readonly heartbeat: StatusPagePublisherHeartbeat | null
	readonly nowMs: number
}): StatusPageFreshness => {
	const publisherAt = Math.max(input.snapshot.generatedAt, input.heartbeat?.at ?? 0)
	const monitored = input.snapshot.components.some((component) => component.monitored)
	const updatedAt = monitored
		? Math.min(publisherAt, input.heartbeat?.probesSeenAt ?? publisherAt)
		: publisherAt
	return input.nowMs - updatedAt > STATUS_PAGE_STALE_AFTER_MS
		? { _tag: "delayed", updatedAt }
		: { _tag: "live", updatedAt }
}

// --- Break-glass token ---

export const STATUS_PAGE_BREAK_GLASS_PREFIX = "mstat_"

/** SHA-256 of the token, base64url: the token carries 256 random bits, so no key is needed. */
export const sha256Base64Url = async (value: string): Promise<string> => {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "")
}

/** Edge storage keys, shared by the publisher and the status Worker. */
export const StatusPageKeys = {
	host: (hostname: string) => `host:${hostname.toLowerCase()}`,
	/** Path addressing (`/s/<slug>`), for hosts without a page of their own such as workers.dev. */
	slug: (slug: string) => `slug:${slug}`,
	snapshot: (pageId: string) => `page:${pageId}:snapshot`,
	/**
	 * One key per break-glass entry, written once by the status Worker and deleted by the
	 * reconciler once a published snapshot carries it: nothing rewrites a shared value.
	 */
	overlayEntry: (pageId: string, entryId: string) => `overlay:${pageId}:${entryId}`,
	overlayPage: (pageId: string) => `overlay:${pageId}:`,
	overlayAll: "overlay:",
	heartbeat: "meta:heartbeat",
	/** R2 copy of the snapshot, read when KV fails. */
	snapshotObject: (pageId: string) => `pages/${pageId}/snapshot.json`,
	hostObject: (hostname: string) => `hosts/${hostname.toLowerCase()}`,
	slugObject: (slug: string) => `slugs/${slug}`,
} as const

export const decodeStatusPageSnapshotJson = Schema.decodeUnknownOption(
	Schema.fromJsonString(StatusPageSnapshot),
)
export const decodeStatusPageOverlayEntryJson = Schema.decodeUnknownOption(
	Schema.fromJsonString(StatusPageOverlayEntry),
)
export const decodeStatusPageHeartbeatJson = Schema.decodeUnknownOption(
	Schema.fromJsonString(StatusPagePublisherHeartbeat),
)
