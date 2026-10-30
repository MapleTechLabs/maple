// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
// SAFETY-FILE: JSON in this test is emitted by the recorder under test before its fields are asserted.
// BOUNDARY: Test doubles mirror intentionally untyped external callbacks.
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type EmitFn = (event: unknown, isCheckout?: boolean) => void
let emitRef: EmitFn | undefined
/** rrweb's checkout: a Meta event, then the FullSnapshot, synchronously. */
const takeFullSnapshot = vi.fn(() => snapshot(1))

vi.mock("rrweb", () => {
	const record = (options: { emit: EmitFn }) => {
		emitRef = options.emit
		return () => {
			emitRef = undefined
		}
	}
	record.takeFullSnapshot = takeFullSnapshot
	return { record }
})

let nextSeq = 0
vi.mock("../session/session", () => ({
	markActivity: vi.fn(),
	isReplayHalted: vi.fn(() => false),
	markReplayHalted: vi.fn(),
	nextChunkSeq: vi.fn(() => nextSeq++),
}))

type Outcome = "accepted" | "rejected" | "failed" | "retry" | "exhausted" | "gzip-error"
interface Posted {
	seq: number
	isCheckpoint: boolean
	eventCount: number
	durationMs: number
	events: Array<{ type: number; uid: number; timestamp: number }>
	bytes: number
	outcome: Outcome
}
let posted: Posted[] = []
let outcomes: Outcome[] = []
let nextOutcome: Outcome = "accepted"

vi.mock("../platform/transport", () => ({
	gzip: vi.fn(async (bytes: Uint8Array) => {
		nextOutcome = outcomes.shift() ?? "accepted"
		if (nextOutcome === "gzip-error") {
			posted.push({
				...decode(bytes),
				seq: -1,
				isCheckpoint: false,
				eventCount: 0,
				durationMs: 0,
				outcome: nextOutcome,
			})
			throw new Error("compression failed")
		}
		return bytes
	}),
	gzipStored: vi.fn((bytes: Uint8Array) => bytes),
	postSessionBlob: vi.fn(
		async (
			_config: unknown,
			meta: { chunkSeq: number; isCheckpoint: boolean; eventCount: number; durationMs: number },
			bytes: Uint8Array,
		) => {
			posted.push({
				...decode(bytes),
				seq: meta.chunkSeq,
				isCheckpoint: meta.isCheckpoint,
				eventCount: meta.eventCount,
				durationMs: meta.durationMs,
				outcome: nextOutcome,
			})
			return nextOutcome
		},
	),
	reserveKeepalive: vi.fn(() => () => {}),
	warnDropped: vi.fn(),
}))

function decode(bytes: Uint8Array): { events: Posted["events"]; bytes: number } {
	const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
	if (!Array.isArray(parsed)) throw new Error("chunk body is not an array")
	return {
		bytes: bytes.byteLength,
		events: parsed.map((event: { type: number; timestamp: number; data: { uid: number } }) => ({
			type: event.type,
			uid: event.data.uid,
			timestamp: event.timestamp,
		})),
	}
}

const { startBufferedRecording, startRecording } = await import("./record")

const META = 4
const FULL_SNAPSHOT = 2
const INCREMENTAL = 3

interface Emitted {
	uid: number
	type: number
}
let emitted: Emitted[] = []
let clock = 1_000

function emit(type: number, size: number, source = 0): void {
	const uid = emitted.length
	emitted.push({ uid, type })
	clock += 7
	emitRef?.({ type, timestamp: clock, data: { uid, source, pad: "p".repeat(size) } }, type !== INCREMENTAL)
}

function snapshot(size: number): void {
	emit(META, 0)
	emit(FULL_SNAPSHOT, size)
}

type Command =
	| { kind: "snapshot"; size: number }
	| { kind: "incremental"; size: number; input: boolean }
	| { kind: "flush"; outcome: Outcome }
	| { kind: "outcome"; outcome: Outcome }
	| { kind: "wait"; ms: number }

const outcome = fc.constantFrom<Outcome>(
	"accepted",
	"accepted",
	"accepted",
	"rejected",
	"failed",
	"retry",
	"gzip-error",
	"exhausted",
)
const size = fc.oneof(fc.integer({ min: 0, max: 2_000 }), fc.integer({ min: 20_000, max: 120_000 }))
const command: fc.Arbitrary<Command> = fc.oneof(
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("snapshot" as const), size }) },
	{
		weight: 6,
		arbitrary: fc.record({ kind: fc.constant("incremental" as const), size, input: fc.boolean() }),
	},
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("flush" as const), outcome }) },
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("outcome" as const), outcome }) },
	{
		weight: 1,
		arbitrary: fc.record({ kind: fc.constant("wait" as const), ms: fc.integer({ min: 0, max: 20_000 }) }),
	},
)

const CONFIG = {
	endpoint: "https://ingest.test",
	sdk: "maple-test/0.0.0",
	maskAllInputs: true,
	maskAllText: false,
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe("startRecording, under any sequence of events, flushes and upload outcomes", () => {
	it("uploads every kept event once, in order, in well-formed chunks that reopen at a snapshot after a loss", async () => {
		await fc.assert(
			fc.asyncProperty(fc.array(command, { maxLength: 60 }), async (commands) => {
				vi.useFakeTimers()
				posted = []
				outcomes = []
				emitted = []
				nextSeq = 0
				const recorder = startRecording(CONFIG, "session-1")
				snapshot(500)
				for (const step of commands) {
					if (step.kind === "snapshot") snapshot(step.size)
					else if (step.kind === "incremental") emit(INCREMENTAL, step.size, step.input ? 2 : 0)
					else if (step.kind === "outcome") outcomes.push(step.outcome)
					else if (step.kind === "wait") await vi.advanceTimersByTimeAsync(step.ms)
					else {
						outcomes.push(step.outcome)
						await recorder.flush()
					}
					await vi.advanceTimersByTimeAsync(0)
				}
				// Drain: past any backoff and pending re-snapshot, every answer accepted.
				outcomes = []
				await vi.advanceTimersByTimeAsync(70_000)
				await recorder.flush()
				recorder.stop()

				const uploaded = posted.filter((chunk) => chunk.outcome !== "gzip-error")
				// Seqs strictly increase; the chunk header matches its body.
				for (let i = 1; i < uploaded.length; i++) {
					expect(uploaded[i]!.seq).toBeGreaterThan(uploaded[i - 1]!.seq)
				}
				for (const chunk of uploaded) {
					expect(chunk.eventCount).toBe(chunk.events.length)
					expect(chunk.durationMs).toBeGreaterThanOrEqual(0)
					expect(chunk.isCheckpoint).toBe(
						chunk.events.some((event) => event.type === FULL_SNAPSHOT),
					)
					// A Meta never closes a chunk without its FullSnapshot.
					expect(chunk.events.at(-1)?.type).not.toBe(META)
				}
				// Everything that went out is the emitted stream minus drops: in order, never twice.
				const sent = posted.flatMap((chunk) => chunk.events.map((event) => event.uid))
				for (let i = 1; i < sent.length; i++) expect(sent[i]!).toBeGreaterThan(sent[i - 1]!)

				// After anything was lost, the next kept event opens a snapshot.
				const kept = posted
					.filter((chunk) => chunk.outcome === "accepted")
					.flatMap((chunk) => chunk.events.map((event) => event.uid))
				const keptSet = new Set(kept)
				let previous = -1
				for (const [index, uid] of kept.entries()) {
					const lostBetween = emitted
						.slice(previous + 1, uid)
						.some((event) => !keptSet.has(event.uid))
					if (lostBetween) {
						expect(emitted[uid]?.type).toBe(META)
						expect(kept[index + 1]).toBe(uid + 1)
						expect(emitted[uid + 1]?.type).toBe(FULL_SNAPSHOT)
					}
					previous = uid
				}
			}),
			{ numRuns: 150 },
		)
	})
})

describe("startBufferedRecording, under any sequence of events", () => {
	it("drains at most two playable segments, oldest first, under the size cap", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.oneof(
						fc.record({ kind: fc.constant("snapshot" as const), size }),
						fc.record({ kind: fc.constant("incremental" as const), size, input: fc.boolean() }),
						fc.record({ kind: fc.constant("drain" as const) }),
					),
					{ maxLength: 80 },
				),
				async (commands) => {
					posted = []
					outcomes = []
					emitted = []
					nextSeq = 0
					const recorder = startBufferedRecording(CONFIG, "session-1")
					const drains: Posted[][] = []
					for (const step of commands) {
						if (step.kind === "snapshot") snapshot(step.size)
						else if (step.kind === "incremental") emit(INCREMENTAL, step.size, step.input ? 2 : 0)
						else {
							const before = posted.length
							await recorder.drain()
							drains.push(posted.slice(before))
						}
					}
					recorder.stop()

					for (const segments of drains) {
						expect(segments.length).toBeLessThanOrEqual(2)
						const uids = segments.flatMap((chunk) => chunk.events.map((event) => event.uid))
						for (let i = 1; i < uids.length; i++) expect(uids[i]!).toBeGreaterThan(uids[i - 1]!)
						const bytes = segments.reduce(
							(sum, chunk) => sum + chunk.bytes - chunk.events.length - 1,
							0,
						)
						expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024)
						for (const chunk of segments) {
							expect(chunk.events.map((event) => event.type).slice(0, 2)).toEqual([
								META,
								FULL_SNAPSHOT,
							])
							expect(chunk.isCheckpoint).toBe(true)
							expect(chunk.eventCount).toBe(chunk.events.length)
							expect(chunk.durationMs).toBeGreaterThanOrEqual(0)
						}
					}
				},
			),
			{ numRuns: 150 },
		)
	})
})
