---
name: maple-agent-tracing-strands
description: "Trace Strands Agents (AWS, Python or TypeScript) with Maple: export Strands' built-in OpenTelemetry spans with messages on span attributes, a session id per conversation and per-call token counts, so each conversation is one Maple Agent Session with transcript, tool calls, sub-agent lanes and tokens. Triggers on 'trace my strands agent', 'add Maple to strands', 'agent sessions for strands', 'OpenTelemetry for strands agents'."
---

# Maple agent tracing: Strands Agents

Goal: every conversation = one Maple Agent Session. Each `agent(...)` / `invoke_async` / `stream_async` call = one turn (one trace) with transcript, `chat` spans with tokens, `execute_tool` spans with args/results, failed tools marked failed, sub-agents in their own lanes.

Mechanism: Strands' native OTel tracer (scope `strands.telemetry.tracer`, `gen_ai.provider.name=strands-agents`). No extra instrumentation package. Maple reads `session.id` (then `gen_ai.conversation.id`) as the session key, and reads span ATTRIBUTES only (never span events).

## Step 0: Detect

1. Language and version.
   - Python: `python -c "from importlib.metadata import version; print(version('strands-agents'))"` or read `pyproject.toml` / `uv.lock` / `requirements*.txt`. Need >= 1.51 (tested 1.57.1): span-attribute content needs 1.48, tool args/results 1.51. Older → upgrade; do not work around it.
   - TypeScript: `@strands-agents/sdk` in `package.json` (tested 1.19.0). Follow Step 2 TS.
2. Existing OTel setup. Search for `StrandsTelemetry(`, `TracerProvider(`, `set_tracer_provider`, `opentelemetry-instrument`, `aws-opentelemetry-distro`, `logfire.configure`, `sentry_sdk.init`, `setupTracer(`, `NodeSDK(`, `NodeTracerProvider(`.
   - `StrandsTelemetry().setup_otlp_exporter()` already present → reuse it; only change env vars.
   - Another global provider exists (web framework, `opentelemetry-instrument`, ADOT on AgentCore) → do NOT call `StrandsTelemetry()`. Add `BatchSpanProcessor(OTLPSpanExporter(endpoint=".../v1/traces", headers={...}))` to that provider. Strands uses the global provider automatically.
   - Nothing → Step 2.
3. Find: every `Agent(` construction (and whether it is module-level/shared), every place the agent is invoked, where the chat/thread/conversation id lives in the request, every `session_manager=`, every `.as_tool(`, `Swarm(`, `GraphBuilder(` / `Graph(`.
4. Other instrumentors on the same model calls (OpenLIT, OpenLLMetry `Traceloop.init`, OpenInference, `opentelemetry-instrumentation-openai*`, botocore/Bedrock GenAI instrumentation) → they double-trace model calls. Keep Strands' spans; ask before removing the others if they serve something else.

## Step 1: Key and region

- US: `https://ingest.maple.dev`. EU: `https://ingest.eu.maple.dev`.
- Header: `Authorization=Bearer <key>`.
- Key given in the prompt → use it.
- No key → use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from Settings → Ingestion.
- Never put a private `maple_sk_` key in browser code.
- Follow the repo's secret/env convention (`.env`, settings module, secret manager, container env) if it has one. Otherwise inline is acceptable: ingest keys are write-only.
- Key read from a secret env var in code: when it is unset, log one warning (`MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled`) and skip the Maple exporter so the app runs normally. Never raise, throw or exit over the key; no bare `KeyError` on import, no `Bearer undefined` (an opaque 401).

## Step 2: Install + init

Python. Add with the repo's package manager, keeping existing extras (`openai`, `anthropic`, `litellm`, ...):

```bash
pip install 'strands-agents[otel]>=1.57'
```

Env vars. Put them where the repo keeps env (shell/.env/container). `OTEL_SEMCONV_STABILITY_OPT_IN` MUST be in the process environment before the first `Agent(` is constructed (Strands reads it once, into a singleton). Setting it via `os.environ` is only acceptable at the very top of the entry point, before any strands import.

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=<service name>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=<env>
OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental,gen_ai_span_attributes_only
```

- Endpoint is the base URL; the exporter appends `/v1/traces`.
- The exporter reads these when it is built. If the app loads `.env` (`load_dotenv()`, `dotenv`, `--env-file`), load it at the top of the tracing module, before `StrandsTelemetry()` / `setupTracer()`; otherwise the exporter silently targets `localhost:4318` with no key.
- `gen_ai_latest_experimental`: `{role, parts}` messages, `gen_ai.system_instructions`, tool args/results.
- `gen_ai_span_attributes_only`: messages as span attributes. Without it the Maple transcript is EMPTY.
- If the repo already has an `OTEL_SEMCONV_STABILITY_OPT_IN` value, merge tokens (comma-separated), don't replace.

Init once, imported from the entry point before any agent runs (skip if Step 0 found an existing provider):

```py
# telemetry.py
from strands.telemetry import StrandsTelemetry

telemetry = StrandsTelemetry().setup_otlp_exporter()
```

TypeScript. OTel packages are optional peers; install them:

```bash
npm install @strands-agents/sdk @opentelemetry/api @opentelemetry/sdk-trace-base @opentelemetry/sdk-trace-node @opentelemetry/resources @opentelemetry/exporter-trace-otlp-http @opentelemetry/sdk-metrics @opentelemetry/exporter-metrics-otlp-http
```

Same env vars.

```ts
import { setupTracer } from "@strands-agents/sdk/telemetry"

export const provider = setupTracer({ exporters: { otlp: true } }) // before the first Agent; reads OTEL_EXPORTER_OTLP_*
```

## Step 3: Session id

Python: pass the conversation id as `session.id` in `trace_attributes` on the agent that handles the turn.

```py
agent = Agent(
    name="support_agent",
    model=model,
    tools=[...],
    session_manager=FileSessionManager(session_id=conversation_id, storage_dir="./sessions"),  # keep the repo's own manager
    trace_attributes={"session.id": conversation_id},
    callback_handler=None,
)
```

Rules:
- Use the app's existing chat/thread/conversation id. Never a per-request `uuid4()`, never a constant.
- A module-level / shared `Agent` must not carry a session id: construct the agent per request or per conversation (restore history with the repo's session manager). If the repo must keep a long-lived agent per conversation, construct it with that conversation's id.
- `session_manager=...(session_id=...)` does NOT put the id on spans. `trace_attributes` is still required.
- Keep any existing `trace_attributes` keys; add `session.id`. Don't add emails/names (never redacted).
- `Agent(name=...)` on every agent. Default name is `Strands Agents` for all agents, which collapses sub-agent lanes.
- Multi-agent roots:
  - Agents as tools: `session.id` on the orchestrator only is enough (one trace).
  - `Swarm([...], trace_attributes={"session.id": conversation_id})`.
  - Graph: `graph = builder.build()` then `graph.trace_attributes = {"session.id": conversation_id}` (`GraphBuilder` drops trace attributes).

TypeScript: same key, in `traceAttributes`.

```ts
import { Agent, FileStorage, SessionManager } from "@strands-agents/sdk"

const agent = new Agent({
	name: "support_agent",
	model,
	tools: [...],
	traceAttributes: { "session.id": conversationId },
	sessionManager: new SessionManager({ sessionId: conversationId, storage: { snapshot: new FileStorage("./sessions") } }), // keep the repo's own storage
})
```

- TS: same rule as Python: construct the agent per request or per conversation (restore history with the repo's `SessionManager` storage), never one shared agent across conversations.
- TS stamps `traceAttributes` on `invoke_agent` only (not chat/tool spans). That is enough.

## Step 4: Content

- Content capture is ON by default; Step 2's tokens only move it onto attributes. Nothing else to enable.
- Redaction, only if the user asks or the repo handles regulated data: append `gen_ai_unredacted_attributes=<allowlist>` to `OTEL_SEMCONV_STABILITY_OPT_IN`. `;`-separated, single trailing `*` only. Covered keys: `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`. Empty list (`gen_ai_unredacted_attributes=`) redacts all to `[REDACTED]`. Example keeping replies only: `...,gen_ai_unredacted_attributes=gen_ai.output.*;gen_ai.tool.call.result`.
- Not redactable: `gen_ai.tool.description`, `gen_ai.tool.json_schema`, `trace_attributes` values.
- Redacted values aren't JSON, so Maple leaves those transcript parts blank; tokens, tools and errors are unaffected.

## Step 5: Tools, errors, sub-agents

- Nothing to add for tool failures: a raising `@tool` (or one returning `{"status": "error"}`) gets span status ERROR with the exception message and `gen_ai.tool.status=error`. Do not catch exceptions inside tools just to return friendly text; that hides the failure unless you return `status: "error"`.
- Sub-agents: `sub.as_tool(description=...)` nests `invoke_agent <sub>` under `execute_tool <sub>`; Maple shows a delegation lane. Give each sub-agent a distinct `name`.
- Graph node ids are not exported; the agent `name` identifies the node.
- Interrupt/resume (HITL): the resume is a new trace in the same session (same `trace_attributes`). Interrupted tool spans appear twice with the same `gen_ai.tool.call.id` (first ends OK with no result, second has the real outcome); the Agent Sessions list counts both as tool calls. Expected, framework-level; do not try to filter spans.
- TS: failed Graph nodes end with status OK (upstream bug harness-sdk#4166). Tool failures are fine.

## Step 6: Flush

- Long-running server: nothing.
- Script / CLI / job / notebook / test: in `finally`:

```py
telemetry.tracer_provider.force_flush()
telemetry.tracer_provider.shutdown()
```

- Lambda: `force_flush()` at the end of each invocation, no `shutdown()`.
- Existing provider (Step 0): flush that provider instead.
- A call cut off by `asyncio.wait_for` or task cancellation may export incomplete spans (upstream harness-sdk#3609); ended spans still flush.
- TS: `await provider.forceFlush(); await provider.shutdown()` before exit. `setupTracer`'s own `beforeExit` flush does not run after `process.exit()`. Both reject when an export failed: add `.catch((err) => console.error("telemetry flush failed", err))` so a Maple outage can't crash the app. TS long-running server: flush on `SIGTERM`, nothing per request.

## Step 7: Verify

Run one short conversation (2-3 messages, one tool call; plus a failing tool if easy) with the real key and flush. If the app has no scriptable entry point (server, UI only), write a small driver for this run: one conversation id, 2+ turns, a tool call, flush before exit. Then check in Maple → Agent Sessions (`https://app.maple.dev/agent-sessions`, EU `app.eu.maple.dev`), or via the Maple MCP (`list_agent_sessions`, `get_agent_session`):

- Exactly one session per conversation id (not `trace:<id>` sessions); a second conversation gets a different session.
- Framework shows Strands Agents.
- One turn per agent call, with the user's message as the turn label.
- Transcript shows user messages, replies, tool calls with args and results. Empty transcript → `gen_ai_span_attributes_only` missing or set after the first `Agent(`.
- Spans: `invoke_agent <name>` → `execute_event_loop_cycle` → `chat` / `execute_tool <tool>`; model id on `chat` spans.
- Input/output tokens on every `chat` span, including streamed turns. Session total ≈ sum of `chat` spans.
- No time to first token in Maple: Strands emits `gen_ai.server.time_to_first_token` (ms), which Maple doesn't read. Expected.
- Failed tool counted as failed; successful tools not.
- Sub-agents in separate lanes with their own names.
- Cost shows "unpriced" (Strands emits no cost). Expected.
- No duplicate `chat` spans per model call.

Symptoms:
- No model name on spans: a custom `Model` subclass that only implements `get_config()` gets no `gen_ai.request.model` (harness-sdk#4205). Give it a `config` dict with `model_id`.
- `401` from ingest (`ingest_unauthorized`, "Invalid ingest key"): header must be `Authorization=Bearer <key>` in `OTEL_EXPORTER_OTLP_HEADERS`. With a key you trust, it usually belongs to the other region (keys are region-bound): try the other endpoint.
- TS: zero tokens on every `chat` span with an OpenAI-compatible gateway such as OpenRouter and `new OpenAIModel({ api: "chat", ... })`: the SDK reads usage only from stream chunks with empty `choices`. Use `api: "responses"`.

With the Maple MCP: `list_agent_sessions` with `search=<conversation id>` returns one row.

Without Maple access (or with `MAPLE_TEST`), both must hold; silence alone proves nothing (no spans is silent too):
- The run exits with no `Failed to export` / `OTLPExporterError` / 401 lines on stderr.
- A local exporter shows the spans: point `OTEL_EXPORTER_OTLP_ENDPOINT` at a local collector, or call `telemetry.setup_console_exporter()` once, and check a `chat` span has `gen_ai.input.messages` as an ATTRIBUTE (not in `events`) and `session.id`.

## Do not

- Do not also enable OpenRouter Broadcast (or another gateway trace export) for the same traffic: Strands `chat` spans have no `gen_ai.response.id`, so Maple can't dedupe and tokens double.
