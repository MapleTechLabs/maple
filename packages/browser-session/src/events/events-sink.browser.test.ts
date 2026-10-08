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

// A periodic flush that gets no response is the one failure the sink resends.
// `session_events` has no dedup, so every other failure must stay a drop.
describe("startEventSink resend after a failed flush", () => {
	const post = vi.mocked(postSessionEvents)
	const messagesOf = (call: number) => post.mock.calls[call]?.[1].map((row) => row.message)

	beforeEach(() => {
		resetSinkForTests()
		post.mockReset().mockResolvedValue("accepted")
	})

	it("resends the same rows with the next flush", async () => {
		const sink = startEventSink(CONFIG, "sess-retry-1")
		sink.emit({ type: "custom", message: "first" })
		post.mockResolvedValueOnce("failed")
		await sink.flush()
		await new Promise((resolve) => setTimeout(resolve, 5))
		sink.emit({ type: "custom", message: "second" })
		await sink.flush()

		const [failed, resent] = post.mock.calls.map(([, rows]) => rows)
		// Same seq and timestamp as the first attempt, alongside the newer event.
		expect(resent).toEqual(expect.arrayContaining([...(failed ?? [])]))
		expect(messagesOf(1)).toContain("second")

		post.mockClear()
		await sink.flush()
		expect(post).not.toHaveBeenCalled()
		sink.stop()
	})

	it("does not resend a batch ingest answered, whatever the status", async () => {
		const sink = startEventSink(CONFIG, "sess-retry-2")
		post.mockResolvedValueOnce("rejected")
		await sink.flush()
		post.mockClear()
		await sink.flush()

		expect(post).not.toHaveBeenCalled()
		sink.stop()
	})

	it("does not resend a keepalive flush", async () => {
		const sink = startEventSink(CONFIG, "sess-retry-3")
		post.mockResolvedValueOnce("failed")
		await sink.flush(true)
		post.mockClear()
		await sink.flush()

		expect(post).not.toHaveBeenCalled()
		sink.stop()
	})

	it("does not resend a flush that was in flight across pagehide", async () => {
		const sink = startEventSink(CONFIG, "sess-retry-4")
		// An unloading document sees the POST reject even when ingest answered it.
		post.mockImplementationOnce(async () => {
			window.dispatchEvent(new Event("pagehide"))
			return "failed"
		})
		await sink.flush()
		post.mockClear()
		await sink.flush()

		expect(post).not.toHaveBeenCalled()
		sink.stop()
	})

	it("keeps the newest events when the unsent backlog passes the byte cap", async () => {
		const big = (message: string) => ({
			type: "custom" as const,
			message,
			attrs: { pad: "x".repeat(30_000) },
		})
		const sink = startEventSink(CONFIG, "sess-retry-5")
		post.mockResolvedValue("failed")
		sink.emit(big("a"))
		sink.emit(big("b"))
		await sink.flush()
		sink.emit(big("c"))
		await sink.flush()
		post.mockClear()
		await sink.flush()

		// 64 KiB holds two of the three; the oldest (and the page view before it) go.
		expect(messagesOf(0)).toHaveLength(2)
		expect(messagesOf(0)).toEqual(expect.arrayContaining(["b", "c"]))
		sink.stop()
	})
})
