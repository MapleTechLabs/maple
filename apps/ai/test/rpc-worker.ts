/** Runs the real service and provider parser against an in-memory model, inside workerd. */
import { WorkerEntrypoint } from "cloudflare:workers"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { makeAiService } from "../src/service"

const EVIDENCE = [
	{
		traceIds: ["trace-1"],
		logPatterns: ["waiting for connection"],
		relatedServices: ["api"],
		note: "Connection pool was full",
	},
]
const REPORT = {
	summary: "The pool is exhausted",
	suspectedCause: "Pool capacity",
	affectedScope: "api",
	evidence: EVIDENCE,
	suggestedActions: ["Inspect pool"],
	confidence: "high",
}
const CANDIDATE = {
	claim: "Pool exhausted",
	mechanism: "Requests queue for a connection",
	confidence: "high",
	evidence: EVIDENCE,
	selfDoubt: "Could be slow queries",
	suggestedActions: [],
}
const PLAN = {
	scopeSummary: "Check the deploy",
	incidentStartedAt: null,
	incidentEndedAt: null,
	hypotheses: [],
	collapseReason: null,
}
const frame = (choices: unknown[], usage?: unknown) =>
	`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test", choices, ...(usage ? { usage } : undefined) })}\n\n`
const service = makeAiService({ MAPLE_LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: "fixture" })
const fakeFetch: typeof fetch = async (_url, init) => {
	const input = (await new Response(init?.body).json()) as {
		tools?: Array<{ function: { name: string } }>
		messages: Array<{ role: string }>
	}
	const planned = input.tools?.some((tool) => tool.function.name === "submit_plan")
	const validated = input.tools?.some((tool) => tool.function.name === "submit_verdict")
	const candidate = input.tools?.some((tool) => tool.function.name === "submit_candidate")
	const diagnosis = input.tools?.some((tool) => tool.function.name === "submit_diagnosis")
	const hasToolResult = input.messages.some((message) => message.role === "tool")
	const name = planned
		? "submit_plan"
		: validated
			? "submit_verdict"
			: candidate
				? "submit_candidate"
				: diagnosis
					? "submit_diagnosis"
					: hasToolResult
						? undefined
						: "list_services"
	const args = planned
		? PLAN
		: validated
			? { promotedLensId: null, report: null, rivals: [], note: "No supported finding" }
			: candidate
				? CANDIDATE
				: diagnosis
					? REPORT
					: {}
	const delta =
		name === undefined
			? { content: "The service is healthy." }
			: {
					tool_calls: [
						{
							index: 0,
							id: "call-1",
							type: "function",
							function: { name, arguments: JSON.stringify(args) },
						},
					],
				}
	const body =
		frame([{ index: 0, delta, finish_reason: null }]) +
		frame([{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }], {
			prompt_tokens: 10,
			completion_tokens: 5,
			total_tokens: 15,
		}) +
		"data: [DONE]\n\n"
	return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
}

export default class AiTestWorker extends WorkerEntrypoint {
	chat(...args: Parameters<typeof service.chat>) {
		return Effect.runPromise(
			service.chat(...args).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch)),
		)
	}
	plan(...args: Parameters<typeof service.plan>) {
		return Effect.runPromise(
			service.plan(...args).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch)),
		)
	}
	hypothesis(...args: Parameters<typeof service.hypothesis>) {
		return Effect.runPromise(
			service.hypothesis(...args).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch)),
		)
	}
	validate(...args: Parameters<typeof service.validate>) {
		return Effect.runPromise(
			service.validate(...args).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch)),
		)
	}
}
