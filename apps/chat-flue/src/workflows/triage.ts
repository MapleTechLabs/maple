import { createAgent, type FlueContext, type WorkflowRouteHandler } from "@flue/runtime"
import type { ChatFlueEnv } from "../lib/env.ts"
import { connectMapleMcp } from "../lib/mcp.ts"
import { buildTriageContextMessage, TRIAGE_SYSTEM_PROMPT, TRIAGE_TOOL_NAMES } from "../lib/triage-prompt.ts"
import { AiTriageResultSchema } from "../lib/triage-result.ts"

/**
 * Headless AI-triage as a Flue workflow — the agentic-investigation half of the
 * legacy apps/api `AiTriageWorkflow`. It runs the read-only investigation loop on
 * Workers AI against Maple's MCP tools and returns a structured `AiTriageResult`.
 *
 * Boundary: this workflow owns ONLY the LLM step. The durable incident lifecycle
 * — gate/claim, D1 `ai_triage_runs` persistence, issue severity + timeline,
 * Autumn token tracking — stays in apps/api's AiTriageService, which invokes this
 * workflow (`@flue/sdk` `workflows.invoke("triage", { payload, wait: "result" })`)
 * for the investigation and persists the returned result. This keeps @maple/db,
 * severity logic, and billing out of the worker bundle.
 *
 * Flue's `{ result }` mechanism replaces the legacy `submit_triage` tool: the
 * model's final structured output is validated against `AiTriageResultSchema`.
 */

const DEFAULT_TRIAGE_MODEL = "cloudflare/@cf/moonshotai/kimi-k2.6"

export interface TriagePayload {
	readonly orgId: string
	readonly incidentKind: "error" | "anomaly" | "alert"
	readonly incidentId: string
	/** Incident context blob written at enqueue time (formatted, never re-queried). */
	readonly context: Record<string, unknown>
}

/** Exposes the workflow at `POST /workflows/triage`. apps/api gates access upstream. */
export const route: WorkflowRouteHandler = async (_c, next) => next()

const triageAgent = createAgent<TriagePayload, ChatFlueEnv>((ctx) => ({
	model: ctx.env.MAPLE_TRIAGE_MODEL ?? ctx.env.MAPLE_CHAT_MODEL ?? DEFAULT_TRIAGE_MODEL,
	instructions: TRIAGE_SYSTEM_PROMPT,
}))

export async function run({ init, payload, env }: FlueContext<TriagePayload, ChatFlueEnv>) {
	// Read-only investigation subset of Maple's MCP tools.
	const maple = await connectMapleMcp(env, payload.orgId, { allowlist: TRIAGE_TOOL_NAMES })
	try {
		const harness = await init(triageAgent, { tools: maple.tools })
		const session = await harness.session()
		const { data, usage, model } = await session.prompt(
			buildTriageContextMessage(payload.incidentKind, payload.context),
			{ result: AiTriageResultSchema },
		)
		return { result: data, model, usage }
	} finally {
		await maple.close()
	}
}
