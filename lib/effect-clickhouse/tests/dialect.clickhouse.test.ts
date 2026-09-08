import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { describe, expect, it } from "@effect/vitest"
import { dialectCases, typeCases } from "./dialect-cases"
import { endpoint, execute } from "./clickhouse-support"

it.layer(FetchHttpClient.layer)("public package ClickHouse dialect", (it) => {
	describe.skipIf(!endpoint)("live", () => {
		// Both driver wire conventions and both outer join contracts are supported.
		for (const setting of ["0", "1"]) {
			for (const fixture of [...dialectCases, ...typeCases]) {
				it.effect(`${fixture.id} (quote64/join_nulls=${setting})`, () =>
					Effect.gen(function* () {
						const compiled = fixture.build()
						if (fixture.metadata) expect(compiled).toMatchObject(fixture.metadata)
						const { rows } = yield* execute(
							compiled,
							{
								output_format_json_quote_64bit_integers: setting,
								join_use_nulls: setting,
							},
							fixture.format,
						)
						expect(rows, compiled.sql).toEqual(fixture.expected)
					}),
				)
			}
		}
	})
})
