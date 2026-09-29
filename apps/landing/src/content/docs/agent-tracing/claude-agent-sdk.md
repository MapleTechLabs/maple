---
title: "Trace Claude Agent SDK agents and Claude Code sessions with OpenTelemetry"
description: "Turn on Claude Code's built-in OpenTelemetry so each Agent SDK conversation or Claude Code session shows up in Maple as one Agent Session."
group: "AI Agents"
order: 14
navLabel: "Claude Agent SDK & Claude Code"
icon: "claude"
---

Every Agent SDK `query()` starts the Claude Code CLI as a child process, and the CLI exports OpenTelemetry spans for each turn, model request and tool call. You configure it with environment variables, the same ones for the TypeScript SDK, the Python SDK and `claude` in your terminal. There is nothing else to install.

Two things need care. Spans only exist with `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, and in the SDK every `query()` starts a new session unless you resume the conversation's session id.

Tested with `@anthropic-ai/claude-agent-sdk` 0.3.283 (TypeScript), `claude-agent-sdk` 0.2.160 (Python) and Claude Code 2.1.283.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-claude-agent-sdk](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-claude-agent-sdk) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for the Claude Agent SDK in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-claude-agent-sdk -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is under **Settings → Ingestion**. EU organizations should say EU region.

## Pass the telemetry variables to the CLI

Without `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` the CLI exports metrics and logs but no spans, and Agent Sessions stays empty. `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` is also required, because Claude Code has no default protocol. EU organizations use `https://ingest.eu.maple.dev`.

The snippets below also drop any inherited `TRACEPARENT`. Claude Code's Bash tool and most CI systems set one, and without this your agent's turns nest inside that outer trace.

Never set an exporter to `console` in an SDK app. The SDK reads the CLI's standard output as its message stream.

### TypeScript Agent SDK

```bash
npm install @anthropic-ai/claude-agent-sdk zod
```

In TypeScript, `options.env` replaces the child's environment, so spread `process.env` to keep `PATH` and `ANTHROPIC_API_KEY`:

```ts
// maple-env.ts
const inherited: Record<string, string | undefined> = { ...process.env }
delete inherited.TRACEPARENT
delete inherited.TRACESTATE

export const mapleEnv: Record<string, string | undefined> = {
	...inherited,
	CLAUDE_CODE_ENABLE_TELEMETRY: "1",
	CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1", // spans; without it there are none
	OTEL_TRACES_EXPORTER: "otlp",
	OTEL_LOGS_EXPORTER: "otlp", // optional: cost and replies, under Logs
	OTEL_METRICS_EXPORTER: "otlp", // optional: token and cost counters
	OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
	OTEL_EXPORTER_OTLP_ENDPOINT: "https://ingest.maple.dev",
	OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${process.env.MAPLE_INGEST_KEY}`,
	OTEL_SERVICE_NAME: "support-agent",
	OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=production",
	OTEL_TRACES_EXPORT_INTERVAL: "1000",
	OTEL_LOGS_EXPORT_INTERVAL: "1000",
	// Content, off by default. See "Choose what content to record" below.
	OTEL_LOG_USER_PROMPTS: "1",
	OTEL_LOG_TOOL_DETAILS: "1",
	OTEL_LOG_TOOL_CONTENT: "1",
}
```

### Python Agent SDK

```bash
pip install claude-agent-sdk
```

In Python, `ClaudeAgentOptions.env` is merged over the inherited environment, so pass only the telemetry variables and remove `TRACEPARENT` from `os.environ`:

```py
# maple_env.py
import os

os.environ.pop("TRACEPARENT", None)
os.environ.pop("TRACESTATE", None)

MAPLE_ENV = {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",  # spans; without it there are none
    "OTEL_TRACES_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",  # optional: cost and replies, under Logs
    "OTEL_METRICS_EXPORTER": "otlp",  # optional: token and cost counters
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://ingest.maple.dev",
    "OTEL_EXPORTER_OTLP_HEADERS": f"Authorization=Bearer {os.environ['MAPLE_INGEST_KEY']}",
    "OTEL_SERVICE_NAME": "support-agent",
    "OTEL_RESOURCE_ATTRIBUTES": "deployment.environment.name=production",
    "OTEL_TRACES_EXPORT_INTERVAL": "1000",
    "OTEL_LOGS_EXPORT_INTERVAL": "1000",
    # Content, off by default. See "Choose what content to record" below.
    "OTEL_LOG_USER_PROMPTS": "1",
    "OTEL_LOG_TOOL_DETAILS": "1",
    "OTEL_LOG_TOOL_CONTENT": "1",
}
```

Pass the env on every `query()` call, as in the next section. You can also set the same variables in your Dockerfile or deployment manifest and skip `env`, as long as no `TRACEPARENT` is set there.

An `env` block in `~/.claude/settings.json` or the project's `.claude/settings.json` overrides `options.env`. A server app that doesn't need settings files can pass `settingSources: []` (Python `setting_sources=[]`).

### Claude Code in your terminal, IDE or desktop app

Put the variables under `env` in `~/.claude/settings.json`, then start a new `claude` session:

```json
{
	"env": {
		"CLAUDE_CODE_ENABLE_TELEMETRY": "1",
		"CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
		"OTEL_TRACES_EXPORTER": "otlp",
		"OTEL_LOGS_EXPORTER": "otlp",
		"OTEL_METRICS_EXPORTER": "otlp",
		"OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
		"OTEL_EXPORTER_OTLP_ENDPOINT": "https://ingest.maple.dev",
		"OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer YOUR_INGEST_KEY",
		"OTEL_LOG_USER_PROMPTS": "1",
		"OTEL_LOG_TOOL_DETAILS": "1",
		"OTEL_LOG_TOOL_CONTENT": "1"
	}
}
```

Use your user settings, your shell or [managed settings](https://code.claude.com/docs/en/managed-settings). Since 2.1.282, Claude Code ignores these variables in a repository's `.claude/settings.json`. Terminal sessions report the service `claude-code`, and each `claude` session is one Maple session.

## Resume the session on every turn

Maple groups Claude Code spans by `session.id`, which is the Claude session id. A chat backend that calls `query()` once per message without resuming gets one Maple session per message, and the agent forgets the previous message.

Store a UUID with each conversation. Pass it as `sessionId` on the first turn and as `resume` on every turn after:

```ts
import { randomUUID } from "node:crypto"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { mapleEnv } from "./maple-env"

type Conversation = { claudeSessionId?: string }

export async function reply(conversation: Conversation, text: string) {
	const firstTurn = !conversation.claudeSessionId
	const sessionId = conversation.claudeSessionId ?? randomUUID()
	conversation.claudeSessionId = sessionId

	for await (const message of query({
		prompt: text,
		options: { env: mapleEnv, ...(firstTurn ? { sessionId } : { resume: sessionId }) },
	})) {
		if (message.type === "result") return message.subtype === "success" ? message.result : undefined
	}
}
```

```py
import uuid
from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query
from maple_env import MAPLE_ENV


async def reply(conversation: dict, text: str) -> str | None:
    first_turn = "claude_session_id" not in conversation
    session_id = conversation.setdefault("claude_session_id", str(uuid.uuid4()))
    session = {"session_id": session_id} if first_turn else {"resume": session_id}

    async for message in query(prompt=text, options=ClaudeAgentOptions(env=MAPLE_ENV, **session)):
        if isinstance(message, ResultMessage):
            return message.result
    return None
```

`resume` reads the transcript from `~/.claude/projects/` on the machine that ran the earlier turns. If the next message can land on another host, use the SDK's [`sessionStore`](https://code.claude.com/docs/en/agent-sdk/session-storage) option. A Python `ClaudeSDKClient`, or a TypeScript `query()` fed an async iterable, keeps one session for all its turns and needs none of this.

## Choose what content to record

Claude Code redacts content by default. `OTEL_LOG_USER_PROMPTS=1` records prompts, which title each turn. `OTEL_LOG_TOOL_DETAILS=1` records Bash commands, file paths and full tool error messages. `OTEL_LOG_TOOL_CONTENT=1` records what each tool returned.

`OTEL_LOG_TOOL_CONTENT=1` sends whatever files Claude reads and whatever commands print, secrets included. Turn on only what your Maple organization is allowed to store.

## Let each turn finish exporting

The CLI exits at the end of each turn, and its final flush has a short timeout. Let every `query()` loop reach its `result` message; breaking out early, calling `close()` or aborting kills the CLI before it flushes. In a script, keep the process alive about 5 seconds after the last `query()`. On serverless platforms, finish the loop before returning the response.

## Check that it works

Run a two-turn conversation through `reply()` with at least one tool call, then open **Agent Sessions**. You should see one session with the framework **Claude Agent SDK**, one turn per message titled with the prompt, model calls with their tokens, and the tool calls by name.

The transcript has no assistant replies and cost shows as unpriced. Claude Code puts both only on log events, which you can search under **Logs** when the logs exporter is on.

## Troubleshooting

- **Metrics and logs arrive, but no sessions.** Set `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` and `OTEL_TRACES_EXPORTER=otlp`.
- **Nothing arrives at all.** `OTEL_EXPORTER_OTLP_PROTOCOL` is unset or `grpc`. Set `http/protobuf`. `CLAUDE_CODE_OTEL_DIAG_STDERR=1` prints export errors to the SDK's `stderr` callback.
- **Every message is its own session.** Resume the conversation's session id as shown above, and don't set `forkSession`.
- **Your agent's turns appear inside another trace.** The process inherited a `TRACEPARENT`. Drop it and `TRACESTATE` from the environment.
- **The CLI ignores your values.** They are in a repository's `.claude/settings.json`, or a settings file overrides `options.env`. Use `~/.claude/settings.json`, or pass `settingSources: []`.
- **Extra turns titled `<task-notification>`.** Claude Code ran sub-agents in the background. Add `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1"` to the env.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview): what Maple builds from these spans.
- [Trace your AI agent](/docs/agent-tracing): guides for other frameworks.
- [Provider SDKs](/docs/agent-tracing/provider-sdks): tracing direct calls with the Anthropic SDK instead of the Agent SDK.
- Claude Code [Monitoring reference](https://code.claude.com/docs/en/monitoring-usage): every variable, span attribute and event.
- Agent SDK [Observability with OpenTelemetry](https://code.claude.com/docs/en/agent-sdk/observability).
