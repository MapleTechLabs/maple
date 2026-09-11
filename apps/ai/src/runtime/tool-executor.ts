// BOUNDARY: Tool arguments are decoded by the API registry behind this capability.
import { Context, Effect } from "effect"
import { AiServiceError, type AiToolCallbacks, type AiToolDescriptor } from "@maple/domain/ai-service"
import type { InternalMcpToolResult } from "@maple/domain/internal-rpc"

export interface ToolExecutorApi {
	readonly tools: ReadonlyArray<AiToolDescriptor>
	readonly execute: (name: string, input: unknown) => Effect.Effect<InternalMcpToolResult, unknown>
}
/** Execution capability supplied by the API, never a database or tenant-selectable API client. */
export class ToolExecutor extends Context.Service<ToolExecutor, ToolExecutorApi>()(
	"@maple/ai/ToolExecutor",
) {}
export const callbackExecutor = (
	tools: ReadonlyArray<AiToolDescriptor>,
	callbacks: AiToolCallbacks,
): ToolExecutorApi => ({
	tools,
	execute: (name, input) =>
		Effect.tryPromise({
			try: () => callbacks.execute(name, input),
			catch: () => new AiServiceError({ message: "Tool callback unavailable" }),
		}),
})
