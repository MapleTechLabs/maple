import { describe, expect, it } from "vitest"
import { envUrl } from "./env-url"

describe("envUrl", () => {
	it("treats an unset or blank variable as unconfigured", () => {
		expect(envUrl(undefined)).toBeUndefined()
		expect(envUrl("   ")).toBeUndefined()
	})

	it("trims and drops one trailing slash", () => {
		expect(envUrl("  https://api.maple.dev/ ")).toBe("https://api.maple.dev")
		expect(envUrl("https://api.maple.dev/v1")).toBe("https://api.maple.dev/v1")
	})
})
