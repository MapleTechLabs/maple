import * as PG from "@maple-dev/effect-orm/postgres"
import {
	StatusPageComponents,
	StatusPageIncidentComponents,
	StatusPageIncidents,
	StatusPageIncidentUpdates,
	StatusPages,
	UptimeMonitorDaily,
	UptimeMonitors,
	UptimeMonitorStates,
} from "@maple/db/tables"
import type {
	OrgId,
	StatusPageComponentId,
	StatusPageComponentStatus,
	StatusPageId,
	StatusPageIncidentId,
	StatusPageIncidentImpact,
	StatusPageIncidentKind,
	StatusPageIncidentStatus,
	StatusPageUpdateSource,
	UptimeMonitorId,
	UptimeMonitorStatus,
} from "@maple/domain/primitives"
import {
	deriveComponentStatus,
	fillDays,
	incidentComponentStatus,
	isActiveIncident,
	lastDays,
	STATUS_PAGE_HISTORY_DAYS,
	STATUS_PAGE_INCIDENT_HISTORY_DAYS,
	STATUS_PAGE_SNAPSHOT_VERSION,
	type StatusPageSnapshot,
	type StatusPageIncidentHistoryEntry,
	type StatusPageSnapshotIncident,
	type StatusPageTheme,
	utcDay,
} from "@maple/domain/status-page"
import { Context, Effect, Layer } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { StatusPageGoneError, StatusPagePublishDbError } from "./publish-errors"

/** Most resolved incidents one snapshot indexes for the calendar: about one a day for a year. */
const STATUS_PAGE_INCIDENT_INDEX_LIMIT = 500

const DAY_MS = 86_400_000

export interface SnapshotPageInput {
	readonly id: StatusPageId
	readonly name: string
	readonly slug: string
	readonly description: string | null
	readonly websiteUrl: string | null
	readonly logoUrl: string | null
	readonly privacyUrl: string | null
	readonly termsUrl: string | null
	readonly theme: StatusPageTheme
	readonly showPoweredBy: boolean
	readonly breakGlassTokenSha256: string | null
	readonly revision: number
}

export interface SnapshotComponentInput {
	readonly id: StatusPageComponentId
	readonly name: string
	readonly description: string | null
	readonly groupName: string | null
	readonly monitorId: UptimeMonitorId | null
	readonly manualStatus: StatusPageComponentStatus | null
	readonly showUptime: boolean
	/** Null when there is no monitor or it has no state row yet. */
	readonly monitorStatus: UptimeMonitorStatus | null
}

export interface SnapshotDailyInput {
	readonly monitorId: UptimeMonitorId
	readonly day: string
	readonly checks: number
	readonly failures: number
	readonly downChecks: number
}

export interface SnapshotIncidentInput {
	readonly id: StatusPageIncidentId
	readonly kind: StatusPageIncidentKind
	readonly title: string
	readonly impact: StatusPageIncidentImpact
	readonly status: StatusPageIncidentStatus
	readonly published: boolean
	readonly startedAt: number
	readonly resolvedAt: number | null
	readonly scheduledStart: number | null
	readonly scheduledEnd: number | null
}

export interface SnapshotUpdateInput {
	readonly id: string
	readonly incidentId: StatusPageIncidentId
	readonly status: StatusPageIncidentStatus
	readonly body: string
	readonly source: StatusPageUpdateSource
	/** The break-glass entry it was imported from, if any. */
	readonly overlayEntryId: string | null
	readonly createdAt: number
}

export interface SnapshotInput {
	readonly page: SnapshotPageInput
	readonly components: ReadonlyArray<SnapshotComponentInput>
	readonly daily: ReadonlyArray<SnapshotDailyInput>
	readonly incidents: ReadonlyArray<SnapshotIncidentInput>
	readonly updates: ReadonlyArray<SnapshotUpdateInput>
	readonly incidentComponents: ReadonlyArray<{
		readonly incidentId: StatusPageIncidentId
		readonly componentId: StatusPageComponentId
	}>
	readonly nowMs: number
}

/** Whether a visitor should see the incident at `nowMs`: active, upcoming maintenance, or recently resolved. */
export const isListedIncident = (incident: SnapshotIncidentInput, nowMs: number): boolean => {
	if (!incident.published) return false
	if (isActiveIncident(incident)) return true
	if (incident.kind === "maintenance" && incident.status === "scheduled") {
		return incident.scheduledEnd !== null && incident.scheduledEnd > nowMs
	}
	return (
		incident.resolvedAt !== null &&
		incident.resolvedAt >= nowMs - STATUS_PAGE_INCIDENT_HISTORY_DAYS * DAY_MS
	)
}

/**
 * Whether the incident belongs in the calendar index: it started, or was still open, within the
 * last `STATUS_PAGE_HISTORY_DAYS`. Maintenance that has not started yet has no days to mark.
 */
export const isIndexedIncident = (incident: SnapshotIncidentInput, nowMs: number): boolean =>
	incident.published &&
	!(incident.kind === "maintenance" && incident.status === "scheduled") &&
	(incident.resolvedAt ?? nowMs) >= nowMs - STATUS_PAGE_HISTORY_DAYS * DAY_MS

/** The snapshot for already-read rows; no I/O, so the rules are testable without a database. */
export const toSnapshot = (input: SnapshotInput): StatusPageSnapshot => {
	const days = lastDays(input.nowMs, STATUS_PAGE_HISTORY_DAYS)
	const firstDay = days[0] ?? ""
	const daily = input.daily.filter((row) => row.day >= firstDay)

	const incidents: ReadonlyArray<StatusPageSnapshotIncident> = input.incidents
		.filter((incident) => isListedIncident(incident, input.nowMs))
		.toSorted((a, b) => b.startedAt - a.startedAt)
		.map((incident) => {
			const updates = input.updates
				.filter((update) => update.incidentId === incident.id)
				.toSorted((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
			const first = updates.at(-1)
			return {
				id: incident.id,
				kind: incident.kind,
				title: incident.title,
				impact: incident.impact,
				status: incident.status,
				startedAt: incident.startedAt,
				resolvedAt: incident.resolvedAt,
				scheduledStart: incident.scheduledStart,
				scheduledEnd: incident.scheduledEnd,
				componentIds: input.incidentComponents
					.filter((link) => link.incidentId === incident.id)
					.map((link) => link.componentId),
				// The first update came from break-glass: `bg-<entry>` follow-ups still target it.
				openedByOverlayEntryId: first?.source === "break_glass" ? first.overlayEntryId : null,
				updates: updates.map((update) => ({
					// An imported break-glass update keeps the id visitors and feed readers already saw.
					id: update.overlayEntryId ?? update.id,
					status: update.status,
					body: update.body,
					at: update.createdAt,
					source: update.source,
					overlayEntryId: update.overlayEntryId,
				})),
			}
		})
	const active = incidents.filter(isActiveIncident)
	const incidentHistory: ReadonlyArray<StatusPageIncidentHistoryEntry> = input.incidents
		.filter((incident) => isIndexedIncident(incident, input.nowMs))
		.toSorted((a, b) => b.startedAt - a.startedAt)
		.map((incident) => ({
			id: incident.id,
			title: incident.title,
			kind: incident.kind,
			impact: incident.impact,
			startedAt: incident.startedAt,
			resolvedAt: incident.resolvedAt,
		}))

	const components = input.components.map((component) => ({
		id: component.id,
		name: component.name,
		description: component.description,
		group: component.groupName,
		status: deriveComponentStatus({
			monitorStatus: component.monitorStatus,
			manualStatus: component.manualStatus,
			incidentStatuses: active
				.filter((incident) => incident.componentIds.includes(component.id))
				.map(incidentComponentStatus),
		}),
		baseStatus: deriveComponentStatus({
			monitorStatus: component.monitorStatus,
			manualStatus: component.manualStatus,
			incidentStatuses: [],
		}),
		showUptime: component.showUptime,
		monitored: component.monitorId !== null,
		days:
			component.monitorId === null || !component.showUptime
				? []
				: fillDays(
						days,
						daily
							.filter((row) => row.monitorId === component.monitorId)
							.map((row) => ({
								day: row.day,
								checks: row.checks,
								failures: row.failures,
								downChecks: row.downChecks,
							})),
					),
	}))

	return {
		schemaVersion: STATUS_PAGE_SNAPSHOT_VERSION,
		pageId: input.page.id,
		revision: input.page.revision,
		generatedAt: input.nowMs,
		page: {
			name: input.page.name,
			slug: input.page.slug,
			description: input.page.description,
			websiteUrl: input.page.websiteUrl,
			logoUrl: input.page.logoUrl,
			theme: input.page.theme,
			showPoweredBy: input.page.showPoweredBy,
			privacyUrl: input.page.privacyUrl,
			termsUrl: input.page.termsUrl,
		},
		breakGlassTokenSha256: input.page.breakGlassTokenSha256,
		components,
		incidents,
		incidentHistory,
	}
}

export interface StatusPageSnapshotBuilderApi {
	/** Reads the page by id (a system path: every later query is scoped to its org). */
	readonly build: (
		pageId: StatusPageId,
		nowMs: number,
	) => Effect.Effect<StatusPageSnapshot, StatusPageGoneError | StatusPagePublishDbError>
	/**
	 * Newest scheduled check (the prober's pulse); null when none ran lately. Across all orgs for the
	 * edge heartbeat (a system read), or one org's monitors when `orgId` is given.
	 */
	readonly probesSeenAt: (
		nowMs: number,
		orgId?: OrgId,
	) => Effect.Effect<number | null, StatusPagePublishDbError>
}

const toDbError = makePersistenceErrorMapper(StatusPagePublishDbError, "Status page snapshot read failed")

export class StatusPageSnapshotBuilder extends Context.Service<
	StatusPageSnapshotBuilder,
	StatusPageSnapshotBuilderApi
>()("@maple/backend/services/status-pages/StatusPageSnapshotBuilder", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const dbExecute = makeDbExecute(database, "StatusPageSnapshotBuilder", toDbError)

		const build = Effect.fn("StatusPageSnapshotBuilder.build")(function* (
			pageId: StatusPageId,
			nowMs: number,
		) {
			yield* Effect.annotateCurrentSpan({ "maple.status_page.id": pageId })
			const firstDay = lastDays(nowMs, STATUS_PAGE_HISTORY_DAYS)[0] ?? ""
			// The calendar index reaches back a year; updates are read only for the listed incidents.
			const indexCutoff = nowMs - STATUS_PAGE_HISTORY_DAYS * DAY_MS
			const input = yield* dbExecute((db) =>
				Effect.gen(function* () {
					const [page] = yield* db.run(
						PG.from(StatusPages)
							.select(($) => ({
								id: $.id,
								orgId: $.orgId,
								name: $.name,
								slug: $.slug,
								description: $.description,
								websiteUrl: $.websiteUrl,
								logoUrl: $.logoUrl,
								privacyUrl: $.privacyUrl,
								termsUrl: $.termsUrl,
								theme: $.theme,
								showPoweredBy: $.showPoweredBy,
								breakGlassTokenSha256: $.breakGlassTokenSha256,
								revision: $.revision,
							}))
							.where(($) => [$.id.eq(pageId)])
							.limit(1),
					)
					if (page === undefined) return null
					const orgId = page.orgId
					const components = yield* db.run(
						PG.from(StatusPageComponents, "c")
							.leftJoin(UptimeMonitorStates, "s", (c, s) =>
								c.monitorId.eq(s.monitorId).and(c.orgId.eq(s.orgId)),
							)
							.select(($) => ({
								id: $.id,
								name: $.name,
								description: $.description,
								groupName: $.groupName,
								monitorId: $.monitorId,
								manualStatus: $.manualStatus,
								showUptime: $.showUptime,
								monitorStatus: $.s.status,
								position: $.position,
							}))
							.where(($) => [$.orgId.eq(orgId), $.pageId.eq(pageId)])
							.orderBy(["position", "asc"], ["id", "asc"]),
					)
					const monitorIds = components.flatMap((c) => (c.monitorId === null ? [] : [c.monitorId]))
					const daily =
						monitorIds.length === 0
							? []
							: yield* db.run(
									PG.from(UptimeMonitorDaily)
										.select(($) => ({
											monitorId: $.monitorId,
											day: $.day,
											checks: $.checks,
											failures: $.failures,
											downChecks: $.downChecks,
										}))
										.where(($) => [
											$.orgId.eq(orgId),
											PG.inList($.monitorId, monitorIds),
											$.day.gte(firstDay),
										]),
								)
					const incidentFields = PG.from(StatusPageIncidents).select(($) => ({
						id: $.id,
						kind: $.kind,
						title: $.title,
						impact: $.impact,
						status: $.status,
						published: $.published,
						startedAt: $.startedAt,
						resolvedAt: $.resolvedAt,
						scheduledStart: $.scheduledStart,
						scheduledEnd: $.scheduledEnd,
					}))
					// Open incidents always, however old; only the resolved ones that fill the calendar are capped.
					const open = yield* db.run(
						incidentFields.where(($) => [
							$.orgId.eq(orgId),
							$.pageId.eq(pageId),
							$.published.eq(true),
							$.resolvedAt.isNull(),
						]),
					)
					const resolved = yield* db.run(
						incidentFields
							.where(($) => [
								$.orgId.eq(orgId),
								$.pageId.eq(pageId),
								$.published.eq(true),
								$.resolvedAt.gte(indexCutoff),
							])
							.orderBy(["startedAt", "desc"], ["id", "desc"])
							.limit(STATUS_PAGE_INCIDENT_INDEX_LIMIT),
					)
					const incidents = [...open, ...resolved]
					const incidentIds = incidents
						.filter((incident) => isListedIncident(incident, nowMs))
						.map((incident) => incident.id)
					const updates =
						incidentIds.length === 0
							? []
							: yield* db.run(
									PG.from(StatusPageIncidentUpdates)
										.select(($) => ({
											id: $.id,
											incidentId: $.incidentId,
											status: $.status,
											body: $.body,
											source: $.source,
											overlayEntryId: $.overlayEntryId,
											createdAt: $.createdAt,
										}))
										.where(($) => [
											$.orgId.eq(orgId),
											PG.inList($.incidentId, incidentIds),
										]),
								)
					const incidentComponents =
						incidentIds.length === 0
							? []
							: yield* db.run(
									PG.from(StatusPageIncidentComponents)
										.select(($) => ({
											incidentId: $.incidentId,
											componentId: $.componentId,
										}))
										.where(($) => [
											$.orgId.eq(orgId),
											PG.inList($.incidentId, incidentIds),
										]),
								)
					return { page, components, daily, incidents, updates, incidentComponents }
				}),
			)
			if (input === null) {
				return yield* new StatusPageGoneError({ message: `Status page ${pageId} not found`, pageId })
			}
			yield* Effect.annotateCurrentSpan({
				"maple.status_page.components": input.components.length,
				"maple.status_page.incidents": input.incidents.length,
			})
			return toSnapshot({ ...input, nowMs })
		})

		const probesSeenAt = Effect.fn("StatusPageSnapshotBuilder.probesSeenAt")(function* (
			nowMs: number,
			orgId?: OrgId,
		) {
			// The daily counters fold in every scheduled check; their PK (monitor, day) serves this
			// per enabled monitor. Heartbeat monitors are excluded: their misses are not probes.
			const [seen] = yield* dbExecute((db) =>
				db.run(
					PG.from(UptimeMonitorDaily, "d")
						.innerJoin(UptimeMonitors, "m", (d, m) =>
							d.monitorId.eq(m.id).and(d.orgId.eq(m.orgId)),
						)
						.select(($) => ({ at: PG.max($.lastCheckAt) }))
						.where(($) => [
							$.m.enabled.eq(true),
							$.m.kind.neq("heartbeat"),
							orgId === undefined ? undefined : $.m.orgId.eq(orgId),
							PG.inList($.day, [utcDay(nowMs), utcDay(nowMs - DAY_MS)]),
						]),
				),
			)
			return seen?.at ?? null
		})

		return { build, probesSeenAt }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
