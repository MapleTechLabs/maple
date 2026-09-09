/**
 * Running one registered agent to a structured answer, headlessly.
 *
 * The engine runs the turn; this is only the seam that lets a Cloudflare Workflow drive one and
 * collect a typed result. Nothing here re-implements a loop.
 *
 * Two things a workflow needs that a chat session gets for free:
 *
 * - **A structured answer.** A run emits events, not objects, so the schema arrives the way
 *   `submit_diagnosis` already does: a required completion tool whose parameters *are* the schema.
 *   The model filling it in is the model answering.
 * - **A deadline.** Supplied as the policy's wall clock. Duration is a hard rail in the engine, so
 *   a pass that runs out of clock fails rather than getting a last word — which is why the answer
 *   is recorded by the tool handler as it arrives rather than read off a successful result. A lane
 *   that investigated for its whole budget and submitted must not be recorded like one that never
 *   looked.
 */
import { Cause, Duration, Effect, Option, Schema, Stream } from "effect"
import * as Agent from "@effect-agent/core/Agent"
import * as AgentRuntime from "@effect-agent/engine/AgentRuntime"
import { ThreadHistory } from "@effect-agent/engine/ThreadHistory"
import { IdGenerator } from "@effect-agent/core/IdGenerator"
import * as Output from "@effect-agent/engine/Output"
import { agentPolicyFor, buildSystemPrompt, type AgentDefinition } from "@/chat/agents"
import { buildMapleToolkit } from "@/mcp/tools/llm-tools"
import { toInputSchema } from "@/mcp/tools/registry"
import { evaluatePermission } from "@maple/domain/permission"
import { makeRunUsage, type RunUsage } from "@/chat/tools"
import type { LlmClients, ResolvedModel } from "@/platform/Llm"
import { McpToolExecutor } from "@/mcp/dispatcher"
import type { TenantContext } from "@/services/auth/tenant-context"
import { summarizeCause } from "@/platform/describe-cause"

/**
 * The answer's schema must decode without services: it is decoded inside a tool handler, where the
 * only context is the engine's, and a schema that needed a service there would fail at runtime
 * rather than at the call site.
 */
export type AnswerSchema = Schema.Top & { readonly DecodingServices: never }

export interface AgentPassInput<S extends AnswerSchema> {
	/** Correlation id; becomes the run's thread id. */
	readonly id: string
	/**
	 * Gen-ai session this pass's spans group under (`maple_ai.session.id`), so every pass of one
	 * investigation lands in one agent session. Omitted, each pass fragments into a session of its
	 * own under its correlation id.
	 */
	readonly sessionId?: string
	/** Workflow this pass runs inside (`gen_ai.workflow.name`), e.g. `"investigation"`. */
	readonly workflowName?: string
	readonly agent: AgentDefinition
	readonly tenant: TenantContext
	readonly model: ResolvedModel
	/** The single user turn. A sub-agent sees nothing else — its prompt must stand alone. */
	readonly prompt: string
	/** Name of the tool the agent calls to answer, e.g. `submit_candidate`. */
	readonly submitToolName: string
	readonly submitToolDescription: string
	/** The answer's schema. Doubles as the tool's parameters, so the model fills it in directly. */
	readonly schema: S
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

/** What is left of the pass's clock, floored so an already-passed deadline still runs one turn. */
const remaining = (deadlineAtMs: number | undefined): Duration.Input | undefined =>
	deadlineAtMs === undefined ? undefined : Duration.millis(Math.max(1_000, deadlineAtMs - Date.now()))

/**
 * Run the agent until it answers, exhausts its steps, or passes its deadline.
 *
 * Never fails on the agent's behalf: an agent that produces nothing returns `None`, because "this
 * lens found nothing" is a result the boards render and not an error the workflow should propagate.
 */
export const runAgentPass = <S extends AnswerSchema>(
	input: AgentPassInput<S>,
): Effect.Effect<AgentPassOutput<S["Type"]>, never, LlmClients | McpToolExecutor> =>
	Effect.gen(function* () {
		type A = S["Type"]
		const toolExecutor = yield* McpToolExecutor
		// The grouping keys the ingest gateway lifts a run into an agent session by. They sit on the
		// pass's own span here; stamping every nested model-call span is the remaining half, and
		// needs Effect AI's span transformer.
		yield* Effect.annotateCurrentSpan({
			"maple_ai.session.id": input.sessionId ?? input.id,
			"maple_ai.turn.id": input.id,
			...(input.workflowName === undefined
				? undefined
				: { "gen_ai.workflow.name": input.workflowName }),
		})
		const usage = input.usage ?? makeRunUsage()
		let answer: Option.Option<A> = Option.none()
		let toolCalls = 0
		let deadlineHit = false

		/** Decode one submitted answer and keep it. Returns what the model is told. */
		const record = (params: unknown): string => {
			const decoded = decodeAnswer(params)
			if (Option.isNone(decoded)) return "Rejected: the answer did not match its schema."
			answer = decoded
			return "Recorded."
		}

		const decodeAnswer = Schema.decodeUnknownOption(input.schema)

		// One construction, so the toolkit and its handlers cannot disagree. The submit tool is
		// dynamic like the registry's, so its arguments arrive unknown and are decoded here.
		const tools = buildMapleToolkit(toolExecutor, input.tenant, {
			// Separates workflow tool calls from interactive chat ones in telemetry; both otherwise
			// reach the dispatcher through the same builder.
			surface: "workflow",
			include: (name) => evaluatePermission(input.agent.permission, name) !== "deny",
			gate: (name) => evaluatePermission(input.agent.permission, name) === "ask",
			extra: [
				{
					name: input.submitToolName,
					description: input.submitToolDescription,
					parameters: toInputSchema(input.schema),
					// The engine projects a completion call into the run's output rather than dispatching
					// its handler, so this only ever runs when the model calls the tool as an ordinary
					// one. Recording in both places keeps either path reporting the answer.
					handler: (params) => Effect.succeed(record(params)),
				},
			],
		})

		const definition = Agent.make(input.agent.name, {
			input: Schema.String,
			output: Output.text(Schema.String),
			instructions: buildSystemPrompt(input.agent),
			toolkit: tools.toolkit,
			policy: agentPolicyFor(input.agent, input.model.limits.context, remaining(input.deadlineAtMs)),
			completion: {
				tool: input.submitToolName,
				required: true,
				// Recording here rather than reading the run's output: wall clock is a hard rail, so a
				// pass that submits and then runs out of time still has to report what it filed.
				// Re-evaluation on recovery records the same value, so this stays idempotent.
				project: ({ parameters }: { readonly parameters: unknown }) => record(parameters),
			},
		})

		yield* AgentRuntime.stream(definition, input.prompt, {}).pipe(
			Stream.runForEach((event) =>
				Effect.sync(() => {
					if (event._tag === "ToolCallDeclared" && event.toolName !== input.submitToolName) {
						toolCalls += 1
					}
				}),
			),
			Effect.provide(tools.layer),
			input.model.provide,
			Effect.provide(ThreadHistory.layerTransient),
			Effect.provide(IdGenerator.layer),
			// A pass that dies mid-run still reports whatever it managed to submit. Workflow
			// cancellation remains an interruption rather than a false successful pass.
			Effect.catchCause((cause) => {
				if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
				deadlineHit = input.deadlineAtMs !== undefined && Date.now() >= input.deadlineAtMs
				return Effect.logWarning("Agent pass failed; returning the partial result").pipe(
					Effect.annotateLogs({
						agent: input.agent.name,
						messageId: input.id,
						submitted: Option.isSome(answer),
						toolCallCount: toolCalls,
						cause: summarizeCause(cause),
					}),
					Effect.tap(() => Effect.annotateCurrentSpan("maple.agent.recovered_failure", true)),
				)
			}),
		)

		return { answer, usage, toolCalls, deadlineHit }
	})
