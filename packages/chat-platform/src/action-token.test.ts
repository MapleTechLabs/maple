import { makeChatSessionId } from "@maple/domain/chat-session"
import { describe, expect, it } from "vitest"
import { decodeChatActionToken, encodeChatActionToken } from "./action-token"

const sessionId = makeChatSessionId("org_2abcdefghijklmnopqrstuvwxy", "bot-0f8a1c2d")

describe("chat action token", () => {
	it("round-trips the session and the call", () => {
		const token = encodeChatActionToken(sessionId, "call_01JQ8ZC4M7X2")
		expect(decodeChatActionToken(token)).toEqual({ sessionId, toolCallId: "call_01JQ8ZC4M7X2" })
	})

	it("fits the smallest action-id budget a platform imposes, with room for a verb", () => {
		// 100 characters is the tightest limit among the platforms this package targets, and a
		// connector prefixes the token with the action it stands for.
		expect(encodeChatActionToken(sessionId, "call_01JQ8ZC4M7X2Y5R9WVBN3KTGHS").length).toBeLessThan(90)
	})

	it("refuses anything that is not one", () => {
		// The string comes back from the platform, so it is untrusted: a session id with no org in it
		// resolves to no tenant and must not reach a caller as a branded id.
		expect(decodeChatActionToken("no-separator")).toBeUndefined()
		expect(decodeChatActionToken("|call_1")).toBeUndefined()
		expect(decodeChatActionToken("orgless|call_1")).toBeUndefined()
		expect(decodeChatActionToken(`${sessionId}|`)).toBeUndefined()
	})

	it("keeps a separator inside a provider's call id", () => {
		const token = encodeChatActionToken(sessionId, "call|weird")
		expect(decodeChatActionToken(token)?.toolCallId).toBe("call|weird")
	})

	it("survives a session id that carries the escape marker itself", () => {
		// Escaping the separator without escaping the marker is not injective: a tab id already
		// holding `%7C` would come back as a `|` it never had — a different session that still
		// resolves an org and still passes the brand.
		const awkward = makeChatSessionId("org_1", "bot%7C42")
		const token = encodeChatActionToken(awkward, "call_1")
		expect(decodeChatActionToken(token)).toEqual({ sessionId: awkward, toolCallId: "call_1" })
	})

	it("survives a session id that carries the separator", () => {
		// A tab id is whatever minted the session — a platform's own message id, on a platform that
		// allows anything. Unescaped, this decoded back as a shorter session id that still looked
		// valid: the wrong conversation, silently.
		const awkward = makeChatSessionId("org_1", "bot|42")
		const token = encodeChatActionToken(awkward, "call_1")
		expect(decodeChatActionToken(token)).toEqual({ sessionId: awkward, toolCallId: "call_1" })
	})
})
