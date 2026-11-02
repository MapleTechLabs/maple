import { McpSchema, McpServer as EffectMcpServer } from "effect/ai"
import { Context, Effect, Layer } from "effect"
import { cachedRecoverable } from "@maple/infra/cached-recoverable"
import { McpToolExecutorLoader, type McpToolsUnavailableError } from "./executor-loader"
import { CurrentMcpRequestTenant } from "./lib/query-warehouse"
import type { McpToolResult } from "./tools/types"
import type { McpToolDescriptor } from "@maple/domain/mcp-tool-contract"

/**
 * The text blocks are what a model reads; `structuredContent` is the typed output the tool's
 * `outputSchema` describes, for clients that consume data rather than prose.
 */
const toCallToolResult = (result: McpToolResult): McpSchema.CallToolResult =>
	new McpSchema.CallToolResult({
		isError: result.isError === true ? true : undefined,
		content: result.content.map((entry) => ({
			type: "text" as const,
			text: entry.text,
		})),
		...(result.structuredContent === undefined
			? undefined
			: { structuredContent: result.structuredContent }),
	})

const toBoundaryErrorResult = (error: { readonly _tag: string; readonly message: string }) =>
	toCallToolResult({
		isError: true,
		content: [{ type: "text", text: `${error._tag}: ${error.message}` }],
	})

/**
 * Public MCP transport backed by the same dispatcher as internal Worker RPC. Tools register from
 * the generated descriptors, so `tools/list` imports neither the catalog nor the executor's
 * service graph; the executor loads on the first `tools/call` (`McpToolExecutorLoader`).
 */
export class McpToolRegistration extends Context.Service<
	McpToolRegistration,
	{
		/** Adds every public tool to the server, once per isolate, before the first `tools/*` request. */
		readonly ensureRegistered: Effect.Effect<void>
		/** Builds the executor before a `tools/call`; `built` marks the request that paid for it. */
		readonly ensureExecutor: Effect.Effect<{ readonly built: boolean }, McpToolsUnavailableError>
	}
>()("@maple/ai/mcp/McpToolRegistration", {
	make: Effect.gen(function* () {
		const server = yield* EffectMcpServer.McpServer
		const loader = yield* McpToolExecutorLoader
		const addTool = (descriptor: McpToolDescriptor) =>
			server.addTool({
				tool: new McpSchema.Tool({
					name: descriptor.name,
					title: descriptor.title,
					description: descriptor.description,
					inputSchema: descriptor.inputSchema,
					...(descriptor.outputSchema === undefined
						? undefined
						: { outputSchema: descriptor.outputSchema }),
					...(descriptor.annotations === undefined
						? undefined
						: { annotations: descriptor.annotations }),
				}),
				annotations: Context.empty(),
				handle: (payload: unknown) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentMcpRequestTenant
						if (tenant === undefined) {
							return toBoundaryErrorResult({
								_tag: "@maple/mcp/errors/McpAuthMissingError",
								message: "The authenticated MCP tenant is unavailable.",
							})
						}

						// Already built by the transport before the call; this reads the cached executor.
						const executor = yield* loader.load
						return yield* executor
							.execute(tenant, descriptor.name, payload, "mcp")
							.pipe(Effect.map(toCallToolResult))
					}).pipe(
						Effect.catchTags({
							"@maple/mcp/ToolNotFoundError": (error) =>
								Effect.succeed(toBoundaryErrorResult(error)),
							"@maple/mcp/errors/McpToolsUnavailableError": (error) =>
								Effect.succeed(toBoundaryErrorResult(error)),
						}),
						// Runs on the `tools/call` server span: an `isError` result is a successful
						// JSON-RPC call, so the MCP conventions mark it with `error.type` alone.
						Effect.tap((result) =>
							result.isError === true
								? Effect.annotateCurrentSpan("error.type", "tool_error")
								: Effect.void,
						),
					),
			})
		const register = Effect.promise(() => import("./tool-descriptors.generated")).pipe(
			Effect.flatMap(({ MCP_TOOL_DESCRIPTORS }) =>
				Effect.forEach(MCP_TOOL_DESCRIPTORS, addTool, { discard: true }),
			),
		)
		return {
			ensureRegistered: yield* cachedRecoverable(register),
			ensureExecutor: Effect.map(loader.loadReportingBuild, ({ built }) => ({ built })),
		}
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
