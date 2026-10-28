import { describe, expect, it } from "vitest"
import dropCases from "../fixtures/drop.json" with { type: "json" }
import redactCases from "../fixtures/redact.json" with { type: "json" }
import { runCase } from "./conformance"

// The same fixtures run in `cargo test` against apps/ingest/src/ingest_rules.rs.

const suites = { drop: dropCases, redact: redactCases }

describe.each(Object.entries(suites))("%s fixtures", (_, cases) => {
	it.each(cases.map((fixture) => [fixture.name, fixture] as const))("%s", (_name, fixture) => {
		expect(runCase(fixture)).toEqual(fixture.expected)
	})
})
