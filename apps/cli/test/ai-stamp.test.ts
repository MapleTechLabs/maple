import { deepStrictEqual, ok, strictEqual } from "node:assert"
import { Result } from "effect"
import { describe, it } from "vitest"
import { spanIdHex, traceIdHex } from "../src/server/otlp/encode"
import { encodeTraceRequest } from "../src/server/otlp/proto"
import { __testables } from "../src/server/serve"

const TRACE_ID = "5b8efff798038103d269b633813fc60c"
const SPAN_ID = "eee19b7ec3c1b174"

const attrs = (pairs: Record<string, string>) =>
	Object.entries(pairs).map(([key, stringValue]) => ({ key, value: { stringValue } }))

// The gateway's own fixture, `vercel_v7_agent_call_and_tool` in
// apps/ingest/crates/ai-session/src/facts.rs, plus a forged stamp.
const request = (traceId: unknown, spanId: unknown) => ({
	resourceSpans: [
		{
			scopeSpans: [
				{
					scope: { name: "gen_ai" },
					spans: [
						{
							traceId,
							spanId,
							name: "chat openai/gpt-4o-mini",
							startTimeUnixNano: "1700000000000000000",
							endTimeUnixNano: "1700000001000000000",
							attributes: attrs({
								"gen_ai.operation.name": "chat",
								"gen_ai.request.model": "openai/gpt-4o-mini",
								"gen_ai.response.model": "openai/gpt-4o-mini-2024-07-18",
								"gen_ai.response.id": "gen-1",
								"maple_ai.tool_call": "1",
							}),
						},
					],
				},
			],
		},
	],
})

interface DecodedSpan {
	traceId: string
	spanId: string
	attributes: { key: string; value: { stringValue?: string } }[]
}

const stampsOf = (decoded: unknown) => {
	const [resourceSpans] = (decoded as { resourceSpans: { scopeSpans: { spans: DecodedSpan[] }[] }[] })
		.resourceSpans
	const span = resourceSpans!.scopeSpans[0]!.spans[0]!
	const stamps = span.attributes.filter(({ key }) => key.startsWith("maple_ai."))
	return {
		traceId: traceIdHex(span.traceId, "traceId"),
		spanId: spanIdHex(span.spanId, "spanId"),
		stamps: Object.fromEntries(stamps.map(({ key, value }) => [key, value.stringValue])),
	}
}

const expected = {
	traceId: TRACE_ID,
	spanId: SPAN_ID,
	stamps: {
		"maple_ai.vendor.id": "vercel_ai_sdk",
		"maple_ai.vendor.version": "0",
		"maple_ai.llm_call": "1",
		"maple_ai.model": "openai/gpt-4o-mini-2024-07-18",
		"maple_ai.response.id": "gen-1",
	},
}

describe("local ingest AI stamping", () => {
	it("stamps an OTLP/protobuf request like the gateway", () => {
		const bytes = encodeTraceRequest(request(Buffer.from(TRACE_ID, "hex"), Buffer.from(SPAN_ID, "hex")))
		const decoded = __testables.decodeOtlp("traces", bytes, "application/x-protobuf", null)
		ok(Result.isSuccess(decoded))
		deepStrictEqual(stampsOf(decoded.success), expected)
	})

	it("stamps an OTLP/JSON request and keeps its hex ids", () => {
		const body = new TextEncoder().encode(JSON.stringify(request(TRACE_ID, SPAN_ID)))
		const decoded = __testables.decodeOtlp("traces", body, "application/json", null)
		ok(Result.isSuccess(decoded))
		deepStrictEqual(stampsOf(decoded.success), expected)
	})

	it("rejects a body the gateway cannot decode", () => {
		const decoded = __testables.decodeOtlp(
			"traces",
			new Uint8Array([0x0a, 0xff]),
			"application/x-protobuf",
			null,
		)
		ok(Result.isFailure(decoded))
		strictEqual(decoded.failure._tag, "@maple/cli/OtlpDecodeFailed")
	})
})
