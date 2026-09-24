import { Option } from "effect"
import { describe, expect, it } from "vitest"
import {
	chatActionControlId,
	chatActionDecision,
	decodeChatActionControlId,
	encodeChatActionToken,
} from "./action-token"

/** The decoder answers `Option`; the assertions read better against the value or `undefined`. */
const readControl = (raw: string) => Option.getOrUndefined(decodeChatActionControlId(raw))

describe("chat action control id", () => {
	const token = encodeChatActionToken("call_01JQ8ZC4M7X2")

	it("round-trips the decision alongside the call it stands for", () => {
		for (const decision of ["approve", "deny"] as const) {
			expect(readControl(chatActionControlId(decision, token))).toEqual({
				decision,
				toolCallId: "call_01JQ8ZC4M7X2",
			})
		}
	})

	it("fits the tightest platform's 100-character control id with room to spare", () => {
		// The shape a production call id actually has. With the session id alongside it, an org id
		// and a platform's thread id pushed this to 101 and the buttons were dropped.
		expect(
			chatActionControlId("approve", encodeChatActionToken("call_01a0d0801dc77ca1aa408683")).length,
		).toBeLessThan(40)
	})

	it("reads the decision off the front, not off a call id full of colons", () => {
		const control = chatActionControlId("approve", encodeChatActionToken("a:b:c"))
		expect(readControl(control)?.toolCallId).toBe("a:b:c")
	})

	it("refuses a control Maple did not render", () => {
		// A platform hands back whatever was on the clicked control, including other apps' — and a
		// forged one naming no decision must not be read as the permissive half of the pair.
		expect(readControl(token)).toBeUndefined()
		expect(readControl(`maybe:${token}`)).toBeUndefined()
		expect(readControl("approve:")).toBeUndefined()
	})

	it("tells a forged control of Maple's apart from somebody else's", () => {
		// One that names a decision and then does not decode is Maple's, corrupted or forged, and the
		// host logs it; one that names no decision is another app's button and is ordinary.
		expect(Option.getOrUndefined(chatActionDecision("approve:"))).toBe("approve")
		expect(Option.getOrUndefined(chatActionDecision(`some-other-app:${token}`))).toBeUndefined()
	})
})
