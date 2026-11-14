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
 * An agent is what a conversation IS, never who is driving it. Who is driving a turn is its
 * `ChatTurnOrigin`, and `./profiles.ts` is the one place that reads it — so a surface becoming
 * reachable from somewhere new costs a profile branch rather than a mode, a record and a prompt.
 *
 * `ChatMode` and `chatSessionKind` stay in the domain package because the session id is on the
 * wire and the mode is derived from it server-side. Every mode names an agent, by construction.
 */
import * as Agent from "@yielded/agent/agent"
import { AgentPolicy } from "@yielded/agent/agent-policy"
import * as Output from "@yielded/agent/output"
import { Option, Schema } from "effect"
import type { Toolkit } from "effect/ai"
import {
	chatSessionKind,
	type ChatMode,
	type ChatSessionKind,
	type ChatTurnOrigin,
} from "@maple/domain/chat-session"
import { PrReviewId, PrReviewReplyId } from "@maple/domain/http"
import { InvestigationId } from "@maple/primitives"
import type { AiUsageSource } from "@maple/backend/services/billing/autumn-tracker"
import {
	type AgentBudget,
	CHAT_BUDGET,
	INVESTIGATION_BUDGET,
	PR_REPLY_BUDGET,
	PR_REVIEW_BUDGET,
	liveContextLimit,
	MODEL_RETRIES,
	REPEATED_TOOL_CALLS,
	TOOL_CONCURRENCY,
} from "./budgets"
import type { PermissionRuleset } from "@maple/domain/permission"
import type { ResolvedModel } from "../platform/Llm"
import { DEFAULT_RULESET, PR_REVIEW_RULESET } from "./permissions"
import {
	CLOSE_OUT_PROMPT,
	INVESTIGATE_SYSTEM_PROMPT,
	PR_REPLY_CLOSE_OUT_PROMPT,
	PR_REPLY_SYSTEM_PROMPT,
	PR_REVIEW_CLOSE_OUT_PROMPT,
	PR_REVIEW_CONTINUE_PROMPT,
	PR_REVIEW_SYSTEM_PROMPT,
	SYSTEM_PROMPT,
} from "./prompts"
import { SUBMIT_DIAGNOSIS, SUBMIT_REPLY, SUBMIT_REVIEW } from "./completion"

/**
 * How a row-backed agent's unattended pass ends, and what the runner does when it does not. One
 * record per agent, so the runner holds no per-mode branches.
 */
export interface AgentCompletion {
	/** The tool the pass answers through; the run settles when it lands. */
	readonly tool: string
	/** The close-out run's message: stop reading, file what you have. */
	readonly closeOutPrompt: string
	/** The turn's error when neither the pass nor its close-out filed. */
	readonly noReportMessage: string
	/** The span attribute that records whether the close-out filed. */
	readonly closedOutAttribute: string
	/** What its turns bill as, keyed on the row rather than the session. */
	readonly billingSource: Extract<AiUsageSource, "triage" | "review">
	/** A stuck pass starts over once, and one that answered in prose continues with this prompt. */
	readonly continuePrompt?: string
}

export interface AgentDefinition {
	readonly name: string
	readonly description: string
	readonly prompt: string
	readonly permission: PermissionRuleset
	/**
	 * The narrower ruleset the agent's *unattended* pass runs under, when it has one of its own.
	 * Without it an autonomous turn runs read-only; see `profileForTurn`.
	 */
	readonly autonomousPermission?: PermissionRuleset
	/**
	 * What a turn as this agent may spend. An attended reply and an unattended investigation are
	 * different work; they shared one budget until 2026-09-20, and it was the investigation's.
	 */
	readonly budget: AgentBudget
	/**
	 * Which model the agent runs on: `review` is the organization's pick for pull request work
	 * (`resolveReviewModel`), `triage` the deployment's chat and investigation model.
	 */
	readonly model: AgentModel
	/** Offer `run_code` over the turn's read-only tools, where the runtime has a code executor. */
	readonly codeMode?: boolean
	/** Present on the agents whose session names a row: investigation, review, reply. */
	readonly completion?: AgentCompletion
}

export type AgentModel = "triage" | "review"

/** The modes whose session id names a row that the turn settles. */
export type RowMode = Exclude<ChatMode, "default">

/**
 * Keyed by `ChatMode`, not by `string`: a new mode is then a compile error here rather than an
 * `undefined` discovered mid-turn. A row-backed mode cannot be declared without its completion.
 */
export const AGENTS: {
	readonly default: AgentDefinition
} & { readonly [M in RowMode]: AgentDefinition & { readonly completion: AgentCompletion } } = {
	default: {
		name: "default",
		description: "General Maple assistant.",
		prompt: SYSTEM_PROMPT,
		permission: DEFAULT_RULESET,
		budget: CHAT_BUDGET,
		model: "triage",
	},
	investigate: {
		name: "investigate",
		description: "Runs an autonomous investigation.",
		prompt: INVESTIGATE_SYSTEM_PROMPT,
		// What an attended follow-up in the same session gets. The unattended pass is narrowed
		// further by its origin — see `profileForTurn` in `./profiles`.
		permission: DEFAULT_RULESET,
		budget: INVESTIGATION_BUDGET,
		model: "triage",
		codeMode: true,
		completion: {
			tool: SUBMIT_DIAGNOSIS,
			closeOutPrompt: CLOSE_OUT_PROMPT,
			noReportMessage: "Maple ended this investigation without a diagnosis.",
			closedOutAttribute: "maple.investigation.closed_out",
			billingSource: "triage",
		},
	},
	"pr-review": {
		name: "pr-review",
		description: "Reviews a pull request: correctness, security, performance and observability.",
		prompt: PR_REVIEW_SYSTEM_PROMPT,
		permission: DEFAULT_RULESET,
		// The pass sees the diff, the code, and the read-only telemetry tools its rubric needs, and
		// nothing else: every unoffered schema is prompt it does not pay for on each call.
		autonomousPermission: PR_REVIEW_RULESET,
		budget: PR_REVIEW_BUDGET,
		model: "review",
		codeMode: true,
		completion: {
			tool: SUBMIT_REVIEW,
			closeOutPrompt: PR_REVIEW_CLOSE_OUT_PROMPT,
			noReportMessage: "Maple ended this review without a report.",
			closedOutAttribute: "maple.pr_review.closed_out",
			billingSource: "review",
			continuePrompt: PR_REVIEW_CONTINUE_PROMPT,
		},
	},
	"pr-reply": {
		name: "pr-reply",
		description: "Answers a mention on a pull request, and makes a fix when asked.",
		prompt: PR_REPLY_SYSTEM_PROMPT,
		permission: DEFAULT_RULESET,
		autonomousPermission: PR_REVIEW_RULESET,
		budget: PR_REPLY_BUDGET,
		model: "review",
		completion: {
			tool: SUBMIT_REPLY,
			closeOutPrompt: PR_REPLY_CLOSE_OUT_PROMPT,
			noReportMessage: "Maple ended this answer without posting it.",
			closedOutAttribute: "maple.pr_reply.closed_out",
			billingSource: "review",
		},
	},
}

/** The row a session's turns settle, decoded from the id after its tab prefix. */
export type SessionRow =
	| { readonly kind: "investigate"; readonly id: InvestigationId }
	| { readonly kind: "pr-review"; readonly id: PrReviewId }
	| { readonly kind: "pr-reply"; readonly id: PrReviewReplyId }

const decodeInvestigationId = Schema.decodeUnknownOption(InvestigationId)
const decodePrReviewId = Schema.decodeUnknownOption(PrReviewId)
const decodePrReviewReplyId = Schema.decodeUnknownOption(PrReviewReplyId)

const rowOf = (kind: ChatSessionKind): Option.Option<SessionRow> => {
	switch (kind.mode) {
		case "default":
			return Option.none()
		case "investigate":
			return Option.map(decodeInvestigationId(kind.rawId), (id): SessionRow => ({
				kind: "investigate",
				id,
			}))
		case "pr-review":
			return Option.map(decodePrReviewId(kind.rawId), (id): SessionRow => ({ kind: "pr-review", id }))
		case "pr-reply":
			return Option.map(decodePrReviewReplyId(kind.rawId), (id): SessionRow => ({
				kind: "pr-reply",
				id,
			}))
	}
}

export interface ChatSessionOf {
	readonly agent: AgentDefinition
	/**
	 * Absent for a plain conversation, and for a mode prefix whose id does not decode (`inv-abc`):
	 * that session keeps its mode's agent, but runs and bills as an ordinary conversation.
	 */
	readonly row: SessionRow | undefined
}

/** The one reading of a session id: its agent (the mode string *is* the agent name) and its row. */
export const sessionOf = (sessionId: string): ChatSessionOf => {
	const kind = chatSessionKind(sessionId)
	return { agent: AGENTS[kind.mode], row: Option.getOrUndefined(rowOf(kind)) }
}

export const agentForSession = (sessionId: string): AgentDefinition => sessionOf(sessionId).agent

/**
 * A machine-started pass the runner closes out itself: an investigation's, a review's, a reply's.
 * Both halves are stated: the session names its row, the origin says nobody is attending.
 */
export const isAutonomousTurn = (row: SessionRow | undefined, origin: ChatTurnOrigin): boolean =>
	row !== undefined && origin.kind === "autonomous"

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
export const agentPolicyFor = (
	agent: AgentDefinition,
	contextTokens?: number,
	/** Only an unattended pass gets the run-status line; an attended follow-up must answer, not file. */
	autonomous = false,
): AgentPolicy => {
	const budget = agent.budget
	return AgentPolicy.make({
		maxTurns: budget.maxToolCalls,
		maxToolCalls: budget.maxToolCalls,
		maxDuration: budget.maxDuration,
		tokenBudget: budget.tokenBudget,
		completionReserveTokens: budget.completionReserveTokens,
		toolConcurrency: TOOL_CONCURRENCY,
		repeatedFailureLimit: REPEATED_TOOL_CALLS,
		modelRetries: MODEL_RETRIES,
		// The closing step, as policy: a turn that runs out of turns, or out of tokens, gets one
		// more without tools, to answer from what it found rather than stopping on a wall of tool
		// rows. This is also what makes `tokenBudget` a deadline rather than a way to lose a run.
		onExhaustion: "final-answer",
		...(budget.runStatus === true && autonomous ? { runStatus: "appended" as const } : undefined),
		...(contextTokens === undefined ? undefined : { contextTokenLimit: liveContextLimit(contextTokens) }),
	})
}

/**
 * A chat agent: prose in, prose out.
 *
 * `Output.text` rather than a JSON output schema because the answer *is* the assistant message.
 * `submit_diagnosis` and the other submit tools are ordinary tools here: the engine would require a
 * declared completion tool on every model call, so `run.ts` settles the run when one lands.
 */
export const chatAgent = (
	agent: AgentDefinition,
	toolkit: Toolkit.Any,
	model: ResolvedModel,
	options: {
		/** The turn is a machine-started pass; see {@link agentPolicyFor}. */
		readonly autonomous?: boolean
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
			instructions: agent.prompt,
			description: agent.description,
			toolkit,
			policy: agentPolicyFor(agent, model.limits.context, options.autonomous === true),
		}),
		model.layer,
	)
