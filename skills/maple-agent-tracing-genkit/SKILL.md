---
name: maple-agent-tracing-genkit
description: "Trace Genkit (TypeScript/Node.js) agents with Maple: export Genkit's OpenTelemetry spans to Maple, map its genkit:* attributes to the GenAI conventions with a span processor, and stamp a conversation id so each chat is one Agent Session with transcript, tool calls and tokens. Covers flows, ai.generate, generateStream and beta defineAgent chats. Triggers on 'trace my genkit agent', 'add Maple to genkit', 'agent sessions for genkit', 'OpenTelemetry for genkit', 'firebase genkit tracing'."
---

# Maple agent tracing: Genkit

## Goal

One conversation = one Maple Agent Session, one turn per flow run, with the transcript, every model call (model, tokens) and every tool call (name, args, result, failures).

Span tree per flow run:

```text
supportChat            genkit:metadata:subtype=flow, genkit:isRoot=true  -> invoke_agent
└── generate           genkit:type=util (one nested generate per tool-loop step, left unmapped)
    ├── googleai/gemini-2.5-flash   subtype=model  -> chat
    ├── getWeather                  subtype=tool   -> execute_tool
    └── generate
        └── googleai/gemini-2.5-flash   subtype=model  -> chat
```

Beta agents (`ai.defineAgent()` / `defineCustomAgent` / `definePromptAgent` from `genkit/beta`): root span has subtype `agent` and `genkit:metadata:agent:sessionId` (Genkit's session id), which the processor uses as the conversation id. Under it: `runTurn-<n>` (flowStep), `render` (promptTemplate), `generate`, model, tool spans. One trace per `chat.send()`.

Known gaps (tell the user, don't try to fix): cost shows as unpriced; `gen_ai.provider.name` is the Genkit plugin prefix (`googleai`, `vertexai`, `openai`, `anthropic`...) rather than the semconv value (`gcp.gemini`...), which is only a label in Maple; media parts are left out of transcripts; `execute_tool` spans have no `gen_ai.tool.call.id` (Genkit doesn't put the call ref on the tool span; the transcript still pairs calls and results through the ids in the model messages when the model plugin sets `ref`).

## Step 0: Detect

- `genkit` version in `package.json` / lockfile: need `>= 1.22` (`disableGenkitOTelInitialization` was added in 1.22). Older: upgrade Genkit first. Node.js >= 20.
- Go or Python Genkit: stop; this skill covers TypeScript/JavaScript only. Tell the user.
- Existing OpenTelemetry: search for `NodeSDK`, `NodeTracerProvider`, `registerOTel`, `@vercel/otel`, `Sentry.init`, `enableTelemetry(`, `enableFirebaseTelemetry(`, `enableGoogleCloudTelemetry(`, `ENABLE_FIREBASE_MONITORING`.
  - An SDK/provider already exists: reuse it. Add `GenkitForMaple` and one Maple exporting processor to it. Never start a second SDK.
  - `enableTelemetry({...})` from `genkit/tracing` with custom processors: remove it. Genkit's `enableTelemetry` builds its own bundled `@opentelemetry/sdk-node` 0.52 / `sdk-trace-base` 1.25, and current (2.x) exporters crash inside it (`Cannot read properties of undefined (reading 'name')` on `instrumentationScope`). Don't pass Maple's exporter there.
  - `enableFirebaseTelemetry()` / `enableGoogleCloudTelemetry()` / `ENABLE_FIREBASE_MONITORING=true`: `disableGenkitOTelInitialization()` makes these no-ops (they go through `enableTelemetry`). Ask the user whether Google Cloud trace export may stop. If they need both, stop and tell them; don't wire two SDKs.
- Find every flow (`ai.defineFlow(`), direct `ai.generate(` / `ai.generateStream(` / `prompt(` call site, beta agents (`defineAgent(`, `.chat(`), and how the app deploys (plain Node server, Express `startFlowServer`/`expressHandler`, Next.js `@genkit-ai/next`, Cloud Functions for Firebase `onCallGenkit`, Cloud Run). Find each conversation's id (chat id, thread id, session row).

## Step 1: Key and region

- US endpoint `https://ingest.maple.dev`, EU endpoint `https://ingest.eu.maple.dev`. Header `Authorization=Bearer <key>`.
- Key in the user's prompt: use it. No key: use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from Settings → Ingestion.
- Private `maple_sk_` keys never go in browser code. Ingest keys are write-only.
- Follow the repo's existing secret/env convention (`.env`, Firebase `defineSecret`, Secret Manager). If there is none, inlining the ingest key is acceptable.
- A 401 `ingest_unauthorized` / "Invalid ingest key" with a key you trust usually means the key belongs to the other region (keys are region-bound): try the other endpoint.

## Step 2: Install

```bash
npm install genkit @opentelemetry/sdk-node @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-proto
```

Use the repo's package manager. `@opentelemetry/api` arrives as a peer; add it explicitly only if the package manager doesn't install peers. Env (or the repo's equivalent):

```bash
OTEL_SERVICE_NAME=support-agent
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.dev
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"
```

Inlining instead of env: `new OTLPTraceExporter({ url: "https://ingest.maple.dev/v1/traces", headers: { authorization: "Bearer <key>" } })` (the full `/v1/traces` path is needed when passing `url`).

- The app loads `.env` (`dotenv`, `--env-file`): load it at the top of `instrumentation.ts` (`import "dotenv/config"` as its first line) or run with `--env-file`. The exporter reads the `OTEL_*` vars when it is constructed; otherwise it silently targets `localhost:4318` with no key.
- Building the header from a variable (`Bearer ${process.env.MAPLE_INGEST_KEY}`): when it is unset, log one warning (`MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled`) and skip the Maple exporter so the app runs normally. Never throw over the key, and never let it become `Bearer undefined` (opaque 401).

## Step 3: The span processor

Create `genkit-for-maple.ts` next to the entry point, verbatim:

```ts
// genkit-for-maple.ts
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base"

type Part = {
	text?: string
	reasoning?: string
	toolRequest?: { name: string; ref?: string; input?: unknown }
	toolResponse?: { name: string; ref?: string; output?: unknown }
}
type Message = { role: string; content: Part[] }

// Genkit message parts to OpenTelemetry GenAI parts. Media parts are left out.
function toPart({ text, reasoning, toolRequest, toolResponse }: Part) {
	if (text !== undefined) return { type: "text", content: text }
	if (reasoning !== undefined) return { type: "reasoning", content: reasoning }
	if (toolRequest) {
		return { type: "tool_call", id: toolRequest.ref, name: toolRequest.name, arguments: toolRequest.input }
	}
	if (toolResponse) return { type: "tool_call_response", id: toolResponse.ref, response: toolResponse.output }
	return undefined
}

const toParts = (content: Part[]) => content.map(toPart).filter((part) => part !== undefined)

function toMessages(messages: Message[]) {
	return messages.map((m) => ({ role: m.role === "model" ? "assistant" : m.role, parts: toParts(m.content) }))
}

/** Adds the gen_ai.* attributes Maple reads to Genkit's flow, model and tool spans. */
export class GenkitForMaple implements SpanProcessor {
	onStart() {}

	onEnd(span: ReadableSpan) {
		const attrs = span.attributes
		const json = (key: string) => {
			const value = attrs[key]
			return typeof value === "string" ? JSON.parse(value) : undefined
		}
		const name = String(attrs["genkit:name"])

		switch (attrs["genkit:metadata:subtype"]) {
			case "flow":
			case "agent": {
				Object.assign(attrs, {
					"gen_ai.operation.name": "invoke_agent",
					"gen_ai.agent.name": name,
				})
				// Set in your flow, or by Genkit for defineAgent() chats
				const conversationId = attrs["genkit:metadata:conversationId"] ?? attrs["genkit:metadata:agent:sessionId"]
				if (conversationId !== undefined) attrs["gen_ai.conversation.id"] = conversationId
				break
			}
			case "model": {
				const input = json("genkit:input")
				const output = json("genkit:output")
				const [provider, ...model] = name.split("/")
				const messages: Message[] = input?.messages ?? []
				const system = messages.filter((m) => m.role === "system").flatMap((m) => toParts(m.content))
				Object.assign(attrs, {
					"gen_ai.operation.name": "chat",
					"gen_ai.provider.name": provider,
					"gen_ai.request.model": model.join("/") || name,
					"gen_ai.input.messages": JSON.stringify(toMessages(messages.filter((m) => m.role !== "system"))),
				})
				if (system.length > 0) attrs["gen_ai.system_instructions"] = JSON.stringify(system)
				if (output?.message) {
					attrs["gen_ai.output.messages"] = JSON.stringify(
						toMessages([output.message]).map((m) => ({ ...m, finish_reason: output.finishReason })),
					)
				}
				if (output?.finishReason) attrs["gen_ai.response.finish_reasons"] = [output.finishReason]
				if (output?.usage?.inputTokens !== undefined) attrs["gen_ai.usage.input_tokens"] = output.usage.inputTokens
				if (output?.usage?.outputTokens !== undefined) attrs["gen_ai.usage.output_tokens"] = output.usage.outputTokens
				break
			}
			case "tool": {
				Object.assign(attrs, {
					"gen_ai.operation.name": "execute_tool",
					"gen_ai.tool.name": name,
					"gen_ai.tool.call.arguments": attrs["genkit:input"] ?? "{}",
				})
				const result = json("genkit:output")
				if (result !== undefined) {
					attrs["gen_ai.tool.call.result"] = typeof result === "string" ? result : JSON.stringify(result)
				}
				break
			}
		}
	}

	forceFlush() {
		return Promise.resolve()
	}

	shutdown() {
		return Promise.resolve()
	}
}
```

It maps:

| Genkit span (`genkit:metadata:subtype`) | Adds |
| --- | --- |
| `flow`, `agent` | `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name=<genkit:name>`, `gen_ai.conversation.id` from `genkit:metadata:conversationId` or `genkit:metadata:agent:sessionId` |
| `model` | `chat`, `gen_ai.provider.name` (prefix before `/`), `gen_ai.request.model` (rest), `gen_ai.input.messages` / `gen_ai.system_instructions` from `genkit:input.messages`, `gen_ai.output.messages` + `gen_ai.response.finish_reasons` from `genkit:output`, `gen_ai.usage.input_tokens` / `output_tokens` from `genkit:output.usage` |
| `tool` | `execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.arguments` (= `genkit:input`), `gen_ai.tool.call.result` (= `genkit:output`, string results as plain text) |

Message conversion: role `model` → `assistant`; parts `{text}` → `text`, `{reasoning}` → `reasoning`, `{toolRequest:{name,ref,input}}` → `tool_call`, `{toolResponse:{name,ref,output}}` → `tool_call_response`; `media`, `data`, `custom` parts are dropped.

Notes:
- It mutates `span.attributes` in `onEnd`. That works because the exporting processor reads the same object; list `GenkitForMaple` BEFORE the exporting processor (required with `SimpleSpanProcessor`, which exports inside `onEnd`).
- Optional, only if the user asks for cache/reasoning token detail: `output.usage.cachedContentTokens` → `gen_ai.usage.cache_read.input_tokens`, `output.usage.thoughtsTokens` → `gen_ai.usage.reasoning.output_tokens`. Gemini models (`googleai/`, `vertexai/`) report `outputTokens` without thoughts: for them set `output_tokens` to `outputTokens + thoughtsTokens`. Keep `input_tokens` as Genkit reports it.
- Optional provider label mapping (`googleai` → `gcp.gemini`, `vertexai` → `gcp.vertex_ai`): cosmetic, skip unless asked.
- Leave `genkit:*` attributes in place; they are what the Genkit Developer UI and Google Cloud views read.
- Typecheck the file with the repo's `tsc` (it passes `strict`).

## Step 4: Start OpenTelemetry

Create `instrumentation.ts`:

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { disableGenkitOTelInitialization } from "genkit/tracing"
import { GenkitForMaple } from "./genkit-for-maple"

export const spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter())
export const sdk = new NodeSDK({ spanProcessors: [new GenkitForMaple(), spanProcessor] })

if (process.env.GENKIT_ENV !== "dev") {
	disableGenkitOTelInitialization()
	sdk.start()
}
```

- `import "./instrumentation"` as the FIRST line of every entry point (server, worker, CLI, Cloud Function index). It must run before Genkit's first span: otherwise Genkit's own SDK registers the global tracer provider first and Maple's never receives spans. Adjust the import extension/style to the repo (ESM `.js` suffix, `tsx`, bundler).
- Why `disableGenkitOTelInitialization()`: without it Genkit lazily starts a second, bundled NodeSDK on its first span. With Maple's SDK started first that second one mostly loses the global registration race, but it's two SDKs; disable it.
- `GENKIT_ENV=dev` is set by `genkit start` (Developer UI). Genkit's own SDK then ships traces to the Developer UI's telemetry server; Maple's SDK can't feed it (Genkit's `TraceServerExporter` reads 1.x span fields). So in dev: Developer UI traces, nothing to Maple. If the user wants Maple in dev too, drop the `if` and tell them the Developer UI trace view goes empty.
- Existing provider/SDK: add `new GenkitForMaple()` and the Maple `BatchSpanProcessor` to its span processors (before any exporting processor for GenkitForMaple), keep `disableGenkitOTelInitialization()`, don't create `NodeSDK`.
- Next.js with `@vercel/otel`: pass `spanProcessors: [new GenkitForMaple(), new BatchSpanProcessor(new OTLPTraceExporter({ url, headers }))]` to `registerOTel` and call `disableGenkitOTelInitialization()` in `register()`. Untested; verify spans arrive.
- `NodeSDK()` with `spanProcessors` doesn't build exporters from `OTEL_TRACES_EXPORTER`; the explicit `OTLPTraceExporter` still reads `OTEL_EXPORTER_OTLP_ENDPOINT` / `HEADERS`. It also starts OTLP metric and log exporters from env (default `otlp`); set `OTEL_METRICS_EXPORTER=none` / `OTEL_LOGS_EXPORTER=none` if the repo doesn't want them.

Genkit starts a NEW TRACE for every root Genkit action (it passes `root: true`), even inside an HTTP server span. That's fine for Maple (one trace per turn). If the user wants flows nested under their HTTP spans, `disableOTelRootSpanDetection()` from `genkit/tracing` changes it; not needed for Agent Sessions.

## Step 5: Conversation id (session)

Every turn must run inside a flow (or a beta agent). In each flow that handles a conversation, call at the start:

```ts
import { setCustomMetadataAttribute } from "genkit/tracing"

setCustomMetadataAttribute("conversationId", chatId)
```

- It writes to the CURRENT Genkit action, so call it directly in the flow body, not inside a tool or a nested `ai.run()` step. It throws outside any Genkit action.
- `ai.generate()` called outside a flow (e.g. straight from an Express route): wrap the call in a flow (`ai.defineFlow`) and call the flow from the route. Without a flow there is no `invoke_agent` span and no session id; each call becomes its own `trace:<id>` session.
- Id: stable per conversation, unique across conversations. Never a module constant, `Date.now()` per call or a per-process id. If the app has no id, create one when the conversation is created and persist it with it.
- Flows exposed via `startFlowServer` / `expressHandler` / `onCallGenkit` / `appRoute`: the client must send the chat id in the flow input; add it to `inputSchema` if missing.
- Beta agents (`defineAgent` etc.): nothing to add; `genkit:metadata:agent:sessionId` is used.
- The flow name is the agent name in Maple (`gen_ai.agent.name`). Give each distinct agent its own flow name.
- Sub-agents: a flow called from inside another flow or a tool also becomes an `invoke_agent` span named after that flow (expected to show as a sub-agent lane; not verified in Maple). Don't set the conversation id on inner flows.
- Don't set `gen_ai.conversation.id` or `maple_ai.session.id` on spans yourself; the processor does it.

## Step 6: Content, errors, flush

- Content: Genkit always records `genkit:input` / `genkit:output` (full prompts, replies, tool args/results). There is no Genkit switch. If the user needs content kept out of Maple, delete `genkit:input`/`genkit:output` in the processor after mapping and skip the message/argument/result attributes; tell them transcripts will be empty.
- Never set `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT` / `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT`: a truncated `genkit:input` makes `JSON.parse` in the processor throw inside `span.end()`.
- Tool failures: a tool that throws ends with status `ERROR` (Maple counts it failed) and aborts the whole `generate` / flow (Genkit doesn't feed the error back to the model). Don't change tool error behavior for tracing; tools that return `{ error }` payloads show as successful, which is accurate to what the model saw.
- Streaming (`ai.generateStream`, `flow.stream()`): model spans end with the full output and usage; read the stream to the end before flushing.
- Flush:
  - Scripts/CLIs: `await sdk.shutdown().catch((err) => console.error("telemetry flush failed", err))` in a `finally`. `shutdown()` rejects when an export failed; the `.catch` keeps a Maple outage from crashing the app.
  - Long-running servers (Cloud Run, plain Node): `process.on("SIGTERM", () => sdk.shutdown().catch((err) => console.error("telemetry flush failed", err)))`; nothing per request.
  - Serverless handlers you control: `await spanProcessor.forceFlush()` after the flow returns (the flow span ends when the flow returns, so flushing inside the flow misses it).
  - Cloud Functions for Firebase `onCallGenkit(flow)`: you can't hook after the flow; the instance may be throttled after the response, so the last batch can be delayed or lost. Tell the user; if it matters, wrap with `onCall` and call the flow then `forceFlush()` before returning. Untested.

## Step 7: Verify

Run one conversation with 2+ turns under the same id, one tool call, plus a second conversation. If the app has no scriptable entry point (server, Developer UI only), write a small driver for this that calls the flow directly: one conversation id, 2+ turns, at least one tool call, flush before exit. Then check (Maple MCP `list_agent_sessions` / `get_agent_session`, or the Agent Sessions page, ~30 s after the run):

- One session per conversation (id = your conversation id), not `trace:<id>` sessions; the second conversation is separate.
- Framework shows **Genkit**.
- Turns = number of flow runs; each trace has `invoke_agent` (flow name) → `generate` → model (`chat`) and tool (`execute_tool`) spans.
- Transcript shows user messages, assistant replies, tool calls with arguments and results; turn labels are the user's messages.
- Every model span has input and output tokens (if the model plugin reports usage).
- A throwing tool is failed; successful tools are not.
- No attribute contains the provider API key or `Bearer `.
- Under `genkit start`, the Developer UI still shows traces (and nothing reaches Maple).
- The process exited cleanly and no turn is missing (flush ran).

Without Maple access: the run exits with no export errors on stderr (`OTLPExporterError`, `Failed to export`, 401 lines) AND a local check shows the spans. Silence alone proves nothing (no spans also looks silent). Local check: point `OTEL_EXPORTER_OTLP_ENDPOINT` at a small HTTP server and swap in `@opentelemetry/exporter-trace-otlp-http` with `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` to read the spans as JSON; confirm `gen_ai.operation.name` on flow/model/tool spans and `gen_ai.conversation.id` equal across turns. With the Maple MCP: `list_agent_sessions` with `search=<conversation id>` returns one row.

## Do not

- Do not add a second GenAI tracer that also exports to Maple (OpenLLMetry/OpenInference Google GenAI or OpenAI instrumentations for the same calls): model calls get recorded twice.
