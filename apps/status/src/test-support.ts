import {
	decodeStatusPageOverlayEntryJson,
	STATUS_PAGE_TOMBSTONE,
	StatusPageKeys,
	type StatusPageOverlayEntry,
	type StatusPagePublisherHeartbeat,
	type StatusPageSnapshot,
} from "@maple/domain/status-page"
import { FIXTURE_NOW, FIXTURE_PAGE_ID } from "@maple/status-page/fixtures"
import { Effect, Option, Schema, Array as Arr, String as Str } from "effect"
import { handleRequest, sharedHostMatcher } from "./handler"
import { type CachedValue, type StatusEnv, type StatusStorage, StatusStorageError } from "./ports"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** In-memory KV, R2, colo cache and rate limiter; each store can be made to fail. */
interface ListHook {
	run: (() => void) | null
}

export const makeFakeStorage = () => {
	const kv = new Map<string, string>()
	const r2 = new Map<string, string>()
	const cache = new Map<string, CachedValue>()
	const failing = new Set<"kv" | "kv-put" | "r2" | "cache">()
	const limits = { allow: true, keys: new Array<string>() }
	const pageLimits = { allow: true, keys: new Array<string>() }
	// Makes either limiter throw, as a binding that is down does.
	const limiterDown = new Set<"client" | "page">()
	const limit = (which: "client" | "page", state: typeof limits, key: string) =>
		limiterDown.has(which)
			? Effect.fail(new StatusStorageError({ message: "unavailable", store: "rate-limit", key }))
			: Effect.sync(() => {
					state.keys.push(key)
					return state.allow
				})

	const guard = <A>(store: "kv" | "kv-put" | "r2" | "cache", key: string, value: () => A) =>
		failing.has(store)
			? Effect.fail(
					new StatusStorageError({
						message: "unavailable",
						store: store === "kv-put" ? "kv" : store,
						key,
					}),
				)
			: Effect.sync(value)

	// Keys a lagging KV `list` has not returned yet; reads by key still see them.
	const unlisted = new Set<string>()
	// Runs once inside the next `list`, to land a concurrent write while it is in flight.
	const duringList: ListHook = { run: null }
	// Every key a KV `get` asked for, in order.
	const kvReads = new Array<string>()
	const storage: StatusStorage = {
		kvGet: (key) =>
			guard("kv", key, () => {
				kvReads.push(key)
				return kv.get(key) ?? null
			}),
		kvPut: (key, value) => guard("kv-put", key, () => void kv.set(key, value)),
		kvList: (prefix, limit) =>
			guard("kv", prefix, () => {
				const listed = Arr.filter(
					[...kv.keys()],
					(key) => Str.startsWith(prefix)(key) && !unlisted.has(key),
				)
					.sort()
					.slice(0, limit)
				const raced = duringList.run
				duringList.run = null
				raced?.()
				return listed
			}),
		r2Get: (key) => guard("r2", key, () => r2.get(key) ?? null),
		cacheGet: (key) => guard("cache", key, () => cache.get(key) ?? null),
		cachePut: (key, entry) => guard("cache", key, () => void cache.set(key, entry)),
		rateLimit: (key) => limit("client", limits, key),
		pageRateLimit: (key) => limit("page", pageLimits, key),
	}
	// Shared across requests, so two posts get distinct entry ids.
	const ids = { next: 0 }
	return {
		storage,
		kv,
		kvReads,
		r2,
		cache,
		failing,
		limits,
		pageLimits,
		limiterDown,
		unlisted,
		duringList,
		ids,
	}
}

export type FakeStorage = ReturnType<typeof makeFakeStorage>

/** The `/s/` address the publisher routes a snapshot's page at. */
export const addressOf = (snapshot: StatusPageSnapshot): string =>
	`${snapshot.page.orgKey}/${snapshot.page.slug}`

/** Publishes a snapshot the way the publisher does: host and slug keys, KV and R2 copies, heartbeat. */
export const publish = (
	fake: FakeStorage,
	snapshot: StatusPageSnapshot,
	options: { readonly host?: string; readonly heartbeatAt?: number | null } = {},
) => {
	const json = encodeJson(snapshot)
	const host = options.host ?? "status.acme.example"
	fake.kv.set(StatusPageKeys.host(host), snapshot.pageId)
	fake.kv.set(StatusPageKeys.slug(addressOf(snapshot)), snapshot.pageId)
	fake.kv.set(StatusPageKeys.snapshot(snapshot.pageId), json)
	fake.r2.set(StatusPageKeys.snapshotObject(snapshot.pageId), json)
	fake.r2.set(StatusPageKeys.hostObject(host), snapshot.pageId)
	fake.r2.set(StatusPageKeys.slugObject(addressOf(snapshot)), snapshot.pageId)
	const heartbeatAt = options.heartbeatAt === undefined ? FIXTURE_NOW : options.heartbeatAt
	if (heartbeatAt !== null) {
		const heartbeat: StatusPagePublisherHeartbeat = {
			at: heartbeatAt,
			probesSeenAt: heartbeatAt - 30_000,
		}
		fake.kv.set(StatusPageKeys.heartbeat, encodeJson(heartbeat))
	}
}

/** Takes a page off the edge the way the publisher does: KV keys gone, a tombstone in R2 for each. */
export const takeOffEdge = (fake: FakeStorage, snapshot: StatusPageSnapshot) => {
	fake.r2.set(StatusPageKeys.slugObject(addressOf(snapshot)), STATUS_PAGE_TOMBSTONE)
	fake.kv.delete(StatusPageKeys.slug(addressOf(snapshot)))
	fake.r2.set(StatusPageKeys.snapshotObject(snapshot.pageId), STATUS_PAGE_TOMBSTONE)
	fake.kv.delete(StatusPageKeys.snapshot(snapshot.pageId))
}

/** Writes one break-glass entry under its own key, as the Worker does. */
export const putOverlayEntry = (fake: FakeStorage, entry: StatusPageOverlayEntry) =>
	fake.kv.set(StatusPageKeys.overlayEntry(FIXTURE_PAGE_ID, entry.id), encodeJson(entry))

/** Every break-glass entry stored for the fixture page, in key order. */
export const overlayEntries = (fake: FakeStorage): ReadonlyArray<StatusPageOverlayEntry> =>
	Arr.flatMap(
		Arr.filter([...fake.kv.entries()], ([key]) =>
			Str.startsWith(StatusPageKeys.overlayPage(FIXTURE_PAGE_ID))(key),
		),
		([, raw]) => Option.toArray(decodeStatusPageOverlayEntryJson(raw)),
	)

/** Runs one request through the handler; ids count up so nonces and entry ids are predictable. */
export const send = (
	fake: FakeStorage,
	input: string | Request,
	options: { readonly nowMs?: number } = {},
): Promise<Response> => {
	const env: StatusEnv = {
		storage: fake.storage,
		nowMs: options.nowMs ?? FIXTURE_NOW,
		randomId: () => `id-${++fake.ids.next}`,
		isSharedHost: sharedHostMatcher(null),
	}
	return Effect.runPromise(handleRequest(typeof input === "string" ? new Request(input) : input, env))
}

/** A urlencoded break-glass POST. */
export const postForm = (url: string, fields: ReadonlyArray<readonly [string, string]>, ip = "203.0.113.7") =>
	new Request(url, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
		body: new URLSearchParams(Arr.map(fields, ([name, value]) => [name, value])).toString(),
	})
