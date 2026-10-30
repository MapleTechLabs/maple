import { describe, expect, it } from "vitest"
import { MAX_RAW_SQL_LENGTH } from "@maple/domain/raw-sql"
import { withTraceIndexSeek } from "./trace-seek"

const ID = "2ea98b74a6330960b2828c8e2edfee38"
const SEEK = `(ServiceName, toStartOfFiveMinutes(Timestamp), TraceId) IN (SELECT ServiceName, Bucket, TraceId FROM trace_index WHERE $__orgFilter AND TraceId IN ('${ID}'))`

describe("withTraceIndexSeek", () => {
	it("ANDs the trace_index seek onto an unbounded trace-id predicate", () => {
		expect(
			withTraceIndexSeek(`SELECT SpanName FROM traces WHERE $__orgFilter AND TraceId = '${ID}'`),
		).toBe(`SELECT SpanName FROM traces WHERE $__orgFilter AND (TraceId = '${ID}' AND ${SEEK})`)
	})

	it("keeps the qualifier and every id of an IN list", () => {
		const other = "7ac1ca09957fd49ac57461016a5a7819"
		const seeked = withTraceIndexSeek(
			`SELECT t.SpanName FROM traces t WHERE $__orgFilter(t) AND t.TraceId IN ('${ID}', '${other}')`,
		)
		expect(seeked).toContain(
			`(t.ServiceName, toStartOfFiveMinutes(t.Timestamp), t.TraceId) IN (SELECT ServiceName, Bucket, TraceId FROM trace_index WHERE $__orgFilter AND TraceId IN ('${ID}', '${other}'))`,
		)
	})

	it.each([
		[
			"a time bound",
			`SELECT 1 FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) AND TraceId = '${ID}'`,
		],
		[
			"a literal bound",
			`SELECT 1 FROM traces WHERE $__orgFilter AND Timestamp >= '2026-10-01' AND TraceId = '${ID}'`,
		],
		["another table", `SELECT 1 FROM logs WHERE $__orgFilter AND TraceId = '${ID}'`],
		[
			"a join",
			`SELECT 1 FROM traces t JOIN logs l USING TraceId WHERE $__orgFilter(t) AND t.TraceId = '${ID}'`,
		],
		[
			"the id only in a string",
			`SELECT 1 FROM traces WHERE $__orgFilter AND Body = 'TraceId = ''${ID}'''`,
		],
		["no org filter of its own", `SELECT 1 FROM traces WHERE TraceId = '${ID}'`],
		[
			"an alias shadowing Timestamp",
			`SELECT toStartOfHour(Timestamp) AS Timestamp FROM traces WHERE $__orgFilter AND TraceId = '${ID}'`,
		],
		["the id inside if()", `SELECT countIf(TraceId = '${ID}') FROM traces WHERE $__orgFilter`],
		["a negated id", `SELECT 1 FROM traces WHERE $__orgFilter AND NOT TraceId = '${ID}'`],
		["an OR-ed id", `SELECT 1 FROM traces WHERE $__orgFilter AND (SpanName = 'x' OR TraceId = '${ID}')`],
		[
			"a subquery id",
			"SELECT 1 FROM traces WHERE $__orgFilter AND TraceId IN (SELECT TraceId FROM trace_list_mv)",
		],
	])("leaves a query with %s alone", (_, sql) => {
		expect(withTraceIndexSeek(sql)).toBeUndefined()
	})

	it("leaves a statement alone when the seek would push it past the length limit", () => {
		const base = `SELECT SpanName FROM traces WHERE $__orgFilter AND TraceId = '${ID}' AND SpanName != ''`
		const sql = `${base}${" ".repeat(MAX_RAW_SQL_LENGTH - base.length - 10)}`
		expect(withTraceIndexSeek(sql)).toBeUndefined()
	})
})
