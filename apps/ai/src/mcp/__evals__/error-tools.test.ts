/**
 * error_detail, find_errors and list_error_issues end to end through the real handlers, against
 * a fake warehouse (routed by the compiled SQL) and a PGlite database seeded with issues.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema } from "effect"
import { ErrorDetailOutput, FindErrorsOutput, ListErrorIssuesOutput } from "@maple/domain/mcp-outputs"
import { executeSql } from "@maple/backend/platform/test-pglite"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "./eval-runtime"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "./fake-warehouse"
import { FIXTURES } from "./utils"

const FINGERPRINT = "13521913963841819692"
const CAUSE_FINGERPRINT = "93079779683878685"
const UNKNOWN_FINGERPRINT = "555"
const ERROR_ISSUE = "3f1c2b8e-9d4a-4c6b-8e2f-1a2b3c4d5e60"
const ALERT_ISSUE = "3f1c2b8e-9d4a-4c6b-8e2f-1a2b3c4d5e61"
const UNKNOWN_ISSUE = "3f1c2b8e-9d4a-4c6b-8e2f-1a2b3c4d5e62"

const summaryRow = {
	occurrences: 16,
	firstSeen: "2026-09-20 08:00:00",
	lastSeen: "2026-09-21 10:00:00",
	errorLabel: "ScrapeAttemptFailed",
	exceptionType: "ScrapeAttemptFailed",
	exceptionMessage: "{}",
	statusMessage: "",
	serviceCount: 1,
	services: ["scraper"],
	noExceptionCount: 0,
}

const traceRow = {
	traceId: "a471ce22b8eee34e016bc27010c04688",
	startTime: "2026-09-21 09:59:00.000",
	durationMicros: 2000,
	spanCount: 4,
	services: ["scraper"],
	rootSpanName: "scrape",
	errorMessage: "",
	errorSpanId: "0e4ce93d7601cb6c",
	errorSpanName: "scrape.attempt",
	errorServiceName: "scraper",
	errorModel: "",
	errorToolName: "",
	errorHttpMethod: "POST",
	errorHttpRoute: "/v1/traces",
	errorHttpStatus: "502",
	errorQueryContext: "",
	errorType: "",
	errorLabel: "ScrapeAttemptFailed",
	exceptionType: "ScrapeAttemptFailed",
	exceptionMessage: "{}",
}

const isErrorEvents = (sql: string) => /\bFROM error_events\b/.test(sql)
const isErrorEventsByTime = (sql: string) => /\bFROM error_events_by_time\b/.test(sql)

// First match wins.
const rules: FixtureRule[] = [
	{ match: (sql) => isErrorEvents(sql) && sql.includes("noExceptionCount"), rows: [summaryRow] },
	{ match: (sql) => sql.includes("occurrenceSpanId"), rows: [traceRow] },
	{
		match: (sql) => isErrorEventsByTime(sql) && sql.includes("TraceId IN"),
		rows: [
			{
				fingerprintHash: CAUSE_FINGERPRINT,
				errorLabel: "OtlpIngestError",
				serviceName: "scraper",
				traces: 1,
				count: 1,
			},
		],
	},
	{
		match: (sql) => isErrorEventsByTime(sql) && sql.includes("AS fingerprintCount"),
		rows: [{ occurrences: 237_000, fingerprintCount: 40, noExceptionCount: 231_000 }],
	},
	{
		match: (sql) => sql.includes("sampleMessage"),
		rows: [
			{
				fingerprintHash: UNKNOWN_FINGERPRINT,
				errorLabel: "Unknown Error",
				sampleMessage: "",
				count: 22_972,
				affectedServicesCount: 1,
				serviceNames: ["maple-landing"],
				firstSeen: "2026-09-21 00:00:00",
				lastSeen: "2026-09-21 10:00:00",
			},
		],
	},
	{
		match: (sql) => isErrorEvents(sql) && sql.includes("AS spanId"),
		rows: [{ fingerprintHash: UNKNOWN_FINGERPRINT, traceId: "t-landing", spanId: "s-landing" }],
	},
	{
		match: (sql) => sql.includes("FROM trace_detail_spans") && sql.includes("AS httpStatus"),
		rows: [
			{
				spanId: "s-landing",
				spanName: "GET /api/org",
				httpMethod: "GET",
				httpRoute: "",
				httpStatus: "404",
			},
		],
	},
	{
		match: (sql) => /\bfrom\s+logs\b/i.test(sql),
		rows: [],
	},
]

let rt: EvalRuntime

const insertIssue = (row: {
	id: string
	kind: string
	fingerprintHash: string
	serviceName: string
	exceptionType: string
	errorLabel: string
	lastSeenAt: string
}) =>
	executeSql(
		rt.testDb,
		`INSERT INTO error_issues (id, org_id, kind, fingerprint_hash, service_name, exception_type,
			exception_message, error_label, top_frame, first_seen_at, last_seen_at, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, '', $7, '', $8, $8, $8, $8)`,
		[
			row.id,
			FIXTURES.orgId,
			row.kind,
			row.fingerprintHash,
			row.serviceName,
			row.exceptionType,
			row.errorLabel,
			row.lastSeenAt,
		],
	)

const seedIssues = async () => {
	await rt.testDb.pglite.waitReady
	await insertIssue({
		id: ERROR_ISSUE,
		kind: "error",
		fingerprintHash: FINGERPRINT,
		serviceName: "scraper",
		exceptionType: "ScrapeAttemptFailed",
		errorLabel: "ScrapeAttemptFailed",
		lastSeenAt: "2026-09-21T10:00:00Z",
	})
	await insertIssue({
		id: ALERT_ISSUE,
		kind: "alert",
		fingerprintHash: "alert:rule-1:scraper",
		serviceName: "scraper",
		exceptionType: "High error rate",
		errorLabel: "",
		lastSeenAt: "2026-09-21T09:30:00Z",
	})
	await insertIssue({
		id: UNKNOWN_ISSUE,
		kind: "error",
		fingerprintHash: UNKNOWN_FINGERPRINT,
		serviceName: "maple-landing",
		exceptionType: "",
		errorLabel: "Unknown Error",
		lastSeenAt: "2026-09-21T09:00:00Z",
	})
}

beforeAll(async () => {
	installFakeWarehouse(rules)
	rt = makeEvalRuntime()
	await seedIssues()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const call = (name: string, params: unknown) => runToolDirect(rt, name, params)

describe("error_detail", () => {
	it("opens with a summary, marks the fingerprint's span and names its partner", async () => {
		const result = await call("error_detail", { fingerprint: FINGERPRINT })
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(ErrorDetailOutput)(result.structuredContent)
		expect(output.anchored).toBe(true)
		expect(output.summary?.occurrences).toBe(16)
		expect(output.related?.[0]?.fingerprintHash).toBe(CAUSE_FINGERPRINT)
		const text = markdown(result)
		expect(text).toContain("Exception: ScrapeAttemptFailed")
		// "{}" is not a message: the render says nothing was recorded instead of `Error: {}`.
		expect(text).toContain("no exception recorded")
		expect(text).not.toContain('"{}"')
		expect(text).toContain("Services: scraper")
		expect(text).toContain("Top routes: POST /v1/traces 502 (1)")
		expect(text).toContain("Error span (this fingerprint): scrape.attempt")
		expect(text).toContain("ending at the last occurrence")
		expect(text).toContain(`\`search_logs service="scraper" severity="ERROR"`)
		expect(text).not.toContain('service=""')
	})

	it("keeps an explicit window as given", async () => {
		const output = Schema.decodeUnknownSync(ErrorDetailOutput)(
			(
				await call("error_detail", {
					fingerprint: FINGERPRINT,
					start_time: "2026-09-21 00:00:00",
					end_time: "2026-09-21 12:00:00",
				})
			).structuredContent,
		)
		expect(output.anchored).toBeUndefined()
		expect(output.timeRange).toEqual({ start: "2026-09-21 00:00:00", end: "2026-09-21 12:00:00" })
	})

	it("resolves an issue_id to its fingerprint", async () => {
		const result = await call("error_detail", { issue_id: ERROR_ISSUE })
		const output = Schema.decodeUnknownSync(ErrorDetailOutput)(result.structuredContent)
		expect(output.fingerprintHash).toBe(FINGERPRINT)
		expect(output.issueId).toBe(ERROR_ISSUE)
	})

	it("treats an issue UUID passed as fingerprint the same way", async () => {
		const result = await call("error_detail", { fingerprint: ERROR_ISSUE })
		expect(result.isError).toBeUndefined()
		expect(Schema.decodeUnknownSync(ErrorDetailOutput)(result.structuredContent).fingerprintHash).toBe(
			FINGERPRINT,
		)
	})

	it("explains that an alert issue has no sample traces", async () => {
		const text = markdown(await call("error_detail", { issue_id: ALERT_ISSUE }))
		expect(text).toMatch(/^Invalid input \(`issue_id`\): /)
		expect(text).toContain("alert issue")
		expect(text).toContain("list_alert_incidents")
	})

	it("asks for one of fingerprint or issue_id", async () => {
		const text = markdown(await call("error_detail", {}))
		expect(text).toContain("`fingerprint`")
		expect(text).toContain("`issue_id`")
	})
})

describe("find_errors", () => {
	it("reports window totals and labels exception-less errors by span", async () => {
		const result = await call("find_errors", {})
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(FindErrorsOutput)(result.structuredContent)
		expect(output.errors[0]?.label).toBe("GET 404 /api/org")
		expect(output.totals).toEqual({ occurrences: 237_000, fingerprints: 40, noExceptionCount: 231_000 })
		const text = markdown(result)
		expect(text).toContain("Showing 1 of 40 fingerprints, 22,972 of 237,000 error occurrences")
		expect(text).toContain("231,000 occurrences are error spans without an exception")
	})
})

describe("list_error_issues", () => {
	it("is compact by default, reports the true total and relabels Unknown Error", async () => {
		const result = await call("list_error_issues", { limit: 2 })
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(ListErrorIssuesOutput)(result.structuredContent)
		expect(output.compact).toBe(true)
		expect(output.total).toBe(2)
		expect(output.totalMatching).toBe(3)
		expect(output.nextCursor).toBeDefined()
		const text = markdown(result)
		expect(text).toContain("Showing 2 of 3 issues")
		expect(text).toContain("cursor=")
		expect(text).not.toContain("Holder")

		const next = await call("list_error_issues", { limit: 2, cursor: output.nextCursor })
		const page2 = Schema.decodeUnknownSync(ListErrorIssuesOutput)(next.structuredContent)
		expect(page2.total).toBe(1)
		expect(page2.nextCursor).toBeUndefined()
		expect(page2.issues[0]?.errorLabel).toBe("GET 404 /api/org")
	})

	it("filters by exception_type and search", async () => {
		const byType = Schema.decodeUnknownSync(ListErrorIssuesOutput)(
			(await call("list_error_issues", { exception_type: "ScrapeAttemptFailed" })).structuredContent,
		)
		expect(byType.issues.map((i) => i.id)).toEqual([ERROR_ISSUE])
		const bySearch = Schema.decodeUnknownSync(ListErrorIssuesOutput)(
			(await call("list_error_issues", { search: "landing" })).structuredContent,
		)
		expect(bySearch.issues.map((i) => i.id)).toEqual([UNKNOWN_ISSUE])
	})

	it("rejects a cursor it did not issue", async () => {
		const text = markdown(await call("list_error_issues", { cursor: "not-a-cursor" }))
		expect(text).toMatch(/^Invalid input \(`cursor`\): /)
	})

	it("returns the wide rows on compact=false", async () => {
		const result = await call("list_error_issues", { compact: false })
		expect(markdown(result)).toContain("Holder")
	})
})
