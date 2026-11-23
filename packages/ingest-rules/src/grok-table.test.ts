import { describe, expect, it } from "vitest"
import { GROK_PATTERNS } from "@maple/domain/ingest-grok"
import shared from "../fixtures/grok-patterns.json" with { type: "json" }

// apps/ingest checks its own table against the same file, so the two libraries cannot drift.

describe("grok library", () => {
	it("matches the shared table", () => {
		expect(GROK_PATTERNS).toEqual(shared)
	})
})
