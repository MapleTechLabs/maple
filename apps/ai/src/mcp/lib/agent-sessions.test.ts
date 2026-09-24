import { describe, expect, it } from "vitest"
import type { AiSessionSpan } from "@maple/domain/http"
import { clipSpanContent } from "./agent-sessions"

const span = (genAi: AiSessionSpan["genAi"]): AiSessionSpan => ({
	traceId: "7f3a4b5c6d7e8f901234567890abcdef",
	spanId: "1111111111111111",
	parentSpanId: "",
	spanName: "chat gpt-5",
	spanKind: "Client",
	serviceName: "agent-runner",
	timestamp: "2026-08-19 10:00:00.000000000",
	durationMs: 900,
	statusCode: "Ok",
	statusMessage: "",
	isAiSpan: true,
	genAi,
})

const userMessage = (text: string) => ({ role: "user", parts: [{ type: "text", content: text }] })
const assistantMessage = (text: string) => ({
	role: "assistant",
	parts: [{ type: "text", content: text }],
})

const long = "x".repeat(3_000)

describe("clipSpanContent", () => {
	it("keeps the newest user message and the last one of an input history", () => {
		const clipped = clipSpanContent(
			span({
				inputMessages: [
					userMessage("first"),
					assistantMessage("second"),
					userMessage("third"),
					assistantMessage("fourth"),
					assistantMessage("fifth"),
				],
			}),
		)
		const messages = clipped.genAi.inputMessages as ReadonlyArray<{
			readonly parts: ReadonlyArray<{ readonly content: string }>
		}>
		expect(messages).toHaveLength(2)
		expect(messages.map((message) => message.parts[0]?.content)).toEqual(["third", "fifth"])
	})

	it("keeps every entry of an array-shaped payload, cutting only its strings", () => {
		const clipped = clipSpanContent(
			span({
				toolCallResult: [{ row: 1, text: long }, { row: 2 }, { row: 3 }],
				systemInstructions: [{ type: "text", content: long }, { type: "text" }],
			}),
		)
		const rows = clipped.genAi.toolCallResult as ReadonlyArray<{ readonly text?: string }>
		const parts = clipped.genAi.systemInstructions as ReadonlyArray<{ readonly content?: string }>
		expect(rows).toHaveLength(3)
		expect(rows[0]?.text).toBe(`${"x".repeat(1_000)}…`)
		expect(parts).toHaveLength(2)
		expect(parts[0]?.content).toBe(`${"x".repeat(1_000)}…`)
	})
})
