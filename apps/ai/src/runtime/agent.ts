/** Shared agent construction and execution policy. Feature definitions live with their owners. */
import * as Agent from "@effect-agent/core/Agent"
import { AgentPolicy } from "@effect-agent/core/AgentPolicy"
import * as Output from "@effect-agent/engine/Output"
import { Schema } from "effect"
import type { Toolkit } from "effect/unstable/ai"
import { delegationToolName } from "@maple/domain/chat-session"
import type { PermissionRuleset } from "@maple/domain/permission"
import type { ResolvedModel } from "../platform/Llm"
import { MAX_TOOL_CALLS, REPEATED_TOOL_CALLS, TOOL_CONCURRENCY, TURN_MAX_DURATION } from "./budgets"

export interface AgentDefinition {
	readonly name: string
	/** Shown to a *calling* model in the `task` tool's description. Written for that reader. */
	readonly description: string
	/** `primary` — a session runs as this. `subagent` — only reachable through the `task` tool. */
	readonly mode: "primary" | "subagent"
	readonly prompt: string
	readonly permission: PermissionRuleset
	/**
	 * Caps assistant turns, for a headless pass that budgets by turn rather than by tool call.
	 *
	 * Left unset by every attended agent: a chat turn answers to `MAX_TOOL_CALLS` and to the
	 * duration, so nothing stops it mid-investigation for having thought too many times.
	 */
	readonly steps?: number
	/**
	 * Sub-agents this agent may spawn. Empty (the default) means it gets no `task` tool at all —
	 * the capability is opt-in per agent, not something every turn carries.
	 */
	readonly spawns?: ReadonlyArray<AgentDefinition>
}

/** Resolve the explicitly supplied children; no global feature registry. */
export const spawnableFor = (agent: AgentDefinition): ReadonlyArray<AgentDefinition> =>
	(agent.spawns ?? []).filter((candidate) => candidate.mode === "subagent")

/**
 * The tool that delegates to `agent`.
 *
 * Prefixed so a delegation can never collide with a registry tool, and one tool per sub-agent
 * rather than one `task` tool taking an agent name: a model picks a tool reliably, where it can
 * get a name wrong inside a free-text argument. Re-exported from the wire contract rather than
 * spelled again here — the web client reads the same convention off a streamed tool name to know
 * a delegation opens a sub-agent card, so the two must be one definition.
 */
export { delegationToolName }

/**
 * The delegation paragraph appended to a system prompt when an agent can spawn.
 *
 * The prompt-side twin of the delegation tools' own descriptions: they tell the model *how* to
 * call, this tells it *when*. Both are generated from the child definitions so there is one source of truth
 * for what a given agent can delegate to.
 */
const taskGuidance = (spawnable: ReadonlyArray<AgentDefinition>): string =>
	[
		"## Delegating",
		"",
		"You can hand a self-contained research question to a sub-agent. Each one has its own tool. " +
			"The sub-agent runs its own tool loop and returns a written answer — its raw tool output " +
			"never enters this conversation, so delegation is how you search broadly without burying " +
			"the thread in payloads. It sees NOTHING of this conversation, so its prompt must stand " +
			"alone, and you cannot ask it a follow-up. Launch several at once when the questions are " +
			"independent.",
		"",
		"Delegation is plumbing: report what a sub-agent found as part of your own answer. Never " +
			"tell the user that you delegated, how the work was split, or that a sub-agent ran out " +
			"of anything.",
		"",
		"Available sub-agents:",
		...spawnable.map((agent) => `- \`${delegationToolName(agent.name)}\`: ${agent.description}`),
	].join("\n")

/** The system prompt for a turn: the agent's own persona, plus delegation guidance if it can. */
export const buildSystemPrompt = (agent: AgentDefinition): string => {
	const spawnable = spawnableFor(agent)
	return spawnable.length === 0 ? agent.prompt : `${agent.prompt}\n\n${taskGuidance(spawnable)}`
}

/**
 * A Maple agent record as a finite policy.
 *
 * Every ceiling comes from `./budgets.ts`, which is still the one place they are collected and
 * reasoned about against each other. `maxToolCalls` is the ceiling that actually binds an attended
 * turn; `maxTurns` defaults to it so a turn can never be stopped for thinking more often than it
 * called a tool. Only a headless pass that budgets by turn declares `steps`.
 *
 * `contextTokenLimit` is what makes compaction the engine's job instead of `turn-runner`'s. It
 * arrives from the resolved model rather than the agent, because it is a property of the model.
 */
export const agentPolicyFor = (agent: AgentDefinition, contextTokens?: number): AgentPolicy => {
	return AgentPolicy.make({
		maxTurns: agent.steps ?? MAX_TOOL_CALLS,
		maxToolCalls: MAX_TOOL_CALLS,
		// The shared ceiling. A headless pass tightens it per run with `durationDeadline`, which the
		// engine takes as the earlier of the two — a run option can never widen the definition.
		maxDuration: TURN_MAX_DURATION,
		toolConcurrency: TOOL_CONCURRENCY,
		repeatedFailureLimit: REPEATED_TOOL_CALLS,
		// The closing step, as policy: a turn that runs out of turns gets one more, without tools,
		// to answer from what it found rather than stopping on a wall of tool rows.
		onExhaustion: "final-answer",
		...(contextTokens === undefined ? undefined : { contextTokenLimit: contextTokens }),
	})
}

/**
 * An attended chat agent: prose in, prose out.
 *
 * `Output.text` rather than a JSON output schema because the answer *is* the assistant message. A
 * structured agent (an investigation pass) declares its own output and answers through a completion
 * tool instead.
 */
export const textAgent = (
	agent: AgentDefinition,
	toolkit: Toolkit.Any,
	model: ResolvedModel,
	options: {
		/**
		 * Set when this run answers *through* a tool. Present means the run cannot settle in prose,
		 * which is what an autonomous investigation needs and what a human follow-up must not have.
		 */
		readonly completion?: { readonly tool: string; readonly required: boolean }
	} = {},
) =>
	// `withModel` rather than providing the model Layer around the run: the binding is what carries
	// the model through delegation, so a sub-agent can run on a different one, and the engine builds
	// it fresh per model call instead of holding one language model open for the whole turn.
	Agent.withModel(
		Agent.make(agent.name, {
			input: Schema.String,
			output: Output.text(Schema.String),
			instructions: buildSystemPrompt(agent),
			// The same sentence the `task` tool shows a calling model, so a delegated definition and
			// the tool that reaches it cannot describe themselves differently.
			description: agent.description,
			toolkit,
			policy: agentPolicyFor(agent, model.limits.context),
			...(options.completion === undefined
				? undefined
				: {
						completion: {
							tool: options.completion.tool,
							required: options.completion.required,
							project: ({ parameters }: { readonly parameters: unknown }) =>
								JSON.stringify(parameters),
						},
					}),
		}),
		model.layer,
	)
