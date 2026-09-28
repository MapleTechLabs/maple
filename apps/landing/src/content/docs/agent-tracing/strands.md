---
title: "Trace Strands Agents with OpenTelemetry"
description: "Send Strands Agents traces to Maple with the prompt, reply and tool calls on every span, one session per conversation, and token counts that don't double."
group: "AI Agents"
order: 24
navLabel: "Strands Agents"
icon: "strands"
---

Strands Agents ships its own OpenTelemetry tracer. Every `agent(...)` call becomes one trace with an `invoke_agent` span, an `execute_event_loop_cycle` span per reasoning step, a `chat` span per model call and an `execute_tool` span per tool call. Maple recognizes these spans as Strands without any extra instrumentation library.

The catch is where Strands puts the conversation. By default, prompts, replies and tool results are written as span events, and Maple reads span attributes only, so the transcript comes out empty even though tokens and tool calls show up. One environment variable fixes it.

This guide covers the Python SDK (`strands-agents` 1.54 or newer, tested on 1.57.1) and notes where the TypeScript SDK (`@strands-agents/sdk` 1.19) differs.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-strands](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-strands) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for Strands Agents in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-strands -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Install Strands telemetry and export to Maple

The `otel` extra adds the OTLP/HTTP exporter. Add the extra for your model provider too (`openai`, `anthropic`, `litellm`; Bedrock needs none).

```bash
pip install 'strands-agents[otel,openai]>=1.57'
```

Configure the exporter and the content settings with environment variables:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_SERVICE_NAME="support-agent"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production"
export OTEL_SEMCONV_STABILITY_OPT_IN="gen_ai_latest_experimental,gen_ai_span_attributes_only,gen_ai_use_latest_invocation_tokens"
```

EU organizations use `https://ingest.eu.maple.dev`. The exporter appends `/v1/traces` itself, so set the base URL only.

The last line matters most. Each token does one job:

- `gen_ai_latest_experimental` switches Strands to the current GenAI conventions: messages as `gen_ai.input.messages` / `gen_ai.output.messages` in `{role, parts}` form, `gen_ai.system_instructions`, and tool arguments and results on `execute_tool` spans.
- `gen_ai_span_attributes_only` writes those messages as span attributes instead of span events. Without it, Maple shows tokens and tools but no transcript. It requires `strands-agents` 1.48 or newer.
- `gen_ai_use_latest_invocation_tokens` makes the `invoke_agent` span report this call's tokens instead of the agent's running total. See [Tokens and cost](#tokens-cost-and-the-agent-level-roll-up).

Strands reads this variable once, when the first `Agent` is created. Set it in the environment (shell, `.env`, container config), not in code that runs after an agent exists.

Then start the tracer once, before your first agent runs:

```py
# telemetry.py: import this from your entry point before creating any Agent
from strands.telemetry import StrandsTelemetry

telemetry = StrandsTelemetry().setup_otlp_exporter()
```

`StrandsTelemetry()` creates a `TracerProvider`, registers it globally and adds a `BatchSpanProcessor` with the stock OTLP/HTTP exporter, so all the standard `OTEL_EXPORTER_OTLP_*` variables apply.

If your app already sets up OpenTelemetry (a global `TracerProvider` from your web framework, `opentelemetry-instrument`, or the ADOT distro on AgentCore), skip `StrandsTelemetry()` entirely. Strands uses whatever global provider exists; add a `BatchSpanProcessor(OTLPSpanExporter(...))` pointing at Maple to that provider instead of creating a second one.

## Group turns into one session

Each `agent(...)` call is its own trace, and Strands has no built-in conversation id on its spans. Without one, Maple shows every message as a separate one-turn session named after its trace id.

Strands copies `trace_attributes` onto every span it creates for that agent. Maple reads `session.id` for Strands, so pass your conversation id there:

```py
from strands import Agent
from strands.models.openai import OpenAIModel
from strands.session.file_session_manager import FileSessionManager

model = OpenAIModel(model_id="gpt-4o-mini", params={"max_tokens": 600})


def handle_message(conversation_id: str, text: str) -> str:
    agent = Agent(
        name="support_agent",
        model=model,
        tools=[get_weather, calculate],
        system_prompt="You are a concise support assistant.",
        session_manager=FileSessionManager(session_id=conversation_id, storage_dir="./sessions"),
        trace_attributes={"session.id": conversation_id},
        callback_handler=None,
    )
    return str(agent(text))
```

This is the usual shape of a chat backend: one request per user message, history restored by the session manager (`FileSessionManager` here, `S3SessionManager` in production), and the same id used for history and for tracing. The session manager's `session_id` never reaches the spans on its own, so both arguments are needed.

A few things to get right:

- **Use the conversation id, not a per-request UUID.** A fresh id per call gives you one session per message again.
- **Don't share one module-level `Agent` across users.** Its `trace_attributes` would carry one user's id into everyone's traces. Create the agent per request, or per conversation.
- **Name every agent.** `name` becomes `gen_ai.agent.name`. Unnamed agents are all called `Strands Agents`, which merges sub-agents into one lane.

Only `session.id` groups sessions for Strands. `gen_ai.conversation.id` is ignored on Python Strands spans, so there is no need to add it.

## Record prompts, responses and tool calls

With the three opt-in tokens set, every span carries the conversation as JSON attributes:

| Span | What Maple reads |
|---|---|
| `invoke_agent <name>` | this turn's user message, the final reply, `gen_ai.system_instructions` |
| `chat` | the full message history sent to the model, the model's reply with `finish_reason`, the system prompt |
| `execute_tool <name>` | `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` (successful calls only) |

Maple builds the transcript from these, and labels each turn with the first line of the user's message.

Leaving out `gen_ai_span_attributes_only` is the most common reason for an empty transcript. The spans look complete in a trace viewer that renders events, and Maple still shows nothing.

### Privacy: redact or drop content

Content capture is on by default in Strands; there is no single off switch. Redaction is controlled by one more token in the same variable, `gen_ai_unredacted_attributes=`, followed by a `;`-separated allowlist. Anything not listed is replaced with `[REDACTED]`:

```bash
# Keep replies and tool results, redact user input and system prompts
export OTEL_SEMCONV_STABILITY_OPT_IN="gen_ai_latest_experimental,gen_ai_span_attributes_only,gen_ai_use_latest_invocation_tokens,gen_ai_unredacted_attributes=gen_ai.output.*;gen_ai.tool.call.result"

# Redact every message (empty allowlist)
export OTEL_SEMCONV_STABILITY_OPT_IN="gen_ai_latest_experimental,gen_ai_span_attributes_only,gen_ai_use_latest_invocation_tokens,gen_ai_unredacted_attributes="
```

The attributes covered are `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`. Only a single trailing `*` works as a wildcard. Redacted values aren't JSON, so Maple leaves those parts of the transcript blank; tokens, tools and errors are unaffected.

Tool descriptions and schemas (`gen_ai.tool.description`, `gen_ai.tool.json_schema`) and anything you put in `trace_attributes` are never redacted. Keep emails and customer names out of `trace_attributes`.

## Tools, errors and sub-agents

Every tool call gets an `execute_tool <tool name>` span with `gen_ai.tool.name`, `gen_ai.tool.call.id` and `gen_ai.tool.description`.

When a tool raises, Strands catches the exception, feeds the error back to the model, and marks the span failed: status `ERROR` with the exception message (for example `transport data service unavailable (503)`) and `gen_ai.tool.status=error`. Maple counts it as a failed tool call and groups it with other failures of the same message on the tool pages. A tool that returns `{"status": "error", ...}` itself is marked the same way. You don't need to add anything.

### Agents as tools

`agent.as_tool()` wraps a sub-agent so an orchestrator can call it. The trace nests the way Maple expects: `execute_tool weather_worker` with the sub-agent's `invoke_agent weather_worker` span inside it, which Maple shows as a delegation with its own lane.

```py
weather_worker = Agent(name="weather_worker", model=model, tools=[get_weather], callback_handler=None)
budget_worker = Agent(name="budget_worker", model=model, tools=[calculate], callback_handler=None)

orchestrator = Agent(
    name="orchestrator",
    model=model,
    tools=[
        weather_worker.as_tool(description="Weather for a city"),
        budget_worker.as_tool(description="Travel budget arithmetic"),
    ],
    trace_attributes={"session.id": conversation_id},
    callback_handler=None,
)
orchestrator("Produce a mini briefing about Amsterdam: weather and a 3-day budget.")
```

Only the orchestrator needs `session.id`. Maple groups sessions per trace, and the sub-agents run inside the orchestrator's trace. Strands runs tool calls from one model response concurrently by default, so parallel sub-agents appear as overlapping sibling spans.

### Graph and Swarm

`Graph` and `Swarm` open their own root span (`invoke_graph` / `invoke_swarm`) with each node's `invoke_agent` span beneath it. The root carries the multi-agent object's `trace_attributes`, not the agents'.

```py
from strands.multiagent import GraphBuilder, Swarm

swarm = Swarm([researcher, writer], trace_attributes={"session.id": conversation_id})

builder = GraphBuilder()
builder.add_node(researcher, "research")
builder.add_node(writer, "write")
builder.add_edge("research", "write")
graph = builder.build()
graph.trace_attributes = {"session.id": conversation_id}  # GraphBuilder has no setter for it
```

`GraphBuilder.build()` doesn't forward trace attributes, which is why the last line exists. Giving each node agent `trace_attributes={"session.id": ...}` works too, since one span per trace is enough.

The graph node id is not exported. Maple identifies each node by its agent's `name`, so name node agents after what they do.

### Human approval (interrupts)

An interrupt raised from a `BeforeToolCallEvent` hook ends the current trace, and the resumed call starts a new one. Both carry the agent's `session.id`, so they stay in one session. The interrupted tool appears twice, once ended early (status OK, no result) and once with the real outcome; both spans share the same `gen_ai.tool.call.id`. The tool body runs once, but Maple counts both spans as tool calls, so an approved call shows as two calls, one of them without a result.

## Tokens, cost and the agent-level roll-up

Each `chat` span reports `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`. Input includes cached tokens, which matches how Maple reads them. Since 1.54, prompt-cache hits and writes use the names Maple reads (`gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`). Older versions only emit `cache_read_input_tokens` / `cache_write_input_tokens`, which Maple ignores.

Strands streams every model call internally and reads usage from the stream's final event, so streamed turns report tokens too. The OpenAI model provider requests `stream_options.include_usage` automatically.

The `invoke_agent` span also carries usage, and this is where counts go wrong:

- **Without `gen_ai_use_latest_invocation_tokens`,** it reports the agent instance's lifetime total. On a long-lived agent, turn 8 reports the sum of turns 1 to 8, and any backend that sums spans over-counts by several times.
- **With it,** the span reports only this call's tokens, which Maple's detail page recognizes as a roll-up of the `chat` spans below and doesn't count twice.

A per-request agent (as in the session example above) never accumulates across turns, which is another reason to create agents per request.

One Maple issue remains even with a correct setup: the **Agent Sessions** list currently shows about twice the real tokens for Strands sessions, in Python and TypeScript. The list only recognizes a roll-up whose model calls sit directly below it, and Strands puts an `execute_event_loop_cycle` span in between. The session's own page shows the right totals, the sum of the `chat` spans.

Strands doesn't emit cost, so Maple shows sessions as unpriced. Maple never prices tokens itself.

More gaps: Strands records time to first token as `gen_ai.server.time_to_first_token` in milliseconds, which Maple doesn't read, and `chat` spans carry no `gen_ai.response.id`. The finish reason is only inside the output messages, so Maple's reply-length check shows as skipped. The missing response id means Maple can't recognize the same call reported twice, so don't also enable a gateway export such as OpenRouter Broadcast for the same traffic.

## Flush before short-lived processes exit

Spans go through a `BatchSpanProcessor`, which exports every few seconds. A long-running server needs nothing extra. Scripts, CLIs, notebooks and jobs lose their last spans unless they flush:

```py
from telemetry import telemetry

try:
    handle_message(conversation_id, "What's the weather in Berlin?")
finally:
    telemetry.tracer_provider.force_flush()
    telemetry.tracer_provider.shutdown()
```

On AWS Lambda, call `telemetry.tracer_provider.force_flush()` at the end of each invocation and don't call `shutdown()`, because the warm container reuses the provider.

A call cut off by `asyncio.wait_for` or task cancellation may export incomplete spans ([strands-agents/harness-sdk#3609](https://github.com/strands-agents/harness-sdk/issues/3609)). Ended spans still flush normally.

## TypeScript SDK differences

The TypeScript SDK emits the same span tree and honours the same `OTEL_SEMCONV_STABILITY_OPT_IN` tokens, except `gen_ai_use_latest_invocation_tokens`, which it doesn't support. Its OpenTelemetry packages are optional peer dependencies, so install them explicitly:

```bash
npm install @strands-agents/sdk @opentelemetry/api @opentelemetry/sdk-trace-base @opentelemetry/sdk-trace-node @opentelemetry/resources @opentelemetry/exporter-trace-otlp-http @opentelemetry/sdk-metrics @opentelemetry/exporter-metrics-otlp-http
```

Set `OTEL_SEMCONV_STABILITY_OPT_IN="gen_ai_latest_experimental,gen_ai_span_attributes_only"` and the same `OTEL_EXPORTER_OTLP_*` variables as above, then:

```ts
import { Agent, FileStorage, SessionManager } from "@strands-agents/sdk"
import { OpenAIModel } from "@strands-agents/sdk/models/openai"
import { setupTracer } from "@strands-agents/sdk/telemetry"

const provider = setupTracer({ exporters: { otlp: true } }) // reads OTEL_EXPORTER_OTLP_* env vars

const model = new OpenAIModel({ modelId: "gpt-4o-mini", params: { max_tokens: 600 } })

// One request per user message: build the agent, restore history, answer.
async function handleMessage(conversationId: string, text: string): Promise<string> {
	const agent = new Agent({
		name: "support_agent",
		model,
		tools: [getWeather],
		systemPrompt: "You are a concise support assistant.",
		traceAttributes: { "session.id": conversationId, "gen_ai.conversation.id": conversationId },
		sessionManager: new SessionManager({
			sessionId: conversationId,
			storage: { snapshot: new FileStorage("./sessions") },
		}),
		printer: false,
	})
	return String(await agent.invoke(text))
}

try {
	await handleMessage(conversationId, "What's the weather in Berlin?")
} finally {
	await provider.forceFlush()
	await provider.shutdown()
}
```

Set both keys in `traceAttributes`. The TypeScript SDK names its tracer and `gen_ai.provider.name` after `OTEL_SERVICE_NAME`, so with a custom service name Maple can't tell the spans come from Strands. It files them as generic GenAI spans, which group by `gen_ai.conversation.id`, and shows the framework as "Unidentified". Transcript, tools, failures and tokens still work. The TypeScript SDK writes `traceAttributes` on the `invoke_agent` span only, which is enough, since Maple groups sessions per trace.

Create the agent per request, as above. The TypeScript `invoke_agent` span always reports the agent instance's running total, so a long-lived agent reports turns 1 to N again on turn N and Maple's totals grow with every turn. A fresh agent per request, with history restored by `SessionManager`, reports only this turn.

The exporter sends OTLP/HTTP JSON, which Maple ingest accepts. `setupTracer()` only flushes on Node's `beforeExit`, which never fires after `process.exit()`, so flush explicitly as above. Failed `Graph` nodes currently end with status OK ([harness-sdk#4166](https://github.com/strands-agents/harness-sdk/issues/4166)); tool failures are marked correctly.

## Check that it works

Run one conversation of two or three messages, including one that calls a tool, then open **Agent Sessions** in Maple. Within a minute you should see:

- **One session per conversation id**, with the framework shown as Strands Agents and one turn per `agent(...)` call. A list of one-turn sessions means `session.id` is missing.
- **The transcript**: each user message, the assistant's replies and the tool calls with their arguments and results.
- **Spans named** `invoke_agent support_agent` (your agent's `name`), `execute_event_loop_cycle`, `chat` and `execute_tool get_weather`.
- **Tokens** on every model call, including streamed ones (the session page has the right total; the list currently shows about twice that), and the model id you passed (for example `gpt-4o-mini`, or a Bedrock id such as `us.anthropic.claude-sonnet-4-5-20250929-v1:0`).
- **Sub-agents** as separate lanes named after each agent, with failed tool calls counted under the tool's name.
- **Cost** shown as unpriced.

## Troubleshooting

- **Transcript is empty, but tokens and tools show up.** Content is still in span events. Add `gen_ai_span_attributes_only` (and `gen_ai_latest_experimental`) to `OTEL_SEMCONV_STABILITY_OPT_IN`, make sure it's set before the first `Agent` is created, and upgrade to 1.48 or newer.
- **Every message is its own session.** No `session.id` on the trace. Pass `trace_attributes={"session.id": conversation_id}` to the agent, or to the `Swarm` / `Graph` that runs it. Setting only the session manager's `session_id` isn't enough.
- **Two users' messages land in one session.** A shared `Agent` instance carries one `trace_attributes` dict for everyone. Create the agent per request.
- **Token totals look several times too high.** The `invoke_agent` span reports the agent's lifetime usage. Add `gen_ai_use_latest_invocation_tokens`, or create the agent per request. If only the sessions list shows about twice the session page's total, that's the known list issue from [Tokens, cost and the agent-level roll-up](#tokens-cost-and-the-agent-level-roll-up); trust the session page.
- **Cache tokens are zero with prompt caching on.** Versions before 1.54 use `cache_read_input_tokens`, which Maple doesn't read. Upgrade.
- **Every sub-agent is called "Strands Agents".** The agents have no `name`. Set `Agent(name=...)` on each one.
- **Graph session splits from the rest of the conversation.** `GraphBuilder.build()` drops trace attributes. Set `graph.trace_attributes` after building.
- **No model name on spans.** A custom `Model` subclass that only implements `get_config()` gets no `gen_ai.request.model` ([harness-sdk#4205](https://github.com/strands-agents/harness-sdk/issues/4205)). Give it a `config` dict with `model_id`.
- **Every model call appears twice.** Another instrumentation (OpenLIT, OpenLLMetry, OpenInference, an OpenAI or Bedrock GenAI instrumentor) is wrapping the same calls. Strands' own spans are enough; remove the other one.
- **Nothing arrives from a script.** The process exited before the batch exported. Call `force_flush()` and `shutdown()` in a `finally` block.
- **`401` from ingest.** The key is wrong or from the other region. The header must be written `Authorization=Bearer YOUR_INGEST_KEY` in `OTEL_EXPORTER_OTLP_HEADERS`.
- **TypeScript: framework shows "Unidentified" and sessions split.** Add `gen_ai.conversation.id` next to `session.id` in `traceAttributes`.
- **TypeScript: tokens grow with every turn.** A reused `Agent` reports its running total on `invoke_agent`. Create the agent per request and restore history with `SessionManager`.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [Agent tracing guides](/docs/agent-tracing)
- [Strands Agents traces documentation](https://strandsagents.com/docs/user-guide/observability-evaluation/traces/)
- [Strands telemetry tracer API reference](https://strandsagents.com/docs/api/python/strands.telemetry.tracer/)
