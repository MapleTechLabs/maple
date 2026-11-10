// The builder-fixture harness both SQL catalogs share: this package's and
// `@maple/query-engine-integrations`', which this package must not import.

import { Array as Arr, String as Str } from "effect"
import type { CompiledQuery } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { fingerprintSql } from "../execution/fingerprint"

export interface BuilderFixture {
	/** Module basename of the builder, e.g. `"session-replays"`. */
	readonly module: string
	/** The exported builder this fixture covers; it must match the export name. */
	readonly name: string
	/** Distinguishes fixtures for one builder; appears in failure output. */
	readonly label: string
	readonly compile: () => CompiledQuery<unknown>
	/**
	 * Sample values for output columns whose row schema narrows what the ClickHouse
	 * column type allows.
	 *
	 * The E2E sweep decodes a synthetic row to prove the schema accepts both 64-bit
	 * wire shapes, and it builds that row from the DESCRIBEd column *types* alone,
	 * so every `String` column gets `""`. A schema that legitimately narrows a
	 * String (a literal union over a column the SQL itself guarantees, like
	 * `serviceExternalEdges.targetType`) rejects `""` and fails a check that is
	 * about integer quoting, with a message telling the author to reach for
	 * `CH.CHNumber` on a string field.
	 *
	 * The narrowing is worth keeping (`service-map.test.ts` asserts an unexpected
	 * `targetType` is rejected), so the fixture names the value instead. Keyed by
	 * output column name.
	 */
	readonly sampleValues?: Readonly<Record<string, unknown>>
}

export const FIXTURE_ORG_ID = OrgId.make("org_sql_catalog")
/** A window that spans whole hours plus partial edges on both sides, so the
 *  edge-hour + rollup-interior union shapes both produce non-degenerate SQL. */
export const FIXTURE_START_TIME = "2026-01-01 10:30:00"
export const FIXTURE_END_TIME = "2026-01-03 14:15:00"
export const FIXTURE_WINDOW = {
	orgId: FIXTURE_ORG_ID,
	startTime: FIXTURE_START_TIME,
	endTime: FIXTURE_END_TIME,
}

export interface BuilderCatalogEntry {
	readonly id: string
	readonly source: "builder"
	readonly name: string
	readonly label: string
	readonly capabilityLabel: string
	readonly route: undefined
	readonly sql: string
	readonly fingerprint: string
	readonly compiled: CompiledQuery<unknown>
	readonly sampleValues?: Readonly<Record<string, unknown>>
}

/**
 * Compile every fixture. The executor dies on unresolved placeholders at
 * runtime, so a fixture missing a compile param fails here, in the unit test.
 */
export const builderCatalogEntries = (
	catalog: string,
	fixtures: ReadonlyArray<BuilderFixture>,
): ReadonlyArray<BuilderCatalogEntry> =>
	Arr.map(fixtures, (fixture) => {
		const compiled = fixture.compile()
		if (Str.includes("__PARAM_")(compiled.sql)) {
			throw new Error(
				`${catalog}: ${fixture.module}/${fixture.name} (${fixture.label}) ` +
					`left an unresolved __PARAM_ placeholder: a compile param is missing.`,
			)
		}
		return {
			id: `builder:${fixture.module}:${fixture.name}:${fixture.label}`,
			source: "builder",
			name: fixture.name,
			label: fixture.label,
			capabilityLabel: "baseline",
			route: undefined,
			sql: compiled.sql,
			fingerprint: fingerprintSql(compiled.sql),
			compiled,
			...(fixture.sampleValues ? { sampleValues: fixture.sampleValues } : undefined),
		}
	})
