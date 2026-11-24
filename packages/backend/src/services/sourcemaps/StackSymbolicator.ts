import { TraceMap } from "@jridgewell/trace-mapping"
import type { SourceMapFileRow } from "@maple/db/tables"
import { SOURCE_MAP_MAX_BYTES } from "@maple/domain/http"
import { parseJsStack, type SymbolicatedStack } from "@maple/domain/errors/js-stack"
import type { OrgId, SourceMapFileId } from "@maple/primitives"
import { Array as Arr, Clock, Context, Deferred, Duration, Effect, Exit, Layer, Option } from "effect"
import { isLookupUrl } from "./source-map-files"
import { SourceMapReader } from "./SourceMapReader"
import { symbolicateStack } from "./symbolicate"

/**
 * Larger maps are not loaded: parsing one costs several times its size in a 128 MB isolate. Uploads
 * are capped at the same size; this only guards maps stored before the cap.
 */
export const SYMBOLICATION_MAX_MAP_BYTES = SOURCE_MAP_MAX_BYTES
/** A parsed map's heap, estimated from its file size (decoded mappings plus the parsed JSON). */
export const PARSED_MAP_SIZE_FACTOR = 6
/** Parsed maps kept per isolate: at most this many, and this much estimated heap. */
const MAP_CACHE_MAX_ENTRIES = 8
const MAP_CACHE_MAX_ESTIMATED_BYTES = 40 * 1024 * 1024
/** How long a frame URL with no stored map is not looked up again; short, so a late upload shows soon. */
const NEGATIVE_TTL = Duration.minutes(5)
const NEGATIVE_MAX_ENTRIES = 10_000
/** `last_used_at` is asked for at most this often per file from one isolate. */
const TOUCH_INTERVAL = Duration.hours(1)
const TOUCHED_MAX_ENTRIES = 10_000
/**
 * Estimated heap of the parsed maps one request holds at once. The first map always loads (one map
 * at the upload cap is 60 MiB by estimate); later ones load only while the total stays under this.
 */
export const REQUEST_MAX_ESTIMATED_BYTES = 64 * 1024 * 1024
/** How long one isolate trusts its answer to "does this org have any maps"; short, so a first upload shows soon. */
const HAS_MAPS_TTL = Duration.minutes(1)
const HAS_MAPS_MAX_ENTRIES = 10_000

export interface SymbolicateRequest {
	readonly orgId: OrgId
	readonly stacktrace: string
	readonly serviceName: string | null
	readonly serviceVersion: string | null
	/** Frame URL to debug id, from the exception event's `maple.exception.debug_ids`. */
	readonly debugIds: ReadonlyMap<string, string>
	/**
	 * Shared by the stacks of one batch (an errors tick): a URL's match is looked up once for all of
	 * them. Absent, every stack looks up its own.
	 */
	readonly lookupMemo?: Map<string, SourceMapFileRow>
}

export interface SymbolicationOutcome {
	readonly stack: SymbolicatedStack
	/** A source map lookup or a map read failed; frames it would have mapped stay unresolved. */
	readonly lookupFailed: boolean
}

interface LoadedMap {
	readonly map: Option.Option<TraceMap>
	readonly cacheHit: boolean
	/** The bucket read failed or the object was gone (an unparseable map is not a failure). */
	readonly failed: boolean
}

/** What waiters on a load that was interrupted get: no map, counted as a failed read. */
const UNREAD_MAP: LoadedMap = { map: Option.none(), cacheHit: false, failed: true }

export interface StackSymbolicatorApi {
	/** Maps a stack through the org's source maps. Never fails: a frame whose map cannot be read stays unresolved. */
	readonly symbolicate: (request: SymbolicateRequest) => Effect.Effect<SymbolicatedStack>
	/** The same, saying whether a lookup or a map read failed (so a missing frame may yet map). */
	readonly symbolicateWithOutcome: (request: SymbolicateRequest) => Effect.Effect<SymbolicationOutcome>
	/** Whether the org has stored any source map, cached briefly per isolate; true when unknown. */
	readonly hasSourceMaps: (orgId: OrgId) => Effect.Effect<boolean>
	/** The same, `None` when the lookup failed, for callers that must not guess. */
	readonly sourceMapsKnown: (orgId: OrgId) => Effect.Effect<Option.Option<boolean>>
}

interface CachedMap {
	readonly map: TraceMap
	/** Estimated heap of the parsed map. */
	readonly bytes: number
}

const parseTraceMap = Option.liftThrowable((json: string) => new TraceMap(json))

/** The stack with every frame unresolved, for when nothing could be looked up. */
const unresolvedStack = (stacktrace: string, debugIds?: ReadonlyMap<string, string>): SymbolicatedStack =>
	symbolicateStack(stacktrace, () => undefined, debugIds)

const notApplicable = (stacktrace: string): SymbolicatedStack => ({
	...unresolvedStack(stacktrace),
	status: "not_applicable",
	missing: [],
})

export class StackSymbolicator extends Context.Service<StackSymbolicator, StackSymbolicatorApi>()(
	"@maple/backend/services/sourcemaps/StackSymbolicator",
	{
		make: Effect.gen(function* () {
			const sourceMaps = yield* SourceMapReader
			// Insertion order is recency: a hit is re-inserted, eviction takes the oldest.
			const maps = new Map<SourceMapFileId, CachedMap>()
			let cachedBytes = 0
			const noMapUntil = new Map<string, number>()
			const touchedAt = new Map<SourceMapFileId, number>()
			const inflight = new Map<SourceMapFileId, Deferred.Deferred<LoadedMap>>()
			const hasMapsAt = new Map<OrgId, { readonly value: boolean; readonly until: number }>()

			const sourceMapsKnown = Effect.fn("StackSymbolicator.sourceMapsKnown")(function* (orgId: OrgId) {
				const now = yield* Clock.currentTimeMillis
				const cached = hasMapsAt.get(orgId)
				if (cached !== undefined && cached.until > now) return Option.some(cached.value)
				const value = yield* sourceMaps.hasAny(orgId).pipe(
					Effect.tapError((error) =>
						Effect.logWarning("Whether the org has source maps could not be read").pipe(
							Effect.annotateLogs({ orgId, message: error.message }),
						),
					),
					Effect.option,
				)
				if (Option.isNone(value)) return Option.none<boolean>()
				hasMapsAt.delete(orgId)
				hasMapsAt.set(orgId, { value: value.value, until: now + Duration.toMillis(HAS_MAPS_TTL) })
				if (hasMapsAt.size > HAS_MAPS_MAX_ENTRIES) {
					Arr.forEach(
						Arr.take(Array.from(hasMapsAt.keys()), hasMapsAt.size - HAS_MAPS_MAX_ENTRIES),
						(key) => hasMapsAt.delete(key),
					)
				}
				return Option.some(value.value)
			})

			// Unknown counts as yes: a failed check must not hide maps the lookup can still find.
			const hasSourceMaps = (orgId: OrgId) =>
				Effect.map(
					sourceMapsKnown(orgId),
					Option.getOrElse(() => true),
				)

			const cacheGet = (id: SourceMapFileId): CachedMap | undefined => {
				const hit = maps.get(id)
				if (hit !== undefined) {
					maps.delete(id)
					maps.set(id, hit)
				}
				return hit
			}

			const cachePut = (id: SourceMapFileId, entry: CachedMap) => {
				// A map over the budget is kept only alone, so it parses once per isolate, not per stack;
				// the next map put evicts it, oldest first.
				if (entry.bytes > MAP_CACHE_MAX_ESTIMATED_BYTES) {
					maps.clear()
					maps.set(id, entry)
					cachedBytes = entry.bytes
					return
				}
				const previous = maps.get(id)
				if (previous !== undefined) {
					maps.delete(id)
					cachedBytes -= previous.bytes
				}
				maps.set(id, entry)
				cachedBytes += entry.bytes
				Arr.forEach(Array.from(maps.keys()), (key) => {
					if (cachedBytes <= MAP_CACHE_MAX_ESTIMATED_BYTES && maps.size <= MAP_CACHE_MAX_ENTRIES)
						return
					const evicted = maps.get(key)
					maps.delete(key)
					cachedBytes -= evicted?.bytes ?? 0
				})
			}

			const negativeKey = (request: SymbolicateRequest, url: string) =>
				Arr.join(
					[
						request.orgId,
						request.debugIds.get(url) ?? "",
						request.serviceName ?? "",
						request.serviceVersion ?? "",
						url,
					],
					"\u0000",
				)

			const markNoMap = (keys: ReadonlyArray<string>, now: number) => {
				const until = now + Duration.toMillis(NEGATIVE_TTL)
				Arr.forEach(keys, (key) => {
					noMapUntil.delete(key)
					noMapUntil.set(key, until)
				})
				const excess = noMapUntil.size - NEGATIVE_MAX_ENTRIES
				if (excess > 0) {
					Arr.forEach(Arr.take(Array.from(noMapUntil.keys()), excess), (key) =>
						noMapUntil.delete(key),
					)
				}
			}

			const knownMissing = (key: string, now: number): boolean => {
				const until = noMapUntil.get(key)
				if (until === undefined) return false
				if (until > now) return true
				noMapUntil.delete(key)
				return false
			}

			/** Reads and parses one stored file; `None` when it is gone or unreadable. */
			const loadMap = (row: SourceMapFileRow): Effect.Effect<LoadedMap> =>
				Effect.gen(function* () {
					const json = yield* sourceMaps.load(row).pipe(
						Effect.tapError((error) =>
							Effect.logWarning("Source map could not be loaded").pipe(
								Effect.annotateLogs({
									orgId: row.orgId,
									sourceMapId: row.id,
									message: error.message,
								}),
							),
						),
						Effect.option,
					)
					if (Option.isNone(json)) return { map: Option.none(), cacheHit: false, failed: true }
					// A matched row whose object is gone was replaced or deleted mid-request: as unknown
					// as a failed read, so a key is not recomputed from the stack's other frames.
					if (Option.isNone(json.value))
						return { map: Option.none(), cacheHit: false, failed: true }
					const parsed = Option.flatMap(json.value, parseTraceMap)
					if (Option.isSome(json.value) && Option.isNone(parsed)) {
						yield* Effect.logWarning("Source map could not be parsed").pipe(
							Effect.annotateLogs({ orgId: row.orgId, sourceMapId: row.id }),
						)
					}
					if (Option.isSome(parsed))
						cachePut(row.id, {
							map: parsed.value,
							bytes: row.sizeBytes * PARSED_MAP_SIZE_FACTOR,
						})
					return { map: parsed, cacheHit: false, failed: false }
				})

			/** The parsed map of one stored file; concurrent calls for one file share a single load. */
			const mapOf = (row: SourceMapFileRow): Effect.Effect<LoadedMap> =>
				// Uninterruptible from the check to the finalizer: an interrupt in between would leave
				// a Deferred no one completes. The load itself stays interruptible.
				Effect.uninterruptibleMask((restore) => {
					const hit = cacheGet(row.id)
					if (hit !== undefined) {
						return Effect.succeed({ map: Option.some(hit.map), cacheHit: true, failed: false })
					}
					const running = inflight.get(row.id)
					if (running !== undefined) {
						return Effect.map(restore(Deferred.await(running)), (loaded) => ({
							...loaded,
							cacheHit: true,
						}))
					}
					const deferred = Deferred.makeUnsafe<LoadedMap>()
					inflight.set(row.id, deferred)
					return restore(loadMap(row)).pipe(
						Effect.onExit((exit) =>
							Effect.andThen(
								Effect.sync(() => inflight.delete(row.id)),
								// An interrupted load leaves its waiters unresolved, never failed.
								Deferred.succeed(deferred, Exit.isSuccess(exit) ? exit.value : UNREAD_MAP),
							),
						),
					)
				})

			const touchUsed = (orgId: OrgId, ids: ReadonlyArray<SourceMapFileId>, now: number) => {
				const due = Arr.filter(
					ids,
					(id) =>
						now - (touchedAt.get(id) ?? Number.NEGATIVE_INFINITY) >=
						Duration.toMillis(TOUCH_INTERVAL),
				)
				if (due.length === 0) return Effect.void
				return sourceMaps.touch(orgId, due).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							Arr.forEach(due, (id) => {
								touchedAt.delete(id)
								touchedAt.set(id, now)
							})
							// Oldest first: a forgotten file costs one more conditional update, nothing else.
							const excess = touchedAt.size - TOUCHED_MAX_ENTRIES
							if (excess > 0) {
								Arr.forEach(Arr.take(Array.from(touchedAt.keys()), excess), (id) =>
									touchedAt.delete(id),
								)
							}
						}),
					),
					Effect.catch((error) =>
						Effect.logWarning("Source map use was not recorded").pipe(
							Effect.annotateLogs({ orgId, message: error.message }),
						),
					),
				)
			}

			const symbolicateWithOutcome = Effect.fn("StackSymbolicator.symbolicate")(function* (
				request: SymbolicateRequest,
			) {
				const { orgId, stacktrace } = request
				const parsed = parseJsStack(stacktrace)
				const urls = Arr.dedupe(
					Arr.filter(
						Arr.getSomes(Arr.map(parsed.frames, (frame) => Option.fromNullishOr(frame.url))),
						(url) => isLookupUrl(url, request.debugIds),
					),
				)
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.stack.frames": parsed.frames.length,
					"maple.stack.js_urls": urls.length,
				})
				if (urls.length === 0) {
					yield* Effect.annotateCurrentSpan({ "maple.stack.status": "not_applicable" })
					return {
						stack: notApplicable(stacktrace),
						lookupFailed: false,
					} satisfies SymbolicationOutcome
				}

				if (!(yield* hasSourceMaps(orgId))) {
					const result = unresolvedStack(stacktrace, request.debugIds)
					yield* Effect.annotateCurrentSpan({
						"maple.stack.status": result.status,
						"maple.stack.org_has_maps": false,
					})
					return { stack: result, lookupFailed: false } satisfies SymbolicationOutcome
				}

				const now = yield* Clock.currentTimeMillis
				// Matches an earlier stack of the same batch found; never kept past the batch, so a map
				// replaced since is looked up afresh by the next one.
				const memo = request.lookupMemo
				const remembered = new Map(
					Arr.flatMap(urls, (url) => {
						const row = memo?.get(negativeKey(request, url))
						return row === undefined ? [] : [[url, row] as const]
					}),
				)
				const pending = Arr.filter(
					urls,
					(url) => !remembered.has(url) && !knownMissing(negativeKey(request, url), now),
				)
				const found =
					pending.length === 0
						? Option.some(new Map<string, SourceMapFileRow>())
						: yield* sourceMaps
								.findForFrames({
									orgId,
									debugIds: request.debugIds,
									serviceName: request.serviceName,
									version: request.serviceVersion,
									urls: pending,
								})
								.pipe(
									Effect.map((rows): ReadonlyMap<string, SourceMapFileRow> => rows),
									Effect.tapError((error) =>
										Effect.all([
											Effect.logWarning("Source maps could not be looked up").pipe(
												Effect.annotateLogs({ orgId, message: error.message }),
											),
											Effect.annotateCurrentSpan({ "maple.stack.lookup_failed": true }),
										]),
									),
									Effect.option,
								)
				const looked = Option.getOrElse(found, () => new Map<string, SourceMapFileRow>())
				const rowsByUrl = new Map([...remembered, ...looked])
				// Only a lookup that answered can say a URL has no map.
				if (Option.isSome(found)) {
					Arr.forEach(Array.from(looked), ([url, row]) => memo?.set(negativeKey(request, url), row))
					markNoMap(
						Arr.map(
							Arr.filter(pending, (url) => !rowsByUrl.has(url)),
							(url) => negativeKey(request, url),
						),
						now,
					)
				}

				const matched = Arr.dedupeWith(Array.from(rowsByUrl.values()), (a, b) => a.id === b.id)
				const tooLarge = Arr.filter(matched, (row) => row.sizeBytes > SYMBOLICATION_MAX_MAP_BYTES)
				const rows = Arr.filter(matched, (row) => row.sizeBytes <= SYMBOLICATION_MAX_MAP_BYTES)
				if (tooLarge.length > 0) {
					yield* Effect.logWarning("Source maps too large to symbolicate with were skipped").pipe(
						Effect.annotateLogs({
							orgId,
							sourceMapIds: Arr.join(
								Arr.map(tooLarge, (row) => row.id),
								",",
							),
							limitBytes: SYMBOLICATION_MAX_MAP_BYTES,
						}),
					)
				}
				// One at a time: each parse briefly holds the file, its string and the parsed map. Every
				// loaded map stays live for the request, so past the budget the rest are left unloaded.
				const estimate = (row: SourceMapFileRow) => row.sizeBytes * PARSED_MAP_SIZE_FACTOR
				// Only rows taken count toward the budget: one left out does not crowd out a later small one.
				const withinBudget = Arr.reduce(
					rows,
					{ taken: Arr.empty<SourceMapFileRow>(), planned: 0 },
					(plan, row) =>
						plan.taken.length === 0 || plan.planned + estimate(row) <= REQUEST_MAX_ESTIMATED_BYTES
							? { taken: [...plan.taken, row], planned: plan.planned + estimate(row) }
							: plan,
				).taken
				const overBudget = rows.length - withinBudget.length
				if (overBudget > 0) {
					yield* Effect.logWarning(
						"Source maps over the per-stack memory budget were not loaded",
					).pipe(Effect.annotateLogs({ orgId, skipped: overBudget }))
				}
				const loaded = yield* Effect.forEach(withinBudget, (row) =>
					Effect.map(mapOf(row), (result) => ({ row, ...result })),
				)
				// A map that could not be read is looked up again by the next stack, not reused.
				if (memo !== undefined) {
					const failed = new Set(
						Arr.map(
							Arr.filter(loaded, (entry) => entry.failed),
							(entry) => entry.row.id,
						),
					)
					Arr.forEach(Array.from(memo), ([key, row]) => {
						if (failed.has(row.id)) memo.delete(key)
					})
				}
				const mapByFile = new Map(
					Arr.getSomes(
						Arr.map(loaded, ({ row, map }) =>
							Option.map(map, (value) => [row.id, value] as const),
						),
					),
				)
				const lookup = (url: string): TraceMap | undefined => {
					const row = rowsByUrl.get(url)
					return row === undefined ? undefined : mapByFile.get(row.id)
				}

				const symbolicated = Option.liftThrowable(() =>
					symbolicateStack(
						stacktrace,
						(frame) => (frame.url === null ? undefined : lookup(frame.url)),
						request.debugIds,
					),
				)()
				if (Option.isNone(symbolicated)) {
					yield* Effect.logWarning("Stack could not be symbolicated").pipe(
						Effect.annotateLogs({ orgId }),
					)
				}
				const result = Option.getOrElse(symbolicated, () =>
					unresolvedStack(stacktrace, request.debugIds),
				)

				// Only a map that resolved a frame counts as used; frames line up with the parsed ones.
				const usedIds = Arr.dedupe(
					Arr.flatMap(result.frames, (frame, i) => {
						const url = parsed.frames[i]?.url ?? null
						const row = frame.resolved && url !== null ? rowsByUrl.get(url) : undefined
						return row !== undefined && mapByFile.has(row.id) ? [row.id] : []
					}),
				)
				yield* touchUsed(orgId, usedIds, now)
				yield* Effect.annotateCurrentSpan({
					"maple.stack.status": result.status,
					"maple.stack.resolved_frames": Arr.filter(result.frames, (frame) => frame.resolved)
						.length,
					"maple.stack.maps_matched": matched.length,
					"maple.stack.maps_too_large": tooLarge.length,
					"maple.stack.maps_over_budget": overBudget,
					"maple.stack.maps_loaded": Arr.filter(loaded, (entry) => !entry.cacheHit).length,
					"maple.stack.map_cache_hits": Arr.filter(loaded, (entry) => entry.cacheHit).length,
					"maple.stack.negative_cache_hits": urls.length - pending.length,
				})
				return {
					stack: result,
					lookupFailed: Option.isNone(found) || Arr.some(loaded, (entry) => entry.failed),
				} satisfies SymbolicationOutcome
			})

			const symbolicate = (request: SymbolicateRequest) =>
				Effect.map(symbolicateWithOutcome(request), (outcome) => outcome.stack)

			return {
				symbolicate,
				symbolicateWithOutcome,
				hasSourceMaps,
				sourceMapsKnown,
			} satisfies StackSymbolicatorApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(SourceMapReader.layer))
}
