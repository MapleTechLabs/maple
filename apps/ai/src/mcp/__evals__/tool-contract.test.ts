/**
 * The registry's contract for a tool declared with `define`, exercised end to end through the
 * executor: aliases, ignored keys, decode messages, the typed output on `structuredContent`,
 * and the rendered text.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema } from "effect"
import { FindErrorsOutput } from "@maple/domain/mcp-outputs"
import { makeEvalRuntime, runToolDirect, markdown, type EvalRuntime } from "./eval-runtime"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "./fake-warehouse"
import type { McpToolResult } from "../tools/types"

const errorRows = [
	{
		fingerprintHash: "11640295108927840024",
		errorLabel: "@maple/http/errors/WarehouseQueryError",
		sampleMessage: "Database query failed | column Foo",
		count: 42,
		affectedServicesCount: 2,
		firstSeen: "2026-09-24 10:00:00",
		lastSeen: "2026-09-24 11:00:00",
	},
]

const rules: FixtureRule[] = [{ match: (sql) => /errorLabel/i.test(sql), rows: errorRows }]
let issuedSql: Array<string> = []

let rt: EvalRuntime

beforeAll(() => {
	installFakeWarehouse([
		{
			match: (sql) => {
				issuedSql.push(sql)
				return false
			},
			rows: [],
		},
		...rules,
	])
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const call = (name: string, params: unknown): Promise<McpToolResult> => {
	issuedSql = []
	return runToolDirect(rt, name, params)
}

describe("a tool declared with define", () => {
	it("returns its typed output as structuredContent and renders the text from it", async () => {
		const result = await call("find_errors", {
			start_time: "2026-09-24 00:00:00",
			end_time: "2026-09-24 12:00:00",
		})
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(FindErrorsOutput)(result.structuredContent)
		expect(output.errors[0]?.fingerprintHash).toBe("11640295108927840024")
		expect(output.timeRange).toEqual({ start: "2026-09-24 00:00:00", end: "2026-09-24 12:00:00" })

		const text = markdown(result)
		expect(result.content).toHaveLength(1)
		expect(text).toContain("## Errors by Type")
		expect(text).toContain("Time range: 2026-09-24 00:00:00 to 2026-09-24 12:00:00")
		// The renderer escapes cells, so a pipe in a message cannot shift the columns.
		expect(text).toContain("Database query failed \\| column Foo")
		expect(text).toContain('`error_detail fingerprint="11640295108927840024"`')
		expect(text).not.toContain("__maple_ui")
	})

	it("accepts a retired parameter name and filters by it", async () => {
		await call("find_errors", { service_name: "checkout" })
		expect(issuedSql.join("\n")).toContain("checkout")
	})

	it("tells the model which keys it ignored, and what it probably meant", async () => {
		const result = await call("find_errors", { servce: "checkout" })
		expect(markdown(result)).toContain(
			"Note: `servce` is not a parameter of `find_errors` and was ignored. Did you mean `service`?",
		)
	})

	it("explains a bad value against the parameter it was sent for", async () => {
		const result = await call("find_errors", { identity: "everything" })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("Invalid parameters for `find_errors`:")
		expect(markdown(result)).toContain("`identity`")
	})

	it("reports a window it will not scan as invalid input, not a query failure", async () => {
		const result = await call("find_errors", {
			start_time: "2026-09-24 12:00:00",
			end_time: "2026-09-24 00:00:00",
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toMatch(/^Invalid input \(`start_time`\): /)
	})
})
