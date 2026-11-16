import { describe, expect, it } from "vitest"
import { Record as Rec, String as Str } from "effect"
import { sameModel, stampAiSpan } from "./ai-stamp"

const SERVER = 2
const CLIENT = 3
const ERROR = 2

const stamp = (name: string, attrs: Record<string, string>, kind?: number, status?: number) =>
	stampAiSpan({ ...attrs }, name, kind, status)

/** Only the `maple_ai.*` keys of a stamped map. */
const stamps = (attrs: Record<string, string>) =>
	Rec.filter(attrs, (_, key) => Str.startsWith("maple_ai.")(key))

describe("stampAiSpan", () => {
	// Composite of facts.rs `vercel_v7_agent_call_and_tool` (model rule) and usage.rs cases, chat span.
	it("stamps a chat span as an unknown:genai model call with usage and its session", () => {
		const got = stamp("chat openai/gpt-4o-mini", {
			"gen_ai.operation.name": "chat",
			"gen_ai.conversation.id": "conv-1",
			"gen_ai.request.model": "openai/gpt-4o-mini",
			"gen_ai.response.model": "openai/gpt-4o-mini-2024-07-18",
			"gen_ai.response.id": "gen-1",
			"gen_ai.usage.input_tokens": "104",
			"gen_ai.usage.output_tokens": "33",
			"gen_ai.usage.cost": "1.5918e-05",
		})
		expect(stamps(got)).toEqual({
			"maple_ai.vendor.id": "unknown:genai",
			"maple_ai.vendor.version": "0",
			"maple_ai.session.id": "conv-1",
			"maple_ai.llm_call": "1",
			"maple_ai.usage.input_tokens": "104",
			"maple_ai.usage.output_tokens": "33",
			"maple_ai.usage.cost": "0.000015918",
			"maple_ai.model": "openai/gpt-4o-mini",
			"maple_ai.response.id": "gen-1",
		})
		// The customer's own usage keys stay as sent.
		expect(got["gen_ai.usage.input_tokens"]).toBe("104")
	})

	// usage.rs `otel_genai_anthropic_is_inclusive` and `otel_google_genai_output_includes_thoughts`.
	it("splits an inclusive prompt and completion into disjoint buckets", () => {
		const cached = stamp("chat anthropic/claude-haiku-4.5", {
			"gen_ai.operation.name": "chat",
			"gen_ai.request.model": "anthropic/claude-haiku-4.5",
			"gen_ai.usage.cache_read.input_tokens": "7581",
			"gen_ai.usage.input_tokens": "7999",
			"gen_ai.usage.output_tokens": "14",
		})
		expect(cached["maple_ai.usage.input_tokens"]).toBe("418")
		expect(cached["maple_ai.usage.cache_read_tokens"]).toBe("7581")
		expect(cached["maple_ai.usage.output_tokens"]).toBe("14")

		const gemini = stamp("generate_content gemini-2.5-flash", {
			"gen_ai.operation.name": "generate_content",
			"gen_ai.request.model": "gemini-2.5-flash",
			"gen_ai.usage.cache_read.input_tokens": "400",
			"gen_ai.usage.input_tokens": "1000",
			"gen_ai.usage.output_tokens": "400",
			"gen_ai.usage.reasoning.output_tokens": "300",
		})
		expect(stamps(gemini)).toMatchObject({
			"maple_ai.usage.input_tokens": "600",
			"maple_ai.usage.cache_read_tokens": "400",
			"maple_ai.usage.output_tokens": "100",
			"maple_ai.usage.reasoning_tokens": "300",
		})
	})

	// usage.rs `a_prompt_smaller_than_its_cache_is_exclusive`.
	it("reads a prompt smaller than its cache as exclusive", () => {
		const got = stamp("chat claude-sonnet-4-5", {
			"gen_ai.operation.name": "chat",
			"gen_ai.usage.input_tokens": "8",
			"gen_ai.usage.cache_read.input_tokens": "4248",
			"gen_ai.usage.cache_creation.input_tokens": "765",
			"gen_ai.usage.output_tokens": "263",
		})
		expect(got["maple_ai.usage.input_tokens"]).toBe("8")
		expect(got["maple_ai.usage.cache_write_tokens"]).toBe("765")
	})

	// Composite after facts.rs `vercel_v7_agent_call_and_tool`, tool span.
	it("stamps an execute_tool span as a tool call", () => {
		const got = stamp("execute_tool search_docs", {
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": "search_docs",
			"gen_ai.tool.description": "Search the docs.",
			"gen_ai.tool.call.result": '{"hits":3}',
		})
		expect(stamps(got)).toEqual({
			"maple_ai.vendor.id": "unknown:genai",
			"maple_ai.vendor.version": "0",
			"maple_ai.llm_call": "0",
			"maple_ai.tool.name": "search_docs",
			"maple_ai.tool.description": "Search the docs.",
			"maple_ai.tool_call": "1",
		})
	})

	// facts.rs `failures_and_the_failed_tool_result`.
	it("flags failures by status, response status and error.type, keeping a failed tool's result cut", () => {
		const byStatus = stamp("chat gpt-5", { "gen_ai.operation.name": "chat" }, CLIENT, ERROR)
		expect(stamps(byStatus)).toMatchObject({ "maple_ai.llm_call": "1", "maple_ai.error": "1" })
		const byResponse = stamp("chat gpt-5", {
			"gen_ai.operation.name": "chat",
			"gen_ai.response.status": "Failed",
		})
		expect(byResponse["maple_ai.error"]).toBe("1")

		const long = Str.repeat(1_050)("x")
		const tool = stamp("execute_tool fetch", {
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": "fetch",
			"error.type": "TimeoutError",
			"gen_ai.tool.call.result": long,
		})
		expect(tool["maple_ai.tool.error_result"]).toBe(Str.slice(0, 1_000)(long))
		// The cap counts code points like Rust's chars, so an emoji is one, not two.
		const emoji = stamp("execute_tool fetch", {
			"gen_ai.operation.name": "execute_tool",
			"error.type": "TimeoutError",
			"gen_ai.tool.call.result": Str.repeat(1_050)("😀"),
		})
		expect(emoji["maple_ai.tool.error_result"]).toBe(Str.repeat(1_000)("😀"))
		expect(tool["maple_ai.error"]).toBe("1")
		// An empty `error.type` is no failure.
		const ok = stamp("execute_tool fetch", { "gen_ai.operation.name": "execute_tool", "error.type": "" })
		expect(ok["maple_ai.error"]).toBeUndefined()
		expect(ok["maple_ai.tool_call"]).toBe("1")
	})

	// ai_session.rs `maple_session_key_lifts_a_generic_genai_span_out_of_the_unknown_tier`.
	it("keeps a native maple_ai.session.id as the maple vendor and strips other client maple_ai keys", () => {
		const got = stamp("chat gpt-5", {
			"gen_ai.operation.name": "chat",
			"gen_ai.conversation.id": "conv-ignored",
			"maple_ai.session.id": "chat-42",
			"maple_ai.turn.id": "turn-1",
			"maple_ai.usage.input_tokens": "999",
		})
		expect(got["maple_ai.vendor.id"]).toBe("maple")
		expect(got["maple_ai.session.id"]).toBe("chat-42")
		expect(got["maple_ai.turn.id"]).toBe("turn-1")
		expect(got["maple_ai.usage.input_tokens"]).toBeUndefined()
	})

	it("leaves a span an upstream gateway already stamped as it is", () => {
		const attrs = {
			"gen_ai.operation.name": "chat",
			"maple_ai.vendor.id": "claude_agent_sdk",
			"maple_ai.llm_call": "1",
		}
		expect(stamp("chat", attrs)).toEqual(attrs)
	})

	it("stamps a span whose upstream vendor id is empty", () => {
		const got = stamp("chat", { "gen_ai.operation.name": "chat", "maple_ai.vendor.id": "" })
		expect(got["maple_ai.vendor.id"]).toBe("unknown:genai")
	})

	it("leaves a non-GenAI span untouched", () => {
		const attrs = { "http.method": "GET", "gen_ai.request.model": "gpt-5" }
		expect(stamp("GET /chat", attrs)).toEqual(attrs)
	})

	// ai_session.rs MCP veto: the server handling `tools/call` is the tool, not an agent.
	it("never stamps an MCP server span", () => {
		const attrs = { "gen_ai.operation.name": "execute_tool", "mcp.method.name": "tools/call" }
		expect(stamps(stamp("tools/call search", attrs, SERVER))).toEqual({})
		expect(stamp("tools/call search", attrs, CLIENT)["maple_ai.tool_call"]).toBe("1")
	})

	// usage.rs `unknown_dialect_calls_by_name_and_model`.
	it("finds an unknown dialect's model call by its model, never a workflow or memory op", () => {
		const call = (name: string, attrs: Record<string, string>) => stamp(name, attrs)["maple_ai.llm_call"]
		expect(
			call("decide typesafe/jev-1.13", {
				"gen_ai.operation.name": "decide",
				"gen_ai.request.model": "typesafe/jev-1.13",
			}),
		).toBe("1")
		expect(
			call("run_workflow", {
				"gen_ai.operation.name": "workflow_step",
				"gen_ai.request.model": "gpt-4o-mini",
			}),
		).toBe("0")
		expect(
			call("search_memory chat-history", {
				"gen_ai.operation.name": "search_memory",
				"gen_ai.request.model": "text-embedding-3-small",
			}),
		).toBe("0")
		expect(
			call("rank_tools openai/gpt-4o-mini", {
				"gen_ai.operation.name": "rank",
				"gen_ai.request.model": "openai/gpt-4o-mini",
			}),
		).toBe("1")
	})

	it("sameModel ignores prefix, date and dots only (facts.rs)", () => {
		expect(sameModel("openai/gpt-4o-mini", "gpt-4o-mini-2024-07-18")).toBe(true)
		expect(sameModel("anthropic/claude-haiku-4.5", "claude-haiku-4-5-20251001")).toBe(true)
		expect(sameModel("openrouter/auto", "anthropic/claude-sonnet-4.5")).toBe(false)
		expect(sameModel("gpt-5", "gpt-5-mini-2025-08-07")).toBe(false)
		expect(sameModel("openai/gpt-4o-2024-05-13", "gpt-4o-2024-08-06")).toBe(false)
	})
})
