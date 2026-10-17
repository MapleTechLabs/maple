import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { UserId } from "../../primitives"
import { McpConnectionNotFoundError, McpConnectionPersistenceError } from "../mcp-connections"
import { AuthorizationV2 } from "./auth"
import { wireExample, ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2ParameterInvalid } from "./errors"
import { publicError } from "./public-error"
import { McpConnectionPublicId } from "./resource-ids"

const mcpConnectionExample = {
	id: "mcpc_p12S8T8agEHUkYc825nMz6",
	object: "mcp_connection",
	client_name: "Claude Code",
	user_id: "user_2Nk8mXqPfR3yZ1aB4cD5eF6g",
	user_email: "david@acme.com",
	scopes: ["mcp:tools"],
	connected_at: "2026-09-30T12:00:00.000Z",
	last_refreshed_at: "2026-10-17T08:00:00.000Z",
	expires_at: "2026-12-29T12:00:00.000Z",
} as const

export const V2McpConnection = Schema.Struct({
	id: McpConnectionPublicId,
	object: Schema.Literal("mcp_connection").annotate({
		description: 'The object type, always `"mcp_connection"`.',
	}),
	client_name: Schema.String.annotate({
		description: "The name the MCP client registered with, such as `Claude Code`.",
	}),
	user_id: UserId.annotate({ description: "The member who approved the connection." }),
	user_email: Schema.NullOr(Schema.String).annotate({
		description: "Email of the member who approved the connection, when known.",
	}),
	scopes: Schema.Array(Schema.String).annotate({
		description: "What the connection was granted. Currently always `mcp:tools`.",
	}),
	connected_at: Timestamp.annotate({ description: "When the member approved the client." }),
	last_refreshed_at: Timestamp.annotate({
		description: "When the client last exchanged its refresh token for a new access token.",
	}),
	expires_at: Timestamp.annotate({
		description: "When the connection ends unless the client reconnects before then.",
	}),
}).annotate({
	identifier: "McpConnection",
	title: "MCP Connection",
	description:
		"An MCP client a member approved through OAuth. The client's access token rotates hourly; the connection is the grant behind it, and revoking it signs the client out.",
	examples: [wireExample(mcpConnectionExample)],
})
export type V2McpConnection = Schema.Schema.Type<typeof V2McpConnection>

const persistence = publicError(McpConnectionPersistenceError)
const notFound = publicError(McpConnectionNotFoundError)

const McpConnectionList = ListOf(V2McpConnection).annotate({
	identifier: "McpConnectionList",
	title: "MCP connection list",
	description: "A cursor-paginated page of MCP connections.",
})

export class V2McpConnectionsApiGroup extends HttpApiGroup.make("mcpConnections")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: McpConnectionList,
			error: [V2ParameterInvalid.schema, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listMcpConnections",
				summary: "List MCP connections",
				description:
					"Returns the live MCP OAuth connections, most recently refreshed first. Org admins see every member's connections; other members see their own. Requires the `mcp_connections:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("revoke", "/:id", {
			params: { id: McpConnectionPublicId },
			success: V2McpConnection,
			error: [notFound, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "revokeMcpConnection",
				summary: "Revoke an MCP connection",
				description:
					"Ends the connection and every access token it minted, and returns the final object. The client has to be approved again to reconnect. Members may revoke their own connections; org admins may revoke any. Requires the `mcp_connections:write` scope.",
			}),
		),
	)
	.prefix("/v2/mcp_connections")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "MCP Connections",
			description:
				"MCP clients connected to the organization through OAuth, and revoking them. Org admins manage every member's connections; other members manage their own.",
		}),
	) {}
