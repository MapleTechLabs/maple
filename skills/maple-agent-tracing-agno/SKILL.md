---
name: maple-agent-tracing-agno
description: "Trace Agno agents with Maple: installs the OpenInference Agno instrumentor with an OTLP exporter and GenAI attributes, and sets session_id per conversation so each chat is one Maple Agent Session with transcript, tool calls, team members, tokens and cost. Triggers on 'trace my agno agent', 'add Maple to agno', 'agent sessions for agno', 'OpenTelemetry for agno'."
---

# Maple agent tracing for Agno

Goal: every conversation with the Agno app shows up in Maple **Agent Sessions** as exactly one session, one turn per `run()`, with transcript, model calls, tool calls (failures marked), team-member lanes, tokens and cost where the provider returns it.

Human guide with the reasoning: https://maple.dev/docs/agent-tracing/agno

Mechanism: `openinference-instrumentation-agno` (the instrumentor Agno's own `setup_tracing()` uses) + OTel SDK + OTLP/HTTP exporter to Maple. Agno's `setup_tracing(db=...)` and `AgentOS(tracing=True)` only write to the AgentOS database; they never export OTLP.

## Step 0: Detect versions and existing setup

1. Find the Python project file (`pyproject.toml`, `requirements*.txt`, `uv.lock`, `poetry.lock`) and the installed `agno` version. Target `agno>=3.0` (verified 3.0.11). On Agno 2.x, `openinference-instrumentation-agno` needs `agno>=2.5.0`; the rest of this skill applies unchanged.
2. Grep for existing tracing: `TracerProvider(`, `set_tracer_provider`, `AgnoInstrumentor`, `setup_tracing(`, `tracing=True`, `phoenix.otel.register`, `openlit.init`, `logfire.configure`, `langfuse`, `OpenAIInstrumentor`, `LiteLLMInstrumentor`.
   - Existing `TracerProvider` of the app's own: reuse it. Add a `BatchSpanProcessor(OTLPSpanExporter(...))` for Maple to it. Do not create a second provider.
   - Existing `AgnoInstrumentor().instrument(...)`: edit that call (add `config=`); never call `instrument()` a second time (the second call is a silent no-op).
   - `AgentOS(tracing=True)` or `setup_tracing(db=...)`: see Step 2c.
   - Any other LLM instrumentor on the same calls (OpenAI/LiteLLM OpenInference instrumentors, OpenLIT, `register(auto_instrument=True)`): remove it or scope it away from Agno, or every model call is recorded twice.
3. Find every place an `Agent`, `Team` or `Workflow` is run: `.run(`, `.arun(`, `.print_response(`, `.aprint_response(`, `.continue_run(`, `.acontinue_run(`. Note where the conversation/thread id lives in the request.

## Step 1: Key and region

- US: `https://ingest.maple.dev`. EU: `https://ingest.eu.maple.dev`.
- Header: `Authorization=Bearer <key>`. Protocol `http/protobuf`.
- Key in the user's prompt: use it. No key: use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from **Settings → Ingestion**.
- Private `maple_sk_` keys never go in browser code. Agno runs server-side; a `maple_pk_` ingest key is write-only.
- Follow the repo's existing secret/env convention (`.env`, settings module, secret manager). If there is none, inline is acceptable because ingest keys are write-only.

## Step 2: Install and initialize

### 2a. Packages

Add to the project's dependency file with its package manager (uv/poetry/pip):

```
agno>=3.0
openinference-instrumentation-agno>=1.0.10
opentelemetry-sdk
opentelemetry-exporter-otlp-proto-http
```

`>=1.0.8` is required for human-in-the-loop `continue_run()` spans; `1.0.10` adds `llm.cost.total`. If the app uses `SqliteDb`/`AsyncSqliteDb` and imports fail with "requires ... 'greenlet'", add `greenlet` (and `aiosqlite` or `agno[sqlite]`).

### 2b. Environment

```bash
OTEL_SERVICE_NAME=<service name, e.g. support-agent>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=<env>
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev     # EU: https://ingest.eu.maple.dev
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <key>
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
AGNO_TELEMETRY=false
```

The exporter appends `/v1/traces` to `OTEL_EXPORTER_OTLP_ENDPOINT`. If you use `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` instead, give the full `.../v1/traces` URL. `AGNO_TELEMETRY=false` disables Agno's anonymous usage pings (unrelated to OTel).

### 2c. Tracing module

Create `tracing.py` (or add to the app's existing observability module):

```py
from openinference.instrumentation import TraceConfig
from openinference.instrumentation.agno import AgnoInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

provider = TracerProvider()  # resource from OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

AgnoInstrumentor().instrument(
    tracer_provider=provider,
    config=TraceConfig(enable_genai_semconv=True),
)
```

- `enable_genai_semconv=True` is REQUIRED. It dual-writes `gen_ai.*` (messages in `{role, parts}` form, usage, tool name/args/result, agent name, `gen_ai.operation.name`). Without it Maple's session detail page has no transcript for Agno. Env equivalent: `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` (use it when you can't edit the `instrument()` call, e.g. AgentOS owns it).
- Import `tracing` at the top of the entry point (`main.py`, `app.py`, the ASGI module), before building agents, teams or `AgentOS`.
- AgentOS: `AgentOS(tracing=True)` and `setup_tracing(db=...)` skip their setup when a real `TracerProvider` is already registered, so AgentOS's traces view stops getting spans once `tracing.py` runs first. If the user wants to keep that view, add Agno's DB exporter to the same provider (use the `db` the AgentOS uses):

  ```py
  from agno.tracing.exporter import DatabaseSpanExporter
  provider.add_span_processor(BatchSpanProcessor(DatabaseSpanExporter(db=db)))
  ```

  If `setup_tracing`/`tracing=True` must run first instead, don't create a provider: call `trace.get_tracer_provider().add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))` after it and set `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true` in the environment before the process starts.

## Step 3: Session id (one conversation = one session)

Maple groups Agno traces by `session.id` on the run span. Agno sets it from `session_id=`.

- Pass `session_id=<conversation id>` on EVERY `run`, `arun`, `print_response`, `aprint_response`, `continue_run`, `acontinue_run`, and on `team.run/arun` and `workflow.run/arun`. Use the id the app already stores for the chat/thread; pass `user_id=` too if available.
- Without `session_id=`, Agno mints a `uuid4()` on the first run and stores it on the `Agent`/`Team` instance; every later run of that instance reuses it. A module-level shared agent then merges all users into one session. Fix it; don't rely on the default.
- Do not mint a new id per request (every turn becomes its own session).
- Team members inherit the team's session id automatically. Do not pass a different id to members.
- Do not add `using_session()` or a custom span processor for the session; Agno's run span already carries it. Maple ignores `gen_ai.conversation.id` for Agno spans (it reads `session.id`).
- If the Agent has a `db`, `session_id` also selects the stored history: keep them the same id.

## Step 4: Content

- Content capture is ON by default in OpenInference. With Step 2c, prompts/replies land in `gen_ai.input.messages` / `gen_ai.output.messages` on span attributes. Nothing else to enable.
- If the user asks for no content / PII-sensitive: set before start `OPENINFERENCE_HIDE_INPUT_MESSAGES=true`, `OPENINFERENCE_HIDE_OUTPUT_MESSAGES=true`, `OPENINFERENCE_HIDE_INPUTS=true`, `OPENINFERENCE_HIDE_OUTPUTS=true`. Tell them the transcript will be empty but tokens/tools/failures remain, and that tool ARGUMENTS (`tool.parameters`, `gen_ai.tool.call.arguments`) are NOT masked by any of these variables; dropping them needs an OTel Collector `redaction`/`transform` processor.
- Tool results are recorded as `str(result)` (the same string Agno sends to the model). A tool returning a `dict`/`list` produces a Python repr (`{'city': 'Berlin'}`), which is not JSON, so Maple shows plain text. Recommend returning `json.dumps(...)` from structured tools; tell the user rather than silently changing tool return types.

## Step 5: Tools, errors, sub-agents

- Tool spans are named after the function and carry `gen_ai.tool.name`, arguments and result. A tool that RAISES gets status ERROR with the exception message; Maple counts it as failed. A tool that RETURNS an error string counts as success. If the user's tools swallow errors into strings, point this out; don't change behavior unasked.
- Give every `Agent` and `Team` a `name=` (distinct per member). Unnamed ones produce `Agent.run`/`Team.run` spans with no `gen_ai.agent.name`, and Maple can't draw a lane for them.
- Teams: one trace per team run. Member runs (`<member>.arun`) are children of the team run span, siblings of the leader's `delegate_task_to_member` tool spans (not nested inside them). Maple draws a lane per named member. Nothing to add.
- Team context leak (instrumentor 1.0.10): after `team.run()`/`team.arun()` returns, the team span stays attached to the thread/task, so any LATER agent run in the same thread/task nests into the finished team trace. Per-request tasks/copied contexts (FastAPI, Starlette) are unaffected. In scripts, loops, workers, CLIs and tests, isolate each team run:

  ```py
  result = await asyncio.create_task(team.arun(prompt, session_id=conversation_id))      # async
  result = contextvars.copy_context().run(team.run, prompt, session_id=conversation_id)  # sync
  ```

  Plain `Agent` runs (sync, async, streamed) do not leak.
- Human-in-the-loop (`@tool(requires_confirmation=True)` → `requirement.confirm()/reject()` → `agent.continue_run(run_id=..., requirements=..., session_id=...)`, agent needs a `db`):

  ```py
  response = agent.run(message, session_id=conversation_id)
  if response.is_paused:
      for requirement in response.active_requirements:
          requirement.confirm()  # or requirement.reject(note="...")
      response = agent.continue_run(
          run_id=response.run_id, requirements=response.requirements, session_id=conversation_id
      )
  ```

  The resumed run is its own trace with a `<agent>.continue_run` span carrying `session.id`, so it joins the session as a second turn. Needs instrumentor `>=1.0.8` and `session_id=` on `continue_run`.

## Step 6: Flush

- Long-running server (FastAPI, AgentOS): nothing to add; `TracerProvider` flushes at normal exit.
- Script / CLI / worker: wrap the entry point:

  ```py
  from tracing import provider
  try:
      main()
  finally:
      provider.force_flush()
      provider.shutdown()
  ```

- Took the `setup_tracing` path in Step 2c (no `provider` of your own): flush with `trace.get_tracer_provider().force_flush()`.
- Serverless handler (Lambda, Cloud Run jobs, etc.): `provider.force_flush()` before returning from EVERY invocation; never `shutdown()`.
- Notebook: `provider.force_flush()` after the cell that runs the agent.

## Step 7: Verify

Run one real conversation: 2-3 turns with the same `session_id` including one tool call, plus a second conversation with a different id. Flush. Wait ~1 minute. In Maple **Agent Sessions**, filtered by the service name (or via the Maple MCP `list_agent_sessions` + `get_agent_session`), check:

- [ ] Exactly one session per conversation id; none named `trace:<id>` (that means a run span had no `session.id`).
- [ ] The two conversations are two different sessions (not merged by a sticky auto id).
- [ ] Framework shows **Agno** (not Unidentified).
- [ ] One turn per `run()`/`arun()`; turn labels are the user messages.
- [ ] Transcript shows system prompt, user and assistant messages, tool calls. Empty transcript with non-zero tokens = `enable_genai_semconv` not active (check Step 2c, check `instrument()` isn't called elsewhere first).
- [ ] Model calls (`<ModelClass>.invoke|ainvoke|invoke_stream|ainvoke_stream`) show the model id and non-zero input/output tokens, including streamed turns.
- [ ] Each tool call appears once with its real name; a raised tool error is marked failed and nothing else is. Structured results render as JSON (not a Python repr).
- [ ] Teams: one lane per named member; the team run and all member spans are in one trace, same session; a run started after a team run is NOT inside the team's trace (else see Step 5 context leak).
- [ ] Cost shown in the Agent Sessions list if the provider returns it (OpenRouter does); otherwise "unpriced" is expected. The session detail page shows cost as not reported for Agno even then (it doesn't read `llm.cost.total` yet); tell the user, don't try to fix it.
- [ ] No span attribute contains the model provider API key or `Bearer`.

Raw span check (optional, e.g. with a console exporter in a scratch run): run spans `<agent_name>.run` have `session.id` + `gen_ai.operation.name=invoke_agent` + `gen_ai.agent.name`; model spans have `gen_ai.operation.name=chat`, `gen_ai.input.messages`, `gen_ai.usage.input_tokens`; tool spans have `gen_ai.operation.name=execute_tool`.

## Known behaviours (expected; explain if the user asks)

- If `setup_tracing()`/`AgentOS(tracing=True)` ran first, `set_tracer_provider` in `tracing.py` logs "Overriding of current TracerProvider is not allowed" and spans go only to the AgentOS database. A second `instrument()` call logs "Attempting to instrument while already instrumented" and its `config` is ignored.
- The instrumentor patches Agno's run functions and every model class in `agno.models`, so agents created after `tracing.py` runs are traced with no further changes.
- Without `enable_genai_semconv`, spans carry only OpenInference attributes (`llm.input_messages.0.message.content`, `llm.token_count.prompt`); the sessions list still shows tokens/models, the detail page doesn't decode them for Agno.
- With `enable_genai_semconv=True` the root span also carries `gen_ai.conversation.id` = `session.id`; Maple ignores it for Agno.
- Maple reads span attributes only; the instrumentor emits no span events or OTLP logs, so nothing else needs enabling. Masked values are replaced with `__REDACTED__` in-process before export.
- Team trace shape (one trace per team run): member runs sit directly under the leader's run, next to (not inside) the `delegate_task_to_member` tool spans; those show as ordinary tool calls on the leader with member id and task as arguments. With `team.arun()` in `coordinate` mode, members called in one step run concurrently and their spans overlap; sync `team.run()` runs them sequentially.
- Team context leak is upstream issue agno#5573. "Failed to detach context" in the logs after a streamed team run is agno#5208: log noise, spans still export.
- Human-in-the-loop: the paused run (`<agent>.run`) and the resumed run (`<agent>.continue_run`) are two traces and two turns in one session; the approved tool call appears once, in the second. Instrumentor <1.0.8 doesn't wrap `continue_run()`, so resumed runs appear as loose model/tool calls with no session.
- Tokens: every model span has input/output tokens plus cache read/write when the provider reports them; streamed runs record usage from the final chunk. The run span has no tokens, so nothing is double counted. Reasoning tokens aren't broken out. Maple links tool results to calls through the message history since tool spans lack `gen_ai.tool.call.id`, and can't show streaming latency (no TTFT).
- Cost: OpenRouter's price is recorded as `llm.cost.total` (USD, instrumentor >=1.0.10). Providers called directly (OpenAI, Anthropic) return no price, so sessions are unpriced.
- A tool that raises: Agno catches it and hands the message to the model; the tool span is `ERROR`, the run span stays OK. Maple groups repeated failures by the exception message.

## Do not

- Do not rely on `setup_tracing()` or `AgentOS(tracing=True)` to reach Maple; they only write to the database.
- Do not omit `TraceConfig(enable_genai_semconv=True)` / `OPENINFERENCE_ENABLE_GENAI_SEMCONV=true`.
- Do not call `AgnoInstrumentor().instrument()` twice or create a second `TracerProvider`.
- Do not stack another LLM instrumentor (OpenAI/LiteLLM OpenInference, OpenLIT, `auto_instrument=True`) on the same calls.
- Do not run agents without `session_id=` in a server; do not generate a fresh id per request.
- Do not put a different `session_id` on team members or resumed runs than on the conversation.
- Do not use `gen_ai.conversation.id` or `maple_ai.session.id` workarounds; `session.id` from Agno is what Maple reads (stamping `maple_ai.session.id` on Agno spans re-vendors them and loses decoding).
- Do not use a console/stdout exporter in production, and do not use `SimpleSpanProcessor` in servers (it exports synchronously on the request path).
- Do not skip the flush in scripts, notebooks, CLIs and serverless.
- Do not run an agent after a team run in the same thread/task without isolating the team run (Step 5).
- Do not expect `gen_ai.response.id`, `gen_ai.tool.call.id` on tool spans, TTFT or reasoning-token attributes from this instrumentor; they are not emitted and nothing needs fixing.
- Do not set `OTEL_SDK_DISABLED=true` (it turns off all tracing). `AGNO_TELEMETRY=false` only stops Agno's product analytics and is safe.

## Feedback on this skill

When a step in this skill was wrong, missing or misleading (or something worked noticeably well), send the Maple team feedback once you're done. Show the user what you'll send and send it only with their OK.

Keep it about the skill, never about the user's project:

- Include: `maple-agent-tracing-agno`, the step that failed, the framework and package versions, what you expected versus what happened, and the fix you used.
- Leave out: keys and tokens of any kind, hostnames, URLs, file paths, repo or service names, code from the project, prompts, model replies, span or log contents, and anything that identifies the user or their customers. Replace a value with a placeholder like `<redacted>` if the error message contains one.

Send it one way:

- **Maple MCP connected:** call `send_maple_feedback` with `kind` (`bug`, `documentation`, `improvement`, `feature_request`, `praise` or `other`), `summary` (one line), `reason` (what you were doing and what got in the way), optional `details`, `related_to: "maple-agent-tracing-agno"`, `agent_type: "coding_agent"` and your `agent_name` and `model`.
- **No MCP:** `POST https://api.maple.dev/v2/agent_feedback` (EU: `https://api.eu.maple.dev/v2/agent_feedback`) with `Authorization: Bearer <maple_ak_ API key>` and the same fields as JSON, the agent under `"agent": {"type": "coding_agent", "name": ..., "model": ...}`. The ingest key (`maple_pk_`) doesn't work here; ask the user for an API key from **Settings → API Keys**, and never write it to a file.
- **Neither available:** give the user the drafted feedback so they can send it themselves.
