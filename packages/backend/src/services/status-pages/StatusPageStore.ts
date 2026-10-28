import type { StatusPageId } from "@maple/domain/primitives"
import {
	decodeStatusPageOverlayJson,
	StatusPageKeys,
	type StatusPageOverlay,
} from "@maple/domain/status-page"
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"

// Edge storage for status pages: the snapshot (KV, mirrored to R2), routes, the publisher
// heartbeat and the break-glass overlay the status Worker writes while Maple is down.

export class StatusPageStoreError extends Schema.TaggedError<StatusPageStoreError>()(
	"@maple/backend/status-pages/StatusPageStoreError",
	{
		message: Schema.String,
		operation: Schema.String,
		key: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/** The subset of a Workers KV namespace the store uses. */
export interface StatusPageKvNamespace {
	get(key: string, type: "text"): Promise<string | null>
	put(key: string, value: string): Promise<void>
	delete(key: string): Promise<void>
}

/** The subset of an R2 bucket the store uses. */
export interface StatusPageBucket {
	put(
		key: string,
		value: string,
		options?: { httpMetadata?: { contentType?: string } },
	): Promise<object | null>
	delete(key: string): Promise<void>
}

export interface StatusPageRoutes {
	readonly slug: string
	readonly hostnames: ReadonlyArray<string>
}

export interface StatusPageStoreApi {
	/** Writes the snapshot to KV and its R2 copy. */
	readonly putSnapshot: (pageId: StatusPageId, json: string) => Effect.Effect<void, StatusPageStoreError>
	readonly putRoutes: (
		pageId: StatusPageId,
		routes: StatusPageRoutes,
	) => Effect.Effect<void, StatusPageStoreError>
	readonly deleteRoutes: (routes: StatusPageRoutes) => Effect.Effect<void, StatusPageStoreError>
	/** Removes the snapshot (KV and R2) and the overlay. */
	readonly deletePage: (pageId: StatusPageId) => Effect.Effect<void, StatusPageStoreError>
	readonly putHeartbeat: (atMs: number) => Effect.Effect<void, StatusPageStoreError>
	/** The page's break-glass overlay; missing or undecodable reads as empty. */
	readonly readOverlay: (pageId: StatusPageId) => Effect.Effect<StatusPageOverlay, StatusPageStoreError>
	/** Drops only these entries, keeping any the edge added since the read. */
	readonly removeOverlayEntries: (
		pageId: StatusPageId,
		entryIds: ReadonlyArray<string>,
	) => Effect.Effect<void, StatusPageStoreError>
}

const EMPTY_OVERLAY: StatusPageOverlay = { entries: [] }

const routeKeys = (routes: StatusPageRoutes): ReadonlyArray<string> => [
	StatusPageKeys.slug(routes.slug),
	...routes.hostnames.map(StatusPageKeys.host),
]

/** The overlay as stored, or empty when absent; an undecodable value is logged and ignored. */
const parseOverlay = (pageId: StatusPageId, raw: string | null) =>
	raw === null
		? Effect.succeed(EMPTY_OVERLAY)
		: Option.match(decodeStatusPageOverlayJson(raw), {
				onNone: () =>
					Effect.logWarning("Undecodable status page overlay ignored").pipe(
						Effect.annotateLogs({ "maple.status_page.id": pageId }),
						Effect.as(EMPTY_OVERLAY),
					),
				onSome: Effect.succeed,
			})

const withoutEntries = (overlay: StatusPageOverlay, entryIds: ReadonlyArray<string>): StatusPageOverlay => ({
	entries: overlay.entries.filter((entry) => !entryIds.includes(entry.id)),
})

/** Low-level key/value operations both layers implement. */
interface StoreBackend {
	readonly kvGet: (key: string) => Effect.Effect<string | null, StatusPageStoreError>
	readonly kvPut: (key: string, value: string) => Effect.Effect<void, StatusPageStoreError>
	readonly kvDelete: (key: string) => Effect.Effect<void, StatusPageStoreError>
	readonly objectPut: (key: string, value: string) => Effect.Effect<void, StatusPageStoreError>
	readonly objectDelete: (key: string) => Effect.Effect<void, StatusPageStoreError>
}

const makeApi = (backend: StoreBackend): StatusPageStoreApi => {
	const readOverlay = (pageId: StatusPageId) =>
		backend.kvGet(StatusPageKeys.overlay(pageId)).pipe(Effect.flatMap((raw) => parseOverlay(pageId, raw)))
	return {
		putSnapshot: (pageId, json) =>
			Effect.all(
				[
					backend.kvPut(StatusPageKeys.snapshot(pageId), json),
					backend.objectPut(StatusPageKeys.snapshotObject(pageId), json),
				],
				{ concurrency: 2, discard: true },
			),
		putRoutes: (pageId, routes) =>
			Effect.forEach(routeKeys(routes), (key) => backend.kvPut(key, pageId), {
				concurrency: 4,
				discard: true,
			}),
		deleteRoutes: (routes) =>
			Effect.forEach(routeKeys(routes), backend.kvDelete, { concurrency: 4, discard: true }),
		deletePage: (pageId) =>
			Effect.all(
				[
					backend.kvDelete(StatusPageKeys.snapshot(pageId)),
					backend.kvDelete(StatusPageKeys.overlay(pageId)),
					backend.objectDelete(StatusPageKeys.snapshotObject(pageId)),
				],
				{ concurrency: 3, discard: true },
			),
		putHeartbeat: (atMs) => backend.kvPut(StatusPageKeys.heartbeat, JSON.stringify({ at: atMs })),
		readOverlay,
		removeOverlayEntries: (pageId, entryIds) =>
			entryIds.length === 0
				? Effect.void
				: readOverlay(pageId).pipe(
						Effect.map((overlay) => withoutEntries(overlay, entryIds)),
						Effect.flatMap((remaining) =>
							remaining.entries.length === 0
								? backend.kvDelete(StatusPageKeys.overlay(pageId))
								: backend.kvPut(StatusPageKeys.overlay(pageId), JSON.stringify(remaining)),
						),
					),
	}
}

const call = <A>(operation: string, key: string, run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) =>
			new StatusPageStoreError({
				message: `Status page store ${operation} failed for ${key}`,
				operation,
				key,
				cause,
			}),
	})

const isBucket = (value: unknown): value is StatusPageBucket =>
	typeof value === "object" &&
	value !== null &&
	"put" in value &&
	typeof value.put === "function" &&
	"delete" in value &&
	typeof value.delete === "function"

const isKvNamespace = (value: unknown): value is StatusPageKvNamespace =>
	isBucket(value) && "get" in value && typeof value.get === "function"

/** The KV namespace and R2 bucket from a Worker env, when both are bound. */
export const statusPageBindingsFrom = (
	env: Record<string, unknown>,
): Option.Option<{ readonly kv: StatusPageKvNamespace; readonly bucket: StatusPageBucket }> => {
	const kv = env.STATUS_PAGES_KV
	const bucket = env.STATUS_PAGES_BUCKET
	return isKvNamespace(kv) && isBucket(bucket) ? Option.some({ kv, bucket }) : Option.none()
}

/** What the in-memory store holds, for test assertions. */
export interface StatusPageStoreContents {
	readonly kv: ReadonlyMap<string, string>
	readonly objects: ReadonlyMap<string, string>
}

export interface InMemoryStatusPageStore {
	readonly api: StatusPageStoreApi
	readonly contents: Effect.Effect<StatusPageStoreContents>
	/** While set, writes fail (all, or those whose key matches): a stand-in for an unavailable KV. */
	readonly setFailing: (failing: boolean | ((key: string) => boolean)) => Effect.Effect<void>
	/** Writes a raw KV value, as the status Worker would. */
	readonly putKv: (key: string, value: string) => Effect.Effect<void>
}

export class StatusPageStore extends Context.Service<StatusPageStore, StatusPageStoreApi>()(
	"@maple/backend/services/status-pages/StatusPageStore",
) {
	/** The store over Worker bindings: pass `env.STATUS_PAGES_KV` and `env.STATUS_PAGES_BUCKET`. */
	static readonly fromBindings = (kv: StatusPageKvNamespace, bucket: StatusPageBucket) =>
		Layer.succeed(
			this,
			makeApi({
				kvGet: (key) => call("kv.get", key, () => kv.get(key, "text")),
				kvPut: (key, value) => call("kv.put", key, () => kv.put(key, value)).pipe(Effect.asVoid),
				kvDelete: (key) => call("kv.delete", key, () => kv.delete(key)).pipe(Effect.asVoid),
				objectPut: (key, value) =>
					call("r2.put", key, () =>
						bucket.put(key, value, { httpMetadata: { contentType: "application/json" } }),
					).pipe(Effect.asVoid),
				objectDelete: (key) => call("r2.delete", key, () => bucket.delete(key)).pipe(Effect.asVoid),
			}),
		)

	/** A `Ref`-backed store plus handles on its contents. */
	static readonly makeInMemory: Effect.Effect<InMemoryStatusPageStore> = Effect.gen(function* () {
		const kv = yield* Ref.make<ReadonlyMap<string, string>>(new Map())
		const objects = yield* Ref.make<ReadonlyMap<string, string>>(new Map())
		const failing = yield* Ref.make<(key: string) => boolean>(() => false)
		const guardWrite = (operation: string, key: string) =>
			Ref.get(failing).pipe(
				Effect.flatMap((fails) =>
					fails(key)
						? Effect.fail(
								new StatusPageStoreError({
									message: `Status page store ${operation} failed for ${key}`,
									operation,
									key,
									cause: new Error("store unavailable"),
								}),
							)
						: Effect.void,
				),
			)
		const set = (ref: Ref.Ref<ReadonlyMap<string, string>>, key: string, value: string) =>
			Ref.update(ref, (map) => new Map([...map, [key, value]]))
		const remove = (ref: Ref.Ref<ReadonlyMap<string, string>>, key: string) =>
			Ref.update(ref, (map) => new Map([...map].filter(([k]) => k !== key)))
		const api = makeApi({
			kvGet: (key) => Ref.get(kv).pipe(Effect.map((map) => map.get(key) ?? null)),
			kvPut: (key, value) => guardWrite("kv.put", key).pipe(Effect.andThen(set(kv, key, value))),
			kvDelete: (key) => guardWrite("kv.delete", key).pipe(Effect.andThen(remove(kv, key))),
			objectPut: (key, value) =>
				guardWrite("r2.put", key).pipe(Effect.andThen(set(objects, key, value))),
			objectDelete: (key) => guardWrite("r2.delete", key).pipe(Effect.andThen(remove(objects, key))),
		})
		return {
			api,
			contents: Effect.all({ kv: Ref.get(kv), objects: Ref.get(objects) }),
			setFailing: (fail) => Ref.set(failing, typeof fail === "function" ? fail : () => fail),
			putKv: (key, value) => set(kv, key, value),
		}
	})

	/** An empty in-memory store, for tests that only need the service. */
	static readonly inMemory = Layer.effect(this, this.makeInMemory.pipe(Effect.map((store) => store.api)))
}
