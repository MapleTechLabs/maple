import {
	decodeStatusPageOverlayEntryJson,
	StatusPageKeys,
	type StatusPageOverlayEntry,
	type StatusPagePublisherHeartbeat,
	type StatusPageSnapshot,
} from "@maple/domain/status-page"
import { FIXTURE_NOW, FIXTURE_PAGE_ID } from "@maple/status-page/fixtures"
import { Effect, Option } from "effect"
import { handleRequest } from "./handler"
import { type CachedValue, type StatusEnv, type StatusStorage, StatusStorageError } from "./ports"

/** In-memory KV, R2, colo cache and rate limiter; each store can be made to fail. */
export const makeFakeStorage = () => {
	const kv = new Map<string, string>()
	const r2 = new Map<string, string>()
	const cache = new Map<string, CachedValue>()
	const failing = new Set<"kv" | "kv-put" | "r2" | "cache">()
	const limits = { allow: true, keys: new Array<string>() }

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
	const storage: StatusStorage = {
		kvGet: (key) => guard("kv", key, () => kv.get(key) ?? null),
		kvPut: (key, value) => guard("kv-put", key, () => void kv.set(key, value)),
		kvList: (prefix, limit) =>
			guard("kv", prefix, () =>
				[...kv.keys()]
					.filter((key) => key.startsWith(prefix) && !unlisted.has(key))
					.sort()
					.slice(0, limit),
			),
		r2Get: (key) => guard("r2", key, () => r2.get(key) ?? null),
		cacheGet: (key) => guard("cache", key, () => cache.get(key) ?? null),
		cachePut: (key, entry) => guard("cache", key, () => void cache.set(key, entry)),
		rateLimit: (key) =>
			Effect.sync(() => {
				limits.keys.push(key)
				return limits.allow
			}),
	}
	// Shared across requests, so two posts get distinct entry ids.
	const ids = { next: 0 }
	return { storage, kv, r2, cache, failing, limits, unlisted, ids }
}

export type FakeStorage = ReturnType<typeof makeFakeStorage>

/** Publishes a snapshot the way the publisher does: host and slug keys, KV and R2 copies, heartbeat. */
export const publish = (
	fake: FakeStorage,
	snapshot: StatusPageSnapshot,
	options: { readonly host?: string; readonly heartbeatAt?: number | null } = {},
) => {
	const json = JSON.stringify(snapshot)
	const host = options.host ?? "status.acme.example"
	fake.kv.set(StatusPageKeys.host(host), snapshot.pageId)
	fake.kv.set(StatusPageKeys.slug(snapshot.page.slug), snapshot.pageId)
	fake.kv.set(StatusPageKeys.snapshot(snapshot.pageId), json)
	fake.r2.set(StatusPageKeys.snapshotObject(snapshot.pageId), json)
	fake.r2.set(StatusPageKeys.hostObject(host), snapshot.pageId)
	fake.r2.set(StatusPageKeys.slugObject(snapshot.page.slug), snapshot.pageId)
	const heartbeatAt = options.heartbeatAt === undefined ? FIXTURE_NOW : options.heartbeatAt
	if (heartbeatAt !== null) {
		const heartbeat: StatusPagePublisherHeartbeat = {
			at: heartbeatAt,
			probesSeenAt: heartbeatAt - 30_000,
		}
		fake.kv.set(StatusPageKeys.heartbeat, JSON.stringify(heartbeat))
	}
}

/** Writes one break-glass entry under its own key, as the Worker does. */
export const putOverlayEntry = (fake: FakeStorage, entry: StatusPageOverlayEntry) =>
	fake.kv.set(StatusPageKeys.overlayEntry(FIXTURE_PAGE_ID, entry.id), JSON.stringify(entry))

/** Every break-glass entry stored for the fixture page, in key order. */
export const overlayEntries = (fake: FakeStorage): ReadonlyArray<StatusPageOverlayEntry> =>
	[...fake.kv.entries()]
		.filter(([key]) => key.startsWith(StatusPageKeys.overlayPage(FIXTURE_PAGE_ID)))
		.flatMap(([, raw]) => Option.toArray(decodeStatusPageOverlayEntryJson(raw)))

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
	}
	return Effect.runPromise(handleRequest(typeof input === "string" ? new Request(input) : input, env))
}

/** A urlencoded break-glass POST. */
export const postForm = (url: string, fields: ReadonlyArray<readonly [string, string]>, ip = "203.0.113.7") =>
	new Request(url, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
		body: new URLSearchParams(fields.map(([name, value]) => [name, value])).toString(),
	})
