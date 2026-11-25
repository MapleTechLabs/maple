import { describe, expect, it } from "vitest"
import { Array as Arr, Option, Record as Rec, Schema } from "effect"
import fixtures from "../fixtures/retention-stamp.json" with { type: "json" }
import { RetentionOverrides, retentionStampDays, sourceRetentionDays } from "./retention"

// The same fixture runs in `cargo test` against apps/ingest/src/retention.rs, which stamps rows.

const Stored = Schema.Struct({ organization: RetentionOverrides, source: RetentionOverrides })

const Fixtures = Schema.Struct({
	cases: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			organization: RetentionOverrides,
			source: RetentionOverrides,
			expected: Schema.Record(Schema.String, Schema.Number),
		}),
	),
	invalidStored: Schema.Array(
		Schema.Struct({ name: Schema.String, organization: Schema.Unknown, source: Schema.Unknown }),
	),
})

const { cases, invalidStored } = Schema.decodeSync(Fixtures)(fixtures)

describe("retention stamp fixtures", () => {
	it.each(Arr.map(cases, (fixture) => [fixture.name, fixture] as const))("%s", (_name, fixture) => {
		const stamps = Rec.map(sourceRetentionDays(fixture.organization, fixture.source), retentionStampDays)
		expect(stamps).toEqual(fixture.expected)
	})
})

// The gateway ignores these stored values signal by signal. Here they are what the API refuses to store.
describe("retention values the gateway ignores", () => {
	it.each(Arr.map(invalidStored, (fixture) => [fixture.name, fixture] as const))("%s", (_name, fixture) => {
		expect(Option.isNone(Schema.decodeUnknownOption(Stored)(fixture))).toBe(true)
	})
})
