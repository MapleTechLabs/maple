import { describe, expect, it } from "vitest"
import { Array as Arr, Record as Rec, Result, Schema, String as Str } from "effect"
import insertMappings from "../schema/local-inserts.json"
import {
	checkOtlpProfilesJson,
	encodeProfiles,
	isSupportedProfilesVersion,
	MAX_FRAME_TEXT,
	MAX_STACK_DEPTH,
	ProfilesTooLarge,
} from "./profiles"
import { decodeProfilesRequest, encodeProfilesRequest } from "./proto"

const NOW_NANO = 1_763_200_000_000_000_000n
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const SPAN_ID = "b7ad6b7169203331"
const b64 = (hex: string): string => Buffer.from(hex, "hex").toString("base64")

const Row = Schema.Struct({
	timestamp: Schema.String,
	service_name: Schema.String,
	service_version: Schema.String,
	environment: Schema.String,
	resource_attributes: Schema.Record(Schema.String, Schema.String),
	profile_id: Schema.String,
	duration_nano: Schema.Number,
	sample_type: Schema.String,
	sample_unit: Schema.String,
	value: Schema.Number,
	samples: Schema.Number,
	frames: Schema.Array(Schema.String),
	frame_files: Schema.Array(Schema.String),
	frame_lines: Schema.Array(Schema.Number),
	trace_id: Schema.String,
	span_id: Schema.String,
	sample_attributes: Schema.Record(Schema.String, Schema.String),
})
const decodeRow = Schema.decodeUnknownSync(Schema.fromJsonString(Row))

/** Ids in call order, so a test names the profile each one went to. */
const countingIds = () => {
	let next = 0
	return () => Str.padStart(32, "0")((++next).toString(16))
}

const rowsOf = (request: unknown, newProfileId: () => string = countingIds()) => {
	const { batches, profileCount } = encodeProfiles(request, NOW_NANO, newProfileId)
	const rows = Arr.flatMap(batches, (batch) =>
		Arr.map(Str.split("\n")(batch.ndjson), (line) => decodeRow(line)),
	)
	return { rows, batches, profileCount }
}

// string table: 0 "", then names. Index 0 of every table is the spec's zero entry.
const STRINGS = [
	"",
	"cpu",
	"nanoseconds",
	"main",
	"handleRequest",
	"parseBody",
	"/app/server.js",
	"service.name",
	"checkout",
	"thread.name",
	"samples",
	"count",
	"libc.so.6",
]

const dictionary = {
	stringTable: STRINGS,
	functionTable: [
		{},
		{ nameStrindex: 3, filenameStrindex: 6, startLine: 1 },
		{ nameStrindex: 4, filenameStrindex: 6, startLine: 10 },
		{ nameStrindex: 5, filenameStrindex: 6, startLine: 40 },
	],
	mappingTable: [{}, { filenameStrindex: 12 }],
	locationTable: [
		{},
		{ lines: [{ functionIndex: 1, line: 3 }] },
		{ lines: [{ functionIndex: 2, line: 12 }] },
		// Inlined: parseBody was inlined into handleRequest, innermost first.
		{
			lines: [
				{ functionIndex: 3, line: 44 },
				{ functionIndex: 2, line: 15 },
			],
		},
		{ mappingIndex: 1, address: 4660 },
	],
	// Leaf first on the wire.
	stackTable: [
		{},
		{ locationIndices: [2, 1] },
		{ locationIndices: [3, 1] },
		{ locationIndices: [4, 2, 1] },
	],
	linkTable: [{}, { traceId: b64(TRACE_ID), spanId: b64(SPAN_ID) }],
	attributeTable: [{}, { keyStrindex: 9, value: { stringValue: "worker-1" } }],
}

const cpuRequest = (samples: ReadonlyArray<unknown>) => ({
	resourceProfiles: [
		{
			resource: {
				attributes: [
					// Key and value both interned, as collectors from v0.161 send them.
					{ keyStrindex: 7, value: { stringValueStrindex: 8 } },
					{ key: "service.version", value: { stringValue: "1.4.0" } },
					{ key: "deployment.environment.name", value: { stringValue: "prod" } },
				],
			},
			scopeProfiles: [
				{
					profiles: [
						{
							sampleType: { typeStrindex: 1, unitStrindex: 2 },
							timeUnixNano: "1763200000000000000",
							durationNano: "10000000000",
							profileId: b64(TRACE_ID),
							samples,
						},
					],
				},
			],
		},
	],
	dictionary,
})

describe("encodeProfiles", () => {
	it("writes one row per stack with root-first frames and the samples summed", () => {
		const { rows, profileCount } = rowsOf(
			cpuRequest([
				{ stackIndex: 1, values: ["4000000", "6000000"] },
				{ stackIndex: 1, values: ["5000000"] },
				{ stackIndex: 2, values: ["1000000"] },
			]),
		)
		expect(profileCount).toBe(1)
		expect(Arr.map(rows, (row) => [row.frames, row.value, row.samples])).toEqual([
			[["main", "handleRequest"], 15_000_000, 3],
			[["main", "handleRequest", "parseBody"], 1_000_000, 1],
		])
		expect(rows[0]?.frame_files).toEqual(["/app/server.js", "/app/server.js"])
		expect(rows[0]?.frame_lines).toEqual([3, 12])
		expect(rows[0]?.timestamp).toBe("2025-11-15 09:46:40.000000000")
	})

	it("resolves resource attributes sent as string-table indices", () => {
		const { rows } = rowsOf(cpuRequest([{ stackIndex: 1, values: ["1"] }]))
		expect(rows[0]).toMatchObject({
			service_name: "checkout",
			service_version: "1.4.0",
			environment: "prod",
		})
	})

	it("keeps a span's samples apart from the rest of the stack and stamps them with its first sample", () => {
		const { rows } = rowsOf(
			cpuRequest([
				{ stackIndex: 1, values: ["2"] },
				{
					stackIndex: 1,
					linkIndex: 1,
					attributeIndices: [1],
					values: ["3", "4"],
					timestampsUnixNano: ["1763200005000000000", "1763200004000000000"],
				},
			]),
		)
		expect(Arr.map(rows, (row) => [row.span_id, row.trace_id, row.value])).toEqual([
			["", "", 2],
			[SPAN_ID, TRACE_ID, 7],
		])
		expect(rows[1]?.timestamp).toBe("2025-11-15 09:46:44.000000000")
		expect(rows[1]?.sample_attributes).toEqual({ "thread.name": "worker-1" })
	})

	it("stores a sample-counting producer in the period's terms", () => {
		const request = cpuRequest([{ stackIndex: 1, timestampsUnixNano: ["1", "2", "3"] }])
		const profile = request.resourceProfiles[0]?.scopeProfiles[0]?.profiles[0]
		Object.assign(profile ?? {}, {
			sampleType: { typeStrindex: 10, unitStrindex: 11 },
			periodType: { typeStrindex: 1, unitStrindex: 2 },
			period: "50000000",
		})
		const { rows } = rowsOf(request)
		expect(rows[0]).toMatchObject({
			sample_type: "cpu",
			sample_unit: "nanoseconds",
			value: 150_000_000,
			samples: 3,
		})
	})

	it("names an unsymbolized frame by its mapping and address", () => {
		const { rows } = rowsOf(cpuRequest([{ stackIndex: 3, values: ["1"] }]))
		expect(rows[0]?.frames).toEqual(["main", "handleRequest", "libc.so.6+0x1234"])
	})

	it("drops a sample whose stack is empty", () => {
		expect(rowsOf(cpuRequest([{ stackIndex: 0, values: ["9"] }])).rows).toEqual([])
	})

	it("keeps the leaf side of a stack deeper than the cap", () => {
		const depth = MAX_STACK_DEPTH + 40
		const request = cpuRequest([{ stackIndex: 1, values: ["1"] }])
		request.dictionary = {
			...dictionary,
			// Leaf first: location 2 (handleRequest) is the leaf, the rest are `main`.
			stackTable: [{}, { locationIndices: [2, ...Arr.makeBy(depth - 1, () => 1)] }],
		}
		const frames = rowsOf(request).rows[0]?.frames ?? []
		expect(frames).toHaveLength(MAX_STACK_DEPTH)
		expect([frames[0], frames.at(-1)]).toEqual(["(truncated)", "handleRequest"])
	})

	it("reads a protobuf export the same as its JSON form", () => {
		const request = cpuRequest([
			{ stackIndex: 2, linkIndex: 1, values: ["5"], timestampsUnixNano: ["1763200001000000000"] },
		])
		const viaProto = rowsOf(Result.getOrThrow(decodeProfilesRequest(encodeProfilesRequest(request))))
		expect(viaProto.rows).toEqual(rowsOf(request).rows)
	})

	it("resolves string-table references nested in an array and in a map", () => {
		type Text = (index: number) => object
		const asArray = (text: Text) => ({
			arrayValue: { values: [text(8), { arrayValue: { values: [text(3)] } }, { intValue: "7" }] },
		})
		const asMap = (text: Text, key: Text) => ({
			kvlistValue: {
				values: [
					{ ...key(9), value: text(8) },
					{ ...key(7), value: { kvlistValue: { values: [{ ...key(1), value: text(2) }] } } },
				],
			},
		})
		// The same values on the resource and, through the attribute table, on the sample.
		const requestWith = (text: Text, key: Text) => {
			const request = cpuRequest([{ stackIndex: 1, attributeIndices: [1, 2], values: ["1"] }])
			const first = request.resourceProfiles[0]
			return {
				resourceProfiles: [
					{
						...first,
						resource: {
							attributes: [
								...(first?.resource.attributes ?? []),
								{ key: "tags", value: asArray(text) },
								{ key: "labels", value: asMap(text, key) },
							],
						},
					},
				],
				dictionary: {
					...dictionary,
					attributeTable: [
						{},
						{ keyStrindex: 9, value: asArray(text) },
						{ keyStrindex: 7, value: asMap(text, key) },
					],
				},
			}
		}
		const byReference = requestWith(
			(index) => ({ stringValueStrindex: index }),
			(index) => ({ keyStrindex: index }),
		)
		const inline = requestWith(
			(index) => ({ stringValue: STRINGS[index] }),
			(index) => ({ key: STRINGS[index] }),
		)
		const { rows } = rowsOf(byReference)
		const tags = '["checkout",["main"],"7"]'
		const labels = '{"thread.name":"checkout","service.name":{"cpu":"nanoseconds"}}'
		expect(rows).toEqual(rowsOf(inline).rows)
		expect(rows[0]?.resource_attributes).toMatchObject({ tags, labels })
		expect(rows[0]?.sample_attributes).toEqual({ "thread.name": tags, "service.name": labels })
		expect(
			rowsOf(Result.getOrThrow(decodeProfilesRequest(encodeProfilesRequest(byReference)))).rows,
		).toEqual(rows)
	})

	it("reads a null integer as unset", () => {
		const request = cpuRequest([{ stackIndex: 3, values: ["1"] }])
		const profile = request.resourceProfiles[0]?.scopeProfiles[0]?.profiles[0]
		Object.assign(profile ?? {}, { timeUnixNano: null, durationNano: null, period: null })
		const nulled = {
			...dictionary,
			functionTable: [
				{},
				{ nameStrindex: 3, filenameStrindex: 6, startLine: null },
				{ nameStrindex: 4, filenameStrindex: 6, startLine: 10 },
			],
			locationTable: [
				{},
				{ lines: [{ functionIndex: 1, line: null }] },
				{ lines: [{ functionIndex: 2, line: null }] },
				{},
				{ mappingIndex: 1, address: null },
			],
		}
		const body = { ...request, dictionary: nulled }
		expect(Result.isSuccess(checkOtlpProfilesJson(body))).toBe(true)
		const { rows } = rowsOf(body)
		expect(rows[0]).toMatchObject({
			timestamp: "2025-11-15 09:46:40.000000000",
			duration_nano: 0,
			frames: ["main", "handleRequest", "libc.so.6+0x0"],
			frame_lines: [0, 10, 0],
			value: 1,
		})
	})

	it("gives every profile without an id one of its own", () => {
		const request = cpuRequest([
			{ stackIndex: 1, values: ["1"] },
			{ stackIndex: 2, values: ["1"] },
		])
		const scope = request.resourceProfiles[0]?.scopeProfiles[0]
		const sent = scope?.profiles[0]
		const idless = [
			{ ...sent, profileId: undefined },
			{ ...sent, profileId: "" },
			{ ...sent, profileId: b64(Str.repeat(32)("0")) },
			{ ...sent, profileId: null },
		]
		const { rows } = rowsOf({
			...request,
			resourceProfiles: [{ scopeProfiles: [{ profiles: [sent, ...idless] }] }],
		})
		// Two rows per profile: the sent id is kept, the generated ones are in profile order.
		const generated = Arr.makeBy(4, (index) => Str.padStart(32, "0")(`${index + 1}`))
		expect(Arr.map(rows, (row) => row.profile_id)).toEqual(
			Arr.flatMap([TRACE_ID, ...generated], (id) => [id, id]),
		)
	})

	it("generates a 16-byte lowercase hex id by default", () => {
		const request = cpuRequest([{ stackIndex: 1, values: ["1"] }])
		const sent = request.resourceProfiles[0]?.scopeProfiles[0]?.profiles[0]
		const idless = { ...sent, profileId: undefined }
		const { batches } = encodeProfiles(
			{ ...request, resourceProfiles: [{ scopeProfiles: [{ profiles: [idless, idless] }] }] },
			NOW_NANO,
		)
		const ids = Arr.map(Str.split("\n")(batches[0]?.ndjson ?? ""), (line) => decodeRow(line).profile_id)
		expect(ids).toHaveLength(2)
		expect(ids[0]).toMatch(/^[0-9a-f]{32}$/)
		expect(ids[1]).toMatch(/^[0-9a-f]{32}$/)
		expect(ids[0]).not.toBe(ids[1])
	})

	it("emits exactly the fields the insert mapping reads", () => {
		const { batches } = rowsOf(cpuRequest([{ stackIndex: 1, values: ["1"] }]))
		const line = Str.split("\n")(batches[0]?.ndjson ?? "")[0] ?? "{}"
		const emitted = Rec.keys(
			Schema.decodeSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(line),
		)
		const selects = Arr.filter(
			insertMappings.datasources.profiles.selects,
			(name) => name !== insertMappings.orgPlaceholder,
		)
		expect([...emitted].sort()).toEqual([...selects].sort())
	})
})

describe("checkOtlpProfilesJson", () => {
	it("refuses a body whose tables have the wrong shape", () => {
		const result = checkOtlpProfilesJson({ dictionary: { stringTable: "nope" } })
		expect(Result.isFailure(result) && result.failure).toContain("invalid OTLP/JSON profiles body")
	})
})

describe("isSupportedProfilesVersion", () => {
	it.each([
		[null, true],
		["1", true],
		["2", false],
	])("header %s -> %s", (header, supported) => {
		expect(isSupportedProfilesVersion(header)).toBe(supported)
	})
})

describe("hostile input", () => {
	it("never builds a stack whole: a location inlining thousands of lines stays under the cap", () => {
		const request = cpuRequest([{ stackIndex: 1, values: ["1"] }])
		const inlined = { lines: Arr.makeBy(5000, () => ({ functionIndex: 1, line: 1 })) }
		request.dictionary = {
			...dictionary,
			locationTable: [{}, inlined],
			stackTable: [{}, { locationIndices: Arr.makeBy(5000, () => 1) }],
		}
		expect(rowsOf(request).rows[0]?.frames).toHaveLength(MAX_STACK_DEPTH)
	})

	it("cuts a function name or file path that would make one row unbounded", () => {
		const request = cpuRequest([{ stackIndex: 1, values: ["1"] }])
		request.dictionary = {
			...dictionary,
			stringTable: [...STRINGS.slice(0, 3), Str.repeat(50_000)("x"), ...STRINGS.slice(4)],
		}
		const row = rowsOf(request).rows[0]
		expect(row?.frames[0]).toHaveLength(MAX_FRAME_TEXT)
	})

	it("refuses a request whose rows pass the ceiling, to the byte", () => {
		// Few bytes on the wire, many in the rows: every sample is its own row of the same stack.
		const request = cpuRequest(Arr.makeBy(50, (index) => ({ stackIndex: index + 1, values: ["1"] })))
		request.dictionary = {
			...dictionary,
			stackTable: Arr.makeBy(51, () => ({ locationIndices: [2, 1] })),
		}
		const whole = encodeProfiles(request, NOW_NANO).batches[0]
		const bytes = Buffer.byteLength(whole?.ndjson ?? "")
		expect(whole?.rowCount).toBe(50)
		const at = (ceiling: number) => () => encodeProfiles(request, NOW_NANO, undefined, ceiling)
		expect(at(bytes)().batches[0]?.rowCount).toBe(50)
		expect(at(bytes - 1)).toThrow(ProfilesTooLarge)
		expect(at(1024)).toThrow(ProfilesTooLarge)
	})

	it("refuses an attribute whose references resolve past the ceiling before serializing it", () => {
		// 10,000 references to one 1 MiB entry: a few wire bytes each, about 10 GB once resolved.
		const big = Str.repeat(1024 * 1024)("x")
		const request = {
			resourceProfiles: [
				{
					resource: {
						attributes: [
							{
								key: "tags",
								value: {
									arrayValue: {
										values: Arr.makeBy(10_000, () => ({ stringValueStrindex: 1 })),
									},
								},
							},
						],
					},
					scopeProfiles: [{ profiles: [{ samples: [{ stackIndex: 1, values: ["1"] }] }] }],
				},
			],
			dictionary: { stringTable: ["", big] },
		}
		const started = performance.now()
		expect(() => encodeProfiles(request, NOW_NANO)).toThrow(ProfilesTooLarge)
		// Stopped while resolving, long before 10 GB of text could be built.
		expect(performance.now() - started).toBeLessThan(2_000)
	})

	it("bounds the text the whole request resolves, not each attribute value alone", () => {
		// 500 attributes of 64 references each to a 1 MiB entry: each under the ceiling, 32 GB in all.
		const big = Str.repeat(1024 * 1024)("x")
		const attribute = (index: number) => ({
			key: `tags.${index}`,
			value: { arrayValue: { values: Arr.makeBy(64, () => ({ stringValueStrindex: 1 })) } },
		})
		const request = {
			resourceProfiles: [
				{
					resource: { attributes: Arr.makeBy(500, attribute) },
					scopeProfiles: [{ profiles: [{ samples: [{ stackIndex: 1, values: ["1"] }] }] }],
				},
			],
			dictionary: { stringTable: ["", big] },
		}
		const started = performance.now()
		expect(() => encodeProfiles(request, NOW_NANO)).toThrow(ProfilesTooLarge)
		expect(performance.now() - started).toBeLessThan(2_000)
	})

	it("counts a value sent as the wrong type, so it cannot switch the budget off", () => {
		// A number where a string belongs, beside the references the budget exists to stop.
		const big = Str.repeat(1024 * 1024)("x")
		const value = {
			stringValue: 5,
			arrayValue: { values: Arr.makeBy(10_000, () => ({ stringValueStrindex: 1 })) },
		}
		const request = {
			resourceProfiles: [
				{
					resource: { attributes: [{ key: "tags", value }] },
					scopeProfiles: [{ profiles: [{ samples: [{ stackIndex: 1, values: ["1"] }] }] }],
				},
			],
			dictionary: { stringTable: ["", big] },
		}
		const started = performance.now()
		expect(() => encodeProfiles(request, NOW_NANO)).toThrow(ProfilesTooLarge)
		expect(performance.now() - started).toBeLessThan(2_000)
	})

	it("stops on attributes every row repeats before it groups the samples they repeat in", () => {
		// One attribute-heavy profile, every sample its own group: the rows would repeat 2 MB each.
		const samples = Arr.makeBy(1_000, (index) => ({ stackIndex: 1, linkIndex: index, values: ["1"] }))
		// Unreadable, so reaching it while grouping would fail as something other than too large.
		const request = cpuRequest([...samples, { stackIndex: 1, values: ["not a number"] }])
		const keys = Arr.makeBy(2_000, (index) => `attribute.${index}`)
		request.dictionary = {
			...dictionary,
			stringTable: [...STRINGS, ...keys],
			attributeTable: Arr.makeBy(2_000, (index) => ({
				keyStrindex: STRINGS.length + index,
				value: { stringValue: Str.repeat(1_000)("x") },
			})),
		}
		Object.assign(request.resourceProfiles[0]?.scopeProfiles[0]?.profiles[0] ?? {}, {
			attributeIndices: Arr.makeBy(2_000, (index) => index),
		})
		const refused = () => encodeProfiles(request, NOW_NANO, undefined, 8 * 1024 * 1024)
		expect(refused).toThrow(ProfilesTooLarge)
	})

	it("counts a sample attribute that replaces a profile's once, at the size it is written", () => {
		// A 1 MB profile attribute every sample overrides with one character: the rows stay small.
		const request = cpuRequest(
			Arr.makeBy(100, (index) => ({
				stackIndex: 1,
				linkIndex: index,
				values: ["1"],
				attributeIndices: [2],
			})),
		)
		request.dictionary = {
			...dictionary,
			attributeTable: [
				{},
				{ keyStrindex: 9, value: { stringValue: Str.repeat(1024 * 1024)("x") } },
				{ keyStrindex: 9, value: { stringValue: "y" } },
			],
		}
		Object.assign(request.resourceProfiles[0]?.scopeProfiles[0]?.profiles[0] ?? {}, {
			attributeIndices: [1],
		})
		const { batches } = encodeProfiles(request, NOW_NANO, undefined, 1024 * 1024)
		expect(batches[0]?.rowCount).toBe(100)
	})

	it("stores values the columns cannot hold as their nearest bound, not as a failed insert", () => {
		const request = cpuRequest([{ stackIndex: 1, values: ["99999999999999999999"] }])
		const profile = request.resourceProfiles[0]?.scopeProfiles[0]?.profiles[0]
		Object.assign(profile ?? {}, { durationNano: "-5" })
		// A line number no Int32 holds, as a JSON sender can write it. On a copy: the fixture is shared.
		request.dictionary = structuredClone(dictionary)
		Object.assign(request.dictionary.locationTable[1]?.lines?.[0] ?? {}, {
			line: "100000000000000000000",
		})
		const { batches } = encodeProfiles(request, NOW_NANO)
		const row = Schema.decodeSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
			Str.split("\n")(batches[0]?.ndjson ?? "")[0] ?? "{}",
		)
		expect([row["value"], row["duration_nano"], row["frame_lines"]]).toEqual([
			"9223372036854775807",
			0,
			[0, 12],
		])
	})
})
