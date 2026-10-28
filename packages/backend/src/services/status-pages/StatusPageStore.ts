import { StatusPageId } from "@maple/domain/primitives"
import {
	decodeStatusPageOverlayEntryJson,
	StatusPageKeys,
	type StatusPageOverlayEntry,
	type StatusPagePublisherHeartbeat,
} from "@maple/domain/status-page"
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"

// Edge storage for status pages: the snapshot (KV, mirrored to R2), routes, the publisher
// heartbeat and the break-glass entries the status Worker writes while Maple is down.

export class StatusPageStoreError extends Schema.TaggedError<StatusPageStoreError>()(
	"@maple/backend/status-pages/StatusPageStoreError",
	{
		message: Schema.String,
		operation: Schema.String,
		key: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/** One page of a KV list; `cursor` is set while `list_complete` is false. */
export interface StatusPageKvListResult {
	readonly keys: ReadonlyArray<{ readonly name: string }>
	readonly list_complete: boolean
	readonly cursor?: string
}

/** The subset of a Workers KV namespace the store uses. */
export interface StatusPageKvNamespace {
	get(key: string, type: "text"): Promise<string | null>
	put(key: string, value: string): Promise<void>
	delete(key: string): Promise<void>
	list(options: { prefix: string; limit: number; cursor?: string }): Promise<StatusPageKvListResult>
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

/** One page of KV keys under a prefix; `cursor` is null once the listing is complete. */
export interface StatusPageKeyPage {
	readonly keys: ReadonlyArray<string>
	readonly cursor: string | null
}

/** Keys listed across pages; `complete` is false when the page bound stopped the listing. */
export interface StatusPageKeyListing {
	readonly keys: ReadonlyArray<string>
	readonly complete: boolean
}

export interface StatusPageStoreApi {
	/** Writes the snapshot to KV and its R2 copy. */
	readonly putSnapshot: (pageId: StatusPageId, json: string) => Effect.Effect<void, StatusPageStoreError>
	/** Points the slug and hostnames at the page, in KV and in R2 for the edge's fallback. */
	readonly putRoutes: (
		pageId: StatusPageId,
		routes: StatusPageRoutes,
	) => Effect.Effect<void, StatusPageStoreError>
	/** The page id the slug's KV route points at, or null. */
	readonly readSlugRoute: (slug: string) => Effect.Effect<string | null, StatusPageStoreError>
	/** Removes the routes from KV and R2. */
	readonly deleteRoutes: (routes: StatusPageRoutes) => Effect.Effect<void, StatusPageStoreError>
	/** Removes the snapshot (KV and R2) and every break-glass entry of the page. */
	readonly deletePage: (pageId: StatusPageId) => Effect.Effect<void, StatusPageStoreError>
	readonly putHeartbeat: (
		heartbeat: StatusPagePublisherHeartbeat,
	) => Effect.Effect<void, StatusPageStoreError>
	/** KV keys under the prefix, following the list cursor for at most `maxPages` list calls. */
	readonly listKeys: (
		prefix: string,
		maxPages: number,
	) => Effect.Effect<StatusPageKeyListing, StatusPageStoreError>
	/** A break-glass entry by key; missing or undecodable reads as none. */
	readonly readOverlayEntry: (
		key: string,
	) => Effect.Effect<Option.Option<StatusPageOverlayEntry>, StatusPageStoreError>
	readonly deleteOverlayEntry: (
		pageId: StatusPageId,
		entryId: string,
	) => Effect.Effect<void, StatusPageStoreError>
}

/** KV list page size; Workers KV caps it at 1000. */
export const STATUS_PAGE_KV_LIST_LIMIT = 1000

const decodePageId = Schema.decodeUnknownOption(StatusPageId)

/** The page and entry ids in an `overlay:<page>:<entry>` key. */
export const parseOverlayKey = (
	key: string,
): Option.Option<{ readonly pageId: StatusPageId; readonly entryId: string }> => {
	if (!key.startsWith(StatusPageKeys.overlayAll)) return Option.none()
	const rest = key.slice(StatusPageKeys.overlayAll.length)
	const split = rest.indexOf(":")
	if (split <= 0 || split === rest.length - 1) return Option.none()
	return Option.map(decodePageId(rest.slice(0, split)), (pageId) => ({
		pageId,
		entryId: rest.slice(split + 1),
	}))
}

/** Low-level key/value operations both layers implement. */
interface StoreBackend {
	readonly kvGet: (key: string) => Effect.Effect<string | null, StatusPageStoreError>
	readonly kvPut: (key: string, value: string) => Effect.Effect<void, StatusPageStoreError>
	readonly kvDelete: (key: string) => Effect.Effect<void, StatusPageStoreError>
	readonly kvList: (
		prefix: string,
		cursor: string | null,
	) => Effect.Effect<StatusPageKeyPage, StatusPageStoreError>
	readonly objectPut: (key: string, value: string) => Effect.Effect<void, StatusPageStoreError>
	readonly objectDelete: (key: string) => Effect.Effect<void, StatusPageStoreError>
}

/** KV keys under the prefix, following the cursor until the listing ends or `pagesLeft` runs out. */
const listFrom = (
	backend: StoreBackend,
	prefix: string,
	cursor: string | null,
	seen: ReadonlyArray<string>,
	pagesLeft: number,
): Effect.Effect<StatusPageKeyListing, StatusPageStoreError> =>
	backend.kvList(prefix, cursor).pipe(
		Effect.flatMap((page) => {
			const keys = [...seen, ...page.keys]
			if (page.cursor === null) return Effect.succeed({ keys, complete: true })
			if (pagesLeft <= 1) return Effect.succeed({ keys, complete: false })
			return listFrom(backend, prefix, page.cursor, keys, pagesLeft - 1)
		}),
	)

/** List calls one page's break-glass cleanup may make; the edge caps a page's entries well below. */
const PAGE_OVERLAY_LIST_PAGES = 10

const makeApi = (backend: StoreBackend): StatusPageStoreApi => ({
	putSnapshot: (pageId, json) =>
		Effect.all(
			[
				backend.kvPut(StatusPageKeys.snapshot(pageId), json),
				backend.objectPut(StatusPageKeys.snapshotObject(pageId), json),
			],
			{ concurrency: 2, discard: true },
		),
	putRoutes: (pageId, routes) =>
		Effect.all(
			[
				backend.kvPut(StatusPageKeys.slug(routes.slug), pageId),
				backend.objectPut(StatusPageKeys.slugObject(routes.slug), pageId),
				...routes.hostnames.flatMap((hostname) => [
					backend.kvPut(StatusPageKeys.host(hostname), pageId),
					backend.objectPut(StatusPageKeys.hostObject(hostname), pageId),
				]),
			],
			{ concurrency: 4, discard: true },
		),
	readSlugRoute: (slug) => backend.kvGet(StatusPageKeys.slug(slug)),
	deleteRoutes: (routes) =>
		Effect.all(
			[
				backend.kvDelete(StatusPageKeys.slug(routes.slug)),
				backend.objectDelete(StatusPageKeys.slugObject(routes.slug)),
				...routes.hostnames.flatMap((hostname) => [
					backend.kvDelete(StatusPageKeys.host(hostname)),
					backend.objectDelete(StatusPageKeys.hostObject(hostname)),
				]),
			],
			{ concurrency: 4, discard: true },
		),
	deletePage: (pageId) =>
		Effect.all(
			[
				backend.kvDelete(StatusPageKeys.snapshot(pageId)),
				backend.objectDelete(StatusPageKeys.snapshotObject(pageId)),
				listFrom(backend, StatusPageKeys.overlayPage(pageId), null, [], PAGE_OVERLAY_LIST_PAGES).pipe(
					Effect.flatMap((listing) =>
						Effect.forEach(listing.keys, backend.kvDelete, { concurrency: 4, discard: true }),
					),
				),
			],
			{ concurrency: 3, discard: true },
		),
	putHeartbeat: (heartbeat) => backend.kvPut(StatusPageKeys.heartbeat, JSON.stringify(heartbeat)),
	listKeys: (prefix, maxPages) => listFrom(backend, prefix, null, [], maxPages),
	readOverlayEntry: (key) =>
		backend.kvGet(key).pipe(
			Effect.flatMap((raw) => {
				if (raw === null) return Effect.succeed(Option.none<StatusPageOverlayEntry>())
				const entry = decodeStatusPageOverlayEntryJson(raw)
				return Option.isSome(entry)
					? Effect.succeed(entry)
					: Effect.logWarning("Undecodable break-glass entry ignored").pipe(
							Effect.annotateLogs({ "maple.status_page.overlay_key": key }),
							Effect.as(Option.none<StatusPageOverlayEntry>()),
						)
			}),
		),
	deleteOverlayEntry: (pageId, entryId) => backend.kvDelete(StatusPageKeys.overlayEntry(pageId, entryId)),
})

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

/** The KV namespace and R2 bucket a Worker binds for publishing. */
export interface StatusPageBindings {
	readonly kv: StatusPageKvNamespace
	readonly bucket: StatusPageBucket
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
				kvList: (prefix, cursor) =>
					call("kv.list", prefix, () =>
						kv.list({
							prefix,
							limit: STATUS_PAGE_KV_LIST_LIMIT,
							...(cursor === null ? undefined : { cursor }),
						}),
					).pipe(
						Effect.map((page) => ({
							keys: page.keys.map((key) => key.name),
							cursor: page.list_complete ? null : (page.cursor ?? null),
						})),
					),
				objectPut: (key, value) =>
					call("r2.put", key, () =>
						bucket.put(key, value, { httpMetadata: { contentType: "application/json" } }),
					).pipe(Effect.asVoid),
				objectDelete: (key) => call("r2.delete", key, () => bucket.delete(key)).pipe(Effect.asVoid),
			}),
		)

	/** A `Ref`-backed store plus handles on its contents; `listPageSize` shrinks KV list pages. */
	static readonly makeInMemoryWith = (options: {
		readonly listPageSize?: number
	}): Effect.Effect<InMemoryStatusPageStore> =>
		Effect.gen(function* () {
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
				objectDelete: (key) =>
					guardWrite("r2.delete", key).pipe(Effect.andThen(remove(objects, key))),
				kvList: (prefix, cursor) =>
					Ref.get(kv).pipe(
						Effect.map((map) => {
							const size = options.listPageSize ?? STATUS_PAGE_KV_LIST_LIMIT
							const offset = cursor === null ? 0 : Number(cursor)
							const matching = [...map.keys()]
								.filter((key) => key.startsWith(prefix))
								.toSorted()
							const end = offset + size
							return {
								keys: matching.slice(offset, end),
								cursor: end < matching.length ? String(end) : null,
							}
						}),
					),
			})
			return {
				api,
				contents: Effect.all({ kv: Ref.get(kv), objects: Ref.get(objects) }),
				setFailing: (fail) => Ref.set(failing, typeof fail === "function" ? fail : () => fail),
				putKv: (key, value) => set(kv, key, value),
			}
		})

	/** A `Ref`-backed store plus handles on its contents. */
	static readonly makeInMemory: Effect.Effect<InMemoryStatusPageStore> = this.makeInMemoryWith({})

	/** An empty in-memory store, for tests that only need the service. */
	static readonly inMemory = Layer.effect(this, this.makeInMemory.pipe(Effect.map((store) => store.api)))
}
