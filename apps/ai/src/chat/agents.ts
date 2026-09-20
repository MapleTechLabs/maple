/**
 * The agents a chat turn can run as.
 *
 * An agent is a record: a prompt and a permission ruleset. That is what makes "this surface should
 * not be able to create alert rules" a one-line change instead of a new branch in the loop.
 *
 * One agent does the whole job. Maple used to split an investigation across a planner, N
 * hypothesis lanes and a validator, and a chat turn could delegate to a read-only `explore`
 * sub-agent; every handoff dropped the evidence the next stage needed, and the run could only be
 * evaluated stage by stage while the failures lived in between. The agent that gathers the
 * evidence is the agent that acts on it.
 *
 * `ChatMode` and `chatModeFromSessionId` stay in the domain package — they are on the wire and the
 * web client derives from them — so a new surface is a literal there and a record here, added
 * together. Every mode names an agent, by construction; `agents.test.ts` fails if one is ever
 * added without one.
 */
import * as Agent from "@effect-agent/core/Agent"
import { AgentPolicy } from "@effect-agent/core/AgentPolicy"
import * as Output from "@effect-agent/engine/Output"
import { Schema } from "effect"
import type { Toolkit } from "effect/unstable/ai"
import { chatModeFromSessionId, type ChatMode } from "@maple/domain/chat-session"
// The specific file, not the `./loop` barrel: the barrel re-exports `turn.ts`, which imports this
// module back. `budgets.ts` depends on nothing but `effect`.
import {
	type AgentBudget,
	CHAT_BUDGET,
	INVESTIGATION_BUDGET,
	liveContextLimit,
	REPEATED_TOOL_CALLS,
	TOOL_CONCURRENCY,
} from "./budgets"
import type { PermissionRuleset } from "@maple/domain/permission"
import type { ResolvedModel } from "../platform/Llm"
import { DEFAULT_RULESET, READ_ONLY_RULESET } from "./permissions"
import { BOT_SYSTEM_PROMPT, INVESTIGATE_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./prompts"

export interface AgentDefinition {
	readonly name: string
	readonly description: string
	readonly prompt: string
	readonly permission: PermissionRuleset
	/**
	 * What a turn as this agent may spend. An attended reply and an unattended investigation are
	 * different work; they shared one budget until 2026-09-20, and it was the investigation's.
	 */
	readonly budget: AgentBudget
}

export const AGENTS: Readonly<Record<string, AgentDefinition>> = {
	default: {
		name: "default",
		description: "General Maple assistant.",
		prompt: SYSTEM_PROMPT,
		permission: DEFAULT_RULESET,
		budget: CHAT_BUDGET,
	},
	alert: {
		name: "alert",
		description: "Assists with an alert in context.",
		prompt: SYSTEM_PROMPT,
		permission: DEFAULT_RULESET,
		budget: CHAT_BUDGET,
	},
	"widget-fix": {
		name: "widget-fix",
		description: "Repairs a dashboard widget in context.",
		prompt: SYSTEM_PROMPT,
		permission: DEFAULT_RULESET,
		budget: CHAT_BUDGET,
	},
	investigate: {
		name: "investigate",
		description: "Runs an autonomous investigation.",
		prompt: INVESTIGATE_SYSTEM_PROMPT,
		// The ruleset a *turn* runs under is narrowed further when the turn is the autonomous pass;
		// see `rulesetForTurn` in `./permissions`. This is what an attended follow-up in the same
		// session gets.
		permission: DEFAULT_RULESET,
		budget: INVESTIGATION_BUDGET,
	},
	bot: {
		name: "bot",
		description: "Answers in a chat platform's channels.",
		prompt: BOT_SYSTEM_PROMPT,
		// Denied, not gated. A bot turn is raised by whoever is in the channel, under an org-level
		// actor with no Maple user behind it, and the surface has nowhere to render an approval card
		// — so a mutating tool here would be a proposal nobody can ever apply. This is the whole of
		// "the bot is read-only": an unoffered tool cannot be called.
		permission: READ_ONLY_RULESET,
		budget: CHAT_BUDGET,
	},
} as const satisfies Readonly<Record<string, AgentDefinition>>

/** Every `ChatMode` literal names an agent; the mode string *is* the agent name. */
export const agentForSession = (sessionId: string): AgentDefinition => {
	const mode: ChatMode = chatModeFromSessionId(sessionId)
	// Non-null by construction, and pinned by `agents.test.ts` rather than by hope.
	return AGENTS[mode]!
}

/** The system prompt for a turn: the agent's own persona. */
export const buildSystemPrompt = (agent: AgentDefinition): string => agent.prompt

/**
 * A Maple agent record as a finite policy.
 *
 * Every ceiling comes from the agent's own `budget` and from `./budgets.ts`, which is still the one
 * place they are collected and reasoned about against each other. `maxToolCalls` is the ceiling
 * that binds a turn; `maxTurns` matches it so a turn can never be stopped for thinking more often
 * than it called a tool.
 *
 * `contextTokenLimit` is what makes compaction the engine's job. It is derived from the resolved
 * model rather than taken from it: handing over the model's whole window, as this did until
 * 2026-09-20, put the limit an order of magnitude above any prompt the agent sends, so compaction
 * never ran. `liveContextLimit` explains both bounds.
 */
export const agentPolicyFor = (agent: AgentDefinition, contextTokens?: number): AgentPolicy => {
	const budget = agent.budget
	return AgentPolicy.make({
		maxTurns: budget.maxToolCalls,
		maxToolCalls: budget.maxToolCalls,
		maxDuration: budget.maxDuration,
		tokenBudget: budget.tokenBudget,
		completionReserveTokens: budget.completionReserveTokens,
		toolConcurrency: TOOL_CONCURRENCY,
		repeatedFailureLimit: REPEATED_TOOL_CALLS,
		// The closing step, as policy: a turn that runs out of turns, or out of tokens, gets one
		// more without tools, to answer from what it found rather than stopping on a wall of tool
		// rows. This is also what makes `tokenBudget` a deadline rather than a way to lose a run.
		onExhaustion: "final-answer",
		...(contextTokens === undefined ? undefined : { contextTokenLimit: liveContextLimit(contextTokens) }),
	})
}

/**
 * A chat agent: prose in, prose out.
 *
 * `Output.text` rather than a JSON output schema because the answer *is* the assistant message. An
 * investigation session declares `submit_diagnosis` as its completion tool as well: a call to it
 * settles the run, and the turn runner closes out a pass that never made one.
 */
export const chatAgent = (
	agent: AgentDefinition,
	toolkit: Toolkit.Any,
	model: ResolvedModel,
	options: {
		/** Set when a call to this tool settles the run. Never engine-required; see `tools.ts`. */
		readonly completion?: { readonly tool: string; readonly required: boolean }
	} = {},
) =>
	// `withModel` rather than providing the model Layer around the run: the engine builds the model
	// fresh per model call instead of holding one language model open for the whole turn.
	Agent.withModel(
		Agent.make(agent.name, {
			input: Schema.String,
			output: Output.text(Schema.String),
			instructions: buildSystemPrompt(agent),
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
