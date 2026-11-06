import { Schema } from "effect"
import { McpConnectionId } from "../primitives"
import { HttpTaggedError } from "./error-policy"

/**
 * MCP clients connected to an organization through OAuth. A connection is one refresh-token
 * family: the access key it mints is rotated hourly, the family is the grant behind it.
 */

export class McpConnectionPersistenceError extends HttpTaggedError<McpConnectionPersistenceError>()(
	"@maple/http/errors/McpConnectionPersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.String),
	},
	{
		status: 503,
		code: "mcp_connections_unavailable",
		title: "Connected clients are temporarily unavailable",
		message: "Connected clients are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

/** Absent, already ended, or another member's connection the caller may not see. */
export class McpConnectionNotFoundError extends HttpTaggedError<McpConnectionNotFoundError>()(
	"@maple/http/errors/McpConnectionNotFoundError",
	{
		message: Schema.String,
		connectionId: McpConnectionId,
	},
	{
		status: 404,
		code: "mcp_connection_not_found",
		title: "Connection not found",
		message: "No active MCP connection with this ID.",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}
