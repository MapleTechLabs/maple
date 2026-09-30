import { deepStrictEqual, ok, strictEqual } from "node:assert"
import { Result } from "effect"
import { describe, it } from "vitest"
import { spanIdHex, traceIdHex } from "../src/server/otlp/encode"
import { encodeTraceRequest } from "../src/server/otlp/proto"
import { __testables } from "../src/server/serve"

const TRACE_ID = "5b8efff798038103d269b633813fc60c"
const SPAN_ID = "eee19b7ec3c1b174"
const PARENT_ID = "0102030405060708"
const LINKED_TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
// Several MiB, so the wasm memory has to grow mid-request.
const LARGE = "x".repeat(8 * 1024 * 1024)

const attrs = (pairs: Record<string, string>) =>
	Object.entries(pairs).map(([key, stringValue]) => ({ key, value: { stringValue } }))

// The gateway's own fixture, `vercel_v7_agent_call_and_tool` in
// apps/ingest/crates/ai-session/src/facts.rs, plus a forged stamp. `id` spells
// the ids for the wire format.
const request = (id: (hex: string) => string | Uint8Array) => ({
	resourceSpans: [
		{
			scopeSpans: [
				{
					scope: { name: "gen_ai" },
					spans: [
						{
							traceId: id(TRACE_ID),
							spanId: id(SPAN_ID),
							parentSpanId: id(PARENT_ID),
							links: [{ traceId: id(LINKED_TRACE_ID), spanId: id(PARENT_ID) }],
							name: "chat openai/gpt-4o-mini",
							startTimeUnixNano: "1700000000000000000",
							endTimeUnixNano: "1700000001000000000",
							attributes: attrs({
								"gen_ai.operation.name": "chat",
								"gen_ai.request.model": "openai/gpt-4o-mini",
								"gen_ai.response.model": "openai/gpt-4o-mini-2024-07-18",
								"gen_ai.response.id": "gen-1",
								"maple_ai.tool_call": "1",
								"app.note": LARGE,
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
	parentSpanId: string
	links: { traceId: string; spanId: string }[]
	attributes: { key: string; value: { stringValue?: string } }[]
}

const stampsOf = (decoded: unknown) => {
	const [resourceSpans] = (decoded as { resourceSpans: { scopeSpans: { spans: DecodedSpan[] }[] }[] })
		.resourceSpans
	const span = resourceSpans!.scopeSpans[0]!.spans[0]!
	const stamps = span.attributes.filter(({ key }) => key.startsWith("maple_ai."))
	const [link] = span.links
	return {
		ids: [
			traceIdHex(span.traceId, "traceId"),
			spanIdHex(span.spanId, "spanId"),
			spanIdHex(span.parentSpanId, "parentSpanId"),
			traceIdHex(link!.traceId, "link.traceId"),
			spanIdHex(link!.spanId, "link.spanId"),
		],
		note: span.attributes.find(({ key }) => key === "app.note")?.value.stringValue?.length,
		stamps: Object.fromEntries(stamps.map(({ key, value }) => [key, value.stringValue])),
	}
}

const expected = {
	ids: [TRACE_ID, SPAN_ID, PARENT_ID, LINKED_TRACE_ID, PARENT_ID],
	note: LARGE.length,
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
		const bytes = encodeTraceRequest(request((hex) => Buffer.from(hex, "hex")))
		const decoded = __testables.decodeOtlp("traces", bytes, "application/x-protobuf", null)
		ok(Result.isSuccess(decoded))
		deepStrictEqual(stampsOf(decoded.success), expected)
	})

	it("stamps an OTLP/JSON request and keeps its hex ids", () => {
		const body = new TextEncoder().encode(JSON.stringify(request((hex) => hex)))
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
		// prost's error, so the rejection came from the stamping, as in the gateway.
		ok(decoded.failure.message.includes("failed to decode Protobuf message"), decoded.failure.message)
	})
})
