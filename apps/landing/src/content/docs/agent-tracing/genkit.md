---
title: "Trace Genkit agents with OpenTelemetry"
description: "Send Genkit's OpenTelemetry spans to Maple and group each chat into one Agent Session."
group: "AI Agents"
order: 16
navLabel: "Genkit"
icon: "googleadk"
---

Genkit traces every flow, model call and tool call with OpenTelemetry, but it records them under its own `genkit:*` attributes, which Agent Sessions doesn't read. You export those spans to Maple and add a small span processor that copies them to the GenAI attributes Maple reads. You also pass a conversation id in each flow, or each message becomes its own session.

This guide covers Genkit for Node.js. You need `genkit` 1.22 or newer and Node.js 20 or newer.

## Quick setup with a coding agent

Copy this prompt into a coding agent that can run shell commands, such as Claude Code, Codex or Cursor. It installs the [maple-agent-tracing-genkit](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-genkit) skill and follows it.

```text
Set up Maple agent tracing for Genkit in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-genkit -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**. If your organization is in the EU region, change `US` to `EU` in the prompt.

## Install the packages

```bash
npm install genkit @opentelemetry/sdk-node @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-proto
```

## Point the exporter at Maple

```bash
export OTEL_SERVICE_NAME="support-agent"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
```

For an EU organization, use `https://ingest.eu.maple.dev`. The exporter appends `/v1/traces` itself.

## Add the span processor

Create `genkit-for-maple.ts` and copy it as is. It turns each flow into an `invoke_agent` span, each model call into a `chat` span with its messages and token counts, and each tool call into an `execute_tool` span:

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

## Start OpenTelemetry

Create an `instrumentation.ts` and import it as the first line of your entry point (`import "./instrumentation"`):

```ts
// instrumentation.ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { disableGenkitOTelInitialization } from "genkit/tracing"
import { GenkitForMaple } from "./genkit-for-maple"

export const spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter())

// Reads OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES and OTEL_EXPORTER_OTLP_*
export const sdk = new NodeSDK({ spanProcessors: [new GenkitForMaple(), spanProcessor] })

// `genkit start` sets GENKIT_ENV=dev: leave the Developer UI's own tracing alone there
if (process.env.GENKIT_ENV !== "dev") {
	disableGenkitOTelInitialization()
	sdk.start()
}
```

Keep `GenkitForMaple` before the exporting processor. `disableGenkitOTelInitialization()` stops Genkit from starting its own OpenTelemetry SDK, which can't export to Maple. It also turns off `enableFirebaseTelemetry()` and `enableGoogleCloudTelemetry()`, so traces stop going to Google Cloud.

Runs under `genkit start` keep their traces in the Developer UI and send nothing to Maple. To trace them in Maple too, remove the `if`, and the Developer UI shows no traces.

If your app already starts OpenTelemetry (Sentry, auto-instrumentation, your own `NodeTracerProvider`), add both processors to that provider instead of creating a `NodeSDK`, and keep the `disableGenkitOTelInitialization()` call.

## Pass the conversation id in each flow

Run each user message through a flow and call `setCustomMetadataAttribute("conversationId", ...)` at its start, with the chat or thread id your app already stores:

```ts
import { genkit, z, type MessageData } from "genkit"
import { setCustomMetadataAttribute } from "genkit/tracing"

const ai = genkit({ plugins: [/* your model plugin */], model: "googleai/gemini-2.5-flash" })

// One history per conversation. Store it in your database in a real backend.
const histories = new Map<string, MessageData[]>()

export const supportChat = ai.defineFlow(
	{ name: "supportChat", inputSchema: z.object({ chatId: z.string(), text: z.string() }), outputSchema: z.string() },
	async ({ chatId, text }) => {
		setCustomMetadataAttribute("conversationId", chatId)

		const response = await ai.generate({ messages: histories.get(chatId) ?? [], prompt: text, tools: [getWeather] })
		histories.set(chatId, response.messages)
		return response.text
	},
)
```

The id must stay the same for the whole conversation and differ between conversations. The flow name becomes the agent name in Maple, so give each agent its own flow.

Chats with an agent from `ai.defineAgent()` (in `genkit/beta`) already carry Genkit's session id, so they need no extra call.

## Flush before the process exits

`BatchSpanProcessor` exports every few seconds, so a short-lived process can exit before its last spans are sent. In a script, call `await sdk.shutdown()` in a `finally` block before exiting. In a serverless handler, call `await spanProcessor.forceFlush()` after the flow returns. In a long-running server, call `sdk.shutdown()` on `SIGTERM`.

## Check that it works

Run a conversation with two messages and a tool call, then open **Agent Sessions** in Maple. You should see one session named after your conversation id, one turn per flow run, and a transcript with the prompts, replies and tool calls. Each model call shows its token counts.

The framework shows as **Genkit**. Cost shows as unpriced because Genkit doesn't report it.

## Troubleshooting

- **No spans at all.** `instrumentation.ts` isn't the first import, or the app runs under `genkit start`.
- **Traces show up, but Agent Sessions is empty.** `GenkitForMaple` is missing from `spanProcessors`.
- **Every message is its own session.** The flow doesn't call `setCustomMetadataAttribute("conversationId", ...)`, or `ai.generate()` runs outside a flow.
- **The Developer UI shows no traces.** `disableGenkitOTelInitialization()` ran under `genkit start`. Keep the `GENKIT_ENV` check around it.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [Genkit observability](https://genkit.dev/docs/observability/getting-started/)
