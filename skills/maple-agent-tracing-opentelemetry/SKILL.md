---
name: maple-agent-tracing-opentelemetry
description: "Trace a hand-rolled or unsupported AI agent with Maple by emitting the OpenTelemetry GenAI conventions yourself (invoke_agent, chat, execute_tool spans) in any language: TypeScript, Python, Go, Rust, Ruby, Elixir, Java, .NET. Triggers on 'trace my custom agent', 'add Maple to my agent loop', 'agent sessions without a framework', 'OpenTelemetry GenAI spans by hand', 'OpenTelemetry for my AI agent in Go/Rust/Ruby'."
---

# Maple agent tracing: OpenTelemetry GenAI conventions (any language)

Goal: every conversation = one Maple Agent Session. Each user message = one trace rooted at an `invoke_agent` span, with a `chat` span per model call (model, tokens, transcript) and an `execute_tool` span per tool call (args, result, failures).

Mechanism: you write the spans. Maple classifies a span only by `gen_ai.operation.name`, groups a trace by `gen_ai.conversation.id`, and reads content only from span attributes. Hand-written spans show as framework "Unidentified" (vendor `unknown:genai`); that is expected.

## Step 0: Detect

1. Language and entry points (web server, workers, scripts, serverless handlers).
2. Is a supported framework the real agent runtime? (`@mastra/core`, `ai`, `agents`/`@cloudflare/ai-chat`, `genkit`/`@genkit-ai/*`, `@openai/agents`/`openai-agents`, `langchain`/`langgraph`, `pydantic-ai`, `crewai`, `google-adk`, `llama-index`, `strands-agents`, `smolagents`, `agno`, `dspy`, `haystack-ai`, `agent-framework`, Spring AI, `litellm`, Claude Agent SDK). If yes, stop and use `maple-agent-tracing-<framework>` instead; use this skill only for the parts that framework doesn't cover, or for the `maple_ai.session.id` wrapper (Step 4).
3. Existing OTel setup. Search for `TracerProvider`, `NodeTracerProvider`, `NodeSDK`, `registerOTel`, `set_tracer_provider`, `opentelemetry-instrument`, `logfire.configure`, `sentry_sdk.init`/`Sentry.init`, `otel.SetTracerProvider`. Exists → add Maple's exporter/processor to it; never create a second provider.
4. Existing GenAI auto-instrumentation on the model client (`@opentelemetry/instrumentation-openai`, `opentelemetry-instrumentation-openai-v2`, OpenLLMetry `Traceloop.init`, OpenInference `OpenAIInstrumentor`, `logfire.instrument_openai`). Pick one source of `chat` spans: either keep that instrumentation (then see `maple-agent-tracing-provider-sdks`) or remove it and write `chat` spans here. Both = every model call twice.
5. Find in the code: the agent loop (where one user message is handled), every model call site, every tool dispatch, sub-agent calls, and where the conversation/chat/thread id lives in the request.

## Step 1: Key and region

- US: `https://ingest.maple.dev`. EU: `https://ingest.eu.maple.dev`.
- Header: `Authorization=Bearer <key>`.
- Key given in the prompt → use it.
- No key → use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from Settings → Ingestion.
- Never put a private `maple_sk_` key in browser code.
- Follow the repo's secret/env convention if it has one. Otherwise inline is acceptable: ingest keys are write-only.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

The exporters append `/v1/traces`.

- The SDK exporters read these env vars when the exporter is constructed. If the app loads `.env` (dotenv, `load_dotenv()`, `--env-file`), load it at the top of the tracing module, before the provider is built; otherwise the exporter silently targets `localhost:4318` with no key.
- If the header is built from your own env var and it is unset, log one warning (`MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled`) and skip the Maple exporter so the app runs normally. Never throw or exit over the key, and never let it become `Bearer undefined` (opaque 401) or a bare `KeyError` on import. Or inline the key when the repo has no env convention.
- 401 `ingest_unauthorized` / "Invalid ingest key" with a key you trust: keys are region-bound, so it usually belongs to the other region. Try the other endpoint.

## Step 2: Install + init

Read the reference for the language and adapt it:
- TypeScript/Node: `references/typescript.md`
- Python: `references/python.md`
- Other languages: the language's OTel SDK with an OTLP/HTTP exporter, following the steps below.

Rules:
- Init module is imported first in every entry point. Set a real `service.name` and `deployment.environment.name`.
- Name the tracer after the app (e.g. `support-agent`). Never `openrouter`, `langsmith`, `litellm`, `haystack`, `ai`, `gen_ai`: Maple fingerprints frameworks by scope name and would treat your spans as that framework's.
- Keep the project's loop structure; add spans around its existing calls. Use the reference's complete loop only when there is no loop yet.

## Step 3: The three spans (exact keys)

`invoke_agent` (kind INTERNAL, name `invoke_agent <agent>`), around one agent run; for a user turn it is the trace root:
- `gen_ai.operation.name`=`invoke_agent`, `gen_ai.agent.name`, `gen_ai.conversation.id` (Step 4)
- optional: `gen_ai.input.messages` (the user message), `gen_ai.output.messages` (final answer)

`chat` (kind CLIENT, name `chat <model>`), around each model call:
- at start: `gen_ai.operation.name`=`chat` (or `generate_content`/`text_completion`), `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.system_instructions`, `gen_ai.input.messages`
- at end: `gen_ai.response.id`, `gen_ai.response.model`, `gen_ai.response.finish_reasons` (string array), `gen_ai.output.messages`, usage (Step 7), `gen_ai.response.time_to_first_chunk` (double, SECONDS, streamed calls)

`execute_tool` (kind INTERNAL, name `execute_tool <tool>`), around each tool call:
- `gen_ai.operation.name`=`execute_tool`, `gen_ai.tool.name` (real name), `gen_ai.tool.call.id` (the model's call id), `gen_ai.tool.type`=`function`
- `gen_ai.tool.call.arguments`: JSON string of an object
- `gen_ai.tool.call.result`: JSON string of the tool's return value; a string return can be set as its plain text.

Message JSON (`input.messages`/`output.messages`): array of `{role, parts}`; parts `{type:"text",content}`, `{type:"tool_call",id,name,arguments:<object>}`, `{type:"tool_call_response",id,response}`, `{type:"reasoning",content}`. Output messages add `finish_reason`. `system_instructions` = array of parts, no role: `[{"type":"text","content":"..."}]`. Always a JSON **string** attribute; plain-text messages don't render.

Also read: a message may carry `content` (string or part array) instead of `parts`. `gen_ai.response.model` wins over `gen_ai.request.model` when both are set.

Legacy spellings are read as fallbacks (use current names in new code): `gen_ai.system` (→ `gen_ai.provider.name`, renamed in semconv 1.37), `gen_ai.usage.prompt_tokens`/`completion_tokens`, whole-value `gen_ai.prompt`/`gen_ai.completion`, `gen_ai.usage.cache_creation.input_tokens` (→ `cache_write`), `gen_ai.usage.total_cost` (→ `cost`).

`provider.name` = the API actually called: `openai`, `anthropic`, `gcp.gemini`, `gcp.vertex_ai`, `aws.bedrock`, `azure.ai.openai`, `mistral_ai`, `groq`, `x_ai`, `deepseek`, or `openrouter` for OpenRouter.

## Step 4: Session id (required)

- The id is read only from spans that have `gen_ai.operation.name`; on an unclassified span it is ignored.
- Set `gen_ai.conversation.id` on the turn's `invoke_agent` span from the app's conversation/chat/thread id. Same value for every message of a conversation; different across conversations. One classified span per trace is enough; every span in the trace joins.
- Never: `uuid4()`/`randomUUID()` per request, the trace id, a module-level constant, a per-process default. No real id (single-shot script) → generate one per conversation, not per message, and reuse it.
- Sub-agents in the same trace: no id (they inherit the trace's session) or the same id. Two different ids in one trace → the lexically larger silently wins.
- Chat backends: one message list per conversation (keyed by that id, persisted), never one global list.

Escape hatch, only when a framework's spans carry a session key Maple ignores for that framework (LiteLLM, Haystack): wrap each turn in your own span with `gen_ai.operation.name`=`invoke_agent`, `gen_ai.agent.name`, and `maple_ai.session.id`=<conversation id>, and run the framework inside it. Rules:
- Only on your own wrapper span, never on framework spans (it re-vendors the span to `maple`: framework decoding lost, usage read as inclusive of cache).
- Use the same value the framework would use for the session.
- Not needed for hand-written spans: use `gen_ai.conversation.id`.
- The session then shows framework **Maple**.

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

## Step 5: Content

- Content = `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages` (chat), `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` (execute_tool). On span attributes only: span events, log records, and indexed keys (`gen_ai.prompt.0.content`, `llm.input_messages.0.*`) are not read.
- Do not set `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT` / `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT`; if the platform sets one, unset it. Truncated JSON is dropped whole. To cap size, drop the oldest messages whole before serializing.
- Replace base64 images/files in history with a placeholder part (ingest rejects requests > 20 MiB with 413).
- User wants no content → skip those five attributes (everything else still works; transcript empty). Wants redaction → redact inside `toSemconv`/`to_semconv` before serializing, or an OTel Collector `redaction`/`transform` processor.
- Never put API keys or `Authorization` headers in any attribute.

## Step 6: Tools, errors, sub-agents

- Tool failure: set status ERROR with the error message as description, set `error.type` (exception class or error code), no `gen_ai.tool.call.result`, then return the error to the model as the tool result so the loop continues. Keep the message specific: Maple's tool pages group failures by it.
- Maple counts any span as failed if it has status ERROR, a non-empty `error.type`, or `gen_ai.response.status`=`failed`.
- Tools that return `{"error": ...}` instead of raising: mark the span failed the same way when you detect it.
- Model call failure: status ERROR + `error.type` (HTTP status or exception class), rethrow.
- Agent run failure: same on `invoke_agent`.
- Sub-agent: call its loop inside the delegating tool's `execute_tool` span, so `execute_tool ask_x` → `invoke_agent x` → its `chat`/`execute_tool`. Distinct `gen_ai.agent.name` per agent (lanes need it).
- Delegation detection: an `execute_tool` span whose only child is an `invoke_agent` span is drawn as a delegation into a lane named after the child's `gen_ai.agent.name`; the tool's arguments/result become the lane's input/output. Two agents with the same name share one lane; an `invoke_agent` span without a name gets no lane.
- Parallel tools: start each `execute_tool` span inside the turn's context (Node `Promise.all` keeps it; Python threads need `contextvars.copy_context().run`).

## Step 7: Tokens and cost

- Usage on `chat` spans only, never cumulative totals on `invoke_agent`.
- Keys: `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`, `gen_ai.usage.reasoning.output_tokens` (ints). `total_tokens` is not read.
- Totals as the spec defines them: `input_tokens` = every prompt token, cache reads and writes included; `output_tokens` = every completion token, reasoning included. OpenAI, OpenRouter and Gemini's `promptTokenCount` already count that way. Anthropic's `input_tokens` excludes cache: send `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Gemini's `candidatesTokenCount` excludes thoughts: send `candidatesTokenCount + thoughtsTokenCount`.
- Streaming OpenAI-compatible: `stream_options: {include_usage: true}`. OpenAI sends usage in an extra last chunk with empty `choices`; OpenRouter always sends usage + `cost` on the chunk carrying `finish_reason`. Read `chunk.usage` before skipping chunks without choices.
- OpenRouter (Claude included): `prompt_tokens` already includes `cached_tokens` → provider `openrouter`, copy as is. Optional: `prompt_tokens_details.cache_write_tokens` → `gen_ai.usage.cache_write.input_tokens`.
- Cost: `gen_ai.usage.cost` (double, USD) on `chat` spans. OpenRouter returns `usage.cost` → copy it. Other providers return none → compute only if the project has a price table; otherwise leave it (Maple shows "unpriced"; it never prices tokens).
- `gen_ai.response.id` always (dedupes against gateway mirrors such as OpenRouter Broadcast).

## Step 8: Flush

- Node script/CLI: `await provider.shutdown()` in `finally`. Serverless: `await provider.forceFlush()` before returning (inside `waitUntil`/`after()` if available). Both reject when an export failed: add `.catch((err) => console.error("telemetry flush failed", err))` so a Maple outage can't crash the app. Long-running server: flush on `SIGTERM`, nothing per request.
- Python script: `provider.shutdown()` in `finally`. Lambda: `force_flush()` in `finally`. Notebooks/workers: `force_flush()` per cell/task.

## Step 9: Verify

If the app has no scriptable entry point (server, REPL, UI only), write a small driver for this run: one conversation id, 2+ turns, at least one tool call, flush before exit.

Run one real conversation: 2+ messages with the same id, one streamed reply if the app streams, one tool call, one failing tool if one exists, one sub-agent call if the app delegates; then a second conversation. Wait ~30 s; Maple → Agent Sessions, filter by service name. Check:

- [ ] One session per conversation; session id = the conversation id; second conversation = different session; no `trace:<id>` sessions.
- [ ] One turn per user message, labeled with it; transcript shows system instructions, user messages, assistant replies, tool calls and results.
- [ ] Spans `invoke_agent <agent>` → `chat <model>` / `execute_tool <tool>`, all in the turn's trace (no orphan roots).
- [ ] Every `chat` span: model, provider, response id, input+output tokens (streamed ones too), finish reasons; TTFT in seconds on streamed calls.
- [ ] Tool spans: real names, call ids matching the model's tool calls, JSON args and results.
- [ ] The failing tool is failed with its message; successful tools and model calls are not.
- [ ] Sub-agents: own lane with their `gen_ai.agent.name`, same session.
- [ ] Cost present only if spans carry `gen_ai.usage.cost`; else "unpriced".
- [ ] No attribute contains an API key, `Bearer `, `sk-or-`, `maple_sk_`.

With the Maple MCP: `list_agent_sessions` with `search=<conversation id>` returns one row.

Check without Maple access: the run exits with no export errors on stderr (`Failed to export`, `OTLPExporterError`, 401 lines) AND a temporary console exporter (`ConsoleSpanExporter` + `SimpleSpanProcessor`) shows the expected span tree with `gen_ai.conversation.id`, and every messages attribute parses with `JSON.parse`/`json.loads`. Silence alone proves nothing: no spans also looks silent.
