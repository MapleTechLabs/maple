import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import {
	AlertIncidents,
	StatusPageComponents,
	StatusPageIncidentComponents,
	StatusPageIncidents,
	StatusPageIncidentUpdates,
	StatusPages,
	UptimeMonitors,
} from "@maple/db/tables"
import {
	AlertIncidentId,
	AlertRuleId,
	OrgId,
	type StatusPageAutoIncidents,
	type StatusPageComponentId,
	type StatusPageId,
	StatusPageIncidentId,
	StatusPageIncidentUpdateId,
} from "@maple/domain/primitives"
import * as Orm from "@maple-dev/effect-orm/database"
import { msToSqlTimestamp } from "@maple/backend/platform/time"
import { Effect, Schema } from "effect"
import { bumpPage } from "./outbox"

// Status page incidents opened and resolved by an uptime monitor's alert incident, on every
// page that opted in (`auto_incidents`) and shows a component on that monitor.

export interface OpenForAlertIncidentInput {
	readonly orgId: OrgId
	readonly ruleId: AlertRuleId
	readonly alertIncidentId: AlertIncidentId
	readonly at: number
}

export interface ResolveForAlertIncidentInput {
	readonly orgId: OrgId
	readonly alertIncidentId: AlertIncidentId
	readonly at: number
}

interface PageComponents {
	readonly pageId: StatusPageId
	readonly publish: boolean
	readonly components: ReadonlyArray<{ readonly id: StatusPageComponentId; readonly name: string }>
}

const groupByPage = (
	rows: ReadonlyArray<{
		readonly pageId: StatusPageId
		readonly autoIncidents: StatusPageAutoIncidents
		readonly componentId: StatusPageComponentId
		readonly componentName: string
	}>,
): ReadonlyArray<PageComponents> =>
	[...new Set(rows.map((row) => row.pageId))].map((pageId) => {
		const forPage = rows.filter((row) => row.pageId === pageId)
		return {
			pageId,
			publish: forPage[0]?.autoIncidents === "publish",
			components: forPage.map((row) => ({ id: row.componentId, name: row.componentName })),
		}
	})

/** Opens a status page incident per opted-in page showing the rule's monitor; run inside a transaction. */
export const openForAlertIncident = (db: MapleDb, input: OpenForAlertIncidentInput) =>
	Effect.gen(function* () {
		const rows = yield* db.run(
			PG.from(StatusPageComponents, "c")
				.innerJoin(UptimeMonitors, "m", (c, m) => c.monitorId.eq(m.id).and(c.orgId.eq(m.orgId)))
				.innerJoin(StatusPages, "p", (c, p) => c.pageId.eq(p.id).and(c.orgId.eq(p.orgId)))
				.select(($) => ({
					pageId: $.pageId,
					autoIncidents: $.p.autoIncidents,
					componentId: $.id,
					componentName: $.name,
					position: $.position,
				}))
				.where(($) => [
					$.orgId.eq(input.orgId),
					$.m.alertRuleId.eq(input.ruleId),
					$.p.autoIncidents.neq("off"),
				])
				.orderBy(["position", "asc"], ["componentId", "asc"]),
		)
		if (rows.length === 0) return 0
		const pages = groupByPage(rows)
		const existing = yield* db.run(
			PG.from(StatusPageIncidents)
				.select(($) => ({ pageId: $.pageId }))
				.where(($) => [$.orgId.eq(input.orgId), $.alertIncidentId.eq(input.alertIncidentId)]),
		)
		const toOpen = pages.filter((page) => !existing.some((row) => row.pageId === page.pageId))
		yield* Effect.forEach(
			toOpen,
			(page) =>
				Effect.gen(function* () {
					const id = StatusPageIncidentId.make(randomUUID())
					const name = page.components[0]?.name ?? "A service"
					yield* db.run(
						PG.insertInto(StatusPageIncidents).values({
							id,
							orgId: input.orgId,
							pageId: page.pageId,
							kind: "incident",
							title: `${name} is down`,
							impact: "major",
							status: "investigating",
							published: page.publish,
							alertIncidentId: input.alertIncidentId,
							scheduledStart: null,
							scheduledEnd: null,
							startedAt: input.at,
							resolvedAt: null,
							createdBy: null,
							createdAt: input.at,
							updatedAt: input.at,
						}),
					)
					yield* db.run(
						PG.insertInto(StatusPageIncidentComponents)
							.values(
								page.components.map((component) => ({
									incidentId: id,
									componentId: component.id,
									orgId: input.orgId,
								})),
							)
							.onConflictDoNothing(),
					)
					yield* db.run(
						PG.insertInto(StatusPageIncidentUpdates).values({
							id: StatusPageIncidentUpdateId.make(randomUUID()),
							orgId: input.orgId,
							incidentId: id,
							status: "investigating",
							body: `Automated checks for ${name} are failing. We are investigating.`,
							source: "auto",
							createdBy: null,
							overlayEntryId: null,
							createdAt: input.at,
						}),
					)
					yield* bumpPage(db, input.orgId, page.pageId)
				}),
			{ discard: true },
		)
		return toOpen.length
	})

/** Posts the auto resolve update on each just-resolved incident and republishes its page. */
const announceResolved = (
	db: MapleDb,
	orgId: OrgId,
	resolved: ReadonlyArray<{ readonly id: StatusPageIncidentId; readonly pageId: StatusPageId }>,
	at: number,
) =>
	Effect.forEach(
		resolved,
		(incident) =>
			db
				.run(
					PG.insertInto(StatusPageIncidentUpdates).values({
						id: StatusPageIncidentUpdateId.make(randomUUID()),
						orgId,
						incidentId: incident.id,
						status: "resolved",
						body: "Automated checks are passing again. This incident has been resolved.",
						source: "auto",
						createdBy: null,
						overlayEntryId: null,
						createdAt: at,
					}),
				)
				.pipe(Effect.andThen(bumpPage(db, orgId, incident.pageId))),
		{ discard: true },
	)

/** Resolves the open status page incidents this alert incident opened; run inside a transaction. */
export const resolveForAlertIncident = (db: MapleDb, input: ResolveForAlertIncidentInput) =>
	Effect.gen(function* () {
		const resolved = yield* db.run(
			PG.update(StatusPageIncidents)
				.set({ status: "resolved", resolvedAt: input.at, updatedAt: input.at })
				.where(($) => [
					$.orgId.eq(input.orgId),
					$.alertIncidentId.eq(input.alertIncidentId),
					$.status.neq("resolved"),
				])
				.returning(($) => ({ id: $.id, pageId: $.pageId })),
		)
		yield* announceResolved(db, input.orgId, resolved, input.at)
		return resolved.length
	})

const MissingAutoIncidentRow = Schema.Struct({
	id: AlertIncidentId,
	org_id: OrgId,
	rule_id: AlertRuleId,
	first_triggered_ms: Schema.Number,
})

/** How long after an alert opens the repair still opens its missing page incidents. */
export const AUTO_INCIDENT_OPEN_RETRY_MS = 15 * 60_000

/**
 * Opens page incidents the open hook missed (it runs after the alert commit, bounded, and may
 * fail). Only for alerts opened in the last 15 minutes, so a page incident someone deleted while
 * its alert stays open is not brought back. Each alert in its own transaction; returns how many.
 */
export const repairMissingAutoIncidents = (db: MapleDb, at: number) =>
	Effect.gen(function* () {
		// Four tables across two join keys (rule, then monitor): a typed query, not the builder.
		const rows = yield* db.query(
			Orm.sql`
				SELECT DISTINCT a.id, a.org_id, a.rule_id,
					(extract(epoch from a.first_triggered_at) * 1000)::float8 AS first_triggered_ms
				FROM alert_incidents a
				JOIN uptime_monitors m ON m.alert_rule_id = a.rule_id AND m.org_id = a.org_id
				JOIN status_page_components c ON c.monitor_id = m.id AND c.org_id = a.org_id
				JOIN status_pages p ON p.id = c.page_id AND p.org_id = a.org_id
				LEFT JOIN status_page_incidents i ON i.alert_incident_id = a.id AND i.page_id = p.id
				WHERE a.status <> 'resolved'
					AND a.first_triggered_at >= ${msToSqlTimestamp(at - AUTO_INCIDENT_OPEN_RETRY_MS)}::timestamptz
					AND p.auto_incidents <> 'off'
					AND i.id IS NULL
				ORDER BY first_triggered_ms
				LIMIT ${AUTO_INCIDENT_REPAIR_BATCH}`,
			MissingAutoIncidentRow,
		)
		const counts = yield* Effect.forEach(rows, (row) =>
			db.transaction(
				openForAlertIncident(db, {
					orgId: row.org_id,
					ruleId: row.rule_id,
					alertIncidentId: row.id,
					at: row.first_triggered_ms,
				}),
			),
		)
		return counts.reduce((sum, n) => sum + n, 0)
	})

/** Auto incidents one repair pass resolves at most. */
export const AUTO_INCIDENT_REPAIR_BATCH = 50

/**
 * Open auto incidents whose alert incident is resolved or gone: the resolve hook runs after
 * the alert commit and may have failed. Resolves each in its own transaction; returns how many.
 */
export const repairOrphanedAutoIncidents = (db: MapleDb, at: number) =>
	Effect.gen(function* () {
		const orphans = yield* db.run(
			PG.from(StatusPageIncidents, "i")
				.leftJoin(AlertIncidents, "a", (i, a) => i.alertIncidentId.eq(a.id).and(i.orgId.eq(a.orgId)))
				.select(($) => ({ id: $.id, orgId: $.orgId }))
				.where(($) => [
					$.alertIncidentId.isNotNull(),
					$.status.neq("resolved"),
					PG.or($.a.id.isNull(), $.a.status.eq("resolved")),
				])
				.orderBy(["id", "asc"])
				.limit(AUTO_INCIDENT_REPAIR_BATCH),
		)
		const counts = yield* Effect.forEach(orphans, (orphan) =>
			db.transaction(
				Effect.gen(function* () {
					// Guarded on status: a resolve landing meanwhile wins and posts its own update.
					const resolved = yield* db.run(
						PG.update(StatusPageIncidents)
							.set({ status: "resolved", resolvedAt: at, updatedAt: at })
							.where(($) => [
								$.orgId.eq(orphan.orgId),
								$.id.eq(orphan.id),
								$.status.neq("resolved"),
							])
							.returning(($) => ({ id: $.id, pageId: $.pageId })),
					)
					yield* announceResolved(db, orphan.orgId, resolved, at)
					return resolved.length
				}),
			),
		)
		return counts.reduce((sum, n) => sum + n, 0)
	})
