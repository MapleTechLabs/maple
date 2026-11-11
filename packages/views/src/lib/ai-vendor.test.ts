import { describe, expect, it } from "vitest"

import { modelVendorColor, vendorColor, vendorIcon, vendorLabel } from "./ai-vendor"

describe("vendorLabel and vendorIcon", () => {
	it("reads a listed vendor's casing and mark, and title-cases the rest", () => {
		expect(vendorLabel("openai_agents_sdk")).toBe("OpenAI Agents SDK")
		expect(vendorIcon("openai_agents_sdk")).toBe("OpenAiIcon")
		expect(vendorLabel("semantic_kernel")).toBe("Semantic Kernel")
		expect(vendorLabel("unknown:genai")).toBe("Unidentified")
		expect(vendorLabel("constructor")).toBe("Constructor")
		expect(vendorIcon("constructor")).toBe("ChatBubbleSparkleIcon")
	})
})

describe("vendorColor", () => {
	it("gives a framework its publisher's brand, shared with that publisher's models", () => {
		expect(vendorColor("claude_agent_sdk")).not.toBe(vendorColor("litellm"))
		// A monochrome brand inverts on dark.
		expect(vendorColor("openai_agents_sdk")).toBe("light-dark(#000000, #FFFFFF)")
		expect(vendorColor("openinference-openai")).toBe(vendorColor("openai_agents_sdk"))
		expect(vendorColor("eve")).toBe(vendorColor("vercel_ai_sdk"))
		expect(vendorColor("vercel_ai_gateway")).toBe(vendorColor("vercel_ai_sdk"))
	})

	it("falls back to the neutral for frameworks without a brand color, and for no vendor at all", () => {
		expect(vendorColor("litellm")).toBe("var(--muted-foreground)")
		expect(vendorColor("unknown:genai")).toBe("var(--muted-foreground)")
		expect(vendorColor("")).toBe("var(--muted-foreground)")
		expect(vendorColor("constructor")).toBe("var(--muted-foreground)")
	})
})

describe("modelVendorColor", () => {
	it("builds a detected brand the way a framework's is built, and leaves an unbranded model uncolored", () => {
		expect(modelVendorColor({ brandColor: { light: "#4285F4", dark: "#4285F4" } })).toBe("#4285F4")
		expect(modelVendorColor({ brandColor: { light: "#000000", dark: "#FFFFFF" } })).toBe(
			"light-dark(#000000, #FFFFFF)",
		)
		expect(modelVendorColor({ brandColor: null })).toBeUndefined()
	})
})
