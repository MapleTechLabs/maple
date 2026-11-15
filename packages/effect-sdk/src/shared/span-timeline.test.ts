import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Tracer, Array as Arr } from "effect"
import { makeSpanTimeline, spanAt, type SpanEvents } from "./span-timeline.js"

const events = (
	entries: ReadonlyArray<readonly [number, string | undefined]>,
	overflowed = false,
): SpanEvents => ({
	times: Float64Array.from(Arr.map(entries, ([time]) => time)),
	spans: Arr.map(entries, ([, spanId]) => (spanId === undefined ? undefined : { traceId: "t", spanId })),
	length: entries.length,
	overflowed,
})

describe("spanAt", () => {
	const log = events([
		[10, "a"],
		[20, undefined],
		[30, "b"],
	])

	it.each([
		[5, undefined],
		[10, "a"],
		[19.9, "a"],
		[25, undefined],
		[30, "b"],
		[1000, "b"],
	])("at %d the running span is %s", (time, spanId) => {
		expect(spanAt(log, time)?.spanId).toBe(spanId)
	})

	it("knows nothing past the end of an overflowed log", () => {
		expect(spanAt(events([[10, "a"]], true), 11)).toBeUndefined()
	})
})

/** A tracer that names spans by their own name, so a test can read the timeline back. */
const namedTracer = Tracer.make({
	span: (options) => ({
		_tag: "Span",
		name: options.name,
		spanId: options.name,
		traceId: "trace",
		parent: options.parent,
		annotations: options.annotations,
		links: options.links,
		sampled: true,
		kind: options.kind,
		status: { _tag: "Started", startTime: options.startTime },
		attributes: new Map(),
		end: () => undefined,
		attribute: () => undefined,
		event: () => undefined,
		addLinks: () => undefined,
	}),
})

const recording = () => {
	let clock = 0
	const timeline = makeSpanTimeline({ now: () => ++clock })
	timeline.setRecording(true)
	return { timeline, layer: Layer.succeed(Tracer.Tracer, timeline.instrument(namedTracer)) }
}

const spansOf = (drained: SpanEvents): ReadonlyArray<string | undefined> =>
	Arr.map(Arr.take(drained.spans, drained.length), (span) => span?.spanId)

describe("makeSpanTimeline", () => {
	it.effect("records each span as it takes the CPU, and nothing once the fibers have stopped", () => {
		const { timeline, layer } = recording()
		return Effect.gen(function* () {
			yield* Effect.void.pipe(Effect.withSpan("inner"), Effect.withSpan("outer"))
			// The microtask that closes the turn runs once this fiber yields to the event loop.
			yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
			const spans = spansOf(timeline.drain())
			expect(Arr.filter(spans, (span) => span !== undefined)).toEqual(["outer", "inner", "outer"])
			expect(spans).toContain(undefined)
		}).pipe(Effect.provide(layer))
	})

	it.effect("tells two interleaved fibers apart", () => {
		const { timeline, layer } = recording()
		const step = (name: string) =>
			Effect.yieldNow.pipe(Effect.andThen(Effect.yieldNow), Effect.withSpan(name))
		return Effect.gen(function* () {
			yield* Effect.all([step("left"), step("right")], { concurrency: "unbounded" })
			const spans = Arr.filter(spansOf(timeline.drain()), (span) => span !== undefined)
			// Each resumes after the other's yield, so the log alternates rather than running one out.
			expect(Arr.filter(spans, (span) => span === "left").length).toBeGreaterThan(1)
			expect(Arr.filter(spans, (span) => span === "right").length).toBeGreaterThan(1)
		}).pipe(Effect.provide(layer))
	})

	it.effect("opens the next window with the span still running", () => {
		const { timeline, layer } = recording()
		return Effect.gen(function* () {
			const carried = yield* Effect.sync(() => {
				timeline.drain()
				return spansOf(timeline.drain())
			}).pipe(Effect.withSpan("long"))
			expect(carried).toEqual(["long"])
		}).pipe(Effect.provide(layer))
	})

	it.effect("marks the log overflowed past its capacity and keeps what it has", () => {
		let clock = 0
		const timeline = makeSpanTimeline({ capacity: 2, now: () => ++clock })
		timeline.setRecording(true)
		return Effect.gen(function* () {
			yield* Effect.void.pipe(Effect.withSpan("c"), Effect.withSpan("b"), Effect.withSpan("a"))
			const drained = timeline.drain()
			expect([drained.length, drained.overflowed]).toEqual([2, true])
		}).pipe(Effect.provide(Layer.succeed(Tracer.Tracer, timeline.instrument(namedTracer))))
	})

	it.effect("opens the log with the span already running when recording starts", () => {
		const timeline = makeSpanTimeline()
		return Effect.gen(function* () {
			const opened = yield* Effect.sync(() => {
				timeline.setRecording(true)
				return spansOf(timeline.drain())
			}).pipe(Effect.withSpan("long"))
			expect(opened).toEqual(["long"])
		}).pipe(Effect.provide(Layer.succeed(Tracer.Tracer, timeline.instrument(namedTracer))))
	})

	it.effect("records nothing while recording is off", () => {
		const timeline = makeSpanTimeline()
		return Effect.gen(function* () {
			yield* Effect.void.pipe(Effect.withSpan("quiet"))
			expect(timeline.drain().length).toBe(0)
		}).pipe(Effect.provide(Layer.succeed(Tracer.Tracer, timeline.instrument(namedTracer))))
	})
})
