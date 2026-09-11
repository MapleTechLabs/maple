/**
 * Running one registered agent to a structured answer, headlessly.
 *
 * The engine runs the turn; this is only the seam that lets a Cloudflare Workflow drive one and
 * collect a typed result. Nothing here re-implements a loop.
 *
 * Two things a workflow needs that a chat session gets for free:
 *
 * - **A structured answer.** A run emits events, not objects, so the schema arrives as a required
 *   completion tool whose parameters *are* the schema — see `./submit-tools.ts`. The engine decodes
 *   those parameters against that schema and projects them into the run's output, which is why the
 *   agent's declared `output` is the answer's schema and the projection is the identity.
 * - **A deadline.** Supplied as `durationDeadline`, an absolute instant the engine takes as the
 *   earlier of it and the policy's own wall clock. Absolute rather than a remaining duration
 *   because a Cloudflare Workflow body re-runs: a `Date.now()` computed here differs on every
 *   replay and invalidates cached steps.
 *
 * Duration is a hard rail, so a pass that runs out of clock fails rather than getting a last word.
 * The answer is therefore read off the submit call as it is declared, not off a successful result:
 * a lane that investigated for its whole budget and submitted must not be recorded like one that
 * never looked.
 */
import { Cause, DateTime, Effect, Layer, Option, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as Agent from "@effect-agent/core/Agent"
import { AgentPolicyError } from "@effect-agent/core/AgentError"
import { ThreadId } from "@effect-agent/core/Identifiers"
import { IdGenerator } from "@effect-agent/core/IdGenerator"
import * as AgentRuntime from "@effect-agent/engine/AgentRuntime"
import { ThreadHistory } from "@effect-agent/engine/ThreadHistory"
import { agentPolicyFor, buildSystemPrompt, type AgentDefinition } from "@/chat/agents"
import { buildMapleToolkit } from "@/mcp/tools/llm-tools"
import { evaluatePermission } from "@maple/domain/permission"
import { accumulateUsage, makeRunUsage, type RunUsage } from "@/chat/tools"
import {
	type LlmClients,
	type ResolvedModel,
	agentSessionSpanAttributes,
	genAiProviderName,
} from "@/platform/Llm"
import { invokeAgentAttributes } from "@/platform/genai-spans"
import { McpToolExecutor } from "@/mcp/dispatcher"
import type { TenantContext } from "@/services/auth/tenant-context"
import { summarizeCause } from "@/platform/describe-cause"

/**
 * The answer's schema must decode *and* encode without services.
 *
 * Both halves run inside the engine: the completion projection decodes the submit call's
 * parameters, and the run's terminal output is encoded back through the same schema. The only
 * context either has is the run's, so a schema that needed a service would fail at runtime rather
 * than at the call site.
 */
export type AnswerSchema = Schema.Top & {
	readonly DecodingServices: never
	readonly EncodingServices: never
}

/**
 * The tool a pass answers through, with the handler layer that satisfies its toolkit.
 *
 * Built in `./submit-tools.ts` so name, schema, toolkit and handlers are declared together and
 * cannot drift apart.
 */
export interface AgentPassSubmit<S extends AnswerSchema, Tools extends Record<string, Tool.Any>> {
	readonly name: string
	readonly schema: S
	readonly toolkit: Toolkit.Toolkit<Tools>
	readonly layer: Layer.Layer<Tool.HandlersFor<Tools>>
}

export interface AgentPassInput<S extends AnswerSchema, Tools extends Record<string, Tool.Any>> {
	/** Correlation id; becomes the run's thread id. */
	readonly id: string
	readonly agent: AgentDefinition
	readonly tenant: TenantContext
	readonly model: ResolvedModel
	/** The single user turn. A sub-agent sees nothing else — its prompt must stand alone. */
	readonly prompt: string
	readonly submit: AgentPassSubmit<S, Tools>
	/**
	 * Wall clock after which the run stops. Omit for the agent's default. Never derive this inside a
	 * Cloudflare Workflow body — a `Date.now()` there differs on every replay and invalidates
	 * cached steps.
	 */
	readonly deadlineAtMs?: number
	readonly usage?: RunUsage
}

export interface AgentPassOutput<A> {
	/** `None` when the agent never called its submit tool — a real outcome, not a crash. */
	readonly answer: Option.Option<A>
	readonly usage: RunUsage
	/** Tool calls the agent made, excluding the submit call itself. */
	readonly toolCalls: number
	readonly deadlineHit: boolean
}

const decodeThreadId = Schema.decodeSync(ThreadId)

/**
 * The instant a pass stops, floored a second into the future.
 *
 * A workflow computes its deadlines up front, so a step that starts late — after a retry, after a
 * queue — can arrive already past its own. The floor is what leaves it one turn to file something
 * rather than failing before its first model call. The clock is read here rather than in the
 * workflow body, where a `Date.now()` differs on every replay and invalidates cached steps.
 */
const stopAt = (deadlineAtMs: number): DateTime.Utc =>
	DateTime.makeUnsafe(Math.max(deadlineAtMs, Date.now() + 1_000))

/**
 * Whether the run ended on the engine's duration rail.
 *
 * Read off the typed policy failure rather than by comparing the clock to the deadline. Those two
 * answers differ exactly when it matters: a pass that failed for its own reasons a millisecond
 * after its deadline is not a pass that ran out of time, and the validator ranks a cut-short lane
 * differently from one that reported nothing.
 */
const hitDurationRail = (cause: Cause.Cause<unknown>): boolean =>
	Option.match(Cause.findErrorOption(cause), {
		onNone: () => false,
		onSome: (error) => error instanceof AgentPolicyError && error.limit === "duration",
	})

/**
 * Run the agent until it answers, exhausts its steps, or passes its deadline.
 *
 * Never fails on the agent's behalf: an agent that produces nothing returns `None`, because "this
 * lens found nothing" is a result the boards render and not an error the workflow should propagate.
 */
export const runAgentPass = <S extends AnswerSchema, Tools extends Record<string, Tool.Any>>(
	input: AgentPassInput<S, Tools>,
): Effect.Effect<AgentPassOutput<S["Type"]>, never, LlmClients | McpToolExecutor> =>
	Effect.gen(function* () {
		type A = S["Type"]
		const toolExecutor = yield* McpToolExecutor
		const usage = input.usage ?? makeRunUsage()
		let answer: Option.Option<A> = Option.none()
		let toolCalls = 0
		let deadlineHit = false

		const decodeAnswer = Schema.decodeUnknownOption(input.submit.schema)

		const tools = buildMapleToolkit(toolExecutor, input.tenant, {
			// Separates workflow tool calls from interactive chat ones in telemetry; both otherwise
			// reach the dispatcher through the same builder.
			surface: "workflow",
			include: (name) => evaluatePermission(input.agent.permission, name) !== "deny",
			gate: (name) => evaluatePermission(input.agent.permission, name) === "ask",
		})

		// Widened to `Toolkit.Any` deliberately. The Maple half is built from a runtime catalogue, so
		// the merged record's exact key set means nothing to a reader and every downstream projection
		// of it — tool parameter encoding services, the completion declaration — resolves to the same
		// place through the erased type.
		const toolkit: Toolkit.Any = Toolkit.merge(tools.toolkit, input.submit.toolkit)

		// The pass's own span roots the turn: the session view files a lane's untagged tool, HTTP and
		// database spans by their nearest tagged ancestor, and concurrent lanes would otherwise be
		// partitioned by start time alone. The model-call spans carry the same keys via the model. It
		// is also the pass's `invoke_agent` span, which is where the agent and its tools are described.
		yield* Effect.annotateCurrentSpan({
			...agentSessionSpanAttributes(input.model.tags),
			...invokeAgentAttributes({
				agentName: input.agent.name,
				agentDescription: input.agent.description,
				conversationId: input.id,
				providerName: genAiProviderName(input.model.provider),
				model: input.model.name,
				tools: Object.values(toolkit.tools),
			}),
		})

		const definition = Agent.withModel(
			Agent.make(input.agent.name, {
				input: Schema.String,
				output: input.submit.schema,
				instructions: buildSystemPrompt(input.agent),
				description: input.agent.description,
				toolkit,
				policy: agentPolicyFor(input.agent, input.model.limits.context),
				completion: {
					tool: input.submit.name,
					required: true,
					// The identity, and pure — which recovery requires, because it re-evaluates this.
					// The engine has already decoded these parameters against the submit tool's own
					// schema, which is the agent's output schema, so the decoded value *is* the answer.
					project: ({ parameters }: { readonly parameters: A }) => parameters,
				},
			}),
			input.model.layer,
		)

		yield* AgentRuntime.stream(definition, input.prompt, {
			threadId: decodeThreadId(input.id),
			// The run event stream carries no token counts, so without this hook every pass reports
			// zero and the investigation rows record no cost.
			budget: accumulateUsage(usage),
			...(input.deadlineAtMs === undefined
				? undefined
				: { durationDeadline: stopAt(input.deadlineAtMs) }),
		}).pipe(
			Stream.runForEach((event) =>
				Effect.sync(() => {
					if (event._tag !== "ToolCallDeclared") return
					if (event.toolName !== input.submit.name) {
						toolCalls += 1
						return
					}
					// Taken from the declaration rather than from the run's output, so a pass that
					// submitted and then ran out of clock still reports what it filed. A declaration the
					// engine goes on to reject leaves the previous answer standing.
					const decoded = decodeAnswer(event.parameters)
					if (Option.isSome(decoded)) answer = decoded
				}),
			),
			// One provide, so the pass's services share a lifetime. A pass is an entry point: the
			// workflow step owns this scope and nothing outside it composes these layers. The model's
			// own client stays in the requirements channel, where the workflow's runtime answers it.
			// oxlint-disable-next-line effecttsgo/strict-effect-provide
			Effect.provide(
				Layer.mergeAll(
					tools.layer,
					input.submit.layer,
					ThreadHistory.layerTransient,
					IdGenerator.layer,
				),
			),
			// A pass that dies mid-run still reports whatever it managed to submit. Workflow
			// cancellation remains an interruption rather than a false successful pass.
			Effect.catchCause((cause) => {
				if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
				deadlineHit = hitDurationRail(cause)
				return Effect.logWarning("Agent pass failed; returning the partial result").pipe(
					Effect.annotateLogs({
						agent: input.agent.name,
						messageId: input.id,
						submitted: Option.isSome(answer),
						toolCallCount: toolCalls,
						deadlineHit,
						cause: summarizeCause(cause),
					}),
					Effect.tap(() => Effect.annotateCurrentSpan("maple.agent.recovered_failure", true)),
				)
			}),
		)

		return { answer, usage, toolCalls, deadlineHit }
	})
