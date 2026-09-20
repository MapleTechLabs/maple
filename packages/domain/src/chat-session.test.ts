import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { OrgId } from "./primitives"
import {
	APP_ORIGIN,
	AUTONOMOUS_ORIGIN,
	ChatConnectorId,
	ChatTurnTenant,
	checkTurnOriginPairing,
	connectorSessionId,
	connectorTurnTenant,
	CONNECTOR_TENANT_USER_ID,
	isConnectorSessionId,
	originForTurn,
	chatModeFromSessionId,
	decodeChatTurnOrigin,
	encodeChatTurnOrigin,
	decodeChatTurnTenant,
	encodeChatTurnTenant,
	decodeChatEvent,
	decodeChatEventOrThrow,
	decodeChatEventPayload,
	encodeChatEvent,
	encodeChatEventPayload,
	investigationIdFromChatSessionId,
	makeChatSessionId,
	orgIdFromChatSessionId,
	tabIdFromChatSessionId,
	ChatTextDeltaEvent,
	ChatToolCallEvent,
	ChatTurnRetryEvent,
	type ChatEventInput,
} from "./chat-session"

const orgId = Schema.decodeSync(OrgId)
/** A connector id, not a real one: the domain never learns which chat platform it answers in. */
const connectorId = Schema.decodeSync(ChatConnectorId)("testchat")

describe("chat session ids", () => {
	it("round-trips org and tab", () => {
		const id = makeChatSessionId("org_abc", "tab-1")
		expect(id).toBe("org_abc:tab-1")
		expect(orgIdFromChatSessionId(id)).toBe("org_abc")
		expect(tabIdFromChatSessionId(id)).toBe("tab-1")
	})

	it("keeps colons inside the tab id", () => {
		// The org is everything before the FIRST colon; a tab id is free to contain more.
		expect(orgIdFromChatSessionId("org_abc:widget-fix-d1:w2")).toBe("org_abc")
		expect(tabIdFromChatSessionId("org_abc:widget-fix-d1:w2")).toBe("widget-fix-d1:w2")
	})

	it("denies ids that carry no resolvable org", () => {
		// Deny-by-default: neither of these may be treated as "the whole string is the org".
		expect(orgIdFromChatSessionId("no-colon")).toBeUndefined()
		expect(orgIdFromChatSessionId(":leading")).toBeUndefined()
	})

	it("derives the mode from the tab prefix", () => {
		expect(chatModeFromSessionId("o:tab-1")).toBe("default")
		expect(chatModeFromSessionId("o:alert-inc_1")).toBe("alert")
		expect(chatModeFromSessionId("o:widget-fix-d1-w2")).toBe("widget-fix")
		expect(chatModeFromSessionId("o:inv-123")).toBe("investigate")
		// A connector thread is an ordinary chat conversation someone is answering in from
		// elsewhere; what differs is the turn's origin, not the mode.
		expect(chatModeFromSessionId("o:bot-testchat-w1-994")).toBe("default")
	})

	it("builds a connector thread's session id, org and prefix intact", () => {
		const id = connectorSessionId(orgId("org_abc"), connectorId, "w1", "994")
		expect(id).toBe("org_abc:bot-testchat-w1-994")
		expect(isConnectorSessionId(id)).toBe(true)
		expect(orgIdFromChatSessionId(id)).toBe("org_abc")
		expect(isConnectorSessionId(makeChatSessionId("org_abc", "tab-1"))).toBe(false)
	})

	it("cannot let one workspace's thread spell another's session", () => {
		// The collision the escape exists for: raw, ("a", "b-c") and ("a-b", "c") are the same tab.
		const left = connectorSessionId(orgId("o"), connectorId, "a", "b-c")
		const right = connectorSessionId(orgId("o"), connectorId, "a-b", "c")
		expect(left).not.toBe(right)
		// And the escape itself cannot be spelled by the input, because `%` is escaped first.
		expect(connectorSessionId(orgId("o"), connectorId, "a%2Db", "c")).not.toBe(left)
		expect(connectorSessionId(orgId("o"), connectorId, "a%2Db", "c")).not.toBe(right)
	})

	it("refuses a connector id that would blur the tab encoding", () => {
		// The id sits between two dashes in `bot-<connector>-<thread>`, which is parsed by prefix, so
		// a dash inside it would let one connector's thread id spell another's session — and land two
		// conversations in the same Durable Object.
		const decode = Schema.decodeUnknownSync(ChatConnectorId)
		for (const bad of ["two-words", "Upper", "9lead", "has_underscore", ""]) {
			expect(() => decode(bad), bad).toThrow()
		}
		expect(decode("testchat2")).toBe("testchat2")
	})

	it("recovers the investigation id only for investigate sessions", () => {
		expect(investigationIdFromChatSessionId("o:inv-abc")).toBe("abc")
		expect(investigationIdFromChatSessionId("o:alert-abc")).toBeUndefined()
	})
})

describe("chat events", () => {
	it("round-trips through the wire encoding", () => {
		const event = new ChatTextDeltaEvent({ seq: 7, type: "text-delta", messageId: "m1", text: "hi" })
		const decoded = decodeChatEvent(encodeChatEvent(event))
		expect(decoded).toMatchObject({ seq: 7, type: "text-delta", messageId: "m1", text: "hi" })
	})

	it("carries the approval flag on a proposed tool call", () => {
		// `proposed` is what tells the client to render an approval card instead of a running tool.
		const event = new ChatToolCallEvent({
			seq: 3,
			type: "tool-call",
			messageId: "m1",
			callId: "c1",
			name: "update_dashboard",
			input: { id: "d1" },
			proposed: true,
		})
		const decoded = decodeChatEvent(encodeChatEvent(event))
		expect(decoded).toMatchObject({ type: "tool-call", proposed: true, name: "update_dashboard" })
	})

	it("round-trips a retry retraction", () => {
		// The two unions — the seq'd wire classes and the storage payload — are declared separately
		// from one shared `eventFields` record. A member added to one and not the other typechecks
		// fine and only shows up as a round-trip failure, here or in the storage-codec suite.
		const event = new ChatTurnRetryEvent({
			seq: 9,
			type: "turn-retry",
			messageId: "a1",
			attempt: 2,
			retractChars: 5,
			reason: "Transport",
			delayMs: 1_000,
		})
		const decoded = decodeChatEvent(encodeChatEvent(event))
		expect(decoded).toMatchObject({ type: "turn-retry", retractChars: 5, attempt: 2 })
	})

	it("skips a frame it does not understand instead of throwing", () => {
		// A throwing decode escaped the client's read loop, which then reconnected from *before* the
		// bad frame — so the server replayed it and the client threw again, until the retry budget
		// ran out and the conversation was dead. Returning undefined means one new event type
		// degrades an old client rather than bricking it.
		expect(decodeChatEvent(JSON.stringify({ seq: 1, type: "from-a-newer-server" }))).toBeUndefined()
		expect(decodeChatEvent("not json at all")).toBeUndefined()
		// Structurally invalid members of a *known* type are skipped too.
		expect(decodeChatEvent(JSON.stringify({ seq: 1, type: "text-delta" }))).toBeUndefined()
	})

	it("still throws on demand, for producers that control both ends", () => {
		expect(() => decodeChatEventOrThrow(JSON.stringify({ type: "nope" }))).toThrow()
	})
})

describe("chat event storage codec", () => {
	// The durable log stores an event without its `seq` — the SQLite row key is the seq — so this is
	// a separate pair from the SSE codecs. It exists because the Durable Object used to read rows
	// back with `JSON.parse(payload) as ChatEvent`, which turns a shape change into a malformed
	// event handed straight to the transcript fold rather than an error at the boundary.
	it("round-trips every member, taking the seq from the row key", () => {
		const inputs: ReadonlyArray<ChatEventInput> = [
			{ type: "user-message", id: "u1", text: "hello" },
			{ type: "turn-start", messageId: "a1" },
			{ type: "text-delta", messageId: "a1", text: "hi" },
			{ type: "tool-call", messageId: "a1", callId: "c1", name: "t", input: { a: 1 } },
			{ type: "tool-call", messageId: "a1", callId: "c2", name: "t", input: {}, proposed: true },
			{ type: "tool-result", messageId: "a1", callId: "c1", output: "ok" },
			{ type: "tool-result", messageId: "a1", callId: "c1", output: "no", isError: true },
			{
				type: "turn-retry",
				messageId: "a1",
				attempt: 2,
				retractChars: 12,
				reason: "Transport",
				delayMs: 1_000,
			},
			// Sub-agent events: the same members, tagged.
			{
				type: "turn-start",
				messageId: "c1",
				task: { id: "t1", agent: "explore", parentMessageId: "a1" },
			},
			{
				type: "text-delta",
				messageId: "c1",
				text: "child",
				task: { id: "t1", agent: "explore", parentMessageId: "a1" },
			},
			{
				type: "turn-end",
				messageId: "c1",
				reason: "stop",
				task: { id: "t1", agent: "explore", parentMessageId: "a1" },
			},
			{ type: "turn-end", messageId: "a1", reason: "stop" },
			{ type: "turn-end", messageId: "a1", reason: "error", error: "boom" },
		]

		for (const input of inputs) {
			const decoded = decodeChatEventPayload(encodeChatEventPayload(input), 42)
			expect(decoded).toEqual({ ...input, seq: 42 })
		}
	})

	it("rejects a stored payload that is not a known event", () => {
		expect(() => decodeChatEventPayload(JSON.stringify({ type: "nonsense" }), 1)).toThrow()
	})
})

describe("ChatTurnTenant", () => {
	it("crosses the Durable Object boundary as a structured-cloneable plain object", () => {
		// Load-bearing, not pedantry: Durable Object RPC serializes with structured clone, which
		// refuses class instances outright. As a `Schema.Class` this failed every `beginTurn` with
		// `DataCloneError: Could not serialize object of type "ChatTurnTenant"` — while `history()`
		// kept working, because it returns object literals. Only an end-to-end run caught it.
		const encoded = encodeChatTurnTenant({
			orgId: "org_1" as ChatTurnTenant["orgId"],
			userId: "user_1" as ChatTurnTenant["userId"],
			roles: [],
			authMode: "self_hosted",
		})

		expect(Object.getPrototypeOf(encoded)).toBe(Object.prototype)
		expect(() => structuredClone(encoded)).not.toThrow()
		expect(structuredClone(encoded)).toEqual(encoded)

		// And it round-trips back to branded values on the far side.
		const decoded = decodeChatTurnTenant(structuredClone(encoded))
		expect(decoded.orgId).toBe("org_1")
		expect(decoded.authMode).toBe("self_hosted")
	})

	it("runs a connector turn as an org-level tenant, with no roles", () => {
		const encoded = connectorTurnTenant(orgId("org_1"))

		expect(encoded).toStrictEqual({
			orgId: "org_1",
			userId: CONNECTOR_TENANT_USER_ID,
			roles: [],
			authMode: "self_hosted",
		})
		// The prototype, not `structuredClone`: Node clones a class instance happily and only
		// workerd raises `DataCloneError`, so the throw check above is the one that catches this
		// and a green `structuredClone` here would prove nothing.
		expect(Object.getPrototypeOf(encoded)).toBe(Object.prototype)
	})
})

describe("ChatTurnOrigin", () => {
	const connector = {
		kind: "connector" as const,
		connectorId: "testchat",
		workspaceId: "w1",
		externalUserId: "u-1",
		displayName: "Ada",
	}

	it("crosses the Durable Object boundary as a plain object", () => {
		// Same constraint as `ChatTurnTenant`: DO RPC serializes with structured clone, which
		// refuses class instances outright.
		for (const origin of [APP_ORIGIN, AUTONOMOUS_ORIGIN, connector]) {
			const encoded = encodeChatTurnOrigin(decodeChatTurnOrigin(origin))
			expect(Object.getPrototypeOf(encoded)).toBe(Object.prototype)
			expect(encoded).toStrictEqual(origin)
		}
	})

	it("defaults a missing origin to `app`, and the investigation actor to `autonomous`", () => {
		// Deploy skew only: api, alerting and ai are separate Workers, so a caller that predates
		// the field keeps calling through a rollout. The pass must not silently become attended.
		const app = { orgId: "org_1", userId: "user_1", roles: [], authMode: "self_hosted" } as const
		const pass = { ...app, userId: "internal-service" } as const
		expect(originForTurn(undefined, app)).toStrictEqual(APP_ORIGIN)
		expect(originForTurn(undefined, pass)).toStrictEqual(AUTONOMOUS_ORIGIN)
		// An explicit origin always wins, so the compatibility read disappears on its own.
		expect(originForTurn(APP_ORIGIN, pass)).toStrictEqual(APP_ORIGIN)
	})

	it("refuses an origin and a session that disagree, in both directions", () => {
		const connectorSession = connectorSessionId(orgId("o"), connectorId, "w1", "994")
		const appSession = makeChatSessionId("o", "tab-1")

		expect(checkTurnOriginPairing(connectorSession, connector)).toBeUndefined()
		expect(checkTurnOriginPairing(appSession, APP_ORIGIN)).toBeUndefined()
		expect(checkTurnOriginPairing(appSession, AUTONOMOUS_ORIGIN)).toBeUndefined()
		// A connector must not be pointed at an app conversation, and an app caller must not post
		// into a channel thread.
		expect(checkTurnOriginPairing(appSession, connector)?._tag).toBe("@maple/chat/ChatTurnOriginMismatch")
		expect(checkTurnOriginPairing(connectorSession, APP_ORIGIN)?._tag).toBe(
			"@maple/chat/ChatTurnOriginMismatch",
		)
	})
})
