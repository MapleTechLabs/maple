/**
 * The wire contract's own test.
 *
 * Every assertion here stands for something a client badges on: the terminal reason it shows, the
 * task ref that routes a sub-agent's output into its card, and the proposal flag that decides
 * whether a mutating call renders as "will do" or "did". A regression in this file is a regression
 * the browser and the iOS app both see.
 */
import { assert, describe, it } from "vitest"
import type { ChatEvent } from "@maple/domain/chat-session"
import { makeChatTranscript } from "@maple/domain/chat-transcript"
import { APPROVAL_REQUIRED } from "../mcp/tools/llm-tools"
import { makeTextSanitizer, toChatEvents, type AdapterContext } from "./events"

/**
 * Engine events are structural here on purpose.
 *
 * Constructing them through their schemas would assert that the schemas exist, not that the mapping
 * is right, and it would couple this test to field names the adapter already pins by compiling.
 */
const event = (tag: string, fields: Record<string, unknown> = {}): never =>
	({ _tag: tag, ...fields }) as never

/**
 * One sanitizer across these cases, which is safe only because every one of them writes prose that
 * passes straight through and leaves it empty. A case that ends mid-tag belongs in the sanitizer's
 * own describe below, with a sanitizer of its own.
 */
const base: AdapterContext = { messageId: "msg-1", sanitizer: makeTextSanitizer() }

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

	it("drops an empty text delta rather than logging it", () => {
		assert.deepEqual(toChatEvents(event("TextDelta", { text: "" }), base), [])
	})

	it("delivers the tail a tag never claimed before the turn ends", () => {
		const ending: AdapterContext = { messageId: "msg-1", sanitizer: makeTextSanitizer() }
		assert.deepEqual(toChatEvents(event("TextDelta", { text: "latency <" }), ending), [
			{ type: "text-delta", messageId: "msg-1", text: "latency " },
		])
		assert.deepEqual(toChatEvents(event("RunCompleted", { finishReason: "stop" }), ending), [
			{ type: "text-delta", messageId: "msg-1", text: "<" },
			{ type: "turn-end", messageId: "msg-1", reason: "stop" },
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
		assert.deepEqual(toChatEvents(event("ToolCallFailed", { toolCallId: "c", message: "nope" }), base), [
			{ type: "tool-result", messageId: "msg-1", callId: "c", output: "nope", isError: true },
		])
	})

	it("leaves a proposal open, and ends its turn as finished rather than failed", () => {
		const context: AdapterContext = {
			messageId: "msg-1",
			isProposed: (name) => name === "create_dashboard",
			sanitizer: makeTextSanitizer(),
		}
		const refusal = {
			errorTag: APPROVAL_REQUIRED,
			message: "create_dashboard requires user approval and was not executed.",
		}
		// The sequence the engine emits for a gated call (see `run-tool-failures.test.ts`).
		const chat = [
			event("RunStarted"),
			event("ToolCallDeclared", { toolCallId: "c", toolName: "create_dashboard", parameters: {} }),
			event("ToolCallFailed", { toolCallId: "c", toolName: "create_dashboard", ...refusal }),
			event("RunFailed", refusal),
		].flatMap((engine) => toChatEvents(engine, context))
		const transcript = makeChatTranscript()
		chat.forEach((wire, index) => transcript.add({ ...wire, seq: index + 1 } as ChatEvent, 0))

		assert.deepEqual(
			chat.map((wire) => wire.type),
			["turn-start", "tool-call", "turn-end"],
		)
		assert.deepInclude(chat.at(-1), { reason: "stop" })
		const [call] = transcript.messages[0]?.toolCalls ?? []
		assert.deepInclude(call, { id: "c", proposed: true })
		assert.notProperty(call, "output")
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

	describe("sub-agents", () => {
		const delegation = { toolCallId: "call-9", targetAgentId: "explore" }
		const task = { id: "call-9", agent: "explore", parentMessageId: "msg-1" }

		it("opens a card keyed by the delegation call", () => {
			// `ChatSession` looks the card up by the parent's tool call id and drops anything it
			// cannot match, so this id is the whole routing decision.
			assert.deepEqual(toChatEvents(event("SubagentStarted", delegation), base), [
				{ type: "turn-start", messageId: "call-9", task },
			])
		})

		it("shows what the sub-agent reports, not a replay of its work", () => {
			// The engine keeps the child's tool history in the child's thread and relays a summary.
			assert.deepEqual(
				toChatEvents(event("SubagentProgress", { ...delegation, summary: "found 3 spans" }), base),
				[{ type: "text-delta", messageId: "call-9", text: "found 3 spans", task }],
			)
		})

		it("closes the card on each terminal outcome", () => {
			assert.deepEqual(
				toChatEvents(event("SubagentCompleted", { ...delegation, finishReason: "stop" }), base),
				[{ type: "turn-end", messageId: "call-9", reason: "stop", task }],
			)
			assert.deepEqual(
				toChatEvents(
					event("SubagentCompleted", { ...delegation, finishReason: "budget-exhausted" }),
					base,
				),
				[{ type: "turn-end", messageId: "call-9", reason: "max-steps", task }],
			)
			assert.deepEqual(
				toChatEvents(event("SubagentFailed", { ...delegation, message: "tool gone" }), base),
				[{ type: "turn-end", messageId: "call-9", reason: "error", error: "tool gone", task }],
			)
			assert.deepEqual(
				toChatEvents(event("SubagentInterrupted", { ...delegation, reason: "cancelled" }), base),
				[{ type: "turn-end", messageId: "call-9", reason: "aborted", task }],
			)
		})
	})

	it("tags a nested run's own events with the card it belongs to", () => {
		const task = { id: "task-1", agent: "explore", parentMessageId: "msg-0" }
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
			"AgentUpdateEmitted",
			// `Requested` precedes the delegation call that opens the card; `Joined` follows the
			// result that closes it. Either would duplicate an event already sent.
			"SubagentRequested",
			"SubagentJoined",
		]) {
			assert.deepEqual(toChatEvents(event(tag), base), [], `${tag} must not reach the transcript`)
		}
	})
})

/**
 * Markup the model wrote into `content`, which a channel would print verbatim.
 *
 * Every case arrives in chunks, because that is how a delta stream delivers one: a tag split
 * across two deltas is what a per-delta regex gets wrong, and the reason this keeps state at all.
 */
describe("makeTextSanitizer", () => {
	const stripped = (chunks: ReadonlyArray<string>) => {
		const sanitizer = makeTextSanitizer()
		const text = chunks.map(sanitizer.strip).join("")
		return { text, leaked: sanitizer.leaked() }
	}

	it("passes ordinary prose through, chunk for chunk", () => {
		assert.equal(stripped(["check", "out is ", "timing out."]).text, "checkout is timing out.")
	})

	it("drops an inline thinking block whose tag arrives split across deltas", () => {
		assert.equal(stripped(["Before <th", "ink>hid", "den</thi", "nk> after"]).text, "Before  after")
	})

	it("drops every thinking spelling a model might reach for", () => {
		for (const [open, close] of [
			["<think>", "</think>"],
			["<thinking>", "</thinking>"],
			["◁think▷", "◁/think▷"],
			["<|begin_of_thought|>", "<|end_of_thought|>"],
		]) {
			assert.equal(stripped([`A${open}h`, `idden${close}B`]).text, "AB", open)
		}
	})

	it("drops a tool call written as text and names the tag once", () => {
		const call = "<tool_call>search_errors<arg_key>service</arg_key></tool_call>"
		const { text, leaked } = stripped(["Errors are up.", call.slice(0, 9), call.slice(9)])

		assert.equal(text, "Errors are up.")
		assert.equal(leaked, "<tool_call>")
	})

	it("takes the rest of the turn with a block the model never closes", () => {
		const { text, leaked } = stripped(["The answer. <tool_call>search", "_errors<arg_key>svc"])

		assert.equal(text, "The answer. ")
		assert.equal(leaked, "<tool_call>")
	})

	it("reports nothing for a turn that only ever wrote prose", () => {
		assert.equal(stripped(["1 < 2 and 2 > 1"]).leaked, undefined)
	})

	it("keeps a tag the model quoted, rather than eating the reply that explains it", () => {
		const { text, leaked } = stripped(["I never write `<tool", "_call>` in a reply. Here is why."])

		assert.equal(text, "I never write `<tool_call>` in a reply. Here is why.")
		assert.equal(leaked, undefined)
	})

	it("releases a held tail at the end of the turn, because the tag never came", () => {
		const sanitizer = makeTextSanitizer()
		assert.equal(sanitizer.strip("errors under 1%, latency <"), "errors under 1%, latency ")
		assert.equal(sanitizer.flush(), "<")
	})

	it("flushes nothing out of a block the turn ended inside", () => {
		const sanitizer = makeTextSanitizer()
		sanitizer.strip("The answer. <tool_call>search_err")
		assert.equal(sanitizer.flush(), "")
	})

	it("cannot splice two halves of a tag together across a block it removed", () => {
		// The halves on either side of the removed block would read as `<think>` concatenated.
		assert.equal(stripped(["a<th<tool_call>x</tool_call>ink> b"]).text, "aink> b")
	})

	it("holds back a tail that could still become a tag, and releases it when it cannot", () => {
		const sanitizer = makeTextSanitizer()
		// `<t` could still grow into `<think>` or `<tool_call>`, so it waits for the next delta.
		assert.equal(sanitizer.strip("a < b and c <t"), "a < b and c ")
		assert.equal(sanitizer.strip("ables"), "<tables")
	})
})
