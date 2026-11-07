import { describe, expect, it } from "vitest"
import {
	WarehouseConfigError,
	WarehouseQueryError,
	WarehouseResultDecodeError,
	WarehouseSchemaDriftError,
} from "@maple/domain"
import { toMcpQueryError, toMcpReadError } from "./map-warehouse-error"

describe("toMcpQueryError", () => {
	it("forwards plain query errors verbatim with the pipe label", () => {
		const err = new WarehouseQueryError({ message: "boom", pipeName: "service_overview" })
		const mcp = toMcpQueryError("service_overview")(err)
		expect(mcp.message).toBe("boom")
		expect(mcp.pipeName).toBe("service_overview")
	})

	it("appends the schema-apply hint for a WarehouseSchemaDriftError", () => {
		const err = new WarehouseSchemaDriftError({
			message: "Unknown expression or function identifier 'SampleRate' in scope SELECT ServiceName ...",
			pipeName: "service_overview",
			clickhouseType: "UNKNOWN_IDENTIFIER",
		})
		const mcp = toMcpQueryError("service_overview")(err)
		expect(mcp.message).toContain("Unknown expression or function identifier 'SampleRate'")
		expect(mcp.message).toContain("schema apply")
		expect(mcp.message).toContain("ClickHouse settings page")
	})

	it("does not enrich non-schema-drift errors", () => {
		const err = new WarehouseQueryError({ message: "boom", pipeName: "service_overview" })
		const mcp = toMcpQueryError("service_overview")(err)
		expect(mcp.message).toBe("boom")
	})

	it("does not tell users to apply schema for a result decode failure", () => {
		const err = new WarehouseResultDecodeError({
			message: "row did not decode",
			pipeName: "service_overview",
		})
		const mcp = toMcpQueryError("service_overview")(err)
		expect(mcp.message).toBe("row did not decode")
		expect(mcp.message).not.toContain("schema apply")
	})
})

describe("toMcpReadError", () => {
	it("reads one of Maple's tables missing for the org as not ready", () => {
		const err = new WarehouseConfigError({
			message: "Resource 'user_activity_hourly' not found",
			pipeName: "list_users",
		})
		const mcp = toMcpReadError("list_users")(err)
		expect(mcp._tag).toBe("@maple/mcp/errors/McpNotReadyError")
		expect(mcp.message).toContain("user_activity_hourly")
	})

	it("leaves a table Maple does not define as a query failure", () => {
		const err = new WarehouseConfigError({
			message: "Resource 'spans' not found",
			pipeName: "list_users",
		})
		expect(toMcpReadError("list_users")(err)._tag).toBe("@maple/mcp/errors/McpQueryError")
	})
})
