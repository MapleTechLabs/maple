import { McpSchema, McpServer as EffectMcpServer } from "effect/ai"
import { Context, Duration, Effect, Layer, Option, Predicate, Array as Arr, String as Str } from "effect"
import type { OrgId } from "@maple/domain/http"
import { cachedRecoverable } from "@maple/infra/cached-recoverable"
import {
	McpToolExecutorLoader,
	type McpToolExecutorBuildKind,
	McpToolsUnavailableError,
} from "./executor-loader"
import { CurrentMcpRequestTenant } from "./tenant"
import { DATA_SOURCE_TOOLS, refusalFor, type McpToolResult } from "./tools/types"
import type { McpToolModule } from "./tools/registry-core"
import { MCP_TOOL_MODULES } from "./tool-modules.generated"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import type { McpToolDescriptor } from "@maple/domain/mcp-tool-contract"
import { enumSpelling } from "./tools/tool-name-aliases"

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

/** How long a `tools/list` or an `initialize` waits for an org's rollout flags. */
const FLAGS_WAIT = Duration.seconds(2)

/** An org's rollout flags, when known within {@link FLAGS_WAIT}; a slow read is not waited on twice. */
export const flagsInTime = (
	featureFlags: Context.Service.Shape<typeof OrganizationFeatureFlagsService>,
	orgId: OrgId,
) => featureFlags.known(orgId, FLAGS_WAIT)

/** The values a tool publishes for an `action` parameter: a family's actions, and so a bounded set. */
const publishedActionsOf = (descriptor: McpToolDescriptor): ReadonlyArray<unknown> => {
	const properties = descriptor.inputSchema.properties
	const action = Predicate.isObject(properties) ? properties.action : undefined
	return Predicate.isObject(action) && Arr.isArray(action.enum) ? action.enum : []
}

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

const toolsByName: ReadonlyMap<string, McpToolModule> = new Map(
	Arr.map(MCP_TOOL_MODULES, (entry) => [entry.name, entry]),
)

/**
 * Hides a tool from the `tools/list` of a caller the registry would refuse (a permission they lack,
 * a read-only key on a tool that changes data), and answers a call to it as unknown: a listed tool
 * invites the call. The data source tools are also hidden from an org outside the `dataSources`
 * rollout; flags that cannot be read in time hide nothing, since those tools still refuse such an org.
 */
const HiddenFromRefusedCallers = EffectMcpServer.visibility(
	Effect.map(
		OrganizationFeatureFlagsService,
		(featureFlags) =>
			({ target }: { readonly target: string }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentMcpRequestTenant
					const tool = toolsByName.get(target)
					if (tenant !== undefined && tool !== undefined && refusalFor(tenant, tool) !== undefined) {
						return false
					}
					if (!DATA_SOURCE_TOOLS.has(target)) return true
					if (tenant === undefined) return false
					const flags = yield* flagsInTime(featureFlags, tenant.orgId)
					return Option.isNone(flags) || flags.value.dataSources
				}),
	),
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
		/** Builds the executor before a `tools/call`, saying how the request came by it. */
		readonly ensureExecutor: Effect.Effect<McpToolExecutorBuildKind, McpToolsUnavailableError>
		/** Starts the executor build in the background, for a request that runs no tool. */
		readonly prewarmExecutor: Effect.Effect<void>
	}
>()("@maple/ai/mcp/McpToolRegistration", {
	make: Effect.gen(function* () {
		const server = yield* EffectMcpServer.McpServer
		const loader = yield* McpToolExecutorLoader
		const gate = yield* Layer.build(HiddenFromRefusedCallers.layer)
		const addTool = (descriptor: McpToolDescriptor) => {
			const actions = publishedActionsOf(descriptor)
			return server.addTool({
				services: gate,
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
						// The hub groups on this span: a family's name alone merges its actions.
						const asked = Predicate.isObject(payload) ? payload.action : undefined
						const action = typeof asked === "string" ? enumSpelling(asked) : undefined
						if (action !== undefined && actions.includes(action)) {
							yield* Effect.annotateCurrentSpan("maple.mcp.tool.action", action)
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
		}
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
			ensureExecutor: Effect.map(loader.loadReportingBuild, ({ build }) => build),
			prewarmExecutor: loader.prewarm,
		}
	}),
}) {
	/** Needs the org's rollout flags from the transport that builds it, which reads them too. */
	static readonly layer = Layer.effect(this, this.make)
}
