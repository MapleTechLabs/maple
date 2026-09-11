import type { AiToolDescriptor } from "@maple/domain/ai-service"
import type { AgentDefinition } from "../runtime/agent"
import { defaultRuleset, readOnlyRuleset } from "@maple/domain/ai-permissions"
import { EXPLORE_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./prompts"

/** Read-only research available to conversations; it cannot delegate or request approval. */
export const exploreAgent = (tools: ReadonlyArray<AiToolDescriptor>): AgentDefinition => ({
	name: "explore",
	description:
		"Read-only investigator. Give it a self-contained question about traces, logs, metrics " +
		"or errors and it returns a written answer. It cannot change anything and cannot spawn " +
		"further agents. Use it to search broadly without filling this conversation with raw " +
		"tool output.",
	mode: "subagent",
	prompt: EXPLORE_SYSTEM_PROMPT,
	permission: readOnlyRuleset(tools),
})

/** Tasks supply context in the user message; they share one assistant and permission policy. */
export type AssistantTask = "question" | "alert" | "widget-fix"

const taskPolicy = {
	question: { delegate: true },
	alert: { delegate: false },
	"widget-fix": { delegate: false },
} satisfies Record<AssistantTask, { readonly delegate: boolean }>

const assistant = (tools: ReadonlyArray<AiToolDescriptor>): AgentDefinition => ({
	name: "assistant",
	description: "General Maple assistant.",
	mode: "primary",
	prompt: SYSTEM_PROMPT,
	permission: defaultRuleset(tools),
})

export const assistantForTask = (
	task: AssistantTask,
	tools: ReadonlyArray<AiToolDescriptor>,
): AgentDefinition => ({
	...assistant(tools),
	...(taskPolicy[task].delegate ? { spawns: [exploreAgent(tools)] } : undefined),
})
