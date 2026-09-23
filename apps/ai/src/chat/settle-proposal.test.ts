/**
 * Settling a proposal the agent paused on, against the real event log.
 *
 * The property worth pinning is that **nothing the clicker sent names the tool**: the host relays
 * a session, a call id and a decision, and everything else — which tool, with which arguments,
 * under which assistant message — is read out of this object's own SQLite. A caller that could
 * name the tool would be a second, unauthorized way to run a mutation.
 *
 * Running the tool is the other unit (`apply-proposal.ts`, which builds the MCP service graph and
 * a database connection). The session takes it as a port, so the lookup, the settling and the
 * double-click window are testable without building either.
 */
import { assert, beforeEach, describe, it } from "vitest"
import type { ChatConnectorOrigin } from "@maple/domain/chat-session"
import { ChatSession, type ProposalApplier } from "./ChatSession"
import { makeFakeDurableObjectState } from "../../test/chat/fake-do-state"

const applied: Array<Parameters<ProposalApplier>[0]> = []
let apply: () => Promise<{ output: string; isError: boolean }> = () =>
	Promise.resolve({ output: "Created alert rule ar_1.", isError: false })

const applier: ProposalApplier = (input) => {
	applied.push(input)
	return apply()
}

const SESSION_ID = "org_1:bot-testchat-c1"

const ADA: ChatConnectorOrigin = {
	kind: "connector",
	connectorId: "testchat",
	workspaceId: "workspace-1",
	externalUserId: "author-1",
	displayName: "Ada",
}

const makeSession = () => new ChatSession(makeFakeDurableObjectState(), {}, applier)

/** A turn that ended on a proposal: the tool has not run, and the call is waiting for a decision. */
const withProposal = (session: ChatSession, callId = "call_9") => {
	session.append({ type: "user-message", id: "u1", text: "alert me on checkout p95" })
	session.append({ type: "turn-start", messageId: "a1" })
	session.append({
		type: "tool-call",
		messageId: "a1",
		callId,
		name: "create_alert_rule",
		input: { name: "checkout p95", threshold: 1200 },
		proposed: true,
	})
	session.append({ type: "turn-end", messageId: "a1", reason: "stop" })
	return session
}

const settledCall = (session: ChatSession, callId = "call_9") =>
	session
		.history()
		.flatMap((message) => message.toolCalls)
		.find((call) => call.id === callId)

const settle = (session: ChatSession, decision: "approve" | "deny", callId = "call_9") =>
	session.settleProposal({ sessionId: SESSION_ID, toolCallId: callId, decision, approver: ADA })

beforeEach(() => {
	applied.length = 0
	apply = () => Promise.resolve({ output: "Created alert rule ar_1.", isError: false })
})

describe("settling a proposal", () => {
	it("runs the tool the LOG names, with the arguments the log holds", async () => {
		const session = withProposal(makeSession())

		assert.equal(await settle(session, "approve"), "decided")

		assert.lengthOf(applied, 1)
		assert.deepEqual(applied[0], {
			env: {},
			tool: "create_alert_rule",
			input: { name: "checkout p95", threshold: 1200 },
			sessionId: SESSION_ID,
			approver: ADA,
		})
		const call = settledCall(session)
		assert.equal(call?.output, "Created alert rule ar_1.")
		assert.isUndefined(call?.isError)
	})

	it("records a denial as the call's result, and runs nothing", async () => {
		const session = withProposal(makeSession())

		assert.equal(await settle(session, "deny"), "decided")

		assert.deepEqual(applied, [])
		const call = settledCall(session)
		// An error result, so the model's next turn reads the proposal as declined rather than as a
		// change that went through quietly.
		assert.equal(call?.isError, true)
		assert.include(String(call?.output), "Declined by Ada")
	})

	it("refuses a call the transcript does not hold as an open proposal", async () => {
		const session = withProposal(makeSession())
		// A tool the agent actually ran is not a proposal: settling one would re-run it.
		session.append({
			type: "tool-call",
			messageId: "a1",
			callId: "call_ran",
			name: "search_traces",
			input: {},
		})

		assert.equal(await settle(session, "approve", "call_missing"), "unknown")
		assert.equal(await settle(session, "approve", "call_ran"), "unknown")
		assert.deepEqual(applied, [])
	})

	it("answers the second click without running the tool twice", async () => {
		const session = withProposal(makeSession())
		await settle(session, "approve")

		assert.equal(await settle(session, "approve"), "settled")
		assert.equal(await settle(session, "deny"), "settled")
		assert.lengthOf(applied, 1)
	})

	it("holds the second of two clicks that land while the tool is still running", async () => {
		const session = withProposal(makeSession())
		let release = (): void => undefined
		const running = new Promise<{ output: string; isError: boolean }>((resolve) => {
			release = () => resolve({ output: "Created alert rule ar_1.", isError: false })
		})
		apply = () => running

		// The durable check cannot see a result that has not been written yet; this is the window a
		// double click actually lands in.
		const first = settle(session, "approve")
		assert.equal(await settle(session, "approve"), "settled")
		release()
		assert.equal(await first, "decided")
		assert.lengthOf(applied, 1)
	})

	it("settles a proposal whose application fell over, rather than leaving it live", async () => {
		const session = withProposal(makeSession())
		apply = () => Promise.reject(new Error("the database was unreachable"))

		assert.equal(await settle(session, "approve"), "decided")

		const call = settledCall(session)
		assert.equal(call?.isError, true)
		// Live controls on a mutation that may or may not have run is the worse of the two.
		assert.include(String(call?.output), "Maple couldn't apply this change")
	})

	it("decides a proposal whose log holds the gate's refusal, which is not a decision", async () => {
		const session = makeSession()
		session.append({ type: "turn-start", messageId: "a1" })
		session.append({
			type: "tool-call",
			messageId: "a1",
			callId: "call_9",
			name: "create_alert_rule",
			input: {},
			proposed: true,
		})
		// What every proposal's log held before the adapter dropped the refusal.
		session.append({
			type: "tool-result",
			messageId: "a1",
			callId: "call_9",
			output: "create_alert_rule requires user approval and was not executed.",
			isError: true,
		})

		assert.equal(await settle(session, "deny"), "decided")
		assert.equal(await settle(session, "deny"), "settled")
	})

	it("appends the result under the message that issued the call", async () => {
		const session = withProposal(makeSession())
		await settle(session, "approve")

		// The fold opens a message by id and only then finds the call in it: any other id would
		// spawn a stray message and leave the proposal open forever.
		const messages = session.history()
		assert.lengthOf(messages, 2)
		assert.equal(messages[1]?.id, "a1")
	})
})
