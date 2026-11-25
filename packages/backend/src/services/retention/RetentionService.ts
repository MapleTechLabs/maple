import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgRetentionPolicies, Sources } from "@maple/db/tables"
import { RetentionPersistenceError, SourceNotFoundError } from "@maple/domain/http"
import {
	hasRetentionOverrides,
	organizationRetentionDays,
	readHorizonDays,
	type RetentionDaysBySignal,
	type RetentionOverrides,
	sourceRetentionDays,
} from "@maple/domain/retention"
import type { OrgId, SourceId, UserId } from "@maple/primitives"
import { Array as Arr, Clock, Context, Effect, Layer } from "effect"
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
	) => Effect.Effect<RetentionPolicy, RetentionPersistenceError>
	/** Replaces one source's overrides; an empty set makes it inherit again. */
	readonly setSource: (
		orgId: OrgId,
		userId: UserId,
		sourceId: SourceId,
		overrides: RetentionOverrides,
	) => Effect.Effect<RetentionPolicy, RetentionPersistenceError | SourceNotFoundError>
}

const toPersistenceError = makePersistenceErrorMapper(
	RetentionPersistenceError,
	"Retention persistence failed",
)

const NO_OVERRIDES: RetentionOverrides = {}

export class RetentionService extends Context.Service<RetentionService, RetentionServiceApi>()(
	"@maple/backend/services/retention/RetentionService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "RetentionService", toPersistenceError)

			const get = Effect.fn("RetentionService.get")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const policies = yield* dbExecute((db) =>
					db.run(
						PG.from(OrgRetentionPolicies)
							.select(($) => ({ retentionDays: $.retentionDays }))
							.where(($) => [$.orgId.eq(orgId)])
							.limit(1),
					),
				)
				const sourceRows = yield* dbExecute((db) =>
					db.run(
						PG.from(Sources)
							.select(($) => ({ id: $.id, retentionDays: $.retentionDays }))
							.where(($) => [$.orgId.eq(orgId)])
							.orderBy(["id", "asc"]),
					),
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

			const setOrganization = Effect.fn("RetentionService.setOrganization")(function* (
				orgId: OrgId,
				userId: UserId,
				overrides: RetentionOverrides,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "tenant.userId": userId })
				const now = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db.run(
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
								set: () => ({ retentionDays: overrides, updatedAt: now, updatedBy: userId }),
							}),
					),
				)
				return yield* get(orgId)
			})

			const setSource = Effect.fn("RetentionService.setSource")(function* (
				orgId: OrgId,
				userId: UserId,
				sourceId: SourceId,
				overrides: RetentionOverrides,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"tenant.userId": userId,
					"maple.source.id": sourceId,
				})
				const now = yield* Clock.currentTimeMillis
				const updated = yield* dbExecute((db) =>
					db.run(
						PG.update(Sources)
							.set({ retentionDays: overrides, updatedAt: now, updatedBy: userId })
							.where(($) => [$.orgId.eq(orgId), $.id.eq(sourceId)])
							.returning(($) => ({ id: $.id })),
					),
				)
				if (updated.length === 0) {
					return yield* new SourceNotFoundError({ sourceId, message: "Source not found" })
				}
				return yield* get(orgId)
			})

			return { get, setOrganization, setSource } satisfies RetentionServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
