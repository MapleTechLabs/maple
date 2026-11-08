import type { SelfDescribingHttpError } from "@maple/domain/http"
import {
	McpAuthInvalidError,
	McpInvalidInputError,
	McpNotReadyError,
	McpQueryError,
	McpUnavailableError,
} from "../tools/types"

export type McpHttpError =
	| McpAuthInvalidError
	| McpInvalidInputError
	| McpNotReadyError
	| McpQueryError
	| McpUnavailableError

/** When a retryable error names no delay. */
const DEFAULT_RETRY_SECONDS = 5

/**
 * Adapt an HTTP-domain failure at the MCP boundary by its public category, so a 403 reads as a
 * permission problem and a 400 as a fix to the call, not as a Maple bug. The text is the error's
 * public message: internal tags never reach the model. Only 5xx stay `McpQueryError`.
 */
export const toMcpHttpError =
	(pipeName: string) =>
	(error: SelfDescribingHttpError): McpHttpError => {
		const body = error.error
		const message = body.message
		switch (body.type) {
			case "invalid_request_error":
			case "not_found_error":
			case "conflict_error":
				return new McpInvalidInputError({
					message,
					...(body.param === undefined ? undefined : { parameter: body.param }),
				})
			case "authentication_error":
				return new McpAuthInvalidError({ message, reason: "invalid_credentials" })
			case "permission_error":
				return new McpAuthInvalidError({ message, reason: "insufficient_scope" })
			case "payment_error":
				return new McpUnavailableError({ message, capability: "plan" })
			case "rate_limit_error":
				return new McpNotReadyError({
					message,
					retryAfterSeconds: body.retry_after_seconds ?? DEFAULT_RETRY_SECONDS,
				})
			// A 5xx stays a real failure (Error span, cause kept) even when a retry may help.
			case "api_error":
				return new McpQueryError({
					message: body.retryable
						? `${message} Retrying in about ${body.retry_after_seconds ?? DEFAULT_RETRY_SECONDS}s may work.`
						: message,
					pipeName,
					cause: error,
				})
		}
	}
