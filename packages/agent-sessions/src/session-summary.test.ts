import { describe, expect, it } from "vitest"

import { agentSpan, llmSpan, makeSpan, toolSpan } from "./span-test-support"
import { buildSessionTurns } from "./session-turns"
import { buildSessionSummary, countTurnTokens, findIdleGaps, type AgentTimeKind } from "./session-summary"
import { Array as Arr, Option, String as Str } from "effect"

const SECOND = 1000
const MINUTE = 60 * SECOND

const summarize = (spans: Parameters<typeof buildSessionTurns>[0]) =>
	buildSessionSummary({ spans, turns: buildSessionTurns(spans) })

const segment = (
	segments: readonly { readonly kind: AgentTimeKind; readonly ms: number }[],
	kind: AgentTimeKind,
) =>
	Option.getOrUndefined(
		Option.map(
			Arr.findFirst(segments, (entry) => entry.kind === kind),
			(entry) => entry.ms,
		),
	)

describe("findIdleGaps", () => {
	it("finds the stretches where nothing was running", () => {
		const gaps = findIdleGaps([
			llmSpan({ spanId: "a", startMs: 0, durationMs: 10 * SECOND }),
			llmSpan({ spanId: "b", startMs: 70 * SECOND, durationMs: 5 * SECOND }),
		])

		expect(gaps).toHaveLength(1)
		expect(Arr.getUnsafe(gaps, 0).durationMs).toBe(60 * SECOND)
	})

	it("ignores a hole too short to be a human", () => {
		const gaps = findIdleGaps([
			llmSpan({ spanId: "a", startMs: 0, durationMs: 10 * SECOND }),
			llmSpan({ spanId: "b", startMs: 12 * SECOND, durationMs: SECOND }),
		])

		expect(gaps).toEqual([])
	})

	it("sees no gap under a span that covers it", () => {
		const gaps = findIdleGaps([
			// The agent span stays open across the whole turn.
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 90 * SECOND }),
			llmSpan({ spanId: "a", parentSpanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
			llmSpan({ spanId: "b", parentSpanId: "agent", startMs: 70 * SECOND, durationMs: 5 * SECOND }),
		])

		expect(gaps).toEqual([])
	})
})

describe("buildSessionSummary — time", () => {
	it("reports the wall clock, and active time as the wall clock less idle", () => {
		const summary = summarize([
			llmSpan({ spanId: "a", startMs: 0, durationMs: 10 * SECOND }),
			llmSpan({ spanId: "b", startMs: 70 * SECOND, durationMs: 10 * SECOND }),
		])

		expect(summary.wallClockMs).toBe(80 * SECOND)
		expect(summary.idleMs).toBe(60 * SECOND)
		expect(summary.activeMs).toBe(20 * SECOND)
	})

	it("sums agent time, so parallel tools exceed the wall clock", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
			// Four tools, ten seconds each, all at once: 40s of agent time inside a
			// 10s session.
			toolSpan({ spanId: "t1", parentSpanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
			toolSpan({ spanId: "t2", parentSpanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
			toolSpan({ spanId: "t3", parentSpanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
			toolSpan({ spanId: "t4", parentSpanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
		])

		expect(segment(summary.agentTime.segments, "tool")).toBe(40 * SECOND)
		expect(summary.agentTime.totalMs).toBe(40 * SECOND)
		expect(summary.wallClockMs).toBe(10 * SECOND)
	})

	it("charges overlapping inference and tool time to both, in full", () => {
		const summary = summarize([
			llmSpan({ spanId: "llm", startMs: 0, durationMs: 10 * SECOND }),
			// A tool that ran while the model was still streaming.
			toolSpan({ spanId: "tool", startMs: 5 * SECOND, durationMs: 10 * SECOND }),
		])

		expect(segment(summary.agentTime.segments, "inference")).toBe(10 * SECOND)
		expect(segment(summary.agentTime.segments, "tool")).toBe(10 * SECOND)
	})

	it("splits a streaming call into time to first token and the rest", () => {
		const summary = summarize([
			llmSpan({ spanId: "llm", startMs: 0, durationMs: 10 * SECOND, ttftSeconds: 4 }),
		])

		expect(segment(summary.agentTime.segments, "ttft")).toBe(4 * SECOND)
		expect(segment(summary.agentTime.segments, "inference")).toBe(6 * SECOND)
	})

	it("omits the time-to-first-token segment when no vendor reported one", () => {
		const summary = summarize([llmSpan({ spanId: "llm", startMs: 0, durationMs: 10 * SECOND })])

		expect(segment(summary.agentTime.segments, "ttft")).toBeUndefined()
	})

	it("orders the bands by class, and counts an agent span as neither", () => {
		const summary = summarize([
			// The agent span covers both children, so charging it too would count
			// the same work twice; the bands read tool-then-inference by class
			// however the work fell on the clock.
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 12 * SECOND }),
			toolSpan({ spanId: "tool", parentSpanId: "agent", startMs: SECOND, durationMs: 4 * SECOND }),
			llmSpan({ spanId: "llm", parentSpanId: "agent", startMs: 6 * SECOND, durationMs: 3 * SECOND }),
		])

		expect(Arr.map(summary.agentTime.segments, (entry) => entry.kind)).toEqual(["inference", "tool"])
		expect(summary.agentTime.totalMs).toBe(7 * SECOND)
	})

	// OpenRouter Broadcast nests a `provider attempt` and a `generation` span,
	// both op `chat`, under each `LLM Generation`: summing all three read 204.8s
	// of agent time in a 125.5s session.
	it("charges a model call observed at several levels once, at the outermost", () => {
		const summary = summarize([
			llmSpan({ spanId: "root", spanName: "LLM Generation", startMs: 0, durationMs: 4_842 }),
			llmSpan({ spanId: "attempt", parentSpanId: "root", startMs: 184, durationMs: 2_019 }),
			llmSpan({
				spanId: "generation",
				parentSpanId: "root",
				startMs: 200,
				durationMs: 4_402,
				ttftSeconds: 3.6,
			}),
		])

		expect(summary.agentTime.totalMs).toBe(4_842)
		// The TTFT only the nested span reported still splits the call.
		expect(segment(summary.agentTime.segments, "ttft")).toBe(3_600)
		expect(segment(summary.agentTime.segments, "inference")).toBe(1_242)
	})

	it("still charges a model call a tool made inside another call", () => {
		const summary = summarize([
			llmSpan({ spanId: "outer", startMs: 0, durationMs: 10 * SECOND }),
			toolSpan({ spanId: "tool", parentSpanId: "outer", startMs: SECOND, durationMs: 4 * SECOND }),
			llmSpan({ spanId: "inner", parentSpanId: "tool", startMs: 2 * SECOND, durationMs: 2 * SECOND }),
		])

		expect(segment(summary.agentTime.segments, "inference")).toBe(12 * SECOND)
	})
})

describe("buildSessionSummary — failed", () => {
	it("is false when the last turn closed cleanly", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
			llmSpan({ spanId: "llm", parentSpanId: "agent", startMs: SECOND, durationMs: SECOND }),
		])

		expect(summary.failed).toBe(false)
	})

	it("is true when the last turn's root span errored", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent-1", startMs: 0, durationMs: 10 * SECOND }),
			agentSpan({ spanId: "agent-2", startMs: 5 * MINUTE, durationMs: SECOND, statusCode: "Error" }),
		])

		expect(summary.failed).toBe(true)
	})

	it("reads the last turn, not any turn — an earlier failure the agent recovered from does not count", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent-1", startMs: 0, durationMs: 10 * SECOND, statusCode: "Error" }),
			agentSpan({ spanId: "agent-2", startMs: 5 * MINUTE, durationMs: SECOND }),
		])

		expect(summary.failed).toBe(false)
	})
})

describe("buildSessionSummary — tokens and models", () => {
	it("sums the five disjoint buckets and the cost the gateway stamped", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 5 * SECOND }),
			llmSpan({
				spanId: "chat",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: SECOND,
				genAi: {
					mapleInputTokens: 18,
					mapleCacheReadTokens: 200,
					mapleOutputTokens: 20,
					mapleReasoningTokens: 8,
					mapleCost: 0.002,
				},
			}),
		])

		expect(summary.tokens).toEqual({
			input: 18,
			cacheRead: 200,
			cacheWrite: 0,
			output: 20,
			reasoning: 8,
			total: 246,
		})
		expect(summary.cost).toBe(0.002)
	})

	it("counts the gateway cost eve stamps on the step above its model call", () => {
		// eve on Vercel AI Gateway: the cost is on `agent.step`, the tokens on
		// its `chat` call.
		const summary = summarize([
			agentSpan({
				spanId: "turn",
				startMs: 0,
				durationMs: 3 * SECOND,
			}),
			makeSpan({
				spanId: "step",
				parentSpanId: "turn",
				spanName: "agent.step",
				startMs: 0,
				durationMs: 2 * SECOND,
				genAi: {
					operationName: "workflow",
					mapleLlmCall: 0,
					mapleCost: 0.0004263,
				},
			}),
			llmSpan({
				spanId: "chat",
				parentSpanId: "step",
				startMs: 0,
				durationMs: 2 * SECOND,
				genAi: { mapleInputTokens: 2700, mapleOutputTokens: 50 },
			}),
		])

		expect(summary.cost).toBe(0.0004263)
		expect(summary.tokens.total).toBe(2750)
		expect(summary.work.llmCalls).toBe(1)
	})

	it("lists a model once whatever snapshot each call answered with", () => {
		const call = (spanId: string, startMs: number, responseModel?: string) =>
			llmSpan({
				spanId,
				startMs,
				durationMs: SECOND,
				genAi: {
					requestModel: "openai/gpt-4o-mini",
					responseModel,
					mapleInputTokens: 10,
					mapleOutputTokens: 1,
				},
			})
		const summary = summarize([
			call("a", 0, "gpt-4o-mini-2024-07-18"),
			call("b", 2 * SECOND, "gpt-4o-mini"),
			call("c", 4 * SECOND),
			llmSpan({
				spanId: "routed",
				startMs: 6 * SECOND,
				durationMs: SECOND,
				genAi: { requestModel: "openrouter/auto", responseModel: "anthropic/claude-sonnet-4.5" },
			}),
			llmSpan({
				spanId: "pinned",
				startMs: 8 * SECOND,
				durationMs: SECOND,
				genAi: { requestModel: "openai/gpt-4o-2024-05-13", responseModel: "gpt-4o-2024-08-06" },
			}),
		])

		expect(Arr.map(summary.models, (model) => model.model).sort()).toEqual([
			"anthropic/claude-sonnet-4.5",
			"gpt-4o-2024-08-06",
			"openai/gpt-4o-mini",
		])
	})

	it("keeps what an outer model call reported above the children that reported", () => {
		const openrouter = { vendorId: "openrouter" } as const
		const summary = summarize([
			// OpenRouter Broadcast's `LLM Generation` over the model spans beneath
			// it, the middle one carrying no usage at all — its tokens survive as
			// the generation's excess.
			llmSpan({
				...openrouter,
				spanId: "llm-generation",
				spanName: "LLM Generation",
				startMs: 0,
				durationMs: 10 * SECOND,
				genAi: { mapleInputTokens: 300, mapleOutputTokens: 30 },
			}),
			llmSpan({
				...openrouter,
				spanId: "a",
				parentSpanId: "llm-generation",
				spanName: "generation",
				startMs: 0,
				durationMs: SECOND,
				genAi: { mapleInputTokens: 100, mapleOutputTokens: 10 },
			}),
			llmSpan({
				...openrouter,
				spanId: "b",
				parentSpanId: "llm-generation",
				spanName: "generation",
				startMs: 2 * SECOND,
				durationMs: SECOND,
			}),
			llmSpan({
				...openrouter,
				spanId: "c",
				parentSpanId: "llm-generation",
				spanName: "generation",
				startMs: 4 * SECOND,
				durationMs: SECOND,
				genAi: { mapleInputTokens: 100, mapleOutputTokens: 10 },
			}),
		])

		expect(summary.tokens.input).toBe(300)
		expect(summary.tokens.output).toBe(30)
	})

	it("groups models by the one that answered, busiest first", () => {
		const summary = summarize([
			llmSpan({ spanId: "a", startMs: 0, durationMs: SECOND, model: "claude-haiku-4-5" }),
			llmSpan({ spanId: "b", startMs: 2 * SECOND, durationMs: SECOND, model: "claude-opus-4-1" }),
			llmSpan({ spanId: "c", startMs: 4 * SECOND, durationMs: SECOND, model: "claude-opus-4-1" }),
		])

		expect(Arr.map(summary.models, (model) => [model.model, model.llmCalls])).toEqual([
			["claude-opus-4-1", 2],
			["claude-haiku-4-5", 1],
		])
	})

	it("gives no model row to usage that names no model, and still counts its tokens", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 5 * SECOND }),
			llmSpan({
				spanId: "llm-1",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: SECOND,
				genAi: { mapleInputTokens: 1000, mapleOutputTokens: 100 },
			}),
		])

		expect(summary.models).toEqual([])
		expect(summary.tokens.input).toBe(1000)
	})
})

describe("buildSessionSummary — one call, several observations", () => {
	it("counts a call observed by the app and by a gateway once, at the larger claim", () => {
		// OpenRouter Broadcast forwards its own trace of the call into the same
		// session: same response id, the gateway pricing what the app could not.
		const summary = summarize([
			llmSpan({
				spanId: "app",
				startMs: 0,
				durationMs: SECOND,
				vendorId: "maple",
				genAi: {
					requestModel: "z-ai/glm-5.3-flash:nitro",
					responseId: "gen-1",
					mapleInputTokens: 100,
					mapleOutputTokens: 10,
				},
			}),
			llmSpan({
				spanId: "gateway",
				traceId: "trace-gateway",
				startMs: 500,
				durationMs: SECOND,
				vendorId: "openrouter",
				genAi: {
					requestModel: "z-ai/glm-5.3-flash",
					responseId: "gen-1",
					mapleInputTokens: 100,
					mapleOutputTokens: 10,
					mapleCost: 0.01,
				},
			}),
			// The gateway's provider attempt under its own span: a model span that
			// reports nothing while its parent does — the same call, not another.
			llmSpan({
				spanId: "attempt",
				traceId: "trace-gateway",
				parentSpanId: "gateway",
				startMs: 600,
				durationMs: 100,
				vendorId: "openrouter",
				genAi: { responseId: "gen-1:attempt-0" },
			}),
		])

		expect(summary.tokens.total).toBe(110)
		expect(summary.cost).toBe(0.01)
		expect(summary.work.llmCalls).toBe(1)
		// The app's span represents the call and carries the gateway's price, so
		// the per-model row adds up to the session's cost.
		expect(
			Arr.map(summary.models, (model) => [model.model, model.llmCalls, model.tokens.total, model.cost]),
		).toEqual([["z-ai/glm-5.3-flash:nitro", 1, 110, 0.01]])
	})

	it("counts a failed call that reported no usage, and not an outer call its children account for", () => {
		const openrouter = { vendorId: "openrouter" } as const
		const summary = summarize([
			// OpenRouter Broadcast's `LLM Generation` restating the two model
			// spans beneath it.
			llmSpan({
				...openrouter,
				spanId: "llm-generation",
				spanName: "LLM Generation",
				startMs: 0,
				durationMs: 3 * SECOND,
				genAi: { requestModel: "gpt-5", mapleInputTokens: 20, mapleOutputTokens: 2 },
			}),
			llmSpan({
				...openrouter,
				spanId: "generation-1",
				parentSpanId: "llm-generation",
				spanName: "generation",
				startMs: 0,
				durationMs: SECOND,
				genAi: { requestModel: "gpt-5", mapleInputTokens: 10, mapleOutputTokens: 1 },
			}),
			llmSpan({
				...openrouter,
				spanId: "generation-2",
				parentSpanId: "llm-generation",
				spanName: "generation",
				startMs: SECOND,
				durationMs: SECOND,
				genAi: { requestModel: "gpt-5", mapleInputTokens: 10, mapleOutputTokens: 1 },
			}),
			// A call that died before usage came back.
			llmSpan({
				spanId: "failed",
				startMs: 5 * SECOND,
				durationMs: SECOND,
				statusCode: "Error",
				genAi: { requestModel: "gpt-5" },
			}),
		])

		expect(summary.work.llmCalls).toBe(3)
		expect(summary.tokens.total).toBe(22)
	})

	it("counts a gateway request whose every attempt failed once, not once per attempt", () => {
		// OpenRouter Broadcast, trace 83d675eb…: the generation and its one
		// provider attempt both failed with op `chat` and no usage.
		const openrouter = { vendorId: "openrouter", statusCode: "Error" } as const
		const summary = summarize([
			llmSpan({
				...openrouter,
				spanId: "generation",
				spanName: "LLM Generation",
				startMs: 0,
				durationMs: 118,
				genAi: { requestModel: "openai/gpt-4o-mini", responseId: "gen-1785983234" },
			}),
			llmSpan({
				...openrouter,
				spanId: "attempt",
				parentSpanId: "generation",
				spanName: "provider attempt 1: OpenAI",
				startMs: 10,
				durationMs: 100,
				genAi: { responseId: "gen-1785983234:attempt-0" },
			}),
		])

		expect(summary.work.llmCalls).toBe(1)
	})
})

/** Two turns, each with its own model call reporting its own usage. */
const perCall = [
	agentSpan({ spanId: "a1", startMs: 0, durationMs: 10 * SECOND }),
	llmSpan({
		spanId: "l1",
		parentSpanId: "a1",
		startMs: SECOND,
		durationMs: SECOND,
		genAi: { mapleInputTokens: 100, mapleOutputTokens: 10 },
	}),
	agentSpan({ spanId: "a2", startMs: 5 * MINUTE, durationMs: 10 * SECOND }),
	llmSpan({
		spanId: "l2",
		parentSpanId: "a2",
		startMs: 5 * MINUTE + SECOND,
		durationMs: SECOND,
		genAi: { mapleInputTokens: 200, mapleOutputTokens: 20 },
	}),
]

/**
 * Aggregate-only: one long-lived span reports the whole session's usage while
 * the model calls beneath it report none, and it outlives the turn it started
 * in. Turns come from the conversation ids on the calls.
 */
const aggregateOnly = [
	llmSpan({
		spanId: "root",
		startMs: 0,
		durationMs: 5 * MINUTE + 10 * SECOND,
		genAi: { mapleInputTokens: 5000, mapleOutputTokens: 500 },
	}),
	llmSpan({
		spanId: "l1",
		parentSpanId: "root",
		startMs: SECOND,
		durationMs: SECOND,
		genAi: { conversationId: "turn-1" },
	}),
	llmSpan({
		spanId: "l2",
		parentSpanId: "root",
		startMs: 5 * MINUTE,
		durationMs: 2 * SECOND,
		genAi: { conversationId: "turn-2" },
	}),
]

describe("buildSessionSummary — token reporting", () => {
	it("is none when nothing reported usage", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: SECOND }),
			llmSpan({ spanId: "llm", parentSpanId: "agent", startMs: 0, durationMs: SECOND }),
		])

		expect(summary.tokenReporting).toBe("none")
	})

	it("is per-call when each model call reported its own", () => {
		expect(summarize(perCall).tokenReporting).toBe("per-call")
	})

	it("is roll-up when a model call restates what the calls beneath it reported", () => {
		const summary = summarize([
			llmSpan({
				spanId: "agent",
				startMs: 0,
				durationMs: 10 * SECOND,
				genAi: { mapleInputTokens: 300, mapleOutputTokens: 30 },
			}),
			llmSpan({
				spanId: "a",
				parentSpanId: "agent",
				startMs: 0,
				durationMs: SECOND,
				genAi: { mapleInputTokens: 100, mapleOutputTokens: 10 },
			}),
			llmSpan({
				spanId: "b",
				parentSpanId: "agent",
				startMs: 2 * SECOND,
				durationMs: SECOND,
				genAi: { mapleInputTokens: 200, mapleOutputTokens: 20 },
			}),
		])

		expect(summary.tokenReporting).toBe("roll-up")
	})

	it("is session-level when the only reporter covers more than one turn", () => {
		const summary = summarize(aggregateOnly)

		expect(summary.tokenReporting).toBe("session-level")
		// The session total is still right — it is the turns that cannot have it.
		expect(summary.tokens.total).toBe(5500)
	})
})

describe("countTurnTokens", () => {
	it("adds up to the session total when every call reported its own usage", () => {
		const turns = buildSessionTurns(perCall)

		expect(Arr.map(turns, (turn) => countTurnTokens(turn, turns).total)).toEqual([110, 220])
		expect(summarize(perCall).tokens.total).toBe(330)
	})

	it("counts a duplicated span row once, as the session total does", () => {
		// A page-overlapping read repeats a row (`session-transcript.ts` dedupes by
		// id for the same reason); both totals are keyed by span id.
		const duplicated = [...perCall, { ...Arr.getUnsafe(perCall, 1) }]
		const turns = buildSessionTurns(duplicated)
		const total = Arr.reduce(turns, 0, (sum, turn) => sum + countTurnTokens(turn, turns).total)

		expect(total).toBe(summarize(duplicated).tokens.total)
		expect(total).toBe(330)
	})

	it("credits no turn with a reporter that spans several of them", () => {
		// Regression: time-partitioned assignment put the whole session's 5,500
		// tokens on turn 1 and left turn 2 reading zero.
		const turns = buildSessionTurns(aggregateOnly)

		expect(turns).toHaveLength(2)
		expect(Arr.map(turns, (turn) => countTurnTokens(turn, turns).total)).toEqual([0, 0])
	})
})

describe("buildSessionSummary — cost", () => {
	it("is undefined when no span reported a cost, whatever the tokens say", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: SECOND }),
			llmSpan({
				spanId: "llm",
				parentSpanId: "agent",
				startMs: 0,
				durationMs: SECOND,
				genAi: { mapleInputTokens: 1000, mapleOutputTokens: 100 },
			}),
		])
		expect(summary.cost).toBeUndefined()
	})

	it("counts a wrapper's cost only above what its children already reported", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: SECOND, genAi: { mapleCost: 0.5 } }),
			llmSpan({
				spanId: "llm-1",
				parentSpanId: "agent",
				startMs: 0,
				durationMs: SECOND,
				genAi: { mapleInputTokens: 1000, mapleOutputTokens: 100, mapleCost: 0.2 },
			}),
			llmSpan({
				spanId: "llm-2",
				parentSpanId: "agent",
				startMs: 0,
				durationMs: SECOND,
				genAi: { mapleInputTokens: 1000, mapleOutputTokens: 100, mapleCost: 0.3 },
			}),
		])
		expect(summary.cost).toBe(0.5)
	})

	it("takes a roll-up on the agent span as the session's cost", () => {
		// The common shape for `operation.cost`: one figure at the top, tokens on
		// the model calls beneath it.
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: SECOND, genAi: { mapleCost: 0.5 } }),
			llmSpan({
				spanId: "llm-1",
				parentSpanId: "agent",
				startMs: 0,
				durationMs: SECOND,
				genAi: { mapleInputTokens: 1000, mapleOutputTokens: 100 },
			}),
			llmSpan({
				spanId: "llm-2",
				parentSpanId: "agent",
				startMs: 0,
				durationMs: SECOND,
				genAi: { mapleInputTokens: 1000, mapleOutputTokens: 100 },
			}),
		])
		expect(summary.cost).toBe(0.5)
	})
})

describe("buildSessionSummary — work and failures", () => {
	it("counts turns, model calls and tool calls separately", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 20 * SECOND }),
			llmSpan({ spanId: "llm-1", parentSpanId: "agent", startMs: SECOND, durationMs: SECOND }),
			toolSpan({ spanId: "tool-1", parentSpanId: "agent", startMs: 3 * SECOND, durationMs: SECOND }),
			toolSpan({ spanId: "tool-2", parentSpanId: "agent", startMs: 5 * SECOND, durationMs: SECOND }),
			llmSpan({ spanId: "llm-2", parentSpanId: "agent", startMs: 7 * SECOND, durationMs: SECOND }),
		])

		expect(summary.work).toEqual({ turns: 1, llmCalls: 2, toolCalls: 2 })
	})

	it("counts a failure once when a wrapper span restates it", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 20 * SECOND }),
			// The framework's own container span around the model call, carrying the
			// same error verbatim.
			llmSpan({
				spanId: "container",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: 2 * SECOND,
				statusCode: "Error",
				genAi: { errorType: "429" },
			}),
			llmSpan({
				spanId: "inner",
				parentSpanId: "container",
				startMs: SECOND,
				durationMs: SECOND,
				statusCode: "Error",
				genAi: { errorType: "429" },
			}),
		])

		expect(summary.failures.rateLimited).toBe(1)
	})

	it("counts a refusal once when the agent span repeats the finish reason", () => {
		const summary = summarize([
			agentSpan({
				spanId: "agent",
				startMs: 0,
				durationMs: 20 * SECOND,
				genAi: { operationName: "invoke_agent", responseFinishReasons: ["refusal"] },
			}),
			llmSpan({
				spanId: "llm",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: SECOND,
				genAi: { responseFinishReasons: ["refusal"] },
			}),
		])

		expect(summary.failures.refusals).toBe(1)
	})

	it("groups failures by cause, and counts each errored span once", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 40 * SECOND }),
			toolSpan({
				spanId: "tool",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: SECOND,
				statusCode: "Error",
				statusMessage: "exit 1",
			}),
			llmSpan({
				spanId: "context",
				parentSpanId: "agent",
				startMs: 3 * SECOND,
				durationMs: SECOND,
				statusCode: "Error",
				statusMessage: "context_length_exceeded",
			}),
			llmSpan({
				spanId: "refused",
				parentSpanId: "agent",
				startMs: 5 * SECOND,
				durationMs: SECOND,
				genAi: { responseFinishReasons: ["refusal"] },
			}),
		])

		expect(summary.failures).toEqual({
			errors: 1,
			rateLimited: 0,
			contextExceeded: 1,
			refusals: 1,
		})
	})

	it("counts an errored model call the patterns do not name, rather than dropping it", () => {
		const summary = summarize([
			llmSpan({
				spanId: "llm",
				startMs: 0,
				durationMs: SECOND,
				statusCode: "Error",
				statusMessage: "Internal Server Error",
			}),
		])

		expect(summary.failures.errors).toBe(1)
	})

	it("counts a failure the span status never records — an error attribute on an Ok span", () => {
		// A tool failure returned as a value: the dispatch succeeded, the tool did
		// not. The span is `Ok`; `error.type` is the only record.
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
			toolSpan({
				spanId: "tool",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: SECOND,
				genAi: { errorType: "tool_error", toolName: "run_sql" },
			}),
		])

		expect(summary.failures.errors).toBe(1)
		expect(summary.failureGroups).toEqual([{ kind: "error", label: "tool_error · run_sql", count: 1 }])
	})

	it("counts a failed gen_ai.response.status on an Ok span, classified by its signal", () => {
		const summary = summarize([
			llmSpan({
				spanId: "llm",
				startMs: 0,
				durationMs: SECOND,
				genAi: { responseStatus: "failed", errorType: "429" },
			}),
		])

		expect(summary.failures.rateLimited).toBe(1)
	})

	it("reads neither a completed response status nor a non-AI span's error.type as a failure", () => {
		// HTTP instrumentation stamps `error.type` on expected 4xx spans whose
		// status is deliberately not `Error`; only AI spans get attribute counting.
		const summary = summarize([
			llmSpan({
				spanId: "llm",
				startMs: 0,
				durationMs: SECOND,
				genAi: { responseStatus: "completed" },
			}),
			makeSpan({
				spanId: "http",
				spanName: "GET /health",
				startMs: 2 * SECOND,
				durationMs: SECOND,
				isAiSpan: false,
				genAi: { errorType: "404" },
			}),
		])

		expect(summary.failures.errors).toBe(0)
	})

	// A gateway's failed provider attempts and the app's spans around a failed
	// tool call are not failures of the agent: the counts read the generation
	// and the tool span, once each.
	it("counts neither a gateway's provider attempts nor the app's spans under a failed tool", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 20 * SECOND }),
			llmSpan({
				spanId: "gen",
				parentSpanId: "agent",
				vendorId: "openrouter",
				spanName: "LLM Generation",
				startMs: SECOND,
				durationMs: 2 * SECOND,
			}),
			llmSpan({
				spanId: "attempt",
				parentSpanId: "gen",
				vendorId: "openrouter",
				spanName: "provider attempt 1: Crusoe",
				startMs: SECOND,
				durationMs: 200,
				statusCode: "Error",
				genAi: { attemptIndex: 0, attemptStatusCode: 429, attemptProvider: "Crusoe" },
			}),
			toolSpan({
				spanId: "tool",
				parentSpanId: "agent",
				startMs: 4 * SECOND,
				durationMs: SECOND,
				toolName: "sandbox_grep",
				statusCode: "Error",
				statusMessage: "Tool execution reached a failed terminal state",
				genAi: { toolCallResult: { result: "Tool failed: GitHub App is not configured" } },
			}),
			makeSpan({
				spanId: "app",
				parentSpanId: "tool",
				spanName: "GithubAppClient.getCommit",
				startMs: 4 * SECOND,
				durationMs: 500,
				isAiSpan: false,
				statusCode: "Error",
				statusMessage: "GitHub App is not configured",
			}),
		])

		expect(summary.failures).toEqual({ errors: 1, rateLimited: 0, contextExceeded: 0, refusals: 0 })
		expect(summary.failureGroups).toEqual([
			{ kind: "toolUnavailable", label: "tool_unavailable · sandbox_grep", count: 1 },
		])
		expect(summary.tools[0]?.events[0]?.errorDetail).toBe("GitHub App is not configured")
	})

	// A refused call that also failed is two events: the refusal is a finish
	// reason, the failure a status. Sharing a response id must not fold them.
	it("keeps a refusal and a failure on one span as two events", () => {
		const summary = summarize([
			llmSpan({
				spanId: "llm",
				startMs: 0,
				durationMs: SECOND,
				statusCode: "Error",
				statusMessage: "content filtered",
				genAi: { responseId: "gen-1", responseFinishReasons: ["content_filter"] },
			}),
		])

		expect(summary.failures).toEqual({ errors: 1, rateLimited: 0, contextExceeded: 0, refusals: 1 })
	})

	it("keeps the observation that named the cause, whichever observer came first", () => {
		const summary = summarize([
			llmSpan({
				spanId: "mirror",
				traceId: "mirror",
				vendorId: "openrouter",
				spanName: "LLM Generation",
				startMs: 0,
				durationMs: SECOND,
				statusCode: "Error",
				statusMessage: "Provider returned error after retries were exhausted",
				genAi: { responseId: "gen-1" },
			}),
			llmSpan({
				spanId: "app",
				startMs: 0,
				durationMs: SECOND,
				statusCode: "Error",
				statusMessage: "429 Too Many Requests",
				genAi: { responseId: "gen-1", errorType: "rate_limit" },
			}),
		])

		expect(summary.failures).toEqual({ errors: 0, rateLimited: 1, contextExceeded: 0, refusals: 0 })
	})

	it("reads a failed tool's cause off `error.type` when the framework recorded no words", () => {
		const summary = summarize([
			toolSpan({
				spanId: "t",
				startMs: 0,
				durationMs: SECOND,
				toolName: "run_tests",
				genAi: { errorType: "timeout" },
			}),
		])

		expect(summary.failureGroups).toEqual([
			{ kind: "toolTimeout", label: "tool_timeout · run_tests", count: 1 },
		])
	})

	// The error-tag chain is not the message: an integrations error tag on an
	// upstream 500 is the tool failing, not an integration that is missing.
	it("classifies a tool failure on its words, not on its error tags", () => {
		const summary = summarize([
			toolSpan({
				spanId: "t-500",
				startMs: 0,
				durationMs: SECOND,
				toolName: "sandbox_grep",
				statusCode: "Error",
				statusMessage:
					"Tool failed: @maple/http/errors/IntegrationsUpstreamError: GitHub returned 500 Internal Server Error",
			}),
			toolSpan({
				spanId: "t-required",
				startMs: 2 * SECOND,
				durationMs: SECOND,
				toolName: "read_source_file",
				statusCode: "Error",
				statusMessage: "Tool failed: The GitHub integration is required for this tool",
			}),
			toolSpan({
				spanId: "t-schema",
				startMs: 4 * SECOND,
				durationMs: SECOND,
				toolName: "query_data",
				statusCode: "Error",
				statusMessage:
					'Tool failed: Invalid parameters: SchemaError(Missing key\n  at ["integration"])',
			}),
		])

		expect(Arr.map(summary.failureGroups, (group) => group.label).sort()).toEqual([
			"error · sandbox_grep",
			"tool_arguments · query_data",
			"tool_unavailable · read_source_file",
		])
	})

	it("keeps a gateway span's own error type over the provider_error default", () => {
		const summary = summarize([
			llmSpan({
				spanId: "gen",
				vendorId: "openrouter",
				spanName: "LLM Generation",
				startMs: 0,
				durationMs: SECOND,
				statusCode: "Error",
				genAi: { errorType: "content_filter" },
			}),
		])

		expect(Arr.map(summary.failureGroups, (group) => group.label)).toEqual(["content_filter"])
	})

	// A gateway attempt that a provider refused, then another provider served:
	// the retry is not the agent being refused, and it must not hide the
	// generation's own verdict either.
	it("reads neither a refusal nor a failure off a provider attempt, nor lets one shadow its generation", () => {
		const generation = (id: string, startMs: number, genAi: Parameters<typeof llmSpan>[0]["genAi"]) =>
			llmSpan({
				spanId: id,
				vendorId: "openrouter",
				spanName: "LLM Generation",
				startMs,
				durationMs: SECOND,
				genAi,
			})
		const attempt = (
			id: string,
			parent: string,
			startMs: number,
			genAi: Parameters<typeof llmSpan>[0]["genAi"],
		) =>
			llmSpan({
				spanId: id,
				parentSpanId: parent,
				vendorId: "openrouter",
				spanName: "provider attempt 1: BaseTen",
				startMs,
				durationMs: 200,
				statusCode: "Error",
				genAi: { attemptIndex: 0, attemptStatusCode: 400, attemptProvider: "BaseTen", ...genAi },
			})
		const summary = summarize([
			generation("gen-served", 0, {}),
			attempt("att-refused", "gen-served", 0, { responseFinishReasons: ["content_filter"] }),
			generation("gen-refused", 2 * SECOND, { responseFinishReasons: ["content_filter"] }),
			attempt("att-copied", "gen-refused", 2 * SECOND, { responseFinishReasons: ["content_filter"] }),
		])

		expect(summary.failures).toEqual({ errors: 0, rateLimited: 0, contextExceeded: 0, refusals: 1 })
	})

	it("counts a refusal seen by the app and by a gateway mirror once", () => {
		const summary = summarize([
			llmSpan({
				spanId: "app",
				startMs: 0,
				durationMs: SECOND,
				genAi: { responseId: "gen-1", responseFinishReasons: ["content_filter"] },
			}),
			llmSpan({
				spanId: "mirror",
				traceId: "mirror",
				vendorId: "openrouter",
				spanName: "LLM Generation",
				startMs: 0,
				durationMs: SECOND,
				genAi: { responseId: "gen-1", responseFinishReasons: ["content_filter"] },
			}),
		])

		expect(summary.failures).toEqual({ errors: 0, rateLimited: 0, contextExceeded: 0, refusals: 1 })
	})

	it("reads a rejected parameter named timeout as the model's arguments", () => {
		const summary = summarize([
			toolSpan({
				spanId: "t",
				startMs: 0,
				durationMs: SECOND,
				toolName: "sandbox_exec",
				statusCode: "Error",
				statusMessage:
					'Tool failed: Invalid parameters: SchemaError(Expected a number\n  at ["timeout"])',
			}),
		])

		expect(Arr.map(summary.failureGroups, (group) => group.label)).toEqual([
			"tool_arguments · sandbox_exec",
		])
	})

	it("does not read a max_tokens finish as a failure", () => {
		const summary = summarize([
			llmSpan({
				spanId: "llm",
				startMs: 0,
				durationMs: SECOND,
				genAi: { responseFinishReasons: ["length"] },
			}),
		])

		expect(summary.failures).toEqual({
			errors: 0,
			rateLimited: 0,
			contextExceeded: 0,
			refusals: 0,
		})
	})
})

describe("buildSessionSummary — identity", () => {
	it("names services busiest first and vendors in first-seen order", () => {
		const summary = summarize([
			agentSpan({
				spanId: "a",
				startMs: 0,
				durationMs: 30 * SECOND,
				serviceName: "gateway",
				vendorId: "eve",
			}),
			llmSpan({ spanId: "b", startMs: SECOND, durationMs: SECOND, serviceName: "agent-runner" }),
			llmSpan({ spanId: "c", startMs: 3 * SECOND, durationMs: SECOND, serviceName: "agent-runner" }),
			makeSpan({
				spanId: "d",
				startMs: 5 * SECOND,
				durationMs: SECOND,
				serviceName: "tool-worker",
				vendorId: "mastra",
			}),
		])

		expect(summary.serviceNames).toEqual(["agent-runner", "gateway", "tool-worker"])
		expect(summary.vendorIds).toEqual(["eve", "mastra"])
		expect(summary.traceCount).toBe(1)
		expect(summary.spanCount).toBe(4)
	})

	it("names vendors in session order, whatever order the rows arrived in", () => {
		const early = agentSpan({ spanId: "a", startMs: 0, durationMs: SECOND, vendorId: "eve" })
		const late = agentSpan({ spanId: "b", startMs: 10 * SECOND, durationMs: SECOND, vendorId: "mastra" })

		expect(buildSessionSummary({ spans: [late, early], turns: [] }).vendorIds).toEqual(["eve", "mastra"])
	})
})

describe("per-model cost, tools and failure groups", () => {
	// The rail prices each model row separately, and a model whose calls carried
	// no cost has to read as unpriced rather than free while another model's
	// figure sits above it.
	it("prices a model only from its own calls, and says nothing about the rest", () => {
		const summary = summarize([
			agentSpan({ spanId: "a1", startMs: 0, durationMs: 10 * SECOND }),
			llmSpan({
				spanId: "priced",
				parentSpanId: "a1",
				startMs: 0,
				durationMs: SECOND,
				model: "claude-opus-5",
				genAi: { mapleCost: 0.5 },
			}),
			llmSpan({
				spanId: "unpriced",
				parentSpanId: "a1",
				startMs: 2 * SECOND,
				durationMs: SECOND,
				model: "claude-haiku-4-5",
			}),
		])

		expect(summary.cost).toBeCloseTo(0.5)
		expect(
			Option.getOrThrow(Arr.findFirst(summary.models, (model) => model.model === "claude-opus-5")).cost,
		).toBeCloseTo(0.5)
		expect(
			Arr.findFirst(summary.models, (model) => model.model === "claude-haiku-4-5").pipe(
				Option.map((model) => model.cost),
				Option.getOrUndefined,
			),
		).toBeUndefined()
	})

	it("nets a sub-agent's cost through its tool span, and past a zero-cost wrapper", () => {
		// The orchestrator prices the whole run; the worker it delegates to via a
		// tool stamps a zero cost of its own over the call it made. The list nets
		// the same way (`Cost > 0` reporters, climbing past the tool span).
		const summary = summarize([
			agentSpan({
				spanId: "orchestrator",
				startMs: 0,
				durationMs: 4 * SECOND,
				genAi: { mapleCost: 0.004 },
			}),
			llmSpan({
				spanId: "own-call",
				parentSpanId: "orchestrator",
				startMs: 0,
				durationMs: SECOND,
				genAi: { mapleCost: 0.003 },
			}),
			toolSpan({
				spanId: "delegate",
				parentSpanId: "orchestrator",
				startMs: SECOND,
				durationMs: 2 * SECOND,
			}),
			agentSpan({
				spanId: "worker",
				parentSpanId: "delegate",
				startMs: SECOND,
				durationMs: 2 * SECOND,
				genAi: { mapleCost: 0 },
			}),
			llmSpan({
				spanId: "worker-call",
				parentSpanId: "worker",
				startMs: SECOND,
				durationMs: SECOND,
				genAi: { mapleCost: 0.001 },
			}),
		])

		expect(summary.cost).toBeCloseTo(0.004, 9)
	})

	it("reads a zero cost as free, not as unmeasured", () => {
		const summary = summarize([
			llmSpan({ spanId: "free", startMs: 0, durationMs: SECOND, genAi: { mapleCost: 0 } }),
		])

		expect(summary.cost).toBe(0)
	})

	// The `maple_ai.tool_call` verdict decides, as on the list.
	it("counts a stamped tool span by the gateway's verdict alone", () => {
		const stamped = (spanId: string, startMs: number, mapleToolCall: number, toolCallResult?: string) =>
			toolSpan({
				spanId,
				traceId: `trace-${spanId}`,
				toolName: "delete_file",
				startMs,
				durationMs: 1,
				genAi: { mapleLlmCall: 0, mapleToolCall, toolCallId: "call_a", toolCallResult },
			})
		const summary = summarize([
			// Google ADK's confirmation request: no call.
			stamped(
				"paused",
				0,
				0,
				'{"error": "This tool call requires confirmation, please approve or reject."}',
			),
			// LlamaIndex ends a step waiting for a human in error, which the
			// gateway stamped neither a call nor a failure.
			{ ...stamped("waiting", 500, 0), statusCode: "Error" },
			// No result and no framework mark: a call, not merged into the one
			// that follows under the same id.
			stamped("no-result", 1_000, 1),
			stamped("approved", 2_000, 1, "deleted /tmp/scratch-notes.txt"),
		])

		expect(summary.work.toolCalls).toBe(2)
		expect(Arr.map(summary.tools, (tool) => [tool.name, tool.calls])).toEqual([["delete_file", 2]])
		expect(Arr.map(Arr.getUnsafe(summary.tools, 0).events, (event) => event.spanId)).toEqual([
			"no-result",
			"approved",
		])
		expect(summary.failures.errors).toBe(0)
	})

	// Busiest first, with what each cost alongside it: how often the agent
	// reached for a tool is the ledger's own order.
	it("orders tools by how often they were called, and totals what they cost", () => {
		const summary = summarize([
			agentSpan({ spanId: "a1", startMs: 0, durationMs: 30 * SECOND }),
			toolSpan({ spanId: "t1", parentSpanId: "a1", startMs: 0, durationMs: 100 }),
			toolSpan({ spanId: "t2", parentSpanId: "a1", startMs: 200, durationMs: 100 }),
			toolSpan({
				spanId: "t3",
				parentSpanId: "a1",
				startMs: 400,
				durationMs: 5 * SECOND,
				toolName: "run_tests",
			}),
		])

		expect(
			Arr.map(summary.tools, (tool) => [tool.name, tool.calls, tool.totalMs, tool.slowestMs]),
		).toEqual([
			["read_file", 2, 200, 100],
			["run_tests", 1, 5 * SECOND, 5 * SECOND],
		])
	})

	// The rail drew one bar per tool, so a failure only ever showed as a share of
	// it. The ledger opens the call itself, which means carrying the call.
	it("carries every call of a tool: when it ran, how long, and the span behind it", () => {
		const summary = summarize([
			agentSpan({ spanId: "a1", startMs: 0, durationMs: 10 * SECOND }),
			toolSpan({ spanId: "t1", parentSpanId: "a1", startMs: 1000, durationMs: 100 }),
			toolSpan({ spanId: "t2", parentSpanId: "a1", startMs: 2000, durationMs: 300 }),
		])

		expect(
			Arr.map(Arr.getUnsafe(summary.tools, 0)?.events, (event) => ({
				...event,
				startMs: event.startMs - summary.startMs,
			})),
		).toEqual([
			{
				spanId: "t1",
				startMs: 1000,
				durationMs: 100,
				failed: false,
				errorLabel: undefined,
				errorDetail: undefined,
				turnIndex: 1,
			},
			{
				spanId: "t2",
				startMs: 2000,
				durationMs: 300,
				failed: false,
				errorLabel: undefined,
				errorDetail: undefined,
				turnIndex: 1,
			},
		])
	})

	it("counts the failed calls of each tool alongside its total", () => {
		const summary = summarize([
			agentSpan({ spanId: "a1", startMs: 0, durationMs: 10 * SECOND }),
			toolSpan({ spanId: "t1", parentSpanId: "a1", startMs: 0, durationMs: 100 }),
			toolSpan({
				spanId: "t2",
				parentSpanId: "a1",
				startMs: 200,
				durationMs: 100,
				statusCode: "Error",
			}),
			// A tool the framework recorded as failed by attribute, on an Ok span.
			toolSpan({
				spanId: "t3",
				parentSpanId: "a1",
				startMs: 400,
				durationMs: 100,
				toolName: "run_tests",
				genAi: { errorType: "timeout" },
			}),
		])

		expect(Arr.map(summary.tools, (tool) => [tool.name, tool.calls, tool.failed])).toEqual([
			["read_file", 2, 1],
			["run_tests", 1, 1],
		])
	})

	// A failed call is only actionable if it says what went wrong in the row the
	// reader expanded, rather than sending them to the span to find out.
	it("names a failed call's error, and its message wherever the framework put it", () => {
		const summary = summarize([
			agentSpan({ spanId: "a1", startMs: 0, durationMs: 10 * SECOND }),
			toolSpan({
				spanId: "t1",
				parentSpanId: "a1",
				startMs: 0,
				durationMs: 100,
				statusCode: "Error",
				statusMessage: "shard 3 is locked by a running merge",
				genAi: { errorType: "SHARD_LOCKED" },
			}),
			// Maple's own agent reports a failed call as a value on an Ok span: the
			// recorded result IS the error.
			toolSpan({
				spanId: "t2",
				parentSpanId: "a1",
				startMs: 200,
				durationMs: 100,
				toolName: "run_tests",
				genAi: { errorType: "tool_error", toolCallResult: { error: "exit 1" } },
			}),
		])

		expect(
			Arr.flatMap(summary.tools, (tool) =>
				Arr.map(tool.events, (event) => [event.errorLabel, event.errorDetail]),
			),
		).toEqual([
			["SHARD_LOCKED", "shard 3 is locked by a running merge"],
			["tool_error", "exit 1"],
		])
	})

	// A framework that records a stack trace as the tool's result would hand the
	// ledger row an unbounded line; the status-message path has always clipped.
	it("clips a failed call's message however the framework recorded it", () => {
		const long = Str.repeat(400)("x")
		const summary = summarize([
			agentSpan({ spanId: "a1", startMs: 0, durationMs: 10 * SECOND }),
			toolSpan({
				spanId: "t1",
				parentSpanId: "a1",
				startMs: 0,
				durationMs: 100,
				genAi: { errorType: "tool_error", toolCallResult: { error: long } },
			}),
			toolSpan({
				spanId: "t2",
				parentSpanId: "a1",
				startMs: 200,
				durationMs: 100,
				toolName: "run_tests",
				statusCode: "Error",
				statusMessage: long,
			}),
		])

		for (const tool of summary.tools) {
			expect(tool.events[0]?.errorDetail?.length).toBe(140)
			const detail = tool.events[0]?.errorDetail
			expect(detail !== undefined && Str.endsWith("…")(detail)).toBe(true)
		}
	})

	// The Overview discloses the description under the tool, so it rides the
	// usage row rather than being re-read off a span.
	it("keeps the first stamped tool description for the tool's usage row", () => {
		const summary = summarize([
			agentSpan({ spanId: "a1", startMs: 0, durationMs: 10 * SECOND }),
			toolSpan({ spanId: "t1", parentSpanId: "a1", startMs: 0, durationMs: 100 }),
			toolSpan({
				spanId: "t2",
				parentSpanId: "a1",
				startMs: 200,
				durationMs: 100,
				genAi: { toolDescription: "Read a file from the repository." },
			}),
		])

		expect(Arr.map(summary.tools, (tool) => tool.description)).toEqual([
			"Read a file from the repository.",
		])
	})

	// The counts and the breakdown are two readings of one list, so a failure
	// classified as a rate limit must not also appear as a generic error.
	it("groups failures under the same classification the counts use", () => {
		const summary = summarize([
			agentSpan({ spanId: "a1", startMs: 0, durationMs: 10 * SECOND }),
			llmSpan({
				spanId: "l1",
				parentSpanId: "a1",
				startMs: 0,
				durationMs: SECOND,
				statusCode: "Error",
				statusMessage: "429 too many requests",
			}),
			llmSpan({
				spanId: "l2",
				parentSpanId: "a1",
				startMs: 2 * SECOND,
				durationMs: SECOND,
				statusCode: "Error",
				statusMessage: "429 too many requests",
			}),
			toolSpan({
				spanId: "t1",
				parentSpanId: "a1",
				startMs: 4 * SECOND,
				durationMs: SECOND,
				toolName: "run_tests",
				statusCode: "Error",
				genAi: { errorType: "tool_error" },
			}),
		])

		expect(summary.failures).toEqual({
			errors: 1,
			rateLimited: 2,
			contextExceeded: 0,
			refusals: 0,
		})
		expect(summary.failureGroups).toEqual([
			{ kind: "rateLimited", label: "rate_limit", count: 2 },
			{ kind: "error", label: "tool_error · run_tests", count: 1 },
		])
	})
})
