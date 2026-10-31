// One managed scrape target per Supabase project, on the Management API metrics endpoint and
// authenticated with the org's OAuth grant (`supabase_oauth`) when the scraper lists targets.
import { randomUUID } from "node:crypto"
import type { MapleDb } from "@maple/db/client"
import {
	ScrapeTargets,
	SupabaseConnections,
	SupabaseProjects,
	type ScrapeTargetRow,
	type SupabaseConnectionRow,
	type SupabaseProjectRow,
} from "@maple/db/tables"
import { ScrapeTargetId, type SupabaseConnectionId } from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Effect, Schema } from "effect"

/** Supabase allows 10 metrics requests a minute per project; one a minute leaves headroom. */
export const SUPABASE_SCRAPE_INTERVAL_SECONDS = 60

/** One `service.name` for every project; projects differ by their `supabase.project.*` labels. */
export const SUPABASE_SERVICE_NAME = "supabase"

/** Not-running statuses. Transient ones (COMING_UP, RESTARTING, ...) keep scraping; they last minutes. */
const NOT_RUNNING_STATUSES: ReadonlySet<string> = new Set([
	"INACTIVE",
	"PAUSING",
	"GOING_DOWN",
	"REMOVED",
	"INIT_FAILED",
	"RESTORE_FAILED",
])

const decodeTargetId = Schema.decodeUnknownSync(ScrapeTargetId)

export const managedBySupabase = (connectionId: SupabaseConnectionId) => `supabase:${connectionId}`

export const supabaseMetricsUrl = (apiBaseUrl: string, projectRef: string) =>
	`${apiBaseUrl}/v1/projects/${projectRef}/analytics/endpoints/metrics`

/** Whether a project's metrics should be scraped right now. */
export const shouldScrape = (project: Pick<SupabaseProjectRow, "metricsEnabled" | "status" | "removedAt">) =>
	project.removedAt === null && project.metricsEnabled && !NOT_RUNNING_STATUSES.has(project.status)

/** The managed fields a project's target converges on. */
const desiredTarget = (
	connection: SupabaseConnectionRow,
	project: SupabaseProjectRow,
	apiBaseUrl: string,
) => ({
	sourceId: connection.sourceId,
	name: `Supabase ${project.name}`,
	serviceName: SUPABASE_SERVICE_NAME,
	url: supabaseMetricsUrl(apiBaseUrl, project.projectRef),
	targetType: "supabase",
	authType: "supabase_oauth",
	scrapeIntervalSeconds: SUPABASE_SCRAPE_INTERVAL_SECONDS,
	labelsJson: {
		"supabase.project.ref": project.projectRef,
		"supabase.project.name": project.name,
		"supabase.project.region": project.region,
		"supabase.organization.slug": connection.supabaseOrganizationSlug,
	},
	enabled: shouldScrape(project),
})

type DesiredTarget = ReturnType<typeof desiredTarget>

const sameLabels = (stored: ScrapeTargetRow["labelsJson"], desired: DesiredTarget["labelsJson"]) =>
	stored !== null &&
	Object.keys(stored).length === Object.keys(desired).length &&
	Object.entries(desired).every(([key, value]) => stored[key] === value)

/** Whether a stored target already matches what its project wants. */
const isCurrent = (target: ScrapeTargetRow, desired: DesiredTarget) =>
	target.sourceId === desired.sourceId &&
	target.name === desired.name &&
	target.serviceName === desired.serviceName &&
	target.url === desired.url &&
	target.targetType === desired.targetType &&
	target.authType === desired.authType &&
	target.scrapeIntervalSeconds === desired.scrapeIntervalSeconds &&
	target.enabled === desired.enabled &&
	sameLabels(target.labelsJson, desired.labelsJson)

export interface ScrapeTargetReconcileSummary {
	readonly created: number
	readonly updated: number
	readonly deleted: number
}

type Change = "created" | "updated" | "deleted" | null

/**
 * Converge the connection's managed targets on its projects: create, update drift, delete removed
 * and orphaned. Idempotent; run it in a transaction, which holds the connection row lock.
 */
export const reconcileSupabaseScrapeTargets = Effect.fnUntraced(function* (
	db: MapleDb,
	current: SupabaseConnectionRow,
	apiBaseUrl: string,
	now: number,
) {
	// Serialize reconciles per connection: one that read the projects before a toggle committed
	// must not write its stale `enabled` after the toggle's own reconcile, nor double-insert.
	const [connection] = yield* db.run(
		PG.from(SupabaseConnections)
			.select()
			.where(($) => [$.id.eq(current.id)])
			.forUpdate(),
	)
	if (connection === undefined) {
		return { created: 0, updated: 0, deleted: 0 } satisfies ScrapeTargetReconcileSummary
	}
	const managedBy = managedBySupabase(connection.id)
	const projects = yield* db.run(
		PG.from(SupabaseProjects)
			.select()
			.where(($) => [$.connectionId.eq(connection.id)]),
	)
	const targets = yield* db.run(
		PG.from(ScrapeTargets)
			.select()
			.where(($) => [$.orgId.eq(connection.orgId), $.managedBy.eq(managedBy)]),
	)
	const targetsById = new Map(targets.map((target) => [target.id, target]))

	const setProjectTarget = (project: SupabaseProjectRow, scrapeTargetId: ScrapeTargetId | null) =>
		db.run(
			PG.update(SupabaseProjects)
				.set({ scrapeTargetId, updatedAt: now })
				.where(($) => [$.id.eq(project.id)]),
		)

	const deleteTarget = (targetId: ScrapeTargetId) =>
		db.run(
			PG.deleteFrom(ScrapeTargets).where(($) => [
				$.orgId.eq(connection.orgId),
				$.id.eq(targetId),
				$.managedBy.eq(managedBy),
			]),
		)

	const reconcileProject = (
		project: SupabaseProjectRow,
	): Effect.Effect<Change, Effect.Error<ReturnType<MapleDb["run"]>>> =>
		Effect.gen(function* () {
			const target =
				project.scrapeTargetId === null ? undefined : targetsById.get(project.scrapeTargetId)
			if (project.removedAt !== null) {
				if (project.scrapeTargetId === null) return null
				if (target !== undefined) yield* deleteTarget(target.id)
				yield* setProjectTarget(project, null)
				return target === undefined ? null : "deleted"
			}
			const desired = desiredTarget(connection, project, apiBaseUrl)
			if (target === undefined) {
				// A project that should not scrape gets no row until it should; a dangling id is cleared.
				if (!desired.enabled) {
					if (project.scrapeTargetId !== null) yield* setProjectTarget(project, null)
					return null
				}
				const id = decodeTargetId(randomUUID())
				yield* db.run(
					PG.insertInto(ScrapeTargets).values({
						id,
						orgId: connection.orgId,
						managedBy,
						...desired,
						createdAt: now,
						updatedAt: now,
					}),
				)
				yield* setProjectTarget(project, id)
				return "created"
			}
			if (isCurrent(target, desired)) return null
			yield* db.run(
				PG.update(ScrapeTargets)
					.set({ ...desired, updatedAt: now })
					.where(($) => [$.id.eq(target.id), $.managedBy.eq(managedBy)]),
			)
			return "updated"
		})

	const changes = yield* Effect.forEach(projects, reconcileProject)
	const referenced = new Set(
		projects.flatMap((project) => (project.scrapeTargetId === null ? [] : [project.scrapeTargetId])),
	)
	const orphans = targets.filter((target) => !referenced.has(target.id))
	yield* Effect.forEach(orphans, (target) => deleteTarget(target.id), { discard: true })

	return {
		created: changes.filter((change) => change === "created").length,
		updated: changes.filter((change) => change === "updated").length,
		deleted: changes.filter((change) => change === "deleted").length + orphans.length,
	} satisfies ScrapeTargetReconcileSummary
})

/** Delete every target the connection manages; the disconnect path. */
export const deleteSupabaseScrapeTargets = (
	db: MapleDb,
	connection: Pick<SupabaseConnectionRow, "id" | "orgId">,
) =>
	db
		.run(
			PG.deleteFrom(ScrapeTargets)
				.where(($) => [
					$.orgId.eq(connection.orgId),
					$.managedBy.eq(managedBySupabase(connection.id)),
				])
				.returning("id"),
		)
		.pipe(Effect.map((rows) => rows.length))
