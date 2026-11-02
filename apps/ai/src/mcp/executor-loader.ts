import { Context, Effect, Layer, Schema } from "effect"
import { cachedRecoverable } from "@maple/infra/cached-recoverable"
import type { McpToolExecutor, McpToolExecutorApi } from "./dispatcher"
import type { McpServicesLive } from "../runtime/mcp-tool-graph"

/** What the tool-execution graph needs from the isolate: the Worker's platform services. */
export type McpToolServicesRequirements = Layer.Services<typeof McpServicesLive>

/** The tool-execution graph, as the loader receives it from its import. */
export type McpToolServicesLayer = Layer.Layer<
	McpToolExecutor,
	Layer.Error<typeof McpServicesLive>,
	McpToolServicesRequirements
>

/** The executor, and whether the request asking for it is the one that paid to build it. */
export interface McpToolExecutorBuild {
	readonly executor: McpToolExecutorApi
	readonly built: boolean
}

/** The tool-execution graph failed to build; the request that needed it answers 503. */
export class McpToolsUnavailableError extends Schema.TaggedError<McpToolsUnavailableError>()(
	"@maple/mcp/errors/McpToolsUnavailableError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/**
 * The tool executor, imported and built on first use, once per isolate.
 *
 * The executor's service graph is most of the Worker's code. `initialize`, the resource and
 * prompt lists and 401s never run a tool, so they must not pay to load or build it.
 */
export class McpToolExecutorLoader extends Context.Service<
	McpToolExecutorLoader,
	{
		readonly load: Effect.Effect<McpToolExecutorApi, McpToolsUnavailableError>
		/** `load`, also saying whether this fiber is the one that imported and built the graph. */
		readonly loadReportingBuild: Effect.Effect<McpToolExecutorBuild, McpToolsUnavailableError>
	}
>()("@maple/ai/mcp/McpToolExecutorLoader") {
	/** The loader around a given import of the graph; `layer` passes the real one. */
	static readonly layerFrom = (importGraph: Effect.Effect<McpToolServicesLayer>) =>
		Layer.effect(
			this,
			Effect.gen(function* () {
				// Captured at layer build, under the isolate's context: the first `tools/*` request
				// builds the graph into the isolate's scope, never its own.
				const isolate = yield* Effect.context<McpToolServicesRequirements>()
				const scope = yield* Effect.scope
				const build = Effect.gen(function* () {
					// `cachedRecoverable` runs the build on its first caller's fiber.
					const builder = yield* Effect.fiberId
					const graph = yield* importGraph
					// Already loaded with the graph; imported for the service tag only.
					const { McpToolExecutor } = yield* Effect.promise(() => import("./dispatcher"))
					const services = yield* Layer.buildWithScope(graph, scope)
					return { executor: Context.get(services, McpToolExecutor), builder }
				}).pipe(
					// Replaces the request's context rather than merging into it (`provideContext` merges),
					// so nothing the first request carries, like its Postgres scope, reaches the graph.
					Effect.setContext(isolate),
					Effect.mapError(
						(cause) =>
							new McpToolsUnavailableError({
								message: "The MCP tool executor failed to build",
								cause,
							}),
					),
					Effect.withSpan("McpToolExecutorLoader.load"),
				)
				// Forgets failures, so the next `tools/*` request retries a graph that failed to build.
				const cached = yield* cachedRecoverable(build)
				return {
					load: Effect.map(cached, ({ executor }) => executor),
					loadReportingBuild: Effect.gen(function* () {
						const fiber = yield* Effect.fiberId
						const { executor, builder } = yield* cached
						return { executor, built: builder === fiber }
					}),
				}
			}),
		)

	static readonly layer = this.layerFrom(
		Effect.promise(() => import("../runtime/mcp-tool-graph")).pipe(
			Effect.map((graph) => graph.McpServicesLive),
		),
	)
}
