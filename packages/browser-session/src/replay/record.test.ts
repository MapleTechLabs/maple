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
	isReplayHalted: vi.fn(() => false),
	markReplayHalted: vi.fn(),
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
	gzipStored: vi.fn((bytes: Uint8Array) => bytes),
	postSessionBlob: vi.fn(
		async (_config: unknown, meta: PostedChunk["meta"], bytes: Uint8Array, keepalive: boolean) => {
			posted.push({ meta, body: new TextDecoder().decode(bytes), keepalive })
			return outcomes.shift() ?? "accepted"
		},
	),
	// The shared keepalive budget has room unless a test says otherwise.
	reserveKeepalive: vi.fn((): (() => void) | undefined => () => {}),
	warnDropped: vi.fn(),
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

		// The next snapshot (a Meta, then the FullSnapshot) re-opens the stream.
		snapshot(7_000)
		emitRef!(incremental(8_000))
		await recorder.flush()
		const recovered = posted.at(-1)!
		expect(recovered.meta.isCheckpoint).toBe(true)
		expect(recovered.meta.eventCount).toBe(3)

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

		/**
		 * Record two events and flush them on the way out, under `chunkSeq`. Larger
		 * than an unload chunk may be, so it takes the compressed, stored path.
		 */
		const unloadFlush = (sessionId: string, chunkSeq: number) => {
			const recorder = startRecording(CONFIG, sessionId)
			const finishGzip = hangGzip()
			vi.mocked(nextChunkSeq).mockReturnValueOnce(chunkSeq)
			emitRef!(fullSnapshot(1_000), true)
			emitRef!(incremental(2_500, "x".repeat(30 * 1024)))
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

		it("is posted at once, before any await, when it is small enough", async () => {
			const recorder = startRecording(CONFIG, "session-1")
			vi.mocked(nextChunkSeq).mockReturnValueOnce(7)
			emitRef!(fullSnapshot(1_000), true)
			emitRef!(incremental(2_500))
			void recorder.flush(true)
			// Synchronously: a document being torn down runs nothing after this.
			expect(posted.map((chunk) => [chunk.meta.chunkSeq, chunk.keepalive])).toEqual([[7, true]])
			expect(stored()).toBeUndefined()
			recorder.stop()
			await nextStart()
			expect(posted).toHaveLength(1)
		})

		it("takes the stored path when the keepalive budget has no room for it now", async () => {
			const recorder = startRecording(CONFIG, "session-1")
			hangGzip()
			vi.mocked(reserveKeepalive).mockReturnValueOnce(undefined)
			vi.mocked(nextChunkSeq).mockReturnValueOnce(7)
			emitRef!(fullSnapshot(1_000), true)
			void recorder.flush(true)
			expect(posted).toEqual([])
			expect(stored()).toBeDefined()
			recorder.stop()
		})

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

		/** An unload flush whose compression finishes with no room left in the keepalive budget. */
		const fullBudgetFlush = async () => {
			vi.mocked(reserveKeepalive).mockReturnValueOnce(undefined)
			unloadFlush("session-1", 7)()
			await vi.advanceTimersByTimeAsync(0)
			// Posted without keepalive now, it would die with the page after its stored
			// copy was gone. A page that went away never gets further than this.
			expect(posted).toEqual([])
			expect(stored()).toBeDefined()
		}
		const postedKeepalive = () => posted.map((chunk) => [chunk.meta.chunkSeq, chunk.keepalive])

		it("waits when the keepalive budget is full, and a page still alive a second later posts it", async () => {
			await fullBudgetFlush()
			await vi.advanceTimersByTimeAsync(1_000)
			expect(postedKeepalive()).toEqual([[7, true]])
			expect(stored()).toBeUndefined()
		})

		it("waiting for keepalive room, is posted once when a recorder start comes first", async () => {
			await fullBudgetFlush()
			await nextStart()
			expect(postedKeepalive()).toEqual([[7, false]])
			await vi.advanceTimersByTimeAsync(1_000)
			await nextStart()
			expect(postedKeepalive()).toEqual([[7, false]])
		})

		it("waiting for keepalive room, is discarded by a consent revoke", async () => {
			await fullBudgetFlush()
			clearPendingChunk()
			await vi.advanceTimersByTimeAsync(1_000)
			expect(posted).toEqual([])
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
			emitRef!(incremental(1_500, "x".repeat(30 * 1024)))
			void recorder.flush(true)
			vi.mocked(nextChunkSeq).mockReturnValueOnce(8)
			emitRef!(incremental(2_000, "x".repeat(30 * 1024)))
			await recorder.flush(true)
			// The second chunk was not kept, so it uploads as it always did.
			expect(postedSeqs()).toEqual([8])

			await nextStart()
			expect(postedSeqs()).toEqual([8, 7])
		})

		it("is dropped by a recorder of another session, endpoint or ingest key", async () => {
			// Before this module loaded: stored by an earlier page of the tab.
			vi.setSystemTime(Date.now() - 60 * 60_000)
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

		it("is still sent, under its own session, when this page stored it and is shown again long after", async () => {
			unloadFlush("session-1", 7)
			await vi.advanceTimersByTimeAsync(40 * 60_000)
			// Hidden past the idle timeout: the page resumes under a rotated session.
			await nextStart("session-2")
			expect(posted.map((chunk) => [chunk.meta.sessionId, chunk.meta.chunkSeq])).toEqual([
				["session-1", 7],
			])
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

describe("rrweb's own failures", () => {
	it("are swallowed rather than surfacing as the host app's uncaught errors", () => {
		startRecording(CONFIG, "session-1").stop()
		const handler = recordOptions?.errorHandler
		expect(typeof handler === "function" && handler(new TypeError("observer failed"))).toBe(true)
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

const session = await import("../session/session")
const { postSessionBlob } = await import("../platform/transport")

describe("startRecording stream integrity", () => {
	const types = (chunk: PostedChunk | undefined) =>
		(JSON.parse(chunk?.body ?? "[]") as Array<{ type: number }>).map((event) => event.type)

	beforeEach(() => {
		posted.length = 0
		outcomes.length = 0
		stopFn.mockClear()
		takeFullSnapshot.mockReset()
		vi.mocked(session.markActivity).mockClear()
		vi.mocked(session.markReplayHalted).mockClear()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
		vi.mocked(session.markActivity).mockReset()
		vi.mocked(session.isReplayHalted).mockReturnValue(false)
	})

	it("marks a chunk as a checkpoint only when it carries a FullSnapshot", async () => {
		const recorder = startRecording(CONFIG, "session-1")
		emitRef!(incremental(1_000))
		emitRef!(meta(2_000), true)
		await recorder.flush()
		// The Meta stays behind for its FullSnapshot rather than closing a chunk on its own.
		expect(posted.map((chunk) => [chunk.meta.isCheckpoint, types(chunk)])).toEqual([
			[false, [INCREMENTAL]],
		])
		emitRef!(fullSnapshot(2_001), true)
		await recorder.flush()
		expect(posted.map((chunk) => [chunk.meta.isCheckpoint, types(chunk)])).toEqual([
			[false, [INCREMENTAL]],
			[true, [META, FULL_SNAPSHOT]],
		])
		recorder.stop()
	})

	it("never size-flushes between a Meta and its FullSnapshot", async () => {
		const recorder = startRecording(CONFIG, "session-1")
		// Just under the size threshold, so the Meta is what crosses it.
		emitRef!(incremental(1_000, "x".repeat(100 * 1024 - 80)))
		emitRef!(meta(2_000), true)
		await vi.advanceTimersByTimeAsync(0)
		expect(posted).toEqual([])
		emitRef!(fullSnapshot(2_001), true)
		await vi.advanceTimersByTimeAsync(0)
		expect(posted.map((chunk) => [chunk.meta.isCheckpoint, types(chunk)])).toEqual([
			[true, [INCREMENTAL, META, FULL_SNAPSHOT]],
		])
		recorder.stop()
	})

	it.each(["failed", "rejected"] as const)(
		"re-snapshots after a %s chunk and keeps nothing that depends on it",
		async (outcome) => {
			const recorder = startRecording(CONFIG, "session-1")
			takeFullSnapshot.mockImplementation(() => snapshot(Date.now()))
			snapshot(1_000)
			outcomes.push(outcome)
			await recorder.flush()
			const lostAt = posted.length
			// Emitted after the loss: these patch nodes the player never got.
			emitRef!(incremental(3_000))
			// The recovery snapshot waits out the backoff, never less than the ten-second floor.
			await vi.advanceTimersByTimeAsync(0)
			expect(takeFullSnapshot).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(10_000)
			expect(takeFullSnapshot).toHaveBeenCalledTimes(1)
			emitRef!(incremental(4_000))
			await recorder.flush()
			// What reaches ingest after the loss starts at the fresh snapshot.
			expect(posted.slice(lostAt).flatMap((chunk) => types(chunk))).toEqual([
				META,
				FULL_SNAPSHOT,
				INCREMENTAL,
			])
			recorder.stop()
		},
	)

	it("backs off re-snapshots while chunks keep failing", async () => {
		const recorder = startRecording(CONFIG, "session-1")
		const snapshotsAt: number[] = []
		takeFullSnapshot.mockImplementation(() => {
			snapshotsAt.push(Date.now())
			snapshot(Date.now())
		})
		snapshot(1_000)
		// An endpoint that never recovers (offline, a 404), flushed every second for five minutes.
		for (let second = 0; second < 300; second++) {
			outcomes.push("failed")
			await recorder.flush()
			await vi.advanceTimersByTimeAsync(1_000)
		}
		const gaps = snapshotsAt.slice(1).map((at, i) => at - (snapshotsAt[i] ?? at))
		expect(gaps.every((gap, i) => i === 0 || gap >= (gaps[i - 1] ?? 0))).toBe(true)
		expect(gaps.at(-1)).toBeGreaterThanOrEqual(60_000)
		// Fixed ten-second spacing would have been about 30.
		expect(snapshotsAt.length).toBeLessThan(12)
		recorder.stop()
	})

	it("drops a batch past the in-flight ceiling instead of holding it, and re-snapshots", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const recorder = startRecording(CONFIG, "session-1")
		const answers: Array<() => void> = []
		vi.mocked(postSessionBlob).mockImplementation(
			async (_config: unknown, meta: PostedChunk["meta"], bytes: Uint8Array) => {
				posted.push({ meta, body: new TextDecoder().decode(bytes), keepalive: false })
				return new Promise((resolve) => answers.push(() => resolve("accepted")))
			},
		)
		try {
			snapshot(1_000)
			for (let i = 0; i < 30; i++) {
				emitRef!(incremental(2_000 + i, "x".repeat(100 * 1024)))
				await vi.advanceTimersByTimeAsync(0)
			}
			// A slow network: about 2 MiB went out and everything past it was dropped.
			const inflight = posted.reduce((sum, chunk) => sum + chunk.body.length, 0)
			expect(inflight).toBeLessThanOrEqual(2 * 1024 * 1024)
			expect(posted.length).toBeLessThan(30)
			expect(takeFullSnapshot).not.toHaveBeenCalled()
			for (const answer of answers) answer()
			await vi.advanceTimersByTimeAsync(10_000)
			expect(takeFullSnapshot).toHaveBeenCalled()
		} finally {
			vi.mocked(postSessionBlob).mockImplementation(
				async (
					_config: unknown,
					meta: PostedChunk["meta"],
					bytes: Uint8Array,
					keepalive?: boolean,
				) => {
					posted.push({
						meta,
						body: new TextDecoder().decode(bytes),
						keepalive: keepalive ?? false,
					})
					return outcomes.shift() ?? "accepted"
				},
			)
			warn.mockRestore()
			recorder.stop()
		}
	})

	it("remembers a 413 on the session, so the next page of it does not record", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {})
		const recorder = startRecording(CONFIG, "session-1")
		snapshot(1_000)
		outcomes.push("exhausted")
		await recorder.flush()
		expect(session.markReplayHalted).toHaveBeenCalledWith("session-1")

		vi.mocked(session.isReplayHalted).mockReturnValue(true)
		emitRef = undefined
		const next = startRecording(CONFIG, "session-1")
		expect(emitRef).toBeUndefined()
		await next.flush()
		expect(posted).toHaveLength(1)
	})

	it("stops for good, with one warning, once the DOM keeps snapshotting over the cap", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const recorder = startRecording(CONFIG, "session-1")
		const huge = (timestamp: number) => {
			emitRef!(meta(timestamp), true)
			emitRef!({ type: FULL_SNAPSHOT, timestamp, data: { blob: "m".repeat(5 * 1024 * 1024) } }, true)
		}
		huge(1_000)
		huge(2_000)
		expect(stopFn).not.toHaveBeenCalled()
		huge(3_000)
		expect(stopFn).toHaveBeenCalledTimes(1)
		expect(session.markReplayHalted).toHaveBeenCalledWith("session-1")
		expect(warn.mock.calls.filter(([message]) => String(message).includes("DOM snapshot"))).toHaveLength(
			1,
		)
		// Never re-snapshotted to recover: that would serialize the same DOM again.
		expect(takeFullSnapshot).not.toHaveBeenCalled()
		await recorder.flush()
		expect(posted).toEqual([])
		warn.mockRestore()
	})

	it("does not post a chunk whose compression outlived a consent revoke", async () => {
		const recorder = startRecording(CONFIG, "session-1")
		let finish = () => {}
		vi.mocked(gzip).mockImplementationOnce(
			(bytes) => new Promise((resolve) => (finish = () => resolve(bytes))),
		)
		snapshot(1_000)
		void recorder.flush()
		await vi.advanceTimersByTimeAsync(1)
		const revokedAt = Date.now()
		vi.stubGlobal("localStorage", { getItem: () => String(revokedAt) })
		finish()
		await vi.advanceTimersByTimeAsync(0)
		expect(posted).toEqual([])
		recorder.stop()
	})

	it("counts only user input as activity, and drops page events once the session is idle", async () => {
		const recorder = startRecording(CONFIG, "session-1")
		snapshot(1_000)
		emitRef!(incremental(1_100)) // a DOM mutation
		expect(session.markActivity).not.toHaveBeenCalledWith("input")
		emitRef!({ type: INCREMENTAL, timestamp: 1_200, data: { source: 2, type: 2, id: 1, x: 0, y: 0 } })
		expect(session.markActivity).toHaveBeenCalledWith("input")

		// The stored session has gone idle.
		vi.mocked(session.markActivity).mockReturnValue(null)
		await vi.advanceTimersByTimeAsync(1_000)
		emitRef!(incremental(5_000))
		await recorder.flush()
		expect(types(posted.at(-1))).toEqual([META, FULL_SNAPSHOT, INCREMENTAL, INCREMENTAL])
		recorder.stop()
	})
})
