import { describe, expect, it } from "vitest"
import { LocalQueryFailed } from "@maple/query-engine/local"
import {
	describeQueryError,
	formatCell,
	inferColumns,
	isNumericColumn,
	parseTables,
	quoteIdentifier,
	tablePreviewSql,
	toCsv,
	truncateCell,
} from "./query-console"

describe("query console helpers", () => {
	it("infers columns in first-seen order across rows", () => {
		expect(
			inferColumns([
				{ a: 1, b: 2 },
				{ b: 3, c: 4 },
			]),
		).toEqual(["a", "b", "c"])
		expect(inferColumns([])).toEqual([])
	})

	it("treats quoted 64-bit integers as numeric and ignores nulls", () => {
		const rows = [
			{ n: 1, s: "x", u: "18446744073709551615" },
			{ n: null, s: "1", u: "-2.5" },
		]
		expect(isNumericColumn(rows, "n")).toBe(true)
		expect(isNumericColumn(rows, "u")).toBe(true)
		expect(isNumericColumn(rows, "s")).toBe(false)
		expect(isNumericColumn([{ n: null }], "n")).toBe(false)
	})

	it("formats and truncates cells", () => {
		expect(formatCell(null)).toBe("NULL")
		expect(formatCell(["a", 1])).toBe('["a",1]')
		expect(formatCell({ k: "v" })).toBe('{"k":"v"}')
		expect(truncateCell("abcdef", 3)).toBe("abc…")
		expect(truncateCell("abc", 3)).toBe("abc")
	})

	it("encodes CSV with quoting and empty nulls", () => {
		const csv = toCsv([
			{ a: 'say "hi"', b: null },
			{ a: "x,y", b: 2 },
		])
		expect(csv).toBe('a,b\r\n"say ""hi""",\r\n"x,y",2\r\n')
	})

	it("neutralizes spreadsheet formulas in text but not negative numbers", () => {
		const csv = toCsv([
			{ a: '=HYPERLINK("x")', b: -5 },
			{ a: "+1", b: "@cmd" },
		])
		expect(csv).toBe('a,b\r\n"\'=HYPERLINK(""x"")",-5\r\n\'+1,\'@cmd\r\n')
	})

	it("quotes table names only when needed", () => {
		expect(quoteIdentifier("traces")).toBe("traces")
		expect(quoteIdentifier("odd-name")).toBe("`odd-name`")
		expect(tablePreviewSql("logs")).toBe("SELECT *\nFROM logs\nWHERE OrgId = 'local'\nLIMIT 100")
	})

	it("parses system.tables rows", () => {
		expect(
			parseTables([{ name: "logs", total_rows: "12" }, { name: "v", total_rows: null }, { x: 1 }]),
		).toEqual([
			{ name: "logs", totalRows: 12 },
			{ name: "v", totalRows: null },
		])
	})

	it("shows the server message for refused queries", () => {
		const refused = new LocalQueryFailed({
			status: 400,
			detail: "read-only query endpoint: multiple statements are not allowed",
			message: "Local query failed (400)",
		})
		expect(describeQueryError(refused)).toEqual({
			title: "Query not allowed",
			detail: "multiple statements are not allowed",
		})
	})
})
