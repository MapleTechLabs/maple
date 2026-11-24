import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import { SourceMapFiles, type SourceMapFileRow } from "@maple/db/tables"
import {
	SourceMapInvalidError,
	SourceMapNotFoundError,
	SourceMapStorageError,
	SourceMapTooLargeError,
} from "@maple/domain/http"
import { type OrgId, SourceMapFileId } from "@maple/primitives"
import { Array as Arr, Clock, Context, Duration, Effect, Layer, Option, Schema, String as Str } from "effect"
import { SourceMapBucket, type WritableObjectStore } from "@maple/backend/platform/bindings"
import { Database, type DatabaseApi } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { postgresSqlState } from "@maple/backend/platform/postgres-errors"
import { type SourceMapUpload, sourceMapObjectKey, validateSourceMapUpload } from "./source-map-files"
import { SOURCE_MAP_TOUCH_INTERVAL, toSourceMapStorageError as toStorageError } from "./SourceMapReader"

/**
 * A file unused this long is deleted, row and object. A recorded use may be up to a day stale
 * (`SOURCE_MAP_TOUCH_INTERVAL`), so a used file gets that day on top.
 */
export const SOURCE_MAP_RETENTION = Duration.days(90)
const SWEEP_BATCH = 500
const SWEEP_BATCHES_PER_TICK = 10
/** An object this old with no row is an upload whose row never landed. */
const ORPHAN_MIN_AGE = Duration.days(1)
/** Objects checked per tick; R2 lists at most 1000 per page. */
const ORPHAN_PAGE = 1000
const OBJECT_PREFIX = "v1/"
/** Where the orphan pass resumes; outside `v1/`, so it is never listed as a map. */
const ORPHAN_CURSOR_KEY = "meta/orphan-sweep-cursor"

export interface SourceMapListFilter {
	readonly serviceName?: string | undefined
	readonly version?: string | undefined
	readonly debugId?: string | undefined
	readonly limit: number
	readonly offset: number
}

export interface SourceMapServiceApi {
	/** Stores the map, replacing the file with its debug id, else the id-less file at its release path. */
	readonly upload: (
		orgId: OrgId,
		upload: SourceMapUpload,
	) => Effect.Effect<
		SourceMapFileRow,
		SourceMapInvalidError | SourceMapTooLargeError | SourceMapStorageError
	>
	/** Newest first; `limit` rows from `offset`. */
	readonly list: (
		orgId: OrgId,
		filter: SourceMapListFilter,
	) => Effect.Effect<ReadonlyArray<SourceMapFileRow>, SourceMapStorageError>
	readonly remove: (
		orgId: OrgId,
		id: SourceMapFileId,
	) => Effect.Effect<SourceMapFileRow, SourceMapNotFoundError | SourceMapStorageError>
	/** Deletes files unused for 90 days; returns how many went. */
	readonly sweepExpired: (now: number) => Effect.Effect<number, SourceMapStorageError>
	/** Deletes objects at least a day old that no row points at; one listing page per call. */
	readonly sweepOrphans: (now: number) => Effect.Effect<number, SourceMapStorageError>
}

const UNIQUE_VIOLATION = "23505"

/** A concurrent upload of the same identity committed first; the write is retried once. */
class SourceMapRowConflict extends Schema.TaggedError<SourceMapRowConflict>()(
	"@maple/backend/sourcemaps/SourceMapRowConflict",
	{ message: Schema.String },
) {}

const decodeFileId = Schema.decodeSync(SourceMapFileId)

const deleteObjects = (bucket: WritableObjectStore, rows: ReadonlyArray<SourceMapFileRow>) =>
	rows.length === 0
		? Effect.void
		: bucket.delete(Arr.map(rows, (row) => row.objectKey)).pipe(Effect.mapError(toStorageError))

/**
 * Deletes the rows among `ids` still unused since before `cutoff`, returning their object keys.
 * The predicate is checked in the delete itself, so a use recorded after selection keeps its row.
 */
export const claimExpired = (
	database: DatabaseApi,
	ids: ReadonlyArray<SourceMapFileId>,
	cutoff: number,
): Effect.Effect<ReadonlyArray<string>, SourceMapStorageError> =>
	ids.length === 0
		? Effect.succeed([])
		: makeDbExecute(
				database,
				"SourceMapService",
				toStorageError,
			)((db) =>
				db.run(
					PG.deleteFrom(SourceMapFiles)
						.where(($) => [
							PG.inList($.id, ids),
							PG.or(
								$.lastUsedAt.lt(cutoff - Duration.toMillis(SOURCE_MAP_TOUCH_INTERVAL)),
								PG.and($.lastUsedAt.isNull(), $.createdAt.lt(cutoff)),
							),
						])
						.crossTenant()
						.returning("objectKey"),
				),
			).pipe(Effect.map((rows) => Arr.map(rows, (row) => row.objectKey)))

/**
 * One sweep over every org: rows are claimed first, then their objects deleted. An object whose
 * delete fails has no row left, so the orphan sweep removes it a day later.
 */
const sweep = (database: DatabaseApi, bucket: WritableObjectStore, now: number) => {
	const dbExecute = makeDbExecute(database, "SourceMapService", toStorageError)
	const cutoff = now - Duration.toMillis(SOURCE_MAP_RETENTION)
	const batch = (left: number, deleted: number): Effect.Effect<number, SourceMapStorageError> =>
		Effect.gen(function* () {
			const candidates = yield* dbExecute((db) =>
				db.run(
					PG.from(SourceMapFiles)
						.select("id")
						.where(($) => [
							PG.or(
								$.lastUsedAt.lt(cutoff - Duration.toMillis(SOURCE_MAP_TOUCH_INTERVAL)),
								PG.and($.lastUsedAt.isNull(), $.createdAt.lt(cutoff)),
							),
						])
						.orderBy(($) => [[$.createdAt, "asc"]])
						.limit(SWEEP_BATCH)
						.crossTenant(),
				),
			)
			if (candidates.length === 0) return deleted
			const claimed = yield* claimExpired(
				database,
				Arr.map(candidates, (row) => row.id),
				cutoff,
			)
			if (claimed.length > 0) {
				yield* bucket.delete(claimed).pipe(
					Effect.tapError((error) =>
						Effect.logWarning(
							"Expired source map objects were not deleted; the orphan sweep will",
						).pipe(Effect.annotateLogs({ count: claimed.length, message: error.message })),
					),
					Effect.ignore,
				)
			}
			const total = deleted + claimed.length
			return candidates.length < SWEEP_BATCH || left <= 1 ? total : yield* batch(left - 1, total)
		})
	return batch(SWEEP_BATCHES_PER_TICK, 0)
}

const decodeFileIdOption = Schema.decodeUnknownOption(SourceMapFileId)

/**
 * One page of the bucket, resuming where the last tick stopped: objects older than a day whose
 * row is missing are deleted. Those are uploads whose isolate died between the object and the
 * row, or replaced objects whose delete failed.
 */
const sweepOrphanObjects = (database: DatabaseApi, bucket: WritableObjectStore, now: number) =>
	Effect.gen(function* () {
		const dbExecute = makeDbExecute(database, "SourceMapService", toStorageError)
		const storeError = Effect.mapError(toStorageError)
		const cursorBytes = yield* bucket.getBytes(ORPHAN_CURSOR_KEY).pipe(storeError)
		const cursor = Option.filter(
			Option.map(cursorBytes, (bytes) => new TextDecoder().decode(bytes)),
			Str.startsWith(OBJECT_PREFIX),
		)
		const page = yield* bucket
			.list({ prefix: OBJECT_PREFIX, startAfter: Option.getOrUndefined(cursor), limit: ORPHAN_PAGE })
			.pipe(storeError)
		const cutoff = now - Duration.toMillis(ORPHAN_MIN_AGE)
		// Keys this service did not write (no file id) are left alone.
		const candidates = Arr.getSomes(
			Arr.map(
				Arr.filter(page.objects, (object) => object.uploadedAt < cutoff),
				(object) =>
					Option.map(
						Option.flatMap(Arr.last(Str.split(object.key, "/")), decodeFileIdOption),
						(id) => ({ key: object.key, id }),
					),
			),
		)
		const known =
			candidates.length === 0
				? []
				: yield* dbExecute((db) =>
						db.run(
							PG.from(SourceMapFiles)
								.select("objectKey")
								.where(($) => [
									PG.inList(
										$.id,
										Arr.map(candidates, (candidate) => candidate.id),
									),
								])
								.crossTenant(),
						),
					)
		const knownKeys = new Set(Arr.map(known, (row) => row.objectKey))
		const orphans = Arr.filter(
			Arr.map(candidates, (candidate) => candidate.key),
			(key) => !knownKeys.has(key),
		)
		if (orphans.length > 0) {
			yield* bucket.delete(orphans).pipe(storeError)
			yield* Effect.logWarning("Deleted source map objects that no row points at").pipe(
				Effect.annotateLogs({ count: orphans.length }),
			)
		}
		// A full pass done, the next tick starts over from the first key.
		const last = Arr.last(page.objects)
		yield* (
			page.truncated && Option.isSome(last)
				? bucket.put(ORPHAN_CURSOR_KEY, new TextEncoder().encode(last.value.key), "text/plain")
				: bucket.delete([ORPHAN_CURSOR_KEY])
		).pipe(storeError)
		return orphans.length
	})

export class SourceMapService extends Context.Service<SourceMapService, SourceMapServiceApi>()(
	"@maple/backend/services/sourcemaps/SourceMapService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const bucket = yield* SourceMapBucket
			const dbExecute = makeDbExecute(database, "SourceMapService", toStorageError)
			const rowExecute = makeDbExecute(database, "SourceMapService", (error) =>
				postgresSqlState(error) === UNIQUE_VIOLATION
					? new SourceMapRowConflict({ message: error.message })
					: toStorageError(error),
			)

			const upload = Effect.fn("SourceMapService.upload")(function* (
				orgId: OrgId,
				input: SourceMapUpload,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.source_map.size_bytes": input.bytes.byteLength,
				})
				const valid = yield* validateSourceMapUpload(input)
				const id = decodeFileId(randomUUID())
				const objectKey = sourceMapObjectKey(orgId, id)
				const now = yield* Clock.currentTimeMillis
				yield* Effect.annotateCurrentSpan({
					"maple.source_map.id": id,
					"maple.source_map.has_debug_id": valid.debugId !== null,
				})

				yield* bucket
					.put(objectKey, input.bytes, "application/json")
					.pipe(Effect.mapError(toStorageError))
				// A failed row write leaves the object: the error may be a lost commit ack for a row
				// that did land. A real orphan goes in the hourly orphan sweep a day later.
				const replaced = yield* rowExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const { debugId, serviceName, version, minifiedPath } = valid
							const previous = yield* db.run(
								PG.from(SourceMapFiles)
									.select()
									.where(($) => [
										$.orgId.eq(orgId),
										// A debug id is the whole identity of its build; only a map without
										// one replaces by release path, and only another map without one.
										debugId !== null
											? $.debugId.eq(debugId)
											: PG.and(
													$.debugId.isNull(),
													$.serviceName.eq(serviceName ?? ""),
													$.version.eq(version ?? ""),
													$.minifiedPath.eq(minifiedPath),
												),
									]),
							)
							if (previous.length > 0) {
								const previousIds = Arr.map(previous, (row) => row.id)
								yield* db.run(
									PG.deleteFrom(SourceMapFiles).where(($) => [
										$.orgId.eq(orgId),
										PG.inList($.id, previousIds),
									]),
								)
							}
							const [row] = yield* db.run(
								PG.insertInto(SourceMapFiles)
									.values({
										id,
										orgId,
										debugId,
										serviceName,
										version,
										minifiedPath,
										sizeBytes: valid.sizeBytes,
										hasSourcesContent: valid.hasSourcesContent,
										objectKey,
										createdAt: now,
										lastUsedAt: null,
									})
									.returning(),
							)
							return { row, previous }
						}),
					),
				).pipe(
					// A concurrent upload of the same map committed between the read and the insert;
					// the second attempt reads and replaces its row.
					Effect.retry({ times: 1, while: Schema.is(SourceMapRowConflict) }),
					Effect.catchTag("@maple/backend/sourcemaps/SourceMapRowConflict", (error) =>
						Effect.fail(new SourceMapStorageError({ message: error.message })),
					),
				)
				// The replaced objects are unreferenced now; a failed delete only leaves bytes behind.
				yield* deleteObjects(bucket, replaced.previous).pipe(
					Effect.tapError((error) =>
						Effect.logWarning("Replaced source map objects were not deleted").pipe(
							Effect.annotateLogs({ orgId, message: error.message }),
						),
					),
					Effect.ignore,
				)
				if (replaced.row === undefined) {
					return yield* new SourceMapStorageError({ message: "The source map row was not written" })
				}
				return replaced.row
			})

			const list = Effect.fn("SourceMapService.list")(function* (
				orgId: OrgId,
				filter: SourceMapListFilter,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				return yield* dbExecute((db) =>
					db.run(
						PG.from(SourceMapFiles)
							.select()
							.where(($) => [
								$.orgId.eq(orgId),
								filter.serviceName === undefined
									? undefined
									: $.serviceName.eq(filter.serviceName),
								filter.version === undefined ? undefined : $.version.eq(filter.version),
								filter.debugId === undefined
									? undefined
									: $.debugId.eq(Str.toLowerCase(filter.debugId)),
							])
							.orderBy(($) => [
								[$.createdAt, "desc"],
								[$.id, "desc"],
							])
							.limit(filter.limit)
							.offset(filter.offset),
					),
				)
			})

			const remove = Effect.fn("SourceMapService.remove")(function* (
				orgId: OrgId,
				id: SourceMapFileId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.source_map.id": id })
				const [row] = yield* dbExecute((db) =>
					db.run(
						PG.from(SourceMapFiles)
							.select()
							.where(($) => [$.orgId.eq(orgId), $.id.eq(id)])
							.limit(1),
					),
				)
				if (row === undefined) {
					return yield* new SourceMapNotFoundError({
						message: "Source map not found",
						sourceMapId: id,
					})
				}
				// Object first: a failed row delete leaves a row a retry can still remove.
				yield* deleteObjects(bucket, [row])
				yield* dbExecute((db) =>
					db.run(PG.deleteFrom(SourceMapFiles).where(($) => [$.orgId.eq(orgId), $.id.eq(id)])),
				)
				return row
			})

			const sweepExpired = Effect.fn("SourceMapService.sweepExpired")(function* (now: number) {
				const deleted = yield* sweep(database, bucket, now)
				yield* Effect.annotateCurrentSpan({ "maple.source_map.swept": deleted })
				return deleted
			})

			const sweepOrphans = Effect.fn("SourceMapService.sweepOrphans")(function* (now: number) {
				const deleted = yield* sweepOrphanObjects(database, bucket, now)
				yield* Effect.annotateCurrentSpan({ "maple.source_map.orphans_swept": deleted })
				return deleted
			})

			return {
				upload,
				list,
				remove,
				sweepExpired,
				sweepOrphans,
			} satisfies SourceMapServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}

/** The hourly retention cron's entry: one sweep at the current time. */
export const runSourceMapRetention = Effect.gen(function* () {
	const database = yield* Database
	const bucket = yield* SourceMapBucket
	const now = yield* Clock.currentTimeMillis
	const deleted = yield* sweep(database, bucket, now)
	const orphans = yield* sweepOrphanObjects(database, bucket, now)
	yield* Effect.annotateCurrentSpan({
		"maple.source_map.swept": deleted,
		"maple.source_map.orphans_swept": orphans,
	})
}).pipe(
	Effect.tapCause((cause) =>
		Effect.logError("[source-maps] retention tick failed").pipe(
			Effect.annotateLogs({ error: String(cause) }),
		),
	),
	Effect.withSpan("SourceMapRetention.tick"),
)
