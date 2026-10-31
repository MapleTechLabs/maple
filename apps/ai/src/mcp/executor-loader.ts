import { Context, Effect, Layer, Schema } from "effect"
import { cachedRecoverable } from "@maple/infra/cached-recoverable"
import type { McpToolExecutor, McpToolExecutorApi } from "./dispatcher"
import type { McpServicesLive } from "../runtime/mcp-service-graph"

/** What the tool-execution graph needs from the isolate: the Worker's platform services. */
export type McpToolServicesRequirements = Layer.Services<typeof McpServicesLive>

/** The tool-execution graph, as the loader receives it from its import. */
export type McpToolServicesLayer = Layer.Layer<
	McpToolExecutor,
	Layer.Error<typeof McpServicesLive>,
	McpToolServicesRequirements
>

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
	{ readonly load: Effect.Effect<McpToolExecutorApi, McpToolsUnavailableError> }
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
					const graph = yield* importGraph
					// Already loaded with the graph; imported for the service tag only.
					const { McpToolExecutor } = yield* Effect.promise(() => import("./dispatcher"))
					const services = yield* Layer.buildWithScope(graph, scope)
					return Context.get(services, McpToolExecutor)
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
				return { load: yield* cachedRecoverable(build) }
			}),
		)

	static readonly layer = this.layerFrom(
		Effect.promise(() => import("../runtime/mcp-service-graph")).pipe(
			Effect.map((graph) => graph.McpServicesLive),
		),
	)
}
