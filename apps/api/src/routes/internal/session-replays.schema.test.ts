import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { SessionReplayListItem, SessionTraceSummary } from "@maple/domain/http"

// Regression for the prod 500 on the replay list: self-recorded
// sessions store UserId="" (no Clerk user passed to MapleBrowser.init), and
// UserId enforces isMinLength(1). The list/detail responses must permit a
// missing user id, and the handler maps "" -> null before decoding.
const decodeItem = Schema.decodeUnknownSync(SessionReplayListItem)

const baseRow = {
	sessionId: "999ea7ec-831a-49b2-b9f7-9001d3c586c2",
	startTime: "2026-05-26 08:29:26.243",
	endTime: null,
	durationMs: null,
	status: "ended",
	lastActivityAt: "2026-07-15 09:18:30",
	userId: null,
	// `""` is the never-identified state (see SessionReplayListItem), which is
	// what an anonymous `userId: null` row carries.
	userName: "",
	userEmail: "",
	groupId: "",
	groupName: "",
	visitorId: "b0f2b0c6-8a9f-4a1f-9a0e-2b4f9e2f1a77",
	utmSource: "",
	entryPath: "/",
	urlInitial: "https://app.maple.dev/",
	browserName: "Chrome",
	osName: "macOS",
	deviceType: "desktop",
	country: "",
	serviceName: "maple-web",
	pageViews: 1,
	clickCount: 0,
	errorCount: 0,
	traceCount: 0,
	recorded: "true",
}

describe("SessionReplayListItem.userId", () => {
	it("accepts a null userId (anonymous sessions)", () => {
		expect(decodeItem(baseRow).userId).toBeNull()
	})

	it("accepts a non-empty userId", () => {
		expect(decodeItem({ ...baseRow, userId: "user_123" }).userId).toBe("user_123")
	})

	it("rejects an empty-string userId — why the handler must map '' -> null", () => {
		expect(() => decodeItem({ ...baseRow, userId: "" })).toThrow()
	})
})

// Regression for the prod 500 on the replay list: `traceCount` is
// `length(TraceIds)` (UInt64), which the ClickHouse driver JSON-quotes as a
// string (the Tinybird path returns a number). The Schema.Number response field
// rejects the string, dying as an undeclared defect → bodyless 500. The handler
// must coerce row.traceCount -> Number before constructing the response.
describe("SessionReplayListItem.traceCount (ClickHouse UInt64-as-string)", () => {
	it("rejects a string traceCount — why the handler must coerce with Number()", () => {
		expect(() => decodeItem({ ...baseRow, traceCount: "3" })).toThrow()
	})

	it("the handler's Number() coercion yields a numeric traceCount", () => {
		const item = decodeItem({ ...baseRow, traceCount: Number("3") })
		expect(item.traceCount).toBe(3)
	})
})

// Same UInt64-as-string hazard for traceSummaries: `spanCount` is `count()`.
const decodeSummary = Schema.decodeUnknownSync(SessionTraceSummary)

const baseSummary = {
	traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
	startTime: "2026-05-26 08:29:26.243",
	durationMs: 12,
	rootSpanName: "GET /",
	rootServiceName: "maple-web",
	spanCount: 5,
	hasError: 0,
}

describe("SessionTraceSummary.spanCount (ClickHouse UInt64-as-string)", () => {
	it("rejects a string spanCount — why the handler must coerce with Number()", () => {
		expect(() => decodeSummary({ ...baseSummary, spanCount: "5" })).toThrow()
	})

	it("the handler's Number() coercion yields a numeric spanCount", () => {
		expect(decodeSummary({ ...baseSummary, spanCount: Number("5") }).spanCount).toBe(5)
	})
})
