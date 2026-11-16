import { describe, expect, it } from "vitest"
import { Array as Arr, Option, Schema, String as Str } from "effect"
import type { SpanEvents } from "../shared/span-timeline.js"
import { type CpuProfile, encodeCpuProfile } from "./cpu-profile.js"

const TRACE = "0af7651916cd43dd8448eb211c80319c"
const SPAN_A = "b7ad6b7169203331"
const SPAN_B = "00f067aa0ba902b7"

const frame = (functionName: string, url = "file:///app/server.js", lineNumber = 9) => ({
	functionName,
	url,
	lineNumber,
})

// (root) -> main -> handle -> { parse, render }, and (root) -> (idle)
const profile: CpuProfile = {
	nodes: [
		{ id: 1, callFrame: frame("(root)", "", -1), children: [2, 6] },
		{ id: 2, callFrame: frame("main", "file:///app/server.js", 0), children: [3] },
		{ id: 3, callFrame: frame("handle"), children: [4, 5] },
		{ id: 4, callFrame: frame("parse", "file:///app/node_modules/qs/index.js", 40) },
		{ id: 5, callFrame: frame("", "file:///app/render.js", 2) },
		{ id: 6, callFrame: frame("(idle)", "", -1) },
	],
	startTime: 5_000_000,
	// One sample per millisecond: parse, parse, idle, render, parse.
	samples: [4, 4, 6, 5, 4],
	timeDeltas: [1000, 1000, 1000, 1000, 1000],
}

const options = {
	resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
	startedAtPerfMs: 100,
	startedAtEpochMs: 1_763_200_000_000,
	durationMs: 5,
	samplingIntervalMicros: 1000,
	profileId: Str.repeat(16)("aa"),
}

const Export = Schema.Struct({
	resourceProfiles: Schema.Tuple([
		Schema.Struct({
			scopeProfiles: Schema.Tuple([
				Schema.Struct({
					profiles: Schema.Tuple([
						Schema.Struct({
							samples: Schema.Array(
								Schema.Struct({
									stackIndex: Schema.Number,
									linkIndex: Schema.Number,
									values: Schema.Tuple([Schema.String]),
									timestampsUnixNano: Schema.Tuple([Schema.String]),
								}),
							),
							timeUnixNano: Schema.String,
							durationNano: Schema.String,
							period: Schema.String,
						}),
					]),
				}),
			]),
		}),
	]),
	dictionary: Schema.Struct({
		stringTable: Schema.Array(Schema.String),
		functionTable: Schema.Array(
			Schema.Struct({
				nameStrindex: Schema.optionalKey(Schema.Number),
				filenameStrindex: Schema.optionalKey(Schema.Number),
				startLine: Schema.optionalKey(Schema.Number),
			}),
		),
		locationTable: Schema.Array(
			Schema.Struct({
				lines: Schema.optionalKey(
					Schema.Array(Schema.Struct({ functionIndex: Schema.Number, line: Schema.Number })),
				),
			}),
		),
		stackTable: Schema.Array(
			Schema.Struct({ locationIndices: Schema.optionalKey(Schema.Array(Schema.Number)) }),
		),
		linkTable: Schema.Array(
			Schema.Struct({
				traceId: Schema.optionalKey(Schema.String),
				spanId: Schema.optionalKey(Schema.String),
			}),
		),
	}),
})

/** The export read back the way a receiver resolves it: each sample as names, leaf first. */
const read = (events?: SpanEvents) => {
	const body = Schema.decodeUnknownSync(Export)(
		encodeCpuProfile(profile, { ...options, spanEvents: events }),
	)
	const { dictionary } = body
	const only = body.resourceProfiles[0].scopeProfiles[0].profiles[0]
	const frameOf = (locationIndex: number) => {
		const line = dictionary.locationTable[locationIndex]?.lines?.[0]
		const fn = dictionary.functionTable[line?.functionIndex ?? 0]
		return {
			name: dictionary.stringTable[fn?.nameStrindex ?? 0],
			file: dictionary.stringTable[fn?.filenameStrindex ?? 0],
			line: line?.line,
		}
	}
	return {
		profile: only,
		samples: Arr.map(only.samples, (sample) => ({
			frames: Arr.map(dictionary.stackTable[sample.stackIndex]?.locationIndices ?? [], frameOf),
			span: dictionary.linkTable[sample.linkIndex]?.spanId,
			trace: dictionary.linkTable[sample.linkIndex]?.traceId,
			nanos: Number(sample.values[0]),
			at: sample.timestampsUnixNano[0],
		})),
	}
}

const events = (
	entries: ReadonlyArray<readonly [number, string | undefined]>,
	overflowed = false,
): SpanEvents => ({
	times: Float64Array.from(Arr.map(entries, ([time]) => time)),
	spans: Arr.map(entries, ([, spanId]) => (spanId === undefined ? undefined : { traceId: TRACE, spanId })),
	length: entries.length,
	overflowed,
})

describe("encodeCpuProfile", () => {
	it("folds samples per stack, leaf first, and leaves idle time out", () => {
		const { samples } = read()
		expect(
			Arr.map(samples, (sample) => [Arr.map(sample.frames, (each) => each.name), sample.nanos]),
		).toEqual([
			[["parse", "handle", "main"], 3_000_000],
			[["(anonymous)", "handle", "main"], 1_000_000],
		])
	})

	it("turns V8's zero-based lines and file URLs into one-based lines and paths", () => {
		const leaf = read().samples[0]?.frames[0]
		expect(leaf).toEqual({ name: "parse", file: "/app/node_modules/qs/index.js", line: 41 })
	})

	it("attributes each sample to the span that was running when it was taken", () => {
		// Samples land at perf 101, 102, (103 idle), 104, 105.
		const { samples } = read(
			events([
				[100.5, SPAN_A],
				[103.5, SPAN_B],
				[104.5, undefined],
			]),
		)
		expect(
			Arr.map(samples, (sample) => [sample.frames[0]?.name, sample.span, sample.trace, sample.nanos]),
		).toEqual([
			["parse", SPAN_A, TRACE, 2_000_000],
			["(anonymous)", SPAN_B, TRACE, 1_000_000],
			["parse", undefined, undefined, 1_000_000],
		])
	})

	it("stamps a span's slice with its first sample and the profile with its start", () => {
		const { profile: only, samples } = read(events([[103.5, SPAN_B]]))
		expect(only.timeUnixNano).toBe("1763200000000000000")
		const slice = Option.getOrUndefined(Arr.findFirst(samples, (sample) => sample.span === SPAN_B))
		expect(slice?.at).toBe("1763200000004000000")
		expect([only.durationNano, only.period]).toEqual(["5000000", "1000000"])
	})

	it("stops linking where the span log overflowed instead of guessing", () => {
		const { samples } = read(events([[100.5, SPAN_A]], true))
		expect(Arr.every(samples, (sample) => sample.span === undefined)).toBe(true)
	})

	it("caps a sample's time when the runtime stopped sampling across a gap", () => {
		const gappy: CpuProfile = { ...profile, samples: [4, 4], timeDeltas: [1000, 900_000] }
		const body = Schema.decodeUnknownSync(Export)(encodeCpuProfile(gappy, options))
		const values = Arr.map(body.resourceProfiles[0].scopeProfiles[0].profiles[0].samples, (sample) =>
			Number(sample.values[0]),
		)
		// The first sample's gap to the next is capped at one interval; the last gets one.
		expect(values).toEqual([2_000_000])
	})

	it("sends nothing for a window that was idle throughout", () => {
		expect(
			encodeCpuProfile({ ...profile, samples: [6, 6], timeDeltas: [1000, 1000] }, options),
		).toBeUndefined()
	})
})
