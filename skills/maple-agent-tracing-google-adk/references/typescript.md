# Google ADK for TypeScript (`@google/adk`)

Tested with `@google/adk` 2.1.0 (`@google/genai` 2.24.0), `@opentelemetry/sdk-node` 0.222.0 (trace SDK 2.11.0), `@opentelemetry/exporter-trace-otlp-proto` 0.222.0, `zod` 4.6.5, Node.js 26.0, TypeScript 7.0 `strict`.

## What ADK for TypeScript emits, and what is missing

Scope `gcp.vertex.agent` (Maple labels it **Google ADK**). One `runner.runAsync()` = one trace = one turn:

```text
invocation
└─ invoke_agent assistant          gen_ai.operation.name=invoke_agent, gen_ai.agent.name, gen_ai.conversation.id=<session id>
   ├─ call_llm                     gen_ai.request.model, gen_ai.usage.input_tokens/output_tokens, finish_reasons,
   │  │                            gcp.vertex.agent.session_id, gcp.vertex.agent.llm_request / llm_response (Gemini JSON)
   │  └─ execute_tool get_weather  gen_ai.operation.name=execute_tool, gen_ai.tool.name, gen_ai.tool.call.id,
   │                               gcp.vertex.agent.tool_call_args / tool_response (JSON)
   └─ call_llm
```

Gaps against what Maple reads:

- `call_llm` has no `gen_ai.operation.name`.
- No `gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions`. Content exists only as Gemini-shaped JSON in `gcp.vertex.agent.llm_request` (`{model, contents, config: {systemInstruction, tools}}`) and `gcp.vertex.agent.llm_response` (`{content, usageMetadata, finishReason}`), which Maple does not read. There is no `OTEL_SEMCONV_STABILITY_OPT_IN` switch in the TS package.
- `execute_tool` has no `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result`; they are in `gcp.vertex.agent.tool_call_args` / `tool_response`.
- A tool that throws, or a call to a tool that does not exist, leaves its `execute_tool` span with no attributes at all and status UNSET.
- Parallel calls add an `execute_tool (merged)` span (tool name `(merged tools)`) on top of the per-call spans.
- Usage: only `promptTokenCount` and `candidatesTokenCount`; thinking (`thoughtsTokenCount`) and cached (`cachedContentTokenCount`) tokens are dropped. No `gen_ai.provider.name`, no `gen_ai.response.model`, no `gen_ai.response.id`.

Why a span processor and not a plugin (the Python fix): ADK-TS runs `beforeToolCallback`/`afterToolCallback` outside the `execute_tool` span (only `tool.runAsync()` runs inside it), so a plugin cannot annotate the tool span. The processor rewrites ADK's own attributes when each span ends.

## Step 0: Detect

- `package.json`: `@google/adk`. Tested on 2.1; if older, upgrade to `^2.1` (confirm with the user if it is a major bump).
- How the agent runs:
  - Own `Runner` / `InMemoryRunner` in app code (server, worker, script): register the SDK below.
  - `npx adk web` / `npx adk api_server` (`@google/adk-devtools`): the CLI builds its own provider from `OTEL_EXPORTER_OTLP_*` (`maybeSetOtelProviders`) with no hook for this processor, so spans arrive without transcript or tool arguments. Treat the CLI as local dev only; tell the user and trace a `Runner` for production.
- Existing OpenTelemetry: grep `NodeSDK`, `NodeTracerProvider`, `registerOTel` (`@vercel/otel`), `Sentry.init`, `maybeSetOtelProviders`, `getGcpExporters`, `--require @opentelemetry/auto-instrumentations-node`. If one exists, add `spanProcessor` to it instead of starting a second SDK (see Step 2).
- Double instrumentation: any other GenAI instrumentation of `@google/genai` or of ADK in the same process doubles model calls. Ask before removing something another backend relies on.

## Step 1: Key and region

Same as SKILL.md Step 1. `OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"`.

A 401 `ingest_unauthorized` ("Invalid ingest key") with a key you trust usually means the key belongs to the other region (keys are region-bound): try the other endpoint.

## Step 2: Install and initialize

```bash
npm install @google/adk@^2.1 @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-proto
```

Add `zod` only if the app defines `FunctionTool` parameters with it and lacks it. Use the repo's package manager.

Env:

```bash
OTEL_SERVICE_NAME=<service-name>
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev        # EU: https://ingest.eu.maple.dev
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"
```

Leave `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` unset (default `true`): the processor reads those attributes. Do not set `OTEL_EXPORTER_OTLP_PROTOCOL`; the exporter class decides the protocol.

`instrumentation.ts` (typechecks under `strict`):

```ts
// instrumentation.ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { NodeSDK, tracing } from "@opentelemetry/sdk-node"

type Part = {
	text?: string
	thought?: boolean
	functionCall?: { id?: string; name?: string; args?: unknown }
	functionResponse?: { id?: string; response?: unknown }
}
type Content = { role?: string; parts?: Part[] }

const parse = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : {})

// Gemini content -> the GenAI message format Maple reads
const toParts = (parts: Part[] = []) =>
	parts.flatMap((part): object[] => {
		if (part.functionCall) {
			const { id, name, args } = part.functionCall
			return [{ type: "tool_call", id, name, arguments: args }]
		}
		if (part.functionResponse) {
			const { id, response } = part.functionResponse
			return [{ type: "tool_call_response", id, response }]
		}
		if (typeof part.text !== "string") return []
		return [{ type: part.thought ? "reasoning" : "text", content: part.text }]
	})

const toMessage = ({ role, parts }: Content) => ({
	role: parts?.some((part) => part.functionResponse) ? "tool" : role === "model" ? "assistant" : "user",
	parts: toParts(parts),
})

/** Copies what ADK records on its spans into the GenAI attributes Maple reads. */
class AdkSpanProcessor extends tracing.BatchSpanProcessor {
	override onEnd(span: tracing.ReadableSpan) {
		// ADK's summary of parallel tool calls, which are also traced one by one
		if (span.name === "execute_tool (merged)") return
		const attributes = span.attributes

		if (span.name === "call_llm") {
			const request = parse(attributes["gcp.vertex.agent.llm_request"])
			const response = parse(attributes["gcp.vertex.agent.llm_response"])
			const usage = response.usageMetadata ?? {}
			const system = request.config?.systemInstruction
			attributes["gen_ai.operation.name"] = "chat"
			attributes["gen_ai.provider.name"] = "gcp.gemini"
			if (usage.thoughtsTokenCount) {
				attributes["gen_ai.usage.reasoning.output_tokens"] = usage.thoughtsTokenCount
			}
			if (usage.cachedContentTokenCount) attributes["gen_ai.usage.cache_read.input_tokens"] = usage.cachedContentTokenCount
			if (request.contents) attributes["gen_ai.input.messages"] = JSON.stringify(request.contents.map(toMessage))
			if (response.content?.parts?.length) {
				const finish_reason = response.finishReason?.toLowerCase()
				attributes["gen_ai.output.messages"] = JSON.stringify([{ ...toMessage(response.content), finish_reason }])
			}
			if (system) {
				const parts = typeof system === "string" ? [{ type: "text", content: system }] : toParts(system.parts)
				attributes["gen_ai.system_instructions"] = JSON.stringify(parts)
			}
		} else if (span.name.startsWith("execute_tool ")) {
			if (attributes["gen_ai.operation.name"] === undefined) {
				// ADK leaves the span bare when the tool threw or doesn't exist
				attributes["gen_ai.operation.name"] = "execute_tool"
				attributes["gen_ai.tool.name"] = span.name.slice("execute_tool ".length)
				attributes["error.type"] = "tool_error"
			} else {
				const result = attributes["gcp.vertex.agent.tool_response"]
				attributes["gen_ai.tool.call.arguments"] = attributes["gcp.vertex.agent.tool_call_args"]
				attributes["gen_ai.tool.call.result"] = result
				if (parse(result).error) attributes["error.type"] = "tool_error"
			}
		}

		// ADK's own copies of the same content, which Maple doesn't read
		for (const key of ["llm_request", "llm_response", "tool_call_args", "tool_response"]) {
			delete attributes[`gcp.vertex.agent.${key}`]
		}
		super.onEnd(span)
	}
}

// Reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS
export const spanProcessor = new AdkSpanProcessor(new OTLPTraceExporter())

// Reads OTEL_SERVICE_NAME
export const sdk = new NodeSDK({ spanProcessors: [spanProcessor] })
sdk.start()
```

- Import it first in every entry point (`import "./instrumentation"`, or `node --import ./instrumentation.js`), before the first `runAsync()`.
- The exporter reads `OTEL_*` when `instrumentation.ts` is imported. If the app loads `.env` (dotenv, `--env-file`), load it at the top of `instrumentation.ts` (`import "dotenv/config"`) or pass `node --env-file=.env`; otherwise the exporter silently targets `localhost:4318` with no key.
- The processor mutates `span.attributes` in `onEnd`, after the span is read-only through the API. This works on trace SDK 2.x (the attributes object is plain and the exporter reads it afterwards); any processor listed after it sees the rewritten attributes.
- `NodeSDK({ spanProcessors })` disables the env-configured default exporter; that is intended. If the app already has a `NodeSDK`, add `spanProcessor` to its `spanProcessors` array (keeping the existing ones). With a `NodeTracerProvider`, pass it in `spanProcessors` at construction (SDK 2.x has no `addSpanProcessor`). Never register a second global provider.
- Vertex AI (`new Gemini({ vertexai: true, ... })`, `GOOGLE_GENAI_USE_ENTERPRISE`, or the older `GOOGLE_GENAI_USE_VERTEXAI`): change `gcp.gemini` to `gcp.vertex_ai`.
- A custom `BaseLlm` for a non-Gemini provider: ADK still records `usageMetadata` in Gemini format if the model fills it. Set `gen_ai.provider.name` to the real provider.
- Keep `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` from being set to `false` anywhere (Dockerfile, `.env`).

## Step 3: Session id

- `invoke_agent` carries `gen_ai.conversation.id = session.id`; `call_llm` carries `gcp.vertex.agent.session_id` (Maple's fallback session key for ADK). Maple groups on them.
- Every turn: `await sessionService.getOrCreateSession({ appName, userId, sessionId: conversationId })`, then `runner.runAsync({ userId, sessionId: conversationId, newMessage })`. There is no `autoCreateSession` in TS; `runAsync` throws `Session not found` for an unknown id.
- `appName` must match the runner's `appName`.
- Fix code that calls `createSession({ appName, userId })` without `sessionId` per request, or uses `runner.runEphemeral()` for a chat: both mint a random id per message (and the model loses history).
- Never use one constant session id for all users.
- `AgentTool` in TS runs the sub-agent under the parent's session id (with the sub-agent's name as `appName`), so it stays in the same Maple session (from the 2.1.0 source; not exercised in the test).

## Step 4: Content

- The processor derives `gen_ai.input.messages` (full history per call), `gen_ai.output.messages`, `gen_ai.system_instructions` (ADK prepends `You are an agent. Your internal name is "<name>".`) from ADK's JSON. Part mapping: `text` -> `text`, `text` with `thought: true` -> `reasoning`, `functionCall` -> `tool_call`, `functionResponse` -> `tool_call_response`; role `model` -> `assistant`, a `user` content holding function responses -> `tool`. `inlineData` (images, files) is stripped by ADK before recording.
- Tool call ids: the Gemini API returns calls without ids; ADK assigns `adk-<uuid>` ids after the response is recorded and strips them before the next request. So transcript `tool_call` / `tool_call_response` parts have no `id`, while the `execute_tool` span has `gen_ai.tool.call.id = adk-...`. Arguments and results for the tool list come from the `execute_tool` span.
- Streaming (`runConfig: { streamingMode: StreamingMode.SSE }`): ADK records the final aggregated response. When a streamed response is only a function call, that aggregate has no content, so that `call_llm` gets no output messages; the call is still on its `execute_tool` span and in the next call's input. Text replies and tokens are complete.
- No content wanted: set `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false` and delete the two `gen_ai.tool.call.*` assignment lines (otherwise they carry `{}`). Consequences: empty transcript, and thinking/cached tokens are lost too (they come from the response JSON). Input/output tokens, tool names and failures remain.

## Step 5: Tools, errors, sub-agents

- A tool that throws: ADK sends `{"error": "Error in tool '<name>': <message>"}` to the model and the run continues (Python aborts instead). The span is bare; the processor marks it `error.type=tool_error`. It has no arguments/result on the span; the error text is visible in the next `call_llm` input.
- Unknown tool name from the model: same handling, `{"error": "Function <name> is not found in the toolsDict."}`.
- A tool returning an object with a truthy `error` key is marked failed. `{status: "error", ...}` is not. If the repo uses that format, tell the user and offer `{ error: ... }` (changes what the model sees; confirm first).
- Span status stays UNSET on failures (status can't be set after end); Maple counts `error.type` on AI spans as a failure.
- Non-object results are wrapped by ADK as `{result: <value>}` (arrays as `{results: [...]}`), so `gen_ai.tool.call.result` is always a JSON object.
- Confirmation (`new FunctionTool({ ..., requireConfirmation: true })`): the first pass records `{"error": "This tool call requires confirmation, please approve or reject."}` on its span, which the processor marks failed; the approved call runs later in its own span. To count each call once, add `if (parse(attributes["gcp.vertex.agent.tool_response"]).error?.startsWith("This tool call requires confirmation")) return` at the top of the `execute_tool` branch (untested). A rejected call records `This tool call is rejected.` and counts as failed.
- Parallel calls: one `execute_tool` span per call (tested); the merged summary span is dropped.
- `execute_tool` spans are children of the `call_llm` that requested them, and `call_llm` stays open until those tools finish, so a model call's duration includes its tools' time. Expected; do not reparent.
- Every agent needs a distinct `name` (`gen_ai.agent.name`, Maple's lanes). `SequentialAgent` / `ParallelAgent` / `LoopAgent` need no changes.

## Step 6: Flush

- `sdk.shutdown()` rejects when an export failed; always add `.catch((err) => console.error("telemetry flush failed", err))` so a Maple outage can't crash the app.
- Scripts, CLIs, jobs, tests: `try { ... } finally { await sdk.shutdown().catch(...) }`.
- Servers: `process.on("SIGTERM", () => sdk.shutdown().catch(...))` (or the framework's shutdown hook); nothing per request.
- Serverless / CPU-frozen platforms (Cloud Run default, Cloud Functions, Lambda): `await spanProcessor.forceFlush()` before each response returns. Consume the whole `runAsync()` generator first.

## Step 7: Verify

Run one conversation of 2-3 turns with the same session id, one calling a tool, then flush. If the app has no scriptable entry point (server, `adk web`, UI only), write a small driver for this run: one session id, 2+ turns, a tool call, flush before exit. With a real key, check Agent Sessions (`https://app.maple.dev/agent-sessions`, EU `app.eu.maple.dev`), data within about a minute:

- [ ] One session, framework **Google ADK**, one turn per `runAsync()`; a second conversation is a separate session.
- [ ] Transcript: user messages, assistant replies, tool calls; tool calls list arguments and results.
- [ ] Every turn has LLM calls with non-zero input/output tokens; model = `gen_ai.request.model` (e.g. `gemini-2.5-flash`).
- [ ] No tool named `(merged tools)`; a throwing tool counts as an error.
- [ ] No duplicated model calls.
- [ ] Cost shows "unpriced" (expected).

With the Maple MCP: `list_agent_sessions` with `search=<session id>` returns one row.

Without Maple access (or with `MAPLE_TEST`), both must hold; silence alone proves nothing (no spans is silent too):
- Run with `OTEL_LOG_LEVEL=error` (`NodeSDK` then prints export failures): no `OTLPExporterError` / 401 lines on stderr.
- A console exporter shows the spans: temporarily set `spanProcessors: [spanProcessor, new tracing.SimpleSpanProcessor(new tracing.ConsoleSpanExporter())]` (the console processor must come after, so it prints rewritten attributes), run one turn, and confirm `call_llm` has `gen_ai.operation.name=chat`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.usage.input_tokens`; `invoke_agent` has `gen_ai.conversation.id`; `execute_tool` has `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`; no `gcp.vertex.agent.llm_request`. Remove the console processor afterwards.

Tell the user the known gaps: cost unpriced; model is the requested id (no response model/id); transcript tool calls carry no ids; a streamed function-call response has no output message; `adk web`/`api_server` traces have no transcript.

## Do not

- Do not drop `call_llm` or `invocation` spans in the processor: their children lose their parent.
