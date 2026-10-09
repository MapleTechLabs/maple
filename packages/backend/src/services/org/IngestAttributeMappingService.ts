import { randomUUID } from "node:crypto"
import {
	CreateIngestAttributeMappingRequest,
	IngestAttributeMapping,
	IngestAttributeMappingDeleteResponse,
	IngestAttributeMappingId,
	IngestAttributeMappingNotFoundError,
	IngestAttributeMappingPersistenceError,
	IngestAttributeMappingsListResponse,
	IngestAttributeMappingValidationError,
	IngestMappingOperation,
	IngestMappingSourceContext,
	IsoDateTimeString,
	type OrgId,
	type UpdateIngestAttributeMappingRequest,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgIngestAttributeMappings, type OrgIngestAttributeMappingRow } from "@maple/db/tables"
import { Array, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database, DatabaseError } from "@maple/backend/platform/DatabaseLive"

type MappingRow = OrgIngestAttributeMappingRow

export interface IngestAttributeMappingServiceApi {
	readonly list: (
		orgId: OrgId,
	) => Effect.Effect<IngestAttributeMappingsListResponse, IngestAttributeMappingPersistenceError>
	readonly create: (
		orgId: OrgId,
		request: CreateIngestAttributeMappingRequest,
	) => Effect.Effect<
		IngestAttributeMapping,
		IngestAttributeMappingValidationError | IngestAttributeMappingPersistenceError
	>
	readonly update: (
		orgId: OrgId,
		mappingId: IngestAttributeMappingId,
		request: UpdateIngestAttributeMappingRequest,
	) => Effect.Effect<
		IngestAttributeMapping,
		| IngestAttributeMappingNotFoundError
		| IngestAttributeMappingValidationError
		| IngestAttributeMappingPersistenceError
	>
	readonly delete: (
		orgId: OrgId,
		mappingId: IngestAttributeMappingId,
	) => Effect.Effect<
		IngestAttributeMappingDeleteResponse,
		IngestAttributeMappingNotFoundError | IngestAttributeMappingPersistenceError
	>
}

const toPersistenceError = (error: DatabaseError) =>
	new IngestAttributeMappingPersistenceError({ message: error.message })

// Logs the underlying Cause before collapsing the database failure into a
// persistence error, so a failed query stays visible in traces and logs.
const runDb = <A>(
	operation: string,
	effect: Effect.Effect<A, DatabaseError>,
): Effect.Effect<A, IngestAttributeMappingPersistenceError> =>
	effect.pipe(
		Effect.tapCause((cause) =>
			Effect.logError("Attribute mapping database operation failed").pipe(
				Effect.annotateLogs({ operation, cause }),
			),
		),
		Effect.mapError(toPersistenceError),
	)

const decodeMappingIdSync = Schema.decodeUnknownSync(IngestAttributeMappingId)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)
const decodeSourceContextSync = Schema.decodeUnknownSync(IngestMappingSourceContext)
const decodeOperationSync = Schema.decodeUnknownSync(IngestMappingOperation)

const rowToResponse = (row: MappingRow): IngestAttributeMapping =>
	new IngestAttributeMapping({
		id: decodeMappingIdSync(row.id),
		name: row.name,
		sourceContext: decodeSourceContextSync(row.sourceContext),
		sourceKey: row.sourceKey,
		targetKey: row.targetKey,
		operation: decodeOperationSync(row.operation),
		enabled: row.enabled,
		createdAt: decodeIsoDateTimeStringSync(new Date(row.createdAt).toISOString()),
		updatedAt: decodeIsoDateTimeStringSync(new Date(row.updatedAt).toISOString()),
	})

const validateRule = Effect.fnUntraced(function* (rule: {
	sourceContext: IngestMappingSourceContext
	sourceKey: string
	targetKey: string
}) {
	const sourceKey = rule.sourceKey.trim()
	const targetKey = rule.targetKey.trim()
	if (sourceKey.length === 0) {
		return yield* new IngestAttributeMappingValidationError({ message: "Source key must not be empty" })
	}
	if (targetKey.length === 0) {
		return yield* new IngestAttributeMappingValidationError({ message: "Target key must not be empty" })
	}
	if (rule.sourceContext === "span" && sourceKey === targetKey) {
		return yield* new IngestAttributeMappingValidationError({
			message: "Source key and target key must differ when the source is a span attribute",
		})
	}
})

export class IngestAttributeMappingService extends Context.Service<
	IngestAttributeMappingService,
	IngestAttributeMappingServiceApi
>()("@maple/api/services/IngestAttributeMappingService", {
	make: Effect.gen(function* () {
		const database = yield* Database

		const selectById = Effect.fn("IngestAttributeMappingService.selectById")(function* (
			orgId: OrgId,
			mappingId: IngestAttributeMappingId,
		) {
			yield* Effect.annotateCurrentSpan({
				orgId,
				"maple.ingest_attribute_mapping.id": mappingId,
			})
			const rows = yield* runDb(
				"selectById",
				database.execute((db) =>
					db.orm.run(
						PG.from(OrgIngestAttributeMappings)
							.select()
							.where(($) => [$.orgId.eq(orgId), $.id.eq(mappingId)])
							.limit(1),
					),
				),
			)

			return Option.fromNullishOr(rows[0])
		})

		const requireMapping = Effect.fn("IngestAttributeMappingService.requireMapping")(function* (
			orgId: OrgId,
			mappingId: IngestAttributeMappingId,
		) {
			yield* Effect.annotateCurrentSpan({
				orgId,
				"maple.ingest_attribute_mapping.id": mappingId,
			})
			const row = yield* selectById(orgId, mappingId)
			if (Option.isSome(row)) return row.value

			yield* Effect.logWarning("Attribute mapping not found").pipe(
				Effect.annotateLogs({ mappingId, orgId }),
			)
			return yield* new IngestAttributeMappingNotFoundError({
				mappingId,
				message: "Attribute mapping not found",
			})
		})

		const list = Effect.fn("IngestAttributeMappingService.list")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			const rows = yield* runDb(
				"list",
				database.execute((db) =>
					db.orm.run(
						PG.from(OrgIngestAttributeMappings)
							.select()
							.where(($) => [$.orgId.eq(orgId)])
							.orderBy(($) => [
								[$.createdAt, "desc"],
								[$.id, "desc"],
							]),
					),
				),
			)

			return new IngestAttributeMappingsListResponse({
				mappings: Array.map(rows, rowToResponse),
			})
		})

		const create = Effect.fn("IngestAttributeMappingService.create")(function* (
			orgId: OrgId,
			request: CreateIngestAttributeMappingRequest,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* validateRule(request)

			const now = yield* Clock.currentTimeMillis
			const id = decodeMappingIdSync(randomUUID())
			yield* Effect.annotateCurrentSpan("maple.ingest_attribute_mapping.id", id)

			yield* runDb(
				"create",
				database.execute((db) =>
					db.orm.run(
						PG.insertInto(OrgIngestAttributeMappings).values({
							id,
							orgId,
							name: request.name.trim(),
							sourceContext: request.sourceContext,
							sourceKey: request.sourceKey.trim(),
							targetKey: request.targetKey.trim(),
							operation: request.operation,
							enabled: request.enabled ?? true,
							createdAt: now,
							updatedAt: now,
						}),
					),
				),
			)

			const row = yield* selectById(orgId, id)
			if (Option.isNone(row)) {
				yield* Effect.logError("Attribute mapping missing after insert").pipe(
					Effect.annotateLogs({ mappingId: id, orgId }),
				)
				return yield* new IngestAttributeMappingPersistenceError({
					message: "Failed to create attribute mapping",
				})
			}

			return rowToResponse(row.value)
		})

		const update = Effect.fn("IngestAttributeMappingService.update")(function* (
			orgId: OrgId,
			mappingId: IngestAttributeMappingId,
			request: UpdateIngestAttributeMappingRequest,
		) {
			yield* Effect.annotateCurrentSpan({
				orgId,
				"maple.ingest_attribute_mapping.id": mappingId,
			})
			const existing = yield* requireMapping(orgId, mappingId)

			const merged = {
				sourceContext: request.sourceContext ?? decodeSourceContextSync(existing.sourceContext),
				sourceKey: request.sourceKey ?? existing.sourceKey,
				targetKey: request.targetKey ?? existing.targetKey,
			}
			yield* validateRule(merged)

			const now = yield* Clock.currentTimeMillis
			const updates = {
				updatedAt: now,
				...(request.name !== undefined ? { name: request.name.trim() } : {}),
				...(request.sourceContext !== undefined ? { sourceContext: request.sourceContext } : {}),
				...(request.sourceKey !== undefined ? { sourceKey: request.sourceKey.trim() } : {}),
				...(request.targetKey !== undefined ? { targetKey: request.targetKey.trim() } : {}),
				...(request.operation !== undefined ? { operation: request.operation } : {}),
				...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
			}

			yield* runDb(
				"update",
				database.execute((db) =>
					db.orm.run(
						PG.update(OrgIngestAttributeMappings)
							.set(updates)
							.where(($) => [$.orgId.eq(orgId), $.id.eq(mappingId)]),
					),
				),
			)

			const row = yield* selectById(orgId, mappingId)
			if (Option.isNone(row)) {
				yield* Effect.logError("Attribute mapping missing after update").pipe(
					Effect.annotateLogs({ mappingId, orgId }),
				)
				return yield* new IngestAttributeMappingPersistenceError({
					message: "Failed to load updated attribute mapping",
				})
			}

			return rowToResponse(row.value)
		})

		const remove = Effect.fn("IngestAttributeMappingService.delete")(function* (
			orgId: OrgId,
			mappingId: IngestAttributeMappingId,
		) {
			yield* Effect.annotateCurrentSpan({
				orgId,
				"maple.ingest_attribute_mapping.id": mappingId,
			})
			const rows = yield* runDb(
				"delete",
				database.execute((db) =>
					db.orm.run(
						PG.deleteFrom(OrgIngestAttributeMappings)
							.where(($) => [$.orgId.eq(orgId), $.id.eq(mappingId)])
							.returning("id"),
					),
				),
			)

			const deleted = Option.fromNullishOr(rows[0])
			if (Option.isNone(deleted)) {
				yield* Effect.logWarning("Attribute mapping not found").pipe(
					Effect.annotateLogs({ mappingId, orgId }),
				)
				return yield* new IngestAttributeMappingNotFoundError({
					mappingId,
					message: "Attribute mapping not found",
				})
			}

			return new IngestAttributeMappingDeleteResponse({
				id: decodeMappingIdSync(deleted.value.id),
			})
		})

		return {
			list,
			create,
			update,
			delete: remove,
		} satisfies IngestAttributeMappingServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
