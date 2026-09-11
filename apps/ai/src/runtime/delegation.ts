/**
 * Delegation: the tools an agent uses to hand a self-contained question to a sub-agent.
 *
 * One tool per sub-agent it may spawn, named `task_<agent>`. That is the library's shape — a
 * delegation binds one target definition — and it is the better prompt: a model picks a tool
 * rather than getting an agent's name right inside a free-text argument.
 *
 * What the engine owns here, and what Maple therefore does not re-implement:
 *
 *   - **The context firewall.** The child gets only what `parameters` carries. It never sees the
 *     parent's transcript, and its own tool payloads stay in its thread — the parent gets the
 *     projected result. That is the entire point of delegating rather than calling the tools
 *     inline, and it is now a property of the seam rather than of a hand-written tool.
 *   - **The depth cap.** A delegation's default grant is exactly the target's declared tool names
 *     at depth ceiling one, so a sub-agent cannot spawn a sub-agent. The old numeric counter is
 *     gone with the loop that counted.
 *   - **Budget.** The child spends against a reservation carved from the parent's policy, and
 *     `budgetExhausted` comes back with the answer so a truncated partial reads as one. It is the
 *     task card's badge, not something the model reports: the delegation guidance in `./agent.ts`
 *     tells it not to narrate the plumbing, and `MAX_TOOL_CALLS` is high enough that a child
 *     rarely reaches it at all.
 *
 * Failures are contained rather than raised (`failureMode: "return"`): a sub-agent that dies is a
 * tool result the parent model can route around, exactly like every other Maple tool. A raised one
 * would end the user's turn because the model it delegated to had a bad minute.
 */
import * as Agent from "@effect-agent/core/Agent"
import * as Subagent from "@effect-agent/capabilities/Subagent"
import {
	SubagentReservations,
	SubagentReservationsMemoryLive,
} from "@effect-agent/capabilities/SubagentReservations"
import { IdGenerator } from "@effect-agent/core/IdGenerator"
import * as Output from "@effect-agent/engine/Output"
import { Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import type { ToolExecutorApi } from "./tool-executor"
import type { LlmClients, ResolvedModel } from "../platform/Llm"
import {
	agentPolicyFor,
	buildSystemPrompt,
	delegationToolName,
	spawnableFor,
	type AgentDefinition,
} from "./agent"
import { buildAgentToolkit } from "./tools"

/**
 * What a delegation's handlers provide, and what they still need.
 *
 * `LlmClients` is the child's own model client: the runtime binds the model Layer, so its provider
 * stays in the requirements channel exactly as the parent's does.
 */
type DelegationLayer = Layer.Layer<Tool.HandlersFor<Record<string, Tool.Any>>, never, LlmClients>

/** The same handlers before the run-scoped services below them are supplied. */
type UnwiredDelegationLayer = Layer.Layer<
	Tool.HandlersFor<Record<string, Tool.Any>>,
	never,
	LlmClients | SubagentReservations | IdGenerator
>

/**
 * The delegation tools `agent` may call, and the layer that runs them.
 *
 * `undefined` when the agent spawns nothing — the capability is opt-in per agent, so most turns
 * carry no delegation tool at all rather than one that refuses.
 */
export const buildDelegation = (
	agent: AgentDefinition,
	executor: ToolExecutorApi,
	model: ResolvedModel,
	/**
	 * The model sub-agents run on. Defaults to the conversation's own.
	 *
	 * A separate argument because it is a separate choice: the binding travels with the child
	 * definition, so putting a narrow read-only searcher on a cheaper model than the conversation
	 * it serves is this one value, not a second code path.
	 */
	childModel: ResolvedModel = model,
): { readonly toolkit: Toolkit.Any; readonly layer: DelegationLayer } | undefined => {
	const spawnable = spawnableFor(agent)
	if (spawnable.length === 0) return undefined

	const built = spawnable.map((child) => {
		// The child's own tools, under the child's own ruleset. A sub-agent's authority is its own,
		// not a slice of its parent's, which is what makes `explore` genuinely read-only however it
		// was reached.
		const tools = buildAgentToolkit(executor, child.permission)
		const target = Agent.make(child.name, {
			input: Schema.String,
			output: Output.text(Schema.String),
			instructions: buildSystemPrompt(child),
			description: child.description,
			toolkit: tools.toolkit,
			policy: agentPolicyFor(child, childModel.limits.context),
		})
		// Model-agnostic on purpose: the runtime layer binds the model, so a sub-agent could run on
		// a cheaper one than the conversation it serves without the definition changing.
		const delegation = Subagent.make(delegationToolName(child.name), {
			target,
			description: child.description,
			// A named field rather than the target's bare string input. The default would have the
			// model pass a top-level JSON string as the whole argument, which several providers
			// render badly and every model gets wrong more often than a field it can see.
			parameters: Schema.Struct({
				prompt: Schema.String.annotate({
					description:
						"The question, standing entirely on its own. The sub-agent sees nothing of this " +
						"conversation, so name the service, the interval and anything else it needs.",
				}),
			}),
			prepareInput: ({ prompt }) => Effect.succeed(prompt),
			failureMode: "return",
		})
		return {
			tool: delegation.tool,
			// KNOWN GAP: a child's tokens do not reach the parent's `RunUsage`, so billing and the
			// diagnosis row under-report a turn that delegated. `accumulateUsage` rides on the
			// parent's own run, and there is no seam to hand it to the child at beta.74:
			// `SubagentRuntimeOptions` carries only `durable` and `mapChildFailure`, and
			// `SubagentCompleted` reports turns and finish reason but no usage. The capabilities
			// package's hierarchical budget nodes account for reservations, which is a different
			// thing from what the child actually spent.
			layer: Subagent.SubagentRuntime.layer(delegation, childModel.layer).pipe(
				Layer.provide(tools.layer),
			),
		}
	})

	const [first, ...rest] = built
	// Non-empty by construction: `spawnable` was checked above.
	const merged = rest.reduce<UnwiredDelegationLayer>(
		(layer, entry) => Layer.merge(layer, entry.layer),
		first!.layer,
	)

	return {
		toolkit: Toolkit.merge(...built.map((entry) => Toolkit.make(entry.tool))),
		// One reservation ledger for the whole turn, provided here rather than by the caller: it is
		// what stops two delegation tools in one run each thinking they own the parent's budget.
		layer: merged.pipe(Layer.provide(SubagentReservationsMemoryLive), Layer.provide(IdGenerator.layer)),
	}
}
