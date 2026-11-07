import * as PG from "@maple-dev/effect-orm/postgres"
import { ServiceMapWorldEntities } from "@maple/db/tables"
import {
	ApplyWorldOpsResponse,
	IsoDateTimeString,
	WORLD_ENTITIES_MAX,
	WORLD_SCHEMA_VERSION,
	WorldConflictError,
	WorldDocument,
	entityIdOf,
	WorldEntity,
	WorldEntityId,
	WorldEntityRecord,
	WorldInvalidOpsError,
	type WorldOp,
	WorldPersistenceError,
} from "@maple/domain/http"
import type { OrgId, UserId } from "@maple/domain/primitives"
import type { MapleDb } from "@maple/db/client"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Result, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"

const toPersistenceError = makePersistenceErrorMapper(
	WorldPersistenceError,
	"Service map world persistence failure",
)

const decodeEntityId = Schema.decodeUnknownOption(WorldEntityId)
const decodeEntity = Schema.decodeUnknownOption(WorldEntity)
const encodeEntity = Schema.encodeEffect(WorldEntity)
const decodeIso = Schema.decodeUnknownSync(IsoDateTimeString)

/** A stored row with `data` left undecoded, so a kind this build does not know is skipped. */
interface StoredRow {
	readonly entityId: string
	readonly data: unknown
	readonly revision: number
	readonly updatedAt: number
	readonly updatedBy: UserId | null
}

const selectStored = () =>
	PG.from(ServiceMapWorldEntities).select(($) => ({
		entityId: $.entityId,
		data: PG.undecoded($.data),
		revision: $.revision,
		updatedAt: $.updatedAt,
		updatedBy: $.updatedBy,
	}))

/** `None` for a row of an unknown or older entity shape. */
const toRecord = (row: StoredRow): Option.Option<WorldEntityRecord> =>
	Option.all({ id: decodeEntityId(row.entityId), entity: decodeEntity(row.data) }).pipe(
		Option.map(
			({ id, entity }) =>
				new WorldEntityRecord({
					id,
					entity,
					revision: row.revision,
					updatedAt: decodeIso(new Date(row.updatedAt).toISOString()),
					updatedBy: row.updatedBy,
				}),
		),
	)

/** Fails with the conflicting ids when any non-null `expectedRevision` is not what is stored. */
const checkRevisions = (ops: ReadonlyArray<WorldOp>, locked: ReadonlyMap<string, StoredRow>) => {
	const ids = Arr.filterMap(ops, (op) =>
		op.expectedRevision !== null && locked.get(op.id)?.revision !== op.expectedRevision
			? Result.succeed(op.id)
			: Result.failVoid,
	)
	if (ids.length === 0) return Effect.void
	const current = Arr.getSomes(
		Arr.map(ids, (id) => Option.flatMap(Option.fromUndefinedOr(locked.get(id)), toRecord)),
	)
	return Effect.fail(
		new WorldConflictError({
			message: `${ids.length} world ${ids.length === 1 ? "entity has" : "entities have"} changed since they were read.`,
			ids,
			current,
		}),
	)
}

const findDuplicateIds = (ops: ReadonlyArray<WorldOp>) => {
	const ids = Arr.map(ops, (op) => op.id)
	return Arr.dedupe(Arr.filter(ids, (id, index) => ids.indexOf(id) !== index))
}

export interface ServiceMapWorldServiceApi {
	readonly get: (orgId: OrgId) => Effect.Effect<WorldDocument, WorldPersistenceError>
	/** All ops in one transaction: any revision mismatch fails the whole batch. */
	readonly apply: (
		orgId: OrgId,
		userId: UserId,
		ops: ReadonlyArray<WorldOp>,
	) => Effect.Effect<
		ApplyWorldOpsResponse,
		WorldPersistenceError | WorldConflictError | WorldInvalidOpsError
	>
}

type PutOp = Extract<WorldOp, { readonly _tag: "Put" }>

/** One upsert for every put: revision 1 on insert, the stored revision + 1 on conflict. */
const upsertPuts = (db: MapleDb, orgId: OrgId, userId: UserId, puts: ReadonlyArray<PutOp>, now: number) =>
	Effect.gen(function* () {
		const values = yield* Effect.forEach(puts, (op) =>
			encodeEntity(op.entity).pipe(
				Effect.mapBoth({
					onSuccess: (data) => ({
						orgId,
						entityId: op.id,
						kind: op.entity._tag,
						data,
						revision: 1,
						createdAt: now,
						updatedAt: now,
						updatedBy: userId,
					}),
					onFailure: (error) =>
						new WorldInvalidOpsError({ message: `Entity ${op.id}: ${error.message}` }),
				}),
			),
		)
		const stored = yield* db.run(
			PG.insertInto(ServiceMapWorldEntities)
				.values(values)
				.onConflictDoUpdate({
					target: ["orgId", "entityId"],
					set: ($, excluded) => ({
						kind: excluded.kind,
						data: excluded.data,
						revision: $.revision.add(1),
						updatedAt: excluded.updatedAt,
						updatedBy: excluded.updatedBy,
					}),
				})
				.returning("entityId", "revision", "updatedAt", "updatedBy"),
		)
		const byId = new Map(Arr.map(stored, (row) => [row.entityId, row] as const))
		return Arr.getSomes(
			Arr.map(puts, (op) =>
				Option.map(
					Option.fromUndefinedOr(byId.get(op.id)),
					(row) =>
						new WorldEntityRecord({
							id: op.id,
							entity: op.entity,
							revision: row.revision,
							updatedAt: decodeIso(new Date(row.updatedAt).toISOString()),
							updatedBy: row.updatedBy,
						}),
				),
			),
		)
	})

const applyInTransaction = (
	db: MapleDb,
	orgId: OrgId,
	userId: UserId,
	ops: ReadonlyArray<WorldOp>,
	now: number,
) =>
	Effect.gen(function* () {
		// Locked in id order so two batches touching the same rows cannot deadlock.
		const lockedRows = yield* db.run(
			selectStored()
				.where(($) => [
					$.orgId.eq(orgId),
					PG.inList(
						$.entityId,
						Arr.map(ops, (op) => op.id),
					),
				])
				.orderBy(["entityId", "asc"])
				.forUpdate(),
		)
		const locked = new Map(Arr.map(lockedRows, (row) => [row.entityId, row] as const))
		yield* checkRevisions(ops, locked)

		const puts = Arr.filterMap(ops, (op) => (op._tag === "Put" ? Result.succeed(op) : Result.failVoid))
		const removeIds = Arr.filterMap(ops, (op) =>
			op._tag === "Remove" ? Result.succeed(op.id) : Result.failVoid,
		)
		const growth =
			Arr.filter(puts, (op) => !locked.has(op.id)).length -
			Arr.filter(removeIds, (id) => locked.has(id)).length
		if (growth > 0) {
			const [counted] = yield* db.run(
				PG.from(ServiceMapWorldEntities)
					.select(() => ({ count: PG.count() }))
					.where(($) => [$.orgId.eq(orgId)]),
			)
			if (Number(counted?.count ?? 0) + growth > WORLD_ENTITIES_MAX) {
				return yield* new WorldInvalidOpsError({
					message: `A world holds at most ${WORLD_ENTITIES_MAX} entities.`,
				})
			}
		}

		if (removeIds.length > 0) {
			yield* db.run(
				PG.deleteFrom(ServiceMapWorldEntities).where(($) => [
					$.orgId.eq(orgId),
					PG.inList($.entityId, removeIds),
				]),
			)
		}
		const put = puts.length === 0 ? [] : yield* upsertPuts(db, orgId, userId, puts, now)
		return new ApplyWorldOpsResponse({ put, removed: removeIds })
	})

export class ServiceMapWorldService extends Context.Service<
	ServiceMapWorldService,
	ServiceMapWorldServiceApi
>()("@maple/backend/services/ServiceMapWorldService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const dbExecute = makeDbExecute(database, "ServiceMapWorldService", toPersistenceError)

		const get = Effect.fn("ServiceMapWorldService.get")(function* (orgId: OrgId) {
			const rows = yield* dbExecute((db) =>
				db.run(
					selectStored()
						.where(($) => [$.orgId.eq(orgId)])
						.orderBy(["entityId", "asc"]),
				),
			)
			const entities = Arr.getSomes(Arr.map(rows, toRecord))
			yield* Effect.annotateCurrentSpan({
				"maple.service_map.world.entity_count": entities.length,
				"maple.service_map.world.skipped_count": rows.length - entities.length,
			})
			return new WorldDocument({ schemaVersion: WORLD_SCHEMA_VERSION, entities })
		})

		const apply = Effect.fn("ServiceMapWorldService.apply")(function* (
			orgId: OrgId,
			userId: UserId,
			ops: ReadonlyArray<WorldOp>,
		) {
			yield* Effect.annotateCurrentSpan({ "maple.service_map.world.op_count": ops.length })
			const duplicates = findDuplicateIds(ops)
			if (duplicates.length > 0) {
				return yield* new WorldInvalidOpsError({
					message: `A batch may touch each entity once; repeated: ${duplicates.join(", ")}.`,
				})
			}
			const misfiled = Arr.filterMap(ops, (op) =>
				op._tag === "Put" && entityIdOf(op.entity) !== op.id
					? Result.succeed(op.id)
					: Result.failVoid,
			)
			if (misfiled.length > 0) {
				return yield* new WorldInvalidOpsError({
					message: `An entity must be stored under its own id; mismatched: ${misfiled.join(", ")}.`,
				})
			}
			const now = yield* Clock.currentTimeMillis
			return yield* dbExecute((db) => db.transaction(applyInTransaction(db, orgId, userId, ops, now)))
		})

		return { get, apply } satisfies ServiceMapWorldServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
