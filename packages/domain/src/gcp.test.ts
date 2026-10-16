import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { gcpConnectorResourceNames } from "./gcp"
import { GcpConnectorId } from "./primitives"

describe("gcpConnectorResourceNames", () => {
	it("derives a service account id inside Google's limits from the connector id alone", () => {
		const names = gcpConnectorResourceNames(
			Schema.decodeUnknownSync(GcpConnectorId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8"),
		)
		expect(names).toEqual({
			serviceAccountId: "maple-018f2b3c4d5e4f708192a3b4",
			topic: "maple-018f2b3c4d5e4f708192a3b4",
			subscription: "maple-018f2b3c4d5e4f708192a3b4",
			sink: "maple-018f2b3c4d5e4f708192a3b4",
		})
		// Google: 6-30 characters, [a-z]([-a-z0-9]*[a-z0-9]).
		expect(names.serviceAccountId).toMatch(/^[a-z][-a-z0-9]{4,28}[a-z0-9]$/)
	})
})
