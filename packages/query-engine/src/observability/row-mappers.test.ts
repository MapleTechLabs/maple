import { describe, expect, it } from "vitest"
import type { TracesRootListOutput } from "../ch"
import { toSpanResult } from "./row-mappers"

const row = (overrides: Partial<TracesRootListOutput> = {}): TracesRootListOutput => ({
	traceId: "0af7651916cd43dd8448eb211c80319c",
	startTime: "2026-04-03 12:00:00.123456789",
	endTime: "2026-04-03 12:00:00.123456789",
	durationMicros: 12_500,
	spanCount: 1,
	services: ["checkout"],
	rootSpanId: "b7ad6b7169203331",
	rootSpanName: "POST /orders",
	rootSpanKind: "Server",
	rootSpanStatusCode: "Unset",
	rootSpanStatusMessage: "",
	rootHttpMethod: "POST",
	rootHttpRoute: "/orders",
	rootHttpStatusCode: "201",
	rootSpanAttributes: '{"http.method":"POST","http.route":"/orders","url.full":""}',
	hasError: 0,
	...overrides,
})

describe("toSpanResult", () => {
	it("keeps the root span's id, status and projected attributes", () => {
		const span = toSpanResult(row())
		expect(span.spanId).toBe("b7ad6b7169203331")
		// The stored status, not a hasError-derived "Ok": the other trace paths
		// report `Unset` for the same span.
		expect(span.statusCode).toBe("Unset")
		expect(span.attributes).toEqual({ "http.method": "POST", "http.route": "/orders" })
		expect(span.durationMs).toBe(12.5)
		expect(span.serviceName).toBe("checkout")
	})

	it("carries an errored root's status message", () => {
		const span = toSpanResult(
			row({ rootSpanStatusCode: "Error", rootSpanStatusMessage: "upstream timeout", hasError: 1 }),
		)
		expect(span.statusCode).toBe("Error")
		expect(span.statusMessage).toBe("upstream timeout")
	})

	it("degrades a malformed attribute map or span id instead of failing the row", () => {
		const span = toSpanResult(row({ rootSpanAttributes: "{not json", rootSpanId: "" }))
		expect(span.attributes).toEqual({})
		expect(span.spanId).toBeNull()
	})

	it("falls back to hasError when the status column is empty", () => {
		expect(toSpanResult(row({ rootSpanStatusCode: "", hasError: 1 })).statusCode).toBe("Error")
		expect(toSpanResult(row({ rootSpanStatusCode: "", hasError: 0 })).statusCode).toBe("Unset")
	})
})
