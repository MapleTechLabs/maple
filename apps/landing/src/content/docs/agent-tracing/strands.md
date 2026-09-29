---
title: "Trace Strands Agents with OpenTelemetry"
description: "Send Strands Agents traces to Maple with the full transcript and one Agent Session per conversation."
group: "AI Agents"
order: 24
navLabel: "Strands Agents"
icon: "strands"
---

Strands Agents ships its own OpenTelemetry tracer: every `agent(...)` call becomes one trace with `invoke_agent`, `chat` and `execute_tool` spans. Maple recognizes them without an extra instrumentation library.

By default Strands writes prompts and replies as span events, which Maple doesn't read, so you set one environment variable to move them onto span attributes. You also pass your conversation id as `session.id` on each agent.

Tested with `strands-agents` 1.57.1 (1.54 or newer required) and the TypeScript SDK `@strands-agents/sdk` 1.19.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-strands](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-strands) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for Strands Agents in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-strands -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**.

## Install and configure the exporter

The `otel` extra adds the OTLP/HTTP exporter. Add the extra for your model provider too (`openai`, `anthropic`, `litellm`; Bedrock needs none).

```bash
pip install 'strands-agents[otel,openai]>=1.57'
```

Set these environment variables:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_SERVICE_NAME="support-agent"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production"
export OTEL_SEMCONV_STABILITY_OPT_IN="gen_ai_latest_experimental,gen_ai_span_attributes_only,gen_ai_use_latest_invocation_tokens"
```

For an EU organization, use `https://ingest.eu.maple.dev`. The exporter appends `/v1/traces` itself.

`OTEL_SEMCONV_STABILITY_OPT_IN` is the important one. Its three values switch to the current GenAI message format, write messages as span attributes (without this the transcript is empty), and make each `invoke_agent` span report only that call's tokens. Strands reads it once, when the first `Agent` is created, so set it in the environment rather than in code.

To redact message content, append `gen_ai_unredacted_attributes=` with a `;`-separated allowlist of attributes to keep; everything else becomes `[REDACTED]`.

Then start the tracer once, before your first agent runs:

```py
# telemetry.py: import this from your entry point before creating any Agent
from strands.telemetry import StrandsTelemetry

telemetry = StrandsTelemetry().setup_otlp_exporter()
```

If your app already sets up a global `TracerProvider` (your web framework, `opentelemetry-instrument`, or the ADOT distro on AgentCore), skip `StrandsTelemetry()`. Add a `BatchSpanProcessor(OTLPSpanExporter(...))` pointing at Maple to that provider instead.

## Pass the conversation id as session.id

Strands copies `trace_attributes` onto every span of the agent, and Maple groups Strands traces by `session.id`:

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

The session manager restores history but doesn't put its `session_id` on the spans, so you need both arguments. Use the conversation id your app already has, never a fresh UUID per request.

Create the agent per request, as above. A shared module-level `Agent` would carry one user's id into everyone's traces. Give every agent a `name`: unnamed agents are all called `Strands Agents`, which merges sub-agents into one lane.

With `agent.as_tool()` sub-agents, only the orchestrator needs `session.id`, because the sub-agents run inside its trace. For a `Swarm`, pass `trace_attributes={"session.id": conversation_id}` to the `Swarm`. For a `Graph`, set `graph.trace_attributes = {"session.id": conversation_id}` after `builder.build()`, which doesn't forward them.

## Flush in scripts and jobs

Spans are exported in batches every few seconds. A long-running server needs nothing extra. Scripts, CLIs, notebooks and jobs lose their last spans unless they flush:

```py
from telemetry import telemetry

try:
    handle_message(conversation_id, "What's the weather in Berlin?")
finally:
    telemetry.tracer_provider.force_flush()
    telemetry.tracer_provider.shutdown()
```

On AWS Lambda, call `telemetry.tracer_provider.force_flush()` at the end of each invocation and don't call `shutdown()`, because the warm container reuses the provider.

## TypeScript SDK

The TypeScript SDK emits the same spans. Its OpenTelemetry packages are optional peer dependencies, so install them explicitly:

```bash
npm install @strands-agents/sdk @opentelemetry/api @opentelemetry/sdk-trace-base @opentelemetry/sdk-trace-node @opentelemetry/resources @opentelemetry/exporter-trace-otlp-http @opentelemetry/sdk-metrics @opentelemetry/exporter-metrics-otlp-http
```

Use the same `OTEL_EXPORTER_OTLP_*` variables, with `OTEL_SEMCONV_STABILITY_OPT_IN="gen_ai_latest_experimental,gen_ai_span_attributes_only"` (the SDK doesn't support the third value). Then:

```ts
import { Agent, FileStorage, SessionManager } from "@strands-agents/sdk"
import { OpenAIModel } from "@strands-agents/sdk/models/openai"
import { setupTracer } from "@strands-agents/sdk/telemetry"

const provider = setupTracer({ exporters: { otlp: true } }) // reads OTEL_EXPORTER_OTLP_* env vars

const model = new OpenAIModel({ modelId: "gpt-4o-mini", params: { max_tokens: 600 } })

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

Set both keys in `traceAttributes`. With a custom service name, Maple can't tell the spans come from Strands and groups them by `gen_ai.conversation.id`, showing the framework as "Unidentified". Create the agent per request here too: a reused TypeScript agent reports its running token total on every turn.

## Check that it works

Run a conversation of two or three messages, including one that calls a tool, then open **Agent Sessions** in Maple. You should see one session per conversation id with framework **Strands Agents**, one turn per `agent(...)` call, and a transcript with the user messages, replies and tool calls.

Cost shows as unpriced, because Strands doesn't report it. The sessions list currently shows about twice the real token count for Strands; the session's own page has the correct total.

## Troubleshooting

- **Transcript is empty, but tokens and tools show up.** Add `gen_ai_span_attributes_only` and `gen_ai_latest_experimental` to `OTEL_SEMCONV_STABILITY_OPT_IN`, set before the first `Agent` is created.
- **Every message is its own session.** Pass `trace_attributes={"session.id": conversation_id}` to the agent, or to the `Swarm` or `Graph` that runs it.
- **Two users' messages land in one session.** A shared `Agent` carries one `trace_attributes` dict for everyone. Create the agent per request.
- **Every model call appears twice.** Another instrumentation (OpenLIT, OpenLLMetry, OpenInference, an OpenAI or Bedrock instrumentor) wraps the same calls. Remove it.
- **Nothing arrives from a script.** The process exited before the batch was exported. Call `force_flush()` and `shutdown()` in a `finally` block.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [Agent tracing guides](/docs/agent-tracing)
- [Strands Agents traces documentation](https://strandsagents.com/docs/user-guide/observability-evaluation/traces/)
- [Strands telemetry tracer API reference](https://strandsagents.com/docs/api/python/strands.telemetry.tracer/)
