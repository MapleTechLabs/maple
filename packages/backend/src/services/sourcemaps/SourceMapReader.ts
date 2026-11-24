import * as PG from "@maple-dev/effect-orm/postgres"
import { SourceMapFiles, type SourceMapFileRow } from "@maple/db/tables"
import { SourceMapStorageError } from "@maple/domain/http"
import type { OrgId, SourceMapFileId } from "@maple/primitives"
import { Array as Arr, Clock, Context, Duration, Effect, Layer, Option, String as Str } from "effect"
import { type ObjectStoreError, SourceMapReadBucket } from "@maple/backend/platform/bindings"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { describeCause } from "@maple/backend/platform/describe-cause"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { matchFrames } from "./source-map-files"

/** `last_used_at` is written at most this often per file. */
const TOUCH_INTERVAL = Duration.days(1)
const RELEASE_FILES_LIMIT = 2000

export interface SourceMapFrameLookup {
	readonly orgId: OrgId
	/** Frame URL to the debug id the SDK recorded for it (`maple.exception.debug_ids`). */
	readonly debugIds: ReadonlyMap<string, string>
	readonly serviceName: string | null | undefined
	readonly version: string | null | undefined
	readonly urls: ReadonlyArray<string>
}

/** What symbolication needs: finding and reading stored maps. Writes only `last_used_at`. */
export interface SourceMapReaderApi {
	/** Whether the org has stored any source map. */
	readonly hasAny: (orgId: OrgId) => Effect.Effect<boolean, SourceMapStorageError>
	/** The stored file for each frame URL that has one: debug id first, then service + version + path. */
	readonly findForFrames: (
		lookup: SourceMapFrameLookup,
	) => Effect.Effect<ReadonlyMap<string, SourceMapFileRow>, SourceMapStorageError>
	/** The map JSON, or `None` when its object is gone. */
	readonly load: (row: SourceMapFileRow) => Effect.Effect<Option.Option<string>, SourceMapStorageError>
	/** Marks files used now, at most once a day each, which keeps them from expiring. */
	readonly touch: (
		orgId: OrgId,
		ids: ReadonlyArray<SourceMapFileId>,
	) => Effect.Effect<void, SourceMapStorageError>
}

export const toSourceMapStorageError = (error: DatabaseError | ObjectStoreError) =>
	new SourceMapStorageError({
		message: error.message,
		...(describeCause(error.cause) === undefined ? undefined : { cause: describeCause(error.cause) }),
	})

export class SourceMapReader extends Context.Service<SourceMapReader, SourceMapReaderApi>()(
	"@maple/backend/services/sourcemaps/SourceMapReader",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const bucket = yield* SourceMapReadBucket
			const dbExecute = makeDbExecute(database, "SourceMapReader", toSourceMapStorageError)

			const hasAny = Effect.fn("SourceMapReader.hasAny")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(SourceMapFiles)
							.select("id")
							.where(($) => [$.orgId.eq(orgId)])
							.limit(1),
					),
				)
				return rows.length > 0
			})

			const findForFrames = Effect.fn("SourceMapReader.findForFrames")(function* (
				lookup: SourceMapFrameLookup,
			) {
				const { orgId, serviceName, version } = lookup
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.source_map.frame_urls": lookup.urls.length,
				})
				const debugIds = Arr.dedupe(
					Arr.map(
						Arr.filter(Array.from(lookup.debugIds.values()), (id) => id.length > 0),
						Str.toLowerCase,
					),
				)
				const byDebugId =
					debugIds.length === 0
						? []
						: yield* dbExecute((db) =>
								db.run(
									PG.from(SourceMapFiles)
										.select()
										.where(($) => [$.orgId.eq(orgId), $.debugId.in_(...debugIds)]),
								),
							)
				const releaseFiles =
					serviceName == null || version == null || serviceName === "" || version === ""
						? []
						: yield* dbExecute((db) =>
								db.run(
									PG.from(SourceMapFiles)
										.select()
										.where(($) => [
											$.orgId.eq(orgId),
											$.serviceName.eq(serviceName),
											$.version.eq(version),
										])
										.limit(RELEASE_FILES_LIMIT),
								),
							)
				const matches = matchFrames(lookup.urls, lookup.debugIds, byDebugId, releaseFiles)
				yield* Effect.annotateCurrentSpan({ "maple.source_map.matched": matches.size })
				return matches
			})

			const load = Effect.fn("SourceMapReader.load")(function* (row: SourceMapFileRow) {
				yield* Effect.annotateCurrentSpan({ orgId: row.orgId, "maple.source_map.id": row.id })
				const bytes = yield* bucket
					.getBytes(row.objectKey)
					.pipe(Effect.mapError(toSourceMapStorageError))
				return Option.map(bytes, (value) => new TextDecoder().decode(value))
			})

			const touch = Effect.fn("SourceMapReader.touch")(function* (
				orgId: OrgId,
				ids: ReadonlyArray<SourceMapFileId>,
			) {
				if (ids.length === 0) return
				const now = yield* Clock.currentTimeMillis
				const staleBefore = now - Duration.toMillis(TOUCH_INTERVAL)
				yield* dbExecute((db) =>
					db.run(
						PG.update(SourceMapFiles)
							.set({ lastUsedAt: now })
							.where(($) => [
								$.orgId.eq(orgId),
								PG.inList($.id, Arr.dedupe(ids)),
								PG.or($.lastUsedAt.isNull(), $.lastUsedAt.lt(staleBefore)),
							]),
					),
				)
			})

			return { hasAny, findForFrames, load, touch } satisfies SourceMapReaderApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
