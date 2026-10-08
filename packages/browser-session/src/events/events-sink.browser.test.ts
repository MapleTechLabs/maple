// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../session/session", () => ({
	markActivity: vi.fn(),
	noteNavigation: vi.fn(),
}))
vi.mock("../platform/transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../platform/transport")>()),
	postSessionEvents: vi.fn(async () => "accepted" as const),
}))

const { resetSinkForTests, startEventSink } = await import("./events-sink")
const { postSessionEvents } = await import("../platform/transport")
const { resetVisitorCacheForTests, setVisitorTracking } = await import("../identity/visitor")

const CONFIG = {
	endpoint: "https://ingest.test",
	ingestKey: "k",
	sdk: "maple-test/0.0.0",
	maskAllInputs: false,
	maskAllText: false,
}

// The sink runs on every page load, sampled for replay or not. These pin the
// counters it is responsible for feeding — the ones the Sessions UI reads —
// against the regression where they only worked on the sampled replay path.
describe("startEventSink baseline counters", () => {
	beforeEach(() => {
		resetSinkForTests()
		document.body.innerHTML = ""
	})

	it("counts uncaught errors without any replay capture installed", () => {
		const sink = startEventSink(CONFIG, "sess-1")
		window.dispatchEvent(new ErrorEvent("error", { message: "boom" }))

		expect(sink.getErrorCount()).toBe(1)
		sink.stop()
	})

	it("counts unhandled rejections as errors", () => {
		const sink = startEventSink(CONFIG, "sess-2")
		window.dispatchEvent(new Event("unhandledrejection") as PromiseRejectionEvent)

		expect(sink.getErrorCount()).toBe(1)
		sink.stop()
	})

	it("survives history.pushState being invoked detached from history", () => {
		const sink = startEventSink(CONFIG, "sess-nav")
		// A router that captured the method reference calls it with no receiver;
		// the native method would throw "Illegal invocation" through our wrapper.
		const push = history.pushState
		expect(() => push.call(undefined, null, "", "/detached")).not.toThrow()
		expect(location.pathname).toBe("/detached")
		sink.stop()
	})

	it("counts clicks without any replay capture installed", () => {
		const sink = startEventSink(CONFIG, "sess-3")
		const button = document.createElement("button")
		document.body.appendChild(button)
		button.click()
		button.click()

		expect(sink.getClickCount()).toBe(2)
		sink.stop()
	})

	it("counts each click exactly once", () => {
		// Regression: errors and interactions used to be installed by the
		// replay-only capture module. Now that the sink owns them, the replay path
		// must not install a second listener on top.
		const sink = startEventSink(CONFIG, "sess-4")
		const button = document.createElement("button")
		document.body.appendChild(button)
		button.click()

		expect(sink.getClickCount()).toBe(1)
		sink.stop()
	})

	it("stops counting once the sink is stopped", () => {
		const sink = startEventSink(CONFIG, "sess-5")
		sink.stop()

		window.dispatchEvent(new ErrorEvent("error", { message: "boom" }))
		const button = document.createElement("button")
		document.body.appendChild(button)
		button.click()

		expect(sink.getErrorCount()).toBe(0)
		expect(sink.getClickCount()).toBe(0)
	})
})

// Every row carries the person key funnels group on. Resolved when the row is
// built, so a late `identify()` still lands on the buffered page view.
describe("startEventSink identity stamping", () => {
	const postedRows = () => vi.mocked(postSessionEvents).mock.calls.flatMap(([, rows]) => rows)

	beforeEach(() => {
		resetSinkForTests()
		resetVisitorCacheForTests()
		window.localStorage.clear()
		vi.mocked(postSessionEvents).mockClear()
	})

	it("stamps visitor_id, user_id and group_id on every row", async () => {
		const sink = startEventSink(
			{ ...CONFIG, getIdentity: () => ({ id: "user_1", groupId: "org_1", traits: {} }) },
			"sess-id-1",
		)
		sink.emit({ type: "custom", message: "signup_completed" })
		await sink.flush()

		const rows = postedRows()
		expect(rows.length).toBeGreaterThan(0)
		for (const row of rows) {
			expect(row.session_id).toBe("sess-id-1")
			expect(row.user_id).toBe("user_1")
			expect(row.group_id).toBe("org_1")
			expect(typeof row.visitor_id).toBe("string")
			expect(row.visitor_id).not.toBe("")
		}
		sink.stop()
	})

	it("reads identity when the row is built, so identify() after emit still applies", async () => {
		let identity: { id: string; traits: Record<string, string> } | undefined
		const sink = startEventSink({ ...CONFIG, getIdentity: () => identity }, "sess-id-2")
		sink.emit({ type: "custom", message: "before_identify" })
		identity = { id: "user_late", traits: {} }
		await sink.flush()

		expect(postedRows().every((row) => row.user_id === "user_late")).toBe(true)
		sink.stop()
	})

	it("sends empty strings when there is no identity and visitor tracking is off", async () => {
		setVisitorTracking(false)
		const sink = startEventSink(CONFIG, "sess-id-3")
		sink.emit({ type: "custom", message: "anon" })
		await sink.flush()

		const rows = postedRows()
		expect(rows.length).toBeGreaterThan(0)
		for (const row of rows) {
			expect(row.visitor_id).toBe("")
			expect(row.user_id).toBe("")
			expect(row.group_id).toBe("")
		}
		sink.stop()
	})
})

// A flush that gets no response while the page stays in view is the one failure
// the sink resends. `session_events` has no dedup, so every other one is a drop.
describe("startEventSink resend after a failed flush", () => {
	const post = vi.mocked(postSessionEvents)
	const rowsOf = (call: number) => post.mock.calls[call]?.[1] ?? []
	const messagesOf = (call: number) => rowsOf(call).map((row) => row.message)

	beforeEach(() => {
		resetSinkForTests()
		post.mockReset().mockResolvedValue("accepted")
	})

	it("resends the same rows once, with the next flush", async () => {
		const sink = startEventSink(CONFIG, "sess-retry-1")
		post.mockResolvedValueOnce("failed").mockResolvedValueOnce("failed")
		sink.emit({ type: "custom", message: "first" })
		await sink.flush()
		await new Promise((resolve) => setTimeout(resolve, 5))
		sink.emit({ type: "custom", message: "second" })
		await sink.flush()
		await sink.flush()
		await sink.flush()

		// Unchanged from the first attempt (same seq and timestamp), ahead of the newer row.
		expect(rowsOf(1).slice(0, rowsOf(0).length)).toEqual(rowsOf(0))
		// The second failure re-queues only the row that had not been resent yet.
		expect(messagesOf(2)).toEqual(["second"])
		expect(post).toHaveBeenCalledTimes(3)
		sink.stop()
	})

	it("re-queues every flush that failed since the previous one", async () => {
		const sink = startEventSink(CONFIG, "sess-retry-2")
		const fail: Array<() => void> = []
		post.mockImplementation(() => new Promise((resolve) => fail.push(() => resolve("failed"))))
		sink.emit({ type: "custom", message: "first" })
		const first = sink.flush()
		sink.emit({ type: "custom", message: "second" })
		const second = sink.flush()
		for (const settle of fail) settle()
		await Promise.all([first, second])
		post.mockReset().mockResolvedValue("accepted")
		await sink.flush()

		// The page view and both events, each exactly once.
		expect(
			rowsOf(0)
				.map((row) => row.seq)
				.sort(),
		).toEqual([0, 1, 2])
		sink.stop()
	})

	it("does not resend a batch ingest answered, whatever the status", async () => {
		const sink = startEventSink(CONFIG, "sess-retry-3")
		post.mockResolvedValueOnce("rejected")
		await sink.flush()
		await sink.flush()

		expect(post).toHaveBeenCalledTimes(1)
		sink.stop()
	})

	it("does not re-queue a keepalive flush", async () => {
		const sink = startEventSink(CONFIG, "sess-retry-4")
		post.mockResolvedValueOnce("failed")
		await sink.flush(true)
		await sink.flush()

		expect(post).toHaveBeenCalledTimes(1)
		sink.stop()
	})

	it("keeps queued rows out of a keepalive flush, for the next periodic one", async () => {
		const sink = startEventSink(CONFIG, "sess-retry-5")
		post.mockResolvedValueOnce("failed")
		sink.emit({ type: "custom", message: "first" })
		await sink.flush()
		sink.emit({ type: "custom", message: "second" })
		await sink.flush(true)
		await sink.flush()

		expect(messagesOf(1)).toEqual(["second"])
		expect(rowsOf(2)).toEqual(rowsOf(0))
		sink.stop()
	})

	// The page going away cuts the POST off whether or not ingest stored it.
	it.each(["visibilitychange", "pagehide"])(
		"does not re-queue a flush in flight across %s",
		async (type) => {
			const sink = startEventSink(CONFIG, `sess-retry-${type}`)
			post.mockImplementationOnce(async () => {
				document.dispatchEvent(new Event(type, { bubbles: true }))
				return "failed"
			})
			await sink.flush()
			await sink.flush()

			expect(post).toHaveBeenCalledTimes(1)
			sink.stop()
		},
	)

	it("drops queued rows on pagehide", async () => {
		// A navigation can abort the POST before `pagehide` fires.
		const sink = startEventSink(CONFIG, "sess-retry-6")
		post.mockResolvedValueOnce("failed")
		await sink.flush()
		window.dispatchEvent(new Event("pagehide"))
		await sink.flush()

		expect(post).toHaveBeenCalledTimes(1)
		sink.stop()
	})
})
