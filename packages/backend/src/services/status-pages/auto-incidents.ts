import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import {
	StatusPageComponents,
	StatusPageIncidentComponents,
	StatusPageIncidents,
	StatusPageIncidentUpdates,
	StatusPages,
	UptimeMonitors,
} from "@maple/db/tables"
import {
	type AlertIncidentId,
	type AlertRuleId,
	type OrgId,
	type StatusPageAutoIncidents,
	type StatusPageComponentId,
	type StatusPageId,
	StatusPageIncidentId,
	StatusPageIncidentUpdateId,
} from "@maple/domain/primitives"
import { Effect } from "effect"
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
		yield* Effect.forEach(
			resolved,
			(incident) =>
				db
					.run(
						PG.insertInto(StatusPageIncidentUpdates).values({
							id: StatusPageIncidentUpdateId.make(randomUUID()),
							orgId: input.orgId,
							incidentId: incident.id,
							status: "resolved",
							body: "Automated checks are passing again. This incident has been resolved.",
							source: "auto",
							createdBy: null,
							overlayEntryId: null,
							createdAt: input.at,
						}),
					)
					.pipe(Effect.andThen(bumpPage(db, input.orgId, incident.pageId))),
			{ discard: true },
		)
		return resolved.length
	})
