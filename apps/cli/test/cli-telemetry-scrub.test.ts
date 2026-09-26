import { describe, expect, test } from "bun:test"
import { sanitizeArgv, sanitizeStack, scrubAttributes, scrubTraceData } from "../src/core/telemetry"

const str = (key: string, value: string) => ({ key, value: { stringValue: value } })

describe("CLI telemetry scrubber", () => {
	test("drops SQL, query text, filter values and error messages", () => {
		const scrubbed = scrubAttributes([
			str("db.query.text", "SELECT * FROM logs WHERE Body = 'secret'"),
			str("db.statement", "SELECT 1"),
			str("ch.sql", "SELECT 2"),
			str("query.filter.serviceName", "checkout"),
			str("service", "checkout"),
			str("exception.message", "Cannot parse input: 'alice@example.com'"),
			str("effect.cause", "Error: row {'email':'x'}"),
			str("db.system.name", "clickhouse"),
			str("error.type", "HTTP 400"),
			{ key: "db.query.length", value: { intValue: 41 } },
		])
		expect(scrubbed.map((attribute) => attribute.key)).toEqual([
			"db.system.name",
			"error.type",
			"db.query.length",
		])
	})

	test("keeps command words and flag names from argv, not values", () => {
		expect(sanitizeArgv("query SELECT * FROM logs WHERE x = 'secret'")).toBe("query")
		expect(sanitizeArgv("query select body from logs where email = 'a@b.c'")).toBe("query select")
		expect(sanitizeArgv("traces --service checkout --since=1h")).toBe("traces --service --since")
		expect(sanitizeArgv("auth login")).toBe("auth login")
	})

	test("keeps stack frames without messages or directories", () => {
		const stack =
			"Error: row 'alice@example.com' failed\n    at run (/Users/alice/app/serve.ts:10:3)\n  [cause]: x"
		expect(sanitizeStack(stack)).toBe("    at run (serve.ts:10:3)")
	})

	test("scrubs whole spans: attributes, exception and log events, status", () => {
		const span = {
			traceId: "t",
			spanId: "s",
			parentSpanId: undefined,
			name: "POST /local/query",
			kind: 2,
			startTimeUnixNano: "1",
			endTimeUnixNano: "2",
			attributes: [str("db.query.text", "SELECT 'secret'"), str("cli.argv", "query SELECT 'secret'")],
			droppedAttributesCount: 0,
			events: [
				{
					name: "exception",
					timeUnixNano: "2",
					droppedAttributesCount: 0,
					attributes: [
						str("exception.type", "@maple/cli/ChdbQueryError"),
						str("exception.message", "Code: 27 ... 'secret'"),
						str("exception.stacktrace", "ChdbQueryError: 'secret'\n    at q (/x/chdb.ts:1:1)"),
					],
				},
				{
					name: 'WarehouseQueryService.executeSql failed {"sql":"SELECT \'secret\'"}',
					timeUnixNano: "2",
					droppedAttributesCount: 0,
					attributes: [str("effect.logLevel", "ERROR"), str("sql", "SELECT 'secret'")],
				},
			],
			droppedEventsCount: 0,
			status: { code: 2 as const, message: "Code: 27 ... 'secret'" },
			links: [],
			droppedLinksCount: 0,
		}
		const data = scrubTraceData({
			resourceSpans: [
				{
					resource: { attributes: [], droppedAttributesCount: 0 },
					scopeSpans: [{ scope: { name: "maple-cli" }, spans: [span] }],
				},
			],
		})
		const scrubbed = data.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
		expect(JSON.stringify(scrubbed)).not.toContain("secret")
		expect(scrubbed.status).toEqual({ code: 2 })
		expect(scrubbed.attributes).toEqual([str("cli.argv", "query")])
		expect(scrubbed.events[0]!.attributes.map((attribute) => attribute.key)).toEqual([
			"exception.type",
			"exception.stacktrace",
		])
		expect(scrubbed.events[1]).toMatchObject({
			name: "log",
			attributes: [str("effect.logLevel", "ERROR")],
		})
	})
})
