import { describe, expect, it } from "vitest"

import { vendorColor } from "./vendor-color"

describe("vendorColor", () => {
	it("gives a framework its publisher's brand, shared with that publisher's models", () => {
		expect(vendorColor("claude_agent_sdk")).toBe("#D97757")
		// Two ids, one brand — and a monochrome one, which inverts on dark.
		expect(vendorColor("openai_agents_sdk")).toBe("light-dark(#000000, #FFFFFF)")
		expect(vendorColor("openinference-openai")).toBe(vendorColor("openai_agents_sdk"))
		expect(vendorColor("eve")).toBe(vendorColor("vercel_ai_sdk"))
	})

	it("keeps a bright brand legible on white by darkening only the light half", () => {
		expect(vendorColor("spring_ai")).toBe("light-dark(#5EA32D, #6DB33F)")
	})

	it("falls back to the neutral for frameworks without a brand color, and for no vendor at all", () => {
		expect(vendorColor("litellm")).toBe("var(--muted-foreground)")
		expect(vendorColor("unknown:genai")).toBe("var(--muted-foreground)")
		expect(vendorColor("")).toBe("var(--muted-foreground)")
	})
})
