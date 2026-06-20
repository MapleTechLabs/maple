import { createAgent, type AgentRouteHandler, type McpServerConnection } from "@flue/runtime"
import { applyApprovalGates } from "../lib/approval.ts"
import type { ChatFlueEnv } from "../lib/env.ts"
import { connectMapleMcp } from "../lib/mcp.ts"
import { buildSystemPrompt, modeFromInstanceId } from "../lib/modes.ts"
import { orgIdFromInstanceId } from "../lib/org.ts"

/**
 * Default Workers AI model. EXPERIMENT: trying Z.ai's `@cf/zai-org/glm-5.2`.
 * `cloudflare/<model-id>` is passed verbatim to `env.AI.run(...)`; an `@cf/*`
 * model is hosted natively on Workers AI — keyless and billed as normal Workers
 * AI usage (neurons + the daily free allocation), no partner/Unified Billing or
 * AI Gateway BYOK.
 *
 * Previous default: `cloudflare/@cf/moonshotai/kimi-k2.6` (validated). The
 * Workers AI catalog churns, so confirm the id against the live catalog if a
 * call 404s. Override per-org via `MAPLE_CHAT_MODEL`.
 */
const DEFAULT_MODEL = "cloudflare/@cf/zai-org/glm-5.2"

/**
 * The addressable Maple chat agent on Cloudflare Workers AI, with tools sourced
 * live from Maple's MCP server (`apps/api` `/mcp`). Mode (default / alert /
 * widget-fix / dashboard-builder) is derived from the instance id.
 *
 * Addressed from the browser as
 *   client.agents.send("maple-chat", "<orgId>:<tabId>", { message })
 *
 * Still open: propose-then-apply approval wrapping for mutating tools (Phase 1b),
 * the context-payload delivery channel (Phase 2), and a full OTel bridge.
 */

/**
 * Exposes the agent over HTTP: `POST /agents/maple-chat/:id` (prompt) and
 * `GET /agents/maple-chat/:id` (event stream) — the surface the `@flue/sdk`
 * browser client talks to. Without this export the agent is reachable only via
 * `dispatch()`.
 *
 * AuthN + per-instance authZ run as Hono middleware on `/agents/*` in `app.ts`
 * (verify the caller's token + match its org to this instance id), so this
 * per-agent handler stays a pass-through.
 */
export const route: AgentRouteHandler = async (_c, next) => next()

export default createAgent<unknown, ChatFlueEnv>(async (ctx) => {
	const orgId = orgIdFromInstanceId(ctx.id)

	// Mode is derived from the instance id's tab-id prefix (alert- / widget-fix- /
	// dashboard-builder-). The rich per-conversation context payloads
	// (alertContext, widgetFixContext, pageContext) are supplied by the web client
	// — wiring that delivery channel (custom app.ts route vs. message preamble) is
	// the Phase 2 frontend integration point; until then the base prompt for the
	// mode is used.
	const mode = modeFromInstanceId(ctx.id)
	const instructions = buildSystemPrompt({ mode })

	// Connect to Maple's MCP server (all tools). We tolerate connection failures so
	// the agent still answers on Workers AI when apps/api or INTERNAL_SERVICE_TOKEN
	// isn't wired yet. The initializer runs per interaction and we don't `close()`
	// here because tool calls need the connection live for the whole turn —
	// connection lifecycle/pooling is a follow-up.
	let tools: McpServerConnection["tools"] = []
	if (orgId) {
		try {
			const maple = await connectMapleMcp(ctx.env, orgId)
			// Propose-then-apply: mutating tools return a proposal the UI approves
			// (Flue has no native human-in-the-loop interrupt).
			tools = applyApprovalGates(maple.tools)
		} catch (error) {
			console.error(
				"[chat-flue] MCP connect failed; continuing without Maple tools:",
				error instanceof Error ? error.message : error,
			)
		}
	}

	return {
		model: ctx.env.MAPLE_CHAT_MODEL ?? DEFAULT_MODEL,
		instructions,
		tools,
	}
})
