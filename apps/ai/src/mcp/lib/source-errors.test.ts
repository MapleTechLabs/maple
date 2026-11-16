import { describe, expect, it } from "vitest"
import { IntegrationsUpstreamError } from "@maple/domain/http"
import { fromVcsLookupError } from "./source-errors"

const mapped = (error: IntegrationsUpstreamError) => fromVcsLookupError("search_source_code")(error)

describe("fromVcsLookupError", () => {
	it("asks the model to come back after a GitHub rate limit", () => {
		const error = mapped(
			new IntegrationsUpstreamError({ message: "GitHub rate limited (retry after 60s)", status: 403 }),
		)
		expect(error).toMatchObject({ _tag: "@maple/mcp/errors/McpNotReadyError", retryAfterSeconds: 60 })
	})

	it("hands a search query GitHub could not parse back to the model to fix", () => {
		const error = mapped(
			new IntegrationsUpstreamError({
				message:
					'Search code failed: 422 {"message":"ERROR_TYPE_QUERY_PARSING_FATAL unable to parse query!"}',
				status: 422,
			}),
		)
		expect(error._tag).toBe("@maple/mcp/errors/McpInvalidInputError")
	})

	it("keeps a GitHub outage a query failure", () => {
		const error = mapped(
			new IntegrationsUpstreamError({
				message: "Get pull request failed: 503 Service Unavailable",
				status: 503,
			}),
		)
		expect(error._tag).toBe("@maple/mcp/errors/McpQueryError")
	})
})
