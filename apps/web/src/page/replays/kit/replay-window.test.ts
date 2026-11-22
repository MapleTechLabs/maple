import { describe, expect, it } from "vitest"
import { visitorHistory } from "./replay-window"

describe("visitorHistory", () => {
	it("reads the stored new-visitor flag for a persistent visitor id", () => {
		expect(visitorHistory("{}", true)).toBe("New")
		expect(visitorHistory(JSON.stringify({ "maple.session.recorded": "true" }), false)).toBe("Returning")
	})

	it("calls a cookieless visitor's history unknown rather than returning", () => {
		const cookieless = JSON.stringify({ "maple.visitor.mode": "cookieless" })
		expect(visitorHistory(cookieless, false)).toBe("Unknown, cookieless")
	})
})
