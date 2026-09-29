import { describe, expect, it } from "vitest"
import { mapAiSpan, resolveAiIntegration } from "./ai-integrations"
import { AI_VENDOR_INTEGRATIONS } from "./ai-vendors"
import type { AiSessionSpansOutput } from "./ai-sessions"

const row = (vendorId: string, spanAttributes: Record<string, string>): AiSessionSpansOutput => ({
	traceId: "a1e33a5cc671a33952cc0e1117701290",
	spanId: "a2d0b69ed027b25b",
	parentSpanId: "2bafd07bbfb0eeb3",
	spanName: "ai.eve.turn",
	spanKind: "Internal",
	serviceName: "maple-slack-agent",
	durationMs: 3632.565327,
	statusCode: "Unset",
	statusMessage: "",
	timestamp: "2026-08-12 15:19:41.626000000",
	spanAttributes: { ...spanAttributes, "maple_ai.vendor.id": vendorId, "maple_ai.vendor.version": "0" },
})

describe("vercel_ai_sdk", () => {
	it("reads the older ai.* usage keys the default integration knows nothing about", () => {
		const mapped = mapAiSpan(
			row("vercel_ai_sdk", {
				"ai.usage.promptTokens": "5033",
				"ai.usage.completionTokens": "38",
				"ai.model.id": "openai/gpt-5.6-luna",
				"ai.model.provider": "openrouter",
				"ai.response.finishReason": "stop",
			}),
		)

		expect(mapped.genAi.usageInputTokens).toBe(5033)
		expect(mapped.genAi.usageOutputTokens).toBe(38)
		expect(mapped.genAi.requestModel).toBe("openai/gpt-5.6-luna")
		expect(mapped.genAi.providerName).toBe("openrouter")
		expect(mapped.genAi.responseFinishReasons).toEqual(["stop"])
		expect(resolveAiIntegration("vercel_ai_sdk").id).toBe("vercel_ai_sdk")
	})

	it("keeps the canonical gen_ai key winning over the ai.* alias", () => {
		// Current AI SDK versions emit both dialects on the same span; the
		// convention's key has to be the one that lands.
		const mapped = mapAiSpan(
			row("vercel_ai_sdk", { "gen_ai.usage.input_tokens": "5033", "ai.usage.promptTokens": "1" }),
		)

		expect(mapped.genAi.usageInputTokens).toBe(5033)
	})

	it("maps the tool dialect of an older SDK span", () => {
		const mapped = mapAiSpan(
			row("vercel_ai_sdk", {
				"ai.toolCall.name": "add_reaction",
				"ai.toolCall.id": "call_uKgzomwVJhP3bYZ0fxvwUe86",
				"ai.toolCall.args": '{"emoji":"wave"}',
				"ai.toolCall.result": '{"reacted":true}',
			}),
		)

		expect(mapped.genAi.toolName).toBe("add_reaction")
		expect(mapped.genAi.toolCallId).toBe("call_uKgzomwVJhP3bYZ0fxvwUe86")
		expect(mapped.genAi.toolCallArguments).toEqual({ emoji: "wave" })
		expect(mapped.genAi.toolCallResult).toEqual({ reacted: true })
	})

	it("falls back to the telemetry function id for the agent name", () => {
		// Real spans in this org put the same value in both, and it is the only
		// agent identity an older-SDK span carries.
		expect(
			mapAiSpan(row("vercel_ai_sdk", { "ai.telemetry.functionId": "slack-agent" })).genAi.agentName,
		).toBe("slack-agent")
		expect(
			mapAiSpan(
				row("vercel_ai_sdk", {
					"gen_ai.agent.name": "triage",
					"ai.telemetry.functionId": "slack-agent",
				}),
			).genAi.agentName,
		).toBe("triage")
	})

	it("reads TTFT from the v7 client.operation key, in seconds", () => {
		const mapped = mapAiSpan(
			row("vercel_ai_sdk", { "gen_ai.client.operation.time_to_first_chunk": "1.84" }),
		)

		expect(mapped.genAi.responseTimeToFirstChunk).toBe(1.84)

		// The canonical key still wins when both appear on one span.
		const both = mapAiSpan(
			row("vercel_ai_sdk", {
				"gen_ai.response.time_to_first_chunk": "0.5",
				"gen_ai.client.operation.time_to_first_chunk": "1.84",
			}),
		)
		expect(both.genAi.responseTimeToFirstChunk).toBe(0.5)
	})

	it("leaves fields it does not mention on the default source list", () => {
		// The merge is per field: `requestSeed` is not in the override, so it
		// keeps the default's canonical key AND the default's legacy alias.
		const mapped = mapAiSpan(row("vercel_ai_sdk", { "gen_ai.openai.request.seed": "7" }))

		expect(mapped.genAi.requestSeed).toBe(7)
	})

	it("still runs the default refine for a vendor span", () => {
		const mapped = mapAiSpan(
			row("vercel_ai_sdk", {
				"gen_ai.system": "vertex_ai",
				"gen_ai.response.finish_reasons": '["tool_calls"]',
			}),
		)

		expect(mapped.genAi.providerName).toBe("gcp.vertex_ai")
		expect(mapped.genAi.responseFinishReasons).toEqual(["tool_call"])
	})
})

describe("openinference", () => {
	it("is registered under every vendor id the gateway stamps from an OpenInference scope", () => {
		// Same dialect, several detection paths: the OpenAI instrumentor by name,
		// the framework instrumentors by their scope, and the generic bucket for
		// any other `openinference.instrumentation.*` scope.
		for (const vendorId of [
			"openinference-openai",
			"unknown:openinference",
			"agno",
			"crewai",
			"dspy",
			"langchain",
			"llamaindex",
			"openai_agents_sdk",
			"smolagents",
		] as const) {
			expect(AI_VENDOR_INTEGRATIONS[vendorId].id).toBe("openinference")
			expect(resolveAiIntegration(vendorId).id).toBe("openinference")
		}
	})

	it("reads the real arguments when the dual-write put the tool's schema there", () => {
		// A crewai `get_weather.run` TOOL span: OpenInference's GenAI dual-write
		// copies `tool.parameters` into `gen_ai.tool.call.arguments`.
		const schema =
			'{"properties": {"city": {"title": "City", "type": "string"}}, "required": ["city"], "title": "Get_Weather", "type": "object"}'
		const mapped = mapAiSpan(
			row("crewai", {
				"openinference.span.kind": "TOOL",
				"input.value": '{"city": "Berlin"}',
				"tool.name": "get_weather",
				"tool.parameters": schema,
				"gen_ai.tool.name": "get_weather",
				"gen_ai.tool.call.arguments": schema,
			}),
		)
		expect(mapped.genAi.toolCallArguments).toEqual({ city: "Berlin" })

		// Real arguments that merely differ from the schema are left alone.
		const real = mapAiSpan(
			row("openai_agents_sdk", {
				"input.value": '{"city":"Berlin"}',
				"tool.parameters": schema,
				"gen_ai.tool.call.arguments": '{"city":"Paris"}',
			}),
		)
		expect(real.genAi.toolCallArguments).toEqual({ city: "Paris" })
	})

	it("rebuilds the flattened llm.*_messages keys every Python instrumentor writes", () => {
		// Trimmed from a smolagents `OpenAIModel.generate` span, whose `input.value`
		// is a Python repr. The flattened keys win over it.
		const mapped = mapAiSpan(
			row("smolagents", {
				"openinference.span.kind": "LLM",
				"input.value": "{'messages': [ChatMessage(role=<MessageRole.USER: 'user'>, ...)]}",
				"llm.input_messages.0.message.role": "system",
				"llm.input_messages.0.message.contents.0.message_content.type": "text",
				"llm.input_messages.0.message.contents.0.message_content.text":
					"You are an expert assistant.",
				"llm.input_messages.1.message.role": "user",
				"llm.input_messages.1.message.contents.0.message_content.type": "text",
				"llm.input_messages.1.message.contents.0.message_content.text": "New task:\nWhat is 17 * 23?",
				"llm.input_messages.2.message.role": "tool",
				"llm.input_messages.2.message.tool_call_id": "call_d16tV0btWCxROGExXHu2d1nl",
				"llm.input_messages.2.message.content": "391",
				"llm.input_messages.10.message.role": "user",
				"llm.input_messages.10.message.content": "the eleventh message sorts last",
				"llm.output_messages.0.message.role": "assistant",
				"llm.output_messages.0.message.tool_calls.0.tool_call.id": "call_Mx0pfPCI8tppc9j4qopqc08x",
				"llm.output_messages.0.message.tool_calls.0.tool_call.function.name": "final_answer",
				"llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments": '{"answer":"391"}',
			}),
		)

		expect(mapped.genAi.inputMessages).toEqual([
			{ role: "system", content: [{ type: "text", text: "You are an expert assistant." }] },
			{ role: "user", content: [{ type: "text", text: "New task:\nWhat is 17 * 23?" }] },
			{ role: "tool", tool_call_id: "call_d16tV0btWCxROGExXHu2d1nl", content: "391" },
			{ role: "user", content: "the eleventh message sorts last" },
		])
		expect(mapped.genAi.outputMessages).toEqual([
			{
				role: "assistant",
				tool_calls: [
					{
						id: "call_Mx0pfPCI8tppc9j4qopqc08x",
						function: { name: "final_answer", arguments: '{"answer":"391"}' },
					},
				],
			},
		])

		// llamaindex writes an empty text part beside its tool calls; it is no part.
		const empty = mapAiSpan(
			row("llamaindex", {
				"openinference.span.kind": "LLM",
				"llm.output_messages.0.message.role": "assistant",
				"llm.output_messages.0.message.contents.0.message_content.type": "text",
				"llm.output_messages.0.message.contents.0.message_content.text": "",
				"llm.output_messages.0.message.tool_calls.0.tool_call.id": "call_1",
				"llm.output_messages.0.message.tool_calls.0.tool_call.function.name": "get_weather",
			}),
		)
		expect(empty.genAi.outputMessages).toEqual([
			{ role: "assistant", tool_calls: [{ id: "call_1", function: { name: "get_weather" } }] },
		])

		// The GenAI dual-write, where present, still wins.
		const dual = mapAiSpan(
			row("smolagents", {
				"gen_ai.input.messages": '[{"role":"user","parts":[{"type":"text","content":"canonical"}]}]',
				"llm.input_messages.0.message.role": "user",
				"llm.input_messages.0.message.content": "dialect",
			}),
		)
		expect(dual.genAi.inputMessages).toEqual([
			{ role: "user", parts: [{ type: "text", content: "canonical" }] },
		])
	})

	it("does not read an agent run's input and output as messages", () => {
		// The smolagents `CodeAgent.run` turn anchor: `input.value` is the run's
		// arguments and `output.value` its final answer. Read as messages, the
		// arguments became the turn's user row.
		const mapped = mapAiSpan(
			row("smolagents", {
				"openinference.span.kind": "AGENT",
				"gen_ai.agent.name": "assistant",
				"input.value":
					'{"task": "Hi! Briefly introduce yourself.", "stream": false, "reset": false, "images": null, "additional_args": null, "max_steps": null, "return_full_result": null}',
				"output.value": "Hello! I am an AI assistant designed to help you with a variety of tasks.",
			}),
		)
		expect(mapped.genAi.inputMessages).toBeUndefined()
		expect(mapped.genAi.outputMessages).toBeUndefined()

		// A chain whose input IS a message list (LangChain's `{messages}`) keeps it.
		const chain = mapAiSpan(
			row("unknown:openinference", {
				"openinference.span.kind": "CHAIN",
				"input.value": '{"messages": [{"role": "user", "content": "Hi"}]}',
			}),
		)
		expect(chain.genAi.inputMessages).toEqual([{ role: "user", content: "Hi" }])
	})

	it("reads a tool span's input and output as its arguments and result", () => {
		// An agno tool span without the GenAI dual-write.
		const mapped = mapAiSpan(
			row("agno", {
				"openinference.span.kind": "TOOL",
				"tool.name": "calculate",
				"input.value": '{"expression": "17 * 23"}',
				"output.value": "391",
			}),
		)
		expect(mapped.genAi.toolCallArguments).toEqual({ expression: "17 * 23" })
		expect(mapped.genAi.toolCallResult).toBe("391")
		expect(mapped.genAi.inputMessages).toBeUndefined()
		expect(mapped.genAi.outputMessages).toBeUndefined()
	})

	it("decodes a framework's OpenInference span without the GenAI dual-write", () => {
		// Trimmed from an agno `OpenRouter.invoke` LLM span, OpenInference keys only.
		const mapped = mapAiSpan(
			row("agno", {
				"openinference.span.kind": "LLM",
				"llm.model_name": "openai/gpt-4o-mini",
				"llm.token_count.prompt": "171",
				"llm.token_count.completion": "46",
				"llm.cost.total": "5.325e-05",
				"input.value":
					'{"messages": [{"id": "9b4bbc03-0b5a-4f0f-9383-1ad696468e2e", "content": "Hi! Briefly introduce yourself.", "role": "user"}]}',
				"output.value": '[{"role": "assistant", "content": "Hello! I am an AI assistant."}]',
			}),
		)

		expect(mapped.genAi).toMatchObject({
			operationName: "chat",
			requestModel: "openai/gpt-4o-mini",
			usageInputTokens: 171,
			usageOutputTokens: 46,
			usageCost: 5.325e-5,
			inputMessages: [
				{
					id: "9b4bbc03-0b5a-4f0f-9383-1ad696468e2e",
					content: "Hi! Briefly introduce yourself.",
					role: "user",
				},
			],
			outputMessages: [{ role: "assistant", content: "Hello! I am an AI assistant." }],
		})
	})

	it("maps the llm.* dialect", () => {
		const mapped = mapAiSpan(
			row("openinference-openai", {
				"llm.model_name": "gpt-5",
				"llm.provider": "openai",
				"llm.token_count.prompt": "5033",
				"llm.token_count.completion": "38",
				"llm.token_count.prompt_details.cache_read": "4924",
				"llm.token_count.completion_details.reasoning": "12",
				"input.value": '{"messages":[{"role":"user"}]}',
				"output.value": '{"messages":[{"role":"assistant"}]}',
				"tool.name": "search",
				"tool.description": "search the docs",
			}),
		)

		expect(mapped.genAi).toMatchObject({
			requestModel: "gpt-5",
			providerName: "openai",
			usageInputTokens: 5033,
			usageOutputTokens: 38,
			usageCacheReadInputTokens: 4924,
			usageReasoningOutputTokens: 12,
			inputMessages: [{ role: "user" }],
			outputMessages: [{ role: "assistant" }],
			toolName: "search",
			toolDescription: "search the docs",
		})
	})

	it("appends its dialect keys to the default's list rather than replacing it", () => {
		// The dialect key is read when it is the only one present, and the
		// canonical key still wins when the span carries both.
		const dialect = mapAiSpan(row("openinference-openai", { "llm.model_name": "gpt-5-dialect" }))

		expect(dialect.genAi.requestModel).toBe("gpt-5-dialect")

		const both = mapAiSpan(
			row("openinference-openai", {
				"gen_ai.request.model": "gpt-5-canonical",
				"llm.model_name": "gpt-5-dialect",
			}),
		)

		expect(both.genAi.requestModel).toBe("gpt-5-canonical")
	})

	it("still reads the default's legacy aliases it did not supersede", () => {
		const mapped = mapAiSpan(
			row("openinference-openai", {
				"gen_ai.usage.prompt_tokens": "120",
				"gen_ai.completion": '[{"role":"assistant"}]',
			}),
		)

		expect(mapped.genAi.usageInputTokens).toBe(120)
		expect(mapped.genAi.outputMessages).toEqual([{ role: "assistant" }])
	})

	it("translates the span kind into a gen_ai operation name", () => {
		expect(
			mapAiSpan(row("openinference-openai", { "openinference.span.kind": "LLM" })).genAi.operationName,
		).toBe("chat")
		expect(
			mapAiSpan(row("openinference-openai", { "openinference.span.kind": "TOOL" })).genAi.operationName,
		).toBe("execute_tool")
		expect(
			mapAiSpan(row("openinference-openai", { "openinference.span.kind": "AGENT" })).genAi
				.operationName,
		).toBe("invoke_agent")
	})

	it("leaves a span kind with no convention equivalent unmapped", () => {
		// Better an absent `operationName` than one carrying a value no GenAI
		// filter in the product can match.
		expect(
			mapAiSpan(row("openinference-openai", { "openinference.span.kind": "CHAIN" })).genAi
				.operationName,
		).toBeUndefined()
	})

	it("runs after the default refine, so it sees the mapped operation name", () => {
		// Hook order is default-then-vendor: the vendor's translation defers to a
		// real `gen_ai.operation.name` that the default mapping already produced.
		const mapped = mapAiSpan(
			row("openinference-openai", {
				"gen_ai.operation.name": "chat",
				"openinference.span.kind": "TOOL",
			}),
		)

		expect(mapped.genAi.operationName).toBe("chat")
	})

	it("decodes the chat.completion array OpenInference TS writes to output.value", () => {
		// Trimmed from an OpenInference TS `generation` span that asked for a tool.
		const mapped = mapAiSpan(
			row("unknown:openinference", {
				"openinference.span.kind": "LLM",
				"output.value":
					'[{"id":"gen-1790615485-YqcVFoU6RoZ0rxtOIcgJ","object":"chat.completion","model":"openai/gpt-4o-mini","choices":[{"index":0,"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"refusal":null,"tool_calls":[{"type":"function","index":0,"id":"call_S2ZCSLmFSJRp7QxaBw8DoCgT","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Berlin\\"}"}}]}}]}]',
				"llm.finish_reason": "tool_calls",
			}),
		)

		expect(mapped.genAi.outputMessages).toEqual([
			{
				role: "assistant",
				content: null,
				refusal: null,
				tool_calls: [
					{
						type: "function",
						index: 0,
						id: "call_S2ZCSLmFSJRp7QxaBw8DoCgT",
						function: { name: "get_weather", arguments: '{"city":"Berlin"}' },
					},
				],
				finish_reason: "tool_calls",
			},
		])
		expect(mapped.genAi.responseFinishReasons).toEqual(["tool_call"])

		// A lone object too: OpenRouter's test generation sends one as `gen_ai.completion`.
		const lone = mapAiSpan(
			row("openrouter", {
				"gen_ai.completion":
					'{"id":"chatcmpl-test123","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"The capital of France is Paris."},"finish_reason":"stop"}]}',
			}),
		)
		expect(lone.genAi.outputMessages).toEqual([
			{ role: "assistant", content: "The capital of France is Paris.", finish_reason: "stop" },
		])

		// Choices with no message (a streamed chunk's delta) keep the capture whole.
		const chunk = mapAiSpan(
			row("openrouter", {
				"gen_ai.completion":
					'{"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Par"},"finish_reason":null}]}',
			}),
		)
		expect(chunk.genAi.outputMessages).toEqual({
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { content: "Par" }, finish_reason: null }],
		})
	})
})

describe("eve", () => {
	it("maps a real ai.eve.turn span, which is a session envelope and nothing else", () => {
		// eve's own span carries no generation attributes at all — the model call
		// happens on Vercel-AI-SDK child spans the gateway stamps separately.
		const mapped = mapAiSpan(
			row("eve", {
				"ai.telemetry.functionId": "slack-agent",
				"eve.environment": "production",
				"eve.session.id": "wrun_01KZAAFFZRHHRYC8MY9MDANASQ",
				"eve.turn.id": "turn_1",
				"eve.version": "0.25.3",
				"maple_ai.session.id": "wrun_01KZAAFFZRHHRYC8MY9MDANASQ",
			}),
		)

		expect(mapped.genAi).toEqual({ conversationId: "turn_1" })
		expect(mapped.sessionId).toBe("wrun_01KZAAFFZRHHRYC8MY9MDANASQ")
		expect(resolveAiIntegration("eve").id).toBe("eve")
		expect(mapped.isAiSpan).toBe(true)
	})

	it("does not overwrite a conversation id the span already declared", () => {
		const mapped = mapAiSpan(row("eve", { "gen_ai.conversation.id": "conv-1", "eve.turn.id": "turn_1" }))

		expect(mapped.genAi.conversationId).toBe("conv-1")
	})

	it("runs both refine hooks, default first", () => {
		// Two observable effects on one span: the default's provider rename and
		// the vendor's turn-id mapping.
		const mapped = mapAiSpan(row("eve", { "gen_ai.system": "xai", "eve.turn.id": "turn_1" }))

		expect(mapped.genAi.providerName).toBe("x_ai")
		expect(mapped.genAi.conversationId).toBe("turn_1")
	})
})

describe("maple", () => {
	it("maps a self-instrumented chat span: canonical gen_ai plus the lifted turn id", () => {
		// What `apps/api`'s chat loop actually emits — canonical `gen_ai.*` the
		// default integration decodes, with only the turn id needing the vendor.
		const mapped = mapAiSpan(
			row("maple", {
				"gen_ai.operation.name": "chat",
				"gen_ai.request.model": "openai/gpt-5.6-luna",
				"gen_ai.provider.name": "openrouter",
				"gen_ai.usage.input_tokens": "15400",
				// Emitter-written and gateway-stamped are the same key now that
				// the AI surface lives under one namespace.
				"maple_ai.session.id": "org_1:inv-abc",
				"maple_ai.turn.id": "msg_1",
			}),
		)

		expect(mapped.genAi.conversationId).toBe("msg_1")
		expect(mapped.genAi.operationName).toBe("chat")
		expect(mapped.genAi.usageInputTokens).toBe(15400)
		expect(mapped.sessionId).toBe("org_1:inv-abc")
		expect(resolveAiIntegration("maple").id).toBe("maple")
		expect(mapped.isAiSpan).toBe(true)
	})

	it("reads the turn id over a conversation id on the same span", () => {
		// The engine's tool spans carry its thread id — the session — as the conversation id.
		const mapped = mapAiSpan(
			row("maple", { "gen_ai.conversation.id": "org_1:inv-abc", "maple_ai.turn.id": "msg_1" }),
		)

		expect(mapped.genAi.conversationId).toBe("msg_1")
	})
})

describe("the vendor merge only ever adds keys", () => {
	it("maps a legacy-only span identically under every vendor", () => {
		// A vendor's dialect keys are appended to the default's list, so an
		// override cannot cost a span a field the default would have mapped.
		// Driven from the registry so a new override inherits the check.
		const LEGACY_ONLY_SPAN = {
			"gen_ai.usage.prompt_tokens": "120",
			"gen_ai.usage.completion_tokens": "34",
			"gen_ai.usage.input_tokens.cached": "2048",
			"gen_ai.usage.output_tokens.reasoning": "704",
			"gen_ai.prompt": '[{"role":"user"}]',
			"gen_ai.completion": '[{"role":"assistant"}]',
			"gen_ai.system": "anthropic",
			"gen_ai.response.finish_reason": "stop",
			"gen_ai.usage.cost": "0.0042",
		}
		// An unregistered stamp resolves to the default integration, which is the
		// baseline every override has to reproduce.
		const baseline = mapAiSpan(row("unknown:other", LEGACY_ONLY_SPAN)).genAi

		for (const vendorId of Object.keys(AI_VENDOR_INTEGRATIONS)) {
			expect(mapAiSpan(row(vendorId, LEGACY_ONLY_SPAN)).genAi).toEqual(baseline)
		}
	})
})
