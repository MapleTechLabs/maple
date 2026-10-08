// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
// BOUNDARY: Test doubles mirror intentionally untyped external callbacks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// rrweb touches the DOM at import time in a real browser; here we only need the
// emit callback and the takeFullSnapshot recovery hook.
type EmitFn = (event: unknown, isCheckout?: boolean) => void
let emitRef: EmitFn | undefined
const takeFullSnapshot = vi.fn()
const stopFn = vi.fn()

let recordOptions: Record<string, unknown> | undefined
vi.mock("rrweb", () => {
	const record = (options: { emit: EmitFn } & Record<string, unknown>) => {
		emitRef = options.emit
		recordOptions = options
		return stopFn
	}
	record.takeFullSnapshot = takeFullSnapshot
	return { record }
})

vi.mock("../session/session", () => ({
	markActivity: vi.fn(),
	nextChunkSeq: vi.fn(() => 1),
}))

interface PostedChunk {
	meta: {
		sessionId: string
		chunkSeq: number
		isCheckpoint: boolean
		eventCount: number
		durationMs: number
	}
	body: string
	keepalive: boolean
}
const posted: PostedChunk[] = []
// What the mocked ingest answers the next uploads with; defaults to accepted.
const outcomes: Array<"accepted" | "rejected" | "exhausted" | "failed"> = []

vi.mock("../platform/transport", () => ({
	// Identity "gzip" so tests can read the serialized payload directly.
	gzip: vi.fn(async (bytes: Uint8Array) => bytes),
	postSessionBlob: vi.fn(
		async (_config: unknown, meta: PostedChunk["meta"], bytes: Uint8Array, keepalive: boolean) => {
			posted.push({ meta, body: new TextDecoder().decode(bytes), keepalive })
			return outcomes.shift() ?? "accepted"
		},
	),
	// The shared keepalive budget has room unless a test says otherwise.
	reserveKeepalive: vi.fn((): (() => void) | undefined => () => {}),
}))

const { startBufferedRecording, startRecording } = await import("./record")
const { clearPendingChunk } = await import("../session/pending-chunk")
const { nextChunkSeq } = await import("../session/session")
const { gzip, reserveKeepalive } = await import("../platform/transport")

const CONFIG = {
	endpoint: "https://ingest.example",
	ingestKey: "key",
	sdk: "maple-test/0.0.0",
	maskAllInputs: true,
	maskAllText: false,
}

const FULL_SNAPSHOT = 2
const INCREMENTAL = 3

const fullSnapshot = (timestamp: number) => ({ type: FULL_SNAPSHOT, timestamp, data: {} })
const incremental = (timestamp: number, payload = "x") => ({
	type: INCREMENTAL,
	timestamp,
	data: { source: 0, payload },
})

describe("startRecording", () => {
	beforeEach(() => {
		posted.length = 0
		outcomes.length = 0
		stopFn.mockClear()
		emitRef = undefined
		takeFullSnapshot.mockClear()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("flushes buffered events as one JSON array without re-stringifying", async () => {
		const recorder = startRecording(CONFIG, "session-1")
		emitRef!(fullSnapshot(1_000), true)
		emitRef!(incremental(2_500))

		await recorder.flush()

		expect(posted).toHaveLength(1)
		const chunk = posted[0]!
		expect(chunk.meta.isCheckpoint).toBe(true)
		expect(chunk.meta.eventCount).toBe(2)
		expect(chunk.meta.durationMs).toBe(1_500)
		const events = JSON.parse(chunk.body) as Array<{ type: number; timestamp: number }>
		expect(events.map((e) => e.type)).toEqual([FULL_SNAPSHOT, INCREMENTAL])
		recorder.stop()
	})

	it("stops recording and uploading once ingest answers 413 for the session", async () => {
		// Ingest returns 413 for every chunk after a session's byte ceiling; a
		// recorder that kept flushing posted a rejected chunk every 5s for the
		// rest of the page's life.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const recorder = startRecording(CONFIG, "session-1")
		emitRef!(fullSnapshot(1_000), true)
		outcomes.push("exhausted")
		await recorder.flush()
		expect(posted).toHaveLength(1)
		expect(stopFn).toHaveBeenCalledTimes(1)
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("maximum recorded size"))

		// Anything still emitted (rrweb is stopped, but be defensive) and every
		// later flush — periodic or explicit — uploads nothing.
		emitRef!(incremental(2_000))
		await recorder.flush()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(posted).toHaveLength(1)
		// A later revoke must not tear rrweb down a second time.
		recorder.stop()
		expect(stopFn).toHaveBeenCalledTimes(1)
	})

	it("skips unserializable events without breaking the stream", async () => {
		const recorder = startRecording(CONFIG, "session-1")
		interface CyclicEvent extends Record<string, unknown> {
			data?: CyclicEvent
		}
		const cyclic: CyclicEvent = { type: INCREMENTAL, timestamp: 1_000 }
		cyclic.data = cyclic
		emitRef!(cyclic)
		emitRef!(fullSnapshot(2_000), true)

		await recorder.flush()

		expect(posted).toHaveLength(1)
		expect(posted[0]!.meta.eventCount).toBe(1)
		recorder.stop()
	})

	it("drops over-cap events and reopens the stream at the next full snapshot", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const recorder = startRecording(CONFIG, "session-1")

		// A single event larger than MAX_BUFFER_BYTES (4MB) — e.g. a full snapshot
		// of a huge DOM — is dropped rather than buffered.
		emitRef!({ type: FULL_SNAPSHOT, timestamp: 1_000, data: { blob: "m".repeat(5 * 1024 * 1024) } }, true)
		expect(warn).toHaveBeenCalled()

		// Incremental events after a drop are useless until a new base snapshot.
		emitRef!(incremental(6_000))
		await recorder.flush()
		expect(posted).toHaveLength(0)
		// No snapshot-recovery loop: re-snapshotting the same DOM would emit
		// another over-cap event.
		expect(takeFullSnapshot).not.toHaveBeenCalled()

		// A new (normal-sized) full snapshot re-opens the stream.
		emitRef!(fullSnapshot(7_000), true)
		emitRef!(incremental(8_000))
		await recorder.flush()
		const recovered = posted.at(-1)!
		expect(recovered.meta.isCheckpoint).toBe(true)
		expect(recovered.meta.eventCount).toBe(2)

		warn.mockRestore()
		recorder.stop()
	})

	it("uploads nothing once stopped, so a consent revoke discards the buffer", async () => {
		const recorder = startRecording(CONFIG, "session-1")
		emitRef!(fullSnapshot(1_000), true)
		emitRef!(incremental(2_000))

		// A revoke stops the recorder without flushing. Anything still buffered is
		// recorded user data that consent was just withdrawn for.
		recorder.stop()
		await recorder.flush()

		expect(posted).toEqual([])
	})

	it("cancels a scheduled idle flush on stop", async () => {
		const idleCallbacks: Array<() => void> = []
		let nextHandle = 1
		const cancelIdleCallback = vi.fn()
		vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
			idleCallbacks.push(cb)
			return nextHandle++
		})
		vi.stubGlobal("cancelIdleCallback", cancelIdleCallback)

		try {
			const recorder = startRecording(CONFIG, "session-1")
			emitRef!(fullSnapshot(1_000), true)

			// The periodic timer queues an idle flush; the revoke lands before the
			// browser gets round to running it.
			await vi.advanceTimersByTimeAsync(5_000)
			expect(idleCallbacks).toHaveLength(1)

			recorder.stop()
			expect(cancelIdleCallback).toHaveBeenCalledWith(1)

			// Belt and braces: even a callback the browser ran anyway must not post.
			idleCallbacks[0]!()
			await vi.advanceTimersByTimeAsync(0)
			expect(posted).toEqual([])
		} finally {
			vi.unstubAllGlobals()
		}
	})

	describe("the chunk a page was flushing as it went away", () => {
		const PENDING_KEY = "maple.replay.pending"
		let storage: Map<string, string>
		let refuses: "setItem" | "removeItem" | undefined
		const refuse = (method: typeof refuses) => {
			if (refuses === method) throw new DOMException("refused", "QuotaExceededError")
		}
		const stored = () => storage.get(PENDING_KEY)

		beforeEach(() => {
			storage = new Map()
			refuses = undefined
			vi.stubGlobal("window", {
				sessionStorage: {
					getItem: (key: string) => storage.get(key) ?? null,
					setItem: (key: string, value: string) => {
						refuse("setItem")
						storage.set(key, value)
					},
					removeItem: (key: string) => {
						refuse("removeItem")
						storage.delete(key)
					},
				},
			})
		})

		afterEach(() => {
			vi.unstubAllGlobals()
		})

		/** A compression that outlives the page; the returned function lets it finish. */
		const hangGzip = () => {
			let finish = () => {}
			vi.mocked(gzip).mockImplementationOnce(
				(bytes) => new Promise((resolve) => (finish = () => resolve(bytes))),
			)
			return () => finish()
		}

		/** Record two events and flush them on the way out, under `chunkSeq`. */
		const unloadFlush = (sessionId: string, chunkSeq: number) => {
			const recorder = startRecording(CONFIG, sessionId)
			const finishGzip = hangGzip()
			vi.mocked(nextChunkSeq).mockReturnValueOnce(chunkSeq)
			emitRef!(fullSnapshot(1_000), true)
			emitRef!(incremental(2_500))
			void recorder.flush(true)
			recorder.stop()
			return finishGzip
		}

		/** The next recorder start of `sessionId`, as a page load or a resume makes it. */
		const nextStart = async (sessionId = "session-1", config = CONFIG) => {
			startRecording(config, sessionId).stop()
			await vi.advanceTimersByTimeAsync(0)
		}

		const postedSeqs = () => posted.map((chunk) => chunk.meta.chunkSeq)

		it("is kept in sessionStorage and sent under its own seq by the next start of the session", async () => {
			unloadFlush("session-1", 7)
			expect(posted).toEqual([])
			expect(stored()).toBeDefined()

			await nextStart()
			expect(posted).toHaveLength(1)
			expect(posted[0]!.meta).toMatchObject({
				sessionId: "session-1",
				chunkSeq: 7,
				isCheckpoint: true,
				eventCount: 2,
				durationMs: 1_500,
			})
			expect((JSON.parse(posted[0]!.body) as Array<{ type: number }>).map((e) => e.type)).toEqual([
				FULL_SNAPSHOT,
				INCREMENTAL,
			])
			expect(stored()).toBeUndefined()

			await nextStart()
			expect(posted).toHaveLength(1)
		})

		it("is posted once when the flush that stored it outlives the start that sent it", async () => {
			const finishGzip = unloadFlush("session-1", 7)
			await nextStart()
			// A page restored from the back/forward cache resumes its compression.
			finishGzip()
			await vi.advanceTimersByTimeAsync(0)
			expect(postedSeqs()).toEqual([7])
		})

		it("is sent by its own flush with keepalive, and not again, when the page survives", async () => {
			unloadFlush("session-1", 7)()
			await vi.advanceTimersByTimeAsync(0)
			expect(posted.map((chunk) => [chunk.meta.chunkSeq, chunk.keepalive])).toEqual([[7, true]])
			expect(stored()).toBeUndefined()
		})

		it("stays stored when the keepalive budget is full, and the next start sends it once", async () => {
			vi.mocked(reserveKeepalive).mockReturnValueOnce(undefined)
			unloadFlush("session-1", 7)()
			await vi.advanceTimersByTimeAsync(0)
			// Posted without keepalive it would die with the page, its stored copy already gone.
			expect(posted).toEqual([])
			expect(stored()).toBeDefined()

			await nextStart()
			await nextStart()
			expect(posted.map((chunk) => [chunk.meta.chunkSeq, chunk.keepalive])).toEqual([[7, false]])
		})

		it("is left for the start after a page that goes away while sending it", async () => {
			unloadFlush("session-1", 7)
			const finishGzip = hangGzip()
			await nextStart()
			expect(posted).toEqual([])
			expect(stored()).toBeDefined()

			await nextStart()
			finishGzip()
			await vi.advanceTimersByTimeAsync(0)
			expect(postedSeqs()).toEqual([7])
		})

		it("is not replaced by a later flush while it waits", async () => {
			const recorder = startRecording(CONFIG, "session-1")
			hangGzip()
			vi.mocked(nextChunkSeq).mockReturnValueOnce(7)
			emitRef!(fullSnapshot(1_000), true)
			void recorder.flush(true)
			vi.mocked(nextChunkSeq).mockReturnValueOnce(8)
			emitRef!(incremental(2_000))
			await recorder.flush(true)
			// The second chunk was not kept, so it uploads as it always did.
			expect(postedSeqs()).toEqual([8])

			await nextStart()
			expect(postedSeqs()).toEqual([8, 7])
		})

		it("is dropped by a recorder of another session, endpoint or ingest key", async () => {
			unloadFlush("session-1", 7)
			await nextStart("session-2")
			expect(stored()).toBeUndefined()

			unloadFlush("session-1", 8)
			await nextStart("session-1", { ...CONFIG, endpoint: "https://ingest.elsewhere.example" })
			expect(stored()).toBeUndefined()

			unloadFlush("session-1", 9)
			await nextStart("session-1", { ...CONFIG, ingestKey: "another-key" })
			expect(stored()).toBeUndefined()
			expect(posted).toEqual([])
		})

		it("is discarded by a consent revoke while its flush or a later start is still compressing it", async () => {
			const finishFlush = unloadFlush("session-1", 7)
			clearPendingChunk()
			expect(stored()).toBeUndefined()
			finishFlush()
			await vi.advanceTimersByTimeAsync(0)

			unloadFlush("session-1", 8)
			const finishStart = hangGzip()
			await nextStart()
			clearPendingChunk()
			finishStart()
			await vi.advanceTimersByTimeAsync(0)
			expect(posted).toEqual([])
		})

		it("is sent only if it was recorded after consent was last withdrawn on this origin", async () => {
			// A revoke on another page of the origin, which no recorder of this tab saw.
			const revokedAt = Date.now()
			vi.stubGlobal("localStorage", { getItem: () => String(revokedAt) })
			unloadFlush("session-1", 7)
			await nextStart()
			expect(stored()).toBeUndefined()
			expect(posted).toEqual([])

			await vi.advanceTimersByTimeAsync(1)
			unloadFlush("session-1", 8)
			await nextStart()
			expect(postedSeqs()).toEqual([8])
		})

		it("is discarded when an earlier page stored it more than ten minutes ago", async () => {
			// Before this module loaded: stored by an earlier page of the tab.
			vi.setSystemTime(Date.now() - 60 * 60_000)
			unloadFlush("session-1", 7)
			await vi.advanceTimersByTimeAsync(9 * 60_000)
			await nextStart()
			expect(postedSeqs()).toEqual([7])

			unloadFlush("session-1", 8)
			await vi.advanceTimersByTimeAsync(10 * 60_000 + 1)
			await nextStart()
			expect(stored()).toBeUndefined()
			expect(postedSeqs()).toEqual([7])
		})

		it("is still sent when this page stored it and was then hidden for longer than that", async () => {
			unloadFlush("session-1", 7)
			await vi.advanceTimersByTimeAsync(20 * 60_000)
			await nextStart()
			expect(postedSeqs()).toEqual([7])
		})

		it("uploads as before when sessionStorage refuses the write", async () => {
			refuses = "setItem"
			unloadFlush("session-1", 7)()
			await vi.advanceTimersByTimeAsync(0)
			expect(postedSeqs()).toEqual([7])
		})

		it("is not sent by a start that cannot remove it, so no later start sends it again", async () => {
			unloadFlush("session-1", 7)
			refuses = "removeItem"
			await nextStart()
			await nextStart()
			expect(posted).toEqual([])

			refuses = undefined
			await nextStart()
			await nextStart()
			expect(postedSeqs()).toEqual([7])
		})

		it("ignores a stored value it did not write, and the next unload flush replaces it", async () => {
			storage.set(PENDING_KEY, '{"sessionId":"session-1","chunkSeq":7}')
			await nextStart()
			storage.set(PENDING_KEY, "{not json")
			await nextStart()
			expect(posted).toEqual([])

			unloadFlush("session-1", 8)
			await nextStart()
			expect(postedSeqs()).toEqual([8])
		})
	})
})

const META = 4
const meta = (timestamp: number) => ({
	type: META,
	timestamp,
	data: { href: "https://app.example/?token=abc" },
})
/** One rrweb snapshot: a Meta event, then the FullSnapshot. */
const snapshot = (timestamp: number) => {
	emitRef!(meta(timestamp), true)
	emitRef!(fullSnapshot(timestamp + 1), true)
}

describe("startBufferedRecording", () => {
	beforeEach(() => {
		posted.length = 0
		outcomes.length = 0
		stopFn.mockClear()
		emitRef = undefined
	})

	it("uploads nothing until drained, then the last two snapshots' segments as checkpoints", async () => {
		const recorder = startBufferedRecording(CONFIG, "session-1")
		emitRef!(incremental(500))
		snapshot(1_000)
		emitRef!(incremental(1_500))
		snapshot(31_000)
		emitRef!(incremental(31_500))
		snapshot(61_000)
		emitRef!(incremental(61_500))
		emitRef!(incremental(62_000))
		expect(posted).toEqual([])

		await recorder.drain()
		expect(posted.map((chunk) => chunk.meta)).toEqual([
			{ sessionId: "session-1", chunkSeq: 1, isCheckpoint: true, eventCount: 3, durationMs: 500 },
			{ sessionId: "session-1", chunkSeq: 1, isCheckpoint: true, eventCount: 4, durationMs: 1_000 },
		])
		const first = JSON.parse(posted[0]!.body) as Array<{ timestamp: number; data: { href?: string } }>
		expect(first[0]?.timestamp).toBe(31_000)
		expect(first[0]?.data.href).toBe("https://app.example/?token=REDACTED")

		await recorder.drain()
		expect(posted).toHaveLength(2)
	})

	it("discards the buffer on stop", async () => {
		const recorder = startBufferedRecording(CONFIG, "session-1")
		snapshot(1_000)
		emitRef!(incremental(1_500))
		recorder.stop()
		await recorder.drain()
		expect(posted).toEqual([])
		expect(stopFn).toHaveBeenCalled()
	})

	it("takes a checkout snapshot only when the page changed since the last one", () => {
		vi.useFakeTimers()
		takeFullSnapshot.mockClear()
		const recorder = startBufferedRecording(CONFIG, "session-1")
		snapshot(1_000)
		vi.advanceTimersByTime(30_000)
		expect(takeFullSnapshot).not.toHaveBeenCalled()
		emitRef!(incremental(1_500))
		vi.advanceTimersByTime(30_000)
		expect(takeFullSnapshot).toHaveBeenCalledWith(true)
		recorder.stop()
		vi.useRealTimers()
	})

	it("waits for the page to be shown, unless the buffer has nothing to play back", () => {
		vi.useFakeTimers()
		vi.stubGlobal("document", { visibilityState: "hidden" })
		takeFullSnapshot.mockClear()
		const recorder = startBufferedRecording(CONFIG, "session-1")
		snapshot(1_000)
		emitRef!(incremental(1_500))
		vi.advanceTimersByTime(30_000)
		expect(takeFullSnapshot).not.toHaveBeenCalled()
		recorder.stop()

		// Nothing buffered yet (or the size cap emptied it): a snapshot is due even while hidden.
		const empty = startBufferedRecording(CONFIG, "session-1")
		emitRef!(incremental(2_000))
		vi.advanceTimersByTime(30_000)
		expect(takeFullSnapshot).toHaveBeenCalledWith(true)
		empty.stop()
		vi.unstubAllGlobals()
		vi.useRealTimers()
	})
})

describe("canvas capture", () => {
	it("is off by default and samples frames at canvasFps when asked", () => {
		startRecording(CONFIG, "session-1").stop()
		expect(recordOptions?.recordCanvas).toBeUndefined()
		startBufferedRecording({ ...CONFIG, canvasFps: 2 }, "session-1").stop()
		expect(recordOptions).toMatchObject({ recordCanvas: true, sampling: { canvas: 2 } })
		startRecording({ ...CONFIG, canvasFps: 2, maskAllText: true }, "session-1").stop()
		expect(recordOptions?.recordCanvas).toBeUndefined()
	})
})
