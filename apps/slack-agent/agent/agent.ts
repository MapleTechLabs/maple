import { defineAgent } from "eve"
import { agentModel, contextWindowTokens } from "#lib/agent-model.js"

/**
 * Make sure no envs are missing on startup.
 */
const missingModelEnv = ["OPENROUTER_API_KEY"].filter((name) => !process.env[name])
const isEveBuildInvocation = process.argv.includes("build")
if (missingModelEnv.length > 0 && !isEveBuildInvocation) {
	console.warn(
		`[startup] ${missingModelEnv.join(" and ")} ${missingModelEnv.length === 1 ? "is" : "are"} not set. ` +
			`The service will start, but every OpenRouter model call will fail until ${missingModelEnv.length === 1 ? "it is" : "they are"} configured.`,
	)
}

/**
 * Durable workflow state ("world").
 */
const workflowWorld = process.env.EVE_WORKFLOW_WORLD

export default defineAgent({
	model: agentModel,
	modelContextWindowTokens: contextWindowTokens,
	...(workflowWorld ? { experimental: { workflow: { world: workflowWorld } } } : undefined),
})
