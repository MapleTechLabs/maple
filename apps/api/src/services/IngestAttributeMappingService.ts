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
	IsoDateTimeString,
	type IngestMappingOperation,
	type IngestMappingSourceContext,
	type OrgId,
	type UpdateIngestAttributeMappingRequest,
} from "@maple/domain/http"
import { orgIngestAttributeMappings } from "@maple/db"
import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "./DatabaseLive"

type MappingRow = typeof orgIngestAttributeMappings.$inferSelect

export interface IngestAttributeMappingServiceShape {
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

const toPersistenceError = (error: unknown) =>
	new IngestAttributeMappingPersistenceError({
		message: error instanceof Error ? error.message : "Attribute mapping persistence failed",
	})

const decodeMappingIdSync = Schema.decodeUnknownSync(IngestAttributeMappingId)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)

const rowToResponse = (row: MappingRow): IngestAttributeMapping =>
	new IngestAttributeMapping({
		id: decodeMappingIdSync(row.id),
		name: row.name,
		sourceContext: row.sourceContext as IngestMappingSourceContext,
		sourceKey: row.sourceKey,
		targetKey: row.targetKey,
		operation: row.operation as IngestMappingOperation,
		enabled: row.enabled,
		createdAt: decodeIsoDateTimeStringSync(new Date(row.createdAt).toISOString()),
		updatedAt: decodeIsoDateTimeStringSync(new Date(row.updatedAt).toISOString()),
	})

const validateRule = (rule: {
	sourceContext: IngestMappingSourceContext
	sourceKey: string
	targetKey: string
}): Effect.Effect<void, IngestAttributeMappingValidationError> => {
	const sourceKey = rule.sourceKey.trim()
	const targetKey = rule.targetKey.trim()
	if (sourceKey.length === 0) {
		return Effect.fail(
			new IngestAttributeMappingValidationError({ message: "Source key must not be empty" }),
		)
	}
	if (targetKey.length === 0) {
		return Effect.fail(
			new IngestAttributeMappingValidationError({ message: "Target key must not be empty" }),
		)
	}
	if (rule.sourceContext === "span" && sourceKey === targetKey) {
		return Effect.fail(
			new IngestAttributeMappingValidationError({
				message: "Source key and target key must differ when the source is a span attribute",
			}),
		)
	}
	return Effect.void
}

export class IngestAttributeMappingService extends Context.Service<
	IngestAttributeMappingService,
	IngestAttributeMappingServiceShape
>()("IngestAttributeMappingService", {
	make: Effect.gen(function* () {
		const database = yield* Database

		const selectById = Effect.fn("IngestAttributeMappingService.selectById")(function* (
			orgId: OrgId,
			mappingId: IngestAttributeMappingId,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(orgIngestAttributeMappings)
						.where(
							and(
								eq(orgIngestAttributeMappings.orgId, orgId),
								eq(orgIngestAttributeMappings.id, mappingId),
							),
						)
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))

			return Option.fromNullishOr(rows[0])
		})

		const requireMapping = Effect.fn("IngestAttributeMappingService.requireMapping")(function* (
			orgId: OrgId,
			mappingId: IngestAttributeMappingId,
		) {
			const row = yield* selectById(orgId, mappingId)
			if (Option.isSome(row)) return row.value

			return yield* Effect.fail(
				new IngestAttributeMappingNotFoundError({
					mappingId,
					message: "Attribute mapping not found",
				}),
			)
		})

		const list = Effect.fn("IngestAttributeMappingService.list")(function* (orgId: OrgId) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(orgIngestAttributeMappings)
						.where(eq(orgIngestAttributeMappings.orgId, orgId)),
				)
				.pipe(Effect.mapError(toPersistenceError))

			return new IngestAttributeMappingsListResponse({
				mappings: rows.map(rowToResponse),
			})
		})

		const create = Effect.fn("IngestAttributeMappingService.create")(function* (
			orgId: OrgId,
			request: CreateIngestAttributeMappingRequest,
		) {
			yield* validateRule(request)

			const now = Date.now()
			const id = decodeMappingIdSync(randomUUID())

			yield* database
				.execute((db) =>
					db.insert(orgIngestAttributeMappings).values({
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
				)
				.pipe(Effect.mapError(toPersistenceError))

			const row = yield* selectById(orgId, id)
			if (Option.isNone(row)) {
				return yield* Effect.fail(
					new IngestAttributeMappingPersistenceError({
						message: "Failed to create attribute mapping",
					}),
				)
			}

			return rowToResponse(row.value)
		})

		const update = Effect.fn("IngestAttributeMappingService.update")(function* (
			orgId: OrgId,
			mappingId: IngestAttributeMappingId,
			request: UpdateIngestAttributeMappingRequest,
		) {
			const existing = yield* requireMapping(orgId, mappingId)

			const merged = {
				sourceContext: request.sourceContext ?? (existing.sourceContext as IngestMappingSourceContext),
				sourceKey: request.sourceKey ?? existing.sourceKey,
				targetKey: request.targetKey ?? existing.targetKey,
			}
			yield* validateRule(merged)

			const now = Date.now()
			const updates: Record<string, unknown> = { updatedAt: now }
			if (request.name !== undefined) updates.name = request.name.trim()
			if (request.sourceContext !== undefined) updates.sourceContext = request.sourceContext
			if (request.sourceKey !== undefined) updates.sourceKey = request.sourceKey.trim()
			if (request.targetKey !== undefined) updates.targetKey = request.targetKey.trim()
			if (request.operation !== undefined) updates.operation = request.operation
			if (request.enabled !== undefined) updates.enabled = request.enabled

			yield* database
				.execute((db) =>
					db
						.update(orgIngestAttributeMappings)
						.set(updates)
						.where(
							and(
								eq(orgIngestAttributeMappings.orgId, orgId),
								eq(orgIngestAttributeMappings.id, mappingId),
							),
						),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const row = yield* selectById(orgId, mappingId)
			if (Option.isNone(row)) {
				return yield* Effect.fail(
					new IngestAttributeMappingPersistenceError({
						message: "Failed to load updated attribute mapping",
					}),
				)
			}

			return rowToResponse(row.value)
		})

		const remove = Effect.fn("IngestAttributeMappingService.delete")(function* (
			orgId: OrgId,
			mappingId: IngestAttributeMappingId,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.delete(orgIngestAttributeMappings)
						.where(
							and(
								eq(orgIngestAttributeMappings.orgId, orgId),
								eq(orgIngestAttributeMappings.id, mappingId),
							),
						)
						.returning({ id: orgIngestAttributeMappings.id }),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const deleted = Option.fromNullishOr(rows[0])
			if (Option.isNone(deleted)) {
				return yield* Effect.fail(
					new IngestAttributeMappingNotFoundError({
						mappingId,
						message: "Attribute mapping not found",
					}),
				)
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
		} satisfies IngestAttributeMappingServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
	static readonly Live = this.layer
	static readonly Default = this.layer
}
