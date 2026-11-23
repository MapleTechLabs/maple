import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Result, Schema } from "effect"
import {
	decodeLogsRequest,
	decodeMetricsRequest,
	decodeProfilesRequest,
	decodeTraceRequest,
	encodeExportResponse,
	encodeLogsRequest,
	encodeMetricsRequest,
	encodeProfilesExportResponse,
	encodeProfilesRequest,
	encodeTraceRequest,
} from "../src/otlp/proto"

// Golden data captured from protobufjs 8.8.1 (`toObject` with longs: String, bytes: String,
// enums: Number, defaults, arrays, oneofs), the decoder this module replaced.
const fixtures = join(import.meta.dirname, "fixtures/otlp-proto")
const signals = ["traces", "logs", "metrics", "profiles"] as const
type Signal = (typeof signals)[number]
const decoders = {
	traces: decodeTraceRequest,
	logs: decodeLogsRequest,
	metrics: decodeMetricsRequest,
	profiles: decodeProfilesRequest,
}
const encoders = {
	traces: encodeTraceRequest,
	logs: encodeLogsRequest,
	metrics: encodeMetricsRequest,
	profiles: encodeProfilesRequest,
}

const EdgeCases = Schema.Array(
	Schema.Struct({
		name: Schema.String,
		signal: Schema.Literals(signals),
		hex: Schema.String,
		expected: Schema.optionalKey(Schema.Unknown),
		fails: Schema.optionalKey(Schema.Boolean),
	}),
)
const edgeCases = Schema.decodeUnknownSync(EdgeCases)(
	JSON.parse(readFileSync(join(fixtures, "edge-cases.json"), "utf8")),
)
const golden = (signal: Signal) => ({
	bytes: new Uint8Array(readFileSync(join(fixtures, `${signal}.bin`))),
	expected: JSON.parse(readFileSync(join(fixtures, `${signal}.expected.json`), "utf8")),
})

describe("OTLP protobuf decoding matches the protobufjs output shape", () => {
	for (const signal of signals)
		it(`decodes the ${signal} fixture (every value kind, 64-bit extremes) exactly`, () => {
			const { bytes, expected } = golden(signal)
			expect(Result.getOrThrow(decoders[signal](bytes))).toStrictEqual(expected)
		})

	for (const { name, signal, hex, expected, fails } of edgeCases)
		it(name, () => {
			const decoded = decoders[signal](Buffer.from(hex, "hex"))
			if (fails === true) {
				expect(Result.isFailure(decoded)).toBe(true)
				if (Result.isFailure(decoded))
					expect(decoded.failure._tag).toBe("@maple/local-server/OtlpProtobufDecodeError")
			} else expect(Result.getOrThrow(decoded)).toStrictEqual(expected)
		})

	it("keeps unsigned and signed 64-bit values exact past 2^53", () => {
		const { bytes } = golden("metrics")
		const decoded = JSON.stringify(Result.getOrThrow(decodeMetricsRequest(bytes)))
		expect(decoded).toContain('"count":"18446744073709551615"')
		expect(decoded).toContain('"asInt":"-9223372036854775808"')
		expect(decoded).toContain('"9007199254740993"')
	})
})

describe("OTLP protobuf encoding", () => {
	for (const signal of signals)
		it(`re-encodes the decoded ${signal} fixture to bytes that decode the same`, () => {
			const { expected } = golden(signal)
			expect(Result.getOrThrow(decoders[signal](encoders[signal](expected)))).toStrictEqual(expected)
		})

	it("writes export responses byte for byte like protobufjs", () => {
		const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")
		expect(hex(encodeExportResponse("traces", 0, ""))).toBe("")
		expect(hex(encodeExportResponse("logs", 3, "bad span"))).toBe("0a0c08031208626164207370616e")
		expect(hex(encodeExportResponse("metrics", 5_000_000_000, "x"))).toBe("0a090880e497d012120178")
		expect(hex(encodeProfilesExportResponse(0, ""))).toBe("")
		expect(hex(encodeProfilesExportResponse(2, "dropped"))).toBe("0a0b0802120764726f70706564")
	})
})
