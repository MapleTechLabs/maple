import { describe, expect, it } from "vitest"
import { WarehouseQueryError, WarehouseResultDecodeError, WarehouseSchemaDriftError } from "@maple/domain"
import {
	GcpLiveQueryFailedError,
	GcpLiveQueryRejectedError,
	GcpLiveQueryUnavailableError,
} from "@maple/domain/http/gcp-live-query-errors"
import { toMcpQueryError } from "./map-warehouse-error"

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

	it("makes a query Google refused the caller's to fix", () => {
		const err = new GcpLiveQueryRejectedError({
			message: "The query reaches 34 projects; filter on project_id",
			reason: "too_many_projects",
		})
		const mcp = toMcpQueryError("query_data")(err)
		expect(mcp._tag).toBe("@maple/mcp/errors/McpInvalidInputError")
		expect(mcp.message).toBe("The query reaches 34 projects; filter on project_id")
	})

	it("reports Google Cloud metrics as unavailable when no connection reads them", () => {
		const err = new GcpLiveQueryUnavailableError({
			message: "No Google Cloud connection has metrics on.",
		})
		const mcp = toMcpQueryError("query_data")(err)
		expect(mcp).toMatchObject({
			_tag: "@maple/mcp/errors/McpUnavailableError",
			message: "No Google Cloud connection has metrics on.",
			capability: "google_cloud_metrics",
		})
	})

	it("asks for a retry when Google did not answer", () => {
		const err = new GcpLiveQueryFailedError({
			message: "Google Cloud could not be read.",
			failures: [{ scope: "projects/acme", message: "503" }],
		})
		const mcp = toMcpQueryError("query_data")(err)
		expect(mcp).toMatchObject({
			_tag: "@maple/mcp/errors/McpNotReadyError",
			message: "Google Cloud could not be read.",
			retryAfterSeconds: 60,
		})
	})
})
