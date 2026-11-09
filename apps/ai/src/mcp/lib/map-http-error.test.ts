import { describe, expect, it } from "@effect/vitest"
import { AlertForbiddenError, AlertPersistenceError, AlertValidationError } from "@maple/domain/http"
import { WarehouseQueryError } from "@maple/domain"
import { toMcpHttpError } from "./map-http-error"

describe("toMcpHttpError", () => {
	it("reads a 403 as a permission problem in public words, never the internal tag", () => {
		const mapped = toMcpHttpError("create_alert_rule")(
			new AlertForbiddenError({ message: "Only admins can create alert rules" }),
		)
		expect({ tag: mapped._tag, reason: "reason" in mapped ? mapped.reason : undefined }).toEqual({
			tag: "@maple/mcp/errors/McpAuthInvalidError",
			reason: "insufficient_scope",
		})
		expect(mapped.message).not.toContain("@maple/")
	})

	it("reads a 400 as input the model fixes", () => {
		const mapped = toMcpHttpError("create_alert_rule")(
			new AlertValidationError({ message: "threshold must be positive", details: [] }),
		)
		expect(mapped._tag).toBe("@maple/mcp/errors/McpInvalidInputError")
	})

	it("keeps a retryable 5xx a real failure, saying a retry may work", () => {
		const mapped = toMcpHttpError("create_alert_rule")(
			new AlertPersistenceError({ message: "connection reset" }),
		)
		expect(mapped._tag).toBe("@maple/mcp/errors/McpQueryError")
		expect(mapped.message).toContain("Retrying in about 5s may work.")
	})

	it("keeps a non-retryable 5xx a query failure, without the tag in its text", () => {
		const mapped = toMcpHttpError("list_users")(
			new WarehouseQueryError({ message: "boom", pipeName: "list_users" }),
		)
		expect(mapped._tag).toBe("@maple/mcp/errors/McpQueryError")
		expect(mapped.message).not.toContain("@maple/")
	})
})
