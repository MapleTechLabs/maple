import { Option, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import {
	chatActionControlId,
	chatActionDecision,
	chatAlertAckControlId,
	decodeChatActionControlId,
	decodeChatAlertAckControlId,
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

describe("alert ack control id", () => {
	const INCIDENT = "00000000-0000-4000-8000-0000000000a1"
	const read = (raw: string) => Option.getOrUndefined(decodeChatAlertAckControlId(raw))

	it("round-trips both actions with the incident they name", () => {
		expect(read(chatAlertAckControlId("acknowledge", INCIDENT))).toEqual({
			action: "acknowledge",
			incidentId: INCIDENT,
		})
		expect(read(chatAlertAckControlId("unacknowledge", INCIDENT))).toEqual({
			action: "unacknowledge",
			incidentId: INCIDENT,
		})
	})

	it("fits the tightest platform's 100-character control id", () => {
		expect(chatAlertAckControlId("unacknowledge", INCIDENT).length).toBeLessThanOrEqual(100)
	})

	it.each([
		"",
		"alert_ack:",
		"alert_ack:not-a-uuid",
		`alert_ack:${INCIDENT}x`,
		`alert_ack:${Str.toUpperCase(INCIDENT)}`,
		`alert_ack:org_other:${INCIDENT}`,
		`alert_snooze:${INCIDENT}`,
		`approve:${INCIDENT}`,
	])("rejects %j", (raw) => {
		expect(read(raw)).toBeUndefined()
	})

	it("is not mistaken for an approval control", () => {
		expect(readControl(chatAlertAckControlId("acknowledge", INCIDENT))).toBeUndefined()
	})
})
