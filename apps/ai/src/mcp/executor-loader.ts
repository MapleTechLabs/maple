import { Context, Duration, Effect, Layer, Ref, Schema } from "effect"
import { AfterResponse, runAfterResponse } from "@maple/backend/platform/after-response"
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

/**
 * Where a `tools/call` got its executor: built on its own request (`inline`), from a background
 * prewarm it is the first call to use (`prewarm`), or already in use by an earlier call (`reused`).
 */
export type McpToolExecutorBuildKind = "inline" | "prewarm" | "reused"

/** Span attribute naming the {@link McpToolExecutorBuildKind}, on the request and the build span. */
export const MCP_EXECUTOR_BUILD_ATTRIBUTE = "maple.mcp.executor_build"

/** The executor, and how the request asking for it came by it. */
export interface McpToolExecutorBuild {
	readonly executor: McpToolExecutorApi
	readonly build: McpToolExecutorBuildKind
}

/** Lets the response go out before the build takes the isolate's CPU. */
const PREWARM_DELAY = Duration.millis(1)

/** Set on the background prewarm's fiber, so its build says where it came from. */
class PrewarmBuild extends Context.Reference<boolean>("@maple/ai/mcp/PrewarmBuild", {
	defaultValue: () => false,
}) {}

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
		/** `load`, also saying how this request came by the executor. */
		readonly loadReportingBuild: Effect.Effect<McpToolExecutorBuild, McpToolsUnavailableError>
		/**
		 * Starts the build in the background after this response, unless it is already built or the
		 * invocation cannot defer work. A `tools/call` arriving meanwhile joins the same build.
		 */
		readonly prewarm: Effect.Effect<void>
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
				const ready = yield* Ref.make(false)
				// A prewarmed executor no `tools/call` has used yet; the first one to use it claims it.
				const prewarmUnclaimed = yield* Ref.make(false)
				const graphBuild = Effect.gen(function* () {
					const graph = yield* importGraph
					// Already loaded with the graph; imported for the service tag only.
					const { McpToolExecutor } = yield* Effect.promise(() => import("./dispatcher"))
					const services = yield* Layer.buildWithScope(graph, scope)
					return Context.get(services, McpToolExecutor)
				}).pipe(
					// Replaces the request's context rather than merging into it (`provideContext` merges),
					// so nothing the first request carries, like its Postgres scope, reaches the graph.
					Effect.setContext(isolate),
				)
				const build = Effect.gen(function* () {
					// `cachedRecoverable` runs the build on its first caller's fiber.
					const builder = yield* Effect.fiberId
					const prewarmed = yield* PrewarmBuild
					yield* Effect.annotateCurrentSpan(
						MCP_EXECUTOR_BUILD_ATTRIBUTE,
						prewarmed ? "prewarm" : "inline",
					)
					const executor = yield* graphBuild
					yield* Ref.set(prewarmUnclaimed, prewarmed)
					yield* Ref.set(ready, true)
					return { executor, builder, prewarmed }
				}).pipe(
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
				const prewarmInBackground = Effect.sleep(PREWARM_DELAY).pipe(
					Effect.andThen(cached),
					Effect.provideService(PrewarmBuild, true),
					Effect.asVoid,
					// The build span already records the failure; a later `tools/call` builds again.
					Effect.catchCause((cause) =>
						Effect.logWarning("MCP tool executor prewarm failed", cause),
					),
				)
				return {
					load: Effect.map(cached, ({ executor }) => executor),
					loadReportingBuild: Effect.gen(function* () {
						const fiber = yield* Effect.fiberId
						const { executor, builder, prewarmed } = yield* cached
						if (builder === fiber) return { executor, build: "inline" as const }
						const claimed = prewarmed && (yield* Ref.getAndSet(prewarmUnclaimed, false))
						return { executor, build: claimed ? ("prewarm" as const) : ("reused" as const) }
					}),
					prewarm: Effect.gen(function* () {
						if (yield* Ref.get(ready)) return
						// Inline would put the build back on this response, the cost prewarming avoids.
						if ((yield* AfterResponse) === undefined) return
						yield* runAfterResponse(prewarmInBackground)
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
