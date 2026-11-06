---
name: maple-agent-tracing-claude-agent-sdk
description: "Trace Claude Agent SDK agents (TypeScript and Python) and Claude Code CLI sessions with Maple: configure Claude Code's built-in OpenTelemetry so each conversation becomes one Maple Agent Session with prompts, model calls, tool calls and tokens. Triggers on 'trace my claude agent sdk agent', 'add Maple to claude agent sdk', 'agent sessions for claude code', 'OpenTelemetry for claude agent sdk', 'send my claude code sessions to Maple'."
---

# Maple agent tracing: Claude Agent SDK and Claude Code

## Goal

One conversation = one Maple Agent Session, one turn per user message, with the user prompts, every model call (model, tokens, TTFT), every tool call (name, args, result, failures).

How it works: the Agent SDK emits nothing itself. `query()` spawns the Claude Code CLI, which has OpenTelemetry built in and exports spans `claude_code.interaction` (turn), `claude_code.llm_request` (model call), `claude_code.tool` (tool call), with phase children `claude_code.tool.blocked_on_user` / `claude_code.tool.execution`. All configuration is environment variables for that child process. No instrumentation package, no TracerProvider.

Known gaps (tell the user, don't try to fix): assistant reply text and cost are only on OTLP log events, which Maple's session views don't read, so transcripts have no assistant text and sessions show "unpriced"; no `gen_ai.agent.name`, so sub-agents get no separate lanes; tool arguments shown only for Bash (command) and Read/Edit/Write (file path).

## Step 0: Detect

- Which surface:
  - TypeScript: `@anthropic-ai/claude-agent-sdk` in `package.json`. Need >= 0.3.283 (bundles Claude Code 2.1.283). Upgrade if older.
  - Python: `claude-agent-sdk` in `pyproject.toml` / `requirements*.txt`. Need >= 0.2.160 (bundles 2.1.283). Upgrade if older.
  - The user wants their own `claude` CLI / IDE / desktop sessions in Maple: go to Step 2c. Check `claude --version` >= 2.1.283.
  - Check for `pathToClaudeCodeExecutable` (TS) / `cli_path` (Py): a custom CLI binary must also be >= 2.1.283.
- Existing OpenTelemetry in the app: keep it. It can't carry the CLI's spans (the CLI exports on its own), but if the app has an active span when `query()` runs, both SDKs pass it as `TRACEPARENT` and the turn nests under it. Do not add a second SDK/exporter for the agent.
- Remove any hook-based instrumentor for the Agent SDK (OpenInference `openinference-instrumentation-claude-agent-sdk`, Langfuse/LangSmith/Opik wrappers) if the user agrees: it duplicates every model call and its spans don't group by session in Maple.
- Find where env is already set for the CLI: `options.env` / `ClaudeAgentOptions(env=...)`, Dockerfile, deploy manifests.
- Settings files beat `options.env`: when `settingSources` / `setting_sources` is omitted (all sources) or includes `user`/`project`, an `env` block in `~/.claude/settings.json` or the repo's `.claude/settings.json` overrides the same keys passed in `options.env` (verified with `OTEL_SERVICE_NAME`). If those files set `OTEL_*` / `CLAUDE_CODE_*` keys, tell the user; for server apps that don't need file settings, suggest `settingSources: []` (Py `setting_sources=[]`). Omitted `settingSources` also loads the developer's personal plugins and MCP servers into the agent and its telemetry.
- Find the conversation boundary: how the app calls `query()` per user message, and whether it stores a session id (`resume`, `sessionId`, `session_id`, `continue`, `ClaudeSDKClient`).

## Step 1: Key and region

- US endpoint `https://ingest.maple.dev`, EU endpoint `https://ingest.eu.maple.dev`. Header `Authorization=Bearer <key>`.
- Key in the user's prompt: use it. No key: use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from Settings → Ingestion.
- Private `maple_sk_` keys never go in browser code. Ingest keys are write-only.
- Follow the repo's existing secret/env convention (e.g. `MAPLE_INGEST_KEY` in `.env`). If there is none, inline the literal key; never ship a lookup that can come out `undefined` (`Bearer undefined` is an opaque 401).
- A 401 `ingest_unauthorized` ("Invalid ingest key") with a key you trust usually means the key belongs to the other region (keys are region-bound): try the other endpoint.

## Step 2a: TypeScript SDK

`npm install @anthropic-ai/claude-agent-sdk@latest zod`. Peers: zod ^4, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`; install them explicitly if the package manager doesn't.

`options.env` REPLACES the child environment. Always spread `process.env`, and drop inherited `TRACEPARENT`/`TRACESTATE`. Build the env when calling `query()`, not at import, so values loaded later (dotenv) are included. Create `maple-env.ts` (adapt service name and environment; with no env convention, replace the key lookup and the throw with the literal key):

```ts
let warnedNoKey = false

export function mapleEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env }
	delete env.TRACEPARENT
	delete env.TRACESTATE
	const key = process.env.MAPLE_INGEST_KEY
	if (!key) {
		// A missing key turns telemetry off; the agent still runs.
		if (!warnedNoKey) console.warn("MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled")
		warnedNoKey = true
		return env
	}
	return {
		...env,
		CLAUDE_CODE_ENABLE_TELEMETRY: "1",
		CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
		OTEL_TRACES_EXPORTER: "otlp",
		OTEL_LOGS_EXPORTER: "otlp",
		OTEL_METRICS_EXPORTER: "otlp",
		OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
		OTEL_EXPORTER_OTLP_ENDPOINT: "https://ingest.maple.dev",
		OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${key}`,
		OTEL_SERVICE_NAME: "support-agent",
		OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=production",
		OTEL_TRACES_EXPORT_INTERVAL: "1000",
		OTEL_LOGS_EXPORT_INTERVAL: "1000",
		OTEL_LOG_USER_PROMPTS: "1",
		OTEL_LOG_TOOL_DETAILS: "1",
		OTEL_LOG_TOOL_CONTENT: "1",
	}
}
```

Pass `env: mapleEnv()` on EVERY `query()` / `startup()` / session call in the codebase. If the call already sets `env`, merge rather than drop it: `env: { ...mapleEnv(), ...existing }`.

## Step 2b: Python SDK

`pip install -U claude-agent-sdk` (or the repo's tool: `uv add`, `poetry add`). Python >= 3.10.

`ClaudeAgentOptions.env` MERGES over the inherited env, so pass only telemetry vars; remove inherited trace context from `os.environ`. Build the env when calling `query()`, not at import, so values loaded later (dotenv) are included. Create `maple_env.py` (same adaptations):

```py
import logging
import os

os.environ.pop("TRACEPARENT", None)
os.environ.pop("TRACESTATE", None)

_warned_no_key = False


def maple_env() -> dict[str, str]:
    """Telemetry env for the Claude Code CLI, built per query()."""
    global _warned_no_key
    key = os.environ.get("MAPLE_INGEST_KEY")
    if not key:
        # A missing key turns telemetry off; the agent still runs.
        if not _warned_no_key:
            logging.getLogger(__name__).warning("MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled")
            _warned_no_key = True
        return {}
    return {
        "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
        "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
        "OTEL_TRACES_EXPORTER": "otlp",
        "OTEL_LOGS_EXPORTER": "otlp",
        "OTEL_METRICS_EXPORTER": "otlp",
        "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
        "OTEL_EXPORTER_OTLP_ENDPOINT": "https://ingest.maple.dev",
        "OTEL_EXPORTER_OTLP_HEADERS": f"Authorization=Bearer {key}",
        "OTEL_SERVICE_NAME": "support-agent",
        "OTEL_RESOURCE_ATTRIBUTES": "deployment.environment.name=production",
        "OTEL_TRACES_EXPORT_INTERVAL": "1000",
        "OTEL_LOGS_EXPORT_INTERVAL": "1000",
        "OTEL_LOG_USER_PROMPTS": "1",
        "OTEL_LOG_TOOL_DETAILS": "1",
        "OTEL_LOG_TOOL_CONTENT": "1",
    }
```

Import `maple_env` before the first `query()` / `ClaudeSDKClient` and pass `env=maple_env()` (merge with any existing `env` dict) on every `ClaudeAgentOptions`.

Alternative for both SDKs: set the same variables in the deployment environment (Dockerfile, k8s manifest) and omit `env`. Then make sure no `TRACEPARENT` is set there.

## Step 2c: Claude Code CLI (the user's own sessions)

Merge into `~/.claude/settings.json` (user settings; create if missing, keep existing keys):

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

- NOT the repo's `.claude/settings.json` / `.claude/settings.local.json`: Claude Code >= 2.1.282 ignores the vars there that turn export on, set the endpoint, or capture content (`CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_LOG_*`, ...).
- Existing `OTEL_*` keys in user settings, or managed settings / `~/.claude/remote-settings.json` setting endpoint or headers: stop and ask the user; managed values override the user's, and replacing them would redirect their company's telemetry.
- Tell the user to start a new `claude` session. The current session doesn't reload it.
- Service name is `claude-code` (terminal) or `claude-code-desktop` (desktop Code tab). Session grouping needs no setup: one `claude` session = one Maple session; `/clear` and `--fork-session` start new ones.

## Step 3: One session per conversation (SDK only)

Maple's session key for Claude Code is the `session.id` span attribute = the Claude session id. Every `query()` without `resume` starts a NEW session, so a chat backend calling `query()` once per message gets one Maple session per message unless it resumes.

- Store a UUID per conversation. First turn: `sessionId: uuid` (TS) / `session_id=uuid` (Py). Later turns: `resume: uuid` / `resume=uuid`. `sessionId`/`session_id` must be a valid UUID and can't be combined with `resume`.
- If the app already captures `session_id` from the init/result message and passes `resume`, keep it; that is correct.
- `ClaudeSDKClient` (Py) or a TS `query()` with an async-iterable prompt keeps one session for all its turns: nothing to do.
- Never set `forkSession` / `fork_session` on normal turns (new session id). Never set `OTEL_METRICS_INCLUDE_SESSION_ID=false` (removes `session.id` from spans).
- `resume` needs the transcript under `~/.claude/projects/` on the same host. Multi-host / serverless: tell the user about the `sessionStore` option; don't implement it unasked.
- Do not add `gen_ai.conversation.id` or `maple_ai.session.id`: you can't attribute the CLI's spans, and Maple reads `session.id` for this vendor.

TS pattern:

```ts
const firstTurn = !conversation.claudeSessionId
const sessionId = conversation.claudeSessionId ?? randomUUID()
conversation.claudeSessionId = sessionId // persist with the conversation
for await (const message of query({
	prompt: text,
	options: { env: mapleEnv(), ...(firstTurn ? { sessionId } : { resume: sessionId }) },
})) {
	if (message.type === "result") return message.subtype === "success" ? message.result : undefined
}
```

Python pattern:

```py
first_turn = "claude_session_id" not in conversation
session_id = conversation.setdefault("claude_session_id", str(uuid.uuid4()))
session = {"session_id": session_id} if first_turn else {"resume": session_id}
async for message in query(prompt=text, options=ClaudeAgentOptions(env=maple_env(), **session)):
    ...
```

## Step 4: Content

- `OTEL_LOG_USER_PROMPTS=1`: prompt in the `user_prompt` attribute of `claude_code.interaction` → turn titles + user messages. Without it: `<REDACTED>`, untitled turns.
- `OTEL_LOG_TOOL_DETAILS=1`: Bash `full_command`, Read/Edit/Write `file_path` → tool arguments; full error message on failed tools; `subagent_type`.
- `OTEL_LOG_TOOL_CONTENT=1`: `tool.output` span event → tool result (Read, Bash, Edit/Write with DETAILS; MCP/SDK tools, WebFetch, WebSearch on >= 2.1.283).
- Ask the user before enabling content in production if the repo shows compliance constraints (PII handling, HIPAA, etc.); content flags send file contents and command output. Offer to leave them off; the session still works (untitled turns, no args/results).
- Do NOT enable `ENABLE_BETA_TRACING_DETAILED` / `BETA_TRACING_ENDPOINT`: they redirect logs+traces and Maple doesn't read what they add.
- `OTEL_LOG_ASSISTANT_RESPONSES` only affects the `assistant_response` log event (not shown in session views). It defaults to `OTEL_LOG_USER_PROMPTS`; set `0` if prompts are approved and replies are not.

## Step 5: Tools, errors, sub-agents

- Nothing to add. Each `claude_code.tool` span is one tool call named by `tool_name` (`Bash`, `Read`, `mcp__<server>__<tool>`, `Agent`).
- Tool failures: SDK tool handlers must fail by throwing or returning `isError: true` (Py `"is_error": True`), not by returning an ordinary success result that says "error". Maple marks the call failed from `claude_code.tool.execution` `success=false` (`error.type` = `error_class`, result = the error).
- Sub-agents (`agents` option, `.claude/agents/`) run through the `Agent` tool; their spans nest under it in one trace. Maple shows no per-sub-agent lane (no `gen_ai.agent.name`). Don't try to fix it.
- Background sub-agents: Claude Code 2.1.283 may run `Agent` calls in the background even when the model doesn't ask for it (seen with SDK `agents` in string-prompt `query()`). Then the turn ends at once, every finished sub-agent starts a new turn whose prompt is a `<task-notification>` block, one `query()` yields several `result` messages, and SDK MCP tool calls inside those sub-agents can fail with "The tool call was interrupted before a result was received" (Maple counts them as failed tools). If the app uses `agents` and expects one answer per `query()`, add `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1"` to its env (verified: one turn, one trace, parallel sub-agents still overlap). Otherwise consume the iterator to its end, not to the first `result`.

## Step 6: Flush

- Keep `OTEL_TRACES_EXPORT_INTERVAL=1000` and `OTEL_LOGS_EXPORT_INTERVAL=1000`.
- Consume every `query()` loop to its `result` message (returning from the loop at `result`, as in Step 3, is fine: verified no span loss). Don't `break`, `close()`, or abort a query before that; it kills the CLI before its final export.
- Scripts / CLIs / one-shot jobs: after the last `query()` completes, wait ~5 s before the process exits (`await new Promise((r) => setTimeout(r, 5000))` / `await asyncio.sleep(5)`).
- Serverless: finish the loop before returning the response.

## Step 7: Verify

Run one conversation: two turns (the second resuming the first), one of which calls a tool. If the app has no scriptable entry point (server, UI only), write a small driver for this run: one conversation, 2+ turns, a tool call, the Step 6 wait before exit. Pre-approve the tool in the driver (`allowedTools: ["Bash"]` / `allowed_tools=["Bash"]`); otherwise the call waits in `blocked_on_user` and never runs. Use `MAPLE_TEST` only if no real key; with the sentinel nothing is stored, so ask the user to check in Maple once they have a key. To see export errors: add `CLAUDE_CODE_OTEL_DIAG_STDERR: "1"` to the env and a `stderr` callback (TS `options.stderr`, Py `ClaudeAgentOptions(stderr=...)`); no `[3P telemetry]` errors should appear. For the CLI: `claude --debug-file /tmp/claude.log`, then grep `3P telemetry`.

No `[3P telemetry]` errors is not proof of spans (no spans is silent too). Confirm in Maple, with the Maple MCP (`list_agent_sessions` with `search=<session id>` returns one row), or by pointing `OTEL_EXPORTER_OTLP_ENDPOINT` at a local OTLP listener once and checking `claude_code.interaction` / `claude_code.llm_request` spans arrive with `session.id`.

Then in Maple → Agent Sessions (`https://app.maple.dev/agent-sessions`, EU `app.eu.maple.dev`) check:

- Exactly one session for the conversation (not one per message), framework "Claude Agent SDK", service = `OTEL_SERVICE_NAME`.
- A second conversation run in the same process gets a different session.
- One turn per user message, titled with the prompt.
- LLM calls > 0 with a model name and input/output/cache tokens; TTFT present.
- Tool calls listed by real name (`mcp__<server>__<tool>`, `Bash`, ...), args for Bash/file tools, results when `OTEL_LOG_TOOL_CONTENT=1`.
- A tool that threw is marked failed; successful tools are not.
- Sub-agent model/tool calls appear under the `Agent` tool call in the same trace, and no turn is titled `<task-notification>` (if one is, see background sub-agents in Step 5).
- Expected and not bugs: cost "unpriced"; no assistant text; no sub-agent lanes.

If spans exist but the turn nests under an unrelated trace, an inherited `TRACEPARENT` survived: fix the env stripping.

## Reference notes (for explaining results to the user)

- Span map: `claude_code.interaction` = a turn titled with the prompt; `claude_code.llm_request` = model call (model, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `ttft_ms`, stop reason, failure); `claude_code.tool` = tool call; `claude_code.tool.blocked_on_user` / `claude_code.tool.execution` = phases shown in the trace, not counted as calls.
- Anthropic's `input_tokens` excludes both cache buckets; Maple counts it that way (total input = sum of the three). The CLI always streams and still records usage.
- Model id is shown as Claude Code sent it (e.g. `anthropic/claude-haiku-4.5` through OpenRouter).
- A failed model request (`success=false` on `claude_code.llm_request`, with `status_code` and `error`) counts as a failed LLM call. Without `OTEL_LOG_TOOL_DETAILS=1` a failed tool's error is only the `error_class` (`McpToolCallError` for SDK tools).
- A call rejected by the user or `canUseTool`: `blocked_on_user` span with `decision=reject` and no execution; Maple shows a call without a result, not a failure.
- An active app span is passed to the CLI as `TRACEPARENT` by both SDKs (the turn nests under the request that triggered it; that's desired). Interactive `claude` ignores inbound `TRACEPARENT`; only SDK and `claude -p` runs read it.
- Content truncation: 60 KB per attribute (`CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH`), `[TRUNCATED ...]` marker.
- Any Claude Code process signed in with a Claude account, including SDK child processes, carries `user.email`, `user.account_uuid` and `organization.id` on every span/event. To drop or mask attributes, route through an OpenTelemetry Collector with a `redaction` or `attributes` processor.
- Content never in session views: assistant replies (`assistant_response` log event), the system prompt, arguments of non-Bash/non-file tools (MCP and SDK tool args are only in the `tool_result` log event).
- Cost: only on the `claude_code.api_request` log event (`cost_usd`, with `session.id`) and the `claude_code.cost.usage` metric; both are Claude Code's client-side estimate at list price unless managed settings set `modelPricing`. In SDK apps, the result message's `total_cost_usd` is the same estimate per `query()`. With logs on, Logs has one `claude_code.user_prompt`, one `claude_code.api_request` per model call and one `claude_code.tool_result` per tool run.
- `/status` in `claude` lists telemetry variables it ignored (repo settings). 401s or data going elsewhere: managed settings or `~/.claude/remote-settings.json` set endpoint/headers and win; the user must ask whoever manages Claude Code.
- For `claude -p` in CI, set the same two export intervals.

## Do not

- Do not omit `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`: zero spans, while metrics/logs still flow and hide it.
- Do not leave `OTEL_EXPORTER_OTLP_PROTOCOL` unset or `grpc`: Claude Code has no default; Maple ingest is OTLP/HTTP.
