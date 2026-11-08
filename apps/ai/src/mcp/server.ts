import { McpSchema, McpServer as EffectMcpServer } from "effect/ai"
import { Context, Effect, Layer, Array as Arr, String as Str } from "effect"
import { cachedRecoverable } from "@maple/infra/cached-recoverable"
import { McpToolExecutorLoader, McpToolsUnavailableError } from "./executor-loader"
import { CurrentMcpRequestTenant } from "./lib/query-warehouse"
import { refusesReadOnlyCredential, type McpToolResult } from "./tools/types"
import type { McpToolDescriptor } from "@maple/domain/mcp-tool-contract"

/**
 * The text blocks are what a model reads; `structuredContent` is the typed output the tool's
 * `outputSchema` describes, for clients that consume data rather than prose.
 */
const toCallToolResult = (result: McpToolResult): McpSchema.CallToolResult =>
	new McpSchema.CallToolResult({
		isError: result.isError === true ? true : undefined,
		content: Arr.map(result.content, (entry) => ({
			type: "text" as const,
			text: entry.text,
		})),
		...(result.structuredContent === undefined
			? undefined
			: { structuredContent: result.structuredContent }),
	})

/** Long enough to tell failures apart in the MCP hub's error groups, short enough for a span. */
const MAX_ERROR_MESSAGE_CHARS = 300

/**
 * The failure's text with its per-call values (times, ids, counts) masked, so one cause is one
 * error group in the hub. The raw text stays on the dispatcher span.
 */
export const failureGroupMessage = (text: string): string =>
	Str.slice(
		0,
		MAX_ERROR_MESSAGE_CHARS,
	)(
		Str.replace(
			/(?<!(?:HTTP|status|code) )\b\d{2,}(?:\.\d+)?/gi,
			"<n>",
		)(
			Str.replace(
				/\b[a-z]{2,6}_(?=[A-Za-z_]*\d)[A-Za-z0-9]{10,}\b|\b[0-9a-f]{12,}\b/g,
				"<id>",
			)(
				Str.replace(
					/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
					"<id>",
				)(Str.replace(/\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z?/g, "<time>")(text)),
			),
		),
	)

/**
 * A failed call's reason on the `tools/call` span. `error.type` stays `tool_error` per the MCP
 * conventions, so without the message every failure is one group in the hub.
 */
const annotateToolFailure = (result: McpToolResult) =>
	result.isError === true
		? Effect.annotateCurrentSpan({
				"error.message": failureGroupMessage(result.content[0]?.text ?? ""),
				...(result.failureCategory === undefined
					? undefined
					: { "maple.mcp.error.category": result.failureCategory }),
			})
		: Effect.void

/**
 * Hides a tool from a read-only credential's `tools/list`, and answers a call to it as unknown:
 * the registry would refuse every such call anyway, and a listed tool invites it.
 */
const HiddenFromReadOnlyCredentials = EffectMcpServer.visibility(() =>
	Effect.gen(function* () {
		const tenant = yield* CurrentMcpRequestTenant
		return tenant?.readOnly !== true
	}),
)

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
		readonly ensureRegistered: Effect.Effect<void, McpToolsUnavailableError>
		/** Builds the executor before a `tools/call`; `built` marks the request that paid for it. */
		readonly ensureExecutor: Effect.Effect<{ readonly built: boolean }, McpToolsUnavailableError>
	}
>()("@maple/ai/mcp/McpToolRegistration", {
	make: Effect.gen(function* () {
		const server = yield* EffectMcpServer.McpServer
		const loader = yield* McpToolExecutorLoader
		const readOnlyGate = yield* Layer.build(HiddenFromReadOnlyCredentials.layer)
		const addTool = (descriptor: McpToolDescriptor) =>
			server.addTool({
				...(refusesReadOnlyCredential(descriptor.name, descriptor.annotations?.readOnlyHint === true)
					? { services: readOnlyGate }
					: undefined),
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

						// The hub tells clients apart by this; the stateless transport issues no session id.
						if (tenant.mcpClientName !== undefined) {
							yield* Effect.annotateCurrentSpan("maple.mcp.client.name", tenant.mcpClientName)
						}
						// Already built by the transport before the call; this reads the cached executor.
						const executor = yield* loader.load
						return yield* executor
							.execute(tenant, descriptor.name, payload, "mcp")
							.pipe(Effect.tap(annotateToolFailure), Effect.map(toCallToolResult))
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
		const register = Effect.tryPromise({
			try: () => import("./tool-descriptors.generated"),
			catch: (cause) =>
				new McpToolsUnavailableError({ message: "The MCP tool descriptors failed to load", cause }),
		}).pipe(
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
