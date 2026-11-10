/**
 * The runtime a `ChatSession` invocation builds for itself: a turn (`turn-runner`) or an approved
 * proposal (`apply-proposal`). Both reach it through a dynamic import, for the startup-CPU reason
 * `ChatSession.ts` gives; so does the Postgres half, which loads only once a runtime is built.
 */
import { type ChatSessionNamespace, chatSessionsLayerIfBound } from "@maple/backend/platform/chat-sessions"
import { envPorts } from "@maple/backend/platform/env-ports"
import { runtimeTelemetry } from "@maple/infra/worker-telemetry"
import { Effect, Layer, Schema } from "effect"
import { MCP_ANTICIPATED_ERROR_IDENTIFIERS } from "../mcp/expected-failures"
import type { AiSessionPortsLayer } from "../worker/bindings"
import { provideSessionPorts } from "./session-ports"

/** A best-effort step of an invocation (loading the code executor, disposing, flushing) rejected. */
export class ChatRuntimeStepError extends Schema.TaggedError<ChatRuntimeStepError>()(
	"@maple/ai/chat/ChatRuntimeStepError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/**
 * The engine's per-step bookkeeping, which is named and therefore traced.
 *
 * Until effect-agent beta.104 this list also held `AgentRuntime.ownModelResponsePart`, one span per
 * streamed delta: 99.8% of this service's spans on 2026-09-18, evicting the run's real spans from
 * the SDK's 10,000-span buffer. Upstream removed it; these are the zero-content leftovers.
 *
 * Named one by one rather than by an `AgentRuntime.` prefix: `AgentRuntime.model` is the model
 * call, and `dropSpanNames` matches on prefix.
 */
const ENGINE_BOOKKEEPING_SPANS = [
	"AgentRuntime.estimateContextTokens",
	"AgentRuntime.nextContextEstimate",
	"AgentRuntime.decodeEventJson",
	"AgentRuntime.schedulingConcurrency",
	"ToolExposure.eligibleCatalog",
]

/**
 * At module scope, so an invocation exports its spans from the isolate it ran in. Deliberately not
 * `maple-api`: background work sharing the request-facing service's name skewed its percentiles
 * (p99 32s, 2026-09-04).
 */
export const chatTelemetry = runtimeTelemetry({
	serviceName: "maple-chat",
	anticipatedErrorIdentifiers: MCP_ANTICIPATED_ERROR_IDENTIFIERS,
	dropSpanNames: ENGINE_BOOKKEEPING_SPANS,
})

export interface ChatRuntimeInput {
	readonly env: Record<string, unknown>
	/** This Worker's `ChatSession` namespace, from the activation; the graph's `ChatSessions` port. */
	readonly chatSessions?: ChatSessionNamespace
	/** The data-source call limiters and the audit queue, from the activation; none where a test or script runs. */
	readonly bindingPorts?: AiSessionPortsLayer
}

/**
 * What every invocation's service graph sits on: Postgres, the env ports, the session namespace, the
 * Worker's bound ports and `tracing`, which is {@link chatTelemetry}'s layer or a decoration of it.
 */
export const chatPlatformLayer = async <T, E>(input: ChatRuntimeInput, tracing: Layer.Layer<T, E>) => {
	const [{ DatabasePgLive }, { layerMapleDbConnection }] = await Promise.all([
		import("@maple/backend/platform/DatabasePgLive"),
		import("@maple/backend/platform/pg-connection-source"),
	])
	return DatabasePgLive.pipe(
		Layer.provideMerge(layerMapleDbConnection(input.env)),
		Layer.provideMerge(envPorts(input.env)),
		Layer.provideMerge(chatSessionsLayerIfBound(input.chatSessions, input.env)),
		provideSessionPorts(input.bindingPorts),
		Layer.provideMerge(tracing),
	)
}

/**
 * Dispose the invocation's runtime, then flush its spans. Best effort: the outcome is already
 * recorded, so a failed dispose or export is dropped rather than failing the caller.
 */
export const releaseChatRuntime = (
	runtime: { readonly dispose: () => Promise<void> },
	env: Record<string, unknown>,
): Effect.Effect<void> =>
	Effect.tryPromise({
		try: () => runtime.dispose(),
		catch: (cause) => new ChatRuntimeStepError({ message: "Failed to dispose the runtime", cause }),
	}).pipe(
		Effect.ignore,
		Effect.andThen(
			Effect.tryPromise({
				try: () => chatTelemetry.flush(env),
				catch: (cause) => new ChatRuntimeStepError({ message: "Failed to flush the spans", cause }),
			}).pipe(Effect.ignore),
		),
	)
