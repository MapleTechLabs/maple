import { configurePrivacy, resetConsentForTests, setConsent } from "@maple/browser-session"
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveConfig } from "../config"
import { attachSpanStash, OfflineSpanExporter, resetOfflineForTests } from "../offline"
import { startOfflineQueue } from "./offline"

const CONFIG = resolveConfig({ ingestKey: "k", serviceName: "web", endpoint: "https://ingest.test" })

const finishedSpans = (...names: string[]): ReadableSpan[] => {
	const memory = new InMemorySpanExporter()
	const tracer = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] }).getTracer(
		"t",
	)
	for (const name of names) tracer.startSpan(name).end()
	return memory.getFinishedSpans()
}

/** How many batches the queue holds, read straight from IndexedDB. */
const storedCount = async (): Promise<number> => {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open("maple-offline", 1)
		request.onupgradeneeded = () =>
			request.result.createObjectStore("batches", { keyPath: "id", autoIncrement: true })
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})
	const count = await new Promise<number>((resolve) => {
		const request = db.transaction("batches").objectStore("batches").count()
		request.onsuccess = () => resolve(request.result)
	})
	db.close()
	return count
}

let stop: (() => void) | undefined

beforeEach(async () => {
	await new Promise((resolve) => {
		const request = indexedDB.deleteDatabase("maple-offline")
		request.onsuccess = request.onerror = request.onblocked = () => resolve(undefined)
	})
})

afterEach(() => {
	stop?.()
	stop = undefined
	resetOfflineForTests()
	resetConsentForTests()
	vi.unstubAllGlobals()
})

describe("offline queue", () => {
	it("stores batches the exporter gave up on and sends them once back online", async () => {
		const posts: Array<{ url: string; body: string }> = []
		let online = false
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (!online) throw new TypeError("Failed to fetch")
				posts.push({ url, body: new TextDecoder().decode(init.body as Uint8Array) })
				return new Response("{}")
			}),
		)
		const queue = startOfflineQueue(CONFIG)
		stop = queue.stop
		queue.stashSpans(finishedSpans("checkout"))
		await vi.waitFor(async () => expect(await storedCount()).toBe(1))

		online = true
		window.dispatchEvent(new Event("online"))
		await vi.waitFor(async () => expect(await storedCount()).toBe(0))
		expect(posts).toHaveLength(1)
		expect(posts[0]?.url).toBe("https://ingest.test/v1/traces")
		expect(JSON.parse(posts[0]?.body ?? "{}").resourceSpans[0].scopeSpans[0].spans[0].name).toBe(
			"checkout",
		)
	})

	it("keeps batches while ingest is failing, and drops ones it rejects", async () => {
		const statuses = [503, 400]
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: statuses.shift() ?? 200 })),
		)
		const queue = startOfflineQueue(CONFIG)
		stop = queue.stop
		await queue.resend()
		queue.stashLogs([])
		queue.stashSpans(finishedSpans("a"))
		await vi.waitFor(async () => expect(await storedCount()).toBe(1))
		await queue.resend()
		expect(await storedCount()).toBe(1)
		await queue.resend()
		expect(await storedCount()).toBe(0)
	})
})

describe("offline queue across tabs", () => {
	it("sends each stored batch once when two tabs resend at the same time", async () => {
		const posts: string[] = []
		let online = false
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (!online) throw new TypeError("Failed to fetch")
				posts.push(url)
				await new Promise((resolve) => setTimeout(resolve, 20))
				return new Response("{}")
			}),
		)
		// Two queues on one origin stand in for two tabs: they share the store and the lock.
		const tabA = startOfflineQueue(CONFIG)
		const tabB = startOfflineQueue(CONFIG)
		tabA.stashSpans(finishedSpans("once"))
		await vi.waitFor(async () => expect(await storedCount()).toBe(1))
		online = true
		await Promise.all([tabA.resend(), tabB.resend()])
		tabA.stop()
		tabB.stop()
		expect(posts).toHaveLength(1)
		expect(await storedCount()).toBe(0)
	})
})

describe("offline queue and consent", () => {
	it("drops batches captured before the current consent grant instead of sending them", async () => {
		const posts: string[] = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				posts.push(url)
				return new Response("{}", { status: 503 })
			}),
		)
		const first = startOfflineQueue(CONFIG)
		// Let its startup resend (of an empty store) finish before anything is stored.
		await first.resend()
		first.stashSpans(finishedSpans("before"))
		await vi.waitFor(async () => expect(await storedCount()).toBe(1))
		first.stop()

		// A later page load that only has consent from now on.
		configurePrivacy({ requireConsent: true })
		await new Promise((resolve) => setTimeout(resolve, 5))
		setConsent(true)
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				posts.push(url)
				return new Response("{}")
			}),
		)
		const second = startOfflineQueue(CONFIG)
		stop = second.stop
		await second.resend()
		await vi.waitFor(async () => expect(await storedCount()).toBe(0))
		expect(posts.filter((url) => url.endsWith("/v1/traces"))).toEqual([])
	})
})

describe("OfflineSpanExporter", () => {
	it("hands failed batches to the stash, holding them until it is attached", () => {
		const failing = {
			export: (_spans: ReadableSpan[], callback: (result: { code: number }) => void) =>
				callback({ code: 1 }),
			shutdown: async () => {},
		}
		const exporter = new OfflineSpanExporter(failing)
		const spans = finishedSpans("early")
		exporter.export(spans, () => {})
		const stashed: ReadableSpan[][] = []
		attachSpanStash((batch) => stashed.push(batch))
		exporter.export(finishedSpans("late"), () => {})
		expect(stashed.map((batch) => batch[0]?.name)).toEqual(["early", "late"])
	})
})
