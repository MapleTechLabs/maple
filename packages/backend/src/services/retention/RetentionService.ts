import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgRetentionPolicies, Sources } from "@maple/db/tables"
import { RetentionInvalidError, RetentionPersistenceError, SourceNotFoundError } from "@maple/domain/http"
import {
	hasRetentionOverrides,
	MAX_RETENTION_DAYS,
	MIN_RETENTION_DAYS,
	organizationRetentionDays,
	readHorizonDays,
	type RetentionDaysBySignal,
	RetentionOverrides,
	sourceRetentionDays,
} from "@maple/domain/retention"
import type { OrgId, SourceId, UserId } from "@maple/primitives"
import type { MapleDb } from "@maple/db/client"
import { Array as Arr, Clock, Context, Effect, Layer, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"

/** A source that keeps at least one signal for a period of its own. */
export interface SourceRetention {
	readonly sourceId: SourceId
	readonly overrides: RetentionOverrides
	readonly days: RetentionDaysBySignal
}

/** An organization's retention as stored and as it resolves. */
export interface RetentionPolicy {
	/** What the organization set; a signal left out uses the default. */
	readonly overrides: RetentionOverrides
	/** What a source with no override of its own keeps. */
	readonly days: RetentionDaysBySignal
	/** How far back a read of each signal may reach: the longest any source keeps it. */
	readonly readHorizonDays: RetentionDaysBySignal
	readonly sources: ReadonlyArray<SourceRetention>
}

export interface RetentionServiceApi {
	readonly get: (orgId: OrgId) => Effect.Effect<RetentionPolicy, RetentionPersistenceError>
	/** Replaces what the organization set. It applies to data ingested from now on. */
	readonly setOrganization: (
		orgId: OrgId,
		userId: UserId,
		overrides: RetentionOverrides,
	) => Effect.Effect<RetentionPolicy, RetentionPersistenceError | RetentionInvalidError>
	/** Replaces one source's overrides; an empty set makes it inherit again. */
	readonly setSource: (
		orgId: OrgId,
		userId: UserId,
		sourceId: SourceId,
		overrides: RetentionOverrides,
	) => Effect.Effect<
		RetentionPolicy,
		RetentionPersistenceError | RetentionInvalidError | SourceNotFoundError
	>
}

const toPersistenceError = makePersistenceErrorMapper(
	RetentionPersistenceError,
	"Retention persistence failed",
)

const NO_OVERRIDES: RetentionOverrides = {}

const decodeOverrides = Schema.decodeUnknownEffect(RetentionOverrides)

/** Periods a caller may store: whole days within the bounds, for known signals only. */
const validOverrides = (input: RetentionOverrides) =>
	decodeOverrides(input).pipe(
		Effect.mapError(
			() =>
				new RetentionInvalidError({
					message: `Retention must be a whole number of days from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}`,
				}),
		),
	)

export class RetentionService extends Context.Service<RetentionService, RetentionServiceApi>()(
	"@maple/backend/services/retention/RetentionService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "RetentionService", toPersistenceError)

			// The org's periods and its sources' are read from one snapshot, so the horizon
			// is never worked out from two different commits.
			const readPolicy = Effect.fnUntraced(function* (db: MapleDb, orgId: OrgId) {
				const policies = yield* db.run(
					PG.from(OrgRetentionPolicies)
						.select(($) => ({ retentionDays: $.retentionDays }))
						.where(($) => [$.orgId.eq(orgId)])
						.limit(1),
				)
				const sourceRows = yield* db.run(
					PG.from(Sources)
						.select(($) => ({ id: $.id, retentionDays: $.retentionDays }))
						.where(($) => [$.orgId.eq(orgId)])
						.orderBy(["id", "asc"]),
				)
				const overrides = policies[0]?.retentionDays ?? NO_OVERRIDES
				const overridden = Arr.filter(sourceRows, (row) => hasRetentionOverrides(row.retentionDays))
				yield* Effect.annotateCurrentSpan({
					"result.rowCount": sourceRows.length,
					"maple.retention.source_overrides": overridden.length,
				})
				return {
					overrides,
					days: organizationRetentionDays(overrides),
					readHorizonDays: readHorizonDays(
						overrides,
						Arr.map(overridden, (row) => row.retentionDays),
					),
					sources: Arr.map(overridden, (row) => ({
						sourceId: row.id,
						overrides: row.retentionDays,
						days: sourceRetentionDays(overrides, row.retentionDays),
					})),
				} satisfies RetentionPolicy
			})

			const get = Effect.fn("RetentionService.get")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				return yield* dbExecute((db) =>
					db.transaction(readPolicy(db, orgId), {
						isolationLevel: "repeatable read",
						accessMode: "read only",
					}),
				)
			})

			const setOrganization = Effect.fn("RetentionService.setOrganization")(function* (
				orgId: OrgId,
				userId: UserId,
				input: RetentionOverrides,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "tenant.userId": userId })
				const overrides = yield* validOverrides(input)
				const now = yield* Clock.currentTimeMillis
				// The write and the policy it returns commit together: a failed read undoes the write.
				return yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* db.run(
								PG.insertInto(OrgRetentionPolicies)
									.values({
										orgId,
										retentionDays: overrides,
										createdAt: now,
										updatedAt: now,
										updatedBy: userId,
									})
									.onConflictDoUpdate({
										target: ["orgId"],
										set: () => ({
											retentionDays: overrides,
											updatedAt: now,
											updatedBy: userId,
										}),
									}),
							)
							return yield* readPolicy(db, orgId)
						}),
						{ isolationLevel: "repeatable read" },
					),
				)
			})

			const setSource = Effect.fn("RetentionService.setSource")(function* (
				orgId: OrgId,
				userId: UserId,
				sourceId: SourceId,
				input: RetentionOverrides,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"tenant.userId": userId,
					"maple.source.id": sourceId,
				})
				const overrides = yield* validOverrides(input)
				const now = yield* Clock.currentTimeMillis
				return yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const updated = yield* db.run(
								PG.update(Sources)
									.set({ retentionDays: overrides, updatedAt: now, updatedBy: userId })
									.where(($) => [$.orgId.eq(orgId), $.id.eq(sourceId)])
									.returning(($) => ({ id: $.id })),
							)
							if (updated.length === 0) {
								return yield* new SourceNotFoundError({
									sourceId,
									message: "Source not found",
								})
							}
							return yield* readPolicy(db, orgId)
						}),
						{ isolationLevel: "repeatable read" },
					),
				)
			})

			return { get, setOrganization, setSource } satisfies RetentionServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
