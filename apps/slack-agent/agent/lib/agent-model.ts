import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { defineDynamic } from "eve"

/**
 * OpenRouter over its REST API.
 *
 * `appUrl`/`appName` set `HTTP-Referer`/`X-OpenRouter-Title`, which is what attributes this
 * traffic to Maple's app page on openrouter.ai. Same URL and title as `apps/api` on purpose: the
 * referer is the app's identity, so a different one here would mint a second app entry and split
 * the rankings. Surfaces are told apart by `trace.trace_name` instead — static, because this
 * process only ever is the Slack agent.
 */
const openrouter = createOpenRouter({
	apiKey: process.env.OPENROUTER_API_KEY ?? "",
	appUrl: "https://maple.dev",
	appName: "Maple",
	extraBody: { trace: { trace_name: "slack" } },
})

/**
 * Must support tool calling **while streaming** — eve's harness is tool-driven and
 * always streams.
 */
const modelId = process.env.OPENROUTER_MODEL ?? "z-ai/glm-5.3-flash:nitro"
/**
 * Validated, because eve rejects a selection whose context window is not a positive integer and
 * then falls back to the session-less model for every step — a misconfigured value would silently
 * turn session tagging off rather than fail.
 */
const configuredContextWindow = Number(process.env.OPENROUTER_CONTEXT_WINDOW)
export const contextWindowTokens =
	Number.isInteger(configuredContextWindow) && configuredContextWindow > 0
		? configuredContextWindow
		: 1_000_000

/**
 * `usage.include` turns on OpenRouter usage accounting: every response then carries the actual
 * amount charged (`usage.cost`, in USD credits), which the telemetry pipeline lifts into
 * `gen_ai.usage.cost` (see `lib/genai-cost.ts`). Without it OpenRouter omits cost and per-session
 * spend in Maple would have to be inferred from token prices.
 *
 * `session_id` is eve's session id — the `eve.session.id` Maple files this agent's own spans
 * under. OpenRouter's Broadcast mirror of each call carries it as `session.id`, so the mirror
 * lands in the same agent session instead of one session per call. OpenRouter caps it at 256.
 */
const model = (sessionId?: string) =>
	openrouter(modelId, {
		usage: { include: true },
		...(sessionId ? { extraBody: { session_id: sessionId.slice(0, 256) } } : undefined),
	})

/**
 * The agent's model, re-selected per step so the request can carry the session it runs in — the
 * static model is built once at startup, before any session exists.
 *
 * `step.started` because it is the only scope eve lets return a provider object; a selection does
 * not inherit the fallback's context window, so it is restated.
 */
export const agentModel = defineDynamic({
	fallback: model(),
	events: {
		"step.started": (_event, ctx) => ({
			model: model(ctx.session.id),
			modelContextWindowTokens: contextWindowTokens,
		}),
	},
})
