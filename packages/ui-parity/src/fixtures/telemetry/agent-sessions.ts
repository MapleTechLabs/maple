import { makePrng, type Prng } from "../prng.ts"
import { emptyTelemetry, formatMicros, type TelemetryRows, type WarehouseRow } from "./rows.ts"

/**
 * Agent sessions as the ingest gateway leaves them: canonical `gen_ai.*` content plus the
 * `maple_ai.*` stamps `ai_trace_index_mv` projects. One trace per turn, spread over the week.
 */

const MINUTE_US = 60_000_000
const HOUR_US = 60 * MINUTE_US

interface ToolStep {
	readonly name: string
	readonly args: Readonly<Record<string, unknown>>
	readonly result: string
	readonly ms: number
	readonly error?: string
}

interface TurnPlan {
	readonly prompt: string
	readonly answer: string
	readonly model: string
	readonly tools: ReadonlyArray<ToolStep>
	/** The model call fails (e.g. a context-window error) and the turn ends there. */
	readonly llmError?: { readonly type: string; readonly message: string }
}

interface SessionPlan {
	readonly sessionId: string
	readonly vendor: string
	readonly vendorVersion: string
	readonly service: string
	readonly env: string
	readonly agent: string
	readonly hoursAgo: number
	readonly turns: ReadonlyArray<TurnPlan>
}

const TOOL_DESCRIPTIONS = new Map(Object.entries({
	Read: "Reads a file from the local filesystem.",
	Grep: "Searches file contents with a regular expression.",
	Edit: "Performs exact string replacements in a file.",
	Bash: "Executes a shell command in the workspace.",
	lookup_order: "Fetches an order and its shipment status by id.",
	refund_order: "Issues a full or partial refund for an order.",
	search_kb: "Searches the help-center knowledge base.",
	get_invoice: "Loads an invoice with its line items.",
	apply_credit: "Applies an account credit to the next invoice.",
	web_search: "Searches the web and returns the top results.",
	fetch_url: "Downloads a page and returns its readable text.",
} satisfies Record<string, string>))

const read = (path: string, ms = 40): ToolStep => ({ name: "Read", args: { file_path: path }, result: `(${path}: 182 lines)`, ms })
const grep = (pattern: string, ms = 120): ToolStep => ({ name: "Grep", args: { pattern, path: "apps/checkout" }, result: "3 matches in 2 files", ms })
const edit = (path: string): ToolStep => ({ name: "Edit", args: { file_path: path, old_string: "retries: 3", new_string: "retries: 5" }, result: "File updated", ms: 30 })
const bash = (command: string, ms: number, error?: string): ToolStep => ({
	name: "Bash",
	args: { command },
	result: error ?? "Tests: 48 passed, 48 total",
	ms,
	...(error === undefined ? undefined : { error }),
})
const tool = (name: string, args: Readonly<Record<string, unknown>>, result: string, ms: number, error?: string): ToolStep => ({
	name,
	args,
	result,
	ms,
	...(error === undefined ? undefined : { error }),
})

const SESSIONS: ReadonlyArray<SessionPlan> = [
	{
		sessionId: "5f1c2a90-3b7e-4c1d-9a2f-7e0d4b6c8a11",
		vendor: "claude_code",
		vendorVersion: "2.1.4",
		service: "claude-code",
		env: "development",
		agent: "claude-code",
		hoursAgo: 2,
		turns: [
			{
				prompt: "the checkout retry test is flaky on CI, find out why",
				answer: "The retry test races the payment mock: the mock resolves before the retry timer is armed.",
				model: "claude-opus-4-1",
				tools: [grep("retryPayment"), read("apps/checkout/src/retry.ts"), read("apps/checkout/test/retry.test.ts"), bash("bun run test retry", 8400, "1 failed: expected 2 attempts, received 1")],
			},
			{
				prompt: "fix it and run the suite again",
				answer: "Armed the timer before resolving the mock and raised the retry budget. The suite passes.",
				model: "claude-opus-4-1",
				tools: [edit("apps/checkout/src/retry.ts"), bash("bun run test retry", 7900)],
			},
			{
				prompt: "summarize the change for the PR description",
				answer: "Retry timer is now armed before the first attempt resolves, so the second attempt is always observed.",
				model: "claude-haiku-4-5",
				tools: [],
			},
		],
	},
	{
		sessionId: "conv_8d2e41b7a6",
		vendor: "effect_ai",
		vendorVersion: "4.0.0",
		service: "support-agent",
		env: "production",
		agent: "support-triage",
		hoursAgo: 5,
		turns: [
			{
				prompt: "My order #48213 never arrived, can I get a refund?",
				answer: "Your order shows as lost in transit, so I issued a full refund of $84.00.",
				model: "gpt-5-mini",
				tools: [
					tool("lookup_order", { orderId: "48213" }, '{"status":"lost_in_transit","total":84}', 210),
					tool("refund_order", { orderId: "48213", amount: 84 }, '{"refundId":"re_31f9","status":"succeeded"}', 640),
				],
			},
			{
				prompt: "Thanks! How long until it shows on my card?",
				answer: "Refunds usually appear within 5 to 10 business days.",
				model: "gpt-5-mini",
				tools: [tool("search_kb", { query: "refund timing card" }, "Refunds post in 5-10 business days.", 180)],
			},
		],
	},
	{
		sessionId: "conv_19ac03f5e2",
		vendor: "effect_ai",
		vendorVersion: "4.0.0",
		service: "support-agent",
		env: "production",
		agent: "support-triage",
		hoursAgo: 19,
		turns: [
			{
				prompt: "Where is order 47790?",
				answer: "Order 47790 is out for delivery and should arrive today.",
				model: "gpt-5-mini",
				tools: [tool("lookup_order", { orderId: "47790" }, '{"status":"out_for_delivery"}', 190)],
			},
		],
	},
	{
		sessionId: "conv_6b7f90d4c1",
		vendor: "effect_ai",
		vendorVersion: "4.0.0",
		service: "support-agent",
		env: "production",
		agent: "support-triage",
		hoursAgo: 30,
		turns: [
			{
				prompt: "Refund my last order, it arrived damaged",
				answer: "I could not issue the refund automatically, so I escalated it to a human agent.",
				model: "gpt-5-mini",
				tools: [
					tool("lookup_order", { orderId: "47102" }, '{"status":"delivered","total":129}', 230),
					tool("refund_order", { orderId: "47102", amount: 129 }, "", 1250, "PaymentProviderError: card_declined for refund re_9c20"),
				],
			},
		],
	},
	{
		sessionId: "thread_billing_7731",
		vendor: "spring_ai",
		vendorVersion: "1.1.0",
		service: "billing-assistant",
		env: "production",
		agent: "billing-agent",
		hoursAgo: 46,
		turns: [
			{
				prompt: "Why was I charged twice in September?",
				answer: "Invoice INV-2209 was retried after a timeout and charged twice. I applied a $49 credit.",
				model: "gpt-4.1",
				tools: [
					tool("get_invoice", { invoiceId: "INV-2209" }, '{"charges":2,"amount":49}', 320),
					tool("apply_credit", { amount: 49, reason: "duplicate charge" }, '{"creditId":"cr_77a1"}', 410),
				],
			},
		],
	},
	{
		sessionId: "research-2b4d9e",
		vendor: "litellm",
		vendorVersion: "1.77.2",
		service: "research-bot",
		env: "staging",
		agent: "researcher",
		hoursAgo: 70,
		turns: [
			{
				prompt: "Compare the p99 latency claims of the three biggest CDN vendors",
				answer: "Collected the published p99 figures from all three vendors; methodology differs per vendor.",
				model: "gemini-2.5-pro",
				tools: [
					tool("web_search", { query: "CDN p99 latency benchmark 2026" }, "10 results", 900),
					tool("fetch_url", { url: "https://example.test/cdn-report" }, "CDN report, 14 pages", 1600),
					tool("fetch_url", { url: "https://example.test/edge-latency" }, "", 30000, "TimeoutError: fetch exceeded 30s"),
				],
			},
			{
				prompt: "Add the raw tables from every report to the answer",
				answer: "",
				model: "gemini-2.5-pro",
				tools: [],
				llmError: { type: "ContextWindowExceededError", message: "prompt is 1,204,331 tokens; the model accepts 1,048,576" },
			},
		],
	},
	{
		sessionId: "a8e3f7d2-61b0-4f5a-8c9e-2d4b7a1f0c35",
		vendor: "claude_code",
		vendorVersion: "2.1.2",
		service: "claude-code",
		env: "development",
		agent: "claude-code",
		hoursAgo: 96,
		turns: [
			{
				prompt: "add a dark mode toggle to the storefront header",
				answer: "Added a theme toggle to the header that persists the choice in localStorage.",
				model: "claude-sonnet-4-5",
				tools: [read("apps/storefront/src/header.tsx"), edit("apps/storefront/src/header.tsx"), bash("bun run typecheck", 5200)],
			},
		],
	},
	{
		sessionId: "conv_0f4e88a2b9",
		vendor: "effect_ai",
		vendorVersion: "4.0.0",
		service: "support-agent",
		env: "production",
		agent: "support-triage",
		hoursAgo: 130,
		turns: [
			{
				prompt: "Do you ship to Canada?",
				answer: "Yes, we ship to Canada with delivery in 4 to 7 business days.",
				model: "gpt-5-mini",
				tools: [tool("search_kb", { query: "international shipping canada" }, "Canada: 4-7 business days.", 150)],
			},
		],
	},
]

/** USD per million input / output tokens, roughly list price. */
const PRICES = new Map(Object.entries({
	"claude-opus-4-1": [15, 75],
	"claude-sonnet-4-5": [3, 15],
	"claude-haiku-4-5": [1, 5],
	"gpt-5-mini": [0.25, 2],
	"gpt-4.1": [2, 8],
	"gemini-2.5-pro": [1.25, 10],
} satisfies Record<string, readonly [number, number]>))

const PROVIDERS = new Map(Object.entries({
	"claude-opus-4-1": "anthropic",
	"claude-sonnet-4-5": "anthropic",
	"claude-haiku-4-5": "anthropic",
	"gpt-5-mini": "openai",
	"gpt-4.1": "openai",
	"gemini-2.5-pro": "gcp.gemini",
} satisfies Record<string, string>))

interface Sink {
	readonly orgId: string
	readonly rng: Prng
	readonly traces: Array<WarehouseRow>
}

interface SpanInput {
	readonly session: SessionPlan
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string
	readonly name: string
	readonly kind: "Internal" | "Client"
	readonly startUs: number
	readonly durationUs: number
	readonly error?: { readonly type: string; readonly message: string }
	readonly attributes: Readonly<Record<string, string>>
}

const pushSpan = (sink: Sink, span: SpanInput) =>
	sink.traces.push({
		OrgId: sink.orgId,
		Timestamp: formatMicros(span.startUs),
		TraceId: span.traceId,
		SpanId: span.spanId,
		ParentSpanId: span.parentSpanId,
		TraceState: "",
		SpanName: span.name,
		SpanKind: span.kind,
		ServiceName: span.session.service,
		ResourceSchemaUrl: "",
		ResourceAttributes: {
			"service.name": span.session.service,
			"deployment.environment.name": span.session.env,
			"telemetry.sdk.language": span.session.vendor === "spring_ai" ? "java" : "nodejs",
		},
		ScopeSchemaUrl: "",
		ScopeName: span.session.vendor,
		ScopeVersion: span.session.vendorVersion,
		ScopeAttributes: {},
		Duration: Math.round(span.durationUs * 1000),
		StatusCode: span.error === undefined ? "Unset" : "Error",
		StatusMessage: span.error?.message ?? "",
		SpanAttributes: {
			"maple_ai.vendor.id": span.session.vendor,
			"maple_ai.vendor.version": span.session.vendorVersion,
			"maple_ai.session.id": span.session.sessionId,
			"maple_ai.agent.name": span.session.agent,
			"gen_ai.conversation.id": span.session.sessionId,
			...span.attributes,
			...(span.error === undefined ? undefined : { "maple_ai.error": "1", "error.type": span.error.type }),
		},
		EventsTimestamp: [],
		EventsName: [],
		EventsAttributes: [],
		LinksTraceId: [],
		LinksSpanId: [],
		LinksTraceState: [],
		LinksAttributes: [],
	})

const text = (role: string, content: string) => ({ role, parts: [{ type: "text", content }] })

/** One turn: an agent root, a model call, its tools, then the closing model call. */
const emitTurn = (sink: Sink, session: SessionPlan, turn: TurnPlan, index: number, startUs: number): number => {
	const { rng } = sink
	const traceId = rng.hex(32)
	const rootId = rng.hex(16)
	const [inPrice, outPrice] = PRICES.get(turn.model) ?? [1, 1]
	const history = session.turns.slice(0, index).flatMap((earlier) => [text("user", earlier.prompt), text("assistant", earlier.answer)])
	const llm = (startAt: number, final: boolean): number => {
		const durationUs = rng.int(900, 4200) * 1000
		const input = rng.int(1200, 9000)
		const cacheRead = index === 0 ? 0 : rng.int(4000, 20000)
		const output = final ? rng.int(120, 600) : rng.int(40, 160)
		const cost = (input * inPrice + output * outPrice + cacheRead * inPrice * 0.1) / 1_000_000
		const calls = final ? [] : turn.tools.map((step, call) => ({ type: "tool_call", id: `call_${index}_${call}`, name: step.name, arguments: step.args }))
		const failed = final && turn.llmError !== undefined
		pushSpan(sink, {
			session,
			traceId,
			spanId: rng.hex(16),
			parentSpanId: rootId,
			name: `chat ${turn.model}`,
			kind: "Client",
			startUs: startAt,
			durationUs,
			...(failed && turn.llmError !== undefined ? { error: turn.llmError } : undefined),
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.provider.name": PROVIDERS.get(turn.model) ?? "openai",
				"gen_ai.request.model": turn.model,
				"gen_ai.response.model": turn.model,
				"gen_ai.input.messages": JSON.stringify([text("system", `You are ${session.agent}.`), ...history, text("user", turn.prompt)]),
				...(failed
					? undefined
					: {
							"gen_ai.output.messages": JSON.stringify([
								{ role: "assistant", parts: final ? [{ type: "text", content: turn.answer }] : calls, finish_reason: final ? "stop" : "tool_calls" },
							]),
							"gen_ai.response.finish_reasons": JSON.stringify([final ? "stop" : "tool_calls"]),
							"maple_ai.usage.input_tokens": String(input),
							"maple_ai.usage.cache_read_tokens": String(cacheRead),
							"maple_ai.usage.output_tokens": String(output),
							"maple_ai.usage.cost": cost.toFixed(6),
							"gen_ai.usage.input_tokens": String(input),
							"gen_ai.usage.cache_read.input_tokens": String(cacheRead),
							"gen_ai.usage.output_tokens": String(output),
						}),
				"maple_ai.llm_call": "1",
				"maple_ai.model": turn.model,
				"maple_ai.response.id": `resp_${traceId.slice(0, 12)}_${final ? "f" : "t"}`,
			},
		})
		return startAt + durationUs
	}
	const firstEnd = turn.tools.length === 0 ? startUs + 1000 : llm(startUs + 2000, false)
	const toolsEnd = turn.tools.reduce((cursor, step, call) => {
		const at = cursor + rng.int(5, 60) * 1000
		const durationUs = step.ms * 1000
		pushSpan(sink, {
			session,
			traceId,
			spanId: rng.hex(16),
			parentSpanId: rootId,
			name: `execute_tool ${step.name}`,
			kind: "Internal",
			startUs: at,
			durationUs,
			...(step.error === undefined ? undefined : { error: { type: step.error.split(":")[0] ?? "ToolError", message: step.error } }),
			attributes: {
				"gen_ai.operation.name": "execute_tool",
				"gen_ai.tool.name": step.name,
				"gen_ai.tool.call.id": `call_${index}_${call}`,
				"gen_ai.tool.type": "function",
				"gen_ai.tool.description": TOOL_DESCRIPTIONS.get(step.name) ?? "",
				"gen_ai.tool.call.arguments": JSON.stringify(step.args),
				"gen_ai.tool.call.result": JSON.stringify(step.error ?? step.result),
				"maple_ai.llm_call": "0",
				"maple_ai.tool_call": "1",
				"maple_ai.tool.name": step.name,
				"maple_ai.tool.description": TOOL_DESCRIPTIONS.get(step.name) ?? "",
				...(step.error === undefined ? undefined : { "maple_ai.tool.error_result": step.error }),
			},
		})
		return at + durationUs
	}, firstEnd)
	const endUs = llm(toolsEnd + 3000, true) + 2000
	pushSpan(sink, {
		session,
		traceId,
		spanId: rootId,
		parentSpanId: "",
		name: `invoke_agent ${session.agent}`,
		kind: "Internal",
		startUs,
		durationUs: endUs - startUs,
		...(turn.llmError === undefined ? undefined : { error: turn.llmError }),
		attributes: {
			"gen_ai.operation.name": "invoke_agent",
			"gen_ai.agent.name": session.agent,
			"maple_ai.llm_call": "0",
		},
	})
	return endUs
}

/** Every session, ending `hoursAgo` before `now`, its turns a few minutes apart. */
export const agentSessionsTelemetry = (options: { readonly orgId: string; readonly now: Date }): TelemetryRows => {
	const sink: Sink = { orgId: options.orgId, rng: makePrng(41), traces: [] }
	const nowUs = options.now.getTime() * 1000
	SESSIONS.forEach((session) => {
		session.turns.reduce(
			(cursor, turn, index) => emitTurn(sink, session, turn, index, cursor) + sink.rng.int(40, 240) * 1_000_000,
			nowUs - session.hoursAgo * HOUR_US,
		)
	})
	return { ...emptyTelemetry, traces: sink.traces }
}

/** For scenarios: the newest session, and a tool every session page links to. */
export const NEWEST_AGENT_SESSION_ID = SESSIONS[0]?.sessionId ?? ""
