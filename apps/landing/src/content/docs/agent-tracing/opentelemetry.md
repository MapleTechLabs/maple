---
title: "Trace any AI agent with the OpenTelemetry GenAI conventions"
description: "Write the three OpenTelemetry spans Maple needs by hand, in any language, so a hand-rolled agent loop shows up in Agent Sessions with its transcript, tool calls, tokens and cost."
group: "AI Agents"
order: 51
navLabel: "Any language (OTel GenAI)"
icon: "opentelemetry"
---

If your agent is a loop you wrote yourself, runs on a framework without OpenTelemetry support, or lives in Go, Rust, Ruby or Elixir, nothing emits agent spans for you. You write them. Maple reads the OpenTelemetry GenAI semantic conventions, so three kinds of span are enough: one `invoke_agent` span per user turn, a `chat` span per model call and an `execute_tool` span per tool call.

What goes wrong is the detail. The GenAI conventions are still in Development status and have renamed attributes several times, and a span that looks right can still arrive with an empty transcript: messages sent as plain text, content put in span events, a JSON string cut off by an attribute length limit, or a fresh conversation id on every request.

This guide lists the exact keys and value formats Maple reads, with full examples in TypeScript and Python and a shorter one in Go. It follows the conventions in [`semantic-conventions-genai`](https://github.com/open-telemetry/semantic-conventions-genai) as of September 2026. The code was written against the OpenTelemetry JS SDK 2.11, Python SDK 1.45 and Go SDK 1.46, with the OpenAI SDK 7.23 for JavaScript and 3.20 for Python.

If you use a framework, check the [framework guides](/docs/agent-tracing) first. Most of them emit these spans for you.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-opentelemetry](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-opentelemetry) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for my hand-rolled agent in this project, using the OpenTelemetry GenAI conventions.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-opentelemetry -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## The three spans Maple needs

One user message produces one trace:

```text
invoke_agent support                 gen_ai.conversation.id = chat_42
├── chat openai/gpt-4o-mini          model call: asks for get_weather
├── execute_tool get_weather         tool call
└── chat openai/gpt-4o-mini          model call: final answer
```

Maple classifies a span by `gen_ai.operation.name`, not by its name. A span without that attribute is ignored by Agent Sessions, even if it carries a model or token counts. The span names above follow the spec (`invoke_agent {agent}`, `chat {model}`, `execute_tool {tool}`) and are what you'll see in the trace view.

**`invoke_agent`** (span kind `INTERNAL`), one per agent run:

| Attribute | Value | What Maple does with it |
| --- | --- | --- |
| `gen_ai.operation.name` | `invoke_agent` | Marks the span as an agent run. A root agent span starts a turn. |
| `gen_ai.agent.name` | `support` | Agent facet, and a separate lane for each sub-agent. |
| `gen_ai.conversation.id` | your chat or thread id | Groups the trace into a session. |
| `gen_ai.input.messages`, `gen_ai.output.messages` | JSON string, see below | Optional. The turn's prompt and answer, and a sub-agent lane's input and output. |

**`chat`** (span kind `CLIENT`), one per model call. `generate_content` and `text_completion` work too.

| Attribute | Value | What Maple does with it |
| --- | --- | --- |
| `gen_ai.operation.name` | `chat` | Counts the span as an LLM call. |
| `gen_ai.provider.name` | `openai`, `anthropic`, `gcp.gemini`, `openrouter`... | Decides how token counts are read (see [Tokens and cost](#tokens-and-cost)). |
| `gen_ai.request.model`, `gen_ai.response.model` | model ids | Model facet. The response model wins when both are set. |
| `gen_ai.response.id` | the provider's response id | Counts two spans for the same response as one call. |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | int | Token totals. |
| `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`, `gen_ai.usage.reasoning.output_tokens` | int | Cache and reasoning breakdown. |
| `gen_ai.usage.cost` | double, USD | Session cost. Not part of the OpenTelemetry spec. |
| `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages` | JSON string | The transcript. |
| `gen_ai.response.finish_reasons` | string array, e.g. `["stop"]` | Refusal (`content_filter`) and truncation (`length`) checks. |
| `gen_ai.response.time_to_first_chunk` | double, **seconds** | Time to first token on streamed calls. |

**`execute_tool`** (span kind `INTERNAL`), one per tool call:

| Attribute | Value | What Maple does with it |
| --- | --- | --- |
| `gen_ai.operation.name` | `execute_tool` | Counts the span as a tool call. |
| `gen_ai.tool.name` | `get_weather` | Tool pages and facet. |
| `gen_ai.tool.call.id` | the model's tool call id | Matches the call to the model message that requested it. |
| `gen_ai.tool.call.arguments` | JSON string of an object | Arguments in the transcript. |
| `gen_ai.tool.call.result` | JSON string of an object or array | Result in the transcript. A bare string is dropped. |

A failed span of any kind gets status `ERROR` with the error message and an `error.type` attribute. Maple counts a span as failed when either is present.

Older spellings still work, so spans from an emitter written against an earlier version of the conventions don't need a rewrite: `gen_ai.system` (renamed to `gen_ai.provider.name` in 1.37), `gen_ai.usage.prompt_tokens` and `completion_tokens`, and whole-value `gen_ai.prompt` and `gen_ai.completion`. When both old and new keys are set, the new one wins. Use the current names in new code.

### The message format

`gen_ai.input.messages` and `gen_ai.output.messages` are JSON arrays of `{role, parts}` messages, serialized to a string:

```json
[
  { "role": "user", "parts": [{ "type": "text", "content": "What's the weather in Berlin?" }] },
  {
    "role": "assistant",
    "parts": [{ "type": "tool_call", "id": "call_1", "name": "get_weather", "arguments": { "city": "Berlin" } }]
  },
  { "role": "tool", "parts": [{ "type": "tool_call_response", "id": "call_1", "response": "{\"temperature_c\":21}" }] }
]
```

Output messages add a `finish_reason` to each message. `gen_ai.system_instructions` is an array of parts without a role: `[{"type":"text","content":"You are a concise assistant."}]`. Maple also renders `reasoning` parts, and accepts `content` (a string or a part array) in place of `parts`.

Always set these as a **string** holding JSON. Maple drops a plain-text value like `"What's the weather?"`. The spec also allows structured attribute values, but Maple receives those as a list of strings and renders them as raw text.

## Export spans to Maple

Point the OTLP exporter at Maple with the standard variables:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
```

For an EU organization, use `https://ingest.eu.maple.dev`. The exporters append `/v1/traces` themselves.

TypeScript (Node.js 20 or newer):

```bash
npm install @opentelemetry/api @opentelemetry/sdk-trace-node @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-proto @opentelemetry/resources openai
```

```ts
// tracing.ts: import this first in every entry point
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"

export const provider = new NodeTracerProvider({
	resource: resourceFromAttributes({
		"service.name": "support-agent",
		"deployment.environment.name": "production",
	}),
	// Reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS
	spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
})
// Registers the global provider and the async context manager, so spans nest across awaits
provider.register()
```

Python (3.10 or newer):

```bash
pip install "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45" openai
```

```py
# tracing.py: import this first in every entry point
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

provider = TracerProvider(
    resource=Resource.create(
        {"service.name": "support-agent", "deployment.environment.name": "production"}
    )
)
# Reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)
```

Import `tracing` first in every entry point: the web server, each worker and each script. If your app already has a `TracerProvider` (from Sentry, Datadog, `opentelemetry-instrument` or `NodeSDK`), don't create a second one. Add the `BatchSpanProcessor` to the existing provider instead.

Name the tracer after your app. Maple recognizes some frameworks by their instrumentation scope name, and a tracer named `openrouter` or `langsmith`, for example, makes Maple read the session from that framework's key and ignore `gen_ai.conversation.id`.

## Instrument the agent loop in TypeScript

The examples call an OpenAI-compatible Chat Completions API through OpenRouter. Any provider works; change `baseURL`, the model ids and `PROVIDER`. Each model call streams, so the same code records time to first chunk and works for streamed chat replies.

```ts
// agent.ts
import { type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import OpenAI from "openai"
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionMessageFunctionToolCall,
	ChatCompletionMessageParam,
	ChatCompletionTool,
} from "openai/resources/chat/completions"

const tracer = trace.getTracer("support-agent")
const client = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY })
const PROVIDER = "openrouter" // gen_ai.provider.name: who you send the request to

type Message = ChatCompletionMessageParam
type ToolCall = ChatCompletionMessageFunctionToolCall
type Tool = { definition: ChatCompletionTool; run: (args: Record<string, unknown>) => unknown }
export type Agent = { name: string; model: string; instructions: string; tools: Record<string, Tool> }

const json = (value: unknown) => JSON.stringify(value)

// OpenAI message -> GenAI semconv message: { role, parts: [...] }
function toSemconv(message: Message) {
	if (message.role === "tool") {
		return { role: "tool", parts: [{ type: "tool_call_response", id: message.tool_call_id, response: message.content }] }
	}
	const parts: object[] = typeof message.content === "string" && message.content ? [{ type: "text", content: message.content }] : []
	if (message.role === "assistant") {
		for (const call of message.tool_calls ?? []) {
			if (call.type !== "function") continue
			parts.push({ type: "tool_call", id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments || "{}") })
		}
	}
	return { role: message.role, parts }
}

function markFailed(span: Span, error: unknown) {
	const err = error instanceof Error ? error : new Error(String(error))
	span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
	span.setAttribute("error.type", err.name)
}

// One model call = one `chat` span. Streams, so time to first chunk is recorded too.
async function chat(agent: Agent, messages: Message[], onText?: (delta: string) => void) {
	return tracer.startActiveSpan(
		`chat ${agent.model}`,
		{
			kind: SpanKind.CLIENT,
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.provider.name": PROVIDER,
				"gen_ai.request.model": agent.model,
				"gen_ai.system_instructions": json([{ type: "text", content: agent.instructions }]),
				"gen_ai.input.messages": json(messages.map(toSemconv)),
			},
		},
		async (span) => {
			try {
				const started = performance.now()
				const stream = await client.chat.completions.create({
					model: agent.model,
					messages: [{ role: "system", content: agent.instructions }, ...messages],
					tools: Object.values(agent.tools).map((tool) => tool.definition),
					stream: true,
					stream_options: { include_usage: true }, // without it, streamed calls report no tokens
				})
				let id = ""
				let model = agent.model
				let text = ""
				let finishReason = "stop"
				let usage: (OpenAI.CompletionUsage & { cost?: number }) | undefined
				const calls: ToolCall[] = []
				for await (const chunk of stream) {
					if (!id) span.setAttribute("gen_ai.response.time_to_first_chunk", (performance.now() - started) / 1000)
					id = chunk.id
					model = chunk.model
					if (chunk.usage) usage = chunk.usage
					const choice = chunk.choices[0]
					if (!choice) continue
					if (choice.finish_reason) finishReason = choice.finish_reason
					if (choice.delta.content) {
						text += choice.delta.content
						onText?.(choice.delta.content)
					}
					for (const delta of choice.delta.tool_calls ?? []) {
						const call = (calls[delta.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } })
						if (delta.id) call.id = delta.id
						call.function.name += delta.function?.name ?? ""
						call.function.arguments += delta.function?.arguments ?? ""
					}
				}
				const reply: ChatCompletionAssistantMessageParam = { role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) }
				span.setAttributes({
					"gen_ai.response.id": id,
					"gen_ai.response.model": model,
					"gen_ai.response.finish_reasons": [finishReason],
					"gen_ai.output.messages": json([{ ...toSemconv(reply), finish_reason: finishReason }]),
				})
				if (usage) {
					span.setAttributes({
						"gen_ai.usage.input_tokens": usage.prompt_tokens,
						"gen_ai.usage.output_tokens": usage.completion_tokens,
						"gen_ai.usage.cache_read.input_tokens": usage.prompt_tokens_details?.cached_tokens ?? 0,
						"gen_ai.usage.reasoning.output_tokens": usage.completion_tokens_details?.reasoning_tokens ?? 0,
					})
					if (usage.cost !== undefined) span.setAttribute("gen_ai.usage.cost", usage.cost) // OpenRouter returns USD cost
				}
				return reply
			} catch (error) {
				markFailed(span, error)
				throw error
			} finally {
				span.end()
			}
		},
	)
}

// One tool call = one `execute_tool` span. A failure is marked on the span and returned to the model.
async function runTool(agent: Agent, call: ToolCall) {
	const name = call.function.name
	return tracer.startActiveSpan(
		`execute_tool ${name}`,
		{
			kind: SpanKind.INTERNAL,
			attributes: {
				"gen_ai.operation.name": "execute_tool",
				"gen_ai.tool.name": name,
				"gen_ai.tool.type": "function",
				"gen_ai.tool.call.id": call.id,
				"gen_ai.tool.call.arguments": call.function.arguments || "{}",
			},
		},
		async (span) => {
			try {
				const result = await agent.tools[name]!.run(JSON.parse(call.function.arguments || "{}"))
				// Maple reads a JSON object or array here; a bare string is dropped
				const output = json(typeof result === "object" && result !== null ? result : { result })
				span.setAttribute("gen_ai.tool.call.result", output)
				return output
			} catch (error) {
				markFailed(span, error)
				return json({ error: error instanceof Error ? error.message : String(error) })
			} finally {
				span.end()
			}
		},
	)
}

// One agent run = one `invoke_agent` span. For a user turn it is the root of the trace.
export async function runAgent(
	agent: Agent,
	messages: Message[],
	options: { conversationId?: string; onText?: (delta: string) => void } = {},
): Promise<string> {
	const input = messages.at(-1)
	return tracer.startActiveSpan(
		`invoke_agent ${agent.name}`,
		{
			kind: SpanKind.INTERNAL,
			attributes: {
				"gen_ai.operation.name": "invoke_agent",
				"gen_ai.agent.name": agent.name,
				...(options.conversationId ? { "gen_ai.conversation.id": options.conversationId } : {}),
				...(input ? { "gen_ai.input.messages": json([toSemconv(input)]) } : {}),
			},
		},
		async (span) => {
			try {
				for (let step = 0; step < 10; step++) {
					const reply = await chat(agent, messages, options.onText)
					messages.push(reply)
					if (!reply.tool_calls?.length) {
						span.setAttribute("gen_ai.output.messages", json([toSemconv(reply)]))
						return typeof reply.content === "string" ? reply.content : ""
					}
					for (const call of reply.tool_calls) {
						if (call.type !== "function") continue
						messages.push({ role: "tool", tool_call_id: call.id, content: await runTool(agent, call) })
					}
				}
				throw new Error("agent exceeded 10 steps")
			} catch (error) {
				markFailed(span, error)
				throw error
			} finally {
				span.end()
			}
		},
	)
}
```

A chat backend keeps one message list per conversation and calls `runAgent` once per user message:

```ts
// main.ts
import { provider } from "./tracing" // first import: sets up the provider
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import { type Agent, runAgent } from "./agent"

const assistant: Agent = {
	name: "support",
	model: "openai/gpt-4o-mini",
	instructions: "You are a concise assistant.",
	tools: {
		get_weather: {
			definition: {
				type: "function",
				function: {
					name: "get_weather",
					description: "Current weather for a city",
					parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
				},
			},
			run: ({ city }) => ({ city, temperature_c: 21, condition: "partly cloudy" }),
		},
	},
}

// One history per conversation. Store it in your database in a real backend.
const histories = new Map<string, ChatCompletionMessageParam[]>()

export async function handleMessage(chatId: string, text: string, onText?: (delta: string) => void) {
	const history = histories.get(chatId) ?? []
	histories.set(chatId, history)
	history.push({ role: "user", content: text })
	return runAgent(assistant, history, { conversationId: chatId, onText })
}

// In a script: two messages of one conversation, then flush
try {
	await handleMessage("chat_42", "Hi! Briefly introduce yourself.")
	await handleMessage("chat_42", "What's the weather in Berlin?", (delta) => process.stdout.write(delta))
} finally {
	await provider.shutdown()
}
```

## Instrument the agent loop in Python

The same loop with the OpenAI Python SDK:

```py
# agent.py
import json
import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from openai import OpenAI, omit
from opentelemetry import trace
from opentelemetry.trace import SpanKind, Status, StatusCode

tracer = trace.get_tracer("support-agent")
client = OpenAI(base_url="https://openrouter.ai/api/v1", api_key=os.environ["OPENROUTER_API_KEY"])
PROVIDER = "openrouter"  # gen_ai.provider.name: who you send the request to


@dataclass
class Tool:
    definition: dict[str, Any]
    run: Callable[..., Any]


@dataclass
class Agent:
    name: str
    model: str
    instructions: str
    tools: dict[str, Tool] = field(default_factory=dict)


def to_semconv(message: dict[str, Any]) -> dict[str, Any]:
    """OpenAI message -> GenAI semconv message: {role, parts: [...]}."""
    if message["role"] == "tool":
        part = {"type": "tool_call_response", "id": message["tool_call_id"], "response": message["content"]}
        return {"role": "tool", "parts": [part]}
    parts: list[dict[str, Any]] = []
    if message.get("content"):
        parts.append({"type": "text", "content": message["content"]})
    for call in message.get("tool_calls") or []:
        fn = call["function"]
        parts.append({"type": "tool_call", "id": call["id"], "name": fn["name"], "arguments": json.loads(fn["arguments"] or "{}")})
    return {"role": message["role"], "parts": parts}


def mark_failed(span: trace.Span, error: Exception) -> None:
    span.set_status(Status(StatusCode.ERROR, str(error)))
    span.set_attribute("error.type", type(error).__qualname__)


def chat(agent: Agent, messages: list[dict[str, Any]], on_text: Callable[[str], None] | None = None) -> dict[str, Any]:
    """One model call = one `chat` span. Streams, so time to first chunk is recorded too."""
    attributes = {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": PROVIDER,
        "gen_ai.request.model": agent.model,
        "gen_ai.system_instructions": json.dumps([{"type": "text", "content": agent.instructions}]),
        "gen_ai.input.messages": json.dumps([to_semconv(m) for m in messages]),
    }
    with tracer.start_as_current_span(f"chat {agent.model}", kind=SpanKind.CLIENT, attributes=attributes) as span:
        try:
            started = time.perf_counter()
            stream = client.chat.completions.create(
                model=agent.model,
                messages=[{"role": "system", "content": agent.instructions}, *messages],
                tools=[tool.definition for tool in agent.tools.values()] or omit,
                stream=True,
                stream_options={"include_usage": True},  # without it, streamed calls report no tokens
            )
            response_id, model, text, finish_reason, usage = "", agent.model, "", "stop", None
            calls: dict[int, dict[str, Any]] = {}
            for chunk in stream:
                if not response_id:
                    span.set_attribute("gen_ai.response.time_to_first_chunk", time.perf_counter() - started)
                response_id, model = chunk.id, chunk.model
                usage = chunk.usage or usage
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                finish_reason = choice.finish_reason or finish_reason
                if choice.delta.content:
                    text += choice.delta.content
                    if on_text:
                        on_text(choice.delta.content)
                for delta in choice.delta.tool_calls or []:
                    call = calls.setdefault(delta.index, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                    call["id"] = delta.id or call["id"]
                    if delta.function:
                        call["function"]["name"] += delta.function.name or ""
                        call["function"]["arguments"] += delta.function.arguments or ""
            reply: dict[str, Any] = {"role": "assistant", "content": text}
            if calls:
                reply["tool_calls"] = [calls[i] for i in sorted(calls)]
            span.set_attributes({
                "gen_ai.response.id": response_id,
                "gen_ai.response.model": model,
                "gen_ai.response.finish_reasons": [finish_reason],
                "gen_ai.output.messages": json.dumps([{**to_semconv(reply), "finish_reason": finish_reason}]),
            })
            if usage:
                span.set_attributes({
                    "gen_ai.usage.input_tokens": usage.prompt_tokens,
                    "gen_ai.usage.output_tokens": usage.completion_tokens,
                    "gen_ai.usage.cache_read.input_tokens": getattr(usage.prompt_tokens_details, "cached_tokens", None) or 0,
                    "gen_ai.usage.reasoning.output_tokens": getattr(usage.completion_tokens_details, "reasoning_tokens", None) or 0,
                })
                cost = getattr(usage, "cost", None)  # OpenRouter returns USD cost
                if cost is not None:
                    span.set_attribute("gen_ai.usage.cost", cost)
            return reply
        except Exception as error:
            mark_failed(span, error)
            raise


def run_tool(agent: Agent, call: dict[str, Any]) -> str:
    """One tool call = one `execute_tool` span. A failure is marked on the span and returned to the model."""
    name, arguments = call["function"]["name"], call["function"]["arguments"] or "{}"
    attributes = {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": name,
        "gen_ai.tool.type": "function",
        "gen_ai.tool.call.id": call["id"],
        "gen_ai.tool.call.arguments": arguments,
    }
    with tracer.start_as_current_span(f"execute_tool {name}", kind=SpanKind.INTERNAL, attributes=attributes) as span:
        try:
            result = agent.tools[name].run(**json.loads(arguments))
            # Maple reads a JSON object or array here; a bare string is dropped
            output = json.dumps(result if isinstance(result, (dict, list)) else {"result": result})
            span.set_attribute("gen_ai.tool.call.result", output)
            return output
        except Exception as error:
            mark_failed(span, error)
            return json.dumps({"error": str(error)})


def run_agent(
    agent: Agent,
    messages: list[dict[str, Any]],
    conversation_id: str | None = None,
    on_text: Callable[[str], None] | None = None,
) -> str:
    """One agent run = one `invoke_agent` span. For a user turn it is the root of the trace."""
    attributes = {"gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": agent.name}
    if conversation_id:
        attributes["gen_ai.conversation.id"] = conversation_id
    if messages:
        attributes["gen_ai.input.messages"] = json.dumps([to_semconv(messages[-1])])
    with tracer.start_as_current_span(f"invoke_agent {agent.name}", kind=SpanKind.INTERNAL, attributes=attributes) as span:
        try:
            for _ in range(10):
                reply = chat(agent, messages, on_text)
                messages.append(reply)
                if not reply.get("tool_calls"):
                    span.set_attribute("gen_ai.output.messages", json.dumps([to_semconv(reply)]))
                    return reply["content"]
                for call in reply["tool_calls"]:
                    messages.append({"role": "tool", "tool_call_id": call["id"], "content": run_tool(agent, call)})
            raise RuntimeError("agent exceeded 10 steps")
        except Exception as error:
            mark_failed(span, error)
            raise
```

```py
# main.py
from tracing import provider  # first import: sets up the provider

from agent import Agent, Tool, run_agent

get_weather = Tool(
    definition={
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Current weather for a city",
            "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
        },
    },
    run=lambda city: {"city": city, "temperature_c": 21, "condition": "partly cloudy"},
)
assistant = Agent("support", "openai/gpt-4o-mini", "You are a concise assistant.", {"get_weather": get_weather})

# One history per conversation. Store it in your database in a real backend.
histories: dict[str, list[dict]] = {}


def handle_message(chat_id: str, text: str, on_text=None) -> str:
    history = histories.setdefault(chat_id, [])
    history.append({"role": "user", "content": text})
    return run_agent(assistant, history, conversation_id=chat_id, on_text=on_text)


if __name__ == "__main__":
    # In a script: two messages of one conversation, then flush
    try:
        handle_message("chat_42", "Hi! Briefly introduce yourself.")
        handle_message("chat_42", "What's the weather in Berlin?", on_text=lambda d: print(d, end="", flush=True))
    finally:
        provider.shutdown()
```

`start_as_current_span` keeps the span in a context variable, so the `chat` and `execute_tool` spans nest under `invoke_agent` in the same trace. That holds across `await` in asyncio code. It doesn't hold in a new thread: code submitted to a `ThreadPoolExecutor` starts with an empty context and becomes a separate trace. Pass the context along with `contextvars.copy_context().run(...)` if your tools run in threads.

## Go and other languages

Any OpenTelemetry SDK works, as long as it sets the same attributes. In Go, start the turn span and wrap your existing client call:

```go
// genai.go
package agent

import (
	"context"
	"encoding/json"
	"fmt"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("support-agent")

// SetupTracing reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS.
// Call Shutdown on the returned provider before the process exits.
func SetupTracing(ctx context.Context) (*sdktrace.TracerProvider, error) {
	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, err
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(resource.NewSchemaless(
			attribute.String("service.name", "support-agent"),
			attribute.String("deployment.environment.name", "production"),
		)),
	)
	otel.SetTracerProvider(tp)
	return tp, nil
}

// Message is the GenAI semconv shape: {role, parts}.
type Message struct {
	Role         string           `json:"role"`
	Parts        []map[string]any `json:"parts"`
	FinishReason string           `json:"finish_reason,omitempty"`
}

// ChatResult holds what your provider returned, copied verbatim.
type ChatResult struct {
	ID, Model, FinishReason   string
	Output                    Message
	InputTokens, OutputTokens int64
	CostUSD                   float64 // 0 when the provider doesn't return a cost
}

func jsonAttr(key string, value any) attribute.KeyValue {
	b, _ := json.Marshal(value)
	return attribute.String(key, string(b))
}

func fail(span trace.Span, err error) {
	span.SetStatus(codes.Error, err.Error())
	span.SetAttributes(attribute.String("error.type", fmt.Sprintf("%T", err)))
}

// StartTurn opens the invoke_agent span for one user message. End it when the turn is done.
func StartTurn(ctx context.Context, agentName, conversationID string) (context.Context, trace.Span) {
	return tracer.Start(ctx, "invoke_agent "+agentName, trace.WithAttributes(
		attribute.String("gen_ai.operation.name", "invoke_agent"),
		attribute.String("gen_ai.agent.name", agentName),
		attribute.String("gen_ai.conversation.id", conversationID),
	))
}

// Chat wraps one model call (your existing client code goes in call).
func Chat(ctx context.Context, model string, input []Message, call func(context.Context) (ChatResult, error)) (ChatResult, error) {
	ctx, span := tracer.Start(ctx, "chat "+model, trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(
		attribute.String("gen_ai.operation.name", "chat"),
		attribute.String("gen_ai.provider.name", "openai"),
		attribute.String("gen_ai.request.model", model),
		jsonAttr("gen_ai.input.messages", input),
	))
	defer span.End()
	res, err := call(ctx)
	if err != nil {
		fail(span, err)
		return res, err
	}
	res.Output.FinishReason = res.FinishReason
	span.SetAttributes(
		attribute.String("gen_ai.response.id", res.ID),
		attribute.String("gen_ai.response.model", res.Model),
		attribute.StringSlice("gen_ai.response.finish_reasons", []string{res.FinishReason}),
		attribute.Int64("gen_ai.usage.input_tokens", res.InputTokens),
		attribute.Int64("gen_ai.usage.output_tokens", res.OutputTokens),
		jsonAttr("gen_ai.output.messages", []Message{res.Output}),
	)
	if res.CostUSD > 0 {
		span.SetAttributes(attribute.Float64("gen_ai.usage.cost", res.CostUSD))
	}
	return res, nil
}
```

An `execute_tool` span follows the same pattern with the attributes from the table. Rust (`opentelemetry` crate), Ruby (`opentelemetry-sdk`), Elixir (`opentelemetry_api`), Java and .NET follow the same pattern: set the attributes from the tables above as strings, ints, doubles and string arrays, and serialize every message and tool payload to a JSON string first.

## Group turns into one session

Maple files a trace under the session id it finds in `gen_ai.conversation.id`. Setting it on the `invoke_agent` span of each turn is enough: every span of that trace joins the session, including HTTP and database spans. Use the id your app already has for the conversation, like a chat id or thread id, and pass the same value for every message of that conversation.

Without it, each trace is its own one-turn session, named `trace:<trace id>`. A chat backend that handles one message per request then shows one session per message.

A few things break grouping:

- **A new id per request.** A UUID generated in the request handler, or the trace id, is different for every message. The GenAI spec says the same: when there's no real conversation id, leave the attribute out rather than inventing one.
- **Different ids in one trace.** If a sub-agent sets its own id, the trace carries two, and Maple silently keeps the one that sorts last. Let sub-agents inherit the session from the trace, as the examples do, or give them the same id.
- **An id only on a span without `gen_ai.operation.name`.** Maple only reads the id from spans it classifies as AI spans.

### When a framework's session key isn't read: `maple_ai.session.id`

Some frameworks write their session id under a key Maple doesn't read for that framework, for example OpenInference's `session.id` from LangChain or LlamaIndex instrumentation, or the Vercel AI SDK's `runtimeContext`. The fix is a wrapper span of your own around each turn, carrying Maple's own session key:

```ts
// chatId comes from your request; frameworkAgent is the framework's agent
await tracer.startActiveSpan(
	"invoke_agent support",
	{
		attributes: {
			"gen_ai.operation.name": "invoke_agent",
			"gen_ai.agent.name": "support",
			"maple_ai.session.id": chatId,
		},
	},
	async (span) => {
		try {
			return await frameworkAgent.run(message) // the framework's spans nest under this one
		} finally {
			span.end()
		}
	},
)
```

`maple_ai.session.id` works on any span and overrides framework detection for that span, so the session shows the framework as **Maple**. Put it only on your own wrapper span, never on the framework's spans: a span carrying it loses the framework's attribute decoding, and Maple reads its token counts as if they include cache. Use the same value the framework would use, because with two different session ids in one trace, the one that sorts last wins. You don't need it for spans written by hand with `gen_ai.conversation.id`.

## Record prompts, responses and tool calls

The transcript comes from five attributes: `gen_ai.system_instructions`, `gen_ai.input.messages` and `gen_ai.output.messages` on `chat` spans, and `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` on `execute_tool` spans. Each has to be a JSON string on the span itself.

- **Span events and logs aren't read.** Older versions of the conventions put messages in events like `gen_ai.user.message`, and some SDKs send them as log records. Agent Sessions only reads span attributes.
- **Indexed keys aren't read.** `gen_ai.prompt.0.content` and `llm.input_messages.0.message.content` are separate dialects. Maple doesn't reassemble them.
- **Attribute length limits break the JSON.** The SDKs don't limit attribute length by default. If `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT` or `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT` is set (some platforms and distributions set one), a long history is cut mid-string, no longer parses, and Maple drops the whole attribute. Leave them unset. To cap size yourself, drop the oldest messages whole and serialize what's left.
- **Batches over 20 MiB are rejected.** Maple's ingest endpoint returns 413 for larger requests. Base64 images in every message's history add up fast; replace them with a placeholder part before serializing.

The spec treats all of this as opt-in, because prompts and tool results often contain personal data. To keep metadata only, skip those five attributes; models, tokens, timings, tool names and errors still work, and the transcript stays empty. To keep content but remove specific values, redact them in the `toSemconv` / `to_semconv` function before serializing, or with an OpenTelemetry Collector `redaction` or `transform` processor. Keep API keys out of tool arguments and results.

## Tools, errors and sub-agents

When a tool throws, the examples mark its span failed and return the error to the model as the tool result, so the agent can recover:

- status `ERROR`, with the error message as the status description;
- `error.type`, the exception class (`RuntimeError`, `TypeError`) or an error code;
- no `gen_ai.tool.call.result`, because the tool didn't return one.

Maple counts a span as failed if it has `ERROR` status, a non-empty `error.type`, or `gen_ai.response.status` set to `failed`. A tool that catches its own error and returns `{"error": "..."}` without marking the span shows as successful. The tool pages group failures by their message, with ids and numbers masked, so the status description should say what failed.

Set `gen_ai.tool.call.id` to the id the model gave the call. Maple matches each result to its call by id, which keeps parallel calls from the same model reply apart.

For a sub-agent, run it inside a tool call:

```ts
// weatherWorker is an Agent like `assistant` above, with get_weather
const orchestrator: Agent = {
	name: "orchestrator",
	model: "openai/gpt-4o-mini",
	instructions: "Delegate weather questions to the weather worker.",
	tools: {
		ask_weather_worker: {
			definition: {
				type: "function",
				function: {
					name: "ask_weather_worker",
					description: "Ask the weather worker a question",
					parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
				},
			},
			// No conversationId: the sub-agent's spans are in this trace, so it inherits the session
			run: ({ question }) => runAgent(weatherWorker, [{ role: "user", content: String(question) }]),
		},
	},
}
```

Maple shows an `execute_tool` span whose only child is an `invoke_agent` span as a delegation, in a lane named after the sub-agent's `gen_ai.agent.name`, with the tool's arguments and result as the lane's input and output. Give every agent a distinct name: two agents called `agent` share one lane, and an agent span without a name gets no lane at all.

## Tokens and cost

Put usage on `chat` spans only. Maple sums it per model call and nets a parent's usage against its children, but an agent span that reports a running total for the whole conversation is counted on top.

Maple reads five buckets: `input_tokens`, `output_tokens`, `cache_read.input_tokens`, `cache_write.input_tokens` and `reasoning.output_tokens`, all under `gen_ai.usage.`. It also accepts `gen_ai.usage.cache_creation.input_tokens`, the spelling before `cache_write`. It doesn't read `total_tokens`, `gen_ai.usage.reasoning_tokens` or `gen_ai.usage.cache_read_input_tokens`.

Providers disagree on whether input includes cached tokens, so Maple interprets the numbers by `gen_ai.provider.name`. Copy the provider's raw numbers and set the provider to the API you called:

| `gen_ai.provider.name` | Input tokens | Output tokens |
| --- | --- | --- |
| `anthropic` | Anthropic's `input_tokens`, **excluding** cache | includes thinking |
| `gcp.gemini`, `gcp.vertex_ai` | `promptTokenCount`, including cache | `candidatesTokenCount`, excluding thoughts |
| `openai`, `openrouter`, anything else | `prompt_tokens`, including cache | includes reasoning |

The Anthropic row differs from the spec, which asks for the inclusive total on every provider. If you send Anthropic's input as `input_tokens + cache_read + cache_write`, Maple counts cached tokens twice. A call to Claude through OpenRouter's OpenAI-compatible API uses `openrouter`, and OpenAI-shaped numbers.

Streaming needs `stream_options: { include_usage: true }` on OpenAI's API, or the stream carries no usage. The usage arrives in the last chunk, which has no choices. OpenRouter always sends usage.

Maple never prices tokens. A session shows cost only when `chat` spans carry `gen_ai.usage.cost` in USD (`gen_ai.usage.total_cost` also works); otherwise it's shown as unpriced. OpenRouter returns the cost in `usage.cost`, which the examples copy. OpenAI and Anthropic don't return a cost, so compute it from your own price table or leave it out.

Set `gen_ai.response.id`. If the same call is also exported by a gateway, for example [OpenRouter Broadcast](/docs/agent-tracing/openrouter), both spans carry the same response id and Maple counts the call once.

## Short-lived processes

`BatchSpanProcessor` exports every few seconds. A script, CLI, Lambda or notebook can exit before the last batch is sent. Flush explicitly:

- **TypeScript:** `await provider.shutdown()` at the end of a script, or `await provider.forceFlush()` before a serverless handler returns (inside `waitUntil` or `after()` on platforms that have one).
- **Python:** `provider.shutdown()` at the end of a script, or `provider.force_flush()` in a `finally` in a Lambda handler or after each notebook cell.
- **Go:** `defer tp.Shutdown(context.Background())` in `main`.

## Check that it works

Run one conversation with two or more messages and a tool call, then open **Agent Sessions** in Maple. Spans take a few seconds to arrive. You should see:

- one session per conversation, with your conversation id as the session id, and the framework shown as **Unidentified** (or **Maple** with `maple_ai.session.id`);
- one turn per user message, labeled with the message, and a transcript with the system instructions, prompts, replies and tool calls;
- `invoke_agent <agent>`, `chat <model>` and `execute_tool <tool>` spans, with every `chat` and `execute_tool` span inside its turn's `invoke_agent` span;
- input and output tokens on every model call, including streamed ones;
- the tool that failed marked as failed, with its message, and every other tool marked successful;
- a lane per sub-agent, named after its `gen_ai.agent.name`;
- cost on each call if your spans carry `gen_ai.usage.cost`, otherwise unpriced.

## Troubleshooting

- **Nothing shows up in Agent Sessions, but the trace is in Traces.** No span has `gen_ai.operation.name`. Maple only picks up traces with at least one classified span.
- **Every message is its own session.** `gen_ai.conversation.id` is missing, or it changes per request. Pass the conversation's id on the `invoke_agent` span of every turn.
- **A session merged two conversations.** The id is a constant, or comes from a module-level variable shared across users. Take it from the request.
- **The transcript is empty, but tokens are there.** The messages are plain text, are in span events or logs, or were cut by an attribute length limit. Set them as JSON strings on the span and unset `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT`.
- **The transcript shows raw JSON instead of messages.** The value isn't an array of `{role, parts}` messages, or it was set as a structured attribute instead of a string.
- **Streamed replies have no tokens.** Add `stream_options: { include_usage: true }` and read usage from the final chunk.
- **Anthropic calls show too many input tokens.** `input_tokens` includes cache while the provider is `anthropic`. Send Anthropic's raw `input_tokens`.
- **Tool calls are missing from the tool pages.** The span has no `gen_ai.operation.name: execute_tool` or no `gen_ai.tool.name`.
- **A failed tool shows as successful.** The span has neither `ERROR` status nor `error.type`.
- **Model and tool spans are separate traces.** The context was lost: the spans weren't started inside the `invoke_agent` span's callback, the provider wasn't registered with a context manager (use `provider.register()` in Node), or the work ran in a new thread.
- **Every model call appears twice.** A provider auto-instrumentation (OpenAI, Anthropic, OpenLLMetry, OpenInference) is also active. Keep either your `chat` spans or the instrumentation, not both. See [provider SDKs](/docs/agent-tracing/provider-sdks) for the instrumentation route.
- **Tokens are missing although the span has usage.** The key is a spelling Maple doesn't read, like `gen_ai.usage.total_tokens`, `gen_ai.usage.reasoning_tokens` or `gen_ai.usage.cache_read_input_tokens`. Use the keys in the table above.
- **Exports fail with 401.** The header is missing or malformed. Some SDKs need the space encoded: `Authorization=Bearer%20YOUR_INGEST_KEY`.
- **Nothing arrives from a script.** The process exited before the batch was sent. Call `shutdown()` at the end.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [All agent tracing guides](/docs/agent-tracing)
- [Provider SDKs](/docs/agent-tracing/provider-sdks), for auto-instrumented OpenAI, Anthropic and Gemini clients
- [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai)
- [GenAI spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) and [GenAI agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)
