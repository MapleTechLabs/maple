import {
	applyOverlay,
	decodeStatusPageHeartbeatJson,
	decodeStatusPageOverlayEntryJson,
	decodeStatusPageSnapshotJson,
	pageFreshness,
	STATUS_PAGE_OVERLAY_MAX_ENTRIES,
	type StatusPageFreshness,
	StatusPageKeys,
	StatusPageOverlay,
	type StatusPageOverlayEntry,
	type StatusPagePublisherHeartbeat,
	type StatusPageSnapshot,
} from "@maple/domain/status-page"
import { Effect, Option, Result, Schema } from "effect"
import type { StatusEnv, StatusStorageError } from "./ports"

/** A cached copy younger than this is served without asking KV. */
export const CACHE_FRESH_MS = 30_000

/** The assembled overlay is listed at most this often per colo, so an incident spike does not list per request. */
export const OVERLAY_CACHE_FRESH_MS = 10_000

/** KV `list` can lag a write by up to a minute; a cached entry younger than this survives a list that misses it. */
const LIST_LAG_MS = 120_000

export const cacheKey = (kind: "host" | "slug" | "snapshot" | "overlay", id: string): string =>
	`https://status-cache.invalid/${kind}/${encodeURIComponent(id)}`

/** `unavailable`: KV and the fallback both errored, so a miss cannot be told apart from an outage. */
export type Lookup<A> =
	| { readonly _tag: "found"; readonly value: A }
	| { readonly _tag: "missing" }
	| { readonly _tag: "unavailable" }

const found = <A>(value: A): Lookup<A> => ({ _tag: "found", value })
const MISSING = { _tag: "missing" } as const
const UNAVAILABLE = { _tag: "unavailable" } as const

interface Found<A> {
	readonly raw: string
	readonly value: A
}

const decodeFound = <A>(
	raw: string | null,
	decode: (raw: string) => Option.Option<A>,
): Option.Option<Found<A>> =>
	raw === null ? Option.none() : Option.map(decode(raw), (value) => ({ raw, value }))

/**
 * Cache (fresh) -> KV -> R2 -> cache (any age). An undecodable value is a miss, and a value read
 * from KV or R2 refreshes the cache. With `kvMissIsFinal`, a KV `null` ends the search.
 */
const readThrough = <A>(
	env: StatusEnv,
	input: {
		readonly cacheKey: string
		readonly kvKey: string
		readonly r2Key: string | null
		readonly kvMissIsFinal: boolean
		readonly decode: (raw: string) => Option.Option<A>
	},
): Effect.Effect<Lookup<A>> =>
	Effect.gen(function* () {
		const { storage } = env
		const cached = yield* storage.cacheGet(input.cacheKey).pipe(Effect.orElseSucceed(() => null))
		const fromCache = decodeFound(cached?.value ?? null, input.decode)
		if (cached !== null && Option.isSome(fromCache) && env.nowMs - cached.storedAt < CACHE_FRESH_MS) {
			return found(fromCache.value.value)
		}
		const remember = (hit: Found<A>) =>
			storage
				.cachePut(input.cacheKey, { value: hit.raw, storedAt: env.nowMs })
				.pipe(Effect.ignore, Effect.as(found(hit.value)))

		const kv = yield* Effect.result(storage.kvGet(input.kvKey))
		const fromKv = Result.isSuccess(kv) ? decodeFound(kv.success, input.decode) : Option.none()
		if (Option.isSome(fromKv)) return yield* remember(fromKv.value)
		if (input.kvMissIsFinal && Result.isSuccess(kv) && kv.success === null) return MISSING

		const r2 = input.r2Key === null ? null : yield* Effect.result(storage.r2Get(input.r2Key))
		const fromR2 =
			r2 !== null && Result.isSuccess(r2) ? decodeFound(r2.success, input.decode) : Option.none()
		if (Option.isSome(fromR2)) return yield* remember(fromR2.value)
		if (Option.isSome(fromCache)) return found(fromCache.value.value)
		const r2Failed = r2 === null || Result.isFailure(r2)
		return Result.isFailure(kv) && r2Failed ? UNAVAILABLE : MISSING
	})

const decodePageId = (raw: string): Option.Option<string> => {
	const id = raw.trim()
	return /^[0-9a-f-]{36}$/u.test(id) ? Option.some(id) : Option.none()
}

/** The page a hostname serves: KV `host:`, R2 `hosts/` when KV fails, then any cached answer. */
export const pageIdForHost = (env: StatusEnv, hostname: string): Effect.Effect<Lookup<string>> =>
	readThrough(env, {
		cacheKey: cacheKey("host", hostname.toLowerCase()),
		kvKey: StatusPageKeys.host(hostname),
		r2Key: StatusPageKeys.hostObject(hostname),
		kvMissIsFinal: true,
		decode: decodePageId,
	})

/** The page at `/s/<slug>`: KV `slug:`, R2 `slugs/` when KV fails, then any cached answer. */
export const pageIdForSlug = (env: StatusEnv, slug: string): Effect.Effect<Lookup<string>> =>
	readThrough(env, {
		cacheKey: cacheKey("slug", slug),
		kvKey: StatusPageKeys.slug(slug),
		r2Key: StatusPageKeys.slugObject(slug),
		kvMissIsFinal: true,
		decode: decodePageId,
	})

/** The page's last published snapshot, from wherever is still answering. */
export const loadSnapshot = (
	env: StatusEnv,
	pageId: string,
): Effect.Effect<Option.Option<StatusPageSnapshot>> =>
	readThrough(env, {
		cacheKey: cacheKey("snapshot", pageId),
		kvKey: StatusPageKeys.snapshot(pageId),
		r2Key: StatusPageKeys.snapshotObject(pageId),
		kvMissIsFinal: false,
		decode: decodeStatusPageSnapshotJson,
	}).pipe(Effect.map((lookup) => (lookup._tag === "found" ? Option.some(lookup.value) : Option.none())))

const decodeOverlayJson = Schema.decodeUnknownOption(Schema.fromJsonString(StatusPageOverlay))

export interface ListedOverlay {
	/** Every listed key, decodable or not: the entry cap counts these. */
	readonly keys: ReadonlyArray<string>
	readonly entries: ReadonlyArray<StatusPageOverlayEntry>
}

/** Lists the page's entry keys and reads each; a key gone or corrupt since the list is skipped. */
export const listOverlay = (
	env: StatusEnv,
	pageId: string,
): Effect.Effect<ListedOverlay, StatusStorageError> =>
	env.storage
		.kvList(StatusPageKeys.overlayPage(pageId), STATUS_PAGE_OVERLAY_MAX_ENTRIES)
		.pipe(
			Effect.flatMap((keys) =>
				Effect.forEach(
					keys,
					(key) =>
						env.storage
							.kvGet(key)
							.pipe(
								Effect.map((raw) =>
									raw === null ? [] : Option.toArray(decodeStatusPageOverlayEntryJson(raw)),
								),
							),
					{ concurrency: 10 },
				).pipe(Effect.map((lists) => ({ keys, entries: lists.flat() }))),
			),
		)

const readCachedOverlay = (env: StatusEnv, pageId: string) =>
	env.storage.cacheGet(cacheKey("overlay", pageId)).pipe(
		Effect.map((cached) =>
			cached === null
				? Option.none()
				: Option.map(decodeOverlayJson(cached.value), (overlay) => ({
						overlay,
						storedAt: cached.storedAt,
					})),
		),
		Effect.orElseSucceed(() => Option.none()),
	)

/** Caches the assembled overlay, keeping cached entries a lagging list has not caught up with yet. */
export const rememberOverlay = (
	env: StatusEnv,
	pageId: string,
	entries: ReadonlyArray<StatusPageOverlayEntry>,
	previous: ReadonlyArray<StatusPageOverlayEntry> = [],
): Effect.Effect<StatusPageOverlay> => {
	const listed = new Set(entries.map((entry) => entry.id))
	const recent = previous.filter((entry) => !listed.has(entry.id) && env.nowMs - entry.at < LIST_LAG_MS)
	const overlay: StatusPageOverlay = { entries: [...entries, ...recent] }
	return env.storage
		.cachePut(cacheKey("overlay", pageId), { value: JSON.stringify(overlay), storedAt: env.nowMs })
		.pipe(Effect.ignore, Effect.as(overlay))
}

/** Break-glass entries, listed at most every 10s per colo; a failed list serves the cached copy, else none. */
export const loadOverlay = (env: StatusEnv, pageId: string): Effect.Effect<StatusPageOverlay> =>
	Effect.gen(function* () {
		const cached = yield* readCachedOverlay(env, pageId)
		if (Option.isSome(cached) && env.nowMs - cached.value.storedAt < OVERLAY_CACHE_FRESH_MS) {
			return cached.value.overlay
		}
		const previous = Option.match(cached, { onNone: () => [], onSome: (hit) => hit.overlay.entries })
		return yield* listOverlay(env, pageId).pipe(
			Effect.flatMap((listed) => rememberOverlay(env, pageId, listed.entries, previous)),
			Effect.orElseSucceed(() => ({ entries: previous })),
		)
	})

/** The publisher's last sweep; null when unreadable, which makes the page say it is delayed. */
export const loadHeartbeat = (env: StatusEnv): Effect.Effect<StatusPagePublisherHeartbeat | null> =>
	env.storage.kvGet(StatusPageKeys.heartbeat).pipe(
		Effect.map((raw) => (raw === null ? null : Option.getOrNull(decodeStatusPageHeartbeatJson(raw)))),
		Effect.orElseSucceed(() => null),
	)

export interface PageView {
	readonly snapshot: StatusPageSnapshot
	readonly freshness: StatusPageFreshness
}

/** The snapshot as visitors see it: break-glass updates applied, freshness judged. */
export const loadView = (env: StatusEnv, pageId: string): Effect.Effect<Option.Option<PageView>> =>
	Effect.gen(function* () {
		const [snapshot, overlay, heartbeat] = yield* Effect.all(
			[loadSnapshot(env, pageId), loadOverlay(env, pageId), loadHeartbeat(env)],
			{ concurrency: "unbounded" },
		)
		if (Option.isNone(snapshot)) return Option.none()
		const merged = applyOverlay(snapshot.value, overlay)
		return Option.some({
			snapshot: merged,
			freshness: pageFreshness({ snapshot: merged, heartbeat, nowMs: env.nowMs }),
		})
	})
