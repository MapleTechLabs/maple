import type { AiToolDescriptor } from "@maple/domain/ai-service"
import type { AgentDefinition } from "../runtime/agent"
import { defaultRuleset } from "@maple/domain/ai-permissions"
import { PermissionRule } from "@maple/domain/permission"
import { hypothesisRuleset } from "@maple/domain/ai-hypothesis-catalogue"
import { PLANNER_MAX_STEPS, PLANNER_SYSTEM_PROMPT, PLANNER_TOOL_NAMES } from "./planner-prompt"
import { INVESTIGATE_SYSTEM_PROMPT, VALIDATOR_SYSTEM_PROMPT } from "./prompts"

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
 * Built per run from the planner’s hypothesis, which is the visible
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

/**
 * Ranks the lens candidates. Denied every tool on purpose: it adjudicates text
 * the lenses already gathered, and giving it instruments would make it a sixth
 * lens with a casting vote — the thing the fan-out exists to avoid.
 */
export const validatorAgent: AgentDefinition = {
	name: "investigation-validator",
	description: "Ranks investigation hypothesis candidates and promotes at most one.",
	mode: "subagent",
	prompt: VALIDATOR_SYSTEM_PROMPT,
	permission: [new PermissionRule({ tool: "*", action: "deny" })],
	steps: 1,
}

/** The report-producing conversation, also used for follow-ups to a workflow report. */
export const investigationAgent = (tools: ReadonlyArray<AiToolDescriptor>): AgentDefinition => ({
	name: "investigate",
	description: "Runs an investigation and answers follow-up questions.",
	mode: "primary",
	prompt: INVESTIGATE_SYSTEM_PROMPT,
	permission: defaultRuleset(tools),
})

import { buildHypothesisSystemPrompt } from "./hypothesis-prompt"
