---
name: maple-agent-tracing-provider-sdks
description: "Trace agents built directly on the OpenAI, Anthropic or Google Gen AI SDKs (Python or TypeScript, no agent framework) with Maple: official OTel GenAI instrumentations in Python, a small span helper in TypeScript, plus invoke_agent/execute_tool spans and gen_ai.conversation.id so each conversation is one Agent Session. Triggers on 'trace my openai agent', 'add Maple to my anthropic agent', 'agent sessions for gemini', 'OpenTelemetry for the openai sdk'."
---

# Maple agent tracing: OpenAI, Anthropic and Gemini SDKs

Goal: every conversation = one Maple Agent Session. Each user message = one turn = one trace rooted at an `invoke_agent <agent>` span, containing a `chat <model>` / `generate_content <model>` span per model call (transcript + tokens) and an `execute_tool <tool>` span per tool call (args, result, failures).

Mechanism:
- Python: OpenTelemetry GenAI instrumentations (`opentelemetry-instrumentation-genai-openai`, `-genai-anthropic`, `opentelemetry-instrumentation-google-genai`, all >= 1.2b0) write `chat` spans with GenAI semconv on span attributes.
- TypeScript: no usable instrumentation (`@opentelemetry/instrumentation-openai` only patches `openai` < 7 and puts messages in log events; nothing official for `@anthropic-ai/sdk` / `@google/genai`). Record the model call with the helper in `references/typescript.md`.
- Both: YOU add the `invoke_agent` span (with `gen_ai.conversation.id`) and `execute_tool` spans.

## Step 0: Detect

1. Confirm there is NO agent framework: `openai-agents`/`@openai/agents`, `langchain*`, `langgraph`, `pydantic-ai*`, `crewai`, `llama-index*`, `ai` (Vercel), `@mastra/core`, `google-adk`, `strands-agents`, `smolagents`, `agno`, `dspy`, `haystack-ai`, `agent-framework`, `litellm`. If one is present, stop and use that framework's skill (`npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing -y` routes). Instrumenting the provider SDK under a framework double-records every call.
2. Language and SDK versions:
   - Python >= 3.10. `openai` < 4 (tested 3.20.0), `anthropic` < 2 (tested 1.8.0), `google-genai` < 3 (tested 2.25.0). Outside these ranges the instrumentation won't patch: tell the user.
   - TypeScript: `openai` 7.x (tested 7.23.0). Anthropic / Gemini: adapt the helper (see reference).
3. Existing OTel setup. Search for `TracerProvider(`, `set_tracer_provider`, `NodeSDK(`, `NodeTracerProvider`, `registerOTel`, `opentelemetry-instrument`, `logfire.configure`, `sentry_sdk.init` / `Sentry.init`, `Traceloop.init`.
   - A provider exists → add a `BatchSpanProcessor(OTLPSpanExporter())` to it; do NOT create a second provider.
4. Other instrumentations of the same SDK → duplicate model-call spans. Look for: `opentelemetry-instrumentation-openai` / `-anthropic` (OpenLLMetry, NOT the official ones), `opentelemetry-instrumentation-openai-v2` (deprecated), `openinference-instrumentation-*`, `@arizeai/openinference-*`, `@traceloop/*`, `logfire.instrument_openai/anthropic`, Sentry OpenAI/Anthropic integrations, `langfuse.openai`. Keep exactly one; ask before removing one that serves something else.
5. Find: every model call site, the agent loop(s), the tool dispatch, where the conversation/thread id lives per request, any agent that calls another agent (sub-agent), any streaming call.

## Step 1: Key and region

- US: `https://ingest.maple.dev`. EU: `https://ingest.eu.maple.dev`.
- Header: `Authorization=Bearer <key>`.
- Key given in the prompt → use it.
- No key → use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from Settings → Ingestion.
- Never put a private `maple_sk_` key in browser code.
- Follow the repo's secret/env convention (`.env`, settings module, secret manager) if it has one. Otherwise inline is acceptable: ingest keys are write-only.

Env vars (the exporter reads them and appends `/v1/traces`):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY
```

- These are read when the exporter and helper are constructed. If the app loads `.env` (dotenv, `load_dotenv()`, `--env-file`), load it at the top of the init module, before the provider is built; otherwise the exporter silently targets `localhost:4318` with no key.
- Key read from an env var in code: when it is unset, log one warning (`MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled`) and skip the Maple exporter so the app runs normally. Never throw or exit over the key, and never let it become `Bearer undefined` (opaque 401) or a bare `KeyError` on import. Or inline the key when the repo has no env convention.

## Step 2: Install + init + helper

Read the reference for the service's language and apply it exactly:

- Python → `references/python.md` (install, `tracing.py`, `agent_tracing.py` helper, loop).
- TypeScript → `references/typescript.md` (install, `instrumentation.ts`, `agent-tracing.ts` helper incl. `tracedChat`, loop, Anthropic/Gemini mapping).

Rules for both:
- Init runs once at process start, before the first model call (Python: before the first request so the SDK classes are patched).
- Set a real `service.name` (never `unknown_service`).
- Do not set `OTEL_SEMCONV_STABILITY_OPT_IN`; the 1.x GenAI packages don't need it.

## Step 3: Session id (required)

- Wrap each user turn (the whole model/tool loop) in `agent_span(<agent_name>, conversation_id)` / `agentSpan(...)`. It sets `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name`, `gen_ai.conversation.id`.
- `conversation_id` = the app's stable conversation/thread/ticket id from the request. Same for every turn of one conversation, different across conversations. No `uuid4()` per request, no process-wide constant, no module-level default.
- No id in the app → ask the user where the conversation boundary is. Single-shot script: one uuid per conversation, reused for all its turns.
- Model and tool calls MUST happen inside the span (same trace). A streamed reply: keep the span open until the stream is consumed (in a web handler, inside the generator that writes the response).
- OpenAI Responses API with `conversation=`: the instrumentation also stamps `gen_ai.conversation.id=conv_...` on the model span. Pass that same id to `agent_span`.
- Do not add `session.id` or `maple_ai.session.id`: Maple reads `gen_ai.conversation.id` for these spans.

## Step 4: Content

- `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY` puts `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions` on span attributes. The helpers read the same variable for tool args/results (and, in TS, messages).
- Values: `NO_CONTENT` (default, empty transcript), `SPAN_ONLY` (use), `EVENT_ONLY` (logs only, Maple shows nothing), `SPAN_AND_EVENT` (also works; duplicates into logs). Legacy `true` = events: wrong.
- User wants content off → leave it unset in that environment; tell them the transcript will be empty but sessions, turns, tools, tokens and failures remain.
- Redaction → in app code before the call, or an OTel Collector `redaction`/`transform` processor. Never lower `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT` / `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT` (truncated JSON is dropped).

## Step 5: Tools, errors, sub-agents

1. Route every tool execution through `run_tool(call_id, name, arguments_json, fn)` / `runTool(...)`, passing the model's tool call id. It catches the exception, marks the span failed (status ERROR + `error.type` + recorded exception) and returns `{"error": ...}` to the model.
   - If the existing loop already catches tool exceptions, move the catch into `run_tool` (or set status + `error.type` where it catches). A caught, unmarked failure shows as success.
   - Anthropic: for each `tool_use` block → `run_tool(block.id, block.name, json.dumps(block.input), fn)`; return `tool_result` blocks.
   - Gemini with automatic function calling: the instrumentation records `execute_tool` spans itself; do NOT also wrap tools. With AFC disabled, use `run_tool` with `function_call.id` (or name if id is empty).
2. Sub-agent (an agent run inside a tool): call it via `run_tool`, and inside wrap its loop in `agent_span("<distinct_name>")` WITHOUT a conversation id (it's in the caller's trace). Every agent gets a unique `gen_ai.agent.name`; same names merge lanes.
3. Parallel tools: `asyncio.gather` / `Promise.all` keep context. `ThreadPoolExecutor`: submit `contextvars.copy_context().run(fn, ...)`, or tool spans become orphan traces.

## Step 6: Tokens, streaming, cost

- OpenAI Chat Completions streaming: ALWAYS pass `stream_options={"include_usage": True}` (Python) or use the helper's `onText` path (TS sets it). Otherwise the streamed call has 0 tokens. The final usage chunk has empty `choices`; skip it when reading text (`if chunk.choices`).
- Anthropic / Gemini streams include usage; nothing to add.
- No Python instrumentation emits cost; Maple doesn't price tokens → sessions show "unpriced". The TS helper copies OpenRouter's `usage.cost` (USD) to `gen_ai.usage.cost`; direct OpenAI sends none. Don't add pricing tables.
- Claude/Gemini models via OpenRouter's OpenAI-compatible endpoint with the `openai` SDK → spans say `gen_ai.provider.name=openai` with OpenAI-shaped usage. Correct; don't override it.

## Step 7: Flush

- Python: the provider flushes at normal interpreter exit. Add `provider.force_flush()` after each turn in Lambda/Cloud Functions/Cloud Run jobs, notebooks, Celery/RQ tasks, and anything ending in `os._exit`. Scripts/CLIs: `provider.shutdown()` in `finally`.
- TypeScript: `await sdk.shutdown()` before a CLI/script exits. Serverless: `await spanProcessor.forceFlush()` before returning (or in `waitUntil` after a streamed response). Both reject when an export failed: add `.catch((err) => console.error("telemetry flush failed", err))` so a Maple outage can't crash the app. Long-running server: flush on `SIGTERM`, nothing per request.

## Step 8: Verify

If the app has no scriptable entry point (server, REPL, UI only), write a small driver for this run: one conversation id, 2+ turns, at least one tool call, flush before exit.

Run one real conversation: 3+ user messages with the same id, one tool call, one streamed message if the app streams, one failing tool if you can trigger it, one sub-agent call if the app delegates; then a second conversation with a different id. Flush. In Maple → Agent Sessions (filter by service; allow ~30 s):

- [ ] Exactly one session per conversation, session id = the id you passed. The second conversation is a separate session. No `trace:<id>` sessions.
- [ ] Framework shows **Unidentified** (expected for this setup).
- [ ] One turn per user message; each turn's trace is rooted at `invoke_agent <agent>`, with all `chat`/`generate_content` and `execute_tool` spans inside it.
- [ ] Transcript shows user messages, assistant replies and tool calls (needs `SPAN_ONLY`).
- [ ] Every model call has input and output tokens, INCLUDING the streamed one.
- [ ] Each model call appears once (no duplicate sibling spans from a second instrumentation).
- [ ] Tool spans have the real tool name, call id, arguments and result.
- [ ] The failing tool is marked failed with its message; successful tools are not.
- [ ] Sub-agents appear as separate lanes under their own names, inside the caller's session.
- [ ] Cost shows "unpriced", except TS calls through OpenRouter (helper records `usage.cost`).
- [ ] No attribute contains an API key, `Bearer `, `sk-` or `maple_sk_`.

With the Maple MCP: `list_agent_sessions` with `search=<conversation id>` returns one row.

Check without Maple access: the run exits with no export errors on stderr (`Failed to export`, `OTLPExporterError`, 401 lines) AND a temporary console exporter (`SimpleSpanProcessor(ConsoleSpanExporter())`) shows the `invoke_agent` span with `gen_ai.conversation.id` and model spans with `gen_ai.input.messages` and `gen_ai.usage.*`. Silence alone proves nothing: no spans also looks silent.

## Known limitations (tell the user, don't work around)

- Framework facet shows "Unidentified".
- Python: no cost (unpriced).
- Anthropic instrumentation 1.2b0 records no time to first chunk for `messages.stream()`.
- Gemini path (Python instrumentation, TS mapping) not yet run end to end against a live model; OpenAI and Anthropic paths are verified.

## Troubleshooting

- Every model call its own session → call ran outside `agent_span`, or the span ended before the call (e.g. a stream consumed after it closed).
- One session per turn → conversation id changes per request.
- Empty transcript → capture unset, `EVENT_ONLY` or legacy `true`; set `SPAN_ONLY` in the process that makes the calls.
- No Python model spans → `.instrument()` ran after the first request, or the OpenLLMetry package (`opentelemetry-instrumentation-openai`) was installed instead of `-genai-openai`.
- Duplicate model spans → second instrumentation on the same SDK. `opentelemetry-instrument` loads every installed instrumentation package, so uninstall extras rather than just not calling them.
- Twin traces per call with OpenRouter → OpenRouter Broadcast also exports the calls; keep one source or nest Broadcast under the app's spans (https://maple.dev/docs/agent-tracing/openrouter#nest-broadcast-under-your-own-traces).
- Streamed turn has 0 tokens → missing `stream_options.include_usage`.
- Failing tool shown as success → exception caught outside `run_tool` without status/`error.type`.
- Sub-agent calls in the orchestrator's lane → same `gen_ai.agent.name`, or never wrapped.
- Exporter logs 401 (`ingest_unauthorized` / "Invalid ingest key") with a key you trust → keys are region-bound; it usually belongs to the other region. Try the other endpoint.
- OpenInference instead of the GenAI packages (Python): OpenAI shows as "OpenInference · OpenAI"; the Anthropic/Gemini OpenInference packages show as Unidentified. Prefer the `-genai-` packages.

## Do not

- Do not install `opentelemetry-instrumentation-openai` / `-anthropic` (OpenLLMetry) or the deprecated `-openai-v2`; install the `-genai-` packages.
