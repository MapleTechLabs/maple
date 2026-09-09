/**
 * The wire contract's own test.
 *
 * Every assertion here stands for something a client badges on: the terminal reason it shows, the
 * task ref that routes a sub-agent's output into its card, and the proposal flag that decides
 * whether a mutating call renders as "will do" or "did". A regression in this file is a regression
 * the browser and the iOS app both see.
 */
import { assert, describe, it } from "vitest"
import { toChatEvents, type AdapterContext } from "./events"

/**
 * Engine events are structural here on purpose.
 *
 * Constructing them through their schemas would assert that the schemas exist, not that the mapping
 * is right, and it would couple this test to field names the adapter already pins by compiling.
 */
const event = (tag: string, fields: Record<string, unknown> = {}): never =>
	({ _tag: tag, ...fields }) as never

const base: AdapterContext = { messageId: "msg-1" }

describe("toChatEvents", () => {
	it("opens the assistant message on RunStarted", () => {
		assert.deepEqual(toChatEvents(event("RunStarted"), base), [
			{ type: "turn-start", messageId: "msg-1" },
		])
	})

	it("carries text deltas through unchanged", () => {
		assert.deepEqual(toChatEvents(event("TextDelta", { text: "hel" }), base), [
			{ type: "text-delta", messageId: "msg-1", text: "hel" },
		])
	})

	it("announces a declared call with its arguments", () => {
		assert.deepEqual(
			toChatEvents(
				event("ToolCallDeclared", {
					toolCallId: "call-1",
					toolName: "search_logs",
					parameters: { query: "boom" },
				}),
				base,
			),
			[
				{
					type: "tool-call",
					messageId: "msg-1",
					callId: "call-1",
					name: "search_logs",
					input: { query: "boom" },
				},
			],
		)
	})

	it("marks a gated call as a proposal rather than a dispatch", () => {
		const [call] = toChatEvents(
			event("ToolCallDeclared", {
				toolCallId: "call-2",
				toolName: "create_alert_rule",
				parameters: {},
			}),
			{ ...base, isProposed: (name) => name === "create_alert_rule" },
		)
		assert.deepInclude(call, { proposed: true })
	})

	it("does not mark an ungated call", () => {
		const [call] = toChatEvents(
			event("ToolCallDeclared", { toolCallId: "c", toolName: "search_logs", parameters: {} }),
			{ ...base, isProposed: () => false },
		)
		assert.notProperty(call, "proposed")
	})

	it("distinguishes a failed tool result from a successful one", () => {
		assert.deepEqual(
			toChatEvents(event("ToolCallSucceeded", { toolCallId: "c", result: "rows" }), base),
			[{ type: "tool-result", messageId: "msg-1", callId: "c", output: "rows" }],
		)
		assert.deepEqual(
			toChatEvents(event("ToolCallFailed", { toolCallId: "c", message: "nope" }), base),
			[{ type: "tool-result", messageId: "msg-1", callId: "c", output: "nope", isError: true }],
		)
	})

	describe("terminal reasons", () => {
		it("reports a budget-exhausted run as max-steps", () => {
			// The client badges this differently from a normal stop: the answer was cut short, and
			// saying "stop" would present a truncated turn as a complete one.
			assert.deepEqual(
				toChatEvents(event("RunCompleted", { finishReason: "budget-exhausted" }), base),
				[{ type: "turn-end", messageId: "msg-1", reason: "max-steps" }],
			)
		})

		it("reports any other completion as a stop", () => {
			assert.deepEqual(toChatEvents(event("RunCompleted", { finishReason: "stop" }), base), [
				{ type: "turn-end", messageId: "msg-1", reason: "stop" },
			])
		})

		it("carries a failure message onto the terminal event", () => {
			assert.deepEqual(toChatEvents(event("RunFailed", { message: "provider down" }), base), [
				{ type: "turn-end", messageId: "msg-1", reason: "error", error: "provider down" },
			])
		})

		it("reports an interruption as aborted, with no error text", () => {
			assert.deepEqual(toChatEvents(event("RunInterrupted", { reason: "cancelled" }), base), [
				{ type: "turn-end", messageId: "msg-1", reason: "aborted" },
			])
		})
	})

	it("routes a sub-agent's events into its task card", () => {
		const task = { id: "task-1", agent: "explore" } as const
		for (const engine of [
			event("RunStarted"),
			event("TextDelta", { text: "x" }),
			event("RunCompleted", { finishReason: "stop" }),
		]) {
			const [mapped] = toChatEvents(engine, { ...base, task })
			assert.deepInclude(mapped, { task })
		}
	})

	it("leaves the top-level conversation untagged", () => {
		const [mapped] = toChatEvents(event("RunStarted"), base)
		assert.notProperty(mapped, "task")
	})

	it("drops events the wire has no word for", () => {
		for (const tag of [
			"TurnStarted",
			"ModelStarted",
			"ReasoningDelta",
			"ToolCallStarted",
			"ToolProgress",
			"TurnCompleted",
			"BudgetWarning",
			"CompactionPerformed",
			"RunSuspended",
			"ApprovalRequested",
			"SubagentRequested",
			"SubagentStarted",
			"SubagentProgress",
			"SubagentCompleted",
			"SubagentFailed",
			"SubagentInterrupted",
			"SubagentJoined",
		]) {
			assert.deepEqual(toChatEvents(event(tag), base), [], `${tag} must not reach the transcript`)
		}
	})
})
