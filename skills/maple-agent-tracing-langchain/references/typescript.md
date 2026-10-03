# LangChain.js & LangGraph.js (TypeScript)

Follow this instead of Steps 2-7 of SKILL.md when the app is TypeScript/JavaScript. Step 1 (key and region) is shared.

Mechanism: `@arizeai/openinference-instrumentation-langchain` (scope `@arizeai/openinference-instrumentation-langchain`) emits OpenInference attributes only; unlike Python it has NO GenAI dual-write (`enable_genai_semconv` does not exist in JS). Maple groups sessions by its `session.id` and decodes the transcript, but without help finds no agent names and counts the `tools` node as a tool call. The `GenAiSpans` span processor below fixes that: in the SDK's `onEnding` hook (after OpenInference has set its attributes, before the span is frozen) it copies them into `gen_ai.*`.

Tested: langchain 1.5.14, @langchain/core 1.2.13, @langchain/langgraph 1.4.18, @langchain/openai 1.6.0, @arizeai/openinference-instrumentation-langchain 4.1.1, @opentelemetry/sdk-node 0.222.0 (sdk-trace-base 2.11.0), Node.js 26 and Bun 1.3.

## Step 0: Detect

1. Versions: read `package.json` / lockfile for `langchain`, `@langchain/core`, `@langchain/langgraph`. Need `@langchain/core` 1.x (0.3 is untested with this processor), Node.js >= 20 (Bun works).
2. Module system: ESM (`"type": "module"`, `.mts`, bundler) or CJS. Both work; `manuallyInstrument()` patches the module object you import, so import `@langchain/core/callbacks/manager` the same way the app imports LangChain.
3. Existing OTel setup. Search for `new NodeSDK(`, `NodeTracerProvider(`, `registerOTel(` (`@vercel/otel`), `Sentry.init(`, `@opentelemetry/auto-instrumentations-node`, `LangChainInstrumentation`, `@traceloop/`, `initializeOTEL` / `LANGSMITH_OTEL_ENABLED`.
   - A provider exists → add `new GenAiSpans()` to its span processors (see Step 2); do NOT start a second SDK.
   - `@traceloop/instrumentation-langchain` (OpenLLMetry) or LangSmith OTel → duplicate spans. Ask; remove for Maple.
4. `langgraph.json` present (LangGraph Platform / `langgraphjs dev`): also `import "./instrumentation.js"` at the top of each module its `graphs` points to, and set `OTEL_*` in the server env. The server passes `thread_id` itself.
5. Find every `createAgent(` / `createReactAgent(` (`@langchain/langgraph/prebuilt`) / `new StateGraph(` + `.compile(`, every `.invoke(` / `.stream(` / `.streamEvents(` / `new Command({ resume` on an agent/graph/chain, where the app's chat/thread id lives, and every tool that invokes another agent.

## Step 1: Install

Use the repo's package manager:

```bash
npm install @arizeai/openinference-instrumentation-langchain @opentelemetry/sdk-node @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-proto
```

pnpm >= 10 blocks the `protobufjs` postinstall the exporter needs: approve it (`allowBuilds: { protobufjs: true }` in `pnpm-workspace.yaml`, or `pnpm approve-builds`).

`@opentelemetry/sdk-node` >= 0.209 (it brings `@opentelemetry/sdk-trace-base` >= 2.3). `SpanProcessor.onEnding` first shipped in sdk-trace-base 2.3.0; on older SDKs it is never called and nothing changes (silently). If the app pins an older SDK, upgrade it. `onEnding` is marked experimental in the SDK; re-verify after major SDK upgrades.

Env vars (as SKILL.md Step 1): `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`. `new OTLPTraceExporter()` with no args reads them and appends `/v1/traces`; `new OTLPTraceExporter({ url })` uses `url` verbatim (must end in `/v1/traces`).

## Step 2: Init

Create `genai-spans.ts` next to the entry point. Copy it unchanged:

```ts
// genai-spans.ts: adds the OpenTelemetry GenAI attributes Maple reads to OpenInference's LangChain spans
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base"

// Hand-built StateGraph agents, by compiled name. createAgent({ name }) is detected on its own.
const AGENT_NAMES = new Set<string>()

const ROLES: Record<string, string> = { human: "user", ai: "assistant" }

function parse(value: unknown): any {
	if (typeof value !== "string") return undefined
	try {
		return JSON.parse(value)
	} catch {
		return undefined
	}
}

function text(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content.map((block) => (block?.type === "text" ? block.text : "")).join("")
}

// LangChain messages are serialized as { lc, id: [..., "AIMessage"], kwargs }; plain inputs are { role, content }
function toGenAiMessage(message: any) {
	const fields = message?.lc ? message.kwargs : (message ?? {})
	const type = message?.lc
		? String(message.id.at(-1)).replace(/Message(Chunk)?$/, "").toLowerCase()
		: String(fields.role ?? fields.type)
	const role = ROLES[type] ?? type
	const parts: object[] = []
	if (role === "tool") {
		parts.push({ type: "tool_call_response", id: fields.tool_call_id, response: text(fields.content) })
	} else if (text(fields.content)) {
		parts.push({ type: "text", content: text(fields.content) })
	}
	for (const call of fields.tool_calls ?? []) {
		parts.push({ type: "tool_call", id: call.id, name: call.name, arguments: call.args })
	}
	return { role, parts }
}

export class GenAiSpans implements SpanProcessor {
	// Tool call arguments by call id, from the model reply that requested them
	private toolArgs = new Map<string, unknown>()

	onEnding(span: Span) {
		if (span.instrumentationScope.name !== "@arizeai/openinference-instrumentation-langchain") return
		const attrs = span.attributes
		const set = (key: string, value: unknown) => {
			if (value === undefined || value === null || value === "") return
			span.setAttribute(key, typeof value === "object" ? JSON.stringify(value) : (value as string | number))
		}
		const metadata = parse(attrs["metadata"]) ?? {}
		const input = parse(attrs["input.value"])
		const output = parse(attrs["output.value"])
		const kind = attrs["openinference.span.kind"]

		if (kind === "LLM") {
			const generations = output?.generations?.[0] ?? []
			const reply = generations[0]?.message?.kwargs ?? {}
			const finish = generations[0]?.generationInfo?.finish_reason ?? reply.response_metadata?.finish_reason
			if (this.toolArgs.size > 1000) this.toolArgs.clear() // calls whose tool never ran
			for (const call of reply.tool_calls ?? []) this.toolArgs.set(call.id, call.args)
			set("gen_ai.operation.name", "chat")
			set("gen_ai.provider.name", metadata.ls_provider)
			set("gen_ai.request.model", attrs["llm.model_name"])
			set("gen_ai.response.model", reply.response_metadata?.model_name)
			set("gen_ai.response.id", reply.id)
			set("gen_ai.usage.input_tokens", attrs["llm.token_count.prompt"])
			set("gen_ai.usage.output_tokens", attrs["llm.token_count.completion"])
			if (finish) span.setAttribute("gen_ai.response.finish_reasons", [finish])
			set("gen_ai.input.messages", (input?.messages?.[0] ?? []).map(toGenAiMessage))
			set(
				"gen_ai.output.messages",
				generations.map((g: any) => ({ ...toGenAiMessage(g.message ?? { role: "assistant", content: g.text }), finish_reason: finish ?? "stop" })),
			)
		} else if (kind === "TOOL") {
			// A tool called by the model returns a serialized ToolMessage
			const message = output?.output?.lc ? output.output.kwargs : undefined
			const content = message ? text(message.content) : attrs["output.value"]
			const result = parse(content)
			set("gen_ai.operation.name", "execute_tool")
			set("gen_ai.tool.name", attrs["tool.name"])
			set("gen_ai.tool.call.id", message?.tool_call_id)
			set("gen_ai.tool.call.arguments", this.toolArgs.get(message?.tool_call_id))
			this.toolArgs.delete(message?.tool_call_id)
			if (content !== undefined) set("gen_ai.tool.call.result", typeof result === "object" && result !== null ? result : content)
		} else if (span.name === metadata.lc_agent_name || AGENT_NAMES.has(span.name)) {
			const messages = output?.messages ?? []
			set("gen_ai.operation.name", "invoke_agent")
			set("gen_ai.agent.name", span.name)
			set("gen_ai.input.messages", (input?.messages ?? []).map(toGenAiMessage))
			set("gen_ai.output.messages", messages.slice(-1).map(toGenAiMessage))
		} else if (kind !== "RETRIEVER" && kind !== "EMBEDDING") {
			// Graph nodes, prompts and other runnables: steps, not model or tool calls
			set("gen_ai.operation.name", "invoke_workflow")
		}
	}

	onStart() {}
	onEnd() {}
	forceFlush() {
		return Promise.resolve()
	}
	shutdown() {
		return Promise.resolve()
	}
}
```

If the repo lints `any`, add `/* eslint-disable @typescript-eslint/no-explicit-any */` at the top of `genai-spans.ts` rather than retyping it.

Create `instrumentation.ts`:

```ts
// instrumentation.ts
import { LangChainInstrumentation } from "@arizeai/openinference-instrumentation-langchain"
import * as CallbackManagerModule from "@langchain/core/callbacks/manager"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { GenAiSpans } from "./genai-spans"

// Reads OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES and OTEL_EXPORTER_OTLP_*
export const spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter())
export const sdk = new NodeSDK({
	spanProcessors: [new GenAiSpans(), spanProcessor],
	// Room for long chats: OpenInference writes several attributes per message
	spanLimits: { attributeCountLimit: 1000 },
})
sdk.start()

new LangChainInstrumentation().manuallyInstrument(CallbackManagerModule)
```

- The app loads `.env` (`import "dotenv/config"`, `node --env-file`): put `import "dotenv/config"` as the first line of `instrumentation.ts`, before the SDK is built. Otherwise the exporter silently targets `localhost:4318` with no key.
- Import it as the first line of every entry point (`import "./instrumentation"`; with Node ESM + plain `tsc` the specifier needs the emitted extension, e.g. `./instrumentation.js`, and the same for `./genai-spans`). Or load it with `node --import ./instrumentation.js`.
- `manuallyInstrument()` is required: the instrumentation isn't registered with the SDK, and its require hook only matches the CJS build. Without the call there are no LangChain spans.
- Passing `spanProcessors` makes `NodeSDK` skip its env-configured default exporter, which is why the exporter is built explicitly.
- `spanLimits.attributeCountLimit`: the default 128 is exceeded once a chat model span carries ~60 messages (OpenInference flattens every message into `llm.input_messages.N.*`); the attributes `GenAiSpans` adds come last and are dropped first. Verified: a 20-turn thread with a tool call per turn lost `gen_ai.operation.name` on 18 of 40 chat spans at the default. 1000 covers ~450 messages; raise it for longer threads.
- Existing provider: add `new GenAiSpans()` to its span processors (order doesn't matter: every processor's `onEnding` runs before any `onEnd`). `NodeSDK({ spanProcessors: [...] })`, `new NodeTracerProvider({ spanProcessors: [...] })`. `@vercel/otel`: `registerOTel({ spanProcessors: ["auto", new GenAiSpans()] })` and install `@opentelemetry/sdk-trace-base` >= 2.3 (its peer range allows 2.0) (untested). Sentry v8+: pass it via `openTelemetrySpanProcessors: [new GenAiSpans()]` in `Sentry.init` (untested).
- Set a real `service.name` (never `unknown_service`).

## Step 3: Agent names

- Give every `createAgent({ ... })` a `name` (sub-agents too). `createAgent` puts it in run metadata as `lc_agent_name`; `GenAiSpans` marks the span whose name equals it as `invoke_agent` with `gen_ai.agent.name`. Unnamed agents run as `LangGraph` and get no agent span (verified), so the session has no agent lane.
- `createReactAgent({ ..., name })` from `@langchain/langgraph/prebuilt` and hand-built `new StateGraph(...).compile({ name: "planner" })` don't set `lc_agent_name`: add their names to `AGENT_NAMES` (verified for `createReactAgent`: without it the root span is only `invoke_workflow`).
- Tool names don't matter here: OpenInference JS takes the span kind from the LangChain run type, so a tool named `ask_weather_agent` stays a tool (unlike Python).

## Step 4: Session id (required)

Pass the app's conversation id as `thread_id` on EVERY agent/graph call, including streams and resumes:

```ts
const result = await agent.invoke(
	{ messages: [{ role: "user", content: text }] },
	{ configurable: { thread_id: conversationId } },
)

const stream = await agent.stream(input, { configurable: { thread_id: conversationId }, streamMode: "messages" })

await agent.invoke(new Command({ resume: decision }), { configurable: { thread_id: conversationId } })
```

- LangGraph copies `configurable.thread_id` into run metadata; OpenInference reads metadata `session_id` > `thread_id` > `conversation_id` into `session.id`, which Maple groups by.
- With a checkpointer, reuse the existing `thread_id`; don't invent a second id.
- `thread_id` groups turns in Maple; it doesn't give the agent memory. With no checkpointer, pass the prior `result.messages` into the next call yourself, or add `MemorySaver` (`@langchain/langgraph`).
- Plain chains (`prompt.pipe(model)`, `RunnableSequence`, no graph) do NOT copy `configurable` (verified): pass `{ metadata: { thread_id: conversationId } }`.
- Nested runs (agents called inside tools) inherit it when the tool passes its config through (LangChain does this automatically for `tool()` functions; verified). Don't pass a different id.
- Stable per conversation, unique across conversations: no constants, no `crypto.randomUUID()` per request. No id in the app → ask where the conversation boundary is.
- Do not set `session.id` / `gen_ai.conversation.id` / `maple_ai.session.id` by hand.

## Step 5: Content

- On by default. `gen_ai.input.messages` / `gen_ai.output.messages` on chat spans (system prompt as a `system` message), turn input and final reply on the `invoke_agent` span, `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` on tool spans.
- User wants content off → `new LangChainInstrumentation({ traceConfig: { hideInputs: true, hideOutputs: true } })`. Verified: messages become `[]`, tool results `{"result":"__REDACTED__"}`, tool call ids and finish reasons disappear; turns, tools, tokens and failures remain. Tell the user the transcript will be empty.
- `OPENINFERENCE_HIDE_INPUTS` / `OPENINFERENCE_HIDE_OUTPUTS` env vars are ignored unless a `traceConfig` object is passed (even `{}`): OpenInference JS only reads env when options are given (verified in openinference-core 2.7.1).

## Step 6: Tools, errors, sub-agents

1. `createAgent` catches tool exceptions by default and returns the error to the model as a `ToolMessage` ("Error: ... Please fix your mistakes."); the run continues. The tool span is status ERROR with the exception recorded (verified), and has no result/call id/arguments (they come from the tool's output).
2. Tools that `return "Error: ..."` show as successful calls. Prefer throwing, where the user agrees.
3. Agent-as-tool sub-agents: the nested agent's spans land in the caller's trace and session, under the tool span (verified):

```ts
const weatherWorker = createAgent({ model, tools: [getWeather], name: "weather_worker" })

const askWeatherWorker = tool(
	async ({ city }) => {
		const result = await weatherWorker.invoke({ messages: [{ role: "user", content: `Weather in ${city}?` }] })
		return result.messages.at(-1)?.content as string
	},
	{ name: "ask_weather_worker", description: "Ask the weather worker", schema: z.object({ city: z.string() }) },
)
```

4. Interrupts / `humanInTheLoopMiddleware`: the resume is a new trace in the same session as long as `thread_id` is passed (untested in JS).

## Step 7: Flush

- `BatchSpanProcessor` exports every 5 s.
- Scripts/CLIs: `await sdk.shutdown().catch((err) => console.error("telemetry flush failed", err))` in a `finally`: shutdown rejects when an export failed, and a Maple outage must not crash the app.
- Long-running servers: flush on `SIGTERM` only, nothing per request. If the app has no `SIGTERM` handler: `process.on("SIGTERM", () => sdk.shutdown().catch((err) => console.error("telemetry flush failed", err)).finally(() => process.exit(0)))`; otherwise add the `shutdown()` to its handler.
- Serverless handlers, queue workers, cron: `await spanProcessor.forceFlush()` in a `finally` after each run.
- Streams: consume them to the end before flushing; spans end when the run ends.

## Step 8: Verify

Run one real conversation: 2+ messages with the same id, at least one tool call, one streamed message if the app streams, a sub-agent call if the app delegates. No scriptable entry point (server, REPL, UI only) → write a small driver: one conversation id, 2+ turns, at least one tool call, `await sdk.shutdown()` before exit. Then check Maple → Agent Sessions (filter by service name; wait up to ~1 min):

- [ ] One session per conversation, id = the `thread_id`. A second conversation is a different session.
- [ ] Framework shows **LangChain**.
- [ ] One turn per `invoke()`; each trace starts at the agent span (the `name`), with `model_request` / `tools` node spans, chat model spans (`ChatOpenAI`, ...) and tool spans named after the tools.
- [ ] Transcript shows user messages, assistant replies and tool calls (not a raw JSON blob).
- [ ] Tool call count = the tools the model actually called.
- [ ] Every chat span has input and output tokens, including streamed ones (JS `ChatOpenAI` requests streamed usage by default; `streamUsage: false` turns it off).
- [ ] A failing tool is marked failed; successful tools are not.
- [ ] Sub-agents appear as separate lanes in the caller's session.
- [ ] Cost shows "unpriced" (expected).
- [ ] No attribute contains an API key or `Bearer ` token.

Without Maple access, both must hold: the run exits with no export errors on stderr (`OTLPExporterError`, 401 lines), AND a temporary `new SimpleSpanProcessor(new ConsoleSpanExporter())` (from `@opentelemetry/sdk-trace-base`) in `spanProcessors` shows every LangChain span of every turn has the same `gen_ai.conversation.id`, chat spans have `gen_ai.operation.name: "chat"` with `gen_ai.input.messages`, tool spans `execute_tool`, and the root span `invoke_agent`. Silence alone proves nothing (no spans is silent too). With the Maple MCP: `list_agent_sessions` with `search=<conversation id>` returns one row.

Known gaps (not setup bugs): `gen_ai.provider.name` is LangChain's `ls_provider` (`openai` for `ChatOpenAI` even behind a gateway; the class name for fake/unknown models); streamed chat spans have no `gen_ai.response.model`; failed tool spans have no call id or arguments, so Maple matches them to the model's tool call by name; with a checkpointer every chat span repeats the whole history (ingest accepts requests up to 20 MiB). Turn labels in the Maple UI were not checked for JS (the `invoke_agent` span carries the turn's own input).

Why not the alternatives (checked 2026-09):
- `@traceloop/instrumentation-langchain` 0.27 (OpenLLMetry) emits `gen_ai.*`, but starts spans without the LangChain parent run, drops tool calls from messages, and has no conversation id.
- LangSmith JS OTel export is experimental; Maple labels it "LangChain" but it has the same problems as the Python LangSmith path (see SKILL.md).
