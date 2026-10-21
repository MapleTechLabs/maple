import type { MapleDb } from "@maple/db/client"
import { ScrapeTargets, Sources } from "@maple/db/tables"
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
}

/**
 * The source an integration row sends as: an existing one for the same integration, or a new
 * one. Call it inside the transaction that writes the row's `source_id`.
 */
export const ensureIntegrationSource = Effect.fnUntraced(function* (
	db: MapleDb,
	orgId: OrgId,
	ref: PullSourceRef,
	now: number,
) {
	const select = db.run(
		PG.from(Sources)
			.select(($) => ({ id: $.id }))
			.where(($) => [
				$.orgId.eq(orgId),
				$.platform.eq(ref.platform),
				$.integrationId.eq(ref.integrationId),
			])
			.limit(1),
	)
	const existing = yield* select
	if (existing[0] !== undefined) return existing[0].id
	// A concurrent connect may insert first: the unique index settles it, and the winner's id is read back.
	const id = newSourceId()
	yield* db.run(
		PG.insertInto(Sources)
			.values({ ...pullSourceRow(orgId, ref, now), id })
			.onConflictDoNothing(),
	)
	return (yield* select)[0]?.id ?? id
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

/** Records a poll tick on its source; a row not linked yet has nowhere to record it. */
export const reportPoll = (db: MapleDb, sourceId: SourceId | null, outcome: PollOutcome, now: number) => {
	if (sourceId === null) return Effect.void
	const error = outcome._tag === "Ok" ? null : outcome._tag === "Failed" ? outcome.error : outcome.reason
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
						outcome._tag === "Disconnected" ? $.disconnectedAt.isNull() : $.disconnectedAt.isNotNull(),
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

/**
 * What each Prometheus source's targets add to its health: switched off when none is enabled,
 * otherwise stale only after its slowest target's window.
 */
export const readScrapeOverrides = Effect.fnUntraced(function* (db: MapleDb, orgId: OrgId) {
	const targets = yield* db.run(
		PG.from(ScrapeTargets)
			.select("sourceId", "enabled", "scrapeIntervalSeconds")
			.where(($) => [$.orgId.eq(orgId), $.managedBy.isNull()]),
	)
	const bySource = Arr.groupBy(
		targets.flatMap((target) => (target.sourceId === null ? [] : [{ ...target, sourceId: target.sourceId }])),
		(target) => target.sourceId,
	)
	return new Map(
		Object.values(bySource).map((group): readonly [SourceId, SourceHealthOverrides] => {
			const enabled = group.filter((target) => target.enabled)
			return [
				group[0].sourceId,
				enabled.length === 0
					? { turnedOff: SCRAPING_OFF }
					: {
							staleAfterMs: Math.max(
								...enabled.map((target) => scrapeStaleAfterMs(target.scrapeIntervalSeconds)),
							),
						},
			]
		}),
	)
})

