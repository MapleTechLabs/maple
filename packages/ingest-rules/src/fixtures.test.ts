import { describe, expect, it } from "vitest"
import dropCases from "../fixtures/drop.json" with { type: "json" }
import redactCases from "../fixtures/redact.json" with { type: "json" }
import { runCase } from "./conformance"
import { Array as Arr, Record as Rec } from "effect"

// The same fixtures run in `cargo test` against apps/ingest/src/ingest_rules.rs.

const suites = { drop: dropCases, redact: redactCases }

describe.each(Rec.toEntries(suites))("%s fixtures", (_, cases) => {
	it.each(Arr.map(cases, (fixture) => [fixture.name, fixture] as const))("%s", (_name, fixture) => {
		expect(runCase(fixture)).toEqual(fixture.expected)
	})
})
