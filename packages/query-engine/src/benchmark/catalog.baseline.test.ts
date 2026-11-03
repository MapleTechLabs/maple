import { Effect, Array as Arr, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { collectQueryCatalog } from "./catalog"

// A verbatim record of every SQL string the product can emit.
//
// `benchmark/catalog.test.ts` asserts *properties* of the catalog (it compiles, it
// covers every pipe, it scopes to an org). This file asserts the bytes. It
// exists so a refactor that claims "no SQL changed" is checkable by reading one
// file's diff instead of by reasoning about the builders.
//
// Regenerate with `vitest -u` ONLY when a SQL change is intended, and treat the
// resulting diff as part of the review. An unexplained diff means the refactor
// is wrong.

describe("sql catalog baseline", () => {
	it("emits the same SQL as the recorded baseline", async () => {
		const rendered = Arr.join(
			Arr.map(
				[...Effect.runSync(collectQueryCatalog())].sort((a, b) => Str.localeCompare(b.id)(a.id)),
				(entry) => `-- ${entry.id}  [${entry.fingerprint}]\n${entry.sql}`,
			),
			"\n\n",
		)

		await expect(rendered).toMatchFileSnapshot("../__sql_baseline__/catalog.sql")
	})
})
