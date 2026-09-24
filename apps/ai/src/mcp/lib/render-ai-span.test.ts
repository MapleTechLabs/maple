import { describe, expect, it } from "vitest"

import { hasAiSignal } from "./render-ai-span"

describe("hasAiSignal", () => {
	it("agrees with the span mapper: a tool call id alone is not an AI span", () => {
		expect(hasAiSignal({ "gen_ai.tool.call.id": "toolu_1" })).toBe(false)
		expect(hasAiSignal({ "gen_ai.tool.call.id": "toolu_1", "gen_ai.tool.name": "Bash" })).toBe(true)
	})
})
