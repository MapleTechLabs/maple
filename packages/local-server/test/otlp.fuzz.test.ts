import { describe, expect, it } from "vitest"
import fc from "fast-check"
import insertMappings from "../src/schema/local-inserts.json"
import { Result, Schema } from "effect"
import { encodeLogs, encodeMetrics, encodeTraces, OtlpFieldError } from "../src/otlp/encode"
import { checkOtlpJson } from "../src/otlp/json"
import {
	decodeLogsRequest,
	decodeMetricsRequest,
	decodeTraceRequest,
	encodeTraceRequest,
} from "../src/otlp/proto"

// Any body a sender posts to /v1/{traces,logs,metrics} must end as rows that fit
// the datasource's columns, or as an OtlpFieldError (a 400 naming the field).
// Anything else the encoders throw is a 500 for the sender's mistake.

const decodeManifest = Schema.decodeUnknownSync(
	Schema.Struct({
		datasources: Schema.Record(Schema.String, Schema.Struct({ inputSchema: Schema.String })),
	}),
)

/** `name Type, ...` from the insert manifest, split on top-level commas. */
const columns = (datasource: string): Map<string, string> => {
	const { inputSchema } = decodeManifest(insertMappings).datasources[datasource]!
	const result = new Map<string, string>()
	let depth = 0
	let token = ""
	const flush = () => {
		const trimmed = token.trim()
		const space = trimmed.indexOf(" ")
		if (space > 0) result.set(trimmed.slice(0, space), trimmed.slice(space + 1).trim())
		token = ""
	}
	for (const ch of inputSchema) {
		if (ch === "(") depth++
		else if (ch === ")") depth--
		if (ch === "," && depth === 0) flush()
		else token += ch
	}
	flush()
	return result
}

const isInteger = (value: unknown) =>
	(typeof value === "number" && Number.isInteger(value)) ||
	(typeof value === "string" && /^-?\d+$/.test(value))

/** Does a JSON value fit a ClickHouse column type, as JSONEachRow would read it? */
const fits = (type: string, value: unknown): boolean => {
	const inner = (prefix: string) => type.slice(prefix.length, -1)
	if (type.startsWith("Nullable(")) return value === null || fits(inner("Nullable("), value)
	if (type.startsWith("LowCardinality(")) return fits(inner("LowCardinality("), value)
	if (type.startsWith("Array("))
		return Array.isArray(value) && value.every((item) => fits(inner("Array("), item))
	if (type.startsWith("Map("))
		return (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			Object.values(value).every((item) => typeof item === "string")
		)
	if (type === "String" || type.startsWith("DateTime64")) return typeof value === "string"
	if (/^U?Int\d+$/.test(type)) return isInteger(value)
	if (type === "Float64") return typeof value === "number" || typeof value === "string"
	if (type === "Bool") return typeof value === "boolean" || value === 0 || value === 1
	return false
}

const decodeRow = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

/** Encode, then hold every emitted row to its datasource's columns. */
const assertRowsFit = (encode: () => ReturnType<typeof encodeTraces>) => {
	let batches: ReturnType<typeof encodeTraces>
	try {
		batches = encode()
	} catch (error) {
		// The one acceptable failure: a 400 that names the field.
		expect(error instanceof OtlpFieldError ? "OtlpFieldError" : String(error)).toBe("OtlpFieldError")
		return
	}
	for (const batch of batches) {
		const schema = columns(batch.datasource)
		const lines = batch.ndjson.split("\n")
		expect(lines).toHaveLength(batch.rowCount)
		for (const line of lines) {
			const row = decodeRow(line)
			for (const [name, value] of Object.entries(row)) {
				const type = schema.get(name)
				expect({ column: name, type, fits: type !== undefined && fits(type, value) }).toEqual({
					column: name,
					type,
					fits: true,
				})
			}
		}
	}
}

// --- generators -------------------------------------------------------------

/** A value of the wrong JSON type, where a sender got the shape wrong. */
const wrongType = fc.oneof(
	fc.constant(null),
	fc.integer(),
	fc.double(),
	fc.boolean(),
	fc.string({ maxLength: 8 }),
	fc.constant({}),
	fc.constant([]),
	fc.constant([1, "x"]),
	fc.constant({ nested: { deeper: [] } }),
	// Strings where numbers, ids or base64 belong.
	fc.constantFrom(
		"",
		"!",
		"NaN",
		"-1",
		"1e400",
		"0x10",
		" 1",
		"9".repeat(30),
		"-9".repeat(12),
		"1.5",
		"==",
	),
)

/** Mostly the right shape; now and then the wrong type in its place. */
const w = <T>(arb: fc.Arbitrary<T>, mangled: boolean): fc.Arbitrary<unknown> =>
	mangled ? fc.oneof({ weight: 6, arbitrary: arb }, { weight: 1, arbitrary: wrongType }) : arb

const id = (bytes: number) =>
	fc.oneof(
		fc.uint8Array({ minLength: bytes, maxLength: bytes }).map((b) => Buffer.from(b).toString("base64")),
		fc.constant(""),
	)
const nanos = fc.oneof(
	fc.bigInt({ min: 0n, max: 2n ** 63n - 1n }).map(String),
	fc.integer({ min: 0 }),
	fc.constant("0"),
)

const otlpBodies = (mangled: boolean) => {
	const { anyValue } = fc.letrec<{ anyValue: unknown; keyValue: unknown }>((tie) => ({
		anyValue: fc.oneof(
			{ depthSize: "small" },
			fc.record({ stringValue: w(fc.string(), mangled) }),
			fc.record({ boolValue: w(fc.boolean(), mangled) }),
			fc.record({ intValue: w(fc.oneof(fc.integer(), fc.bigInt().map(String)), mangled) }),
			fc.record({
				doubleValue: w(
					fc.oneof(fc.double(), fc.constantFrom("NaN", "Infinity", "-Infinity")),
					mangled,
				),
			}),
			fc.record({ bytesValue: mangled ? fc.oneof(id(4), fc.string({ maxLength: 6 })) : id(4) }),
			fc.record({
				arrayValue: fc.record({ values: w(fc.array(tie("anyValue"), { maxLength: 3 }), mangled) }),
			}),
			fc.record({
				kvlistValue: fc.record({ values: w(fc.array(tie("keyValue"), { maxLength: 3 }), mangled) }),
			}),
			fc.constant({}),
		),
		keyValue: fc.record(
			{ key: w(fc.string(), mangled), value: w(tie("anyValue"), mangled) },
			{ requiredKeys: [] },
		),
	}))
	const attributes = w(
		fc.array(
			fc.record({ key: w(fc.string(), mangled), value: w(anyValue, mangled) }, { requiredKeys: [] }),
			{
				maxLength: 4,
			},
		),
		mangled,
	)
	const resource = w(fc.record({ attributes }, { requiredKeys: [] }), mangled)
	const scope = w(
		fc.record(
			{ name: w(fc.string(), mangled), version: w(fc.string(), mangled), attributes },
			{ requiredKeys: [] },
		),
		mangled,
	)
	const span = fc.record(
		{
			traceId: w(id(16), mangled),
			spanId: w(id(8), mangled),
			parentSpanId: w(id(8), mangled),
			traceState: w(fc.string(), mangled),
			name: w(fc.string(), mangled),
			kind: w(fc.integer({ min: 0, max: 5 }), mangled),
			startTimeUnixNano: w(nanos, mangled),
			endTimeUnixNano: w(nanos, mangled),
			attributes,
			events: w(
				fc.array(
					fc.record(
						{ timeUnixNano: w(nanos, mangled), name: w(fc.string(), mangled), attributes },
						{
							requiredKeys: [],
						},
					),
					{ maxLength: 2 },
				),
				mangled,
			),
			links: w(
				fc.array(
					fc.record(
						{
							traceId: w(id(16), mangled),
							spanId: w(id(8), mangled),
							traceState: w(fc.string(), mangled),
							attributes,
						},
						{ requiredKeys: [] },
					),
					{ maxLength: 2 },
				),
				mangled,
			),
			status: w(
				fc.record(
					{ code: w(fc.integer({ min: 0, max: 2 }), mangled), message: w(fc.string(), mangled) },
					{
						requiredKeys: [],
					},
				),
				mangled,
			),
		},
		{ requiredKeys: [] },
	)
	const traces = fc.record(
		{
			resourceSpans: w(
				fc.array(
					fc.record(
						{
							resource,
							schemaUrl: w(fc.string(), mangled),
							scopeSpans: w(
								fc.array(
									fc.record(
										{
											scope,
											schemaUrl: w(fc.string(), mangled),
											spans: w(fc.array(span, { maxLength: 3 }), mangled),
										},
										{ requiredKeys: [] },
									),
									{ maxLength: 2 },
								),
								mangled,
							),
						},
						{ requiredKeys: [] },
					),
					{ maxLength: 2 },
				),
				mangled,
			),
		},
		{ requiredKeys: [] },
	)
	const logRecord = fc.record(
		{
			timeUnixNano: w(nanos, mangled),
			observedTimeUnixNano: w(nanos, mangled),
			severityNumber: w(fc.integer({ min: 0, max: 24 }), mangled),
			severityText: w(fc.string(), mangled),
			body: w(anyValue, mangled),
			attributes,
			flags: w(fc.integer({ min: 0, max: 255 }), mangled),
			traceId: w(id(16), mangled),
			spanId: w(id(8), mangled),
		},
		{ requiredKeys: [] },
	)
	const logs = fc.record(
		{
			resourceLogs: w(
				fc.array(
					fc.record(
						{
							resource,
							schemaUrl: w(fc.string(), mangled),
							scopeLogs: w(
								fc.array(
									fc.record(
										{
											scope,
											schemaUrl: w(fc.string(), mangled),
											logRecords: w(fc.array(logRecord, { maxLength: 3 }), mangled),
										},
										{ requiredKeys: [] },
									),
									{ maxLength: 2 },
								),
								mangled,
							),
						},
						{ requiredKeys: [] },
					),
					{ maxLength: 2 },
				),
				mangled,
			),
		},
		{ requiredKeys: [] },
	)
	const count = w(fc.oneof(fc.nat(), fc.nat().map(String)), mangled)
	const double = w(fc.oneof(fc.double(), fc.constantFrom("NaN", "Infinity", "-Infinity")), mangled)
	const exemplars = w(
		fc.array(
			fc.record(
				{
					traceId: w(id(16), mangled),
					spanId: w(id(8), mangled),
					timeUnixNano: w(nanos, mangled),
					asDouble: double,
					filteredAttributes: attributes,
				},
				{ requiredKeys: [] },
			),
			{ maxLength: 2 },
		),
		mangled,
	)
	const point = {
		attributes,
		startTimeUnixNano: w(nanos, mangled),
		timeUnixNano: w(nanos, mangled),
		exemplars,
		flags: w(fc.nat(255), mangled),
	}
	const numberPoint = fc.oneof(
		fc.record({ ...point, asDouble: double }, { requiredKeys: [] }),
		fc.record(
			{ ...point, asInt: w(fc.oneof(fc.integer(), fc.bigInt().map(String)), mangled) },
			{ requiredKeys: [] },
		),
	)
	const buckets = w(
		fc.record(
			{
				offset: w(fc.integer({ min: -100, max: 100 }), mangled),
				bucketCounts: w(fc.array(count, { maxLength: 4 }), mangled),
			},
			{ requiredKeys: [] },
		),
		mangled,
	)
	const histogramPoint = fc.record(
		{
			...point,
			count,
			sum: double,
			bucketCounts: w(fc.array(count, { maxLength: 4 }), mangled),
			explicitBounds: w(fc.array(double, { maxLength: 3 }), mangled),
			min: double,
			max: double,
		},
		{ requiredKeys: [] },
	)
	const expPoint = fc.record(
		{
			...point,
			count,
			sum: double,
			scale: w(fc.integer({ min: -10, max: 20 }), mangled),
			zeroCount: count,
			positive: buckets,
			negative: buckets,
			min: double,
			max: double,
		},
		{ requiredKeys: [] },
	)
	const points = <T>(arb: fc.Arbitrary<T>) => w(fc.array(arb, { maxLength: 3 }), mangled)
	const temporality = w(fc.integer({ min: 0, max: 2 }), mangled)
	const metric = fc.oneof(
		fc.record(
			{
				name: w(fc.string(), mangled),
				unit: w(fc.string(), mangled),
				gauge: w(fc.record({ dataPoints: points(numberPoint) }, { requiredKeys: [] }), mangled),
			},
			{ requiredKeys: [] },
		),
		fc.record(
			{
				name: w(fc.string(), mangled),
				sum: w(
					fc.record(
						{
							dataPoints: points(numberPoint),
							aggregationTemporality: temporality,
							isMonotonic: w(fc.boolean(), mangled),
						},
						{ requiredKeys: [] },
					),
					mangled,
				),
			},
			{ requiredKeys: [] },
		),
		fc.record(
			{
				name: w(fc.string(), mangled),
				histogram: w(
					fc.record(
						{ dataPoints: points(histogramPoint), aggregationTemporality: temporality },
						{ requiredKeys: [] },
					),
					mangled,
				),
			},
			{ requiredKeys: [] },
		),
		fc.record(
			{
				name: w(fc.string(), mangled),
				exponentialHistogram: w(
					fc.record(
						{ dataPoints: points(expPoint), aggregationTemporality: temporality },
						{ requiredKeys: [] },
					),
					mangled,
				),
			},
			{ requiredKeys: [] },
		),
	)
	const metrics = fc.record(
		{
			resourceMetrics: w(
				fc.array(
					fc.record(
						{
							resource,
							schemaUrl: w(fc.string(), mangled),
							scopeMetrics: w(
								fc.array(
									fc.record(
										{
											scope,
											schemaUrl: w(fc.string(), mangled),
											metrics: w(fc.array(metric, { maxLength: 3 }), mangled),
										},
										{ requiredKeys: [] },
									),
									{ maxLength: 2 },
								),
								mangled,
							),
						},
						{ requiredKeys: [] },
					),
					{ maxLength: 2 },
				),
				mangled,
			),
		},
		{ requiredKeys: [] },
	)
	return { traces, logs, metrics }
}

const valid = otlpBodies(false)
const mangled = otlpBodies(true)

/** Every path to a value inside `root`, the root itself included. */
const paths = (root: unknown): ReadonlyArray<ReadonlyArray<string | number>> => {
	const out: Array<ReadonlyArray<string | number>> = [[]]
	const walk = (value: unknown, at: ReadonlyArray<string | number>) => {
		if (Array.isArray(value)) value.forEach((item, i) => (out.push([...at, i]), walk(item, [...at, i])))
		else if (typeof value === "object" && value !== null)
			for (const [key, item] of Object.entries(value))
				(out.push([...at, key]), walk(item, [...at, key]))
	}
	walk(root, [])
	return out
}

/** `root` with the value at `path` replaced (a deep copy; the input is untouched).
 * BOUNDARY: generated bodies are arbitrary JSON by design; the encoders take `unknown`. */
const replaceAt = (root: unknown, path: ReadonlyArray<string | number>, replacement: unknown): unknown => {
	if (path.length === 0) return replacement
	const [head, ...rest] = path
	if (Array.isArray(root))
		return root.map((item, i) => (i === head ? replaceAt(item, rest, replacement) : item))
	const entries = typeof root === "object" && root !== null ? Object.entries(root) : []
	return Object.fromEntries(
		entries.map(([key, item]) => [key, key === head ? replaceAt(item, rest, replacement) : item]),
	)
}

/**
 * A well-formed body with exactly one value of the wrong type. One mistake at a
 * time is what reaches the encoders: a body with several is almost always
 * refused at the boundary before any of them is read.
 */
const oneWrongValue = <T>(arb: fc.Arbitrary<T>) =>
	fc.tuple(arb, fc.nat(), wrongType).map(([body, pick, bad]) => {
		const all = paths(body)
		return replaceAt(body, all[pick % all.length]!, bad)
	})

describe("OTLP protobuf ingest", () => {
	it("encodes every span of a well-formed request into rows that fit the traces columns", () => {
		fc.assert(
			fc.property(valid.traces, (request) => {
				const decoded = decodeTraceRequest(encodeTraceRequest(request))
				assertRowsFit(() => encodeTraces(decoded))
			}),
			{ numRuns: 300 },
		)
	})

	it("turns arbitrary bytes into a decode error or rows that fit", () => {
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
				for (const [decode, encode] of [
					[decodeTraceRequest, encodeTraces],
					[decodeLogsRequest, encodeLogs],
					[decodeMetricsRequest, encodeMetrics],
				] as const) {
					let decoded: unknown
					try {
						decoded = decode(bytes)
					} catch {
						continue // OtlpDecodeFailed: a 400
					}
					assertRowsFit(() => encode(decoded))
				}
			}),
			{ numRuns: 500 },
		)
	})
})

/** The JSON ingest path: a 400 at the shape check, or rows that fit. */
const ingestJson = (signal: "traces" | "logs" | "metrics", body: unknown) => {
	const checked = checkOtlpJson(signal, body)
	if (Result.isFailure(checked)) return
	const encode = { traces: encodeTraces, logs: encodeLogs, metrics: encodeMetrics }[signal]
	assertRowsFit(() => encode(checked.success))
}

describe("OTLP JSON ingest", () => {
	const validBySignal: Record<"traces" | "logs" | "metrics", fc.Arbitrary<unknown>> = valid
	for (const signal of ["traces", "logs", "metrics"] as const)
		it(`handles any single wrong value in a ${signal} body`, () => {
			fc.assert(
				fc.property(oneWrongValue(validBySignal[signal]), (body) => ingestJson(signal, body)),
				{ numRuns: 2000 },
			)
		})

	it("rejects a malformed trace body at the boundary or stores rows that fit", () => {
		fc.assert(
			fc.property(mangled.traces, (body) => ingestJson("traces", body)),
			{ numRuns: 1000 },
		)
	})

	it("rejects a malformed log body at the boundary or stores rows that fit", () => {
		fc.assert(
			fc.property(mangled.logs, (body) => ingestJson("logs", body)),
			{ numRuns: 1000 },
		)
	})

	it("rejects a malformed metrics body at the boundary or stores rows that fit", () => {
		fc.assert(
			fc.property(mangled.metrics, (body) => ingestJson("metrics", body)),
			{ numRuns: 1000 },
		)
	})

	it("stores every well-formed metrics body as rows that fit", () => {
		fc.assert(
			fc.property(valid.metrics, (body) => {
				expect(Result.isSuccess(checkOtlpJson("metrics", body))).toBe(true)
				ingestJson("metrics", body)
			}),
			{ numRuns: 500 },
		)
	})

	it("accepts every well-formed body the protobuf path would", () => {
		fc.assert(
			fc.property(valid.traces, valid.logs, (traces, logs) => {
				expect(Result.isSuccess(checkOtlpJson("traces", traces))).toBe(true)
				expect(Result.isSuccess(checkOtlpJson("logs", logs))).toBe(true)
			}),
			{ numRuns: 300 },
		)
	})

	it("survives any JSON value as a body", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (body) => {
				ingestJson("traces", body)
				ingestJson("logs", body)
				ingestJson("metrics", body)
			}),
			{ numRuns: 300 },
		)
	})
})
