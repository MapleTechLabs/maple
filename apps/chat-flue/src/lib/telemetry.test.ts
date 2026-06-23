import { describe, expect, it } from "vitest"
import { setupTelemetry } from "./telemetry.ts"

describe("setupTelemetry", () => {
	it("is a no-op (returns undefined) when no ingest key is configured", () => {
		expect(setupTelemetry({})).toBeUndefined()
		expect(setupTelemetry({ ingestKey: "   " })).toBeUndefined()
		expect(setupTelemetry({ environment: "production" })).toBeUndefined()
	})

	it("returns a flushable tracer provider when an ingest key is set", () => {
		const provider = setupTelemetry({
			ingestKey: "maple_pk_test",
			environment: "test",
		})

		expect(provider).toBeDefined()
		expect(typeof provider?.getTracer).toBe("function")
		expect(typeof provider?.forceFlush).toBe("function")
		expect(provider?.getTracer("maple-chat-flue")).toBeDefined()
	})
})
