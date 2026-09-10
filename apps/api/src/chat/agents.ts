/**
 * The agents a chat turn can run as.
 *
 * Supersedes `modes.ts`, which was a string switch from `ChatMode` to a system prompt. An agent is
 * now a record: a prompt, a permission ruleset, an optional step budget, and the sub-agents it may
 * delegate to. That is what makes "this surface should not be able to create alert rules" a
 * one-line change instead of a new branch in the loop.
 *
 * `ChatMode` and `chatModeFromSessionId` are deliberately untouched — they are on the wire and the
 * web client derives from them. Every mode names a primary agent, by construction; `agents.test.ts`
 * fails if one is ever added without one.
 */
import * as Agent from "@effect-agent/core/Agent"
import { AgentPolicy } from "@effect-agent/core/AgentPolicy"
import * as Output from "@effect-agent/engine/Output"
import { Schema } from "effect"
import type { Toolkit } from "effect/unstable/ai"
import { chatModeFromSessionId, delegationToolName, type ChatMode } from "@maple/domain/chat-session"
import { PermissionRule } from "@maple/domain/permission"
// The specific file, not the `./loop` barrel: the barrel re-exports `turn.ts`, which imports this
// module back. `budgets.ts` depends on nothing but `effect`.
import { MAX_TOOL_CALLS, REPEATED_TOOL_CALLS, TOOL_CONCURRENCY, TURN_MAX_DURATION } from "./budgets"
import { buildHypothesisSystemPrompt, hypothesisRuleset } from "@/workflows/hypothesis-catalogue"
import { PLANNER_MAX_STEPS, PLANNER_SYSTEM_PROMPT, PLANNER_TOOL_NAMES } from "@/workflows/planner-prompt"
import type { PermissionRuleset } from "@maple/domain/permission"
import type { ResolvedModel } from "@/platform/Llm"
import { DEFAULT_RULESET, READ_ONLY_RULESET } from "./permissions"
import {
	EXPLORE_SYSTEM_PROMPT,
	INVESTIGATE_SYSTEM_PROMPT,
	SYSTEM_PROMPT,
	VALIDATOR_SYSTEM_PROMPT,
} from "./prompts"

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
	readonly spawns?: ReadonlyArray<string>
}

/**
 * Assistant turns a hypothesis lane gets.
 *
 * Raised from the lens era's 6. That number was sized for a *framing* with
 * nothing specific to look at — "is there a deploy correlation here?" — where
 * more steps mostly bought more ways to say no. A lane now arrives with a named
 * claim, a confirmed evidence source and an established interval, so the extra
 * steps go into testing it rather than into finding something to test.
 *
 * Raised again to 10 alongside the evidence floor in the lane prompt. Production
 * lanes were stopping at four to six steps and about thirteen seconds against a
 * six-minute budget — not because they ran out of room, but because nothing told
 * them that thin was unacceptable. The prompt is what changes that; this only
 * makes sure the ceiling is not what stops them once it does.
 */
export const HYPOTHESIS_MAX_STEPS = 10

/**
 * The agent that tests one hypothesis.
 *
 * Built per run rather than registered in {@link AGENTS}, which is the visible
 * consequence of hypotheses being planner-written: there is no fixed set of them
 * to register. It is still an `AgentDefinition` on the shared turn loop, so it
 * keeps retry, context pruning, permission gating and the step budget — none of
 * that is re-implemented for headless passes.
 *
 * A sub-agent by construction: no `spawns`, so it never sees the `task` tool and
 * cannot delegate. A lane that could fan out further would make the width of an
 * investigation unbounded and unattributable.
 */
export const hypothesisAgent = (hypothesis: {
	readonly id: string
	readonly name: string
	readonly question: string
	readonly claimToTest: string
	readonly rationale: string
	readonly toolNames: ReadonlyArray<string>
}): AgentDefinition => ({
	name: `hypothesis-${hypothesis.id}`,
	description: hypothesis.question,
	mode: "subagent",
	prompt: buildHypothesisSystemPrompt(hypothesis),
	// Gated twice, as the tool `include` filter and as a ruleset, for the same
	// reason the read-only ruleset is: a tool the model never sees cannot be
	// called, and a tool that slips through the filter is still denied.
	permission: hypothesisRuleset(new Set(hypothesis.toolNames)),
	steps: HYPOTHESIS_MAX_STEPS,
})

/**
 * The agent that decides what the run is spent on.
 *
 * Also built rather than registered, and for a duller reason than the lanes: it
 * is only ever invoked directly by the workflow, so a registry entry would be a
 * second name for the same thing plus a test asserting they agree.
 */
export const plannerAgent = (): AgentDefinition => ({
	name: "investigation-planner",
	description: "Scopes an incident and writes the hypotheses worth testing.",
	mode: "subagent",
	prompt: PLANNER_SYSTEM_PROMPT,
	permission: hypothesisRuleset(PLANNER_TOOL_NAMES),
	steps: PLANNER_MAX_STEPS,
})

export const AGENTS: Readonly<Record<string, AgentDefinition>> = {
	/**
	 * Ranks the lens candidates. Denied every tool on purpose: it adjudicates text
	 * the lenses already gathered, and giving it instruments would make it a sixth
	 * lens with a casting vote — the thing the fan-out exists to avoid.
	 */
	"investigation-validator": {
		name: "investigation-validator",
		description: "Ranks investigation hypothesis candidates and promotes at most one.",
		mode: "subagent",
		prompt: VALIDATOR_SYSTEM_PROMPT,
		permission: [new PermissionRule({ tool: "*", action: "deny" })],
		steps: 1,
	},
	default: {
		name: "default",
		description: "General Maple assistant.",
		mode: "primary",
		prompt: SYSTEM_PROMPT,
		permission: DEFAULT_RULESET,
		spawns: ["explore"],
	},
	alert: {
		name: "alert",
		description: "Assists with an alert in context.",
		mode: "primary",
		prompt: SYSTEM_PROMPT,
		permission: DEFAULT_RULESET,
	},
	"widget-fix": {
		name: "widget-fix",
		description: "Repairs a dashboard widget in context.",
		mode: "primary",
		prompt: SYSTEM_PROMPT,
		permission: DEFAULT_RULESET,
	},
	investigate: {
		name: "investigate",
		description: "Runs an autonomous investigation.",
		mode: "primary",
		prompt: INVESTIGATE_SYSTEM_PROMPT,
		permission: DEFAULT_RULESET,
		spawns: ["explore"],
	},
	explore: {
		name: "explore",
		description:
			"Read-only investigator. Give it a self-contained question about traces, logs, metrics " +
			"or errors and it returns a written answer. It cannot change anything and cannot spawn " +
			"further agents. Use it to search broadly without filling this conversation with raw " +
			"tool output.",
		mode: "subagent",
		prompt: EXPLORE_SYSTEM_PROMPT,
		permission: READ_ONLY_RULESET,
	},
} as const satisfies Readonly<Record<string, AgentDefinition>>

/** Every `ChatMode` literal names a primary agent; the mode string *is* the agent name. */
export const agentForSession = (sessionId: string): AgentDefinition => {
	const mode: ChatMode = chatModeFromSessionId(sessionId)
	// Non-null by construction, and pinned by `agents.test.ts` rather than by hope.
	return AGENTS[mode]!
}

/** The sub-agents `agent` is allowed to spawn, resolved and filtered to real subagent records. */
export const spawnableFor = (agent: AgentDefinition): ReadonlyArray<AgentDefinition> =>
	(agent.spawns ?? [])
		.map((name) => AGENTS[name])
		.filter((candidate): candidate is AgentDefinition => candidate?.mode === "subagent")

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
 * call, this tells it *when*. Both are generated from the registry so there is one source of truth
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
export const chatAgent = (
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
