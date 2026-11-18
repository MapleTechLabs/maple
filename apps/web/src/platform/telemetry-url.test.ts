import { describe, expect, it } from "vitest"
import { sanitizeSelfTelemetryUrl } from "./telemetry-url"

describe("sanitizeSelfTelemetryUrl", () => {
	it("keeps the origin and first segment, and drops the rest of the path, the query and the fragment", () => {
		expect(
			sanitizeSelfTelemetryUrl(
				"https://app.maple.dev/services/demo-api?environments=%5B%22production%22%5D#x",
			),
		).toBe("https://app.maple.dev/services/:path")
		expect(
			sanitizeSelfTelemetryUrl("https://app.maple.dev/traces?whereClause=user.email%3Da%40b.c"),
		).toBe("https://app.maple.dev/traces")
		expect(sanitizeSelfTelemetryUrl("https://app.maple.dev/")).toBe("https://app.maple.dev/")
	})

	it("hides a value that is not a URL", () => {
		expect(sanitizeSelfTelemetryUrl("not a url with a@b.c")).toBe("[url]")
	})
})
