/**
 * The two shapes a caller of Maple's MCP tool registry sees from outside it: a tool's advertised
 * shape, and the one failure any surface can provoke by naming a tool that does not exist.
 */
import { Schema } from "effect"

/** MCP tool annotations, spelled as the protocol spells them. */
export interface McpToolAnnotations {
	readonly title: string
	readonly readOnlyHint: boolean
	readonly destructiveHint: boolean
	readonly idempotentHint: boolean
	readonly openWorldHint: boolean
}

export interface McpToolDescriptor {
	readonly name: string
	readonly title: string
	readonly description: string
	readonly inputSchema: Record<string, unknown>
	/** The JSON Schema `structuredContent` conforms to. */
	readonly outputSchema?: Record<string, unknown>
	readonly annotations?: McpToolAnnotations
}

export class McpToolNotFoundError extends Schema.TaggedError<McpToolNotFoundError>()(
	"@maple/mcp/ToolNotFoundError",
	{
		toolName: Schema.String,
		message: Schema.String,
	},
) {}
