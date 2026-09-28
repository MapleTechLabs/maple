---
title: "Trace Claude Agent SDK agents and Claude Code sessions with OpenTelemetry"
description: "Turn on the tracing Claude Code has built in, so each Agent SDK conversation or Claude Code session shows up in Maple as one Agent Session with its prompts, model calls, tool calls and tokens."
group: "AI Agents"
order: 14
navLabel: "Claude Agent SDK & Claude Code"
icon: "claude"
---

The Claude Agent SDK has no telemetry of its own. Every `query()` starts the Claude Code CLI as a child process, and the CLI has OpenTelemetry built in: a span per user turn (`claude_code.interaction`), per model request (`claude_code.llm_request`) and per tool call (`claude_code.tool`), plus log events and metrics. Maple recognizes these spans and turns them into Agent Sessions, so there is nothing to install besides the SDK. You configure it with environment variables, the same ones whether you run the TypeScript SDK, the Python SDK or `claude` in your terminal.

Tracing is the part that goes wrong. Spans are a beta behind `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, and without it the CLI exports metrics and logs and not a single span, so Agent Sessions stays empty while everything looks configured. The second surprise comes later: Claude's replies and the per-request cost are only on log events, which Maple's session views don't read, so sessions show the prompts and tool calls but no assistant text and no cost.

This guide covers `@anthropic-ai/claude-agent-sdk` 0.3.283 (TypeScript), `claude-agent-sdk` 0.2.160 (Python) and Claude Code 2.1.283, which both SDKs bundle.

## Quick setup with a coding agent

Copy this prompt into Claude Code, Codex, Cursor or another agent that can run shell commands. It installs the [maple-agent-tracing-claude-agent-sdk](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-claude-agent-sdk) skill, which contains every step of this guide.

```text
Set up Maple agent tracing for the Claude Agent SDK in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-claude-agent-sdk -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use your key from **Settings → Ingestion**. Without one, the agent uses a placeholder you can replace later. EU organizations should say EU region.

## Export Claude Code telemetry to Maple

Every setup below sets the same variables. What each one does:

- `CLAUDE_CODE_ENABLE_TELEMETRY=1` turns telemetry on. `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` turns on spans, which are what Agent Sessions are built from.
- `OTEL_TRACES_EXPORTER=otlp` sends the spans. The logs and metrics exporters are optional: they carry cost and Claude's replies, which you can search under **Logs** but which don't appear in the session views.
- `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` is required. Claude Code has no default protocol, and Maple ingest speaks OTLP over HTTP.
- `OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev` with `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer YOUR_INGEST_KEY`. The CLI appends `/v1/traces`, `/v1/logs` and `/v1/metrics` itself. EU organizations use `https://ingest.eu.maple.dev`.
- `OTEL_SERVICE_NAME` names the service. Without it every agent reports as `claude-code`.

Never set an exporter to `console` in an SDK app. The SDK reads the CLI's standard output as its message stream, and console telemetry corrupts it.

### TypeScript Agent SDK

```bash
npm install @anthropic-ai/claude-agent-sdk zod
```

In TypeScript, `options.env` **replaces** the child's environment instead of adding to it. Spread `process.env` so the CLI keeps `PATH` and `ANTHROPIC_API_KEY`, and drop any inherited trace context (see [Keep each turn in its own trace](#keep-each-turn-in-its-own-trace)):

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
	// Content, off by default. See "Record prompts and tool calls" below.
	OTEL_LOG_USER_PROMPTS: "1",
	OTEL_LOG_TOOL_DETAILS: "1",
	OTEL_LOG_TOOL_CONTENT: "1",
}
```

Pass it on every call:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk"
import { mapleEnv } from "./maple-env"

for await (const message of query({ prompt: "What changed in the last commit?", options: { env: mapleEnv } })) {
	if (message.type === "result") console.log(message.subtype === "success" ? message.result : message.subtype)
}
```

### Python Agent SDK

```bash
pip install claude-agent-sdk
```

In Python, `ClaudeAgentOptions.env` is merged on top of the inherited environment, so pass only the telemetry variables. Because it merges, removing an inherited `TRACEPARENT` has to happen on `os.environ`:

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
    # Content, off by default. See "Record prompts and tool calls" below.
    "OTEL_LOG_USER_PROMPTS": "1",
    "OTEL_LOG_TOOL_DETAILS": "1",
    "OTEL_LOG_TOOL_CONTENT": "1",
}
```

```py
import asyncio
from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query
from maple_env import MAPLE_ENV


async def main():
    async for message in query(
        prompt="What changed in the last commit?",
        options=ClaudeAgentOptions(env=MAPLE_ENV),
    ):
        if isinstance(message, ResultMessage):
            print(message.result)


asyncio.run(main())
```

Because the CLI inherits the process environment in both SDKs, you can also set these variables in your Dockerfile or deployment manifest and skip `env` entirely. That is what Anthropic recommends for production. You still need to make sure no `TRACEPARENT` is set there.

Settings files win over `env`. Unless you pass `settingSources` (Python `setting_sources`), the CLI loads `~/.claude/settings.json` and the project's `.claude/settings.json`, and an `env` block in either overrides the same variable in `options.env`. In our test, `OTEL_SERVICE_NAME` from user settings replaced the one the app passed. That matters on a developer machine that also sends its own Claude Code sessions to Maple. A server app that doesn't need file settings can pass `settingSources: []`.

### Claude Code in your terminal, IDE or the desktop app

To see your own Claude Code sessions in Maple, put the variables under `env` in `~/.claude/settings.json`:

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

Start a new `claude` session to pick it up. Terminal sessions report `service.name=claude-code`, and sessions from the desktop app's Code tab report `claude-code-desktop`.

It has to be your user settings, your shell, or managed settings. Since 2.1.282, Claude Code ignores the variables that turn export on, set the endpoint or capture content (`CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_LOG_*` and the like) in a repository's `.claude/settings.json` and `.claude/settings.local.json`, so a repo can't turn export on or pick where it goes. `/status` lists any it ignored. To roll this out to a team, put the same `env` block in [managed settings](https://code.claude.com/docs/en/managed-settings).

## Group turns into one session

Maple groups Claude Code spans by their `session.id` attribute, which the CLI puts on every span. One Claude Code session becomes one Maple session, with one turn per `claude_code.interaction` span. Each turn is its own trace.

In the terminal that needs no setup. `/clear` starts a new session, `claude --resume` and `--continue` keep the old one, and `--fork-session` starts a new one.

In the SDK, **every `query()` call starts a new session** unless you resume one. A chat backend that calls `query()` once per user message and doesn't resume shows every message in Maple as its own one-turn session, and the agent has no memory of the previous message either.

Store a session UUID with each conversation. Pass it as `sessionId` on the first turn, then as `resume` on every turn after that:

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

The session UUID is the Maple session id, so if your conversation ids are UUIDs you can use them directly and find a conversation in Maple by its own id.

A few things break this:

- `resume` reads the session's transcript from `~/.claude/projects/` on the machine that ran the earlier turns. If the next message can land on another host, mirror transcripts with the SDK's [`sessionStore`](https://code.claude.com/docs/en/agent-sdk/session-storage) option.
- `forkSession: true` (Python `fork_session=True`) gives the resumed conversation a new session id, so it becomes a new Maple session.
- `OTEL_METRICS_INCLUDE_SESSION_ID=false` removes `session.id` from spans too, and every turn becomes its own session.

A long-lived process that keeps one session open needs none of this: a TypeScript `query()` fed an async iterable of messages, or a Python `ClaudeSDKClient`, sends every turn in the same session.

Adding `gen_ai.conversation.id` or `maple_ai.session.id` doesn't help here. You can't add attributes to the CLI's spans, and Maple reads `session.id` for Claude Code.

### Keep each turn in its own trace

When your application has an active OpenTelemetry span, both SDKs pass its context to the CLI as `TRACEPARENT`, and each turn's `claude_code.interaction` span becomes a child of your span. That is useful: the agent turn shows up inside the HTTP request that triggered it.

An **inherited** `TRACEPARENT` is the problem. Claude Code sets one on every command its Bash tool runs, CI systems set them, and the SDK passes the environment through. If you ask Claude Code to run your agent script, every turn of your agent nests inside that Claude Code session's trace. The snippets above drop `TRACEPARENT` and `TRACESTATE` from the inherited environment, and the SDK still injects your own active span's context on top.

Interactive `claude` sessions ignore an inbound `TRACEPARENT`. Only SDK and `claude -p` runs read it.

## Record prompts and tool calls

Claude Code redacts content by default. Each flag adds one kind:

| Variable | What it adds to the spans | What you see in Maple |
| --- | --- | --- |
| `OTEL_LOG_USER_PROMPTS=1` | `user_prompt` on `claude_code.interaction` (otherwise `<REDACTED>`) | Turns titled with the prompt, and the user messages in the transcript |
| `OTEL_LOG_TOOL_DETAILS=1` | `full_command` for Bash, `file_path` for Read, Edit and Write, `subagent_type` for the Agent tool, and the full error message of a failed tool | The Bash command or file path as the tool call's arguments, and the real error on failed calls |
| `OTEL_LOG_TOOL_CONTENT=1` | A `tool.output` span event with what the tool returned | The tool call's result, for Read, Bash, Edit and Write (Edit and Write also need `OTEL_LOG_TOOL_DETAILS`), and from 2.1.283 for MCP tools, including your SDK tools, WebFetch and WebSearch |

Some content never reaches the session views, whatever you set:

- **Claude's replies.** They are only on the `assistant_response` log event (`OTEL_LOG_ASSISTANT_RESPONSES`, which follows `OTEL_LOG_USER_PROMPTS` when unset). With the logs exporter on, you can read them under **Logs**. The transcript shows the prompts and tool calls, not the answers.
- **The system prompt.**
- **Arguments of other tools.** Maple shows the Bash command and the file path. The arguments of MCP tools, including the ones you define with the SDK, are only in the `tool_result` log event.

Anthropic's detailed beta tracing (`ENABLE_BETA_TRACING_DETAILED` with `BETA_TRACING_ENDPOINT`) adds more content attributes to spans, but it also redirects your logs and traces to that endpoint, and Maple doesn't read the attributes it adds. Leave it off.

### Privacy

The flags are per category, so `OTEL_LOG_TOOL_CONTENT=1` sends whatever files Claude reads and whatever commands print, secrets included. Turn on only what your Maple organization is allowed to store. Content is truncated at 60 KB per attribute (`CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH`), with a `[TRUNCATED ...]` marker.

Terminal sessions signed in with a Claude account also carry `user.email` on every span and event. To drop or mask attributes before they leave your network, send the data through an OpenTelemetry Collector with a `redaction` or `attributes` processor and point the Collector at Maple.

The ingest key can only write telemetry, so it is safe in an environment variable or settings file. Keep private `maple_sk_` keys out of both.

## Tools, errors and sub-agents

Every `claude_code.tool` span is one tool call, named by its `tool_name`: `Bash`, `Read` and `Edit` for built-ins, `mcp__<server>__<tool>` for MCP tools and the ones you define with `createSdkMcpServer`, and `Agent` for a sub-agent. The two phases inside a tool call, `claude_code.tool.blocked_on_user` (the permission wait) and `claude_code.tool.execution` (the run), are shown in the trace but not counted as tool calls of their own.

A tool fails when its execution does. When a tool handler throws, or returns `isError: true`, the CLI marks `claude_code.tool.execution` with `success=false`, and Maple marks the tool call failed with `error.type` set to the CLI's `error_class` (`McpToolCallError` for SDK tools) and the error as its result. Without `OTEL_LOG_TOOL_DETAILS=1` the error is only that class name; with it, it is the full message your tool threw, such as `transport data service unavailable (503)`.

A call the user or `canUseTool` rejects has a `blocked_on_user` span with `decision=reject` and no execution. Maple shows it as a call without a result, not as a failure.

A failed model request (`success=false` on `claude_code.llm_request`, with `status_code` and `error`) counts as a failed LLM call.

Sub-agents, defined with the `agents` option or in `.claude/agents/`, run through the `Agent` tool. Their model and tool calls nest under that `Agent` tool call in the same trace, so a whole delegation is one turn, and parallel sub-agents show up as overlapping calls.

Claude Code can also run sub-agents in the background. In our tests, 2.1.283 did that for SDK `agents` even though the model never asked for it. The parent turn then ends right away, and each sub-agent that finishes starts a new turn in the same session, with a `<task-notification>` block as its prompt. Your `query()` loop receives one `result` per turn instead of one in total, and SDK tool calls made by background sub-agents failed with "The tool call was interrupted before a result was received", which Maple counts as failed tool calls. If your app expects one answer per `query()`, keep sub-agents in the foreground:

```ts
for await (const message of query({
	prompt,
	options: { agents, env: { ...mapleEnv, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" } },
})) {
	if (message.type === "result") console.log(message.subtype === "success" ? message.result : message.subtype)
}
```

With it, the whole delegation is one turn and one trace, and parallel sub-agents still run side by side.

What you don't get is a lane per sub-agent. Maple opens a lane for each distinct `gen_ai.agent.name`, and Claude Code puts no agent name on its spans, only an opaque `agent_id` and, with `OTEL_LOG_TOOL_DETAILS=1`, the `subagent_type` on the `Agent` call. The agent filter in Agent Sessions stays empty for Claude Code sessions for the same reason.

## Tokens and cost

Each `claude_code.llm_request` span carries `input_tokens`, `output_tokens`, `cache_read_tokens` and `cache_creation_tokens`, plus `ttft_ms` and the stop reason. Maple maps them to its token buckets and time to first token. Anthropic's `input_tokens` excludes both cache buckets, and Maple counts it that way, so total input is the sum of the three. The CLI always streams and still records usage, so there is no streaming gap to work around.

Claude Code reports the cache buckets on every call, even when they're zero. If your prompts are shorter than the model's minimum cacheable length (a short custom `systemPrompt` often is), nothing is cached and the session's **Prompt cache** check warns with a 0% hit rate. That warning is accurate, not a tracing problem.

Maple doesn't show cost for these sessions. Maple never prices tokens itself, and Claude Code puts cost only on the `api_request` log event (`cost_usd`) and the `claude_code.cost.usage` metric, never on a span. Sessions read as **unpriced**.

To track spend anyway, keep the logs and metrics exporters on. The `claude_code.api_request` records are searchable under **Logs** with their `cost_usd` and `session.id`, and `claude_code.cost.usage` can go on a dashboard. Both are Claude Code's client-side estimate at list price, unless your organization sets `modelPricing` in managed settings. In an SDK app, the result message's `total_cost_usd` is the same estimate for one `query()`.

## Flush short-lived processes

The CLI exports spans every 5 seconds and flushes when it exits cleanly, but that last flush has a short timeout. In the SDK, a `query()` with a string prompt starts a CLI process that exits when the turn ends, so every turn ends with that flush.

- Set `OTEL_TRACES_EXPORT_INTERVAL` and `OTEL_LOGS_EXPORT_INTERVAL` to `1000`, as in the snippets above, so most spans leave during the turn.
- Let the message loop run to the `result` message. Returning from the loop at `result`, as `reply()` does, is fine. Calling `close()` on a query, aborting it, or breaking out of the loop before that kills the CLI before it flushes.
- In a script, keep the process alive for about 5 seconds after the last `query()` finishes, so the CLI's final export completes.
- On serverless platforms, finish the loop before you return the response. A frozen instance can't flush.
- For `claude -p` in CI, set the same two intervals.

## Check that it works

Run one conversation with two turns and at least one tool call, for example with the `reply()` function above. Then open **Agent Sessions** in Maple. You should see:

- **One session** for the conversation, with the framework shown as **Claude Agent SDK** (Claude Code sessions from the terminal show the same name) and your `OTEL_SERVICE_NAME` as the service.
- **One turn per message**, titled with the user's prompt.
- The model ID as Claude Code sent it (for example `anthropic/claude-haiku-4.5` when calling through OpenRouter), the LLM call count, and the four token buckets.
- The tool calls by name, with arguments and results as described in [Record prompts and tool calls](#record-prompts-and-tool-calls), and failed tools marked failed.
- Cost shown as **unpriced**, and no assistant text in the transcript. Both are expected, as explained above.

How the spans map:

| Claude Code span | In Agent Sessions |
| --- | --- |
| `claude_code.interaction` | A turn, titled with the prompt |
| `claude_code.llm_request` | A model call: model, tokens, time to first token, finish reason, failure |
| `claude_code.tool` | A tool call: name, arguments, result, failure |
| `claude_code.tool.blocked_on_user`, `claude_code.tool.execution` | Part of their tool call in the trace view, not calls of their own |

With the logs exporter on, **Logs** has one `claude_code.user_prompt`, one `claude_code.api_request` per model call and one `claude_code.tool_result` per tool run for the same `session.id`.

## Troubleshooting

- **Metrics and logs arrive, but no traces and no sessions.** `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` or `OTEL_TRACES_EXPORTER=otlp` is missing. Both are required for spans.
- **Nothing arrives at all.** `OTEL_EXPORTER_OTLP_PROTOCOL` is unset (there is no default) or set to `grpc`. Set `http/protobuf`. To see export errors, set `CLAUDE_CODE_OTEL_DIAG_STDERR=1` and read the SDK's `stderr` callback, or run `claude --debug-file /tmp/claude.log` and look for `[3P telemetry]` lines.
- **The CLI ignores your settings.** They are in the repository's `.claude/settings.json`, which Claude Code ignores for telemetry since 2.1.282. Move them to `~/.claude/settings.json` or your shell. `/status` lists what it ignored.
- **401 errors, or data going to another backend.** Managed settings, or an org-distributed `~/.claude/remote-settings.json`, set `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_HEADERS`, and managed values win over yours. Ask whoever manages Claude Code in your organization, or add Maple to the managed configuration.
- **Every message is its own one-turn session.** Each `query()` starts a new session. Resume the conversation's session id as in [Group turns into one session](#group-turns-into-one-session), and check that `forkSession` is off and `OTEL_METRICS_INCLUDE_SESSION_ID` isn't `false`.
- **Your agent's turns appear inside another trace.** The process inherited a `TRACEPARENT`, typically because Claude Code or CI started it. Drop `TRACEPARENT` and `TRACESTATE` from the environment you pass to the SDK.
- **TypeScript: the CLI fails to start or can't authenticate after adding `env`.** `options.env` replaced the whole environment. Spread `process.env` into it.
- **SDK output is garbled or `query()` throws a JSON parse error.** An exporter is set to `console`. Use `otlp` or `none`.
- **Turns are untitled and the transcript has no user messages.** `OTEL_LOG_USER_PROMPTS=1` is missing, so the prompt is `<REDACTED>`.
- **Your SDK tools have no results.** You need Claude Code 2.1.283 or later (Agent SDK 0.3.283 for TypeScript, 0.2.160 for Python) and `OTEL_LOG_TOOL_CONTENT=1`.
- **The last turn of a script is missing, or ends at a model call.** The process exited before the CLI's final export. See [Flush short-lived processes](#flush-short-lived-processes).
- **Extra turns titled `<task-notification>`, and sub-agent tool calls failed with "interrupted before a result was received".** Claude Code ran the sub-agents in the background. Set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` as in [Tools, errors and sub-agents](#tools-errors-and-sub-agents).
- **The service name, endpoint or content flags aren't the ones you passed in `env`.** An `env` block in `~/.claude/settings.json` or `.claude/settings.json` overrides `options.env`. Pass `settingSources: []`, or remove the keys from the settings file.
- **Every model call appears twice.** You also installed a hook-based instrumentor for the SDK, such as OpenInference's. Remove it; the CLI's own spans are the ones Maple groups by session.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview): what Maple builds from these spans.
- [Trace your AI agent](/docs/agent-tracing): guides for other frameworks.
- [Provider SDKs](/docs/agent-tracing/provider-sdks): tracing direct calls with the Anthropic SDK instead of the Agent SDK.
- Claude Code [Monitoring reference](https://code.claude.com/docs/en/monitoring-usage): every variable, span attribute and event.
- Agent SDK [Observability with OpenTelemetry](https://code.claude.com/docs/en/agent-sdk/observability).
