import { describe, expect, it } from "vitest"
import { signalLane } from "./view-kit"

describe("signalLane", () => {
	it("folds every signal past the first two into the +N labels", () => {
		expect(signalLane(["replay", "traces", "logs", "events", "mcp"])).toEqual({
			shown: ["replay", "traces"],
			hidden: ["Logs", "Events", "MCP"],
		})
	})

	it("hides nothing when the signals fit", () => {
		expect(signalLane(["replay"]).hidden).toEqual([])
	})
})
