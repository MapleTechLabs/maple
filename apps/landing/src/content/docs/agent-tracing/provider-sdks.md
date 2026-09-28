---
title: "Trace agents built on the OpenAI, Anthropic and Gemini SDKs"
description: "Trace your own agent loop on the OpenAI, Anthropic or Google Gen AI SDK so each conversation is one Maple Agent Session with its transcript, tool calls, failures and tokens, in Python or TypeScript."
group: "AI Agents"
order: 50
navLabel: "OpenAI, Anthropic & Gemini SDKs"
icon: "openai"
---

If your agent is your own loop around `client.chat.completions.create`, `client.messages.create` or `client.models.generate_content`, an instrumentation library can record each model call: the prompt, the reply, the model and the tokens. It can't know where a user's turn starts, which conversation it belongs to, or that your code ran a tool between two calls. Those spans are yours to add, and it's about 40 lines of code.

Without them, every model call is its own trace, and Maple files every trace without a conversation id as its own session. A four-message chat with two tool calls shows up as six one-call sessions, with no tool calls and nothing tying them together. The second surprise is that the instrumentations record no prompts or replies until you turn content capture on.

This guide covers Python 3.10+ with `openai` 3.x, `anthropic` 1.x and `google-genai` 2.x, and TypeScript on Node.js with `openai` 7.x (the same pattern works for `@anthropic-ai/sdk` and `@google/genai`). We ran the OpenAI and Anthropic paths end to end (Python `openai` 3.20.0 and `anthropic` 1.8.0 with the 1.2b0 instrumentations, TypeScript `openai` 7.23.0). The Gemini path follows the instrumentation's documentation and hasn't been run against a live Gemini model yet. If you use an agent framework on top of these SDKs, such as the OpenAI Agents SDK, LangChain or Pydantic AI, use [that framework's guide](/docs/agent-tracing) instead.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-provider-sdks](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-provider-sdks) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for the OpenAI, Anthropic or Gemini SDK in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-provider-sdks -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Which instrumentation to use

Maple builds the transcript from GenAI span attributes: `gen_ai.input.messages` and `gen_ai.output.messages` as JSON arrays of `{role, parts}`. It doesn't read span events or OpenTelemetry logs. That rules out several popular options:

| Language | Use | Why not the alternatives |
| --- | --- | --- |
| Python | The OpenTelemetry GenAI instrumentations: `opentelemetry-instrumentation-genai-openai`, `opentelemetry-instrumentation-genai-anthropic`, `opentelemetry-instrumentation-google-genai` | They write the messages, tokens (including cache and reasoning), response id and finish reasons onto the span in the exact shape Maple reads. |
| TypeScript | A small helper that records the model call itself (below) | `@opentelemetry/instrumentation-openai` 0.20 only patches `openai` below 7.0 and writes messages to log events. There is no OpenTelemetry instrumentation for `@anthropic-ai/sdk` or `@google/genai`. |

Other packages you'll find:

- **`opentelemetry-instrumentation-openai-v2`** is deprecated. Its README says it gets security fixes only and points to `opentelemetry-instrumentation-genai-openai`.
- **`pip install opentelemetry-instrumentation-openai`** (without `genai`) installs OpenLLMetry by Traceloop, a different project. The same goes for `opentelemetry-instrumentation-anthropic`. OpenLLMetry records prompts and replies by default. Pick one family and don't install both.
- **OpenInference** (`openinference-instrumentation-openai`) is recognized by Maple as "OpenInference · OpenAI" and its tokens count, but the transcript is the raw request JSON as one message, with no turn labels. The Anthropic and Gemini OpenInference packages show as Unidentified with the same raw transcript.

The GenAI instrumentations aren't a vendor Maple recognizes by name either, so sessions show **Unidentified** in the framework column. Everything else (transcript, tools, tokens, failures) is read in full.

## Export spans to Maple

Both languages use the standard OpenTelemetry exporter variables:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT="SPAN_ONLY"
```

For an EU organization, use `https://ingest.eu.maple.dev`. The exporter appends `/v1/traces` itself. `SPAN_ONLY` is explained in [Record prompts, replies and tool calls](#record-prompts-replies-and-tool-calls).

### Python

Install the SDK, the exporter and the instrumentation for each provider you call:

```bash
pip install "opentelemetry-sdk>=1.45" "opentelemetry-exporter-otlp-proto-http>=1.45" \
  "opentelemetry-instrumentation-genai-openai>=1.2b0"
# Anthropic: opentelemetry-instrumentation-genai-anthropic>=1.2b0
# Gemini:    opentelemetry-instrumentation-google-genai>=1.2b0
```

Set up tracing once, before your first model call:

```py
# tracing.py
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.genai.openai import OpenAIInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

provider = TracerProvider(resource=Resource.create({"service.name": "support-agent"}))
# Reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

OpenAIInstrumentor().instrument()
# from opentelemetry.instrumentation.genai.anthropic import AnthropicInstrumentor
# from opentelemetry.instrumentation.google_genai import GoogleGenAiSdkInstrumentor
```

Import `tracing` at the top of your entry point. The instrumentors patch the SDK classes, so they cover every client, but the patch has to be in place before the first request. If your app already has a `TracerProvider` (Sentry, Logfire, Datadog), add the `BatchSpanProcessor` to that one instead of creating a second.

### TypeScript

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-proto
```

```ts
// instrumentation.ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { NodeSDK, tracing } from "@opentelemetry/sdk-node"

// The exporter reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS.
export const spanProcessor = new tracing.BatchSpanProcessor(new OTLPTraceExporter())

export const sdk = new NodeSDK({ serviceName: "support-agent", spanProcessors: [spanProcessor] })
sdk.start()
```

Import it first in your entry point. The helper below creates its spans through `@opentelemetry/api`, so nothing gets monkey-patched and import order only matters for the provider being registered before the first span.

## Group turns into one session

Maple groups traces into a session by `gen_ai.conversation.id`. It only needs the id on one AI span per trace, and the natural place is a span that wraps the whole turn: `invoke_agent`, with the agent's name. The model calls and tool calls made inside it become its children, so a turn is one trace.

Use the id your app already has for the conversation: the chat thread's database id, a support ticket id, the Slack thread timestamp. Don't generate a UUID per request (every turn becomes its own session) or per process (every user shares one).

### Python

```py
# agent_tracing.py
import json
import os
from contextlib import contextmanager

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

tracer = trace.get_tracer("support-agent")

# Same switch the instrumentors read, so one env var controls content everywhere.
CAPTURE_CONTENT = os.environ.get(
    "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", ""
).upper() in ("SPAN_ONLY", "SPAN_AND_EVENT")


@contextmanager
def agent_span(agent_name: str, conversation_id: str | None = None):
    """One agent run. With a conversation id, it's the turn Maple files under that session."""
    attributes = {"gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": agent_name}
    if conversation_id:
        attributes["gen_ai.conversation.id"] = conversation_id
    with tracer.start_as_current_span(f"invoke_agent {agent_name}", attributes=attributes) as span:
        yield span


def run_tool(call_id: str, name: str, arguments: str, tool) -> str:
    """One tool call. A failing tool returns its error to the model, and the span still says it failed."""
    with tracer.start_as_current_span(
        f"execute_tool {name}",
        attributes={
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": name,
            "gen_ai.tool.call.id": call_id,
        },
    ) as span:
        if CAPTURE_CONTENT:
            span.set_attribute("gen_ai.tool.call.arguments", arguments)
        try:
            result = json.dumps(tool(**json.loads(arguments)))
        except Exception as exc:
            # The exception never leaves this block, so mark the span failed by hand.
            span.record_exception(exc)
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.set_attribute("error.type", type(exc).__qualname__)
            result = json.dumps({"error": str(exc)})
        if CAPTURE_CONTENT:
            span.set_attribute("gen_ai.tool.call.result", result)
        return result
```

Your loop then looks like this. Only the two `with` and `run_tool` lines are tracing:

```py
# agent.py
import tracing  # noqa: F401  (first import)
from openai import OpenAI

from agent_tracing import agent_span, run_tool

client = OpenAI()
MODEL = "gpt-4o-mini"
# get_weather, fetch_transport_data and TOOL_SCHEMAS are your own tools and their JSON schemas.
TOOLS = {"get_weather": get_weather, "fetch_transport_data": fetch_transport_data}


def chat_turn(conversation_id: str, history: list, user_text: str) -> str:
    """One user message in, one reply out. `history` is this conversation's stored messages."""
    with agent_span("support_agent", conversation_id):
        history.append({"role": "user", "content": user_text})
        while True:
            response = client.chat.completions.create(model=MODEL, messages=history, tools=TOOL_SCHEMAS)
            message = response.choices[0].message
            history.append(message.model_dump(include={"role", "content", "tool_calls"}, exclude_none=True))
            if not message.tool_calls:
                return message.content
            for call in message.tool_calls:
                result = run_tool(call.id, call.function.name, call.function.arguments, TOOLS[call.function.name])
                history.append({"role": "tool", "tool_call_id": call.id, "content": result})
```

With Anthropic, the loop is the same shape: run each `tool_use` block with `run_tool(block.id, block.name, json.dumps(block.input), ...)` and send the results back as `tool_result` blocks. With Gemini's automatic function calling, the SDK runs your Python functions itself and the instrumentation records an `execute_tool` span for each, so wrap the turn in `agent_span` but don't call `run_tool`.

### TypeScript

The helper records all three spans: the turn, each tool call, and each model call with the attributes the Python instrumentations would write.

```ts
// agent-tracing.ts
import { type Attributes, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import type OpenAI from "openai"

const tracer = trace.getTracer("support-agent")

// Same switch as the Python instrumentations, so one env var controls content everywhere.
const captureContent = ["SPAN_ONLY", "SPAN_AND_EVENT"].includes(
	(process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ?? "").toUpperCase(),
)

/** One agent run. With a conversation id, it's the turn Maple files under that session. */
export function agentSpan<T>(agentName: string, conversationId: string | undefined, fn: () => Promise<T>) {
	const attributes: Attributes = { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": agentName }
	if (conversationId) attributes["gen_ai.conversation.id"] = conversationId
	return withSpan(`invoke_agent ${agentName}`, SpanKind.INTERNAL, attributes, () => fn())
}

/** One tool call. A failing tool returns its error to the model, and the span still says it failed. */
export function runTool(callId: string, name: string, args: string, tool: (args: any) => unknown) {
	const attributes = { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name, "gen_ai.tool.call.id": callId }
	return withSpan(`execute_tool ${name}`, SpanKind.INTERNAL, attributes, async (span) => {
		if (captureContent) span.setAttribute("gen_ai.tool.call.arguments", args)
		let result: string
		try {
			result = JSON.stringify(await tool(JSON.parse(args)))
		} catch (error) {
			markFailed(span, error)
			result = JSON.stringify({ error: String(error) })
		}
		if (captureContent) span.setAttribute("gen_ai.tool.call.result", result)
		return result
	})
}

type ChatParams = Omit<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, "stream">

/** One model call. Pass `onText` to stream; usage still arrives. */
export function tracedChat(client: OpenAI, params: ChatParams, onText?: (delta: string) => void) {
	const attributes = { "gen_ai.operation.name": "chat", "gen_ai.provider.name": "openai", "gen_ai.request.model": params.model }
	return withSpan(`chat ${params.model}`, SpanKind.CLIENT, attributes, async (span) => {
		if (captureContent) {
			span.setAttribute("gen_ai.input.messages", JSON.stringify(params.messages.map(toGenAiMessage)))
		}
		let completion: OpenAI.Chat.ChatCompletion
		if (onText) {
			const started = performance.now()
			let firstChunkAt: number | undefined
			// Without include_usage, a streamed call reports no tokens at all.
			const stream = client.chat.completions.stream({ ...params, stream_options: { include_usage: true } })
			stream.on("content", (delta) => {
				firstChunkAt ??= performance.now()
				onText(delta)
			})
			completion = await stream.finalChatCompletion()
			if (firstChunkAt !== undefined) {
				span.setAttribute("gen_ai.response.time_to_first_chunk", (firstChunkAt - started) / 1000)
			}
		} else {
			completion = await client.chat.completions.create(params)
		}
		span.setAttributes({
			"gen_ai.response.id": completion.id,
			"gen_ai.response.model": completion.model,
			"gen_ai.response.finish_reasons": completion.choices.map((c) => c.finish_reason),
		})
		if (completion.usage) {
			span.setAttributes({
				"gen_ai.usage.input_tokens": completion.usage.prompt_tokens,
				"gen_ai.usage.output_tokens": completion.usage.completion_tokens,
				"gen_ai.usage.cache_read.input_tokens": completion.usage.prompt_tokens_details?.cached_tokens ?? 0,
				"gen_ai.usage.reasoning.output_tokens": completion.usage.completion_tokens_details?.reasoning_tokens ?? 0,
			})
			// OpenRouter adds the call's price in USD to usage. Other providers don't send one.
			const cost = (completion.usage as { cost?: number }).cost
			if (cost !== undefined) span.setAttribute("gen_ai.usage.cost", cost)
		}
		if (captureContent) {
			const output = completion.choices.map((c) => ({ ...toGenAiMessage(c.message), finish_reason: c.finish_reason }))
			span.setAttribute("gen_ai.output.messages", JSON.stringify(output))
		}
		return completion
	})
}

// OpenAI chat messages -> the {role, parts} shape Maple renders as a transcript. Text and tool calls only.
function toGenAiMessage(message: OpenAI.Chat.ChatCompletionMessageParam | OpenAI.Chat.ChatCompletionMessage) {
	if (message.role === "tool") {
		return { role: "tool", parts: [{ type: "tool_call_response", id: message.tool_call_id, response: message.content }] }
	}
	const parts: object[] = []
	if (typeof message.content === "string" && message.content) parts.push({ type: "text", content: message.content })
	if (message.role === "assistant") {
		for (const call of message.tool_calls ?? []) {
			if (call.type === "function") {
				parts.push({ type: "tool_call", id: call.id, name: call.function.name, arguments: call.function.arguments })
			}
		}
	}
	return { role: message.role, parts }
}

function withSpan<T>(name: string, kind: SpanKind, attributes: Attributes, fn: (span: Span) => Promise<T>) {
	return tracer.startActiveSpan(name, { kind, attributes }, async (span) => {
		try {
			return await fn(span)
		} catch (error) {
			markFailed(span, error)
			throw error
		} finally {
			span.end()
		}
	})
}

function markFailed(span: Span, error: unknown) {
	const err = error instanceof Error ? error : new Error(String(error))
	span.recordException(err)
	span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
	span.setAttribute("error.type", err.name)
}
```

```ts
// agent.ts
import "./instrumentation.ts"
import OpenAI from "openai"
import { agentSpan, runTool, tracedChat } from "./agent-tracing.ts"

const client = new OpenAI()
const model = "gpt-4o-mini"
// tools: Record<string, (args: any) => unknown> and toolSchemas: OpenAI.Chat.ChatCompletionTool[] are your own.

/** One user message in, one reply out. `history` is this conversation's stored messages. */
export function chatTurn(
	conversationId: string,
	history: OpenAI.Chat.ChatCompletionMessageParam[],
	userText: string,
	onText?: (delta: string) => void,
) {
	return agentSpan("support_agent", conversationId, async () => {
		history.push({ role: "user", content: userText })
		while (true) {
			const completion = await tracedChat(client, { model, messages: history, tools: toolSchemas }, onText)
			const message = completion.choices[0].message
			history.push(message)
			if (!message.tool_calls?.length) return message.content ?? ""
			for (const call of message.tool_calls) {
				if (call.type !== "function") continue
				const result = await runTool(call.id, call.function.name, call.function.arguments, tools[call.function.name])
				history.push({ role: "tool", tool_call_id: call.id, content: result })
			}
		}
	})
}
```

For `@anthropic-ai/sdk` or `@google/genai`, copy `tracedChat` and change what it reads. Keep each provider's raw token counts: Maple knows that Anthropic's `input_tokens` excludes cached tokens and Gemini's `candidatesTokenCount` excludes thinking tokens, and it picks the right arithmetic from `gen_ai.provider.name`.

| Attribute | Anthropic Messages | Gemini `generateContent` |
| --- | --- | --- |
| `gen_ai.operation.name` | `chat` | `generate_content` |
| `gen_ai.provider.name` | `anthropic` | `gcp.gemini` (`gcp.vertex_ai` on Vertex) |
| `gen_ai.response.id` / `.model` | `id` / `model` | `responseId` / `modelVersion` |
| `gen_ai.response.finish_reasons` | `[stop_reason]` | `candidates[].finishReason` |
| `gen_ai.usage.input_tokens` | `usage.input_tokens` | `usageMetadata.promptTokenCount` |
| `gen_ai.usage.output_tokens` | `usage.output_tokens` | `usageMetadata.candidatesTokenCount` |
| `gen_ai.usage.cache_read.input_tokens` | `usage.cache_read_input_tokens` | `usageMetadata.cachedContentTokenCount` |
| `gen_ai.usage.cache_write.input_tokens` | `usage.cache_creation_input_tokens` | not reported |
| `gen_ai.usage.reasoning.output_tokens` | not reported separately | `usageMetadata.thoughtsTokenCount` |

For messages, map text blocks to `{type: "text", content}`, tool calls (`tool_use`, `functionCall`) to `{type: "tool_call", id, name, arguments}` and tool results (`tool_result`, `functionResponse`) to `{type: "tool_call_response", id, response}`. Pass the system prompt as `gen_ai.system_instructions`, a JSON array of text parts.

If you skip the turn span, each model call is its own trace and its own session, and tool calls float as separate one-span traces. If you keep the span but drop the id, you get one session per turn.

## Record prompts, replies and tool calls

The instrumentations record no message content by default. `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` takes four values:

| Value | Where content goes | In Maple |
| --- | --- | --- |
| `NO_CONTENT` (default) | Nowhere | Turns, models, tokens and tools, with an empty transcript |
| `SPAN_ONLY` | Span attributes | Full transcript. Use this. |
| `EVENT_ONLY` | Log events | Empty transcript: Maple doesn't read logs |
| `SPAN_AND_EVENT` | Both | Full transcript, plus a second copy in your logs if you export them |

The 1.x GenAI packages (July 2026 onward) don't need `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`: the current GenAI conventions are the only ones they emit. Older guides that tell you to set it, or to set the capture variable to `true`, describe the deprecated `openai-v2` package, where `true` meant log events.

The helpers above read the same variable, so tool arguments, tool results and (in TypeScript) messages follow one switch.

Content capture sends everything your users type and everything the model answers. To keep it off in production, leave the variable unset there: you still get the session, turns, tools, tokens and failures. To keep content but drop secrets, redact in your code before the call, or run an OpenTelemetry Collector with a `redaction` or `transform` processor on `gen_ai.input.messages` and `gen_ai.output.messages`. Don't lower `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT` to trim them: it cuts the JSON mid-string, and Maple drops a message attribute that doesn't parse.

## Tools, errors and sub-agents

Each `run_tool` call is an `execute_tool <name>` span with the tool name, the model's call id, the arguments and the result. The call id is what lets Maple pair the tool span with the tool call in the model's reply.

Most agent loops catch a tool's exception and hand the error back to the model, which is right for the agent but hides the failure from tracing: the exception never escapes, so the span would end as a success. The helpers mark the span failed themselves (status `ERROR`, `error.type`, the exception recorded), and Maple counts it under the session's tool errors and on the Tools page, grouped by the error message.

A sub-agent is another agent run inside a tool call. Call it through `run_tool` and wrap its loop in `agent_span` with its own name:

```py
def ask_weather_worker(task: str) -> str:
    # Runs inside the orchestrator's execute_tool span, in the same trace.
    with agent_span("weather_worker"):
        ...  # its own model calls and tools
```

It doesn't need the conversation id, because it's in the orchestrator's trace. Maple opens a separate lane for each distinct `gen_ai.agent.name`, and an `execute_tool` span whose only child is an agent span shows as a delegation with the task and the answer. Two agents with the same name merge into one lane.

If you run tools in parallel, `asyncio.gather` and `Promise.all` keep the trace context. A `ThreadPoolExecutor` doesn't: submit `contextvars.copy_context().run` with your function, or the tool spans start new traces outside the turn.

## Tokens and cost

The Python instrumentations record input and output tokens on every model call, plus cached input and reasoning tokens when the provider reports them. The TypeScript helper does the same for OpenAI.

Streaming is the exception. OpenAI's Chat Completions API only sends usage on streamed calls when you ask for it, in a last chunk with no `choices`:

```py
stream = client.chat.completions.create(
    model=MODEL, messages=history, stream=True, stream_options={"include_usage": True}
)
reply = "".join(chunk.choices[0].delta.content or "" for chunk in stream if chunk.choices)
```

Without `stream_options`, the streamed call shows 0 tokens in Maple. Anthropic and Gemini always send usage on a stream. The Python OpenAI instrumentation and the TypeScript helper also record time to first chunk on streamed calls, which Maple shows per model call. The Anthropic instrumentation (1.2b0) doesn't record it for `messages.stream()`.

If you call Claude or Gemini models through OpenRouter's OpenAI-compatible endpoint with the `openai` SDK, the spans say `gen_ai.provider.name=openai`. That is correct: the usage arrives in OpenAI's shape, and Maple does the arithmetic for that shape.

None of the Python instrumentations record cost, and Maple doesn't price tokens itself, so those sessions show as **unpriced**. In TypeScript you own the span: the helper copies OpenRouter's `usage.cost` (USD, sent on streamed calls too) to `gen_ai.usage.cost`, which Maple reads as the call's cost. Called directly, OpenAI sends no cost and the session stays unpriced.

## Short-lived processes

`BatchSpanProcessor` sends spans every 5 seconds, so the last turn of a script can still be in memory when the process exits.

- **Python:** the `TracerProvider` flushes when the interpreter exits normally. In a serverless handler, a notebook or anything that ends with `os._exit`, call `provider.force_flush()` after each turn.
- **TypeScript:** call `await sdk.shutdown()` before a CLI or script exits. In a serverless handler, call `await spanProcessor.forceFlush()` before returning, or in `waitUntil` once a streamed response is sent.

## Check that it works

Run one conversation of two or three messages with at least one tool call, flush, and open **Agent Sessions** in Maple. Sessions appear within a few seconds of the export.

- **One session per conversation**, with the conversation id you passed. The framework column says **Unidentified**, which is expected for this setup.
- **One turn per user message**, labeled with the first line of that message (with content capture on). Each turn is an `invoke_agent support_agent` span (your agent name) holding the rest.
- **Model calls** named `chat <model>` for OpenAI and Anthropic (`chat gpt-4o-mini`) or `generate_content <model>` for Gemini, with input and output tokens.
- **Tool calls** named `execute_tool get_weather` with their arguments and results, and a failing tool counted as a tool error.
- **A transcript** with the user messages, the replies and the tool calls between them.
- **Cost** shown as unpriced, except for TypeScript calls through OpenRouter, where the helper records OpenRouter's price.

## Troubleshooting

- **Every model call is its own session.** The call ran outside `agent_span`, or the span was ended before the call. Wrap the whole turn, including the tool loop, in one `agent_span` with the conversation id.
- **One session per turn instead of per conversation.** The conversation id changes per request. Pass the id stored with the conversation, not a new UUID.
- **Turns show models and tokens but the transcript is empty.** Content capture is off, or set to `EVENT_ONLY` or `true`. Set `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY` in the process that makes the calls.
- **No model spans in Python, only yours.** The instrumentor wasn't installed or `instrument()` ran after the first request. Check that `tracing` is imported first, and that you installed `opentelemetry-instrumentation-genai-openai`, not `opentelemetry-instrumentation-openai`.
- **Every model call appears twice.** Two instrumentations wrap the same SDK: the GenAI package plus OpenLLMetry, OpenInference, the deprecated `openai-v2` package, `logfire.instrument_openai()`, Sentry's OpenAI integration or a framework's own tracing. `opentelemetry-instrument` loads every instrumentation package that's installed, so uninstall the extras rather than just not calling them.
- **Twin traces for every call when you use OpenRouter.** OpenRouter Broadcast is also exporting the same calls. Keep one source, or nest Broadcast under your spans as the [OpenRouter guide](/docs/agent-tracing/openrouter#join-broadcast-to-your-own-traces) shows.
- **The streamed turn has 0 tokens.** Add `stream_options={"include_usage": True}` (OpenAI Chat Completions).
- **A failing tool shows as successful.** The tool's exception was caught outside `run_tool`. Let `run_tool` catch it, or set the span status and `error.type` where you catch it.
- **Sub-agent calls land in the orchestrator's lane.** The sub-agent's `agent_span` has the same name as the orchestrator's, or it was never wrapped. Give each agent its own name.
- **Two conversation ids in one trace.** With the OpenAI Responses API and a `conversation` parameter, the instrumentation also sets `gen_ai.conversation.id` to that `conv_...` id. Pass the same id to `agent_span`, or Maple picks one of the two and can split the turn.
- **Cached Anthropic calls show more input tokens than you were billed for (Python).** The Anthropic GenAI instrumentation reports `gen_ai.usage.input_tokens` as the raw input plus cache reads plus cache writes (a call that sent 330 new tokens and wrote 7,581 to the cache reports 7,911), while Maple reads Anthropic's figure as excluding the cache and adds both buckets again. In our test, a three-turn session that processed 40,239 tokens showed 78,144 in Maple. Calls without prompt caching are unaffected.
- **Using the Anthropic SDK through OpenRouter.** Point it at `https://openrouter.ai/api` (no `/v1`): `Anthropic(base_url="https://openrouter.ai/api", api_key=OPENROUTER_API_KEY)`. OpenRouter accepts the key as `api_key` or `auth_token`. Model ids are OpenRouter's, such as `anthropic/claude-haiku-4.5`, and the spans say `gen_ai.provider.name=anthropic`.
- **Nothing arrives, and the exporter logs 401.** The key or region is wrong. EU keys only work with `ingest.eu.maple.dev`.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [Agent tracing guides](/docs/agent-tracing)
- [OpenRouter](/docs/agent-tracing/openrouter), if your calls go through OpenRouter
- [OpenTelemetry GenAI instrumentations for Python](https://github.com/open-telemetry/opentelemetry-python-genai)
- [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
