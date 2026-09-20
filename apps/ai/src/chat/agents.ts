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
import { CHAT_BOT_USER_ID, chatModeFromSessionId, type ChatMode } from "@maple/domain/chat-session"
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
import { DEFAULT_RULESET } from "./permissions"
import { BOT_SYSTEM_PROMPT, INVESTIGATE_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./prompts"

/**
 * What a turn as this agent *is*, to everything downstream of the run.
 *
 * One literal, three readers that already accept it: the tool registry's audience filter
 * (`McpToolSurface`), the LLM call's tags, and the billing meter's source.
 */
export type ChatSurface = "chat" | "bot"

export interface AgentDefinition {
	readonly name: string
	readonly description: string
	readonly prompt: string
	readonly permission: PermissionRuleset
	readonly surface: ChatSurface
	/**
	 * What a turn as this agent may spend. An attended reply and an unattended investigation are
	 * different work; they shared one budget until 2026-09-20, and it was the investigation's.
	 */
	readonly budget: AgentBudget
}

/**
 * Keyed by `ChatMode`, not by `string`: a new mode is then a compile error here rather than an
 * `undefined` discovered mid-turn, and `agentForSession` needs no non-null assertion.
 */
export const AGENTS: Readonly<Record<ChatMode, AgentDefinition>> = {
	default: {
		name: "default",
		description: "General Maple assistant.",
		prompt: SYSTEM_PROMPT,
		permission: DEFAULT_RULESET,
		surface: "chat",
		budget: CHAT_BUDGET,
	},
	alert: {
		name: "alert",
		description: "Assists with an alert in context.",
		prompt: SYSTEM_PROMPT,
		permission: DEFAULT_RULESET,
		surface: "chat",
		budget: CHAT_BUDGET,
	},
	"widget-fix": {
		name: "widget-fix",
		description: "Repairs a dashboard widget in context.",
		prompt: SYSTEM_PROMPT,
		permission: DEFAULT_RULESET,
		surface: "chat",
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
		surface: "chat",
		budget: INVESTIGATION_BUDGET,
	},
	bot: {
		name: "bot",
		description: "Answers in a chat platform's channels.",
		prompt: BOT_SYSTEM_PROMPT,
		// The same propose-then-apply model as in-app chat: reads run, mutations are proposed and
		// wait. The platform connector renders the proposal for the channel to approve or reject.
		permission: DEFAULT_RULESET,
		// What the bot does *not* get is the internal audience: `bot` is not an internal surface, so
		// the agents-only tools — the repository sandbox above all — are never in its catalog. A
		// reply lands wherever the thread is readable, and `sandbox_exec` alone is code execution
		// against the org's checkout.
		surface: "bot",
		budget: CHAT_BUDGET,
	},
} as const satisfies Readonly<Record<ChatMode, AgentDefinition>>

/** Every `ChatMode` literal names an agent; the mode string *is* the agent name. */
export const agentForSession = (sessionId: string): AgentDefinition =>
	AGENTS[chatModeFromSessionId(sessionId)]

/**
 * The agent a turn runs as, which the session id alone does not decide.
 *
 * Either signal makes a turn the bot's, and neither is redundant: the tab prefix is what a session
 * built in this app carries, while the actor is what a transport Worker outside it controls. A
 * mismatched pair must not hand an org-level actor the internal toolset — `bot` is not an internal
 * surface, and that is the audience boundary a channel-invoked turn stays behind.
 *
 * Returning the whole agent rather than just its surface is what keeps prompt, permission and
 * surface one answer: a turn cannot run on the bot's surface while being told it is answering in a
 * 420px panel, or be filed under a surface it did not run on. Every reader takes it from here.
 */
export const agentForTurn = (sessionId: string, userId: string): AgentDefinition =>
	userId === CHAT_BOT_USER_ID ? AGENTS.bot : agentForSession(sessionId)

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
			// The turn's message is already prose, and without this projection the engine falls back to
			// `JSON.stringify` of the encoded input: the model reads a quoted literal whose newlines are
			// two characters, and Agent Sessions replays that escaped blob back to the engineer.
			inputPrompt: (text: string) => text,
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
