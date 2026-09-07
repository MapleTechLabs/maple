import { describe, expect, it } from "vitest"

import { AnthropicIcon, ChatBubbleSparkleIcon, ClaudeIcon, GeminiIcon, ZaiIcon } from "@/components/icons"
import { modelVendorIcon } from "./model-vendor-icon"

describe("modelVendorIcon", () => {
	it("prefers a family mark over the vendor's, with or without a vendor", () => {
		expect(modelVendorIcon({ vendorSlug: "anthropic", family: "claude" })).toBe(ClaudeIcon)
		expect(modelVendorIcon({ vendorSlug: "google", family: "gemini" })).toBe(GeminiIcon)
		expect(modelVendorIcon({ vendorSlug: null, family: "claude" })).toBe(ClaudeIcon)
		// An unlisted family falls through to the vendor.
		expect(modelVendorIcon({ vendorSlug: "anthropic", family: "sonnet" })).toBe(AnthropicIcon)
	})

	it("uses the vendor mark when the family has none", () => {
		expect(modelVendorIcon({ vendorSlug: "anthropic", family: null })).toBe(AnthropicIcon)
		expect(modelVendorIcon({ vendorSlug: "z-ai", family: null })).toBe(ZaiIcon)
	})

	it("falls back for an unknown vendor, a prototype key, and no vendor", () => {
		expect(modelVendorIcon({ vendorSlug: "thedrummer", family: null })).toBe(ChatBubbleSparkleIcon)
		expect(modelVendorIcon({ vendorSlug: "constructor", family: "constructor" })).toBe(
			ChatBubbleSparkleIcon,
		)
		expect(modelVendorIcon({ vendorSlug: null, family: null })).toBe(ChatBubbleSparkleIcon)
	})
})
