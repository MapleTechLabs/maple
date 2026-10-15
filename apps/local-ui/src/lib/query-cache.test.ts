import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { DateTime } from "effect"
import { describe, expect, it, vi } from "vitest"
import { boundsKey } from "./query"
import {
	LocalQueryClient,
	olderWindowData,
	restoreQueryCache,
	serializeQueryCache,
	standInSince,
	windowed,
} from "./query-cache"
import { boundsForRange } from "./time"

const MINUTE = 60_000
const anchor = Date.UTC(2026, 9, 15, 20, 14)
const key = (range: string, anchorMs: number, filters: unknown = { service: "api" }) => [
	"local",
	"traces",
	filters,
	boundsKey(boundsForRange(range, anchorMs)),
]

describe("windowed queries", () => {
	const observe = (client: QueryClient, queryFn: () => Promise<ReadonlyArray<{ id: string }>>) =>
		new QueryObserver(client, { ...windowed(key("1h", anchor)), queryFn, retry: false })

	it("open on the newest earlier window of the same view and keep it when the fetch fails", async () => {
		const client = new LocalQueryClient()
		const newer = [{ id: "newer" }]
		client.setQueryData(key("1h", anchor - 10 * MINUTE), [{ id: "older" }], {
			updatedAt: anchor - 10 * MINUTE,
		})
		client.setQueryData(key("1h", anchor - 2 * MINUTE), newer, { updatedAt: anchor - 2 * MINUTE })
		const observer = observe(client, () => Promise.reject(new Error("unreachable")))
		const unsubscribe = observer.subscribe(() => {})
		expect(observer.getCurrentResult()).toMatchObject({ data: newer, isFetching: true })
		await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true))
		expect(observer.getCurrentResult().data).toBe(newer)
		const query = client.getQueryCache().find({ queryKey: key("1h", anchor) })
		expect(query && standInSince(query)).toBe(anchor - 2 * MINUTE)
		unsubscribe()
	})

	it("replace the stand-in once their own window loads", async () => {
		const client = new LocalQueryClient()
		client.setQueryData(key("1h", anchor - MINUTE), [{ id: "older" }])
		const fresh = [{ id: "fresh" }]
		const observer = observe(client, () => Promise.resolve(fresh))
		const unsubscribe = observer.subscribe(() => {})
		await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(fresh))
		const query = client.getQueryCache().find({ queryKey: key("1h", anchor) })
		expect(query && standInSince(query)).toBeUndefined()
		unsubscribe()
	})

	it("stop being a stand-in when their own window returns the same rows", async () => {
		const client = new LocalQueryClient()
		const rows = [{ id: "same" }]
		client.setQueryData(key("1h", anchor - MINUTE), rows, { updatedAt: anchor - MINUTE })
		const observer = observe(client, () => Promise.resolve([{ id: "same" }]))
		const unsubscribe = observer.subscribe(() => {})
		await vi.waitFor(() => expect(observer.getCurrentResult().isFetching).toBe(false))
		// Structural sharing kept the stand-in's reference for the equal result.
		expect(observer.getCurrentResult().data).toBe(rows)
		const query = client.getQueryCache().find({ queryKey: key("1h", anchor) })
		expect(query && standInSince(query)).toBeUndefined()
		unsubscribe()
	})

	it("never open on another range, other filters, or a later window", () => {
		const client = new QueryClient()
		client.setQueryData(key("6h", anchor - MINUTE), [{ id: "6h" }])
		client.setQueryData(key("1h", anchor - MINUTE, { service: "web" }), [{ id: "web" }])
		client.setQueryData(key("1h", anchor + MINUTE), [{ id: "later" }])
		expect(olderWindowData(client, key("1h", anchor))).toBeUndefined()
	})
})

describe("saved query cache", () => {
	it("restores results, timestamps included, and lets a new window seed from them", () => {
		const source = new QueryClient()
		const startTime = DateTime.makeUnsafe(anchor - 5 * MINUTE)
		const rows = { pages: [[{ traceId: "t1", startTime }]], pageParams: [undefined] }
		source.setQueryData(key("1h", anchor - 3 * MINUTE), rows, { updatedAt: anchor - 3 * MINUTE })
		source.setQueryData(["local", "server-status"], { reachability: "connected" })

		const storage = new Map<string, string>()
		storage.set("cache", serializeQueryCache(source))
		globalThis.localStorage = {
			getItem: (k: string) => storage.get(k) ?? null,
			setItem: (k: string, v: string) => void storage.set(k, v),
			removeItem: (k: string) => void storage.delete(k),
			clear: () => storage.clear(),
			key: () => null,
			length: storage.size,
		}

		const restored = new QueryClient()
		restoreQueryCache(restored, "cache", anchor)
		expect(restored.getQueryData(["local", "server-status"])).toBeUndefined()
		expect(restored.getQueryData(key("1h", anchor - 3 * MINUTE))).toEqual(rows)
		expect(olderWindowData(restored, key("1h", anchor))).toEqual(rows)

		const saved = JSON.parse(storage.get("cache") ?? "{}")
		saved.entries.unshift({
			key: ["local", "corrupt"],
			data: { $t: "bigint", v: "abc" },
			updatedAt: anchor,
		})
		storage.set("cache", JSON.stringify(saved))
		const withCorrupt = new QueryClient()
		restoreQueryCache(withCorrupt, "cache", anchor)
		expect(withCorrupt.getQueryData(["local", "corrupt"])).toBeUndefined()
		expect(withCorrupt.getQueryData(key("1h", anchor - 3 * MINUTE))).toEqual(rows)

		const dayLater = new QueryClient()
		restoreQueryCache(dayLater, "cache", anchor + 25 * 60 * MINUTE)
		expect(dayLater.getQueryData(key("1h", anchor - 3 * MINUTE))).toBeUndefined()
	})
})
