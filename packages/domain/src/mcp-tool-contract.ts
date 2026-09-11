/**
 * The two shapes a caller of Maple's MCP tool registry sees from outside it.
 *
 * These lived in an internal Worker-to-Worker RPC contract until that contract
 * was deleted unused. What survived is the part that was never about RPC: a
 * tool's advertised shape, and the one failure any surface can provoke by
 * naming a tool that does not exist.
 */
import { Schema } from "effect"

export interface McpToolDescriptor {
	readonly name: string
	readonly description: string
	readonly inputSchema: Record<string, unknown>
}

export class McpToolNotFoundError extends Schema.TaggedError<McpToolNotFoundError>()(
	"@maple/mcp/ToolNotFoundError",
	{
		name: Schema.String,
		message: Schema.String,
	},
) {}
