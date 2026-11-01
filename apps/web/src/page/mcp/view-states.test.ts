import { describe, expect, it } from "vitest"
import { connectedText } from "./view-states"

describe("connectedText", () => {
	it("names one or two clients in full", () => {
		expect(connectedText(["executor"])).toBe("executor")
		expect(connectedText(["executor", "Claude"])).toBe("executor and Claude")
	})

	it("names the first two and counts the rest", () => {
		expect(connectedText(["executor", "Claude", "omp", "Cursor"])).toBe("executor, Claude and 2 more")
	})
})
