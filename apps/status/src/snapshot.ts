import {
	applyOverlay,
	decodeStatusPageHeartbeatJson,
	decodeStatusPageOverlayJson,
	decodeStatusPageSnapshotJson,
	pageFreshness,
	type StatusPageFreshness,
	StatusPageKeys,
	type StatusPageOverlay,
	type StatusPageSnapshot,
} from "@maple/domain/status-page"
import { Effect, Option, Result } from "effect"
import type { StatusEnv } from "./ports"

/** A cached copy younger than this is served without asking KV. */
export const CACHE_FRESH_MS = 30_000

export const cacheKey = (kind: "host" | "slug" | "snapshot", id: string): string =>
	`https://status-cache.invalid/${kind}/${encodeURIComponent(id)}`

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
): Effect.Effect<Option.Option<A>> =>
	Effect.gen(function* () {
		const { storage } = env
		const cached = yield* storage.cacheGet(input.cacheKey).pipe(Effect.orElseSucceed(() => null))
		const fromCache = decodeFound(cached?.value ?? null, input.decode)
		if (cached !== null && Option.isSome(fromCache) && env.nowMs - cached.storedAt < CACHE_FRESH_MS) {
			return Option.some(fromCache.value.value)
		}
		const remember = (found: Found<A>) =>
			storage
				.cachePut(input.cacheKey, { value: found.raw, storedAt: env.nowMs })
				.pipe(Effect.ignore, Effect.as(Option.some(found.value)))

		const kv = yield* Effect.result(storage.kvGet(input.kvKey))
		const fromKv = Result.isSuccess(kv) ? decodeFound(kv.success, input.decode) : Option.none()
		if (Option.isSome(fromKv)) return yield* remember(fromKv.value)
		if (input.kvMissIsFinal && Result.isSuccess(kv) && kv.success === null) return Option.none()

		const fromR2 =
			input.r2Key === null
				? Option.none<Found<A>>()
				: yield* storage.r2Get(input.r2Key).pipe(
						Effect.map((raw) => decodeFound(raw, input.decode)),
						Effect.orElseSucceed(() => Option.none<Found<A>>()),
					)
		if (Option.isSome(fromR2)) return yield* remember(fromR2.value)
		return Option.map(fromCache, (found) => found.value)
	})

const decodePageId = (raw: string): Option.Option<string> => {
	const id = raw.trim()
	return /^[0-9a-f-]{36}$/u.test(id) ? Option.some(id) : Option.none()
}

/** The page a hostname serves: KV `host:`, R2 `hosts/` when KV fails, then any cached answer. */
export const pageIdForHost = (env: StatusEnv, hostname: string) =>
	readThrough(env, {
		cacheKey: cacheKey("host", hostname.toLowerCase()),
		kvKey: StatusPageKeys.host(hostname),
		r2Key: StatusPageKeys.hostObject(hostname),
		kvMissIsFinal: true,
		decode: decodePageId,
	})

/** The page at `/s/<slug>`. */
export const pageIdForSlug = (env: StatusEnv, slug: string) =>
	readThrough(env, {
		cacheKey: cacheKey("slug", slug),
		kvKey: StatusPageKeys.slug(slug),
		r2Key: null,
		kvMissIsFinal: true,
		decode: decodePageId,
	})

/** The page's last published snapshot, from wherever is still answering. */
export const loadSnapshot = (env: StatusEnv, pageId: string) =>
	readThrough(env, {
		cacheKey: cacheKey("snapshot", pageId),
		kvKey: StatusPageKeys.snapshot(pageId),
		r2Key: StatusPageKeys.snapshotObject(pageId),
		kvMissIsFinal: false,
		decode: decodeStatusPageSnapshotJson,
	})

const EMPTY_OVERLAY: StatusPageOverlay = { entries: [] }

/** Break-glass entries; unreadable or corrupt reads as none. */
export const loadOverlay = (env: StatusEnv, pageId: string): Effect.Effect<StatusPageOverlay> =>
	env.storage.kvGet(StatusPageKeys.overlay(pageId)).pipe(
		Effect.map((raw) =>
			raw === null
				? EMPTY_OVERLAY
				: Option.getOrElse(decodeStatusPageOverlayJson(raw), () => EMPTY_OVERLAY),
		),
		Effect.orElseSucceed(() => EMPTY_OVERLAY),
	)

/** When the publisher last ran; null when unreadable, which makes the page say it is delayed. */
export const loadHeartbeatAt = (env: StatusEnv): Effect.Effect<number | null> =>
	env.storage.kvGet(StatusPageKeys.heartbeat).pipe(
		Effect.map((raw) =>
			raw === null
				? null
				: Option.match(decodeStatusPageHeartbeatJson(raw), {
						onNone: () => null,
						onSome: (beat) => beat.at,
					}),
		),
		Effect.orElseSucceed(() => null),
	)

export interface PageView {
	readonly snapshot: StatusPageSnapshot
	readonly freshness: StatusPageFreshness
}

/** The snapshot as visitors see it: break-glass updates applied, freshness judged. */
export const loadView = (env: StatusEnv, pageId: string): Effect.Effect<Option.Option<PageView>> =>
	Effect.gen(function* () {
		const [snapshot, overlay, heartbeatAt] = yield* Effect.all(
			[loadSnapshot(env, pageId), loadOverlay(env, pageId), loadHeartbeatAt(env)],
			{ concurrency: "unbounded" },
		)
		if (Option.isNone(snapshot)) return Option.none()
		const merged = applyOverlay(snapshot.value, overlay)
		return Option.some({
			snapshot: merged,
			freshness: pageFreshness({ snapshot: merged, heartbeatAt, nowMs: env.nowMs }),
		})
	})
