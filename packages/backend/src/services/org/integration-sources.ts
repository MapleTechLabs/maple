import type { MapleDb } from "@maple/db/client"
import {
	GcpConnectors,
	OAuthConnections,
	PlanetscaleConnections,
	RailwayConnections,
	ScrapeTargets,
	Sources,
	SupabaseConnections,
	VcsInstallations,
} from "@maple/db/tables"
import { scrapeStaleAfterMs } from "@maple/domain/integration-inventory"
import type { SourceResourceCount } from "@maple/domain/source-health"
import { SourcePublicId } from "@maple/domain/http/v2"
import type { OrgId, PullSourcePlatform, SourceId } from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Array as Arr, Effect, Schema } from "effect"
import {
	isPausedAt,
	newSourceId,
	type PullSourceRef,
	pullSourceRow,
	type SourceHealthOverrides,
} from "./source-rows"

const encodeSourceId = Schema.encodeSync(SourcePublicId)

/** The `src_` id pollers stamp as `maple_source_id`. */
export const publicSourceId = (id: SourceId) => encodeSourceId(id)

/** Display names for integration sources, given when an integration connects. */
export const integrationSourceName = {
	prometheus: (target: { readonly name: string }) => target.name,
	gcp: (connector: { readonly scopeId: string }) => `Google Cloud ${connector.scopeId}`,
	railway: (connection: { readonly workspaceNames: string | null }) =>
		connection.workspaceNames ?? "Railway",
	planetscale: (organization: string | undefined) =>
		organization === undefined ? "PlanetScale" : `PlanetScale ${organization}`,
	cloudflare: (connection: { readonly externalAccountName: string | null }) =>
		connection.externalAccountName ?? "Cloudflare",
	github: (installation: { readonly accountLogin: string }) => `GitHub ${installation.accountLogin}`,
	supabase: (organization: { readonly name: string }) => `Supabase ${organization.name}`,
}

/** A new integration source. Create it in the transaction that writes the row pointing at it. */
export const createIntegrationSource = Effect.fnUntraced(function* (
	db: MapleDb,
	orgId: OrgId,
	ref: PullSourceRef,
	now: number,
) {
	const id = newSourceId()
	yield* db.run(PG.insertInto(Sources).values({ ...pullSourceRow(orgId, ref, now), id }))
	return id
})

/**
 * Upserts an integration row with its source: the source of the row it replaces, or a new one.
 * A source created for a row that lost the race to a concurrent upsert is deleted again.
 */
export const upsertWithSource = <Row extends { readonly sourceId: SourceId | null }, E1, E2>(
	db: MapleDb,
	orgId: OrgId,
	ref: PullSourceRef,
	now: number,
	current: Effect.Effect<SourceId | null, E1>,
	upsert: (sourceId: SourceId) => Effect.Effect<Row | undefined, E2>,
) =>
	Effect.gen(function* () {
		const existing = yield* current
		const sourceId = existing ?? (yield* createIntegrationSource(db, orgId, ref, now))
		const row = yield* upsert(sourceId)
		if (existing === null && row?.sourceId !== sourceId) {
			yield* deleteSourcesOf(db, orgId, [{ sourceId }])
		}
		return row
	})

/**
 * Deletes the integration sources of `rows` and, through `ON DELETE CASCADE`, every row that still
 * sends as them. `platform` limits it to sources of that platform.
 */
export const deleteSourcesOf = (
	db: MapleDb,
	orgId: OrgId,
	rows: ReadonlyArray<{ readonly sourceId: SourceId | null }>,
	platform?: PullSourcePlatform,
) => {
	const ids = rows.flatMap((row) => (row.sourceId === null ? [] : [row.sourceId]))
	return ids.length === 0
		? Effect.void
		: db
				.run(
					PG.deleteFrom(Sources).where(($) => [
						$.orgId.eq(orgId),
						PG.inList($.id, ids),
						$.kind.eq("integration"),
						platform === undefined ? undefined : $.platform.eq(platform),
					]),
				)
				.pipe(Effect.asVoid)
}

/**
 * Whether one integration row's source is paused; a row not linked yet is not. Pollers skip a
 * paused source instead of reading data the gateway would drop.
 */
export const isSourcePaused = (db: MapleDb, sourceId: SourceId | null, now: number) =>
	sourceId === null
		? Effect.succeed(false)
		: db
				.run(
					PG.from(Sources)
						.select("pausedAt", "pausedUntil")
						.where(($) => [$.id.eq(sourceId)])
						.limit(1),
				)
				.pipe(Effect.map(([source]) => source !== undefined && isPausedAt(source, now)))

/** What one poll tick found, written onto the integration's source for its health. */
export type PollOutcome =
	| { readonly _tag: "Ok"; readonly resources?: SourceResourceCount }
	| { readonly _tag: "Failed"; readonly error: string; readonly resources?: SourceResourceCount }
	/** The grant is revoked, suspended or rejected: nothing can be read until it is reconnected. */
	| { readonly _tag: "Disconnected"; readonly reason: string }

/** A tick that changes nothing rewrites the row at most once a minute. */
const POLL_REPORT_INTERVAL_MS = 60_000

const pollError = (outcome: PollOutcome) =>
	outcome._tag === "Ok" ? null : outcome._tag === "Failed" ? outcome.error : outcome.reason

/**
 * Whether a tick changes what its source last recorded, or the record is over a minute old. The
 * same test `reportPoll` writes with, for a caller that already holds the source's poll state.
 */
export const pollReportDue = (
	current: {
		readonly lastPollAt: number | null
		readonly lastPollError: string | null
		readonly disconnectedAt: number | null
	},
	outcome: PollOutcome,
	now: number,
) =>
	current.lastPollAt === null ||
	current.lastPollAt < now - POLL_REPORT_INTERVAL_MS ||
	(outcome._tag === "Disconnected") !== (current.disconnectedAt !== null) ||
	pollError(outcome) !== current.lastPollError

/** Records a poll tick on its source; a row not linked yet has nowhere to record it. */
export const reportPoll = (db: MapleDb, sourceId: SourceId | null, outcome: PollOutcome, now: number) => {
	if (sourceId === null) return Effect.void
	const error = pollError(outcome)
	const tick: PG.UpdateSetOf<typeof Sources> = {
		lastPollAt: now,
		lastPollError: error,
		disconnectedAt: outcome._tag === "Disconnected" ? now : null,
		pollResources: outcome._tag === "Disconnected" ? null : (outcome.resources ?? null),
	}
	const set = outcome._tag === "Ok" ? { ...tick, lastPollOkAt: now } : tick
	return db
		.run(
			PG.update(Sources)
				.set(set)
				.where(($) => [
					$.id.eq(sourceId),
					PG.or(
						$.lastPollAt.isNull(),
						$.lastPollAt.lt(now - POLL_REPORT_INTERVAL_MS),
						outcome._tag === "Disconnected"
							? $.disconnectedAt.isNull()
							: $.disconnectedAt.isNotNull(),
						error === null
							? $.lastPollError.isNotNull()
							: PG.or($.lastPollError.isNull(), $.lastPollError.neq(error)),
					),
				]),
		)
		.pipe(Effect.asVoid)
}

/** The `src_` id a row stamps as `maple_source_id`; undefined for a row not linked yet. */
export const stampedSourceId = (sourceId: SourceId | null) =>
	sourceId === null ? undefined : publicSourceId(sourceId)

const SCRAPING_OFF = "Scraping is turned off"

/** What a Prometheus source's targets add to its health: off when none is enabled, else their slowest window. */
const scrapeOverrides = (
	group: ReadonlyArray<{ readonly enabled: boolean; readonly scrapeIntervalSeconds: number }>,
): SourceHealthOverrides => {
	const enabled = group.filter((target) => target.enabled)
	return enabled.length === 0
		? { turnedOff: SCRAPING_OFF }
		: {
				staleAfterMs: Math.max(
					...enabled.map((target) => scrapeStaleAfterMs(target.scrapeIntervalSeconds)),
				),
			}
}

const overridesBySource = (
	targets: ReadonlyArray<{
		readonly sourceId: SourceId | null
		readonly enabled: boolean
		readonly scrapeIntervalSeconds: number
	}>,
) => {
	const bySource = Arr.groupBy(
		targets.flatMap((target) =>
			target.sourceId === null ? [] : [{ ...target, sourceId: target.sourceId }],
		),
		(target) => target.sourceId,
	)
	return new Map(
		Object.values(bySource).map((group): readonly [SourceId, SourceHealthOverrides] => [
			group[0].sourceId,
			scrapeOverrides(group),
		]),
	)
}

/** What each of an org's Prometheus sources' targets add to its health, reading only scrape targets. */
export const readScrapeOverrides = Effect.fnUntraced(function* (db: MapleDb, orgId: OrgId) {
	const targets = yield* db.run(
		PG.from(ScrapeTargets)
			.select("sourceId", "enabled", "scrapeIntervalSeconds")
			.where(($) => [$.orgId.eq(orgId), $.managedBy.isNull()]),
	)
	return overridesBySource(targets)
})

/**
 * For each of an org's integration sources: the integration row it stands for (a scrape target,
 * a connector, a connection; a PlanetScale-managed target sends as its connection), and what its
 * scrape targets add to its health.
 */
export const readSourceOwners = Effect.fnUntraced(function* (db: MapleDb, orgId: OrgId) {
	const [targets, ...owners] = yield* Effect.all(
		[
			db.run(
				PG.from(ScrapeTargets)
					.select("id", "sourceId", "enabled", "scrapeIntervalSeconds")
					.where(($) => [$.orgId.eq(orgId), $.managedBy.isNull()]),
			),
			db.run(
				PG.from(GcpConnectors)
					.select("id", "sourceId")
					.where(($) => [$.orgId.eq(orgId)]),
			),
			db.run(
				PG.from(RailwayConnections)
					.select("id", "sourceId")
					.where(($) => [$.orgId.eq(orgId)]),
			),
			db.run(
				PG.from(PlanetscaleConnections)
					.select("id", "sourceId")
					.where(($) => [$.orgId.eq(orgId)]),
			),
			db.run(
				PG.from(SupabaseConnections)
					.select("id", "sourceId")
					.where(($) => [$.orgId.eq(orgId)]),
			),
			db.run(
				PG.from(OAuthConnections)
					.select("id", "sourceId")
					.where(($) => [$.orgId.eq(orgId), $.sourceId.isNotNull()]),
			),
			db.run(
				PG.from(VcsInstallations)
					.select("id", "sourceId")
					.where(($) => [$.orgId.eq(orgId)]),
			),
		],
		{ concurrency: "unbounded" },
	)
	const linked = [...targets, ...owners.flat()].flatMap((owner) =>
		owner.sourceId === null ? [] : [[owner.sourceId, owner.id] as const],
	)
	return {
		integrationIds: new Map(linked),
		overrides: overridesBySource(targets),
	}
})
