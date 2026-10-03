import { configurePrivacy, resetConsentForTests, setConsent } from "@maple/browser-session"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type OfflineQueueOptions, startOfflineQueue } from "./offline"

const CONFIG: OfflineQueueOptions = {
	endpoint: "https://ingest.test",
	headers: { Authorization: "Bearer k", "x-maple-sdk": "test/1" },
}

/** An OTLP JSON body naming one span, as an exporter would have sent it. */
const body = (name: string): Uint8Array =>
	new TextEncoder().encode(JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ name }] }] }] }))

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
	localStorage.removeItem("maple-consent-revoked-at")
	await new Promise((resolve) => {
		const request = indexedDB.deleteDatabase("maple-offline")
		request.onsuccess = request.onerror = request.onblocked = () => resolve(undefined)
	})
})

afterEach(() => {
	stop?.()
	stop = undefined
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
		queue.stash("traces", body("checkout"))
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

	it("keeps batches while ingest is failing, drops ones it rejects, and never stores an empty one", async () => {
		const statuses = [503, 400]
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: statuses.shift() ?? 200 })),
		)
		const queue = startOfflineQueue(CONFIG)
		stop = queue.stop
		await queue.resend()
		queue.stash("logs", new Uint8Array())
		queue.stash("traces", body("a"))
		await vi.waitFor(async () => expect(await storedCount()).toBe(1))
		await queue.resend()
		expect(await storedCount()).toBe(1)
		await queue.resend()
		expect(await storedCount()).toBe(0)
	})

	it("never resends another SDK's batch under this one's endpoint or key", async () => {
		const posts: Array<{ url: string; auth: string | null }> = []
		let online = false
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (!online) throw new TypeError("Failed to fetch")
				posts.push({ url, auth: new Headers(init.headers).get("authorization") })
				return new Response("{}")
			}),
		)
		const other = startOfflineQueue({
			endpoint: "https://proxy.test",
			headers: { Authorization: "Bearer other" },
		})
		const mine = startOfflineQueue(CONFIG)
		other.stash("traces", body("theirs"))
		mine.stash("traces", body("mine"))
		await vi.waitFor(async () => expect(await storedCount()).toBe(2))
		online = true
		await mine.resend()
		expect(posts).toEqual([{ url: "https://ingest.test/v1/traces", auth: "Bearer k" }])
		expect(await storedCount()).toBe(1)
		await other.resend()
		expect(posts.at(-1)).toEqual({ url: "https://proxy.test/v1/traces", auth: "Bearer other" })
		other.stop()
		mine.stop()
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
		tabA.stash("traces", body("once"))
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
	it("sends an earlier page's batches once consent is granted on this one", async () => {
		const posts: string[] = []
		let online = false
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (!online) throw new TypeError("Failed to fetch")
				posts.push(url)
				return new Response("{}")
			}),
		)
		configurePrivacy({ requireConsent: true })
		setConsent(true)
		const first = startOfflineQueue(CONFIG)
		first.stash("traces", body("offline"))
		await vi.waitFor(async () => expect(await storedCount()).toBe(1))
		first.stop()

		// The next page load: consent is granted afresh, which is not a revoke.
		resetConsentForTests()
		configurePrivacy({ requireConsent: true })
		await new Promise((resolve) => setTimeout(resolve, 5))
		setConsent(true)
		online = true
		const second = startOfflineQueue(CONFIG)
		stop = second.stop
		await second.resend()
		await vi.waitFor(async () => expect(await storedCount()).toBe(0))
		expect(posts).toEqual(["https://ingest.test/v1/traces"])
	})

	it("drops batches captured before consent was withdrawn instead of sending them", async () => {
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
		first.stash("traces", body("before"))
		await vi.waitFor(async () => expect(await storedCount()).toBe(1))
		first.stop()

		// Consent was withdrawn somewhere this queue never saw (another tab, which records it), then granted again.
		await new Promise((resolve) => setTimeout(resolve, 5))
		localStorage.setItem("maple-consent-revoked-at", String(Date.now()))
		configurePrivacy({ requireConsent: true })
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

	it("stops a resend when consent is withdrawn during it", async () => {
		configurePrivacy({ requireConsent: true })
		setConsent(true)
		let online = false
		const posts: string[] = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (!online) throw new TypeError("Failed to fetch")
				posts.push(url)
				// The user withdraws consent while the first batch is in flight.
				setConsent(false)
				return new Response("{}")
			}),
		)
		const queue = startOfflineQueue(CONFIG)
		stop = queue.stop
		queue.stash("traces", body("one"))
		queue.stash("traces", body("two"))
		await vi.waitFor(async () => expect(await storedCount()).toBe(2))
		online = true
		await queue.resend()
		expect(posts).toHaveLength(1)
	})
})
